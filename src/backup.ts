/**
 * Backup orchestration: turn a content event into GitHub commits.
 */

import type { ResolvedConfig } from "./config.js";
import { bytesToBase64, type GithubClient } from "./github.js";

/** Subset of the emdash logger we use. */
interface LogLike {
	info(message: string, data?: unknown): void;
	warn(message: string, data?: unknown): void;
	error(message: string, data?: unknown): void;
}

/** Subset of the media access API we use (read-only). */
interface MediaLike {
	get(id: string): Promise<{ id: string; filename: string; mimeType: string; url: string } | null>;
}

/** Subset of the HTTP access API we use. */
interface HttpLike {
	fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** A content snapshot, shaped to be stable and diff-friendly in git. */
interface Snapshot {
	collection: string;
	slug: string;
	id: string | null;
	backedUpAt: string;
	content: Record<string, unknown>;
}

/**
 * Sanitise a value so it is safe to use as a path segment: keep it readable
 * but strip anything that would break a GitHub path or escape the folder.
 */
function safeSegment(value: string): string {
	const cleaned = value
		.trim()
		.replace(/[\\/]+/g, "-") // no path separators
		.replace(/\.\.+/g, "-") // no parent traversal
		.replace(/[^a-zA-Z0-9._-]+/g, "-") // conservative allowlist
		.replace(/^-+|-+$/g, "");
	return cleaned.length > 0 ? cleaned : "untitled";
}

/**
 * Derive a slug for an entry. Prefers an explicit `slug`, then common title
 * fields, then the id, then a fallback. Always returns a safe segment.
 */
function deriveSlug(content: Record<string, unknown>, id: string | null): string {
	const candidate =
		pickString(content.slug) ??
		pickString(content.title) ??
		pickString(content.name) ??
		id ??
		"entry";
	return safeSegment(candidate);
}

function pickString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function entryPath(config: ResolvedConfig, collection: string, slug: string): string {
	return `${config.folder}/${safeSegment(collection)}/${slug}.json`;
}

/** Pretty-printed JSON with a trailing newline for clean diffs. */
function toJson(snapshot: Snapshot): string {
	return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/**
 * Write (or overwrite) the JSON snapshot for a saved entry.
 */
export async function backupEntry(args: {
	client: GithubClient;
	config: ResolvedConfig;
	log: LogLike;
	collection: string;
	content: Record<string, unknown>;
	isNew: boolean;
	media?: MediaLike;
	http?: HttpLike;
}): Promise<void> {
	const { client, config, log, collection, content, isNew, media, http } = args;

	const id = pickString(content.id) ?? null;
	const slug = deriveSlug(content, id);
	const path = entryPath(config, collection, slug);

	const snapshot: Snapshot = {
		collection,
		slug,
		id,
		backedUpAt: new Date().toISOString(),
		content,
	};

	const verb = isNew ? "Create" : "Update";
	const message = `${verb} ${collection}/${slug} (emdash backup)`;

	await client.putTextFile(path, toJson(snapshot), message);
	log.info("github-backup: wrote entry snapshot", { path });

	// Best-effort media backup. Only runs when both media read access and the
	// HTTP client are available. Failures here never propagate.
	if (media && http) {
		await backupReferencedMedia({ client, config, log, content, media, http }).catch((err) => {
			log.warn("github-backup: media backup skipped", { error: String(err) });
		});
	}
}

/**
 * Delete (or tombstone) the JSON snapshot for a deleted entry.
 *
 * Behaviour: we remove the file. Because every change is a commit, the entry's
 * full pre-delete content remains recoverable from git history. This keeps the
 * working tree an accurate mirror of live content rather than accumulating
 * tombstones. (A `permanent: false` trash event is treated the same as a hard
 * delete for the mirror: the file is removed and history preserves it.)
 */
export async function deleteEntry(args: {
	client: GithubClient;
	config: ResolvedConfig;
	log: LogLike;
	collection: string;
	id: string;
}): Promise<void> {
	const { client, config, log, collection, id } = args;

	// We only have the id at delete time, not the slug. The snapshot is keyed
	// by slug, so we cannot always reconstruct the exact path. We remove the
	// id-named file if one exists, and otherwise write a tombstone keyed by id
	// so the deletion is still recorded in history.
	const safeId = safeSegment(id);
	const byIdPath = entryPath(config, collection, safeId);

	const message = `Delete ${collection}/${safeId} (emdash backup)`;

	if (await client.fileExists(byIdPath)) {
		await client.deleteFile(byIdPath, message);
		log.info("github-backup: removed entry snapshot", { path: byIdPath });
		return;
	}

	// The live file is slug-keyed and the slug is not in the delete event, so
	// we cannot reliably target it. Record a tombstone keyed by id instead, so
	// the deletion still shows up as a commit in history.
	const tombstonePath = `${config.folder}/${safeSegment(collection)}/_deleted/${safeId}.json`;
	const tombstone = `${JSON.stringify(
		{ collection, id, deletedAt: new Date().toISOString() },
		null,
		2,
	)}\n`;
	await client.putTextFile(tombstonePath, tombstone, message);
	log.info("github-backup: wrote delete tombstone", { path: tombstonePath });
}

/**
 * Walk a content object collecting media item ids that look like references,
 * then copy each referenced media file into `<folder>/media/<filename>`.
 *
 * This is best-effort: media bytes are only reachable when the media URL can
 * be fetched through the host-restricted HTTP client. If the media host is not
 * in `allowedHosts`, the fetch fails and that file is skipped (logged, not
 * thrown). The text backup is never blocked by media handling.
 */
async function backupReferencedMedia(args: {
	client: GithubClient;
	config: ResolvedConfig;
	log: LogLike;
	content: Record<string, unknown>;
	media: MediaLike;
	http: HttpLike;
}): Promise<void> {
	const { client, config, log, content, media, http } = args;

	const ids = collectMediaIds(content);
	if (ids.size === 0) return;

	for (const mediaId of ids) {
		try {
			const item = await media.get(mediaId);
			if (!item || !item.url) continue;

			const res = await http.fetch(item.url, { method: "GET" });
			if (!res.ok) {
				log.warn("github-backup: could not fetch media bytes", {
					mediaId,
					status: res.status,
				});
				continue;
			}
			const bytes = new Uint8Array(await res.arrayBuffer());
			const filename = safeSegment(item.filename || mediaId);
			const path = `${config.folder}/media/${filename}`;
			await client.putBase64File(path, bytesToBase64(bytes), `Backup media ${filename} (emdash backup)`);
			log.info("github-backup: wrote media file", { path });
		} catch (err) {
			// Most commonly: the media URL host is not in allowedHosts, so the
			// sandboxed fetch is blocked. Skip and keep going.
			log.warn("github-backup: media file skipped", { mediaId, error: String(err) });
		}
	}
}

/**
 * Heuristic: find values that look like media references. emdash stores media
 * references as ids; we collect any string value under a key that hints at
 * media (image, media, file, photo, cover, etc.) plus any object carrying a
 * `mediaId`/`id` alongside a media-ish key.
 */
function collectMediaIds(content: Record<string, unknown>): Set<string> {
	const ids = new Set<string>();
	const mediaKey = /(image|images|media|file|files|photo|cover|avatar|thumbnail|gallery|attachment)/i;

	const visit = (value: unknown, keyHint: string): void => {
		if (value == null) return;
		if (typeof value === "string") {
			if (mediaKey.test(keyHint) && value.trim().length > 0) {
				ids.add(value.trim());
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry, keyHint);
			return;
		}
		if (typeof value === "object") {
			const obj = value as Record<string, unknown>;
			// A media object may carry its own id under mediaId/id.
			if (mediaKey.test(keyHint)) {
				const ref = pickString(obj.mediaId) ?? pickString(obj.id);
				if (ref) ids.add(ref);
			}
			for (const [key, child] of Object.entries(obj)) {
				visit(child, key);
			}
		}
	};

	for (const [key, value] of Object.entries(content)) {
		visit(value, key);
	}
	return ids;
}

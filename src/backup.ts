/**
 * Backup orchestration: turn a content event into GitHub commits.
 */

import type { ResolvedConfig } from "./config.js";
import { bytesToBase64, type GitIdentity, type GithubClient } from "./github.js";

/** This plugin's repo, linked from every backup commit message. */
const PLUGIN_URL = "https://github.com/dennisklappe/emdash-plugin-github-backup";

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

/** Subset of the emdash user access API we use (read-only, `users:read`). */
interface UsersLike {
	get(id: string): Promise<{ id: string; email: string; name: string | null } | null>;
}

/**
 * Who an entry is attributed to, for the commit. emdash's content hooks do not
 * carry the logged-in editor (the `content:afterSave` event is only
 * `{ content, collection, isNew }`), so this is the best available signal: the
 * entry's assigned author/byline taken from the saved record. `name` always
 * has a human-readable label; `email` is set only when we could resolve a real
 * account, in which case it is used as the git commit author.
 */
interface Editor {
	name: string;
	email?: string;
}

/** Narrow an unknown value to a non-empty trimmed string, else undefined. */
function pickNonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Best-effort: figure out who to attribute the commit to from the saved record.
 *
 * Preference order:
 *   1. The hydrated byline display name (`content.byline.displayName`), and its
 *      linked user (`byline.userId`) resolved to an email via `ctx.users`.
 *   2. The first credited byline in `content.bylines`.
 *   3. The raw `content.authorId`, resolved to a name + email via `ctx.users`.
 *
 * Returns `null` when nothing usable is present, so callers can omit the
 * "edited by" clause and let the commit fall back to the neutral committer.
 *
 * NOTE: this is the *assigned author/byline*, which is not necessarily the
 * person who clicked save. Exposing the true acting user would require a fork
 * change (see README "Who made the edit").
 */
async function resolveEditor(
	content: Record<string, unknown>,
	users?: UsersLike,
): Promise<Editor | null> {
	const byline = content.byline as { displayName?: unknown; userId?: unknown } | null | undefined;
	if (byline) {
		const name = pickNonEmpty(byline.displayName);
		if (name) {
			const userId = pickNonEmpty(byline.userId);
			const email = userId ? await resolveUserEmail(userId, users) : undefined;
			return { name, email };
		}
	}

	const bylines = content.bylines as Array<{ byline?: { displayName?: unknown } }> | undefined;
	if (Array.isArray(bylines)) {
		for (const credit of bylines) {
			const name = pickNonEmpty(credit?.byline?.displayName);
			if (name) return { name };
		}
	}

	const authorId = pickNonEmpty(content.authorId);
	if (authorId && users) {
		try {
			const user = await users.get(authorId);
			const name = pickNonEmpty(user?.name) ?? pickNonEmpty(user?.email);
			if (name) {
				return { name, email: pickNonEmpty(user?.email) };
			}
		} catch {
			// users access is best-effort; ignore and fall through.
		}
	}

	return null;
}

/** Resolve a user id to an email via `ctx.users`, tolerating any failure. */
async function resolveUserEmail(userId: string, users?: UsersLike): Promise<string | undefined> {
	if (!users) return undefined;
	try {
		const user = await users.get(userId);
		return pickNonEmpty(user?.email);
	} catch {
		return undefined;
	}
}

/**
 * Build the commit message. The SUBJECT line is just the change
 * ("Update collection/slug") so GitHub's commit list stays clean; the body
 * (after a blank line, git convention) carries the editor and a link back to
 * this plugin. GitHub renders the subject as the title and the rest as the
 * description.
 */
function commitMessage(verb: string, collection: string, slug: string, editor: Editor | null): string {
	const subject = `${verb} ${collection}/${slug}`;
	const body: string[] = [];
	if (editor) {
		body.push(editor.email ? `Edited by ${editor.name} <${editor.email}>` : `Edited by ${editor.name}`);
	}
	body.push(`via ${PLUGIN_URL}`);
	return `${subject}\n\n${body.join("\n")}`;
}

/**
 * The git identity (commit author + committer) for an edit: the logged-in CMS
 * editor's name AND email when resolvable, otherwise the neutral configured
 * committer (so the commit never falls back to the token-owner account).
 */
function commitIdentity(editor: Editor | null, config: ResolvedConfig): GitIdentity {
	return {
		name: editor?.name ?? config.committerName,
		email: editor?.email ?? config.committerEmail,
	};
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
 * System-managed bookkeeping fields on a saved record that change on every
 * write. emdash fires `content:afterSave` TWICE for a single user save (a
 * draft-save, then the publish), and only these fields differ between the two.
 * Excluding them when comparing means one edit produces one commit, not two.
 */
const VOLATILE_CONTENT_KEYS = new Set([
	"version",
	"updatedAt",
	"liveRevisionId",
	"draftRevisionId",
	"publishedAt",
	"scheduledAt",
]);

/** A stable, key-sorted JSON of the content with volatile bookkeeping removed. */
function substantiveContent(content: Record<string, unknown>): string {
	const filtered: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(content)) {
		if (!VOLATILE_CONTENT_KEYS.has(key)) filtered[key] = value;
	}
	return canonicalJson(filtered);
}

/** Deterministic JSON.stringify with object keys sorted at every depth. */
function canonicalJson(value: unknown): string {
	return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort()) out[key] = sortDeep(obj[key]);
		return out;
	}
	return value;
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
	users?: UsersLike;
}): Promise<void> {
	const { client, config, log, collection, content, isNew, media, http, users } = args;

	const id = pickString(content.id) ?? null;
	const slug = deriveSlug(content, id);
	const path = entryPath(config, collection, slug);

	// Dedup the draft-save + publish double-fire: if the substantive content
	// (ignoring version/revision bookkeeping) is unchanged from the last backup,
	// skip the commit so one edit yields one commit. Also stops no-op saves from
	// adding noise. Best-effort: any read failure falls through to a normal write.
	const existingText = await client.getTextFile(path).catch(() => null);
	if (existingText) {
		try {
			const prev = JSON.parse(existingText) as { content?: Record<string, unknown> };
			if (prev.content && substantiveContent(prev.content) === substantiveContent(content)) {
				log.info("github-backup: entry unchanged, skipping duplicate save", { path });
				return;
			}
		} catch {
			// Unparseable previous backup: fall through and overwrite it.
		}
	}

	const snapshot: Snapshot = {
		collection,
		slug,
		id,
		backedUpAt: new Date().toISOString(),
		content,
	};

	const editor = await resolveEditor(content, users);
	const verb = isNew ? "Create" : "Update";
	const message = commitMessage(verb, collection, slug, editor);

	await client.putTextFile(path, toJson(snapshot), message, commitIdentity(editor, config));
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

	const message = `Delete ${collection}/${safeId} · via ${PLUGIN_URL}`;

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
			await client.putBase64File(path, bytesToBase64(bytes), `Backup media ${filename} · via ${PLUGIN_URL}`);
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

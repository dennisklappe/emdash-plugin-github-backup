/**
 * emdash-plugin-github-backup
 *
 * Backs up emdash content to a GitHub repository folder on every edit. emdash
 * keeps live content in a database; the client's edits do not reach git. This
 * plugin closes that gap: on each content create, update or delete it commits
 * a JSON snapshot to a GitHub repo via the GitHub Contents API. Because every
 * write is a commit, the repository's history becomes the content edit history
 * with file-based, versioned backups.
 *
 * Hooks used:
 *   - content:afterSave   (create + update) -> write/overwrite a JSON snapshot
 *   - content:afterDelete (delete)          -> remove the file (history keeps it)
 */

import { definePlugin } from "emdash";
import type { PluginDescriptor } from "emdash";

import { resolveConfig, type GithubBackupOptions } from "./config.js";
import { createGithubClient } from "./github.js";
import { backupEntry, deleteEntry } from "./backup.js";

const PLUGIN_ID = "github-backup";
const PLUGIN_VERSION = "0.1.1";
const ENTRYPOINT = "emdash-plugin-github-backup";

export type { GithubBackupOptions } from "./config.js";

/**
 * Create the plugin definition. `options` are optional and form the
 * highest-priority config source (see config.ts for the full resolution
 * order). They can be omitted entirely when configuring via the admin
 * settings UI or environment variables.
 */
export function createPlugin(options?: GithubBackupOptions) {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		// network:request -> ctx.http.fetch, restricted to the hosts below.
		// content:read / media:read let the backup read the saved item and any
		// referenced media (media is best-effort, see backup.ts). users:read
		// lets us resolve an entry author id to a name/email for the commit
		// "edited by" clause and author (best-effort, see backup.ts).
		capabilities: ["network:request", "content:read", "media:read", "users:read"],
		allowedHosts: ["api.github.com"],
		admin: {
			settingsSchema: {
				token: {
					type: "secret",
					label: "GitHub token",
					description:
						"Personal access token with write access to the backup repository's contents. Stored as a secret.",
				},
				owner: {
					type: "string",
					label: "Repository owner",
					description: "GitHub user or organisation that owns the backup repository.",
				},
				repo: {
					type: "string",
					label: "Repository name",
					description: "Name of the backup repository.",
				},
				branch: {
					type: "string",
					label: "Branch",
					description: "Branch to commit backups to.",
					default: "main",
				},
				folder: {
					type: "string",
					label: "Folder",
					description: "Folder inside the repository to write backups to.",
					default: "emdash-backup",
				},
				committerName: {
					type: "string",
					label: "Committer name",
					description:
						"Name shown as the commit committer (and as the author when the editing user cannot be resolved). Prevents commits being attributed to the token owner's GitHub account.",
					default: "EmDash CMS",
				},
				committerEmail: {
					type: "string",
					label: "Committer email",
					description:
						"Email for the commit committer. A no-reply address keeps it as plain text without linking to any GitHub account.",
					default: "emdash-cms@users.noreply.github.com",
				},
			},
		},
		hooks: {
			// Fires after the entry is persisted, so the snapshot reflects the
			// saved state. event.content is the saved record, event.collection
			// the collection slug, event.isNew distinguishes create from update.
			"content:afterSave": async (event, ctx) => {
				try {
					const config = await resolveConfig(options, ctx.kv);
					if (!config) {
						ctx.log.warn(
							"github-backup: not configured (need token, owner, repo); skipping backup",
						);
						return;
					}
					if (!ctx.http) {
						ctx.log.warn("github-backup: no HTTP access; skipping backup");
						return;
					}
					const client = createGithubClient(config, ctx.http.fetch.bind(ctx.http));
					await backupEntry({
						client,
						config,
						log: ctx.log,
						collection: event.collection,
						content: event.content,
						isNew: event.isNew,
						media: ctx.media,
						http: ctx.http,
						users: ctx.users,
					});
				} catch (err) {
					// A backup failure must never break the content save.
					ctx.log.error("github-backup: afterSave backup failed", { error: String(err) });
				}
			},

			// Fires after the entry is deleted. We only get id + collection here
			// (no slug), which is why deleteEntry falls back to a tombstone when
			// the live file cannot be located by id.
			"content:afterDelete": async (event, ctx) => {
				try {
					const config = await resolveConfig(options, ctx.kv);
					if (!config) {
						ctx.log.warn(
							"github-backup: not configured (need token, owner, repo); skipping delete backup",
						);
						return;
					}
					if (!ctx.http) {
						ctx.log.warn("github-backup: no HTTP access; skipping delete backup");
						return;
					}
					const client = createGithubClient(config, ctx.http.fetch.bind(ctx.http));
					await deleteEntry({
						client,
						config,
						log: ctx.log,
						collection: event.collection,
						id: event.id,
					});
				} catch (err) {
					ctx.log.error("github-backup: afterDelete backup failed", { error: String(err) });
				}
			},
		},
	});
}

export default createPlugin;

/**
 * Descriptor for use in an emdash() config `plugins` array.
 *
 * @example
 * ```ts
 * import { githubBackupPlugin } from "emdash-plugin-github-backup";
 *
 * emdash({
 *   plugins: [githubBackupPlugin({ owner: "me", repo: "site-backup" })],
 * });
 * ```
 */
export function githubBackupPlugin(options?: GithubBackupOptions): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		entrypoint: ENTRYPOINT,
		format: "native",
		// PluginDescriptor.options is typed as Record<string, unknown>; our
		// option fields are a known subset, so widen at the boundary.
		options: (options ?? {}) as Record<string, unknown>,
	};
}

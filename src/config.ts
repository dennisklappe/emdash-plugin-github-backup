/**
 * Configuration resolution for the GitHub backup plugin.
 *
 * Resolution order (first non-empty value wins, per field):
 *   1. Plugin options passed to githubBackupPlugin({ ... }) / createPlugin({ ... })
 *   2. Admin settings stored in ctx.kv under the "settings:" prefix
 *   3. Environment variables
 *
 * The token is treated as a secret. It is never written to a backup file
 * and never logged.
 */

export interface GithubBackupOptions {
	/** GitHub personal access token (or fine-grained token) with contents write access. */
	token?: string;
	/** Repository owner (user or organisation). */
	owner?: string;
	/** Repository name. */
	repo?: string;
	/** Branch to commit backups to. Defaults to "main". */
	branch?: string;
	/** Folder (path prefix) inside the repo to write backups to. Defaults to "emdash-backup". */
	folder?: string;
}

export interface ResolvedConfig {
	token: string;
	owner: string;
	repo: string;
	branch: string;
	folder: string;
}

/** Minimal subset of the plugin KV API this module relies on. */
interface KvLike {
	get<T>(key: string): Promise<T | null>;
}

const DEFAULT_BRANCH = "main";
const DEFAULT_FOLDER = "emdash-backup";

function firstNonEmpty(...values: Array<string | null | undefined>): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) {
			return value.trim();
		}
	}
	return "";
}

function readEnv(name: string): string | undefined {
	// process may not exist in every runtime (for example a strict edge
	// sandbox). Guard so a missing global never throws.
	const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
	return proc?.env?.[name];
}

/**
 * Split a "owner/repo" string into its parts. Returns empty strings when the
 * input does not contain a single slash.
 */
function splitRepo(value: string | undefined): { owner: string; repo: string } {
	if (!value) return { owner: "", repo: "" };
	const parts = value.split("/");
	if (parts.length !== 2) return { owner: "", repo: "" };
	return { owner: parts[0].trim(), repo: parts[1].trim() };
}

/**
 * Resolve the effective configuration from options, KV settings and env vars.
 *
 * Returns `null` (after logging a warning) when the required fields (token,
 * owner, repo) cannot all be resolved, so callers can skip the backup
 * without throwing.
 */
export async function resolveConfig(
	options: GithubBackupOptions | undefined,
	kv: KvLike,
): Promise<ResolvedConfig | null> {
	const opt = options ?? {};

	// KV settings (admin UI). Read each key independently and tolerate any
	// read failing (a fresh install has no settings yet).
	const kvGet = async (key: string): Promise<string | undefined> => {
		try {
			const value = await kv.get<string>(key);
			return typeof value === "string" ? value : undefined;
		} catch {
			return undefined;
		}
	};

	const [kvToken, kvOwner, kvRepo, kvBranch, kvFolder] = await Promise.all([
		kvGet("settings:token"),
		kvGet("settings:owner"),
		kvGet("settings:repo"),
		kvGet("settings:branch"),
		kvGet("settings:folder"),
	]);

	// Env var GITHUB_BACKUP_REPO is "owner/repo".
	const envRepoPair = splitRepo(readEnv("GITHUB_BACKUP_REPO"));

	const token = firstNonEmpty(opt.token, kvToken, readEnv("GITHUB_BACKUP_TOKEN"));
	const owner = firstNonEmpty(opt.owner, kvOwner, envRepoPair.owner);
	const repo = firstNonEmpty(opt.repo, kvRepo, envRepoPair.repo);
	const branch = firstNonEmpty(opt.branch, kvBranch, readEnv("GITHUB_BACKUP_BRANCH"), DEFAULT_BRANCH);
	const folder = firstNonEmpty(opt.folder, kvFolder, readEnv("GITHUB_BACKUP_FOLDER"), DEFAULT_FOLDER);

	if (!token || !owner || !repo) {
		return null;
	}

	return { token, owner, repo, branch, folder };
}

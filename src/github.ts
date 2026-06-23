/**
 * Minimal GitHub Contents API client.
 *
 * Uses only the "create or update file contents" and "get contents"
 * endpoints, which is all that is needed to commit a backup file:
 *   GET  /repos/{owner}/{repo}/contents/{path}  (to read the current sha)
 *   PUT  /repos/{owner}/{repo}/contents/{path}  (to create or overwrite)
 *
 * Every PUT is a commit, so the repository history becomes the edit history.
 *
 * The client is given a `fetch`-compatible function (the plugin passes
 * `ctx.http.fetch`, which is host-restricted to api.github.com via the
 * declared `allowedHosts`).
 */

import type { ResolvedConfig } from "./config.js";

const API_BASE = "https://api.github.com";
const ACCEPT = "application/vnd.github+json";
const USER_AGENT = "emdash-plugin-github-backup";
const API_VERSION = "2022-11-28";

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GithubClient {
	/** Write (create or overwrite) a UTF-8 text file at `path`. */
	putTextFile(path: string, content: string, message: string): Promise<void>;
	/** Write (create or overwrite) a binary file at `path` from base64 content. */
	putBase64File(path: string, base64: string, message: string): Promise<void>;
	/** Delete a file at `path`. No-op when the file does not exist. */
	deleteFile(path: string, message: string): Promise<void>;
	/** Return true when a file already exists at `path`. */
	fileExists(path: string): Promise<boolean>;
}

function authHeaders(token: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		Accept: ACCEPT,
		"User-Agent": USER_AGENT,
		"X-GitHub-Api-Version": API_VERSION,
	};
}

/** Encode a UTF-8 string to base64 in a runtime-agnostic way. */
export function toBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	return bytesToBase64(bytes);
}

/** Encode raw bytes to base64. */
export function bytesToBase64(bytes: Uint8Array): string {
	// Prefer Buffer when available (Node), fall back to btoa (edge runtimes).
	const maybeBuffer = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } })
		.Buffer;
	if (maybeBuffer) {
		return maybeBuffer.from(bytes).toString("base64");
	}
	let binary = "";
	for (let i = 0; i < bytes.length; i += 1) {
		binary += String.fromCharCode(bytes[i]);
	}
	// btoa is available in browser and most edge runtimes.
	return (globalThis as { btoa: (s: string) => string }).btoa(binary);
}

/**
 * GitHub paths must not be URL-encoded as a whole (the slashes are real path
 * separators), but each segment should be encoded so names with spaces or
 * unicode work. We encode per segment and rejoin with "/".
 */
function encodePath(path: string): string {
	return path
		.split("/")
		.filter((segment) => segment.length > 0)
		.map((segment) => encodeURIComponent(segment))
		.join("/");
}

export function createGithubClient(config: ResolvedConfig, fetchFn: FetchLike): GithubClient {
	const { owner, repo, branch, token } = config;

	const contentsUrl = (path: string): string =>
		`${API_BASE}/repos/${owner}/${repo}/contents/${encodePath(path)}`;

	/**
	 * Look up the current blob sha for a path on the target branch. Returns
	 * `null` when the file does not exist (HTTP 404), which is the signal to
	 * create instead of update.
	 */
	const getSha = async (path: string): Promise<string | null> => {
		const url = `${contentsUrl(path)}?ref=${encodeURIComponent(branch)}`;
		const res = await fetchFn(url, { method: "GET", headers: authHeaders(token) });
		if (res.status === 404) {
			return null;
		}
		if (!res.ok) {
			throw new Error(`GitHub GET ${path} failed: ${res.status} ${await safeText(res)}`);
		}
		const body = (await res.json()) as { sha?: string };
		return body.sha ?? null;
	};

	const put = async (path: string, base64: string, message: string): Promise<void> => {
		// Read the current sha so an existing file is updated rather than
		// rejected. When the file is new, sha stays null and GitHub creates it.
		const sha = await getSha(path);
		const payload: Record<string, unknown> = {
			message,
			content: base64,
			branch,
		};
		if (sha) {
			payload.sha = sha;
		}

		const res = await fetchFn(contentsUrl(path), {
			method: "PUT",
			headers: { ...authHeaders(token), "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});

		// 409 (conflict) / 422 (unprocessable) usually mean the sha went stale
		// between our GET and PUT (a concurrent write). Retry once with a fresh
		// sha before giving up.
		if (res.status === 409 || res.status === 422) {
			const freshSha = await getSha(path);
			const retryPayload: Record<string, unknown> = { message, content: base64, branch };
			if (freshSha) {
				retryPayload.sha = freshSha;
			}
			const retry = await fetchFn(contentsUrl(path), {
				method: "PUT",
				headers: { ...authHeaders(token), "Content-Type": "application/json" },
				body: JSON.stringify(retryPayload),
			});
			if (!retry.ok) {
				throw new Error(`GitHub PUT ${path} failed after retry: ${retry.status} ${await safeText(retry)}`);
			}
			return;
		}

		if (!res.ok) {
			throw new Error(`GitHub PUT ${path} failed: ${res.status} ${await safeText(res)}`);
		}
	};

	return {
		async putTextFile(path, content, message) {
			await put(path, toBase64(content), message);
		},
		async putBase64File(path, base64, message) {
			await put(path, base64, message);
		},
		async deleteFile(path, message) {
			const sha = await getSha(path);
			if (!sha) {
				// Nothing to delete.
				return;
			}
			const res = await fetchFn(contentsUrl(path), {
				method: "DELETE",
				headers: { ...authHeaders(token), "Content-Type": "application/json" },
				body: JSON.stringify({ message, sha, branch }),
			});
			if (!res.ok) {
				throw new Error(`GitHub DELETE ${path} failed: ${res.status} ${await safeText(res)}`);
			}
		},
		async fileExists(path) {
			return (await getSha(path)) !== null;
		},
	};
}

async function safeText(res: Response): Promise<string> {
	try {
		return (await res.text()).slice(0, 500);
	} catch {
		return "(no body)";
	}
}

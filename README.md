# emdash-plugin-github-backup

Backs up [emdash](https://emdash.cc) CMS content to a GitHub repository folder
on every edit. emdash keeps live content in a database (D1), so the client's
edits never reach git. This plugin closes that gap: on each content create,
update or delete it commits a JSON snapshot to a GitHub repository via the
GitHub Contents API. Because every write is a commit, the repository's history
becomes the content edit history, with file-based, versioned backups.

This is an independent, open-source plugin. It is not affiliated with or
endorsed by the emdash project.

## What it does

- On create or update (`content:afterSave`): writes (or overwrites) a
  pretty-printed JSON file at `<folder>/<collection>/<slug>.json` on the
  configured branch. The commit message records the collection and slug.
- On delete (`content:afterDelete`): removes the file so the working tree
  mirrors live content. The full pre-delete content stays recoverable from git
  history. When the file cannot be located by id (the delete event carries only
  an id, not a slug), a small tombstone is written at
  `<folder>/<collection>/_deleted/<id>.json` so the deletion is still recorded
  as a commit.
- Media (best effort): values that look like media references are collected
  from the saved entry. When media read access and the HTTP client are both
  available, each referenced file is copied to `<folder>/media/<filename>`. See
  Limitations for when this is skipped.

A backup failure never breaks the content save. Errors are caught and logged.

## Install

```sh
npm install emdash-plugin-github-backup
```

Add it to your emdash config's `plugins` array:

```ts
import { githubBackupPlugin } from "emdash-plugin-github-backup";

export default emdash({
  plugins: [
    githubBackupPlugin({ owner: "your-name", repo: "your-backup-repo" }),
  ],
});
```

The token is best supplied via the admin settings UI (stored as a secret) or an
environment variable rather than in code.

## Configuration

Five settings: `token`, `owner`, `repo`, `branch`, `folder`. Each is resolved
independently, first non-empty value wins, in this order:

1. Plugin options passed to `githubBackupPlugin({ ... })`.
2. Admin settings (the plugin exposes a settings schema; `token` is a secret).
3. Environment variables.

| Field  | Option   | Env var                  | Default         |
| ------ | -------- | ------------------------ | --------------- |
| token  | `token`  | `GITHUB_BACKUP_TOKEN`    | (required)      |
| owner  | `owner`  | `GITHUB_BACKUP_REPO` (1) | (required)      |
| repo   | `repo`   | `GITHUB_BACKUP_REPO` (1) | (required)      |
| branch | `branch` | `GITHUB_BACKUP_BRANCH`   | `main`          |
| folder | `folder` | `GITHUB_BACKUP_FOLDER`   | `emdash-backup` |

(1) `GITHUB_BACKUP_REPO` is a single `owner/repo` string, for example
`dennisklappe/my-site-backup`. It is split into owner and repo.

The token needs write access to the target repository's contents (a
fine-grained token with Contents: Read and write, or a classic token with the
`repo` scope). When `token`, `owner` or `repo` cannot be resolved, the backup
is skipped with a warning and the content save proceeds normally.

## What gets backed up

- Text content: always (when configured). One JSON file per entry, keyed by
  slug.
- Media bytes: best effort, only when reachable (see Limitations).

## How it works (GitHub API)

For each entry the plugin calls the GitHub Contents API:

- `GET /repos/{owner}/{repo}/contents/{path}?ref={branch}` to read the current
  file's blob `sha`. A 404 means the file is new.
- `PUT /repos/{owner}/{repo}/contents/{path}` with `{ message, content
  (base64), branch }`, plus `sha` when overwriting an existing file. Auth is
  `Authorization: Bearer <token>`, with `Accept: application/vnd.github+json`,
  an `X-GitHub-Api-Version` header and a `User-Agent`.
- Deletes use `DELETE` with the file's `sha`.

If a `PUT` returns 409 or 422 (usually a stale sha from a concurrent write),
the plugin re-reads the sha once and retries.

## Limitations and assumptions

- Hooks fire after persistence (`content:afterSave`, `content:afterDelete`), so
  snapshots reflect the saved state. If a save succeeds but the backup commit
  fails, live content and the backup can drift until the next edit. This is by
  design: the save is never blocked by a backup failure.
- The delete event provides only an id and collection, not a slug, while
  snapshots are keyed by slug. When the file cannot be found by id, a tombstone
  keyed by id is written instead of deleting the slug-named file. Deleting an
  entry and re-creating one with the same slug will overwrite, which is the
  intended mirror behaviour.
- Media bytes are only backed up when the media URL can be fetched through the
  host-restricted HTTP client. The plugin declares `api.github.com` as its only
  allowed host, so media served from another host (a CDN or object store) is
  not fetchable and is skipped with a warning. The text backup still includes
  the media reference, so nothing is lost from the content snapshot. Media
  reference detection is heuristic (keys such as image, media, file, cover).
- Slugs and collection names are sanitised to safe path segments. Two entries
  that sanitise to the same slug would share a file; pick distinct slugs to
  avoid this.

## License

MIT, Dennis Klappe.

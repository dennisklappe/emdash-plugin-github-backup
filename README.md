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
  configured branch. The commit **subject** is just `Update <collection>/<slug>`
  (clean in GitHub's commit list); the **body** carries an `Edited by <name>
  <email>` line when the entry's author can be resolved (see "Who made the
  edit") and a link back to this plugin.
- One edit, one commit: emdash fires `content:afterSave` twice for a single save
  (a draft-save, then the publish). Before committing, the plugin compares the
  substantive content (ignoring `version` / `updatedAt` / revision-id
  bookkeeping) against the last backup and skips the write when nothing
  meaningful changed, so a single edit no longer produces two commits. No-op
  saves are skipped for the same reason.
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

## Commit identity (who shows up on the commit)

By default the GitHub Contents API attributes every commit to the **owner of the
token** used to write it. With a dedicated backup token that renders as a
confusing phantom account on GitHub. To avoid that, every commit is made under an
explicit, neutral committer:

- **Committer**: `EmDash CMS Backup <emdash-cms@users.noreply.github.com>` by default.
  The no-reply email is intentional: it shows the name as plain text and does
  not link to any GitHub account. Override it with the `committerName` /
  `committerEmail` settings (or `GITHUB_BACKUP_COMMITTER_NAME` /
  `GITHUB_BACKUP_COMMITTER_EMAIL`).
- **Author**: the CMS user the entry is attributed to, when that user can be
  resolved to a real email (see below). The commit then links to that person's
  GitHub account, just like a normal commit. When no user can be resolved, the
  author falls back to the neutral committer.

## Who made the edit

emdash's content hooks do **not** carry the logged-in editor. The
`content:afterSave` event is only `{ content, collection, isNew }` and
`content:afterDelete` is `{ id, collection, permanent }` — neither includes the
acting user / session. So the plugin uses the best available signal: the saved
record's **assigned author / byline** (`content.byline`, `content.bylines`,
`content.authorId`), resolving an id to a name and email via `ctx.users` (the
`users:read` capability). This is the entry's author, which is usually but not
necessarily the same person who clicked save.

To attribute commits to the *actual* acting user, the emdash core would need to
include it in the hook event — e.g. add a `user` field to `ContentHookEvent` and
pass the request's session user into `runAfterSaveHooks` in `emdash-runtime.ts`.
Until then the plugin degrades gracefully: when no author can be resolved, the
`edited by` clause is omitted and the commit uses the neutral committer.

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

| Field          | Option           | Env var                          | Default                                |
| -------------- | ---------------- | -------------------------------- | -------------------------------------- |
| token          | `token`          | `GITHUB_BACKUP_TOKEN`            | (required)                             |
| owner          | `owner`          | `GITHUB_BACKUP_REPO` (1)         | (required)                             |
| repo           | `repo`           | `GITHUB_BACKUP_REPO` (1)         | (required)                             |
| branch         | `branch`         | `GITHUB_BACKUP_BRANCH`           | `main`                                 |
| folder         | `folder`         | `GITHUB_BACKUP_FOLDER`           | `emdash-backup`                        |
| committerName  | `committerName`  | `GITHUB_BACKUP_COMMITTER_NAME`   | `EmDash CMS Backup`                           |
| committerEmail | `committerEmail` | `GITHUB_BACKUP_COMMITTER_EMAIL`  | `emdash-cms@users.noreply.github.com`  |

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
  (base64), branch, committer, author }`, plus `sha` when overwriting an
  existing file. `committer` and `author` are set explicitly (see "Commit
  identity") so commits are never attributed to the token owner. Auth is
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

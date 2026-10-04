# git-drift

**Find code that never made it to GitHub: on your laptop and on your servers.**

```sh
npx git-drift scan ~/code
```

```
git-drift — 4 drifted, 31 clean

✗ ~/code/api [local] main @ 2c71f0e — 3 uncommitted changes (+1 more)
    • 3 uncommitted changes
         M src/billing.ts
        ?? scripts/backfill.ts
        ?? notes.md
    • 1 local branch has commits not on GitHub
        spike/new-pricing (9b2e44d)
✗ ~/code/side-project [local] no git remote: nothing in this repo is on GitHub
✗ ~/code/infra [local] main @ 77a01c9 — 2 stashes (hidden uncommitted work)
✗ ~/code/web [local] main @ 4be19d0 — uncommitted changes in 1 other worktree
```

Work goes missing in two places:

- **Your machine:** uncommitted changes, forgotten stashes, branches you never pushed, a commit that lives
  only in one clone, a worktree with edits in it, a whole project that never got a remote.
- **Your servers:** a hot-fix over SSH, a cron script edited in place, an AI coding agent with shell access
  "just fixing it" on the box, a half-failed deploy, a server three commits behind. Deploy-on-push moves code
  from the repo to the server; nothing checks the other direction.

`git-drift` checks every repo and deployment against GitHub and reports what doesn't match.

## Quick start: your laptop

```sh
npx git-drift scan ~/code            # every git repo under ~/code (default depth 3)
npx git-drift scan ~/code ~/work     # several folders
```

No config. For each repo it finds, it reads the GitHub remote and flags:

| flagged (drift) | just a note |
|---|---|
| uncommitted changes, stashes | behind GitHub (nothing is lost, just pull) |
| commits or local branches GitHub has never seen | on a branch other than the default |
| uncommitted changes in other worktrees | pushed but not merged |
| a repo with **no remote at all** | a remote that isn't GitHub (not checked) |

## Servers

The same scan works over SSH. Nothing is installed on the server:

```sh
npx git-drift scan --ssh web-1 /srv /opt
```

For deployments that aren't plain git checkouts (rsync copies, build output, version stamps), and for a
weekly report across everything, write a config (`git-drift init` writes an example):

```
$ git-drift
git-drift — 2 drifted, 31 clean

✗ cron jobs [web] 1 differ, 1 only here vs acme/ops/cron @ main 3f9c2d1
    • 1 file differs from main 3f9c2d1
        backup.sh
    • 1 file exists only here (not in the repo, not gitignored)
        cleanup-old-logs.sh
✗ api [web] main @ 8e0b1a4 — commit 8e0b1a4 is not on GitHub — it exists only here
```

### Why not just `git status`?

- **rsync/CI deploys** usually have no `.git`, or a stale one that no deploy ever updates.
- **Build output** (`dist/`, `build/`) can't be compared to source with git.
- **`git status`** can't tell you a commit was never pushed, that a stash exists, or that you're 4 commits behind.

For copied deployments `git-drift` compares content, not git metadata. It hashes every file on the server
the way git does and checks it against the blob SHAs in GitHub's tree for the expected commit.

## How it works

- **Nothing to install on servers.** Each check is a short, read-only POSIX shell script piped over your
  existing SSH (`ssh host sh -s`). The host needs `git` (or `python3` for file hashing).
- **No clones.** The expected state comes from the GitHub API.
- **Deterministic.** No AI in the loop. Exit code 0 = clean, 1 = drift, 2 = a check failed to run.

Needs Node 20+ (macOS or Linux). GitHub auth comes from `GITHUB_TOKEN` / `GH_TOKEN`, or the token from
`gh auth login`. Private repos need a token with read access.

## Config

`git-drift.config.json`:

```json
{
  "github": { "owner": "acme" },
  "hosts": {
    "web": { "ssh": "web-1" },
    "worker": { "ssh": "deploy@203.0.113.10", "sshArgs": ["-p", "2222"] }
  },
  "defaults": {
    "exclude": [".git", "node_modules"],
    "ignore": ["package-lock.json", "yarn.lock"]
  },
  "targets": [
    { "name": "api", "type": "git", "host": "web", "path": "/srv/api", "repo": "api" },
    { "name": "site", "type": "files", "host": "web", "path": "/var/www/site", "repo": "site", "subdir": "public" },
    { "name": "cron jobs", "type": "files", "host": "web", "path": "/opt/cron", "repo": "ops", "subdir": "cron" },
    { "name": "worker build", "type": "stamp", "host": "worker", "path": "/opt/worker/build/version.json", "field": "sha", "repo": "worker" },
    { "name": "worker up", "type": "command", "host": "worker", "run": "systemctl is-active worker", "expect": "^active$" }
  ],
  "discover": [
    { "host": "local", "roots": ["~/code"], "maxDepth": 2, "check": true, "onlyUnpushed": true },
    { "host": "web", "roots": ["/srv", "/opt"], "maxDepth": 2 }
  ],
  "githubRepos": { "repos": ["api", "site", "ops", "worker"], "ignoreBranches": ["dependabot/*"] }
}
```

| type | for | passes when |
|---|---|---|
| `git` | a git checkout on a server, or a repo on this machine (no `host`) | on `ref` at the same commit as GitHub, nothing uncommitted, no stashes, no worktree edits, no local branch with commits GitHub has never seen |
| `files` | a directory deployed by rsync / copy / CI | every file matches the repo at `ref` (optionally a `subdir`), no repo file is missing, no extra file the repo's `.gitignore` doesn't explain |
| `stamp` | a build that records its commit (e.g. `build/version.json`) | the recorded SHA is `ref` |
| `command` | anything else | exits 0, and the output matches `expect` (and not `fail`) |

- **`discover`** finds git checkouts under `roots`. With `"check": true`, every one that no target covers
  is checked against its own GitHub remote (what `scan` does). Without it, uncovered checkouts are listed as
  drift: new or forgotten deployments. `ignore` lists paths to skip.
- **`onlyUnpushed`** (on `git` targets and `discover`): only work missing from GitHub counts as drift; being
  behind, unmerged, or on another branch is a note. Use it for laptops; leave it off for deployments, where
  "3 commits behind" is exactly what you want to know.
- **`githubRepos`**: open pull requests and branches not merged into the default branch. These are notes and never fail the run.

Also: `ref` (a branch, tag or SHA; default = the repo's default branch) on `git`/`files`/`stamp`;
`allowDetached` and `checkBranches` on `git`; `subdir`, `exclude` and `ignore` on `files`; `field` (a JSON dot
path) or `pattern` (a regex whose first group is the SHA) on `stamp`; `expect`, `fail` and `timeoutSec` on
`command`. Paths may use `~/…`, which is expanded on the host the check runs on.

## Usage

```
git-drift scan [dir...] [--ssh host] [--depth n]     every repo under the dirs
git-drift [-c config.json]                           everything in a config file
git-drift init                                       write an example config

  -f text|markdown|html|json   stdout format          -o report.md   also write a report (repeatable)
  -q                           hide clean checks      --only name    only matching checks / host
```

Run it from cron, launchd or a scheduled CI job for a weekly report.

## Safety

Every probe only reads. They run `git rev-parse` / `status` / `stash list` / `worktree list` /
`for-each-ref` / `config --get`, `find`, `git hash-object` (or python3 `hashlib`) and `cat` on stamp files,
with `GIT_OPTIONAL_LOCKS=0` and `core.fsmonitor=false` so git neither rewrites the index nor runs a repo's
monitor hook. They create one temp directory and remove it. `command` checks run whatever you write. Everything
runs with your SSH user's permissions.

## License

MIT

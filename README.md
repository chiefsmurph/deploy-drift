# deploy-drift

**Find code that exists only on your servers.**

Deploy-on-push moves code from the repo to the server. Nothing checks the other direction. Over time servers
drift from GitHub: a hot-fix over SSH, a cron script edited in place, an AI coding agent with shell access
"just fixing it" on the box, a deploy that half-failed, a server three commits behind. Then the next
`rsync --delete` silently wipes the fix, or the next `git pull` refuses to run, or nobody knows what's actually live.

`deploy-drift` checks every deployment you list against GitHub, file by file, and reports what doesn't match.

```
$ deploy-drift -q
deploy-drift — 2 drifted, 31 clean  (2026-10-04 15:00 UTC)

✗ cron jobs [web] 1 differ, 1 only here vs acme/ops/cron @ main 3f9c2d1
    • 1 file differs from main 3f9c2d1
        backup.sh
    • 1 file exists only here (not in the repo, not gitignored)
        cleanup-old-logs.sh
✗ api [web] main @ 8e0b1a4 — deployed commit 8e0b1a4 is not on GitHub — it exists only here
```

## Why not just `git status`?

Because most deployments don't have a trustworthy `.git`:

- **rsync/CI deploys** usually have no `.git` at all, or a stale one that no deploy ever updates.
- **Build output** (`dist/`, `build/`) can't be compared to source with git.
- **`git status`** can't tell you that the commit you're on was never pushed, or that you're 4 commits behind.

`deploy-drift` compares content, not git metadata. It hashes every file on the server the way git does and
checks it against the blob SHAs in GitHub's tree for the expected commit.

## How it works

- **Nothing to install on servers.** Each check is a short, read-only POSIX shell script piped over your
  existing SSH (`ssh host sh -s`). The host needs `git` or `python3` to hash files.
- **No clones.** The expected state comes from the GitHub API, so it also runs from CI.
- **Deterministic.** No AI in the loop: same inputs, same answer. Exit code 0 = clean, 1 = drift, 2 = a check failed to run.

## Install

```sh
npm install -g deploy-drift    # or run with npx deploy-drift
deploy-drift init              # writes deploy-drift.config.json for you to edit
deploy-drift                   # run every check
```

Needs Node 20+ and `ssh` on the machine running it (macOS or Linux). For GitHub auth it uses `GITHUB_TOKEN` /
`GH_TOKEN`, or the token from `gh auth login`. Private repos need a token with read access.

## Check types

| type | for | passes when |
|---|---|---|
| `git` | a git checkout on a server (or your laptop) | on `ref` at the same commit as GitHub, nothing uncommitted, no stashes, no local branch with commits GitHub has never seen |
| `files` | a directory deployed by rsync / copy / CI | every file matches the repo at `ref` (optionally a `subdir`), no repo file is missing, and no extra file exists that the repo's `.gitignore` doesn't explain |
| `stamp` | a build that records its commit (e.g. `build/version.json`) | the recorded SHA is `ref` |
| `command` | anything else | the command exits 0 and its output matches `expect` (and not `fail`) |

Plus:

- **`discover`**: git checkouts under given roots that no target covers. A new or forgotten deployment shows up as drift until you add or ignore it.
- **`githubRepos`**: open pull requests and branches not merged into the default branch. Reported as notes; never fails the run.

When a commit doesn't match, it tells you how: **behind** (needs a deploy), **ahead** or **diverged** (something
unmerged is deployed), or **not on GitHub** (commits that exist only on that machine).

## Config

`deploy-drift.config.json`:

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
    { "name": "worker up", "type": "command", "host": "worker", "run": "systemctl is-active worker", "expect": "^active$" },
    { "name": "laptop: api", "type": "git", "path": "~/code/api", "repo": "api" }
  ],
  "discover": [{ "host": "web", "roots": ["/srv", "/opt"], "maxDepth": 2 }],
  "githubRepos": { "repos": ["api", "site", "ops", "worker"], "ignoreBranches": ["dependabot/*"] }
}
```

- **`hosts`**: an `ssh` destination (an `~/.ssh/config` alias or `user@host`). The host `local` (this machine) always exists, and targets without a `host` use it.
- **`repo`**: `name` (uses `github.owner`) or `owner/name`. **`ref`**: a branch, tag or SHA; defaults to the repo's default branch.
- **`defaults.exclude`**: names (any depth) or paths that are never walked. **`ignore`**: gitignore-style patterns left out of `files` comparisons.
- **`git`** also takes `allowDetached` (for submodules or tag pins) and `checkBranches` (default true).
- **`files`** also takes `subdir`, `exclude` and `ignore`.
- **`stamp`** takes `field` (a JSON dot path) or `pattern` (a regex whose first group is the SHA).
- **`command`** takes `expect`, `fail` and `timeoutSec`.

Use absolute paths, or `~/…` (expanded on the host it runs on).

## Usage

```
deploy-drift [-c config.json] [-f text|markdown|html|json] [-o report.md]... [--only name]... [-q]
```

- `-o` writes extra reports, with the format taken from the extension (`.md`, `.html`, `.json`, `.txt`). Useful for a weekly email or a CI artifact.
- `--only` runs checks whose name contains the text, or that run on the named host.
- `-q` leaves clean checks out of the report.

Run it from cron, launchd or a scheduled CI job.

## Safety

Every probe only reads. They run `git rev-parse` / `status` / `stash list` / `for-each-ref`, `find`,
`git hash-object` (or python3 `hashlib`) and `cat` on stamp files, and create one temp directory that they
remove. The exception is `command` checks, which run whatever you write. Everything runs with your SSH user's
permissions, so use a read-only account where you can.

## License

MIT

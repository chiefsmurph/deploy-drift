# deploy-drift

Find servers that have drifted from GitHub.

Over time, what runs on a server stops matching the repo: someone hot-fixes a file over SSH, a deploy
half-fails, a cron script gets edited in place, a box sits three commits behind, or a fix exists *only*
on the server. `git status` misses most of this. Rsync deploys have no `.git` at all, and CI-deployed boxes
often have a stale checkout that says nothing about what is actually running.

`deploy-drift` checks every deployment you list against GitHub, file by file, and tells you what doesn't match.

```
$ deploy-drift
deploy-drift — 2 drifted, 31 clean  (2026-10-04 15:00 UTC)

✗ web job-watch [web] 2 differ vs you/ops/job-watch @ main 1a04b03
    • 2 files differ from main 1a04b03
        boards.json
        watch.mjs
✗ web api [web] main @ 880bb18 — behind main by 4 commits (880bb18 vs main 7bde6a3)
✓ worker build [worker] deployed eafc29d = main on GitHub
...
```

- **Nothing to install on servers.** Each check is a short read-only shell script piped over your existing SSH
  (`ssh host sh -s`). It needs `git` *or* `python3` on the host to hash files.
- **No clones.** Expected content comes from the GitHub API (git blob SHAs), so it also runs in CI.
- **Deterministic.** No AI in the loop: same inputs, same answer.

## Install

```sh
npm install -g deploy-drift     # or: npx deploy-drift
deploy-drift init               # writes deploy-drift.config.json to edit
deploy-drift                    # run it
```

GitHub auth: `GITHUB_TOKEN` / `GH_TOKEN`, or the token from `gh auth login`. Private repos need a token with read access.

## Check types

| type | for | passes when |
|---|---|---|
| `git` | a git checkout on a host (or your laptop) | on `ref`, at the same commit as GitHub, nothing uncommitted, no stashes, no local branches GitHub has never seen |
| `files` | a directory deployed by copy / rsync / CI | every file's content matches the repo at `ref` (optionally a `subdir`); no repo files missing; no extra files the repo's `.gitignore` doesn't explain |
| `stamp` | a build that records its commit (e.g. `build/version.json`) | the recorded SHA is `ref` |
| `command` | anything else | the command exits 0 and its output matches `expect` (and not `fail`) |

Plus:

- **`discover`**: lists git checkouts under given roots that no target covers. New or forgotten deployments show up as drift until you add (or ignore) them.
- **`githubRepos`**: open pull requests and branches not merged into the default branch. Reported as info; never fails the run.

When a commit doesn't match, it says how: **behind** (needs a deploy), **ahead** / **diverged** (deployed something unmerged), or
**not on GitHub** (commits that exist only on that machine, the one you most want to know about).

## Config

```jsonc
{
  "github": { "owner": "your-github-user" },          // default owner for bare repo names
  "hosts": {
    "web": { "ssh": "web-1" },                         // an ~/.ssh/config alias or user@host
    "worker": { "ssh": "deploy@203.0.113.10", "sshArgs": ["-p", "2222"] }
  },                                                    // "local" (this machine) always exists
  "defaults": {
    "exclude": [".git", "node_modules"],                // never walked or compared
    "ignore": ["package-lock.json", "yarn.lock"]        // gitignore-style; left out of files checks
  },
  "targets": [
    { "name": "api", "type": "git", "host": "web", "path": "/srv/api", "repo": "api" },
    { "name": "site", "type": "files", "host": "web", "path": "/var/www/site", "repo": "site", "subdir": "public" },
    { "name": "worker build", "type": "stamp", "host": "worker", "path": "/opt/worker/build/version.json", "field": "sha", "repo": "worker" },
    { "name": "worker up", "type": "command", "host": "worker", "run": "systemctl is-active worker", "expect": "^active$" },
    { "name": "laptop api", "type": "git", "path": "~/code/api", "repo": "api" }
  ],
  "discover": [{ "host": "web", "roots": ["/srv"], "maxDepth": 2, "ignore": ["/srv/vendor-tool"] }],
  "githubRepos": { "repos": ["api", "site"], "ignoreBranches": ["dependabot/*"] }
}
```

(The real file is plain JSON, without comments. See [`examples/`](examples/).)

Per-target options: `ref` (branch, tag or SHA; default = the repo's default branch) on `git`/`files`/`stamp`;
`allowDetached` and `checkBranches` on `git`; `subdir`, `exclude`, `ignore` on `files`; `field` (JSON dot path) or
`pattern` (regex, first group = SHA) on `stamp`; `expect`, `fail`, `timeoutSec` on `command`.

## Usage

```
deploy-drift [-c config.json] [-f text|markdown|html|json] [-o report.md]... [--only name]... [-q]
```

- `-o` writes extra reports (format from the extension), handy for email or a CI artifact.
- `--only` runs checks whose name contains the text, or that run on a given host.
- Exit codes: **0** clean, **1** drift found, **2** a check couldn't run or the config is invalid.

Run it from cron/launchd for a weekly email, or from CI on a schedule.

## Security

The tool only reads. Remote probes run `git rev-parse/status/stash list/for-each-ref`, `find`, `git hash-object`
(or python3 `hashlib`), `cat` of stamp files, plus whatever `command` checks you write yourself. They create
one temp directory and remove it. Commands run with your SSH user's permissions, so use a read-only account
if you can.

## License

MIT

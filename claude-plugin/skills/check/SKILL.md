---
name: check
description: Check git repos and servers for code that never made it to GitHub (uncommitted or unpushed work, stashes, repos with no remote, servers edited by hand or behind), explain each finding in plain language, and fix them with the user's approval. Use when the user asks to check for drift, find unpushed or uncommitted work, audit what's deployed, or deal with a git-drift report or email.
---

# git-drift: check and fix

You help the user find work that isn't on GitHub and resolve it safely. git-drift does the detection
(deterministic, read-only); you do the judgment: what each finding means, which side is right, and the fix.

## 0. Check the prerequisites (once per session)

git-drift is a command-line tool (an npm package, or a standalone binary); this skill only drives it. Check
quietly, in one command:
`command -v git-drift; node -v; command -v npx; command -v brew; git --version; (gh auth status 2>&1 | head -2) || true; [ -n "$GITHUB_TOKEN$GH_TOKEN" ] && echo token-set`

- **git-drift on PATH**: use it.
- **Not installed**: if Node.js 20+ is present, run it through `npx -y git-drift@latest` (downloads it from npm
  on first use). Without Node.js, offer the standalone install (no Node needed), and run it only after the user
  says yes:
  - macOS or Linux with Homebrew: `brew install chiefsmurph/tap/git-drift`
  - otherwise: `curl -fsSL https://raw.githubusercontent.com/chiefsmurph/git-drift/main/install.sh | sh`
    (puts it in `~/.local/bin`; mention adding that to PATH if the script says so)
  Then confirm with `git-drift --version`.
- **No git**: git-drift checks git repos, so git is required. Offer `brew install git` (macOS) or the system
  package manager, again only with their OK.
- **GitHub access**: public repos work without login. For private repos git-drift needs `GITHUB_TOKEN` /
  `GH_TOKEN`, or the GitHub CLI logged in (`gh auth login`). If neither is set, say that private repos will
  fail with "no access" and suggest `gh auth login`. Never ask the user to paste a token into the chat.
- **Servers** (config hosts or `scan --ssh`): only `ssh` on this machine and `git` (or `python3`) on the
  server; nothing is installed there.

## 1. Run git-drift with evidence

Use `git-drift` if it's on PATH, otherwise `npx -y git-drift@latest` (written as `git-drift` below).

Pick the scope:
- If the user has a config (a `git-drift.config.json` in the current folder, `$GIT_DRIFT_CONFIG`, or
  `~/.config/git-drift/config.json`), or names one: `git-drift -e -f json -q`
  (add `-c <file>` if they named one; `--only <name>` to narrow to a repo, server or check).
- Otherwise scan their code folder (ask which if it isn't obvious, `~/code` is a common default):
  `git-drift scan <dir> -e -f json -q` (or `--ssh <host> <dirs>` for a server).

The JSON has `summary` and `results[]`. Each result has `name`, `host`, `status` (ok | drift | error) and
`findings[]`. Each finding has `severity` (drift | info), `code`, `message`, `items`, `fix` (steps; lines that
start with `$ ` are commands), with `-e`, `evidence` (diffs, commit logs, dates; secrets redacted), and
`firstSeen` (when git-drift first reported it; `summary.new` counts results new in this run). Lead with new
problems; one that has sat for days is either forgotten or deliberate in-flight work, so ask before acting on it.
Exit code 0 = clean, 1 = drift, 2 = a check couldn't run.

If everything is clean, say so in one line and stop.

## 2. Explain and recommend

For each drift finding, most urgent first:
- **What it is**, in plain words: whose work, where, how old. Use the evidence (dates, authors, commit
  messages, the diff).
- **Which side should win** and why. This is the real decision:
  - Uncommitted or unpushed work on a laptop is usually wanted: push it.
  - A hand edit on a server that looks deliberate (a dated comment, a sensible config change): copy it into git.
  - An accidental or stale server change, or a server that's behind: redeploy the version from GitHub.
  - A repo with no remote: back it up as a private GitHub repo, unless it's an untouched starter.
  If the evidence doesn't settle it, run read-only commands to find out (`git log`, `git show`,
  `git diff`, the `diff <(gh api …) <(ssh … cat …)` from the fix steps), or ask the user.
- **The exact commands** to do it, filled in from the finding's `fix` steps.

Errors (`status: error`) mean that machine couldn't be checked: report them separately, don't guess.

## 3. Fix, with approval

- Get the user's OK before ANY change: push, commit, delete, or anything over SSH that writes.
  Batch the safe, additive ones (push an unpushed branch, back up a repo, commit a server edit into git) into
  one confirmation; ask separately for anything that discards work (restore, stash drop, delete,
  overwrite a server file, redeploy over a hand edit).
- Never force-push, `git reset --hard`, `rm -rf`, or edit a server's running config without explicit
  approval for that specific action. Prefer preserving work over discarding it.
- Servers may be production. When unsure, preserve the server's version in git first; that loses nothing.
- If another tool or session may own a change (an agent worktree, a branch being worked on right now),
  say so and ask before touching it.

## 4. Verify

Re-run git-drift for what you fixed (`--only <name>`) and report the result in a line or two:
what's fixed, what's left, and anything the user still needs to decide.

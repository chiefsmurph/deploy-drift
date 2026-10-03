// Read-only probe scripts run on a host via `sh -s`. Each prints simple tab/space-separated lines
// that the parsers below turn into data. They write nothing except a mktemp dir they remove.
import { q, qpath } from "./exec.js";

// git refuses to read repos owned by another user ("dubious ownership"); a read-only probe can safely trust them.
const GIT_FN = `G() { git -c safe.directory='*' "$@"; }`;

export function gitStateScript(path: string): string {
  return `${GIT_FN}
cd ${qpath(path)} 2>/dev/null || { echo "ERR missing"; exit 0; }
G rev-parse --git-dir >/dev/null 2>&1 || { echo "ERR notgit"; exit 0; }
echo "HEAD $(G rev-parse HEAD 2>/dev/null)"
echo "BRANCH $(G symbolic-ref -q --short HEAD 2>/dev/null)"
echo "STASH $(G stash list 2>/dev/null | wc -l | tr -d ' ')"
echo "WORKTREES $(G worktree list 2>/dev/null | wc -l | tr -d ' ')"
echo "DIRTYCOUNT $(G status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
G status --porcelain 2>/dev/null | head -100 | sed 's/^/DIRTY /'
G for-each-ref --format='LB %(objectname) %(refname:short)' refs/heads 2>/dev/null
`;
}

export interface GitState {
  error?: "missing" | "notgit";
  head: string;
  branch: string;
  stashes: number;
  worktrees: number;
  dirtyCount: number;
  dirty: string[];
  branches: { name: string; sha: string }[];
}

export function parseGitState(out: string): GitState {
  const s: GitState = { head: "", branch: "", stashes: 0, worktrees: 0, dirtyCount: 0, dirty: [], branches: [] };
  for (const line of out.split("\n")) {
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? "" : line.slice(sp + 1);
    if (key === "ERR") s.error = val.trim() as GitState["error"];
    else if (key === "HEAD") s.head = val.trim();
    else if (key === "BRANCH") s.branch = val.trim();
    else if (key === "STASH") s.stashes = Number(val) || 0;
    else if (key === "WORKTREES") s.worktrees = Math.max(0, (Number(val) || 1) - 1);
    else if (key === "DIRTYCOUNT") s.dirtyCount = Number(val) || 0;
    else if (key === "DIRTY") s.dirty.push(val);
    else if (key === "LB") {
      const [sha, ...name] = val.split(" ");
      s.branches.push({ sha, name: name.join(" ") });
    }
  }
  return s;
}

/** find(1) prune clause: plain names match at any depth, anything with a slash is a path from the root. */
function pruneClause(exclude: string[]): string {
  if (!exclude.length) return "";
  const parts = exclude.map((e) => (e.includes("/") ? `-path ${q("./" + e.replace(/^\.?\/+|\/+$/g, ""))}` : `-name ${q(e)}`));
  return `\\( ${parts.join(" -o ")} \\) -prune -o`;
}

/**
 * Hash every file under `path` the way git does. Prefers `git hash-object`, falls back to python3.
 * Output: "F\t<sha>\t<path>", "L\t<link target>\t<path>", "U\t<path>" (unreadable), or "ERR ...".
 */
export function hashScript(path: string, exclude: string[]): string {
  const prune = pruneClause(exclude);
  return `cd ${qpath(path)} 2>/dev/null || { echo "ERR missing"; exit 0; }
t=$(mktemp -d 2>/dev/null || mktemp -d -t dd) || { echo "ERR mktemp"; exit 0; }
trap 'rm -rf "$t"' EXIT
find . ${prune} -type f -print 2>/dev/null | sed 's|^\\./||' > "$t/all"
find . ${prune} -type l -print 2>/dev/null | sed 's|^\\./||' > "$t/links"
: > "$t/files"
while IFS= read -r p; do
  if [ -r "$p" ]; then printf '%s\\n' "$p" >> "$t/files"; else printf 'U\\t%s\\n' "$p"; fi
done < "$t/all"
if command -v git >/dev/null 2>&1; then
  git hash-object --no-filters --stdin-paths < "$t/files" > "$t/shas" 2>/dev/null || { echo "ERR hash"; exit 0; }
elif command -v python3 >/dev/null 2>&1; then
  python3 -c '
import sys, hashlib
for p in sys.stdin.read().splitlines():
    d = open(p, "rb").read()
    print(hashlib.sha1(b"blob %d\\0" % len(d) + d).hexdigest())
' < "$t/files" > "$t/shas" || { echo "ERR hash"; exit 0; }
else
  echo "ERR nohash"; exit 0
fi
paste "$t/shas" "$t/files" | awk '{ print "F\\t" $0 }'
while IFS= read -r p; do printf 'L\\t%s\\t%s\\n' "$(readlink "$p")" "$p"; done < "$t/links"
`;
}

export interface HashedDir {
  error?: string;
  files: Map<string, string>; // path -> blob sha
  links: Map<string, string>; // path -> link target
  unreadable: string[];
}

export function parseHashed(out: string): HashedDir {
  const d: HashedDir = { files: new Map(), links: new Map(), unreadable: [] };
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("ERR ")) { d.error = line.slice(4).trim(); continue; }
    const [kind, a, ...rest] = line.split("\t");
    if (kind === "F" && rest.length) d.files.set(rest.join("\t"), a);
    else if (kind === "L" && rest.length) d.links.set(rest.join("\t"), a);
    else if (kind === "U") d.unreadable.push(a);
  }
  return d;
}

export function catScript(path: string): string {
  return `[ -r ${qpath(path)} ] || { echo "ERR missing"; exit 0; }
echo "OK"
cat ${qpath(path)}
`;
}

export function discoverScript(roots: string[], maxDepth: number): string {
  return roots
    .map((r) => `find ${qpath(r)} -maxdepth ${maxDepth} \\( -name node_modules -o -name .cache -o -name .nvm \\) -prune -o -name .git -print -prune 2>/dev/null`)
    .join("\n") + "\n";
}

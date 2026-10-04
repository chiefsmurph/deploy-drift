// Read-only probe scripts run on a host via `sh -s`. Each prints simple tab/space-separated lines
// that the parsers below turn into data, and finishes with an "END" line so a cut-off run (timeout,
// dropped connection) is never mistaken for a complete, clean one. They write nothing except a
// mktemp dir they remove.
import { q, qpath } from "./exec.js";
import type { ExecResult } from "./exec.js";

// Read-only git: GIT_OPTIONAL_LOCKS=0 stops `git status` refreshing (rewriting) the index, and
// core.fsmonitor=false stops it running a repo-configured monitor command. No safe.directory override:
// git's "dubious ownership" refusal protects a privileged user from another user's repo config.
const GIT_FN = `G() { GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false "$@"; }`;

export class ProbeError extends Error {}

/** Lines of a finished probe; throws when the run was cut off or failed outright. */
export function probeLines(r: ExecResult, what: string): string[] {
  if (r.timedOut) throw new ProbeError(`${what}: timed out`);
  const lines = r.stdout.split("\n");
  if (lines.some((l) => l.startsWith("ERR "))) return lines; // the probe explained itself
  if (r.code !== 0 || !lines.includes("END")) {
    const why = (r.stderr.trim().split("\n").pop() ?? "").slice(0, 300);
    throw new ProbeError(`${what}: incomplete output (exit ${r.code}${why ? `: ${why}` : ""})`);
  }
  return lines;
}

export function gitStateScript(path: string): string {
  return `${GIT_FN}
cd ${qpath(path)} 2>/dev/null || { echo "ERR missing"; exit 0; }
command -v git >/dev/null 2>&1 || { echo "ERR nogit"; exit 0; }
out=$(G rev-parse --git-dir 2>&1) || {
  case "$out" in *"dubious ownership"*) echo "ERR ownership";; *) echo "ERR notgit";; esac
  exit 0
}
echo "HEAD $(G rev-parse --verify -q HEAD 2>/dev/null)"
echo "BRANCH $(G symbolic-ref -q HEAD 2>/dev/null)"
echo "STASH $(G stash list 2>/dev/null | wc -l | tr -d ' ')"
top=$(G rev-parse --show-toplevel 2>/dev/null)
G worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | while IFS= read -r w; do
  [ "$w" = "$top" ] && continue
  case "$w" in */.git/*) continue ;; esac   # a submodule lists its gitdir (.git/modules/x) as a worktree
  if [ -d "$w" ]; then
    printf 'WT %s\t%s\n' "$(GIT_OPTIONAL_LOCKS=0 git -c core.fsmonitor=false -C "$w" status --porcelain 2>/dev/null | wc -l | tr -d ' ')" "$w"
  else
    printf 'WT missing\t%s\n' "$w"
  fi
done
st=$(G status --porcelain 2>/dev/null) || { echo "ERR status"; exit 0; }
if [ -n "$st" ]; then
  echo "DIRTYCOUNT $(printf '%s\\n' "$st" | wc -l | tr -d ' ')"
  printf '%s\\n' "$st" | head -100 | sed 's/^/DIRTY /'
else
  echo "DIRTYCOUNT 0"
fi
G for-each-ref --format='LB %(objectname) %(refname:short)' refs/heads 2>/dev/null
echo END
`;
}

export interface GitState {
  error?: "missing" | "notgit" | "nogit" | "ownership" | "status";
  head: string;
  branch: string;
  stashes: number;
  /** linked worktrees (not the main checkout): uncommitted-change count, or "missing" */
  worktrees: { path: string; dirty: number | "missing" }[];
  dirtyCount: number;
  dirty: string[];
  branches: { name: string; sha: string }[];
}

export function parseGitState(lines: string[]): GitState {
  const s: GitState = { head: "", branch: "", stashes: 0, worktrees: [], dirtyCount: 0, dirty: [], branches: [] };
  for (const line of lines) {
    const sp = line.indexOf(" ");
    const key = sp < 0 ? line : line.slice(0, sp);
    const val = sp < 0 ? "" : line.slice(sp + 1);
    if (key === "ERR") s.error = val.trim() as GitState["error"];
    else if (key === "HEAD") s.head = /^[0-9a-f]{40,64}$/.test(val.trim()) ? val.trim() : "";
    else if (key === "BRANCH") s.branch = val.trim().replace(/^refs\/heads\//, "");
    else if (key === "STASH") s.stashes = Number(val) || 0;
    else if (key === "WT") {
      const [n, ...p] = val.split("\t");
      s.worktrees.push({ path: p.join("\t"), dirty: n === "missing" ? "missing" : Number(n) || 0 });
    }
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
 * Hash every file under `path` the way git does (`git hash-object`, else python3).
 * Output: "F\t<sha>\t<path>", "L\t<link target>\t<path>", "U\t<path>" (unreadable), "ERR ...", then "END".
 * Paths go to git as ABSOLUTE paths: given relative ones inside a work tree, git resolves them from the
 * repo's top level, not the current directory. Names git would mangle on --stdin-paths (a leading
 * double quote is C-unquoted, a trailing CR stripped) are hashed one at a time.
 */
export function hashScript(path: string, exclude: string[]): string {
  const prune = pruneClause(exclude);
  return `cd ${qpath(path)} 2>/dev/null || { echo "ERR missing"; exit 0; }
t=$(mktemp -d 2>/dev/null || mktemp -d -t dd) || { echo "ERR mktemp"; exit 0; }
trap 'rm -rf "$t"' EXIT
CR=$(printf '\\r')
if command -v git >/dev/null 2>&1; then H=git; elif command -v python3 >/dev/null 2>&1; then H=py; else echo "ERR nohash"; exit 0; fi
find . ${prune} -type f -print 2>/dev/null | sed 's|^\\./||' > "$t/all" || { echo "ERR find"; exit 0; }
find . ${prune} -type l -print 2>/dev/null | sed 's|^\\./||' > "$t/links"
: > "$t/files"
while IFS= read -r p; do
  if [ ! -r "$p" ]; then printf 'U\\t%s\\n' "$p"; continue; fi
  case "$H:$p" in
    git:\\"*|git:*"$CR") printf 'F\\t%s\\t%s\\n' "$(git hash-object --no-filters -- "$PWD/$p")" "$p" ;;
    *) printf '%s\\n' "$p" >> "$t/files" ;;
  esac
done < "$t/all"
if [ "$H" = git ]; then
  awk '{ print ENVIRON["PWD"] "/" $0 }' "$t/files" | git hash-object --no-filters --stdin-paths > "$t/shas" 2>/dev/null || { echo "ERR hash"; exit 0; }
else
  python3 -c '
import sys, hashlib
for p in sys.stdin.buffer.read().split(b"\\n")[:-1]:
    d = open(p, "rb").read()
    sys.stdout.write(hashlib.sha1(b"blob %d\\0" % len(d) + d).hexdigest() + "\\n")
' < "$t/files" > "$t/shas" || { echo "ERR hash"; exit 0; }
fi
[ "$(wc -l < "$t/shas")" -eq "$(wc -l < "$t/files")" ] || { echo "ERR hashcount"; exit 0; }
paste "$t/shas" "$t/files" | awk '{ print "F\\t" $0 }'
while IFS= read -r p; do printf 'L\\t%s\\t%s\\n' "$(readlink -- "$p")" "$p"; done < "$t/links"
echo END
`;
}

export interface HashedDir {
  error?: string;
  files: Map<string, string>; // path -> blob sha
  links: Map<string, string>; // path -> link target
  unreadable: string[];
}

export function parseHashed(lines: string[]): HashedDir {
  const d: HashedDir = { files: new Map(), links: new Map(), unreadable: [] };
  for (const line of lines) {
    if (!line || line === "END") continue;
    if (line.startsWith("ERR ")) { d.error = line.slice(4).trim(); continue; }
    const [kind, a, ...rest] = line.split("\t");
    if (kind === "F" && rest.length) d.files.set(rest.join("\t"), a);
    else if (kind === "L" && rest.length) d.links.set(rest.join("\t"), a);
    else if (kind === "U") d.unreadable.push([a, ...rest].join("\t"));
  }
  return d;
}

export function catScript(path: string): string {
  return `[ -r ${qpath(path)} ] || { echo "ERR missing"; exit 0; }
echo "DD-STAMP-BEGIN"
cat ${qpath(path)}
printf '\\nDD-STAMP-END\\nEND\\n'
`;
}

/** Content between the stamp markers (tolerates banner text before it). */
export function parseCat(lines: string[]): { missing: boolean; content: string } {
  if (lines.some((l) => l === "ERR missing")) return { missing: true, content: "" };
  const start = lines.indexOf("DD-STAMP-BEGIN");
  const end = lines.lastIndexOf("DD-STAMP-END");
  return { missing: false, content: start >= 0 && end > start ? lines.slice(start + 1, end).join("\n") : "" };
}

/**
 * Prints the host's $HOME (so "~/x" config paths can be matched), then one line per checkout found:
 * "REPO\t<dir>\t<status>\t<remote url>" where status is "ok", "none" (no remote at all) or "err".
 */
export function discoverScript(roots: string[], maxDepth: number): string {
  const finds = roots.map(
    (r) => `if [ -d ${qpath(r)} ]; then find ${qpath(r)} -maxdepth ${Math.floor(maxDepth)} \\( -name node_modules -o -name .cache -o -name .nvm \\) -prune -o -name .git -print -prune 2>/dev/null; else echo "NOROOT ${r.replace(/\n/g, " ")}" >&3; fi`,
  );
  return `echo "HOME $HOME"
{ ${finds.join("\n")}
} 3>&1 | while IFS= read -r g; do
  case "$g" in "NOROOT "*) echo "$g"; continue ;; esac
  d=\${g%/.git}
  # A linked worktree's .git is a file pointing into the main repo's worktrees/ dir; the main repo's
  # check already reports its uncommitted changes, so don't check it twice.
  if [ -f "$g" ]; then case "$(sed -n 1p "$g" 2>/dev/null)" in *"/worktrees/"*) printf 'LINKED\t%s\n' "$d"; continue ;; esac; fi
  u=$(git -C "$d" config --get remote.origin.url 2>/dev/null); rc=$?
  if [ $rc -ne 0 ]; then
    r=$(git -C "$d" remote 2>/dev/null | head -1)
    if [ -n "$r" ]; then u=$(git -C "$d" config --get "remote.$r.url" 2>/dev/null); rc=$?;
    elif git -C "$d" rev-parse --git-dir >/dev/null 2>&1; then rc=none;
    else rc=err; fi
  fi
  case "$rc" in 0) st=ok ;; none) st=none ;; *) st=err ;; esac
  printf 'REPO\t%s\t%s\t%s\n' "$d" "$st" "$u"
done
echo END
`;
}

export interface FoundRepo {
  dir: string;
  remote: "ok" | "none" | "err";
  url: string;
}

export function parseDiscover(lines: string[]): { home: string; repos: FoundRepo[]; noRoot: string[]; linked: string[] } {
  const out = { home: "", repos: [] as FoundRepo[], noRoot: [] as string[], linked: [] as string[] };
  for (const l of lines) {
    if (l.startsWith("HOME ")) out.home = l.slice(5);
    else if (l.startsWith("NOROOT ")) out.noRoot.push(l.slice(7));
    else if (l.startsWith("LINKED\t")) out.linked.push(l.slice(7));
    else if (l.startsWith("REPO\t")) {
      const [, dir, remote, ...url] = l.split("\t");
      out.repos.push({ dir: dir.replace(/\/+$/, ""), remote: remote as FoundRepo["remote"], url: url.join("\t") });
    }
  }
  return out;
}

/** owner/name from a GitHub remote URL (https, ssh, or an ~/.ssh/config alias whose name contains "github"). */
export function githubSlug(url: string): string | null {
  const m = url.trim().match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](?:\d+\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m || !/github/i.test(m[1])) return null;
  return `${m[2]}/${m[3]}`;
}

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

export interface HostConfig {
  /** SSH destination: an alias from ~/.ssh/config or user@host. */
  ssh?: string;
  /** Extra arguments passed to ssh before the destination (e.g. ["-p", "2222"]). */
  sshArgs?: string[];
  /** Run on this machine instead of over SSH. */
  local?: boolean;
}

interface TargetBase {
  name: string;
  /** Key into `hosts`. Defaults to "local". */
  host?: string;
}

/** A git checkout on a host: must be on `ref`, at the same commit as GitHub, with nothing uncommitted. */
export interface GitTarget extends TargetBase {
  type: "git";
  path: string;
  repo: string;
  /** Branch, tag or commit SHA. Defaults to the repo's default branch. */
  ref?: string;
  /** Flag local branches whose tip commit is not on GitHub. Default true. */
  checkBranches?: boolean;
  /** Accept a detached HEAD at the expected commit (submodules, tag pins). Default false. */
  allowDetached?: boolean;
  /**
   * Only flag work that is NOT on GitHub (uncommitted changes, stashes, unpushed commits/branches). Being
   * behind, ahead/unmerged, or on another branch becomes a note. Right for laptops; default false (deployments).
   */
  onlyUnpushed?: boolean;
}

/** A plain directory deployed by copy/rsync: every file must match the repo at `ref`, byte for byte. */
export interface FilesTarget extends TargetBase {
  type: "files";
  path: string;
  repo: string;
  ref?: string;
  /** Compare the directory against this subdirectory of the repo. */
  subdir?: string;
  /** Names (any depth) or relative paths that are never walked or compared, e.g. "node_modules", "data". */
  exclude?: string[];
  /** gitignore-style patterns (relative to `path`) to leave out of the comparison, e.g. "package-lock.json". */
  ignore?: string[];
}

/** A file on the host that records the deployed commit (e.g. build/version.json written by CI). */
export interface StampTarget extends TargetBase {
  type: "stamp";
  path: string;
  repo: string;
  ref?: string;
  /** Dot path into a JSON stamp, e.g. "sha" or "build.commit". */
  field?: string;
  /** Regex whose first capture group is the SHA (for non-JSON stamps). */
  pattern?: string;
}

/** Any shell command; passes when it exits 0 and its output matches `expect` (and not `fail`). */
export interface CommandTarget extends TargetBase {
  type: "command";
  run: string;
  expect?: string;
  fail?: string;
  timeoutSec?: number;
}

export type Target = GitTarget | FilesTarget | StampTarget | CommandTarget;

/** Look for git checkouts on a host that no `git` target covers. */
export interface DiscoverConfig {
  host: string;
  roots: string[];
  maxDepth?: number;
  /** Paths to accept without a target (exact path or prefix). */
  ignore?: string[];
  /**
   * Check every checkout found (that no target covers) as a `git` target, using its GitHub remote.
   * Repos with no remote are reported as existing only on that machine. Default false: just list them.
   */
  check?: boolean;
  /** With `check`: apply `onlyUnpushed` to every repo found (what `git-drift scan` does). */
  onlyUnpushed?: boolean;
}

/** Repo-level hygiene on GitHub: open PRs and branches not merged into the default branch (reported as info). */
export interface GithubReposConfig {
  repos: string[];
  /** Glob-ish branch names to skip, e.g. "archive/*", "dependabot/*". */
  ignoreBranches?: string[];
}

export interface Config {
  github?: { owner?: string; apiUrl?: string };
  hosts: Record<string, HostConfig>;
  defaults?: { exclude?: string[]; ignore?: string[] };
  targets: Target[];
  discover?: DiscoverConfig[];
  githubRepos?: GithubReposConfig;
}

export class ConfigError extends Error {}

const TYPES = new Set(["git", "files", "stamp", "command"]);

/** Expand a leading ~ for paths used on THIS machine. */
export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

/** owner/name, filling in the default owner for a bare name. */
export function repoSlug(config: Config, repo: string): string {
  if (repo.includes("/")) return repo;
  const owner = config.github?.owner;
  if (!owner) throw new ConfigError(`repo "${repo}" has no owner and github.owner is not set`);
  return `${owner}/${repo}`;
}

export function validate(raw: unknown): Config {
  const errors: string[] = [];
  const c = raw as Config;
  if (!c || typeof c !== "object") throw new ConfigError("config must be a JSON object");
  c.hosts = { local: { local: true }, ...(c.hosts ?? {}) };
  if (!Array.isArray(c.targets)) errors.push("`targets` must be an array");

  for (const [name, h] of Object.entries(c.hosts)) {
    if (!h.local && !h.ssh) errors.push(`host "${name}": needs "ssh" or "local": true`);
  }

  const names = new Set<string>();
  for (const [i, t] of (c.targets ?? []).entries()) {
    const where = `targets[${i}]${t?.name ? ` (${t.name})` : ""}`;
    if (!t?.name) errors.push(`${where}: missing "name"`);
    else if (names.has(t.name)) errors.push(`${where}: duplicate name`);
    else names.add(t.name);
    if (!TYPES.has(t?.type)) {
      errors.push(`${where}: "type" must be one of ${[...TYPES].join(", ")}`);
      continue;
    }
    const host = t.host ?? "local";
    if (!c.hosts[host]) errors.push(`${where}: unknown host "${host}"`);
    if (t.type === "command") {
      if (!t.run) errors.push(`${where}: missing "run"`);
      for (const k of ["expect", "fail"] as const) {
        if (t[k]) try { new RegExp(t[k]!); } catch { errors.push(`${where}: "${k}" is not a valid regex`); }
      }
    } else {
      if (!t.path) errors.push(`${where}: missing "path"`);
      if (!t.repo) errors.push(`${where}: missing "repo"`);
      else if (!t.repo.includes("/") && !c.github?.owner) errors.push(`${where}: repo "${t.repo}" needs github.owner`);
    }
    if (t.type === "stamp" && t.pattern) {
      try { new RegExp(t.pattern); } catch { errors.push(`${where}: "pattern" is not a valid regex`); }
    }
  }

  for (const [i, d] of (c.discover ?? []).entries()) {
    if (!c.hosts[d.host]) errors.push(`discover[${i}]: unknown host "${d.host}"`);
    if (!Array.isArray(d.roots) || d.roots.length === 0) errors.push(`discover[${i}]: "roots" must be a non-empty array`);
    if (d.maxDepth !== undefined && !(Number.isInteger(d.maxDepth) && d.maxDepth >= 1 && d.maxDepth <= 20)) errors.push(`discover[${i}]: "maxDepth" must be an integer 1-20`);
  }
  if (c.githubRepos && !Array.isArray(c.githubRepos.repos)) errors.push("githubRepos.repos must be an array");

  if (errors.length) throw new ConfigError("invalid config:\n  - " + errors.join("\n  - "));
  return c;
}

export async function loadConfig(path: string): Promise<Config> {
  let text: string;
  try {
    text = await readFile(expandHome(path), "utf8");
  } catch {
    throw new ConfigError(`cannot read config file ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${path} is not valid JSON: ${(e as Error).message}`);
  }
  return validate(raw);
}

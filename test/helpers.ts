import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitBlobSha } from "../src/blob.js";
import type { Context } from "../src/checks/context.js";
import { validate, type Target } from "../src/config.js";
import type { Comparison, Github, Resolved, TreeEntry } from "../src/github.js";

export interface FakeRepo {
  sha: string;
  ref?: string;
  kind?: Resolved["kind"];
  files?: Record<string, string>;
  links?: Record<string, string>;
  /** paths that are git submodules (tree entries of type "commit") */
  submodules?: string[];
  /** head sha -> comparison against `sha`; missing = not on GitHub */
  compare?: Record<string, Comparison>;
  /** extra commit SHAs that exist on GitHub */
  known?: string[];
  pulls?: { number: number; title: string; head: string }[];
  branches?: { name: string; sha: string }[];
}

export class FakeGithub implements Github {
  constructor(private repos: Record<string, FakeRepo>) {}
  private r(repo: string): FakeRepo {
    const r = this.repos[repo];
    if (!r) throw new Error(`fake: unknown repo ${repo}`);
    return r;
  }
  async resolve(repo: string, ref?: string): Promise<Resolved> {
    const r = this.r(repo);
    return { sha: r.sha, treeSha: "tree-" + r.sha, ref: ref ?? r.ref ?? "main", kind: r.kind ?? "branch" };
  }
  async tree(repo: string) {
    const r = this.r(repo);
    const entries: TreeEntry[] = [
      ...Object.entries(r.files ?? {}).map(([path, c]) => ({ path, mode: "100644", type: "blob" as const, sha: gitBlobSha(c) })),
      ...Object.entries(r.links ?? {}).map(([path, t]) => ({ path, mode: "120000", type: "blob" as const, sha: gitBlobSha(t) })),
      ...(r.submodules ?? []).map((path) => ({ path, mode: "160000", type: "commit" as const, sha: "c".repeat(40) })),
    ];
    return { entries, truncated: false };
  }
  async blob(repo: string, sha: string) {
    const c = Object.values(this.r(repo).files ?? {}).find((v) => gitBlobSha(v) === sha);
    if (c === undefined) throw new Error("fake: no blob " + sha);
    return Buffer.from(c);
  }
  async compare(repo: string, _base: string, head: string) {
    return this.r(repo).compare?.[head] ?? null;
  }
  async commitExists(repo: string, sha: string) {
    const r = this.r(repo);
    return sha === r.sha || (r.known ?? []).includes(sha);
  }
  async openPulls(repo: string) {
    return this.r(repo).pulls ?? [];
  }
  async branches(repo: string) {
    return this.r(repo).branches ?? [];
  }
}

export function ctxWith(gh: Github, targets: Target[] = [], extra: Record<string, unknown> = {}): Context {
  return { gh, config: validate({ github: { owner: "o" }, hosts: {}, targets, ...extra }) };
}

export function tempDir(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "dd-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
}

export function link(dir: string, path: string, target: string) {
  symlinkSync(target, join(dir, path));
}

export function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
}

/** A real repo with one commit on `main`; returns its dir and HEAD sha. */
export function tempRepo(files: Record<string, string> = { "a.txt": "a\n" }): { dir: string; head: string } {
  const dir = tempDir(files);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return { dir, head: git(dir, "rev-parse", "HEAD") };
}

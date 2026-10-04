// The laptop side: repos with work that never reached GitHub.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkGit } from "../src/checks/git.js";
import type { GitTarget } from "../src/config.js";
import { githubSlug } from "../src/remote.js";
import { buildTasks, runAll } from "../src/run.js";
import { scanConfig } from "../src/scan.js";
import { ctxWith, FakeGithub, git, tempDir, tempRepo } from "./helpers.js";

test("uncommitted work in another worktree is drift; a clean worktree is just a note", async () => {
  const { dir, head } = tempRepo();
  const wt = join(tempDir(), "wt");
  git(dir, "worktree", "add", "-q", "-b", "wt", wt);
  const t: GitTarget = { name: "g", type: "git", path: dir, repo: "api" };
  const ctx = ctxWith(new FakeGithub({ "o/api": { sha: head } }), [t]);
  const clean = await checkGit(ctx, t);
  assert.deepEqual(clean.findings.map((f) => f.severity), ["info"]);
  writeFileSync(join(wt, "new.txt"), "unsaved\n");
  const dirty = await checkGit(ctx, t);
  const f = dirty.findings.find((x) => x.severity === "drift");
  assert.match(f!.message, /uncommitted changes in 1 other worktree/);
  assert.match(f!.items![0], /wt \(1\)$/);
});

test("onlyUnpushed: stale or other-branch is a note, unpushed work is drift", async () => {
  const { dir, head } = tempRepo();
  const newer = "9".repeat(40);
  const t: GitTarget = { name: "g", type: "git", path: dir, repo: "api", onlyUnpushed: true };
  const gh = new FakeGithub({ "o/api": { sha: newer, known: [head], compare: { [head]: { status: "behind", aheadBy: 0, behindBy: 5 } } } });
  git(dir, "checkout", "-qb", "feature");
  const r = await checkGit(ctxWith(gh, [t]), t);
  assert.ok(r.findings.length >= 2 && r.findings.every((f) => f.severity === "info"), JSON.stringify(r.findings));
  writeFileSync(join(dir, "a.txt"), "changed\n");
  git(dir, "commit", "-qam", "not pushed");
  const r2 = await checkGit(ctxWith(gh, [t]), t);
  assert.ok(r2.findings.some((f) => f.severity === "drift" && /is not on GitHub/.test(f.message)));
});

test("discover with check: every repo found gets checked, by its own remote", async () => {
  const root = tempDir();
  const mk = (name: string) => {
    const r = tempRepo();
    git(root, "clone", "-q", r.dir, name);
    return git(join(root, name), "rev-parse", "HEAD");
  };
  mk("local-only");
  git(join(root, "local-only"), "remote", "remove", "origin");
  const headB = mk("on-github");
  git(join(root, "on-github"), "remote", "set-url", "origin", "git@github-work:acme/web.git");
  mk("on-gitlab");
  git(join(root, "on-gitlab"), "remote", "set-url", "origin", "https://ci:secret@gitlab.com/acme/x.git");

  git(join(root, "on-github"), "worktree", "add", "-q", "-b", "side", join(root, "on-github-wt"));
  const gh = new FakeGithub({ "acme/web": { sha: headB } });
  const ctx = ctxWith(gh, [], { discover: [{ host: "local", roots: [root], maxDepth: 2, check: true }] });
  const results = await runAll(buildTasks(ctx));
  const by = Object.fromEntries(results.map((r) => [r.name.split("/").pop(), r]));
  assert.equal(by["on-github-wt"], undefined, "a linked worktree was checked as its own repo");
  assert.match(results[0].summary, /\+1 linked worktree/);
  assert.match(by["local-only"].summary, /no git remote/);
  assert.equal(by["local-only"].status, "drift");
  assert.equal(by["on-github"].status, "ok", by["on-github"].summary); // a clean extra worktree is just a note
  assert.equal(by["on-gitlab"].status, "ok");
  assert.match(by["on-gitlab"].findings[0].message, /not on GitHub/);
  assert.ok(!by["on-gitlab"].findings[0].message.includes("secret"), "credentials leaked into the report");
});

test("githubSlug reads https, ssh, scp-style and ~/.ssh/config aliases", () => {
  const cases: [string, string | null][] = [
    ["https://github.com/acme/web.git", "acme/web"],
    ["https://github.com/acme/web", "acme/web"],
    ["git@github.com:acme/web.git", "acme/web"],
    ["ssh://git@github.com/acme/web.git", "acme/web"],
    ["git@github-work:acme/web.git", "acme/web"],
    ["https://user:token@github.com/acme/web.git", "acme/web"],
    ["git@gitlab.com:acme/web.git", null],
    ["/srv/git/web.git", null],
  ];
  for (const [url, want] of cases) assert.equal(githubSlug(url), want, url);
});

test("scanConfig: local roots become absolute; ssh roots are left to the server", () => {
  const local = scanConfig(["~/code", "."]);
  const d = local.discover![0];
  assert.equal(d.host, "local");
  assert.ok(d.roots.every((r) => r.startsWith("/")), d.roots.join(","));
  assert.equal(d.check && d.onlyUnpushed, true);
  const remote = scanConfig(["/srv"], { ssh: "web-1", depth: 2 });
  assert.deepEqual(remote.hosts["web-1"], { ssh: "web-1" });
  assert.deepEqual(remote.discover![0], { host: "web-1", roots: ["/srv"], maxDepth: 2, check: true, onlyUnpushed: true });
});

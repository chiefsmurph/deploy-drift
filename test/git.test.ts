import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkGit } from "../src/checks/git.js";
import type { GitTarget } from "../src/config.js";
import { ctxWith, FakeGithub, git, tempRepo, type FakeRepo } from "./helpers.js";

function setup(repo: (head: string) => Partial<FakeRepo> = () => ({}), target: Partial<GitTarget> = {}) {
  const { dir, head } = tempRepo();
  const t: GitTarget = { name: "api", type: "git", path: dir, repo: "api", ...target };
  const gh = new FakeGithub({ "o/api": { sha: head, ref: "main", ...repo(head) } });
  return { dir, head, t, ctx: ctxWith(gh, [t]) };
}

test("clean checkout on the expected commit", async () => {
  const { ctx, t } = setup();
  const r = await checkGit(ctx, t);
  assert.deepEqual(r.findings, []);
  assert.match(r.summary, /main @ \w{7} matches main on GitHub, clean/);
});

test("uncommitted changes and stashes are drift", async () => {
  const { ctx, t, dir } = setup();
  writeFileSync(join(dir, "a.txt"), "changed\n");
  git(dir, "stash");
  writeFileSync(join(dir, "a.txt"), "changed again\n");
  writeFileSync(join(dir, "new.txt"), "n\n");
  const r = await checkGit(ctx, t);
  const msgs = r.findings.map((f) => f.message);
  assert.ok(msgs.includes("2 uncommitted changes"), msgs.join("|"));
  assert.ok(msgs.some((m) => m.startsWith("1 stash")));
});

test("a HEAD commit GitHub has never seen is flagged", async () => {
  const { ctx, t, dir } = setup((head) => ({ sha: head }));
  writeFileSync(join(dir, "a.txt"), "local\n");
  git(dir, "commit", "-qam", "box-only fix");
  const r = await checkGit(ctx, t);
  assert.match(r.findings[0].message, /commit \w{7} is not on GitHub — it exists only here/);
});

test("behind the branch on GitHub", async () => {
  const fakeNew = "f".repeat(40);
  const { ctx, t, head } = setup((head) => ({ sha: fakeNew, compare: { [head]: { status: "behind", aheadBy: 0, behindBy: 3 } } }));
  void head;
  const r = await checkGit(ctx, t);
  assert.match(r.findings[0].message, /^behind main by 3 commits/);
});

test("wrong branch at the right commit", async () => {
  const { ctx, t, dir } = setup();
  git(dir, "checkout", "-qb", "feature");
  const r = await checkGit(ctx, t);
  assert.ok(r.findings.some((f) => f.message === "checked out on branch feature, expected main"));
});

test("local branches with commits not on GitHub", async () => {
  const { ctx, t, dir } = setup();
  git(dir, "checkout", "-qb", "wip");
  writeFileSync(join(dir, "w.txt"), "w\n");
  git(dir, "add", "w.txt");
  git(dir, "commit", "-qm", "wip");
  git(dir, "checkout", "-q", "main");
  const r = await checkGit(ctx, t);
  const f = r.findings.find((x) => x.message.includes("local branch"));
  assert.ok(f && f.items?.[0].startsWith("wip ("), JSON.stringify(r.findings));
  const quiet = await checkGit(ctx, { ...t, checkBranches: false });
  assert.deepEqual(quiet.findings, []);
});

test("a pinned tag expects that commit, not the branch tip", async () => {
  const { ctx, t } = setup(() => ({ kind: "tag" }), { ref: "v1.0" });
  const r = await checkGit(ctx, t);
  assert.deepEqual(r.findings, []);
});

test("allowDetached accepts a detached HEAD at the right commit (submodules)", async () => {
  const { ctx, t, dir, head } = setup();
  git(dir, "checkout", "-q", "--detach", head);
  assert.match((await checkGit(ctx, t)).findings[0].message, /detached HEAD, expected branch main/);
  assert.deepEqual((await checkGit(ctx, { ...t, allowDetached: true })).findings, []);
});

test("missing path and non-git dir", async () => {
  const { ctx, t } = setup();
  assert.match((await checkGit(ctx, { ...t, path: "/nonexistent/dd" })).summary, /does not exist/);
  assert.match((await checkGit(ctx, { ...t, path: "/" })).summary, /not a git checkout/);
});

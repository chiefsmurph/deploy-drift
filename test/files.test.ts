import assert from "node:assert/strict";
import { chmodSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkFiles, isExcluded } from "../src/checks/files.js";
import type { FilesTarget } from "../src/config.js";
import { ctxWith, FakeGithub, link, tempDir } from "./helpers.js";

const repoFiles = { "index.js": "console.log(1)\n", "lib/util.js": "module.exports = 1\n", ".gitignore": ".env\nlogs/\n" };

function setup(boxFiles: Record<string, string> = repoFiles, repo: Record<string, string> = repoFiles, extra: Partial<FilesTarget> = {}) {
  const dir = tempDir(boxFiles);
  const t: FilesTarget = { name: "site", type: "files", path: dir, repo: "site", ...extra };
  const gh = new FakeGithub({ "o/site": { sha: "a".repeat(40), files: repo } });
  return { dir, t, ctx: ctxWith(gh, [t]) };
}

test("identical directory is clean", async () => {
  const { ctx, t } = setup();
  const r = await checkFiles(ctx, t);
  assert.deepEqual(r.findings, []);
  assert.match(r.summary, /3 files match o\/site @ main aaaaaaa/);
});

test("modified, missing and extra files are drift", async () => {
  const { ctx, t, dir } = setup();
  writeFileSync(join(dir, "index.js"), "console.log(2)\n");
  unlinkSync(join(dir, "lib/util.js"));
  writeFileSync(join(dir, "hotfix.js"), "x\n");
  const r = await checkFiles(ctx, t);
  const msgs = r.findings.map((f) => f.message);
  assert.ok(msgs.some((m) => m.startsWith("1 file differs")), msgs.join("|"));
  assert.ok(msgs.some((m) => m.startsWith("1 file is in the repo but missing")));
  assert.ok(msgs.some((m) => m.startsWith("1 file exists only here")));
  assert.deepEqual(r.findings.find((f) => f.message.includes("only here"))?.items, ["hotfix.js"]);
});

test("files the repo's .gitignore ignores are expected on the box", async () => {
  const { ctx, t, dir } = setup({ ...repoFiles, ".env": "SECRET=1\n", "logs/a.log": "x\n" });
  void dir;
  const r = await checkFiles(ctx, t);
  assert.deepEqual(r.findings, []);
});

test("user ignore patterns and excluded dirs are left out", async () => {
  const { ctx, t } = setup(
    { ...repoFiles, "package-lock.json": "{}\n", "data/cache.json": "{}\n" },
    { ...repoFiles, "package-lock.json": "{\"v\":1}\n", "data/.gitkeep": "" },
    { ignore: ["package-lock.json"], exclude: ["data"] },
  );
  const r = await checkFiles(ctx, t);
  assert.deepEqual(r.findings, []);
});

test("subdir compares against part of the repo", async () => {
  const { ctx, t } = setup({ "run.sh": "echo hi\n" }, { "job/run.sh": "echo hi\n", "other/x": "y\n" }, { subdir: "job" });
  const r = await checkFiles(ctx, t);
  assert.deepEqual(r.findings, []);
  assert.match(r.summary, /1 files match o\/site\/job/);
});

test("symlinks compare by target", async () => {
  const { ctx, t, dir } = setup({ "a.txt": "a\n" }, { "a.txt": "a\n" });
  link(dir, "current", "a.txt");
  const gh = new FakeGithub({ "o/site": { sha: "b".repeat(40), files: { "a.txt": "a\n" }, links: { current: "a.txt" } } });
  assert.deepEqual((await checkFiles({ ...ctx, gh }, t)).findings, []);
  const gh2 = new FakeGithub({ "o/site": { sha: "b".repeat(40), files: { "a.txt": "a\n" }, links: { current: "b.txt" } } });
  assert.match((await checkFiles({ ...ctx, gh: gh2 }, t)).findings[0].message, /1 file differs/);
});

test("unreadable files are reported as info, not drift", { skip: process.getuid?.() === 0 }, async () => {
  const { ctx, t, dir } = setup({ ...repoFiles, "secret.key": "k\n" }, { ...repoFiles, "secret.key": "k\n" });
  chmodSync(join(dir, "secret.key"), 0o000);
  try {
    const r = await checkFiles(ctx, t);
    const info = r.findings.find((f) => f.severity === "info");
    assert.ok(info && info.message.includes("unreadable"));
    assert.ok(!r.findings.some((f) => f.severity === "drift"), JSON.stringify(r.findings));
  } finally {
    chmodSync(join(dir, "secret.key"), 0o600);
  }
});

test("a missing directory is drift", async () => {
  const { ctx, t, dir } = setup();
  rmSync(dir, { recursive: true });
  const r = await checkFiles(ctx, t);
  assert.match(r.findings[0].message, /does not exist/);
});

test("isExcluded matches names at any depth and paths from the root", () => {
  assert.ok(isExcluded("a/node_modules/x.js", ["node_modules"]));
  assert.ok(isExcluded("src/data/x", ["src/data"]));
  assert.ok(!isExcluded("data/x", ["src/data"]));
  assert.ok(!isExcluded("metadata.json", ["data"]));
});

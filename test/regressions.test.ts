// One test per bug found in the pre-publish review, so none of them can come back silently.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkFiles } from "../src/checks/files.js";
import { checkGit } from "../src/checks/git.js";
import type { FilesTarget, GitTarget } from "../src/config.js";
import { parseCat, probeLines, ProbeError } from "../src/remote.js";
import { ctxWith, FakeGithub, git, tempDir, tempRepo } from "./helpers.js";

const filesTarget = (dir: string, extra: Partial<FilesTarget> = {}): FilesTarget => ({ name: "f", type: "files", path: dir, repo: "site", ...extra });
const fake = (files: Record<string, string>, extra = {}) => new FakeGithub({ "o/site": { sha: "a".repeat(40), files, ...extra } });

test("a files target inside a git work tree hashes its own files, not the repo root's", async () => {
  const { dir } = tempRepo({ "a.txt": "ROOT\n", "public/a.txt": "public\n" });
  const t = filesTarget(join(dir, "public"));
  const r = await checkFiles(ctxWith(fake({ "a.txt": "public\n" }), [t]), t);
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings));
});

test("the git probe never runs a repo's fsmonitor hook or rewrites its index", async () => {
  const { dir, head } = tempRepo();
  const marker = join(dir, "..", `fsmonitor-ran-${Date.now()}`);
  git(dir, "config", "core.fsmonitor", `touch ${marker}; true`);
  writeFileSync(join(dir, "a.txt"), "a\n"); // same content, new mtime: a normal status would refresh the index
  const before = statSync(join(dir, ".git/index")).mtimeMs;
  const t: GitTarget = { name: "g", type: "git", path: dir, repo: "api" };
  await checkGit(ctxWith(new FakeGithub({ "o/api": { sha: head } }), [t]), t);
  assert.equal(existsSync(marker), false, "fsmonitor command ran");
  assert.equal(statSync(join(dir, ".git/index")).mtimeMs, before, "index was rewritten");
});

test("cut-off probe output is an error, never a clean result", () => {
  const ok = { code: 0, stdout: "HEAD x\nEND\n", stderr: "", timedOut: false };
  assert.deepEqual(probeLines(ok, "t").slice(0, 2), ["HEAD x", "END"]);
  assert.throws(() => probeLines({ ...ok, stdout: "HEAD x\n" }, "t"), ProbeError);
  assert.throws(() => probeLines({ ...ok, timedOut: true }, "t"), /timed out/);
  assert.throws(() => probeLines({ ...ok, code: 255 }, "t"), /incomplete output/);
  assert.equal(probeLines({ ...ok, stdout: "ERR missing\n" }, "t")[0], "ERR missing");
});

test("non-ASCII file names compare correctly", async () => {
  const files = { "café/naïve.txt": "ünïcödé\n", "日本.md": "x\n" };
  const t = filesTarget(tempDir(files));
  assert.deepEqual((await checkFiles(ctxWith(fake(files), [t]), t)).findings, []);
});

test("files inside git submodules are not reported as extra", async () => {
  const dir = tempDir({ "index.js": "1\n", "vendor/lib/x.js": "2\n" });
  const t = filesTarget(dir);
  const r = await checkFiles(ctxWith(fake({ "index.js": "1\n" }, { submodules: ["vendor/lib"] }), [t]), t);
  assert.deepEqual(r.findings, []);
});

test("names git would mangle (leading quote, trailing CR) hash correctly", async () => {
  const files = { '"quoted.txt': "q\n", "Icon\r": "", "plain.txt": "p\n" };
  const t = filesTarget(tempDir(files));
  assert.deepEqual((await checkFiles(ctxWith(fake(files), [t]), t)).findings, []);
});

test("a custom defaults.exclude still excludes .git and node_modules", async () => {
  const { dir } = tempRepo({ "a.txt": "a\n" });
  mkdirSync(join(dir, "node_modules/x"), { recursive: true });
  writeFileSync(join(dir, "node_modules/x/i.js"), "x\n");
  const t = filesTarget(dir);
  const ctx = ctxWith(fake({ "a.txt": "a\n" }), [t], { defaults: { exclude: ["uploads"] } });
  assert.deepEqual((await checkFiles(ctx, t)).findings, []);
});

test("a tag with the same name as the branch doesn't look like a wrong branch", async () => {
  const { dir, head } = tempRepo();
  git(dir, "tag", "main");
  const t: GitTarget = { name: "g", type: "git", path: dir, repo: "api" };
  const r = await checkGit(ctxWith(new FakeGithub({ "o/api": { sha: head } }), [t]), t);
  assert.deepEqual(r.findings, []);
});

test("a nested .gitignore can re-include (!) what a parent ignores", async () => {
  const repo = { ".gitignore": "*.log\n", "sub/.gitignore": "!keep.log\n", "sub/a.txt": "a\n" };
  const t = filesTarget(tempDir({ ...repo, "sub/keep.log": "k\n", "sub/drop.log": "d\n" }));
  const r = await checkFiles(ctxWith(fake(repo), [t]), t);
  assert.deepEqual(r.findings.find((f) => f.message.includes("only here"))?.items, ["sub/keep.log"]);
});

test("stamp parsing tolerates banner text before the content", () => {
  const lines = ["Welcome to Ubuntu", "DD-STAMP-BEGIN", '{"sha":"abc1234"}', "DD-STAMP-END", "END"];
  assert.equal(parseCat(lines).content, '{"sha":"abc1234"}');
  assert.equal(parseCat(["ERR missing"]).missing, true);
});

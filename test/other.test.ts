import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gitBlobSha } from "../src/blob.js";
import { checkCommand } from "../src/checks/command.js";
import { checkDiscover } from "../src/checks/discover.js";
import { checkGithubRepo, globMatch } from "../src/checks/github-repos.js";
import { checkStamp, readStamp } from "../src/checks/stamp.js";
import { ConfigError, validate } from "../src/config.js";
import { q } from "../src/exec.js";
import { parseGitState, parseHashed } from "../src/remote.js";
import { render } from "../src/report.js";
import { buildTasks, runAll } from "../src/run.js";
import { ctxWith, FakeGithub, tempDir } from "./helpers.js";

const SHA = "1234567890abcdef1234567890abcdef12345678";

test("gitBlobSha matches git hash-object", () => {
  assert.equal(gitBlobSha("hello\n"), "ce013625030ba8dba906f756967f9e9ca394464a");
  assert.equal(gitBlobSha(""), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
});

test("shell quoting survives single quotes", () => {
  assert.equal(q("it's"), `'it'\\''s'`);
});

test("readStamp: JSON field, regex, plain", () => {
  assert.equal(readStamp(`{"build":{"sha":"${SHA}"}}`, { field: "build.sha" }), SHA);
  assert.equal(readStamp(`deployed commit=${SHA}\n`, { pattern: "commit=([0-9a-f]+)" }), SHA);
  assert.equal(readStamp(`${SHA}\n`, {}), SHA);
  assert.equal(readStamp("not json", { field: "sha" }), null);
});

test("stamp check: match, behind, missing", async () => {
  const dir = tempDir({ "version.json": JSON.stringify({ sha: SHA }) });
  const t = { name: "s", type: "stamp" as const, path: join(dir, "version.json"), repo: "w", field: "sha" };
  const ok = await checkStamp(ctxWith(new FakeGithub({ "o/w": { sha: SHA } }), [t]), t);
  assert.deepEqual(ok.findings, []);
  const newer = "9".repeat(40);
  const gh = new FakeGithub({ "o/w": { sha: newer, compare: { [SHA]: { status: "behind", aheadBy: 0, behindBy: 1 } } } });
  assert.match((await checkStamp(ctxWith(gh, [t]), t)).findings[0].message, /behind main by 1 commit/);
  assert.match((await checkStamp(ctxWith(gh, [t]), { ...t, path: "/nope" })).summary, /does not exist/);
});

test("command check: exit code, expect, fail", async () => {
  const ctx = ctxWith(new FakeGithub({}));
  const base = { name: "c", type: "command" as const };
  assert.deepEqual((await checkCommand(ctx, { ...base, run: "echo active", expect: "^active$" })).findings, []);
  assert.match((await checkCommand(ctx, { ...base, run: "echo down", expect: "^active$" })).summary, /did not match/);
  assert.match((await checkCommand(ctx, { ...base, run: "echo ERROR x", fail: "ERROR" })).summary, /matched \/ERROR\//);
  assert.match((await checkCommand(ctx, { ...base, run: "exit 3" })).summary, /exited 3/);
  assert.match((await checkCommand(ctx, { ...base, run: "sleep 5", timeoutSec: 1 })).summary, /timed out/);
});

test("discover finds checkouts no target covers", async () => {
  const root = tempDir();
  for (const d of ["known", "stray", "ignored/x"]) mkdirSync(join(root, d, ".git"), { recursive: true });
  const t = { name: "k", type: "git" as const, path: join(root, "known"), repo: "k" };
  const ctx = ctxWith(new FakeGithub({}), [t]);
  const r = await checkDiscover(ctx, { host: "local", roots: [root], ignore: [join(root, "ignored")] });
  assert.deepEqual(r.findings[0].items, [join(root, "stray")]);
});

test("discover expands ~ with the host's own home", async () => {
  const home = tempDir();
  for (const d of ["code/known", "code/stray"]) mkdirSync(join(home, d, ".git"), { recursive: true });
  const saved = process.env.HOME;
  process.env.HOME = home; // the probe's sh inherits this, standing in for a remote user's home
  try {
    const t = { name: "k", type: "git" as const, path: "~/code/known", repo: "k" };
    const r = await checkDiscover(ctxWith(new FakeGithub({}), [t]), { host: "local", roots: ["~/code"], maxDepth: 2 });
    assert.deepEqual(r.findings[0].items, [join(home, "code/stray")]);
  } finally {
    process.env.HOME = saved;
  }
});

test("github repo hygiene is info, never drift", async () => {
  const gh = new FakeGithub({
    "o/api": {
      sha: SHA,
      pulls: [{ number: 7, title: "bump x", head: "dependabot/x" }],
      branches: [
        { name: "main", sha: SHA },
        { name: "feature", sha: "f".repeat(40) },
        { name: "archive/old", sha: "e".repeat(40) },
      ],
      compare: { ["f".repeat(40)]: { status: "ahead", aheadBy: 2, behindBy: 0 } },
    },
  });
  const r = await checkGithubRepo(ctxWith(gh), "api", ["archive/*"]);
  assert.ok(r.findings.every((f) => f.severity === "info"));
  assert.deepEqual(r.findings[1].items, ["feature (+2, fffffff)"]);
  assert.ok(globMatch("dependabot/*", "dependabot/npm/x"));
  assert.ok(!globMatch("archive/*", "main"));
});

test("config validation reports every problem", () => {
  assert.throws(
    () => validate({ hosts: { b: {} }, targets: [{ name: "x", type: "git", host: "nope" }, { name: "x", type: "bogus" }] }),
    (e: Error) => {
      assert.ok(e instanceof ConfigError);
      for (const s of ['host "b"', "unknown host", 'missing "path"', "duplicate name", '"type" must be']) assert.ok(e.message.includes(s), s);
      return true;
    },
  );
  const c = validate({ github: { owner: "o" }, targets: [] });
  assert.deepEqual(c.hosts.local, { local: true });
});

test("parsers", () => {
  const g = parseGitState(`HEAD ${SHA}\nBRANCH refs/heads/main\nSTASH 2\nWORKTREES 3\nDIRTYCOUNT 1\nDIRTY  M a.txt\nLB ${SHA} main\nLB ${SHA} feat/x y\nEND`.split("\n"));
  assert.equal(g.branch, "main");
  assert.equal(g.worktrees, 2);
  assert.deepEqual(g.dirty, [" M a.txt"]);
  assert.deepEqual(g.branches[1], { sha: SHA, name: "feat/x y" });
  const h = parseHashed(`F\t${SHA}\tdir/a b.txt\nL\ttarget\tcur\nU\tsecret\nEND`.split("\n"));
  assert.equal(h.files.get("dir/a b.txt"), SHA);
  assert.equal(h.links.get("cur"), "target");
  assert.deepEqual(h.unreadable, ["secret"]);
});

test("runner: a throwing check becomes an error result; reports render", async () => {
  const ctx = ctxWith(new FakeGithub({}), [
    { name: "ok", type: "command", run: "true" },
    { name: "bad", type: "git", path: "/tmp", repo: "missing-repo" },
  ]);
  const results = await runAll(buildTasks(ctx));
  assert.equal(results[0].status, "ok");
  assert.equal(results[1].status, "error");
  assert.match(results[1].summary, /unknown repo/);
  assert.match(render(results, "text"), /1 failed to run, 1 clean/);
  assert.match(render(results, "markdown"), /### Needs attention/);
  assert.match(render(results, "html"), /<table/);
  assert.equal(JSON.parse(render(results, "json")).summary.error, 1);
  assert.equal(buildTasks(ctx, ["bad"]).length, 1);
});

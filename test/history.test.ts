// 0.3.0: repos found on this machine get laptop rules by default, and reports say what is new.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ageLabel, applyHistory, defaultStatePath, loadHistory, saveHistory, type History } from "../src/history.js";
import { render } from "../src/report.js";
import { buildTasks, runAll } from "../src/run.js";
import type { CheckResult, Finding } from "../src/types.js";
import { ctxWith, FakeGithub, git, tempDir, tempRepo } from "./helpers.js";

/** A clone under a fresh root, checked out on a pushed feature branch (same commit as GitHub's main). */
function featureCheckout() {
  const root = tempDir();
  const origin = tempRepo();
  git(root, "clone", "-q", origin.dir, "web");
  const dir = join(root, "web");
  git(dir, "remote", "set-url", "origin", "git@github.com:acme/web.git");
  git(dir, "checkout", "-qb", "feature");
  return { root, dir, gh: new FakeGithub({ "acme/web": { sha: origin.head } }) };
}

const web = (results: CheckResult[]) => results.find((r) => r.name.endsWith("/web"))!;

test("discover on this machine defaults to laptop rules: a pushed feature branch is a note", async () => {
  const { root, gh } = featureCheckout();
  const ctx = ctxWith(gh, [], { discover: [{ host: "local", roots: [root], maxDepth: 2, check: true }] });
  const r = web(await runAll(buildTasks(ctx)));
  assert.equal(r.status, "ok", JSON.stringify(r.findings));
  assert.ok(r.findings.some((f) => f.code === "wrong-branch" && f.severity === "info"));
});

test("discover on this machine still fails on work that isn't on GitHub", async () => {
  const { root, dir, gh } = featureCheckout();
  writeFileSync(join(dir, "a.txt"), "changed\n");
  git(dir, "commit", "-qam", "not pushed");
  const ctx = ctxWith(gh, [], { discover: [{ host: "local", roots: [root], maxDepth: 2, check: true }] });
  const r = web(await runAll(buildTasks(ctx)));
  assert.equal(r.status, "drift");
  assert.ok(r.findings.some((f) => f.code === "not-on-github"));
});

test('"onlyUnpushed": false keeps discovered local repos strict', async () => {
  const { root, gh } = featureCheckout();
  const ctx = ctxWith(gh, [], { discover: [{ host: "local", roots: [root], maxDepth: 2, check: true, onlyUnpushed: false }] });
  const r = web(await runAll(buildTasks(ctx)));
  assert.equal(r.status, "drift");
  assert.ok(r.findings.some((f) => f.code === "wrong-branch" && f.severity === "drift"));
});

const result = (name: string, ...codes: string[]): CheckResult => ({
  name,
  type: "git",
  host: "local",
  status: codes.length ? "drift" : "ok",
  summary: codes.length ? codes.join(", ") : "clean",
  findings: codes.map((code): Finding => ({ severity: "drift", code, message: code })),
  ms: 1,
});

test("history: first run is new, later runs keep the first-seen date, a fixed problem is forgotten", () => {
  const mon = new Date(2026, 9, 5, 19, 0);
  const wed = new Date(2026, 9, 7, 19, 0);
  const thu = new Date(2026, 9, 8, 19, 0);
  let h: History = { version: 1, seen: {} };

  const r1 = [result("~/code/a", "uncommitted")];
  h = applyHistory(r1, h, mon);
  assert.equal(ageLabel(r1[0].findings[0], mon), "new");

  const r2 = [result("~/code/a", "uncommitted", "stash")];
  h = applyHistory(r2, h, wed);
  assert.equal(r2[0].findings[0].firstSeen, mon.toISOString());
  assert.equal(ageLabel(r2[0].findings[0], wed), "since Oct 5 · day 3");
  assert.equal(ageLabel(r2[0].findings[1], wed), "new");

  h = applyHistory([result("~/code/a")], h, thu); // fixed
  const r4 = [result("~/code/a", "uncommitted")];
  applyHistory(r4, h, thu);
  assert.equal(ageLabel(r4[0].findings[0], thu), "new", "a problem that went away and came back is new again");
});

test("history: a run that skipped a check (--only) keeps that check's dates", () => {
  const mon = new Date(2026, 9, 5, 19, 0);
  const tue = new Date(2026, 9, 6, 19, 0);
  let h = applyHistory([result("a", "uncommitted"), result("b", "stash")], { version: 1, seen: {} }, mon);
  h = applyHistory([result("a", "uncommitted")], h, tue);
  const later = [result("b", "stash")];
  applyHistory(later, h, tue);
  assert.equal(later[0].findings[0].firstSeen, mon.toISOString());
});

test("report: new problems first, labelled, and counted in the headline and json", () => {
  const mon = new Date(2026, 9, 5, 19, 0);
  const tue = new Date(2026, 9, 6, 19, 0);
  const h = applyHistory([result("old", "uncommitted")], { version: 1, seen: {} }, mon);
  const results = [result("old", "uncommitted"), result("fresh", "stash"), result("clean")];
  applyHistory(results, h, tue);

  const text = render(results, "text", false, tue);
  assert.match(text.split("\n")[0], /2 drifted, 1 clean \(1 new\)/);
  assert.ok(text.indexOf("✗ fresh") < text.indexOf("✗ old"), "the new problem should be listed first");
  assert.match(text, /• stash \(new\)/);
  assert.match(text, /• uncommitted \(since Oct 5 · day 2\)/);
  assert.match(render(results, "markdown", false, tue), /- uncommitted _\(since Oct 5 · day 2\)_/);
  assert.equal(JSON.parse(render(results, "json", false, tue)).summary.new, 1);
});

test("report: without a state file nothing changes", () => {
  const results = [result("a", "uncommitted")];
  const text = render(results, "text", false, new Date());
  assert.doesNotMatch(text, /new|since/);
  assert.equal(JSON.parse(render(results, "json")).summary.new, undefined);
});

test("state file: round-trips, and a missing or corrupt file is a fresh start", async () => {
  const dir = tempDir({ "bad.json": "{not json" });
  assert.deepEqual(await loadHistory(join(dir, "missing.json")), { version: 1, seen: {} });
  assert.deepEqual(await loadHistory(join(dir, "bad.json")), { version: 1, seen: {} });
  const h: History = { version: 1, seen: { "local\u0000a": { stash: "2026-10-05T02:00:00.000Z" } } };
  const path = join(dir, "nested", "seen.json");
  await saveHistory(path, h);
  assert.deepEqual(await loadHistory(path), h);
  assert.equal(defaultStatePath({ XDG_STATE_HOME: "/x" }, "/home/u"), "/x/git-drift/seen.json");
  assert.equal(defaultStatePath({}, "/home/u"), "/home/u/.local/state/git-drift/seen.json");
});

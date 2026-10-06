// Every drift finding must say how to resolve it, and every report format must show that.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkFiles } from "../src/checks/files.js";
import { checkGit } from "../src/checks/git.js";
import { checkFoundRepo } from "../src/checks/discover.js";
import type { FilesTarget, GitTarget } from "../src/config.js";
import { render } from "../src/report.js";
import type { CheckResult } from "../src/types.js";
import { ctxWith, FakeGithub, git, tempDir, tempRepo } from "./helpers.js";

const cmds = (fix?: string[]) => (fix ?? []).filter((l) => l.startsWith("$ ")).join("\n");

test("git findings carry runnable fixes", async () => {
  const { dir, head } = tempRepo();
  git(dir, "checkout", "-qb", "wip");
  writeFileSync(join(dir, "w.txt"), "w\n");
  git(dir, "add", "w.txt");
  git(dir, "commit", "-qm", "wip");
  git(dir, "checkout", "-q", "main");
  writeFileSync(join(dir, "a.txt"), "edited\n");
  const t: GitTarget = { name: "g", type: "git", path: dir, repo: "api" };
  const r = await checkGit(ctxWith(new FakeGithub({ "o/api": { sha: head } }), [t]), t);
  const dirty = r.findings.find((f) => f.message.includes("uncommitted"))!;
  assert.match(cmds(dirty.fix), /git status && git diff/);
  const branch = r.findings.find((f) => f.message.includes("local branch"))!;
  assert.match(cmds(branch.fix), /git push -u origin wip/);
  assert.ok(r.findings.filter((f) => f.severity === "drift").every((f) => f.fix?.length), "a drift finding has no fix");
});

test("fix commands for a server are wrapped in ssh; local ones aren't; unpushed local HEAD gets a rescue branch", async () => {
  const { onHost } = await import("../src/checks/context.js");
  const ctx = ctxWith(new FakeGithub({}), [], { hosts: { web: { ssh: "web-1", sshArgs: ["-p", "2222"] } } });
  assert.equal(onHost(ctx, "web", "cd /srv/api && git status"), "ssh -p 2222 web-1 'cd /srv/api && git status'");
  assert.equal(onHost(ctx, "local", "git status"), "git status");
  const { dir, head } = tempRepo();
  writeFileSync(join(dir, "a.txt"), "edit\n");
  git(dir, "commit", "-qam", "never pushed");
  const t: GitTarget = { name: "g", type: "git", path: dir, repo: "api" };
  const fix = (await checkGit(ctxWith(new FakeGithub({ "o/api": { sha: head } }), [t]), t)).findings[0].fix!;
  assert.match(cmds(fix), /git push -u origin HEAD:refs\/heads\/rescue\/local-\w{7}/);
});

test("files and no-remote findings carry fixes", async () => {
  const dir = tempDir({ "a.txt": "server edit\n", "extra.sh": "x\n" });
  const t: FilesTarget = { name: "f", type: "files", path: dir, repo: "site" };
  const r = await checkFiles(ctxWith(new FakeGithub({ "o/site": { sha: "a".repeat(40), files: { "a.txt": "repo\n" } } }), [t]), t);
  assert.match(cmds(r.findings[0].fix), /diff <\(gh api .*repos\/o\/site\/contents\/a\.txt/);
  assert.ok(r.findings.every((f) => f.severity !== "drift" || f.fix?.length));
  const none = await checkFoundRepo(ctxWith(new FakeGithub({})), "local", { dir: "/tmp/side-project", remote: "none", url: "" });
  assert.match(cmds(none.findings[0].fix), /gh repo create side-project --private --source \. --push/);
});

test("every report format shows the fix", () => {
  const results: CheckResult[] = [
    { name: "x", type: "git", host: "local", status: "drift", summary: "s", ms: 1, findings: [{ severity: "drift", message: "m", fix: ["Do this:", "$ git push"] }] },
  ];
  assert.match(render(results, "text"), /→ how to fix:\n\s+Do this:\n\s+\$ git push/);
  assert.match(render(results, "markdown"), /\*\*How to fix:\*\*[\s\S]*```sh\n\s+git push/);
  assert.match(render(results, "html"), /How to fix<\/div>.*<pre[^>]*>git push<\/pre>/s);
  assert.deepEqual(JSON.parse(render(results, "json")).results[0].findings[0].fix, ["Do this:", "$ git push"]);
});

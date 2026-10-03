import { checkCommand } from "./checks/command.js";
import type { Context } from "./checks/context.js";
import { checkDiscover } from "./checks/discover.js";
import { checkFiles } from "./checks/files.js";
import { checkGit, type Outcome } from "./checks/git.js";
import { checkGithubRepo } from "./checks/github-repos.js";
import { checkStamp } from "./checks/stamp.js";
import type { Target } from "./config.js";
import { statusOf, type CheckResult } from "./types.js";

interface Task {
  name: string;
  type: string;
  host: string;
  run: () => Promise<Outcome>;
}

function targetTask(ctx: Context, t: Target): Task {
  const run = () => {
    switch (t.type) {
      case "git": return checkGit(ctx, t);
      case "files": return checkFiles(ctx, t);
      case "stamp": return checkStamp(ctx, t);
      case "command": return checkCommand(ctx, t);
    }
  };
  return { name: t.name, type: t.type, host: t.host ?? "local", run };
}

export function buildTasks(ctx: Context, only: string[] = []): Task[] {
  const tasks: Task[] = ctx.config.targets.map((t) => targetTask(ctx, t));
  for (const d of ctx.config.discover ?? []) {
    tasks.push({ name: `discover ${d.host}`, type: "discover", host: d.host, run: () => checkDiscover(ctx, d) });
  }
  const gr = ctx.config.githubRepos;
  for (const repo of gr?.repos ?? []) {
    tasks.push({ name: `github ${repo}`, type: "github", host: "github", run: () => checkGithubRepo(ctx, repo, gr?.ignoreBranches ?? []) });
  }
  if (!only.length) return tasks;
  const want = only.map((o) => o.toLowerCase());
  return tasks.filter((t) => want.some((o) => t.name.toLowerCase().includes(o) || t.host.toLowerCase() === o));
}

async function runTask(task: Task): Promise<CheckResult> {
  const started = Date.now();
  const base = { name: task.name, type: task.type, host: task.host };
  try {
    const { summary, findings } = await task.run();
    return { ...base, status: statusOf(findings), summary, findings, ms: Date.now() - started };
  } catch (e) {
    const message = (e as Error).message || String(e);
    return { ...base, status: "error", summary: message, findings: [{ severity: "drift", message }], ms: Date.now() - started };
  }
}

/** Run every task with bounded parallelism; results keep config order. */
export async function runAll(tasks: Task[], concurrency = 6): Promise<CheckResult[]> {
  const results: CheckResult[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await runTask(tasks[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

import { checkCommand } from "./checks/command.js";
import type { Context } from "./checks/context.js";
import { checkDiscover, type DiscoverOutcome } from "./checks/discover.js";
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
  run: () => Promise<Outcome | DiscoverOutcome>;
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

async function runTask(task: Task, spawned: Task[]): Promise<CheckResult> {
  const started = Date.now();
  const base = { name: task.name, type: task.type, host: task.host };
  try {
    const outcome = await task.run();
    spawned.push(...((outcome as DiscoverOutcome).spawn ?? []));
    return { ...base, status: statusOf(outcome.findings), summary: outcome.summary, findings: outcome.findings, ms: Date.now() - started };
  } catch (e) {
    const message = (e as Error).message || String(e);
    const fix = ["The check couldn't run, so this machine is unverified (not necessarily broken). Usually SSH access, permissions, a GitHub token, or a renamed path. Retry just this check:", `$ git-drift --only ${JSON.stringify(task.name)}`];
    return { ...base, status: "error", summary: message, findings: [{ severity: "drift", message, fix }], ms: Date.now() - started };
  }
}

async function runBatch(tasks: Task[], concurrency: number, spawned: Task[]): Promise<CheckResult[]> {
  const results: CheckResult[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await runTask(tasks[i], spawned);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

/**
 * Run every task with bounded parallelism (results keep config order), then the per-repo checks that
 * `discover` with `check: true` handed back.
 */
export async function runAll(tasks: Task[], concurrency = 6): Promise<CheckResult[]> {
  const spawned: Task[] = [];
  const first = await runBatch(tasks, concurrency, spawned);
  if (!spawned.length) return first;
  spawned.sort((a, b) => a.name.localeCompare(b.name));
  return [...first, ...(await runBatch(spawned, concurrency, []))];
}

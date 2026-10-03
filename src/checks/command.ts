import type { CommandTarget } from "../config.js";
import { runScript } from "../exec.js";
import { capped, hostOf, type Context } from "./context.js";
import type { Outcome } from "./git.js";

export async function checkCommand(ctx: Context, t: CommandTarget): Promise<Outcome> {
  const r = await runScript(hostOf(ctx, t.host), t.run + "\n", (t.timeoutSec ?? 300) * 1000);
  const out = (r.stdout + (r.stderr ? "\n" + r.stderr : "")).trim();
  const tail = capped(out.split("\n").slice(-15), 15);
  const problems: string[] = [];
  if (r.timedOut) problems.push(`timed out after ${t.timeoutSec ?? 300}s`);
  else if (r.code !== 0) problems.push(`exited ${r.code}`);
  if (t.expect && !new RegExp(t.expect, "m").test(out)) problems.push(`output did not match /${t.expect}/`);
  if (t.fail && new RegExp(t.fail, "m").test(out)) problems.push(`output matched /${t.fail}/`);
  if (problems.length) return { summary: problems.join("; "), findings: [{ severity: "drift", message: problems.join("; "), items: tail }] };
  return { summary: out.split("\n").filter(Boolean).pop()?.slice(0, 160) || "passed", findings: [] };
}

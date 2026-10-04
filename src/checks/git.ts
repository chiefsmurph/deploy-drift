import { short } from "../blob.js";
import type { GitTarget } from "../config.js";
import { runScript } from "../exec.js";
import { gitStateScript, parseGitState, probeLines } from "../remote.js";
import type { Finding } from "../types.js";
import { capped, hostOf, slug, type Context } from "./context.js";
import { relationFinding } from "./relation.js";

export interface Outcome {
  summary: string;
  findings: Finding[];
}

export async function checkGit(ctx: Context, t: GitTarget): Promise<Outcome> {
  const repo = slug(ctx, t.repo);
  const [r, want] = await Promise.all([runScript(hostOf(ctx, t.host), gitStateScript(t.path)), ctx.gh.resolve(repo, t.ref)]);
  const s = parseGitState(probeLines(r, `inspecting ${t.path}`));
  if (s.error === "missing") return { summary: `${t.path} does not exist`, findings: [{ severity: "drift", message: `${t.path} does not exist` }] };
  if (s.error === "notgit") return { summary: `${t.path} is not a git checkout`, findings: [{ severity: "drift", message: `${t.path} is not a git checkout` }] };
  if (s.error === "nogit") throw new Error(`git is not installed on the host`);
  if (s.error === "ownership") throw new Error(`git refuses ${t.path} ("dubious ownership"): connect as the user that owns the checkout`);
  if (s.error) throw new Error(`git status failed in ${t.path}`);
  if (!s.head) return { summary: `no commit checked out in ${t.path}`, findings: [{ severity: "drift", message: `no commit checked out (empty repo or unborn branch)` }] };

  const findings: Finding[] = [];
  const rel = await relationFinding(ctx.gh, repo, want, s.head);
  if (rel) findings.push(rel);
  if (want.kind === "branch" && s.branch !== want.ref && !(t.allowDetached && !s.branch)) {
    findings.push({ severity: "drift", message: s.branch ? `checked out on branch ${s.branch}, expected ${want.ref}` : `detached HEAD, expected branch ${want.ref}` });
  }
  if (s.dirtyCount > 0) {
    findings.push({ severity: "drift", message: `${s.dirtyCount} uncommitted change${s.dirtyCount === 1 ? "" : "s"}`, items: capped(s.dirty) });
  }
  if (s.stashes > 0) findings.push({ severity: "drift", message: `${s.stashes} stash${s.stashes === 1 ? "" : "es"} (hidden uncommitted work)` });
  if (s.worktrees > 0) findings.push({ severity: "info", message: `${s.worktrees} extra worktree${s.worktrees === 1 ? "" : "s"}` });

  if (t.checkBranches !== false) {
    const others = s.branches.filter((b) => b.name !== s.branch && b.sha !== want.sha);
    const missing: string[] = [];
    await Promise.all(
      others.map(async (b) => {
        if (!(await ctx.gh.commitExists(repo, b.sha))) missing.push(`${b.name} (${short(b.sha)})`);
      }),
    );
    if (missing.length) {
      findings.push({ severity: "drift", message: `${missing.length} local branch${missing.length === 1 ? " has" : "es have"} commits not on GitHub`, items: capped(missing.sort()) });
    }
  }

  const where = `${s.branch || "detached"} @ ${short(s.head)}`;
  const drift = findings.filter((f) => f.severity === "drift");
  return {
    summary: drift.length
      ? `${where} — ${drift[0].message}${drift.length > 1 ? ` (+${drift.length - 1} more)` : ""}`
      : `${where} matches ${want.ref} on GitHub, clean`,
    findings,
  };
}

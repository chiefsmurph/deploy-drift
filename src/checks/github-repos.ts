import { short } from "../blob.js";
import type { Finding } from "../types.js";
import { capped, slug, type Context } from "./context.js";
import type { Outcome } from "./git.js";

/** "archive/*" style globs; only * is special. */
export function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(name);
}

/** Repo hygiene on GitHub itself. Reported as info: open PRs and unmerged branches are often intentional. */
export async function checkGithubRepo(ctx: Context, repoName: string, ignoreBranches: string[]): Promise<Outcome> {
  const repo = slug(ctx, repoName);
  const [want, pulls, branches] = await Promise.all([ctx.gh.resolve(repo), ctx.gh.openPulls(repo), ctx.gh.branches(repo)]);
  const findings: Finding[] = [];
  if (pulls.length) {
    findings.push({ severity: "info", message: `${pulls.length} open pull request${pulls.length === 1 ? "" : "s"}`, items: capped(pulls.map((p) => `#${p.number} ${p.title}`)) });
  }
  const candidates = branches.filter((b) => b.name !== want.ref && b.sha !== want.sha && !ignoreBranches.some((g) => globMatch(g, b.name)));
  const unmerged: string[] = [];
  await Promise.all(
    candidates.map(async (b) => {
      const cmp = await ctx.gh.compare(repo, want.sha, b.sha);
      if (cmp && cmp.aheadBy > 0) unmerged.push(`${b.name} (+${cmp.aheadBy}, ${short(b.sha)})`);
    }),
  );
  if (unmerged.length) {
    findings.push({ severity: "info", message: `${unmerged.length} branch${unmerged.length === 1 ? "" : "es"} not merged into ${want.ref}`, items: capped(unmerged.sort()) });
  }
  return {
    summary: findings.length ? findings.map((f) => f.message).join(", ") : `no open PRs, every branch merged into ${want.ref}`,
    findings,
  };
}

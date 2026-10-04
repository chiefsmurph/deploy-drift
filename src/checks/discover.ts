import type { DiscoverConfig } from "../config.js";
import { runScript } from "../exec.js";
import { discoverScript, githubSlug, parseDiscover, probeLines, type FoundRepo } from "../remote.js";
import type { Finding } from "../types.js";
import { capped, hostOf, type Context } from "./context.js";
import { checkGit, type Outcome } from "./git.js";

const norm = (p: string) => p.replace(/\/+$/, "");

export interface SpawnedCheck {
  name: string;
  type: string;
  host: string;
  run: () => Promise<Outcome>;
}

/** With `check`, discover hands back one git check per repo it found; the runner runs them next. */
export interface DiscoverOutcome extends Outcome {
  spawn?: SpawnedCheck[];
}

/** A repo found by discover: no remote = exists only here; a GitHub remote = full git check. */
export async function checkFoundRepo(ctx: Context, host: string, repo: FoundRepo, onlyUnpushed = false): Promise<Outcome> {
  if (repo.remote === "none") {
    return { summary: "no git remote: nothing in this repo is on GitHub", findings: [{ severity: "drift", message: "no git remote: this repo exists only here" }] };
  }
  if (repo.remote === "err") throw new Error(`could not read ${repo.dir} (permissions or "dubious ownership")`);
  const slug = githubSlug(repo.url);
  if (!slug) {
    const safe = repo.url.replace(/\/\/[^@/]+@/, "//"); // never echo credentials embedded in a URL
    return { summary: "remote is not on GitHub: not checked", findings: [{ severity: "info", message: `remote ${safe} is not on GitHub, so it was not checked` }] };
  }
  return checkGit(ctx, { name: repo.dir, type: "git", host, path: repo.dir, repo: slug, onlyUnpushed });
}

/** Git checkouts under `roots` that no target covers: new, forgotten or never-pushed repos. */
export async function checkDiscover(ctx: Context, d: DiscoverConfig): Promise<DiscoverOutcome> {
  const r = await runScript(hostOf(ctx, d.host), discoverScript(d.roots, d.maxDepth ?? 3));
  const { home, repos, noRoot, linked } = parseDiscover(probeLines(r, "discover"));
  // "~/x" in the config means the HOST's home, which may differ from this machine's.
  const fix = (p: string) => norm(p === "~" ? home : p.startsWith("~/") ? home + p.slice(1) : p);
  const pretty = (p: string) => (home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);
  const known = ctx.config.targets
    .filter((t) => (t.type === "git" || t.type === "files") && (t.host ?? "local") === d.host)
    .map((t) => fix((t as { path: string }).path));
  const ignored = (d.ignore ?? []).map(fix);
  // A .git nested inside a covered checkout (submodule, vendored repo) belongs to that target.
  const covered = (p: string) => known.some((k) => p === k || p.startsWith(k + "/")) || ignored.some((i) => p === i || p.startsWith(i + "/"));
  const unknown = repos.filter((x) => !covered(x.dir)).sort((a, b) => a.dir.localeCompare(b.dir));

  const findings: Finding[] = [];
  if (noRoot.length) findings.push({ severity: "info", message: `root${noRoot.length === 1 ? "" : "s"} not found: ${noRoot.join(", ")}` });

  if (d.check) {
    return {
      summary: `${repos.length} checkout${repos.length === 1 ? "" : "s"} found; ${unknown.length} checked individually${linked.length ? ` (+${linked.length} linked worktree${linked.length === 1 ? "" : "s"}, covered by their repo)` : ""}`,
      findings,
      spawn: unknown.map((x) => ({ name: pretty(x.dir), type: "git", host: d.host, run: () => checkFoundRepo(ctx, d.host, x, d.onlyUnpushed) })),
    };
  }
  if (unknown.length) {
    findings.unshift({ severity: "drift", message: `${unknown.length} git checkout${unknown.length === 1 ? " is" : "s are"} not covered by any target`, items: capped(unknown.map((x) => pretty(x.dir)), 30) });
  }
  return {
    summary: unknown.length ? `${unknown.length} git checkout${unknown.length === 1 ? "" : "s"} not in the config` : `${repos.length} checkouts found, all covered`,
    findings,
  };
}

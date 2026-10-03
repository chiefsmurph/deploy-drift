import ignore from "ignore";
import { gitBlobSha, short } from "../blob.js";
import type { FilesTarget } from "../config.js";
import { execError, runScript } from "../exec.js";
import type { Github, TreeEntry } from "../github.js";
import { hashScript, parseHashed } from "../remote.js";
import type { Finding } from "../types.js";
import { capped, hostOf, slug, type Context } from "./context.js";
import type { Outcome } from "./git.js";

export const DEFAULT_EXCLUDE = [".git", "node_modules"];
const MAX_GITIGNORES = 50;

export function isExcluded(rel: string, exclude: string[]): boolean {
  const segments = rel.split("/");
  return exclude.some((e) => {
    const clean = e.replace(/^\.?\/+|\/+$/g, "");
    return clean.includes("/") ? rel === clean || rel.startsWith(clean + "/") : segments.includes(clean);
  });
}

/**
 * True when the repo's own .gitignore files ignore `rel` (relative to the compared subdir):
 * such files are expected on a server (.env, data/, logs) and are not drift.
 */
async function repoIgnoreMatcher(gh: Github, repo: string, entries: TreeEntry[], prefix: string): Promise<(rel: string) => boolean> {
  const relevant = entries
    .filter((e) => e.type === "blob" && (e.path === ".gitignore" || e.path.endsWith("/.gitignore")))
    .map((e) => ({ dir: e.path.slice(0, -".gitignore".length), sha: e.sha }))
    .filter(({ dir }) => prefix.startsWith(dir) || dir.startsWith(prefix))
    .slice(0, MAX_GITIGNORES);
  const matchers = await Promise.all(
    relevant.map(async ({ dir, sha }) => ({ dir, ig: ignore().add((await gh.blob(repo, sha)).toString("utf8")) })),
  );
  return (rel) => {
    const full = prefix + rel;
    return matchers.some(({ dir, ig }) => {
      if (!full.startsWith(dir)) return false;
      const sub = full.slice(dir.length);
      return sub !== "" && ig.ignores(sub);
    });
  };
}

export async function checkFiles(ctx: Context, t: FilesTarget): Promise<Outcome> {
  const repo = slug(ctx, t.repo);
  const exclude = [...new Set([...(ctx.config.defaults?.exclude ?? DEFAULT_EXCLUDE), ...(t.exclude ?? [])])];
  const userIgnore = ignore().add([...(ctx.config.defaults?.ignore ?? []), ...(t.ignore ?? [])]);
  const want = await ctx.gh.resolve(repo, t.ref);
  const [{ entries, truncated }, r] = await Promise.all([
    ctx.gh.tree(repo, want.treeSha),
    runScript(hostOf(ctx, t.host), hashScript(t.path, exclude), 600_000),
  ]);
  if (r.code !== 0 && !r.stdout) throw new Error(`could not read ${t.path}: ${execError(r)}`);
  const box = parseHashed(r.stdout);
  if (box.error === "missing") return { summary: `${t.path} does not exist`, findings: [{ severity: "drift", message: `${t.path} does not exist` }] };
  if (box.error === "nohash") throw new Error(`host has neither git nor python3 to hash files`);
  if (box.error) throw new Error(`hashing files failed on the host (${box.error})`);

  const prefix = t.subdir ? t.subdir.replace(/^\/+|\/+$/g, "") + "/" : "";
  const expected = new Map<string, TreeEntry>();
  for (const e of entries) {
    if (e.type !== "blob" || !e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    if (!isExcluded(rel, exclude)) expected.set(rel, e);
  }
  const repoIgnored = await repoIgnoreMatcher(ctx.gh, repo, entries, prefix);

  const differ: string[] = [];
  const missing: string[] = [];
  let same = 0;
  const unreadable = new Set(box.unreadable);
  for (const [rel, e] of expected) {
    if (userIgnore.ignores(rel) || unreadable.has(rel)) continue;
    if (e.mode === "120000") {
      const target = box.links.get(rel);
      if (target === undefined) (box.files.has(rel) ? differ : missing).push(rel);
      else if (gitBlobSha(target) !== e.sha) differ.push(rel);
      else same++;
      continue;
    }
    const sha = box.files.get(rel);
    if (sha === undefined) (box.links.has(rel) ? differ : missing).push(rel);
    else if (sha !== e.sha) differ.push(rel);
    else same++;
  }
  const extra = [...box.files.keys(), ...box.links.keys()]
    .filter((rel) => !expected.has(rel) && !userIgnore.ignores(rel) && !repoIgnored(rel))
    .sort();

  const findings: Finding[] = [];
  const label = `${want.ref} ${short(want.sha)}`;
  if (differ.length) findings.push({ severity: "drift", message: `${differ.length} file${differ.length === 1 ? " differs" : "s differ"} from ${label}`, items: capped(differ.sort()) });
  if (missing.length) findings.push({ severity: "drift", message: `${missing.length} file${missing.length === 1 ? " is" : "s are"} in the repo but missing here`, items: capped(missing.sort()) });
  if (extra.length) findings.push({ severity: "drift", message: `${extra.length} file${extra.length === 1 ? " exists" : "s exist"} only here (not in the repo, not gitignored)`, items: capped(extra) });
  if (box.unreadable.length) findings.push({ severity: "info", message: `${box.unreadable.length} unreadable file(s) skipped`, items: capped(box.unreadable.sort()) });
  if (truncated) findings.push({ severity: "info", message: "GitHub truncated the file list (very large repo); the comparison may be incomplete" });

  const parts = [differ.length && `${differ.length} differ`, missing.length && `${missing.length} missing`, extra.length && `${extra.length} only here`].filter(Boolean);
  return {
    summary: parts.length ? `${parts.join(", ")} vs ${repo}${prefix ? "/" + prefix.slice(0, -1) : ""} @ ${label}` : `${same} files match ${repo}${prefix ? "/" + prefix.slice(0, -1) : ""} @ ${label}`,
    findings,
  };
}

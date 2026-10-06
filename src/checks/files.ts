import ignore from "ignore";
import { gitBlobSha, short } from "../blob.js";
import type { FilesTarget } from "../config.js";
import { runScript } from "../exec.js";
import type { Github, TreeEntry } from "../github.js";
import { capLines, unifiedDiff } from "../evidence.js";
import { catManyScript, hashScript, lsScript, parseCatMany, parseHashed, probeLines } from "../remote.js";
import type { Finding } from "../types.js";
import { capped, hostOf, isLocal, onHost, slug, type Context } from "./context.js";
import { shownPath, type Outcome } from "./git.js";

/** Always excluded, on top of anything configured. */
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
 * True when the repo's own .gitignore files ignore `rel` (relative to the compared subdir): such files are
 * expected on a server (.env, data/, logs) and are not drift. As in git, the deepest .gitignore that has an
 * opinion (ignore or `!` re-include) wins.
 */
async function repoIgnoreMatcher(gh: Github, repo: string, entries: TreeEntry[], prefix: string) {
  const all = entries
    .filter((e) => e.type === "blob" && (e.path === ".gitignore" || e.path.endsWith("/.gitignore")))
    .map((e) => ({ dir: e.path.slice(0, -".gitignore".length), sha: e.sha }))
    .filter(({ dir }) => prefix.startsWith(dir) || dir.startsWith(prefix))
    .sort((a, b) => b.dir.length - a.dir.length);
  const used = all.slice(0, MAX_GITIGNORES);
  const matchers = await Promise.all(
    used.map(async ({ dir, sha }) => ({ dir, ig: ignore().add((await gh.blob(repo, sha)).toString("utf8")) })),
  );
  const ignored = (rel: string) => {
    const full = prefix + rel;
    for (const { dir, ig } of matchers) {
      if (!full.startsWith(dir)) continue;
      const verdict = ig.test(full.slice(dir.length));
      if (verdict.ignored) return true;
      if (verdict.unignored) return false;
    }
    return false;
  };
  return { ignored, skipped: all.length - used.length };
}

export async function checkFiles(ctx: Context, t: FilesTarget): Promise<Outcome> {
  const repo = slug(ctx, t.repo);
  const exclude = [...new Set([...DEFAULT_EXCLUDE, ...(ctx.config.defaults?.exclude ?? []), ...(t.exclude ?? [])])];
  const userIgnore = ignore().add([...(ctx.config.defaults?.ignore ?? []), ...(t.ignore ?? [])]);
  const want = await ctx.gh.resolve(repo, t.ref);
  const [{ entries, truncated }, r] = await Promise.all([
    ctx.gh.tree(repo, want.treeSha),
    runScript(hostOf(ctx, t.host), hashScript(t.path, exclude), 600_000),
  ]);
  const box = parseHashed(probeLines(r, `hashing ${t.path}`));
  if (box.error === "missing") return { summary: `${t.path} does not exist`, findings: [{ severity: "drift", code: "missing-path", message: `${t.path} does not exist` }] };
  if (box.error === "nohash") throw new Error(`host has neither git nor python3 to hash files`);
  if (box.error) throw new Error(`hashing files failed on the host (${box.error})`);

  const prefix = t.subdir ? t.subdir.replace(/^\/+|\/+$/g, "") + "/" : "";
  const expected = new Map<string, TreeEntry>();
  const submodules: string[] = [];
  for (const e of entries) {
    if (!e.path.startsWith(prefix)) continue;
    const rel = e.path.slice(prefix.length);
    if (e.type === "commit") submodules.push(rel);
    else if (e.type === "blob" && !isExcluded(rel, exclude)) expected.set(rel, e);
  }
  const inSubmodule = (rel: string) => submodules.some((s) => rel === s || rel.startsWith(s + "/"));
  const repoIgnore = await repoIgnoreMatcher(ctx.gh, repo, entries, prefix);

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
    .filter((rel) => !expected.has(rel) && !inSubmodule(rel) && !userIgnore.ignores(rel) && !repoIgnore.ignored(rel))
    .sort();

  const findings: Finding[] = [];
  const label = `${want.ref} ${short(want.sha)}`;
  const local = isLocal(ctx, t.host);
  const dest = hostOf(ctx, t.host).ssh ?? "";
  const hostFile = (rel: string) => `${t.path.replace(/\/+$/, "")}/${rel}`;
  const fromGithub = (rel: string) => `gh api -H 'Accept: application/vnd.github.raw' 'repos/${repo}/contents/${prefix}${rel}?ref=${want.sha}'`;
  const onBox = (cmd: string) => `$ ${onHost(ctx, t.host, cmd)}`;
  if (differ.length) {
    const f = differ.sort()[0];
    findings.push({
      severity: "drift",
      code: "files-differ",
      message: `${differ.length} file${differ.length === 1 ? " differs" : "s differ"} from ${label}`,
      items: capped(differ),
      fix: [
        `First decide which side is right. See the difference (GitHub on the left, ${local ? "this machine" : t.host} on the right):`,
        `$ diff <(${fromGithub(f)}) <(${local ? `cat ${shownPath(hostFile(f))}` : `ssh ${dest} 'cat ${shownPath(hostFile(f))}'`})`,
        `Keep the ${local ? "local" : "server"} version: copy it into your clone of ${repo}${prefix ? ` (${prefix.slice(0, -1)}/)` : ""}, commit and push.`,
        ...(local ? [] : [`$ scp ${dest}:${shownPath(hostFile(f))} <your clone>/${prefix}${f}`]),
        `Keep GitHub's: redeploy, or overwrite just this file:`,
        `$ ${fromGithub(f)} | ${local ? `cat > ${shownPath(hostFile(f))}` : `ssh ${dest} 'cat > ${shownPath(hostFile(f))}'`}`,
      ],
    });
  }
  if (truncated) {
    // GitHub cut the file list short: "missing"/"only here" can't be trusted, only content mismatches can.
    findings.push({ severity: "info", message: "GitHub truncated the repo's file list (very large repo): only changed files were checked, not missing or extra ones" });
  } else {
    if (missing.length) {
      findings.push({
        severity: "drift",
        code: "files-missing",
        message: `${missing.length} file${missing.length === 1 ? " is" : "s are"} in the repo but missing here`,
        items: capped(missing.sort()),
        fix: [`Redeploy ${repo} @ ${want.ref}. If the files were removed on purpose, delete them from the repo too (or add them to this target's "ignore").`],
      });
    }
    if (extra.length) {
      findings.push({
        severity: "drift",
        code: "files-extra",
        message: `${extra.length} file${extra.length === 1 ? " exists" : "s exist"} only here (not in the repo, not gitignored)`,
        items: capped(extra),
        fix: [
          "For each file, one of:",
          `• real code or config: add it to ${repo}${local ? "" : ` (copy it down: scp ${dest}:${shownPath(hostFile(extra[0]))} <your clone>/${prefix}${extra[0]})`}, commit and push`,
          `• generated or runtime (logs, data, caches, .env): add it to the repo's .gitignore, or to this target's "ignore" in the config`,
          `• leftover junk: delete it${local ? "" : ` (${onBox(`rm ${shownPath(hostFile(extra[0]))}`).slice(2)})`}`,
        ],
      });
    }
  }
  if (box.unreadable.length) findings.push({ severity: "info", message: `${box.unreadable.length} unreadable file(s) skipped`, items: capped(box.unreadable.sort()) });
  if (repoIgnore.skipped) findings.push({ severity: "info", message: `${repoIgnore.skipped} .gitignore file(s) beyond the first ${MAX_GITIGNORES} were not applied` });

  if (ctx.evidence) {
    const host = hostOf(ctx, t.host);
    const hostLabel = local ? "local" : t.host ?? "host";
    const differF = findings.find((f) => f.code === "files-differ");
    if (differF) {
      const sample = differ.slice(0, 3);
      const got = parseCatMany(probeLines(await runScript(host, catManyScript(t.path, sample)), "reading changed files"), sample.length);
      const lines: string[] = [];
      for (const [i, rel] of sample.entries()) {
        const repoText = (await ctx.gh.blob(repo, expected.get(rel)!.sha)).toString("utf8");
        lines.push(`# ${rel}  (${hostLabel}: ${got[i].ls || "?"})`);
        lines.push(...unifiedDiff(repoText, got[i].content, `github ${prefix}${rel} @ ${short(want.sha)}`, `${hostLabel} ${hostFile(rel)}`).slice(0, 80));
      }
      differF.evidence = capLines(lines);
    }
    const extraF = findings.find((f) => f.code === "files-extra");
    if (extraF) {
      // Sizes and dates only: an unexplained file could hold secrets, so its contents never leave the host.
      const ls = probeLines(await runScript(host, lsScript(t.path, extra.slice(0, 15))), "listing extra files").filter((l) => l && l !== "END");
      extraF.evidence = capLines(["# extra files (size, date; contents not read)", ...ls]);
    }
  }

  const where = `${repo}${prefix ? "/" + prefix.slice(0, -1) : ""} @ ${label}`;
  const counted = [differ.length && `${differ.length} differ`, !truncated && missing.length && `${missing.length} missing`, !truncated && extra.length && `${extra.length} only here`].filter(Boolean);
  return { summary: counted.length ? `${counted.join(", ")} vs ${where}` : `${same} files match ${where}`, findings };
}

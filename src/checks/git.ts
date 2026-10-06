import { short } from "../blob.js";
import type { GitTarget } from "../config.js";
import { GithubError } from "../github.js";
import { runScript } from "../exec.js";
import { capLines } from "../evidence.js";
import { gitEvidenceScript, gitStateScript, parseGitState, probeLines, sections } from "../remote.js";
import type { Finding } from "../types.js";
import { capped, hostOf, isLocal, onHost, slug, type Context } from "./context.js";
import { relationFinding } from "./relation.js";

export interface Outcome {
  summary: string;
  findings: Finding[];
}

/** Quote a path for a command shown to the user, leaving plain paths (and ~/…) readable. */
export function shownPath(p: string): string {
  return /^[\w~./@+-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

export async function checkGit(ctx: Context, t: GitTarget): Promise<Outcome> {
  const repo = slug(ctx, t.repo);
  const [r, want] = await Promise.all([
    runScript(hostOf(ctx, t.host), gitStateScript(t.path)),
    ctx.gh.resolve(repo, t.ref).catch((e) => {
      if (e instanceof GithubError && e.status === 404) throw new Error(`GitHub has no ${repo}${t.ref ? ` ref ${t.ref}` : ""} (renamed, deleted, or no access with this token)`);
      throw e;
    }),
  ]);
  const s = parseGitState(probeLines(r, `inspecting ${t.path}`));
  if (s.error === "missing") {
    return { summary: `${t.path} does not exist`, findings: [{ severity: "drift", code: "missing-path", message: `${t.path} does not exist`, fix: ["Deploy it again, or remove this target from the config if it was retired."] }] };
  }
  if (s.error === "notgit") {
    return { summary: `${t.path} is not a git checkout`, findings: [{ severity: "drift", code: "not-git", message: `${t.path} is not a git checkout`, fix: ['If it is deployed by copying files, make it a "files" target instead of "git".'] }] };
  }
  if (s.error === "nogit") throw new Error(`git is not installed on the host`);
  if (s.error === "ownership") throw new Error(`git refuses ${t.path} ("dubious ownership"): connect as the user that owns the checkout`);
  if (s.error) throw new Error(`git status failed in ${t.path}`);
  if (!s.head) return { summary: `no commit checked out in ${t.path}`, findings: [{ severity: "drift", code: "no-commit", message: `no commit checked out (empty repo or unborn branch)` }] };

  const local = isLocal(ctx, t.host);
  const dest = hostOf(ctx, t.host).ssh ?? "";
  const here = (cmd: string) => `$ ${onHost(ctx, t.host, `cd ${shownPath(t.path)} && ${cmd}`)}`;
  // From your own clone, copy a branch that only exists on a server up to GitHub (servers usually can't push).
  const rescue = (from: string, to: string) => [
    `Save it to GitHub from your local clone of ${repo}:`,
    `$ git fetch ${dest}:${shownPath(t.path)} ${from} && git push origin FETCH_HEAD:refs/heads/${to}`,
  ];

  const findings: Finding[] = [];
  // onlyUnpushed (laptops): only work missing from GitHub is drift; stale/unmerged/other-branch is a note.
  const soft = t.onlyUnpushed ? ("info" as const) : ("drift" as const);
  const rel = await relationFinding(ctx.gh, repo, want, s.head);
  if (rel) {
    const target = s.branch && s.branch !== want.ref ? s.branch : `rescue/${local ? "local" : t.host}-${short(s.head)}`;
    const fix =
      rel.kind === "missing"
        ? local
          ? ["Push it so it exists on GitHub:", here(`git push -u origin ${s.branch && s.branch !== want.ref ? s.branch : `HEAD:refs/heads/${target}`}`)]
          : [...rescue(s.branch || "HEAD", target), `Then merge it into ${want.ref}, or redeploy ${want.ref} here if it shouldn't be live.`]
        : rel.kind === "behind"
          ? [`Update it to ${want.ref}${local ? "" : " (or re-run your deploy)"}:`, here("git pull --ff-only")]
          : [
              `Something not merged into ${want.ref} is checked out. Merge it into ${want.ref} on GitHub, or put this checkout back on ${want.ref}:`,
              here(`git checkout ${want.ref} && git pull --ff-only`),
              "If that refuses, the checkout has commits of its own: push them first.",
            ];
    findings.push({ severity: rel.missing ? "drift" : soft, code: rel.kind === "missing" ? "not-on-github" : rel.kind, message: rel.message, fix });
  }
  if (want.kind === "branch" && s.branch !== want.ref && !(t.allowDetached && !s.branch)) {
    findings.push({
      severity: soft,
      code: "wrong-branch",
      message: s.branch ? `checked out on branch ${s.branch}, expected ${want.ref}` : `detached HEAD, expected branch ${want.ref}`,
      fix: [`Switch back to ${want.ref}:`, here(`git checkout ${want.ref} && git pull --ff-only`)],
    });
  }
  if (s.dirtyCount > 0) {
    findings.push({
      severity: "drift",
      code: "uncommitted",
      message: `${s.dirtyCount} uncommitted change${s.dirtyCount === 1 ? "" : "s"}`,
      items: capped(s.dirty),
      fix: local
        ? [
            "Look at them:",
            here("git status && git diff"),
            "Keep them: commit and push.",
            here('git add <files> && git commit -m "…" && git push'),
            "Not wanted: `git restore <file>` for a changed file (M), delete an untracked one (??).",
          ]
        : [
            "Look at them:",
            here("git status && git diff"),
            `Keep them: copy the files into your local clone of ${repo}, commit and push, then redeploy here.`,
            `$ scp ${dest}:${shownPath(t.path)}/<file> <your clone>/<file>`,
            "Not wanted: `git restore <file>` there for a changed file (M), delete an untracked one (??).",
          ],
    });
  }
  if (s.stashes > 0) {
    findings.push({
      severity: "drift",
      code: "stash",
      message: `${s.stashes} stash${s.stashes === 1 ? "" : "es"} (hidden uncommitted work)`,
      fix: ["See what's in them:", here("git stash list && git stash show -p"), "Keep one: `git stash pop`, then commit and push. Not needed: `git stash drop`."],
    });
  }
  const dirtyTrees = s.worktrees.filter((w) => typeof w.dirty === "number" && w.dirty > 0);
  if (dirtyTrees.length) {
    const wt = dirtyTrees[0].path;
    findings.push({
      severity: "drift",
      code: "worktree-uncommitted",
      message: `uncommitted changes in ${dirtyTrees.length} other worktree${dirtyTrees.length === 1 ? "" : "s"}`,
      items: capped(dirtyTrees.map((w) => `${w.path} (${w.dirty})`)),
      fix: [
        "Look at them (one worktree at a time):",
        `$ ${onHost(ctx, t.host, `cd ${shownPath(wt)} && git status`)}`,
        "Commit and push (or discard) them. When the worktree is finished, remove it:",
        here(`git worktree remove ${shownPath(wt)}`),
      ],
    });
  }
  if (s.worktrees.length) {
    findings.push({ severity: "info", code: "worktrees", message: `${s.worktrees.length} extra worktree${s.worktrees.length === 1 ? "" : "s"}`, items: capped(s.worktrees.map((w) => (w.dirty === "missing" ? `${w.path} (directory gone: git worktree prune)` : w.path))) });
  }

  if (t.checkBranches !== false) {
    const others = s.branches.filter((b) => b.name !== s.branch && b.sha !== want.sha);
    const missing: { name: string; sha: string }[] = [];
    await Promise.all(
      others.map(async (b) => {
        if (!(await ctx.gh.commitExists(repo, b.sha))) missing.push(b);
      }),
    );
    if (missing.length) {
      missing.sort((a, b) => a.name.localeCompare(b.name));
      const first = missing[0].name;
      findings.push({
        severity: "drift",
        code: "unpushed-branches",
        message: `${missing.length} local branch${missing.length === 1 ? " has" : "es have"} commits not on GitHub`,
        items: capped(missing.map((b) => `${b.name} (${short(b.sha)})`)),
        fix: [
          ...(local ? ["Push it (one command per branch):", here(`git push -u origin ${first}`)] : rescue(first, first)),
          "Abandoned instead? Delete it: `git branch -D <name>`.",
        ],
      });
    }
  }

  if (ctx.evidence && findings.some((f) => f.severity === "drift")) {
    const trees = dirtyTrees.slice(0, 3).map((w) => w.path);
    const ev = sections(probeLines(await runScript(hostOf(ctx, t.host), gitEvidenceScript(t.path, trees)), `collecting evidence in ${t.path}`));
    const pick = (...names: string[]) => names.flatMap((n) => { const l = ev.get(n) ?? []; return l.length ? [`# ${n}`, ...l] : []; });
    const byCode: Record<string, string[]> = {
      uncommitted: pick("status", "diff", "untracked"),
      stash: pick("stashes"),
      "unpushed-branches": pick("local-only commits"),
      "not-on-github": pick("local-only commits"),
      "worktree-uncommitted": trees.flatMap((w) => pick(`worktree ${w}`)),
    };
    for (const f of findings) {
      const lines = f.code ? byCode[f.code] : undefined;
      if (f.severity === "drift" && lines?.length) f.evidence = capLines(lines);
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

import { short } from "../blob.js";
import type { StampTarget } from "../config.js";
import { execError, runScript } from "../exec.js";
import { catScript } from "../remote.js";
import { hostOf, slug, type Context } from "./context.js";
import type { Outcome } from "./git.js";
import { relationFinding } from "./relation.js";

export function readStamp(content: string, t: Pick<StampTarget, "field" | "pattern">): string | null {
  if (t.field) {
    let v: any;
    try {
      v = JSON.parse(content);
    } catch {
      return null;
    }
    for (const k of t.field.split(".")) v = v?.[k];
    return typeof v === "string" ? v.trim() : null;
  }
  if (t.pattern) return content.match(new RegExp(t.pattern))?.[1]?.trim() ?? null;
  return content.trim().split(/\s+/)[0] || null;
}

export async function checkStamp(ctx: Context, t: StampTarget): Promise<Outcome> {
  const repo = slug(ctx, t.repo);
  const [r, want] = await Promise.all([runScript(hostOf(ctx, t.host), catScript(t.path)), ctx.gh.resolve(repo, t.ref)]);
  if (r.code !== 0 && !r.stdout) throw new Error(`could not read ${t.path}: ${execError(r)}`);
  if (r.stdout.startsWith("ERR missing")) return { summary: `${t.path} does not exist`, findings: [{ severity: "drift", message: `stamp ${t.path} does not exist` }] };
  const sha = readStamp(r.stdout.replace(/^OK\n/, ""), t);
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    return { summary: `no commit SHA found in ${t.path}`, findings: [{ severity: "drift", message: `no commit SHA found in ${t.path}` }] };
  }
  const rel = await relationFinding(ctx.gh, repo, want, sha.toLowerCase());
  return rel
    ? { summary: `deployed ${short(sha)} — ${rel.message}`, findings: [rel] }
    : { summary: `deployed ${short(sha)} = ${want.ref} on GitHub`, findings: [] };
}

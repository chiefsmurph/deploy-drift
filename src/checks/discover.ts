import { expandHome, type DiscoverConfig } from "../config.js";
import { execError, runScript } from "../exec.js";
import { discoverScript } from "../remote.js";
import { capped, hostOf, type Context } from "./context.js";
import type { Outcome } from "./git.js";

const norm = (p: string) => p.replace(/\/+$/, "");

/** Git checkouts under `roots` on a host that no `git` target covers — new or forgotten deployments. */
export async function checkDiscover(ctx: Context, d: DiscoverConfig): Promise<Outcome> {
  const host = hostOf(ctx, d.host);
  const local = Boolean(host.local);
  const fix = (p: string) => norm(local ? expandHome(p) : p);
  const r = await runScript(host, discoverScript(d.roots, d.maxDepth ?? 3));
  if (r.code !== 0 && !r.stdout) throw new Error(`discover failed: ${execError(r)}`);
  const found = r.stdout.split("\n").filter(Boolean).map((p) => norm(p.replace(/\/\.git$/, "")));
  const known = new Set(
    ctx.config.targets
      .filter((t) => (t.type === "git" || t.type === "files") && (t.host ?? "local") === d.host)
      .map((t) => fix((t as { path: string }).path)),
  );
  const ignored = (d.ignore ?? []).map(fix);
  const unknown = found.filter((p) => !known.has(p) && !ignored.some((i) => p === i || p.startsWith(i + "/"))).sort();
  return unknown.length
    ? {
        summary: `${unknown.length} git checkout${unknown.length === 1 ? "" : "s"} not in the config`,
        findings: [{ severity: "drift", message: `${unknown.length} git checkout${unknown.length === 1 ? " is" : "s are"} not covered by any target`, items: capped(unknown, 30) }],
      }
    : { summary: `${found.length} checkouts found, all covered`, findings: [] };
}

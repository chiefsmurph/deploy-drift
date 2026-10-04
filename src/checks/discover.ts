import type { DiscoverConfig } from "../config.js";
import { runScript } from "../exec.js";
import { discoverScript, probeLines } from "../remote.js";
import type { Finding } from "../types.js";
import { capped, hostOf, type Context } from "./context.js";
import type { Outcome } from "./git.js";

const norm = (p: string) => p.replace(/\/+$/, "");

/** Git checkouts under `roots` on a host that no `git` target covers — new or forgotten deployments. */
export async function checkDiscover(ctx: Context, d: DiscoverConfig): Promise<Outcome> {
  const r = await runScript(hostOf(ctx, d.host), discoverScript(d.roots, d.maxDepth ?? 3));
  const lines = probeLines(r, "discover").filter((l) => l && l !== "END");
  // "~/x" in the config means the HOST's home, which may differ from this machine's.
  const home = lines.find((l) => l.startsWith("HOME "))?.slice(5) ?? "";
  const fix = (p: string) => norm(p === "~" ? home : p.startsWith("~/") ? home + p.slice(1) : p);
  const noRoot = lines.filter((l) => l.startsWith("NOROOT ")).map((l) => l.slice(7));
  const found = lines.filter((l) => !l.startsWith("HOME ") && !l.startsWith("NOROOT ")).map((p) => norm(p.replace(/\/\.git$/, "")));
  const known = ctx.config.targets
    .filter((t) => (t.type === "git" || t.type === "files") && (t.host ?? "local") === d.host)
    .map((t) => fix((t as { path: string }).path));
  const ignored = (d.ignore ?? []).map(fix);
  // A .git nested inside a covered checkout (submodule, vendored repo) belongs to that target.
  const covered = (p: string) => known.some((k) => p === k || p.startsWith(k + "/")) || ignored.some((i) => p === i || p.startsWith(i + "/"));
  const unknown = found.filter((p) => !covered(p)).sort();
  const findings: Finding[] = [];
  if (unknown.length) {
    findings.push({ severity: "drift", message: `${unknown.length} git checkout${unknown.length === 1 ? " is" : "s are"} not covered by any target`, items: capped(unknown, 30) });
  }
  if (noRoot.length) findings.push({ severity: "info", message: `root${noRoot.length === 1 ? "" : "s"} not found: ${noRoot.join(", ")}` });
  return {
    summary: unknown.length ? `${unknown.length} git checkout${unknown.length === 1 ? "" : "s"} not in the config` : `${found.length} checkouts found, all covered`,
    findings,
  };
}

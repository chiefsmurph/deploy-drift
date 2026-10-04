import { resolve } from "node:path";
import { expandHome, validate, type Config } from "./config.js";

/**
 * Config for `deploy-drift scan`: find every git checkout under `roots` (on this machine, or over SSH)
 * and check each one against its GitHub remote. No config file needed.
 */
export function scanConfig(roots: string[], opts: { ssh?: string; depth?: number } = {}): Config {
  const dirs = roots.length ? roots : ["."];
  const host = opts.ssh ?? "local";
  return validate({
    hosts: opts.ssh ? { [opts.ssh]: { ssh: opts.ssh } } : {},
    targets: [],
    // Local roots are made absolute so reports show real paths; remote roots are left to the remote shell.
    discover: [{ host, roots: opts.ssh ? dirs : dirs.map((d) => resolve(expandHome(d))), maxDepth: opts.depth ?? 3, check: true, onlyUnpushed: true }],
  });
}

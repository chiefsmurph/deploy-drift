import type { Config, HostConfig } from "../config.js";
import { repoSlug } from "../config.js";
import { q } from "../exec.js";
import type { Github } from "../github.js";

export interface Context {
  config: Config;
  gh: Github;
}

export function hostOf(ctx: Context, name = "local"): HostConfig {
  return ctx.config.hosts[name];
}

export function slug(ctx: Context, repo: string): string {
  return repoSlug(ctx.config, repo);
}

/** A command as the user would type it: as-is for this machine, wrapped in ssh for a server. */
export function onHost(ctx: Context, hostName: string | undefined, cmd: string): string {
  const h = hostOf(ctx, hostName);
  return h.local ? cmd : `ssh ${[...(h.sshArgs ?? []), h.ssh].join(" ")} ${q(cmd)}`;
}

export const isLocal = (ctx: Context, hostName?: string) => Boolean(hostOf(ctx, hostName).local);

/** Cap long lists so a report stays readable. */
export function capped(items: string[], max = 15): string[] {
  return items.length <= max ? items : [...items.slice(0, max), `… and ${items.length - max} more`];
}

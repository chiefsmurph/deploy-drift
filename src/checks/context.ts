import type { Config, HostConfig } from "../config.js";
import { repoSlug } from "../config.js";
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

/** Cap long lists so a report stays readable. */
export function capped(items: string[], max = 15): string[] {
  return items.length <= max ? items : [...items.slice(0, max), `… and ${items.length - max} more`];
}

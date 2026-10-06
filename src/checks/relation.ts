import { short } from "../blob.js";
import type { Github, Resolved } from "../github.js";
import type { Finding } from "../types.js";

/**
 * Explain how a checked-out or deployed commit relates to the expected one. Returns null when they match.
 * `missing` marks the important case: GitHub has never seen the commit, so it exists only on that machine.
 */
export type Relation = Finding & { kind: "missing" | "behind" | "ahead" | "diverged"; missing?: boolean };

export async function relationFinding(gh: Github, repo: string, want: Resolved, have: string): Promise<Relation | null> {
  if (have === want.sha || (have.length >= 7 && want.sha.startsWith(have))) return null;
  const cmp = await gh.compare(repo, want.sha, have);
  const at = `${short(have)} vs ${want.ref} ${short(want.sha)}`;
  if (!cmp) return { kind: "missing", severity: "drift", message: `commit ${short(have)} is not on GitHub — it exists only here`, missing: true };
  switch (cmp.status) {
    case "behind":
      return { kind: "behind", severity: "drift", message: `behind ${want.ref} by ${cmp.behindBy} commit${cmp.behindBy === 1 ? "" : "s"} (${at})` };
    case "ahead":
      return { kind: "ahead", severity: "drift", message: `${cmp.aheadBy} commit${cmp.aheadBy === 1 ? "" : "s"} ahead of ${want.ref} (on GitHub, not merged) (${at})` };
    case "diverged":
      return { kind: "diverged", severity: "drift", message: `diverged from ${want.ref}: ${cmp.aheadBy} ahead, ${cmp.behindBy} behind (${at})` };
    default:
      return null; // identical trees under different SHAs
  }
}

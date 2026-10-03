import { short } from "../blob.js";
import type { Github, Resolved } from "../github.js";
import type { Finding } from "../types.js";

/**
 * Explain how a deployed commit relates to the expected one. Returns null when they match.
 * "Not on GitHub" is the important case: commits that exist only on that machine.
 */
export async function relationFinding(gh: Github, repo: string, want: Resolved, have: string): Promise<Finding | null> {
  if (have === want.sha || (have.length >= 7 && want.sha.startsWith(have))) return null;
  const cmp = await gh.compare(repo, want.sha, have);
  const at = `${short(have)} vs ${want.ref} ${short(want.sha)}`;
  if (!cmp) return { severity: "drift", message: `deployed commit ${short(have)} is not on GitHub — it exists only here` };
  switch (cmp.status) {
    case "behind":
      return { severity: "drift", message: `behind ${want.ref} by ${cmp.behindBy} commit${cmp.behindBy === 1 ? "" : "s"} (${at})` };
    case "ahead":
      return { severity: "drift", message: `${cmp.aheadBy} commit${cmp.aheadBy === 1 ? "" : "s"} ahead of ${want.ref} (on GitHub, not merged) (${at})` };
    case "diverged":
      return { severity: "drift", message: `diverged from ${want.ref}: ${cmp.aheadBy} ahead, ${cmp.behindBy} behind (${at})` };
    default:
      return null; // identical trees under different SHAs
  }
}

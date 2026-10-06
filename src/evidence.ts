import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_LINES = 160;

/**
 * Hide likely secrets before evidence goes into a report, an email or an AI prompt: values assigned to
 * secret-sounding names, and well-known token formats.
 */
export function redact(line: string): string {
  return line
    .replace(/((?:api[_-]?key|secret|token|passw(?:or)?d|pass|auth|credential|private[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1<redacted>")
    .replace(/\b(sk_(?:live|test)_|ghp_|gho_|github_pat_|npm_|xox[abpr]-|AKIA|glpat-)[A-Za-z0-9_\-]{8,}/g, "$1<redacted>")
    .replace(/(\/\/[^/\s:@]+:)[^@\s/]+@/g, "$1<redacted>@");
}

export function capLines(lines: string[], max = MAX_LINES): string[] {
  const clean = lines.map(redact);
  return clean.length <= max ? clean : [...clean.slice(0, max), `… ${clean.length - max} more lines`];
}

/** Unified diff of two texts via the system diff(1) (GNU and BSD both support -u and -L). */
export function unifiedDiff(a: string, b: string, labelA: string, labelB: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "gd-"));
  try {
    writeFileSync(join(dir, "a"), a);
    writeFileSync(join(dir, "b"), b);
    try {
      execFileSync("diff", ["-u", "-L", labelA, "-L", labelB, join(dir, "a"), join(dir, "b")], { encoding: "utf8" });
      return ["(identical)"];
    } catch (e) {
      const out = (e as { stdout?: string }).stdout ?? "";
      return out ? out.replace(/\n$/, "").split("\n") : ["(diff unavailable)"];
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

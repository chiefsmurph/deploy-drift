/** "drift" findings make a check fail; "info" findings are reported but never fail it. */
export type Severity = "drift" | "info";

export type Status = "ok" | "drift" | "error";

export interface Finding {
  severity: Severity;
  /** Stable machine-readable kind (e.g. "uncommitted", "files-differ") for scripts and AI agents. */
  code?: string;
  message: string;
  /** Optional detail lines (file paths, git status lines, command output). */
  items?: string[];
  /** How to resolve it: plain lines, and commands prefixed with "$ ". */
  fix?: string[];
  /** With --evidence: read-only context for deciding the fix (diffs, commit logs, dates). Secrets redacted. */
  evidence?: string[];
  /** When this problem was first seen (ISO), from the state file. Equal to the run's time = new. */
  firstSeen?: string;
}

export interface CheckResult {
  name: string;
  type: string;
  host: string;
  status: Status;
  /** One line describing the outcome. */
  summary: string;
  findings: Finding[];
  ms: number;
}

export function statusOf(findings: Finding[]): Status {
  return findings.some((f) => f.severity === "drift") ? "drift" : "ok";
}

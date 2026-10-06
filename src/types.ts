/** "drift" findings make a check fail; "info" findings are reported but never fail it. */
export type Severity = "drift" | "info";

export type Status = "ok" | "drift" | "error";

export interface Finding {
  severity: Severity;
  message: string;
  /** Optional detail lines (file paths, git status lines, command output). */
  items?: string[];
  /** How to resolve it: plain lines, and commands prefixed with "$ ". */
  fix?: string[];
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

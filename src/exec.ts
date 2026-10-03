import { spawn } from "node:child_process";
import type { HostConfig } from "./config.js";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run a POSIX sh script on a host. Locally it is piped to `sh -s`; remotely to `ssh <dest> sh -s`,
 * so nothing is ever copied to or installed on the server.
 */
export function runScript(host: HostConfig, script: string, timeoutMs = 120_000): Promise<ExecResult> {
  const [cmd, args] = host.local
    ? ["sh", ["-s"]]
    : ["ssh", [...(host.sshArgs ?? []), "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", host.ssh!, "sh -s"]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + e.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
    child.stdin.on("error", () => {}); // the remote may close stdin early
    child.stdin.end(script);
  });
}

/** Single-quote a string for sh. */
export function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quote a path for sh, keeping a leading ~/ expandable on whichever machine runs the script. */
export function qpath(p: string): string {
  if (p === "~") return `"$HOME"`;
  if (p.startsWith("~/")) return `"$HOME"/${q(p.slice(2))}`;
  return q(p);
}

/** A short, readable reason for a failed connection or script. */
export function execError(r: ExecResult): string {
  if (r.timedOut) return "timed out";
  const last = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-2).join(" ").slice(0, 300);
  return `exit ${r.code}${last ? `: ${last}` : ""}`;
}

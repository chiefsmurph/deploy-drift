import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CheckResult, Finding } from "./types.js";

/**
 * When each problem was first seen, so a daily report can say what is new and what has been sitting there.
 * Keyed by check (host + name), then by finding code (or message). Only checks that ran are updated: a
 * problem that is gone is forgotten, so if it comes back it is new again.
 */
export interface History {
  version: 1;
  seen: Record<string, Record<string, string>>;
}

const empty = (): History => ({ version: 1, seen: {} });
const checkKey = (r: CheckResult) => `${r.host}\u0000${r.name}`;
const findingKey = (f: Finding) => f.code ?? f.message;
const tracked = (r: CheckResult) => r.findings.filter((f) => f.severity === "drift");

/** $XDG_STATE_HOME/git-drift/seen.json, else ~/.local/state/git-drift/seen.json. */
export function defaultStatePath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "git-drift", "seen.json");
}

/** A missing or unreadable state file is a fresh start, never an error. */
export async function loadHistory(path: string): Promise<History> {
  try {
    const h = JSON.parse(await readFile(path, "utf8")) as History;
    return h?.version === 1 && h.seen && typeof h.seen === "object" ? h : empty();
  } catch {
    return empty();
  }
}

/** Stamp `firstSeen` on every drift finding and return the history to save. */
export function applyHistory(results: CheckResult[], history: History, now: Date): History {
  const stamp = now.toISOString();
  const seen = { ...history.seen };
  for (const r of results) {
    const before = seen[checkKey(r)] ?? {};
    const after: Record<string, string> = {};
    for (const f of tracked(r)) {
      const key = findingKey(f);
      f.firstSeen = after[key] ?? before[key] ?? stamp;
      after[key] = f.firstSeen;
    }
    if (Object.keys(after).length) seen[checkKey(r)] = after;
    else delete seen[checkKey(r)];
  }
  return { version: 1, seen };
}

export async function saveHistory(path: string, history: History): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(history, null, 1) + "\n");
  await rename(tmp, path);
}

/** True when the finding was first seen in this run. */
export const isNew = (f: Finding, when: Date) => f.firstSeen === when.toISOString();

/** "new", or "since Oct 5 · day 3" (calendar days in local time, the day it first showed up is day 1). */
export function ageLabel(f: Finding, when: Date): string | null {
  if (!f.firstSeen) return null;
  if (isNew(f, when)) return "new";
  const first = new Date(f.firstSeen);
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const day = Math.round((midnight(when) - midnight(first)) / 86_400_000) + 1;
  return `since ${first.toLocaleDateString("en-US", { month: "short", day: "numeric" })} · day ${day}`;
}

/** Checks with at least one problem that is new in this run. */
export function newChecks(results: CheckResult[], when: Date): number {
  return results.filter((r) => r.status !== "ok" && r.findings.some((f) => isNew(f, when))).length;
}

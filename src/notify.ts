import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { VERSION } from "./generated.js";
import { headline, render } from "./report.js";
import type { CheckResult } from "./types.js";

/**
 * Email the report through PingPigeon (pingpigeon.app): a free email/push service by git-drift's author.
 * The login lives in ~/.pingpigeon/config.json (0600), shared with PingPigeon's own tools, so one sign-in
 * covers both. Mail only ever goes to the account's own verified address.
 */
export interface PigeonLogin {
  url: string;
  token: string;
  email?: string;
  topic?: string | null;
  phoneVerified?: boolean;
}

export const PIGEON_URL = "https://pingpigeon.app";

// The free plan allows 100 KB per email (text + html together). Stay under it with room for the headers.
const BODY_BUDGET = 95 * 1024;

export class PigeonError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export function loginPath(home = homedir()): string {
  return join(home, ".pingpigeon", "config.json");
}

/** PINGPIGEON_TOKEN (and PINGPIGEON_URL) win, for CI; otherwise the shared login file. */
export async function readLogin(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<PigeonLogin | null> {
  if (env.PINGPIGEON_TOKEN) return { url: env.PINGPIGEON_URL || PIGEON_URL, token: env.PINGPIGEON_TOKEN };
  try {
    const c = JSON.parse(await readFile(loginPath(home), "utf8")) as PigeonLogin;
    return c?.token ? { ...c, url: c.url || PIGEON_URL } : null;
  } catch {
    return null;
  }
}

export async function saveLogin(login: PigeonLogin, home = homedir()): Promise<string> {
  const path = loginPath(home);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(login, null, 2) + "\n", { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
  return path;
}

async function call(base: string, path: string, opts: { token?: string; body?: Record<string, unknown> } = {}): Promise<Record<string, any>> {
  let res: Response;
  try {
    res = await fetch(base.replace(/\/+$/, "") + path, {
      method: opts.body ? "POST" : "GET",
      headers: {
        "user-agent": `git-drift/${VERSION}`,
        ...(opts.body ? { "content-type": "application/json" } : {}),
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new PigeonError(`can't reach ${base}: ${(e as Error).message}`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || data.ok === false) throw new PigeonError(data.error || `${base}${path} answered ${res.status}`, res.status);
  return data;
}

export const pigeon = {
  /** Email a 6-digit code to `email` (also how an existing account signs in on a new machine). */
  signup: (url: string, email: string) => call(url, "/signup", { body: { email } }),
  /** Trade the code for a token. `client` labels the token, so the account shows where it was connected. */
  verify: (url: string, email: string, code: string) => call(url, "/verify-email", { body: { email, code, client: "git-drift" } }),
  me: (login: PigeonLogin) => call(login.url, "/me", { token: login.token }),
  email: (login: PigeonLogin, msg: { subject: string; body: string; html?: string }) => call(login.url, "/email", { token: login.token, body: msg }),
};

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

/** Fit a report into one email: drop the html version if both don't fit, then trim the text. */
export function fitEmail(text: string, html: string | undefined, budget = BODY_BUDGET): { body: string; html?: string } {
  if (html && bytes(text) + bytes(html) <= budget) return { body: text, html };
  if (bytes(text) <= budget) return { body: text };
  const note = "\n\n… report cut short to fit one email. Run git-drift for the full report.\n";
  let cut = text.slice(0, budget - bytes(note));
  while (bytes(cut) > budget - bytes(note)) cut = cut.slice(0, -1024);
  return { body: cut.slice(0, cut.lastIndexOf("\n") + 1) + note };
}

export async function sendReport(login: PigeonLogin, results: CheckResult[], quiet: boolean, when: Date): Promise<void> {
  const msg = fitEmail(render(results, "text", quiet, when), render(results, "html", quiet, when));
  await pigeon.email(login, { subject: `git-drift: ${headline(results, when)}`, ...msg });
}

const usageLine = (me: Record<string, any>) => {
  const u = me.usage;
  return `${me.subscriber?.email ?? "?"} · ${u?.plan ?? me.subscriber?.plan ?? "free"} plan${u?.email ? ` · ${u.email.used}/${u.email.quota} emails this month` : ""}`;
};

export interface SetupIO {
  /** Ask a question and return the answer (trimmed). */
  ask: (question: string) => Promise<string>;
  say: (line: string) => void;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * `git-drift notify pingpigeon [email] [--token t]`: sign up or sign in, verifying the address with a code
 * emailed to it, and save the login. An existing working login is reused.
 */
export async function setupPigeon(io: SetupIO, opts: { email?: string; token?: string; url?: string } = {}): Promise<PigeonLogin> {
  const url = opts.url || PIGEON_URL;
  io.say("PingPigeon (pingpigeon.app) emails you your git-drift reports. It's a free service made by git-drift's author:");
  io.say("free accounts get 200 emails a month, sent only to your own verified address. Reports contain repo paths,");
  io.say("host names, file names, fix commands and the last lines of output from any failed `command` check;");
  io.say("never file contents or diffs.");
  io.say("");

  if (opts.token) {
    const login: PigeonLogin = { url, token: opts.token };
    const me = await pigeon.me(login);
    login.email = me.subscriber?.email;
    login.topic = me.subscriber?.ntfy_topic ?? null;
    const path = await saveLogin(login, io.home);
    io.say(`Signed in: ${usageLine(me)}. Saved to ${path}.`);
    return login;
  }

  const existing = await readLogin(io.env ?? {}, io.home);
  if (existing) {
    const me = await pigeon.me(existing).catch(() => null);
    const same = !opts.email || opts.email.toLowerCase() === String(me?.subscriber?.email ?? "").toLowerCase();
    if (me && same) {
      io.say(`Already signed in to PingPigeon: ${usageLine(me)}. git-drift will use it.`);
      return existing;
    }
    if (me) {
      const ok = await io.ask(`This replaces the PingPigeon sign-in in ${loginPath(io.home)} (${me.subscriber?.email}). Continue? [y/N] `);
      if (!/^y(es)?$/i.test(ok)) throw new PigeonError("kept the existing sign-in");
    }
  }

  const email = opts.email || (await io.ask("Your email address: "));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PigeonError(`"${email}" doesn't look like an email address`);
  try {
    await pigeon.signup(url, email);
  } catch (e) {
    const captcha = /captcha/i.test((e as Error).message);
    throw new PigeonError(
      (captcha ? "PingPigeon is asking for a captcha right now (too many signups at once)." : (e as Error).message) +
        `\nOr sign up at ${url}, copy your token, and run: git-drift notify pingpigeon --token <token>`,
    );
  }
  io.say(`Sent a 6-digit code to ${email} (check spam if it isn't there in a minute).`);
  for (let tries = 3; ; tries--) {
    const code = (await io.ask("Code: ")).replace(/\s+/g, "");
    try {
      const v = await pigeon.verify(url, email, code);
      const login: PigeonLogin = { url, token: v.token, email: v.subscriber?.email ?? email, topic: v.subscriber?.ntfy_topic ?? null, phoneVerified: !!v.subscriber?.phone_verified };
      const path = await saveLogin(login, io.home);
      io.say(`Verified. Signed in as ${login.email}; saved to ${path}.`);
      return login;
    } catch (e) {
      if (tries <= 1 || !/invalid/i.test((e as Error).message)) throw e;
      io.say(`${(e as Error).message}. Try again.`);
    }
  }
}

/** `git-drift notify`: where reports go, and how much of the month's allowance is used. */
export async function describeNotify(env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<string> {
  const login = await readLogin(env, home);
  if (!login) return "Reports aren't emailed anywhere yet. Set it up (free): git-drift notify pingpigeon";
  const me = await pigeon.me(login);
  return [
    `PingPigeon: ${usageLine(me)}`,
    "Email the report when something drifts:  git-drift --notify   (every run: --notify-always)",
    "Send a test email:                       git-drift notify test",
  ].join("\n");
}

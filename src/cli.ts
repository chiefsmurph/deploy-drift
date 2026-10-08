#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ConfigError, expandHome, findConfig, loadConfig } from "./config.js";
import { findToken, GithubApi } from "./github.js";
import { applyHistory, defaultStatePath, loadHistory, saveHistory } from "./history.js";
import { createInterface, type Interface } from "node:readline/promises";
import { describeNotify, pigeon, PigeonError, readLogin, sendReport, setupPigeon } from "./notify.js";
import { counts, formatFromPath, render, type Format } from "./report.js";
import { buildTasks, runAll } from "./run.js";
import { scanConfig } from "./scan.js";
import { EXAMPLE_CONFIG, VERSION } from "./generated.js";

const USAGE = `git-drift — find code that never made it to GitHub, on your servers and your laptop

Usage:
  git-drift scan [dir...]      check every git repo under the dirs (default: .) against GitHub
       --ssh <host>               ...on a server instead of this machine (dirs are on the server)
       --depth <n>                how deep to look for repos (default 3)
  git-drift [options]          run every check in the config file
  git-drift init [file]        write an example config (default git-drift.config.json)
  git-drift notify             where reports get emailed
  git-drift notify pingpigeon [email]   get reports by email (free): verifies your address with a code
       --token <token>            ...or sign in with a token from pingpigeon.app
  git-drift notify test        send a test email

Options:
  -c, --config <file>      config file (default: ./git-drift.config.json, else $GIT_DRIFT_CONFIG,
                           else ~/.config/git-drift/config.json)
  -f, --format <fmt>       stdout format: text | markdown | html | json (default: text)
  -o, --out <file>         also write a report; format from the extension (.md .html .json .txt). Repeatable.
      --only <name>        run only checks whose name contains <name>, or on host <name>. Repeatable.
  -q, --quiet              leave clean checks out of the report
  -e, --evidence           for each drift, also collect read-only evidence (diffs, commit logs, dates;
                           secrets redacted) into the json report, e.g. to hand to an AI agent
      --concurrency <n>    checks to run at once (default 6)
      --state <file>       where to remember when each problem was first seen, so reports mark it
                           "new" or "since Oct 5 · day 3" (default ~/.local/state/git-drift/seen.json)
      --no-state           don't read or write that file
      --notify             email the report (PingPigeon) when something drifted or failed
      --notify-always      email it after every run, clean or not
  -h, --help | -v, --version

GitHub auth: GITHUB_TOKEN or GH_TOKEN, else the token from \`gh auth login\`.
Exit codes: 0 clean, 1 drift found, 2 a check could not run or the config is invalid.`;

interface Args {
  config?: string;
  format: Format;
  outs: string[];
  only: string[];
  quiet: boolean;
  evidence: boolean;
  concurrency: number;
  /** null = --no-state */
  state?: string | null;
  init?: string;
  /** `notify [pingpigeon|test] [email]` */
  notifyCmd?: string[];
  token?: string;
  notifyWhen?: "drift" | "always";
  scan?: { roots: string[]; ssh?: string; depth?: number };
}

function parseArgs(argv: string[]): Args {
  const a: Args = { format: "text", outs: [], only: [], quiet: false, evidence: false, concurrency: 6 };
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) throw new ConfigError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "scan": a.scan = { roots: [] }; break;
      case "--ssh": if (!a.scan) throw new ConfigError("--ssh only works with scan"); a.scan.ssh = value(i++, arg); break;
      case "--depth": {
        if (!a.scan) throw new ConfigError("--depth only works with scan");
        const n = Number(value(i++, arg));
        if (!Number.isInteger(n) || n < 1 || n > 20) throw new ConfigError("--depth must be an integer 1-20");
        a.scan.depth = n;
        break;
      }
      case "notify": a.notifyCmd = []; break;
      case "--token": if (!a.notifyCmd) throw new ConfigError("--token only works with notify"); a.token = value(i++, arg); break;
      case "--notify": a.notifyWhen = "drift"; break;
      case "--notify-always": a.notifyWhen = "always"; break;
      case "init": a.init = argv[i + 1] && !argv[i + 1].startsWith("-") ? argv[++i] : "git-drift.config.json"; break;
      case "-c": case "--config": a.config = value(i++, arg); break;
      case "-f": case "--format": {
        const f = value(i++, arg) as Format;
        if (!["text", "markdown", "html", "json"].includes(f)) throw new ConfigError(`unknown format "${f}"`);
        a.format = f;
        break;
      }
      case "-o": case "--out": a.outs.push(value(i++, arg)); break;
      case "--only": a.only.push(value(i++, arg)); break;
      case "-q": case "--quiet": a.quiet = true; break;
      case "-e": case "--evidence": a.evidence = true; break;
      case "--state": a.state = value(i++, arg); break;
      case "--no-state": a.state = null; break;
      case "--concurrency": a.concurrency = Math.max(1, Number(value(i++, arg)) || 6); break;
      case "-h": case "--help": console.log(USAGE); process.exit(0);
      case "-v": case "--version": {
        console.log(VERSION);
        process.exit(0);
      }
      default:
        if (a.scan && !arg.startsWith("-")) { a.scan.roots.push(arg); break; }
        if (a.notifyCmd && !arg.startsWith("-")) { a.notifyCmd.push(arg); break; }
        throw new ConfigError(`unknown argument "${arg}"\n\n${USAGE}`);
    }
  }
  return a;
}

async function init(path: string): Promise<void> {
  const target = expandHome(path);
  if (existsSync(target)) throw new ConfigError(`${path} already exists — not overwriting`);
  await writeFile(target, EXAMPLE_CONFIG);
  console.log(`wrote ${path} — edit hosts and targets, then run: git-drift -c ${path}`);
}

/** Prompts on the terminal; the readline interface is opened only if a question is actually asked. */
function terminal() {
  let rl: Interface | undefined;
  return {
    ask: async (question: string) => {
      if (!process.stdin.isTTY) throw new ConfigError("this step needs a terminal to answer in (or pass --token)");
      rl ??= createInterface({ input: process.stdin, output: process.stdout });
      return (await rl.question(question)).trim();
    },
    say: (line: string) => console.log(line),
    env: process.env,
    close: () => rl?.close(),
  };
}

async function notify(cmd: string[], token?: string): Promise<number> {
  const [what, email, ...rest] = cmd;
  if (rest.length) throw new ConfigError(`unexpected "${rest[0]}"`);
  if (!what) {
    console.log(await describeNotify());
    return 0;
  }
  if (what === "test") {
    const login = await readLogin();
    if (!login) throw new ConfigError("no PingPigeon sign-in yet: git-drift notify pingpigeon");
    const body = "It works: git-drift reports will arrive here.\n\nTo get them, add --notify to your scheduled git-drift run.\n";
    await pigeon.email(login, { subject: "git-drift: test email", body });
    console.log(`Sent a test email to ${login.email ?? "your PingPigeon address"}.`);
    return 0;
  }
  if (what !== "pingpigeon") throw new ConfigError(`unknown notify destination "${what}" (supported: pingpigeon)`);
  const io = terminal();
  try {
    await setupPigeon(io, { email, token });
  } finally {
    io.close();
  }
  console.log("\nNext: add --notify to your scheduled run (cron, launchd, CI), e.g.  git-drift --notify");
  console.log("Send a test email:  git-drift notify test");
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.init) {
    await init(args.init);
    return 0;
  }
  if (args.notifyCmd) return notify(args.notifyCmd, args.token);
  const configPath = args.scan ? null : args.config ?? findConfig();
  if (!args.scan && !configPath) {
    throw new ConfigError(
      "no config found (./git-drift.config.json, $GIT_DRIFT_CONFIG, ~/.config/git-drift/config.json).\n" +
        "  Quick look at a folder of repos:  git-drift scan ~/code\n  Set up servers + repos:          git-drift init",
    );
  }
  const config = args.scan ? scanConfig(args.scan.roots, args.scan) : await loadConfig(configPath!);
  const token = findToken(config.github?.apiUrl);
  if (!token) console.error("warning: no GitHub token (set GITHUB_TOKEN or run `gh auth login`); private repos will fail");
  const gh = new GithubApi(token, config.github?.apiUrl);
  const tasks = buildTasks({ config, gh, evidence: args.evidence }, args.only);
  if (!tasks.length) throw new ConfigError("no checks matched");
  const results = await runAll(tasks, args.concurrency, args.only);
  if (!results.length) throw new ConfigError("no checks matched");
  const when = new Date();
  const statePath = args.state === null ? null : expandHome(args.state ?? defaultStatePath());
  if (statePath) {
    const history = applyHistory(results, await loadHistory(statePath), when);
    await saveHistory(statePath, history).catch((e) => console.error(`warning: could not save ${statePath}: ${(e as Error).message}`));
  }
  process.stdout.write(render(results, args.format, args.quiet, when));
  for (const out of args.outs) await writeFile(expandHome(out), render(results, formatFromPath(out), args.quiet, when));
  const c = counts(results);
  if (args.notifyWhen === "always" || (args.notifyWhen && (c.drift || c.error))) {
    const login = await readLogin();
    if (!login) console.error("warning: --notify: no PingPigeon sign-in yet. Set it up: git-drift notify pingpigeon");
    else {
      await sendReport(login, results, args.quiet, when).then(
        () => console.error(`emailed the report to ${login.email ?? "your PingPigeon address"}`),
        (e) => console.error(`warning: could not email the report: ${(e as Error).message}`),
      );
    }
  }
  return c.error ? 2 : c.drift ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code; // not process.exit(): that can cut off a large piped report
  },
  (e) => {
    console.error(e instanceof ConfigError || e instanceof PigeonError ? e.message : `git-drift: ${(e as Error).stack ?? e}`);
    process.exitCode = 2;
  },
);


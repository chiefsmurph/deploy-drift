#!/usr/bin/env node
import { copyFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { ConfigError, expandHome, loadConfig } from "./config.js";
import { findToken, GithubApi } from "./github.js";
import { counts, formatFromPath, render, type Format } from "./report.js";
import { buildTasks, runAll } from "./run.js";
import { scanConfig } from "./scan.js";

const USAGE = `git-drift — find code that never made it to GitHub, on your servers and your laptop

Usage:
  git-drift scan [dir...]      check every git repo under the dirs (default: .) against GitHub
       --ssh <host>               ...on a server instead of this machine (dirs are on the server)
       --depth <n>                how deep to look for repos (default 3)
  git-drift [options]          run every check in the config file
  git-drift init [file]        write an example config (default git-drift.config.json)

Options:
  -c, --config <file>      config file (default: git-drift.config.json)
  -f, --format <fmt>       stdout format: text | markdown | html | json (default: text)
  -o, --out <file>         also write a report; format from the extension (.md .html .json .txt). Repeatable.
      --only <name>        run only checks whose name contains <name>, or on host <name>. Repeatable.
  -q, --quiet              leave clean checks out of the report
      --concurrency <n>    checks to run at once (default 6)
  -h, --help | -v, --version

GitHub auth: GITHUB_TOKEN or GH_TOKEN, else the token from \`gh auth login\`.
Exit codes: 0 clean, 1 drift found, 2 a check could not run or the config is invalid.`;

interface Args {
  config: string;
  format: Format;
  outs: string[];
  only: string[];
  quiet: boolean;
  concurrency: number;
  init?: string;
  scan?: { roots: string[]; ssh?: string; depth?: number };
}

function parseArgs(argv: string[]): Args {
  const a: Args = { config: "git-drift.config.json", format: "text", outs: [], only: [], quiet: false, concurrency: 6 };
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
      case "--concurrency": a.concurrency = Math.max(1, Number(value(i++, arg)) || 6); break;
      case "-h": case "--help": console.log(USAGE); process.exit(0);
      case "-v": case "--version": {
        const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
        console.log(pkg.version);
        process.exit(0);
      }
      default:
        if (a.scan && !arg.startsWith("-")) { a.scan.roots.push(arg); break; }
        throw new ConfigError(`unknown argument "${arg}"\n\n${USAGE}`);
    }
  }
  return a;
}

async function init(path: string): Promise<void> {
  const target = expandHome(path);
  if (existsSync(target)) throw new ConfigError(`${path} already exists — not overwriting`);
  await copyFile(new URL("../../examples/git-drift.config.example.json", import.meta.url), target);
  console.log(`wrote ${path} — edit hosts and targets, then run: git-drift -c ${path}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.init) {
    await init(args.init);
    return 0;
  }
  if (!args.scan && args.config === "git-drift.config.json" && !existsSync(args.config)) {
    throw new ConfigError("no git-drift.config.json here.\n  Quick look at a folder of repos:  git-drift scan ~/code\n  Set up servers + repos:          git-drift init");
  }
  const config = args.scan ? scanConfig(args.scan.roots, args.scan) : await loadConfig(args.config);
  const token = findToken(config.github?.apiUrl);
  if (!token) console.error("warning: no GitHub token (set GITHUB_TOKEN or run `gh auth login`); private repos will fail");
  const gh = new GithubApi(token, config.github?.apiUrl);
  const tasks = buildTasks({ config, gh }, args.only);
  if (!tasks.length) throw new ConfigError("no checks matched");
  const results = await runAll(tasks, args.concurrency);
  const when = new Date();
  process.stdout.write(render(results, args.format, args.quiet, when));
  for (const out of args.outs) await writeFile(expandHome(out), render(results, formatFromPath(out), args.quiet, when));
  const c = counts(results);
  return c.error ? 2 : c.drift ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code; // not process.exit(): that can cut off a large piped report
  },
  (e) => {
    console.error(e instanceof ConfigError ? e.message : `git-drift: ${(e as Error).stack ?? e}`);
    process.exitCode = 2;
  },
);


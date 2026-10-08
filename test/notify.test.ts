// 0.4.0: email the report through PingPigeon, signing up from the terminal.
import assert from "node:assert/strict";
import { statSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fitEmail, loginPath, readLogin, sendReport, setupPigeon, type PigeonLogin } from "../src/notify.js";
import type { CheckResult } from "../src/types.js";
import { tempDir } from "./helpers.js";

interface Hit {
  method: string;
  path: string;
  auth?: string;
  ua?: string;
  body: Record<string, any>;
}

const hits: Hit[] = [];
let captcha = false;
let server: Server;
let url = "";

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c)).on("end", () => resolve(s));
  });

before(async () => {
  server = createServer(async (req, res) => {
    const body = JSON.parse((await read(req)) || "{}");
    hits.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, ua: req.headers["user-agent"], body });
    const send = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    const token = (req.headers.authorization ?? "").replace("Bearer ", "");
    if (req.url === "/signup") return captcha ? send(400, { ok: false, error: "captcha required" }) : send(200, { ok: true });
    if (req.url === "/verify-email") {
      return body.code === "123456"
        ? send(200, { ok: true, token: "pp_new", subscriber: { email: body.email, ntfy_topic: "pp-t", phone_verified: false } })
        : send(400, { ok: false, error: "invalid verification code" });
    }
    if (!token.startsWith("pp_")) return send(401, { ok: false, error: "invalid or missing subscriber token" });
    const who = token === "pp_old" ? "old@example.com" : "me@example.com";
    if (req.url === "/me") return send(200, { ok: true, subscriber: { email: who, plan: "free" }, usage: { plan: "free", email: { used: 3, quota: 200 } } });
    if (req.url === "/email") return send(200, { ok: true, id: "m1" });
    send(404, { ok: false, error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

function io(answers: string[], home: string) {
  const said: string[] = [];
  const asked: string[] = [];
  return {
    said,
    asked,
    io: {
      ask: async (q: string) => {
        asked.push(q);
        const a = answers.shift();
        if (a === undefined) throw new Error(`unexpected question: ${q}`);
        return a;
      },
      say: (l: string) => void said.push(l),
      home,
      env: {},
    },
  };
}

test("sign up from the terminal: code emailed, verified, login saved privately and labelled git-drift", async () => {
  hits.length = 0;
  const home = tempDir();
  const t = io(["me@example.com", "000000", "123 456"], home);
  const login = await setupPigeon(t.io, { url });
  assert.equal(login.token, "pp_new");
  assert.deepEqual(hits.find((h) => h.path === "/signup")!.body, { email: "me@example.com" });
  const verify = hits.filter((h) => h.path === "/verify-email");
  assert.equal(verify.length, 2, "a wrong code gets another try");
  assert.equal(verify[1].body.client, "git-drift");
  assert.equal(verify[1].body.code, "123456", "spaces in a typed code are ignored");
  assert.match(verify[1].ua ?? "", /^git-drift\//);
  assert.equal(statSync(loginPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(await readLogin({}, home), { url, token: "pp_new", email: "me@example.com", topic: "pp-t", phoneVerified: false });
  assert.ok(t.said.some((l) => /free service made by git-drift's author/.test(l)), "the setup says whose service it is");
  assert.ok(t.said.some((l) => /never file contents/.test(l)));
});

test("an existing working sign-in is reused without asking anything", async () => {
  hits.length = 0;
  const home = tempDir();
  mkdirSync(join(home, ".pingpigeon"));
  writeFileSync(loginPath(home), JSON.stringify({ url, token: "pp_old", email: "old@example.com" }));
  const t = io([], home);
  const login = await setupPigeon(t.io, { url });
  assert.equal(login.token, "pp_old");
  assert.equal(hits.some((h) => h.path === "/signup"), false);
  assert.match(t.said.at(-1)!, /Already signed in to PingPigeon: old@example.com · free plan · 3\/200 emails/);
});

test("signing in as someone else asks before replacing the saved sign-in", async () => {
  const home = tempDir();
  mkdirSync(join(home, ".pingpigeon"));
  writeFileSync(loginPath(home), JSON.stringify({ url, token: "pp_old", email: "old@example.com" }));
  await assert.rejects(setupPigeon(io(["n"], home).io, { url, email: "me@example.com" }), /kept the existing sign-in/);
  assert.equal((await readLogin({}, home))!.token, "pp_old");
});

test("--token signs in without a code; a captcha wall explains the token route", async () => {
  const home = tempDir();
  const login = await setupPigeon(io([], home).io, { url, token: "pp_web" });
  assert.equal(login.email, "me@example.com");
  captcha = true;
  try {
    await assert.rejects(setupPigeon(io(["x@example.com"], tempDir()).io, { url }), /captcha[\s\S]*--token <token>/);
  } finally {
    captcha = false;
  }
});

test("PINGPIGEON_TOKEN wins over the login file (CI)", async () => {
  assert.deepEqual(await readLogin({ PINGPIGEON_TOKEN: "pp_ci", PINGPIGEON_URL: "http://x" }, tempDir()), { url: "http://x", token: "pp_ci" });
  assert.equal(await readLogin({}, tempDir()), null);
});

test("the report email: headline subject, text + html bodies, bearer token", async () => {
  hits.length = 0;
  const results: CheckResult[] = [{ name: "api", type: "git", host: "web", status: "drift", summary: "1 uncommitted change", findings: [{ severity: "drift", code: "uncommitted", message: "1 uncommitted change" }], ms: 1 }];
  const login: PigeonLogin = { url, token: "pp_new" };
  await sendReport(login, results, true, new Date());
  const h = hits.find((x) => x.path === "/email")!;
  assert.equal(h.auth, "Bearer pp_new");
  assert.equal(h.body.subject, "git-drift: 1 drifted, 0 clean");
  assert.match(h.body.body, /✗ api \[web\] 1 uncommitted change/);
  assert.match(h.body.html, /<table/);
});

test("fitEmail: keeps both when they fit, drops html, then trims text under the budget", () => {
  assert.deepEqual(fitEmail("t", "<b>h</b>", 100), { body: "t", html: "<b>h</b>" });
  assert.deepEqual(fitEmail("short text", "x".repeat(200), 100), { body: "short text" });
  const long = Array.from({ length: 5000 }, (_, i) => `line ${i} ✗ some/path/file.ts`).join("\n");
  const fit = fitEmail(long, undefined, 20_000);
  assert.ok(Buffer.byteLength(fit.body) <= 20_000, String(Buffer.byteLength(fit.body)));
  assert.match(fit.body, /cut short to fit one email/);
  assert.equal(fit.html, undefined);
});

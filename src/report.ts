import { ageLabel, isNew, newChecks } from "./history.js";
import type { CheckResult, Finding, Status } from "./types.js";

export type Format = "text" | "markdown" | "html" | "json";

const ICON: Record<Status, string> = { ok: "✓", drift: "✗", error: "!" };

export function counts(results: CheckResult[]) {
  return {
    ok: results.filter((r) => r.status === "ok").length,
    drift: results.filter((r) => r.status === "drift").length,
    error: results.filter((r) => r.status === "error").length,
  };
}

/** Whether this run knows when problems were first seen (a state file was used). */
const tracked = (results: CheckResult[]) => results.some((r) => r.findings.some((f) => f.firstSeen));

export function headline(results: CheckResult[], when = new Date()): string {
  const c = counts(results);
  if (!c.drift && !c.error) return `all ${c.ok} checks clean`;
  const n = newChecks(results, when);
  const fresh = tracked(results) ? (n ? ` (${n} new)` : " (nothing new)") : "";
  return [c.drift && `${c.drift} drifted`, c.error && `${c.error} failed to run`, `${c.ok} clean`].filter(Boolean).join(", ") + fresh;
}

/** Problems first (new ones ahead of ones already reported), then clean checks; `quiet` drops the clean ones. */
function ordered(results: CheckResult[], quiet: boolean, when: Date): CheckResult[] {
  const rank: Record<Status, number> = { error: 0, drift: 1, ok: 2 };
  const fresh = (r: CheckResult) => (r.status !== "ok" && r.findings.some((f) => isNew(f, when)) ? 0 : 1);
  return results
    .filter((r) => !quiet || r.status !== "ok" || r.findings.length)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank[a.r.status] - rank[b.r.status] || fresh(a.r) - fresh(b.r) || a.i - b.i)
    .map(({ r }) => r);
}

/** " (new)" or " (since Oct 5 · day 3)" after a problem, when a state file is in use. */
function age(f: Finding, when: Date): string {
  const label = f.severity === "drift" ? ageLabel(f, when) : null;
  return label ? ` (${label})` : "";
}

/** Split fix lines into prose and runnable commands ("$ " prefix). */
function fixParts(fix: string[]): { cmd: boolean; text: string }[] {
  return fix.map((l) => (l.startsWith("$ ") ? { cmd: true, text: l.slice(2) } : { cmd: false, text: l }));
}

function text(results: CheckResult[], quiet: boolean, when: Date): string {
  const lines = [`git-drift — ${headline(results, when)}  (${when.toISOString().slice(0, 16).replace("T", " ")} UTC)`, ""];
  for (const r of ordered(results, quiet, when)) {
    lines.push(`${ICON[r.status]} ${r.name} [${r.host}] ${r.summary}`);
    for (const f of r.findings) {
      if (r.status !== "ok" || f.severity === "info") {
        lines.push(`    ${f.severity === "info" ? "·" : "•"} ${f.message}${age(f, when)}`);
        for (const item of f.items ?? []) lines.push(`        ${item}`);
        if (f.fix?.length && f.severity === "drift") {
          lines.push(`      → how to fix:`);
          for (const p of fixParts(f.fix)) lines.push(p.cmd ? `          $ ${p.text}` : `          ${p.text}`);
        }
      }
    }
  }
  return lines.join("\n") + "\n";
}

function markdown(results: CheckResult[], quiet: boolean, when: Date): string {
  const out = [
    `## git-drift: ${headline(results, when)}`,
    "",
    `_${when.toISOString().slice(0, 16).replace("T", " ")} UTC · ✗ needs action (each one says how to fix it) · ! couldn't check · notes never fail the run_`,
    "",
  ];
  const list = ordered(results, quiet, when);
  const problems = list.filter((r) => r.status !== "ok");
  if (problems.length) {
    out.push("### Needs attention", "");
    for (const r of problems) {
      out.push(`- **${ICON[r.status]} ${r.name}** \`${r.host}\` — ${r.summary}`);
      for (const f of r.findings) {
        out.push(`  - ${f.message}${age(f, when) && ` _${age(f, when).trim()}_`}`);
        if (f.items?.length) out.push("", "    ```", ...f.items.map((i) => "    " + i), "    ```", "");
        if (f.fix?.length && f.severity === "drift") {
          out.push("", "    **How to fix:**", "");
          let block: string[] = [];
          const flush = () => {
            if (block.length) out.push("    ```sh", ...block.map((c) => "    " + c), "    ```", "");
            block = [];
          };
          for (const p of fixParts(f.fix)) {
            if (p.cmd) block.push(p.text);
            else {
              flush();
              out.push(`    ${p.text}`, "");
            }
          }
          flush();
        }
      }
    }
    out.push("");
  }
  const clean = list.filter((r) => r.status === "ok");
  if (clean.length) {
    out.push("### Clean", "", "| Check | Host | Result |", "|---|---|---|");
    for (const r of clean) {
      const notes = r.findings.filter((f) => f.severity === "info").map((f) => f.message).join("; ");
      out.push(`| ${r.name} | ${r.host} | ${(r.summary + (notes && !r.summary.includes(notes) ? ` (${notes})` : "")).replace(/\|/g, "\\|")} |`);
    }
  }
  return out.join("\n") + "\n";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function html(results: CheckResult[], quiet: boolean, when: Date): string {
  const color: Record<Status, string> = { ok: "#1a7f37", drift: "#b35900", error: "#cf222e" };
  const rows = ordered(results, quiet, when)
    .map((r) => {
      const details = r.findings
        .filter((f) => r.status !== "ok" || f.severity === "info")
        .map((f) => {
          const items = f.items?.length ? `<pre style="margin:4px 0;font-size:12px;background:#f6f8fa;padding:6px;white-space:pre-wrap">${esc(f.items.join("\n"))}</pre>` : "";
          const fix =
            f.fix?.length && f.severity === "drift"
              ? `<div style="margin:6px 0 8px;padding:8px 10px;border-left:3px solid #0969da;background:#f0f6ff"><div style="font-weight:600;margin-bottom:4px">How to fix</div>${fixParts(f.fix)
                  .map((p) => (p.cmd ? `<pre style="margin:4px 0;font-size:12px;background:#fff;border:1px solid #d0d7de;padding:6px;white-space:pre-wrap;word-break:break-all">${esc(p.text)}</pre>` : `<div style="margin:2px 0">${esc(p.text)}</div>`))
                  .join("")}</div>`
              : "";
          const label = age(f, when) && `<span style="color:${isNew(f, when) ? "#cf222e" : "#666"};font-size:12px">${esc(age(f, when))}</span>`;
          return `<div style="margin:4px 0 0 0">${esc(f.message)}${label}${items}${fix}</div>`;
        })
        .join("");
      return `<tr><td style="padding:6px;vertical-align:top;color:${color[r.status]};font-weight:600">${ICON[r.status]}</td><td style="padding:6px;vertical-align:top"><b>${esc(r.name)}</b> <span style="color:#666">${esc(r.host)}</span><div>${esc(r.summary)}</div>${details}</td></tr>`;
    })
    .join("");
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px"><h2 style="margin:0 0 4px">git-drift: ${esc(headline(results, when))}</h2><p style="color:#666;margin:0 0 12px">${when.toISOString().slice(0, 16).replace("T", " ")} UTC · ✗ needs action (each one says how to fix it) · ! couldn't check · notes never fail the run</p><table style="border-collapse:collapse">${rows}</table></div>\n`;
}

export function render(results: CheckResult[], format: Format, quiet = false, when = new Date()): string {
  switch (format) {
    case "json": {
      const summary = tracked(results) ? { ...counts(results), new: newChecks(results, when) } : counts(results);
      return JSON.stringify({ generatedAt: when.toISOString(), summary, results }, null, 2) + "\n";
    }
    case "markdown": return markdown(results, quiet, when);
    case "html": return html(results, quiet, when);
    default: return text(results, quiet, when);
  }
}

export function formatFromPath(path: string): Format {
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".html") || path.endsWith(".htm")) return "html";
  return "text";
}

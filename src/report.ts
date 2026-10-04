import type { CheckResult, Status } from "./types.js";

export type Format = "text" | "markdown" | "html" | "json";

const ICON: Record<Status, string> = { ok: "✓", drift: "✗", error: "!" };

export function counts(results: CheckResult[]) {
  return {
    ok: results.filter((r) => r.status === "ok").length,
    drift: results.filter((r) => r.status === "drift").length,
    error: results.filter((r) => r.status === "error").length,
  };
}

export function headline(results: CheckResult[]): string {
  const c = counts(results);
  if (!c.drift && !c.error) return `all ${c.ok} checks clean`;
  return [c.drift && `${c.drift} drifted`, c.error && `${c.error} failed to run`, `${c.ok} clean`].filter(Boolean).join(", ");
}

/** Problems first, then clean checks; `quiet` drops the clean ones. */
function ordered(results: CheckResult[], quiet: boolean): CheckResult[] {
  const rank: Record<Status, number> = { error: 0, drift: 1, ok: 2 };
  return results
    .filter((r) => !quiet || r.status !== "ok" || r.findings.length)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => rank[a.r.status] - rank[b.r.status] || a.i - b.i)
    .map(({ r }) => r);
}

function text(results: CheckResult[], quiet: boolean, when: Date): string {
  const lines = [`git-drift — ${headline(results)}  (${when.toISOString().slice(0, 16).replace("T", " ")} UTC)`, ""];
  for (const r of ordered(results, quiet)) {
    lines.push(`${ICON[r.status]} ${r.name} [${r.host}] ${r.summary}`);
    for (const f of r.findings) {
      if (r.status !== "ok" || f.severity === "info") {
        lines.push(`    ${f.severity === "info" ? "·" : "•"} ${f.message}`);
        for (const item of f.items ?? []) lines.push(`        ${item}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

function markdown(results: CheckResult[], quiet: boolean, when: Date): string {
  const out = [`## git-drift: ${headline(results)}`, "", `_${when.toISOString().slice(0, 16).replace("T", " ")} UTC_`, ""];
  const list = ordered(results, quiet);
  const problems = list.filter((r) => r.status !== "ok");
  if (problems.length) {
    out.push("### Needs attention", "");
    for (const r of problems) {
      out.push(`- **${ICON[r.status]} ${r.name}** \`${r.host}\` — ${r.summary}`);
      for (const f of r.findings) {
        out.push(`  - ${f.message}`);
        if (f.items?.length) out.push("", "    ```", ...f.items.map((i) => "    " + i), "    ```", "");
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
  const rows = ordered(results, quiet)
    .map((r) => {
      const details = r.findings
        .filter((f) => r.status !== "ok" || f.severity === "info")
        .map((f) => `<div style="margin:4px 0 0 0">${esc(f.message)}${f.items?.length ? `<pre style="margin:4px 0;font-size:12px;background:#f6f8fa;padding:6px;white-space:pre-wrap">${esc(f.items.join("\n"))}</pre>` : ""}</div>`)
        .join("");
      return `<tr><td style="padding:6px;vertical-align:top;color:${color[r.status]};font-weight:600">${ICON[r.status]}</td><td style="padding:6px;vertical-align:top"><b>${esc(r.name)}</b> <span style="color:#666">${esc(r.host)}</span><div>${esc(r.summary)}</div>${details}</td></tr>`;
    })
    .join("");
  return `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px"><h2 style="margin:0 0 4px">git-drift: ${esc(headline(results))}</h2><p style="color:#666;margin:0 0 12px">${when.toISOString().slice(0, 16).replace("T", " ")} UTC</p><table style="border-collapse:collapse">${rows}</table></div>\n`;
}

export function render(results: CheckResult[], format: Format, quiet = false, when = new Date()): string {
  switch (format) {
    case "json": return JSON.stringify({ generatedAt: when.toISOString(), summary: counts(results), results }, null, 2) + "\n";
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

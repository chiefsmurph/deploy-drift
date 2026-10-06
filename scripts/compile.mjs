// Standalone executables (no Node.js needed) for each platform, via `bun build --compile`.
// Output: dist-bin/git-drift-<os>-<arch>.tar.gz (each holds one `git-drift` file) + checksums.txt.
// BUN="<command>" picks bun (default: bun). Pass platform names to build only some.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const TARGETS = [
  ["darwin-arm64", "bun-darwin-arm64"],
  ["darwin-x64", "bun-darwin-x64"],
  ["linux-x64", "bun-linux-x64-baseline"], // baseline: runs on older x86-64 CPUs (no AVX2) too
  ["linux-arm64", "bun-linux-arm64"],
];
const only = process.argv.slice(2);
const bun = (process.env.BUN ?? "bun").split(" ");
const out = new URL("../dist-bin/", import.meta.url).pathname;
rmSync(out, { recursive: true, force: true });
const sums = [];
for (const [name, target] of TARGETS.filter(([n]) => !only.length || only.includes(n))) {
  const dir = `${out}${name}/`;
  mkdirSync(dir, { recursive: true });
  execFileSync(bun[0], [...bun.slice(1), "build", "./src/cli.ts", "--compile", "--minify", `--target=${target}`, "--outfile", `${dir}git-drift`], { stdio: "inherit" });
  // Apple Silicon refuses to run unsigned code: give macOS builds an ad-hoc signature (needs a macOS host).
  if (name.startsWith("darwin")) {
    if (process.platform === "darwin") execFileSync("codesign", ["--force", "--sign", "-", `${dir}git-drift`]);
    else console.warn(`warning: ${name} built off macOS is unsigned; build releases on macOS`);
  }
  const tgz = `git-drift-${name}.tar.gz`;
  execFileSync("tar", ["-czf", `${out}${tgz}`, "-C", dir, "git-drift"]);
  sums.push(`${createHash("sha256").update(readFileSync(`${out}${tgz}`)).digest("hex")}  ${tgz}`);
}
writeFileSync(`${out}checksums.txt`, sums.join("\n") + "\n");
console.log(`built ${sums.length} archives in dist-bin/`);

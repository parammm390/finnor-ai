#!/usr/bin/env node
import { existsSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const gitRoot = realpathSync(execFileSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
if (gitRoot !== repoRoot) throw new Error("Refusing cleanup: script is not inside the Git worktree root.");

const apply = process.argv.includes("--apply");
const deep = process.argv.includes("--deep");
const targets = [
  ".next",
  "finnor-os/.next",
  "playwright-report",
  "test-results",
  "coverage",
];
if (deep) targets.push("node_modules", "finnor-os/node_modules");

for (const target of targets) {
  const path = resolve(repoRoot, target);
  if (path !== repoRoot && !path.startsWith(repoRoot + sep)) throw new Error("Refusing cleanup path outside repository: " + target);
  if (!existsSync(path)) continue;
  console.log((apply ? "remove " : "would remove ") + target);
  if (apply) rmSync(path, { recursive: true, force: true });
}

if (!apply) console.log("Dry run only. Pass --apply to remove generated caches.");

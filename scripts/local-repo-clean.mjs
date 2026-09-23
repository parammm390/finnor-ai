#!/usr/bin/env node
import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const deep = process.argv.includes("--deep");
const targets = [
  ".codex-release-recovery",
  ".next",
  "finnor-os/.next",
  "evidence",
  "qa-screenshots",
  "playwright-report",
  "test-results",
  "coverage",
];
if (deep) targets.push("node_modules", "finnor-os/node_modules");

for (const target of targets) {
  if (!existsSync(target)) continue;
  console.log(`remove ${target}`);
  rmSync(target, { recursive: true, force: true });
}

const gc = spawnSync("git", ["gc"], { stdio: "inherit" });
if (gc.status !== 0) process.exit(gc.status ?? 1);

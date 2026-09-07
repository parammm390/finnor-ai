import { execFileSync } from "node:child_process"

export function worktreeStatus(repoRoot = process.cwd()) {
  // Unlike diff-files, status refreshes cached stat information before deciding
  // whether content changed. Normal mode reports untracked directories without
  // recursively expanding their contents (including large local evidence trees).
  return execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: repoRoot, encoding: "utf8",
  }).trim()
}

import { execFileSync } from "node:child_process"

export function readGit(args, repoRoot = process.cwd(), { timeoutMs = 30_000 } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) throw new Error("Git read deadline must be within 30 seconds")
  try {
    return execFileSync("git", args, {
      cwd: repoRoot, encoding: "utf8", timeout: timeoutMs,
      killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    })
  } catch (error) {
    // Do not repeat complete argv, remote URLs, credential-helper output or the
    // original error object in release logs: those can contain credentials.
    const timedOut = error.code === "ETIMEDOUT"
    throw Object.assign(new Error(`Git ${args[0]} ${timedOut ? `exceeded ${timeoutMs}ms` : `failed (exit ${error.status ?? error.code ?? "unknown"})`}`), { code: error.code, timedOut })
  }
}

export function worktreeStatus(repoRoot = process.cwd()) {
  // Unlike diff-files, status refreshes cached stat information before deciding
  // whether content changed. Normal mode reports untracked directories without
  // recursively expanding their contents (including large local evidence trees).
  return readGit(["status", "--porcelain=v1", "--untracked-files=normal"], repoRoot).trim()
}

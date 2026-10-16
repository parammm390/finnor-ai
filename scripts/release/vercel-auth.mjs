import { spawnSync } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Vercel 50.15.1 checks its auth file before consuming VERCEL_TOKEN. Use its
// supported global-config boundary, never a token-valued OS argument. This
// directory is separate from pulled configuration and gone before any build.
export function runAuthenticatedVercel(args, { cwd, env = process.env, timeout } = {}) {
  const token = env.VERCEL_TOKEN?.trim()
  if (!token) throw new Error("VERCEL_TOKEN is required for authenticated Vercel CLI access")
  if (args.some(arg => arg === "--" || /^(?:--(?:token|global-config)(?:=|$)|-t|-Q)/.test(arg))) throw new Error("Caller-supplied CLI authentication is forbidden")
  const privateConfig = mkdtempSync(join(tmpdir(), "finnor-vercel-auth-"))
  const cleanup = () => rmSync(privateConfig, { recursive: true, force: true })
  process.once("exit", cleanup)
  try {
    chmodSync(privateConfig, 0o700)
    writeFileSync(join(privateConfig, "auth.json"), JSON.stringify({ token }), { mode: 0o600, flag: "wx" })
    const childEnv = { VERCEL_TELEMETRY_DISABLED: "1" }
    for (const name of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SystemRoot", "LANG", "LC_ALL", "CI", "NO_COLOR", "FORCE_COLOR", "VERCEL_ORG_ID", "VERCEL_PROJECT_ID"]) {
      if (env[name] !== undefined) childEnv[name] = env[name]
    }
    const result = spawnSync("vercel", [...args, "--global-config", privateConfig], {
      cwd, env: childEnv, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      ...(timeout === undefined ? {} : { timeout, killSignal: "SIGKILL" }),
    })
    for (const field of ["stdout", "stderr"]) if (typeof result[field] === "string") result[field] = result[field].replaceAll(token, "[REDACTED]")
    return result
  } finally {
    process.removeListener("exit", cleanup)
    cleanup()
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2)
  if (args[0] === "verify-release-access" && args.length === 1) {
    const contract = JSON.parse(readFileSync(new URL("../../infra/deployment/production.contract.json", import.meta.url), "utf8"))
    for (const component of ["identity", "frontend", "api", "supplierCanaryApp", "supplierCanaryAuth"]) {
      const target = contract.topology[component]
      const command = target ? ["project", "inspect", target.projectId, "--scope", target.organizationId] : ["whoami"]
      const result = runAuthenticatedVercel(command, { cwd: process.cwd(), timeout: 60_000 })
      if (result.stdout) process.stdout.write(result.stdout)
      if (result.stderr) process.stderr.write(result.stderr)
      if (result.error) console.error(result.error.message)
      if (result.status !== 0) { process.exitCode = result.status ?? 1; break }
      console.log(`Vercel CLI read-only access verified: ${component}`)
    }
  } else {
    // This entry point cannot become an alternate production deployer.
    if (!["whoami", "pull"].includes(args[0]) && !(args[0] === "project" && args[1] === "inspect")) throw new Error("Standalone Vercel authentication is restricted to read-only commands")
    const result = runAuthenticatedVercel(args, { cwd: process.cwd(), timeout: 120_000 })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.error) console.error(result.error.message)
    process.exitCode = result.status ?? 1
  }
}

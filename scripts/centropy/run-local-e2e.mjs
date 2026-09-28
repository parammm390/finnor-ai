import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { resolve } from "node:path"

// Owner credentials remain local and are never written to the proof artifact.
const root = resolve(import.meta.dirname, "../..")
const require = createRequire(`${root}/finnor-os/package.json`)
const { parse } = require("dotenv")
const local = parse(readFileSync(`${root}/.env.local`))
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3001"
if (!["localhost", "127.0.0.1"].includes(new URL(baseURL).hostname)) throw new Error("Local certification requires a loopback target")
if (!local.TEST_OWNER_EMAIL || !local.TEST_OWNER_PASSWORD) throw new Error("Configure the real test owner in .env.local")
const child = spawn(process.execPath, [`${root}/node_modules/@playwright/test/cli.js`, "test", ...process.argv.slice(2)], {
  cwd: root,
  env: { ...process.env, TEST_OWNER_EMAIL: local.TEST_OWNER_EMAIL, TEST_OWNER_PASSWORD: local.TEST_OWNER_PASSWORD,
    CENTROPY_DISPOSABLE_E2E: "1", PLAYWRIGHT_BASE_URL: baseURL },
  stdio: "inherit",
})
child.on("error", (error) => { console.error(error.message); process.exitCode = 1 })
child.on("exit", (code) => { process.exitCode = code ?? 1 })
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal))

import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { spawn } from "node:child_process"
import { resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")
const sha = process.argv[2]
if (!/^[0-9a-f]{40}$/.test(sha ?? "")) throw new Error("Supply the independently verified released commit SHA")
const contract = JSON.parse(readFileSync(`${root}/infra/deployment/production.contract.json`, "utf8"))
const { parse } = createRequire(`${root}/finnor-os/package.json`)("dotenv")
const local = parse(readFileSync(`${root}/.env.local`))
if (local.TEST_OWNER_EMAIL !== "owner@test-dealer.finnor.local" || !local.TEST_OWNER_PASSWORD) throw new Error("Configure the requested real test owner locally")
const child = spawn(process.execPath, [`${root}/node_modules/@playwright/test/cli.js`, "test", "e2e/centropy-live-host.spec.ts", "--project=desktop-chromium", "--workers=1"], {
  cwd: root,
  env: { ...process.env, TEST_OWNER_EMAIL: local.TEST_OWNER_EMAIL, TEST_OWNER_PASSWORD: local.TEST_OWNER_PASSWORD,
    CENTROPY_LIVE_CERTIFICATION: "1", CENTROPY_DISPOSABLE_E2E: "0", CENTROPY_EXPECTED_RELEASE_SHA: sha,
    PLAYWRIGHT_BASE_URL: contract.topology.frontend.productionUrl, CENTROPY_LIVE_API_URL: contract.topology.api.productionUrl,
    PLAYWRIGHT_OUTPUT_DIR: `test-results/live-host-${sha.slice(0, 12)}` },
  stdio: "inherit",
})
child.on("error", (error) => { console.error(error.message); process.exitCode = 1 })
child.on("exit", (code) => { process.exitCode = code ?? 1 })
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal))

// Reproduce the compiled API boundary: Next substitutes NODE_ENV at build time.
// Runtime test profiles must still work, production must refuse disposable mode,
// and neither profile may grant protected execution.
import assert from "node:assert/strict"
import test from "node:test"
import { createRequire } from "node:module"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const { buildSync } = createRequire(join(root, "finnor-os/package.json"))("esbuild")

test("compiled analytical capabilities use the running process and retain production refusals", () => {
  const directory = mkdtempSync(join(tmpdir(), "finnor-analytical-profile-"))
  const source = join(root, "finnor-os/packages/private-equity/src/evidence-execution/profile.ts")
  const emitted = join(directory, "profile.mjs")
  buildSync({ entryPoints: [source], outfile: emitted, bundle: true, platform: "node", format: "esm",
    define: { "process.env.NODE_ENV": JSON.stringify("production") } })
  const scenarios = [
    { node: "test", environment: "development", profile: "ordinary_disposable", expected: "ordinary_disposable" },
    { node: "production", environment: "development", profile: "ordinary_disposable", expected: null },
    { node: "test", environment: "production", profile: "ordinary_disposable", expected: null },
    { node: "production", environment: "production", profile: "production_analysis", expected: "production_analysis" },
    { node: "test", environment: "development", profile: "", expected: null },
  ]
  const results = []
  for (const scenario of scenarios) {
    const script = `
      const module = await import(${JSON.stringify(pathToFileURL(emitted).href)});
      let protectedRefusal;
      try { module.assertAnalyticalExecutionProfile("protected"); }
      catch (error) { protectedRefusal = error.message; }
      console.log(JSON.stringify({capabilities: module.analyticalExecutionCapabilities(), protectedRefusal}));
    `
    const observed = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { NODE_ENV: scenario.node, FINNOR_ENVIRONMENT: scenario.environment, FINNOR_P4_PROFILE: scenario.profile }, encoding: "utf8",
    }))
    results.push({ scenario, observed })
  }
  const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex")
  writeFileSync(join(directory, "receipt.json"), JSON.stringify({ source, sourceSha256: hash(source), emittedSha256: hash(emitted),
    node: process.version, results, rerun: "node --test scripts/release/analytical-profile.e2e.test.mjs" }, null, 2))
  for (const { scenario, observed } of results) {
    assert.equal(observed.capabilities.mode, scenario.expected, JSON.stringify({ scenario, observed, directory }))
    assert.equal(observed.capabilities.effectAuthority, false)
    assert.equal(observed.capabilities.protectedExecution, false)
    assert.equal(observed.protectedRefusal, "PROTECTED_FUNDING_ADMISSION_AND_RUNTIME_BINDINGS_UNAVAILABLE")
  }
})

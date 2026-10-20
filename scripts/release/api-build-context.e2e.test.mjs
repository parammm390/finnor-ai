// Real source projection and stamp processes, not a mocked Vercel builder.
import assert from "node:assert/strict"
import test from "node:test"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { apiBuildContext } from "./vercel-build-context.mjs"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const loader = createRequire(join(root, "finnor-os/package.json")).resolve("tsx")
const owners = [
  ["enterprise-applications", "APPLICATION_SOURCE_PATHS", "currentApplicationEnvironment"],
  ["policy-learning", "LEARNING_SOURCE_PATHS", "currentLearningEnvironment"],
  ["system-identification", "IDENTIFICATION_SOURCE_PATHS", "currentIdentificationEnvironment"],
]
const hash = bytes => createHash("sha256").update(bytes).digest("hex")

test("isolated API context retains exact native source cuts and refuses changed or substituted inputs", () => {
  const evidence = process.env.FINNOR_API_CONTEXT_EVIDENCE_DIR || mkdtempSync(join(tmpdir(), "finnor-api-context-evidence-"))
  assert.ok(isAbsolute(evidence))
  mkdirSync(evidence, { recursive: true })
  const receiptPath = join(evidence, "receipt.json")
  assert.ok(!existsSync(receiptPath), "Refusing to overwrite an attempt")
  const receipt = {
    schema: "finnor.api-build-context-e2e.v1", status: "FAIL", node: process.version,
    startedAt: new Date().toISOString(), driverSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    commands: [], probes: [], emittedDependencyProof: false, deploymentProof: false,
    rerun: "FINNOR_API_CONTEXT_EVIDENCE_DIR=/absolute/new/evidence node --test scripts/release/api-build-context.e2e.test.mjs",
  }
  const contexts = []
  const run = (cwd, args, name, success = true) => {
    const result = spawnSync(process.execPath, ["--import", loader, ...args], {
      cwd, encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
    })
    const log = (result.stdout || "") + (result.stderr || "")
    writeFileSync(join(evidence, `${name}.log`), log, { flag: "wx", mode: 0o600 })
    receipt.commands.push({ name, args, exitCode: result.status, logSha256: hash(log) })
    if (success) assert.equal(result.status, 0, log)
    else assert.ok(Number.isInteger(result.status) && result.status !== 0, log)
    return result
  }
  try {
    const list = owners.map(([owner, paths]) =>
      `result[${JSON.stringify(owner)}]=(await import(${JSON.stringify(pathToFileURL(join(root, "finnor-os/packages/private-equity/src", owner, "source-paths.ts")).href)})).${paths};`).join("\n")
    const declarations = JSON.parse(run(root, ["--input-type=module", "-e", `const result={};${list}console.log(JSON.stringify(result));`], "source-declarations").stdout)
    const paths = [...new Set(Object.values(declarations).flat())].sort()
    const original = paths.map(path => ({ path, sha256: hash(readFileSync(join(root, path))) }))
    const context = apiBuildContext(root)
    contexts.push(context)
    assert.deepEqual(paths.map(path => ({ path, sha256: hash(readFileSync(join(context.directory, path))) })), original)
    receipt.probes.push({ exactOriginalFiles: original })

    const markers = [".env.local", "finnor-os/.env.test", "finnor-os/node_modules/fixture-marker.txt",
      "finnor-os/evidence/fixture-marker.txt", "src/components/centropy/canvas/.env.local"]
    for (const path of markers) {
      mkdirSync(dirname(join(context.directory, path)), { recursive: true })
      writeFileSync(join(context.directory, path), "synthetic exclusion marker, not a credential\n")
    }
    const projected = apiBuildContext(context.directory)
    contexts.push(projected)
    for (const path of markers) assert.equal(existsSync(join(projected.directory, path)), false, path)
    receipt.probes.push({ excludedSyntheticMarkers: markers })
    // This narrow projection check borrows locked build dependencies. Only the
    // separate real Vercel/emitted-function E2E proves installed dependencies.
    symlinkSync(join(root, "finnor-os/node_modules"), join(projected.directory, "finnor-os/node_modules"), "dir")
    for (const owner of ["x3", "x5", "x4"]) {
      run(join(projected.directory, "finnor-os"), [`scripts/${owner}/stamp-source.mts`], `${owner}-stamp`)
    }
    const checks = owners.map(([owner, , verify]) =>
      `result[${JSON.stringify(owner)}]=(await (await import(${JSON.stringify(pathToFileURL(join(projected.directory, "finnor-os/packages/private-equity/src", owner, "source-cut.ts")).href)})).${verify}()).files.length;`).join("\n")
    const environments = run(join(projected.directory, "finnor-os"), ["--input-type=module", "-e",
      `const result={};${checks}console.log(JSON.stringify(result));`], "canonical-environments")
    assert.deepEqual(JSON.parse(environments.stdout), Object.fromEntries(Object.entries(declarations).map(([owner, files]) => [owner, files.length])))
    receipt.probes.push({ stampedEnvironments: JSON.parse(environments.stdout), buildDependenciesFromOriginalCheckout: true })

    const client = "src/components/centropy/canvas/application-client.ts"
    writeFileSync(join(projected.directory, client), "// changed fixture input\n", { flag: "a" })
    const changed = run(join(projected.directory, "finnor-os"), ["scripts/x3/stamp-source.mts", "--check"], "changed-source-refusal", false)
    assert.match(changed.stderr, /X3_SOURCE_STAMP_STALE/)
    unlinkSync(join(context.directory, client))
    assert.throws(() => apiBuildContext(context.directory), /ENOENT/)
    symlinkSync(join(root, client), join(context.directory, client))
    assert.throws(() => apiBuildContext(context.directory), /API_CONTEXT_SOURCE_NOT_REGULAR|API_CONTEXT_SOURCE_ESCAPES_ROOT/)
    receipt.probes.push({ changedSourceRefused: true, missingSourceRefused: true, symlinkSubstitutionRefused: true })
    assert.deepEqual(paths.map(path => ({ path, sha256: hash(readFileSync(join(root, path))) })), original)
    receipt.status = "PASS"
  } catch (error) {
    receipt.failure = error.message
    throw error
  } finally {
    for (const context of contexts.reverse()) context.cleanup()
    receipt.finishedAt = new Date().toISOString()
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  }
})

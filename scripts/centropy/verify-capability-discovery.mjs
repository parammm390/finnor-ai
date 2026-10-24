import assert from "node:assert/strict"
import { spawnSync, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"

const project = resolve(import.meta.dirname, "../..")
if (process.argv.length !== 4 || process.argv[2] !== "--evidence-dir" || !isAbsolute(process.argv[3]))
  throw new Error("Usage: node scripts/centropy/verify-capability-discovery.mjs --evidence-dir /absolute/directory")
assert.equal(process.versions.node.split(".")[0], "22", "Use the repository's Node 22 toolchain")
mkdirSync(process.argv[3], { recursive: true })
const directory = mkdtempSync(join(process.argv[3], "run-"))
const checkout = join(directory, "checkout")
mkdirSync(checkout)
const hash = value => createHash("sha256").update(value).digest("hex")
const read = path => readFileSync(join(checkout, path), "utf8")
const save = (path, value) => {
  const target = join(directory, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n")
}
const report = {
  schema: "finnor.capability-discovery-cli-contract/v1",
  startedAt: new Date().toISOString(), node: process.version,
  sourceBaseCommit: execFileSync("git", ["-C", project, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  source: project, snapshot: checkout,
  qualification: "Real generator/auditor CLI source-contract E2E only. Borrowed installed third-party dependencies and parent Git metadata, not a cold install, HTTP flow, product qualification or phase completion.",
  rerun: `${process.execPath} ${join(project, "scripts/centropy/verify-capability-discovery.mjs")} --evidence-dir ${process.argv[3]}`,
  environment: { inheritedNames: ["PATH"], syntheticNames: ["NODE_ENV", "NODE_OPTIONS", "TSX_DISABLE_CACHE"] },
  cases: [], commands: [], result: "RUNNING",
}
const flush = () => save("report.json", report)
flush()

const roots = ["src", "scripts/centropy", "finnor-os", "e2e", "docs/centropy", "package.json", "package-lock.json", "tsconfig.json", "next-env.d.ts"]
const files = execFileSync("git", ["-C", project, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...roots], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }).split("\0").filter(Boolean).sort()
const inventory = []
for (const file of files) {
  const original = join(project, file), target = join(checkout, file)
  assert(lstatSync(original).isFile(), `Snapshot accepts regular source files only: ${file}`)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(original, target)
  const bytes = readFileSync(target)
  inventory.push({ file, bytes: bytes.length, sha256: hash(bytes) })
}
save("source-inventory.json", inventory)
report.sourceInventorySha256 = hash(readFileSync(join(directory, "source-inventory.json")))

// Reusing the entire backend node_modules symlink would resolve @finnor
// packages into the parent's source and invalidate source-mutation controls.
for (const prefix of ["", "finnor-os"]) {
  const installed = join(project, prefix, "node_modules"), target = join(checkout, prefix, "node_modules")
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(installed, { withFileTypes: true })) {
    if (entry.name !== "@finnor") {
      symlinkSync(join(installed, entry.name), join(target, entry.name))
      continue
    }
    mkdirSync(join(target, "@finnor"))
    for (const workspace of readdirSync(join(installed, "@finnor"))) {
      const original = join(installed, "@finnor", workspace)
      const packageJson = JSON.parse(readFileSync(join(original, "package.json"), "utf8"))
      const owner = inventory.find(row => row.file.endsWith("/package.json") &&
        JSON.parse(readFileSync(join(checkout, row.file), "utf8")).name === packageJson.name)
      assert(owner, `Missing snapshot workspace ${packageJson.name}`)
      symlinkSync(join(checkout, dirname(owner.file)), join(target, "@finnor", workspace))
    }
  }
}

const cleanEnv = mode => ({
  PATH: process.env.PATH, NODE_ENV: mode, NODE_OPTIONS: "--max-old-space-size=4096", TSX_DISABLE_CACHE: "1",
})
function command(label, file, args = [], mode = "production", extraEnv = {}) {
  const result = spawnSync(process.execPath, [file, ...args], {
    cwd: checkout, env: { ...cleanEnv(mode), ...extraEnv }, encoding: "utf8",
    timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
  })
  const output = { label, executable: process.execPath, arguments: [file, ...args], mode,
    status: result.status, signal: result.signal, error: result.error?.message ?? null }
  const index = report.commands.length
  save(`commands/${index}.stdout.log`, result.stdout ?? "")
  save(`commands/${index}.stderr.log`, result.stderr ?? "")
  report.commands.push({ ...output, stdout: `commands/${index}.stdout.log`, stderr: `commands/${index}.stderr.log` })
  flush()
  return { ...output, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
}
function ok(result) {
  assert.equal(result.error, null, `${result.label}: ${result.error}`)
  assert.equal(result.status, 0, `${result.label}: ${result.stderr}`)
}
function check(name, action) {
  try { action(); report.cases.push({ name, result: "PASS" }) }
  catch (error) { report.cases.push({ name, result: "FAIL", error: error.message }) }
  flush()
}

// This oracle calls the source owner directly. It neither imports the generator
// nor uses its new helper/projection as the expected result.
const oracle = String.raw`
const {createRequire, syncBuiltinESMExports} = require("node:module");
const req = createRequire(process.cwd() + "/finnor-os/package.json");
process.chdir(process.cwd() + "/finnor-os");
const attempts = [];
const deny = name => (...args) => {
  const error = new Error("ORACLE_NETWORK_DENIED:" + name);
  const loaderIPC = name === "net.createConnection" && typeof args[0] === "string" &&
    args[0].endsWith("/" + process.ppid + ".pipe") && error.stack.includes("/node_modules/tsx/dist/client-");
  attempts.push({name, loaderIPC, stack:error.stack});
  throw error;
};
for (const [name, methods] of Object.entries({
  http:["request","get"], https:["request","get"], net:["connect","createConnection"],
  tls:["connect"], dns:["lookup","resolve","resolve4","resolve6"],
  dgram:["createSocket"]
})) {
  const api = require("node:" + name);
  for (const method of methods) api[method] = deny(name + "." + method);
}
require("node:net").Socket.prototype.connect = deny("Socket.connect");
for (const method of ["lookup","resolve","resolve4","resolve6"])
  require("node:dns").promises[method] = deny("dns.promises." + method);
globalThis.fetch = deny("fetch");
syncBuiltinESMExports();
req("tsx/cjs/api").register();
const loaderAttempts = attempts.splice(0);
if (loaderAttempts.some(attempt => !attempt.loaderIPC)) throw new Error("Unexpected TS loader network attempt");
const owner = req("./packages/orchestration/src/plugin-registry.ts");
const shared = req("@finnor/shared-types");
const original = owner.PluginRegistry.prototype.register;
let actionCalls = 0;
owner.PluginRegistry.prototype.register = function(plugin) {
  plugin.execute = () => { actionCalls++; throw new Error("ORACLE_ACTION_EXECUTION_DENIED"); };
  return original.call(this, plugin);
};
const entries = owner.planningCapabilitiesForVertical(owner.createDefaultPluginRegistry(), shared.PRIVATE_EQUITY_VERTICAL);
if (attempts.length || actionCalls) throw new Error("Oracle observed forbidden effect attempts: " + JSON.stringify({attempts, actionCalls}));
process.stdout.write(JSON.stringify({
  entries, humanOnly: [...owner.HUMAN_ONLY_PLANNING_CAPABILITIES], attempts, loaderAttempts, actionCalls,
  workspaceSources: Object.keys(require.cache).filter(path => /\/finnor-os\/(?:packages|apps)\//.test(path)),
  registrySource: req.resolve("./packages/orchestration/src/plugin-registry.ts"),
  sharedSource: req.resolve("@finnor/shared-types")
}));
`
save("oracle.cjs", oracle)
const oracleFile = join(directory, "oracle.cjs")
const generator = join(checkout, "scripts/centropy/generate-capability-manifest.mjs")
const auditor = join(checkout, "scripts/centropy/audit-capability-coverage.mjs")
const manifestFile = "src/lib/centropy/capability-manifest.generated.json"
const registryFile = "finnor-os/packages/orchestration/src/plugin-registry.ts"
const queryFile = "finnor-os/packages/shared-types/src/operational-queries.ts"
function observe(mode) {
  const result = command(`direct canonical registry (${mode})`, oracleFile, [], mode)
  ok(result)
  const value = JSON.parse(result.stdout)
  assert(value.entries.length > 0)
  assert(value.workspaceSources.length > 0)
  for (const path of [...value.workspaceSources, value.registrySource, value.sharedSource])
    assert(path.startsWith(checkout + "/"), `Oracle escaped snapshot product source: ${path}`)
  save(`canonical-${mode}-${report.commands.length}.json`, value)
  return value
}
const plannerRows = document => document.capabilities.filter(row => row.transport === "planner")
const kind = { action: "mutation", query: "read", wait: "wait", check: "check" }
function parity(snapshot, document) {
  const rows = plannerRows(document)
  assert.deepEqual(rows.map(row => row.capabilityId).sort(), snapshot.entries.map(row => `planner.${row.capability}`).sort(), "Complete canonical planner identities differ")
  for (const entry of snapshot.entries) {
    const row = rows.find(candidate => candidate.capabilityId === `planner.${entry.capability}`)
    assert.deepEqual(row.planning, entry, `Full planning metadata: ${entry.capability}`)
    assert.deepEqual(row.requiredContext, entry.requiredReferences, `Required references: ${entry.capability}`)
    assert.equal(row.kind, kind[entry.kind], `Kind: ${entry.capability}`)
    assert.equal(row.classification, entry.kind === "query" ? "READ" : entry.kind === "action" ? "MUTATION" : "CONTROL")
    assert.equal(row.modelCallable, entry.modelProposable)
    assert.equal(row.agentProduct, entry.modelProposable && entry.available)
    assert.equal(row.humanOnly, snapshot.humanOnly.includes(entry.capability))
  }
}

try {
  const httpBefore = JSON.parse(read(manifestFile)).capabilities.filter(row => row.transport === "http")
  let production, productionDocument
  check("production canonical denominator and complete metadata", () => {
    production = observe("production")
    ok(command("generate production manifest", generator))
    productionDocument = JSON.parse(read(manifestFile))
    save("generated-planner.production.json", plannerRows(productionDocument))
    parity(production, productionDocument)
  })
  assert(production && productionDocument, "Production setup did not reach the manifest boundary")
  check("test registration matches production without credentials", () => {
    const snapshot = observe("test")
    assert.deepEqual(snapshot.entries, production.entries)
    ok(command("generate test manifest", generator, [], "test"))
    parity(snapshot, JSON.parse(read(manifestFile)))
  })
  check("planner repair does not change the HTTP catalogue", () => {
    assert.deepEqual(JSON.parse(read(manifestFile)).capabilities.filter(row => row.transport === "http"), httpBefore)
  })
  check("real manifest check is deterministic", () => ok(command("manifest --check", generator, ["--check"])))
  const pristine = read(manifestFile)
  check("real coverage generation succeeds on an unmodified manifest", () => ok(command("coverage positive", auditor)))
  const target = production.entries.find(entry => entry.kind === "query")
  assert(target)
  const mutations = [
    ["omitted identity", document => { document.capabilities = document.capabilities.filter(row => row.capabilityId !== `planner.${target.capability}`) }],
    ["extra identity", document => { const row = structuredClone(plannerRows(document)[0]); row.capabilityId = "planner.z0_unregistered_probe"; document.capabilities.push(row) }],
    ["duplicate identity", document => document.capabilities.push(structuredClone(plannerRows(document)[0]))],
    ["required references", (_document, row) => { row.requiredContext = ["z0_wrong_reference"] }],
    ["model proposability", (_document, row) => { row.modelCallable = !target.modelProposable }],
    ["raw availability", (_document, row) => { row.planning = { ...target, available: !target.available } }],
    ["raw risk", (_document, row) => { row.planning = { ...target, risk: target.risk === "high" ? "low" : "high" } }],
    ["raw kind", (_document, row) => { row.planning = { ...target, kind: "action" }; row.kind = "mutation" }],
  ]
  for (const [name, mutate] of mutations) check(`coverage rejects ${name} against canonical source`, () => {
    const document = JSON.parse(pristine)
    mutate(document, plannerRows(document).find(row => row.capabilityId === `planner.${target.capability}`))
    writeFileSync(join(checkout, manifestFile), JSON.stringify(document, null, 2) + "\n")
    const result = command(`coverage mutant: ${name}`, auditor)
    assert.notEqual(result.status, 0, "Auditor trusted the mutated manifest")
    assert.match(result.stderr, /canonical planner/i, "Failure must come from independent canonical-planner validation")
  })
  writeFileSync(join(checkout, manifestFile), pristine)
  const queryOriginal = read(queryFile), registryOriginal = read(registryFile)
  check("fresh canonical identity flows through real generation and coverage", () => {
    const anchor = "export const CORE_OPERATIONAL_QUERY_INTENTS = ["
    assert(queryOriginal.includes(anchor), "Source-mutation anchor changed; update the fixture explicitly")
    writeFileSync(join(checkout, queryFile), queryOriginal.replace(anchor, anchor + '\n  "z0_future_inventory_probe",'))
    try {
      const snapshot = observe("production")
      assert(snapshot.entries.some(entry => entry.capability === "query:z0_future_inventory_probe"))
      ok(command("generate after canonical addition", generator))
      parity(snapshot, JSON.parse(read(manifestFile)))
      ok(command("coverage after canonical addition", auditor))
    } finally { writeFileSync(join(checkout, queryFile), queryOriginal); writeFileSync(join(checkout, manifestFile), pristine) }
  })
  check("changed canonical references flow through real generation", () => {
    const anchor = 'intent === "pe_world_state" ? ["root"]'
    assert(registryOriginal.includes(anchor), "Source-mutation anchor changed; update the fixture explicitly")
    writeFileSync(join(checkout, registryFile), registryOriginal.replace(anchor, 'intent === "pe_world_state" ? ["root","z0RevisionRef"]'))
    try {
      const snapshot = observe("production")
      ok(command("generate after canonical reference change", generator))
      parity(snapshot, JSON.parse(read(manifestFile)))
    } finally { writeFileSync(join(checkout, registryFile), registryOriginal); writeFileSync(join(checkout, manifestFile), pristine) }
  })
  check("enumeration denies an ordinary network import", () => {
    writeFileSync(join(checkout, registryFile), registryOriginal + '\nglobalThis.fetch("https://example.invalid/z0-enumeration-probe");\n')
    try {
      const result = command("generate with network import attempt", generator)
      assert.notEqual(result.status, 0, "Canonical registration did not fail closed on the network attempt")
      assert.match(result.stderr, /CAPABILITY_ENUMERATION_NETWORK_DENIED/, "Wrong rejection boundary")
    } finally { writeFileSync(join(checkout, registryFile), registryOriginal) }
  })
  check("enumeration does not inherit provider credentials", () => {
    const guard = '\nif (process.env.Z0_CREDENTIAL_CANARY || process.env.DATABASE_URL) throw new Error("Z0_INHERITED_CREDENTIAL");\n'
    writeFileSync(join(checkout, registryFile), registryOriginal + guard)
    try {
      ok(command("generate with synthetic parent credentials", generator, [], "production", {
        Z0_CREDENTIAL_CANARY: "synthetic-not-a-credential", DATABASE_URL: "postgres://unused.invalid/z0",
      }))
      parity(production, JSON.parse(read(manifestFile)))
    } finally { writeFileSync(join(checkout, registryFile), registryOriginal); writeFileSync(join(checkout, manifestFile), pristine) }
  })
  check("coverage check succeeds after restoring all source and manifest mutations", () => {
    ok(command("final coverage generation", auditor))
    ok(command("final coverage --check", auditor, ["--check"]))
  })
} catch (error) {
  report.cases.push({ name: "contract setup or execution", result: "FAIL", error: error.message })
}
report.completedAt = new Date().toISOString()
report.passed = report.cases.filter(row => row.result === "PASS").length
report.failed = report.cases.filter(row => row.result === "FAIL").length
report.result = report.failed ? "FAIL" : "PASS"
flush()
console.log(JSON.stringify({ report: join(directory, "report.json"), result: report.result, passed: report.passed, failed: report.failed }))
process.exitCode = report.failed ? 1 : 0

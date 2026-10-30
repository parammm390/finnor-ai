import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { createWriteStream, existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

// Ordinary disposable native stack for phase scenarios: pinned real Auth and
// embedded PostgreSQL, the migrated/seeded application on loopback with real
// owner binding, then one or more scenario programs. This is the transport and
// lifecycle only. A scenario writes its own evidence and decides its own result.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const backend = join(root, "finnor-os")
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const options = name => process.argv.filter(arg => arg.startsWith(`--${name}=`)).map(arg => arg.slice(name.length + 3))
const name = option("name")
const evidence = option("evidence")
const archive = option("archive")
const profiles = option("profiles")
const z3Producer = option("z3-producer")
const scenarios = options("scenario")
const forwarded = options("forward-env")
const hold = process.argv.includes("--hold")
const noWorker = process.argv.includes("--no-worker")
assert.match(name ?? "", /^[a-z0-9-]{1,48}$/)
assert.ok(evidence && isAbsolute(evidence) && !existsSync(evidence), "A new absolute evidence directory is required")
assert.ok(!archive || isAbsolute(archive))
assert.ok(hold || scenarios.length > 0, "A scenario or --hold is required")
assert.ok(scenarios.every(path => isAbsolute(path) && existsSync(path)), "Scenario paths must be existing absolute files")
assert.ok(forwarded.every(key => /^[A-Z][A-Z0-9_]{2,60}$/.test(key) && !/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/.test(key)),
  "Only named non-secret environment variables may be forwarded")
const state = join(root, ".centropy-certification", name)
assert.ok(!existsSync(state) && state !== evidence && !state.startsWith(evidence + "/") && !evidence.startsWith(state + "/"))
mkdirSync(evidence, { mode: 0o700 })
const baseEnv = { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: evidence, TMPDIR: evidence,
  CI: "1", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1", NEXT_TELEMETRY_DISABLED: "1",
  NODE_OPTIONS: "--max-old-space-size=4096", RAYON_NUM_THREADS: "2", TSX_DISABLE_CACHE: "1" }
const scenarioEnv = { ...baseEnv, ...Object.fromEntries(forwarded.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]])) }
const receipt = { schema: "finnor.project-z.native-scenario-stack.v1", status: "RUNNING", stage: "PINNED_AUTH_INSTALL",
  startedAt: new Date().toISOString(), sourceRoot: root, state, node: process.version, profiles: profiles ?? null,
  scenarios: scenarios.map(path => ({ path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), code: null, signal: null })),
  forwardedEnvironmentNames: forwarded.filter(key => process.env[key] !== undefined), workerLifecycle: noWorker ? "SCENARIO_OWNED" : "STOCK",
  children: [], authBypass: false, inheritedCredentials: false, productionAccess: false, phasesAccepted: [],
  toolchainSha256: createHash("sha256").update(readFileSync(join(root, "infra/deployment/project-z-verification-toolchain.json"))).digest("hex") }
function save() { writeFileSync(join(evidence, "stack-result.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }) }
const children = []
const alive = child => child.exitCode === null && child.signalCode === null
function start(label, file, args, readyStatus, extraEnv = {}, cwd = root) {
  const row = { label, file, args: args.map(arg => arg.replace(/^(--(?:state|auth-binary|evidence)=).*/, "$1<path>")),
    startedAt: new Date().toISOString(), pid: null, code: null, signal: null }
  receipt.children.push(row)
  const stdout = createWriteStream(join(evidence, label + ".private.stdout"), { flags: "wx", mode: 0o600 })
  const stderr = createWriteStream(join(evidence, label + ".private.stderr"), { flags: "wx", mode: 0o600 })
  const proc = spawn(file, args, { cwd, env: { ...(readyStatus === undefined ? scenarioEnv : baseEnv), ...extraEnv }, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  row.pid = proc.pid ?? null
  children.push(proc)
  proc.stdout.pipe(stdout, { end: false })
  proc.stderr.pipe(stderr, { end: false })
  let buffer = ""
  let foundReady = false
  let resolveReady
  const ready = new Promise(done => { resolveReady = done })
  proc.stdout.on("data", chunk => {
    buffer += chunk.toString()
    if (buffer.length > 65536) buffer = buffer.slice(-65536)
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      try {
        const value = JSON.parse(line)
        if (value.status === readyStatus) { foundReady = true; resolveReady(value) }
      } catch {}
    }
  })
  const ended = new Promise(done => {
    proc.once("error", () => { row.signal = "SPAWN_ERROR"; resolveReady(null); done(row) })
    proc.once("close", async (code, signal) => {
      Object.assign(row, { code, signal, endedAt: new Date().toISOString() })
      await Promise.all([new Promise(finish => stdout.end(finish)), new Promise(finish => stderr.end(finish))])
      save()
      if (!foundReady) resolveReady(null)
      done(row)
    })
  })
  save()
  return { proc, ready, ended, row }
}
async function bounded(promise, milliseconds) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error("NATIVE_SCENARIO_STAGE_TIMEOUT")), milliseconds) })
  try { return await Promise.race([promise, timeout]) } finally { clearTimeout(timer) }
}
async function stopAll() {
  for (const proc of [...children].reverse()) if (alive(proc)) {
    try { process.kill(-proc.pid, "SIGTERM") } catch {}
  }
  if (children.some(alive)) await delay(5000)
  for (const proc of children) if (alive(proc)) {
    receipt.forcedOwnedStop = true
    try { process.kill(-proc.pid, "SIGKILL") } catch {}
  }
}
let stopping
async function interrupted() {
  if (stopping) return
  stopping = true
  receipt.status = hold ? "STOPPED_BY_OPERATOR" : "FAILED_INTERRUPTED"
  await stopAll()
  save()
  process.exit(hold ? 0 : 1)
}
process.once("SIGTERM", () => void interrupted())
process.once("SIGINT", () => void interrupted())
save()
try {
  const memory = Number(readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024
  const disk = statfsSync(root)
  const cpuAffinity = readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s+(.+)$/m)?.[1]
  receipt.resources = { availableMemoryBytes: memory, availableSourceDiskBytes: disk.bavail * disk.bsize, minimumBytes: 4 * 1024 ** 3, cpuAffinity }
  save()
  assert.match(process.version, /^v22\./, "NODE_22_REQUIRED")
  assert.ok(memory >= 4 * 1024 ** 3 && disk.bavail * disk.bsize >= 4 * 1024 ** 3, "UNCHANGED_RESOURCE_GUARD")
  const target = join(evidence, "auth-toolchain")
  const install = start("install", "python3", ["-I", "-B", join(root, "scripts/project-z/install-isolated-auth.py"),
    "--target", target, ...(archive ? ["--archive", archive] : [])], "NOT_A_STATUS_PROCESS")
  assert.equal((await bounded(install.ended, 180000)).code, 0, "PINNED_AUTH_INSTALL_REQUIRED")
  receipt.stage = "REAL_AUTH_AND_DATABASE"
  save()
  const auth = start("auth", process.execPath, [join(root, "scripts/project-z/start-isolated-auth.mjs"),
    "--state=" + state, "--auth-binary=" + join(target, "auth")], "READY_REAL_LOCAL_AUTH_AND_DATABASE")
  assert.ok(await bounded(auth.ready, 240000), "REAL_AUTH_READY_REQUIRED")
  receipt.stage = "REAL_APPLICATION_BOOTSTRAP"
  save()
  const app = start("app", process.execPath, [join(root, "scripts/project-z/start-isolated-app.mjs"), "--state=" + state,
    ...(profiles ? ["--profile=" + profiles] : []), ...(z3Producer ? ["--z3-producer=" + z3Producer] : []),
    ...(profiles?.split(",").includes("z5") ? ["--z5-s3-python=" + process.env.FINNOR_S3_PYTHON] : []), // z5-native
    ...(noWorker ? ["--no-worker"] : [])], "READY_REAL_AUTHENTICATED_NATIVE_TARGET")
  assert.ok(await bounded(app.ready, 1200000), "REAL_APPLICATION_READY_REQUIRED")
  receipt.stage = hold ? "HELD_READY" : "SCENARIOS"
  receipt.readyAt = new Date().toISOString()
  save()
  if (hold) {
    console.log(JSON.stringify({ status: "HELD_READY", state, evidence }))
    await new Promise(() => {})
  }
  for (const [index, scenario] of scenarios.entries()) {
    const output = join(evidence, `scenario-${String(index + 1).padStart(2, "0")}`)
    const run = start(`scenario-${index + 1}`, process.execPath, ["--import", createRequireTsx(), scenario], undefined,
      { FINNOR_NATIVE_STATE: state, FINNOR_NATIVE_EVIDENCE: output, FINNOR_NATIVE_ROOT: root, FINNOR_NATIVE_APP_ATTEMPT: "01" }, backend)
    const result = await run.ended
    receipt.scenarios[index].code = result.code
    receipt.scenarios[index].signal = result.signal
    save()
    assert.equal(result.code, 0, "SCENARIO_EXIT_REQUIRED_ZERO")
  }
  receipt.status = "SCENARIOS_COMPLETED_RESULTS_IN_SCENARIO_EVIDENCE"
  receipt.stage = "COMPLETE"
} catch (error) {
  receipt.status = "FAILED_RETAINED_NO_AUTOMATIC_RETRY"
  const label = error?.message?.split("\n")[0] ?? ""
  receipt.failureCode = /^[A-Z_]+$/.test(label) ? label : error?.code ?? "NATIVE_SCENARIO_FAILED"
  process.exitCode = 1
} finally {
  await stopAll()
  if (receipt.forcedOwnedStop) { receipt.status = "FAILED_FORCED_OWNED_CLEANUP"; process.exitCode = 1 }
  receipt.finishedAt = new Date().toISOString()
  save()
}
console.log(JSON.stringify(receipt))

function createRequireTsx() {
  return createRequire(join(backend, "package.json")).resolve("tsx")
}

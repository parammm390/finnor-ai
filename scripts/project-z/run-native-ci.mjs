import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createWriteStream, existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const option = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const name = option("name")
const evidence = option("evidence")
const browsers = option("browsers")
const archive = option("archive")
assert.match(name ?? "", /^[a-z0-9-]{1,48}$/)
assert.ok(evidence && isAbsolute(evidence) && !existsSync(evidence))
assert.ok(browsers && isAbsolute(browsers))
assert.ok(!archive || isAbsolute(archive))
const state = join(root, ".centropy-certification", name)
assert.ok(!existsSync(state) && state !== evidence && !state.startsWith(evidence + "/") && !evidence.startsWith(state + "/"))
mkdirSync(evidence, { mode: 0o700 })
const env = { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: evidence, TMPDIR: evidence,
  CI: "1", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1", NEXT_TELEMETRY_DISABLED: "1",
  NODE_OPTIONS: "--max-old-space-size=4096", RAYON_NUM_THREADS: "2", TSX_DISABLE_CACHE: "1" }
const receipt = { schema: "finnor.project-z.native-ci.v1", status: "RUNNING", stage: "PINNED_AUTH_INSTALL",
  startedAt: new Date().toISOString(), sourceRoot: root, state, node: process.version,
  scope: "REAL_AUTH_OWNER_LOGIN_RELOAD_TRANSPORT_ONLY", children: [], authBypass: false,
  inheritedCredentials: false, productionAccess: false, nativeMechanismAdmission: "NOT_RUN",
  protectedAdmission: "NOT_RUN", installedAcceptance: "NOT_RUN", phasesAccepted: [],
  inputs: Object.fromEntries(["scripts/project-z/run-native-ci.mjs", "scripts/project-z/install-isolated-auth.py",
    "scripts/project-z/start-isolated-auth.mjs", "scripts/project-z/start-isolated-app.mjs",
    "scripts/project-z/run-owner-smoke.mjs", "finnor-os/apps/api/next.config.mjs", "next.config.mjs",
    "package-lock.json", "finnor-os/package-lock.json", "e2e/centropy-owner-login.spec.ts"]
    .map(path => [path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")])),
  toolchainSha256: createHash("sha256").update(readFileSync(join(root, "infra/deployment/project-z-verification-toolchain.json"))).digest("hex") }
function save() { writeFileSync(join(evidence, "result.json"), JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 }) }
const children = []
const alive = child => child.exitCode === null && child.signalCode === null
function start(label, file, args, readyStatus) {
  const row = { label, file, args, startedAt: new Date().toISOString(), pid: null, code: null, signal: null }
  receipt.children.push(row)
  const stdout = createWriteStream(join(evidence, label + ".private.stdout"), { flags: "wx", mode: 0o600 })
  const stderr = createWriteStream(join(evidence, label + ".private.stderr"), { flags: "wx", mode: 0o600 })
  const child = spawn(file, args, { cwd: root, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  row.pid = child.pid ?? null
  children.push(child)
  child.stdout.pipe(stdout, { end: false })
  child.stderr.pipe(stderr, { end: false })
  let buffer = ""
  let foundReady = false
  let resolveReady
  const ready = new Promise(done => { resolveReady = done })
  child.stdout.on("data", chunk => {
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
    child.once("error", () => { row.signal = "SPAWN_ERROR"; resolveReady(null); done(row) })
    child.once("close", async (code, signal) => {
      Object.assign(row, { code, signal, endedAt: new Date().toISOString() })
      await Promise.all([new Promise(finish => stdout.end(finish)), new Promise(finish => stderr.end(finish))])
      save()
      if (!foundReady) resolveReady(null)
      done(row)
    })
  })
  save()
  return { child, ready, ended }
}
async function bounded(promise, milliseconds) {
  let timer
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error("NATIVE_CI_STAGE_TIMEOUT")), milliseconds) })
  try { return await Promise.race([promise, timeout]) } finally { clearTimeout(timer) }
}
async function stopAll() {
  for (const child of [...children].reverse()) if (alive(child)) {
    try { process.kill(-child.pid, "SIGTERM") } catch {}
  }
  if (children.some(alive)) await delay(3000)
  for (const child of children) if (alive(child)) {
    receipt.forcedOwnedStop = true
    try { process.kill(-child.pid, "SIGKILL") } catch {}
  }
}
let stopping
async function interrupted() {
  if (stopping) return
  stopping = true
  receipt.status = "FAILED_INTERRUPTED"
  await stopAll()
  save()
  process.exit(1)
}
process.once("SIGTERM", () => void interrupted())
process.once("SIGINT", () => void interrupted())
save()
try {
  const memory = Number(readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)/m)?.[1]) * 1024
  const disk = statfsSync(root)
  const outputDisk = statfsSync(evidence)
  const cpuAffinity = readFileSync("/proc/self/status", "utf8").match(/^Cpus_allowed_list:\s+(.+)$/m)?.[1]
  receipt.resources = { availableMemoryBytes: memory, availableSourceDiskBytes: disk.bavail * disk.bsize,
    availableEvidenceDiskBytes: outputDisk.bavail * outputDisk.bsize, minimumBytes: 4 * 1024 ** 3, cpuAffinity }
  save()
  assert.match(process.version, /^v22\./, "NODE_22_REQUIRED")
  assert.equal(cpuAffinity, "0-1", "EXACT_TWO_CPU_AFFINITY_REQUIRED")
  assert.ok(memory >= 4 * 1024 ** 3 && disk.bavail * disk.bsize >= 4 * 1024 ** 3
    && outputDisk.bavail * outputDisk.bsize >= 4 * 1024 ** 3, "UNCHANGED_RESOURCE_GUARD")
  const target = join(evidence, "auth-toolchain")
  const install = start("install", "python3", ["-I", "-B", join(root, "scripts/project-z/install-isolated-auth.py"),
    "--target", target, ...(archive ? ["--archive", archive] : [])])
  assert.equal((await bounded(install.ended, 120000)).code, 0, "PINNED_AUTH_INSTALL_REQUIRED")
  receipt.stage = "REAL_AUTH_AND_DATABASE"
  save()
  const auth = start("auth", process.execPath, [join(root, "scripts/project-z/start-isolated-auth.mjs"),
    "--state=" + state, "--auth-binary=" + join(target, "auth")], "READY_REAL_LOCAL_AUTH_AND_DATABASE")
  assert.ok(await bounded(auth.ready, 120000), "REAL_AUTH_READY_REQUIRED")
  receipt.stage = "REAL_APPLICATION_BOOTSTRAP"
  save()
  const app = start("app", process.execPath, [join(root, "scripts/project-z/start-isolated-app.mjs"), "--state=" + state],
    "READY_REAL_AUTHENTICATED_NATIVE_TARGET")
  assert.ok(await bounded(app.ready, 600000), "REAL_APPLICATION_READY_REQUIRED")
  receipt.stage = "REAL_OWNER_AND_MOUNTED_RELOAD"
  save()
  const smokeEvidence = join(evidence, "owner")
  const smoke = start("smoke", process.execPath, [join(root, "scripts/project-z/run-owner-smoke.mjs"),
    "--state=" + state, "--app-attempt=01", "--evidence=" + smokeEvidence, "--browsers=" + browsers])
  assert.equal((await bounded(smoke.ended, 330000)).code, 0, "UNSKIPPED_OWNER_BROWSER_FLOW_REQUIRED")
  const proofBytes = readFileSync(join(smokeEvidence, "result.json"))
  const proof = JSON.parse(proofBytes)
  assert.equal(proof.status, "PASS_ORDINARY_DEVELOPMENT_OWNER_SMOKE_ONLY")
  assert.equal(proof.browserStats.expected, 1)
  assert.equal(proof.browserStats.skipped, 0)
  receipt.ownerSmokeSha256 = createHash("sha256").update(proofBytes).digest("hex")
  receipt.ownerObservations = proof.observations
  receipt.browserStats = proof.browserStats
  receipt.status = "PASS_ORDINARY_NATIVE_TRANSPORT_ONLY"
  receipt.stage = "COMPLETE"
} catch (error) {
  receipt.status = "FAILED_RETAINED_NO_AUTOMATIC_RETRY"
  const label = error?.message?.split("\n")[0] ?? ""
  receipt.failureCode = /^[A-Z_]+$/.test(label) ? label : error?.code ?? "NATIVE_CI_FAILED"
  process.exitCode = 1
} finally {
  await stopAll()
  if (receipt.forcedOwnedStop) { receipt.status = "FAILED_FORCED_OWNED_CLEANUP"; process.exitCode = 1 }
  receipt.finishedAt = new Date().toISOString()
  save()
}
console.log(JSON.stringify(receipt))

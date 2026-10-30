import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const backend = join(root, "finnor-os")
const require = createRequire(join(backend, "package.json"))
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const phase = option("phase")
const evidence = option("evidence")
assert.ok(["z1", "z2", "z3", "z4"].includes(phase), "Explicit public phase z1–z4 required")
assert.ok(evidence && isAbsolute(evidence), "New absolute evidence path required")
mkdirSync(evidence, { mode: 0o700 })
const target = join(evidence, "process")
const deadline = new Date(Date.now() + 600000).toISOString()
const commands = {
  z1: [process.execPath, [join(backend, "scripts/project-z/z1/verify.mjs"), target]],
  z2: ["python3", [join(backend, "scripts/project-z/z2/ci-qualification.py"), "--repo", root, "--evidence-dir", target]],
  z3: ["python3", [join(backend, "scripts/project-z/z3/finite-e2e.py"), "--cli", join(backend, "scripts/project-z/z3/cli.mts"),
    "--checker", join(backend, "packages/epistemic-runtime/src/project-z/z3-viability/nonconflicting-checker.py"), "--output", target]],
  z4: [process.execPath, [join(backend, "scripts/project-z/z4/supplementary-process.mts"),
    "--family", "negative-obligations-v4", "--evidence", target, "--deadline", deadline]],
}
const [file, args] = commands[phase]
const variables = {
  PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: evidence, TMPDIR: evidence,
  CI: "1", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1", TSX_DISABLE_CACHE: "1", RAYON_NUM_THREADS: "2",
  NODE_OPTIONS: "--max-old-space-size=4096 --import=" + require.resolve("tsx"),
}
const startedAt = new Date().toISOString()
const log = join(evidence, "process.log")
const stream = createWriteStream(log, { flags: "wx", mode: 0o600 })
const child = spawn(file, args, { cwd: backend, env: variables, detached: true, stdio: ["ignore", "pipe", "pipe"] })
child.stdout.pipe(stream, { end: false })
child.stderr.pipe(stream, { end: false })
let timedOut = false
let failure
let escalation
function terminate() {
  try { process.kill(-child.pid, "SIGTERM") } catch {}
  escalation = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, 2000)
  escalation.unref()
}
const timer = setTimeout(() => { timedOut = true; terminate() }, 600000)
process.once("SIGTERM", terminate)
process.once("SIGINT", terminate)
const result = await new Promise(done => {
  child.once("error", error => { failure = error.code ?? "PROCESS_START_FAILED"; done({ code: null, signal: null }) })
  child.once("close", (code, signal) => done({ code, signal }))
})
clearTimeout(timer)
if (escalation) clearTimeout(escalation)
await new Promise(done => stream.end(done))
let report
try { report = JSON.parse(readFileSync(join(target, "report.json"), "utf8")) } catch {}
const acceptedReport = report !== undefined && ({
  z1: () => report.status === "PASSED" && report.passed === 256 && report.failed === 0 && report.results?.length === 256,
  z2: () => report.status === "PASS_PUBLIC_SOURCE_REPLAY_ONLY" && report.failed === 0 && report.passed === 256
    && report.cases?.length === 256 && report.cases.every(row => row.passed === true)
    && report.structuralFamiliesQualified === 32 && report.sourceUnchanged === true
    && report.usefulSupportedPositivePassed === 248 && report.negatives?.length === 254
    && report.negatives.every(row => row.passed === true),
  z3: () => report.status === "PASS" && report.requests >= 256 && report.failures?.length === 0 && Object.keys(report.families ?? {}).length === 32,
  z4: () => report.status === "PASSED_BOUNDED_PUBLIC_PROCESS_ONLY" && report.proofPassed === 0 && report.negatives?.length === 12
    && report.negatives.every(row => row.originalRejected === true && row.originalReasonMatched === true),
}[phase])()
const passed = result.code === 0 && !result.signal && !timedOut && !failure && acceptedReport
const receipt = {
  schema: "finnor.project-z.public-ci.v1", phase, status: passed ? "PASS" : "FAIL",
  command: [file, ...args], cwd: backend, startedAt, finishedAt: new Date().toISOString(),
  ...result, timedOut, failure: failure ?? null, environmentNames: Object.keys(variables).sort(),
  logSha256: createHash("sha256").update(readFileSync(log)).digest("hex"),
  processReportSha256: report ? createHash("sha256").update(readFileSync(join(target, "report.json"))).digest("hex") : null,
  scope: phase === "z4" ? "ORIGINAL_AND_NATIVE_CRITICAL_REJECTS_NO_NEW_PROOFS" : "PUBLIC_ORIGINAL_SEMANTICS_PROCESS",
  nativeOwner: "NOT_RUN", protectedAdmission: "NOT_RUN", business100x: "NOT_RUN", wholePhaseAccepted: false,
}
writeFileSync(join(evidence, "result.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 })
console.log(JSON.stringify(receipt))
if (!passed) process.exitCode = 1

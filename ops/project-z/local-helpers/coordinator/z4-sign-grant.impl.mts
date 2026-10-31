// Coordinator policy signer for Z4 guarded native replay grants.
// The grant is the coordinator's act (session dfd67166-a075-4f36-94a7-e1df86369259). This signer applies the
// coordinator's fixed disposable-target policy and refuses everything else. It never widens a scope.
import { execFileSync } from "node:child_process"
import { constants, existsSync, mkdirSync, appendFileSync } from "node:fs"
import { open, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"

const COORDINATOR = "dfd67166-a075-4f36-94a7-e1df86369259"
const PERMISSIONS = ["NATIVE_PROOF_WORK_WRITE", "EXCLUSIVE_JOB_CLAIM_RECOVERY", "NATIVE_ANALYTICAL_GUARD_USE",
  "OWNED_CHILD_SIGKILL", "MOUNTED_OWNER_UI"] as const
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  ?? (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : undefined)
const refuse = (predicate: string, detail?: string): never => {
  console.error(JSON.stringify({ signed: false, predicate, detail: detail ?? null }))
  process.exit(77)
}
const repository = arg("repository"), scopePath = arg("scope"), outDir = arg("out-dir")
if (!repository || !scopePath || !outDir || ![repository, scopePath, outDir].every(path => path.startsWith("/"))) refuse("Z4_SIGNER_ARGUMENTS")
const requiredDir = join(repository!, "scope-z/orchestration/replay-grants/z4")
if (resolve(outDir!) !== requiredDir) refuse("Z4_SIGNER_OUT_DIR_MUST_BE_THE_COORDINATOR_RECEIPT_DIRECTORY", requiredDir)

const authority = await import(join(repository!, "finnor-os/scripts/project-z/z4/replay-authority.mts")) as Record<string, any>
const contracts = await import(join(repository!, "finnor-os/packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts.ts")) as Record<string, any>
const { sha } = contracts
for (const name of ["scopeSchema", "targetSchema", "ownedInventory"]) {
  if (!authority[name]) refuse("Z4_SIGNER_REPLAY_AUTHORITY_EXPORT_MISSING", name)
}

async function privateFile(path: string, limit: number) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) refuse("Z4_SIGNER_PRIVATE_FILE_REQUIRED", path)
    return await file.readFile()
  } finally { await file.close() }
}

const scopeBytes = await privateFile(scopePath!, 128 * 1024)
let scope: any
try { scope = authority.scopeSchema.parse(JSON.parse(scopeBytes.toString("utf8"))) } catch { refuse("Z4_SIGNER_SCOPE_SCHEMA") }
const now = Date.now()
if (!(Date.parse(scope.grantedAt) <= now && now < Date.parse(scope.expiresAt)) || Date.parse(scope.expiresAt) - Date.parse(scope.grantedAt) > 3_600_000) {
  refuse("Z4_SIGNER_SCOPE_NOT_CURRENT_OR_OVER_ONE_HOUR")
}
const git = (...args: string[]) => execFileSync("git", ["-C", repository!, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
let head: string, tree: string
// next dev/build rewrites next-env.d.ts; that generated file is the only tracked path allowed to differ.
try {
  head = git("rev-parse", "HEAD"); tree = git("rev-parse", "HEAD^{tree}")
  git("diff", "--quiet", "HEAD", "--", ".", ":(exclude)next-env.d.ts", ":(exclude)finnor-os/apps/api/next-env.d.ts", ":(exclude)finnor-os/apps/web/next-env.d.ts")
} catch { refuse("Z4_SIGNER_SOURCE_NOT_A_CLEAN_COMMITTED_TREE") }
if (head! !== scope.sourceCommit || tree! !== scope.sourceTree) refuse("Z4_SIGNER_SOURCE_IDENTITY_MISMATCH")
const inventory = await authority.ownedInventory(repository)
if (inventory.digest !== scope.ownedSourceDigest) refuse("Z4_SIGNER_OWNED_SOURCE_DIGEST_MISMATCH")

const native = join(repository!, "finnor-os/packages/epistemic-runtime/native/z4-execution-proof")
const identity = JSON.parse(await readFile(join(native, "build-identity.json"), "utf8"))
const binarySha = sha(await readFile(join(native, "bin/z4-proof")))
if (identity.binarySha256 !== scope.nativeBinarySha256 || binarySha !== scope.nativeBinarySha256 || identity.sourceDigest !== scope.nativeSourceDigest) {
  refuse("Z4_SIGNER_NATIVE_IDENTITY_MISMATCH")
}

const targetBytes = await privateFile(scope.targetReceiptFile, 128 * 1024)
if (sha(targetBytes) !== scope.targetReceiptSha256) refuse("Z4_SIGNER_TARGET_RECEIPT_MISMATCH")
let target: any
try { target = authority.targetSchema.parse(JSON.parse(targetBytes.toString("utf8"))) } catch { refuse("Z4_SIGNER_TARGET_SCHEMA") }
const loopback = (value: string) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)
if (!loopback(target.frontendOrigin) || !loopback(target.backendOrigin) || !loopback(target.authOrigin)
  || new URL(target.authOrigin).protocol !== "https:") refuse("Z4_SIGNER_TARGET_MUST_BE_LOOPBACK_WITH_HTTPS_AUTH")
if (target.databasePort !== 55441 || !["127.0.0.1", "localhost", "::1"].includes(target.databaseHost)) refuse("Z4_SIGNER_DATABASE_MUST_BE_THE_DISPOSABLE_LOOPBACK_DATABASE")
if (!target.authCertificateFile || !target.authCertificateSha256 || !target.authCertificateSpkiSha256) refuse("Z4_SIGNER_DECLARED_CERTIFICATE_REQUIRED")
for (const [file, expected] of [[target.frontendBuildIdFile, target.frontendBuildIdSha256], [target.backendBuildIdFile, target.backendBuildIdSha256],
  [target.chromiumExecutableFile, target.chromiumExecutableSha256]] as const) {
  if (!existsSync(file) || sha(await readFile(file)) !== expected) refuse("Z4_SIGNER_TARGET_IDENTITY_FILE_MISMATCH", file)
}
// The listeners must be live and visible as this user's own processes: ss shows process ids only for them.
for (const origin of [target.frontendOrigin, target.backendOrigin, target.authOrigin]) {
  const port = new URL(origin).port
  const listing = execFileSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" })
  if (!/pid=\d+/.test(listing)) refuse("Z4_SIGNER_TARGET_LISTENER_NOT_OWNED_OR_ABSENT", origin)
}

const kinds = ["tenant", "private-use", "authority", "currentness", "budget", "cancellation", "unsupported", "incomplete"]
if (!scope.cases.some((item: any) => item.recoverProducer) || !scope.cases.some((item: any) => item.recoverOwner)
  || !kinds.every(kind => scope.negatives.some((item: any) => item.kind === kind))
  || scope.negatives.some((item: any) => ["tenant", "authority"].includes(item.kind) && !item.credentialsEnvironmentVariable)) refuse("Z4_SIGNER_COVERAGE_REQUIRED")
const credentialNames = new Set<string>([scope.credentialsEnvironmentVariable,
  ...scope.negatives.flatMap((item: any) => item.credentialsEnvironmentVariable ? [item.credentialsEnvironmentVariable] : [])])
if (credentialNames.size < 2) refuse("Z4_SIGNER_DISTINCT_ACTOR_CREDENTIAL_NAMES_REQUIRED")
for (const item of scope.cases) {
  for (const [file, expected] of [[item.requestFile, item.requestSha256], [item.expectedFile, item.expectedSha256]] as const) {
    if (sha(await readFile(file)) !== expected) refuse("Z4_SIGNER_CASE_PREIMAGE_MISMATCH", file)
  }
}
for (const item of scope.negatives) if (sha(await readFile(item.bodyFile)) !== item.bodySha256) refuse("Z4_SIGNER_NEGATIVE_PREIMAGE_MISMATCH", item.bodyFile)

const receipt = { schema: "finnor.z4.replay-grant.v1", fixture: false, grantedBy: COORDINATOR, scopeDigest: sha(scope), permissions: [...PERMISSIONS] }
const bytes = Buffer.from(JSON.stringify(receipt) + "\n")
const receiptSha = createHash("sha256").update(bytes).digest("hex")
mkdirSync(requiredDir, { recursive: true, mode: 0o700 })
const path = join(requiredDir, receiptSha + ".json")
const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
try { await file.writeFile(bytes) } finally { await file.close() }
const audit = "/home/factory-user/repos/fzv-int-out/coordinator/audit"
mkdirSync(audit, { recursive: true, mode: 0o700 })
appendFileSync(join(audit, "z4-grants.jsonl"), JSON.stringify({ at: new Date().toISOString(), receiptSha256: receiptSha, scopeDigest: receipt.scopeDigest,
  sourceCommit: scope.sourceCommit, expiresAt: scope.expiresAt, cases: scope.cases.length, negatives: scope.negatives.length }) + "\n", { mode: 0o600 })
console.log(JSON.stringify({ signed: true, receiptSha256: receiptSha, path, scopeDigest: receipt.scopeDigest, expiresAt: scope.expiresAt }))

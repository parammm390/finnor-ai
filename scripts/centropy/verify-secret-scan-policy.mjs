import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const binary = resolve(process.argv[2] ?? join(root, ".centropy-certification/tooling/gitleaks-8.24.3/gitleaks"))
const config = join(root, ".gitleaks.toml")
const output = resolve(process.argv[3] ?? join(root, "docs/centropy/evidence/release-candidate-secret-scan/policy.proof.json"))
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const version = spawnSync(binary, ["version"], { encoding: "utf8" })
if (version.status !== 0 || version.stdout.trim() !== "8.24.3") throw new Error("Use the release's pinned Gitleaks 8.24.3 binary")
const temporary = mkdtempSync(join(tmpdir(), "centropy-secret-policy-"))
const reference = "dac03595-1793-4796-a744-a7c0c7dc2d35"
const authoredNegative = ["gf9A3mR7", "zQ2xP6cV", "8bN4kH1s", "D0uW5eTj"].join("")
const authoredAwsId = ["AKIA", "6S8V4PQ3ZN9X2R7T"].join("")
const evidencePath = "docs/centropy/evidence/probe.json"
const m1Path = "finnor-os/scripts/m1/run-e2e.mts"
const p4Path = "finnor-os/scripts/p4/frontier-comparison.mts"
const predicatesPath = "finnor-os/packages/private-equity/src/program-synthesis/owners.ts"
const m4Path = "finnor-os/scripts/m4/run-e2e.mts"
const candidatePath = "finnor-os/packages/private-equity/src/capital-program/v2-owners.ts"
const migrationsPath = "docs/release/completed-release-2026-10-08/migration-allocation.json"
const prosePaths = ["scope-pm/completion-c/all-ten-gates.json", "scope-pm/completion-c/all-ten-requirements.json"]
const json = (value) => JSON.stringify(value, null, 2) + "\n"
const credential = (field = "apiKey", value = authoredNegative) => `const ${field} = '${value}';\n`
const objectFixture = (name, field, value, spacing = "") => `const ${name}={${field}:${spacing}'${value}'};\n`
const approvalPredicate = "S6_EXACT_APPROVAL_AND_CREDENTIAL_EGRESS"
const observationPredicate = "S6_INDEPENDENT_OBSERVATION"
const predicateFixture = (value = observationPredicate) => `const proposal={remainingPredicates:['${approvalPredicate}','${value}']};\n`
const observationSemantics = "observed/available/known"
const cpuModel = "m1-cpu-boundary"
const revocationModel = "m1-live-revocation"
const duplicateReference = "m4-idempotency"
const proposalCandidate = "m3-nonconsequential-proposal"
const migrationPins = {
  ["0141_restricted_digest_projection_access.sql"]: "45f4832a2e63eecbab99ccb8ef38c47491ce5f4afef2d6e935df87c090b41aab",
  ["0085_phase1_identity_access_fabric.sql"]: "59f49a2e99bb4c495091e8647e903767f0daf098b6bd7ad1878421e2bd37a982",
  ["0088_staging_os_keychain_auth_profiles.sql"]: "da578eb5b1aeaf158fa568eb3ead7e3b7d64ca92ef8df523297e9dbca77ce57a",
  ["0079_tenant_credential_references.sql"]: "a8b237e21706c24856c625d0bd6a4c1bc6979c86fab7fbb6c625a923fac660ba",
}
const metadata = [
  { name: "m1", path: m1Path, fields: ["modelKey"], baselineCount: 2, bytes: objectFixture("first", "modelKey", cpuModel) + objectFixture("second", "modelKey", revocationModel) },
  { name: "p4", path: p4Path, fields: ["modelKey"], baselineCount: 4, bytes: ["consumer", "consumer", "incumbent", "incumbent"].map((kind, index) => objectFixture(`model${index}`, "modelKey", `p4-frontier-${kind}`, " ")).join("") },
  { name: "predicates", path: predicatesPath, fields: ["remainingPredicates"], baselineCount: 1, bytes: predicateFixture() },
  { name: "m4", path: m4Path, fields: ["idempotencyKey"], baselineCount: 3, bytes: Array.from({ length: 3 }, (_, index) => objectFixture(`request${index}`, "idempotencyKey", duplicateReference)).join("") },
  { name: "candidate", path: candidatePath, fields: ["candidateKey"], baselineCount: 1, bytes: objectFixture("candidate", "candidateKey", proposalCandidate) },
  { name: "migration-pins", path: migrationsPath, fields: Object.keys(migrationPins), baselineCount: 4, bytes: json(migrationPins) },
  ...prosePaths.map((path, index) => ({ name: `prose-${index}`, path, fields: ["verbatim"], baselineCount: 1, bytes: json({ verbatim: `Retain instrument/source revision, token semantics, ${observationSemantics} time, provenance.` }) })),
]
const scans = []
const historyScans = []
const emptyIgnore = join(temporary, "empty-gitleaksignore")
const scannerOptions = ["--redact=100", "--no-banner", "--ignore-gitleaks-allow", `--gitleaks-ignore-path=${emptyIgnore}`, "--log-level=error"]

function scan(name, path, bytes, policy, expectedCount, fields = []) {
  const directory = join(temporary, name)
  const fixturePath = join(directory, path)
  const report = join(temporary, `${name}-${policy}.json`)
  mkdirSync(dirname(fixturePath), { recursive: true })
  writeFileSync(fixturePath, bytes)
  const result = spawnSync(binary, ["dir", directory, ...scannerOptions, "--report-format=json", `--report-path=${report}`, ...(policy === "configured" ? [`--config=${config}`] : [])], { encoding: "utf8", timeout: 30_000 })
  if (![0, 1].includes(result.status)) throw new Error(`Scanner failed for ${name}/${policy}, exit ${result.status}`)
  const findings = JSON.parse(readFileSync(report, "utf8"))
  const summary = { fixture: name, path, policy, inputSha256: sha(bytes), inputBytes: Buffer.byteLength(bytes), fields, expectedFindingCount: expectedCount, exitCode: result.status, findingCount: findings.length, ruleIds: [...new Set(findings.map((item) => item.RuleID))].sort() }
  scans.push(summary)
  if (findings.length !== expectedCount || result.status !== (expectedCount ? 1 : 0)) throw new Error(`Policy verification failed: ${JSON.stringify(summary)}`)
  return summary
}

function git(directory, args, input, env = {}) {
  const result = spawnSync("git", ["-C", directory, ...args], { input, encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 })
  if (result.status !== 0) throw new Error(`Temporary Git fixture failed for ${args[0]}, exit ${result.status}`)
  return result.stdout.trim()
}

function historyProbe(name, placement) {
  const directory = join(temporary, `history-${name}`)
  mkdirSync(directory)
  git(directory, ["init", "--quiet"])
  const author = git(root, ["var", "GIT_AUTHOR_IDENT"])
  const committer = git(root, ["var", "GIT_COMMITTER_IDENT"])
  const index = join(temporary, `index-${name}`)
  const files = { [m1Path]: metadata[0].bytes }
  const object = (parents, label) => {
    git(directory, ["read-tree", "--empty"], undefined, { GIT_INDEX_FILE: index })
    for (const [path, bytes] of Object.entries(files)) {
      const blob = git(directory, ["hash-object", "-w", "--stdin"], bytes)
      git(directory, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], undefined, { GIT_INDEX_FILE: index })
    }
    const tree = git(directory, ["write-tree"], undefined, { GIT_INDEX_FILE: index })
    const content = [`tree ${tree}`, ...parents.map((parent) => `parent ${parent}`), `author ${author}`, `committer ${committer}`, "", label, ""].join("\n")
    return git(directory, ["hash-object", "-t", "commit", "-w", "--stdin"], content)
  }
  const base = object([], "Authored scanner proof base")
  let head = base
  let introduced
  for (let number = 1; number <= 34; number++) {
    files["history-sequence.txt"] = `Authored proof step ${number}\n`
    if (placement === "late" && number === 34) files["late-credential.ts"] = credential()
    head = object([head], `Authored scanner proof step ${number}`)
    if (placement === "late" && number === 34) introduced = head
  }
  const linearHead = head
  const savedFiles = { ...files }
  if (placement === "side-parent") files["side-credential.ts"] = credential()
  files["side-marker.txt"] = "Authored side-parent proof\n"
  const side = object([base], "Authored side-parent scanner proof")
  if (placement === "side-parent") introduced = side
  for (const path of Object.keys(files)) delete files[path]
  Object.assign(files, savedFiles)
  if (placement === "merge-only") files["merge-credential.ts"] = credential()
  head = object([linearHead, side], "Authored merge scanner proof")
  if (placement === "merge-only") introduced = head
  git(directory, ["update-ref", "refs/heads/scanner-proof", head])
  git(directory, ["symbolic-ref", "HEAD", "refs/heads/scanner-proof"])
  const range = `${base}..${head}`
  const commits = git(directory, ["rev-list", range]).split("\n")
  const firstParent = git(directory, ["rev-list", "--first-parent", range]).split("\n")
  const report = join(temporary, `history-${name}.json`)
  const result = spawnSync(binary, ["git", directory, ...scannerOptions, `--config=${config}`, `--log-opts=-m ${range}`, "--report-format=json", `--report-path=${report}`], { encoding: "utf8", timeout: 30_000 })
  if (![0, 1].includes(result.status)) throw new Error(`History scanner failed for ${name}, exit ${result.status}`)
  const findings = JSON.parse(readFileSync(report, "utf8"))
  const expectedExit = placement ? 1 : 0
  const foundAtIntroduction = placement ? findings.some((finding) => finding.Commit === introduced) : findings.length === 0
  const summary = { fixture: name, placement: placement ?? "allowed-metadata", range, commitCount: commits.length, firstParentCount: firstParent.length, introducedCommit: introduced ?? null, sideParentIncluded: commits.includes(side), logOptions: `-m ${range}`, inputSha256: sha(json(files)), exitCode: result.status, findingCount: findings.length, ruleIds: [...new Set(findings.map((finding) => finding.RuleID))].sort(), introductionDetected: foundAtIntroduction, findings: findings.map((finding) => ({ ruleId: finding.RuleID, path: finding.File, line: finding.StartLine, commit: finding.Commit })) }
  historyScans.push(summary)
  if (commits.length !== 36 || !commits.includes(side) || result.status !== expectedExit || !foundAtIntroduction) throw new Error(`Complete history verification failed: ${JSON.stringify(summary)}`)
  if (placement === "side-parent" && firstParent.includes(introduced)) throw new Error("Side-parent fixture does not challenge first-parent omission")
}

try {
  writeFileSync(emptyIgnore, "")
  const business = { executionKey: reference, idempotencyKey: reference, templateKey: "centropy_ic_default_v1", versionKey: "centropy-growth-bps-e2e-v2" }
  scan("business", evidencePath, json(business), "default", 4, Object.keys(business))
  scan("business", evidencePath, json(business), "configured", 0, Object.keys(business))
  scan("credential", evidencePath, json({ accessToken: reference, apiKey: authoredNegative }), "configured", 2, ["accessToken", "apiKey"])
  for (const fixture of metadata) {
    scan(fixture.name, fixture.path, fixture.bytes, "default", fixture.baselineCount, fixture.fields)
    scan(fixture.name, fixture.path, fixture.bytes, "configured", 0, fixture.fields)
    scan(`${fixture.name}-wrong-path`, `unrelated/${fixture.name}.txt`, fixture.bytes, "configured", fixture.baselineCount, fixture.fields)
    scan(`${fixture.name}-same-path-credential`, fixture.path, credential(), "configured", 1, ["apiKey"])
    const sameLine = fixture.bytes.trimEnd().replaceAll("\n", " ") + " " + credential()
    scan(`${fixture.name}-same-line-credential`, fixture.path, sameLine, "configured", 1, [...fixture.fields, "apiKey"])
  }
  for (const path of [m1Path, p4Path]) scan(`model-value-${path === m1Path ? "m1" : "p4"}`, path, credential("modelKey"), "configured", 1, ["modelKey"])
  scan("model-wrong-field", m1Path, credential("apiKey", cpuModel), "configured", 1, ["apiKey"])
  scan("predicate-altered-value", predicatesPath, predicateFixture(authoredNegative), "configured", 1, ["remainingPredicates"])
  scan("runtime-idempotency-not-exempt", predicatesPath, credential("idempotencyKey"), "configured", 1, ["idempotencyKey"])
  scan("m4-altered-idempotency", m4Path, credential("idempotencyKey"), "configured", 1, ["idempotencyKey"])
  scan("m4-runtime-uuid-not-exempt", m4Path, `const idempotencyKey = '${reference}';\n`, "configured", 1, ["idempotencyKey"])
  scan("candidate-altered-value", candidatePath, credential("candidateKey"), "configured", 1, ["candidateKey"])
  for (const name of Object.keys(migrationPins)) scan(`migration-altered-${name}`, migrationsPath, json({ [name]: authoredNegative }), "configured", 1, [name])
  scan("prose-altered-value", prosePaths[0], json({ verbatim: `token semantics, ${authoredNegative} time` }), "configured", 1, ["verbatim"])
  const aws = scan("default-aws-rule-active", m1Path, `const aws_access_key_id = '${authoredAwsId}';\n`, "configured", 1, ["aws_access_key_id"])
  if (!aws.ruleIds.includes("aws-access-token")) throw new Error("Default AWS credential detector was not preserved")
  historyProbe("allowed-metadata")
  historyProbe("late-commit", "late")
  historyProbe("side-parent", "side-parent")
  historyProbe("merge-only", "merge-only")
  const proof = { schema: "centropy.secret-scan-policy-proof/v2", status: "PASS", capturedAt: new Date().toISOString(), scannerVersion: version.stdout.trim(), binarySha256: sha(readFileSync(binary)), configurationSha256: sha(readFileSync(config)), verifierSha256: sha(readFileSync(fileURLToPath(import.meta.url))), steps: ["Show default rules detect each exact authored metadata match", "Show only exact path and detector-match pairs are permitted", "Reject wrong-path copies, same-path and same-line credentials, changed fields and changed values", "Show runtime idempotency keys and the default AWS credential detector remain scanned", "Exercise the actual -m base-to-head command with more than 30 ancestors, a side parent and a merge-only introduction"], scans, historyScans, secretValuesPersisted: false, reproduce: "node scripts/centropy/verify-secret-scan-policy.mjs <pinned-gitleaks-8.24.3-path> <proof-output-path>", limitation: "Authored local scanner fixtures and temporary Git objects; no real credential, repository commit, external certification, fresh dependency install, or production build is claimed." }
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(proof, null, 2) + "\n")
  console.log(JSON.stringify({ status: proof.status, scannerVersion: proof.scannerVersion, policyProbeCount: scans.length, historyScans, output }))
} finally { rmSync(temporary, { recursive: true, force: true }) }

import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, writeFileSync, utimesSync, mkdirSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { worktreeStatus } from "./worktree-state.mjs"
import test from "node:test"
import {
  assertAlbTargetsHealthy,
  assertAwsTarget,
  assertAwsWorkerHealth,
  assertCanonicalRelease,
  assertEcsDeploymentStable,
  assertFreshAwsPreflight,
  assertImmutableEcrRelease,
  assertMigrationLineage,
  HISTORICAL_PRODUCTION_MIGRATIONS,
  assertRuntimeParity,
  assertWorkerHeartbeat,
  expectedRelease,
  loadContract,
} from "./release-policy.mjs"

const contract = loadContract()
const sha = "a".repeat(40)
const expected = expectedRelease(sha)

test("source checks ignore timestamp-only build changes but reject real edits and untracked directories", () => {
  const directory = mkdtempSync(join(tmpdir(), "finnor-git-regression-"))
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" })
  try {
    git("init", "--quiet")
    writeFileSync(join(directory, "asset.txt"), "original\n")
    git("add", ".")
    git("-c", "user.name=Release Test", "-c", "user.email=release@test.invalid", "commit", "-qm", "fixture")
    const later = new Date(Date.now() + 60_000)
    utimesSync(join(directory, "asset.txt"), later, later)
    assert.equal(worktreeStatus(directory), "")
    writeFileSync(join(directory, "asset.txt"), "modified\n")
    assert.match(worktreeStatus(directory), /asset\.txt/)
    git("add", "asset.txt")
    assert.match(worktreeStatus(directory), /asset\.txt/)
    mkdirSync(join(directory, "evidence"))
    writeFileSync(join(directory, "evidence", "sample.txt"), "fixture")
    assert.match(worktreeStatus(directory), /\?\? evidence\//)
    assert.doesNotMatch(worktreeStatus(directory), /sample\.txt/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("production history is accepted only with forward repair; unknown and newer migrations fail", () => {
  const head = "0126_pe_underwriting_runtime.sql"
  const repo = ["0104_core_vertical_runtime_boundary.sql", "0109_atomic_water_runtime_retirement.sql", head]
  assert.doesNotThrow(() => assertMigrationLineage(HISTORICAL_PRODUCTION_MIGRATIONS, repo, head))
  assert.doesNotThrow(() => assertMigrationLineage(repo, repo, head))
  assert.throws(() => assertMigrationLineage(["0108_unknown.sql"], repo, head), /absent/)
  assert.throws(() => assertMigrationLineage(["0127_future.sql"], [...repo, "0127_future.sql"], head), /head/)
  assert.throws(() => assertMigrationLineage(HISTORICAL_PRODUCTION_MIGRATIONS, ["0108_candidate.sql"], "0108_candidate.sql"), /newer|forward repair/)
  assert.throws(() => assertMigrationLineage(HISTORICAL_PRODUCTION_MIGRATIONS, ["0110_future.sql"], "0110_future.sql"), /forward repair/)
})

test("the Phase 8 production contract retains AWS ECS and requires both PE supplier canaries", () => {
  const worker = contract.topology.worker
  assert.equal(worker.provider, "aws-ecs-fargate")
  assert.equal(worker.accountId, "601804670058")
  assert.equal(worker.region, "us-east-1")
  assert.equal(worker.clusterName, "finnor-production")
  assert.equal(worker.serviceName, "finnor-worker")
  assert.equal(worker.sseGatewayUrl, "https://realtime.finnorai.com")
  assert.deepEqual(contract.release.requiredComponents, ["frontend", "api", "worker", "supplierCanaryApp", "supplierCanaryAuth"])
  assert.equal(contract.topology.supplierCanaryApp.portalRole, "app")
  assert.equal(contract.topology.supplierCanaryAuth.portalRole, "auth")
  assert.ok(contract.forbiddenActiveProviders.includes("azure"))
  assert.doesNotMatch(JSON.stringify(worker), /azure|systemd|RunCommand|cloudapp\.azure/i)
})

test("canonical release and AWS target guards fail closed", () => {
  assert.throws(() => assertCanonicalRelease({ head: sha, remoteMain: "b".repeat(40), dirty: "" }), /canonical remote main/)
  const target = { accountId: "601804670058", region: "us-east-1", clusterName: "finnor-production", serviceName: "finnor-worker", taskFamily: "finnor-worker", ecrRepository: "finnor-worker" }
  assert.doesNotThrow(() => assertAwsTarget(contract, target))
  assert.throws(() => assertAwsTarget(contract, { ...target, region: "eu-west-1" }), /AWS region/)
})

test("ECR, freshness, ECS, and ALB guards reject unsafe evidence", () => {
  const digest = `sha256:${"1".repeat(64)}`
  assert.equal(assertImmutableEcrRelease({ repository: { imageTagMutability: "IMMUTABLE" }, image: { imageDigest: digest, imageTags: [sha] }, expectedCommitSha: sha, expectedDigest: digest }), digest)
  assert.throws(() => assertImmutableEcrRelease({ repository: { imageTagMutability: "MUTABLE" }, image: { imageDigest: digest, imageTags: [sha] }, expectedCommitSha: sha }), /mutable/)
  const evidence = { ok: true, checkedAt: new Date(1_000).toISOString(), commitSha: sha, remoteMain: sha, contractSha256: "hash" }
  assert.equal(assertFreshAwsPreflight(evidence, { commitSha: sha, contractHash: "hash", now: 2_000 }), 1_000)
  assert.throws(() => assertFreshAwsPreflight({ ...evidence, contractSha256: "wrong" }, { commitSha: sha, contractHash: "hash", now: 2_000 }), /fresh/)
  const arn = "arn:aws:ecs:us-east-1:601804670058:task-definition/finnor-worker:2"
  assert.doesNotThrow(() => assertEcsDeploymentStable({ desiredCount: 1, runningCount: 1, pendingCount: 0, deployments: [{ status: "PRIMARY", taskDefinition: arn }] }, arn, 1))
  assert.throws(() => assertEcsDeploymentStable({ desiredCount: 1, runningCount: 1, pendingCount: 0, deployments: [] }, arn, 1), /stable/)
  assert.doesNotThrow(() => assertAlbTargetsHealthy([{ TargetHealth: { State: "healthy" } }]))
  assert.throws(() => assertAlbTargetsHealthy([]), /healthy/)
})

test("worker health and heartbeat guards bind the exact certified P7 release", () => {
  const body = { ok: true, realtime: true, capabilities: ["jobs", "orchestration", "realtime", "sse"], release: expected }
  assert.doesNotThrow(() => assertAwsWorkerHealth({ status: 200, body, expected }))
  assert.throws(() => assertAwsWorkerHealth({ status: 200, body: { ...body, release: { ...expected, commitSha: "b".repeat(40) } }, expected }), /exact release/)
  const heartbeat = { releaseSha: sha, buildId: expected.buildId, version: expected.version, releaseSource: expected.source, environment: expected.environment, migrationHead: contract.release.requiredMigrationHead, deploymentId: `ecs:finnor-production:finnor-worker:${sha}`, capabilities: body.capabilities, ageSeconds: 10 }
  assert.doesNotThrow(() => assertWorkerHeartbeat(heartbeat, expected, contract.release.requiredMigrationHead))
  assert.throws(() => assertWorkerHeartbeat({ ...heartbeat, deploymentId: "azure:old" }, expected, contract.release.requiredMigrationHead), /heartbeat/)
})

test("active release workflow retains the AWS worker and adds the governed Phase 8 cutover", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/production-release.yml", import.meta.url), "utf8")
  assert.doesNotMatch(workflow, /azure\/login|AZURE_|deploy-azure|RunCommand|cloudapp\.azure/i)
  assert.match(workflow, /aws-actions\/configure-aws-credentials@cbe3b392738ccf3f987d68400dafcf4b0624a56c/)
  assert.match(workflow, /docker build/)
  assert.match(workflow, /docker push/)
  assert.match(workflow, /deploy-aws-worker\.mjs/)
  assert.match(workflow, /deploy-production\.mjs supplierCanaryApp/)
  assert.match(workflow, /deploy-production\.mjs supplierCanaryAuth/)
  assert.match(workflow, /run-p8-production-water-retirement\.mjs/)
  assert.match(workflow, /phase5-readiness/)
  assert.match(workflow, /release:pe-p7-workforce-learning/)
  assert.match(workflow, /phase6-conversation-context-kernel\.test\.ts/)
  assert.doesNotMatch(workflow, /FINNOR_CORE_CERTIFICATION_FILE=|release:certify -- core/)
})

test("supplier canary builds are isolated from the finnor-os workspace lockfile", () => {
  const deployScript = readFileSync(new URL("./deploy-production.mjs", import.meta.url), "utf8")
  assert.match(deployScript, /isolateCanaryBuild = appName\.startsWith\("supplierCanary"\)/)
  assert.match(deployScript, /mkdtempSync\(join\(tmpdir\(\), "finnor-vercel-canary-"\)\)/)
  assert.match(deployScript, /cpSync\(appDir, buildDir, \{\s*recursive: true/)
  assert.match(deployScript, /worktreeStatus\(repoRoot\)/)
  assert.match(deployScript, /vercel", \["build"[\s\S]*buildDir/)
  assert.match(deployScript, /vercel", deployArgs, buildDir/)
})

test("supplier canary verification honors Vercel deployment protection", () => {
  const verifier = readFileSync(new URL("./verify-supplier-canary-release.mjs", import.meta.url), "utf8")
  assert.match(verifier, /VERCEL_AUTOMATION_BYPASS_SECRET/)
  assert.match(verifier, /x-vercel-protection-bypass/)
})

test("runtime parity requires the embedded orchestrator and exact migration", () => {
  const observed = {
    frontend: { ...expected, traceable: true },
    api: { ...expected, traceable: true },
    worker: { ...expected, traceable: true, capabilities: ["jobs", "orchestration", "realtime", "sse"] },
    supplierCanaryApp: { ...expected, traceable: true },
    supplierCanaryAuth: { ...expected, traceable: true },
    migrationHead: contract.release.requiredMigrationHead,
  }
  assert.doesNotThrow(() => assertRuntimeParity(contract, expected, observed))
  assert.throws(() => assertRuntimeParity(contract, expected, { ...observed, migrationHead: "0108_operating_product_closure.sql" }), /migration head/)
})

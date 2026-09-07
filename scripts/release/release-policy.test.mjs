import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  assertAlbTargetsHealthy,
  assertAwsTarget,
  assertAwsWorkerHealth,
  assertCanonicalRelease,
  assertEcsDeploymentStable,
  assertFreshAwsPreflight,
  assertImmutableEcrRelease,
  assertRuntimeParity,
  assertWorkerHeartbeat,
  expectedRelease,
  loadContract,
} from "./release-policy.mjs"

const contract = loadContract()
const sha = "a".repeat(40)
const expected = expectedRelease(sha)

test("the Phase 5 production contract is AWS ECS with no active Azure target", () => {
  const worker = contract.topology.worker
  assert.equal(worker.provider, "aws-ecs-fargate")
  assert.equal(worker.accountId, "601804670058")
  assert.equal(worker.region, "us-east-1")
  assert.equal(worker.clusterName, "finnor-production")
  assert.equal(worker.serviceName, "finnor-worker")
  assert.equal(worker.sseGatewayUrl, "https://realtime.finnorai.com")
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

test("worker health and heartbeat guards bind the exact Phase 5 release", () => {
  const body = { ok: true, realtime: true, capabilities: ["jobs", "orchestration", "realtime", "sse"], release: expected }
  assert.doesNotThrow(() => assertAwsWorkerHealth({ status: 200, body, expected }))
  assert.throws(() => assertAwsWorkerHealth({ status: 200, body: { ...body, release: { ...expected, commitSha: "b".repeat(40) } }, expected }), /exact release/)
  const heartbeat = { releaseSha: sha, buildId: expected.buildId, version: expected.version, releaseSource: expected.source, environment: expected.environment, migrationHead: "0109_atomic_water_runtime_retirement.sql", deploymentId: `ecs:finnor-production:finnor-worker:${sha}`, capabilities: body.capabilities, ageSeconds: 10 }
  assert.doesNotThrow(() => assertWorkerHeartbeat(heartbeat, expected, "0109_atomic_water_runtime_retirement.sql"))
  assert.throws(() => assertWorkerHeartbeat({ ...heartbeat, deploymentId: "azure:old" }, expected, "0109_atomic_water_runtime_retirement.sql"), /heartbeat/)
})

test("active release workflow is AWS-only and Phase 5-only", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/production-release.yml", import.meta.url), "utf8")
  assert.doesNotMatch(workflow, /azure\/login|AZURE_|deploy-azure|RunCommand|cloudapp\.azure/i)
  assert.match(workflow, /aws-actions\/configure-aws-credentials@v4/)
  assert.match(workflow, /docker build/)
  assert.match(workflow, /docker push/)
  assert.match(workflow, /deploy-aws-worker\.mjs/)
  assert.match(workflow, /phase5-readiness/)
  assert.match(workflow, /phase6-conversation-context-kernel\.test\.ts/)
  assert.doesNotMatch(workflow, /FINNOR_CORE_CERTIFICATION_FILE=|release:certify -- core/)
})

test("runtime parity requires the embedded orchestrator and exact migration", () => {
  const observed = {
    frontend: { ...expected, traceable: true },
    api: { ...expected, traceable: true },
    worker: { ...expected, traceable: true, capabilities: ["jobs", "orchestration", "realtime", "sse"] },
    migrationHead: "0109_atomic_water_runtime_retirement.sql",
  }
  assert.doesNotThrow(() => assertRuntimeParity(contract, expected, observed))
  assert.throws(() => assertRuntimeParity(contract, expected, { ...observed, migrationHead: "0108_operating_product_closure.sql" }), /migration head/)
})

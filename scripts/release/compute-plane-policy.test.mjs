import assert from "node:assert/strict"
import test from "node:test"
import { assertComputeFleetConverged, assertComputeRolloutChangeSet, assertComputeStageTransition, COMPUTE_CLASSES } from "./compute-plane-policy.mjs"

const sha = "a".repeat(40)
const digest = `sha256:${"b".repeat(64)}`
const now = Date.parse("2026-01-01T00:00:00Z")
const expected = { commitSha: sha, buildId: "finnor-aaaaaaaaaaaa", version: "0.1.0+aaaaaaaaaaaa", source: "github-actions", environment: "production" }
const migrationHead = "0141_restricted_digest_projection_access.sql"

function fixture() {
  const profiles = {}, services = {}, tasksByClass = {}, heartbeats = []
  for (const workloadClass of COMPUTE_CLASSES) {
    const lower = workloadClass.toLowerCase()
    const serviceName = `finnor-${lower}`
    const heartbeatService = `compute-${lower}`
    const taskArn = `arn:aws:ecs:us-east-1:123456789012:task/finnor-production/${lower}`
    const taskDefinition = `arn:aws:ecs:us-east-1:123456789012:task-definition/${serviceName}:1`
    profiles[workloadClass] = { serviceName, heartbeatService, containerName: serviceName, minTasks: 1, maxTasks: 2, workerConcurrency: workloadClass === "HEAVY" ? 1 : 2 }
    services[workloadClass] = { status: "ACTIVE", serviceName, launchType: "FARGATE", desiredCount: 1, runningCount: 1, pendingCount: 0, deployments: [{ status: "PRIMARY", taskDefinition, rolloutState: "COMPLETED" }] }
    tasksByClass[workloadClass] = [{ taskArn, taskDefinitionArn: taskDefinition, lastStatus: "RUNNING", containers: [{ name: serviceName, lastStatus: "RUNNING", healthStatus: "HEALTHY", imageDigest: digest }] }]
    heartbeats.push({ service: heartbeatService, instanceId: `ecs:${taskArn}`, releaseSha: sha, buildId: expected.buildId, version: expected.version, releaseSource: expected.source, environment: "production", migrationHead, deploymentId: `ecs:finnor-production:${lower}:${sha}`, capabilities: ["jobs"], lastBeatAt: new Date(now - 10_000).toISOString(), meta: { serviceClass: workloadClass, draining: false, taskArn, processConcurrency: profiles[workloadClass].workerConcurrency, allowedWorkloadClasses: [workloadClass] } })
  }
  return { profiles, services, tasksByClass, heartbeats, expected, imageDigest: digest, migrationHead, now }
}

test("all four classes require one-to-one healthy ECS task and current durable release evidence", () => {
  const state = fixture()
  assert.doesNotThrow(() => assertComputeFleetConverged(state))
  state.heartbeats[0].lastBeatAt = new Date(now - 120_000).toISOString()
  assert.throws(() => assertComputeFleetConverged(state), /stale or incompatible/)
})

test("a heartbeat from another task cannot stand in for a missing class task", () => {
  const state = fixture()
  state.heartbeats[1].instanceId = state.heartbeats[0].instanceId
  assert.throws(() => assertComputeFleetConverged(state), /one-to-one|not every/)
})

test("wrong digest, revision, or class capability blocks release convergence", () => {
  const state = fixture()
  state.tasksByClass.HEAVY[0].containers[0].imageDigest = `sha256:${"c".repeat(64)}`
  assert.throws(() => assertComputeFleetConverged(state), /digest mismatch/)
  state.tasksByClass.HEAVY[0].containers[0].imageDigest = digest
  state.heartbeats[3].meta.allowedWorkloadClasses = ["HEAVY", "INTERACTIVE"]
  assert.throws(() => assertComputeFleetConverged(state), /metadata is inconsistent/)
})

test("legacy infrastructure is removed only after a separate routing stage", () => {
  assert.doesNotThrow(() => assertComputeStageTransition({ from: "legacy", to: "preparing", changes: [] }))
  assert.doesNotThrow(() => assertComputeStageTransition({ from: "preparing", to: "routing", changes: [] }))
  assert.doesNotThrow(() => assertComputeStageTransition({ from: "routing", to: "finalized", changes: [{ ResourceChange: { Action: "Remove", LogicalResourceId: "WorkerService" } }] }))
  assert.throws(() => assertComputeStageTransition({ from: "preparing", to: "finalized", changes: [] }), /unsafe/)
  assert.throws(() => assertComputeStageTransition({ from: "preparing", to: "routing", changes: [{ ResourceChange: { Action: "Remove", LogicalResourceId: "WorkerService" } }] }), /unexpected resource/)
  assert.throws(() => assertComputeStageTransition({ from: "routing", to: "finalized", changes: [{ ResourceChange: { Action: "Remove", LogicalResourceId: "RealtimeService" } }] }), /unexpected resource/)
})

test("normal rollouts may change only all four class task definitions and services", () => {
  const taskChanges = ["Worker", "Interactive", "Background", "Heavy"].map((name) => ({ ResourceChange: { Action: "Modify", LogicalResourceId: `${name}TaskDefinition` } }))
  const serviceChanges = ["Realtime", "Interactive", "Background", "Heavy"].map((name) => ({ ResourceChange: { Action: "Modify", LogicalResourceId: `${name}Service` } }))
  assert.doesNotThrow(() => assertComputeRolloutChangeSet([...taskChanges, ...serviceChanges]))
  assert.throws(() => assertComputeRolloutChangeSet(taskChanges.slice(1)), /REALTIME task definition/)
  assert.throws(() => assertComputeRolloutChangeSet([...taskChanges, { ResourceChange: { Action: "Modify", LogicalResourceId: "GitHubActionsRole" } }]), /non-release resource/)
})

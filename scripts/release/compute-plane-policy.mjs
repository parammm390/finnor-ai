/** Pure Scope-3 release guards. The live deployer feeds these with independent
 * ECS and canonical-Postgres observations; no desired count is treated as proof
 * that the corresponding application task is healthy. */

export const COMPUTE_CLASSES = Object.freeze(["REALTIME", "INTERACTIVE", "BACKGROUND", "HEAVY"])
const COMPUTE_ROLLOUT_RESOURCES = new Set([
  "WorkerTaskDefinition", "InteractiveTaskDefinition", "BackgroundTaskDefinition", "HeavyTaskDefinition",
  "RealtimeService", "InteractiveService", "BackgroundService", "HeavyService",
])

export function assertComputeFleetConverged({ profiles, services, tasksByClass, heartbeats, expected, imageDigest, migrationHead, now = Date.now() }) {
  const failures = []
  if (!/^sha256:[0-9a-f]{64}$/i.test(imageDigest ?? "")) failures.push("immutable image digest is invalid")
  for (const workloadClass of COMPUTE_CLASSES) {
    const profile = profiles?.[workloadClass]
    const service = services?.[workloadClass]
    const tasks = tasksByClass?.[workloadClass] ?? []
    if (!profile || !service) { failures.push(`${workloadClass}: service/profile missing`); continue }
    const primary = service.deployments?.find((deployment) => deployment.status === "PRIMARY")
    if (service.status !== "ACTIVE" || service.serviceName !== profile.serviceName || service.launchType !== "FARGATE") failures.push(`${workloadClass}: wrong ECS service identity/state`)
    if (!Number.isInteger(service.desiredCount) || service.desiredCount < profile.minTasks || service.desiredCount > profile.maxTasks || service.runningCount !== service.desiredCount || service.pendingCount !== 0 || service.deployments?.length !== 1 || !primary?.taskDefinition || (primary.rolloutState && primary.rolloutState !== "COMPLETED")) failures.push(`${workloadClass}: ECS rollout is not stable within its capacity envelope`)
    if (tasks.length !== service.runningCount) failures.push(`${workloadClass}: ECS running task count differs from service count`)
    const taskArns = new Set()
    for (const task of tasks) {
      if (!task.taskArn || taskArns.has(task.taskArn) || task.lastStatus !== "RUNNING" || task.taskDefinitionArn !== primary?.taskDefinition) failures.push(`${workloadClass}: unexpected ECS task identity/revision`)
      taskArns.add(task.taskArn)
      const container = task.containers?.find((entry) => entry.name === profile.containerName)
      if (!container || container.lastStatus !== "RUNNING" || container.healthStatus !== "HEALTHY" || container.imageDigest !== imageDigest) failures.push(`${workloadClass}: ECS container health/digest mismatch`)
    }
    const classHeartbeats = (heartbeats ?? []).filter((heartbeat) => heartbeat.service === profile.heartbeatService)
    const attested = new Set()
    for (const heartbeat of classHeartbeats) {
      const ageMs = now - Date.parse(heartbeat.lastBeatAt ?? "")
      const taskArn = heartbeat.instanceId?.startsWith("ecs:") ? heartbeat.instanceId.slice(4) : null
      if (!taskArn || !taskArns.has(taskArn) || attested.has(taskArn)) failures.push(`${workloadClass}: heartbeat does not map one-to-one to a running ECS task`)
      attested.add(taskArn)
      if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 45_000 || heartbeat.releaseSha !== expected.commitSha || heartbeat.buildId !== expected.buildId || heartbeat.version !== expected.version || heartbeat.releaseSource !== expected.source || heartbeat.environment !== expected.environment || heartbeat.migrationHead !== migrationHead || heartbeat.deploymentId?.startsWith("ecs:") !== true || !heartbeat.capabilities?.includes("jobs")) failures.push(`${workloadClass}: release heartbeat is stale or incompatible`)
      if (heartbeat.meta?.serviceClass !== workloadClass || heartbeat.meta?.draining !== false || heartbeat.meta?.taskArn !== taskArn || heartbeat.meta?.processConcurrency !== profile.workerConcurrency || JSON.stringify(heartbeat.meta?.allowedWorkloadClasses) !== JSON.stringify([workloadClass])) failures.push(`${workloadClass}: class/slot heartbeat metadata is inconsistent`)
    }
    if (attested.size !== taskArns.size) failures.push(`${workloadClass}: not every running task has fresh release evidence`)
  }
  if (failures.length) throw new Error(`compute fleet is not converged:\n${failures.join("\n")}`)
}

export function assertComputeStageTransition({ from, to, changes }) {
  const allowed = { legacy: ["preparing"], preparing: ["routing"], routing: ["finalized"], finalized: ["finalized"] }
  if (!allowed[from]?.includes(to)) throw new Error(`unsafe compute stage transition ${from} -> ${to}`)
  const deleted = (changes ?? []).filter((change) => change.ResourceChange?.Action === "Remove").map((change) => change.ResourceChange.LogicalResourceId)
  const permittedRemovals = to === "finalized" ? new Set(["WorkerService", "WorkerTargetGroup", "LegacyDrainListenerRule"]) : new Set()
  if (deleted.some((name) => !permittedRemovals.has(name)) || (to !== "finalized" && deleted.length)) throw new Error(`compute change set removes an unexpected resource: ${deleted.join(", ")}`)
  if (to === "routing") {
    const permitted = new Set(["HttpsRealtimeListener", "LegacyDrainListenerRule"])
    const unexpected = (changes ?? []).filter((change) => !permitted.has(change.ResourceChange?.LogicalResourceId))
    if (unexpected.length) throw new Error("routing change set is not an ingress-only switch")
  }
  if (to === "finalized" && (changes ?? []).some((change) => change.ResourceChange?.Action !== "Remove")) {
    throw new Error("finalization may only remove retired legacy resources")
  }
}

export function assertComputeRolloutChangeSet(changes) {
  const resourceChanges = (changes ?? []).map((change) => change.ResourceChange).filter(Boolean)
  if (resourceChanges.length === 0) throw new Error("compute rollout contains no resource changes")
  const unexpected = resourceChanges.filter((change) => change.Action === "Remove" || !COMPUTE_ROLLOUT_RESOURCES.has(change.LogicalResourceId))
  if (unexpected.length) throw new Error(`compute rollout changes a non-release resource: ${unexpected.map((change) => change.LogicalResourceId).join(", ")}`)
  for (const workloadClass of COMPUTE_CLASSES) {
    const family = workloadClass === "REALTIME" ? "Worker" : workloadClass[0] + workloadClass.slice(1).toLowerCase()
    if (!resourceChanges.some((change) => change.LogicalResourceId === `${family}TaskDefinition`)) {
      throw new Error(`${workloadClass} task definition is absent from the rollout change set`)
    }
  }
}

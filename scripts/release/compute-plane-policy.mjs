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

// A provider no-change failure is a candidate, never sufficient release proof.
// Keep this separate from the nonempty rollout and ingress/removal allowlists.
export const COMPUTE_NO_CHANGE_REASON = "The submitted information didn't contain changes. Submit different information to create a change set."

export function assertComputeNoopCandidate({ stage, currentStage, nextStage, changeSet }) {
  if (stage !== "rollout" || currentStage !== "finalized" || nextStage !== "finalized"
    || changeSet?.Status !== "FAILED" || changeSet.StatusReason !== COMPUTE_NO_CHANGE_REASON
    || (changeSet.Changes !== undefined && (!Array.isArray(changeSet.Changes) || changeSet.Changes.length !== 0))) {
    throw new Error("compute change set is not the exact finalized no-change candidate")
  }
}

export function assertComputeNoopStack({ stack, expectedParameters, previousStackId, expectedTemplateSha256, deployedTemplateSha256 }) {
  if (!stack?.StackId || stack.StackId !== previousStackId || stack.RoleARN
    || !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus)) {
    throw new Error("compute no-op requires the same independently stable stack")
  }
  const parameters = Object.fromEntries((stack.Parameters ?? []).map((entry) => [entry.ParameterKey, entry.ParameterValue]))
  if (parameters.ComputePlaneStage !== "finalized"
    || Object.entries(expectedParameters).some(([key, value]) => parameters[key] !== value)) {
    throw new Error("compute no-op stack parameters differ from the exact release")
  }
  if (!/^[0-9a-f]{64}$/.test(expectedTemplateSha256 ?? "") || deployedTemplateSha256 !== expectedTemplateSha256) {
    throw new Error("compute no-op deployed template differs from the requested template")
  }
}

export function assertComputeNoopFleet({ profiles, services, tasksByClass, taskDefinitions, heartbeats, expected, imageDigest, imageUri, migrationHead, coreCertificationId, worker, targetGroup, targetHealth }) {
  assertComputeFleetConverged({ profiles, services, tasksByClass, heartbeats, expected, imageDigest, migrationHead })
  const definitions = []
  for (const workloadClass of COMPUTE_CLASSES) {
    const profile = profiles[workloadClass]
    const service = services[workloadClass]
    const definition = taskDefinitions[workloadClass]
    const container = definition?.containerDefinitions?.find((entry) => entry.name === profile.containerName)
    const environment = Object.fromEntries((container?.environment ?? []).map((entry) => [entry.name, entry.value]))
    const metadata = {
      FINNOR_COMMIT_SHA: expected.commitSha, FINNOR_BUILD_ID: expected.buildId,
      FINNOR_VERSION: expected.version, FINNOR_ENVIRONMENT: expected.environment,
      FINNOR_RELEASE_SOURCE: expected.source, FINNOR_CORE_CERTIFICATION_ID: coreCertificationId,
      FINNOR_WORKLOAD_CLASS: workloadClass,
    }
    if (!definition?.taskDefinitionArn || definition.taskDefinitionArn !== service.taskDefinition
      || service.taskDefinition !== service.deployments?.find((deployment) => deployment.status === "PRIMARY")?.taskDefinition
      || definition.family !== profile.taskFamily
      || definition.executionRoleArn !== `arn:aws:iam::${worker.accountId}:role/${worker.executionRoleName}`
      || definition.taskRoleArn !== `arn:aws:iam::${worker.accountId}:role/${profile.taskRoleName}`
      || container?.image !== imageUri
      || Object.entries(metadata).some(([name, value]) => environment[name] !== value)) {
      throw new Error(`${workloadClass}: compute no-op task definition is not the exact release`)
    }
    definitions.push(definition.taskDefinitionArn)
  }
  if (new Set(definitions).size !== COMPUTE_CLASSES.length) throw new Error("compute no-op class task definitions are not distinct")
  const ips = (tasksByClass.REALTIME ?? []).flatMap((task) =>
    (task.attachments ?? []).flatMap((attachment) =>
      (attachment.details ?? []).filter((detail) => detail.name === "privateIPv4Address").map((detail) => detail.value)))
  if (ips.length !== tasksByClass.REALTIME.length || new Set(ips).size !== ips.length || ips.some((ip) => typeof ip !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(ip))
    || targetGroup?.TargetType !== "ip" || targetGroup.VpcId !== worker.vpcId
    || targetGroup.Port !== worker.containerPort || targetGroup.HealthCheckPath !== "/healthz" || targetGroup.HealthCheckProtocol !== "HTTP"
    || !Array.isArray(targetHealth) || targetHealth.length !== ips.length
    || new Set(targetHealth.map((entry) => entry.Target?.Id)).size !== ips.length
    || targetHealth.some((entry) => !ips.includes(entry.Target?.Id) || entry.Target?.Port !== worker.containerPort || entry.TargetHealth?.State !== "healthy")) {
    throw new Error("compute no-op REALTIME ALB targets do not map exactly to the healthy current tasks")
  }
  return definitions
}

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/
export const CONTRACT_PATH = resolve(fileURLToPath(new URL("../../infra/deployment/production.contract.json", import.meta.url)))

export function loadContract(path = CONTRACT_PATH) {
  return JSON.parse(readFileSync(path, "utf8"))
}

export function assertCanonicalRelease({ head, remoteMain, dirty }) {
  if (!FULL_COMMIT_SHA.test(head)) throw new Error(`HEAD is not a full commit SHA: ${head}`)
  if (head !== remoteMain) throw new Error(`release SHA ${head} is not canonical remote main ${remoteMain || "<missing>"}`)
  if (dirty) throw new Error("production release requires a clean worktree")
}

export function expectedRelease(commitSha, source = "github-actions") {
  if (!FULL_COMMIT_SHA.test(commitSha)) throw new Error(`invalid release SHA: ${commitSha}`)
  const shortSha = commitSha.slice(0, 12)
  return {
    commitSha,
    buildId: `finnor-${shortSha}`,
    version: `0.1.0+${shortSha}`,
    environment: "production",
    source,
  }
}

export function assertDeploymentPlan(contract, deployedComponents) {
  const required = new Set(contract.release.requiredComponents)
  if (contract.topology.orchestrator.separateDeployment) required.add("orchestrator")
  const deployed = new Set(deployedComponents)
  const missing = [...required].filter((component) => !deployed.has(component))
  if (missing.length) throw new Error(`release omitted required component(s): ${missing.join(", ")}`)
}

export function assertResolvedTarget(label, expected, observed, keys) {
  const failures = keys.flatMap((key) => {
    const expectedValue = expected[key]
    const observedValue = observed?.[key]
    if (typeof expectedValue === "string" && typeof observedValue === "string") {
      return expectedValue.toLowerCase() === observedValue.toLowerCase() ? [] : [`${key}: ${observedValue} != ${expectedValue}`]
    }
    return observedValue === expectedValue ? [] : [`${key}: ${observedValue ?? "<missing>"} != ${expectedValue ?? "<missing>"}`]
  })
  if (failures.length) throw new Error(`${label} target differs from canonical contract:\n${failures.join("\n")}`)
}

export function assertAwsTarget(contract, observed) {
  const target = contract.topology.worker
  for (const [key, expected] of Object.entries({
    accountId: target.accountId,
    region: target.region,
    clusterName: target.clusterName,
    serviceName: target.serviceName,
    taskFamily: target.taskFamily,
    ecrRepository: target.ecrRepository,
  })) {
    if (observed?.[key] !== expected) throw new Error(`AWS ${key} ${observed?.[key] ?? "<missing>"} differs from canonical ${expected}`)
  }
}

export function assertImmutableEcrRelease({ repository, image, expectedCommitSha, expectedDigest }) {
  if (repository?.imageTagMutability !== "IMMUTABLE") throw new Error("ECR repository is mutable")
  if (!image?.imageDigest || !image.imageTags?.includes(expectedCommitSha)) throw new Error(`ECR image tag ${expectedCommitSha} is missing`)
  if (expectedDigest && image.imageDigest !== expectedDigest) throw new Error(`ECR digest ${image.imageDigest} differs from ${expectedDigest}`)
  return image.imageDigest
}

export function assertFreshAwsPreflight(evidence, { commitSha, contractHash, now = Date.now(), maxAgeMs = 20 * 60 * 1000 }) {
  const ageMs = now - Date.parse(evidence?.checkedAt ?? "")
  if (evidence?.ok !== true || evidence.commitSha !== commitSha || evidence.remoteMain !== commitSha || evidence.contractSha256 !== contractHash || !Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) {
    throw new Error("AWS deployment requires fresh, matching production preflight evidence")
  }
  return ageMs
}

export function assertAwsWorkerHealth({ status, body, expected, requiredCapabilities = ["jobs", "orchestration", "realtime", "sse"] }) {
  if (status !== 200 || body?.ok !== true || body.realtime !== true || body.release?.commitSha !== expected.commitSha) throw new Error("worker /healthz did not prove the exact release")
  for (const [field, value] of [["buildId", expected.buildId], ["version", expected.version], ["environment", expected.environment], ["source", expected.source]]) {
    if (body.release?.[field] !== value) throw new Error(`worker /healthz ${field} mismatch`)
  }
  for (const capability of requiredCapabilities) if (!body.capabilities?.includes(capability)) throw new Error(`worker /healthz is missing ${capability} capability`)
}

export function assertEcsDeploymentStable(service, taskDefinitionArn, desiredCount) {
  const primary = service?.deployments?.find((deployment) => deployment.status === "PRIMARY")
  if (service?.desiredCount !== desiredCount || service.runningCount !== desiredCount || service.pendingCount !== 0 || primary?.taskDefinition !== taskDefinitionArn || service.deployments?.length !== 1) {
    throw new Error("ECS deployment is not stable on the requested task definition")
  }
}

export function assertAlbTargetsHealthy(targets) {
  if (!Array.isArray(targets) || targets.length === 0 || targets.some((target) => target.TargetHealth?.State !== "healthy")) throw new Error("ALB target did not become healthy")
}

export function assertWorkerHeartbeat(heartbeat, expected, migrationHead, requiredCapabilities = ["jobs", "orchestration", "realtime", "sse"], coreCertificationId) {
  const releaseSha = heartbeat?.releaseSha ?? heartbeat?.commitSha
  const releaseSource = heartbeat?.releaseSource ?? heartbeat?.source
  const ageSeconds = Number(heartbeat?.ageSeconds)
  if (!heartbeat || releaseSha !== expected.commitSha || heartbeat.buildId !== expected.buildId || heartbeat.version !== expected.version || releaseSource !== expected.source || heartbeat.environment !== expected.environment || (coreCertificationId && heartbeat.coreCertificationId !== coreCertificationId) || heartbeat.migrationHead !== migrationHead || heartbeat.deploymentId?.startsWith("ecs:") !== true || !Number.isFinite(ageSeconds) || ageSeconds > 120 || requiredCapabilities.some((capability) => !heartbeat.capabilities?.includes(capability))) {
    throw new Error("worker heartbeat did not prove the exact ECS release")
  }
}

export function assertRuntimeParity(contract, expected, observed) {
  const failures = []
  if (contract.topology.orchestrator.separateDeployment === false && contract.topology.orchestrator.releaseIdentity !== "worker") {
    failures.push("embedded orchestrator must inherit worker release identity")
  }
  for (const component of contract.release.requiredComponents) {
    const release = observed[component]
    if (!release) {
      failures.push(`${component}: missing release evidence`)
      continue
    }
    for (const key of ["commitSha", "buildId", "version", "environment", "source"]) {
      const expectedValue = expected[key]
      if (release[key] !== expectedValue) failures.push(`${component}.${key}: ${release[key] ?? "<missing>"} != ${expectedValue ?? "<missing>"}`)
    }
    if (release.traceable !== true) failures.push(`${component}: release metadata is not traceable`)
  }
  if (!observed.worker?.capabilities?.includes(contract.topology.orchestrator.requiredCapability)) {
    failures.push("worker release does not prove the embedded orchestrator capability")
  }
  if (observed.migrationHead !== contract.release.requiredMigrationHead) {
    failures.push(`database migration head: ${observed.migrationHead ?? "<missing>"} != ${contract.release.requiredMigrationHead}`)
  }
  if (failures.length) throw new Error(`release parity failed:\n${failures.join("\n")}`)
}

export function readGitRelease(repoRoot = process.cwd(), contract = loadContract()) {
  const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()
  const head = git(["rev-parse", "HEAD"]).toLowerCase()
  const dirty = git(["status", "--porcelain=v1", "--untracked-files=all"])
  const { remote, branch } = contract.canonicalGit
  const remoteMain = git(["ls-remote", remote, `refs/heads/${branch}`]).split(/\s+/)[0]?.toLowerCase() ?? ""
  return { head, remoteMain, dirty }
}

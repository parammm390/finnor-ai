import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertComputeFleetConverged, assertComputeRolloutChangeSet, assertComputeStageTransition, COMPUTE_CLASSES } from "./compute-plane-policy.mjs"
import { assertCanonicalRelease, assertFreshAwsPreflight, expectedRelease, loadContract, readGitRelease } from "./release-policy.mjs"
import { authorizeProductionMutation } from "./production-mutation-guard.mjs"
import { readProtectedEnvValue } from "./protected-env.mjs"
import { pgConnectionConfig } from "../../finnor-os/packages/db/postgres-connection.mjs"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const contract = loadContract()
const worker = contract.topology.worker
const profiles = contract.topology.computePlane.classes
const args = Object.fromEntries(process.argv.slice(2).filter((part) => part.startsWith("--")).map((part) => {
  const [key, value] = part.slice(2).split("=", 2)
  return [key, value]
}))
const stage = args.stage
if (!["preparing", "routing", "finalized", "rollout"].includes(stage)) throw new Error("--stage must be preparing, routing, finalized, or rollout")
if (!args["database-env"] || !existsSync(args["database-env"])) throw new Error("--database-env must name the protected production database environment")
if (!/^sha256:[0-9a-f]{64}$/i.test(args["image-digest"] ?? "")) throw new Error("--image-digest must pin an immutable ECR digest")
const imageDigest = args["image-digest"]
const release = readGitRelease(repoRoot, contract)
assertCanonicalRelease(release)
const expected = expectedRelease(release.head, process.env.FINNOR_RELEASE_SOURCE || "github-actions")
if (worker.region !== "us-east-1" || process.env.AWS_REGION !== worker.region) throw new Error("selected AWS Region differs from the production contract")
const templatePath = resolve(repoRoot, "infra/aws/finnor-production.yaml")
const template = readFileSync(templatePath)
if (template.byteLength > 51_200) throw new Error("CloudFormation inline template exceeds 51,200 bytes; package it in governed S3 before deployment")
const contractHash = createHash("sha256").update(readFileSync(resolve(repoRoot, "infra/deployment/production.contract.json"))).digest("hex")

function aws(service, command, options = {}) {
  const output = execFileSync("aws", [service, ...command, "--region", worker.region, "--output", "json", "--no-cli-pager"], {
    encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: options.timeout ?? 90_000,
    env: { ...process.env, AWS_PAGER: "" },
  })
  return output.trim() ? JSON.parse(output) : {}
}
const pause = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
const identity = aws("sts", ["get-caller-identity"])
if (identity.Account !== worker.accountId) throw new Error("AWS project differs from the production contract")
const image = aws("ecr", ["describe-images", "--repository-name", worker.ecrRepository, "--image-ids", `imageTag=${expected.commitSha}`]).imageDetails?.[0]
if (image?.imageDigest !== imageDigest) throw new Error("ECR release tag does not resolve to the requested digest")
const imageUri = `${worker.accountId}.dkr.ecr.${worker.region}.amazonaws.com/${worker.ecrRepository}@${imageDigest}`
const stack = aws("cloudformation", ["describe-stacks", "--stack-name", worker.stackName]).Stacks?.[0]
if (!stack || !["CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE"].includes(stack.StackStatus) || stack.RoleARN) throw new Error("production stack is missing, unstable, or uses an unexpected service role")
const stackParameters = Object.fromEntries((stack.Parameters ?? []).map((parameter) => [parameter.ParameterKey, parameter.ParameterValue]))
const currentStage = stackParameters.ComputePlaneStage ?? "legacy"
const requestedStage = stage === "rollout" ? "finalized" : stage
if (stage === "rollout" && currentStage !== "finalized") throw new Error("normal class rollout requires a finalized legacy cutover")
if (stage !== "rollout") assertComputeStageTransition({ from: currentStage, to: requestedStage, changes: [] })
const coreCertificationId = process.env.FINNOR_CORE_CERTIFICATION_ID?.trim() || `post-merge:${expected.commitSha}`
if (coreCertificationId.length > 128) throw new Error("core certification identity is too long")

const requireFromOs = createRequire(new URL("../../finnor-os/package.json", import.meta.url))
const pg = requireFromOs("pg")
const databaseUrl = readProtectedEnvValue(args["database-env"], "MIGRATIONS_DATABASE_URL", { fallbackKey: "DATABASE_URL" })
const parsedDatabase = new URL(databaseUrl)
if (parsedDatabase.hostname !== contract.topology.database.host) throw new Error("production database host differs from the contract")
if (!parsedDatabase.username.endsWith(`.${new URL(contract.topology.database.supabaseUrl).hostname.split(".")[0]}`)) {
  throw new Error("database project reference differs from the canonical Supabase auth project")
}
const client = new pg.Client({ ...pgConnectionConfig(databaseUrl), connectionTimeoutMillis: 15_000 })
await client.connect()
try {
  const migration = await client.query("SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1")
  if (migration.rows[0]?.name !== contract.release.requiredMigrationHead) throw new Error("compute deployment requires the exact production migration head")
  const cutover = await client.query("SELECT state,accepted_job_epoch,minimum_claim_epoch,activated_release_sha FROM finnor_os.compute_plane_cutover WHERE singleton=true")
  const databaseStage = cutover.rows[0]
  if (!databaseStage) throw new Error("compute cutover singleton is missing")

  async function observeFleet() {
    const names = COMPUTE_CLASSES.map((workloadClass) => profiles[workloadClass].serviceName)
    const found = aws("ecs", ["describe-services", "--cluster", worker.clusterName, "--services", ...names]).services ?? []
    const services = Object.fromEntries(COMPUTE_CLASSES.map((workloadClass) => [workloadClass, found.find((service) => service.serviceName === profiles[workloadClass].serviceName)]))
    const tasksByClass = {}
    for (const workloadClass of COMPUTE_CLASSES) {
      const arns = aws("ecs", ["list-tasks", "--cluster", worker.clusterName, "--service-name", profiles[workloadClass].serviceName, "--desired-status", "RUNNING"]).taskArns ?? []
      tasksByClass[workloadClass] = arns.length ? aws("ecs", ["describe-tasks", "--cluster", worker.clusterName, "--tasks", ...arns]).tasks ?? [] : []
    }
    const beats = await client.query(`
      SELECT service,instance_id AS "instanceId",release_sha AS "releaseSha",build_id AS "buildId",
             version,release_source AS "releaseSource",environment,migration_head AS "migrationHead",
             deployment_id AS "deploymentId",capabilities,h.last_beat_at AS "lastBeatAt",w.meta
        FROM finnor_os.service_release_heartbeats h
        JOIN finnor_os.worker_heartbeat w ON w.id=h.instance_id
       WHERE service=ANY($1::text[]) AND h.last_beat_at>now()-interval '45 seconds'`,
      [COMPUTE_CLASSES.map((workloadClass) => profiles[workloadClass].heartbeatService)],
    )
    assertComputeFleetConverged({ profiles, services, tasksByClass, heartbeats: beats.rows,
      expected, imageDigest, migrationHead: contract.release.requiredMigrationHead })
    const targets = aws("elbv2", ["describe-target-groups", "--names", profiles.REALTIME.serviceName]).TargetGroups ?? []
    if (targets.length !== 1) throw new Error("REALTIME target group is missing")
    const health = aws("elbv2", ["describe-target-health", "--target-group-arn", targets[0].TargetGroupArn]).TargetHealthDescriptions ?? []
    if (health.length < profiles.REALTIME.minTasks || health.some((target) => target.TargetHealth?.State !== "healthy")) throw new Error("REALTIME ALB targets are not all healthy")
    return { serviceNames: names, taskCounts: Object.fromEntries(COMPUTE_CLASSES.map((workloadClass) => [workloadClass, tasksByClass[workloadClass].length])), targetCount: health.length }
  }

  async function waitForFleet() {
    const deadline = Date.now() + 15 * 60_000
    let lastError
    while (Date.now() < deadline) {
      try { return await observeFleet() } catch (error) { lastError = error; await pause(5_000) }
    }
    throw new Error(`four-class fleet did not converge: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  }

  async function prepareStackChange(nextStage, legacyTaskArn) {
    const changesetName = `finnor-compute-${nextStage}-${expected.commitSha.slice(0, 12)}-${Date.now()}`
    const overrides = {
      ImageUri: imageUri, ReleaseCommitSha: expected.commitSha, ReleaseBuildId: expected.buildId,
      ReleaseVersion: expected.version, CoreCertificationId: coreCertificationId,
      SupabaseUrl: contract.topology.database.supabaseUrl, ComputePlaneStage: nextStage,
      LegacyWorkerTaskDefinitionArn: legacyTaskArn,
    }
    const parameters = Object.entries(overrides).map(([key, value]) => `ParameterKey=${key},ParameterValue=${value}`)
    const preserved = ["VpcId", "PublicSubnet1", "PublicSubnet2", "CertificateArn", "GitHubOidcProviderArn", "GitHubOwner", "GitHubRepositoryName", "GitHubOwnerId", "GitHubRepositoryId", "GitHubEnvironment", "SecretMap", "RealtimeSecretMap", "HeavySecretMap", "SseAllowedOrigins"]
    for (const key of preserved) if (key in stackParameters) parameters.push(`ParameterKey=${key},UsePreviousValue=true`)
    aws("cloudformation", ["create-change-set", "--stack-name", worker.stackName, "--change-set-name", changesetName,
      "--change-set-type", "UPDATE", "--template-body", `file://${templatePath}`, "--capabilities", "CAPABILITY_NAMED_IAM", "--parameters", ...parameters])
    let changeSet
    const deadline = Date.now() + 3 * 60_000
    while (Date.now() < deadline) {
      changeSet = aws("cloudformation", ["describe-change-set", "--stack-name", worker.stackName, "--change-set-name", changesetName])
      if (changeSet.Status === "CREATE_COMPLETE" || changeSet.Status === "FAILED") break
      await pause(3_000)
    }
    if (changeSet?.Status !== "CREATE_COMPLETE") throw new Error(`compute change set failed: ${changeSet?.StatusReason ?? "timed out"}`)
    if (stage === "rollout" || (stage === "routing" && nextStage === "preparing")) assertComputeRolloutChangeSet(changeSet.Changes)
    else assertComputeStageTransition({ from: currentStage, to: nextStage, changes: changeSet.Changes })
    if (nextStage === "routing" && !changeSet.Changes?.some((change) => change.ResourceChange?.LogicalResourceId === "HttpsRealtimeListener")) throw new Error("routing change set omitted the authoritative listener switch")
    return { changesetName, changes: changeSet.Changes }
  }

  async function executeStackChange(prepared) {
    aws("cloudformation", ["execute-change-set", "--stack-name", worker.stackName, "--change-set-name", prepared.changesetName])
    const updateDeadline = Date.now() + 20 * 60_000
    while (Date.now() < updateDeadline) {
      const latest = aws("cloudformation", ["describe-stacks", "--stack-name", worker.stackName]).Stacks?.[0]
      if (latest?.StackStatus === "UPDATE_COMPLETE") return prepared.changes
      if (latest?.StackStatus?.includes("FAILED") || latest?.StackStatus?.includes("ROLLBACK")) throw new Error(`compute stack update failed: ${latest.StackStatus}`)
      await pause(5_000)
    }
    throw new Error("compute stack update timed out")
  }

  if (stage === "preparing") {
    const evidencePath = args["preflight-evidence"]
    if (!evidencePath || !existsSync(evidencePath)) throw new Error("preparing requires fresh protected preflight evidence")
    assertFreshAwsPreflight(JSON.parse(readFileSync(evidencePath, "utf8")), { commitSha: expected.commitSha, contractHash })
    if (databaseStage.state !== "preparing" || currentStage !== "legacy") throw new Error("first compute prepare requires legacy stack and preparing database fence")
    const legacy = aws("ecs", ["describe-services", "--cluster", worker.clusterName, "--services", worker.serviceName]).services?.[0]
    if (legacy?.status !== "ACTIVE" || legacy.runningCount !== 1 || !legacy.taskDefinition?.includes(`:task-definition/${worker.taskFamily}:`)) throw new Error("legacy worker is not a stable task-definition-pinned service")
    await authorizeProductionMutation("aws-compute-stack-deploy")
    const prepared = await prepareStackChange("preparing", legacy.taskDefinition)
    await executeStackChange(prepared)
    const fleet = await waitForFleet()
    console.log(JSON.stringify({ ok: true, stage: "preparing", release: expected.commitSha, imageDigest, fleet }))
  } else if (stage === "routing") {
    const activating = databaseStage.state === "preparing"
    const recovering = databaseStage.state === "authoritative" && databaseStage.activated_release_sha === expected.commitSha
    if (currentStage !== "preparing" || (!activating && !recovering)) throw new Error("routing requires a prepared stack and either an unactivated fence or same-release recovery")
    if (activating && stackParameters.ReleaseCommitSha !== expected.commitSha) {
      await authorizeProductionMutation("aws-compute-stack-deploy")
      const refreshed = await prepareStackChange("preparing", stackParameters.LegacyWorkerTaskDefinitionArn)
      await executeStackChange(refreshed)
    }
    const fleet = await waitForFleet()
    await authorizeProductionMutation("aws-compute-stack-deploy")
    // Validate the exact ingress-only change before the forward-only database fence.
    // If execution later fails, a same-release rerun can safely resume routing.
    const prepared = await prepareStackChange("routing", stackParameters.LegacyWorkerTaskDefinitionArn)
    if (activating) {
      await authorizeProductionMutation("compute-cutover-activate")
      await client.query("BEGIN")
      try {
        const changed = await client.query(`
          UPDATE finnor_os.compute_plane_cutover
             SET state='authoritative',accepted_job_epoch=3,minimum_claim_epoch=3,
                 enforce_known_job_types=true,activated_release_sha=$1,
                 activated_at=clock_timestamp(),updated_at=clock_timestamp()
           WHERE singleton=true AND state='preparing' AND minimum_claim_epoch=1
           RETURNING state`, [expected.commitSha])
        if (changed.rowCount !== 1) throw new Error("compute authority activation lost its singleton compare-and-set")
        await client.query("COMMIT")
      } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error }
    }
    await executeStackChange(prepared)
    console.log(JSON.stringify({ ok: true, stage: "routing", release: expected.commitSha, imageDigest, fleet }))
  } else if (stage === "finalized") {
    if (currentStage !== "routing" || databaseStage.state !== "authoritative" || databaseStage.activated_release_sha !== expected.commitSha) throw new Error("finalization requires the exact release to own class-aware authority and ingress")
    const fleet = await waitForFleet()
    const oldRunning = await client.query(`
      SELECT count(*)::int AS count
        FROM finnor_os.jobs j
       WHERE j.status='running'
         AND NOT EXISTS (
           SELECT 1 FROM finnor_os.worker_heartbeat w
            WHERE w.id=j.lease_owner
              AND w.last_beat_at>now()-interval '45 seconds'
              AND w.meta->>'serviceClass'=ANY($1::text[]))`, [COMPUTE_CLASSES])
    if (Number(oldRunning.rows[0]?.count) !== 0) throw new Error("legacy worker still owns in-flight durable jobs")
    await authorizeProductionMutation("compute-cutover-finalize")
    aws("ecs", ["update-service", "--cluster", worker.clusterName, "--service", worker.serviceName, "--desired-count", "0"])
    const stopDeadline = Date.now() + 5 * 60_000
    while (Date.now() < stopDeadline) {
      const old = aws("ecs", ["describe-services", "--cluster", worker.clusterName, "--services", worker.serviceName]).services?.[0]
      if (old?.runningCount === 0 && old.pendingCount === 0) break
      await pause(5_000)
    }
    const old = aws("ecs", ["describe-services", "--cluster", worker.clusterName, "--services", worker.serviceName]).services?.[0]
    if (old?.runningCount !== 0 || old.pendingCount !== 0) throw new Error("legacy worker tasks did not drain")
    const postStop = await client.query(`
      SELECT count(*)::int AS count
        FROM finnor_os.jobs j
       WHERE j.status='running'
         AND NOT EXISTS (
           SELECT 1 FROM finnor_os.worker_heartbeat w
            WHERE w.id=j.lease_owner
              AND w.last_beat_at>now()-interval '45 seconds'
              AND w.meta->>'serviceClass'=ANY($1::text[]))`, [COMPUTE_CLASSES])
    if (Number(postStop.rows[0]?.count) !== 0) throw new Error("legacy task shutdown left a durable job in flight; reconcile before finalization")
    await client.query("UPDATE finnor_os.compute_plane_cutover SET legacy_tenant_writes_allowed=false,updated_at=clock_timestamp() WHERE singleton=true AND state='authoritative'")
    await authorizeProductionMutation("aws-compute-stack-deploy")
    const prepared = await prepareStackChange("finalized", stackParameters.LegacyWorkerTaskDefinitionArn)
    await executeStackChange(prepared)
    console.log(JSON.stringify({ ok: true, stage: "finalized", release: expected.commitSha, imageDigest, fleet }))
  } else {
    if (databaseStage.state !== "authoritative" || currentStage !== "finalized") throw new Error("four-class rollout requires finalized authority")
    await authorizeProductionMutation("aws-compute-stack-deploy")
    const prepared = await prepareStackChange("finalized", stackParameters.LegacyWorkerTaskDefinitionArn ?? "")
    await executeStackChange(prepared)
    const fleet = await waitForFleet()
    console.log(JSON.stringify({ ok: true, stage: "rollout", release: expected.commitSha, imageDigest, fleet }))
  }
} finally {
  await client.end()
}

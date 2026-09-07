import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertAlbTargetsHealthy, assertAwsTarget, assertAwsWorkerHealth, assertCanonicalRelease, assertEcsDeploymentStable, assertFreshAwsPreflight, assertWorkerHeartbeat, expectedRelease, loadContract, readGitRelease } from "./release-policy.mjs"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const contract = loadContract()
const worker = contract.topology.worker
const evidenceIndex = process.argv.indexOf("--preflight-evidence")
const evidencePath = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : undefined
const databaseEnvIndex = process.argv.indexOf("--database-env")
const databaseEnvPath = databaseEnvIndex >= 0 ? process.argv[databaseEnvIndex + 1] : undefined
const digestIndex = process.argv.indexOf("--image-digest")
const requestedImageDigest = digestIndex >= 0 ? process.argv[digestIndex + 1] : process.env.FINNOR_ECR_IMAGE_DIGEST

if (!evidencePath || !databaseEnvPath) throw new Error("Usage: node scripts/release/deploy-aws-worker.mjs --preflight-evidence <path> --database-env <path> [--image-digest sha256:...]")
if (!existsSync(evidencePath) || !existsSync(databaseEnvPath)) throw new Error("AWS worker deployment evidence or protected database environment is missing")

const gitRelease = readGitRelease(repoRoot, contract)
assertCanonicalRelease(gitRelease)
const expected = expectedRelease(gitRelease.head, process.env.FINNOR_RELEASE_SOURCE || "github-actions")
const evidence = JSON.parse(readFileSync(resolve(evidencePath), "utf8"))
const contractBytes = readFileSync(resolve(repoRoot, "infra/deployment/production.contract.json"))
const contractHash = createHash("sha256").update(contractBytes).digest("hex")
assertFreshAwsPreflight(evidence, { commitSha: gitRelease.head, contractHash })

const awsRegion = worker.region
function awsJson(service, args, timeout = 60_000) {
  const output = execFileSync("aws", [service, ...args, "--region", awsRegion, "--output", "json", "--no-cli-pager"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
    env: { ...process.env, AWS_PAGER: "" },
  })
  return JSON.parse(output)
}

function awsRun(service, args, timeout = 120_000) {
  return execFileSync("aws", [service, ...args, "--region", awsRegion, "--no-cli-pager"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout,
    env: { ...process.env, AWS_PAGER: "" },
  })
}

const identity = awsJson("sts", ["get-caller-identity"])
if (identity.Account !== worker.accountId) throw new Error(`AWS account ${identity.Account ?? "<missing>"} differs from canonical ${worker.accountId}`)
const selectedRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
if (selectedRegion && selectedRegion !== awsRegion) throw new Error(`AWS region ${selectedRegion} differs from canonical ${awsRegion}`)
assertAwsTarget(contract, { accountId: identity.Account, region: awsRegion, clusterName: worker.clusterName, serviceName: worker.serviceName, taskFamily: worker.taskFamily, ecrRepository: worker.ecrRepository })
if (!requestedImageDigest || !/^sha256:[0-9a-f]{64}$/i.test(requestedImageDigest)) throw new Error("AWS worker deploy requires the exact ECR image digest")
if (evidence.aws?.imageDigest !== requestedImageDigest) throw new Error("preflight evidence does not carry the requested ECR digest")
if (evidence.aws?.ecrRepository !== worker.ecrRepository || evidence.aws?.clusterName !== worker.clusterName || evidence.aws?.serviceName !== worker.serviceName) {
  throw new Error("preflight evidence is for a different AWS worker target")
}

let coreCertificationId = process.env.FINNOR_CORE_CERTIFICATION_ID?.trim()
if (process.env.FINNOR_CORE_CERTIFICATION_FILE) {
  const certification = JSON.parse(readFileSync(resolve(process.env.FINNOR_CORE_CERTIFICATION_FILE), "utf8"))
  if (certification.status !== "PASS" || certification.canonicalCoreSha !== expected.commitSha) throw new Error("AWS worker deploy requires a PASS core certification for the exact release SHA")
  if (coreCertificationId && coreCertificationId !== certification.certificationId) throw new Error("FINNOR_CORE_CERTIFICATION_ID differs from the bound core certification")
  coreCertificationId = certification.certificationId
}
const taskRoleArn = `arn:aws:iam::${worker.accountId}:role/${worker.taskRoleName}`
const executionRoleArn = `arn:aws:iam::${worker.accountId}:role/${worker.executionRoleName}`
const taskDefinitionInput = {
  family: worker.taskFamily,
  cpu: String(worker.cpu),
  memory: String(worker.memory),
  networkMode: "awsvpc",
  requiresCompatibilities: ["FARGATE"],
  executionRoleArn,
  taskRoleArn,
  runtimePlatform: { cpuArchitecture: "X86_64", operatingSystemFamily: "LINUX" },
  containerDefinitions: [{
    name: worker.containerName,
    image: `${evidence.aws.imageUri?.split("@")[0] ?? `601804670058.dkr.ecr.${awsRegion}.amazonaws.com/${worker.ecrRepository}`}@${requestedImageDigest}`,
    essential: true,
    stopTimeout: 120,
    portMappings: [{ containerPort: worker.containerPort, hostPort: worker.containerPort, protocol: "tcp" }],
    environment: [
      { name: "AWS_REGION", value: awsRegion },
      { name: "NODE_ENV", value: "production" },
      { name: "FINNOR_ENVIRONMENT", value: "production" },
      { name: "FINNOR_RELEASE_SOURCE", value: expected.source },
      { name: "FINNOR_COMMIT_SHA", value: expected.commitSha },
      { name: "FINNOR_BUILD_ID", value: expected.buildId },
      { name: "FINNOR_VERSION", value: expected.version },
      ...(coreCertificationId ? [{ name: "FINNOR_CORE_CERTIFICATION_ID", value: coreCertificationId }] : []),
      { name: "SUPABASE_URL", value: contract.topology.database.supabaseUrl },
      { name: "FINNOR_WORKER_DEPLOYMENT_ID", value: `ecs:${worker.clusterName}:${worker.serviceName}:${expected.commitSha}` },
      { name: "FINNOR_WORKER_CAPABILITIES", value: "jobs,orchestration,computer,event-wake,connection-health,realtime,sse" },
      { name: "SECRETS_PROVIDER", value: "aws-secrets-manager" },
      { name: "FINNOR_SECRET_IDS", value: JSON.stringify(worker.secretMap) },
      { name: "FINNOR_TENANT_SECRET_PREFIX", value: "finnor/tenants" },
      { name: "JARVIS_SSE_ALLOWED_ORIGINS", value: "https://finnorai.com" },
      { name: "WORKER_CONCURRENCY", value: "2" },
      { name: "WORKER_INTERACTIVE_RESERVED_CONCURRENCY", value: "1" },
      { name: "FINNOR_DB_POOL_MAX", value: "4" },
      { name: "PORT", value: "8090" },
      { name: "SSE_PORT", value: "8090" },
    ],
    healthCheck: {
      command: ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
      interval: 30,
      timeout: 5,
      retries: 3,
      startPeriod: 30,
    },
    logConfiguration: {
      logDriver: "awslogs",
      options: {
        "awslogs-group": worker.logGroupName,
        "awslogs-region": awsRegion,
        "awslogs-stream-prefix": "ecs",
      },
    },
  }],
}
const taskEnvironment = Object.fromEntries(taskDefinitionInput.containerDefinitions[0].environment.map((entry) => [entry.name, entry.value]))
if ("AWS_ACCESS_KEY_ID" in taskEnvironment || "AWS_SECRET_ACCESS_KEY" in taskEnvironment) throw new Error("refusing to register a task definition with static AWS credentials")

const tempDir = join(tmpdir(), `finnor-aws-deploy-${process.pid}`)
mkdirSync(tempDir, { recursive: true, mode: 0o700 })
const taskInputPath = join(tempDir, "task-definition.json")
writeFileSync(taskInputPath, `${JSON.stringify(taskDefinitionInput, null, 2)}\n`, { mode: 0o600 })
let registeredTaskDefinition
let targetHealth
let workerHeartbeat
try {
  registeredTaskDefinition = awsJson("ecs", ["register-task-definition", "--cli-input-json", `file://${taskInputPath}`], 180_000).taskDefinition
  if (!registeredTaskDefinition?.taskDefinitionArn) throw new Error("ECS did not return a task definition ARN")
  console.log(`Registered ${worker.taskFamily}:${registeredTaskDefinition.revision} for ${expected.commitSha}`)
  awsRun("ecs", [
    "update-service", "--cluster", worker.clusterName, "--service", worker.serviceName,
    "--task-definition", registeredTaskDefinition.taskDefinitionArn,
    "--desired-count", String(worker.desiredCount),
    "--deployment-configuration", "minimumHealthyPercent=100,maximumPercent=200,deploymentCircuitBreaker={enable=true,rollback=true}",
    "--health-check-grace-period-seconds", "120",
  ])

  const deadline = Date.now() + 15 * 60 * 1000
  let lastStatus = ""
  while (Date.now() < deadline) {
    const service = awsJson("ecs", ["describe-services", "--cluster", worker.clusterName, "--services", worker.serviceName]).services?.[0]
    const primary = service?.deployments?.find((deployment) => deployment.status === "PRIMARY")
    const status = `running=${service?.runningCount ?? 0} pending=${service?.pendingCount ?? 0} primary=${primary?.taskDefinition ?? "<missing>"}`
    if (status !== lastStatus) { console.log(`ECS rollout: ${status}`); lastStatus = status }
    if (
      service?.desiredCount === worker.desiredCount && service.runningCount === worker.desiredCount && service.pendingCount === 0
      && primary?.taskDefinition === registeredTaskDefinition.taskDefinitionArn
      && (primary.rolloutState === undefined || primary.rolloutState === "COMPLETED")
      && service.deployments?.length === 1
    ) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
  }
  if (Date.now() >= deadline) throw new Error("ECS deployment did not become stable within 15 minutes")
  const stableService = awsJson("ecs", ["describe-services", "--cluster", worker.clusterName, "--services", worker.serviceName]).services?.[0]
  assertEcsDeploymentStable(stableService, registeredTaskDefinition.taskDefinitionArn, worker.desiredCount)

  const runningTaskArns = awsJson("ecs", ["list-tasks", "--cluster", worker.clusterName, "--service-name", worker.serviceName, "--desired-status", "RUNNING"]).taskArns ?? []
  const tasks = runningTaskArns.length ? awsJson("ecs", ["describe-tasks", "--cluster", worker.clusterName, "--tasks", ...runningTaskArns]).tasks ?? [] : []
  const task = tasks.find((candidate) => candidate.taskDefinitionArn === registeredTaskDefinition.taskDefinitionArn)
  if (!task) throw new Error("ECS service stabilized without a running task on the newly registered task definition")
  const container = task.containers?.find((candidate) => candidate.name === worker.containerName)
  if (!container || container.lastStatus !== "RUNNING" || (container.healthStatus && container.healthStatus !== "HEALTHY")) throw new Error("ECS worker container is not RUNNING and HEALTHY")
  if (container.imageDigest && container.imageDigest !== requestedImageDigest) throw new Error(`ECS task image digest ${container.imageDigest} differs from ${requestedImageDigest}`)

  const targetDeadline = Date.now() + 3 * 60 * 1000
  while (Date.now() < targetDeadline) {
    targetHealth = awsJson("elbv2", ["describe-target-health", "--target-group-arn", evidence.aws.targetGroupArn]).TargetHealthDescriptions ?? []
    if (targetHealth.length > 0 && targetHealth.every((target) => target.TargetHealth?.State === "healthy")) break
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
  }
  assertAlbTargetsHealthy(targetHealth)

  const gatewayResponse = await fetch(`${worker.sseGatewayUrl}/healthz`, { headers: { accept: "application/json", "cache-control": "no-cache" }, signal: AbortSignal.timeout(20_000) })
  const gateway = await gatewayResponse.json().catch(() => null)
  assertAwsWorkerHealth({ status: gatewayResponse.status, body: gateway, expected })

  process.loadEnvFile(resolve(databaseEnvPath))
  const databaseUrl = process.env.MIGRATIONS_DATABASE_URL || process.env.DATABASE_URL
  if (!databaseUrl) throw new Error("MIGRATIONS_DATABASE_URL or DATABASE_URL is required for worker heartbeat verification")
  const requireFromOs = createRequire(new URL("../../finnor-os/package.json", import.meta.url))
  const pg = requireFromOs("pg")
  const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 })
  await client.connect()
  try {
    const heartbeatDeadline = Date.now() + 120_000
    while (Date.now() < heartbeatDeadline) {
      const result = await client.query(`
        SELECT release_sha, build_id, version, release_source, core_certification_id,
               migration_head, deployment_id, capabilities, environment,
               extract(epoch FROM (now() - last_beat_at))::int AS age_seconds
          FROM finnor_os.service_release_heartbeats
         WHERE service='worker' AND release_sha=$1
         ORDER BY last_beat_at DESC
         LIMIT 1
      `, [expected.commitSha])
      const row = result.rows[0]
      if (row && Number(row.age_seconds) <= 120 && row.migration_head === contract.release.requiredMigrationHead && row.deployment_id && ["jobs", "orchestration", "realtime", "sse"].every((capability) => row.capabilities?.includes(capability))) {
        workerHeartbeat = {
          commitSha: row.release_sha,
          buildId: row.build_id,
          version: row.version,
          source: row.release_source,
          coreCertificationId: row.core_certification_id,
          migrationHead: row.migration_head,
          deploymentId: row.deployment_id,
          capabilities: row.capabilities,
          environment: row.environment,
          ageSeconds: Number(row.age_seconds),
        }
        break
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_000))
    }
  } finally {
    await client.end()
  }
  assertWorkerHeartbeat(workerHeartbeat, expected, contract.release.requiredMigrationHead, ["jobs", "orchestration", "realtime", "sse"], coreCertificationId)

  const result = {
    ok: true,
    component: "worker",
    ...expected,
    coreCertificationId,
    accountId: identity.Account,
    region: awsRegion,
    clusterName: worker.clusterName,
    serviceName: worker.serviceName,
    taskDefinitionArn: registeredTaskDefinition.taskDefinitionArn,
    taskDefinitionRevision: registeredTaskDefinition.revision,
    imageDigest: requestedImageDigest,
    targetHealth: targetHealth.map((target) => ({ id: target.Target?.Id, state: target.TargetHealth?.State, reason: target.TargetHealth?.Reason })),
    gateway: { url: worker.sseGatewayUrl, release: gateway.release, capabilities: gateway.capabilities },
    workerHeartbeat,
  }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  const diagnostics = { error: error instanceof Error ? error.message : String(error) }
  try {
    const service = awsJson("ecs", ["describe-services", "--cluster", worker.clusterName, "--services", worker.serviceName])
    diagnostics.serviceEvents = service.services?.[0]?.events?.slice(0, 10) ?? []
    const stoppedArns = awsJson("ecs", ["list-tasks", "--cluster", worker.clusterName, "--service-name", worker.serviceName, "--desired-status", "STOPPED", "--max-items", "5"]).taskArns ?? []
    if (stoppedArns.length) {
      const stopped = awsJson("ecs", ["describe-tasks", "--cluster", worker.clusterName, "--tasks", ...stoppedArns]).tasks ?? []
      diagnostics.stoppedTasks = stopped.map((task) => ({
        taskArn: task.taskArn,
        stoppedReason: task.stoppedReason,
        stopCode: task.stopCode,
        containers: task.containers?.map((container) => ({ name: container.name, lastStatus: container.lastStatus, exitCode: container.exitCode, reason: container.reason, healthStatus: container.healthStatus })),
      }))
    }
    if (evidence.aws?.targetGroupArn) diagnostics.targetHealth = awsJson("elbv2", ["describe-target-health", "--target-group-arn", evidence.aws.targetGroupArn]).TargetHealthDescriptions ?? []
    const streams = awsJson("logs", ["describe-log-streams", "--log-group-name", worker.logGroupName, "--order-by", "LastEventTime", "--descending", "--max-items", "3"]).logStreams ?? []
    diagnostics.cloudWatchLogs = []
    for (const stream of streams.slice(0, 3)) {
      const events = awsJson("logs", ["get-log-events", "--log-group-name", worker.logGroupName, "--log-stream-name", stream.logStreamName, "--limit", "20", "--no-start-from-head"]).events ?? []
      diagnostics.cloudWatchLogs.push({ stream: stream.logStreamName, events: events.map((event) => String(event.message ?? "").replace(/(authorization|token|secret|password|api[_-]?key|postgres(?:ql)?:\/\/)[^\s"']+/gi, "$1=<redacted>")) })
    }
  } catch (diagnosticError) {
    diagnostics.diagnosticCollectionError = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
  }
  console.error(JSON.stringify(diagnostics, null, 2))
  process.exitCode = 1
} finally {
  try { rmSync(tempDir, { recursive: true, force: true }) } catch { /* best-effort cleanup of a process-local task definition file */ }
}

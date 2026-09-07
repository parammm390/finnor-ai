import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { promises as dns } from "node:dns"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { assertAwsTarget, assertCanonicalRelease, assertImmutableEcrRelease, assertResolvedTarget, expectedRelease, loadContract, readGitRelease } from "./release-policy.mjs"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const contract = loadContract()
const worker = contract.topology.worker
const outputIndex = process.argv.indexOf("--output-file")
const outputPath = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined
const databaseEnvIndex = process.argv.indexOf("--database-env")
const databaseEnvPath = databaseEnvIndex >= 0 ? process.argv[databaseEnvIndex + 1] : undefined
const digestIndex = process.argv.indexOf("--image-digest")
const requestedImageDigest = digestIndex >= 0 ? process.argv[digestIndex + 1] : process.env.FINNOR_ECR_IMAGE_DIGEST

if (!outputPath || !databaseEnvPath) {
  throw new Error("Usage: node scripts/release/preflight-production.mjs --database-env <path> --output-file <path> [--image-digest sha256:...]")
}
if (!existsSync(databaseEnvPath)) throw new Error(`protected database environment not found: ${databaseEnvPath}`)

const gitRelease = readGitRelease(repoRoot, contract)
assertCanonicalRelease(gitRelease)
const expected = expectedRelease(gitRelease.head, process.env.FINNOR_RELEASE_SOURCE || "github-actions")
for (const [name, value] of Object.entries({
  FINNOR_COMMIT_SHA: expected.commitSha,
  FINNOR_BUILD_ID: expected.buildId,
  FINNOR_VERSION: expected.version,
  FINNOR_ENVIRONMENT: expected.environment,
  FINNOR_RELEASE_SOURCE: expected.source,
})) {
  if (process.env[name] !== value) throw new Error(`${name} must be ${value}, got ${process.env[name] || "<missing>"}`)
}

const vercelToken = process.env.VERCEL_TOKEN
if (!vercelToken) throw new Error("VERCEL_TOKEN is required before production preflight")

async function vercel(path) {
  const response = await fetch(`https://api.vercel.com${path}`, {
    headers: { authorization: `Bearer ${vercelToken}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Vercel preflight failed (${response.status}) for ${path}`)
  return response.json()
}

const vercelTargets = {}
for (const component of ["frontend", "api"]) {
  const target = contract.topology[component]
  const project = await vercel(`/v9/projects/${target.projectId}?teamId=${target.organizationId}`)
  assertResolvedTarget(`Vercel ${component}`, target, {
    projectId: project.id,
    projectName: project.name,
    organizationId: project.accountId,
  }, ["projectId", "projectName", "organizationId"])
  vercelTargets[component] = { projectId: project.id, projectName: project.name, organizationId: project.accountId }
}

function isProductionTarget(target) {
  return target === "production" || target?.includes?.("production")
}

const apiTarget = contract.topology.api
const envResponse = await vercel(`/v10/projects/${apiTarget.projectId}/env?teamId=${apiTarget.organizationId}&decrypt=false`)
const productionEnvNames = new Set((envResponse.envs ?? []).filter((entry) => isProductionTarget(entry.target)).map((entry) => entry.key))
for (const name of ["MIGRATIONS_DATABASE_URL", "DATABASE_URL", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SECRETS_PROVIDER", "FINNOR_SECRET_IDS"]) {
  if (!productionEnvNames.has(name)) throw new Error(`Vercel API production environment is missing ${name}`)
}
const frontendTarget = contract.topology.frontend
const frontendEnvResponse = await vercel(`/v10/projects/${frontendTarget.projectId}/env?teamId=${frontendTarget.organizationId}&decrypt=false`)
const frontendProductionEnvNames = new Set((frontendEnvResponse.envs ?? []).filter((entry) => isProductionTarget(entry.target)).map((entry) => entry.key))
if (!frontendProductionEnvNames.has("JARVIS_SSE_GATEWAY_URL")) throw new Error("Vercel frontend production environment is missing JARVIS_SSE_GATEWAY_URL")

const awsRegion = worker.region
function awsJson(service, args, timeout = 60_000) {
  try {
    const output = execFileSync("aws", [service, ...args, "--region", awsRegion, "--output", "json", "--no-cli-pager"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout,
      env: { ...process.env, AWS_PAGER: "" },
    })
    return JSON.parse(output)
  } catch (error) {
    const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : ""
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : ""
    const diagnostic = [stdout, stderr].filter(Boolean).join("\n") || (error instanceof Error ? error.message : String(error))
    throw new Error(`AWS ${service} ${args.join(" ")} failed:\n${diagnostic}`, { cause: error })
  }
}

const identity = awsJson("sts", ["get-caller-identity"])
if (identity.Account !== worker.accountId) throw new Error(`AWS account ${identity.Account ?? "<missing>"} differs from canonical ${worker.accountId}`)
const selectedRegion = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION
if (selectedRegion && selectedRegion !== awsRegion) throw new Error(`AWS region ${selectedRegion} differs from canonical ${awsRegion}`)
assertAwsTarget(contract, { accountId: identity.Account, region: awsRegion, clusterName: worker.clusterName, serviceName: worker.serviceName, taskFamily: worker.taskFamily, ecrRepository: worker.ecrRepository })

const repositories = awsJson("ecr", ["describe-repositories", "--repository-names", worker.ecrRepository]).repositories ?? []
const repository = repositories[0]
if (!repository) throw new Error(`ECR repository ${worker.ecrRepository} is missing`)
if (repository.imageTagMutability !== "IMMUTABLE") throw new Error(`ECR repository ${worker.ecrRepository} is mutable`)
if (repository.imageScanningConfiguration?.scanOnPush !== true) throw new Error(`ECR repository ${worker.ecrRepository} does not scan images on push`)
if (!requestedImageDigest || !/^sha256:[0-9a-f]{64}$/i.test(requestedImageDigest)) throw new Error("preflight requires the exact pushed ECR image digest")
const imageDetails = awsJson("ecr", ["describe-images", "--repository-name", worker.ecrRepository, "--image-ids", `imageTag=${expected.commitSha}`]).imageDetails ?? []
const image = imageDetails[0]
assertImmutableEcrRelease({ repository, image, expectedCommitSha: expected.commitSha, expectedDigest: requestedImageDigest })

const clusterResponse = awsJson("ecs", ["describe-clusters", "--clusters", worker.clusterName])
const cluster = clusterResponse.clusters?.[0]
if (!cluster || cluster.status !== "ACTIVE") throw new Error(`ECS cluster ${worker.clusterName} is missing or not ACTIVE`)
if (cluster.registeredContainerInstancesCount !== 0) throw new Error("FINNOR ECS cluster unexpectedly contains EC2 container instances")
const serviceResponse = awsJson("ecs", ["describe-services", "--cluster", worker.clusterName, "--services", worker.serviceName])
const service = serviceResponse.services?.[0]
if (!service || service.status !== "ACTIVE") throw new Error(`ECS service ${worker.serviceName} is missing or not ACTIVE`)
if (service.launchType !== "FARGATE") throw new Error(`ECS service launch type is ${service.launchType ?? "<missing>"}, not FARGATE`)
if (service.desiredCount !== worker.desiredCount) throw new Error(`ECS desired count ${service.desiredCount} differs from ${worker.desiredCount}`)
if (service.capacityProviderStrategy?.some((entry) => entry.capacityProvider === "FARGATE_SPOT")) throw new Error("ECS service is configured for Fargate Spot")
if (service.deploymentConfiguration?.minimumHealthyPercent !== 100 || service.deploymentConfiguration?.maximumPercent !== 200) throw new Error("ECS rolling deployment percentages are not 100/200")
if (service.deploymentConfiguration?.deploymentCircuitBreaker?.enable !== true || service.deploymentConfiguration?.deploymentCircuitBreaker?.rollback !== true) throw new Error("ECS deployment circuit breaker rollback is not enabled")
const configuredSubnets = service.networkConfiguration?.awsvpcConfiguration?.subnets ?? []
if (new Set(configuredSubnets).size !== new Set(worker.publicSubnetIds).size || worker.publicSubnetIds.some((subnet) => !configuredSubnets.includes(subnet))) throw new Error("ECS service subnets differ from the canonical two-subnet public network")
const taskSecurityGroupId = service.networkConfiguration?.awsvpcConfiguration?.securityGroups?.[0]
if (!taskSecurityGroupId) throw new Error("ECS service has no worker task security group")
const taskDefinition = awsJson("ecs", ["describe-task-definition", "--task-definition", worker.taskFamily]).taskDefinition
if (!taskDefinition || taskDefinition.family !== worker.taskFamily) throw new Error(`ECS task definition family ${worker.taskFamily} is missing`)
const container = taskDefinition.containerDefinitions?.find((entry) => entry.name === worker.containerName)
if (!container || !container.portMappings?.some((entry) => entry.containerPort === worker.containerPort)) throw new Error("ECS task definition does not expose the canonical worker port")
const taskEnv = Object.fromEntries((container.environment ?? []).map((entry) => [entry.name, entry.value]))
for (const [name, value] of Object.entries({ SECRETS_PROVIDER: "aws-secrets-manager", SUPABASE_URL: contract.topology.database.supabaseUrl, PORT: "8090", SSE_PORT: "8090", WORKER_CONCURRENCY: "2", WORKER_INTERACTIVE_RESERVED_CONCURRENCY: "1", FINNOR_DB_POOL_MAX: "4" })) {
  if (taskEnv[name] !== value) throw new Error(`ECS task definition ${name} is ${taskEnv[name] ?? "<missing>"}, expected ${value}`)
}
if ("AWS_ACCESS_KEY_ID" in taskEnv || "AWS_SECRET_ACCESS_KEY" in taskEnv) throw new Error("ECS task definition contains static AWS credentials")
let taskSecretMap
try { taskSecretMap = JSON.parse(taskEnv.FINNOR_SECRET_IDS ?? "") } catch { throw new Error("ECS task definition FINNOR_SECRET_IDS is not valid JSON") }
if (JSON.stringify(taskSecretMap) !== JSON.stringify(worker.secretMap)) throw new Error("ECS task definition secret map differs from the canonical map")

const loadBalancers = awsJson("elbv2", ["describe-load-balancers", "--names", worker.loadBalancerName]).LoadBalancers ?? []
const loadBalancer = loadBalancers[0]
if (!loadBalancer || loadBalancer.State?.Code !== "active") throw new Error(`ALB ${worker.loadBalancerName} is missing or not active`)
if (loadBalancer.VpcId !== worker.vpcId || loadBalancer.Scheme !== "internet-facing") throw new Error("realtime ALB VPC or scheme differs from the contract")
const targetGroups = awsJson("elbv2", ["describe-target-groups", "--names", worker.targetGroupName]).TargetGroups ?? []
const targetGroup = targetGroups[0]
if (!targetGroup || targetGroup.VpcId !== worker.vpcId || targetGroup.TargetType !== "ip" || targetGroup.Port !== worker.containerPort) throw new Error("ALB target group does not match the Fargate worker")
if (targetGroup.HealthCheckPath !== "/healthz" || targetGroup.HealthCheckProtocol !== "HTTP") throw new Error("ALB target health check is not GET /healthz over HTTP")
const listeners = awsJson("elbv2", ["describe-listeners", "--load-balancer-arn", loadBalancer.LoadBalancerArn]).Listeners ?? []
const httpListener = listeners.find((entry) => entry.Protocol === "HTTP" && entry.Port === worker.httpListenerPort)
if (!httpListener) throw new Error("ALB does not have the canonical HTTP listener")
if (!httpListener.DefaultActions?.some((action) => action.Type === "redirect" && action.RedirectConfig?.Protocol === "HTTPS" && String(action.RedirectConfig?.Port) === String(worker.httpsListenerPort))) throw new Error("HTTP listener does not redirect to the canonical HTTPS listener")
const httpsListener = listeners.find((entry) => entry.Protocol === "HTTPS" && entry.Port === worker.httpsListenerPort)
if (!httpsListener) throw new Error("ALB does not have the canonical HTTPS listener")
if (!httpsListener.DefaultActions?.some((action) => action.Type === "forward" && action.TargetGroupArn === targetGroup.TargetGroupArn)) throw new Error("HTTPS listener does not forward to the canonical worker target group")
const attributes = awsJson("elbv2", ["describe-load-balancer-attributes", "--load-balancer-arn", loadBalancer.LoadBalancerArn]).Attributes ?? []
const idleTimeout = attributes.find((entry) => entry.Key === "idle_timeout.timeout_seconds")?.Value
if (Number(idleTimeout) < 3600) throw new Error(`ALB idle timeout ${idleTimeout ?? "<missing>"} is too short for SSE`)
const albSecurityGroupId = loadBalancer.SecurityGroups?.[0]
if (!albSecurityGroupId) throw new Error("realtime ALB has no security group")
const securityGroups = awsJson("ec2", ["describe-security-groups", "--group-ids", albSecurityGroupId, taskSecurityGroupId]).SecurityGroups ?? []
const albSecurityGroup = securityGroups.find((group) => group.GroupId === albSecurityGroupId)
const taskSecurityGroup = securityGroups.find((group) => group.GroupId === taskSecurityGroupId)
if (!albSecurityGroup || !taskSecurityGroup) throw new Error("could not resolve ALB and worker security groups")
const albHasHttps = (albSecurityGroup.IpPermissions ?? []).some((rule) => rule.IpProtocol === "tcp" && rule.FromPort === 443 && rule.ToPort === 443 && rule.IpRanges?.some((range) => range.CidrIp === "0.0.0.0/0"))
if (!albHasHttps) throw new Error("ALB security group does not allow public HTTPS ingress")
const taskPortRule = (taskSecurityGroup.IpPermissions ?? []).find((rule) => rule.IpProtocol === "tcp" && rule.FromPort === worker.containerPort && rule.ToPort === worker.containerPort)
if (!taskPortRule?.UserIdGroupPairs?.some((pair) => pair.GroupId === albSecurityGroupId)) throw new Error("worker port is not restricted to the ALB security group")
if (taskPortRule.IpRanges?.some((range) => range.CidrIp === "0.0.0.0/0" || range.CidrIp === "::/0")) throw new Error("worker task port is directly open to the internet")
const natGateways = awsJson("ec2", ["describe-nat-gateways", "--filter", `Name=vpc-id,Values=${worker.vpcId}`, "Name=state,Values=pending,available,deleting"]).NatGateways ?? []
if (natGateways.length > 0) throw new Error("canonical prototype network unexpectedly contains a NAT Gateway")

const realtimeUrl = new URL(worker.sseGatewayUrl)
if (realtimeUrl.protocol !== "https:" || realtimeUrl.hostname !== "realtime.finnorai.com") throw new Error("canonical realtime URL is not https://realtime.finnorai.com")
let realtimeDnsMatches = false
try {
  const aliases = await dns.resolveCname(realtimeUrl.hostname)
  realtimeDnsMatches = aliases.some((alias) => alias.replace(/\.$/, "").toLowerCase() === loadBalancer.DNSName.replace(/\.$/, "").toLowerCase())
} catch { /* fall through to resolved address comparison */ }
if (!realtimeDnsMatches) {
  const [realtimeAddresses, albAddresses] = await Promise.all([
    dns.lookup(realtimeUrl.hostname, { all: true }).then((rows) => rows.map((row) => row.address)).catch(() => []),
    dns.lookup(loadBalancer.DNSName, { all: true }).then((rows) => rows.map((row) => row.address)).catch(() => []),
  ])
  realtimeDnsMatches = realtimeAddresses.some((address) => albAddresses.includes(address))
}
if (!realtimeDnsMatches) throw new Error(`realtime.finnorai.com does not resolve to ALB ${loadBalancer.DNSName}`)

process.loadEnvFile(resolve(databaseEnvPath))
const databaseUrl = process.env.MIGRATIONS_DATABASE_URL
if (!databaseUrl) throw new Error("MIGRATIONS_DATABASE_URL is missing from the protected environment")
const parsedDatabaseUrl = new URL(databaseUrl)
if (parsedDatabaseUrl.hostname !== contract.topology.database.host) throw new Error(`database host ${parsedDatabaseUrl.hostname} differs from the canonical contract`)
const requireFromOs = createRequire(new URL("../../finnor-os/package.json", import.meta.url))
const pg = requireFromOs("pg")
const client = new pg.Client({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 })
await client.connect()
let migrationHead
let businessCounts
try {
  await client.query("BEGIN READ ONLY")
  const migrations = await client.query("SELECT name FROM finnor_os._migrations ORDER BY name")
  const applied = migrations.rows.map((row) => row.name)
  migrationHead = applied.at(-1)
  const repoMigrations = readdirSync(resolve(repoRoot, "finnor-os/packages/db/migrations")).filter((name) => name.endsWith(".sql")).sort()
  const knownLegacyMigrationAliases = new Set(["0102_product_truth_objective_realtime.sql"])
  const unknown = applied.filter((name) => !repoMigrations.includes(name) && !knownLegacyMigrationAliases.has(name))
  if (unknown.length) throw new Error(`production database contains migrations absent from the release: ${unknown.join(", ")}`)
  if (repoMigrations.at(-1) !== contract.release.requiredMigrationHead) throw new Error(`repository migration head ${repoMigrations.at(-1)} differs from contract ${contract.release.requiredMigrationHead}`)
  if (migrationHead && migrationHead > contract.release.requiredMigrationHead) throw new Error(`production migration head ${migrationHead} is newer than this release`)
  if (migrationHead && migrationHead >= "0080_declarative_client_imports.sql") {
    const shape = await client.query(`
      SELECT
        to_regclass('finnor_os.tenant_locations') IS NOT NULL AS tenant_locations,
        to_regclass('finnor_os.import_runs') IS NOT NULL AS import_runs,
        to_regclass('finnor_os.import_rows') IS NOT NULL AS import_rows,
        to_regclass('finnor_os.import_entity_refs') IS NOT NULL AS import_entity_refs,
        EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='finnor_os' AND table_name='tenant_integrations' AND column_name='credential_ref') AS tenant_credentials
    `)
    if (Object.values(shape.rows[0] ?? {}).some((value) => value !== true)) throw new Error("production Phase 1–3 schema shape is inconsistent")
  }
  const counts = await client.query(`
    SELECT
      (SELECT count(*)::int FROM finnor_os.tenants) AS tenants,
      (SELECT count(*)::int FROM finnor_os.users) AS users,
      (SELECT count(*)::int FROM finnor_os.households) AS households,
      (SELECT count(*)::int FROM finnor_os.leads) AS leads,
      (SELECT count(*)::int FROM finnor_os.equipment) AS equipment,
      (SELECT count(*)::int FROM finnor_os.work_orders) AS work_orders
  `)
  businessCounts = counts.rows[0]
  if (Number(businessCounts?.tenants ?? 0) < 1 || Number(businessCounts?.users ?? 0) < 1) throw new Error("production database has no tenant/user business data")
  await client.query("ROLLBACK")
} finally {
  await client.end()
}

const contractBytes = readFileSync(resolve(repoRoot, "infra/deployment/production.contract.json"))
const evidence = {
  ok: true,
  checkedAt: new Date().toISOString(),
  commitSha: gitRelease.head,
  remoteMain: gitRelease.remoteMain,
  contractSha256: createHash("sha256").update(contractBytes).digest("hex"),
  vercel: vercelTargets,
  aws: {
    accountId: identity.Account,
    region: awsRegion,
    ecrRepository: worker.ecrRepository,
    ecrRepositoryArn: repository.repositoryArn,
    imageTag: expected.commitSha,
    imageDigest: image.imageDigest,
    imageUri: `${repository.repositoryUri}@${image.imageDigest}`,
    clusterName: worker.clusterName,
    clusterArn: cluster.arn,
    serviceName: worker.serviceName,
    serviceArn: service.serviceArn,
    taskFamily: worker.taskFamily,
    taskDefinitionArn: taskDefinition.taskDefinitionArn,
    loadBalancerName: worker.loadBalancerName,
    loadBalancerArn: loadBalancer.LoadBalancerArn,
    loadBalancerDnsName: loadBalancer.DNSName,
    targetGroupName: worker.targetGroupName,
    targetGroupArn: targetGroup.TargetGroupArn,
    httpListenerArn: httpListener.ListenerArn,
    httpsListenerArn: httpsListener.ListenerArn,
    albSecurityGroupId,
    taskSecurityGroupId,
    publicSubnetIds: worker.publicSubnetIds,
  },
  database: { host: parsedDatabaseUrl.hostname, migrationHead, businessCounts },
}
writeFileSync(resolve(outputPath), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
console.log(JSON.stringify(evidence, null, 2))

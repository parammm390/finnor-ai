import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadContract } from "./release-policy.mjs"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const contract = loadContract()
const failures = []
const fail = (message) => failures.push(message)
const read = (path) => readFileSync(join(repoRoot, path), "utf8")
const required = (condition, message) => { if (!condition) fail(message) }

required(contract.schemaVersion === 3 && contract.environment === "production", "contract schema/environment is invalid")
required(contract.canonicalGit.remote === "origin" && contract.canonicalGit.branch === "main" && contract.canonicalGit.repository === "parammm390/finnor-ai", "canonical Git target must be origin/main")
required(contract.canonicalGit.requireCleanWorktree === true, "production contract must require a clean worktree")
required(contract.release.concurrencyGroup === "finnor-production-release", "production concurrency lock changed")
required(contract.release.requiredMigrationHead === "0141_restricted_digest_projection_access.sql", "production migration head is not locked to the projection repair")
for (const component of ["computeRealtime", "computeInteractive", "computeBackground", "computeHeavy"]) required(contract.release.requiredComponents.includes(component), `${component} must be required for every production release`)
required(contract.release.requiredComponents.includes("supplierCanaryApp") && contract.release.requiredComponents.includes("supplierCanaryAuth"), "both supplier canary roles must be required for the Phase 8 cutover release")
required(contract.forbiddenActiveProviders.includes("azure"), "Azure must remain forbidden in the active production topology")

for (const name of ["frontend", "api", "worker", "computePlane", "orchestrator", "supplierCanaryApp", "supplierCanaryAuth", "database"]) required(contract.topology[name], `topology is missing ${name}`)
for (const name of ["frontend", "api"]) {
  const target = contract.topology[name]
  required(target.provider === "vercel" && target.releaseWorkingDirectory && target.installCommand === "npm ci", `${name} must use the canonical Vercel npm-ci contract`)
}
for (const [name, role] of [["supplierCanaryApp", "app"], ["supplierCanaryAuth", "auth"]]) {
  const target = contract.topology[name]
  required(target.provider === "vercel" && target.releaseWorkingDirectory === "finnor-os/apps/supplier-canary" && target.installCommand === "npm ci", `${name} must use the canonical supplier-canary Vercel contract`)
  required(target.releasePath === "/health" && target.portalRole === role, `${name} health role contract is invalid`)
}

const worker = contract.topology.worker
required(worker.provider === "aws-ecs-fargate", "worker provider must be AWS ECS Fargate")
for (const key of ["accountId", "region", "stackName", "vpcId", "clusterName", "serviceName", "taskFamily", "containerName", "ecrRepository", "loadBalancerName", "targetGroupName", "executionRoleName", "taskRoleName", "githubActionsRoleName", "logGroupName", "sseGatewayUrl"]) required(worker[key], `AWS worker contract is missing ${key}`)
required(worker.accountId === "601804670058" && worker.region === "us-east-1", "AWS worker account or region differs from the canonical target")
required(worker.containerPort === 8090 && worker.sseGatewayPort === 8090 && worker.sseGatewayEnabled === true, "worker realtime port contract drifted")
required(worker.sseGatewayUrl === "https://realtime.finnorai.com", "canonical realtime URL drifted")
required(contract.topology.orchestrator.separateDeployment === false && contract.topology.orchestrator.mode === "embedded-compute-interactive" && contract.topology.orchestrator.releaseIdentity === "computeInteractive", "orchestrator must run only in INTERACTIVE compute")
const compute = contract.topology.computePlane
required(compute.imageRepository === worker.ecrRepository && compute.clusterName === worker.clusterName, "compute classes must share the canonical immutable image and cluster")
for (const workloadClass of ["REALTIME", "INTERACTIVE", "BACKGROUND", "HEAVY"]) {
  const profile = compute.classes?.[workloadClass]
  required(profile?.serviceName && profile?.taskFamily && profile?.containerName && profile?.heartbeatService === `compute-${workloadClass.toLowerCase()}`, `${workloadClass} profile is incomplete`)
  required(profile?.minTasks >= 1 && profile?.maxTasks >= profile?.minTasks && profile?.maxTasks <= 4, `${workloadClass} autoscaling envelope is unsafe`)
  required(profile?.cpu > 0 && profile?.memory > 0 && profile?.workerConcurrency >= 1 && profile?.workerConcurrency <= 8, `${workloadClass} process envelope is invalid`)
  required(profile?.taskRoleName?.startsWith("finnor-") && profile?.leaseSeconds === 300 && profile?.stopTimeoutSeconds === 120, `${workloadClass} role or lease/drain envelope is invalid`)
}
required(compute.classes.HEAVY.cpu > compute.classes.BACKGROUND.cpu && compute.classes.HEAVY.memory > compute.classes.BACKGROUND.memory, "HEAVY must have a materially larger task envelope")

const migrationPath = join(repoRoot, "finnor-os/packages/db/migrations", contract.release.requiredMigrationHead)
required(existsSync(migrationPath), `required migration does not exist: ${relative(repoRoot, migrationPath)}`)
const repositoryMigrationHead = readdirSync(join(repoRoot, "finnor-os/packages/db/migrations")).filter((name) => name.endsWith(".sql")).sort().at(-1)
required(repositoryMigrationHead === contract.release.requiredMigrationHead, `production contract migration head ${contract.release.requiredMigrationHead} differs from repository head ${repositoryMigrationHead ?? "<missing>"}`)
for (const path of ["infra/aws/finnor-production.yaml", "finnor-os/Dockerfile.worker", "finnor-os/.dockerignore", "scripts/release/deploy-aws-compute-plane.mjs", "scripts/release/compute-plane-policy.mjs", "scripts/release/preflight-production.mjs", "scripts/release/verify-production-parity.mjs", "scripts/release/vercel-protection.mjs", "scripts/release/configure-vercel-realtime.mjs"]) required(existsSync(join(repoRoot, path)), `required AWS release surface is missing: ${path}`)
required(!existsSync(join(repoRoot, "scripts/release/deploy-aws-worker.mjs")), "retired single-worker deployer still exists")

const dockerfile = read("finnor-os/Dockerfile.worker")
const dockerignore = read("finnor-os/.dockerignore")
for (const invariant of ["FROM node:22", "COPY package.json package-lock.json", "COPY apps ./apps", "COPY packages ./packages", "npm ci", "EXPOSE 8090", "apps/worker/src/index.ts"]) required(dockerfile.includes(invariant), `worker Dockerfile lost ${invariant}`)
for (const invariant of [".env", ".vercel", "node_modules", ".git"]) required(dockerignore.includes(invariant), `worker Docker context does not exclude ${invariant}`)

const cfn = read("infra/aws/finnor-production.yaml")
for (const invariant of ["AWSAgentToolkit: aws-cloudformation@2", "AWS::ECR::Repository", "ImageTagMutability: IMMUTABLE", "AWS::ECS::Cluster", "AWS::ECS::Service", "AWS::ElasticLoadBalancingV2::LoadBalancer", "AWS::ElasticLoadBalancingV2::Listener", "HealthCheckPath: /healthz", "AssignPublicIp: ENABLED", "MinimumHealthyPercent: 100", "MaximumPercent: 200", "RetentionInDays: 7"]) required(cfn.includes(invariant), `AWS CloudFormation template lost ${invariant}`)
for (const invariant of ["ServiceName: finnor-realtime", "ServiceName: finnor-interactive", "ServiceName: finnor-background", "ServiceName: finnor-heavy", "RoleName: finnor-realtime-task", "RoleName: finnor-worker-task", "RoleName: finnor-background-task", "RoleName: finnor-heavy-task", "ComputePlaneStage", "LegacyWorkerTaskDefinitionArn", "FINNOR_DB_POOL_MAX", "Value: '1'"]) required(cfn.includes(invariant), `four-class CloudFormation contract lost ${invariant}`)
required(Buffer.byteLength(cfn) <= 51_200, "CloudFormation template exceeds the governed inline deployment limit")
for (const claim of ["aud", "sub"]) required(cfn.includes(`token.actions.githubusercontent.com:${claim}`), `GitHub OIDC trust omits AWS-supported ${claim}`)
required(cfn.includes("repo:${GitHubOwner}@${GitHubOwnerId}/${GitHubRepositoryName}@${GitHubRepositoryId}:environment:${GitHubEnvironment}"), "GitHub OIDC subject no longer binds immutable repository identity and production environment")
for (const unsupportedClaim of ["repository_id", "repository_owner_id", "ref", "environment", "workflow"]) required(!cfn.includes(`token.actions.githubusercontent.com:${unsupportedClaim}:`), `GitHub OIDC trust uses AWS-unsupported claim ${unsupportedClaim}`)
required(cfn.includes("AWS-supported sub binds immutable repo + owner IDs and the production environment"), "GitHub OIDC role context no longer records its trust invariant")

const workflow = read(".github/workflows/production-release.yml")
const workflowDirectory = join(repoRoot, ".github/workflows")
for (const workflowName of readdirSync(workflowDirectory).filter((name) => /\.ya?ml$/.test(name))) {
  const workflowText = readFileSync(join(workflowDirectory, workflowName), "utf8")
  for (const match of workflowText.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)$/gm)) {
    const actionRef = match[1]
    required(actionRef.startsWith("./.github/workflows/") || /@[0-9a-f]{40}$/i.test(actionRef), `${workflowName} uses a mutable GitHub Action ref: ${actionRef}`)
  }
}
const activeFiles = [
  ".github/workflows/production-release.yml",
  "scripts/release/release-policy.mjs",
  "scripts/release/preflight-production.mjs",
  "scripts/release/deploy-aws-compute-plane.mjs",
  "scripts/release/compute-plane-policy.mjs",
  "scripts/release/verify-production-parity.mjs",
  "scripts/release/vercel-protection.mjs",
  "scripts/release/verify-supplier-canary-release.mjs",
  "scripts/release/run-p8-production-water-retirement.mjs",
  "scripts/release/deploy-production.mjs",
  "finnor-os/scripts/release/migrate-production.ts",
]
const forbiddenActive = /azure|runcommand|azure-vm|systemdUnit|\/srv\/finnor|\/etc\/finnor|railway|render\.com/i
for (const path of activeFiles) {
  if (forbiddenActive.test(read(path))) fail(`active release source mentions a retired provider or VM transport: ${path}`)
}
function scanWorker(path) {
  if (!existsSync(path)) return
  const info = statSync(path)
  if (info.isDirectory()) { for (const entry of readdirSync(path)) scanWorker(join(path, entry)); return }
  if (![".ts", ".tsx", ".js", ".mjs"].includes(extname(path))) return
  if (forbiddenActive.test(readFileSync(path, "utf8"))) fail(`active worker source mentions a retired provider or VM transport: ${relative(repoRoot, path)}`)
}
scanWorker(join(repoRoot, "finnor-os/apps/worker/src"))

for (const marker of ["aws-actions/configure-aws-credentials@cbe3b392738ccf3f987d68400dafcf4b0624a56c", "docker build", "docker push", "preflight-production.mjs", "--image-digest", "configure-vercel-realtime.mjs --apply", "deploy-aws-compute-plane.mjs", "deploy_stage preparing", "deploy_stage routing", "deploy_stage finalized", "deploy_stage rollout", "verify-production-parity.mjs", "deploy-production.mjs supplierCanaryApp", "deploy-production.mjs supplierCanaryAuth", "run-p8-production-water-retirement.mjs", "release:scope5:rollout", "phase5-readiness", "npm run release:scope4-digital-twin", "npm run release:scope5-epistemic-impact"]) required(workflow.includes(marker), `production workflow omits required release marker: ${marker}`)
for (const argument of ['--preflight-evidence="$FINNOR_PREFLIGHT_EVIDENCE"', '--database-env="$FINNOR_PROTECTED_DATABASE_ENV"', '--image-digest="$FINNOR_ECR_IMAGE_DIGEST"']) required(workflow.includes(argument), `compute deploy argument does not match the exact --key=value parser: ${argument}`)
required(!workflow.includes("azure/login") && !workflow.includes("deploy-azure-worker") && !workflow.includes("FINNOR_CORE_CERTIFICATION_FILE="), "production workflow still carries Azure or Phase 6 certification machinery")
const backendCi = read(".github/workflows/ci.yml")
const prVerdict = read(".github/workflows/pr-verdict.yml")
required(prVerdict.includes("uses: ./.github/workflows/ci.yml") && backendCi.includes("npm test -- --exclude tests/integration/phase6-conversation-context-kernel.test.ts"), "PR backend gate must run the full active suite while excluding the retired Phase 6 integration fixture")
required(!/\bprj_[A-Za-z0-9]+|\bteam_[A-Za-z0-9]+/.test(workflow), "production workflow must resolve Vercel IDs from the canonical contract")
required(workflow.includes("production.contract.json').topology.api") && read("scripts/release/deploy-production.mjs").includes("production.contract.json"), "Vercel release stages must consume the canonical deployment contract")

const oidcAt = workflow.indexOf("aws-actions/configure-aws-credentials@cbe3b392738ccf3f987d68400dafcf4b0624a56c")
const pushAt = workflow.indexOf("docker push")
const preflightAt = workflow.indexOf("preflight-production.mjs")
const migrationAt = workflow.indexOf("release:migrate:production")
const workerAt = workflow.indexOf("deploy-aws-compute-plane.mjs")
const parityAt = workflow.indexOf("verify-production-parity.mjs")
const canaryAppAt = workflow.indexOf("deploy-production.mjs supplierCanaryApp --output-file")
const canaryAuthAt = workflow.indexOf("deploy-production.mjs supplierCanaryAuth --output-file")
const cutoverAt = workflow.indexOf("run-p8-production-water-retirement.mjs")
const readinessAt = workflow.indexOf("verify-production-readiness.mjs")
const scope5At = workflow.indexOf("release:scope5:rollout")
required(oidcAt >= 0 && oidcAt < pushAt && pushAt < preflightAt && preflightAt < canaryAppAt && canaryAppAt < canaryAuthAt && canaryAuthAt < migrationAt && migrationAt < workerAt && workerAt < parityAt && parityAt < cutoverAt && cutoverAt < readinessAt && readinessAt < scope5At, "production workflow ordering is not OIDC -> image -> preflight -> supplier canaries -> migration -> four-class compute -> parity -> governed Water retirement -> readiness -> Scope-5 activation")

if (failures.length) {
  console.error(`Deployment truth validation failed:\n- ${failures.join("\n- ")}`)
  process.exit(1)
}
console.log(JSON.stringify({ ok: true, phase: "8", provider: "aws-ecs-fargate", contract: "infra/deployment/production.contract.json" }, null, 2))

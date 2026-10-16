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

test("the Phase 8 production contract adds four independently required compute services without dropping either PE supplier canary", () => {
  const worker = contract.topology.worker
  assert.equal(worker.provider, "aws-ecs-fargate")
  assert.equal(worker.accountId, "601804670058")
  assert.equal(worker.region, "us-east-1")
  assert.equal(worker.clusterName, "finnor-production")
  assert.equal(worker.serviceName, "finnor-worker")
  assert.equal(worker.sseGatewayUrl, "https://realtime.finnorai.com")
  assert.equal(contract.release.requiredMigrationHead, "0187_r3_incentive_rule_synthesis.sql")
  assert.ok(!contract.release.mutationAuthorization.allowedOperations.includes("product-authority-update"))
  assert.ok(!contract.release.mutationAuthorization.allowedOperations.includes("epistemic-impact-activate"))
  assert.deepEqual(contract.release.requiredComponents, ["frontend", "api", "computeRealtime", "computeInteractive", "computeBackground", "computeHeavy", "supplierCanaryApp", "supplierCanaryAuth"])
  assert.equal(new Set(Object.values(contract.topology.computePlane.classes).map((profile) => profile.serviceName)).size, 4)
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

test("active release workflow uses the governed four-class AWS compute cutover", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/production-release.yml", import.meta.url), "utf8")
  assert.doesNotMatch(workflow, /azure\/login|AZURE_|deploy-azure|RunCommand|cloudapp\.azure/i)
  assert.match(workflow, /aws-actions\/configure-aws-credentials@cbe3b392738ccf3f987d68400dafcf4b0624a56c/)
  const smoke = readFileSync(new URL("./smoke-worker-image.sh", import.meta.url), "utf8")
  assert.match(workflow, /bash scripts\/release\/smoke-worker-image\.sh/)
  assert.match(smoke, /docker build/)
  assert.match(workflow, /docker push/)
  assert.match(workflow, /deploy-aws-compute-plane\.mjs/)
  const computeSessionPolicy = workflow.match(/- name: Authenticate exact AWS project with GitHub OIDC for ECS[\s\S]*?inline-session-policy: >-\s*([^\n]+)/)?.[1]
  assert.ok(computeSessionPolicy, "compute deployment must use a scoped AWS session")
  assert.ok(computeSessionPolicy.length <= 2048, "the inline STS session policy must fit AWS's 2,048-character limit")
  const computePolicy = JSON.parse(computeSessionPolicy)
  const computeStatements = computePolicy.Statement
  const computeActions = computeStatements.flatMap((statement) => Array.isArray(statement.Action) ? statement.Action : [statement.Action])
  assert.ok(computeActions.length > 0)
  assert.ok(computeActions.every((action) => typeof action === "string" && !action.endsWith(":*")), "the deploy session must enumerate every AWS action")
  for (const statement of computeStatements.filter((entry) => entry.Resource === "*")) {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action]
    assert.ok(actions.every((action) => action === "ecr:GetAuthorizationToken" || /:(?:Describe|List)[A-Za-z]+$/.test(action)), `wildcard resource is restricted to read-only discovery actions: ${actions.join(", ")}`)
  }
  const computeResources = computeStatements.flatMap((statement) => Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource])
  assert.ok(computeResources.some((resource) => resource?.endsWith(":stack/finnor-production/*")), "CloudFormation is restricted to the production stack")
  assert.match(JSON.stringify(computePolicy), /"ecs:cluster":"arn:aws:ecs:us-east-1:601804670058:cluster\/finnor-production"/, "task listing is restricted to the production cluster")
  assert.ok(computeResources.some((resource) => resource?.includes(":service/finnor-production/finnor-")), "ECS services are restricted to FINNOR services")
  assert.ok(computeResources.some((resource) => resource?.endsWith(":repository/finnor-worker")), "ECR writes are restricted to the worker repository")
  const iamActions = computeActions.filter((action) => action.startsWith("iam:"))
  assert.ok(iamActions.every((action) => action === "iam:PassRole"), "the deployment session can only pass the named ECS task roles, not mutate IAM")
  const ecrSessionPolicy = workflow.match(/- name: Authenticate exact AWS project with GitHub OIDC for ECR[\s\S]*?inline-session-policy: >-\s*([^\n]+)/)?.[1]
  assert.ok(ecrSessionPolicy, "worker image publication must use a scoped AWS session")
  const ecrPolicy = JSON.parse(ecrSessionPolicy)
  assert.ok(ecrSessionPolicy.length <= 2048)
  assert.ok(ecrPolicy.Statement.some((statement) => statement.Action === "ecr:GetAuthorizationToken" && statement.Resource === "*"))
  assert.ok(ecrPolicy.Statement.some((statement) => Array.isArray(statement.Action) && statement.Action.includes("ecr:PutImage") && statement.Resource === "arn:aws:ecr:us-east-1:601804670058:repository/finnor-worker"))
  const computeTemplate = readFileSync(new URL("../../infra/aws/finnor-production.yaml", import.meta.url), "utf8")
  assert.match(computeTemplate, /Sid: LogGroupLookup, Effect: Allow, Action: logs:DescribeLogGroups, Resource: '\*'/)
  assert.match(computeTemplate, /Sid: ComputeScalingTags[\s\S]{0,240}application-autoscaling:TagResource[\s\S]{0,120}application-autoscaling:UntagResource[\s\S]{0,180}scalable-target\/\*/)
  for (const path of ["preflight-production.mjs", "deploy-aws-compute-plane.mjs"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8")
    assert.match(source, /UPDATE_ROLLBACK_COMPLETE/, `${path} must accept a stable stack after a governed rollback`)
  }
  const deployStage = workflow.match(/deploy_stage\(\) \{([\s\S]*?)\n          \}/)?.[1]
  assert.ok(deployStage, "production workflow must define the compute deploy stage")
  for (const argument of ["preflight-evidence", "database-env", "image-digest"]) {
    assert.match(deployStage, new RegExp(`--${argument}=\\"\\$FINNOR_[A-Z_]+\\"`))
  }
  assert.doesNotMatch(workflow, /deploy-aws-worker\.mjs/)
  const readinessWorkflow = readFileSync(new URL("../../.github/workflows/release-readiness.yml", import.meta.url), "utf8")
  assert.match(workflow, /uses: \.\/\.github\/workflows\/release-readiness\.yml/)
  assert.match(readinessWorkflow, /release:scope4-digital-twin\b/)
  assert.match(readinessWorkflow, /release:scope5-epistemic-impact\b/)
  assert.match(workflow, /deploy-production\.mjs supplierCanaryApp/)
  assert.match(workflow, /deploy-production\.mjs supplierCanaryAuth/)
  assert.doesNotMatch(workflow, /run-p8-production-water-retirement\.mjs|release:scope5:rollout/)
  assert.match(workflow, /Verify final PE product authority readiness/)
  assert.match(readinessWorkflow, /phase5-readiness/)
  for (const envName of [
    "VERCEL_FRONTEND_AUTOMATION_BYPASS_SECRET",
    "VERCEL_API_AUTOMATION_BYPASS_SECRET",
    "VERCEL_SUPPLIER_CANARY_APP_AUTOMATION_BYPASS_SECRET",
    "VERCEL_SUPPLIER_CANARY_AUTH_AUTOMATION_BYPASS_SECRET",
  ]) assert.match(workflow, new RegExp(envName))
  assert.doesNotMatch(workflow, /FINNOR_CORE_CERTIFICATION_FILE=|release:certify -- core/)
})

test("supplier canary builds are isolated from the finnor-os workspace lockfile", () => {
  const deployScript = readFileSync(new URL("./deploy-production.mjs", import.meta.url), "utf8")
  assert.match(deployScript, /isolateCanaryBuild = appName\.startsWith\("supplierCanary"\)/)
  assert.match(deployScript, /mkdtempSync\(join\(tmpdir\(\), "finnor-vercel-canary-"\)\)/)
  assert.match(deployScript, /cpSync\(appDir, buildDir, \{\s*recursive: true/)
  assert.match(deployScript, /worktreeStatus\(repoRoot\)/)
  assert.match(deployScript, /vercel", \["build"[\s\S]*buildDir/)
  assert.match(deployScript, /vercel", deployArgs, buildDir, withVercelToken\(withoutSecrets\(env\)\)/)
})

test("Vercel release authentication is explicit and redacted", () => {
  const deployScript = readFileSync(new URL("./deploy-production.mjs", import.meta.url), "utf8")
  const workflow = readFileSync(new URL("../../.github/workflows/production-release.yml", import.meta.url), "utf8")
  assert.match(deployScript, /function withVercelToken\(sourceEnv\)/)
  assert.match(deployScript, /VERCEL_TOKEN: vercelToken/)
  assert.match(deployScript, /run\("vercel", \["pull", "--yes", "--environment=production"\], pullDir, withVercelToken\(withoutSecrets\(env\)\)\)/)
  assert.match(deployScript, /run\("vercel", deployArgs, buildDir, withVercelToken\(withoutSecrets\(env\)\)\)/)
  assert.doesNotMatch(deployScript, /--token/)
  assert.match(workflow, /vercel pull --yes --environment=production/)
  assert.doesNotMatch(workflow, /vercel pull[^\n]*--token/)
  assert.match(workflow, /deploy-production\.mjs supplierCanaryApp --prepare-only/)
  assert.match(workflow, /deploy-production\.mjs supplierCanaryAuth --prepare-only/)
})

test("isolated supplier canary builds preserve canonical Vercel routing", () => {
  const deployScript = readFileSync(new URL("./deploy-production.mjs", import.meta.url), "utf8")
  const canaryConfig = JSON.parse(readFileSync(new URL("../../finnor-os/apps/supplier-canary/vercel.json", import.meta.url), "utf8"))
  assert.ok(Array.isArray(canaryConfig.rewrites) && canaryConfig.rewrites.length > 0)
  assert.ok(canaryConfig.rewrites.some((rewrite) => rewrite.source === "/(.*)" && rewrite.destination === "/api/index.mjs"))
  assert.match(deployScript, /let buildConfig = \{ installCommand: app\.installCommand \}/)
  assert.match(deployScript, /if \(isolateCanaryBuild\)/)
  assert.match(deployScript, /JSON\.parse\(readFileSync\(join\(appDir, "vercel\.json"\), "utf8"\)\)/)
  assert.match(deployScript, /\.\.\.canonicalConfig, installCommand: app\.installCommand/)
})

test("supplier canary verification honors Vercel deployment protection", () => {
  const verifier = readFileSync(new URL("./verify-supplier-canary-release.mjs", import.meta.url), "utf8")
  const protection = readFileSync(new URL("./vercel-protection.mjs", import.meta.url), "utf8")
  assert.match(verifier, /vercelProtectionHeaders\(component\)/)
  assert.match(protection, /VERCEL_SUPPLIER_CANARY_APP_AUTOMATION_BYPASS_SECRET/)
  assert.match(protection, /VERCEL_SUPPLIER_CANARY_AUTH_AUTOMATION_BYPASS_SECRET/)
  assert.match(protection, /x-vercel-protection-bypass/)
})

test("Water retirement waits for rolling ECS heartbeat overlap before freeze", () => {
  const retirement = readFileSync(new URL("./run-p8-production-water-retirement.mjs", import.meta.url), "utf8")
  assert.match(retirement, /const freshBefore = await readFreshRuntimeRows\(\)/)
  assert.match(retirement, /awaitPreCutoverFleet\(currentSurfaces, Number\(authorityBefore\.epoch\)\)/)
  assert.match(retirement, /strict all-role, single-release assertion below/)
  assert.doesNotMatch(retirement, /assertCompatibleRuntimeRows\(freshBefore,/)
})

test("runtime parity requires the embedded orchestrator and exact migration", () => {
  const observed = {
    frontend: { ...expected, traceable: true },
    api: { ...expected, traceable: true },
    computeRealtime: { ...expected, traceable: true, capabilities: ["jobs", "realtime", "sse"] },
    computeInteractive: { ...expected, traceable: true, capabilities: ["jobs", "orchestration"] },
    computeBackground: { ...expected, traceable: true, capabilities: ["jobs", "recovery"] },
    computeHeavy: { ...expected, traceable: true, capabilities: ["jobs", "computer"] },
    supplierCanaryApp: { ...expected, traceable: true },
    supplierCanaryAuth: { ...expected, traceable: true },
    migrationHead: contract.release.requiredMigrationHead,
  }
  assert.doesNotThrow(() => assertRuntimeParity(contract, expected, observed))
  assert.throws(() => assertRuntimeParity(contract, expected, { ...observed, migrationHead: "0108_operating_product_closure.sql" }), /migration head/)
})

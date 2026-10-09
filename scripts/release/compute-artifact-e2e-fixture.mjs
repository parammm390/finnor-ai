import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
export const SHA = "a".repeat(40)
export const DIGEST = `sha256:${"b".repeat(64)}`
export const NO_CHANGES = "The submitted information didn't contain changes. Submit different information to create a change set."
export const classes = ["REALTIME", "INTERACTIVE", "BACKGROUND", "HEAVY"]
export const captureRoot = "/tmp/finnor-production-compute-artifact-e2e-captures"
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")

export function createFixture(t, scenario = "valid") {
  const root = mkdtempSync(join(tmpdir(), "finnor-release-e2e-"))
  const repo = join(root, "repo")
  const scripts = join(repo, "scripts/release")
  mkdirSync(scripts, { recursive: true })
  for (const name of ["deploy-production.mjs", "deploy-aws-compute-plane.mjs", "compute-plane-policy.mjs", "release-policy.mjs", "protected-env.mjs", "worktree-state.mjs", "vercel-build-context.mjs"]) {
    cpSync(join(sourceRoot, "scripts/release", name), join(scripts, name))
  }
  mkdirSync(join(repo, "infra/deployment"), { recursive: true })
  mkdirSync(join(repo, "infra/aws"), { recursive: true })
  const contract = JSON.parse(readFileSync(join(sourceRoot, "infra/deployment/production.contract.json"), "utf8"))
  writeFileSync(join(repo, "infra/deployment/production.contract.json"), JSON.stringify(contract))
  cpSync(join(sourceRoot, "infra/aws/finnor-production.yaml"), join(repo, "infra/aws/finnor-production.yaml"))
  for (const name of ["package.json", "package-lock.json", "finnor-os/package.json", "finnor-os/package-lock.json"]) {
    mkdirSync(dirname(join(repo, name)), { recursive: true })
    cpSync(join(sourceRoot, name), join(repo, name))
  }
  mkdirSync(join(repo, "finnor-os/packages/db"), { recursive: true })
  cpSync(join(sourceRoot, "finnor-os/packages/db/postgres-connection.mjs"), join(repo, "finnor-os/packages/db/postgres-connection.mjs"))
  cpSync(join(sourceRoot, "finnor-os/packages/db/production-database-admission.mjs"), join(repo, "finnor-os/packages/db/production-database-admission.mjs"))
  const appDir = join(repo, contract.topology.supplierCanaryApp.releaseWorkingDirectory)
  mkdirSync(appDir, { recursive: true })
  writeFileSync(join(appDir, "package.json"), '{"name":"fixture-canary","private":true,"type":"module"}\n')
  writeFileSync(join(appDir, "package-lock.json"), '{"name":"fixture-canary","lockfileVersion":3,"packages":{}}\n')
  writeFileSync(join(appDir, "vercel.json"), '{"rewrites":[{"source":"/(.*)","destination":"/api/index.mjs"}]}\n')
  mkdirSync(join(appDir, "api"))
  writeFileSync(join(appDir, "api/index.mjs"), 'export default function handler() { return "fixture"; }\n')
  const stateFile = join(root, "state.json")
  const log = join(root, "commands.jsonl")
  const state = { root, repo, scenario, sha: SHA, digest: DIGEST, contract, log }
  writeFileSync(stateFile, JSON.stringify(state))
  const fixtureUrl = pathToFileURL(fileURLToPath(import.meta.url)).href
  writeFileSync(join(scripts, "production-mutation-guard.mjs"), `
    import { fixtureAuthorize } from ${JSON.stringify(fixtureUrl)};
    export const authorizeProductionMutation = fixtureAuthorize;
  `)
  const pgDir = join(repo, "finnor-os/node_modules/pg")
  mkdirSync(pgDir, { recursive: true })
  writeFileSync(join(pgDir, "package.json"), '{"name":"pg","main":"index.cjs"}')
  writeFileSync(join(pgDir, "index.cjs"), `
    const fs = require("node:fs");
    class Client {
      async connect() {}
      async end() {}
      async query(sql) {
        const { fixtureQuery } = await import(${JSON.stringify(fixtureUrl)});
        return fixtureQuery(sql);
      }
    }
    module.exports = { Client };
  `)
  const bin = join(root, "bin")
  mkdirSync(bin)
  for (const name of ["git", "aws", "vercel"]) {
    writeFileSync(join(bin, name), `#!${process.execPath}\nimport { mockCommand } from ${JSON.stringify(fixtureUrl)};\nprocess.env.FIXTURE_STATE = ${JSON.stringify(stateFile)};\nmockCommand(${JSON.stringify(name)}, process.argv.slice(2));\n`, { mode: 0o755 })
  }
  const runner = join(root, "runner-temp")
  mkdirSync(runner)
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: join(root, "home"), RUNNER_TEMP: runner, FIXTURE_STATE: stateFile,
    AWS_REGION: contract.topology.worker.region, FINNOR_COMMIT_SHA: SHA,
    FINNOR_BUILD_ID: `finnor-${SHA.slice(0, 12)}`, FINNOR_VERSION: `0.1.0+${SHA.slice(0, 12)}`,
    FINNOR_ENVIRONMENT: "production", FINNOR_RELEASE_SOURCE: "github-actions",
    VERCEL_TOKEN: "fixture-only-not-a-credential",
    GH_TOKEN: "fixture-only-not-a-credential", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-only",
    AWS_SECRET_ACCESS_KEY: "fixture-only", FINNOR_PROTECTED_DATABASE_ENV: join(root, "database.env"),
  }
  writeFileSync(env.FINNOR_PROTECTED_DATABASE_ENV, `MIGRATIONS_DATABASE_URL=postgres://postgres.kpxrnonhnhexutvdywbh:fixture-only@${contract.topology.database.host}:5432/postgres\n`)
  const preflight = join(root, "preflight.json")
  writeFileSync(preflight, JSON.stringify({
    ok: true, checkedAt: new Date().toISOString(), commitSha: SHA, remoteMain: SHA,
    contractSha256: hash(readFileSync(join(repo, "infra/deployment/production.contract.json"))),
    aws: { accountId: contract.topology.worker.accountId, region: contract.topology.worker.region },
  }))
  const captures = []
  t.after(() => {
    mkdirSync(captureRoot, { recursive: true })
    writeFileSync(join(captureRoot, `${scenario}-${root.split("/").at(-1)}.json`), JSON.stringify({
      schema: "finnor.release-local-e2e-capture.v1", qualification: "MOCK_PROVIDER_NOT_DEPLOYMENT_PROOF",
      scenario, sourceSha256: {
        compute: hash(readFileSync(join(scripts, "deploy-aws-compute-plane.mjs"))),
        canary: hash(readFileSync(join(scripts, "deploy-production.mjs"))),
      }, invocations: captures, commands: events(),
    }, null, 2))
    rmSync(root, { recursive: true, force: true })
  })
  const events = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : []
  const run = (script, args = []) => {
    const result = spawnSync(process.execPath, [join(scripts, script), ...args], {
      cwd: repo, env, encoding: "utf8", timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    })
    captures.push({ script, args, status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message })
    return result
  }
  return {
    root, repo, runner, appDir, contract, env, events,
    setScenario(value) { state.scenario = value; writeFileSync(stateFile, JSON.stringify(state)) },
    compute(stage = "rollout") { return run("deploy-aws-compute-plane.mjs", [`--stage=${stage}`, `--database-env=${env.FINNOR_PROTECTED_DATABASE_ENV}`, `--image-digest=${DIGEST}`, `--preflight-evidence=${preflight}`]) },
    canary(component, mode) { return run("deploy-production.mjs", [component, mode]) },
    prepared(component) { return join(runner, "finnor-prepared-canaries", SHA, component) },
  }
}

function state() { return JSON.parse(readFileSync(process.env.FIXTURE_STATE, "utf8")) }
function log(value) { appendFileSync(state().log, `${JSON.stringify(value)}\n`) }
export async function fixtureAuthorize(operation) {
  const s = state()
  log({ command: "authorize", operation })
  if (s.scenario === "auth-denied") throw new Error("FIXTURE_AUTHORIZATION_DENIED")
  if (s.scenario === "artifact-auth-race") {
    const base = join(s.root, "runner-temp/finnor-prepared-canaries", SHA, "supplierCanaryApp/context/.vercel/output/config.json")
    writeFileSync(base, '{"version":3,"tampered":true}')
  }
  return Object.freeze({ ok: true, operation, commitSha: SHA })
}

function fleet(s) {
  const profiles = s.contract.topology.computePlane.classes
  const image = `${s.contract.topology.worker.accountId}.dkr.ecr.${s.contract.topology.worker.region}.amazonaws.com/finnor-worker@${DIGEST}`
  return classes.map((name, i) => {
    const profile = profiles[name]
    const taskArn = `arn:aws:ecs:us-east-1:${s.contract.topology.worker.accountId}:task/finnor-production/${name}`
    const definition = `arn:aws:ecs:us-east-1:${s.contract.topology.worker.accountId}:task-definition/${profile.taskFamily}:7`
    const ip = `10.0.0.${i + 10}`
    const env = { FINNOR_COMMIT_SHA: SHA, FINNOR_BUILD_ID: `finnor-${SHA.slice(0, 12)}`, FINNOR_VERSION: `0.1.0+${SHA.slice(0, 12)}`, FINNOR_RELEASE_SOURCE: "github-actions", FINNOR_ENVIRONMENT: "production", FINNOR_CORE_CERTIFICATION_ID: `post-merge:${SHA}`, FINNOR_WORKLOAD_CLASS: name }
    return { name, profile, taskArn, definition, ip,
      service: { status: "ACTIVE", serviceName: profile.serviceName, launchType: "FARGATE", desiredCount: 1, runningCount: 1, pendingCount: 0, taskDefinition: definition, deployments: [{ status: "PRIMARY", taskDefinition: definition, rolloutState: "COMPLETED" }] },
      task: { taskArn, taskDefinitionArn: definition, lastStatus: "RUNNING", attachments: [{ details: [{ name: "privateIPv4Address", value: ip }] }], containers: [{ name: profile.containerName, lastStatus: "RUNNING", healthStatus: "HEALTHY", imageDigest: DIGEST }] },
      taskDefinition: { taskDefinitionArn: definition, family: profile.taskFamily, executionRoleArn: `arn:aws:iam::${s.contract.topology.worker.accountId}:role/${s.contract.topology.worker.executionRoleName}`, taskRoleArn: `arn:aws:iam::${s.contract.topology.worker.accountId}:role/${profile.taskRoleName}`, containerDefinitions: [{ name: profile.containerName, image: s.scenario === "task-image" && i === 2 ? "wrong:image" : image, environment: Object.entries({ ...env, ...(s.scenario === "task-sha" && i === 2 ? { FINNOR_COMMIT_SHA: "c".repeat(40) } : {}) }).map(([name, value]) => ({ name, value })) }] },
      beat: { service: profile.heartbeatService, instanceId: `ecs:${taskArn}`, releaseSha: s.scenario === "mixed-beat" && i === 2 ? "c".repeat(40) : SHA, buildId: env.FINNOR_BUILD_ID, version: env.FINNOR_VERSION, releaseSource: env.FINNOR_RELEASE_SOURCE, environment: env.FINNOR_ENVIRONMENT, migrationHead: s.contract.release.requiredMigrationHead, deploymentId: `ecs:fixture:${name}`, capabilities: ["jobs"], lastBeatAt: new Date(Date.now() - (s.scenario === "stale-beat" ? 60_000 : 0)).toISOString(), meta: { serviceClass: name, draining: false, taskArn, processConcurrency: profile.workerConcurrency, allowedWorkloadClasses: [name] } },
    }
  })
}
export async function fixtureQuery(sql) {
  const s = state()
  log({ command: "pg", sql: sql.replace(/\s+/g, " ").trim() })
  if (sql.includes("_migrations")) return { rows: [{ name: s.contract.release.requiredMigrationHead }] }
  if (sql.includes("compute_plane_cutover") && !sql.includes("UPDATE")) return { rows: [{ state: "authoritative", accepted_job_epoch: s.scenario === "db-fence" ? 1 : 3, minimum_claim_epoch: 3, activated_release_sha: SHA, legacy_tenant_writes_allowed: false, enforce_known_job_types: true }] }
  if (sql.includes("service_release_heartbeats")) {
    const rows = fleet(s).map((entry) => entry.beat)
    if (s.scenario === "duplicate-beat") rows.push(rows[0])
    return { rows }
  }
  if (sql.includes("count(*)")) return { rows: [{ count: 0 }] }
  if (sql.includes("UPDATE")) return { rows: [{ state: "authoritative" }], rowCount: 1 }
  return { rows: [], rowCount: 0 }
}

export function mockCommand(name, args) {
  const s = state()
  log({ command: name, args, cwd: process.cwd(), oidcPresent: Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN), awsSecretPresent: Boolean(process.env.AWS_SECRET_ACCESS_KEY), ghTokenPresent: Boolean(process.env.GH_TOKEN) })
  const out = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value))
  if (name === "git") {
    if (args.includes("--show-toplevel")) return out(s.repo)
    if (args.includes("HEAD")) return out(SHA)
    if (args[0] === "ls-remote") return out(`${SHA}\trefs/heads/main\n`)
    if (args[0] === "remote") return out("https://github.com/parammm390/finnor-ai.git")
    if (args[0] === "branch" || args.includes("--abbrev-ref")) return out("main")
    if (["status", "diff", "ls-files"].includes(args[0])) return out("")
    throw new Error(`Unknown fixture git: ${args.join(" ")}`)
  }
  if (name === "vercel") {
    if (args.includes("--version")) return out("Vercel CLI 50.15.1\n")
    const project = [s.contract.topology.supplierCanaryApp, s.contract.topology.supplierCanaryAuth].find((target) => target.projectId === process.env.VERCEL_PROJECT_ID)
    if (args[0] === "pull") {
      mkdirSync(".vercel", { recursive: true })
      writeFileSync(".vercel/project.json", JSON.stringify({ orgId: process.env.VERCEL_ORG_ID, projectId: process.env.VERCEL_PROJECT_ID, settings: { rootDirectory: process.env.VERCEL_PROJECT_ID === s.contract.topology.api.projectId ? "apps/api" : null } }))
      writeFileSync(".vercel/.env.production.local", [
        `PORTAL_ROLE=${s.scenario === "wrong-role" ? "wrong" : project?.portalRole ?? "app"}`,
        "NEXT_PUBLIC_FIXTURE=public-config", "DATABASE_URL=fixture-secret-db",
        "SUPABASE_SERVICE_ROLE_KEY=fixture-secret-service", "CANARY_SIGNING_KEY=fixture-secret-signing",
        ...(process.env.VERCEL_PROJECT_ID === s.contract.topology.api.projectId ? [
          `SECRETS_PROVIDER=${s.scenario === "api-invalid-provider" ? "env" : "aws-secrets-manager"}`,
          `FINNOR_SECRET_IDS=${JSON.stringify(JSON.stringify({ GROQ_API_KEY: "finnor/prod/groq-api-key" }))}`,
          "FINNOR_TENANT_SECRET_PREFIX=finnor/tenants/",
          "FINNOR_SYSTEM_CREDENTIAL_PROVIDERS=resend",
        ] : []),
        ...(s.scenario === "public-service-key" ? ["NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY=fixture-secret-public-service"] : []),
      ].join("\n"))
      return out("Fixture pull\n")
    }
    if (args[0] === "build") {
      const env = readFileSync(".vercel/.env.production.local", "utf8")
      if (/fixture-secret/.test(env) && s.scenario !== "public-service-key") throw new Error("Build environment retained private fixture secrets")
      mkdirSync(".vercel/output/functions/health.func", { recursive: true })
      writeFileSync(".vercel/output/config.json", '{"version":3}\n')
      writeFileSync(".vercel/output/functions/health.func/index.mjs", `export const role=${JSON.stringify(project?.portalRole)};\n`)
      if (s.scenario === "api-file-map") {
        symlinkSync("health.func", ".vercel/output/functions/alias.func")
        writeFileSync(".vercel/output/functions/health.func/.vc-config.json", JSON.stringify({
          runtime: "nodejs22.x", handler: "index.mjs",
          filePathMap: { "package-lock.json": "package-lock.json" },
        }))
      }
      return out("Fixture build\n")
    }
    if (args[0] === "deploy") {
      if (!existsSync(".vercel/output/config.json")) throw new Error("No prepared output")
      log({ command: "deployed-output", outputSha256: hash(readFileSync(".vercel/output/config.json")) })
      return out("Production: https://fixture-deployment.vercel.app\n")
    }
    throw new Error(`Unknown fixture vercel: ${args.join(" ")}`)
  }
  if (name === "aws") {
    const [service, command] = args
    const f = fleet(s)
    if (service === "sts") return out({ Account: s.contract.topology.worker.accountId })
    if (service === "ecr") {
      const previous = readFileSync(s.log, "utf8").split("\n").filter((line) => line.includes('"command":"aws"') && line.includes('"ecr"')).length
      return out({ imageDetails: [{ imageDigest: s.scenario === "ecr-race" && previous > 1 ? `sha256:${"c".repeat(64)}` : DIGEST }] })
    }
    if (service === "cloudformation" && command === "describe-stacks") {
      const count = readFileSync(s.log, "utf8").split("\n").filter((line) => line.includes('"describe-stacks"')).length
      const parameters = { ImageUri: `${s.contract.topology.worker.accountId}.dkr.ecr.us-east-1.amazonaws.com/finnor-worker@${DIGEST}`, ReleaseCommitSha: SHA, ReleaseBuildId: `finnor-${SHA.slice(0, 12)}`, ReleaseVersion: `0.1.0+${SHA.slice(0, 12)}`, CoreCertificationId: `post-merge:${SHA}`, SupabaseUrl: s.contract.topology.database.supabaseUrl, ComputePlaneStage: s.scenario === "routing-recovery" ? "preparing" : "finalized", LegacyWorkerTaskDefinitionArn: "" }
      parameters.SecretMap = JSON.stringify(s.contract.topology.worker.secretMap)
      parameters.RealtimeSecretMap = JSON.stringify(Object.fromEntries(["DATABASE_URL","SENTRY_DSN","SUPABASE_SERVICE_ROLE_KEY"].map((key) => [key,s.contract.topology.worker.secretMap[key]])))
      parameters.HeavySecretMap = JSON.stringify(Object.fromEntries(["DATABASE_URL","GROQ_API_KEY","REDIS_URL","SENTRY_DSN"].map((key) => [key,s.contract.topology.worker.secretMap[key]])))
      if (s.scenario === "parameter-sha") parameters.ReleaseCommitSha = "c".repeat(40)
      if (s.scenario === "parameter-digest") parameters.ImageUri = "wrong:image"
      return out({ Stacks: [{ StackName: "finnor-production", StackId: `arn:aws:cloudformation:us-east-1:${s.contract.topology.worker.accountId}:stack/finnor-production/fixture`, StackStatus: s.scenario === "unstable-stack" && count > 1 ? "UPDATE_IN_PROGRESS" : "UPDATE_COMPLETE", Parameters: Object.entries(parameters).map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })) }] })
    }
    if (service === "cloudformation" && command === "get-template") return out({ TemplateBody: s.scenario === "template-drift" ? "wrong template" : readFileSync(join(s.repo, "infra/aws/finnor-production.yaml"), "utf8") })
    if (service === "cloudformation" && command === "create-change-set") return out({ Id: "fixture-change-set" })
    if (service === "cloudformation" && command === "describe-change-set") {
      if (s.scenario === "normal-rollout") return out({ Status: "CREATE_COMPLETE", Changes: ["Worker", "Interactive", "Background", "Heavy"].map((name) => ({ ResourceChange: { LogicalResourceId: `${name}TaskDefinition`, Action: "Modify" } })) })
      if (s.scenario === "routing-recovery") return out({ Status: "CREATE_COMPLETE", Changes: [{ ResourceChange: { LogicalResourceId: "HttpsRealtimeListener", Action: "Modify" } }] })
      return out({ Status: s.scenario === "empty-complete" ? "CREATE_COMPLETE" : "FAILED", StatusReason: s.scenario === "failed-reason" ? "Access denied" : s.scenario === "near-reason" ? `${NO_CHANGES} ` : NO_CHANGES, Changes: s.scenario === "failed-changes" ? [{ ResourceChange: { Action: "Modify", LogicalResourceId: "WorkerTaskDefinition" } }] : [] })
    }
    if (service === "cloudformation" && command === "execute-change-set") return out({})
    if (service === "ecs" && command === "describe-services") return out({ services: f.filter((entry) => s.scenario !== "missing-class" || entry.name !== "BACKGROUND").map((entry) => entry.service) })
    if (service === "ecs" && command === "list-tasks") return out({ taskArns: f.filter((entry) => entry.profile.serviceName === args[args.indexOf("--service-name") + 1]).map((entry) => entry.taskArn) })
    if (service === "ecs" && command === "describe-tasks") return out({ tasks: f.filter((entry) => args.includes(entry.taskArn)).map((entry) => entry.task) })
    if (service === "ecs" && command === "describe-task-definition") return out({ taskDefinition: f.find((entry) => args.includes(entry.definition))?.taskDefinition })
    if (service === "elbv2" && command === "describe-target-groups") return out({ TargetGroups: [{ TargetGroupArn: "fixture-target-group", TargetType: "ip", Port: 8090, VpcId: s.contract.topology.worker.vpcId, HealthCheckPath: "/healthz", HealthCheckProtocol: "HTTP" }] })
    if (service === "elbv2" && command === "describe-target-health") return out({ TargetHealthDescriptions: [{ Target: { Id: f[0].ip, Port: 8090 }, TargetHealth: { State: s.scenario === "alb-health" ? "unhealthy" : "healthy" } }, ...(s.scenario === "alb-extra" ? [{ Target: { Id: "10.0.0.99", Port: 8090 }, TargetHealth: { State: "healthy" } }] : [])] })
    throw new Error(`Unknown fixture AWS: ${args.join(" ")}`)
  }
  throw new Error("Unrecognized fixture command")
}

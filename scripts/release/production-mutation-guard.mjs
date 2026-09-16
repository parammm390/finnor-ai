import { execFileSync } from "node:child_process"
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { loadContract } from "./release-policy.mjs"

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)))
const contractPath = resolve(repoRoot, "infra/deployment/production.contract.json")
const FULL_SHA = /^[0-9a-f]{40}$/
const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com"
const GITHUB_OIDC_JWKS = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`
const productionMutationCapabilities = new WeakMap()

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]))
  }
  return value
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function authorizationDigest(payload) {
  return sha256(canonicalJson(payload))
}

function required(value, message) {
  if (value === undefined || value === null || value === "") throw new Error(message)
  return value
}

function jwtJson(segment, label) {
  try {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))
  } catch {
    throw new Error(`GitHub OIDC ${label} is invalid`)
  }
}

function expectedSubject(contract) {
  const [owner, repository] = contract.canonicalGit.repository.split("/")
  return `repo:${owner}@${contract.canonicalGit.repositoryOwnerId}/${repository}@${contract.canonicalGit.repositoryId}:environment:production`
}

export function validateGitHubOidcClaims({ claims, context, contract, now = Date.now() }) {
  const policy = contract.release.mutationAuthorization
  const audiences = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud]
  const issuedAt = Number(claims?.iat) * 1000
  const notBefore = Number(claims?.nbf) * 1000
  const expiresAt = Number(claims?.exp) * 1000
  if (claims?.iss !== GITHUB_OIDC_ISSUER || !audiences.includes(policy.oidcAudience)) throw new Error("GitHub OIDC issuer or audience is invalid")
  if (!Number.isFinite(issuedAt) || !Number.isFinite(notBefore) || !Number.isFinite(expiresAt) || issuedAt > now + 60_000 || now - issuedAt > 10 * 60_000 || notBefore > now + 60_000 || expiresAt < now - 60_000) {
    throw new Error("GitHub OIDC token is stale or outside its validity window")
  }
  const exact = [
    [claims.sub, expectedSubject(contract), "subject"],
    [claims.repository, context.repository, "repository"],
    [String(claims.repository_id), String(context.repositoryId), "repository id"],
    [String(claims.repository_owner_id), String(context.repositoryOwnerId), "repository owner id"],
    [claims.ref, context.ref, "ref"],
    [claims.sha?.toLowerCase(), context.sha, "SHA"],
    [String(claims.run_id), String(context.runId), "run id"],
    [String(claims.run_attempt), String(context.runAttempt), "run attempt"],
    [claims.event_name, context.eventName, "event"],
    [claims.environment, context.environment, "environment"],
    [claims.workflow, policy.workflowName, "workflow name"],
    [claims.workflow_ref, context.workflowRef, "workflow ref"],
  ]
  for (const [observed, expected, label] of exact) if (observed !== expected) throw new Error(`GitHub OIDC ${label} does not match the certified release`)
  if (claims.ref_protected !== "true" && claims.ref_protected !== true) throw new Error("GitHub OIDC token does not prove a protected main ref")
  if (claims.job_workflow_ref !== undefined && claims.job_workflow_ref !== context.workflowRef) throw new Error("GitHub OIDC job workflow ref is not canonical")
  return {
    issuer: claims.iss,
    audience: policy.oidcAudience,
    subject: claims.sub,
    workflow: claims.workflow,
    workflowRef: claims.workflow_ref,
  }
}

export function verifyGitHubOidcJwtSignature(token, jwks) {
  const parts = String(token).split(".")
  if (parts.length !== 3) throw new Error("GitHub OIDC token is not a JWT")
  const header = jwtJson(parts[0], "header")
  const claims = jwtJson(parts[1], "payload")
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("GitHub OIDC token uses an unsupported signature")
  const jwk = jwks?.keys?.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA")
  if (!jwk) throw new Error("GitHub OIDC signing key is unavailable")
  const key = createPublicKey({ key: jwk, format: "jwk" })
  const signed = Buffer.from(`${parts[0]}.${parts[1]}`)
  const signature = Buffer.from(parts[2], "base64url")
  if (!verifySignature("RSA-SHA256", signed, key, signature)) throw new Error("GitHub OIDC signature is invalid")
  return claims
}

async function readGitHubOidcIdentity(context, contract) {
  const requestUrl = new URL(required(process.env.ACTIONS_ID_TOKEN_REQUEST_URL, "GitHub OIDC request URL is unavailable"))
  requestUrl.searchParams.set("audience", contract.release.mutationAuthorization.oidcAudience)
  const requestToken = required(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "GitHub OIDC request token is unavailable")
  const [tokenResponse, jwksResponse] = await Promise.all([
    fetch(requestUrl, { headers: { authorization: `Bearer ${requestToken}` }, signal: AbortSignal.timeout(20_000) }),
    fetch(GITHUB_OIDC_JWKS, { signal: AbortSignal.timeout(20_000) }),
  ])
  const tokenBody = await tokenResponse.json().catch(() => null)
  const jwks = await jwksResponse.json().catch(() => null)
  if (!tokenResponse.ok || typeof tokenBody?.value !== "string") throw new Error(`GitHub OIDC mint failed (${tokenResponse.status})`)
  if (!jwksResponse.ok || !Array.isArray(jwks?.keys)) throw new Error(`GitHub OIDC key lookup failed (${jwksResponse.status})`)
  const claims = verifyGitHubOidcJwtSignature(tokenBody.value, jwks)
  return { claims, identity: validateGitHubOidcClaims({ claims, context, contract }) }
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim()
}

function currentContext(contract) {
  const head = git(["rev-parse", "HEAD"]).toLowerCase()
  const remoteMain = git(["ls-remote", contract.canonicalGit.remote, `refs/heads/${contract.canonicalGit.branch}`])
    .split(/\s+/)[0]?.toLowerCase() ?? ""
  return {
    actions: process.env.GITHUB_ACTIONS,
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    sha: process.env.GITHUB_SHA?.toLowerCase(),
    head,
    remoteMain,
    dirty: git(["status", "--porcelain=v1", "--untracked-files=normal"]),
    repository: process.env.GITHUB_REPOSITORY,
    repositoryId: process.env.GITHUB_REPOSITORY_ID,
    repositoryOwnerId: process.env.GITHUB_REPOSITORY_OWNER_ID,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    environment: process.env.FINNOR_ENVIRONMENT,
    releaseSource: process.env.FINNOR_RELEASE_SOURCE,
  }
}

async function githubJson(path, token) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "finnor-production-mutation-guard",
    },
    signal: AbortSignal.timeout(20_000),
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`GitHub authorization lookup failed (${response.status}) for ${path}: ${body?.message ?? "unknown error"}`)
  return body
}

async function readLiveRun(context, contract, token) {
  const repository = contract.canonicalGit.repository
  const [repo, run, jobs] = await Promise.all([
    githubJson(`/repos/${repository}`, token),
    githubJson(`/repos/${repository}/actions/runs/${context.runId}`, token),
    githubJson(`/repos/${repository}/actions/runs/${context.runId}/jobs?filter=latest&per_page=100`, token),
  ])
  return { repo, run, jobs: jobs.jobs ?? [] }
}

function expectedWorkflowRef(contract) {
  return `${contract.canonicalGit.repository}/${contract.release.mutationAuthorization.workflowPath}@refs/heads/${contract.canonicalGit.branch}`
}

export function validateProductionMutationAuthorization({
  authorization,
  operation,
  context,
  contract,
  contractSha256,
  live,
  oidcClaims,
  now = Date.now(),
}) {
  const policy = contract.release?.mutationAuthorization
  if (!policy || policy.schema !== "finnor-production-mutation-authorization.v1") throw new Error("production mutation authorization policy is missing or unsupported")
  if (!policy.allowedOperations?.includes(operation)) throw new Error(`production operation is not allowlisted: ${operation}`)
  if (context.actions !== "true") throw new Error("production mutation is restricted to GitHub Actions")
  if (context.eventName !== "push") throw new Error(`production mutation requires the canonical push event, received ${context.eventName ?? "<missing>"}`)
  if (context.ref !== `refs/heads/${contract.canonicalGit.branch}`) throw new Error(`production mutation requires refs/heads/${contract.canonicalGit.branch}`)
  if (context.repository !== contract.canonicalGit.repository) throw new Error("production mutation repository does not match the canonical contract")
  if (String(context.repositoryId) !== String(contract.canonicalGit.repositoryId)) throw new Error("production mutation repository id does not match the canonical contract")
  if (String(context.repositoryOwnerId) !== String(contract.canonicalGit.repositoryOwnerId)) throw new Error("production mutation repository owner id does not match the canonical contract")
  if (context.workflowRef !== expectedWorkflowRef(contract)) throw new Error("production mutation workflow ref is not the canonical main workflow")
  if (context.environment !== "production") throw new Error("production mutation requires the protected production environment")
  if (context.releaseSource !== "github-actions") throw new Error("production mutation release source must be github-actions")
  if (!FULL_SHA.test(context.sha ?? "") || context.sha !== context.head || context.sha !== context.remoteMain) {
    throw new Error("production mutation SHA is not the exact current origin/main commit")
  }
  if (context.dirty) throw new Error("production mutation requires an unmodified canonical checkout")
  const oidcIdentity = validateGitHubOidcClaims({ claims: oidcClaims, context, contract, now })
  if (!authorization || authorization.schema !== policy.schema) throw new Error("production mutation authorization evidence is missing or has the wrong schema")
  const { digest, ...payload } = authorization
  if (digest !== authorizationDigest(payload)) throw new Error("production mutation authorization digest is invalid")
  if (payload.repository !== context.repository || String(payload.repositoryId) !== String(context.repositoryId) || String(payload.repositoryOwnerId) !== String(context.repositoryOwnerId)) {
    throw new Error("production mutation authorization is bound to a different repository")
  }
  if (payload.commitSha !== context.sha || String(payload.runId) !== String(context.runId) || String(payload.runAttempt) !== String(context.runAttempt)) {
    throw new Error("production mutation authorization is bound to a different SHA or workflow run")
  }
  if (payload.workflowPath !== policy.workflowPath || payload.ref !== context.ref || payload.eventName !== context.eventName || payload.environment !== context.environment) {
    throw new Error("production mutation authorization has the wrong workflow, ref, event, or environment")
  }
  if (payload.contractSchemaVersion !== contract.schemaVersion || payload.contractSha256 !== contractSha256) {
    throw new Error("production mutation authorization is bound to a different deployment contract")
  }
  if (canonicalJson(payload.oidcIdentity) !== canonicalJson(oidcIdentity)) throw new Error("production mutation authorization is bound to a different cryptographic OIDC identity")
  if (!payload.allowedOperations?.includes(operation) || payload.allowedOperations.some((candidate) => !policy.allowedOperations.includes(candidate))) {
    throw new Error(`production mutation authorization does not permit ${operation}`)
  }
  const issuedAt = Date.parse(payload.issuedAt ?? "")
  const expiresAt = Date.parse(payload.expiresAt ?? "")
  const maxAgeMs = Number(policy.maxAgeSeconds) * 1000
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now || expiresAt < now || now - issuedAt > maxAgeMs || expiresAt - issuedAt > maxAgeMs) {
    throw new Error("production mutation authorization is stale or has an invalid validity window")
  }
  if (Number(live.repo?.id) !== Number(contract.canonicalGit.repositoryId) || Number(live.repo?.owner?.id) !== Number(contract.canonicalGit.repositoryOwnerId) || live.repo?.full_name !== contract.canonicalGit.repository) {
    throw new Error("live GitHub repository identity differs from the production contract")
  }
  if (
    String(live.run?.id) !== String(context.runId)
    || Number(live.run?.run_attempt) !== Number(context.runAttempt)
    || live.run?.event !== "push"
    || live.run?.head_branch !== contract.canonicalGit.branch
    || live.run?.head_sha?.toLowerCase() !== context.sha
    || live.run?.path !== policy.workflowPath
    || live.run?.status !== "in_progress"
  ) throw new Error("live GitHub workflow run identity is not the active canonical release")
  for (const jobName of policy.certificationJobs) {
    const job = live.jobs.find((candidate) => candidate.name === jobName)
    if (!job || job.status !== "completed" || job.conclusion !== "success" || job.run_attempt !== undefined && Number(job.run_attempt) !== Number(context.runAttempt)) {
      throw new Error(`required release certification job is not successful: ${jobName}`)
    }
    if (!payload.certifications?.some((candidate) => candidate.name === jobName && candidate.conclusion === "success")) {
      throw new Error(`authorization evidence omitted successful certification job: ${jobName}`)
    }
  }
  return { ok: true, operation, commitSha: context.sha, runId: String(context.runId), digest, oidcSubject: oidcIdentity.subject }
}

function contractState() {
  const bytes = readFileSync(contractPath)
  return { contract: JSON.parse(bytes.toString("utf8")), contractSha256: sha256(bytes) }
}

export async function issueProductionMutationAuthorization(outputPath) {
  const { contract, contractSha256 } = contractState()
  const context = currentContext(contract)
  const token = required(process.env.GH_TOKEN || process.env.GITHUB_TOKEN, "GH_TOKEN is required to issue production mutation authorization")
  const [live, oidc] = await Promise.all([readLiveRun(context, contract, token), readGitHubOidcIdentity(context, contract)])
  const policy = contract.release.mutationAuthorization
  const issuedAt = Date.now()
  const payload = {
    schema: policy.schema,
    repository: contract.canonicalGit.repository,
    repositoryId: String(contract.canonicalGit.repositoryId),
    repositoryOwnerId: String(contract.canonicalGit.repositoryOwnerId),
    commitSha: context.sha,
    runId: String(context.runId),
    runAttempt: Number(context.runAttempt),
    workflowPath: policy.workflowPath,
    ref: context.ref,
    eventName: context.eventName,
    environment: context.environment,
    contractSchemaVersion: contract.schemaVersion,
    contractSha256,
    oidcIdentity: oidc.identity,
    issuedAt: new Date(issuedAt).toISOString(),
    expiresAt: new Date(issuedAt + Number(policy.maxAgeSeconds) * 1000).toISOString(),
    allowedOperations: [...policy.allowedOperations],
    certifications: policy.certificationJobs.map((name) => ({ name, conclusion: "success" })),
  }
  const authorization = { ...payload, digest: authorizationDigest(payload) }
  validateProductionMutationAuthorization({ authorization, operation: policy.allowedOperations[0], context, contract, contractSha256, live, oidcClaims: oidc.claims, now: issuedAt })
  const destination = resolve(required(outputPath, "an output path is required for production mutation authorization"))
  writeFileSync(destination, `${JSON.stringify(authorization, null, 2)}\n`, { mode: 0o600 })
  chmodSync(destination, 0o600)
  return { path: destination, authorization }
}

export async function authorizeProductionMutation(operation, { authorizationPath = process.env.FINNOR_MUTATION_AUTHORIZATION } = {}) {
  const { contract, contractSha256 } = contractState()
  const context = currentContext(contract)
  const token = required(process.env.GH_TOKEN || process.env.GITHUB_TOKEN, "GH_TOKEN is required for production mutation authorization")
  const path = resolve(required(authorizationPath, "FINNOR_MUTATION_AUTHORIZATION is required for production mutation"))
  const authorization = JSON.parse(readFileSync(path, "utf8"))
  const [live, oidc] = await Promise.all([readLiveRun(context, contract, token), readGitHubOidcIdentity(context, contract)])
  const result = validateProductionMutationAuthorization({ authorization, operation, context, contract, contractSha256, live, oidcClaims: oidc.claims })
  const capability = Object.freeze({ ...result })
  productionMutationCapabilities.set(capability, { operation: result.operation, digest: result.digest })
  return capability
}

export function assertProductionMutationCapability(capability, operation) {
  const certified = capability && typeof capability === "object" ? productionMutationCapabilities.get(capability) : undefined
  if (!certified || certified.operation !== operation || capability.operation !== operation || capability.digest !== certified.digest) {
    throw new Error(`a certified ${operation} production mutation capability is required`)
  }
}

async function main() {
  const [command, operation] = process.argv.slice(2)
  if (command === "issue") {
    const outputIndex = process.argv.indexOf("--output")
    const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined
    const result = await issueProductionMutationAuthorization(output)
    console.log(JSON.stringify({ ok: true, path: result.path, commitSha: result.authorization.commitSha, runId: result.authorization.runId, digest: result.authorization.digest }, null, 2))
    return
  }
  if (command === "authorize" && operation) {
    console.log(JSON.stringify(await authorizeProductionMutation(operation), null, 2))
    return
  }
  throw new Error("Usage: node scripts/release/production-mutation-guard.mjs issue --output <path> | authorize <operation>")
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}

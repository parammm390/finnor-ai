import assert from "node:assert/strict"
import { generateKeyPairSync, sign } from "node:crypto"
import test from "node:test"
import { assertProductionMutationCapability, authorizationDigest, validateGitHubOidcClaims, validateProductionMutationAuthorization, verifyGitHubOidcJwtSignature } from "./production-mutation-guard.mjs"

const sha = "a".repeat(40)
const now = Date.parse("2026-09-16T10:00:00.000Z")
const operation = "database-migrate"
const contractSha256 = "b".repeat(64)
const contract = {
  schemaVersion: 2,
  canonicalGit: {
    branch: "main",
    repository: "parammm390/finnor-ai",
    repositoryId: "1306076635",
    repositoryOwnerId: "221117685",
  },
  release: {
    mutationAuthorization: {
      schema: "finnor-production-mutation-authorization.v1",
      workflowPath: ".github/workflows/production-release.yml",
      workflowName: "production-release",
      oidcAudience: "finnor-production-mutation.v1",
      maxAgeSeconds: 7200,
      certificationJobs: ["post-merge-certification"],
      allowedOperations: [operation, "vercel-production-deploy"],
    },
  },
}
const context = {
  actions: "true",
  eventName: "push",
  ref: "refs/heads/main",
  sha,
  head: sha,
  remoteMain: sha,
  dirty: "",
  repository: contract.canonicalGit.repository,
  repositoryId: contract.canonicalGit.repositoryId,
  repositoryOwnerId: contract.canonicalGit.repositoryOwnerId,
  runId: "9001",
  runAttempt: "2",
  workflowRef: "parammm390/finnor-ai/.github/workflows/production-release.yml@refs/heads/main",
  environment: "production",
  releaseSource: "github-actions",
}
const oidcClaims = {
  iss: "https://token.actions.githubusercontent.com",
  aud: contract.release.mutationAuthorization.oidcAudience,
  iat: Math.floor((now - 30_000) / 1000),
  nbf: Math.floor((now - 30_000) / 1000),
  exp: Math.floor((now + 5 * 60_000) / 1000),
  sub: "repo:parammm390@221117685/finnor-ai@1306076635:environment:production",
  repository: context.repository,
  repository_id: context.repositoryId,
  repository_owner_id: context.repositoryOwnerId,
  ref: context.ref,
  ref_protected: "true",
  sha,
  run_id: context.runId,
  run_attempt: context.runAttempt,
  event_name: context.eventName,
  environment: context.environment,
  workflow: contract.release.mutationAuthorization.workflowName,
  workflow_ref: context.workflowRef,
  job_workflow_ref: context.workflowRef,
}
const oidcIdentity = validateGitHubOidcClaims({ claims: oidcClaims, context, contract, now })
const payload = {
  schema: contract.release.mutationAuthorization.schema,
  repository: context.repository,
  repositoryId: context.repositoryId,
  repositoryOwnerId: context.repositoryOwnerId,
  commitSha: sha,
  runId: context.runId,
  runAttempt: Number(context.runAttempt),
  workflowPath: contract.release.mutationAuthorization.workflowPath,
  ref: context.ref,
  eventName: context.eventName,
  environment: context.environment,
  contractSchemaVersion: contract.schemaVersion,
  contractSha256,
  oidcIdentity,
  issuedAt: new Date(now - 1_000).toISOString(),
  expiresAt: new Date(now + 60_000).toISOString(),
  allowedOperations: [...contract.release.mutationAuthorization.allowedOperations],
  certifications: [{ name: "post-merge-certification", conclusion: "success" }],
}
const authorization = { ...payload, digest: authorizationDigest(payload) }
const live = {
  repo: { id: Number(context.repositoryId), full_name: context.repository, owner: { id: Number(context.repositoryOwnerId) } },
  run: { id: Number(context.runId), run_attempt: Number(context.runAttempt), event: "push", head_branch: "main", head_sha: sha, path: contract.release.mutationAuthorization.workflowPath, status: "in_progress" },
  jobs: [{ name: "post-merge-certification", status: "completed", conclusion: "success", run_attempt: Number(context.runAttempt) }],
}

function verify(overrides = {}) {
  return validateProductionMutationAuthorization({ authorization, operation, context, contract, contractSha256, live, oidcClaims, now, ...overrides })
}

test("valid certified exact-run authorization permits the allowlisted operation", () => {
  const validatedEvidence = verify()
  assert.deepEqual(validatedEvidence, { ok: true, operation, commitSha: sha, runId: "9001", digest: authorization.digest, oidcSubject: oidcClaims.sub })
  assert.throws(() => assertProductionMutationCapability(validatedEvidence, operation), /certified database-migrate production mutation capability/)
})

test("GitHub OIDC identity is cryptographically verified and exactly release-bound", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(oidcClaims)).toString("base64url")
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url")
  const token = `${header}.${body}.${signature}`
  const jwk = publicKey.export({ format: "jwk" })
  assert.deepEqual(verifyGitHubOidcJwtSignature(token, { keys: [{ ...jwk, kid: "test-key" }] }), oidcClaims)
  assert.throws(() => verifyGitHubOidcJwtSignature(`${header}.${body}.${Buffer.from("tampered").toString("base64url")}`, { keys: [{ ...jwk, kid: "test-key" }] }), /signature is invalid/)
  assert.throws(() => verify({ oidcClaims: { ...oidcClaims, ref_protected: "false" } }), /protected main ref/)
  assert.throws(() => verify({ oidcClaims: { ...oidcClaims, run_id: "9002" } }), /run id/)
})

test("stale and tampered authorization evidence fails closed", () => {
  assert.throws(() => verify({ now: Date.parse(payload.expiresAt) + 1 }), /stale/)
  assert.throws(() => verify({ authorization: { ...authorization, commitSha: "c".repeat(40) } }), /digest/)
  assert.throws(() => verify({ contractSha256: "d".repeat(64) }), /deployment contract/)
})

test("wrong SHA, run, repository, environment, or newly advanced main fails closed", () => {
  assert.throws(() => verify({ context: { ...context, sha: "c".repeat(40), head: "c".repeat(40), remoteMain: "c".repeat(40) } }), /SHA/)
  assert.throws(() => verify({ context: { ...context, runId: "9002" } }), /run id|workflow run/)
  assert.throws(() => verify({ context: { ...context, repositoryId: "7" } }), /repository id/)
  assert.throws(() => verify({ context: { ...context, environment: "preview" } }), /protected production environment/)
  assert.throws(() => verify({ context: { ...context, remoteMain: "e".repeat(40) } }), /current origin\/main/)
})

test("missing or failed exact certification job and unauthorized operations fail closed", () => {
  assert.throws(() => verify({ live: { ...live, jobs: [{ ...live.jobs[0], conclusion: "failure" }] } }), /certification job/)
  assert.throws(() => verify({ live: { ...live, run: { ...live.run, status: "completed" } } }), /active canonical release/)
  assert.throws(() => verify({ operation: "unknown-production-write" }), /not allowlisted/)
  assert.throws(() => verify({ context: { ...context, dirty: " M package.json" } }), /unmodified canonical checkout/)
})

test("local, feature-branch, manual-dispatch, and noncanonical workflow contexts never authorize mutation", () => {
  assert.throws(() => verify({ context: { ...context, actions: undefined } }), /restricted to GitHub Actions/)
  assert.throws(() => verify({ context: { ...context, eventName: "workflow_dispatch" } }), /canonical push event/)
  assert.throws(() => verify({ context: { ...context, ref: "refs/heads/feature/phase9" } }), /requires refs\/heads\/main/)
  assert.throws(() => verify({ context: { ...context, workflowRef: "parammm390/finnor-ai/.github/workflows/phase9-production-pe-bootstrap.yml@refs/heads/main" } }), /canonical main workflow/)
})

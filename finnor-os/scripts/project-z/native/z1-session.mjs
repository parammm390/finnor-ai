// Scenario: the complete Z1 native owner episode on the integrated stack.
// Seeds three original Works and their canonical sources through the product
// libraries, runs the real S3 fit -> S4 policy -> S5 clearing -> S6 obligation
// owner chain so the third Work carries a genuine unresolved obligation, reads
// the exact existing bindings, materializes the public fixture, stamps the
// installed source, pins the running target by /proc identity, then runs the
// guarded native driver. No credential, token or credentialed URL is recorded;
// this admits no phase by itself.
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { readdir, readFile, readlink, stat } from "node:fs/promises"
import { join } from "node:path"

const state = process.env.FINNOR_NATIVE_STATE
const evidence = process.env.FINNOR_NATIVE_EVIDENCE
const repository = process.env.FINNOR_NATIVE_ROOT
assert.ok(state && evidence && repository, "NATIVE_SCENARIO_ENVIRONMENT_REQUIRED")
mkdirSync(evidence, { mode: 0o700 })
const sha = value => createHash("sha256").update(value).digest("hex")
const privateEnv = JSON.parse(readFileSync(join(state, "native-environment-01.private.json"), "utf8"))
const appState = JSON.parse(readFileSync(join(state, "native-app-state.json"), "utf8"))
assert.equal(appState.workerLifecycle, "OWNED_BY_SCENARIO_NOT_STARTED_BY_LAUNCHER", "Z1_OWNS_ITS_WORKER_LIFECYCLE")
assert.ok(typeof privateEnv.FINNOR_WORKER_DATABASE_URL === "string", "WORKER_ROLE_CONNECTION_NOT_DELIVERED")
const runName = state.split("/").at(-1)
const episodeId = `z1-${runName}`
assert.match(episodeId, /^[a-z][a-z0-9_-]{0,79}$/, "EPISODE_ID_INVALID")
const fail = predicate => { throw new Error(predicate) }

const result = { schema: "finnor.project-z.z1-session.v1", runName, episodeId, startedAt: new Date().toISOString(),
  redaction: "no credential, token or credentialed URL recorded", steps: [], status: "RUNNING" }
const save = () => writeFileSync(join(evidence, "session.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
async function step(name, action) {
  const entry = { name, startedAt: new Date().toISOString(), status: "RUNNING" }
  result.steps.push(entry); save()
  try { const value = await action(); entry.status = "OK"; return value }
  catch (error) { entry.status = "FAILED"; entry.error = String(error?.message ?? error).split("\n")[0].slice(0, 300); throw error }
  finally { entry.finishedAt = new Date().toISOString(); save() }
}

// Product libraries read their environment lazily; assign before the dynamic imports.
for (const name of ["DATABASE_URL", "FINNOR_ENVIRONMENT", "FINNOR_Z1_PROFILE", "P3_GOVERNORS",
  "FINNOR_S3_MODEL_STORE", "FINNOR_S4_POLICY_STORE", "FINNOR_S3_PYTHON"]) {
  assert.ok(typeof privateEnv[name] === "string" && privateEnv[name], `LAUNCHER_ENVIRONMENT_${name}_REQUIRED`)
  process.env[name] = privateEnv[name]
}
const s3Python = privateEnv.FINNOR_S3_PYTHON
const playwrightBrowsers = process.env.PLAYWRIGHT_BROWSERS_PATH

const closers = []
const API = "http://127.0.0.1:3101"
const FRONTEND = "http://127.0.0.1:3001"
const TARGET_ORGANIZATION = "90000000-0000-4000-8000-000000000027"
const FOREIGN_DEAL = "90000000-0000-4000-8000-000000000001"
const INTEGRATED_BASE = "a5209abc15fe40c68f30336c60d95dbfc343c13a"
const day = 86400000

async function bearerFor(email, password) {
  const response = await fetch(privateEnv.SUPABASE_URL + "/auth/v1/token?grant_type=password", { method: "POST",
    headers: { apikey: privateEnv.SUPABASE_ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ email, password }), signal: AbortSignal.timeout(30000) })
  const body = await response.json().catch(() => ({}))
  if (response.status !== 200 || typeof body.access_token !== "string") fail("AUTH_PASSWORD_GRANT_FAILED_" + response.status)
  return body.access_token
}
const httpCalls = []
async function apiCall(path, token, body, timeoutMs = 300000) {
  const response = await fetch(API + path, { method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let value = null
  try { value = JSON.parse(text) } catch { /* retained as null */ }
  httpCalls.push({ path, status: response.status, inputDigest: sha(JSON.stringify(body)), responseDigest: sha(text) })
  return { status: response.status, body: value }
}
const expectStatus = (answer, status, label) => {
  if (answer.status !== status) fail(`${label}_STATUS_${answer.status}`)
  return answer.body
}
// The S5 owner fixture support routes by operation name; the handler argument is unused over real HTTP.
function makeOwnerApi(token) {
  return async (_fixture, operation, body) => {
    const family = operation === "fit" ? "interventions" : ["synthesize", "handoff"].includes(operation) ? "policies" : "allocations"
    return apiCall(`/api/${family}/${operation}`, token, body)
  }
}

async function listenerProcessIdentity(port) {
  const portHex = port.toString(16).padStart(4, "0").toUpperCase()
  const inodes = []
  for (const family of ["tcp", "tcp6"]) {
    const rows = (await readFile(`/proc/net/${family}`, "utf8")).trim().split("\n").slice(1)
    for (const line of rows) {
      const row = line.trim().split(/\s+/)
      if (row[3] === "0A" && row[1].split(":")[1] === portHex) {
        assert.ok(["0100007F", "00000000000000000000000001000000"].includes(row[1].split(":")[0]), "TARGET_LISTENER_MUST_BIND_LOOPBACK_ONLY")
        inodes.push(row[9])
      }
    }
  }
  assert.ok(inodes.length > 0, `OWNED_LISTENER_${port}_NOT_DELIVERED`)
  const pids = (await readdir("/proc")).filter(name => /^[0-9]+$/.test(name)).map(Number).sort((a, b) => a - b)
  for (const pid of pids) {
    let descriptors
    try { descriptors = await readdir(`/proc/${pid}/fd`) } catch { continue }
    const sockets = []
    for (const descriptor of descriptors) {
      try { sockets.push(await readlink(`/proc/${pid}/fd/${descriptor}`)) } catch { /* raced a closed fd */ }
    }
    if (!inodes.every(inode => sockets.includes(`socket:[${inode}]`))) continue
    // Same formula as the guarded driver's processIdentity, so the manifest matches byte for byte.
    const fields = (await readFile(`/proc/${pid}/stat`, "utf8")).split(") ").slice(1).join(") ").split(" ")
    const info = await stat(`/proc/${pid}`)
    const executable = await readlink(`/proc/${pid}/exe`)
    return { pid, startTicks: fields[19], uid: info.uid, executableSha256: sha(await readFile(executable)), port,
      commandLineSha256: sha(await readFile(`/proc/${pid}/cmdline`)), cwd: await readlink(`/proc/${pid}/cwd`) }
  }
  fail(`OWNED_LISTENER_${port}_PROCESS_NOT_FOUND`)
}

try {
  // The S3 history begins 128 days before today's UTC midnight; keep the whole chain off the boundary.
  if (day - (Date.now() % day) < 100 * 60000) fail("Z1_SESSION_TOO_CLOSE_TO_UTC_MIDNIGHT")

  const libraries = await step("load-product-libraries", async () => ({
    db: await import("../../../packages/db/index.ts"),
    pe: await import("../../../packages/private-equity/src/index.ts"),
    memory: await import("../../../packages/memory/src/evidence.ts"),
    store: await import("../../../packages/private-equity/src/allocation-store.ts"),
    authority: await import("../../../packages/authority/src/index.ts"),
    z1res: await import("../../../packages/private-equity/src/project-z/z1-shared-work/resources.ts"),
    z1store: await import("../../../packages/private-equity/src/project-z/z1-shared-work/native-store.ts"),
    z1contracts: await import("../../../packages/epistemic-runtime/src/project-z/z1-shared-work/contracts.ts"),
    obligations: await import("../../../packages/private-equity/src/enterprise-obligations.ts"),
    upstream: await import("../../s5/owner-fixture.mts"),
    pg: (await import("pg")).default,
  }))
  const { db, pe, memory, store, authority, z1res, z1store, z1contracts, obligations, upstream, pg } = libraries

  const ownerToken = await step("owner-auth-login", () => bearerFor(privateEnv.TEST_OWNER_EMAIL, privateEnv.TEST_OWNER_PASSWORD))
  const me = await step("owner-identity", async () => {
    const response = await fetch(FRONTEND + "/api/centropy/me", { headers: { authorization: "Bearer " + ownerToken },
      signal: AbortSignal.timeout(30000) })
    const body = await response.json().catch(() => ({}))
    assert.equal(response.status, 200, "OWNER_ME_FAILED")
    assert.equal(body.role, "owner", "OWNER_ROLE_REQUIRED")
    assert.equal(body.userId, body.employeeId, "Z1_ORIGINAL_PRINCIPAL_IS_THE_EMPLOYEE")
    return body
  })
  const tenantId = me.tenantId, principalId = me.userId
  const ctx = { auth: { tenantId, userId: principalId, employeeId: principalId, role: "owner" },
    provenance: { sourceSystem: `z1:${episodeId}-seed`, createdBy: principalId } }
  result.owner = { tenantId, principalId, role: me.role }

  const admin = new pg.Client({ connectionString: privateEnv.CENTROPY_E2E_DB_ADMIN_URL })
  closers.push(() => admin.end().catch(() => {}), () => db.closePool?.().catch(() => {}))
  await admin.connect()
  await admin.query("SET app.test_vertical_mode='explicit'")
  const workerPool = new pg.Pool({ connectionString: privateEnv.FINNOR_WORKER_DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 })
  closers.push(() => workerPool.end().catch(() => {}))

  const seeded = await step("seed-works-sources-resources", async () => {
    const deal = await pe.createDeal(ctx, { targetOrganizationId: TARGET_ORGANIZATION,
      name: `Z1 public exact fixture deal ${runName}`, codeName: runName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) || "Z1RUN",
      dealLeadEmployeeId: principalId, signedLoiAt: new Date(), targetClosingAt: new Date(Date.now() + 30 * day) })
    const root = { entityType: "pe_deal", entityId: String(deal.row.id) }
    const foreignRoot = { entityType: "pe_deal", entityId: FOREIGN_DEAL }
    // One active case per deal (pe_investment_cases_one_active_idx), so the S4 consumer Works share it.
    const created = await pe.createInvestmentCase(ctx, { dealId: root.entityId, title: "Z1 public exact choice case" })
    await pe.activateInvestmentCase(ctx, { investmentCaseId: String(created.row.id), expectedVersion: 1 })
    const investmentCaseId = String(created.row.id)
    const works = []
    for (const index of [0, 1, 2]) works.push(await db.receiveWork({ tenantId, userId: principalId, channel: "console",
      instruction: `Z1 public deterministic exact original Work ${index} (${episodeId})`,
      idempotencyKey: `${episodeId}:work:${index}`, activeContext: { businessRoot: root } }))
    const foreign = await db.receiveWork({ tenantId, userId: principalId, channel: "console",
      instruction: `Z1 negative-scope Work rooted elsewhere (${episodeId})`,
      idempotencyKey: `${episodeId}:work:foreign`, activeContext: { businessRoot: foreignRoot } })
    const snapshot = { z1FixtureEpisode: episodeId, worldRoot: root, protectionDomain: "DISPOSABLE_LOCAL_DEVELOPMENT",
      externalEffects: false, qualification: "PUBLIC_DETERMINISTIC_FIXTURE_NO_PII" }
    const sources = {}
    for (const name of ["ledger", "dimension", "declaration-0", "declaration-1", "declaration-2"]) {
      const source = await memory.createEvidenceSource(tenantId, { sourceKey: `z1:${episodeId}:${name}`,
        sourceType: "manual", title: `Z1 public fixture ${name}` })
      const version = await memory.appendEvidenceVersion(tenantId, source.id,
        { content: JSON.stringify({ episodeId, name, initial: true }), snapshot, asOf: new Date() })
      sources[name] = { sourceId: source.id, versionId: version.versionId }
    }
    const now = Date.now(), sanitized = episodeId.replace(/[^a-z0-9]/g, "_")
    const ref = (id, owner = "BUSINESS_OWNER") => ({ owner, id, version: "public-owner-input-v1",
      contentDigest: sha(JSON.stringify({ id, owner })) })
    const horizon = { startAt: new Date(now - 60000).toISOString(), periodMs: 3600000, periods: 6 }
    const roles = { logical: ["z1-logical-tick", "CUMULATIVE_EXPENDITURE"], cpu: ["cpu-microseconds", "CUMULATIVE_EXPENDITURE"],
      storage: ["byte", "CUMULATIVE_EXPENDITURE"], memory: ["byte", "OCCUPANCY"] }
    const resources = {}
    for (const [role, [unit, kind]] of Object.entries(roles)) {
      const body = { schema: "finnor.allocation-resource.v1", resourceId: `z1_${sanitized}_${role}`, tenantId,
        ownerRef: ref(principalId), legalEntityRef: ref(root.entityId, "S1"), scopeRef: ref(`z1-${sanitized}-${role}`),
        permittedRoots: [root], rightsRef: "S1:current-owner-assertion", unit, currency: null, kind, resourceClass: "COMPUTE",
        horizon, sourceRef: ref(`public_declared_compute_${role}`), asOf: new Date(now - 60000).toISOString(),
        knowledgeAt: new Date(now - 60000).toISOString(), validUntil: new Date(now + 6 * 3600000).toISOString(),
        beliefPins: [], availability: Array.from({ length: horizon.periods + 1 }, () => ({ amount: "100000000000", basis: "REPORTED_AVAILABLE" })),
        existingUse: Array(horizon.periods + 1).fill("0"), safetyMargin: "0", covenants: [], revoked: false,
        qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" }
      const createdResource = await store.putAllocationResource(ctx, body, null)
      resources[role] = createdResource.ref
    }
    return { root, foreignRoot, investmentCaseId, works, foreignWorkId: foreign.workId, sources, resources }
  })
  const { root, foreignRoot, investmentCaseId, works, sources, resources } = seeded
  Object.assign(result, { root, foreignRoot, workIds: works.map(work => work.workId), foreignWorkId: seeded.foreignWorkId,
    investmentCaseIds: [investmentCaseId], sources, resources })

  const chain = await step("s3-s4-s5-owner-chain", async () => {
    // All upstream owners run before the first S6 obligation: S4 lawfully refuses new
    // plans once an outstanding obligation exists, and the fixture is the chain's input.
    const generated = spawnSync(s3Python, [join(repository, "finnor-os/scripts/s3/reference.py")],
      { input: JSON.stringify({ operation: "equivalent" }), encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, OPENBLAS_NUM_THREADS: "1", OMP_NUM_THREADS: "1" } })
    assert.equal(generated.status, 0, "S3_REFERENCE_INPUT_GENERATION_FAILED")
    const artifact = async (name, value) => {
      const path = join(evidence, "upstream", name)
      mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
      writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
    }
    const begin = new Date(Math.floor(Date.now() / day) * day - 128 * day).toISOString()
    // The S3 fit gate revalidates the world belief pin and requires COMPLETE canonical
    // coverage (enterprise-beliefs.ts). The seeded phase-9 world carries PARTIAL
    // coverage (unversioned core documents and decision receipts), which is exactly
    // what the Z4 worker's retained w4-seed-01/02 attempts observed. The chain
    // therefore roots at a fresh organization whose world contains only this
    // fixture's own evidence, the same shape the S5/S6 owner suites prove.
    const chainRoot = { entityType: "external_organization", entityId: randomUUID() }
    await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$4,'other')",
      [chainRoot.entityId, tenantId, `z1-${runName}-chain`, `Z1 S5 chain root ${runName}`])
    const support = upstream.createUpstreamFixtureSupport({ admin: () => admin,
      generatedRows: JSON.parse(generated.stdout).rows, begin, day, fixtures: {}, api: makeOwnerApi(ownerToken), artifact })
    const owner = await support.fixture(episodeId, 2, [{ id: "cash", unit: "USD", capacity: 100, totalLimit: 100 }],
      { existing: { tenant: tenantId, principal: principalId, root: chainRoot }, expiryMs: 5400000 })
    const policy = await support.policy(owner, "z1obligation", { cash: 25 })
    await support.resource(owner, "cash", "USD", "STOCK", ["100", "100", "100"])
    const cleared = expectStatus(await apiCall("/api/allocations/clear", ownerToken,
      support.clearing(owner, { z1obligation: ["100"] })), 200, "S5_CLEAR")
    assert.equal(cleared.status, "FEASIBLE", "S5_CLEARING_NOT_FEASIBLE")
    const handoff = expectStatus(await apiCall("/api/policies/handoff", ownerToken,
      { policyRef: policy.ref, allocationRef: cleared.certificate.ref,
        decision: support.decision(owner, cleared.certificate.ref) }), 200, "S4_HANDOFF")
    assert.ok(handoff.preparationRef && handoff.allocationRef && handoff.consumptionRef && handoff.intervention,
      "S4_HANDOFF_REFERENCES_REQUIRED")
    return { chainRoot, modelRef: owner.model.ref, policyRef: policy.ref, allocationRef: cleared.certificate.ref,
      preparationRef: handoff.preparationRef, consumptionRef: handoff.consumptionRef, handoffInterventionDigest: sha(JSON.stringify(handoff.intervention)) }
  })
  result.chain = chain

  const obligation = await step("s6-obligation-with-original-work-lineage", async () => {
    const prepared = await obligations.prepareEnterpriseDurableObligation(ctx,
      { preparationRef: chain.preparationRef, allocationRef: chain.allocationRef, consumptionRef: chain.consumptionRef },
      { workId: works[2].workId })
    assert.equal(prepared.executionAuthorityGranted, false, "S6_PREPARATION_GRANTS_NO_AUTHORITY")
    assert.equal(prepared.protectedReceipt, null)
    const lineage = await db.withTenantTransaction(tenantId, { userId: principalId, readOnly: true }, async (_db, c) => {
      const rows = (await c.query(`SELECT o.obligation_id, a.work_id, a.plan_revision_id, a.status action_status,
        e.status effect_status, o.body->'workLineage'->>'workId' lineage_work
        FROM finnor_os.s6_obligation_origins o
        JOIN finnor_os.domain_actions a ON a.tenant_id=o.tenant_id AND a.id=o.domain_action_id
        JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id
        WHERE o.tenant_id=$1 AND o.obligation_id=$2`, [tenantId, prepared.ref.id])).rows
      assert.equal(rows.length, 1, "EXACTLY_ONE_S6_ORIGIN_REQUIRED")
      return rows[0]
    })
    assert.equal(lineage.work_id, works[2].workId, "S6_DOMAIN_ACTION_WORK_LINEAGE_REQUIRED")
    assert.equal(lineage.lineage_work, works[2].workId, "S6_BODY_WORK_LINEAGE_REQUIRED")
    assert.equal(lineage.action_status, "draft")
    assert.equal(lineage.effect_status, "compiled")
    return { obligationRef: prepared.ref, lineage }
  })
  result.obligation = { ref: obligation.obligationRef, workId: works[2].workId }

  const bindings = await step("read-existing-bindings", async () => {
    // FOR SHARE owner reads need a writable transaction; nothing is written here.
    const bound = await db.withTenantTransaction(tenantId, { userId: principalId, readOnly: false }, async (_db, c) => {
      const rights = await authority.employeeAuthoritySnapshotTx(ctx.auth, c)
      const pins = {}
      for (const [name, item] of Object.entries(sources)) {
        const row = (await c.query(`SELECT id::text,content_hash FROM finnor_os.evidence_source_versions
          WHERE tenant_id=$1 AND source_id=$2 ORDER BY version_number DESC,id DESC LIMIT 1`, [tenantId, item.sourceId])).rows[0]
        assert.ok(row, `CANONICAL_SOURCE_HEAD_${name}_REQUIRED`)
        pins[name] = { sourceId: item.sourceId, versionId: row.id, contentDigest: row.content_hash }
      }
      const inputs = []
      for (const work of works) inputs.push({ ...(await z1res.currentWorkInputTx(ctx, c, work.workId, root)),
        obligations: await z1store.originalObligationsTx(ctx, c, work.workId) })
      return { rightsRevision: String(rights.revision), pins, inputs }
    })
    assert.deepEqual(bound.inputs[0].obligations, [], "FIRST_ORIGINAL_WORK_CARRIES_NO_OBLIGATION")
    assert.deepEqual(bound.inputs[1].obligations, [], "SECOND_ORIGINAL_WORK_CARRIES_NO_OBLIGATION")
    assert.deepEqual(bound.inputs[2].obligations, [obligation.obligationRef.id], "THIRD_ORIGINAL_WORK_CARRIES_THE_ONE_OBLIGATION")
    const value = { schema: "finnor.z1.existing-public-fixture-bindings.v1", dataClass: "PUBLIC_DETERMINISTIC_FIXTURE_NO_PII",
      episodeId, tenantId, principalId, root, foreignRoot, foreignWorkId: seeded.foreignWorkId,
      rightsRevision: bound.rightsRevision, deadlineAt: new Date(Date.now() + 3 * 3600000).toISOString(), resources,
      sources: { ledger: bound.pins.ledger, dimension: bound.pins.dimension },
      works: works.map((work, index) => ({ workId: work.workId, inputId: bound.inputs[index].inputId,
        inputDigest: bound.inputs[index].inputDigest, declaration: bound.pins[`declaration-${index}`],
        unresolvedObligationRefs: bound.inputs[index].obligations,
        ...(index ? { investmentCaseId } : {}) })) }
    const path = join(evidence, "z1-existing-public-bindings.json")
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    return { path, rightsRevision: bound.rightsRevision, inputDigests: bound.inputs.map(input => input.inputDigest) }
  })
  result.bindings = { file: bindings.path, rightsRevision: bindings.rightsRevision, inputDigests: bindings.inputDigests }

  const fixture = await step("materialize-public-fixture", async () => {
    const output = join(evidence, "z1-public-fixture.json")
    const require = createRequire(join(repository, "finnor-os/package.json"))
    const run = spawnSync(process.execPath, ["--import", require.resolve("tsx"),
      join(repository, "finnor-os/scripts/project-z/z1/make-native-fixture.mjs"),
      "--bindings", bindings.path, "--output", output], { encoding: "utf8", timeout: 60000 })
    assert.equal(run.status, 0, "OFFLINE_FIXTURE_MATERIALIZATION_FAILED")
    const bytes = readFileSync(output)
    return { file: output, sha256: sha(bytes), bytes: bytes.length }
  })
  result.fixture = fixture

  const installed = await step("stamp-installed-source", async () => {
    const git = args => {
      const run = spawnSync("git", ["-C", repository, ...args], { timeout: 120000, maxBuffer: 64 * 1024 * 1024 })
      assert.equal(run.status, 0, "DECLARED_GIT_IDENTITY_REQUIRED")
      return run.stdout
    }
    const sourceCommit = git(["rev-parse", "HEAD"]).toString("utf8").trim()
    const sourceTree = git(["rev-parse", "HEAD^{tree}"]).toString("utf8").trim()
    // The declared delta over the integrated candidate base and the exact archived tree bytes.
    const integrationPatchSha256 = sha(git(["diff", "--binary", INTEGRATED_BASE, "HEAD"]))
    const sourceArchiveSha256 = sha(git(["archive", "HEAD"]))
    const base = join(repository, "finnor-os/packages/private-equity/src/project-z/z1-shared-work")
    writeFileSync(join(base, "reconstruction-input.json"), JSON.stringify({ schema: "finnor.z1.reconstruction-input.v1",
      sourceCommit, sourceTree, integrationPatchSha256, sourceArchiveSha256 }, null, 2) + "\n", { mode: 0o600 })
    const require = createRequire(join(repository, "finnor-os/package.json"))
    const run = spawnSync(process.execPath, ["--import", require.resolve("tsx"),
      join(repository, "finnor-os/scripts/project-z/z1/stamp-installed.mjs")], { encoding: "utf8", timeout: 600000 })
    assert.equal(run.status, 0, "INSTALLED_SOURCE_STAMP_FAILED")
    const value = JSON.parse(readFileSync(join(base, "installed-source.json"), "utf8"))
    assert.equal(value.sourceCommit, sourceCommit)
    return { sourceCommit, sourceTree, integrationPatchSha256, sourceArchiveSha256,
      nativeRuntimeDigest: value.nativeRuntimeDigest, reconstructionReference: value.reconstructionReference,
      sourceFilesManifestSha256: value.sourceFilesManifestSha256 }
  })
  result.installed = installed

  const manifest = await step("pin-target-manifest", async () => {
    const database = new URL(privateEnv.DATABASE_URL)
    const workerDatabase = new URL(privateEnv.FINNOR_WORKER_DATABASE_URL)
    const appPool = new pg.Pool({ connectionString: privateEnv.DATABASE_URL, max: 1, connectionTimeoutMillis: 10000 })
    let migration, catalog
    try {
      migration = (await appPool.query("SELECT name FROM finnor_os._migrations ORDER BY name DESC LIMIT 1")).rows[0]?.name
      catalog = (await appPool.query(`SELECT p.proname,pg_get_function_identity_arguments(p.oid) args,
        pg_get_functiondef(p.oid) body FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='finnor_os' AND p.proname LIKE 'z1_%' ORDER BY p.proname,args`)).rows
    } finally { await appPool.end() }
    assert.ok(migration && catalog.length >= 10, "APPLIED_MIGRATION_AND_NATIVE_SCHEMA_CATALOG_REQUIRED")
    const require = createRequire(join(repository, "package.json"))
    const { chromium } = require("@playwright/test")
    const processes = []
    for (const port of [3001, 3101, Number(database.port)]) processes.push(await listenerProcessIdentity(port))
    const target = { schema: "finnor.z1.authorized-native-target.v1", flavor: "SOURCE_DEVELOPMENT", repository,
      frontend: FRONTEND + "/", api: API + "/", authOrigin: new URL(privateEnv.SUPABASE_URL).origin,
      database: { name: database.pathname.slice(1), port: Number(database.port),
        role: decodeURIComponent(database.username), workerRole: decodeURIComponent(workerDatabase.username) },
      fixtureFile: fixture.file, fixtureSha256: fixture.sha256,
      nativeRuntimeDigest: installed.nativeRuntimeDigest, sourceCommit: installed.sourceCommit,
      sourceTree: installed.sourceTree, reconstructionReference: installed.reconstructionReference,
      authorization: { reference: `scope-z/phase-evidence/z1/native-integrated-failure-model.md run ${runName}`,
        disposableDatabaseExclusive: true, existingFixtureWritesOnly: true, ownedWorkerFaultsOnly: true,
        noOtherWorkers: true, realDisposableAuthProject: true, externalEffects: false,
        newDatabaseTenantsAuthGrantsOrListeners: false, scenario: "ORIGINAL_EPISODE" },
      appliedMigration: migration,
      nativeSchemaSha256: sha(readFileSync(join(repository, "finnor-os/scripts/project-z/z1/shared-schema.sql"))),
      schemaCatalogSha256: z1contracts.digest(catalog),
      browserExecutableSha256: sha(readFileSync(chromium.executablePath())),
      processes }
    const path = join(evidence, "z1-target-manifest.json")
    writeFileSync(path, JSON.stringify(target, null, 2) + "\n", { flag: "wx", mode: 0o600 })
    return { file: path, sha256: sha(readFileSync(path)), appliedMigration: migration, processPids: processes.map(item => item.pid) }
  })
  result.target = { file: manifest.file, sha256: manifest.sha256, appliedMigration: manifest.appliedMigration,
    processPids: manifest.processPids }

  await step("queue-census-before-episode", async () => {
    const rows = (await workerPool.query(`SELECT id,type,tenant_id,status FROM finnor_os.jobs
      WHERE status IN('queued','running','failed','dead_letter') ORDER BY id LIMIT 32`)).rows
    writeFileSync(join(evidence, "queue-census-before.json"), JSON.stringify({ schema: "finnor.project-z.z1-queue-census.v1",
      at: new Date().toISOString(), jobs: rows }, null, 2) + "\n", { mode: 0o600 })
    assert.equal(rows.length, 0, "EXCLUSIVE_OWNED_QUEUE_REQUIRED_BEFORE_THE_EPISODE")
  })

  const episode = await step("guarded-native-episode", async () => {
    const reportDirectory = join(evidence, "z1-native-e2e-report-01")
    const child = spawn(process.execPath, [join(repository, "finnor-os/scripts/project-z/z1/native-e2e.mjs"),
      "--report", reportDirectory], { cwd: repository, stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: evidence, TMPDIR: evidence, LANG: "C.UTF-8", CI: "1",
        NODE_OPTIONS: "--max-old-space-size=4096", PYTHONDONTWRITEBYTECODE: "1", TSX_DISABLE_CACHE: "1",
        RAYON_NUM_THREADS: "2", TEST_OWNER_EMAIL: privateEnv.TEST_OWNER_EMAIL, TEST_OWNER_PASSWORD: privateEnv.TEST_OWNER_PASSWORD,
        DATABASE_URL: privateEnv.DATABASE_URL, FINNOR_Z1_WORKER_DATABASE_URL: privateEnv.FINNOR_WORKER_DATABASE_URL,
        NEXT_PUBLIC_SUPABASE_URL: privateEnv.NEXT_PUBLIC_SUPABASE_URL, SUPABASE_URL: privateEnv.SUPABASE_URL,
        FINNOR_ENVIRONMENT: privateEnv.FINNOR_ENVIRONMENT, FINNOR_Z1_PROFILE: "ordinary_disposable", P3_GOVERNORS: "1",
        FINNOR_Z1_NATIVE_AUTHORIZED: "DISPOSABLE_ORIGINAL_Z1_EPISODE_ONLY",
        FINNOR_Z1_TARGET_MANIFEST: manifest.file, FINNOR_Z1_TARGET_SHA256: manifest.sha256,
        ...(playwrightBrowsers ? { PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsers } : {}) } })
    let stdout = "", stderrBytes = 0
    child.stdout.on("data", chunk => { stdout += chunk.toString(); if (stdout.length > 65536) stdout = stdout.slice(-65536) })
    child.stderr.on("data", chunk => { stderrBytes += chunk.length })
    const timer = setTimeout(() => { try { child.kill("SIGKILL") } catch {} }, 5400000)
    const exit = await new Promise(done => child.once("close", (code, signal) => done({ code, signal })))
    clearTimeout(timer)
    const report = JSON.parse(readFileSync(join(reportDirectory, "report.json"), "utf8"))
    const value = { exit, reportStatus: report.status, blocker: report.blocker ?? null, scenario: report.scenario ?? null,
      sourceOwnerFlow: report.sourceOwnerFlow, physicalNativeRecovery: report.physicalNativeRecovery,
      actions: report.actions?.length ?? 0, originalWorkIds: report.originalWorkIds ?? [],
      physicalExits: (report.physicalExits ?? []).length, stderrBytes }
    if (report.status !== "PASSED" || exit.code !== 0 || exit.signal !== null)
      fail(`NATIVE_EPISODE_${report.status ?? "NO_REPORT"}_${report.blocker ?? exit.code}`)
    return value
  })
  result.episode = episode

  await step("queue-census-after-episode", async () => {
    const rows = (await workerPool.query(`SELECT id,type,status,payload->>'requestId' request_id FROM finnor_os.jobs
      ORDER BY id LIMIT 64`)).rows
    writeFileSync(join(evidence, "queue-census-after.json"), JSON.stringify({ schema: "finnor.project-z.z1-queue-census.v1",
      at: new Date().toISOString(), jobs: rows.map(row => ({ ...row, tenant_id: undefined })) }, null, 2) + "\n", { mode: 0o600 })
  })
  result.httpCallCount = httpCalls.length
  result.status = "Z1_NATIVE_EPISODE_OBSERVED"
} catch (error) {
  result.status = "FAILED"
  result.failure = String(error?.message ?? error).split("\n")[0].slice(0, 300)
  process.exitCode = 1
} finally {
  result.finishedAt = new Date().toISOString()
  save()
  // Open pools would keep the event loop alive; the runner waits on this process exiting.
  for (const close of closers.splice(0)) await close()
  console.log(JSON.stringify({ status: result.status, failure: result.failure ?? null, steps: result.steps.length }))
}
if (result.status !== "Z1_NATIVE_EPISODE_OBSERVED") process.exitCode = 1

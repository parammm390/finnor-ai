// Scenario: seeds original Z4 Work through real owner routes, builds the target receipt and
// scope, asks the coordinator signer for the replay grant, then runs the guarded native replay.
// The grant is never written by this program: only the coordinator signer creates the receipt.
// Nothing here admits a phase; the replay report is the only result.
import assert from "node:assert/strict"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const state = process.env.FINNOR_NATIVE_STATE
const evidence = process.env.FINNOR_NATIVE_EVIDENCE
const repository = process.env.FINNOR_NATIVE_ROOT
const tlsState = process.env.FINNOR_NATIVE_AUTH_TLS_STATE
const chromium = process.env.FINNOR_Z4_CHROMIUM
const stage = process.env.FINNOR_Z4_SESSION_STAGE ?? "full"
const signer = "/home/factory-user/repos/fzv-int-out/coordinator/z4-sign-grant.mjs"
assert.ok(state && evidence && repository && tlsState && chromium, "NATIVE_SCENARIO_ENVIRONMENT_REQUIRED")
assert.ok(["seed", "full"].includes(stage), "SESSION_STAGE_INVALID")
mkdirSync(evidence, { mode: 0o700 })
const sha = value => createHash("sha256").update(value).digest("hex")
const privateEnv = JSON.parse(readFileSync(join(state, "native-environment-01.private.json"), "utf8"))
const tls = JSON.parse(readFileSync(join(tlsState, "state.json"), "utf8"))
const runName = state.split("/").at(-1)
const result = { schema: "finnor.project-z.z4-session.v1", runName, stage, startedAt: new Date().toISOString(),
  redaction: "no credential, token or credentialed URL recorded", steps: [], status: "RUNNING" }
const save = () => writeFileSync(join(evidence, "session.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 })
async function step(name, action) {
  const entry = { name, startedAt: new Date().toISOString(), status: "RUNNING" }
  result.steps.push(entry); save()
  try { const value = await action(); entry.status = "OK"; return value }
  catch (error) { entry.status = "FAILED"; entry.error = String(error?.message ?? error).slice(0, 600); throw error }
  finally { entry.finishedAt = new Date().toISOString(); save() }
}

// Product libraries read their environment lazily; only the names below are given to this process.
for (const name of ["DATABASE_URL", "FINNOR_ENVIRONMENT", "FINNOR_Z4_PROFILE", "FINNOR_S3_MODEL_STORE", "FINNOR_S4_POLICY_STORE",
  "FINNOR_Z4_CAPSULE_STORE", "FINNOR_S3_PYTHON", "SUPABASE_URL", "SUPABASE_ANON_KEY"]) process.env[name] = privateEnv[name]
assert.equal(process.env.SUPABASE_URL, tls.origin, "AUTH_ORIGIN_MUST_BE_THE_DECLARED_HTTPS_ORIGIN")

const day = 86400000
const API = "http://127.0.0.1:3101"
const FRONTEND = "http://127.0.0.1:3001"
const REGISTRATION = "scope-z/phase-evidence/z4/public-cases.pre-code.json"
const REGISTRATION_SHA = "3992c3111ed0ba6fb700ae99095720780e713f7b55b1b9e938a6534004514d94"
const fail = predicate => { throw new Error(predicate) }

async function bearerFor(email, password) {
  const response = await fetch(privateEnv.SUPABASE_URL + "/auth/v1/token?grant_type=password", { method: "POST",
    headers: { apikey: privateEnv.SUPABASE_ANON_KEY, "content-type": "application/json" }, body: JSON.stringify({ email, password }) })
  const body = await response.json().catch(() => ({}))
  if (response.status !== 200 || typeof body.access_token !== "string") fail("AUTH_PASSWORD_GRANT_FAILED_" + response.status)
  return body.access_token
}
async function call(origin, path, token, body, timeoutMs = 300000) {
  const response = await fetch(origin + path, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let value = null
  try { value = JSON.parse(text) } catch { /* retained as null */ }
  return { status: response.status, body: value, bytes: text.length }
}
const expectStatus = (answer, status, label) => {
  if (answer.status !== status) fail(`${label}_STATUS_${answer.status}_${JSON.stringify(answer.body).slice(0, 300)}`)
  return answer.body
}

try {
  // Stay clear of UTC midnight: the S3 history, mandate horizon and S5 resource all start at today's midnight.
  const untilMidnight = day - (Date.now() % day)
  if (untilMidnight < 100 * 60000) fail("Z4_SESSION_TOO_CLOSE_TO_UTC_MIDNIGHT")

  const libraries = await step("load-product-libraries", async () => ({
    contracts: await import("../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts.ts"),
    authority: await import("../z4/replay-authority.mts"),
    db: await import("../../../packages/db/index.ts"),
    pe: await import("../../../packages/private-equity/src/index.ts"),
    memory: await import("../../../packages/memory/src/evidence.ts"),
    epistemic: await import("../../../packages/epistemic-runtime/src/index.ts"),
    source: await import("../../../packages/private-equity/src/project-z/z4-execution-proof/source.ts"),
    z4: await import("../../../packages/private-equity/src/project-z/z4-execution-proof/contracts.ts"),
  }))
  const { contracts, authority, db, pe, memory, epistemic, source, z4 } = libraries
  const { canonical } = contracts

  const ownerCredentials = { email: privateEnv.TEST_OWNER_EMAIL, password: privateEnv.TEST_OWNER_PASSWORD }
  const ownerToken = await step("owner-https-auth-login", () => bearerFor(ownerCredentials.email, ownerCredentials.password))
  const me = await step("owner-identity", async () => {
    const response = await fetch(FRONTEND + "/api/centropy/me", { headers: { authorization: "Bearer " + ownerToken } })
    const body = await response.json()
    assert.equal(response.status, 200, "OWNER_ME_FAILED")
    assert.equal(body.role, "owner")
    return body
  })
  const tenantId = me.tenantId
  const principalId = me.employeeId ?? me.userId
  const ctx = { auth: { tenantId, userId: me.userId, employeeId: me.employeeId ?? undefined, role: "owner" } }
  result.owner = { tenantId, principalId, role: me.role }
  // A fresh organization per run: the tenant's pre-existing world carries unversioned core
  // Document/DecisionReceipt records, which make its permitted canonical cut PARTIAL and
  // disqualify every pin. A fresh root has a vacuously complete recorded cut (the same
  // shape the product's own S3/S5 owner fixtures fit against).
  const root = { entityType: "external_organization", entityId: randomUUID() }
  result.world = { root }

  const { default: pg } = await import("pg")
  const admin = new pg.Client({ connectionString: privateEnv.CENTROPY_E2E_DB_ADMIN_URL })
  await admin.connect()
  try {
    // ---- second and third actors: real Auth users bound by email to existing seeded rows ----
    const actors = await step("second-actors", async () => {
      const rows = (await admin.query(`SELECT id::text,tenant_id::text,email,role,status FROM finnor_os.users WHERE lower(email)=ANY($1)`,
        [["phase9.foreign.owner@test.invalid", "phase9.ic.member.two@test.invalid"]])).rows
      const byEmail = Object.fromEntries(rows.map(row => [row.email.toLowerCase(), row]))
      const foreign = byEmail["phase9.foreign.owner@test.invalid"], other = byEmail["phase9.ic.member.two@test.invalid"]
      if (!foreign || foreign.tenant_id === tenantId) fail("Z4_FOREIGN_TENANT_ROW_REQUIRED")
      if (!other || other.tenant_id !== tenantId || other.id === me.userId) fail("Z4_DISTINCT_SAME_TENANT_ROW_REQUIRED")
      const made = {}
      for (const [label, row] of [["foreign", foreign], ["other", other]]) {
        const password = randomBytes(24).toString("base64url")
        const created = await fetch(privateEnv.SUPABASE_URL + "/auth/v1/admin/users", { method: "POST",
          headers: { Authorization: "Bearer " + privateEnv.SUPABASE_SERVICE_ROLE_KEY, apikey: privateEnv.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ email: row.email, password, email_confirm: true }), signal: AbortSignal.timeout(15000) })
        if (created.status !== 200) fail("AUTH_ADMIN_USER_CREATION_FAILED_" + label + "_" + created.status)
        const token = await bearerFor(row.email, password)
        const identity = await (await fetch(FRONTEND + "/api/centropy/me", { headers: { authorization: "Bearer " + token } })).json()
        made[label] = { email: row.email, password, userId: row.id, tenantId: row.tenant_id, identity }
      }
      return made
    })
    result.actors = { foreign: { tenantId: actors.foreign.tenantId, userId: actors.foreign.userId, identity: actors.foreign.identity?.role ?? null },
      other: { tenantId: actors.other.tenantId, userId: actors.other.userId, identity: actors.other.identity?.role ?? null } }
    save()

    // ---- S3 model with an exact integer history; the public inputs sit at registered periods ----
    const registration = readFileSync(join(repository, REGISTRATION))
    assert.equal(sha(registration), REGISTRATION_SHA, "Z4_FROZEN_REGISTRATION_CHANGED")
    const publicCases = Object.fromEntries(JSON.parse(registration.toString("utf8")).cases.map(item => [item.id, item]))
    const selection = [
      { name: "s3-producer-recovery", id: "weighted-sum:positive-a", owner: "S3", recoverProducer: true, recoverOwner: false, submit: "mounted" },
      { name: "s3-plain", id: "affine:positive-a", owner: "S3", recoverProducer: false, recoverOwner: false, submit: "mounted" },
      { name: "s4-owner-recovery", id: "dot-product:positive-b", owner: "S4", recoverProducer: false, recoverOwner: true, submit: "api" },
      { name: "s4-plain", id: "running-sum:positive-a", owner: "S4", recoverProducer: false, recoverOwner: false, submit: "mounted" },
    ].map((item, index) => {
      const publicCase = publicCases[item.id]
      assert.ok(publicCase, "PUBLIC_CASE_MISSING_" + item.id)
      assert.equal(publicCase.request.inputs.length, 2)
      return { ...item, index, periods: [10 + 2 * index, 11 + 2 * index], publicCase }
    })

    const begin = new Date(Math.floor(Date.now() / day) * day - 128 * day).toISOString()
    const refOf = (id, owner = "SUPPLIED") => ({ owner, id, version: "fixture-v1", contentDigest: sha(id) })
    const model = await step("s3-seed-and-fit", async () => {
      const ok = (await admin.query(`SELECT 1 FROM finnor_os.users u
        WHERE u.tenant_id=$1 AND u.id=$2 AND u.status='active' AND u.role='owner'
          AND EXISTS(SELECT 1 FROM finnor_os.tenant_vertical_assignments v WHERE v.tenant_id=u.tenant_id AND v.vertical_key='private_equity' AND v.effective_from<=clock_timestamp())`,
        [tenantId, me.userId])).rows[0]
      if (!ok) fail("Z4_EXISTING_CANONICAL_OWNER_AND_VERTICAL_REQUIRED")
      await admin.query(`INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$3,'other')`,
        [root.entityId, tenantId, `z4-${runName}`])
      const sourceRow = await memory.createEvidenceSource(tenantId, { sourceKey: `z4:${runName}:history`, sourceType: "pe_document_claim", title: "Generated exact integer history" })
      const version = (await admin.query("SELECT gen_random_uuid()::text id")).rows[0].id
      await admin.query(`INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at)
        VALUES($1,$2,'tenant',$3,1,$4,'Generated exact integer observations',$5::jsonb,$6,clock_timestamp(),clock_timestamp())`,
      [version, sourceRow.id, tenantId, refOf("z4-history").contentDigest,
        JSON.stringify({ worldRoot: root, claims: [{ propositionId: "z4-integer-history", predicate: "reported", value: "Generated integer observations; not field evidence" }] }), begin])
      // Deterministic integer history with ordinary variation; case periods are then overwritten with the public inputs.
      let seed = 20261030
      const draw = limit => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed % (2 * limit + 1)) - limit }
      const rows = []
      let prior = 0
      for (let period = 0; period < 128; period++) {
        const price = draw(3), secondary = draw(2)
        const outcome = Math.max(-12, Math.min(12, Math.round(0.6 * price - 0.3 * secondary + 0.4 * prior) + draw(1)))
        rows.push({ period, outcome, price, priceSecondary: secondary })
        prior = outcome
      }
      for (const item of selection) item.publicCase.request.inputs.forEach((values, step) => {
        const row = rows[item.periods[step]]
        row.outcome = Number(values[0]); row.price = Number(values[1]); row.priceSecondary = Number(values[2])
      })
      const series = {}
      for (const id of ["outcome", "price", "priceSecondary"]) {
        const metric = await pe.createMetricSeries(ctx, { subjectType: "external_organization", subjectId: root.entityId, metricKey: `z4-${id}`, name: `Exact ${id}`, unit: "1", frequency: "daily" })
        series[id] = String(metric.row.id)
        await pe.attachCanonicalEvidenceToWorld(ctx, { worldRoot: root, entity: { entityType: "pe_metric_series", entityId: series[id] },
          evidenceSourceId: sourceRow.id, evidenceVersionId: version, relationship: "supports" })
        for (const row of rows) {
          const at = new Date(Date.parse(begin) + row.period * day).toISOString()
          await admin.query(`INSERT INTO finnor_os.pe_metric_observations(id,tenant_id,metric_series_id,period_start,period_end,value_type,value_numeric,evidence_source_id,evidence_version_id,source_system,created_by)
            VALUES(gen_random_uuid(),$1,$2,$3,$4,'number',$5,$6,$7,'z4:generated-integer',$8)`,
          [tenantId, series[id], at, new Date(Date.parse(at) + day).toISOString(), String(row[id]), sourceRow.id, version, me.userId])
        }
      }
      const exposure = id => ({ id, root, seriesId: series[id], unit: "1", operation: "PRICE_CHANGE",
        measurement: { status: "MEASURED_ACTUAL", methodRef: refOf("z4-measurement-" + id), qualification: "SUPPLIED_OWNER_MEASUREMENT_UNVERIFIED" } })
      const categories = ["SEQUENTIAL_EXCHANGEABILITY", "POSITIVITY", "CONSISTENCY", "MEASUREMENT", "SELECTION", "INTERFERENCE", "STATIONARITY", "FUNCTIONAL_FORM", "ACTOR_INFORMATION"]
      const fitStartedAt = Date.now()
      const request = { schema: "finnor.s3.fit-request.v1", modelKey: "z4-exact-integer-history", episodeId: `z4-${runName}`, roots: [root],
        stateVariables: [{ id: "outcome", root, seriesId: series.outcome, unit: "1", range: [-20, 20], role: "ENTERPRISE_STATE" }],
        exposures: [exposure("price"), exposure("priceSecondary")],
        time: { startAt: begin, endAt: new Date(Date.parse(begin) + 128 * day).toISOString(), periodMs: day, trainingThrough: new Date(Date.parse(begin) + 96 * day).toISOString() },
        validity: { validUntil: new Date(fitStartedAt + 3600000).toISOString(), maxBeliefAgeMs: 3600000, regimes: ["operating"], contexts: ["public-price"], maximumHorizon: 24 },
        measurementPolicy: { selection: "COMPLETE_RECORDED_GRID_ASSUMED", missingness: "NONE", instrumentError: "ASSUMED_NEGLIGIBLE" },
        mechanisms: [{ id: "registered", meaning: "Generated conditional response only", origin: "SUPPLIED_HYPOTHESIS",
          assumptions: categories.map(category => ({ id: category, category, status: "DECLARED", meaning: "Generated fixture assumption", evidenceRefs: [refOf(category)] })),
          equations: [{ variableId: "outcome", features: [{ kind: "CONSTANT" }, { kind: "EXPOSURE", id: "price", lag: 0 }, { kind: "EXPOSURE", id: "priceSecondary", lag: 0 }] }],
          counterparties: [] }],
        numerical: { bootstrapDraws: 64, blockLength: 4, seed: 20261002 } }
      const fitAnswer = await call(API, "/api/interventions/fit", ownerToken, { request })
      if (fitAnswer.status !== 200) {
        // The route maps every owner fault to one public code; the same call in this process names the first throw site.
        const diagnosis = { httpStatus: fitAnswer.status, httpBody: fitAnswer.body }
        try {
          const beliefs = await import("../../../packages/private-equity/src/enterprise-beliefs.ts")
          const view = await beliefs.loadEnterpriseBeliefView(ctx, { root })
          diagnosis.beliefView = { coverage: view.coverage, pin: view.pin, keys: Object.keys(view) }
          diagnosis.pinStatus = (await beliefs.validateBeliefViewPin(ctx, view.pin)).status
        } catch (error) { diagnosis.beliefViewError = { code: error?.code, message: String(error?.message ?? error), stack: String(error?.stack ?? "").split("\n").slice(0, 8) } }
        writeFileSync(join(evidence, "s3-fit-diagnosis.json"), JSON.stringify(diagnosis, null, 2) + "\n", { mode: 0o600 })
      }
      const fitted = expectStatus(fitAnswer, 200, "S3_FIT")
      if (fitted.status !== "FITTED") fail("S3_FIT_NOT_FITTED_" + JSON.stringify(fitted).slice(0, 400))
      writeFileSync(join(evidence, "s3-fit-summary.json"), JSON.stringify({ status: fitted.status, ref: fitted.model.ref, request, historyRowsPublicInputs: selection.map(item => ({ name: item.name, periods: item.periods, inputs: item.publicCase.request.inputs })) }, null, 2) + "\n", { mode: 0o600 })
      return { ref: fitted.model.ref, request, fitStartedAt, validUntil: Date.parse(request.validity.validUntil), series,
        pin: fitted.model.beliefBindings?.[0]?.pin ?? null }
    })
    const deadlineMs = model.fitStartedAt + 55 * 60000
    const deadlineAt = new Date(deadlineMs).toISOString()
    result.timing = { fitStartedAt: new Date(model.fitStartedAt).toISOString(), originalDeadlineAt: deadlineAt, modelValidUntil: new Date(model.validUntil).toISOString() }
    save()

    // ---- S4 mandate/policy and S5 compute envelope, via the real owner routes ----
    const zeros = { cash: 0, execution: 0 }
    const policy = await step("s4-policy", async () => {
      const mandateNow = new Date(Date.now() - 1).toISOString()
      const until = new Date(model.validUntil).toISOString()
      const dimensions = [{ id: "cash", unit: "USD", capacity: 100, totalLimit: 100, resourceClass: "CASH" },
        { id: "execution", unit: "request", capacity: 200, totalLimit: 200, resourceClass: "COMPUTE" }]
      const h = 2
      const body = { schema: "finnor.economic-mandate.v1", tenantId, principalId, episodeId: model.request.episodeId, knowledgeAt: mandateNow, validUntil: until,
        businessOwnerRef: refOf(principalId, "BUSINESS_OWNER"), rightsRef: "s5-owner-rights", utilityRef: refOf("supplied-joint-net-utility", "BUSINESS_OWNER"),
        horizon: { startAt: model.request.time.endAt, periodMs: day, periods: h },
        utility: { unit: "USD", accountingConventionRef: refOf("declared-complete-cost-net-utility", "BUSINESS_OWNER"),
          periodTerms: [{ variableId: "outcome", unit: "1", coefficient: 100 }], discountFactors: Array(h + 1).fill(1), terminalTerms: [],
          tail: { status: "SUPPLIED_COMPLETE_FINITE_HORIZON", terminalLiability: 0, ref: refOf("finite-tail", "BUSINESS_OWNER") } },
        risk: { kind: "HARD_WORST_PATH_UTILITY_FLOOR", minimumUtility: -1000 },
        ambiguity: { kind: "ROBUST_FIXED_JOINT_SCENARIOS", authorizationRef: refOf("common-paths-no-probabilities", "BUSINESS_OWNER") },
        resources: { dimensions, couplings: [] }, search: { maxExpansions: 50000, deadlineMs: 30000, maxWorlds: 512, maxPolicyNodes: 50000, maxHumanSeconds: 900 },
        scoring: { normalization: 100, maxRegret: 0.05 }, authorization: { basis: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED", protectedReceipt: null } }
      body.utilityRef = { ...body.utilityRef, contentDigest: epistemic.allocationRef("BUSINESS_OWNER", "utility", body.utility).contentDigest }
      const mandate = { ...body, ref: epistemic.allocationRef("BUSINESS_OWNER", "mandate", body, "economic-mandate-v1") }
      const exposureIds = ["price", "priceSecondary"]
      const action = (id, kind, period, last, amounts, dose) => ({ id, kind, cost: 0, costUnit: "USD", resources: { ...zeros, ...amounts }, occupancy: { ...zeros },
        occupationPeriods: h, tailLiability: 0, earliestPeriod: period, lastPeriod: last, atMostOnce: kind === "INTERVENE",
        exposures: kind === "INTERVENE" ? Object.fromEntries(exposureIds.map(id => [id, [dose]])) : {}, protocolRef: null, informationDelayPeriods: 1, humanSeconds: 0 })
      const input = { mandate, problem: { schema: "finnor.control-problem.v1", id: "z4-native-price", episodeId: mandate.episodeId, modelRef: model.ref,
        context: "public-price", regime: "operating", baselineExposures: Object.fromEntries(exposureIds.map(id => [id, Array(h).fill(0)])),
        actions: [action("programme-price", "INTERVENE", 0, 0, { cash: 25 }, 0.15), action("wait", "WAIT", 0, h - 1, {}, 0), action("stop", "STOP", 0, h - 1, {}, 0)],
        observations: [], obligations: [], validUntil: mandate.validUntil }, protocols: [], scenarios: { pathsPerMechanism: 4, seed: 20261002 } }
      const produced = expectStatus(await call(API, "/api/policies/synthesize", ownerToken, input), 200, "S4_SYNTHESIZE")
      if (produced.status !== "POLICY_AVAILABLE" || !produced.policy) fail("S4_POLICY_NOT_AVAILABLE_" + JSON.stringify(produced).slice(0, 400))
      return { mandate, policy: produced.policy }
    })
    await step("s5-compute-resource", async () => {
      const m = policy.mandate
      const resource = { schema: "finnor.allocation-resource.v1", resourceId: "execution", tenantId, ownerRef: m.businessOwnerRef, legalEntityRef: refOf(root.entityId, "S1"),
        scopeRef: refOf("z4-native", "BUSINESS_OWNER"), permittedRoots: [root], rightsRef: m.rightsRef, unit: "request", currency: null, kind: "CUMULATIVE_EXPENDITURE",
        resourceClass: "COMPUTE", horizon: m.horizon, sourceRef: refOf("source-execution", "BUSINESS_OWNER"), asOf: m.knowledgeAt, knowledgeAt: m.knowledgeAt,
        validUntil: m.validUntil, beliefPins: policy.policy.bindings.beliefPins, availability: ["2000", "2000", "2000"].map(amount => ({ amount, basis: "REPORTED_AVAILABLE" })),
        existingUse: ["0", "0", "0"], safetyMargin: "0", covenants: [], revoked: false, qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" }
      expectStatus(await call(API, "/api/allocations/resource", ownerToken, { resource }), 200, "S5_RESOURCE")
    })

    // ---- original Work: intake, plan and (for some) submission through the real routes ----
    const horizon = 2
    const specification = value => ({ schema: "finnor.intervention-specification.v1", vocabularyVersion: "s3-intervention-v1", targets: [root], context: "public-price",
      timing: { startAt: model.request.time.endAt, periodMs: day, durationMs: horizon * day },
      channels: ["price", "priceSecondary"].map(exposureId => ({ exposureId, operation: "PRICE_CHANGE", unit: "1", target: root,
        doses: Array(horizon).fill(value), intendedExposure: "REGISTERED_DOSE", permittedRefinements: [] })) })
    const columns = [{ kind: "STATE", variableId: "outcome", unit: "1" }, { kind: "EXPOSURE", variableId: "price", unit: "1" },
      { kind: "EXPOSURE", variableId: "priceSecondary", unit: "1" }]
    const decisionAt = new Date(Math.max(Date.now(), Date.parse(policy.policy.knowledgeAt ?? 0))).toISOString()
    const ownerContract = (owner, periods, guard, tag) => owner === "S3"
      ? { owner, modelRef: model.ref, periods, columns, query: { schema: "finnor.s3.response-query.v1", id: "z4-query-" + tag, episodeId: model.request.episodeId,
        kind: "POPULATION_INTERVENTION", targets: [root], context: "public-price", regime: "operating", horizon, intervention: specification(1),
        comparator: specification(0), simulations: 256, seed: 20261003 }, guard }
      : { owner, modelRef: model.ref, periods, columns, policyRef: policy.policy.ref,
        decision: { knowledgeAt: decisionAt, period: 0, actionHistory: [], observations: [], rightsRef: policy.mandate.rightsRef, obligations: [],
          allocationRefs: policy.policy.bindings.allocationRefs ?? [] }, allocationRef: null, guard }
    const baseRequest = ({ item, tag, amount = "8", program, initial, owner, periods, guard }) => ({ schema: "finnor.z4.submit.v1", mode: "ordinary_disposable", root,
      idempotencyKey: `z4-${runName}-${tag}`, purpose: `Z4 native exact computation ${tag} (${runName})`, program, initial,
      ownerContract: ownerContract(owner, periods, guard, tag), deadlineAt, resourceDemand: [{ resourceId: "execution", unit: "request", amount }],
      maxMemoryBytes: 512 * 1024 * 1024, maxCpuSeconds: 300, maxAttempts: 3, maxRetainedBytes: 16 * 1024 * 1024 })
    async function createWork(tag, parts) {
      const intakeBody = baseRequest({ tag, ...parts })
      const intake = expectStatus(await call(API, "/api/company-brain/execution-proof-intake", ownerToken, intakeBody), 200, "INTAKE_" + tag)
      assert.match(intake.workId, /^[0-9a-f-]{36}$/)
      const planBody = { ...intakeBody, workId: intake.workId, workInputId: intake.workInputId }
      const plan = expectStatus(await call(API, "/api/company-brain/execution-proof-plan", ownerToken, planBody), 200, "PLAN_" + tag)
      return { ...planBody, workRevisionRef: plan.workRevisionRef }
    }
    const works = await step("original-work-intake-and-plan", async () => {
      const made = []
      try {
        for (const item of selection) {
          const guard = { register: 0, unit: item.publicCase.request.program.registers[0].unit, minimum: item.publicCase.expectedFinal[0], maximum: item.publicCase.expectedFinal[0] }
          const request = await createWork(item.name, { amount: "8", program: item.publicCase.request.program, initial: item.publicCase.request.initial, owner: item.owner, periods: item.periods, guard })
          made.push({ ...item, request })
        }
      } catch (error) {
        // The route maps owner faults to one public code; re-run the same currentness gates in-process to name the first one.
        const diagnosis = { error: String(error?.message ?? error), completedWorks: made.map(item => item.name) }
        try { diagnosis.modelValidation = await pe.validateEnterpriseInterventionModel(ctx, model.ref) }
        catch (inner) { diagnosis.modelValidationError = String(inner?.message ?? inner) }
        if (model.pin) try {
          const beliefs = await import("../../../packages/private-equity/src/enterprise-beliefs.ts")
          const pinCheck = await beliefs.validateBeliefViewPin(ctx, model.pin)
          diagnosis.pinRevalidation = { status: pinCheck.status, reason: pinCheck.reason }
          const view = await beliefs.loadEnterpriseBeliefView(ctx, { root })
          diagnosis.freshView = { dependencyDigest: view.dependencyDigest, rightsRevision: view.rights?.revision, canonicalStatus: view.coverage.canonicalStatus }
          diagnosis.fitPin = { dependencyDigest: model.pin.dependencyDigest, rightsRevision: model.pin.rightsRevision, validAt: model.pin.validAt }
        } catch (inner) { diagnosis.pinError = String(inner?.message ?? inner) }
        writeFileSync(join(evidence, "intake-diagnosis.json"), JSON.stringify(diagnosis, null, 2) + "\n", { mode: 0o600 })
        throw error
      }
      return made
    })
    // The cancelled Work and the over-budget Work are extra originals used only by the exact negatives below.
    const template = selection[1].publicCase.request
    const extras = await step("negative-support-work", async () => {
      const guard = { register: 0, unit: template.program.registers[0].unit, minimum: "-1000000", maximum: "1000000" }
      const cancelled = await createWork("cancelled-original", { amount: "8", program: template.program, initial: template.initial, owner: "S3", periods: [30, 31], guard })
      const overBudget = await createWork("over-budget-original", { amount: "2049", program: template.program, initial: template.initial, owner: "S3", periods: [32, 33], guard })
      return { cancelled, overBudget }
    })
    const submitted = await step("pre-submit-and-cancel", async () => {
      const recoverOwner = works.find(item => item.recoverOwner)
      const sessionBody = expectStatus(await call(API, "/api/company-brain/execution-proof-submit", ownerToken, recoverOwner.request), 202, "PRE_SUBMIT_OWNER_RECOVERY")
      const cancelledSession = expectStatus(await call(API, "/api/company-brain/execution-proof-submit", ownerToken, extras.cancelled), 202, "PRE_SUBMIT_CANCELLED")
      expectStatus(await call(API, "/api/company-brain/execution-proof-cancel", ownerToken, { sessionId: cancelledSession.sessionId }), 200, "CANCEL_ORIGINAL")
      return { recoverOwnerSession: sessionBody.sessionId, cancelledSession: cancelledSession.sessionId }
    })
    result.works = works.map(item => ({ name: item.name, publicCaseId: item.id, owner: item.owner, workId: item.request.workId, workInputId: item.request.workInputId,
      planRevision: item.request.workRevisionRef.id, periods: item.periods }))
    result.negativeSupport = { cancelledWorkId: extras.cancelled.workId, overBudgetWorkId: extras.overBudget.workId }
    save()

    // ---- case, expected and negative files; the ownerSourceDigest is an identity binding computed by the product owner ----
    const files = join(evidence, "preimages")
    mkdirSync(files, { mode: 0o700 })
    const writeFile = (name, value) => { const path = join(files, name); const body = JSON.stringify(value, null, 2) + "\n"; writeFileSync(path, body, { mode: 0o600 }); return { path, sha256: sha(body) } }
    const cases = []
    for (const item of works) {
      const original = await source.ownerSource(ctx, z4.submitSchema.parse(item.request))
      const request = writeFile(`${item.name}.request.json`, item.request)
      const expected = writeFile(`${item.name}.expected.json`, { schema: "finnor.z4.native-expected.v1", fixture: false, ownerSourceDigest: original.digest,
        inputs: item.publicCase.request.inputs, finalState: item.publicCase.expectedFinal,
        provenance: `Literal expectedFinal and inputs of public case ${item.id} from ${REGISTRATION} (sha256 ${REGISTRATION_SHA}), registered before the Z4 code. ownerSourceDigest is the identity binding computed by ownerSource() after seeding, not an oracle.` })
      cases.push({ name: item.name, workId: item.request.workId, workInputId: item.request.workInputId, requestFile: request.path, requestSha256: request.sha256,
        expectedFile: expected.path, expectedSha256: expected.sha256, ...(item.recoverOwner ? { sessionId: submitted.recoverOwnerSession } : {}),
        recoverProducer: item.recoverProducer, recoverOwner: item.recoverOwner })
    }
    const ownerRecovery = works.find(item => item.recoverOwner)
    const unsupported = structuredClone(works[0].request)
    unsupported.program.instructions[0].op = "div"
    const incomplete = structuredClone(works[0].request)
    delete incomplete.ownerContract
    const lateDeadline = { ...extras.overBudget, deadlineAt: new Date(deadlineMs + 60000).toISOString() }
    const zeroDigest = "0".repeat(64)
    const negativeSpecs = [
      { kind: "tenant", operation: "execution-proof-read", actor: "FOREIGN", body: { sessionId: submitted.recoverOwnerSession }, status: 404, predicate: "PE_ENTITY_NOT_FOUND" },
      { kind: "tenant", operation: "execution-proof-audit", actor: "FOREIGN", body: { sessionId: submitted.recoverOwnerSession }, status: 404, predicate: "PE_ENTITY_NOT_FOUND" },
      { kind: "authority", operation: "execution-proof-cancel", actor: "OTHER", body: { sessionId: submitted.recoverOwnerSession }, status: 404, predicate: "PE_ENTITY_NOT_FOUND" },
      { kind: "private-use", operation: "execution-proof-consume", actor: "OTHER", body: { sessionId: submitted.recoverOwnerSession, capsuleDigest: zeroDigest, idempotencyKey: "z4-negative-private-use" }, status: 404, predicate: "PE_ENTITY_NOT_FOUND" },
      // A later deadline on the same Work is a deadline-reset attempt: workSnapshot refuses it before any budget check.
      { kind: "currentness", operation: "execution-proof-submit", actor: null, body: lateDeadline, status: 422, predicate: "Z4_ORIGINAL_PLAN_OR_DEADLINE_CHANGED" },
      { kind: "budget", operation: "execution-proof-submit", actor: null, body: extras.overBudget, status: 422, predicate: "X2_S5_ORIGINAL_DEMAND_DOMAIN" },
      { kind: "cancellation", operation: "execution-proof-consume", actor: null, body: { sessionId: submitted.cancelledSession, capsuleDigest: zeroDigest, idempotencyKey: "z4-negative-cancelled" }, status: 422, predicate: "Z4_CURRENT_CHECKED_CAPSULE_REQUIRED" },
      { kind: "cancellation", operation: "execution-proof-audit", actor: null, body: { sessionId: submitted.cancelledSession }, status: 422, predicate: "Z4_CURRENT_CHECKED_CAPSULE_REQUIRED" },
      { kind: "unsupported", operation: "execution-proof-submit", actor: null, body: unsupported, status: 400, predicate: "Z4_TYPED_DOMAIN_REQUIRED" },
      { kind: "incomplete", operation: "execution-proof-submit", actor: null, body: incomplete, status: 400, predicate: "Z4_TYPED_DOMAIN_REQUIRED" },
      { kind: "incomplete", operation: "execution-proof-read", actor: null, body: {}, status: 400, predicate: "Z4_TYPED_DOMAIN_REQUIRED" },
    ]
    const envNames = { OWNER: "FINNOR_Z4_REPLAY_OWNER_CREDENTIALS", FOREIGN: "FINNOR_Z4_REPLAY_FOREIGN_CREDENTIALS", OTHER: "FINNOR_Z4_REPLAY_OTHER_CREDENTIALS" }
    const negatives = negativeSpecs.map((spec, index) => {
      const file = writeFile(`negative-${String(index + 1).padStart(2, "0")}-${spec.kind}.json`, spec.body)
      return { kind: spec.kind, operation: spec.operation, bodyFile: file.path, bodySha256: file.sha256,
        ...(spec.actor ? { credentialsEnvironmentVariable: envNames[spec.actor] } : {}), expectedStatus: spec.status, expectedPredicate: spec.predicate }
    })

    if (stage === "seed") {
      // Iteration aid only: the expectations above come from the product source; this records what the routes answer.
      const tokens = { null: ownerToken, OWNER: ownerToken, FOREIGN: await bearerFor(actors.foreign.email, actors.foreign.password),
        OTHER: await bearerFor(actors.other.email, actors.other.password) }
      result.negativeProbe = []
      for (const spec of negativeSpecs) {
        const answer = await call(API, "/api/company-brain/" + spec.operation, tokens[spec.actor], spec.body)
        const predicate = answer.body?.predicate ?? answer.body?.code ?? null
        result.negativeProbe.push({ kind: spec.kind, operation: spec.operation, actor: spec.actor, expected: [spec.status, spec.predicate], observed: [answer.status, predicate],
          matches: answer.status === spec.status && predicate === spec.predicate })
      }
      result.status = "SEEDED_ONLY"; save(); process.exit(0)
    }

    // ---- target receipt and scope ----
    const identity = JSON.parse(readFileSync(join(repository, "finnor-os/packages/epistemic-runtime/native/z4-execution-proof/build-identity.json"), "utf8"))
    const git = args => spawnSync("git", ["-C", repository, ...args], { encoding: "utf8" }).stdout.trim()
    const buildIds = { frontend: join(repository, ".next/BUILD_ID"), api: join(repository, "finnor-os/apps/api/.next/BUILD_ID") }
    const targetBody = { schema: "finnor.z4.existing-native-target.v1", fixture: false, production: false, initializationAlreadyComplete: true, authProjectSame: true,
      liveProvidersDisabled: true, externalEffectsDisabled: true, exclusiveHeavyWorker: true, frontendOrigin: FRONTEND, backendOrigin: API, authOrigin: tls.origin,
      authCertificateFile: tls.certificateFile, authCertificateSha256: tls.certificateSha256, authCertificateSpkiSha256: tls.spkiSha256,
      frontendBuildIdFile: buildIds.frontend, frontendBuildIdSha256: sha(readFileSync(buildIds.frontend)),
      backendBuildIdFile: buildIds.api, backendBuildIdSha256: sha(readFileSync(buildIds.api)),
      chromiumExecutableFile: chromium, chromiumExecutableSha256: sha(readFileSync(chromium)),
      databaseHost: "127.0.0.1", databasePort: 55441, databaseName: "finnor" }
    const target = { ...targetBody, targetFingerprint: sha(canonical(targetBody)) }
    const targetBytes = JSON.stringify(target, null, 2) + "\n"
    const targetFile = join(evidence, "target-receipt.private.json")
    writeFileSync(targetFile, targetBytes, { mode: 0o600 })
    const grantedAt = new Date()
    const expiresAt = new Date(Math.min(deadlineMs - 30000, grantedAt.getTime() + 3600000 - 1000))
    const inventory = await authority.ownedInventory(repository)
    const scope = { phase: "Z4", mode: "ordinary_disposable", publicInputOnly: true, existingTargetOnly: true, noInitialization: true, noListeners: true, noExternalEffects: true,
      sourceCommit: git(["rev-parse", "HEAD"]), sourceTree: git(["rev-parse", "HEAD^{tree}"]), ownedSourceDigest: inventory.digest,
      nativeSourceDigest: identity.sourceDigest, nativeBinarySha256: identity.binarySha256, tenantId, principalId,
      targetReceiptFile: targetFile, targetReceiptSha256: sha(targetBytes), credentialsEnvironmentVariable: envNames.OWNER,
      databaseEnvironmentVariable: "FINNOR_Z4_REPLAY_DATABASE_URL",
      runtimeEnvironmentVariableNames: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "FINNOR_S3_MODEL_STORE", "FINNOR_S4_POLICY_STORE", "FINNOR_Z4_CAPSULE_STORE"],
      grantedAt: grantedAt.toISOString(), expiresAt: expiresAt.toISOString(), cases, negatives }
    authority.scopeSchema.parse(scope)
    const scopeFile = join(evidence, "scope.private.json")
    writeFileSync(scopeFile, JSON.stringify(scope, null, 2) + "\n", { mode: 0o600 })
    result.scope = { digest: sha(JSON.stringify(scope, null, 2) + "\n"), sourceCommit: scope.sourceCommit, ownedSourceDigest: scope.ownedSourceDigest,
      cases: cases.map(item => item.name), negativeKinds: negatives.map(item => item.kind), grantedAt: scope.grantedAt, expiresAt: scope.expiresAt }
    save()

    // ---- coordinator signer: the only writer of the grant receipt ----
    const grantDirectory = join(repository, "scope-z/orchestration/replay-grants/z4")
    const signed = await step("coordinator-signer", async () => {
      const run = spawnSync(process.execPath, [signer, "--repository", repository, "--scope", scopeFile, "--out-dir", grantDirectory],
        { encoding: "utf8", env: { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: evidence }, timeout: 120000 })
      writeFileSync(join(evidence, "signer.private.stdout"), run.stdout ?? "", { mode: 0o600 })
      writeFileSync(join(evidence, "signer.private.stderr"), run.stderr ?? "", { mode: 0o600 })
      let value = null
      try { value = JSON.parse((run.stdout ?? "").trim().split("\n").at(-1)) } catch { /* handled below */ }
      if (run.status !== 0 || !value?.signed) fail("COORDINATOR_SIGNER_REFUSED_" + (value?.predicate ?? run.status))
      return value
    })
    result.grant = { receiptSha256: signed.receiptSha256, scopeDigest: signed.scopeDigest, expiresAt: signed.expiresAt }
    const manifestFile = join(evidence, "manifest.private.json")
    writeFileSync(manifestFile, JSON.stringify({ schema: "finnor.z4.replay-authority.v1", fixture: false, scope, grantReceiptPath: signed.path,
      grantReceiptSha256: signed.receiptSha256 }, null, 2) + "\n", { mode: 0o600 })
    chmodSync(manifestFile, 0o600)

    // ---- guarded native replay ----
    const replayEvidence = join(evidence, "replay")
    const replayEnv = { PATH: dirname(process.execPath) + ":/usr/bin:/bin", HOME: evidence, LANG: "C.UTF-8",
      FINNOR_Z4_REPLAY_AUTHORITY_SHA256: signed.receiptSha256,
      [envNames.OWNER]: JSON.stringify(ownerCredentials),
      [envNames.FOREIGN]: JSON.stringify({ email: actors.foreign.email, password: actors.foreign.password }),
      [envNames.OTHER]: JSON.stringify({ email: actors.other.email, password: actors.other.password }),
      FINNOR_Z4_REPLAY_DATABASE_URL: privateEnv.FINNOR_WORKER_DATABASE_URL,
      SUPABASE_URL: privateEnv.SUPABASE_URL, SUPABASE_ANON_KEY: privateEnv.SUPABASE_ANON_KEY,
      FINNOR_S3_MODEL_STORE: privateEnv.FINNOR_S3_MODEL_STORE, FINNOR_S4_POLICY_STORE: privateEnv.FINNOR_S4_POLICY_STORE,
      FINNOR_Z4_CAPSULE_STORE: privateEnv.FINNOR_Z4_CAPSULE_STORE }
    assert.ok(replayEnv.FINNOR_Z4_REPLAY_DATABASE_URL, "WORKER_DATABASE_URL_REQUIRED")
    const replay = await step("native-replay", () => new Promise((resolve, reject) => {
      const out = [], err = []
      const child = spawn("/usr/bin/python3", ["-I", "-B", join(repository, "finnor-os/scripts/project-z/z4/reconstruct.py"), "replay", "--repository", repository,
        "--evidence", replayEvidence, "--manifest", manifestFile, "--node", process.execPath], { env: replayEnv, stdio: ["ignore", "pipe", "pipe"], detached: true })
      child.stdout.on("data", chunk => out.push(chunk))
      child.stderr.on("data", chunk => err.push(chunk))
      const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch { /* already gone */ } }, Math.max(1000, expiresAt.getTime() - Date.now()))
      child.once("error", reject)
      child.once("close", (code, signal) => {
        clearTimeout(timer)
        writeFileSync(join(evidence, "replay.private.stdout"), Buffer.concat(out), { mode: 0o600 })
        writeFileSync(join(evidence, "replay.private.stderr"), Buffer.concat(err), { mode: 0o600 })
        resolve({ code, signal })
      })
    }))
    result.replay = { exit: replay.code, signal: replay.signal }
    let report = null
    try { report = JSON.parse(readFileSync(join(replayEvidence, "report.json"), "utf8")) } catch { /* absent when the guard refused */ }
    result.replay.report = report ? { status: report.status, failure: report.failure ?? null, cases: report.cases.length, negatives: report.negatives.length,
      nativeOwner: report.nativeOwner, protectedAdmission: report.protectedAdmission } : null
    result.status = report?.status === "PASSED_NATIVE_ORDINARY_ENGINEERING_ONLY" && replay.code === 0 ? "REPLAY_PASSED_ORDINARY_ENGINEERING_ONLY" : "REPLAY_FAILED"
    save()
    if (result.status !== "REPLAY_PASSED_ORDINARY_ENGINEERING_ONLY") process.exitCode = 1
  } finally { await admin.end().catch(() => undefined); await db.getPool().end().catch(() => undefined) }
} catch (error) {
  result.status = "FAILED"
  result.failure = String(error?.message ?? error).slice(0, 800)
  save()
  process.exitCode = 1
}

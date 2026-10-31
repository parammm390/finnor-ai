/** Worker G Z1 disposable seeding through existing product library owners only.
 * Never prints credentials. Writes IDs/pins to new 0600 files. Creates no S6
 * obligation: the only in-repo S6 preparation chain needs the S3 numerics
 * backend (numpy/scipy), which is not installed on this host. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [state, output, scratch] = process.argv.slice(2);
if (!state || !output || !scratch) throw Error("STATE_OUTPUT_SCRATCH_REQUIRED");
const env = JSON.parse(readFileSync(`${state}/native-environment-01.private.json`, "utf8"));
process.env.DATABASE_URL = env.DATABASE_URL;
for (const key of ["FINNOR_ENVIRONMENT", "FINNOR_Z1_PROFILE", "P3_GOVERNORS"]) if (env[key]) process.env[key] = env[key];
const pkg = `${scratch}/finnor-os/packages`;
const db = await import(`${pkg}/db/index.ts`);
const pe = await import(`${pkg}/private-equity/src/index.ts`);
const memory = await import(`${pkg}/memory/src/evidence.ts`);
const store = await import(`${pkg}/private-equity/src/allocation-store.ts`);
const z1res = await import(`${pkg}/private-equity/src/project-z/z1-shared-work/resources.ts`);
const z1store = await import(`${pkg}/private-equity/src/project-z/z1-shared-work/native-store.ts`);
const authority = await import(`${pkg}/authority/src/index.ts`);
const steps = [];
const step = async (name, fn) => {
  const startedAt = new Date().toISOString();
  try { const value = await fn(); steps.push({ name, startedAt, status: "OK" }); return value; }
  catch (error) { steps.push({ name, startedAt, status: "FAILED", code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 300) }); throw error; }
};
const receipt = { schema: "fzv-g-29.z1-seed-receipt.v3", supersedesFailedAttempts: ["seed.mjs (g29-z1-native-01)", "seed-02.mjs (g29-z1-native-02)"], startedAt: new Date().toISOString(), method: "PRODUCT_LIBRARY_FUNCTIONS_IN_SEEDER_PROCESS_NOT_HTTP",
  functions: ["resolve_authenticated_identity", "createDeal", "createInvestmentCase", "activateInvestmentCase", "receiveWork", "createEvidenceSource",
    "appendEvidenceVersion", "putAllocationResource", "currentWorkInputTx", "originalObligationsTx", "employeeAuthoritySnapshotTx"], steps };
const episodeId = "fzv-g-29-z1";
try {
  const identity = (await db.getPool().query("SELECT * FROM finnor_os.resolve_authenticated_identity($1)", [env.TEST_OWNER_EMAIL])).rows[0];
  if (!identity || identity.user_role !== "owner") throw Error("REAL_TEST_OWNER_BINDING_MISSING");
  const tenantId = identity.tenant_id, principalId = identity.user_id;
  const ctx = { auth: { tenantId, userId: principalId, employeeId: principalId, role: "owner" },
    provenance: { sourceSystem: "z1:fzv-g-29-seed", createdBy: principalId } };
  Object.assign(receipt, { tenantId, principalId, employeeStatus: identity.employee_status, authorityRevision: identity.authority_revision });
  const phase9Deal = "90000000-0000-4000-8000-000000000001", targetOrg = "90000000-0000-4000-8000-000000000027";
  const deal = await step("createDeal", () => pe.createDeal(ctx, { targetOrganizationId: targetOrg, name: "Z1 public exact fixture deal fzv-g-29",
    codeName: "FZVG29", dealLeadEmployeeId: principalId, signedLoiAt: new Date(), targetClosingAt: new Date(Date.now() + 30 * 86400000) }));
  const root = { entityType: "pe_deal", entityId: String(deal.row.id) }, foreignRoot = { entityType: "pe_deal", entityId: phase9Deal };
  // pe_investment_cases_one_active_idx admits one active case per deal (seed-01 failure), so Works 1 and 2 share it.
  const created = await step("createInvestmentCase-1", () => pe.createInvestmentCase(ctx, { dealId: root.entityId, title: "Z1 public exact choice case" }));
  await step("activateInvestmentCase-1", () => pe.activateInvestmentCase(ctx, { investmentCaseId: String(created.row.id), expectedVersion: 1 }));
  const cases = [String(created.row.id), String(created.row.id)];
  const works = [];
  for (const index of [0, 1, 2]) works.push(await step(`receiveWork-${index}`, () => db.receiveWork({ tenantId, userId: principalId, channel: "console",
    instruction: `Z1 public deterministic exact original Work ${index} (${episodeId})`, idempotencyKey: `${episodeId}:work:${index}`,
    activeContext: { businessRoot: root } })));
  receipt.workIds = works.map(w => w.workId);
  const foreign = await step("receiveWork-foreign", () => db.receiveWork({ tenantId, userId: principalId, channel: "console",
    instruction: `Z1 negative-scope Work rooted elsewhere (${episodeId})`, idempotencyKey: `${episodeId}:work:foreign`,
    activeContext: { businessRoot: foreignRoot } }));
  const snapshot = { z1FixtureEpisode: episodeId, worldRoot: root, protectionDomain: "DISPOSABLE_LOCAL_DEVELOPMENT", externalEffects: false,
    qualification: "PUBLIC_DETERMINISTIC_FIXTURE_NO_PII" };
  const sources = {};
  for (const name of ["ledger", "dimension", "declaration-0", "declaration-1", "declaration-2"]) {
    const source = await step(`createEvidenceSource-${name}`, () => memory.createEvidenceSource(tenantId, { sourceKey: `z1:${episodeId}:${name}`,
      sourceType: "manual", title: `Z1 public fixture ${name}` }));
    const version = await step(`appendEvidenceVersion-${name}`, () => memory.appendEvidenceVersion(tenantId, source.id,
      { content: JSON.stringify({ episodeId, name, initial: true }), snapshot, asOf: new Date() }));
    sources[name] = { sourceId: source.id, versionId: version.versionId };
  }
  const now = Date.now(), ref = (id, owner = "BUSINESS_OWNER") => ({ owner, id, version: "public-owner-input-v1",
    contentDigest: createHash("sha256").update(JSON.stringify({ id, owner })).digest("hex") });
  const horizon = { startAt: new Date(now - 60000).toISOString(), periodMs: 3600000, periods: 6 };
  const roles = { logical: ["z1-logical-tick", "CUMULATIVE_EXPENDITURE"], cpu: ["cpu-microseconds", "CUMULATIVE_EXPENDITURE"],
    storage: ["byte", "CUMULATIVE_EXPENDITURE"], memory: ["byte", "OCCUPANCY"] };
  const resources = {};
  for (const [role, [unit, kind]] of Object.entries(roles)) {
    const body = { schema: "finnor.allocation-resource.v1", resourceId: `z1_fzvg29_${role}`, tenantId, ownerRef: ref(principalId),
      legalEntityRef: ref(root.entityId, "S1"), scopeRef: ref(`z1-fzvg29-${role}`), permittedRoots: [root], rightsRef: "S1:current-owner-assertion",
      unit, currency: null, kind, resourceClass: "COMPUTE", horizon, sourceRef: ref(`public_declared_compute_${role}`),
      asOf: new Date(now - 60000).toISOString(), knowledgeAt: new Date(now - 60000).toISOString(), validUntil: new Date(now + 6 * 3600000).toISOString(),
      beliefPins: [], availability: Array.from({ length: horizon.periods + 1 }, () => ({ amount: "100000000000", basis: "REPORTED_AVAILABLE" })),
      existingUse: Array(horizon.periods + 1).fill("0"), safetyMargin: "0", covenants: [], revoked: false, qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" };
    const created = await step(`putAllocationResource-${role}`, () => store.putAllocationResource(ctx, body, null));
    resources[role] = created.ref;
  }
  // Read-only transactions refuse the SELECT FOR SHARE these owner reads take (seed-02 failure, 25006); nothing is written here.
  const bound = await step("readBindings", () => db.withTenantTransaction(tenantId, { userId: principalId, readOnly: false }, async (_d, c) => {
    const rights = await authority.employeeAuthoritySnapshotTx(ctx.auth, c);
    const pins = {};
    for (const [name, item] of Object.entries(sources)) {
      const row = (await c.query("SELECT id::text,content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND source_id=$2 ORDER BY version_number DESC,id DESC LIMIT 1",
        [tenantId, item.sourceId])).rows[0];
      pins[name] = { sourceId: item.sourceId, versionId: row.id, contentDigest: row.content_hash };
    }
    const inputs = [];
    for (const work of works) inputs.push({ ...(await z1res.currentWorkInputTx(ctx, c, work.workId, root)),
      obligations: await z1store.originalObligationsTx(ctx, c, work.workId).catch(error => ({ refused: String(error?.message ?? error).slice(0, 200) })) });
    return { rightsRevision: String(rights.revision), pins, inputs };
  }));
  const bindings = { schema: "finnor.z1.existing-public-fixture-bindings.v1", dataClass: "PUBLIC_DETERMINISTIC_FIXTURE_NO_PII", episodeId,
    tenantId, principalId, root, foreignRoot, foreignWorkId: foreign.workId, rightsRevision: bound.rightsRevision,
    deadlineAt: new Date(now + 3 * 3600000).toISOString(), resources,
    sources: { ledger: bound.pins.ledger, dimension: bound.pins.dimension },
    works: works.map((work, index) => ({ workId: work.workId, inputId: bound.inputs[index].inputId, inputDigest: bound.inputs[index].inputDigest,
      declaration: bound.pins[`declaration-${index}`], unresolvedObligationRefs: Array.isArray(bound.inputs[index].obligations) ? bound.inputs[index].obligations : [],
      ...(index ? { investmentCaseId: cases[index - 1] } : {}) })) };
  writeFileSync(`${output}/bindings-without-s6-obligation.json`, JSON.stringify(bindings, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  Object.assign(receipt, { status: "SEEDED_EXCEPT_S6_OBLIGATION", root, foreignRoot, workIds: works.map(w => w.workId), workInputIds: works.map(w => w.workInputId),
    foreignWorkId: foreign.workId, investmentCaseIds: cases, sources: bound.pins, resources, obligationReads: bound.inputs.map(i => i.obligations),
    s6Obligation: "NOT_CREATED_S3_NUMERICS_BACKEND_ABSENT" });
} catch (error) {
  receipt.status = "FAILED"; receipt.failure = String(error?.message ?? error).slice(0, 300);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  writeFileSync(`${output}/seed-receipt.json`, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await db.closePool?.().catch(() => {});
  console.log(JSON.stringify({ status: receipt.status, steps: steps.length, failure: receipt.failure ?? null }));
}

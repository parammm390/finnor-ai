import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createForeignIdentity, readNativeEnvironment, signInOwner, startOwnedWorker } from "./x1-origin-fixture.mts";

const state = process.env.FINNOR_NATIVE_STATE;
const evidence = process.env.FINNOR_NATIVE_EVIDENCE;
assert(state && evidence, "Z0_NATIVE_SCENARIO_REQUIRED");
const env = readNativeEnvironment(state);
process.env.DATABASE_URL = env.DATABASE_URL;
const { default: pg } = await import("pg");
const db = await import("@finnor/db");
const { createDocument, appendDocumentVersion } = await import("@finnor/data-platform");
const { employeeAuthoritySnapshot } = await import("@finnor/authority");
const { sha } = await import("../../../packages/private-equity/src/confidential-computation/contracts.ts");
const sql = new pg.Client({ connectionString: env.CENTROPY_E2E_DB_ADMIN_URL });
await mkdir(evidence, { recursive: true, mode: 0o700 });
await sql.connect();
let worker;

const ensure = (value, code) => { if (!value) throw Error(code); };
const ask = async (owner, op, body, status = 200) => {
  const reply = await owner.operation(op, body);
  ensure(reply.status === status, "Z0_Y4_HTTP_" + op.replaceAll("-", "_").toUpperCase() + "_" + reply.status);
  return reply.body;
};
const ref = (owner, id) => ({ owner, id, version: "disposable-v1", contentDigest: sha({ owner, id }) });
const q = async (text, values) => (await sql.query(text, values)).rows;
const save = async result => writeFile(join(evidence, "z0-001-case-D1-03a.json"),
  JSON.stringify({ id: "D1-03a", ...result }, null, 2) + "\n", { mode: 0o600 });

try {
  const owner = await signInOwner(env);
  const { tenantId } = owner;
  const sessions = [owner];
  for (let i = 0; i < 2; i++) {
    const identity = await createForeignIdentity(env, { tenantId });
    sessions.push(await signInOwner(env, identity));
  }
  const peer = await signInOwner(env, await createForeignIdentity(env, { tenantId }));
  const target = randomUUID();
  await q("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,'Disposable confidential query target','other')",
    [target, tenantId, "z0-y4-" + target]);
  const root = { entityType: "external_organization", entityId: target };
  const deadlineAt = new Date(Date.now() + 30 * 60000).toISOString();
  const expiresAt = new Date(Date.now() + 40 * 60000).toISOString();
  const now = new Date().toISOString();
  const purpose = "Observe the original confidential computation through its authenticated native reader";
  const semantics = { ...root, periodStart: "2026-10-01T00:00:00Z", periodEnd: "2026-10-31T00:00:00Z",
    unit: "currency", currencyCode: "USD", frequency: "monthly", calendar: "GREGORIAN",
    consolidation: "CONSOLIDATED", instrument: "EXPLICIT_JOINT_TERMS", scale: "1", sign: "AS_RECORDED" };
  const participants = [], inputs = [], privateValues = [];
  for (const [i, session] of sessions.entries()) {
    const principalId = session.userId, institutionId = randomUUID(), participantId = "p" + i;
    const sourceWork = await db.receiveWork({ tenantId, userId: principalId, instruction: purpose, channel: "console",
      idempotencyKey: randomUUID(), activeContext: { focusedEntity: root } });
    await ask(session, "institution-mandate", { workId: sourceWork.workId, institutionId, expiresAt,
      rules: [{ id: "source", triggerKind: "evidence_request_needed", operation: "create_deal_request",
        principalId, deadlineAt: expiresAt, materiality: "source scope only" }] });
    const value = ["72.15", "56.87", "94.31"][i];
    privateValues.push(value);
    const bytes = Buffer.from(JSON.stringify([{ id: "original-" + i, kind: "quantity", registrationId: "y4-target",
      factKey: "available_liquidity", value, currency: "USD", unit: "dollars", period: "2026-10",
      basis: "owner_asserted", occurredAt: now, availableAt: now }]));
    const sourceSystem = "Z0-Y4-disposable";
    const version = await db.withTenantTransaction(tenantId, { userId: principalId }, async transaction => {
      const document = await createDocument(transaction, { tenantId, kind: "source_export", title: "Participant original",
        provenance: { sourceSystem, externalId: randomUUID(), createdBy: principalId } });
      return appendDocumentVersion(transaction, { tenantId, documentId: document.documentId, bytes,
        mediaType: "application/json", format: "unknown", origin: "manual_upload", actor: principalId,
        sourceSystem, sourceRef: participantId, providerVersionId: "owner-revision-1" });
    });
    const grant = await ask(session, "institution-register-source", { workId: sourceWork.workId,
      documentId: version.document_id, documentVersionId: version.id, sourceClass: "financial_ledger",
      protocol: "json_records", purpose, expiresAt });
    const handle = await ask(session, "confidential-source-handle", { workId: sourceWork.workId, grantId: grant.id });
    const authority = await employeeAuthoritySnapshot({ tenantId, userId: principalId, employeeId: principalId, role: "owner" });
    participants.push({ id: participantId, institutionId, authorityRef: { owner: "S1", id: principalId,
      version: String(authority.revision), contentDigest: sha({ tenantId, principalId, revision: authority.revision }) } });
    inputs.push({ key: ["a", "b", "c"][i], participantId, semantics, lower: "-100", upper: "100", decimalPlaces: 2,
      sourceRef: handle.sourceRef, grantRef: handle.grantRef, validationRef: ref("BUSINESS_OWNER", "validation-" + i),
      primaryEvidenceRef: null, sourceStatus: "OWNER_ASSERTED", freshUntil: deadlineAt, rounding: "EXACT_OR_REJECT" });
  }

  const definition = { schema: "finnor.confidential-function.v1", functionRef: ref("P1", randomUUID()),
    baselineManifestRef: ref("P1", "native-original-query"), objectiveRef: ref("S4", "liquidity-observation"),
    mandateRef: ref("S6", "disposable-analytical-terms"), jointSemanticsRef: ref("P1", "joint-terms"),
    purpose, participants, inputs, outputs: [{ key: "joint_liquidity", semantics, recipients: ["p0"],
      expression: { kind: "subtract", left: { kind: "add", left: { kind: "input", key: "a" },
        right: { kind: "input", key: "b" } }, right: { kind: "input", key: "c" } } }],
    release: { familyId: randomUUID(), policyRef: ref("S1", "one-source-use"),
      termsRef: ref("S6", "metadata-observation-only"), maxDistinctFunctions: 1 } };
  const limits = { deadlineAt, maxAttempts: 2, maxCpuSeconds: 60, maxMemoryBytes: 1024 ** 3, maxRetainedBytes: 16 * 1024 * 1024 };
  const intake = await ask(owner, "confidential-intake", { schema: "finnor.y4.intake.v1", root,
    function: definition, limits, idempotencyKey: randomUUID() });
  const { workId, workInputId } = intake;
  const planned = await ask(owner, "confidential-plan", { schema: "finnor.y4.plan.v1", root,
    workId, workInputId, function: definition, limits });
  worker = await startOwnedWorker(env, { logPath: join(state, "z0-confidential-worker.private.log") });
  const submitted = await ask(owner, "confidential-submit", { schema: "finnor.y4.submit.v1", root, workId,
    workInputId, function: { ...definition, workRevisionRef: planned.workRevisionRef }, limits,
    idempotencyKey: randomUUID() }, 202);
  const ownerState = async () => (await q(
    "SELECT status,correspondence->>'status' checker,attempt_count FROM finnor_os.y4_computations WHERE tenant_id=$1 AND id=$2 AND work_id=$3 AND work_input_id=$4",
    [tenantId, submitted.computationId, workId, workInputId]))[0];
  const end = Date.now() + 120000;
  let compiled = await ownerState();
  while (["QUEUED", "COMPILING"].includes(compiled?.status) && Date.now() < end) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    compiled = await ownerState();
  }
  ensure(compiled?.status === "AWAITING_PARTICIPANTS" && compiled.checker === "CHECKED", "Z0_Y4_COMPUTATION_" + compiled?.status);
  const [job] = await q("SELECT j.status FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.job_id=j.id WHERE j.id=$1 AND j.tenant_id=$2 AND a.claim_fence=j.claim_fence",
    [submitted.jobId, tenantId]);
  ensure(job?.status === "completed" || job?.status === "running", "Z0_Y4_DURABLE_DELIVERY_NOT_OBSERVED");

  const cut = async () => (await q(
    "SELECT status,(SELECT count(*)::int FROM finnor_os.works WHERE tenant_id=$1) works,"
    + "(SELECT count(*)::int FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2) inputs "
    + "FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [tenantId, workId]))[0];
  const before = await cut();
  const query = { intent: "confidential_economic_computation_v1", workId, executionKey: randomUUID() };
  const reply = await owner.call("/api/queries", query);
  const nonrecipient = await sessions[1].call("/api/queries", { ...query, executionKey: randomUUID() });
  const rejected = await peer.call("/api/queries", { ...query, executionKey: randomUUID() });
  const result = reply.body?.result, data = result?.data;
  ensure(reply.status === 201, "Z0_Y4_QUERY_HTTP_" + reply.status);
  ensure(reply.body.workId === workId && reply.body.workInputId === workInputId
    && result.execution?.workId === workId && result.execution?.workInputId === workInputId,
  "Z0_Y4_QUERY_ORIGINAL_IDENTITY_REQUIRED");
  ensure(result.status === "partial" && data?.computationId === submitted.computationId && !data.recipientReleaseImported
    && !data.typedConsumerCurrent, "Z0_Y4_QUERY_CHECKED_METADATA_REQUIRED");
  const participantData = nonrecipient.body?.result?.data;
  ensure(nonrecipient.status === 201 && participantData?.computationId === submitted.computationId
    && !participantData.recipientReleaseImported && !participantData.typedConsumerCurrent,
  "Z0_Y4_QUERY_DECLARED_PARTICIPANT_METADATA_REQUIRED");
  ensure([403, 404].includes(rejected.status) && !JSON.stringify(rejected.body).includes(submitted.computationId),
    "Z0_Y4_QUERY_NONPARTICIPANT_HTTP_" + rejected.status);
  const wire = JSON.stringify([reply.body, nonrecipient.body]);
  ensure(!privateValues.some(value => wire.includes(value)) && !/openingNonce|private_cut|originalSha256/.test(wire),
    "Z0_Y4_QUERY_PRIVATE_DATA_VISIBLE");
  assert.deepEqual(await cut(), before, "Z0_Y4_QUERY_CHANGED_WORK");
  await save({ outcome: "PASS", detail: { status: reply.status, nativeStatus: compiled.status,
    ownerMetadataOnly: true, originalWorkUnchanged: true, nonparticipantStatus: rejected.status } });
} catch (error) {
  await save({ outcome: "FAIL", error: String(error?.message ?? error).slice(0, 500), errorCode: error?.code });
  process.exitCode = 1;
} finally {
  await worker?.stop();
  await sql.end();
  await db.closePool();
}

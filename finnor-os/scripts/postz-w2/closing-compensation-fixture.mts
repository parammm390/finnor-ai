/** W2 extension of the existing actual closing-owner campaign. Controlled
 * actors submit ordinary requests; only the independent provider/checker can
 * establish receiving settlement. No receipt or admission is seeded here. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { createEvidenceSource } from "@finnor/memory";
import { withTenantTransaction } from "@finnor/db";
import { readWorkforceCarvesTx } from "../../packages/private-equity/src/workforce-allocation";

export const compensationCases = ["exact", "wrong-amount", "wrong-payee", "wrong-receipt"] as const;
export type CompensationCase = (typeof compensationCases)[number];
type Fixture = {
  admin: PoolClient;
  f: any;
  request: (f: any, path: string, body?: unknown, actorId?: string) => Promise<any>;
  save: (path: string, body: unknown) => Promise<unknown>;
  startWorker: () => Promise<void>;
  stopWorker: () => Promise<void>;
};
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const ok = (r: any) => { assert(r.status >= 200 && r.status < 300, JSON.stringify(r)); return r.body; };

export async function prepareCompensationFixture(p: Fixture, selected: CompensationCase) {
  const { admin, f, request, save } = p;
  const workId = f.w2WorkId as string;
  const seller = f.actors.find((a: any) => a.kind === "seller").id as string;
  const other = f.actors.find((a: any) => a.kind === "registry-authority").id as string;
  const checker = f.actors.find((a: any) => a.kind === "receiving-authority").id as string;
  const payee = selected === "wrong-payee" ? other : seller;
  const value = selected === "wrong-amount" ? "3" : "2";
  const now = Date.now(), iso = (delta: number) => new Date(now + delta).toISOString();
  const reference = (owner: string, id: string) => ({ owner, id, version: "controlled-w2-closing-v1", contentDigest: hash(id) });
  // Establish the owner's original reported capacity before scientific pins.
  // W2 acceptance/evidence must not be appended after freezing the S3 source.
  const cash = ok(await request(f, "/api/allocations/resource", { resource: {
    schema: "finnor.allocation-resource.v1", resourceId: "cash", resourceClass: "CASH", tenantId: f.tenant,
    ownerRef: reference("BUSINESS_OWNER", f.principal), legalEntityRef: reference("S1", f.root.entityId),
    scopeRef: reference("BUSINESS_OWNER", f.name), permittedRoots: [f.root, { entityType: "work", entityId: workId }],
    rightsRef: "s5-owner-rights", unit: "USD", currency: "USD", kind: "STOCK", horizon: f.compensationHorizon,
    sourceRef: reference("BUSINESS_OWNER", "controlled-original-cash-capacity"),
    asOf: iso(0), knowledgeAt: iso(0), validUntil: iso(3600000), beliefPins: [],
    availability: [{ amount: "6", basis: "REPORTED_AVAILABLE" }, { amount: "6", basis: "REPORTED_AVAILABLE" }],
    existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false,
    qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED" } }));
  f.resources.push(cash);
  const expires = cash.validUntil as string;
  const { ref: _cashRef, revision: _revision, priorRef: _priorRef, ...cashBody } = cash;
  const compute = ok(await request(f, "/api/allocations/resource", { resource: { ...cashBody,
    resourceId: "w2-operations", resourceClass: "COMPUTE", unit: "workforce-operation", currency: null,
    kind: "CUMULATIVE_EXPENDITURE", sourceRef: reference("BUSINESS_OWNER", "controlled-w2-operation-capacity"),
    availability: [{ amount: "100", basis: "REPORTED_AVAILABLE" }, { amount: "100", basis: "REPORTED_AVAILABLE" }],
    existingUse: ["0", "0"] } }));
  f.resources.push(compute);
  const sourceIds: string[] = [];
  for (const [id, human] of [[f.principal, false], [seller, true], [other, true], [checker, false]] as const) {
    await admin.query(`INSERT INTO finnor_os.employee_actor_profiles(tenant_id,principal_id,actor_kind)
      VALUES($1,$2,$3) ON CONFLICT(tenant_id,principal_id) DO UPDATE SET actor_kind=EXCLUDED.actor_kind`,
    [f.tenant, id, human ? "HUMAN" : "SERVICE"]);
    const actor = { id, tenantId: f.tenant, identityRef: reference("identity", id),
      kind: human ? "INTERNAL_HUMAN" : "COMPUTATIONAL_CELL", status: "CURRENT",
      capabilities: [{ skill: "controlled-compensation-" + id, scope: "analysis",
        evidenceRef: reference("S1", "qualification-" + id), certainty: "OBSERVED", validUntil: expires }],
      availability: { kind: "OBSERVED", ref: reference("S1", "schedule-" + id), validUntil: expires,
        slots: [{ startAt: iso(-60000), endAt: expires, capacity: "1", committed: "0" }], maxConcurrent: 1,
        humanLimits: human ? { kind: "OBSERVED", maxEffortSeconds: "100", alreadyCommittedSeconds: "0",
          fatigue: "WITHIN_LIMIT", ref: reference("S1", "controlled-human-limits-" + id) } : { kind: "NOT_HUMAN" } } };
    const snapshot = { schema: "finnor.workforce-actor-evidence.v1", canonical: { kind: "USER", id, principalId: id },
      actor, qualification: "AUTHORIZED_SOURCE_ASSERTION_NOT_PROTECTED_QUALIFICATION" };
    const source = await createEvidenceSource(f.tenant, { sourceKey: "w2-closing-controlled-" + id,
      sourceType: "workforce_actor_evidence", title: "Controlled W2 actor, not genuine-human qualification" });
    await admin.query(`INSERT INTO finnor_os.evidence_source_versions
      (id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at)
      VALUES($1,$2,'tenant',$3,1,$4,$5,$6::jsonb,clock_timestamp(),clock_timestamp(),clock_timestamp())`,
    [randomUUID(), source.id, f.tenant, hash(JSON.stringify(snapshot)), JSON.stringify(snapshot), JSON.stringify(snapshot)]);
    sourceIds.push(source.id);
  }
  const envelope = { resourceId: cash.resourceId, unit: cash.unit, kind: cash.kind, horizon: cash.horizon,
    quantities: [value, "0"], minimumQuantities: ["0", "0"] };
  const operations = (amount: string) => ({ resourceId: compute.resourceId, unit: compute.unit,
    kind: compute.kind, horizon: compute.horizon, quantities: [amount, "0"], minimumQuantities: ["0", "0"] });
  const ceiling = { capabilities: ["query:work"], dataScopes: ["work:self"], purposes: ["controlled-compensation"],
    effects: [], validFrom: iso(-60000), validUntil: expires, allowSubdelegation: false };
  const original = { schema: "finnor.workforce-original-outcome.v1", sourceClass: "CONTROLLED_ACTOR_RECORDS",
    actorSourceIds: sourceIds, resources: { resourceRefs: [cash.ref, compute.ref],
      schedules: [{ resourceId: cash.resourceId, quantities: [value, "0"] }, { resourceId: compute.resourceId, quantities: ["12", "0"] }] },
    outcome: { deadline: expires, ceiling, resourceLimits: [envelope, operations("12")],
      criteria: [{ id: "compensated-output", checkerActorId: checker, evidenceCustodianActorId: checker,
        acceptance: { kind: "EXACT_JSON", expected: "42" } }],
      tasks: [{ id: "compensated-task", parentTaskId: null, dependsOn: [], returnTo: [], delegatorActorId: f.principal,
        criterionId: "compensated-output", requiredCapabilities: [{ skill: "controlled-compensation-" + payee, scope: "analysis" }],
        allowedActorKinds: ["INTERNAL_HUMAN"], assignmentMode: "INTERNAL_AUTHORIZED", ceiling,
        terms: { revision: 1, deliverable: "Controlled exact literal output, not genuine labor",
          compensation: { value, unit: "USD" }, subdelegation: false, expiresAt: expires },
        dueAt: expires, slot: { startAt: iso(-60000), endAt: expires }, effortSeconds: "1", demand: [envelope, operations("1")],
        context: { dataScopes: ["work:self"], purposes: ["controlled-compensation"], includesCredentials: false }, effectId: null }] },
    operations: [{ taskId: "compensated-task", computation: { kind: "PARTICIPANT_INPUT", prompt: "Return literal 42 through the actual participant action." } }] };
  const submitted = ok(await request(f, "/api/workforce/execution-programs/intake",
    { workId, idempotencyKey: randomUUID(), original }));
  const path = "/api/workforce/execution-programs/" + submitted.id;
  await p.startWorker();
  let q: any;
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    q = ok(await request(f, path));
    if (q.program?.assignments?.length === 1) break;
    await new Promise<void>(done => setTimeout(done, 100));
  }
  assert.equal(q.program?.assignments?.length, 1, "Actual W2 claimed compiler did not offer the original task");
  await p.stopWorker();
  const act = async (action: string, actorId: string, extra: object = {}) => {
    q = ok(await request(f, path));
    const a = q.program.assignments[0];
    return ok(await request(f, path + "/actions", { action, idempotencyKey: "w2-closing-" + action,
      expectedRevision: q.revision, assignmentId: a.id, termsDigest: a.termsDigest, termsRevision: a.terms.revision, ...extra }, actorId));
  };
  await act("ACCEPT", payee);
  q = ok(await request(f, path));
  assert.equal(q.compensation.records.length, 1);
  assert.equal(q.compensation.observations[0].status, "OPEN");
  const obligation = q.compensation.records[0];
  await act("START", payee);
  await act("DELIVER", payee, { value: "42" });
  const binding = { schema: "finnor.s6.closing-workforce-compensation.v1",
    obligationRef: obligation.ref, programmeId: obligation.programmeId, workId: obligation.workId,
    originalRoot: obligation.rootId, assignmentId: obligation.assignmentId,
    originalBudget: obligation.originalBudget, originalReservation: obligation.originalReservation,
    termsDigest: obligation.termsDigest, payerPrincipalId: f.principal, payeePrincipalId: seller };
  if (selected === "wrong-receipt") binding.originalReservation = reference("S5", "another-original-reservation");
  await save(f.name + "/w2-original-obligation.json", { selected, original, submitted, obligation, binding,
    expectedAmountUsd: value, financialOwnerAmountUsd: "2", realPayment: false, genuineHumanQualified: false });
  return { path, obligation, binding, selected, acceptedBytes: JSON.stringify(obligation) };
}

export async function compensationReadback(p: Pick<Fixture, "f" | "request">) {
  const q = ok(await p.request(p.f, p.f.compensationFixture.path));
  return q.compensation;
}

export async function compensationFunding(p: Pick<Fixture, "f">) {
  const f = p.f;
  return withTenantTransaction(f.tenant, { userId: f.principal }, async (_db, c) => {
    const row = (await c.query("SELECT budget FROM finnor_os.w2_programs WHERE tenant_id=$1 AND id=$2",
      [f.tenant, f.compensationFixture.obligation.programmeId])).rows[0];
    return readWorkforceCarvesTx(f.ctx, c, row.budget);
  });
}

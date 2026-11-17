/** Small actual W2 native assignment on the shared business root. The input
 * carries a literal W1 accepted value, not an invented capsule-provenance field. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { attachWorkEntity, transactionDb, withTenantTransaction } from "@finnor/db";
import { createEvidenceSourceTx, appendEvidenceVersionTx } from "@finnor/memory";
import { nativeWorkforceOriginalSchema } from "../../../packages/orchestration/src/workforce-execution/contracts";
import { workforceActorSchema, workforceExecutionProgramSchema } from "../../../packages/workforce/src/execution-program/schema";
import { reference } from "../../../packages/orchestration/src/workforce-execution/store";
import type { IntegratedOwnerPorts, NativeJourneyOutput } from "./owner-journey.mts";

export async function runWorkforceOwner(ports: IntegratedOwnerPorts, upstream: NativeJourneyOutput,
  executor: string, workId: string): Promise<NativeJourneyOutput> {
  ports.checkBound();
  assert.equal(upstream.engine, "W1"); assert.equal(upstream.companyId, ports.companyId);
  const acceptedValue = (await ports.admin.query(`SELECT h.body->'result'->'values'->'netEquity'->>'value' value
    FROM finnor_os.p1_requests p JOIN finnor_os.p1_programs h
      ON h.tenant_id=p.tenant_id AND h.principal_id=p.principal_id AND h.id=p.head_id
    JOIN finnor_os.p2_requests s
      ON s.tenant_id=p.tenant_id AND s.principal_id=p.principal_id AND s.program_id=p.id
    WHERE s.tenant_id=$1 AND s.principal_id=$2 AND s.id=$3 AND p.status='TESTED'`,
    [ports.tenant, ports.owner, upstream.requestId])).rows[0]?.value;
  assert.equal(acceptedValue, "43", "W2_MUST_RECEIVE_ACTUAL_ACCEPTED_W1_PARENT_VALUE");
  const key = "integrated-workforce-" + workId, now = Date.now();
  const iso = (offset: number) => new Date(now + offset).toISOString(), expires = iso(3600000);
  const ref = (owner: string, id: string) => ({ owner, id, version: "controlled-source-v1",
    contentDigest: createHash("sha256").update(id).digest("hex") });
  const bridge = { kind: "ACCEPTED_VALUE_SUPPLIED_AS_LITERAL_ORIGINAL_INPUT", upstream: upstream.ref,
    value: acceptedValue, nativeCapsuleProvenanceVerified: false,
    limitation: "The strict W2 original has no capsule/output-reference input; no new field or native provenance claim is invented." };
  await ports.artifact("integrated/w2/original.json", {
    companyId: ports.companyId, workId, executor, bridge, operation: { kind: "SUM_INTEGERS", values: ["43", "-1"] },
    expected: { independentlyVerifiedValue: "42", assignments: 1, originalWorkStatus: "completed",
      s6Intentions: 1, s6Observations: 1, reconciledConsumptions: 2, completeMonetaryCost: null },
    sourceClass: "CONTROLLED_ACTOR_RECORDS", genuineHumanConsentEstablished: false,
  });
  for (const principal of [ports.owner, executor]) {
    const profile = (await ports.admin.query(`SELECT actor_kind FROM finnor_os.employee_actor_profiles
      WHERE tenant_id=$1 AND principal_id=$2`, [ports.tenant, principal])).rows[0];
    assert.equal(profile?.actor_kind, "SERVICE", "CONTROLLED_SERVICE_PROFILE_CANNOT_REWRITE_A_HUMAN_PROFILE");
  }
  const standingGrants = (await ports.admin.query(`SELECT DISTINCT g.capability,a.resource_scope
    FROM finnor_os.employee_role_assignments a JOIN finnor_os.employee_roles r
      ON r.tenant_id=a.tenant_id AND r.id=a.role_id AND r.active
    JOIN finnor_os.role_authority_grants g ON g.tenant_id=a.tenant_id AND g.role_id=a.role_id
    WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.active AND a.effective_from<=clock_timestamp()
      AND (a.expires_at IS NULL OR a.expires_at>clock_timestamp())
      AND g.resource_type='*' AND g.effect='allow' AND g.max_risk='low'`, [ports.tenant, executor])).rows;
  assert.deepEqual([...new Set(standingGrants.map(row => row.capability))].sort(),
    ["query:work", "action:workforce_assign_contract", "action:workforce_respond_contract"].sort(),
  "W2_EXISTING_CONTROLLED_WORKFORCE_AUTHORITY_MUST_PRECEDE_NATIVE_OWNER_PINS");
  assert.deepEqual(standingGrants.filter(row => row.capability === "query:work").map(row => row.resource_scope),
    [{ kind: "resources", resourceType: "work", resourceIds: [workId] }],
  "W2_STANDING_READ_MUST_RETAIN_ITS_EXACT_PREDECLARED_WORK_SCOPE");
  const sourceIds: string[] = [];
  for (const principal of [ports.owner, executor]) {
    const actor = workforceActorSchema.parse({ id: principal, tenantId: ports.tenant,
      identityRef: ref("identity", principal), kind: principal === ports.owner ? "COMPUTATIONAL_CELL" : "DETERMINISTIC_SERVICE",
      status: "CURRENT", capabilities: [{ skill: principal === ports.owner ? "root-analysis" : "compute", scope: "analysis",
        evidenceRef: ref("S1", "qualification:" + principal), certainty: "OBSERVED", validUntil: expires }],
      availability: { kind: "OBSERVED", ref: ref("S1", "schedule:" + principal), validUntil: expires,
        slots: [{ startAt: iso(-60000), endAt: expires, capacity: "1", committed: "0" }],
        maxConcurrent: 1, humanLimits: { kind: "NOT_HUMAN" } } });
    const snapshot = { schema: "finnor.workforce-actor-evidence.v1",
      canonical: { kind: "USER", id: principal, principalId: principal }, actor,
      qualification: "AUTHORIZED_SOURCE_ASSERTION_NOT_PROTECTED_QUALIFICATION" };
    const source = await withTenantTransaction(ports.tenant, { userId: ports.owner }, async (_db, client) => {
      const db = transactionDb(client), created = await createEvidenceSourceTx(db, ports.tenant, {
        sourceKey: key + ":" + principal, sourceType: "workforce_actor_evidence",
        title: "Controlled service capability and availability, not human qualification" });
      await appendEvidenceVersionTx(db, ports.tenant, created.id, { content: JSON.stringify(snapshot), snapshot });
      return created;
    });
    sourceIds.push(source.id);
  }
  const revision = String((await ports.admin.query("SELECT revision FROM finnor_os.authority_states WHERE tenant_id=$1",
    [ports.tenant])).rows[0].revision);
  const horizon = { startAt: iso(-60000), periodMs: 3600000, periods: 1 };
  const resourceResponse = await ports.http("allocations", "resource", { resource: {
    schema: "finnor.allocation-resource.v1", resourceId: key, resourceClass: "COMPUTE", tenantId: ports.tenant,
    ownerRef: ref("BUSINESS_OWNER", ports.owner), legalEntityRef: ref("S1", ports.companyId),
    scopeRef: ref("BUSINESS_OWNER", key), permittedRoots: [{ entityType: "work", entityId: workId }],
    rightsRef: `authority:${ports.tenant}:${revision}`, unit: "workforce-operation", currency: null,
    kind: "CUMULATIVE_EXPENDITURE", horizon, sourceRef: ref("BUSINESS_OWNER", "controlled-compute-capacity:" + key),
    asOf: iso(0), knowledgeAt: iso(0), validUntil: expires, beliefPins: [],
    availability: [{ amount: "100", basis: "REPORTED_AVAILABLE" }, { amount: "100", basis: "REPORTED_AVAILABLE" }],
    existingUse: ["0", "0"], safetyMargin: "0", covenants: [], revoked: false,
    qualification: "AUTHENTICATED_OWNER_ASSERTION_UNADMITTED",
  } }, ports.owner);
  assert.equal(resourceResponse.status, 200, JSON.stringify(resourceResponse));
  const resource = resourceResponse.body;
  const envelope = (amount: string) => ({ resourceId: resource.resourceId, unit: resource.unit, kind: resource.kind,
    horizon, quantities: [amount, "0"], minimumQuantities: ["0", "0"] });
  const ceiling = { capabilities: ["query:work"], dataScopes: ["work:self"], purposes: ["controlled-analysis"],
    effects: [], validFrom: iso(-60000), validUntil: expires, allowSubdelegation: true };
  const original = nativeWorkforceOriginalSchema.parse({
    schema: "finnor.workforce-original-outcome.v1", sourceClass: "CONTROLLED_ACTOR_RECORDS", actorSourceIds: sourceIds,
    resources: { resourceRefs: [resource.ref], schedules: [{ resourceId: resource.resourceId, quantities: ["12", "0"] }] },
    outcome: { deadline: expires, ceiling, resourceLimits: [envelope("12")], criteria: [{
      id: "independent-value", checkerActorId: ports.owner, evidenceCustodianActorId: ports.owner,
      acceptance: { kind: "EXACT_JSON", expected: "42" },
    }], tasks: [{ id: "reconcile-accepted-company-value", parentTaskId: null, dependsOn: [], returnTo: [],
      delegatorActorId: ports.owner, criterionId: "independent-value",
      requiredCapabilities: [{ skill: "compute", scope: "analysis" }], allowedActorKinds: ["DETERMINISTIC_SERVICE"],
      assignmentMode: "INTERNAL_AUTHORIZED", ceiling,
      terms: { revision: 1, deliverable: "Reconcile the supplied accepted company value against the original one-unit adjustment",
        compensation: { value: "0", unit: "USD" }, subdelegation: true, expiresAt: expires },
      dueAt: expires, slot: { startAt: iso(-60000), endAt: expires }, effortSeconds: "1", demand: [envelope("1")],
      context: { dataScopes: ["work:self"], purposes: ["controlled-analysis"], includesCredentials: false }, effectId: null,
    }] }, operations: [{ taskId: "reconcile-accepted-company-value",
      computation: { kind: "SUM_INTEGERS", values: [acceptedValue, "-1"] } }],
  });
  await ports.artifact("integrated/w2/original-native-intake.json", { workId, idempotencyKey: key, original, bridge });
  const intake = await ports.http("workforce", "execution-programs/intake", { workId, idempotencyKey: key, original }, ports.owner);
  assert.equal(intake.status, 202, JSON.stringify(intake));
  await attachWorkEntity(ports.tenant, workId, { entityType: "external_organization", entityId: ports.companyId,
    relationship: "about", source: "controlled-integrated-native-owner" });
  const id = intake.body.id as string, began = performance.now();
  let current: any = null;
  for (let decision = 0; decision < 128; decision++) {
    ports.checkBound();
    assert(performance.now() - began < 600000, "W2_ORIGINAL_FULL_COMPILATION_OBSERVER_BOUND");
    const response = await ports.http("workforce", "execution-programs/" + id, undefined, ports.owner);
    assert.equal(response.status, 200, JSON.stringify(response)); current = response.body;
    if (current.status === "CLOSED") break;
    assert(!["BLOCKED", "FENCED", "FAILED", "CANCELLED", "INVALIDATED"].includes(current.status),
      "W2_NATIVE_ORIGINAL_OWNER_REFUSED:" + JSON.stringify(current));
    await ports.tick(16);
  }
  assert(performance.now() - began < 600000, "W2_TERMINAL_STATUS_AFTER_ORIGINAL_OBSERVER_BOUND");
  assert.equal(current?.status, "CLOSED"); assert.equal(current.currentCheck.valid, true);
  const program = workforceExecutionProgramSchema.parse(current.program);
  assert.equal(program.assignments.length, 1); assert.equal(program.assignments[0]!.state.kind, "CLOSED");
  const events = (await ports.admin.query(`SELECT kind,body,event_id FROM finnor_os.w2_events
    WHERE tenant_id=$1 AND program_id=$2 ORDER BY created_at,event_id`, [ports.tenant, id])).rows;
  const intents = events.filter(row => row.kind === "S6_INTENDED"), observations = events.filter(row => row.kind === "S6_OBSERVATION");
  assert.equal(intents.length, 1); assert.equal(observations.length, 1);
  assert.equal(observations[0].body.value, "42");
  assert.equal(observations[0].body.assignmentId, program.assignments[0]!.id);
  const consumptions = (await ports.admin.query(`SELECT co.body,st.status FROM finnor_os.s5_consumptions co
    JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
    WHERE co.tenant_id=$1 AND co.body->>'programmeId'=$2`, [ports.tenant, id])).rows;
  assert.equal(consumptions.length, 2); assert(consumptions.every(row => row.status === "RECONCILED"));
  const economics = (await ports.admin.query(`SELECT body FROM finnor_os.s7_economic_records
    WHERE tenant_id=$1 AND body->'payload'->>'programmeId'=$2`, [ports.tenant, id])).rows;
  assert(economics.some(row => row.body.payload.phase === "COMPILE"));
  assert(economics.some(row => row.body.payload.phase === "S6"));
  const row = (await ports.admin.query(`SELECT q.*,w.status work_status FROM finnor_os.w2_programs q
    JOIN finnor_os.works w ON w.tenant_id=q.tenant_id AND w.id=q.work_id
    WHERE q.tenant_id=$1 AND q.id=$2 AND q.principal_id=$3`, [ports.tenant, id, ports.owner])).rows[0];
  assert.equal(row.work_id, workId); assert.equal(row.work_status, "completed");
  const foreign = await ports.http("workforce", "execution-programs/" + id, undefined, ports.foreign);
  assert.equal(foreign.status, 404);
  const result: NativeJourneyOutput = {
    engine: "W2", schema: program.schema, tenantId: ports.tenant, principalId: ports.owner, companyId: ports.companyId,
    workId, workInputId: row.work_input_id, requestId: id, ref: reference("W2", id, program, "workforce-execution-program-v1"),
    consumedBy: { owner: "NATIVE_WORKFORCE_RUNTIME", assignmentId: program.assignments[0]!.id,
      s6Intentions: intents, s6Observations: observations, independentCheck: current.currentCheck },
    evidence: { original, bridge, program, consumptions, economics, sourceIds,
      originalDeadline: expires, completeMonetaryCost: null, completeChildUsage: null,
      actualHumanConsentEstablished: false, independentProtectedCustody: false },
  };
  await ports.artifact("integrated/w2/private-native-output.json", result);
  return result;
}

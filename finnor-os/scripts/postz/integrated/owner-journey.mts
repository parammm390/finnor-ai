/** Combined owning-boundary fixture. These are controlled original inputs,
 * never fabricated grants, fitted responses, participant consent or receipts. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";
import { receiveWork } from "@finnor/db";
import { prepareNativeOwnerFixture } from "../../postz-w1/native-stories.mjs";
import { submitInternalSearch } from "../../postz-w1/native-internal-support.mjs";
import { driveNativeProgram } from "../../postz-w1/native-drive.mjs";
import { observeNativeRun } from "../../postz-w1/native-observe.mjs";
import { nativeCapsuleSchema } from "../../../packages/private-equity/src/economic-orchestration/contracts";
import type { SharedAllocationFixture, SharedCapacityBasis } from "./allocation-fixture.mts";
export { INTEGRATED_PROFILE } from "./profile.mts";

export interface IntegratedOwnerPorts {
  admin: pg.Client; repo: string; output: string;
  tenant: string; owner: string; foreign: string;
  companyId: string; serviceWorkId: string; serviceWorkInputId: string;
  http(group: string, operation: string, body: unknown, actor?: string | null): Promise<{ status: number; body: any }>;
  tick(maximumTicks: number): Promise<{
    pid: number; observations: Array<{ pid: number; role: unknown; registration: string; worked: boolean }>;
  }>;
  artifact(name: string, body: unknown): Promise<unknown>;
  checkBound(): void;
}

export interface NativeJourneyOutput {
  engine: "W1" | "W2" | "W3" | "W4" | "W5";
  schema: string; tenantId: string; principalId: string; companyId: string;
  workId: string; workInputId: string; requestId: string;
  ref: { owner: string; id: string; version: string; contentDigest: string };
  consumedBy: unknown; evidence: unknown;
}

/** Reuses W1's actual S1/S3/S4/S5/P1/P2 setup on the canonical business root.
 * The independent arithmetic expectations are literal original inputs, not
 * values obtained from the producer or its checker. */
export async function runOrchestrationOwner(ports: IntegratedOwnerPorts,
  sharedAllocation: SharedAllocationFixture & { outcomeSeriesId: string; capacity: SharedCapacityBasis }): Promise<NativeJourneyOutput> {
  ports.checkBound();
  const root = { entityType: "external_organization" as const, entityId: ports.companyId };
  const existingOwner = { tenant: ports.tenant, principal: ports.owner, root };
  const destination = join(ports.output, "integrated", "w1");
  await mkdir(destination, { recursive: true });
  const expected = { netEquity: "43", leverage: "3.5", originalEpisodeRetained: true,
    originalGrantRetained: true, checkedCapsuleActuallyConsumed: true, completeMonetaryCost: null };
  await ports.artifact("integrated/w1/original.json", {
    company: existingOwner, originalServiceWorkId: ports.serviceWorkId,
    originalServiceWorkInputId: ports.serviceWorkInputId, values: { EV: "120", debt: "70", liability: "7", EBITDA: "20" },
    expected, qualification: "AUTHENTICATED_CONTROLLED_INPUTS_NOT_PRIVATE_FIELD_FACTS",
  });
  const periodStart = "2025-01-01T00:00:00.000Z", periodEnd = "2025-12-31T00:00:00.000Z";
  const input = (key: string) => ({ kind: "input", key });
  const request = () => ({
    schema: "finnor.harness-request.v1",
    instruction: `Produce a source-cited analytical draft of equity after debt and all recorded liabilities, with leverage, for the company operating original service Work ${ports.serviceWorkId}. No IC approval or external effect is requested.`,
    root, validAt: "2026-01-01T00:00:00.000Z", mode: "ordinary_disposable", idempotencyKey: randomUUID(),
    sources: ["EV", "debt", "EBITDA", "liability"].map(key => ({ key, source: {
      kind: "metric", subject: root, metricKey: key, periodStart, periodEnd, unit: "currency", currencyCode: "USD",
      frequency: "annual", calendar: "OWNER_RECORDED", consolidation: "OWNER_SUBJECT_ONLY",
      instrument: "UNSPECIFIED", scale: "1", sign: "AS_RECORDED",
    } })),
    acceptance: { requiredSourceKeys: ["EV", "debt", "EBITDA", "liability"], targets: [
      { key: "netEquity", expression: { kind: "subtract", left: { kind: "subtract", left: input("EV"), right: input("debt") },
        right: input("liability") }, unit: "currency", currencyCode: "USD" },
      { key: "leverage", expression: { kind: "ratio", left: input("debt"), right: input("EBITDA") },
        unit: "multiple", currencyCode: null },
    ], deliverable: { kind: "analytical_draft", title: "Original company liability-complete analytical draft" } },
  });
  let lastWorker: Awaited<ReturnType<IntegratedOwnerPorts["tick"]>> | null = null;
  const queue = {
    async tick(signal?: AbortSignal) {
      signal?.throwIfAborted(); ports.checkBound();
      lastWorker = await ports.tick(16);
      signal?.throwIfAborted(); ports.checkBound();
      return lastWorker.observations.some(row => row.worked);
    },
    registeredTypes: () => ["run_harness_program_v1", "run_evidence_derivation_v1", "run_compute_search_unit_v1"],
  };
  const api = (operation: string, body: unknown, identity = { tenant: ports.tenant, actor: ports.owner }) => {
    assert.equal(identity.tenant, ports.tenant); assert.equal(identity.actor, ports.owner);
    return ports.http("company-brain", operation, body, ports.owner);
  };
  // Preparation also needs a physical worker claim. The parent owns the app database role.
  const e = { admin: ports.admin, repo: ports.repo, evidence: destination, request, periodStart, periodEnd,
    queue, preparationQueue: queue, api,
    ownerApi: (operation: string, body: unknown, identity: { tenant: string; actor: string }) => {
      assert.equal(identity.tenant, ports.tenant); assert.equal(identity.actor, ports.owner);
      const group = operation === "fit" ? "interventions" : operation === "synthesize" ? "policies" : "allocations";
      return ports.http(group, operation, body, ports.owner);
    } };
  const fixture = await prepareNativeOwnerFixture(e, { existingOwner, sharedAllocation, beforeFit: async owner => {
    assert.equal(owner.tenant, ports.tenant); assert.equal(owner.principal, ports.owner);
    assert.deepEqual(owner.root, root, "W049_ACTUAL_COMPANY_NOT_FIXTURE_LABEL_REQUIRED");
  } });
  console.log(JSON.stringify({ event: "PHASE_W_W1_STAGE", stage: "ORIGINAL_PREPARED" }));
  const http = { call: (operation: string, body: unknown) => api(operation, body) };
  const verifyProgram = async (programId: string, searchId: string, stage: "WARM" | "FOLLOW_UP") => {
    const began = performance.now();
    try {
      const status = await driveNativeProgram(ports.admin, queue, programId, began);
      assert.equal(status, "TESTED");
      console.log(JSON.stringify({ event: "PHASE_W_W1_STAGE", stage, status, elapsedMs: Math.round(performance.now() - began) }));
    } catch (error) {
      const failure = (await ports.admin.query(`SELECT p.status,p.failure,s.status search_status,s.reason search_reason,
          q.status derivation_status, d.body->'failure' AS derivation_failure,
          (SELECT jsonb_agg(job) FROM (
            SELECT j.type,j.status,j.attempts,j.run_at,j.last_error,a.outcome,a.failure_kind,a.failure_detail
            FROM finnor_os.jobs j LEFT JOIN finnor_os.job_delivery_attempts a
              ON a.job_id=j.id AND a.claim_fence=j.claim_fence
            WHERE j.tenant_id=p.tenant_id AND (j.payload->>'programId'=p.id::text
              OR j.payload->>'searchId'=s.id::text OR j.payload->>'queryId'=q.id::text)
            ORDER BY j.run_at,j.id LIMIT 32
          ) job) AS jobs,
          (SELECT jsonb_agg(attempt) FROM (
            SELECT u.kind,a.status,a.body->>'predicate' AS predicate,a.body->>'physicalOutcome' AS physical_outcome
            FROM finnor_os.p2_attempts a JOIN finnor_os.p2_units u ON u.id=a.unit_id
              AND u.tenant_id=a.tenant_id AND u.principal_id=a.principal_id AND u.search_id=a.search_id
            WHERE a.tenant_id=p.tenant_id AND a.principal_id=p.principal_id AND a.search_id=s.id
            ORDER BY a.created_at,a.id LIMIT 32
          ) attempt) AS attempts
        FROM finnor_os.p1_requests p LEFT JOIN finnor_os.p2_requests s
          ON s.tenant_id=p.tenant_id AND s.principal_id=p.principal_id AND s.program_id=p.id AND s.id=$4
        LEFT JOIN finnor_os.p4_queries q
          ON q.tenant_id=p.tenant_id AND q.principal_id=p.principal_id AND q.id=p.evidence_query_id
        LEFT JOIN finnor_os.p4_derivations d
          ON d.tenant_id=q.tenant_id AND d.principal_id=q.principal_id AND d.id=q.derivation_id
        WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.id=$3`,
      [ports.tenant, ports.owner, programId, searchId])).rows[0];
      await ports.artifact(`integrated/w1/program-failure-${programId}.json`, { ...failure,
        driverError: error instanceof Error ? error.message : String(error) });
      const finite = (value: unknown) => typeof value === "string" && /^[A-Z][A-Z0-9_]{2,100}$/.test(value) ? value : null;
      console.error(JSON.stringify({ event: "PHASE_W_W1_STAGE", stage, status: "FAIL",
        elapsedMs: Math.round(performance.now() - began), programme: finite(failure?.status),
        search: finite(failure?.search_status), sourceDerivation: finite(failure?.derivation_status),
        predicate: finite(error instanceof Error ? error.message : null),
        deadline: error instanceof Error && (error.name === "TimeoutError" ||
          error.message === "Finite native episode driver deadline") }));
      throw error;
    }
  };
  const anonymous = await ports.http("company-brain", "economic-orchestration-projection",
    { root, workId: fixture.p.workId }, null);
  assert.equal(anonymous.status, 401);
  const warmSearchId = await submitInternalSearch(http, fixture);
  await verifyProgram(fixture.p.programId, warmSearchId, "WARM");
  const episode = async (id: string) => (await ports.admin.query(`SELECT e.* FROM finnor_os.p1_episodes e
    JOIN finnor_os.p1_requests p ON p.tenant_id=e.tenant_id AND p.principal_id=e.principal_id AND p.episode_id=e.id
    WHERE p.id=$1 AND p.tenant_id=$2 AND p.principal_id=$3`, [id, ports.tenant, ports.owner])).rows[0];
  const before = await episode(fixture.p.programId);
  const responses = (await ports.admin.query(`SELECT digest FROM finnor_os.w1_response_states
    WHERE tenant_id=$1 AND principal_id=$2`, [ports.tenant, ports.owner])).rows;
  assert(responses.length, "W1_REAL_WARM_OBSERVATIONS_REQUIRED_NOT_SUPPLIED_RESPONSE");
  const followUp = await receiveWork({ tenantId: ports.tenant, userId: ports.owner, workId: fixture.p.workId,
    instruction: fixture.request.instruction, channel: "console", idempotencyKey: randomUUID() });
  assert.equal(followUp.workId, fixture.p.workId); assert.equal(followUp.created, false);
  assert.notEqual(followUp.workInputId, fixture.request.workInputId);
  const accepted = await api("program-submit", { ...fixture.request, workInputId: followUp.workInputId,
    idempotencyKey: randomUUID() });
  assert.equal(accepted.status, 202, JSON.stringify(accepted));
  const programId = accepted.body.programId as string, searchId = await submitInternalSearch(http, fixture, programId);
  await verifyProgram(programId, searchId, "FOLLOW_UP");
  const after = await episode(programId);
  assert.equal(after.id, before.id); assert.equal(String(after.deadline_at), String(before.deadline_at));
  for (const key of ["max_attempts", "max_steps", "max_candidates"]) assert.equal(after[key], before[key]);
  assert(after.attempts_used > before.attempts_used && after.attempts_used <= after.max_attempts);
  const program = await api("program-read", { programId });
  assert.equal(program.status, 200); assert.equal(program.body.status, "TESTED");
  assert.equal(program.body.program.result.values.netEquity.value, expected.netEquity);
  assert.equal(program.body.program.result.values.leverage.value, expected.leverage);
  const foreign = await ports.http("company-brain", "economic-orchestration-read", { searchId }, ports.foreign);
  assert.equal(foreign.status, 404);
  const capsuleRows = (await ports.admin.query(`SELECT c.id,c.body,c.digest,e.id consumer_event_id,
    e.body consumer_body,e.digest consumer_digest,to_jsonb(j) job,to_jsonb(d) delivery
    FROM finnor_os.w1_capsules c JOIN finnor_os.p2_events e
      ON e.tenant_id=c.tenant_id AND e.principal_id=c.principal_id AND e.search_id=c.search_id
      AND e.kind='W1_NEXT_COMPUTATION_APPLIED' AND e.body->>'capsuleDigest'=c.digest
    JOIN finnor_os.jobs j ON j.tenant_id=c.tenant_id AND j.id=(c.body->'execution'->>'jobId')::uuid
    JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id AND d.id=(c.body->'execution'->>'deliveryAttemptId')::uuid
    WHERE c.tenant_id=$1 AND c.principal_id=$2 AND c.search_id=$3
      AND c.body->'proposal'->>'status'='CHECKED_POLICY' ORDER BY c.revision,e.created_at,e.id`,
    [ports.tenant, ports.owner, searchId])).rows;
  assert(capsuleRows.length, "W049_ACTUAL_CHECKED_W1_CAPSULE_AND_P2_CONSUMPTION_REQUIRED");
  const original = (await ports.admin.query(`SELECT request FROM finnor_os.p1_requests
    WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`, [ports.tenant, ports.owner, programId])).rows[0];
  assert.deepEqual(original.request.root, root);
  const row = capsuleRows[0], capsule = nativeCapsuleSchema.parse(row.body);
  assert.equal(capsule.execution.originalEpisode, before.id);
  assert.equal(row.job.claim_fence, capsule.execution.claimFence);
  assert.equal(row.delivery.id, capsule.execution.deliveryAttemptId);
  const oracle = await observeNativeRun(ports.admin, { fixture: "P1_LIABILITY_ARITHMETIC",
    tenantId: ports.tenant, principalId: ports.owner, programId }, searchId, program.body.program,
    { bypass: false, anonymousStatus: anonymous.status, foreignStatus: foreign.status }, destination);
  const result: NativeJourneyOutput = {
    engine: "W1", schema: capsule.schema, tenantId: ports.tenant, principalId: ports.owner, companyId: ports.companyId,
    workId: fixture.p.workId, workInputId: followUp.workInputId, requestId: searchId,
    ref: { owner: "W1", id: capsule.id, version: capsule.version, contentDigest: row.digest },
    consumedBy: { owner: "P2", eventId: row.consumer_event_id, eventDigest: row.consumer_digest,
      event: row.consumer_body, job: row.job, delivery: row.delivery },
    evidence: { expected, oracle, before, after, originalGrant: fixture.search.computeGrant,
      warmSearchId, measuredResponseDigests: responses, originalSourceAndAcceptanceUnchanged: true,
      setupAuth: "ACTUAL_SIGNED_BEARER_AUTH_DEV_BYPASS_0", worker: lastWorker,
      completeMonetaryCost: null, completeChildUsage: null, independentProtectedCustody: false },
  };
  await ports.artifact("integrated/w1/private-native-output.json", result);
  return result;
}

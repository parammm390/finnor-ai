/** Real sibling Works, original queue/resource occupation and P7 closure.
 * The controller delays only original read bytes and kills owned workers. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import type pg from "pg";
import { receiveWork } from "@finnor/db";
import type { ApplicationState, CheckedApplicationComposition } from "@finnor/shared-types";
import type { PeMutationContext } from "../../packages/private-equity/src/types";
import { applicationArtifact, applicationSession, type ApplicationSessionRow } from "../../packages/private-equity/src/application-semantics/store";
import { invalidateApplicationOperation } from "../../packages/private-equity/src/application-semantics/validity";
import type { nativeReadRelay } from "./native-review-gates.mts";

const pause = (ms: number) => new Promise<void>(yes => setTimeout(yes, ms));
export async function runNativeSiblingGates(input: {
  ctx: PeMutationContext; sql: pg.Client; originalSessionId: string; firstWorkId: string; firstSessionId: string;
  targetId: string; recordPath: string; goal: ApplicationState; parameters: ApplicationState;
  relay: Awaited<ReturnType<typeof nativeReadRelay>>;
  createWork(instruction: string): Promise<string>;
  execute(workId: string, goal: ApplicationState): Promise<{ status: number; body: any }>;
  startWorker(id: string, mode?: "ONE_DELIVERY" | "RECOVER_ONLY", killed?: boolean):
    Promise<{ child: ChildProcess; completed: Promise<{ status: string; reason: string | null }> }>;
  save(name: string, value: unknown): Promise<unknown>;
  external(): Promise<{ digest: string; state: { records: Record<string, any> } }>;
}) {
  const { ctx, sql, relay } = input, tenant = ctx.auth.tenantId;
  const original = await applicationSession(ctx, input.originalSessionId);
  const history = async () => ({
    acquisition: await applicationSession(ctx, original.id),
    requests: (await sql.query("SELECT id,status,request_ref,observation_ref,obligation_id FROM finnor_os.application_semantics_requests"
      + " WHERE session_id=$1 ORDER BY id", [original.id])).rows,
    charges: (await sql.query("SELECT charge_key,body FROM finnor_os.s5_governed_resource_charges"
      + " WHERE tenant_id=$1 AND reservation_id=$2 ORDER BY charge_key", [tenant, original.reservation_ref.id])).rows,
  });
  const before = await history(), externalBefore = await input.external();
  const captureComposition = async (id: string) => {
    let held = relay.arm(input.recordPath);
    const worker = await input.startWorker(id, undefined, true);
    const captured = async (signal: Promise<void>) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          signal, worker.completed.then(() => { throw Error("SIBLING_WORKER_FINISHED_BEFORE_PREPARATION_HOLD"); }),
          new Promise<never>((_yes, no) => {
            timer = setTimeout(() => no(Error("REAL_SIBLING_RECORD_RESPONSE_NOT_CAPTURED")), 15000);
          }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    };
    const holds: Array<{ ordinal: number; status: string; compositionRef: ApplicationSessionRow["composition_ref"] }> = [];
    try {
      for (let ordinal = 1; ordinal <= 8; ordinal++) {
        await captured(held);
        const row = await applicationSession(ctx, id);
        const requests = (await sql.query("SELECT id FROM finnor_os.application_semantics_requests WHERE session_id=$1", [id])).rows;
        assert.equal(requests.length, 0, "SIBLING_PREPARATION_MUST_PRECEDE_ANY_EFFECT_REQUEST");
        holds.push({ ordinal, status: row.status, compositionRef: row.composition_ref });
        if (row.composition_ref) {
          const composition = await applicationArtifact<Omit<CheckedApplicationComposition, "ref">>(ctx, row.composition_ref);
          assert.equal(composition.steps.length, 4, "REGISTERED_UNSEEN_FOUR_STEP_COMPOSITION_REQUIRED");
          assert(worker.child.kill("SIGKILL"), "ACTUAL_OWNED_SIBLING_PROCESS_MUST_BE_KILLED");
          await worker.completed;
          return { row, composition, holds, killedPid: worker.child.pid };
        }
        relay.release();
        held = relay.arm(input.recordPath);
      }
      throw Error("REAL_S4_COMPOSITION_MUST_COMMIT_BEFORE_PHYSICAL_KILL");
    } finally {
      relay.release();
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
      await worker.completed.catch(() => undefined);
      await input.save("private/sibling-preparation-holds-" + id + ".json", holds);
    }
  };
  const capacity = async () => (await sql.query(
    "SELECT id,owner_id,job_id,expires_at,released_at FROM finnor_os.compute_resource_leases"
    + " WHERE resource_key='native:x2' AND tenant_key=$1 AND released_at IS NULL AND expires_at>clock_timestamp() ORDER BY expires_at",
    [tenant])).rows;
  const waitOriginalCapacity = async () => {
    const occupied = await capacity();
    assert.equal(occupied.length, 1, "KILLED_DELIVERY_MUST_RETAIN_CANONICAL_CAPACITY_UNTIL_EXPIRY");
    const wait = Math.max(...occupied.map(row => row.expires_at.getTime())) - Date.now();
    assert(wait > 0 && wait <= 150000, "ORIGINAL_NATIVE_LEASE_MUST_EXPIRE_WITHOUT_CONFIGURATION_CHANGE");
    await pause(wait + 50);
    assert.equal((await capacity()).length, 0);
    return occupied;
  };
  const first = await captureComposition(input.firstSessionId);
  const secondWorkId = await input.createWork("Prepare a second independent Work using the same frozen model and original resource reservation.");
  const registered = await input.execute(secondWorkId, input.goal);
  assert.equal(registered.status, 202);
  const secondId = registered.body.sessionId as string;
  const deferred = await input.startWorker(secondId, "ONE_DELIVERY");
  assert.equal((await deferred.completed).status, "QUEUED");
  const deferredJob = (await sql.query("SELECT id,status,capacity_defer_count,capacity_defer_reason,run_at FROM finnor_os.jobs"
    + " WHERE payload->>'sessionId'=$1 ORDER BY accepted_at,id", [secondId])).rows;
  assert.equal(deferredJob.length, 1); assert.equal(deferredJob[0].status, "queued");
  assert.equal(deferredJob[0].capacity_defer_count, 1); assert.equal(deferredJob[0].capacity_defer_reason, "native:x2");
  const firstOccupation = await waitOriginalCapacity();
  await pause(Math.max(0, deferredJob[0].run_at.getTime() - Date.now()) + 20);
  const second = await captureComposition(secondId);
  await receiveWork({ tenantId: tenant, userId: ctx.auth.userId, workId: input.firstWorkId,
    channel: "console", instruction: "Replace the old suspended instruction. Do not execute its submission.",
    activeContext: { ...original.root }, idempotencyKey: "sibling-replacement:" + randomUUID() });
  const replacement = (await sql.query("SELECT w.status,(SELECT i.id FROM finnor_os.work_inputs i"
    + " WHERE i.tenant_id=w.tenant_id AND i.work_id=w.id ORDER BY i.created_at DESC,i.id DESC LIMIT 1) input_id"
    + " FROM finnor_os.works w WHERE w.id=$1",
    [input.firstWorkId])).rows[0];
  assert.notEqual(replacement.input_id, first.row.work_input_id, "REAL_REPLACEMENT_INPUT_REQUIRED");
  const operationId = first.composition.steps[2]!.operationId;
  assert.equal(second.composition.steps[2]!.operationId, operationId);
  await invalidateApplicationOperation(ctx, first.row, operationId, null, "X2_OWNER_OPERATION_WITHDRAWAL", true);
  const oldFirst = await applicationSession(ctx, first.row.id), oldSecond = await applicationSession(ctx, secondId);
  assert.equal(oldFirst.status, "STALE"); assert.equal(oldSecond.status, "STALE");
  const works = (await sql.query("SELECT w.id,w.status,(SELECT i.id FROM finnor_os.work_inputs i"
    + " WHERE i.tenant_id=w.tenant_id AND i.work_id=w.id ORDER BY i.created_at DESC,i.id DESC LIMIT 1) input_id"
    + " FROM finnor_os.works w WHERE w.id=ANY($1::uuid[])",
    [[input.firstWorkId, secondWorkId]])).rows;
  assert.deepEqual(works.find(row => row.id === input.firstWorkId), { id: input.firstWorkId, ...replacement },
    "INVALIDATION_MUST_NOT_PUBLISH_OVER_THE_REPLACEMENT_INPUT");
  assert.equal(works.find(row => row.id === secondWorkId)?.status, "blocked");
  const closures = (await sql.query("SELECT session_id,body FROM finnor_os.application_semantics_events"
    + " WHERE session_id=ANY($1::uuid[]) AND kind='P7_MINIMAL_SOUND_COMPOSITION_CLOSURE'",
    [[first.row.id, secondId]])).rows;
  assert.equal(closures.length, 2);
  for (const closure of closures) {
    const composition = closure.session_id === first.row.id ? first.composition : second.composition;
    assert.deepEqual(closure.body.detail.affectedStepIds, composition.steps.slice(2).map(step => step.id));
    assert.deepEqual(closure.body.detail.keptStepIds, composition.steps.slice(0, 2).map(step => step.id));
  }
  const validities = (await sql.query("SELECT operation_id,status FROM finnor_os.application_operation_validities"
    + " WHERE tenant_id=$1 AND model_id=$2 ORDER BY operation_id", [tenant, original.model_ref!.id])).rows;
  assert.equal(validities.filter(row => row.status === "REVOKED" && row.operation_id === operationId).length, 1);
  assert.equal(validities.filter(row => row.status === "CURRENT").length, 3);
  assert.equal((await input.external()).digest, externalBefore.digest, "PREPARATION_AND_INVALIDATION_MUST_NOT_MUTATE_THE_PORTAL");
  const secondOccupation = await waitOriginalCapacity();
  await input.save("private/sibling-before-still-current-use.json", {
    first, second, deferredJob, firstOccupation, secondOccupation, replacement, works, closures, validities,
    before, oldFirst, oldSecond, externalBefore, originalDeadline: original.parent.deadlineAt, newAllowance: false,
  });
  const quantity = input.goal.reporting;
  assert(quantity && typeof quantity === "object" && quantity.kind === "quantity");
  const draftWork = await input.createWork("Execute only the independently still-current draft operation under the original parent.");
  const draft = await input.execute(draftWork, { phase: "DRAFT", "draft.reporting": quantity });
  assert.equal(draft.status, 202);
  const delivered = await input.startWorker(draft.body.sessionId);
  assert.equal((await delivered.completed).status, "COMPLETED");
  const requests = (await sql.query("SELECT session_id,status,possible_egress,body FROM finnor_os.application_semantics_requests"
    + " WHERE session_id=ANY($1::uuid[]) ORDER BY created_at,id",
    [[first.row.id, secondId, draft.body.sessionId]])).rows;
  assert.equal(requests.length, 1); assert.equal(requests[0].session_id, draft.body.sessionId);
  assert.equal(requests[0].body.operationId, first.composition.steps[0]!.operationId);
  assert.equal(requests[0].status, "VERIFIED"); assert.equal(requests[0].possible_egress, true);
  const after = await history(), externalAfter = await input.external();
  assert.deepEqual(after.acquisition, before.acquisition); assert.deepEqual(after.requests, before.requests);
  for (const charge of before.charges) assert.deepEqual(after.charges.find(row => row.charge_key === charge.charge_key), charge);
  for (const session of [oldFirst, oldSecond, await applicationSession(ctx, draft.body.sessionId)]) {
    assert.deepEqual(session.original_parent_ref, original.original_parent_ref);
    assert.deepEqual(session.allocation_ref, original.allocation_ref);
    assert.deepEqual(session.reservation_ref, original.reservation_ref);
    assert.equal(session.parent.deadlineAt, original.parent.deadlineAt);
  }
  const record = externalAfter.state.records[input.targetId];
  assert.equal(record.phase, "DRAFT"); assert.equal(record.submissions.length, 0);
  assert.equal(record.submission, null); assert.equal(record.approval, null);
  assert.deepEqual(record.draft.reporting, {
    amount: quantity.decimal, currency: quantity.currency, entity: quantity.entity,
    unit: quantity.unit, date: quantity.time, basis: quantity.basis,
  });
  await input.save("private/real-sibling-Work-outcome.json", {
    first, second, deferredJob, firstOccupation, secondOccupation, replacement, works, closures, validities,
    before, after, requests, externalBefore, externalAfter, originalDeadline: original.parent.deadlineAt, newAllowance: false,
  });
  return { realSiblingCompositions: 2, staleOldInputs: 2, replacementInputPreserved: true,
    canonicalCapacityDeferral: true, affectedSuffixSteps: 2, keptPrefixSteps: 2,
    unrelatedDraftVerified: true, submissionCount: 0, originalDeadline: original.parent.deadlineAt, newAllowance: false };
}

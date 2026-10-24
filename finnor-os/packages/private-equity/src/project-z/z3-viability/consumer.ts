/** S4's first concrete native consumer: bounded internal-readiness and S6
 * observation prefixes. No provider, effect dispatch, settlement or release.
 * The shared S4 owner entry calls this inside the physical writer transaction. */
import { transitionWorkTx, type Db, type WorkStatus } from "@finnor/db";
import type { PoolClient } from "pg";
import type { PeMutationContext } from "../../types";
import { sha } from "../../evidence-execution/store";
import { chargeViabilityOwnerStep, resolveViabilityNativeOrigin } from "./native-origin";
import { assertViabilityClaimTx, assertViabilityCurrent, viabilityEvent, viabilitySession } from "./store";
import { hash, parseStoredCandidate, parseStoredReceipt, z3Fault, type ViabilityClaim } from "./contracts";
import type { NativeOperation } from "./native-model";
import type { ViabilityRevisionBridge } from "../../../../orchestration/src/project-z/z3-viability/revision";

export interface ViabilityCursor {
  schema: "finnor.z3.s4-cursor.v1"; candidateDigest: string; checkDigest: string; bindingDigest: string;
  stateId: string; memory: number; operations: number; goalVisits: Record<NativeOperation, number>;
}
interface Observation {
  operation: NativeOperation; outcome: string; evidenceDigest: string;
}

/** These meanings are fixed in loaded source. READINESS observes the actual
 * canonical native plan head. RECONCILE observes outstanding S6 effect rows;
 * observing CLEAR does NOT settle anything or remove any model UNKNOWN. */
async function observe(ctx: PeMutationContext, operation: NativeOperation, parentId: string, c: PoolClient): Promise<Observation> {
  if (operation === "READINESS") {
    const head = (await c.query<{ body: { schema?: string; status?: string }; digest: string; plan_status: string }>(
      `SELECT h.body,h.digest,p.status plan_status FROM finnor_os.p1_requests r
       JOIN finnor_os.p1_programs h ON h.tenant_id=r.tenant_id AND h.id=r.head_id AND h.request_id=r.id
       JOIN finnor_os.work_plan_revisions p ON p.tenant_id=r.tenant_id AND p.id=r.plan_revision_id
       WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.id=$3 FOR SHARE OF h,p`,
      [ctx.auth.tenantId, ctx.auth.userId, parentId])).rows[0];
    if (head && sha(head.body) !== head.digest) z3Fault("Z3_NATIVE_HEAD_PREIMAGE_CORRUPT");
    return { operation, outcome: head?.body.schema === "finnor.institution-harness-program.v1"
      && ["WAITING", "PARTIAL"].includes(head.body.status ?? "") && head.plan_status === "active" ? "READY" : "NOT_READY",
      evidenceDigest: hash(head ?? null) };
  }
  const rows = (await c.query<{ id: string; status: string }>(
    `SELECT id::text,status FROM finnor_os.business_effects
     WHERE tenant_id=$1 AND status NOT IN('verified','cancelled','compensated')
     ORDER BY id LIMIT 257 FOR SHARE`, [ctx.auth.tenantId])).rows;
  if (rows.length > 256) z3Fault("Z3_ORIGINAL_OBLIGATION_BOUND");
  return { operation, outcome: rows.length ? "UNKNOWN_RETAINED" : "CLEAR", evidenceDigest: hash(rows) };
}

export async function consumeCheckedViabilityTx(ctx: PeMutationContext, sessionId: string,
  claim: ViabilityClaim, c: PoolClient, db: Db) {
  const preimage = await viabilitySession(ctx, sessionId, c);
  const origin = await resolveViabilityNativeOrigin(ctx, preimage.work_id, c);
  const row = await assertViabilityClaimTx(ctx, preimage, claim, c);
  await assertViabilityCurrent(ctx, row, c, true, origin);
  const candidate = parseStoredCandidate(row.candidate), receipt = parseStoredReceipt(row.check_receipt);
  if (candidate.disposition !== "COMPLETE" || receipt.status !== "VIABLE"
    || candidate.arenaDigest !== row.arena_digest || candidate.bindingDigest !== row.binding_digest
    || receipt.candidateDigest !== row.candidate_digest || receipt.bindingDigest !== row.binding_digest
    || receipt.arenaDigest !== row.arena_digest || !row.candidate_digest || !row.check_digest) {
    z3Fault("Z3_S4_CURRENT_CHECKED_STRATEGY_REQUIRED");
  }
  if (origin.remaining.steps < 4) z3Fault("Z3_ORIGINAL_NATIVE_BUDGET_EXHAUSTED");
  const prior = (await c.query<{ body: { cursor: ViabilityCursor; cursorDigest: string } }>(
    `SELECT body FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND principal_id=$2
     AND session_id=$3 AND kind='Z3_S4_NATIVE_PREFIX' ORDER BY id DESC LIMIT 1`,
    [row.tenant_id, row.principal_id, row.id])).rows[0]?.body;
  const arena = origin.model.arena, strategy = candidate.strategy;
  if (!prior && arena.initial.length !== 1) z3Fault("Z3_NATIVE_SINGLE_INITIAL_OBSERVATION_REQUIRED");
  const intake = (await c.query<{ body: { revisionBridge: ViabilityRevisionBridge | null } }>(
    `SELECT body FROM finnor_os.z3_viability_events WHERE tenant_id=$1 AND principal_id=$2
     AND session_id=$3 AND kind='Z3_SESSION_INTAKE' ORDER BY id LIMIT 1`,
    [row.tenant_id, row.principal_id, row.id])).rows[0]?.body;
  const bridge = intake?.revisionBridge;
  if (!prior && bridge && (bridge.currentBindingDigest !== row.binding_digest || bridge.strategyDigest !== hash(strategy)
    || bridge.cursor.stateId !== arena.initial[0] || bridge.cursor.memory !== strategy.initial[0])) {
    z3Fault("Z3_REDERIVED_STRATEGY_DOES_NOT_COVER_CARRIED_MEMORY");
  }
  let cursor: ViabilityCursor = prior?.cursor ?? {
    schema: "finnor.z3.s4-cursor.v1", candidateDigest: row.candidate_digest, checkDigest: row.check_digest,
    bindingDigest: row.binding_digest, stateId: bridge?.cursor.stateId ?? arena.initial[0]!,
    memory: bridge?.cursor.memory ?? strategy.initial[0]!,
    operations: bridge?.cursor.operations ?? 0,
    goalVisits: bridge?.cursor.goalVisits ?? { READINESS: 0, RECONCILE: 0 },
  };
  if (prior && hash(cursor) !== prior.cursorDigest || cursor.candidateDigest !== row.candidate_digest
    || cursor.checkDigest !== row.check_digest || cursor.bindingDigest !== row.binding_digest
    || !Number.isSafeInteger(cursor.operations) || cursor.operations < 0) z3Fault("Z3_S4_CURSOR_PREIMAGE_CHANGED");
  const transitions: Array<Record<string, unknown>> = [];
  const step = (edgeIndex: number) => {
    const edge = arena.edges[edgeIndex];
    if (!Number.isSafeInteger(edgeIndex) || !edge || edge.from !== cursor.stateId) z3Fault("Z3_S4_UNMODELLED_ORIGINAL_EDGE");
    const memory = strategy.updates[cursor.memory]?.[edgeIndex];
    if (!Number.isSafeInteger(memory) || memory === undefined || memory < 0 || memory >= strategy.memories.length) {
      z3Fault("Z3_S4_UNMODELLED_MEMORY_UPDATE");
    }
    cursor = { ...cursor, stateId: edge.to, memory };
  };
  const before = hash(cursor);
  for (let index = 0; index < 4; index++) {
    const stateIndex = arena.states.findIndex(s => s.id === cursor.stateId);
    if (!Number.isSafeInteger(cursor.memory) || cursor.memory < 0 || cursor.memory >= strategy.memories.length
      || arena.states[stateIndex]?.owner !== "C") z3Fault("Z3_S4_CURRENT_STATE_UNMODELLED");
    const edgeIndex = strategy.actions[cursor.memory]?.[stateIndex];
    if (edgeIndex === undefined) z3Fault("Z3_S4_ACTION_NOT_COVERED");
    const from = { stateId: cursor.stateId, memory: cursor.memory };
    step(edgeIndex);
    const operation = origin.model.environmentOperations.get(cursor.stateId);
    if (!operation) z3Fault("Z3_S4_OPERATION_NOT_COVERED");
    const environment = { stateId: cursor.stateId, memory: cursor.memory };
    await chargeViabilityOwnerStep(ctx, origin, claim, c);
    const observation = await observe(ctx, operation, origin.parent.id, c);
    const observedEdge = arena.edges.findIndex(edge => edge.from === cursor.stateId && edge.action === observation.outcome);
    step(observedEdge);
    cursor = { ...cursor, operations: cursor.operations + 1,
      goalVisits: { ...cursor.goalVisits, [operation]: cursor.goalVisits[operation] + 1 } };
    transitions.push({ from, controllerEdge: edgeIndex, environment, ...observation,
      environmentEdge: observedEdge, to: { stateId: cursor.stateId, memory: cursor.memory } });
  }
  const work = (await c.query<{ status: WorkStatus }>(
    "SELECT status FROM finnor_os.works WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.work_id])).rows[0];
  if (!work || ["cancelled", "failed", "completed"].includes(work.status)) z3Fault("Z3_ORIGINAL_WORK_NOT_CURRENT");
  const body = { schema: "finnor.z3.s4-native-prefix.v1", owner: "S4", sessionId, workId: row.work_id,
    workInputId: row.work_input_id, originalParentId: row.original_parent_id, reservationRef: row.reservation_ref,
    deadlineAt: origin.binding.deadlineAt, previousCursorDigest: before, cursor, cursorDigest: hash(cursor), transitions,
    deliveryAttemptId: claim.physical.deliveryAttemptId, jobClaimFence: claim.physical.claimFence,
    claimFence: claim.sessionFence, conditionality: "FINITE_OBSERVED_PREFIX_NOT_UNBOUNDED_EXECUTION_OR_FINANCIAL_AUTHORITY",
    unknownClearedWithoutS6: false, protectedReceipt: null, executionAuthorityGranted: false };
  await transitionWorkTx(db, row.tenant_id, row.work_id, work.status, "viability_native_prefix_observed", body,
    { expectedStatus: work.status, expectedWorkInputId: row.work_input_id });
  await viabilityEvent(ctx, row, "Z3_S4_NATIVE_PREFIX", body, c);
  await assertViabilityCurrent(ctx, row, c);
  await assertViabilityClaimTx(ctx, row, claim, c);
  return { consumed: true as const, cursor, cursorDigest: hash(cursor), transitions: transitions.length,
    originalWorkObservation: "viability_native_prefix_observed", executionAuthorityGranted: false as const };
}

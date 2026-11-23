/** Concrete owner boundary for a possible protected delegated child.
 * Assembles the actual current parent chain, recipient attenuation, original
 * root budget, attempt history and the real S6 origin/consumption join, then
 * always refuses: this runtime has no protected custody or admission. The
 * durable binding is committed separately after the refusing transaction rolls
 * back, so a refused caller still leaves exact reconstructible evidence. */
import type { PoolClient } from "pg";
import type { ExperimentRef, TenantContext } from "@finnor/shared-types";
import { s6AdapterContract } from "../../../governed-execution/src/adapter-contract";
import { workforceDigest, workforceCanonicalGraph, type WorkforceCompilerInput,
  type WorkforceAssignment, type WorkforceExecutionProgram, type WorkforceTask
} from "../../../workforce/src/execution-program/index";
import { tx, type WorkforceProgramRow } from "./store";
import { WorkforceRuntimeError } from "./contracts";

export const protectedChildRefusalCode = "WORKFORCE_PROTECTED_DELEGATED_CHILD_ADAPTER_UNADMITTED";

interface ProtectedChildRefusalBody {
  schema: "finnor.w2.protected-child-refusal.v1";
  [key: string]: unknown;
}

/** Reads only; throws the retained refusal carrying the exact binding body. */
export async function refuseWorkforceProtectedChildTx(ctx: TenantContext, q: WorkforceProgramRow,
  program: WorkforceExecutionProgram, assignment: WorkforceAssignment, task: WorkforceTask,
  canonical: WorkforceCompilerInput, c: PoolClient): Promise<never> {
  const graph = workforceCanonicalGraph(canonical), byId = new Map(program.assignments.map(a => [a.id, a]));
  const chain: WorkforceAssignment[] = [];
  for (let current: WorkforceAssignment | undefined = assignment; current; current = byId.get(current.parentAssignmentId ?? "")) {
    chain.push(current);
    if (chain.length > 512) throw new WorkforceRuntimeError("WORKFORCE_COMPLETE_PARENT_CHAIN_REQUIRED");
  }
  const violations: string[] = [];
  for (const ancestor of chain.slice(1)) {
    const parentTask = graph.tasks.find(value => value.id === ancestor.taskId);
    if (!parentTask) { violations.push("PARENT_TASK_UNAVAILABLE:" + ancestor.id); continue; }
    for (const field of ["capabilities", "dataScopes", "purposes", "effects"] as const)
      if (task.ceiling[field].some(value => !parentTask.ceiling[field].includes(value)))
        violations.push("CEILING_NOT_ATTENUATED:" + field + ":" + ancestor.id);
    if (Date.parse(task.ceiling.validUntil) > Date.parse(parentTask.ceiling.validUntil))
      violations.push("CEILING_VALIDITY_EXCEEDS_PARENT:" + ancestor.id);
  }
  const attempts = (await c.query(`SELECT event_id,kind,request_digest FROM finnor_os.w2_events
    WHERE tenant_id=$1 AND program_id=$2 AND kind IN('S6_INTENDED','S6_OBSERVATION')
      AND body->>'assignmentId'=ANY($3::text[]) ORDER BY event_id LIMIT 129`,
  [ctx.tenantId, q.id, chain.map(value => value.id)])).rows;
  if (attempts.length > 128) throw new WorkforceRuntimeError("WORKFORCE_S6_ATTEMPT_PROFILE_EXCEEDED");
  const effectKey = task.effectId ?? "ceiling-effects:" + task.id;
  const origin = /^[0-9a-f-]{36}$/i.test(task.effectId ?? "")
    ? (await c.query(`SELECT obligation_id,consumption_id,effect_id,domain_action_id,input_digest
        FROM finnor_os.s6_obligation_origins WHERE tenant_id=$1 AND effect_id=$2 ORDER BY obligation_id LIMIT 1`,
      [ctx.tenantId, task.effectId])).rows[0] ?? null
    : null;
  const body: ProtectedChildRefusalBody = {
    schema: "finnor.w2.protected-child-refusal.v1", programmeId: q.id, assignmentId: assignment.id,
    candidateTaskId: task.id, candidateEffectId: task.effectId, candidateCeilingEffects: task.ceiling.effects,
    effectKey, parentChain: chain.map(value => ({ assignmentId: value.id, taskId: value.taskId,
      termsDigest: value.termsDigest, actorId: value.actorId, state: value.state.kind,
      parentAssignmentId: value.parentAssignmentId })),
    recipientAttenuation: { checked: chain.length > 1, violations },
    originalRoot: q.work_id, originalDeadline: q.original.outcome.deadline,
    originalBudget: q.budget.ref, originalReservation: q.budget.reservationRef,
    carveRef: (canonical.funding.find(value => value.assignmentId === assignment.id)?.ref ?? null) as ExperimentRef | null,
    attemptHistory: attempts.map(value => ({ eventId: value.event_id, kind: value.kind, digest: value.request_digest })),
    s6Origin: origin ? { obligationId: origin.obligation_id, consumptionId: origin.consumption_id,
      effectId: origin.effect_id, domainActionId: origin.domain_action_id, inputDigest: origin.input_digest } : null,
    adapterContract: s6AdapterContract("DELEGATED_CHILD"),
    admission: "UNADMITTED", protectedCustody: false, protectedExecution: false,
    executionAuthorityGranted: false, egressAuthority: "NONE",
    refusalCode: protectedChildRefusalCode, at: new Date().toISOString() };
  throw new WorkforceRuntimeError(protectedChildRefusalCode, 409,
    { ...body, refusalDigest: workforceDigest(body) });
}

/** Commits the exact refused binding in its own transaction after the refusing
 * transaction rolled back. Idempotent on the content-addressed refusal. */
export async function persistWorkforceProtectedChildBinding(ctx: TenantContext, programId: string, detail: unknown) {
  const body = detail as ProtectedChildRefusalBody & { refusalDigest?: string; assignmentId?: string;
    effectKey?: string; parentChain?: { parentAssignmentId?: string | null }[];
    s6Origin?: { effectId?: string; domainActionId?: string; consumptionId?: string } | null };
  if (!body || body.schema !== "finnor.w2.protected-child-refusal.v1" || body.programmeId !== programId ||
      typeof body.refusalDigest !== "string" || typeof body.assignmentId !== "string" ||
      typeof body.effectKey !== "string") return;
  const { refusalDigest, ...preimage } = body;
  if (workforceDigest(preimage) !== refusalDigest)
    throw new WorkforceRuntimeError("WORKFORCE_PROTECTED_CHILD_REFUSAL_DIGEST_CHANGED");
  await tx(ctx, async c => {
    const origin = body.s6Origin ?? null;
    await c.query(`INSERT INTO finnor_os.w2_protected_child_bindings(tenant_id,program_id,assignment_id,effect_key,
      principal_id,parent_assignment_id,effect_id,domain_action_id,consumption_id,refusal_digest,body)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
      ON CONFLICT(tenant_id,program_id,assignment_id,effect_key,refusal_digest) DO NOTHING`,
    [ctx.tenantId, programId, body.assignmentId, body.effectKey,
      ctx.employeeId ?? ctx.userId, body.parentChain?.[0]?.parentAssignmentId ?? null,
      origin?.effectId ?? null, origin?.domainActionId ?? null, origin?.consumptionId ?? null,
      body.refusalDigest, JSON.stringify(body)]);
  });
}

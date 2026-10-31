import { z } from "zod";
import type { PoolClient } from "pg";
import type { PeMutationContext } from "../types";
import type { DurableObligation } from "@finnor/shared-types";
import {
  readEnterpriseDurableObligation, readEnterpriseDurableObligationExecutionHandoff,
  scheduleEnterpriseDurableObligationRequest, readEnterpriseDurableObligationBudgets,
  prepareEnterpriseDurableObligation,
} from "../enterprise-obligations";
import { validateEnterpriseAllocation } from "../enterprise-allocation";
import { ObligationOperationSchemas } from "../obligation-contracts";
import { canonical, hash, sameScope, type NativeEffectObservation, type NativeRef,
  type ObservationOriginal, type RealWorldServiceProgram, type ServiceProjection, type SourceRef } from "./contracts";
import { NativeExecutionSchema, NativeServiceIRSchema, MandateSchema, ServiceOperationSchemas, type NativeServiceExecution } from "./boundaries";
import { serviceNow, requireServiceProfile } from "./identity";
import { checkServiceProgram } from "./checker";
import { projectServiceProgram } from "./projection";
import { observationOriginals } from "./participants";
import { serviceTx, serviceRequest, authorizeServiceWork, currentServiceCut, serviceArtifact, sourceOriginal,
  enqueueService, type ServiceRequestRow } from "./store";

export interface ServiceExecutionOriginal { ref: SourceRef; body: NativeServiceExecution }
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const safeCode = (error: unknown) => {
  const code = error instanceof Error && "code" in error ? String(error.code)
    : error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_:]{0,200}$/.test(code) ? code : "W3_NATIVE_OWNER_UNAVAILABLE";
};
export { safeCode as servicePredicate };
export async function prepareNativeServiceObligation(ctx: PeMutationContext, raw: unknown) {
  requireServiceProfile();
  const input = ServiceOperationSchemas["prepare-native"].parse(raw);
  await serviceTx(ctx, async c => {
    await authorizeServiceWork(ctx, input.workId, c);
    const source = await sourceOriginal(ctx, input.workId, input.mandateSource, c);
    const mandate = MandateSchema.parse(JSON.parse(source.content));
    if (source.author_id !== ctx.auth.userId || mandate.authorizedByPrincipalId !== source.author_id
      || mandate.scope.workId !== input.workId || mandate.revoked || Date.parse(mandate.validFrom) > Date.now()
      || Date.parse(mandate.expiresAt) <= Date.now()) throw Error("W3_SEPARATE_ORIGINAL_MANDATE_REQUIRED");
  });
  return prepareEnterpriseDurableObligation(ctx, {
    preparationRef: input.preparationRef, allocationRef: input.allocationRef, consumptionRef: input.consumptionRef,
  }, { workId: input.workId });
}

/** The actual admitted JSON method must address this exact immutable service
 * bundle. The ordinary compiler cannot turn an arbitrary price action into one. */
export function serviceExecutionRecordKey(body: Pick<NativeServiceExecution,
  "scope" | "operation" | "coveredTerms" | "paymentPlan">): string {
  return "w3-service:" + hash({ scope: body.scope, operation: body.operation,
    coveredTerms: [...body.coveredTerms].sort((a, b) => canonical(a).localeCompare(canonical(b))),
    paymentPlan: [...body.paymentPlan].sort((a, b) => canonical(a).localeCompare(canonical(b))) });
}
export async function serviceExecutions(ctx: PeMutationContext, row: ServiceRequestRow, c: PoolClient) {
  const refs = (await c.query<{ source_id: string; version_id: string; content_digest: string }>(`SELECT l.*
   FROM finnor_os.w3_original_source_links l JOIN finnor_os.evidence_source_versions v
    ON v.tenant_id=l.tenant_id AND v.id=l.version_id AND v.source_id=l.source_id
   WHERE l.tenant_id=$1 AND l.principal_id=$2 AND l.author_id=$2 AND l.work_id=$3
    AND v.content::jsonb->>'schema'='finnor.service-native-execution.v1'
    AND v.content::jsonb->'scope'->>'businessAssignmentId'=$4
   ORDER BY l.created_at,l.source_id LIMIT 257`,
  [row.tenant_id, row.principal_id, row.work_id, row.business_assignment_id])).rows;
  if (refs.length > 256) throw Error("W3_NATIVE_BINDING_BOUND_INCOMPLETE");
  const result: ServiceExecutionOriginal[] = [];
  for (const ref of refs) {
    const sourceRef = { sourceId: ref.source_id, versionId: ref.version_id, contentDigest: ref.content_digest };
    const source = await sourceOriginal(ctx, row.work_id, sourceRef, c);
    result.push({ ref: sourceRef, body: NativeExecutionSchema.parse(JSON.parse(source.content)) });
  }
  return result;
}
export async function assertNativeServiceBinding(
  ctx: PeMutationContext, row: ServiceRequestRow, program: RealWorldServiceProgram, body: NativeServiceExecution,
): Promise<DurableObligation> {
  if (!sameScope(body.scope, program.envelope.scope) || !equal(body.parentAllocation, row.parent_allocation)
    || !program.original.permittedOperations.includes(body.operation)
    || new Set(body.coveredTerms.map(t => t.instanceId)).size !== body.coveredTerms.length
    || !body.coveredTerms.some(t => t.instanceId === body.instanceId && t.providerId === body.providerId
      && t.termsDigest === body.termsDigest)
    || body.coveredTerms.some(t => t.providerId !== body.providerId || !program.options.some(o =>
      o.instanceId === t.instanceId && o.providerId === t.providerId && o.termsDigest === t.termsDigest && o.gaps.length === 0)))
    throw Error("W3_NATIVE_EXACT_CURRENT_TERMS_REQUIRED");
  if (body.operation !== "PAY" && body.paymentPlan.length !== 0
    || body.operation === "PAY" && body.paymentPlan.length === 0
    || body.paymentPlan.some(p => !body.coveredTerms.some(t =>
      t.instanceId === p.instanceId && t.providerId === p.providerId && t.termsDigest === p.termsDigest))
    || new Set(body.paymentPlan.map(p => canonical(p.invoiceSource))).size !== body.paymentPlan.length)
    throw Error("W3_NATIVE_EXACT_PAYMENT_PLAN_REQUIRED");
  const execution = ObligationOperationSchemas["schedule-request"].parse(body.execution);
  const obligation = await readEnterpriseDurableObligation(ctx, body.obligationRef);
  const budget = await readEnterpriseDurableObligation(ctx, row.budget_obligation_ref);
  const ir = NativeServiceIRSchema.parse(execution.request.ir);
  if (!equal(obligation.allocationRef, row.parent_allocation) || !equal(ir.allocationRef, row.parent_allocation)
    || !equal(ir.obligationRef, body.obligationRef) || !equal(ir.effectRef, obligation.effectRef)
    || !equal(obligation.mandateRef, budget.mandateRef) || obligation.rightsRef !== budget.rightsRef
    || obligation.workLineage?.workId !== row.work_id || obligation.workLineage.workInputId !== row.work_input_id
    || ir.tenantId !== row.tenant_id || ir.principalId !== row.principal_id
    || execution.request.ref.contentDigest !== hash(execution.request.ir) || ir.members.length !== 1)
    throw Error("W3_NATIVE_ORIGINAL_WORK_POLICY_ALLOCATION_REQUIRED");
  const member = ir.members[0]!;
  if (member.semantic.operation !== "SERVICE_TRANSITION_V1" || member.semantic.unit !== "service_transition"
    || member.semantic.target.entityType !== "external_organization" || member.semantic.target.entityId !== row.company_id
    || member.request.kind !== "CONDITIONAL_JSON_FIELDS_REPLACE"
    || member.request.applicationAccountId !== body.providerId || member.request.recordKey !== serviceExecutionRecordKey(body)
    || Object.keys(member.request.changes).length !== 1 || !("serviceTransition" in member.request.changes))
    throw Error("W3_ADMITTED_NATIVE_SERVICE_OPERATION_REQUIRED");
  return obligation;
}
export async function readServiceNativeEffects(ctx: PeMutationContext, executions: ServiceExecutionOriginal[]) {
  const effects: NativeEffectObservation[] = [], gaps: string[] = [];
  const identities = new Set<string>();
  for (const original of executions) {
    const b = original.body;
    if (identities.has(b.obligationRef.id)) throw Error("W3_NATIVE_IDENTITY_REBOUND");
    identities.add(b.obligationRef.id);
    let state: NativeEffectObservation["state"] = "UNKNOWN", originalIdentityReadback = false;
    try {
      const answer = await readEnterpriseDurableObligationExecutionHandoff(ctx, { obligationRef: b.obligationRef });
      const handoff = answer.handoff;
      if (!equal(handoff.obligation.ref, b.obligationRef)) throw Error("W3_NATIVE_READBACK_IDENTITY_MISMATCH");
      const declared = NativeServiceIRSchema.parse(b.execution.request.ir);
      if (declared.members.length !== 1 || declared.members[0]!.request.recordKey !== serviceExecutionRecordKey(b)
        || declared.members[0]!.semantic.operation !== "SERVICE_TRANSITION_V1"
        || declared.members[0]!.request.applicationAccountId !== b.providerId)
        throw Error("W3_NATIVE_READBACK_TERMS_MISMATCH");
      const settled = handoff.settlements.some((r: { event: { detail: { status: string; requestRef: NativeRef } } }) =>
        r.event.detail.status === "VERIFIED" && equal(r.event.detail.requestRef, b.execution.request.ref));
      if (settled && equal(handoff.request?.ref, b.execution.request.ref)) state = "VERIFIED";
      else state = handoff.attempts.length ? "UNKNOWN" : "NOT_ATTEMPTED";
      originalIdentityReadback = true;
    } catch (error) { gaps.push(safeCode(error) + ":" + b.obligationRef.id) }
    for (const term of b.coveredTerms) effects.push({ ...term, ref: b.obligationRef, operation: b.operation, state,
      originalIdentityReadback, invoiceSourceIds: b.paymentPlan.filter(p => p.instanceId === term.instanceId
        && p.termsDigest === term.termsDigest).map(p => p.invoiceSource.sourceId) });
  }
  return { effects, gaps };
}
export function serviceOperationGap(
  program: RealWorldServiceProgram, originals: ObservationOriginal[], effects: NativeEffectObservation[],
  b: NativeServiceExecution, now: number,
): string | null {
  if (program.original.reservedDecisions.length) return "W3_ORIGINAL_RESERVED_DECISION_UNRESOLVED";
  for (const term of b.coveredTerms) {
    const instance = program.instances.find(i => i.id === term.instanceId)!;
    const selected = program.selection.find(s => s.instanceId === term.instanceId);
    const reports = originals.filter(r => r.body.instanceId !== term.instanceId || r.body.providerId === term.providerId
      && r.body.termsDigest === term.termsDigest);
    const view = { ...program, selection: program.selection.map(s => s.instanceId === term.instanceId
      ? { ...s, providerId: term.providerId, termsDigest: term.termsDigest } : s) };
    const projected = projectServiceProgram(view, reports, effects, now).instances.find(i => i.instanceId === term.instanceId)!;
    const full = projectServiceProgram(program, originals, effects, now);
    if (selected && selected.providerId !== term.providerId && !["CANCEL", "RETIRE_ACCESS", "PAY"].includes(b.operation)) {
      const primary = full.instances.find(i => i.instanceId === term.instanceId)!;
      const failed = primary.originalFailures.length > 0 || originals.some(r => r.body.instanceId === term.instanceId
        && r.body.providerId === selected.providerId && r.body.kind === "OBSERVATION" && r.body.result === "FAIL");
      const livePrimary = primary.commitments.some(c => c.providerId === selected.providerId
        && ["ACCEPTED", "CANCELLATION_REQUESTED"].includes(c.state));
      if (!failed || livePrimary || primary.outstandingEffects.length)
        return "W3_BACKUP_REQUIRES_ORIGINAL_FAILURE_AND_RECONCILED_COMMITMENT";
    }
    if (effects.some(e => e.instanceId === term.instanceId && e.providerId === term.providerId
      && e.termsDigest === term.termsDigest && ["UNKNOWN", "MAY_HAVE_LEFT"].includes(e.state)))
      return "W3_ORIGINAL_IDENTITY_READBACK_REQUIRED";
    const criteria = program.observationRequirements.filter(r => r.instanceId === term.instanceId).map(r => r.criterion);
    if (b.operation === "OFFER") {
      if (now >= Date.parse(instance.endAt)) return "W3_ORIGINAL_SERVICE_WINDOW_EXPIRED";
    } else if (b.operation === "TRIAL" || b.operation === "ACCESS") {
      if (criteria.some(c => c.phase === "READINESS" && projected.missingCriteria.includes(c.id)))
        return "W3_ACTUAL_SAFE_READINESS_EVIDENCE_REQUIRED";
    } else if (b.operation === "BOOK") {
      if (!projected.ready || !projected.accepted || projected.contradictions.length)
        return "W3_EXACT_ACCEPTANCE_TRIAL_AND_READINESS_REQUIRED";
      if (instance.prerequisites.some(id => !full.instances.find(i => i.instanceId === id)?.operationallyComplete))
        return "W3_ORIGINAL_SERVICE_PREREQUISITE_INCOMPLETE";
      if (now >= Date.parse(instance.endAt)) return "W3_ORIGINAL_SERVICE_WINDOW_EXPIRED";
    } else if (b.operation === "PAY") {
      if (!projected.operationallyComplete || projected.contradictions.length)
        return "W3_UNOBSERVED_SERVICE_PAYMENT_FORBIDDEN";
      const plan = b.paymentPlan.filter(p => p.instanceId === term.instanceId && p.providerId === term.providerId
        && p.termsDigest === term.termsDigest);
      if (!plan.length || new Set(plan.map(p => p.invoiceId)).size !== plan.length)
        return "W3_NATIVE_EXACT_PAYMENT_PLAN_REQUIRED";
      for (const item of plan) {
        const invoice = originals.find(r => equal(r.ref, item.invoiceSource));
        if (!invoice || invoice.body.kind !== "INVOICE" || invoice.body.invoiceId !== item.invoiceId
          || !equal(invoice.body.amount, item.amount) || invoice.body.instanceId !== term.instanceId
          || invoice.body.providerId !== term.providerId || invoice.body.termsDigest !== term.termsDigest
          || !invoice.consentCurrent) return "W3_ORIGINAL_INVOICE_PAYMENT_MISMATCH";
      }
    } else if (b.operation === "RETIRE_ACCESS") {
      if (now < Date.parse(instance.endAt)) return "W3_ACCESS_STILL_REQUIRED_BY_ORIGINAL_SERVICE";
    } else if (b.operation === "CANCEL") {
      if (!originals.some(r => r.body.instanceId === term.instanceId && r.body.providerId === term.providerId
        && r.body.termsDigest === term.termsDigest && r.consentCurrent
        && ["CANCELLATION_REQUESTED", "MISSED", "DISPUTED"].includes(r.body.kind)))
        return "W3_ORIGINAL_CANCELLATION_OR_FAILURE_REQUIRED";
    }
  }
  return null;
}
export async function readServiceCut(ctx: PeMutationContext, requestId: string) {
  return serviceTx(ctx, async c => {
    const row = await serviceRequest(ctx, requestId, c), cut = await currentServiceCut(ctx, row, c);
    const artifact = await serviceArtifact(ctx, row, c);
    if (artifact && checkServiceProgram(cut.outcome, cut.providers, artifact.body, row.identity, Date.now())
      .disposition !== "CHECKED_DEVELOPMENT") throw Error("W3_ARTIFACT_CURRENT_CHECK_REJECTED");
    return { row, ...cut, artifact, originals: await observationOriginals(ctx, row, c),
      executions: await serviceExecutions(ctx, row, c) };
  });
}
/** Called by the real S6 nonce assessment, not just by the W3 scheduler.
 * A queued native request cannot outlive the exact W3 terms/consent/evidence cut.
 * Unrelated S6 obligations keep their existing owner path. */
export async function serviceDispatchReasons(ctx: PeMutationContext, obligation: DurableObligation, requestRef: NativeRef) {
  if (!obligation.workLineage) return [];
  const rows = await serviceTx(ctx, async c => (await c.query<ServiceRequestRow>(`SELECT * FROM finnor_os.w3_service_requests
   WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY id LIMIT 33`,
  [ctx.auth.tenantId, ctx.auth.employeeId ?? ctx.auth.userId, obligation.workLineage!.workId])).rows);
  if (rows.length > 32) return ["W3_DISPATCH_DEPENDENCY_BOUND_INCOMPLETE"];
  let bound = false;
  for (const row of rows) {
    const links = await serviceTx(ctx, c => serviceExecutions(ctx, row, c));
    const matching = links.filter(link => equal(link.body.obligationRef, obligation.ref));
    if (!matching.length) continue;
    if (bound) return ["W3_NATIVE_IDENTITY_REBOUND"];
    bound = true;
    try {
      requireServiceProfile();
      if (matching.length !== 1 || !equal(matching[0]!.body.execution.request.ref, requestRef))
        throw Error("W3_NATIVE_IDENTITY_REBOUND");
      const cut = await readServiceCut(ctx, row.id);
      if (!cut.artifact) throw Error("W3_CHECKED_ARTIFACT_REQUIRED_AT_DISPATCH");
      await assertNativeServiceBinding(ctx, row, cut.artifact.body, matching[0]!.body);
      // Do not recursively request the in-flight obligation's broker handoff.
      const native = await readServiceNativeEffects(ctx, links.filter(link => !equal(link.body.obligationRef, obligation.ref)));
      const gap = serviceOperationGap(cut.artifact.body, cut.originals, native.effects, matching[0]!.body, serviceNow());
      if (gap) return [gap];
    } catch (error) { return [safeCode(error)] }
  }
  if (!bound && rows.length && (rows.some(row => equal(row.budget_obligation_ref, obligation.ref))
    || obligation.intervention.channels.some(channel => channel.operation === "SERVICE_TRANSITION_V1")))
    return ["W3_NATIVE_TERMS_NOT_BOUND"];
  return [];
}
/** Native S4/S5/S6 own delivery. Re-entry observes the original identity and
 * never directly resends a possibly delivered provider request. */
export async function consumeServiceProgram(ctx: PeMutationContext, requestId: string,
  assertClaim: () => Promise<void>) {
  requireServiceProfile();
  const cut = await readServiceCut(ctx, requestId);
  if (!cut.artifact) return { projection: null, scheduled: [], gaps: ["W3_CHECKED_ARTIFACT_PENDING"] };
  const native = await readServiceNativeEffects(ctx, cut.executions), scheduled = [], gaps = [...native.gaps];
  for (const original of cut.executions) {
    const body = original.body;
    if (!native.effects.some(e => equal(e.ref, body.obligationRef) && e.state === "NOT_ATTEMPTED")) continue;
    try {
      await assertClaim();
      const current = await readServiceCut(ctx, requestId);
      if (!current.artifact || current.artifact.body_digest !== cut.artifact.body_digest)
        throw Error("W3_ARTIFACT_CHANGED_BEFORE_NATIVE_USE");
      await assertNativeServiceBinding(ctx, current.row, current.artifact.body, body);
      const gap = serviceOperationGap(current.artifact.body, current.originals, native.effects, body, serviceNow());
      if (gap) { gaps.push(gap + ":" + body.instanceId); continue }
      if ((await validateEnterpriseAllocation(ctx, current.row.parent_allocation)).status !== "CURRENT")
        throw Error("W3_ORIGINAL_S5_ALLOCATION_NOT_CURRENT");
      scheduled.push(await scheduleEnterpriseDurableObligationRequest(ctx, body.execution));
    } catch (error) { gaps.push(safeCode(error) + ":" + body.instanceId) }
  }
  const projection = projectServiceProgram(cut.artifact.body, cut.originals, native.effects, serviceNow());
  return { projection, scheduled, gaps: [...new Set(gaps)] };
}
export async function requestServiceAdvance(ctx: PeMutationContext, raw: unknown) {
  const input = z.object({ requestId: z.string().uuid(), expectedArtifactDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw);
  requireServiceProfile();
  return serviceTx(ctx, async c => {
    const row = await serviceRequest(ctx, input.requestId, c, true);
    await currentServiceCut(ctx, row, c);
    const artifact = await serviceArtifact(ctx, row, c);
    if (!artifact || artifact.body_digest !== input.expectedArtifactDigest) throw Error("W3_CURRENT_ARTIFACT_REQUIRED");
    const next = (await c.query<ServiceRequestRow>(`UPDATE finnor_os.w3_service_requests
     SET wake_revision=wake_revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [row.tenant_id, row.id])).rows[0]!;
    await enqueueService(c, next, false);
    return { status: "QUEUED_NATIVE_REVALIDATION", requestId: row.id, executionAuthorityGranted: false };
  });
}
export async function readServiceWork(ctx: PeMutationContext, raw: unknown) {
  const input = z.object({ workId: z.string().uuid() }).strict().parse(raw);
  const rows = await serviceTx(ctx, async c => {
    await authorizeServiceWork(ctx, input.workId, c);
    const rows = (await c.query<ServiceRequestRow>(`SELECT * FROM finnor_os.w3_service_requests
     WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY created_at,id LIMIT 33`,
    [ctx.auth.tenantId, ctx.auth.employeeId ?? ctx.auth.userId, input.workId])).rows;
    if (rows.length > 32) throw Error("W3_WORK_ASSIGNMENT_READ_BOUND_INCOMPLETE");
    return rows;
  });
  const requests = [];
  for (const row of rows) {
    try {
      const cut = await readServiceCut(ctx, row.id);
      const native = await readServiceNativeEffects(ctx, cut.executions);
      if (cut.artifact) for (const { body } of cut.executions) {
        if (!native.effects.some(effect => equal(effect.ref, body.obligationRef) && effect.state === "NOT_ATTEMPTED")) continue;
        const gap = serviceOperationGap(cut.artifact.body, cut.originals, native.effects, body, serviceNow());
        if (gap) native.gaps.push(gap + ":" + body.instanceId);
      }
      let budgets: unknown = null;
      try { budgets = await readEnterpriseDurableObligationBudgets(ctx, { obligationRef: row.budget_obligation_ref }) }
      catch (error) { native.gaps.push(safeCode(error)) }
      requests.push({ requestId: row.id, status: row.status, generation: row.generation,
        artifactDigest: cut.artifact?.body_digest ?? null, program: cut.artifact?.body ?? null,
        check: cut.artifact?.check_result ?? null,
        projection: cut.artifact ? projectServiceProgram(cut.artifact.body, cut.originals, native.effects, serviceNow()) : null,
        nativeEffects: native.effects, budgets, gaps: [...new Set(native.gaps)],
        originalDeadlineAt: row.original_deadline.toISOString() });
    } catch (error) {
      requests.push({ requestId: row.id, status: "CURRENTNESS_UNAVAILABLE_RESPONSIBILITY_RETAINED",
        program: null, projection: null, gaps: [safeCode(error)], originalDeadlineAt: row.original_deadline.toISOString() });
    }
  }
  return { scope: { tenantId: ctx.auth.tenantId, principalId: ctx.auth.employeeId ?? ctx.auth.userId, workId: input.workId },
    requests, complete: true, qualification: "CONTROLLED_DEVELOPMENT_ONLY", admissionGranted: false, fieldValidated: false };
}

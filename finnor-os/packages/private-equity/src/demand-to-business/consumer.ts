import type { PoolClient } from "pg";
import type { DurableObligation } from "@finnor/shared-types";
import type { PeMutationContext } from "../types";
import { readOwnerTransportExecutionHandoffs } from "../../../governed-execution/src/owner-transport";
import { principal } from "../owner-context";
import { prepareEnterpriseDurableObligation, readEnterpriseDurableObligation,
  readEnterpriseDurableObligationBudgets,
  scheduleEnterpriseDurableObligationRequest } from "../enterprise-obligations";
import { validateEnterpriseAllocation } from "../enterprise-allocation";
import { ObligationOperationSchemas } from "../obligation-contracts";
import { hash, same, sameScope, type EffectObservation, type EventOriginal, type GrowthInput,
  type MarketValidatedOperatingProgram, type NativeRef, type SourceRef } from "./contracts";
import { growthMandateSchema, growthOperationSchemas, growthNativeExecutionSchema, nativeGrowthIRSchema,
  growthEvidenceSchema, type GrowthNativeExecution } from "./boundaries";
import { requireGrowthProfile, growthNow } from "./identity";
import { checkOperatingProgram } from "./checker";
import { projectOperatingProgram } from "./projection";
import { growthEventOriginals } from "./participants";
import { growthPreparedOutcomes, growthOwnerProductInfo } from "./product";
import { growthTx, growthRequest, growthSourceOriginal, growthSourceOriginals, authorizeGrowthWork, currentGrowthCut,
  loadGrowthInput, growthArtifact, enqueueGrowth, type GrowthRequestRow } from "./store";

export interface GrowthExecutionOriginal { ref: SourceRef; body: GrowthNativeExecution }
export const growthPredicate = (error: unknown) => {
  const code = error instanceof Error && "code" in error ? String(error.code)
    : error instanceof Error ? error.message : "";
  return /^[A-Z][A-Z0-9_:]{0,200}$/.test(code) ? code : "W4_NATIVE_OWNER_UNAVAILABLE";
};
export async function prepareNativeGrowthObligation(ctx: PeMutationContext, raw: unknown) {
  requireGrowthProfile();
  const input = growthOperationSchemas["prepare-native"].parse(raw);
  await growthTx(ctx, async c => {
    await authorizeGrowthWork(ctx, input.workId, c);
    const source = await growthSourceOriginal(ctx, input.workId, input.mandateSource, c);
    const mandate = growthMandateSchema.parse(JSON.parse(source.content));
    if (source.author_id !== ctx.auth.userId || mandate.authorizedByPrincipalId !== source.author_id
      || mandate.scope.principalId !== principal(ctx) || mandate.scope.workId !== input.workId
      || mandate.scope.tenantId !== ctx.auth.tenantId || mandate.revoked
      || Date.parse(mandate.validFrom) > Date.now() || Date.parse(mandate.expiresAt) <= Date.now())
      throw Error("W4_SEPARATE_ORIGINAL_MANDATE_REQUIRED");
  });
  return prepareEnterpriseDurableObligation(ctx, {
    preparationRef: input.preparationRef, allocationRef: input.allocationRef, consumptionRef: input.consumptionRef,
  }, { workId: input.workId });
}
export function growthExecutionRecordKey(body: Pick<GrowthNativeExecution,
  "scope" | "buyerId" | "offerId" | "termsDigest" | "operation" | "quantity" | "amount" | "basis">) {
  return "w4-business:" + hash({ scope: body.scope, buyerId: body.buyerId, offerId: body.offerId,
    termsDigest: body.termsDigest, operation: body.operation, quantity: body.quantity, amount: body.amount,
    basis: [...body.basis].sort((a, b) => a.sourceId.localeCompare(b.sourceId)) });
}
export function growthNativeChange(body: Pick<GrowthNativeExecution, "operation" | "quantity" | "amount">) {
  const field = { OFFER: "offeredUnits", DELIVER: "deliveredUnits", COLLECT: "collectedMinor", REFUND: "refundedMinor" }[body.operation];
  const value = body.quantity ?? Number(body.amount!.minor);
  if (!Number.isSafeInteger(value) || value <= 0 || value > 1e9) throw Error("W4_ADMITTED_NATIVE_NUMERIC_RANGE_UNSUPPORTED");
  return { field, value, unit: body.quantity === null ? "minor_" + body.amount!.currency : "commercial_unit" };
}
export async function growthExecutions(ctx: PeMutationContext, row: GrowthRequestRow, c: PoolClient) {
  const refs = (await c.query<{ source_id: string; version_id: string; content_digest: string }>(`SELECT l.*
   FROM finnor_os.w4_original_source_links l JOIN finnor_os.evidence_source_versions v
    ON v.tenant_id=l.tenant_id AND v.id=l.version_id AND v.source_id=l.source_id
   WHERE l.tenant_id=$1 AND l.principal_id=$2 AND l.author_id=$2 AND l.work_id=$3 AND l.kind='NATIVE'
    AND v.content::jsonb->'scope'->>'businessAssignmentId'=$4 ORDER BY l.created_at,l.source_id LIMIT 1025`,
  [row.tenant_id, row.principal_id, row.work_id, row.business_assignment_id])).rows;
  if (refs.length > 1024) throw Error("W4_NATIVE_BINDING_BOUND_INCOMPLETE");
  const result: GrowthExecutionOriginal[] = [], identities = new Set<string>(), semanticKeys = new Set<string>();
  const originals = refs.map(ref => ({ sourceId: ref.source_id, versionId: ref.version_id, contentDigest: ref.content_digest }));
  const sources = await growthSourceOriginals(ctx, row.work_id, originals, c, false);
  for (const [index, source] of sources.entries()) {
    const body = growthNativeExecutionSchema.parse(JSON.parse(source.content)), key = growthExecutionRecordKey(body);
    if (identities.has(body.obligationRef.id) || semanticKeys.has(key)) throw Error("W4_NATIVE_IDENTITY_REBOUND");
    identities.add(body.obligationRef.id); semanticKeys.add(key); result.push({ ref: originals[index]!, body });
  }
  return result;
}
export async function assertNativeGrowthBinding(ctx: PeMutationContext, row: GrowthRequestRow,
  program: MarketValidatedOperatingProgram, body: GrowthNativeExecution): Promise<DurableObligation> {
  const offer = program.offers.find(o => o.id === body.offerId && o.termsDigest === body.termsDigest);
  if (!sameScope(body.scope, program.scope) || !same(body.parentAllocation, row.parent_allocation) || !offer
    || !program.assignedExposure.some(a => a.buyerId === body.buyerId && a.offerId === body.offerId
      && a.termsDigest === body.termsDigest) || body.amount && body.amount.currency !== offer.unitPrice.currency)
    throw Error("W4_NATIVE_EXACT_ORIGINAL_BUYER_OFFER_TERMS_REQUIRED");
  const execution = ObligationOperationSchemas["schedule-request"].parse(body.execution);
  const obligation = await readEnterpriseDurableObligation(ctx, body.obligationRef);
  const budget = await readEnterpriseDurableObligation(ctx, row.budget_obligation_ref);
  const ir = nativeGrowthIRSchema.parse(execution.request.ir), change = growthNativeChange(body), member = ir.members[0]!;
  if (!same(obligation.allocationRef, row.parent_allocation) || !same(ir.allocationRef, row.parent_allocation)
    || !same(ir.obligationRef, body.obligationRef) || !same(ir.effectRef, obligation.effectRef)
    || !same(obligation.mandateRef, budget.mandateRef) || obligation.rightsRef !== budget.rightsRef
    || obligation.workLineage?.workId !== row.work_id || obligation.workLineage.workInputId !== row.work_input_id
    || ir.tenantId !== row.tenant_id || ir.principalId !== row.principal_id
    || execution.request.ref.contentDigest !== hash(execution.request.ir)
    || member.semantic.operation !== "SERVICE_TRANSITION_V1" || member.semantic.unit !== change.unit
    || member.semantic.dose !== change.value || member.semantic.target.entityType !== "external_organization"
    || member.semantic.target.entityId !== row.company_id || member.request.applicationAccountId !== body.applicationAccountId
    || member.request.recordKey !== growthExecutionRecordKey(body)
    || !same(member.request.changes, { [change.field]: change.value }))
    throw Error("W4_ADMITTED_NATIVE_EXACT_COMMERCIAL_TRANSITION_REQUIRED");
  return obligation;
}
export async function readGrowthNativeEffects(ctx: PeMutationContext, executions: GrowthExecutionOriginal[],
  original: { row: GrowthRequestRow; program: MarketValidatedOperatingProgram }) {
  const effects: EffectObservation[] = [], gaps: string[] = [];
  const scope = { semanticOwner: "S6", tenantId: ctx.auth.tenantId, principalId: principal(ctx) };
  for (let offset = 0; offset < executions.length; offset += 8) {
    const batch = executions.slice(offset, offset + 8);
    const bindings = await Promise.allSettled(batch.map(({ body }) => assertNativeGrowthBinding(ctx, original.row, original.program, body)));
    const authorized = bindings.flatMap(binding => binding.status === "fulfilled" ? [binding.value.ref.id] : []);
    const answers = authorized.length ? await readOwnerTransportExecutionHandoffs(scope, authorized)
      .catch(reason => authorized.map(() => ({ status: "rejected" as const, reason }))) : [];
    const byId = new Map(authorized.map((id, index) => [id, answers[index]!]));
    for (const [index, { body }] of batch.entries()) {
      let state: EffectObservation["state"] = "UNKNOWN", originalIdentityReadback = false;
      let notBeforeAt: string | undefined;
      try {
        const binding = bindings[index]!;
        if (binding.status === "rejected") throw binding.reason;
        const answer = byId.get(binding.value.ref.id)!;
        if (answer.status === "rejected") throw answer.reason;
        const { handoff } = answer.value;
        if (!same(handoff.obligation.ref, body.obligationRef)) throw Error("W4_NATIVE_READBACK_IDENTITY_MISMATCH");
        const ir = nativeGrowthIRSchema.parse(body.execution.request.ir), member = ir.members[0]!, change = growthNativeChange(body);
        if (body.execution.request.ref.contentDigest !== hash(body.execution.request.ir)
          || handoff.request && same(handoff.request.ref, body.execution.request.ref)
            && !same(handoff.request.ir, body.execution.request.ir)
          || member.request.recordKey !== growthExecutionRecordKey(body)
          || member.request.applicationAccountId !== body.applicationAccountId
          || member.semantic.operation !== "SERVICE_TRANSITION_V1" || member.semantic.unit !== change.unit
          || member.semantic.dose !== change.value || !same(member.request.changes, { [change.field]: change.value }))
          throw Error("W4_NATIVE_READBACK_EXACT_TRANSACTION_MISMATCH");
        const verified = handoff.settlements.some((s: { event: { detail: { status: string; requestRef: NativeRef } } }) =>
          s.event.detail.status === "VERIFIED" && same(s.event.detail.requestRef, body.execution.request.ref));
        state = verified && same(handoff.request?.ref, body.execution.request.ref)
          ? "VERIFIED" : handoff.attempts.length ? "UNKNOWN" : "NOT_ATTEMPTED";
        notBeforeAt = handoff.attempts[0]?.event.knowledgeAt;
        originalIdentityReadback = true;
      } catch (error) { gaps.push(growthPredicate(error) + ":" + body.obligationRef.id) }
      effects.push({ ref: body.obligationRef, kind: body.operation, buyerId: body.buyerId, offerId: body.offerId,
        termsDigest: body.termsDigest, state, quantity: body.quantity, amount: body.amount, originalIdentityReadback,
        basisSourceIds: body.basis.map(ref => ref.sourceId), ...(notBeforeAt ? { notBeforeAt } : {}) });
    }
  }
  return { effects, gaps };
}
export function growthOperationGap(input: GrowthInput, program: MarketValidatedOperatingProgram,
  originals: EventOriginal[], effects: EffectObservation[], body: GrowthNativeExecution, now: number, current: boolean) {
  const offer = program.offers.find(o => o.id === body.offerId && o.termsDigest === body.termsDigest);
  if (!offer) return "W4_EXACT_CHECKED_OFFER_REQUIRED";
  const projection = projectOperatingProgram(input, program, originals, effects, now, current);
  const commitment = projection.commitments.find(c => c.buyerId === body.buyerId && c.offerId === body.offerId
    && c.termsDigest === body.termsDigest);
  if (input.reservedDecisions.length) return "W4_ORIGINAL_RESERVED_DECISION_UNRESOLVED";
  if (effects.some(e => e.buyerId === body.buyerId && e.offerId === body.offerId && e.termsDigest === body.termsDigest
    && e.state === "UNKNOWN" && !same(e.ref, body.obligationRef))) return "W4_ORIGINAL_IDENTITY_READBACK_REQUIRED";
  if (body.operation === "OFFER") {
    if (!current || projection.currentness !== "CURRENT" || ["STOP", "HOLD_UNKNOWN", "ITERATE"].includes(projection.decision)
      || now >= Date.parse(input.test.closesAt)) return "W4_NEW_EXPOSURE_NOT_CURRENT_OR_TEST_STOPPED";
    if (!body.quantity || body.quantity > input.terms.maximumUnitsPerBuyer || commitment)
      return "W4_ORIGINAL_ASSIGNED_EXPOSURE_QUANTITY_EXCEEDED";
    if (effects.some(e => e.kind === "OFFER" && e.buyerId === body.buyerId && e.offerId === body.offerId
      && !same(e.ref, body.obligationRef))) return "W4_BUYER_ALREADY_ASSIGNED_OR_POSSIBLY_CONTACTED";
  } else if (!commitment) return "W4_ORIGINAL_BUYER_COMMITMENT_REQUIRED";
  else if (body.operation === "DELIVER") {
    const alreadyDelivered = effects.filter(e => e.kind === "DELIVER" && e.state === "VERIFIED"
      && e.buyerId === body.buyerId && e.offerId === body.offerId && e.termsDigest === body.termsDigest)
      .reduce((n, e) => n + (e.quantity ?? 0), 0);
    if (body.quantity !== commitment.quantity - alreadyDelivered) return "W4_ORIGINAL_REMAINING_DELIVERY_QUANTITY_REQUIRED";
  } else if (body.operation === "COLLECT") {
    const collections = effects.filter(e => e.kind === "COLLECT" && e.state === "VERIFIED"
      && e.buyerId === body.buyerId && e.offerId === body.offerId && e.termsDigest === body.termsDigest);
    const collected = collections.reduce((n, e) => n + BigInt(e.amount?.minor ?? "0"), 0n);
    if (!body.amount || collected + BigInt(body.amount.minor) > BigInt(offer.unitPrice.minor) * BigInt(commitment.quantity))
      return "W4_ORIGINAL_CONTRACT_COLLECTION_LIMIT_EXCEEDED";
    if (!body.basis.length) return "W4_ORIGINAL_INVOICE_REQUIRED";
    if (collections.some(e => e.basisSourceIds?.some(id => body.basis.some(ref => ref.sourceId === id))))
      return "W4_ORIGINAL_INVOICE_ALREADY_CONSUMED";
  } else if (body.operation === "REFUND") {
    const requests = originals.filter(o => body.basis.some(ref => same(ref, o.ref)) && o.role === "BUYER"
      && o.body.kind === "REFUND" && o.body.status === "REQUESTED" && o.body.buyerId === body.buyerId
      && o.body.offerId === body.offerId && o.body.termsDigest === body.termsDigest);
    if (!body.amount || requests.length !== 1 || requests[0]!.body.kind !== "REFUND"
      || !same(requests[0]!.body.amount, body.amount)) return "W4_ORIGINAL_BUYER_REFUND_REQUEST_REQUIRED";
    const collected = effects.filter(e => e.kind === "COLLECT" && e.state === "VERIFIED"
      && e.buyerId === body.buyerId && e.offerId === body.offerId && e.termsDigest === body.termsDigest)
      .reduce((n, e) => n + BigInt(e.amount?.minor ?? "0"), 0n);
    if (BigInt(body.amount.minor) > collected) return "W4_ORIGINAL_VERIFIED_COLLECTION_REFUND_LIMIT_EXCEEDED";
    if (effects.some(e => e.kind === "REFUND" && e.buyerId === body.buyerId && e.offerId === body.offerId
      && !same(e.ref, body.obligationRef))) return "W4_ORIGINAL_REFUND_ALREADY_POSSIBLY_PAID";
  }
  return null;
}
async function assertGrowthNativeBasis(ctx: PeMutationContext, row: GrowthRequestRow, input: GrowthInput, body: GrowthNativeExecution) {
  return growthTx(ctx, async c => {
    if (body.operation === "COLLECT" && body.basis.length !== 1) throw Error("W4_ONE_EXACT_ORIGINAL_INVOICE_REQUIRED");
    for (const ref of body.basis) {
      const source = await growthSourceOriginal(ctx, row.work_id, ref, c, body.operation === "OFFER");
      if (body.operation !== "COLLECT") continue;
      const invoice = growthEvidenceSchema.parse(JSON.parse(source.content));
      const accountant = (await c.query(`SELECT 1 FROM finnor_os.w4_participant_protocols p
       WHERE p.tenant_id=$1 AND p.id=$2 AND p.participant_id=$3 AND p.work_id=$4
        AND p.business_assignment_id=$5 AND p.role='ACCOUNTANT' AND p.consent_at<=$6
        AND p.expires_at>$6 AND (p.revoked_at IS NULL OR p.revoked_at>$6)`,
      [row.tenant_id, source.protocol_id, source.author_id, row.work_id, row.business_assignment_id, source.created_at])).rows[0];
      if (invoice.kind !== "INVOICE" || !accountant || source.author_id === body.buyerId || source.author_id === row.principal_id
        || input.capabilities.some(cap => cap.operatorId === source.author_id)
        || input.population.some(buyer => buyer.buyerId === source.author_id)
        || !sameScope(invoice.scope, body.scope) || !same(invoice.data, {
          buyerId: body.buyerId, offerId: body.offerId, termsDigest: body.termsDigest, amount: body.amount }))
        throw Error("W4_ORIGINAL_EXACT_INDEPENDENT_INVOICE_REQUIRED");
    }
  });
}
export async function readGrowthCut(ctx: PeMutationContext, requestId: string) {
  return growthTx(ctx, async c => {
    const row = await growthRequest(ctx, requestId, c);
    const artifact = await growthArtifact(ctx, row, c);
    const observations = await growthEventOriginals(ctx, row, c), gaps = [...observations.gaps];
    let current = true;
    let input: Awaited<ReturnType<typeof loadGrowthInput>>;
    try { ({ input } = await currentGrowthCut(ctx, row, c)) } catch (error) {
      current = false; gaps.push(growthPredicate(error));
      input = await loadGrowthInput(ctx, row, c, false);
    }
    if (artifact && checkOperatingProgram(input, artifact.body, row.identity, Date.parse(artifact.body.compiledAt))
      .disposition !== "CHECKED_DEVELOPMENT") throw Error("W4_ARTIFACT_ORIGINAL_CHECK_REJECTED");
    return { row, input, artifact, current, gaps, originals: observations.originals,
      executions: await growthExecutions(ctx, row, c) };
  });
}
export async function consumeGrowthProgram(ctx: PeMutationContext, requestId: string, assertClaim: () => Promise<void>) {
  requireGrowthProfile();
  const cut = await readGrowthCut(ctx, requestId);
  if (!cut.artifact) return { projection: null, scheduled: [], gaps: ["W4_CHECKED_ARTIFACT_PENDING"] };
  const native = await readGrowthNativeEffects(ctx, cut.executions, { row: cut.row, program: cut.artifact.body });
  const scheduled: Array<Awaited<ReturnType<typeof scheduleEnterpriseDurableObligationRequest>>> = [];
  const gaps = [...cut.gaps, ...native.gaps];
  for (const { body } of cut.executions) {
    if (!native.effects.some(e => same(e.ref, body.obligationRef) && e.state === "NOT_ATTEMPTED")) continue;
    try {
      await assertClaim();
      const fresh = await readGrowthCut(ctx, requestId);
      if (!fresh.artifact || fresh.artifact.body_digest !== cut.artifact.body_digest) throw Error("W4_ARTIFACT_CHANGED_BEFORE_NATIVE_USE");
      await assertNativeGrowthBinding(ctx, fresh.row, fresh.artifact.body, body);
      const gap = growthOperationGap(fresh.input, fresh.artifact.body, fresh.originals, native.effects, body, growthNow(), fresh.current);
      if (gap) { gaps.push(gap + ":" + body.offerId); continue }
      await assertGrowthNativeBasis(ctx, fresh.row, fresh.input, body);
      if ((await validateEnterpriseAllocation(ctx, fresh.row.parent_allocation)).status !== "CURRENT")
        throw Error("W4_ORIGINAL_S5_ALLOCATION_NOT_CURRENT");
      scheduled.push(await scheduleEnterpriseDurableObligationRequest(ctx, body.execution));
    } catch (error) { gaps.push(growthPredicate(error) + ":" + body.offerId) }
  }
  return { projection: projectOperatingProgram(cut.input, cut.artifact.body, cut.originals, native.effects, growthNow(), cut.current),
    scheduled, gaps: [...new Set(gaps)] };
}
/** Exact programme ownership selection at the real S6 nonce/egress boundary.
 * This also prevents a same-Work W3 programme from denying an unrelated W4 member. */
export async function growthDispatchAssessment(ctx: PeMutationContext, obligation: DurableObligation, requestRef: NativeRef) {
  if (!obligation.workLineage) return { handled: false, reasons: [] as string[] };
  const rows = await growthTx(ctx, async c => (await c.query<GrowthRequestRow>(`SELECT * FROM finnor_os.w4_business_requests
   WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY id LIMIT 33`,
  [ctx.auth.tenantId, principal(ctx), obligation.workLineage!.workId])).rows);
  if (rows.length > 32) return { handled: true, reasons: ["W4_DISPATCH_DEPENDENCY_BOUND_INCOMPLETE"] };
  let matching: { row: GrowthRequestRow; link: GrowthExecutionOriginal } | null = null;
  for (const row of rows) {
    const links = await growthTx(ctx, c => growthExecutions(ctx, row, c));
    for (const link of links.filter(l => same(l.body.obligationRef, obligation.ref))) {
      if (matching) return { handled: true, reasons: ["W4_NATIVE_IDENTITY_REBOUND"] };
      matching = { row, link };
    }
  }
  if (!matching) return { handled: false, reasons: [] as string[] };
  try {
    requireGrowthProfile();
    const { row, link } = matching;
    if (!same(link.body.execution.request.ref, requestRef)) throw Error("W4_NATIVE_IDENTITY_REBOUND");
    const cut = await readGrowthCut(ctx, row.id);
    if (!cut.artifact) throw Error("W4_CHECKED_ARTIFACT_REQUIRED_AT_DISPATCH");
    await assertNativeGrowthBinding(ctx, row, cut.artifact.body, link.body);
    await assertGrowthNativeBasis(ctx, row, cut.input, link.body);
    const native = await readGrowthNativeEffects(ctx, cut.executions.filter(l => !same(l.body.obligationRef, obligation.ref)),
      { row: cut.row, program: cut.artifact.body });
    const gap = growthOperationGap(cut.input, cut.artifact.body, cut.originals, native.effects, link.body, growthNow(), cut.current);
    return { handled: true, reasons: gap ? [gap] : [] };
  } catch (error) { return { handled: true, reasons: [growthPredicate(error)] } }
}
export async function advanceGrowthProgram(ctx: PeMutationContext, raw: unknown) {
  requireGrowthProfile();
  const input = growthOperationSchemas.advance.parse(raw);
  return growthTx(ctx, async c => {
    const row = await growthRequest(ctx, input.requestId, c, true), artifact = await growthArtifact(ctx, row, c);
    if (!artifact || artifact.body_digest !== input.expectedArtifactDigest) throw Error("W4_CURRENT_ARTIFACT_REQUIRED");
    const next = (await c.query<GrowthRequestRow>(`UPDATE finnor_os.w4_business_requests
     SET wake_revision=wake_revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 RETURNING *`,
    [row.tenant_id, row.id])).rows[0]!;
    await enqueueGrowth(c, next, false);
    return { requestId: row.id, status: "QUEUED_NATIVE_REVALIDATION", executionAuthorityGranted: false };
  });
}
export async function readGrowthWork(ctx: PeMutationContext, raw: unknown) {
  requireGrowthProfile();
  const input = growthOperationSchemas.read.parse(raw);
  const rows = await growthTx(ctx, async c => {
    await authorizeGrowthWork(ctx, input.workId, c);
    const rows = (await c.query<GrowthRequestRow>(`SELECT * FROM finnor_os.w4_business_requests
     WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY created_at,id LIMIT 33`,
    [ctx.auth.tenantId, principal(ctx), input.workId])).rows;
    if (rows.length > 32) throw Error("W4_WORK_ASSIGNMENT_READ_BOUND_INCOMPLETE");
    return rows;
  });
  const requests: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const cut = await readGrowthCut(ctx, row.id);
    const native = cut.artifact ? await readGrowthNativeEffects(ctx, cut.executions, { row: cut.row, program: cut.artifact.body })
      : { effects: [], gaps: cut.executions.length ? ["W4_CHECKED_ARTIFACT_REQUIRED_BEFORE_NATIVE_READBACK"] : [] };
    const gaps = [...cut.gaps, ...native.gaps];
    let budgets: unknown = null;
    try { budgets = await readEnterpriseDurableObligationBudgets(ctx, { obligationRef: row.budget_obligation_ref }) }
    catch (error) { gaps.push(growthPredicate(error)) }
    const projection = cut.artifact
      ? projectOperatingProgram(cut.input, cut.artifact.body, cut.originals, native.effects, growthNow(), cut.current) : null;
    const product = await growthOwnerProductInfo(ctx, row, cut.input);
    requests.push({ requestId: row.id, status: cut.current ? row.status : "STALE_RESPONSIBILITY_RETAINED",
      generation: row.generation, originalDeadlineAt: row.original_deadline.toISOString(),
      artifactDigest: cut.artifact?.body_digest ?? null, program: cut.artifact?.body ?? null,
      check: cut.artifact?.check_result ?? null, projection, nativeEffects: native.effects, budgets, product,
      nativeOriginals: cut.executions.map(e => ({ source: e.ref, operation: e.body.operation,
        buyerId: e.body.buyerId, offerId: e.body.offerId, termsDigest: e.body.termsDigest,
        quantity: e.body.quantity, amount: e.body.amount, obligationRef: e.body.obligationRef })),
      gaps: [...new Set(gaps)] });
  }
  return { scope: { tenantId: ctx.auth.tenantId, principalId: principal(ctx), workId: input.workId }, requests,
    preparedOutcomes: await growthPreparedOutcomes(ctx, input.workId),
    complete: true, qualification: "CONTROLLED_DEVELOPMENT_ONLY", fieldValidated: false, admissionGranted: false };
}

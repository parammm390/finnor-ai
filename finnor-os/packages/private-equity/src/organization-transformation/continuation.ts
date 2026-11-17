import type { PoolClient } from "pg";
import type { TenantContext } from "@finnor/shared-types";
import type { z } from "zod";
import { readEnterpriseDurableObligationExecutionHandoff } from "../enterprise-obligations";
import { organizationCanonical, organizationDigest } from "./compiler";
import { checkOrganizationTransformation } from "./checker";
import { organizationEffectContinuation, organizationEffectObservation } from "./native-contracts";
import { inspectOrganizationDependenciesTx } from "./dependencies";
import { inspectOrganizationObligationPopulationTx } from "./population";
import { readOrganizationEvidenceTx, resolveOrganizationSourcesTx } from "./sources";
import { orgActor, orgAuthority, orgCurrent, orgEvent, orgEvidence, orgFail, orgLock, orgRow, orgTx, rawDigest } from "./store";

type ObservationInput = z.infer<typeof organizationEffectObservation>;
interface CoreEffectRow {
  action_id: string; action_status: string; action_type: string; work_id: string;
  effect_id: string; effect_status: string; semantic_hash: string; version: number;
}

/** The native Core/S5 owners remain authoritative. In particular, a prepared
 * packet and its acknowledgment are never substituted for a confirmed episode. */
async function continuationContextTx(ctx: TenantContext, input: ObservationInput, c: PoolClient) {
  await orgActor(ctx, c, true);
  const q = await orgRow(ctx, input.requestId, c, true);
  await orgAuthority(ctx, c, q.work_id, false);
  if (organizationDigest(q.original) !== q.original_digest ||
      q.program && organizationDigest(q.program) !== q.program_digest) orgFail("W5_IMMUTABLE_PREIMAGE_CHANGED");
  const population = await inspectOrganizationObligationPopulationTx(ctx, q, c);
  if (population.status !== "READY") orgFail("W5_COMPLETE_ORIGINAL_CONTINUATION_POPULATION_REQUIRED");
  const obligation = population.obligations.find(o => o.id === input.obligationId);
  if (!obligation || obligation.workId !== input.workId || obligation.processId !== input.processId ||
      obligation.effectRefs.length !== 1) orgFail("W5_EXACT_BOUND_ORIGINAL_EFFECT_ROUTE_REQUIRED");
  const process = q.original.organization.processes.find(p => p.id === input.processId);
  if (!q.program || checkOrganizationTransformation(q.original, q.program).status !== "CHECKED")
    orgFail("W5_INDEPENDENT_CURRENT_CONTINUATION_GRAPH_CHECK_REQUIRED");
  const alternative = q.program?.alternatives.find(a => a.id === q.program?.selectedAlternativeId);
  const destination = alternative?.processes.find(p => p.id === input.processId)?.nodes.find(n => n.id === obligation.nodeId);
  if (!process || !destination || destination.roleId !== obligation.accountableRoleId)
    orgFail("W5_UNCHANGED_ACCOUNTABLE_CONTINUATION_DESTINATION_REQUIRED");
  const ancestors = new Set<string>([obligation.nodeId]);
  for (let i = 0; i < process.nodes.length; i++)
    for (const node of process.nodes) if (ancestors.has(node.id)) node.after.forEach(id => ancestors.add(id));
  const controls = process.nodes.filter(n => n.mandatory && n.kind === "APPROVE" && ancestors.has(n.id));
  if (!controls.length) orgFail("W5_ORIGINAL_APPROVAL_CONTROL_ROUTE_REQUIRED");
  const use = (await c.query(`SELECT source_ref,result FROM finnor_os.w5_process_uses
    WHERE tenant_id=$1 AND request_id=$2 AND use_key=$3 AND work_id=$4 AND process_id=$5`,
    [ctx.tenantId, q.id, input.useKey, input.workId, input.processId])).rows[0];
  if (!use || use.result?.approvalGranted !== false || use.result?.externalEffectDispatched !== false)
    orgFail("W5_ACTUAL_ORIGINAL_PROCESS_USE_REQUIRED");
  const packet = await readOrganizationEvidenceTx(ctx, use.source_ref, c);
  if (packet.record.schema !== "finnor.organization-prepared-packet.v1" || packet.record.requestId !== q.id ||
      packet.record.workId !== input.workId || packet.record.processId !== input.processId)
    orgFail("W5_ORIGINAL_USE_PACKET_PREIMAGE_REQUIRED");
  const reads: Array<{ controlId: string; principalId: string; readRef: unknown; readAt: Date }> = [];
  for (const control of controls) {
    const role = q.original.organization.roles.find(r => r.id === control.roleId);
    const retained = alternative?.processes.find(p => p.id === process.id)?.nodes.find(n => n.id === control.id);
    if (!role || !retained || organizationDigest({ ...retained, after: [] }) !== organizationDigest({ ...control, after: [] }))
      orgFail("W5_ORIGINAL_APPROVER_CONTROL_CHANGED");
    const row = (await c.query(`SELECT d.recipient_id,d.terms_digest,d.packet_ref,d.disclosure,d.disclosure_digest,
      r.source_ref,r.created_at FROM finnor_os.w5_control_deliveries d
      JOIN finnor_os.w5_control_reads r ON r.tenant_id=d.tenant_id AND r.request_id=d.request_id
        AND r.use_key=d.use_key AND r.control_id=d.control_id AND r.participant_id=d.recipient_id
      WHERE d.tenant_id=$1 AND d.request_id=$2 AND d.use_key=$3 AND d.control_id=$4 AND d.work_id=$5
        AND r.terms_digest=d.terms_digest AND r.packet_ref=d.packet_ref AND r.disclosure_digest=d.disclosure_digest`,
      [ctx.tenantId, q.id, input.useKey, control.id, input.workId])).rows[0];
    if (!row || row.recipient_id !== role.principalId || row.disclosure_digest !== organizationDigest(row.disclosure) ||
        organizationDigest(row.packet_ref) !== organizationDigest(use.source_ref))
      orgFail("W5_ACTUAL_ORIGINAL_APPROVER_PACKET_READ_REQUIRED");
    const receipt = await readOrganizationEvidenceTx(ctx, row.source_ref, c);
    if (receipt.metadata.authenticatedPrincipal !== role.principalId ||
        receipt.record.schema !== "finnor.organization-original-control-self-read.v1" ||
        receipt.record.authenticatedPrincipalId !== role.principalId || receipt.record.requestId !== q.id ||
        receipt.record.useKey !== input.useKey || receipt.record.controlId !== control.id ||
        receipt.record.termsDigest !== row.terms_digest || receipt.record.disclosureDigest !== row.disclosure_digest ||
        organizationDigest(receipt.record.packetRef) !== organizationDigest(use.source_ref) ||
        receipt.record.approvalGranted !== false)
      orgFail("W5_AUTHENTICATED_ORIGINAL_CONTROL_READ_PREIMAGE_REQUIRED");
    reads.push({ controlId: control.id, principalId: role.principalId, readRef: row.source_ref, readAt: row.created_at });
  }
  const effectRef = obligation.effectRefs[0]!;
  const core = (await c.query<CoreEffectRow>(`SELECT a.id action_id,a.status action_status,a.action_type,a.work_id,
    e.id effect_id,e.status effect_status,e.semantic_hash,e.version
    FROM finnor_os.domain_actions a JOIN finnor_os.business_effects e
      ON e.tenant_id=a.tenant_id AND e.domain_action_id=a.id AND a.business_effect_id=e.id
    WHERE a.tenant_id=$1 AND a.work_id=$2 AND e.id=$3 FOR SHARE OF a,e`,
    [ctx.tenantId, input.workId, effectRef.id])).rows[0];
  if (!core || core.semantic_hash !== effectRef.contentDigest || "business-effect-v" + core.version !== effectRef.version)
    orgFail("W5_EXACT_CURRENT_ORIGINAL_CORE_EFFECT_REQUIRED");
  const confirmation = (await c.query(`SELECT id,input,output,timestamp FROM finnor_os.action_log
    WHERE tenant_id=$1 AND domain_action_id=$2 AND step='confirmed'
    ORDER BY timestamp DESC,id DESC LIMIT 1`, [ctx.tenantId, core.action_id])).rows[0];
  const confirmer = reads.find(r => r.principalId === confirmation?.input?.by);
  const confirmed = !!confirmer && confirmation.output?.businessEffectId === core.effect_id &&
    confirmation.output?.authorizedEffectHash === core.semantic_hash &&
    reads.every(r => confirmation.timestamp.getTime() >= r.readAt.getTime());
  const authorization = (await c.query(`SELECT id,output FROM finnor_os.action_log
    WHERE tenant_id=$1 AND domain_action_id=$2 AND step='execution_authorized'
      AND output->>'businessEffectId'=$3 AND output->>'authorizedEffectHash'=$4
    ORDER BY timestamp DESC,id DESC LIMIT 1`,
    [ctx.tenantId, core.action_id, core.effect_id, core.semantic_hash])).rows[0];
  const operations = population.manifest.operations.filter(o => o.effectId === core.effect_id);
  const attempts = population.manifest.providerAttempts.filter(a => a.effectId === core.effect_id);
  const reservation = population.manifest.reservations.find(r => r.id === obligation.reservationRef.id);
  if (!reservation) orgFail("W5_ORIGINAL_LIABILITY_RESERVATION_REQUIRED");
  const possibleDispatch = !!authorization || operations.length > 0 || attempts.length > 0 ||
    ["executing", "completed"].includes(core.action_status) ||
    !["compiled", "authorized"].includes(core.effect_status) ||
    ["UNKNOWN", "MAY_HAVE_LEFT", "DISPATCHED", "DISPUTED", "SETTLED"].includes(obligation.state);
  const result = {
    schema: "finnor.organization-original-effect-continuation.v1" as const,
    requestId: q.id, obligationId: obligation.id, processId: input.processId, useKey: input.useKey,
    originalWorkId: obligation.workId, originalMeaningDigest: obligation.meaningDigest,
    originalTermsDigest: obligation.termsDigest, originalDeadline: obligation.deadline,
    originalNativeDeadlines: obligation.canonical?.deadlines ?? null,
    originalReservationRef: obligation.reservationRef, originalConsumptionRef: obligation.canonical?.consumptionRef ?? null,
    originalEffectRef: effectRef, originalActionId: core.action_id, originalCoreActionStatus: core.action_status,
    originalCoreEffectStatus: core.effect_status, obligationState: obligation.state,
    originalExecutionOwner: obligation.canonical ? "S6" as const : "CORE" as const,
    originalControlReads: reads, originalCoreConfirmationId: confirmed ? confirmation.id as string : null,
    originalApproverConfirmedExactEffect: confirmed,
    originalExecutionAuthorization: authorization ? { episodeId: authorization.id, ...authorization.output } : null,
    originalOperations: operations, originalProviderAttempts: attempts, reservationStatus: reservation.status,
    consumedMinor: null, unresolvedMinor: null, currency: null, unknownMoneyRetained: true,
    status: obligation.canonical ? "AWAITING_ORIGINAL_S6_OWNER_READBACK" : !confirmed ? "AWAITING_ORIGINAL_CORE_APPROVAL" : possibleDispatch
      ? "OBSERVE_ORIGINAL_CORE_OWNER_ONLY" : "ORIGINAL_APPROVAL_OBSERVED_NOT_YET_DISPATCHED",
    populationDigest: population.populationDigest, executionAuthorityGranted: false,
    approvalGranted: false, resourcesReleased: false, resourcesRenewed: false, effectsRetried: false,
    fieldBenefitEstablished: false, qualification: "ORIGINAL_OWNER_READBACK_NOT_NEW_APPROVAL_OR_SETTLEMENT",
  };
  const originalS6OriginDigest = population.manifest.nativeS6Origins.find(origin =>
    origin.effectId === core.effect_id &&
    origin.obligationRef.id === obligation.canonical?.obligationRef.id)?.preimageDigest ?? null;
  return { q, obligation, core, confirmer, confirmed, possibleDispatch, result, originalS6OriginDigest };
}

type ContinuationContext = Awaited<ReturnType<typeof continuationContextTx>>;

async function retainOriginalS6Readback(ctx: TenantContext, current: ContinuationContext,
  readback: Awaited<ReturnType<typeof readEnterpriseDurableObligationExecutionHandoff>>, idempotencyKey: string, c: PoolClient) {
  const { q, obligation } = current;
  const key = "original-s6-readback:" + q.id + ":" + idempotencyKey;
  const record = {
    schema: "finnor.organization-original-s6-owner-readback.v1", requestId: q.id,
    originalObligationRef: obligation.canonical!.obligationRef, actualSignedHandoff: readback,
    callerApprovalInferred: false, executionAuthorityGranted: false,
  };
  if (Buffer.byteLength(organizationCanonical(record)) <= 262_144)
    return orgEvidence(ctx, obligation.workId, key, record, c);

  const bytes = Buffer.from(organizationCanonical(readback));
  if (bytes.length > 2 * 1024 * 1024) orgFail("W5_ORIGINAL_S6_READBACK_EVIDENCE_BYTE_BOUND");
  const chunkKey = "original-s6-readback-part:" + q.id + ":" + organizationDigest(idempotencyKey);
  const chunkBytes = 144 * 1024;
  const chunks: { index: number; bytes: number; ref: Awaited<ReturnType<typeof orgEvidence>>["ref"] }[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    const index = chunks.length;
    const chunk = bytes.subarray(offset, offset + chunkBytes);
    const source = await orgEvidence(ctx, obligation.workId, chunkKey + ":" + index, {
      schema: "finnor.organization-original-s6-owner-readback-part.v1", requestId: q.id,
      originalObligationRef: record.originalObligationRef, index, base64: chunk.toString("base64"),
      executionAuthorityGranted: false,
    }, c);
    chunks.push({ index, bytes: chunk.length, ref: source.ref });
  }
  return orgEvidence(ctx, obligation.workId, key, {
    schema: "finnor.organization-original-s6-owner-readback-manifest.v1", requestId: q.id,
    originalObligationRef: record.originalObligationRef, bytes: bytes.length,
    sha256: rawDigest(bytes.toString("utf8")), encoding: "ORGANIZATION_CANONICAL_JSON_UTF8", chunks,
    callerApprovalInferred: false, executionAuthorityGranted: false,
  }, c);
}
async function continuationSnapshot(ctx: TenantContext, input: ObservationInput) {
  return orgTx(ctx, async c => {
    await orgLock(ctx, c);
    return continuationContextTx(ctx, input, c);
  });
}
function assertSameOriginalOwner(before: ContinuationContext, after: ContinuationContext) {
  if (before.q.original_digest !== after.q.original_digest ||
      before.core.effect_id !== after.core.effect_id || before.core.semantic_hash !== after.core.semantic_hash ||
      before.originalS6OriginDigest !== after.originalS6OriginDigest)
    orgFail("W5_ORIGINAL_CONTINUATION_OWNER_CHANGED_DURING_READBACK");
}

/** The S6 consumer verifies signatures, release pins, rights, every history
 * receipt, and the original obligation. W5 never supplies an expected receipt. */
async function originalS6Readback(ctx: TenantContext, current: ContinuationContext) {
  const original = current.obligation.canonical;
  if (!original) return null;
  let signed: Awaited<ReturnType<typeof readEnterpriseDurableObligationExecutionHandoff>>;
  try {
    signed = await readEnterpriseDurableObligationExecutionHandoff({ auth: ctx },
      { obligationRef: original.obligationRef });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return { signed: null, projection: {
      status: "ORIGINAL_S6_READBACK_UNAVAILABLE_RESPONSIBILITY_RETAINED",
      ownerReadback: { status: "UNAVAILABLE", reason: typeof code === "string" && /^[A-Z0-9_]{1,128}$/.test(code)
        ? code : "ORIGINAL_S6_HANDOFF_UNAVAILABLE" },
    } };
  }
  const handoff = signed.handoff;
  if (!current.originalS6OriginDigest || organizationDigest(handoff.obligation) !== current.originalS6OriginDigest ||
      organizationDigest(handoff.obligation.ref) !== organizationDigest(original.obligationRef) ||
      handoff.obligation.effectRef.id !== current.core.effect_id ||
      handoff.obligation.effectRef.semanticHash !== current.core.semantic_hash)
    orgFail("W5_SIGNED_S6_HANDOFF_ORIGINAL_PREIMAGE_CHANGED");
  if (Buffer.byteLength(JSON.stringify(signed)) > 2 * 1024 * 1024)
    orgFail("W5_ORIGINAL_S6_READBACK_EVIDENCE_BYTE_BOUND");
  const verified = handoff.settlements.some((row: { event: { detail: { status?: string } } }) =>
    row.event.detail.status === "VERIFIED");
  return { signed, projection: {
    status: verified ? "ORIGINAL_S6_VERIFIED_READBACK_LIABILITIES_RETAINED" : handoff.attempts.length
      ? "ORIGINAL_S6_POSSIBLE_EFFECT_OBSERVE_ONLY" : "ORIGINAL_S6_RESPONSIBILITY_RETAINED_NOT_DISPATCHED",
    ownerReadback: { status: "AUTHENTICATED_ORIGINAL_S6_HANDOFF", handoffDigest: organizationDigest(handoff),
      signature: signed.signature, knowledgeAt: handoff.knowledgeAt, checkpoint: handoff.checkpoint, release: handoff.release,
      obligationRef: original.obligationRef, attemptCount: handoff.attempts.length, observationCount: handoff.observations.length,
      verificationCount: handoff.settlements.length, originalVerificationObserved: verified,
      history: handoff.history.map((row: { event: { eventId: string; type: string }; receipt: {
        identity: string; sequence: number; checkpointDigest: string; protectedExecution?: boolean } }) => ({
        eventId: row.event.eventId, type: row.event.type, eventDigest: organizationDigest(row.event),
        receiptIdentity: row.receipt.identity, sequence: row.receipt.sequence,
        checkpointDigest: row.receipt.checkpointDigest, protectedExecution: row.receipt.protectedExecution === true,
      })),
      resourceReleaseGranted: false, attributionGranted: false, executionAuthorityGranted: false,
    },
  } };
}

export async function readOrganizationEffectContinuation(ctx: TenantContext, value: unknown) {
  const input = organizationEffectObservation.parse(value);
  const before = await continuationSnapshot(ctx, input), owner = await originalS6Readback(ctx, before);
  return orgTx(ctx, async c => {
    await orgLock(ctx, c);
    const current = await continuationContextTx(ctx, input, c);
    assertSameOriginalOwner(before, current);
    return { ...current.result, ...owner?.projection };
  });
}

/** Commit an at-most-once handoff intent before leaving the W5 transaction.
 * The API alone delegates an eligible original action to the normal Core
 * orchestrator. Lost responses or a previous intent cannot mint another permit. */
export async function prepareOrganizationEffectContinuation(ctx: TenantContext, value: unknown) {
  const input = organizationEffectContinuation.parse(value), requestDigest = organizationDigest(input);
  const before = await continuationSnapshot(ctx, input), owner = await originalS6Readback(ctx, before);
  return orgTx(ctx, async c => {
    await orgLock(ctx, c);
    const current = await continuationContextTx(ctx, input, c), { q } = current;
    assertSameOriginalOwner(before, current);
    const prior = (await c.query(`SELECT body,body_digest FROM finnor_os.w5_events
      WHERE tenant_id=$1 AND request_id=$2 AND event_key=$3`,
      [ctx.tenantId, q.id, "continuation-request:" + input.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.body_digest !== organizationDigest(prior.body) || prior.body.requestDigest !== requestDigest)
        orgFail("W5_CONTINUATION_IDEMPOTENCY_CONFLICT");
      const completed = (await c.query(`SELECT body,body_digest FROM finnor_os.w5_events
        WHERE tenant_id=$1 AND request_id=$2 AND event_key=$3`,
        [ctx.tenantId, q.id, "continuation-observation:" + input.idempotencyKey])).rows[0];
      if (completed && completed.body_digest !== organizationDigest(completed.body)) orgFail("W5_CONTINUATION_PREIMAGE_CHANGED");
      return { result: { ...(completed?.body.result ?? prior.body.result), semanticReplay: true },
        executeOriginalAction: null };
    }
    if (owner) {
      if (input.expectedRevision !== q.revision) orgFail("W5_CURRENT_CONTINUATION_REVISION_REQUIRED");
      const readback = owner.signed
        ? await retainOriginalS6Readback(ctx, current, owner.signed, input.idempotencyKey, c) : null;
      const result = { ...current.result, ...owner.projection, ownerReadbackRef: readback?.ref ?? null, semanticReplay: false };
      await orgEvent(ctx, q, "ORIGINAL_S6_CONTINUATION_OBSERVED", "continuation-request:" + input.idempotencyKey,
        { requestDigest, result }, c);
      return { result, executeOriginalAction: null };
    }
    const priorIntent = (await c.query(`SELECT event_key FROM finnor_os.w5_events WHERE tenant_id=$1 AND request_id=$2
      AND kind='ORIGINAL_EFFECT_CONTINUATION_INTENT' AND body->>'effectId'=$3 LIMIT 1`,
      [ctx.tenantId, q.id, current.core.effect_id])).rows[0];
    if (priorIntent || current.possibleDispatch || !current.confirmed) {
      const result = { ...current.result, ...(priorIntent ? { status: "UNKNOWN_PRIOR_CONTINUATION_OBSERVE_ONLY" } : {}),
        semanticReplay: false };
      await orgEvent(ctx, q, "ORIGINAL_EFFECT_CONTINUATION_OBSERVED", "continuation-request:" + input.idempotencyKey,
        { requestDigest, result }, c);
      return { result, executeOriginalAction: null };
    }
    if (input.expectedRevision !== q.revision || !q.program || !["TRIAL", "ACTIVE"].includes(q.program.status))
      orgFail("W5_CURRENT_MIGRATED_CONTINUATION_REVISION_REQUIRED");
    const canonical = await orgCurrent(ctx, q, c);
    await resolveOrganizationSourcesTx(ctx, canonical, c);
    if ((await inspectOrganizationDependenciesTx(ctx, q, c)).status !== "CURRENT")
      orgFail("W5_CURRENT_CONTINUATION_DEPENDENCIES_REQUIRED");
    if (current.core.action_status !== "approved" || current.core.effect_status !== "authorized" ||
        Date.parse(current.obligation.deadline) <= Date.now() ||
        current.obligation.canonical && Date.parse(current.obligation.canonical.deadlines.authorityExpiresAt) <= Date.now())
      orgFail("W5_ORIGINAL_APPROVED_UNDISPATCHED_ACTION_REQUIRED");
    const result = { ...current.result, status: "UNKNOWN_UNTIL_ORIGINAL_CORE_READBACK", semanticReplay: false };
    await orgEvent(ctx, q, "ORIGINAL_EFFECT_CONTINUATION_INTENT", "continuation-request:" + input.idempotencyKey,
      { requestDigest, effectId: current.core.effect_id, originalActionId: current.core.action_id,
        originalApproverId: current.confirmer!.principalId, result }, c);
    return { result, executeOriginalAction: { actionId: current.core.action_id, approvedBy: current.confirmer!.principalId } };
  });
}

/** Re-read canonical owners after Core returns or throws. The executor's
 * caller-shaped success output is deliberately not an input to this observer. */
export async function recordOrganizationEffectContinuationReadback(ctx: TenantContext, value: unknown) {
  const input = organizationEffectContinuation.parse(value);
  return orgTx(ctx, async c => {
    await orgLock(ctx, c);
    const current = await continuationContextTx(ctx, input, c);
    const result = { ...current.result, status: current.possibleDispatch ? current.result.status
      : "UNKNOWN_ORIGINAL_CORE_CONTINUATION_NOT_OBSERVED", semanticReplay: false };
    await orgEvent(ctx, current.q, "ORIGINAL_EFFECT_CONTINUATION_READBACK", "continuation-observation:" + input.idempotencyKey,
      { requestDigest: organizationDigest(input), result }, c);
    return result;
  });
}

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { receiveWork } from "@finnor/db";
import type { TenantContext } from "@finnor/shared-types";
import { canExerciseWorkforceAuthorityTx, workforceEmployeeAuthoritySnapshotTx } from "@finnor/authority";
import { reserveWorkforceBudgetTx, assertCurrentWorkforceAllocationAuthorityTx } from "../workforce-allocation";
import { organizationDigest, parseOrganizationTransformation } from "./compiler";
import { checkOrganizationTransformation } from "./checker";
import { organizationAction, organizationIntake, organizationSelfDecision, organizationSubmit,
  nativeOrganizationOriginal, organizationProcessUse, organizationReadQuery, organizationInputQuery,
  organizationOffersQuery } from "./native-contracts";
import { orgActor, orgAuthority, orgCurrent, orgEnqueue, orgEvent, orgEvidence, orgFail, orgLock, orgRow, orgTx,
  principal, rawDigest, type OrganizationRequestRow } from "./store";
import { resolveOrganizationSourcesTx, readOrganizationEvidenceTx } from "./sources";
import { inspectOrganizationDependenciesTx } from "./dependencies";
import { organizationSelfContractTx, projectOrganizationSelfOffersTx, type OrganizationSelfOffer } from "./audience";
import { assertOrganizationTrialProcessUseTx, organizationProcessUseIntentDigest,
  reserveOrganizationTrialUseMailboxTx } from "./trials";
export { registerOrganizationSource } from "./sources";
export { composeOrganizationObligation, composeOrganizationResourceConstraint } from "./bridges";
export { readOrganizationPackets, acknowledgeOrganizationPacket } from "./packets";
export { readOrganizationEffectContinuation, prepareOrganizationEffectContinuation,
  recordOrganizationEffectContinuationReadback } from "./continuation";
export { evaluateOrganizationOperation, readOrganizationEvaluation } from "./native-evaluation";
export { registerOrganizationTrial, readOrganizationTrial, recordOrganizationTrialObservation } from "./trials";
export type { OrganizationObligationComposition, OrganizationResourceConstraintComposition, NativeOrganizationOriginal } from "./native-contracts";
export type { OrganizationObligationCompositionResult, OrganizationResourceConstraintCompositionResult } from "./bridges";

const summary = (q: OrganizationRequestRow) => ({ id: q.id, requestId: q.id, workId: q.work_id, workInputId: q.work_input_id,
  status: q.status, revision: q.revision, programDigest: q.program_digest, originalDeadline: q.original_deadline.toISOString() });

/** Discovery of the actual immutable Core input, not a browser-supplied
 * declaration or permission to reserve resources or operate a new process. */
export async function readOrganizationOriginalInput(ctx: TenantContext, value: unknown) {
  const input = organizationInputQuery.parse(value);
  return orgTx(ctx, async c => {
    await orgAuthority(ctx, c, input.workId, true);
    const row = (await c.query(`SELECT w.created_by,w.status,i.id,i.created_by input_creator,
      octet_length(i.instruction_text) input_bytes,
      CASE WHEN octet_length(i.instruction_text)<=2097152 THEN i.instruction_text END instruction_text
      FROM finnor_os.works w JOIN finnor_os.work_inputs i ON i.tenant_id=w.tenant_id AND i.work_id=w.id
      WHERE w.tenant_id=$1 AND w.id=$2
      ORDER BY i.created_at DESC,i.id DESC LIMIT 1 FOR SHARE OF w,i`,
      [ctx.tenantId, input.workId])).rows[0];
    if (!row || row.created_by !== principal(ctx) || row.input_creator !== principal(ctx) ||
        ["completed", "cancelled", "failed"].includes(row.status) ||
        row.input_bytes > 2 * 1024 * 1024 || typeof row.instruction_text !== "string")
      return { workId: input.workId, originalInput: null, executionAuthorityGranted: false };
    let supplied: unknown;
    try { supplied = JSON.parse(row.instruction_text); } catch {
      return { workId: input.workId, originalInput: null, executionAuthorityGranted: false };
    }
    const original = nativeOrganizationOriginal.safeParse(supplied);
    return { workId: input.workId, originalInput: original.success ? {
      workInputId: row.id, originalDeadline: original.data.mandate.originalDeadline,
      purpose: original.data.mandate.purpose, companyId: original.data.companyId,
      sourceClass: original.data.sourceClass, currentInterval: Date.parse(original.data.mandate.validFrom) <= Date.now() &&
        Date.parse(original.data.mandate.originalDeadline) > Date.now(),
    } : null, executionAuthorityGranted: false,
      qualification: "IMMUTABLE_INPUT_DISCOVERY_NOT_SOURCE_VERIFICATION_OR_CURRENT_S5_CLEARANCE" };
  });
}

/** Attach to a canonical immutable input without replacing its meaning or
 * creating another Work. The exact W5 declaration is separately frozen. */
export async function submitOrganizationTransformation(ctx: TenantContext, value: unknown) {
  const input = organizationSubmit.parse(value);
  return orgTx(ctx, async c => {
    await orgLock(ctx, c);
    await orgAuthority(ctx, c, input.workId, true);
    const work = (await c.query(`SELECT w.created_by,w.status,i.instruction_text,i.created_by input_creator
      FROM finnor_os.works w JOIN finnor_os.work_inputs i ON i.tenant_id=w.tenant_id AND i.work_id=w.id
      WHERE w.tenant_id=$1 AND w.id=$2 AND i.id=$3 FOR SHARE OF w,i`, [ctx.tenantId, input.workId, input.workInputId])).rows[0];
    if (!work || work.created_by !== principal(ctx) || work.input_creator !== principal(ctx) ||
        ["completed", "cancelled", "failed"].includes(work.status)) orgFail("W5_ORIGINAL_WORK_INPUT_AUTHORITY_REQUIRED", 403);
    const supplied = nativeOrganizationOriginal.parse(JSON.parse(work.instruction_text));
    if (input.original && organizationDigest(input.original) !== organizationDigest(supplied))
      orgFail("W5_DECLARATION_DIFFERS_FROM_IMMUTABLE_WORK_INPUT");
    const { resources, ...original } = supplied;
    const canonical = parseOrganizationTransformation({ ...original, tenantId: ctx.tenantId, principalId: principal(ctx),
      workId: input.workId, workInputId: input.workInputId });
    if (Date.parse(canonical.mandate.validFrom) > Date.now() || Date.parse(canonical.mandate.originalDeadline) <= Date.now())
      orgFail("W5_ORIGINAL_MANDATE_INTERVAL_UNAVAILABLE");
    const requestDigest = organizationDigest({ ...input, original: supplied });
    const prior = (await c.query<OrganizationRequestRow>(`SELECT * FROM finnor_os.w5_requests WHERE tenant_id=$1
      AND principal_id=$2 AND (idempotency_key=$3 OR work_id=$4) FOR UPDATE`,
      [ctx.tenantId, principal(ctx), input.idempotencyKey, input.workId])).rows[0];
    if (prior) {
      if (prior.request_digest !== requestDigest) orgFail("W5_ORIGINAL_EPISODE_ALREADY_BOUND");
      return { ...summary(prior), semanticReplay: true };
    }
    const sources = await resolveOrganizationSourcesTx(ctx, canonical, c);
    const standing = await workforceEmployeeAuthoritySnapshotTx(ctx, c), id = randomUUID();
    const budget = await reserveWorkforceBudgetTx({ auth: ctx }, c, { ...resources, workId: input.workId,
      programmeId: id, purpose: canonical.mandate.purpose, deadlineAt: canonical.mandate.originalDeadline,
      idempotencyKey: "organization:" + id });
    if (!budget.resources.some(r => r.resourceClass === "COMPUTE" && r.unit === "request"))
      orgFail("W5_NATIVE_COMPUTE_REQUEST_RESOURCE_REQUIRED");
    await c.query(`INSERT INTO finnor_os.w5_requests
      (tenant_id,id,principal_id,company_id,work_id,work_input_id,idempotency_key,request_digest,original_digest,
       original_input_digest,original,source_id,source_version_id,source_digest,budget,rights_revision,original_deadline)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb,$16,$17)`,
      [ctx.tenantId, id, principal(ctx), canonical.companyId, input.workId, input.workInputId, input.idempotencyKey,
        requestDigest, organizationDigest(canonical), rawDigest(work.instruction_text), JSON.stringify(canonical),
        sources.slice.source_id, sources.slice.id, sources.slice.content_hash, JSON.stringify(budget), standing.revision,
        canonical.mandate.originalDeadline]);
    const q = await orgRow(ctx, id, c, true), jobId = await orgEnqueue(ctx, q, "COMPILE", "compile", c);
    await c.query("UPDATE finnor_os.w5_requests SET job_id=$3 WHERE tenant_id=$1 AND id=$2", [ctx.tenantId, id, jobId]);
    await orgEvent(ctx, q, "ORIGINAL_ACCEPTED", "original", { originalWorkId: q.work_id, originalWorkInputId: q.work_input_id,
      originalDigest: q.original_digest, originalInputDigest: q.original_input_digest, originalBudget: budget.ref,
      organizationSourceRef: canonical.organization.ref, mandateRef: canonical.mandate.ref, sourceClass: canonical.sourceClass,
      executionAuthorityGranted: false, fieldBenefitEstablished: false }, c);
    return { ...summary(q), semanticReplay: false };
  });
}

/** Uses the Core exact-intake owner. Repeated delivery returns the same input,
 * then the same W5 request, resource grant and original deadline. */
export async function intakeOrganizationTransformation(ctx: TenantContext, value: unknown) {
  const input = organizationIntake.parse(value);
  await orgTx(ctx, async c => {
    await orgActor(ctx, c, true);
    if (!await canExerciseWorkforceAuthorityTx(ctx, { operation: "action", capability: "action:workforce_assign_contract",
      resource: { type: "work", id: input.workId }, risk: "low" }, c)) orgFail("W5_ORIGINAL_INTAKE_AUTHORITY_REQUIRED", 403);
  });
  const work = await receiveWork({ tenantId: ctx.tenantId, userId: principal(ctx), workId: input.workId,
    channel: "text", instruction: JSON.stringify(input.original), idempotencyKey: "w5-intake:" + input.idempotencyKey,
    entityAttachments: [{ entityType: "external_organization", entityId: input.original.companyId,
      relationship: "target", source: "W5_EXPLICIT_ORIGINAL_BUSINESS_ROOT" }],
    requireExactIntake: true, authorityContext: { authenticatedPrincipal: principal(ctx), channel: "ORGANIZATION_ORDINARY_INTAKE",
      executionAuthorityGranted: false } });
  return submitOrganizationTransformation(ctx, { workId: work.workId, workInputId: work.workInputId,
    original: input.original, idempotencyKey: input.idempotencyKey });
}

export async function readOrganizationTransformation(ctx: TenantContext, value: unknown) {
  const input = organizationReadQuery.parse(value);
  return orgTx(ctx, async c => {
    await orgActor(ctx, c);
    const q = input.requestId ? (await c.query<OrganizationRequestRow>(`SELECT * FROM finnor_os.w5_requests
      WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`, [ctx.tenantId, principal(ctx), input.requestId])).rows[0] :
      (await c.query<OrganizationRequestRow>(`SELECT * FROM finnor_os.w5_requests WHERE tenant_id=$1 AND principal_id=$2
        AND work_id=$3 AND ($4::uuid IS NULL OR work_input_id=$4) ORDER BY created_at DESC LIMIT 1`,
        [ctx.tenantId, principal(ctx), input.workId, input.workInputId ?? null])).rows[0];
    if (!q) {
      if (!input.requestId) orgFail("W5_CONTEXT_UNAVAILABLE", 404);
      const rows = (await c.query<OrganizationSelfOffer>(`SELECT * FROM finnor_os.w5_role_offers
        WHERE tenant_id=$1 AND request_id=$2 AND participant_id=$3 LIMIT 129`,
        [ctx.tenantId, input.requestId, principal(ctx)])).rows;
      if (!rows.length) orgFail("W5_CONTEXT_UNAVAILABLE", 404);
      const offers = await projectOrganizationSelfOffersTx(ctx, rows, c);
      const decisions = (await c.query(`SELECT role_id,decision,terms_digest,created_at FROM finnor_os.w5_adoption_decisions
        WHERE tenant_id=$1 AND request_id=$2 AND participant_id=$3 ORDER BY created_at,id LIMIT 1025`,
        [ctx.tenantId, input.requestId, principal(ctx)])).rows;
      if (decisions.length > 1024) orgFail("W5_COMPLETE_SELF_DECISION_POPULATION_REQUIRED");
      const selfUses = (await c.query(`SELECT process_id,role_id,work_id,use_key,result,created_at
        FROM finnor_os.w5_process_uses WHERE tenant_id=$1 AND request_id=$2 AND participant_id=$3
        ORDER BY created_at,use_key LIMIT 1025`, [ctx.tenantId, input.requestId, principal(ctx)])).rows;
      if (selfUses.length > 1024) orgFail("W5_COMPLETE_SELF_USE_POPULATION_REQUIRED");
      return { access: "PARTICIPANT" as const, requestId: input.requestId, offers, decisions, selfUses,
        parentPrivateDataDisclosed: false, fieldBenefitEstablished: false };
    }
    await orgActor(ctx, c, true);
    await orgAuthority(ctx, c, q.work_id, false);
    if (input.workId && input.workId !== q.work_id || input.workInputId && input.workInputId !== q.work_input_id)
      orgFail("W5_CONTEXT_UNAVAILABLE", 404);
    const dependencies = await inspectOrganizationDependenciesTx(ctx, q, c);
    const uses = (await c.query(`SELECT process_id,role_id,work_id,use_key,result,created_at FROM finnor_os.w5_process_uses
      WHERE tenant_id=$1 AND request_id=$2 ORDER BY created_at,use_key LIMIT 1025`, [ctx.tenantId, q.id])).rows;
    if (uses.length > 1024) orgFail("W5_COMPLETE_OBSERVED_USE_POPULATION_REQUIRED");
    const pendingNativeWork = (await c.query(`SELECT EXISTS(SELECT 1 FROM finnor_os.jobs
      WHERE tenant_id=$1 AND payload->>'requestId'=$2
      AND type IN('compile_organization_transformation_v1','advance_organization_transformation_v1')
      AND status IN('queued','running')) pending`, [ctx.tenantId, q.id])).rows[0]?.pending === true;
    const transitionDiagnostics = (await c.query(`SELECT event_key,kind,created_at,
      coalesce(body->'blocked',body->'errors','[]'::jsonb) errors FROM finnor_os.w5_events
      WHERE tenant_id=$1 AND request_id=$2 AND kind IN('OWNER_TRANSITION_BLOCKED','UNBRIDGED_CANONICAL_LIABILITIES_RETAINED')
      ORDER BY created_at DESC,event_key DESC LIMIT 16`, [ctx.tenantId, q.id])).rows;
    const bound = (await c.query(`SELECT body,body_digest FROM finnor_os.w5_events WHERE tenant_id=$1 AND request_id=$2
      AND kind='OBLIGATION_ROUTE_BOUND' ORDER BY event_key LIMIT 1025`, [ctx.tenantId, q.id])).rows;
    if (bound.length > 1024 || bound.some(row => organizationDigest(row.body) !== row.body_digest))
      orgFail("W5_COMPLETE_ORIGINAL_CONTINUATION_ROUTE_POPULATION_REQUIRED");
    const declarations = [...q.original.organization.obligations, ...bound.map(row => row.body.obligation)];
    if (declarations.length > 1024) orgFail("W5_COMPLETE_ORIGINAL_CONTINUATION_ROUTE_POPULATION_REQUIRED");
    const continuationRoutes = declarations.map(obligation => ({ obligationId: obligation.id, workId: obligation.workId,
      processId: obligation.processId, originalDeadline: obligation.deadline,
      useKeys: uses.filter(use => use.work_id === obligation.workId && use.process_id === obligation.processId)
        .map(use => use.use_key) }));
    const continuationDiagnostics = (await c.query(`SELECT event_key,kind,created_at,
      body->'result' result FROM finnor_os.w5_events WHERE tenant_id=$1 AND request_id=$2
      AND kind IN('ORIGINAL_EFFECT_CONTINUATION_INTENT','ORIGINAL_EFFECT_CONTINUATION_OBSERVED','ORIGINAL_EFFECT_CONTINUATION_READBACK',
        'ORIGINAL_S6_CONTINUATION_OBSERVED')
      ORDER BY created_at DESC,event_key DESC LIMIT 16`, [ctx.tenantId, q.id])).rows;
    return { access: "OWNER" as const, ...summary(q), program: dependencies.status === "CURRENT" ? q.program : null,
      check: dependencies.status === "CURRENT" ? q.check_result : null,
      currentness: dependencies, nativeUses: uses, pendingNativeWork, transitionDiagnostics,
      continuationRoutes, continuationDiagnostics,
      nativeBudgetRef: q.budget.ref, planRevisionId: q.plan_revision_id,
      lastError: q.last_error, qualification: "CHECKED_DEVELOPMENT_NOT_FIELD_OR_PROTECTED", fieldBenefitEstablished: false };
  });
}

export async function readOrganizationOffers(ctx: TenantContext, value: unknown = {}) {
  const input = organizationOffersQuery.parse(value);
  return orgTx(ctx, async c => {
    await orgActor(ctx, c);
    const rows = (await c.query<OrganizationSelfOffer>(`SELECT * FROM finnor_os.w5_role_offers
      WHERE tenant_id=$1 AND participant_id=$2 AND ($3::text IS NULL OR disclosure->>'workId'=$3)
      ORDER BY expires_at,request_id,role_id LIMIT 129`, [ctx.tenantId, principal(ctx), input.workId ?? null])).rows;
    const offers = await projectOrganizationSelfOffersTx(ctx, rows, c);
    return { access: "PARTICIPANT" as const, offers, parentPrivateDataDisclosed: false };
  });
}

/** The owner requests a transition; the durable worker re-resolves current
 * owners, dependencies, S5 and all exact decisions before applying it. */
export async function actOrganizationTransformation(ctx: TenantContext, value: unknown) {
  const input = organizationAction.parse(value);
  return orgTx(ctx, async c => {
    await orgLock(ctx, c);
    const q = await orgRow(ctx, input.requestId, c, true);
    await orgAuthority(ctx, c, q.work_id, true);
    const prior = (await c.query("SELECT body FROM finnor_os.w5_events WHERE tenant_id=$1 AND request_id=$2 AND event_key=$3",
      [ctx.tenantId, q.id, "command:" + input.idempotencyKey])).rows[0]?.body;
    if (prior) {
      if (prior.requestDigest !== organizationDigest(input)) orgFail("W5_COMMAND_IDEMPOTENCY_CONFLICT");
      return { ...summary(q), semanticReplay: true };
    }
    if (!q.program || q.revision !== input.expectedRevision) orgFail("W5_CURRENT_PROGRAM_REVISION_REQUIRED");
    if (!["RECONCILE", "ROLLBACK", "CANCEL"].includes(input.action.kind)) {
      const canonical = await orgCurrent(ctx, q, c);
      await resolveOrganizationSourcesTx(ctx, canonical, c);
      await assertCurrentWorkforceAllocationAuthorityTx({ auth: ctx }, c, q.budget);
      const current = await inspectOrganizationDependenciesTx(ctx, q, c);
      if (current.status !== "CURRENT") orgFail("W5_CURRENT_DEPENDENCIES_REQUIRED");
    }
    if (input.action.kind === "SELECT") {
      const alternativeId = input.action.alternativeId;
      const alternative = q.program.alternatives.find(a => a.id === alternativeId);
      if (!alternative || checkOrganizationTransformation(q.original, q.program).status !== "CHECKED")
        orgFail("W5_CHECKED_CURRENT_ALTERNATIVE_REQUIRED");
    }
    await orgEvent(ctx, q, "OWNER_COMMAND", "command:" + input.idempotencyKey, { command: input,
      requestDigest: organizationDigest(input), authenticatedPrincipal: principal(ctx) }, c);
    await orgEnqueue(ctx, q, "ADVANCE", "command:" + input.idempotencyKey, c);
    return { ...summary(q), accepted: true, semanticReplay: false };
  });
}

/** No owner context is used to manufacture someone else's acceptance. The SQL
 * self-insert policy checks the exact disclosed offer under this principal. */
export async function decideOrganizationAdoption(ctx: TenantContext, value: unknown) {
  const input = organizationSelfDecision.parse(value);
  return orgTx(ctx, async c => {
    await orgLock(ctx, c);
    await orgActor(ctx, c);
    const offer = (await c.query(`SELECT * FROM finnor_os.w5_role_offers WHERE tenant_id=$1 AND request_id=$2
      AND role_id=$3 AND participant_id=$4`, [ctx.tenantId, input.requestId, input.roleId, principal(ctx)])).rows[0];
    if (!offer || offer.alternative_id !== input.alternativeId || offer.terms_digest !== input.termsDigest ||
        input.decision !== "REVOKE" && (offer.revoked_at || offer.expires_at.getTime() <= Date.now()))
      orgFail("W5_SELF_CURRENT_EXACT_OFFER_REQUIRED", 403);
    if (input.decision !== "REVOKE" && (await organizationSelfContractTx(ctx, offer, c)).status !== "CURRENT")
      orgFail("W5_CURRENT_SELF_CONTRACT_REQUIRED");
    if (input.decision !== "REVOKE" && !await canExerciseWorkforceAuthorityTx(ctx, {
      operation: "action", capability: "action:workforce_respond_contract", risk: "low",
      workId: offer.disclosure.workId, resource: { type: "workforce_assignment", id: input.requestId + ":" + input.roleId },
    }, c)) orgFail("W5_CURRENT_SELF_DECISION_AUTHORITY_REQUIRED", 403);
    const old = (await c.query(`SELECT * FROM finnor_os.w5_adoption_decisions WHERE tenant_id=$1 AND request_id=$2
      AND participant_id=$3 AND idempotency_key=$4`, [ctx.tenantId, input.requestId, principal(ctx), input.idempotencyKey])).rows[0];
    if (old) {
      if (old.role_id !== input.roleId || old.alternative_id !== input.alternativeId || old.terms_digest !== input.termsDigest ||
          old.decision !== input.decision) orgFail("W5_ADOPTION_IDEMPOTENCY_CONFLICT");
      return { requestId: input.requestId, roleId: input.roleId, decision: old.decision, semanticReplay: true };
    }
    const source = await orgEvidence(ctx, offer.disclosure.workId, "adoption:" + input.requestId + ":" + principal(ctx) + ":" + input.idempotencyKey,
      { schema: "finnor.organization-self-adoption.v1", ...input, authenticatedPrincipalId: principal(ctx),
        observedOperationEstablished: false, acceptedTerms: offer.terms, protectedAdmission: false }, c);
    await c.query(`INSERT INTO finnor_os.w5_adoption_decisions(tenant_id,id,request_id,principal_id,participant_id,
      role_id,alternative_id,terms_digest,decision,idempotency_key,source_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [ctx.tenantId, randomUUID(), input.requestId, offer.principal_id, principal(ctx), input.roleId, input.alternativeId,
        input.termsDigest, input.decision, input.idempotencyKey, JSON.stringify(source.ref)]);
    await orgEnqueue(ctx, { id: input.requestId, principal_id: offer.principal_id }, "ADVANCE",
      "adoption:" + principal(ctx) + ":" + input.idempotencyKey, c);
    return { requestId: input.requestId, roleId: input.roleId, decision: input.decision,
      qualification: "AUTHENTICATED_SELF_DECISION_NOT_OBSERVED_USE", semanticReplay: false };
  });
}

/** Actual use of a compiled evidence/coordination contract. This prepares a
 * source-backed packet for the unchanged accountable approver; it never
 * approves, pays, contacts a provider or changes a person's employment. */
export async function useOrganizationProcess(ctx: TenantContext, value: unknown) {
  const input = organizationProcessUse.parse(value);
  return orgTx(ctx, async c => {
    // Registration and native publication use this same original S5 mutex.
    // Hold it before the self-head locks so a unit cannot be enrolled mid-use.
    await orgLock(ctx, c);
    await orgActor(ctx, c);
    const offer = (await c.query(`SELECT * FROM finnor_os.w5_role_offers WHERE tenant_id=$1 AND request_id=$2
      AND role_id=$3 AND participant_id=$4 AND revoked_at IS NULL AND expires_at>clock_timestamp()`,
      [ctx.tenantId, input.requestId, input.roleId, principal(ctx)])).rows[0];
    if (!offer) orgFail("W5_SELF_ADOPTED_PROCESS_OFFER_REQUIRED", 403);
    const current = await organizationSelfContractTx(ctx, offer, c);
    if (current.status !== "CURRENT" || !["TRIAL", "ACTIVE"].includes(current.phase ?? ""))
      orgFail("W5_CURRENT_MIGRATED_SELF_CONTRACT_REQUIRED");
    const adopted = (await c.query(`SELECT decision,terms_digest FROM finnor_os.w5_adoption_decisions
      WHERE tenant_id=$1 AND request_id=$2 AND role_id=$3 AND participant_id=$4 ORDER BY created_at DESC,id DESC LIMIT 1`,
      [ctx.tenantId, input.requestId, input.roleId, principal(ctx)])).rows[0];
    if (adopted?.decision !== "ADOPT" || adopted.terms_digest !== offer.terms_digest) orgFail("W5_SELF_EXACT_ADOPTION_REQUIRED");
    const contract = offer.disclosure.processes?.find((p: { id: string }) => p.id === input.processId);
    if (!contract || !contract.constructedAssets?.length) orgFail("W5_CONSTRUCTED_PROCESS_NOT_DISCLOSED");
    if (!await canExerciseWorkforceAuthorityTx(ctx, { operation: "query", capability: "query:work",
      workId: input.workId, resource: { type: "work", id: input.workId }, risk: "low" }, c))
      orgFail("W5_PROCESS_INPUT_WORK_AUTHORITY_REQUIRED", 403);
    const trialUse = await assertOrganizationTrialProcessUseTx(ctx, input, String(offer.disclosure.workId), c);
    const jobKey = "w5:" + input.requestId + ":use:" + principal(ctx) + ":" + input.idempotencyKey;
    const previous = (await c.query(`SELECT id,type,payload,status FROM finnor_os.jobs
      WHERE tenant_id=$1 AND idempotency_key=$2`, [ctx.tenantId, jobKey])).rows;
    if (previous.length > 1) orgFail("W5_ORIGINAL_PROCESS_MAILBOX_JOB_REQUIRED");
    const priorJob = previous[0], priorRequest = priorJob?.payload?.processUse;
    if (priorJob && (priorJob.type !== "advance_organization_transformation_v1" ||
        priorJob.payload.tenantId !== ctx.tenantId || priorJob.payload.principalId !== offer.principal_id ||
        priorJob.payload.requestId !== input.requestId || priorJob.payload.phase !== "ADVANCE" ||
        !priorRequest || priorRequest.authenticatedPrincipalId !== principal(ctx) ||
        priorRequest.termsDigest !== offer.terms_digest ||
        organizationProcessUseIntentDigest(priorRequest) !== organizationProcessUseIntentDigest(input)))
      orgFail("W5_PROCESS_USE_IDEMPOTENCY_CONFLICT");
    if (trialUse?.mailbox && (trialUse.mailbox.terms_digest !== offer.terms_digest ||
        priorJob && (trialUse.mailbox.job_id !== priorJob.id ||
          organizationDigest(trialUse.mailbox.packet_ref) !== organizationDigest(priorRequest.packetRef))))
      orgFail("W5_ASSIGNED_UNIT_ORIGINAL_MAILBOX_CANNOT_BE_REPLACED");
    const priorPacket = trialUse?.mailbox?.packet_ref ?? priorRequest?.packetRef;
    if (priorPacket) {
      const packet = await readOrganizationEvidenceTx(ctx, priorPacket, c);
      if (packet.record.schema !== "finnor.organization-prepared-packet.v1" ||
          packet.metadata.authenticatedPrincipal !== principal(ctx) ||
          packet.record.authenticatedPrincipalId !== principal(ctx) ||
          packet.record.exactTermsDigest !== offer.terms_digest ||
          organizationProcessUseIntentDigest(packet.record) !== organizationProcessUseIntentDigest(input))
        orgFail("W5_ORIGINAL_PROCESS_PACKET_PREIMAGE_REQUIRED");
      for (const evidence of input.evidence) await readOrganizationEvidenceTx(ctx, evidence.ref, c);
      return { requestId: input.requestId, processId: input.processId, packetRef: priorPacket,
        jobId: trialUse?.mailbox?.job_id ?? priorJob.id, accepted: true, semanticReplay: true,
        publicationStatus: priorJob?.status ?? "ORIGINAL_JOB_UNAVAILABLE_NO_REQUEUE",
        approvalGranted: false, externalEffectRequested: false };
    }
    if (priorJob) orgFail("W5_ORIGINAL_PROCESS_PACKET_PREIMAGE_REQUIRED");
    const resolved: Array<{ field: string; ref: unknown }> = [];
    if (new Set(input.evidence.map(e => e.field)).size !== input.evidence.length) orgFail("W5_EXACT_EVIDENCE_FIELDS_REQUIRED");
    for (const evidence of input.evidence) {
      await readOrganizationEvidenceTx(ctx, evidence.ref, c);
      resolved.push({ field: evidence.field, ref: evidence.ref });
    }
    const missing = contract.constructedAssets.flatMap((a: { inputFields: string[] }) => a.inputFields)
      .filter((field: string) => !resolved.some(e => e.field === field));
    if (missing.length) orgFail("W5_REQUIRED_EVIDENCE_NOT_PREPARED", 422);
    const packet = await orgEvidence(ctx, input.workId, "process-use:" + input.requestId + ":" + principal(ctx) + ":" + input.idempotencyKey,
      { schema: "finnor.organization-prepared-packet.v1", ...input, authenticatedPrincipalId: principal(ctx),
        exactTermsDigest: offer.terms_digest, preparedEvidence: resolved,
        originalControls: contract.originalControls, approvalGranted: false, externalEffectRequested: false }, c);
    const request = { ...input, authenticatedPrincipalId: principal(ctx), termsDigest: offer.terms_digest, packetRef: packet.ref };
    // A self-visible, exact offer authenticates the narrow mailbox. The root
    // worker validates this source and the current original graph before use.
    const jobId = randomUUID();
    const queued = await c.query(`INSERT INTO finnor_os.jobs(id,tenant_id,type,payload,status,run_at,lane,protocol_version,max_attempts,idempotency_key)
      VALUES($1,$2,'advance_organization_transformation_v1',$3::jsonb,'queued',clock_timestamp(),'interactive',1,4,$4)
      ON CONFLICT DO NOTHING RETURNING id`, [jobId, ctx.tenantId, JSON.stringify({ tenantId: ctx.tenantId, principalId: offer.principal_id,
        requestId: input.requestId, phase: "ADVANCE", processUse: request }),
        jobKey]);
    if (queued.rows[0]?.id !== jobId) orgFail("W5_ORIGINAL_PROCESS_MAILBOX_JOB_REQUIRED");
    if (trialUse) await reserveOrganizationTrialUseMailboxTx(ctx, trialUse, input.idempotencyKey,
      offer.terms_digest, packet.ref, jobId, c);
    return { requestId: input.requestId, processId: input.processId, packetRef: packet.ref, accepted: true,
      jobId, semanticReplay: false, approvalGranted: false, externalEffectRequested: false };
  });
}

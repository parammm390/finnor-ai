import { z } from "zod";
import type { PoolClient } from "pg";
import type { TenantContext, ExperimentRef } from "@finnor/shared-types";
import { lockTenantMaterialCutTx, transactionDb } from "@finnor/db";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import { reserveWorkforceUseTx, observeWorkforceUseTx, type WorkforceResourceSchedule } from "../workforce-allocation";
import { persistEconomicRecordTx } from "../economic-store";
import { constructOrganizationTransformation, organizationDigest } from "./compiler";
import { checkOrganizationTransformation } from "./checker";
import { applyTransformationDecision, planObligationBridge } from "./lifecycle";
import type { OrganizationTransformationProgram } from "./contracts";
import { OrganizationTransformationError } from "./contracts";
import { organizationAction, organizationProcessUse } from "./native-contracts";
import { resolveOrganizationSourcesTx, readOrganizationEvidenceTx } from "./sources";
import { inspectOrganizationDependenciesTx, pinOrganizationDependenciesTx } from "./dependencies";
import { selectOrganizationPlanTx } from "./plan";
import { deliverOrganizationPacketsTx } from "./packets";
import { assignPendingOrganizationTrialsTx, assertOrganizationTrialProcessUseTx } from "./trials";
import { inspectOrganizationObligationPopulationTx, organizationBusinessPopulationTx, resolveOrganizationObligation } from "./population";
import { orgActor, orgAuthority, orgCurrent, orgEvent, orgEvidence, orgFail, orgLock, orgPublish, orgRow, orgTx,
  rawDigest, canonicalLiveOrganizationObligations, type OrganizationRequestRow } from "./store";

const wire = z.object({ tenantId: z.string().uuid(), principalId: z.string().uuid(), requestId: z.string().uuid(),
  phase: z.enum(["COMPILE", "ADVANCE"]),
  processUse: organizationProcessUse.extend({ authenticatedPrincipalId: z.string().uuid(),
    termsDigest: z.string(), packetRef: z.object({ owner: z.string(), id: z.string(), version: z.string(), contentDigest: z.string() }).strict() }).strict().optional(),
}).strict();
type Wire = z.infer<typeof wire>;
type Accepted = { q: OrganizationRequestRow; consumptionId: string; consumptionRef: ExperimentRef;
  schedules: WorkforceResourceSchedule[]; acceptedAt: string };

/** S5 does not authenticate deliveries. This owner checks the actual job and
 * physical attempt, its exact payload, fence, worker and unexpired lease. */
export async function assertOrganizationPhysicalClaimTx(ctx: TenantContext, q: OrganizationRequestRow,
  payload: Wire, execution: Readonly<JobExecutionContext> | undefined, c: PoolClient) {
  if (!execution || execution.tenantId !== ctx.tenantId || q.principal_id !== ctx.userId ||
      payload.requestId !== q.id || payload.principalId !== q.principal_id) orgFail("W5_PHYSICAL_CLAIM_FENCED");
  const row = (await c.query(`SELECT j.payload,j.type,j.claim_fence,j.claim_token,a.worker_id
    FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
    WHERE j.tenant_id=$1 AND j.id=$2 AND j.protocol_version=1 AND j.status='running'
      AND j.claim_token=$3 AND j.claim_fence=$4 AND j.lease_expires_at>clock_timestamp()
      AND a.id=$5 AND a.claim_token=j.claim_token AND a.claim_fence=j.claim_fence
      AND a.finished_at IS NULL AND a.outcome IN('claimed','running') FOR SHARE OF j,a`,
    [ctx.tenantId, execution.jobId, execution.claimToken, execution.claimFence, execution.deliveryAttemptId])).rows[0];
  const expectedType = payload.phase === "COMPILE" ? "compile_organization_transformation_v1" : "advance_organization_transformation_v1";
  if (!row || row.type !== expectedType || row.worker_id !== execution.workerId ||
      organizationDigest(row.payload) !== organizationDigest(payload)) orgFail("W5_PHYSICAL_CLAIM_FENCED");
}
function computeRequest(q: OrganizationRequestRow) {
  let counter = false;
  const schedules = q.budget.resources.map(r => {
    const period = Math.floor((Date.now() - Date.parse(r.horizon.startAt)) / r.horizon.periodMs);
    const selected = r.resourceClass === "COMPUTE" && r.unit === "request";
    if (selected) {
      if (period < 0 || period > r.horizon.periods) orgFail("W5_ORIGINAL_COMPUTE_CALENDAR_EXPIRED");
      counter = true;
    }
    return { resourceId: r.resourceId, quantities: Array.from({ length: r.horizon.periods + 1 },
      (_, index) => selected && index === period ? "1" : "0") };
  });
  if (!counter) orgFail("W5_CANONICAL_REQUEST_COUNTER_REQUIRED");
  return schedules;
}
async function phaseMeter(ctx: TenantContext, q: OrganizationRequestRow, c: PoolClient, key: string, body: Record<string, unknown>) {
  const result = await persistEconomicRecordTx({ auth: ctx }, { kind: "COMPUTE",
    payload: { schema: "finnor.organization-native-compute.v1", workId: q.work_id, episodeId: q.id,
      originalWorkInputId: q.work_input_id, originalBudgetRef: q.budget.ref, sourceClass: q.original.sourceClass, ...body,
      monetaryCost: null, humanSupervisionSeconds: null, databaseCpuMicroseconds: null,
      billingPricebookRef: null, elapsedHumanAdoptionEstablished: false, fieldBenefitEstablished: false,
      gaps: ["BILLING", "HUMAN_SUPERVISION", "DATABASE_CPU", "INDEPENDENT_FIELD_COUNTERFACTUAL"] },
    rightsRef: q.budget.resources[0]!.rightsRef, idempotencyKey: "w5:" + q.id + ":" + key,
    validAt: new Date().toISOString(), horizon: "H0",
    uncertainty: "ACTUAL_LOCAL_MEASUREMENT_WITH_EXPLICIT_FULL_COST_GAPS_NOT_FIELD_ECONOMICS", dependencies: [q.budget.ref] }, c);
  await orgEvent(ctx, q, "S7_PHASE_METER", "meter:" + key, { ...body, economicRecordRef: result.record.ref,
    monetaryCost: { status: "UNKNOWN", reason: "NO_INDEPENDENT_BILLING_OBSERVATION" },
    humanSupervisionSeconds: { status: "UNKNOWN", reason: "NO_INDEPENDENT_HUMAN_TIME_OBSERVATION" } }, c);
  return result.record.ref;
}

/** Observe lost accepted deliveries using the canonical queue, never a caller
 * assertion or a local pretend marker. Interrupted coordinates remain held. */
export async function reconcileOrganizationAcceptedClaimsTx(ctx: TenantContext, q: OrganizationRequestRow, c: PoolClient) {
  const accepted = (await c.query(`SELECT e.event_key,e.body,e.body_digest FROM finnor_os.w5_events e
    WHERE e.tenant_id=$1 AND e.request_id=$2 AND e.kind='NATIVE_COMPUTE_ACCEPTED'
      AND NOT EXISTS(SELECT 1 FROM finnor_os.w5_events f WHERE f.tenant_id=e.tenant_id AND f.request_id=e.request_id
        AND f.event_key='finished:'||(e.body->>'deliveryAttemptId'))
      AND NOT EXISTS(SELECT 1 FROM finnor_os.w5_events f WHERE f.tenant_id=e.tenant_id AND f.request_id=e.request_id
        AND f.event_key='orphaned:'||(e.body->>'deliveryAttemptId'))
    ORDER BY e.created_at,e.event_key LIMIT 65`, [ctx.tenantId, q.id])).rows;
  if (accepted.length > 64) orgFail("W5_COMPLETE_ACCEPTED_CLAIM_POPULATION_REQUIRED");
  for (const acceptedRow of accepted) {
    const body = acceptedRow.body;
    if (acceptedRow.body_digest !== organizationDigest(body)) orgFail("W5_ACCEPTED_CLAIM_PREIMAGE_CHANGED");
    const delivery = (await c.query(`SELECT j.status,j.lease_expires_at,a.outcome,a.failure_kind
      FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts a ON a.tenant_id=j.tenant_id AND a.job_id=j.id
      WHERE j.tenant_id=$1 AND j.id=$2 AND a.id=$3 AND a.claim_fence=$4
       AND (j.status<>'running' OR j.lease_expires_at<=clock_timestamp() OR j.claim_fence<>a.claim_fence)
      FOR SHARE OF j,a`, [ctx.tenantId, body.jobId, body.deliveryAttemptId, body.claimFence])).rows[0];
    if (!delivery) continue;
    await observeWorkforceUseTx({ auth: ctx }, c, q.budget, { consumptionId: body.consumptionId,
      observationKey: q.id + ":orphaned:" + body.deliveryAttemptId, actual: [], evidenceRef: null,
      possibleEffect: false, meterGaps: ["INTERRUPTED_PHYSICAL_DELIVERY_CPU_AND_ELAPSED_UNKNOWN"] });
    await orgEvent(ctx, q, "ORPHANED_DELIVERY_RETAINED_UNKNOWN", "orphaned:" + body.deliveryAttemptId, {
      jobId: body.jobId, deliveryAttemptId: body.deliveryAttemptId, claimFence: body.claimFence,
      consumptionId: body.consumptionId, originalBudgetRef: q.budget.ref, originalWorkId: q.work_id,
      originalWorkInputId: q.work_input_id, originalDeadline: q.original.mandate.originalDeadline,
      canonicalDelivery: delivery, elapsedMs: null, monetaryCost: null, resourceEnvelopeRetained: true,
      possibleOriginalEffectsRetained: true, businessEffectRedispatchRequested: false }, c);
    await phaseMeter(ctx, q, c, "orphaned:" + body.deliveryAttemptId, { phase: body.phase, status: "UNKNOWN",
      jobId: body.jobId, deliveryAttemptId: body.deliveryAttemptId, consumptionId: body.consumptionId,
      elapsedMs: null, supervisorCpuMicroseconds: null, originalEnvelopeRetained: true });
  }
}
async function accept(ctx: TenantContext, payload: Wire, execution: Readonly<JobExecutionContext>): Promise<Accepted | null> {
  return orgTx(ctx, async c => {
    await orgLock(ctx, c);
    const q = await orgRow(ctx, payload.requestId, c, true);
    await assertOrganizationPhysicalClaimTx(ctx, q, payload, execution, c);
    await orgCurrent(ctx, q, c);
    await reconcileOrganizationAcceptedClaimsTx(ctx, q, c);
    if (payload.phase === "COMPILE" && q.program) return null;
    const schedules = computeRequest(q), acceptedAt = new Date().toISOString();
    const use = await reserveWorkforceUseTx({ auth: ctx }, c, q.budget, { assignmentId: q.budget.programmeId,
      operationKey: "organization:" + q.id + ":" + execution.deliveryAttemptId,
      schedules, decisionDigest: organizationDigest({ original: q.original_digest, payload, generation: q.generation }) });
    await orgEvent(ctx, q, "NATIVE_COMPUTE_ACCEPTED", "accepted:" + execution.deliveryAttemptId, {
      phase: payload.phase, jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId, claimFence: execution.claimFence,
      claimTokenDigest: rawDigest(execution.claimToken), workerId: execution.workerId, consumptionId: use.consumption.ref.id,
      consumptionRef: use.consumption.ref, originalWorkId: q.work_id, originalWorkInputId: q.work_input_id,
      originalDigest: q.original_digest, originalBudgetRef: q.budget.ref, schedules, acceptedAt,
      effectDispatchAuthorityGranted: false }, c);
    return { q, consumptionId: use.consumption.ref.id, consumptionRef: use.consumption.ref, schedules, acceptedAt };
  });
}
async function makeOffers(ctx: TenantContext, q: OrganizationRequestRow, program: OrganizationTransformationProgram, c: PoolClient) {
  const alternative = program.alternatives.find(a => a.id === program.selectedAlternativeId);
  if (!alternative || alternative.kind === "RETAIN") return;
  for (const role of alternative.roles) {
    const terms = { alternativeId: alternative.id, role }, termsDigest = organizationDigest(terms);
    const disclosure = { schema: "finnor.organization-role-offer.v1", requestId: q.id, workId: q.work_id,
      companyId: q.company_id, alternativeId: alternative.id, roleId: role.id, role,
      originalDeadline: q.original.mandate.originalDeadline, originalServiceIds: q.original.mandate.requiredServiceIds,
      processes: alternative.processes.filter(p => p.nodes.some(n => n.roleId === role.id)).map(p => ({
        id: p.id, serviceId: p.serviceId, family: p.family,
        constructedAssets: alternative.constructedAssets.filter(a => a.processId === p.id &&
          p.nodes.some(n => n.id === a.nodeId && n.roleId === role.id)),
        originalControls: q.original.organization.processes.find(old => old.id === p.id)!.nodes.filter(n => n.mandatory)
          .map(n => ({ id: n.id, kind: n.kind, roleId: n.roleId, requiredEvidence: n.requiredEvidence })),
      })),
      employmentChanged: false, originalLiabilitiesRetained: true, actualUseEstablished: false, fieldBenefitEstablished: false };
    await c.query(`INSERT INTO finnor_os.w5_role_offers(tenant_id,request_id,principal_id,participant_id,role_id,
      alternative_id,terms_digest,terms,disclosure,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
      ON CONFLICT DO NOTHING`, [ctx.tenantId, q.id, q.principal_id, role.principalId, role.id, alternative.id,
        termsDigest, JSON.stringify(terms), JSON.stringify(disclosure), q.original.mandate.originalDeadline]);
  }
}
async function applyDecisions(ctx: TenantContext, q: OrganizationRequestRow, initial: OrganizationTransformationProgram, c: PoolClient) {
  let program = initial;
  const rows = (await c.query(`SELECT d.*,u.status actor_status,o.revoked_at,o.expires_at
    FROM finnor_os.w5_adoption_decisions d JOIN finnor_os.w5_role_offers o
      ON o.tenant_id=d.tenant_id AND o.request_id=d.request_id AND o.role_id=d.role_id
    JOIN finnor_os.users u ON u.tenant_id=d.tenant_id AND u.id=d.participant_id
    WHERE d.tenant_id=$1 AND d.request_id=$2 AND NOT EXISTS(SELECT 1 FROM finnor_os.w5_events e
      WHERE e.tenant_id=d.tenant_id AND e.request_id=d.request_id AND e.event_key='decision:'||d.id::text)
    ORDER BY d.created_at,d.id LIMIT 1025`, [ctx.tenantId, q.id])).rows;
  if (rows.length > 1024) orgFail("W5_COMPLETE_SELF_DECISION_POPULATION_REQUIRED");
  for (const row of rows) {
    if (row.actor_status !== "active" || row.decision === "ADOPT" && (row.revoked_at || row.expires_at.getTime() <= Date.now())) {
      await orgEvent(ctx, q, "SELF_DECISION_FENCED", "decision:" + row.id, { decisionId: row.id, roleId: row.role_id,
        reason: "CURRENT_SELF_IDENTITY_OR_TERMS_EXPIRED", originalLiabilitiesRetained: true }, c);
      continue;
    }
    const evidence = await readOrganizationEvidenceTx(ctx, row.source_ref, c);
    if (evidence.metadata.authenticatedPrincipal !== row.participant_id ||
        evidence.record.authenticatedPrincipalId !== row.participant_id || evidence.record.termsDigest !== row.terms_digest ||
        evidence.record.requestId !== q.id || evidence.record.decision !== row.decision)
      orgFail("W5_AUTHENTICATED_SELF_DECISION_PREIMAGE_REQUIRED");
    const decision = { kind: row.decision, alternativeId: row.alternative_id, roleId: row.role_id,
      principalId: row.participant_id, termsDigest: row.terms_digest, observationRef: row.source_ref,
      at: row.created_at.toISOString() };
    program = applyTransformationDecision(program, decision);
    await orgEvent(ctx, q, "SELF_DECISION_APPLIED", "decision:" + row.id, { decisionId: row.id, decision,
      actualOperationEstablished: false, fieldBenefitEstablished: false }, c);
  }
  return program;
}
async function transition(ctx: TenantContext, q: OrganizationRequestRow, program: OrganizationTransformationProgram,
  kind: "MIGRATE" | "ROLLBACK", key: string, c: PoolClient, stage?: "TRIAL" | "ACTIVE") {
  const population = await inspectOrganizationObligationPopulationTx(ctx, q, c);
  if (population.status !== "READY") {
    await orgEvent(ctx, q, "UNBRIDGED_CANONICAL_LIABILITIES_RETAINED", "population:" + key, population, c);
    return { program, blocked: population.errors };
  }
  const bridge = planObligationBridge(q.original, program, population.obligations,
    kind === "ROLLBACK" ? "ROLLBACK" : "FORWARD", population.resourceConstraints);
  await orgEvent(ctx, q, "OBLIGATION_BRIDGE_CHECKED", "bridge-check:" + key,
    { bridge, canonicalPopulationDigest: population.populationDigest, canonicalPopulation: population.manifest }, c);
  if (bridge.status !== "READY") return { program, blocked: bridge.errors };
  if (kind === "MIGRATE" && stage === "ACTIVE") {
    const uses = (await c.query("SELECT DISTINCT process_id FROM finnor_os.w5_process_uses WHERE tenant_id=$1 AND request_id=$2",
      [ctx.tenantId, q.id])).rows;
    if (q.original.organization.processes.some(p => !uses.some(u => u.process_id === p.id)))
      return { program, blocked: ["ACTUAL_COMPLETE_SERVICE_PROCESS_USE_REQUIRED"] };
  }
  await c.query(`INSERT INTO finnor_os.w5_transition_links(tenant_id,request_id,principal_id,transition_key,direction,population_digest,bridge)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT DO NOTHING`,
    [ctx.tenantId, q.id, q.principal_id, key, bridge.direction, bridge.populationDigest, JSON.stringify(bridge)]);
  const next = structuredClone(program); next.status = kind === "ROLLBACK" ? "ROLLED_BACK" : stage ?? "TRIAL"; next.revision++;
  next.events.push({ revision: next.revision, kind, principalId: q.principal_id, at: new Date().toISOString(),
    body: { bridgeDigest: organizationDigest(bridge), originalPopulationDigest: bridge.populationDigest,
      originalWorkId: q.work_id, originalDeadline: next.originalDeadline, oldArrangementRetained: true,
      effectsRedispatched: false, fieldBenefitEstablished: false } });
  if (kind === "ROLLBACK") await c.query(`UPDATE finnor_os.w5_role_offers SET revoked_at=COALESCE(revoked_at,clock_timestamp())
    WHERE tenant_id=$1 AND request_id=$2`, [ctx.tenantId, q.id]);
  return { program: next, blocked: [] as string[] };
}
async function applyCommands(ctx: TenantContext, q: OrganizationRequestRow, initial: OrganizationTransformationProgram, c: PoolClient) {
  let program = initial;
  const commands = (await c.query(`SELECT e.event_key,e.body FROM finnor_os.w5_events e
    WHERE e.tenant_id=$1 AND e.request_id=$2 AND e.kind='OWNER_COMMAND'
      AND NOT EXISTS(SELECT 1 FROM finnor_os.w5_events f WHERE f.tenant_id=e.tenant_id AND f.request_id=e.request_id
        AND f.event_key='applied:'||e.event_key) ORDER BY e.created_at,e.event_key LIMIT 65`, [ctx.tenantId, q.id])).rows;
  if (commands.length > 64) orgFail("W5_PENDING_COMMAND_PROFILE_BOUND");
  for (const row of commands) {
    const command = organizationAction.parse(row.body.command), action = command.action;
    if (row.body.authenticatedPrincipal !== q.principal_id || row.body.requestDigest !== organizationDigest(command))
      orgFail("W5_AUTHENTICATED_OWNER_COMMAND_PREIMAGE_REQUIRED");
    let blocked: string[] = [];
    if (command.expectedRevision !== program.revision) blocked = ["W5_OWNER_COMMAND_REVISION_STALE"];
    else if (!["CANCEL", "ROLLBACK", "RECONCILE"].includes(action.kind) &&
      (await inspectOrganizationDependenciesTx(ctx, q, c)).status !== "CURRENT") blocked = ["W5_CURRENT_EXECUTION_DEPENDENCIES_REQUIRED"];
    else if (action.kind === "RECONCILE") await reconcileOrganizationAcceptedClaimsTx(ctx, q, c);
    else if (action.kind === "BIND_OBLIGATION") {
      if (q.original.organization.obligations.some(o => o.id === action.obligation.id)) orgFail("W5_ORIGINAL_OBLIGATION_CANNOT_BE_REBOUND");
      const alternative = program.alternatives.find(a => a.id === program.selectedAlternativeId);
      const process = alternative?.processes.find(p => p.id === action.obligation.processId);
      const node = process?.nodes.find(n => n.id === action.obligation.nodeId);
      if (!node || node.roleId !== action.obligation.accountableRoleId) orgFail("W5_EXACT_CURRENT_OBLIGATION_DESTINATION_REQUIRED");
      const population = await organizationBusinessPopulationTx(ctx, q, c);
      const obligation = resolveOrganizationObligation(q, action.obligation, population);
      await orgEvent(ctx, q, "OBLIGATION_ROUTE_BOUND", "live-route:" + obligation.id,
        { obligation, originalOwnerAndTermsRetained: true, dispatchAuthorityGranted: false }, c);
      program = structuredClone(program); program.revision++;
      program.events.push({ revision: program.revision, kind: "BOUND_EXISTING_CANONICAL_OBLIGATION",
        principalId: q.principal_id, at: new Date().toISOString(), body: { obligationId: obligation.id,
          workId: obligation.workId, nativeEffectRefs: obligation.effectRefs, newAuthorityGranted: false } });
    }
    else if (action.kind === "SELECT") {
      program = applyTransformationDecision(program, { kind: "SELECT", alternativeId: action.alternativeId,
        principalId: q.principal_id, at: new Date().toISOString() });
      await selectOrganizationPlanTx(ctx, q, program, c, action.alternativeId);
      await makeOffers(ctx, q, program, c);
    } else if (action.kind === "CANCEL") {
      program = applyTransformationDecision(program, { kind: "CANCEL", principalId: q.principal_id, at: new Date().toISOString() });
      await c.query("UPDATE finnor_os.w5_role_offers SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE tenant_id=$1 AND request_id=$2",
        [ctx.tenantId, q.id]);
    } else {
      const result = await transition(ctx, q, program, action.kind, row.event_key, c, action.kind === "MIGRATE" ? action.stage : undefined);
      program = result.program; blocked = result.blocked;
    }
    await orgEvent(ctx, q, blocked.length ? "OWNER_TRANSITION_BLOCKED" : "OWNER_COMMAND_APPLIED", "applied:" + row.event_key, {
      commandDigest: organizationDigest(command), kind: action.kind, revision: program.revision, blocked,
      originalWorkId: q.work_id, originalLiabilitiesRetained: true }, c);
  }
  return program;
}
async function applyProcessUse(ctx: TenantContext, q: OrganizationRequestRow, initial: OrganizationTransformationProgram,
  request: NonNullable<Wire["processUse"]>, c: PoolClient, execution: Readonly<JobExecutionContext>) {
  if (request.requestId !== q.id || !["TRIAL", "ACTIVE"].includes(initial.status)) orgFail("W5_ACTUALLY_MIGRATED_PROCESS_REQUIRED");
  const currentness = await inspectOrganizationDependenciesTx(ctx, q, c);
  if (currentness.affectedProcessIds.includes(request.processId)) orgFail("W5_PROCESS_DEPENDENCY_INVALIDATED");
  const alternative = initial.alternatives.find(a => a.id === initial.selectedAlternativeId);
  const role = alternative?.roles.find(r => r.id === request.roleId), process = alternative?.processes.find(p => p.id === request.processId);
  const adoption = initial.adoptions.find(a => a.roleId === request.roleId);
  if (!role || !process || role.principalId !== request.authenticatedPrincipalId || adoption?.state !== "ADOPTED" ||
      adoption.termsDigest !== request.termsDigest || !alternative?.constructedAssets.some(a => a.processId === process.id &&
        process.nodes.some(n => n.id === a.nodeId && n.roleId === role.id))) orgFail("W5_CURRENT_EXACT_ADOPTED_PROCESS_REQUIRED");
  const packet = await readOrganizationEvidenceTx(ctx, request.packetRef, c);
  if (packet.record.schema !== "finnor.organization-prepared-packet.v1" ||
      packet.metadata.authenticatedPrincipal !== request.authenticatedPrincipalId ||
      packet.record.authenticatedPrincipalId !== request.authenticatedPrincipalId ||
      packet.record.exactTermsDigest !== request.termsDigest || packet.record.requestId !== q.id ||
      packet.record.workId !== request.workId || packet.record.processId !== request.processId ||
      packet.record.roleId !== request.roleId || packet.record.idempotencyKey !== request.idempotencyKey ||
      organizationDigest(packet.record.trialAssignmentRef ?? null) !== organizationDigest(request.trialAssignmentRef ?? null) ||
      organizationDigest(packet.record.evidence) !== organizationDigest(request.evidence))
    orgFail("W5_ACTUAL_AUTHENTICATED_PROCESS_USE_PREIMAGE_REQUIRED");
  await assertOrganizationTrialProcessUseTx(ctx, request, q.work_id, c, request.authenticatedPrincipalId,
    { jobId: execution.jobId, packetRef: request.packetRef, termsDigest: request.termsDigest });
  const useKey = request.authenticatedPrincipalId + ":" + request.idempotencyKey;
  const inputDigest = organizationDigest(request);
  const prior = (await c.query("SELECT input_digest FROM finnor_os.w5_process_uses WHERE tenant_id=$1 AND request_id=$2 AND use_key=$3",
    [ctx.tenantId, q.id, useKey])).rows[0];
  if (prior) { if (prior.input_digest !== inputDigest) orgFail("W5_PROCESS_USE_IDEMPOTENCY_CONFLICT"); return initial; }
  const result = { schema: "finnor.organization-native-use.v1", packetRef: request.packetRef, processId: process.id,
    originalWorkId: request.workId, originalControls: q.original.organization.processes.find(p => p.id === process.id)!.nodes
      .filter(n => n.mandatory).map(n => ({ id: n.id, roleId: n.roleId, kind: n.kind })),
    behavior: "PREPARED_CURRENT_EVIDENCE_FOR_ORIGINAL_APPROVER", approvalGranted: false, externalEffectDispatched: false,
    trialAssignmentRef: request.trialAssignmentRef ?? null,
    moneyCost: null, humanWorkSeconds: null, fullCostStatus: "UNKNOWN", fieldBenefitEstablished: false };
  await c.query(`INSERT INTO finnor_os.w5_process_uses(tenant_id,request_id,principal_id,participant_id,use_key,
    process_id,role_id,work_id,input_digest,source_ref,result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)`,
    [ctx.tenantId, q.id, q.principal_id, request.authenticatedPrincipalId, useKey, process.id, role.id, request.workId,
      inputDigest, JSON.stringify(request.packetRef), JSON.stringify(result)]);
  await deliverOrganizationPacketsTx(ctx, q, initial, request, useKey, c);
  const program = structuredClone(initial); program.claims.observedOperation = true; program.revision++;
  program.events.push({ revision: program.revision, kind: "OBSERVED_NATIVE_PROCESS_USE", principalId: request.authenticatedPrincipalId,
    at: new Date().toISOString(), body: result });
  await orgEvent(ctx, q, "NATIVE_PROCESS_USE", "use:" + useKey, { requestDigest: inputDigest, result }, c);
  return program;
}

export async function runOrganizationTransformationJob(value: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) {
  const payload = wire.parse(value), ctx: TenantContext = { tenantId: payload.tenantId, userId: payload.principalId,
    employeeId: payload.principalId, role: "owner" };
  if (!execution) orgFail("W5_PHYSICAL_CLAIM_FENCED");
  const began = performance.now(), cpu = process.cpuUsage();
  const accepted = await accept(ctx, payload, execution);
  if (!accepted) return;
  // This is a genuine committed-boundary diagnostic, not a test-only hook.
  console.info(JSON.stringify({ event: "W5_NATIVE_COMPUTE_ACCEPTED", requestId: payload.requestId,
    jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId, claimFence: execution.claimFence,
    transactionCommitted: true, effectAuthorityGranted: false }));
  try {
    await orgTx(ctx, async c => {
      await orgLock(ctx, c);
      await lockTenantMaterialCutTx(transactionDb(c), ctx.tenantId);
      const q = await orgRow(ctx, payload.requestId, c, true);
      await assertOrganizationPhysicalClaimTx(ctx, q, payload, execution, c);
      const input = await orgCurrent(ctx, q, c);
      let program: OrganizationTransformationProgram;
      if (payload.phase === "COMPILE") {
        await resolveOrganizationSourcesTx(ctx, input, c);
        await canonicalLiveOrganizationObligations(ctx, q, c);
        program = constructOrganizationTransformation(input);
        if (checkOrganizationTransformation(input, program).status !== "CHECKED") orgFail("W5_INDEPENDENT_CONSTRUCTION_CHECK_FAILED");
        await selectOrganizationPlanTx(ctx, q, program, c);
        await pinOrganizationDependenciesTx(ctx, q, c, program);
        program.unresolved = program.unresolved.filter(v => !["S4_SELECTION", "S5_CURRENT_JOINT_FEASIBILITY"].includes(v));
        program.unresolved.push("S4_BUSINESS_VALUE_UNIDENTIFIED");
      } else {
        if (!q.program) orgFail("W5_CHECKED_PROGRAM_REQUIRED");
        program = await applyDecisions(ctx, q, q.program, c);
        program = await applyCommands(ctx, q, program, c);
        await assignPendingOrganizationTrialsTx(ctx, q, program, execution, accepted.consumptionRef, c);
        if (payload.processUse) program = await applyProcessUse(ctx, q, program, payload.processUse, c, execution);
      }
      await assertOrganizationPhysicalClaimTx(ctx, q, payload, execution, c);
      if (program.revision > q.revision) await orgPublish(ctx, q, program, c);
      const observed = await orgEvidence(ctx, q.work_id, "worker:" + q.id + ":" + execution.deliveryAttemptId,
        { schema: "finnor.organization-native-phase-observation.v1", requestId: q.id, phase: payload.phase,
          jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId, claimFence: execution.claimFence,
          programDigest: organizationDigest(program), originalWorkInputId: q.work_input_id,
          fieldBenefitEstablished: false, originalEffectsRedispatched: false }, c);
      await observeWorkforceUseTx({ auth: ctx }, c, q.budget, { consumptionId: accepted.consumptionId,
        observationKey: q.id + ":worker:" + execution.deliveryAttemptId, actual: accepted.schedules,
        evidenceRef: observed.ref, possibleEffect: false, meterGaps: [] });
      const used = process.cpuUsage(cpu);
      await phaseMeter(ctx, q, c, "worker:" + execution.deliveryAttemptId, { phase: payload.phase, status: "OBSERVED",
        jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId, consumptionId: accepted.consumptionId,
        elapsedMs: performance.now() - began, supervisorCpuMicroseconds: used.user + used.system,
        supervisorPeakRssKiB: process.resourceUsage().maxRSS, computeScope: "THIS_NODE_PROCESS_NOT_DATABASE_OR_OTHER_WORKERS",
        programDigest: organizationDigest(program), requestQuanta: 1 });
      await orgEvent(ctx, q, "NATIVE_COMPUTE_FINISHED", "finished:" + execution.deliveryAttemptId, { phase: payload.phase,
        jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId, consumptionId: accepted.consumptionId,
        programRevision: program.revision, originalBudgetRef: q.budget.ref, originalDeadline: program.originalDeadline }, c);
    });
  } catch (error) {
    await orgTx(ctx, async c => {
      await orgLock(ctx, c);
      const q = await orgRow(ctx, payload.requestId, c, true);
      await assertOrganizationPhysicalClaimTx(ctx, q, payload, execution, c);
      await orgAuthority(ctx, c, q.work_id, false);
      await observeWorkforceUseTx({ auth: ctx }, c, q.budget, { consumptionId: accepted.consumptionId,
        observationKey: q.id + ":failed:" + execution.deliveryAttemptId, actual: [], evidenceRef: null,
        possibleEffect: false, meterGaps: ["FAILED_BEFORE_COMPLETE_NATIVE_OBSERVATION"] });
      const code = error instanceof OrganizationTransformationError ? error.code : "W5_NATIVE_PHASE_FAILED";
      await c.query(`UPDATE finnor_os.w5_requests SET last_error=$3,status=CASE WHEN program IS NULL THEN 'UNKNOWN' ELSE status END,
        updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2`, [ctx.tenantId, q.id, code]);
      await orgEvent(ctx, q, "NATIVE_PHASE_FAILED_RETAINED", "failed:" + execution.deliveryAttemptId,
        { code, originalWorkId: q.work_id, originalWorkInputId: q.work_input_id, originalBudgetRef: q.budget.ref,
          originalLiabilitiesRetained: true, monetaryCost: null, possibleOriginalEffectsRetained: true }, c);
    });
    throw error;
  }
}
export const compileOrganizationTransformationJob = runOrganizationTransformationJob;
export const advanceOrganizationTransformationJob = runOrganizationTransformationJob;

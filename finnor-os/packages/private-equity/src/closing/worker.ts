import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenantTransaction, reconcileWorkStatus } from "@finnor/db";
import type { ClosingCheck, ClosingOwnerRef, ExternalEffectObservation } from "@finnor/shared-types";
import type { JobExecutionContext } from "../../../../apps/worker/src/queue";
import type { PeMutationContext } from "../types";
import { consumeEnterpriseAllocation, validateEnterpriseAllocation } from "../enterprise-allocation";
import { reconcileClosingAllocationObservation } from "../allocation-store";
import { persistEconomicRecord } from "../economic-store";
import { closingTx as tx } from "../owner-context";
import { closingCanonical, closingDigest } from "./compiler";
import { ClosingError, type ClosingProgrammeRow } from "./contracts";
import { appendClosingObservation, assertClosingCurrent, closingEvent, closingProfile, closingProgramme, enqueueClosing, readClosingProgramme } from "./store";
import { refreshIndependentClosingCheck as check } from "./check-client";
import { closingPlannedChildren, selectClosingPlan } from "./plan";
import type { PlanActionNode } from "@finnor/planning";
import { readClosingProvider } from "../../../governed-execution/src/closing-provider";

const Request = z.object({ tenantId: z.string().uuid(), programmeId: z.string().uuid(), generation: z.number().int().positive() }).strict();
const strip = (r: ClosingOwnerRef) => ({ owner: r.owner, id: r.id, version: r.version, contentDigest: r.contentDigest });
function childId(programmeId: string, node: string): string {
  const hex = closingDigest({ programmeId, node });
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
async function observe(ctx: PeMutationContext, q: ClosingProgrammeRow): Promise<ClosingCheck | undefined> {
  const { settleExternalEffectObservation } = await import("@finnor/orchestration");
  const { finishClosingChildBudget } = await import("../../../orchestration/src/objective-loop");
  const rows = await tx(ctx, async c => (await c.query(
    "SELECT l.*,e.semantic_hash,o.id operation_id,o.operation_key,o.integration_id,o.verification_status,o.observation FROM finnor_os.pe_closing_node_links l JOIN finnor_os.pe_closing_programmes prior ON prior.tenant_id=l.tenant_id AND prior.id=l.programme_id JOIN finnor_os.business_effects e ON e.tenant_id=l.tenant_id AND e.id=l.business_effect_id JOIN finnor_os.external_operations o ON o.tenant_id=e.tenant_id AND o.business_effect_id=e.id WHERE l.tenant_id=$1 AND prior.transaction_id=$2 AND o.provider='finnor_closing_provider' ORDER BY o.external_observed_at NULLS FIRST,o.id LIMIT 257", [q.tenant_id, q.transaction_id],
  )).rows, true);
  if (rows.length > 256) throw new ClosingError("CLOSING_OBSERVATION_BOUND_EXCEEDED");
  if (!rows.length) return;
  let independent = await check(ctx, q);
  for (const row of rows) {
    const original = row.programme_id === q.id ? q : await closingProgramme(ctx, row.programme_id);
    const step = original.spec.steps.find(s => s.key === row.node_key);
    if (!step) throw new ClosingError("CLOSING_ORIGINAL_OPERATION_BINDING_MISSING");
    let proof = independent.verifiedOperationSettlements.find(p => p.businessEffectId === row.business_effect_id);
    if (!proof) {
      const response = await readClosingProvider({
        tenantId: q.tenant_id, programmeId: original.id, nodeKey: step.key, domainActionId: row.domain_action_id,
        businessEffectId: row.business_effect_id, businessEffectHash: row.semantic_hash,
      });
      if (response.observed !== true || !response.observation) continue;
      const observation = response.observation as Record<string, unknown>;
      const profile = await closingProfile(ctx, original, true), provider = profile.providers.find(p => p.id === step.providerProfileId);
      if (!provider?.observationIssuerIds.includes(String(observation.issuerId))) throw new ClosingError("CLOSING_OBSERVATION_PROVIDER_ISSUER_BINDING_MISMATCH");
      const appended = await appendClosingObservation(ctx, original.id, observation, false, true);
      if (appended.appended) independent = await check(ctx, q);
      proof = independent.verifiedOperationSettlements.find(p => p.businessEffectId === row.business_effect_id);
    }
    if (!proof) continue;
    const evidence = proof.ref;
    const settlement: ExternalEffectObservation & { closingEvidenceRef: typeof evidence } = {
      tenantId: q.tenant_id, businessEffectId: row.business_effect_id, integrationId: row.integration_id,
      provider: "finnor_closing_provider", externalObjectType: "closing_operation", externalId: row.business_effect_id,
      observedAt: independent.checkedAt, classification: "present",
      expected: { originalSpecDigest: original.spec_digest, requirementKey: step.requirementKey },
      observed: { independentlySignedSourceVersionId: evidence.versionId },
      evidence: { mechanism: "read_after_write", providerEventId: evidence.versionId }, closingEvidenceRef: evidence,
    };
    if (row.verification_status !== "verified" || row.observation?.closingEvidenceRef?.versionId !== evidence.versionId) {
      await settleExternalEffectObservation(settlement, { domainActionId: row.domain_action_id, externalOperationKey: row.operation_key });
    }
    if (step.allocationRef && row.consumption_ref) await reconcileClosingAllocationObservation(ctx, {
      allocationRef: strip(step.allocationRef), consumptionRef: strip(row.consumption_ref),
      effectId: row.business_effect_id, evidenceVersionId: evidence.versionId,
    });
    await closingEvent(ctx, original, "ORIGINAL_OPERATION_INDEPENDENTLY_OBSERVED", {
      effectId: row.business_effect_id, evidence, retryPermitted: false, financingPrincipalIsProfit: false,
    }, undefined, `settlement:${row.business_effect_id}:${evidence.versionId}`);
    await finishClosingChildBudget(q.tenant_id, row.domain_action_id, evidence.versionId);
  }
  return independent;
}
async function child(ctx: PeMutationContext, q: ClosingProgrammeRow, node: string, actionType: string, payload: Record<string, unknown>, actorId: string,
  consumptionRef?: Record<string, unknown>) {
  const { FinnorOrchestrator, reserveClosingChildBudget } = await import("@finnor/orchestration");
  const { finishClosingChildBudget } = await import("../../../orchestration/src/objective-loop");
  const existing = await tx(ctx, async c => (await c.query(
    "SELECT l.*,a.status,a.objective_step_id,a.plan_revision_id,a.plan_node_id FROM finnor_os.pe_closing_node_links l JOIN finnor_os.domain_actions a ON a.tenant_id=l.tenant_id AND a.id=l.domain_action_id WHERE l.tenant_id=$1 AND l.programme_id=$2 AND l.node_key=$3",
    [q.tenant_id, q.id, node],
  )).rows[0], true);
  if (existing && existing.status !== "draft") {
    if (actionType !== "execute_closing_operation") await finishClosingChildBudget(q.tenant_id, existing.domain_action_id);
    return { action: { id: existing.domain_action_id as string, status: existing.status as string } };
  }
  const find = () => tx(ctx, async c => {
    const plan = (await c.query("SELECT plan_graph,status FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND id=$2", [q.tenant_id, q.plan_revision_id])).rows[0];
    return plan?.status === "active" ? plan.plan_graph.nodes.find((n: PlanActionNode) => n.kind === "action"
      && n.preconditions.some(p => p.requirement.nodeKey === node && p.requirement.programmeId === q.id)) as PlanActionNode | undefined : undefined;
  }, true);
  let planned = await find();
  if (!planned || planned.actionType !== actionType || closingCanonical(planned.payload) !== closingCanonical(payload)) {
    const waiting = await tx(ctx, async c => (await c.query(
      "SELECT id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND plan_revision_id=$2 AND status IN('draft','pending','approved','executing','needs_human_review','blocked_integration_unavailable') LIMIT 1",
      [q.tenant_id, q.plan_revision_id],
    )).rows[0], true);
    if (waiting) throw new ClosingError("CLOSING_NATIVE_STAGE_WAITING_FOR_ORIGINAL_CHILD");
    const instruction = `Advance transaction ${q.transaction_id} under legally accepted ClosingSpec ${q.spec_digest}; report verified close or the exact retained disposition.`;
    const selected = await selectClosingPlan(ctx, q.spec, { programmeId: q.id, workId: q.work_id,
      inputId: q.work_input_id, inputDigest: q.work_input_digest, specDigest: q.spec_digest,
      authorityRevision: q.authority_revision, parentRevisionId: q.plan_revision_id, instruction, focusNode: node });
    await tx(ctx, async c => c.query("UPDATE finnor_os.pe_closing_programmes SET plan_revision_id=$3 WHERE tenant_id=$1 AND id=$2", [q.tenant_id, q.id, selected.planRevisionId]));
    q.plan_revision_id = selected.planRevisionId;
    planned = await find();
    await check(ctx, q);
  }
  if (!q.plan_revision_id || !planned || planned.actionType !== actionType || closingCanonical(planned.payload) !== closingCanonical(payload)) {
    throw new ClosingError("CLOSING_EXACT_COMPILED_NATIVE_CHILD_REQUIRED");
  }
  const budget = existing ? { stepId: existing.objective_step_id as string } : await reserveClosingChildBudget({
    tenantId: q.tenant_id, workId: q.work_id, inputId: q.work_input_id, programmeId: q.id, nodeKey: node,
    actionType, payload, planRevisionId: q.plan_revision_id, planNodeId: planned.id,
  });
  const result = await new FinnorOrchestrator().draftKnownAction(actionType, payload, q.tenant_id, {
    source: "V3:original-approved-closing-graph", actionId: childId(q.id, node), workId: q.work_id,
    initiatedBy: actorId, objectiveStepId: budget.stepId, planRevisionId: q.plan_revision_id, planNodeId: planned.id,
    authorityContext: { originalEpisodeRef: q.spec.originalGrant.episodeRef, closingSpecDigest: q.spec_digest },
    onActionPersisted: async action => {
      await tx(ctx, async c => {
      const effect = (await c.query("SELECT id FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2 ORDER BY created_at DESC LIMIT 1", [q.tenant_id, action.id])).rows[0];
      await c.query(
        "INSERT INTO finnor_os.pe_closing_node_links(tenant_id,programme_id,node_key,domain_action_id,business_effect_id,consumption_ref) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(tenant_id,programme_id,node_key) DO NOTHING",
        [q.tenant_id, q.id, node, action.id, effect?.id ?? null, consumptionRef ? closingCanonical(consumptionRef) : null],
      );
      const link = (await c.query("SELECT * FROM finnor_os.pe_closing_node_links WHERE tenant_id=$1 AND programme_id=$2 AND node_key=$3 FOR UPDATE", [q.tenant_id, q.id, node])).rows[0];
      if (link?.domain_action_id !== action.id
          || consumptionRef && closingCanonical(link.consumption_ref) !== closingCanonical(consumptionRef)) {
        throw new ClosingError("CLOSING_ORIGINAL_NATIVE_CHILD_BINDING_CONFLICT");
      }
      await c.query("UPDATE finnor_os.work_objective_steps SET domain_action_id=$3,phase='acting',execution_role='node',execution_state='waiting' WHERE tenant_id=$1 AND id=$2 AND domain_action_id IS NULL", [q.tenant_id, budget.stepId, action.id]);
      if (node === "publish-close") {
        await c.query("UPDATE finnor_os.pe_closing_programmes SET publication_action_id=$3 WHERE tenant_id=$1 AND id=$2 AND (publication_action_id IS NULL OR publication_action_id=$3)", [q.tenant_id, q.id, action.id]);
        q.publication_action_id = action.id;
      }
      });
      // Grounding reads canonical eligibility. Its cut must include the actual
      // publication child, especially when requalifying an already-closed Deal.
      if (node === "publish-close") await check(ctx, q);
    },
  });
  if (actionType !== "execute_closing_operation") await finishClosingChildBudget(q.tenant_id, result.action.id);
  return result;
}
async function duties(ctx: PeMutationContext, q: ClosingProgrammeRow) {
  for (const duty of q.spec.continuingDuties) {
    const node = `duty:${duty.key}`;
    const prior = await tx(ctx, async c => (await c.query("SELECT body FROM finnor_os.s6_closing_duty_handoffs WHERE tenant_id=$1 AND transaction_id=$2 AND duty_key=$3", [q.tenant_id, q.transaction_id, duty.key])).rows[0], true);
    if (prior) {
      if (prior.body.statementDigest !== closingDigest(duty.statement) || prior.body.ownerPrincipalId !== duty.ownerPrincipalId
          || Date.parse(prior.body.dueAt) !== Date.parse(duty.dueAt)
          || closingCanonical(prior.body.liability) !== closingCanonical(duty.liability)
          || closingCanonical(prior.body.dependencyKeys) !== closingCanonical(duty.dependencyKeys)) {
        throw new ClosingError("CLOSING_CANONICAL_DUTY_REVISION_REQUIRED_NO_DUPLICATE_RESPONSIBILITY");
      }
      continue;
    }
    await child(ctx, q, node, "create_task", {
      subjectRef: { entityType: "work", entityId: q.work_id }, title: `Closing duty ${duty.key}`,
      dueAt: duty.dueAt, assigneeRef: { partyType: "employee", partyId: duty.ownerPrincipalId },
      priority: "high", workRef: { workId: q.work_id },
    }, q.principal_id);
    const task = await tx(ctx, async c => (await c.query("SELECT * FROM finnor_os.tasks WHERE tenant_id=$1 AND source_domain_action_id=$2", [q.tenant_id, childId(q.id, node)])).rows[0], true);
    if (!task) continue;
    const authority = await tx(ctx, async c => (await c.query(
      "SELECT d.id FROM finnor_os.authority_decisions d WHERE d.tenant_id=$1 AND d.domain_action_id=$2 AND d.capability='action:create_task' AND d.employee_id=$3 AND d.outcome='allowed' ORDER BY d.created_at DESC,d.id DESC LIMIT 1",
      [q.tenant_id, task.source_domain_action_id, q.principal_id],
    )).rows[0], true);
    if (!authority) throw new ClosingError("CLOSING_CONTINUING_DUTY_AUTHORITY_REQUIRED");
    const body = { key: duty.key, ownerPrincipalId: duty.ownerPrincipalId, dueAt: duty.dueAt, statement: duty.statement,
      statementDigest: closingDigest(duty.statement), dependencyKeys: duty.dependencyKeys, liability: duty.liability,
      obligationRef: duty.obligationRef ?? { owner: "S6", kind: "canonical-task-responsibility", id: task.id, version: "1", contentDigest: closingDigest({ taskId: task.id, duty }) } };
    if (body.obligationRef.owner !== "S6" || body.obligationRef.id !== task.id) throw new ClosingError("CLOSING_EXACT_CANONICAL_DUTY_REFERENCE_REQUIRED");
    await tx(ctx, async c => c.query("INSERT INTO finnor_os.s6_closing_duty_handoffs(tenant_id,programme_id,transaction_id,duty_key,task_id,authority_decision_id,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(tenant_id,transaction_id,duty_key) DO NOTHING", [q.tenant_id, q.id, q.transaction_id, duty.key, task.id, authority.id, closingCanonical(body), closingDigest(body)]));
  }
}
async function notice(ctx: PeMutationContext, q: ClosingProgrammeRow) {
  await persistEconomicRecord(ctx, {
    kind: "COST", rightsRef: `closing:${q.spec_digest}`, idempotencyKey: `v3:${q.id}:retained-costs-and-liabilities`,
    validAt: q.spec.originalGrant.deadlineAt, horizon: "H0", uncertainty: "UNMETERED_NO_ECONOMIC_GAIN_ESTABLISHED",
    payload: {
      schema: "finnor.v3.s7-retained-exposure.v1", programmeId: q.id, workId: q.work_id, transactionId: q.transaction_id,
      specDigest: q.spec_digest, financingPrincipalIsProfit: false,
      financing: q.spec.funding.map(f => ({ sourceClass: f.sourceClass, money: f.money, facilityDigest: f.facilityDigest })),
      continuingLiabilities: q.spec.continuingDuties.filter(d => d.liability).map(d => ({ key: d.key, liability: d.liability, ownerPrincipalId: d.ownerPrincipalId })),
      costs: { totalUsd: null, humanUsd: null, recoveryUsd: null, externalUsd: null, status: "UNMETERED" },
      protectedReceipt: null, valueCreated: null, economicGain: "NOT_ESTABLISHED",
    },
    dependencies: [strip(q.spec.originalGrant.episodeRef)],
  });
}
async function advance(ctx: PeMutationContext, q: ClosingProgrammeRow) {
  const observed = await observe(ctx, q); // Read-only responsibility survives stop/expiry.
  if (q.stopped_at || q.original_deadline_at.getTime() <= Date.now()) {
    const unresolved = await tx(ctx, async c => (await c.query(
      "SELECT 1 FROM finnor_os.pe_closing_node_links l JOIN finnor_os.external_operations o ON o.tenant_id=l.tenant_id AND o.business_effect_id=l.business_effect_id WHERE l.tenant_id=$1 AND l.programme_id=$2 AND o.verification_status<>'verified' LIMIT 1",
      [q.tenant_id, q.id],
    )).rows.length > 0, true);
    await tx(ctx, async c => c.query("UPDATE finnor_os.pe_closing_programmes SET status=$3,reason=$4 WHERE tenant_id=$1 AND id=$2 AND status NOT IN('CLOSED','REOPENED') AND (status IS DISTINCT FROM $3 OR reason IS DISTINCT FROM $4)", [q.tenant_id, q.id,
      q.stopped_at ? "STOPPED" : unresolved ? "RECONCILING" : "STOPPED", q.stopped_at ? "FUTURE_WORK_STOPPED_RESPONSIBILITY_RETAINED" : "ORIGINAL_DEADLINE_EXPIRED_RESPONSIBILITY_RETAINED"]));
    return;
  }
  if (!q.plan_revision_id) {
    const selected = await selectClosingPlan(ctx, q.spec, { programmeId: q.id, workId: q.work_id, inputId: q.work_input_id,
      inputDigest: q.work_input_digest, specDigest: q.spec_digest, authorityRevision: q.authority_revision, parentRevisionId: null,
      instruction: `Advance transaction ${q.transaction_id} under legally accepted ClosingSpec ${q.spec_digest}; report verified close or the exact retained disposition.` });
    await tx(ctx, async c => c.query("UPDATE finnor_os.pe_closing_programmes SET plan_revision_id=$3 WHERE tenant_id=$1 AND id=$2 AND plan_revision_id IS NULL", [q.tenant_id, q.id, selected.planRevisionId]));
    q.plan_revision_id = selected.planRevisionId;
  }
  await assertClosingCurrent(ctx, q);
  await notice(ctx, q);
  await duties(ctx, q);
  // Reuse only this invocation's unexpired independent receipt at the exact
  // unchanged canonical cut. Settlement, duties, replanning or any other
  // material change forces a fresh independently charged check.
  const sameCut = observed && await tx(ctx, async c => Boolean((await c.query(
    `SELECT 1 FROM finnor_os.pe_closing_checks
     WHERE tenant_id=$1 AND programme_id=$2 AND id=$3 AND spec_digest=$4
       AND valid_until>clock_timestamp()
       AND observation_cut_digest=finnor_os.pe_closing_cut_digest($1,$2)`,
    [q.tenant_id, q.id, q.last_check_id, q.spec_digest],
  )).rows[0]), true);
  let result = sameCut ? observed! : await check(ctx, q);
  if (result.accepted) {
    const deal = await tx(ctx, async c => (await c.query("SELECT version,graph_version FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2", [q.tenant_id, q.transaction_id])).rows[0], true);
    const publication = await child(ctx, q, "publish-close", "declare_deal_closed", {
      dealId: q.transaction_id, expectedVersion: deal.version, expectedGraphVersion: deal.graph_version,
    }, q.principal_id);
    if (["failed", "cancelled"].includes(publication.action.status)) throw new ClosingError("CLOSING_ORIGINAL_PUBLICATION_FAILED_RETAINED");
    if ((await closingProgramme(ctx, q.id)).status === "CLOSED") return;
    result = await check(ctx, q); // Includes the actual publication action/effect.
  } else {
    const links = await tx(ctx, async c => (await c.query<{ node_key: string }>("SELECT node_key FROM finnor_os.pe_closing_node_links WHERE tenant_id=$1 AND programme_id=$2", [q.tenant_id, q.id])).rows, true);
    const node = q.spec.steps.find(s => result.readyOperationKeys.includes(s.key) && !links.some(l => l.node_key === s.key));
    if (node) {
      if (["ACQUIRE_EVIDENCE", "REQUEST_PROFESSIONAL"].includes(node.kind)) {
        const planned = closingPlannedChildren(q.spec, q.id, q.work_id, { version: 1, graph_version: 1 }).find(n => n.key === node.key)!;
        await child(ctx, q, node.key, "create_task", planned.payload, q.principal_id);
        await closingEvent(ctx, q, "QUALIFIED_EVIDENCE_REQUEST_OWNED", { nodeKey: node.key, requirementKey: node.requirementKey,
          professionalJudgmentProducedByModel: false, costUsd: null }, undefined, `evidence-request:${node.key}`);
      } else {
      if (!node.allocationRef || !node.policyRef || !node.decision) throw new ClosingError("CLOSING_NATIVE_S4_S5_OPERATION_BINDING_REQUIRED");
      const pending = await tx(ctx, async c => (await c.query(
        "SELECT id,domain_action_id,status FROM finnor_os.business_effects WHERE tenant_id=$1 AND status NOT IN('verified','cancelled','compensated') ORDER BY created_at,id LIMIT 1",
        [q.tenant_id],
      )).rows[0], true);
      if (pending) {
        await closingEvent(ctx, q, "NATIVE_S6_EFFECT_AWAITING_RECONCILIATION", { nodeKey: node.key,
          originalEffectId: pending.id, originalActionId: pending.domain_action_id, status: pending.status,
          freshAuthorityGranted: false }, undefined, `native-pending:${node.key}:${pending.id}:${pending.status}`);
        throw new ClosingError("CLOSING_NATIVE_S6_OUTSTANDING_EFFECT_RECONCILIATION_REQUIRED");
      }
      const allocation = strip(node.allocationRef), validation = await validateEnterpriseAllocation(ctx, allocation);
      if (validation.status !== "CURRENT") {
        await closingEvent(ctx, q, "NATIVE_S5_CURRENTNESS_REFUSAL", { nodeKey: node.key, validation,
          originalReservationRetained: true, freshAuthorityGranted: false });
        throw new ClosingError("CLOSING_S5_CURRENT_ALLOCATION_REQUIRED");
      }
      const consumed = await consumeEnterpriseAllocation(ctx, {
        allocationRef: allocation, policyRef: strip(node.policyRef), decision: node.decision,
        idempotencyKey: `v3:${q.id}:${node.key}`,
      });
      await child(ctx, q, node.key, "execute_closing_operation", {
        dealId: q.transaction_id, programmeId: q.id, nodeKey: node.key, specDigest: q.spec_digest,
      }, node.actor.principalId, { ...consumed.consumption.ref,
        reservationRef: { ...consumed.consumption.reservationRef, kind: "allocation-reservation" } });
      // Drafting/scheduling is not an observation of a completed effect. Keep
      // the checked disposition until the action event wakes the next read.
      // Approval, physical dispatch and publication still perform their own
      // current independent checks against the unchanged original read budget.
      }
    }
  }
  await tx(ctx, async c => c.query("UPDATE finnor_os.pe_closing_programmes SET status=$3,reason=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status NOT IN('CLOSED','REOPENED','STOPPED') AND (status IS DISTINCT FROM $3 OR reason IS DISTINCT FROM $4)", [q.tenant_id, q.id, result.disposition, result.reasons.join(";") || null]));
  await reconcileWorkStatus(q.tenant_id, q.work_id);
}

/** A dedicated physical job owns programme progression. Each consequential
 * child still uses the ordinary S6 action/approval/workflow runtime. */
export async function runClosingProgrammeJob(payload: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) {
  const request = Request.parse(payload);
  if (!execution || execution.tenantId !== request.tenantId || execution.protocolVersion !== 1) throw Error("CLOSING_CANONICAL_JOB_CLAIM_REQUIRED");
  const token = randomUUID();
  const actor = await withTenantTransaction(request.tenantId, { readOnly: true }, async (_db, c) =>
    (await c.query("SELECT u.id,u.role,u.status,coalesce(s.revision,1) authority_revision FROM finnor_os.pe_closing_programmes q JOIN finnor_os.works w ON w.tenant_id=q.tenant_id AND w.id=q.work_id JOIN finnor_os.users u ON u.tenant_id=q.tenant_id AND u.id=COALESCE(w.current_owner_id,q.principal_id) LEFT JOIN finnor_os.authority_states s ON s.tenant_id=q.tenant_id WHERE q.tenant_id=$1 AND q.id=$2", [request.tenantId, request.programmeId])).rows[0]);
  if (!actor || actor.status !== "active" || actor.role !== "owner") throw Error("CLOSING_CURRENT_CANONICAL_PE_PRINCIPAL_UNAVAILABLE");
  const ctx: PeMutationContext = { auth: { tenantId: request.tenantId, userId: actor.id, employeeId: actor.id, role: actor.role,
    authorityRevision: Number(actor.authority_revision) } };
  const q = await tx(ctx, async c => {
    const job = (await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE", [request.tenantId, execution.jobId, execution.claimToken, execution.claimFence])).rows[0];
    if (!job) throw new ClosingError("CLOSING_JOB_LEASE_LOST");
    return (await c.query<ClosingProgrammeRow>("UPDATE finnor_os.pe_closing_programmes SET controller_lease_token=$4,controller_lease_until=clock_timestamp()+interval '90 seconds' WHERE tenant_id=$1 AND id=$2 AND generation=$3 AND (controller_lease_until IS NULL OR controller_lease_until<clock_timestamp()) RETURNING *", [request.tenantId, request.programmeId, request.generation, token])).rows[0];
  });
  if (!q) return;
  execution.registerHeartbeat(async () => tx(ctx, async c => Boolean((await c.query("UPDATE finnor_os.pe_closing_programmes SET controller_lease_until=clock_timestamp()+interval '90 seconds' WHERE tenant_id=$1 AND id=$2 AND controller_lease_token=$3 AND generation=$4 RETURNING id", [q.tenant_id, q.id, token, q.generation])).rowCount)));
  try {
    const projection = await readClosingProgramme(ctx, q.id);
    if (projection.status === "CLOSED") {
      if (q.publication_action_id) await (await import("../../../orchestration/src/objective-loop")).finishClosingChildBudget(q.tenant_id, q.publication_action_id);
      await tx(ctx, async c => {
        const loop = (await c.query("SELECT id,revision,state FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2", [q.tenant_id, q.work_id])).rows[0];
        if (loop?.state === "continue") await c.query(
          "INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety) VALUES($1,'run_objective_iteration',$2::jsonb,$3,'interactive',1,'durably_effect_guarded') ON CONFLICT(idempotency_key) DO NOTHING",
          [q.tenant_id, closingCanonical({ tenantId: q.tenant_id, workId: q.work_id, objectiveLoopId: loop.id, expectedRevision: loop.revision }),
            `v3:${q.id}:native-current-certificate-success-check`],
        );
      });
      return;
    }
    if (projection.status === "REOPENED") {
      await observe(ctx, q);
      return;
    }
    await advance(ctx, q);
  } catch (error) {
    const reason = error instanceof ClosingError ? error.code : "CLOSING_OWNER_BOUNDARY_UNAVAILABLE";
    const fault = error && typeof error === "object" ? error as { code?: unknown; name?: unknown; stack?: unknown } : {};
    const diagnostic = {
      errorType: typeof fault.name === "string" ? fault.name : "UNKNOWN",
      code: typeof fault.code === "string" && /^[A-Z0-9_]{1,128}$/.test(fault.code) ? fault.code : null,
      frames: typeof fault.stack === "string" ? fault.stack.split("\n").filter(line => line.trim().startsWith("at ")).slice(0, 8) : [],
    };
    await closingEvent(ctx, q, "CONTROLLER_BLOCKED_WITH_RESPONSIBILITY_RETAINED", { reason, diagnostic,
      newFinancialEffectsAuthorized: false, costsUsd: null });
    await tx(ctx, async c => c.query("UPDATE finnor_os.pe_closing_programmes SET status=CASE WHEN stopped_at IS NOT NULL THEN 'STOPPED' ELSE 'BLOCKED' END,reason=$3 WHERE tenant_id=$1 AND id=$2 AND status NOT IN('CLOSED','REOPENED') AND (status,reason) IS DISTINCT FROM (CASE WHEN stopped_at IS NOT NULL THEN 'STOPPED' ELSE 'BLOCKED' END,$3::text)", [q.tenant_id, q.id, reason]));
  } finally {
    const current = await closingProgramme(ctx, q.id);
    const retained = (await readClosingProgramme(ctx, q.id)).unresolvedEffects.length > 0;
    const budget = await tx(ctx, async c => (await c.query(
      "SELECT step_count<max_steps AND query_count<max_queries AS remaining FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND work_id=$2",
      [q.tenant_id, q.work_id],
    )).rows[0], true);
    if (budget?.remaining && (retained || !["CLOSED", "REOPENED", "FAILED", "STOPPED"].includes(current.status) && current.original_deadline_at.getTime() > Date.now())) {
      await enqueueClosing(ctx, current, `retained-responsibility:${Math.floor(Date.now()/60000)+1}`, undefined, 60000);
    }
    await tx(ctx, async c => c.query("UPDATE finnor_os.pe_closing_programmes SET controller_lease_token=NULL,controller_lease_until=NULL WHERE tenant_id=$1 AND id=$2 AND controller_lease_token=$3", [q.tenant_id, q.id, token]));
  }
}

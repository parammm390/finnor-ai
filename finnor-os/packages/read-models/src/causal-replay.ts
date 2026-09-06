import {
  actionLog,
  authorityApprovalRequests,
  authorityApprovalRequestSteps,
  authorityDecisions,
  businessEffects,
  businessEvents,
  communicationDeliveries,
  compensationCases,
  computerArtifacts,
  commands,
  decisionReceipts,
  domainActions,
  domainPolicyRevisions,
  externalOperations,
  inboxEvents,
  instructionEvents,
  integrationOperations,
  outboxEvents,
  reconciliationCases,
  tenantRetentionPolicies,
  universalActionEvents,
  withTenant,
  workAggregate,
  workInputs,
  workObjectivePlannerAttempts,
  workObjectiveSteps,
  workPlannerAttempts,
  workflowRuns,
  workflowSteps,
  works,
  type WorkAggregate,
} from "@finnor/db";
import type {
  CausalEvidenceAvailability,
  CausalReplayEdge,
  CausalReplayEvidenceRef,
  CausalReplayNode,
  CausalReplayProjection,
  CausalReplayStage,
  DecisionContextSnapshot,
  Role,
} from "@finnor/shared-types";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { executionProjection, sanitizeExecutionValue } from "./execution-projection";

const NODE_LIMIT = 1_000;
const EDGE_LIMIT = 2_000;
const ACTION_EVENT_LIMIT = 2_000;
const ARTIFACT_LIMIT = 500;

export interface CausalReplayViewer {
  userId: string;
  role: Role;
}

type WorkRow = typeof works.$inferSelect;
type InputRow = typeof workInputs.$inferSelect;
type PlannerRow = typeof workPlannerAttempts.$inferSelect;
type ActionRow = typeof domainActions.$inferSelect;
type ReceiptRow = typeof decisionReceipts.$inferSelect;
type ObjectiveStepRow = typeof workObjectiveSteps.$inferSelect;
type ObjectiveAttemptRow = typeof workObjectivePlannerAttempts.$inferSelect;
type WorkflowStepRow = typeof workflowSteps.$inferSelect;

function iso(value: Date | string | null | undefined, fallback = new Date(0).toISOString()): string {
  return value ? new Date(value).toISOString() : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 1_000);
  return fallback;
}

function humanize(value: string): string {
  return value.replace(/[_\-.]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function sourceRef(table: string, id: string): string {
  return `${table}:${id}`;
}

function evidence(
  source: string,
  ref: string | null,
  recordedAt: string,
  availability: CausalEvidenceAvailability = "available",
  integrityHash: string | null = null,
): CausalReplayEvidenceRef {
  return { source, ref, recordedAt, availability, integrityHash };
}

function isDecisionContextSnapshot(value: unknown): value is DecisionContextSnapshot {
  const row = record(value);
  return row.version === 1 && typeof row.capturedAt === "string" && Array.isArray(row.entities);
}

function actionEventStage(step: string): CausalReplayStage {
  if (/fail|error|timeout|blocked|unknown/i.test(step)) return "failure";
  if (/recover|retry|reconcil/i.test(step)) return "recovery";
  if (/gate|confirm|reject|approv|escalat/i.test(step)) return "approval";
  if (/verif|reflect/i.test(step)) return "verification";
  if (/dispatch|execut|complete|result/i.test(step)) return "execution";
  return "planning";
}

function statusForAvailability(availability: CausalEvidenceAvailability): string {
  return availability === "available" ? "available" : availability.replaceAll("_", " ");
}

/**
 * The projection is intentionally assembled from existing Work facts and the Phase 3
 * execution read model. It never calls reconcileWorkStatus, a mutation route, a
 * provider, the planner, or the Objective Loop.
 */
export async function causalReplayProjection(
  tenantId: string,
  workId: string,
  viewer: CausalReplayViewer,
): Promise<CausalReplayProjection | null> {
  const [aggregate, execution] = await Promise.all([
    workAggregate(tenantId, workId),
    executionProjection(tenantId, workId, { userId: viewer.userId, role: viewer.role }),
  ]);
  if (!aggregate || !execution) return null;

  const work = aggregate.work as WorkRow;
  const inputs = (aggregate.inputs ?? []) as InputRow[];
  const plannerAttempts = (aggregate.plannerAttempts ?? []) as PlannerRow[];
  const actions = (aggregate.actions ?? []) as ActionRow[];
  const receipts = (aggregate.receipts ?? []) as ReceiptRow[];
  const objectiveSteps = (aggregate.objectiveSteps ?? []) as ObjectiveStepRow[];
  const objectiveLoop = aggregate.objectiveLoop;
  const objectiveAttempts = (aggregate.objectivePlannerAttempts ?? []) as ObjectiveAttemptRow[];
  const workflowStepRows = (aggregate.workflowSteps ?? []) as WorkflowStepRow[];
  const repairs = (aggregate.repairs ?? []) as Array<{ id: string; failedDomainActionId: string; status: string; terminalReceipt: unknown; createdAt: Date; proposedAt: Date | null }>;
  const eventWaits = (aggregate.eventWaits ?? []) as Array<{ id: string; objectiveStepId: string; status: string; expectedEventType: string; matchedEventId: string | null; conditionSummary: string; createdAt: Date; satisfiedAt: Date | null; timedOutAt: Date | null }>;
  const wakeClaims = (aggregate.wakeClaims ?? []) as Array<{ id: string; waitId: string; integrationEventId: string; claimedAt: Date }>;
  const integrationEventRows = (aggregate.integrationEvents ?? []) as Array<{ id: string; source: string; provider: string | null; eventType: string; status: string; trustClass: string; workId: string | null; domainActionId: string | null; computerRunId: string | null; evidenceRefs: unknown; occurredAt: Date; receivedAt: Date }>;
  const workEvents = (aggregate.events ?? []) as Array<{ id: string; seq: number; eventType: string; fromStatus: string | null; toStatus: string; payload: unknown; createdAt: Date }>;
  const queryExecutions = (aggregate.queryExecutions ?? []) as Array<{ id: string; workInputId: string | null; intent: string; status: string; resultSummary: unknown; rowCount: number; startedAt: Date; completedAt: Date | null }>;
  const operations = (aggregate.operations ?? []) as Array<{ id: string; domainActionId: string; status: string; operationType: string; createdAt: Date; completedAt: Date | null }>;

  const actionIds = actions.map((row) => row.id);
  const stepIds = workflowStepRows.map((row) => row.id);
  const computerRunIds = execution.nodes.flatMap((node) => node.computer ? [node.computer.id] : []);
  const policyIds = [...new Set(actions.flatMap((row) => row.policyId ? [row.policyId] : []))];
  const exactBusinessSources = [
    ...actionIds.flatMap((id) => [id, `domain_action:${id}`]),
    ...operations.map((operation) => `business_operation:${operation.id}`),
  ];

  const extra = await withTenant(tenantId, async (db) => {
    const actionEventsPlus = actionIds.length ? await db.select().from(actionLog).where(and(
      eq(actionLog.tenantId, tenantId),
      inArray(actionLog.domainActionId, actionIds),
    )).orderBy(asc(actionLog.timestamp)).limit(ACTION_EVENT_LIMIT + 1) : [];
    const authorityRows = await db.select().from(authorityDecisions).where(and(
      eq(authorityDecisions.tenantId, tenantId),
      or(eq(authorityDecisions.workId, workId), ...(actionIds.length ? [inArray(authorityDecisions.domainActionId, actionIds)] : [])),
    )).orderBy(asc(authorityDecisions.createdAt));
    const approvalRows = actionIds.length ? await db.select().from(authorityApprovalRequests).where(and(
      eq(authorityApprovalRequests.tenantId, tenantId),
      inArray(authorityApprovalRequests.domainActionId, actionIds),
    )).orderBy(asc(authorityApprovalRequests.createdAt)) : [];
    const approvalIds = approvalRows.map((row) => row.id);
    const approvalSteps = approvalIds.length ? await db.select().from(authorityApprovalRequestSteps).where(and(
      eq(authorityApprovalRequestSteps.tenantId, tenantId),
      inArray(authorityApprovalRequestSteps.approvalRequestId, approvalIds),
    )).orderBy(asc(authorityApprovalRequestSteps.sequence)) : [];
    const effectRows = actionIds.length ? await db.select().from(businessEffects).where(and(
      eq(businessEffects.tenantId, tenantId),
      inArray(businessEffects.domainActionId, actionIds),
    )).orderBy(asc(businessEffects.createdAt)) : [];
    const policyRows = policyIds.length ? await db.select().from(domainPolicyRevisions).where(and(
      eq(domainPolicyRevisions.tenantId, tenantId),
      inArray(domainPolicyRevisions.policyId, policyIds),
    )).orderBy(asc(domainPolicyRevisions.effectiveFrom)) : [];
    const externalRows = actionIds.length ? await db.select().from(externalOperations).where(and(
      eq(externalOperations.tenantId, tenantId),
      inArray(externalOperations.domainActionId, actionIds),
    )).orderBy(asc(externalOperations.createdAt)) : [];
    const deliveryRows = actionIds.length ? await db.select().from(communicationDeliveries).where(and(
      eq(communicationDeliveries.tenantId, tenantId),
      or(eq(communicationDeliveries.workId, workId), inArray(communicationDeliveries.domainActionId, actionIds)),
    )).orderBy(asc(communicationDeliveries.createdAt)) : [];
    const universalRows = actionIds.length ? await db.select().from(universalActionEvents).where(and(
      eq(universalActionEvents.tenantId, tenantId),
      inArray(universalActionEvents.domainActionId, actionIds),
    )).orderBy(asc(universalActionEvents.createdAt)) : [];
    const integrationRows = stepIds.length ? await db.select().from(integrationOperations).where(and(
      eq(integrationOperations.tenantId, tenantId),
      inArray(integrationOperations.workflowStepId, stepIds),
    )).orderBy(asc(integrationOperations.createdAt)) : [];
    const commandRows = await db.select({ command: commands, runId: workflowRuns.id }).from(workflowRuns)
      .innerJoin(commands, and(eq(commands.tenantId, tenantId), eq(commands.id, workflowRuns.commandId)))
      .where(and(eq(workflowRuns.tenantId, tenantId), eq(workflowRuns.workId, workId)))
      .orderBy(asc(commands.createdAt));
    const outboxRows = stepIds.length ? await db.select().from(outboxEvents).where(and(
      eq(outboxEvents.tenantId, tenantId),
      inArray(outboxEvents.workflowStepId, stepIds),
    )).orderBy(asc(outboxEvents.createdAt)) : [];
    const inboxRows = stepIds.length ? await db.select().from(inboxEvents).where(and(
      eq(inboxEvents.tenantId, tenantId),
      inArray(inboxEvents.matchedStepId, stepIds),
    )).orderBy(asc(inboxEvents.receivedAt)) : [];
    const reconciliationRows = stepIds.length ? await db.select().from(reconciliationCases).where(and(
      eq(reconciliationCases.tenantId, tenantId),
      inArray(reconciliationCases.relatedStepId, stepIds),
    )).orderBy(asc(reconciliationCases.createdAt)) : [];
    const compensationRows = stepIds.length ? await db.select().from(compensationCases).where(and(
      eq(compensationCases.tenantId, tenantId),
      inArray(compensationCases.workflowStepId, stepIds),
    )).orderBy(asc(compensationCases.createdAt)) : [];
    const artifactRowsPlus = computerRunIds.length ? await db.select({
      id: computerArtifacts.id,
      runId: computerArtifacts.runId,
      stepId: computerArtifacts.stepId,
      kind: computerArtifacts.kind,
      mimeType: computerArtifacts.mimeType,
      sizeBytes: computerArtifacts.sizeBytes,
      sha256: computerArtifacts.sha256,
      storageRef: computerArtifacts.storageRef,
      content: computerArtifacts.content,
      metadata: computerArtifacts.metadata,
      createdAt: computerArtifacts.createdAt,
    }).from(computerArtifacts).where(and(
      eq(computerArtifacts.tenantId, tenantId),
      inArray(computerArtifacts.runId, computerRunIds),
    )).orderBy(asc(computerArtifacts.createdAt)).limit(ARTIFACT_LIMIT + 1) : [];
    const [artifactRetention] = await db.select({ retentionDays: tenantRetentionPolicies.retentionDays, legalHold: tenantRetentionPolicies.legalHold }).from(tenantRetentionPolicies).where(and(
      eq(tenantRetentionPolicies.tenantId, tenantId),
      eq(tenantRetentionPolicies.dataClass, "computer_artifact_content"),
    )).limit(1);
    const businessRows = exactBusinessSources.length ? await db.select().from(businessEvents).where(and(
      eq(businessEvents.tenantId, tenantId),
      inArray(businessEvents.source, exactBusinessSources),
    )).orderBy(asc(businessEvents.occurredAt)) : [];
    const instructionIds = inputs.map((input) => input.instructionId);
    const instructionRows = instructionIds.length ? await db.select().from(instructionEvents).where(and(
      eq(instructionEvents.tenantId, tenantId),
      inArray(instructionEvents.instructionId, instructionIds),
    )).orderBy(asc(instructionEvents.createdAt)) : [];
    return {
      actionEventsPlus,
      authorityRows,
      approvalRows,
      approvalSteps,
      effectRows,
      policyRows,
      externalRows,
      deliveryRows,
      universalRows,
      integrationRows,
      commandRows,
      outboxRows,
      inboxRows,
      reconciliationRows,
      compensationRows,
      artifactRowsPlus,
      artifactRetention,
      businessRows,
      instructionRows,
    };
  });

  const nodes: CausalReplayNode[] = [];
  const edges: CausalReplayEdge[] = [];
  const missing: string[] = [];
  const nodeIds = new Set<string>();
  const addNode = (node: CausalReplayNode) => {
    if (nodeIds.has(node.id)) return;
    nodeIds.add(node.id);
    nodes.push(node);
  };
  const addEdge = (edge: Omit<CausalReplayEdge, "id" | "certainty"> & { certainty?: CausalReplayEdge["certainty"] }) => {
    const certainty = edge.certainty ?? (edge.evidenceRefs.length > 0 ? "proven" : "missing");
    if (certainty === "missing") missing.push(edge.explanation);
    edges.push({ ...edge, id: `edge:${edges.length + 1}`, certainty });
  };
  const addMissing = (id: string, at: string, summary: string, from?: string) => {
    addNode({
      id,
      stage: "missing",
      title: "Missing provenance",
      summary,
      status: "legacy incomplete history",
      occurredAt: at,
      sourceRefs: [],
      evidence: [evidence("legacy_history", null, at, "legacy_incomplete")],
      facts: {},
      entityRefs: [],
    });
    missing.push(summary);
    if (from) addEdge({ from, to: id, relation: "missing_provenance", evidenceRefs: [], explanation: summary, certainty: "missing" });
  };

  const inputNodeById = new Map<string, string>();
  const contextNodeByInput = new Map<string, string>();
  for (const input of inputs) {
    const id = `trigger:${input.id}`;
    inputNodeById.set(input.id, id);
    addNode({
      id,
      stage: "trigger",
      title: input.channel === "voice" ? "Voice instruction received" : "Instruction received",
      summary: text(sanitizeExecutionValue(input.instructionText, viewer.role), "Instruction text unavailable"),
      status: "recorded",
      occurredAt: iso(input.createdAt),
      sourceRefs: [sourceRef("work_inputs", input.id), sourceRef("instruction_sessions", input.instructionId)],
      evidence: [evidence("work_inputs", input.id, iso(input.createdAt))],
      facts: { channel: input.channel, instructionId: input.instructionId, actorId: input.createdBy },
      entityRefs: [],
    });
    if (input.contextSnapshot && input.contextSnapshotHash && input.contextCapturedAt) {
      const context = record(input.contextSnapshot);
      const contextId = `interaction-context:${input.id}`;
      contextNodeByInput.set(input.id, contextId);
      addNode({
        id: contextId,
        stage: "context",
        title: "Operating interaction context captured",
        summary: `${Array.isArray(context.selectedEntities) ? context.selectedEntities.length : 0} selected · ${Array.isArray(context.excludedEntities) ? context.excludedEntities.length : 0} excluded · ${record(context.surface).id ?? "unknown"} surface`,
        status: "immutable",
        occurredAt: iso(input.contextCapturedAt),
        sourceRefs: [`${sourceRef("work_inputs", input.id)}.context_snapshot`],
        evidence: [evidence("work_inputs.context_snapshot", input.id, iso(input.contextCapturedAt), "available", input.contextSnapshotHash)],
        facts: sanitizeExecutionValue({
          hash: input.contextSnapshotHash,
          focusedEntity: context.focusedEntity ?? null,
          selectedCount: Array.isArray(context.selectedEntities) ? context.selectedEntities.length : 0,
          excludedCount: Array.isArray(context.excludedEntities) ? context.excludedEntities.length : 0,
          surface: context.surface ?? null,
          filters: context.filters ?? [],
          timeContext: context.timeContext ?? null,
          cohort: context.cohort ?? null,
        }, viewer.role) as Record<string, unknown>,
        entityRefs: [context.focusedEntity, ...(Array.isArray(context.selectedEntities) ? context.selectedEntities : []), ...(Array.isArray(context.excludedEntities) ? context.excludedEntities : [])].flatMap((item) => {
          const ref = record(item);
          return typeof ref.entityType === "string" && typeof ref.entityId === "string" ? [{ entityType: ref.entityType, entityId: ref.entityId }] : [];
        }),
      });
      addEdge({ from: id, to: contextId, relation: "captured_context", evidenceRefs: [`${sourceRef("work_inputs", input.id)}.context_snapshot`], explanation: "The immutable input row stores the exact interaction context supplied with this instruction." });
    } else {
      addMissing(`missing:interaction-context:${input.id}`, iso(input.createdAt), "This legacy Work input has no immutable interaction-context snapshot.", id);
    }
  }

  const plannerNodeById = new Map<string, string>();
  for (const attempt of plannerAttempts) {
    const inputNode = attempt.workInputId ? inputNodeById.get(attempt.workInputId) : undefined;
    const contextNode = attempt.workInputId ? contextNodeByInput.get(attempt.workInputId) : undefined;
    let decisionContextNode: string | undefined;
    if (isDecisionContextSnapshot(attempt.decisionContextSnapshot) && attempt.decisionContextHash && attempt.decisionContextCapturedAt) {
      const snapshot = attempt.decisionContextSnapshot;
      decisionContextNode = `decision-context:${attempt.id}`;
      addNode({
        id: decisionContextNode,
        stage: "context",
        title: "Decision-time context frozen",
        summary: `${snapshot.entities.length} bounded entity snapshot${snapshot.entities.length === 1 ? "" : "s"} · authority revision ${snapshot.authority.revision ?? "unavailable"}`,
        status: snapshot.health.status,
        occurredAt: iso(attempt.decisionContextCapturedAt),
        sourceRefs: [`${sourceRef("work_planner_attempts", attempt.id)}.decision_context_snapshot`],
        evidence: [evidence("work_planner_attempts.decision_context_snapshot", attempt.id, iso(attempt.decisionContextCapturedAt), "available", attempt.decisionContextHash)],
        facts: sanitizeExecutionValue({
          hash: attempt.decisionContextHash,
          entities: snapshot.entities,
          cohort: snapshot.cohort,
          canonicalEvidence: snapshot.canonicalEvidence,
          canonicalSummaries: snapshot.canonicalSummaries,
          authority: snapshot.authority,
          health: snapshot.health,
        }, viewer.role) as Record<string, unknown>,
        entityRefs: snapshot.entities.map((entity) => ({ entityType: entity.entityType, entityId: entity.entityId })),
      });
      if (contextNode || inputNode) addEdge({
        from: contextNode ?? inputNode!,
        to: decisionContextNode,
        relation: "resolved_decision_context",
        evidenceRefs: [sourceRef("work_planner_attempts", attempt.id)],
        explanation: "The planner attempt references the same Work input and freezes the context assembled before planning.",
      });
    }
    const id = `planner:${attempt.id}`;
    plannerNodeById.set(attempt.id, id);
    addNode({
      id,
      stage: attempt.status === "failed" || attempt.status === "timed_out" ? "failure" : "planning",
      title: `Planner attempt ${attempt.attempt}`,
      summary: attempt.status === "succeeded" ? `${Number(record(attempt.plannerResult).actionCount ?? 0)} proposed action${Number(record(attempt.plannerResult).actionCount ?? 0) === 1 ? "" : "s"}` : text(record(attempt.failure).message, humanize(attempt.status)),
      status: attempt.status,
      occurredAt: iso(attempt.startedAt),
      sourceRefs: [sourceRef("work_planner_attempts", attempt.id)],
      evidence: [evidence("work_planner_attempts", attempt.id, iso(attempt.startedAt))],
      facts: sanitizeExecutionValue({ attempt: attempt.attempt, result: attempt.plannerResult, failure: attempt.failure }, viewer.role) as Record<string, unknown>,
      entityRefs: [],
    });
    if (decisionContextNode || contextNode || inputNode) addEdge({
      from: decisionContextNode ?? contextNode ?? inputNode!,
      to: id,
      relation: "informed_planning",
      evidenceRefs: [sourceRef("work_planner_attempts", attempt.id), ...(attempt.workInputId ? [`${sourceRef("work_planner_attempts", attempt.id)}.work_input_id`] : [])],
      explanation: "The planner attempt durably references its Work input and captured decision context.",
    });
    if (!decisionContextNode) addMissing(`missing:decision-context:${attempt.id}`, iso(attempt.startedAt), "This planner attempt predates immutable decision-time context capture.", id);
  }

  const objectivePlannerByStep = new Map<string, string[]>();
  for (const attempt of objectiveAttempts) {
    const id = `objective-planner:${attempt.id}`;
    addNode({
      id,
      stage: attempt.status === "failed" || attempt.status === "timed_out" ? "failure" : "planning",
      title: `Objective planner attempt ${attempt.attempt}`,
      summary: humanize(attempt.status),
      status: attempt.status,
      occurredAt: iso(attempt.startedAt),
      sourceRefs: [sourceRef("work_objective_planner_attempts", attempt.id)],
      evidence: [evidence("work_objective_planner_attempts", attempt.id, iso(attempt.startedAt), "available", attempt.inspectionHash)],
      facts: sanitizeExecutionValue({ provider: attempt.provider, inspectionHash: attempt.inspectionHash, decision: attempt.decision, failure: attempt.failure }, viewer.role) as Record<string, unknown>,
      entityRefs: [],
    });
    objectivePlannerByStep.set(attempt.objectiveStepId, [...(objectivePlannerByStep.get(attempt.objectiveStepId) ?? []), id]);
  }

  const objectiveStepNodeById = new Map<string, string>();
  for (const step of objectiveSteps) {
    const id = `objective-step:${step.id}`;
    objectiveStepNodeById.set(step.id, id);
    addNode({
      id,
      stage: step.iterationOutcome === "failed" || step.iterationOutcome === "blocked" ? "failure" : step.decisionKind === "wait" ? "external_event" : "planning",
      title: `Objective iteration ${step.stepNumber}`,
      summary: text(step.decisionReason, step.decisionKind ? humanize(step.decisionKind) : humanize(step.phase)),
      status: step.iterationOutcome ?? step.phase,
      occurredAt: iso(step.startedAt),
      sourceRefs: [sourceRef("work_objective_steps", step.id)],
      evidence: [evidence("work_objective_steps", step.id, iso(step.startedAt), step.inspectionHash ? "available" : "unavailable", step.inspectionHash)],
      facts: sanitizeExecutionValue({ inspection: step.inspection, inspectionHash: step.inspectionHash, decision: step.decision, observation: step.observation, recoveryKind: step.recoveryKind, successVerification: step.successVerification, failure: step.failure }, viewer.role) as Record<string, unknown>,
      entityRefs: [],
    });
    for (const plannerId of objectivePlannerByStep.get(step.id) ?? []) addEdge({
      from: plannerId,
      to: id,
      relation: "produced_objective_decision",
      evidenceRefs: [`${sourceRef("work_objective_planner_attempts", plannerId.slice("objective-planner:".length))}.objective_step_id`],
      explanation: "The objective planner attempt is durably bound to this exact objective step.",
    });
  }

  const executionNodeByAction = new Map(execution.nodes.map((node) => [node.id, node]));
  const actionNodeById = new Map<string, string>();
  const policyNodeByAction = new Map<string, string>();
  const authorityNodeByAction = new Map<string, string>();
  const approvalNodeByAction = new Map<string, string>();
  const effectNodeByAction = new Map<string, string>();
  const policyByIdentity = new Map(extra.policyRows.map((row) => [`${row.policyId}:${row.version}`, row]));
  const authorityByAction = new Map(extra.authorityRows.flatMap((row) => row.domainActionId ? [[row.domainActionId, row] as const] : []));
  const approvalByAction = new Map(extra.approvalRows.map((row) => [row.domainActionId, row]));
  const effectByAction = new Map(extra.effectRows.flatMap((row) => row.domainActionId ? [[row.domainActionId, row] as const] : []));
  for (const action of actions) {
    const projected = executionNodeByAction.get(action.id);
    const id = `action:${action.id}`;
    actionNodeById.set(action.id, id);
    addNode({
      id,
      stage: action.status === "failed" || action.status === "blocked_integration_unavailable" ? "failure" : action.status === "completed" ? "execution" : "planning",
      title: action.summary ?? humanize(action.actionType),
      summary: `${humanize(action.actionType)} · ${humanize(action.status)}`,
      status: action.status,
      occurredAt: iso(action.createdAt),
      sourceRefs: [sourceRef("domain_actions", action.id)],
      evidence: [evidence("domain_actions", action.id, iso(action.createdAt))],
      facts: sanitizeExecutionValue({
        actionType: action.actionType,
        payload: action.payload,
        planId: action.planId,
        groundedPayload: action.groundedPayload,
        compiledGraph: action.compiledGraph,
        expectedResult: projected?.intent.expectedResult ?? null,
        externalEffect: projected?.externalEffect ?? "unknown",
      }, viewer.role) as Record<string, unknown>,
      entityRefs: projected?.targets.map((target) => ({ entityType: target.entityType, entityId: target.entityId })) ?? [],
    });
    const plannerId = action.plannerAttemptId ? plannerNodeById.get(action.plannerAttemptId) : undefined;
    const objectiveStepId = action.objectiveStepId ? objectiveStepNodeById.get(action.objectiveStepId) : undefined;
    const inputId = action.instructionId ? inputs.find((input) => input.instructionId === action.instructionId)?.id : undefined;
    const upstream = plannerId ?? objectiveStepId ?? (inputId ? inputNodeById.get(inputId) : undefined);
    if (upstream) addEdge({
      from: upstream,
      to: id,
      relation: "proposed_action",
      evidenceRefs: [action.plannerAttemptId ? `${sourceRef("domain_actions", action.id)}.planner_attempt_id` : action.objectiveStepId ? `${sourceRef("domain_actions", action.id)}.objective_step_id` : `${sourceRef("domain_actions", action.id)}.instruction_id`],
      explanation: "The action row stores the exact planner, objective-step, or instruction relationship that proposed it.",
    });
    else addMissing(`missing:action-origin:${action.id}`, iso(action.createdAt), `Action ${action.id} has no durable planner, objective-step, or instruction relationship.`, id);

    const revision = action.policyId && action.policyVersion ? policyByIdentity.get(`${action.policyId}:${action.policyVersion}`) : undefined;
    if (revision) {
      const policyId = `policy:${revision.id}`;
      policyNodeByAction.set(action.id, policyId);
      addNode({
        id: policyId,
        stage: "policy",
        title: `${humanize(revision.actionType)} policy v${revision.version}`,
        summary: revision.requiresConfirmation ? "Human confirmation required by the recorded revision." : "The recorded revision allowed unattended execution.",
        status: "historical revision",
        occurredAt: iso(revision.effectiveFrom),
        sourceRefs: [sourceRef("domain_policy_revisions", revision.id)],
        evidence: [evidence("domain_policy_revisions", revision.id, iso(revision.createdAt))],
        facts: sanitizeExecutionValue({ version: revision.version, policy: revision.policy, requiresConfirmation: revision.requiresConfirmation, effectiveFrom: revision.effectiveFrom }, viewer.role) as Record<string, unknown>,
        entityRefs: [],
      });
      addEdge({ from: id, to: policyId, relation: "governed_by_policy", evidenceRefs: [`${sourceRef("domain_actions", action.id)}.policy_id`, `${sourceRef("domain_actions", action.id)}.policy_version`], explanation: "The action stores the exact policy id and version that governed it." });
    } else {
      addMissing(`missing:policy:${action.id}`, iso(action.createdAt), `Action ${action.id} has no resolvable historical policy revision.`, id);
    }

    const effect = effectByAction.get(action.id);
    if (effect) {
      const effectId = `effect:${effect.id}`;
      effectNodeByAction.set(action.id, effectId);
      const contract = record(effect.effect);
      addNode({
        id: effectId,
        stage: "planning",
        title: "Business Effect compiled",
        summary: `${humanize(effect.operationClass)} · ${humanize(effect.status)}`,
        status: effect.status,
        occurredAt: iso(effect.createdAt),
        sourceRefs: [sourceRef("business_effects", effect.id)],
        evidence: [evidence("business_effects", effect.id, iso(effect.createdAt), "available", effect.semanticHash)],
        facts: sanitizeExecutionValue({ semanticHash: effect.semanticHash, scopeHash: effect.scopeHash, contract, verification: effect.verification }, viewer.role) as Record<string, unknown>,
        entityRefs: Array.isArray(contract.targets) ? contract.targets.flatMap((target) => { const row = record(target); return typeof row.type === "string" && typeof row.id === "string" ? [{ entityType: row.type, entityId: row.id }] : []; }) : [],
      });
      addEdge({ from: policyNodeByAction.get(action.id) ?? id, to: effectId, relation: "compiled_business_effect", evidenceRefs: [sourceRef("business_effects", effect.id), `${sourceRef("domain_actions", action.id)}.business_effect_id`], explanation: "The DomainAction is immutably bound to the canonical Business Effect compiled before approval or execution." });
    }

    const decision = authorityByAction.get(action.id);
    if (decision) {
      const authorityId = `authority:${decision.id}`;
      authorityNodeByAction.set(action.id, authorityId);
      addNode({
        id: authorityId,
        stage: "authority",
        title: `Authority ${humanize(decision.outcome)}`,
        summary: `${decision.capability} · revision ${decision.authorityRevision} · ${humanize(decision.reasonCode)}`,
        status: decision.outcome,
        occurredAt: iso(decision.createdAt),
        sourceRefs: [sourceRef("authority_decisions", decision.id)],
        evidence: [evidence("authority_decisions", decision.id, iso(decision.createdAt))],
        facts: sanitizeExecutionValue({ employeeId: decision.employeeId, revision: decision.authorityRevision, operation: decision.operation, capability: decision.capability, resourceType: decision.resourceType, resourceId: decision.resourceId, risk: decision.risk, outcome: decision.outcome, reasonCode: decision.reasonCode, evidence: decision.evidence }, viewer.role) as Record<string, unknown>,
        entityRefs: decision.resourceId ? [{ entityType: decision.resourceType, entityId: decision.resourceId }] : [],
      });
      addEdge({ from: effectNodeByAction.get(action.id) ?? policyNodeByAction.get(action.id) ?? id, to: authorityId, relation: "evaluated_authority", evidenceRefs: [sourceRef("authority_decisions", decision.id), `${sourceRef("authority_decisions", decision.id)}.domain_action_id`, ...(decision.businessEffectId ? [`${sourceRef("authority_decisions", decision.id)}.business_effect_id`] : [])], explanation: "The immutable authority decision is durably linked to this action, effect, and decision-time revision." });
    } else {
      addMissing(`missing:authority:${action.id}`, iso(action.createdAt), `Action ${action.id} has no durable authority decision.`, policyNodeByAction.get(action.id) ?? id);
    }

    const approval = approvalByAction.get(action.id);
    if (approval) {
      const approvalId = `approval:${approval.id}`;
      approvalNodeByAction.set(action.id, approvalId);
      const steps = extra.approvalSteps.filter((step) => step.approvalRequestId === approval.id);
      addNode({
        id: approvalId,
        stage: "approval",
        title: `Approval ${humanize(approval.status)}`,
        summary: steps.map((step) => `${step.sequence}. ${humanize(step.status)}`).join(" · ") || `Step ${approval.currentStep}`,
        status: approval.status,
        occurredAt: iso(approval.resolvedAt ?? approval.createdAt),
        sourceRefs: [sourceRef("authority_approval_requests", approval.id), ...steps.map((step) => sourceRef("authority_approval_request_steps", step.id))],
        evidence: [evidence("authority_approval_requests", approval.id, iso(approval.createdAt)), ...steps.map((step) => evidence("authority_approval_request_steps", step.id, iso(step.decidedAt ?? approval.createdAt)))],
        facts: { requesterId: approval.requesterId, currentStep: approval.currentStep, steps: steps.map((step) => ({ sequence: step.sequence, capability: step.approverCapability, status: step.status, decidedBy: step.decidedBy, decidedAt: iso(step.decidedAt, "") || null })) },
        entityRefs: [],
      });
      addEdge({ from: authorityNodeByAction.get(action.id) ?? id, to: approvalId, relation: "required_approval", evidenceRefs: [`${sourceRef("authority_approval_requests", approval.id)}.authority_decision_id`, `${sourceRef("authority_approval_requests", approval.id)}.domain_action_id`], explanation: "The approval request references both the authority decision and exact consequence-bearing action." });
    }
  }

  for (const action of actions) {
    for (const dependencyId of action.dependsOn) {
      const from = actionNodeById.get(dependencyId);
      const to = actionNodeById.get(action.id);
      if (from && to) addEdge({ from, to, relation: "must_complete_before", evidenceRefs: [`${sourceRef("domain_actions", action.id)}.depends_on`], explanation: "The dependency is stored on the dependent DomainAction; parallel actions remain unconnected." });
      else addMissing(`missing:dependency:${action.id}:${dependencyId}`, iso(action.createdAt), `Dependency ${dependencyId} referenced by action ${action.id} is unavailable in this Work.`, to);
    }
  }

  const commandNodeByRun = new Map<string, string>();
  for (const row of extra.commandRows) {
    const command = row.command;
    const id = `execution-authorization:${command.id}`;
    commandNodeByRun.set(row.runId, id);
    addNode({
      id,
      stage: command.status === "failed" || command.status === "cancelled" ? "failure" : "approval",
      title: "Durable effect authorization",
      summary: `${humanize(command.commandType)} · ${humanize(command.status)}`,
      status: command.status,
      occurredAt: iso(command.authorizedAt ?? command.createdAt),
      sourceRefs: [sourceRef("commands", command.id)],
      evidence: [evidence("commands", command.id, iso(command.authorizedAt ?? command.createdAt), command.authorizedEffectHash ? "available" : "unavailable", command.authorizedEffectHash)],
      facts: sanitizeExecutionValue({
        businessEffectId: command.businessEffectId,
        authorizedEffectHash: command.authorizedEffectHash,
        authorityDecisionId: command.authorityDecisionId,
        authorityRevision: command.authorityRevision,
        policyId: command.policyId,
        policyVersion: command.policyVersion,
        executionClass: command.executionClass,
        cancellationRequestedAt: iso(command.cancellationRequestedAt, "") || null,
      }, viewer.role) as Record<string, unknown>,
      entityRefs: [],
    });
    const actionId = workflowStepRows.find((step) => step.workflowRunId === row.runId)?.domainActionId;
    const upstream = actionId ? approvalNodeByAction.get(actionId) ?? authorityNodeByAction.get(actionId) ?? actionNodeById.get(actionId) : undefined;
    if (upstream) addEdge({
      from: upstream,
      to: id,
      relation: "authorized_exact_effect",
      evidenceRefs: [`${sourceRef("commands", command.id)}.authorized_effect_hash`, `${sourceRef("commands", command.id)}.business_effect_id`],
      explanation: "The final decision and durable command reference the exact immutable Business Effect and authorization revision.",
    });
  }

  const providerNodesByAction = new Map<string, string[]>();
  const attachProvider = (actionId: string, nodeId: string, evidenceRef: string) => {
    providerNodesByAction.set(actionId, [...(providerNodesByAction.get(actionId) ?? []), nodeId]);
    const upstream = approvalNodeByAction.get(actionId) ?? authorityNodeByAction.get(actionId) ?? actionNodeById.get(actionId);
    if (upstream) addEdge({ from: upstream, to: nodeId, relation: "authorized_dispatch", evidenceRefs: [evidenceRef], explanation: "The execution record carries the exact action foreign key; approval/authority remains a separate preceding fact." });
  };
  for (const operation of extra.externalRows) {
    const id = `external-operation:${operation.domainActionId}:${operation.operationKey}`;
    const ref = `external_operations:${operation.domainActionId}:${operation.operationKey}`;
    addNode({ id, stage: operation.status === "failed" || operation.status === "unknown" ? "failure" : "provider", title: operation.provider ? `${humanize(operation.provider)} operation` : "External operation", summary: `${operation.operationKey} · ${humanize(operation.status)}`, status: operation.status, occurredAt: iso(operation.createdAt), sourceRefs: [ref], evidence: [evidence("external_operations", ref, iso(operation.updatedAt), operation.response === null ? "unavailable" : "available", operation.requestHash)], facts: sanitizeExecutionValue({ provider: operation.provider, operationKey: operation.operationKey, requestHash: operation.requestHash, response: operation.response }, viewer.role) as Record<string, unknown>, entityRefs: [] });
    attachProvider(operation.domainActionId, id, `${ref}.domain_action_id`);
  }
  for (const delivery of extra.deliveryRows) {
    const id = `delivery:${delivery.id}`;
    addNode({ id, stage: delivery.status === "failed" || delivery.status === "unknown" ? "failure" : "provider", title: `${humanize(delivery.channel)} ${humanize(delivery.status)}`, summary: `${delivery.provider ?? humanize(delivery.route)} · ${humanize(delivery.status)}`, status: delivery.status, occurredAt: iso(delivery.updatedAt), sourceRefs: [sourceRef("communication_deliveries", delivery.id)], evidence: [evidence("communication_deliveries", delivery.id, iso(delivery.updatedAt), delivery.providerMessageRef ? "available" : "unavailable")], facts: sanitizeExecutionValue({ route: delivery.route, provider: delivery.provider, communicationIdentityId: delivery.communicationIdentityId, providerMessageRef: delivery.providerMessageRef, errorCode: delivery.errorCode }, viewer.role) as Record<string, unknown>, entityRefs: [{ entityType: delivery.recipientType, entityId: delivery.recipientId }] });
    attachProvider(delivery.domainActionId, id, `${sourceRef("communication_deliveries", delivery.id)}.domain_action_id`);
  }
  for (const run of execution.nodes.flatMap((node) => node.computer ? [{ actionId: node.id, run: node.computer }] : [])) {
    const id = `computer-run:${run.run.id}`;
    addNode({ id, stage: run.run.status === "failed" || run.run.status === "blocked" || run.run.effectStatus === "unknown" ? "failure" : "provider", title: `${humanize(run.run.application)} computer run`, summary: `${run.run.provider} · ${humanize(run.run.status)} · effect ${humanize(run.run.effectStatus)}`, status: run.run.status, occurredAt: run.run.createdAt, sourceRefs: [run.run.sourceRef], evidence: [evidence("computer_runs", run.run.id, run.run.finishedAt ?? run.run.createdAt)], facts: sanitizeExecutionValue({ mode: run.run.mode, task: run.run.task, target: run.run.target, account: run.run.account, actor: run.run.actor, effectStatus: run.run.effectStatus, result: run.run.result, failureCode: run.run.failureCode, blockReason: run.run.blockReason, steps: run.run.steps }, viewer.role) as Record<string, unknown>, entityRefs: [] });
    attachProvider(run.actionId, id, `${run.run.sourceRef}.domain_action_id`);
  }

  const stepNodeById = new Map<string, string>();
  for (const step of workflowStepRows) {
    const id = `workflow-step:${step.id}`;
    stepNodeById.set(step.id, id);
    addNode({ id, stage: step.status === "failed" || step.executionState === "reconciling" || step.executionState === "failed_after_possible_effect" ? "failure" : "execution", title: humanize(step.stepType), summary: `Workflow step ${step.sequence + 1} · ${humanize(step.executionState)}`, status: step.executionState, occurredAt: iso(step.updatedAt), sourceRefs: [sourceRef("workflow_steps", step.id)], evidence: [evidence("workflow_steps", step.id, iso(step.updatedAt))], facts: sanitizeExecutionValue({ localStatus: step.status, executionState: step.executionState, attempts: step.attempts, claimedAt: iso(step.claimedAt, "") || null, effectCommitAt: iso(step.effectCommitAt, "") || null, cancellationRequestedAt: iso(step.cancellationRequestedAt, "") || null, terminalReason: step.terminalReason, evidence: step.evidence }, viewer.role) as Record<string, unknown>, entityRefs: [] });
    const authorization = commandNodeByRun.get(step.workflowRunId);
    if (authorization) addEdge({ from: authorization, to: id, relation: "claimed_durable_execution", evidenceRefs: [`${sourceRef("workflow_steps", step.id)}.workflow_run_id`], explanation: "The worker step belongs to the run created by this exact durable authorization." });
    if (step.domainActionId && actionNodeById.has(step.domainActionId)) addEdge({ from: actionNodeById.get(step.domainActionId)!, to: id, relation: "executed_as_workflow_step", evidenceRefs: [`${sourceRef("workflow_steps", step.id)}.domain_action_id`], explanation: "The workflow step stores the exact originating DomainAction." });
  }
  for (const operation of extra.integrationRows) {
    const id = `integration-operation:${operation.id}`;
    addNode({ id, stage: operation.status === "failed" || operation.status === "unknown" ? "failure" : "provider", title: `${humanize(operation.capability)} provider operation`, summary: `${operation.provider ?? "provider unavailable"} · ${humanize(operation.status)}`, status: operation.status, occurredAt: iso(operation.updatedAt), sourceRefs: [sourceRef("integration_operations", operation.id)], evidence: [evidence("integration_operations", operation.id, iso(operation.updatedAt), operation.response === null ? "unavailable" : "available", operation.requestHash)], facts: sanitizeExecutionValue({ provider: operation.provider, capability: operation.capability, operationKey: operation.operationKey, requestHash: operation.requestHash, response: operation.response }, viewer.role) as Record<string, unknown>, entityRefs: [] });
    const step = stepNodeById.get(operation.workflowStepId);
    if (step) addEdge({ from: step, to: id, relation: "dispatched_provider_operation", evidenceRefs: [`${sourceRef("integration_operations", operation.id)}.workflow_step_id`], explanation: "The provider operation is keyed to the exact workflow step." });
  }
  for (const event of extra.outboxRows) {
    const id = `outbox-event:${event.id}`;
    addNode({ id, stage: event.status === "failed" || event.status === "unknown" ? "failure" : "provider", title: `Outbound ${humanize(event.eventType)}`, summary: `${humanize(event.status)} after ${event.attempts} attempt${event.attempts === 1 ? "" : "s"}`, status: event.status, occurredAt: iso(event.deliveredAt ?? event.createdAt), sourceRefs: [sourceRef("outbox_events", event.id)], evidence: [evidence("outbox_events", event.id, iso(event.createdAt))], facts: { eventType: event.eventType, envelopeVersion: event.envelopeVersion, attempts: event.attempts, lastErrorKind: event.lastErrorKind }, entityRefs: [] });
    const step = event.workflowStepId ? stepNodeById.get(event.workflowStepId) : undefined;
    if (step) addEdge({ from: step, to: id, relation: "enqueued_outbound_effect", evidenceRefs: [`${sourceRef("outbox_events", event.id)}.workflow_step_id`], explanation: "The transactional outbox record stores the exact workflow step that enqueued the external effect." });
  }
  for (const event of extra.inboxRows) {
    const id = `inbox-event:${event.id}`;
    addNode({ id, stage: "external_event", title: `${humanize(event.provider)} callback`, summary: `${humanize(event.status)} · envelope v${event.envelopeVersion}`, status: event.status, occurredAt: iso(event.receivedAt), sourceRefs: [sourceRef("inbox_events", event.id)], evidence: [evidence("inbox_events", event.id, iso(event.receivedAt), "available", event.payloadHash)], facts: { provider: event.provider, eventId: event.eventId, payloadHash: event.payloadHash, envelopeVersion: event.envelopeVersion }, entityRefs: [] });
    const step = event.matchedStepId ? stepNodeById.get(event.matchedStepId) : undefined;
    if (step) addEdge({ from: id, to: step, relation: "matched_provider_callback", evidenceRefs: [`${sourceRef("inbox_events", event.id)}.matched_step_id`], explanation: "The inbox event records the exact workflow step selected by callback matching." });
  }
  for (const event of extra.universalRows) {
    const id = `universal-action-event:${event.id}`;
    addNode({ id, stage: actionEventStage(event.eventType), title: humanize(event.eventType), summary: `${humanize(event.actionType)} via ${event.route ? humanize(event.route) : "unrecorded route"}`, status: "recorded", occurredAt: iso(event.createdAt), sourceRefs: [sourceRef("universal_action_events", event.id)], evidence: [evidence("universal_action_events", event.id, iso(event.createdAt))], facts: sanitizeExecutionValue({ sequence: event.seq, route: event.route, actorId: event.actorId, evidence: event.evidence }, viewer.role) as Record<string, unknown>, entityRefs: event.subjectType && event.subjectId ? [{ entityType: event.subjectType, entityId: event.subjectId }] : [] });
    const action = actionNodeById.get(event.domainActionId);
    if (action) addEdge({ from: action, to: id, relation: "recorded_action_transition", evidenceRefs: [`${sourceRef("universal_action_events", event.id)}.domain_action_id`], explanation: "The append-only universal action event is bound to the exact DomainAction." });
  }

  for (const event of integrationEventRows) {
    const id = `integration-event:${event.id}`;
    addNode({ id, stage: "external_event", title: humanize(event.eventType), summary: `${event.provider ?? event.source} · ${humanize(event.status)}`, status: event.status, occurredAt: iso(event.occurredAt), sourceRefs: [sourceRef("integration_events", event.id)], evidence: [evidence("integration_events", event.id, iso(event.receivedAt))], facts: { source: event.source, provider: event.provider, trustClass: event.trustClass, evidenceCount: Array.isArray(event.evidenceRefs) ? event.evidenceRefs.length : 0 }, entityRefs: [] });
    const action = event.domainActionId ? actionNodeById.get(event.domainActionId) : undefined;
    const computer = event.computerRunId ? `computer-run:${event.computerRunId}` : undefined;
    if (action || (computer && nodeIds.has(computer))) addEdge({ from: computer && nodeIds.has(computer) ? computer : action!, to: id, relation: "observed_external_event", evidenceRefs: [event.domainActionId ? `${sourceRef("integration_events", event.id)}.domain_action_id` : `${sourceRef("integration_events", event.id)}.computer_run_id`], explanation: "The integration event carries an exact action or computer-run correlation." });
  }
  for (const wait of eventWaits) {
    const id = `event-wait:${wait.id}`;
    addNode({ id, stage: wait.status === "timed_out" ? "failure" : "external_event", title: `Wait for ${humanize(wait.expectedEventType)}`, summary: wait.conditionSummary, status: wait.status, occurredAt: iso(wait.satisfiedAt ?? wait.timedOutAt ?? wait.createdAt), sourceRefs: [sourceRef("work_event_waits", wait.id)], evidence: [evidence("work_event_waits", wait.id, iso(wait.createdAt))], facts: { matchedEventId: wait.matchedEventId }, entityRefs: [] });
    const step = objectiveStepNodeById.get(wait.objectiveStepId);
    if (step) addEdge({ from: step, to: id, relation: "paused_for_exact_event", evidenceRefs: [`${sourceRef("work_event_waits", wait.id)}.objective_step_id`], explanation: "The wait contract is owned by the objective step that paused." });
  }
  for (const claim of wakeClaims) {
    const wait = `event-wait:${claim.waitId}`;
    const event = `integration-event:${claim.integrationEventId}`;
    const objectiveStepId = eventWaits.find((candidate) => candidate.id === claim.waitId)?.objectiveStepId;
    const step = objectiveStepId ? objectiveStepNodeById.get(objectiveStepId) : undefined;
    if (nodeIds.has(wait) && nodeIds.has(event)) addEdge({ from: event, to: wait, relation: "satisfied_wait", evidenceRefs: [sourceRef("work_wake_claims", claim.id)], explanation: "The durable wake claim links one exact integration event to one exact wait." });
    if (step && nodeIds.has(event)) addEdge({ from: event, to: step, relation: "continued_objective", evidenceRefs: [sourceRef("work_wake_claims", claim.id)], explanation: "The wake claim continues only the objective step recorded on the claim." });
  }

  for (const event of extra.instructionRows) {
    const id = `instruction-event:${event.id}`;
    addNode({ id, stage: actionEventStage(event.phase), title: humanize(event.phase), summary: `Instruction trace ${event.seq}`, status: "recorded", occurredAt: iso(event.createdAt), sourceRefs: [sourceRef("instruction_events", event.id)], evidence: [evidence("instruction_events", event.id, iso(event.createdAt))], facts: { sequence: event.seq, phase: event.phase }, entityRefs: [] });
    const input = inputs.find((candidate) => candidate.instructionId === event.instructionId);
    const trigger = input ? inputNodeById.get(input.id) : undefined;
    if (trigger) addEdge({ from: trigger, to: id, relation: "instruction_phase", evidenceRefs: [`${sourceRef("instruction_events", event.id)}.instruction_id`], explanation: "The append-only instruction trace is bound to the exact instruction session used by this Work input." });
  }

  for (const event of extra.businessRows) {
    const id = `business-event:${event.id}`;
    addNode({ id, stage: "canonical_change", title: humanize(event.eventType), summary: `${humanize(event.entityType)} changed in the canonical business system.`, status: "recorded", occurredAt: iso(event.occurredAt), sourceRefs: [sourceRef("business_events", event.id)], evidence: [evidence("business_events", event.id, iso(event.occurredAt))], facts: sanitizeExecutionValue({ source: event.source, payload: event.payload }, viewer.role) as Record<string, unknown>, entityRefs: [{ entityType: event.entityType, entityId: event.entityId }] });
    const operationId = event.source?.startsWith("business_operation:") ? event.source.slice("business_operation:".length) : null;
    const operation = operations.find((candidate) => candidate.id === operationId);
    const actionId = operation?.domainActionId ?? (event.source?.startsWith("domain_action:") ? event.source.slice("domain_action:".length) : actionIds.includes(event.source ?? "") ? event.source : null);
    const providers = actionId ? providerNodesByAction.get(actionId) ?? [] : [];
    const upstream = providers.at(-1) ?? (actionId ? actionNodeById.get(actionId) : undefined);
    if (upstream) addEdge({ from: upstream, to: id, relation: "produced_canonical_change", evidenceRefs: [sourceRef("business_events", event.id)], explanation: "The business event source contains the exact action or business-operation identity." });
  }

  for (const receipt of receipts) {
    const projected = execution.receipts.find((row) => row.id === receipt.id);
    const at = iso(receipt.finalizedAt ?? receipt.createdAt);
    const verificationId = `verification:${receipt.id}`;
    const hasVerification = Boolean(receipt.actualResult || receipt.failure || (Array.isArray(receipt.evidence) && receipt.evidence.length > 0));
    if (hasVerification) addNode({ id: verificationId, stage: receipt.failure ? "failure" : "verification", title: receipt.failure ? "Verification recorded a failure" : "Result verification", summary: receipt.failure ? text(record(receipt.failure).message, "The receipt records a failed outcome.") : receipt.actualResult ? "Actual result and evidence were recorded separately from dispatch." : "Evidence was recorded; no actual-result payload is available.", status: receipt.failure ? "failed" : receipt.actualResult ? "verified" : "evidence only", occurredAt: at, sourceRefs: [`${sourceRef("decision_receipts", receipt.id)}.actual_result`, `${sourceRef("decision_receipts", receipt.id)}.evidence`], evidence: projected?.evidence.length ? projected.evidence.map((item) => evidence(item.source, item.ref, item.timestamp, item.restricted ? "restricted" : "available")) : [evidence("decision_receipts", receipt.id, at, receipt.actualResult || receipt.failure ? "available" : "unavailable")], facts: sanitizeExecutionValue({ expectedResult: receipt.expectedResult, actualResult: receipt.actualResult, evidence: receipt.evidence, failure: receipt.failure }, viewer.role) as Record<string, unknown>, entityRefs: [] });
    const receiptId = `receipt:${receipt.id}`;
    addNode({ id: receiptId, stage: "receipt", title: receipt.objective, summary: receipt.finalizedAt ? "Canonical receipt finalized." : "Receipt remains open; terminal proof is incomplete.", status: receipt.finalizedAt ? "finalized" : "open", occurredAt: at, sourceRefs: [sourceRef("decision_receipts", receipt.id)], evidence: [evidence("decision_receipts", receipt.id, iso(receipt.createdAt))], facts: sanitizeExecutionValue({ policyApplied: receipt.policyApplied, riskTier: receipt.riskTier, approval: receipt.approval, correlationId: receipt.correlationId }, viewer.role) as Record<string, unknown>, entityRefs: [] });
    const action = receipt.domainActionId ? actionNodeById.get(receipt.domainActionId) : undefined;
    const step = receipt.workflowStepId ? stepNodeById.get(receipt.workflowStepId) : undefined;
    const upstream = step ?? action;
    if (hasVerification && upstream) addEdge({ from: upstream, to: verificationId, relation: "verified_effect", evidenceRefs: [receipt.domainActionId ? `${sourceRef("decision_receipts", receipt.id)}.domain_action_id` : `${sourceRef("decision_receipts", receipt.id)}.workflow_step_id`], explanation: "The receipt links verification to the exact action or workflow step." });
    else if (!upstream) addMissing(`missing:receipt-origin:${receipt.id}`, at, `Receipt ${receipt.id} has no available action or workflow-step relationship.`, receiptId);
    if (hasVerification) addEdge({ from: verificationId, to: receiptId, relation: "settled_receipt", evidenceRefs: [sourceRef("decision_receipts", receipt.id)], explanation: "Verification and receipt fields coexist on the same canonical receipt row." });
    else addMissing(`missing:verification:${receipt.id}`, at, `Receipt ${receipt.id} contains no recorded verification evidence or actual outcome.`, receiptId);
  }

  for (const repair of repairs) {
    const id = `recovery:${repair.id}`;
    addNode({ id, stage: "recovery", title: "Plan recovery", summary: `${humanize(repair.status)} after action ${repair.failedDomainActionId}`, status: repair.status, occurredAt: iso(repair.proposedAt ?? repair.createdAt), sourceRefs: [sourceRef("plan_repairs", repair.id)], evidence: [evidence("plan_repairs", repair.id, iso(repair.createdAt))], facts: sanitizeExecutionValue({ terminalReceipt: repair.terminalReceipt }, viewer.role) as Record<string, unknown>, entityRefs: [] });
    const failed = actionNodeById.get(repair.failedDomainActionId);
    if (failed) addEdge({ from: failed, to: id, relation: "triggered_recovery", evidenceRefs: [`${sourceRef("plan_repairs", repair.id)}.failed_domain_action_id`], explanation: "The repair row references the exact failed action; recovery does not erase it." });
  }
  for (const recovery of extra.reconciliationRows) {
    const id = `reconciliation:${recovery.id}`;
    addNode({ id, stage: "recovery", title: "External effect reconciliation", summary: `${humanize(recovery.caseType)} · ${humanize(recovery.status)}`, status: recovery.status, occurredAt: iso(recovery.resolvedAt ?? recovery.createdAt), sourceRefs: [sourceRef("reconciliation_cases", recovery.id)], evidence: [evidence("reconciliation_cases", recovery.id, iso(recovery.createdAt))], facts: sanitizeExecutionValue(recovery.details, viewer.role) as Record<string, unknown>, entityRefs: [] });
    if (recovery.relatedStepId && stepNodeById.has(recovery.relatedStepId)) addEdge({ from: stepNodeById.get(recovery.relatedStepId)!, to: id, relation: "opened_reconciliation", evidenceRefs: [`${sourceRef("reconciliation_cases", recovery.id)}.related_step_id`], explanation: "The reconciliation case preserves the exact uncertain workflow step." });
  }
  for (const compensation of extra.compensationRows) {
    const id = `compensation:${compensation.id}`;
    addNode({ id, stage: "compensation", title: "Compensating action", summary: `${humanize(compensation.status)} · ${compensation.reason}`, status: compensation.status, occurredAt: iso(compensation.resolvedAt ?? compensation.createdAt), sourceRefs: [sourceRef("compensation_cases", compensation.id)], evidence: [evidence("compensation_cases", compensation.id, iso(compensation.createdAt))], facts: sanitizeExecutionValue(compensation.details, viewer.role) as Record<string, unknown>, entityRefs: [] });
    const original = stepNodeById.get(compensation.workflowStepId);
    if (original) addEdge({ from: original, to: id, relation: "compensated_by", evidenceRefs: [`${sourceRef("compensation_cases", compensation.id)}.workflow_step_id`], explanation: "Compensation is a later durable fact linked to the original step; original history remains intact." });
  }

  const actionEventsTruncated = extra.actionEventsPlus.length > ACTION_EVENT_LIMIT;
  for (const event of extra.actionEventsPlus.slice(0, ACTION_EVENT_LIMIT).filter((event) => /fail|error|timeout|blocked|unknown|recover|retry|reconcil|gate|confirm|reject|approv|escalat/i.test(event.step))) {
    const id = `action-event:${event.id}`;
    const stage = actionEventStage(event.step);
    addNode({ id, stage, title: humanize(event.step), summary: `${humanize(event.step)} for ${event.domainActionId}`, status: stage === "failure" ? "failed" : "recorded", occurredAt: iso(event.timestamp), sourceRefs: [sourceRef("action_log", event.id)], evidence: [evidence("action_log", event.id, iso(event.timestamp))], facts: sanitizeExecutionValue({ input: event.input, output: event.output }, viewer.role) as Record<string, unknown>, entityRefs: [] });
    const action = actionNodeById.get(event.domainActionId);
    if (action) addEdge({ from: action, to: id, relation: `action_${event.step}`, evidenceRefs: [`${sourceRef("action_log", event.id)}.domain_action_id`], explanation: "The append-only action log records this exact action episode." });
  }

  const retentionDays = extra.artifactRetention?.retentionDays ?? 90;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const artifactsTruncated = extra.artifactRowsPlus.length > ARTIFACT_LIMIT;
  for (const artifact of extra.artifactRowsPlus.slice(0, ARTIFACT_LIMIT)) {
    const available = artifact.content !== null || artifact.storageRef !== null;
    const expired = !available && !extra.artifactRetention?.legalHold && artifact.createdAt.getTime() < cutoff;
    const availability: CausalEvidenceAvailability = available ? "available" : expired ? "expired" : "unavailable";
    const id = `computer-artifact:${artifact.id}`;
    addNode({ id, stage: "evidence", title: `${humanize(artifact.kind)} evidence`, summary: `${artifact.mimeType} · ${artifact.sizeBytes} bytes · ${statusForAvailability(availability)}`, status: statusForAvailability(availability), occurredAt: iso(artifact.createdAt), sourceRefs: [sourceRef("computer_artifacts", artifact.id)], evidence: [evidence("computer_artifacts", artifact.id, iso(artifact.createdAt), availability, artifact.sha256)], facts: sanitizeExecutionValue({ kind: artifact.kind, mimeType: artifact.mimeType, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256, metadata: artifact.metadata, retentionDays, legalHold: extra.artifactRetention?.legalHold ?? false }, viewer.role) as Record<string, unknown>, entityRefs: [] });
    const run = `computer-run:${artifact.runId}`;
    if (nodeIds.has(run)) addEdge({ from: run, to: id, relation: "produced_evidence", evidenceRefs: [`${sourceRef("computer_artifacts", artifact.id)}.run_id`], explanation: "Artifact metadata remains linked to the exact computer run even when retained content expires." });
  }

  for (const query of queryExecutions) {
    const id = `query:${query.id}`;
    addNode({ id, stage: query.status === "failed" ? "failure" : "evidence", title: humanize(query.intent), summary: `${query.rowCount} canonical row${query.rowCount === 1 ? "" : "s"} · ${humanize(query.status)}`, status: query.status, occurredAt: iso(query.completedAt ?? query.startedAt), sourceRefs: [sourceRef("work_query_executions", query.id)], evidence: [evidence("work_query_executions", query.id, iso(query.startedAt))], facts: sanitizeExecutionValue({ resultSummary: query.resultSummary }, viewer.role) as Record<string, unknown>, entityRefs: [] });
    const input = query.workInputId ? inputNodeById.get(query.workInputId) : undefined;
    if (input) addEdge({ from: input, to: id, relation: "executed_read", evidenceRefs: [`${sourceRef("work_query_executions", query.id)}.work_input_id`], explanation: "The deterministic query receipt is durably linked to the Work input that requested it." });
  }

  for (const event of workEvents.filter((event) => /fail|block|recover|reconcil|cancel|interrupted/i.test(event.eventType))) {
    const id = `work-event:${event.id}`;
    const stage: CausalReplayStage = /recover|reconcil/i.test(event.eventType) ? "recovery" : "failure";
    addNode({ id, stage, title: humanize(event.eventType), summary: `${event.fromStatus ?? "start"} → ${event.toStatus}`, status: event.toStatus, occurredAt: iso(event.createdAt), sourceRefs: [sourceRef("work_events", event.id)], evidence: [evidence("work_events", event.id, iso(event.createdAt))], facts: sanitizeExecutionValue(event.payload, viewer.role) as Record<string, unknown>, entityRefs: [] });
  }

  if (nodes.length === 0) addMissing(`missing:work:${workId}`, iso(work.createdAt), "No causal child records are available for this Work.");
  for (const action of execution.nodes.filter((node) => node.sourceStatus === "completed" && node.observation.verification !== "verified" && !node.receiptIds.length)) {
    addMissing(`missing:action-verification:${action.id}`, action.timestamps.lastChangedAt, `Completed action ${action.id} has no verified receipt or observation.`, actionNodeById.get(action.id));
  }
  for (const action of execution.nodes.filter((node) => node.externalEffect === "confirmed" && (providerNodesByAction.get(node.id)?.length ?? 0) === 0)) {
    addMissing(`missing:provider-effect:${action.id}`, action.timestamps.lastChangedAt, `Action ${action.id} claims a confirmed external effect but has no replayable provider/computer record.`, actionNodeById.get(action.id));
  }

  const sortedNodes = nodes.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  const nodesTruncated = sortedNodes.length > NODE_LIMIT;
  const finalNodes = sortedNodes.slice(0, NODE_LIMIT);
  const retainedNodeIds = new Set(finalNodes.map((node) => node.id));
  const validEdges = edges.filter((edge) => retainedNodeIds.has(edge.from) && retainedNodeIds.has(edge.to));
  const edgesTruncated = validEdges.length > EDGE_LIMIT;
  const finalEdges = validEdges.slice(0, EDGE_LIMIT);
  const moments = [...new Map(finalNodes.map((node) => [node.occurredAt, node.occurredAt])).values()].map((at) => {
    const atNodes = finalNodes.filter((node) => node.occurredAt === at);
    return { at, nodeIds: atNodes.map((node) => node.id), headline: atNodes[0]?.title ?? "Recorded causal moment", stage: atNodes[0]?.stage ?? "evidence" };
  });
  const provenEdges = finalEdges.filter((edge) => edge.certainty === "proven").length;
  const missingEdges = finalEdges.filter((edge) => edge.certainty === "missing").length;
  const uniqueMissing = [...new Set(missing)];
  const legacyIncomplete = inputs.some((input) => !input.contextSnapshot) || plannerAttempts.some((attempt) => !attempt.decisionContextSnapshot);
  const finalizedReceipts = receipts.filter((receipt) => receipt.finalizedAt).length;
  const approvals = extra.approvalRows;
  const providers = extra.externalRows.length + extra.integrationRows.length + extra.deliveryRows.length + computerRunIds.length;
  const failures = finalNodes.filter((node) => node.stage === "failure").length;
  const recoveries = finalNodes.filter((node) => node.stage === "recovery" || node.stage === "compensation").length;
  const firstInput = inputs[0];
  return {
    version: 1,
    mode: "read_only",
    work: {
      id: work.id,
      status: work.status,
      executionModel: work.executionModel,
      objective: objectiveLoop?.objective ?? work.initialInstruction,
      objectiveState: objectiveLoop?.state ?? null,
      successCondition: objectiveLoop?.successCondition ?? null,
      successVerification: objectiveLoop?.successVerification ?? null,
      createdAt: iso(work.createdAt),
      updatedAt: iso(work.updatedAt),
    },
    nodes: finalNodes,
    edges: finalEdges,
    moments,
    explanation: {
      trigger: firstInput ? `${humanize(firstInput.channel)} instruction: ${firstInput.instructionText.slice(0, 500)}` : "No durable Work input is available.",
      context: plannerAttempts.some((attempt) => attempt.decisionContextSnapshot) ? "FINNOR froze decision-time interaction, entity, source, cohort, and authority provenance before planning." : inputs.some((input) => input.contextSnapshot) ? "The explicit interaction context is preserved; assembled planner provenance is incomplete." : "Decision-time context is unavailable for this legacy Work.",
      plan: actions.length ? `${actions.length} exact DomainAction${actions.length === 1 ? " was" : "s were"} proposed with ${actions.reduce((count, action) => count + action.dependsOn.length, 0)} stored dependenc${actions.reduce((count, action) => count + action.dependsOn.length, 0) === 1 ? "y" : "ies"}.` : queryExecutions.length ? `${queryExecutions.length} deterministic read executed; no consequential action was invented.` : "No action plan is recorded.",
      governance: `${extra.authorityRows.length} immutable authority decision${extra.authorityRows.length === 1 ? "" : "s"}; ${approvals.length} approval request${approvals.length === 1 ? "" : "s"}${approvals.some((approval) => approval.status === "rejected") ? ", including a permanent rejection" : ""}.`,
      execution: providers ? `${providers} provider, communication, integration, or computer execution record${providers === 1 ? "" : "s"} preserve intent separately from acknowledgement.` : "No provider execution was required or durably recorded.",
      verification: `${finalizedReceipts} finalized receipt${finalizedReceipts === 1 ? "" : "s"}; ${failures} failure fact${failures === 1 ? "" : "s"}; ${recoveries} recovery/compensation fact${recoveries === 1 ? "" : "s"}.`,
      outcome: `Work is ${humanize(work.status)}. The replay reports only durable facts and ${uniqueMissing.length ? `${uniqueMissing.length} explicit provenance gap${uniqueMissing.length === 1 ? "" : "s"}` : "no detected causal gaps"}.`,
      gaps: uniqueMissing,
    },
    completeness: { status: uniqueMissing.length === 0 ? "complete" : legacyIncomplete ? "legacy_incomplete" : "partial", provenEdges, missingEdges, missing: uniqueMissing },
    viewer: { role: viewer.role, evidenceVisibility: "full" },
    readOnlyGuarantee: { source: "durable_projection", method: "GET", mutationControlsIncluded: false, sideEffectsPossible: false },
    limits: { nodes: NODE_LIMIT, edges: EDGE_LIMIT, actionEvents: ACTION_EVENT_LIMIT, computerArtifacts: ARTIFACT_LIMIT },
    truncated: { nodes: nodesTruncated, edges: edgesTruncated, actionEvents: actionEventsTruncated, computerArtifacts: artifactsTruncated },
    asOf: new Date().toISOString(),
  };
}

// P2.T1 — the backward-compatible Work Case projection.
//
// Upgrade 2 makes `works` the canonical lifecycle root. This module keeps the old
// Work Case response fields stable while grouping proven action/workflow/receipt
// records through their durable Work foreign keys. Older rows without those links
// retain the original deterministic projection fallback.

import {
  actionLog,
  businessEvents,
  businessOperations,
  businessOperationTargets,
  calls,
  commands,
  conversations,
  decisionReceipts,
  domainActions,
  instructionEvents,
  instructionSessions,
  pendingConfirmations,
  voiceSessions,
  voiceTurns,
  withTenant,
  workflowRuns,
  workflowSteps,
  works,
  workEvents,
  workInputs,
  workPlannerAttempts,
  workEntityLinks,
  workObjectiveLoops,
  workObjectiveSteps,
  workObjectivePlannerAttempts,
  outcomePackRuns,
  autonomyEvaluations,
  outcomeShadowProposals,
} from "@finnor/db";
import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";

const DEFAULT_WORK_CASE_LIMIT = 50;
const MAX_WORK_CASE_LIMIT = 100;
const MAX_CHILD_ROWS_PER_TABLE = 1_000;

export interface WorkCasesPageOptions {
  limit?: number;
  cursor?: string;
}

export interface WorkCasesPage {
  items: WorkCaseProjection[];
  page: {
    limit: number;
    hasMore: boolean;
    nextCursor: string | null;
    rootScope: "canonical_work" | "legacy_instruction";
    childRowsTruncated: boolean;
    childRowLimitPerTable: number;
  };
}

type WorkCasesCursor = {
  scope: WorkCasesPage["page"]["rootScope"];
  activityBucket?: 0 | 1;
  updatedAt?: string;
  id?: string;
};

function pageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WORK_CASE_LIMIT;
  if (!Number.isInteger(value) || value < 1) throw Object.assign(new Error("work-cases limit must be a positive integer"), { status: 400 });
  return Math.min(value, MAX_WORK_CASE_LIMIT);
}

function encodeWorkCasesCursor(cursor: WorkCasesCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeWorkCasesCursor(value: string | undefined): WorkCasesCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<WorkCasesCursor>;
    if (parsed.scope !== "canonical_work" && parsed.scope !== "legacy_instruction") throw new Error();
    const positioned = parsed.updatedAt !== undefined || parsed.id !== undefined || parsed.activityBucket !== undefined;
    if (positioned && (
      typeof parsed.id !== "string"
      || typeof parsed.updatedAt !== "string"
      || Number.isNaN(new Date(parsed.updatedAt).getTime())
      || (parsed.activityBucket !== 0 && parsed.activityBucket !== 1)
    )) throw new Error();
    if (!positioned && parsed.scope !== "legacy_instruction") throw new Error();
    return parsed as WorkCasesCursor;
  } catch {
    throw Object.assign(new Error("Invalid work-cases cursor"), { status: 400 });
  }
}

export const WORK_STATUSES = ["Needs you", "Working", "Waiting", "Partial", "Cancelled", "Completed", "Failed", "Blocked"] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
type DurableWorkRow = typeof works.$inferSelect;

export type DomainActionStatus =
  | "draft"
  | "pending"
  | "approved"
  | "rejected"
  | "executing"
  | "completed"
  | "failed"
  | "needs_human_review"
  | "blocked_integration_unavailable";

export type WorkflowRunStatus = "running" | "completed" | "failed" | "compensating" | "compensated" | "paused" | "cancelled" | "escalated";
export type WorkflowStepStatus = "pending" | "leased" | "waiting_observation" | "completed" | "failed" | "compensating" | "compensated";
export type InstructionPhase =
  | "received"
  | "context_retrieved"
  | "planning"
  | "plan_ready"
  | "clarification_required"
  | "action_created"
  | "action_gated"
  | "dispatched"
  | "executing"
  | "step_progress"
  | "verifying"
  | "verified"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkRootKind = "work" | "instruction" | "plan" | "trace" | "workflow_run" | "action";
export type WorkEntityType =
  | "household"
  | "invoice"
  | "visit"
  | "service_visit"
  | "appointment"
  | "work_order"
  | "call"
  | "conversation"
  | "lead"
  | "quote"
  | "opportunity"
  | "proposal"
  | "document"
  | "equipment"
  | "maintenance_agreement"
  | "technician";
  // Canonical links are additive; historical JSON inference above only emits the
  // original subset, while durable Work attachments may name these real rows too.
export type CanonicalWorkEntityType = WorkEntityType
  | "contact" | "user" | "payment" | "message" | "communication" | "task"
  | "work" | "domain_action" | "workflow_run" | "workflow_step"
  | "business_operation" | "business_operation_target" | "decision_receipt" | "business_event";

export interface WorkRoot {
  kind: WorkRootKind;
  id: string;
}

export interface WorkEntityLink {
  entityType: CanonicalWorkEntityType;
  entityId: string;
  via: string;
}

export interface WorkInstruction {
  id: string;
  text: string;
  source: "typed" | "voice";
  createdAt: string;
  lastPhase: InstructionPhase | null;
}

export interface WorkAction {
  id: string;
  actionType: string;
  status: DomainActionStatus;
  summary: string | null;
  instructionId: string | null;
  planId: string | null;
  dependsOn: string[];
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WorkApproval {
  actionId: string;
  status: "pending" | "approved" | "rejected" | "escalated" | "expired" | "not_required" | "unknown";
  decidedBy: string | null;
  decidedAt: string | null;
  pendingConfirmationId: string | null;
}

export interface WorkStep {
  id: string;
  stepType: string;
  sequence: number;
  status: WorkflowStepStatus;
  attempts: number;
  terminalReason: string | null;
  domainActionId: string | null;
  updatedAt: string;
}

export interface WorkWorkflow {
  id: string;
  commandId: string;
  workflowType: string;
  status: WorkflowRunStatus;
  correlationId: string | null;
  createdAt: string;
  updatedAt: string;
  steps: WorkStep[];
}

export interface WorkReceipt {
  id: string;
  workflowRunId: string | null;
  workflowStepId: string | null;
  domainActionId: string | null;
  objective: string;
  evidence: unknown;
  approval: unknown;
  expectedResult: unknown;
  actualResult: unknown;
  failure: unknown;
  correlationId: string | null;
  createdAt: string;
  finalizedAt: string | null;
}

export interface WorkOperation {
  id: string;
  operationType: string;
  status: string;
  configuration: unknown;
  cohortDefinition: unknown;
  cohortFrozenAt: string;
  targetCount: number;
  counts: { pending: number; running: number; succeeded: number; failed: number; skipped: number; retry: number };
  finalOutcome: unknown;
  failure: unknown;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkBusinessEvent {
  id: string;
  entityType: string;
  entityId: string;
  eventType: string;
  occurredAt: string;
  source: string | null;
}

export interface WorkCall {
  id: string;
  conversationId: string | null;
  direction: "inbound" | "outbound";
  externalId: string | null;
  sourceSystem: string | null;
  startedAt: string | null;
  endedAt: string | null;
  endedReason: string | null;
  householdId: string | null;
  agentKey: "jarvis" | "follow-up" | "service-reminder" | "win-back" | "payment-collector" | null;
}

export interface WorkCaseProjection {
  id: string;
  root: WorkRoot;
  title: string;
  status: WorkStatus;
  createdAt: string;
  updatedAt: string;
  source: { kind: "instruction" | "action" | "workflow" | "voice" | "system"; id: string | null; channel: string | null };
  instruction: WorkInstruction | null;
  actions: WorkAction[];
  approvals: WorkApproval[];
  workflows: WorkWorkflow[];
  receipts: WorkReceipt[];
  operations?: WorkOperation[];
  linkedEntities: WorkEntityLink[];
  businessEvents: WorkBusinessEvent[];
  calls: WorkCall[];
  /** Exact action ids observed on a workflow when it cannot be safely merged into one action/instruction root. */
  relatedActionIds: string[];
  /** Source paths used to make the projection inspectable; not a user-facing raw-data dump. */
  provenance: string[];
  /** Upgrade 2 canonical state. Older clients can keep consuming the unchanged
   * title/status/actions/workflows/receipts fields above. */
  durableWork?: {
    id: string;
    status: DurableWorkRow["status"];
    executionModel: DurableWorkRow["executionModel"];
    sessionId: string | null;
    channel: DurableWorkRow["initialChannel"];
    activeContext: unknown;
    initiatedBy: string | null;
    currentOwnerId: string | null;
    assignedTo: string | null;
    authorityContext: unknown;
    finalOutcome: unknown;
    failure: unknown;
    recovery: unknown;
    handoffs: Array<{
      sequence: number;
      fromEmployeeId: string | null;
      toEmployeeId: string | null;
      actorId: string | null;
      note: string | null;
      authorityRevision: number | null;
      createdAt: string;
    }>;
  };
  inputs?: Array<{ id: string; instructionId: string; channel: string; text: string; createdAt: string }>;
  plannerAttempts?: Array<{ id: string; attempt: number; status: string; result: unknown; failure: unknown; startedAt: string; completedAt: string | null }>;
  objectiveLoop?: {
    id: string;
    objective: string;
    state: "continue" | "awaiting_approval" | "waiting" | "blocked" | "completed" | "failed" | "cancelled";
    revision: number;
    reason: string | null;
    nextStep: string | null;
    nextRunAt: string | null;
    lastObservation: unknown;
    successCondition: unknown;
    successVerification: unknown;
    successVerifiedAt: string | null;
    cancelledAt: string | null;
    budget: { steps: number; maxSteps: number; actions: number; maxActions: number; queries: number; maxQueries: number };
    iterations: Array<{
      id: string;
      stepNumber: number;
      phase: string;
      decisionKind: string | null;
      reason: string | null;
      observation: unknown;
      progressMade: boolean | null;
      outcome: string | null;
      recoveryKind: string | null;
      successVerification: unknown;
      scheduledFor: string | null;
      completedAt: string | null;
      plannerAttempts: Array<{ id: string; attempt: number; status: string; provider: string | null; failure: unknown }>;
    }>;
  };
  outcomePack?: {
    id: string;
    packId: string;
    packVersion: number;
    mode: "shadow" | "approval" | "autopilot";
    status: string;
    certificationFingerprint: string;
    objective: string;
    subjectRefs: unknown;
    blockedReason: string | null;
    finalVerification: unknown;
    latestAutonomyDecision: {
      outcome: string;
      eligible: boolean;
      reasonCodes: string[];
      grantId: string | null;
      evaluatedAt: string;
    } | null;
    shadowProposals: Array<{
      id: string;
      businessEffectId: string;
      semanticHash: string;
      comparisonStatus: string;
      proposedAt: string;
      comparedAt: string | null;
    }>;
  };
}

const ENTITY_KEYS: Record<string, WorkEntityType> = {
  householdId: "household",
  invoiceId: "invoice",
  invoiceIds: "invoice",
  // service_visits is the canonical table and Company Graph entity. `visitId` is
  // the long-standing action payload field, not a second entity kind.
  visitId: "service_visit",
  serviceVisitId: "service_visit",
  appointmentId: "appointment",
  workOrderId: "work_order",
  callId: "call",
  conversationId: "conversation",
  leadId: "lead",
  quoteId: "quote",
  opportunityId: "opportunity",
  proposalId: "proposal",
  documentId: "document",
  equipmentId: "equipment",
  maintenanceAgreementId: "maintenance_agreement",
  technicianId: "technician",
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const WORK_AGENT_KEYS = ["jarvis", "follow-up", "service-reminder", "win-back", "payment-collector"] as const;
type WorkAgentKey = (typeof WORK_AGENT_KEYS)[number];

function callAgentKey(raw: unknown): WorkAgentKey | null {
  const value = stringValue(record(raw)?.agentKey);
  return value && WORK_AGENT_KEYS.includes(value as WorkAgentKey) ? (value as WorkAgentKey) : null;
}

function callDomainActionId(raw: unknown): string | null {
  return stringValue(record(raw)?.domainActionId);
}

function iso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function maxDate(values: Array<Date | null | undefined>, fallback: Date): string {
  const timestamps = values.filter((value): value is Date => value instanceof Date).map((value) => value.getTime());
  return new Date(Math.max(fallback.getTime(), ...(timestamps.length > 0 ? timestamps : [fallback.getTime()]))).toISOString();
}

function minDate(values: Array<Date | null | undefined>, fallback: Date): string {
  const timestamps = values.filter((value): value is Date => value instanceof Date).map((value) => value.getTime());
  return new Date(Math.min(fallback.getTime(), ...(timestamps.length > 0 ? timestamps : [fallback.getTime()]))).toISOString();
}

/** Exhaustive mapping for the current domain_actions status union. */
export function projectDomainActionStatus(status: DomainActionStatus): WorkStatus {
  switch (status) {
    case "failed":
      return "Failed";
    case "blocked_integration_unavailable":
      return "Blocked";
    case "pending":
    case "needs_human_review":
      return "Needs you";
    case "executing":
      return "Working";
    case "approved":
    case "draft":
      return "Waiting";
    case "completed":
      return "Completed";
    case "rejected":
      return "Cancelled";
  }
}

/** Exhaustive mapping for the current workflow_runs status union. */
export function projectWorkflowRunStatus(status: WorkflowRunStatus): WorkStatus {
  switch (status) {
    case "failed":
      return "Failed";
    case "paused":
    case "escalated":
      return "Needs you";
    case "running":
    case "compensating":
      return "Working";
    case "completed":
    case "compensated":
      return "Completed";
    case "cancelled":
      return "Cancelled";
  }
}

/** Exhaustive mapping for the current workflow_steps status union. */
export function projectWorkflowStepStatus(status: WorkflowStepStatus): WorkStatus {
  switch (status) {
    case "failed":
      return "Failed";
    case "leased":
    case "compensating":
      return "Working";
    case "pending":
    case "waiting_observation":
      return "Waiting";
    case "completed":
    case "compensated":
      return "Completed";
  }
}

function projectInstructionPhase(phase: InstructionPhase | null): WorkStatus | null {
  switch (phase) {
    case "clarification_required":
    case "action_gated":
      return "Needs you";
    case "failed":
      return "Failed";
    case "received":
    case "context_retrieved":
    case "planning":
    case "plan_ready":
    case "action_created":
    case "dispatched":
    case "executing":
    case "step_progress":
    case "verifying":
      return "Working";
    case "verified":
    case "completed":
      return "Completed";
    case "cancelled":
      return "Cancelled";
    case null:
      return null;
  }
}

const STATUS_PRIORITY: Record<WorkStatus, number> = {
  Failed: 6,
  Blocked: 5,
  "Needs you": 4,
  Working: 3,
  Waiting: 2,
  Partial: 2,
  Cancelled: 1,
  Completed: 0,
};

export function deriveWorkStatus(statuses: WorkStatus[], instructionPhase: InstructionPhase | null = null): WorkStatus {
  // A terminal durable graph is stronger evidence than a stale pre-execution trace
  // phase. Older approvals stopped their instruction trace at action_gated even
  // after every action/run/step completed and a receipt finalized, which left Work
  // permanently claiming "Needs you". Do not let that observational lag override
  // unanimous terminal execution state.
  if (statuses.length > 0 && statuses.every((status) => status === "Completed")) return "Completed";
  if (statuses.length > 0 && statuses.every((status) => status === "Cancelled")) return "Cancelled";
  if (statuses.length > 0 && statuses.every((status) => status === "Completed" || status === "Cancelled")) return "Partial";
  const candidates = [...statuses, ...(instructionPhase ? [projectInstructionPhase(instructionPhase)] : [])].filter(
    (status): status is WorkStatus => status !== null,
  );
  return candidates.sort((left, right) => STATUS_PRIORITY[right] - STATUS_PRIORITY[left])[0] ?? "Waiting";
}

function addLink(target: Map<string, WorkEntityLink>, entityType: CanonicalWorkEntityType, entityId: string, via: string): void {
  if (!entityId) return;
  const key = `${entityType}:${entityId}`;
  if (!target.has(key)) target.set(key, { entityType, entityId, via });
}

function collectEntityLinks(value: unknown, source: string, target: Map<string, WorkEntityLink>, depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectEntityLinks(item, `${source}[${index}]`, target, depth + 1));
    return;
  }
  const object = record(value);
  if (!object) return;
  for (const [key, child] of Object.entries(object)) {
    const entityType = ENTITY_KEYS[key];
    if (entityType) {
      const values = Array.isArray(child) ? child : [child];
      values.forEach((item) => {
        const id = stringValue(item);
        if (id) addLink(target, entityType, id, `${source}.${key}`);
      });
    }
    collectEntityLinks(child, `${source}.${key}`, target, depth + 1);
  }
}

function latestDecisionLog(logs: Array<{ step: string; input: unknown; output: unknown; timestamp: Date }>, actionId: string): WorkApproval {
  const candidates = logs.filter((log) => ["confirmed", "rejected", "escalated", "policy_ungated_authorized"].includes(log.step)).sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
  const latest = candidates[0];
  if (!latest) return { actionId, status: "unknown", decidedBy: null, decidedAt: null, pendingConfirmationId: null };
  const input = record(latest.input);
  const output = record(latest.output);
  const decidedBy = stringValue(output?.by) ?? stringValue(input?.by) ?? null;
  const status = latest.step === "confirmed" ? "approved" : latest.step === "rejected" ? "rejected" : latest.step === "escalated" ? "escalated" : "not_required";
  return { actionId, status, decidedBy, decidedAt: latest.timestamp.toISOString(), pendingConfirmationId: null };
}

function actionApproval(
  action: { id: string; status: DomainActionStatus },
  confirmations: Array<{ id: string; status: "awaiting" | "confirmed" | "rejected" | "expired"; createdAt: Date; resolvedAt: Date | null }>,
  logs: Array<{ step: string; input: unknown; output: unknown; timestamp: Date }>,
): WorkApproval {
  const confirmation = [...confirmations].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (confirmation) {
    const status = confirmation.status === "awaiting" ? "pending" : confirmation.status === "confirmed" ? "approved" : confirmation.status;
    return {
      actionId: action.id,
      status,
      decidedBy: null,
      decidedAt: iso(confirmation.resolvedAt),
      pendingConfirmationId: confirmation.id,
    };
  }
  if (action.status === "pending") return { actionId: action.id, status: "pending", decidedBy: null, decidedAt: null, pendingConfirmationId: null };
  if (action.status === "needs_human_review") return { actionId: action.id, status: "escalated", decidedBy: null, decidedAt: null, pendingConfirmationId: null };
  const logged = latestDecisionLog(logs, action.id);
  if (logged.status !== "unknown") return logged;
  if (action.status === "rejected") return { actionId: action.id, status: "rejected", decidedBy: null, decidedAt: null, pendingConfirmationId: null };
  return logged;
}

function sourceForCase(instruction: WorkInstruction | null, actions: WorkAction[], calls: WorkCall[], root: WorkRoot): WorkCaseProjection["source"] {
  if (instruction) return { kind: "instruction", id: instruction.id, channel: instruction.source };
  if (calls.length > 0) return { kind: "voice", id: calls[0]!.id, channel: "voice" };
  if (root.kind === "workflow_run") return { kind: "workflow", id: root.id, channel: null };
  if (actions.length > 0) return { kind: "action", id: actions[0]!.id, channel: null };
  return { kind: "system", id: root.id, channel: null };
}

function caseTitle(instruction: WorkInstruction | null, actions: WorkAction[], workflows: WorkWorkflow[], root: WorkRoot): string {
  if (instruction?.text) return instruction.text;
  const summary = actions.find((action) => action.summary)?.summary;
  if (summary) return summary;
  const actionType = actions[0]?.actionType;
  if (actionType) return humanize(actionType);
  const workflowType = workflows[0]?.workflowType;
  if (workflowType) return humanize(workflowType);
  return `${humanize(root.kind)} ${root.id.slice(0, 8)}`;
}

function caseSort(left: WorkCaseProjection, right: WorkCaseProjection): number {
  const statusDelta = STATUS_PRIORITY[right.status] - STATUS_PRIORITY[left.status];
  if (statusDelta !== 0) return statusDelta;
  return right.updatedAt.localeCompare(left.updatedAt);
}

type WorkingCase = {
  root: WorkRoot;
  instructionId: string | null;
  actionIds: Set<string>;
  runIds: Set<string>;
  relatedActionIds: Set<string>;
  links: Map<string, WorkEntityLink>;
  provenance: Set<string>;
};

function ensureCase(cases: Map<string, WorkingCase>, root: WorkRoot): WorkingCase {
  const key = `${root.kind}:${root.id}`;
  const current = cases.get(key);
  if (current) return current;
  const created: WorkingCase = {
    root,
    instructionId: root.kind === "instruction" ? root.id : null,
    actionIds: new Set(),
    runIds: new Set(),
    relatedActionIds: new Set(),
    links: new Map(),
    provenance: new Set(),
  };
  cases.set(key, created);
  return created;
}

function addLinks(target: WorkingCase, links: Map<string, WorkEntityLink>, provenance: Set<string>): void {
  links.forEach((link, key) => target.links.set(key, link));
  provenance.forEach((path) => target.provenance.add(path));
}

function mergeLinkMaps(target: Map<string, WorkEntityLink>, provenance: Set<string>, links: Map<string, WorkEntityLink>): void {
  links.forEach((link, key) => target.set(key, link));
  links.forEach((link) => provenance.add(link.via));
}

function findActionRoot(
  action: { id: string; workId: string | null; instructionId: string | null; planId: string | null },
  instructionIds: Set<string>,
  instructionActionRoots: Map<string, string>,
  instructionWorkRoots: Map<string, string>,
): WorkRoot {
  if (action.workId) return { kind: "work", id: action.workId };
  if (action.instructionId && instructionIds.has(action.instructionId)) {
    const workId = instructionWorkRoots.get(action.instructionId);
    return workId ? { kind: "work", id: workId } : { kind: "instruction", id: action.instructionId };
  }
  const eventInstructionId = instructionActionRoots.get(action.id);
  if (eventInstructionId) {
    const workId = instructionWorkRoots.get(eventInstructionId);
    return workId ? { kind: "work", id: workId } : { kind: "instruction", id: eventInstructionId };
  }
  if (action.planId) return { kind: "plan", id: action.planId };
  return { kind: "action", id: action.id };
}

function toWorkAction(row: typeof domainActions.$inferSelect): WorkAction {
  return {
    id: row.id,
    actionType: row.actionType,
    status: row.status,
    summary: row.summary,
    instructionId: row.instructionId,
    planId: row.planId,
    dependsOn: row.dependsOn,
    payload: record(row.payload) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: (row.executionStartedAt ?? row.createdAt).toISOString(),
  };
}

function toWorkStep(row: typeof workflowSteps.$inferSelect): WorkStep {
  return {
    id: row.id,
    stepType: row.stepType,
    sequence: row.sequence,
    status: row.status,
    attempts: row.attempts,
    terminalReason: row.terminalReason,
    domainActionId: row.domainActionId,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toWorkReceipt(row: typeof decisionReceipts.$inferSelect): WorkReceipt {
  return {
    id: row.id,
    workflowRunId: row.workflowRunId,
    workflowStepId: row.workflowStepId,
    domainActionId: row.domainActionId,
    objective: row.objective,
    evidence: row.evidence,
    approval: row.approval,
    expectedResult: row.expectedResult,
    actualResult: row.actualResult,
    failure: row.failure,
    correlationId: row.correlationId,
    createdAt: row.createdAt.toISOString(),
    finalizedAt: iso(row.finalizedAt),
  };
}

/**
 * Returns one bounded page of tenant Work Cases. Canonical Work is the root; a
 * bounded instruction-root fallback remains only for tenants that have no Work rows
 * from before the durable Work migration. Every child query is restricted to the
 * selected roots and capped independently.
 */
export async function workCasesPage(tenantId: string, options: WorkCasesPageOptions = {}): Promise<WorkCasesPage> {
  return withTenant(tenantId, async (db) => {
    const limit = pageLimit(options.limit);
    let childRowsTruncated = false;
    const bounded = <T>(rows: T[]): T[] => {
      if (rows.length > MAX_CHILD_ROWS_PER_TABLE) childRowsTruncated = true;
      return rows.slice(0, MAX_CHILD_ROWS_PER_TABLE);
    };
    const cursor = decodeWorkCasesCursor(options.cursor);
    const [canonicalWork] = await db.select({ id: works.id }).from(works).where(eq(works.tenantId, tenantId)).limit(1);
    const rootScope: WorkCasesPage["page"]["rootScope"] = cursor?.scope ?? (canonicalWork ? "canonical_work" : "legacy_instruction");
    const cursorDate = cursor?.updatedAt ? new Date(cursor.updatedAt) : null;
    const activityBucket = sql<number>`CASE WHEN ${works.status} IN ('completed','failed','cancelled') THEN 1 ELSE 0 END`;
    // JavaScript Date serializes milliseconds while PostgreSQL timestamps retain
    // microseconds. Use the same millisecond key for filtering and ordering so a
    // cursor round-trip cannot skip roots created within one statement.
    const workUpdatedAt = sql<Date>`date_trunc('milliseconds', ${works.updatedAt})`;
    const legacyUpdatedAt = sql<Date>`date_trunc('milliseconds', ${instructionSessions.updatedAt})`;
    const workCursor = cursorDate
      ? or(
          gt(activityBucket, cursor!.activityBucket!),
          and(eq(activityBucket, cursor!.activityBucket!), or(
            lt(workUpdatedAt, cursorDate),
            and(eq(workUpdatedAt, cursorDate), lt(works.id, cursor!.id!)),
          )),
        )
      : undefined;
    const legacyCursor = cursorDate
      ? or(lt(legacyUpdatedAt, cursorDate), and(eq(legacyUpdatedAt, cursorDate), lt(instructionSessions.id, cursor!.id!)))
      : undefined;

    const fetchedWorkRows = rootScope === "canonical_work"
      ? await db.select().from(works).where(and(eq(works.tenantId, tenantId), workCursor)).orderBy(asc(activityBucket), desc(workUpdatedAt), desc(works.id)).limit(limit + 1)
      : [];
    const fetchedLegacyInstructions = rootScope === "legacy_instruction"
      ? await db.select().from(instructionSessions).where(and(eq(instructionSessions.tenantId, tenantId), isNull(instructionSessions.workId), legacyCursor)).orderBy(desc(legacyUpdatedAt), desc(instructionSessions.id)).limit(limit + 1)
      : [];
    const scopeHasMore = (rootScope === "canonical_work" ? fetchedWorkRows : fetchedLegacyInstructions).length > limit;
    const workRows = fetchedWorkRows.slice(0, limit);
    const legacyInstructionRoots = fetchedLegacyInstructions.slice(0, limit);
    const lastRoot = rootScope === "canonical_work" ? workRows.at(-1) : legacyInstructionRoots.at(-1);
    const [legacyRemaining] = rootScope === "canonical_work" && !scopeHasMore
      ? await db.select({ id: instructionSessions.id }).from(instructionSessions).where(and(
          eq(instructionSessions.tenantId, tenantId),
          isNull(instructionSessions.workId),
        )).limit(1)
      : [];
    const hasMore = scopeHasMore || Boolean(legacyRemaining);
    const nextCursor = scopeHasMore && lastRoot
      ? encodeWorkCasesCursor({
          scope: rootScope,
          activityBucket: rootScope === "canonical_work" && "status" in lastRoot && ["completed", "failed", "cancelled"].includes(lastRoot.status) ? 1 : 0,
          updatedAt: lastRoot.updatedAt.toISOString(),
          id: lastRoot.id,
        })
      : legacyRemaining
        ? encodeWorkCasesCursor({ scope: "legacy_instruction" })
      : null;
    const workIds = workRows.map((row) => row.id);

    const workEventRows = workIds.length ? bounded(await db.select().from(workEvents).where(and(eq(workEvents.tenantId, tenantId), inArray(workEvents.workId, workIds))).orderBy(asc(workEvents.seq)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const workInputRows = workIds.length ? bounded(await db.select().from(workInputs).where(and(eq(workInputs.tenantId, tenantId), inArray(workInputs.workId, workIds))).orderBy(asc(workInputs.createdAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const plannerAttemptRows = workIds.length ? bounded(await db.select().from(workPlannerAttempts).where(and(eq(workPlannerAttempts.tenantId, tenantId), inArray(workPlannerAttempts.workId, workIds))).orderBy(asc(workPlannerAttempts.attempt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const canonicalWorkLinks = workIds.length ? bounded(await db.select().from(workEntityLinks).where(and(eq(workEntityLinks.tenantId, tenantId), inArray(workEntityLinks.workId, workIds))).orderBy(asc(workEntityLinks.createdAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const objectiveLoopRows = workIds.length ? bounded(await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, tenantId), inArray(workObjectiveLoops.workId, workIds))).orderBy(desc(workObjectiveLoops.updatedAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const objectiveLoopIds = objectiveLoopRows.map((row) => row.id);
    const objectiveStepRows = objectiveLoopIds.length ? bounded(await db.select().from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, tenantId), inArray(workObjectiveSteps.objectiveLoopId, objectiveLoopIds))).orderBy(asc(workObjectiveSteps.stepNumber)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const objectiveStepIds = objectiveStepRows.map((row) => row.id);
    const objectiveAttemptRows = objectiveStepIds.length ? bounded(await db.select().from(workObjectivePlannerAttempts).where(and(eq(workObjectivePlannerAttempts.tenantId, tenantId), inArray(workObjectivePlannerAttempts.objectiveStepId, objectiveStepIds))).orderBy(asc(workObjectivePlannerAttempts.startedAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const outcomePackRunRows = workIds.length ? bounded(await db.select().from(outcomePackRuns).where(and(eq(outcomePackRuns.tenantId, tenantId), inArray(outcomePackRuns.workId, workIds))).orderBy(desc(outcomePackRuns.updatedAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const outcomePackIds = outcomePackRunRows.map((row) => row.id);
    const autonomyEvaluationRows = outcomePackIds.length ? bounded(await db.select().from(autonomyEvaluations).where(and(eq(autonomyEvaluations.tenantId, tenantId), inArray(autonomyEvaluations.outcomePackRunId, outcomePackIds))).orderBy(desc(autonomyEvaluations.evaluatedAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const shadowProposalRows = outcomePackIds.length ? bounded(await db.select().from(outcomeShadowProposals).where(and(eq(outcomeShadowProposals.tenantId, tenantId), inArray(outcomeShadowProposals.outcomePackRunId, outcomePackIds))).orderBy(desc(outcomeShadowProposals.proposedAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const instructionRows = rootScope === "legacy_instruction"
      ? legacyInstructionRoots
      : workIds.length ? bounded(await db.select().from(instructionSessions).where(and(eq(instructionSessions.tenantId, tenantId), inArray(instructionSessions.workId, workIds))).orderBy(desc(instructionSessions.updatedAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const instructionIds = instructionRows.map((row) => row.id);
    const instructionEventRows = instructionIds.length ? bounded(await db.select().from(instructionEvents).where(and(eq(instructionEvents.tenantId, tenantId), inArray(instructionEvents.instructionId, instructionIds))).orderBy(asc(instructionEvents.seq)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const actionPredicates = [
      ...(workIds.length ? [inArray(domainActions.workId, workIds)] : []),
      ...(instructionIds.length ? [inArray(domainActions.instructionId, instructionIds)] : []),
    ];
    const actionRows = actionPredicates.length ? bounded(await db.select().from(domainActions).where(and(eq(domainActions.tenantId, tenantId), or(...actionPredicates))).orderBy(desc(domainActions.createdAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const actionIds = actionRows.map((row) => row.id);
    const confirmationRows = actionIds.length ? bounded(await db.select().from(pendingConfirmations).where(and(eq(pendingConfirmations.tenantId, tenantId), inArray(pendingConfirmations.domainActionId, actionIds))).orderBy(desc(pendingConfirmations.createdAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const operationPredicates = [
      ...(workIds.length ? [inArray(businessOperations.workId, workIds)] : []),
      ...(actionIds.length ? [inArray(businessOperations.domainActionId, actionIds)] : []),
    ];
    const operationRows = operationPredicates.length ? bounded(await db.select().from(businessOperations).where(and(eq(businessOperations.tenantId, tenantId), or(...operationPredicates))).orderBy(desc(businessOperations.updatedAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const operationIds = operationRows.map((row) => row.id);
    const operationTargetRows = operationIds.length ? bounded(await db.select().from(businessOperationTargets).where(and(eq(businessOperationTargets.tenantId, tenantId), inArray(businessOperationTargets.operationId, operationIds))).orderBy(asc(businessOperationTargets.ordinal)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const logRows = actionIds.length ? bounded(await db.select().from(actionLog).where(and(eq(actionLog.tenantId, tenantId), inArray(actionLog.domainActionId, actionIds))).orderBy(desc(actionLog.timestamp)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];

    const directRunRows = workIds.length ? bounded(await db.select().from(workflowRuns).where(and(eq(workflowRuns.tenantId, tenantId), inArray(workflowRuns.workId, workIds))).orderBy(desc(workflowRuns.updatedAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const actionStepRows = actionIds.length ? bounded(await db.select().from(workflowSteps).where(and(eq(workflowSteps.tenantId, tenantId), inArray(workflowSteps.domainActionId, actionIds))).orderBy(asc(workflowSteps.sequence)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const runIds = [...new Set([...directRunRows.map((row) => row.id), ...actionStepRows.map((row) => row.workflowRunId)])];
    const runRows = runIds.length ? bounded(await db.select().from(workflowRuns).where(and(eq(workflowRuns.tenantId, tenantId), inArray(workflowRuns.id, runIds))).orderBy(desc(workflowRuns.updatedAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const stepRows = runIds.length ? bounded(await db.select().from(workflowSteps).where(and(eq(workflowSteps.tenantId, tenantId), inArray(workflowSteps.workflowRunId, runIds))).orderBy(asc(workflowSteps.sequence)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const stepIds = stepRows.map((row) => row.id);
    const commandIds = runRows.map((row) => row.commandId);
    const commandRows = commandIds.length ? bounded(await db.select().from(commands).where(and(eq(commands.tenantId, tenantId), inArray(commands.id, commandIds))).orderBy(desc(commands.updatedAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const receiptPredicates = [
      ...(workIds.length ? [inArray(decisionReceipts.workId, workIds)] : []),
      ...(actionIds.length ? [inArray(decisionReceipts.domainActionId, actionIds)] : []),
      ...(runIds.length ? [inArray(decisionReceipts.workflowRunId, runIds)] : []),
      ...(stepIds.length ? [inArray(decisionReceipts.workflowStepId, stepIds)] : []),
      ...(operationIds.length ? [inArray(decisionReceipts.operationId, operationIds)] : []),
    ];
    const receiptRows = receiptPredicates.length ? bounded(await db.select().from(decisionReceipts).where(and(eq(decisionReceipts.tenantId, tenantId), or(...receiptPredicates))).orderBy(desc(decisionReceipts.createdAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];

    const voiceTurnActionPredicate = actionIds.length
      ? sql`${voiceTurns.resolvedActionIds} ?| ARRAY[${sql.join(actionIds.map((id) => sql`${id}`), sql`, `)}]::text[]`
      : undefined;
    const voiceTurnRows = voiceTurnActionPredicate ? bounded(await db.select().from(voiceTurns).where(and(eq(voiceTurns.tenantId, tenantId), voiceTurnActionPredicate)).orderBy(asc(voiceTurns.sequence)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const voiceSessionIds = [...new Set([...confirmationRows.map((row) => row.voiceSessionId), ...voiceTurnRows.map((row) => row.voiceSessionId)])];
    const voiceSessionRows = voiceSessionIds.length ? bounded(await db.select().from(voiceSessions).where(and(eq(voiceSessions.tenantId, tenantId), inArray(voiceSessions.id, voiceSessionIds))).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const callIds = [...new Set([
      ...canonicalWorkLinks.filter((link) => link.entityType === "call").map((link) => link.entityId),
      ...actionRows.map((action) => stringValue(record(action.payload)?.callId)).filter((id): id is string => Boolean(id)),
    ])];
    const callExternalIds = voiceSessionRows.map((row) => row.callExternalId);
    const callPredicates = [
      ...(callIds.length ? [inArray(calls.id, callIds)] : []),
      ...(callExternalIds.length ? [inArray(calls.externalId, callExternalIds)] : []),
      ...(actionIds.length ? [inArray(sql<string>`${calls.raw}->>'domainActionId'`, actionIds)] : []),
    ];
    const callRows = callPredicates.length ? bounded(await db.select().from(calls).where(and(eq(calls.tenantId, tenantId), or(...callPredicates))).orderBy(desc(calls.createdAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];
    const conversationIds = callRows.map((row) => row.conversationId).filter((id): id is string => Boolean(id));
    const conversationRows = conversationIds.length ? bounded(await db.select({ id: conversations.id, householdId: conversations.householdId }).from(conversations).where(and(eq(conversations.tenantId, tenantId), inArray(conversations.id, conversationIds))).limit(MAX_CHILD_ROWS_PER_TABLE + 1)) : [];

    const instructionActionRoots = new Map<string, string>();
    const lastPhaseByInstruction = new Map<string, InstructionPhase>();
    for (const event of instructionEventRows) {
      lastPhaseByInstruction.set(event.instructionId, event.phase);
      const actionId = stringValue(record(event.payload)?.actionId);
      if (actionId) instructionActionRoots.set(actionId, event.instructionId);
    }

    const actionLinks = new Map<string, Map<string, WorkEntityLink>>();
    const actionProvenance = new Map<string, Set<string>>();
    const linksForAction = (actionId: string): { links: Map<string, WorkEntityLink>; provenance: Set<string> } => {
      const links = actionLinks.get(actionId) ?? new Map<string, WorkEntityLink>();
      const provenance = actionProvenance.get(actionId) ?? new Set<string>();
      actionLinks.set(actionId, links);
      actionProvenance.set(actionId, provenance);
      return { links, provenance };
    };
    for (const action of actionRows) {
      const target = linksForAction(action.id);
      collectEntityLinks(action.payload, `domain_actions(${action.id}).payload`, target.links);
      target.links.forEach((link) => target.provenance.add(link.via));
    }
    for (const target of operationTargetRows) {
      const operation = operationRows.find((row) => row.id === target.operationId);
      if (!operation) continue;
      const actionTarget = linksForAction(operation.domainActionId);
      addLink(actionTarget.links, "household", target.targetId, `business_operation_targets(${target.id}).target_id`);
      actionTarget.provenance.add(`business_operation_targets(${target.id}).target_id`);
    }
    for (const log of logRows) {
      const target = linksForAction(log.domainActionId);
      collectEntityLinks(log.input, `action_log(${log.id}).input`, target.links);
      collectEntityLinks(log.output, `action_log(${log.id}).output`, target.links);
      target.links.forEach((link) => target.provenance.add(link.via));
    }

    const stepsByRun = new Map<string, typeof stepRows>();
    const stepLinks = new Map<string, Map<string, WorkEntityLink>>();
    for (const step of stepRows) {
      const list = stepsByRun.get(step.workflowRunId) ?? [];
      list.push(step);
      stepsByRun.set(step.workflowRunId, list);
      const links = new Map<string, WorkEntityLink>();
      const provenance = new Set<string>();
      collectEntityLinks(step.payload, `workflow_steps(${step.id}).payload`, links);
      collectEntityLinks(step.evidence, `workflow_steps(${step.id}).evidence`, links);
      links.forEach((link) => provenance.add(link.via));
      stepLinks.set(step.id, links);
      if (step.domainActionId) {
        const actionTarget = linksForAction(step.domainActionId);
        mergeLinkMaps(actionTarget.links, actionTarget.provenance, links);
      }
    }

    const runLinks = new Map<string, Map<string, WorkEntityLink>>();
    for (const receipt of receiptRows) {
      const links = new Map<string, WorkEntityLink>();
      collectEntityLinks(receipt.proposedAction, `decision_receipts(${receipt.id}).proposed_action`, links);
      collectEntityLinks(receipt.expectedResult, `decision_receipts(${receipt.id}).expected_result`, links);
      collectEntityLinks(receipt.actualResult, `decision_receipts(${receipt.id}).actual_result`, links);
      collectEntityLinks(receipt.failure, `decision_receipts(${receipt.id}).failure`, links);
      if (receipt.domainActionId) {
        const target = linksForAction(receipt.domainActionId);
        mergeLinkMaps(target.links, target.provenance, links);
      } else if (receipt.workflowStepId) {
        const step = stepRows.find((row) => row.id === receipt.workflowStepId);
        const stepTarget = step ? stepLinks.get(step.id) : undefined;
        if (stepTarget) mergeLinkMaps(stepTarget, new Set(), links);
      } else if (receipt.workflowRunId) {
        const target = runLinks.get(receipt.workflowRunId) ?? new Map<string, WorkEntityLink>();
        mergeLinkMaps(target, new Set(), links);
        runLinks.set(receipt.workflowRunId, target);
      }
    }

    const commandById = new Map(commandRows.map((command) => [command.id, command]));
    const runById = new Map(runRows.map((run) => [run.id, run]));
    const actionById = new Map(actionRows.map((action) => [action.id, action]));
    const instructionById = new Map(instructionRows.map((instruction) => [instruction.id, instruction]));
    const instructionWorkRoots = new Map(instructionRows.flatMap((instruction) => instruction.workId ? [[instruction.id, instruction.workId] as const] : []));

    const cases = new Map<string, WorkingCase>();
    for (const work of workRows) ensureCase(cases, { kind: "work", id: work.id });
    for (const link of canonicalWorkLinks) {
      const target = ensureCase(cases, { kind: "work", id: link.workId });
      target.links.set(`${link.entityType}:${link.entityId}`, { entityType: link.entityType as CanonicalWorkEntityType, entityId: link.entityId, via: `work_entity_links(${link.id}).entity_id` });
      target.provenance.add(`work_entity_links(${link.id}).entity_id`);
    }
    for (const instruction of instructionRows) {
      const target = ensureCase(cases, instruction.workId ? { kind: "work", id: instruction.workId } : { kind: "instruction", id: instruction.id });
      target.instructionId ??= instruction.id;
    }
    const rootByAction = new Map<string, WorkRoot>();
    for (const action of actionRows) {
      const root = findActionRoot(action, new Set(instructionRows.map((instruction) => instruction.id)), instructionActionRoots, instructionWorkRoots);
      rootByAction.set(action.id, root);
      const target = ensureCase(cases, root);
      target.actionIds.add(action.id);
      addLinks(target, actionLinks.get(action.id) ?? new Map(), actionProvenance.get(action.id) ?? new Set());
    }

    const traceRoots = new Map<string, WorkRoot>();
    for (const run of runRows) {
      const command = commandById.get(run.commandId);
      const steps = stepsByRun.get(run.id) ?? [];
      const actionIds = [...new Set(steps.map((step) => step.domainActionId).filter((id): id is string => Boolean(id)))];
      const actionRoots = [...new Set(actionIds.map((id) => rootByAction.get(id)).filter((root): root is WorkRoot => Boolean(root)).map((root) => `${root.kind}:${root.id}`))];
      let root: WorkRoot;
      if (run.workId) {
        root = { kind: "work", id: run.workId };
      } else if (actionRoots.length === 1) {
        root = rootByAction.get(actionIds[0]!) ?? { kind: "workflow_run", id: run.id };
      } else if (actionRoots.length > 1) {
        root = { kind: "workflow_run", id: run.id };
      } else {
        if (command?.correlationId) {
          root = traceRoots.get(command.correlationId) ?? { kind: "trace", id: command.correlationId };
          traceRoots.set(command.correlationId, root);
        } else {
          root = { kind: "workflow_run", id: run.id };
        }
      }
      const target = ensureCase(cases, root);
      target.runIds.add(run.id);
      actionIds.forEach((actionId) => {
        if (`${rootByAction.get(actionId)?.kind}:${rootByAction.get(actionId)?.id}` === `${root.kind}:${root.id}`) target.actionIds.add(actionId);
        else target.relatedActionIds.add(actionId);
      });
      for (const step of steps) addLinks(target, stepLinks.get(step.id) ?? new Map(), new Set([...stepLinks.get(step.id)?.values() ?? []].map((link) => link.via)));
      if (command) {
        const commandLinks = new Map<string, WorkEntityLink>();
        collectEntityLinks(command.payload, `commands(${command.id}).payload`, commandLinks);
        addLinks(target, commandLinks, new Set([...commandLinks.values()].map((link) => link.via)));
      }
      addLinks(target, runLinks.get(run.id) ?? new Map(), new Set([...runLinks.get(run.id)?.values() ?? []].map((link) => link.via)));
    }

    const caseByAction = (actionId: string): WorkingCase | null => {
      const root = rootByAction.get(actionId);
      return root ? cases.get(`${root.kind}:${root.id}`) ?? null : null;
    };
    const caseByRun = (runId: string): WorkingCase | null => {
      for (const target of cases.values()) if (target.runIds.has(runId)) return target;
      return null;
    };
    const caseByStep = (stepId: string): WorkingCase | null => {
      const step = stepRows.find((row) => row.id === stepId);
      return step ? caseByRun(step.workflowRunId) : null;
    };

    const receiptByCase = new Map<WorkingCase, typeof receiptRows>();
    for (const receipt of receiptRows) {
      const target = receipt.domainActionId ? caseByAction(receipt.domainActionId) : receipt.workflowRunId ? caseByRun(receipt.workflowRunId) : receipt.workflowStepId ? caseByStep(receipt.workflowStepId) : null;
      if (!target) continue;
      const list = receiptByCase.get(target) ?? [];
      list.push(receipt);
      receiptByCase.set(target, list);
    }

    const voiceSessionById = new Map(voiceSessionRows.map((session) => [session.id, session]));
    const actionCallRefs = new Map<string, Set<string>>();
    for (const turn of voiceTurnRows) {
      const actionIds = Array.isArray(turn.resolvedActionIds) ? turn.resolvedActionIds.filter((id): id is string => typeof id === "string") : [];
      for (const actionId of actionIds) {
        const refs = actionCallRefs.get(actionId) ?? new Set<string>();
        const session = voiceSessionById.get(turn.voiceSessionId);
        if (session) refs.add(session.callExternalId);
        actionCallRefs.set(actionId, refs);
      }
    }
    for (const confirmation of confirmationRows) {
      const session = voiceSessionById.get(confirmation.voiceSessionId);
      if (!session) continue;
      const refs = actionCallRefs.get(confirmation.domainActionId) ?? new Set<string>();
      refs.add(session.callExternalId);
      actionCallRefs.set(confirmation.domainActionId, refs);
    }

    const callByReference = new Map<string, typeof callRows[number]>();
    const conversationById = new Map(conversationRows.map((conversation) => [conversation.id, conversation]));
    for (const call of callRows) {
      callByReference.set(call.id, call);
      if (call.externalId) callByReference.set(call.externalId, call);
    }

    const addCallEdge = (target: WorkingCase, call: typeof callRows[number], via: string): void => {
      const callLinks = new Map<string, WorkEntityLink>();
      addLink(callLinks, "call", call.id, via);
      const conversation = call.conversationId ? conversationById.get(call.conversationId) : undefined;
      if (conversation?.householdId) {
        addLink(callLinks, "household", conversation.householdId, `calls(${call.id}).conversation_id -> conversations(${conversation.id}).household_id`);
      }
      mergeLinkMaps(target.links, target.provenance, callLinks);
    };

    // Outbound call writers carry the executor-stamped action id in a whitelisted
    // metadata envelope. This is the only call→Work join for those calls; no
    // customer, invoice, time, or text similarity is considered.
    for (const call of callRows) {
      const actionId = callDomainActionId(call.raw);
      const target = actionId && actionById.has(actionId) ? caseByAction(actionId) : null;
      if (target) addCallEdge(target, call, `calls(${call.id}).raw.domainActionId`);
    }

    for (const [actionId, refs] of actionCallRefs) {
      const target = caseByAction(actionId);
      if (!target) continue;
      for (const ref of refs) {
        const call = callByReference.get(ref);
        if (call) addCallEdge(target, call, `voice_turns(${actionId}).resolved_action_ids`);
      }
    }

    const allLinks = [...cases.values()].flatMap((target) => [...target.links.values()]);
    const uniqueEventLinks = [...new Map(allLinks.map((link) => [`${link.entityType}:${link.entityId}`, link])).values()];
    if (uniqueEventLinks.length > MAX_CHILD_ROWS_PER_TABLE) childRowsTruncated = true;
    const eventPredicates = uniqueEventLinks.slice(0, MAX_CHILD_ROWS_PER_TABLE).map((link) => and(eq(businessEvents.entityType, link.entityType), eq(businessEvents.entityId, link.entityId)));
    const eventRows = eventPredicates.length > 0
      ? bounded(await db.select().from(businessEvents).where(and(eq(businessEvents.tenantId, tenantId), or(...eventPredicates))).orderBy(desc(businessEvents.occurredAt)).limit(MAX_CHILD_ROWS_PER_TABLE + 1))
      : [];
    const eventsByEntity = new Map<string, typeof eventRows>();
    for (const event of eventRows) {
      const key = `${event.entityType}:${event.entityId}`;
      const list = eventsByEntity.get(key) ?? [];
      list.push(event);
      eventsByEntity.set(key, list);
    }

    // Canonical attachments win provenance when a historical JSON/operation edge
    // names the same row. The entity is de-duplicated, but the durable validated
    // Work link is the relationship contract runtime consumers should see.
    for (const link of canonicalWorkLinks) {
      const target = cases.get(`work:${link.workId}`);
      if (!target) continue;
      target.links.set(`${link.entityType}:${link.entityId}`, { entityType: link.entityType as CanonicalWorkEntityType, entityId: link.entityId, via: `work_entity_links(${link.id}).entity_id` });
      target.provenance.add(`work_entity_links(${link.id}).entity_id`);
    }

    const output: WorkCaseProjection[] = [];
    const workById = new Map(workRows.map((work) => [work.id, work]));
    for (const target of cases.values()) {
      const durableWork = target.root.kind === "work" ? workById.get(target.root.id) : undefined;
      const objectiveLoop = durableWork ? objectiveLoopRows.find((loop) => loop.workId === durableWork.id) : undefined;
      const outcomePack = durableWork ? outcomePackRunRows.find((run) => run.workId === durableWork.id) : undefined;
      const instructionRow = target.instructionId ? instructionById.get(target.instructionId) : undefined;
      const actions = [...target.actionIds].map((id) => actionById.get(id)).filter((action): action is typeof actionRows[number] => Boolean(action)).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map(toWorkAction);
      const workflows = [...target.runIds].map((id) => {
        const run = runById.get(id);
        if (!run) return null;
        const command = commandById.get(run.commandId);
        return {
          id: run.id,
          commandId: run.commandId,
          workflowType: run.workflowType,
          status: run.status,
          correlationId: command?.correlationId ?? null,
          createdAt: run.createdAt.toISOString(),
          updatedAt: run.updatedAt.toISOString(),
          steps: (stepsByRun.get(run.id) ?? []).sort((a, b) => a.sequence - b.sequence).map(toWorkStep),
        } satisfies WorkWorkflow;
      }).filter((workflow): workflow is WorkWorkflow => Boolean(workflow));
      const instruction: WorkInstruction | null = instructionRow
        ? { id: instructionRow.id, text: instructionRow.instructionText, source: instructionRow.source, createdAt: instructionRow.createdAt.toISOString(), lastPhase: lastPhaseByInstruction.get(instructionRow.id) ?? null }
        : null;
      const approvals = actions.map((action) => actionApproval(
        { id: action.id, status: action.status },
        confirmationRows.filter((confirmation) => confirmation.domainActionId === action.id).map((confirmation) => ({ id: confirmation.id, status: confirmation.status, createdAt: confirmation.createdAt, resolvedAt: confirmation.resolvedAt })),
        logRows.filter((log) => log.domainActionId === action.id).map((log) => ({ step: log.step, input: log.input, output: log.output, timestamp: log.timestamp })),
      ));
      const receipts = [...(receiptByCase.get(target) ?? [])].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map(toWorkReceipt);
      const operations = operationRows
        .filter((operation) => operation.workId === durableWork?.id || target.actionIds.has(operation.domainActionId))
        .map((operation) => ({
          id: operation.id,
          operationType: operation.operationType,
          status: operation.status,
          configuration: operation.configuration,
          cohortDefinition: operation.cohortDefinition,
          cohortFrozenAt: operation.cohortFrozenAt.toISOString(),
          targetCount: operation.targetCount,
          counts: {
            pending: operation.pendingCount,
            running: operation.runningCount,
            succeeded: operation.succeededCount,
            failed: operation.failedCount,
            skipped: operation.skippedCount,
            retry: operation.retryCount,
          },
          finalOutcome: operation.finalOutcome,
          failure: operation.failure,
          approvedBy: operation.approvedBy,
          approvedAt: iso(operation.approvedAt),
          createdAt: operation.createdAt.toISOString(),
          updatedAt: operation.updatedAt.toISOString(),
        }));
      const linkedEntities = [...target.links.values()].sort((a, b) => a.entityType.localeCompare(b.entityType) || a.entityId.localeCompare(b.entityId));
      const businessEventList = linkedEntities.flatMap((link) => eventsByEntity.get(`${link.entityType}:${link.entityId}`) ?? []).map((event) => ({ id: event.id, entityType: event.entityType, entityId: event.entityId, eventType: event.eventType, occurredAt: event.occurredAt.toISOString(), source: event.source }));
      const callsForCase = callRows
        .filter((call) => linkedEntities.some((link) => link.entityType === "call" && link.entityId === call.id))
        .map((call) => ({
          id: call.id,
          conversationId: call.conversationId,
          direction: call.direction,
          externalId: call.externalId,
          sourceSystem: call.sourceSystem,
          startedAt: iso(call.startedAt),
          endedAt: iso(call.endedAt),
          endedReason: call.endedReason,
          householdId: call.conversationId ? conversationById.get(call.conversationId)?.householdId ?? null : null,
          agentKey: callAgentKey(call.raw),
        }));
      const statusCandidates = [
        ...actions.map((action) => projectDomainActionStatus(action.status)),
        ...workflows.flatMap((workflow) => [projectWorkflowRunStatus(workflow.status), ...workflow.steps.map((step) => projectWorkflowStepStatus(step.status))]),
      ];
      const lastPhase = instruction?.lastPhase ?? null;
      const status = durableWork
        ? durableWork.status === "completed"
          ? operations.some((operation) => operation.status === "completed_with_failures")
            || (statusCandidates.includes("Completed") && statusCandidates.includes("Cancelled"))
            ? "Partial"
            : "Completed"
          : durableWork.status === "cancelled"
            ? "Cancelled"
          : durableWork.status === "failed"
            ? "Failed"
            : durableWork.status === "blocked"
              ? "Blocked"
              : durableWork.status === "waiting"
                ? "Waiting"
            : durableWork.status === "awaiting_approval" || durableWork.status === "recovery"
              ? "Needs you"
              : "Working"
        : deriveWorkStatus(statusCandidates, lastPhase);
      const fallbackDate = instructionRow?.createdAt
        ?? actionRows.find((action) => target.actionIds.has(action.id))?.createdAt
        ?? runRows.find((run) => target.runIds.has(run.id))?.createdAt
        ?? new Date(0);
      const sourceCalls = callsForCase;
      output.push({
        id: `${target.root.kind}:${target.root.id}`,
        root: target.root,
        title: caseTitle(instruction, actions, workflows, target.root),
        status,
        createdAt: minDate([
          instructionRow?.createdAt,
          ...[...target.actionIds].map((id) => actionById.get(id)?.createdAt),
          ...[...target.runIds].map((id) => runById.get(id)?.createdAt),
        ], fallbackDate),
        updatedAt: maxDate([
          instructionRow?.updatedAt,
          ...[...target.actionIds].map((id) => actionById.get(id)?.createdAt),
          ...[...target.runIds].map((id) => runById.get(id)?.updatedAt),
          ...receipts.map((receipt) => new Date(receipt.finalizedAt ?? receipt.createdAt)),
          ...operations.map((operation) => new Date(operation.updatedAt)),
          objectiveLoop?.updatedAt,
          ...objectiveStepRows.filter((step) => step.objectiveLoopId === objectiveLoop?.id).map((step) => step.completedAt ?? step.startedAt),
        ], fallbackDate),
        source: sourceForCase(instruction, actions, sourceCalls, target.root),
        instruction,
        actions,
        approvals,
        workflows,
        receipts,
        operations,
        linkedEntities,
        businessEvents: businessEventList.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)),
        calls: sourceCalls,
        relatedActionIds: [...target.relatedActionIds].sort(),
        provenance: [...target.provenance].sort(),
        ...(durableWork ? {
          durableWork: {
            id: durableWork.id,
            status: durableWork.status,
            executionModel: durableWork.executionModel,
            sessionId: durableWork.sessionId,
            channel: durableWork.initialChannel,
            activeContext: durableWork.activeContext,
            initiatedBy: durableWork.createdBy,
            currentOwnerId: durableWork.currentOwnerId,
            assignedTo: durableWork.assignedTo,
            authorityContext: durableWork.authorityContext,
            finalOutcome: durableWork.finalOutcome,
            failure: durableWork.failure,
            recovery: durableWork.recovery,
            handoffs: workEventRows.filter((event) => event.workId === durableWork.id && event.eventType === "employee_handoff").map((event) => {
              const payload = record(event.payload) ?? {};
              return {
                sequence: event.seq,
                fromEmployeeId: stringValue(payload.fromEmployeeId),
                toEmployeeId: stringValue(payload.toEmployeeId),
                actorId: stringValue(payload.actorId),
                note: stringValue(payload.note),
                authorityRevision: typeof payload.authorityRevision === "number" ? payload.authorityRevision : null,
                createdAt: event.createdAt.toISOString(),
              };
            }),
          },
          inputs: workInputRows.filter((input) => input.workId === durableWork.id).map((input) => ({
            id: input.id,
            instructionId: input.instructionId,
            channel: input.channel,
            text: input.instructionText,
            createdAt: input.createdAt.toISOString(),
          })),
          plannerAttempts: plannerAttemptRows.filter((attempt) => attempt.workId === durableWork.id).map((attempt) => ({
            id: attempt.id,
            attempt: attempt.attempt,
            status: attempt.status,
            result: attempt.plannerResult,
            failure: attempt.failure,
            startedAt: attempt.startedAt.toISOString(),
            completedAt: iso(attempt.completedAt),
          })),
          ...(objectiveLoop ? {
            objectiveLoop: {
              id: objectiveLoop.id,
              objective: objectiveLoop.objective,
              state: objectiveLoop.state,
              revision: objectiveLoop.revision,
              reason: objectiveLoop.reason,
              nextStep: objectiveLoop.nextStep,
              nextRunAt: iso(objectiveLoop.nextRunAt),
              lastObservation: objectiveLoop.lastObservation,
              successCondition: objectiveLoop.successCondition,
              successVerification: objectiveLoop.successVerification,
              successVerifiedAt: iso(objectiveLoop.successVerifiedAt),
              cancelledAt: iso(objectiveLoop.cancelledAt),
              budget: {
                steps: objectiveLoop.stepCount,
                maxSteps: objectiveLoop.maxSteps,
                actions: objectiveLoop.actionCount,
                maxActions: objectiveLoop.maxActions,
                queries: objectiveLoop.queryCount,
                maxQueries: objectiveLoop.maxQueries,
              },
              iterations: objectiveStepRows.filter((step) => step.objectiveLoopId === objectiveLoop.id).map((step) => ({
                id: step.id,
                stepNumber: step.stepNumber,
                phase: step.phase,
                decisionKind: step.decisionKind,
                reason: step.decisionReason,
                observation: step.observation,
                progressMade: step.progressMade,
                outcome: step.iterationOutcome,
                recoveryKind: step.recoveryKind,
                successVerification: step.successVerification,
                scheduledFor: iso(step.scheduledFor),
                completedAt: iso(step.completedAt),
                plannerAttempts: objectiveAttemptRows.filter((attempt) => attempt.objectiveStepId === step.id).map((attempt) => ({ id: attempt.id, attempt: attempt.attempt, status: attempt.status, provider: attempt.provider, failure: attempt.failure })),
              })),
            },
          } : {}),
          ...(outcomePack ? {
            outcomePack: {
              id: outcomePack.id,
              packId: outcomePack.packId,
              packVersion: outcomePack.packVersion,
              mode: outcomePack.mode,
              status: outcomePack.status,
              certificationFingerprint: outcomePack.certificationFingerprint,
              objective: outcomePack.objective,
              subjectRefs: outcomePack.subjectRefs,
              blockedReason: outcomePack.blockedReason,
              finalVerification: outcomePack.finalVerification,
              latestAutonomyDecision: (() => {
                const evaluation = autonomyEvaluationRows.find((row) => row.outcomePackRunId === outcomePack.id);
                return evaluation ? {
                  outcome: evaluation.outcome,
                  eligible: evaluation.eligible,
                  reasonCodes: evaluation.reasonCodes,
                  grantId: evaluation.grantId,
                  evaluatedAt: evaluation.evaluatedAt.toISOString(),
                } : null;
              })(),
              shadowProposals: shadowProposalRows.filter((row) => row.outcomePackRunId === outcomePack.id).map((row) => ({
                id: row.id,
                businessEffectId: row.businessEffectId,
                semanticHash: row.semanticHash,
                comparisonStatus: row.comparisonStatus,
                proposedAt: row.proposedAt.toISOString(),
                comparedAt: iso(row.comparedAt),
              })),
            },
          } : {}),
        } : {}),
      });
    }
    return {
      items: output.sort(caseSort),
      page: {
        limit,
        hasMore,
        nextCursor,
        rootScope,
        childRowsTruncated,
        childRowLimitPerTable: MAX_CHILD_ROWS_PER_TABLE,
      },
    };
  });
}

export async function workCases(tenantId: string): Promise<WorkCaseProjection[]> {
  return (await workCasesPage(tenantId)).items;
}

export const workCasesReadModel = workCases;

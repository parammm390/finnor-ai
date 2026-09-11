// Upgrade 9: the smallest governed objective loop that sits inside Durable Work.
//
// This is deliberately a controller over proven primitives, not another agent
// framework. Every iteration performs one canonical inspection, asks for exactly one
// bounded decision, routes reads through the Operational Query Plane, routes writes
// through the existing typed action/executor boundary, observes the durable result,
// and ends in one explicit state before another job may be scheduled.

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import type { DomainAction, ExecutionResult, MemorySnapshot, ObjectiveSuccessCondition, ObjectiveSuccessVerification, OperatingInteractionContext, OperationalQueryRequest, OutcomePackStartBinding, Role, TenantContext } from "@finnor/shared-types";
import {
  activeWorkPlanRevision,
  beginWorkPlannerAttempt as beginCanonicalWorkPlannerAttempt,
  completeWorkPlanRevision,
  finishWorkPlannerAttempt as finishCanonicalWorkPlannerAttempt,
  domainActions,
  domainPolicyRevisions,
  authorityApprovalRequests,
  authorityApprovalRequestSteps,
  businessEffects,
  actionLog,
  canonicalRefsFromContext,
  computerArtifacts,
  computerRuns,
  createWorkEventWaitTx,
  delegations,
  acknowledgementRequests,
  jobs,
  receiveWork,
  tenantSettings,
  transitionWork,
  users,
  withTenant,
  workAggregate,
  workObjectiveLoops,
  workObjectivePlannerAttempts,
  workObjectiveSteps,
  workEventWaits,
  workEvents,
  workInputs,
  workPlanRevisions,
  workforceAssignments,
  works,
  pendingConfirmations,
  outcomePackRuns,
  tenantOutcomePackSettings,
  type Db,
  resolveTenantVertical,
} from "@finnor/db";
import {
  buildConstraintSet,
  buildGoalSpec,
  buildPlanningWorldSnapshot,
  compileAndSelectPlans,
  DEFAULT_PLAN_BUDGETS,
  planNodeSemanticHash,
  sha256 as planningHash,
  type CandidateCompilationFacts,
  type CandidatePlan,
  type CandidatePlanNode,
  type CompletionProof,
  type ConstraintSet,
  type GoalSpec,
  type PlanGraph,
  type PlanNode,
  type PlanningWorldSnapshot,
} from "@finnor/planning";
import { attachWorkToDealGraph, resolvePrivateEquityDealReference } from "@finnor/private-equity";
import { canExerciseAuthority, employeeAuthoritySnapshot, evaluateAuthority } from "@finnor/authority";
import { listAvailableIdentityAccess } from "@finnor/security";
import type { LLMChannel, LLMProvider } from "./llm";
import { resolveProviderForPurpose } from "./llm";
import type { PluginRegistry } from "./plugin-registry";
import { plannerActionTypesForVertical, planningCapabilitiesForVertical } from "./plugin-registry";
import { LLMPlanner, type Planner, type PlanningResult } from "./planner";
import { PlanCompilationError, deterministicPlanActionId, selectPlanRevision } from "./plan-runtime";
import { resolvePlanProgress, type PlanReplanCause } from "./plan-progress";
import { planningHealthForAction, requiredPlanningHealthCapability } from "./planning-health";
import { queryAuthorityRequest } from "./authority-runtime";
import { groundEntitiesWithDb } from "./compiler";
import { validateOperationalQueryRequest } from "./fast-read-lane";
import { executeTenantOperationalQuery } from "./operational-query-runtime";
import { ingestIntegrationEvent, markObjectiveWakeConsumed, objectiveWakeContext, recoverDueWorkEventWaits } from "./event-waits";
import { resolveOperatingInteractionContext } from "./interaction-context";
import {
  defaultObjectiveSuccessCondition,
  evaluateObjectiveSuccessCondition,
  inspectCurrentObjectiveSuccessState,
  ObjectiveCompletionEvidenceSchema,
  parseObjectiveCompletionEvidence,
  parseObjectiveSuccessCondition,
  privateEquityObjectiveSuccessCondition,
} from "./objective-success";
import {
  claimWorkforceAssignment,
  completePriorWaitingAssignments,
  enqueueAssignmentRecovery,
  isWorkforceAssignmentCurrent,
  recordLearningObservationForAssignment,
  requestWorkforceAssignment,
} from "./workforce-runtime";

export const OBJECTIVE_ITERATION_OUTCOMES = ["continue", "awaiting_approval", "waiting", "blocked", "completed", "failed", "cancelled"] as const;
export type ObjectiveIterationOutcome = (typeof OBJECTIVE_ITERATION_OUTCOMES)[number];

const PE_OBJECTIVE_ENTITY_TYPES = new Set(["pe_deal", "pe_request", "pe_finding", "pe_deal_risk", "pe_closing_condition", "pe_closing_item"]);

function privateEquityRefsFromContext(value: unknown): Array<{ entityType: string; entityId: string }> {
  if (Array.isArray(value)) return value.flatMap(privateEquityRefsFromContext);
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  const own = typeof row.entityType === "string" && PE_OBJECTIVE_ENTITY_TYPES.has(row.entityType)
    && typeof row.entityId === "string" && /^[0-9a-f-]{36}$/i.test(row.entityId)
    ? [{ entityType: row.entityType, entityId: row.entityId }]
    : [];
  const nested = Object.values(row).flatMap(privateEquityRefsFromContext);
  return [...new Map([...own, ...nested].map((ref) => [`${ref.entityType}:${ref.entityId}`, ref])).values()];
}

const OptionalDecisionText = z.preprocess((value) => value === null ? undefined : value, z.string().min(1).max(2000).optional());
const OptionalDecisionRecord = z.preprocess((value) => value === null ? undefined : value, z.record(z.unknown()).optional());
const CanonicalWaitRefSchema = z.object({ type: z.string().min(1).max(120), id: z.string().uuid() }).strict();
const WaitForSchema = z.object({
  eventType: z.string().min(1).max(200),
  subject: CanonicalWaitRefSchema.optional(),
  resource: CanonicalWaitRefSchema.optional(),
  delegationId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  acknowledgementRequestId: z.string().uuid().optional(),
  computerRunId: z.string().uuid().optional(),
  domainActionId: z.string().uuid().optional(),
  provider: z.string().min(1).max(120).optional(),
  providerConversationId: z.string().min(1).max(500).optional(),
  providerMessageId: z.string().min(1).max(500).optional(),
  applicationRef: z.string().min(1).max(500).optional(),
  correlationId: z.string().min(1).max(500).optional(),
}).strict();
const RecoveryModeSchema = z.enum(["retry", "replan", "recover", "compensate", "escalate"]);

const DecisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("query"), request: z.record(z.unknown()), reason: z.string().min(1).max(4000), nextStep: OptionalDecisionText, recoveryMode: RecoveryModeSchema.optional() }),
  z.object({ kind: z.literal("action"), actionType: z.string().min(1).max(200), payload: z.record(z.unknown()), reason: z.string().min(1).max(4000), nextStep: OptionalDecisionText, recoveryMode: RecoveryModeSchema.optional() }),
  z.object({
    kind: z.literal("wait"),
    waitFor: WaitForSchema.optional(),
    deadlineAt: z.string().datetime().optional(),
    // Backward-compatible timer-only shape. It is normalized into a durable wait,
    // not scheduled as a blind Objective iteration.
    resumeAt: z.string().datetime().optional(),
    condition: z.string().min(1).max(2000).optional(),
    reason: z.string().min(1).max(4000),
    recoveryMode: RecoveryModeSchema.optional(),
  }),
  z.object({ kind: z.literal("complete"), outcome: z.record(z.unknown()), evidence: ObjectiveCompletionEvidenceSchema.optional(), reason: z.string().min(1).max(4000) }),
  z.object({ kind: z.literal("block"), reason: z.string().min(1).max(4000), recovery: OptionalDecisionText }),
  z.object({ kind: z.literal("fail"), reason: z.string().min(1).max(4000), failure: OptionalDecisionRecord }),
]);

export type ObjectiveDecision = z.infer<typeof DecisionSchema>;

export interface ObjectiveInspection extends Record<string, unknown> {
  inspectedAt: string;
  work: Record<string, unknown>;
  objective: Record<string, unknown>;
  companyGraph: Record<string, unknown>;
  businessState: unknown;
  companyContext?: unknown;
  executionAccess: Record<string, unknown>;
  computerRuns: unknown[];
  delegations: unknown[];
  acknowledgementRequests: unknown[];
  eventWake: unknown;
  eventWaits: unknown[];
  integrationEvents: unknown[];
  actions: unknown[];
  businessEffects: unknown[];
  operations: unknown[];
  receipts: unknown[];
  priorIterations: unknown[];
}

export interface ObjectiveDecisionPlanner {
  decide(input: {
    objective: string;
    inspection: ObjectiveInspection;
    allowedActionTypes: string[];
    actionPayloadSpec: string;
    remaining: { steps: number; actions: number; queries: number };
    tenantId: string;
    workId: string;
    channel: LLMChannel;
    signal?: AbortSignal;
    deadlineAt?: number;
  }): Promise<ObjectiveDecision>;
  providerName?: string;
}

export interface ObjectiveActionExecutor {
  draftObjectiveAction(params: {
    tenantId: string;
    actionType: string;
    payload: Record<string, unknown>;
    workId: string;
    instructionId: string | null;
    initiatedBy: string | null;
    authorityContext: Record<string, unknown>;
    objectiveStepId: string;
    actionId: string;
    plannerAttemptId: string;
    planRevisionId: string;
    planNodeId: string;
  }): Promise<{ action: DomainAction; result: ExecutionResult }>;
}

export interface ObjectiveBudgets {
  maxSteps?: number;
  maxActions?: number;
  maxQueries?: number;
  maxPlannerFailures?: number;
  maxConsecutiveNoProgress?: number;
  deadlineAt?: Date;
}

export interface StartObjectiveOptions extends ObjectiveBudgets {
  channel?: "voice" | "text" | "console";
  sessionId?: string;
  instructionId?: string;
  workId?: string;
  workInputId?: string;
  idempotencyKey?: string;
  activeContext?: OperatingInteractionContext | Record<string, unknown>;
  successCondition?: ObjectiveSuccessCondition;
  /** Phase 5 binding only. The existing Objective controller remains the runtime. */
  outcomePack?: OutcomePackStartBinding;
}

export interface StartObjectiveResult {
  workId: string;
  workInputId: string;
  instructionId: string;
  objectiveLoopId: string;
  state: ObjectiveIterationOutcome;
  duplicate: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function intakeAuthorityContext(ctx: TenantContext): Record<string, unknown> {
  if (!ctx.employeeId && ctx.userId.startsWith("system:")) return { principal: ctx.userId, kind: "service" };
  return {
    employeeId: ctx.employeeId ?? null,
    revision: ctx.authorityRevision ?? null,
    roles: ctx.authorityRoles ?? [ctx.role],
    principal: ctx.userId,
  };
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).filter((key) => row[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function bounded(value: unknown, maxBytes = 48_000): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized && Buffer.byteLength(serialized, "utf8") <= maxBytes) return value;
    return { bounded: true, bytes: serialized ? Buffer.byteLength(serialized, "utf8") : null, hash: hash(value) };
  } catch {
    return { bounded: true, unserializable: true };
  }
}

function semanticQueryResult(result: unknown): unknown {
  if (!isRecord(result)) return result;
  const value = isRecord(result.data) ? result.data : result;
  // Query receipts contain a fresh asOf timestamp and execution id on every read.
  // Those prove that a read happened, but they are not business progress. Keep them
  // in the persisted observation while comparing only the canonical result payload.
  const { asOf: _asOf, execution: _execution, meta: _meta, page: _page, source: _source, version: _version, ...businessValue } = value;
  return businessValue;
}

function failureShape(error: unknown): Record<string, unknown> {
  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : "Error";
  return {
    message,
    name,
    timeout: name === "AbortError" || /\b(?:timeout|timed out|deadline|aborted?)\b/i.test(message),
    at: new Date().toISOString(),
  };
}

function role(value: unknown): Role {
  void value;
  return "owner";
}

function channel(value: string): LLMChannel {
  return value === "voice" || value === "text" || value === "console" ? value : "background";
}

/** Providers occasionally wrap JSON mode output in a sentence even when asked for
 * a bare object. Extract one balanced object, then let the strict decision schema
 * remain the authority. A second JSON value is rejected so commentary can never
 * smuggle an additional autonomous step into the iteration. */
export function parseObjectiveModelJson(raw: string): unknown {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (originalError) {
    const start = cleaned.indexOf("{");
    if (start < 0) throw originalError;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < cleaned.length; index += 1) {
      const character = cleaned[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') inString = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) { end = index; break; }
      }
    }
    if (end < 0) throw originalError;
    const suffix = cleaned.slice(end + 1).replace(/^\s*```/, "").trim();
    if (/^[{[]/.test(suffix)) throw new Error("Objective decision provider returned more than one JSON value");
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

export class LLMObjectiveDecisionPlanner implements ObjectiveDecisionPlanner {
  private provider: LLMProvider | undefined;

  constructor(provider?: LLMProvider) {
    this.provider = provider;
  }

  get providerName(): string | undefined {
    return this.provider?.selectedProviderName ?? this.provider?.name;
  }

  async decide(input: Parameters<ObjectiveDecisionPlanner["decide"]>[0]): Promise<ObjectiveDecision> {
    this.provider ??= resolveProviderForPurpose("planning", input.channel);
    const raw = await this.provider.complete({
      system: [
        "You are JARVIS's governed objective-step decision maker.",
        "Choose exactly ONE bounded next step from the current canonical business inspection.",
        "Never emit a multi-step plan. Never assume an action worked; durable results will be inspected on the next iteration.",
        "Prefer a deterministic query when a missing canonical fact is needed. Use a typed action only for a real mutation.",
        "Execution priority is canonical query/data, native FINNOR action, provider API/MCP, computer_task browser/CDP, visual fallback, then manual fallback. computer_task is only for an already-authorized business task that has no reliable native/API route. Never choose it for work an existing query or action can do, never put browser primitives or a model-selected URL in its payload, and block for ambiguity before computer execution.",
        "For computer_task, use an exact active application/authProfileRef pair visible in canonicalInspection.executionAccess.identityAccess. Never invent or infer an auth profile. computer_task must be READ_ONLY unless the objective explicitly requests one exact mutation.",
        "A complete decision is only a REQUEST to verify completion. It never completes Work by itself. Cite exact current evidence allowed by canonicalInspection.objective.successCondition; action/workflow/provider success alone is not business-outcome evidence.",
        "Complete only when the persisted business success condition appears true in current canonical state, including when a previously expected action is no longer necessary. Include evidence using exact query/effect/event/delegation/computer ids or a typed canonical query assertion.",
        "Wait only for a future business condition. Use waitFor with exact canonical refs and optionally deadlineAt for 'event X OR deadline Y'. Never correlate by similar names or message text. A timer-only wait may use deadlineAt without waitFor. Block when safe progress requires a human fact/integration. Fail only for a terminal objective failure.",
        `Allowed action types: ${input.allowedActionTypes.join(", ")}`,
        `Typed operational query intents: work_list, attention_queue, agent_activity, workforce_status, company_context, party_lookup, party_context, team_roster, pe_world_state, deal_context, deal_workstreams, open_requests, open_findings, open_deal_risks, critical_dependencies, closing_readiness.`,
        "Deal-scoped operational queries require the exact dealId from canonical state. Never infer a deal, company, fund, party, request, finding, risk, condition, or workstream from a similar label.",
        "Action payload schemas follow. Field names and required fields are strict:",
        input.actionPayloadSpec,
        `Exact governed computer access visible for this decision: ${JSON.stringify(input.inspection.executionAccess)}`,
        'For governed external diligence evidence, computer_task requires all six typed fields: application (copy the exact configured application), authProfileRef (copy the exact active profile ref), task, target {kind:"diligence_record",identifier:<exact reference>}, mode:"READ_ONLY", and a non-empty successCriteria array. Never invent a URL, account, profile, or reference.',
        'Return one JSON object. query/action/wait may include recoveryMode: retry|replan|recover|compensate|escalate. Shapes: {"kind":"query","request":{"intent":"..."},"reason":"...","nextStep":"..."}; {"kind":"action","actionType":"...","payload":{},"reason":"...","nextStep":"..."}; {"kind":"wait","waitFor":{"eventType":"delegation.acknowledged","delegationId":"exact UUID","subject":{"type":"employee","id":"exact UUID"}},"deadlineAt":"optional ISO","condition":"short label","reason":"..."}; {"kind":"complete","outcome":{},"evidence":[{"kind":"canonical_query","request":{"intent":"..."},"assertion":{"path":["rows"],"operator":"array_contains","expected":{}}}],"reason":"..."}; {"kind":"block","reason":"...","recovery":"..."}; {"kind":"fail","reason":"...","failure":{}}.',
      ].join("\n"),
      user: JSON.stringify({ objective: input.objective, remainingBudget: input.remaining, canonicalInspection: input.inspection }),
      json: true,
      tenantId: input.tenantId,
      traceId: input.workId,
      purpose: "planning",
      channel: input.channel,
      signal: input.signal,
      deadlineAt: input.deadlineAt,
    });
    const parsed = DecisionSchema.safeParse(parseObjectiveModelJson(raw));
    if (!parsed.success) throw new Error(`Objective decision failed schema validation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
    return parsed.data;
  }
}

type SchedulableObjectiveLoop = { id: string; tenantId: string; workId: string; stepCount: number; revision: number };

export function objectiveIterationJobKey(loopId: string, revision: number, stepNumber: number, recoveryAfterJobId?: string): string {
  const canonical = `objective:${loopId}:revision:${revision}:step:${stepNumber}`;
  return recoveryAfterJobId ? `${canonical}:recovery-after:${recoveryAfterJobId}` : canonical;
}

async function scheduleIterationTx(
  db: Db,
  loop: SchedulableObjectiveLoop,
  runAt: Date,
  correlationId?: string,
): Promise<boolean> {
  const [unfinished] = await db.select({ stepNumber: workObjectiveSteps.stepNumber }).from(workObjectiveSteps).where(and(
    eq(workObjectiveSteps.tenantId, loop.tenantId),
    eq(workObjectiveSteps.objectiveLoopId, loop.id),
    sql`${workObjectiveSteps.completedAt} IS NULL`,
  )).orderBy(desc(workObjectiveSteps.stepNumber)).limit(1);
  const nextStep = unfinished?.stepNumber ?? loop.stepCount + 1;
  const scope = and(
    eq(jobs.type, "run_objective_iteration"),
    sql`${jobs.payload}->>'objectiveLoopId'=${loop.id}`,
    sql`${jobs.payload}->>'expectedRevision'=${String(loop.revision)}`,
    sql`${jobs.payload}->>'expectedStepNumber'=${String(nextStep)}`,
  );
  const [actionable] = await db.select({ id: jobs.id }).from(jobs).where(and(
    scope,
    inArray(jobs.status, ["queued", "running"]),
  )).limit(1);
  if (actionable) return false;

  const [latestTerminal] = await db.select({ id: jobs.id }).from(jobs).where(scope)
    .orderBy(sql`${jobs.completedAt} DESC NULLS LAST`, sql`${jobs.startedAt} DESC NULLS LAST`, desc(jobs.id))
    .limit(1);
  const payload = {
    tenantId: loop.tenantId,
    workId: loop.workId,
    objectiveLoopId: loop.id,
    expectedRevision: loop.revision,
    expectedStepNumber: nextStep,
    ...(correlationId ? { _correlationId: correlationId } : {}),
  };
  const [inserted] = await db.insert(jobs).values({
    type: "run_objective_iteration",
    payload,
    runAt,
    idempotencyKey: objectiveIterationJobKey(loop.id, loop.revision, nextStep, latestTerminal?.id),
    lane: "interactive",
    priority: 100,
  }).onConflictDoNothing({ target: jobs.idempotencyKey }).returning({ id: jobs.id });
  return Boolean(inserted);
}

async function scheduleIteration(loop: SchedulableObjectiveLoop, runAt: Date, correlationId?: string): Promise<void> {
  await withTenant(loop.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workObjectiveLoops} WHERE ${workObjectiveLoops.tenantId}=${loop.tenantId} AND ${workObjectiveLoops.id}=${loop.id} FOR UPDATE`);
    const [current] = await db.select().from(workObjectiveLoops).where(and(
      eq(workObjectiveLoops.tenantId, loop.tenantId),
      eq(workObjectiveLoops.id, loop.id),
    )).limit(1);
    if (!current || ["blocked", "completed", "failed", "cancelled"].includes(current.state)) return;
    await scheduleIterationTx(db, current, runAt, correlationId);
  });
}

export async function ensureObjectiveIterationDelivery(tenantId: string, objectiveLoopId: string, correlationId?: string): Promise<boolean> {
  return withTenant(tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workObjectiveLoops} WHERE ${workObjectiveLoops.tenantId}=${tenantId} AND ${workObjectiveLoops.id}=${objectiveLoopId} FOR UPDATE`);
    const [loop] = await db.select().from(workObjectiveLoops).where(and(
      eq(workObjectiveLoops.tenantId, tenantId),
      eq(workObjectiveLoops.id, objectiveLoopId),
    )).limit(1);
    if (!loop || loop.state !== "continue") return false;
    return scheduleIterationTx(db, loop, new Date(), correlationId);
  });
}

export async function startWorkObjective(objective: string, ctx: TenantContext, options: StartObjectiveOptions = {}): Promise<StartObjectiveResult> {
  const preReceived = options.workId && options.workInputId && options.instructionId
    ? await withTenant(ctx.tenantId, async (db) => {
        const [row] = await db.select({ input: workInputs, work: works }).from(workInputs)
          .innerJoin(works, and(eq(works.tenantId, ctx.tenantId), eq(works.id, workInputs.workId)))
          .where(and(
            eq(workInputs.tenantId, ctx.tenantId),
            eq(workInputs.id, options.workInputId!),
            eq(workInputs.workId, options.workId!),
            eq(workInputs.instructionId, options.instructionId!),
          )).limit(1);
        if (!row || row.input.instructionText !== objective) throw new Error("The pre-received Work input does not match this objective");
        return { workId: row.work.id, workInputId: row.input.id, instructionId: row.input.instructionId, created: false, duplicate: false, status: row.work.status, finalOutcome: row.work.finalOutcome };
      })
    : null;
  const input = preReceived ?? await receiveWork({
      tenantId: ctx.tenantId,
      instruction: objective,
      channel: options.channel ?? "text",
      sessionId: options.sessionId,
      instructionId: options.instructionId,
      workId: options.workId,
      userId: ctx.employeeId ?? ctx.userId,
      idempotencyKey: options.idempotencyKey,
      // The caller may still be holding an unverified interaction context.
      // Resolve it after the durable Work/Input claim before persisting it.
      activeContext: undefined,
      authorityContext: intakeAuthorityContext(ctx),
    });
  options = {
    ...options,
    activeContext: await resolveOperatingInteractionContext({
      tenantId: ctx.tenantId,
      context: options.activeContext,
      channel: options.channel ?? "text",
      workId: input.workId,
    }),
  };
  const vertical = await resolveTenantVertical(ctx.tenantId);
  const activeRefs = privateEquityRefsFromContext(options.activeContext);
  const activeDeal = activeRefs.find((ref) => ref.entityType === "pe_deal")?.entityId;
  const resolution = vertical.verticalKey === "private_equity" && !activeDeal
    ? await resolvePrivateEquityDealReference(ctx.tenantId, objective, { workId: input.workId, userId: ctx.userId })
    : null;
  const dealId = activeDeal ?? (resolution?.status === "resolved" ? resolution.dealId : null);
  if (vertical.verticalKey === "private_equity" && dealId) {
    await attachWorkToDealGraph({ auth: ctx }, {
      dealId,
      workId: input.workId,
      entities: [{ entityType: "pe_deal", entityId: dealId, relationship: "about" }],
    });
  }
  let successCondition: ObjectiveSuccessCondition;
  if (options.successCondition) {
    successCondition = parseObjectiveSuccessCondition(options.successCondition);
  } else {
    const subject = activeRefs.find((ref) => ["pe_request", "pe_finding", "pe_deal_risk", "pe_closing_condition", "pe_closing_item"].includes(ref.entityType));
    successCondition = vertical.verticalKey === "private_equity" && dealId
      ? privateEquityObjectiveSuccessCondition({
          objective,
          dealId,
          ...(subject ? { subject: subject as { entityType: "pe_request" | "pe_finding" | "pe_deal_risk" | "pe_closing_condition" | "pe_closing_item"; entityId: string } } : {}),
        })
      : defaultObjectiveSuccessCondition(objective);
  }
  const loopClaim = await withTenant(ctx.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${works} WHERE ${works.id}=${input.workId} AND ${works.tenantId}=${ctx.tenantId} FOR UPDATE`);
    const [currentWork] = await db.select().from(works).where(and(eq(works.tenantId, ctx.tenantId), eq(works.id, input.workId))).limit(1);
    const [latestInput] = await db.select({ id: workInputs.id }).from(workInputs)
      .where(and(eq(workInputs.tenantId, ctx.tenantId), eq(workInputs.workId, input.workId)))
      .orderBy(desc(workInputs.createdAt), desc(workInputs.id))
      .limit(1);
    if (!currentWork || latestInput?.id !== input.workInputId) throw new Error("Objective input is no longer the active Work input");
    if (currentWork.status === "cancelled" || currentWork.status === "completed") {
      const [latestEvent] = await db.select({ eventType: workEvents.eventType, payload: workEvents.payload }).from(workEvents)
        .where(and(eq(workEvents.tenantId, ctx.tenantId), eq(workEvents.workId, input.workId)))
        .orderBy(desc(workEvents.seq))
        .limit(1);
      const payload = isRecord(latestEvent?.payload) ? latestEvent.payload : {};
      const explicitlyContinued = (latestEvent?.eventType === "input_received" || latestEvent?.eventType === "recovery_input_received")
        && payload.workInputId === input.workInputId;
      if (!explicitlyContinued) throw new Error(`Terminal Work cannot start an objective from ${currentWork.status} without a newer explicit input`);
    }
    if (currentWork.status === "failed") throw new Error("Failed Work must enter explicit recovery before starting an objective");
    const [existing] = await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, ctx.tenantId), eq(workObjectiveLoops.workId, input.workId))).limit(1);
    if (existing) {
      if (existing.objective !== objective && !input.duplicate) throw new Error("Work already owns a different objective; use redirect explicitly");
      if (canonicalJson(existing.successCondition) !== canonicalJson(successCondition) && !input.duplicate) throw new Error("Work already owns a different objective success condition; use redirect explicitly");
      if (options.outcomePack) {
        const [existingPack] = await db.select().from(outcomePackRuns).where(and(eq(outcomePackRuns.tenantId, ctx.tenantId), eq(outcomePackRuns.workId, input.workId))).limit(1);
        if (!existingPack || existingPack.packId !== options.outcomePack.packId || existingPack.packVersion !== options.outcomePack.packVersion
          || existingPack.mode !== options.outcomePack.mode || existingPack.certificationFingerprint !== options.outcomePack.certificationFingerprint) {
          throw new Error("Work is already bound to a different Outcome Pack contract");
        }
      }
      if (existing.state === "continue") {
        // A retry re-enters handleInstructionResult through the ordinary
        // understanding/routing trace before it reaches this idempotent branch.
        // Restore the durable objective invariant instead of leaving Work in
        // understanding after a successful objective has already been claimed.
        if (currentWork.status !== "executing" && !["completed", "cancelled", "failed", "recovery"].includes(currentWork.status)) {
          const [latestEvent] = await db.select({ maxSeq: sql<number>`coalesce(max(${workEvents.seq}), 0)::int` })
            .from(workEvents).where(eq(workEvents.workId, input.workId));
          await db.update(works).set({ status: "executing", executionModel: "objective", updatedAt: new Date() })
            .where(and(eq(works.tenantId, ctx.tenantId), eq(works.id, input.workId)));
          await db.insert(workEvents).values({
            tenantId: ctx.tenantId,
            workId: input.workId,
            seq: (latestEvent?.maxSeq ?? 0) + 1,
            eventType: "objective_replayed",
            fromStatus: currentWork.status,
            toStatus: "executing",
            payload: { objectiveLoopId: existing.id, duplicate: true },
          });
        }
        await scheduleIterationTx(db, existing, new Date(), ctx.correlationId);
      }
      return { loop: existing, created: false } as const;
    }
    if (options.outcomePack) {
      const [setting] = await db.select().from(tenantOutcomePackSettings).where(and(
        eq(tenantOutcomePackSettings.tenantId, ctx.tenantId),
        eq(tenantOutcomePackSettings.packId, options.outcomePack.packId),
      )).limit(1);
      if (setting && !setting.enabled) throw new Error(`Outcome Pack ${options.outcomePack.packId} is disabled: ${setting.reason ?? "operator control"}`);
    }
    const [created] = await db.insert(workObjectiveLoops).values({
      tenantId: ctx.tenantId,
      workId: input.workId,
      objective,
      successCondition,
      state: "continue",
      createdBy: ctx.employeeId ?? (/^[0-9a-f-]{36}$/i.test(ctx.userId) ? ctx.userId : null),
      initialChannel: options.channel ?? "text",
      maxSteps: options.maxSteps ?? 12,
      maxActions: options.maxActions ?? 5,
      maxQueries: options.maxQueries ?? 12,
      maxPlannerFailures: options.maxPlannerFailures ?? 3,
      maxConsecutiveNoProgress: options.maxConsecutiveNoProgress ?? 3,
      deadlineAt: options.deadlineAt ?? new Date(Date.now() + 7 * 86_400_000),
      reason: "Objective accepted; canonical inspection is next.",
      nextStep: "Inspect current canonical business state.",
    }).returning();
    if (!created) throw new Error("Unable to persist Work objective loop");
    if (options.outcomePack) {
      await db.insert(outcomePackRuns).values({
        tenantId: ctx.tenantId,
        workId: input.workId,
        objectiveLoopId: created.id,
        packId: options.outcomePack.packId,
        packVersion: options.outcomePack.packVersion,
        mode: options.outcomePack.mode,
        certificationFingerprint: options.outcomePack.certificationFingerprint,
        objective: options.outcomePack.objective,
        input: options.outcomePack.input,
        subjectRefs: options.outcomePack.subjectRefs,
        successCondition: options.outcomePack.successCondition,
      });
    }
    const [latest] = await db.select({ maxSeq: sql<number>`coalesce(max(${workEvents.seq}), 0)::int` })
      .from(workEvents).where(eq(workEvents.workId, input.workId));
    await db.update(works).set({
      status: "executing",
      updatedAt: new Date(),
      activeContext: options.activeContext
        ? { ...(isRecord(currentWork.activeContext) ? currentWork.activeContext : {}), ...(options.activeContext as Record<string, unknown>) }
        : currentWork.activeContext,
      executionModel: "objective",
    }).where(and(eq(works.tenantId, ctx.tenantId), eq(works.id, input.workId)));
    await db.insert(workEvents).values({
      tenantId: ctx.tenantId,
      workId: input.workId,
      seq: (latest?.maxSeq ?? 0) + 1,
      eventType: "objective_accepted",
      fromStatus: currentWork.status,
      toStatus: "executing",
      payload: {
        objectiveLoopId: created.id,
        objective,
        successCondition: created.successCondition,
        budgets: { maxSteps: created.maxSteps, maxActions: created.maxActions, maxQueries: created.maxQueries },
      },
    });
    await scheduleIterationTx(db, created, new Date(), ctx.correlationId);
    return { loop: created, created: true } as const;
  });
  const loop = loopClaim.loop;
  return { workId: input.workId, workInputId: input.workInputId, instructionId: input.instructionId, objectiveLoopId: loop.id, state: loop.state, duplicate: input.duplicate };
}

async function workerContext(tenantId: string, workId: string): Promise<{ ctx: TenantContext; work: typeof works.$inferSelect }> {
  return withTenant(tenantId, async (db) => {
    const [work] = await db.select().from(works).where(and(eq(works.tenantId, tenantId), eq(works.id, workId))).limit(1);
    if (!work) throw new Error("Objective Work not found");
    const responsibleEmployeeId = work.currentOwnerId ?? work.createdBy;
    const [employee] = responsibleEmployeeId ? await db.select({ id: users.id, role: users.role }).from(users).where(and(eq(users.tenantId, tenantId), eq(users.id, responsibleEmployeeId))).limit(1) : [];
    return {
      work,
      ctx: employee
        ? { tenantId, userId: employee.id, employeeId: employee.id, role: role(employee.role), correlationId: workId }
        : { tenantId, userId: "system:objective-loop", role: "owner", correlationId: workId },
    };
  });
}

async function claimStep(tenantId: string, loopId: string, leaseOwner: string, expectedRevision?: number, expectedStepNumber?: number) {
  return withTenant(tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workObjectiveLoops} WHERE ${workObjectiveLoops.id}=${loopId} AND ${workObjectiveLoops.tenantId}=${tenantId} FOR UPDATE`);
    const [loop] = await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, tenantId), eq(workObjectiveLoops.id, loopId))).limit(1);
    if (!loop) throw new Error("Objective loop not found");
    if (["blocked", "completed", "failed", "cancelled"].includes(loop.state)) return { loop, step: null, terminal: true } as const;
    if (expectedRevision !== undefined && expectedRevision !== loop.revision) return { loop, step: null, terminal: true } as const;
    if (loop.leaseUntil && loop.leaseUntil > new Date() && loop.leaseOwner !== leaseOwner) return { loop, step: null, terminal: true } as const;
    const [unfinished] = await db.select().from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, tenantId), eq(workObjectiveSteps.objectiveLoopId, loop.id), sql`${workObjectiveSteps.completedAt} IS NULL`)).orderBy(desc(workObjectiveSteps.stepNumber)).limit(1);
    if (expectedStepNumber !== undefined && ((unfinished && unfinished.stepNumber !== expectedStepNumber) || (!unfinished && loop.stepCount >= expectedStepNumber))) {
      return { loop, step: null, terminal: true } as const;
    }
    const leaseUntil = new Date(Date.now() + 30_000);
    if (unfinished) {
      const [leased] = await db.update(workObjectiveLoops).set({ leaseOwner, leaseUntil, updatedAt: new Date() }).where(eq(workObjectiveLoops.id, loop.id)).returning();
      return { loop: leased!, step: unfinished, terminal: false } as const;
    }
    const stepNumber = loop.stepCount + 1;
    if (expectedStepNumber !== undefined && stepNumber !== expectedStepNumber) return { loop, step: null, terminal: true } as const;
    const [step] = await db.insert(workObjectiveSteps).values({
      tenantId,
      objectiveLoopId: loop.id,
      workId: loop.workId,
      stepNumber,
      idempotencyKey: `revision:${loop.revision}:step:${stepNumber}`,
      phase: "inspecting",
    }).returning();
    if (!step) throw new Error("Unable to persist objective iteration");
    const [updated] = await db.update(workObjectiveLoops).set({ stepCount: stepNumber, state: "continue", nextRunAt: null, leaseOwner, leaseUntil, updatedAt: new Date() }).where(eq(workObjectiveLoops.id, loop.id)).returning();
    return { loop: updated!, step, terminal: false } as const;
  });
}

async function releaseLease(tenantId: string, loopId: string, leaseOwner: string): Promise<void> {
  await withTenant(tenantId, (db) => db.update(workObjectiveLoops).set({ leaseOwner: null, leaseUntil: null, updatedAt: new Date() }).where(and(eq(workObjectiveLoops.tenantId, tenantId), eq(workObjectiveLoops.id, loopId), eq(workObjectiveLoops.leaseOwner, leaseOwner))));
}

async function currentIterationState(tenantId: string, loopId: string, stepId: string, revision: number, leaseOwner: string): Promise<{ current: boolean; state: ObjectiveIterationOutcome }> {
  return withTenant(tenantId, async (db) => {
    const [loop] = await db.select({ state: workObjectiveLoops.state, revision: workObjectiveLoops.revision, leaseOwner: workObjectiveLoops.leaseOwner }).from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, tenantId), eq(workObjectiveLoops.id, loopId))).limit(1);
    const [step] = await db.select({ completedAt: workObjectiveSteps.completedAt }).from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, tenantId), eq(workObjectiveSteps.id, stepId))).limit(1);
    if (!loop) throw new Error("Objective loop disappeared while checking its iteration lease");
    return { current: loop.revision === revision && loop.leaseOwner === leaseOwner && !step?.completedAt, state: loop.state };
  });
}

async function inspectCanonicalState(tenantId: string, workId: string, loop: typeof workObjectiveLoops.$inferSelect, step: typeof workObjectiveSteps.$inferSelect, ctx: TenantContext): Promise<{ inspection: ObjectiveInspection; inspectionHash: string }> {
  const aggregate = await workAggregate(tenantId, workId);
  if (!aggregate) throw new Error("Objective Work aggregate not found");
  const vertical = await resolveTenantVertical(tenantId);
  let businessRequest: OperationalQueryRequest;
  if (vertical.verticalKey === "private_equity") {
    const resolution = await resolvePrivateEquityDealReference(tenantId, loop.objective, { workId, userId: ctx.userId });
    if (resolution.status !== "resolved") throw new Error("Objective PE inspection requires one exact Work-anchored Deal");
    // The close-readiness composition includes PE2 eligibility plus P3 decision
    // readiness/acquisition options. Other bounded PE reads remain available as
    // one-step query decisions when the objective needs requests/workstreams.
    businessRequest = { intent: "closing_readiness", dealId: resolution.dealId };
  } else {
    businessRequest = { intent: "work_list", recordId: workId };
  }
  const businessAuthority = await evaluateAuthority(ctx, queryAuthorityRequest(businessRequest, workId));
  if (businessAuthority.outcome !== "allowed") throw new Error(`Authority denied canonical objective inspection: ${businessAuthority.reasonCode}`);
  const businessState = await executeTenantOperationalQuery(tenantId, businessRequest, {
    workId,
    executionKey: `objective:${loop.id}:revision:${loop.revision}:step:${step.stepNumber}:inspect:business-state`,
  });
  const objectiveSteps = aggregate.objectiveSteps as Array<typeof workObjectiveSteps.$inferSelect>;
  const actorId = ctx.employeeId ?? (/^[0-9a-f-]{36}$/i.test(ctx.userId) ? ctx.userId : null);
  const [identityAccess, computerConfig, computerRunRows, delegationRows, acknowledgementRows, eventWake] = await Promise.all([
    actorId ? listAvailableIdentityAccess(tenantId, actorId) : Promise.resolve({ communicationIdentities: [], applicationAccounts: [], authProfiles: [] }),
    withTenant(tenantId, async (db) => {
      const [row] = await db.select({ computerConfig: tenantSettings.computerConfig }).from(tenantSettings).where(eq(tenantSettings.tenantId, tenantId)).limit(1);
      const config = isRecord(row?.computerConfig) ? row.computerConfig : {};
      return { enabled: config.enabled === true, provider: typeof config.provider === "string" ? config.provider : null };
    }),
    withTenant(tenantId, (db) => db.select({
      id: computerRuns.id,
      domainActionId: computerRuns.domainActionId,
      status: computerRuns.status,
      mode: computerRuns.mode,
      application: computerRuns.application,
      authProfileRef: computerRuns.authProfileRef,
      task: computerRuns.task,
      target: computerRuns.target,
      result: computerRuns.result,
      failureCode: computerRuns.failureCode,
      blockReason: computerRuns.blockReason,
      createdAt: computerRuns.createdAt,
      finishedAt: computerRuns.finishedAt,
      sessionReleasedAt: computerRuns.sessionReleasedAt,
    }).from(computerRuns).where(and(eq(computerRuns.tenantId, tenantId), eq(computerRuns.workId, workId))).orderBy(asc(computerRuns.createdAt))),
    withTenant(tenantId, (db) => db.select({
      id: delegations.id,
      domainActionId: delegations.domainActionId,
      taskId: delegations.taskId,
      targetType: delegations.targetType,
      targetId: delegations.targetId,
      status: delegations.status,
      acknowledgementDeadline: delegations.acknowledgementDeadline,
      completionDeadline: delegations.completionDeadline,
      acknowledgedAt: delegations.acknowledgedAt,
      acceptedAt: delegations.acceptedAt,
      completedAt: delegations.completedAt,
      updatedAt: delegations.updatedAt,
    }).from(delegations).where(and(eq(delegations.tenantId, tenantId), eq(delegations.workId, workId))).orderBy(asc(delegations.createdAt))),
    withTenant(tenantId, (db) => db.select({
      id: acknowledgementRequests.id,
      domainActionId: acknowledgementRequests.domainActionId,
      delegationId: acknowledgementRequests.delegationId,
      taskId: acknowledgementRequests.taskId,
      recipientType: acknowledgementRequests.recipientType,
      recipientId: acknowledgementRequests.recipientId,
      status: acknowledgementRequests.status,
      deadline: acknowledgementRequests.deadline,
      acknowledgedAt: acknowledgementRequests.acknowledgedAt,
      declinedAt: acknowledgementRequests.declinedAt,
      updatedAt: acknowledgementRequests.updatedAt,
    }).from(acknowledgementRequests).where(and(eq(acknowledgementRequests.tenantId, tenantId), eq(acknowledgementRequests.workId, workId))).orderBy(asc(acknowledgementRequests.createdAt))),
    objectiveWakeContext(tenantId, loop.id),
  ]);
  const runIds = computerRunRows.map((run) => run.id);
  const computerEvidence = runIds.length === 0 ? [] : await withTenant(tenantId, (db) => db.select({
    id: computerArtifacts.id,
    runId: computerArtifacts.runId,
    kind: computerArtifacts.kind,
    mimeType: computerArtifacts.mimeType,
    sizeBytes: computerArtifacts.sizeBytes,
    sha256: computerArtifacts.sha256,
    metadata: computerArtifacts.metadata,
    createdAt: computerArtifacts.createdAt,
  }).from(computerArtifacts).where(and(eq(computerArtifacts.tenantId, tenantId), inArray(computerArtifacts.runId, runIds))).orderBy(asc(computerArtifacts.createdAt)));
  const computerRunInspection = computerRunRows.map((run) => ({
    ...run,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    sessionReleasedAt: run.sessionReleasedAt?.toISOString() ?? null,
    evidence: computerEvidence.filter((artifact) => artifact.runId === run.id).map((artifact) => ({
      ...artifact,
      createdAt: artifact.createdAt.toISOString(),
    })),
  }));
  const aggregateActions = aggregate.actions as Array<typeof domainActions.$inferSelect>;
  const actions = aggregateActions.slice(-20).map((action) => ({
    id: action.id, actionType: action.actionType, status: action.status, summary: action.summary, payload: bounded(action.payload, 8_000), objectiveStepId: action.objectiveStepId, businessEffectId: action.businessEffectId,
  }));
  const actionIds = aggregateActions.map((action) => action.id);
  const effectRows = actionIds.length === 0 ? [] : await withTenant(tenantId, (db) => db.select({
    id: businessEffects.id,
    domainActionId: businessEffects.domainActionId,
    status: businessEffects.status,
    effect: businessEffects.effect,
    verification: businessEffects.verification,
    observedResult: businessEffects.observedResult,
    observedAt: businessEffects.observedAt,
  }).from(businessEffects).where(and(eq(businessEffects.tenantId, tenantId), inArray(businessEffects.domainActionId, actionIds))).orderBy(asc(businessEffects.createdAt)));
  const operations = (aggregate.operations as Array<Record<string, unknown>>).slice(-10).map((operation) => ({
    id: operation.id, domainActionId: operation.domainActionId, operationType: operation.operationType, status: operation.status,
    targetCount: operation.targetCount, pendingCount: operation.pendingCount, runningCount: operation.runningCount,
    succeededCount: operation.succeededCount, failedCount: operation.failedCount, retryCount: operation.retryCount,
    finalOutcome: bounded(operation.finalOutcome, 8_000), failure: bounded(operation.failure, 8_000),
  }));
  const receipts = (aggregate.receipts as Array<Record<string, unknown>>).slice(-12).map((receipt) => ({
    id: receipt.id, domainActionId: receipt.domainActionId, operationId: receipt.operationId, objective: receipt.objective,
    actualResult: bounded(receipt.actualResult, 8_000), failure: bounded(receipt.failure, 8_000), finalizedAt: receipt.finalizedAt,
  }));
  const inspection: ObjectiveInspection = {
    inspectedAt: new Date().toISOString(),
    work: { id: workId, status: (aggregate.work as { status: string }).status, activeContext: (aggregate.work as { activeContext: unknown }).activeContext },
    objective: {
      id: loop.id, text: loop.objective, state: loop.state, revision: loop.revision,
      successCondition: loop.successCondition,
      successVerification: loop.successVerification,
      budget: {
        stepCount: loop.stepCount, maxSteps: loop.maxSteps, actionCount: loop.actionCount, maxActions: loop.maxActions,
        queryCount: loop.queryCount, maxQueries: loop.maxQueries, plannerFailureCount: loop.plannerFailureCount,
        maxPlannerFailures: loop.maxPlannerFailures, consecutiveNoProgress: loop.consecutiveNoProgress,
        maxConsecutiveNoProgress: loop.maxConsecutiveNoProgress, deadlineAt: loop.deadlineAt.toISOString(),
      },
    },
    companyGraph: { entityLinks: aggregate.entityLinks },
    executionAccess: { identityAccess, computerTask: computerConfig },
    computerRuns: computerRunInspection,
    delegations: delegationRows.map((row) => ({
      ...row,
      acknowledgementDeadline: row.acknowledgementDeadline?.toISOString() ?? null,
      completionDeadline: row.completionDeadline?.toISOString() ?? null,
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    })),
    acknowledgementRequests: acknowledgementRows.map((row) => ({
      ...row,
      deadline: row.deadline?.toISOString() ?? null,
      acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      declinedAt: row.declinedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    })),
    eventWake: bounded(eventWake, 24_000),
    eventWaits: (aggregate.eventWaits as Array<Record<string, unknown>>).map((wait) => ({
      id: wait.id, objectiveStepId: wait.objectiveStepId, status: wait.status, expectedEventType: wait.expectedEventType,
      matchedEventId: wait.matchedEventId, conditionSummary: wait.conditionSummary,
      deadlineAt: wait.deadlineAt instanceof Date ? wait.deadlineAt.toISOString() : wait.deadlineAt ?? null,
    })),
    integrationEvents: (aggregate.integrationEvents as Array<Record<string, unknown>>).map((event) => ({
      id: event.id, eventType: event.eventType, status: event.status, source: event.source,
      workId: event.workId, occurredAt: event.occurredAt instanceof Date ? event.occurredAt.toISOString() : event.occurredAt,
      trustClass: event.trustClass,
    })),
    businessState: bounded(businessState, 40_000),
    actions,
    businessEffects: effectRows.map((effect) => ({
      ...effect,
      observedAt: effect.observedAt?.toISOString() ?? null,
      observedResult: bounded(effect.observedResult, 12_000),
    })),
    operations,
    receipts,
    priorIterations: objectiveSteps.filter((item) => item.id !== step.id).slice(-8).map((item) => ({
      stepNumber: item.stepNumber, decisionKind: item.decisionKind, decisionReason: item.decisionReason,
      outcome: item.iterationOutcome, observation: bounded(item.observation, 8_000), progressMade: item.progressMade,
    })),
    inspectionAuthority: { businessState: businessAuthority.id, companyContext: null },
  };
  return { inspection, inspectionHash: hash(inspection) };
}

function unresolvedEffect(inspection: ObjectiveInspection): {
  outcome: "awaiting_approval" | "waiting";
  reason: string;
  waitFor: z.infer<typeof WaitForSchema>;
} | null {
  const actions = inspection.actions as Array<{ id: string; status: string }>;
  const operations = inspection.operations as Array<{ status: string }>;
  const browserRuns = inspection.computerRuns as Array<{ id: string; status: string }>;
  const pending = actions.find((action) => action.status === "pending"
    || action.status === "needs_human_review"
    || action.status === "blocked_integration_unavailable");
  if (pending) {
    return {
      outcome: "awaiting_approval",
      reason: pending.status === "blocked_integration_unavailable"
        ? "A known pre-effect provider failure is durably paused for an explicit retry or escalation decision."
        : "A consequential action is durably paused at the approval boundary.",
      waitFor: { eventType: "action.state_changed", domainActionId: pending.id },
    };
  }
  const browserRun = browserRuns.find((run) => !["succeeded", "blocked", "failed", "timed_out", "cancelled"].includes(run.status));
  if (browserRun) {
    return { outcome: "waiting", reason: "A governed computer run is still producing its verifiable result.", waitFor: { eventType: "computer.run.terminal", computerRunId: browserRun.id } };
  }
  const running = actions.find((action) => action.status === "approved" || action.status === "executing");
  if (running || operations.some((operation) => ["queued", "running", "awaiting_approval"].includes(operation.status))) {
    if (!running) return null;
    return { outcome: "waiting", reason: "A prior typed action or durable operation is still producing its real result.", waitFor: { eventType: "action.state_changed", domainActionId: running.id } };
  }
  return null;
}

async function beginPlannerAttempt(tenantId: string, loopId: string, stepId: string, inspectionHash: string) {
  return withTenant(tenantId, async (db) => {
    const [latest] = await db.select({ count: sql<number>`count(*)::int` }).from(workObjectivePlannerAttempts).where(and(eq(workObjectivePlannerAttempts.tenantId, tenantId), eq(workObjectivePlannerAttempts.objectiveStepId, stepId)));
    const [attempt] = await db.insert(workObjectivePlannerAttempts).values({
      tenantId, objectiveLoopId: loopId, objectiveStepId: stepId, attempt: (latest?.count ?? 0) + 1, status: "planning", inspectionHash,
    }).returning();
    if (!attempt) throw new Error("Unable to persist objective planner attempt");
    await db.update(workObjectiveSteps).set({ phase: "deciding", inspectionHash, failure: null }).where(eq(workObjectiveSteps.id, stepId));
    return attempt;
  });
}

async function finishPlannerAttempt(tenantId: string, attemptId: string, status: "succeeded" | "failed" | "timed_out", provider: string | undefined, decision?: ObjectiveDecision, failure?: Record<string, unknown>): Promise<void> {
  await withTenant(tenantId, (db) => db.update(workObjectivePlannerAttempts).set({
    status, provider: provider ?? null, decision: decision ?? null, failure: failure ?? null, completedAt: new Date(),
  }).where(and(eq(workObjectivePlannerAttempts.tenantId, tenantId), eq(workObjectivePlannerAttempts.id, attemptId))));
}

function recoveryKind(decision: ObjectiveDecision | undefined): "retry" | "replan" | "recover" | "compensate" | "escalate" | "block" | null {
  if (!decision) return null;
  if (decision.kind === "block") return "block";
  if (decision.kind === "query" || decision.kind === "action" || decision.kind === "wait") return decision.recoveryMode ?? null;
  return null;
}

async function finishIteration(params: {
  tenantId: string;
  loop: typeof workObjectiveLoops.$inferSelect;
  step: typeof workObjectiveSteps.$inferSelect;
  outcome: ObjectiveIterationOutcome;
  reason: string;
  nextStep?: string | null;
  observation?: unknown;
  progressMade: boolean;
  decision?: ObjectiveDecision;
  authorityDecisionId?: string | null;
  queryExecutionId?: string | null;
  domainActionId?: string | null;
  planRevisionId?: string | null;
  planNodeId?: string | null;
  scheduledFor?: Date | null;
  failure?: unknown;
  actionIncrement?: number;
  queryIncrement?: number;
  successVerification?: ObjectiveSuccessVerification;
  durableWait?: {
    waitFor: z.infer<typeof WaitForSchema>;
    conditionSummary: string;
    earliestAt?: Date;
    deadlineAt?: Date | null;
  };
}): Promise<{
  outcome: ObjectiveIterationOutcome;
  loop: typeof workObjectiveLoops.$inferSelect;
  wakeClaimedDuringWaitCreation?: boolean;
}> {
  const result = await withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workObjectiveLoops} WHERE ${workObjectiveLoops.id}=${params.loop.id} FOR UPDATE`);
    const [current] = await db.select().from(workObjectiveLoops).where(eq(workObjectiveLoops.id, params.loop.id)).limit(1);
    if (!current) throw new Error("Objective loop disappeared while finishing an iteration");
    const [currentStep] = await db.select({ completedAt: workObjectiveSteps.completedAt }).from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, params.tenantId), eq(workObjectiveSteps.id, params.step.id))).limit(1);
    if (current.revision !== params.loop.revision || current.leaseOwner !== params.loop.leaseOwner || currentStep?.completedAt) {
      return { outcome: current.state, loop: current, superseded: true as const };
    }
    const nextNoProgress = params.outcome === "continue"
      ? (params.progressMade ? 0 : current.consecutiveNoProgress + 1)
      : current.consecutiveNoProgress;
    let outcome = params.outcome;
    let reason = params.reason;
    if (outcome === "continue" && current.stepCount >= current.maxSteps) {
      outcome = "blocked";
      reason = `Objective stopped at the configured ${current.maxSteps}-step limit.`;
    } else if (outcome === "continue" && nextNoProgress >= current.maxConsecutiveNoProgress) {
      outcome = "blocked";
      reason = `Objective stopped after ${nextNoProgress} consecutive iterations without observed progress.`;
    }
    // The ObjectiveLoop lease owner is also the P7 assignment fencing token.
    // Finalize ownership in this same transaction as the P6 step so a crash can
    // expose neither a completed step with a running owner nor the inverse.
    const [activeAssignment] = await db.select().from(workforceAssignments).where(and(
      eq(workforceAssignments.tenantId, params.tenantId),
      eq(workforceAssignments.objectiveStepId, params.step.id),
      eq(workforceAssignments.state, "running"),
      eq(workforceAssignments.leaseOwner, current.leaseOwner!),
    )).limit(1);
    if (activeAssignment) {
      const assignmentWaiting = outcome === "waiting" || outcome === "awaiting_approval";
      const assignmentCancelled = outcome === "cancelled";
      const assignmentFailed = outcome === "failed" || outcome === "blocked" || Boolean(params.failure);
      await db.update(workforceAssignments).set({
        state: assignmentWaiting ? "waiting" : assignmentCancelled ? "cancelled" : assignmentFailed ? "failed" : "completed",
        leaseOwner: null,
        leaseUntil: null,
        domainActionId: params.domainActionId ?? null,
        completedAt: assignmentWaiting ? null : new Date(),
        failure: assignmentFailed ? bounded({ code: outcome === "blocked" ? "OBJECTIVE_BLOCKED" : "OBJECTIVE_STEP_FAILED", reason, detail: params.failure ?? null }, 16_000) as object : null,
        updatedAt: new Date(),
      }).where(and(
        eq(workforceAssignments.id, activeAssignment.id),
        eq(workforceAssignments.state, "running"),
        eq(workforceAssignments.leaseOwner, current.leaseOwner!),
      ));
    }
    if (params.step.planRevisionId && (outcome === "blocked" || outcome === "failed" || outcome === "cancelled")) {
      await db.update(workPlanRevisions).set({ status: outcome === "failed" ? "failed" : "blocked" }).where(and(
        eq(workPlanRevisions.tenantId, params.tenantId),
        eq(workPlanRevisions.id, params.step.planRevisionId),
        eq(workPlanRevisions.status, "active"),
      ));
    }
    await db.update(workObjectiveSteps).set({
      phase: "finished",
      decisionKind: params.decision?.kind ?? (outcome === "waiting" ? "wait" : outcome === "completed" ? "complete" : outcome === "blocked" ? "block" : outcome === "failed" ? "fail" : null),
      decision: params.decision ?? null,
      decisionReason: reason,
      authorityDecisionId: params.authorityDecisionId ?? null,
      queryExecutionId: params.queryExecutionId ?? null,
      domainActionId: params.domainActionId ?? null,
      planRevisionId: params.planRevisionId ?? params.step.planRevisionId ?? null,
      planNodeId: params.planNodeId ?? params.step.planNodeId ?? null,
      observation: bounded(params.observation),
      progressMade: params.progressMade,
      iterationOutcome: outcome,
      scheduledFor: params.scheduledFor ?? null,
      failure: params.failure ? bounded(params.failure, 16_000) : null,
      recoveryKind: recoveryKind(params.decision),
      successVerification: params.successVerification ?? null,
      completedAt: new Date(),
    }).where(and(eq(workObjectiveSteps.tenantId, params.tenantId), eq(workObjectiveSteps.id, params.step.id)));
    const [updated] = await db.update(workObjectiveLoops).set({
      state: outcome,
      actionCount: current.actionCount + (params.actionIncrement ?? 0),
      queryCount: current.queryCount + (params.queryIncrement ?? 0),
      consecutiveNoProgress: nextNoProgress,
      nextRunAt: params.scheduledFor ?? null,
      reason,
      nextStep: params.nextStep ?? null,
      lastObservation: bounded(params.observation),
      successVerification: params.successVerification ?? current.successVerification,
      successVerifiedAt: outcome === "completed" ? new Date() : current.successVerifiedAt,
      completedAt: outcome === "completed" || outcome === "failed" || outcome === "cancelled" ? new Date() : null,
      cancelledAt: outcome === "cancelled" ? new Date() : current.cancelledAt,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: new Date(),
    }).where(eq(workObjectiveLoops.id, current.id)).returning();
    let finalLoop = updated!;
    let wakeClaimedDuringWaitCreation = false;
    if ((outcome === "waiting" || outcome === "awaiting_approval") && params.durableWait) {
      const created = await createWorkEventWaitTx(db, {
        tenantId: params.tenantId,
        workId: current.workId,
        objectiveLoopId: current.id,
        objectiveStepId: params.step.id,
        waitFor: params.durableWait.waitFor,
        conditionSummary: params.durableWait.conditionSummary,
        earliestAt: params.durableWait.earliestAt,
        deadlineAt: params.durableWait.deadlineAt,
      });
      wakeClaimedDuringWaitCreation = Boolean(created.wakeClaimId);
      const [reloaded] = await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, params.tenantId), eq(workObjectiveLoops.id, current.id))).limit(1);
      if (!reloaded) throw new Error("Objective Loop disappeared after its durable wait was created");
      finalLoop = reloaded;
      outcome = reloaded.state;
    }
    const packStatus = outcome === "completed" ? "completed"
      : outcome === "failed" ? "failed"
        : outcome === "cancelled" ? "cancelled"
          : outcome === "blocked" ? "blocked"
            : null;
    if (packStatus) {
      await db.update(outcomePackRuns).set({
        status: packStatus,
        blockedReason: outcome === "blocked" ? reason : null,
        finalVerification: params.successVerification ?? null,
        completedAt: outcome === "completed" || outcome === "failed" || outcome === "cancelled" ? new Date() : null,
        updatedAt: new Date(),
      }).where(and(eq(outcomePackRuns.tenantId, params.tenantId), eq(outcomePackRuns.objectiveLoopId, current.id)));
    }
    return { outcome, loop: finalLoop, superseded: false as const, wakeClaimedDuringWaitCreation, finalizedAssignmentId: activeAssignment?.id ?? null };
  });
  if (result.superseded) return result;
  if (result.wakeClaimedDuringWaitCreation) return result;
  const workStatus = result.outcome === "continue" ? "executing" : result.outcome;
  await transitionWork(params.tenantId, params.loop.workId, workStatus, "objective_iteration_finished", {
    objectiveLoopId: params.loop.id,
    objectiveStepId: params.step.id,
    stepNumber: params.step.stepNumber,
    outcome: result.outcome,
    reason: result.loop.reason,
  }, result.outcome === "completed"
    ? { finalOutcome: { kind: "objective", objectiveLoopId: params.loop.id, successVerification: params.successVerification, observation: bounded(params.observation), reason: result.loop.reason } }
    : result.outcome === "failed" ? { failure: { kind: "objective", objectiveLoopId: params.loop.id, reason: result.loop.reason, detail: bounded(params.failure) } }
      : result.outcome === "cancelled" ? { finalOutcome: { kind: "objective", objectiveLoopId: params.loop.id, state: "cancelled", reason: result.loop.reason } } : {});
  if (result.outcome === "continue") await scheduleIteration(result.loop, new Date(), params.loop.workId);
  if (result.finalizedAssignmentId) await recordLearningObservationForAssignment(params.tenantId, result.finalizedAssignmentId);
  return result;
}

async function latestActionObservation(tenantId: string, workId: string, actionId: string): Promise<Record<string, unknown>> {
  const aggregate = await workAggregate(tenantId, workId);
  if (!aggregate) return { actionId, missing: true };
  const action = (aggregate.actions as Array<Record<string, unknown>>).find((item) => item.id === actionId);
  const operations = (aggregate.operations as Array<Record<string, unknown>>).filter((item) => item.domainActionId === actionId);
  const receipts = (aggregate.receipts as Array<Record<string, unknown>>).filter((item) => item.domainActionId === actionId);
  return { action: bounded(action, 12_000), operations: bounded(operations, 16_000), receipts: bounded(receipts, 20_000) };
}

function operationStillRunning(observation: Record<string, unknown>): boolean {
  const operations = Array.isArray(observation.operations) ? observation.operations as Array<Record<string, unknown>> : [];
  return operations.some((operation) => ["awaiting_approval", "queued", "running"].includes(String(operation.status)));
}

const EMPTY_OBJECTIVE_MEMORY: MemorySnapshot = {
  shortTerm: null,
  longTerm: null,
  semantic: [],
  episodic: [],
  patterns: null,
};

function objectiveStateProjection(inspection: ObjectiveInspection): Record<string, unknown> {
  return {
    work: inspection.work,
    objective: inspection.objective,
    companyGraph: inspection.companyGraph,
    businessState: inspection.businessState,
    executionAccess: inspection.executionAccess,
    computerRuns: inspection.computerRuns,
    delegations: inspection.delegations,
    acknowledgementRequests: inspection.acknowledgementRequests,
    eventWake: inspection.eventWake,
    eventWaits: inspection.eventWaits,
    integrationEvents: inspection.integrationEvents,
    actions: inspection.actions,
    businessEffects: inspection.businessEffects,
    operations: inspection.operations,
    receipts: inspection.receipts,
  };
}

function graphFromPersistence(value: unknown): PlanGraph {
  if (!isRecord(value) || value.version !== 1 || typeof value.semanticHash !== "string" || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    throw new Error("Active PlanRevision contains an invalid immutable PlanGraph");
  }
  return value as unknown as PlanGraph;
}

function compatibilityCandidate(decision: ObjectiveDecision, goal: GoalSpec): CandidatePlan {
  let material: CandidatePlanNode | null = null;
  if (decision.kind === "query") {
    material = { key: "material", kind: "query", request: decision.request, supports: goal.criteria.map((criterion) => criterion.id) };
  } else if (decision.kind === "action") {
    material = { key: "material", kind: "action", actionType: decision.actionType, payload: decision.payload, supports: goal.criteria.map((criterion) => criterion.id) };
  } else if (decision.kind === "wait") {
    material = {
      key: "material",
      kind: "wait",
      waitFor: decision.waitFor ?? { eventType: "deadline.reached" },
      ...(decision.deadlineAt || decision.resumeAt ? { deadlineAt: decision.deadlineAt ?? decision.resumeAt } : {}),
      supports: goal.criteria.map((criterion) => criterion.id),
    };
  }
  return {
    version: 1,
    candidateKey: "scripted-objective-compatibility",
    nodes: [
      ...(material ? [material] : []),
      ...goal.criteria.map((criterion, index): CandidatePlanNode => ({
        key: `check_${index + 1}`,
        kind: "check",
        criterionId: criterion.id,
        ...(material ? { dependsOn: [material.key] } : {}),
        observation: decision.kind === "complete" || decision.kind === "block" || decision.kind === "fail"
          ? { compatibilityControl: decision.kind, criterion: criterion.criterion }
          : criterion.criterion,
      })),
    ],
    rationale: decision.reason,
  };
}

function planDecision(node: PlanNode): ObjectiveDecision {
  if (node.kind === "query") {
    return {
      kind: "query",
      request: node.request,
      reason: "Execute the selected immutable PlanGraph query node and observe its canonical result.",
      nextStep: "Advance a causally ready dependent node when the persisted query observation matches; otherwise create a child PlanRevision.",
      recoveryMode: node.recovery.mode,
    };
  }
  if (node.kind === "action") {
    return {
      kind: "action",
      actionType: node.actionType,
      payload: node.groundedPayload,
      reason: "Execute the selected immutable PlanGraph action node through the existing governed DomainAction boundary.",
      nextStep: "Observe the durable BusinessEffect or DecisionReceipt, then advance the graph or create a child PlanRevision on mismatch.",
      recoveryMode: node.recovery.mode,
    };
  }
  if (node.kind === "wait") {
    return {
      kind: "wait",
      waitFor: node.waitFor as z.infer<typeof WaitForSchema>,
      ...(node.deadlineAt ? { deadlineAt: node.deadlineAt } : {}),
      condition: "Wait for the exact selected PlanGraph event correlation.",
      reason: "Enter the selected immutable PlanGraph wait node through the durable event-wait boundary.",
      recoveryMode: node.recovery.mode,
    };
  }
  return {
    kind: "complete",
    outcome: { planNodeId: node.id, criterionId: node.criterionId },
    reason: "Verify the accepted GoalSpec against current canonical business state.",
  };
}

function readyRootNode(graph: PlanGraph): PlanNode {
  const priority: Record<PlanNode["kind"], number> = { query: 0, wait: 1, action: 2, check: 3 };
  const ready = graph.nodes.filter((node) => node.dependsOn.length === 0)
    .sort((left, right) => priority[left.kind] - priority[right.kind] || left.semanticHash.localeCompare(right.semanticHash));
  if (!ready[0]) throw new Error("Selected PlanGraph has no causally ready root node");
  return ready[0];
}

function completionEvidenceRefs(verification: ObjectiveSuccessVerification): Array<{ type: string; id: string }> {
  const refs = verification.results.flatMap((result) => result.evidenceRefs ?? []);
  refs.push(...verification.queryExecutionIds.map((id) => ({ type: "work_query_execution", id })));
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.type}:${ref.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => `${left.type}:${left.id}`.localeCompare(`${right.type}:${right.id}`));
}

async function objectivePlanningInputs(params: {
  tenantId: string;
  workId: string;
  plannerAttemptId: string;
  loop: typeof workObjectiveLoops.$inferSelect;
  inspection: ObjectiveInspection;
  ctx: TenantContext;
  plugins: PluginRegistry;
}): Promise<{ workInputId: string; verticalKey: string; goal: GoalSpec; constraints: ConstraintSet; snapshot: PlanningWorldSnapshot; verifiedIrreversibleEffectHashes: string[] }> {
  const vertical = await resolveTenantVertical(params.tenantId);
  const manifest = planningCapabilitiesForVertical(params.plugins, vertical.verticalKey);
  const actionTypes = manifest.filter((item) => item.kind === "action" && item.available).map((item) => item.capability);
  const [input, policyRows, revisions, effectRows] = await Promise.all([
    withTenant(params.tenantId, async (db) => {
      const [row] = await db.select().from(workInputs).where(and(eq(workInputs.tenantId, params.tenantId), eq(workInputs.workId, params.workId)))
        .orderBy(desc(workInputs.createdAt), desc(workInputs.id)).limit(1);
      return row ?? null;
    }),
    actionTypes.length === 0 ? Promise.resolve([]) : withTenant(params.tenantId, (db) => db.select().from(domainPolicyRevisions).where(and(
      eq(domainPolicyRevisions.tenantId, params.tenantId),
      inArray(domainPolicyRevisions.actionType, actionTypes),
      lte(domainPolicyRevisions.effectiveFrom, new Date()),
    )).orderBy(desc(domainPolicyRevisions.effectiveFrom), desc(domainPolicyRevisions.version))),
    withTenant(params.tenantId, (db) => db.select({ id: workPlanRevisions.id, planGraph: workPlanRevisions.planGraph })
      .from(workPlanRevisions).where(and(eq(workPlanRevisions.tenantId, params.tenantId), eq(workPlanRevisions.workId, params.workId)))),
    withTenant(params.tenantId, (db) => {
      return db.select({
        id: businessEffects.id,
        status: businessEffects.status,
        planRevisionId: domainActions.planRevisionId,
        planNodeId: domainActions.planNodeId,
      }).from(domainActions).innerJoin(businessEffects, and(
        eq(businessEffects.tenantId, params.tenantId),
        eq(businessEffects.domainActionId, domainActions.id),
      )).where(and(eq(domainActions.tenantId, params.tenantId), eq(domainActions.workId, params.workId)));
    }),
  ]);
  if (!input) throw new Error("Objective planning requires a durable WorkInput");
  const effectivePolicies = policyRows.filter((row, index, all) => all.findIndex((candidate) => candidate.actionType === row.actionType) === index);
  const graphByRevision = new Map(revisions.map((row) => [row.id, graphFromPersistence(row.planGraph)]));
  const currentEffects = effectRows.flatMap((effect) => {
    const graph = effect.planRevisionId ? graphByRevision.get(effect.planRevisionId) : undefined;
    const node = graph?.nodes.find((candidate) => candidate.id === effect.planNodeId && candidate.kind === "action");
    return node ? [{
      semanticHash: node.semanticHash,
      status: effect.status,
      irreversible: node.kind === "action" && node.irreversible,
      evidenceRef: `business_effect:${effect.id}`,
    }] : [];
  });
  const verifiedIrreversibleEffectHashes = currentEffects
    .filter((effect) => effect.status === "verified" && effect.irreversible)
    .map((effect) => effect.semanticHash);
  const stateProjection = objectiveStateProjection(params.inspection);
  const stateHash = planningHash(stateProjection);
  const rawRefs = canonicalRefsFromContext({ work: params.inspection.work, companyGraph: params.inspection.companyGraph });
  const refs = rawRefs.filter((ref, index, all) => all.findIndex((candidate) => candidate.entityType === ref.entityType && candidate.entityId === ref.entityId) === index);
  const targets = refs.map((ref) => ({
    kind: "entity" as const,
    type: ref.entityType,
    id: ref.entityId,
    sourceRef: "work.active_context",
  }));
  const condition = parseObjectiveSuccessCondition(params.loop.successCondition);
  const authority = await employeeAuthoritySnapshot(params.ctx).catch(() => ({
    employeeId: params.ctx.employeeId ?? null,
    revision: params.ctx.authorityRevision ?? null,
    roles: params.ctx.authorityRoles ?? [params.ctx.role],
  }));
  const goal = buildGoalSpec({
    objective: params.loop.objective,
    workId: params.workId,
    workInputId: input.id,
    targets,
    deadline: params.loop.deadlineAt,
    successCondition: condition as unknown as Record<string, unknown> & { criteria?: unknown[]; source?: unknown },
  });
  const constraints = buildConstraintSet({
    tenantId: params.tenantId,
    verticalKey: vertical.verticalKey,
    allowedCapabilities: manifest.filter((item) => item.modelProposable && item.available).map((item) => item.capability),
    humanOnlyCapabilities: manifest.filter((item) => !item.modelProposable).map((item) => item.capability),
    prohibitedCapabilities: [],
    authorityRevision: authority.revision,
    budgets: {
      ...DEFAULT_PLAN_BUDGETS,
      maxActions: Math.max(0, params.loop.maxActions - params.loop.actionCount),
      maxQueries: Math.max(0, params.loop.maxQueries - params.loop.queryCount),
    },
    constraints: [],
    deadlineAt: params.loop.deadlineAt.toISOString(),
    softPreferences: [],
  });
  const snapshot = buildPlanningWorldSnapshot({
    workId: params.workId,
    workInputId: input.id,
    plannerAttemptId: params.plannerAttemptId,
    tenantId: params.tenantId,
    verticalKey: vertical.verticalKey,
    capturedAt: params.inspection.inspectedAt,
    decisionContextHash: stateHash,
    canonicalStateHash: stateHash,
    work: { id: params.workId, status: String(params.inspection.work.status ?? ""), inputId: input.id },
    interactionContextRef: { hash: planningHash(input.contextSnapshot ?? null), sourceRef: "work_input.context_snapshot" },
    canonicalEntities: targets.map((target) => ({ ...target, versionHash: null })),
    canonicalVersions: [
      { sourceRef: "objective.canonical_state", versionHash: planningHash(params.inspection.businessState) },
      { sourceRef: "objective.execution_state", versionHash: planningHash({ actions: params.inspection.actions, effects: params.inspection.businessEffects, operations: params.inspection.operations }) },
    ],
    activeObjective: { id: params.loop.id, revision: params.loop.revision, successConditionHash: planningHash(condition) },
    completedEffects: currentEffects.filter((effect) => effect.status === "verified").map((effect) => ({ semanticHash: effect.semanticHash, irreversible: effect.irreversible, evidenceRef: effect.evidenceRef })),
    outstandingEffects: currentEffects.filter((effect) => effect.status !== "verified").map((effect) => ({ semanticHash: effect.semanticHash, status: effect.status, evidenceRef: effect.evidenceRef })),
    policyRefs: effectivePolicies.map((row) => ({
      actionType: row.actionType,
      policyId: row.policyId,
      version: row.version,
      semanticHash: planningHash({ actionType: row.actionType, policyId: row.policyId, version: row.version, policy: row.policy, requiresConfirmation: row.requiresConfirmation }),
    })),
    evidenceRefs: effectRows.map((effect) => ({ type: "business_effect", id: effect.id })),
    epistemicWarnings: [],
    sourceRefs: [{ kind: "operational_query", ref: "objective.canonical_state", asOf: params.inspection.inspectedAt, hash: planningHash(params.inspection.businessState) }],
    authority,
    capabilities: manifest.map((item) => ({
      capability: item.capability,
      kind: item.kind,
      modelProposable: item.modelProposable,
      available: item.available,
      health: item.health,
      risk: item.risk,
      irreversible: item.irreversible,
      requiredReferences: item.requiredReferences,
      effectClass: item.effectClass,
      observationStrategy: item.observationStrategy,
      reversibility: item.reversibility,
      supportedRecoveryModes: item.supportedRecoveryModes,
      externalSideEffect: item.externalSideEffect,
      authorityRequirement: item.authorityRequirement,
    })),
    currentEffects: currentEffects.map(({ semanticHash, status, irreversible }) => ({ semanticHash, status, irreversible })),
    sourceHealth: { status: "complete", missing: [] },
  });
  return { workInputId: input.id, verticalKey: vertical.verticalKey, goal, constraints, snapshot, verifiedIrreversibleEffectHashes };
}

async function consequentialDispatchViolation(params: {
  tenantId: string;
  workId: string;
  loopRevision: number;
  planRevisionId: string;
  node: Extract<PlanNode, { kind: "action" }>;
  ctx: TenantContext;
  plugins: PluginRegistry;
}): Promise<string | null> {
  const currentPlan = await activeWorkPlanRevision(params.tenantId, params.workId);
  if (!currentPlan || currentPlan.id !== params.planRevisionId) return "The PlanRevision is no longer active";
  const snapshot = isRecord(currentPlan.planningSnapshot) ? currentPlan.planningSnapshot as unknown as PlanningWorldSnapshot : null;
  if (!snapshot || snapshot.workId !== params.workId) return "The active PlanRevision snapshot is malformed or Work-scoped incorrectly";
  const current = await withTenant(params.tenantId, async (db) => {
    const [work] = await db.select({ status: works.status }).from(works).where(and(eq(works.tenantId, params.tenantId), eq(works.id, params.workId))).limit(1);
    const [input] = await db.select({ id: workInputs.id }).from(workInputs).where(and(eq(workInputs.tenantId, params.tenantId), eq(workInputs.workId, params.workId)))
      .orderBy(desc(workInputs.createdAt), desc(workInputs.id)).limit(1);
    const [loop] = await db.select({ revision: workObjectiveLoops.revision, state: workObjectiveLoops.state }).from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, params.tenantId), eq(workObjectiveLoops.workId, params.workId))).limit(1);
    const [policy] = await db.select().from(domainPolicyRevisions).where(and(
      eq(domainPolicyRevisions.tenantId, params.tenantId),
      eq(domainPolicyRevisions.actionType, params.node.actionType),
      lte(domainPolicyRevisions.effectiveFrom, new Date()),
    )).orderBy(desc(domainPolicyRevisions.effectiveFrom), desc(domainPolicyRevisions.version)).limit(1);
    const grounding = await groundEntitiesWithDb(db, params.tenantId, params.node.groundedPayload);
    return { work, input, loop, policy, grounding };
  });
  if (!current.work || ["cancelled", "completed", "failed"].includes(current.work.status)) return `Work is ${current.work?.status ?? "missing"}`;
  if (current.input?.id !== snapshot.workInputId) return "The active WorkInput changed after plan selection";
  if (current.loop?.revision !== params.loopRevision || current.loop.state !== "continue") return "The Objective was interrupted, redirected, or moved out of runnable state";
  if (current.grounding.some((field) => field.status !== "verified")) return "An entity reference or expected version is no longer grounded";
  const vertical = await resolveTenantVertical(params.tenantId);
  const capability = planningCapabilitiesForVertical(params.plugins, vertical.verticalKey).find((item) => item.kind === "action" && item.capability === params.node.actionType);
  if (!capability?.available || !capability.modelProposable || capability.health === "unavailable") return "The selected capability is no longer available to the planner";
  if (requiredPlanningHealthCapability(params.node.actionType, params.node.groundedPayload)) {
    const providerHealth = await planningHealthForAction({
      tenantId: params.tenantId,
      actorId: params.ctx.employeeId ?? params.ctx.userId,
      actionType: params.node.actionType,
      payload: params.node.groundedPayload,
    });
    if (!providerHealth || providerHealth.health === "unavailable") {
      return providerHealth?.reason
        ? `The selected provider capability is unavailable: ${providerHealth.reason}`
        : "The selected provider capability health could not be verified";
    }
  }
  const plugin = params.plugins.resolve(params.node.actionType);
  const schemaResult = plugin?.payloadSchemas?.[params.node.actionType]?.safeParse(params.node.groundedPayload);
  if (!plugin || (schemaResult && !schemaResult.success)) return "The selected action payload no longer satisfies its registered schema";
  const snapshotPolicy = snapshot.policyRefs.find((ref) => ref.actionType === params.node.actionType);
  const currentPolicyHash = current.policy ? planningHash({
    actionType: current.policy.actionType,
    policyId: current.policy.policyId,
    version: current.policy.version,
    policy: current.policy.policy,
    requiresConfirmation: current.policy.requiresConfirmation,
  }) : null;
  if ((snapshotPolicy && snapshotPolicy.semanticHash !== currentPolicyHash) || (!snapshotPolicy && current.policy)) return "The effective action policy changed after plan selection";
  const authority = await employeeAuthoritySnapshot(params.ctx).catch(() => null);
  if (snapshot.authority.revision !== null && authority?.revision !== snapshot.authority.revision) return "The responsible employee's authority revision changed after plan selection";
  const refs = canonicalRefsFromContext(params.node.groundedPayload).map((ref) => ({ type: ref.entityType, id: ref.entityId }));
  if (params.node.authority === "approval_required") return null;
  const mayAct = await canExerciseAuthority(params.ctx, {
    operation: "action",
    capability: `action:${params.node.actionType}`,
    resources: refs.length > 0 ? refs : [{ type: "work", id: params.workId }],
    risk: params.node.risk,
    policyRequiresApproval: false,
    workId: params.workId,
  }).catch(() => false);
  return mayAct ? null : "Current authority cannot exercise the selected action capability";
}

export class ObjectiveLoopRuntime {
  constructor(
    private plugins: PluginRegistry,
    private actionExecutor: ObjectiveActionExecutor,
    private compatibilityPlanner?: ObjectiveDecisionPlanner,
    private canonicalPlanner: Planner = new LLMPlanner(plugins),
  ) {}

  async runIteration(params: {
    tenantId: string;
    workId: string;
    objectiveLoopId: string;
    expectedRevision?: number;
    expectedStepNumber?: number;
    workforceAssignmentId?: string;
    /** Existing Objective jobs defer; direct/manual invocations may execute the
     * same governed assignment inline without bypassing assignment/lease checks. */
    deferToWorkforceJob?: boolean;
    workforceLeaseOwner?: string;
    signal?: AbortSignal;
  }): Promise<ObjectiveIterationOutcome> {
    const leaseOwner = params.workforceLeaseOwner ?? randomUUID();
    const claimed = await claimStep(params.tenantId, params.objectiveLoopId, leaseOwner, params.expectedRevision, params.expectedStepNumber);
    if (claimed.terminal || !claimed.step) return claimed.loop.state;
    const loop = claimed.loop;
    const step = claimed.step;
    if (loop.workId !== params.workId) throw new Error("Objective job Work does not match its loop");
    if (step.stepNumber > loop.maxSteps) {
      return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: `Objective stopped at the configured ${loop.maxSteps}-step limit.`, progressMade: false })).outcome;
    }
    if (new Date() >= loop.deadlineAt) {
      return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "failed", reason: "Objective deadline expired before another safe step could begin.", progressMade: false, failure: { deadlineAt: loop.deadlineAt.toISOString() } })).outcome;
    }
    const { ctx, work } = await workerContext(params.tenantId, params.workId);
    let inspection: ObjectiveInspection;
    let inspectionHash: string;
    try {
      const inspected = await inspectCanonicalState(params.tenantId, params.workId, loop, step, ctx);
      inspection = inspected.inspection;
      inspectionHash = inspected.inspectionHash;
    } catch (error) {
      const failure = failureShape(error);
      if (/^Authority denied/i.test(String(failure.message))) {
        return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: String(failure.message), progressMade: false, failure })).outcome;
      }
      const [updated] = await withTenant(params.tenantId, async (db) => {
        await db.update(workObjectiveSteps).set({ phase: "inspecting", failure }).where(eq(workObjectiveSteps.id, step.id));
        return db.update(workObjectiveLoops).set({ plannerFailureCount: sql`${workObjectiveLoops.plannerFailureCount} + 1`, reason: `Canonical inspection failed: ${String(failure.message)}`, updatedAt: new Date() }).where(eq(workObjectiveLoops.id, loop.id)).returning();
      });
      const next = updated?.plannerFailureCount ?? loop.plannerFailureCount + 1;
      if (next >= loop.maxPlannerFailures) {
        return (await finishIteration({ tenantId: params.tenantId, loop: updated ?? loop, step, outcome: "failed", reason: "Canonical inspection exhausted its configured recovery attempts.", progressMade: false, failure })).outcome;
      }
      await transitionWork(params.tenantId, params.workId, "recovery", "objective_inspection_failed", { objectiveLoopId: loop.id, objectiveStepId: step.id, failure });
      await releaseLease(params.tenantId, loop.id, leaseOwner);
      throw error;
    }
    await withTenant(params.tenantId, (db) => db.update(workObjectiveSteps).set({ inspection: bounded(inspection, 128_000) as object, inspectionHash, phase: "deciding" }).where(eq(workObjectiveSteps.id, step.id)));
    await markObjectiveWakeConsumed(params.tenantId, loop.id, loop.revision);

    const unresolved = unresolvedEffect(inspection);
    if (unresolved) {
      return (await finishIteration({
        tenantId: params.tenantId, loop, step, outcome: unresolved.outcome, reason: unresolved.reason,
        nextStep: unresolved.outcome === "awaiting_approval" ? "Resume this same objective after authorization." : "Observe the durable result when its exact event arrives.",
        observation: { canonicalInspectionHash: inspectionHash }, progressMade: false,
        durableWait: { waitFor: unresolved.waitFor, conditionSummary: unresolved.reason },
      })).outcome;
    }

    let planRevisionId: string;
    let planSemanticHash: string;
    let planGoalHash: string;
    let planNode: PlanNode;
    let plannerAttemptId: string;
    let decision: ObjectiveDecision;
    const active = await activeWorkPlanRevision(params.tenantId, params.workId);
    if (!active && step.planRevisionId) {
      const [completedPlan] = await withTenant(params.tenantId, (db) => db.select().from(workPlanRevisions).where(and(
        eq(workPlanRevisions.tenantId, params.tenantId),
        eq(workPlanRevisions.id, step.planRevisionId!),
        eq(workPlanRevisions.workId, params.workId),
        eq(workPlanRevisions.status, "completed"),
      )).limit(1));
      const proof = isRecord(completedPlan?.completionProof) ? completedPlan.completionProof : null;
      const verification = proof && isRecord(proof.verification) ? proof.verification as unknown as ObjectiveSuccessVerification : null;
      if (proof?.verified === true && verification?.state === "verified") {
        return (await finishIteration({
          tenantId: params.tenantId,
          loop,
          step,
          outcome: "completed",
          reason: "Recovered a verified CompletionProof persisted before the prior Objective worker stopped.",
          decision: DecisionSchema.safeParse(step.decision).success ? step.decision as ObjectiveDecision : undefined,
          observation: { recoveredCompletionProof: proof },
          successVerification: verification,
          progressMade: true,
        })).outcome;
      }
    }
    const [latestHistoricalPlan] = !active ? await withTenant(params.tenantId, (db) => db.select().from(workPlanRevisions).where(and(
      eq(workPlanRevisions.tenantId, params.tenantId),
      eq(workPlanRevisions.workId, params.workId),
    )).orderBy(desc(workPlanRevisions.revision)).limit(1)) : [];
    if (!active && latestHistoricalPlan?.status === "completed") {
      throw new Error("A completed PlanRevision exists without a recoverable Objective CompletionProof binding");
    }
    const lineageParent = active ?? latestHistoricalPlan ?? null;
    let activeGraph: PlanGraph | null = null;
    let activeNode: PlanNode | null = null;
    let replanCause: PlanReplanCause = "observation";
    if (active) {
      activeGraph = graphFromPersistence(active.planGraph);
      if (step.planRevisionId === active.id && step.planNodeId) {
        // Exact crash resume: the unfinished Objective step retains ownership of
        // the same immutable node and deterministic action/query idempotency key.
        activeNode = activeGraph.nodes.find((node) => node.id === step.planNodeId)
          ?? (() => { throw new Error("Objective step references a node outside its active PlanRevision"); })();
      } else if (!this.compatibilityPlanner) {
        // The compatibility planner is a deterministic fixture/legacy adapter that
        // proposes exactly one material decision per call. It still compiles through
        // P6, but deliberately starts a child revision after that material boundary.
        // Canonical CandidatePlan planners use the complete graph frontier below.
        const completedSteps = await withTenant(params.tenantId, (db) => db.select({
          id: workObjectiveSteps.id,
          stepNumber: workObjectiveSteps.stepNumber,
          planNodeId: workObjectiveSteps.planNodeId,
          queryExecutionId: workObjectiveSteps.queryExecutionId,
          domainActionId: workObjectiveSteps.domainActionId,
          iterationOutcome: workObjectiveSteps.iterationOutcome,
          failure: workObjectiveSteps.failure,
          successVerification: workObjectiveSteps.successVerification,
          completedAt: workObjectiveSteps.completedAt,
        }).from(workObjectiveSteps).where(and(
          eq(workObjectiveSteps.tenantId, params.tenantId),
          eq(workObjectiveSteps.objectiveLoopId, loop.id),
          eq(workObjectiveSteps.planRevisionId, active.id),
          sql`${workObjectiveSteps.completedAt} IS NOT NULL`,
        )).orderBy(asc(workObjectiveSteps.stepNumber)));
        const progress = resolvePlanProgress(activeGraph, completedSteps, inspection);
        if (progress.state === "waiting") {
          return (await finishIteration({
            tenantId: params.tenantId,
            loop,
            step,
            outcome: "waiting",
            reason: progress.reason,
            nextStep: "Resume only after the existing exact durable correlation changes state.",
            observation: { canonicalInspectionHash: inspectionHash, waitingPlanRevisionId: active.id, waitingPlanNodeId: progress.node.id },
            progressMade: false,
          })).outcome;
        }
        if (progress.state === "ready") activeNode = progress.node;
        else replanCause = progress.cause;
      }
    }

    if (active && activeGraph && activeNode) {
      planNode = activeNode;
      planRevisionId = active.id;
      planSemanticHash = active.semanticHash;
      planGoalHash = activeGraph.goalHash;
      if (!active.plannerAttemptId) throw new Error("Active Objective PlanRevision has no canonical planner attempt");
      plannerAttemptId = active.plannerAttemptId;
      const persistedDecision = DecisionSchema.safeParse(step.decision);
      decision = planNode.kind === "check" && persistedDecision.success && ["complete", "block", "fail"].includes(persistedDecision.data.kind)
        ? persistedDecision.data
        : planDecision(planNode);
    } else {
      const attempt = await beginPlannerAttempt(params.tenantId, loop.id, step.id, inspectionHash);
      let canonicalAttempt: Awaited<ReturnType<typeof beginCanonicalWorkPlannerAttempt>> | undefined;
      try {
        const latestInput = await withTenant(params.tenantId, async (db) => {
          const [row] = await db.select({ id: workInputs.id }).from(workInputs).where(and(eq(workInputs.tenantId, params.tenantId), eq(workInputs.workId, params.workId)))
            .orderBy(desc(workInputs.createdAt), desc(workInputs.id)).limit(1);
          return row ?? null;
        });
        if (!latestInput) throw new Error("Objective planning requires a durable WorkInput");
        canonicalAttempt = await beginCanonicalWorkPlannerAttempt({
          tenantId: params.tenantId,
          workId: params.workId,
          workInputId: latestInput.id,
          attemptKey: `objective:${loop.id}:revision:${loop.revision}:step:${step.stepNumber}:attempt:${attempt.attempt}`,
          decisionContext: objectiveStateProjection(inspection),
        });
        const inputs = await objectivePlanningInputs({
          tenantId: params.tenantId,
          workId: params.workId,
          plannerAttemptId: canonicalAttempt.id,
          loop,
          inspection,
          ctx,
          plugins: this.plugins,
        });
        let planning: PlanningResult;
        let compatibilityDecision: ObjectiveDecision | undefined;
        if (this.compatibilityPlanner) {
          const allowedActionTypes = plannerActionTypesForVertical(this.plugins, inputs.verticalKey);
          const proposed = await this.compatibilityPlanner.decide({
            objective: loop.objective,
            inspection,
            allowedActionTypes,
            actionPayloadSpec: this.plugins.payloadSpecJson(allowedActionTypes),
            remaining: { steps: Math.max(0, loop.maxSteps - loop.stepCount), actions: Math.max(0, loop.maxActions - loop.actionCount), queries: Math.max(0, loop.maxQueries - loop.queryCount) },
            tenantId: params.tenantId,
            workId: params.workId,
            channel: channel(loop.initialChannel),
            signal: params.signal,
            deadlineAt: Math.min(loop.deadlineAt.getTime(), Date.now() + 15_000),
          });
          const parsed = DecisionSchema.safeParse(proposed);
          if (!parsed.success) throw new Error(`Scripted Objective proposal failed schema validation: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
          compatibilityDecision = parsed.data;
          if (compatibilityDecision.kind === "complete") parseObjectiveCompletionEvidence(compatibilityDecision.evidence);
          planning = await new LLMPlanner(this.plugins).compileCandidatePlans({
            candidates: [compatibilityCandidate(compatibilityDecision, inputs.goal)],
            tenantContext: ctx,
            verticalKey: inputs.verticalKey,
            goal: inputs.goal,
            constraints: inputs.constraints,
            snapshot: inputs.snapshot,
            useDatabase: true,
          });
        } else {
          planning = await this.canonicalPlanner.plan(loop.objective, ctx, EMPTY_OBJECTIVE_MEMORY, {
            workId: params.workId,
            workInputId: inputs.workInputId,
            plannerAttemptId: canonicalAttempt.id,
            decisionContextHash: canonicalAttempt.decisionContextHash ?? inputs.snapshot.decisionContextHash,
            channel: channel(loop.initialChannel),
            signal: params.signal,
            deadlineAt: Math.min(loop.deadlineAt.getTime(), Date.now() + 15_000),
            planDeadlineAt: loop.deadlineAt.toISOString(),
            goalSpec: inputs.goal,
            constraints: inputs.constraints,
            planningSnapshot: inputs.snapshot,
            planningContext: inspection,
            parentRevisionId: lineageParent?.id,
            priorVerifiedEffectHashes: inputs.verifiedIrreversibleEffectHashes,
          });
        }
        const selected = await selectPlanRevision({
          planning,
          tenantContext: ctx,
          workId: params.workId,
          workInputId: inputs.workInputId,
          plannerAttemptId: canonicalAttempt.id,
          objectiveLoopId: loop.id,
          parentRevisionId: lineageParent?.id ?? null,
          reason: active ? replanCause : lineageParent ? "redirect" : "initial",
        });
        planRevisionId = selected.planRevisionId;
        planSemanticHash = selected.planSemanticHash;
        planGoalHash = selected.graph.goalHash;
        plannerAttemptId = canonicalAttempt.id;
        planNode = readyRootNode(selected.graph);
        decision = planNode.kind === "check" && compatibilityDecision && ["complete", "block", "fail"].includes(compatibilityDecision.kind)
          ? compatibilityDecision
          : planDecision(planNode);
        await withTenant(params.tenantId, (db) => db.update(workObjectiveSteps).set({
          planRevisionId,
          planNodeId: planNode.id,
          decisionKind: decision.kind,
          decision,
          decisionReason: decision.reason,
        }).where(and(eq(workObjectiveSteps.tenantId, params.tenantId), eq(workObjectiveSteps.id, step.id))));
        await finishCanonicalWorkPlannerAttempt({
          tenantId: params.tenantId,
          attemptId: canonicalAttempt.id,
          status: "succeeded",
          plannerResult: {
            planRevisionId,
            planSemanticHash: selected.planSemanticHash,
            selectedCandidateKey: planning.compilation.selected?.candidateKey ?? null,
            planNodeId: planNode.id,
          },
        });
        await finishPlannerAttempt(params.tenantId, attempt.id, "succeeded", this.compatibilityPlanner?.providerName ?? "canonical_candidate_planner", decision);
      } catch (error) {
        const failure = failureShape(error);
        if (canonicalAttempt) await finishCanonicalWorkPlannerAttempt({ tenantId: params.tenantId, attemptId: canonicalAttempt.id, status: failure.timeout ? "timed_out" : "failed", failure });
        await finishPlannerAttempt(params.tenantId, attempt.id, failure.timeout ? "timed_out" : "failed", this.compatibilityPlanner?.providerName ?? "canonical_candidate_planner", undefined, failure);
        const [updated] = await withTenant(params.tenantId, (db) => db.update(workObjectiveLoops).set({ plannerFailureCount: sql`${workObjectiveLoops.plannerFailureCount} + 1`, reason: String(failure.message), updatedAt: new Date() }).where(eq(workObjectiveLoops.id, loop.id)).returning());
        if ((updated?.plannerFailureCount ?? loop.plannerFailureCount + 1) >= loop.maxPlannerFailures) {
          return (await finishIteration({ tenantId: params.tenantId, loop: updated ?? loop, step, outcome: "failed", reason: "Objective candidate planning exhausted its configured recovery attempts.", progressMade: false, failure })).outcome;
        }
        await withTenant(params.tenantId, (db) => db.update(workObjectiveSteps).set({ phase: "deciding", failure }).where(eq(workObjectiveSteps.id, step.id)));
        await transitionWork(params.tenantId, params.workId, "recovery", "objective_planner_attempt_failed", { objectiveLoopId: loop.id, objectiveStepId: step.id, attempt: attempt.attempt, failure });
        await releaseLease(params.tenantId, loop.id, leaseOwner);
        throw error;
      }
    }

    await withTenant(params.tenantId, (db) => db.update(workObjectiveSteps).set({
      planRevisionId,
      planNodeId: planNode.id,
      decisionKind: decision.kind,
      decision,
      decisionReason: decision.reason,
    }).where(and(eq(workObjectiveSteps.tenantId, params.tenantId), eq(workObjectiveSteps.id, step.id))));
    step.planRevisionId = planRevisionId;
    step.planNodeId = planNode.id;

    const currency = await currentIterationState(params.tenantId, loop.id, step.id, loop.revision, leaseOwner);
    if (!currency.current) {
      await releaseLease(params.tenantId, loop.id, leaseOwner);
      return currency.state;
    }

    const currentPlan = await activeWorkPlanRevision(params.tenantId, params.workId);
    if (currentPlan?.id !== planRevisionId || currentPlan.semanticHash !== planSemanticHash) {
      return (await finishIteration({
        tenantId: params.tenantId,
        loop,
        step,
        outcome: "continue",
        reason: "The selected PlanRevision was superseded before its material node could run; no operation was dispatched.",
        decision,
        observation: { selectedPlanRevisionId: planRevisionId, activePlanRevisionId: currentPlan?.id ?? null },
        progressMade: false,
      })).outcome;
    }

    // P7 interposes only after P6 has selected and revalidated the exact ready
    // node. The assignment cannot select, repair, or broaden the plan.
    await completePriorWaitingAssignments(params.tenantId, loop.id, step.id);
    let assignmentId = params.workforceAssignmentId;
    if (!assignmentId) {
      const requested = await requestWorkforceAssignment({
        tenantId: params.tenantId,
        workId: params.workId,
        planRevisionId,
        node: planNode,
        objectiveLoop: loop,
        objectiveStepId: step.id,
        plugins: this.plugins,
      });
      if (requested.status !== "assigned") {
        return (await finishIteration({
          tenantId: params.tenantId,
          loop,
          step,
          outcome: requested.status === "human_required" ? "waiting" : "blocked",
          reason: requested.reason,
          nextStep: requested.status === "human_required"
            ? "An authenticated human must act through the existing human-only boundary."
            : "Configure or restore an eligible governed AI worker, then explicitly continue this Work.",
          decision,
          observation: { workforceStatus: requested.status, capability: planNode.kind === "action" ? planNode.actionType : planNode.kind, ineligibility: requested.ineligibility },
          progressMade: false,
        })).outcome;
      }
      assignmentId = requested.assignment.id;
      if (params.deferToWorkforceJob) {
        await releaseLease(params.tenantId, loop.id, leaseOwner);
        return "continue";
      }
    }
    const workforceClaim = await claimWorkforceAssignment({ tenantId: params.tenantId, assignmentId, leaseOwner });
    if (workforceClaim.status !== "claimed") {
      await releaseLease(params.tenantId, loop.id, leaseOwner);
      if (workforceClaim.status === "expired" || workforceClaim.status === "reassigned") {
        await enqueueAssignmentRecovery(params.tenantId, assignmentId);
      }
      return loop.state;
    }
    if (workforceClaim.assignment.workId !== params.workId
      || workforceClaim.assignment.objectiveLoopId !== loop.id
      || workforceClaim.assignment.objectiveStepId !== step.id
      || workforceClaim.assignment.planRevisionId !== planRevisionId
      || workforceClaim.assignment.planNodeId !== planNode.id) {
      await releaseLease(params.tenantId, loop.id, leaseOwner);
      throw new Error("WorkforceAssignment does not bind the exact current P6 ObjectiveStep/PlanNode");
    }
    const workforceCurrency = () => isWorkforceAssignmentCurrent({
      tenantId: params.tenantId,
      assignmentId,
      leaseOwner,
      planRevisionId,
      planNodeId: planNode.id,
      agentRevisionId: workforceClaim.assignment.agentRevisionId,
    });
    const assignmentCurrent = await workforceCurrency();
    if (!assignmentCurrent) {
      await releaseLease(params.tenantId, loop.id, leaseOwner);
      return loop.state;
    }

    await withTenant(params.tenantId, (db) => db.update(workObjectiveSteps).set({ phase: decision.kind === "query" || decision.kind === "action" ? "acting" : "observing", decisionKind: decision.kind, decision, decisionReason: decision.reason, planRevisionId, planNodeId: planNode.id }).where(eq(workObjectiveSteps.id, step.id)));

    if (decision.kind === "complete") {
      if (planNode.kind !== "check") {
        return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: "Completion may only be attempted by a selected PlanGraph check node.", decision, progressMade: false })).outcome;
      }
      const condition = parseObjectiveSuccessCondition(loop.successCondition);
      const evidence = parseObjectiveCompletionEvidence(decision.evidence);
      const requestedVerificationQueries = condition.criteria.filter((criterion) => criterion.kind === "canonical_query").length
        + evidence.filter((item) => item.kind === "canonical_query").length;
      if (loop.queryCount + requestedVerificationQueries > loop.maxQueries) {
        return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: `Objective completion verification would exceed the configured ${loop.maxQueries}-query budget.`, decision, observation: { requestedVerificationQueries, remainingQueries: Math.max(0, loop.maxQueries - loop.queryCount) }, progressMade: false })).outcome;
      }
      const successVerification = await evaluateObjectiveSuccessCondition({
        tenantId: params.tenantId,
        workId: params.workId,
        loopId: loop.id,
        stepNumber: step.stepNumber,
        condition,
        inspection: await inspectCurrentObjectiveSuccessState(params.tenantId, params.workId, loop.id),
        evidence,
      });
      if (successVerification.state === "verified") {
        const currentPlan = await activeWorkPlanRevision(params.tenantId, params.workId);
        if (currentPlan?.id !== planRevisionId || currentPlan.semanticHash !== planSemanticHash) {
          return (await finishIteration({
            tenantId: params.tenantId,
            loop,
            step,
            outcome: "continue",
            reason: "Completion verification raced a newer PlanRevision; current truth must be verified against the new active graph.",
            decision,
            observation: { stalePlanRevisionId: planRevisionId, activePlanRevisionId: currentPlan?.id ?? null, successVerification },
            successVerification,
            progressMade: false,
            queryIncrement: successVerification.queryExecutionIds.length,
          })).outcome;
        }
        const completionProof: CompletionProof = {
          version: 1,
          finalPlanRevisionId: planRevisionId,
          planRevisionId,
          planSemanticHash,
          goalSemanticHash: planGoalHash,
          successConditionHash: planningHash(condition),
          verified: true,
          verifiedAt: successVerification.checkedAt,
          verification: successVerification as unknown as Record<string, unknown>,
          evidenceRefs: completionEvidenceRefs(successVerification),
        };
        const planCompleted = await completeWorkPlanRevision({ tenantId: params.tenantId, planRevisionId, completionProof: completionProof as unknown as Record<string, unknown> });
        if (!planCompleted) throw new Error("CompletionProof could not atomically complete the active PlanRevision");
        return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "completed", reason: decision.reason, decision, observation: { ...decision.outcome, successVerification, completionProof }, successVerification, progressMade: true, queryIncrement: successVerification.queryExecutionIds.length })).outcome;
      }
      const failedKinds = successVerification.results.filter((result) => !result.satisfied).map((result) => result.kind);
      return (await finishIteration({
        tenantId: params.tenantId,
        loop,
        step,
        outcome: successVerification.state === "blocked" ? "blocked" : "continue",
        reason: `Completion was rejected because the persisted business success condition is not verified: ${failedKinds.join(", ") || "unknown condition"}.`,
        nextStep: successVerification.state === "blocked" ? "Obtain the required manual verification or redirect the objective with an authorized success condition." : "Re-inspect current business state and choose one bounded step toward the unsatisfied success condition.",
        decision,
        observation: { proposedOutcome: decision.outcome, successVerification },
        successVerification,
        progressMade: false,
        queryIncrement: successVerification.queryExecutionIds.length,
      })).outcome;
    }
    if (decision.kind === "block") {
      return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: decision.reason, nextStep: decision.recovery, decision, observation: { recovery: decision.recovery ?? null }, progressMade: false })).outcome;
    }
    if (decision.kind === "fail") {
      return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "failed", reason: decision.reason, decision, observation: decision.failure, failure: decision.failure, progressMade: false })).outcome;
    }
    if (decision.kind === "wait") {
      if (planNode.kind !== "wait") {
        return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: "The wait decision does not match the selected PlanGraph node.", decision, progressMade: false })).outcome;
      }
      const deadlineValue = decision.deadlineAt ?? decision.resumeAt;
      const requested = deadlineValue ? new Date(deadlineValue) : null;
      if (requested && (Number.isNaN(requested.getTime()) || requested <= new Date() || requested > loop.deadlineAt)) {
        return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: "The proposed wait deadline was outside the objective's safe deadline.", decision, observation: { requestedDeadlineAt: deadlineValue, objectiveDeadlineAt: loop.deadlineAt.toISOString() }, progressMade: false })).outcome;
      }
      const waitFor = decision.waitFor ?? { eventType: "deadline.reached" };
      return (await finishIteration({
        tenantId: params.tenantId,
        loop,
        step,
        outcome: "waiting",
        reason: decision.reason,
        nextStep: decision.condition ?? waitFor.eventType,
        decision,
        observation: { waitingFor: waitFor, deadlineAt: requested?.toISOString() ?? null, inboundContentTreatment: "untrusted_evidence" },
        progressMade: false,
        scheduledFor: requested,
        durableWait: { waitFor, conditionSummary: decision.condition ?? `Wait for ${waitFor.eventType}`, deadlineAt: requested },
      })).outcome;
    }

    if (decision.kind === "query") {
      if (planNode.kind !== "query" || planningHash(planNode.request) !== planningHash(decision.request)) {
        return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: "The query does not exactly match the selected immutable PlanGraph node.", decision, progressMade: false })).outcome;
      }
      if (loop.queryCount >= loop.maxQueries) {
        return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: `Objective exhausted its ${loop.maxQueries}-query budget.`, decision, progressMade: false })).outcome;
      }
      const validated = validateOperationalQueryRequest(decision.request);
      if (!validated.success) {
        return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: `Model selected an invalid typed query: ${validated.error}`, decision, progressMade: false })).outcome;
      }
      const authority = await evaluateAuthority(ctx, queryAuthorityRequest(validated.request, params.workId));
      if (authority.outcome !== "allowed") {
        return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: `Authority denied the selected query: ${authority.reasonCode}`, decision, authorityDecisionId: authority.id, observation: { authority }, progressMade: false })).outcome;
      }
      try {
        if (!await workforceCurrency()) {
          await releaseLease(params.tenantId, loop.id, leaseOwner);
          return loop.state;
        }
        const result = await executeTenantOperationalQuery(params.tenantId, validated.request, {
          workId: params.workId,
          executionKey: `objective:${loop.id}:revision:${loop.revision}:step:${step.stepNumber}:decision-query`,
        });
        const executionId = result.execution?.id ?? null;
        const prior = isRecord(loop.lastObservation) ? loop.lastObservation : {};
        const semanticHash = hash(semanticQueryResult(result));
        const observation = { query: validated.request, result: bounded(result, 40_000), semanticHash };
        return (await finishIteration({
          tenantId: params.tenantId, loop, step, outcome: "continue", reason: decision.reason, nextStep: decision.nextStep,
          decision, authorityDecisionId: authority.id, queryExecutionId: executionId, observation,
          progressMade: prior.semanticHash !== semanticHash, queryIncrement: 1,
        })).outcome;
      } catch (error) {
        const failure = failureShape(error);
        return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "continue", reason: `Typed query failed; the next iteration must choose a recovery step: ${String(failure.message)}`, nextStep: "Recover from the failed read or block truthfully.", decision, authorityDecisionId: authority.id, observation: { failure }, failure, progressMade: false, queryIncrement: 1 })).outcome;
      }
    }

    if (loop.actionCount >= loop.maxActions) {
      return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: `Objective exhausted its ${loop.maxActions}-action budget.`, decision, progressMade: false })).outcome;
    }
    if (planNode.kind !== "action" || planNode.actionType !== decision.actionType || planningHash(planNode.groundedPayload) !== planningHash(decision.payload)) {
      return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: "The executable action does not exactly match the selected immutable PlanGraph node.", decision, progressMade: false })).outcome;
    }
    const dispatchViolation = await consequentialDispatchViolation({
      tenantId: params.tenantId,
      workId: params.workId,
      loopRevision: loop.revision,
      planRevisionId,
      node: planNode,
      ctx,
      plugins: this.plugins,
    });
    if (dispatchViolation) {
      return (await finishIteration({
        tenantId: params.tenantId,
        loop,
        step,
        outcome: "continue",
        reason: `Consequential dispatch was refused after current-state revalidation: ${dispatchViolation}.`,
        nextStep: "Build an immutable child PlanRevision from the new canonical state.",
        decision,
        observation: { stalePlanRevisionId: planRevisionId, dispatchViolation },
        progressMade: false,
      })).outcome;
    }
    if (!this.plugins.resolve(decision.actionType)) {
      return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "blocked", reason: `Model selected unregistered action type ${decision.actionType}.`, decision, progressMade: false })).outcome;
    }
    const effectHash = hash({ actionType: decision.actionType, payload: decision.payload });
    const priorSteps = await withTenant(params.tenantId, (db) => db.select().from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, params.tenantId), eq(workObjectiveSteps.objectiveLoopId, loop.id))).orderBy(asc(workObjectiveSteps.stepNumber)));
    const duplicate = priorSteps.find((item) => item.id !== step.id && item.domainActionId && isRecord(item.decision) && item.decision.kind === "action" && hash({ actionType: item.decision.actionType, payload: item.decision.payload }) === effectHash);
    if (duplicate?.domainActionId) {
      const observation = await latestActionObservation(params.tenantId, params.workId, duplicate.domainActionId);
      return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "continue", reason: "The same typed action was already attempted; its durable result was observed instead of repeating the side effect.", nextStep: decision.nextStep, decision, observation: { deduplicated: true, priorObjectiveStepId: duplicate.id, priorDomainActionId: duplicate.domainActionId, ...observation }, progressMade: false })).outcome;
    }

    const actionId = deterministicPlanActionId(planRevisionId, planNode.id);
    try {
      if (!await workforceCurrency()) {
        await releaseLease(params.tenantId, loop.id, leaseOwner);
        return loop.state;
      }
      const { action, result } = await this.actionExecutor.draftObjectiveAction({
        tenantId: params.tenantId,
        actionType: decision.actionType,
        payload: decision.payload,
        workId: params.workId,
        instructionId: null,
        initiatedBy: work.currentOwnerId ?? work.createdBy,
        authorityContext: isRecord(work.authorityContext) ? work.authorityContext : {},
        objectiveStepId: step.id,
        actionId,
        plannerAttemptId,
        planRevisionId,
        planNodeId: planNode.id,
      });
      const observation = await latestActionObservation(params.tenantId, params.workId, action.id);
      const awaitingApproval = Boolean(result.output?.gated || result.output?.pendingConfirmation) || (isRecord(observation.action) && ["pending", "needs_human_review"].includes(String(observation.action.status)));
      const waiting = !awaitingApproval && (operationStillRunning(observation) || (isRecord(observation.action) && ["approved", "executing"].includes(String(observation.action.status))));
      const outcome: ObjectiveIterationOutcome = awaitingApproval ? "awaiting_approval" : waiting ? "waiting" : "continue";
      const [computerRun] = waiting ? await withTenant(params.tenantId, (db) => db.select({ id: computerRuns.id }).from(computerRuns).where(and(
        eq(computerRuns.tenantId, params.tenantId),
        eq(computerRuns.domainActionId, action.id),
      )).limit(1)) : [];
      const durableWait = awaitingApproval
        ? { waitFor: { eventType: "action.state_changed", domainActionId: action.id }, conditionSummary: "Wait for the governed approval/action state to change." }
        : waiting
          ? computerRun
            ? { waitFor: { eventType: "computer.run.terminal", computerRunId: computerRun.id }, conditionSummary: "Wait for this exact governed computer run to reach a terminal outcome." }
            : { waitFor: { eventType: "action.state_changed", domainActionId: action.id }, conditionSummary: "Wait for this exact typed action to produce a durable state change." }
          : undefined;
      return (await finishIteration({
        tenantId: params.tenantId, loop, step, outcome,
        reason: awaitingApproval ? "The selected consequential action is durably paused for approval." : waiting ? "The typed action is still producing its durable result." : result.status === "success" ? decision.reason : `The action failed; the next iteration will inspect the receipt and choose recovery: ${result.error ?? "unknown failure"}`,
        nextStep: awaitingApproval ? "Resume this objective after authorization." : waiting ? "Observe the actual operation result." : decision.nextStep,
        decision, domainActionId: action.id, observation: { executionResult: bounded(result, 12_000), durable: observation },
        progressMade: result.status === "success" && !awaitingApproval,
        actionIncrement: 1,
        durableWait,
      })).outcome;
    } catch (error) {
      const failure = failureShape(error);
      return (await finishIteration({ tenantId: params.tenantId, loop, step, outcome: "continue", reason: `The action/provider failed before a successful result; recovery will be decided from canonical state: ${String(failure.message)}`, nextStep: "Inspect the failed action/receipt and select one safe recovery step.", decision, observation: { failure }, failure, progressMade: false, actionIncrement: 1 })).outcome;
    }
  }
}

export async function controlWorkObjective(params: {
  tenantId: string;
  workId: string;
  command: "continue" | "interrupt" | "redirect" | "cancel";
  actorId: string;
  objective?: string;
  successCondition?: ObjectiveSuccessCondition;
  correlationId?: string;
}): Promise<typeof workObjectiveLoops.$inferSelect> {
  let cancellationAlreadyRecorded = false;
  const loop = await withTenant(params.tenantId, async (db) => {
    await db.execute(sql`SELECT id FROM ${workObjectiveLoops} WHERE ${workObjectiveLoops.workId}=${params.workId} AND ${workObjectiveLoops.tenantId}=${params.tenantId} FOR UPDATE`);
    const [current] = await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, params.tenantId), eq(workObjectiveLoops.workId, params.workId))).limit(1);
    if (!current) throw new Error("Work has no objective loop");
    if (current.state === "cancelled" && params.command === "cancel") {
      cancellationAlreadyRecorded = true;
      return current;
    }
    if (current.state === "completed" || current.state === "cancelled") {
      throw new Error(`${current.state === "completed" ? "Completed" : "Cancelled"} objective cannot be ${params.command === "cancel" ? "cancelled" : "continued or redirected"}`);
    }
    await db.update(workPlanRevisions).set({
      status: params.command === "interrupt" || params.command === "cancel" ? "blocked" : "superseded",
    }).where(and(
      eq(workPlanRevisions.tenantId, params.tenantId),
      eq(workPlanRevisions.workId, params.workId),
      eq(workPlanRevisions.status, "active"),
    ));
    await db.update(workEventWaits).set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() }).where(and(
      eq(workEventWaits.tenantId, params.tenantId),
      eq(workEventWaits.objectiveLoopId, current.id),
      eq(workEventWaits.status, "waiting"),
    ));
    if (params.command === "interrupt" || params.command === "redirect" || params.command === "cancel") {
      const stepIds = (await db.select({ id: workObjectiveSteps.id }).from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, params.tenantId), eq(workObjectiveSteps.objectiveLoopId, current.id)))).map((step) => step.id);
      if (stepIds.length > 0) {
        const cancelled = await db.update(domainActions).set({ status: "rejected", executionStartedAt: null }).where(and(
          eq(domainActions.tenantId, params.tenantId),
          inArray(domainActions.objectiveStepId, stepIds),
          inArray(domainActions.status, ["draft", "pending", "approved", "needs_human_review"]),
        )).returning({ id: domainActions.id });
        if (cancelled.length > 0) {
          const cancelledActionIds = cancelled.map((action) => action.id);
          const approvalRows = await db.update(authorityApprovalRequests).set({ status: "rejected", resolvedAt: new Date() }).where(and(
            eq(authorityApprovalRequests.tenantId, params.tenantId),
            inArray(authorityApprovalRequests.domainActionId, cancelledActionIds),
            eq(authorityApprovalRequests.status, "pending"),
          )).returning({ id: authorityApprovalRequests.id });
          if (approvalRows.length > 0) {
            await db.update(authorityApprovalRequestSteps).set({ status: "skipped", decidedAt: new Date() }).where(and(
              eq(authorityApprovalRequestSteps.tenantId, params.tenantId),
              inArray(authorityApprovalRequestSteps.approvalRequestId, approvalRows.map((row) => row.id)),
              eq(authorityApprovalRequestSteps.status, "pending"),
            ));
          }
          await db.update(pendingConfirmations).set({ status: "rejected", resolvedAt: new Date() }).where(and(
            eq(pendingConfirmations.tenantId, params.tenantId),
            inArray(pendingConfirmations.domainActionId, cancelledActionIds),
            eq(pendingConfirmations.status, "awaiting"),
          ));
          await db.insert(actionLog).values(cancelled.map((action) => ({
            tenantId: params.tenantId,
            domainActionId: action.id,
            step: "rejected",
            input: { by: params.actorId, command: params.command },
            output: { reason: "Objective was interrupted, redirected, or cancelled before execution." },
          })));
        }
      }
    }
    await db.update(workObjectiveSteps).set({
      phase: "finished",
      iterationOutcome: params.command === "cancel" ? "cancelled" : "blocked",
      decisionReason: `Iteration superseded by ${params.command} from ${params.actorId}.`,
      progressMade: false,
      completedAt: new Date(),
    }).where(and(eq(workObjectiveSteps.tenantId, params.tenantId), eq(workObjectiveSteps.objectiveLoopId, current.id), sql`${workObjectiveSteps.completedAt} IS NULL`));
    if (params.command === "interrupt") {
      const [updated] = await db.update(workObjectiveLoops).set({ state: "blocked", reason: `Interrupted by ${params.actorId}.`, nextStep: "Explicitly continue or redirect this objective.", nextRunAt: null, leaseOwner: null, leaseUntil: null, updatedAt: new Date() }).where(eq(workObjectiveLoops.id, current.id)).returning();
      return updated!;
    }
    if (params.command === "cancel") {
      const [updated] = await db.update(workObjectiveLoops).set({
        state: "cancelled", reason: `Responsibility explicitly cancelled by ${params.actorId}.`, nextStep: null,
        nextRunAt: null, leaseOwner: null, leaseUntil: null, completedAt: new Date(), cancelledAt: new Date(), updatedAt: new Date(),
      }).where(eq(workObjectiveLoops.id, current.id)).returning();
      return updated!;
    }
    if (params.command === "redirect" && !params.objective?.trim()) throw new Error("Redirect requires a non-empty objective");
    const [updated] = await db.update(workObjectiveLoops).set({
      ...(params.command === "redirect" ? {
        objective: params.objective!.trim(),
        successCondition: params.successCondition ? parseObjectiveSuccessCondition(params.successCondition) : defaultObjectiveSuccessCondition(params.objective!.trim()),
        successVerification: null,
        successVerifiedAt: null,
      } : {}),
      // A control transition starts a new scheduling generation even when the text
      // is unchanged. This makes any pre-interrupt job provably stale and gives the
      // resumed first step a fresh durable idempotency key.
      revision: current.revision + 1,
      state: "continue", reason: params.command === "redirect" ? `Objective redirected by ${params.actorId}.` : `Objective continued by ${params.actorId}.`,
      nextStep: "Inspect current canonical business state.", nextRunAt: new Date(), completedAt: null, leaseOwner: null, leaseUntil: null, updatedAt: new Date(),
    }).where(eq(workObjectiveLoops.id, current.id)).returning();
    return updated!;
  });
  if (cancellationAlreadyRecorded) return loop;
  await withTenant(params.tenantId, (db) => db.update(outcomePackRuns).set({
    status: params.command === "cancel" ? "cancelled"
      : params.command === "interrupt" ? "paused"
        : params.command === "redirect" ? "blocked"
          : "active",
    blockedReason: params.command === "redirect" ? "Objective redirect invalidated the certified pack scope; review or start a new pack run." : null,
    completedAt: params.command === "cancel" ? new Date() : null,
    updatedAt: new Date(),
  }).where(and(eq(outcomePackRuns.tenantId, params.tenantId), eq(outcomePackRuns.workId, params.workId))));
  const workStatus = loop.state === "continue" ? "executing" : loop.state;
  await transitionWork(params.tenantId, params.workId, workStatus, `objective_${params.command}`, { objectiveLoopId: loop.id, actorId: params.actorId, revision: loop.revision, objective: params.command === "redirect" ? loop.objective : undefined }, loop.state === "cancelled" ? { finalOutcome: { kind: "objective", objectiveLoopId: loop.id, state: "cancelled", actorId: params.actorId } } : {});
  if (loop.state === "continue") await scheduleIteration(loop, new Date(), params.correlationId);
  return loop;
}

/** Periodic restart/operation recovery. It only enqueues due work; the iteration job
 * performs the tenant-scoped inspection and all authority checks. */
export async function recoverRunnableObjectives(tenantId: string): Promise<number> {
  let enqueued = await recoverDueWorkEventWaits(tenantId);
  const loops = await withTenant(tenantId, (db) => db.select().from(workObjectiveLoops).where(and(
    eq(workObjectiveLoops.tenantId, tenantId),
    sql`${workObjectiveLoops.state} IN ('continue','waiting','awaiting_approval')`,
  )));
  for (const loop of loops) {
    const [openWait] = await withTenant(tenantId, (db) => db.select({ id: workEventWaits.id }).from(workEventWaits).where(and(
      eq(workEventWaits.tenantId, tenantId),
      eq(workEventWaits.objectiveLoopId, loop.id),
      eq(workEventWaits.status, "waiting"),
    )).limit(1));
    if (openWait) continue;
    const due = loop.state === "continue" || (loop.state === "waiting" && (!loop.nextRunAt || loop.nextRunAt <= new Date()));
    if (due) {
      await scheduleIteration(loop, new Date(), loop.workId);
      enqueued += 1;
      continue;
    }
    if (loop.state === "awaiting_approval") {
      const aggregate = await workAggregate(tenantId, loop.workId);
      const actions = (aggregate?.actions ?? []) as Array<{ status: string }>;
      if (!actions.some((action) => action.status === "pending"
        || action.status === "needs_human_review"
        || action.status === "blocked_integration_unavailable")) {
        await scheduleIteration(loop, new Date(), loop.workId);
        enqueued += 1;
      }
    }
  }
  return enqueued;
}

/** Approval/action boundaries call this after the real action status changes. The
 * original awaiting-approval iteration remains immutable evidence; a new iteration
 * re-inspects the action, receipt, operation, and Company Graph before deciding. */
export async function resumeObjectiveForAction(tenantId: string, actionId: string): Promise<boolean> {
  const actionEvent = await withTenant(tenantId, async (db) => {
    const [action] = await db.select({
      id: domainActions.id,
      workId: domainActions.workId,
      status: domainActions.status,
      actionType: domainActions.actionType,
      objectiveStepId: domainActions.objectiveStepId,
    }).from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, actionId))).limit(1);
    if (!action) return null;
    const [latest] = await db.select({ id: actionLog.id, timestamp: actionLog.timestamp, step: actionLog.step }).from(actionLog)
      .where(and(eq(actionLog.tenantId, tenantId), eq(actionLog.domainActionId, actionId))).orderBy(desc(actionLog.timestamp)).limit(1);
    return { action, latest };
  });
  if (!actionEvent) return false;
  const normalized = await ingestIntegrationEvent({
    tenantId,
    source: "objective_action_runtime",
    sourceEventId: `action:${actionId}:${actionEvent.latest?.id ?? actionEvent.action.status}`,
    eventType: "action.state_changed",
    occurredAt: actionEvent.latest?.timestamp ?? new Date(),
    workId: actionEvent.action.workId,
    domainActionId: actionId,
    resource: { type: "domain_action", id: actionId },
    payload: { status: actionEvent.action.status, actionType: actionEvent.action.actionType, transition: actionEvent.latest?.step ?? null },
    evidenceRefs: actionEvent.latest ? [{ type: "action_log", id: actionEvent.latest.id }] : [],
    trustClass: "trusted_runtime",
  });
  if (normalized.matchedWaitIds.length > 0) return true;
  const loop = await withTenant(tenantId, async (db) => {
    const [action] = await db.select({ objectiveStepId: domainActions.objectiveStepId }).from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, actionId))).limit(1);
    if (!action?.objectiveStepId) return null;
    const [step] = await db.select({ objectiveLoopId: workObjectiveSteps.objectiveLoopId }).from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, tenantId), eq(workObjectiveSteps.id, action.objectiveStepId))).limit(1);
    if (!step) return null;
    const [current] = await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId, tenantId), eq(workObjectiveLoops.id, step.objectiveLoopId))).limit(1);
    if (!current || ["blocked", "completed", "failed", "cancelled"].includes(current.state)) return null;
    const [updated] = await db.update(workObjectiveLoops).set({ state: "continue", nextRunAt: new Date(), reason: "The approved/action result changed; canonical observation is due.", nextStep: "Observe the real action, receipt, operation, and business state.", updatedAt: new Date() }).where(eq(workObjectiveLoops.id, current.id)).returning();
    return updated ?? null;
  });
  if (!loop) return false;
  await scheduleIteration(loop, new Date(), loop.workId);
  return true;
}

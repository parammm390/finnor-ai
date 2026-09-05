// Orchestration core (§9): Planner → confirmation gate → Executor → Reflection.
// This module is the single entry point the API, webhooks, and workers all use.

import type { DomainAction, DomainPolicy, TenantContext, ExecutionResult, MemorySnapshot, OperatingContext, OperatingInteractionContext, EmployeeConversationContext, Role } from "@finnor/shared-types";
import {
  withTenant, domainActions, domainPolicies, domainPolicyRevisions, actionLog,
  decisionReceipts, planRepairs, enqueueJob, receiveWork, transitionWork,
  beginWorkPlannerAttempt, finishWorkPlannerAttempt, latestWorkInput, reconcileWorkStatus,
  authorizeBusinessOperationTx, businessOperations,
  attachWorkEntity,
  authorityStates,
  workObjectiveSteps,
  businessEffects,
  resolveTenantVertical,
} from "@finnor/db";
import { buildMemorySnapshot, appendEpisode, appendShortTerm } from "@finnor/memory";
import { createDefaultRegistry, type ToolRegistry } from "@finnor/tools";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { LLMPlanner, type Planner } from "./planner";
import { GatedExecutor, type Executor } from "./executor";
import { OutcomeReflection, type Reflection } from "./reflection";
import { createDefaultPluginRegistry, PluginRegistry } from "./plugin-registry";
import { resolveProvider, resolveProviderForPurpose } from "./llm";
import { AllowlistExecutor } from "./graph/allowlist-executor";
import { LangGraphExecutor } from "./graph/executor";
import { buildGateGraph } from "./graph/build-graph";
import { getCheckpointer } from "./graph/checkpointer";
import { ensureSecretsLoaded, redactStructured, redactText } from "@finnor/security";
import { isPlanActionReady, planIdForAction, readyPlanActions, recordPredictionDiff } from "./plan-dag";
import { plannerMemoryEnabled } from "./planner-memory";
import { createInstructionTraceAnswerEnvelope, createInstructionTraceResultEnvelope, ensureInstructionSession, emitInstructionEvent, isInstructionCancelled, isReadOnlyAnswerAction } from "./instruction-trace";
import {
  defaultFastReadOnlyRouter,
  type AnswerEnvelope,
  type FastReadOnlyRouter,
  type OperationalQueryDecision,
  type OperationalQueryExecution,
  type OperationalQueryRequest,
} from "./fast-read-lane";
import { isConversationalTurn, LLMConversationResponder, type ConversationResponder } from "./conversation";
import { requiresTypedConfirmation } from "../../../scripts/release/action-hardening-spec";
import { assembleOperatingContext } from "./operating-context";
import { interactionAwareOperationalDecision, resolveOperatingInteractionContext } from "./interaction-context";
import { employeeAuthoritySnapshot, evaluateActionApproval, evaluateAuthority, finalizeApprovalAuthorityTx, isFinalApprovalStep, revalidateActionExecution } from "@finnor/authority";
import { queryAuthorityRequest } from "./authority-runtime";
import { isConsequentialAction } from "./compiler";
import {
  ActionCancellationConflictError,
  assertActionNotCancelledTx,
  authorizeActionExecution,
  authorizeActionExecutionTx,
} from "./runtime-bridge";
import {
  controlWorkObjective,
  ObjectiveLoopRuntime,
  resumeObjectiveForAction,
  startWorkObjective,
  type ObjectiveDecisionPlanner,
  type StartObjectiveOptions,
} from "./objective-loop";
import { classifyInstructionRoute, finalizeInstructionRoute, type InstructionRouteDecision } from "./instruction-routing";
import { interpretPrivateEquityQuestion } from "@finnor/private-equity";

export * from "./llm";
export * from "./planner";
export * from "./compiler";
export * from "./executor";
export * from "./reflection";
export * from "./plugin-registry";
export * from "./voice";
export * from "./critic";
export * from "./learning";
export * from "./tiering";
export * from "./graph/allowlist-executor";
export * from "./graph/executor";
export * from "./graph/build-graph";
export * from "./graph/checkpointer";
export * from "./graph/state";
export * from "./plan-dag";
export * from "./planning-health";
export * from "./planner-memory";
export * from "./policy-simulation";
export * from "./instruction-trace";
export * from "./fast-read-lane";
export * from "./conversation";
export * from "./authority-runtime";
export * from "./objective-loop";
export * from "./operating-context";
export * from "./research-context";
export * from "./event-waits";
export * from "./interaction-context";
export * from "./interaction-targeting";
export * from "./runtime-bridge";
export * from "./durable-execution";
export * from "./instruction-routing";
export * from "./objective-success";
export * from "./external-observation";
export * from "./conversation-kernel";
export * from "./outcome-packs";
export * from "./autonomy";
export * from "./operational-query-runtime";

const EXTERNAL_RESEARCH_ACTION_TYPES = new Set(["search_web", "scan_competitors", "check_business_reviews"]);

export interface InstructionResult {
  actions: DomainAction[];
  answer?: AnswerEnvelope;
  query?: OperationalQueryExecution;
  workId?: string;
  workInputId?: string;
  instructionId?: string;
  objective?: { objectiveLoopId: string; state: string; route: "OBJECTIVE" };
}

export interface InstructionOptions {
  sessionId?: string;
  householdId?: string;
  instructionId?: string;
  workId?: string;
  workInputId?: string;
  idempotencyKey?: string;
  /** Optional deterministic key for the durable work_query_executions receipt. */
  executionKey?: string;
  plannerAttemptKey?: string;
  activeContext?: OperatingInteractionContext | Record<string, unknown>;
  conversationContext?: EmployeeConversationContext;
  channel?: "voice" | "text" | "console";
  signal?: AbortSignal;
  deadlineAt?: number;
  deadlineMs?: number;
  /** Set by an API boundary that already performed the pure read classification. */
  fastReadDecision?: OperationalQueryDecision;
  /** Skip the legacy router classification entirely after a planner decision. */
  skipFastReadClassification?: boolean;
  /** Set by an intake boundary that already applied the one execution-model policy. */
  instructionRouteDecision?: InstructionRouteDecision;
}

export interface OperationalQueryOptions {
  sessionId?: string;
  instructionId?: string;
  workId?: string;
  idempotencyKey?: string;
  executionKey?: string;
  activeContext?: OperatingInteractionContext | Record<string, unknown>;
  channel?: "voice" | "text" | "console";
}

export interface OperationalQueryRun extends OperationalQueryExecution {
  workId: string;
  workInputId: string;
  instructionId: string;
  duplicate?: boolean;
  answer?: AnswerEnvelope;
}

export interface Orchestrator {
  handleInstruction(
    instruction: string,
    ctx: TenantContext,
    opts?: InstructionOptions,
  ): Promise<DomainAction[]>;
  handleInstructionResult(
    instruction: string,
    ctx: TenantContext,
    opts?: InstructionOptions,
  ): Promise<InstructionResult>;
  runAction(actionId: string, tenantId: string): Promise<ExecutionResult>;
  repairPlanAfterTerminalFailure(tenantId: string, domainActionId: string, workflowStepId: string): Promise<void>;
}

/** A policy row is required for execution; absent one, a safe default gates everything. */
export function defaultPolicy(tenantId: string, actionType: string): DomainPolicy {
  return {
    id: "00000000-0000-4000-8000-00000000dead",
    tenantId,
    actionType,
    policy: {},
    // Default-deny posture: no configured policy → always require a human.
    requiresConfirmation: true,
    confirmationTemplate: null,
    // No real row exists — version 0 marks this as never having been a stored policy
    // (real rows start at 1, migration 0023's default), so a receipt citing version 0
    // is honestly distinguishable from one that cites an actual configured policy.
    version: 0,
  };
}

async function rememberAnswerTurn(
  instruction: string,
  answer: AnswerEnvelope,
  ctx: TenantContext,
  opts: InstructionOptions,
): Promise<void> {
  if (!opts.sessionId || !ctx.employeeId) return;
  const turn = {
    instruction,
    answer: {
      intent: answer.intent,
      title: answer.display.title,
      evidence: answer.evidence.slice(0, 5).map(({ source, ref }) => ({ source, ref })),
    },
    actions: [],
    at: new Date().toISOString(),
  };
  await appendShortTerm(ctx.tenantId, opts.sessionId, turn).catch(() => undefined);
}

function workFailure(error: unknown, fallback: string): Record<string, unknown> & { message: string; timeout: boolean } {
  const message = error instanceof Error ? error.message : fallback;
  const name = error instanceof Error ? error.name : "Error";
  const timeout = name === "AbortError" || /\b(?:timeout|timed out|deadline|aborted?)\b/i.test(message);
  return { message, name, timeout, recoverable: true, at: new Date().toISOString() };
}

function canonicalPayload(value: unknown): string {
  // Match PostgreSQL jsonb/JSON.stringify semantics exactly: undefined object
  // properties are omitted and undefined array members become null. Several legacy
  // deterministic actions intentionally pass optional properties as undefined.
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => entry === undefined ? "null" : canonicalPayload(entry)).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).filter((key) => row[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalPayload(row[key])}`).join(",")}}`;
}

export class PlannerAttemptAlreadyClaimedError extends Error {
  constructor(readonly workId: string, readonly attemptId: string) {
    super(`Planner attempt ${attemptId} for Work ${workId} is already claimed`);
    this.name = "PlannerAttemptAlreadyClaimedError";
  }
}

function requireFreshPlannerAttempt(workId: string, attempt: { id: string; claimed: boolean }): void {
  if (!attempt.claimed) throw new PlannerAttemptAlreadyClaimedError(workId, attempt.id);
}

async function authorityContextForWork(ctx: TenantContext): Promise<Record<string, unknown>> {
  if (!ctx.employeeId) return { principal: ctx.userId, kind: "service" };
  const snapshot = await employeeAuthoritySnapshot(ctx);
  return { employeeId: snapshot.employeeId, revision: snapshot.revision, roles: snapshot.roles };
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

export class FinnorOrchestrator implements Orchestrator {
  readonly plugins: PluginRegistry;
  readonly tools: ToolRegistry;
  readonly planner: Planner;
  readonly executor: Executor;
  readonly reflection: Reflection;
  readonly fastReadOnlyRouter: FastReadOnlyRouter;
  readonly conversationResponder: ConversationResponder;

  constructor(deps?: {
    plugins?: PluginRegistry;
    tools?: ToolRegistry;
    planner?: Planner;
    executor?: Executor;
    reflection?: Reflection;
    fastReadOnlyRouter?: FastReadOnlyRouter;
    conversationResponder?: ConversationResponder;
    objectiveDecisionPlanner?: ObjectiveDecisionPlanner;
  }) {
    this.plugins = deps?.plugins ?? createDefaultPluginRegistry();
    this.tools = deps?.tools ?? createDefaultRegistry();
    this.planner = deps?.planner ?? new LLMPlanner(this.plugins);
    this.reflection = deps?.reflection ?? new OutcomeReflection();
    this.fastReadOnlyRouter = deps?.fastReadOnlyRouter ?? defaultFastReadOnlyRouter;
    this.conversationResponder = deps?.conversationResponder ?? new LLMConversationResponder();
    if (deps?.executor) {
      this.executor = deps.executor;
    } else {
      const legacy = new GatedExecutor(this.plugins, this.tools);
      const graph = new LangGraphExecutor(buildGateGraph(this.plugins, this.tools, getCheckpointer()));
      this.executor = new AllowlistExecutor(legacy, graph);
    }
    this.objectiveLoopRuntime = new ObjectiveLoopRuntime(this.plugins, this, deps?.objectiveDecisionPlanner);
  }

  private readonly objectiveLoopRuntime: ObjectiveLoopRuntime;

  async startObjective(objective: string, ctx: TenantContext, options: StartObjectiveOptions = {}) {
    return startWorkObjective(objective, ctx, options);
  }

  async runObjectiveIteration(params: { tenantId: string; workId: string; objectiveLoopId: string; expectedRevision?: number; expectedStepNumber?: number; signal?: AbortSignal }) {
    return this.objectiveLoopRuntime.runIteration(params);
  }

  async controlObjective(params: { tenantId: string; workId: string; command: "continue" | "interrupt" | "redirect" | "cancel"; actorId: string; objective?: string; successCondition?: import("@finnor/shared-types").ObjectiveSuccessCondition; correlationId?: string }) {
    return controlWorkObjective(params);
  }

  /** Instruction (voice transcript or text) → plan → gate-or-execute each action.
   *  jarvis-v3 P3.T3: when the caller supplies a client-minted `instructionId`
   *  (`POST /api/actions`'s new optional field, P3.T4), this method's own real
   *  phases are traced into `instruction_events` (migration 0062) — the frontend's
   *  400ms poll is what makes the UNDERSTOOD/PLAN blocks stream in as this actually
   *  happens, instead of waiting for the whole POST to resolve. Absent an
   *  instructionId (the phone/worker paths, untouched), every emit call below is a
   *  real no-op (see instruction-trace.ts) — this method's own control flow and
   *  return value are unchanged either way. */
  async handleInstruction(
    instruction: string,
    ctx: TenantContext,
    opts: InstructionOptions = {},
  ): Promise<DomainAction[]> {
    const result = await this.handleInstructionResult(instruction, ctx, opts);
    return result.actions;
  }

  private async conversationalResult(
    instruction: string,
    ctx: TenantContext,
    memory: MemorySnapshot,
    opts: InstructionOptions,
    route: "conversation" | "empty_plan_recovery",
    work: { workId: string; workInputId: string; instructionId: string; plannerAttemptId: string },
  ): Promise<InstructionResult> {
    const instructionId = work.instructionId;
    try {
      const answer = await this.conversationResponder.answer(instruction, ctx, memory, {
        channel: opts.channel,
        signal: opts.signal,
        deadlineAt: opts.deadlineAt,
        deadlineMs: opts.deadlineMs,
        capabilityActionTypes: this.plugins.actionTypes(),
      });
      if (await isInstructionCancelled(ctx.tenantId, instructionId)) return { actions: [] };
      await finishWorkPlannerAttempt({
        tenantId: ctx.tenantId,
        attemptId: work.plannerAttemptId,
        status: "succeeded",
        plannerResult: { route, kind: "answer", actionCount: 0 },
      });
      await transitionWork(ctx.tenantId, work.workId, "ready", "planner_succeeded", { route, plannerAttemptId: work.plannerAttemptId }, { expectedWorkInputId: work.workInputId });
      await transitionWork(ctx.tenantId, work.workId, "executing", "answer_started", { route }, { expectedWorkInputId: work.workInputId });
      if (instructionId) {
        const answerId = `conversation:${instructionId}`;
        await emitInstructionEvent(ctx.tenantId, instructionId, "plan_ready", { count: 1, route });
        await emitInstructionEvent(ctx.tenantId, instructionId, "executing", { actionId: answerId, route });
        await emitInstructionEvent(ctx.tenantId, instructionId, "completed", createInstructionTraceAnswerEnvelope(answerId, answer));
      }
      await rememberAnswerTurn(instruction, answer, ctx, opts);
      await transitionWork(ctx.tenantId, work.workId, "completed", "answer_completed", { route }, {
        finalOutcome: { kind: "answer", route, spokenSummary: answer.spokenSummary },
        expectedWorkInputId: work.workInputId,
      });
      return { actions: [], answer, workId: work.workId, workInputId: work.workInputId, instructionId };
    } catch (err) {
      const failure = workFailure(err, "Conversational answer failed");
      await finishWorkPlannerAttempt({ tenantId: ctx.tenantId, attemptId: work.plannerAttemptId, status: failure.timeout ? "timed_out" : "failed", failure });
      await transitionWork(ctx.tenantId, work.workId, "failed", "understanding_failed", failure, { failure, expectedWorkInputId: work.workInputId });
      if (instructionId) {
        await emitInstructionEvent(ctx.tenantId, instructionId, "failed", {
          error: err instanceof Error ? err.message : "Conversational answer failed",
          route,
        });
      }
      throw err;
    }
  }

  private async executeFastOperationalQuery(
    request: OperationalQueryRequest,
    ctx: TenantContext,
    work: { workId: string; workInputId: string; instructionId: string },
    opts: { emitTrace?: boolean; executionKey?: string } = {},
  ): Promise<{ execution: OperationalQueryExecution; answer?: AnswerEnvelope }> {
    const start = Date.now();
    await transitionWork(ctx.tenantId, work.workId, "executing", "query_execution_started", {
      intent: request.intent,
      workInputId: work.workInputId,
    }, { expectedWorkInputId: work.workInputId });
    try {
      if (!this.fastReadOnlyRouter.execute) throw new Error("Operational query execution is unavailable");
      const authority = await evaluateAuthority(ctx, queryAuthorityRequest(request, work.workId));
      await transitionWork(ctx.tenantId, work.workId, "executing", "query_authority_evaluated", {
        authorityDecisionId: authority.id,
        authorityRevision: authority.authorityRevision,
        outcome: authority.outcome,
        reasonCode: authority.reasonCode,
      }, { expectedWorkInputId: work.workInputId });
      if (authority.outcome !== "allowed") throw new Error(`Authority denied: ${authority.reasonCode}`);
      if (opts.emitTrace !== false) {
        await emitInstructionEvent(ctx.tenantId, work.instructionId, "context_retrieved", {
          chips: [{ label: `${request.intent} canonical query selected`, source: `read-model:${request.intent}`, kind: "CANONICAL", role: "answer_evidence" }],
        });
        await emitInstructionEvent(ctx.tenantId, work.instructionId, "step_progress", {
          stage: "querying_business",
          intent: request.intent,
          sourceKind: "CANONICAL",
        });
        await emitInstructionEvent(ctx.tenantId, work.instructionId, "executing", {
          intent: request.intent,
          sourceKind: "CANONICAL",
        });
      }
      // The canonical read-model executor is the sole owner of
      // work_query_executions. Passing Work context here makes both NL and
      // explicit typed API reads use the same durable claim/finish path.
      const execution = await this.fastReadOnlyRouter.execute(request, ctx, {
        workId: work.workId,
        workInputId: work.workInputId,
        executionKey: opts.executionKey ?? work.instructionId,
      });
      const durationMs = Math.max(0, Date.now() - start);
      const queryId = execution.result.execution?.id ?? execution.metadata.queryId;
      const completedAt = execution.metadata.completedAt;
      const normalizedExecution: OperationalQueryExecution = {
        ...execution,
        metadata: {
          ...execution.metadata,
          queryId,
          durationMs,
          completedAt,
        },
      };
      const answer = this.fastReadOnlyRouter.answer?.(normalizedExecution);
      if (opts.emitTrace !== false) {
        await emitInstructionEvent(ctx.tenantId, work.instructionId, "verifying", {
          queryId,
          intent: request.intent,
          sourceKind: "CANONICAL",
        });
        await emitInstructionEvent(ctx.tenantId, work.instructionId, "verified", {
          queryId,
          intent: request.intent,
          rowCount: normalizedExecution.result.count,
          sourceKind: "CANONICAL",
        });
        await emitInstructionEvent(ctx.tenantId, work.instructionId, "completed", answer
          ? createInstructionTraceAnswerEnvelope(queryId, answer)
          : { queryId, intent: request.intent, durationMs });
      }
      await transitionWork(ctx.tenantId, work.workId, "completed", "query_execution_completed", {
        queryId,
        intent: request.intent,
        durationMs,
      }, {
        finalOutcome: { kind: "operational_query", query: normalizedExecution },
        expectedWorkInputId: work.workInputId,
      });
      return { execution: normalizedExecution, ...(answer ? { answer } : {}) };
    } catch (err) {
      const publicMessage = request.intent === "schedule_range"
        ? "The canonical schedule could not be queried, so appointments cannot be verified."
        : `The canonical ${request.intent.replaceAll("_", " ")} read could not be queried, so the result cannot be verified.`;
      const failure = { ...workFailure(err, publicMessage), message: publicMessage, cause: err instanceof Error ? err.message.slice(0, 300) : "query unavailable" };
      await transitionWork(ctx.tenantId, work.workId, "failed", "query_execution_failed", {
        intent: request.intent,
        message: failure.message,
        durationMs: Math.max(0, Date.now() - start),
      }, { failure, expectedWorkInputId: work.workInputId }).catch(() => undefined);
      if (opts.emitTrace !== false) await emitInstructionEvent(ctx.tenantId, work.instructionId, "failed", { error: failure.message, intent: request.intent, recoverable: true });
      throw err;
    }
  }

  /** Execute a typed operational request without natural-language planning. */
  async handleOperationalQuery(
    request: OperationalQueryRequest,
    ctx: TenantContext,
    opts: OperationalQueryOptions = {},
  ): Promise<OperationalQueryRun> {
    const instruction = `Typed operational query: ${request.intent}`;
    const received = await receiveWork({
      tenantId: ctx.tenantId,
      instruction,
      channel: opts.channel ?? "console",
      sessionId: opts.sessionId,
      instructionId: opts.instructionId,
      workId: opts.workId,
      userId: ctx.userId,
      idempotencyKey: opts.idempotencyKey,
      activeContext: opts.activeContext as Record<string, unknown> | undefined,
      authorityContext: await authorityContextForWork(ctx),
    });
    if (received.duplicate) {
      const finalOutcome = received.finalOutcome && typeof received.finalOutcome === "object" ? received.finalOutcome as Record<string, unknown> : {};
      const stored = finalOutcome.query && typeof finalOutcome.query === "object"
        ? finalOutcome.query as Record<string, unknown>
        : finalOutcome.response && typeof finalOutcome.response === "object" && (finalOutcome.response as Record<string, unknown>).query && typeof (finalOutcome.response as Record<string, unknown>).query === "object"
          ? (finalOutcome.response as Record<string, unknown>).query as Record<string, unknown>
          : null;
      if (stored && stored.result && stored.metadata) {
        const execution = stored as unknown as OperationalQueryExecution;
        const answer = this.fastReadOnlyRouter.answer?.(execution);
        return { ...execution, workId: received.workId, workInputId: received.workInputId, instructionId: received.instructionId, duplicate: true, ...(answer ? { answer } : {}) };
      }
      throw new Error("Duplicate operational query has no durable result to replay");
    }
    await ensureInstructionSession(ctx.tenantId, received.instructionId, instruction, {
      sessionId: opts.sessionId,
      userId: ctx.userId,
      source: opts.channel === "voice" ? "voice" : "typed",
      workId: received.workId,
    });
    await emitInstructionEvent(ctx.tenantId, received.instructionId, "received", { workId: received.workId, queryIntent: request.intent });
    await transitionWork(ctx.tenantId, received.workId, "understanding", "query_understanding_started", { queryIntent: request.intent, workInputId: received.workInputId }, { executionModel: "query", expectedWorkInputId: received.workInputId });
    const result = await this.executeFastOperationalQuery(request, ctx, {
      workId: received.workId,
      workInputId: received.workInputId,
      instructionId: received.instructionId,
    }, { executionKey: opts.executionKey ?? opts.idempotencyKey ?? received.instructionId });
    return {
      ...result.execution,
      workId: received.workId,
      workInputId: received.workInputId,
      instructionId: received.instructionId,
      ...(result.answer ? { answer: result.answer } : {}),
    };
  }

  /** Same instruction path as handleInstruction, with an additive direct-answer
   * result for callers that can render read-only answers immediately. Existing
   * callers should keep using handleInstruction when they only need action rows. */
  async handleInstructionResult(
    instruction: string,
    ctx: TenantContext,
    opts: InstructionOptions = {},
  ): Promise<InstructionResult> {
    const received = opts.workId && opts.workInputId && opts.instructionId
      ? {
          workId: opts.workId,
          workInputId: opts.workInputId,
          instructionId: opts.instructionId,
        }
      : await receiveWork({
          tenantId: ctx.tenantId,
          instruction,
          channel: opts.channel ?? "console",
          sessionId: opts.sessionId,
          instructionId: opts.instructionId,
          workId: opts.workId,
          userId: ctx.userId,
          idempotencyKey: opts.idempotencyKey,
          // The caller may still be holding an unverified interaction context.
          // Resolve it after the durable Work/Input claim before persisting it.
          activeContext: undefined,
          authorityContext: intakeAuthorityContext(ctx),
        });
    opts = {
      ...opts,
      activeContext: await resolveOperatingInteractionContext({
        tenantId: ctx.tenantId,
        context: opts.activeContext,
        channel: opts.channel ?? "console",
        workId: received.workId,
      }),
    };
    const workId = received.workId;
    const workInputId = received.workInputId;
    const instructionId = received.instructionId;
    const effectiveOpts: InstructionOptions = { ...opts, workId, workInputId, instructionId };
    await ensureInstructionSession(ctx.tenantId, instructionId, instruction, {
        sessionId: opts.sessionId,
        userId: ctx.userId,
        source: opts.channel === "voice" ? "voice" : "typed",
        workId,
      });
    await emitInstructionEvent(ctx.tenantId, instructionId, "received", { workId });
    await transitionWork(ctx.tenantId, workId, "understanding", "understanding_started", { instructionId, workInputId }, {
      ...(opts.activeContext ? { activeContext: opts.activeContext as Record<string, unknown> } : {}),
      expectedWorkInputId: workInputId,
    });

    // This branch is intentionally before memory retrieval and planner invocation.
    // Classification is read-only and can only produce a typed query; it never
    // selects an action type, policy, or write capability. When an API boundary has
    // already classified the instruction, it passes the decision so writes are not
    // classified a second time.
    let fastAnswer: AnswerEnvelope | null = null;
    let fastQuery: OperationalQueryExecution | undefined;
    let operatingContext: OperatingContext | undefined;
    const suppliedDecision = opts.fastReadDecision ? interactionAwareOperationalDecision(opts.fastReadDecision, opts.activeContext as OperatingInteractionContext | undefined) : undefined;
    const shouldClassify = !opts.skipFastReadClassification && suppliedDecision === undefined;
    let fastDecision: OperationalQueryDecision | undefined = suppliedDecision;
    let instructionRoute: InstructionRouteDecision | undefined = opts.instructionRouteDecision;
    try {
      if (shouldClassify) {
        // Legacy/unit embeddings may provide a fully injected fast-read seam
        // without a configured database. A missing vertical identity is not a
        // reason to break that seam; the canonical dispatcher will still fail
        // closed if an actual read is attempted. Only a confirmed PE identity
        // takes the PE-specific resolver below.
        let verticalKey: string | undefined;
        try {
          verticalKey = (await resolveTenantVertical(ctx.tenantId)).verticalKey;
        } catch {
          verticalKey = undefined;
        }
        if (verticalKey === "private_equity") {
          const peDecision = await interpretPrivateEquityQuestion(ctx.tenantId, instruction, { workId, userId: ctx.userId });
          if (peDecision.route === "fast_read") {
            fastDecision = { route: "fast_read", confidence: "high", request: peDecision.request };
          } else if (peDecision.route === "clarify") {
            const names = peDecision.resolution.candidates.map((candidate) => candidate.codeName ?? candidate.name).slice(0, 5);
            fastAnswer = {
              kind: "answer",
              intent: "conversation",
              readOnly: true,
              spokenSummary: peDecision.reason === "ambiguous_deal"
                ? `I found multiple matching Deals: ${names.join(", ")}. Which exact Deal should I use?`
                : "I could not resolve that Deal from this tenant's canonical PE records. Which exact Deal should I use?",
              display: {
                title: "Deal clarification required",
                facts: names.map((name) => ({ label: "Candidate", value: name })),
              },
              evidence: [],
              asOf: new Date().toISOString(),
              freshness: { status: "unknown", observedAt: new Date().toISOString() },
            };
            instructionRoute = { version: 1, route: "CONVERSATION", reasonCodes: [`pe_${peDecision.reason}`] };
          }
        }
        if (!fastDecision && !fastAnswer) {
          const interpreted = this.fastReadOnlyRouter.interpret?.(instruction);
          fastDecision = interpreted ? interactionAwareOperationalDecision(interpreted, opts.activeContext as OperatingInteractionContext | undefined) : undefined;
        }
      }
      const routeReadDecision: OperationalQueryDecision = fastDecision ?? { route: "planner", reason: "unsupported" };
      instructionRoute ??= classifyInstructionRoute({
        instruction,
        fastReadDecision: routeReadDecision,
        activeContext: opts.activeContext,
        conversational: isConversationalTurn(instruction),
      });
      if (opts.conversationContext?.resolution.status === "clarification_required") {
        instructionRoute = { version: 1, route: "ATOMIC_EFFECT", reasonCodes: ["phase6_reference_or_sender_ambiguous"] };
      }
      await transitionWork(ctx.tenantId, workId, "understanding", "instruction_routed", {
        policyVersion: instructionRoute.version,
        route: instructionRoute.route,
        reasonCodes: instructionRoute.reasonCodes,
      }, instructionRoute.route === "CONVERSATION"
        ? { expectedWorkInputId: workInputId }
        : { executionModel: instructionRoute.route === "QUERY" ? "query" : instructionRoute.route === "ATOMIC_EFFECT" ? "atomic_effect" : "objective", expectedWorkInputId: workInputId });
      if (instructionRoute.route === "QUERY" && routeReadDecision.route === "fast_read" && this.fastReadOnlyRouter.execute) {
        await emitInstructionEvent(ctx.tenantId, instructionId, "step_progress", { stage: "resolving_context", sourceKind: "PROFILE" });
        operatingContext = (await assembleOperatingContext(ctx, {
          instruction,
          workId,
          sessionId: opts.sessionId,
          activeContext: opts.activeContext,
          conversationContext: opts.conversationContext,
          includeMemory: false,
          includeCanonicalBusinessState: false,
        })).context;
        const result = await this.executeFastOperationalQuery(routeReadDecision.request, ctx, { workId, workInputId, instructionId }, { executionKey: opts.executionKey ?? opts.idempotencyKey ?? instructionId });
        fastQuery = result.execution;
        fastAnswer = result.answer ?? null;
      } else if (!opts.skipFastReadClassification && fastDecision === undefined) {
        // Legacy injected routers predate the typed seam. Keep their answer contract
        // intact, but never create a planner attempt for the read branch.
        fastAnswer = await this.fastReadOnlyRouter.route(instruction, ctx);
      }
    } catch (err) {
      const failure = workFailure(err, "Instruction classification failed");
      await transitionWork(ctx.tenantId, workId, "failed", "understanding_failed", failure, { failure, expectedWorkInputId: workInputId }).catch(() => undefined);
      await emitInstructionEvent(ctx.tenantId, instructionId, "failed", { error: failure.message, workId, recoverable: true });
      throw err;
    }
    if (fastQuery) return { actions: [], ...(fastAnswer ? { answer: fastAnswer } : {}), query: fastQuery, workId, workInputId, instructionId };
    if (fastAnswer) {
      await transitionWork(ctx.tenantId, workId, "executing", "answer_started", { route: "fast_read_only" }, { expectedWorkInputId: workInputId });
      await emitInstructionEvent(ctx.tenantId, instructionId, "executing", { actionId: `fast-read:${instructionId}`, route: "fast_read_only" });
      await emitInstructionEvent(ctx.tenantId, instructionId, "completed", createInstructionTraceAnswerEnvelope(`fast-read:${instructionId}`, fastAnswer));
      await transitionWork(ctx.tenantId, workId, "completed", "answer_completed", { route: "fast_read_only" }, {
        finalOutcome: { kind: "answer", route: "fast_read_only", spokenSummary: fastAnswer.spokenSummary },
        expectedWorkInputId: workInputId,
      });
      return { actions: [], answer: fastAnswer, workId, workInputId, instructionId };
    }

    if (instructionRoute?.route === "OBJECTIVE") {
      await emitInstructionEvent(ctx.tenantId, instructionId, "planning", { route: "objective" });
      if (await isInstructionCancelled(ctx.tenantId, instructionId)) return { actions: [], workId, workInputId, instructionId };
      const started = await this.startObjective(instruction, ctx, {
        channel: opts.channel ?? "console",
        sessionId: opts.sessionId,
        instructionId,
        workId,
        workInputId,
        idempotencyKey: opts.idempotencyKey,
        activeContext: opts.activeContext,
      });
      await emitInstructionEvent(ctx.tenantId, instructionId, "plan_ready", { route: "objective", objectiveLoopId: started.objectiveLoopId, boundedIterations: true });
      return { actions: [], workId, workInputId, instructionId, objective: { objectiveLoopId: started.objectiveLoopId, state: started.state, route: "OBJECTIVE" } };
    }

    // Greetings and capability turns are conversational by contract. Keep them
    // off the household resolver, semantic retrieval, and planner path so a simple
    // "hey" is fast, cannot inherit an unrelated customer/research context, and
    // still produces the same explicit progress trace as every other turn.
    if (instructionRoute?.route === "CONVERSATION") {
      try {
        await ensureSecretsLoaded();
      } catch (err) {
        const failure = workFailure(err, "Provider initialization failed");
        await transitionWork(ctx.tenantId, workId, "failed", "understanding_failed", failure, { failure, expectedWorkInputId: workInputId });
        await emitInstructionEvent(ctx.tenantId, instructionId, "failed", { error: failure.message, workId, recoverable: true });
        throw err;
      }
      {
        await emitInstructionEvent(ctx.tenantId, instructionId, "context_retrieved", { chips: [] });
        await emitInstructionEvent(ctx.tenantId, instructionId, "planning", { route: "conversation" });
      }
      const emptyMemory: MemorySnapshot = {
        shortTerm: null,
        longTerm: null,
        semantic: [],
        episodic: [],
        patterns: null,
      };
      const attempt = await beginWorkPlannerAttempt({ tenantId: ctx.tenantId, workId, workInputId, attemptKey: opts.plannerAttemptKey ?? `input:${workInputId}` });
      requireFreshPlannerAttempt(workId, attempt);
      await transitionWork(ctx.tenantId, workId, "planning", "planning_started", { plannerAttemptId: attempt.id, route: "conversation" }, { expectedWorkInputId: workInputId });
      return this.conversationalResult(instruction, ctx, emptyMemory, effectiveOpts, "conversation", { workId, workInputId, instructionId, plannerAttemptId: attempt.id });
    }

    // Secrets are needed by the existing planner/provider path only. Keeping boot
    // after the deterministic branch makes a fast read independent of Secrets
    // Manager latency or availability.
    let mentionedHousehold: { householdId: string; label: string } | null = null;
    let resolvedHouseholdId: string | undefined;
    let memory: MemorySnapshot;
    try {
      if (opts.conversationContext?.resolution.status !== "clarification_required") await ensureSecretsLoaded();
      await emitInstructionEvent(ctx.tenantId, instructionId, "step_progress", { stage: "resolving_context" });
      const assembled = await assembleOperatingContext(ctx, {
        instruction,
        workId,
        sessionId: opts.sessionId,
        householdId: opts.householdId,
        activeContext: opts.activeContext,
        conversationContext: opts.conversationContext,
        includeMemory: true,
        includeSemanticMemory: plannerMemoryEnabled(),
        includeCanonicalBusinessState: true,
      });
      operatingContext = assembled.context;
      memory = assembled.memory;
      mentionedHousehold = assembled.mentionedHousehold;
      resolvedHouseholdId = assembled.resolvedHouseholdId;
      await transitionWork(ctx.tenantId, workId, "understanding", "context_resolved", {
        householdId: resolvedHouseholdId ?? null,
        mentionedHousehold: mentionedHousehold?.label ?? null,
        operatingContextHealth: operatingContext.health.status,
      }, resolvedHouseholdId && !operatingContext.interactionContext
        ? { activeContext: { householdId: resolvedHouseholdId }, expectedWorkInputId: workInputId }
        : { expectedWorkInputId: workInputId });
      if (resolvedHouseholdId) await attachWorkEntity(ctx.tenantId, workId, {
        entityType: "household",
        entityId: resolvedHouseholdId,
        source: "orchestrator.context_resolved",
      });
    } catch (err) {
      const failure = workFailure(err, "Context retrieval failed");
      await transitionWork(ctx.tenantId, workId, "failed", "understanding_failed", failure, { failure, expectedWorkInputId: workInputId });
      await emitInstructionEvent(ctx.tenantId, instructionId, "failed", { error: failure.message, workId, recoverable: true });
      throw err;
    }
    {
      // Real counts from what handleInstruction actually retrieved before planning —
      // never the memory CONTENTS (this session's own binding rule). shortTerm/
      // longTerm are single facts (present or not, hence count 0|1); episodic/
      // semantic/patterns are real arrays already built above.
      const contextChips = [
        { label: "explicit canvas targets", count: operatingContext?.interactionContext?.selectedEntities.length || (operatingContext?.interactionContext?.focusedEntity ? 1 : 0), source: "interaction:explicit", kind: "CANONICAL", role: "context_only" },
        { label: "explicit exclusions", count: operatingContext?.interactionContext?.excludedEntities.length ?? 0, source: "interaction:exclusions", kind: "CANONICAL", role: "context_only" },
        { label: "bounded cohort reference", count: operatingContext?.interactionContext?.cohort ? 1 : 0, source: "interaction:cohort", kind: "CANONICAL", role: "context_only" },
        { label: "authenticated company profile", count: operatingContext?.tenant.companyName ? 1 : 0, source: "profile:tenant", kind: "PROFILE", role: "context_only" },
        { label: "current Work", count: operatingContext?.activeWork ? 1 : 0, source: "work:active", kind: "WORK", role: "context_only" },
        { label: "canonical business state", count: operatingContext?.canonicalSummaries.length ?? 0, source: "operational:business-state", kind: "CANONICAL", role: "context_only" },
        { label: "prior turns this session", count: memory.shortTerm ? 1 : 0, source: "memory:short-term", kind: "SESSION", role: "context_only" },
        { label: "household history", count: memory.longTerm ? 1 : 0, source: "memory:long-term", kind: "MEMORY", role: "context_only" },
        { label: "related past instructions", count: memory.semantic.length, source: "memory:semantic", kind: "MEMORY", role: "context_only" },
        { label: "recent execution history", count: memory.episodic.length, source: "memory:episodic", kind: "WORK", role: "context_only" },
      ].filter((c) => c.count > 0);
      await emitInstructionEvent(ctx.tenantId, instructionId, "context_retrieved", { chips: contextChips });
      await emitInstructionEvent(ctx.tenantId, instructionId, "planning");
    }
    const plannerAttempt = await beginWorkPlannerAttempt({
      tenantId: ctx.tenantId,
      workId,
      workInputId,
      attemptKey: opts.plannerAttemptKey ?? `input:${workInputId}`,
      ...(operatingContext ? { decisionContext: operatingContext } : {}),
    });
    requireFreshPlannerAttempt(workId, plannerAttempt);
    await transitionWork(ctx.tenantId, workId, "planning", "planning_started", { plannerAttemptId: plannerAttempt.id }, { expectedWorkInputId: workInputId });
    let actions: DomainAction[];
    try {
      actions = await this.planner.plan(instruction, ctx, memory, {
        instructionId,
        workId,
        plannerAttemptId: plannerAttempt.id,
        channel: opts.channel,
        signal: opts.signal,
        deadlineAt: opts.deadlineAt,
        deadlineMs: opts.deadlineMs,
        operatingContext,
      });
    } catch (err) {
      const failure = workFailure(err, "Planning failed");
      await finishWorkPlannerAttempt({ tenantId: ctx.tenantId, attemptId: plannerAttempt.id, status: failure.timeout ? "timed_out" : "failed", failure });
      await transitionWork(ctx.tenantId, workId, "failed", "planning_failed", failure, { failure, expectedWorkInputId: workInputId });
      await emitInstructionEvent(ctx.tenantId, instructionId, "failed", { error: failure.message, workId, recoverable: true });
      throw err;
    }
    if (await isInstructionCancelled(ctx.tenantId, instructionId)) {
      await this.rejectCancelledDrafts(ctx.tenantId, instructionId);
      return { actions: [], workId, workInputId, instructionId };
    }
    const finalRoute = opts.conversationContext?.resolution.status === "clarification_required"
      ? instructionRoute!
      : finalizeInstructionRoute(instructionRoute!, actions);
    if (finalRoute.route === "OBJECTIVE") {
      if (actions.length > 0) {
        await withTenant(ctx.tenantId, async (db) => {
          const rejected = await db.update(domainActions).set({ status: "rejected" }).where(and(
            eq(domainActions.tenantId, ctx.tenantId),
            inArray(domainActions.id, actions.map((action) => action.id)),
            eq(domainActions.status, "draft"),
          )).returning({ id: domainActions.id });
          if (rejected.length > 0) await db.insert(actionLog).values(rejected.map((action) => ({
            tenantId: ctx.tenantId,
            domainActionId: action.id,
            step: "rejected",
            input: { routePolicyVersion: finalRoute.version },
            output: { reason: "Typed plan proved this instruction was not one independent EffectSet; the same Work now owns a persistent Objective." },
          })));
        });
      }
      await finishWorkPlannerAttempt({
        tenantId: ctx.tenantId,
        attemptId: plannerAttempt.id,
        status: "succeeded",
        plannerResult: { route: "OBJECTIVE", reasonCodes: finalRoute.reasonCodes, supersededActionIds: actions.map((action) => action.id) },
      });
      await transitionWork(ctx.tenantId, workId, "planning", "instruction_route_refined", { from: instructionRoute!.route, to: "OBJECTIVE", reasonCodes: finalRoute.reasonCodes }, { executionModel: "objective", expectedWorkInputId: workInputId });
      const started = await this.startObjective(instruction, ctx, {
        channel: opts.channel ?? "console",
        sessionId: opts.sessionId,
        instructionId,
        workId,
        workInputId,
        idempotencyKey: opts.idempotencyKey,
        activeContext: opts.activeContext,
      });
      await emitInstructionEvent(ctx.tenantId, instructionId, "plan_ready", { route: "objective", objectiveLoopId: started.objectiveLoopId, boundedIterations: true });
      return { actions: [], workId, workInputId, instructionId, objective: { objectiveLoopId: started.objectiveLoopId, state: started.state, route: "OBJECTIVE" } };
    }
    if (actions.length === 0) {
      return this.conversationalResult(instruction, ctx, memory, effectiveOpts, "empty_plan_recovery", { workId, workInputId, instructionId, plannerAttemptId: plannerAttempt.id });
    }
    await finishWorkPlannerAttempt({
      tenantId: ctx.tenantId,
      attemptId: plannerAttempt.id,
      status: "succeeded",
      plannerResult: { actionCount: actions.length, actionIds: actions.map((action) => action.id), actionTypes: actions.map((action) => action.actionType) },
    });
    await transitionWork(ctx.tenantId, workId, "ready", "planner_succeeded", { plannerAttemptId: plannerAttempt.id, actionCount: actions.length }, { expectedWorkInputId: workInputId });
    {
      await emitInstructionEvent(ctx.tenantId, instructionId, "plan_ready", { count: actions.length });
      for (const action of actions) {
        await emitInstructionEvent(ctx.tenantId, instructionId, "action_created", {
          actionId: action.id,
          actionType: action.actionType,
        });
        if (action.actionType === "clarification_request") {
          const payload = action.payload as { question?: string; missingFields?: string[]; context?: string };
          await emitInstructionEvent(ctx.tenantId, instructionId, "clarification_required", {
            actionId: action.id,
            question: payload.question ?? null,
            missingFields: payload.missingFields ?? [],
            context: payload.context ?? null,
          });
        }
      }
    }
    await transitionWork(ctx.tenantId, workId, "actionable", "actions_created", { actionIds: actions.map((action) => action.id) }, { expectedWorkInputId: workInputId });
    // Record every planned node before dispatching anything. Dependent nodes stay as
    // durable drafts until their prerequisite actions genuinely complete.
    const turnResults: Array<{
      actionType: string;
      payload: Record<string, unknown>;
      status: string;
      awaitingApproval: boolean;
      resultOutput: Record<string, unknown>;
    }> = [];
    await Promise.all(
      actions.map((action) => appendEpisode(ctx.tenantId, action.id, "planned", { instruction }, { actionType: action.actionType, reasoning: action.reasoning ?? null })),
    );
    const readiness = await Promise.all(actions.map(async (action) => ({ action, ready: await isPlanActionReady(ctx.tenantId, action.id) })));
    await Promise.all(
      readiness.filter(({ ready }) => ready).map(async ({ action: rawAction }) => {
        if (await isInstructionCancelled(ctx.tenantId, instructionId)) {
          await this.rejectCancelledDrafts(ctx.tenantId, instructionId);
          return;
        }
        // Phase 16(e): tag this instruction's correlation id onto the action so the
        // executor's own enqueueJob calls (voice_confirm_request/voice_notify_failure)
        // can thread it through — in-memory only, never a DB column (see DomainAction.correlationId).
        const action: DomainAction = ctx.correlationId ? { ...rawAction, correlationId: ctx.correlationId } : rawAction;
        const policy = await this.loadPolicy(action);
        const readOnlyAnswer = isReadOnlyAnswerAction(action.actionType, undefined, false) && !policy.requiresConfirmation;
        if (instructionId && readOnlyAnswer) {
          await emitInstructionEvent(ctx.tenantId, instructionId, "dispatched", { actionId: action.id, actionType: action.actionType });
          await emitInstructionEvent(ctx.tenantId, instructionId, "executing", { actionId: action.id, actionType: action.actionType });
          await emitInstructionEvent(ctx.tenantId, instructionId, "step_progress", {
            actionId: action.id,
            stage: EXTERNAL_RESEARCH_ACTION_TYPES.has(action.actionType) ? "researching_verified_external_sources" : "querying_grounded_sources",
            sourceKind: EXTERNAL_RESEARCH_ACTION_TYPES.has(action.actionType) ? "WEB" : "CANONICAL",
          });
        }
        const result = await this.executor.execute(action, policy);
        await this.reflectWithRetry(action, policy, result);
        // result.status is "success" even for a merely-GATED action (it succeeded at
        // drafting, not at doing) — awaitingApproval is what actually distinguishes
        // "this really happened, the resulting row/id is real" from "this is still a
        // pending draft with no real resource yet." Conflating the two previously let
        // a follow-up turn treat a pending draft's own id as if it were the id of the
        // thing it would eventually create.
        const awaitingApproval = Boolean(result.output?.gated || result.output?.pendingConfirmation);
        if (instructionId) {
          if (awaitingApproval) {
            await emitInstructionEvent(ctx.tenantId, instructionId, "action_gated", { actionId: action.id });
          } else {
            // Ungated: this action's real execution already happened above, inside
            // this same synchronous call — genuinely reachable from handleInstruction
            // itself (unlike a GATED action's later approve/execute, which happens in
            // a separate request via decide()/runAction(), untouched this phase).
            if (!readOnlyAnswer) await emitInstructionEvent(ctx.tenantId, instructionId, "executing", { actionId: action.id });
            await emitInstructionEvent(ctx.tenantId, instructionId, "verifying", {
              actionId: action.id,
              actionType: action.actionType,
              sourceKind: EXTERNAL_RESEARCH_ACTION_TYPES.has(action.actionType) ? "WEB" : "CANONICAL",
            });
            if (result.status === "success") {
              await emitInstructionEvent(ctx.tenantId, instructionId, "verified", {
                actionId: action.id,
                actionType: action.actionType,
                evidenceCount: Array.isArray(result.output.citations) ? result.output.citations.length : 0,
                sourceKind: EXTERNAL_RESEARCH_ACTION_TYPES.has(action.actionType) ? "WEB" : "CANONICAL",
              });
            }
            await emitInstructionEvent(
              ctx.tenantId,
              instructionId,
              result.status === "success" ? "completed" : "failed",
              result.status === "success" && isReadOnlyAnswerAction(action.actionType, result.expected, awaitingApproval)
                ? createInstructionTraceResultEnvelope(action.id, result.output)
                : { actionId: action.id, ...(result.status !== "success" ? { error: result.error ?? null, errorKind: result.errorKind ?? null } : {}) },
            );
          }
        }
        if (awaitingApproval) {
          // Fire-and-forget async second pass — reviews the action while it already
          // sits in the confirmation gate awaiting a human, so this adds zero latency
          // to the voice/instruction path itself. See critic.ts for why this fires
          // here (LLM-planned, instruction-driven actions) and not from
          // draftKnownAction (deterministic system scans have no instruction to
          // misinterpret — nothing for a critic to check).
          await enqueueJob("critic_review", { tenantId: ctx.tenantId, actionId: action.id }, `critic:${action.id}`, ctx.correlationId).catch(() => undefined);
        }
        turnResults.push({
          actionType: action.actionType,
          payload: action.payload,
          status: result.status,
          awaitingApproval,
          resultOutput: awaitingApproval ? {} : result.output,
        });
      }),
    );
    const planIds = new Set(await Promise.all(actions.map((action) => planIdForAction(ctx.tenantId, action.id))));
    await Promise.all([...planIds].filter((planId): planId is string => Boolean(planId)).map((planId) => this.dispatchReadyPlanActions(ctx.tenantId, planId)));
    // Write this turn back to short-term memory (§10) — without this, every turn in
    // the same call/session started completely blank, so "call them" or "do it for
    // the second one" had nothing to resolve against. TTL'd (30 min), scoped to this
    // session only, never cross-session or cross-tenant.
    if (opts.sessionId && ctx.employeeId) {
      await appendShortTerm(ctx.tenantId, opts.sessionId, {
        instruction,
        actions: turnResults,
        at: new Date().toISOString(),
      }).catch(() => undefined);
    }
    await reconcileWorkStatus(ctx.tenantId, workId);
    return { actions, workId, workInputId, instructionId };
  }

  /**
   * Draft and gate a SINGLE action whose action_type/payload is already known —
   * skips the LLM planner entirely. For system-originated work (scheduled scans,
   * proactive jobs) where there's no free-text instruction to interpret, only a
   * deterministic decision already made by the caller. This is the shared primitive
   * every proactive scan handler uses so each one gets a real rendered summary and
   * (if voice is configured) a real voice_confirm_request job — the same treatment
   * a human-typed instruction gets, not a hand-inserted row that skips the pipeline.
   */
  async draftKnownAction(
    actionType: string,
    payload: Record<string, unknown>,
    tenantId: string,
    opts: {
      source?: string;
      actionId?: string;
      workId?: string;
      instructionId?: string | null;
      initiatedBy?: string | null;
      authorityContext?: Record<string, unknown>;
      objectiveStepId?: string;
    } = {},
  ): Promise<{ action: DomainAction; result: ExecutionResult }> {
    await ensureSecretsLoaded();
    const row = await withTenant(tenantId, async (db) => {
      const [created] = await db.insert(domainActions).values({
        ...(opts.actionId ? { id: opts.actionId } : {}),
        tenantId,
        actionType,
        payload,
        status: "draft",
        workId: opts.workId ?? null,
        instructionId: opts.instructionId ?? null,
        initiatedBy: opts.initiatedBy ?? null,
        authorityContext: opts.authorityContext ?? {},
        objectiveStepId: opts.objectiveStepId ?? null,
      }).onConflictDoNothing().returning();
      if (created) return created;
      const [existing] = opts.objectiveStepId
        ? await db.select().from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.objectiveStepId, opts.objectiveStepId))).limit(1)
        : opts.actionId
          ? await db.select().from(domainActions).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, opts.actionId))).limit(1)
          : [];
      return existing;
    });
    if (!row) throw new Error("draftKnownAction: insert returned no row");
    // PostgreSQL jsonb canonicalizes object key order. Compare semantic JSON so a
    // crash/retry can safely reclaim the same objective step after the executor has
    // read the row back in a different key order.
    if (row.actionType !== actionType || canonicalPayload(row.payload) !== canonicalPayload(payload)) {
      const [boundStep] = row.objectiveStepId
        ? await withTenant(tenantId, (db) => db.select({ decision: workObjectiveSteps.decision }).from(workObjectiveSteps).where(and(eq(workObjectiveSteps.tenantId, tenantId), eq(workObjectiveSteps.id, row.objectiveStepId!))).limit(1))
        : [];
      const immutableDecision = boundStep?.decision && typeof boundStep.decision === "object" && !Array.isArray(boundStep.decision)
        ? boundStep.decision as Record<string, unknown>
        : null;
      const matchesImmutableDecision = immutableDecision?.kind === "action"
        && immutableDecision.actionType === actionType
        && canonicalPayload(immutableDecision.payload) === canonicalPayload(payload);
      if (!matchesImmutableDecision) throw new Error("Objective action idempotency key is already bound to a different typed action");
    }
    const action: DomainAction = {
      id: row.id,
      tenantId: row.tenantId,
      actionType: row.actionType,
      payload: row.payload as Record<string, unknown>,
      policyId: row.policyId, policyVersion: row.policyVersion,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      workId: row.workId,
      plannerAttemptId: row.plannerAttemptId,
      initiatedBy: row.initiatedBy,
      authorityDecisionId: row.authorityDecisionId,
      authorityRevision: row.authorityRevision,
      authorityContext: row.authorityContext as Record<string, unknown>,
      objectiveStepId: row.objectiveStepId,
    };
    if (["pending", "approved", "completed", "rejected", "failed", "needs_human_review", "blocked_integration_unavailable"].includes(row.status)) {
      return {
        action,
        result: row.status === "completed"
          ? { status: "success", output: { idempotent: true, status: row.status } }
          : row.status === "pending" || row.status === "needs_human_review" || row.status === "approved"
            ? { status: "success", output: { idempotent: true, status: row.status, gated: row.status !== "approved", pendingConfirmation: row.status !== "approved" } }
            : { status: "failure", output: { idempotent: true, status: row.status }, error: `Action is ${row.status}` },
      };
    }
    await appendEpisode(tenantId, action.id, "planned", { source: opts.source ?? "system_scan" }, { actionType });
    const policy = await this.loadPolicy(action);
    // Real bug found while building Phase 3's e2e proof test: unlike the LLM-planner
    // path (planner.ts:327, sets policyId at insert time), draftKnownAction — the
    // shared primitive EVERY proactive scan and the Dealer Zero simulator uses — never
    // persisted policyId onto the domain_actions row, even when loadPolicy() resolved a
    // real, versioned policy. openReceiptForFirstClaim (workflow-runtime/src/steps.ts)
    // reads policyId straight off that row, so every system-originated receipt's
    // policyApplied silently came back null — the majority of Dealer Zero's real
    // traffic, not an edge case. version 0 is defaultPolicy()'s sentinel for "no real
    // row exists" (index.ts:58) — only persist a real, stored policy's id, never that.
    if (policy.version && policy.version > 0 && policy.id !== action.policyId) {
      await withTenant(tenantId, (db) => db.update(domainActions).set({ policyId: policy.id, policyVersion: policy.version }).where(eq(domainActions.id, action.id)));
      action.policyId = policy.id;
      action.policyVersion = policy.version;
    }
    const result = await this.executor.execute(action, policy);
    await this.reflectWithRetry(action, policy, result);
    return { action, result };
  }

  async draftObjectiveAction(params: {
    tenantId: string;
    actionType: string;
    payload: Record<string, unknown>;
    workId: string;
    instructionId: string | null;
    initiatedBy: string | null;
    authorityContext: Record<string, unknown>;
    objectiveStepId: string;
    actionId: string;
  }): Promise<{ action: DomainAction; result: ExecutionResult }> {
    return this.draftKnownAction(params.actionType, params.payload, params.tenantId, {
      source: "objective_loop",
      actionId: params.actionId,
      workId: params.workId,
      instructionId: params.instructionId,
      initiatedBy: params.initiatedBy,
      authorityContext: params.authorityContext,
      objectiveStepId: params.objectiveStepId,
    });
  }

  /**
   * Claims an approved action before execution. The conditional status transition is
   * the database concurrency boundary: exactly one caller can turn approved into
   * executing, so duplicate HTTP/webhook deliveries never duplicate a side effect.
   */
  async runAction(actionId: string, tenantId: string, approvedBy?: string): Promise<ExecutionResult> {
    await ensureSecretsLoaded();
    const row = await withTenant(tenantId, async (db) => {
      // Status alone is never approval evidence. decide() writes this immutable
      // episode in the same transaction as its pending→approved transition; requiring
      // it prevents a bare forged SQL status mutation from claiming execution.
      const [approval] = await db
        .select({ id: actionLog.id, output: actionLog.output })
        .from(actionLog)
        .where(and(eq(actionLog.domainActionId, actionId), eq(actionLog.tenantId, tenantId), eq(actionLog.step, "confirmed")))
        .orderBy(desc(actionLog.timestamp))
        .limit(1);
      const [currentBeforeClaim] = await db.select().from(domainActions).where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, tenantId))).limit(1);
      if (currentBeforeClaim && currentBeforeClaim.status !== "completed") {
        try {
          await assertActionNotCancelledTx(db, {
            tenantId,
            instructionId: currentBeforeClaim.instructionId,
            workId: currentBeforeClaim.workId,
          });
        } catch (error) {
          if (error instanceof ActionCancellationConflictError) {
            return { claimed: null, current: currentBeforeClaim, cancelledBoundary: true as const };
          }
          throw error;
        }
      }
      const [effect] = currentBeforeClaim?.businessEffectId
        ? await db.select().from(businessEffects).where(and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, currentBeforeClaim.businessEffectId))).limit(1)
        : [];
      const approvalOutput = approval?.output && typeof approval.output === "object" ? approval.output as Record<string, unknown> : {};
      const requiresEffect = Boolean(currentBeforeClaim && isConsequentialAction(currentBeforeClaim.actionType, currentBeforeClaim.payload as Record<string, unknown>));
      const validApproval = Boolean(approval && (!requiresEffect || (effect && approvalOutput.businessEffectId === effect.id && approvalOutput.authorizedEffectHash === effect.semanticHash)));
      if (validApproval && requiresEffect && currentBeforeClaim?.status === "approved") {
        return { claimed: null, current: currentBeforeClaim, consequentialReady: true as const };
      }
      const [claimed] = validApproval
        ? await db
            .update(domainActions)
            .set({ status: "executing", executionStartedAt: new Date() })
            .where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, tenantId), eq(domainActions.status, "approved")))
            .returning()
        : [];
      if (claimed) return { claimed, current: claimed };
      const [current] = currentBeforeClaim ? [currentBeforeClaim] : await db.select().from(domainActions).where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, tenantId)));
      return { claimed: null, current };
    });
    if (!row.current) return { status: "failure", output: {}, error: "Action not found" };
    if ("cancelledBoundary" in row && row.cancelledBoundary) {
      return { status: "failure", output: { cancelled: true }, error: "Execution refused: the instruction or Work item is cancelled." };
    }
    if ("consequentialReady" in row && row.consequentialReady) {
      const durable = await authorizeActionExecution({
        tenantId,
        actionId,
        approvedBy,
        authorizationSource: "human_approval",
      });
      if (row.current.workId) await reconcileWorkStatus(tenantId, row.current.workId);
      return { status: "success", output: { authorized: true, durable: true, queued: true, durableWorkerExecution: true, ...durable }, expected: { durableWorkerExecution: true } };
    }
    if (!row.claimed) {
      if (row.current.status !== "executing" && row.current.status !== "completed") {
        return {
          status: "failure",
          output: {},
          error: `Action is ${row.current.status}, not approved — the confirmation gate has not cleared.`,
        };
      }
      if (row.current.status === "completed") await resumeObjectiveForAction(tenantId, actionId).catch(() => false);
      return {
        status: "success",
        output: { idempotent: true, status: row.current.status },
      };
    }
    const claimed = row.claimed;
    const freshAuthority = await revalidateActionExecution(tenantId, actionId);
    if (freshAuthority.outcome !== "allowed") {
      await withTenant(tenantId, (db) => db.update(domainActions).set({ status: "needs_human_review", executionStartedAt: null }).where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, tenantId), eq(domainActions.status, "executing"))));
      await appendEpisode(tenantId, actionId, "execution_authority_denied", { priorApprover: approvedBy ?? null }, { decisionId: freshAuthority.id, revision: freshAuthority.authorityRevision, reasonCode: freshAuthority.reasonCode });
      if (claimed.workId) await reconcileWorkStatus(tenantId, claimed.workId);
      await resumeObjectiveForAction(tenantId, actionId).catch(() => false);
      return { status: "failure", output: { authorityDecisionId: freshAuthority.id }, error: `Authority denied before execution: ${freshAuthority.reasonCode}` };
    }
    if (claimed.workId) {
      await transitionWork(tenantId, claimed.workId, "executing", "action_execution_claimed", { actionId: claimed.id });
    }
    const action: DomainAction = {
      id: claimed.id,
      tenantId: claimed.tenantId,
      actionType: claimed.actionType,
      payload: claimed.payload as Record<string, unknown>,
      policyId: claimed.policyId, policyVersion: claimed.policyVersion,
      status: claimed.status,
      createdAt: claimed.createdAt.toISOString(),
      workId: claimed.workId,
      plannerAttemptId: claimed.plannerAttemptId,
      initiatedBy: claimed.initiatedBy,
      authorityDecisionId: claimed.authorityDecisionId,
      authorityRevision: claimed.authorityRevision,
      authorityContext: claimed.authorityContext as Record<string, unknown>,
      objectiveStepId: claimed.objectiveStepId,
      businessEffectId: claimed.businessEffectId,
      approvedBy,
    };
    const policy = await this.loadPolicy(action);
    const result = await this.executor.execute(action, policy);
    await this.reflectWithRetry(action, policy, result);
    await this.dispatchReadyPlanActions(tenantId, row.claimed.planId);
    if (claimed.workId) await reconcileWorkStatus(tenantId, claimed.workId);
    await resumeObjectiveForAction(tenantId, actionId).catch(() => false);
    return result;
  }

  /**
   * B2.T6: a terminal runtime receipt is a new planning input, never an excuse to
   * mutate the old DAG. We claim one repair lineage row atomically, ask the ordinary
   * planner for a revised remainder, then put the resulting roots through the same
   * validation/confirmation executor every other plan uses.
   */
  async repairPlanAfterTerminalFailure(tenantId: string, domainActionId: string, workflowStepId: string): Promise<void> {
    const [sourceAction, receipt] = await withTenant(tenantId, async (db) => {
      const [action] = await db
        .select()
        .from(domainActions)
        .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, domainActionId)));
      const [latestReceipt] = await db
        .select()
        .from(decisionReceipts)
        .where(and(eq(decisionReceipts.tenantId, tenantId), eq(decisionReceipts.workflowStepId, workflowStepId), eq(decisionReceipts.domainActionId, domainActionId)))
        .orderBy(desc(decisionReceipts.createdAt))
        .limit(1);
      return [action, latestReceipt] as const;
    });
    if (!sourceAction?.planId || !receipt) return;
    // Failed step receipts store their terminal classification in `failure`, while
    // successful ones store data in `actualResult`; keep that receipt shape intact
    // when handing it back to the planner.
    const failure = (receipt.failure ?? null) as Record<string, unknown> | null;
    if (failure?.errorKind !== "terminal") return;
    const terminalReceipt = { failure, actualResult: receipt.actualResult ?? null };

    // Unique failed_domain_action_id is the concurrency boundary: duplicate jobs or
    // repeated worker delivery cannot create two competing repair plans.
    const [claim] = await withTenant(tenantId, (db) =>
      db
        .insert(planRepairs)
        .values({
          tenantId,
          workId: sourceAction.workId,
          failedDomainActionId: domainActionId,
          sourcePlanId: sourceAction.planId!,
          terminalReceipt,
          status: "planning",
        })
        .onConflictDoNothing()
        .returning(),
    );
    if (!claim) return;
    if (sourceAction.workId) {
      await transitionWork(tenantId, sourceAction.workId, "recovery", "recovery_started", {
        planRepairId: claim.id,
        failedDomainActionId: domainActionId,
        workflowStepId,
      }, { recovery: { status: "planning", planRepairId: claim.id, failedDomainActionId: domainActionId } });
    }

    let repairPlannerAttemptId: string | null = null;
    try {
      const remainder = await withTenant(tenantId, (db) =>
        db
          .select({ actionType: domainActions.actionType, payload: domainActions.payload, status: domainActions.status, dependsOn: domainActions.dependsOn })
          .from(domainActions)
          .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.planId, sourceAction.planId!), inArray(domainActions.status, ["draft", "pending"]))),
      );
      if (remainder.length === 0) {
        await withTenant(tenantId, (db) => db.update(planRepairs).set({ status: "no_remainder", proposedAt: new Date() }).where(eq(planRepairs.id, claim.id)));
        await appendEpisode(tenantId, domainActionId, "plan_repair", { receipt: terminalReceipt }, { status: "no_remainder", sourcePlanId: sourceAction.planId });
        if (sourceAction.workId) {
          await transitionWork(tenantId, sourceAction.workId, "failed", "recovery_exhausted", {
            planRepairId: claim.id,
            reason: "no_remainder",
          }, { recovery: { status: "no_remainder", planRepairId: claim.id } });
        }
        return;
      }
      const repairInput = {
        kind: "terminal_plan_repair",
        sourcePlanId: sourceAction.planId,
        failedAction: { actionType: sourceAction.actionType, payload: sourceAction.payload },
        terminalReceipt,
        unfinishedRemainder: remainder,
        instruction: "Return only the revised remaining business actions needed after this terminal failure. Do not repeat completed work; preserve dependencies where still required.",
      };
      const instruction = JSON.stringify(repairInput);
      const memory = await buildMemorySnapshot({ tenantId, semanticQuery: plannerMemoryEnabled() ? instruction : undefined });
      if (sourceAction.workId) {
        const input = await latestWorkInput(tenantId, sourceAction.workId);
        if (input) {
          const attempt = await beginWorkPlannerAttempt({
            tenantId,
            workId: sourceAction.workId,
            workInputId: input.id,
            attemptKey: `repair:${claim.id}`,
          });
          requireFreshPlannerAttempt(sourceAction.workId, attempt);
          repairPlannerAttemptId = attempt.id;
        }
      }
      const repaired = await this.planner.plan(instruction, { tenantId, userId: "system:plan-repair", role: "owner" }, memory, {
        instructionId: sourceAction.instructionId ?? undefined,
        workId: sourceAction.workId ?? undefined,
        plannerAttemptId: repairPlannerAttemptId ?? undefined,
      });
      if (repairPlannerAttemptId) {
        await finishWorkPlannerAttempt({
          tenantId,
          attemptId: repairPlannerAttemptId,
          status: "succeeded",
          plannerResult: { route: "recovery", actionCount: repaired.length, actionIds: repaired.map((action) => action.id) },
        });
      }
      const repairPlanId = repaired.length > 0 ? await planIdForAction(tenantId, repaired[0]!.id) : null;
      if (repairPlanId) {
        await withTenant(tenantId, (db) =>
          db.update(domainActions).set({ repairedFromPlanId: sourceAction.planId }).where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.planId, repairPlanId))),
        );
      }
      await withTenant(tenantId, (db) =>
        db.update(planRepairs).set({ repairPlanId, status: repaired.length > 0 ? "proposed" : "no_remainder", proposedAt: new Date() }).where(eq(planRepairs.id, claim.id)),
      );
      await appendEpisode(tenantId, domainActionId, "plan_repair", { receipt: terminalReceipt, unfinishedRemainder: remainder }, { sourcePlanId: sourceAction.planId, repairPlanId, actionIds: repaired.map((action) => action.id) });
      if (repairPlanId) await this.dispatchReadyPlanActions(tenantId, repairPlanId);
      if (sourceAction.workId) {
        await transitionWork(tenantId, sourceAction.workId, "recovery", "recovery_planned", {
          planRepairId: claim.id,
          repairPlanId,
          actionIds: repaired.map((action) => action.id),
        }, { recovery: { status: repaired.length > 0 ? "proposed" : "no_remainder", planRepairId: claim.id, repairPlanId } });
        await reconcileWorkStatus(tenantId, sourceAction.workId);
      }
    } catch (err) {
      await withTenant(tenantId, (db) => db.update(planRepairs).set({ status: "failed" }).where(eq(planRepairs.id, claim.id))).catch(() => undefined);
      if (repairPlannerAttemptId) {
        const plannerFailure = workFailure(err, "Recovery planning failed");
        await finishWorkPlannerAttempt({
          tenantId,
          attemptId: repairPlannerAttemptId,
          status: plannerFailure.timeout ? "timed_out" : "failed",
          failure: plannerFailure,
        }).catch(() => undefined);
      }
      if (sourceAction.workId) {
        const failure = workFailure(err, "Recovery planning failed");
        await transitionWork(tenantId, sourceAction.workId, "failed", "recovery_failed", failure, { failure, recovery: { status: "failed", planRepairId: claim.id } }).catch(() => undefined);
      }
      throw err;
    }
  }

  // Policies change rarely; a short TTL cache removes a DB round trip from every
  // execution without letting edits go stale for more than 30 seconds.
  private policyCache = new Map<string, { at: number; policy: DomainPolicy }>();

  async loadPolicy(action: DomainAction): Promise<DomainPolicy> {
    const cacheKey = `${action.tenantId}:${action.policyId ?? action.actionType}:${action.policyVersion ?? "current"}`;
    const cached = this.policyCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 30_000) return cached.policy;
    const row = await withTenant(action.tenantId, async (db) => {
      // Explicit tenantId filter, not just RLS scoping — defense in depth (a role
      // that owns these tables, as local dev connections typically do, bypasses RLS
      // entirely regardless of FORCE ROW LEVEL SECURITY; without this, an
      // unqualified `.limit(1)` by actionType alone can non-deterministically pick
      // up another tenant's policy row for the same action_type). Same convention
      // scan-low-inventory.ts and friends already follow.
      const [revision] = action.policyId
        ? await db.select().from(domainPolicyRevisions).where(and(eq(domainPolicyRevisions.policyId, action.policyId), eq(domainPolicyRevisions.tenantId, action.tenantId), action.policyVersion ? eq(domainPolicyRevisions.version, action.policyVersion) : lte(domainPolicyRevisions.effectiveFrom, new Date()))).orderBy(desc(domainPolicyRevisions.effectiveFrom), desc(domainPolicyRevisions.version)).limit(1)
        : await db.select().from(domainPolicyRevisions).where(and(eq(domainPolicyRevisions.actionType, action.actionType), eq(domainPolicyRevisions.tenantId, action.tenantId), lte(domainPolicyRevisions.effectiveFrom, new Date()))).orderBy(desc(domainPolicyRevisions.effectiveFrom), desc(domainPolicyRevisions.version)).limit(1);
      return revision;
    });
    const policy: DomainPolicy = !row
      ? defaultPolicy(action.tenantId, action.actionType)
      : {
          // `row` comes from domainPolicyRevisions (queried above for versioned
          // lookups), which has its OWN `id` distinct from the `domain_policies`
          // row it's a revision of — that parent id lives in `row.policyId`.
          // Using `row.id` here wrote a domain_policy_revisions id into
          // domain_actions.policy_id, which foreign-keys to domain_policies(id),
          // so every draftKnownAction call that resolved a real (version > 0)
          // policy failed with "violates foreign key constraint
          // domain_actions_policy_id_fkey" — this broke get_business_overview and
          // every proactive scan.
          id: row.policyId,
          tenantId: row.tenantId,
          actionType: row.actionType,
          policy: row.policy as Record<string, unknown>,
          requiresConfirmation: row.requiresConfirmation,
          confirmationTemplate: row.confirmationTemplate,
          modelProvider: row.modelProvider ?? undefined,
          confirmationTimeoutHours: row.confirmationTimeoutHours ?? undefined,
          version: row.version,
        };
    this.policyCache.set(cacheKey, { at: Date.now(), policy });
    return policy;
  }

  /**
   * Voice/console-shared decision path. The state transition and its audit entry are
   * one transaction; the conditional UPDATE is the single winner under concurrent
   * approvals. decidedBy records the channel ("voice:<callId>" or a user id).
   */
  async decide(
    actionId: string,
    tenantId: string,
    decision: "approve" | "reject" | "escalate",
    decidedBy: string,
    opts?: { role?: string; note?: string | null; reason?: string | null; typedConfirmation?: boolean },
  ): Promise<ExecutionResult> {
    const humanDecision = decision === "approve" || decision === "reject";
    const approverAuthority = humanDecision
      ? await evaluateActionApproval({ tenantId, userId: decidedBy, employeeId: /^[0-9a-f-]{36}$/i.test(decidedBy) ? decidedBy : undefined, role: (opts?.role as Role | undefined) ?? "owner" }, actionId)
      : null;
    if (approverAuthority && approverAuthority.outcome !== "allowed") {
      return { status: "failure", output: { authorityDecisionId: approverAuthority.id }, error: `Authority denied: ${approverAuthority.reasonCode}` };
    }
    if (decision === "approve" && approverAuthority && !(await isFinalApprovalStep(tenantId, actionId))) {
      const advanced = await withTenant(tenantId, async (db) => {
        const [action] = await db
          .select({ instructionId: domainActions.instructionId, workId: domainActions.workId })
          .from(domainActions)
          .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.id, actionId)))
          .limit(1);
        if (!action) return { found: false as const, cancelled: false as const };
        try {
          await assertActionNotCancelledTx(db, {
            tenantId,
            instructionId: action.instructionId,
            workId: action.workId,
          });
        } catch (error) {
          if (error instanceof ActionCancellationConflictError) {
            return { found: true as const, cancelled: true as const };
          }
          throw error;
        }
        await finalizeApprovalAuthorityTx(db, {
          tenantId,
          actionId,
          decision,
          approverId: decidedBy,
          authorityDecisionId: approverAuthority.id,
        });
        return { found: true as const, cancelled: false as const };
      });
      if (!advanced.found) return { status: "failure", output: {}, error: "Action not found" };
      if (advanced.cancelled) {
        return { status: "failure", output: { cancelled: true }, error: "Approval refused: the instruction or Work item is cancelled." };
      }
      await appendEpisode(tenantId, actionId, "approval_chain_advanced", { by: decidedBy, authorityDecisionId: approverAuthority.id }, { awaitingNextApproval: true });
      return { status: "success", output: { awaitingNextApproval: true, authorityDecisionId: approverAuthority.id } };
    }
    if (decision === "approve" && requiresTypedConfirmation((await this.actionTypeForDecision(actionId, tenantId)) ?? "") && opts?.typedConfirmation !== true) {
      return {
        status: "failure",
        output: { requiresTypedConfirmation: true },
        error: "This action requires explicit typed confirmation before it can be approved.",
      };
    }
    // Escalate is non-terminal (pending -> needs_human_review, still awaiting a
    // human): it only ever moves a genuinely still-pending action, never one already
    // under review (that transition is a no-op, handled by the idempotent branch
    // below via the source-status check).
    const fromStatuses = decision === "escalate" ? (["pending"] as const) : (["pending", "needs_human_review"] as const);
    const toStatus = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "needs_human_review";
    const transition = await withTenant(tenantId, async (db) => {
      if (approverAuthority) {
        const [state] = await db.select({ revision: authorityStates.revision }).from(authorityStates).where(eq(authorityStates.tenantId, tenantId)).limit(1);
        if ((state?.revision ?? 1) !== approverAuthority.authorityRevision) return { claimed: null, current: null, staleAuthority: true as const };
      }
      const [before] = await db.select().from(domainActions).where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, tenantId)));
      if (decision !== "reject" && before) {
        try {
          await assertActionNotCancelledTx(db, {
            tenantId,
            instructionId: before.instructionId,
            workId: before.workId,
          });
        } catch (error) {
          if (error instanceof ActionCancellationConflictError) {
            return { claimed: null, current: before, cancelledBoundary: true as const };
          }
          throw error;
        }
      }
      const [effect] = before?.businessEffectId
        ? await db.select().from(businessEffects).where(and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, before.businessEffectId))).limit(1)
        : [];
      if (decision === "approve" && before && isConsequentialAction(before.actionType, before.payload as Record<string, unknown>) && !effect) {
        return { claimed: null, current: before, effectBoundary: true as const };
      }
      const [claimed] = await db
        .update(domainActions)
        .set({ status: toStatus })
        .where(
          and(
            eq(domainActions.id, actionId),
            eq(domainActions.tenantId, tenantId),
            inArray(domainActions.status, [...fromStatuses]),
          ),
        )
        .returning();
      if (!claimed) {
        const [current] = await db.select().from(domainActions).where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, tenantId)));
        return { claimed: null, current };
      }
      const [currentRevision] = decision === "approve" && claimed.policyId
        ? await db.select().from(domainPolicyRevisions).where(and(eq(domainPolicyRevisions.policyId, claimed.policyId), eq(domainPolicyRevisions.tenantId, tenantId), lte(domainPolicyRevisions.effectiveFrom, new Date()))).orderBy(desc(domainPolicyRevisions.effectiveFrom), desc(domainPolicyRevisions.version)).limit(1)
        : [];
      const [draftRevision] = decision === "approve" && before?.policyId && before.policyVersion
        ? await db.select().from(domainPolicyRevisions).where(and(eq(domainPolicyRevisions.policyId, before.policyId), eq(domainPolicyRevisions.version, before.policyVersion))).limit(1)
        : [];
      const policyDrift = draftRevision && currentRevision && draftRevision.version !== currentRevision.version
        ? { draftedVersion: draftRevision.version, approvedVersion: currentRevision.version, changed: {
            policy: JSON.stringify(draftRevision.policy) !== JSON.stringify(currentRevision.policy),
            requiresConfirmation: draftRevision.requiresConfirmation !== currentRevision.requiresConfirmation,
            confirmationTemplate: draftRevision.confirmationTemplate !== currentRevision.confirmationTemplate,
          } }
        : null;
      await db.insert(actionLog).values({
        tenantId,
        domainActionId: actionId,
        step: decision === "approve" ? "confirmed" : decision === "reject" ? "rejected" : "escalated",
        input: {
          by: decidedBy,
          policyVersion: before?.policyVersion ?? null,
          ...(opts?.role ? { role: opts.role } : {}),
          ...(decision === "approve" ? { typedConfirmation: opts?.typedConfirmation === true } : {}),
        },
        output: {
          channel: decidedBy.startsWith("voice:") ? "voice" : "console",
          businessEffectId: effect?.id ?? null,
          intendedEffectHash: effect?.semanticHash ?? null,
          authorizedEffectHash: decision === "approve" ? effect?.semanticHash ?? null : null,
          ...(decision === "approve" ? { note: opts?.note ?? null, policyDrift } : decision === "reject" ? { reason: opts?.reason ?? null } : { note: opts?.note ?? null }),
        },
      });
      if (approverAuthority && humanDecision) {
        await finalizeApprovalAuthorityTx(db, { tenantId, actionId, decision, approverId: decidedBy, authorityDecisionId: approverAuthority.id });
      }
      if (effect) {
        await db.update(businessEffects).set(decision === "approve"
          ? { status: "authorized", authorizedAt: new Date() }
          : decision === "reject"
            ? { status: "cancelled" }
            : { status: "compiled" })
          .where(and(eq(businessEffects.tenantId, tenantId), eq(businessEffects.id, effect.id), eq(businessEffects.status, "compiled")));
      }
      const durableOperation = decision === "approve"
        ? await authorizeBusinessOperationTx(db, {
            tenantId,
            domainActionId: actionId,
            approvedBy: decidedBy,
            authorityDecisionId: approverAuthority?.id,
            authorityRevision: approverAuthority?.authorityRevision,
          })
        : null;
      if (durableOperation) {
        await db.update(domainActions).set({ status: "executing", executionStartedAt: new Date() })
          .where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, tenantId)));
        await db.insert(actionLog).values({
          tenantId,
          domainActionId: actionId,
          step: "operation_authorized",
          input: { by: decidedBy, operationId: durableOperation.id },
          output: { status: durableOperation.status, queued: durableOperation.authorized },
        });
        return { claimed: { ...claimed, status: "executing" as const, executionStartedAt: new Date() }, current: claimed, durableOperation };
      }
      const durableAction = decision === "approve" && effect
        ? await authorizeActionExecutionTx(db, {
            tenantId,
            actionId,
            approvedBy: decidedBy,
            authorityDecisionId: approverAuthority?.id,
            authorityRevision: approverAuthority?.authorityRevision,
            authorizationSource: "human_approval",
          })
        : null;
      if (durableAction) {
        return {
          claimed: { ...claimed, status: "executing" as const, executionStartedAt: new Date() },
          current: claimed,
          durableOperation: null,
          durableAction,
        };
      }
      if (decision === "reject") {
        const [operation] = await db.update(businessOperations).set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date(), finalOutcome: { rejected: true, decidedBy } })
          .where(and(eq(businessOperations.tenantId, tenantId), eq(businessOperations.domainActionId, actionId), eq(businessOperations.status, "awaiting_approval")))
          .returning({ id: businessOperations.id });
        if (operation) {
          await db.update(decisionReceipts).set({ actualResult: { rejected: true }, finalizedAt: new Date() })
            .where(and(eq(decisionReceipts.tenantId, tenantId), eq(decisionReceipts.operationId, operation.id)));
        }
      }
      return { claimed, current: claimed, durableOperation: null, durableAction: null, staleAuthority: false as const };
    });
    if ("staleAuthority" in transition && transition.staleAuthority) {
      return { status: "failure", output: { staleAuthority: true }, error: "Authority changed while the decision was being applied; review the request again." };
    }
    if ("effectBoundary" in transition && transition.effectBoundary) {
      return { status: "failure", output: { effectBoundary: "effect_missing" }, error: "Approval refused: the consequential action has no frozen Business Effect." };
    }
    if ("cancelledBoundary" in transition && transition.cancelledBoundary) {
      return {
        status: "failure",
        output: { cancelled: true },
        error: `${decision === "approve" ? "Approval" : "Escalation"} refused: the instruction or Work item is cancelled.`,
      };
    }
    if (!transition.current) return { status: "failure", output: {}, error: "Action not found" };
    if (!transition.claimed) {
      // For escalate specifically, an action already in needs_human_review is the
      // correct idempotent target state, not an error.
      if (decision === "escalate" && transition.current.status === "needs_human_review") {
        return { status: "success", output: { idempotent: true, status: transition.current.status } };
      }
      return { status: "success", output: { idempotent: true, status: transition.current.status } };
    }
    const row = transition.claimed;
    if (transition.durableOperation) {
      if (row.instructionId) {
        await emitInstructionEvent(tenantId, row.instructionId, "executing", {
          actionId,
          operationId: transition.durableOperation.id,
          durable: true,
        }).catch(() => undefined);
      }
      if (row.workId) await reconcileWorkStatus(tenantId, row.workId);
      await resumeObjectiveForAction(tenantId, actionId).catch(() => false);
      return {
        status: "success",
        output: {
          authorized: true,
          durable: true,
          operationId: transition.durableOperation.id,
          operationStatus: transition.durableOperation.status,
          queued: transition.durableOperation.authorized,
        },
        expected: { durableWorkerExecution: true },
      };
    }
    if ("durableAction" in transition && transition.durableAction) {
      if (row.instructionId) {
        await emitInstructionEvent(tenantId, row.instructionId, "executing", {
          actionId,
          commandId: transition.durableAction.commandId,
          workflowRunId: transition.durableAction.workflowRunId,
          queued: true,
          durable: true,
        }).catch(() => undefined);
      }
      if (row.workId) await reconcileWorkStatus(tenantId, row.workId);
      return {
        status: "success",
        output: {
          authorized: true,
          durable: true,
          queued: true,
          durableWorkerExecution: true,
          ...transition.durableAction,
        },
        expected: { durableWorkerExecution: true },
      };
    }
    if (decision === "reject") {
      // Best-effort: close a paused graph thread so it doesn't dangle waiting for a
      // resume that will never come. Never blocks the reject itself.
      await this.executor.close?.(actionId, tenantId, row.actionType).catch(() => undefined);
      // Rejection is scoped to this action. Emitting the instruction-level
      // `cancelled` phase here used to trip isInstructionCancelled() and could
      // suppress unrelated sibling actions in the same plan.
      if (row.instructionId) await emitInstructionEvent(tenantId, row.instructionId, "failed", {
        actionId,
        status: "rejected",
        rejected: true,
      }).catch(() => undefined);
      if (row.workId) await reconcileWorkStatus(tenantId, row.workId);
      await resumeObjectiveForAction(tenantId, actionId).catch(() => false);
      return { status: "success", output: { rejected: true } };
    }
    if (decision === "escalate") {
      // Stays open for a human, no executor thread to close, nothing to run yet.
      if (row.workId) await reconcileWorkStatus(tenantId, row.workId);
      return { status: "success", output: { escalated: true } };
    }
    if (row.instructionId) await emitInstructionEvent(tenantId, row.instructionId, "executing", { actionId }).catch(() => undefined);
    const result = await this.runAction(actionId, tenantId, decidedBy);
    if (row.instructionId) {
      const phase = result.status === "success" ? "completed" : "failed";
      await emitInstructionEvent(tenantId, row.instructionId, phase, { actionId, status: result.status }).catch(() => undefined);
    }
    if (row.workId) await reconcileWorkStatus(tenantId, row.workId);
    return result;
  }

  private async actionTypeForDecision(actionId: string, tenantId: string): Promise<string | null> {
    const [row] = await withTenant(tenantId, (db) =>
      db
        .select({ actionType: domainActions.actionType })
        .from(domainActions)
        .where(and(eq(domainActions.id, actionId), eq(domainActions.tenantId, tenantId)))
        .limit(1),
    );
    return row?.actionType ?? null;
  }

  /** Reflection loop: retry once on mismatch, escalate after that (§9). */
  private async reflectWithRetry(
    action: DomainAction,
    policy: DomainPolicy,
    result: ExecutionResult,
  ): Promise<void> {
    await recordPredictionDiff(action, result);
    const outcome = await this.reflection.evaluate(action, result);
    if (outcome.decision === "retry") {
      const retryResult = await this.executor.execute(action, policy);
      await this.reflection.evaluate(action, retryResult);
    }
  }

  private async rejectCancelledDrafts(tenantId: string, instructionId: string | undefined): Promise<void> {
    if (!instructionId) return;
    await withTenant(tenantId, async (db) => {
      const rows = await db
        .update(domainActions)
        .set({ status: "rejected" })
        .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.instructionId, instructionId), eq(domainActions.status, "draft")))
        .returning({ id: domainActions.id });
      if (rows.length > 0) {
        await db.insert(actionLog).values(rows.map((row) => ({
          tenantId,
          domainActionId: row.id,
          step: "rejected",
          input: { by: "instruction_cancel", instructionId },
          output: { cancelledBeforeDispatch: true },
        })));
      }
    });
  }

  private async instructionIdForPlan(tenantId: string, planId: string): Promise<string | null> {
    const [row] = await withTenant(tenantId, (db) =>
      db
        .select({ instructionId: domainActions.instructionId })
        .from(domainActions)
        .where(and(eq(domainActions.tenantId, tenantId), eq(domainActions.planId, planId)))
        .limit(1),
    );
    return row?.instructionId ?? null;
  }

  /** Persistent workers call this after a durable action settles. It restores the
   * same plan-DAG continuation the former synchronous runAction path performed,
   * deriving readiness only from canonical terminal action state. */
  async resumePlanForAction(actionId: string, tenantId: string): Promise<boolean> {
    const [action] = await withTenant(tenantId, (db) => db.select({
      planId: domainActions.planId,
      status: domainActions.status,
    }).from(domainActions).where(and(
      eq(domainActions.tenantId, tenantId),
      eq(domainActions.id, actionId),
    )).limit(1));
    if (!action?.planId || action.status !== "completed") return false;
    await this.dispatchReadyPlanActions(tenantId, action.planId);
    return true;
  }

  /** Sends newly-unblocked DAG nodes through the ordinary validation/gate path. */
  private async dispatchReadyPlanActions(tenantId: string, planId: string | null): Promise<void> {
    if (!planId) return;
    // Each pass consumes one topological layer. Pending approvals leave no ready
    // drafts, while auto-approved completions can make the following layer ready.
    for (;;) {
      const instructionId = await this.instructionIdForPlan(tenantId, planId);
      if (await isInstructionCancelled(tenantId, instructionId ?? undefined)) {
        await this.rejectCancelledDrafts(tenantId, instructionId ?? undefined);
        return;
      }
      const ready = await readyPlanActions(tenantId, planId);
      if (ready.length === 0) return;
      await Promise.all(
        ready.map(async (action) => {
          const policy = await this.loadPolicy(action);
          const result = await this.executor.execute(action, policy);
          await this.reflectWithRetry(action, policy, result);
          if (action.workId) await reconcileWorkStatus(tenantId, action.workId);
        }),
      );
    }
  }
}

/** Convenience: resolve the model provider an action's policy asks for. An absent
 * policy pin follows the explicit planning/text route; it never falls through to a
 * legacy provider by accident. */
export function providerForPolicy(policy: DomainPolicy, channel: "voice" | "text" | "console" | "background" = "text") {
  return policy.modelProvider ? resolveProvider(policy.modelProvider) : resolveProviderForPurpose("planning", channel);
}
export * from "./workflow";
export * from "./dealer-zero-replay";
export * from "./training-mode";

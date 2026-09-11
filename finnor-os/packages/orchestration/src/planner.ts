// P6 canonical planner: Work/Input -> GoalSpec -> ConstraintSet -> immutable
// PlanningWorldSnapshot -> CandidatePlan[] -> deterministic PlanCompiler result.
// The model is a proposal source only. This file never inserts DomainAction rows.

import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { z } from "zod";
import {
  OPERATIONAL_QUERY_INTENTS,
  PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS,
  PRIVATE_EQUITY_VERTICAL,
  RetiredVerticalError,
  isRetiredWaterAction,
  type DomainPolicy,
  type MemorySnapshot,
  type ObjectiveSuccessCondition,
  type OperatingContext,
  type TenantContext,
} from "@finnor/shared-types";
import { domainPolicyRevisions, resolveTenantVertical, withTenant } from "@finnor/db";
import {
  buildConstraintSet,
  buildGoalSpec,
  buildPlanningWorldSnapshot,
  CandidatePlanSchema,
  compileAndSelectPlans,
  DEFAULT_PLAN_BUDGETS,
  sha256,
  type CandidateCompilationFacts,
  type CandidatePlan,
  type CandidatePlanNode,
  type ConstraintSet,
  type GoalSpec,
  type GoalTarget,
  type NodeCompilationFacts,
  type PlanBudgets,
  type PlanCompilationResult,
  type PlanningConstraint,
  type PlanningWorldSnapshot,
} from "@finnor/planning";
import { planNodeSemanticHash } from "@finnor/planning";
import { canExerciseAuthority } from "@finnor/authority";
import { redactStructured, redactText, restoreTokens } from "@finnor/security";
import { ACTION_HARDENING_SPEC } from "../../../scripts/release/action-hardening-spec";
import type { LLMChannel, LLMProvider } from "./llm";
import { resolveProviderForPurpose } from "./llm";
import { groundEntitiesWithDb } from "./compiler";
import { validateOperationalQueryRequest } from "./fast-read-lane";
import { authorityResourcesFromPayload, queryAuthorityRequest } from "./authority-runtime";
import { plannerActionTypesForVertical, planningCapabilitiesForVertical, type PluginRegistry } from "./plugin-registry";
import { plannerContinuationInstruction, plannerMemoryContext, plannerShortTermContext } from "./planner-memory";
import { clarificationContinuationAction, enforceExternalResearchRoute, safeReadFallbackForInstruction } from "./read-routing";
import { resolveCompetitorResearch } from "./research-context";
import { applyOperatingInteractionTargets } from "./interaction-targeting";
import { defaultObjectiveSuccessCondition } from "./objective-success";
import { planningHealthForAction } from "./planning-health";

export { clarificationContinuationAction, enforceExternalResearchRoute, safeReadFallbackForInstruction } from "./read-routing";

const CandidateEnvelopeSchema = z.object({ candidates: z.array(z.unknown()).min(1).max(4) }).strict();
const CHANNEL_AWARE_ANSWER_ACTIONS = new Set(["search_web"]);
const UUID_V4_ZERO = "00000000-0000-4000-8000-000000000006";
const MAX_PLANNER_CONTEXT_CHARS = 24_000;

export interface PlanningResult {
  version: 1;
  goal: GoalSpec;
  constraints: ConstraintSet;
  snapshot: PlanningWorldSnapshot;
  /** Raw proposals are retained so schema failures are compiler evidence rather
   * than parser exceptions or silently repaired model output. */
  candidates: unknown[];
  compilation: PlanCompilationResult;
}

export interface Planner {
  plan(
    instruction: string,
    tenantContext: TenantContext,
    memory: MemorySnapshot,
    opts?: PlannerOptions,
  ): Promise<PlanningResult>;
}

export interface PlannerOptions {
  instructionId?: string;
  workId?: string;
  workInputId?: string;
  plannerAttemptId?: string;
  decisionContextHash?: string;
  channel?: LLMChannel;
  signal?: AbortSignal;
  deadlineAt?: number;
  deadlineMs?: number;
  operatingContext?: OperatingContext;
  successCondition?: ObjectiveSuccessCondition;
  goalSpec?: GoalSpec;
  goalTargets?: GoalTarget[];
  explicitNonGoals?: string[];
  planDeadlineAt?: string | null;
  constraints?: ConstraintSet;
  hardConstraints?: PlanningConstraint[];
  planBudgets?: Partial<PlanBudgets>;
  planningSnapshot?: PlanningWorldSnapshot;
  planningContext?: unknown;
  /** Persisted by the adapter; supplied so recovery intent is explicit at the
   * planner boundary without granting the model lineage authority. */
  parentRevisionId?: string;
  /** Recovery creates a new immutable child; the old graph is never edited. */
  priorVerifiedEffectHashes?: string[];
}

export interface CompileCandidatePlansInput {
  candidates: unknown[];
  tenantContext: TenantContext;
  verticalKey: string;
  goal: GoalSpec;
  constraints: ConstraintSet;
  snapshot: PlanningWorldSnapshot;
  operatingContext?: OperatingContext;
  /** Real Work planning must compile against current policy, grounding, authority,
   * and capability state. Unit-only callers may explicitly disable DB facts. */
  useDatabase?: boolean;
}

function boundedPromptValue(value: unknown, maxChars: number): unknown {
  const serialized = JSON.stringify(value);
  if (serialized !== undefined && serialized.length <= maxChars) return value;
  if (maxChars < 16 || value === null || value === undefined) return null;
  if (typeof value === "string") return value.slice(0, Math.max(0, maxChars - 2));
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      const remaining = maxChars - JSON.stringify(result).length - 2;
      if (remaining < 16) break;
      const bounded = boundedPromptValue(item, remaining);
      if (JSON.stringify([...result, bounded]).length > maxChars) break;
      result.push(bounded);
    }
    return result;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const remaining = maxChars - JSON.stringify(result).length - key.length - 6;
    if (remaining < 16) break;
    const bounded = boundedPromptValue(item, remaining);
    if (JSON.stringify({ ...result, [key]: bounded }).length > maxChars) break;
    result[key] = bounded;
  }
  return result;
}

function plannerOperatingContext(context: OperatingContext | undefined): Record<string, unknown> | null {
  if (!context) return null;
  return boundedPromptValue(redactStructured({
    version: context.version,
    truthPrecedence: context.truthPrecedence,
    interactionPrecedence: context.interactionPrecedence,
    interactionContext: context.interactionContext,
    tenant: context.tenant,
    employee: context.employee,
    activeWork: context.activeWork,
    companyDirectory: context.companyDirectory,
    identityAccess: context.identityAccess,
    universalActions: context.universalActions,
    conversationContext: context.conversationContext,
    referencedEntities: context.referencedEntities.slice(0, 24),
    canonicalSummaries: context.canonicalSummaries.slice(0, 16),
    epistemicWarnings: (context.epistemicWarnings ?? []).slice(0, 30),
    integrationHealth: context.integrationHealth,
    authority: context.authority,
    sources: context.sources.slice(0, 20).map(({ kind, source, asOf, role }) => ({ kind, source, asOf, role })),
    health: context.health,
  }), MAX_PLANNER_CONTEXT_CHARS) as Record<string, unknown>;
}

function riskFor(actionType: string): { risk: "low" | "medium" | "high"; irreversible: boolean } {
  const row = ACTION_HARDENING_SPEC.find((item) => item.actionType === actionType);
  if (!row) return { risk: "high", irreversible: true };
  const high = row.external || ["FINANCIAL_WRITE", "EXTERNAL_SPEND", "BATCH_EXTERNAL", "DURABLE_WORKFLOW"].includes(row.profile);
  const medium = ["OPERATIONAL_CHANGE", "INTERNAL_WRITE"].includes(row.profile);
  return {
    risk: high ? "high" : medium ? "medium" : "low",
    irreversible: row.external || ["FINANCIAL_WRITE", "EXTERNAL_SPEND", "BATCH_EXTERNAL"].includes(row.profile),
  };
}

function candidateForAction(
  action: { action_type: string; payload: Record<string, unknown>; reasoning?: string; depends_on?: number[] },
  goal: GoalSpec,
  candidateKey = "deterministic-1",
): CandidatePlan {
  const actionNode: CandidatePlanNode = {
    key: "action_1",
    kind: "action",
    actionType: action.action_type,
    payload: action.payload,
    ...(action.reasoning ? { rationale: action.reasoning } : {}),
    supports: goal.criteria.map((criterion) => criterion.id),
  };
  return {
    version: 1,
    candidateKey,
    nodes: [
      actionNode,
      ...goal.criteria.map((criterion, index): CandidatePlanNode => ({
        key: `check_${index + 1}`,
        kind: "check",
        criterionId: criterion.id,
        dependsOn: [actionNode.key],
      })),
    ],
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sourceHealth(context: OperatingContext | undefined): "complete" | "partial" | "unavailable" {
  if (!context) return "partial";
  if (context.health.status === "complete") return "complete";
  return context.health.errors.length > 0 && context.canonicalSummaries.length === 0 ? "unavailable" : "partial";
}

export class LLMPlanner implements Planner {
  private provider: LLMProvider | undefined;
  private routedProviders = new Map<LLMChannel, LLMProvider>();
  private systemPromptCache = new Map<string, string>();

  constructor(private plugins: PluginRegistry, provider?: LLMProvider) {
    this.provider = provider;
  }

  /** Exposed through the existing test seam. The prompt contains graph contracts,
   * never the retired Action[] wire format. */
  private systemPrompt(verticalKey = "none", allowedActionTypes = this.plugins.actionTypes(), goal?: GoalSpec): string {
    const cacheKey = `${verticalKey}:${allowedActionTypes.join(",")}:${goal?.semanticHash ?? "none"}`;
    const cached = this.systemPromptCache.get(cacheKey);
    if (cached) return cached;
    const doctrine = verticalKey === PRIVATE_EQUITY_VERTICAL
      ? [
          "You are a candidate-plan proposer for one authenticated Private Equity Work item.",
          "Canonical PE truth belongs only to @finnor/private-equity. Never guess a Deal, target, version, blocker, party, or evidence result.",
          "Task is not Request; Document is not Deliverable; Finding is not DealRisk; ready is not verified; Workstream is not Work; provider acknowledgement is not verified external outcome.",
          "Votes, dissents, waivers, committee changes, voting open/close, and final decisions are human-only and forbidden in model proposals even if an approval could be requested.",
        ]
      : [
          "You are a candidate-plan proposer for FINNOR Core without a business vertical.",
          "Do not invent business-domain vocabulary, canonical entities, identifiers, dates, amounts, parties, evidence, or provider outcomes.",
        ];
    const prompt = [
      ...doctrine,
      "You may propose alternatives; you never select, authorize, persist, or execute a plan. A deterministic compiler does all selection and hard-constraint enforcement.",
      "Truth precedence is CANONICAL > durable WORK/effects/receipts > PROFILE > SESSION > MEMORY > WEB. Interaction selection never grants authority.",
      "Use computer_task only when no reliable canonical/native/API capability can complete the task and a governed auth profile is available.",
      "Never invent identifiers. Use only the listed model-proposable action types and exact payload schemas:",
      this.plugins.payloadSpecJson(allowedActionTypes),
      `Accepted completion criteria: ${JSON.stringify(goal?.criteria ?? [])}`,
      "Each candidate is a DAG. Node kinds are query, action, wait, and check. Dependencies name node keys in the same candidate.",
      "Every accepted completion criterion id must have exactly one check node. A claimed action result is never completion proof.",
      "Waits require an exact resource/delegation/task/run/provider correlation or a bounded deadline. Do not repeat a verified irreversible effect from prior state.",
      'Return only JSON: {"candidates":[{"version":1,"candidateKey":"candidate-a","nodes":[{"key":"a1","kind":"action","actionType":"...","payload":{},"supports":["criterion_..."]},{"key":"c1","kind":"check","criterionId":"criterion_...","dependsOn":["a1"]}]}]}. Return 1-4 bounded alternatives.',
    ].join("\n");
    this.systemPromptCache.set(cacheKey, prompt);
    return prompt;
  }

  private goal(instruction: string, opts: PlannerOptions): GoalSpec {
    if (opts.goalSpec) return opts.goalSpec;
    const condition = opts.successCondition ?? defaultObjectiveSuccessCondition(instruction);
    const targets = opts.goalTargets ?? (opts.operatingContext?.referencedEntities ?? []).map((ref): GoalTarget => ({
      kind: "entity",
      type: ref.entityType,
      id: ref.entityId,
      sourceRef: `operating-context:${ref.entityType}:${ref.entityId}`,
    }));
    return buildGoalSpec({
      objective: instruction,
      workId: opts.workId,
      workInputId: opts.workInputId,
      targets,
      deadline: opts.planDeadlineAt,
      explicitNonGoals: opts.explicitNonGoals,
      successCondition: condition as unknown as Record<string, unknown> & { criteria?: unknown[]; source?: unknown },
    });
  }

  private constraints(tenantContext: TenantContext, verticalKey: string, opts: PlannerOptions): ConstraintSet {
    if (opts.constraints) return opts.constraints;
    const manifest = planningCapabilitiesForVertical(this.plugins, verticalKey);
    return buildConstraintSet({
      tenantId: tenantContext.tenantId,
      verticalKey,
      allowedCapabilities: manifest.filter((item) => item.modelProposable).map((item) => item.capability),
      humanOnlyCapabilities: manifest.filter((item) => !item.modelProposable).map((item) => item.capability),
      prohibitedCapabilities: [],
      authorityRevision: opts.operatingContext?.authority.revision ?? tenantContext.authorityRevision ?? null,
      budgets: { ...DEFAULT_PLAN_BUDGETS, ...opts.planBudgets },
      constraints: opts.hardConstraints ?? [],
      deadlineAt: opts.planDeadlineAt ?? null,
      softPreferences: [],
    });
  }

  private async snapshot(tenantContext: TenantContext, verticalKey: string, opts: PlannerOptions): Promise<PlanningWorldSnapshot> {
    if (opts.planningSnapshot) return opts.planningSnapshot;
    const context = opts.operatingContext;
    const manifest = planningCapabilitiesForVertical(this.plugins, verticalKey);
    const policyRows = opts.workId && opts.workInputId && opts.plannerAttemptId
      ? await withTenant(tenantContext.tenantId, (db) => db.select().from(domainPolicyRevisions).where(and(
          eq(domainPolicyRevisions.tenantId, tenantContext.tenantId),
          inArray(domainPolicyRevisions.actionType, manifest.filter((item) => item.kind === "action" && item.available).map((item) => item.capability)),
          lte(domainPolicyRevisions.effectiveFrom, new Date()),
        )).orderBy(desc(domainPolicyRevisions.effectiveFrom), desc(domainPolicyRevisions.version)))
      : [];
    const effectivePolicies = policyRows.filter((row, index, all) => all.findIndex((candidate) => candidate.actionType === row.actionType) === index);
    const contextHash = sha256(context?.interactionContext ?? null);
    const canonicalVersions = (context?.canonicalSummaries ?? []).map((summary) => ({
      sourceRef: `${summary.source}:${summary.name}`,
      versionHash: sha256(summary.data),
    }));
    return buildPlanningWorldSnapshot({
      workId: opts.workId ?? UUID_V4_ZERO,
      workInputId: opts.workInputId ?? UUID_V4_ZERO,
      plannerAttemptId: opts.plannerAttemptId ?? UUID_V4_ZERO,
      tenantId: tenantContext.tenantId,
      verticalKey,
      capturedAt: context?.assembledAt ?? new Date().toISOString(),
      decisionContextHash: opts.decisionContextHash ?? sha256({ interactionContext: context?.interactionContext ?? null }),
      canonicalStateHash: sha256({
        referencedEntities: context?.referencedEntities ?? [],
        canonicalSummaries: context?.canonicalSummaries ?? [],
        epistemicWarnings: context?.epistemicWarnings ?? [],
        integrationHealth: context?.integrationHealth ?? {},
      }),
      work: { id: opts.workId ?? UUID_V4_ZERO, status: context?.activeWork?.status ?? null, inputId: opts.workInputId ?? UUID_V4_ZERO },
      interactionContextRef: context?.interactionContext ? { hash: contextHash, sourceRef: "work_input.context_snapshot" } : null,
      canonicalEntities: (context?.referencedEntities ?? []).map((ref) => ({ kind: "entity", type: ref.entityType, id: ref.entityId, versionHash: null, sourceRef: `operating-context:${ref.entityType}:${ref.entityId}` })),
      canonicalVersions,
      activeObjective: null,
      completedEffects: (opts.priorVerifiedEffectHashes ?? []).map((semanticHash) => ({ semanticHash, irreversible: true, evidenceRef: `plan-node:${semanticHash}` })),
      outstandingEffects: [],
      policyRefs: effectivePolicies.map((row) => ({
        actionType: row.actionType,
        policyId: row.policyId,
        version: row.version,
        semanticHash: sha256({ actionType: row.actionType, policyId: row.policyId, version: row.version, policy: row.policy, requiresConfirmation: row.requiresConfirmation }),
      })),
      evidenceRefs: (context?.sources ?? []).flatMap((source) => source.ref ? [{ type: source.kind, id: source.ref }] : []),
      epistemicWarnings: (context?.epistemicWarnings ?? []).map((warning) => ({ code: warning.status, sourceRef: warning.propositionId })),
      sourceRefs: [
        ...(context?.sources ?? []).map((source) => ({ kind: source.kind, ref: source.ref ?? source.source, asOf: source.asOf })),
        ...Object.entries(context?.integrationHealth ?? {}).map(([capability, health]) => ({
          kind: "integration_health",
          ref: capability,
          asOf: context?.assembledAt ?? null,
          hash: sha256(health),
        })),
      ],
      authority: {
        employeeId: context?.authority.employeeId ?? tenantContext.employeeId ?? null,
        revision: context?.authority.revision ?? tenantContext.authorityRevision ?? null,
        roles: context?.authority.roles ?? tenantContext.authorityRoles ?? [tenantContext.role],
      },
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
      currentEffects: (opts.priorVerifiedEffectHashes ?? []).map((semanticHash) => ({ semanticHash, status: "verified", irreversible: true })),
      sourceHealth: { status: sourceHealth(context), missing: context?.health.missing ?? ["operating_context"] },
    });
  }

  private async policies(tenantId: string, candidates: CandidatePlan[], useDatabase: boolean): Promise<Map<string, DomainPolicy>> {
    const actionTypes = [...new Set(candidates.flatMap((candidate) => candidate.nodes.filter((node): node is Extract<CandidatePlanNode, { kind: "action" }> => node.kind === "action").map((node) => node.actionType)))];
    if (!useDatabase || actionTypes.length === 0) return new Map();
    const rows = await withTenant(tenantId, (db) => db.select().from(domainPolicyRevisions).where(and(
      eq(domainPolicyRevisions.tenantId, tenantId),
      inArray(domainPolicyRevisions.actionType, actionTypes),
      lte(domainPolicyRevisions.effectiveFrom, new Date()),
    )).orderBy(desc(domainPolicyRevisions.effectiveFrom), desc(domainPolicyRevisions.version)));
    return new Map(rows.filter((row, index, all) => all.findIndex((candidate) => candidate.actionType === row.actionType) === index).map((row) => [row.actionType, {
      id: row.policyId,
      tenantId: row.tenantId,
      actionType: row.actionType,
      policy: row.policy as Record<string, unknown>,
      requiresConfirmation: row.requiresConfirmation,
      confirmationTemplate: row.confirmationTemplate,
      modelProvider: row.modelProvider ?? undefined,
      confirmationTimeoutHours: row.confirmationTimeoutHours ?? undefined,
      version: row.version,
    } satisfies DomainPolicy]));
  }

  private fallbackPolicy(tenantId: string, actionType: string): DomainPolicy {
    return { id: "", tenantId, actionType, policy: {}, requiresConfirmation: true, confirmationTemplate: null, version: 0 };
  }

  private async verticalKey(tenantContext: TenantContext, opts: PlannerOptions): Promise<string> {
    const supplied = opts.operatingContext?.tenant.vertical?.verticalKey;
    if (supplied) {
      if (supplied !== "none" && supplied !== PRIVATE_EQUITY_VERTICAL) throw new RetiredVerticalError(supplied);
      return supplied;
    }
    // Unit/injected planners intentionally have no database. Real Work planning
    // always supplies all three persisted ids and therefore resolves the tenant's
    // canonical vertical instead of inferring it from prompt text.
    if (!opts.workId || !opts.workInputId || !opts.plannerAttemptId) return "none";
    return (await resolveTenantVertical(tenantContext.tenantId)).verticalKey;
  }

  private routedProvider(channel: LLMChannel): LLMProvider {
    if (this.provider) return this.provider;
    const cached = this.routedProviders.get(channel);
    if (cached) return cached;
    const provider = resolveProviderForPurpose("planning", channel);
    this.routedProviders.set(channel, provider);
    return provider;
  }

  private normalizeCandidate(
    candidate: unknown,
    tokens: ReadonlyMap<string, string>,
    channel: LLMChannel,
    interactionContext: OperatingContext["interactionContext"] | undefined,
  ): unknown {
    const restored = restoreTokens(candidate, tokens);
    if (!restored || typeof restored !== "object" || Array.isArray(restored)) return restored;
    const row = restored as Record<string, unknown>;
    if (!Array.isArray(row.nodes)) return restored;
    return {
      ...row,
      nodes: row.nodes.map((rawNode) => {
        if (!rawNode || typeof rawNode !== "object" || Array.isArray(rawNode)) return rawNode;
        const node = rawNode as Record<string, unknown>;
        if (node.kind !== "action" || typeof node.actionType !== "string" || !node.payload || typeof node.payload !== "object" || Array.isArray(node.payload)) return node;
        let payload = node.payload as Record<string, unknown>;
        if (CHANNEL_AWARE_ANSWER_ACTIONS.has(node.actionType)) payload = { ...payload, responseChannel: channel };
        const [targeted] = applyOperatingInteractionTargets([{ action_type: node.actionType, payload }], interactionContext);
        return { ...node, payload: targeted?.payload ?? payload };
      }),
    };
  }

  private deterministicCandidate(
    instruction: string,
    planningInstruction: string,
    memory: MemorySnapshot,
    allowedActionTypes: string[],
    goal: GoalSpec,
    opts: PlannerOptions,
  ): CandidatePlan | null {
    if (opts.operatingContext) {
      const research = resolveCompetitorResearch(instruction, opts.operatingContext);
      if (research.route === "clarification" || research.route === "resolved") {
        const action = research.action;
        const [targeted] = applyOperatingInteractionTargets([action], opts.operatingContext.interactionContext);
        return candidateForAction(targeted ?? action, goal, `deterministic-${research.route}`);
      }
    }
    const continuation = clarificationContinuationAction(instruction, planningInstruction, memory, allowedActionTypes);
    if (continuation) return candidateForAction(continuation, goal, "deterministic-continuation");
    // Public/current/source-backed reads have one registered execution path. They
    // do not need a model to choose between capabilities.
    const researchRead = safeReadFallbackForInstruction(planningInstruction, allowedActionTypes);
    if (researchRead) return candidateForAction(researchRead, goal, "deterministic-research");
    return null;
  }

  private async compilationFacts(params: {
    candidates: unknown[];
    tenantContext: TenantContext;
    verticalKey: string;
    snapshot: PlanningWorldSnapshot;
    useDatabase: boolean;
    operatingContext?: OperatingContext;
  }): Promise<CandidateCompilationFacts[]> {
    const parsed = params.candidates.flatMap((candidate) => {
      const result = CandidatePlanSchema.safeParse(candidate);
      return result.success ? [result.data as CandidatePlan] : [];
    });
    const policies = await this.policies(params.tenantContext.tenantId, parsed, params.useDatabase);
    const manifest = new Map(planningCapabilitiesForVertical(this.plugins, params.verticalKey).map((entry) => [entry.capability, entry]));

    const facts: CandidateCompilationFacts[] = [];
    for (const candidate of parsed) {
      const nodes: Record<string, NodeCompilationFacts> = {};
      for (const node of candidate.nodes) {
        if (node.kind === "action") {
          const capability = manifest.get(node.actionType);
          const plugin = this.plugins.resolve(node.actionType);
          const policy = policies.get(node.actionType) ?? this.fallbackPolicy(params.tenantContext.tenantId, node.actionType);
          const schema = plugin?.payloadSchemas?.[node.actionType];
          const schemaResult = schema?.safeParse(node.payload);
          const groundedPayload = schemaResult?.success ? schemaResult.data as Record<string, unknown> : node.payload;
          const validation = plugin?.validate(node.actionType, groundedPayload, policy) ?? { valid: false, errors: [`No plugin is registered for ${node.actionType}`] };
          let grounded = validation.valid;
          let crossTenant = false;
          let stale = false;
          const groundingErrors: string[] = [];
          if (grounded && params.useDatabase) {
            try {
              const fields = await withTenant(params.tenantContext.tenantId, (db) => groundEntitiesWithDb(db, params.tenantContext.tenantId, groundedPayload));
              const rejected = fields.filter((field) => field.status !== "verified");
              grounded = rejected.length === 0;
              groundingErrors.push(...rejected.map((field) => `${field.field}:${field.status}`));
            } catch (error) {
              const message = error instanceof Error ? error.message : "Grounding failed";
              grounded = false;
              crossTenant = /cross[- ]tenant|outside (?:the )?tenant/i.test(message);
              stale = /stale|version|changed since/i.test(message);
              groundingErrors.push(message);
            }
          }
          let predictedReceipt: Record<string, unknown> | undefined;
          if (plugin && validation.valid) {
            try {
              const simulation = await this.plugins.simulate(node.actionType, groundedPayload, policy);
              predictedReceipt = {
                kind: "simulation",
                mode: simulation.mode,
                summary: simulation.summary,
                predicted: simulation.predicted,
              };
            } catch (error) {
              groundingErrors.push(error instanceof Error ? error.message : "Simulation failed");
            }
          }
          const hardening = ACTION_HARDENING_SPEC.find((row) => row.actionType === node.actionType);
          const risk = riskFor(node.actionType);
          let authority: NodeCompilationFacts["authority"] = policy.requiresConfirmation || hardening?.approvalFloor === "REQUIRED" || hardening?.approvalFloor === "TYPED_REQUIRED"
            ? "approval_required"
            : "allowed";
          if (params.useDatabase && authority !== "approval_required") {
            const mayAct = await canExerciseAuthority(params.tenantContext, {
              operation: "action",
              capability: `action:${node.actionType}`,
              resources: authorityResourcesFromPayload(groundedPayload).length > 0
                ? authorityResourcesFromPayload(groundedPayload)
                : (params.operatingContext?.activeWork ? [{ type: "work", id: params.operatingContext.activeWork.id }] : []),
              risk: risk.risk,
              policyRequiresApproval: false,
              workId: params.operatingContext?.activeWork?.id,
            }).catch(() => false);
            if (!mayAct) authority = "denied";
          }
          const snapshotPolicy = params.snapshot.policyRefs.find((ref) => ref.actionType === node.actionType);
          const currentPolicyHash = policy.version > 0 ? sha256({ actionType: policy.actionType, policyId: policy.id, version: policy.version, policy: policy.policy, requiresConfirmation: policy.requiresConfirmation }) : null;
          if ((snapshotPolicy && currentPolicyHash !== snapshotPolicy.semanticHash) || (!snapshotPolicy && policy.version > 0)) stale = true;
          const uncertainPrerequisiteNodeKeys = (node.preconditions ?? [])
            .filter((precondition) => precondition.certainty === "uncertain" && candidate.nodes.some((candidateNode) => candidateNode.key === precondition.ref))
            .map((precondition) => precondition.ref);
          const computerUnavailable = node.actionType === "computer_task" && params.operatingContext?.universalActions?.capabilities.computerExecutable === false;
          const providerHealth = params.useDatabase && validation.valid && grounded
            ? await planningHealthForAction({
                tenantId: params.tenantContext.tenantId,
                actorId: params.tenantContext.employeeId ?? params.tenantContext.userId,
                actionType: node.actionType,
                payload: groundedPayload,
              })
            : null;
          if (providerHealth?.health === "unavailable" && providerHealth.reason) {
            groundingErrors.push(`provider:${providerHealth.reason}`);
          }
          nodes[node.key] = {
            registered: Boolean(plugin && capability?.available),
            schemaValid: validation.valid,
            schemaErrors: [...validation.errors, ...groundingErrors],
            grounded,
            crossTenant,
            stale,
            authority,
            health: computerUnavailable || providerHealth?.health === "unavailable"
              ? "unavailable"
              : capability?.health ?? "unavailable",
            risk: risk.risk,
            irreversible: risk.irreversible,
            wrongVerticalRoot: false,
            policyAllowed: !stale,
            preconditionsSatisfied: (node.preconditions ?? []).every((precondition) => precondition.certainty === "known" || (node.dependsOn ?? []).includes(precondition.ref)),
            deadlineFeasible: true,
            uncertainPrerequisiteNodeKeys,
            supportedRecoveryModes: capability?.supportedRecoveryModes ?? [],
            effectSemanticHash: planNodeSemanticHash(node),
            estimatedCostMicros: null,
            estimatedLatencyMs: null,
            ...(predictedReceipt ? { predictedReceipt } : {}),
            groundedPayload,
          };
          continue;
        }

        if (node.kind === "query") {
          const capabilityKey = `query:${String(node.request.intent ?? "")}`;
          const capability = manifest.get(capabilityKey);
          const validation = validateOperationalQueryRequest(node.request);
          const wrongVertical = validation.success
            && PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS.includes(validation.request.intent as (typeof PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS)[number])
            && params.verticalKey !== PRIVATE_EQUITY_VERTICAL;
          const queryAuthority = params.useDatabase && validation.success && !wrongVertical
            ? await canExerciseAuthority(params.tenantContext, queryAuthorityRequest(validation.request, params.operatingContext?.activeWork?.id)).catch(() => false)
            : validation.success && !wrongVertical;
          nodes[node.key] = {
            registered: Boolean(capability?.available),
            schemaValid: validation.success && !wrongVertical,
            schemaErrors: validation.success ? (wrongVertical ? ["Private Equity query is not available for this tenant vertical"] : []) : [validation.error],
            grounded: validation.success && !wrongVertical,
            crossTenant: false,
            stale: false,
            authority: queryAuthority ? "allowed" : "denied",
            health: capability?.health ?? "unavailable",
            risk: "low",
            irreversible: false,
            wrongVerticalRoot: wrongVertical,
            policyAllowed: true,
            preconditionsSatisfied: true,
            deadlineFeasible: true,
            supportedRecoveryModes: capability?.supportedRecoveryModes ?? [],
            estimatedCostMicros: null,
            estimatedLatencyMs: null,
          };
          continue;
        }

        const capabilityKey = node.kind === "wait" ? "wait:event" : "check:objective_success";
        const capability = manifest.get(capabilityKey);
        nodes[node.key] = {
          registered: Boolean(capability?.available),
          schemaValid: true,
          schemaErrors: [],
          grounded: true,
          crossTenant: false,
          stale: false,
          authority: "allowed",
          health: capability?.health ?? "unavailable",
          risk: capability?.risk ?? "low",
          irreversible: false,
          wrongVerticalRoot: false,
          policyAllowed: true,
          preconditionsSatisfied: true,
          deadlineFeasible: true,
          supportedRecoveryModes: capability?.supportedRecoveryModes ?? [],
          estimatedCostMicros: null,
          estimatedLatencyMs: null,
        };
      }
      facts.push({ candidateKey: candidate.candidateKey, nodes });
    }
    return facts;
  }

  /** Deterministic compiler entry point for non-model proposal sources. This is
   * used by the legacy scripted Objective test seam so even compatibility input
   * has no independent path to selection or execution authority. */
  async compileCandidatePlans(input: CompileCandidatePlansInput): Promise<PlanningResult> {
    const facts = await this.compilationFacts({
      candidates: input.candidates,
      tenantContext: input.tenantContext,
      verticalKey: input.verticalKey,
      snapshot: input.snapshot,
      useDatabase: input.useDatabase ?? true,
      operatingContext: input.operatingContext,
    });
    const compilation = compileAndSelectPlans({
      candidates: input.candidates,
      facts,
      goal: input.goal,
      constraints: input.constraints,
      snapshot: input.snapshot,
    });
    return {
      version: 1,
      goal: input.goal,
      constraints: input.constraints,
      snapshot: input.snapshot,
      candidates: input.candidates,
      compilation,
    };
  }

  async plan(
    instruction: string,
    tenantContext: TenantContext,
    memory: MemorySnapshot,
    opts: PlannerOptions = {},
  ): Promise<PlanningResult> {
    const verticalKey = await this.verticalKey(tenantContext, opts);
    if (isRetiredWaterAction(instruction)) throw new RetiredVerticalError("water");
    const goal = this.goal(instruction, opts);
    const constraints = this.constraints(tenantContext, verticalKey, opts);
    const snapshot = await this.snapshot(tenantContext, verticalKey, opts);
    const allowedActionTypes = plannerActionTypesForVertical(this.plugins, verticalKey);
    const planningInstruction = plannerContinuationInstruction(instruction, memory.shortTerm);
    const deterministic = this.deterministicCandidate(instruction, planningInstruction, memory, allowedActionTypes, goal, opts);
    let candidates: unknown[];

    if (deterministic) {
      candidates = [this.normalizeCandidate(deterministic, new Map(), opts.channel ?? "text", opts.operatingContext?.interactionContext)];
    } else {
      const redacted = redactText(planningInstruction);
      try {
        const raw = await this.routedProvider(opts.channel ?? "text").complete({
          system: this.systemPrompt(verticalKey, allowedActionTypes, goal),
          user: JSON.stringify({
            instruction: redacted.value,
            goal: boundedPromptValue(goal, 12_000),
            constraints: boundedPromptValue(constraints, 12_000),
            snapshot: boundedPromptValue(snapshot, 18_000),
            operatingContext: plannerOperatingContext(opts.operatingContext),
            shortTermContext: plannerShortTermContext(planningInstruction, memory.shortTerm),
            memory: plannerMemoryContext(memory),
            planningContext: boundedPromptValue(redactStructured(opts.planningContext ?? null), 32_000),
          }),
          json: true,
          tenantId: tenantContext.tenantId,
          traceId: tenantContext.correlationId,
          purpose: "planning",
          channel: opts.channel ?? "text",
          signal: opts.signal,
          deadlineAt: opts.deadlineAt,
          deadlineMs: opts.deadlineMs,
        });
        const envelope = CandidateEnvelopeSchema.safeParse(JSON.parse(raw));
        candidates = envelope.success
          ? envelope.data.candidates.map((candidate) => this.normalizeCandidate(candidate, redacted.tokens, opts.channel ?? "text", opts.operatingContext?.interactionContext))
          : [{ version: 0, candidateKey: "provider-envelope-invalid", nodes: [] }];
      } catch (error) {
        const fallback = safeReadFallbackForInstruction(planningInstruction, allowedActionTypes);
        if (!fallback) throw error;
        candidates = [candidateForAction(fallback, goal, "provider-fallback-research")];
      }
    }

    const useDatabase = Boolean(opts.workId && opts.workInputId && opts.plannerAttemptId);
    return this.compileCandidatePlans({
      candidates,
      tenantContext,
      verticalKey,
      goal,
      constraints,
      snapshot,
      useDatabase,
      operatingContext: opts.operatingContext,
    });
  }
}

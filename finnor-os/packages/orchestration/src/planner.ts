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
import { defaultObjectiveSuccessCondition, growthRateLessBps } from "./objective-success";
import { planningHealthForAction } from "./planning-health";
import { parseModelJson } from "./model-json";

export { clarificationContinuationAction, enforceExternalResearchRoute, safeReadFallbackForInstruction } from "./read-routing";

// Providers sometimes add a harmless top-level note even in JSON mode. The
// candidates themselves still pass the full deterministic compiler unchanged.
const CandidateEnvelopeSchema = z.object({ candidates: z.array(z.unknown()).min(1).max(4) }).passthrough();
const CHANNEL_AWARE_ANSWER_ACTIONS = new Set(["search_web"]);
const IC_PREPARATION_PROPOSER_ACTIONS = new Set([
  "create_underwriting_run", "open_ic_case", "begin_ic_preparation", "create_ic_deck_draft", "create_ic_memo_draft",
  "select_ic_memo_version", "select_ic_underwriting_run", "create_ic_question",
  "request_ic_memo_review", "prepare_ic_recommendation", "prepare_ic_decision_proposal",
  "delegate_objective", "clarification_request", "search_web",
]);
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
  /** A prior proposal rejected for the same Work input, objective, and accepted
   * success condition. Feedback guides a new proposal; it grants no authority. */
  proposalFeedback?: { candidates: unknown; violations: unknown };
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
  planningContext?: unknown;
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

/** The compiler receives the complete immutable ConstraintSet. The proposer only
 * needs the decision rules; its system prompt already lists every action schema,
 * and the capability allowlist is repeated inside the hard constraints. */
function plannerConstraintContext(constraints: ConstraintSet): Record<string, unknown> {
  return {
    budgets: constraints.budgets,
    humanOnlyCapabilities: constraints.humanOnlyCapabilities,
    prohibitedCapabilities: constraints.prohibitedCapabilities,
    constraints: constraints.constraints.filter((item) => item.kind !== "capability_allowlist"),
    deadlineAt: constraints.deadlineAt,
    softPreferences: constraints.softPreferences,
  };
}

/** Preserve the canonical refs and effect fences the proposer must reason over,
 * while leaving full capability metadata, hashes, and policy revisions with the
 * deterministic compiler that actually validates every proposed node. */
function plannerSnapshotContext(snapshot: PlanningWorldSnapshot): Record<string, unknown> {
  const dealId = snapshot.canonicalEntities.find((entity) => entity.kind === "entity" && entity.type === "pe_deal")?.id;
  const availableReads = snapshot.capabilities
    .filter((item) => item.kind === "query" && item.available && item.health !== "unavailable")
    .flatMap((item) => {
      const intent = item.capability.startsWith("query:") ? item.capability.slice("query:".length) : item.capability;
      const request = intent === "pe_world_state" && dealId
        ? { intent, root: { entityType: "pe_deal", entityId: dealId } }
        : PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS.some((value) => value === intent) && dealId
          ? { intent, dealId }
          : item.requiredReferences.length === 0 ? { intent } : null;
      if (!request) return [];
      const valid = validateOperationalQueryRequest(request);
      return valid.success ? [{ request: valid.request }] : [];
    });
  return {
    capturedAt: snapshot.capturedAt,
    work: snapshot.work,
    canonicalEntities: snapshot.canonicalEntities,
    canonicalVersions: snapshot.canonicalVersions,
    activeObjective: snapshot.activeObjective,
    completedEffects: snapshot.completedEffects,
    outstandingEffects: snapshot.outstandingEffects,
    evidenceRefs: snapshot.evidenceRefs,
    epistemicWarnings: snapshot.epistemicWarnings,
    sourceRefs: snapshot.sourceRefs,
    sourceHealth: snapshot.sourceHealth,
    authority: snapshot.authority,
    availableReads,
    unavailableCapabilities: snapshot.capabilities
      .filter((item) => !item.available || item.health === "unavailable")
      .map((item) => item.capability),
  };
}

function plannerInspectionContext(inspection: unknown): unknown {
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) return inspection ?? null;
  const state = redactStructured(inspection) as Record<string, unknown>;
  const objective = record(state.objective);
  // A bounded object keeps its first fields. Put the current IC basis and
  // completed actions before large query results so continuation never loses
  // the evidence that an underwriting run or approval already happened.
  return boundedPromptValue({
    privateEquityIcBasis: boundedPromptValue(state.privateEquityIcBasis ?? null, 14_000),
    actions: boundedPromptValue(state.actions ?? [], 3_000),
    businessEffects: boundedPromptValue(state.businessEffects ?? [], 3_000),
    queryExecutions: boundedPromptValue(state.queryExecutions ?? [], 1_500),
    priorIterations: boundedPromptValue(state.priorIterations ?? [], 2_000),
    successVerification: boundedPromptValue(objective.successVerification ?? null, 2_000),
    businessState: boundedPromptValue(state.businessState ?? null, 2_000),
    executionAccess: boundedPromptValue(state.executionAccess ?? null, 1_000),
  }, 24_000);
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

function icGroundingReadCandidate(goal: GoalSpec, snapshot: PlanningWorldSnapshot, planningContext: unknown): CandidatePlan | null {
  if (!goal.criteria.some((criterion) => criterion.criterion.kind === "private_equity_ic_preparation")) return null;
  const inspection = planningContext && typeof planningContext === "object" && !Array.isArray(planningContext)
    ? planningContext as Record<string, unknown> : {};
  const priorIterations = Array.isArray(inspection.priorIterations) ? inspection.priorIterations : [];
  const queryExecutions = Array.isArray(inspection.queryExecutions) ? inspection.queryExecutions.map(record) : [];
  // IC preparation begins with one exact available canonical grounding read.
  // Do not keep reading the same Deal when a previous objective step already
  // used a query; the next failure must remain visible for recovery.
  if (queryExecutions.some((item) => item.intent === "pe_world_state" && item.status === "succeeded")
    || priorIterations.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).decisionKind === "query")) return null;
  const availableReads = plannerSnapshotContext(snapshot).availableReads as Array<{ request: Record<string, unknown> }>;
  const worldRead = availableReads.find((item) => item.request.intent === "pe_world_state");
  if (!worldRead) return null;
  const supports = goal.criteria.filter((criterion) =>
    criterion.criterion.kind === "private_equity_ic_preparation" || criterion.criterion.kind === "decision_evidence",
  ).map((criterion) => criterion.id);
  return {
    version: 1,
    candidateKey: "deterministic-ic-grounding-read",
    nodes: [
      { key: "read_deal_graph", kind: "query", request: worldRead.request, supports },
      ...goal.criteria.map((criterion, index): CandidatePlanNode => ({
        key: `check_${index + 1}`,
        kind: "check",
        criterionId: criterion.id,
        dependsOn: ["read_deal_graph"],
      })),
    ],
  };
}

/** A whole-Deal recheck fans out only over canonical, Deal-bound reads that
 * exist in the live capability snapshot. The three nodes have no dependency
 * edge between them; the check frontier waits for all three observations. */
function parallelDealRecheckCandidate(goal: GoalSpec, snapshot: PlanningWorldSnapshot, planningContext: unknown): CandidatePlan | null {
  if (!/\brecheck\b.{0,120}\bdeal\b.{0,120}\b(?:ic|investment committee)\b/i.test(goal.objective)) return null;
  const basis = record(record(planningContext).privateEquityIcBasis);
  if (typeof basis.dealId !== "string") return null;
  const availableReads = plannerSnapshotContext(snapshot).availableReads as Array<{ request: Record<string, unknown> }>;
  const desired = ["pe_world_state", "open_findings", "open_deal_risks"] as const;
  const reads = desired.map((intent) => availableReads.find((item) => item.request.intent === intent
    && (intent === "pe_world_state" ? record(item.request.root).entityId === basis.dealId : item.request.dealId === basis.dealId)));
  if (reads.some((item) => !item)) return null;
  const keys = ["read_deal_world", "read_findings", "read_risks"] as const;
  const queries: CandidatePlanNode[] = reads.map((item, index) => ({
    key: keys[index]!, kind: "query", request: item!.request,
    supports: goal.criteria.filter((criterion) => criterion.criterion.kind === "canonical_query"
      && record(criterion.criterion.request).intent === desired[index]).map((criterion) => criterion.id),
  }));
  return {
    version: 1, candidateKey: "parallel-canonical-deal-recheck",
    nodes: [
      ...queries,
      ...goal.criteria.map((criterion, index): CandidatePlanNode => ({
        key: `check_${index + 1}`, kind: "check", criterionId: criterion.id, dependsOn: [...keys],
      })),
    ],
  };
}

function icFirstUnderwritingCandidate(goal: GoalSpec, planningContext: unknown, proposals: unknown[]): CandidatePlan | null {
  const icCriterion = goal.criteria.find((item) => item.criterion.kind === "private_equity_ic_preparation" && item.criterion.requireScenario);
  if (!icCriterion || icCriterion.criterion.kind !== "private_equity_ic_preparation") return null;
  const inspection = record(planningContext);
  const basis = record(inspection.privateEquityIcBasis);
  const versions = Array.isArray(basis.modelVersions) ? basis.modelVersions.map(record) : [];
  const investmentCases = Array.isArray(basis.investmentCases) ? basis.investmentCases.map(record) : [];
  const priorActions = Array.isArray(inspection.actions) ? inspection.actions.map(record) : [];
  if (priorActions.some((action) => action.actionType === "create_underwriting_run")) return null;
  for (const proposal of proposals) {
    const parsed = CandidatePlanSchema.safeParse(proposal);
    if (!parsed.success) continue;
    for (const node of parsed.data.nodes) {
      if (node.kind !== "action" || node.actionType !== "create_underwriting_run") continue;
      const payload = record(node.payload);
      if (payload.dealId !== icCriterion.criterion.dealId || !record(payload.scenario).overrides) continue;
      if (!versions.some((version) => version.id === payload.modelVersionId && version.investmentCaseId === payload.investmentCaseId)) continue;
      if (!investmentCases.some((investmentCase) => investmentCase.id === payload.investmentCaseId)) continue;
      return boundedIcUnderwritingCandidate(goal, node.payload, "bounded-ic-underwriting-step");
    }
  }
  return null;
}

function boundedIcUnderwritingCandidate(goal: GoalSpec, payload: Record<string, unknown>, candidateKey: string): CandidatePlan {
  return boundedIcActionCandidate(goal, "create_underwriting_run", payload, candidateKey);
}

function boundedIcActionCandidate(goal: GoalSpec, actionType: string, payload: Record<string, unknown>, candidateKey: string): CandidatePlan {
  const actionKey = actionType === "create_underwriting_run" ? "underwrite_revenue_scenario" : actionType;
  const supports = goal.criteria.filter((item) => item.criterion.kind === "private_equity_ic_preparation" || item.criterion.kind === "private_equity_ic_deck_draft" || item.criterion.kind === "private_equity_underwriting_scenario" || item.criterion.kind === "decision_evidence").map((item) => item.id);
  return {
    version: 1,
    candidateKey,
    nodes: [
      { key: actionKey, kind: "action", actionType, payload, supports },
      ...goal.criteria.map((item, index): CandidatePlanNode => ({
        key: `check_${index + 1}`, kind: "check", criterionId: item.id, dependsOn: [actionKey],
      })),
    ],
  };
}

function icCurrentStateVerificationCandidate(goal: GoalSpec, planningContext: unknown): CandidatePlan | null {
  if (!goal.criteria.some((item) => item.criterion.kind === "private_equity_ic_preparation")) return null;
  const inspection = record(planningContext);
  const basis = record(inspection.privateEquityIcBasis);
  const cases = Array.isArray(basis.icCases) ? basis.icCases.map(record) : [];
  const actions = Array.isArray(inspection.actions) ? inspection.actions.map(record) : [];
  const effects = Array.isArray(inspection.businessEffects) ? inspection.businessEffects.map(record) : [];
  const prior = Array.isArray(inspection.priorIterations) ? inspection.priorIterations.map(record) : [];
  const review = actions.find((item) => item.actionType === "request_ic_memo_review" && item.status === "completed");
  const reviewEffect = effects.find((item) => item.domainActionId === review?.id && item.status === "verified"
    && record(item.verification).state === "verified"
    && record(record(item.effect).expected).observation === "canonical_state"
    && record(record(record(item.effect).expected).state).state === "READY_FOR_REVIEW");
  if (!reviewEffect) return null;
  // A check that omitted an existing review citation may be retried once with
  // that exact evidence. A check that already cited it and failed must await
  // new canonical state; otherwise this would become an endless check-only loop.
  if (prior.some((item) => item.decisionKind === "complete"
    && Array.isArray(record(record(item.observation).successVerification).evidence)
    && (record(record(item.observation).successVerification).evidence as unknown[]).map(record)
      .some((citation) => citation.kind === "business_effect" && citation.businessEffectId === reviewEffect.id))) return null;
  if (!cases.some((item) => item.state === "READY_FOR_REVIEW" && typeof item.currentMemoId === "string"
    && typeof item.currentRecommendationId === "string" && typeof item.primaryUnderwritingRunId === "string")) return null;
  return {
    version: 1,
    candidateKey: "ic-current-state-verification",
    nodes: goal.criteria.map((item, index): CandidatePlanNode => ({
      key: `check_${index + 1}`, kind: "check", criterionId: item.id,
    })),
  };
}

function workOpenedIcCase(planningContext: unknown): { caseRow: Record<string, unknown>; basis: Record<string, unknown>; actions: Record<string, unknown>[]; effects: Record<string, unknown>[] } | null {
  const inspection = record(planningContext);
  const basis = record(inspection.privateEquityIcBasis);
  const actions = Array.isArray(inspection.actions) ? inspection.actions.map(record) : [];
  const opened = actions.find((action) => ["open_ic_case", "select_ic_underwriting_run"].includes(String(action.actionType)) && action.status === "completed");
  const effects = Array.isArray(inspection.businessEffects) ? inspection.businessEffects.map(record) : [];
  const effect = effects.find((item) => item.domainActionId === opened?.id && item.status === "verified");
  const caseId = record(record(effect?.observedResult).entity).entityId;
  const cases = Array.isArray(basis.icCases) ? basis.icCases.map(record) : [];
  const caseRow = cases.find((item) => item.id === caseId && typeof item.version === "number" && item.version > 0);
  return caseRow ? { caseRow, basis, actions, effects } : null;
}

function icMemoDraftCandidate(goal: GoalSpec, planningContext: unknown): CandidatePlan | null {
  if (!goal.criteria.some((item) => item.criterion.kind === "private_equity_ic_preparation")) return null;
  const current = workOpenedIcCase(planningContext);
  if (!current || !["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN"].includes(String(current.caseRow.state)) || typeof current.caseRow.primaryUnderwritingRunId !== "string"
    || current.actions.some((action) => action.actionType === "create_ic_memo_draft")) return null;
  const investments = Array.isArray(current.basis.investmentCases) ? current.basis.investmentCases.map(record) : [];
  const investment = investments.find((item) => item.id === current.caseRow.investmentCaseId);
  if (!investment || typeof investment.title !== "string") return null;
  return boundedIcActionCandidate(goal, "create_ic_memo_draft", {
    dealId: current.basis.dealId, icCaseId: current.caseRow.id,
    expectedCaseVersion: current.caseRow.version,
    title: `${investment.title.slice(0, 450)} IC working memo`,
  }, "grounded-ic-memo-draft");
}

function icMemoSelectionCandidate(goal: GoalSpec, planningContext: unknown): CandidatePlan | null {
  if (!goal.criteria.some((item) => item.criterion.kind === "private_equity_ic_preparation")) return null;
  const current = workOpenedIcCase(planningContext);
  if (!current || !["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN"].includes(String(current.caseRow.state))) return null;
  const priorSelections = current.actions.filter((action) => action.actionType === "select_ic_memo_version");
  // A prior action may have selected the exact memo in PE2 before a downstream
  // Work-graph attachment failed. Permit one fresh, approved re-selection of
  // the same DocumentVersion while preserving the failed action and receipt.
  const recovering = priorSelections.length === 1 && priorSelections[0]?.status === "failed"
    && (current.caseRow.currentMemoId == null || current.caseRow.currentMemoId === priorSelections[0]?.id);
  if (priorSelections.length > 1 || (priorSelections.length === 1 && !recovering)) return null;
  const created = current.actions.find((action) => action.actionType === "create_ic_memo_draft" && action.status === "completed");
  const drafts = Array.isArray(current.basis.generatedMemoDrafts) ? current.basis.generatedMemoDrafts.map(record) : [];
  const draft = drafts.find((item) => item.ic_case_id === current.caseRow.id && item.action_id === created?.id
    && typeof item.document_id === "string" && typeof item.document_version_id === "string");
  if (!draft || typeof current.caseRow.primaryUnderwritingRunId !== "string") return null;
  const parsedCutoff = new Date(String(draft.created_at));
  if (Number.isNaN(parsedCutoff.getTime())) return null;
  const cutoff = parsedCutoff.toISOString();
  return boundedIcActionCandidate(goal, "select_ic_memo_version", {
    dealId: current.basis.dealId, icCaseId: current.caseRow.id,
    expectedCaseVersion: current.caseRow.version, artifactRole: "MEMO",
    documentId: draft.document_id, documentVersionId: draft.document_version_id,
    underwritingRunId: current.caseRow.primaryUnderwritingRunId,
    evidenceCutoffAt: cutoff, sourceCompleteness: "COMPLETE",
    changeClassification: recovering && current.caseRow.currentMemoId ? "NON_MATERIAL" : current.caseRow.currentMemoId ? "MATERIAL" : "INITIAL",
  }, recovering ? "grounded-ic-memo-selection-recovery" : "grounded-ic-memo-selection");
}

function icRecommendationCandidate(goal: GoalSpec, planningContext: unknown): CandidatePlan | null {
  if (!goal.criteria.some((item) => item.criterion.kind === "private_equity_ic_preparation")) return null;
  const current = workOpenedIcCase(planningContext);
  if (!current || !["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN"].includes(String(current.caseRow.state)) || current.caseRow.currentRecommendationId
    || current.actions.some((action) => action.actionType === "prepare_ic_recommendation")) return null;
  const selections = Array.isArray(current.basis.memoSelections) ? current.basis.memoSelections.map(record) : [];
  const selected = selections.find((item) => item.id === current.caseRow.currentMemoId
    && item.ic_case_id === current.caseRow.id && item.source_completeness === "COMPLETE"
    && item.underwriting_run_id === current.caseRow.primaryUnderwritingRunId);
  if (!selected || typeof current.caseRow.primaryUnderwritingRunId !== "string") return null;
  const workSelections = current.actions.filter((action) => action.actionType === "select_ic_memo_version");
  if (workSelections.length > 0 && !workSelections.some((action) => action.id === selected.id && action.status === "completed"
    && current.effects.some((effect) => effect.domainActionId === action.id && effect.status === "verified"))) return null;
  return boundedIcActionCandidate(goal, "prepare_ic_recommendation", {
    dealId: current.basis.dealId, icCaseId: current.caseRow.id,
    expectedCaseVersion: current.caseRow.version, memoId: selected.id,
    underwritingRunId: current.caseRow.primaryUnderwritingRunId,
  }, "grounded-ic-diligence-recommendation");
}

function icReviewCandidate(goal: GoalSpec, planningContext: unknown): CandidatePlan | null {
  if (!goal.criteria.some((item) => item.criterion.kind === "private_equity_ic_preparation")) return null;
  const current = workOpenedIcCase(planningContext);
  if (!current || !["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN"].includes(String(current.caseRow.state)) || typeof current.caseRow.currentRecommendationId !== "string"
    || current.actions.some((action) => action.actionType === "request_ic_memo_review")) return null;
  return boundedIcActionCandidate(goal, "request_ic_memo_review", {
    dealId: current.basis.dealId, icCaseId: current.caseRow.id,
    expectedCaseVersion: current.caseRow.version,
  }, "grounded-ic-review-readiness");
}

function icExistingCaseRunCandidate(goal: GoalSpec, snapshot: PlanningWorldSnapshot, planningContext: unknown): CandidatePlan | null {
  if (!goal.criteria.some((item) => item.criterion.kind === "private_equity_ic_preparation")) return null;
  const inspection = record(planningContext);
  const basis = record(inspection.privateEquityIcBasis);
  const actions = Array.isArray(inspection.actions) ? inspection.actions.map(record) : [];
  if (actions.some((item) => ["open_ic_case", "select_ic_underwriting_run"].includes(String(item.actionType)))) return null;
  const runs = Array.isArray(basis.recentRuns) ? basis.recentRuns.map(record) : [];
  const run = runs.find((item) => item.workId === snapshot.work.id && item.status === "SUCCEEDED"
    && item.validity === "VALID" && typeof item.scenarioId === "string");
  if (!run || typeof run.id !== "string") return null;
  const cases = Array.isArray(basis.icCases) ? basis.icCases.map(record).filter((item) => item.investmentCaseId === run.investmentCaseId
    && !["DECIDED", "WITHDRAWN", "SUPERSEDED"].includes(String(item.state))) : [];
  if (cases.length !== 1) return null;
  const current = cases[0]!;
  if (!["DRAFT", "PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN"].includes(String(current.state))
    || typeof current.id !== "string" || typeof current.version !== "number") return null;
  return boundedIcActionCandidate(goal, "select_ic_underwriting_run", {
    dealId: basis.dealId, icCaseId: current.id, expectedCaseVersion: current.version, underwritingRunId: run.id,
  }, "grounded-existing-ic-run-selection");
}

function icCaseOpeningCandidate(goal: GoalSpec, snapshot: PlanningWorldSnapshot, planningContext: unknown): CandidatePlan | null {
  if (!goal.criteria.some((item) => item.criterion.kind === "private_equity_ic_preparation")) return null;
  const inspection = record(planningContext);
  const basis = record(inspection.privateEquityIcBasis);
  const priorActions = Array.isArray(inspection.actions) ? inspection.actions.map(record) : [];
  if (priorActions.some((action) => action.actionType === "open_ic_case")) return null;
  const runs = Array.isArray(basis.recentRuns) ? basis.recentRuns.map(record) : [];
  const run = runs.find((item) => item.workId === snapshot.work.id && item.status === "SUCCEEDED"
    && item.validity === "VALID" && typeof item.scenarioId === "string");
  if (!run || typeof run.id !== "string" || typeof run.investmentCaseId !== "string") return null;
  const investmentCases = Array.isArray(basis.investmentCases) ? basis.investmentCases.map(record) : [];
  if (!investmentCases.some((item) => item.id === run.investmentCaseId && item.state === "active")) return null;
  const cases = Array.isArray(basis.icCases) ? basis.icCases.map(record).filter((item) => item.investmentCaseId === run.investmentCaseId) : [];
  if (cases.some((item) => !["DECIDED", "SUPERSEDED", "WITHDRAWN"].includes(String(item.state)))) return null;
  const priorDecision = cases.find((item) => item.state === "DECIDED" && typeof item.finalDecisionId === "string");
  const configs = Array.isArray(basis.committeeConfigVersions) ? basis.committeeConfigVersions.map(record) : [];
  const configId = priorDecision?.committeeConfigVersionId ?? (configs.length === 1 ? configs[0]?.id : null);
  if (typeof configId !== "string" || !configs.some((item) => item.id === configId)) return null;
  return boundedIcActionCandidate(goal, "open_ic_case", {
    dealId: basis.dealId,
    investmentCaseId: run.investmentCaseId,
    committeeConfigVersionId: configId,
    primaryUnderwritingRunId: run.id,
    ...(typeof priorDecision?.finalDecisionId === "string" ? { reconsidersDecisionId: priorDecision.finalDecisionId } : {}),
  }, "grounded-ic-case-opening");
}

function icBeginPreparationCandidate(goal: GoalSpec, planningContext: unknown): CandidatePlan | null {
  if (!goal.criteria.some((item) => item.criterion.kind === "private_equity_ic_preparation")) return null;
  const inspection = record(planningContext);
  const priorActions = Array.isArray(inspection.actions) ? inspection.actions.map(record) : [];
  if (priorActions.some((action) => action.actionType === "begin_ic_preparation")) return null;
  const opened = priorActions.find((action) => ["open_ic_case", "select_ic_underwriting_run"].includes(String(action.actionType)) && action.status === "completed");
  if (!opened) return null;
  const effects = Array.isArray(inspection.businessEffects) ? inspection.businessEffects.map(record) : [];
  const effect = effects.find((item) => item.domainActionId === opened.id && item.status === "verified");
  const caseId = record(record(effect?.observedResult).entity).entityId;
  if (typeof caseId !== "string") return null;
  const basis = record(inspection.privateEquityIcBasis);
  const cases = Array.isArray(basis.icCases) ? basis.icCases.map(record) : [];
  const icCase = cases.find((item) => item.id === caseId && item.state === "DRAFT" && typeof item.version === "number" && item.version > 0);
  if (!icCase) return null;
  return boundedIcActionCandidate(goal, "begin_ic_preparation", {
    dealId: basis.dealId, icCaseId: caseId, expectedCaseVersion: icCase.version,
  }, "grounded-ic-preparation-start");
}

function icDeckDraftCandidate(goal: GoalSpec, planningContext: unknown): CandidatePlan | null {
  const criterion = goal.criteria.find((item) => item.criterion.kind === "private_equity_ic_preparation" || item.criterion.kind === "private_equity_ic_deck_draft");
  if (!criterion || (criterion.criterion.kind !== "private_equity_ic_preparation" && criterion.criterion.kind !== "private_equity_ic_deck_draft")
    || !/\b(?:deck|slides|presentation)\b/i.test(goal.objective)) return null;
  const dealId = String(criterion.criterion.dealId ?? "");
  const inspection = record(planningContext);
  const actions = Array.isArray(inspection.actions) ? inspection.actions.map(record) : [];
  if (actions.some((action) => action.actionType === "create_ic_deck_draft")) return criterion.criterion.kind === "private_equity_ic_deck_draft" ? {
    version: 1, candidateKey: "verify-sourced-ic-deck",
    nodes: goal.criteria.map((item, index): CandidatePlanNode => ({ key: `check_${index + 1}`, kind: "check", criterionId: item.id })),
  } : null;
  const basis = record(inspection.privateEquityIcBasis);
  if (basis.dealId !== dealId) return null;
  const cases = Array.isArray(basis.icCases) ? basis.icCases.map(record) : [];
  const preparing = cases.filter((item) => ["PREPARING", "READY_FOR_REVIEW", "QUESTIONS_OPEN", "READY_FOR_VOTE"].includes(String(item.state))
    && typeof item.primaryUnderwritingRunId === "string"
    && typeof item.id === "string" && typeof item.version === "number" && item.version > 0);
  if (preparing.length !== 1) return null;
  const templates = Array.isArray(basis.artifactTemplates) ? basis.artifactTemplates.map(record)
    .filter((item) => item.status === "active" && item.kind === "pptx"
      && typeof item.template_key === "string" && typeof item.version_id === "string") : [];
  if (templates.length !== 1) return null;
  const icCase = preparing[0]!;
  const template = templates[0]!;
  const investmentCases = Array.isArray(basis.investmentCases) ? basis.investmentCases.map(record) : [];
  const investment = investmentCases.find((item) => item.id === icCase.investmentCaseId);
  const caseTitle = typeof investment?.title === "string" ? investment.title.slice(0, 470) : "Investment Case";
  return boundedIcActionCandidate(goal, "create_ic_deck_draft", {
    dealId: basis.dealId,
    icCaseId: icCase.id,
    expectedCaseVersion: icCase.version,
    templateKey: template.template_key,
    templateVersionId: template.version_id,
    title: `${caseTitle} IC deck draft`,
  }, "grounded-ic-deck-draft");
}

function decimalDownside(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const [integer, fractional = ""] = value.split(".");
  const original = BigInt(integer + fractional);
  if (original <= 0n) return null;
  const scaled = (original * 80n).toString().padStart(fractional.length + 3, "0");
  const point = scaled.length - fractional.length - 2;
  return `${scaled.slice(0, point)}.${scaled.slice(point).replace(/0+$/, "")}`.replace(/\.$/, "");
}

/** Exact financial instructions are compiled from a canonical growth-rate base Run,
 * not from a revenue amount or an LLM's interpretation of basis points. */
function exactGrowthScenarioCandidate(goal: GoalSpec, planningContext: unknown): CandidatePlan | null {
  const target = goal.criteria.find((item) => item.criterion.kind === "private_equity_underwriting_scenario");
  if (!target || target.criterion.kind !== "private_equity_underwriting_scenario") return null;
  const criterion = target.criterion;
  const decreaseBps = Number(criterion.growthDecreaseBps);
  const exitMultiple = criterion.exitMultiple;
  if (!Number.isInteger(decreaseBps) || decreaseBps < 1 || decreaseBps > 10_000 || typeof exitMultiple !== "string") return null;
  const inspection = record(planningContext);
  const priorActions = Array.isArray(inspection.actions) ? inspection.actions.map(record) : [];
  if (priorActions.some((action) => action.actionType === "create_underwriting_run")) return {
    version: 1, candidateKey: "verify-exact-growth-scenario",
    nodes: goal.criteria.map((item, index): CandidatePlanNode => ({ key: `check_${index + 1}`, kind: "check", criterionId: item.id })),
  };
  const basis = record(inspection.privateEquityIcBasis);
  if (basis.dealId !== criterion.dealId) return null;
  const investments = Array.isArray(basis.investmentCases) ? basis.investmentCases.map(record) : [];
  const versions = Array.isArray(basis.modelVersions) ? basis.modelVersions.map(record) : [];
  const runs = Array.isArray(basis.recentRuns) ? basis.recentRuns.map(record) : [];
  for (const run of runs) {
    if (typeof run.id !== "string" || run.scenarioId || run.status !== "SUCCEEDED" || run.validity !== "VALID") continue;
    if (!investments.some((item) => item.id === run.investmentCaseId && item.state === "active")) continue;
    const version = versions.find((item) => item.id === run.modelVersionId && item.investmentCaseId === run.investmentCaseId);
    if (!version) continue;
    const inputs = Array.isArray(version.inputNodes) ? version.inputNodes.map(record) : [];
    if (!inputs.some((item) => item.id === "operating.revenue_growth" && item.shape === "series" && item.valueType === "decimal")
      || !inputs.some((item) => item.id === "exit.multiple" && item.shape === "scalar" && item.valueType === "decimal")) continue;
    const growth = record(run.growthInput);
    const exit = record(run.exitMultipleInput);
    if (growth.nodeId !== "operating.revenue_growth" || growth.status !== "KNOWN" || exit.nodeId !== "exit.multiple" || exit.status !== "KNOWN") continue;
    const rates = record(growth.value);
    if (Object.keys(rates).length === 0 || Object.keys(rates).length > 240 || typeof exit.value !== "string") continue;
    const stressed = Object.fromEntries(Object.entries(rates).map(([period, value]) => [period, growthRateLessBps(value, decreaseBps)]));
    if (Object.values(stressed).some((value) => value === null)) continue;
    return boundedIcUnderwritingCandidate(goal, {
      dealId: criterion.dealId,
      investmentCaseId: run.investmentCaseId,
      modelVersionId: run.modelVersionId,
      baseRunId: run.id,
      scenario: {
        name: `Revenue growth down ${decreaseBps}bps; exit ${exitMultiple}x`,
        overrides: [
          { nodeId: "operating.revenue_growth", value: stressed, reason: `Exact ${decreaseBps} basis-point decrease from each recorded base growth rate; exploratory scenario, not a reported forecast.` },
          { nodeId: "exit.multiple", value: exitMultiple, reason: `Requested ${exitMultiple}x exit multiple in the same scenario.` },
        ],
      },
    }, "exact-growth-bps-and-exit-scenario");
  }
  return null;
}

function icRevenueSensitivityCandidate(goal: GoalSpec, planningContext: unknown): CandidatePlan | null {
  const criterion = goal.criteria.find((item) => item.criterion.kind === "private_equity_ic_preparation" && item.criterion.requireScenario);
  if (!criterion || criterion.criterion.kind !== "private_equity_ic_preparation") return null;
  const inspection = record(planningContext);
  const priorIterations = Array.isArray(inspection.priorIterations) ? inspection.priorIterations.map(record) : [];
  const queryExecutions = Array.isArray(inspection.queryExecutions) ? inspection.queryExecutions.map(record) : [];
  if (!queryExecutions.some((item) => item.intent === "pe_world_state" && item.status === "succeeded")
    && !priorIterations.some((item) => item.decisionKind === "query")) return null;
  const priorActions = Array.isArray(inspection.actions) ? inspection.actions.map(record) : [];
  if (priorActions.some((action) => action.actionType === "create_underwriting_run")) return null;
  const basis = record(inspection.privateEquityIcBasis);
  if (basis.dealId !== criterion.criterion.dealId) return null;
  const activeCases = Array.isArray(basis.investmentCases) ? basis.investmentCases.map(record).filter((item) => item.state === "active") : [];
  const modelVersions = Array.isArray(basis.modelVersions) ? basis.modelVersions.map(record) : [];
  const runs = Array.isArray(basis.recentRuns) ? basis.recentRuns.map(record) : [];
  for (const run of runs) {
    if (typeof run.id !== "string" || run.scenarioId || run.status !== "SUCCEEDED" || run.validity !== "VALID") continue;
    if (!activeCases.some((item) => item.id === run.investmentCaseId)) continue;
    const version = modelVersions.find((item) => item.id === run.modelVersionId && item.investmentCaseId === run.investmentCaseId);
    if (!version) continue;
    const inputs = Array.isArray(version.inputNodes) ? version.inputNodes.map(record) : [];
    if (!inputs.some((item) => item.id === "operating.revenue_explicit" && item.shape === "series")) continue;
    const revenue = record(run.revenueInput);
    if (revenue.nodeId !== "operating.revenue_explicit" || revenue.status !== "KNOWN") continue;
    const values = record(revenue.value);
    if (Object.keys(values).length === 0 || Object.keys(values).length > 240) continue;
    const downside = Object.fromEntries(Object.entries(values).map(([period, value]) => [period, decimalDownside(value)]));
    if (Object.values(downside).some((value) => value === null)) continue;
    return boundedIcUnderwritingCandidate(goal, {
      dealId: criterion.criterion.dealId,
      investmentCaseId: run.investmentCaseId,
      modelVersionId: run.modelVersionId,
      baseRunId: run.id,
      scenario: {
        name: "Revenue downside 20% sensitivity (exploratory)",
        overrides: [{
          nodeId: "operating.revenue_explicit",
          value: downside,
          reason: "Exploratory 20% reduction to the persisted base revenue series for this Work; this is a sensitivity, not a sourced forecast.",
        }],
      },
    }, "deterministic-ic-revenue-sensitivity");
  }
  return null;
}

function icPinnedBaseRun(planningContext: unknown, payload: Record<string, unknown>): string | null {
  if (!record(payload.scenario).overrides || payload.baseRunId) return null;
  const basis = record(record(planningContext).privateEquityIcBasis);
  if (basis.dealId !== payload.dealId) return null;
  const runs = Array.isArray(basis.recentRuns) ? basis.recentRuns.map(record) : [];
  const base = runs.find((run) => typeof run.id === "string" && !run.scenarioId
    && run.status === "SUCCEEDED" && run.validity === "VALID"
    && run.investmentCaseId === payload.investmentCaseId && run.modelVersionId === payload.modelVersionId);
  return typeof base?.id === "string" ? base.id : null;
}

function icScenarioInputErrors(planningContext: unknown, payload: Record<string, unknown>): string[] {
  const scenario = record(payload.scenario);
  if (!Array.isArray(scenario.overrides)) return [];
  const basis = record(record(planningContext).privateEquityIcBasis);
  if (basis.dealId !== payload.dealId) return [];
  const versions = Array.isArray(basis.modelVersions) ? basis.modelVersions.map(record) : [];
  const version = versions.find((item) => item.id === payload.modelVersionId && item.investmentCaseId === payload.investmentCaseId);
  if (!version) return [];
  const runs = Array.isArray(basis.recentRuns) ? basis.recentRuns.map(record) : [];
  const base = runs.find((run) => run.id === payload.baseRunId && run.modelVersionId === payload.modelVersionId
    && run.investmentCaseId === payload.investmentCaseId && !run.scenarioId
    && run.status === "SUCCEEDED" && run.validity === "VALID");
  const errors: string[] = [];
  if (!base) errors.push("scenario requires an exact valid pinned base Run from current IC inspection");
  const inputs = Array.isArray(version.inputNodes) ? version.inputNodes.map(record) : [];
  const exactDecimal = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
  for (const item of scenario.overrides) {
    const override = record(item);
    const input = inputs.find((node) => node.id === override.nodeId);
    if (!input) {
      errors.push(`scenario target ${String(override.nodeId)} is absent from the pinned model inputs`);
      continue;
    }
    if (input.valueType !== "decimal") continue;
    if (input.shape === "series") {
      const values = record(override.value);
      if (Object.keys(values).length === 0 || Object.values(values).some((value) => typeof value !== "string" || !exactDecimal.test(value))) {
        errors.push(`scenario ${String(override.nodeId)} must contain exact decimal strings for each period`);
      }
      if ((override.nodeId === "operating.revenue_explicit" || override.nodeId === "operating.revenue_growth") && base) {
        const known = record(record(override.nodeId === "operating.revenue_growth" ? base.growthInput : base.revenueInput).value);
        if (Object.keys(values).some((period) => !(period in known))) errors.push("revenue scenario contains a period absent from the pinned base Run");
      }
    } else if (typeof override.value !== "string" || !exactDecimal.test(override.value)) {
      errors.push(`scenario ${String(override.nodeId)} must be one exact decimal string`);
    }
  }
  return errors;
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
          "For IC preparation, inspect the exact Deal, Investment Case, model version, and IC case before proposing their mutations. A Deal ID alone cannot create an IC case or an underwriting run. If the next needed ID is absent, propose a native canonical read and replan after its recorded result.",
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
      `Required completion check mapping for EVERY candidate: ${JSON.stringify((goal?.criteria ?? []).map((criterion, index) => ({ key: `check_${index + 1}`, kind: "check", criterionId: criterion.id })))}`,
      "Each candidate is a DAG. Node kinds are query, action, wait, and check. Dependencies name node keys in the same candidate.",
      "Every material query, action, or wait node must declare supports: an array of the exact criterion ids it can materially advance. Every accepted completion criterion id must have exactly one check node, causally downstream of every node that supports it. A claimed action result is never completion proof.",
      "A candidate may cover just the next bounded step; the system observes that step and replans. For every candidate, include ALL required check nodes from the mapping, each with dependsOn naming every material node that supports its criterion. Do not omit a check because its criterion is not yet true; the runtime checks current truth after the step.",
      "The no_open_execution and all_objective_effects_verified criteria are observational guards: include their check nodes, but material nodes need not claim to support them. A canonical query supplies decision_evidence only when its exact result can be cited; list that criterion id in its supports and make its check depend on the query.",
      "If a required IC or model identifier is missing, make candidate 1 a native read-only query plan with no actions, using a request from snapshot.availableReads. Put any later mutation in a separate candidate only when every required identifier and input is grounded. Do not create a task as a substitute for underwriting, memo drafting, or IC preparation.",
      "When IC preparation has requireScenario:true, a create_underwriting_run step needs a new inline scenario with a real revenue input node from planningContext.privateEquityIcBasis. Pin baseRunId to the exact SUCCEEDED/VALID canonical base Run in that inspection so all non-overridden model inputs remain known. Derive the stressed value from that Run and label it as an exploratory downside hypothesis, not a reported fact. If no stress percentage was requested, use a clearly labeled 20% downside sensitivity. Propose that single bounded action followed by all required check nodes. Never add a later action that needs an ID this step will create.",
      "For an operational query, copy one exact request object from snapshot.availableReads. request.intent is the bare intent, never a query: capability name; do not put requiredReferences in a request. Deal queries require a grounded Deal UUID; pe_world_state requires a valid root object. Never copy explanatory text or a schema placeholder into an ID field.",
      "Use native canonical reads and typed domain capabilities for the requested work. A web result cannot substitute for a Deal record or underwriting run. Do not propose a message to a recipient unless the exact party identity and permitted channel are grounded in the supplied context.",
      "Do not add send_message, place_call, or clarification_request to an analysis task unless the instruction actually requires contact or a specific missing input must be requested. An empty missingFields array is invalid. For recipient and workRef objects, use the exact nested field names in the payload schema, not generic kind/type/id references.",
      "search_web and clarification_request are action types, not node kinds or operational query intents. Node kind must be exactly query, action, wait, or check.",
      "If priorRejectedProposal is present, correct every listed compiler violation. Do not reuse an invalid candidate, guessed identifier, or unsupported completion claim.",
      "Omit optional action payload fields when they have no value. JSON null is not a valid substitute for an absent optional ID, Scenario, reference, or timestamp.",
      "Waits require an exact resource/delegation/task/run/provider correlation or a bounded deadline. Do not repeat a verified irreversible effect from prior state.",
      "Never invent an ID for an entity that a proposed node has not actually created. If an action needs a future output ID, stop the plan at a canonical read or earlier action and replan after its persisted result is inspected.",
      'Return only a JSON object with a candidates array of 1-4 bounded alternatives. Each candidate has version 1, a candidateKey string, and a nodes array. Each node has a unique key and may have dependsOn containing earlier node keys. A query node has kind "query", request, and supports; an action node has kind "action", actionType, payload, and supports; a wait node has kind "wait", waitFor or deadlineAt, and supports; a check node has kind "check", criterionId, and dependsOn. Include one check node for every exact listed criterion id. Do not include placeholder identifiers or payload fields not present in the exact schema.',
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
    planningContext?: unknown,
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
        const [targeted] = applyOperatingInteractionTargets([{ action_type: node.actionType, payload }], interactionContext, this.plugins.payloadFieldNames(node.actionType));
        payload = targeted?.payload ?? payload;
        const schema = this.plugins.resolve(node.actionType)?.payloadSchemas?.[node.actionType];
        if (schema && !schema.safeParse(payload).success) {
          const withoutAbsentOptionals = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== null));
          // This only treats top-level JSON null as omission when the exact
          // registered schema proves the resulting payload valid. Required
          // nulls and every other malformed value still reach the compiler.
          if (schema.safeParse(withoutAbsentOptionals).success) payload = withoutAbsentOptionals;
        }
        if (node.actionType === "create_underwriting_run" && !payload.baseRunId) {
          const baseRunId = icPinnedBaseRun(planningContext, payload);
          if (baseRunId) payload = { ...payload, baseRunId };
        }
        return { ...node, payload };
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
    const request = /^ask\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*){0,2})\s+for\s+([^\n]+?)[.!]?$/iu.exec(instruction.trim());
    if (request && allowedActionTypes.includes("send_message") && opts.operatingContext) {
      const context = opts.operatingContext;
      const parties = context.companyDirectory.referencedParties.filter((party) => party.status === "active"
        && party.displayName.toLocaleLowerCase() === request[1]!.toLocaleLowerCase());
      const party = parties.length === 1 ? parties[0] : null;
      const emailAllowed = context.universalActions?.capabilities.allowedChannels.includes("email") === true;
      if (party && emailAllowed) {
        const criteria = goal.criteria.map((item) => item.id);
        const prior = record(opts.planningContext).actions;
        const alreadyPrepared = Array.isArray(prior) && prior.map(record).some((action) => action.actionType === "send_message");
        const nodes: CandidatePlanNode[] = [{ key: "recipient_read", kind: "query", request: { intent: "party_lookup", ref: party.ref }, supports: criteria }];
        if (!alreadyPrepared) nodes.push({ key: "request_message", kind: "action", actionType: "send_message",
          payload: { recipient: party.ref, channel: "email", subject: `Request for ${request[2]!.trim()}`.slice(0, 300),
            body: `Hi ${party.displayName}, please share ${request[2]!.trim()}.`, ...(opts.workId ? { workRef: { workId: opts.workId } } : {}) },
          dependsOn: ["recipient_read"], supports: criteria });
        const dependencies = nodes.map((node) => node.key);
        nodes.push(...goal.criteria.map((item, index): CandidatePlanNode => ({ key: `check_${index + 1}`, kind: "check", criterionId: item.id, dependsOn: dependencies })));
        return { version: 1, candidateKey: alreadyPrepared ? "inspect-governed-communication" : "prepare-grounded-information-request", nodes };
      }
    }
    if (opts.operatingContext) {
      const research = resolveCompetitorResearch(instruction, opts.operatingContext);
      if (research.route === "clarification" || research.route === "resolved") {
        const action = research.action;
        const [targeted] = applyOperatingInteractionTargets([action], opts.operatingContext.interactionContext, this.plugins.payloadFieldNames(action.action_type));
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
    planningContext?: unknown;
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
          const scenarioErrors = node.actionType === "create_underwriting_run"
            ? icScenarioInputErrors(params.planningContext, groundedPayload) : [];
          let grounded = validation.valid && scenarioErrors.length === 0;
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
            schemaValid: validation.valid && scenarioErrors.length === 0,
            schemaErrors: [...validation.errors, ...scenarioErrors, ...groundingErrors],
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
      planningContext: input.planningContext,
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
    const allActionTypes = plannerActionTypesForVertical(this.plugins, verticalKey);
    // An IC objective has a typed capability path. Keep the proposer focused on
    // that path so a long unrelated action catalog cannot crowd out its exact
    // payload fields or completion checks. The compiler still enforces the
    // immutable full capability and policy snapshot.
    const allowedActionTypes = goal.criteria.some((criterion) => criterion.criterion.kind === "private_equity_ic_preparation")
      ? allActionTypes.filter((actionType) => IC_PREPARATION_PROPOSER_ACTIONS.has(actionType))
      : allActionTypes;
    const planningInstruction = plannerContinuationInstruction(instruction, memory.shortTerm);
    const deterministic = exactGrowthScenarioCandidate(goal, opts.planningContext)
      ?? parallelDealRecheckCandidate(goal, snapshot, opts.planningContext)
      ?? icBeginPreparationCandidate(goal, opts.planningContext)
      ?? icDeckDraftCandidate(goal, opts.planningContext)
      ?? icMemoDraftCandidate(goal, opts.planningContext)
      ?? icMemoSelectionCandidate(goal, opts.planningContext)
      ?? icRecommendationCandidate(goal, opts.planningContext)
      ?? icReviewCandidate(goal, opts.planningContext)
      ?? icCurrentStateVerificationCandidate(goal, opts.planningContext)
      ?? icExistingCaseRunCandidate(goal, snapshot, opts.planningContext)
      ?? icCaseOpeningCandidate(goal, snapshot, opts.planningContext)
      ?? icRevenueSensitivityCandidate(goal, opts.planningContext)
      ?? icGroundingReadCandidate(goal, snapshot, opts.planningContext)
      ?? this.deterministicCandidate(instruction, planningInstruction, memory, allowedActionTypes, goal, opts);
    if (!deterministic && goal.criteria.some((criterion) => criterion.criterion.kind === "private_equity_underwriting_scenario")) {
      throw new Error("EXACT_GROWTH_BASE_UNAVAILABLE: no valid canonical base Run with recorded growth-rate and exit-multiple inputs is available for the selected Deal");
    }
    const prior = record(opts.planningContext).priorIterations;
    if (!deterministic && goal.criteria.some((item) => item.criterion.kind === "private_equity_ic_preparation")
      && Array.isArray(prior) && prior.map(record).some((item) => item.decisionKind === "complete" && item.outcome !== "completed")) {
      throw new Error("IC_PREPARATION_VERIFICATION_UNMET: the exact success check already failed; do not repeat a check-only plan without new canonical evidence");
    }
    let candidates: unknown[];

    if (deterministic) {
      candidates = [this.normalizeCandidate(deterministic, new Map(), opts.channel ?? "text", opts.operatingContext?.interactionContext, opts.planningContext)];
    } else {
      const redacted = redactText(planningInstruction);
      try {
        const raw = await this.routedProvider(opts.channel ?? "text").complete({
          system: this.systemPrompt(verticalKey, allowedActionTypes, goal),
          user: JSON.stringify({
            instruction: redacted.value,
            goal: boundedPromptValue(goal, 12_000),
            constraints: plannerConstraintContext(constraints),
            snapshot: plannerSnapshotContext(snapshot),
            operatingContext: plannerOperatingContext(opts.operatingContext),
            shortTermContext: plannerShortTermContext(planningInstruction, memory.shortTerm),
            memory: plannerMemoryContext(memory),
            planningContext: plannerInspectionContext(opts.planningContext),
            priorRejectedProposal: opts.proposalFeedback
              ? boundedPromptValue(redactStructured(opts.proposalFeedback), 12_000) : null,
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
        const parsed = parseModelJson(raw);
        const envelope = CandidateEnvelopeSchema.safeParse(parsed);
        candidates = envelope.success
          ? envelope.data.candidates.map((candidate) => this.normalizeCandidate(candidate, redacted.tokens, opts.channel ?? "text", opts.operatingContext?.interactionContext, opts.planningContext))
          // Preserve a bounded invalid proposal as compiler evidence. Replacing
          // it with a synthetic empty plan hid the actual provider defect from
          // both durable retry feedback and the Work failure record.
          : [boundedPromptValue(redactStructured(parsed), 12_000)];
      } catch (error) {
        const groundedIcStep = icRevenueSensitivityCandidate(goal, opts.planningContext)
          ?? icGroundingReadCandidate(goal, snapshot, opts.planningContext);
        if (groundedIcStep) {
          // A malformed provider response must not prevent a separately grounded,
          // bounded read or scenario step from reaching the deterministic compiler.
          candidates = [groundedIcStep];
        } else {
        const fallback = safeReadFallbackForInstruction(planningInstruction, allowedActionTypes);
        if (!fallback) throw error;
        candidates = [candidateForAction(fallback, goal, "provider-fallback-research")];
        }
      }
    }

    const useDatabase = Boolean(opts.workId && opts.workInputId && opts.plannerAttemptId);
    const input = {
      candidates,
      tenantContext,
      verticalKey,
      goal,
      constraints,
      snapshot,
      useDatabase,
      operatingContext: opts.operatingContext,
      planningContext: opts.planningContext,
    };
    const initial = await this.compileCandidatePlans(input);
    if (initial.compilation.selected) return initial;
    const underwritingStep = icFirstUnderwritingCandidate(goal, opts.planningContext, candidates);
    if (underwritingStep) {
      const bounded = await this.compileCandidatePlans({
        ...input,
        candidates: [...candidates.slice(0, Math.max(0, constraints.budgets.maxCandidates - 1)), underwritingStep],
      });
      if (bounded.compilation.selected) return bounded;
    }
    const icSensitivity = icRevenueSensitivityCandidate(goal, opts.planningContext);
    if (icSensitivity) {
      const sensitivity = await this.compileCandidatePlans({
        ...input,
        candidates: [...candidates.slice(0, Math.max(0, constraints.budgets.maxCandidates - 1)), icSensitivity],
      });
      if (sensitivity.compilation.selected) return sensitivity;
    }
    const groundingRead = icGroundingReadCandidate(goal, snapshot, opts.planningContext);
    if (!groundingRead) {
      const verify = icCurrentStateVerificationCandidate(goal, opts.planningContext);
      if (!verify) return initial;
      // A check-only fallback is legal only after the exact memo, recommendation,
      // and review state exist. Otherwise it would replan the same failed check
      // until the 48-step budget is exhausted without creating business value.
      return this.compileCandidatePlans({
        ...input,
        candidates: [...candidates.slice(0, Math.max(0, constraints.budgets.maxCandidates - 1)), verify],
      });
    }
    const candidatesWithGrounding = [...candidates.slice(0, Math.max(0, constraints.budgets.maxCandidates - 1)), groundingRead];
    return this.compileCandidatePlans({ ...input, candidates: candidatesWithGrounding });
  }
}

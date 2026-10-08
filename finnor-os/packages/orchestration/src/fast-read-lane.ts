import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  OPERATIONAL_QUERY_INTENTS,
  PE_WORLD_ROOT_TYPES,
  PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS,
  isRetiredWaterCanonicalEntity,
  isRetiredWaterParty,
  isRetiredWaterQuery,
  type CanonicalOperationalQueryIntent,
  type CanonicalOperationalQueryRequest,
  type OperationalQueryResult as SharedOperationalQueryResult,
  type OperationalQuerySource,
  type OperatingEvidenceKind,
  type TenantContext,
} from "@finnor/shared-types";
import type { OperationalQueryOptions } from "@finnor/read-models";
import { executeTenantOperationalQuery } from "./operational-query-runtime";

export type OperationalQueryIntent = CanonicalOperationalQueryIntent;
export type OperationalQueryRequest = CanonicalOperationalQueryRequest;
export type OperationalQueryResult = SharedOperationalQueryResult;

type QueryTenantContext = Pick<TenantContext, "tenantId"> &
  Partial<Pick<TenantContext, "userId" | "employeeId">>;

export interface OperationalQueryDateRange {
  timeZone: string;
  startLocalDate: string;
  endLocalDateInclusive: string;
  startAt: string;
  endAt: string;
}

export interface OperationalQuerySourceTruth {
  assessedAt: string;
  status: "fresh" | "stale" | "unknown";
  provenance: "tenant_integrations+integration_sync_checkpoints+external_refs";
  sources: Array<{
    integrationId: string;
    capability: string;
    provider: string;
    state: string;
    freshness: string;
    asOf?: string;
    unresolvedConflicts: number;
    blockedReason?: string;
  }>;
}

export interface OperationalQueryMetadata {
  queryId: string;
  source: "postgresql";
  durationMs: number;
  startedAt: string;
  completedAt: string;
  timeZone?: string;
  dateRange?: OperationalQueryDateRange;
  sourceTruth?: OperationalQuerySourceTruth;
}

export interface OperationalQueryExecution {
  request: OperationalQueryRequest;
  result: OperationalQueryResult;
  metadata: OperationalQueryMetadata;
}

export interface OperationalQueryInterpretation {
  route: "fast_read";
  confidence: "high";
  request: OperationalQueryRequest;
}

export interface PlannerReadFallback {
  route: "planner";
  reason: "not_question" | "mutation_or_advice" | "external_or_ambiguous" | "unsupported";
}

export type OperationalQueryDecision = OperationalQueryInterpretation | PlannerReadFallback;

export interface AnswerDisplayFact {
  label: string;
  value: string;
}

export interface AnswerDisplay {
  title: string;
  facts: AnswerDisplayFact[];
}

export interface AnswerEvidence {
  source: string;
  ref: string;
  timestamp: string;
  kind?: OperatingEvidenceKind;
}

export interface AnswerFreshness {
  status: "fresh" | "stale" | "unknown";
  observedAt: string;
  sourceTruth?: OperationalQuerySourceTruth;
}

export interface AnswerEnvelope {
  kind: "answer";
  intent: OperationalQueryIntent | "conversation";
  readOnly: true;
  spokenSummary: string;
  display: AnswerDisplay;
  evidence: AnswerEvidence[];
  asOf: string;
  freshness: AnswerFreshness;
  query?: OperationalQueryExecution;
}

export type FastReadOnlyClassification =
  | { route: "fast_read"; intent: OperationalQueryIntent }
  | PlannerReadFallback;

export type ExecuteOperationalQuery = typeof executeTenantOperationalQuery;

export interface FastReadOnlyRouter {
  classify(instruction: string): FastReadOnlyClassification;
  route(instruction: string, ctx: QueryTenantContext): Promise<AnswerEnvelope | null>;
  interpret?(instruction: string): OperationalQueryDecision;
  execute?(
    request: OperationalQueryRequest,
    ctx: QueryTenantContext,
    options?: OperationalQueryOptions,
  ): Promise<OperationalQueryExecution>;
  answer?(execution: OperationalQueryExecution): AnswerEnvelope;
}

export interface FastReadOnlyRouterDeps {
  executeOperationalQuery?: ExecuteOperationalQuery;
}

const ACTIVE_INTENTS = new Set<string>(OPERATIONAL_QUERY_INTENTS);
const PE_INTENTS = new Set<string>(PRIVATE_EQUITY_OPERATIONAL_QUERY_INTENTS);
const MUTATION = /\b(?:send|email|message|call|create|update|delete|remove|assign|handoff|delegate|schedule|reschedule|share|approve|reject|close|waive|execute|change)\b/i;
const QUESTION = /\?|\b(?:what|which|who|why|show|list|give|are|is|how|status|context|readiness|open|find)\b/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;
// A mention of "Work" can also describe the product or its replay semantics.
// Claim a deterministic collection read only when the user asks for records.
const WORK_RECORD = /(?:work(?:\s+items?)?|tasks?)/i;
const WORK_LIST_REQUEST = new RegExp(`\\b(?:show|list|find|give(?:\\s+me)?|pull\\s+up)\\s+(?:me\\s+)?(?:the\\s+)?(?:my\\s+|our\\s+|all\\s+)?(?:open\\s+|active\\s+|pending\\s+|due\\s+|overdue\\s+)?${WORK_RECORD.source}\\b|\\bhow\\s+many\\s+(?:open\\s+|active\\s+|pending\\s+)?${WORK_RECORD.source}\\b|\\b(?:what|which)\\s+(?:open\\s+|active\\s+|pending\\s+|due\\s+|overdue\\s+)?${WORK_RECORD.source}\\s+(?:are|is|do|did|were|have|has)\\b|\\b(?:my|our)\\s+(?:open\\s+|active\\s+|pending\\s+|due\\s+|overdue\\s+)?${WORK_RECORD.source}\\s*\\??$`, "i");

function cleanQuery(value: string): string {
  return value.replace(/\?/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
}

function dealRequest(
  instruction: string,
  intent: Extract<OperationalQueryIntent,
    | "deal_context"
    | "deal_workstreams"
    | "open_requests"
    | "open_findings"
    | "open_deal_risks"
    | "critical_dependencies"
    | "closing_readiness">,
  scopedDealId?: string,
): OperationalQueryDecision {
  const dealId = instruction.match(UUID)?.[0] ?? scopedDealId;
  if (!dealId) return { route: "planner", reason: "external_or_ambiguous" };
  return { route: "fast_read", confidence: "high", request: { intent, dealId } };
}

export function interpretOperationalQuery(instruction: string, scopedDealId?: string): OperationalQueryDecision {
  const text = instruction.trim();
  if (!text || !QUESTION.test(text)) return { route: "planner", reason: "not_question" };
  if (MUTATION.test(text)) return { route: "planner", reason: "mutation_or_advice" };

  if (/^what changed since yesterday(?:,? and does it affect our recommendation)?\??$/i.test(text)) {
    const dealId = text.match(UUID)?.[0] ?? scopedDealId;
    return dealId
      ? { route: "fast_read", confidence: "high", request: { intent: "pe_world_state", root: { entityType: "pe_deal", entityId: dealId }, compareWindow: "previous_24h" } }
      : { route: "planner", reason: "external_or_ambiguous" };
  }

  if (/\b(?:pe\s+)?world\s+state\b/i.test(text)) {
    const entityId = text.match(UUID)?.[0];
    const entityType = /\bstrategy\b/i.test(text) ? "pe_strategy" as const
      : /\bopportunity\b/i.test(text) ? "pe_opportunity" as const
        : /\bdeal\b/i.test(text) ? "pe_deal" as const : null;
    if (!entityId || !entityType) return { route: "planner", reason: "external_or_ambiguous" };
    return { route: "fast_read", confidence: "high", request: { intent: "pe_world_state", root: { entityType, entityId } } };
  }

  if (/^why\s+(?:is|are)\s+.{1,100}\s+blocked\??$/i.test(text)
      || /\bwhat\s+is\s+blocking\s+(?:this\s+)?deal\b/i.test(text)) {
    return dealRequest(text, "closing_readiness", scopedDealId);
  }
  if (/\bclosing\s+readiness\b/i.test(text)) return dealRequest(text, "closing_readiness", scopedDealId);
  if (/\bcritical\s+dependenc(?:y|ies)\b/i.test(text)) return dealRequest(text, "critical_dependencies", scopedDealId);
  if (/\b(?:open\s+)?deal\s+risks?\b/i.test(text)) return dealRequest(text, "open_deal_risks", scopedDealId);
  if (/\b(?:open\s+)?findings?\b/i.test(text)) return dealRequest(text, "open_findings", scopedDealId);
  if (/\b(?:open\s+)?requests?\b/i.test(text)) return dealRequest(text, "open_requests", scopedDealId);
  if (/\bworkstreams?\b/i.test(text)) return dealRequest(text, "deal_workstreams", scopedDealId);
  if (/\bdeal\s+(?:context|overview|status)\b/i.test(text)) return dealRequest(text, "deal_context", scopedDealId);

  if (/\b(?:team\s+roster|members?\s+of\s+(?:the\s+)?team)\b/i.test(text)) {
    return { route: "fast_read", confidence: "high", request: { intent: "team_roster", query: cleanQuery(text) } };
  }
  if (/\b(?:workforce\s+(?:status|activity)|ai\s+workers?|worker\s+(?:status|assignments?))\b/i.test(text)) {
    return { route: "fast_read", confidence: "high", request: { intent: "workforce_status" } };
  }
  if (/\b(?:agent|workflow|action)\s+activit(?:y|ies)\b/i.test(text)) {
    return { route: "fast_read", confidence: "high", request: { intent: "agent_activity" } };
  }
  if (/\b(?:attention|what\s+(?:needs|requires)\s+(?:my\s+)?attention|what\s+should\s+i\s+do\s+next)\b/i.test(text)) {
    return { route: "fast_read", confidence: "high", request: { intent: "attention_queue" } };
  }
  // Replay and trace are product concepts, not Work collection filters.
  if (/\b(?:work\s+replay|instruction\s+trace)\b/i.test(text)) {
    return { route: "planner", reason: "unsupported" };
  }
  if (WORK_LIST_REQUEST.test(text)) {
    return { route: "fast_read", confidence: "high", request: { intent: "work_list", openOnly: /\bopen\b/i.test(text) } };
  }
  if (/\b(?:company|organization)\s+(?:context|graph|relationships?)\b/i.test(text)) {
    return { route: "fast_read", confidence: "high", request: { intent: "company_context", query: cleanQuery(text) } };
  }
  if (/\b(?:context|details?)\s+(?:for|about)\s+\S+/i.test(text)) {
    return { route: "fast_read", confidence: "high", request: { intent: "party_context", query: cleanQuery(text) } };
  }
  if (/^(?:how\s+(?:does|do|is|are|can)\b|what\s+(?:is|are|does|can)\b|explain\b|show\s+me\s+how\b)/i.test(text)) {
    return { route: "planner", reason: "unsupported" };
  }
  if (/\b(?:who\s+is|find|lookup|show)\b/i.test(text)) {
    return { route: "fast_read", confidence: "high", request: { intent: "party_lookup", query: cleanQuery(text) } };
  }
  return { route: "planner", reason: "unsupported" };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function validateOperationalQueryRequest(
  input: unknown,
): { success: true; request: OperationalQueryRequest } | { success: false; error: string } {
  const value = object(input);
  const intent = typeof value?.intent === "string" ? value.intent : "";
  if (!intent) return { success: false, error: "Operational query intent is required" };
  if (isRetiredWaterQuery(intent)) return { success: false, error: "Operational query intent belongs to the retired Water vertical" };
  if (!ACTIVE_INTENTS.has(intent)) return { success: false, error: "Unsupported operational query intent" };

  if (intent === "harness_program_v1") {
    if (Object.keys(value!).some(key=>!["intent","programId","workId"].includes(key)) || typeof value?.programId!=="string" || !UUID.test(value.programId) || typeof value?.workId!=="string" || !UUID.test(value.workId)) return {success:false,error:"Harness query requires exact programme and Work IDs"};
    return {success:true,request:value as unknown as OperationalQueryRequest};
  }

  if (intent === "attention_queue") {
    const permitted = new Set(["intent", "page"]);
    if (Object.keys(value!).some((key) => !permitted.has(key))) {
      return { success: false, error: "Attention queue accepts only intent and page; employee identity comes from authentication" };
    }
    const page = value?.page === undefined ? undefined : object(value.page);
    if (value?.page !== undefined && !page) return { success: false, error: "Attention queue page must be an object" };
    if (page && Object.keys(page).some((key) => key !== "limit")) return { success: false, error: "Attention queue supports only a page limit" };
    if (page?.limit !== undefined && (!Number.isInteger(page.limit) || Number(page.limit) < 1 || Number(page.limit) > 100)) {
      return { success: false, error: "Attention queue limit must be an integer from 1 to 100" };
    }
    return {
      success: true,
      request: {
        intent: "attention_queue",
        ...(page?.limit !== undefined ? { page: { limit: Number(page.limit) } } : {}),
      },
    };
  }

  if (intent === "workforce_status") {
    const permitted = new Set(["intent", "page"]);
    if (Object.keys(value!).some((key) => !permitted.has(key))) {
      return { success: false, error: "Workforce status accepts only intent and page; tenant identity comes from authentication" };
    }
    const page = value?.page === undefined ? undefined : object(value.page);
    if (value?.page !== undefined && !page) return { success: false, error: "Workforce status page must be an object" };
    if (page && Object.keys(page).some((key) => key !== "limit" && key !== "cursor")) return { success: false, error: "Workforce status supports only a page limit and AgentProfile cursor" };
    if (page?.limit !== undefined && (!Number.isInteger(page.limit) || Number(page.limit) < 1 || Number(page.limit) > 100)) {
      return { success: false, error: "Workforce status limit must be an integer from 1 to 100" };
    }
    if (page?.cursor !== undefined && (typeof page.cursor !== "string" || !UUID.test(page.cursor))) {
      return { success: false, error: "Workforce status cursor must be an AgentProfile UUID" };
    }
    return {
      success: true,
      request: {
        intent: "workforce_status",
        ...(page?.limit !== undefined || page?.cursor !== undefined ? { page: {
          ...(page.limit !== undefined ? { limit: Number(page.limit) } : {}),
          ...(page.cursor !== undefined ? { cursor: page.cursor } : {}),
        } } : {}),
      },
    };
  }

  if (intent === "pe_world_state") {
    const root = object(value?.root);
    if (!root || !PE_WORLD_ROOT_TYPES.includes(String(root.entityType) as (typeof PE_WORLD_ROOT_TYPES)[number])
        || typeof root.entityId !== "string" || !UUID.test(root.entityId)) {
      return { success: false, error: "PE world-state queries require a valid canonical PE world root" };
    }
    if (value?.at !== undefined && (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)))) {
      return { success: false, error: "PE world-state at must be an ISO timestamp" };
    }
    if (value?.compareWindow !== undefined && value.compareWindow !== "previous_24h") {
      return { success: false, error: "Unsupported PE world-state comparison window" };
    }
    if (value?.compareWindow && (value.at || value.validAt || value.knowledgeAt)) {
      return { success: false, error: "A rolling PE comparison cannot use a separate historical instant" };
    }
  } else if (PE_INTENTS.has(intent)) {
    if (typeof value?.dealId !== "string" || !UUID.test(value.dealId)) {
      return { success: false, error: "Private Equity operational queries require a valid dealId" };
    }
  }
  const ref = object(value?.ref) ?? object(value?.teamRef);
  if (ref && typeof ref.partyType === "string" && isRetiredWaterParty(ref.partyType)) {
    return { success: false, error: "Party type belongs to the retired Water vertical" };
  }
  const anchor = object(value?.anchor);
  if (anchor && typeof anchor.entityType === "string" && isRetiredWaterCanonicalEntity(anchor.entityType)) {
    return { success: false, error: "Entity type belongs to the retired Water vertical" };
  }
  return { success: true, request: value as unknown as OperationalQueryRequest };
}

export function classifyFastReadOnlyQuestion(instruction: string): FastReadOnlyClassification {
  const decision = interpretOperationalQuery(instruction);
  return decision.route === "fast_read"
    ? { route: "fast_read", intent: decision.request.intent }
    : decision;
}

function title(intent: OperationalQueryIntent): string {
  return intent.split("_").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
}

function answerOperationalQuery(execution: OperationalQueryExecution): AnswerEnvelope {
  const { result } = execution;
  const facts: AnswerDisplayFact[] = [
    { label: "Status", value: result.status },
    { label: "Records", value: String(result.count) },
  ];
  let summary = `${title(result.intent)} returned ${result.count} record${result.count === 1 ? "" : "s"}.`;

  if (result.intent === "work_list") {
    facts.push({ label: "Works", value: String(result.works.length) });
    facts.push({ label: "Tasks", value: String(result.tasks.length) });
    summary = `There are ${result.works.length} matching work items and ${result.tasks.length} matching tasks.`;
  } else if (result.intent === "attention_queue") {
    facts.push({ label: "Source status", value: result.sourceStatus.status });
    facts.push({ label: "Actionable items", value: String(result.items.length) });
    summary = result.sourceStatus.status === "unavailable"
      ? "The attention queue is unavailable; this is not a clear queue."
      : result.sourceStatus.status === "partial"
        ? `The attention queue is partial and contains ${result.items.length} verified actionable item${result.items.length === 1 ? "" : "s"}.`
        : `There are ${result.items.length} verified actionable attention item${result.items.length === 1 ? "" : "s"}.`;
  } else if (result.intent === "agent_activity") {
    facts.push({ label: "Actions", value: String(result.actions.length) });
    facts.push({ label: "Workflows", value: String(result.workflows.length) });
  } else if (result.intent === "workforce_status") {
    facts.push({ label: "Configuration", value: result.configurationState });
    facts.push({ label: "Current assignments", value: String(result.currentAssignments.length) });
    facts.push({ label: "Failed / reassigned", value: String(result.blockedOrFailedAssignments.length) });
    facts.push({ label: "Learning proposals", value: String(result.proposals.filter((proposal) => proposal.status === "proposed").length) });
    summary = result.configurationState === "unconfigured"
      ? "The AI workforce is unconfigured; no worker identities are being inferred."
      : `${result.workers.length} configured AI worker${result.workers.length === 1 ? " is" : "s are"} recorded with ${result.currentAssignments.length} current assignment${result.currentAssignments.length === 1 ? "" : "s"}.`;
  } else if (result.intent === "closing_readiness") {
    facts.push({ label: "Eligible", value: result.eligible ? "Yes" : "No" });
    facts.push({ label: "Blocking conditions", value: String(result.blockingConditions.length) });
    const named = (rows: Record<string, unknown>[], field: string, kind: string) => rows
      .map((row) => {
        const name = typeof row[field] === "string" ? String(row[field]).trim() : "";
        const state = typeof row.state === "string" ? String(row.state).replaceAll("_", " ") : "";
        return name ? `${kind} “${name}”${state ? ` (${state})` : ""}` : "";
      })
      .filter(Boolean);
    const reasons = [
      ...named(result.blockingConditions, "condition", "Unmet closing condition"),
      ...named(result.failedConditions, "condition", "Failed closing condition"),
      ...named(result.unverifiedClosingItems, "item", "Unverified closing item"),
      ...result.integrityErrors.map((error) => `Integrity error: ${error}`),
    ];
    const listedBlockers = `${reasons.slice(0, 3).join("; ")}${reasons.length > 3 ? `; and ${reasons.length - 3} more` : ""}`;
    summary = result.eligible
      ? "The deal is currently eligible to close under the verified controls."
      : reasons.length > 0
        ? `The deal is not ready to close. Recorded blockers: ${listedBlockers}${/[.!?]$/.test(listedBlockers) ? "" : "."}`
        : "The deal is not ready to close. The readiness record has no named closing blocker; inspect its status, dependencies, and evidence coverage.";
  } else if (result.intent === "pe_world_state") {
    facts.push({ label: "Temporal completeness", value: result.temporalCompleteness.status });
    facts.push({ label: "State at", value: result.stateAt });
    if (result.temporalReview) {
      const review = result.temporalReview;
      const evidenceChanges = review.changes.filter((item) => item.kind === "evidence_version_recorded");
      const modelChanges = review.changes.filter((item) => item.kind === "underwriting_run_completed" || item.kind === "underwriting_run_failed");
      const recommendationChanges = review.changes.filter((item) => item.kind === "ic_recommendation_recorded");
      const recommendationRunRefs = recommendationChanges.flatMap((item) => item.causalRefs.filter((ref) => ref.relationship === "underwriting_run").map((ref) => ref.id));
      const linkedRun = modelChanges.find((item) => recommendationRunRefs.includes(item.subject.id));
      const incomplete = review.baselineStatus !== "complete" || review.activityTruncated || review.basisCoverage.status !== "complete" || review.activitySources.some((source) => source.status !== "complete");
      facts.push({ label: "Window", value: `${review.sinceAt} to ${review.untilAt}` });
      facts.push({ label: "Recorded changes shown", value: `${review.changes.length}${review.activityTruncated ? "+ (truncated)" : ""}` });
      facts.push({ label: "Evidence versions", value: String(evidenceChanges.length) });
      facts.push({ label: "Underwriting runs", value: String(modelChanges.length) });
      facts.push({ label: "IC recommendation events", value: String(recommendationChanges.length) });
      facts.push({ label: "Historical baseline", value: review.baselineStatus === "unavailable_before_baseline" ? `Unavailable before ${review.baselineAt ?? "the recorded baseline"}` : review.baselineStatus });
      facts.push({ label: "IC basis coverage", value: review.basisCoverage.status });
      for (const comparison of review.recommendationComparisons.slice(0, 6)) {
        const before = comparison.baseline?.outcome.replaceAll("_", " ").toLowerCase();
        const current = comparison.current?.outcome.replaceAll("_", " ").toLowerCase();
        facts.push({ label: `Recommendation · ${comparison.caseId}`, value: comparison.assessment === "unverified"
          ? `Prior selection is unverified; current selection: ${current ?? "none recorded"}`
          : `${before ?? "no selected recommendation"} → ${current ?? "no selected recommendation"} · ${comparison.assessment.replaceAll("_", " ")}` });
      }
      for (const comparison of review.modelComparisons.slice(0, 6)) {
        facts.push({ label: `Selected model basis · ${comparison.caseId}`, value: `${comparison.baselineRunId} → ${comparison.currentRunId}; changed inputs: ${Object.keys(comparison.changedInputs).join(", ") || "none"}; ${Object.keys(comparison.changedOutputs).length} changed outputs` });
      }
      for (const [index, change] of review.changes.filter((item) => ["evidence_version_recorded", "underwriting_run_completed", "underwriting_run_failed", "ic_recommendation_recorded", "ic_case_transition"].includes(item.kind)).slice(0, 6).entries()) {
        const source = change.sourceRefs[0];
        facts.push({ label: `Observed change ${index + 1}`, value: `${change.label} at ${change.occurredAt}${source ? ` · ${source.table}:${source.id}` : ""}` });
      }
      const verifiedComparisons = review.recommendationComparisons.filter((item) => item.assessment !== "unverified");
      const recommendationImpact = verifiedComparisons.length
        ? verifiedComparisons.slice(0, 3).map((item) => {
          const before = item.baseline?.outcome.replaceAll("_", " ").toLowerCase() ?? "no selected recommendation";
          const current = item.current?.outcome.replaceAll("_", " ").toLowerCase() ?? "no selected recommendation";
          const basis = item.assessment === "changed_basis"
            ? "; the recorded Run, memo or rationale basis changed"
            : "";
          return `IC recommendation for case ${item.caseId}: ${before} → ${current} (${item.assessment.replaceAll("_", " ")}${basis})${item.current ? `, explicitly based on Run ${item.current.underwritingRunId} and memo ${item.current.memoId}` : ""}.`;
        }).join(" ")
        : linkedRun
        ? `An IC recommendation was recorded in this window with an explicit link to Underwriting Run ${linkedRun.subject.id}.`
        : recommendationChanges.length
          ? "An IC recommendation event was recorded, but this bounded read did not prove a changed underwriting basis."
          : "This bounded read did not show an IC recommendation change; it does not prove the recommendation was unaffected.";
      const modelImpact = review.modelComparisons.slice(0, 3).map((item) => {
        const inputs = Object.keys(item.changedInputs).length;
        const outputs = Object.keys(item.changedOutputs).length;
        return `The selected model comparison for case ${item.caseId} records ${inputs} changed input${inputs === 1 ? "" : "s"} and ${outputs} changed output${outputs === 1 ? "" : "s"}.`;
      }).join(" ");
      summary = `${review.changes.length}${review.activityTruncated ? " or more" : ""} recorded Deal changes since ${review.sinceAt}, including ${evidenceChanges.length} evidence version${evidenceChanges.length === 1 ? "" : "s"} and ${modelChanges.length} Underwriting Run event${modelChanges.length === 1 ? "" : "s"}. ${recommendationImpact}${modelImpact ? ` ${modelImpact}` : ""} The record does not prove that an evidence change caused the recommendation.${incomplete ? " Historical or source coverage is partial; absence of other changes is unverified." : ""}`;
    } else {
      summary = `PE world state is ${result.temporalCompleteness.status} at ${result.stateAt}.`;
    }
  } else if ("resolution" in result) {
    facts.push({ label: "Resolution", value: String(result.resolution) });
  }

  const source = result.source as OperationalQuerySource;
  const review = result.intent === "pe_world_state" ? result.temporalReview : undefined;
  const temporalEvidence = review?.changes.flatMap((change) => change.sourceRefs.map((ref) => ({
    source: ref.table, ref: ref.id, timestamp: change.occurredAt, kind: "CANONICAL" as const,
  }))).slice(0, 30);
  return {
    kind: "answer",
    intent: result.intent,
    readOnly: true,
    spokenSummary: summary,
    display: { title: title(result.intent), facts },
    evidence: temporalEvidence?.length ? temporalEvidence : source.tables.map((table) => ({
      source: table,
      ref: "tenant-scoped",
      timestamp: result.asOf,
      kind: "CANONICAL" as const,
    })),
    asOf: result.asOf,
    freshness: { status: review && (review.baselineStatus !== "complete" || review.activityTruncated || review.activitySources.some((item) => item.status !== "complete")) ? "unknown" : "fresh", observedAt: result.asOf },
    query: execution,
  };
}

export function createFastReadOnlyRouter(
  deps: FastReadOnlyRouterDeps = {},
): FastReadOnlyRouter {
  const executeQuery = deps.executeOperationalQuery ?? executeTenantOperationalQuery;
  const execute = async (
    request: OperationalQueryRequest,
    ctx: QueryTenantContext,
    options: OperationalQueryOptions = {},
  ): Promise<OperationalQueryExecution> => {
    const validation = validateOperationalQueryRequest(request);
    if (!validation.success) throw new Error(validation.error);
    const startedAt = new Date();
    const started = performance.now();
    const result = await executeQuery(ctx.tenantId, validation.request, {
      ...options,
      employeeId: ctx.employeeId,
      userId: ctx.userId,
    });
    const completedAt = new Date();
    return {
      request: validation.request,
      result: result as OperationalQueryResult,
      metadata: {
        queryId: result.execution?.id ?? createHash("sha256")
          .update(JSON.stringify([ctx.tenantId, validation.request, startedAt.toISOString()]))
          .digest("hex"),
        source: "postgresql",
        durationMs: Math.max(0, performance.now() - started),
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      },
    };
  };

  return {
    classify: classifyFastReadOnlyQuestion,
    interpret: interpretOperationalQuery,
    execute,
    answer: answerOperationalQuery,
    async route(instruction, ctx) {
      const decision = interpretOperationalQuery(instruction);
      if (decision.route !== "fast_read") return null;
      return answerOperationalQuery(await execute(decision.request, ctx));
    },
  };
}

export const defaultFastReadOnlyRouter = createFastReadOnlyRouter();

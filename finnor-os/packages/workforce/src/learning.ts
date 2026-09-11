import { createHash } from "node:crypto";
import type {
  LearningMetricSlice,
  LearningObservation,
  LearningOutcomeClass,
  LearningProposedChange,
  WorkforceCapabilityKind,
} from "./contracts";
import { MIN_ROUTING_SAMPLE_SIZE } from "./eligibility";

export interface OutcomeAttributionFacts {
  verifiedCompletion?: boolean;
  userCancelled?: boolean;
  humanRejected?: boolean;
  humanCorrected?: boolean;
  authorityDenied?: boolean;
  schemaOrCompileRejected?: boolean;
  providerUnavailable?: boolean;
  externalFailure?: boolean;
  staleWorldOrReplan?: boolean;
  timedOut?: boolean;
  businessOutcomeFailed?: boolean;
  planningFailed?: boolean;
  recovered?: boolean;
}

/** Ordered, deterministic attribution. Ambiguous/self-authored opinions remain unknown. */
export function attributeLearningOutcome(facts: OutcomeAttributionFacts): LearningOutcomeClass {
  if (facts.verifiedCompletion) return "verified_completion";
  if (facts.userCancelled) return "user_cancellation";
  if (facts.humanRejected) return "human_rejection";
  if (facts.humanCorrected) return "human_correction";
  if (facts.authorityDenied) return "authority_denial";
  if (facts.schemaOrCompileRejected) return "schema_compile_rejection";
  if (facts.providerUnavailable) return "provider_outage";
  if (facts.externalFailure) return "external_failure";
  if (facts.staleWorldOrReplan) return "stale_world_replan";
  if (facts.timedOut) return "timeout";
  if (facts.businessOutcomeFailed) return "business_outcome_failure";
  if (facts.planningFailed) return "agent_planning_failure";
  if (facts.recovered) return "recovery";
  return "unknown";
}

function percentile(sorted: number[], percentileValue: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(percentileValue * sorted.length))] ?? null;
}

function metricKey(observation: LearningObservation): string {
  return [observation.agentProfileId, observation.agentRevisionId, observation.capability, observation.nodeKind, observation.contextClass].join("\u001f");
}

const QUALITY_FAILURES = new Set<LearningOutcomeClass>([
  "agent_planning_failure", "schema_compile_rejection", "business_outcome_failure", "timeout", "unknown",
]);
const QUALITY_EXCLUDED = new Set<LearningOutcomeClass>([
  "provider_outage", "external_failure", "authority_denial", "human_rejection", "human_correction", "stale_world_replan", "user_cancellation", "recovery",
]);

export function computeLearningMetrics(observations: LearningObservation[]): LearningMetricSlice[] {
  const groups = new Map<string, LearningObservation[]>();
  for (const observation of observations) {
    if (!observation.verified || observation.sourceRefs.length === 0) continue;
    const key = metricKey(observation);
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  return [...groups.values()].map((rows) => {
    const first = rows[0]!;
    const completions = rows.filter((row) => row.outcomeClass === "verified_completion").length;
    const qualityRows = rows.filter((row) => row.outcomeClass === "verified_completion" || QUALITY_FAILURES.has(row.outcomeClass));
    const qualityFailures = qualityRows.filter((row) => QUALITY_FAILURES.has(row.outcomeClass)).length;
    const latencies = rows.map((row) => row.measuredMetrics.latencyMs).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
    const costs = rows.map((row) => row.measuredMetrics.knownCostUsd).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
    const humanRejections = rows.filter((row) => row.outcomeClass === "human_rejection").length;
    const sampleState = qualityRows.length >= MIN_ROUTING_SAMPLE_SIZE ? "KNOWN" as const : "UNKNOWN" as const;
    return {
      agentProfileId: first.agentProfileId,
      agentRevisionId: first.agentRevisionId,
      capability: first.capability,
      nodeKind: first.nodeKind as WorkforceCapabilityKind,
      contextClass: first.contextClass,
      attemptCount: rows.length,
      verifiedCompletionCount: completions,
      qualityAttemptCount: qualityRows.length,
      qualityFailureCount: qualityFailures,
      humanRejectionCount: humanRejections,
      humanCorrectionCount: rows.filter((row) => row.outcomeClass === "human_correction").length,
      providerOutageCount: rows.filter((row) => row.outcomeClass === "provider_outage").length,
      externalFailureCount: rows.filter((row) => row.outcomeClass === "external_failure").length,
      replanCount: rows.filter((row) => row.outcomeClass === "stale_world_replan").length + rows.reduce((sum, row) => sum + (row.measuredMetrics.replans ?? 0), 0),
      recoveryCount: rows.filter((row) => row.outcomeClass === "recovery").length + rows.reduce((sum, row) => sum + (row.measuredMetrics.recoveries ?? 0), 0),
      medianLatencyMs: percentile(latencies, 0.5),
      p95LatencyMs: percentile(latencies, 0.95),
      knownCostUsd: costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null,
      sampleState,
      verifiedCompletionRate: sampleState === "KNOWN" ? completions / qualityRows.length : null,
      qualityFailureRate: sampleState === "KNOWN" ? qualityFailures / qualityRows.length : null,
      humanRejectionRate: rows.length >= MIN_ROUTING_SAMPLE_SIZE ? humanRejections / rows.length : null,
    };
  }).sort((left, right) => [left.agentRevisionId, left.capability, left.nodeKind, left.contextClass].join(":").localeCompare([right.agentRevisionId, right.capability, right.nodeKind, right.contextClass].join(":")));
}

const FORBIDDEN_GUIDANCE_KEYS = /(?:authority|policy|human.?only|vote|attest|approve|schema|compiler|evidence|business.?effect|recovery.?guarantee|source.?truth|code|prompt|database)/i;

export function assertSafeLearningChange(change: LearningProposedChange): void {
  const serialized = JSON.stringify(change);
  if (FORBIDDEN_GUIDANCE_KEYS.test(serialized)) throw new Error("Learning proposal attempts to modify a hard authority, truth, or compiler boundary");
  if (change.class === "routing_preference_adjustment" && (!Number.isFinite(change.weight) || change.weight < -0.25 || change.weight > 0.25)) {
    throw new Error("Routing preference adjustment must stay within the bounded [-0.25, 0.25] soft range");
  }
  if (change.class === "soft_planning_hint_update" && (!/^[a-z0-9_.-]{1,80}$/i.test(change.hintKey) || change.hint.length > 500)) {
    throw new Error("Soft planning hint is outside its bounded contract");
  }
}

export function proposalChangeForMetric(metric: LearningMetricSlice): LearningProposedChange | null {
  if (metric.sampleState !== "KNOWN" || metric.qualityAttemptCount < MIN_ROUTING_SAMPLE_SIZE) return null;
  if ((metric.qualityFailureRate ?? 0) >= 0.4) {
    return { class: "capability_quality_warning", capability: metric.capability, warning: `Verified quality failures are ${metric.qualityFailureCount}/${metric.qualityAttemptCount} for this exact revision and context.` };
  }
  if ((metric.verifiedCompletionRate ?? 0) >= 0.9 && metric.qualityAttemptCount >= 10) {
    return { class: "routing_preference_adjustment", capability: metric.capability, adjustment: "prefer", weight: 0.1 };
  }
  return null;
}

export function learningObservationHash(value: Omit<LearningObservation, "id" | "observationHash">): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== "object") return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    const row = input as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
  };
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function isQualityExcluded(outcomeClass: LearningOutcomeClass): boolean {
  return QUALITY_EXCLUDED.has(outcomeClass);
}

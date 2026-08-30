import type { CausalReplayNode } from "@finnor/shared-types";
import type {
  EpistemicSemanticDiff,
  RedactedEpistemicTrace,
  StaticAdmissibilityResultLike,
} from "./contracts";
import type { EpistemicControllerRun } from "./controller";
import { epistemicHash } from "./source-precedence";

function redactedReasonCode(reasonCode: string): string {
  return /^[A-Z][A-Z0-9_:.\-]{1,127}$/.test(reasonCode)
    ? reasonCode
    : `UNSTRUCTURED_REASON_REDACTED:${epistemicHash(reasonCode).slice(0, 12)}`;
}

export function redactEpistemicTrace(
  run: EpistemicControllerRun,
  options: { p2Statuses?: StaticAdmissibilityResultLike["status"][]; semanticDiff?: EpistemicSemanticDiff } = {},
): RedactedEpistemicTrace {
  const body = {
    decisionId: run.finalState.scope.decisionId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    initial: run.initialState.propositions.map((proposition) => ({ id: proposition.id, status: proposition.status, evidenceCount: proposition.evidenceRefs.length })),
    final: run.finalState.propositions.map((proposition) => ({ id: proposition.id, status: proposition.status, evidenceCount: proposition.evidenceRefs.length })),
    actions: run.rounds.flatMap((round) => round.selectedAction ? [round.selectedAction.id] : []),
  };
  return {
    version: 1,
    traceId: `epistemic:${epistemicHash(body).slice(0, 24)}`,
    decisionId: run.finalState.scope.decisionId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    initialPropositions: body.initial,
    uncertainties: run.rounds.flatMap((round) => round.uncertainties.map((uncertainty) => ({
      propositionId: uncertainty.requiredPropositionId,
      category: uncertainty.category,
      reasonCodes: uncertainty.reasonCodes.map(redactedReasonCode),
    }))),
    candidates: run.rounds.flatMap((round) => round.candidates.map((action) => ({
      actionId: action.id,
      kind: action.kind,
      adapterId: action.adapterId,
      score: {
        ...round.scores.find((score) => score.actionId === action.id)!,
        reasonCodes: (round.scores.find((score) => score.actionId === action.id)?.reasonCodes ?? []).map(redactedReasonCode),
      },
    }))),
    selectedActions: run.rounds.flatMap((round) => round.selectedAction && round.observation ? [{
      actionId: round.selectedAction.id,
      kind: round.selectedAction.kind,
      adapterId: round.selectedAction.adapterId,
      outcome: round.observation.outcome,
    }] : []),
    beliefUpdates: run.finalState.transitions.slice(run.initialState.transitions.length),
    stopDecisions: run.rounds.map((round) => ({
      ...round.stopDecision,
      reasonCodes: round.stopDecision.reasonCodes.map(redactedReasonCode),
    })),
    finalPropositions: body.final,
    p2Statuses: [...(options.p2Statuses ?? [])],
    ...(options.semanticDiff ? { semanticDiff: options.semanticDiff } : {}),
    redaction: "STRUCTURED_DECISIONS_ONLY",
  };
}

/** Reuses existing CausalReplay node/evidence shapes. Persistence remains the
 * existing Work/planner-attempt decision-context snapshot; this adapter creates no
 * unrelated telemetry schema. */
export function epistemicTraceToCausalReplayNodes(trace: RedactedEpistemicTrace): CausalReplayNode[] {
  const source = `decision_context_snapshot.epistemic.${trace.traceId}`;
  const baseEvidence = [{
    source,
    ref: trace.traceId,
    recordedAt: trace.completedAt,
    availability: "available" as const,
    integrityHash: epistemicHash(trace),
  }];
  const uncertaintyNode: CausalReplayNode = {
    id: `${trace.traceId}:uncertainty`,
    stage: "context",
    title: "Decision-critical uncertainty analyzed",
    summary: `${trace.initialPropositions.length} propositions · ${trace.uncertainties.length} unresolved classifications`,
    status: trace.uncertainties.length > 0 ? "uncertainty_recorded" : "resolved",
    occurredAt: trace.startedAt,
    sourceRefs: [source],
    evidence: baseEvidence,
    facts: {
      propositionStatuses: trace.initialPropositions.map((proposition) => ({ id: proposition.id, status: proposition.status })),
      uncertaintyReasonCodes: trace.uncertainties.map((uncertainty) => ({ propositionId: uncertainty.propositionId, category: uncertainty.category, reasonCodes: uncertainty.reasonCodes })),
    },
    entityRefs: [],
  };
  const acquisitionNode: CausalReplayNode = {
    id: `${trace.traceId}:acquisition`,
    stage: "evidence",
    title: "Read-only information actions evaluated",
    summary: `${trace.candidates.length} candidates · ${trace.selectedActions.length} selected`,
    status: trace.selectedActions.some((action) => action.outcome === "FAILED" || action.outcome === "PERMISSION_BLOCKED") ? "partial" : "recorded",
    occurredAt: trace.completedAt,
    sourceRefs: [source],
    evidence: baseEvidence,
    facts: {
      candidates: trace.candidates.map((candidate) => ({ actionId: candidate.actionId, kind: candidate.kind, adapterId: candidate.adapterId, eligible: candidate.score.eligible, reasonCodes: candidate.score.reasonCodes })),
      selected: trace.selectedActions,
      stopReasons: trace.stopDecisions.map((decision) => decision.reason),
    },
    entityRefs: [],
  };
  const beliefNode: CausalReplayNode = {
    id: `${trace.traceId}:belief`,
    stage: "planning",
    title: "Belief state updated before planning",
    summary: `${trace.beliefUpdates.length} transitions · final stop ${trace.stopDecisions.at(-1)?.reason ?? "unknown"}`,
    status: trace.finalPropositions.some((proposition) => proposition.status !== "KNOWN") ? "uncertainty_remains" : "resolved",
    occurredAt: trace.completedAt,
    sourceRefs: [source],
    evidence: baseEvidence,
    facts: {
      transitions: trace.beliefUpdates.map((transition) => ({ propositionId: transition.propositionId, from: transition.from, to: transition.to, reasonCode: transition.reasonCode })),
      finalStatuses: trace.finalPropositions.map((proposition) => ({ id: proposition.id, status: proposition.status })),
      p2Statuses: trace.p2Statuses,
      semanticDiff: trace.semanticDiff ? { classification: trace.semanticDiff.classification, reasonCodes: trace.semanticDiff.reasonCodes } : null,
    },
    entityRefs: [],
  };
  return [uncertaintyNode, acquisitionNode, beliefNode];
}

export function decisionContextEpistemicSummary(trace: RedactedEpistemicTrace): Record<string, unknown> {
  return {
    version: trace.version,
    traceId: trace.traceId,
    integrityHash: epistemicHash(trace),
    uncertaintyCount: trace.uncertainties.length,
    candidateCount: trace.candidates.length,
    selectedCount: trace.selectedActions.length,
    transitions: trace.beliefUpdates.map((transition) => ({ propositionId: transition.propositionId, from: transition.from, to: transition.to, reasonCode: transition.reasonCode })),
    finalStatuses: trace.finalPropositions.map((proposition) => ({ id: proposition.id, status: proposition.status })),
    finalStop: trace.stopDecisions.at(-1)?.reason ?? null,
    p2Statuses: trace.p2Statuses,
    redaction: trace.redaction,
  };
}

import type {
  AcquisitionUsage,
  BeliefTransition,
  ConfidenceAssessment,
  DecisionRequirement,
  EpistemicScope,
  EpistemicState,
  EvidenceFreshness,
  EvidenceRecord,
  Proposition,
  PropositionDefinition,
  PropositionPredicate,
  PropositionStatus,
  PropositionSubject,
} from "./contracts";
import { EPISTEMIC_HEURISTIC_VERSION, EPISTEMIC_STATE_VERSION } from "./contracts";
import { epistemicHash, evidenceFingerprint, validateEvidenceSource } from "./source-precedence";

export const UNKNOWN_FRESHNESS: EvidenceFreshness = {
  status: "UNKNOWN",
  reason: "No selected evidence",
};

export const UNSUPPORTED_CONFIDENCE: ConfidenceAssessment = {
  level: "UNSUPPORTED",
  basis: "NO_SUPPORT",
  heuristicVersion: EPISTEMIC_HEURISTIC_VERSION,
  reasonCodes: ["NO_EVIDENCE"],
};

export function unknownProposition(definition: PropositionDefinition): Proposition {
  return {
    id: definition.id,
    subject: definition.subject,
    predicate: definition.predicate,
    status: "UNKNOWN",
    value: { kind: "UNAVAILABLE" },
    freshness: { ...UNKNOWN_FRESHNESS },
    confidence: { ...UNSUPPORTED_CONFIDENCE, reasonCodes: [...UNSUPPORTED_CONFIDENCE.reasonCodes] },
    evidenceRefs: [],
    dependencyRefs: [...(definition.dependencyRefs ?? [])],
    contradictingEvidenceRefs: [],
  };
}

export function createEpistemicState(input: {
  scope: EpistemicScope;
  asOf: string;
  propositions: PropositionDefinition[];
}): EpistemicState {
  assertIso(input.asOf, "asOf");
  if (!input.scope.tenantId.trim() || !input.scope.principalId.trim() || !input.scope.decisionId.trim()) {
    throw new Error("Epistemic scope requires trusted tenant, principal, and decision identities");
  }
  const ids = new Set<string>();
  const propositions = input.propositions.map((definition) => {
    if (!definition.id.trim()) throw new Error("Proposition id cannot be empty");
    if (ids.has(definition.id)) throw new Error(`Duplicate proposition id: ${definition.id}`);
    ids.add(definition.id);
    return unknownProposition(definition);
  });
  const dependencies = input.propositions.flatMap((definition) => (definition.dependencyRefs ?? []).map((dependsOnPropositionId) => ({
    id: `dependency:${epistemicHash({ propositionId: definition.id, dependsOnPropositionId, kind: "DERIVED_FROM" }).slice(0, 24)}`,
    propositionId: definition.id,
    dependsOnPropositionId,
    kind: "DERIVED_FROM" as const,
  })));
  return {
    version: EPISTEMIC_STATE_VERSION,
    scope: { ...input.scope },
    asOf: input.asOf,
    propositions,
    canonicalTruth: [],
    evidence: [],
    conflicts: [],
    unknowns: propositions.map((proposition) => ({ propositionId: proposition.id, reason: "NO_EVIDENCE" as const })),
    freshness: propositions.map((proposition) => ({ propositionId: proposition.id, status: "UNKNOWN" as const, evaluatedAt: input.asOf })),
    provenance: propositions.map((proposition) => ({ propositionId: proposition.id, evidenceRefs: [], selectedEvidenceRefs: [], dependencyRefs: [...proposition.dependencyRefs], complete: false })),
    dependencies,
    transitions: [],
  };
}

export function addPropositionDefinitions(
  state: EpistemicState,
  definitions: readonly PropositionDefinition[],
): EpistemicState {
  const existing = new Set(state.propositions.map((proposition) => proposition.id));
  const additions = definitions.filter((definition) => !existing.has(definition.id)).map(unknownProposition);
  if (additions.length === 0) return state;
  return {
    ...state,
    propositions: [...state.propositions, ...additions],
    unknowns: [...state.unknowns, ...additions.map((proposition) => ({ propositionId: proposition.id, reason: "NO_EVIDENCE" as const }))],
    freshness: [...state.freshness, ...additions.map((proposition) => ({ propositionId: proposition.id, status: "UNKNOWN" as const, evaluatedAt: state.asOf }))],
    provenance: [...state.provenance, ...additions.map((proposition) => ({ propositionId: proposition.id, evidenceRefs: [], selectedEvidenceRefs: [], dependencyRefs: [...proposition.dependencyRefs], complete: false }))],
    dependencies: [
      ...state.dependencies,
      ...additions.flatMap((proposition) => proposition.dependencyRefs.map((dependsOnPropositionId) => ({
        id: `dependency:${epistemicHash({ propositionId: proposition.id, dependsOnPropositionId, kind: "DERIVED_FROM" }).slice(0, 24)}`,
        propositionId: proposition.id,
        dependsOnPropositionId,
        kind: "DERIVED_FROM" as const,
      }))),
    ],
  };
}

export function initialAcquisitionUsage(): AcquisitionUsage {
  return { actions: 0, userInterruptions: 0, latencyMs: 0, costUnits: 0, selectedActionFingerprints: [] };
}

export function propositionById(state: EpistemicState, id: string): Proposition | undefined {
  return state.propositions.find((proposition) => proposition.id === id);
}

export function requirementResolved(
  state: EpistemicState,
  requirement: DecisionRequirement,
): boolean {
  const proposition = propositionById(state, requirement.propositionId);
  if (!proposition || !requirement.acceptableStatuses.includes(proposition.status)) return false;
  if (proposition.status !== "KNOWN") return false;
  if (requirement.maximumAgeMs !== undefined && proposition.freshness.ageMs !== undefined && proposition.freshness.ageMs > requirement.maximumAgeMs) return false;
  if (requirement.minimumAuthority && (!proposition.sourceAuthority || !requirement.minimumAuthority.includes(proposition.sourceAuthority))) return false;
  if (requirement.minimumConfidence && !confidenceAtLeast(proposition.confidence.level, requirement.minimumConfidence)) return false;
  return consequentialProvenanceSatisfied(state, proposition.id);
}

const CONFIDENCE_RANK: Readonly<Record<ConfidenceAssessment["level"], number>> = {
  VERIFIED: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  UNSUPPORTED: 4,
};

export function confidenceAtLeast(
  actual: ConfidenceAssessment["level"],
  minimum: Exclude<ConfidenceAssessment["level"], "UNSUPPORTED">,
): boolean {
  return CONFIDENCE_RANK[actual] <= CONFIDENCE_RANK[minimum];
}

/** The required invariant: a belief without provenance cannot satisfy a
 * consequential precondition. Canonical truth carries a canonical evidence ref. */
export function consequentialProvenanceSatisfied(state: EpistemicState, propositionId: string): boolean {
  const proposition = propositionById(state, propositionId);
  if (!proposition || proposition.status !== "KNOWN" || proposition.evidenceRefs.length === 0) return false;
  const evidenceById = new Map(state.evidence.map((record) => [record.id, record]));
  if (!proposition.evidenceRefs.every((ref) => evidenceById.has(ref))) return false;
  const trace = (record: EvidenceRecord, active: Set<string>): { complete: boolean; consequentialLeaf: boolean } => {
    if (active.has(record.id) || record.provenance.sourceRef !== record.source.ref) return { complete: false, consequentialLeaf: false };
    if (record.source.kind !== "DERIVED") {
      return { complete: true, consequentialLeaf: record.source.role === "answer_evidence" };
    }
    if (record.provenance.parentEvidenceRefs.length === 0) return { complete: false, consequentialLeaf: false };
    const nextActive = new Set(active).add(record.id);
    const parents = record.provenance.parentEvidenceRefs.map((ref) => evidenceById.get(ref));
    if (parents.some((parent) => !parent)) return { complete: false, consequentialLeaf: false };
    const results = parents.map((parent) => trace(parent!, nextActive));
    return {
      complete: results.every((result) => result.complete),
      consequentialLeaf: results.some((result) => result.consequentialLeaf),
    };
  };
  const selected = proposition.evidenceRefs.map((ref) => evidenceById.get(ref)!);
  const traces = selected.map((record) => trace(record, new Set()));
  if (!traces.every((result) => result.complete) || !traces.some((result) => result.consequentialLeaf)) return false;
  const provenance = state.provenance.find((entry) => entry.propositionId === propositionId);
  return provenance?.complete === true && provenance.selectedEvidenceRefs.length > 0;
}

export function validateEvidenceRecord(record: EvidenceRecord, state: EpistemicState): string[] {
  const errors = validateEvidenceSource(record.source);
  if (!record.id.trim()) errors.push("EVIDENCE_ID_REQUIRED");
  if (!record.propositionId.trim()) errors.push("EVIDENCE_PROPOSITION_REQUIRED");
  if (record.tenantId !== state.scope.tenantId) errors.push("CROSS_TENANT_EVIDENCE");
  if (!state.propositions.some((proposition) => proposition.id === record.propositionId)) errors.push("UNKNOWN_PROPOSITION");
  if (record.immutable !== true) errors.push("EVIDENCE_MUST_BE_IMMUTABLE");
  if (record.canonical !== (record.source.kind === "CANONICAL_DB")) errors.push("CANONICAL_FLAG_SOURCE_MISMATCH");
  if (record.provenance.sourceRef !== record.source.ref) errors.push("PROVENANCE_SOURCE_REF_MISMATCH");
  if (record.source.kind === "DERIVED" && record.provenance.parentEvidenceRefs.length === 0) errors.push("DERIVED_EVIDENCE_REQUIRES_PARENTS");
  for (const field of [[record.observedAt, "observedAt"], [record.ingestedAt, "ingestedAt"], [record.validAt, "validAt"]] as const) {
    if (field[0] !== undefined && !Number.isFinite(Date.parse(field[0]))) errors.push(`INVALID_${field[1].toUpperCase()}`);
  }
  return errors;
}

export function assertEvidenceRecord(record: EvidenceRecord, state: EpistemicState): void {
  const errors = validateEvidenceRecord(record, state);
  if (errors.length) throw new Error(`Invalid epistemic evidence ${record.id}: ${errors.join(",")}`);
  const duplicate = state.evidence.find((candidate) => candidate.id === record.id);
  if (duplicate && evidenceFingerprint(duplicate) !== evidenceFingerprint(record)) {
    throw new Error(`Immutable evidence id collision: ${record.id}`);
  }
}

export function transition(
  propositionId: string,
  from: PropositionStatus,
  to: PropositionStatus,
  evidenceRefs: string[],
  occurredAt: string,
  reasonCode: string,
): BeliefTransition {
  return {
    id: `belief:${propositionId}:${occurredAt}:${from}:${to}:${reasonCode}`,
    propositionId,
    from,
    to,
    evidenceRefs: [...evidenceRefs].sort(),
    occurredAt,
    reasonCode,
  };
}

export function assertIso(value: string, field: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${field} must be an ISO-compatible timestamp`);
}

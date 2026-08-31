import type {
  ConfidenceAssessment,
  EpistemicState,
  EvidenceConflict,
  EvidenceFreshness,
  EvidenceRecord,
  FreshnessStatus,
  InformationObservation,
  JsonValue,
  Proposition,
  PropositionStatus,
  UnknownProposition,
} from "./contracts";
import { EPISTEMIC_HEURISTIC_VERSION } from "./contracts";
import {
  compareEvidenceAuthority,
  epistemicHash,
  equalJson,
  evidenceFingerprint,
  sourceAuthorityRank,
  truthClassRank,
} from "./source-precedence";
import { assertEvidenceRecord, assertIso, transition } from "./state";

function cloneEvidence(record: EvidenceRecord): EvidenceRecord {
  return {
    ...record,
    source: { ...record.source },
    confidence: { ...record.confidence, reasonCodes: [...record.confidence.reasonCodes] },
    freshness: { ...record.freshness },
    provenance: {
      ...record.provenance,
      parentEvidenceRefs: [...record.provenance.parentEvidenceRefs],
      dependencyRefs: [...record.provenance.dependencyRefs],
      ...(record.provenance.derivation ? { derivation: { ...record.provenance.derivation } } : {}),
    },
    ...(record.supersedesEvidenceRefs ? { supersedesEvidenceRefs: [...record.supersedesEvidenceRefs] } : {}),
  };
}

function evidenceTime(record: EvidenceRecord): number {
  return Date.parse(record.validAt ?? record.observedAt);
}

function evaluatedFreshness(record: EvidenceRecord, asOf: string): EvidenceFreshness {
  if (record.freshness.status === "EXPIRED") return { ...record.freshness };
  const ageMs = Math.max(0, Date.parse(asOf) - evidenceTime(record));
  if (record.freshness.status === "STALE") return { ...record.freshness, ageMs };
  if (record.freshness.maxAgeMs === undefined) return { ...record.freshness, ageMs };
  if (ageMs <= record.freshness.maxAgeMs) {
    return { status: "FRESH", maxAgeMs: record.freshness.maxAgeMs, ageMs, reason: "Within configured freshness window" };
  }
  if (ageMs <= record.freshness.maxAgeMs * 3) {
    return { status: "STALE", maxAgeMs: record.freshness.maxAgeMs, ageMs, reason: "Configured freshness window elapsed" };
  }
  return { status: "EXPIRED", maxAgeMs: record.freshness.maxAgeMs, ageMs, reason: "Evidence exceeded three freshness windows" };
}

function sameAuthorityTier(left: EvidenceRecord, right: EvidenceRecord, subject: Proposition["subject"]): boolean {
  if (subject.kind === "user_intent") {
    const leftIntent = left.source.authority === "USER_INTENT_OWNER";
    const rightIntent = right.source.authority === "USER_INTENT_OWNER";
    if (leftIntent !== rightIntent) return false;
  }
  return left.source.truthClass === right.source.truthClass && left.source.authority === right.source.authority;
}

function confidenceFor(records: EvidenceRecord[], canonical: boolean): ConfidenceAssessment {
  if (canonical) {
    return {
      level: "VERIFIED",
      basis: "DETERMINISTIC_SOURCE",
      heuristicVersion: EPISTEMIC_HEURISTIC_VERSION,
      reasonCodes: ["CANONICAL_TRUTH_SELECTED"],
    };
  }
  const corroboratingOwners = new Set(records.map((record) => `${record.source.owner}:${record.source.ref}`)).size;
  const best = records
    .map((record) => record.confidence)
    .sort((left, right) => confidenceRank(left.level) - confidenceRank(right.level))[0];
  if (corroboratingOwners > 1 && best && confidenceRank(best.level) <= confidenceRank("MEDIUM")) {
    return {
      level: best.level === "VERIFIED" ? "VERIFIED" : "HIGH",
      basis: "CORROBORATED",
      heuristicVersion: EPISTEMIC_HEURISTIC_VERSION,
      reasonCodes: ["MULTIPLE_CONSISTENT_SOURCES"],
    };
  }
  return best ? { ...best, reasonCodes: [...best.reasonCodes] } : {
    level: "UNSUPPORTED",
    basis: "NO_SUPPORT",
    heuristicVersion: EPISTEMIC_HEURISTIC_VERSION,
    reasonCodes: ["NO_EVIDENCE"],
  };
}

const CONFIDENCE_RANK: Record<ConfidenceAssessment["level"], number> = {
  VERIFIED: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  UNSUPPORTED: 4,
};

function confidenceRank(level: ConfidenceAssessment["level"]): number {
  return CONFIDENCE_RANK[level];
}

function conflict(
  propositionId: string,
  evidenceRefs: string[],
  resolution: EvidenceConflict["resolution"],
  winningEvidenceRefs: string[],
  reasonCode: string,
): EvidenceConflict {
  const refs = [...new Set(evidenceRefs)].sort();
  return {
    id: `conflict:${epistemicHash({ propositionId, refs, resolution, winningEvidenceRefs, reasonCode }).slice(0, 24)}`,
    propositionId,
    evidenceRefs: refs,
    resolution,
    winningEvidenceRefs: [...new Set(winningEvidenceRefs)].sort(),
    reasonCode,
  };
}

interface PropositionEvaluation {
  proposition: Proposition;
  conflicts: EvidenceConflict[];
  reasonCode: string;
}

function evaluateProposition(
  base: Proposition,
  records: EvidenceRecord[],
  allPropositions: Proposition[],
  asOf: string,
): PropositionEvaluation {
  if (records.length === 0) {
    return {
      proposition: {
        ...base,
        status: "UNKNOWN",
        value: { kind: "UNAVAILABLE" },
        source: undefined,
        sourceAuthority: undefined,
        observedAt: undefined,
        validAt: undefined,
        freshness: { status: "UNKNOWN", reason: "No evidence" },
        confidence: { level: "UNSUPPORTED", basis: "NO_SUPPORT", heuristicVersion: EPISTEMIC_HEURISTIC_VERSION, reasonCodes: ["NO_EVIDENCE"] },
        evidenceRefs: [],
        contradictingEvidenceRefs: [],
      },
      conflicts: [],
      reasonCode: "NO_EVIDENCE",
    };
  }

  const sorted = [...records].sort((left, right) => compareEvidenceAuthority(left, right, base.subject));
  const winner = sorted[0]!;
  const winnerTier = sorted.filter((record) => sameAuthorityTier(winner, record, base.subject));
  const newestTime = Math.max(...winnerTier.map(evidenceTime));
  const newest = winnerTier.filter((record) => evidenceTime(record) === newestTime);
  const superseding = newest.filter((record) => (record.supersedesEvidenceRefs?.length ?? 0) > 0);
  const selectedTier = superseding.length > 0 ? superseding : newest;
  const selectedValue = selectedTier[0]!.value;
  const sameTimeConflict = selectedTier.some((record) => !equalJson(record.value, selectedValue));
  const staleValues = winnerTier.filter((record) => evidenceTime(record) < newestTime && !equalJson(record.value, selectedValue));
  const lowerContradictions = sorted.filter((record) => !sameAuthorityTier(winner, record, base.subject) && !equalJson(record.value, selectedValue));
  const conflicts: EvidenceConflict[] = [];

  if (sameTimeConflict) {
    const refs = selectedTier.map((record) => record.id);
    conflicts.push(conflict(base.id, refs, "UNRESOLVED", [], "EQUAL_AUTHORITY_CONFLICT"));
    return {
      proposition: {
        ...base,
        status: "CONFLICTING",
        value: { kind: "ALTERNATIVES", alternatives: selectedTier.map((record) => ({ value: record.value, evidenceRefs: [record.id] })) },
        source: { ...winner.source },
        sourceAuthority: winner.source.authority,
        observedAt: winner.observedAt,
        ...(winner.validAt ? { validAt: winner.validAt } : {}),
        freshness: evaluatedFreshness(winner, asOf),
        confidence: { level: "LOW", basis: "SOURCE_ASSERTION", heuristicVersion: EPISTEMIC_HEURISTIC_VERSION, reasonCodes: ["EQUAL_AUTHORITY_CONFLICT"] },
        evidenceRefs: refs.sort(),
        contradictingEvidenceRefs: refs.sort(),
      },
      conflicts,
      reasonCode: "EQUAL_AUTHORITY_CONFLICT",
    };
  }

  if (staleValues.length > 0) {
    const resolution = superseding.length > 0 ? "EXPLICIT_SUPERSESSION" : "FRESHER_SAME_AUTHORITY_WINS";
    conflicts.push(conflict(base.id, [...selectedTier, ...staleValues].map((record) => record.id), resolution, selectedTier.map((record) => record.id), resolution));
  }
  if (lowerContradictions.length > 0) {
    conflicts.push(conflict(base.id, [...selectedTier, ...lowerContradictions].map((record) => record.id), "HIGHER_AUTHORITY_WINS", selectedTier.map((record) => record.id), "STRICT_TRUTH_PRECEDENCE"));
  }

  const freshness = evaluatedFreshness(selectedTier[0]!, asOf);
  const confidence = confidenceFor(selectedTier.filter((record) => equalJson(record.value, selectedValue)), selectedTier.some((record) => record.canonical));
  const unresolvedDependency = base.dependencyRefs.some((dependencyId) => allPropositions.find((candidate) => candidate.id === dependencyId)?.status !== "KNOWN");
  let status: PropositionStatus = "KNOWN";
  let reasonCode = "EVIDENCE_SELECTED";
  if (freshness.status === "STALE" || freshness.status === "EXPIRED") {
    status = "STALE";
    reasonCode = "SELECTED_EVIDENCE_STALE";
  } else if (confidence.level === "LOW" || confidence.level === "UNSUPPORTED" || unresolvedDependency) {
    status = "UNCERTAIN";
    reasonCode = unresolvedDependency ? "DEPENDENCY_UNRESOLVED" : "LOW_CONFIDENCE_EVIDENCE";
  }
  const selectedRefs = selectedTier.filter((record) => equalJson(record.value, selectedValue)).map((record) => record.id).sort();
  return {
    proposition: {
      ...base,
      status,
      value: { kind: "DETERMINISTIC", value: selectedValue },
      source: { ...selectedTier[0]!.source },
      sourceAuthority: selectedTier[0]!.source.authority,
      observedAt: selectedTier[0]!.observedAt,
      ...(selectedTier[0]!.validAt ? { validAt: selectedTier[0]!.validAt } : {}),
      freshness,
      confidence,
      evidenceRefs: selectedRefs,
      contradictingEvidenceRefs: [...new Set([...staleValues, ...lowerContradictions].map((record) => record.id))].sort(),
    },
    conflicts,
    reasonCode,
  };
}

/** Append evidence, then recompute every proposition deterministically from the full
 * immutable evidence history. No current belief is patched in place. */
export function appendEvidenceAndRecompute(
  state: EpistemicState,
  incoming: readonly EvidenceRecord[],
  asOf: string,
): EpistemicState {
  assertIso(asOf, "asOf");
  const evidence = state.evidence.map(cloneEvidence);
  const byId = new Map(evidence.map((record) => [record.id, record]));
  const availableEvidenceRefs = new Set([...byId.keys(), ...incoming.map((record) => record.id)]);
  const availablePropositionRefs = new Set(state.propositions.map((proposition) => proposition.id));
  for (const record of incoming) {
    assertEvidenceRecord(record, state);
    if (record.source.kind === "DERIVED" && record.provenance.parentEvidenceRefs.some((ref) => !availableEvidenceRefs.has(ref))) {
      throw new Error(`Invalid epistemic evidence ${record.id}: DERIVED_PARENT_EVIDENCE_NOT_FOUND`);
    }
    if (record.provenance.dependencyRefs.some((ref) => !availablePropositionRefs.has(ref))) {
      throw new Error(`Invalid epistemic evidence ${record.id}: EVIDENCE_DEPENDENCY_PROPOSITION_NOT_FOUND`);
    }
    const existing = byId.get(record.id);
    if (existing) {
      if (evidenceFingerprint(existing) !== evidenceFingerprint(record)) throw new Error(`Immutable evidence id collision: ${record.id}`);
      continue;
    }
    const copy = cloneEvidence(record);
    evidence.push(copy);
    byId.set(copy.id, copy);
  }
  evidence.sort((left, right) => left.id.localeCompare(right.id));

  const prior = new Map(state.propositions.map((proposition) => [proposition.id, proposition]));
  let working = state.propositions.map((proposition) => ({ ...proposition }));
  // Dependencies can reference later propositions, so converge in a small bounded
  // number of deterministic passes instead of relying on input order.
  let evaluations: PropositionEvaluation[] = [];
  for (let pass = 0; pass < Math.max(1, working.length); pass += 1) {
    evaluations = working.map((proposition) => evaluateProposition(
      proposition,
      evidence.filter((record) => record.propositionId === proposition.id),
      working,
      asOf,
    ));
    const next = evaluations.map((evaluation) => evaluation.proposition);
    const stable = next.every((proposition, index) => proposition.status === working[index]?.status);
    working = next;
    if (stable) break;
  }

  const transitions = [...state.transitions];
  for (const evaluation of evaluations) {
    const before = prior.get(evaluation.proposition.id)?.status ?? "UNKNOWN";
    if (before !== evaluation.proposition.status) {
      transitions.push(transition(
        evaluation.proposition.id,
        before,
        evaluation.proposition.status,
        evaluation.proposition.evidenceRefs,
        asOf,
        evaluation.reasonCode,
      ));
    }
  }

  const selectedEvidenceRefs = new Set(working.flatMap((proposition) => proposition.evidenceRefs));
  const canonicalTruth = evidence
    .filter((record) => record.canonical && selectedEvidenceRefs.has(record.id))
    .map((record) => ({
      propositionId: record.propositionId,
      evidenceRef: record.id,
      owner: record.source.owner,
      sourceRef: record.source.ref,
      value: record.value,
      observedAt: record.observedAt,
      ...(record.validAt ? { validAt: record.validAt } : {}),
    }))
    .sort((left, right) => `${left.propositionId}:${left.evidenceRef}`.localeCompare(`${right.propositionId}:${right.evidenceRef}`));
  const conflicts = evaluations.flatMap((evaluation) => evaluation.conflicts).sort((left, right) => left.id.localeCompare(right.id));
  const unknowns: UnknownProposition[] = working.flatMap<UnknownProposition>((proposition) => {
    if (proposition.status === "UNKNOWN") return [{ propositionId: proposition.id, reason: "NO_EVIDENCE" as const }];
    if (proposition.status === "STALE") return [{ propositionId: proposition.id, reason: "ONLY_STALE_EVIDENCE" as const }];
    if (proposition.status === "CONFLICTING") return [{ propositionId: proposition.id, reason: "CONFLICT_UNRESOLVED" as const }];
    if (proposition.status === "UNCERTAIN") return [{ propositionId: proposition.id, reason: "LOW_CONFIDENCE" as const }];
    return [];
  });
  return {
    ...state,
    asOf,
    propositions: working,
    canonicalTruth,
    evidence,
    conflicts,
    unknowns,
    freshness: working.map((proposition) => ({
      propositionId: proposition.id,
      status: proposition.freshness.status,
      evaluatedAt: asOf,
      ...(proposition.observedAt ? { newestEvidenceAt: proposition.observedAt } : {}),
      ...(proposition.freshness.maxAgeMs === undefined ? {} : { maxAgeMs: proposition.freshness.maxAgeMs }),
    })),
    provenance: working.map((proposition) => ({
      propositionId: proposition.id,
      evidenceRefs: evidence.filter((record) => record.propositionId === proposition.id).map((record) => record.id).sort(),
      selectedEvidenceRefs: [...proposition.evidenceRefs],
      dependencyRefs: [...proposition.dependencyRefs],
      complete: proposition.evidenceRefs.length > 0 && proposition.evidenceRefs.every((ref) => byId.has(ref)),
    })),
    transitions,
  };
}

export function applyInformationObservation(state: EpistemicState, observation: InformationObservation): EpistemicState {
  if (observation.tenantId !== state.scope.tenantId) throw new Error("Cross-tenant information observation rejected");
  if (!Number.isFinite(Date.parse(observation.observedAt))) throw new Error("Information observation timestamp is invalid");
  if (observation.outcome === "OBSERVED" && observation.evidence.length === 0) throw new Error("Observed information requires evidence");
  if (observation.outcome !== "OBSERVED" && observation.evidence.length > 0) throw new Error("Non-observed information outcome cannot carry evidence");
  if (["FAILED", "PERMISSION_BLOCKED"].includes(observation.outcome) && !observation.failureCode) {
    throw new Error("Failed or permission-blocked information observation requires a failure code");
  }
  if (!state.propositions.every((proposition) => proposition.id) || observation.propositionIds.some((id) => !state.propositions.some((proposition) => proposition.id === id))) {
    throw new Error("Information observation references an unknown proposition");
  }
  if (observation.evidence.some((record) => !observation.propositionIds.includes(record.propositionId))) {
    throw new Error("Information evidence is outside the observation proposition set");
  }
  return appendEvidenceAndRecompute(state, observation.evidence, observation.observedAt);
}

export function advanceEpistemicClock(state: EpistemicState, asOf: string): EpistemicState {
  return appendEvidenceAndRecompute(state, [], asOf);
}

export function createEvidenceRecord(input: Omit<EvidenceRecord, "immutable">): EvidenceRecord {
  return { ...input, immutable: true };
}

export function effectiveFreshnessStatus(record: EvidenceRecord, asOf: string): FreshnessStatus {
  return evaluatedFreshness(record, asOf).status;
}

export function valueOfKnown(proposition: Proposition): JsonValue | undefined {
  return proposition.status === "KNOWN" && proposition.value.kind === "DETERMINISTIC" ? proposition.value.value : undefined;
}

/** Exposed for deterministic ordering/property tests. */
export function evidenceSelectionKey(record: EvidenceRecord): readonly [number, number, number, string] {
  return [
    truthClassRank(record.source.truthClass),
    sourceAuthorityRank(record.source.authority),
    -evidenceTime(record),
    record.id,
  ];
}

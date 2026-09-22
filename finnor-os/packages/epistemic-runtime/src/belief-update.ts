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
  PropositionDerivationExpression,
  PropositionStatus,
  UnknownProposition,
} from "./contracts";
import { EPISTEMIC_HEURISTIC_VERSION } from "./contracts";
import {
  compareEvidenceAuthority,
  canonicalJson,
  epistemicHash,
  equalJson,
  evidenceFingerprint,
  sourceAuthorityRank,
  truthClassRank,
} from "./source-precedence";
import { assertEvidenceRecord, assertIso, transition, unknownProposition } from "./state";
import type { PropositionDefinition } from "./contracts";

export interface EpistemicEvaluationTime {
  validAt: string;
  knownAt: string;
}

function evaluationTime(asOf: string, time?: EpistemicEvaluationTime): EpistemicEvaluationTime {
  const result = time ?? { validAt: asOf, knownAt: asOf };
  assertIso(result.validAt, "validAt");
  assertIso(result.knownAt, "knownAt");
  return result;
}

function isVisible(record: EvidenceRecord, time: EpistemicEvaluationTime): boolean {
  return Date.parse(record.ingestedAt) <= Date.parse(time.knownAt)
    && (record.validAt === undefined || Date.parse(record.validAt) <= Date.parse(time.validAt))
    && (record.validTo === undefined || Date.parse(time.validAt) < Date.parse(record.validTo));
}

function cloneJson<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneJson(nested)])) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function cloneEvidence(record: EvidenceRecord): EvidenceRecord {
  return deepFreeze({
    ...record,
    source: { ...record.source },
    value: cloneJson(record.value),
    confidence: { ...record.confidence, reasonCodes: [...record.confidence.reasonCodes] },
    freshness: { ...record.freshness },
    provenance: {
      ...record.provenance,
      parentEvidenceRefs: [...record.provenance.parentEvidenceRefs],
      dependencyRefs: [...record.provenance.dependencyRefs],
      ...(record.provenance.derivation ? { derivation: { ...record.provenance.derivation } } : {}),
    },
    ...(record.supersedesEvidenceRefs ? { supersedesEvidenceRefs: [...record.supersedesEvidenceRefs] } : {}),
  });
}

function evidenceTime(record: EvidenceRecord): number {
  return Date.parse(record.validAt ?? record.observedAt);
}

function evaluatedFreshness(record: EvidenceRecord, asOf: string): EvidenceFreshness {
  if (record.freshness.status === "EXPIRED") return { ...record.freshness };
  // A late correction can be valid for an old period without already being stale.
  const ageMs = Math.max(0, Date.parse(asOf) - Date.parse(record.observedAt));
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

type DerivationTruth = "true" | "false" | "unknown";
interface DerivationEvaluation { truth: DerivationTruth; used: Proposition[] }

function propositionValueHash(proposition: Proposition): string {
  return proposition.valueHash ?? `sha256:${epistemicHash(proposition.value)}`;
}

function evaluateDerivationExpression(
  expression: PropositionDerivationExpression,
  propositions: ReadonlyMap<string, Proposition>,
): DerivationEvaluation {
  if (expression.op === "require") {
    const proposition = propositions.get(expression.propositionId);
    const statuses = expression.acceptableStatuses ?? ["KNOWN"];
    if (!proposition || !statuses.includes(proposition.status)) return { truth: "unknown", used: proposition ? [proposition] : [] };
    return {
      truth: expression.expectedValueHashes.includes(propositionValueHash(proposition)) ? "true" : "false",
      used: [proposition],
    };
  }
  const terms = expression.terms.map((term) => evaluateDerivationExpression(term,propositions));
  if (expression.op === "all") {
    const decisive = terms.filter((term) => term.truth === "false");
    if (decisive.length) return { truth: "false", used: decisive.flatMap((term) => term.used) };
    if (terms.some((term) => term.truth === "unknown")) return { truth: "unknown", used: terms.flatMap((term) => term.used) };
    return { truth: "true", used: terms.flatMap((term) => term.used) };
  }
  const decisive = terms.filter((term) => term.truth === "true");
  if (decisive.length) return { truth: "true", used: decisive.flatMap((term) => term.used) };
  if (terms.some((term) => term.truth === "unknown")) return { truth: "unknown", used: terms.flatMap((term) => term.used) };
  return { truth: "false", used: terms.flatMap((term) => term.used) };
}

function evaluateDerivedProposition(
  base: Proposition,
  allPropositions: ReadonlyMap<string, Proposition>,
): PropositionEvaluation | null {
  const derivation = base.predicate.derivation;
  if (!derivation) return null;
  const evaluated = evaluateDerivationExpression(derivation.expression,allPropositions);
  if (evaluated.truth === "unknown") {
    return {
      proposition: {
        ...base,status:"UNKNOWN",value:{ kind:"UNAVAILABLE" },source:undefined,sourceAuthority:undefined,
        observedAt:undefined,validAt:undefined,freshness:{ status:"UNKNOWN",reason:"Derived dependency unresolved" },
        confidence:{ level:"UNSUPPORTED",basis:"NO_SUPPORT",heuristicVersion:EPISTEMIC_HEURISTIC_VERSION,
          reasonCodes:["DERIVATION_DEPENDENCY_UNRESOLVED"] },evidenceRefs:[],contradictingEvidenceRefs:[],
      },
      conflicts:[],reasonCode:"DERIVATION_DEPENDENCY_UNRESOLVED",
    };
  }
  const used = [...new Map(evaluated.used.map((row) => [row.id,row])).values()].sort((a,b) => a.id.localeCompare(b.id));
  const canonical = used.length > 0 && used.every((row) => row.sourceAuthority === "CANONICAL_OWNER"
    && row.confidence.level === "VERIFIED");
  const observed = used.map((row) => row.observedAt).filter((value): value is string => Boolean(value))
    .sort().at(-1);
  const refs = [...new Set(used.flatMap((row) => row.evidenceRefs))].sort();
  return {
    proposition: {
      ...base,status:"KNOWN",value:{ kind:"DETERMINISTIC",value:evaluated.truth === "true" },
      source: canonical
        ? { kind:"CANONICAL_DB",owner:derivation.owner,ref:`${derivation.ruleId}:${derivation.version}`,authority:"CANONICAL_OWNER",truthClass:"CANONICAL",role:"answer_evidence" }
        : { kind:"DERIVED",owner:derivation.owner,ref:`${derivation.ruleId}:${derivation.version}`,authority:"DERIVED_ONLY",truthClass:"MEMORY",role:"answer_evidence" },
      sourceAuthority: canonical ? "CANONICAL_OWNER" : "DERIVED_ONLY",
      ...(observed ? { observedAt:observed,validAt:observed } : {}),
      freshness:{ status:"FRESH",reason:"Versioned deterministic dependency rule" },
      confidence: canonical
        ? { level:"VERIFIED",basis:"DETERMINISTIC_SOURCE",heuristicVersion:EPISTEMIC_HEURISTIC_VERSION,reasonCodes:["CANONICAL_DERIVATION"] }
        : { level:"LOW",basis:"DERIVED_HEURISTIC",heuristicVersion:EPISTEMIC_HEURISTIC_VERSION,reasonCodes:["NON_CANONICAL_DERIVATION"] },
      evidenceRefs:refs,contradictingEvidenceRefs:[],
    },
    conflicts:[],reasonCode:evaluated.truth === "true" ? "DERIVATION_TRUE" : "DERIVATION_FALSE",
  };
}

/** A bounded durable worker evaluates one indexed proposition at a time using
 * the same selector as the in-memory oracle. Dependencies are already resolved
 * by the durable topological frontier. */
export function evaluateBoundProposition(input: {
  definition: PropositionDefinition;
  evidence: readonly EvidenceRecord[];
  dependencies: ReadonlyMap<string, Proposition>;
  time: EpistemicEvaluationTime;
}): { proposition: Proposition; conflicts: EvidenceConflict[]; reasonCode: string } {
  const at = evaluationTime(input.time.knownAt, input.time);
  return evaluateProposition(
    unknownProposition(input.definition),
    input.evidence.filter((record) => record.propositionId === input.definition.id && isVisible(record, at)),
    input.dependencies,
    at.knownAt,
  );
}

function evaluateProposition(
  base: Proposition,
  records: EvidenceRecord[],
  allPropositions: ReadonlyMap<string, Proposition>,
  asOf: string,
): PropositionEvaluation {
  if (records.length === 0) {
    const derived = evaluateDerivedProposition(base,allPropositions);
    if (derived) return derived;
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
        value: { kind: "ALTERNATIVES", alternatives: selectedTier.map((record) => ({ value: cloneJson(record.value), evidenceRefs: [record.id] })) },
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
  const unresolvedDependency = base.dependencyRefs.some((dependencyId) => allPropositions.get(dependencyId)?.status !== "KNOWN");
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
      value: { kind: "DETERMINISTIC", value: cloneJson(selectedValue) },
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
  time?: EpistemicEvaluationTime,
): EpistemicState {
  assertIso(asOf, "asOf");
  const at = evaluationTime(asOf, time);
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
  const visibleByProposition = new Map<string, EvidenceRecord[]>();
  for (const record of evidence) {
    if (!isVisible(record, at)) continue;
    const rows = visibleByProposition.get(record.propositionId) ?? [];
    rows.push(record);
    visibleByProposition.set(record.propositionId, rows);
  }
  // Full recomputation remains independent of the incremental dirty frontier.
  // The graph is a DAG: one complete topological sweep is equivalent to the old
  // fixed-point passes, including when definitions arrived out of input order.
  const propositionIndex = new Map(state.propositions.map((proposition) => [proposition.id, { ...proposition }]));
  const visited = new Set<string>();
  const ordered: string[] = [];
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    const proposition = propositionIndex.get(id);
    if (!proposition) throw new Error(`Full recompute missing proposition ${id}`);
    visited.add(id);
    for (const parent of proposition.dependencyRefs) visit(parent);
    ordered.push(id);
  };
  for (const proposition of state.propositions) visit(proposition.id);
  const evaluatedById = new Map<string, PropositionEvaluation>();
  for (const id of ordered) {
    const result = evaluateProposition(propositionIndex.get(id)!, visibleByProposition.get(id) ?? [], propositionIndex, at.knownAt);
    propositionIndex.set(id,result.proposition);
    evaluatedById.set(id,result);
  }
  const evaluations = state.propositions.map((proposition) => evaluatedById.get(proposition.id)!);
  const working = evaluations.map((evaluation) => evaluation.proposition);

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
    .filter((record) => record.canonical && selectedEvidenceRefs.has(record.id) && isVisible(record, at))
    .map((record) => ({
      propositionId: record.propositionId,
      evidenceRef: record.id,
      owner: record.source.owner,
      sourceRef: record.source.ref,
      value: cloneJson(record.value),
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
    validAt: at.validAt,
    knownAt: at.knownAt,
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
      evidenceRefs: evidence.filter((record) => record.propositionId === proposition.id && isVisible(record, at)).map((record) => record.id).sort(),
      selectedEvidenceRefs: [...proposition.evidenceRefs],
      dependencyRefs: [...proposition.dependencyRefs],
      complete: proposition.evidenceRefs.length > 0 && proposition.evidenceRefs.every((ref) => byId.has(ref)),
    })),
    transitions,
  };
}

/** The old full recomputation above remains the independent semantic oracle.
 * This path evaluates only new/clock-affected propositions and a dependent only
 * after an effective semantic change in one of its prerequisites. The immutable
 * evidence array is retained for replay; ordinary reads do not patch beliefs. */
export function appendEvidenceIncrementally(
  state: EpistemicState,
  incoming: readonly EvidenceRecord[],
  asOf: string,
  time?: EpistemicEvaluationTime,
): { state: EpistemicState; evaluatedPropositionIds: string[]; changedPropositionIds: string[] } {
  assertIso(asOf, "asOf");
  const at = evaluationTime(asOf, time);
  const previousAt = evaluationTime(state.asOf, {
    validAt: state.validAt ?? state.asOf,
    knownAt: state.knownAt ?? state.asOf,
  });
  const byId = new Map(state.evidence.map((record) => [record.id, record]));
  const availableEvidenceRefs = new Set([...byId.keys(), ...incoming.map((record) => record.id)]);
  const definitions = new Map(state.propositions.map((proposition) => [proposition.id, proposition]));
  const direct = new Set<string>();
  const evidence = [...state.evidence];
  for (const record of incoming) {
    assertEvidenceRecord(record, state);
    if (record.source.kind === "DERIVED" && record.provenance.parentEvidenceRefs.some((ref) => !availableEvidenceRefs.has(ref))) {
      throw new Error(`Invalid epistemic evidence ${record.id}: DERIVED_PARENT_EVIDENCE_NOT_FOUND`);
    }
    if (record.provenance.dependencyRefs.some((ref) => !definitions.has(ref))) {
      throw new Error(`Invalid epistemic evidence ${record.id}: EVIDENCE_DEPENDENCY_PROPOSITION_NOT_FOUND`);
    }
    const existing = byId.get(record.id);
    if (existing) {
      if (evidenceFingerprint(existing) !== evidenceFingerprint(record)) throw new Error(`Immutable evidence id collision: ${record.id}`);
      continue;
    }
    const copy = cloneEvidence(record);
    byId.set(copy.id, copy);
    evidence.push(copy);
    if (isVisible(copy, at)) direct.add(copy.propositionId);
  }
  evidence.sort((left, right) => left.id.localeCompare(right.id));
  const byProposition = new Map<string, EvidenceRecord[]>();
  for (const record of evidence) {
    if (!isVisible(record, at)) continue;
    const records = byProposition.get(record.propositionId) ?? [];
    records.push(record);
    byProposition.set(record.propositionId, records);
    if (!isVisible(record, previousAt)) direct.add(record.propositionId);
  }
  if (at.knownAt !== previousAt.knownAt || at.validAt !== previousAt.validAt) {
    for (const proposition of state.propositions) {
      const selected = proposition.evidenceRefs.map((id) => byId.get(id)).filter((record): record is EvidenceRecord => Boolean(record));
      if (selected.some((record) => evaluatedFreshness(record, at.knownAt).status !== proposition.freshness.status)) {
        direct.add(proposition.id);
      }
    }
  }

  const dependents = new Map<string, string[]>();
  for (const edge of state.dependencies) {
    const ids = dependents.get(edge.dependsOnPropositionId) ?? [];
    ids.push(edge.propositionId);
    dependents.set(edge.dependsOnPropositionId, ids);
  }
  for (const ids of dependents.values()) ids.sort();
  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    const cached = depthMemo.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) throw new Error(`Epistemic proposition dependency cycle at ${id}`);
    visiting.add(id);
    const proposition = definitions.get(id);
    if (!proposition) throw new Error(`Epistemic dependency references unknown proposition ${id}`);
    const value = proposition.dependencyRefs.length === 0
      ? 0 : 1 + Math.max(...proposition.dependencyRefs.map(depth));
    visiting.delete(id);
    depthMemo.set(id, value);
    return value;
  };
  const pending = new Set(direct);
  const working = new Map(definitions);
  const evaluated: string[] = [];
  const changed = new Set<string>();
  const nextConflicts = new Map<string, EvidenceConflict[]>(state.propositions.map((proposition) => [
    proposition.id, state.conflicts.filter((entry) => entry.propositionId === proposition.id),
  ]));
  const priorConflictSignature = new Map([...nextConflicts].map(([id, rows]) => [id, canonicalJson(rows)]));
  const reasons = new Map<string, string>();
  while (pending.size > 0) {
    const id = [...pending].sort((left, right) => depth(left) - depth(right) || left.localeCompare(right))[0]!;
    pending.delete(id);
    const before = working.get(id)!;
    const result = evaluateProposition(before, byProposition.get(id) ?? [], working, at.knownAt);
    working.set(id, result.proposition);
    nextConflicts.set(id, result.conflicts);
    reasons.set(id, result.reasonCode);
    evaluated.push(id);
    if (propositionSemanticFingerprint(before) !== propositionSemanticFingerprint(result.proposition)
      || priorConflictSignature.get(id) !== canonicalJson(result.conflicts)) {
      changed.add(id);
      for (const child of dependents.get(id) ?? []) pending.add(child);
    }
  }
  const selected = new Set([...working.values()].flatMap((proposition) => proposition.evidenceRefs));
  const canonicalTruth = evidence.filter((record) => record.canonical && selected.has(record.id) && isVisible(record, at))
    .map((record) => ({
      propositionId: record.propositionId, evidenceRef: record.id, owner: record.source.owner,
      sourceRef: record.source.ref, value: cloneJson(record.value), observedAt: record.observedAt,
      ...(record.validAt ? { validAt: record.validAt } : {}),
    }))
    .sort((left, right) => `${left.propositionId}:${left.evidenceRef}`.localeCompare(`${right.propositionId}:${right.evidenceRef}`));
  const propositionRows = state.propositions.map((proposition) => working.get(proposition.id)!);
  const evaluatedSet = new Set(evaluated);
  const nextUnknowns = state.unknowns.filter((entry) => !evaluatedSet.has(entry.propositionId));
  const nextFreshness = state.freshness.filter((entry) => !evaluatedSet.has(entry.propositionId));
  const nextProvenance = state.provenance.filter((entry) => !evaluatedSet.has(entry.propositionId));
  const transitions = [...state.transitions];
  for (const id of [...evaluatedSet].sort()) {
    const before = definitions.get(id)!;
    const after = working.get(id)!;
    if (before.status !== after.status) transitions.push(transition(id, before.status, after.status, after.evidenceRefs, asOf, reasons.get(id)!));
    if (after.status === "UNKNOWN") nextUnknowns.push({ propositionId: id, reason: "NO_EVIDENCE" });
    else if (after.status === "STALE") nextUnknowns.push({ propositionId: id, reason: "ONLY_STALE_EVIDENCE" });
    else if (after.status === "CONFLICTING") nextUnknowns.push({ propositionId: id, reason: "CONFLICT_UNRESOLVED" });
    else if (after.status === "UNCERTAIN") nextUnknowns.push({ propositionId: id, reason: "LOW_CONFIDENCE" });
    nextFreshness.push({
      propositionId: id, status: after.freshness.status, evaluatedAt: asOf,
      ...(after.observedAt ? { newestEvidenceAt: after.observedAt } : {}),
      ...(after.freshness.maxAgeMs === undefined ? {} : { maxAgeMs: after.freshness.maxAgeMs }),
    });
    nextProvenance.push({
      propositionId: id,
      evidenceRefs: (byProposition.get(id) ?? []).map((record) => record.id).sort(),
      selectedEvidenceRefs: [...after.evidenceRefs], dependencyRefs: [...after.dependencyRefs],
      complete: after.evidenceRefs.length > 0 && after.evidenceRefs.every((ref) => byId.has(ref)),
    });
  }
  const nextState: EpistemicState = {
    ...state, asOf, validAt: at.validAt, knownAt: at.knownAt,
    propositions: propositionRows, evidence, canonicalTruth,
    conflicts: [...nextConflicts.values()].flat().sort((left, right) => left.id.localeCompare(right.id)),
    unknowns: nextUnknowns.sort((left, right) => left.propositionId.localeCompare(right.propositionId)),
    freshness: nextFreshness.sort((left, right) => left.propositionId.localeCompare(right.propositionId)),
    provenance: nextProvenance.sort((left, right) => left.propositionId.localeCompare(right.propositionId)),
    transitions,
  };
  return {
    state: nextState,
    evaluatedPropositionIds: [...evaluatedSet].sort(),
    changedPropositionIds: [...changed].sort(),
  };
}

/** Excludes the incidental clock age from propagation while retaining every
 * selected source, contradiction, and epistemic classification. */
export function propositionSemanticFingerprint(proposition: Proposition): string {
  return epistemicHash({
    id: proposition.id, subject: proposition.subject, predicate: proposition.predicate,
    status: proposition.status, value: proposition.value, source: proposition.source ?? null,
    sourceAuthority: proposition.sourceAuthority ?? null, observedAt: proposition.observedAt ?? null,
    validAt: proposition.validAt ?? null,
    freshness: { status: proposition.freshness.status, maxAgeMs: proposition.freshness.maxAgeMs ?? null, reason: proposition.freshness.reason },
    confidence: proposition.confidence, evidenceRefs: proposition.evidenceRefs,
    dependencyRefs: proposition.dependencyRefs, contradictingEvidenceRefs: proposition.contradictingEvidenceRefs,
  });
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
  return appendEvidenceIncrementally(state, observation.evidence, observation.observedAt).state;
}

export function advanceEpistemicClock(state: EpistemicState, asOf: string): EpistemicState {
  return appendEvidenceIncrementally(state, [], asOf).state;
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

import type {
  AcquisitionOption,
  DecisionRequirement,
  EpistemicState,
  EvidenceKind,
  EvidenceRecord,
  EvidenceSource,
  PropositionDefinition,
} from "./contracts";
import { EPISTEMIC_HEURISTIC_VERSION } from "./contracts";
import { createEvidenceRecord } from "./belief-update";
import { createEpistemicState } from "./state";

export const TEST_NOW = "2026-08-31T00:00:00.000Z";
export const TEST_TENANT = "11111111-1111-4111-8111-111111111111";

const SOURCE_CLASS: Readonly<Record<EvidenceKind, Pick<EvidenceSource, "authority" | "truthClass">>> = {
  CANONICAL_DB: { authority: "CANONICAL_OWNER", truthClass: "CANONICAL" },
  ACTIVE_WORK: { authority: "WORK_LEDGER", truthClass: "WORK" },
  EXPLICIT_USER_INPUT: { authority: "USER_INTENT_OWNER", truthClass: "SESSION" },
  PROFILE: { authority: "CONFIGURED_PROFILE", truthClass: "PROFILE" },
  SESSION: { authority: "CURRENT_SESSION", truthClass: "SESSION" },
  MEMORY: { authority: "SEMANTIC_MEMORY", truthClass: "MEMORY" },
  DOCUMENT: { authority: "DURABLE_EVIDENCE", truthClass: "MEMORY" },
  PROVIDER_OBSERVATION: { authority: "GOVERNED_OBSERVATION", truthClass: "WORK" },
  COMPUTER_OBSERVATION: { authority: "GOVERNED_OBSERVATION", truthClass: "WORK" },
  WEB_RESEARCH: { authority: "PUBLIC_RESEARCH", truthClass: "WEB" },
  DERIVED: { authority: "DERIVED_ONLY", truthClass: "MEMORY" },
};

export function testDefinition(
  id = "invoice.balance",
  subject: PropositionDefinition["subject"] = { kind: "entity", type: "invoice", id: "invoice-1" },
): PropositionDefinition {
  return { id, subject, predicate: { name: id, operator: "exists" } };
}

export function testState(definitions: PropositionDefinition[] = [testDefinition()]): EpistemicState {
  return createEpistemicState({
    scope: { tenantId: TEST_TENANT, principalId: "employee:test", decisionId: "decision:test" },
    asOf: TEST_NOW,
    propositions: definitions,
  });
}

export function testSource(
  kind: EvidenceKind,
  id: string,
  role: EvidenceSource["role"] = "answer_evidence",
): EvidenceSource {
  return {
    kind,
    owner: kind === "CANONICAL_DB" ? "operational_query:test" : `test:${kind.toLowerCase()}`,
    ref: `fixture:${id}`,
    role,
    ...SOURCE_CLASS[kind],
  };
}

export function testEvidence(input: {
  state: EpistemicState;
  id: string;
  value: EvidenceRecord["value"];
  kind?: EvidenceKind;
  propositionId?: string;
  observedAt?: string;
  ingestedAt?: string;
  tenantId?: string;
  freshness?: EvidenceRecord["freshness"]["status"];
  maxAgeMs?: number;
  confidence?: EvidenceRecord["confidence"]["level"];
  role?: EvidenceSource["role"];
  parentEvidenceRefs?: string[];
  supersedesEvidenceRefs?: string[];
}): EvidenceRecord {
  const kind = input.kind ?? "MEMORY";
  const observedAt = input.observedAt ?? TEST_NOW;
  const source = testSource(kind, input.id, input.role);
  return createEvidenceRecord({
    id: input.id,
    propositionId: input.propositionId ?? input.state.propositions[0]!.id,
    tenantId: input.tenantId ?? input.state.scope.tenantId,
    source,
    observedAt,
    validAt: observedAt,
    ingestedAt: input.ingestedAt ?? TEST_NOW,
    value: input.value,
    confidence: {
      level: input.confidence ?? (kind === "CANONICAL_DB" ? "VERIFIED" : "HIGH"),
      basis: kind === "CANONICAL_DB" ? "DETERMINISTIC_SOURCE" : "SOURCE_ASSERTION",
      heuristicVersion: EPISTEMIC_HEURISTIC_VERSION,
      reasonCodes: ["TEST_EVIDENCE"],
    },
    freshness: {
      status: input.freshness ?? "FRESH",
      ...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }),
      reason: "Test evidence",
    },
    sensitivity: "TENANT_INTERNAL",
    provenance: {
      sourceRef: source.ref,
      parentEvidenceRefs: [...(input.parentEvidenceRefs ?? [])],
      dependencyRefs: [],
      ...(kind === "DERIVED" ? { derivation: { ruleId: "test-derived", version: "1" } } : {}),
    },
    canonical: kind === "CANONICAL_DB",
    ...(input.supersedesEvidenceRefs ? { supersedesEvidenceRefs: [...input.supersedesEvidenceRefs] } : {}),
  });
}

export function testOption(
  kind: AcquisitionOption["kind"] = "READ",
  adapterId: AcquisitionOption["adapterId"] = "CANONICAL_OPERATIONAL_QUERY",
  expectedAuthority: AcquisitionOption["expectedAuthority"] = "CANONICAL_OWNER",
): AcquisitionOption {
  return { kind, adapterId, expectedAuthority, reason: `test:${kind}` };
}

export function testRequirement(
  propositionId = "invoice.balance",
  acquisitionOptions: AcquisitionOption[] = [testOption()],
  overrides: Partial<DecisionRequirement> = {},
): DecisionRequirement {
  return {
    propositionId,
    decisionId: "decision:test",
    description: `Resolve ${propositionId}`,
    criticality: "CONSEQUENTIAL",
    mandatory: true,
    acceptableStatuses: ["KNOWN"],
    minimumConfidence: "HIGH",
    consequenceIfUnresolved: "Consequential decision remains blocked",
    acquisitionOptions,
    ...overrides,
  };
}

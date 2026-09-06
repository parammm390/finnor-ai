import {
  EPISTEMIC_HEURISTIC_VERSION,
  analyzeUncertainty,
  appendEvidenceAndRecompute,
  canonicalOperationalQueryEvidence,
  createEpistemicState,
  evidenceFromExistingSource,
  explicitUserInputEvidence,
  providerObservationEvidence,
  propositionById,
  requirementResolved,
  webResearchEvidence,
  type AcquisitionOption,
  type DecisionRequirement,
  type EpistemicState,
  type EvidenceRecord,
  type JsonValue,
  type PropositionDefinition,
} from "@finnor/epistemic-runtime";
import type {
  PrivateEquityDecisionReadiness,
  PrivateEquityEpistemicWarning,
} from "@finnor/shared-types";
import { isPositiveDependencyResolution } from "./state-machines";
import type { DealCloseEligibility, DealExecutionGraph, PeEntityType } from "./types";

export const PE_PROPOSITION_PREDICATES = [
  "deal.exists",
  "deal.loi_signed",
  "deal.target_close_at",
  "deal.lifecycle_state",
  "workstream.state",
  "request.acknowledged",
  "request.fulfilled",
  "request.overdue",
  "deliverable.received",
  "deliverable.accepted",
  "finding.current",
  "deal_risk.current",
  "dependency.resolved",
  "milestone.achieved",
  "closing_condition.state",
  "closing_condition.evidence_sufficient",
  "closing_condition.waiver_valid",
  "closing_item.ready",
  "closing_item.verified",
  "deal.close_eligible",
] as const;

export type PePropositionPredicate = (typeof PE_PROPOSITION_PREDICATES)[number];

export interface PePropositionCatalogEntry {
  predicate: PePropositionPredicate;
  canonicalOwner: "@finnor/private-equity";
  canonicalTable: string;
  consequential: boolean;
  acceptedAssertionKinds: Array<"provider_observation" | "document_claim" | "user_input">;
  freshness: "canonical_current" | "source_policy_only";
}

const tableForPredicate = (predicate: PePropositionPredicate): string => {
  if (predicate.startsWith("deal.")) return "pe_deals";
  if (predicate.startsWith("workstream.")) return "pe_workstreams";
  if (predicate.startsWith("request.")) return "pe_requests";
  if (predicate.startsWith("deliverable.")) return "pe_deliverables";
  if (predicate.startsWith("finding.")) return "pe_findings";
  if (predicate.startsWith("deal_risk.")) return "pe_deal_risks";
  if (predicate.startsWith("dependency.")) return "pe_dependencies";
  if (predicate.startsWith("milestone.")) return "pe_milestones";
  if (predicate.startsWith("closing_condition.")) return "pe_closing_conditions";
  return "pe_closing_items";
};

export const PE_PROPOSITION_CATALOG: readonly PePropositionCatalogEntry[] = PE_PROPOSITION_PREDICATES.map((predicate) => ({
  predicate,
  canonicalOwner: "@finnor/private-equity" as const,
  canonicalTable: tableForPredicate(predicate),
  // Every published PE proposition is intentionally decision-relevant. The
  // catalog is bounded; facts that are merely descriptive stay in the typed
  // query summaries rather than becoming propositions.
  consequential: true,
  acceptedAssertionKinds: ["provider_observation", "document_claim", "user_input"],
  freshness: "canonical_current" as const,
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(value: unknown): JsonValue {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value as JsonValue;
  if (Array.isArray(value)) return value.map(json);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .map(([key, nested]) => [key, json(nested)]));
  }
  return String(value);
}

export function pePropositionId(
  dealId: string,
  entityType: PeEntityType,
  entityId: string,
  predicate: PePropositionPredicate,
): string {
  return `pe:v1:${dealId}:${entityType}:${entityId}:${predicate}`;
}

export interface PrivateEquityAssertion {
  propositionId: string;
  kind: "provider_observation" | "document_claim" | "user_input" | "memory" | "web";
  value: JsonValue;
  ref: string;
  observedAt: string;
  ingestedAt?: string;
  maximumAgeMs?: number;
  freshnessPolicyRef?: string;
  supersedesEvidenceRefs?: string[];
}

export interface BuildPrivateEquityEpistemicInput {
  tenantId: string;
  principalId: string;
  dealId: string;
  graph: DealExecutionGraph;
  eligibility: DealCloseEligibility;
  assertions?: readonly PrivateEquityAssertion[];
  declaredUnknowns?: Array<{
    entityType: PeEntityType;
    entityId: string;
    predicate: PePropositionPredicate;
  }>;
  decisionId?: string;
  asOf?: string;
}

export interface PrivateEquityEpistemicSnapshot {
  state: EpistemicState;
  requirements: PrivateEquityDecisionRequirement[];
  warnings: PrivateEquityEpistemicWarning[];
  decisions: PrivateEquityDecisionReadiness[];
}

export interface PrivateEquityDecisionRequirement extends DecisionRequirement {
  decisionType: PrivateEquityDecisionReadiness["decisionType"];
  expectedValues: JsonValue[];
}

type DefinitionRow = {
  definition: PropositionDefinition;
  table: string;
  value?: JsonValue;
  observedAt: string;
};

function asId(row: Record<string, unknown>): string {
  return String(row.id ?? "");
}

function asIso(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

function definition(
  dealId: string,
  entityType: PeEntityType,
  entityId: string,
  predicate: PePropositionPredicate,
  observedAt: string,
  value?: JsonValue,
  dependencyRefs: string[] = [],
): DefinitionRow {
  return {
    definition: {
      id: pePropositionId(dealId, entityType, entityId, predicate),
      subject: { kind: "entity", type: entityType, id: entityId },
      predicate: { name: predicate, operator: "eq" },
      dependencyRefs,
    },
    table: tableForPredicate(predicate),
    value,
    observedAt,
  };
}

function canonicalDefinitions(input: BuildPrivateEquityEpistemicInput, asOf: string): DefinitionRow[] {
  const { graph, dealId, eligibility } = input;
  const dealObserved = asIso(graph.deal.updatedAt ?? graph.deal.createdAt, asOf);
  const rows: DefinitionRow[] = [
    definition(dealId, "pe_deal", dealId, "deal.exists", dealObserved, true),
    definition(dealId, "pe_deal", dealId, "deal.loi_signed", dealObserved, Boolean(graph.deal.signedLoiAt)),
    definition(dealId, "pe_deal", dealId, "deal.target_close_at", dealObserved, json(graph.deal.targetClosingAt ?? null)),
    definition(dealId, "pe_deal", dealId, "deal.lifecycle_state", dealObserved, json(graph.deal.status ?? "active")),
  ];

  for (const row of graph.workstreams) {
    rows.push(definition(dealId, "pe_workstream", asId(row), "workstream.state", asIso(row.updatedAt, asOf), json(row.state)));
  }
  for (const row of graph.requests) {
    const id = asId(row);
    const observedAt = asIso(row.updatedAt, asOf);
    rows.push(
      definition(dealId, "pe_request", id, "request.acknowledged", observedAt, ["acknowledged", "fulfilled"].includes(String(row.state))),
      definition(dealId, "pe_request", id, "request.fulfilled", observedAt, row.state === "fulfilled"),
      definition(dealId, "pe_request", id, "request.overdue", observedAt, Boolean(row.overdue)),
    );
  }
  for (const row of graph.deliverables) {
    const id = asId(row);
    const observedAt = asIso(row.updatedAt, asOf);
    rows.push(
      definition(dealId, "pe_deliverable", id, "deliverable.received", observedAt, ["received", "accepted", "rejected"].includes(String(row.state))),
      definition(dealId, "pe_deliverable", id, "deliverable.accepted", observedAt, row.state === "accepted"),
    );
  }
  for (const row of graph.findings) {
    rows.push(definition(dealId, "pe_finding", asId(row), "finding.current", asIso(row.updatedAt, asOf), row.state === "open"));
  }
  for (const row of graph.dealRisks) {
    rows.push(definition(dealId, "pe_deal_risk", asId(row), "deal_risk.current", asIso(row.updatedAt, asOf), ["open", "mitigating"].includes(String(row.state))));
  }

  const entityState = new Map<string, string>();
  for (const [entityType, items] of [
    ["pe_workstream", graph.workstreams], ["pe_request", graph.requests], ["pe_deliverable", graph.deliverables],
    ["pe_finding", graph.findings], ["pe_deal_risk", graph.dealRisks], ["pe_milestone", graph.milestones],
    ["pe_closing_condition", graph.closingConditions], ["pe_closing_item", graph.closingItems],
  ] as const) {
    for (const row of items) entityState.set(`${entityType}:${asId(row)}`, String(row.state));
  }
  for (const row of graph.dependencies) {
    const blockerType = String(row.blockerType);
    const blockerId = String(row.blockerId);
    const resolved = Boolean(row.removedAt) || isPositiveDependencyResolution(blockerType, entityState.get(`${blockerType}:${blockerId}`) ?? "");
    rows.push(definition(dealId, "pe_dependency", asId(row), "dependency.resolved", asIso(row.updatedAt, asOf), resolved));
  }
  for (const row of graph.milestones) {
    rows.push(definition(dealId, "pe_milestone", asId(row), "milestone.achieved", asIso(row.updatedAt, asOf), row.state === "achieved"));
  }
  for (const row of graph.closingConditions) {
    const id = asId(row);
    const observedAt = asIso(row.updatedAt, asOf);
    rows.push(definition(dealId, "pe_closing_condition", id, "closing_condition.state", observedAt, json(row.state)));
    rows.push(definition(
      dealId,
      "pe_closing_condition",
      id,
      "closing_condition.evidence_sufficient",
      observedAt,
      // A linked Document/Evidence row is an assertion source, not a canonical
      // determination that this condition is sufficient. Only the PE2 canonical
      // state (or the explicit no-evidence-required rule) can establish this
      // proposition as canonical; provider/document claims are appended below as
      // lower-authority evidence and remain visible without bypassing PE2.
      row.evidenceRequired === false || row.state === "satisfied" ? true : undefined,
    ));
    const invalid = eligibility.invalidWaivers.some((waiver) => waiver.id === id);
    rows.push(definition(
      dealId,
      "pe_closing_condition",
      id,
      "closing_condition.waiver_valid",
      observedAt,
      row.state === "waived" ? !invalid : undefined,
    ));
  }
  for (const row of graph.closingItems) {
    const id = asId(row);
    const observedAt = asIso(row.updatedAt, asOf);
    rows.push(
      definition(dealId, "pe_closing_item", id, "closing_item.ready", observedAt, ["ready", "verified"].includes(String(row.state))),
      // `ready` is not negative proof of the external signature/business outcome.
      // Canonical truth may establish verified=true; otherwise the proposition is
      // intentionally UNKNOWN until exact evidence is observed.
      definition(dealId, "pe_closing_item", id, "closing_item.verified", observedAt, row.state === "verified" ? true : undefined),
    );
  }

  const eligibilityDeps = [
    ...graph.closingConditions.filter((row) => row.requiredForClose !== false).map((row) => pePropositionId(dealId, "pe_closing_condition", asId(row), "closing_condition.state")),
    ...graph.closingItems.filter((row) => row.requiredForClose !== false).map((row) => pePropositionId(dealId, "pe_closing_item", asId(row), "closing_item.verified")),
    ...graph.dependencies.filter((row) => !row.removedAt).map((row) => pePropositionId(dealId, "pe_dependency", asId(row), "dependency.resolved")),
  ];
  rows.push(definition(dealId, "pe_deal", dealId, "deal.close_eligible", asOf, eligibility.eligible, eligibilityDeps));
  return rows;
}

function assertionEvidence(state: EpistemicState, assertion: PrivateEquityAssertion): EvidenceRecord | null {
  // Memory and public-web material may provide context, but cannot establish an
  // internal Deal proposition. Keep it out of the proposition evidence set.
  if (assertion.kind === "memory" || assertion.kind === "web") return null;
  if (assertion.maximumAgeMs !== undefined && !assertion.freshnessPolicyRef) {
    throw new Error("PE assertion maximumAgeMs requires an explicit freshnessPolicyRef");
  }
  const common = {
    state,
    propositionId: assertion.propositionId,
    value: assertion.value,
    observedAt: assertion.observedAt,
    ingestedAt: assertion.ingestedAt,
    maxAgeMs: assertion.maximumAgeMs,
  };
  let record: EvidenceRecord;
  if (assertion.kind === "provider_observation") {
    record = providerObservationEvidence({ ...common, observationRef: assertion.ref });
  } else if (assertion.kind === "user_input") {
    record = explicitUserInputEvidence({ ...common, inputRef: assertion.ref });
  } else {
    record = evidenceFromExistingSource({
      ...common,
      source: {
        kind: "DOCUMENT",
        owner: "evidence_corpus",
        ref: assertion.ref,
        authority: "DURABLE_EVIDENCE",
        truthClass: "MEMORY",
        role: "answer_evidence",
      },
    });
  }
  return assertion.supersedesEvidenceRefs?.length
    ? { ...record, supersedesEvidenceRefs: [...assertion.supersedesEvidenceRefs] }
    : record;
}

function readOption(reason: string): AcquisitionOption {
  return { kind: "READ", adapterId: "CANONICAL_OPERATIONAL_QUERY", reason, expectedAuthority: "CANONICAL_OWNER" };
}

function evidenceOptions(reason: string): AcquisitionOption[] {
  return [
    { kind: "RETRIEVE", adapterId: "EVIDENCE_CORPUS_RETRIEVAL", reason, expectedAuthority: "DURABLE_EVIDENCE" },
    { kind: "INSPECT", adapterId: "SOURCE_TRUTH_OBSERVATION", reason: "Inspect a configured provider without mutating the Deal.", expectedAuthority: "GOVERNED_OBSERVATION" },
    { kind: "ASK", adapterId: "CLARIFICATION_REQUEST", reason: "Ask for a precise source or missing intent; user input remains an assertion.", expectedAuthority: "USER_INTENT_OWNER" },
  ];
}

function requirement(input: {
  propositionId: string;
  decisionId: string;
  decisionType: PrivateEquityDecisionReadiness["decisionType"];
  description: string;
  expectedValues: JsonValue[];
  consequence: string;
  options: AcquisitionOption[];
  minimumAuthority?: DecisionRequirement["minimumAuthority"];
  minimumConfidence?: DecisionRequirement["minimumConfidence"];
  maximumAgeMs?: number;
}): PrivateEquityDecisionRequirement {
  return {
    propositionId: input.propositionId,
    decisionId: input.decisionId,
    decisionType: input.decisionType,
    description: input.description,
    expectedValues: input.expectedValues,
    criticality: "CONSEQUENTIAL",
    mandatory: true,
    acceptableStatuses: ["KNOWN"],
    minimumAuthority: input.minimumAuthority ?? ["CANONICAL_OWNER"],
    minimumConfidence: input.minimumConfidence ?? "VERIFIED",
    ...(input.maximumAgeMs === undefined ? {} : { maximumAgeMs: input.maximumAgeMs }),
    consequenceIfUnresolved: input.consequence,
    acquisitionOptions: input.options,
  };
}

function decisionRequirements(input: BuildPrivateEquityEpistemicInput): PrivateEquityDecisionRequirement[] {
  const { graph, dealId } = input;
  const requirements: PrivateEquityDecisionRequirement[] = [];
  for (const row of graph.closingConditions) {
    const id = asId(row);
    if (row.state === "waived") {
      // A valid canonical waiver is an alternate PE2 satisfaction path. It does
      // not need evidence sufficiency, but it must have its own explicit
      // canonical governance proposition so an invalid waiver cannot look ready.
      requirements.push(requirement({
        propositionId: pePropositionId(dealId, "pe_closing_condition", id, "closing_condition.waiver_valid"),
        decisionId: `pe:decision:closing-condition-waiver:${id}`,
        decisionType: "closing_condition_satisfaction",
        description: "A waived ClosingCondition requires a valid canonical waiver decision and receipt.",
        expectedValues: [true],
        consequence: "FINNOR must not treat the waived ClosingCondition as satisfied without valid governance.",
        options: [readOption("Re-read the canonical waiver decision and receipt.")],
      }));
    } else {
      requirements.push(requirement({
        propositionId: pePropositionId(dealId, "pe_closing_condition", id, "closing_condition.evidence_sufficient"),
        decisionId: `pe:decision:closing-condition:${id}`,
        decisionType: "closing_condition_satisfaction",
        description: "Canonical evidence must be sufficient before this ClosingCondition can be satisfied.",
        expectedValues: [true],
        consequence: "FINNOR must not claim the ClosingCondition is satisfied.",
        options: evidenceOptions("Retrieve exact linked evidence for this ClosingCondition."),
      }));
    }
  }
  for (const row of graph.closingItems) {
    const id = asId(row);
    const decisionId = `pe:decision:closing-item:${id}`;
    requirements.push(requirement({
      propositionId: pePropositionId(dealId, "pe_closing_item", id, "closing_item.ready"),
      decisionId,
      decisionType: "closing_item_verification",
      description: "The ClosingItem must be canonically ready before verification.",
      expectedValues: [true],
      consequence: "FINNOR must not claim the ClosingItem is verified.",
      options: [readOption("Re-read the canonical ClosingItem state.")],
    }));
    requirements.push(requirement({
      propositionId: pePropositionId(dealId, "pe_closing_item", id, "closing_item.verified"),
      decisionId,
      decisionType: "closing_item_verification",
      description: "An exact external/business outcome needs authoritative evidence before canonical verification.",
      expectedValues: [true],
      consequence: "FINNOR must keep ready distinct from verified and must not perform or claim verification.",
      options: evidenceOptions("Retrieve or inspect exact verification evidence for this ClosingItem."),
      minimumAuthority: ["CANONICAL_OWNER", "GOVERNED_OBSERVATION", "DURABLE_EVIDENCE"],
      minimumConfidence: "MEDIUM",
    }));
  }
  requirements.push(requirement({
    propositionId: pePropositionId(dealId, "pe_deal", dealId, "deal.close_eligible"),
    decisionId: `pe:decision:deal-close:${dealId}`,
    decisionType: "deal_close",
    description: "The existing PE2 close-eligibility gate must return eligible.",
    expectedValues: [true],
    consequence: "The Deal cannot be represented as close-eligible.",
    options: [
      readOption("Re-run canonical PE2 close eligibility after blockers change."),
      { kind: "WAIT", adapterId: "WORK_EVENT_WAIT", reason: "Wait for an already-active Work event and then re-read; waiting does not mutate the Deal.", expectedAuthority: "WORK_LEDGER" },
    ],
  }));
  for (const row of graph.requests) {
    const id = asId(row);
    const decisionId = `pe:decision:request-fulfillment:${id}`;
    requirements.push(requirement({
      propositionId: pePropositionId(dealId, "pe_request", id, "request.fulfilled"),
      decisionId,
      decisionType: "request_fulfillment",
      description: "Request fulfillment must be canonical, not a provider acknowledgement or uploaded assertion.",
      expectedValues: [true],
      consequence: "FINNOR must continue to call the Request open or acknowledged, not fulfilled.",
      options: [readOption("Re-read the canonical Request and accepted Deliverable state."), ...evidenceOptions("Inspect the requested material as evidence only.")],
    }));
    if (row.requiresAcceptedDeliverable) {
      for (const deliverable of graph.deliverables.filter((candidate) => candidate.requestId === id)) {
        requirements.push(requirement({
          propositionId: pePropositionId(dealId, "pe_deliverable", asId(deliverable), "deliverable.accepted"),
          decisionId,
          decisionType: "request_fulfillment",
          description: "A Request configured to require an accepted Deliverable needs canonical acceptance.",
          expectedValues: [true],
          consequence: "The Request cannot be claimed fulfilled from document receipt alone.",
          options: [readOption("Re-read canonical Deliverable acceptance.")],
        }));
      }
    }
  }
  return requirements;
}

function valueMatches(state: EpistemicState, requirement: PrivateEquityDecisionRequirement): boolean {
  const proposition = propositionById(state, requirement.propositionId);
  if (!proposition || proposition.value.kind !== "DETERMINISTIC") return false;
  const actual = proposition.value.value;
  return requirement.expectedValues.some((candidate) => JSON.stringify(candidate) === JSON.stringify(actual));
}

function decisionReadiness(state: EpistemicState, requirements: PrivateEquityDecisionRequirement[]): PrivateEquityDecisionReadiness[] {
  const groups = new Map<string, PrivateEquityDecisionRequirement[]>();
  for (const item of requirements) groups.set(item.decisionId, [...(groups.get(item.decisionId) ?? []), item]);
  return [...groups.entries()].map(([decisionId, items]) => {
    const unresolved = items.filter((item) => !requirementResolved(state, item) || !valueMatches(state, item));
    const runtimeUncertainty = analyzeUncertainty(state, unresolved);
    return {
      decisionId,
      decisionType: items[0]!.decisionType,
      ready: unresolved.length === 0,
      unresolvedPropositionIds: unresolved.map((item) => item.propositionId).sort(),
      acquisitionOptions: unresolved.flatMap((item) => {
        const classified = runtimeUncertainty.find((uncertainty) => uncertainty.requiredPropositionId === item.propositionId);
        return item.acquisitionOptions.map((option) => ({
          propositionId: item.propositionId,
          adapterId: option.adapterId,
          kind: option.kind,
          reason: classified?.whyUnresolved ?? option.reason,
        }));
      }).sort((left, right) => `${left.propositionId}:${left.adapterId}`.localeCompare(`${right.propositionId}:${right.adapterId}`)),
    };
  }).sort((left, right) => left.decisionId.localeCompare(right.decisionId));
}

export function privateEquityEpistemicWarnings(state: EpistemicState): PrivateEquityEpistemicWarning[] {
  const propositionWarnings = state.propositions.flatMap((proposition): PrivateEquityEpistemicWarning[] => {
    if (proposition.status !== "KNOWN") {
      return [{
        propositionId: proposition.id,
        predicate: proposition.predicate.name,
        status: proposition.status,
        reason: proposition.freshness.reason,
        evidenceRefs: [...proposition.evidenceRefs],
      }];
    }
    if (proposition.contradictingEvidenceRefs.length > 0) {
      return [{
        propositionId: proposition.id,
        predicate: proposition.predicate.name,
        status: "CONTRADICTED",
        reason: "Canonical truth wins, but lower-authority contradictory evidence is retained.",
        evidenceRefs: [...proposition.contradictingEvidenceRefs],
      }];
    }
    return [];
  });
  // A fresh canonical winner must not erase the operational fact that a supporting
  // provider/document observation is stale. The core runtime keeps the immutable
  // evidence record; this PE projection makes that source-level freshness visible
  // without downgrading or replacing canonical truth.
  const staleEvidenceWarnings = state.evidence.flatMap((evidence): PrivateEquityEpistemicWarning[] => {
    if (evidence.freshness.maxAgeMs === undefined) return [];
    const observedAt = Date.parse(evidence.validAt ?? evidence.observedAt);
    const ageMs = Math.max(0, Date.parse(state.asOf) - observedAt);
    if (ageMs <= evidence.freshness.maxAgeMs) return [];
    const proposition = propositionById(state, evidence.propositionId);
    if (!proposition || proposition.status === "STALE") return [];
    return [{
      propositionId: evidence.propositionId,
      predicate: proposition.predicate.name,
      status: "STALE",
      reason: ageMs > evidence.freshness.maxAgeMs * 3
        ? "A retained supporting observation exceeded three configured freshness windows."
        : "A retained supporting observation exceeded its configured freshness window.",
      evidenceRefs: [evidence.id],
    }];
  });
  return [...propositionWarnings, ...staleEvidenceWarnings].sort((left, right) =>
    `${left.propositionId}:${left.status}:${left.evidenceRefs.join(",")}`
      .localeCompare(`${right.propositionId}:${right.status}:${right.evidenceRefs.join(",")}`));
}

export function buildPrivateEquityEpistemicSnapshot(input: BuildPrivateEquityEpistemicInput): PrivateEquityEpistemicSnapshot {
  if (!UUID.test(input.dealId)) throw new Error("PE epistemic Deal id must be a UUID");
  if (String(input.graph.deal.id) !== input.dealId || input.eligibility.dealId !== input.dealId) {
    throw new Error("PE epistemic inputs must describe exactly one Deal");
  }
  const asOf = input.asOf ?? input.graph.asOf;
  const canonical = canonicalDefinitions(input, asOf);
  const declared = (input.declaredUnknowns ?? []).map((item) => definition(
    input.dealId, item.entityType, item.entityId, item.predicate, asOf,
  ));
  const byId = new Map<string, DefinitionRow>();
  for (const row of canonical) byId.set(row.definition.id, row);
  // A caller may declare an unknown only for a proposition the canonical graph
  // did not define. It can never shadow a canonical definition (or turn a known
  // fact into an unavailable one).
  for (const row of declared) if (!byId.has(row.definition.id)) byId.set(row.definition.id, row);
  let state = createEpistemicState({
    scope: {
      tenantId: input.tenantId,
      principalId: input.principalId,
      decisionId: input.decisionId ?? `pe:decision:deal:${input.dealId}`,
    },
    asOf,
    propositions: [...byId.values()].map((row) => row.definition),
  });
  const canonicalEvidence = [...byId.values()].flatMap((row) => row.value === undefined ? [] : [canonicalOperationalQueryEvidence({
    state,
    propositionId: row.definition.id,
    value: row.value,
    observedAt: row.observedAt,
    intent: "private_equity_truth",
    tables: [row.table],
    executionRef: `pe-canonical:${row.table}:${input.dealId}:${row.definition.subject.id}:${row.observedAt}`,
  })]);
  state = appendEvidenceAndRecompute(state, canonicalEvidence, asOf);
  const assertions = (input.assertions ?? []).map((assertion) => {
    if (!byId.has(assertion.propositionId)) throw new Error(`PE assertion references undeclared proposition ${assertion.propositionId}`);
    return assertionEvidence(state, assertion);
  }).filter((record): record is EvidenceRecord => Boolean(record));
  state = appendEvidenceAndRecompute(state, assertions, asOf);
  const requirements = decisionRequirements(input);
  return {
    state,
    requirements,
    warnings: privateEquityEpistemicWarnings(state),
    decisions: decisionReadiness(state, requirements),
  };
}

/** Context-only helper proving that web evidence may be retained as research but
 * is never admitted as an internal Deal assertion by the PE snapshot builder. */
export function privateEquityWebContextEvidence(state: EpistemicState, input: {
  propositionId: string;
  value: JsonValue;
  citationRef: string;
  observedAt: string;
}): EvidenceRecord {
  return webResearchEvidence({ ...input, state });
}

export const PE_EPISTEMIC_HEURISTIC_VERSION = EPISTEMIC_HEURISTIC_VERSION;

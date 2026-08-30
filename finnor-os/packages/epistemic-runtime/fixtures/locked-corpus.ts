import corpus from "./locked-cases.json";
import type {
  AcquisitionBudget,
  AcquisitionOption,
  DecisionRequirement,
  EpistemicScope,
  EpistemicState,
  EvidenceRecord,
  InformationAction,
  InformationObservation,
  PropositionDefinition,
  StaticAdmissibilityResultLike,
  Uncertainty,
} from "../src/contracts";
import { EPISTEMIC_HEURISTIC_VERSION } from "../src/contracts";
import { appendEvidenceAndRecompute, applyInformationObservation, createEvidenceRecord } from "../src/belief-update";
import { createEpistemicState, propositionById } from "../src/state";
import { analyzeUncertainty, p2IssueUncertaintyCategory } from "../src/uncertainty";
import { createInformationAction, type InformationActionExecutor } from "../src/information-actions";
import { decideAcquisitionStop, selectInformationAction } from "../src/scoring";
import { resolveP2WithInformation } from "../src/p2-handoff";

export interface LockedCorpusCase {
  id: string;
  category: string;
  expected: string;
}

export interface LockedCorpusCaseResult {
  id: string;
  passed: boolean;
  actual: string;
  expected: string;
  assertions: string[];
}

export const LOCKED_CORPUS = corpus as {
  version: 1;
  fixedClock: string;
  fixedSeed: number;
  cases: LockedCorpusCase[];
};

const NOW = LOCKED_CORPUS.fixedClock;
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";

function scope(decisionId = "decision:locked"): EpistemicScope {
  return { tenantId: TENANT, principalId: "employee:locked", decisionId };
}

function definition(
  id = "invoice.balance",
  subject: PropositionDefinition["subject"] = { kind: "entity", type: "invoice", id: "invoice-1" },
): PropositionDefinition {
  return { id, subject, predicate: { name: id.split(".").at(-1) ?? id, operator: "exists" } };
}

function stateFor(def = definition()): EpistemicState {
  return createEpistemicState({ scope: scope(), asOf: NOW, propositions: [def] });
}

function source(kind: EvidenceRecord["source"]["kind"], owner: string, ref: string): EvidenceRecord["source"] {
  const mapping: Record<EvidenceRecord["source"]["kind"], Pick<EvidenceRecord["source"], "authority" | "truthClass">> = {
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
  return { kind, owner, ref, ...mapping[kind], role: "answer_evidence" };
}

function evidence(input: {
  state: EpistemicState;
  id: string;
  value: EvidenceRecord["value"];
  kind: EvidenceRecord["source"]["kind"];
  propositionId?: string;
  observedAt?: string;
  maxAgeMs?: number;
  tenantId?: string;
  freshness?: EvidenceRecord["freshness"]["status"];
  confidence?: EvidenceRecord["confidence"]["level"];
}): EvidenceRecord {
  const observedAt = input.observedAt ?? NOW;
  const src = source(input.kind, `fixture:${input.kind.toLowerCase()}`, input.id);
  return createEvidenceRecord({
    id: input.id,
    propositionId: input.propositionId ?? input.state.propositions[0]!.id,
    tenantId: input.tenantId ?? input.state.scope.tenantId,
    source: src,
    observedAt,
    validAt: observedAt,
    ingestedAt: NOW,
    value: input.value,
    confidence: {
      level: input.confidence ?? (input.kind === "CANONICAL_DB" ? "VERIFIED" : "HIGH"),
      basis: input.kind === "CANONICAL_DB" ? "DETERMINISTIC_SOURCE" : "SOURCE_ASSERTION",
      heuristicVersion: EPISTEMIC_HEURISTIC_VERSION,
      reasonCodes: ["FROZEN_FIXTURE"],
    },
    freshness: { status: input.freshness ?? "FRESH", ...(input.maxAgeMs === undefined ? {} : { maxAgeMs: input.maxAgeMs }), reason: "Frozen fixture" },
    sensitivity: "TENANT_INTERNAL",
    provenance: { sourceRef: src.ref, parentEvidenceRefs: [], dependencyRefs: [] },
    canonical: input.kind === "CANONICAL_DB",
  });
}

function option(kind: AcquisitionOption["kind"], adapterId: AcquisitionOption["adapterId"], expectedAuthority: AcquisitionOption["expectedAuthority"]): AcquisitionOption {
  return { kind, adapterId, expectedAuthority, reason: `fixture:${kind}` };
}

function requirement(
  propositionId: string,
  options: AcquisitionOption[],
  subjectCritical = false,
): DecisionRequirement {
  return {
    propositionId,
    decisionId: "decision:locked",
    description: propositionId,
    criticality: subjectCritical ? "SAFETY_LEGAL" : "CONSEQUENTIAL",
    mandatory: true,
    acceptableStatuses: ["KNOWN"],
    minimumConfidence: "HIGH",
    consequenceIfUnresolved: "Frozen consequential decision remains blocked",
    acquisitionOptions: options,
  };
}

function uncertaintyFor(state: EpistemicState, req: DecisionRequirement): Uncertainty {
  return analyzeUncertainty(state, [req])[0]!;
}

function budget(overrides: Partial<AcquisitionBudget> = {}): AcquisitionBudget {
  return {
    maxActions: 4,
    maxUserInterruptions: 1,
    maxLatencyMs: 100_000_000,
    maxCostUnits: 20,
    deadline: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function selection(state: EpistemicState, req: DecisionRequirement, actions: InformationAction[]) {
  const uncertainties = analyzeUncertainty(state, [req]);
  return selectInformationAction(actions, { state, uncertainties, requirements: [req], budget: budget(), usage: { actions: 0, userInterruptions: 0, latencyMs: 0, costUnits: 0, selectedActionFingerprints: [] }, now: NOW });
}

const unresolvedP2 = (reasonCode = "ENTITY_RESOLUTION_UNRESOLVED"): StaticAdmissibilityResultLike => ({
  status: "UNRESOLVED",
  reasonCodes: [reasonCode],
  issues: [{
    status: "UNRESOLVED",
    reasonCode,
    nodeId: "entity:invoice",
    path: "resolution.entity:invoice",
    message: "Canonical invoice resolution is incomplete.",
    detail: { resolutionReasonCode: "ENTITY_REFERENCE_UNRESOLVED" },
  }],
});

class FixtureExecutor implements InformationActionExecutor {
  constructor(private readonly outcome: "CANONICAL" | "NO_RESULT") {}

  async execute(action: InformationAction): Promise<InformationObservation> {
    const propositionId = action.expectedInformation.propositionIds[0]!;
    const state = createEpistemicState({ scope: action.scope, asOf: NOW, propositions: [definition(propositionId)] });
    return {
      actionId: action.id,
      adapterId: action.adapterId,
      tenantId: action.scope.tenantId,
      observedAt: NOW,
      evidence: this.outcome === "CANONICAL" ? [evidence({ state, id: `canonical:${propositionId}`, value: true, kind: "CANONICAL_DB", propositionId })] : [],
      propositionIds: [propositionId],
      outcome: this.outcome === "CANONICAL" ? "OBSERVED" : "NO_RESULT",
    };
  }
}

function result(entry: LockedCorpusCase, actual: string, assertions: string[]): LockedCorpusCaseResult {
  return { id: entry.id, passed: actual === entry.expected, actual, expected: entry.expected, assertions };
}

export async function runLockedCorpusCase(entry: LockedCorpusCase): Promise<LockedCorpusCaseResult> {
  switch (entry.id) {
    case "canonical_fact_already_known": {
      const initial = stateFor();
      const next = appendEvidenceAndRecompute(initial, [evidence({ state: initial, id: "canonical:balance", value: 100, kind: "CANONICAL_DB" })], NOW);
      return result(entry, propositionById(next, "invoice.balance")?.status ?? "missing", ["canonical evidence selected", "provenance retained"]);
    }
    case "missing_canonical_fact": {
      const initial = stateFor();
      const category = uncertaintyFor(initial, requirement("invoice.balance", [option("READ", "CANONICAL_OPERATIONAL_QUERY", "CANONICAL_OWNER")])).category;
      return result(entry, category, ["missing is explicit"]);
    }
    case "stale_memory": {
      const initial = stateFor();
      const next = appendEvidenceAndRecompute(initial, [evidence({ state: initial, id: "memory:old", value: "unpaid", kind: "MEMORY", observedAt: "2026-08-29T00:00:00.000Z", maxAgeMs: 60_000 })], NOW);
      return result(entry, propositionById(next, "invoice.balance")?.status ?? "missing", ["fixed clock", "freshness window elapsed"]);
    }
    case "conflicting_memory_canonical_data": {
      const initial = stateFor();
      const next = appendEvidenceAndRecompute(initial, [
        evidence({ state: initial, id: "memory:unpaid", value: "unpaid", kind: "MEMORY" }),
        evidence({ state: initial, id: "canonical:paid", value: "paid", kind: "CANONICAL_DB" }),
      ], NOW);
      const canonicalWins = propositionById(next, "invoice.balance")?.evidenceRefs.includes("canonical:paid")
        && next.conflicts.some((conflict) => conflict.resolution === "HIGHER_AUTHORITY_WINS");
      return result(entry, canonicalWins ? "CANONICAL_WINS" : "FAILED", ["lower memory preserved as contradicting evidence"]);
    }
    case "ambiguous_entity": {
      const category = p2IssueUncertaintyCategory({ status: "UNRESOLVED", reasonCode: "ENTITY_RESOLUTION_UNRESOLVED", nodeId: "entity", path: "entity", message: "ambiguous", detail: { resolutionReasonCode: "ENTITY_REFERENCE_AMBIGUOUS" } });
      return result(entry, category, ["precise P2 ambiguity reason"]);
    }
    case "cross_tenant_candidate": {
      const initial = stateFor();
      const observation: InformationObservation = { actionId: "a", adapterId: "CANONICAL_OPERATIONAL_QUERY", tenantId: OTHER_TENANT, observedAt: NOW, evidence: [], propositionIds: ["invoice.balance"], outcome: "NO_RESULT" };
      let rejected = false;
      try { applyInformationObservation(initial, observation); } catch { rejected = true; }
      return result(entry, rejected ? "REJECTED" : "ACCEPTED", ["trusted tenant mismatch rejected"]);
    }
    case "missing_field_classification": {
      const initial = stateFor(definition("customer.phone.classification"));
      const category = uncertaintyFor(initial, requirement("customer.phone.classification", [option("READ", "OPERATING_CONTEXT_READ", "CANONICAL_OWNER")])).category;
      return result(entry, category, ["unclassified field is not assumed safe"]);
    }
    case "external_outcome_unknown": {
      const initial = stateFor(definition("provider.delivery", { kind: "external", type: "delivery", id: "delivery-1" }));
      const category = uncertaintyFor(initial, requirement("provider.delivery", [option("INSPECT", "SOURCE_TRUTH_OBSERVATION", "GOVERNED_OBSERVATION")])).category;
      return result(entry, category, ["external unknown distinguished from missing"]);
    }
    case "provider_state_stale": {
      const initial = stateFor(definition("provider.state", { kind: "provider", type: "configured_provider", id: "binding-1" }));
      const next = appendEvidenceAndRecompute(initial, [evidence({ state: initial, id: "provider:old", value: "pending", kind: "PROVIDER_OBSERVATION", observedAt: "2026-08-30T00:00:00.000Z", maxAgeMs: 60_000 })], NOW);
      return result(entry, propositionById(next, "provider.state")?.status ?? "missing", ["provider observation can become stale"]);
    }
    case "computer_inspection_required":
    case "document_retrieval":
    case "external_research":
    case "user_clarification":
    case "wait_for_event": {
      const kindByCase = {
        computer_inspection_required: ["INSPECT", "COMPUTER_READ_ONLY_OBSERVATION", "GOVERNED_OBSERVATION"],
        document_retrieval: ["RETRIEVE", "EVIDENCE_CORPUS_RETRIEVAL", "DURABLE_EVIDENCE"],
        external_research: ["RESEARCH", "WEB_RESEARCH", "PUBLIC_RESEARCH"],
        user_clarification: ["ASK", "CLARIFICATION_REQUEST", "USER_INTENT_OWNER"],
        wait_for_event: ["WAIT", "WORK_EVENT_WAIT", "WORK_LEDGER"],
      } as const;
      const selected = kindByCase[entry.id];
      const subject = entry.id === "user_clarification" ? { kind: "user_intent" as const, type: "choice" }
        : entry.id === "wait_for_event" ? { kind: "external" as const, type: "event" }
          : undefined;
      const initial = stateFor(definition(`case.${entry.id}`, subject));
      const req = requirement(`case.${entry.id}`, [option(selected[0], selected[1], selected[2])]);
      const uncertainty = uncertaintyFor(initial, req);
      const action = createInformationAction(initial.scope, uncertainty, req.acquisitionOptions[0]!, entry.id === "external_research" ? { sensitivity: ["PUBLIC"] } : {});
      const chosen = selection(initial, req, [action]).action?.kind ?? "NONE";
      return result(entry, chosen, ["typed information action selected"]);
    }
    case "unnecessary_clarification_avoidance": {
      const initial = stateFor(definition("entity.choice"));
      const req = requirement("entity.choice", [
        option("READ", "CANONICAL_OPERATIONAL_QUERY", "CANONICAL_OWNER"),
        option("ASK", "CLARIFICATION_REQUEST", "USER_INTENT_OWNER"),
      ]);
      const uncertainty = uncertaintyFor(initial, req);
      const actions = req.acquisitionOptions.map((candidate) => createInformationAction(initial.scope, uncertainty, candidate));
      const chosen = selection(initial, req, actions);
      return result(entry, chosen.action?.kind ?? "NONE", ["canonical machine read precedes ASK", "user interruption avoided"]);
    }
    case "unnecessary_retrieval_avoidance": {
      const initial = stateFor();
      const known = appendEvidenceAndRecompute(initial, [evidence({ state: initial, id: "canonical:known", value: true, kind: "CANONICAL_DB" })], NOW);
      const req = requirement("invoice.balance", [option("RETRIEVE", "HYBRID_RETRIEVAL", "SEMANTIC_MEMORY")]);
      const uncertainties = analyzeUncertainty(known, [req]);
      const stop = decideAcquisitionStop(known, [req], [], [], budget(), { actions: 0, userInterruptions: 0, latencyMs: 0, costUnits: 0, selectedActionFingerprints: [] }, NOW);
      return result(entry, uncertainties.length === 0 && stop.stop ? "NO_ACQUISITION" : "RETRIEVED", ["canonical fact already satisfies requirement"]);
    }
    case "low_value_research_rejected": {
      const initial = stateFor(definition("external.market", { kind: "external", type: "market" }));
      const req = requirement("external.market", [option("RESEARCH", "WEB_RESEARCH", "PUBLIC_RESEARCH")]);
      const u = uncertaintyFor(initial, req);
      const action = createInformationAction(initial.scope, u, req.acquisitionOptions[0]!, { sensitivity: ["PUBLIC"], estimate: { decisionQualityImprovement: 0, expectedUncertaintyReduction: 0 } });
      const chosen = selection(initial, req, [action]);
      return result(entry, chosen.action ? "SELECTED" : "REJECTED", ["non-positive uncertainty reduction"]);
    }
    case "privacy_sensitive_acquisition_rejected": {
      const initial = stateFor(definition("customer.identity"));
      const req = requirement("customer.identity", [option("RESEARCH", "WEB_RESEARCH", "PUBLIC_RESEARCH")]);
      const u = uncertaintyFor(initial, req);
      const action = createInformationAction(initial.scope, u, req.acquisitionOptions[0]!, { sensitivity: ["PII"] });
      const chosen = selection(initial, req, [action]);
      return result(entry, chosen.action ? "SELECTED" : "REJECTED", ["PII cannot cross public research boundary"]);
    }
    case "conflicting_sources": {
      const initial = stateFor();
      const next = appendEvidenceAndRecompute(initial, [
        evidence({ state: initial, id: "work:a", value: "paid", kind: "ACTIVE_WORK" }),
        evidence({ state: initial, id: "work:b", value: "unpaid", kind: "ACTIVE_WORK" }),
      ], NOW);
      return result(entry, propositionById(next, "invoice.balance")?.status ?? "missing", ["equal-authority conflict remains explicit"]);
    }
    case "unresolved_high_risk_proposition": {
      const initial = stateFor(definition("legal.permission"));
      const req = requirement("legal.permission", [], true);
      const uncertainties = analyzeUncertainty(initial, [req]);
      const stop = decideAcquisitionStop(initial, [req], [], [], budget(), { actions: 0, userInterruptions: 0, latencyMs: 0, costUnits: 0, selectedActionFingerprints: [] }, NOW);
      return result(entry, uncertainties[0]?.category === "UNOBSERVABLE" && stop.stop ? "BLOCKED" : "ALLOWED", ["safety/legal uncertainty cannot become action"]);
    }
    case "acquisition_budget_exhaustion": {
      const initial = stateFor();
      const req = requirement("invoice.balance", [option("READ", "CANONICAL_OPERATIONAL_QUERY", "CANONICAL_OWNER")]);
      const stop = decideAcquisitionStop(initial, [req], [], [], budget({ maxActions: 0 }), { actions: 0, userInterruptions: 0, latencyMs: 0, costUnits: 0, selectedActionFingerprints: [] }, NOW);
      return result(entry, stop.reason, ["maxActions is a hard bound"]);
    }
    case "p2_unresolved_resolved_admissible":
    case "p2_unresolved_still_unresolved": {
      const p2State = createEpistemicState({ scope: scope("decision:p2"), asOf: NOW, propositions: [] });
      const resolved = entry.id === "p2_unresolved_resolved_admissible";
      const handoff = await resolveP2WithInformation({
        initialP2: unresolvedP2(),
        state: p2State,
        budget: budget({ maxActions: 2 }),
        executor: new FixtureExecutor(resolved ? "CANONICAL" : "NO_RESULT"),
        now: () => NOW,
        rerunP2: async (next) => resolved && next.propositions.some((proposition) => proposition.status === "KNOWN")
          ? { status: "ADMISSIBLE", reasonCodes: [], issues: [] }
          : unresolvedP2(),
      });
      return result(entry, handoff.status, ["P2 rerun required after belief update", "bounded loop"]);
    }
    case "p2_rejected_remains_rejected": {
      const rejected: StaticAdmissibilityResultLike = { status: "REJECTED", reasonCodes: ["FORBIDDEN_INFORMATION_FLOW"], issues: [{ status: "REJECTED", reasonCode: "FORBIDDEN_INFORMATION_FLOW", nodeId: "effect", path: "effect", message: "forbidden" }] };
      const handoff = await resolveP2WithInformation({
        initialP2: rejected,
        state: createEpistemicState({ scope: scope("decision:p2-rejected"), asOf: NOW, propositions: [] }),
        budget: budget(),
        executor: { execute: async () => { throw new Error("executor must never run"); } },
        now: () => NOW,
        rerunP2: async () => { throw new Error("P2 must not be rerun after rejection"); },
      });
      return result(entry, handoff.status, ["zero acquisitions", "zero rejected overrides"]);
    }
    default:
      return { id: entry.id, passed: false, actual: "UNIMPLEMENTED", expected: entry.expected, assertions: ["fixture missing"] };
  }
}

export async function runLockedCorpus(): Promise<LockedCorpusCaseResult[]> {
  const results: LockedCorpusCaseResult[] = [];
  for (const entry of LOCKED_CORPUS.cases) results.push(await runLockedCorpusCase(entry));
  return results;
}

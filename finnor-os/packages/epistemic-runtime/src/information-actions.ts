import type {
  AcquisitionBudget,
  AcquisitionOption,
  AcquisitionUsage,
  EpistemicScope,
  InformationAction,
  InformationActionKind,
  InformationAdapterId,
  InformationBoundary,
  InformationObservation,
  InformationSensitivity,
  PrivacyExposure,
  SourceAuthority,
  Uncertainty,
} from "./contracts";
import { EPISTEMIC_HEURISTIC_VERSION } from "./contracts";
import { epistemicHash } from "./source-precedence";

interface ActionHeuristic {
  latency: { expectedMs: number; maximumMs: number };
  cost: { monetaryUnits: number; toolUnits: number };
  interruption: { required: boolean; units: number };
  privacyUnits: number;
  failureRisk: number;
  boundary: InformationBoundary;
  freshness: InformationAction["freshnessGain"];
}

const ADAPTER_ACTION_KIND: Readonly<Record<InformationAdapterId, InformationActionKind>> = {
  CANONICAL_OPERATIONAL_QUERY: "READ",
  OPERATING_CONTEXT_READ: "READ",
  HYBRID_RETRIEVAL: "RETRIEVE",
  EVIDENCE_CORPUS_RETRIEVAL: "RETRIEVE",
  CLARIFICATION_REQUEST: "ASK",
  SOURCE_TRUTH_OBSERVATION: "INSPECT",
  COMPUTER_READ_ONLY_OBSERVATION: "INSPECT",
  WEB_RESEARCH: "RESEARCH",
  WORK_EVENT_WAIT: "WAIT",
};

const ADAPTER_SOURCE_AUTHORITY: Readonly<Record<InformationAdapterId, SourceAuthority>> = {
  CANONICAL_OPERATIONAL_QUERY: "CANONICAL_OWNER",
  OPERATING_CONTEXT_READ: "CANONICAL_OWNER",
  HYBRID_RETRIEVAL: "SEMANTIC_MEMORY",
  EVIDENCE_CORPUS_RETRIEVAL: "DURABLE_EVIDENCE",
  CLARIFICATION_REQUEST: "USER_INTENT_OWNER",
  SOURCE_TRUTH_OBSERVATION: "GOVERNED_OBSERVATION",
  COMPUTER_READ_ONLY_OBSERVATION: "GOVERNED_OBSERVATION",
  WEB_RESEARCH: "PUBLIC_RESEARCH",
  WORK_EVENT_WAIT: "WORK_LEDGER",
};

/** Explicit bounded seed heuristics. These are ordering estimates, not measured
 * probabilities, prices, or service-level promises. */
const ACTION_HEURISTICS: Readonly<Record<InformationActionKind, ActionHeuristic>> = {
  READ: {
    latency: { expectedMs: 50, maximumMs: 1_000 },
    cost: { monetaryUnits: 0, toolUnits: 1 },
    interruption: { required: false, units: 0 },
    privacyUnits: 0,
    failureRisk: 3,
    boundary: "CANONICAL_INTERNAL",
    freshness: { expected: "REFRESH", validityMs: 60_000 },
  },
  RETRIEVE: {
    latency: { expectedMs: 150, maximumMs: 2_000 },
    cost: { monetaryUnits: 0, toolUnits: 2 },
    interruption: { required: false, units: 0 },
    privacyUnits: 3,
    failureRisk: 8,
    boundary: "TENANT_INTERNAL",
    freshness: { expected: "NEW_OBSERVATION" },
  },
  ASK: {
    latency: { expectedMs: 30_000, maximumMs: 86_400_000 },
    cost: { monetaryUnits: 0, toolUnits: 0 },
    interruption: { required: true, units: 100 },
    privacyUnits: 2,
    failureRisk: 15,
    boundary: "USER",
    freshness: { expected: "NEW_OBSERVATION" },
  },
  INSPECT: {
    latency: { expectedMs: 1_000, maximumMs: 10_000 },
    cost: { monetaryUnits: 0, toolUnits: 4 },
    interruption: { required: false, units: 0 },
    privacyUnits: 12,
    failureRisk: 18,
    boundary: "CONFIGURED_PROVIDER",
    freshness: { expected: "REFRESH", validityMs: 30_000 },
  },
  RESEARCH: {
    latency: { expectedMs: 2_000, maximumMs: 20_000 },
    cost: { monetaryUnits: 1, toolUnits: 5 },
    interruption: { required: false, units: 0 },
    privacyUnits: 25,
    failureRisk: 25,
    boundary: "PUBLIC_WEB",
    freshness: { expected: "NEW_OBSERVATION" },
  },
  WAIT: {
    latency: { expectedMs: 5_000, maximumMs: 86_400_000 },
    cost: { monetaryUnits: 0, toolUnits: 1 },
    interruption: { required: false, units: 0 },
    privacyUnits: 0,
    failureRisk: 10,
    boundary: "EVENT_STREAM",
    freshness: { expected: "NEW_OBSERVATION" },
  },
};

export interface InformationActionOverrides {
  query?: InformationAction["requiredInput"]["query"];
  sensitivity?: InformationSensitivity[];
  latency?: Partial<InformationAction["latency"]>;
  cost?: Partial<InformationAction["cost"]>;
  privacy?: Partial<PrivacyExposure>;
  estimate?: Partial<InformationAction["estimate"]>;
  promptFields?: string[];
  expectedSchema?: string;
}

function criticalityPriority(criticality: Uncertainty["decisionDependency"]["criticality"]): number {
  if (criticality === "SAFETY_LEGAL") return 100;
  if (criticality === "CONSEQUENTIAL") return 80;
  if (criticality === "OPERATIONAL") return 50;
  return 20;
}

function expectedReduction(category: Uncertainty["category"], kind: InformationActionKind): number {
  if (category === "UNOBSERVABLE" || category === "PERMISSION_BLOCKED") return 0;
  if (category === "AMBIGUOUS" && kind === "ASK") return 90;
  if (category === "EXTERNAL_UNKNOWN" && (kind === "INSPECT" || kind === "WAIT")) return 85;
  if (category === "STALE" && (kind === "READ" || kind === "INSPECT")) return 90;
  if (category === "CONFLICTING" && (kind === "READ" || kind === "INSPECT")) return 85;
  if (category === "MISSING" && kind === "READ") return 90;
  if (category === "LOW_CONFIDENCE" && (kind === "RETRIEVE" || kind === "RESEARCH")) return 60;
  return 45;
}

function boundaryFor(option: AcquisitionOption): InformationBoundary {
  if (option.adapterId === "COMPUTER_READ_ONLY_OBSERVATION") return "COMPUTER_APPLICATION";
  if (option.adapterId === "SOURCE_TRUTH_OBSERVATION") return "CONFIGURED_PROVIDER";
  return ACTION_HEURISTICS[option.kind].boundary;
}

export function createInformationAction(
  scope: EpistemicScope,
  uncertainty: Uncertainty,
  option: AcquisitionOption,
  overrides: InformationActionOverrides = {},
): InformationAction {
  if (ADAPTER_ACTION_KIND[option.adapterId] !== option.kind) {
    throw new Error(`Information adapter ${option.adapterId} cannot execute ${option.kind}`);
  }
  if (ADAPTER_SOURCE_AUTHORITY[option.adapterId] !== option.expectedAuthority) {
    throw new Error(`Information adapter ${option.adapterId} cannot claim ${option.expectedAuthority}`);
  }
  const seed = ACTION_HEURISTICS[option.kind];
  const sensitivity = [...new Set(overrides.sensitivity ?? ["TENANT_INTERNAL"])] as InformationSensitivity[];
  const idSeed = {
    decisionId: scope.decisionId,
    propositionId: uncertainty.requiredPropositionId,
    kind: option.kind,
    adapterId: option.adapterId,
    query: overrides.query ?? {},
  };
  return {
    id: `info:${epistemicHash(idSeed).slice(0, 24)}`,
    kind: option.kind,
    adapterId: option.adapterId,
    scope: { ...scope },
    requiredInput: {
      propositionIds: [uncertainty.requiredPropositionId],
      query: overrides.query ?? {},
      sensitivity,
      tenantId: scope.tenantId,
      principalId: scope.principalId,
    },
    expectedInformation: {
      propositionIds: [uncertainty.requiredPropositionId],
      possibleStatuses: ["KNOWN", "UNCERTAIN", "CONFLICTING"],
      evidenceKind: evidenceKindFor(option.adapterId),
      schema: overrides.expectedSchema ?? `epistemic:${uncertainty.requiredPropositionId}`,
    },
    sourceAuthority: option.expectedAuthority,
    cost: {
      monetaryUnits: overrides.cost?.monetaryUnits ?? seed.cost.monetaryUnits,
      toolUnits: overrides.cost?.toolUnits ?? seed.cost.toolUnits,
      provenance: overrides.cost?.provenance ?? "BOUNDED_HEURISTIC",
    },
    latency: {
      expectedMs: overrides.latency?.expectedMs ?? seed.latency.expectedMs,
      maximumMs: overrides.latency?.maximumMs ?? seed.latency.maximumMs,
    },
    userInterruption: {
      required: seed.interruption.required,
      units: seed.interruption.units,
      promptFields: overrides.promptFields ?? (option.kind === "ASK" ? [uncertainty.requiredPropositionId] : []),
    },
    privacyExposure: {
      boundary: overrides.privacy?.boundary ?? boundaryFor(option),
      sensitivity: overrides.privacy?.sensitivity ?? sensitivity,
      units: overrides.privacy?.units ?? seed.privacyUnits,
      declassified: overrides.privacy?.declassified ?? false,
      authorizationEvidenceRefs: overrides.privacy?.authorizationEvidenceRefs ?? [],
    },
    failureModes: [
      { code: `${option.adapterId}_UNAVAILABLE`, recoverable: option.kind !== "ASK", riskUnits: seed.failureRisk },
      { code: "NO_RESULT", recoverable: true, riskUnits: Math.max(1, Math.floor(seed.failureRisk / 2)) },
    ],
    freshnessGain: seed.freshness,
    decisionDependency: {
      decisionId: uncertainty.decisionDependency.decisionId,
      propositionIds: [uncertainty.requiredPropositionId],
      criticality: uncertainty.decisionDependency.criticality,
    },
    estimate: {
      decisionQualityImprovement: overrides.estimate?.decisionQualityImprovement ?? (uncertainty.decisionDependency.mandatory ? 90 : 45),
      expectedUncertaintyReduction: overrides.estimate?.expectedUncertaintyReduction ?? expectedReduction(uncertainty.category, option.kind),
      decisionRelevance: overrides.estimate?.decisionRelevance ?? (uncertainty.decisionDependency.mandatory ? 100 : 60),
      safetyLegalityPriority: overrides.estimate?.safetyLegalityPriority ?? criticalityPriority(uncertainty.decisionDependency.criticality),
      failureRisk: overrides.estimate?.failureRisk ?? seed.failureRisk,
      provenance: overrides.estimate?.provenance ?? "BOUNDED_HEURISTIC",
      heuristicVersion: EPISTEMIC_HEURISTIC_VERSION,
      reasonCodes: [...new Set([
        `ACQUISITION_OPTION_${option.kind}_${option.adapterId}`,
        ...uncertainty.reasonCodes,
        ...(overrides.estimate?.reasonCodes ?? []),
      ])],
    },
    mutability: "READ_ONLY",
  };
}

function evidenceKindFor(adapterId: InformationAdapterId): InformationAction["expectedInformation"]["evidenceKind"] {
  switch (adapterId) {
    case "CANONICAL_OPERATIONAL_QUERY":
    case "OPERATING_CONTEXT_READ":
      return "CANONICAL_DB";
    case "HYBRID_RETRIEVAL":
      return "MEMORY";
    case "EVIDENCE_CORPUS_RETRIEVAL":
      return "DOCUMENT";
    case "CLARIFICATION_REQUEST":
      return "EXPLICIT_USER_INPUT";
    case "SOURCE_TRUTH_OBSERVATION":
      return "PROVIDER_OBSERVATION";
    case "COMPUTER_READ_ONLY_OBSERVATION":
      return "COMPUTER_OBSERVATION";
    case "WEB_RESEARCH":
      return "WEB_RESEARCH";
    case "WORK_EVENT_WAIT":
      return "ACTIVE_WORK";
  }
}

export function informationActionFingerprint(action: InformationAction): string {
  return epistemicHash({
    kind: action.kind,
    adapterId: action.adapterId,
    tenantId: action.scope.tenantId,
    propositionIds: action.requiredInput.propositionIds,
    query: action.requiredInput.query,
    boundary: action.privacyExposure.boundary,
  });
}

export interface InformationActionExecutor {
  execute(action: InformationAction): Promise<InformationObservation>;
}

export interface InformationAdapter {
  id: InformationAdapterId;
  execute(action: InformationAction): Promise<InformationObservation>;
}

/** The registry accepts only read-only InformationAction contracts. Business-action
 * tools have no compatible registration surface. */
export class ReadOnlyInformationActionExecutor implements InformationActionExecutor {
  private readonly adapters = new Map<InformationAdapterId, InformationAdapter>();

  constructor(
    adapters: readonly InformationAdapter[],
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.id)) throw new Error(`Duplicate information adapter: ${adapter.id}`);
      this.adapters.set(adapter.id, adapter);
    }
  }

  async execute(action: InformationAction): Promise<InformationObservation> {
    assertInformationAction(action);
    const adapter = this.adapters.get(action.adapterId);
    if (!adapter) {
      return {
        actionId: action.id,
        adapterId: action.adapterId,
        tenantId: action.scope.tenantId,
        observedAt: this.now(),
        evidence: [],
        propositionIds: action.expectedInformation.propositionIds,
        outcome: "FAILED",
        failureCode: "ADAPTER_UNAVAILABLE",
      };
    }
    try {
      const observation = await adapter.execute(action);
      assertInformationObservationForAction(action, observation);
      return observation;
    } catch {
      return {
        actionId: action.id,
        adapterId: action.adapterId,
        tenantId: action.scope.tenantId,
        observedAt: this.now(),
        evidence: [],
        propositionIds: action.expectedInformation.propositionIds,
        outcome: "FAILED",
        failureCode: "ADAPTER_EXECUTION_OR_CONTRACT_FAILURE",
      };
    }
  }
}

export function assertInformationAction(action: InformationAction): void {
  if (action.mutability !== "READ_ONLY") throw new Error("Information actions must be read-only");
  if (action.scope.tenantId !== action.requiredInput.tenantId) throw new Error("Information action tenant mismatch");
  if (action.scope.principalId !== action.requiredInput.principalId) throw new Error("Information action principal mismatch");
  if (!action.requiredInput.propositionIds.length) throw new Error("Information action requires at least one proposition");
  if (ADAPTER_ACTION_KIND[action.adapterId] !== action.kind) throw new Error("Information action kind does not match its adapter contract");
  if (ADAPTER_SOURCE_AUTHORITY[action.adapterId] !== action.sourceAuthority) throw new Error("Information action source authority does not match its adapter contract");
  const numericBounds = [
    action.cost.monetaryUnits,
    action.cost.toolUnits,
    action.latency.expectedMs,
    action.latency.maximumMs,
    action.userInterruption.units,
    action.privacyExposure.units,
  ];
  if (numericBounds.some((value) => !Number.isFinite(value) || value < 0) || action.latency.maximumMs < action.latency.expectedMs) {
    throw new Error("Information action cost/latency bounds are invalid");
  }
}

export function assertInformationObservationForAction(
  action: InformationAction,
  observation: InformationObservation,
): void {
  if (observation.actionId !== action.id || observation.adapterId !== action.adapterId) throw new Error("Information adapter returned mismatched action identity");
  if (observation.tenantId !== action.scope.tenantId) throw new Error("Cross-tenant information adapter result rejected");
  if (!Number.isFinite(Date.parse(observation.observedAt))) throw new Error("Information adapter returned an invalid observation timestamp");
  const expected = new Set(action.expectedInformation.propositionIds);
  if (observation.propositionIds.some((id) => !expected.has(id))) throw new Error("Information adapter returned an unexpected proposition");
  for (const record of observation.evidence) {
    if (record.tenantId !== action.scope.tenantId) throw new Error("Cross-tenant information evidence rejected");
    if (!expected.has(record.propositionId) || !observation.propositionIds.includes(record.propositionId)) {
      throw new Error("Information evidence does not match the action proposition contract");
    }
    if (record.source.kind !== action.expectedInformation.evidenceKind) throw new Error("Information evidence kind does not match the adapter contract");
    if (record.source.authority !== action.sourceAuthority) throw new Error("Information evidence authority does not match the adapter contract");
    if (record.immutable !== true || record.provenance.sourceRef !== record.source.ref) throw new Error("Information evidence is not immutable and provenance-backed");
  }
  if (observation.outcome === "OBSERVED" && observation.evidence.length === 0) throw new Error("OBSERVED information action requires evidence");
  if (observation.outcome !== "OBSERVED" && observation.evidence.length > 0) throw new Error("Non-observed information outcome cannot smuggle evidence");
  if (["FAILED", "PERMISSION_BLOCKED"].includes(observation.outcome) && !observation.failureCode) {
    throw new Error("Failed or permission-blocked information outcome requires a failure code");
  }
}

export function assertAcquisitionBudget(budget: AcquisitionBudget): void {
  const boundedIntegers: Array<[number, string]> = [
    [budget.maxActions, "maxActions"],
    [budget.maxUserInterruptions, "maxUserInterruptions"],
    [budget.maxLatencyMs, "maxLatencyMs"],
    [budget.maxCostUnits, "maxCostUnits"],
  ];
  for (const [value, name] of boundedIntegers) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Acquisition budget ${name} must be a non-negative safe integer`);
  }
  if (!Number.isFinite(Date.parse(budget.deadline))) throw new Error("Acquisition budget deadline must be an ISO-compatible timestamp");
}

export function informationActionPrivacyErrors(action: InformationAction): string[] {
  const errors: string[] = [];
  const sensitivities = new Set(action.privacyExposure.sensitivity);
  const external = ["PUBLIC_WEB", "CONFIGURED_PROVIDER", "COMPUTER_APPLICATION"].includes(action.privacyExposure.boundary);
  if (external && sensitivities.has("SECRET")) errors.push("SECRET_EXTERNAL_ACQUISITION_FORBIDDEN");
  if (external && sensitivities.has("UNCLASSIFIED")) errors.push("UNCLASSIFIED_EXTERNAL_ACQUISITION_FORBIDDEN");
  if (action.privacyExposure.boundary === "PUBLIC_WEB") {
    const nonPublic = [...sensitivities].filter((sensitivity) => sensitivity !== "PUBLIC");
    if (nonPublic.length && !action.privacyExposure.declassified) errors.push("PRIVATE_DATA_TO_PUBLIC_RESEARCH_FORBIDDEN");
  }
  if (external && sensitivities.has("CREDENTIAL_BOUND") && action.privacyExposure.authorizationEvidenceRefs.length === 0) {
    errors.push("CREDENTIAL_BOUND_ACQUISITION_REQUIRES_AUTHORIZATION_EVIDENCE");
  }
  if (external && ["CUSTOMER_DATA", "PII", "FINANCIAL"].some((sensitivity) => sensitivities.has(sensitivity as InformationSensitivity))
    && action.privacyExposure.authorizationEvidenceRefs.length === 0) {
    errors.push("SENSITIVE_EXTERNAL_ACQUISITION_REQUIRES_AUTHORIZATION_EVIDENCE");
  }
  if (action.privacyExposure.boundary === "TENANT_INTERNAL"
    && ["SECRET", "CREDENTIAL_BOUND"].some((sensitivity) => sensitivities.has(sensitivity as InformationSensitivity))
    && action.privacyExposure.authorizationEvidenceRefs.length === 0) {
    errors.push("SENSITIVE_INTERNAL_ACQUISITION_REQUIRES_AUTHORIZATION_EVIDENCE");
  }
  return errors;
}

export function budgetAllowsAction(
  budget: AcquisitionBudget,
  usage: AcquisitionUsage,
  action: InformationAction,
  now: string,
): { allowed: boolean; reasonCodes: string[] } {
  assertAcquisitionBudget(budget);
  const reasons: string[] = [];
  if (Date.parse(now) >= Date.parse(budget.deadline)) reasons.push("DEADLINE_REACHED");
  if (usage.actions + 1 > budget.maxActions) reasons.push("MAX_ACTIONS_EXCEEDED");
  if (usage.userInterruptions + (action.userInterruption.required ? 1 : 0) > budget.maxUserInterruptions) reasons.push("MAX_USER_INTERRUPTION_EXCEEDED");
  if (usage.latencyMs + action.latency.maximumMs > budget.maxLatencyMs) reasons.push("MAX_LATENCY_EXCEEDED");
  if (usage.costUnits + action.cost.monetaryUnits + action.cost.toolUnits > budget.maxCostUnits) reasons.push("MAX_COST_EXCEEDED");
  if (usage.selectedActionFingerprints.includes(informationActionFingerprint(action))) reasons.push("DUPLICATE_ACQUISITION_LOOP");
  return { allowed: reasons.length === 0, reasonCodes: reasons };
}

export function consumeActionBudget(usage: AcquisitionUsage, action: InformationAction, elapsedMs: number): AcquisitionUsage {
  return {
    actions: usage.actions + 1,
    userInterruptions: usage.userInterruptions + (action.userInterruption.required ? 1 : 0),
    latencyMs: usage.latencyMs + Math.max(0, elapsedMs),
    costUnits: usage.costUnits + action.cost.monetaryUnits + action.cost.toolUnits,
    selectedActionFingerprints: [...usage.selectedActionFingerprints, informationActionFingerprint(action)],
  };
}

export function informationActionKindsAreNonMutating(): boolean {
  return (Object.keys(ACTION_HEURISTICS) as InformationActionKind[]).every((kind) => ACTION_HEURISTICS[kind] !== undefined);
}

export type { SourceAuthority };

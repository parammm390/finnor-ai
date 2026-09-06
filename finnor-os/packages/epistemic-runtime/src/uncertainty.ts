import type {
  AcquisitionOption,
  DecisionCriticality,
  DecisionRequirement,
  EpistemicState,
  PropositionDefinition,
  StaticAdmissibilityIssueLike,
  StaticAdmissibilityResultLike,
  Uncertainty,
  UncertaintyCategory,
} from "./contracts";
import { confidenceAtLeast, propositionById, requirementResolved } from "./state";
import { epistemicHash } from "./source-precedence";

export interface AcquisitionPolicySnapshot {
  allowedAdapters?: readonly AcquisitionOption["adapterId"][];
  deniedAdapters?: readonly AcquisitionOption["adapterId"][];
  externalObservationPossible?: boolean;
}

function categoryFor(
  state: EpistemicState,
  requirement: DecisionRequirement,
  policy: AcquisitionPolicySnapshot,
): { category: UncertaintyCategory; why: string; reasonCodes: string[] } {
  const proposition = propositionById(state, requirement.propositionId);
  if (!proposition) return { category: "UNOBSERVABLE", why: "Required proposition is absent from the epistemic contract.", reasonCodes: ["PROPOSITION_NOT_DECLARED"] };
  const permitted = requirement.acquisitionOptions.filter((option) =>
    (!policy.allowedAdapters || policy.allowedAdapters.includes(option.adapterId))
    && !policy.deniedAdapters?.includes(option.adapterId),
  );
  if (requirement.acquisitionOptions.length > 0 && permitted.length === 0) {
    return { category: "PERMISSION_BLOCKED", why: "Every declared acquisition adapter is denied by the current read/privacy boundary.", reasonCodes: ["ACQUISITION_PERMISSION_BLOCKED"] };
  }
  if (proposition.status === "STALE") {
    return { category: "STALE", why: proposition.freshness.reason, reasonCodes: ["REQUIRED_EVIDENCE_STALE"] };
  }
  if (proposition.status === "CONFLICTING") {
    return { category: "CONFLICTING", why: "Equal-authority evidence disagrees and no deterministic winner exists.", reasonCodes: ["DECISION_RELEVANT_CONFLICT"] };
  }
  if (proposition.status === "UNCERTAIN") {
    if (proposition.value.kind === "ALTERNATIVES" || proposition.confidence.reasonCodes.some((code) => code.includes("AMBIGU"))) {
      return { category: "AMBIGUOUS", why: "Multiple candidates remain possible.", reasonCodes: ["MULTIPLE_CANDIDATES"] };
    }
    return { category: "LOW_CONFIDENCE", why: "Available evidence does not meet the requirement's confidence floor.", reasonCodes: ["CONFIDENCE_FLOOR_NOT_MET"] };
  }
  if (proposition.status === "UNKNOWN") {
    if (requirement.acquisitionOptions.length === 0) {
      return { category: "UNOBSERVABLE", why: "No legal acquisition option is declared for this proposition.", reasonCodes: ["NO_ACQUISITION_OPTION"] };
    }
    const external = proposition.subject.kind === "external" || proposition.subject.kind === "provider";
    if (requirement.unresolvedCategoryHint) {
      return {
        category: requirement.unresolvedCategoryHint,
        why: `The upstream decision contract classified this proposition as ${requirement.unresolvedCategoryHint.toLowerCase()}.`,
        reasonCodes: [...new Set(requirement.unresolvedReasonCodes ?? [`UPSTREAM_${requirement.unresolvedCategoryHint}`])],
      };
    }
    if (external && policy.externalObservationPossible === false) {
      return { category: "EXTERNAL_UNKNOWN", why: "The external outcome is not currently observable through a configured read-only boundary.", reasonCodes: ["EXTERNAL_OBSERVATION_UNAVAILABLE"] };
    }
    return external
      ? { category: "EXTERNAL_UNKNOWN", why: "External state has not yet been observed.", reasonCodes: ["EXTERNAL_STATE_NOT_OBSERVED"] }
      : { category: "MISSING", why: "No evidence currently supports the required proposition.", reasonCodes: ["REQUIRED_EVIDENCE_MISSING"] };
  }
  if (requirement.minimumConfidence && !confidenceAtLeast(proposition.confidence.level, requirement.minimumConfidence)) {
    return { category: "LOW_CONFIDENCE", why: "Known evidence is below the explicit confidence floor.", reasonCodes: ["CONFIDENCE_FLOOR_NOT_MET"] };
  }
  return { category: "MISSING", why: "The requirement remains unresolved under its status, authority, freshness, or provenance constraints.", reasonCodes: ["REQUIREMENT_NOT_SATISFIED"] };
}

export function analyzeUncertainty(
  state: EpistemicState,
  requirements: readonly DecisionRequirement[],
  policy: AcquisitionPolicySnapshot = {},
): Uncertainty[] {
  return requirements
    .filter((requirement) => !requirementResolved(state, requirement))
    .map((requirement) => {
      const classified = categoryFor(state, requirement, policy);
      return {
        id: `uncertainty:${epistemicHash({ propositionId: requirement.propositionId, decisionId: requirement.decisionId, category: classified.category }).slice(0, 24)}`,
        category: classified.category,
        requiredPropositionId: requirement.propositionId,
        whyUnresolved: classified.why,
        reasonCodes: classified.reasonCodes,
        decisionDependency: {
          decisionId: requirement.decisionId,
          criticality: requirement.criticality,
          mandatory: requirement.mandatory,
        },
        possibleAcquisitionActions: [...requirement.acquisitionOptions],
        consequenceOfActingWithoutResolution: requirement.consequenceIfUnresolved,
      };
    })
    .sort((left, right) => `${left.requiredPropositionId}:${left.category}`.localeCompare(`${right.requiredPropositionId}:${right.category}`));
}

function p2AcquisitionOptions(issue: StaticAdmissibilityIssueLike): AcquisitionOption[] {
  const detailCode = typeof issue.detail?.resolutionReasonCode === "string" ? issue.detail.resolutionReasonCode : issue.reasonCode;
  if (detailCode === "ENTITY_REFERENCE_AMBIGUOUS") {
    return [
      { kind: "READ", adapterId: "CANONICAL_OPERATIONAL_QUERY", reason: "Re-run a typed tenant-scoped entity lookup.", expectedAuthority: "CANONICAL_OWNER" },
      { kind: "ASK", adapterId: "CLARIFICATION_REQUEST", reason: "Ask only if canonical lookup cannot distinguish candidates.", expectedAuthority: "USER_INTENT_OWNER" },
    ];
  }
  if (detailCode.startsWith("ENTITY_")) {
    return [{ kind: "READ", adapterId: "CANONICAL_OPERATIONAL_QUERY", reason: "Resolve the entity through the existing canonical operational query plane.", expectedAuthority: "CANONICAL_OWNER" }];
  }
  if (detailCode === "BINDING_CONFIGURATION_UNRESOLVED") {
    return [
      { kind: "READ", adapterId: "OPERATING_CONTEXT_READ", reason: "Read configured integration health/binding state.", expectedAuthority: "CANONICAL_OWNER" },
      { kind: "INSPECT", adapterId: "SOURCE_TRUTH_OBSERVATION", reason: "Inspect configured provider state without mutation if the canonical binding read is insufficient.", expectedAuthority: "GOVERNED_OBSERVATION" },
    ];
  }
  if (detailCode.startsWith("CAPABILITY_") || detailCode === "CAPABILITY_RESOLUTION_UNAVAILABLE") {
    return [{ kind: "READ", adapterId: "OPERATING_CONTEXT_READ", reason: "Read the existing capability and integration-health projection.", expectedAuthority: "CANONICAL_OWNER" }];
  }
  // Unsupported inference/lowering is an implementation seam, not missing facts.
  return [];
}

function subjectForP2Issue(issue: StaticAdmissibilityIssueLike): PropositionDefinition["subject"] {
  const detailCode = typeof issue.detail?.resolutionReasonCode === "string" ? issue.detail.resolutionReasonCode : issue.reasonCode;
  if (detailCode.startsWith("ENTITY_")) return { kind: "entity", type: "canonical_entity", id: issue.nodeId };
  if (detailCode.startsWith("CAPABILITY_") || detailCode.includes("BINDING")) return { kind: "system", type: "capability", id: issue.nodeId };
  return { kind: "system", type: "p2_static_semantics", id: issue.nodeId };
}

export interface P2UnresolvedRequirements {
  propositions: PropositionDefinition[];
  requirements: DecisionRequirement[];
}

/** Converts only P2 UNRESOLVED issues. REJECTED is intentionally not representable
 * as an acquisition request and must be handled by the P2 handoff gate. */
export function requirementsFromP2Unresolved(
  result: StaticAdmissibilityResultLike,
  decisionId: string,
  criticality: DecisionCriticality = "CONSEQUENTIAL",
): P2UnresolvedRequirements {
  if (result.status === "REJECTED") throw new Error("P2 REJECTED cannot be converted into P3 acquisition requirements");
  if (result.status === "ADMISSIBLE") return { propositions: [], requirements: [] };
  const issues = result.issues.filter((issue) => issue.status === "UNRESOLVED");
  const propositions: PropositionDefinition[] = [];
  const requirements: DecisionRequirement[] = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const detailCode = typeof issue.detail?.resolutionReasonCode === "string" ? issue.detail.resolutionReasonCode : issue.reasonCode;
    const propositionId = `p2:${issue.nodeId}:${detailCode}`;
    if (seen.has(propositionId)) continue;
    seen.add(propositionId);
    const options = p2AcquisitionOptions(issue);
    propositions.push({
      id: propositionId,
      subject: subjectForP2Issue(issue),
      predicate: { name: detailCode.toLowerCase(), path: issue.path, operator: "exists" },
    });
    requirements.push({
      propositionId,
      decisionId,
      description: issue.message,
      criticality,
      mandatory: true,
      acceptableStatuses: ["KNOWN"],
      minimumConfidence: "HIGH",
      consequenceIfUnresolved: `P2 remains UNRESOLVED at ${issue.nodeId}; consequential lowering cannot continue.`,
      acquisitionOptions: options,
      unresolvedCategoryHint: p2IssueUncertaintyCategory(issue),
      unresolvedReasonCodes: [detailCode, issue.reasonCode],
    });
  }
  return { propositions, requirements };
}

export function p2IssueUncertaintyCategory(issue: StaticAdmissibilityIssueLike): UncertaintyCategory {
  const code = typeof issue.detail?.resolutionReasonCode === "string" ? issue.detail.resolutionReasonCode : issue.reasonCode;
  if (code.includes("AMBIGUOUS")) return "AMBIGUOUS";
  if (code.includes("STALE")) return "STALE";
  if (code.includes("BINDING") || code.includes("EXTERNAL")) return "EXTERNAL_UNKNOWN";
  if (code.includes("PERMISSION")) return "PERMISSION_BLOCKED";
  if (code.includes("UNSUPPORTED") || code.includes("RUNTIME_ONLY")) return "UNOBSERVABLE";
  return "MISSING";
}

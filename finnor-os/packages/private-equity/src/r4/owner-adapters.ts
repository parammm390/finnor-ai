import type { BeliefView, ContingentPolicy, ExperimentRef, InterventionModel } from "@finnor/shared-types";
import type { IdentificationPlan, IdentificationProblem } from "../../../shared-types/src/identification-plan";
import { IdentificationProblemSchema } from "../../../shared-types/src/identification-plan";
import { exactOwnerNumber, hash, stable } from "./exact";

const reference = (owner: string, prefix: string, body: unknown, version: string): ExperimentRef => {
  const contentDigest = hash(body);
  return { owner, id: prefix + ":" + contentDigest, version, contentDigest };
};

/** New observational domain, deliberately not an ExperimentProtocol adapter. */
export function observationalProfile(view: BeliefView, value: unknown) {
  const problem = IdentificationProblemSchema.parse(value);
  const body = {
    schema: "finnor.s2.observational-acquisition-profile.v1",
    tenantId: view.tenantId, principalId: view.principalId, rightsRef: view.rights.ref,
    sourceDependencyDigest: view.pin.dependencyDigest, scope: problem.query.scope,
    bundles: problem.bundles, baseline: problem.baseline,
    constraints: problem.constraints, costItems: problem.costItems,
    qualification: "OWNER_DECLARED_COLLECTION_AND_SUPPORT_PREMISES_UNADMITTED",
    binomialProfileUsed: false, populationPositivityEstablished: false,
    physicalCollectionObserved: false, executionAuthorityGranted: false,
  };
  return { ...body, ref: reference("S2", "observational-profile", body, "s2-observational-acquisition-v1") };
}

export function identificationProfile(model: InterventionModel, value: unknown) {
  const problem = IdentificationProblemSchema.parse(value);
  const coordinates = [...model.request.stateVariables, ...model.request.exposures];
  if (problem.variables.some(v => !coordinates.some(c => c.id === v.id && c.unit === v.unit)))
    throw Error("R4_EXPLICIT_S3_VARIABLE_UNIT_METADATA_REQUIRED");
  const body = {
    schema: "finnor.s3.admg-query-profile.v1",
    tenantId: model.tenantId, principalId: model.principalId, modelRef: model.ref,
    graphFamily: problem.graphs, query: problem.query, variables: problem.variables,
    baseline: problem.baseline, acquisitionLaws: problem.bundles.map(b => ({ id: b.id, laws: b.laws })),
    representationAcceptedByOwner: true, coefficientGraphInferred: false,
    graphTruthEstablished: false, fieldIdentified: false,
    qualification: "OWNER_DECLARED_ADMG_QUERY_AND_DATA_PROFILE_UNADMITTED",
  };
  return { ...body, ref: reference("S3", "admg-query-profile", body, "s3-admg-query-profile-v1") };
}

export function observationalProposal(profile: ReturnType<typeof observationalProfile>,
  problem: IdentificationProblem, plan: IdentificationPlan, profileRef: ExperimentRef, originalEpisode: string) {
  if (stable(profile.scope) !== stable(plan.targetQuery.scope)) throw Error("R4_S2_PROPOSAL_SCOPE_MISMATCH");
  const body = {
    schema: "finnor.s2.r4-acquisition-proposal.v1", semanticOwner: "S2", profileRef,
    acquisitionProfileRef: profile.ref, originalEpisode, selected: plan.selected,
    bundles: problem.bundles.filter(b => plan.selected?.bundleIds.includes(b.id)),
    requiredConditions: plan.pairs.filter(pair => pair.mask === plan.selected?.mask).flatMap(pair => pair.conditions),
    scope: problem.query.scope, eligibility: profile.qualification,
    collectionObserved: false, protectedAdmission: null, executionAuthorityGranted: false,
  };
  return { ...body, ref: reference("S2", "r4-collection", body, "s2-observational-proposal-v1") };
}

export function identificationAssessment(model: InterventionModel, problem: IdentificationProblem,
  plan: IdentificationPlan, profileRef: ExperimentRef, checkerRef: ExperimentRef) {
  const body = {
    schema: "finnor.s3.r4-identification-assessment.v1", semanticOwner: "S3", profileRef,
    modelRef: model.ref, query: problem.query, identification: plan.identification,
    perGraph: plan.pairs.filter(pair => pair.mask === plan.selected?.mask),
    commonFunctional: plan.commonFunctional, checkerRef,
    graphTruthEstablished: false, fieldIdentified: false, effectEstimate: null, attributionGranted: false,
    qualification: "INDEPENDENT_MODEL_RELATIVE_SYMBOLIC_PROOF_UNDER_SUPPLIED_PREMISES_NOT_S8_ADMISSION",
  };
  return { ...body, ref: reference("S3", "r4-assessment", body, "s3-identification-assessment-v1") };
}

/** S4's original supplied utility, never a new R4 reward function or VOI proof. */
export function acquisitionReview(policy: ContingentPolicy, input: {
  proposalRef: ExperimentRef | null; plan: IdentificationPlan | null;
  disposition: "PROPOSE" | "DECLINE" | "WAIT"; remainingDeadlineMs: number;
  originalEpisode: string;
}) {
  const terms = policy.mandate.utility.deliberation, selected = input.plan?.selected;
  const cost = selected ? exactOwnerNumber(selected.totalCost) : null;
  const delay = selected ? exactOwnerNumber(selected.completion) : null;
  const hypotheticalNetValue = terms && cost !== null && delay !== null
    ? terms.lossWithoutQualifiedResult - terms.lossWithQualifiedResult - cost - delay * 1000 * terms.delayMsCost : null;
  const status = input.remainingDeadlineMs < 1 ? "ORIGINAL_GRANT_EXHAUSTED"
    : input.disposition === "WAIT" || !selected ? "WAIT"
    : input.disposition === "DECLINE" ? "DECLINED_BY_OWNER"
    : hypotheticalNetValue === null ? "INFORMATION_VALUE_UNRESOLVED"
    : hypotheticalNetValue <= 0 ? "DECLINED_REGISTERED_COST_OR_DELAY"
    : "ACCEPT_FOR_PLANNING";
  const body = {
    schema: "finnor.s4.observational-acquisition-review.v1",
    tenantId: policy.tenantId, principalId: policy.principalId,
    incumbentPolicyRef: policy.ref, mandateRef: policy.mandateRef,
    utilityRef: policy.mandate.utilityRef, utilityDigest: hash(policy.mandate.utility),
    proposalRef: input.proposalRef, originalEpisode: input.originalEpisode,
    remainingDeadlineMs: input.remainingDeadlineMs, status,
    registeredCost: selected?.totalCost ?? null, registeredDelay: selected?.completion ?? null,
    hypotheticalNetValue, futureCollectionSuccessAssumedForPlanningOnly: true,
    utilityUnchanged: true, actualInformationValue: null, actualAcquisitionCost: null,
    qualification: "SUPPLIED_OWNER_FINITE_PLANNING_UTILITY_NOT_FIELD_WEALTH_OR_ADMISSION",
    executionAuthorityGranted: false, reservationGranted: false, attributionGranted: false,
  };
  return { ...body, ref: reference("S4", "acquisition-review", body, "s4-observational-review-v1") };
}

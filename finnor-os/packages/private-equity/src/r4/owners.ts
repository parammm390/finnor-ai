import type { PeMutationContext } from "../types";
import { loadEnterpriseBeliefView, validateBeliefViewPin, authorizeBeliefSourceScopes } from "../enterprise-beliefs";
import { readEnterpriseInterventionMetadataForObservation, registerEnterpriseIdentificationProfile, assessEnterpriseIdentificationPlan } from "../enterprise-interventions";
import { registerEnterpriseObservationalAcquisitionProfile, proposeEnterpriseObservationalAcquisition } from "../enterprise-experiments";
import { readEnterpriseControlDecisionContext, synthesizeEnterpriseControlProposal, chooseEnterpriseControlBranch, reviewEnterpriseObservationalAcquisition } from "../enterprise-control";
import { readEnterpriseAllocation, validateEnterpriseAllocation } from "../enterprise-allocation";
import { readEnterpriseEconomicRecord } from "../enterprise-economic-attribution";
import { authorize, principal, tx } from "../evidence-execution/store";
import { hash, stable } from "./exact";
import type { ProfileRegistration, R4Profile, R4RunRow } from "./contracts";
import { append, artifact, currentLocal, costs } from "./store";
import type { IdentificationPlan } from "../../../shared-types/src/identification-plan";

/** Explicit S3/S7 profile adapter. Fitted numbers are metadata, never ADMG edges. */
export async function resolveProfileOwners(ctx: PeMutationContext, registration: ProfileRegistration) {
  if (ctx.auth.role !== "owner") throw Error("R4_AUTHENTICATED_OWNER_REQUIRED");
  const { root, problem } = registration;
  await authorize(ctx, root, [{ type: "work", id: registration.workId }]);
  const view = await loadEnterpriseBeliefView(ctx, { root });
  if (view.coverage.canonicalStatus !== "COMPLETE" || view.coverage.truncated) throw Error("R4_S1_PERMITTED_COMPLETE_CUT_REQUIRED");
  const context = await readEnterpriseControlDecisionContext(ctx, registration.policyRef);
  const model = await readEnterpriseInterventionMetadataForObservation(ctx, registration.modelRef);
  if (stable(context.model.ref) !== stable(model.ref) || model.request.episodeId !== context.policy.mandate.episodeId ||
      !model.request.roots.some(r => r.entityType === root.entityType && r.entityId === root.entityId))
    throw Error("R4_S3_S4_ROOT_MODEL_EPISODE_BINDING");
  const coordinates = [...model.request.stateVariables, ...model.request.exposures];
  if (problem.variables.some(v => !coordinates.some(c => c.id === v.id && c.unit === v.unit)))
    throw Error("R4_EXPLICIT_S3_VARIABLE_UNIT_METADATA_REQUIRED");
  const s2 = await registerEnterpriseObservationalAcquisitionProfile(ctx, { root, problem });
  const s3 = await registerEnterpriseIdentificationProfile(ctx, { modelRef: model.ref, problem });
  // Graph family and query remain supplied assumptions, not a coefficient graph.
  const estimand = await readEnterpriseEconomicRecord(ctx, { id: registration.estimandId });
  const target = await readEnterpriseEconomicRecord(ctx, { id: registration.targetRecordId });
  if (!("payload" in estimand) || !("payload" in target)) throw Error("R4_CANONICAL_S7_RECORD_REQUIRED");
  const e = estimand.payload.estimand as any, mapping = target.payload.record as any;
  if (estimand.kind !== "PREREGISTRATION" || target.kind !== "SOURCE" ||
      target.payload.physicalCompletionGranted !== false || target.payload.economicCreditGranted !== false ||
      mapping?.schema !== "finnor.r4.s7-query-binding.v1" ||
      mapping.estimandId !== estimand.ref.id || mapping.episodeId !== context.policy.mandate.episodeId ||
      stable(mapping.scope) !== stable(problem.query.scope) ||
      stable(mapping.query) !== stable({ outcomes: problem.query.outcomes, treatments: problem.query.treatments, conditions: problem.query.conditions }) ||
      problem.query.estimandRef !== estimand.ref.id ||
      problem.query.scope.population !== e.populationRef.id ||
      problem.query.scope.time.start !== e.assignmentAt || problem.query.scope.time.end !== e.endpointAt ||
      !e.controllers.some((c: any) => c.interventionRefs.some((r: any) => r.id === problem.query.scope.intervention)) ||
      stable(e.mandateRef) !== stable(context.policy.mandateRef))
    throw Error("R4_CURRENT_S7_TARGET_POPULATION_INTERVENTION_TIME_BINDING_REQUIRED");
  const allocation = await readEnterpriseAllocation(ctx, registration.allocationRef);
  const allocationState = await validateEnterpriseAllocation(ctx, registration.allocationRef);
  if (allocationState.status !== "CURRENT" || !allocation.reservation ||
      !allocation.certificate.check.selectedPolicyIds.includes(context.policy.ref.id) ||
      stable(allocation.certificate.mandateRef) !== stable(context.policy.mandateRef) ||
      allocation.certificate.rightsRef !== context.policy.bindings.rightsRef)
    throw Error("R4_CURRENT_S5_SELECTED_POLICY_GRANT_REQUIRED");
  const nativeResources = allocation.problem.resources.filter(r => r.resourceClass === "COMPUTE" &&
    r.unit === "native-attempt" && r.kind === "CUMULATIVE_EXPENDITURE");
  if (nativeResources.length !== 1) throw Error("R4_S5_NATIVE_ATTEMPT_MAPPING_UNAVAILABLE");
  const resource = nativeResources[0]!, envelope = allocation.reservation.envelopes.find(e => e.resourceId === resource.resourceId);
  if (!envelope || stable(envelope.horizon) !== stable(context.policy.mandate.horizon) ||
      !allocation.problem.demandBindings.some(b => stable(b.policyRef) === stable(context.policy.ref) &&
        b.resourceId === resource.resourceId && b.component === "TOTAL" && b.conversion === "IDENTICAL_UNIT_NO_CONVERSION"))
    throw Error("R4_S5_SAME_UNIT_ENVELOPE_REQUIRED");
  const period = Math.floor((Date.now() - Date.parse(envelope.horizon.startAt)) / envelope.horizon.periodMs);
  const amounts = period < 0 ? [] : envelope.quantities.slice(0, period + 1);
  if (period >= envelope.horizon.periods || !amounts.length || amounts.some(n => !/^\d+$/.test(n)))
    throw Error("R4_ORIGINAL_COMPUTE_HORIZON_UNAVAILABLE");
  const capacity = amounts.reduce((n, v) => n + Number(v), 0);
  if (!Number.isSafeInteger(capacity) || capacity < 2 || capacity > 1000000) throw Error("R4_NATIVE_GRANT_CAPACITY_UNSUPPORTED");
  const basis = problem.constraints.costBasis;
  if (basis.unit !== context.policy.mandate.utility.unit || basis.currency !== e.currency ||
      stable(basis.horizon) !== stable(mapping.scope.time))
    throw Error("R4_REGISTERED_COST_OWNER_TIME_UNIT_REQUIRED");

  // Resolve actual immutable source handles, not a request-provided receipt.
  const laws = [...problem.baseline, ...problem.bundles.flatMap(b => b.laws)];
  const sourceRefs = [...new Set(laws.flatMap(l => l.sourceRefs))].sort();
  if (sourceRefs.some(id => !/^[a-f0-9-]{36}$/i.test(id))) throw Error("R4_CANONICAL_SOURCE_VERSION_HANDLES_REQUIRED");
  const sources = await tx(ctx, async c => (await c.query(
    "SELECT id,source_id,content_hash,snapshot,as_of FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=ANY($2::uuid[]) ORDER BY id",
    [ctx.auth.tenantId, sourceRefs])).rows, true);
  if (sources.length !== sourceRefs.length) throw Error("R4_S1_SOURCE_HANDLE_UNAVAILABLE");
  await authorizeBeliefSourceScopes(ctx, root, sources.map(s => s.source_id));
  for (const law of laws) {
    const declared = sources.flatMap(s => s.snapshot?.identificationLaws ?? []);
    if (!declared.some(l => stable(l) === stable(law))) throw Error("R4_SOURCE_LAW_PREIMAGE_OR_COLLECTION_DECLARATION_MISMATCH");
  }
  for (const b of problem.bundles) {
    if (b.admissibility.staffing !== "PERMITTED") continue;
    // No mandate benefits/compensation reduction is implied by a cost proposal.
    if ((sources.some(s => s.snapshot?.requiresLayoffs === true || s.snapshot?.requiresBenefitReduction === true)))
      throw Error("R4_MANDATE_STAFFING_BENEFIT_CONSTRAINT");
  }
  const binding = {
    S1: { pin: view.pin, rightsRef: view.rights.ref, sourceHandles: sources.map(s => ({
      versionId: s.id, sourceId: s.source_id, contentDigest: s.content_hash, snapshotDigest: hash(s.snapshot), asOf: s.as_of,
    })) },
    S2: { version: "s2-observational-acquisition-v1", profileRef: s2.ref,
      qualification: s2.qualification, executionAuthorityGranted: false },
    S3: { modelRef: model.ref, profileRef: s3.ref, graphDigest: hash(problem.graphs), queryDigest: hash(problem.query),
      graphTruthEstablished: false, fieldIdentified: false, qualification: "OWNER_DECLARED_ADMG_NOT_NUMERICAL_MODEL_PROOF" },
    S4: { policyRef: context.policy.ref, mandateRef: context.policy.mandateRef,
      utilityRef: context.policy.mandate.utilityRef, utilityDigest: hash(context.policy.mandate.utility),
      episodeId: context.policy.mandate.episodeId, validUntil: context.policy.validUntil,
      obligationsDigest: hash(context.policy.problem.obligations), context: context.policy.problem.context,
      horizon: context.policy.mandate.horizon, originalSearchMs: context.policy.mandate.search.deadlineMs,
      maxOwnerExpansions: context.policy.mandate.search.maxExpansions,
      initialOwnerExpansions: context.policy.compute.usage.expansions },
    S5: { allocationRef: allocation.certificate.ref, reservationRef: allocation.reservation.ref,
      resourceRef: resource.ref, resourceId: resource.resourceId, capacity, envelope,
      resourceHeads: allocation.problem.resources.map(r => ({ id: r.resourceId, ref: r.ref })),
      validUntil: allocation.certificate.validUntil, rightsRef: allocation.certificate.rightsRef, reservationGrantedByR4: false },
    S7: { estimandRef: estimand.ref, targetRef: target.ref, populationRef: e.populationRef,
      horizonMonths: e.horizonMonths, sourceQualification: estimand.payload.sourceQualification,
      attributionGranted: false },
  };
  if ((await validateBeliefViewPin(ctx, view.pin)).status !== "CURRENT") throw Error("R4_S1_OWNER_CHANGED_DURING_RESOLUTION");
  return { binding, beliefPins: [view.pin, ...model.beliefBindings.map(b => b.pin)] };
}

export async function currentOwners(ctx: PeMutationContext, p: R4Profile) {
  await currentLocal(ctx, p);
  for (const pin of p.beliefPins)
    if ((await validateBeliefViewPin(ctx, pin)).status !== "CURRENT") throw Error("R4_S1_SOURCE_RIGHTS_OR_SUPPORT_REVISED");
  const now = await resolveProfileOwners(ctx, p.registration);
  // A belief pin's fresh knowledge time is not a new semantic source revision.
  const fingerprint = (binding: any) => {
    const { pin, ...s1 } = binding.S1;
    return { ...binding, S1: { ...s1, dependencyDigest: pin.dependencyDigest, rightsRevision: pin.rightsRevision } };
  };
  if (stable(fingerprint(now.binding)) !== stable(fingerprint(p.ownerBinding))) throw Error("R4_S2_S3_S4_S5_S7_OWNER_PREIMAGE_REVISED");
}

/** Actual S2 collection proposal and S3 assessment, no arbitrary IID coercion. */
export async function scientificConsumers(ctx: PeMutationContext, p: R4Profile, plan: IdentificationPlan, checkerRef: import("@finnor/shared-types").ExperimentRef) {
  await currentOwners(ctx, p);
  const proposal = await proposeEnterpriseObservationalAcquisition(ctx, { root: p.root, problem: p.problem,
    plan, profileRef: p.ref, originalEpisode: p.ownerBinding.S4.episodeId });
  const assessment = await assessEnterpriseIdentificationPlan(ctx, { modelRef: p.ownerBinding.S3.modelRef,
    problem: p.problem, plan, profileRef: p.ref, checkerRef });
  return { S2: proposal, S3: assessment, S5: { current: true, reservationGrantedByR4: false }, S7: p.ownerBinding.S7 };
}

/** S4 retains utility and can refuse information even when it identifies. */
export async function decideOwner(ctx: PeMutationContext, p: R4Profile, run: R4RunRow, plan: IdentificationPlan | null, disposition: "PROPOSE" | "DECLINE" | "WAIT", proposalRef: import("@finnor/shared-types").ExperimentRef | null = null) {
  const start = performance.now();
  const { policy } = await readEnterpriseControlDecisionContext(ctx, p.ownerBinding.S4.policyRef);
  const episode = await tx(ctx, async c => (await c.query(
    "SELECT extract(epoch FROM(deadline_at-clock_timestamp()))*1000 remaining_ms FROM finnor_os.r4_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
    [ctx.auth.tenantId, principal(ctx), run.episode_id])).rows[0], true);
  if (!episode || Number(episode.remaining_ms) <= 0) {
    return { status: "NO_COMPATIBLE_OWNER_FALLBACK_WITH_REMAINING_ORIGINAL_GRANT", admittedFallback: null,
      originalEpisode: run.episode_id, executionAuthorityGranted: false, costsRetained: await costs(ctx, run.id) };
  }
  const problem = structuredClone(policy.problem);
  const acquisitionAbsent = !problem.actions.some(a => a.kind === "INQUIRE" && a.protocolRef);
  // Observational proposals cannot become an unrelated S2 fixed-binomial action.
  // Until an admitted compatible collection instrument exists, actual WAIT/STOP
  // executes; that precise acquisition-domain absence is retained separately.
  // No existing binomial protocol is a compatible observational collection.
  problem.actions = problem.actions.filter(a => ["WAIT", "STOP"].includes(a.kind));
  if (!problem.actions.length) return { status: "NO_COMPATIBLE_CURRENT_S4_WAIT_STOP", admittedFallback: null, executionAuthorityGranted: false };
  problem.observations = problem.observations.filter(i => i.afterActionIds.every(id => problem.actions.some(a => a.id === id)));
  const remainingDeadlineMs = Math.floor(Math.min(Number(episode.remaining_ms), policy.mandate.search.deadlineMs) - (performance.now() - start));
  if (remainingDeadlineMs < 1) return { status: "ORIGINAL_REMAINING_OWNER_BUDGET_EXHAUSTED", admittedFallback: null, executionAuthorityGranted: false };
  const remainingExpansions = await tx(ctx, async c => {
    const e = (await c.query("SELECT * FROM finnor_os.r4_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR UPDATE",
      [ctx.auth.tenantId, principal(ctx), run.episode_id])).rows[0];
    if (e.owner_call_pending || e.owner_expansions_used >= e.max_owner_expansions) return 0;
    await c.query("UPDATE finnor_os.r4_episodes SET owner_call_pending=true WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [ctx.auth.tenantId, principal(ctx), run.episode_id]);
    await append(ctx, run.id, "OWNER_CALL_ADMITTED", { originalEpisode: run.episode_id,
      remainingExpansions: e.max_owner_expansions - e.owner_expansions_used, remainingDeadlineMs, costUSD: null }, c);
    return e.max_owner_expansions - e.owner_expansions_used;
  });
  if (!remainingExpansions) return { status: "ORIGINAL_OWNER_BUDGET_BUSY_UNKNOWN_OR_EXHAUSTED", admittedFallback: null, executionAuthorityGranted: false };
  const review = await reviewEnterpriseObservationalAcquisition(ctx, { incumbentPolicyRef: policy.ref,
    proposalRef, plan, disposition, remainingDeadlineMs, originalEpisode: run.episode_id });
  const proposal = await synthesizeEnterpriseControlProposal(ctx, {
    incumbentPolicyRef: policy.ref, problem, remainingDeadlineMs,
    remainingExpansions,
  });
  await tx(ctx, async c => {
    await c.query("UPDATE finnor_os.r4_episodes SET owner_call_pending=false,owner_expansions_used=owner_expansions_used+$4 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [ctx.auth.tenantId, principal(ctx), run.episode_id, proposal.compute.usage.expansions]);
    await append(ctx, run.id, "OWNER_CALL_RETURNED", { originalEpisode: run.episode_id,
      compute: proposal.compute, remainingExpansions, costUSD: null }, c);
  });
  const decision = proposal.policy ? await chooseEnterpriseControlBranch(ctx, {
    policyRef: proposal.policy.ref,
    decision: { knowledgeAt: new Date().toISOString(), period: 0, actionHistory: [], observations: [],
      rightsRef: policy.mandate.rightsRef, obligations: policy.problem.obligations, allocationRefs: [] },
  }) : null;
  return { schema: "finnor.s4.r4-proposal-disposition.v1", request: disposition,
    collectionProposalReceived: !!plan?.selected, registeredCost: plan?.selected?.totalCost ?? null,
    registeredDelay: plan?.selected?.completion ?? null, utilityUnchanged: true,
    originalEpisode: run.episode_id, remainingDeadlineMs, callee: "synthesizeEnterpriseControlProposal -> chooseEnterpriseControlBranch",
    review, proposal, decision, admittedFallback: null,
    acquisitionFallbackAbsence: acquisitionAbsent ? "NO_ADMITTED_OBSERVATIONAL_COLLECTION_INSTRUMENT_IN_CURRENT_S4_DOMAIN" : "OBSERVATIONAL_PROFILE_NOT_AN_IID_PROTOCOL",
    executionAuthorityGranted: false, reservationGranted: false, attributionGranted: false };
}

export async function retainFallback(ctx: PeMutationContext, p: R4Profile, run: R4RunRow, predicate: string) {
  const intended = { callee: "S4.synthesizeEnterpriseControlProposal -> chooseEnterpriseControlBranch",
    domain: "CURRENT_EXISTING_WAIT_STOP_NO_OBSERVATIONAL_COLLECTION_AUTHORITY", originalEpisode: run.episode_id,
    expectedDisposition: "Actual ordinary S4 WAIT/STOP, or exact current/grant/UNKNOWN responsibility refusal", predicate };
  await append(ctx, run.id, "FALLBACK_INTENT", intended);
  let observed: any;
  try { observed = await decideOwner(ctx, p, run, null, "WAIT"); }
  catch { observed = { status: "CURRENT_S4_DOMAIN_OR_OUTSTANDING_S6_RESPONSIBILITY_REFUSAL", admittedFallback: null, executionAuthorityGranted: false }; }
  const ref = await artifact(ctx, run.id, "FALLBACK", { ...intended, observed });
  await append(ctx, run.id, "FALLBACK_OBSERVED", { ref, status: observed.status ?? observed.proposal?.status, costsRetained: true, admittedFallback: null });
  return { ...intended, observed, ref };
}

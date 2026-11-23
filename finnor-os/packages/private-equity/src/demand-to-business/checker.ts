import { growthInputSchema, programSchema, hash, same, W4_BOUNDS, type BuildIdentity,
  type GrowthInput, type ProgramCheck } from "./contracts";

export function checkOperatingProgram(original: GrowthInput, candidate: unknown, identity: BuildIdentity, now: number): ProgramCheck {
  const reasons: string[] = [];
  const result = programSchema.safeParse(candidate), input = growthInputSchema.parse(original);
  const originalDigest = hash(input), candidateDigest = hash(candidate);
  if (!result.success) return { disposition: "REJECTED", reasons: ["CANDIDATE_SCHEMA_INVALID"],
    originalDigest, candidateDigest, fieldValidated: false, admissionGranted: false };
  const p = result.data;
  if (Buffer.byteLength(JSON.stringify(p)) > W4_BOUNDS.artifactBytes) reasons.push("ARTIFACT_BYTE_BOUND");
  if (p.originalDigest !== originalDigest || !same(p.scope, input.scope) || !same(p.identity, identity)
    || !same(p.parentPolicy, input.parentPolicy) || !same(p.parentAllocation, input.parentAllocation)
    || !same(p.budgetObligation, input.budgetObligation) || p.originalDeadlineAt !== input.originalDeadlineAt
    || p.marketRevision !== input.marketRevision || Date.parse(p.compiledAt) > now
    || Date.parse(p.compiledAt) < Date.parse(input.validFrom) || now >= Date.parse(input.originalDeadlineAt))
    reasons.push("ORIGINAL_IDENTITY_RESOURCE_TIME_OR_SOURCE_MISMATCH");
  if (!same(p.protocol, input.test) || !same(p.population, input.population)) reasons.push("ORIGINAL_TEST_POPULATION_EXPOSURE_CHANGED");
  if (!same(p.hypotheses, input.demands.map(d => ({ demandId: d.id, problem: d.description,
    alternatives: d.existingAlternatives, selectionBias: d.selectionBias, source: d.source,
    explanations: ["NO_VIABLE_DEMAND", "INTEREST_WITHOUT_VIABLE_COMMITMENT", "VIABLE_COMMITMENT_REQUIRES_DELIVERY_AND_ECONOMICS"] }))))
    reasons.push("COMPETING_HYPOTHESES_ORIGINAL_EVIDENCE_CHANGED");
  const duties = ["CONTACT", "OFFER", "ACCEPT", "FULFILL", "DELIVERY_ACCEPTANCE", "COLLECT", "RECOGNIZE", "SUPPORT_REFUND", "STOP_RECONCILE"];
  if (!same(p.operatingShape.map(s => s.duty), duties)
    || !same(p.operatingShape.map(s => s.owner), ["S2_S6", "S4_S6", "AUTHENTICATED_BUYER_S5", "S5_S6", "ORIGINAL_BUYER",
      "S6_S7", "S7", "ORIGINAL_COMMITMENT_S6_S7", "S4_S6_S7"])) reasons.push("INCOMPLETE_CANONICAL_OPERATING_SHAPE");
  if (new Set(p.offers.map(o => o.id)).size !== p.offers.length
    || new Set(p.offers.map(o => o.demandId)).size !== p.offers.length) reasons.push("DUPLICATE_OFFER_OR_DEMAND");
  for (const offer of p.offers) {
    const demand = input.demands.find(d => d.id === offer.demandId);
    const caps = offer.capabilityIds.map(id => input.capabilities.find(c => c.id === id));
    const { termsDigest, ...terms } = offer;
    if (!demand || caps.some(c => !c) || new Set(offer.capabilityIds).size !== offer.capabilityIds.length) {
      reasons.push("OFFER_UNKNOWN_CAPABILITY_OR_DEMAND"); continue;
    }
    const selected = caps.filter((c): c is NonNullable<typeof c> => !!c);
    if (Date.parse(demand.validUntil) <= Date.parse(p.compiledAt)
      || selected.some(c => !input.permittedCapabilityIds.includes(c.id) || !c.unitCost || !c.unitSupportCost
        || c.capacityUnits - c.committedUnits < offer.maximumUnits
        || c.supportCapacityUnits - c.committedSupportUnits < offer.maximumUnits
        || c.prerequisites.some(id => !offer.capabilityIds.includes(id)))
      || !same(offer.outcomeIds, demand.outcomeIds)
      || demand.outcomeIds.some(outcome => !selected.some(c => c.outcomeIds.includes(outcome))))
      reasons.push("OFFER_FEASIBILITY_OR_ORIGINAL_OUTCOME_NOT_PRESERVED");
    const visiting = new Set<string>(), finished = new Set<string>();
    const acyclic = (id: string): boolean => {
      if (visiting.has(id)) return false;
      if (finished.has(id)) return true;
      visiting.add(id);
      if (!selected.find(c => c.id === id)?.prerequisites.every(acyclic)) return false;
      visiting.delete(id); finished.add(id); return true;
    };
    if (!offer.capabilityIds.every(acyclic)) reasons.push("CYCLIC_REQUIRED_CAPABILITIES");
    let cost = 0n;
    for (const cap of selected) if (cap.unitCost && cap.unitSupportCost)
      cost += BigInt(cap.unitCost.minor) + BigInt(cap.unitSupportCost.minor);
    const deliveryHours = selected.reduce((n, c) => n + c.deliveryLeadHours, 0);
    const supportHours = Math.max(...selected.map(c => c.supportHours));
    const operationEnd = Date.parse(p.compiledAt) + (deliveryHours + supportHours) * 3600000;
    if (offer.unitLifecycleCost.minor !== cost.toString()
      || offer.unitPrice.minor !== (cost + BigInt(input.terms.minimumContributionMinor)).toString()
      || BigInt(offer.unitPrice.minor) > BigInt(input.terms.maximumUnitPrice.minor)
      || offer.unitPrice.currency !== input.currency || offer.unitLifecycleCost.currency !== input.currency
      || offer.deliveryLeadHours !== deliveryHours || offer.supportHours !== supportHours
      || operationEnd > Date.parse(input.originalDeadlineAt)
      || selected.some(c => operationEnd >= Date.parse(c.validUntil))) reasons.push("EXACT_OFFER_COST_PRICE_OR_WINDOW_MISMATCH");
    if (hash(terms) !== termsDigest || offer.revision !== input.terms.revision
      || !same(offer.accountingPolicySource, input.terms.accountingPolicySource)
      || !same(offer.exclusions, input.terms.exclusions) || offer.refunds !== input.terms.refunds
      || offer.warranty !== input.terms.warranty || offer.disclosure !== input.terms.disclosure
      || !same(offer.claims, [...new Set(selected.flatMap(c => c.permittedClaims))].sort()))
      reasons.push("EXACT_TERMS_OR_TRUTHFUL_CLAIMS_CHANGED");
  }
  const capabilityUse = new Map<string, number>(), offerUse = new Map<string, number>();
  let quoteExposure = 0n;
  if (new Set(p.assignedExposure.map(a => a.buyerId)).size !== p.assignedExposure.length
    || p.assignedExposure.length > input.test.maxContacts) reasons.push("DUPLICATED_OR_EXCESS_CONTACT_EXPOSURE");
  for (const assignment of p.assignedExposure) {
    const buyer = input.population.find(b => b.buyerId === assignment.buyerId);
    const offer = p.offers.find(o => o.id === assignment.offerId);
    const demand = input.demands.find(d => d.id === offer?.demandId);
    if (!buyer || !offer || assignment.termsDigest !== offer.termsDigest || !demand?.buyerIds.includes(assignment.buyerId)
      || buyer.permittedPurpose !== input.permittedPurpose || Date.parse(buyer.consentValidUntil) <= Date.parse(input.test.closesAt)) {
      reasons.push("CONTACT_ORIGINAL_BUYER_TERMS_CONSENT_MISMATCH"); continue;
    }
    const units = input.terms.maximumUnitsPerBuyer;
    offerUse.set(offer.id, (offerUse.get(offer.id) ?? 0) + units);
    for (const id of offer.capabilityIds) capabilityUse.set(id, (capabilityUse.get(id) ?? 0) + units);
    quoteExposure += BigInt(offer.unitLifecycleCost.minor) * BigInt(units);
  }
  if (quoteExposure > BigInt(input.test.maxMoney.minor)
    || p.offers.some(o => (offerUse.get(o.id) ?? 0) > o.maximumUnits)
    || input.capabilities.some(c => (capabilityUse.get(c.id) ?? 0) > Math.min(
      c.capacityUnits - c.committedUnits, c.supportCapacityUnits - c.committedSupportUnits)))
    reasons.push("ORIGINAL_JOINT_CAPACITY_OR_COST_EXCEEDED");
  if (!p.search.complete && !p.gaps.some(g => g.includes("BOUNDED_SEARCH"))) reasons.push("SEARCH_UNCERTAINTY_HIDDEN");
  return { disposition: reasons.length ? "REJECTED" : "CHECKED_DEVELOPMENT", reasons: [...new Set(reasons)],
    originalDigest, candidateDigest, fieldValidated: false, admissionGranted: false };
}

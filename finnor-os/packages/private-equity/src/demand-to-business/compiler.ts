import { growthInputSchema, W4_BOUNDS, W4_REQUIREMENTS, W4_VERSION, hash, offerTermsDigest,
  type BuildIdentity, type Capability, type ConstructedOffer, type GrowthInput,
  type MarketValidatedOperatingProgram } from "./contracts";

export function compileOperatingProgram(raw: GrowthInput, identity: BuildIdentity, now: number): MarketValidatedOperatingProgram {
  const input = growthInputSchema.parse(raw);
  const gaps: string[] = [], requests: MarketValidatedOperatingProgram["capabilityRequests"] = [];
  const offers: ConstructedOffer[] = [];
  const capabilities = new Map(input.capabilities.map(c => [c.id, c]));
  const allowed = new Set(input.permittedCapabilityIds);
  let visited = 0, complete = true;
  const eligible = (c: Capability) => allowed.has(c.id) && Date.parse(c.validUntil) > now
    && c.capacityUnits > c.committedUnits && c.supportCapacityUnits > c.committedSupportUnits
    && c.unitCost !== null && c.unitSupportCost !== null
    && now + (c.deliveryLeadHours + c.supportHours) * 3600000 <= Date.parse(input.originalDeadlineAt)
    && now + (c.deliveryLeadHours + c.supportHours) * 3600000 < Date.parse(c.validUntil);
  const close = (selected: Set<string>, id: string, path: Set<string>): Set<string> | null => {
    const cap = capabilities.get(id);
    if (!cap || !eligible(cap) || path.has(id)) return null;
    if (selected.has(id)) return selected;
    const next = new Set(selected); next.add(id);
    const visiting = new Set(path); visiting.add(id);
    let result = next;
    for (const prerequisite of cap.prerequisites) {
      const closed = close(result, prerequisite, visiting);
      if (!closed) return null;
      result = closed;
    }
    return result;
  };
  for (const demand of input.demands) {
    const missing = demand.outcomeIds.filter(outcome => !input.capabilities.some(c => allowed.has(c.id)
      && c.outcomeIds.includes(outcome)));
    if (Date.parse(demand.validUntil) <= now) {
      gaps.push("DEMAND_EVIDENCE_STALE:" + demand.id); continue;
    }
    let best: Capability[] | null = null, bestCost: bigint | null = null;
    const seen = new Set<string>();
    const search = (selected: Set<string>) => {
      if (visited >= W4_BOUNDS.searchNodes) { complete = false; return }
      const signature = [...selected].sort().join("\0");
      if (seen.has(signature)) return;
      seen.add(signature); visited++;
      const bundle = [...selected].map(id => capabilities.get(id)!);
      const uncovered = demand.outcomeIds.find(outcome => !bundle.some(c => c.outcomeIds.includes(outcome)));
      if (uncovered) {
        for (const cap of input.capabilities) {
          if (!cap.outcomeIds.includes(uncovered)) continue;
          const expanded = close(selected, cap.id, new Set());
          if (expanded) search(expanded);
          if (!complete) return;
        }
        return;
      }
      const cost = bundle.reduce((n, c) => n + BigInt(c.unitCost!.minor) + BigInt(c.unitSupportCost!.minor), 0n);
      if (bestCost === null || cost < bestCost
        || cost === bestCost && signature < best!.map(c => c.id).sort().join("\0")) {
        best = bundle; bestCost = cost;
      }
    };
    if (!missing.length) search(new Set());
    const selected = best as Capability[] | null;
    const cost = bestCost as bigint | null;
    if (!selected || cost === null) {
      const reason = !complete ? "CAPABILITY_SEARCH_INCOMPLETE" : missing.length
        ? "MISSING_PERMITTED_CAPABILITY" : "CURRENT_DELIVERY_SUPPORT_CAPACITY_UNAVAILABLE";
      gaps.push(reason + ":" + demand.id);
      requests.push({ demandId: demand.id, missingOutcomeIds: missing, reason }); continue;
    }
    const price = cost + BigInt(input.terms.minimumContributionMinor);
    if (price > BigInt(input.terms.maximumUnitPrice.minor)) {
      gaps.push("AUTHORIZED_PRICE_CANNOT_COVER_REGISTERED_QUOTE:" + demand.id);
      requests.push({ demandId: demand.id, missingOutcomeIds: [], reason: "REVISE_OFFER_WITHIN_MANDATE" }); continue;
    }
    const capabilityIds = selected.map(c => c.id).sort();
    const body: Omit<ConstructedOffer, "termsDigest"> = {
      id: "offer-" + hash({ demandId: demand.id, capabilityIds, revision: input.terms.revision }).slice(0, 32),
      demandId: demand.id, capabilityIds, outcomeIds: [...demand.outcomeIds], unitPrice: { currency: input.currency, minor: price.toString() },
      unitLifecycleCost: { currency: input.currency, minor: cost.toString() },
      maximumUnits: Math.min(input.terms.maximumUnitsPerBuyer * input.test.maxContacts,
        ...selected.map(c => Math.min(c.capacityUnits - c.committedUnits, c.supportCapacityUnits - c.committedSupportUnits))),
      deliveryLeadHours: selected.reduce((n, c) => n + c.deliveryLeadHours, 0),
      supportHours: Math.max(...selected.map(c => c.supportHours)),
      claims: [...new Set(selected.flatMap(c => c.permittedClaims))].sort(),
      exclusions: [...input.terms.exclusions], refunds: input.terms.refunds, warranty: input.terms.warranty,
      disclosure: input.terms.disclosure, revision: input.terms.revision, accountingPolicySource: input.terms.accountingPolicySource,
    };
    if (now + (body.deliveryLeadHours + body.supportHours) * 3600000 > Date.parse(input.originalDeadlineAt)
      || selected.some(c => now + (body.deliveryLeadHours + body.supportHours) * 3600000 >= Date.parse(c.validUntil))) {
      gaps.push("COMPLETE_PACKAGE_ORIGINAL_DEADLINE_UNAVAILABLE:" + demand.id); continue;
    }
    offers.push({ ...body, termsDigest: offerTermsDigest(body) });
  }
  const assignedExposure: MarketValidatedOperatingProgram["assignedExposure"] = [];
  const usage = new Map<string, number>(), offerUsage = new Map<string, number>();
  let quotedExposure = 0n;
  for (const buyer of input.population) {
    if (assignedExposure.length >= input.test.maxContacts) break;
    if (Date.parse(buyer.consentValidUntil) <= Date.parse(input.test.closesAt)) {
      gaps.push("ORIGINAL_CONTACT_CONSENT_UNAVAILABLE:" + buyer.buyerId); continue;
    }
    const offer = offers.find(o => input.demands.find(d => d.id === o.demandId)!.buyerIds.includes(buyer.buyerId)
      && (offerUsage.get(o.id) ?? 0) + input.terms.maximumUnitsPerBuyer <= o.maximumUnits
      && o.capabilityIds.every(id => {
        const cap = capabilities.get(id)!;
        return (usage.get(id) ?? 0) + input.terms.maximumUnitsPerBuyer <= Math.min(
          cap.capacityUnits - cap.committedUnits, cap.supportCapacityUnits - cap.committedSupportUnits);
      }) && quotedExposure + BigInt(o.unitLifecycleCost.minor) * BigInt(input.terms.maximumUnitsPerBuyer) <= BigInt(input.test.maxMoney.minor));
    if (!offer) { gaps.push("NO_FEASIBLE_ORIGINAL_EXPOSURE_SLOT:" + buyer.buyerId); continue }
    assignedExposure.push({ buyerId: buyer.buyerId, offerId: offer.id, termsDigest: offer.termsDigest });
    quotedExposure += BigInt(offer.unitLifecycleCost.minor) * BigInt(input.terms.maximumUnitsPerBuyer);
    offerUsage.set(offer.id, (offerUsage.get(offer.id) ?? 0) + input.terms.maximumUnitsPerBuyer);
    for (const id of offer.capabilityIds) usage.set(id, (usage.get(id) ?? 0) + input.terms.maximumUnitsPerBuyer);
  }
  if (!complete) gaps.push("BOUNDED_SEARCH_NO_GLOBAL_OPTIMALITY_OR_INFEASIBILITY_CLAIM");
  if (input.reservedDecisions.length) gaps.push("ORIGINAL_RESERVED_DECISION_REMAINS");
  if (now < Date.parse(input.validFrom) || now >= Date.parse(input.test.closesAt)) gaps.push("ORIGINAL_TEST_WINDOW_UNAVAILABLE");
  return {
    schema: W4_VERSION, requirements: W4_REQUIREMENTS, scope: input.scope, originalDigest: hash(input), identity,
    originalDeadlineAt: input.originalDeadlineAt, parentPolicy: input.parentPolicy, parentAllocation: input.parentAllocation,
    budgetObligation: input.budgetObligation, marketRevision: input.marketRevision, compiledAt: new Date(now).toISOString(),
    hypotheses: input.demands.map(d => ({ demandId: d.id, problem: d.description, alternatives: d.existingAlternatives,
      selectionBias: d.selectionBias, source: d.source, explanations: ["NO_VIABLE_DEMAND", "INTEREST_WITHOUT_VIABLE_COMMITMENT",
        "VIABLE_COMMITMENT_REQUIRES_DELIVERY_AND_ECONOMICS"] })),
    protocol: input.test, population: input.population, offers, assignedExposure,
    operatingShape: [
      { duty: "CONTACT", owner: "S2_S6", required: true }, { duty: "OFFER", owner: "S4_S6", required: true },
      { duty: "ACCEPT", owner: "AUTHENTICATED_BUYER_S5", required: true }, { duty: "FULFILL", owner: "S5_S6", required: true },
      { duty: "DELIVERY_ACCEPTANCE", owner: "ORIGINAL_BUYER", required: true }, { duty: "COLLECT", owner: "S6_S7", required: true },
      { duty: "RECOGNIZE", owner: "S7", required: true }, { duty: "SUPPORT_REFUND", owner: "ORIGINAL_COMMITMENT_S6_S7", required: true },
      { duty: "STOP_RECONCILE", owner: "S4_S6_S7", required: true },
    ],
    search: { visited, complete, optimalityClaimed: false }, capabilityRequests: requests, gaps,
    validationState: "CANDIDATE", admitted: false, productionActive: false, fieldValidated: false,
  };
}

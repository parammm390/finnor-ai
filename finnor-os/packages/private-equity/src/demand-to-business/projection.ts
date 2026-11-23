import { COST_CATEGORIES, eventSchema, hash, same, sameScope, type BusinessProjection, type CommercialEvent,
  type EffectObservation, type EventOriginal, type GrowthInput, type MarketValidatedOperatingProgram,
  type NativeRef } from "./contracts";

type Commitment = BusinessProjection["commitments"][number];
const eventKey = (e: CommercialEvent) => "buyerId" in e ? e.buyerId + ":" + e.offerId : null;
export function projectOperatingProgram(input: GrowthInput, program: MarketValidatedOperatingProgram,
  originals: readonly EventOriginal[], effects: readonly EffectObservation[], now: number, inputCurrent: boolean): BusinessProjection {
  const gaps = [...program.gaps], failures: string[] = [], seenSources = new Set<string>();
  const events: EventOriginal[] = [];
  let current = inputCurrent;
  for (const original of originals) {
    if (seenSources.has(original.ref.sourceId)) continue;
    seenSources.add(original.ref.sourceId);
    const parsed = eventSchema.safeParse(original.body);
    if (!parsed.success || !sameScope(original.body.scope, program.scope)) { gaps.push("EVENT_ORIGINAL_SCOPE_OR_SCHEMA_MISMATCH"); continue }
    const e = parsed.data;
    if (Date.parse(e.at) > now || Date.parse(original.receivedAt) > now
      || Date.parse(e.at) > Date.parse(original.receivedAt) || Date.parse(e.at) < Date.parse(input.validFrom)
      || !(original.consentValidAtReceipt ?? original.consentCurrent)) {
      gaps.push("EVENT_FUTURE_OR_CONSENT_NOT_ESTABLISHED:" + original.ref.sourceId); continue;
    }
    if (!original.consentCurrent) current = false;
    let actorValid = false;
    if ("buyerId" in e) {
      const offer = program.offers.find(o => o.id === e.offerId);
      const buyer = program.population.find(b => b.buyerId === e.buyerId);
      if (!offer || !buyer || e.termsDigest !== offer.termsDigest
        || !program.assignedExposure.some(a => a.buyerId === e.buyerId && a.offerId === e.offerId
          && a.termsDigest === e.termsDigest)) {
        gaps.push("EVENT_EXACT_ORIGINAL_BUYER_OFFER_TERMS_MISMATCH:" + original.ref.sourceId); continue;
      }
      if (["RESPONSE", "DELIVERY_ACCEPTANCE", "SUPPORT"].includes(e.kind)
        || e.kind === "REFUND" && e.status === "REQUESTED")
        actorValid = original.role === "BUYER" && original.authorId === e.buyerId;
      else if (e.kind === "DELIVERY") actorValid = original.role === "OPERATOR"
        && offer.capabilityIds.some(id => input.capabilities.find(c => c.id === id)?.operatorId === original.authorId);
      else actorValid = original.role === "ACCOUNTANT" && original.authorId !== e.buyerId
        && original.authorId !== program.scope.principalId;
    } else if (e.kind === "COST") actorValid = original.role === "ACCOUNTANT"
      && original.authorId !== program.scope.principalId;
    else actorValid = original.role === "INDEPENDENT_OBSERVER"
      && original.authorId === input.test.independentObservationOwnerId
      && original.authorId !== program.scope.principalId;
    if (!actorValid) { gaps.push("EVENT_ACTOR_ROLE_MISMATCH:" + original.ref.sourceId); continue }
    if (e.kind === "MARKET_CHANGE" && e.previousRevision === program.marketRevision
      && e.currentRevision !== program.marketRevision) current = false;
    events.push({ ...original, body: e });
  }
  events.sort((a, b) => Date.parse(a.body.at) - Date.parse(b.body.at)
    || Date.parse(a.receivedAt) - Date.parse(b.receivedAt) || a.ref.sourceId.localeCompare(b.ref.sourceId));
  const responses = new Map<string, string>(), commitments = new Map<string, Commitment>();
  const deliverySources = new Map<string, { key: string; quantity: number }>();
  const acceptanceSources = new Map<string, { key: string; quantity: number }>();
  const usedDelivery = new Map<string, number>(), usedAcceptance = new Map<string, bigint>();
  const usedEffects = new Set<string>(), usedAccounting = new Set<string>(), accountingRefs: NativeRef[] = [];
  const support = new Map<string, { key: string; state: string; liability: bigint | null }>();
  const refundRequests = new Map<string, { key: string; amount: bigint; settled: bigint }>();
  const costItems = new Map<string, { category: string; expense: bigint | null; cash: bigint | null; terminal: bigint | null }>();
  let collected = 0n, recognized = 0n, refunded = 0n, booked = 0n;
  const recognizedByCommitment = new Map<string, bigint>(), collectedByCommitment = new Map<string, bigint>();
  const refundedByCommitment = new Map<string, bigint>();
  const validMoney = (v: { currency: string; minor: string }) => v.currency === input.currency;
  const effect = (e: CommercialEvent, kind: EffectObservation["kind"], ref?: NativeRef) =>
    "buyerId" in e ? effects.find(f => f.kind === kind && f.buyerId === e.buyerId && f.offerId === e.offerId
      && f.termsDigest === e.termsDigest && f.state === "VERIFIED" && f.originalIdentityReadback
      && (!f.notBeforeAt || Date.parse(e.at) >= Date.parse(f.notBeforeAt))
      && (!ref || same(f.ref, ref))) : undefined;
  const accounting = (ref: NativeRef) => {
    if (ref.owner !== "S7" && ref.owner !== "S1") return false;
    const key = hash(ref);
    if (usedAccounting.has(key)) return false;
    usedAccounting.add(key); accountingRefs.push(ref); return true;
  };
  const remainingCapacity = (offerId: string, units: number) => {
    const offer = program.offers.find(o => o.id === offerId)!;
    const all = [...commitments.values()];
    if (all.filter(c => c.offerId === offerId).reduce((n, c) => n + c.quantity, 0) + units > offer.maximumUnits) return false;
    return offer.capabilityIds.every(id => {
      const cap = input.capabilities.find(c => c.id === id)!;
      const used = all.filter(c => program.offers.find(o => o.id === c.offerId)!.capabilityIds.includes(id))
        .reduce((n, c) => n + c.quantity, 0);
      return used + units <= Math.min(cap.capacityUnits - cap.committedUnits, cap.supportCapacityUnits - cap.committedSupportUnits);
    });
  };
  for (const original of events) {
    const e = original.body, key = eventKey(e);
    const offer = "offerId" in e ? program.offers.find(o => o.id === e.offerId)! : null;
    let commitment = key ? commitments.get(key) : undefined;
    switch (e.kind) {
      case "RESPONSE": {
        responses.set(key!, e.response);
        if (e.response !== "ACCEPTED") break;
        if (commitment) {
          if (commitment.quantity !== e.quantity) gaps.push("ACCEPTED_TERMS_QUANTITY_CONFLICT:" + original.ref.sourceId);
          break;
        }
        const offerEffect = effect(e, "OFFER");
        if (!offerEffect || (offerEffect.quantity ?? 0) < e.quantity || e.quantity > input.terms.maximumUnitsPerBuyer
          || !remainingCapacity(e.offerId, e.quantity) || Date.parse(e.at) >= Date.parse(input.test.closesAt)
          || Date.parse(e.at) + (offer!.deliveryLeadHours + offer!.supportHours) * 3600000 > Date.parse(input.originalDeadlineAt)
          || input.reservedDecisions.length) {
          gaps.push("COMMITMENT_ORIGINAL_EFFECT_CAPACITY_OR_WINDOW_UNAVAILABLE:" + original.ref.sourceId); break;
        }
        commitment = { buyerId: e.buyerId, offerId: e.offerId, termsDigest: e.termsDigest, quantity: e.quantity,
          deliveredQuantity: 0, acceptedDeliveryQuantity: 0, state: "ACCEPTED_AWAITING_DELIVERY",
          supportUntil: input.originalDeadlineAt, continuingObligations: ["DELIVERY", "SUPPORT_WARRANTY", "REFUND_TERMS"],
          sourceIds: [original.ref.sourceId] };
        commitments.set(key!, commitment);
        booked += BigInt(offer!.unitPrice.minor) * BigInt(e.quantity); break;
      }
      case "DELIVERY": {
        const observed = effect(e, "DELIVER", e.effectRef), effectId = hash(e.effectRef);
        if (!commitment || !observed || observed.quantity !== e.quantity || usedEffects.has(effectId)
          || commitment.deliveredQuantity + e.quantity > commitment.quantity) {
          gaps.push("DELIVERY_ORIGINAL_EFFECT_OR_QUANTITY_UNVERIFIED:" + original.ref.sourceId); break;
        }
        usedEffects.add(effectId); commitment.deliveredQuantity += e.quantity; commitment.sourceIds.push(original.ref.sourceId);
        deliverySources.set(original.ref.sourceId, { key: key!, quantity: e.quantity }); break;
      }
      case "DELIVERY_ACCEPTANCE": {
        const cited = e.deliveredSourceIds.map(id => deliverySources.get(id));
        if (!commitment || !e.accepted) {
          if (!e.accepted) failures.push("DELIVERY_REJECTED:" + original.ref.sourceId);
          break;
        }
        if (new Set(e.deliveredSourceIds).size !== e.deliveredSourceIds.length
          || cited.some(d => !d || d.key !== key) || cited.reduce((n, d, i) =>
            n + (d?.quantity ?? 0) - (usedDelivery.get(e.deliveredSourceIds[i]!) ?? 0), 0) < e.quantity
          || commitment.acceptedDeliveryQuantity + e.quantity > commitment.deliveredQuantity) {
          gaps.push("INDEPENDENT_ORIGINAL_DELIVERY_ACCEPTANCE_INCOMPLETE:" + original.ref.sourceId); break;
        }
        let remaining = e.quantity;
        for (const id of e.deliveredSourceIds) {
          const before = usedDelivery.get(id) ?? 0, used = Math.min(remaining, deliverySources.get(id)!.quantity - before);
          usedDelivery.set(id, before + used); remaining -= used;
        }
        commitment.acceptedDeliveryQuantity += e.quantity; commitment.sourceIds.push(original.ref.sourceId);
        commitment.supportUntil = new Date(Date.parse(e.at) + offer!.supportHours * 3600000).toISOString();
        acceptanceSources.set(original.ref.sourceId, { key: key!, quantity: e.quantity }); break;
      }
      case "COLLECTION": {
        const observed = effect(e, "COLLECT", e.effectRef), effectId = hash(e.effectRef);
        const previous = collectedByCommitment.get(key!) ?? 0n;
        if (!commitment || !validMoney(e.amount) || !observed || !same(observed.amount, e.amount)
          || usedEffects.has(effectId) || e.invoiceRef.owner !== "S1" && e.invoiceRef.owner !== "S7"
          || previous + BigInt(e.amount.minor) > BigInt(offer!.unitPrice.minor) * BigInt(commitment.quantity)
          || !accounting(e.accountingRef)) {
          gaps.push("COLLECTION_NOT_ORIGINAL_VERIFIED_ACCOUNTING:" + original.ref.sourceId); break;
        }
        usedEffects.add(effectId); collected += BigInt(e.amount.minor);
        collectedByCommitment.set(key!, previous + BigInt(e.amount.minor)); commitment.sourceIds.push(original.ref.sourceId); break;
      }
      case "RECOGNITION": {
        const prior = recognizedByCommitment.get(key!) ?? 0n;
        const accepted = e.acceptedSourceIds.map(id => acceptanceSources.get(id));
        if (!commitment || !validMoney(e.amount) || !same(e.accountingPolicySource, input.terms.accountingPolicySource)
          || new Set(e.acceptedSourceIds).size !== e.acceptedSourceIds.length || accepted.some(a => !a || a.key !== key)
          || prior + BigInt(e.amount.minor) > BigInt(offer!.unitPrice.minor) * BigInt(commitment.acceptedDeliveryQuantity)
          || accepted.reduce((n, a, i) => n + BigInt(a?.quantity ?? 0) * BigInt(offer!.unitPrice.minor)
            - (usedAcceptance.get(e.acceptedSourceIds[i]!) ?? 0n), 0n) < BigInt(e.amount.minor)
          || !accounting(e.accountingRef)) {
          gaps.push("REVENUE_RECOGNITION_CONDITIONS_NOT_ESTABLISHED:" + original.ref.sourceId); break;
        }
        let remaining = BigInt(e.amount.minor);
        for (const id of e.acceptedSourceIds) {
          const before = usedAcceptance.get(id) ?? 0n;
          const available = BigInt(acceptanceSources.get(id)!.quantity) * BigInt(offer!.unitPrice.minor) - before;
          const used = remaining < available ? remaining : available;
          usedAcceptance.set(id, before + used); remaining -= used;
        }
        recognized += BigInt(e.amount.minor); recognizedByCommitment.set(key!, prior + BigInt(e.amount.minor));
        commitment.sourceIds.push(original.ref.sourceId); break;
      }
      case "REFUND": {
        if (!commitment || !validMoney(e.amount)) { gaps.push("REFUND_ORIGINAL_CONTRACT_UNAVAILABLE"); break }
        if (e.status === "REQUESTED") {
          refundRequests.set(original.ref.sourceId, { key: key!, amount: BigInt(e.amount.minor), settled: 0n });
          commitment.sourceIds.push(original.ref.sourceId); break;
        }
        const request = e.requestSourceId ? refundRequests.get(e.requestSourceId) : null;
        const observed = e.effectRef ? effect(e, "REFUND", e.effectRef) : null;
        const effectId = e.effectRef ? hash(e.effectRef) : "";
        if (!request || request.key !== key || !observed || !same(observed.amount, e.amount)
          || request.settled + BigInt(e.amount.minor) > request.amount || usedEffects.has(effectId)
          || (refundedByCommitment.get(key!) ?? 0n) + BigInt(e.amount.minor) > (collectedByCommitment.get(key!) ?? 0n)
          || !e.accountingRef || !accounting(e.accountingRef)) {
          gaps.push("REFUND_ORIGINAL_EFFECT_OR_ACCOUNTING_UNVERIFIED:" + original.ref.sourceId); break;
        }
        usedEffects.add(effectId); request.settled += BigInt(e.amount.minor); refunded += BigInt(e.amount.minor);
        refundedByCommitment.set(key!, (refundedByCommitment.get(key!) ?? 0n) + BigInt(e.amount.minor));
        commitment.sourceIds.push(original.ref.sourceId); break;
      }
      case "SUPPORT": {
        if (!commitment || e.residualLiability && !validMoney(e.residualLiability)) { gaps.push("SUPPORT_ORIGINAL_CONTRACT_UNAVAILABLE"); break }
        support.set(key + ":" + e.issueId, { key: key!, state: e.state,
          liability: e.residualLiability === null ? null : BigInt(e.residualLiability.minor) });
        commitment.sourceIds.push(original.ref.sourceId); break;
      }
      case "COST": {
        if (costItems.has(e.itemId)) {
          const prior = costItems.get(e.itemId)!;
          if (prior.category !== e.category || prior.expense?.toString() !== e.expense?.minor
            || prior.cash?.toString() !== e.cash?.minor || prior.terminal?.toString() !== e.additionalTerminalLiability?.minor)
            gaps.push("CANONICAL_COST_ITEM_CONFLICT:" + e.itemId);
          break;
        }
        if ([e.expense, e.cash, e.additionalTerminalLiability].some(v => v && !validMoney(v)) || !accounting(e.accountingRef)) {
          gaps.push("COST_CANONICAL_ACCOUNTING_OR_CURRENCY_MISMATCH:" + original.ref.sourceId); break;
        }
        costItems.set(e.itemId, { category: e.category, expense: e.expense === null ? null : BigInt(e.expense.minor),
          cash: e.cash === null ? null : BigInt(e.cash.minor), terminal: e.additionalTerminalLiability === null
            ? null : BigInt(e.additionalTerminalLiability.minor) }); break;
      }
      case "TEST_CLOSED":
        if (!same(e.originalPopulationSource, input.test.populationSource) || Date.parse(e.at) < Date.parse(input.test.closesAt))
          gaps.push("TEST_CLOSURE_ORIGINAL_PROTOCOL_MISMATCH");
        break;
      case "MARKET_CHANGE": break;
    }
  }
  const missing = COST_CATEGORIES.filter(category => ![...costItems.values()].some(c => c.category === category)
    || [...costItems.values()].some(c => c.category === category && (c.expense === null || c.cash === null || c.terminal === null)));
  const allCostsKnown = missing.length === 0;
  const costs = [...costItems.values()], expense = costs.reduce((n, c) => n + (c.expense ?? 0n), 0n);
  const cash = costs.reduce((n, c) => n + (c.cash ?? 0n), 0n), terminal = costs.reduce((n, c) => n + (c.terminal ?? 0n), 0n);
  const refundRequested = [...refundRequests.values()].reduce((n, r) => n + r.amount - r.settled, 0n);
  const netRevenue = recognized > refunded ? recognized - refunded : 0n, netCollection = collected - refunded;
  const unresolvedSupport = [...support.values()].filter(s => s.state === "OPEN");
  const supportKnown = unresolvedSupport.every(s => s.liability !== null);
  const supportLiability = unresolvedSupport.reduce((n, s) => n + (s.liability ?? 0n), 0n);
  const net = allCostsKnown && supportKnown ? netRevenue - expense - terminal - supportLiability - refundRequested : null;
  const values = [...commitments.values()];
  for (const c of values) {
    const k = c.buyerId + ":" + c.offerId, obligations: string[] = [];
    if (c.acceptedDeliveryQuantity < c.quantity) obligations.push("ORIGINAL_DELIVERY_ACCEPTANCE");
    if (now < Date.parse(c.supportUntil) || unresolvedSupport.some(s => s.key === k)) obligations.push("SUPPORT_WARRANTY");
    if ([...refundRequests.values()].some(r => r.key === k && r.amount > r.settled)) obligations.push("REFUND_REQUEST");
    if ((recognizedByCommitment.get(k) ?? 0n) < BigInt(program.offers.find(o => o.id === c.offerId)!.unitPrice.minor) * BigInt(c.acceptedDeliveryQuantity))
      obligations.push("REVENUE_ACCOUNTING_RECONCILIATION");
    c.continuingObligations = obligations;
    c.state = c.acceptedDeliveryQuantity < c.quantity ? "COMMITTED_DELIVERY_OPEN"
      : obligations.length ? "DELIVERED_CONTINUING_OBLIGATIONS" : "CONTROLLED_OPERATION_RECONCILED";
  }
  const accepted = values.length, delivered = values.filter(c => c.acceptedDeliveryQuantity === c.quantity).length;
  const eligible = values.filter(c => input.population.find(b => b.buyerId === c.buyerId)?.affiliation === "UNAFFILIATED_ASSERTED"
    && c.buyerId !== input.scope.principalId).length;
  const responded = responses.size, closed = now >= Date.parse(input.test.closesAt);
  const decision: BusinessProjection["decision"] = !current ? "STOP_NEW_EXPOSURE_RETAIN_OBLIGATIONS"
    : net !== null && net < 0n ? "STOP" : closed && accepted < input.test.minimumCommitments ? "STOP"
      : !program.offers.length ? "ITERATE" : accepted && (!allCostsKnown || !supportKnown) ? "HOLD_UNKNOWN"
        : accepted >= input.test.minimumCommitments && delivered >= input.test.minimumRepetitions
          ? "CONTINUE_WITHIN_ORIGINAL_LIMITS" : "TEST_WITHIN_ORIGINAL_LIMITS";
  if (!current) gaps.push("MARKET_SOURCE_RIGHTS_OR_MODEL_STALE_ORIGINAL_OBLIGATIONS_RETAINED");
  if (missing.length) gaps.push("COMPLETE_LIFECYCLE_COSTS_UNMETERED");
  if (eligible < accepted) gaps.push("AFFILIATED_SYNTHETIC_OR_UNVERIFIED_DEMAND_EXCLUDED_FROM_INDEPENDENT_CREDIT");
  if (net !== null && net < 0n) failures.push("INCREMENTAL_ACCOUNTING_LOSS_NO_PROFITABLE_GROWTH_CLAIM");
  return {
    schema: "finnor.w4.operating-projection.v1", scope: program.scope, artifactDigest: hash(program),
    currentness: current ? "CURRENT" : "STALE",
    validationState: accepted && delivered === accepted ? "TESTED_CONTROLLED" : accepted || !program.offers.length ? "INCOMPLETE" : "CANDIDATE",
    counts: { assigned: program.assignedExposure.length, responded,
      interested: [...responses.values()].filter(r => r === "INTEREST").length,
      declined: [...responses.values()].filter(r => r === "DECLINED").length,
      nonresponse: [...responses.values()].filter(r => r === "NONRESPONSE").length + (closed ? program.assignedExposure.length - responded : 0),
      accepted, independentEligibleAccepted: eligible, delivered, repetitions: delivered },
    commitments: values, accounting: { currency: input.currency, bookingsMinor: booked.toString(),
      collectedMinor: netCollection.toString(), recognizedMinor: netRevenue.toString(),
      deferredMinor: (netCollection > netRevenue ? netCollection - netRevenue : 0n).toString(),
      receivableMinor: (netRevenue > netCollection ? netRevenue - netCollection : 0n).toString(),
      refundedMinor: refunded.toString(), refundRequestedMinor: refundRequested.toString(),
      expenseMinor: allCostsKnown ? expense.toString() : null, cashCostMinor: allCostsKnown ? cash.toString() : null,
      additionalTerminalLiabilityMinor: allCostsKnown && supportKnown ? (terminal + supportLiability + refundRequested).toString() : null,
      incrementalNetAfterTaxMinor: net?.toString() ?? null, missingCostCategories: missing, canonicalAccountingRefs: accountingRefs },
    decision, gaps: [...new Set(gaps)], originalFailures: [...new Set(failures)], causalStatus: input.test.causalStatus,
    qualification: "CONTROLLED_DEVELOPMENT_ONLY", fieldValidated: false, s7ProfitQualified: false,
    admissionGranted: false, executionAuthorityGranted: false,
  };
}

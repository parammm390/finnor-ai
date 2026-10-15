/* Independent source reconstruction. No controller, contract, normalizer or expected-answer imports. */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
const hash = value => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const integer = value => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,37})$/.test(value)) throw Error("NONCANONICAL_QUANTITY");
  return BigInt(value);
};
const fraction = value => {
  if (!value || !/^-?(0|[1-9][0-9]{0,37})$/.test(value.numerator) || !/^[1-9][0-9]{0,37}$/.test(value.denominator)) throw Error("NONCANONICAL_RATIONAL");
  return [BigInt(value.numerator), BigInt(value.denominator)];
};
const compare = (a, b) => { const [an, ad] = fraction(a), [bn, bd] = fraction(b); return an * bd - bn * ad; };
const nonnegative = v => fraction(v)[0] >= 0n;
const time = value => { const result = Date.parse(value); if (!Number.isFinite(result)) throw Error("INVALID_TIME"); return result; };
const max = (a, b) => a > b ? a : b;
const decimal = value => {
  if (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/.test(value) || value.length > 128) throw Error("S5_QUANTITY_UNSUPPORTED");
  const negative = value.startsWith("-"), [whole, tail = ""] = value.replace(/^-/, "").split(".");
  return [BigInt(whole + tail) * (negative ? -1n : 1n), 10n ** BigInt(tail.length)];
};
const toMinor = (value, scale) => {
  const [n, d] = decimal(value), scaled = n * 10n ** BigInt(scale);
  if (scaled % d) throw Error("S5_INEXACT_QUANTITY");
  return scaled / d;
};
const roles = {
  IDENTITY_CONFIRMED: "IDENTITY", INDICATION: "PROVIDER", OFFER: "PROVIDER", COUNTERPROPOSAL: "PROVIDER",
  COMMITMENT_EXECUTED: "PROVIDER", REFUSAL: "PROVIDER", WITHDRAWAL: "PROVIDER", CORRECTION: "PROVIDER",
  PROFESSIONAL_DETERMINATION: "PROFESSIONAL", CONDITION_OBSERVED: "CONDITION", FUNDING_OBSERVATION: "SETTLEMENT",
};
function authentic(event, issuer, now, mandate, key) {
  const b = event.body;
  const signature = Buffer.from(event.signature, "base64");
  return !!(issuer && key.asymmetricKeyType === "ed25519" && signature.length === 64
    && signature.toString("base64") === event.signature && !issuer.revoked
    && issuer.independentOfProducer === true && issuer.purposes.includes(roles[b.kind])
    && issuer.instruments.includes(b.instrument)
    && b.issuerId === issuer.id && b.issuerRevision === issuer.revision
    && b.tenantId === mandate.tenantId && b.programmeId === mandate.programmeId
    && time(b.observedAt) <= now && time(b.effectiveAt) <= now
    && time(b.observedAt) >= time(issuer.validFrom) && time(b.observedAt) < time(issuer.validUntil)
    && verify(null, Buffer.from(canonical(b)), key, signature));
}
function resourceAvailable(resource, outstanding, scale, now, mandate, terms, termsDigest, backingTerms) {
  const backing = backingTerms.get(resource?.sourceRef?.contentDigest)?.find(({ terms: t, digest }) =>
    t.providerEntityId === terms.providerEntityId && (digest === termsDigest
      || t.facilityId !== null && t.facilityId === terms.facilityId));
  if (!resource || resource.revoked || time(resource.validUntil) <= now || resource.currency !== terms.amount.currency
    || resource.unit !== terms.amount.currency || !["BORROWING_HEADROOM", "COMMITTED_CAPITAL", "CASH"].includes(resource.resourceClass)
    || resource.legalEntityRef.id !== mandate.legalEntityId
    || !resource.permittedRoots.some(r => canonical(r) === canonical(mandate.root))
    || !backing) return { error: "CURRENT_CANONICAL_CAPACITY_BACKING_UNAVAILABLE", available: 0n };
  if (resource.kind !== "STOCK" || resource.horizon.periods !== 1 || resource.availability.length !== 2
    || resource.availability.some(p => p.basis !== "REPORTED_AVAILABLE" || p.amount === null) || resource.existingUse.length !== 2) {
    return { error: "CAPACITY_TIMING_DOMAIN_UNSUPPORTED", available: 0n };
  }
  let available = integer(backing.terms.amount.amountMinor), existingPrefix = 0n;
  for (let period = 0; period <= 1; period++) {
    existingPrefix += toMinor(resource.existingUse[period], scale);
    let periodAvailable = toMinor(resource.availability[period].amount, scale)
      - existingPrefix - toMinor(resource.safetyMargin, scale);
    for (const reservation of outstanding) for (const envelope of reservation.envelopes) if (envelope.resourceId === resource.resourceId) {
      if (envelope.quantities.length !== 2 || envelope.unit !== resource.unit) return { error: "CAPACITY_OUTSTANDING_DOMAIN_UNSUPPORTED", available: 0n };
      // UNKNOWN_OUTCOME, SETTLED_RETAINED and every unreleased reservation still occupy capacity.
      periodAvailable -= envelope.quantities.slice(0, period + 1).reduce((sum, q) => sum + toMinor(q, scale), 0n);
    }
    if (periodAvailable < available) available = periodAvailable;
  }
  return { error: null, available: max(0n, available) };
}

function reconstruct(input) {
  const { mandate: m, authority: a, approval, profiles, issuers, events, resources, outstanding, draws } = input;
  const now = time(input.knowledgeAt), conflicts = [], unresolved = [], groups = new Map(), seenIds = new Set();
  if (events.length > 512 || profiles.length > 3 || issuers.length > 256 || resources.length > 16 || outstanding.length > 256 || draws.length > 256) throw Error("CHECKER_DOMAIN_BOUND");
  const publicKeys = new Map(), representativeKeys = new Map();
  const parsedKey = issuer => {
    if (!issuer) return null;
    let parsed = publicKeys.get(issuer.publicKey);
    if (!parsed) { const key = createPublicKey(issuer.publicKey);
      parsed = { key, der: key.export({ type: "spki", format: "der" }).toString("base64") }; publicKeys.set(issuer.publicKey, parsed); }
    return parsed;
  };
  const keysForRepresentative = actorId => {
    if (!representativeKeys.has(actorId)) representativeKeys.set(actorId,
      new Set(issuers.filter(i => i.actorId === actorId).map(i => parsedKey(i).der)));
    return representativeKeys.get(actorId);
  };
  const authorityIssuer = issuers.find(i => i.id === a.issuerId), authorityKey = parsedKey(authorityIssuer)?.key;
  if (!authorityIssuer || authorityIssuer.revoked || !authorityIssuer.purposes.includes("AUTHORITY")
    || authorityIssuer.actorId !== a.body.issuingPrincipalId || a.body.issuingPrincipalId !== m.principalId
    || authorityIssuer.independentOfProducer !== true || authorityKey.asymmetricKeyType !== "ed25519"
    || !verify(null, Buffer.from(canonical(a.body)), authorityKey, Buffer.from(a.signature, "base64"))
    || a.body.id !== m.authorityProfileId || !a.body.legalEntityIds.includes(m.legalEntityId)
    || a.body.revoked || time(a.body.validFrom) > now || time(a.body.validUntil) <= now) throw Error("AUTHORITY_NOT_ESTABLISHED");
  if (!approval || approval.body.schema !== "finnor.s4.capital-approval.v1"
    || approval.body.tenantId !== m.tenantId || approval.body.principalId !== m.principalId
    || approval.body.programmeId !== m.programmeId || approval.body.mandateDigest !== hash(m)
    || approval.body.authorityDigest !== hash(a.body) || approval.issuerId !== authorityIssuer.id
    || !authorityIssuer.activities.includes("APPROVE")
    || !verify(null, Buffer.from(canonical(approval.body)), authorityKey, Buffer.from(approval.signature, "base64"))) throw Error("EXACT_MANDATE_APPROVAL_UNESTABLISHED");
  if (time(m.expiresAt) <= now) unresolved.push("MANDATE_EXPIRED");
  const termSlots = new Map(), capacityClaims = new Map(), capacityPools = new Map(), collateralClaims = new Map(), fundingIdentities = new Set();
  const states = [];
  for (const event of events) {
    const b = event.body, issuer = issuers.find(i => i.id === b.issuerId && i.revision === b.issuerRevision);
    if (seenIds.has(`${b.issuerId}:${b.eventId}`)) throw Error("DUPLICATE_SOURCE_EVENT");
    seenIds.add(`${b.issuerId}:${b.eventId}`);
    if (!authentic(event, issuer, now, m, parsedKey(issuer)?.key)) { unresolved.push(`UNAUTHENTICATED_OR_REVOKED_SOURCE:${b.eventId}`); continue; }
    if (!m.providerIds.includes(b.providerEntityId)) { conflicts.push("PROVIDER_NOT_IN_MANDATE"); continue; }
    const groupKey = `${b.providerEntityId}:${b.instrument}:${b.commitmentIdentity}`;
    const group = groups.get(groupKey) ?? [];
    group.push(b); groups.set(groupKey, group);
  }
  const backingTerms = new Map();
  for (const group of groups.values()) for (const event of group) if (event.kind === "COMMITMENT_EXECUTED" && event.terms) {
    const digest = hash(event.terms), candidates = backingTerms.get(digest) ?? [];
    candidates.push({ terms: event.terms, digest }); backingTerms.set(digest, candidates);
  }
  for (const [groupKey, history] of groups) {
    history.sort((x, y) => time(x.observedAt) - time(y.observedAt) || x.sequence - y.sequence || x.eventId.localeCompare(y.eventId));
    const termHistory = history.filter(e => e.terms && ["INDICATION", "OFFER", "COUNTERPROPOSAL", "COMMITMENT_EXECUTED", "CORRECTION"].includes(e.kind));
    const latest = termHistory.at(-1);
    if (!latest) continue;
    const t = latest.terms, td = hash(t), amount = integer(t.amount.amountMinor), issues = [];
    const faceSlot = `${t.providerEntityId}:${t.instrumentIdentity}:${t.trancheId}`;
    if (termSlots.has(faceSlot) && termSlots.get(faceSlot) !== groupKey) conflicts.push(`ALIASED_COMMITMENT:${t.instrumentIdentity}:${t.trancheId}`);
    termSlots.set(faceSlot, groupKey);
    const profile = profiles.find(p => m.domainProfileIds.includes(p.id) && p.instrument === t.instrument && !p.revoked
      && time(p.validUntil) > now && p.permittedRootTypes.includes(m.root.entityType));
    const identity = history.filter(e => e.kind === "IDENTITY_CONFIRMED" && e.identity
      && profile?.identityIssuerIds.includes(e.issuerId) && e.representativeId === t.representativeId && time(e.expiresAt) > now).at(-1);
    if (!profile) issues.push("INSTRUMENT_PROFILE_UNAVAILABLE");
    if (!identity?.identity.providerEligible || !identity.identity.representativeActs.includes("EXECUTE_COMMITMENT")) issues.push("PROVIDER_IDENTITY_OR_ACT_AUTHORITY_UNESTABLISHED");
    if (t.programmeId !== m.programmeId || t.providerEntityId !== latest.providerEntityId || t.representativeId !== latest.representativeId
      || t.instrument !== latest.instrument || t.commitmentIdentity !== latest.commitmentIdentity || latest.termsDigest !== td
      || t.amount.legalEntityId !== m.legalEntityId || canonical(t.amount.ownerShare) !== canonical(m.requirement.ownerShare)
      || t.amount.timeBasis !== m.requirement.timeBasis || t.amount.unit !== "CURRENCY_MINOR_UNIT") issues.push("EXACT_TERMS_OR_ENTITY_SUBSTITUTION");
    if (!t.materialInventoryComplete) issues.push("MATERIAL_INVENTORY_INCOMPLETE");
    if (!a.body.instruments.includes(t.instrument) || !a.body.jurisdictions.includes(profile?.jurisdiction)
      || !a.body.permittedProviderIds.includes(t.providerEntityId) || a.body.suppressedProviderIds.includes(t.providerEntityId)
      || t.offeringAuthorityDigest !== hash(a.body)) issues.push("ACTIVITY_AUTHORITY_UNESTABLISHED");
    const execution = history.filter(e => e.kind === "COMMITMENT_EXECUTED" && e.termsDigest === td && time(e.expiresAt) > now
      && issuers.find(i => i.id === e.issuerId && i.revision === e.issuerRevision)?.legalEntityId === t.providerEntityId
      && issuers.find(i => i.id === e.issuerId && i.revision === e.issuerRevision)?.actorId === t.representativeId
      && issuers.find(i => i.id === e.issuerId && i.revision === e.issuerRevision)?.activities.includes("EXECUTE_COMMITMENT")).at(-1);
    const professional = history.filter(e => {
      const i = issuers.find(i => i.id === e.issuerId && i.revision === e.issuerRevision);
      return e.kind === "PROFESSIONAL_DETERMINATION" && e.determination?.termsDigest === td
        && profile?.professionalIssuerIds.includes(e.issuerId) && time(e.expiresAt) > now
        && i?.activities.includes("DETERMINE_LEGAL_STATUS") && i.actorId !== m.principalId
        && i.actorId !== t.representativeId && i.legalEntityId !== t.providerEntityId
        && !keysForRepresentative(t.representativeId).has(parsedKey(i).der);
    }).at(-1);
    const pd = professional?.determination;
    if (pd && (pd.legalBasisDigest !== profile?.legalBasisDigest || !pd.executionEstablished || !pd.issuerAuthorityEstablished
      || !pd.offeringActivityEstablished || !pd.liabilitiesComplete)) issues.push("PROFESSIONAL_SCOPE_OR_MATERIAL_TERMS_UNESTABLISHED");
    const materialIds = t.conditions.filter(c => c.material).map(c => c.id).sort();
    if (pd && canonical([...pd.materialConditionIds].sort()) !== canonical(materialIds)) issues.push("PROFESSIONAL_CONDITION_INVENTORY_MISMATCH");
    const unsatisfied = [];
    for (const condition of t.conditions) {
      const observation = history.filter(e => e.kind === "CONDITION_OBSERVED" && e.termsDigest === td && e.condition?.id === condition.id
        && condition.requiredIssuerIds.includes(e.issuerId) && time(e.expiresAt) > now).at(-1);
      const disclosedSatisfied = pd && !pd.unsatisfiedConditionIds.includes(condition.id);
      if (condition.kind === "DISCRETIONARY" || !disclosedSatisfied
        || condition.kind !== "PROFESSIONAL" && (!observation?.condition.satisfied || observation.condition.meaning !== condition.interpretation)) {
        unsatisfied.push(condition.id);
      }
      if (condition.expiry && time(condition.expiry) <= now) issues.push(`CONDITION_EXPIRED:${condition.id}`);
    }
    if (pd?.unsatisfiedConditionIds.some(id => !materialIds.includes(id))) issues.push("PROFESSIONAL_UNKNOWN_CONDITION");
    const moneyCompatible = t.amount.currency === m.requirement.currency && t.amount.minorUnits === m.requirement.minorUnits
      && t.amount.rounding === "EXACT" && m.requirement.rounding === "EXACT";
    if (!moneyCompatible) issues.push("FX_OR_UNIT_DOMAIN_UNSUPPORTED_NO_IMPLICIT_CONVERSION");
    if (t.financialIRRef !== null || t.fixedRate !== null && t.rateConvention !== "FIXED_RATE_NO_COMPUTED_SCHEDULE"
      || t.fixedRate === null && t.rateConvention !== "NOT_APPLICABLE") issues.push("CURRENT_TYPED_FINANCIAL_IR_LINK_UNSUPPORTED");
    if (t.fixedRate && (compare(t.fixedRate, a.body.pricingBounds.minRate) < 0n || compare(t.fixedRate, a.body.pricingBounds.maxRate) > 0n)) issues.push("PRICING_OUTSIDE_AUTHORITY");
    if (amount > integer(a.body.maxExposureMinor)) issues.push("EXPOSURE_OUTSIDE_AUTHORITY");
    let fees = 0n;
    for (const fee of t.fees) {
      if (fee.amount.currency !== m.requirement.currency || fee.amount.minorUnits !== m.requirement.minorUnits || fee.amount.legalEntityId !== m.legalEntityId) issues.push("FEE_SEMANTICS_UNSUPPORTED");
      fees += integer(fee.amount.amountMinor);
      const tranche = m.tranches.find(x => x.id === fee.id && x.purpose === "FEES" && x.currency === fee.amount.currency && time(x.dueAt) >= time(fee.dueAt));
      if (!tranche || integer(tranche.requiredMinor) < integer(fee.amount.amountMinor)) conflicts.push(`UNFUNDED_FEE:${fee.id}`);
    }
    if (fees > integer(a.body.pricingBounds.maxFeesMinor)) issues.push("FEES_OUTSIDE_AUTHORITY");
    for (const guarantee of t.guarantees) {
      if (!a.body.permittedGuaranteeIds.includes(guarantee.id)) issues.push(`GUARANTEE_OUTSIDE_AUTHORITY:${guarantee.id}`);
      if (!a.body.legalEntityIds.includes(guarantee.guarantorEntityId) || guarantee.maximum.legalEntityId !== guarantee.guarantorEntityId
        || guarantee.maximum.currency !== m.requirement.currency || guarantee.maximum.minorUnits !== m.requirement.minorUnits
        || guarantee.maximum.unit !== "CURRENCY_MINOR_UNIT" || guarantee.maximum.rounding !== "EXACT") issues.push(`GUARANTEE_ENTITY_OR_MONEY_UNSUPPORTED:${guarantee.id}`);
    }
    if (t.guarantees.reduce((sum, g) => sum + integer(g.maximum.amountMinor), amount) > integer(a.body.maxExposureMinor)) issues.push("GUARANTEE_AGGREGATE_EXPOSURE_OUTSIDE_AUTHORITY");
    for (const covenant of t.covenants) if (m.prohibitedCovenantIds.includes(covenant.id)) conflicts.push(`PROHIBITED_COVENANT:${covenant.id}`);
    for (const crossDefault of t.crossDefaults) if (m.prohibitedCrossDefaults.includes(crossDefault)) conflicts.push(`PROHIBITED_CROSS_DEFAULT:${crossDefault}`);
    if (t.ownership && (!nonnegative(t.ownership.economicShare) || !nonnegative(t.ownership.votingShare)
      || compare(t.ownership.economicShare, m.maxEconomicOwnership) > 0n || compare(t.ownership.votingShare, m.maxVotingOwnership) > 0n)) conflicts.push("OWNERSHIP_LIMIT");
    const tranche = m.tranches.find(x => x.id === t.trancheId && x.instruments.includes(t.instrument) && x.currency === t.amount.currency);
    if (!tranche || time(t.availableFrom) > time(tranche.dueAt) || time(t.drawDeadline) < time(tranche.dueAt) || time(t.expiresAt) <= time(tranche.dueAt)) conflicts.push(`TRANCHE_TIMING_OR_PURPOSE:${t.trancheId}`);
    let state = latest.kind === "INDICATION" ? "INDICATIVE" : "APPROVAL_PENDING";
    const withdrawal = history.filter(e => ["WITHDRAWAL", "REFUSAL"].includes(e.kind) && (!e.termsDigest || e.termsDigest === td)).at(-1);
    if (withdrawal && time(withdrawal.observedAt) >= time(latest.observedAt)) state = "WITHDRAWN";
    else if (time(t.expiresAt) <= now || time(t.drawDeadline) <= now) state = "EXPIRED";
    else if (!issues.length && execution && pd && ["BINDING_CONDITIONAL", "EFFECTIVE"].includes(pd.operativeStatus)) {
      state = unsatisfied.length || pd.operativeStatus === "BINDING_CONDITIONAL" || time(t.availableFrom) > now
        ? "VERIFIED_CONDITIONAL" : "VERIFIED_EFFECTIVE_UNDRAWN";
      if (!t.executionDigest || t.executionDigest !== execution.terms.executionDigest) { issues.push("EXACT_EXECUTED_DOCUMENT_UNESTABLISHED"); state = "APPROVAL_PENDING"; }
    }
    if (!pd && state !== "INDICATIVE" && !["EXPIRED", "WITHDRAWN"].includes(state)) issues.push("PROFESSIONAL_DETERMINATION_REQUIRED");
    let received = 0n, unknown = 0n;
    const groupDraws = draws.filter(d => d.commitmentIdentity === t.commitmentIdentity && d.providerEntityId === t.providerEntityId && d.termsDigest === td);
    for (const draw of groupDraws) {
      if (draw.sourceArtifactDigest !== draw.currentArtifactDigest || !draw.exactOwnerBinding || !draw.allocationRef || !draw.obligationId) {
        issues.push("DRAW_EXACT_OWNER_BINDING_UNAVAILABLE"); continue;
      }
      const observations = history.filter(e => e.kind === "FUNDING_OBSERVATION" && e.funding?.originalDrawEffectId === draw.effectId
        && profile?.settlementIssuerIds.includes(e.issuerId));
      let drawReceived = 0n;
      for (const observation of observations) {
        const f = observation.funding, observationKey = `${observation.issuerId}:${f.observationIdentity}`;
        if (fundingIdentities.has(observationKey)) continue;
        fundingIdentities.add(observationKey);
        if (!f.receiverConfirmed || !f.settlementFinal || f.receivingEntityId !== m.legalEntityId
          || f.amount.legalEntityId !== m.legalEntityId || f.amount.currency !== t.amount.currency
          || f.amount.minorUnits !== t.amount.minorUnits || f.amount.rounding !== "EXACT" || observation.termsDigest !== td) {
          issues.push("RECEIVING_PREDICATE_NOT_ESTABLISHED"); continue;
        }
        drawReceived += integer(f.amount.amountMinor);
      }
      if (drawReceived > integer(draw.amountMinor)) issues.push("FUNDING_OBSERVATION_EXCEEDS_ORIGINAL_OBLIGATION");
      received += drawReceived;
      if (draw.state !== "DEFINITELY_NOT_DISPATCHED") unknown += max(0n, integer(draw.amountMinor) - drawReceived);
    }
    if (received > amount) issues.push("FUNDING_EXCEEDS_COMMITMENT");
    const legallyVerified = ["VERIFIED_CONDITIONAL", "VERIFIED_EFFECTIVE_UNDRAWN"].includes(state),
      legalIssues = issues.length;
    let eligible = state === "VERIFIED_EFFECTIVE_UNDRAWN" ? max(0n, amount - received - unknown) : 0n;
    if (eligible) for (const resourceId of t.capacityResourceIds) {
      const result = resourceAvailable(resources.find(r => r.resourceId === resourceId), outstanding, m.requirement.minorUnits, now, m, t, td, backingTerms);
      if (result.error) issues.push(`${result.error}:${resourceId}`);
      const already = capacityClaims.get(resourceId) ?? 0n;
      capacityClaims.set(resourceId, already + eligible);
      if (already + eligible > result.available) conflicts.push(`SHARED_CAPACITY_EXCEEDED:${resourceId}`);
    }
    if (issues.length) eligible = 0n;
    if (eligible) {
      const pool = `${t.providerEntityId}:${t.instrument}:${t.facilityId ?? t.securityId ?? t.instrumentIdentity}`,
        prior = capacityPools.get(pool) ?? [];
      if (prior.some(claim => !claim.resourceIds.some(id => t.capacityResourceIds.includes(id)))) {
        conflicts.push(`CANONICAL_FACILITY_CAPACITY_IDENTITY_AMBIGUOUS:${pool}`);
      }
      prior.push({ commitmentId: groupKey, resourceIds: t.capacityResourceIds }); capacityPools.set(pool, prior);
    }
    if (unknown > 0n) state = "FUNDING_UNKNOWN";
    else if (received > 0n) state = "FUNDING_OBSERVED";
    for (const security of t.security) if (legallyVerified) {
      const prior = collateralClaims.get(security.collateralId);
      if (prior && (security.exclusivity || prior.exclusivity)) conflicts.push(`COLLATERAL_EXCLUSIVITY:${security.collateralId}`);
      collateralClaims.set(security.collateralId, security);
      for (const consent of security.requiredConsentRefs) if (!m.requiredCollateralConsents.includes(consent)) conflicts.push(`COLLATERAL_CONSENT_UNAVAILABLE:${consent}`);
    }
    const candidate = {
      commitmentId: groupKey, providerEntityId: t.providerEntityId, instrument: t.instrument, termsDigest: td, state,
      faceMinor: moneyCompatible ? amount.toString() : "0", conditionalMinor: state === "VERIFIED_CONDITIONAL" ? amount.toString() : "0",
      eligibleUndrawnMinor: eligible.toString(), fundingReceivedMinor: received.toString(), fundingUnknownMinor: unknown.toString(),
      unsatisfiedConditions: unsatisfied, unresolvedClaims: [...new Set(issues)], eventIds: history.map(e => `${e.issuerId}:${e.eventId}`),
      verified: legallyVerified && !legalIssues, profileId: profile?.id ?? null, identityEventId: identity ? `${identity.issuerId}:${identity.eventId}` : null,
      executionEventId: execution ? `${execution.issuerId}:${execution.eventId}` : null,
      determinationEventId: professional ? `${professional.issuerId}:${professional.eventId}` : null,
    };
    states.push(candidate); unresolved.push(...candidate.unresolvedClaims);
  }
  // Dependencies and mutually incompatible covenants are evaluated over the whole package, not by document.
  const dependencies = new Map(), selectedTerms = new Map(states.map(state => [state.commitmentId,
    groups.get(state.commitmentId).findLast(e => e.terms && e.termsDigest === state.termsDigest).terms]));
  for (const state of states) {
    const terms = selectedTerms.get(state.commitmentId);
    dependencies.set(state.commitmentId, [...new Set(terms.conditions.flatMap(c => c.dependencyCommitmentIds))]);
    for (const condition of terms.conditions) for (const dependency of condition.dependencyCommitmentIds) {
      const other = states.find(s => s.commitmentId === dependency);
      if (!other || !["VERIFIED_EFFECTIVE_UNDRAWN", "FUNDING_OBSERVED"].includes(other.state)) conflicts.push(`FINANCING_DEPENDENCY_UNSATISFIED:${condition.id}`);
    }
    for (const covenant of terms.covenants) for (const other of states.filter(s => s.commitmentId !== state.commitmentId && s.verified)) {
      if (selectedTerms.get(other.commitmentId).covenants.some(c => covenant.conflictsWith.includes(c.id))) conflicts.push(`COVENANT_CONFLICT:${covenant.id}`);
    }
  }
  // At most 512 authenticated events bound the graph. Colour every reachable
  // node, including self-loops and cycles longer than a mutual pair.
  const colours = new Map();
  const visit = id => {
    if (colours.get(id) === 1) { conflicts.push("CIRCULAR_FINANCING_DEPENDENCY"); return; }
    if (colours.get(id) === 2) return;
    colours.set(id, 1);
    for (const dependency of dependencies.get(id) ?? []) if (dependencies.has(dependency)) visit(dependency);
    colours.set(id, 2);
  };
  for (const id of dependencies.keys()) visit(id);
  // A conflicted set is not a feasible package. Retain every source and
  // liability, but do not report summed conflicting capacity as available.
  if (conflicts.length || input.programmeStopped || input.programmeActivityBlocked || time(m.expiresAt) <= now) {
    for (const state of states) state.eligibleUndrawnMinor = "0";
  }
  if (input.programmeStopped) unresolved.push("ORIGINAL_PROGRAMME_STOPPED_NO_NEW_AVAILABILITY");
  if (input.programmeActivityBlocked) unresolved.push("ORIGINAL_ACTIVITY_BLOCKED_NO_NEW_AVAILABILITY");
  const eligible = states.reduce((s, c) => s + integer(c.eligibleUndrawnMinor), 0n),
    conditional = states.reduce((s, c) => s + integer(c.conditionalMinor), 0n),
    received = states.reduce((s, c) => s + integer(c.fundingReceivedMinor), 0n),
    unknown = states.reduce((s, c) => s + integer(c.fundingUnknownMinor), 0n),
    requirement = integer(m.requirement.amountMinor);
  let reserved = 0n;
  for (const draw of draws) if (draw.exactOwnerBinding && draw.allocationRef) reserved += integer(draw.amountMinor);
  for (const tranche of m.tranches) {
    const matching = states.filter(c => groups.get(c.commitmentId).some(e => e.termsDigest === c.termsDigest && e.terms?.trancheId === tranche.id));
    const present = matching.reduce((s, c) => s + integer(c.eligibleUndrawnMinor) + integer(c.fundingReceivedMinor), 0n);
    if (present < integer(tranche.requiredMinor)) unresolved.push(`TRANCHE_NOT_PRESENT_ELIGIBLE:${tranche.id}`);
  }
  const allowed = m.readinessBasis === "RECONCILED_FUNDING_ONLY" ? received : eligible + received;
  const blocked = conflicts.length || unresolved.length || unknown > 0n || states.some(s => s.unsatisfiedConditions.length > 0);
  const readiness = !blocked && received >= requirement ? "FUNDING_RECEIVED"
    : !blocked && allowed >= requirement ? "READY_FOR_AUTHORIZED_NEXT_STEP"
      : !blocked && eligible + conditional + received >= requirement ? "CONDITIONALLY_COMPATIBLE" : "INCOMPLETE";
  const result = {
    programmeId: m.programmeId, basis: m.readinessBasis, basisRevision: m.readinessRevision,
    currency: m.requirement.currency, minorUnits: m.requirement.minorUnits, requirementMinor: requirement.toString(),
    faceMinor: states.reduce((s, c) => s + integer(c.faceMinor), 0n).toString(),
    conditionalCommittedMinor: conditional.toString(),
    indicativeEquityMinor: states.filter(c => c.state === "INDICATIVE" && c.instrument !== "CORPORATE_DEBT").reduce((s, c) => s + integer(c.faceMinor), 0n).toString(),
    eligibleUndrawnMinor: eligible.toString(), reservedAllocationMinor: reserved.toString(), dispatchedUnknownMinor: unknown.toString(),
    fundingReceivedMinor: received.toString(), financingGapMinor: max(0n, requirement - conditional - eligible - received).toString(),
    presentEligibleGapMinor: max(0n, requirement - allowed).toString(),
    readiness, conflicts: [...new Set(conflicts)].sort(), unresolvedClaims: [...new Set(unresolved)].sort(),
    remainingConditions: [...new Set(states.flatMap(c => c.unsatisfiedConditions))].sort(),
    commitments: states, raisedPrincipalIsProfit: false,
  };
  return { schema: "finnor.v4.independent-check.v1", inputDigest: hash(input), resultDigest: hash(result), result,
    supportedDomain: "ENROLLED_EXACT_SIGNED_PROFESSIONAL_SEMANTICS_SINGLE_PERIOD_EXACT_CURRENCY",
    excludedInterpretations: ["NO_GENERAL_LEGAL_INFERENCE", "NO_IMPLICIT_FX", "NO_INFERRED_COVENANT_EQUIVALENCE", "NO_PRINCIPAL_AS_PROFIT"],
    checkedAt: input.knowledgeAt, checkerDigest: hash(awaitableSource) };
}

const awaitableSource = await readFile(new URL(import.meta.url), "utf8");
let size = 0; const chunks = [];
try {
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 8 * 1024 * 1024) throw Error("CHECKER_BYTE_BOUND"); chunks.push(chunk); }
  const answer = reconstruct(JSON.parse(Buffer.concat(chunks).toString()));
  process.stdout.write(JSON.stringify(answer));
} catch (error) {
  process.stdout.write(JSON.stringify({ schema: "finnor.v4.independent-check.v1", failure: String(error?.message ?? "CHECKER_REJECTED") }));
  process.exitCode = 1;
}

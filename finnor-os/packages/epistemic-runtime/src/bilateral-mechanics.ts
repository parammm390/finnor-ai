import type { BilateralBounds, BilateralCompanyRecord, BilateralMandate, BilateralTerms } from "@finnor/shared-types";

/** Registered exact nonbinding majority-purchase grammar. No funding, employment,
 * accounting opinion or legal-effectiveness assertion is produced here. */
export function bilateralMechanics(terms: BilateralTerms, bounds: BilateralBounds, buyerId: string, currency: string): string[] {
  const reasons: string[] = [], price = BigInt(terms.purchasePrice.amount);
  if (terms.buyerEntityId !== buyerId || terms.purchasePrice.legalEntityId !== buyerId ||
      terms.purchasePrice.currency !== currency || terms.purchasePrice.ownerShare.numerator !== "1" ||
      terms.purchasePrice.ownerShare.denominator !== "1") reasons.push("EXACT_BUYER_CURRENCY_SHARE_MISMATCH");
  if (price <= 0n || price < BigInt(bounds.minimumPurchaseMinorUnits) ||
      price > BigInt(bounds.maximumPurchaseMinorUnits)) reasons.push("PURCHASE_PRICE_OUTSIDE_ENVELOPE");
  if (terms.controlShareBps <= 5000 || terms.controlShareBps < bounds.minimumControlBps ||
      terms.controlShareBps > bounds.maximumControlBps ||
      terms.controlShareBps + terms.retainedShareBps !== 10000) reasons.push("MAJORITY_AND_RETAINED_SHARES_INVALID");
  if (terms.managementParticipationBps > bounds.maximumManagementParticipationBps ||
      terms.managementParticipationBps > terms.retainedShareBps) reasons.push("MANAGEMENT_PARTICIPATION_OUTSIDE_ENVELOPE");
  const close = Date.parse(terms.proposedClosingAt);
  if (close < Date.parse(bounds.earliestClosingAt) || close > Date.parse(bounds.latestClosingAt)) reasons.push("CLOSING_TIMING_OUTSIDE_ENVELOPE");
  let total = 0n, deferred = 0n, closings = 0;
  for (const stage of terms.consideration) {
    const amount = BigInt(stage.amount), date = Date.parse(stage.dueAt);
    total += amount;
    if (amount <= 0n || date < close) reasons.push("CONSIDERATION_STAGE_INVALID");
    if (stage.condition === "AT_CLOSING") {
      closings++; if (date !== close) reasons.push("CLOSING_CONSIDERATION_DATE_MISMATCH");
    } else {
      deferred += amount;
      if (date - close > bounds.maximumDeferredDays * 86400000) reasons.push("DEFERRED_TIMING_OUTSIDE_ENVELOPE");
    }
  }
  if (closings !== 1 || total !== price || deferred * 10000n > price * BigInt(bounds.maximumDeferredBps)) reasons.push("EXACT_CONSIDERATION_MECHANICS_INVALID");
  if (terms.managementContinuity !== "NONE" && !bounds.allowProposedManagementContinuity) reasons.push("MANAGEMENT_CONDITION_NOT_PERMITTED");
  return [...new Set(reasons)];
}

export function preliminaryBilateralFit(mandate: BilateralMandate, company: BilateralCompanyRecord, at: string) {
  return mandate.preliminaryPredicates.map(predicate => {
    const fact = company.facts[predicate.field], source = company.factSources[predicate.field];
    let supported = false;
    if (fact !== undefined && fact !== null && source &&
        source.exactFields.includes(predicate.field) && Date.parse(source.observedAt) <= Date.parse(at) &&
        Date.parse(at) - Date.parse(source.observedAt) <= predicate.maximumAgeMs) {
      if (predicate.operator === "EQ") supported = fact === predicate.expected;
      else if (typeof fact === "string" && typeof predicate.expected === "string" &&
        /^-?(0|[1-9]\d{0,95})$/.test(fact) && /^-?(0|[1-9]\d{0,95})$/.test(predicate.expected)) {
        supported = predicate.operator === "GTE" ? BigInt(fact) >= BigInt(predicate.expected) : BigInt(fact) <= BigInt(predicate.expected);
      }
    }
    return { id: predicate.id, field: predicate.field, evidence: source ?? null,
      status: supported ? "SUPPORTED" as const : fact === undefined || fact === null || !source ? "UNRESOLVED" as const : "CONTRADICTED" as const };
  });
}

export function searchBilateralStructures(mandate: BilateralMandate, company: BilateralCompanyRecord, at: string): BilateralTerms[] {
  const b = mandate.bounds, o = company.ownerObjectives;
  if (o.majoritySaleConsidered === false) return [];
  const minimum = Math.max(5001, b.minimumControlBps), maximum = Math.min(b.maximumControlBps, 10000 - (o.minimumRetainedBps ?? 0));
  if (minimum > maximum) return [];
  const closing = Math.max(Date.parse(b.earliestClosingAt), Date.parse(o.earliestClosingAt ?? b.earliestClosingAt));
  if (closing > Math.min(Date.parse(b.latestClosingAt), Date.parse(o.latestClosingAt ?? b.latestClosingAt))) return [];
  if (o.proposedManagementContinuityRequested && !b.allowProposedManagementContinuity) return [];
  const controls = [...new Set([minimum, Math.floor((minimum + maximum) / 2), maximum])];
  return controls.map(control => ({
    schema: "finnor.bilateral-terms.v1" as const, companyId: company.companyId, buyerEntityId: mandate.buyerEntityId,
    purchasePrice: { amount: b.minimumPurchaseMinorUnits, currency: mandate.currency, units: "MINOR_UNITS" as const,
      minorUnitsPerMajor: 100 as const, legalEntityId: mandate.buyerEntityId, ownerShare: { numerator: "1", denominator: "1" },
      timeBasis: "AT_PROPOSED_CLOSING" as const, valuationDate: at, rounding: "EXACT_INTEGER_NO_EXECUTION_ROUNDING" as const },
    controlShareBps: control, retainedShareBps: 10000 - control, managementParticipationBps: 0,
    consideration: [{ amount: b.minimumPurchaseMinorUnits, dueAt: new Date(closing).toISOString(), condition: "AT_CLOSING" as const }],
    managementContinuity: o.proposedManagementContinuityRequested ? "PROPOSED_12_MONTH_CONTINUITY_SUBJECT_TO_DEFINITIVE_AGREEMENT" as const : "NONE" as const,
    proposedClosingAt: new Date(closing).toISOString(), indicationBindingStatus: "NONBINDING" as const,
    exclusions: ["NOT_UNDERWRITTEN", "NO_FUNDING_OR_IC_APPROVAL_CLAIM", "NO_EXCLUSIVITY", "NO_EMPLOYMENT_GUARANTEE", "NO_LEGAL_EFFECTIVENESS_CLAIM"] as BilateralTerms["exclusions"],
  })).filter(terms => bilateralMechanics(terms, b, mandate.buyerEntityId, mandate.currency).length === 0);
}

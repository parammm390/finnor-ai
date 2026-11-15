import {
  COST_CATEGORIES, canonical, decimal, hash, sameScope, type EvidenceClass, type InstanceProjection,
  type NativeEffectObservation, type NativeRef, type ObservationOriginal, type RealWorldServiceProgram,
  type ServiceCost, type ServiceCriterion, type ServiceProjection, type ServiceState,
} from "./contracts";

function reportRoleAllowed(r: ObservationOriginal, p: RealWorldServiceProgram): boolean {
  if (r.body.kind === "ORIGINAL_ACCEPTANCE")
    return r.role === "ACCEPTANCE_OWNER" && r.authorId === p.original.acceptanceOwnerId;
  if (r.body.kind === "OBSERVATION") {
    const body = r.body;
    const required = p.original.criteria.find(c => c.id === body.criterionId);
    return !!required && (
      required.kind === "SENSORY" ? r.role === "RECIPIENT"
      : required.kind === "PROFESSIONAL" ? r.role === "PROFESSIONAL" && required.qualificationIds.every(id => r.qualificationIds.includes(id))
      : required.kind === "ORIGINAL_ACCEPTANCE" ? r.role === "ACCEPTANCE_OWNER" && r.authorId === p.original.acceptanceOwnerId
      : ["INSPECTOR", "PROFESSIONAL", "RECIPIENT"].includes(r.role)
    ) && (!required.independentOfProvider || r.authorId !== r.body.providerId);
  }
  if (["QUOTE", "ACCEPTED", "STARTED", "DELIVERED", "CANCELLED"].includes(r.body.kind)) return r.role === "PROVIDER";
  return true;
}
function timeFits(r: ObservationOriginal, c: ServiceCriterion, start: number, end: number, deadline: number): boolean {
  const at = Date.parse(r.body.at), maxAge = c.maximumAgeSeconds * 1000;
  switch (c.phase) {
    case "TRIAL": case "READINESS": return at <= start && start - at <= maxAge;
    case "SERVICE": return at >= start && at <= end;
    case "HANDBACK": case "ACCESS_RETIREMENT": return at >= end && at <= deadline;
  }
}
const uniqueRefs = (refs: NativeRef[]) => [...new Map(refs.map(r => [canonical(r), r])).values()];
const uniqueCosts = (costs: ServiceCost[]) => [...new Map(costs.map(c => [c.id, c])).values()];

/** Projection only. Native S6 owns effect state; S7 owns accounting. An inspected
 * controlled trace never becomes field validation or an admission receipt. */
export function projectServiceProgram(
  program: RealWorldServiceProgram, originals: ObservationOriginal[],
  effects: NativeEffectObservation[], now: number,
): ServiceProjection {
  const allScoped = originals.filter(r => sameScope(r.body.scope, program.envelope.scope));
  const historical = allScoped.filter(r => Date.parse(r.body.at) <= now
    && Date.parse(r.receivedAt) <= now && reportRoleAllowed(r, program));
  const invoiceKey = (body: { instanceId: string; providerId: string; termsDigest: string; invoiceId: string }) =>
    canonical([body.instanceId, body.providerId, body.termsDigest, body.invoiceId]);
  const invoiceSources = new Map<string, ObservationOriginal>();
  const settledPayments = new Set<string>(), disputedInvoices = new Set<string>();
  for (const report of historical) {
    const body = report.body;
    if (body.kind === "INVOICE") invoiceSources.set(report.ref.sourceId, report);
    if (body.kind === "PAYMENT") {
      if (body.status === "DISPUTED") disputedInvoices.add(invoiceKey(body));
      if (body.status === "SETTLED") settledPayments.add(canonical([invoiceKey(body), body.amount, body.effectRef]));
    }
  }
  const reconciledInvoiceBodies = new Set<string>();
  for (const effect of effects) if (effect.operation === "PAY" && effect.state === "VERIFIED" && effect.originalIdentityReadback)
    for (const sourceId of effect.invoiceSourceIds) {
      const invoice = invoiceSources.get(sourceId)?.body;
      if (invoice?.kind === "INVOICE" && invoice.instanceId === effect.instanceId && invoice.providerId === effect.providerId
        && invoice.termsDigest === effect.termsDigest && !disputedInvoices.has(invoiceKey(invoice))
        && settledPayments.has(canonical([invoiceKey(invoice), invoice.amount, effect.ref])))
        reconciledInvoiceBodies.add(hash(invoice));
    }
  const unreconciledInvoices = [...new Map([...invoiceSources.values()].filter(r => !reconciledInvoiceBodies.has(hash(r.body)))
    .map(r => [hash(r.body), r])).values()];
  const unreconciledInstances = new Set(unreconciledInvoices.map(r => r.body.instanceId));
  const eligible = historical.filter(r => r.consentCurrent
    && program.options.some(o => o.instanceId === r.body.instanceId && o.providerId === r.body.providerId
      && o.termsDigest === r.body.termsDigest));
  const instances: InstanceProjection[] = program.instances.map(instance => {
    const reports = eligible.filter(r => r.body.instanceId === instance.id);
    const rows = reports.map(r => r.body);
    const originalFailures = allScoped.filter(r => r.body.instanceId === instance.id
      && ["MISSED", "DISPUTED"].includes(r.body.kind)).map(r => r.body.kind + ":" + r.ref.sourceId);
    const ownEffects = effects.filter(e => e.instanceId === instance.id);
    const unresolved = ownEffects.filter(e => ["UNKNOWN", "MAY_HAVE_LEFT"].includes(e.state)).map(e => e.ref);
    const selected = program.selection.find(s => s.instanceId === instance.id);
    const historicReports = historical.filter(r => r.body.instanceId === instance.id);
    const commitments = [...program.options.filter(o => o.instanceId === instance.id),
      ...historicReports.map(r => ({ providerId: r.body.providerId, termsDigest: r.body.termsDigest }))]
      .filter((o, i, all) => all.findIndex(x => x.providerId === o.providerId && x.termsDigest === o.termsDigest) === i)
      .map(option => {
        const matching = historicReports.filter(r => r.body.providerId === option.providerId && r.body.termsDigest === option.termsDigest);
        const accepted = matching.find(r => r.body.kind === "ACCEPTED");
        const cancelled = matching.filter(r => r.body.kind === "CANCELLED");
        const confirmed = cancelled.some(r => r.body.kind === "CANCELLED"
          && ownEffects.some(e => canonical(e.ref) === canonical(r.body.kind === "CANCELLED" ? r.body.effectRef : null)
            && e.termsDigest === option.termsDigest && e.providerId === option.providerId
            && e.operation === "CANCEL" && e.state === "VERIFIED" && e.originalIdentityReadback));
        const state = confirmed ? "CONFIRMED_CANCELLED_WITH_RESIDUALS" as const
          : matching.some(r => r.body.kind === "CANCELLATION_REQUESTED") ? "CANCELLATION_REQUESTED" as const
          : accepted ? "ACCEPTED" as const
          : matching.some(r => r.body.kind === "QUOTE") ? "QUOTED" as const : "PROPOSED" as const;
        return {
          providerId: option.providerId, termsDigest: option.termsDigest, state,
          effectRefs: uniqueRefs(matching.flatMap(r => "effectRef" in r.body ? [r.body.effectRef] : [])),
          residualCosts: cancelled.flatMap(r => r.body.kind === "CANCELLED" ? r.body.residualCosts : []),
        };
      });
    const acceptance = reports.filter(r => r.body.kind === "ORIGINAL_ACCEPTANCE")
      .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt));
    const chosenProvider = acceptance[0]?.body.providerId ?? selected?.providerId ?? "";
    const chosenTerms = acceptance[0]?.body.termsDigest ?? selected?.termsDigest ?? "";
    const chosen = reports.filter(r => r.body.providerId === chosenProvider && r.body.termsDigest === chosenTerms);
    const criteria = program.observationRequirements.filter(r => r.instanceId === instance.id).map(r => r.criterion);
    const missingCriteria: string[] = [], contradictions: string[] = [];
    const passedSources: string[] = [];
    const start = Date.parse(instance.startAt), end = Date.parse(instance.endAt);
    const passed = new Set<string>();
    for (const criterion of criteria) {
      const evidence = chosen.filter(r => r.body.kind === "OBSERVATION"
        && r.body.criterionId === criterion.id && timeFits(r, criterion, start, end, Date.parse(program.original.originalDeadlineAt)));
      const values = new Set(evidence.map(r => r.body.kind === "OBSERVATION" ? r.body.result : "UNOBSERVED"));
      if (values.has("CONFLICTING") || values.has("FAIL") && values.has("PASS")) contradictions.push(criterion.id);
      if (values.size !== 1 || !values.has("PASS")) missingCriteria.push(criterion.id);
      else {
        passed.add(criterion.id); passedSources.push(...evidence.map(r => r.ref.sourceId));
      }
    }
    const acceptedReports = chosen.filter(r => r.body.kind === "ACCEPTED");
    const accepted = acceptedReports.some(r => {
      const body = r.body;
      return body.kind === "ACCEPTED" && ownEffects.some(e => e.providerId === chosenProvider
        && e.termsDigest === chosenTerms && ["OFFER", "BOOK"].includes(e.operation) && e.state === "VERIFIED"
        && e.originalIdentityReadback && canonical(e.ref) === canonical(body.effectRef));
    });
    const ready = criteria.filter(c => c.phase === "READINESS" || c.phase === "TRIAL").every(c => passed.has(c.id));
    const deliveryClaims = chosen.filter(r => r.body.kind === "DELIVERED");
    const exactDelivery = deliveryClaims.length > 0 && deliveryClaims.every(r => r.body.kind === "DELIVERED"
      && canonical(r.body.quantity) === canonical(instance.quantity) && Date.parse(r.body.at) >= start && Date.parse(r.body.at) <= end);
    if (deliveryClaims.some(r => r.body.kind === "DELIVERED" && canonical(r.body.quantity) !== canonical(instance.quantity)))
      contradictions.push("DELIVERY_QUANTITY");
    const independentEvent = criteria.some(c => c.phase === "SERVICE" && c.independentOfProvider
      && ["OBSERVED_EVENT", "INSPECTION", "PROFESSIONAL"].includes(c.kind) && passed.has(c.id));
    const delivered = exactDelivery && independentEvent;
    const inspected = criteria.filter(c => c.phase === "SERVICE").every(c => passed.has(c.id)) && independentEvent;
    const latestAcceptance = acceptance.find(r => r.body.providerId === chosenProvider && r.body.termsDigest === chosenTerms);
    const acceptedSources = new Set(latestAcceptance?.body.kind === "ORIGINAL_ACCEPTANCE"
      ? latestAcceptance.body.observedSourceIds : []);
    const requiredSources = new Set(passedSources);
    const currentAcceptance = latestAcceptance?.body.kind === "ORIGINAL_ACCEPTANCE" && latestAcceptance.body.accepted
      && passedSources.every(id => acceptedSources.has(id))
      && chosen.filter(r => requiredSources.has(r.ref.sourceId)).every(r =>
        Date.parse(r.body.at) <= Date.parse(latestAcceptance.body.at));
    const needsRetirement = criteria.some(c => c.phase === "ACCESS_RETIREMENT");
    const retirementReadback = !needsRetirement || ownEffects.some(e => e.operation === "RETIRE_ACCESS"
      && e.providerId === chosenProvider && e.termsDigest === chosenTerms
      && e.state === "VERIFIED" && e.originalIdentityReadback);
    if (!retirementReadback) missingCriteria.push("NATIVE_ACCESS_RETIREMENT_READBACK");
    const operationallyComplete = !!currentAcceptance && accepted && ready && delivered && inspected
      && missingCriteria.length === 0 && contradictions.length === 0;
    const invoices = chosen.filter(r => r.body.kind === "INVOICE");
    let invoicesReconciled = invoices.length > 0;
    const invoiceIds = new Set<string>();
    let invoicedQuantity = 0n, invoicedMinor = 0n;
    for (const report of invoices) if (report.body.kind === "INVOICE") {
      const invoice = report.body;
      if (invoiceIds.has(invoice.invoiceId)) {
        const same = invoices.filter(r => r.body.kind === "INVOICE" && r.body.invoiceId === invoice.invoiceId);
        if (same.some(r => hash(r.body) !== hash(invoice))) contradictions.push("INVOICE_REVISION:" + invoice.invoiceId);
        continue;
      }
      invoiceIds.add(invoice.invoiceId);
      invoicedQuantity += decimal(invoice.quantity.value);
      if (invoice.amount.currency === program.original.currency) invoicedMinor += BigInt(invoice.amount.minor);
      if (!delivered || invoice.quantity.unit !== instance.quantity.unit
        || decimal(invoice.quantity.value) > decimal(instance.quantity.value) || invoice.amount.currency !== program.original.currency) {
        contradictions.push("UNDELIVERED_OR_WRONG_UNIT_INVOICE:" + invoice.invoiceId); invoicesReconciled = false; continue;
      }
      const payments = chosen.filter(r => r.body.kind === "PAYMENT" && r.body.invoiceId === invoice.invoiceId);
      const settled = payments.some(r => {
        const body = r.body;
        return body.kind === "PAYMENT" && body.status === "SETTLED"
          && canonical(body.amount) === canonical(invoice.amount) && ownEffects.some(e => e.operation === "PAY"
            && e.termsDigest === chosenTerms && e.invoiceSourceIds.includes(report.ref.sourceId)
            && e.providerId === chosenProvider && e.state === "VERIFIED" && e.originalIdentityReadback
            && canonical(e.ref) === canonical(body.effectRef));
      });
      if (!settled || payments.some(r => r.body.kind === "PAYMENT" && r.body.status === "DISPUTED")) invoicesReconciled = false;
    }
    if (invoicedQuantity > decimal(instance.quantity.value)) {
      contradictions.push("AGGREGATE_INVOICE_EXCEEDS_OBSERVED_DELIVERY"); invoicesReconciled = false;
    }
    if (invoices.length) {
      const quoted = program.options.find(o => o.instanceId === instance.id
        && o.providerId === chosenProvider && o.termsDigest === chosenTerms)?.total;
      if (!quoted || quoted.currency !== program.original.currency) {
        contradictions.push("ORIGINAL_QUOTED_TOTAL_UNAVAILABLE"); invoicesReconciled = false;
      } else if (invoicedMinor > BigInt(quoted.minor)) {
        contradictions.push("AGGREGATE_INVOICE_EXCEEDS_ORIGINAL_TERMS"); invoicesReconciled = false;
      }
    }
    const disputed = chosen.some(r => r.body.kind === "DISPUTED");
    const costs = uniqueCosts([
      ...chosen.flatMap(r => r.body.kind === "COST" ? [r.body.cost] : []),
      ...commitments.flatMap(c => c.residualCosts),
    ]);
    // An older quote remains a distinct commitment even for the same provider.
    const liveOtherCommitments = commitments.some(c => (c.providerId !== chosenProvider || c.termsDigest !== chosenTerms)
      && ["ACCEPTED", "CANCELLATION_REQUESTED"].includes(c.state));
    const financiallyReconciled = operationallyComplete && !disputed && invoicesReconciled && unresolved.length === 0
      && !unreconciledInstances.has(instance.id)
      && !liveOtherCommitments && costs.every(c => c.amount !== null && c.basis !== "EXPOSURE" && c.basis !== "UNKNOWN")
      && contradictions.length === 0;
    let state: ServiceState = "PROPOSAL";
    if (rows.some(r => r.kind === "QUOTE")) state = "QUOTED";
    if (accepted) state = "ACCEPTED";
    if (accepted && ready) state = "READY";
    if (chosen.some(r => r.body.kind === "STARTED")) state = "STARTED";
    if (delivered) state = "OBSERVED_DELIVERED";
    if (delivered && inspected) state = "INSPECTED";
    if (rows.some(r => r.kind === "MISSED")) state = "MISSED";
    if (rows.some(r => r.kind === "CANCELLATION_REQUESTED")) state = "CANCELLATION_REQUESTED";
    if (commitments.some(c => c.state === "CONFIRMED_CANCELLED_WITH_RESIDUALS")) state = "CONFIRMED_CANCELLED_WITH_RESIDUALS";
    if (operationallyComplete) state = "OPERATIONALLY_COMPLETE";
    if (financiallyReconciled) state = "FINANCIALLY_RECONCILED";
    if (contradictions.length || rows.some(r => r.kind === "DISPUTED")) state = "DISPUTED";
    return {
      instanceId: instance.id, providerId: chosenProvider, state, accepted, ready, delivered, inspected,
      operationallyComplete: operationallyComplete && !disputed, financiallyReconciled, missingCriteria, contradictions, originalFailures,
      observations: reports.map(r => r.ref), outstandingEffects: uniqueRefs(unresolved), costs, commitments,
    };
  });
  // Historical costs and liabilities survive changed terms and revoked evidence.
  const costReports = historical.flatMap(r => (r.body.kind === "COST" ? [r.body.cost]
    : r.body.kind === "CANCELLED" ? r.body.residualCosts : []).map(cost => ({
      key: canonical([r.body.instanceId, r.body.providerId, r.body.termsDigest, cost.id]), cost,
    })));
  const costStates = new Map<string, ServiceCost>(), costConflicts = new Set<string>();
  const rank = { UNKNOWN: 0, QUOTE: 1, EXPOSURE: 2, ACCRUED: 3, CASH: 4 };
  for (const { key, cost } of costReports) {
    const old = costStates.get(key);
    if (old && old.basis === cost.basis && canonical(old) !== canonical(cost)) costConflicts.add(key);
    if (!old || rank[cost.basis] >= rank[old.basis]) costStates.set(key, cost);
  }
  const allCosts = [...costStates.values()];
  const known = new Map<string, bigint>();
  for (const cost of allCosts) if (cost.amount && ["CASH", "ACCRUED"].includes(cost.basis))
    known.set(cost.amount.currency, (known.get(cost.amount.currency) ?? 0n) + BigInt(cost.amount.minor));
  const unknownCostCategories: string[] = COST_CATEGORIES.filter(category =>
    !allCosts.some(c => c.category === category) || allCosts.some(c => c.category === category
      && (c.amount === null || ["QUOTE", "EXPOSURE", "UNKNOWN"].includes(c.basis))));
  if (costConflicts.size) unknownCostCategories.push("CONFLICTING_ORIGINAL_COSTS");
  return {
    originalBusinessAssignments: 1, instances,
    operationallyComplete: instances.length === program.original.demands.length && instances.every(i => i.operationallyComplete),
    financiallyReconciled: instances.every(i => i.financiallyReconciled) && unknownCostCategories.length === 0 && costConflicts.size === 0
      && unreconciledInvoices.length === 0,
    fieldValidated: false, originalFailures: instances.flatMap(i => i.originalFailures),
    residualEffects: uniqueRefs(instances.flatMap(i => i.outstandingEffects)),
    knownCosts: [...known].map(([currency, value]) => ({ currency, minor: value.toString() })),
    unknownCostCategories, evidenceClasses: [...new Set(allScoped.map(r => r.classification))] as EvidenceClass[],
    unreconciledInvoiceSources: unreconciledInvoices.map(r => r.ref),
  };
}

import {
  W3_VERSION, W3_BOUNDS, OutcomeContractSchema, ProviderEvidenceSchema, canonical, decimal, hash,
  optionTerms, sameScope, type OutcomeContract, type ProviderOriginal, type RealWorldServiceProgram,
  type ServiceDemand, type ServiceOption,
} from "./contracts";

export interface CompilationIdentity { methodDigest: string; checkerDigest: string; runtimeDigest: string }
function* optionFor(outcome: OutcomeContract, demand: ServiceDemand, provider: ProviderOriginal,
  now: number, originalDigest: string): IterableIterator<ServiceOption> {
  const p = provider.body;
  if (!provider.current || !sameScope(p.scope, outcome.scope) || provider.authorId !== p.reportingPrincipalId
    || p.classification !== "SERVICE_PROCUREMENT" || p.classificationBasis.length === 0
    || now >= Date.parse(p.evidenceValidUntil) || now >= Date.parse(p.quote.validUntil)) return;
  const needed = outcome.criteria.filter(c => demand.criterionIds.includes(c.id)).flatMap(c => c.qualificationIds);
  if (needed.some(id => !p.qualifications.some(q => q.id === id && Date.parse(q.validUntil) >= Date.parse(demand.endAt)
    && q.verifiedByPrincipalId !== p.reportingPrincipalId))) return;
  const gaps = [...p.quote.unresolvedTerms];
  if (p.quote.perInstanceCosts.some(c => c.amount === null)) gaps.push("MATERIAL_TOTAL_COST_UNIDENTIFIED");
  if (p.quote.perInstanceCosts.some(c => c.amount && c.amount.currency !== outcome.currency))
    gaps.push("QUOTE_CURRENCY_NOT_ORIGINAL_CURRENCY");
  const total = gaps.length ? null : {
    currency: outcome.currency,
    minor: p.quote.perInstanceCosts.reduce((sum, c) => sum + BigInt(c.amount?.minor ?? "0"), 0n).toString(),
  };
  const termsDigest = optionTerms(outcome, demand, provider, originalDigest);
  for (const a of p.availability) if (a.siteId === demand.siteId && a.capacity.unit === demand.quantity.unit
    && Date.parse(a.startAt) <= Date.parse(demand.startAt) && Date.parse(a.endAt) >= Date.parse(demand.endAt)
    && Date.parse(a.validUntil) >= Date.parse(demand.endAt) && Date.parse(a.validUntil) > now
    && decimal(a.capacity.value) >= decimal(demand.quantity.value)) yield {
      providerId: p.providerId, source: provider.ref, provisionKind: p.provisionKind,
      instanceId: demand.id, availabilityId: a.id, termsDigest,
      total, costs: p.quote.perInstanceCosts, gaps: [...gaps],
    };
}
function fits(selected: ServiceOption[], next: ServiceOption, outcome: OutcomeContract, providers: ProviderOriginal[]): boolean {
  const together = [...selected.filter(s => s.providerId === next.providerId), next];
  const p = providers.find(x => x.body.providerId === next.providerId);
  if (!p) return false;
  const demands = new Map(outcome.demands.map(d => [d.id, d]));
  const positions = together.map(s => ({ option: s, demand: demands.get(s.instanceId),
    availability: p.body.availability.find(a => a.id === s.availabilityId) }));
  if (positions.some(s => !s.demand || !s.availability)) return false;
  for (const position of positions) {
    if (!position.demand || !position.availability) return false;
    const at = Date.parse(position.demand.startAt), unit = position.demand.quantity.unit;
    const active = positions.filter(s => s.demand && s.availability && s.demand.quantity.unit === unit
      && Date.parse(s.demand.startAt) <= at && Date.parse(s.demand.endAt) > at);
    const load = active.reduce((sum, s) => sum + decimal(s.demand!.quantity.value), 0n);
    if (active.some(s => load > decimal(s.availability!.capacity.value))) return false;
  }
  return true;
}

/** Construct from original service obligations. No effects, fabricated contacts,
 * physical observations, authority grants or completion records are produced. */
export function compileServiceProgram(
  original: OutcomeContract, sources: ProviderOriginal[], identity: CompilationIdentity, now: number,
): RealWorldServiceProgram {
  const outcome = OutcomeContractSchema.parse(original);
  if (sources.length > W3_BOUNDS.providers || new Set(sources.map(p => p.body.providerId)).size !== sources.length)
    throw Error("W3_PROVIDER_POPULATION_BOUND_OR_DUPLICATE");
  for (const source of sources) ProviderEvidenceSchema.parse(source.body);
  const options: ServiceOption[] = [], originalDigest = hash(outcome);
  let optionBytes = 2;
  for (const demand of outcome.demands) for (const provider of sources)
    for (const option of optionFor(outcome, demand, provider, now, originalDigest)) {
      optionBytes += Buffer.byteLength(canonical(option)) + 1;
      if (optionBytes > W3_BOUNDS.artifactBytes) throw Error("W3_ARTIFACT_BYTE_BOUND");
      options.push(option);
    }
  const candidates = new Map(outcome.demands.map(d => [d.id, options.filter(o => o.instanceId === d.id && o.gaps.length === 0)
    .sort((a, b) => {
      const delta = BigInt(a.total?.minor ?? "0") - BigInt(b.total?.minor ?? "0");
      return delta < 0n ? -1 : delta > 0n ? 1 : canonical(a).localeCompare(canonical(b));
    })]));
  const order = [...outcome.demands].sort((a, b) =>
    (candidates.get(a.id)?.length ?? 0) - (candidates.get(b.id)?.length ?? 0) || a.id.localeCompare(b.id));
  let visited = 0, exhausted = false, solved = false, best: ServiceOption[] = [];
  const chosen: ServiceOption[] = [];
  function search(index: number) {
    if (solved || exhausted) return;
    if (++visited > W3_BOUNDS.searchNodes) { exhausted = true; return }
    if (chosen.length > best.length) best = [...chosen];
    if (index === order.length) { solved = chosen.length === order.length; return }
    const demand = order[index]!;
    for (const option of candidates.get(demand.id) ?? []) {
      if (fits(chosen, option, outcome, sources)) {
        chosen.push(option); search(index + 1); chosen.pop();
        if (solved || exhausted) return;
      }
    }
    search(index + 1);
  }
  search(0);
  const programme: RealWorldServiceProgram = {
    schema: W3_VERSION,
    envelope: {
      scope: outcome.scope, requirements: "FINNOR-POSTZ-W-PRD-1.0.0", schemaVersion: 1,
      originalDigest, originalDeadlineAt: outcome.originalDeadlineAt,
      sourceRefs: sources.map(p => p.ref), ...identity, parentPolicy: outcome.parentPolicy,
      parentAllocation: outcome.parentAllocation, checked: "UNCHECKED", admitted: false,
      productionActive: false, fieldValidated: false, supportedProfile: { sites: 3, calendarDays: 30, instances: 2048 },
    },
    original: outcome,
    instances: outcome.demands.map(d => ({ ...d, originalDigest: hash(d),
      timeZone: outcome.sites.find(s => s.id === d.siteId)!.timeZone })),
    dependencyEdges: outcome.demands.flatMap(d => d.prerequisites.map(prerequisite => ({ prerequisite, dependent: d.id }))),
    options,
    selection: best.map(o => ({ instanceId: o.instanceId, providerId: o.providerId, termsDigest: o.termsDigest,
      availabilityId: o.availabilityId }))
      .sort((a, b) => a.instanceId.localeCompare(b.instanceId)),
    observationRequirements: outcome.demands.flatMap(d => d.criterionIds.map(id => ({
      instanceId: d.id, criterion: outcome.criteria.find(c => c.id === id)!,
    }))),
    search: { disposition: exhausted ? "EXHAUSTED" : solved ? "COMPLETE" : "PARTIAL",
      visited: Math.min(visited, W3_BOUNDS.searchNodes), optimalityClaimed: false },
    gaps: [
      ...outcome.demands.filter(d => !best.some(o => o.instanceId === d.id)).map(d => "NO_CHECKED_CURRENT_PROVISION:" + d.id),
      ...(exhausted ? ["SEARCH_EXHAUSTION_IS_NOT_PHYSICAL_INFEASIBILITY"] : []),
      ...outcome.reservedDecisions.map(d => "RESERVED_DECISION:" + d.id),
      ...sources.filter(p => !p.current).map(p => "PROVIDER_UNAVAILABLE:" + p.body.providerId),
    ],
    assignmentCount: 1,
  };
  if (Buffer.byteLength(canonical(programme)) > W3_BOUNDS.artifactBytes) throw Error("W3_ARTIFACT_BYTE_BOUND");
  return programme;
}

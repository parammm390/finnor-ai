import {
  W3_VERSION, W3_BOUNDS, canonical, hash, OutcomeContractSchema, ServiceProgramSchema, ProviderEvidenceSchema, type OutcomeContract,
  type ProviderOriginal, type RealWorldServiceProgram, type ProgramCheck, type ServiceOption,
} from "./contracts";

/** Independently specified from original obligations in failure-model.md. This
 * checker does not call the compiler, trust its search flags or certify the world. */
export function checkServiceProgram(
  original: OutcomeContract, providerOriginals: ProviderOriginal[], proposed: RealWorldServiceProgram,
  identity: { methodDigest: string; checkerDigest: string; runtimeDigest: string }, now: number,
): ProgramCheck {
  const o = OutcomeContractSchema.parse(original), reasons: string[] = [];
  const parsed = ServiceProgramSchema.safeParse(proposed);
  if (!parsed.success || Buffer.byteLength(canonical(proposed)) > W3_BOUNDS.artifactBytes)
    return { schema: "finnor.service-program-check.v1", disposition: "REJECTED", originalDigest: hash(o),
      candidateDigest: hash(proposed), reasons: ["MALFORMED_OR_UNBOUNDED_CANDIDATE"], checkedInstances: o.demands.length,
      checkedEdges: o.demands.reduce((n, d) => n + d.prerequisites.length, 0),
      physicalDeliveryEstablished: false, admissionGranted: false };
  const candidate = parsed.data;
  for (const provider of providerOriginals) ProviderEvidenceSchema.parse(provider.body);
  const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  const reject = (condition: boolean, reason: string) => { if (condition) reasons.push(reason) };
  const originalDigest = hash(o);
  reject(candidate.schema !== W3_VERSION || candidate.assignmentCount !== 1, "ORIGINAL_ASSIGNMENT_OR_SCHEMA_CHANGED");
  reject(!equal(candidate.original, o) || candidate.envelope.originalDigest !== originalDigest
    || !equal(candidate.envelope.scope, o.scope), "ORIGINAL_CONTRACT_CHANGED");
  reject(candidate.envelope.originalDeadlineAt !== o.originalDeadlineAt
    || !equal(candidate.envelope.parentPolicy, o.parentPolicy)
    || !equal(candidate.envelope.parentAllocation, o.parentAllocation), "PARENT_OR_DEADLINE_REPLACED");
  reject(candidate.envelope.methodDigest !== identity.methodDigest
    || candidate.envelope.checkerDigest !== identity.checkerDigest
    || candidate.envelope.runtimeDigest !== identity.runtimeDigest, "METHOD_CHECKER_RUNTIME_CHANGED");
  reject(candidate.envelope.checked !== "UNCHECKED" || candidate.envelope.admitted !== false
    || candidate.envelope.productionActive !== false || candidate.envelope.fieldValidated !== false,
    "PRODUCER_SELF_VERIFICATION_OR_ADMISSION");
  reject(!equal(candidate.envelope.supportedProfile, { sites: 3, calendarDays: 30, instances: 2048 }),
    "SUPPORTED_PROFILE_CHANGED");
  reject(!equal(candidate.envelope.sourceRefs, providerOriginals.map(p => p.ref)), "SOURCE_POPULATION_CHANGED");
  reject(candidate.instances.length !== o.demands.length
    || new Set(candidate.instances.map(i => i.id)).size !== o.demands.length, "INSTANCE_COVERAGE");
  const instances = new Map(candidate.instances.map(i => [i.id, i]));
  for (const d of o.demands) {
    const instance = instances.get(d.id), timeZone = o.sites.find(s => s.id === d.siteId)?.timeZone;
    reject(!instance || !equal(instance, { ...d, originalDigest: hash(d), timeZone }),
      "ORIGINAL_SITE_DATE_WINDOW_QUANTITY_UNIT:" + d.id);
  }
  const expectedEdges = o.demands.flatMap(d => d.prerequisites.map(prerequisite => ({ prerequisite, dependent: d.id })));
  const edgeKey = (e: { prerequisite: string; dependent: string }) => e.prerequisite + "\0" + e.dependent;
  reject(candidate.dependencyEdges.length > W3_BOUNDS.edges
    || !equal([...candidate.dependencyEdges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b))),
      [...expectedEdges].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)))), "DEPENDENCY_COVERAGE");
  const counts = new Map(o.demands.map(d => [d.id, 0])), next = new Map<string, string[]>();
  for (const e of expectedEdges) {
    counts.set(e.dependent, (counts.get(e.dependent) ?? 0) + 1);
    next.set(e.prerequisite, [...(next.get(e.prerequisite) ?? []), e.dependent]);
  }
  const queue = [...counts].filter(([, degree]) => degree === 0).map(([id]) => id);
  let traversed = 0;
  for (let i = 0; i < queue.length; i++) {
    traversed++;
    for (const id of next.get(queue[i]!) ?? []) {
      const degree = counts.get(id)! - 1; counts.set(id, degree); if (degree === 0) queue.push(id);
    }
  }
  reject(traversed !== o.demands.length, "DEPENDENCY_CYCLE");
  const requirements = o.demands.flatMap(d => d.criterionIds.map(id => ({
    instanceId: d.id, criterion: o.criteria.find(c => c.id === id),
  })));
  reject(!equal(candidate.observationRequirements, requirements), "INDEPENDENT_OBSERVATION_REQUIREMENTS_CHANGED");
  const providers = new Map(providerOriginals.map(p => [p.body.providerId, p]));
  reject(providers.size !== providerOriginals.length || providers.size > W3_BOUNDS.providers, "PROVIDER_POPULATION");
  const q = (value: string) => {
    const [a = "0", b = ""] = value.split("."); return BigInt(a) * 1000000n + BigInt(b.padEnd(6, "0"));
  };
  const expectedOptions: ServiceOption[] = [];
  let optionBytes = 2;
  optionPopulation: for (const d of o.demands) for (const p of providerOriginals) {
    const body = p.body;
    if (p.current !== true || !equal(body.scope, o.scope) || p.authorId !== body.reportingPrincipalId
      || body.classification !== "SERVICE_PROCUREMENT" || body.classificationBasis.length === 0
      || Date.parse(body.evidenceValidUntil) <= now || Date.parse(body.quote.validUntil) <= now) continue;
    const qualifications = o.criteria.filter(c => d.criterionIds.includes(c.id)).flatMap(c => c.qualificationIds);
    if (qualifications.some(id => !body.qualifications.some(cert => cert.id === id
      && Date.parse(cert.validUntil) >= Date.parse(d.endAt) && cert.verifiedByPrincipalId !== body.reportingPrincipalId))) continue;
    const gaps = [...body.quote.unresolvedTerms];
    if (body.quote.perInstanceCosts.some(c => c.amount === null)) gaps.push("MATERIAL_TOTAL_COST_UNIDENTIFIED");
    if (body.quote.perInstanceCosts.some(c => c.amount && c.amount.currency !== o.currency)) gaps.push("QUOTE_CURRENCY_NOT_ORIGINAL_CURRENCY");
    for (const a of body.availability) {
      if (a.siteId !== d.siteId || a.capacity.unit !== d.quantity.unit
        || Date.parse(a.startAt) > Date.parse(d.startAt) || Date.parse(a.endAt) < Date.parse(d.endAt)
        || Date.parse(a.validUntil) < Date.parse(d.endAt) || Date.parse(a.validUntil) <= now
        || q(a.capacity.value) < q(d.quantity.value)) continue;
      const option: ServiceOption = {
        providerId: body.providerId, source: p.ref, provisionKind: body.provisionKind, instanceId: d.id,
        availabilityId: a.id, termsDigest: hash({ original: originalDigest, demand: d, providerId: body.providerId,
          providerSource: p.ref, quote: body.quote, disclosure: o.disclosure }),
        total: gaps.length ? null : { currency: o.currency, minor: body.quote.perInstanceCosts
          .reduce((sum, cost) => sum + BigInt(cost.amount?.minor ?? "0"), 0n).toString() },
        costs: body.quote.perInstanceCosts, gaps,
      };
      optionBytes += Buffer.byteLength(canonical(option)) + 1;
      if (optionBytes > W3_BOUNDS.artifactBytes) {
        reasons.push("ORIGINAL_OPTION_POPULATION_EXCEEDS_ARTIFACT_BOUND");
        break optionPopulation;
      }
      expectedOptions.push(option);
    }
  }
  reject(!equal(candidate.options, expectedOptions), "OPTIONS_OMITTED_OR_UNSUPPORTED");
  reject(new Set(candidate.selection.map(s => s.instanceId)).size !== candidate.selection.length,
    "DUPLICATE_SELECTED_INSTANCE");
  for (const s of candidate.selection) {
    reject(!candidate.options.some(p => p.instanceId === s.instanceId && p.providerId === s.providerId
      && p.termsDigest === s.termsDigest && p.availabilityId === s.availabilityId && p.gaps.length === 0),
      "SELECTED_UNSUPPORTED_TERMS:" + s.instanceId);
  }
  // Independently sweep every provider/unit overlap. Canonical S5 remains the
  // authority for shared capacity beyond this exact programme.
  for (const provider of providerOriginals) {
    const selected = candidate.selection.filter(s => s.providerId === provider.body.providerId);
    for (const point of selected) {
      const demand = o.demands.find(d => d.id === point.instanceId);
      if (!demand) { reasons.push("SELECTED_FOREIGN_INSTANCE"); continue }
      const active = selected.map(s => ({ s, d: o.demands.find(d => d.id === s.instanceId) }))
        .filter((item): item is { s: typeof point; d: OutcomeContract["demands"][number] } =>
          !!item.d && item.d.quantity.unit === demand.quantity.unit
          && Date.parse(item.d.startAt) <= Date.parse(demand.startAt) && Date.parse(item.d.endAt) > Date.parse(demand.startAt));
      const load = active.reduce((sum, item) => sum + q(item.d.quantity.value), 0n);
      for (const item of active) {
        const option = candidate.options.find(p => p.instanceId === item.s.instanceId
          && p.providerId === item.s.providerId && p.termsDigest === item.s.termsDigest
          && p.availabilityId === item.s.availabilityId);
        const availability = provider.body.availability.find(a => a.id === option?.availabilityId);
        reject(!availability || q(availability.capacity.value) < load, "PROVIDER_CAPACITY_OVERLAP:" + item.s.instanceId);
      }
    }
  }
  const missing = o.demands.filter(d => !candidate.selection.some(s => s.instanceId === d.id))
    .map(d => "NO_CHECKED_CURRENT_PROVISION:" + d.id);
  for (const gap of missing) reject(!candidate.gaps.includes(gap), "HIDDEN_INCOMPLETE_SERVICE:" + gap);
  for (const decision of o.reservedDecisions)
    reject(!candidate.gaps.includes("RESERVED_DECISION:" + decision.id), "HIDDEN_RESERVED_DECISION:" + decision.id);
  reject(candidate.search.disposition === "COMPLETE" && missing.length > 0, "FALSE_CONSTRUCTION_COMPLETENESS");
  reject(candidate.search.visited < 1 || candidate.search.visited > W3_BOUNDS.searchNodes
    || candidate.search.optimalityClaimed !== false, "UNSUPPORTED_SEARCH_CLAIM");
  reject(Buffer.byteLength(canonical(candidate)) > W3_BOUNDS.artifactBytes, "ARTIFACT_BYTE_BOUND");
  return {
    schema: "finnor.service-program-check.v1", disposition: reasons.length ? "REJECTED" : "CHECKED_DEVELOPMENT",
    originalDigest, candidateDigest: hash(candidate), reasons: [...new Set(reasons)],
    checkedInstances: o.demands.length, checkedEdges: expectedEdges.length,
    physicalDeliveryEstablished: false, admissionGranted: false,
  };
}

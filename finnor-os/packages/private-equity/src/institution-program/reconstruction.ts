import { decodeInstitutionSources } from "./source-decoder";
import type { OriginalInstitutionEvidence, InstitutionCandidate } from "./checker";
import type { DigitalInstitutionProfile } from "./contracts";

type Observation = Awaited<ReturnType<typeof decodeInstitutionSources>>["observations"][number];
const key = (source: string, record: string) => `${source}/${record}`;
function fields(row: Observation): Record<string, string> {
  return Object.fromEntries(Object.entries(row.fields).map(([name, value]) =>
    [name.replace(/[^a-z0-9]/gi, "").toLowerCase(), value]));
}
function classify(data: Record<string, string>): "entity" | "quantity" | "trigger" | "unknown" {
  const explicit = data.kind?.toLowerCase();
  if (explicit === "entity" || explicit === "quantity" || explicit === "trigger") return explicit;
  if (data.triggerkind || data.xinstitutiontriggerkind) return "trigger";
  if (data.factkey && data.value) return "quantity";
  if (data.registrationid && (data.entitytype || data.xinstitutionentitytype)) return "entity";
  // Descriptive source classes do not imply a normative trigger.
  return "unknown";
}

/** Bounded proposal only. The original-byte checker and canonical owner state
 * decide acceptance. A name or an observed approval-looking event never does. */
export async function proposeInstitutionModel(
  original: OriginalInstitutionEvidence, profile: DigitalInstitutionProfile,
): Promise<InstitutionCandidate> {
  const start = Date.now();
  const decoded = await decodeInstitutionSources(original, profile);
  const { bounds } = profile;
  const unresolved: NonNullable<InstitutionCandidate["unresolved"]> = [];
  const processHypotheses: NonNullable<InstitutionCandidate["processHypotheses"]> = [];
  const mappings: InstitutionCandidate["mappings"] = [], quantities: InstitutionCandidate["quantities"] = [];
  const obligations: InstitutionCandidate["obligations"] = [];
  const byRegistration = new Map<string, typeof original.canonical.entities>();
  for (const entity of original.canonical.entities) {
    const existing = byRegistration.get(entity.registrationId) ?? [];
    existing.push(entity); byRegistration.set(entity.registrationId, existing);
  }
  const claimed: Array<{ row: Observation; data: Record<string, string>; kind: string; ref: string | null }> = [];
  const addUnresolved = (row: Observation, reason: string, alternatives: string[] = []) => {
    if (alternatives.length > bounds.alternativesPerInterpretation
        || unresolved.length >= bounds.unresolvedInterpretations) {
      throw new Error("X1_RECONSTRUCTION_BOUND: unresolved/alternative limit exceeded");
    }
    unresolved.push({ witness: key(row.sourceId, row.objectId), reason, alternatives });
  };
  for (const row of decoded.observations) {
    const data = fields(row), kind = classify(data);
    const registrationId = data.registrationid ?? data.xinstitutionregistrationid ?? "";
    const entityType = data.entitytype ?? data.xinstitutionentitytype ?? "";
    const options = (byRegistration.get(registrationId) ?? [])
      .filter((entity) => entity.institutionId === original.institutionId && (!entityType || entity.entityType === entityType));
    const ref = options.length === 1 ? options[0]!.ref : null;
    if (!ref) {
      addUnresolved(row, options.length > 1 ? "AMBIGUOUS_CANONICAL_IDENTITY" : "CANONICAL_IDENTITY_NOT_ESTABLISHED",
        options.map((entity) => entity.ref));
    }
    if (kind === "entity" && ref) mappings.push({
      sourceId: row.sourceId, recordId: row.objectId, canonicalRef: ref, registrationId });
    if (kind === "quantity") {
      const value = data.value, currency = data.currency, unit = data.unit, period = data.period,
        basis = data.basis, factKey = data.factkey, occurredAt = data.occurredat, availableAt = data.availableat;
      if (ref && value && currency && unit && period && basis && factKey && occurredAt && availableAt) {
        quantities.push({ sourceId: row.sourceId, recordId: row.objectId, canonicalRef: ref,
          registrationId, value, currency, unit, period, basis, factKey, occurredAt, availableAt });
      } else addUnresolved(row, "QUANTITY_UNIT_TIME_OR_ACCOUNTING_CONTEXT_MISSING");
    }
    if (["work_tracking", "approval_records", "email", "calendar"].includes(row.sourceClass)) {
      processHypotheses.push({ witness: key(row.sourceId, row.objectId),
        interpretation: `${row.sourceClass}: observed ${data.state ?? data.subject ?? data.summary ?? "record"}; no inferred rule or permission`,
        normative: false });
    }
    claimed.push({ row, data, kind, ref });
  }
  const contradictions: InstitutionCandidate["contradictions"] = [];
  const values = claimed.filter((item) => item.kind === "quantity");
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
    const a = values[i]!, b = values[j]!;
    if (a.data.registrationid === b.data.registrationid
      && a.data.factkey === b.data.factkey && a.data.currency === b.data.currency
      && a.data.unit === b.data.unit && a.data.period === b.data.period
      && a.data.basis === b.data.basis && a.data.value !== b.data.value) {
      const [left, right] = [key(a.row.sourceId, a.row.objectId), key(b.row.sourceId, b.row.objectId)].sort();
      contradictions.push({ left: left!, right: right!, disposition: "unresolved" });
    }
  }
  for (const item of claimed.filter((record) => record.kind === "trigger" && record.ref)) {
    const triggerKind = item.data.triggerkind ?? item.data.xinstitutiontriggerkind;
    for (const rule of original.mandate.rules.filter((entry) => entry.triggerKind === triggerKind)) {
      obligations.push({ trigger: key(item.row.sourceId, item.row.objectId), subjectRef: item.ref!,
        ruleId: rule.id, deadlineAt: rule.deadlineAt, principalId: rule.principalId,
        operation: rule.operation, materiality: rule.materiality,
        postconditionRef: rule.postconditionRef, observerRef: rule.observerRef });
    }
  }
  for (const gap of decoded.gaps) {
    if (unresolved.length >= bounds.unresolvedInterpretations) throw new Error("X1_RECONSTRUCTION_BOUND: coverage gaps exceed unresolved limit");
    unresolved.push({ witness: gap.sourceId, reason: gap.reason, alternatives: gap.affectedObjectIds });
  }
  const elapsed = Math.ceil((Date.now() - start) / 1000);
  const measured: Record<string, number> = Object.fromEntries(Object.keys(bounds).map((name) => [name, 0]));
  Object.assign(measured, {
    sourceInstances: original.sources.length, observationReferences: decoded.observations.length,
    rawBytes: decoded.rawBytes, objectBytes: Math.max(0, ...original.sources.map((source) =>
      source.rawBase64 ? Buffer.from(source.rawBase64, "base64").length : Buffer.byteLength(source.rawUtf8))),
    tabularRowsPerObject: Math.max(0, ...original.sources.map((source) =>
      decoded.observations.filter((record) => record.sourceId === source.id).length)),
    canonicalReferences: mappings.length + quantities.length, deals: original.canonical.entities.filter((entity) => entity.entityType === "deal").length,
    people: original.canonical.entities.filter((entity) => entity.entityType === "person").length,
    s1AssertionsPerSlice: mappings.length + quantities.length,
    s1SnapshotBytes: Buffer.byteLength(JSON.stringify(original.canonical)),
    derivedObligations: obligations.length, institutionDependencyNodes: decoded.observations.length + original.sources.length,
    institutionDependencyEdges: decoded.observations.length,
    nativePlanNodes: obligations.length, authorizedAcquisitionCalls: decoded.acquisitionCalls,
    alternativesPerInterpretation: Math.max(0, ...unresolved.map((item) => item.alternatives.length)),
    unresolvedInterpretations: unresolved.length, concurrentSourceReads: 1, concurrentCompilerEpisodes: 1,
    initialResponseSeconds: elapsed, episodeWallSeconds: elapsed,
  });
  for (const [name, count] of Object.entries(measured)) {
    if (!Number.isSafeInteger(count) || count > bounds[name as keyof typeof bounds]!) {
      throw new Error(`X1_RECONSTRUCTION_BOUND: ${name}=${count} exceeds frozen ${bounds[name as keyof typeof bounds]}`);
    }
  }
  return { tenantId: original.tenantId, institutionId: original.institutionId,
    workId: original.workId, principalId: original.principalId,
    coverage: original.sources.map((source) => source.id), mappings, quantities,
    contradictions, obligations, dependencies: { ...original.current }, limits: measured,
    unresolved, processHypotheses, receipt: null };
}

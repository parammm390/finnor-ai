import { decodeInstitutionSources } from "./source-decoder";
import type { OriginalInstitutionEvidence, InstitutionCandidate } from "./checker";
import type { DigitalInstitutionProfile } from "./contracts";

type Observation = Awaited<ReturnType<typeof decodeInstitutionSources>>["observations"][number];
const key = (source: string, record: string) => `${source}/${record}`;
const equalAmount = (a: string | undefined, b: string | undefined): boolean => {
  if (!a || !b || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(a) || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(b)
      || a.length > 128 || b.length > 128) return false;
  const scale = Math.max((a.split(".")[1] ?? "").length, (b.split(".")[1] ?? "").length);
  const units = (value: string) => BigInt(value.replace(".", "")) * 10n ** BigInt(scale - (value.split(".")[1] ?? "").length);
  return units(a) === units(b);
};
function fields(row: Observation): Record<string, string> {
  return Object.fromEntries(Object.entries(row.fields).map(([name, value]) =>
    [name.replace(/[^a-z0-9]/gi, "").toLowerCase(), value]));
}
function classify(data: Record<string, string>): "entity" | "quantity" | "trigger" | "unknown" {
  const explicit = data.kind?.toLowerCase();
  if (explicit === "entity" || explicit === "quantity" || explicit === "trigger") return explicit;
  if (data.triggerkind || data.xinstitutiontriggerkind) return "trigger";
  if (data.factkey && data.value) return "quantity";
  if ((data.registrationid || data.xinstitutionregistrationid)
      && (data.entitytype || data.xinstitutionentitytype)) return "entity";
  // Descriptive source classes do not imply a normative trigger.
  return "unknown";
}
function interpret(row: Observation, data: Record<string, string>) {
  const control = classify(data);
  if (control !== "unknown") return {
    kind: control, registrationId: data.registrationid ?? data.xinstitutionregistrationid ?? "",
    entityType: data.entitytype ?? data.xinstitutionentitytype ?? "",
    triggerKind: data.triggerkind ?? data.xinstitutiontriggerkind,
    value: data.value, currency: data.currency, unit: data.unit, period: data.period,
    basis: data.basis, factKey: data.factkey, occurredAt: data.occurredat,
    availableAt: data.availableat, relationTarget: undefined as string | undefined,
    effectiveFrom: undefined as string | undefined,
    vehicleType: undefined as string | undefined,
  };
  const registrationId = data.vehiclenumber ?? data.fundnumber
    ?? data.dealnumber ?? data.opportunitynumber ?? data.employeenumber ?? "";
  const entityType = row.sourceClass === "crm_deals"
    ? data.fundnumber && !data.vehiclenumber ? "fund" : data.vehiclenumber ? "vehicle" : "deal"
    : row.sourceClass === "personnel_benefits" ? "person" : "";
  const triggerKind = row.sourceClass === "work_tracking"
    && /^\s*evidence[\s_-]+request[\s_-]+needed\s*[.!]?\s*$/i.test(data.activity ?? data.subject ?? "")
    ? "evidence_request_needed" : undefined;
  const value = data.amount ?? data.balance ?? (row.sourceClass === "lender_portal" ? data.outstanding : undefined);
  const kind = triggerKind ? "trigger"
    : value && ["financial_ledger", "expense_administration", "lender_portal"].includes(row.sourceClass) ? "quantity"
      : entityType && registrationId ? "entity" : "unknown";
  return {
    kind, registrationId, entityType, triggerKind, value, currency: data.currency,
    unit: data.unit, period: data.period, basis: data.accountingbasis ?? data.basis,
    factKey: (data.account ?? data.description ?? (row.sourceClass === "lender_portal" ? "outstanding" : undefined))
      ?.toLowerCase().replace(/\s+/g, "_"),
    occurredAt: data.postedat ?? data.createdat ?? data.asof ?? data.occurredat,
    availableAt: data.availableat,
    effectiveFrom: data.effectivefrom,
    vehicleType: data.vehicletype,
    relationTarget: row.sourceClass === "crm_deals"
      ? data.vehiclenumber ? data.fundnumber : data.counterpartynumber : undefined,
  };
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
  const relations: NonNullable<InstitutionCandidate["relations"]> = [];
  const temporalLinks: NonNullable<InstitutionCandidate["temporalLinks"]> = [];
  const obligations: InstitutionCandidate["obligations"] = [];
  const byRegistration = new Map<string, typeof original.canonical.entities>();
  for (const entity of original.canonical.entities) {
    const existing = byRegistration.get(entity.registrationId) ?? [];
    existing.push(entity); byRegistration.set(entity.registrationId, existing);
  }
  const claimed: Array<{ row: Observation; data: ReturnType<typeof interpret>; kind: string; ref: string | null }> = [];
  const addUnresolved = (row: Observation, reason: string, alternatives: string[] = []) => {
    if (alternatives.length > bounds.alternativesPerInterpretation
        || unresolved.length >= bounds.unresolvedInterpretations) {
      throw new Error("X1_RECONSTRUCTION_BOUND: unresolved/alternative limit exceeded");
    }
    const existing = unresolved.find((item) => item.sourceId === row.sourceId && item.recordId === row.objectId);
    if (existing) {
      existing.reason += `;${reason}`;
      existing.alternatives = [...new Set([...existing.alternatives, ...alternatives])];
      if (existing.alternatives.length > bounds.alternativesPerInterpretation) throw new Error("X1_RECONSTRUCTION_BOUND: alternatives exceeded");
    } else unresolved.push({ witness: key(row.sourceId, row.objectId),
      sourceId: row.sourceId, recordId: row.objectId, reason, alternatives });
  };
  for (const row of decoded.observations) {
    const raw = fields(row), data = interpret(row, raw), { kind, registrationId, entityType } = data;
    if (row.sourceClass === "calendar" && kind === "unknown") {
      const instant = (value: string | undefined): string | null => {
        if (!value || !/^\d{8}T\d{6}Z$/.test(value)) return null;
        const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.000Z`;
        return Number.isFinite(Date.parse(iso)) && new Date(iso).toISOString() === iso ? iso : null;
      };
      const startsAt = instant(raw.dtstart), endsAt = instant(raw.dtend);
      if (startsAt && endsAt && startsAt < endsAt) temporalLinks.push({
        sourceId: row.sourceId, recordId: row.objectId, startsAt, endsAt, kind: "scheduled",
      });
      else addUnresolved(row, "CALENDAR_TIMEZONE_OR_CHRONOLOGY_UNRESOLVED");
    }
    const options = (byRegistration.get(registrationId) ?? [])
      .filter((entity) => entity.institutionId === original.institutionId && (!entityType || entity.entityType === entityType)
        &&(!entity.sourceId||entity.sourceId===row.sourceId));
    const ref = options.length === 1 ? options[0]!.ref : null;
    if (!ref && (registrationId || kind !== "unknown")) {
      addUnresolved(row, options.length > 1 ? "AMBIGUOUS_CANONICAL_IDENTITY" : "CANONICAL_IDENTITY_NOT_ESTABLISHED",
        options.map((entity) => entity.ref));
    }
    if (kind === "entity" && ref) mappings.push({
      sourceId: row.sourceId, recordId: row.objectId, canonicalRef: ref, registrationId });
    if (data.relationTarget && ref) {
      const related = (byRegistration.get(data.relationTarget) ?? [])
        .filter((entity) => entity.institutionId === original.institutionId
          &&(!entity.sourceId||entity.sourceId===row.sourceId)
          && entity.entityType === (data.entityType === "vehicle" ? "fund" : "counterparty"));
      if (related.length === 1 && (data.entityType !== "vehicle"
          || data.effectiveFrom && Number.isFinite(Date.parse(data.effectiveFrom))
            && data.effectiveFrom <= original.knowledgeCut
            && ["feeder", "main"].includes(data.vehicleType ?? ""))) {
        relations.push({ sourceId: row.sourceId, recordId: row.objectId,
          canonicalRef: ref, registrationId, relation: data.entityType === "vehicle" ? "fund_vehicle" : "counterparty",
          targetRef: related[0]!.ref, targetRegistrationId: data.relationTarget,
          ...(data.entityType === "vehicle" ? { validFrom: data.effectiveFrom } : {}) });
      } else if (related.length === 1) addUnresolved(row, "FUND_VEHICLE_VALID_FROM_MISSING", related.map((item) => item.ref));
      else addUnresolved(row, "CROSS_REFERENCE_IDENTITY_NOT_ESTABLISHED", related.map((item) => item.ref));
    }
    if (kind === "quantity") {
      const { value, currency, unit, period, basis, factKey, occurredAt, availableAt } = data;
      if (ref && value && currency && unit && period && basis && factKey && occurredAt && availableAt) {
        quantities.push({ sourceId: row.sourceId, recordId: row.objectId, canonicalRef: ref,
          registrationId, value, currency, unit, period, basis, factKey, occurredAt, availableAt });
      } else {
        const missing = Object.entries({ value, currency, unit, period, basis, factKey, occurredAt, availableAt })
          .filter(([, entry]) => !entry).map(([name]) => name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase());
        addUnresolved(row, `QUANTITY_${missing.join("_") || "IDENTITY"}_MISSING`,
          options.map((entity) => entity.ref));
      }
    }
    if (kind === "unknown") {
      const narrative = [raw.subject, raw.summary, raw.body, raw.content, raw.description]
        .filter((item): item is string => !!item).join("\n");
      const mentioned = original.canonical.entities.filter((entity) =>
        entity.institutionId === original.institutionId
          &&(!entity.sourceId||entity.sourceId===row.sourceId)
          && entity.registrationId.length >= 3 && narrative.includes(entity.registrationId))
        .map((entity) => entity.ref);
      addUnresolved(row, "DESCRIPTIVE_CROSS_REFERENCE_NOT_IDENTITY_OR_NORM",
        [...new Set([...(ref ? [ref] : []), ...mentioned])]);
    }
    if (["work_tracking", "approval_records", "email", "calendar", "document_dms"].includes(row.sourceClass)) {
      const participants = [raw.from, raw.to, raw.organizer, raw.attendee].filter(Boolean).join(" → ");
      processHypotheses.push({ witness: key(row.sourceId, row.objectId),
        sourceId: row.sourceId, recordId: row.objectId,
        interpretation: `${row.sourceClass}: observed ${(raw.state ?? raw.subject ?? raw.summary ?? raw.status ?? "record").slice(0, 256)}`
          + `${participants ? `; participants ${participants.slice(0, 256)}` : ""}; no inferred rule or permission`,
        normative: false });
    }
    claimed.push({ row, data, kind, ref });
  }
  const contradictions: InstitutionCandidate["contradictions"] = [];
  const values = claimed.filter((item) => item.kind === "quantity");
  const accounting = new Map<string, { context: string[]; roles: Set<string>;
    recordRefs: { sourceId: string; recordId: string }[] }>();
  for (const item of values) {
    const data = fields(item.row), id = data.accountingrelationid, role = data.balancerole;
    if (!id || !role) continue;
    const context = [id,item.data.registrationId,item.data.factKey ?? "",item.data.currency ?? "",
      item.data.unit ?? "",item.data.period ?? "",item.data.basis ?? ""];
    const key = JSON.stringify(context);
    const entry = accounting.get(key) ?? { context, roles: new Set<string>(),
      recordRefs: [] as { sourceId: string; recordId: string }[] };
    entry.roles.add(role);
    entry.recordRefs.push({ sourceId: item.row.sourceId, recordId: item.row.objectId });
    accounting.set(key, entry);
  }
  for (const { context, roles, recordRefs } of accounting.values()) {
    const missing = ["opening", "movement", "closing"].filter((role) => !roles.has(role));
    if (missing.length) {
      if (unresolved.length >= bounds.unresolvedInterpretations) throw new Error("X1_RECONSTRUCTION_BOUND: accounting gaps");
      unresolved.push({ witness: `accounting:${context[0]}`, accountingContext: context, recordRefs,
        reason: `ACCOUNTING_${missing.join("_")}_MISSING`, alternatives: [] });
    }
  }
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) {
    const a = values[i]!, b = values[j]!;
    if (a.data.registrationId === b.data.registrationId
      && a.data.factKey === b.data.factKey && a.data.currency === b.data.currency
      && a.data.unit === b.data.unit && a.data.period === b.data.period
      && a.data.basis === b.data.basis
      && !fields(a.row).transactionid && !fields(b.row).transactionid
      && !fields(a.row).balancerole && !fields(b.row).balancerole
      && !equalAmount(a.data.value, b.data.value)) {
      const [left, right] = [key(a.row.sourceId, a.row.objectId), key(b.row.sourceId, b.row.objectId)].sort();
      contradictions.push({ left: left!, right: right!,
        leftRef: { sourceId: a.row.sourceId, recordId: a.row.objectId },
        rightRef: { sourceId: b.row.sourceId, recordId: b.row.objectId }, disposition: "unresolved" });
    }
  }
  for (const item of claimed.filter((record) => record.kind === "trigger" && record.ref)) {
    const triggerKind = item.data.triggerKind;
    for (const rule of original.mandate.rules.filter((entry) => entry.triggerKind === triggerKind)) {
      obligations.push({ trigger: key(item.row.sourceId, item.row.objectId),
        sourceId: item.row.sourceId, recordId: item.row.objectId, subjectRef: item.ref!,
        occurredAt: item.data.occurredAt!, availableAt: item.data.availableAt!,
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
  const measured: InstitutionCandidate["limits"] = Object.fromEntries(Object.keys(bounds).map((name) => [name, null]));
  Object.assign(measured, {
    sourceInstances: original.sources.length, observationReferences: decoded.observations.length,
    rawBytes: decoded.rawBytes, objectBytes: Math.max(0, ...original.sources.map((source) =>
      source.rawBase64 ? Buffer.from(source.rawBase64, "base64").length : Buffer.byteLength(source.rawUtf8))),
    tabularRowsPerObject: Math.max(0, ...original.sources.map((source) =>
      decoded.observations.filter((record) => record.sourceId === source.id).length)),
    canonicalReferences: mappings.length + quantities.length + relations.length, deals: original.canonical.entities.filter((entity) => entity.entityType === "deal").length,
    people: original.canonical.entities.filter((entity) => entity.entityType === "person").length,
    s1AssertionsPerSlice: mappings.length + quantities.length + relations.length,
    s1SnapshotBytes: Buffer.byteLength(JSON.stringify(original.canonical)),
    derivedObligations: obligations.length,
    alternativesPerInterpretation: Math.max(0, ...unresolved.map((item) => item.alternatives.length)),
    unresolvedInterpretations: unresolved.length,
    initialResponseSeconds: elapsed, episodeWallSeconds: elapsed,
  });
  for (const [name, count] of Object.entries(measured)) {
    if (count !== null && (!Number.isSafeInteger(count) || count > bounds[name as keyof typeof bounds]!)) {
      throw new Error(`X1_RECONSTRUCTION_BOUND: ${name}=${count} exceeds frozen ${bounds[name as keyof typeof bounds]}`);
    }
  }
  return { tenantId: original.tenantId, institutionId: original.institutionId,
    workId: original.workId, principalId: original.principalId,
    coverage: original.sources.map((source) => source.id), mappings, quantities, relations, temporalLinks,
    contradictions, obligations, dependencies: { ...original.current }, limits: measured,
    unresolved, processHypotheses, receipt: null };
}

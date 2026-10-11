import { createHash } from "node:crypto";
import type { DigitalInstitutionProfile } from "./contracts";
import { originalRawRecords } from "./checker-raw";

type Source = {
  id: string; revision: string; sourceClass: string; protocol: string;
  tenantId: string; institutionId: string; authorizedPrincipalIds: string[];
  rightsRevision: string; rawUtf8: string;
  rawBase64?: string;
  integrationId?: string; provider?: string; sourceScope?: string; externalObjectType?: string;
  sensitiveConsentRef?: string;
  coverage: { expectedObjectIds: string[]; readObjectIds: string[]; complete: boolean };
};
type RawRecord = {
  id: string; kind: string; registrationId?: string; entityType?: string;
  factKey?: string; value?: string; currency?: string; unit?: string; period?: string; basis?: string;
  occurredAt?: string; availableAt?: string; triggerKind?: string;
};
type Rule = {
  id: string; triggerKind: string; operation: string; principalId: string;
  deadlineAt: string; materiality: string; postconditionRef: string; observerRef: string;
};
export type OriginalInstitutionEvidence = {
  tenantId: string; institutionId: string; workId: string; principalId: string; knowledgeCut: string;
  sources: Source[];
  mandate: { id: string; revision: string; tenantId: string; institutionId: string; workId: string; rules: Rule[] };
  canonical: { tenantId: string; revision: string; entities: { ref: string; entityType: string; registrationId: string; institutionId: string }[] };
  current: {
    sourceRevisions: Record<string, string>; mandateRevision: string; canonicalRevision: string;
    rightsRevision: string; resourceRevision: string; methodRevision: string; operationRevision: string;
    checkerRevision: string; profileRevision: number; schemaRevision: string; runtimeRevision: string;
    authorizedOperations: string[];
  };
};
type Mapping = { sourceId: string; recordId: string; canonicalRef: string; registrationId: string };
type Quantity = Mapping & {
  factKey: string; value: string; currency: string; unit: string; period: string; basis: string;
  occurredAt: string; availableAt: string;
};
type Obligation = {
  trigger: string; subjectRef: string; ruleId: string; deadlineAt: string; principalId: string;
  operation: string; materiality: string; postconditionRef: string; observerRef: string;
};
export type InstitutionCandidate = {
  tenantId: string; institutionId: string; workId: string; principalId: string;
  coverage: string[];
  mappings: Mapping[]; quantities: Quantity[];
  contradictions: { left: string; right: string; disposition: "unresolved" | "superseded" }[];
  obligations: Obligation[];
  dependencies: Record<string, unknown> & { sourceRevisions: Record<string, string> };
  limits: Record<string, number>;
  unresolved?: { witness: string; reason: string; alternatives: string[] }[];
  processHypotheses?: { witness: string; interpretation: string; normative: false }[];
  /** A producer cannot provide its own independently accepted check. */
  receipt: unknown;
};
export type CheckGuard =
  | "SOURCE_AUTHORITY" | "BOUND" | "COVERAGE" | "IDENTITY" | "CHRONOLOGY"
  | "QUANTITY" | "CONTRADICTION" | "CURRENTNESS" | "RULE" | "AUTHORITY"
  | "OBLIGATION" | "OMISSION" | "CHECK_AUTHENTICITY";
export type InstitutionCheck =
  | { disposition: "REJECTED"; guard: CheckGuard; witness: string; affectedRefs: string[] }
  | { disposition: "ACCEPTED_DEVELOPMENT"; checkerRevision: string; inputDigest: string; candidateDigest: string;
      profileDigest: string; mappingDenominator: number; obligationDenominator: number; basis: "ORIGINAL_SOURCE_MODEL_RELATIVE" };

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (guard: CheckGuard, witness: string, affectedRefs: string[] = []): InstitutionCheck =>
  ({ disposition: "REJECTED", guard, witness, affectedRefs });
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const iso = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

// Decimal comparison uses integer coefficients, not binary floating point or coercion.
function decimal(value: unknown): { coefficient: bigint; scale: number } | null {
  if (typeof value !== "string" || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const [whole, fractional = ""] = value.split(".");
  return { coefficient: BigInt(whole + fractional), scale: fractional.length };
}
function equalDecimal(a: unknown, b: unknown): boolean {
  const left = decimal(a), right = decimal(b);
  if (!left || !right) return false;
  const scale = Math.max(left.scale, right.scale);
  return left.coefficient * 10n ** BigInt(scale - left.scale)
    === right.coefficient * 10n ** BigInt(scale - right.scale);
}
function unique(items: string[]): boolean { return new Set(items).size === items.length; }
function recordKey(sourceId: string, recordId: string): string { return `${sourceId}/${recordId}`; }

/**
 * Separate, bounded original-evidence evaluator. It deliberately imports no
 * candidate hypothesis, producer mapping or rule-selection implementation.
 * Supplied mandate rules are normative; raw event records alone are not.
 */
export async function independentlyCheckInstitutionModel(
  original: OriginalInstitutionEvidence,
  candidate: InstitutionCandidate,
  profile: DigitalInstitutionProfile,
): Promise<InstitutionCheck> {
  if (!original || !candidate || !profile || !Array.isArray(original.sources)
      || !Array.isArray(candidate.coverage) || !Array.isArray(candidate.mappings)
      || !Array.isArray(candidate.quantities) || !Array.isArray(candidate.obligations)
      || !Array.isArray(candidate.contradictions) || !candidate.dependencies || !candidate.limits) {
    return fail("COVERAGE", "Incomplete original/candidate structure");
  }
  const { mandate, canonical, current } = original;
  if (!mandate || !canonical || !current
      || candidate.tenantId !== original.tenantId || candidate.institutionId !== original.institutionId
      || candidate.workId !== original.workId || candidate.principalId !== original.principalId
      || mandate.tenantId !== original.tenantId || mandate.institutionId !== original.institutionId
      || mandate.workId !== original.workId || canonical.tenantId !== original.tenantId
      || !iso(original.knowledgeCut)) {
    return fail("SOURCE_AUTHORITY", "Tenant, institution, Work, principal or mandate binding differs");
  }
  if (original.sources.some((source) => !source || typeof source.id !== "string"
        || typeof source.rawUtf8 !== "string" || !source.coverage
        || !Array.isArray(source.coverage.expectedObjectIds) || !Array.isArray(source.coverage.readObjectIds)
        || !Array.isArray(source.authorizedPrincipalIds)
        || source.tenantId !== original.tenantId
        || source.institutionId !== original.institutionId || !source.authorizedPrincipalIds.includes(original.principalId)
        || source.rightsRevision !== current.rightsRevision
        || (["personnel_benefits", "expense_administration"].includes(source.sourceClass)
          && !source.sensitiveConsentRef))
      || !unique(original.sources.map((source) => source.id))) {
    return fail("SOURCE_AUTHORITY", "Original source access or scope is not current");
  }
  const bounds: Record<string, number> = profile.bounds;
  const boundKeys = Object.keys(bounds);
  if (boundKeys.some((key) => !Number.isSafeInteger(candidate.limits[key]) || candidate.limits[key]! < 0
        || candidate.limits[key]! > bounds[key]!)
      || original.sources.length > profile.bounds.sourceInstances
      || original.sources.reduce((sum, source) => sum + (source.rawBase64
        ? Buffer.from(source.rawBase64, "base64").length : Buffer.byteLength(source.rawUtf8 ?? "")), 0) > profile.bounds.rawBytes
      || original.sources.some((source) => (source.rawBase64
        ? Buffer.from(source.rawBase64, "base64").length : Buffer.byteLength(source.rawUtf8 ?? "")) > profile.bounds.objectBytes)
      || candidate.obligations.length > profile.bounds.derivedObligations) {
    return fail("BOUND", "A frozen profile bound is exceeded or a measured count is invalid");
  }
  const sourceIds = original.sources.map((source) => source.id);
  if (!unique(candidate.coverage) || !same([...candidate.coverage].sort(), [...sourceIds].sort())) {
    return fail("COVERAGE", "A declared original source is missing or duplicated", sourceIds);
  }
  const records = new Map<string, { source: Source; record: RawRecord }>();
  for (const source of original.sources) {
    const declared = profile.sourceClasses.find((entry) => entry.id === source.sourceClass);
    if (!declared || !declared.protocols.includes(source.protocol)) {
      return fail("COVERAGE", `No independent raw decoder for ${source.id}/${source.protocol}`, [source.id]);
    }
    let rows: RawRecord[];
    try {
      rows = await originalRawRecords(source, profile.bounds.tabularRowsPerObject, profile.bounds.objectBytes);
    } catch (error) {
      return fail("COVERAGE", `Invalid or unsupported original ${source.id}: ${error instanceof Error ? error.message : "parse failure"}`, [source.id]);
    }
    if (!source.coverage.complete || !unique(source.coverage.expectedObjectIds)
        || !unique(source.coverage.readObjectIds)
        || !same([...source.coverage.expectedObjectIds].sort(), [...source.coverage.readObjectIds].sort())
        || !same([...source.coverage.readObjectIds].sort(), rows.map((row) => row.id).sort())
        || rows.some((row) => records.has(recordKey(source.id, row.id)))) {
      return fail("COVERAGE", `Missing, duplicate or unaccounted original object in ${source.id}`, [source.id]);
    }
    for (const row of rows) records.set(recordKey(source.id, row.id), { source, record: row });
  }
  if (records.size > profile.bounds.observationReferences) return fail("BOUND", "Observation population exceeds frozen bound");
  if (candidate.limits.sourceInstances! < original.sources.length
      || candidate.limits.observationReferences! < records.size
      || candidate.limits.rawBytes! < original.sources.reduce((sum, source) => sum + (source.rawBase64
        ? Buffer.from(source.rawBase64, "base64").length : Buffer.byteLength(source.rawUtf8)), 0)
      || candidate.limits.authorizedAcquisitionCalls! < original.sources.length
      || candidate.limits.s1SnapshotBytes! < Buffer.byteLength(JSON.stringify(canonical))
      || canonical.entities.length > profile.bounds.canonicalReferences
      || canonical.entities.filter((entity) => entity.entityType === "deal").length > profile.bounds.deals
      || canonical.entities.filter((entity) => entity.entityType === "person").length > profile.bounds.people) {
    return fail("BOUND", "Original source/owner population or claimed measured usage violates frozen bounds");
  }
  if (candidate.mappings.length > profile.bounds.canonicalReferences
      || candidate.obligations.length > profile.bounds.derivedObligations
      || candidate.mappings.length + candidate.quantities.length > profile.bounds.s1AssertionsPerSlice) {
    return fail("BOUND", "Candidate material population exceeds a frozen profile bound");
  }
  const entities = [...records].filter(([, value]) => value.record.kind === "entity");
  const quantityRows = [...records].filter(([, value]) => value.record.kind === "quantity");
  const triggers = [...records].filter(([, value]) => value.record.kind === "trigger");
  if (records.size !== entities.length + quantityRows.length + triggers.length) {
    return fail("COVERAGE", "An original record kind is not independently interpreted");
  }
  const canonicalByRegistration = new Map<string, typeof canonical.entities>();
  for (const entity of canonical.entities) {
    const matches = canonicalByRegistration.get(entity.registrationId) ?? [];
    matches.push(entity); canonicalByRegistration.set(entity.registrationId, matches);
  }
  const canonicalRef = (registrationId: string | undefined): string | null => {
    const matches = canonicalByRegistration.get(registrationId ?? "") ?? [];
    return matches.length === 1 && matches[0]!.institutionId === original.institutionId ? matches[0]!.ref : null;
  };
  const mapByKey = new Map(candidate.mappings.map((item) => [recordKey(item.sourceId, item.recordId), item]));
  if (mapByKey.size !== candidate.mappings.length) return fail("IDENTITY", "Duplicate candidate mapping");
  for (const [key, { record }] of entities) {
    const proposal = mapByKey.get(key), ref = canonicalRef(record.registrationId);
    if (!ref || !proposal || proposal.registrationId !== record.registrationId || proposal.canonicalRef !== ref
        || record.entityType !== canonical.entities.find((entity) => entity.ref === ref)?.entityType) {
      return fail("IDENTITY", `Original scoped identity does not support ${key}`, [key]);
    }
  }
  if (mapByKey.size !== entities.length) return fail("IDENTITY", "Unsupported or extra material mapping");
  const quantityByKey = new Map(candidate.quantities.map((item) => [recordKey(item.sourceId, item.recordId), item]));
  if (quantityByKey.size !== candidate.quantities.length || quantityByKey.size !== quantityRows.length) {
    return fail("QUANTITY", "Material quantity denominator differs");
  }
  for (const [key, { record }] of quantityRows) {
    const proposal = quantityByKey.get(key), ref = canonicalRef(record.registrationId);
    if (!ref || !proposal || proposal.canonicalRef !== ref || proposal.registrationId !== record.registrationId) {
      return fail("IDENTITY", `Quantity belongs to a different institutional identity ${key}`, [key]);
    }
    if (!iso(record.occurredAt) || !iso(record.availableAt) || !iso(proposal.occurredAt)
        || !iso(proposal.availableAt) || record.availableAt < record.occurredAt
        || proposal.availableAt < proposal.occurredAt || record.availableAt > original.knowledgeCut
        || proposal.occurredAt !== record.occurredAt || proposal.availableAt !== record.availableAt) {
      return fail("CHRONOLOGY", `Occurrence/availability/knowledge conflict ${key}`, [key]);
    }
    if (!equalDecimal(proposal.value, record.value) || proposal.currency !== record.currency
        || proposal.unit !== record.unit || proposal.period !== record.period
        || proposal.basis !== record.basis || proposal.factKey !== record.factKey
        || !proposal.currency || !proposal.unit || !proposal.period || !proposal.basis) {
      return fail("QUANTITY", `Exact original quantity/context conflict ${key}`, [key]);
    }
  }
  const conflictPairs = new Set<string>();
  for (let i = 0; i < quantityRows.length; i++) for (let j = i + 1; j < quantityRows.length; j++) {
    const [aKey, a] = quantityRows[i]!, [bKey, b] = quantityRows[j]!;
    if (a.record.registrationId === b.record.registrationId && a.record.factKey === b.record.factKey
      && a.record.currency === b.record.currency && a.record.unit === b.record.unit
      && a.record.period === b.record.period && a.record.basis === b.record.basis
      && !equalDecimal(a.record.value, b.record.value)) conflictPairs.add([aKey, bKey].sort().join("|"));
  }
  const declaredConflicts = candidate.contradictions.map((entry) => [entry.left, entry.right].sort().join("|"));
  if (!unique(declaredConflicts) || !same([...declaredConflicts].sort(), [...conflictPairs].sort())
      || candidate.contradictions.some((entry) => entry.disposition !== "unresolved")) {
    return fail("CONTRADICTION", "Original competing assertions lack preserved unresolved disposition", [...conflictPairs]);
  }
  if (mandate.revision !== current.mandateRevision || canonical.revision !== current.canonicalRevision
      || profile.revision !== current.profileRevision
      || original.sources.some((source) => source.revision !== current.sourceRevisions[source.id])
      || Object.keys(current.sourceRevisions).length !== original.sources.length
      || !same(candidate.dependencies.sourceRevisions, current.sourceRevisions)
      || Object.keys(current).some((key) => key !== "sourceRevisions" && key !== "authorizedOperations"
        && candidate.dependencies[key] !== (current as unknown as Record<string, unknown>)[key])) {
    return fail("CURRENTNESS", "Checker/source/mandate/owner/runtime dependency revision is stale");
  }
  const obligations = new Map(candidate.obligations.map((item) => [`${item.trigger}#${item.ruleId}`, item]));
  if (obligations.size !== candidate.obligations.length) return fail("OBLIGATION", "Duplicate trigger obligation");
  const expected = new Map<string, Obligation>();
  for (const [key, { record }] of triggers) {
    if (!iso(record.occurredAt) || !iso(record.availableAt) || record.availableAt < record.occurredAt
        || record.availableAt > original.knowledgeCut) return fail("CHRONOLOGY", `Trigger not available ${key}`, [key]);
    const ref = canonicalRef(record.registrationId);
    if (!ref) return fail("IDENTITY", `Trigger identity unresolved ${key}`, [key]);
    for (const rule of mandate.rules.filter((entry) => entry.triggerKind === record.triggerKind)) {
      if (!iso(rule.deadlineAt) || rule.deadlineAt < record.occurredAt) {
        return fail("CHRONOLOGY", `Mandate deadline precedes trigger ${key}`, [key]);
      }
      const obligationKey = `${key}#${rule.id}`;
      expected.set(obligationKey, { trigger: key, subjectRef: ref, ruleId: rule.id,
        deadlineAt: rule.deadlineAt, principalId: rule.principalId, operation: rule.operation,
        materiality: rule.materiality, postconditionRef: rule.postconditionRef, observerRef: rule.observerRef });
    }
  }
  for (const actual of candidate.obligations) {
    const trigger = records.get(actual.trigger)?.record;
    const matchingRules = mandate.rules.filter((rule) => rule.triggerKind === trigger?.triggerKind);
    if (!matchingRules.some((rule) => rule.id === actual.ruleId)) return fail("RULE", `No current explicit normative rule for ${actual.trigger}`, [actual.trigger]);
    if (!current.authorizedOperations.includes(actual.operation)
      || !profile.ordinaryOperations.includes(actual.operation)) return fail("AUTHORITY", `Operation is not currently authorized: ${actual.operation}`, [actual.trigger]);
    const basis = expected.get(`${actual.trigger}#${actual.ruleId}`);
    if (!basis || !same(actual, basis)) return fail("OBLIGATION", `Mandate trigger/principal/deadline/postcondition differs ${actual.trigger}`, [actual.trigger]);
  }
  if (candidate.obligations.length !== expected.size
      || [...expected.keys()].some((key) => !obligations.has(key))) {
    return fail("OMISSION", "Independent mandate/source denominator includes omitted duties", [...expected.keys()]);
  }
  if (candidate.receipt !== null) return fail("CHECK_AUTHENTICITY", "A producer-supplied independent receipt is not trusted");
  return {
    disposition: "ACCEPTED_DEVELOPMENT", checkerRevision: current.checkerRevision,
    inputDigest: digest(original), candidateDigest: digest(candidate), profileDigest: digest(profile),
    mappingDenominator: entities.length, obligationDenominator: expected.size,
    basis: "ORIGINAL_SOURCE_MODEL_RELATIVE",
  };
}

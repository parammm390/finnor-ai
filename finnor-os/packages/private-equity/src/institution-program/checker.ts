import { createHash } from "node:crypto";
import type { DigitalInstitutionProfile } from "./contracts";
import { originalRawRecords } from "./checker-raw";
import { institutionOwnerCutDigest,canonicalInstitutionJson } from "./canonical-json";

type Source = {
  id: string; revision: string; sourceClass: string; protocol: string;
  tenantId: string; institutionId: string; authorizedPrincipalIds: string[];
  rightsRevision: string; rawUtf8: string;
  rawBase64?: string;
  integrationId?: string; provider?: string; sourceScope?: string; externalObjectType?: string;
  sensitiveConsentRef?: string;
  ownerCoverageGap?: SourceCoverageGap;
  sourceScopePin?: {grantId:string;digest:string;originalReadAllowed:boolean};
  coverage: { expectedObjectIds: string[]; readObjectIds: string[]; complete: boolean };
};
export type SourceCoverageGap = {sourceId:string;grantId:string;reason:string;scopeDigest:string;expectedObjectCount:number};
type RawRecord = {
  id: string; kind: string; registrationId?: string; entityType?: string;
  effectiveFrom?: string;
  vehicleType?: string;
  factKey?: string; value?: string; currency?: string; unit?: string; period?: string; basis?: string;
  occurredAt?: string; availableAt?: string; triggerKind?: string;
  relation?: string; relationRegistrationId?: string;
  endsAt?: string;
  narrative?: string;
  observationKind?: string; balanceRole?: string; accountingRelationId?: string;
};
type Rule = {
  id: string; triggerKind: string; operation: string; principalId: string;
  deadlineAt: string; materiality: string; postconditionRef: string; observerRef: string;
};
export type OriginalInstitutionEvidence = {
  tenantId: string; institutionId: string; workId: string; principalId: string; knowledgeCut: string;
  sources: Source[];
  mandate: { id: string; standingId?:string; revision: string; tenantId: string; institutionId: string; workId: string; rules: Rule[] };
  canonical: { tenantId: string; revision: string; entities: { ref: string; entityType: string; registrationId: string; institutionId: string; sourceId?:string; ownerWitness?:Record<string,unknown> }[] };
  current: {
    sourceRevisions: Record<string, string>; mandateRevision: string; canonicalRevision: string;
    rightsRevision: string; resourceRevision: string; methodRevision: string; operationRevision: string;
    checkerRevision: string; profileRevision: number; schemaRevision: string; runtimeRevision: string;
    authorizedOperations: string[];
    sourceDigests?: Record<string, string>;
    sourceScopes?: Array<{grantId:string;digest:string;originalReadAllowed:boolean}>;
    responsiblePrincipals?: Array<{principalId:string;active:boolean;status:string|null;role:string|null}>;
    canonicalOwners?: OriginalInstitutionEvidence["canonical"]["entities"];
    methodCapability?: {schema:'finnor.s8.institution-consumer-binding.v1';
      revisionRef:{owner:string;id:string;version:string;contentDigest:string};
      admissionRef:{owner:string;id:string;version:string;contentDigest:string};
      policyDigest:string;candidateDigest:string;profileDigest:string;runtimeDigest:string;
      protectionDomain:'DISPOSABLE_TEST_AUTHORITY';protectedQualification:false;productionActive:false;executionAuthorityGranted:false};
    sensitiveSubjects?: Array<{sourceId:string;institutionId:string;sourceClass:string;purpose:string;registrations:string[]}>;
  };
};
type Mapping = { sourceId: string; recordId: string; canonicalRef: string; registrationId: string };
type Relation = Mapping & { relation: string; targetRef: string; targetRegistrationId: string; validFrom?: string };
type Quantity = Mapping & {
  factKey: string; value: string; currency: string; unit: string; period: string; basis: string;
  occurredAt: string; availableAt: string;
};
type Obligation = {
  trigger: string; sourceId: string; recordId: string; occurredAt: string; availableAt: string;
  subjectRef: string; ruleId: string; deadlineAt: string; principalId: string;
  operation: string; materiality: string; postconditionRef: string; observerRef: string;
  nonExecutable?:'OUTSIDE_PROFILE'|'CURRENT_AUTHORITY_UNAVAILABLE'|'CURRENT_RESPONSIBLE_PRINCIPAL_UNAVAILABLE';
};
export type InstitutionCandidate = {
  tenantId: string; institutionId: string; workId: string; principalId: string;
  coverage: string[];
  sourceCoverageGaps?: SourceCoverageGap[];
  mappings: Mapping[]; quantities: Quantity[];
  relations?: Relation[];
  temporalLinks?: { sourceId: string; recordId: string; startsAt: string; endsAt: string; kind: "scheduled" }[];
  contradictions: { left: string; right: string; leftRef: { sourceId: string; recordId: string };
    rightRef: { sourceId: string; recordId: string }; disposition: "unresolved" | "superseded" }[];
  obligations: Obligation[];
  dependencies: Record<string, unknown> & { sourceRevisions: Record<string, string> };
  limits: Record<string, number | null>;
  unresolved?: { witness: string; sourceId?: string; recordId?: string;
    accountingContext?: string[]; recordRefs?: { sourceId: string; recordId: string }[];
    reason: string; alternatives: string[] }[];
  processHypotheses?: { witness: string; sourceId: string; recordId: string; interpretation: string; normative: false }[];
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
const same = (left: unknown, right: unknown): boolean => {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, i) => same(item, right[i]));
  }
  const a = left as Record<string, unknown>, b = right as Record<string, unknown>;
  return Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
};
const iso = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

// Decimal comparison uses integer coefficients, not binary floating point or coercion.
function decimal(value: unknown): { coefficient: bigint; scale: number } | null {
  if (typeof value !== "string" || value.length > 128 || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
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
function recordKey(sourceId: string, recordId: string): string { return JSON.stringify([sourceId, recordId]); }
const witness = (sourceId: string, recordId: string): string => `${sourceId}/${recordId}`;
const obligationKey = (sourceId: string, recordId: string, ruleId: string): string =>
  JSON.stringify([sourceId, recordId, ruleId]);
const quantityContext = (item: RawRecord | Quantity): boolean =>
  typeof item.factKey === "string" && item.factKey.length > 0 && item.factKey.length <= 128
  && typeof item.currency === "string" && /^[A-Z]{3}$/.test(item.currency)
  && typeof item.unit === "string" && /^[A-Za-z][\w./ -]{0,63}$/.test(item.unit)
  && typeof item.period === "string" && /^(?:\d{4}-\d{2}|\d{4}-\d{2}-\d{2})$/.test(item.period)
  && typeof item.basis === "string" && item.basis.length > 0 && item.basis.length <= 128;

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
        || source.institutionId !== original.institutionId
        || (!source.ownerCoverageGap&&!source.authorizedPrincipalIds.includes(original.principalId))
        || source.rightsRevision !== current.rightsRevision
        || (["personnel_benefits", "expense_administration"].includes(source.sourceClass)
          && !source.ownerCoverageGap&&!source.sensitiveConsentRef))
      || !unique(original.sources.map((source) => source.id))) {
    return fail("SOURCE_AUTHORITY", "Original source access or scope is not current");
  }
  const bounds: Record<string, number> = profile.bounds;
  const boundKeys = Object.keys(bounds);
  if (boundKeys.some((key) => candidate.limits[key] !== null
        && (!Number.isSafeInteger(candidate.limits[key]) || candidate.limits[key]! < 0
          || candidate.limits[key]! > bounds[key]!))
      || (candidate.unresolved?.length ?? 0) > profile.bounds.unresolvedInterpretations
      || candidate.unresolved?.some((item) => !Array.isArray(item.alternatives)
        || item.alternatives.length > profile.bounds.alternativesPerInterpretation)
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
  const sourceGaps=original.sources.flatMap(source=>source.ownerCoverageGap?[source.ownerCoverageGap]:[]);
  if(!Array.isArray(candidate.sourceCoverageGaps??[])
    ||!unique((candidate.sourceCoverageGaps??[]).map(g=>g.sourceId))
    ||!same([...(candidate.sourceCoverageGaps??[])].sort((a,b)=>a.sourceId.localeCompare(b.sourceId)),
      [...sourceGaps].sort((a,b)=>a.sourceId.localeCompare(b.sourceId))))
    return fail('COVERAGE','Native source coverage gaps were omitted, duplicated or forged');
  for (const source of original.sources) {
    const declared = profile.sourceClasses.find((entry) => entry.id === source.sourceClass);
    if (!declared || !declared.protocols.includes(source.protocol)) {
      return fail("COVERAGE", `No independent raw decoder for ${source.id}/${source.protocol}`, [source.id]);
    }
    if(source.ownerCoverageGap){
      const gap=source.ownerCoverageGap,pin=source.sourceScopePin;
      if(gap.sourceId!==source.id||!gap.grantId||!/^[a-f0-9]{64}$/.test(gap.scopeDigest)
        ||!['SOURCE_GRANT_REVOKED','SOURCE_GRANT_WINDOW_UNAVAILABLE','SUBJECT_SCOPE_NOT_CERTIFIED',
          'SENSITIVE_SUBJECT_CONSENT_OR_IDENTITY_UNAVAILABLE'].includes(gap.reason)
        ||gap.expectedObjectCount!==source.coverage.expectedObjectIds.length
        ||!gap.expectedObjectCount||!unique(source.coverage.expectedObjectIds)
        ||source.coverage.expectedObjectIds.some(id=>typeof id!=='string'||!id)
        ||source.rawUtf8!==''||source.rawBase64!==undefined||source.authorizedPrincipalIds.length!==0
        ||source.coverage.complete!==false||source.coverage.readObjectIds.length!==0
        ||source.sensitiveConsentRef!==undefined||!pin||pin.grantId!==gap.grantId
        ||pin.digest!==gap.scopeDigest||pin.originalReadAllowed!==false
        ||!current.sourceScopes?.some(p=>same(p,pin)))
        return fail('SOURCE_AUTHORITY','Unavailable source lacks its exact native metadata-only refusal',[source.id]);
      continue;
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
  for (const [key, { record }] of records) {
    if ((record.occurredAt && !iso(record.occurredAt))
      || (record.availableAt && (!iso(record.availableAt) || record.availableAt > original.knowledgeCut))) {
      return fail("CHRONOLOGY", `Original occurrence or availability is invalid ${key}`, [key]);
    }
  }
  if (!unique([...records.values()].map(({ source, record }) => witness(source.id, record.id)))) {
    return fail("COVERAGE", "Original object witness is ambiguous across sources");
  }
  if (candidate.processHypotheses?.some((item) =>
    !records.has(recordKey(item.sourceId, item.recordId))
      || item.witness !== witness(item.sourceId, item.recordId))
      || candidate.unresolved?.some((item) => item.sourceId !== undefined
        && (!records.has(recordKey(item.sourceId, item.recordId ?? ""))
          || item.witness !== witness(item.sourceId, item.recordId ?? "")))) {
    return fail("COVERAGE", "Descriptive or unresolved reference lacks a typed original identity");
  }
  if (Buffer.byteLength(JSON.stringify(canonical)) > profile.bounds.s1SnapshotBytes
      || canonical.entities.length > profile.bounds.canonicalReferences
      || canonical.entities.filter((entity) => entity.entityType === "deal").length > profile.bounds.deals
      || new Set(canonical.entities.filter((entity) => entity.entityType === "person").map(e=>e.ref.split("@")[0])).size > profile.bounds.people) {
    return fail("BOUND", "Measured original/owner population violates frozen bounds");
  }
  if(original.current.canonicalOwners && (canonicalInstitutionJson(original.current.canonicalOwners)!==canonicalInstitutionJson(canonical.entities)
    ||institutionOwnerCutDigest(canonical.entities)!==original.current.canonicalRevision))
    return fail("CURRENTNESS","Canonical owner witnesses differ from the recorded cut");
  if (candidate.mappings.length + (candidate.relations?.length ?? 0) > profile.bounds.canonicalReferences
      || candidate.obligations.length > profile.bounds.derivedObligations
      || candidate.mappings.length + candidate.quantities.length + (candidate.relations?.length ?? 0) > profile.bounds.s1AssertionsPerSlice) {
    return fail("BOUND", "Candidate material population exceeds a frozen profile bound");
  }
  const entities = [...records].filter(([, value]) => value.record.kind === "entity");
  const quantityRows = [...records].filter(([, value]) => value.record.kind === "quantity");
  const triggers = [...records].filter(([, value]) => value.record.kind === "trigger");
  const unknowns = [...records].filter(([, value]) => value.record.kind === "unresolved");
  if (records.size !== entities.length + quantityRows.length + triggers.length + unknowns.length) {
    return fail("COVERAGE", "An original record kind is not independently interpreted");
  }
  if (candidate.processHypotheses?.some((item) => item.normative !== false)) {
    return fail("RULE", "Descriptive source history cannot grant normative authority");
  }
  const canonicalByRegistration = new Map<string, typeof canonical.entities>();
  for (const entity of canonical.entities) {
    const matches = canonicalByRegistration.get(entity.registrationId) ?? [];
    matches.push(entity); canonicalByRegistration.set(entity.registrationId, matches);
  }
  const canonicalRef = (registrationId: string | undefined,entityType?:string,sourceId?:string): string | null => {
    const matches = (canonicalByRegistration.get(registrationId ?? "") ?? []).filter(entity=>
      (!entityType||entity.entityType===entityType)&&(!entity.sourceId||entity.sourceId===sourceId));
    return matches.length === 1 && matches[0]!.institutionId === original.institutionId ? matches[0]!.ref : null;
  };
  const unresolvedFor = (sourceId: string, record: RawRecord, options: string[]): InstitutionCheck | null => {
    const key = witness(sourceId, record.id);
    const basis = candidate.unresolved?.find((item) => item.sourceId === sourceId && item.recordId === record.id);
    if (!basis || typeof basis.reason !== "string" || !basis.reason
        || basis.witness !== key || !Array.isArray(basis.alternatives)) return fail("COVERAGE", `Unresolved original omitted ${key}`, [recordKey(sourceId, record.id)]);
    if (options.length > profile.bounds.alternativesPerInterpretation
        || !unique(basis.alternatives) || !same([...basis.alternatives].sort(), [...options].sort())) {
      return fail("IDENTITY", `Original alternatives differ ${key}`, [key]);
    }
    void record;
    return null;
  };
  const optionsFor = (record: RawRecord,sourceId?:string): string[] => canonical.entities.filter((entity) =>
    entity.institutionId === original.institutionId
      &&(!entity.sourceId||entity.sourceId===sourceId)&&(!record.entityType||entity.entityType===record.entityType)
      && (entity.registrationId === record.registrationId
        || (entity.registrationId.length >= 3 && record.narrative?.includes(entity.registrationId))))
    .map((entity) => entity.ref);
  for (const [, { source, record }] of unknowns) {
    const invalid = unresolvedFor(source.id, record, optionsFor(record,source.id));
    if (invalid) return invalid;
  }
  const mapByKey = new Map(candidate.mappings.map((item) => [recordKey(item.sourceId, item.recordId), item]));
  if (mapByKey.size !== candidate.mappings.length) return fail("IDENTITY", "Duplicate candidate mapping");
  for (const [key, { source, record }] of entities) {
    const proposal = mapByKey.get(key), ref = canonicalRef(record.registrationId,record.entityType,source.id);
    if (!ref) {
      const invalid = unresolvedFor(source.id, record, optionsFor(record,source.id));
      if (invalid) return invalid;
      if(record.entityType==='vehicle'&&!record.vehicleType&&optionsFor(record,source.id).length===0
        &&candidate.unresolved?.find(g=>g.sourceId===source.id&&g.recordId===record.id)?.reason
          !=='VEHICLE_TYPE_REQUIRED_FOR_CANONICAL_CREATION')
        return fail('IDENTITY','Missing native Vehicle type requires an exact creation gap',[key]);
      if (proposal) return fail("IDENTITY", `Ambiguous original cannot support mapping ${key}`, [key]);
      continue;
    }
    if (!proposal || recordKey(proposal.sourceId, proposal.recordId) !== key
        || proposal.registrationId !== record.registrationId || proposal.canonicalRef !== ref
        || record.entityType !== canonical.entities.find((entity) => entity.ref === ref)?.entityType) {
      return fail("IDENTITY", `Original scoped identity does not support ${key}`, [key]);
    }
  }
  if (mapByKey.size !== entities.filter(([, { source, record }]) => canonicalRef(record.registrationId,record.entityType,source.id)).length)
    return fail("IDENTITY", "Unsupported or extra material mapping");
  const relationRows = [...records].filter(([, value]) =>
    value.record.relation && value.record.relationRegistrationId
      && canonicalRef(value.record.registrationId,value.record.entityType,value.source.id) && canonicalRef(value.record.relationRegistrationId,value.record.relation==="fund_vehicle"?"fund":"counterparty",value.source.id)
      && (value.record.relation !== "fund_vehicle"
        || (iso(value.record.effectiveFrom) && value.record.effectiveFrom! <= original.knowledgeCut
          && ["feeder", "main"].includes(value.record.vehicleType ?? ""))));
  for (const [, { source, record }] of records) {
    if (!record.relation || !record.relationRegistrationId
        || (canonicalRef(record.relationRegistrationId,record.relation==="fund_vehicle"?"fund":"counterparty",source.id)
          && (record.relation !== "fund_vehicle"
            || (iso(record.effectiveFrom) && record.effectiveFrom! <= original.knowledgeCut
              && ["feeder", "main"].includes(record.vehicleType ?? ""))))) continue;
    const alternatives = canonical.entities.filter((entity) => entity.institutionId === original.institutionId
      &&(!entity.sourceId||entity.sourceId===source.id)
      &&entity.entityType===(record.relation==="fund_vehicle"?"fund":"counterparty")
      && entity.registrationId === record.relationRegistrationId).map((entity) => entity.ref);
    const gap = candidate.unresolved?.find((item) => item.sourceId === source.id && item.recordId === record.id
      && item.witness === witness(source.id, record.id));
    if (!gap || alternatives.length > profile.bounds.alternativesPerInterpretation
        || !same([...alternatives].sort(), [...gap.alternatives].sort())) {
      return fail("IDENTITY", `Cross-reference alternatives differ ${source.id}/${record.id}`);
    }
  }
  const relationByKey = new Map((candidate.relations ?? []).map((item) => [recordKey(item.sourceId, item.recordId), item]));
  if (relationByKey.size !== (candidate.relations ?? []).length || relationByKey.size !== relationRows.length) {
    return fail("IDENTITY", "Material relation denominator differs");
  }
  for (const [key, { source, record }] of relationRows) {
    const proposal = relationByKey.get(key);
    if (!proposal || recordKey(proposal.sourceId, proposal.recordId) !== key
        || proposal.canonicalRef !== canonicalRef(record.registrationId,record.entityType,source.id)
        || proposal.targetRef !== canonicalRef(record.relationRegistrationId,record.relation==="fund_vehicle"?"fund":"counterparty",source.id)
        || proposal.relation !== record.relation
        || proposal.targetRegistrationId !== record.relationRegistrationId
        || (record.relation === "fund_vehicle" && (!iso(record.effectiveFrom)
          || proposal.validFrom !== record.effectiveFrom))) {
      return fail("IDENTITY", `Original cross-reference does not support relation ${key}`, [key]);
    }
  }
  const scheduled = [...records].filter(([, value]) => value.record.endsAt);
  const temporalByKey = new Map((candidate.temporalLinks ?? []).map((item) => [recordKey(item.sourceId, item.recordId), item]));
  if (temporalByKey.size !== (candidate.temporalLinks ?? []).length || temporalByKey.size !== scheduled.length) {
    return fail("CHRONOLOGY", "Scheduled temporal evidence denominator differs");
  }
  for (const [key, { record }] of scheduled) {
    const actual = temporalByKey.get(key);
    if (!actual || recordKey(actual.sourceId, actual.recordId) !== key
      || !iso(record.occurredAt) || !iso(record.endsAt) || record.endsAt <= record.occurredAt
      || !iso(actual.startsAt) || !iso(actual.endsAt)
      || actual.startsAt !== record.occurredAt || actual.endsAt !== record.endsAt
      || actual.kind !== "scheduled") {
      return fail("CHRONOLOGY", `Original scheduled temporal relation differs ${key}`, [key]);
    }
  }
  const quantityByKey = new Map(candidate.quantities.map((item) => [recordKey(item.sourceId, item.recordId), item]));
  if (quantityByKey.size !== candidate.quantities.length) {
    return fail("QUANTITY", "Material quantity denominator differs");
  }
  for (const [key, { source, record }] of quantityRows) {
    const proposal = quantityByKey.get(key), ref = canonicalRef(record.registrationId,record.entityType,source.id);
    if (["factKey", "value", "currency", "unit", "period", "basis", "occurredAt", "availableAt"]
      .some((field) => record[field as keyof RawRecord] !== undefined
        && typeof record[field as keyof RawRecord] !== "string")) {
      return fail("QUANTITY", `Malformed original quantity context ${key}`, [key]);
    }
    if (!ref || !quantityContext(record) || !decimal(record.value)
        || !iso(record.occurredAt) || !iso(record.availableAt)) {
      const invalid = unresolvedFor(source.id, record, optionsFor(record,source.id));
      if (invalid) return invalid;
      if (proposal) return fail("QUANTITY", `Unsupported original quantity proposed as exact ${key}`, [key]);
      continue;
    }
    if (!proposal || recordKey(proposal.sourceId, proposal.recordId) !== key
        || proposal.canonicalRef !== ref || proposal.registrationId !== record.registrationId) {
      return fail("IDENTITY", `Quantity belongs to a different institutional identity ${key}`, [key]);
    }
    if (!iso(record.occurredAt) || !iso(record.availableAt) || !iso(proposal.occurredAt)
        || !iso(proposal.availableAt) || record.availableAt < record.occurredAt
        || proposal.availableAt < proposal.occurredAt || record.availableAt > original.knowledgeCut
        || proposal.occurredAt !== record.occurredAt || proposal.availableAt !== record.availableAt) {
      return fail("CHRONOLOGY", `Occurrence/availability/knowledge conflict ${key}`, [key]);
    }
    if (!quantityContext(record) || !quantityContext(proposal) || !equalDecimal(proposal.value, record.value)
        || proposal.currency !== record.currency
        || proposal.unit !== record.unit || proposal.period !== record.period
        || proposal.basis !== record.basis || proposal.factKey !== record.factKey
        || !proposal.currency || !proposal.unit || !proposal.period || !proposal.basis) {
      return fail("QUANTITY", `Exact original quantity/context conflict ${key}`, [key]);
    }
  }
  if (quantityByKey.size !== quantityRows.filter(([, { source, record }]) =>
    canonicalRef(record.registrationId,record.entityType,source.id) && quantityContext(record) && decimal(record.value)
      && iso(record.occurredAt) && iso(record.availableAt)).length) {
    return fail("QUANTITY", "Supported quantity omitted or unsupported quantity claimed");
  }
  const accountingGroups = new Map<string, Map<string, { sourceId: string; record: RawRecord }>>();
  for (const [key, { source, record }] of quantityRows) {
    if (!record.accountingRelationId && !record.balanceRole) continue;
    if (!record.accountingRelationId || !["opening", "movement", "closing"].includes(record.balanceRole ?? "")
        || !quantityContext(record) || !decimal(record.value)) return fail("QUANTITY", `Invalid accounting relation ${key}`, [key]);
    const group = JSON.stringify([record.accountingRelationId, record.registrationId, record.factKey,
      record.currency, record.unit, record.period, record.basis]);
    const roles = accountingGroups.get(group) ?? new Map<string, { sourceId: string; record: RawRecord }>();
    if (roles.has(record.balanceRole!)) return fail("QUANTITY", `Repeated accounting role ${key}`, [key]);
    roles.set(record.balanceRole!, { sourceId: source.id, record }); accountingGroups.set(group, roles);
  }
  for (const [group, roles] of accountingGroups) {
    if (roles.size !== 3) {
      const [id] = JSON.parse(group) as string[];
      const missing = ["opening", "movement", "closing"].filter((role) => !roles.has(role));
      const context = JSON.parse(group) as string[];
      const refs = [...roles.values()].map(({sourceId,record})=>({sourceId,recordId:record.id}));
      const gap = candidate.unresolved?.find((item) => item.witness === `accounting:${id}`
        && same(item.accountingContext, context)
        && same([...item.recordRefs ?? []].map(ref=>recordKey(ref.sourceId,ref.recordId)).sort(),
          refs.map(ref=>recordKey(ref.sourceId,ref.recordId)).sort()));
      if (!gap || !missing.every((role) => gap.reason.includes(role)) || gap.alternatives.length) {
        return fail("QUANTITY", `Partial accounting relationship not disclosed ${group}`, [group]);
      }
      continue; // Missing equation evidence is unresolved, not an assumed zero.
    }
    const opening = decimal(roles.get("opening")!.record.value)!;
    const movement = decimal(roles.get("movement")!.record.value)!;
    const closing = decimal(roles.get("closing")!.record.value)!;
    const scale = Math.max(opening.scale, movement.scale, closing.scale);
    const units = (item: typeof opening) => item.coefficient * 10n ** BigInt(scale - item.scale);
    if (units(opening) + units(movement) !== units(closing)) return fail("QUANTITY", `Original accounting conservation fails ${group}`, [group]);
  }
  const conflictPairs = new Set<string>();
  for (let i = 0; i < quantityRows.length; i++) for (let j = i + 1; j < quantityRows.length; j++) {
    const [aKey, a] = quantityRows[i]!, [bKey, b] = quantityRows[j]!;
    if (a.record.observationKind !== "transaction" && b.record.observationKind !== "transaction"
      && !a.record.balanceRole && !b.record.balanceRole
      && a.record.registrationId === b.record.registrationId && a.record.factKey === b.record.factKey
      && a.record.currency === b.record.currency && a.record.unit === b.record.unit
      && a.record.period === b.record.period && a.record.basis === b.record.basis
      && !equalDecimal(a.record.value, b.record.value)) conflictPairs.add(JSON.stringify([aKey, bKey].sort()));
  }
  const declaredConflicts = candidate.contradictions.map((entry) =>
    JSON.stringify([recordKey(entry.leftRef?.sourceId ?? "", entry.leftRef?.recordId ?? ""),
      recordKey(entry.rightRef?.sourceId ?? "", entry.rightRef?.recordId ?? "")].sort()));
  if (!unique(declaredConflicts) || !same(declaredConflicts.sort(), [...conflictPairs].sort())
      || candidate.contradictions.some((entry) =>
        entry.left !== witness(entry.leftRef?.sourceId ?? "", entry.leftRef?.recordId ?? "")
          || entry.right !== witness(entry.rightRef?.sourceId ?? "", entry.rightRef?.recordId ?? ""))
      || candidate.contradictions.some((entry) => entry.disposition !== "unresolved")) {
    return fail("CONTRADICTION", "Original competing assertions lack preserved unresolved disposition", [...conflictPairs]);
  }
  if (mandate.revision !== current.mandateRevision || canonical.revision !== current.canonicalRevision
      || profile.revision !== current.profileRevision
      || original.sources.some((source) => source.revision !== current.sourceRevisions[source.id])
      || Object.keys(current.sourceRevisions).length !== original.sources.length
      || !same(candidate.dependencies.sourceRevisions, current.sourceRevisions)
      || (current.sourceDigests && original.sources.some((source) => !source.ownerCoverageGap &&
        current.sourceDigests?.[source.id] !== createHash("sha256").update(source.rawBase64
          ? Buffer.from(source.rawBase64, "base64") : Buffer.from(source.rawUtf8)).digest("hex")))
      || Object.keys(current).some((key) => key !== "sourceRevisions" && key !== "authorizedOperations"
        && !same(candidate.dependencies[key], (current as unknown as Record<string, unknown>)[key]))) {
    return fail("CURRENTNESS", "Checker/source/mandate/owner/runtime dependency revision is stale");
  }
  const obligations = new Map(candidate.obligations.map((item) => [obligationKey(item.sourceId, item.recordId, item.ruleId), item]));
  if(current.responsiblePrincipals){
    const pins=current.responsiblePrincipals;
    if(!Array.isArray(pins)||!unique(pins.map(p=>p.principalId))
      ||!same(pins.map(p=>p.principalId).sort(),[...new Set(mandate.rules.map(r=>r.principalId))].sort())
      ||pins.some(p=>typeof p.active!=='boolean'||p.active!==(p.status==='active')
        ||p.status!==null&&typeof p.status!=='string'||p.role!==null&&typeof p.role!=='string'))
      return fail('SOURCE_AUTHORITY','Native responsible-principal population is incomplete or inconsistent');
  }
  if (obligations.size !== candidate.obligations.length) return fail("OBLIGATION", "Duplicate trigger obligation");
  const expected = new Map<string, Obligation>();
  for (const [key, { source, record }] of triggers) {
    if (!iso(record.occurredAt) || !iso(record.availableAt) || record.availableAt < record.occurredAt
        || record.availableAt > original.knowledgeCut) return fail("CHRONOLOGY", `Trigger not available ${key}`, [key]);
    const ref = canonicalRef(record.registrationId,record.entityType,source.id);
    if (!ref) {
      const invalid = unresolvedFor(source.id, record, optionsFor(record,source.id));
      if (invalid) return invalid;
      continue;
    }
    for (const rule of mandate.rules.filter((entry) => entry.triggerKind === record.triggerKind)) {
      if (!iso(rule.deadlineAt) || rule.deadlineAt < record.occurredAt) {
        return fail("CHRONOLOGY", `Mandate deadline precedes trigger ${key}`, [key]);
      }
      const trigger = witness(source.id, record.id);
      const identity = obligationKey(source.id, record.id, rule.id);
      const withheld=!profile.ordinaryOperations.includes(rule.operation)?'OUTSIDE_PROFILE'
        :current.responsiblePrincipals&&!current.responsiblePrincipals.some(p=>p.principalId===rule.principalId&&p.active)
          ?'CURRENT_RESPONSIBLE_PRINCIPAL_UNAVAILABLE'
        :!current.authorizedOperations.includes(rule.operation)?'CURRENT_AUTHORITY_UNAVAILABLE':null;
      expected.set(identity, { trigger, sourceId: source.id, recordId: record.id,
        occurredAt: record.occurredAt, availableAt: record.availableAt, subjectRef: ref, ruleId: rule.id,
        deadlineAt: rule.deadlineAt, principalId: rule.principalId, operation: rule.operation,
        materiality: rule.materiality, postconditionRef: rule.postconditionRef, observerRef: rule.observerRef,
        ...(withheld?{nonExecutable:withheld}: {}) });
    }
  }
  for (const actual of candidate.obligations) {
    const trigger = records.get(recordKey(actual.sourceId, actual.recordId))?.record;
    const matchingRules = mandate.rules.filter((rule) => rule.triggerKind === trigger?.triggerKind);
    if (!matchingRules.some((rule) => rule.id === actual.ruleId)) return fail("RULE", `No current explicit normative rule for ${actual.trigger}`, [actual.trigger]);
    const basis = expected.get(obligationKey(actual.sourceId, actual.recordId, actual.ruleId));
    // A normative unsupported duty stays in the denominator as explicitly
    // non-executable. The original mandate/profile/authority snapshot fixes
    // this disposition; a producer cannot invent or silently withhold an action.
    if(basis?.nonExecutable
      ?actual.operation!==basis.operation||actual.nonExecutable!==basis.nonExecutable
      :actual.nonExecutable!==undefined||!current.authorizedOperations.includes(actual.operation)
        ||!profile.ordinaryOperations.includes(actual.operation))
      return fail('AUTHORITY',`Operation is not independently authorized or explicitly withheld: ${actual.operation}`,[actual.trigger]);
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

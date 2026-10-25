import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import {
  DiligenceAssertionSchema, DiligenceSemanticsSchema, DiligenceValueSchema,
  VReferenceSchema, PrimaryReferenceSemanticsSchema, PrimaryRequestSchema,
  SignedPrimaryResponseSchema, PrimarySourceProfileSchema, PrimaryConsentSchema,
  PrimaryAuthorityProfileSchema,
} from "../../../shared-types/src/primary-diligence.js";
import type {
  ExactQuantity, DiligenceValue, PrimaryRecord, PrimaryObservation,
  PrimaryReconciliation, PrimaryClaimCheck, VReference,
} from "../../../shared-types/src/primary-diligence.js";

// Structural schemas are shared; evidence interpretation and arithmetic are not.
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const instantSchema = z.string().datetime({ offset: true });
const idSchema = z.string().min(1).max(200);
const observationSchema = z.object({
  observationId: idSchema, sourceRef: VReferenceSchema, request: PrimaryRequestSchema,
  requestDigest: digestSchema, raw: SignedPrimaryResponseSchema, rawDigest: digestSchema,
  retrievedAt: instantSchema, sourceProfile: PrimarySourceProfileSchema,
  consent: PrimaryConsentSchema, authority: PrimaryAuthorityProfileSchema,
  actualAcquisition: z.literal(true), sourceClass: z.enum([
    "EXTERNAL_AUTHORITATIVE_RECORD", "DIRECT_EXTERNAL_CONFIRMATION",
    "TARGET_CONTROLLED_RECORD", "DERIVED_COMPUTATION",
  ]), instructionEligible: z.literal(false),
}).strict();
const witnessSchema = z.object({
  observationRef: VReferenceSchema, issuerRecordId: idSchema, economicId: idSchema,
  sourceRevision: idSchema, field: idSchema, rawPointer: z.string().max(1000),
  rawValue: DiligenceValueSchema, normalizedValue: DiligenceValueSchema,
  semantics: DiligenceSemanticsSchema, sourceClass: observationSchema.shape.sourceClass,
}).strict();
const reasonsSchema = z.array(z.string().min(1).max(1000)).max(32768);
const reconciliationSchema = z.object({
  assertionRef: VReferenceSchema, sourceWitnesses: z.array(witnessSchema).max(16384),
  selectedEconomicIds: z.array(idSchema).max(16384),
  excludedEconomicIds: z.array(z.object({ id: idSchema, reason: z.string().min(1).max(1000) }).strict()).max(32768),
  observedMembers: z.array(idSchema).max(128), requiredMembers: z.array(idSchema).max(128),
  coverageComplete: z.boolean(), observedValue: DiligenceValueSchema, gaps: reasonsSchema,
  discrepancy: z.object({
    asserted: DiligenceValueSchema, observed: DiligenceValueSchema, difference: DiligenceValueSchema,
  }).strict().nullable(),
  uncertainty: z.object({
    identity: reasonsSchema, measurement: reasonsSchema,
    sampling: reasonsSchema, interpretation: reasonsSchema,
  }).strict(), excludedInterpretations: reasonsSchema,
}).strict();
const frameSchema = z.object({
  assertion: DiligenceAssertionSchema, assertionRef: VReferenceSchema,
  semantics: PrimaryReferenceSemanticsSchema,
  observations: z.array(observationSchema).max(128), proposed: reconciliationSchema,
  startingEvidenceDigest: digestSchema, knowledgeCut: instantSchema, checkedAt: instantSchema,
  currentBindings: z.object({
    sourceProfileRefs: z.array(VReferenceSchema).max(32),
    consentRefs: z.array(VReferenceSchema).max(32),
    authorityRef: VReferenceSchema, semanticsRef: VReferenceSchema,
  }).strict(),
}).strict();
type Frame = z.infer<typeof frameSchema>;
type Rational = { n: bigint; d: bigint };
type Entry = { record: PrimaryRecord; observation: PrimaryObservation; index: number };
type Axis = keyof PrimaryReconciliation["uncertainty"];
let checkDeadline = Infinity;

class CheckFailure extends Error {
  constructor(readonly predicate: string, message = predicate) { super(message); }
}
function requireThat(condition: unknown, predicate: string): asserts condition {
  if (!condition) throw new CheckFailure(predicate);
}
function bounded() {
  requireThat(performance.now() <= checkDeadline, "CHECK_TIME_BOUND");
}
function unique(values: string[]) { return [...new Set(values)].sort(); }
function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    requireThat(Number.isSafeInteger(value) && !Object.is(value, -0), "UNSAFE_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  requireThat(typeof value === "object" && value !== null, "UNSAFE_CANONICAL_VALUE");
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
}
function hash(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function same(a: unknown, b: unknown) { return canonical(a) === canonical(b); }
function sameSet(a: string[], b: string[]) {
  return new Set(a).size === a.length && new Set(b).size === b.length && same([...a].sort(), [...b].sort());
}
function subset(a: string[], b: string[]) { return a.every(v => b.includes(v)); }
function reference(ref: VReference, value: unknown, id: string, revision: number | string) {
  return ref.id === id && ref.revision === String(revision) && ref.contentDigest === hash(value);
}
function current(ref: VReference, refs: VReference[]) {
  return refs.some(r => same(r, ref));
}
function validAt(profile: { validFrom: string; expiresAt: string }, at: string) {
  return Date.parse(profile.validFrom) <= Date.parse(at) && Date.parse(at) < Date.parse(profile.expiresAt);
}
function covers(start: string, end: string, requiredStart: string, requiredEnd: string) {
  return Date.parse(start) <= Date.parse(requiredStart) && Date.parse(end) >= Date.parse(requiredEnd);
}
function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  while (b) { const remainder = a % b; a = b; b = remainder; }
  return a;
}
function rational(n: bigint, d: bigint): Rational {
  requireThat(d > 0n && n.toString().replace("-", "").length <= 384 && d.toString().length <= 384, "RATIONAL_GROWTH_BOUND");
  const divisor = gcd(n, d);
  return { n: n / divisor, d: d / divisor };
}
function quantity(value: ExactQuantity) { return rational(BigInt(value.numerator), BigInt(value.denominator)); }
function add(a: Rational, b: Rational) {
  const common = gcd(a.d, b.d);
  return rational(a.n * (b.d / common) + b.n * (a.d / common), (a.d / common) * b.d);
}
function multiply(a: Rational, b: Rational) {
  const left = gcd(a.n, b.d), right = gcd(b.n, a.d);
  return rational((a.n / left) * (b.n / right), (a.d / right) * (b.d / left));
}
function exact(value: Rational): DiligenceValue {
  requireThat(value.n.toString().replace("-", "").length <= 96 && value.d.toString().length <= 96, "RATIONAL_OUTPUT_BOUND");
  return { kind: "EXACT", quantity: { numerator: value.n.toString(), denominator: value.d.toString() } };
}
function unknown(reason: string): DiligenceValue { return { kind: "UNKNOWN", reason }; }
function equivalentValue(a: DiligenceValue | undefined, b: DiligenceValue | undefined, inverse = false) {
  if (!a || !b) return false;
  if (a.kind === "EXACT" && b.kind === "EXACT") {
    const x = quantity(a.quantity), y = quantity(b.quantity);
    return x.n * y.d === (inverse ? -y.n : y.n) * x.d;
  }
  return !inverse && same(a, b);
}

// Scan before JSON.parse: duplicate keys must not disappear during parsing.
function parseFrame(bytes: Buffer): unknown {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new CheckFailure("INVALID_UTF8"); }
  let cursor = 0;
  const whitespace = () => { while (/[ \n\r\t]/.test(text[cursor] ?? "x")) cursor++; };
  function stringToken(): string {
    requireThat(text[cursor] === '"', "INVALID_JSON");
    const begin = cursor++;
    while (cursor < text.length) {
      const ch = text[cursor++];
      if (ch === "\\") { cursor++; continue; }
      if (ch === '"') {
        let result: string;
        try { result = JSON.parse(text.slice(begin, cursor)) as string; }
        catch { throw new CheckFailure("INVALID_JSON"); }
        requireThat(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result), "UNPAIRED_SURROGATE");
        return result;
      }
    }
    throw new CheckFailure("INVALID_JSON");
  }
  function value(depth: number): void {
    bounded(); requireThat(depth <= 32, "NESTING_BOUND"); whitespace();
    if (text[cursor] === '"') { stringToken(); return; }
    if (text[cursor] === "{") {
      cursor++; whitespace(); const keys = new Set<string>();
      if (text[cursor] === "}") { cursor++; return; }
      for (;;) {
        whitespace(); const key = stringToken();
        requireThat(!["__proto__", "prototype", "constructor"].includes(key), "UNSAFE_FIELD");
        requireThat(!keys.has(key), "DUPLICATE_JSON_KEY"); keys.add(key); whitespace();
        requireThat(text[cursor++] === ":", "INVALID_JSON"); value(depth + 1); whitespace();
        const delimiter = text[cursor++]; if (delimiter === "}") return;
        requireThat(delimiter === ",", "INVALID_JSON");
      }
    }
    if (text[cursor] === "[") {
      cursor++; whitespace(); if (text[cursor] === "]") { cursor++; return; }
      for (;;) {
        value(depth + 1); whitespace(); const delimiter = text[cursor++];
        if (delimiter === "]") return; requireThat(delimiter === ",", "INVALID_JSON");
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(cursor));
    requireThat(token, "INVALID_JSON"); cursor += token[0].length;
    if (/^-?\d/.test(token[0]))
      requireThat(Number.isSafeInteger(Number(token[0])) && !Object.is(Number(token[0]), -0), "UNSAFE_NUMBER");
  }
  value(0); whitespace(); requireThat(cursor === text.length, "ONE_FRAME_REQUIRED");
  try { return JSON.parse(text) as unknown; }
  catch { throw new CheckFailure("INVALID_JSON"); }
}

function check(frame: Frame): PrimaryClaimCheck {
  const { assertion: a, assertionRef, semantics: s, currentBindings: bindings } = frame;
  requireThat(reference(assertionRef, a, a.assertionId, a.revision), "ASSERTION_REFERENCE");
  requireThat(reference(bindings.semanticsRef, s, s.profileId, s.revision), "SEMANTICS_REFERENCE");
  requireThat(s.environment === "DEVELOPMENT" || s.environment === "LIVE", "PRIMARY_ENVIRONMENT_INVALID");
  requireThat(Date.parse(frame.knowledgeCut) <= Date.parse(frame.checkedAt), "KNOWLEDGE_CUT");
  for (const refs of [bindings.sourceProfileRefs, bindings.consentRefs])
    requireThat(new Set(refs.map(ref => `${ref.owner}:${ref.id}`)).size === refs.length, "AMBIGUOUS_CURRENT_REFERENCE");
  requireThat(frame.observations.reduce((n, o) => n + o.raw.body.records.length, 0) <= 16384, "RECORD_BOUND");
  requireThat(quantity(a.requiredCoverage.errorTolerance).n >= 0n && quantity(a.materiality.threshold).n >= 0n, "NEGATIVE_TOLERANCE");
  const minimum = quantity(a.requiredCoverage.minimumCoverage);
  requireThat(minimum.n >= 0n && minimum.n <= minimum.d && quantity(a.semantics.scale).n > 0n, "QUANTITY_SEMANTICS");
  const uncertainty: PrimaryReconciliation["uncertainty"] = {
    identity: [], measurement: [], sampling: [], interpretation: [],
  };
  const gaps: string[] = [];
  const blockingGaps: string[] = [];
  const coverageGaps: string[] = [];
  const seenGaps = new Set<string>();
  const seenBlocking = new Set<string>();
  const seenAxes = { identity: new Set<string>(), measurement: new Set<string>(),
    sampling: new Set<string>(), interpretation: new Set<string>() };
  let metadataBytes = 0;
  const metadata = (value: unknown) => {
    metadataBytes += Buffer.byteLength(canonical(value));
    requireThat(metadataBytes <= 1024 * 1024, "RECONCILIATION_METADATA_BOUND");
  };
  const excludedEconomicIds: PrimaryReconciliation["excludedEconomicIds"] = [];
  const excludedInterpretations = [
    "AUDIT_OPINION", "S8_ADMISSION", "SOURCE_SIGNATURE_IS_TRUTH", "PARTIAL_POPULATION_POINT_ESTIMATE",
    "TARGET_RECORD_IS_EXTERNAL_AUTHORITY", "FORWARDED_REPLY_IS_DIRECT_CONFIRMATION",
    "CASH_IS_EARNED_REVENUE", "UNOBSERVED_REMAINDER_IS_ZERO",
  ];
  const recordGap = (axis: Axis, reason: string) => {
    if (!seenGaps.has(reason)) {
      metadata(reason); requireThat(seenGaps.size < 32768, "REASON_COUNT_BOUND");
      seenGaps.add(reason); gaps.push(reason);
    }
    if (!seenAxes[axis].has(reason)) { seenAxes[axis].add(reason); uncertainty[axis].push(reason); }
  };
  const gap = (axis: Axis, reason: string) => {
    recordGap(axis, reason);
    if (!seenBlocking.has(reason)) { seenBlocking.add(reason); blockingGaps.push(reason); }
  };
  const coverageGap = (reason: string) => {
    if (!seenGaps.has(reason)) coverageGaps.push(reason);
    recordGap("measurement", reason);
  };
  const exclude = (id: string, reason: string) => {
    const item = { id, reason }; metadata(item);
    requireThat(excludedEconomicIds.length < 32768, "EXCLUSION_COUNT_BOUND");
    excludedEconomicIds.push(item);
  };
  const rules = s.rules.filter(rule => rule.field === a.field);
  const rule = rules.length === 1 ? rules[0] : undefined;
  if (!rule) gap("interpretation", "NO_UNIQUE_FIELD_RULE");
  for (const candidate of rules) excludedInterpretations.push(...candidate.excludedInterpretations);
  if (!same(a.semantics.basisRef, bindings.semanticsRef) || s.legalEntityId !== a.semantics.legalEntityId ||
      s.grossNetTreatment !== a.semantics.grossNetTreatment || s.recognitionRule !== a.semantics.recognitionRule ||
      s.calendarRef !== a.semantics.calendarRef || s.consolidationRef !== a.semantics.consolidationRef)
    gap("interpretation", "REFERENCE_SEMANTICS_BINDING");
  if (!same(s.authorityRef, bindings.authorityRef) || !validAt(s, frame.checkedAt))
    gap("interpretation", "SEMANTICS_AUTHORITY_CURRENTNESS");
  if (new Set(a.semantics.perimeter).size !== a.semantics.perimeter.length ||
      !sameSet(a.requiredCoverage.members, a.semantics.accountOrParticipantIds))
    gap("identity", "REGISTERED_PERIMETER_MEMBERS");
  // This source schema binds a single entity; consolidated perimeters need a different admitted contract.
  if (a.semantics.perimeter.length !== 1) gap("identity", "MULTI_ENTITY_PERIMETER_UNSUPPORTED");
  if (a.requiredCoverage.measurementDesignRef || a.amountOrState.kind === "INTERVAL")
    gap("sampling", "MEASUREMENT_DESIGN_NOT_EXECUTABLE");
  if (rule && !subset(rule.recordKinds, a.requiredCoverage.requiredRecordKinds))
    gap("interpretation", "RULE_KINDS_NOT_REGISTERED");
  const revenueWitnesses = ["performance", "recognition", "cutoff", "grossNetTreatment", "nonRevenueExclusions"];
  if (rule?.treatment === "EARNED_REVENUE" && (!subset(revenueWitnesses, rule.requiredWitnessFields) || !s.professionalReviewRef))
    gap("interpretation", "REVENUE_REFERENCE_WITNESSES");
  if (rule?.treatment === "EXACT_RECORDED_STATE" && a.predicateKind === "POPULATION_TOTAL")
    gap("interpretation", "STATE_POPULATION_UNSUPPORTED");
  if (a.predicateKind === "RECORD_CLASSIFICATION" && rule?.treatment !== "EXACT_RECORDED_STATE")
    gap("interpretation", "CLASSIFICATION_REQUIRES_STATE_RULE");

  const entries: Entry[] = [];
  const observedMembers: string[] = [];
  const streams = new Map<string, PrimaryObservation[]>();
  const observationIds = new Set<string>();
  const requestDigests = new Map<string, string>();
  for (const o of frame.observations) {
    bounded();
    const q = o.request, p = o.sourceProfile, c = o.consent, auth = o.authority, b = o.raw.body;
    requireThat(!observationIds.has(o.observationId), "DUPLICATE_OBSERVATION_ID");
    observationIds.add(o.observationId);
    requireThat(o.requestDigest === hash(q) && b.requestDigest === o.requestDigest && b.requestId === q.requestId, "ACTUAL_REQUEST_DIGEST");
    requireThat(o.rawDigest === hash(o.raw) && o.sourceRef.contentDigest === o.rawDigest &&
      o.sourceRef.id === o.observationId && o.sourceRef.revision === b.sourceRevision, "RAW_REFERENCE_DIGEST");
    requireThat(!requestDigests.has(q.requestId) || requestDigests.get(q.requestId) === o.requestDigest, "REQUEST_ID_CONFLICT");
    requestDigests.set(q.requestId, o.requestDigest);
    requireThat(reference(q.sourceProfileRef, p, p.profileId, p.revision) &&
      reference(q.consentRef, c, c.consentId, c.revision) &&
      reference(q.authorityRef, auth, auth.profileId, auth.revision), "GOVERNANCE_REFERENCE_DIGEST");
    requireThat(current(q.sourceProfileRef, bindings.sourceProfileRefs) && current(q.consentRef, bindings.consentRefs) &&
      same(q.authorityRef, bindings.authorityRef) && same(q.semanticsRef, bindings.semanticsRef), "CURRENT_OWNER_BINDINGS");
    requireThat(p.environment === s.environment && c.environment === s.environment &&
      auth.environment === s.environment, "PRIMARY_ENVIRONMENT_MISMATCH");
    let signatureValid = false;
    try {
      const key = createPublicKey(p.responsePublicKeyPem);
      const signature = Buffer.from(o.raw.signature, "base64");
      signatureValid = key.asymmetricKeyType === "ed25519" && signature.length === 64 &&
        signature.toString("base64") === o.raw.signature &&
        verify(null, Buffer.from(canonical(b)), key, signature);
    } catch { /* Invalid keys/signatures have a stable fail-closed predicate. */ }
    requireThat(signatureValid, "ED25519_SIGNATURE");
    requireThat(q.assertionRefs.some(ref => same(ref, assertionRef)) &&
      q.legalEntityId === a.semantics.legalEntityId && q.periodStart === a.semantics.periodStart &&
      q.periodEnd === a.semantics.periodEnd && q.cutoff === a.semantics.cutoff &&
      q.populationId === a.requiredCoverage.populationId && q.populationRevision === a.requiredCoverage.populationRevision &&
      sameSet(q.requiredMembers, a.requiredCoverage.members) && sameSet(q.economicRecordIds, a.economicRecordIds) &&
      sameSet(q.accountOrParticipantIds, a.semantics.accountOrParticipantIds) &&
      q.fieldNames.includes(a.field) && q.knowledgeCut === frame.knowledgeCut, "EXACT_ASSERTION_REQUEST");
    const firstRequest = frame.observations[0]!.request;
    requireThat(q.tenantId === firstRequest.tenantId && q.programmeId === firstRequest.programmeId &&
      same(q.mandateRef, firstRequest.mandateRef) && same(q.grantRef, firstRequest.grantRef), "PROGRAMME_REQUEST_BINDING");
    if (rule && !subset(rule.requiredWitnessFields, q.fieldNames))
      gap("interpretation", `REFERENCE_FIELDS_NOT_REQUESTED:${o.observationId}`);
    requireThat(Date.parse(q.requestedAt) >= Date.parse(frame.knowledgeCut) &&
      Date.parse(q.requestedAt) < Date.parse(q.expiresAt) &&
      Date.parse(b.observedAt) >= Date.parse(q.requestedAt) &&
      Date.parse(b.observedAt) <= Date.parse(o.retrievedAt) &&
      Date.parse(o.retrievedAt) <= Date.parse(frame.checkedAt) &&
      Date.parse(b.observedAt) < Date.parse(q.expiresAt), "ACTUAL_ACQUISITION_TIMES");
    requireThat([p, c, auth, s].every(profile => validAt(profile, q.requestedAt) && validAt(profile, frame.checkedAt)), "GOVERNANCE_VALIDITY");
    requireThat(Date.parse(c.retention.rawUntil) > Date.parse(frame.checkedAt) &&
      Date.parse(c.retention.derivativesUntil) > Date.parse(frame.checkedAt), "RETENTION_RIGHTS");
    requireThat(p.legalEntityId === q.legalEntityId && c.legalEntityId === q.legalEntityId &&
      auth.legalEntityIds.includes(q.legalEntityId) && c.authorizedActorId === q.principalId &&
      c.sourceProfileIds.includes(p.profileId) && subset(q.accountOrParticipantIds, p.accountOrParticipantIds) &&
      subset(q.accountOrParticipantIds, c.accountOrParticipantIds) && p.products.includes(q.product) &&
      c.products.includes(q.product) && p.purpose === q.purpose && c.purposes.includes(q.purpose) &&
      subset(q.fieldNames, p.authoritativeFields) && same(p.rightsRef, c.rightsRef) &&
      covers(c.periodStart, c.periodEnd, q.periodStart, q.periodEnd), "CONSENT_SOURCE_SCOPE");
    const activity = (name: string, actor: string) => auth.activities.some(binding =>
      binding.activity === name && binding.actorIds.includes(actor) && binding.channelIds.includes(p.channelId));
    requireThat(activity("ACCESS_RECORDS", q.principalId) && activity("INTERPRET", s.acceptedBy), "ACTOR_ACTIVITY_AUTHORITY");
    for (const requirement of auth.professionalRequirements.filter(r => ["INTERPRET", "ACCESS_RECORDS", "CONTACT"].includes(r.activity))) {
      const actor = requirement.activity === "INTERPRET" ? s.acceptedBy : q.principalId;
      requireThat(requirement.requiredActorId === actor, "PROFESSIONAL_ACTOR");
      if (requirement.activity === "INTERPRET")
        requireThat(s.professionalReviewRef && same(s.professionalReviewRef, requirement.qualificationRef), "PROFESSIONAL_REVIEW");
    }
    if (auth.instrumentAndTransactionClasses.some(v => ["TAX", "BENEFITS", "PERSONAL_RECORDS"].includes(v)))
      requireThat(s.professionalReviewRef, "CONFIDENTIAL_PROFESSIONAL_INTERPRETATION");
    if (auth.instrumentAndTransactionClasses.includes("PERSONAL_RECORDS"))
      requireThat(auth.confidentialityRules.includes("PERSONAL_RECORDS_PERMITTED") &&
        c.disclosureRules.includes("PERSONAL_RECORDS_PERMITTED"), "PERSONAL_RECORD_RIGHTS");
    const controls = {
      EXTERNAL_AUTHORITATIVE_RECORD: "EXTERNAL_ISSUER", DIRECT_EXTERNAL_CONFIRMATION: "EXTERNAL_RESPONDENT",
      TARGET_CONTROLLED_RECORD: "TARGET", DERIVED_COMPUTATION: "COMPUTATION",
    } as const;
    requireThat(b.issuer === p.issuer && b.system === p.system && b.channelId === p.channelId &&
      b.legalEntityId === q.legalEntityId && b.sourceClass === p.sourceClass && o.sourceClass === p.sourceClass &&
      b.sourceControl === p.sourceControl && p.sourceControl === controls[p.sourceClass], "SOURCE_IDENTITY_CONTROL");
    requireThat(a.acceptableSourceClasses.includes(p.sourceClass) && p.sourceClass !== "DERIVED_COMPUTATION", "PRIMARY_SOURCE_CLASS");
    requireThat(subset(a.observationPredicates, p.observationPredicates), "SOURCE_OBSERVATION_PREDICATES");
    requireThat(!p.intermediary || p.intermediary.independentlyQualified, "INTERMEDIARY_RELIABILITY");
    requireThat(b.respondentId === p.respondentId && b.respondentRole === p.respondentRole &&
      sameSet(b.respondentKnowledge, p.respondentKnowledge), "RESOLVED_RESPONDENT");
    if (p.sourceClass === "DIRECT_EXTERNAL_CONFIRMATION") {
      requireThat(p.respondentId && p.respondentRole && p.respondentAuthorityRef &&
        subset(q.fieldNames, p.respondentKnowledge), "RESPONDENT_ROLE_KNOWLEDGE");
      requireThat(activity("CONTACT", q.principalId) && auth.contactLimits.maximumRequests > 0 &&
        !auth.contactLimits.suppressedParticipantIds.includes(p.respondentId), "CONTACT_AUTHORITY");
    }
    if (!covers(p.availableHistory.start, p.availableHistory.end, q.periodStart, q.periodEnd))
      coverageGap(`SOURCE_HISTORY_INCOMPLETE:${o.observationId}`);
    if (b.populationId !== q.populationId || b.populationRevision !== q.populationRevision)
      gap("identity", `RESPONSE_POPULATION_BINDING:${o.observationId}`);
    if (!subset(b.observedMembers, q.requiredMembers) || !subset(b.coverage.completeForMembers, q.requiredMembers))
      gap("identity", `RESPONSE_MEMBER_BINDING:${o.observationId}`);
    if (b.suspiciousReasons.length) gap("identity", `SUSPICIOUS_REVALIDATION_REQUIRED:${o.observationId}`);
    for (const reason of b.coverage.missingReasons) coverageGap(`SOURCE_MISSING:${reason}`);
    if (!["OBSERVED", "NO_RECORD"].includes(b.status))
      gap("measurement", `SOURCE_STATUS_${b.status}:${o.observationId}`);
    if (b.status !== "OBSERVED" && b.records.length)
      gap("measurement", `STATUS_RECORD_CONFLICT:${o.observationId}`);
    if (b.coverage.measurementDesignRef) gap("sampling", `SOURCE_SAMPLE_NOT_EXECUTABLE:${o.observationId}`);
    observedMembers.push(...b.observedMembers.filter(member => q.requiredMembers.includes(member)));
    const streamKey = hash({ sourceProfileRef: q.sourceProfileRef, populationId: q.populationId,
      populationRevision: q.populationRevision, members: [...q.requiredMembers].sort(),
      periodStart: q.periodStart, periodEnd: q.periodEnd, fieldNames: [...q.fieldNames].sort() });
    streams.set(streamKey, [...(streams.get(streamKey) ?? []), o]);
    if (b.status !== "OBSERVED" || b.suspiciousReasons.length) continue;
    for (let index = 0; index < b.records.length; index++) {
      bounded(); const record = b.records[index]!;
      requireThat(subset(Object.keys(record.fields), q.fieldNames) &&
        subset(Object.keys(record.witnessFields), q.fieldNames), "UNREQUESTED_RAW_FIELD");
      if (!b.coverage.availableRecordKinds.includes(record.kind))
        gap("measurement", `RAW_RECORD_COVERAGE_BINDING:${record.economicId}`);
      if (record.legalEntityId !== a.semantics.legalEntityId ||
          !q.accountOrParticipantIds.includes(record.accountOrParticipantId) ||
          !b.observedMembers.includes(record.accountOrParticipantId)) {
        gap("identity", `RAW_RECORD_IDENTITY:${record.economicId}`); exclude(record.economicId, "IDENTITY_BINDING"); continue;
      }
      if (record.currency !== a.semantics.currency || record.units !== a.semantics.units ||
          record.basisDigest !== a.semantics.basisRef.contentDigest ||
          Date.parse(record.periodStart) > Date.parse(record.periodEnd) ||
          Date.parse(record.periodStart) < Date.parse(q.periodStart) ||
          Date.parse(record.periodEnd) > Date.parse(q.periodEnd) ||
          Date.parse(record.effectiveAt) < Date.parse(q.periodStart) ||
          Date.parse(record.effectiveAt) > Date.parse(q.cutoff) ||
          Date.parse(record.observedAt) > Date.parse(b.observedAt)) {
        gap("interpretation", `RAW_RECORD_SEMANTICS:${record.economicId}`); exclude(record.economicId, "SEMANTICS_BINDING"); continue;
      }
      entries.push({ record, observation: o, index });
    }
  }

  // A separate page stream cannot hide its unknown tail behind another complete stream.
  const coveredMembers: string[] = [];
  let streamsComplete = streams.size > 0;
  for (const observations of streams.values()) {
    bounded();
    const pages = new Map<number, PrimaryObservation>();
    let complete = true;
    let pagesComplete = true;
    const first = observations[0]!;
    const pageShape = (o: PrimaryObservation) => {
      const { requestId: _id, requestDigest: _digest, observedAt: _at, providerCost: _cost, ...rest } = o.raw.body;
      return rest;
    };
    for (const o of observations) {
      const b = o.raw.body, coverage = b.coverage;
      const match = /^(?:page-)?([1-9][0-9]{0,2})$/.exec(coverage.pageId);
      const number = match ? Number(match[1]) : 0;
      if (!number || number > coverage.totalPages || coverage.totalPages !== first.raw.body.coverage.totalPages ||
          b.sourceRevision !== first.raw.body.sourceRevision || b.populationRevision !== first.raw.body.populationRevision ||
          b.populationId !== first.raw.body.populationId) { complete = false; pagesComplete = false; }
      const previous = pages.get(number);
      if (previous && !same(pageShape(previous), pageShape(o))) {
        gap("measurement", `CONFLICTING_PAGE:${o.sourceProfile.profileId}:${coverage.pageId}`);
        complete = false; pagesComplete = false;
      } else pages.set(number, o);
      if (!["OBSERVED", "NO_RECORD"].includes(b.status) || b.suspiciousReasons.length ||
          coverage.missingReasons.length || !coverage.completePopulation ||
          !sameSet(coverage.completeForMembers, o.request.requiredMembers) ||
          !subset(a.requiredCoverage.requiredRecordKinds, coverage.availableRecordKinds) ||
          !covers(coverage.historyStart, coverage.historyEnd, a.semantics.periodStart, a.semantics.periodEnd) ||
          coverage.measurementDesignRef) complete = false;
    }
    const count = first.raw.body.coverage.totalPages;
    if (pages.size !== count) { complete = false; pagesComplete = false; }
    for (let number = 1; number <= count; number++) {
      const page = pages.get(number);
      if (!page) { complete = false; pagesComplete = false; continue; }
      const next = pages.get(number + 1);
      if (number === count ? page.raw.body.coverage.nextCursor !== null :
          !next || page.raw.body.coverage.nextCursor !== next.raw.body.coverage.pageId) {
        complete = false; pagesComplete = false;
      }
    }
    if (!pagesComplete) gap("measurement", `PAGINATION_INCOMPLETE:${first.sourceProfile.profileId}`);
    if (complete) coveredMembers.push(...first.request.requiredMembers);
    else { streamsComplete = false; coverageGap(`POPULATION_STREAM_INCOMPLETE:${first.sourceProfile.profileId}`); }
  }
  const coverageComplete = streamsComplete && subset(a.requiredCoverage.members, unique(coveredMembers));
  const needsPopulation = ["POPULATION_TOTAL", "ABSENCE"].includes(a.predicateKind) || a.requiredCoverage.completePopulation;
  if (needsPopulation) blockingGaps.push(...coverageGaps);
  if (needsPopulation && !coverageComplete) gap("measurement", "REGISTERED_POPULATION_INCOMPLETE");
  if (!frame.observations.length) gap("measurement", "NO_PRIMARY_OBSERVATIONS");

  function economicShape(record: PrimaryRecord, alias = false) {
    const { issuerRecordId: _issuer, observedAt: _observed, economicId: _economic,
      aliasOf: _alias, revision: _revision, ...rest } = record;
    // Revision is checked separately, not an extra contribution.
    const fields = Object.fromEntries(Object.entries(rest.fields).map(([field, value]) =>
      [field, value.kind === "EXACT" ? exact(quantity(value.quantity)) : value]));
    return alias ? { ...rest, fields } : { ...rest, fields, aliasOf: record.aliasOf };
  }
  const revisions = new Map<string, Map<number, Entry[]>>();
  for (const entry of entries) {
    const record = entry.record;
    const versions = revisions.get(record.economicId) ?? new Map<number, Entry[]>();
    const copies = versions.get(record.revision) ?? [];
    copies.push(entry); versions.set(record.revision, copies);
    revisions.set(record.economicId, versions);
  }
  const latest = new Map<string, Entry[]>();
  for (const [id, versions] of revisions) {
    bounded();
    for (const duplicates of versions.values()) {
      if (duplicates.some(entry => !same(economicShape(entry.record), economicShape(duplicates[0]!.record))))
        gap("measurement", `ECONOMIC_REVISION_CONFLICT:${id}`);
    }
    const ordered = [...versions.keys()].sort((x, y) => x - y);
    for (let index = 1; index < ordered.length; index++) {
      const prior = versions.get(ordered[index - 1]!)![0]!.record;
      const next = versions.get(ordered[index]!)![0]!.record;
      if (["REMOVED", "REVERSED"].includes(prior.state) && next.state === "POSTED" ||
          prior.state === "POSTED" && next.state === "PENDING")
        gap("measurement", `UNSUPPORTED_REVISION_TRANSITION:${id}`);
    }
    latest.set(id, versions.get(ordered[ordered.length - 1]!)!);
  }
  const rootCache = new Map<string, string>();
  function aliasRoot(id: string): string | null {
    if (rootCache.has(id)) return rootCache.get(id)!;
    const seen = new Set<string>(); let cursor = id;
    while (latest.get(cursor)?.[0]?.record.aliasOf) {
      bounded();
      if (seen.has(cursor)) { gap("identity", `ALIAS_CYCLE:${id}`); return null; }
      seen.add(cursor); cursor = latest.get(cursor)![0]!.record.aliasOf!;
    }
    if (!latest.has(cursor)) { gap("identity", `ALIAS_TARGET_MISSING:${id}`); return null; }
    for (const member of seen) rootCache.set(member, cursor);
    rootCache.set(id, cursor); return cursor;
  }
  const canonicalEntries = new Map<string, Entry[]>();
  for (const [id, copies] of latest) {
    const root = aliasRoot(id);
    if (!root) { exclude(id, "ALIAS_UNRESOLVED"); continue; }
    if (root !== id) {
      if (!same(economicShape(copies[0]!.record, true), economicShape(latest.get(root)![0]!.record, true)))
        gap("measurement", `ALIAS_VALUE_CONFLICT:${id}`);
      exclude(id, `ALIAS_OF:${root}`);
    }
    const grouped = canonicalEntries.get(root) ?? [];
    grouped.push(...copies); canonicalEntries.set(root, grouped);
  }
  // Keep the root's actual revision/state as the economic representative.
  for (const [id, copies] of canonicalEntries)
    canonicalEntries.set(id, [...latest.get(id)!, ...copies.filter(copy => copy.record.economicId !== id)]);
  const retired = new Set<string>();
  const replacedBy = new Map<string, string>();
  const reversedBy = new Map<string, string>();
  for (const [id, copies] of canonicalEntries) {
    bounded(); const record = copies[0]!.record;
    if (record.replacesEconomicId) {
      const target = aliasRoot(record.replacesEconomicId);
      if (!target || target === id || record.state !== "POSTED" ||
          !["PENDING", "POSTED"].includes(canonicalEntries.get(target)?.[0]?.record.state ?? "") ||
          (replacedBy.has(target) && replacedBy.get(target) !== id)) {
        gap("measurement", `REPLACEMENT_UNRESOLVED:${id}`);
      } else {
        const predecessor = canonicalEntries.get(target)![0]!.record;
        if (record.accountOrParticipantId !== predecessor.accountOrParticipantId ||
            record.revision < predecessor.revision) gap("identity", `REPLACEMENT_BINDING:${id}`);
        replacedBy.set(target, id); retired.add(target); exclude(target, `REPLACED_BY:${id}`);
      }
    }
    if (record.reversesEconomicId) {
      const target = aliasRoot(record.reversesEconomicId);
      const original = target ? canonicalEntries.get(target)?.[0]?.record : undefined;
      if (!target || target === id || !original || original.state !== "POSTED" ||
          !["POSTED", "REVERSED"].includes(record.state) ||
          original.accountOrParticipantId !== record.accountOrParticipantId ||
          !equivalentValue(record.fields[a.field], original.fields[a.field], record.state === "POSTED") ||
          (reversedBy.has(target) && reversedBy.get(target) !== id)) {
        gap("measurement", `REVERSAL_UNRESOLVED:${id}`);
      } else {
        reversedBy.set(target, id); retired.add(target); retired.add(id);
        exclude(target, `REVERSED_BY:${id}`); exclude(id, `REVERSAL_OF:${target}`);
      }
    }
  }
  for (const origin of replacedBy.keys()) {
    const seen = new Set<string>(); let cursor = origin;
    while (replacedBy.has(cursor)) {
      if (seen.has(cursor)) { gap("identity", `REPLACEMENT_CYCLE:${origin}`); break; }
      seen.add(cursor); cursor = replacedBy.get(cursor)!;
    }
  }
  for (const id of reversedBy.keys())
    if (replacedBy.has(id)) gap("measurement", `REPLACED_REVERSAL_CONFLICT:${id}`);

  const selectedEconomicIds: string[] = [];
  const sourceWitnesses: PrimaryReconciliation["sourceWitnesses"] = [];
  let witnessBytes = 0;
  const values: DiligenceValue[] = [];
  const requestedRoots = unique(a.economicRecordIds.map(id => {
    let root = latest.has(id) ? aliasRoot(id) ?? id : id;
    const seen = new Set<string>();
    while (replacedBy.has(root) && !seen.has(root)) { seen.add(root); root = replacedBy.get(root)!; }
    return root;
  }));
  const normalized = (value: DiligenceValue): DiligenceValue => {
    if (value.kind !== "EXACT") return value;
    const scaled = multiply(quantity(value.quantity), quantity(a.semantics.scale));
    return exact(a.semantics.signConvention === "NEGATE" ? { ...scaled, n: -scaled.n } : scaled);
  };
  for (const [id, copies] of [...canonicalEntries].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    bounded(); const record = copies[0]!.record;
    const relevant = ["POPULATION_TOTAL", "ABSENCE"].includes(a.predicateKind) ?
      a.economicRecordIds.length === 0 || requestedRoots.includes(id) : requestedRoots.includes(id);
    if (!relevant) { exclude(id, "OUTSIDE_EXACT_PREDICATE"); continue; }
    let witnessesUsable = true;
    if (rule) for (const copy of copies) for (const field of rule.requiredWitnessFields) {
      if (!copy.record.witnessFields[field]?.trim() ||
          !copy.observation.sourceProfile.authoritativeFields.includes(field) ||
          !copy.observation.request.fieldNames.includes(field)) {
        gap("interpretation", `REQUIRED_FIELD_WITNESS:${id}:${field}`); witnessesUsable = false;
      }
    }
    if (retired.has(id)) continue;
    if (["REMOVED", "REVERSED"].includes(record.state)) { exclude(id, record.state); continue; }
    if (record.state === "PENDING") { gap("measurement", `PENDING_RECORD:${id}`); exclude(id, "PENDING"); continue; }
    if (!rule || !rule.recordKinds.includes(record.kind)) { exclude(id, "OUTSIDE_RULE_KINDS"); continue; }
    const rawValue = record.fields[a.field];
    if (!rawValue || rawValue.kind === "UNKNOWN" || rawValue.kind === "INTERVAL") {
      gap("measurement", `EXACT_FIELD_UNAVAILABLE:${id}`); exclude(id, "UNKNOWN_FIELD"); continue;
    }
    let usable = witnessesUsable;
    for (const copy of copies) {
      const raw = copy.record;
      if (rule.treatment === "EARNED_REVENUE" &&
          (raw.witnessFields.performance !== "SATISFIED" || raw.witnessFields.recognition !== s.recognitionRule ||
           raw.witnessFields.cutoff !== a.semantics.cutoff || raw.witnessFields.grossNetTreatment !== s.grossNetTreatment ||
           raw.witnessFields.nonRevenueExclusions !== "BORROWING_TRANSFERS_ADVANCES_EXCLUDED" ||
           raw.relatedParty === "UNKNOWN")) {
        gap("interpretation", `REVENUE_RECOGNITION_UNESTABLISHED:${id}`); usable = false;
      }
    }
    if ((rule.treatment === "EXACT_RECORDED_STATE") !== (rawValue.kind === "STATE")) {
      gap("interpretation", `FIELD_TREATMENT_MISMATCH:${id}`); usable = false;
    }
    if (!usable) { exclude(id, "INSUFFICIENT_FIELD_WITNESSES"); continue; }
    const value = normalized(rawValue);
    selectedEconomicIds.push(id); values.push(value);
    for (const copy of copies) {
      const pointerField = a.field.replace(/~/g, "~0").replace(/\//g, "~1");
      const witness: PrimaryReconciliation["sourceWitnesses"][number] = {
        observationRef: copy.observation.sourceRef, issuerRecordId: copy.record.issuerRecordId,
        economicId: copy.record.economicId, sourceRevision: copy.observation.raw.body.sourceRevision,
        field: a.field, rawPointer: `/body/records/${copy.index}/fields/${pointerField}`,
        rawValue: copy.record.fields[a.field]!, normalizedValue: normalized(copy.record.fields[a.field]!),
        semantics: a.semantics, sourceClass: copy.observation.sourceClass,
      };
      witnessBytes += Buffer.byteLength(canonical(witness));
      requireThat(witnessBytes <= 4 * 1024 * 1024, "FIELD_WITNESS_BYTE_BOUND");
      sourceWitnesses.push(witness);
    }
  }
  if (["RECORD_VALUE", "RECORD_CLASSIFICATION"].includes(a.predicateKind))
    for (const id of requestedRoots)
      if (!selectedEconomicIds.includes(id)) gap("measurement", `EXACT_RECORD_UNESTABLISHED:${id}`);

  let observedValue: DiligenceValue = unknown("INSUFFICIENT_PRIMARY_EVIDENCE");
  if (blockingGaps.length === 0) {
    if (a.predicateKind === "ABSENCE")
      observedValue = { kind: "STATE", state: selectedEconomicIds.length ? "PRESENT" : "ABSENT" };
    else if (values.every(value => value.kind === "EXACT") && rule?.treatment !== "EXACT_RECORDED_STATE") {
      let total = rational(0n, 1n);
      for (const value of values) if (value.kind === "EXACT") { bounded(); total = add(total, quantity(value.quantity)); }
      observedValue = exact(total);
    } else if (values.length && values.every(value => value.kind === "STATE" && same(value, values[0])))
      observedValue = values[0]!;
    else gap("interpretation", "INCOMPATIBLE_RECORD_STATES");
  }
  let conclusion: PrimaryClaimCheck["conclusion"] = "UNRESOLVED";
  let discrepancy: PrimaryReconciliation["discrepancy"] = null;
  if (observedValue.kind !== "UNKNOWN" && blockingGaps.length === 0) {
    const expected = a.amountOrState;
    if (expected.kind === "UNKNOWN") conclusion = "SUPPORTED";
    else if (expected.kind === "EXACT" && observedValue.kind === "EXACT") {
      const x = quantity(observedValue.quantity), y = quantity(expected.quantity);
      const difference = add(x, { n: -y.n, d: y.d });
      const tolerance = quantity(a.requiredCoverage.errorTolerance);
      const absolute = difference.n < 0n ? -difference.n : difference.n;
      const left = absolute * tolerance.d, right = tolerance.n * difference.d;
      requireThat(left.toString().length <= 384 && right.toString().length <= 384, "RATIONAL_GROWTH_BOUND");
      conclusion = left <= right ? "SUPPORTED" : "CONTRADICTED";
      if (conclusion === "CONTRADICTED") discrepancy = { asserted: expected, observed: observedValue, difference: exact(difference) };
    } else if (expected.kind === "STATE" && observedValue.kind === "STATE") {
      conclusion = expected.state === observedValue.state ? "SUPPORTED" : "CONTRADICTED";
      if (conclusion === "CONTRADICTED") discrepancy = {
        asserted: expected, observed: observedValue, difference: unknown("STATE_DIFFERENCE_NOT_QUANTITY"),
      };
    } else {
      gap("interpretation", "EXPECTED_VALUE_TYPE_INCOMPATIBLE");
      observedValue = unknown("INSUFFICIENT_PRIMARY_EVIDENCE");
    }
  }
  for (const axis of Object.keys(uncertainty) as Axis[]) uncertainty[axis] = unique(uncertainty[axis]);
  sourceWitnesses.sort((left, right) => {
    const x = [left.observationRef.id, left.rawPointer, left.economicId];
    const y = [right.observationRef.id, right.rawPointer, right.economicId];
    for (let index = 0; index < x.length; index++) {
      if (x[index]! < y[index]!) return -1;
      if (x[index]! > y[index]!) return 1;
    }
    return 0;
  });
  const distinctExclusions = [...new Map(excludedEconomicIds.map(item => [canonical(item), item])).values()]
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 :
      left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0);
  const reconciliation: PrimaryReconciliation = {
    assertionRef, sourceWitnesses, selectedEconomicIds: unique(selectedEconomicIds),
    excludedEconomicIds: distinctExclusions, observedMembers: unique(observedMembers),
    requiredMembers: unique(a.requiredCoverage.members), coverageComplete,
    observedValue, gaps: unique(gaps), discrepancy, uncertainty,
    excludedInterpretations: unique(excludedInterpretations),
  };
  const proposedMatches = same(frame.proposed, reconciliation);
  const checkerIdentity: VReference = {
    owner: "P4", id: "primary-raw-evidence-checker", revision: "1",
    contentDigest: hash({
      code: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
      specification: createHash("sha256").update(readFileSync(new URL("./checker-spec.md", import.meta.url))).digest("hex"),
    }),
  };
  const observationRefs = frame.observations.map(o => o.sourceRef)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const producerReconciliationDigest = hash(frame.proposed);
  const sourceScopeDigest = hash({
    assertionRef, observationRefs, startingEvidenceDigest: frame.startingEvidenceDigest,
    knowledgeCut: frame.knowledgeCut, currentBindings: bindings,
    semanticsRef: bindings.semanticsRef, producerReconciliationDigest,
    checkerIdentity, checkedAt: frame.checkedAt,
  });
  return {
    checkId: hash({ sourceScopeDigest, reconciliation }), checkerIdentity, assertionRef, observationRefs,
    sourceScopeDigest, semanticsRef: bindings.semanticsRef,
    result: !proposedMatches ? "REJECT" : conclusion === "UNRESOLVED" ? "UNRESOLVED" : "ACCEPT",
    conclusion, establishedValue: observedValue,
    reasons: unique([...reconciliation.gaps, ...(!proposedMatches ? ["PRODUCER_RECONCILIATION_MISMATCH"] : []),
      ...(conclusion !== "UNRESOLVED" ? [`INDEPENDENT_${conclusion}`] : [])]),
    excludedInterpretations: reconciliation.excludedInterpretations, checkedAt: frame.checkedAt,
    producerReconciliationDigest, independentReconciliation: reconciliation,
  };
}

function usage() {
  const cpu = process.cpuUsage();
  return { cpuMicros: String(cpu.user + cpu.system), peakRSSBytes: String(process.resourceUsage().maxRSS * 1024) };
}
let finished = false;
function finish(result: Record<string, unknown>, failed = false) {
  if (finished) return;
  let encoded = JSON.stringify({ ...result, usage: usage() });
  if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) {
    failed = true;
    encoded = JSON.stringify({ ok: false, predicate: "OUTPUT_BYTE_BOUND",
      message: "OUTPUT_BYTE_BOUND", usage: usage() });
  }
  finished = true; clearTimeout(inputTimer); process.stdin.destroy();
  process.exitCode = failed ? 1 : 0;
  process.stdout.write(`${encoded}\n`);
}
function failure(error: unknown) {
  const known = error instanceof CheckFailure;
  finish({ ok: false, predicate: known ? error.predicate : "CHECKER_INTERNAL_ERROR",
    message: known ? error.message : "Independent checker failed closed" }, true);
}
const chunks: Buffer[] = [];
let bytesRead = 0;
const inputTimer = setTimeout(() => failure(new CheckFailure("INPUT_TIME_BOUND")), 10000);
process.stdin.on("data", (chunk: Buffer) => {
  if (finished) return;
  bytesRead += chunk.length;
  if (bytesRead > 8 * 1024 * 1024) { failure(new CheckFailure("INPUT_BYTE_BOUND")); return; }
  chunks.push(chunk);
});
process.stdin.on("error", () => failure(new CheckFailure("INPUT_IO_ERROR")));
process.stdout.on("error", () => { process.exitCode = 1; });
process.stdin.on("end", () => {
  if (finished) return;
  clearTimeout(inputTimer); checkDeadline = performance.now() + 5000;
  try {
    const raw = parseFrame(Buffer.concat(chunks));
    const parsed = frameSchema.safeParse(raw);
    if (!parsed.success) throw new CheckFailure("FRAME_SCHEMA", "Input violates the fixed structural schema");
    const data = check(parsed.data); bounded();
    finish({ ok: true, data });
  } catch (error) { failure(error); }
});

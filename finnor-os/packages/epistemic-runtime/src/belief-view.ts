import type { BeliefClaim, BeliefDecisionContext, BeliefOwnerRef, BeliefResolution, BeliefView, S1ExperienceEvent } from "@finnor/shared-types";
import { epistemicHash } from "./source-precedence";

export const BELIEF_INTERPRETATION_VERSION = "s1-permissioned-records-v3";
export const MAX_BELIEF_BYTES = 8 * 1024 * 1024;

/** Content identity for a prepared envelope, never an authenticated receipt. */
export function prepareS1ExperienceEvent(input: Omit<S1ExperienceEvent, "eventId">): S1ExperienceEvent {
  const body = structuredClone(input);
  return { ...body, eventId: `s1-event:${epistemicHash(body)}` };
}

export interface BeliefViewInput {
  tenantId: string; principalId: string; root: BeliefView["root"];
  validAt: string; knowledgeAt: string; rightsRevision: number; rightsEvaluatedAt: string;
  claims: BeliefClaim[]; sourceCuts: BeliefView["sourceCuts"]; coverage: BeliefView["coverage"];
  dependencyRefs: string[]; episodeId?: string;
}

/** Exact decimal comparison for the registered numeric predicate fragment.
 * Values are never coerced to binary floating point. No aggregation is implied. */
function decimal(value: string): { negative: boolean; digits: string; scale: number } {
  if (value.length > 128 || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) throw new Error("Unsupported decimal representation");
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^[+-]/, "").split(".");
  const digits = `${whole}${fraction}`.replace(/^0+/, "") || "0";
  return { negative: negative && digits !== "0", digits, scale: fraction.length };
}
function compareDecimal(left: string, right: string): number {
  const a = decimal(left); const b = decimal(right);
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const scale = Math.max(a.scale, b.scale);
  const ad = (a.digits + "0".repeat(scale - a.scale)).replace(/^0+/, "") || "0";
  const bd = (b.digits + "0".repeat(scale - b.scale)).replace(/^0+/, "") || "0";
  const order = ad.length === bd.length ? (ad === bd ? 0 : ad < bd ? -1 : 1) : ad.length < bd.length ? -1 : 1;
  return a.negative ? -order : order;
}
function instant(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}
function checkedDecision(context: BeliefDecisionContext): void {
  if (!context.id?.trim() || !context.version?.trim() || context.evidenceUniverse !== "registered_canonical_records"
    || !Array.isArray(context.requirements) || context.requirements.length < 1 || context.requirements.length > 64) throw new Error("Unsupported S1 decision context");
  const ids = new Set<string>();
  for (const requirement of context.requirements) {
    if (!requirement.id?.trim() || ids.has(requirement.id) || !requirement.subject?.entityType?.trim() || !requirement.subject.entityId?.trim()
      || !requirement.metricKey?.trim() || !requirement.unit?.trim() || (requirement.currencyCode !== null && !/^[A-Z]{3}$/.test(requirement.currencyCode))
      || !instant(requirement.periodStart) || !instant(requirement.periodEnd) || Date.parse(requirement.periodEnd) < Date.parse(requirement.periodStart)
      || !["gte", "lte", "eq"].includes(requirement.operator)
      || (requirement.maximumAgeMs !== undefined && (!Number.isFinite(requirement.maximumAgeMs) || requirement.maximumAgeMs < 0))) throw new Error("Invalid S1 decision requirement");
    ids.add(requirement.id); decimal(requirement.threshold);
  }
}

function resolution(view: Pick<BeliefView, "claims" | "coverage" | "knowledgeAt" | "contradictions">, context?: BeliefDecisionContext): BeliefResolution {
  if (!context) return { status: "NOT_REQUESTED", decisionRef: null, errorBound: null, results: [], reasons: ["NO_EXTERNAL_DECISION_CONTEXT"], refinement: null };
  checkedDecision(context);
  const reasons: string[] = [];
  if (view.coverage.canonicalStatus !== "COMPLETE") reasons.push("CANONICAL_RECONSTRUCTION_INCOMPLETE");
  if (view.coverage.truncated) reasons.push("PERMITTED_VIEW_BUDGET_TRUNCATED");
  const results: BeliefResolution["results"] = context.requirements.map(requirement => {
    const series = view.claims.filter(c => c.ownerRef.entityType === "pe_metric_series" && c.value.subjectType === requirement.subject.entityType
      && c.value.subjectId === requirement.subject.entityId && c.value.metricKey === requirement.metricKey && c.value.unit === requirement.unit
      && (c.value.currencyCode ?? null) === requirement.currencyCode);
    const seriesIds = new Set(series.map(c => c.ownerRef.id));
    const claims = view.claims.filter(c => c.ownerRef.entityType === "pe_metric_observation" && seriesIds.has(String(c.value.metricSeriesId))
      && instant(c.value.periodStart) === instant(requirement.periodStart) && instant(c.value.periodEnd) === instant(requirement.periodEnd));
    const localReasons: string[] = [];
    if (series.length === 0 || claims.length === 0) localReasons.push("PERMITTED_METRIC_UNAVAILABLE");
    if (claims.some(c => c.value.valueType !== "number" || typeof c.value.valueNumeric !== "string")) localReasons.push("UNSUPPORTED_METRIC_REPRESENTATION");
    if (claims.some(c => view.contradictions.some(x => x.claimRefs.includes(c.id)))) localReasons.push("UNRESOLVED_METRIC_CONTRADICTION");
    if (claims.some(c => c.dependencyRefs.some(ref => !view.claims.some(parent => parent.id === ref || parent.ownerRef.revisionId === ref)))) localReasons.push("METRIC_DEPENDENCY_UNAVAILABLE");
    if (requirement.maximumAgeMs !== undefined && claims.some(c => !instant(c.value.observedAt)
      || Date.parse(String(c.value.observedAt)) > Date.parse(view.knowledgeAt)
      || Date.parse(view.knowledgeAt) - Date.parse(String(c.value.observedAt)) > requirement.maximumAgeMs!)) localReasons.push("FRESHNESS_NOT_ESTABLISHED");
    let matches: boolean[] = [];
    try { matches = claims.map(c => { const cmp = compareDecimal(String(c.value.valueNumeric), requirement.threshold); return requirement.operator === "gte" ? cmp >= 0 : requirement.operator === "lte" ? cmp <= 0 : cmp === 0; }); }
    catch { localReasons.push("UNSUPPORTED_METRIC_REPRESENTATION"); }
    // Multiple compatible series are still competing assertions about one metric.
    if (new Set(claims.map(c => String(c.value.valueNumeric))).size > 1) localReasons.push("UNRESOLVED_METRIC_CONTRADICTION");
    return { requirementId: requirement.id, status: reasons.length || localReasons.length ? "UNKNOWN" : matches.every(Boolean) ? "MATCHES" : "DOES_NOT_MATCH",
      claimRefs: [...series, ...claims].map(c => c.id), reasons: [...new Set([...reasons, ...localReasons])] };
  });
  const sufficient = results.every(r => r.status !== "UNKNOWN");
  return { status: sufficient ? "SUFFICIENT" : "INSUFFICIENT_RESOLUTION", decisionRef: { id: context.id, version: context.version, contentDigest: epistemicHash(context) },
    errorBound: sufficient ? { maximumPredicateError: 0, domain: "registered_canonical_records" } : null, results,
    reasons: [...new Set(results.flatMap(r => r.reasons))], refinement: sufficient ? null : view.coverage.truncated ? "REQUEST_FULL_PERMITTED_VIEW" : "NO_SUPPORTED_REFINEMENT" };
}

function contradictions(claims: BeliefClaim[]): BeliefView["contradictions"] {
  const series = new Map(claims.filter(c => c.ownerRef.entityType === "pe_metric_series").map(c => [c.ownerRef.id, c]));
  const groups = new Map<string, BeliefClaim[]>();
  for (const claim of claims.filter(c => c.ownerRef.entityType === "pe_metric_observation")) {
    const s = series.get(String(claim.value.metricSeriesId)); if (!s) continue;
    const key = epistemicHash([s.value.subjectType, s.value.subjectId, s.value.metricKey, s.value.unit, s.value.currencyCode ?? null, instant(claim.value.periodStart), instant(claim.value.periodEnd), claim.value.valueType]);
    groups.set(key, [...(groups.get(key) ?? []), claim]);
  }
  const sourceGroups = new Map<string, Array<{ claim: BeliefClaim; value: unknown }>>();
  for (const claim of claims.filter(c => c.kind === "SOURCE_ASSERTION")) {
    for (const assertion of Array.isArray(claim.value.assertions) ? claim.value.assertions : []) {
      if (!assertion || typeof assertion !== "object" || typeof assertion.propositionId !== "string" || typeof assertion.valueJson !== "string") continue;
      sourceGroups.set(assertion.propositionId, [...(sourceGroups.get(assertion.propositionId) ?? []), { claim, value: assertion.valueJson }]);
    }
  }
  const sourceConflicts: BeliefView["contradictions"] = [...sourceGroups.values()].filter(group => new Set(group.map(x => epistemicHash(x.value))).size > 1)
    .map(group => ({ claimRefs: [...new Set(group.map(x => x.claim.id))].sort(), resolution: "UNRESOLVED", reason: "COMPETING_SOURCE_ASSERTIONS" }));
  return [...sourceConflicts, ...[...groups.values()].filter(group => new Set(group.map(c => epistemicHash([c.value.valueNumeric, c.value.valueText, c.value.valueBoolean]))).size > 1)
    .map(group => ({ claimRefs: group.map(c => c.id).sort(), resolution: "UNRESOLVED" as const, reason: "COMPETING_COMPATIBLE_METRIC_ASSERTIONS" }))
  ];
}

/** Receives only already-authorized immutable owner records. It performs no I/O
 * and supplies no authority, business policy, acquisition choice or canonical write. */
export function createBeliefView(input: BeliefViewInput, decisionContext?: BeliefDecisionContext): BeliefView {
  if (!Number.isSafeInteger(input.rightsRevision) || input.rightsRevision < 1 || !instant(input.validAt) || !instant(input.knowledgeAt)) throw new Error("Invalid S1 view cut");
  if (Buffer.byteLength(JSON.stringify(input.claims), "utf8") > MAX_BELIEF_BYTES) throw new Error("S1 permitted view exceeds the 8 MiB serialization envelope");
  const claims = structuredClone(input.claims).sort((a, b) => a.id.localeCompare(b.id));
  const dependencyRefs = [...new Set(input.dependencyRefs)].sort();
  const dependencyDigest = epistemicHash({ dependencyRefs, rightsRevision: input.rightsRevision, interpretation: BELIEF_INTERPRETATION_VERSION,
    coverage: input.coverage, sourceCuts: input.sourceCuts.map(({ knownThrough, ...cut }) => cut) });
  const base = { schema: "finnor.belief-view.v1" as const, semanticOwner: "S1" as const, interpretationVersion: BELIEF_INTERPRETATION_VERSION,
    tenantId: input.tenantId, principalId: input.principalId, root: { ...input.root }, validAt: input.validAt, knowledgeAt: input.knowledgeAt,
    rights: { revision: input.rightsRevision, ref: `authority:${input.tenantId}:${input.rightsRevision}`, evaluatedAt: input.rightsEvaluatedAt, scope: "CURRENT_AUTHORIZED_RESOURCES" as const },
    sourceCuts: structuredClone(input.sourceCuts), claims, contradictions: contradictions(claims), coverage: structuredClone(input.coverage), dependencyDigest };
  const resolved = resolution(base, decisionContext);
  const contentDigest = epistemicHash({ ...base, rights: { ...base.rights, evaluatedAt: undefined }, resolution: resolved });
  const id = `belief-view:${contentDigest}`;
  const event = prepareS1ExperienceEvent({ schema: "finnor.s1.experience.v1" as const, episodeId: input.episodeId ?? id, semanticOwner: "S1" as const,
    type: "BELIEF_VIEW" as const, tenantId: input.tenantId, principalId: input.principalId, rightsRef: base.rights.ref, causalParents: [] as string[],
    revisionRef: id, contentDigest, validAt: input.validAt, knowledgeAt: input.knowledgeAt, dependencyRefs,
    freshnessRef: `s1-cut:${epistemicHash(input.sourceCuts)}`, uncertainty: "QUALIFIED_RECORDS_NO_CALIBRATION" as const, horizon: "H0" as const,
    provenanceRefs: claims.map(c => c.ownerRef), modelCompute: null });
  return { ...base, id, contentDigest, resolution: resolved, pin: { tenantId: input.tenantId, principalId: input.principalId, root: { ...input.root },
    validAt: input.validAt, knowledgeAt: input.knowledgeAt, dependencyDigest, rightsRevision: input.rightsRevision, interpretationVersion: BELIEF_INTERPRETATION_VERSION },
    experience: { status: "BLOCKED_EXTERNAL", event, receipt: null, appendAuthorityGranted: false, executionAuthorityGranted: false,
      reason: "S6 protected ExperienceLedger append/commitment/receipt boundary is unavailable" } };
}

/** A bounded context retains its limitations and immutable source references.
 * No aggregate/predicate is silently computed on an omitted tail. */
export function boundBeliefView(view: BeliefView, maximumClaims: number, decisionContext?: BeliefDecisionContext): BeliefView {
  if (!Number.isSafeInteger(maximumClaims) || maximumClaims < 1 || maximumClaims > 1000) throw new Error("S1 claim limit must be 1..1000");
  const truncated = view.claims.length > maximumClaims;
  return createBeliefView({ tenantId: view.tenantId, principalId: view.principalId, root: view.root, validAt: view.validAt, knowledgeAt: view.knowledgeAt,
    rightsRevision: view.rights.revision, rightsEvaluatedAt: view.rights.evaluatedAt, claims: view.claims.slice(0, maximumClaims), sourceCuts: view.sourceCuts,
    dependencyRefs: view.experience.event.dependencyRefs, episodeId: view.experience.event.episodeId,
    coverage: { ...view.coverage, status: truncated ? "PARTIAL" : view.coverage.status, truncated: truncated || view.coverage.truncated,
      omittedScope: [...view.coverage.omittedScope, ...(truncated ? ["PERMITTED_CONTEXT_BUDGET"] : [])], reasons: [...view.coverage.reasons, ...(truncated ? ["PERMITTED_CONTEXT_BUDGET_TRUNCATED"] : [])] } }, decisionContext);
}

export function beliefOwnerRef(owner: string, entityType: string, id: string, revisionId: string, contentDigest: string): BeliefOwnerRef {
  return { owner, entityType, id, revisionId, contentDigest };
}

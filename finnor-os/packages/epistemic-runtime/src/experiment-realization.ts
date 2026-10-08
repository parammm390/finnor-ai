import type { ExperimentCollectionHandoff, ExperimentProtocol, ExperimentRealization, ExperimentRef, ExperimentTelemetry, ExperimentTelemetryKind, S2ExperienceEvent } from "@finnor/shared-types";
import { z } from "zod";
import { epistemicHash } from "./source-precedence";
import { assertExperimentProtocol, ExperimentContractError, ExperimentRefSchema, freezeExperiment, prepareS2ExperienceEvent, sameExperimentRef } from "./experiments";
import { conditionalMeasurementAnalysis, ER_ZERO, ExperimentRational, registeredStatisticalStop } from "./experiment-numerics";

const text = z.string().min(1).max(512), decimal = z.string().max(32).regex(/^\d+(?:\.\d{1,12})?$/);
const dataSchemas: Record<ExperimentTelemetryKind, z.ZodTypeAny> = {
  SELECTION: z.object({ policyRef: ExperimentRefSchema, status: z.enum(["SELECTED", "REJECTED"]), reason: text }).strict(),
  ALLOCATION: z.object({ commitmentRef: ExperimentRefSchema, status: z.enum(["SUPPLIED", "REVOKED"]), reason: text }).strict(),
  ASSIGNMENT: z.object({ unitId: text, targetRef: ExperimentRefSchema, probability: decimal }).strict(),
  ATTEMPT: z.object({ unitId: text, assignmentId: text, effectRef: ExperimentRefSchema }).strict(),
  ACKNOWLEDGMENT: z.object({ attemptId: text, status: z.enum(["ACKNOWLEDGED", "FAILED", "UNKNOWN"]) }).strict(),
  EXPOSURE: z.object({ unitId: text, attemptId: text, quantity: decimal.nullable(), unit: text, status: z.enum(["MEASURED", "UNKNOWN"]) }).strict(),
  OBSERVATION: z.object({ unitId: text, exposureId: text, originId: text, instrumentRef: ExperimentRefSchema, endpointId: text, category: text.nullable(),
    status: z.enum(["MEASURED", "MISSING", "CENSORED", "UNKNOWN"]), observationRef: ExperimentRefSchema }).strict(),
  VERIFICATION: z.object({ observationId: text, status: z.enum(["VERIFIED", "FAILED", "UNKNOWN"]), methodRef: ExperimentRefSchema }).strict(),
  RECONCILIATION: z.object({ unknownEventId: text, resolution: z.enum(["NO_EXPOSURE", "MEASURED_EXPOSURE"]), resolvedExposureId: text.nullable(), evidenceRef: ExperimentRefSchema, reason: text }).strict(),
  COST: z.object({ itemId: text, dimension: z.enum(["money", "elapsedMs", "humanSeconds", "dataBytes", "integrationUnits", "computeMs", "privacyUnits"]), amount: decimal.nullable(), unit: text, supersedes: text.nullable() }).strict(),
  CORRECTION: z.object({ supersedesEventId: text, reason: text }).strict(),
  BUSINESS_STOP: z.object({ policyRef: ExperimentRefSchema, reason: text }).strict(),
};
const telemetrySchema = z.object({ schema: z.literal("finnor.s2.reference-telemetry.v1"), id: text, tenantId: text, principalId: text, protocolRef: text,
  kind: z.enum(["SELECTION", "ALLOCATION", "ASSIGNMENT", "ATTEMPT", "ACKNOWLEDGMENT", "EXPOSURE", "OBSERVATION", "VERIFICATION", "RECONCILIATION", "COST", "CORRECTION", "BUSINESS_STOP"]),
  data: z.record(z.unknown()), parents: z.array(text).max(32), validAt: z.string().datetime({ offset: true }), knowledgeAt: z.string().datetime({ offset: true }),
  sourceRef: ExperimentRefSchema, trust: z.literal("SUPPLIED_UNAUTHENTICATED"), protectedReceipt: z.null() }).strict();
/** Explicit reference consumer helper. Content addressing provides no protected
 * history, source authentication, authorization, receipt or effect execution. */
export function referenceExperimentTelemetry(input: Omit<ExperimentTelemetry, "schema" | "id" | "trust" | "protectedReceipt">): ExperimentTelemetry {
  const body = { ...structuredClone(input), schema: "finnor.s2.reference-telemetry.v1" as const, trust: "SUPPLIED_UNAUTHENTICATED" as const, protectedReceipt: null };
  return freezeExperiment({ ...body, id: `telemetry:${epistemicHash(body)}` });
}
function parseTelemetry(input: unknown): ExperimentTelemetry {
  try { const event = telemetrySchema.parse(input); dataSchemas[event.kind].parse(event.data); const { id, ...body } = event;
    if (id !== `telemetry:${epistemicHash(body)}` || new Set(event.parents).size !== event.parents.length) throw new Error("Invalid event identity");
    const owner = ["SELECTION", "BUSINESS_STOP"].includes(event.kind) ? "S4" : event.kind === "ALLOCATION" ? "S5" : "S6";
    if (event.sourceRef.owner !== owner || Date.parse(event.validAt) > Date.parse(event.knowledgeAt)) throw new Error("Invalid source clock");
    return event;
  } catch { throw new ExperimentContractError("INVALID_REQUEST", "S2 realization requires bounded typed unadmitted source telemetry"); }
}
type Actor = { tenantId: string; principalId: string; now?: string };
function boundActor(protocol: ExperimentProtocol, actor: Actor): string {
  assertExperimentProtocol(protocol); const now = actor.now ?? new Date().toISOString();
  if (protocol.tenantId !== actor.tenantId || protocol.principalId !== actor.principalId || !Number.isFinite(Date.parse(now))) throw new ExperimentContractError("PERMITTED_CONTEXT_UNAVAILABLE", "Permitted S2 context is unavailable");
  return now;
}
export function projectExperimentRealization(protocol: ExperimentProtocol, supplied: readonly unknown[], actor: Actor): ExperimentRealization {
  const now = boundActor(protocol, actor);
  if (!Array.isArray(supplied) || supplied.length > 4096 || Buffer.byteLength(JSON.stringify(supplied)) > 4 * 1024 * 1024) throw new ExperimentContractError("LIMIT_EXCEEDED", "S2 telemetry exceeds the registered envelope");
  const unique = new Map<string, ExperimentTelemetry>();
  for (const raw of supplied) { const e = parseTelemetry(raw);
    if (e.tenantId !== actor.tenantId || e.principalId !== actor.principalId || e.protocolRef !== protocol.id) throw new ExperimentContractError("PERMITTED_CONTEXT_UNAVAILABLE", "Permitted S2 context is unavailable");
    // Historical projection cannot acquire later observations by their valid clock.
    if (Date.parse(e.knowledgeAt) <= Date.parse(now)) unique.set(e.id, e);
  }
  const deviations: ExperimentRealization["deviations"] = [];
  const deviation = (code: string, eventRefs: string[], reason = code) => { deviations.push({ code, eventRefs, reason }); };
  const history: ExperimentTelemetry[] = [], visited = new Set<string>(), visiting = new Set<string>();
  function visit(e: ExperimentTelemetry): void {
    if (visited.has(e.id)) return; if (visiting.has(e.id)) { deviation("CYCLIC_HISTORY", [e.id]); return; } visiting.add(e.id);
    for (const id of e.parents) { const parent = unique.get(id); if (!parent) { deviation("MISSING_PARENT", [e.id]); continue; }
      if (Date.parse(parent.knowledgeAt) > Date.parse(e.knowledgeAt)) deviation("PARENT_KNOWLEDGE_AFTER_CHILD", [e.id, id]); visit(parent); }
    visiting.delete(e.id); visited.add(e.id); history.push(e);
  }
  for (const e of [...unique.values()].sort((a, b) => Date.parse(a.knowledgeAt) - Date.parse(b.knowledgeAt))) visit(e);
  const filter = (kind: ExperimentTelemetryKind) => history.filter(e => e.kind === kind);
  const selections = filter("SELECTION"), allocations = filter("ALLOCATION"), assignments = filter("ASSIGNMENT"), attempts = filter("ATTEMPT"), acknowledgments = filter("ACKNOWLEDGMENT"), actualExposures = filter("EXPOSURE"), measuredObservations = filter("OBSERVATION"), reconciliations = filter("RECONCILIATION");
  for (const e of allocations) if (e.data.status === "REVOKED") deviation("ALLOCATION_REVOKED", [e.id]);
  const unknownOutcomes: ExperimentTelemetry[] = [], failures: ExperimentTelemetry[] = [], censored = measuredObservations.filter(e => ["MISSING", "CENSORED"].includes(String(e.data.status)));
  const requireParent = (e: ExperimentTelemetry, id: unknown, kind: ExperimentTelemetryKind): ExperimentTelemetry | undefined => {
    const parent = typeof id === "string" ? unique.get(id) : undefined;
    if (!parent || parent.kind !== kind || !e.parents.includes(parent.id)) { deviation("INVALID_STAGE_REFERENCE", [e.id]); return; } return parent;
  };
  const unitAssignments = new Map<string, ExperimentTelemetry>();
  for (const e of assignments) {
    const unitId = String(e.data.unitId); if (unitAssignments.has(unitId)) deviation("DUPLICATE_ASSIGNMENT_UNIT", [e.id, unitAssignments.get(unitId)!.id]); else unitAssignments.set(unitId, e);
    if (!sameExperimentRef(e.data.targetRef as ExperimentRef, protocol.candidate.populationRef) || e.data.probability !== "1") deviation("ASSIGNMENT_NONCOMPLIANCE", [e.id]);
  }
  const unitAttempts = new Set<string>();
  for (const e of attempts) {
    const assignment = requireParent(e, e.data.assignmentId, "ASSIGNMENT"); if (assignment && assignment.data.unitId !== e.data.unitId) deviation("ATTEMPT_UNIT_MISMATCH", [e.id]);
    if (unitAttempts.has(String(e.data.unitId))) deviation("RETRY_REQUIRES_EXTERNAL_RECONCILIATION", [e.id]); unitAttempts.add(String(e.data.unitId));
    const ack = acknowledgments.filter(a => a.data.attemptId === e.id);
    if (!ack.length || ack.some(a => a.data.status === "UNKNOWN")) unknownOutcomes.push(e);
    if (ack.some(a => a.data.status === "FAILED")) failures.push(e);
    if (ack.length > 1) deviation("CONFLICTING_ACKNOWLEDGMENT", ack.map(a => a.id));
  }
  for (const e of acknowledgments) requireParent(e, e.data.attemptId, "ATTEMPT");
  let exposureTotal = ER_ZERO; const exposureAttempts = new Set<string>();
  for (const e of actualExposures) {
    const attempt = requireParent(e, e.data.attemptId, "ATTEMPT"); if (attempt && attempt.data.unitId !== e.data.unitId) deviation("EXPOSURE_UNIT_MISMATCH", [e.id]);
    if (exposureAttempts.has(String(e.data.attemptId))) deviation("DUPLICATE_EXPOSURE", [e.id]); exposureAttempts.add(String(e.data.attemptId));
    if (e.data.status === "UNKNOWN" || e.data.quantity === null) { unknownOutcomes.push(e); continue; }
    const q = ExperimentRational.decimal(String(e.data.quantity)); exposureTotal = exposureTotal.add(q);
    if (e.data.unit !== protocol.candidate.measurementUnit || q.compare(ExperimentRational.decimal(protocol.candidate.exposure.unitsPerSample)) !== 0) deviation("EXPOSURE_NONCOMPLIANCE", [e.id]);
  }
  // An acknowledgment is not measured exposure. A successful attempt with no
  // exposure remains unknown, even if an instrument would prefer to retry it.
  for (const e of attempts) if (!failures.includes(e) && !actualExposures.some(x => x.data.attemptId === e.id) && !unknownOutcomes.includes(e)) unknownOutcomes.push(e);
  const origins = new Map<string, string>(), measuredUnits = new Set<string>(); const analyzableSample: ExperimentTelemetry[] = [];
  for (const e of measuredObservations) {
    const exposure = requireParent(e, e.data.exposureId, "EXPOSURE");
    if (exposure && exposure.data.unitId !== e.data.unitId) deviation("OBSERVATION_UNIT_MISMATCH", [e.id]);
    const origin = String(e.data.originId); if (origins.has(origin)) deviation("DUPLICATE_ORIGIN", [e.id, origins.get(origin)!]); else origins.set(origin, e.id);
    if (measuredUnits.has(String(e.data.unitId))) deviation("DUPLICATE_MEASUREMENT_UNIT", [e.id]); measuredUnits.add(String(e.data.unitId));
    if (!sameExperimentRef(e.data.instrumentRef as ExperimentRef, protocol.candidate.instrumentRef) || e.data.endpointId !== protocol.candidate.endpoint.id) deviation("INSTRUMENT_OR_ENDPOINT_DEVIATION", [e.id]);
    if (e.data.status === "UNKNOWN") unknownOutcomes.push(e);
    if (["MISSING", "CENSORED"].includes(String(e.data.status))) deviation("MISSINGNESS_OUTSIDE_REGISTERED_OUTCOME", [e.id]);
    if (e.data.status === "MEASURED" && !protocol.candidate.endpoint.categories.includes(String(e.data.category))) deviation("UNSUPPORTED_MEASURED_CATEGORY", [e.id]);
    const verifies = filter("VERIFICATION").filter(v => v.data.observationId === e.id);
    if (!verifies.length || verifies.some(v => v.data.status === "UNKNOWN")) unknownOutcomes.push(e);
    if (verifies.some(v => v.data.status === "FAILED")) { failures.push(e); deviation("OBSERVATION_VERIFICATION_FAILED", [e.id]); }
    if (verifies.length > 1) deviation("CONFLICTING_VERIFICATION", verifies.map(v => v.id));
    if (e.data.status === "MEASURED" && exposure?.data.status === "MEASURED" && verifies.length === 1 && verifies[0]!.data.status === "VERIFIED"
      && protocol.candidate.endpoint.categories.includes(String(e.data.category))) analyzableSample.push(e);
  }
  for (const e of filter("VERIFICATION")) requireParent(e, e.data.observationId, "OBSERVATION");
  for (const e of actualExposures) if (!measuredObservations.some(o => o.data.exposureId === e.id)) unknownOutcomes.push(e);
  const reconciled = new Set<string>();
  for (const e of reconciliations) {
    const original = unique.get(String(e.data.unknownEventId));
    if (!original || !unknownOutcomes.some(o => o.id === original.id) || !e.parents.includes(original.id) || reconciled.has(original.id) || !["ATTEMPT", "ACKNOWLEDGMENT", "EXPOSURE"].includes(original.kind)) { deviation("INVALID_RECONCILIATION_REFERENCE", [e.id]); continue; }
    const attemptId = original.kind === "ATTEMPT" ? original.id : String(original.data.attemptId);
    if (e.data.resolution === "NO_EXPOSURE") {
      if (e.data.resolvedExposureId !== null || actualExposures.some(x => x.data.attemptId === attemptId && x.data.status === "MEASURED")) { deviation("CONTRADICTORY_RECONCILIATION", [e.id]); continue; }
      const attempt = unique.get(attemptId); if (attempt && !failures.includes(attempt)) failures.push(attempt);
    } else {
      const measured = unique.get(String(e.data.resolvedExposureId));
      if (!measured || measured.kind !== "EXPOSURE" || measured.data.attemptId !== attemptId || measured.data.status !== "MEASURED" || !e.parents.includes(measured.id)) { deviation("INVALID_RECONCILIATION_EVIDENCE", [e.id]); continue; }
    }
    reconciled.add(original.id);
    for (const o of unknownOutcomes) if ((o.kind === "ATTEMPT" && o.id === attemptId) || (o.kind === "ACKNOWLEDGMENT" && o.data.attemptId === attemptId)) reconciled.add(o.id);
  }
  for (let i = unknownOutcomes.length - 1; i >= 0; i--) if (reconciled.has(unknownOutcomes[i]!.id)) unknownOutcomes.splice(i, 1);
  for (const e of failures) deviation("COLLECTION_FAILURE_OUTSIDE_REGISTERED_MEASUREMENT_PROCESS", [e.id], "Failed or unmeasured assigned units need a qualified missingness/selection model; they cannot silently disappear from a calibrated sample");
  for (const e of filter("CORRECTION")) { if (!unique.has(String(e.data.supersedesEventId)) || !e.parents.includes(String(e.data.supersedesEventId))) deviation("INVALID_CORRECTION_REFERENCE", [e.id]);
    deviation("MEASUREMENT_CORRECTION_REQUIRES_NEW_ANALYSIS_VERSION", [e.id, String(e.data.supersedesEventId)]); }
  if (unitAssignments.size > protocol.candidate.samples || attempts.length > protocol.candidate.samples || actualExposures.length > protocol.candidate.samples) deviation("SAMPLE_LIMIT_EXCEEDED", history.map(e => e.id));
  if (exposureTotal.compare(ExperimentRational.decimal(protocol.constraints.maxExposureUnits)) > 0) deviation("EXPOSURE_LIMIT_EXCEEDED", actualExposures.map(e => e.id));
  if (Date.parse(now) > Date.parse(protocol.validUntil)) deviation("EXPIRED_PROTOCOL", []);
  for (const e of [...attempts, ...actualExposures, ...measuredObservations]) if (Date.parse(e.validAt) < Date.parse(protocol.candidate.timing.startAt) || Date.parse(e.validAt) > Date.parse(protocol.candidate.timing.endAt)) deviation("COLLECTION_OUTSIDE_REGISTERED_TIMING", [e.id]);
  if (attempts.length && Date.parse(now) - Date.parse(attempts[0]!.knowledgeAt) > protocol.constraints.maxElapsedMs) deviation("COLLECTION_TIME_LIMIT_EXCEEDED", attempts.map(e => e.id));
  const latestCost = new Map<string, ExperimentTelemetry>();
  for (const e of filter("COST")) {
    const item = String(e.data.itemId), prior = latestCost.get(item);
    if ((prior && (e.data.supersedes !== prior.id || !e.parents.includes(prior.id) || e.data.unit !== prior.data.unit || e.data.dimension !== prior.data.dimension)) || (!prior && e.data.supersedes !== null)) {
      deviation("INVALID_COST_REVISION", [e.id]); continue;
    }
    latestCost.set(item, e);
  }
  const costGroups = new Map<string, { dimension: string; unit: string; total: ExperimentRational; unknown: boolean; refs: string[] }>();
  for (const e of latestCost.values()) {
    const dimension = String(e.data.dimension), unit = String(e.data.unit), key = `${dimension}:${unit}`; const row = costGroups.get(key) ?? { dimension, unit, total: ER_ZERO, unknown: false, refs: [] };
    if (e.data.amount === null) row.unknown = true; else row.total = row.total.add(ExperimentRational.decimal(String(e.data.amount))); row.refs.push(e.id); costGroups.set(key, row);
  }
  const actualCosts: ExperimentRealization["actualCosts"] = [...costGroups.values()].map(row => ({ dimension: row.dimension, unit: row.unit, amount: row.unknown ? null : row.total.decimalString(), knownSubtotal: row.total.decimalString(), eventRefs: row.refs, basis: "SUPPLIED_ACCOUNTING_UNVERIFIED" }));
  const missingDimensions = ["money", "elapsedMs", "humanSeconds", "dataBytes", "integrationUnits", "computeMs", "privacyUnits"].filter(d => !actualCosts.some(c => c.dimension === d && c.amount !== null));
  for (const row of costGroups.values()) {
    if (row.dimension === "money" && protocol.constraints.moneyLimit) { if (row.unknown || row.unit !== protocol.constraints.moneyLimit.unit) deviation("MONEY_ACTUAL_UNRECONCILED", row.refs);
      else if (row.total.compare(ExperimentRational.decimal(protocol.constraints.moneyLimit.value)) > 0) deviation("MONEY_LIMIT_EXCEEDED", row.refs); }
    if (row.dimension === "elapsedMs" && (row.unknown || row.unit !== "milliseconds" || row.total.compare(new ExperimentRational(BigInt(Math.floor(protocol.constraints.maxElapsedMs)))) > 0)) deviation("TIME_ACTUAL_UNKNOWN_OR_LIMIT_EXCEEDED", row.refs);
    if (row.dimension === "privacyUnits" && (row.unknown || row.unit !== "privacy-units" || row.total.compare(ExperimentRational.decimal(protocol.constraints.maxPrivacyUnits)) > 0)) deviation("PRIVACY_ACTUAL_UNKNOWN_OR_LIMIT_EXCEEDED", row.refs);
  }
  const counts = Array<number>(protocol.candidate.endpoint.categories.length).fill(0), steps: ExperimentRealization["analysis"]["steps"] = [];
  let stop: ExperimentRealization["analysis"]["statisticalStop"] = "CONTINUE";
  for (const e of analyzableSample) {
    if (stop !== "CONTINUE") deviation("COLLECTION_AFTER_REGISTERED_STOP", [e.id]);
    const priorObservation = steps.length ? unique.get(steps[steps.length - 1]!.observationRef) : null;
    if (priorObservation && Date.parse(e.validAt) - Date.parse(priorObservation.validAt) < protocol.candidate.timing.minimumIntervalMs) deviation("REGISTERED_MEASUREMENT_INTERVAL_VIOLATED", [priorObservation.id, e.id]);
    counts[protocol.candidate.endpoint.categories.indexOf(String(e.data.category))]!++;
    if (counts.reduce((a, b) => a + b, 0) <= protocol.candidate.samples) stop = registeredStatisticalStop(protocol.candidate, counts, protocol.hypotheses.length);
    steps.push({ observationRef: e.id, cumulativeSampleSize: counts.reduce((a, b) => a + b, 0), counts: [...counts], statisticalStop: stop });
  }
  const conditional = counts.reduce((a, b) => a + b, 0) <= 24 ? conditionalMeasurementAnalysis(protocol, counts) : null;
  if (!conditional) deviation("OBSERVATION_IMPOSSIBLE_UNDER_SUPPLIED_HYPOTHESES", analyzableSample.map(e => e.id));
  const valid = deviations.length === 0;
  const businessStops = [...filter("BUSINESS_STOP"), ...selections.filter(e => e.data.status === "REJECTED")];
  const disposition: ExperimentRealization["collectionDisposition"] = !valid ? "DEVIATION_HALT" : unknownOutcomes.length ? "RECONCILE_UNKNOWN" : businessStops.length ? "BUSINESS_STOP"
    : ["REJECT_H0", "REJECT_H1"].includes(stop) ? "STATISTICAL_STOP" : stop === "SAMPLE_LIMIT" || assignments.length >= protocol.candidate.samples ? "COLLECTION_LIMIT" : "CONTINUE_REFERENCE";
  const eventType = (e: ExperimentTelemetry): S2ExperienceEvent["type"] => e.kind === "SELECTION" ? "SELECTION" : e.kind === "ALLOCATION" ? "ALLOCATION_REFERENCE" : e.kind === "COST" ? "COST" : e.kind === "CORRECTION" ? "CORRECTION" : e.kind === "BUSINESS_STOP" ? "STOPPING" : "COLLECTION";
  const eventBase = { schema: "finnor.s2.experience.v1" as const, episodeId: protocol.episodeId, semanticOwner: "S2" as const, tenantId: actor.tenantId, principalId: actor.principalId, rightsRef: protocol.beliefBinding.rightsRef,
    causalParents: [] as [], revisionRef: protocol.id, contentDigest: protocol.contentDigest, dependencyRefs: [protocol.requestDigest, protocol.beliefBinding.dependencyDigest], freshnessRef: protocol.beliefBinding.dependencyDigest,
    uncertainty: "SUPPLIED_UNAUTHENTICATED_TELEMETRY" as const, horizon: "H1" as const, provenanceRefs: protocol.dependencies, modelComputeRef: null };
  const experience = history.map(e => prepareS2ExperienceEvent({ ...eventBase, type: eventType(e), preparedParentRefs: [protocol.experience.event.eventId, ...e.parents], validAt: e.validAt, knowledgeAt: e.knowledgeAt,
    detail: { telemetryRef: e.id, sourceOwner: e.sourceRef.owner, kind: e.kind, trust: e.trust } }));
  for (const step of steps) { const observed = unique.get(step.observationRef)!; experience.push(prepareS2ExperienceEvent({ ...eventBase, type: "STOPPING", preparedParentRefs: [protocol.id, step.observationRef],
    validAt: observed.validAt, knowledgeAt: observed.knowledgeAt, detail: { ...step, registeredMethod: protocol.candidate.stopping.method, statisticalValidity: valid ? "MODEL_CONDITIONAL_REFERENCE" : "INVALID" } })); }
  for (const d of deviations) experience.push(prepareS2ExperienceEvent({ ...eventBase, type: "DEVIATION", preparedParentRefs: d.eventRefs, validAt: now, knowledgeAt: now, detail: d }));
  if (disposition !== "CONTINUE_REFERENCE") experience.push(prepareS2ExperienceEvent({ ...eventBase, type: "STOPPING", preparedParentRefs: experience.map(e => e.eventId), validAt: now, knowledgeAt: now,
    detail: { collectionDisposition: disposition, statisticalStop: valid ? stop : "INVALID", businessStopRefs: businessStops.map(e => e.id) } }));
  const body: Omit<ExperimentRealization, "id" | "contentDigest"> = { schema: "finnor.experiment-realization.v1", semanticOwner: "S2_MEASUREMENT_PROJECTION", protocolRef: protocol.id,
    priorRealizationRef: null, tenantId: actor.tenantId, principalId: actor.principalId, knowledgeAt: now, history, selections, allocations, assignments, attempts, acknowledgments, reconciliations, actualExposures, measuredObservations, analyzableSample, censored, failures,
    unknownOutcomes: [...new Map(unknownOutcomes.map(e => [e.id, e])).values()], deviations, actualCosts, accountingCoverage: { status: missingDimensions.length ? "PARTIAL" : "COMPLETE_SUPPLIED_UNVERIFIED", missingDimensions, independentlyAudited: false },
    analysis: { valid, basis: "SUPPLIED_MODEL_AND_UNAUTHENTICATED_REFERENCE_TELEMETRY", counts, posteriorByHypothesis: valid ? conditional!.posteriorByHypothesis : null, conditionalLossByAction: valid ? conditional!.conditionalLossByAction : null,
      steps, statisticalStop: valid ? stop : "INVALID", reasons: ["UNADMITTED_SOURCE_AUTHENTICATION_AND_ORDER", "NO_FIELD_LIKELIHOOD_CALIBRATION", ...deviations.map(d => d.code)] }, collectionDisposition: disposition,
    lineage: { hypothesisRefs: protocol.hypotheses.map(h => h.ref), mandateRef: protocol.mandateRef, policyRefs: [...selections, ...businessStops].map(e => e.data.policyRef as ExperimentRef), allocationRefs: allocations.map(e => e.data.commitmentRef as ExperimentRef),
      effectRefs: attempts.map(e => e.data.effectRef as ExperimentRef), observationRefs: measuredObservations.map(e => e.data.observationRef as ExperimentRef), attributionGranted: false }, experience,
    admission: { status: "BLOCKED_EXTERNAL", protectedHistoryComplete: false, executionAuthorityGranted: false, receipt: null } };
  const digest = epistemicHash(body); if (Buffer.byteLength(JSON.stringify(body)) > 4 * 1024 * 1024) throw new ExperimentContractError("LIMIT_EXCEEDED", "S2 realization exceeds 4 MiB");
  return freezeExperiment({ ...body, id: `realization:${digest}`, contentDigest: digest });
}
export function resumeExperimentRealization(protocol: ExperimentProtocol, prior: ExperimentRealization, additional: readonly unknown[], actor: Actor): ExperimentRealization {
  const now = boundActor(protocol, actor), { id, contentDigest, ...priorBody } = prior;
  if (id !== `realization:${epistemicHash(priorBody)}` || contentDigest !== epistemicHash(priorBody) || prior.protocolRef !== protocol.id || prior.tenantId !== actor.tenantId || prior.principalId !== actor.principalId
    || Date.parse(prior.knowledgeAt) > Date.parse(now) || !Array.isArray(prior.history)) throw new ExperimentContractError("INVALID_PROTOCOL", "S2 prior realization identity is invalid");
  // The caller cannot remove prior observations/costs or reset the registered
  // sample/error budget when using this resume contract. Protected completeness
  // and detection of an omitted initial history still require S6.
  const resumed = projectExperimentRealization(protocol, [...prior.history, ...additional], { ...actor, now });
  const { id: _id, contentDigest: _digest, ...body } = resumed; const next = { ...body, priorRealizationRef: prior.id }; const digest = epistemicHash(next);
  return freezeExperiment({ ...next, id: `realization:${digest}`, contentDigest: digest });
}
export function prepareExperimentCollectionHandoff(protocol: ExperimentProtocol, realization: ExperimentRealization, actor: Actor): ExperimentCollectionHandoff {
  boundActor(protocol, actor); const { id, contentDigest, ...body } = realization;
  if (realization.protocolRef !== protocol.id || realization.tenantId !== actor.tenantId || realization.principalId !== actor.principalId || contentDigest !== epistemicHash(body) || id !== `realization:${contentDigest}`
    || realization.admission.executionAuthorityGranted !== false || realization.admission.receipt !== null) throw new ExperimentContractError("INVALID_PROTOCOL", "S2 realization identity is invalid");
  return freezeExperiment({ schema: "finnor.s2.collection-handoff.v1", status: "BLOCKED_EXTERNAL", executionAuthorityGranted: false, receipt: null, protocolRef: protocol.id, realizationRef: realization.id,
    nextOperation: realization.collectionDisposition === "RECONCILE_UNKNOWN" ? "RECONCILE_UNKNOWN" : realization.collectionDisposition === "CONTINUE_REFERENCE" ? "OBSERVE_REGISTERED_UNIT" : "NO_FURTHER_COLLECTION",
    ir: { version: "s2-collection-ir-v1", tenantId: actor.tenantId, principalId: actor.principalId, rightsRef: protocol.beliefBinding.rightsRef, beliefPin: protocol.beliefBinding.pin, mandateRef: protocol.mandateRef, candidate: protocol.candidate,
      remainingSamples: Math.max(0, protocol.candidate.samples - realization.assignments.length), maximumExposure: protocol.constraints.maxExposureUnits, maximumPrivacy: protocol.constraints.maxPrivacyUnits, moneyLimit: protocol.constraints.moneyLimit, expiry: protocol.validUntil },
    requiredContracts: [{ owner: "S4", requirement: "Admitted current joint mandate and immutable inquiry selection/policy reference; business continuation remains S4" },
      { owner: "S5", requirement: "Current allocation certificate/reservations with independent exposure/cost accounting" },
      { owner: "S6", requirement: "Protected ExperienceLedger append/source order/receipt; final effect-bound rights/revocation/fence/reservation checks; collect or reconcile without blind retry" },
      { owner: "S7", requirement: "Preregistered measurement/assignment estimand joins and independent field instrument/actual-exposure qualification" }],
    outcomeRegistration: { protocolRef: protocol.id, realizationRef: realization.id, assignmentRefs: realization.assignments.map(e => e.id), actualExposureRefs: realization.actualExposures.map(e => e.id),
      measurementRefs: realization.measuredObservations.map(e => e.id), analyzableRefs: realization.analyzableSample.map(e => e.id), deviationRefs: realization.deviations.flatMap(d => d.eventRefs), costRefs: realization.history.filter(e => e.kind === "COST").map(e => e.id), creditGranted: false } });
}

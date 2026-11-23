import { z } from "zod";
import { r2Quantity, r2MeasuredQuantity, r2String, r2Zero } from "../r2-rational";
import { epistemicHash } from "../source-precedence";

const ref = z.string().min(1).max(2048);
const refs = z.array(ref).refine(v => new Set(v).size === v.length, "Duplicate evidence reference");
const quantity = z.string().superRefine((value, ctx) => {
  try { if (r2Quantity(value).n < 0n) throw Error("Negative"); }
  catch { ctx.addIssue({ code: "custom", message: "Invalid nonnegative rational" }); }
});
const measured = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const time = z.string().datetime({ offset: true });
export const responsePinsSchema = z.object({
  sourceRef: ref, modelRef: ref, providerRef: ref, methodRef: ref,
  priceRef: ref, checkerRef: ref, runtimeRef: ref,
}).strict();
export const responseFeaturesSchema = z.object({
  structureRef: ref, outcomeClassRef: ref, domainRef: ref,
}).strict();
const costSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("KNOWN"), amount: quantity, unit: ref }).strict(),
  z.object({ status: z.literal("UNKNOWN"), reason: ref }).strict(),
]);
export const responseObservationSchema = z.object({
  id: ref, workId: ref, unitId: ref, split: z.enum(["TRAIN", "CALIBRATION"]),
  features: responseFeaturesSchema, treatmentRef: ref, traceRef: ref,
  evidenceRefs: refs.min(1), premiseRefs: refs.min(1), assignmentRef: ref,
  assignmentProbability: quantity.refine(v => r2Quantity(v).n > 0n && r2Quantity(v).compare(r2Quantity("1")) <= 0, "Invalid assignment probability"),
  accepted: z.boolean(), acceptanceRef: ref, censored: z.boolean(), humanRescue: z.boolean(),
  observedAt: time, latencyMs: measured, cpuMs: measured,
  peakMemoryBytes: measured.int(), humanSeconds: measured, monetaryCost: costSchema,
}).strict();
export const responseDatasetSchema = z.object({
  schema: z.literal("finnor.orchestration-response-dataset.v1"), datasetId: ref,
  tenantId: ref, principalId: ref, purposeRef: ref, populationRef: ref,
  sourceClass: z.enum(["SYNTHETIC_DEVELOPMENT", "CONTROLLED_NATIVE", "NATIVE_RECORDS"]),
  protocol: z.object({
    kind: z.enum(["RANDOMIZED_INDEPENDENT_UNITS", "LOGGED_ASSOCIATION"]),
    ref, confidenceLevel: z.number().gt(0).lt(1),
  }).strict(),
  pins: responsePinsSchema, knowledgeAt: time, validUntil: time, samples: z.array(responseObservationSchema),
}).strict();
export type ResponseDataset = z.infer<typeof responseDatasetSchema>;
export type ResponseObservation = ResponseDataset["samples"][number];
export type ResponsePins = z.infer<typeof responsePinsSchema>;
export type ResponseFeatures = z.infer<typeof responseFeaturesSchema>;
const estimateSchema = z.object({
  key: ref, features: responseFeaturesSchema, treatmentRef: ref,
  trainingSamples: z.number().int().positive(), independentUnits: z.number().int().positive(),
  acceptanceMean: quantity, acceptanceBounds: z.tuple([quantity, quantity]),
  latencyMeanMs: quantity, cpuMeanMs: quantity, peakMemoryBytes: measured.int(),
  humanMeanSeconds: quantity, monetaryCost: costSchema, calibrationSamples: z.number().int().nonnegative(),
  calibrationAcceptance: quantity.nullable(),
  identification: z.enum(["RANDOMIZED_DESIGN_CONDITIONAL", "ASSOCIATIONAL_ONLY"]),
  premiseRefs: refs, observationRefs: refs,
}).strict();
const stateBodySchema = z.object({
  schema: z.literal("finnor.orchestration-response-state.v1"),
  estimatorVersion: z.literal("joint-unit-response-v1"), datasetRef: ref, previousRef: ref.nullable(),
  tenantId: ref, principalId: ref, purposeRef: ref, populationRef: ref,
  sourceClass: responseDatasetSchema.shape.sourceClass, protocol: responseDatasetSchema.shape.protocol,
  pins: responsePinsSchema, knowledgeAt: responseDatasetSchema.shape.knowledgeAt, validUntil: time, estimates: z.array(estimateSchema),
  limitations: refs,
}).strict();
export const responseStateSchema = stateBodySchema.extend({ ref }).strict();
export type ResponseState = z.infer<typeof responseStateSchema>;
export type ResponseEstimate = ResponseState["estimates"][number];
export const responseQuerySchema = z.object({
  tenantId: ref, principalId: ref, purposeRef: ref, populationRef: ref, protocolRef: ref,
  pins: responsePinsSchema, features: responseFeaturesSchema, treatmentRef: ref, now: time,
}).strict();
const keyOf = (features: ResponseFeatures, treatmentRef: string) => epistemicHash({ features, treatmentRef });
const equal = (a: unknown, b: unknown) => epistemicHash(a) === epistemicHash(b);

function mean(values: ReturnType<typeof r2Quantity>[]) {
  if (!values.length) throw Error("RESPONSE_EMPTY_MEAN");
  return values.reduce((sum, q) => sum.add(q), r2Zero()).div(r2Quantity(String(values.length)));
}

export function parseResponseDataset(input: unknown): ResponseDataset {
  const dataset = responseDatasetSchema.parse(input), sampleIds = new Set<string>();
  const splitByWork = new Map<string, string>(), splitByUnit = new Map<string, string>(), splitByPremise = new Map<string, string>();
  if (Date.parse(dataset.knowledgeAt) > Date.parse(dataset.validUntil)) throw Error("RESPONSE_KNOWLEDGE_CUT_AFTER_VALIDITY");
  for (const sample of dataset.samples) {
    if (sampleIds.has(sample.id)) throw Error("RESPONSE_DUPLICATE_OBSERVATION");
    sampleIds.add(sample.id);
    const workSplit = splitByWork.get(sample.workId);
    if (workSplit !== undefined && workSplit !== sample.split) throw Error("RESPONSE_WORK_SPLIT_LEAKAGE");
    splitByWork.set(sample.workId, sample.split);
    const previous = splitByUnit.get(sample.unitId);
    if (previous !== undefined && previous !== sample.split) throw Error("RESPONSE_UNIT_SPLIT_LEAKAGE");
    splitByUnit.set(sample.unitId, sample.split);
    for (const premise of sample.premiseRefs) {
      const old = splitByPremise.get(premise);
      if (old !== undefined && old !== sample.split) throw Error("RESPONSE_PREMISE_SPLIT_LEAKAGE");
      splitByPremise.set(premise, sample.split);
    }
    if (Date.parse(sample.observedAt) > Date.parse(dataset.validUntil)) throw Error("RESPONSE_OBSERVATION_AFTER_VALIDITY");
    if (Date.parse(sample.observedAt) > Date.parse(dataset.knowledgeAt)) throw Error("RESPONSE_OBSERVATION_AFTER_KNOWLEDGE_CUT");
  }
  return dataset;
}

/** Shared lineage collapses confidence even when a caller supplied distinct unit IDs. */
function independentGroups(samples: ResponseObservation[]): ResponseObservation[][] {
  const groups: ResponseObservation[][] = [];
  for (const sample of samples) {
    const related = groups.filter(group => group.some(other =>
      other.workId === sample.workId || other.unitId === sample.unitId || other.premiseRefs.some(ref => sample.premiseRefs.includes(ref))));
    if (!related.length) { groups.push([sample]); continue; }
    const merged = [sample, ...related.flat()];
    for (const group of related) groups.splice(groups.indexOf(group), 1);
    groups.push(merged);
  }
  return groups;
}
function monetaryMean(groups: ResponseObservation[][]): z.infer<typeof costSchema> {
  const units = new Set<string>();
  for (const sample of groups.flat()) {
    if (sample.monetaryCost.status === "UNKNOWN") return { status: "UNKNOWN", reason: "COMPLETE_OBSERVED_COST_UNKNOWN" };
    units.add(sample.monetaryCost.unit);
  }
  if (units.size !== 1) return { status: "UNKNOWN", reason: "INCOMPARABLE_ORIGINAL_COST_UNITS" };
  const unit = [...units][0];
  if (unit === undefined) return { status: "UNKNOWN", reason: "NO_COST_OBSERVATIONS" };
  const groupCosts = groups.map(group => mean(group.map(sample => {
    if (sample.monetaryCost.status !== "KNOWN") throw Error("RESPONSE_COST_BOUNDARY");
    return r2Quantity(sample.monetaryCost.amount);
  })));
  return { status: "KNOWN", amount: r2String(mean(groupCosts)), unit };
}

/** Saturated joint treatments: absent combinations remain absent, never additive extrapolation. */
export function fitResponseState(input: unknown, previousRef: string | null = null): ResponseState {
  const dataset = parseResponseDataset(input), buckets = new Map<string, ResponseObservation[]>();
  for (const sample of dataset.samples) {
    if (sample.split !== "TRAIN") continue;
    const key = keyOf(sample.features, sample.treatmentRef), bucket = buckets.get(key) ?? [];
    bucket.push(sample); buckets.set(key, bucket);
  }
  const estimates: ResponseEstimate[] = [];
  for (const [key, samples] of buckets) {
    const first = samples[0];
    if (first === undefined) throw Error("RESPONSE_EMPTY_BUCKET");
    const groups = independentGroups(samples);
    const accept = mean(groups.map(group => mean(group.map(s => r2Quantity(s.accepted && !s.censored && !s.humanRescue ? "1" : "0")))));
    const random = dataset.protocol.kind === "RANDOMIZED_INDEPENDENT_UNITS" &&
      new Set(samples.map(s => r2String(r2Quantity(s.assignmentProbability)))).size === 1;
    const probability = Number(accept.n) / Number(accept.d);
    const radius = Math.sqrt(Math.log(2 * Math.max(1, buckets.size) / (1 - dataset.protocol.confidenceLevel)) / (2 * groups.length));
    const lower = random ? Math.max(0, Math.floor((probability - radius) * 1e12) / 1e12) : 0;
    const upper = random ? Math.min(1, Math.ceil((probability + radius) * 1e12) / 1e12) : 1;
    const calibration = dataset.samples.filter(s => s.split === "CALIBRATION" && keyOf(s.features, s.treatmentRef) === key);
    const calibrationGroups = independentGroups(calibration);
    estimates.push({
      key, features: first.features, treatmentRef: first.treatmentRef,
      trainingSamples: samples.length, independentUnits: groups.length, acceptanceMean: r2String(accept),
      acceptanceBounds: [r2String(r2MeasuredQuantity(lower)), r2String(r2MeasuredQuantity(upper))],
      latencyMeanMs: r2String(mean(groups.map(group => mean(group.map(s => r2MeasuredQuantity(s.latencyMs)))))),
      cpuMeanMs: r2String(mean(groups.map(group => mean(group.map(s => r2MeasuredQuantity(s.cpuMs)))))),
      peakMemoryBytes: Math.max(...samples.map(s => s.peakMemoryBytes)),
      humanMeanSeconds: r2String(mean(groups.map(group => mean(group.map(s => r2MeasuredQuantity(s.humanSeconds)))))),
      monetaryCost: monetaryMean(groups), calibrationSamples: calibration.length,
      calibrationAcceptance: calibrationGroups.length ? r2String(mean(calibrationGroups.map(group =>
        mean(group.map(s => r2Quantity(s.accepted && !s.censored && !s.humanRescue ? "1" : "0")))))) : null,
      identification: random ? "RANDOMIZED_DESIGN_CONDITIONAL" : "ASSOCIATIONAL_ONLY",
      premiseRefs: [...new Set(samples.flatMap(s => s.premiseRefs))].sort(),
      observationRefs: samples.map(s => s.id).sort(),
    });
  }
  estimates.sort((a, b) => a.key.localeCompare(b.key));
  const body = stateBodySchema.parse({
    schema: "finnor.orchestration-response-state.v1", estimatorVersion: "joint-unit-response-v1",
    datasetRef: `orchestration-response-dataset:${epistemicHash(dataset)}`, previousRef,
    tenantId: dataset.tenantId, principalId: dataset.principalId, purposeRef: dataset.purposeRef,
    populationRef: dataset.populationRef, sourceClass: dataset.sourceClass, protocol: dataset.protocol,
    pins: dataset.pins, knowledgeAt: dataset.knowledgeAt, validUntil: dataset.validUntil, estimates,
    limitations: ["ORIGINAL_ACCEPTANCE_OWNER_UNCHANGED", "NO_PROTECTED_ADMISSION_OR_FIELD_QUALIFICATION",
      "NO_ADDITIVE_OR_MONOTONE_EXTRAPOLATION", "CONFIDENCE_CONDITIONAL_ON_REGISTERED_UNIT_ASSIGNMENT_AND_LINEAGE",
      "NO_UNIVERSAL_TRANSPORT_OR_CAUSAL_GAIN_CLAIM", "UNKNOWN_DOLLARS_REMAIN_UNKNOWN",
      "CONTROLLER_CHECKER_AND_NATIVE_OVERHEAD_REQUIRE_SEPARATE_METERING"],
  });
  return { ...body, ref: `orchestration-response-state:${epistemicHash(body)}` };
}

export function appendResponseObservations(input: unknown, observations: unknown, knowledgeAt: string): ResponseDataset {
  const original = parseResponseDataset(input), added = z.array(responseObservationSchema).parse(observations);
  const cut = time.parse(knowledgeAt);
  if (Date.parse(cut) < Date.parse(original.knowledgeAt)) throw Error("RESPONSE_KNOWLEDGE_CUT_REGRESSION");
  return parseResponseDataset({ ...original, knowledgeAt: cut, samples: [...original.samples, ...added] });
}

export function responseEstimate(stateInput: unknown, queryInput: unknown):
  | { status: "AVAILABLE"; stateRef: string; estimate: ResponseEstimate; authorityGranted: false }
  | { status: "UNKNOWN"; reason: string; authorityGranted: false } {
  const state = responseStateSchema.parse(stateInput), query = responseQuerySchema.parse(queryInput);
  const { ref: stateRef, ...body } = state;
  const unavailable = (reason: string) => ({ status: "UNKNOWN" as const, reason, authorityGranted: false as const });
  if (stateRef !== `orchestration-response-state:${epistemicHash(body)}`) return unavailable("ALTERED_FITTED_STATE");
  if (state.tenantId !== query.tenantId || state.principalId !== query.principalId ||
      state.purposeRef !== query.purposeRef || state.populationRef !== query.populationRef) return unavailable("LAWFUL_CONTEXT_OR_POPULATION_MISMATCH");
  if (state.protocol.ref !== query.protocolRef || !equal(state.pins, query.pins)) return unavailable("DEPENDENT_REVISION_DRIFT");
  if (Date.parse(query.now) < Date.parse(state.knowledgeAt)) return unavailable("RESPONSE_STATE_AFTER_KNOWLEDGE_CUT");
  if (Date.parse(query.now) >= Date.parse(state.validUntil)) return unavailable("RESPONSE_STATE_EXPIRED");
  const estimate = state.estimates.find(e => e.key === keyOf(query.features, query.treatmentRef));
  if (estimate === undefined) return unavailable("UNOBSERVED_JOINT_TREATMENT_OR_TASK_STRUCTURE");
  return { status: "AVAILABLE", stateRef, estimate: structuredClone(estimate), authorityGranted: false };
}

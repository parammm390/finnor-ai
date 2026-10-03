import type { BeliefView, ExperimentCandidate, ExperimentDesignBundle, ExperimentDesignRequest, ExperimentProtocol, ExperimentRef, ModelComputeInvocation, S2ExperienceEvent } from "@finnor/shared-types";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { epistemicHash } from "./source-precedence";
import { ER_ONE, ER_ZERO, ExperimentRational, exactExperimentMetrics, sumRationals } from "./experiment-numerics";

export class ExperimentContractError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "INVALID_PROTOCOL" | "PERMITTED_CONTEXT_UNAVAILABLE" | "LIMIT_EXCEEDED", message: string) { super(message); this.name = "ExperimentContractError"; }
}
const text = z.string().min(1).max(256);
const instant = z.string().datetime({ offset: true });
const decimal = z.string().max(32).regex(/^\d+(?:\.\d{1,12})?$/);
export const ExperimentRefSchema = z.object({ owner: text, id: text, version: text, contentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const quantity = z.object({ value: decimal, unit: text }).strict();
const nullableNumber = z.number().finite().nonnegative().max(1e12).nullable();
export const ExperimentCandidateSchema = z.object({ id: text, instrumentRef: ExperimentRefSchema, endpoint: z.object({ id: text, unit: text, categories: z.array(text).min(2).max(3) }).strict(),
  populationRef: ExperimentRefSchema, measurementUnit: text, assignment: z.object({ kind: z.literal("OBSERVATIONAL"), unit: text, probability: z.literal("1") }).strict(),
  timing: z.object({ startAt: instant, endAt: instant, minimumIntervalMs: z.number().finite().nonnegative().max(1e12) }).strict(),
  process: z.object({ methodRef: ExperimentRefSchema, instrumentError: z.enum(["IN_LIKELIHOOD", "UNKNOWN"]), missingness: z.enum(["NONE", "EXPLICIT_OUTCOME", "INFORMATIVE", "UNKNOWN"]),
    dependence: z.enum(["CONDITIONAL_IID", "CLUSTERED", "UNKNOWN"]), interference: z.enum(["NONE", "PRESENT", "UNKNOWN"]), reactivity: z.enum(["NONE", "PRESENT", "UNKNOWN"]), nuisance: z.enum(["FIXED_SUPPLIED", "UNKNOWN"]) }).strict(),
  likelihood: z.discriminatedUnion("status", [z.object({ status: z.literal("SUPPLIED_CONDITIONAL"), probabilities: z.array(z.array(decimal).min(2).max(3)).min(2).max(4), calibrationRef: ExperimentRefSchema.nullable(), assumptions: z.array(text).min(1).max(32) }).strict(),
    z.object({ status: z.literal("UNKNOWN"), reasons: z.array(text).min(1).max(32) }).strict()]),
  samples: z.number().int().min(1).max(24), stopping: z.object({ method: z.enum(["FIXED_SAMPLE", "ANYTIME_LR"]), alpha: decimal, beta: decimal, minimumPower: decimal }).strict(),
  costEstimate: z.object({ money: quantity.nullable(), elapsedMs: nullableNumber, humanSeconds: nullableNumber, dataBytes: nullableNumber, integrationUnits: nullableNumber, computeMs: nullableNumber }).strict(),
  exposure: z.object({ unitsPerSample: decimal, privacyUnitsPerSample: decimal, riskAssumptions: z.array(text).min(1).max(32) }).strict() }).strict();
const decisionContext = z.object({ ref: ExperimentRefSchema, utilityRef: ExperimentRefSchema, horizonEnd: instant, lossUnit: text, actionIds: z.array(text).min(1).max(8), lossByHypothesis: z.array(z.array(decimal).min(1).max(8)).min(2).max(4) }).strict();
const hypotheses = z.array(z.object({ ref: ExperimentRefSchema, prior: decimal, meaning: text }).strict()).min(2).max(4);
const constraints = z.object({ maxSamples: z.number().int().min(1).max(24), maxElapsedMs: z.number().finite().positive().max(1e12), maxExposureUnits: decimal, maxPrivacyUnits: decimal,
  moneyLimit: quantity.nullable(), permittedPopulationRefs: z.array(ExperimentRefSchema).min(1).max(8), permittedInstrumentRefs: z.array(ExperimentRefSchema).min(1).max(8) }).strict();
export const ExperimentDesignRequestSchema = z.object({ schema: z.literal("finnor.s2.design-request.v1"), inquiryId: text, episodeId: text, mandateRef: ExperimentRefSchema, decisionContext, hypotheses,
  requiredClaimRefs: z.array(text).max(64), validUntil: instant, maxBeliefAgeMs: z.number().finite().positive().max(1e12), constraints, candidates: z.array(ExperimentCandidateSchema).min(1).max(8) }).strict();
export function freezeExperiment<T>(value: T): T { const clone = structuredClone(value); const freeze = (v: unknown): void => { if (v && typeof v === "object") { for (const nested of Object.values(v)) freeze(nested); Object.freeze(v); } }; freeze(clone); return clone; }
export function prepareS2ExperienceEvent(input: Omit<S2ExperienceEvent, "eventId">): S2ExperienceEvent { const body = structuredClone(input); return freezeExperiment({ ...body, eventId: `s2-event:${epistemicHash(body)}` }); }
export const sameExperimentRef = (a: ExperimentRef, b: ExperimentRef) => epistemicHash(a) === epistemicHash(b);
export function parseExperimentDesignRequest(value: unknown): ExperimentDesignRequest {
  try {
    if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) throw new Error("Request bytes");
    const request = ExperimentDesignRequestSchema.parse(value);
    if (new Set(request.hypotheses.map(h => epistemicHash(h.ref))).size !== request.hypotheses.length || new Set(request.candidates.map(c => c.id)).size !== request.candidates.length
      || new Set(request.decisionContext.actionIds).size !== request.decisionContext.actionIds.length || new Set(request.requiredClaimRefs).size !== request.requiredClaimRefs.length) throw new Error("Duplicate identity");
    const priors = request.hypotheses.map(h => ExperimentRational.decimal(h.prior)); if (priors.some(p => p.n === 0n) || sumRationals(priors).compare(ER_ONE) !== 0) throw new Error("Invalid prior");
    if (request.decisionContext.lossByHypothesis.length !== request.hypotheses.length || request.decisionContext.lossByHypothesis.some(row => row.length !== request.decisionContext.actionIds.length
      || row.some(v => ExperimentRational.decimal(v).compare(new ExperimentRational(1000000n)) > 0))) throw new Error("Invalid supplied loss");
    for (const candidate of request.candidates) {
      if (new Set(candidate.endpoint.categories).size !== candidate.endpoint.categories.length || candidate.assignment.unit !== candidate.measurementUnit) throw new Error("Invalid measurement units");
      for (const bound of [candidate.stopping.alpha, candidate.stopping.beta]) { const q = ExperimentRational.decimal(bound); if (q.compare(ER_ZERO) <= 0 || q.compare(ER_ONE) >= 0) throw new Error("Invalid error budget"); }
      if (ExperimentRational.decimal(candidate.stopping.alpha).add(ExperimentRational.decimal(candidate.stopping.beta)).compare(ER_ONE) >= 0
        || ExperimentRational.decimal(candidate.stopping.minimumPower).compare(ER_ONE) > 0) throw new Error("Invalid error budget");
      if (candidate.likelihood.status === "SUPPLIED_CONDITIONAL" && (candidate.likelihood.probabilities.length !== request.hypotheses.length || candidate.likelihood.probabilities.some(row => row.length !== candidate.endpoint.categories.length
        || sumRationals(row.map(ExperimentRational.decimal)).compare(ER_ONE) !== 0))) throw new Error("Invalid conditional probability");
      if (Date.parse(candidate.timing.endAt) <= Date.parse(candidate.timing.startAt) || candidate.timing.minimumIntervalMs * Math.max(0, candidate.samples - 1) > Date.parse(candidate.timing.endAt) - Date.parse(candidate.timing.startAt)) throw new Error("Invalid measurement timing");
      for (const value of [candidate.exposure.unitsPerSample, candidate.exposure.privacyUnitsPerSample, request.constraints.maxExposureUnits, request.constraints.maxPrivacyUnits]) {
        if (ExperimentRational.decimal(value).compare(new ExperimentRational(1000000000000n)) > 0) throw new Error("Quantity bound exceeded");
      }
      if (ExperimentRational.decimal(candidate.exposure.unitsPerSample).n === 0n) throw new Error("Unsupported zero collection exposure");
    }
    return freezeExperiment(request);
  } catch { throw new ExperimentContractError("INVALID_REQUEST", "S2 request is outside the registered finite measurement contract"); }
}
const loadedSourceDigests = ["experiment-numerics.ts", "experiments.ts", "experiment-realization.ts"].flatMap(path => {
  try { return [{ path, sha256: createHash("sha256").update(readFileSync(new URL(path, import.meta.url))).digest("hex") }]; } catch { return []; }
});
export const S2_BACKEND_VERSION = `s2-finite-v1:${epistemicHash(loadedSourceDigests)}`;
export function protocolDigest(protocol: Omit<ExperimentProtocol, "id" | "contentDigest" | "experience"> | ExperimentProtocol): string {
  const { id: _id, contentDigest: _digest, experience: _experience, ...body } = protocol as ExperimentProtocol; return epistemicHash(body);
}
export function assertExperimentProtocol(value: unknown): asserts value is ExperimentProtocol {
  try {
    if (!value || typeof value !== "object" || Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) throw new Error("Protocol envelope");
    const p = value as ExperimentProtocol;
    if (p.schema !== "finnor.experiment-protocol.v1" || p.semanticOwner !== "S2" || p.version !== "s2-finite-v1" || p.id !== `experiment:${protocolDigest(p)}` || p.contentDigest !== protocolDigest(p)
      || p.admission.executionAuthorityGranted !== false || p.admission.appendAuthorityGranted !== false || p.admission.receipt !== null || p.experience.receipt !== null
      || p.beliefBinding.posteriorCalibrated !== false || p.tenantId !== p.beliefBinding.pin.tenantId || p.principalId !== p.beliefBinding.pin.principalId
      || !Number.isFinite(Date.parse(p.knowledgeAt)) || !Number.isFinite(Date.parse(p.validUntil))) throw new Error("Invalid identity/authority");
    parseExperimentDesignRequest({ schema: "finnor.s2.design-request.v1", inquiryId: p.inquiryId, episodeId: p.episodeId, mandateRef: p.mandateRef, decisionContext: p.decisionContext, hypotheses: p.hypotheses,
      requiredClaimRefs: [], validUntil: p.validUntil, maxBeliefAgeMs: p.beliefBinding.maxAgeMs, constraints: p.constraints, candidates: [p.candidate] });
    const { eventId, ...eventBody } = p.experience.event;
    if (eventId !== `s2-event:${epistemicHash(eventBody)}` || p.experience.event.revisionRef !== p.id || p.experience.event.contentDigest !== p.contentDigest) throw new Error("Invalid prepared envelope");
  } catch { throw new ExperimentContractError("INVALID_PROTOCOL", "S2 protocol identity or contract is invalid"); }
}
function unsupported(candidate: ExperimentCandidate, request: ExperimentDesignRequest): string[] {
  const reasons: string[] = []; const p = candidate.process;
  if (candidate.likelihood.status === "UNKNOWN") reasons.push("UNKNOWN_OBSERVATION_LIKELIHOOD");
  if (p.instrumentError !== "IN_LIKELIHOOD") reasons.push("UNKNOWN_INSTRUMENT_ERROR");
  if (!["NONE", "EXPLICIT_OUTCOME"].includes(p.missingness)) reasons.push("UNSUPPORTED_MISSINGNESS");
  if (p.dependence !== "CONDITIONAL_IID") reasons.push("UNSUPPORTED_DEPENDENCE_OR_CLUSTERING");
  if (p.interference !== "NONE") reasons.push("UNSUPPORTED_INTERFERENCE"); if (p.reactivity !== "NONE") reasons.push("UNSUPPORTED_COUNTERPARTY_REACTIVITY");
  if (p.nuisance !== "FIXED_SUPPLIED") reasons.push("UNKNOWN_NUISANCE_DISTRIBUTION");
  if (candidate.stopping.method === "ANYTIME_LR" && request.hypotheses.length !== 2) reasons.push("SEQUENTIAL_METHOD_REQUIRES_TWO_SIMPLE_HYPOTHESES");
  if (request.hypotheses.length !== 2 && ExperimentRational.decimal(candidate.stopping.minimumPower).n > 0n) reasons.push("COMPOSITE_POWER_NOT_REGISTERED");
  return reasons;
}
function budgetReasons(candidate: ExperimentCandidate, request: ExperimentDesignRequest): string[] {
  const reasons: string[] = [], c = request.constraints; const n = new ExperimentRational(BigInt(candidate.samples));
  if (!c.permittedPopulationRefs.some(ref => sameExperimentRef(ref, candidate.populationRef))) reasons.push("POPULATION_NOT_PERMITTED");
  if (!c.permittedInstrumentRefs.some(ref => sameExperimentRef(ref, candidate.instrumentRef))) reasons.push("INSTRUMENT_NOT_PERMITTED");
  if (candidate.samples > c.maxSamples) reasons.push("SAMPLE_LIMIT_EXCEEDED");
  if (ExperimentRational.decimal(candidate.exposure.unitsPerSample).mul(n).compare(ExperimentRational.decimal(c.maxExposureUnits)) > 0) reasons.push("EXPOSURE_LIMIT_EXCEEDED");
  if (ExperimentRational.decimal(candidate.exposure.privacyUnitsPerSample).mul(n).compare(ExperimentRational.decimal(c.maxPrivacyUnits)) > 0) reasons.push("PRIVACY_LIMIT_EXCEEDED");
  if (candidate.costEstimate.elapsedMs === null || candidate.costEstimate.elapsedMs > c.maxElapsedMs) reasons.push("TIME_COST_UNKNOWN_OR_EXCEEDS_LIMIT");
  if (candidate.timing.minimumIntervalMs * Math.max(0, candidate.samples - 1) > c.maxElapsedMs) reasons.push("REGISTERED_MIN_COLLECTION_TIME_EXCEEDS_LIMIT");
  if (Date.parse(candidate.timing.endAt) > Date.parse(request.validUntil) || Date.parse(candidate.timing.endAt) > Date.parse(request.decisionContext.horizonEnd)) reasons.push("COLLECTION_OUTSIDE_VALIDITY_OR_DECISION_HORIZON");
  if (c.moneyLimit && (!candidate.costEstimate.money || candidate.costEstimate.money.unit !== c.moneyLimit.unit || ExperimentRational.decimal(candidate.costEstimate.money.value).compare(ExperimentRational.decimal(c.moneyLimit.value)) > 0)) reasons.push("MONEY_COST_UNKNOWN_OR_EXCEEDS_LIMIT");
  return reasons;
}
export function designExperiments(input: { beliefView: BeliefView; request: unknown; now?: string }): ExperimentDesignBundle {
  const request = parseExperimentDesignRequest(input.request), view = input.beliefView, now = input.now ?? new Date().toISOString();
  if (view.schema !== "finnor.belief-view.v1" || view.semanticOwner !== "S1" || view.coverage.canonicalStatus !== "COMPLETE" || view.coverage.truncated
    || Date.parse(view.knowledgeAt) > Date.parse(now) || Date.parse(now) - Date.parse(view.knowledgeAt) > request.maxBeliefAgeMs || Date.parse(request.validUntil) <= Date.parse(now)
    || request.requiredClaimRefs.some(ref => !view.claims.some(claim => claim.id === ref))) throw new ExperimentContractError("PERMITTED_CONTEXT_UNAVAILABLE", "Qualified current S1 context is unavailable");
  const start = performance.now(), cpu = process.cpuUsage(), before = process.memoryUsage().rss;
  const requestDigest = epistemicHash(request), experience: S2ExperienceEvent[] = [];
  const eventBase = { schema: "finnor.s2.experience.v1" as const, episodeId: request.episodeId, semanticOwner: "S2" as const, tenantId: view.tenantId, principalId: view.principalId, rightsRef: view.rights.ref,
    preparedParentRefs: [view.experience.event.eventId], causalParents: [] as [], validAt: now, knowledgeAt: now, dependencyRefs: [view.dependencyDigest, requestDigest], freshnessRef: view.dependencyDigest,
    uncertainty: "MODEL_CONDITIONAL_NO_FIELD_CALIBRATION" as const, horizon: "H1" as const, provenanceRefs: [request.mandateRef, request.decisionContext.ref, ...request.hypotheses.map(h => h.ref)], modelComputeRef: null };
  const designs: ExperimentDesignBundle["designs"] = request.candidates.map(candidate => {
    const unsupportedReasons = unsupported(candidate, request), budget = budgetReasons(candidate, request); const reasons = [...unsupportedReasons, ...budget];
    if (reasons.length) {
      experience.push(prepareS2ExperienceEvent({ ...eventBase, type: "DESIGN_REJECTION", revisionRef: `request:${requestDigest}`, contentDigest: requestDigest, detail: { candidateId: candidate.id, reasons } }));
      return { candidateId: candidate.id, status: unsupportedReasons.length ? "UNSUPPORTED" : "BUDGET_EXCEEDED", protocol: null, reasons };
    }
    const metrics = exactExperimentMetrics(request, candidate);
    const power = ExperimentRational.decimal(candidate.stopping.minimumPower);
    const enough = request.hypotheses.length !== 2 || [metrics.rejectH0ByHypothesis[1]!, metrics.rejectH1ByHypothesis[0]!].every(v => new ExperimentRational(BigInt(v.numerator), BigInt(v.denominator)).compare(power) >= 0);
    const status = !enough ? "EXPOSURE_INSUFFICIENT" : metrics.riskReduction.numerator === "0" ? "UNINFORMATIVE" : "SUPPORTED";
    const limitations = !enough ? ["REGISTERED_POWER_NOT_REACHED_WITHIN_EXPOSURE"] : status === "UNINFORMATIVE" ? ["NO_DECISION_LOSS_REDUCTION_FOR_SUPPLIED_CONTEXT"] : [];
    const dependencies = [request.mandateRef, request.decisionContext.ref, request.decisionContext.utilityRef, ...request.hypotheses.map(h => h.ref), candidate.instrumentRef, candidate.populationRef, candidate.process.methodRef,
      ...(candidate.likelihood.status === "SUPPLIED_CONDITIONAL" && candidate.likelihood.calibrationRef ? [candidate.likelihood.calibrationRef] : [])];
    const body: Omit<ExperimentProtocol, "id" | "contentDigest" | "experience"> = { schema: "finnor.experiment-protocol.v1", semanticOwner: "S2", version: "s2-finite-v1", inquiryId: request.inquiryId, episodeId: request.episodeId,
      tenantId: view.tenantId, principalId: view.principalId, knowledgeAt: now, validUntil: request.validUntil, requestDigest, mandateRef: request.mandateRef, decisionContext: request.decisionContext, hypotheses: request.hypotheses,
      candidate, constraints: request.constraints, beliefBinding: { viewRef: view.id, contentDigest: view.contentDigest, dependencyDigest: view.dependencyDigest, pin: view.pin, rightsRef: view.rights.ref, coverage: view.coverage,
        claimRefs: view.claims.filter(claim => request.requiredClaimRefs.includes(claim.id)).map(claim => claim.ownerRef), posteriorCalibrated: false, maxAgeMs: request.maxBeliefAgeMs }, metrics, dependencies,
      admissibility: { status: "PROPOSAL_ONLY", prerequisites: ["S4_COMMISSION_AND_CURRENT_MANDATE", "S5_ALLOCATION_CERTIFICATE", "S6_PROTECTED_LEDGER_AND_EFFECT_BOUND_CHECKS", "S7_MEASUREMENT_REGISTRATION"], estimatesAreEnforcedLimits: false },
      admission: { status: "BLOCKED_EXTERNAL", appendAuthorityGranted: false, executionAuthorityGranted: false, receipt: null } };
    const digest = protocolDigest(body), id = `experiment:${digest}`;
    const event = prepareS2ExperienceEvent({ ...eventBase, type: "PROPOSAL", revisionRef: id, contentDigest: digest, detail: { candidateId: candidate.id, designStatus: status, limitations } }); experience.push(event);
    return { candidateId: candidate.id, status, protocol: freezeExperiment({ ...body, id, contentDigest: digest, experience: { event, receipt: null, status: "BLOCKED_EXTERNAL" } } as ExperimentProtocol), reasons: limitations };
  });
  let preferred: ExperimentProtocol | null = null;
  for (const design of designs) if (design.status === "SUPPORTED" && design.protocol) {
    const risk = design.protocol.metrics.terminalRisk, existing = preferred?.metrics.terminalRisk;
    if (!existing || new ExperimentRational(BigInt(risk.numerator), BigInt(risk.denominator)).compare(new ExperimentRational(BigInt(existing.numerator), BigInt(existing.denominator))) < 0) preferred = design.protocol;
  }
  const cpuAfter = process.cpuUsage(cpu), finished = new Date().toISOString();
  const computeBody: Omit<ModelComputeInvocation, "id"> = { schema: "finnor.model-compute-invocation.v1", semanticOwner: "S2", tenantId: view.tenantId, principalId: view.principalId, rightsRef: view.rights.ref,
    inputRef: `request:${requestDigest}`, outputRefs: designs.flatMap(d => d.protocol ? [d.protocol.id] : []), requestedRoute: "LOCAL_EXACT_FINITE", actualRoute: "LOCAL_EXACT_FINITE", fallbacks: [],
    backend: { name: "finnor-finite-rational", version: S2_BACKEND_VERSION, sourceDigests: loadedSourceDigests, identityBasis: loadedSourceDigests.length === 3 ? "LOADED_SOURCE_SNAPSHOT" : "SOURCE_IDENTITY_UNAVAILABLE" }, model: null,
    harness: { nodeVersion: process.version, platform: process.platform, architecture: process.arch, configuration: { domain: "s2-finite-v1", maxSamples: 24, maxCandidates: 8 }, deterministicReplayClaimed: false },
    attempts: [{ startedAt: now, finishedAt: finished, status: "COMPLETED", reason: null }], randomness: { used: false, seed: null },
    usage: { elapsedMs: performance.now() - start, processCpuUserMicros: cpuAfter.user, processCpuSystemMicros: cpuAfter.system, rssBeforeBytes: before, rssAfterBytes: process.memoryUsage().rss, accountingScope: "PROCESS_INTERVAL_INCLUSIVE_NOT_ISOLATED_PEAK" },
    cost: { money: null, pricebookRef: null, status: "LOCAL_COST_UNMETERED", externalCalls: 0 }, admission: { status: "BLOCKED_EXTERNAL", receipt: null } };
  const compute = freezeExperiment({ ...computeBody, id: `compute:${epistemicHash(computeBody)}` });
  experience.push(prepareS2ExperienceEvent({ ...eventBase, type: "COMPUTE", revisionRef: compute.id, contentDigest: epistemicHash(compute), modelComputeRef: compute.id, detail: { costStatus: compute.cost.status, route: compute.actualRoute } }));
  const result = { schema: "finnor.s2.design-bundle.v1" as const, designs, preferredDesignRef: preferred?.id ?? null, compute, experience, boundary: "S4_SELECTS_INQUIRY_S5_COMMITS_S6_EXECUTES_S7_ATTRIBUTES" as const };
  if (Buffer.byteLength(JSON.stringify(result)) > 4 * 1024 * 1024) throw new ExperimentContractError("LIMIT_EXCEEDED", "S2 response exceeds the registered 4 MiB limit");
  return freezeExperiment(result);
}

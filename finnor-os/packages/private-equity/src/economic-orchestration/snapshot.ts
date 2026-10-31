import type { PoolClient } from "pg";
import { z } from "zod";
import type { PeMutationContext } from "../types";
import type { SearchRow } from "../compute-search/contracts";
import type { ProgramRow } from "../program-synthesis/store";
import { assertProgramCurrent } from "../program-synthesis/store";
import { units, incumbentOf, append } from "../compute-search/store";
import { sha, stable, currentDerivation, assertDependencies, currentCodeIdentity } from "../evidence-execution/store";
import { r2MeasuredQuantity, r2String } from "../../../epistemic-runtime/src/r2-rational";
import { EconomicOrchestrationOptionsSchema, nativeControlInputSchema, nativeOriginalProgramSchema, W1_NATIVE_LIMITS,
  type NativeComputation, type NativeControlInput } from "./contracts";
import { readNativeResponseTx, NATIVE_ASSIGNMENT_PROTOCOL } from "./learning";
import { recheckSearchOwners } from "../compute-search/owners";
import { nativeCapacitySnapshot } from "../compute-search/endpoints";
import { readNativeFrameTx, readNativeContinuationTx } from "./observations";
import { nativeDependencyFacets } from "./dependencies";
import { readNativeCapabilityTx, attenuateNativeCapability, REGISTERED_NATIVE_MODEL } from "./native-capability";

const contextSchema = z.object({
  derivationId: z.string().uuid(), sourceResultDigest: z.string(), inputDigest: z.string(),
  programGeneration: z.number().int(), program: nativeOriginalProgramSchema,
}).passthrough();
const ownerSchema = z.object({
  mandateRef: z.unknown(), utilityRef: z.unknown(), rightsRef: z.string(), capacity: z.number().int().positive(),
  resourceId: z.string(), validUntil: z.string(), reservationRef: z.unknown(), resourceRef: z.unknown(),
  deliberationConversion: z.object({
    ref: z.unknown(), unit: z.string(), lossWithoutQualifiedResult: z.number().finite().nonnegative(),
    lossWithQualifiedResult: z.number().finite().nonnegative(), nativeAttemptCost: z.number().finite().nonnegative(),
    delayMsCost: z.number().finite().nonnegative(), controllerMsCost: z.number().finite().nonnegative(),
  }).passthrough().nullable().optional(),
}).passthrough();
export function economicOptions(s: SearchRow) {
  return z.object({ orchestration: EconomicOrchestrationOptionsSchema }).passthrough().parse(s.request).orchestration;
}
export function isEconomicSearch(request: unknown): boolean {
  return z.object({ orchestration: EconomicOrchestrationOptionsSchema }).passthrough().safeParse(request).success;
}
/** Called at actual owner boundaries, not a substitute for P2's S4/S5 current reader. */
export async function nativeControlSnapshotTx(ctx: PeMutationContext, s: SearchRow, q: ProgramRow, c: PoolClient,
  cut: { pinnedContinuationRef?: string | null; ignoreAttemptId?: string } = {}): Promise<NativeControlInput> {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["s5-portfolio:" + s.tenant_id]);
  await assertProgramCurrent(ctx, q, c, true);
  await recheckSearchOwners(ctx, q, s, c);
  if ((await currentCodeIdentity()).digest !== q.proposed.producer.codeDigest) throw Error("W1_ORIGINAL_RUNTIME_CUT_CHANGED");
  const options = economicOptions(s), context = contextSchema.parse(s.context), owner = ownerSchema.parse(s.binding);
  const nativeCapability = await readNativeCapabilityTx(ctx, c);
  if (nativeCapability) {
    const previous = (await c.query(`SELECT search_id,body,digest FROM finnor_os.p2_events
      WHERE tenant_id=$1 AND principal_id=$2 AND kind='W1_NATIVE_CAPABILITY_OBSERVED'
        AND body->'capability'->>'revision'=$3`, [s.tenant_id, s.principal_id, nativeCapability.revision])).rows;
    if (previous.some(row => sha(row.body) !== row.digest ||
        row.body.capability.sourceSha256 !== nativeCapability.sourceSha256))
      throw Error("W1_NATIVE_CAPABILITY_REVISION_PREIMAGE_CHANGED");
    if (!previous.some(row => row.search_id === s.id)) await append(ctx, s, "W1_NATIVE_CAPABILITY_OBSERVED", {
      capability: nativeCapability, originalEpisode: q.episode_id, originalGrant: s.request.computeGrant,
      actualBillingUSD: null, authorityGranted: false,
    }, c);
  }
  const d = await currentDerivation(ctx, context.derivationId, c);
  if (d.result?.digest !== context.sourceResultDigest || context.programGeneration !== q.generation) throw Error("W1_ORIGINAL_SOURCE_OR_PROGRAM_CUT_CHANGED");
  await assertDependencies(ctx, d.invalidationKeys, c, true);
  const frontier = await units(ctx, s, c), modules = context.program.modules;
  if (modules.length > W1_NATIVE_LIMITS.modules) throw Error("W1_NATIVE_CATALOGUE_BOUND_UNSUPPORTED_NOT_TRUNCATED");
  const checkerRef = "p1-original-numeric-checker:" + sha({ acceptance: q.proposed.acceptanceDigest, runtime: q.proposed.producer.codeDigest });
  const singleton: NativeComputation[] = [];
  for (const module of modules) {
    if (sha(module.compiled) !== module.compiledDigest) throw Error("W1_ACTUAL_METHOD_BYTES_CHANGED");
    const execution = frontier.find(unit => unit.kind === "EXECUTE_P1" && unit.body.moduleId === module.id);
    const check = frontier.find(unit => unit.kind === "VERIFY_P1" && unit.body.moduleId === module.id);
    if (!execution || !check || !check.body.prerequisites.includes(execution.id)) throw Error("W1_ACTUAL_NATIVE_EXECUTE_CHECK_CATALOGUE_REQUIRED");
    const method = { owner: "P1", id: module.id, version: module.runtime.version, contentDigest: module.compiledDigest };
    const treatmentRef = "p1-joint-treatment:" + sha({ methods: [method], topology: "DEPENDENT_EXECUTE_THEN_INDEPENDENT_SQL_CHECK", checkerRef });
    singleton.push({ computationRef: treatmentRef, treatmentRef, unitIds: [execution.id, check.id],
      unitCosts: [{ unitId: execution.id, attempts: 1, steps: module.bounds.steps + 1 }, { unitId: check.id, attempts: 1, steps: 1 }],
      moduleIds: [module.id], methodRefs: [method],
      contextRefs: [context.sourceResultDigest, context.inputDigest, q.proposed.acceptanceDigest], verifierRefs: [checkerRef],
      prerequisiteEdges: [{ from: execution.id, to: check.id }], attempts: 2, steps: module.bounds.steps + 2,
      independence: "COMMON_PREMISE_ALTERNATE_IMPLEMENTATIONS", available: ![execution, check].some(unit => ["FAILED", "CANCELLED", "UNKNOWN"].includes(unit.status)) });
  }
  const entries = [...singleton];
  for (let mask = 1; mask < 2 ** singleton.length; mask++) {
    const joint = singleton.filter((_, index) => (mask & (1 << index)) !== 0);
    if (joint.length < 2) continue;
    const treatmentRef = "p1-joint-treatment:" + sha({ methods: joint.flatMap(entry => entry.methodRefs), topology: "CURRENT_P2_BOUNDED_READY_PARALLEL_WITH_ORIGINAL_CHECK_BARRIERS", checkerRef, maxParallel: s.request.limits.maxParallel });
    entries.push({ computationRef: treatmentRef, treatmentRef, unitIds: joint.flatMap(entry => entry.unitIds), unitCosts: joint.flatMap(entry => entry.unitCosts),
      moduleIds: joint.flatMap(entry => entry.moduleIds),
      methodRefs: joint.flatMap(entry => entry.methodRefs), contextRefs: singleton[0]?.contextRefs ?? [], verifierRefs: [checkerRef],
      prerequisiteEdges: joint.flatMap(entry => entry.prerequisiteEdges), attempts: joint.reduce((sum, entry) => sum + entry.attempts, 0),
      steps: joint.reduce((sum, entry) => sum + entry.steps, 0), independence: "COMMON_PREMISE_ALTERNATE_IMPLEMENTATIONS", available: joint.every(entry => entry.available) });
  }
  const pins = {
    sourceRef: "p4-source:" + context.sourceResultDigest, modelRef: nativeCapability?.modelRef ?? REGISTERED_NATIVE_MODEL,
    providerRef: "P1_LOCAL_NATIVE_REGISTERED_IR", methodRef: "p1-method-set:" + sha(singleton.map(entry => entry.methodRefs)),
    priceRef: "s4-native-price:" + sha(nativeCapability ?
      { original: owner.deliberationConversion ?? null, attenuation: nativeCapability.nativeAttemptCostMultiplier } :
      owner.deliberationConversion ?? { status: "UNKNOWN", grant: s.request.computeGrant }),
    checkerRef, runtimeRef: "p1-p2-runtime:" + q.proposed.producer.codeDigest +
      (nativeCapability ? ":configuration:" + nativeCapability.sourceSha256 : ""),
  };
  const features = {
    structureRef: "p1-dependency-shape:" + sha({ structures: modules.map(module => module.structureDigest), operations: q.request.operations ?? [] }),
    outcomeClassRef: "p1-original-numeric-acceptance:" + q.proposed.acceptanceDigest, domainRef: options.domainRef,
  };
  const episode = (await c.query(
    "SELECT id,max_attempts,max_steps,max_candidates,deadline_at,max_attempts-attempts_used remaining_attempts,max_steps-steps_used remaining_steps,extract(epoch FROM(deadline_at-clock_timestamp()))*1000 remaining_ms FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR SHARE",
    [s.tenant_id, s.principal_id, q.episode_id],
  )).rows[0];
  if (!episode) throw Error("W1_ORIGINAL_EPISODE_REQUIRED");
  const episodeDeadlineAt = new Date(episode.deadline_at).toISOString();
  const responseContext = { pins, features, purposeRef: options.purposeRef, populationRef: options.populationRef,
    validUntil: new Date(Math.min(Date.parse(q.proposed.bounds.deadlineAt), Date.parse(owner.validUntil), Date.parse(episodeDeadlineAt))).toISOString() };
  const response = await readNativeResponseTx(ctx, c, responseContext, options.responseRef);
  const continuation = await readNativeContinuationTx(ctx, c, { tenantId: s.tenant_id, principalId: s.principal_id,
    ...responseContext, sourceClass: "CONTROLLED_NATIVE" },
    Object.hasOwn(cut, "pinnedContinuationRef") ? cut.pinnedContinuationRef ?? null : options.continuationRef ?? null);
  const frame = await readNativeFrameTx(s, frontier, c, cut.ignoreAttemptId);
  const grant = (await c.query("SELECT spent FROM finnor_os.p2_grant_usage WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3 AND resource_id=$4 FOR SHARE", [s.tenant_id, s.principal_id, s.request.computeGrant.contentDigest, owner.resourceId])).rows[0];
  const incumbent = incumbentOf(s, frontier), terms = owner.deliberationConversion;
  const catalogue = { entries, ref: "p2-current-native-catalogue:" + sha(entries.map(({ available: _availability, ...entry }) => entry)) };
  const input = nativeControlInputSchema.parse({
    schema: "finnor.w1.native-control-input.v1", searchId: s.id, programId: q.id, episodeId: q.episode_id,
    workInputId: q.work_input_id, workInputDigest: q.work_input_digest, generation: s.generation,
    purposeRef: options.purposeRef, populationRef: options.populationRef, protocolRef: NATIVE_ASSIGNMENT_PROTOCOL,
    binding: {
      tenantId: s.tenant_id, principalId: s.principal_id, workId: q.work_id,
      outcomeRef: "p1-original-outcome:" + q.proposed.acceptanceDigest, mandateRef: stable(owner.mandateRef),
      sourceRef: pins.sourceRef, rightsRef: owner.rightsRef, catalogueRef: catalogue.ref, responseRef: continuation?.ref ?? "NATIVE_CONDITIONAL_RESPONSE_NOT_YET_OBSERVED",
      modelRef: pins.modelRef, priceRef: pins.priceRef, checkerRef, runtimeRef: pins.runtimeRef,
      parentGrantRef: stable(s.request.computeGrant), deadline: q.proposed.bounds.deadlineAt,
    },
    features, pins, catalogue, response, continuation, frame, contextValidUntil: responseContext.validUntil, episodeDeadlineAt,
    ...(nativeCapability ? { nativeCapability } : {}),
    utility: terms ? { ref: terms.ref, unit: terms.unit,
      lossGap: r2String(r2MeasuredQuantity(terms.lossWithoutQualifiedResult).sub(r2MeasuredQuantity(terms.lossWithQualifiedResult))),
      nativeAttemptCost: r2String(r2MeasuredQuantity(terms.nativeAttemptCost)), delayMsCost: r2String(r2MeasuredQuantity(terms.delayMsCost)),
      controllerMsCost: r2String(r2MeasuredQuantity(terms.controllerMsCost)) } : null,
    remaining: {
      attempts: Math.max(0, Math.min(Number(episode.remaining_attempts), owner.capacity - Number(grant?.spent ?? 0))),
      steps: Math.max(0, Number(episode.remaining_steps)), wallMs: Math.min(Number(episode.remaining_ms), Date.parse(responseContext.validUntil) - Date.now()), maxParallel: s.request.limits.maxParallel,
      // The actual P1 continuation charges no second attempt after its durable
      // evidence_query_id exists; it still debits its original logical steps.
      publicationAttempts: q.evidence_query_id ? 0 : 1,
      publicationSteps: q.proposed.graph.length + 2 + (q.request.operations?.length ?? 0),
    },
    incumbentRef: incumbent ? "p1-current-original-sql-incumbent:" + sha(incumbent) : null,
    outstanding: frame.obligations.filter(obligation => obligation.status !== "RESOLVED").map(obligation =>
      ({ id: obligation.id, status: obligation.status === "UNKNOWN" ? "UNKNOWN" : "PENDING" })),
    now: new Date().toISOString(),
  });
  attenuateNativeCapability(input);
  input.dependencyState = nativeDependencyFacets(input, {
    resource: { episodeId: q.episode_id, maxAttempts: episode.max_attempts, maxSteps: episode.max_steps, maxCandidates: episode.max_candidates,
      capacity: owner.capacity, resourceRef: owner.resourceRef, reservationRef: owner.reservationRef,
      physicalCapacity: (await nativeCapacitySnapshot(ctx, s.request.requestedKinds.includes("MODEL_REFINE"), c)).digest,
      ownerValidUntil: owner.validUntil },
    source: d.invalidationKeys, rights: { q: q.proposed.rights, source: d.invalidationKeys },
    plan: q.plan_revision_id,
  });
  return input;
}
/** The native physical call can attenuate, never extend, the original episode. */
export async function economicEpisodeDeadlineTx(s: SearchRow, q: ProgramRow, c: PoolClient): Promise<number> {
  const episode = (await c.query("SELECT deadline_at FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR SHARE",
    [s.tenant_id, s.principal_id, q.episode_id])).rows[0];
  if (!episode) throw Error("W1_ORIGINAL_EPISODE_REQUIRED");
  return Math.min(Date.parse(q.proposed.bounds.deadlineAt), new Date(episode.deadline_at).getTime(), Date.parse(s.binding.validUntil));
}

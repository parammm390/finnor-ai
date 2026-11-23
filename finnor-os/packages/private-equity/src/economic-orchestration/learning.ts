import type { PoolClient } from "pg";
import { z } from "zod";
import type { PeMutationContext } from "../types";
import type { SearchRow } from "../compute-search/contracts";
import { units, incumbentOf } from "../compute-search/store";
import { sha, stable, principal } from "../evidence-execution/store";
import { appendResponseObservations, fitResponseState, parseResponseDataset, responseEstimate, responseStateSchema, responsePinsSchema, responseFeaturesSchema,
  type ResponseDataset, type ResponseState, type ResponseObservation, type ResponsePins, type ResponseFeatures } from "../../../epistemic-runtime/src/metalevel-policy/response";
import { EconomicOrchestrationOptionsSchema, meterSchema } from "./contracts";
import { lockNativeContextsTx, persistNativeGapTx } from "./gaps";
import { recordNativeStagesTx, nativeContinuationContextKey } from "./observations";
import { append } from "../compute-search/store";

export const NATIVE_ASSIGNMENT_PROTOCOL = "logged-native-current-owner-assignment-v1";
export interface NativeResponseContext {
  pins: ResponsePins; features: ResponseFeatures; purposeRef: string; populationRef: string; validUntil: string;
}
const stateRowSchema = z.object({ body: responseStateSchema, dataset: z.unknown(), digest: z.string(), dataset_digest: z.string() }).passthrough();
export async function readNativeResponseTx(ctx: PeMutationContext, c: PoolClient, context: NativeResponseContext, requestedRef: string | null): Promise<ResponseState | null> {
  const result = await c.query(
    `SELECT body,dataset,digest,dataset_digest FROM finnor_os.w1_response_states
     WHERE tenant_id=$1 AND principal_id=$2
       AND ($3::text IS NULL OR body->>'ref'=$3)
       AND body->>'purposeRef'=$4 AND body->>'populationRef'=$5
       AND body->'pins'=$6::jsonb
     ORDER BY created_at DESC,digest DESC LIMIT 1`,
    [ctx.auth.tenantId, principal(ctx), requestedRef, context.purposeRef, context.populationRef, stable(context.pins)],
  );
  if (!result.rows[0]) {
    if (requestedRef) throw Error("W1_REQUESTED_NATIVE_RESPONSE_REVISION_UNAVAILABLE");
    return null;
  }
  const row = stateRowSchema.parse(result.rows[0]);
  if (sha(row.body) !== row.digest || sha(row.dataset) !== row.dataset_digest ||
      row.body.ref !== fitResponseState(row.dataset, row.body.previousRef).ref ||
      row.body.sourceClass !== "CONTROLLED_NATIVE")
    throw Error("W1_NATIVE_RESPONSE_CUSTODY_OR_CURRENTNESS_UNPASSED");
  const now = new Date().toISOString();
  if (!row.body.estimates.some(estimate => responseEstimate(row.body, {
    tenantId: ctx.auth.tenantId, principalId: principal(ctx), purposeRef: context.purposeRef, populationRef: context.populationRef,
    protocolRef: NATIVE_ASSIGNMENT_PROTOCOL, pins: context.pins, features: context.features,
    treatmentRef: estimate.treatmentRef, now,
  }).status === "AVAILABLE")) {
    if (requestedRef) throw Error("W1_REQUESTED_NATIVE_RESPONSE_CONTEXT_OR_KNOWLEDGE_CUT_UNPASSED");
    return null;
  }
  return row.body;
}
const selectedSchema = z.object({
  treatmentRef: z.string(), treatmentUnitIds: z.array(z.string()).min(1),
  responseContext: z.object({
    pins: responsePinsSchema,
    features: responseFeaturesSchema,
    purposeRef: z.string(), populationRef: z.string(), validUntil: z.string(),
  }).strict(),
}).passthrough();
const attemptSchema = z.object({
  id: z.string().uuid(), unit_id: z.string().uuid(), status: z.enum(["INTENT", "SUBMITTED", "COMPLETED", "FAILED", "UNKNOWN", "LATE"]),
  body: z.object({ w1Meter: meterSchema.optional(), submittedAt: z.string().optional(), completedAt: z.number().optional() }).passthrough(),
  digest: z.string(),
}).passthrough();
/** The producer cannot submit observations. All samples are reconstructed from original durable native attempts. */
export async function recordNativeObservationsTx(ctx: PeMutationContext, s: SearchRow, c: PoolClient): Promise<void> {
  const options = z.object({ orchestration: EconomicOrchestrationOptionsSchema }).passthrough().parse(s.request).orchestration;
  const frontier = await units(ctx, s, c);
  const selectionRows = (await c.query(
    `SELECT kind,body,digest,created_at FROM finnor_os.p2_events WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3
      AND kind IN('W1_NEXT_COMPUTATION_APPLIED','W1_NATIVE_FALLBACK_APPLIED','W1_NATIVE_COMPUTATION_STOPPED') ORDER BY created_at,id`,
    [s.tenant_id, s.principal_id, s.id],
  )).rows;
  // Declare every context before any learned-state write. Sort actual PG
  // bigint lock identities, not event order or only their unhashed strings.
  const contextKeys: string[] = [];
  for (const row of selectionRows) {
    const context = z.object({ responseContext: selectedSchema.shape.responseContext }).passthrough().safeParse(row.body);
    if (!context.success) continue;
    const value = context.data.responseContext;
    contextKeys.push("w1-response:" + sha({ tenant: s.tenant_id, principal: s.principal_id, purpose: value.purposeRef,
      population: value.populationRef, pins: value.pins }));
    contextKeys.push(nativeContinuationContextKey({ tenantId: s.tenant_id, principalId: s.principal_id, ...value, sourceClass: "CONTROLLED_NATIVE" }));
  }
  const lockIds = await lockNativeContextsTx(ctx, c, contextKeys);
  await recordNativeStagesTx(ctx, s, frontier, selectionRows, c);
  if (contextKeys.length) await append(ctx, s, "W1_CONTEXT_LOCK_SET", { lockIds, principalGateFirst: true,
    signedBigintOrder: true, allContextsDeclaredBeforeWrites: true }, c);
  // Whole-treatment chains: stage-level selection events sharing one
  // treatmentRef are stages of the same original EXECUTE_P1 + SQL VERIFY
  // chain. One completed chain yields exactly one complete-chain response
  // observation; per-stage contingent observations stay with the separate
  // recordNativeStagesTx pipeline above.
  const chains = new Map<string, { rows: typeof selectionRows; selections: z.infer<typeof selectedSchema>[] }>();
  for (const row of selectionRows) {
    if (row.kind === "W1_NATIVE_COMPUTATION_STOPPED") continue;
    if (sha(row.body) !== row.digest) throw Error("W1_ORIGINAL_SELECTION_EVENT_DIGEST_MISMATCH");
    const selection = selectedSchema.parse(row.body);
    const chain = chains.get(selection.treatmentRef) ?? { rows: [], selections: [] };
    chain.rows.push(row); chain.selections.push(selection); chains.set(selection.treatmentRef, chain);
  }
  for (const [treatmentRef, chain] of chains) {
    // Expand stage-selected units through the original prerequisite barrier in
    // both directions: an execution still awaiting its SQL check is an
    // incomplete chain below, never a failed treatment.
    const selected = new Set(chain.selections.flatMap(selection => selection.treatmentUnitIds));
    for (let grew = true; grew;) {
      grew = false;
      for (const unit of frontier) {
        if (selected.has(unit.id) || (unit.kind !== "EXECUTE_P1" && unit.kind !== "VERIFY_P1")) continue;
        if (unit.body.prerequisites.some(id => selected.has(id)) ||
            (unit.kind === "EXECUTE_P1" && frontier.some(other => selected.has(other.id) && other.body.prerequisites.includes(unit.id))))
          { selected.add(unit.id); grew = true; }
      }
    }
    const unitIds = [...selected].sort();
    const identity = sha({ searchId: s.id, treatmentRef, units: unitIds });
    const context = chain.selections[0]!.responseContext;
    if (chain.selections.some(selection => stable(selection.responseContext) !== stable(context))) continue;
    const resolved = unitIds.map(id => frontier.find(unit => unit.id === id));
    if (resolved.some(unit => !unit || !["COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"].includes(unit.status))) continue;
    const sampleId = "p2-native-observation:" + identity;
    if ((await c.query("SELECT id FROM finnor_os.w1_native_observations WHERE tenant_id=$1 AND principal_id=$2 AND id=$3", [s.tenant_id, s.principal_id, sampleId])).rowCount) continue;
    const attempts = (await c.query(
      "SELECT id,unit_id,status,body,digest FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND unit_id=ANY($4::uuid[]) ORDER BY created_at,id",
      [s.tenant_id, s.principal_id, s.id, unitIds],
    )).rows.map(raw => attemptSchema.parse(raw));
    if (!attempts.length) continue; // Withdrawn, never a zero-cost sample.
    if (attempts.some(attempt => sha(attempt.body) !== attempt.digest)) throw Error("W1_ORIGINAL_NATIVE_ATTEMPT_CUSTODY_UNPASSED");
    if (attempts.some(attempt => !attempt.body.w1Meter || ["INTENT", "SUBMITTED", "UNKNOWN"].includes(attempt.status))) continue;
    const meters = attempts.map(attempt => meterSchema.parse(attempt.body.w1Meter));
    const knownUnits = frontier.filter(unit => unitIds.includes(unit.id));
    const incumbent = incumbentOf(s, knownUnits);
    const censored = knownUnits.some(unit => ["UNKNOWN", "CANCELLED"].includes(unit.status));
    const outcomeRefs = attempts.map(attempt => "p2-attempt:" + attempt.id + ":" + attempt.digest);
    const sample: ResponseObservation = {
      id: sampleId, workId: z.object({ workId: z.string() }).passthrough().parse(chain.rows[0]!.body).workId,
      unitId: "native-premise-unit:" + sha({ source: context.pins.sourceRef, checker: context.pins.checkerRef }),
      split: options.observationSplit, features: context.features, treatmentRef,
      traceRef: "p2-native-treatment:" + identity, evidenceRefs: [...outcomeRefs, "METER_ROOT_INTERVAL_NONADDITIVE_CHILDREN_UNMETERED",
        "JOINT_LATENCY_WALL_CLOCK_ENVELOPE_CROSS_HOST_CLOCK_SYNC_UNQUALIFIED", "PEAK_RSS_ROOT_PROCESS_LIFETIME_NOT_TASK_PEAK"],
      premiseRefs: [context.pins.sourceRef], assignmentRef: "p2-current-owner-selection:" + chain.rows[0]!.digest,
      assignmentProbability: "1", accepted: !!incumbent && !censored,
      acceptanceRef: incumbent ? "p1-original-sql-acceptance:" + sha(incumbent) : "p2-native-negative-disposition:" + sha(outcomeRefs),
      censored, humanRescue: false, observedAt: new Date().toISOString(),
      latencyMs: Math.max(...meters.map(meter => Date.parse(meter.endedAt))) - Math.min(...meters.map(meter => Date.parse(meter.startedAt))),
      cpuMs: meters.reduce((sum, meter) => sum + meter.cpuMs, 0),
      peakMemoryBytes: Math.max(...meters.map(meter => meter.peakMemoryBytes)),
      humanSeconds: 0, monetaryCost: { status: "UNKNOWN", reason: "NATIVE_BILLING_AND_CHILD_USAGE_UNRECONCILED" },
    };
    if (Date.parse(sample.observedAt) > Date.parse(context.validUntil)) continue;
    const previous = (await c.query(
      `SELECT body,dataset,digest,dataset_digest FROM finnor_os.w1_response_states WHERE tenant_id=$1 AND principal_id=$2
        AND body->>'purposeRef'=$3 AND body->>'populationRef'=$4 AND body->'pins'=$5::jsonb
       ORDER BY created_at DESC,digest DESC LIMIT 1 FOR SHARE`,
      [s.tenant_id, s.principal_id, context.purposeRef, context.populationRef, stable(context.pins)],
    )).rows[0];
    let dataset: ResponseDataset, previousRef: string | null = null;
    const freshLineage = () => parseResponseDataset({
      schema: "finnor.orchestration-response-dataset.v1",
      datasetId: "native-response:" + sha({ tenant: s.tenant_id, principal: s.principal_id, purpose: context.purposeRef, population: context.populationRef, pins: context.pins }),
      tenantId: s.tenant_id, principalId: s.principal_id, purposeRef: context.purposeRef, populationRef: context.populationRef,
      sourceClass: "CONTROLLED_NATIVE", protocol: { kind: "LOGGED_ASSOCIATION", ref: NATIVE_ASSIGNMENT_PROTOCOL, confidenceLevel: .95 },
      pins: context.pins, knowledgeAt: sample.observedAt, validUntil: context.validUntil, samples: [sample],
    });
    try {
    if (previous) {
      const prior = stateRowSchema.parse(previous);
      if (sha(prior.body) !== prior.digest || sha(prior.dataset) !== prior.dataset_digest) throw Error("W1_IMMUTABLE_RESPONSE_PREIMAGE_MISMATCH");
      if (Date.parse(prior.body.validUntil) < Date.parse(sample.observedAt)) {
        // The pinned expired revision remains historical: begin a fresh
        // validity-bounded lineage instead of appending knowledge past expiry,
        // extending the old validity, backdating, or reusing expired samples.
        dataset = freshLineage();
      } else {
        dataset = appendResponseObservations(prior.dataset, [sample], sample.observedAt); previousRef = prior.body.ref;
      }
    } else {
      dataset = freshLineage();
    }
    if (dataset.samples.length > 1024) throw Error("W1_ORIGINAL_RESPONSE_RETENTION_BOUND_REQUIRES_OWNER_COMPACTION");
    const state = fitResponseState(dataset, previousRef);
    if (Buffer.byteLength(stable(state)) > 2097152 || Buffer.byteLength(stable(dataset)) > 4194304)
      throw Error("W1_ORIGINAL_RESPONSE_RETENTION_BOUND_REQUIRES_OWNER_COMPACTION");
    await c.query("INSERT INTO finnor_os.w1_native_observations(tenant_id,principal_id,id,search_id,body,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
      [s.tenant_id, s.principal_id, sample.id, s.id, stable(sample), sha(sample)]);
    await c.query("INSERT INTO finnor_os.w1_response_states(tenant_id,principal_id,digest,dataset_digest,body,dataset) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT DO NOTHING",
      [s.tenant_id, s.principal_id, sha(state), sha(dataset), stable(state), stable(dataset)]);
    } catch (error) {
      // Legacy descriptive terminal tables are not the contingent model. A
      // bounded fit failure must not roll back canonical stages or gap records.
      if (!(error instanceof z.ZodError) && !(error instanceof Error && /^(W1_|RESPONSE_)/.test(error.message))) throw error;
      await persistNativeGapTx(ctx, s, c, { kind: "DESCRIPTIVE_RESPONSE_FIT_OR_RETENTION_UNPASSED", subjectRef: sampleId,
        contextRef: "legacy-response:" + sha(context), evidenceRefs: outcomeRefs.slice(0, 16) });
    }
  }
}

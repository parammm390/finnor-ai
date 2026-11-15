import type { PoolClient } from "pg";
import { z } from "zod";
import type { PeMutationContext } from "../types";
import type { SearchRow, UnitRow } from "../compute-search/contracts";
import { incumbentOf } from "../compute-search/store";
import { sha, stable, principal } from "../evidence-execution/store";
import { meterSchema, EconomicOrchestrationOptionsSchema, nativeOriginalProgramSchema } from "./contracts";
import { nativeFrameSchema, nativeStageActionSchema, nativeStageObservationSchema, nativeContinuationSchema,
  nativeContinuationContextSchema, nativeRemainingSchema, NATIVE_CONTINUATION_LIMITS,
  type NativeFrame, type NativeStageObservation, type NativeContinuationContext, type NativeContinuation } from "./continuation-contracts";
import { fitNativeContinuation, nativeFrameKey } from "./continuation";
import { persistNativeGapTx, gapReasonsForAttempt } from "./gaps";

const actualAttempt = z.object({ id: z.string(), unit_id: z.string(), status: z.string(),
  body: z.record(z.string(), z.unknown()), digest: z.string() }).passthrough();
type Attempt = z.infer<typeof actualAttempt>;
const selected = z.object({
  workId: z.string(), originalEpisode: z.string(), selectionGroupRef: z.string(), beforeFrame: nativeFrameSchema, stageAction: nativeStageActionSchema.nullable(),
  remaining: nativeRemainingSchema.optional(),
  responseContext: z.object({ pins: z.unknown(), features: z.unknown(), purposeRef: z.string(), populationRef: z.string(), validUntil: z.string() }).strict(),
  stoppedDisposition: z.enum(["ACCEPTED", "INCOMPLETE", "UNKNOWN", "CANCELLED"]).optional(),
}).passthrough();
export function nativeContinuationContextKey(context: NativeContinuationContext): string {
  const { validUntil: _validity, sourceClass: _source, ...material } = context;
  return "w1-continuation:" + sha(material);
}
async function originalAttempts(s: SearchRow, c: PoolClient): Promise<Attempt[]> {
  const rows = (await c.query("SELECT id,unit_id,status,body,digest FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 ORDER BY created_at,id",
    [s.tenant_id, s.principal_id, s.id])).rows.map(row => actualAttempt.parse(row));
  for (const row of rows) if (sha(row.body) !== row.digest) throw Error("W1_ORIGINAL_ATTEMPT_DIGEST_UNPASSED");
  return rows;
}
function frameFromOriginal(s: SearchRow, rows: UnitRow[], attempts: Attempt[], history: NativeFrame["history"], priorObligations: NativeFrame["obligations"] = []): NativeFrame {
  const native = rows.filter(row => row.kind === "EXECUTE_P1" || row.kind === "VERIFY_P1");
  const program = nativeOriginalProgramSchema.parse(s.context?.program);
  const keys = new Map(native.map(row => {
    const method = program.modules.find(module => module.id === row.body.moduleId);
    if (!method) throw Error("W1_ORIGINAL_MODULE_REQUIRED");
    return [row.id, row.kind + ":" + sha({ method: method.compiledDigest, module: method.id, checker: s.context?.acceptanceDigest })];
  }));
  const requiredChecks = program.acceptance.targets.map(target => "numeric:" + target.key);
  const checked = incumbentOf(s, rows), obligations = new Map(priorObligations.map(o => [o.id, { ...o }]));
  for (const attempt of attempts) {
    const id = "original-attempt:" + attempt.id, previous = obligations.get(id);
    if (["INTENT", "SUBMITTED", "UNKNOWN"].includes(attempt.status)) obligations.set(id,
      { id, status: attempt.status === "UNKNOWN" ? "UNKNOWN" : "PENDING", resolutionRef: null });
    else if (previous) obligations.set(id, { id, status: "RESOLVED", resolutionRef: "p2-attempt:" + attempt.id + ":" + attempt.digest });
  }
  return nativeFrameSchema.parse({
    units: native.map(row => {
      const module = program.modules.find(module => module.id === row.body.moduleId)!;
      if (row.body.prerequisites.some(id => !keys.has(id))) throw Error("W1_NONNATIVE_PREREQUISITE_UNSUPPORTED_NOT_ERASED");
      return { key: keys.get(row.id)!, unitId: row.id, kind: row.kind, status: row.status,
        prerequisites: row.body.prerequisites.map(id => keys.get(id)).filter((id): id is string => !!id),
        steps: row.kind === "VERIFY_P1" ? 1 : module.bounds.steps + 1,
        observationRef: ["COMPLETED", "FAILED", "UNKNOWN", "CANCELLED"].includes(row.status) ?
          "native-outcome:" + sha({ status: row.status, values: row.result?.values ?? null, checks: row.result?.checks ?? null,
            predicate: row.result?.predicate ?? null, attemptDispositions: attempts.filter(attempt => attempt.unit_id === row.id).map(attempt =>
              ({ status: attempt.status, predicate: attempt.body.predicate ?? null,
                physicalOutcome: attempt.body.physicalOutcome ?? null, liabilityRetained: attempt.body.liabilityRetained ?? false })) }) : null };
    }),
    history, obligations: [...obligations.values()].sort((a, b) => a.id.localeCompare(b.id)), requiredChecks,
    completedChecks: checked ? requiredChecks : [], acceptanceRef: checked ? "p1-original-SQL:" + sha(checked) : null,
    disposition: obligations.size && [...obligations.values()].some(o => o.status === "UNKNOWN") ? "UNKNOWN" :
      s.status === "CANCELLED" ? "CANCELLED" : checked ? "ACCEPTED" : ["INVALIDATED", "FAILED", "STOPPED"].includes(s.status) ? "INCOMPLETE" : "ACTIVE",
  });
}
export async function readNativeFrameTx(s: SearchRow, rows: UnitRow[], c: PoolClient, ignoreAttemptId?: string): Promise<NativeFrame> {
  const prior = (await c.query("SELECT body,digest FROM finnor_os.w1_stage_observations WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 ORDER BY created_at,id",
    [s.tenant_id, s.principal_id, s.id])).rows;
  const history: NativeFrame["history"] = [], obligations = new Map<string, NativeFrame["obligations"][number]>();
  for (const row of prior) {
    if (sha(row.body) !== row.digest) throw Error("W1_STAGE_OBSERVATION_DIGEST_UNPASSED");
    const sample = nativeStageObservationSchema.parse(row.body);
    if (sample.action) history.push({ actionRef: sample.action.ref, observation: sample.observation });
    for (const o of sample.after.obligations) obligations.set(o.id, o);
  }
  const attempts = (await originalAttempts(s, c)).filter(attempt => attempt.id !== ignoreAttemptId);
  return frameFromOriginal(s, rows, attempts, history, [...obligations.values()]);
}
export async function readNativeContinuationTx(ctx: PeMutationContext, c: PoolClient, context: NativeContinuationContext, requested: string | null): Promise<NativeContinuation | null> {
  const row = (await c.query(
    `SELECT body,digest FROM finnor_os.w1_continuation_states WHERE tenant_id=$1 AND principal_id=$2
     AND ($3::text IS NULL OR body->>'ref'=$3) AND body->'context'->>'purposeRef'=$4
     AND body->'context'->>'populationRef'=$5 AND body->'context'->'pins'=$6::jsonb
     AND body->'context'->'features'=$7::jsonb ORDER BY created_at DESC,digest DESC LIMIT 1`,
    [ctx.auth.tenantId, principal(ctx), requested, context.purposeRef, context.populationRef, stable(context.pins), stable(context.features)],
  )).rows[0];
  if (!row) { if (requested) throw Error("W1_PINNED_CONTINUATION_UNAVAILABLE"); return null; }
  const body = nativeContinuationSchema.parse(row.body);
  if (sha(body) !== row.digest || body.context.sourceClass !== "CONTROLLED_NATIVE" ||
      fitNativeContinuation(body.samples, body.context, body.previousRef, body.knowledgeAt).ref !== body.ref) throw Error("W1_CANONICAL_CONTINUATION_CUSTODY_UNPASSED");
  if (Date.parse(body.context.validUntil) <= Date.now()) { if (requested) throw Error("W1_PINNED_CONTINUATION_EXPIRED"); return null; }
  if (Date.parse(body.knowledgeAt) > Date.now()) { if (requested) throw Error("W1_PINNED_CONTINUATION_AFTER_KNOWLEDGE_CUT"); return null; }
  return body;
}
/** Caller has already locked every legacy+continuation context in one batch. */
export async function recordNativeStagesTx(ctx: PeMutationContext, s: SearchRow, rows: UnitRow[], selectionRows: Array<{ body: unknown; digest: string; created_at?: Date | string }>, c: PoolClient) {
  const attempts = await originalAttempts(s, c);
  for (const attempt of attempts) for (const kind of gapReasonsForAttempt(attempt)) await persistNativeGapTx(ctx, s, c,
    { kind, subjectRef: "p2-attempt:" + attempt.id, contextRef: "original-search:" + s.id,
      evidenceRefs: ["p2-attempt:" + attempt.id + ":" + attempt.digest] });
  const seen = new Set<string>();
  for (const row of selectionRows) {
    if (sha(row.body) !== row.digest) throw Error("W1_ORIGINAL_SELECTION_EVENT_DIGEST_MISMATCH");
    const parsed = selected.safeParse(row.body);
    if (!parsed.success) {
      await persistNativeGapTx(ctx, s, c, { kind: "LEGACY_SELECTION_WITHOUT_COMPLETE_STATE", subjectRef: row.digest,
        contextRef: "original-search:" + s.id, evidenceRefs: ["p2-selection:" + row.digest] }); continue;
    }
    const selection = parsed.data;
    if (seen.has(selection.selectionGroupRef)) continue;
    seen.add(selection.selectionGroupRef);
    const id = "native-stage-observation:" + selection.selectionGroupRef;
    if ((await c.query("SELECT id FROM finnor_os.w1_stage_observations WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
      [s.tenant_id, s.principal_id, id])).rowCount) continue;
    const action = selection.stageAction, chosen = action ? rows.filter(unit => action.unitIds.includes(unit.id)) : [];
    if (action && (chosen.length !== action.unitIds.length || chosen.some(unit => ["PENDING", "QUEUED", "RUNNING"].includes(unit.status)))) continue;
    const actual = action ? attempts.filter(attempt => action.unitIds.includes(attempt.unit_id) &&
      attempt.body.w1SelectionGroupRef === selection.selectionGroupRef) : [];
    if (action && !actual.length) {
      await persistNativeGapTx(ctx, s, c, { kind: "WITHDRAWN_OR_UNEXECUTED_ASSIGNMENT_NOT_A_SAMPLE", subjectRef: selection.selectionGroupRef,
        contextRef: "original-search:" + s.id, evidenceRefs: ["p2-selection:" + row.digest] }); continue;
    }
    if (actual.some(attempt => attempt.body.originalEpisode !== selection.originalEpisode ||
        attempt.body.grantDigest !== s.request.computeGrant.contentDigest || attempt.body.resourceId !== s.binding.resourceId ||
        attempt.body.w1ActionRef !== action?.ref)) throw Error("W1_ORIGINAL_STAGE_ASSIGNMENT_BINDING_REQUIRED");
    if (actual.some(attempt => ["INTENT", "SUBMITTED"].includes(attempt.status))) continue;
    let after = frameFromOriginal(s, rows, attempts, selection.beforeFrame.history, selection.beforeFrame.obligations);
    if (!action) after = { ...after, disposition: selection.stoppedDisposition ?? after.disposition };
    const observation = "native-observation:" + nativeFrameKey({ ...after, history: [] });
    if (action) after.history = [...selection.beforeFrame.history, { actionRef: action.ref, observation }];
    const meters = actual.map(attempt => meterSchema.safeParse(attempt.body.w1Meter));
    const debitKnown = actual.length > 0 && actual.every(attempt => Number.isSafeInteger(attempt.body.steps) && Number(attempt.body.steps) >= 0 &&
      attempt.body.chargedNativeAttempts === 1 && typeof attempt.body.originalEpisode === "string");
    const started = row.created_at instanceof Date ? row.created_at.getTime() : row.created_at ? Date.parse(row.created_at) : NaN;
    const ended = meters.every(meter => meter.success) && meters.length ? Math.max(...meters.map(meter => meter.success ? Date.parse(meter.data.endedAt) : NaN)) : NaN;
    const wall = Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? String(ended - started) : null;
    const context = nativeContinuationContextSchema.parse({ tenantId: s.tenant_id, principalId: s.principal_id,
      ...selection.responseContext, sourceClass: "CONTROLLED_NATIVE" });
    const key = nativeContinuationContextKey(context);
    const sample = nativeStageObservationSchema.parse({
      schema: "finnor.w1.native-stage-observation.v1", id, assignmentRef: "native-stage-assignment:" + selection.selectionGroupRef,
      episodeRef: selection.originalEpisode,
      workId: selection.workId, premiseRef: "native-premise:" + sha({ source: context.pins.sourceRef, checker: context.pins.checkerRef }),
      split: z.object({ orchestration: EconomicOrchestrationOptionsSchema }).passthrough().parse(s.request).orchestration.observationSplit,
      before: selection.beforeFrame, action, after, observation,
      ...(selection.remaining ? { beforeRemaining: selection.remaining } : {}),
      consumption: { attempts: action ? debitKnown ? actual.length : null : 0,
        steps: action ? debitKnown ? actual.reduce((total, attempt) => total + Number(attempt.body.steps), 0) : null : 0, wallMs: wall },
      evidenceRefs: ["p2-selection:" + row.digest, ...actual.map(attempt => "p2-attempt:" + attempt.id + ":" + attempt.digest),
        ...(after.acceptanceRef ? [after.acceptanceRef] : [])],
      observedAt: new Date().toISOString(),
    });
    await c.query("INSERT INTO finnor_os.w1_stage_observations(tenant_id,principal_id,search_id,id,context_key,body,digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING",
      [s.tenant_id, s.principal_id, s.id, id, key, stable(sample), sha(sample)]);
    if (wall === null) await persistNativeGapTx(ctx, s, c, { kind: "MISSING_OR_CENSORED_STAGE_WALL_MEASUREMENT", subjectRef: id, contextRef: key, evidenceRefs: sample.evidenceRefs.slice(0, 16) });
    if (Date.parse(context.validUntil) <= Date.now()) {
      await persistNativeGapTx(ctx, s, c, { kind: "EXPIRED_OBSERVATION_CONTEXT", subjectRef: id, contextRef: key, evidenceRefs: [id] }); continue;
    }
    const prior = await readNativeContinuationTx(ctx, c, context, null);
    if ((prior?.samples.length ?? 0) >= NATIVE_CONTINUATION_LIMITS.samples) {
      await persistNativeGapTx(ctx, s, c, { kind: "CONTINUATION_RETENTION_BOUND", subjectRef: id, contextRef: key, evidenceRefs: [id] }); continue;
    }
    try {
      const fitted = fitNativeContinuation([...(prior?.samples ?? []), sample],
        { ...context, validUntil: new Date(Math.min(Date.parse(context.validUntil), Date.parse(prior?.context.validUntil ?? context.validUntil))).toISOString() },
        prior?.ref ?? null, sample.observedAt);
      await c.query("INSERT INTO finnor_os.w1_continuation_states(tenant_id,principal_id,context_key,body,digest) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT DO NOTHING",
        [s.tenant_id, s.principal_id, key, stable(fitted), sha(fitted)]);
    } catch (error) {
      await persistNativeGapTx(ctx, s, c, { kind: "CONDITIONAL_FIT_OR_RETENTION_UNPASSED", subjectRef: id, contextRef: key,
        evidenceRefs: [id], detail: error instanceof Error && /^W1_[A-Z_]+$/.test(error.message) ? error.message : "W1_BOUNDED_FIT_UNPASSED" });
    }
  }
}

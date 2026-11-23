/** Actual ordinary queue preservation, never a protected/disposable authority. */
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { getPool, PRODUCTION_JOB_CONTRACTS } from "@finnor/db";
import { JobQueue } from "../../apps/worker/src/queue";
import { digest } from "../../packages/capability-evolution/src/contracts";
import { immutable } from "../../packages/capability-evolution/src/specialist-publication-protocol";
import { withOriginalOriginOwningFixture } from "../../packages/governed-execution/src/specialist-origin-owning-fixture";
import { nativeWorkforceOriginalSchema } from "../../packages/orchestration/src/workforce-execution/contracts";
import { intakeWorkforceExecution } from "../../packages/orchestration/src/workforce-execution/runtime";
import { rootContext, tx } from "../../packages/orchestration/src/workforce-execution/store";
import { runWorkforceExecutionJob } from "../../packages/orchestration/src/workforce-execution/worker";
import { readPrivateQualifiedFixture, reserveQualifiedFixtureArtifacts,
  qualifiedFixtureFailureCode, refuseQualifiedFixture as refuse } from "./qualified-fixture-custody.mts";

const hex = z.string().regex(/^[a-f0-9]{64}$/), text = z.string().min(1).max(4096);
export const qualifiedOrdinaryQueueFixtureSchema = z.object({
  schema: z.literal("finnor.w2.prequalified-ordinary-queue-fixture.v1"),
  lane: z.enum(["FRESH_DATABASE", "ALREADY_APPLIED_UPGRADE"]), runId: z.string().uuid(),
  database: z.string().regex(/^finnor_w2_e2e_[a-z0-9_]+$/), workerSqlLogin: text,
  tenantId: z.string().uuid(), principalId: z.string().uuid(), workId: z.string().uuid(),
  workerInstanceId: text, leaseSeconds: z.number().int().min(30).max(600),
  maximumTicks: z.number().int().min(2).max(64), maximumWallMs: z.number().int().min(1000).max(300000),
  original: nativeWorkforceOriginalSchema,
  dataClass: z.literal("HUMAN_APPROVED_DEVELOPER_TEST_DATA_ONLY"),
}).strict();
export const ordinaryQueuedPreservationEpisodeSchema = z.object({
  schema: z.literal("finnor.w2.actual-ordinary-queued-preservation.v1"),
  status: z.literal("ACTUAL_ORDINARY_CLOSED"), fixtureSha256: hex,
  lane: qualifiedOrdinaryQueueFixtureSchema.shape.lane, programmeId: z.string().uuid(),
  originalWorkId: z.string().uuid(), originalInputId: z.string().uuid(), originalDigest: hex,
  queuedHandlerInvocations: z.number().int().min(2), closedAssignments: z.number().int().positive(),
  actualClaimDigests: z.array(hex).min(2).max(64), finalOutcomeDigest: hex,
  actualCompletionDigest: hex, observerInvocationCount: z.literal(0),
  modelPossibleCount: z.literal(0), specialistNativeReadyCount: z.literal(0),
  protectedAuthorityUsed: z.literal(false), providerInvoked: z.literal(false),
}).strict();
export type OrdinaryQueuedPreservationEpisode = z.infer<typeof ordinaryQueuedPreservationEpisodeSchema>;

export async function produceOrdinaryQueuedPreservationEpisode(input: {
  readonly fixturePath: string; readonly artifactDirectory: string; readonly signal: AbortSignal;
}) {
  const artifacts = await reserveQualifiedFixtureArtifacts(input.artifactDirectory);
  let programmeId: string | null = null, fixtureSha256: string | null = null;
  let observerInvocationCount = 0;
  const handler: { failure?: { error: unknown } } = {};
  const claims: string[] = [];
  try {
    const loaded = await readPrivateQualifiedFixture(input.fixturePath, qualifiedOrdinaryQueueFixtureSchema);
    const f = loaded.fixture; fixtureSha256 = loaded.fixtureSha256;
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(f.maximumWallMs)]);
    signal.throwIfAborted();
    if (process.platform !== "linux" || !process.getuid?.()) refuse("W2_ORDINARY_REAL_WORKER_OS_REQUIRED");
    if (f.original.operations.some(operation => !["SUM_INTEGERS", "SORT_STRINGS"].includes(operation.computation.kind))
      || f.original.outcome.tasks.some(task => task.assignmentMode !== "INTERNAL_AUTHORIZED")
      || Date.parse(f.original.outcome.deadline) <= Date.now())
      refuse("W2_ORDINARY_NO_MODEL_INTERNAL_ORIGINAL_REQUIRED");
    const database = (await getPool().query(`SELECT current_database() database,session_user login,current_user actor,
      r.rolsuper,r.rolbypassrls FROM pg_catalog.pg_roles r WHERE r.rolname=session_user`)).rows[0];
    signal.throwIfAborted();
    if (database?.database !== f.database || database.login !== f.workerSqlLogin || database.actor !== database.login
      || database.rolsuper || database.rolbypassrls) refuse("W2_ORDINARY_DISPOSABLE_WORKER_LOGIN_REQUIRED");
    const ctx = rootContext({ tenant_id: f.tenantId, principal_id: f.principalId });
    const prior = await tx(ctx, async c => (await c.query(`SELECT
      (SELECT count(*) FROM finnor_os.w2_programs WHERE tenant_id=$1 AND work_id=$2)::integer programmes,
      (SELECT count(*) FROM finnor_os.jobs WHERE status IN('queued','running'))::integer pending_jobs`,
    [f.tenantId, f.workId])).rows[0]);
    signal.throwIfAborted();
    if (prior?.programmes !== 0 || prior.pending_jobs !== 0) refuse("W2_ORDINARY_NEW_ORIGINAL_ONLY_NO_RETRY");
    const accepted = await intakeWorkforceExecution(ctx, { workId: f.workId,
      idempotencyKey: "qualified-ordinary:" + f.runId, original: f.original });
    if (accepted.semanticReplay) refuse("W2_ORDINARY_NEW_ORIGINAL_ONLY_NO_RETRY");
    programmeId = accepted.id;
    const queue = new JobQueue(f.workerInstanceId, f.leaseSeconds);
    queue.register("run_workforce_execution_v1", async (payload, execution) => {
      try {
        if (!execution || payload.tenantId !== f.tenantId || payload.principalId !== f.principalId
          || payload.programId !== programmeId || !["COMPILE", "ADVANCE"].includes(String(payload.phase)))
          refuse("W2_ORDINARY_REAL_QUEUED_HANDLER_REQUIRED");
        claims.push(digest({ jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId,
          claimFence: execution.claimFence, phase: payload.phase }));
        await withOriginalOriginOwningFixture(async () => {
          observerInvocationCount++;
          refuse("W2_ORDINARY_MUST_NOT_ENTER_SPECIALIST_ORIGIN_OBSERVER");
        }, () => runWorkforceExecutionJob(payload, execution));
      } catch (error) { handler.failure ??= { error }; throw error; }
    }, PRODUCTION_JOB_CONTRACTS.run_workforce_execution_v1);
    for (let tick = 0; tick < f.maximumTicks; tick++) {
      signal.throwIfAborted(); await queue.tick(signal); signal.throwIfAborted();
      if (handler.failure !== undefined) throw handler.failure.error;
      const observed = await tx(ctx, async c => {
        const row = (await c.query(`SELECT q.status,q.work_input_id,q.original_digest,q.program,
          w.status work_status,w.final_outcome FROM finnor_os.w2_programs q
          JOIN finnor_os.works w ON w.tenant_id=q.tenant_id AND w.id=q.work_id AND w.created_by=q.principal_id
          WHERE q.tenant_id=$1 AND q.id=$2 AND q.principal_id=$3 AND q.work_id=$4`,
        [f.tenantId, programmeId, f.principalId, f.workId])).rows[0];
        const events = (await c.query(`SELECT event_id,kind,body FROM finnor_os.w2_events
          WHERE tenant_id=$1 AND program_id=$2 ORDER BY event_id LIMIT 8193`, [f.tenantId, programmeId])).rows;
        return { row, events };
      });
      signal.throwIfAborted();
      if (!observed.row || observed.events.length > 8192) refuse("W2_ORDINARY_BOUNDED_ACTUAL_READBACK_REQUIRED");
      if (observed.events.some(event => ["READ_ONLY_RECOVERY", "SPECIALIST_REFUSED"].includes(event.kind)))
        refuse("W2_ORDINARY_UNCERTAIN_NO_REPLACEMENT_TICK");
      const possible = observed.events.filter(event => event.event_id.startsWith("specialist-model-possible:"));
      const native = observed.events.filter(event => event.kind === "SPECIALIST_NATIVE_READY");
      if (possible.length || native.length || observerInvocationCount)
        refuse("W2_ORDINARY_SPECIALIST_PATH_ENTERED");
      if (observed.row.status === "CLOSED") {
        const program = z.object({ assignments: z.array(z.object({
          state: z.object({ kind: z.literal("CLOSED") }).passthrough(),
        }).passthrough()).min(1) }).passthrough().parse(observed.row.program);
        const completion = observed.events.find(event => event.event_id === "completed" && event.kind === "COMPLETION");
        const final = z.object({ schema: z.literal("finnor.workforce-verified-outcome.v1"),
          programId: z.string(), originalInput: z.string(), protectedReceipt: z.null(),
          check: z.object({ valid: z.literal(true) }).passthrough(),
        }).passthrough().parse(observed.row.final_outcome);
        if (observed.row.work_status !== "completed" || final.programId !== programmeId
          || final.originalInput !== accepted.workInputId || observed.row.work_input_id !== accepted.workInputId
          || !completion || completion.body.protectedAdmission !== false
          || completion.body.check?.valid !== true || claims.length < 2)
          refuse("W2_ORDINARY_ACTUAL_COMPLETION_REQUIRED");
        const episode = ordinaryQueuedPreservationEpisodeSchema.parse({
          schema: "finnor.w2.actual-ordinary-queued-preservation.v1", status: "ACTUAL_ORDINARY_CLOSED",
          fixtureSha256, lane: f.lane, programmeId, originalWorkId: f.workId,
          originalInputId: accepted.workInputId, originalDigest: observed.row.original_digest,
          queuedHandlerInvocations: claims.length, closedAssignments: program.assignments.length,
          actualClaimDigests: claims, finalOutcomeDigest: digest(final), actualCompletionDigest: digest(completion.body),
          observerInvocationCount, modelPossibleCount: possible.length, specialistNativeReadyCount: native.length,
          protectedAuthorityUsed: false, providerInvoked: false,
        });
        signal.throwIfAborted();
        const receipt = await artifacts.write("ordinary-queued-preservation.json", episode);
        signal.throwIfAborted();
        return Object.freeze({ episode: immutable(episode), episodePath: receipt.path, episodeSha256: receipt.sha256 });
      }
      await delay(250, undefined, { signal });
    }
    refuse("W2_ORDINARY_ORIGINAL_QUEUE_BOUND");
  } catch (error) {
    try {
      await artifacts.write("ordinary-queued-failure.json", {
        schema: "finnor.w2.actual-ordinary-queued-failure.v1", status: "FAILED_NOT_PRESERVED",
        programmeId, fixtureSha256, observerInvocationCount, queuedHandlerInvocations: claims.length,
        failureCode: qualifiedFixtureFailureCode(error), qualificationGranted: false,
      });
    } catch { /* Preserve the actual first error, never count evidence failure as PASS. */ }
    throw error;
  }
}

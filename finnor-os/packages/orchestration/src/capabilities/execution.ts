import { assertCurrentClaim, CapabilityJobClaimSchema, type CapabilityJobClaim } from "./job-claim";
import { sql } from "drizzle-orm";
import { withTenant } from "@finnor/db";
import { runPythonEngine, CapabilityEngineError } from "@finnor/tools/capabilities/python-runner";
import { reserveBudget, releaseBudget } from "@finnor/tools/provider-budget";
import { CAPABILITY_PROVIDERS, type CapabilityActor, type CapabilityRun, type FrozenDocumentSource } from "./contracts";
import { appendCapabilityEvent, jsonbBytes, loadCapabilitySource, rowToCapabilityRun } from "./repository";
import { assertCapabilityAuthorityRevision, assertCapabilityOwnerValidity, authorizeCapability, capabilityDigest, requireActiveCapabilityPrincipal } from "./policy";
import { executeParallelStep, executeParallelMonitorControl } from "./parallel-execution";
import { executePageIndexStep } from "./pageindex-execution";
import { executeNangoStep } from "./nango-execution";
import { executeModalStep, executeModalControlStep, cleanupFailedModalRun } from "./modal-execution";
import { executeGepa } from "./gepa-execution";
import { persistDerivedDocumentEvidence } from "./document-evidence";
import { executeShinka } from "./shinka-execution";
import type { ProviderCheckpoint, ProviderStep } from "./provider-step";

async function claimRun(actor: CapabilityActor, runId: string, claim: CapabilityJobClaim): Promise<CapabilityRun | null> {
  return withTenant(actor.tenantId, async db => {
    await assertCurrentClaim(db, claim, actor.tenantId);
    await requireActiveCapabilityPrincipal(db, actor);
    const selected = await db.execute(sql`SELECT * FROM finnor_os.capability_runs WHERE tenant_id=${actor.tenantId}::uuid
      AND principal_id=${actor.userId}::uuid AND id=${runId}::uuid AND job_id=${claim.jobId}::uuid FOR UPDATE`);
    if (!selected.rows[0]) throw new CapabilityEngineError("CAPABILITY_RUN_NOT_FOUND");
    const run = rowToCapabilityRun(selected.rows[0]);
    if (["SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"].includes(run.status)) return null;
    const nonResumableOptimizer = ["gepa_optimize", "shinka_evolve"].includes(run.kind) && Object.keys(run.remoteState).length > 0;
    if (run.status === "RUNNING" && CAPABILITY_PROVIDERS[run.kind].remote && (run.remoteState.phase === "dispatching" || nonResumableOptimizer)) {
      await db.execute(sql`UPDATE finnor_os.capability_runs SET status='UNKNOWN',failure_code='PRIOR_PROVIDER_ATTEMPT_REQUIRES_RECONCILIATION',updated_at=clock_timestamp()
        WHERE tenant_id=${actor.tenantId}::uuid AND id=${runId}::uuid`);
      await appendCapabilityEvent(db, actor.tenantId, runId, "UNKNOWN", { reason: "PRIOR_PROVIDER_ATTEMPT_REQUIRES_RECONCILIATION" });
      return null;
    }
    const updated = await db.execute(sql`UPDATE finnor_os.capability_runs SET status='RUNNING',worker_claim_token=${claim.claimToken}::uuid,
      started_at=coalesce(started_at,clock_timestamp()),updated_at=clock_timestamp() WHERE tenant_id=${actor.tenantId}::uuid AND id=${runId}::uuid RETURNING *`);
    await appendCapabilityEvent(db, actor.tenantId, runId, "CLAIMED", { jobId: claim.jobId, claimFence: claim.claimFence });
    return rowToCapabilityRun(updated.rows[0]);
  }, actor.userId);
}

interface RemoteProgress { active: boolean; state: Record<string, unknown> }
function remoteCheckpoint(actor: CapabilityActor, run: CapabilityRun, claim: CapabilityJobClaim, progress: RemoteProgress): ProviderCheckpoint {
  return async (state, event) => {
    if (Buffer.byteLength(JSON.stringify(state)) > 60_000) throw new CapabilityEngineError("CAPABILITY_REMOTE_STATE_TOO_LARGE");
    if (event === "PROVIDER_ACCEPTED") {
      // An acknowledgement is a fact about a dispatched request. Recording it
      // grants no read/result/effect authority and must survive later revocation.
      progress.active = true; progress.state = structuredClone(state);
      const receipt = { requestDigest: run.requestDigest, jobId: claim.jobId, claimToken: claim.claimToken, claimFence: claim.claimFence };
      try {
        await withTenant(actor.tenantId, async db => {
          await assertCurrentClaim(db, claim, actor.tenantId);
          const updated = await db.execute(sql`UPDATE finnor_os.capability_runs SET remote_state=${JSON.stringify(state)}::jsonb,updated_at=clock_timestamp()
            WHERE tenant_id=${actor.tenantId}::uuid AND id=${run.id}::uuid AND job_id=${claim.jobId}::uuid AND status='RUNNING' AND worker_claim_token=${claim.claimToken}::uuid RETURNING id`);
          if (!updated.rows.length) throw new CapabilityEngineError("CAPABILITY_ACCEPTED_RECEIPT_FENCED");
          await appendCapabilityEvent(db, actor.tenantId, run.id, event, { state, receipt });
        }, actor.userId);
      } catch (error) {
        // A stale delivery cannot change the run. Preserve its independently
        // scoped late receipt in the append-only journal for reconciliation.
        await withTenant(actor.tenantId, async db => {
          const selected = await db.execute(sql`SELECT id FROM finnor_os.capability_runs WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid
            AND id=${run.id}::uuid AND request_digest=${run.requestDigest}`);
          if (selected.rows.length) await appendCapabilityEvent(db, actor.tenantId, run.id, event, { state, receipt: { ...receipt, late: true } });
        }, actor.userId);
        throw error;
      }
      // Further provider reads and result publication still need current rights.
      const current = await authorizeCapability(actor, run.request, run.sources);
      await withTenant(actor.tenantId, async db => { await requireActiveCapabilityPrincipal(db, actor); await assertCapabilityAuthorityRevision(db, actor.tenantId, current.authorityRevision); }, actor.userId);
      if (Date.now() >= Date.parse(run.deadlineAt)) throw new CapabilityEngineError("CAPABILITY_DEADLINE_EXCEEDED");
      return;
    }
    const decision = await authorizeCapability(actor, run.request, run.sources);
    if (event === "PROVIDER_DISPATCH" && ["parallel_task", "parallel_find", "parallel_monitor", "pageindex_index", "pageindex_retrieve", "modal_execute", "gepa_optimize", "shinka_evolve"].includes(run.kind)) {
      const provider = CAPABILITY_PROVIDERS[run.kind].provider;
      const key = provider === "pageindex" ? "FINNOR_PAGEINDEX_MAX_RUNS_PER_TENANT_DAY" : provider === "modal" ? "FINNOR_MODAL_MAX_RUNS_PER_TENANT_DAY"
        : provider === "gepa" ? "FINNOR_GEPA_MAX_RUNS_PER_TENANT_DAY" : provider === "shinka" ? "FINNOR_SHINKA_MAX_RUNS_PER_TENANT_DAY" : "FINNOR_PARALLEL_MAX_RUNS_PER_TENANT_DAY";
      const limit = Number(process.env[key] ?? 1);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new CapabilityEngineError("PROVIDER_DAILY_LIMIT_INVALID");
      const acceptedDay = new Date(Date.parse(run.deadlineAt) - run.request.timeoutMs);
      const reservation = await reserveBudget(actor.tenantId, provider, "capability_submissions", limit, 1, acceptedDay, run.id);
      if (!reservation.allowed) throw new CapabilityEngineError("PROVIDER_DAILY_SUBMISSION_LIMIT");
      if (run.kind === "shinka_evolve" && Array.isArray(state.sandboxes)) {
        const latest: unknown = state.sandboxes.at(-1);
        if (latest && typeof latest === "object" && "physicalId" in latest && typeof latest.physicalId === "string" && "state" in latest
          && latest.state && typeof latest.state === "object" && "phase" in latest.state && latest.state.phase === "dispatching" && !("sandboxId" in latest.state)) {
          const modalLimit = Number(process.env.FINNOR_MODAL_MAX_RUNS_PER_TENANT_DAY ?? 1);
          if (!Number.isSafeInteger(modalLimit) || modalLimit < 1 || modalLimit > 1000) throw new CapabilityEngineError("PROVIDER_DAILY_LIMIT_INVALID");
          const sandboxReservation = await reserveBudget(actor.tenantId, "modal", "capability_submissions", modalLimit, 1, acceptedDay, `${run.id}:${latest.physicalId}`);
          if (!sandboxReservation.allowed) throw new CapabilityEngineError("MODAL_DAILY_SANDBOX_LIMIT");
        }
      }
    }
    await withTenant(actor.tenantId, async db => {
      await assertCurrentClaim(db, claim, actor.tenantId);
      await requireActiveCapabilityPrincipal(db, actor);
      await assertCapabilityAuthorityRevision(db, actor.tenantId, decision.authorityRevision);
      const updated = await db.execute(sql`UPDATE finnor_os.capability_runs SET remote_state=${JSON.stringify(state)}::jsonb,updated_at=clock_timestamp()
        WHERE tenant_id=${actor.tenantId}::uuid AND id=${run.id}::uuid AND job_id=${claim.jobId}::uuid AND status='RUNNING'
        AND worker_claim_token=${claim.claimToken}::uuid AND deadline_at>clock_timestamp() RETURNING id`);
      if (!updated.rows.length) throw new CapabilityEngineError("CAPABILITY_CHECKPOINT_FENCED_OR_EXPIRED");
      await appendCapabilityEvent(db, actor.tenantId, run.id, event, state);
    }, actor.userId);
    progress.active = true; progress.state = structuredClone(state);
  };
}

function sourceFor(run: CapabilityRun, versionId: string): FrozenDocumentSource {
  const found = run.sources.find(s => s.versionId === versionId);
  if (!found) throw new CapabilityEngineError("CAPABILITY_FROZEN_SOURCE_MISSING");
  return found;
}

async function executeEngine(actor: CapabilityActor, run: CapabilityRun): Promise<Record<string, unknown>> {
  const request = run.request, deadlineAt = Date.parse(run.deadlineAt);
  if (deadlineAt <= Date.now()) throw new CapabilityEngineError("CAPABILITY_DEADLINE_EXCEEDED");
  switch (request.kind) {
    case "duckdb_query": {
      const tables = await Promise.all(request.datasets.map(async dataset => {
        const source = sourceFor(run, dataset.versionId), bytes = await loadCapabilitySource(actor, source, deadlineAt);
        return { name: dataset.name, format: dataset.format, bytesBase64: bytes.toString("base64"), sha256: source.sha256, source };
      }));
      const executed = await runPythonEngine("duckdb", { tables, query: request.query, maxRows: request.maxRows }, { deadlineAt });
      return { ...executed.result, computeIdentity: executed.identity };
    }
    case "docling_extract": {
      const source = sourceFor(run, request.source.versionId), bytes = await loadCapabilitySource(actor, source, deadlineAt);
      const executed = await runPythonEngine("docling", { bytesBase64: bytes.toString("base64"), sha256: source.sha256, source, forceOcr: request.forceOcr,
        modelsPath: process.env.FINNOR_DOCLING_MODELS_DIR }, { deadlineAt });
      return { ...executed.result, computeIdentity: executed.identity };
    }
    case "pywhy_assess": {
      const source = sourceFor(run, request.dataset.versionId), bytes = await loadCapabilitySource(actor, source, deadlineAt);
      const executed = await runPythonEngine("pywhy", { ...request, format: request.dataset.format, bytesBase64: bytes.toString("base64"), sha256: source.sha256, source }, { deadlineAt });
      return { ...executed.result, computeIdentity: executed.identity, ...(request.interventionModelRef ? { s3Context: { interventionModelRef: request.interventionModelRef,
        owner: "S3", assessmentRole: "SEPARATE_CONDITIONAL_ESTIMATE_NOT_TEMPORAL_DYNAMICS_MODEL", temporalModelReplaced: false, modelAdmissionGranted: false } } : {}) };
    }
    case "pageindex_index": case "pageindex_retrieve": case "gepa_optimize": case "shinka_evolve":
    case "modal_execute": case "modal_control": case "nango_sync": case "parallel_task": case "parallel_find": case "parallel_monitor": case "parallel_monitor_control":
      throw new CapabilityEngineError("CAPABILITY_PROVIDER_STEP_REQUIRED");
    default: { const exhaustive: never = request; return exhaustive; }
  }
}

export async function executeCapabilityRun(actor: CapabilityActor, runId: string, inputClaim: CapabilityJobClaim): Promise<void> {
  const claim = CapabilityJobClaimSchema.parse(inputClaim);
  const run = await claimRun(actor, runId, claim);
  if (!run) return;
  let output: Record<string, unknown> | null = null, failure: string | null = null, publicationRevision: number | null = null;
  let ownerValidUntil: string | null = null;
  let pending: Extract<ProviderStep, { status: "waiting" }> | null = null, unknown: Extract<ProviderStep, { status: "unknown" }> | null = null;
  let notDispatched: Extract<ProviderStep, { status: "not_dispatched" }> | null = null;
  const progress: RemoteProgress = { active: CAPABILITY_PROVIDERS[run.kind].remote && ["accepted", "dispatching"].includes(String(run.remoteState.phase)), state: structuredClone(run.remoteState) };
  const checkpoint = remoteCheckpoint(actor, run, claim, progress);
  let cleanupReason: string | null = null;
  const requireReconciliation = (code: string) => { if (progress.active) unknown = { status: "unknown", remoteState: progress.state, code: `${code}_REQUIRES_PROVIDER_RECONCILIATION` }; };
  try {
    await authorizeCapability(actor, run.request, run.sources);
    const step: ProviderStep = run.kind === "parallel_monitor_control" ? await executeParallelMonitorControl(actor, run, checkpoint)
      : ["parallel_task", "parallel_find", "parallel_monitor"].includes(run.kind) ? await executeParallelStep(run, checkpoint)
      : run.kind === "pageindex_index" || run.kind === "pageindex_retrieve" ? await executePageIndexStep(actor, run, checkpoint)
      : run.kind === "nango_sync" ? await executeNangoStep(actor, run, claim)
      : run.kind === "modal_execute" ? await executeModalStep(actor, run, checkpoint)
      : run.kind === "modal_control" ? await executeModalControlStep(actor, run, checkpoint)
      : run.kind === "gepa_optimize" ? await (async (): Promise<ProviderStep> => {
        await checkpoint({ provider: "gepa", phase: "dispatching", optimizerRunId: run.id, sourceDigest: run.sources[0]?.sha256 }, "PROVIDER_DISPATCH");
        const result = await executeGepa(actor, run);
        await checkpoint({ provider: "gepa", phase: "accepted", optimizerRunId: run.id, candidateDigest: result.candidateDigest }, "PROVIDER_ACCEPTED");
        return { status: "complete", result };
      })()
      : run.kind === "shinka_evolve" ? { status: "complete", result: await executeShinka(actor, run, checkpoint) }
      : { status: "complete", result: await executeEngine(actor, run) };
    if (step.status === "complete") output = step.result;
    else if (step.status === "waiting") pending = step;
    else if (step.status === "not_dispatched") {
      if (run.kind !== "modal_execute") throw new CapabilityEngineError("CAPABILITY_NEGATIVE_DISPATCH_FACT_INVALID");
      notDispatched = step; failure = step.code; progress.active = false;
    }
    else { unknown = step; failure = step.code; }
    if (Date.now() >= Date.parse(run.deadlineAt)) throw new CapabilityEngineError("CAPABILITY_DEADLINE_EXCEEDED");
    if (Buffer.byteLength(JSON.stringify(output)) > 8_000_000) throw new CapabilityEngineError("CAPABILITY_RESULT_TOO_LARGE");
    const publicationAuthorization = await authorizeCapability(actor, run.request, run.sources);
    publicationRevision = publicationAuthorization.authorityRevision; ownerValidUntil = publicationAuthorization.ownerValidUntil;
  } catch (error) { output = null; pending = null; failure = error instanceof CapabilityEngineError ? error.code : "CAPABILITY_ENGINE_FAILED"; requireReconciliation(failure); }
  await withTenant(actor.tenantId, async db => {
    await assertCurrentClaim(db, claim, actor.tenantId);
    if ((output || pending) && publicationRevision !== null) {
      try { await requireActiveCapabilityPrincipal(db, actor); await assertCapabilityAuthorityRevision(db, actor.tenantId, publicationRevision); }
      catch (error) {
        if (!(error instanceof CapabilityEngineError)) throw error;
        output = null; pending = null; failure = error.code; requireReconciliation(failure);
      }
    }
    // All potentially contended owner/claim/revision locks precede the final
    // clock read. Queue, execution, authorization and publication share one cut.
    await db.execute(sql`SELECT id FROM finnor_os.capability_runs WHERE tenant_id=${actor.tenantId}::uuid AND id=${runId}::uuid FOR UPDATE`);
    if (output || pending) {
      try { await assertCapabilityOwnerValidity(db, ownerValidUntil); }
      catch (error) {
        if (!(error instanceof CapabilityEngineError)) throw error;
        output = null; pending = null; failure = error.code; requireReconciliation(failure);
      }
    }
    await db.execute(sql`SAVEPOINT capability_document_evidence`);
    if (output && publicationRevision !== null) output = await persistDerivedDocumentEvidence(db, actor, run, output, publicationRevision);
    if (output && await jsonbBytes(db, output) > 8_388_608) { output = null; failure = "CAPABILITY_RESULT_TOO_LARGE"; requireReconciliation(failure); }
    const clock = await db.execute(sql`SELECT clock_timestamp()>=deadline_at AS expired FROM finnor_os.capability_runs WHERE tenant_id=${actor.tenantId}::uuid AND id=${runId}::uuid`);
    if (clock.rows[0]?.expired === true) { output = null; pending = null; failure = "CAPABILITY_DEADLINE_EXCEEDED"; requireReconciliation(failure); }
    if (!output) await db.execute(sql`ROLLBACK TO SAVEPOINT capability_document_evidence`);
    if (pending) {
      const next = await db.execute(sql`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,priority,protocol_version,run_at)
        VALUES(${actor.tenantId}::uuid,'run_capability_provider_v1',${JSON.stringify({ tenantId: actor.tenantId, principalId: actor.userId, runId, _correlationId: run.correlationId })}::jsonb,
        ${`capability:${actor.tenantId}:${runId}:poll:${String(pending.remoteState.polls)}`},'batch',0,1,
        least(${run.deadlineAt}::timestamptz,clock_timestamp()+${String(pending.delayMs)}::int*interval '1 millisecond')) RETURNING id`);
      const updated = await db.execute(sql`UPDATE finnor_os.capability_runs SET status='WAITING_PROVIDER',remote_state=${JSON.stringify(pending.remoteState)}::jsonb,
        job_id=${String(next.rows[0]!.id)}::uuid,worker_claim_token=NULL,updated_at=clock_timestamp()
        WHERE tenant_id=${actor.tenantId}::uuid AND id=${runId}::uuid AND status='RUNNING' AND worker_claim_token=${claim.claimToken}::uuid RETURNING id`);
      if (!updated.rows.length) throw new CapabilityEngineError("CAPABILITY_PUBLICATION_FENCED");
      await appendCapabilityEvent(db, actor.tenantId, runId, "PROVIDER_OBSERVED", { state: pending.remoteState, nextJobId: next.rows[0]!.id });
      return;
    }
    let finalOutput = output, finalFailure = unknown?.code ?? failure;
    let result = await db.execute(sql`UPDATE finnor_os.capability_runs SET status=${finalOutput ? "SUCCEEDED" : unknown ? "UNKNOWN" : "FAILED"},result=${finalOutput ? JSON.stringify(finalOutput) : null}::jsonb,
      result_digest=${finalOutput ? capabilityDigest(finalOutput) : null},failure_code=${finalFailure},remote_state=CASE WHEN ${unknown !== null} THEN ${JSON.stringify(unknown?.remoteState ?? {})}::jsonb WHEN ${notDispatched !== null} THEN ${JSON.stringify(notDispatched?.remoteState ?? {})}::jsonb ELSE remote_state END,completed_at=clock_timestamp(),updated_at=clock_timestamp()
      WHERE tenant_id=${actor.tenantId}::uuid AND principal_id=${actor.userId}::uuid AND id=${runId}::uuid
      AND status='RUNNING' AND worker_claim_token=${claim.claimToken}::uuid AND (${finalOutput === null} OR (deadline_at>clock_timestamp()
        AND (${ownerValidUntil}::timestamptz IS NULL OR clock_timestamp()<${ownerValidUntil}::timestamptz))) RETURNING id`);
    if (!result.rows.length && finalOutput) {
      await db.execute(sql`ROLLBACK TO SAVEPOINT capability_document_evidence`);
      let expiredCode = "CAPABILITY_DEADLINE_EXCEEDED";
      try { await assertCapabilityOwnerValidity(db, ownerValidUntil); }
      catch (error) { if (!(error instanceof CapabilityEngineError)) throw error; expiredCode = error.code; }
      finalOutput = null; requireReconciliation(expiredCode); finalFailure = unknown?.code ?? expiredCode;
      result = await db.execute(sql`UPDATE finnor_os.capability_runs SET status=${unknown ? "UNKNOWN" : "FAILED"},result=NULL,result_digest=NULL,failure_code=${finalFailure},completed_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE tenant_id=${actor.tenantId}::uuid AND id=${runId}::uuid AND status='RUNNING' AND worker_claim_token=${claim.claimToken}::uuid RETURNING id`);
    }
    if (!result.rows.length) throw new CapabilityEngineError("CAPABILITY_PUBLICATION_FENCED");
    if (!finalOutput) cleanupReason = finalFailure ?? "CAPABILITY_TERMINAL_WITHOUT_RESULT";
    await appendCapabilityEvent(db, actor.tenantId, runId, finalOutput ? "COMPLETED" : unknown ? "UNKNOWN" : "FAILED", { resultDigest: finalOutput ? capabilityDigest(finalOutput) : null, failureCode: finalFailure });
  }, actor.userId);
  if (notDispatched && run.kind === "modal_execute") {
    try { await releaseBudget(actor.tenantId, "modal", "capability_submissions", 1, new Date(Date.parse(run.deadlineAt) - run.request.timeoutMs), run.id); }
    catch { /* A missed refund retains the conservative reservation; no dispatch is retried. */ }
  }
  if (cleanupReason) await cleanupFailedModalRun(actor, run, claim, cleanupReason);
}

import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@finnor/shared-types';
import { acquireComputeResourceLeases, renewComputeResourceLeases, releaseComputeResourceLeases, PRODUCTION_JOB_CONTRACTS } from '@finnor/db';
import { JobQueue, type JobExecutionContext } from '../../../../apps/worker/src/queue';
import { Classes, fault, hash, LIMITS, type InputArtifact } from './contracts';
import { actor, artifact, assertBasis, assertFence, changeState, head, inputFor, readArtifact, tx } from './store';
import { currentInput } from './owners';
import { executeCell, fixedProcess, InvocationFailure } from './runtime';
import { verifyCheckpoint } from './checkpoint';
import { cleanNativePreparation, releaseNativePreparation } from './preparation';
import { assertWorkBudget, costOnce, measuredInterval, recoverAttemptLiabilities } from './accounting';
import { LinuxCellFailure } from './linux';
export interface WorkerHooks { boundary?: (name: string, detail: Record<string, any>) => Promise<void> }

export function branchQueue(hooks: WorkerHooks = {}) {
  const queue = new JobQueue('p3-worker:' + randomUUID(), 60, 'HEAVY');
  queue.register('run_branch_fabric_v1', (payload, execution) => handleBranch(payload, execution!, hooks), PRODUCTION_JOB_CONTRACTS.run_branch_fabric_v1);
  return queue;
}
export async function handleBranch(payload: Record<string, unknown>, execution: Readonly<JobExecutionContext>, hooks: WorkerHooks = {}) {
  if (!execution || typeof payload.branchId !== 'string' || typeof payload.principalId !== 'string' || payload.tenantId !== execution.tenantId) fault('BRANCH_JOB_BINDING_INVALID');
  const ctx: TenantContext = { tenantId: execution.tenantId!, userId: payload.principalId, employeeId: payload.principalId, role: 'owner' };
  const branchId = payload.branchId, initial = await tx(ctx, c => head(c, ctx, branchId));
  if (initial.status === 'COMPLETE') {
    // Post-commit/pre-ACK replay never launches twice, but the interrupted
    // controller may not have committed its final physical usage record.
    await tx(ctx, async c => {
      const attempts = (await c.query("SELECT id,body FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND category='ATTEMPT' AND body->>'branchId'=$3", [ctx.tenantId, actor(ctx), branchId])).rows;
      const costs = (await c.query("SELECT body FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND category='COST' AND body->>'branchId'=$3", [ctx.tenantId, actor(ctx), branchId])).rows;
      await recoverAttemptLiabilities(c, ctx, initial.work_id, branchId, attempts, costs);
    });
    return;
  }
  if (['INVALIDATED', 'QUARANTINED', 'FAILED', 'CANCELLED'].includes(initial.status)) return;
  if (initial.status === 'CANCEL_REQUESTED') {
    await tx(ctx, async c => { const h = await head(c, ctx, branchId, true); await changeState(c, h, 'CANCELLED'); await artifact(c, ctx, h.work_id, 'EVENT', { branchId, type: 'CANCELLED_BEFORE_LAUNCH', observedStopped: true }); });
    return;
  }
  const input = await inputFor(ctx, initial.input_id);
  await currentInput(ctx, input);
  const leases = await acquireComputeResourceLeases({ resourceKeys: ['native:p3-branch'], requiredResourceKeys: ['native:p3-branch'], tenantId: ctx.tenantId, workloadClass: 'HEAVY', ownerId: `p3:${branchId}:${execution.deliveryAttemptId}` });
  const controller = new AbortController(), epoch = initial.epoch;
  let generation = initial.generation;
  let attemptId: string | null = null, renewal: Promise<boolean> | null = null, failure: string | null = null;
  const began = performance.now(), beforeUsage = process.resourceUsage(), usage: any[] = [];
  let preparation: Awaited<ReturnType<typeof cleanNativePreparation>> | null = null;
  const heartbeat = async () => {
    if (controller.signal.aborted) return false;
    try {
      if (!await renewComputeResourceLeases(leases)) throw Error('RESOURCE_FENCE_LOST');
      await tx(ctx, async c => { const h = await head(c, ctx, branchId); await assertFence(c, h, execution); await assertBasis(c, ctx, h); if (h.generation !== generation || h.epoch !== epoch || ['CANCEL_REQUESTED', 'INVALIDATED'].includes(h.status)) throw Error('GENERATION_CANCELLED_OR_INVALIDATED'); });
      return true;
    } catch { controller.abort(); return false; }
  };
  execution.registerHeartbeat(heartbeat);
  const timer = setInterval(() => { renewal ??= heartbeat().finally(() => { renewal = null; }); }, 150);
  try {
    const cp = initial.request.checkpointId ? await verifyCheckpoint(ctx, input, initial.request.checkpointId) : null;
    await hooks.boundary?.('BEFORE_INTENT', { branchId });
    const intent = await tx(ctx, async c => {
      const h = await head(c, ctx, branchId, true); await assertBasis(c, ctx, h); await assertFence(c, h, execution);
      if (h.epoch !== epoch || h.generation !== generation) fault('BRANCH_GENERATION_CHANGED');
      const attempts = (await c.query("SELECT id,body FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND category='ATTEMPT' AND body->>'branchId'=$3", [ctx.tenantId, actor(ctx), branchId])).rows;
      const costs = (await c.query("SELECT body FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND category='COST' AND body->>'branchId'=$3", [ctx.tenantId, actor(ctx), branchId])).rows;
      await recoverAttemptLiabilities(c, ctx, h.work_id, branchId, attempts, costs);
      await assertWorkBudget(c, ctx, h.work_id);
      const charged = costs.reduce((n, r) => n + Number(r.body.elapsedMs ?? r.body.reservedLiabilityMs ?? LIMITS.wallMs + 5000), 0);
      const missing = attempts.filter(row => !costs.some(r => r.body.attemptId === row.id)).reduce((n, row) => n + Number(row.body.reservedWallMs ?? LIMITS.wallMs) + 5000, 0);
      if (attempts.length >= LIMITS.attempts || charged + missing + LIMITS.wallMs + 5000 > LIMITS.requestMs) return null;
      if (h.status !== 'PREPARING') {
        if (h.status !== 'INTERRUPTED') await changeState(c, h, 'INTERRUPTED', 'PRIOR_CONTROLLER_INTERRUPTED');
        await c.query("UPDATE finnor_os.p3_requests SET status='PREPARING',generation=generation+1 WHERE id=$1", [branchId]);
        generation = h.generation + 1;
      }
      const id = await artifact(c, ctx, h.work_id, 'ATTEMPT', { schema: 'finnor.branch-attempt.v1', branchId, physicalId: randomUUID(), generation, epoch, parentAttemptId: h.attempt_id, checkpointId: initial.request.checkpointId ?? null, resumeProtocol: cp ? (cp.state ? 'PRIVATE_LOGICAL_CLONE' : 'IMMUTABLE_RESTART') : 'FRESH', inputDigest: hash(input), programme: input.programme, jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId, claimToken: execution.claimToken, claimFence: execution.claimFence, leases, intentAt: new Date().toISOString(), reservedWallMs: LIMITS.wallMs, money: null, status: 'INTENT_BEFORE_LAUNCH' });
      await c.query("UPDATE finnor_os.p3_requests SET attempt_id=$2,status='RUNNING' WHERE id=$1", [branchId, id]);
      return id;
    });
    if (!intent) fault('BRANCH_TOTAL_BUDGET_EXHAUSTED');
    attemptId = intent;
    await hooks.boundary?.('AFTER_INTENT', { branchId, attemptId });
    preparation = await cleanNativePreparation(input, initial.request.mode);
    usage.push({ phase: 'PREPARATION', ...preparation, observedStopped: true });
    let effective = input;
    if (cp?.state) {
      const state = cp.state;
      const steps = input.payload.steps.filter((s: any) => !state.effects.some((e: any) => e.id === s.effectId));
      effective = { ...input, payload: { ...input.payload, state, steps, restored: true } };
    }
    await hooks.boundary?.('BEFORE_EXECUTION', { branchId, attemptId });
    const observedStart = (phase: 'EXECUTION' | 'CHECKER') => async (pid: number) => {
      await tx(ctx, c => artifact(c, ctx, initial.work_id, 'EVENT', { branchId, attemptId, generation, type: phase + '_PROCESS_STARTED', pid, processGroup: pid, at: new Date().toISOString(), qualification: 'REGISTERED_NATIVE_PROCESS_ID_NOT_HOSTILE_CONFINEMENT' }));
      await hooks.boundary?.(phase + '_PROCESS_STARTED', { branchId, attemptId, pid, processGroup: pid });
    };
    const executed = await executeCell(effective, controller.signal, observedStart('EXECUTION')); usage.push({ phase: 'EXECUTION', ...executed.receipt });
    await hooks.boundary?.('AFTER_EXECUTION', { branchId, attemptId, candidate: executed.candidate });
    if (controller.signal.aborted) fault('BRANCH_PUBLICATION_CANCELLED');
    await tx(ctx, async c => { const h = await head(c, ctx, branchId, true); await assertFence(c, h, execution); if (h.epoch !== epoch) fault('BRANCH_EPOCH_CHANGED'); await changeState(c, h, 'CHECKING'); });
    await hooks.boundary?.('BEFORE_CHECK', { branchId, attemptId });
    const checked = await fixedProcess('checker-worker.mts', { input: effective, candidate: executed.candidate, invocationDigest: executed.invocationDigest }, controller.signal, 5000, undefined, observedStart('CHECKER'));
    usage.push({ phase: 'CHECKING', ...checked.receipt });
    await hooks.boundary?.('AFTER_CHECK', { branchId, attemptId, check: checked.value });
    await currentInput(ctx, input);
    if (controller.signal.aborted) fault('BRANCH_PUBLICATION_CANCELLED');
    const result = {
      schema: 'finnor.rehearsal-branch.v1', branchId, attemptId, generation, epoch,
      tenantId: ctx.tenantId, principalId: actor(ctx), work: input.basis, root: input.root,
      kind: input.kind, programme: input.programme, baselineState: { inputDigest: hash(input), baselineDigest: hash(input.payload) },
      scenario: input.source.kind === 's3' ? input.ownerBindings : null,
      environmentAttestation: executed.receipt, candidate: executed.candidate, independentPostconditions: checked.value,
      check: checked.value, observations: usage, checkpoints: initial.request.checkpointId ? [initial.request.checkpointId] : [],
      evidenceClass: Classes[input.kind], result: executed.candidate.result,
      accepted: false, acceptanceDomain: 'INDEPENDENT_RUNTIME_DOMAIN_CERTIFICATION_REQUIRED',
      protectedEligible: false, admission: null, funding: null, externalSettlement: 'NOT_APPLICABLE',
      claimToken: execution.claimToken, claimFence: execution.claimFence, jobId: execution.jobId,
      cost: { moneyUSD: null, reconciliation: 'UNRECONCILED', scope: 'ALL_PHYSICAL_ATTEMPTS_PLUS_CONTROL_CHECK_STORAGE', attemptId },
    };
    // Blob first in its own durable transaction. Orphan on crash is discoverable
    // through branchId/category; query head never points to incomplete bytes.
    const resultId = await tx(ctx, c => artifact(c, ctx, initial.work_id, 'RESULT', result));
    await hooks.boundary?.('AFTER_BLOB_BEFORE_POINTER', { branchId, attemptId, resultId });
    // Blob persistence is not publication authority. Recheck an upstream change
    // across this durable recovery boundary before exposing a current pointer.
    await currentInput(ctx, input);
    await tx(ctx, async c => {
      const h = await head(c, ctx, branchId, true); await assertBasis(c, ctx, h); await assertFence(c, h, execution);
      if (h.generation !== generation || h.epoch !== epoch || h.status !== 'CHECKING' || h.attempt_id !== attemptId) fault('STALE_BRANCH_PUBLICATION');
      if (!checked.value.passed) {
        await changeState(c, h, checked.value.complete ? 'QUARANTINED' : 'FAILED', checked.value.complete ? 'INDEPENDENT_CHECK_FAILED' : 'INDEPENDENT_ORACLE_INCOMPLETE');
        await artifact(c, ctx, h.work_id, 'CLEANUP', { branchId, attemptId, orphanResultId: resultId, reason: 'UNQUALIFIED_RESULT_NOT_PUBLISHED', retainedCosts: true }); return;
      }
      await c.query("UPDATE finnor_os.p3_requests SET result_id=$2,status='COMPLETE' WHERE id=$1", [branchId, resultId]);
      await artifact(c, ctx, h.work_id, 'EVENT', { branchId, attemptId, generation, type: 'RESULT_PUBLISHED', resultId, resultDigest: hash(result), qualifiedDomain: checked.value.domain, isolated: executed.receipt.isolated, accepted: result.accepted });
    });
    await hooks.boundary?.('AFTER_POINTER_BEFORE_ACK', { branchId, attemptId, resultId });
  } catch (e) {
    failure = e instanceof Error ? e.message : 'BRANCH_FAILED';
    if (e instanceof InvocationFailure || e instanceof LinuxCellFailure) usage.push({ phase: 'FAILED_INVOCATION', ...e.receipt });
    controller.abort();
    await tx(ctx, async c => {
      const h = await head(c, ctx, branchId, true);
      if (h.status === 'COMPLETE' || h.generation !== generation) return;
      const stopped = usage.length === 0 || usage.every(u => u.observedStopped);
      const status = failure === 'BRANCH_TOTAL_BUDGET_EXHAUSTED' ? 'FAILED' : h.status === 'CANCEL_REQUESTED' && stopped ? 'CANCELLED' : h.status === 'INVALIDATED' ? 'INVALIDATED' : 'INTERRUPTED';
      await changeState(c, h, status, failure);
      await artifact(c, ctx, h.work_id, 'EVENT', { branchId, attemptId, generation, type: status, reason: failure, observedStopped: stopped, accountingLiabilityRetained: true });
    }).catch(() => undefined);
    if (!['CANCELLED', 'INVALIDATED'].includes((await tx(ctx, c => head(c, ctx, branchId))).status)) throw e;
  } finally {
    clearInterval(timer); if (renewal) await renewal;
    if (preparation) {
      const cleanup = await releaseNativePreparation(preparation);
      usage.push({ phase: 'PREPARATION_RETENTION', ...cleanup, observedStopped: true });
    }
    await tx(ctx, async c => {
      await costOnce(c, ctx, initial.work_id, `delivery:${execution.deliveryAttemptId}`, { branchId, attemptId, deliveryAttemptId: execution.deliveryAttemptId, generation, ...measuredInterval(began, beforeUsage), usage, failure, phases: ['PREPARATION', 'LAUNCH', 'EXECUTION', 'CHECKING', 'PUBLICATION', 'RECOVERY', 'STORAGE'], pricebookRef: null, externalAttemptRefs: [], parentIntervalsMayOverlap: true });
    }).catch(() => undefined);
    await releaseComputeResourceLeases(leases, 'P3_FIXED_INVOCATION_FINISHED_AFTER_CLOSE').catch(() => undefined);
  }
}

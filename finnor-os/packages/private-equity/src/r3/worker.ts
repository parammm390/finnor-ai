import { randomUUID } from 'node:crypto';
import { acquireComputeResourceLeases, releaseComputeResourceLeases, renewComputeResourceLeases,
  withDatabaseExecutionDeadline, ComputeCapacityUnavailableError, type ComputeResourceLease } from '@finnor/db';
import type { JobExecutionContext } from '../../../../apps/worker/src/queue';
import type { ElicitationCheck, ElicitationProtocol, ElicitationRule } from '../../../shared-types/src/elicitation-protocol';
import { proposeR3Rule, checkR3Rule, runR3Child, r3Digest, r3RuntimeIdentity, type R3ChildReceipt } from '../../../epistemic-runtime/src/incentive-rule-synthesis/launcher';
import { R3_BASE } from '../../../epistemic-runtime/src/incentive-rule-synthesis/contracts';
import { tx } from '../evidence-execution/store';
import type { PeMutationContext } from '../types';
import { assertR3Current } from './owners';
import { r3Authorize, r3Event, r3PutObject, r3Ref, r3Request, type R3RequestRow } from './store';

function context(payload: Record<string, unknown>): PeMutationContext {
  if (typeof payload.tenantId !== 'string' || typeof payload.principalId !== 'string') throw Error('R3_DURABLE_OWNER_IDENTITY_REQUIRED');
  return { auth: { tenantId: payload.tenantId, userId: payload.principalId, employeeId: payload.principalId, role: 'owner' },
    provenance: { sourceSystem: 'R3:durable-worker', createdBy: payload.principalId } };
}
async function claim(ctx: PeMutationContext, row: R3RequestRow, x: Readonly<JobExecutionContext>) {
  return tx(ctx, async c => {
    const locked = await r3Request(ctx, row.id, c, true);
    if (locked.generation !== row.generation || !['QUEUED', 'RUNNING'].includes(locked.status)) throw Error('R3_LOGICAL_JOB_GENERATION_FENCED');
    const current = (await c.query("SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND type='run_incentive_rule_synthesis_v1' AND protocol_version=1 AND status='running' AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE",
      [x.jobId, row.tenant_id, x.claimToken, x.claimFence])).rows[0];
    if (!current) throw Error('R3_ACTUAL_PHYSICAL_JOB_CLAIM_REQUIRED');
    await c.query("UPDATE finnor_os.r3_requests SET status='RUNNING',claim_token=$3,claim_fence=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",
      [row.tenant_id, row.id, x.claimToken, x.claimFence]);
    await r3Event(ctx, locked, 'DURABLE_CLAIM', { jobId: x.jobId, deliveryAttemptId: x.deliveryAttemptId,
      claimFence: x.claimFence, originalDeadlineAt: row.deadline_at.toISOString() }, c);
    return { ...locked, status: 'RUNNING', claim_token: x.claimToken, claim_fence: x.claimFence };
  });
}
async function admit(ctx: PeMutationContext, row: R3RequestRow, x: Readonly<JobExecutionContext>, phase: 'PRODUCER' | 'CHECKER') {
  return tx(ctx, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['s5-portfolio:' + row.tenant_id]);
    const locked = await r3Request(ctx, row.id, c, true); await r3Authorize(ctx, c);
    if (locked.generation !== row.generation || locked.claim_token !== x.claimToken || locked.status !== 'RUNNING' || Date.now() >= row.deadline_at.getTime())
      throw Error('R3_ORIGINAL_NATIVE_ATTEMPT_ADMISSION_FENCED');
    const reservation = (await c.query("SELECT envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2 AND status<>'RELEASED' AND revocation_reason IS NULL FOR SHARE",
      [row.tenant_id, row.binding.grant.reservationRef.id])).rows[0];
    if (!reservation || r3Digest(reservation.envelopes.find((e: { resourceId: string }) => e.resourceId === row.binding.grant.resourceId)) !== r3Digest(row.binding.grant.envelope))
      throw Error('R3_ORIGINAL_COMPUTE_GRANT_CHANGED');
    await c.query('INSERT INTO finnor_os.p2_grant_usage(tenant_id,principal_id,grant_digest,resource_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [row.tenant_id, row.principal_id, row.binding.grant.ref.contentDigest, row.binding.grant.resourceId]);
    const debit = await c.query('UPDATE finnor_os.p2_grant_usage SET spent=spent+1 WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3 AND resource_id=$4 AND spent+1<=$5 RETURNING spent',
      [row.tenant_id, row.principal_id, row.binding.grant.ref.contentDigest, row.binding.grant.resourceId, row.binding.grant.capacity]);
    if (!debit.rowCount) throw Error('R3_SHARED_ORIGINAL_S5_NATIVE_GRANT_EXHAUSTED');
    const episode = await c.query('UPDATE finnor_os.r3_requests SET attempts_used=attempts_used+1 WHERE tenant_id=$1 AND id=$2 AND attempts_used<$3 AND deadline_at>clock_timestamp() RETURNING attempts_used',
      [row.tenant_id, row.id, row.request.limits.maxAttempts]);
    if (!episode.rowCount) throw Error('R3_ORIGINAL_EPISODE_ATTEMPTS_OR_DEADLINE_EXHAUSTED');
    const id = randomUUID(), body = { phase, jobId: x.jobId, deliveryAttemptId: x.deliveryAttemptId, claimFence: x.claimFence,
      originalEpisode: row.id, originalDeadlineAt: row.deadline_at.toISOString(), originalGrant: row.request.budget_grant_ref,
      grantResourceId: row.binding.grant.resourceId, chargedInvocations: 1, inputDigest: r3Digest(row.problem),
      runtimeDigest: row.binding.runtimeDigest, costs: { usd: null, basis: 'UNMETERED_FAILED_AND_UNKNOWN_RETAINED' } };
    await c.query("INSERT INTO finnor_os.r3_attempts(id,tenant_id,principal_id,request_id,delivery_id,phase,status,claim_fence,body,digest) VALUES($1,$2,$3,$4,$5,$6,'INTENT',$7,$8::jsonb,$9)",
      [id, row.tenant_id, row.principal_id, row.id, x.deliveryAttemptId, phase, x.claimFence, JSON.stringify(body), r3Digest(body)]);
    await r3Event(ctx, locked, 'NATIVE_ATTEMPT_CHARGED', { attemptId: id, ...body, priorChargesRetained: true }, c);
    return { id, body };
  });
}
async function record(ctx: PeMutationContext, row: R3RequestRow, id: string, status: string, delta: unknown) {
  return tx(ctx, async c => {
    const original = (await c.query('SELECT body,status FROM finnor_os.r3_attempts WHERE tenant_id=$1 AND request_id=$2 AND id=$3 FOR UPDATE', [row.tenant_id, row.id, id])).rows[0];
    if (!original) throw Error('R3_DURABLE_NATIVE_ATTEMPT_REQUIRED');
    const body = { ...original.body, ...(delta as Record<string, unknown>) };
    await c.query('UPDATE finnor_os.r3_attempts SET status=$4,body=$5::jsonb,digest=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND request_id=$2 AND id=$3',
      [row.tenant_id, row.id, id, status, JSON.stringify(body), r3Digest(body)]);
    await r3Event(ctx, row, 'NATIVE_ATTEMPT_' + status, { attemptId: id, previousStatus: original.status,
      receipt: body.receipt ?? null, outputDigest: body.output ? r3Digest(body.output) : null, predicate: body.predicate ?? null }, c);
  });
}
async function recover(ctx: PeMutationContext, row: R3RequestRow, x: Readonly<JobExecutionContext>) {
  return tx(ctx, async c => {
    const attempts = (await c.query("SELECT * FROM finnor_os.r3_attempts WHERE tenant_id=$1 AND request_id=$2 AND phase IN('PRODUCER','CHECKER') ORDER BY created_at LIMIT 33", [row.tenant_id, row.id])).rows;
    if (attempts.length > 32) throw Error('R3_ORIGINAL_NATIVE_ATTEMPT_HISTORY_BOUND');
    for (const a of attempts) {
      if (r3Digest(a.body) !== a.digest || a.body.inputDigest !== r3Digest(row.problem)||a.body.runtimeDigest!==row.binding.runtimeDigest)
        throw Error('R3_RECOVERY_NATIVE_ORIGINAL_INPUT_BINDING');
      if (['INTENT', 'SUBMITTED'].includes(a.status) && a.delivery_id !== x.deliveryAttemptId) {
        const body = { ...a.body, recoveryDisposition: 'UNKNOWN_PRIOR_CHILD_RETAINED_NO_EFFECT_REPLAY', costsRetained: true };
        await c.query("UPDATE finnor_os.r3_attempts SET status='UNKNOWN',body=$3::jsonb,digest=$4 WHERE tenant_id=$1 AND id=$2",
          [row.tenant_id, a.id, JSON.stringify(body), r3Digest(body)]);
        await r3Event(ctx, row, 'PHYSICAL_RECOVERY_UNKNOWN_RETAINED', { attemptId: a.id, originalDeadlineAt: row.deadline_at.toISOString() }, c);
      }
    }
    const producer = attempts.filter(a => a.phase === 'PRODUCER' && a.status === 'RETURNED').at(-1);
    const checker = attempts.filter(a => a.phase === 'CHECKER' && a.status === 'ACCEPTED').at(-1);
    if (producer && checker && checker.body.output?.accepted===true&&checker.body.output?.inputDigest===r3Digest(row.problem)&&
      checker.body.output?.checker?.sourceDigest===row.problem.binding.checkerDigest&&
      checker.body.output?.ruleDigest === r3Digest(producer.body.output?.rule)&&
      [producer,checker].every(a=>a.body.receipt?.runtimeDigest===row.binding.runtimeDigest&&a.body.receipt?.exitCode===0&&a.body.receipt?.termination==='EXITED')) {
      await r3Event(ctx, row, 'RECOVER_ACCEPTED_NATIVE_CHILDREN', { producerAttempt: producer.id, checkerAttempt: checker.id,
        noNewNativeInvocation: true, originalChargesAndDeadlineRetained: true }, c);
      return { rule: producer.body.output.rule as ElicitationRule, check: checker.body.output as ElicitationCheck,
        receipts: [producer.body.receipt, checker.body.receipt] as R3ChildReceipt[] };
    }
    return null;
  });
}
export async function runIncentiveRuleSynthesisJob(payload: Record<string, unknown>, x?: Readonly<JobExecutionContext>) {
  if (!x || x.protocolVersion !== 1 || x.tenantId !== payload.tenantId || typeof payload.requestId !== 'string') throw Error('R3_REAL_VERSIONED_DURABLE_JOB_CONTEXT_REQUIRED');
  if (process.env.NODE_ENV === 'production' || process.env.FINNOR_R3_PROFILE !== 'ordinary_disposable') throw Error('R3_PROTECTED_RUNTIME_FUNDING_AND_ADMISSION_UNAVAILABLE');
  const ctx = context(payload), initial = await r3Request(ctx, payload.requestId);
  if (payload.generation !== initial.generation || !['QUEUED', 'RUNNING'].includes(initial.status)) return;
  const absolute = initial.deadline_at.getTime(), monotone = performance.now() + Math.max(0, absolute - Date.now());
  if (Date.now() >= absolute) {
    await tx(ctx, async c => { await c.query("UPDATE finnor_os.r3_requests SET status='UNKNOWN',failure='R3_ORIGINAL_DEADLINE_EXHAUSTED' WHERE tenant_id=$1 AND id=$2 AND generation=$3", [initial.tenant_id, initial.id, initial.generation]) });
    return;
  }
  return withDatabaseExecutionDeadline(monotone, async () => {
    let row = await claim(ctx, initial, x), leases: ComputeResourceLease[] = [], activeAttempt: string | null = null;
    const controller = new AbortController(); let watch: ReturnType<typeof setInterval> | undefined, polling = false;
    try {
      await assertR3Current(ctx, row);
      leases = await acquireComputeResourceLeases({ resourceKeys: ['native:r3'], requiredResourceKeys: ['native:r3'],
        tenantId: row.tenant_id, workloadClass: 'INTERACTIVE', ownerId: 'r3:' + x.deliveryAttemptId });
      x.registerHeartbeat(() => withDatabaseExecutionDeadline(monotone, () => renewComputeResourceLeases(leases)));
      watch = setInterval(() => {
        if (polling) return; polling = true;
        void withDatabaseExecutionDeadline(monotone, async () => {
          const current = await r3Request(ctx, row.id);
          if (current.generation !== row.generation || current.status !== 'RUNNING' || current.claim_token !== x.claimToken || Date.now() >= absolute)
            controller.abort(Error('R3_PHYSICAL_CHILD_CURRENTNESS_FENCE'));
        }).catch(() => controller.abort(Error('R3_PHYSICAL_CHILD_OWNER_UNAVAILABLE'))).finally(() => { polling = false });
      }, 1000);
      let accepted = await recover(ctx, row, x);
      if (!accepted) {
        activeAttempt = (await admit(ctx, row, x, 'PRODUCER')).id;
        await record(ctx, row, activeAttempt, 'SUBMITTED', { at: new Date().toISOString() });
        const proposed = await proposeR3Rule(row.problem, absolute, row.request.limits.childSeconds, controller.signal);
        await record(ctx, row, activeAttempt, 'RETURNED', { receipt: proposed.receipt, output: proposed.output });
        activeAttempt = null;
        await assertR3Current(ctx, row);
        if (!proposed.output.rule) {
          activeAttempt = (await admit(ctx, row, x, 'CHECKER')).id;
          await record(ctx, row, activeAttempt, 'SUBMITTED', { operation: 'ORIGINAL_CONTRADICTION_CHECK' });
          const contradiction = await runR3Child<{ status: string; basis: string; inputDigest:string; checker:{sourceDigest:string}; [key: string]: unknown }>('CHECKER', { operation: 'contradiction', problem: row.problem }, absolute, row.request.limits.childSeconds, controller.signal);
          if(contradiction.output.inputDigest!==r3Digest(row.problem)||contradiction.output.checker.sourceDigest!==row.problem.binding.checkerDigest)
            throw Error('R3_ORIGINAL_CONTRADICTION_CHECKER_CUSTODY_REQUIRED');
          await record(ctx, row, activeAttempt, 'RETURNED', { receipt: contradiction.receipt, output: contradiction.output });
          activeAttempt = null;
          await tx(ctx, async c => {
            const locked = await r3Request(ctx, row.id, c, true);
            await r3Event(ctx, locked, 'NO_RULE_ORIGINAL_PROOF_DISPOSITION', contradiction.output, c);
            await c.query('UPDATE finnor_os.r3_requests SET status=$3,failure=$4 WHERE tenant_id=$1 AND id=$2 AND generation=$5',
              [row.tenant_id, row.id, contradiction.output.status === 'INFEASIBLE' ? 'INFEASIBLE' : 'UNKNOWN', contradiction.output.basis, row.generation]);
          }); return;
        }
        activeAttempt = (await admit(ctx, row, x, 'CHECKER')).id;
        await record(ctx, row, activeAttempt, 'SUBMITTED', { at: new Date().toISOString() });
        const checked = await checkR3Rule(row.problem, proposed.output.rule, absolute, row.request.limits.childSeconds, controller.signal);
        await record(ctx, row, activeAttempt, 'ACCEPTED', { receipt: checked.receipt, output: checked.output });
        activeAttempt = null;
        accepted = { rule: proposed.output.rule, check: checked.output, receipts: [proposed.receipt, checked.receipt] };
      }
      await assertR3Current(ctx, row);
      if (Date.now() >= absolute || !await renewComputeResourceLeases(leases)) throw Error('R3_ACCEPTED_CHILD_PUBLICATION_DEADLINE_OR_LEASE_FENCED');
      const runtime = await r3RuntimeIdentity(), checkerRef = r3Ref('S3', 'r3-check', accepted.check, 'independent-fraction-v1');
      const content: Omit<ElicitationProtocol, 'ref'> = { schema: 'finnor.elicitation-protocol.v1',
        envelope: { id: 'elicitation:' + r3Digest([row.id, accepted.rule, accepted.check]), kind: 'ElicitationProtocol', schemaRevision: 1,
          tenantId: row.tenant_id, principalId: row.principal_id, work: { id: row.work_id, revision: row.work_input_id, digest: row.binding.work.inputDigest },
          baseline: { ...R3_BASE, manifestDigest: row.binding.codeDigest }, producer: { codeDigest: row.binding.codeDigest, lockDigest: runtime.digest, admissionRef: null },
          ownerInputs: [row.problem.binding.preferenceRef, row.problem.binding.mandateRef, ...row.binding.resourceRefs,
            ...(row.problem.binding.programTarget ? [row.problem.binding.programTarget.programRef, row.problem.binding.programTarget.policyRef] : [])]
            .map(ref => ({ ref, asOf: row.problem.money.valuationDate, rightsRef: row.problem.binding.rightsRef })),
          domainRef: row.problem.binding.domainRef, grammar: 'r3-elicitation-use-v1', checkBasis: 'MODEL_RELATIVE_EXACT',
          claims: [{ statement: 'Complete original finite individual weak DSIC and ex-post participation under supplied preferences', domainRef: row.problem.binding.domainRef, checkerReceipt: checkerRef }],
          gaps: [{ reason: 'GENERAL_OPTIMIZATION_PROOF_UNKNOWN', affectedClaims: ['OPTIMUM'], status: 'UNKNOWN' },
            { reason: 'S3_BEHAVIORAL_DOMAIN_UNQUALIFIED', affectedClaims: ['PREFERENCE_APPLICABILITY'], status: 'BLOCKED_EXTERNAL' },
            { reason: 'S8_AND_S6_OPERATION_ADMISSION_UNAVAILABLE', affectedClaims: ['ACTIVATION', 'CONSENT', 'SETTLEMENT'], status: 'BLOCKED_EXTERNAL' }],
          budgetGrantRef: row.request.budget_grant_ref, resourceReceipts: accepted.receipts as unknown as Record<string, unknown>[],
          invalidationDependencies: row.binding.dependencies,
          lifecycle: { state: 'development-verified', historyRefs: [], domainQualified: false, s8Admitted: false, active: false } },
        problem: row.problem, rule: accepted.rule, check: accepted.check,
        reporting: { schema: 'r3-authorized-report-v1', corrections: 'BEFORE_CLOSE_ONLY', closing: 'ALL_REPORTS_OR_NO_AGREEMENT', tableFixedBeforeReports: true },
        usePolicyRef: null, reservation: null, proposedSchedulesRef: null,
        agreementEstablished: false, settlementEstablished: false, executionAuthorityGranted: false };
      await tx(ctx, async c => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['s5-portfolio:' + row.tenant_id]);
        const locked = await r3Request(ctx, row.id, c, true);
        await assertR3Current(ctx, locked, c, true);
        const job = (await c.query("SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE", [x.jobId, row.tenant_id, x.claimToken, x.claimFence])).rows[0];
        if (!job || locked.status !== 'RUNNING' || locked.generation !== row.generation || locked.claim_token !== x.claimToken || Date.now() >= absolute)
          throw Error('R3_FINAL_IMMUTABLE_PROTOCOL_PUBLICATION_FENCED');
        await r3PutObject(ctx, locked, 'S3', 'r3-finite-model', 's3-finite-preference-v1', { requestId:row.id, problem: row.problem, behavioralQualification: 'UNQUALIFIED', sourceStandingNotPrivateTruth: true }, c);
        await r3PutObject(ctx, locked, 'S3', 'r3-check', 'independent-fraction-v1', accepted!.check, c);
        const ref = await r3PutObject(ctx, locked, 'S3', 'elicitation-protocol', 'r3-elicitation-protocol-v1', content, c);
        await c.query("UPDATE finnor_os.r3_requests SET status='COMPLETE',protocol_ref=$3::jsonb,claim_token=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id, JSON.stringify(ref)]);
        await r3Event(ctx, locked, 'PROTOCOL_PUBLISHED', { protocolRef: ref, checkerRef, completeFeasibilityNotCertifiedOptimum: true }, c);
      });
    } catch (error) {
      const predicate = error instanceof Error ? error.message : 'R3_WORKER_UNKNOWN_FAILURE';
      if (error instanceof ComputeCapacityUnavailableError) throw error;
      if (activeAttempt) await record(ctx, row, activeAttempt, 'UNKNOWN', { predicate, receipt: (error as { receipt?: unknown }).receipt ?? null, responsibilityAndOriginalDebitRetained: true }).catch(() => undefined);
      await tx(ctx, async c => {
        const locked = await r3Request(ctx, row.id, c, true);
        await r3Event(ctx, locked, 'WORKER_FAILURE_RETAINED', { predicate, childCheck: (error as { check?: unknown }).check ?? null, privateArtifactPublished: false, costsRetained: true }, c);
        if (locked.generation === row.generation && locked.status === 'RUNNING') await c.query("UPDATE finnor_os.r3_requests SET status='UNKNOWN',failure=$3,claim_token=NULL WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id, predicate]);
      }).catch(() => undefined);
      if (predicate.includes('capacity') || predicate.includes('capacity is unavailable')) throw error;
    } finally {
      if (watch) clearInterval(watch); controller.abort();
      if (leases.length) await releaseComputeResourceLeases(leases, 'r3_child_interval_completed').catch(() => undefined);
    }
  });
}

import { randomUUID } from 'node:crypto';
import type { JobExecutionContext } from '../../../../apps/worker/src/queue';
import type { PeMutationContext } from '../types';
import { authorize, codeIdentity, schemaIdentity, sha, stable, tx } from '../evidence-execution/store';
import { safePredicate } from '../program-synthesis/store';
import { loadEnterpriseBeliefView } from '../enterprise-beliefs';
import { induceProcedures } from './induction';
import { inductionRow, appendProcedureEvent, authorizeInduction, assertInductionWork } from './store';

export async function runProcedureInductionJob(payload: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) {
  if (!execution || execution.protocolVersion !== 1 || execution.tenantId !== payload.tenantId ||
    typeof payload.tenantId !== 'string' || typeof payload.principalId !== 'string' ||
    typeof payload.inductionId !== 'string') throw Error('P6_ACTUAL_DURABLE_JOB_CLAIM_REQUIRED');
  const ctx: PeMutationContext = {
    auth: { tenantId: payload.tenantId, userId: payload.principalId, employeeId: payload.principalId, role: 'owner' },
    provenance: { sourceSystem: 'P6:ordinary-structural-worker', createdBy: payload.principalId },
  };
  let row = await inductionRow(ctx, payload.inductionId);
  if (['TESTED', 'FAILED', 'CANCELLED'].includes(row.state) || row.generation !== payload.generation) return;
  const started = performance.now();
  try {
    await authorizeInduction(ctx, row);
    if (row.source_digest !== (await codeIdentity()).digest || row.schema_digest !== await schemaIdentity(ctx))
      throw Error('P6_INDUCTION_RUNTIME_OR_SCHEMA_CHANGED');
    row = await tx(ctx, async c => {
      const current = await inductionRow(ctx, row.id, c, true);
      const claimed = (await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2
        AND type='run_procedure_induction_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4
        AND lease_expires_at>clock_timestamp() FOR SHARE`,
      [row.tenant_id, execution.jobId, execution.claimToken, execution.claimFence])).rows[0];
      if (!claimed || current.generation !== payload.generation || current.state === 'CANCELLED')
        throw Error('P6_INDUCTION_CLAIM_FENCED');
      if (current.deadline_at.getTime() <= Date.now() || current.attempts_used >= 4) throw Error('P6_ORIGINAL_INDUCTION_GRANT_EXHAUSTED');
      await assertInductionWork(ctx, current, c);
      await c.query(`UPDATE finnor_os.p6_inductions SET state='RUNNING',claim_token=$4,claim_fence=$5,attempts_used=attempts_used+1
        WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
      [row.tenant_id, row.principal_id, row.id, execution.claimToken, execution.claimFence]);
      await appendProcedureEvent(ctx, row, 'INDUCTION_ATTEMPT_STARTED', {
        jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId, workerId: execution.workerId,
        fence: execution.claimFence, costUSD: null, sourceReadBytes: Buffer.byteLength(stable(row.cut)),
      }, 'attempt:' + execution.deliveryAttemptId, c);
      return { ...current, state: 'RUNNING', claim_token: execution.claimToken, claim_fence: execution.claimFence };
    });
    await authorize(ctx, row.request.root, [{ type: 'work', id: row.work_id }]);
    const { rights } = await loadEnterpriseBeliefView(ctx, {
      root: row.request.root, knowledgeAt: row.request.knowledgeCut, maxClaims: 1,
    });
    const induced = induceProcedures(row.cut, row.source_digest, randomUUID, {
      work: { id: row.work_id, revision: row.work_input_id, inputDigest: row.work_input_digest }, rights,
    });
    await authorizeInduction(ctx, row);
    if (Date.now() >= row.deadline_at.getTime()) throw Error('P6_ORIGINAL_INDUCTION_DEADLINE_EXHAUSTED');
    await tx(ctx, async c => {
      const current = await inductionRow(ctx, row.id, c, true);
      const claim = (await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2
        AND type='run_procedure_induction_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4
        AND lease_expires_at>clock_timestamp() FOR SHARE`,
      [row.tenant_id, execution.jobId, execution.claimToken, execution.claimFence])).rows[0];
      if (!claim || current.state !== 'RUNNING' || current.generation !== row.generation ||
        current.claim_token !== execution.claimToken || current.claim_fence !== execution.claimFence)
        throw Error('P6_CAPSULE_PUBLICATION_FENCED');
      await assertInductionWork(ctx, row, c);
      if (current.deadline_at.getTime() <= Date.now())
        throw Error('P6_ORIGINAL_INDUCTION_DEADLINE_EXHAUSTED');
      for (const capsule of induced.capsules) await c.query(`INSERT INTO finnor_os.p6_capsules
        (id,tenant_id,principal_id,induction_id,body,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      [capsule.id, row.tenant_id, row.principal_id, row.id, stable(capsule), sha(capsule)]);
      await appendProcedureEvent(ctx, row, 'INDUCTION_RESULT_AND_COST', {
        status: induced.status, capsules: induced.capsules.map(capsule => ({ id: capsule.id, digest: sha(capsule) })),
        rejected: induced.rejected, allSourceRecordsRetained: induced.allSourceRecordsRetained,
        wallMs: performance.now() - started, dollars: null, sourceClass: row.cut.qualification,
        admission: null, independentTransferEstablished: false, codeDigest: row.source_digest,
      }, 'result:' + execution.deliveryAttemptId, c);
      const finalized = await c.query(`UPDATE finnor_os.p6_inductions SET state=$4,capsule_ids=$5,reason=$6
        WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND state='RUNNING'
          AND generation=$7 AND claim_token=$8 AND claim_fence=$9 AND deadline_at>clock_timestamp()
          AND EXISTS(SELECT 1 FROM finnor_os.jobs WHERE id=$10 AND tenant_id=$1
            AND status='running' AND claim_token=$8 AND claim_fence=$9 AND lease_expires_at>clock_timestamp())
        RETURNING id`,
      [row.tenant_id, row.principal_id, row.id, induced.capsules.length ? 'TESTED' : 'FAILED',
        induced.capsules.map(capsule => capsule.id), induced.capsules.length ? null : 'NO_SUPPORTED_ABSTRACTION',
        row.generation, execution.claimToken, execution.claimFence, execution.jobId]);
      if (finalized.rowCount !== 1) throw Error('P6_ORIGINAL_DEADLINE_OR_CLAIM_FENCED_AFTER_PUBLICATION_WAIT');
    });
  } catch (error) {
    await tx(ctx, async c => {
      const current = await inductionRow(ctx, row.id, c, true);
      await appendProcedureEvent(ctx, row, 'FAILED_OR_FENCED', {
        predicate: safePredicate(error), elapsedMs: performance.now() - started, dollars: null,
        jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId,
      }, 'failure:' + execution.deliveryAttemptId, c);
      if (current.generation === row.generation && !['TESTED', 'CANCELLED'].includes(current.state))
        await c.query(`UPDATE finnor_os.p6_inductions SET state='FAILED',reason=$4
          WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
        [row.tenant_id, row.principal_id, row.id, safePredicate(error)]);
    });
  }
}

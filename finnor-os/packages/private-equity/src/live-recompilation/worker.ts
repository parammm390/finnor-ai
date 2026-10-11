import { randomUUID } from 'node:crypto';
import { ingestIntegrationEventTx } from '@finnor/db';
import type { JobExecutionContext } from '../../../../apps/worker/src/queue';
import type { PeMutationContext } from '../types';
import { submitHarnessProgram } from '../program-synthesis/api';
import { assertProgramCurrent, readCurrentProgram, requestRow } from '../program-synthesis/store';
import { assertDependencies, codeIdentity, schemaIdentity, sha, stable, tx } from '../evidence-execution/store';
import { continuationRow, priorHead, assertContinuationCut, appendContinuation, enqueueContinuation } from './api';
import { P7_VERSION, ref, type ContinuationPatch } from './contracts';

export async function runProgrammeContinuationJob(payload: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) {
  if(payload.schema==='finnor.r1.p7-invalidation.v1')return (await import('../r1/dependencies')).runR1DependencyContinuation(payload,execution);
  if (!execution || execution.protocolVersion !== 1 || execution.retrySafety !== 'locally_idempotent' ||
    typeof payload.tenantId !== 'string' || execution.tenantId !== payload.tenantId ||
    typeof payload.principalId !== 'string' || typeof payload.continuationId !== 'string')
    throw Error('P7_ACTUAL_CANONICAL_JOB_CONTEXT_REQUIRED');
  const fence = Number(execution.claimFence);
  if (!Number.isSafeInteger(fence) || fence < 1) throw Error('P7_ACTUAL_CANONICAL_JOB_CONTEXT_REQUIRED');
  const ctx: PeMutationContext = { auth: { tenantId: payload.tenantId, userId: payload.principalId,
    employeeId: payload.principalId, role: 'owner' } };
  const claim = async (c: import('pg').PoolClient) => {
    if (!(await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2
      AND type='run_programme_continuation_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4
      AND protocol_version=1 AND lease_expires_at>clock_timestamp() FOR SHARE`,
    [payload.tenantId, execution.jobId, execution.claimToken, fence])).rows[0])
      throw Error('P7_CANONICAL_JOB_CLAIM_FENCED');
  };
  let row = await continuationRow(ctx, payload.continuationId);
  if (!['ACCEPTED', 'PREPARED'].includes(row.state)) return;
  try {
    const prior = await tx(ctx, async c => {
      await claim(c);
      const q = await assertContinuationCut(ctx, row, c, true);
      const episode = (await c.query('SELECT deadline_at FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
        [row.tenant_id, row.principal_id, row.episode_id])).rows[0];
      if (!episode || episode.deadline_at.getTime() <= Date.now()) throw Error('P7_ORIGINAL_EPISODE_EXHAUSTED');
      return q;
    });
    if (!row.next_request_id) {
      // P1's own idempotent request/episode/plan/queue transaction owns compilation.
      // Cold adoption repeats this exact handoff identity, not the external effect.
      const next = await submitHarnessProgram(ctx, { ...prior.request, workId: prior.work_id,
        workInputId: row.event_body.workInputId, parentProgramId: prior.id,
        knowledgeAt: undefined, idempotencyKey: 'p7:' + row.id });
      await tx(ctx, async c => {
        await claim(c); await assertContinuationCut(ctx, row, c, true);
        const locked = await continuationRow(ctx, row.id, c, true);
        if (!['ACCEPTED', 'PREPARED'].includes(locked.state) ||
          locked.next_request_id && locked.next_request_id !== next.programId) throw Error('P7_PRODUCER_HANDOFF_FENCED');
        await c.query("UPDATE finnor_os.p7_continuations SET next_request_id=$4,state='PREPARED' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
          [row.tenant_id, row.principal_id, row.id, next.programId]);
        await appendContinuation(ctx, row, 'AUTHENTIC_P1_REGION_QUEUED', {
          nextProgramId: next.programId, originalEpisodeId: row.episode_id, idempotentHandoff: true,
          effectDispatched: false, responsibilityReleased: false,
        }, c);
      });
      row = await continuationRow(ctx, row.id);
    }
    const next = await readCurrentProgram(ctx, row.next_request_id!);
    if (!['TESTED', 'FAILED', 'INVALIDATED', 'PARTIAL', 'CANCELLED'].includes(next.status)) {
      await tx(ctx, async c => {
        await claim(c);
        const locked = await continuationRow(ctx, row.id, c, true);
        if (locked.state !== 'PREPARED') return;
        if (locked.polls >= 60) throw Error('P7_BOUNDED_PRODUCER_WAIT_EXHAUSTED');
        await c.query('UPDATE finnor_os.p7_continuations SET polls=polls+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
          [row.tenant_id, row.principal_id, row.id]);
        await enqueueContinuation(ctx, row, 'producer:' + (locked.polls + 1), c, 250);
      });
      return;
    }
    if (next.status !== 'TESTED' || !next.program?.result) throw Error('P7_AUTHENTIC_CURRENT_COMPLETED_PRODUCER_REQUIRED');
    const program = next.program, nextRow = await requestRow(ctx, row.next_request_id!);
    const old = await priorHead(ctx, prior), source = await codeIdentity(), schemaDigest = await schemaIdentity(ctx);
    if (program.bounds.episodeId !== row.episode_id || program.acceptanceDigest !== old.body.acceptanceDigest ||
      program.validAt !== old.body.validAt || !program.parents.includes(prior.id))
      throw Error('P7_ORIGINAL_OBJECTIVE_CLOCK_OR_GRANT_CHANGED');
    await tx(ctx, async (c, db) => {
      await claim(c); await assertContinuationCut(ctx, row, c, true);
      await assertProgramCurrent(ctx, nextRow, c, true);
      await assertDependencies(ctx, program.dependencies, c, true);
      const locked = await continuationRow(ctx, row.id, c, true);
      if (locked.state === 'PUBLISHED') return;
      if (locked.state !== 'PREPARED' || locked.next_request_id !== nextRow.id) throw Error('P7_COHERENT_PUBLICATION_FENCED');
      const storedNext = await priorHead(ctx, nextRow, c);
      if (sha(storedNext.body) !== sha(program)) throw Error('P7_NEXT_PROGRAMME_HEAD_CHANGED');
      const manifestId = randomUUID();
      const manifest = { schema: 'finnor.p7.coherent-work-manifest.v1', work: program.work,
        priorProgram: ref('P1', 'p1-head:' + old.id, old.body),
        nextProgram: ref('P1', 'p1-head:' + storedNext.id, program),
        consistencyVector: { dependencies: row.event_body.checkedDependencies,
          workInputId: row.event_body.workInputId, workInputDigest: row.event_body.workInputDigest },
        artifact: program.result!.artifact, resultDigest: program.result!.digest,
        outstandingResponsibility: 'NO_EFFECT_AUTHORITY_IN_SUPPORTED_ANALYTICAL_DOMAIN',
        costs: program.costs, domain: P7_VERSION, publishedAt: new Date().toISOString() };
      const node = (id: string) => {
        const value = old.body.graph.find(n => n.id === id);
        if (!value) throw Error('P7_CLOSURE_MEMBER_CORRUPT');
        return ref('P1', 'p1-node:' + old.id + ':' + id, value);
      };
      const patch: ContinuationPatch = {
        schema: 'finnor.continuation-patch.v1', tenantId: row.tenant_id, principalId: row.principal_id,
        sharing: program.sharing, rights: program.rights,
        work: { id: program.work.id, revision: program.work.revision, inputDigest: program.work.inputDigest },
        mandate: null, parents: [old.id], inputsDigest: row.event_digest,
        validAt: program.validAt, knowledgeAt: program.knowledgeAt,
        code: { version: P7_VERSION, digest: source.digest, schemaDigest },
        capability: { kind: 'NATIVE_ANALYTICAL_CONTINUATION', admission: null },
        runtime: { node: process.version, imageDigest: null, fabricInvocationId: null,
          workerId: execution.workerId, jobId: execution.jobId, deliveryAttemptId: execution.deliveryAttemptId,
          claimFence: fence, childPid: null, leases: [] },
        domain: { entityScope: [prior.request.root.entityId], interface: P7_VERSION, horizon: 'H0', businessTruthCertified: false },
        dependencyRefs: program.dependencies.map(d => d.key + ':' + d.revision),
        costs: { wallMs: program.costs.wallMs, cpuMicros: null, peakRSSBytes: null, inputBytes: Buffer.byteLength(stable(row.event_body)),
          outputBytes: Buffer.byteLength(stable(manifest)), modelCalls: 0, usd: null, status: 'LOCAL_COST_UNMETERED',
          attempts: program.costs.attempts, nativeInvocations: program.costs.nativeInvocations, unreconciledAttemptIds: [] },
        status: 'TESTED', admission: null, funding: null,
        unavailableBindings: ['FULL_S2_S3_S4_S5_S6_CONTINUATION', 'A_B_COMPLETION_GENERATIONS', 'P5_DRIFT_JOIN',
          'S8_INDEPENDENT_CONTINUATION_ADMISSION', 'MOUNTED_PRODUCT_FLOW', 'SEALED_GATE_P7', 'RECONCILED_COSTS'],
        priorProgram: manifest.priorProgram, nextProgram: manifest.nextProgram,
        trigger: ref('P7', 'p7-source-event:' + row.event_digest, row.event_body),
        affectedNodes: row.affected_nodes.map(node), keptNodes: row.kept_nodes.map(node),
        consistencyVector: manifest.consistencyVector, obligationChanges: [], reservationChanges: [],
        publication: ref('P7', 'p7-work-manifest:' + manifestId, manifest),
        supportedState: 'PUBLISHED_ORDINARY_ANALYTICAL',
      };
      await c.query('INSERT INTO finnor_os.p7_manifests(id,tenant_id,principal_id,work_id,continuation_id,body,digest,patch) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)',
        [manifestId, row.tenant_id, row.principal_id, row.work_id, row.id, stable(manifest), sha(manifest), stable(patch)]);
      await c.query("UPDATE finnor_os.p7_continuations SET state='PUBLISHED',reason=NULL WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
        [row.tenant_id, row.principal_id, row.id]);
      await ingestIntegrationEventTx(db, { tenantId: row.tenant_id, source: 'P7_NATIVE_CONTINUATION_V1',
        sourceEventId: row.id, eventType: 'programme.manifest.published', workId: row.work_id,
        resource: { type: 'work', id: row.work_id }, correlationId: row.id, trustClass: 'trusted_runtime',
        payload: { manifest: patch.publication, continuationId: row.id, domain: P7_VERSION, effectAuthorityGranted: false } });
      await appendContinuation(ctx, row, 'COHERENT_NATIVE_MANIFEST_PUBLISHED', {
        manifestRef: patch.publication, notificationOwner: 'CANONICAL_EVENT_FABRIC',
        externalAtomicityClaimed: false, originalEpisodeRetained: true }, c);
    });
  } catch (error) {
    const reason = String((error as Error).message).match(/^P7_[A-Z0-9_]+$/)?.[0] ?? 'P7_OWNER_OR_PRODUCER_UNAVAILABLE';
    await tx(ctx, async c => {
      await claim(c);
      const locked = await continuationRow(ctx, row.id, c, true);
      if (!['ACCEPTED', 'PREPARED'].includes(locked.state)) return;
      await c.query('UPDATE finnor_os.p7_continuations SET state=$4,reason=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
        [row.tenant_id, row.principal_id, row.id, reason.includes('SUPERSEDED') || reason.includes('FENCED') ? 'SUPERSEDED' : 'FAILED', reason]);
      await appendContinuation(ctx, row, 'PUBLICATION_REFUSED', {
        reason, ownerPredicate: String((error as Error).message).match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0] ?? 'NON_PUBLIC_OWNER_ERROR',
        ownerErrorCode: String((error as any).code ?? (error as any).cause?.code ?? '').match(/^[A-Z0-9_]{1,64}$/)?.[0] ?? null,
        databaseGuard: String((error as any).where ?? (error as any).cause?.where ?? '')
          .match(/function ([A-Za-z0-9_.]+)\(/)?.[1] ?? null,
        nextProgramId: locked.next_request_id, costsRetained: true, resourceReleased: false,
        effectDispatched: false }, c);
    });
  }
}

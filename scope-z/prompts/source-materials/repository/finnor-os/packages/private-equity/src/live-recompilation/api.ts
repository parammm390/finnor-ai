import type { PoolClient } from 'pg';
import type { EvidenceDependency } from '@finnor/shared-types';
import type { PeMutationContext } from '../types';
import type { HarnessProgram } from '../program-synthesis/contracts';
import { requestRow, assertProgramCurrent, episodeCosts, type ProgramRow } from '../program-synthesis/store';
import { authorize, codeIdentity, principal, revisions, sameRevisions, sha, stable, tx, unavailable, schemaIdentity } from '../evidence-execution/store';
import { randomUUID } from 'node:crypto';
import {assertProcedureContinuationIntake} from '../procedure-induction/continuation';
import { receiveWork } from '@finnor/db';
import { P7_VERSION, SubmitSchema, ReadSchema, ProjectionSchema, affectedClosure, ref, type ContinuationPatch } from './contracts';
import { z } from 'zod';

export const CONTINUATION_OPERATIONS = ['continuation-submit','continuation-read','continuation-projection'] as const;
export const CONTINUATION_OPERATION_SCHEMAS = {
  'continuation-submit': SubmitSchema, 'continuation-read': ReadSchema, 'continuation-projection': ProjectionSchema,
};

export interface ContinuationRow {
  id: string; tenant_id: string; principal_id: string; work_id: string;
  prior_request_id: string; prior_head_id: string; episode_id: string;
  event_body: { schema: string; priorDependencies: EvidenceDependency[]; checkedDependencies: EvidenceDependency[];
    workInputId: string; workInputDigest: string; observedAt: string; changedKeys: string[] };
  event_digest: string; source_digest: string; affected_nodes: string[]; kept_nodes: string[];
  state: 'ACCEPTED' | 'PREPARED' | 'PUBLISHED' | 'SUPERSEDED' | 'FAILED';
  next_request_id: string | null; polls: number; reason: string | null;
}
export async function continuationRow(ctx: PeMutationContext, id: string, client?: PoolClient, lock = false): Promise<ContinuationRow> {
  const read = async (c: PoolClient) => {
    const row = (await c.query<ContinuationRow>(
      'SELECT * FROM finnor_os.p7_continuations WHERE tenant_id=$1 AND principal_id=$2 AND id=$3' + (lock ? ' FOR UPDATE' : ''),
      [ctx.auth.tenantId, principal(ctx), id])).rows[0];
    if (!row) throw unavailable();
    if (sha(row.event_body) !== row.event_digest) throw Error('P7_DURABLE_EVENT_PREIMAGE_CORRUPT');
    return row;
  };
  return client ? read(client) : tx(ctx, read, true);
}
export async function priorHead(ctx: PeMutationContext, q: ProgramRow, c?: PoolClient) {
  const read = async (client: PoolClient) => {
    const row = (await client.query<{ id: string; body: HarnessProgram; digest: string }>(
      'SELECT id,body,digest FROM finnor_os.p1_programs WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND request_id=$4',
      [q.tenant_id, q.principal_id, q.head_id, q.id])).rows[0];
    if (!row) throw Error('P7_ISSUED_IMMUTABLE_PRIOR_HEAD_REQUIRED');
    if (sha(row.body) !== row.digest || row.body.id !== q.id || row.body.work.id !== q.work_id ||
      row.body.principalId !== principal(ctx) || row.body.tenantId !== ctx.auth.tenantId)
      throw Error('P7_PRIOR_PROGRAMME_PREIMAGE_INVALID');
    return row;
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function authorizeProgramme(ctx: PeMutationContext, q: ProgramRow) {
  await authorize(ctx, q.request.root, [{ type: 'work', id: q.work_id }]);
  for (const source of q.request.sources) if (source.source.kind !== 'derivation')
    await authorize(ctx, source.source.subject, source.source.kind === 'artifact'
      ? [{ type: 'document', id: source.source.documentId }] : []);
}
export async function appendContinuation(ctx: PeMutationContext, row: ContinuationRow, kind: string, body: unknown, c: PoolClient) {
  await c.query('INSERT INTO finnor_os.p7_events(tenant_id,principal_id,continuation_id,kind,body) VALUES($1,$2,$3,$4,$5::jsonb)',
    [row.tenant_id, principal(ctx), row.id, kind, stable(body)]);
}
export async function enqueueContinuation(ctx: PeMutationContext, row: ContinuationRow, stage: string, c: PoolClient, delay = 0) {
  await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety,run_at)
    VALUES($1,'run_programme_continuation_v1',$2::jsonb,$3,'interactive',1,'locally_idempotent',clock_timestamp()+$4::int*interval '1 millisecond')
    ON CONFLICT(idempotency_key) DO NOTHING`,
  [row.tenant_id, stable({ tenantId: row.tenant_id, principalId: principal(ctx), continuationId: row.id }),
    'p7:' + row.id + ':' + stage, delay]);
}
export async function assertContinuationCut(ctx: PeMutationContext, row: ContinuationRow, c: PoolClient, lock = false) {
  const q = await requestRow(ctx, row.prior_request_id, c);
  await authorizeProgramme(ctx, q);
  if (row.source_digest !== (await codeIdentity()).digest) throw Error('P7_RUNTIME_SOURCE_CHANGED');
  if (lock) await c.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE', [row.tenant_id, row.work_id]);
  const input = (await c.query<{ id: string; body: unknown }>(
    'SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
    [row.tenant_id, row.work_id])).rows[0];
  if (input?.id !== row.event_body.workInputId || sha(input.body) !== row.event_body.workInputDigest ||
    !sameRevisions(row.event_body.checkedDependencies,
      await revisions(ctx, row.event_body.checkedDependencies.map(d => d.key), c, lock)))
    throw Error('P7_ACCEPTED_OWNER_CUT_SUPERSEDED');
  return q;
}
export async function submitContinuation(ctx: PeMutationContext, body: unknown) {
  const input = SubmitSchema.parse(body);
  const q = await requestRow(ctx, input.priorProgramId);
  await authorizeProgramme(ctx, q);
  if (q.request.mode !== 'ordinary_disposable' || process.env.NODE_ENV === 'production' ||
    process.env.FINNOR_P4_PROFILE !== 'ordinary_disposable') throw Error('P7_ORDINARY_ANALYTICAL_PROFILE_REQUIRED');
  // No mutation or liability is reclassified by the currently supported port.
  if (q.request.operations?.length || q.request.ownerBindings || q.request.computeSearch)
    throw Error('P7_CONSEQUENTIAL_OR_ADAPTIVE_OWNER_CONTINUATION_PORT_REQUIRED');
  const head = await priorHead(ctx, q);
  if (head.body.status !== 'TESTED' || !head.body.result || !head.body.dependencies.length)
    throw Error('P7_CHECKED_SOURCE_BOUND_ANALYTICAL_PRIOR_REQUIRED');
  const source = await codeIdentity();
  // Native Work/Objective requires a genuine new intake, including for a source
  // correction. Preserve the original instruction and original Work episode.
  // Ignore only this handoff's Work-input counter when deduplicating the SOURCE
  // event; never ignore an owner/source/rights revision.
  const sourceDependencies = head.body.dependencies.filter(d => d.key !== 'work-inputs:' + q.work_id);
  const observed = await revisions(ctx, sourceDependencies.map(d => d.key));
  const eventKey = sha({ priorHead: head.id, sourceDependencies: observed });
  const replay = await tx(ctx, async c => (await c.query<ContinuationRow>(
    'SELECT * FROM finnor_os.p7_continuations WHERE tenant_id=$1 AND principal_id=$2 AND event_key=$3',
    [q.tenant_id, q.principal_id, eventKey])).rows[0], true);
  if (replay) return { continuationId: replay.id, state: replay.state, replayed: true, domain: P7_VERSION };
  if (sameRevisions(sourceDependencies, observed)) throw Error('P7_AUTHENTIC_CHANGED_DEPENDENCY_REQUIRED');
  // Commit the exact authorized handoff BEFORE native intake. Recovery may adopt
  // only this intent's real idempotent input, never any arbitrary newer input.
  const intentBody = { priorRequestId: q.id, priorHeadId: head.id, workId: q.work_id,
    principalId: q.principal_id, originalInputId: q.work_input_id, originalInputDigest: q.work_input_digest,
    generation: q.generation, sourceDigest: source.digest, schemaDigest: q.proposed.producer.schemaDigest,
    sourceDependencies: observed, eventKey, instructionDigest: sha(q.request.instruction) };
  await tx(ctx, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7002))', [q.tenant_id + ':' + q.principal_id + ':' + q.work_id]);
    const fresh = await requestRow(ctx, q.id, c, true);
    if (fresh.generation !== q.generation || fresh.head_id !== head.id || fresh.status === 'CANCELLED')
      throw Error('P7_PRIOR_GENERATION_SUPERSEDED');
    const intent = (await c.query<{ body: unknown; digest: string }>(
      'SELECT body,digest FROM finnor_os.p7_intake_intents WHERE tenant_id=$1 AND principal_id=$2 AND event_key=$3',
      [q.tenant_id, q.principal_id, eventKey])).rows[0];
    if (intent && (sha(intent.body) !== intent.digest || intent.digest !== sha(intentBody)))
      throw Error('P7_INTAKE_INTENT_PREIMAGE_MISMATCH');
    try { await assertProcedureContinuationIntake(ctx, q, c, true); }
    catch (error) {
      if (!intent || (error as Error).message !== 'EXACT_WORK_REVISION_CHANGED') throw error;
      const canonical = (await c.query<{ id: string }>(`SELECT i.id FROM finnor_os.work_inputs i
        WHERE i.tenant_id=$1 AND i.work_id=$2 AND i.created_by=$3 AND i.idempotency_key=$4
          AND i.instruction_text=$5
          AND i.id=(SELECT id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1)
          AND EXISTS(SELECT 1 FROM finnor_os.work_events e WHERE e.tenant_id=$1 AND e.work_id=$2
            AND e.event_type IN('input_received','recovery_input_received') AND e.payload->>'workInputId'=i.id::text)
          AND EXISTS(SELECT 1 FROM finnor_os.work_plan_revisions p WHERE p.tenant_id=$1 AND p.id=$6
            AND p.work_input_id=$7 AND p.status IN('active','completed'))`,
        [q.tenant_id, q.work_id, q.principal_id, 'p7-source:' + eventKey, q.request.instruction,
          q.plan_revision_id, q.work_input_id])).rows[0];
      if (!canonical || q.proposed.producer.codeDigest !== source.digest ||
        q.proposed.producer.schemaDigest !== await schemaIdentity(ctx))
        throw Error('P7_EXACT_DURABLE_NATIVE_INTAKE_ADOPTION_REQUIRED');
    }
    if (!sameRevisions(observed, await revisions(ctx, sourceDependencies.map(d => d.key), c, true)))
      throw Error('P7_SOURCE_CHANGED_BEFORE_NATIVE_INTAKE');
    const episode = (await c.query('SELECT id FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND deadline_at>clock_timestamp() FOR SHARE',
      [q.tenant_id, q.principal_id, q.episode_id])).rows[0];
    if (!episode) throw Error('P7_ORIGINAL_EPISODE_EXHAUSTED');
    await c.query(`INSERT INTO finnor_os.p7_intake_intents(tenant_id,principal_id,work_id,prior_request_id,event_key,body,digest)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING`,
      [q.tenant_id, q.principal_id, q.work_id, q.id, eventKey, stable(intentBody), sha(intentBody)]);
  });
  const intake = await receiveWork({ tenantId: q.tenant_id, userId: q.principal_id, workId: q.work_id,
    instruction: q.request.instruction, channel: 'console', idempotencyKey: 'p7-source:' + eventKey,
    activeContext: { entityType: q.request.root.entityType, entityId: q.request.root.entityId },
    authorityContext: { principalId: q.principal_id, producer: 'P7_SOURCE_CONTINUATION_NO_NEW_MANDATE',
      priorProgramId: q.id, sourceCutDigest: eventKey } });
  return tx(ctx, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7001))', [q.tenant_id + ':' + q.principal_id + ':' + q.work_id]);
    await c.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE', [q.tenant_id, q.work_id]);
    const dependencies = await revisions(ctx, head.body.dependencies.map(d => d.key), c, true);
    if (!sameRevisions(observed, dependencies)) throw Error('P7_SOURCE_CHANGED_DURING_NATIVE_INTAKE');
    const changedKeys = head.body.dependencies.filter(d => dependencies.find(n => n.key === d.key)?.revision !== d.revision).map(d => d.key);
    if (!changedKeys.length) throw Error('P7_AUTHENTIC_CHANGED_DEPENDENCY_REQUIRED');
    const prior = (await c.query<ContinuationRow>(
      'SELECT * FROM finnor_os.p7_continuations WHERE tenant_id=$1 AND principal_id=$2 AND event_key=$3',
      [q.tenant_id, q.principal_id, eventKey])).rows[0];
    if (prior) return { continuationId: prior.id, state: prior.state, replayed: true, domain: P7_VERSION };
    const originalEpisode = (await c.query('SELECT deadline_at FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 FOR SHARE',
      [q.tenant_id, q.principal_id, q.episode_id])).rows[0];
    if (!originalEpisode || originalEpisode.deadline_at.getTime() <= Date.now()) throw Error('P7_ORIGINAL_EPISODE_EXHAUSTED');
    const latest = (await c.query<{ id: string; body: unknown }>(
      'SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
      [q.tenant_id, q.work_id])).rows[0];
    if (latest?.id !== intake.workInputId) throw Error('P7_WORK_REVISION_CONTINUATION_PORT_REQUIRED');
    // P1 currently has a coarse derivation dependency node. Conservatively affect
    // its entire fan-out; no invented scoped reuse from a broad code digest.
    const seeds = changedKeys.some(k => k === 'rights:tenant' || k.startsWith('work-inputs:'))
      ? head.body.graph.map(n => n.id) : head.body.graph.filter(n => n.op === 'derive').map(n => n.id);
    if (!seeds.length) throw Error('P7_GRAPH_SOURCE_DEPENDENCY_COVERAGE_GAP');
    const closure = affectedClosure(head.body.graph, seeds);
    const eventBody = { schema: 'finnor.p7.observed-source-revision.v1', priorDependencies: head.body.dependencies,
      checkedDependencies: dependencies, workInputId: latest.id, workInputDigest: sha(latest.body),
      observedAt: (await c.query('SELECT clock_timestamp() at')).rows[0].at.toISOString(), changedKeys };
    const id = randomUUID();
    await c.query(`INSERT INTO finnor_os.p7_continuations(id,tenant_id,principal_id,work_id,prior_request_id,prior_head_id,episode_id,
      event_key,event_body,event_digest,source_digest,affected_nodes,kept_nodes) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13)`,
    [id, q.tenant_id, q.principal_id, q.work_id, q.id, head.id, q.episode_id, eventKey, stable(eventBody), sha(eventBody),
      source.digest, closure.affectedNodes.map(n => n.id), closure.keptNodes.map(n => n.id)]);
    // Fence only this analytical producer. Never cancel, release or rewrite S6/S5.
    await c.query("UPDATE finnor_os.p1_requests SET generation=generation+1,status='INVALIDATED',failure='P7_ACCEPTED_SOURCE_REVISION',updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND status<>'CANCELLED'",
      [q.tenant_id, q.principal_id, q.id]);
    const row = await continuationRow(ctx, id, c);
    await appendContinuation(ctx, row, 'REVISION_ACCEPTED_AND_PRIOR_FENCED',
      { trigger: ref('P7', 'p7-source-event:' + sha(eventBody), eventBody),
        affected: row.affected_nodes, kept: row.kept_nodes, conservativeSourceFanOut: true,
        episodeId: q.episode_id, resourceReleased: false, effectDispatched: false }, c);
    await enqueueContinuation(ctx, row, 'accepted', c);
    return { continuationId: id, state: 'ACCEPTED' as const, replayed: false, domain: P7_VERSION };
  });
}
export async function readContinuation(ctx: PeMutationContext, id: string) {
  ReadSchema.parse({ continuationId: id });
  const row = await continuationRow(ctx, id), q = await requestRow(ctx, row.prior_request_id);
  await authorizeProgramme(ctx, q);
  let current = row.state, patch: ContinuationPatch | null = null;
  try {
    await tx(ctx, c => assertContinuationCut(ctx, row, c), true);
    if (row.state === 'PUBLISHED') {
      const next = await requestRow(ctx, row.next_request_id!);
      const read = await (await import('../program-synthesis/store')).readCurrentProgram(ctx, next.id);
      if (read.status !== 'TESTED' || !read.program) throw Error('P7_NEXT_PROGRAMME_NOT_CURRENT');
      patch = await tx(ctx, async c => {
        const manifest = (await c.query<{ body: unknown; digest: string; patch: ContinuationPatch }>(
          'SELECT body,digest,patch FROM finnor_os.p7_manifests WHERE tenant_id=$1 AND principal_id=$2 AND continuation_id=$3',
          [row.tenant_id, row.principal_id, row.id])).rows[0];
        if (!manifest || sha(manifest.body) !== manifest.digest ||
          manifest.patch.publication.contentDigest !== manifest.digest ||
          manifest.patch.nextProgram.contentDigest !== sha(read.program))
          throw Error('P7_COHERENT_MANIFEST_PREIMAGE_INVALID');
        return manifest.patch;
      }, true);
    }
  } catch (error) {
    if ((error as Error).message === 'Evidence resource is unavailable in the authenticated scope') throw error;
    current = 'SUPERSEDED';
  }
  await authorizeProgramme(ctx, q);
  return { schema: 'finnor.p7.continuation-read.v1', continuationId: row.id, workId: row.work_id,
    state: current, recordedState: row.state, nextProgramId: row.next_request_id, patch,
    affectedNodes: row.affected_nodes, keptNodes: row.kept_nodes, reason: row.reason,
    historicalPublicationRetained: row.state === 'PUBLISHED', incurredCosts: await episodeCosts(ctx, q),
    domain: P7_VERSION, effectAuthorityGranted: false, reservationReleased: false };
}

export async function handleContinuationOperation(ctx:PeMutationContext,operation:string,body:unknown):Promise<{status:number;body:unknown}> {
  try {
    if(operation==='continuation-submit')return {status:202,body:await submitContinuation(ctx,body)};
    if(operation==='continuation-read')return {status:200,body:await readContinuation(ctx,ReadSchema.parse(body).continuationId)};
    if(operation==='continuation-projection'){
      const input=ProjectionSchema.parse(body);
      await authorize(ctx,input.root,[{type:'work',id:input.workId}]);
      const rows=await tx(ctx,async c=>(await c.query<{id:string;prior_request_id:string}>(
        'SELECT id,prior_request_id FROM finnor_os.p7_continuations WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY created_at DESC,id DESC LIMIT 20',
        [ctx.auth.tenantId,principal(ctx),input.workId])).rows,true);
      const continuations=[];
      for(const row of rows){
        const prior=await requestRow(ctx,row.prior_request_id);
        if(stable(prior.request.root)===stable(input.root))continuations.push(await readContinuation(ctx,row.id));
      }
      await authorize(ctx,input.root,[{type:'work',id:input.workId}]);
      return {status:200,body:{schema:'finnor.p7.work-projection.v1',workId:input.workId,continuations,
        domain:P7_VERSION,effectAuthorityGranted:false,reservationReleased:false}};
    }
    return {status:404,body:{code:'NOT_FOUND'}};
  } catch(error) {
    if(error instanceof z.ZodError)return {status:400,body:{code:'CONTINUATION_SCHEMA_INVALID'}};
    if((error as Error).message==='Evidence resource is unavailable in the authenticated scope'||(error as {code?:string}).code==='PE_ENTITY_NOT_FOUND')
      return {status:404,body:{code:'PE_ENTITY_NOT_FOUND',error:'Continuation resource is unavailable in the authenticated scope'}};
    const message=(error as Error).message??'';
    const predicate=/^P7_[A-Z_]+$/.test(message)?message:'CONTINUATION_TRANSITION_NOT_CONFIRMED';
    return {status:422,body:{code:'CONTINUATION_PREDICATE_UNPASSED',predicate}};
  }
}

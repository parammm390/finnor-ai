import { z } from 'zod';
import type { PeMutationContext } from '../types';
import { authorize, codeIdentity, principal, sha, stable, tx, newId, schemaIdentity, unavailable } from '../evidence-execution/store';
import { safePredicate } from '../program-synthesis/store';
import { InductionRequestSchema, InductionIdSchema, IdSchema, ProjectionSchema,
  ImmutableRefSchema, CounterexampleSchema, ExperienceRequestSchema, boundedJson } from './contracts';
import { readProcedureExperience } from './experience';
import { appendProcedureEvent, assertInductionWork, authorizeInduction, inductionRow,
  readCapsule, resolveCapsuleComponent } from './store';
import { recordProcedureCounterexample } from './lifecycle';
import { procedureAdmissionRequest } from './admission';
import { loadProcedureInterface, ProcedureInterfaceSchema } from './interface';
import { inductionCostHistory, procedureCostLedger } from './costs';

export const PROCEDURE_OPERATIONS = ['procedure-experience', 'procedure-induce', 'procedure-induction-read',
  'procedure-induction-cancel', 'procedure-read', 'procedure-component', 'procedure-counterexample',
  'procedure-projection', 'procedure-admission-request', 'procedure-interface', 'procedure-costs'] as const;
export const PROCEDURE_OPERATION_SCHEMAS = {
  'procedure-experience': ExperienceRequestSchema, 'procedure-induce': InductionRequestSchema,
  'procedure-induction-read': InductionIdSchema, 'procedure-induction-cancel': InductionIdSchema,
  'procedure-read': IdSchema, 'procedure-component': IdSchema.extend({ ref: ImmutableRefSchema }).strict(),
  'procedure-counterexample': CounterexampleSchema, 'procedure-projection': ProjectionSchema,
  'procedure-admission-request': IdSchema, 'procedure-interface': ProcedureInterfaceSchema, 'procedure-costs': IdSchema,
};

export async function submitProcedureInduction(ctx: PeMutationContext, body: unknown) {
  boundedJson(body, 65536);
  const request = InductionRequestSchema.parse(body);
  if (new Set(request.programIds).size !== request.programIds.length) throw Error('P6_UNIQUE_PROGRAMME_UNIVERSE_REQUIRED');
  await authorize(ctx, request.root, [{ type: 'work', id: request.workId }]);
  const cut = await readProcedureExperience(ctx, {
    programIds: request.programIds, knowledgeCut: request.knowledgeCut, mode: request.mode,
  });
  const code = await codeIdentity(), schema = await schemaIdentity(ctx), digest = sha(request);
  return tx(ctx, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7600))',
      [ctx.auth.tenantId + ':' + principal(ctx) + ':' + request.idempotencyKey]);
    const prior = (await c.query<{ id: string; request_digest: string; state: string }>(
      `SELECT id,request_digest,state FROM finnor_os.p6_inductions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`,
    [ctx.auth.tenantId, principal(ctx), request.idempotencyKey])).rows[0];
    if (prior) {
      if (prior.request_digest !== digest) throw Error('P6_INDUCTION_IDEMPOTENCY_CONFLICT');
      return { inductionId: prior.id, workId: request.workId, state: prior.state, replayed: true };
    }
    await c.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',
      [ctx.auth.tenantId, request.workId]);
    const input = (await c.query<{ id: string; body: unknown }>(
      `SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2
       ORDER BY created_at DESC,id DESC LIMIT 1`, [ctx.auth.tenantId, request.workId])).rows[0];
    const user = (await c.query('SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2',
      [ctx.auth.tenantId, principal(ctx)])).rows[0];
    if (!input || user?.role !== 'owner' || user.status !== 'active') throw unavailable();
    const id = newId();
    await c.query(`INSERT INTO finnor_os.p6_inductions(id,tenant_id,principal_id,work_id,work_input_id,
      work_input_digest,idempotency_key,request,request_digest,cut,cut_digest,source_digest,schema_digest,deadline_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb,$11,$12,$13,clock_timestamp()+interval '30 seconds')`,
    [id, ctx.auth.tenantId, principal(ctx), request.workId, input.id, sha(input.body), request.idempotencyKey,
      stable(request), digest, stable(cut), sha(cut), code.digest, schema]);
    const row = await inductionRow(ctx, id, c);
    await appendProcedureEvent(ctx, row, 'SOURCE_CUT_ACCEPTED', { cutDigest: cut.cutDigest,
      episodes: cut.episodes, sourceClass: cut.qualification, costsUSD: null,
      futureKnowledgeExcluded: cut.futureKnowledgeExcluded, admission: null }, 'source-cut', c);
    await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety)
      VALUES($1,'run_procedure_induction_v1',$2::jsonb,$3,'interactive',1,'locally_idempotent') ON CONFLICT DO NOTHING`,
    [row.tenant_id, stable({ tenantId: row.tenant_id, principalId: principal(ctx), inductionId: id, generation: 1 }), 'p6:' + id + ':1']);
    return { inductionId: id, workId: request.workId, state: 'QUEUED', replayed: false };
  });
}

export async function handleProcedureOperation(ctx: PeMutationContext, operation: string, body: unknown):
Promise<{ status: number; body: unknown }> {
  try {
    boundedJson(body, 65536);
    if (operation === 'procedure-experience') return { status: 200, body: await readProcedureExperience(ctx, body) };
    if (operation === 'procedure-induce') return { status: 202, body: await submitProcedureInduction(ctx, body) };
    if (operation === 'procedure-induction-read' || operation === 'procedure-induction-cancel') {
      const { inductionId } = InductionIdSchema.parse(body), row = await inductionRow(ctx, inductionId);
      await authorizeInduction(ctx, row);
      if (operation === 'procedure-induction-cancel') return { status: 200, body: await tx(ctx, async c => {
        const current = await inductionRow(ctx, row.id, c, true);
        if (['QUEUED', 'RUNNING'].includes(current.state)) {
          await c.query(`UPDATE finnor_os.p6_inductions SET state='CANCELLED',generation=generation+1
            WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`, [row.tenant_id, principal(ctx), row.id]);
          await appendProcedureEvent(ctx, row, 'CANCELLED', { costsRetained: true, actor: principal(ctx) },
            'cancelled', c);
        }
        return { inductionId: row.id, state: ['QUEUED', 'RUNNING'].includes(current.state) ? 'CANCELLED' : current.state };
      }) };
      return { status: 200, body: { inductionId: row.id, state: row.state,
        capsuleIds: row.capsule_ids, reason: row.reason, originalDeadlineAt: row.deadline_at.toISOString(),
        admission: null, sourceClass: row.cut.qualification, costs: await inductionCostHistory(ctx, row.id) } };
    }
    if (operation === 'procedure-counterexample')
      return { status: 200, body: await recordProcedureCounterexample(ctx, body) };
    if (operation === 'procedure-interface') return { status: 200, body: await loadProcedureInterface(ctx, body) };
    if (operation === 'procedure-costs') return { status: 200,
      body: await procedureCostLedger(ctx, IdSchema.parse(body).capsuleId) };
    if (operation === 'procedure-component') {
      const input = IdSchema.extend({ ref: ImmutableRefSchema }).strict().parse(body);
      return { status: 200, body: await resolveCapsuleComponent(ctx, input.capsuleId, input.ref) };
    }
    if (operation === 'procedure-read' || operation === 'procedure-admission-request') {
      const result = await readCapsule(ctx, IdSchema.parse(body).capsuleId);
      return { status: 200, body: operation === 'procedure-read' ? result : procedureAdmissionRequest(result.capsule) };
    }
    if (operation === 'procedure-projection') {
      const input = ProjectionSchema.parse(body);
      await authorize(ctx, input.root, [{ type: 'work', id: input.workId }]);
      const rows = await tx(ctx, async c => (await c.query<{ id: string }>(
        `SELECT p.id FROM finnor_os.p6_capsules p JOIN finnor_os.p6_inductions i ON i.id=p.induction_id AND i.tenant_id=p.tenant_id
         WHERE p.tenant_id=$1 AND p.principal_id=$2 AND i.work_id=$3 ORDER BY p.created_at DESC LIMIT 20`,
      [ctx.auth.tenantId, principal(ctx), input.workId])).rows, true);
      const capsules = [];
      for (const row of rows) capsules.push(await readCapsule(ctx, row.id));
      return { status: 200, body: { schema: 'finnor.p6.work-projection.v1', workId: input.workId, capsules } };
    }
    return { status: 404, body: { code: 'NOT_FOUND' } };
  } catch (error) {
    if (error instanceof z.ZodError) return { status: 400, body: { code: 'P6_SCHEMA_INVALID', predicate: 'BOUNDED_PROCEDURE_REQUEST_REQUIRED' } };
    if ((error as { code?: string }).code === 'PE_ENTITY_NOT_FOUND') return { status: 404,
      body: { code: 'PE_ENTITY_NOT_FOUND', error: 'Procedure resource is unavailable in the authenticated scope' } };
    return { status: 422, body: { code: 'P6_PREDICATE_UNPASSED', predicate: safePredicate(error) } };
  }
}

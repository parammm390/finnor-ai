import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { ElicitationProblem, ElicitationProtocol } from '../../../shared-types/src/elicitation-protocol';
import type { ExperimentRef } from '@finnor/shared-types';
import type { R3Submit } from '../../../epistemic-runtime/src/incentive-rule-synthesis/contracts';
import { r3Canonical, r3Digest } from '../../../epistemic-runtime/src/incentive-rule-synthesis/launcher';
import { tx, principal, unavailable } from '../evidence-execution/store';
import { enqueueOwnerDeliveryInTransaction } from '../../../governed-execution/src/owner-delivery-store';
import { nativeReference } from '../native-experience-transport';
import type { PeMutationContext } from '../types';
import type { R3OwnerBinding } from './owners';

export interface R3RequestRow {
  id: string; tenant_id: string; principal_id: string; work_id: string; work_input_id: string;
  request: R3Submit; request_digest: string; problem: ElicitationProblem; binding: R3OwnerBinding;
  generation: number; status: string; attempts_used: number; deadline_at: Date;
  protocol_ref: ExperimentRef | null; use_policy_ref: ExperimentRef | null;
  allocation_ref: ExperimentRef | null; schedules_ref: ExperimentRef | null;
  closed_event_id: string | null; claim_token: string | null; claim_fence: number | null; failure: string | null;
}
export const r3Ref = (owner: string, prefix: string, body: unknown, version: string): ExperimentRef => {
  const digest = r3Digest(body); return { owner, id: `${prefix}:${digest}`, version, contentDigest: digest };
};
export async function r3Authorize(ctx: PeMutationContext, c: PoolClient, lock = true) {
  if (principal(ctx) !== ctx.auth.userId) throw unavailable();
  const user = (await c.query("SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2" + (lock ? ' FOR SHARE' : ''),
    [ctx.auth.tenantId, principal(ctx)])).rows[0];
  if (!user || user.status !== 'active' || user.role !== ctx.auth.role) throw unavailable();
  return user;
}
export async function r3Request(ctx: PeMutationContext, id: string, c?: PoolClient, lock = false, reporter = false): Promise<R3RequestRow> {
  const read = async (client: PoolClient) => {
    await r3Authorize(ctx, client, lock);
    const row = (await client.query<R3RequestRow>('SELECT * FROM finnor_os.r3_requests WHERE tenant_id=$1 AND id=$2' +
      (!reporter ? ' AND principal_id=$3' : '') + (lock ? ' FOR UPDATE' : ''), reporter ? [ctx.auth.tenantId, id] : [ctx.auth.tenantId, id, principal(ctx)])).rows[0];
    if (!row || reporter && row.principal_id !== principal(ctx) && !row.problem.parties.some(p => p.reportingPrincipalId === principal(ctx))) throw unavailable();
    return row;
  };
  return c ? read(c) : tx(ctx, read, true);
}
export function r3PreparedExperienceEvent(body: Record<string, any>, eventId: string) {
  const owner = body.semanticOwner;
  const type = owner === 'S6' ? body.kind === 'SCHEDULE_PROPOSED' ? 'INTENT' : 'OBSERVATION'
    : owner === 'S5' ? body.kind === 'S5_CONTINGENT_RESERVED' ? 'RESERVATION' : 'CONSUMPTION'
    : owner === 'S4' ? 'POLICY_REVISION'
    : body.kind === 'SUBMITTED' ? 'HYPOTHESIS' : body.kind === 'PROTOCOL_PUBLISHED' ? 'MODEL_REVISION'
    : body.kind.startsWith('INVALIDATED') ? 'VALIDITY_CHANGE' : body.kind.includes('ATTEMPT') ? 'COMPUTE' : 'CORRECTION';
  const prepared = { schema: `finnor.${owner.toLowerCase()}.experience.v1`, semanticOwner: owner,
    episodeId: body.requestId, type, tenantId: body.tenantId, principalId: body.principalId,
    ...(owner === 'S3' ? { rightsRefs: [body.rightsRef], freshnessRefs: [], provenanceRefs: [], modelComputeRef: null }
      : { rightsRef: body.rightsRef }),
    revisionRef: eventId, contentDigest: r3Digest(body),
    knowledgeAt: body.at, validAt: body.at, preparedParentRefs: body.nativeParentRefs ?? [],
    causalParents: [], dependencyRefs: [], horizon: 'H1',
    uncertainty: owner === 'S3' ? 'ASSUMPTION_CONDITIONAL_UNADMITTED_H1' : 'MODEL_CONDITIONAL_UNADMITTED',
    detail: body, protectedReceipt: null, appendAuthorityGranted: false };
  return { ...prepared, eventId: `${owner.toLowerCase()}-event:${r3Digest(prepared)}` };
}
export async function r3Event(ctx: PeMutationContext, row: R3RequestRow, kind: string, detail: unknown, c: PoolClient) {
  const semanticOwner = ['REPORT', 'CLOSED', 'DECLINE', 'NO_RESPONSE', 'OBSERVED_ACCEPTANCE', 'OUT_OF_DOMAIN', 'SCHEDULE_PROPOSED'].includes(kind) ? 'S6'
    : kind.startsWith('S5_') ? 'S5' : kind.startsWith('S4_') ? 'S4' : 'S3';
  const prior = (await c.query(`SELECT event_id,body,digest FROM finnor_os.r3_events
    WHERE tenant_id=$1 AND request_id=$2 AND principal_id=$3 AND body->>'semanticOwner'=$4
    ORDER BY created_at DESC,event_id DESC LIMIT 1`,
    [row.tenant_id, row.id, principal(ctx), semanticOwner])).rows[0];
  if (prior && (r3Digest(prior.body) !== prior.digest || prior.event_id !== 'r3-event:' + prior.digest))
    throw Error('R3_NATIVE_PARENT_HISTORY_PREIMAGE_MISMATCH');
  const nativeParentRefs = prior?.body.rightsRef
    ? [r3PreparedExperienceEvent(prior.body, prior.event_id).eventId] : [];
  const body = { schema: 'finnor.r3.owner-event.v1', tenantId: row.tenant_id, principalId: principal(ctx),
    ownerPrincipalId: row.principal_id, requestId: row.id, generation: row.generation, kind,
    originalDeadlineAt: row.deadline_at.toISOString(), at: new Date().toISOString(), nonce: randomUUID(), detail,
    semanticOwner, rightsRef: row.problem.binding.rightsRef, nativeParentRefs,
    executionAuthorityGranted: false, protectedReceipt: null };
  const eventId = 'r3-event:' + r3Digest(body);
  if (Buffer.byteLength(r3Canonical(body)) > 8 * 1024 * 1024) throw Error('R3_HISTORY_RECORD_BYTE_BOUND');
  const n = (await c.query('SELECT count(*)::int n FROM finnor_os.r3_events WHERE tenant_id=$1 AND request_id=$2', [row.tenant_id, row.id])).rows[0].n;
  if (n >= 512) throw Error('R3_APPEND_HISTORY_BOUND_REQUIRES_ACCOUNTABLE_ARCHIVAL');
  await c.query('INSERT INTO finnor_os.r3_events(tenant_id,principal_id,request_id,event_id,generation,kind,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
    [row.tenant_id, principal(ctx), row.id, eventId, row.generation, kind, r3Canonical(body), r3Digest(body)]);
  // Native S6 transport is the canonical delivery owner. Missing configured
  // routes remain explicit pending external custody, never forged append PASS.
  const reference = nativeReference(body.semanticOwner, eventId, body, 'r3-owner-event-v1');
  await enqueueOwnerDeliveryInTransaction(c, { semanticOwner: body.semanticOwner, tenantId: row.tenant_id, principalId: principal(ctx) },
    { kind: 'REFERENCE', identity: reference.id, payload: { reference, rightsRefs: [row.problem.binding.rightsRef] } });
  const prepared = r3PreparedExperienceEvent(body, eventId);
  await enqueueOwnerDeliveryInTransaction(c, { semanticOwner, tenantId: row.tenant_id, principalId: principal(ctx) },
    { kind: 'EVENT', identity: prepared.eventId, payload: { event: prepared, references: [reference] } });
  return { eventId, ...body };
}
export async function r3PutObject(ctx: PeMutationContext, row: R3RequestRow, owner: string, prefix: string, version: string, content: unknown, c: PoolClient) {
  const ref = r3Ref(owner, prefix, content, version), reference = nativeReference(owner, ref.id, content, version);
  if (ref.contentDigest !== reference.contentDigest) throw Error('R3_NATIVE_OWNER_CANONICAL_ENCODING_MISMATCH');
  await c.query('INSERT INTO finnor_os.r3_objects(tenant_id,principal_id,request_id,owner,object_id,version,digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(tenant_id,object_id) DO NOTHING',
    [row.tenant_id, row.principal_id, row.id, owner, ref.id, version, ref.contentDigest, r3Canonical(content)]);
  await enqueueOwnerDeliveryInTransaction(c, { semanticOwner: owner, tenantId: row.tenant_id, principalId: row.principal_id },
    { kind: 'REFERENCE', identity: ref.id, payload: { reference, rightsRefs: [row.problem.binding.rightsRef] } });
  return ref;
}
export async function r3Object<T>(ctx: PeMutationContext, ref: ExperimentRef, c?: PoolClient, ownerPrincipalId = principal(ctx)): Promise<T> {
  const read = async (client: PoolClient) => {
    await r3Authorize(ctx, client, Boolean(c));
    const result = (await client.query('SELECT owner,version,digest,body FROM finnor_os.r3_objects WHERE tenant_id=$1 AND principal_id=$2 AND object_id=$3',
      [ctx.auth.tenantId, ownerPrincipalId, ref.id])).rows[0];
    if (!result || result.owner !== ref.owner || result.version !== ref.version || result.digest !== ref.contentDigest || r3Digest(result.body) !== ref.contentDigest) throw unavailable();
    return result.body as T;
  };
  return c ? read(c) : tx(ctx, read, true);
}
export async function r3Events(ctx: PeMutationContext, row: R3RequestRow, c?: PoolClient) {
  const read = async (client: PoolClient) => {
    const rows = (await client.query('SELECT event_id,kind,body,digest FROM finnor_os.r3_events WHERE tenant_id=$1 AND request_id=$2 ORDER BY created_at,event_id LIMIT 513',
      [row.tenant_id, row.id])).rows;
    if (rows.length > 512 || rows.some(r => r3Digest(r.body) !== r.digest || r.event_id !== 'r3-event:' + r.digest)) throw Error('R3_OWNER_HISTORY_INTEGRITY_OR_BOUND');
    return rows;
  }; return c ? read(c) : tx(ctx, read, true);
}
export const r3Protocol = (ctx: PeMutationContext, row: R3RequestRow, c?: PoolClient) => {
  if (!row.protocol_ref) throw Error('R3_CHECKED_PROTOCOL_REQUIRED');
  return r3Object<Omit<ElicitationProtocol, 'ref'>>(ctx, row.protocol_ref, c, row.principal_id).then(content => ({ ...content, ref: row.protocol_ref! }));
};

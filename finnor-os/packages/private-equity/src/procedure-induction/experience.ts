import type { PeMutationContext } from '../types';
import type { HarnessProgram, HarnessRequest } from '../program-synthesis/contracts';
import { requestRow } from '../program-synthesis/store';
import { authorizeProgramme } from '../live-recompilation/api';
import { sha, stable, tx, principal } from '../evidence-execution/store';
import { readCapabilityExecutionExperience } from '../../../capability-evolution/src/experience';
import { ExperienceRequestSchema, immutableRef, boundedJson,
  type EpisodeCut, type ExperienceRecord } from './contracts';

/** S6's authentic existing obligation handoff, not a manufactured analytical feed. */
export async function readProcedureExecutionHistory(ctx: PeMutationContext, obligationId: string) {
  return readCapabilityExecutionExperience(ctx, obligationId);
}

export async function readProcedureExperience(ctx: PeMutationContext, body: unknown): Promise<EpisodeCut> {
  boundedJson(body, 65536);
  const input = ExperienceRequestSchema.parse(body), cut = Date.parse(input.knowledgeCut);
  if (input.mode === 'protected') throw Error('P6_COMPLETE_PROTECTED_ANALYTICAL_EPISODE_PORT_REQUIRED');
  if (process.env.NODE_ENV === 'production' || process.env.FINNOR_P4_PROFILE !== 'ordinary_disposable')
    throw Error('P6_ORDINARY_DISPOSABLE_PROFILE_REQUIRED');
  if (cut > Date.now() || !Number.isFinite(cut)) throw Error('P6_KNOWLEDGE_CUT_INVALID');
  // Discover original episodes from authenticated rows, then enumerate their
  // entire request universes. A caller cannot hide failed siblings by naming a head.
  const selected = [];
  for (const id of input.programIds) {
    const q = await requestRow(ctx, id);
    await authorizeProgramme(ctx, q);
    selected.push(q);
  }
  const episodeIds = [...new Set(selected.map(q => q.episode_id))].sort();
  const requests = await tx(ctx, async c => (await c.query<{
    id: string; episode_id: string; work_id: string; request: HarnessRequest; proposed: HarnessProgram;
    created_at: Date; known_at: Date | null;
  }>(`SELECT id,episode_id,work_id,request,proposed,created_at,pg_xact_commit_timestamp(xmin) known_at
    FROM finnor_os.p1_requests WHERE tenant_id=$1 AND principal_id=$2 AND episode_id=ANY($3::uuid[])
    ORDER BY created_at,id LIMIT 129`, [ctx.auth.tenantId, principal(ctx), episodeIds])).rows, true);
  if (requests.length > 128) throw Error('P6_DECLARED_EPISODE_REQUEST_BOUND');
  for (const row of requests) await authorizeProgramme(ctx, await requestRow(ctx, row.id));
  const records: ExperienceRecord[] = [], future: ExperienceRecord[] = [];
  function knowledgeAt(created: Date, committed: Date | null): Date {
    if (!committed || !Number.isFinite(committed.getTime()))
      throw Error('P6_NATIVE_IMMUTABLE_COMMIT_CLOCK_REQUIRED');
    return committed > created ? committed : created;
  }
  function add(owner: 'P1' | 'P4' | 'P5', id: string, kind: string, body: unknown,
    at: Date, episodeId: string, programId: string) {
    boundedJson(body, 8388608);
    const row: ExperienceRecord = {
      ref: immutableRef(owner, id, owner === 'P1' ? 'p1-bounded-native-v1' :
        owner === 'P4' ? 'p4-native-v1' : 'p5-interface-ir-v1', body),
      kind, body, episodeId, programId, knowledgeAt: at.toISOString(),
    };
    (at.getTime() <= cut ? records : future).push(row);
  }
  const episodeRows = await tx(ctx, async c => (await c.query(
    `SELECT id,work_id,max_steps,max_attempts,max_candidates,max_depth,deadline_at,created_at,
      pg_xact_commit_timestamp(xmin) known_at FROM finnor_os.p1_episodes
      WHERE tenant_id=$1 AND principal_id=$2 AND id=ANY($3::uuid[]) ORDER BY id`,
  [ctx.auth.tenantId, principal(ctx), episodeIds])).rows, true);
  for (const q of requests) {
    // The initial immutable request/proposal is the decision-time source, not
    // today's mutable request status, queue lease, head pointer or counters.
    const events = await tx(ctx, async c => (await c.query(
      `SELECT id,kind,body,created_at,pg_xact_commit_timestamp(xmin) known_at FROM finnor_os.p1_events
       WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 ORDER BY created_at,id LIMIT 513`,
    [ctx.auth.tenantId, principal(ctx), q.id])).rows, true);
    if (events.length > 512) throw Error('P6_EPISODE_EVENT_BOUND');
    const accepted = events.find(e => e.kind === 'RESOLVE_OUTCOME');
    if (!accepted || accepted.body.acceptedDigest !== sha(q.request.acceptance) ||
      q.proposed.acceptanceDigest !== sha(q.request.acceptance))
      throw Error('P6_IMMUTABLE_NATIVE_INTAKE_REQUIRED');
    // xmin on the mutable request points at the latest lease/status UPDATE.
    // The immutable intake event owns original commit visibility instead.
    const acceptedAt = knowledgeAt(accepted.created_at, accepted.known_at);
    add('P1', 'p1-request:' + q.id, 'REQUEST', { request: q.request, proposed: q.proposed },
      acceptedAt, q.episode_id, q.id);
    for (const event of events) add('P1', 'p1-event:' + event.id, event.kind, event.body,
      knowledgeAt(event.created_at, event.known_at), q.episode_id, q.id);
    const heads = await tx(ctx, async c => (await c.query<{ id: string; body: HarnessProgram; digest: string; created_at: Date; known_at: Date | null }>(
      `SELECT id,body,digest,created_at,pg_xact_commit_timestamp(xmin) known_at FROM finnor_os.p1_programs
       WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 ORDER BY created_at,id LIMIT 33`,
    [ctx.auth.tenantId, principal(ctx), q.id])).rows, true);
    if (heads.length > 32) throw Error('P6_EPISODE_HEAD_BOUND');
    for (const head of heads) {
      if (sha(head.body) !== head.digest) throw Error('P6_NATIVE_HEAD_PREIMAGE_INVALID');
      add('P1', head.id, 'PROGRAMME_HEAD', head.body,
        knowledgeAt(head.created_at, head.known_at), q.episode_id, q.id);
    }
    const derivations = await tx(ctx, async c => (await c.query(
      `SELECT d.id,d.body,d.digest,d.created_at,pg_xact_commit_timestamp(d.xmin) known_at
       FROM finnor_os.p4_derivations d JOIN finnor_os.p4_queries p ON p.id=d.query_id AND p.tenant_id=d.tenant_id
       WHERE d.tenant_id=$1 AND d.principal_id=$2 AND p.work_id=$3 ORDER BY d.created_at,d.id LIMIT 65`,
    [ctx.auth.tenantId, principal(ctx), q.work_id])).rows, true);
    if (derivations.length > 64) throw Error('P6_EPISODE_DERIVATION_BOUND');
    for (const d of derivations) {
      if (sha(d.body) !== d.digest) throw Error('P6_NATIVE_DERIVATION_PREIMAGE_INVALID');
      add('P4', d.id, 'EVIDENCE_DERIVATION', d.body,
        knowledgeAt(d.created_at, d.known_at), q.episode_id, q.id);
    }
    // Include every P5 path belonging to the declared Work, not just interfaces
    // with successful practice. Their semantics/egress responsibility stay P5/S6.
    const interfaces = await tx(ctx, async c => (await c.query(
      `SELECT e.id,e.kind,e.body,e.digest,e.created_at,pg_xact_commit_timestamp(e.xmin) known_at
       FROM finnor_os.p5_events e JOIN finnor_os.p5_acquisitions a ON a.id=e.acquisition_id AND a.tenant_id=e.tenant_id
       WHERE e.tenant_id=$1 AND e.principal_id=$2 AND a.work_id=$3 ORDER BY e.created_at,e.id LIMIT 129`,
    [ctx.auth.tenantId, principal(ctx), q.work_id])).rows, true);
    if (interfaces.length > 128) throw Error('P6_EPISODE_INTERFACE_BOUND');
    for (const e of interfaces) {
      if (sha(e.body) !== e.digest) throw Error('P6_NATIVE_INTERFACE_PREIMAGE_INVALID');
      add('P5', 'p5-event:' + e.id, e.kind, e.body,
        knowledgeAt(e.created_at, e.known_at), q.episode_id, q.id);
    }
  }
  const unique = (rows: ExperienceRecord[]) => [...new Map(rows.map(r => [stable(r.ref), r])).values()]
    .sort((a, b) => a.knowledgeAt.localeCompare(b.knowledgeAt) || a.ref.id.localeCompare(b.ref.id));
  const visible = unique(records), later = unique(future);
  const episodes = episodeRows.filter(e => visible.some(r => r.episodeId === e.id && r.kind === 'REQUEST')).map(e => ({
    id: String(e.id), workId: String(e.work_id),
    requestIds: requests.filter(q => q.episode_id === e.id &&
      visible.some(r => r.programId === q.id && r.kind === 'REQUEST')).map(q => q.id),
    declaredBounds: { maxSteps: e.max_steps, maxAttempts: e.max_attempts,
      maxCandidates: e.max_candidates, maxDepth: e.max_depth, deadlineAt: e.deadline_at.toISOString() },
  }));
  const adverse = (r: ExperienceRecord) => /FAIL|UNKNOWN|INVALIDAT|CORRECT|CANCEL|DISCREPANC|QUARANTIN|STOP/.test(r.kind);
  const counts: Record<string, number> = {};
  for (const row of visible) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  for (const row of requests) await authorizeProgramme(ctx, await requestRow(ctx, row.id));
  return {
    schema: 'finnor.p6.native-episode-cut.v1', tenantId: ctx.auth.tenantId, principalId: principal(ctx),
    knowledgeCut: input.knowledgeCut, episodes, records: visible,
    futureKnowledgeExcluded: later.map(r => r.ref), newAdverseNoticeRefs: later.filter(adverse).map(r => r.ref),
    cutDigest: sha({ episodes, records: visible }), counts, protectedReceipt: null,
    qualification: 'AUTHORIZED_COMPLETE_DECLARED_NATIVE_EPISODES_NOT_PROTECTED_LEDGER_OR_CAUSAL_TRUTH',
    universe: 'CALLER_DECLARED_ORIGINAL_EPISODES_NOT_GLOBAL_SUCCESS_OR_NOVELTY_SAMPLE',
  };
}

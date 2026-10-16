import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canExerciseAuthorityTx, employeeAuthoritySnapshotTx } from '@finnor/authority';
import type { PeMutationContext } from '../types';
import { LiveControlError, type ControlConsequence, type ControlIntent } from './contracts';
import { controlFieldsTx } from './fields';
import { actor, branchRow, canonicalObjectTx, controlTransaction, currentOwnerVectorTx, digest,
  permittedCapacityTx, proposalRow, readControlActorTx, sharedControlIntent, sessionResources, sessionRow, type EvaluationRow,
  type ProposalRow, type SessionRow } from './store';

const reason = (value: unknown) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,159}$/.test(value) ? value : 'NATIVE_OWNER_PREDICATE_UNPASSED';
export function publishedConsequence(result: ControlConsequence | null, owner: boolean) {
  if (!result) return null;
  const native = result.result as Record<string, unknown> | null;
  let value: unknown = native?.native ?? native;
  if (result.owner === 'S4/S5' && value && typeof value === 'object') {
    const allocation = value as { check?: { feasible: boolean; reasons: string[]; envelopes: unknown[]; scenarioValues: unknown[];
      witnesses: Array<{ period: number; used: string; maximum: string; margin: string }> }; validUntil?: string };
    value = { check: allocation.check ? { feasible: allocation.check.feasible,
      reasons: allocation.check.reasons.map(reason), envelopes: allocation.check.envelopes,
      scenarioValues: owner ? allocation.check.scenarioValues : null,
      witnesses: allocation.check.witnesses.map(({ period, used, maximum, margin }) => ({ period, used, maximum, margin })) } : null,
    validUntil: allocation.validUntil ?? null };
  }
  return { status: result.status, owner: result.owner, result: value,
    materialGaps: result.materialGaps.map(reason), coverage: result.coverage,
    modelRelative: true, reservesCapital: false, executionAuthorityGranted: false,
    costs: owner ? result.costs : { status: result.costs.status, refs: [], usage: { privateOriginalCostCustody: true } } };
}
async function observedOperation(ctx: PeMutationContext, proposal: ProposalRow, client: PoolClient) {
  const disposition = (await client.query<{ status: string; refs: Record<string, any>; reason: string | null }>(
    `SELECT d.status,coalesce(c.refs,d.refs) refs,d.reason FROM finnor_os.v5_dispatch_refs d
     LEFT JOIN finnor_os.v5_dispatch_custody c ON c.tenant_id=d.tenant_id AND c.proposal_id=d.proposal_id
     WHERE d.tenant_id=$1 AND d.proposal_id=$2`,
    [ctx.auth.tenantId, proposal.id])).rows[0];
  if (!disposition) return null;
  const owner = proposal.principal_id === actor(ctx);
  const actionId = typeof disposition.refs.actionId === 'string' ? disposition.refs.actionId
    : proposal.native_request.kind === 'NATIVE_ACTION' ? proposal.id : null;
  const native = actionId ? (await client.query(`SELECT d.id,d.status action_status,e.id effect_id,e.status effect_status,
    e.semantic_hash effect_hash FROM finnor_os.domain_actions d
    LEFT JOIN finnor_os.business_effects e ON e.tenant_id=d.tenant_id AND e.id=d.business_effect_id
    WHERE d.tenant_id=$1 AND d.id=$2`, [ctx.auth.tenantId, actionId])).rows[0] : null;
  const run = native?.effect_id ? (await client.query(`SELECT r.id,r.status FROM finnor_os.workflow_runs r
    JOIN finnor_os.workflow_steps s ON s.tenant_id=r.tenant_id AND s.workflow_run_id=r.id
    WHERE s.tenant_id=$1 AND s.business_effect_id=$2 ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
  [ctx.auth.tenantId, native.effect_id])).rows[0] : null;
  const key = 'v5-dispatch:' + proposal.branch_id;
  const reservation = (await client.query(`SELECT r.reservation_id,r.revision,r.status,r.revocation_reason
    FROM finnor_os.s5_requests q JOIN finnor_os.s5_reservations r ON r.tenant_id=q.tenant_id AND r.allocation_digest=q.allocation_digest
    WHERE q.tenant_id=$1 AND q.principal_id=$2 AND q.idempotency_key=$3`,
  [ctx.auth.tenantId, proposal.principal_id, key])).rows[0];
  return { status: disposition.status === 'SUBMITTING' && !native && !reservation ? 'UNKNOWN' : disposition.status,
    reason: disposition.reason ? reason(disposition.reason) : null,
    originalAction: native ? { id: native.id, status: native.action_status } : null,
    originalEffect: native?.effect_id ? { id: native.effect_id, status: native.effect_status, semanticHash: native.effect_hash } : null,
    originalWorkflow: run ?? null,
    reservation: reservation ? { id: reservation.reservation_id, revision: reservation.revision,
      status: reservation.status, retained: reservation.status !== 'RELEASED', revoked: !!reservation.revocation_reason } : null,
    originalRefs: owner ? disposition.refs : null, independentlyReadFromCanonicalOwners: true,
    settlementEstablished: false, automaticMutationRetry: false, responsibilityRetained: true };
}
async function projectionTx(ctx: PeMutationContext, session: SessionRow, client: PoolClient, onlyProposal?: string) {
  const identity = await readControlActorTx(ctx, client);
  const base = await currentOwnerVectorTx(ctx, session, sessionResources(session), client);
  const focus = await canonicalObjectTx(ctx, session.focus, client);
  const work = await canonicalObjectTx(ctx, { type: 'work', id: session.work_id }, client);
  const participants = (await client.query<{ principal_id: string }>(`SELECT DISTINCT p.principal_id
    FROM finnor_os.v5_participants p JOIN finnor_os.auth_delivery_sessions d
      ON d.tenant_id=p.tenant_id AND d.session_id=p.delivery_session_id
    WHERE p.tenant_id=$1 AND p.session_id=$2 AND d.revoked_at IS NULL AND d.expires_at>clock_timestamp()
      AND (p.principal_id=$3 OR finnor_os.may_query_resource('user',p.principal_id::text))
    ORDER BY p.principal_id LIMIT 11`, [ctx.auth.tenantId, session.id, actor(ctx)])).rows;
  const branches = (await client.query<{ id: string }>(`SELECT b.id FROM finnor_os.v5_branches b
    WHERE b.tenant_id=$1 AND b.session_id=$2 AND ($3::uuid IS NULL OR EXISTS(
      SELECT 1 FROM finnor_os.v5_proposals p WHERE p.tenant_id=b.tenant_id AND p.branch_id=b.id AND p.id=$3))
    ORDER BY b.created_at DESC,b.id DESC LIMIT 65`, [ctx.auth.tenantId, session.id, onlyProposal ?? null])).rows;
  const scenarios: unknown[] = [];
  for (const item of branches.slice(0, 64)) {
    const branch = await branchRow(ctx, session, item.id, client);
    const owner = branch.principal_id === actor(ctx);
    const vector = await currentOwnerVectorTx(ctx, session, branch.resources, client, branch.principal_id);
    const current = digest(vector) === digest(branch.owner_vector);
    const evaluation = (await client.query<EvaluationRow & { physical_claim_current: boolean }>(`SELECT e.*,coalesce(c.result_private,e.result) result,
      coalesce(c.cost_refs,'[]'::jsonb) cost_refs,c.charged,
      EXISTS(SELECT 1 FROM finnor_os.jobs j WHERE j.tenant_id=e.tenant_id AND j.id=e.job_id
        AND j.status='running' AND j.claim_token=c.claim_token AND j.claim_fence=c.claim_fence
        AND j.lease_expires_at>clock_timestamp()) physical_claim_current FROM finnor_os.v5_evaluations e
      LEFT JOIN finnor_os.v5_evaluation_custody c ON c.tenant_id=e.tenant_id AND c.evaluation_id=e.id
      WHERE e.tenant_id=$1 AND e.branch_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT 1`, [ctx.auth.tenantId, branch.id])).rows[0];
    const proposals = (await client.query<ProposalRow>(`SELECT * FROM finnor_os.v5_proposals
      WHERE tenant_id=$1 AND branch_id=$2 ORDER BY created_at,id LIMIT 33`, [ctx.auth.tenantId, branch.id])).rows;
    if (proposals.length > 32) throw new LiveControlError('EXACT_PROPOSAL_LIMIT', 'The exact branch exceeds its 32-proposal profile');
    const actions: unknown[] = [];
    for (const publicProposal of proposals) {
      const proposal = await proposalRow(ctx, session, publicProposal.id, client);
      const approvals = (await client.query<{ decision_id: string; principal_id: string }>(
        'SELECT decision_id,principal_id FROM finnor_os.v5_approval_refs WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY created_at,decision_id',
        [ctx.auth.tenantId, proposal.id])).rows;
      const permitted = publishedConsequence(evaluation?.result ?? null, owner);
      const review = branch.intent.kind === 'S5_ALLOCATION' ? {
        kind: 'S5_RESERVATION_REVIEW', quantityContext: branch.intent.quantityContext,
        resourceEnvelopes: (permitted?.result as { check?: { envelopes: unknown[] } } | null)?.check?.envelopes ?? [],
        authorityRequest: proposal.authority_request, expiresAt: proposal.expires_at.toISOString(),
        materialGaps: permitted?.materialGaps ?? [],
        privateProducerBytesDisclosed: false, professionalOrExecutionAuthorityGranted: false,
      } : owner && branch.intent.kind !== 'GOVERNED_REQUEST' ? proposal.native_request
        : branch.intent.kind === 'NATIVE_ACTION' ? { kind: 'NATIVE_ACTION', actionType: branch.intent.actionType, payload: branch.intent.payload } : null;
      actions.push({ proposalId: proposal.id, proposalDigest: proposal.proposal_digest, requestDigest: proposal.request_digest,
        ownerVector: proposal.owner_vector, expiresAt: proposal.expires_at.toISOString(),
        status: !current || proposal.expires_at.getTime() <= Date.now() ? 'INVALIDATED_REVIEW' : 'EXACT_PROPOSAL_RECHECK_AT_DISPATCH',
        nativeRequest: owner && branch.intent.kind !== 'GOVERNED_REQUEST' ? proposal.native_request : null,
        permittedReview: review,
        authorityRequest: proposal.authority_request,
        approvals: approvals.map(approval => ({ decisionRef: approval.decision_id })),
        operation: await observedOperation(ctx, proposal, client) });
    }
    const withdrawn = !!(await client.query("SELECT 1 FROM finnor_os.v5_history WHERE tenant_id=$1 AND branch_id=$2 AND kind='WITHDRAWN' LIMIT 1",
      [ctx.auth.tenantId, branch.id])).rowCount;
    const author = owner ? identity : await canExerciseAuthorityTx(ctx.auth, { operation: 'query', capability: 'query:pe_world_state',
      resource: { type: 'user', id: branch.principal_id }, risk: 'low' }, client) ? (await client.query(
      'SELECT principal_id "principalId",actor_kind "actorKind",version "profileVersion" FROM finnor_os.employee_actor_profiles WHERE tenant_id=$1 AND principal_id=$2',
      [ctx.auth.tenantId, branch.principal_id])).rows[0] ?? null : null;
    scenarios.push({ branchId: branch.id, parentId: branch.parent_id, author,
      isAuthor: owner, visibility: branch.visibility, intent: owner ? branch.intent : sharedControlIntent(branch.intent),
      intentDigest: branch.intent_digest, ownerVector: branch.owner_vector, currentOwnerVector: vector,
      status: withdrawn ? 'WITHDRAWN_RESPONSIBILITY_RETAINED' : current ? 'HYPOTHETICAL_SCENARIO' : 'MATERIAL_CONFLICT_REBASE_REQUIRED',
      evaluation: evaluation ? { evaluationId: evaluation.id, status: !current ? 'INVALIDATED'
        : owner && evaluation.status === 'RUNNING' && evaluation.charged && !evaluation.physical_claim_current ? 'UNKNOWN' : evaluation.status,
        consequence: current ? publishedConsequence(evaluation.result, owner) : null,
        incurredCosts: owner ? evaluation.cost_refs : [], originalGrantRetained: true } : null,
      proposals: actions, confirmedStateChanged: false, automaticMerge: false });
  }
  const history = (await client.query<{ branch_id: string | null; kind: string; created_at: Date }>(`SELECT branch_id,kind,created_at
    FROM finnor_os.v5_history WHERE tenant_id=$1 AND session_id=$2
      AND ($3::uuid IS NULL OR branch_id IN(SELECT branch_id FROM finnor_os.v5_proposals WHERE tenant_id=$1 AND id=$3))
    ORDER BY created_at DESC,id DESC LIMIT 129`, [ctx.auth.tenantId, session.id, onlyProposal ?? null])).rows;
  const controls = {
    propose: await canExerciseAuthorityTx(ctx.auth, { operation: 'action', capability: 'action:propose_control',
      resources: sessionResources(session), risk: 'low', workId: session.work_id }, client),
    professionalOwner: 'ACTUAL_QUALIFIED_V3_PORT_REQUIRED',
    fields: await controlFieldsTx(ctx, session, client),
  };
  const result = { schema: 'finnor.live-institutional-control-session.v1', version: 'v5-live-institutional-control-v1',
    sessionId: session.id, principal: identity, workId: session.work_id, root: session.root, focus: session.focus,
    ownerVector: base, confirmed: { focus: { ref: focus.ref, owner: focus.owner, version: focus.version,
      exactProjectionJson: focus.exactProjectionJson, coverage: focus.coverage },
    work: { ref: work.ref, version: work.version, exactProjectionJson: work.exactProjectionJson },
    capacity: await permittedCapacityTx(ctx, client), settlementClaim: 'NO_SETTLEMENT_OR_ECONOMIC_VALUE_INFERRED' },
    participants: participants.slice(0, 10).map(row => ({ principalId: row.principal_id })),
    scenarios, history: history.slice(0, 128).map(row => ({ branchId: row.branch_id, kind: row.kind, recordedAt: row.created_at.toISOString() })),
    controls, coverage: { scope: 'PERMISSIONED_FOCUSED_OWNER_CUT', branchesTruncated: branches.length > 64,
      historyTruncated: history.length > 128, participantsTruncated: participants.length > 10,
      consistency: 'POSTGRES_SOURCE_AUTHORITY_DELIVERY_AND_S5_FENCES', atomicAcrossProviders: false },
    recovery: { mutationReplayPermitted: false, originalOwnerResponsibilityRetained: true } };
  if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024) throw new LiveControlError('PROJECTION_LIMIT', 'The permitted projection exceeds 8 MiB');
  return result;
}
async function cursorTx(ctx: PeMutationContext, session: SessionRow, projection: Awaited<ReturnType<typeof projectionTx>>, client: PoolClient) {
  const authority = await employeeAuthoritySnapshotTx(ctx.auth, client), witness = ctx.auth.deliverySession!;
  const expiresAt = new Date(Math.min(Date.now() + 15000, Date.parse(witness.expiresAt),
    authority.validUntil ? Date.parse(authority.validUntil) : Infinity,
    projection.principal.validUntil ? Date.parse(projection.principal.validUntil) : Infinity)).toISOString();
  await client.query('DELETE FROM finnor_os.v5_cursors WHERE tenant_id=$1 AND principal_id=$2 AND expires_at<=clock_timestamp()',
    [ctx.auth.tenantId, actor(ctx)]);
  const id = randomUUID(), vectors: Record<string, unknown> = { session: projection.ownerVector };
  const stable = { ...projection, principal: { ...projection.principal, authorityRevision: undefined },
    ownerVector: { scope: 'RECIPIENT_PRIVATE_CUT' }, scenarios: (projection.scenarios as Array<any>).map(branch => {
      vectors['branch:' + branch.branchId] = branch.ownerVector;
      vectors['current:' + branch.branchId] = branch.currentOwnerVector;
      return { ...branch, ownerVector: { scope: 'RECIPIENT_PRIVATE_CUT' }, currentOwnerVector: { scope: 'RECIPIENT_PRIVATE_CUT' },
        intentDigest: branch.isAuthor ? branch.intentDigest : digest(branch.intent),
        author: branch.author ? { ...branch.author, authorityRevision: undefined } : null,
        proposals: branch.proposals.map((proposal: any) => {
          vectors['proposal:' + proposal.proposalId] = proposal.ownerVector;
          return { ...proposal, ownerVector: { scope: 'RECIPIENT_PRIVATE_CUT' }, proposalDigest: 'EXACT_RECIPIENT_REVIEW',
            requestDigest: branch.isAuthor ? proposal.requestDigest : undefined };
        }) };
    }) };
  const projectionDigest = digest(stable);
  await client.query(`INSERT INTO finnor_os.v5_cursors(id,tenant_id,session_id,principal_id,delivery_session_id,
    projection_digest,owner_vector_digest,expires_at,owner_vectors) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
  [id, ctx.auth.tenantId, session.id, actor(ctx), witness.sessionId, projectionDigest, digest(projection.ownerVector), expiresAt, JSON.stringify(vectors)]);
  return { ...stable, ownerVector: { cut: id, basis: 'session' }, scenarios: stable.scenarios.map(branch => ({
    ...branch, ownerVector: { cut: id, basis: 'branch:' + branch.branchId }, currentOwnerVector: { cut: id, basis: 'current:' + branch.branchId },
    proposals: branch.proposals.map((proposal: any) => ({ ...proposal, ownerVector: { cut: id, basis: 'proposal:' + proposal.proposalId },
      proposalDigest: digest([id, proposal.proposalId, 'EXACT_RECIPIENT_REVIEW']) })),
  })), projectionDigest, cursor: id, cursorExpiresAt: expiresAt };
}
export async function readLiveControlSnapshot(ctx: PeMutationContext, sessionId: string, proposalId?: string) {
  return controlTransaction(ctx, async client => {
    const session = await sessionRow(ctx, sessionId, client);
    return cursorTx(ctx, session, await projectionTx(ctx, session, client, proposalId), client);
  }, { financialFence: true, coherent: true });
}
/** Full permitted replacements avoid global sequence/gap metadata and handle
 * commit inversion, listener loss, duplicate/future/out-of-order/expired cursors.
 * Nothing in this read path submits a financial command. */
export async function readLiveControlEvents(ctx: PeMutationContext, input: { sessionId: string; cursor: string; projectionDigest: string }) {
  return controlTransaction(ctx, async client => {
    const session = await sessionRow(ctx, input.sessionId, client);
    const prior = /^[a-f0-9-]{36}$/i.test(input.cursor) ? (await client.query<{ projection_digest: string }>(
      `SELECT projection_digest FROM finnor_os.v5_cursors WHERE id=$1 AND tenant_id=$2 AND session_id=$3
        AND principal_id=$4 AND delivery_session_id=$5 AND expires_at>clock_timestamp()`,
      [input.cursor, ctx.auth.tenantId, session.id, actor(ctx), ctx.auth.deliverySession!.sessionId])).rows[0] : null;
    const projection = await projectionTx(ctx, session, client);
    const valid = prior?.projection_digest === input.projectionDigest;
    const snapshot = await cursorTx(ctx, session, projection, client);
    return { kind: !valid ? 'RESYNC' : snapshot.projectionDigest === input.projectionDigest ? 'UNCHANGED' : 'DELTA',
      snapshot, gapMetadata: 'OPAQUE_RECIPIENT_BOUND_RESYNC', mutationReplayPermitted: false };
  }, { financialFence: true, coherent: true });
}

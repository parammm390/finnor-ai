import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { AllocationClearingInput, AuthorityRequest, DomainAction, ExecutionResult } from '@finnor/shared-types';
import { evaluateAuthorityTx, exactControlRequirementsTx, employeeAuthoritySnapshotTx, lockCurrentAuthorityTx, validateExactControlApprovalsTx } from '@finnor/authority';
import { LIVE_CONTROL_OPERATION_SCHEMAS as schemas, ControlIntentSchema, LiveControlError, unavailable, type ControlIntent, type OwnerVector } from './contracts';
import type { z } from 'zod';
import type { PeMutationContext } from '../types';
import { actor, appendHistory, assertActorActionTx, assertBranchUsableTx, assertVector, authorizeResourcesTx, branchRow, canonicalObjectTx, controlTransaction,
  currentOwnerVectorTx, digest, intentResourcesTx, investmentAnchorTx, proposalRow, rememberCommand, replayCommand, assertControlCutTx, sharedControlIntent, sessionResources, sessionRow,
  type BranchRow, type EvaluationRow, type ProposalRow, type SessionRow } from './store';
import { clearEnterprisePortfolio } from '../enterprise-allocation';
import { prepareEnterpriseContingentHandoff } from '../enterprise-control';
import { prepareEnterpriseDurableObligation, compileEnterpriseDurableObligationRequest, scheduleEnterpriseDurableObligationRequest } from '../enterprise-obligations';
import { readLiveControlSnapshot, readLiveControlEvents } from './projection';
import { assertNativeIntent, nativeRequest } from './native';
import { resolveControlBudget, assertControlBudgetTx, debitControlBudgetTx, type OriginalControlBudget } from './budget';

export type Operation = keyof typeof schemas;
export type Input<K extends Operation> = z.infer<(typeof schemas)[K]>;
/** Actual API composition supplies the existing S6 orchestrator, not a second
 * financial executor. Worker/native owner currentness is checked separately. */
export interface LiveControlPorts {
  runKnownAction(params: { actionId: string; workId: string; principalId: string; actionType: string;
    payload: Record<string, unknown>; control: Record<string, unknown> }): Promise<{ action: DomainAction; result: ExecutionResult }>;
}
function ownerOnly(ctx: PeMutationContext, branch: BranchRow) {
  if (branch.principal_id !== actor(ctx)) throw unavailable();
}
export function baseVector(vector: OwnerVector, session: SessionRow): OwnerVector {
  const keys = new Set(sessionResources(session).flatMap(ref => [`${ref.type}:${ref.id}`, `source:canonical:${ref.type}:${ref.id}`])
    .concat('authority', 'S5:joint-cut', 'source:rights:tenant', 'source:work-inputs:' + session.work_id,
      'work-input:' + session.work_id, 'work-plan:' + session.work_id));
  return Object.fromEntries(Object.entries(vector).filter(([key]) => keys.has(key)));
}
async function assertBase(ctx: PeMutationContext, session: SessionRow, expected: OwnerVector, client: PoolClient) {
  const current = await currentOwnerVectorTx(ctx, session, sessionResources(session), client);
  await assertControlCutTx(ctx, session, expected, baseVector(current, session), client, true);
}
async function requireProposalCapability(ctx: PeMutationContext, session: SessionRow, client: PoolClient) {
  await assertActorActionTx(ctx, { operation: 'action', capability: 'action:propose_control',
    resources: sessionResources(session), risk: 'low', workId: session.work_id }, client);
  const decision = await evaluateAuthorityTx(ctx.auth, { operation: 'action', capability: 'action:propose_control',
    resources: sessionResources(session), risk: 'low', workId: session.work_id }, client);
  if (decision.outcome !== 'allowed') throw new LiveControlError('PROPOSAL_AUTHORITY_DENIED', 'Present authority does not permit an institutional proposal', 403);
  return decision.id;
}
async function assertFocusBinding(ctx: PeMutationContext, session: SessionRow, client: PoolClient) {
  const focus = await canonicalObjectTx(ctx, session.focus, client);
  await canonicalObjectTx(ctx, { type: session.root.entityType, id: session.root.entityId }, client);
  await canonicalObjectTx(ctx, { type: 'work', id: session.work_id }, client);
  if (session.focus.type === session.root.entityType && session.focus.id === session.root.entityId) return;
  let bound = focus;
  if (session.focus.type === 'pe_investment_case' || typeof focus.raw.investment_case_id === 'string') {
    const investment = session.focus.type === 'pe_investment_case' ? focus
      : await canonicalObjectTx(ctx, { type: 'pe_investment_case', id: focus.raw.investment_case_id as string }, client);
    if (session.root.entityType === 'pe_opportunity' && investment.raw.opportunity_id === session.root.entityId) return;
    bound = await investmentAnchorTx(ctx, investment, client);
    if (session.root.entityType === bound.ref.type && session.root.entityId === bound.ref.id) return;
  }
  const dealId = typeof bound.raw.deal_id === 'string' ? bound.raw.deal_id : bound.ref.type === 'pe_deal' ? bound.ref.id : null;
  if (dealId) {
    if (session.root.entityType === 'pe_deal' && session.root.entityId === dealId) return;
    const deal = await canonicalObjectTx(ctx, { type: 'pe_deal', id: dealId }, client);
    if (session.root.entityType === 'external_organization' && deal.raw.target_organization_id === session.root.entityId) return;
  }
  if (session.root.entityType === 'external_organization' && bound.ref.type === 'pe_opportunity' && bound.raw.target_organization_id === session.root.entityId) return;
  if (focus.raw.subject_type === session.root.entityType && focus.raw.subject_id === session.root.entityId) return;
  throw new LiveControlError('FOCUS_ROOT_BINDING_UNAVAILABLE', 'The exact focused owner has no supported binding to this root', 422);
}
async function createBranch(ctx: PeMutationContext, session: SessionRow, input: Input<'branch'> | Input<'rebase'>,
  parent: BranchRow | null, client: PoolClient) {
  await requireProposalCapability(ctx, session, client);
  await assertBase(ctx, session, input.expectedOwnerVector, client);
  const intent = ControlIntentSchema.parse(input.intent);
  await assertNativeIntent(ctx, session, intent, client);
  if (intent.kind === 'GOVERNED_REQUEST' && 'visibility' in input && input.visibility === 'SHARED')
    throw new LiveControlError('PROTECTED_EXECUTION_IS_PRINCIPAL_PRIVATE', 'Protected request and authorization bytes cannot become shared session data');
  const resources = await intentResourcesTx(ctx, session, intent, client);
  const ownerVector = await currentOwnerVectorTx(ctx, session, resources, client);
  const id = randomUUID(), visibility = 'visibility' in input ? input.visibility : parent!.visibility;
  const publicIntent = sharedControlIntent(intent);
  const row = (await client.query<BranchRow>(`INSERT INTO finnor_os.v5_branches
    (id,tenant_id,session_id,principal_id,parent_id,visibility,intent,owner_vector,resources,intent_digest,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11) RETURNING *`,
  [id, ctx.auth.tenantId, session.id, actor(ctx), parent?.id ?? null, visibility, JSON.stringify(publicIntent), '{}',
    JSON.stringify(resources), digest(publicIntent), 'reason' in input ? input.reason : null])).rows[0]!;
  await client.query(`INSERT INTO finnor_os.v5_branch_custody(tenant_id,session_id,branch_id,principal_id,intent,intent_digest,owner_vector)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb)`, [ctx.auth.tenantId, session.id, id, actor(ctx), JSON.stringify(intent), digest(intent), JSON.stringify(ownerVector)]);
  row.intent = intent; row.owner_vector = ownerVector; row.intent_digest = digest(intent);
  row.consequence_grant = input.consequenceGrant;
  if (input.consequenceGrant) await client.query(`INSERT INTO finnor_os.v5_consequence_grants(tenant_id,session_id,branch_id,principal_id,grant_body)
    VALUES($1,$2,$3,$4,$5::jsonb)`, [ctx.auth.tenantId, session.id, id, actor(ctx), JSON.stringify(input.consequenceGrant)]);
  await appendHistory(ctx, session, row, parent ? 'EXPLICIT_REBASE' : 'TYPED_PROPOSAL', {
    branchId: id, parentId: parent?.id ?? null,
    originalPreserved: true, automaticMerge: false, confirmedStateChanged: false,
  }, client);
  return { branchId: id, status: 'PROPOSED_SCENARIO', confirmedStateChanged: false };
}

export async function operateLiveControl<K extends Operation>(ctx: PeMutationContext, operation: K, raw: unknown, ports?: LiveControlPorts): Promise<unknown> {
  const input = schemas[operation].parse(raw) as Input<K>;
  if (operation === 'snapshot') return readLiveControlSnapshot(ctx, (input as Input<'snapshot'>).sessionId);
  if (operation === 'events') return readLiveControlEvents(ctx, input as Input<'events'>);
  if (operation === 'open') {
    const open = input as Input<'open'>;
    const session = await controlTransaction(ctx, async client => {
      const provisional = { id: randomUUID(), tenant_id: ctx.auth.tenantId, work_id: open.workId, root: open.root, focus: open.focus };
      await assertFocusBinding(ctx, provisional, client);
      const inserted = (await client.query<SessionRow>(`INSERT INTO finnor_os.v5_sessions(id,tenant_id,work_id,root,focus,created_by)
        VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6) ON CONFLICT(tenant_id,work_id,root,focus) DO NOTHING RETURNING *`,
      [provisional.id, ctx.auth.tenantId, open.workId, JSON.stringify(open.root), JSON.stringify(open.focus), actor(ctx)])).rows[0];
      const row = inserted ?? (await client.query<SessionRow>(
        'SELECT * FROM finnor_os.v5_sessions WHERE tenant_id=$1 AND work_id=$2 AND root=$3::jsonb AND focus=$4::jsonb',
        [ctx.auth.tenantId, open.workId, JSON.stringify(open.root), JSON.stringify(open.focus)])).rows[0];
      if (!row) throw unavailable();
      await client.query(`INSERT INTO finnor_os.v5_participants(tenant_id,session_id,principal_id,delivery_session_id)
        VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [ctx.auth.tenantId, row.id, actor(ctx), ctx.auth.deliverySession!.sessionId]);
      return row;
    }, { registerDelivery: true });
    return readLiveControlSnapshot(ctx, session.id);
  }
  if (operation === 'dispatch') return dispatch(ctx, input as Input<'dispatch'>, ports);
  if (operation === 'recover') return readLiveControlSnapshot(ctx, (input as Input<'recover'>).sessionId, (input as Input<'recover'>).proposalId);
  if (operation === 'compile-request') {
    const request = input as Input<'compile-request'>;
    const refs = await controlTransaction(ctx, async client => {
      const session = await sessionRow(ctx, request.sessionId, client), proposal = await proposalRow(ctx, session, request.proposalId, client);
      if (proposal.principal_id !== actor(ctx)) throw unavailable();
      const dispatch = (await client.query('SELECT refs FROM finnor_os.v5_dispatch_custody WHERE tenant_id=$1 AND proposal_id=$2',
        [ctx.auth.tenantId, proposal.id])).rows[0];
      if (!dispatch?.refs?.obligationRef) throw new LiveControlError('NATIVE_S6_OBLIGATION_UNAVAILABLE', 'The original S5/S6 handoff is not prepared');
      return dispatch.refs;
    });
    return compileEnterpriseDurableObligationRequest(ctx, { obligationRef: refs.obligationRef, bindings: request.bindings });
  }
  let acceptedBudget: OriginalControlBudget | null = null;
  if (operation === 'evaluate') {
    const evaluate = input as Input<'evaluate'>;
    const original = await controlTransaction(ctx, async client => {
      const session = await sessionRow(ctx, evaluate.sessionId, client);
      const replay = await replayCommand(ctx, operation, evaluate.idempotencyKey, evaluate, client);
      if (replay) return { replay, session, branch: null };
      const branch = await branchRow(ctx, session, evaluate.branchId, client);
      ownerOnly(ctx, branch);
      return { replay: null, session, branch };
    }, { financialFence: true });
    if (original.replay) return original.replay;
    acceptedBudget = await resolveControlBudget(ctx, original.session, original.branch!);
  }
  return controlTransaction(ctx, async client => {
    const body = input as Input<'branch'> | Input<'evaluate'> | Input<'share'> | Input<'rebase'> | Input<'propose'> | Input<'approve'> | Input<'withdraw'>;
    const session = await sessionRow(ctx, body.sessionId, client);
    const key = body.idempotencyKey;
    const prior = await replayCommand(ctx, operation, key, body, client);
    if (prior) return prior;
    let result: unknown;
    if (operation === 'branch') result = await createBranch(ctx, session, body as Input<'branch'>, null, client);
    else if (operation === 'approve') result = await approveTx(ctx, session, body as Input<'approve'>, client);
    else {
      const branch = await branchRow(ctx, session, (body as Input<'evaluate'>).branchId, client);
      ownerOnly(ctx, branch);
      if (operation === 'rebase') result = await createBranch(ctx, session, body as Input<'rebase'>, branch, client);
      else if (operation === 'share') {
        const share = body as Input<'share'>;
        await requireProposalCapability(ctx, session, client);
        await assertControlCutTx(ctx, session, share.expectedOwnerVector, await currentOwnerVectorTx(ctx, session, branch.resources, client), client);
        if (branch.intent.kind === 'GOVERNED_REQUEST' && share.visibility === 'SHARED') throw new LiveControlError('PROTECTED_EXECUTION_IS_PRINCIPAL_PRIVATE', 'Protected authorization bytes stay principal-private');
        await appendHistory(ctx, session, branch, 'BRANCH_VISIBILITY', { visibility: share.visibility }, client);
        result = { branchId: branch.id, visibility: share.visibility, originalPreserved: true };
      } else if (operation === 'withdraw') {
        await appendHistory(ctx, session, branch, 'WITHDRAWN', { reason: (body as Input<'withdraw'>).reason,
          effectsCancelled: false, resourceReleaseGranted: false, responsibilityRetained: true }, client);
        result = { branchId: branch.id, status: 'WITHDRAWN', effectsCancelled: false };
      } else {
        await assertBranchUsableTx(ctx, branch, client);
        assertVector(branch.owner_vector, await currentOwnerVectorTx(ctx, session, branch.resources, client));
        if (operation === 'evaluate') {
          await requireProposalCapability(ctx, session, client);
          const id = randomUUID(), jobId = acceptedBudget ? randomUUID() : null;
          if (acceptedBudget) await assertControlBudgetTx(ctx, session, acceptedBudget, client);
          await client.query(`INSERT INTO finnor_os.v5_evaluations(id,tenant_id,session_id,principal_id,branch_id,request_digest,owner_vector,status,job_id)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
          [id, ctx.auth.tenantId, session.id, actor(ctx), branch.id, digest({ branchId: branch.id }),
            '{}', acceptedBudget ? 'ACCEPTED' : 'BLOCKED', jobId]);
          await client.query(`INSERT INTO finnor_os.v5_evaluation_custody(tenant_id,session_id,branch_id,evaluation_id,principal_id,delivery_session_id,original_budget,owner_vector)
            VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`, [ctx.auth.tenantId, session.id, branch.id, id, actor(ctx),
            ctx.auth.deliverySession!.sessionId, acceptedBudget ? JSON.stringify(acceptedBudget) : null, JSON.stringify(branch.owner_vector)]);
          if (acceptedBudget) await client.query(`INSERT INTO finnor_os.jobs(id,tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety,max_attempts)
            VALUES($1,$2,'evaluate_live_control_v1',$3::jsonb,$4,'interactive',1,'locally_idempotent',3)`,
          [jobId, ctx.auth.tenantId, JSON.stringify({ tenantId: ctx.auth.tenantId, principalId: actor(ctx), sessionId: session.id,
            branchId: branch.id, evaluationId: id, workId: session.work_id, originalDeadlineAt: acceptedBudget.deadlineAt }),
            'v5-evaluate:' + id]);
          await appendHistory(ctx, session, branch, acceptedBudget ? 'CONSEQUENCE_ACCEPTED' : 'CONSEQUENCE_BLOCKED', {
            evaluationId: id, status: acceptedBudget ? 'ACCEPTED' : 'BLOCKED', reservesCapital: false,
            reason: acceptedBudget ? null : 'ORIGINAL_NATIVE_COMPUTE_GRANT_REQUIRED' }, client);
          result = { evaluationId: id, status: acceptedBudget ? 'ACCEPTED' : 'BLOCKED', jobId,
            reason: acceptedBudget ? null : 'ORIGINAL_NATIVE_COMPUTE_GRANT_REQUIRED', reservesCapital: false };
        } else if (operation === 'propose') {
          const propose = body as Input<'propose'>;
          await assertControlCutTx(ctx, session, propose.expectedOwnerVector, branch.owner_vector, client);
          result = await proposeTx(ctx, session, branch, client);
        } else throw new LiveControlError('OPERATION_UNAVAILABLE', 'Unsupported control operation');
      }
    }
    return rememberCommand(ctx, session, operation, key, body, result, client);
  }, { financialFence: true });
}

async function proposeTx(ctx: PeMutationContext, session: SessionRow, branch: BranchRow, client: PoolClient) {
  const evaluation = (await client.query<EvaluationRow>(`SELECT e.*,c.result_private result,c.original_budget,c.owner_vector
    FROM finnor_os.v5_evaluations e JOIN finnor_os.v5_evaluation_custody c ON c.tenant_id=e.tenant_id AND c.evaluation_id=e.id
    WHERE e.tenant_id=$1 AND e.branch_id=$2 ORDER BY e.created_at DESC,e.id DESC LIMIT 1`, [ctx.auth.tenantId, branch.id])).rows[0];
  if (!evaluation?.result || !['COMPLETE', 'PARTIAL'].includes(evaluation.status)) throw new LiveControlError('CONSEQUENCE_NOT_CURRENT', 'A current native consequence result is required');
  assertVector(evaluation.owner_vector, branch.owner_vector);
  const evaluated = evaluation.result.result as { native: { check?: { feasible: boolean }; authorityRequest?: AuthorityRequest }; originalDeadlineAt: string };
  if (branch.intent.kind === 'S5_ALLOCATION' && (evaluation.status !== 'COMPLETE' || !evaluated.native.check?.feasible))
    throw new LiveControlError('JOINT_ALLOCATION_INFEASIBLE_OR_PARTIAL', 'The exact joint allocation does not pass the native constraints');
  if (branch.intent.kind === 'UNDERWRITING_ASSUMPTIONS' && evaluation.status !== 'COMPLETE')
    throw new LiveControlError('UNDERWRITING_INCOMPLETE', 'Incomplete native financial consequences cannot be submitted as complete');
  const request = await nativeRequest(ctx, session, branch, client);
  const authority: AuthorityRequest = evaluated.native.authorityRequest ? { ...evaluated.native.authorityRequest, workId: session.work_id } : { operation: 'action',
    capability: 'action:' + (request.actionType as string ?? 'execute_contingent_intervention'),
    resources: branch.resources.filter(ref => ref.type !== 'p4_derivation'), risk: 'high', workId: session.work_id };
  await assertActorActionTx(ctx, authority, client);
  const identity = await employeeAuthoritySnapshotTx(ctx.auth, client);
  const expiresAt = new Date(Math.min(Date.parse(evaluated.originalDeadlineAt), identity.validUntil ? Date.parse(identity.validUntil) : Infinity)).toISOString();
  if (Date.parse(expiresAt) <= Date.now()) throw new LiveControlError('ORIGINAL_DEADLINE_EXPIRED', 'The original native grant/authority deadline expired');
  const original = { branchId: branch.id, evaluationId: evaluation.id, ownerVector: branch.owner_vector,
    nativeRequest: request, authorityRequest: authority, expiresAt };
  const id = randomUUID(), proposalDigest = digest(original), requestDigest = digest(request);
  const exact = { ...authority, controlBinding: { proposalId: id, proposalDigest, dependencyDigest: digest(branch.owner_vector), requestDigest, expiresAt } };
  const requirements = await exactControlRequirementsTx(ctx.auth, exact, client);
  if (requirements.decision.outcome === 'denied') throw new LiveControlError('EXACT_ACTION_AUTHORITY_DENIED', 'Present action authority denies this exact request', 403);
  await client.query(`INSERT INTO finnor_os.v5_proposals
    (id,tenant_id,session_id,principal_id,branch_id,evaluation_id,proposal_digest,request_digest,owner_vector,native_request,authority_request,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)`,
  [id, ctx.auth.tenantId, session.id, actor(ctx), branch.id, evaluation.id, digest(randomUUID()), digest(randomUUID()),
    '{}', JSON.stringify({ kind: request.kind, actionType: request.actionType ?? null }), JSON.stringify(authority), expiresAt]);
  await client.query(`INSERT INTO finnor_os.v5_proposal_custody(tenant_id,session_id,proposal_id,principal_id,native_request,owner_vector,proposal_digest,request_digest)
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`, [ctx.auth.tenantId, session.id, id, actor(ctx), JSON.stringify(request), JSON.stringify(branch.owner_vector), proposalDigest, requestDigest]);
  await appendHistory(ctx, session, branch, 'EXACT_ACTION_PROPOSED', { proposalId: id,
    approvalSteps: requirements.steps, expiresAt, effectsDispatched: false }, client);
  return { proposalId: id, expiresAt,
    authorityDecisionRef: requirements.decision.id, authorityMode: requirements.steps.length ? 'EXACT_APPROVAL_REQUIRED' : 'CURRENT_STANDING_AUTHORITY', approvalSteps: requirements.steps };
}
function boundRequest(proposal: ProposalRow): AuthorityRequest {
  return { ...proposal.authority_request, controlBinding: { proposalId: proposal.id, proposalDigest: proposal.proposal_digest,
    dependencyDigest: digest(proposal.owner_vector), requestDigest: proposal.request_digest, expiresAt: proposal.expires_at.toISOString() } };
}
async function approvalRefs(ctx: PeMutationContext, proposal: ProposalRow, client: PoolClient) {
  return (await client.query<{ decision_id: string }>('SELECT decision_id FROM finnor_os.v5_approval_refs WHERE tenant_id=$1 AND proposal_id=$2 ORDER BY created_at,decision_id',
    [ctx.auth.tenantId, proposal.id])).rows.map(row => row.decision_id);
}
async function approveTx(ctx: PeMutationContext, session: SessionRow, input: Input<'approve'>, client: PoolClient) {
  const proposal = await proposalRow(ctx, session, input.proposalId, client), branch = await branchRow(ctx, session, proposal.branch_id, client);
  await assertBranchUsableTx(ctx, branch, client);
  const reviewedDigest = digest([input.expectedOwnerVector.cut, proposal.id, 'EXACT_RECIPIENT_REVIEW']);
  if (input.proposalDigest !== reviewedDigest || input.expiresAt !== proposal.expires_at.toISOString()) throw new LiveControlError('EXACT_PROPOSAL_MISMATCH', 'Review must bind the unchanged proposal and expiry', 409);
  await assertControlCutTx(ctx, session, input.expectedOwnerVector, proposal.owner_vector, client);
  assertVector(proposal.owner_vector, await currentOwnerVectorTx(ctx, session, branch.resources, client, proposal.principal_id));
  if (proposal.expires_at.getTime() <= Date.now()) throw new LiveControlError('EXACT_APPROVAL_EXPIRED', 'The original approval deadline expired', 409);
  const request = boundRequest(proposal), proposer = { ...ctx.auth, userId: proposal.principal_id, employeeId: proposal.principal_id };
  const requirements = await exactControlRequirementsTx(proposer, request, client), refs = await approvalRefs(ctx, proposal, client);
  if (requirements.decision.outcome === 'denied') throw new LiveControlError('EXACT_ACTION_AUTHORITY_DENIED', 'The original principal no longer has this action authority', 403);
  if (!requirements.steps.length) throw new LiveControlError('STANDING_AUTHORITY_RECHECK_AT_DISPATCH', 'No additional human approval is required by current S1');
  let step = requirements.steps[0]!;
  for (const candidate of requirements.steps) {
    const prefix = requirements.steps.filter(item => item.sequence < candidate.sequence);
    const counts = await client.query<{ capability: string; n: number }>(`SELECT capability,count(DISTINCT employee_id)::int n
      FROM finnor_os.authority_decisions WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND outcome='allowed'
        AND authority_revision=$3 AND evidence->'controlBinding'=$4::jsonb GROUP BY capability`,
    [ctx.auth.tenantId, refs, requirements.decision.authorityRevision, JSON.stringify(request.controlBinding)]);
    if (prefix.every(item => Number(counts.rows.find(row => row.capability === item.capability)?.n ?? 0) >= item.minimum)) step = candidate;
    if (Number(counts.rows.find(row => row.capability === candidate.capability)?.n ?? 0) < candidate.minimum) break;
  }
  const approvalRequest = { ...request, operation: 'approval' as const, capability: step.capability };
  await assertActorActionTx(ctx, approvalRequest, client, true);
  const decision = await evaluateAuthorityTx(ctx.auth, approvalRequest, client);
  if (decision.outcome !== 'allowed') throw new LiveControlError('EXACT_APPROVER_DENIED', 'Present authority does not cover this exact review', 403);
  await client.query(`INSERT INTO finnor_os.v5_approval_refs(tenant_id,session_id,proposal_id,principal_id,decision_id)
    VALUES($1,$2,$3,$4,$5)`, [ctx.auth.tenantId, session.id, proposal.id, actor(ctx), decision.id]);
  await appendHistory(ctx, session, branch, 'EXACT_APPROVAL_RECORDED', { proposalId: proposal.id, decisionRef: decision.id,
    expiresAt: proposal.expires_at.toISOString(), executionAuthorityGranted: false }, client);
  return { proposalId: proposal.id, decisionRef: decision.id, status: 'EXACT_REVIEW_RECORDED', executionAuthorityGranted: false };
}

export async function assertNativeControlActionTx(ctx: PeMutationContext, actionId: string, client: PoolClient) {
  const visible = (await client.query<ProposalRow>('SELECT * FROM finnor_os.v5_proposals WHERE tenant_id=$1 AND id=$2', [ctx.auth.tenantId, actionId])).rows[0];
  if (!visible) {
    const retained = (await client.query('SELECT proposal_id FROM finnor_os.v5_proposal_custody WHERE tenant_id=$1 AND proposal_id=$2',
      [ctx.auth.tenantId, actionId])).rowCount;
    const flagged = (await client.query(`SELECT id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=$2
      AND authority_context->'liveControl' IS NOT NULL`, [ctx.auth.tenantId, actionId])).rowCount;
    if (retained || flagged) throw unavailable();
    return;
  }
  if (visible.principal_id !== actor(ctx)) throw unavailable();
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['s5-portfolio:' + ctx.auth.tenantId]);
  await lockCurrentAuthorityTx(ctx.auth, client);
  const session = await sessionRow(ctx, visible.session_id, client), original = await proposalRow(ctx, session, visible.id, client),
    branch = await branchRow(ctx, session, original.branch_id, client);
  await assertBranchUsableTx(ctx, branch, client);
  assertVector(original.owner_vector, await currentOwnerVectorTx(ctx, session, branch.resources, client));
  const request = boundRequest(original);
  const action = (await client.query('SELECT action_type,payload,work_id,created_at,business_effect_id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=$2',
    [ctx.auth.tenantId, actionId])).rows[0];
  if (action && original.native_request.actionType) {
    const payload = original.native_request.payload as Record<string, unknown>;
    const { PRIVATE_EQUITY_CREATE_ID_FIELDS, PRIVATE_EQUITY_ACTION_CONTRACTS } = await import('../../../domain-plugins/private-equity');
    const createField = PRIVATE_EQUITY_CREATE_ID_FIELDS[action.action_type as keyof typeof PRIVATE_EQUITY_CREATE_ID_FIELDS];
    const expected = { ...payload, ...(action.payload.workId !== undefined ? { workId: session.work_id } : {}),
      ...(createField && action.payload[createField] !== undefined && payload[createField] === undefined ? { [createField]: actionId } : {}),
      ...(action.action_type === 'create_underwriting_run' && action.payload.worldAt !== undefined ? { worldAt: action.created_at.toISOString() } : {}) };
    const { grounding, ...actual } = action.payload;
    if (action.action_type !== original.native_request.actionType || action.work_id !== session.work_id || digest(actual) !== digest(expected)
      || grounding && (grounding.verticalKey !== 'private_equity' || grounding.deal?.entityId !== payload.dealId || grounding.work?.entityId !== session.work_id))
      throw new LiveControlError('EXACT_NATIVE_REQUEST_CHANGED', 'The native action no longer matches the bound request', 409);
    if (action.business_effect_id) {
      const effect = (await client.query('SELECT effect,semantic_hash FROM finnor_os.business_effects WHERE tenant_id=$1 AND id=$2 AND domain_action_id=$3',
        [ctx.auth.tenantId, action.business_effect_id, actionId])).rows[0];
      const { semanticValue } = await import('../../../orchestration/src/compiler');
      const body = effect?.effect;
      const createdType = createField ? PRIVATE_EQUITY_ACTION_CONTRACTS.find(contract => contract.actionType === action.action_type)?.resultEntityType : null;
      const targetsBound = Array.isArray(body?.targets) && body.targets.every((target: { type: string; id: string }) => {
        const type = target.type === 'employee' ? 'user' : target.type;
        return branch.resources.some(resource => resource.type === type && resource.id === target.id)
          || target.type === createdType && target.id === actionId;
      });
      if (!body || body.mode !== 'consequential' || body.semanticHash !== effect.semantic_hash || body.source?.domainActionId !== actionId
        || body.source?.workId !== session.work_id || body.source?.actionType !== action.action_type
        || body.operation?.name !== action.action_type || body.operation?.external || !targetsBound
        || body.bindings?.length || body.delta?.operation !== action.action_type
        || digest(body.delta?.values) !== digest(semanticValue(action.payload)))
        throw new LiveControlError('EXACT_GROUNDED_EFFECT_CHANGED', 'The original grounded Business Effect differs from the reviewed native operation', 409);
    }
  }
  await assertActorActionTx(ctx, request, client);
  const decisions = await approvalRefs(ctx, original, client);
  try { await validateExactControlApprovalsTx(ctx.auth, request, decisions, client); }
  catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (/^EXACT_(?:CURRENT_APPROVAL_CHAIN_INCOMPLETE|APPROVAL_BINDING_EXPIRED_OR_UNAVAILABLE|ACTION_AUTHORITY_DENIED|APPROVAL_CHAIN_UNAVAILABLE)$/.test(code))
      throw new LiveControlError(code, 'The exact current original S1 approval chain is not satisfied', 409);
    throw error;
  }
  const evaluation = (await client.query<{ original_budget: OriginalControlBudget }>(
    'SELECT original_budget FROM finnor_os.v5_evaluation_custody WHERE tenant_id=$1 AND evaluation_id=$2 AND principal_id=$3',
    [ctx.auth.tenantId, original.evaluation_id, actor(ctx)])).rows[0];
  if (!evaluation?.original_budget) throw new LiveControlError('ORIGINAL_NATIVE_COMPUTE_GRANT_REQUIRED', 'The original native budget custody is required');
  await assertControlBudgetTx(ctx, session, evaluation.original_budget, client);
  return { authorityRequest: request, approvalDecisionIds: decisions };
}

async function dispatch(ctx: PeMutationContext, input: Input<'dispatch'>, ports?: LiveControlPorts) {
  const prepared = await controlTransaction(ctx, async client => {
    const session = await sessionRow(ctx, input.sessionId, client), proposal = await proposalRow(ctx, session, input.proposalId, client);
    const branch = await branchRow(ctx, session, proposal.branch_id, client);
    ownerOnly(ctx, branch);
    const previous = (await client.query('SELECT status,refs FROM finnor_os.v5_dispatch_refs WHERE tenant_id=$1 AND proposal_id=$2',
      [ctx.auth.tenantId, proposal.id])).rows[0];
    if (previous) return { previous, session, proposal, branch };
    if (input.proposalDigest !== digest([input.expectedOwnerVector.cut, proposal.id, 'EXACT_RECIPIENT_REVIEW'])) throw new LiveControlError('EXACT_PROPOSAL_MISMATCH', 'The original recipient review differs', 409);
    await assertControlCutTx(ctx, session, input.expectedOwnerVector, proposal.owner_vector, client);
    await assertNativeControlActionTx(ctx, proposal.id, client);
    const evaluation = (await client.query<EvaluationRow>(`SELECT e.*,c.original_budget FROM finnor_os.v5_evaluations e
      JOIN finnor_os.v5_evaluation_custody c ON c.tenant_id=e.tenant_id AND c.evaluation_id=e.id
      WHERE e.tenant_id=$1 AND e.id=$2`, [ctx.auth.tenantId, proposal.evaluation_id])).rows[0];
    if (!evaluation?.original_budget) throw new LiveControlError('ORIGINAL_NATIVE_COMPUTE_GRANT_REQUIRED', 'Dispatch cannot invent an original native compute grant');
    const debit = await debitControlBudgetTx(ctx, session, evaluation.original_budget, client, 'EXACT_NATIVE_DISPATCH', proposal.id);
    await client.query(`INSERT INTO finnor_os.v5_dispatch_refs(tenant_id,session_id,proposal_id,principal_id,status,refs)
      VALUES($1,$2,$3,$4,'SUBMITTING',$5::jsonb)`, [ctx.auth.tenantId, session.id, proposal.id, actor(ctx),
      JSON.stringify({ nativeCommandKey: 'v5-dispatch:' + branch.id })]);
    await client.query(`INSERT INTO finnor_os.v5_dispatch_custody(tenant_id,session_id,proposal_id,principal_id,refs)
      VALUES($1,$2,$3,$4,$5::jsonb)`, [ctx.auth.tenantId, session.id, proposal.id, actor(ctx),
      JSON.stringify({ nativeCommandKey: 'v5-dispatch:' + branch.id, requestDigest: proposal.request_digest, originalComputeDebit: debit })]);
    await appendHistory(ctx, session, branch, 'ORIGINAL_DISPATCH_INTENT', { proposalId: proposal.id,
      automaticMutationRetry: false, responsibilityRetained: true }, client);
    return { previous: null, session, proposal, branch };
  }, { financialFence: true });
  if (prepared.previous) return { proposalId: prepared.proposal.id, status: prepared.previous.status, semanticReplay: true,
    effectsResubmitted: false, responsibilityRetained: true };
  const { session, proposal, branch } = prepared;
  let refs: Record<string, unknown> = {}, status = 'OWNER_ACCEPTED', reason: string | null = null;
  try {
    if (branch.intent.kind === 'S5_ALLOCATION') {
      const bound = proposal.native_request as {kind:string;request:AllocationClearingInput};
      if (bound.kind !== 'S5_ALLOCATION' || proposal.request_digest !== digest(bound))
        throw new LiveControlError('EXACT_NATIVE_REQUEST_CHANGED', 'The native allocation request differs from the approved request', 409);
      const exact = bound.request;
      const cleared = await clearEnterprisePortfolio(ctx, exact, async client => {
        const checked = await assertNativeControlActionTx(ctx, proposal.id, client);
        if (!checked || proposal.request_digest !== digest({ kind: 'S5_ALLOCATION', request: exact }))
          throw new LiveControlError('EXACT_NATIVE_REQUEST_CHANGED', 'The native allocation request differs from the approved request', 409);
        return checked;
      });
      if (!cleared.reservation || !cleared.certificate) { status = 'BLOCKED'; reason = cleared.status; }
      else {
        refs = { allocationRef: cleared.certificate.ref, reservationRef: cleared.reservation.ref, nativeStatus: cleared.status,
          costs: cleared.compute, executionAuthorityGranted: false, settlementEstablished: false };
        if (branch.intent.handoff) {
          const preparation = await prepareEnterpriseContingentHandoff(ctx, { ...branch.intent.handoff, allocationRef: cleared.certificate.ref });
          if (!preparation.preparationRef || !preparation.consumptionRef) throw new LiveControlError('ORIGINAL_S4_PREPARATION_NOT_CONSUMED', 'The original S4 owner did not prepare and consume the selected handoff');
          refs.preparationRef = preparation.preparationRef;
          refs.consumptionRef = preparation.consumptionRef;
          const obligation = await prepareEnterpriseDurableObligation(ctx, { preparationRef: preparation.preparationRef, allocationRef: cleared.certificate.ref,
            consumptionRef: preparation.consumptionRef }, { workId: session.work_id });
          refs.obligationRef = obligation.ref;
          refs.effectRef = obligation.effectRef;
          refs.actionId = obligation.domainActionId;
          refs.protectedDispatch = 'EXACT_REQUEST_ADMISSIONS_AND_EXTERNAL_OWNER_SIGNATURE_REQUIRED';
        }
      }
    } else if (branch.intent.kind === 'GOVERNED_REQUEST') {
      const scheduled = await scheduleEnterpriseDurableObligationRequest(ctx, branch.intent.execution);
      refs = { scheduled, originalRequestRef: branch.intent.execution.request.ref, protectedReceipt: null };
      status = 'QUEUED';
    } else {
      if (!ports) throw new LiveControlError('NATIVE_S6_PORT_UNAVAILABLE', 'The current native S6 action port is unavailable');
      const request = proposal.native_request;
      const dispatched = await ports.runKnownAction({ actionId: proposal.id, workId: session.work_id, principalId: actor(ctx),
        actionType: String(request.actionType), payload: request.payload as Record<string, unknown>,
        control: { sessionId: session.id, proposalId: proposal.id, proposalDigest: proposal.proposal_digest } });
      refs = { actionId: dispatched.action.id, nativeStatus: dispatched.result.status,
        gated: !!dispatched.result.output?.gated || !!dispatched.result.output?.pendingConfirmation,
        settlementEstablished: false };
      if (dispatched.result.status === 'failure') { status = 'BLOCKED'; reason = 'NATIVE_S6_REFUSAL'; }
    }
  } catch (error) {
    status = 'UNKNOWN';
    reason = error instanceof LiveControlError ? error.code : 'ORIGINAL_NATIVE_OWNER_OUTCOME_UNRESOLVED';
  }
  // Transport loss does not resubmit. A read-only canonical projection resolves
  // the original owner command/action identity, including after process loss.
  await controlTransaction(ctx, async client => {
    const live = await sessionRow(ctx, session.id, client);
    await branchRow(ctx, live, branch.id, client);
    const publicRefs = { actionId: refs.actionId ?? null, nativeStatus: refs.nativeStatus ?? null, gated: refs.gated ?? false };
    await client.query(`UPDATE finnor_os.v5_dispatch_refs SET status=$3,refs=refs||$4::jsonb,reason=$5,updated_at=clock_timestamp()
      WHERE tenant_id=$1 AND proposal_id=$2 AND status='SUBMITTING'`, [ctx.auth.tenantId, proposal.id, status, JSON.stringify(publicRefs), reason]);
    await client.query('UPDATE finnor_os.v5_dispatch_custody SET refs=refs||$3::jsonb WHERE tenant_id=$1 AND proposal_id=$2',
      [ctx.auth.tenantId, proposal.id, JSON.stringify(refs)]);
    await appendHistory(ctx, live, branch, 'NATIVE_OWNER_DISPOSITION', { proposalId: proposal.id, status, reason,
      independentlyObserved: false, automaticMutationRetry: false, responsibilityRetained: true }, client);
  }).catch(() => undefined); // Revocation cannot erase native responsibility.
  return { proposalId: proposal.id, status, reason, independentlyObserved: false, effectsResubmitted: false, responsibilityRetained: true };
}

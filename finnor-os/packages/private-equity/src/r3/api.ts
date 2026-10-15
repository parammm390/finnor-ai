import { randomUUID } from 'node:crypto';
import { ElicitationOperationSchemas, R3PreferenceDeclarationSchema } from '../../../epistemic-runtime/src/incentive-rule-synthesis/contracts';
import { r3Digest } from '../../../epistemic-runtime/src/incentive-rule-synthesis/launcher';
import { resolveDecisionWork } from '../decision-slice/adapters';
import { authorizeBeliefResources } from '../enterprise-beliefs';
import { tx, principal } from '../evidence-execution/store';
import { readSourceObject } from '../deliberation/store';
import type { PeMutationContext } from '../types';
import { assertR3Current, resolveR3Owners } from './owners';
import { r3Authorize, r3Event, r3Events, r3Object, r3Protocol, r3PutObject, r3Request } from './store';
import { createR3UsePolicy } from './control';
import { clearR3Portfolio, validateR3Allocation } from './allocation';
import { prepareR3Schedules, compileR3OperationPacket } from './obligations';
import { submitR3Report, closeR3Reports, recordR3ObservedEvent, currentR3Reports } from './events';
import { executeR3Fallback, R3_FALLBACK_CONTRACT } from './fallback';

export async function submitElicitationProtocol(ctx: PeMutationContext, raw: unknown) {
  const input = ElicitationOperationSchemas.submit.parse(raw), digest = r3Digest(input);
  if (process.env.NODE_ENV === 'production' || process.env.FINNOR_ENVIRONMENT === 'production' ||
    process.env.FINNOR_R3_PROFILE !== 'ordinary_disposable') throw Error('R3_PROTECTED_RUNTIME_FUNDING_AND_ADMISSION_UNAVAILABLE');
  const previous = await tx(ctx, async c => {
    await r3Authorize(ctx, c, false);
    return (await c.query('SELECT id,request_digest,status FROM finnor_os.r3_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
      [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0];
  }, true);
  if (previous) {
    if (previous.request_digest !== digest) throw Error('R3_REQUEST_IDEMPOTENCY_CONFLICT');
    await authorizeBeliefResources(ctx, [{ type: 'work', id: input.existing_work_revision.workId }]);
    return { requestId: previous.id, workId: input.existing_work_revision.workId, status: previous.status, semanticReplay: true };
  }
  const resolved = await resolveR3Owners(ctx, input), id = randomUUID();
  return tx(ctx, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7733))', [ctx.auth.tenantId + ':' + principal(ctx) + ':' + resolved.binding.work.id]);
    await r3Authorize(ctx, c);
    const currentInput = (await c.query('SELECT id::text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
      [ctx.auth.tenantId, resolved.binding.work.id])).rows[0];
    if (currentInput?.id !== resolved.binding.work.inputId) throw Error('R3_SUBMIT_EXACT_WORK_REVISION_FENCED');
    const retry = (await c.query('SELECT id,request_digest,status FROM finnor_os.r3_requests WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
      [ctx.auth.tenantId, principal(ctx), input.idempotencyKey])).rows[0];
    if (retry) {
      if (retry.request_digest !== digest) throw Error('R3_REQUEST_IDEMPOTENCY_CONFLICT');
      return { requestId: retry.id, workId: resolved.binding.work.id, status: retry.status, semanticReplay: true };
    }
    const count = (await c.query('SELECT count(*)::int n FROM finnor_os.r3_requests WHERE tenant_id=$1', [ctx.auth.tenantId])).rows[0].n;
    if (count >= 256) throw Error('R3_REQUEST_BOUND_REQUIRES_ACCOUNTABLE_ARCHIVAL');
    await c.query("UPDATE finnor_os.r3_requests SET status='INVALIDATED',generation=generation+1,failure='R3_NEW_WORK_PROPOSAL_OLD_AGREEMENTS_AND_LIABILITIES_RETAINED' WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND status IN('QUEUED','RUNNING','COMPLETE','INCOMPLETE')",
      [ctx.auth.tenantId, principal(ctx), resolved.binding.work.id]);
    await c.query('INSERT INTO finnor_os.r3_requests(id,tenant_id,principal_id,work_id,work_input_id,idempotency_key,request_digest,request,problem,binding,deadline_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11)',
      [id, ctx.auth.tenantId, principal(ctx), resolved.binding.work.id, resolved.binding.work.inputId, input.idempotencyKey, digest,
        JSON.stringify(input), JSON.stringify(resolved.problem), JSON.stringify(resolved.binding), input.limits.deadlineAt]);
    const row = await r3Request(ctx, id, c, true);
    for (const dependency of resolved.binding.dependencies) await c.query('INSERT INTO finnor_os.r3_dependencies(tenant_id,request_id,key,revision) VALUES($1,$2,$3,$4)',
      [row.tenant_id, row.id, dependency.key, dependency.revision]);
    const { assertDependencies } = await import('../evidence-execution/store');
    await assertDependencies(ctx, resolved.binding.dependencies, c, true);
    await assertR3Current(ctx, row, c, true);
    await r3PutObject(ctx, row, 'S3', 'r3-original-problem', 'r3-owner-resolved-problem-v1', resolved.problem, c);
    await r3Event(ctx, row, 'SUBMITTED', { originalInputDigest: r3Digest(resolved.problem), originalGrant: input.budget_grant_ref,
      cancellationRef: input.cancellation_ref, sourceStanding: 'CURRENT_PERMISSIONED_S1_DECLARATION_NOT_PRIVATE_TRUTH' }, c);
    await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety) VALUES($1,'run_incentive_rule_synthesis_v1',$2::jsonb,$3,'interactive',1,'locally_idempotent')",
      [row.tenant_id, JSON.stringify({ tenantId: row.tenant_id, principalId: row.principal_id, requestId: row.id, generation: 1 }), 'r3:' + id + ':1']);
    return { requestId: id, workId: row.work_id, workRevision: row.work_input_id, status: 'QUEUED', semanticReplay: false,
      deadlineAt: input.limits.deadlineAt, provisional: true, executionAuthorityGranted: false };
  });
}
export async function readElicitationProtocol(ctx: PeMutationContext, raw: unknown) {
  const input = ElicitationOperationSchemas.read.parse(raw), row = await r3Request(ctx, input.requestId);
  await authorizeBeliefResources(ctx, [{ type: 'work', id: row.work_id },
    { type: row.problem.binding.root.entityType, id: row.problem.binding.root.entityId }]);
  const attempts = await tx(ctx, async c => (await c.query('SELECT id,phase,status,body,digest FROM finnor_os.r3_attempts WHERE tenant_id=$1 AND request_id=$2 ORDER BY created_at LIMIT 33', [row.tenant_id, row.id])).rows, true);
  if (attempts.length > 32 || attempts.some(a => r3Digest(a.body) !== a.digest)) throw Error('R3_DURABLE_COST_RECEIPT_INTEGRITY_OR_BOUND');
  const costs = { attemptsUsed: row.attempts_used, nativeAndFallbackAttempts: attempts.map(a => ({ id: a.id, phase: a.phase, status: a.status,
    receipt: a.body.receipt ?? null, costs: a.body.costs ?? null })), usd: null, basis: 'UNMETERED_ALL_ATTEMPTS_RETAINED' };
  const base = { schema: 'finnor.r3.work-review.v1', requestId: row.id, workId: row.work_id, workRevision: row.work_input_id,
    tenantId: row.tenant_id, principalId: row.principal_id, status: row.status, deadlineAt: row.deadline_at.toISOString(),
    protocol: null, usePolicy: null, allocation: null, schedules: null, reportState: null, costs,
    reason: row.failure, provisional: !row.protocol_ref, agreementEstablished: false, settlementEstablished: false, executionAuthorityGranted: false };
  if (['CANCELLED', 'INVALIDATED'].includes(row.status)) return base;
  try {
    await assertR3Current(ctx, row, undefined, false, true);
    const protocol = row.protocol_ref ? await r3Protocol(ctx, row) : null;
    const allocation = row.allocation_ref ? await validateR3Allocation(ctx, row.allocation_ref) : null;
    if (allocation && allocation.status !== 'CURRENT') throw Error('R3_CURRENT_RESOURCE_FEASIBILITY_REVISED');
    return { ...base, protocol, usePolicy: row.use_policy_ref ? { ref: row.use_policy_ref, ...await r3Object<Record<string, unknown>>(ctx, row.use_policy_ref) } : null,
      allocation, schedules: row.schedules_ref ? { ref: row.schedules_ref, ...await r3Object<Record<string, unknown>>(ctx, row.schedules_ref) } : null,
      reportState: protocol ? await currentR3Reports(ctx, row) : null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'R3_CURRENTNESS_UNAVAILABLE';
    await tx(ctx, async c => {
      const locked = await r3Request(ctx, row.id, c, true);
      if (!['CANCELLED', 'INVALIDATED'].includes(locked.status)) {
        await c.query("UPDATE finnor_os.r3_requests SET status='INVALIDATED',generation=generation+1,failure=$3 WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id, reason]);
        await r3Event(ctx, locked, 'INVALIDATED_FUTURE_USE', { reason, agreementsPaymentsLiabilitiesAndCostsRetained: true }, c);
      }
    });
    return { ...base, status: 'INVALIDATED', reason };
  }
}
export async function reviewElicitationProtocol(ctx: PeMutationContext, raw: unknown) {
  const input = ElicitationOperationSchemas.review.parse(raw), row = await r3Request(ctx, input.requestId);
  await assertR3Current(ctx, row, undefined, false, true);
  if (input.decision !== 'PROPOSE_USE') return executeR3Fallback(ctx, row, input.decision);
  await tx(ctx, async c => {
    const locked = await r3Request(ctx, row.id, c, true);
    if (locked.status !== 'COMPLETE' || !locked.protocol_ref) throw Error('R3_CHECKED_CURRENT_PROTOCOL_REQUIRED_FOR_OWNER_REVIEW');
    const ref = locked.use_policy_ref ?? await createR3UsePolicy(ctx, locked, c);
    await c.query('UPDATE finnor_os.r3_requests SET use_policy_ref=$3::jsonb WHERE tenant_id=$1 AND id=$2', [row.tenant_id, row.id, JSON.stringify(ref)]);
    await r3Event(ctx, locked, 'S4_PROPOSED_USE_REVIEWED', { usePolicyRef: ref, reason: input.reason, ownerReviewNotPartyConsent: true }, c);
  });
  const {clearEnterprisePortfolio}=await import('../enterprise-allocation');
  const allocation = await clearEnterprisePortfolio(ctx,{schema:'finnor.s5.r3-clearing-request.v1',requestId:row.id,idempotencyKey:'r3-reserve:'+row.id});
  if (!allocation.reservation) return allocation;
  const current = await r3Request(ctx, row.id), schedules = await prepareR3Schedules(ctx, current);
  return { usePolicyRef: current.use_policy_ref, allocation, schedules, operationPacket: await compileR3OperationPacket(ctx, current),
    agreementEstablished: false, executionAuthorityGranted: false };
}
export async function cancelElicitationProtocol(ctx: PeMutationContext, raw: unknown) {
  const input = ElicitationOperationSchemas.cancel.parse(raw);
  return tx(ctx, async c => {
    const row = await r3Request(ctx, input.requestId, c, true);
    await authorizeBeliefResources(ctx, [{ type: 'work', id: row.work_id }]);
    if (row.status !== 'CANCELLED') {
      await c.query("UPDATE finnor_os.r3_requests SET status='CANCELLED',generation=generation+1,claim_token=NULL,failure='R3_CANCELLED_NEW_SEARCH_NOT_AGREEMENTS_OR_LIABILITIES' WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
      await r3Event(ctx, row, 'CANCELLED', { cancellationRef: row.request.cancellation_ref, originalDeadlineRetained: true,
        previouslyAcceptedAgreementsAndPossibleEffectsRetained: true, resourceReleaseGranted: false }, c);
    }
    return { requestId: row.id, status: 'CANCELLED', originalDeadlineAt: row.deadline_at.toISOString(), costsAndResponsibilitiesRetained: true };
  });
}
async function contextElicitationProtocol(ctx: PeMutationContext, raw: unknown) {
  const input = ElicitationOperationSchemas.context.parse(raw), work = await resolveDecisionWork(ctx, input.workId);
  await authorizeBeliefResources(ctx, [{ type: input.root.entityType, id: input.root.entityId }]);
  const sources = await tx(ctx, async c => (await c.query(`SELECT DISTINCT ON(source_id) source_id,id,content_hash,version_number
    FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND snapshot->'worldRoot'=$2::jsonb
    AND snapshot->>'r3Kind'='PREFERENCE_DECLARATION' ORDER BY source_id,version_number DESC LIMIT 17`, [ctx.auth.tenantId, JSON.stringify(input.root)])).rows, true);
  if (sources.length > 16) throw Error('R3_CURRENT_PREFERENCE_CONTEXT_BOUND');
  const declarations = [];
  for (const s of sources) {
    const source = await readSourceObject(ctx, input.root, s.source_id, s.id), declared = R3PreferenceDeclarationSchema.parse(JSON.parse(source.content));
    if (declared.workId !== work.id || declared.workRevision !== work.inputId) continue;
    declarations.push({ problem_ref: { sourceId: s.source_id, versionId: s.id, contentDigest: s.content_hash },
      domain_profile_ref: declared.domainRef, mandateRef: declared.mandateRef, supportedParties: declared.parties.length,
      qualification: declared.behavioralQualification, noPrivateTruthInferred: true });
  }
  const requests = await tx(ctx, async c => (await c.query('SELECT id,status,work_input_id FROM finnor_os.r3_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 ORDER BY created_at DESC,id DESC LIMIT 17',
    [ctx.auth.tenantId, principal(ctx), work.id])).rows, true);
  if (requests.length > 16) throw Error('R3_WORK_REVIEW_HISTORY_BOUND');
  const {listEnterpriseControlPolicies}=await import('../enterprise-control');
  const policies=await listEnterpriseControlPolicies(ctx,input.root as import('../types').PeWorldRootRef);
  const grants=await tx(ctx,async c=>(await c.query(`SELECT p.certificate
    FROM finnor_os.s5_proposals p JOIN finnor_os.s5_reservations s ON p.tenant_id=s.tenant_id AND p.content_digest=s.allocation_digest
    WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.certificate->>'version'='s5-joint-finite-v1'
    AND s.status='RESERVED' AND s.revocation_reason IS NULL AND (p.certificate->>'validUntil')::timestamptz>clock_timestamp()
    AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.problem->'resources') r WHERE r->>'unit'='invocation' AND r->>'resourceClass'='COMPUTE')
    ORDER BY p.content_digest LIMIT 17`,[ctx.auth.tenantId,principal(ctx)])).rows,true);
  if(grants.length>16)throw Error('R3_CONTEXT_ORIGINAL_GRANT_BOUND');
  return { schema: 'finnor.r3.work-context.v1', workId: work.id, workRevision: work.inputId, declarations,
    incumbentPolicies:policies.map(p=>({ref:p.ref,mandateRef:p.mandateRef})),
    budgetGrants:grants.map(g=>({ref:g.certificate.ref,validUntil:g.certificate.validUntil})),
    requests: requests.map(r => ({ requestId: r.id, status: r.status, workRevision: r.work_input_id })), fallback: R3_FALLBACK_CONTRACT,
    executionAuthorityGranted: false };
}
export async function elicitationOperation(ctx: PeMutationContext, operation: string, input: unknown) {
  switch (operation) {
    case 'submit': return submitElicitationProtocol(ctx, input);
    case 'context': return contextElicitationProtocol(ctx, input);
    case 'read': case 'status': return readElicitationProtocol(ctx, input);
    case 'review': return reviewElicitationProtocol(ctx, input);
    case 'cancel': return cancelElicitationProtocol(ctx, input);
    case 'report': return submitR3Report(ctx, input);
    case 'close': return closeR3Reports(ctx, input);
    case 'event': return recordR3ObservedEvent(ctx, input);
    case 'use': {
      const parsed = ElicitationOperationSchemas.use.parse(input), row = await r3Request(ctx, parsed.requestId);
      const {consumeEnterpriseAllocation}=await import('../enterprise-allocation');
      return consumeEnterpriseAllocation(ctx,{schema:'finnor.s5.r3-consumption-request.v1',requestId:row.id,idempotencyKey:parsed.idempotencyKey});
    }
    case 'history': {
      const parsed = ElicitationOperationSchemas.history.parse(input), row = await r3Request(ctx, parsed.requestId);
      await authorizeBeliefResources(ctx, [{ type: 'work', id: row.work_id }]);
      return { requestId: row.id, events: await r3Events(ctx, row), historicalProtocolRef: row.protocol_ref,
        responsibilitiesRetained: true, executionAuthorityGranted: false };
    }
    default: throw Error('R3_OPERATION_NOT_FOUND');
  }
}

import type { PoolClient } from 'pg';
import type { ElicitationProtocol, ElicitationRuleRow } from '../../../shared-types/src/elicitation-protocol';
import type { ExperimentRef } from '@finnor/shared-types';
import { r3Digest } from '../../../epistemic-runtime/src/incentive-rule-synthesis/launcher';
import type { PeMutationContext } from '../types';
import { tx } from '../evidence-execution/store';
import { assertR3Current } from './owners';
import { r3Object, r3Protocol, r3PutObject, r3Request, type R3RequestRow } from './store';

export interface R3UsePolicy {
  schema: 'finnor.s4.r3-mechanism-use.v1'; requestId: string; tenantId: string; principalId: string;
  protocolRef: ExperimentRef; mandateRef: ExperimentRef; originalPolicyRef: ExperimentRef;
  domainRef: ExperimentRef; rightsRef: string; workId: string; workRevision: string;
  validUntil: string; grammar: 'r3-elicitation-use-v1';
  reservationSemantics: 'SOUND_ENVELOPE_ALL_LIVE_MUTUALLY_EXCLUSIVE_REPORTS';
  requiredObservations: ['AUTHORIZED_REPORTS_CLOSED', 'SEPARATE_CURRENT_PARTY_ACCEPTANCE'];
  numericProjection: 'NONE_EXACT_ORIGINAL_RULE_ONLY';
  executionAuthorityGranted: false; agreementEstablished: false;
}
export async function createR3UsePolicy(ctx: PeMutationContext, row: R3RequestRow, c: PoolClient) {
  const protocol = await r3Protocol(ctx, row, c);
  assertChecked(protocol);
  const policy: R3UsePolicy = { schema: 'finnor.s4.r3-mechanism-use.v1', requestId: row.id,
    tenantId: row.tenant_id, principalId: row.principal_id, protocolRef: protocol.ref, mandateRef: row.problem.binding.mandateRef,
    originalPolicyRef: row.binding.incumbentPolicyRef, domainRef: row.problem.binding.domainRef, rightsRef: row.problem.binding.rightsRef,
    workId: row.work_id, workRevision: row.work_input_id, validUntil: row.binding.validUntil, grammar: 'r3-elicitation-use-v1',
    reservationSemantics: 'SOUND_ENVELOPE_ALL_LIVE_MUTUALLY_EXCLUSIVE_REPORTS',
    requiredObservations: ['AUTHORIZED_REPORTS_CLOSED', 'SEPARATE_CURRENT_PARTY_ACCEPTANCE'],
    numericProjection: 'NONE_EXACT_ORIGINAL_RULE_ONLY', executionAuthorityGranted: false, agreementEstablished: false };
  return r3PutObject(ctx, row, 'S4', 'r3-use-policy', 'r3-elicitation-use-v1', policy, c);
}
function assertChecked(protocol: ElicitationProtocol) {
  if (!protocol.check.accepted || protocol.check.basis !== 'MODEL_RELATIVE_EXACT' ||
    protocol.check.inputDigest !== r3Digest(protocol.problem) || protocol.check.ruleDigest !== r3Digest(protocol.rule) ||
    protocol.check.checker.sourceDigest !== protocol.problem.binding.checkerDigest ||
    protocol.check.counts.profiles !== 81 || protocol.check.counts.deviations !== 648 || protocol.check.counts.participation !== 324)
    throw Error('R3_ACTUAL_INDEPENDENT_COMPLETE_PROTOCOL_REQUIRED');
}
export async function readR3UsePolicy(ctx: PeMutationContext, ref: ExperimentRef) {
  if (ref.owner !== 'S4' || ref.version !== 'r3-elicitation-use-v1') throw Error('R3_EXACT_POLICY_VERSION_REQUIRED');
  const policy = await r3Object<R3UsePolicy>(ctx, ref), row = await r3Request(ctx, policy.requestId);
  if (['CANCELLED', 'INVALIDATED'].includes(row.status)) throw Error('R3_POLICY_INVALIDATED_RESPONSIBILITY_RETAINED');
  await assertR3Current(ctx, row, undefined, false, true);
  const protocol = await r3Protocol(ctx, row);
  assertChecked(protocol);
  if (r3Digest(policy.protocolRef) !== r3Digest(protocol.ref) || policy.workRevision !== row.work_input_id ||
    r3Digest(policy.mandateRef) !== r3Digest(row.binding.mandate.ref)) throw Error('R3_POLICY_ORIGINAL_OWNER_BINDING_MISMATCH');
  return { ...policy, ref, protocol };
}
/** Called only by S4's versioned dispatch; no caller-provided report vector. */
export async function chooseR3ControlBranch(ctx: PeMutationContext, input: { policyRef: ExperimentRef }) {
  const policy = await readR3UsePolicy(ctx, input.policyRef), row = await r3Request(ctx, policy.requestId);
  const { currentR3Reports } = await import('./events');
  const observed = await currentR3Reports(ctx, row);
  if (!observed.closed || observed.noAgreement || !observed.complete)
    return { schema: 'finnor.s4.r3-choice.v1', status: 'WAIT_REPORTS_OR_NO_AGREEMENT', policyRef: policy.ref,
      protocolRef: policy.protocolRef, row: null, observations: observed.refs, agreementEstablished: false, executionAuthorityGranted: false };
  const selected = policy.protocol.rule.table.find(r => r.reports.every((t, i) => t === observed.reports[i]));
  if (!selected) throw Error('R3_ORIGINAL_REPORT_RULE_LOOKUP_INCOMPLETE');
  if (!observed.acceptanceComplete)
    return { schema: 'finnor.s4.r3-choice.v1', status: 'WAIT_SEPARATE_PARTY_ACCEPTANCE', policyRef: policy.ref,
      protocolRef: policy.protocolRef, row: selected, observations: observed.refs, agreementEstablished: false, executionAuthorityGranted: false };
  const { validateR3Allocation } = await import('./allocation');
  if (!row.allocation_ref || (await validateR3Allocation(ctx, row.allocation_ref)).status !== 'CURRENT')
    throw Error('R3_CURRENT_S5_RESERVATION_REQUIRED_AT_CHOICE');
  const body = { schema: 'finnor.s4.r3-choice.v1', status: 'PROPOSED_CHECKED_MODEL_RELATIVE',
    policyRef: policy.ref, protocolRef: policy.protocolRef, row: selected as ElicitationRuleRow,
    observations: observed.refs, agreementEstablished: false,
    acceptanceBasis: 'OBSERVED_DISPOSABLE_DECLARATIONS_NOT_PROTECTED_SIGNED_AGREEMENT', executionAuthorityGranted: false };
  const ref=await tx(ctx,async c=>{
    const locked=await r3Request(ctx,row.id,c,true);
    await assertR3Current(ctx,locked,c,true,true);
    return r3PutObject(ctx,locked,'S4','r3-rule-choice','r3-elicitation-choice-v1',body,c);
  });
  return {...body,ref};
}

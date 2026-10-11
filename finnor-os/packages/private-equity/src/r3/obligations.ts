import type { ExperimentRef } from '@finnor/shared-types';
import { r3Digest } from '../../../epistemic-runtime/src/incentive-rule-synthesis/launcher';
import type { PeMutationContext } from '../types';
import { tx } from '../evidence-execution/store';
import { assertR3Current } from './owners';
import { r3Event, r3Protocol, r3PutObject, r3Request, r3Object, type R3RequestRow } from './store';
import { readR3Allocation, validateR3Allocation } from './allocation';

/** Ordinary S6 proposed schedule IR, not a new protected operation vocabulary. */
export async function prepareR3Schedules(ctx: PeMutationContext, row: R3RequestRow) {
  await assertR3Current(ctx, row, undefined, false, true);
  if (!row.use_policy_ref || !row.allocation_ref) throw Error('R3_ACTUAL_S4_S5_HANDOFF_REQUIRED');
  if ((await validateR3Allocation(ctx, row.allocation_ref)).status !== 'CURRENT') throw Error('R3_CURRENT_S5_FUNDING_REQUIRED');
  const allocation = await readR3Allocation(ctx, row.allocation_ref), protocol = await r3Protocol(ctx, row);
  const body = { schema: 'finnor.s6.r3-proposed-schedules.v1', tenantId: row.tenant_id, principalId: row.principal_id,
    requestId: row.id, protocolRef: protocol.ref, usePolicyRef: row.use_policy_ref, allocationRef: row.allocation_ref,
    reservationRef: allocation.reservation.ref, moneyMeaning: protocol.problem.money,
    paymentContractRef: protocol.problem.binding.paymentContractRef, quantityEncoding: 'CANONICAL_RATIONAL_NUMERATOR_DENOMINATOR',
    branches: protocol.rule.table.map(branch => ({ reports: branch.reports, outcomeId: branch.outcomeId,
      obligations: branch.schedule.map(s => {
        const party = protocol.problem.parties.find(p => p.id === s.partyId)!;
        return { effectIdentity: 'r3-proposed-effect:' + r3Digest([protocol.ref, branch.reports, s]),
          beneficiary: { entityType: party.entityType, entityId: party.entityId }, ...s,
          operation: 'PROPOSED_CONTRACTED_CASH_TRANSFER_NOT_AN_ADMITTED_PROVIDER_OPERATION',
          event: protocol.problem.dates.find(d => d.id === s.dateId),
          preconditions: ['CURRENT_AUTHORIZED_CLOSED_REPORTS', 'SEPARATELY_QUALIFIED_PARTY_CONSENT',
            'CURRENT_S4_S5_FUNDING_RESERVATION_AND_CONSUMPTION', 'S8_METHOD_AND_S6_PROVIDER_OBSERVATION_ADMISSION'],
          fundingRef: row.allocation_ref, reservationRef: allocation.reservation.ref, consumptionRef: null,
          cancellation: 'RETAIN_ACCEPTED_AGREEMENT_AND_POSSIBLE_EFFECT_LIABILITIES',
          observationSupport: 'DUE_TIME_OBSERVABLE_SETTLEMENT_OPERATION_UNAVAILABLE', actualAttemptRef: null };
      }) })),
    reportingAndConsentContract: protocol.reporting,
    requiredOperations: ['QUALIFIED_SOLICITATION', 'QUALIFIED_AGREEMENT_SIGNING', 'QUALIFIED_PAYMENT_AND_COLLECTION_READBACK'],
    existingProtectedMethod: 'json-field-replace-v1_NOT_A_BANK_OR_SIGNING_INTERFACE',
    executionAuthorityGranted: false, agreementEstablished: false, settlementEstablished: false,
    status: 'COMPLETE_PROPOSED_SCHEDULE_OPERATION_ADMISSION_REQUIRED', noScheduleCollapsed: true };
  return tx(ctx, async c => {
    const locked = await r3Request(ctx, row.id, c, true);
    await assertR3Current(ctx, locked, c, true, true);
    if (locked.schedules_ref) return { ref: locked.schedules_ref, ...await r3Object<Record<string, unknown>>(ctx, locked.schedules_ref, c) };
    const ref = await r3PutObject(ctx, locked, 'S6', 'r3-proposed-schedules', 's6-r3-schedule-proposal-v1', body, c);
    await c.query('UPDATE finnor_os.r3_requests SET schedules_ref=$3::jsonb WHERE tenant_id=$1 AND id=$2', [row.tenant_id, row.id, JSON.stringify(ref)]);
    await r3Event(ctx, locked, 'SCHEDULE_PROPOSED', { schedulesRef: ref, profiles: body.branches.length,
      datedPaymentMembers: body.branches.reduce((n, b) => n + b.obligations.length, 0), authorityMissing: body.requiredOperations,
      proposedAmountsNotSettled: true }, c);
    return { ref, ...body };
  });
}
export async function readR3Schedules(ctx: PeMutationContext, ref: ExperimentRef) {
  const body = await r3Object<Record<string, unknown>>(ctx, ref);
  if (ref.owner !== 'S6' || ref.version !== 's6-r3-schedule-proposal-v1') throw Error('R3_S6_PROPOSED_SCHEDULE_VERSION_REQUIRED');
  return { ref, ...body };
}
export async function compileR3OperationPacket(ctx: PeMutationContext, row: R3RequestRow, consumptionRef: ExperimentRef | null = null) {
  const schedule = row.schedules_ref ? await readR3Schedules(ctx, row.schedules_ref) : await prepareR3Schedules(ctx, row);
  const body = { schema: 'finnor.s6.r3-operation-admission-packet.v1', schedulesRef: schedule.ref, consumptionRef,
    originalInputDigest: r3Digest(row.problem), protocolRef: row.protocol_ref, allocationRef: row.allocation_ref,
    checkerDigest: row.problem.binding.checkerDigest, domainRef: row.problem.binding.domainRef,
    requestedSemanticOwners: ['S6', 'S8', 'BUSINESS_OWNER'],
    requestedOperations: ['SOLICIT_REPORT', 'ATTEST_AGREEMENT', 'TRANSFER_OR_COLLECT_EXACT_CASH', 'INDEPENDENT_SETTLEMENT_READBACK'],
    protocol: 'EXACT_BENEFICIARY_AMOUNT_CURRENCY_DUE_EVENT_IDEMPOTENT_ATTEMPT_AND_UNKNOWN_READBACK',
    acceptancePredicate: 'ALL_ORIGINAL_MEMBERS_AND_CURRENT_AUTHORITY_FUNDING; RECONCILE_POSSIBLE_ATTEMPT_BEFORE_RETRY',
    observation: 'PROVIDER_AND_SIGNER_CONTRACT_UNAVAILABLE_DO_NOT_USE_JSON_FIELD_REPLACE_AS_PAYMENT',
    receiptDestination: { workId: row.work_id, requestId: row.id, semanticOwner: 'S6' },
    status: 'BLOCKED_EXTERNAL_PROTECTED_OPERATION_ADMISSION', executionAuthorityGranted: false };
  return { ...body, packetDigest: r3Digest(body) };
}

/** S6's explicit ordinary version. Unsupported cash operations stay proposals,
 * while exact canonical S5 intent and the selected original schedule are bound. */
export async function prepareR3OwnerHandoff(ctx: PeMutationContext, input: { requestId: string; consumptionRef?: ExperimentRef }) {
  const row = await r3Request(ctx, input.requestId);
  await assertR3Current(ctx, row, undefined, false, true);
  const schedules = await prepareR3Schedules(ctx, row);
  const current = await r3Request(ctx, row.id), issued = await readR3Allocation(ctx, current.allocation_ref!);
  let selectedSchedule: unknown = null;
  if (input.consumptionRef) {
    const { chooseEnterpriseControlBranch } = await import('../enterprise-control');
    const choice = await chooseEnterpriseControlBranch(ctx, { schema: 'finnor.s4.r3-choice-request.v1', policyRef: current.use_policy_ref! });
    if (choice.status !== 'PROPOSED_CHECKED_MODEL_RELATIVE' || !choice.row || !('ref' in choice))
      throw Error('R3_S6_CURRENT_EXACT_CLOSED_REPORT_CHOICE_REQUIRED');
    selectedSchedule = choice.row.schedule;
  }
  const body = { schema: 'finnor.s6.r3-owner-handoff.v1', semanticOwner: 'S6', requestId: row.id,
    tenantId: row.tenant_id, principalId: row.principal_id, protocolRef: row.protocol_ref,
    schedules, consumptionRef: input.consumptionRef ?? null, selectedSchedule,
    operationPacket: await compileR3OperationPacket(ctx, current, input.consumptionRef ?? null),
    status: 'COMPLETE_ORDINARY_PROPOSAL_NOT_PROTECTED_OPERATION', agreementEstablished: false,
    settlementEstablished: false, executionAuthorityGranted: false };
  return tx(ctx, async c => {
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['s5-portfolio:' + row.tenant_id]);
    const locked = await r3Request(ctx, row.id, c, true);
    await assertR3Current(ctx, locked, c, true, true);
    const held = (await c.query('SELECT status,revocation_reason,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2 FOR SHARE',
      [row.tenant_id, issued.reservation.ref.id])).rows[0];
    if (!held || held.status === 'RELEASED' || held.revocation_reason || r3Digest(held.envelopes) !== r3Digest(issued.reservation.envelopes))
      throw Error('R3_S6_CURRENT_CANONICAL_FUNDING_REQUIRED');
    if (input.consumptionRef) {
      const native = (await c.query('SELECT co.body,st.status,st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id) WHERE co.tenant_id=$1 AND co.principal_id=$2 AND co.consumption_id=$3 FOR SHARE OF st',
        [row.tenant_id, row.principal_id, input.consumptionRef.id])).rows[0];
      if (!native || native.status !== 'INTENDED_PENDING_S6' || native.effect_ref !== null ||
        r3Digest(native.body.ref) !== r3Digest(input.consumptionRef) ||
        r3Digest(native.body.policyRef) !== r3Digest(locked.use_policy_ref) ||
        r3Digest(native.body.certificateRef) !== r3Digest(locked.allocation_ref) ||
        r3Digest(native.body.envelope) !== r3Digest(held.envelopes))
        throw Error('R3_S6_ORIGINAL_CURRENT_EXACT_CONSUMPTION_REQUIRED');
    }
    const ref = await r3PutObject(ctx, locked, 'S6', 'r3-obligation-proposal', 's6-r3-owner-handoff-v1', body, c);
    return { ref, ...body };
  });
}

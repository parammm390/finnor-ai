import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ExperimentRefSchema } from '../../../epistemic-runtime/src/experiments';
import { r3Digest } from '../../../epistemic-runtime/src/incentive-rule-synthesis/launcher';
import { ElicitationOperationSchemas } from '../../../epistemic-runtime/src/incentive-rule-synthesis/contracts';
import { readSourceObject } from '../deliberation/store';
import { authorizeBeliefResources } from '../enterprise-beliefs';
import { tx, principal, assertDependencies, codeIdentity, schemaIdentity, revisions } from '../evidence-execution/store';
import { r3RuntimeIdentity } from '../../../epistemic-runtime/src/incentive-rule-synthesis/launcher';
import type { PeMutationContext } from '../types';
import { r3Events, r3Event, r3Protocol, r3Request, type R3RequestRow } from './store';

async function reportingCurrent(ctx: PeMutationContext, row: R3RequestRow, c: PoolClient) {
  if (!row.protocol_ref || ['CANCELLED', 'INVALIDATED'].includes(row.status)) throw Error('R3_CURRENT_FIXED_PROTOCOL_REQUIRED_FOR_REPORTS');
  await assertDependencies(ctx,row.binding.dependencies,c,true);
  if((await codeIdentity()).digest!==row.binding.codeDigest||(await schemaIdentity(ctx))!==row.binding.schemaDigest||
    (await r3RuntimeIdentity()).digest!==row.binding.runtimeDigest)throw Error('R3_REPORTING_METHOD_CHECKER_RUNTIME_CHANGED');
  await authorizeBeliefResources(ctx, [{ type: 'work', id: row.work_id },
    { type: row.problem.binding.root.entityType, id: row.problem.binding.root.entityId }]);
  const original = await readSourceObject(ctx, row.problem.binding.root, row.binding.source.sourceId, row.binding.source.versionId);
  if (original.content_hash !== row.binding.source.contentDigest) throw Error('R3_REPORTING_AUTHORITY_OR_PREFERENCE_REVISION_CHANGED');
  const latest = (await c.query('SELECT id::text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', [row.tenant_id, row.work_id])).rows[0];
  if (latest?.id !== row.work_input_id || Date.now() >= Date.parse(row.binding.validUntil)) throw Error('R3_REPORT_WORK_OR_PROTOCOL_EXPIRED');
}
export async function submitR3Report(ctx: PeMutationContext, raw: unknown) {
  const input = ElicitationOperationSchemas.report.parse(raw);
  return tx(ctx, async c => {
    const row = await r3Request(ctx, input.requestId, c, true, true);
    await reportingCurrent(ctx, row, c);
    const party = row.problem.parties.find(p => p.id === input.partyId);
    if (!party || party.reportingPrincipalId !== principal(ctx)) throw Error('R3_ACTUAL_PARTY_REPORTING_PRINCIPAL_REQUIRED');
    if (!party.types.some(t => t.id === input.typeId)) throw Error('R3_REPORT_OUTSIDE_DECLARED_DOMAIN');
    const events = await r3Events(ctx, row, c), requestDigest = r3Digest(input);
    const retry = events.find(e => e.kind === 'REPORT' && e.body.principalId === principal(ctx) && e.body.detail.idempotencyKey === input.idempotencyKey);
    if (retry) {
      if (retry.body.detail.requestDigest !== requestDigest) throw Error('R3_REPORT_IDEMPOTENCY_CONFLICT');
      return { eventId: retry.event_id, status: 'REPORT_RECORDED_NOT_AGREEMENT', semanticReplay: true };
    }
    if (row.closed_event_id) throw Error('R3_CORRECTION_AFTER_CLOSURE_FORBIDDEN');
    const prior = events.filter(e => e.kind === 'REPORT' && e.body.detail.partyId === party.id).at(-1);
    if ((prior?.event_id ?? null) !== input.replacesEventId) throw Error('R3_EXACT_REPORT_CORRECTION_PREIMAGE_REQUIRED');
    const event = await r3Event(ctx, row, 'REPORT', { ...input, requestDigest, protocolRef: row.protocol_ref,
      partyRef: { entityType: party.entityType, entityId: party.entityId }, submittedAt: new Date().toISOString(),
      claimNotTrueType: true, reportNotAgreement: true, sharing: 'OWNER_AND_AUTHORIZED_REPORTER_ONLY' }, c);
    await revision(c, row, `r3:report:${row.id}:${party.id}`);
    return { eventId: event.eventId, status: 'REPORT_RECORDED_NOT_AGREEMENT', semanticReplay: false };
  });
}
async function revision(c: PoolClient, row: R3RequestRow, key: string) {
  await c.query('INSERT INTO finnor_os.p4_source_revisions(tenant_id,key,revision) VALUES($1,$2,1) ON CONFLICT(tenant_id,key) DO UPDATE SET revision=finnor_os.p4_source_revisions.revision+1,changed_at=clock_timestamp()', [row.tenant_id, key]);
}
export async function closeR3Reports(ctx: PeMutationContext, raw: unknown) {
  const input = ElicitationOperationSchemas.close.parse(raw);
  return tx(ctx, async c => {
    const row = await r3Request(ctx, input.requestId, c, true); await reportingCurrent(ctx, row, c);
    if (row.closed_event_id) return { eventId: row.closed_event_id, semanticReplay: true, ...(await currentR3Reports(ctx, row, c)) };
    const state = await currentR3Reports(ctx, row, c);
    const event = await r3Event(ctx, row, 'CLOSED', { protocolRef: row.protocol_ref, reportEventIds: state.reportEventIds,
      missingParties: row.problem.parties.filter(p => !state.reportEventIds[p.id]).map(p => p.id),
      disposition: state.complete && !state.noAgreement ? 'REPORTS_FIXED_AWAIT_SEPARATE_ACCEPTANCE' : 'NO_AGREEMENT',
      changesRule: false, agreementEstablished: false }, c);
    await c.query('UPDATE finnor_os.r3_requests SET closed_event_id=$3 WHERE tenant_id=$1 AND id=$2', [row.tenant_id, row.id, event.eventId]);
    await revision(c, row, `r3:report-closing:${row.id}`);
    return { eventId: event.eventId, semanticReplay: false, ...(await currentR3Reports(ctx, { ...row, closed_event_id: event.eventId }, c)) };
  });
}
const observationSchema = z.object({
  schema: z.literal('finnor.r3.observed-party-event.v1'), protocolRef: ExperimentRefSchema,
  partyId: z.string().min(1).max(256), kind: z.enum(['DECLINE', 'NO_RESPONSE', 'OBSERVED_ACCEPTANCE', 'OUT_OF_DOMAIN']),
  attestingPrincipalId: z.string().uuid(), observerPrincipalId: z.string().uuid(),
  observedAt: z.string().datetime({ offset: true }), reportEventId: z.string().nullable(),
  outcomeId: z.string().nullable(), scheduleDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  domainRef: ExperimentRefSchema, basis: z.literal('DISPOSABLE_OBSERVED_DECLARATION_NOT_PROTECTED_AGREEMENT'),
  executionAuthorityGranted: z.literal(false),
}).strict();
export async function recordR3ObservedEvent(ctx: PeMutationContext, raw: unknown) {
  const input = ElicitationOperationSchemas.event.parse(raw), initial = await r3Request(ctx, input.requestId, undefined, false, true);
  const source = await readSourceObject(ctx, initial.problem.binding.root, input.observation.sourceId, input.observation.versionId);
  if (source.content_hash !== input.observation.contentDigest) throw Error('R3_SEPARATE_OBSERVATION_BYTES_REQUIRED');
  const observed = observationSchema.parse(JSON.parse(source.content));
  return tx(ctx, async c => {
    const row = await r3Request(ctx, input.requestId, c, true, true); await reportingCurrent(ctx, row, c);
    const party = row.problem.parties.find(p => p.id === input.partyId);
    if (!party || observed.partyId !== party.id || observed.kind !== input.kind ||
      observed.attestingPrincipalId !== party.reportingPrincipalId || observed.observerPrincipalId !== principal(ctx) ||
      r3Digest(observed.protocolRef) !== r3Digest(row.protocol_ref) || r3Digest(observed.domainRef) !== r3Digest(row.problem.binding.domainRef) ||
      Date.parse(observed.observedAt) > Date.now()) throw Error('R3_ORIGINAL_PARTY_EVENT_PROTOCOL_DOMAIN_OR_IDENTITY_MISMATCH');
    // An owner cannot manufacture another party's acceptance. This ordinary
    // adapter records an attested disposable observation, not a qualified signer.
    if (input.kind === 'OBSERVED_ACCEPTANCE' && principal(ctx) !== party.reportingPrincipalId)
      throw Error('R3_PARTY_ATTESTATION_REQUIRED_NOT_OWNER_REVIEW');
    const state = await currentR3Reports(ctx, row, c), protocol = await r3Protocol(ctx, row, c);
    if (input.kind === 'OBSERVED_ACCEPTANCE') {
      if (!state.closed || !state.complete || state.noAgreement) throw Error('R3_CLOSED_COMPLETE_REPORTS_REQUIRED_BEFORE_ACCEPTANCE');
      const selected = protocol.rule.table.find(r => r.reports.every((t, i) => t === state.reports[i]))!;
      if (observed.reportEventId !== state.reportEventIds[party.id] || observed.outcomeId !== selected.outcomeId ||
        observed.scheduleDigest !== r3Digest(selected.schedule) || Date.parse(observed.observedAt) < Date.parse(state.closedAt!))
        throw Error('R3_ACCEPTANCE_EXACT_REPORT_OUTCOME_SCHEDULE_AND_TIME_REQUIRED');
    } else if (observed.scheduleDigest !== null || observed.outcomeId !== null) throw Error('R3_NO_AGREEMENT_EVENT_CANNOT_ATTEST_SCHEDULE');
    const events = await r3Events(ctx, row, c), requestDigest = r3Digest(input), prior = events.find(e => e.body.detail.idempotencyKey === input.idempotencyKey && e.body.principalId === principal(ctx));
    if (prior) {
      if (prior.body.detail.requestDigest !== requestDigest) throw Error('R3_EVENT_IDEMPOTENCY_CONFLICT');
      return { eventId: prior.event_id, semanticReplay: true, agreementEstablished: false };
    }
    const event = await r3Event(ctx, row, input.kind, { ...input, requestDigest, observed,
      observationRef: { owner: 'S1', id: source.id, version: 'evidence-source-version-v1', contentDigest: source.content_hash },
      originalSourceId: source.source_id, agreementsAndLiabilitiesRetained: true }, c);
    await revision(c, row, `r3:acceptance:${row.id}:${party.id}`);
    const dependencies=await revisions(ctx,[`evidence:${source.source_id}`,`source-version:${source.id}`],c,true);
    for(const d of dependencies)await c.query('INSERT INTO finnor_os.r3_dependencies(tenant_id,request_id,key,revision) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,request_id,key) DO NOTHING',
      [row.tenant_id,row.id,d.key,d.revision]);
    if (input.kind === 'OUT_OF_DOMAIN') await c.query("UPDATE finnor_os.r3_requests SET status='INVALIDATED',generation=generation+1,failure='R3_BEHAVIORAL_APPLICABILITY_REFUTED_HISTORY_AND_LIABILITIES_RETAINED' WHERE tenant_id=$1 AND id=$2", [row.tenant_id, row.id]);
    return { eventId: event.eventId, semanticReplay: false, agreementEstablished: false,
      basis: observed.basis, executionAuthorityGranted: false, responsibilitiesRetained: true };
  });
}
export async function currentR3Reports(ctx: PeMutationContext, row: R3RequestRow, c?: PoolClient) {
  const events = await r3Events(ctx, row, c), reportEventIds: Record<string, string> = {}, reports: string[] = [];
  let noAgreement = false;
  const accepted: string[] = [], refs: string[] = [];
  for (const party of row.problem.parties) {
    const latest = events.filter(e => e.kind === 'REPORT' && e.body.detail.partyId === party.id).at(-1);
    if (latest) { reportEventIds[party.id] = latest.event_id; reports.push(latest.body.detail.typeId); refs.push(latest.event_id) }
    else reports.push('');
    const terminal = events.filter(e => ['DECLINE', 'NO_RESPONSE', 'OUT_OF_DOMAIN'].includes(e.kind) && e.body.detail.partyId === party.id);
    if (terminal.length) noAgreement = true;
    const acceptance = events.filter(e => e.kind === 'OBSERVED_ACCEPTANCE' && e.body.detail.partyId === party.id &&
      e.body.detail.observed.reportEventId === latest?.event_id).at(-1);
    if (acceptance) { accepted.push(party.id); refs.push(acceptance.event_id) }
  }
  const closed = events.find(e => e.event_id === row.closed_event_id);
  if (closed?.body.detail.disposition === 'NO_AGREEMENT') noAgreement = true;
  return { reports, reportEventIds, refs, closed: Boolean(closed), closedAt: closed?.body.at ?? null,
    complete: reports.every(Boolean), noAgreement, acceptanceComplete: !noAgreement && accepted.length === row.problem.parties.length,
    acceptedParties: accepted, reportIsAgreement: false, qualifiedAgreementEstablished: false };
}

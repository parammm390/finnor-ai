/** Concrete S3 exact-model and S4 canonical-decision consumers.
 * An exact relation is not coerced into a learned causal intervention model. */
import type { PoolClient } from 'pg';
import type { ExperimentRef } from '@finnor/shared-types';
import type { PeMutationContext } from '../../types';
import { authorize, principal } from '../../owner-context';
import { recordDecisionTx, finalizeDecisionTx } from '../../world-repository';
import { enqueueOwnerDeliveryInTransaction } from '../../../../governed-execution/src/owner-delivery-store';
import { canonicalRelation, compare, numeric, quantity, qadd, qtext } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/relational.js';
import { digest, stable, requireZ1, type WorkProjection } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts.js';
import { nativeRef, same, type NativeRow } from './native-contracts.js';
import { artifactTx, eventTx } from './native-store.js';
import type { NativeOwnerReceipt, PublishedProgram } from './owner.js';

export async function consumeOriginalOwnerTx(ctx: PeMutationContext, c: PoolClient, row: NativeRow,
  publication: PublishedProgram, projection: WorkProjection): Promise<NativeOwnerReceipt> {
  const cut = row.cuts.find(item => item.workId === projection.workId);
  requireZ1(cut && projection.result && projection.lifecycle === 'ACTIVE', 'Z1_CURRENT_ORIGINAL_OWNER_INPUT_REQUIRED');
  const prior = (await c.query<{ receipt: NativeOwnerReceipt }>(
    'SELECT receipt FROM finnor_os.z1_owner_uses WHERE tenant_id=$1 AND principal_id=$2 AND publication_id=$3 AND work_id=$4',
    [ctx.auth.tenantId, principal(ctx), publication.reference.id, projection.workId])).rows[0];
  if (prior) {
    requireZ1(prior.receipt.resultDigest === digest(projection.result) && same(prior.receipt.artifactRef, publication.reference),
      'Z1_ORIGINAL_OWNER_REPLAY_CONFLICT'); return prior.receipt;
  }
  const relation = canonicalRelation(structuredClone(projection.result));
  requireZ1(same(relation, projection.result), 'Z1_EXACT_ORIGINAL_RELATION_REQUIRED', 'COUNTEREXAMPLE');
  const common = { tenantId: ctx.auth.tenantId, principalId: principal(ctx), originalWorkId: projection.workId,
    originalInputId: cut.inputId, parentReservationRef: cut.parent, publicationRef: publication.reference,
    independentCheckRef: publication.body.envelope.checkerIdentityAndResultReferences.resultReference,
    originalBindingDigest: projection.bindingDigest, resultDigest: digest(relation),
    claim: 'EXACT_CONDITIONAL_DERIVATION_NOT_OBSERVED_BUSINESS_OR_CAUSAL_IDENTIFICATION',
    observation: 'UNKNOWN', unresolvedObligationRefs: projection.unresolvedObligationRefs,
    businessCompletionGranted: false, protectedAdmission: false, executionAuthorityGranted: false };
  let body: Record<string, unknown>, nativeResultRef: ExperimentRef;
  if (cut.consumer.owner === 'S3') {
    const field = cut.consumer.measureField, type = relation.columns[field];
    requireZ1(type && numeric(type), 'Z1_S3_REGISTERED_EXACT_MODEL_MEASURE_REQUIRED');
    let total = quantity('0');
    for (const observation of relation.rows) {
      const value = observation[field];
      requireZ1(typeof value === 'string', 'Z1_S3_EXACT_MODEL_VALUE_REQUIRED');
      total = qadd(total, quantity(value));
    }
    body = { schema: 'finnor.s3.original-exact-relational-model.v1', ...common, relation,
      analyticalUse: { kind: 'EXACT_FINANCIAL_MEASURE_OVER_ORIGINAL_RELATION', field, type,
        value: qtext(total), originalRowsActuallyRead: relation.rows.length, bagMultiplicityPreserved: true },
      conditioning: { originalProgramme: projection.binding.original.programme,
        originalParameters: projection.binding.original.parameters, originalSources: projection.binding.sources },
      learnedTransitionLaw: false, modelActuallyResolved: true, originalResultActuallyUsed: true };
    nativeResultRef = await artifactTx(ctx, c, row.id, 'S3', 'z1-original-exact-model', body);
  } else {
    const consumer = cut.consumer, type = relation.columns[consumer.valueField], action = relation.columns[consumer.actionField];
    requireZ1(type && ['integer', 'rational'].includes(type.kind) && action?.kind === 'text',
      'Z1_S4_REGISTERED_EXACT_CHOICE_TYPE_REQUIRED');
    await authorize(ctx, row.root, [{ type: 'work', id: projection.workId },
      { type: 'pe_investment_case', id: consumer.investmentCaseId }], [], c);
    requireZ1((await c.query(
      'SELECT id FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND id=$2 AND deal_id=$3 FOR SHARE',
      [ctx.auth.tenantId, consumer.investmentCaseId, row.root.entityId])).rows[0], 'Z1_ORIGINAL_S4_ROOT_CASE_REQUIRED', 'REVOKED');
    const candidates = [...relation.rows].sort((a, b) => {
      const cmp = compare(a[consumer.valueField]!, b[consumer.valueField]!, type);
      if (cmp) return consumer.direction === 'MAXIMIZE' ? -cmp : cmp;
      const left = stable(a), right = stable(b); return left < right ? -1 : left > right ? 1 : 0;
    });
    const selected = projection.unresolvedObligationRefs.length ? null : candidates[0] ?? null;
    const choice = selected ? String(selected[consumer.actionField]) :
      projection.unresolvedObligationRefs.length ? 'WAIT_ORIGINAL_S6_RECONCILIATION' : 'WAIT_NO_ELIGIBLE_ORIGINAL_RESULT';
    const decision = await recordDecisionTx(c, ctx, { dealId: row.root.entityId, investmentCaseId: consumer.investmentCaseId,
      decisionType: consumer.decisionType, title: consumer.title, decision: choice,
      rationale: JSON.stringify({ ...common, choiceRule: consumer, selected, conditionalDevelopmentDecisionOnly: true }) });
    await finalizeDecisionTx(c, ctx, { decisionId: String(decision.row.id), expectedVersion: Number(decision.row.version),
      decidedBy: { partyType: 'employee', partyId: principal(ctx) } });
    body = { schema: 'finnor.s4.original-exact-choice.v1', ...common, decisionId: String(decision.row.id),
      choice, selected, choiceRule: consumer, modelActuallyResolved: true, originalResultActuallyUsed: true,
      effectPrepared: false, executableHandoffCreated: false, counterfactualEconomicValueClaimed: false };
    nativeResultRef = await artifactTx(ctx, c, row.id, 'S4', 'z1-original-exact-choice', body);
  }
  const receipt: NativeOwnerReceipt = { owner: cut.consumer.owner, workId: projection.workId,
    originalParentReservationRef: cut.parent.id, artifactRef: publication.reference,
    resultDigest: digest(projection.result), nativeResultRef, observation: 'UNKNOWN',
    unresolvedObligationRefs: projection.unresolvedObligationRefs, executionAuthorityGranted: false };
  await c.query('INSERT INTO finnor_os.z1_owner_uses(tenant_id,principal_id,request_id,publication_id,work_id,semantic_owner,reference,body,receipt) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb)',
    [ctx.auth.tenantId, principal(ctx), row.id, publication.reference.id, projection.workId, receipt.owner,
      JSON.stringify(nativeResultRef), JSON.stringify(body), JSON.stringify(receipt)]);
  await enqueueOwnerDeliveryInTransaction(c, { semanticOwner: receipt.owner, tenantId: ctx.auth.tenantId, principalId: principal(ctx) },
    { kind: 'REFERENCE', identity: nativeResultRef.id, payload: { reference: { ...nativeResultRef, content: body }, rightsRefs: [row.rights_revision] } });
  await eventTx(ctx, c, row.id, null, `owner:${digest([publication.reference, projection.workId])}`,
    { kind: 'ORIGINAL_NATIVE_OWNER_CONSUMED', receipt, businessCompletionGranted: false });
  return receipt;
}

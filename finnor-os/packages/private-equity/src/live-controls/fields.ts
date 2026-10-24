import type { PoolClient } from 'pg';
import { canExerciseAuthorityTx } from '@finnor/authority';
import type { PeMutationContext } from '../types';
import type { UnderwritingModelIR, UnderwritingInputSnapshot } from '@finnor/underwriting';
import { actor, authorizeResourcesTx, canonicalObjectTx, intentResourcesTx, investmentAnchorTx, type SessionRow } from './store';
/** Descriptors come from the actual current native model and original base run,
 * not a browser preset or a newly invented financial assumption. */
export async function controlFieldsTx(ctx: PeMutationContext, session: SessionRow, client: PoolClient) {
  const focus = await canonicalObjectTx(ctx, session.focus, client);
  const investmentCaseId = session.focus.type === 'pe_investment_case' ? session.focus.id
    : typeof focus.raw.investment_case_id === 'string' ? focus.raw.investment_case_id : null;
  const grantRows = (await client.query<{ certificate: any }>(`SELECT p.certificate FROM finnor_os.s5_proposals p
    JOIN finnor_os.s5_reservations r ON r.tenant_id=p.tenant_id AND r.allocation_digest=p.content_digest
    WHERE p.tenant_id=$1 AND p.principal_id=$2 AND r.status<>'RELEASED' AND r.revocation_reason IS NULL
      AND (p.certificate->>'validUntil')::timestamptz>clock_timestamp()
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(r.envelopes) e
        WHERE e->>'unit'='native-attempt' AND e->>'kind'='CUMULATIVE_EXPENDITURE')
    ORDER BY p.created_at DESC LIMIT 16`, [ctx.auth.tenantId, actor(ctx)])).rows;
  const consequenceGrants = grantRows.flatMap(({ certificate }) => certificate.policyBindings.map((binding: any) => ({
    allocationRef: certificate.ref, policyRef: binding.policyRef, programmeRef: null,
    qualification: 'ORIGINAL_ORDINARY_S5_ENVELOPE_CURRENTNESS_RECHECK_REQUIRED_NOT_DOLLARS',
  })));
  if (!investmentCaseId) return { underwriting: null, consequenceGrants, unsupported: 'NO_NATIVE_FINANCIAL_MODEL_BOUND_TO_THIS_FOCUS' };
  const investment = await canonicalObjectTx(ctx, { type: 'pe_investment_case', id: investmentCaseId }, client);
  const anchor = await investmentAnchorTx(ctx, investment, client);
  const base = (await client.query<{ id: string; model_version_id: string; world_at: Date }>(
    `SELECT id,model_version_id,world_at FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND investment_case_id=$2
      AND scenario_id IS NULL AND status='SUCCEEDED' ORDER BY computed_at DESC,id DESC LIMIT 1`,
    [ctx.auth.tenantId, investmentCaseId])).rows[0];
  if (!base || !await canExerciseAuthorityTx(ctx.auth, { operation: 'query', capability: 'query:pe_world_state',
    resource: { type: 'underwriting_run', id: base.id }, risk: 'low' }, client))
    return { underwriting: null, consequenceGrants, unsupported: 'PERMITTED_NATIVE_BASE_RUN_REQUIRED' };
  await authorizeResourcesTx(ctx, [{ type: 'underwriting_model_version', id: base.model_version_id }], client);
  const model = await canonicalObjectTx(ctx, { type: 'underwriting_model_version', id: base.model_version_id }, client);
  const original = await canonicalObjectTx(ctx, { type: 'underwriting_run', id: base.id }, client);
  const definition = model.raw.model_definition as UnderwritingModelIR;
  const snapshot = original.raw.input_snapshot as UnderwritingInputSnapshot;
  const fields: unknown[] = [];
  let authorizedClosure = false;
  for (const node of definition.nodes.filter(n => n.kind === 'input').slice(0, 100)) {
    if (node.kind !== 'input' || !['money', 'rate', 'multiple', 'ratio', 'count', 'period'].includes(node.unit)) continue;
    const quantity = node.unit === 'money' && node.evidenceSemantics ? {
      semantics: node.evidenceSemantics, legalEntityRef: { type: 'external_organization' as const, id: String(anchor.raw.target_organization_id) },
      ownerShare: { numerator: '1', denominator: '1' }, valuationAt: base.world_at.toISOString(), rounding: 'EXACT_NO_EXECUTION_ROUNDING' as const,
    } : null;
    if (node.unit === 'money' && !quantity) continue;
    const observed = snapshot.values[node.id]?.value;
    if (typeof observed !== 'string' && typeof observed !== 'object') continue;
    try {
      if (!authorizedClosure) {
        await intentResourcesTx(ctx, session, { kind: 'UNDERWRITING_ASSUMPTIONS', investmentCaseId,
          modelVersionId: base.model_version_id, baseRunId: base.id, worldAt: base.world_at.toISOString(), name: 'Descriptor authorization',
          overrides: [{ nodeId: node.id, value: observed as string | Record<string, string>, unit: node.unit,
            currency: node.currency ?? null, quantityContext: quantity, reason: 'Native descriptor authorization only, no scenario accepted' }] }, client);
        authorizedClosure = true;
      }
    } catch { break; } // The model/base source closure is common to every input.
    fields.push({ nodeId: node.id, label: node.label ?? node.id, value: observed, unit: node.unit,
      currency: node.currency ?? null, quantityContext: quantity });
  }
  return { underwriting: { investmentCaseId, modelVersionId: base.model_version_id, baseRunId: base.id,
    worldAt: base.world_at.toISOString(), fields }, consequenceGrants, unsupported: fields.length ? null : 'NO_PERMITTED_TYPED_NATIVE_INPUTS' };
}

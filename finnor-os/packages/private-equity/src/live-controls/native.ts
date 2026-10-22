import type { PoolClient } from 'pg';
import type { PeMutationContext } from '../types';
import { PRIVATE_EQUITY_ACTION_SCHEMAS } from '../../../domain-plugins/private-equity/schemas';
import { compileUnderwritingModel, applyScenario, executeUnderwritingModel, inputSnapshotHash, runResultHash,
  type UnderwritingModelIR, type UnderwritingInputSnapshot, type UnderwritingRunResult } from '@finnor/underwriting';
import { affectedClosure } from '../live-recompilation/contracts';
import { constrainEnterpriseAllocationSelection, previewEnterprisePortfolio } from '../enterprise-allocation';
import { readEnterpriseDurableObligation } from '../enterprise-obligations';
import { LiveControlError, allocationInput, type ControlConsequence, type ControlIntent } from './contracts';
import { actor, assertActorActionTx, canonicalObjectTx, digest, intentResourcesTx, investmentAnchorTx, type BranchRow, type SessionRow } from './store';

const professionalActions = new Set(['verify_closing_item', 'waive_closing_condition', 'declare_deal_closed']);
export const humanDecisionActions = new Set([...professionalActions, 'record_ic_vote', 'cast_ic_vote',
  'approve_ic_decision_proposal', 'finalize_ic_decision']);
export async function assertNativeIntent(ctx: PeMutationContext, session: SessionRow, intent: ControlIntent, client: PoolClient) {
  if (intent.kind === 'NATIVE_ACTION') {
    const schema = PRIVATE_EQUITY_ACTION_SCHEMAS[intent.actionType as keyof typeof PRIVATE_EQUITY_ACTION_SCHEMAS];
    if (!schema) throw new LiveControlError('UNSUPPORTED_NATIVE_OPERATION', 'No installed native operation schema supports this action');
    schema.parse(intent.payload);
    if (professionalActions.has(intent.actionType) || intent.professionalAuthorityRef)
      throw new LiveControlError('QUALIFIED_PROFESSIONAL_OWNER_PORT_UNAVAILABLE', 'An actual qualified V3 professional determination is required. A session cannot supply it');
    if (humanDecisionActions.has(intent.actionType)) await assertActorActionTx(ctx, { operation: 'action',
      capability: 'action:' + intent.actionType, resources: [{ type: session.root.entityType, id: session.root.entityId }], risk: 'high' }, client, true);
    if (intent.payload.verifierEmployeeId && intent.payload.verifierEmployeeId !== actor(ctx)) throw unavailableActor();
  } else if (intent.kind === 'UNDERWRITING_ASSUMPTIONS') {
    const model = await canonicalObjectTx(ctx, { type: 'underwriting_model_version', id: intent.modelVersionId }, client);
    const definition = model.raw.model_definition as UnderwritingModelIR;
    const compiled = compileUnderwritingModel(definition);
    const investment = await canonicalObjectTx(ctx, { type: 'pe_investment_case', id: intent.investmentCaseId }, client);
    const anchor = await investmentAnchorTx(ctx, investment, client);
    for (const edit of intent.overrides) {
      const node = compiled.nodeById[edit.nodeId];
      if (!node || node.kind !== 'input' || node.unit !== edit.unit || (node.currency ?? null) !== edit.currency)
        throw new LiveControlError('UNSUPPORTED_FIELD_OR_UNIT', 'Only the exact installed native InputNode and unit can be proposed');
      if (edit.unit === 'money') {
        const quantity = edit.quantityContext!;
        if (!node.evidenceSemantics || digest(node.evidenceSemantics) !== digest(quantity.semantics)
          || quantity.legalEntityRef.type !== 'external_organization' || quantity.legalEntityRef.id !== anchor.raw.target_organization_id
          || quantity.semantics.entityId !== quantity.legalEntityRef.id || quantity.semantics.entityType !== quantity.legalEntityRef.type
          || quantity.semantics.unit !== 'currency' || quantity.semantics.currencyCode !== node.currency
          || quantity.ownerShare.numerator !== '1' || quantity.ownerShare.denominator !== '1'
          || quantity.semantics.scale !== '1' || quantity.semantics.sign !== 'AS_RECORDED'
          || Date.parse(quantity.valuationAt) !== Date.parse(intent.worldAt))
          throw new LiveControlError('QUANTITY_OWNER_POLICY_UNAVAILABLE', 'Exact full-entity, native-scale financial semantics are required. Ownership, FX or scale conversions are not inferred');
      }
    }
  } else if (intent.kind === 'S5_ALLOCATION') {
    const request = constrainEnterpriseAllocationSelection(ctx, allocationInput(intent.request), intent.selectedPolicyIds);
    const mandate = request.mandate as { horizon: { startAt: string; periodMs: number; periods: number } };
    const quantity = intent.quantityContext;
    if (quantity.ownerShare.numerator !== '1' || quantity.ownerShare.denominator !== '1'
      || quantity.semantics.unit !== 'currency' || quantity.semantics.currencyCode !== 'USD'
      || quantity.semantics.scale !== '1' || quantity.semantics.sign !== 'AS_RECORDED'
      || quantity.semantics.entityType !== quantity.legalEntityRef.type || quantity.semantics.entityId !== quantity.legalEntityRef.id
      || Date.parse(quantity.semantics.periodStart) !== Date.parse(mandate.horizon.startAt)
      || Date.parse(quantity.semantics.periodEnd) !== Date.parse(mandate.horizon.startAt) + mandate.horizon.periodMs * mandate.horizon.periods)
      throw new LiveControlError('ALLOCATION_QUANTITY_POLICY_UNAVAILABLE', 'The native allocation supports explicit whole-entity USD over its exact horizon, without ownership/FX/scale inference');
    const resources = (await client.query('SELECT r.body FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1',
      [ctx.auth.tenantId])).rows.map(row => row.body);
    if (resources.filter(row => row.currency === 'USD').some(row => row.legalEntityRef.id !== quantity.legalEntityRef.id
      || Date.parse(row.asOf) !== Date.parse(quantity.valuationAt))) throw new LiveControlError('QUANTITY_AS_OF_OR_ENTITY_MISMATCH', 'Quantity context differs from the actual resource owner basis');
  }
  await intentResourcesTx(ctx, session, intent, client);
}
const unavailableActor = () => new LiveControlError('ACTOR_IMPERSONATION_DENIED', 'The actual actor cannot be replaced by an input employee ID', 403);
export async function nativeRequest(ctx: PeMutationContext, session: SessionRow, branch: BranchRow, client: PoolClient): Promise<Record<string, unknown>> {
  const intent = branch.intent;
  if (intent.kind === 'S5_ALLOCATION') {
    const request = constrainEnterpriseAllocationSelection(ctx, { ...allocationInput(intent.request), idempotencyKey: 'v5-dispatch:' + branch.id }, intent.selectedPolicyIds);
    const refs = (await client.query('SELECT r.body->\'ref\' ref FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision) WHERE r.tenant_id=$1 ORDER BY r.resource_id',
      [ctx.auth.tenantId])).rows.map(row => row.ref);
    return { kind: 'S5_ALLOCATION', request: { ...request, resourceRefs: refs } };
  }
  if (intent.kind === 'GOVERNED_REQUEST') return { kind: intent.kind, execution: intent.execution };
  const actionType = intent.kind === 'UNDERWRITING_ASSUMPTIONS' ? 'create_underwriting_run' : intent.actionType;
  const investment = intent.kind === 'UNDERWRITING_ASSUMPTIONS'
    ? await canonicalObjectTx(ctx, { type: 'pe_investment_case', id: intent.investmentCaseId }, client) : null;
  if (investment && typeof investment.raw.deal_id !== 'string')
    throw new LiveControlError('NATIVE_ACTION_REQUIRES_PROMOTED_DEAL', 'The installed consequential action requires the actual promoted signed-LOI Deal. A pre-LOI scenario grants no transition authority');
  const payload = intent.kind === 'UNDERWRITING_ASSUMPTIONS' ? {
    dealId: investment!.raw.deal_id, investmentCaseId: intent.investmentCaseId, modelVersionId: intent.modelVersionId,
    baseRunId: intent.baseRunId, scenario: { name: intent.name, overrides: intent.overrides.map(({ nodeId, value, reason }) => ({ nodeId, value, reason })) },
  } : intent.payload;
  const schema = PRIVATE_EQUITY_ACTION_SCHEMAS[actionType as keyof typeof PRIVATE_EQUITY_ACTION_SCHEMAS];
  if (!schema) throw new LiveControlError('UNSUPPORTED_NATIVE_OPERATION', 'No native schema supports the exact action');
  return { kind: 'NATIVE_ACTION', actionType, payload: schema.parse(payload) };
}

/** Calls installed producers, never a financial mutation during evaluation. */
export async function nativeConsequence(ctx: PeMutationContext, session: SessionRow, branch: BranchRow): Promise<Omit<ControlConsequence, 'costs'>> {
  const intent = branch.intent;
  const base = { refs: [] as unknown[], modelRelative: true as const, reservesCapital: false as const, executionAuthorityGranted: false as const };
  if (intent.kind === 'S5_ALLOCATION') {
    const result = await previewEnterprisePortfolio(ctx, allocationInput(intent.request), intent.selectedPolicyIds);
    return { ...base, owner: 'S4/S5', status: result.status, result, materialGaps: result.materialGaps,
      coverage: ['EXACT_SELECTED_FINITE_JOINT_RESOURCE_AND_COVENANT_CONSTRAINTS', 'NO_RESERVATION_NO_OPTIMUM_CLAIM'] };
  }
  if (intent.kind === 'UNDERWRITING_ASSUMPTIONS') {
    const { peClientTransaction } = await import('../repository');
    const native = await peClientTransaction(ctx, async client => {
      await assertNativeIntent(ctx, session, intent, client);
      const model = await canonicalObjectTx(ctx, { type: 'underwriting_model_version', id: intent.modelVersionId }, client);
      const run = await canonicalObjectTx(ctx, { type: 'underwriting_run', id: intent.baseRunId }, client);
      const definition = model.raw.model_definition as UnderwritingModelIR, compiled = compileUnderwritingModel(definition);
      const input = run.raw.input_snapshot as UnderwritingInputSnapshot, prior = run.raw.result as UnderwritingRunResult;
      const { refuseUnadmittedConfidentialSink } = await import('../confidential-computation/consumer');
      refuseUnadmittedConfidentialSink(input);
      if (input.semanticHash !== run.raw.input_hash || inputSnapshotHash(input) !== run.raw.input_hash
        || runResultHash(prior) !== run.raw.result_hash || compiled.semanticHash !== model.raw.semantic_hash)
        throw new LiveControlError('NATIVE_OWNER_INTEGRITY_FAILED', 'Native model/input/result preimages do not match');
      const scenario = { schemaVersion: 'underwriting-scenario.v1' as const, name: intent.name,
        overrides: intent.overrides.map(({ nodeId, value, reason }) => ({ nodeId, value, reason })) };
      const graph = compiled.model.nodes.map(node => ({ id: node.id, dependsOn: [...compiled.dependencyGraph[node.id]!] }));
      const closure = affectedClosure(graph, scenario.overrides.map(item => item.nodeId));
      const applied = applyScenario(compiled, input, scenario), result = executeUnderwritingModel(compiled, input, scenario);
      const { assertEvidenceSnapshotCurrent } = await import('../evidence-execution/consumer');
      await assertEvidenceSnapshotCurrent(ctx, input, client);
      return { modelVersionId: intent.modelVersionId, baseRunId: intent.baseRunId, modelHash: compiled.semanticHash,
        inputHash: inputSnapshotHash(input), scenarioHash: applied.scenarioSemanticHash,
        result, affectedNodeIds: closure.affectedNodes.map(node => node.id), keptNodeIds: closure.keptNodes.map(node => node.id),
        dependencyOwner: 'P7', sourceContraryOverrides: scenario.overrides, observedSourcesChanged: false,
        sourceRefs: branch.resources, originalWorldAt: intent.worldAt };
    }, { isolation: 'repeatable read' });
    return { ...base, owner: 'Underwriting', status: native.result.status === 'SUCCEEDED' && native.result.validity === 'VALID' ? 'COMPLETE' : 'PARTIAL',
      result: native, materialGaps: ['MODEL_CONDITIONAL_NOT_OBSERVED_VALUE', 'LEGAL_SETTLEMENT_AND_OWNER_VALUE_UNESTABLISHED'],
      coverage: ['INSTALLED_NATIVE_UNDERWRITING_MODEL', 'P7_FULL_FINITE_AFFECTED_NODE_CLOSURE', 'EXACT_PINNED_INPUT_SCENARIO'] };
  }
  if (intent.kind === 'GOVERNED_REQUEST') {
    const obligation = await readEnterpriseDurableObligation(ctx, intent.execution.request.ir.obligationRef);
    return { ...base, owner: 'Core/S6', status: 'PARTIAL', refs: [obligation.ref, intent.execution.request.ref],
      result: { obligationRef: obligation.ref, effectRef: obligation.effectRef, resourceEnvelope: obligation.resourceEnvelope,
        deadline: obligation.deadline, protectedSignatureNotReplaced: true },
      materialGaps: ['PROTECTED_REQUEST_ADMISSION_AND_CURRENT_OWNER_SIGNATURE_RECHECK_AT_S6', 'INDEPENDENT_SETTLEMENT_NOT_YET_OBSERVED'],
      coverage: ['ORIGINAL_NATIVE_OBLIGATION_BINDING', 'NO_DISPATCH_NO_FINANCIAL_CREDIT'] };
  }
  return { ...base, owner: 'Core/S6', status: 'PARTIAL', result: { actionType: intent.actionType,
    exactSchemaChecked: true, expectedVersion: intent.payload.expectedVersion ?? intent.payload.expectedCaseVersion ?? null,
    valueForecast: null }, materialGaps: ['NO_INSTALLED_VALUE_CONSEQUENCE_MODEL_FOR_THIS_OPERATION', 'NATIVE_STATE_MACHINE_AND_EFFECT_RECHECK_REQUIRED'],
    coverage: ['INSTALLED_TYPED_OPERATION_SCHEMA', 'PERMITTED_CURRENT_CANONICAL_CONTEXT', 'NO_FABRICATED_FORECAST'] };
}

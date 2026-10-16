import type { PoolClient } from 'pg';
import type { AuthorityRequest, TenantContext } from '@finnor/shared-types';
import { canExerciseAuthorityTx, employeeAuthoritySnapshotTx, lockCurrentAuthorityTx } from '@finnor/authority';
import { assertDeliverySessionTx } from '@finnor/security';
import { epistemicHash } from '@finnor/epistemic-runtime';
import { peClientTransaction } from '../repository';
import { PeDomainError, type PeMutationContext, type PeWorldRootRef } from '../types';
import { authorizeBeliefSourceScopes } from '../enterprise-beliefs';
import { ControlIntentSchema, LiveControlError, unavailable, type ConsequenceGrant, type ControlIntent, type ControlObjectRef, type OwnerVector } from './contracts';

export const actor = (ctx: PeMutationContext) => ctx.auth.employeeId ?? ctx.auth.userId;
export const digest = epistemicHash;
export function sharedControlIntent(intent: ControlIntent): unknown {
  if (intent.kind === 'S5_ALLOCATION') return { kind: intent.kind, quantityContext: intent.quantityContext,
    policy: 'EXACT_NATIVE_REQUEST_CUSTODY_RETAINED_BY_AUTHOR' };
  if (intent.kind === 'GOVERNED_REQUEST') return { kind: intent.kind, protectedRequestBytes: 'PRINCIPAL_PRIVATE' };
  return intent;
}
/** Reading the recorded owner's proof is not an effect or act_as permission.
 * The caller's RLS/resource checks precede this private, non-publishing read.
 * Restore the real recipient before any authority decision or mutation. */
export async function recordedOwnerProofTx<T>(principalId: string, client: PoolClient, read: () => Promise<T>): Promise<T> {
  const previous = (await client.query<{ id: string }>("SELECT current_setting('app.user_id',true) id")).rows[0]!.id;
  try {
    await client.query("SELECT set_config('app.user_id',$1,true)", [principalId]);
    return await read();
  } finally { await client.query("SELECT set_config('app.user_id',$1,true)", [previous ?? '']); }
}
export interface SessionRow { id: string; tenant_id: string; work_id: string; root: { entityType: string; entityId: string }; focus: ControlObjectRef }
export interface BranchRow { id: string; tenant_id: string; session_id: string; principal_id: string; parent_id: string | null;
  visibility: 'PRIVATE' | 'SHARED'; intent: ControlIntent; owner_vector: OwnerVector; resources: Resource[];
  consequence_grant: ConsequenceGrant | null; intent_digest: string; created_at: Date }
export interface EvaluationRow { id: string; tenant_id: string; session_id: string; principal_id: string; branch_id: string;
  status: string; owner_vector: OwnerVector; result: import('./contracts').ControlConsequence | null; charged: boolean;
  claim_token: string | null; claim_fence: string | null; job_id: string | null; cost_refs: unknown[]; request_digest: string;
  original_budget: import('./budget').OriginalControlBudget | null; delivery_session_id: string }
export interface ProposalRow { id: string; tenant_id: string; session_id: string; principal_id: string; branch_id: string;
  evaluation_id: string; proposal_digest: string; request_digest: string; owner_vector: OwnerVector;
  native_request: Record<string, unknown>; authority_request: AuthorityRequest; expires_at: Date }
export interface Resource { type: string; id: string }
const identifiers = /^[a-z][a-z0-9_]{0,62}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// A focused object is not permission to expose embedded Work, conversation,
// memory, source payloads, compiler traces or principal-private derivatives.
const focusedFields = ['id', 'version', 'status', 'stage', 'name', 'title', 'description', 'summary',
  'deal_id', 'opportunity_id', 'investment_case_id', 'target_organization_id', 'workstream_id', 'request_id', 'ic_case_id',
  'condition_id', 'closing_condition_id', 'model_version_id', 'scenario_id', 'work_id',
  'amount', 'amount_usd', 'currency', 'currency_code', 'price', 'target_amount', 'priority', 'due_at',
  'condition_type', 'verification_status', 'valid_from', 'valid_to', 'world_at', 'created_at', 'updated_at'];

export function uniqueResources(resources: Resource[]): Resource[] {
  return [...new Map(resources.map(ref => [`${ref.type}:${ref.id}`, ref])).values()]
    .sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`));
}
export async function authorizeResourcesTx(ctx: PeMutationContext, resources: Resource[], client: PoolClient) {
  if (!resources.length || resources.length > 512) throw unavailable();
  for (const resource of uniqueResources(resources)) {
    if (resource.type === 'p4_derivation' && !(await client.query(
      'SELECT id FROM finnor_os.p4_derivations WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
      [ctx.auth.tenantId, actor(ctx), resource.id])).rowCount) throw unavailable();
    if (!await canExerciseAuthorityTx(ctx.auth, {
    operation: 'query', capability: resource.type === 'allocation_resource' ? 'query:allocation_resources' : 'query:pe_world_state',
    resource, risk: 'low',
    }, client)) throw unavailable();
  }
}

export async function controlTransaction<T>(ctx: PeMutationContext, fn: (client: PoolClient) => Promise<T>,
  options: { coherent?: boolean; financialFence?: boolean; registerDelivery?: boolean; worker?: boolean } = {}): Promise<T> {
  return peClientTransaction(ctx, async client => {
    if (options.financialFence) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['s5-portfolio:' + ctx.auth.tenantId]);
    await lockCurrentAuthorityTx(ctx.auth, client);
    if (!options.worker) await assertDeliverySessionTx(ctx.auth, client, options.registerDelivery);
    const result = await fn(client);
    // Serialize a response while the actual principal/revision/session fences
    // are held. Transport cannot strengthen this to wire-spanning revocation.
    if (!options.worker) {
      await employeeAuthoritySnapshotTx(ctx.auth, client);
      await assertDeliverySessionTx(ctx.auth, client);
    }
    return result;
  }, { isolation: options.coherent ? 'repeatable read' : 'read committed' });
}
export async function sessionRow(ctx: PeMutationContext, id: string, client: PoolClient): Promise<SessionRow> {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,5176))', ['v5-session:' + ctx.auth.tenantId + ':' + id]);
  const row = (await client.query<SessionRow>('SELECT * FROM finnor_os.v5_sessions WHERE tenant_id=$1 AND id=$2', [ctx.auth.tenantId, id])).rows[0];
  if (!row) throw unavailable();
  await authorizeResourcesTx(ctx, sessionResources(row), client);
  return row;
}
export const sessionResources = (session: SessionRow): Resource[] => [
  { type: 'work', id: session.work_id }, { type: session.root.entityType, id: session.root.entityId }, session.focus,
];
export async function branchRow(ctx: PeMutationContext, session: SessionRow, id: string, client: PoolClient): Promise<BranchRow> {
  const row = (await client.query<BranchRow>(`SELECT b.*,g.grant_body consequence_grant,finnor_os.v5_branch_visibility(b.id) current_visibility
    FROM finnor_os.v5_branches b LEFT JOIN finnor_os.v5_consequence_grants g ON g.tenant_id=b.tenant_id AND g.branch_id=b.id
    WHERE b.tenant_id=$1 AND b.session_id=$2 AND b.id=$3`,
    [ctx.auth.tenantId, session.id, id])).rows[0];
  if (!row || digest(row.intent) !== row.intent_digest) throw unavailable();
  row.visibility = (row as BranchRow & { current_visibility: BranchRow['visibility'] }).current_visibility;
  await authorizeResourcesTx(ctx, row.resources, client);
  await assertSourcePermissionsTx(ctx, session, row.resources, client);
  const original = await recordedOwnerProofTx(row.principal_id, client, async () => (await client.query(
    'SELECT intent,intent_digest,owner_vector FROM finnor_os.v5_branch_custody WHERE tenant_id=$1 AND branch_id=$2 AND principal_id=$3',
    [ctx.auth.tenantId, row.id, row.principal_id])).rows[0]);
  if (!original || digest(original.intent) !== original.intent_digest) throw unavailable();
  row.intent = ControlIntentSchema.parse(original.intent);
  row.intent_digest = original.intent_digest;
  row.owner_vector = original.owner_vector;
  return row;
}
export async function assertBranchUsableTx(ctx: PeMutationContext, branch: BranchRow, client: PoolClient) {
  if ((await client.query(`SELECT id FROM finnor_os.v5_history WHERE tenant_id=$1 AND branch_id=$2
    AND principal_id=$3 AND kind='WITHDRAWN' LIMIT 1`, [ctx.auth.tenantId, branch.id, branch.principal_id])).rowCount)
    throw new LiveControlError('WITHDRAWN_BRANCH', 'The original branch was withdrawn from future use', 409);
}
export async function proposalRow(ctx: PeMutationContext, session: SessionRow, id: string, client: PoolClient): Promise<ProposalRow> {
  const row = (await client.query<ProposalRow>('SELECT * FROM finnor_os.v5_proposals WHERE tenant_id=$1 AND session_id=$2 AND id=$3',
    [ctx.auth.tenantId, session.id, id])).rows[0];
  if (!row) throw unavailable();
  await branchRow(ctx, session, row.branch_id, client);
  const original = await recordedOwnerProofTx(row.principal_id, client, async () => (await client.query(
    'SELECT native_request,owner_vector,proposal_digest,request_digest FROM finnor_os.v5_proposal_custody WHERE tenant_id=$1 AND proposal_id=$2 AND principal_id=$3',
    [ctx.auth.tenantId, row.id, row.principal_id])).rows[0]);
  if (!original) throw unavailable();
  Object.assign(row, original);
  const body = { branchId: row.branch_id, evaluationId: row.evaluation_id, ownerVector: row.owner_vector,
    nativeRequest: row.native_request, authorityRequest: row.authority_request, expiresAt: row.expires_at.toISOString() };
  if (digest(body) !== row.proposal_digest || digest(row.native_request) !== row.request_digest) throw unavailable();
  return row;
}

/** Registry resolution preserves the exact UUID. A presentation ID is never
 * cast to another entity, and a missing owner is never replaced. */
export async function canonicalObjectTx(ctx: PeMutationContext, ref: Resource, client: PoolClient) {
  await authorizeResourcesTx(ctx, [ref], client);
  const registry = (await client.query<{ source_table: string; id_column: string; tenant_column: string; writable_owner: string }>(
    `SELECT source_table,id_column,tenant_column,writable_owner FROM finnor_os.canonical_truth_registry
      WHERE active AND entity_type=$1 AND (vertical_key IS NULL OR vertical_key='private_equity')`, [ref.type])).rows[0];
  if (!registry || ![registry.source_table, registry.id_column, registry.tenant_column].every(value => identifiers.test(value))) throw unavailable();
  const table = `"finnor_os"."${registry.source_table}"`, id = `"${registry.id_column}"`, tenant = `"${registry.tenant_column}"`;
  const raw = (await client.query<{ body: Record<string, unknown>; exact_json: string }>(
    `SELECT to_jsonb(r) body,to_jsonb(r)::text exact_json FROM ${table} r WHERE r.${tenant}=$1 AND r.${id}=$2`,
    [ctx.auth.tenantId, ref.id])).rows[0];
  if (!raw || Buffer.byteLength(raw.exact_json) > 2 * 1024 * 1024) throw unavailable();
  const foreign = (await client.query<{ column_name: string; entity_type: string }>(
    `SELECT a.attname column_name,registry.entity_type FROM pg_constraint k
      JOIN pg_class target ON target.oid=k.confrelid
      JOIN pg_namespace target_schema ON target_schema.oid=target.relnamespace
      JOIN LATERAL unnest(k.conkey,k.confkey) keys(source_number,target_number) ON true
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=keys.source_number
      JOIN pg_attribute target_id ON target_id.attrelid=k.confrelid AND target_id.attnum=keys.target_number
      JOIN finnor_os.canonical_truth_registry registry ON registry.source_table=target.relname
        AND registry.id_column=target_id.attname AND registry.active
      WHERE k.contype='f' AND k.conrelid=$1::regclass AND target_schema.nspname='finnor_os'`, [table])).rows;
  const omitted: string[] = [];
  for (const foreignRef of foreign) {
    const value = raw.body[foreignRef.column_name];
    if (typeof value !== 'string' || value === ctx.auth.tenantId || value === actor(ctx)) continue;
    if (!await canExerciseAuthorityTx(ctx.auth, { operation: 'query', capability: 'query:pe_world_state',
      resource: { type: foreignRef.entity_type, id: value }, risk: 'low' }, client)) omitted.push(foreignRef.column_name);
  }
  // PostgreSQL performs redaction on exact JSON tokens, not JS numeric values.
  const projected = (await client.query<{ exact_json: string }>(
    `SELECT (SELECT coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb) FROM jsonb_each(to_jsonb(r)) e
      WHERE e.key=ANY($3::text[]) AND NOT e.key=ANY($4::text[]))::text exact_json
      FROM ${table} r WHERE r.${tenant}=$1 AND r.${id}=$2`,
    [ctx.auth.tenantId, ref.id, focusedFields, omitted])).rows[0]!.exact_json;
  return { ref, owner: registry.writable_owner, version: String(raw.body.version ?? digest(projected)),
    revisionDigest: digest(projected), exactProjectionJson: projected, raw: raw.body,
    coverage: omitted.length ? 'PERMITTED_FIELDS_ONLY' : 'FOCUSED_OWNER_RECORD' };
}

/** Pre-LOI analysis stays anchored to its real Opportunity, never a fake Deal. */
export async function investmentAnchorTx(ctx: PeMutationContext,
  investment: Awaited<ReturnType<typeof canonicalObjectTx>>, client: PoolClient) {
  if (investment.ref.type !== 'pe_investment_case') throw unavailable();
  const ref = typeof investment.raw.deal_id === 'string' ? { type: 'pe_deal', id: investment.raw.deal_id }
    : typeof investment.raw.opportunity_id === 'string' ? { type: 'pe_opportunity', id: investment.raw.opportunity_id } : null;
  if (!ref) throw unavailable();
  return canonicalObjectTx(ctx, ref, client);
}

export async function assertSourcePermissionsTx(ctx: PeMutationContext, session: SessionRow, resources: Resource[], client: PoolClient) {
  const sourceIds = resources.filter(ref => ref.type === 'evidence_source').map(ref => ref.id);
  try { await authorizeBeliefSourceScopes(ctx,session.root as PeWorldRootRef,sourceIds,client); }
  catch(error){
    if(error instanceof PeDomainError&&error.code==='PE_ENTITY_NOT_FOUND')throw unavailable();
    throw error;
  }
}

const nativeIds: Record<string, string> = { dealId: 'pe_deal', investmentCaseId: 'pe_investment_case', modelVersionId: 'underwriting_model_version',
  baseRunId: 'underwriting_run', scenarioId: 'underwriting_scenario', workstreamId: 'pe_workstream', requestId: 'pe_request',
  deliverableId: 'pe_deliverable', findingId: 'pe_finding', dealRiskId: 'pe_deal_risk', dependencyId: 'pe_dependency',
  closingConditionId: 'pe_closing_condition', closingItemId: 'pe_closing_item', evidenceSourceId: 'evidence_source',
  evidenceVersionId: 'evidence_source_version', documentId: 'document', documentVersionId: 'document_version',
  icCaseId: 'pe_ic_case', questionId: 'pe_ic_question', recommendationId: 'pe_ic_recommendation',
  conditionId: 'pe_ic_condition', decisionProposalId: 'pe_ic_decision_proposal', committeeConfigVersionId: 'pe_ic_committee_config_version',
  underwritingRunId: 'underwriting_run', verifierEmployeeId: 'user', metricSeriesId: 'pe_metric_series',
  metricObservationId: 'pe_metric_observation', assumptionId: 'pe_assumption', thesisId: 'pe_thesis' };
export function payloadResources(value: unknown): Resource[] {
  if (!value || typeof value !== 'object') return [];
  const typed = value as { entityType?: unknown; entityId?: unknown };
  const party = value as { partyType?: unknown; partyId?: unknown };
  const partyTypes: Record<string, string> = { employee: 'user', team: 'team', external_organization: 'external_organization', external_contact: 'external_contact' };
  return [...(typeof typed.entityType === 'string' && identifiers.test(typed.entityType) && typeof typed.entityId === 'string' && uuid.test(typed.entityId)
    ? [{ type: typed.entityType, id: typed.entityId }] : []),
    ...(typeof party.partyType === 'string' && partyTypes[party.partyType] && typeof party.partyId === 'string' && uuid.test(party.partyId)
      ? [{ type: partyTypes[party.partyType]!, id: party.partyId }] : []), ...Object.entries(value).flatMap(([key, child]) => nativeIds[key] && typeof child === 'string' && uuid.test(child)
    ? [{ type: nativeIds[key]!, id: child }] : child && typeof child === 'object' ? payloadResources(child) : [])];
}
export async function intentResourcesTx(ctx: PeMutationContext, session: SessionRow, intent: ControlIntent, client: PoolClient): Promise<Resource[]> {
  const resources = [...sessionResources(session)];
  if ('quantityContext' in intent && intent.quantityContext) resources.push(intent.quantityContext.legalEntityRef);
  if (intent.kind === 'UNDERWRITING_ASSUMPTIONS') resources.push(...intent.overrides.flatMap(item => item.quantityContext ? [item.quantityContext.legalEntityRef] : []));
  if (intent.kind === 'UNDERWRITING_ASSUMPTIONS') {
    resources.push({ type: 'pe_investment_case', id: intent.investmentCaseId }, { type: 'underwriting_model_version', id: intent.modelVersionId },
      { type: 'underwriting_run', id: intent.baseRunId });
    await authorizeResourcesTx(ctx, resources, client);
    const model = (await client.query<{ investment_case_id: string; model_definition: { nodes: Array<{ id: string; unit: string; currency?: string; source?: Record<string, string> }> } }>(
      'SELECT investment_case_id,model_definition FROM finnor_os.underwriting_model_versions WHERE tenant_id=$1 AND id=$2', [ctx.auth.tenantId, intent.modelVersionId])).rows[0];
    const base = (await client.query('SELECT investment_case_id,model_version_id,world_at,scenario_id FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2',
      [ctx.auth.tenantId, intent.baseRunId])).rows[0];
    if (!model || !base || model.investment_case_id !== intent.investmentCaseId || base.investment_case_id !== intent.investmentCaseId
      || base.model_version_id !== intent.modelVersionId || base.scenario_id || base.world_at.toISOString() !== new Date(intent.worldAt).toISOString()) throw unavailable();
    for (const edit of intent.overrides) {
      const node = model.model_definition.nodes.find(node => node.id === edit.nodeId);
      if (!node || node.unit !== edit.unit || (node.currency ?? null) !== edit.currency) throw new LiveControlError('UNSUPPORTED_FIELD_OR_UNIT', 'The exact native model input or unit does not match');
    }
    resources.push(...model.model_definition.nodes.flatMap(node => payloadResources(node.source)));
  } else if (intent.kind === 'S5_ALLOCATION') {
    const refs = intent.request.resourceRefs.map(ref => ref.contentDigest);
    const current = (await client.query<{ body: { ref: { contentDigest: string }; scopeRef: { id: string }; legalEntityRef: { id: string } } }>(
      `SELECT r.body FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
        WHERE r.tenant_id=$1 AND r.content_digest=ANY($2::text[])`, [ctx.auth.tenantId, refs])).rows;
    if (current.length !== refs.length) throw new LiveControlError('MATERIAL_CONFLICT', 'Canonical capacity revisions changed', 409);
    resources.push(...current.map(row => ({ type: 'allocation_resource', id: row.body.scopeRef.id })));
    if (!current.some(row => row.body.legalEntityRef.id === intent.quantityContext.legalEntityRef.id)) throw new LiveControlError('QUANTITY_ENTITY_MISMATCH', 'Allocation quantity names a different legal entity');
  } else if (intent.kind === 'NATIVE_ACTION') {
    resources.push(...payloadResources(intent.payload));
  } else {
    resources.push(...payloadResources(intent.execution.request.ir));
  }
  if (intent.kind === 'UNDERWRITING_ASSUMPTIONS') {
    const snapshot = (await client.query('SELECT input_snapshot FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2',
      [ctx.auth.tenantId, intent.baseRunId])).rows[0]?.input_snapshot as import('@finnor/underwriting').UnderwritingInputSnapshot;
    for (const input of Object.values(snapshot.values)) for (const ref of input.provenance) {
      if (ref.kind === 'evidence_derivation') resources.push({ type: 'p4_derivation', id: ref.id });
      if (ref.kind === 'p1_assumption') resources.push({ type: 'pe_assumption', id: ref.id });
      if (ref.kind === 'evidence_version') resources.push({ type: 'evidence_source_version', id: ref.versionId ?? ref.id });
    }
  }
  const versions = resources.filter(ref => ref.type === 'evidence_source_version').map(ref => ref.id);
  if (versions.length) resources.push(...(await client.query<{ source_id: string }>(
    'SELECT source_id FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [ctx.auth.tenantId, versions])).rows
    .map(row => ({ type: 'evidence_source', id: row.source_id })));
  const result = uniqueResources(resources);
  await authorizeResourcesTx(ctx, result, client);
  await assertSourcePermissionsTx(ctx, session, result, client);
  return result;
}

export async function currentOwnerVectorTx(ctx: PeMutationContext, session: SessionRow, resources: Resource[], client: PoolClient,
  ownerPrincipalId = actor(ctx)): Promise<OwnerVector> {
  await authorizeResourcesTx(ctx, resources, client);
  await assertSourcePermissionsTx(ctx, session, resources, client);
  const identity = await recordedOwnerProofTx(ownerPrincipalId, client, () => readControlActorTx(
    { ...ctx, auth: { ...ctx.auth, userId: ownerPrincipalId, employeeId: ownerPrincipalId } }, client));
  const vector: OwnerVector = { authority: `${identity.authorityRevision}:${digest({
    roles: identity.authorityRoles, validUntil: identity.validUntil, kind: identity.actorKind,
    profileVersion: identity.profileVersion, delegation: identity.delegationRef,
    delegator: identity.delegatorId, delegationWork: identity.delegationWorkId,
  })}` };
  const keys = uniqueResources(resources).filter(ref => ref.type !== 'work').map(ref => `canonical:${ref.type}:${ref.id}`)
    .concat('rights:tenant', 'work-inputs:' + session.work_id);
  // These are existing P4 freshness rows, not a new version owner. Initialize
  // missing zero preimages and lock before reading their original owners.
  await client.query(`INSERT INTO finnor_os.p4_source_revisions(tenant_id,key,revision)
    SELECT $1,k,0 FROM unnest($2::text[]) k ON CONFLICT DO NOTHING`, [ctx.auth.tenantId, keys]);
  const revisions = (await client.query<{ key: string; revision: string }>(
    'SELECT key,revision::text FROM finnor_os.p4_source_revisions WHERE tenant_id=$1 AND key=ANY($2::text[]) ORDER BY key FOR SHARE',
    [ctx.auth.tenantId, keys])).rows;
  for (const revision of revisions) vector['source:' + revision.key] = revision.revision;
  for (const ref of uniqueResources(resources).filter(ref => !['allocation_resource', 'p4_derivation'].includes(ref.type))) {
    const object = await canonicalObjectTx(ctx, ref, client);
    // Work execution/status bookkeeping is not a financial term. Its original
    // input, selected Plan and responsibility owner are separate exact pins.
    vector[`${ref.type}:${ref.id}`] = ref.type === 'work'
      ? digest({ id: ref.id, createdBy: object.raw.created_by, currentOwnerId: object.raw.current_owner_id, assignedTo: object.raw.assigned_to })
      : `${object.version}:${object.revisionDigest}`;
  }
  for (const ref of resources.filter(ref => ref.type === 'p4_derivation')) {
    const row = (await client.query('SELECT digest FROM finnor_os.p4_derivations WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
      [ctx.auth.tenantId, actor(ctx), ref.id])).rows[0];
    if (!row) throw unavailable();
    vector[`P4:${ref.id}`] = row.digest;
  }
  const input = (await client.query<{ id: string; exact_json: string }>(
    'SELECT id,to_jsonb(w)::text exact_json FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
    [ctx.auth.tenantId, session.work_id])).rows[0];
  vector['work-input:' + session.work_id] = input ? `${input.id}:${digest(input.exact_json)}` : 'NO_INPUT';
  const plan = (await client.query(
    "SELECT id,revision,semantic_hash,status FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 AND status IN('active','completed') ORDER BY revision DESC LIMIT 1",
    [ctx.auth.tenantId, session.work_id])).rows[0];
  vector['work-plan:' + session.work_id] = plan ? digest(plan) : 'NO_PLAN';
  // Internal complete S5 cut. Only its opaque commitment and permissioned
  // aggregate projections cross the API, never another principal's references.
  vector['S5:joint-cut'] = digest(await permittedCapacityTx(ctx, client));
  return vector;
}
/** Permitted pool quantities include every retained hold, not the hold's private
 * author, reservation, policy, certificate, status or effect identifiers. */
export async function permittedCapacityTx(ctx: PeMutationContext, client: PoolClient) {
  const rows = (await client.query<{ projection: Record<string, unknown> }>(`SELECT jsonb_build_object(
    'resourceId',r.resource_id,'revision',r.revision,'resourceClass',r.body->'resourceClass','kind',r.body->'kind',
    'unit',r.body->'unit','currency',r.body->'currency','horizon',r.body->'horizon',
    'availability',r.body->'availability','existingUse',r.body->'existingUse','safetyMargin',r.body->'safetyMargin',
    'asOf',r.body->'asOf','validUntil',r.body->'validUntil','revoked',r.body->'revoked',
    'aggregateHeld',coalesce((SELECT jsonb_agg(q.amount ORDER BY q.period) FROM (
      SELECT n.period,coalesce(sum((e.body->'quantities'->>n.period)::numeric),0)::text amount
       FROM generate_series(0,(r.body->'horizon'->>'periods')::int) n(period)
       LEFT JOIN (SELECT item body FROM finnor_os.s5_reservations h
          CROSS JOIN LATERAL jsonb_array_elements(h.envelopes) item
          WHERE h.tenant_id=r.tenant_id AND h.status<>'RELEASED' AND item->>'resourceId'=r.resource_id
            AND item->'horizon'=r.body->'horizon') e ON true GROUP BY n.period) q),'[]'::jsonb),
    'unalignedHold',EXISTS(SELECT 1 FROM finnor_os.s5_reservations h
      CROSS JOIN LATERAL jsonb_array_elements(h.envelopes) item
      WHERE h.tenant_id=r.tenant_id AND h.status<>'RELEASED' AND item->>'resourceId'=r.resource_id
        AND item->'horizon'<>r.body->'horizon'),
    'qualification','OWNER_ASSERTED_UNADMITTED_NOT_FUNDING') projection
    FROM finnor_os.s5_resources r JOIN finnor_os.s5_resource_heads h USING(tenant_id,resource_id,revision)
    WHERE r.tenant_id=$1 AND finnor_os.may_query_resource('allocation_resource',r.body->'scopeRef'->>'id','query:allocation_resources')
    ORDER BY r.resource_id LIMIT 17`, [ctx.auth.tenantId])).rows;
  if (rows.length > 16) throw new LiveControlError('PERMITTED_CAPACITY_LIMIT', 'The permitted native capacity cut exceeds its 16-resource profile');
  return rows.map(row => row.projection);
}
export function assertVector(expected: OwnerVector, current: OwnerVector) {
  if (digest(expected) !== digest(current)) throw new LiveControlError('MATERIAL_CONFLICT', 'Canonical terms, evidence, Work, rights or joint capacity changed. Rebase and evaluate the preserved proposal.', 409);
}
/** Browser cuts contain no tenant sequence, forbidden hash, or author-private
 * grant vector. Resolve only the exact recipient/provider/session/basis cut. */
export async function assertControlCutTx(ctx: PeMutationContext, session: SessionRow, cut: OwnerVector,
  expected: OwnerVector, client: PoolClient, baseOnly = false): Promise<void> {
  if (!cut.cut || !uuid.test(cut.cut) || !cut.basis || Object.keys(cut).length !== 2) throw new LiveControlError(
    'RECIPIENT_CONTROL_CUT_REQUIRED', 'Use the exact current recipient-bound control cut', 409);
  // The database compares the private proof without returning its bytes, keys
  // or hashes to the recipient's ordinary SQL role.
  const row = (await client.query<{ matches: boolean }>(
    'SELECT finnor_os.v5_control_cut_matches($1,$2,$3,$4,$5::jsonb,$6) matches',
    [cut.cut, session.id, ctx.auth.deliverySession!.sessionId, cut.basis, JSON.stringify(expected), baseOnly])).rows[0];
  if (!row?.matches) throw new LiveControlError('RECIPIENT_CONTROL_CUT_EXPIRED',
    'Resynchronize and review the original proposal before continuing', 409);
}

export async function readControlActorTx(ctx: PeMutationContext, client: PoolClient) {
  const authority = await employeeAuthoritySnapshotTx(ctx.auth, client);
  const profile = (await client.query(`SELECT p.*,d.status delegation_status,d.target_id,d.target_type,d.completion_deadline,
    d.created_by delegation_issuer,d.work_id delegation_work_id,
    a.employee_id assignment_employee,a.active assignment_active,a.effective_from,a.expires_at,
    u.status delegator_status FROM finnor_os.employee_actor_profiles p
    LEFT JOIN finnor_os.delegations d ON d.tenant_id=p.tenant_id AND d.id=p.delegation_id
    LEFT JOIN finnor_os.employee_role_assignments a ON a.tenant_id=p.tenant_id AND a.id=p.authority_assignment_id
    LEFT JOIN finnor_os.users u ON u.tenant_id=p.tenant_id AND u.id=p.delegated_by
    WHERE p.tenant_id=$1 AND p.principal_id=$2`, [ctx.auth.tenantId, actor(ctx)])).rows[0];
  if (profile?.actor_kind === 'AGENT' && (profile.delegator_status !== 'active' || profile.delegation_issuer !== profile.delegated_by
    || profile.assignment_employee !== actor(ctx)
    || !profile.assignment_active || profile.effective_from.getTime() > Date.now() || profile.expires_at && profile.expires_at.getTime() <= Date.now()
    || profile.delegation_status !== 'accepted' || profile.target_type !== 'employee' || profile.target_id !== actor(ctx)
    || profile.completion_deadline && profile.completion_deadline.getTime() <= Date.now())) throw unavailable();
  const delegator = profile?.actor_kind === 'AGENT' ? await employeeAuthoritySnapshotTx(
    { ...ctx.auth, userId: profile.delegated_by, employeeId: profile.delegated_by }, client) : null;
  const deadlines = [authority.validUntil, delegator?.validUntil, profile?.completion_deadline?.toISOString()]
    .filter((value): value is string => typeof value === 'string');
  return { principalId: actor(ctx), actorKind: profile?.actor_kind ?? 'UNCLASSIFIED_CANONICAL_EMPLOYEE',
    authorityRevision: authority.revision, authorityRoles: authority.roles,
    validUntil: deadlines.length ? new Date(Math.min(...deadlines.map(Date.parse))).toISOString() : null,
    profileVersion: profile?.version ?? null, delegationRef: profile?.delegation_id ?? null,
    delegatorId: profile?.delegated_by ?? null, delegationWorkId: profile?.delegation_work_id ?? null };
}
export async function assertActorActionTx(ctx: PeMutationContext, request: AuthorityRequest, client: PoolClient, humanOnly = false) {
  const identity = await readControlActorTx(ctx, client);
  if (identity.actorKind === 'UNCLASSIFIED_CANONICAL_EMPLOYEE' || identity.actorKind === 'SERVICE' || humanOnly && identity.actorKind !== 'HUMAN')
    throw new LiveControlError('ACTOR_KIND_OR_PROFESSIONAL_AUTHORITY_UNAVAILABLE', 'Present explicit actor identity is required', 403);
  if (identity.actorKind === 'AGENT' && identity.delegationWorkId && request.workId !== identity.delegationWorkId)
    throw new LiveControlError('DELEGATION_WORK_SCOPE_MISMATCH', 'The accepted delegation is bound to another Work', 403);
  if (identity.actorKind === 'AGENT' && !await canExerciseAuthorityTx({ ...ctx.auth, userId: identity.delegatorId, employeeId: identity.delegatorId } as TenantContext, request, client))
    throw new LiveControlError('PRESENT_DELEGATION_DENIED', 'The current delegator does not cover this exact action', 403);
}

export async function appendHistory(ctx: PeMutationContext, session: SessionRow, branch: BranchRow | null, kind: string, body: unknown, client: PoolClient) {
  await client.query(`INSERT INTO finnor_os.v5_history(tenant_id,session_id,principal_id,branch_id,visibility,resources,kind,body)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb)`, [ctx.auth.tenantId, session.id, actor(ctx), branch?.id ?? null,
    branch?.visibility ?? 'PRIVATE', JSON.stringify(branch?.resources ?? sessionResources(session)), kind, JSON.stringify(body)]);
}
export async function replayCommand(ctx: PeMutationContext, operation: string, key: string, request: unknown, client: PoolClient) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,5176))', [JSON.stringify([ctx.auth.tenantId, actor(ctx), operation, key])]);
  const row = (await client.query('SELECT request_digest,result FROM finnor_os.v5_commands WHERE tenant_id=$1 AND principal_id=$2 AND operation=$3 AND idempotency_key=$4',
    [ctx.auth.tenantId, actor(ctx), operation, key])).rows[0];
  if (row && row.request_digest !== digest(request)) throw new LiveControlError('IDEMPOTENCY_CONFLICT', 'This original command identity has different bytes', 409);
  return row?.result ?? null;
}
export async function rememberCommand(ctx: PeMutationContext, session: SessionRow, operation: string, key: string, request: unknown, result: unknown, client: PoolClient) {
  await client.query('INSERT INTO finnor_os.v5_commands(tenant_id,session_id,principal_id,operation,idempotency_key,request_digest,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
    [ctx.auth.tenantId, session.id, actor(ctx), operation, key, digest(request), JSON.stringify(result)]);
  return result;
}

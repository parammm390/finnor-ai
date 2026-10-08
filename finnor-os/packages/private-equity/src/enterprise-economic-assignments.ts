/** S2 owns the prospective assignment law and its actual immutable draws.
 * This records assignment; intervention authorization remains with S4–S6. */
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { withTenantTransaction } from '@finnor/db';
import type { EconomicRef, EconomicAssignment } from '../../shared-types/src/economic-attribution';
import { collectEconomicRefs, economicHash, parseOutcomeEstimand, EconomicContractError } from '../../epistemic-runtime/src/economic-attribution';
import { enqueueOwnerDeliveryInTransaction } from '../../governed-execution/src/owner-delivery-store';
import { LedgerFault } from '../../governed-execution/src/protocol';
import { authorizeEconomicActor, economicActor, readStoredEconomicRecord } from './economic-store';
import { resolveEconomicSourceCut } from './enterprise-economic-attribution';
import type { PeMutationContext } from './types';
const text = z.string().min(1).max(256), ref = z.object({ owner: z.string().min(1).max(128), id: z.string().min(1).max(4096), version: text, contentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const protocolSchema = z.object({ schema: z.literal('finnor.s2.economic-assignment-protocol.v1'), key: text, mandateRef: ref, populationRef: ref, clusterIds: z.array(text).min(1).max(4096), controllerIds: z.array(text).min(2).max(32), probabilityUnits: z.record(z.number().int().min(1).max(999999)), assignmentNotBefore: z.string().datetime({ offset: true }), outcomeAccessNotBefore: z.string().datetime({ offset: true }), randomization: z.literal('INDEPENDENT_CRYPTO_CATEGORICAL_V1') }).strict();
type Stored = {
    ref: EconomicRef;
    content: Record<string, any>;
    assignments?: EconomicAssignment[];
    executionAuthorityGranted: false;
};
const fail = (code: string): never => { throw new EconomicContractError(code); };
const same = (a: unknown, b: unknown) => economicHash(a) === economicHash(b);
function commitment(content: Record<string, any>, kind: string) { const contentDigest = economicHash(content); return { owner: 'S2', id: 'economic-' + kind + ':' + contentDigest, version: 's2-economic-assignment-v1', contentDigest, content }; }
async function replay(ctx: PeMutationContext, kind: string, key: string, digest: string) { return withTenantTransaction(ctx.auth.tenantId, { userId: economicActor(ctx) }, async (_db, c) => { await authorizeEconomicActor(ctx, c, true); const r = (await c.query('SELECT * FROM finnor_os.s2_economic_assignment_records WHERE tenant_id=$1 AND principal_id=$2 AND kind=$3 AND idempotency_key=$4', [ctx.auth.tenantId, economicActor(ctx), kind, key])).rows[0]; if (!r)
    return null; if (r.request_digest !== digest)
    throw new LedgerFault(409, 'ECONOMIC_ASSIGNMENT_IDEMPOTENCY_CONFLICT'); const stored = r.body as Stored; if (economicHash(stored.content) !== r.content_digest || stored.ref.contentDigest !== r.content_digest || stored.ref.id !== r.record_id)
    throw new LedgerFault(503, 'ECONOMIC_ASSIGNMENT_STORAGE_PREIMAGE_INVALID'); return { record: stored, semanticReplay: true }; }); }
async function save(ctx: PeMutationContext, input: {
    kind: 'PROTOCOL' | 'ASSIGNMENT';
    key: string;
    digest: string;
    rightsRef: string;
    protocolId?: string;
    estimandId?: string;
    build: (at: string) => {
        content: Record<string, any>;
        assignments?: EconomicAssignment[];
        references?: Record<string, any>[];
    };
}) {
    return withTenantTransaction(ctx.auth.tenantId, { userId: economicActor(ctx) }, async (_db, c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`s2-economic:${ctx.auth.tenantId}:${economicActor(ctx)}`]);
        await authorizeEconomicActor(ctx, c, true);
        const prior = (await c.query('SELECT * FROM finnor_os.s2_economic_assignment_records WHERE tenant_id=$1 AND principal_id=$2 AND kind=$3 AND idempotency_key=$4', [ctx.auth.tenantId, economicActor(ctx), input.kind, input.key])).rows[0];
        if (prior) {
            if (prior.request_digest !== input.digest)
                throw new LedgerFault(409, 'ECONOMIC_ASSIGNMENT_IDEMPOTENCY_CONFLICT');
            return { record: prior.body as Stored, semanticReplay: true };
        }
        const at = (await c.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now")).rows[0].now as string;
        if (input.estimandId) {
            const assigned = (await c.query("SELECT record_id FROM finnor_os.s2_economic_assignment_records WHERE tenant_id=$1 AND principal_id=$2 AND estimand_id=$3 AND kind='ASSIGNMENT' LIMIT 1", [ctx.auth.tenantId, economicActor(ctx), input.estimandId])).rowCount;
            if (assigned)
                throw new LedgerFault(409, 'ECONOMIC_ASSIGNMENT_ALREADY_FROZEN');
            const invalid = (await c.query("SELECT record_id FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND principal_id=$2 AND estimand_id=$3 AND kind='INVALIDATION' LIMIT 1", [ctx.auth.tenantId, economicActor(ctx), input.estimandId])).rowCount;
            if (invalid)
                fail('PREREGISTRATION_INVALIDATED');
        }
        const built = input.build(at), reference = commitment(built.content, input.kind.toLowerCase()), { content, ...r } = reference, stored: Stored = { ref: r, content, ...(built.assignments ? { assignments: built.assignments } : {}), executionAuthorityGranted: false };
        if (Buffer.byteLength(JSON.stringify(stored)) > 8388608)
            fail('ECONOMIC_ASSIGNMENT_RECORD_LIMIT');
        await c.query('INSERT INTO finnor_os.s2_economic_assignment_records(tenant_id,principal_id,record_id,kind,protocol_id,estimand_id,idempotency_key,request_digest,content_digest,knowledge_at,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)', [ctx.auth.tenantId, economicActor(ctx), r.id, input.kind, input.protocolId ?? null, input.estimandId ?? null, input.key, input.digest, r.contentDigest, at, JSON.stringify(stored)]);
        const identity = { semanticOwner: 'S2', tenantId: ctx.auth.tenantId, principalId: economicActor(ctx) }, references = [reference, ...(built.references ?? [])];
        for (let i = 0; i < references.length; i += 256)
            await enqueueOwnerDeliveryInTransaction(c, identity, { kind: 'REFERENCE', identity: references[i]!.id, payload: { reference: references[i], relatedReferences: references.slice(i + 1, i + 256), rightsRefs: [input.rightsRef] } });
        const eventBody = { schema: 'finnor.s2.experience.v1', semanticOwner: 'S2', type: 'COLLECTION', episodeId: input.estimandId ?? r.id, tenantId: ctx.auth.tenantId, principalId: economicActor(ctx), rightsRef: input.rightsRef, revisionRef: r.id, contentDigest: r.contentDigest, knowledgeAt: at, validAt: at, preparedParentRefs: [], causalParents: [], dependencyRefs: [], freshnessRef: r.id, provenanceRefs: [], horizon: 'H0', uncertainty: 'ASSIGNMENT_ONLY_NO_EXECUTION_OR_CAUSAL_CREDIT', detail: content, protectedReceipt: null, appendAuthorityGranted: false, executionAuthorityGranted: false };
        const event = { ...eventBody, eventId: 's2-event:' + economicHash(eventBody) };
        await enqueueOwnerDeliveryInTransaction(c, identity, { kind: 'EVENT', identity: event.eventId, payload: { event, references: [] } });
        return { record: stored, semanticReplay: false };
    });
}
export async function registerEnterpriseEconomicAssignmentProtocol(ctx: PeMutationContext, input: {
    protocol: unknown;
    rightsRef: string;
    idempotencyKey?: string;
}) {
    const p = protocolSchema.parse(input.protocol);
    if (p.mandateRef.owner !== 'BUSINESS_OWNER' || p.populationRef.owner !== 'S2' || new Set(p.clusterIds).size !== p.clusterIds.length || new Set(p.controllerIds).size !== p.controllerIds.length || Object.keys(p.probabilityUnits).length !== p.controllerIds.length || p.controllerIds.some(id => !p.probabilityUnits[id]) || Object.values(p.probabilityUnits).reduce((a, b) => a + b, 0) !== 1000000 || Date.parse(p.outcomeAccessNotBefore) <= Date.parse(p.assignmentNotBefore))
        fail('ECONOMIC_ASSIGNMENT_PROTOCOL_INVALID');
    const key = input.idempotencyKey ?? p.key, digest = economicHash({ protocol: p, rightsRef: input.rightsRef }), old = await replay(ctx, 'PROTOCOL', key, digest);
    if (old)
        return old;
    const probabilities = Object.fromEntries(p.controllerIds.map(id => [id, (p.probabilityUnits[id]! / 1000000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')]));
    return save(ctx, { kind: 'PROTOCOL', key, digest, rightsRef: input.rightsRef, build: at => { if (Date.parse(at) >= Date.parse(p.assignmentNotBefore))
            fail('ASSIGNMENT_PROTOCOL_MUST_PRECEDE_ASSIGNMENT'); return { content: { ...p, probabilities, registeredAt: at, tenantId: ctx.auth.tenantId, principalId: economicActor(ctx), rightsRef: input.rightsRef } }; } });
}
/** Read the original native S2 record under the same tenant/member boundary.
 * A protected commitment is checked separately by its attenuated consumer. */
export async function readEnterpriseEconomicAssignmentRecord(ctx: PeMutationContext, value: unknown): Promise<Stored> {
    const wanted = ref.parse(value);
    if (wanted.owner !== 'S2' || wanted.version !== 's2-economic-assignment-v1')
        fail('NATIVE_ECONOMIC_ASSIGNMENT_REFERENCE_REQUIRED');
    return withTenantTransaction(ctx.auth.tenantId, { userId: economicActor(ctx), readOnly: true }, async (_db, c) => {
        await authorizeEconomicActor(ctx, c, false);
        const row = (await c.query('SELECT * FROM finnor_os.s2_economic_assignment_records WHERE tenant_id=$1 AND principal_id=$2 AND record_id=$3', [ctx.auth.tenantId, economicActor(ctx), wanted.id])).rows[0];
        if (!row)
            throw new LedgerFault(404, 'ECONOMIC_ASSIGNMENT_CONTEXT_UNAVAILABLE');
        const stored = row.body as Stored;
        if (!same(stored.ref, wanted) || economicHash(stored.content) !== row.content_digest || wanted.contentDigest !== row.content_digest || stored.content.tenantId !== ctx.auth.tenantId || stored.content.principalId !== economicActor(ctx)
            || stored.executionAuthorityGranted !== false || row.kind === 'PROTOCOL' && stored.content.schema !== 'finnor.s2.economic-assignment-protocol.v1'
            || row.kind === 'ASSIGNMENT' && (stored.content.schema !== 'finnor.s2.economic-assignment-group.v1' || !same(stored.assignments, stored.content.assignments)))
            throw new LedgerFault(503, 'ECONOMIC_ASSIGNMENT_STORAGE_PREIMAGE_INVALID');
        return structuredClone(stored);
    });
}
export async function assignEnterpriseEconomicProgramme(ctx: PeMutationContext, input: {
    estimandId: string;
    protocolId: string;
    idempotencyKey: string;
}) {
    const digest = economicHash(input), old = await replay(ctx, 'ASSIGNMENT', input.idempotencyKey, digest);
    if (old)
        return old;
    const original = await readStoredEconomicRecord(ctx, input.estimandId), e = parseOutcomeEstimand(original.payload.estimand);
    if (original.kind !== 'PREREGISTRATION' || original.payload.mode !== 'PROSPECTIVE' || e.assignment.kind !== 'INDEPENDENT_CLUSTER_RANDOMIZATION' || e.assignment.protocolRef.id !== input.protocolId)
        fail('PROSPECTIVE_S2_BOUND_ESTIMAND_REQUIRED');
    if (e.assignment.kind !== 'INDEPENDENT_CLUSTER_RANDOMIZATION')
        throw new EconomicContractError('PROSPECTIVE_S2_BOUND_ESTIMAND_REQUIRED');
    const cut = await resolveEconomicSourceCut(ctx, [original.ref, e.assignment.protocolRef, e.mandateRef], e);
    if (cut.evidence.some(v => v.status !== 'RESOLVED_AUTHENTICATED' || Date.parse(v.knowledgeAt) >= Date.parse(e.assignmentAt)))
        fail('PROTECTED_PREASSIGNMENT_SOURCE_COMMITMENTS_REQUIRED');
    const originalCut = original.payload.sourceCut as any[];
    if (!Array.isArray(originalCut) || collectEconomicRefs(e).some(ref => !originalCut.some(v => same(v.ref, ref) && v.status === 'RESOLVED_AUTHENTICATED' && v.signatureVerified && v.protectedReceiptRef && Date.parse(v.knowledgeAt) < Date.parse(e.assignmentAt))))
        fail('PREREGISTERED_SOURCE_CUT_INCOMPLETE');
    const p = cut.readbacks.get(input.protocolId)?.reference.content as any, m = cut.readbacks.get(e.mandateRef.id)?.reference.content as any;
    if (p?.schema !== 'finnor.s2.economic-assignment-protocol.v1' || p.randomization !== 'INDEPENDENT_CRYPTO_CATEGORICAL_V1' || !same(p.probabilities, e.assignment.probabilities) || !same(p.clusterIds, e.clusters.map(c => c.id)) || !same(p.controllerIds, e.controllers.map(c => c.id)) || !same(p.mandateRef, e.mandateRef) || !same(p.populationRef, e.populationRef) || p.assignmentNotBefore !== e.assignmentAt || p.outcomeAccessNotBefore !== e.outcomeAccessNotBefore || p.tenantId !== ctx.auth.tenantId || p.principalId !== economicActor(ctx) || m?.schema !== 'finnor.economic-mandate.v1' || m.tenantId !== ctx.auth.tenantId || m.principalId !== economicActor(ctx) || m.rightsRef !== original.event.rightsRef || m.economicProgrammeAssignment !== true)
        fail('AUTHORIZED_ASSIGNMENT_PROTOCOL_BINDING_INVALID');
    return save(ctx, { kind: 'ASSIGNMENT', key: input.idempotencyKey, digest, rightsRef: String(original.event.rightsRef), protocolId: input.protocolId, estimandId: input.estimandId, build: at => { if (Date.parse(at) < Date.parse(e.assignmentAt) || Date.parse(at) >= Date.parse(e.outcomeAccessNotBefore) || Date.parse(at) >= Date.parse(m.validUntil))
            fail('ASSIGNMENT_TIME_OR_MANDATE_INVALID'); const references: Record<string, any>[] = []; const assignments = e.clusters.map(cluster => { const draw = randomInt(1000000); let cumulative = 0, controllerId = ''; for (const id of p.controllerIds) {
            cumulative += p.probabilityUnits[id];
            if (draw < cumulative) {
                controllerId = id;
                break;
            }
        } if (!controllerId)
            fail('REGISTERED_PROBABILITY_LAW_INVALID'); const reference = commitment({ schema: 'finnor.s2.economic-assignment.v1', tenantId: ctx.auth.tenantId, principalId: economicActor(ctx), estimandRef: original.ref, protocolRef: e.assignment.protocolRef, clusterId: cluster.id, controllerId, assignedAt: at, randomization: p.randomization }, 'draw'); references.push(reference); const { content, ...assignmentRef } = reference; return { clusterId: cluster.id, controllerId, assignedAt: at, assignmentRef, protocolRef: e.assignment.protocolRef, stages: [{ stage: 'INTENDED' as const, ref: assignmentRef }], actualExposureRefs: [] }; }); return { content: { schema: 'finnor.s2.economic-assignment-group.v1', tenantId: ctx.auth.tenantId, principalId: economicActor(ctx), estimandRef: original.ref, protocolRef: e.assignment.protocolRef, assignedAt: at, assignments, physicalCompletionGranted: false, economicCreditGranted: false }, assignments, references }; } });
}

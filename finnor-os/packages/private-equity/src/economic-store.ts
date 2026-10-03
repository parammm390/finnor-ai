import { canonicalEconomic } from '../../epistemic-runtime/src/economic-attribution';
/** Ordinary S7 persistence: original bytes and prepared S6 delivery origins
 * commit together. No local SQL state establishes a protected receipt or H2. */
import { withTenantTransaction } from '@finnor/db';
import type pg from 'pg';
import { LedgerFault } from '../../governed-execution/src/protocol';
import { ownerTransportHash } from '../../governed-execution/src/owner-transport';
import { enqueueOwnerDeliveryInTransaction } from '../../governed-execution/src/owner-delivery-store';
import type { PeMutationContext } from './types';
export type EconomicRecordKind = 'PREREGISTRATION' | 'SOURCE' | 'ASSIGNMENT' | 'EXPOSURE' | 'MEASUREMENT' | 'VALUATION' | 'COST' | 'ASSESSMENT' | 'AGGREGATION' | 'CORRECTION' | 'INVALIDATION' | 'COMPUTE' | 'BENCHMARK_REGISTRATION' | 'BENCHMARK_ASSESSMENT';
export interface StoredEconomicRecord {
    ref: {
        owner: 'S7';
        id: string;
        version: string;
        contentDigest: string;
    };
    kind: EconomicRecordKind;
    estimandId: string | null;
    revisionOf: string | null;
    tenantId: string;
    principalId: string;
    validAt: string;
    knowledgeAt: string;
    payload: Record<string, unknown>;
    event: Record<string, unknown>;
    protectedReceipt: null;
    executionAuthorityGranted: false;
}
export const economicActor = (ctx: PeMutationContext) => ctx.auth.employeeId ?? ctx.auth.userId;
const denied = (): never => { throw new LedgerFault(404, 'ECONOMIC_CONTEXT_UNAVAILABLE'); };
const bounded = (value: unknown) => {
    if (Buffer.byteLength(canonicalEconomic(value)) > 8 * 1024 * 1024)
        throw new LedgerFault(413, 'ECONOMIC_RECORD_LIMIT');
};
export async function authorizeEconomicActor(ctx: PeMutationContext, c: pg.PoolClient, write: boolean) {
    if (economicActor(ctx) !== ctx.auth.userId || write && ctx.auth.role !== 'owner')
        denied();
    const row = await c.query("SELECT role FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active'" + (write ? ' FOR SHARE' : ''), [ctx.auth.tenantId, economicActor(ctx)]);
    if (row.rowCount !== 1 || write && row.rows[0].role !== 'owner')
        denied();
}
function decode(row: any): StoredEconomicRecord {
    const value = row.body as StoredEconomicRecord;
    const { ref, event, protectedReceipt, executionAuthorityGranted, ...content } = value;
    if (ref.id !== row.record_id || ref.contentDigest !== row.content_digest || (ref.version === 's7-economic-record-v2' ? ownerTransportHash({ schema: 'finnor.s7.semantic-content.v2', canonicalPayload: canonicalEconomic(content) }) : ownerTransportHash(content)) !== ref.contentDigest
        || value.tenantId !== row.tenant_id || value.principalId !== row.principal_id || ownerTransportHash(event) !== ownerTransportHash(row.event))
        throw new LedgerFault(503, 'ECONOMIC_STORAGE_PREIMAGE_INVALID');
    return value;
}
export async function readStoredEconomicRecord(ctx: PeMutationContext, id: string) {
    if (typeof id !== 'string' || id.length > 4096)
        denied();
    return withTenantTransaction(ctx.auth.tenantId, { userId: economicActor(ctx), readOnly: true }, async (_db, c) => {
        await authorizeEconomicActor(ctx, c, false);
        const row = (await c.query('SELECT * FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND principal_id=$2 AND record_id=$3', [ctx.auth.tenantId, economicActor(ctx), id])).rows[0];
        if (!row)
            denied();
        return decode(row);
    });
}
export async function listStoredEconomicHistory(ctx: PeMutationContext, estimandId: string, knowledgeAt?: string) {
    const cut = knowledgeAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(cut)) || Date.parse(cut) > Date.now() + 1000)
        throw new LedgerFault(400, 'ECONOMIC_KNOWLEDGE_CUT_INVALID');
    return withTenantTransaction(ctx.auth.tenantId, { userId: economicActor(ctx), readOnly: true }, async (_db, c) => {
        await authorizeEconomicActor(ctx, c, false);
        const tracking = (await c.query('SHOW track_commit_timestamp')).rows[0].track_commit_timestamp;
        if (tracking !== 'on')
            return { records: [], knowledgeAt: cut, complete: false, reason: 'COMMIT_VISIBILITY_UNAVAILABLE', executionAuthorityGranted: false as const };
        const gaps = (await c.query('SELECT count(*)::int n FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND principal_id=$2 AND (estimand_id=$3 OR record_id=$3) AND knowledge_at<=$4::timestamptz AND pg_xact_commit_timestamp(xmin) IS NULL', [ctx.auth.tenantId, economicActor(ctx), estimandId, cut])).rows[0].n;
        const rows = await c.query('SELECT * FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND principal_id=$2 AND (estimand_id=$3 OR record_id=$3) AND knowledge_at<=$4::timestamptz AND pg_xact_commit_timestamp(xmin)<=$4::timestamptz ORDER BY knowledge_at,record_id LIMIT 4097', [ctx.auth.tenantId, economicActor(ctx), estimandId, cut]);
        if (rows.rows.length > 4096)
            throw new LedgerFault(413, 'ECONOMIC_HISTORY_LIMIT');
        return { records: rows.rows.map(decode), knowledgeAt: cut, complete: gaps === 0, ...(gaps ? { reason: 'COMMIT_VISIBILITY_RETENTION_GAP' } : {}), executionAuthorityGranted: false as const };
    });
}
export async function persistEconomicRecord(ctx: PeMutationContext, input: {
    kind: EconomicRecordKind;
    payload: Record<string, unknown>;
    rightsRef: string;
    idempotencyKey: string;
    estimandId?: string;
    revisionOf?: string;
    validAt: string;
    horizon: 'H0' | 'H1' | 'H2';
    uncertainty: string;
    dependencies?: Array<{
        owner: string;
        id: string;
        version: string;
        contentDigest: string;
    }>;
    semanticRequestDigest?: string;
    freezeBefore?: string;
}) {
    bounded(input);
    if (!Number.isFinite(Date.parse(input.validAt)) || typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 256 || !input.rightsRef)
        throw new LedgerFault(400, 'ECONOMIC_RECORD_INVALID');
    const digest = input.semanticRequestDigest ?? ownerTransportHash(input);
    if (!/^[a-f0-9]{64}$/.test(digest))
        throw new LedgerFault(400, 'ECONOMIC_REQUEST_DIGEST_INVALID');
    return withTenantTransaction(ctx.auth.tenantId, { userId: economicActor(ctx) }, async (_db, c) => {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`s7-economic:${ctx.auth.tenantId}:${economicActor(ctx)}`]);
        await authorizeEconomicActor(ctx, c, true);
        const prior = (await c.query('SELECT * FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND principal_id=$2 AND kind=$3 AND idempotency_key=$4', [ctx.auth.tenantId, economicActor(ctx), input.kind, input.idempotencyKey])).rows[0];
        if (prior) {
            if (prior.request_digest !== digest)
                throw new LedgerFault(409, 'ECONOMIC_IDEMPOTENCY_CONFLICT');
            return { record: decode(prior), semanticReplay: true };
        }
        for (const id of [input.estimandId, input.revisionOf].filter((v): v is string => !!v)) {
            const row = (await c.query('SELECT * FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND principal_id=$2 AND record_id=$3', [ctx.auth.tenantId, economicActor(ctx), id])).rows[0];
            if (!row)
                denied();
            if (id === input.estimandId && row.kind !== 'PREREGISTRATION')
                throw new LedgerFault(400, 'ECONOMIC_ESTIMAND_REQUIRED');
            if (id === input.revisionOf && input.estimandId && row.estimand_id !== input.estimandId && row.record_id !== input.estimandId)
                throw new LedgerFault(409, 'ECONOMIC_REVISION_CONTEXT_MISMATCH');
        }
        const knowledgeAt = (await c.query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS now")).rows[0].now as string;
        if (input.freezeBefore && Date.parse(knowledgeAt) >= Date.parse(input.freezeBefore))
            throw new LedgerFault(409, 'ECONOMIC_PREREGISTRATION_DEADLINE_PASSED');
        const content = { kind: input.kind, estimandId: input.estimandId ?? null, revisionOf: input.revisionOf ?? null, tenantId: ctx.auth.tenantId, principalId: economicActor(ctx), validAt: input.validAt, knowledgeAt, payload: input.payload };
        const encodedContent = { schema: 'finnor.s7.semantic-content.v2', canonicalPayload: canonicalEconomic(content) };
        const contentDigest = ownerTransportHash(encodedContent), ref = { owner: 'S7' as const, id: `economic-record:${contentDigest}`, version: 's7-economic-record-v2', contentDigest };
        const dependencies = input.dependencies ?? [];
        if (dependencies.length > 4096)
            throw new LedgerFault(413, 'ECONOMIC_DEPENDENCY_LIMIT');
        const cuts = dependencies.length <= 256 ? [] : Array.from({ length: Math.ceil(dependencies.length / 256) }, (_, i) => { const content = { schema: 'finnor.s7.dependency-cut.v1', tenantId: ctx.auth.tenantId, principalId: economicActor(ctx), references: dependencies.slice(i * 256, (i + 1) * 256) }; const digest = ownerTransportHash(content); return { owner: 'S7', id: 'economic-dependency-cut:' + digest, version: 's7-dependency-cut-v1', contentDigest: digest, content }; });
        const eventDependencies = cuts.length ? cuts : dependencies;
        const compute = input.payload.computeInvocation as any;
        const computeReference = compute ? { owner: 'S7', id: compute.id, version: 's7-model-compute-v1', contentDigest: ownerTransportHash(compute), content: compute } : null;
        const type = input.kind === 'SOURCE' ? 'MEASUREMENT' : input.kind === 'BENCHMARK_REGISTRATION' ? 'PREREGISTRATION' : input.kind === 'BENCHMARK_ASSESSMENT' ? 'ASSESSMENT' : input.kind;
        const parents = input.revisionOf ? (await c.query('SELECT event FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND principal_id=$2 AND record_id=$3', [ctx.auth.tenantId, economicActor(ctx), input.revisionOf])).rows.map(row => row.event.eventId) : [];
        const eventBody = { schema: 'finnor.s7.experience.v1', semanticOwner: 'S7', type, episodeId: input.estimandId ?? ref.id, tenantId: ctx.auth.tenantId, principalId: economicActor(ctx), rightsRef: input.rightsRef, preparedParentRefs: parents, causalParents: [], revisionRef: ref.id, contentDigest, validAt: input.validAt, knowledgeAt, dependencyRefs: eventDependencies.map(r => r.id), freshnessRef: ref.id, uncertainty: input.uncertainty, horizon: input.horizon, provenanceRefs: eventDependencies.map(({ owner, id, version, contentDigest }) => ({ owner, id, version, contentDigest })), modelComputeRef: computeReference?.id ?? null, detail: encodedContent, protectedReceipt: null, appendAuthorityGranted: false, executionAuthorityGranted: false };
        const event = { ...eventBody, eventId: `s7-event:${ownerTransportHash(eventBody)}` };
        const record: StoredEconomicRecord = { ...content, ref, event, protectedReceipt: null, executionAuthorityGranted: false };
        bounded(record);
        await c.query('INSERT INTO finnor_os.s7_economic_records(tenant_id,principal_id,record_id,kind,estimand_id,revision_of,idempotency_key,request_digest,content_digest,valid_at,knowledge_at,body,event) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb)', [ctx.auth.tenantId, economicActor(ctx), ref.id, input.kind, input.estimandId ?? null, input.revisionOf ?? null, input.idempotencyKey, digest, contentDigest, input.validAt, knowledgeAt, JSON.stringify(record), JSON.stringify(event)]);
        const identity = { semanticOwner: 'S7', tenantId: ctx.auth.tenantId, principalId: economicActor(ctx) };
        await enqueueOwnerDeliveryInTransaction(c, identity, { kind: 'REFERENCE', identity: ref.id, payload: { reference: { ...ref, content: encodedContent }, rightsRefs: [input.rightsRef], ...((cuts.length || computeReference) ? { relatedReferences: [...cuts, ...(computeReference ? [computeReference] : [])] } : {}) } });
        await enqueueOwnerDeliveryInTransaction(c, identity, { kind: 'EVENT', identity: event.eventId, payload: { event, references: [] } });
        return { record, semanticReplay: false };
    });
}
/** Replays the original semantic request without recomputing a newer assessment. */
export async function readEconomicReplay(ctx: PeMutationContext, kind: EconomicRecordKind, key: string, requestDigest: string) {
    return withTenantTransaction(ctx.auth.tenantId, { userId: economicActor(ctx) }, async (_db, c) => {
        await authorizeEconomicActor(ctx, c, true);
        const row = (await c.query('SELECT * FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND principal_id=$2 AND kind=$3 AND idempotency_key=$4', [ctx.auth.tenantId, economicActor(ctx), kind, key])).rows[0];
        if (!row)
            return null;
        if (row.request_digest !== requestDigest)
            throw new LedgerFault(409, 'ECONOMIC_IDEMPOTENCY_CONFLICT');
        return { record: decode(row), semanticReplay: true };
    });
}
/** A nonrecursive immutable history cut; original records remain independently readable. */
export function economicHistoryManifest(history: Awaited<ReturnType<typeof listStoredEconomicHistory>>) { return { ...history, records: history.records.map(r => ({ ref: r.ref, kind: r.kind, estimandId: r.estimandId, revisionOf: r.revisionOf, validAt: r.validAt, knowledgeAt: r.knowledgeAt, eventId: String(r.event.eventId) })) }; }

/** Monetary notices change current qualification without rewriting a historical score. */
export const ECONOMIC_MONETARY_NOTICE_KINDS = new Set(['COST', 'CORRECTION', 'VALUATION']);
export function economicAssessmentKnowledgeCut(record: StoredEconomicRecord): string {
    return String((record.payload.nativeHistory as any)?.knowledgeAt ?? (record.payload.inputs as any)?.assessedAt ?? record.knowledgeAt);
}
export function economicHistoryHasNewNotices(history: { records: Array<{ kind: string; knowledgeAt: string }> }, knowledgeCut: string): boolean {
    return history.records.some(v => ECONOMIC_MONETARY_NOTICE_KINDS.has(v.kind) && Date.parse(v.knowledgeAt) > Date.parse(knowledgeCut));
}

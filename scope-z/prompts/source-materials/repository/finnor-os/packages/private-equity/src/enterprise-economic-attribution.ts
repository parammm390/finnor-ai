/** Authenticated S7 owner. Submitted references are resolved from their actual
 * protected owner; caller JSON never supplies signatures or maturity authority. */
import type { EconomicRef, OutcomeEstimand, EconomicAssignment, EconomicAccountingSubmission, EconomicEvidenceResolution, EconomicAssessmentInput, EconomicBenchmarkRegistration, EconomicAssessment, S7ModelComputeInvocation } from '../../shared-types/src/economic-attribution';
import { parseOutcomeEstimand, parseEconomicAccountingSubmission, parseEconomicBenchmarkRegistration, assessEconomicAttribution, assessEconomicBenchmark, collectEconomicRefs, economicHash, EconomicContractError, parseEconomicAssessmentInput, parseEconomicBenchmarkInput, immutableEconomic } from '../../epistemic-runtime/src/economic-attribution';
import { resolveEconomicOwnerReference, ownerTransportRoute, readOwnerTransportEvent, readOwnerTransportExecutionHandoff } from '../../governed-execution/src/owner-transport';
import { LedgerFault } from '../../governed-execution/src/protocol';
import { economicActor, persistEconomicRecord, readEconomicReplay, readStoredEconomicRecord, listStoredEconomicHistory, economicHistoryManifest, ECONOMIC_MONETARY_NOTICE_KINDS, economicAssessmentKnowledgeCut, economicHistoryHasNewNotices, type EconomicRecordKind } from './economic-store';
import type { PeMutationContext } from './types';
const same = (a: unknown, b: unknown) => economicHash(a) === economicHash(b);
const fail = (code: string): never => { throw new EconomicContractError(code); };
const identity = (ctx: PeMutationContext) => ({ semanticOwner: 'S7', tenantId: ctx.auth.tenantId, principalId: economicActor(ctx) });
const economicSourceContent = (v: Readback | undefined): any => { const content = v?.reference.content; return v?.reference.owner === 'S7' && v.reference.version === 's7-economic-record-v2' && typeof content === 'object' && content?.schema === 'finnor.s7.semantic-content.v2' && typeof content?.canonicalPayload === 'string' ? JSON.parse(content.canonicalPayload) : content; };
type Readback = Awaited<ReturnType<typeof resolveEconomicOwnerReference>>;
export async function resolveEconomicSourceCut(ctx: PeMutationContext, refs: EconomicRef[], e?: OutcomeEstimand) {
    if (refs.length > 4096)
        fail('ECONOMIC_SOURCE_CUT_LIMIT');
    const evidence: EconomicEvidenceResolution[] = [], readbacks = new Map<string, Readback>(), started = Date.now();
    const route = await ownerTransportRoute(identity(ctx), 'CONSUMER'), purpose = route ? 'CONSUMER' as const : 'OWNER' as const;
    for (let offset = 0; offset < refs.length; offset += 4) {
        if (Date.now() - started > 30000)
            fail('ECONOMIC_SOURCE_READ_BUDGET_EXCEEDED');
        const results = await Promise.allSettled(refs.slice(offset, offset + 4).map(async (ref) => { const issuers = e?.valuationProtocol.authorityRefs.filter(a => a.owner === ref.owner && /^[a-f0-9-]{36}$/i.test(a.id)).map(a => a.id) ?? []; return resolveEconomicOwnerReference(identity(ctx), ref, { purpose, ...(issuers.length ? { allowedPrincipalIds: issuers } : {}) }); }));
        for (let j = 0; j < results.length; j++) {
            const ref = refs[offset + j]!, result = results[j]!;
            if (result.status === 'fulfilled') {
                const v = result.value, body = economicSourceContent(v), external = !/^S[1-8]$/.test(ref.owner) && ref.owner !== 'BUSINESS_OWNER', authorityBody = body?.schema === 'finnor.independent-valuation-authority.v1' && body.principalId === v.receipt.principalId && ref.id === v.receipt.principalId, valuationBody = body?.schema === 'finnor.independent-owner-valuation.v1' && body.authorityRef?.owner === ref.owner && body.authorityRef?.id === v.receipt.principalId;
                readbacks.set(ref.id, v);
                evidence.push({ ref, status: 'RESOLVED_AUTHENTICATED', tenantId: ctx.auth.tenantId, knowledgeAt: v.receipt.appendAt, protectedReceiptRef: { owner: 'S6', id: v.receipt.identity, version: v.receipt.schema, contentDigest: v.receipt.checkpointDigest }, signatureVerified: true, independent: external && v.receipt.principalId !== economicActor(ctx) && (authorityBody || valuationBody || body?.independent === true), sourceOrigin: external && ['FIELD', 'GENERATED_CHALLENGE', 'RETROSPECTIVE', 'MODELED'].includes(body?.sourceOrigin) ? body.sourceOrigin : 'UNKNOWN', protectionDomain: v.protectionDomain });
            }
            else {
                const error = result.reason;
                if (error instanceof LedgerFault && /SIGNATURE|BINDING|PREIMAGE|TOKEN_CHANGED|CONFIGURATION_SIGNATURE/.test(error.code))
                    throw error;
                evidence.push({ ref, status: 'UNAVAILABLE', tenantId: ctx.auth.tenantId, knowledgeAt: new Date().toISOString(), protectedReceiptRef: null, signatureVerified: false, independent: false, sourceOrigin: 'UNKNOWN' });
            }
        }
    }
    return { evidence, readbacks };
}
const coreItem = (item: any) => ({ canonicalId: item.canonicalId, ownerBoundaryRef: item.ownerBoundaryRef, currency: item.currency, at: item.at, destination: item.destination, amount: item.amount, costCategory: item.costCategory, embeddedIn: item.embeddedIn });
/** Source-specific semantic joins. A signature over unrelated bytes is not a
 * statement about submitted money, treatment, coverage or an independent mark. */
function bindSources(e: OutcomeEstimand, assignments: EconomicAssignment[], accounting: EconomicAccountingSubmission[], cut: Awaited<ReturnType<typeof resolveEconomicSourceCut>>) {
    const body = (ref: EconomicRef | null) => ref ? economicSourceContent(cut.readbacks.get(ref.id)) : null;
    const mark = (ref: EconomicRef | null, ok: boolean) => {
        if (!ref || ok)
            return;
        const v = cut.evidence.find(v => same(v.ref, ref));
        if (v)
            v.status = 'UNVERIFIED';
    };
    if (e.assignment.kind === 'INDEPENDENT_CLUSTER_RANDOMIZATION') {
        const p = body(e.assignment.protocolRef);
        mark(e.assignment.protocolRef, p?.schema === 'finnor.s2.economic-assignment-protocol.v1' && same(p.probabilities, e.assignment.probabilities) && same(p.clusterIds, e.clusters.map(c => c.id)) && same(p.controllerIds, e.controllers.map(c => c.id)) && same(p.populationRef, e.populationRef) && same(p.mandateRef, e.mandateRef) && p.randomization === 'INDEPENDENT_CRYPTO_CATEGORICAL_V1');
    }
    for (const a of assignments) {
        const p = body(a.assignmentRef);
        mark(a.assignmentRef, p?.schema === 'finnor.s2.economic-assignment.v1' && p.clusterId === a.clusterId && p.controllerId === a.controllerId && p.assignedAt === a.assignedAt && same(p.protocolRef, a.protocolRef));
    }
    for (const s of accounting) {
        const manifest = body(s.sourceManifestRef);
        mark(s.sourceManifestRef, manifest?.schema === 'finnor.economic-source-manifest.v1' && same(manifest.ownerBoundaryRef, e.ownerBoundaryRef) && manifest.currency === e.currency && manifest.clusterId === s.clusterId && manifest.openingWealth === e.clusters.find(c => c.id === s.clusterId)?.openingWealth && same(manifest.ownershipWaterfallRef, e.ownershipWaterfallRef));
        for (const item of s.items) {
            const p = body(item.sourceRef);
            mark(item.sourceRef, (['finnor.economic-financial-statement.v1', 'finnor.economic-compute-meter.v1'].includes(p?.schema) && Array.isArray(p.items) && p.items.some((i: any) => same(i, coreItem(item)))) || (item.destination === 'RESIDUAL_EQUITY' && p?.schema === 'finnor.independent-owner-valuation.v1' && p.itemId === item.canonicalId && same(p.equityBounds, item.amount) && same(p.ownerBoundaryRef, item.ownerBoundaryRef) && p.currency === item.currency && p.asOf === item.at));
        }
        for (const t of s.sourceTotals) {
            const p = body(t.sourceRef);
            mark(t.sourceRef, (['finnor.economic-financial-statement.v1', 'finnor.economic-compute-meter.v1'].includes(p?.schema) && p.totals?.some((v: any) => same(v, { destination: t.destination, itemIds: t.itemIds, total: t.total }))) || (t.destination === 'RESIDUAL_EQUITY' && p?.schema === 'finnor.independent-owner-valuation.v1' && same(p.equityBounds, t.total) && same(t.itemIds, [p.itemId])));
        }
        for (const c of s.costCoverage) {
            if (c.itemIds.length === 0) {
                const p = body(c.zeroCostEvidenceRef);
                mark(c.zeroCostEvidenceRef, p?.schema === 'finnor.economic-cost-coverage.v1' && p.clusterId === s.clusterId && p.controllerId === s.controllerId && p.asOf === s.asOf && p.zeroCostCategories?.includes(c.category) && same(p.ownerBoundaryRef, e.ownerBoundaryRef));
            }
        }
        for (const v of s.valuations) {
            const p = body(v.signedAssessmentRef);
            mark(v.signedAssessmentRef, p?.schema === 'finnor.independent-owner-valuation.v1' && p.itemId === v.itemId && p.asOf === v.asOf && same(p.authorityRef, v.authorityRef) && same(p.methodRef, v.methodRef) && same(p.ownershipDebtRef, v.ownershipDebtRef) && same(p.independenceRef, v.independenceRef) && same(p.inputRefs, v.inputRefs) && same(p.conflictsBlindingRef, e.valuationProtocol.conflictsBlindingRef));
        }
        const liabilities = body(s.liabilityCoverageRef);
        mark(s.liabilityCoverageRef, liabilities?.schema === 'finnor.owner-liability-coverage.v1' && same(liabilities.ownerBoundaryRef, e.ownerBoundaryRef) && liabilities.asOf === s.asOf && liabilities.allOwnerLiabilitiesExamined === true && Array.isArray(liabilities.extraLiabilityIds) && same([...liabilities.extraLiabilityIds].sort(), s.items.filter(i => i.destination === 'EXTRA_LIABILITY').map(i => i.canonicalId).sort()));
        const conservation = body(s.conservationRef);
        mark(s.conservationRef, conservation?.schema === 'finnor.owner-conservation.v1' && same(conservation.ownerBoundaryRef, e.ownerBoundaryRef) && same(conservation.ownershipWaterfallRef, e.ownershipWaterfallRef) && conservation.asOf === s.asOf && conservation.distributionsRemovedFromResidual === true && conservation.residualIncludesEntityDebt === true && conservation.internalTransfersEliminated === true && Array.isArray(conservation.economicItemIds) && same([...conservation.economicItemIds].sort(), s.items.map(i => i.canonicalId).sort()));
    }
}
export async function registerEnterpriseOutcomeEstimand(ctx: PeMutationContext, input: {
    estimand: unknown;
    rightsRef: string;
    idempotencyKey?: string;
    mode?: 'PROSPECTIVE' | 'RETROSPECTIVE';
}) {
    const e = parseOutcomeEstimand(input.estimand), mode = input.mode ?? 'PROSPECTIVE', now = new Date().toISOString(), key = input.idempotencyKey ?? e.key, semanticRequestDigest = economicHash({ estimand: e, mode, rightsRef: input.rightsRef });
    const replay = await readEconomicReplay(ctx, 'PREREGISTRATION', key, semanticRequestDigest);
    if (replay)
        return replay;
    if (mode === 'PROSPECTIVE' && (Date.parse(e.assignmentAt) <= Date.now() || Date.parse(e.outcomeAccessNotBefore) <= Date.now() || Date.parse(e.registeredAt) > Date.now() + 1000))
        fail('QUESTION_MUST_FREEZE_BEFORE_ASSIGNMENT_AND_OUTCOME_ACCESS');
    const cut = await resolveEconomicSourceCut(ctx, collectEconomicRefs(e), e), mandate = cut.readbacks.get(e.mandateRef.id)?.reference.content as any;
    if (mandate && (mandate.tenantId !== ctx.auth.tenantId || mandate.principalId !== economicActor(ctx) || mandate.rightsRef !== input.rightsRef || Date.parse(mandate.validUntil) <= Date.now()))
        fail('AUTHORIZED_MANDATE_BINDING_INVALID');
    const prior = e.correctionOf ? await readStoredEconomicRecord(ctx, e.correctionOf.id) : null;
    if (prior && (prior.kind !== 'PREREGISTRATION' || !same(prior.ref, e.correctionOf)))
        fail('ORIGINAL_ESTIMAND_VERSION_REQUIRED');
    return persistEconomicRecord(ctx, { kind: 'PREREGISTRATION', ...(mode === 'PROSPECTIVE' ? { freezeBefore: e.assignmentAt } : {}), payload: { estimand: e, mode, sourceQualification: cut.evidence.every(v => v.status === 'RESOLVED_AUTHENTICATED') ? 'AUTHENTICATED_SOURCE_COMMITMENTS_ONLY' : 'PREPARED_UNPROTECTED_OR_SOURCE_GAPS', sourceCut: cut.evidence }, rightsRef: input.rightsRef, idempotencyKey: key, semanticRequestDigest, ...(prior ? { revisionOf: prior.ref.id } : {}), validAt: e.registeredAt, horizon: 'H1', uncertainty: 'SOURCE_OR_COST_GAPS', dependencies: collectEconomicRefs(e) });
}
export async function readEnterpriseEconomicRecord(ctx: PeMutationContext, input: {
    id: string;
    protectedReadback?: boolean;
}) {
    const record = await readStoredEconomicRecord(ctx, input.id);
    if (!input.protectedReadback)
        return record;
    const cut = await resolveEconomicSourceCut(ctx, [record.ref]);
    const accepted = cut.readbacks.get(record.ref.id);
    return { record, protectedReadback: accepted ?? null, qualification: accepted ? 'AUTHENTICATED_IMMUTABLE_BYTES_ONLY' : 'PROTECTED_COMMITMENT_UNAVAILABLE', executionAuthorityGranted: false };
}
export const readEnterpriseEconomicHistory = (ctx: PeMutationContext, input: {
    estimandId: string;
    knowledgeAt?: string;
}) => listStoredEconomicHistory(ctx, input.estimandId, input.knowledgeAt);
export async function appendEnterpriseEconomicRecord(ctx: PeMutationContext, input: {
    kind: Extract<EconomicRecordKind, 'SOURCE' | 'ASSIGNMENT' | 'EXPOSURE' | 'MEASUREMENT' | 'VALUATION' | 'COST' | 'CORRECTION' | 'INVALIDATION'>;
    estimandRefId: string;
    record: Record<string, unknown>;
    sourceRefs: EconomicRef[];
    validAt: string;
    revisionOf?: string;
    idempotencyKey: string;
}) {
    const semanticRequestDigest = economicHash(input), replay = await readEconomicReplay(ctx, input.kind, input.idempotencyKey, semanticRequestDigest);
    if (replay)
        return replay;
    const original = await readStoredEconomicRecord(ctx, input.estimandRefId);
    if (original.kind !== 'PREREGISTRATION')
        fail('OUTCOME_ESTIMAND_REQUIRED');
    const e = parseOutcomeEstimand(original.payload.estimand), cut = await resolveEconomicSourceCut(ctx, input.sourceRefs, e);
    return persistEconomicRecord(ctx, { kind: input.kind, semanticRequestDigest, payload: { record: input.record, sourceRefs: input.sourceRefs, sourceQualification: cut.evidence, physicalCompletionGranted: false, economicCreditGranted: false }, rightsRef: String(original.event.rightsRef), idempotencyKey: input.idempotencyKey, estimandId: original.ref.id, ...(input.revisionOf ? { revisionOf: input.revisionOf } : {}), validAt: input.validAt, horizon: input.kind === 'ASSIGNMENT' || input.kind === 'EXPOSURE' ? 'H0' : 'H1', uncertainty: 'SOURCE_OR_COST_GAPS', dependencies: input.sourceRefs });
}
export async function assessEnterpriseEconomicAttribution(ctx: PeMutationContext, input: {
    estimandId: string;
    lookAt: string;
    assignments: EconomicAssignment[];
    accounting: unknown[];
    idempotencyKey: string;
    priorAssessmentId?: string;
    computeCost: EconomicAssessmentInput['computeCost'];
    noticeResolutionRefs?: EconomicRef[];
}) {
    const semanticRequestDigest = economicHash(input), replay = await readEconomicReplay(ctx, 'ASSESSMENT', input.idempotencyKey, semanticRequestDigest);
    if (replay)
        return replay;
    const original = await readStoredEconomicRecord(ctx, input.estimandId);
    if (original.kind !== 'PREREGISTRATION')
        fail('OUTCOME_ESTIMAND_REQUIRED');
    const e = parseOutcomeEstimand(original.payload.estimand), accounting = input.accounting.map(parseEconomicAccountingSubmission), assessedAt = new Date().toISOString();
    const prior = input.priorAssessmentId ? await readStoredEconomicRecord(ctx, input.priorAssessmentId) : null;
    if (prior && (prior.kind !== 'ASSESSMENT' || prior.estimandId !== original.ref.id))
        fail('PRIOR_ASSESSMENT_CONTEXT_MISMATCH');
    const request = { schema: 'finnor.economic-assessment-request.v1' as const, tenantId: ctx.auth.tenantId, principalId: economicActor(ctx), estimand: e, estimandRef: original.ref, assessedAt, lookAt: input.lookAt, assignments: input.assignments, accounting, priorAssessmentRef: prior?.ref ?? null, computeCost: input.computeCost };
    parseEconomicAssessmentInput({ ...request, evidence: [] });
    const noticeResolutionRefs = input.noticeResolutionRefs ?? [];
    if (noticeResolutionRefs.length > 256) fail('ECONOMIC_NOTICE_RESOLUTION_LIMIT');
    const cut = await resolveEconomicSourceCut(ctx, collectEconomicRefs({ request, noticeResolutionRefs }), e);
    bindSources(e, input.assignments, accounting, cut);
    const nativeHistory = economicHistoryManifest(await listStoredEconomicHistory(ctx, original.ref.id, assessedAt));
    const eventReadbacks: Record<string, unknown>[] = [];
    let protectedEventsComplete = true;
    const historyReadStart = Date.now();
    for (let offset = 0; offset < nativeHistory.records.length; offset += 4) {
        if (Date.now() - historyReadStart > 30000)
            fail('ECONOMIC_HISTORY_READ_BUDGET_EXCEEDED');
        const results = await Promise.allSettled(nativeHistory.records.slice(offset, offset + 4).map(v => readOwnerTransportEvent(identity(ctx), v.eventId)));
        for (const result of results) {
            if (result.status === 'fulfilled') {
                const { detail: _detail, ...eventMetadata } = result.value.event as any;
                eventReadbacks.push({ event: eventMetadata, receipt: result.value.receipt, qualification: result.value.qualification,
                    detailPreimage: { availability: 'IMMUTABLE_PROTECTED_EVENT_BY_ID', identity: eventMetadata.eventId, revisionRef: eventMetadata.revisionRef, contentDigest: eventMetadata.contentDigest } });
            }
            else {
                if (result.reason instanceof LedgerFault && /SIGNATURE|BINDING|PREIMAGE/.test(result.reason.code))
                    throw result.reason;
                protectedEventsComplete = false;
            }
        }
    }
    if (!nativeHistory.complete || !protectedEventsComplete || nativeHistory.records.some(v => v.kind === 'INVALIDATION')) {
        for (const v of cut.evidence)
            v.status = 'UNVERIFIED';
    }
    const registered = cut.evidence.find(v => same(v.ref, original.ref));
    if (registered && original.payload.mode !== 'PROSPECTIVE')
        registered.status = 'UNVERIFIED';
    const nativeProgrammeSemantics = e.controllers.every(c => [c.programmeRef, ...c.policyRefs].every(ref => economicSourceContent(cut.readbacks.get(ref.id))?.schema === 'finnor.contingent-policy.v1') && c.interventionRefs.every(ref => ['finnor.intervention-specification.v1', 'finnor.intervention-model.v1'].includes(economicSourceContent(cut.readbacks.get(ref.id))?.schema))) && economicSourceContent(cut.readbacks.get(e.allocationRef.id))?.schema === 'finnor.allocation-reservation.v1';
    if (registered?.protectionDomain === 'REVIEWED_PROTECTED_DOMAIN' && original.payload.mode === 'PROSPECTIVE' && nativeProgrammeSemantics)
        registered.sourceOrigin = 'FIELD';
    const meter = input.computeCost.meteringRef && cut.readbacks.get(input.computeCost.meteringRef.id)?.reference.content as any;
    if (meter && (!same(meter.amount, input.computeCost.amount) || meter.schema !== 'finnor.economic-compute-meter.v1' || !same(meter.ownerBoundaryRef, e.ownerBoundaryRef) || meter.currency !== e.currency || !same(meter.pricebookRef, input.computeCost.pricebookRef) || !same(meter.estimandRef, original.ref) || meter.lookAt !== input.lookAt || meter.methodVersion !== e.version)) {
        const v = cut.evidence.find(v => same(v.ref, input.computeCost.meteringRef));
        if (v)
            v.status = 'UNVERIFIED';
    }
    const monetaryNotices = nativeHistory.records.filter(v => ECONOMIC_MONETARY_NOTICE_KINDS.has(v.kind));
    const financialRefs = collectEconomicRefs(accounting.flatMap(s => [
        ...s.items.map(i => i.sourceRef), ...s.sourceTotals.map(v => v.sourceRef),
        ...s.valuations.map(v => v.signedAssessmentRef), ...s.costCoverage.map(v => v.zeroCostEvidenceRef),
        s.liabilityCoverageRef, s.conservationRef,
    ]).concat([input.computeCost.meteringRef]));
    const noticeQualification = monetaryNotices.map(notice => {
        const resolution = noticeResolutionRefs.find(ref => {
            const body = economicSourceContent(cut.readbacks.get(ref.id));
            const descriptor = cut.evidence.find(v => same(v.ref, ref));
            const authorityRef = body?.authorityRef;
            const authority = authorityRef && economicSourceContent(cut.readbacks.get(authorityRef.id));
            if (!descriptor || descriptor.status !== 'RESOLVED_AUTHENTICATED' || !descriptor.independent || Date.parse(descriptor.knowledgeAt) < Date.parse(notice.knowledgeAt) || Date.parse(descriptor.knowledgeAt) > Date.parse(assessedAt)
                || body?.schema !== 'finnor.independent-economic-notice-resolution.v1' || body.independent !== true
                || !same(body.noticeRef ?? null, notice.ref) || !same(body.estimandRef ?? null, original.ref) || !same(body.ownerBoundaryRef ?? null, e.ownerBoundaryRef) || body.currency !== e.currency || body.lookAt !== input.lookAt
                || !authorityRef || !e.valuationProtocol.authorityRefs.some(v => same(v, authorityRef)) || authority?.economicNoticeResolution !== true
                || !['INCLUDED', 'REFUTED'].includes(body.disposition) || !Array.isArray(body.correctedSourceRefs)) return false;
            return body.disposition === 'REFUTED' || body.correctedSourceRefs.length > 0 && body.correctedSourceRefs.every((r: EconomicRef) => financialRefs.some(v => same(v, r)) && cut.evidence.some(v => same(v.ref, r) && v.status === 'RESOLVED_AUTHENTICATED'));
        });
        const descriptor = resolution && cut.evidence.find(v => same(v.ref, resolution));
        return { noticeRef: notice.ref, kind: notice.kind, resolutionRef: resolution ?? null,
            status: resolution ? 'INDEPENDENTLY_RESOLVED' : 'UNRESOLVED',
            matureFieldResolution: !!descriptor && descriptor.sourceOrigin === 'FIELD' && descriptor.protectionDomain === 'REVIEWED_PROTECTED_DOMAIN' };
    });
    const unresolvedNotices = noticeQualification.filter(v => v.status === 'UNRESOLVED');
    if (unresolvedNotices.length) {
        for (const descriptor of cut.evidence)
            if (same(descriptor.ref, original.ref) || input.computeCost.meteringRef && same(descriptor.ref, input.computeCost.meteringRef)) descriptor.status = 'UNVERIFIED';
    }
    let assessment = assessEconomicAttribution({ ...request, evidence: cut.evidence });
    if (unresolvedNotices.length || assessment.supportedHorizon === 'H2' && noticeQualification.some(v => !v.matureFieldResolution)) {
        const { ref: _ref, ...body } = assessment;
        const reason = unresolvedNotices.length ? 'REGISTERED_SUPPORT_NOT_RECONFIRMED_AFTER_UNRESOLVED_MONETARY_NOTICE' : 'INDEPENDENT_NOTICE_RESOLUTION_IS_NOT_MATURE_FIELD_EVIDENCE';
        const qualifiedBody: Omit<EconomicAssessment, 'ref'> = { ...body, supportedHorizon: 'H1', evidenceClass: 'PARTIAL',
            ...(unresolvedNotices.length ? { completeCosts: false,
                accounting: body.accounting.map(v => ({ ...v, wealth: null, completeCosts: false, supportedHorizon: 'H1' as const, reasons: [...v.reasons, reason] })),
                contrasts: body.contrasts.map(v => ({ ...v, identification: 'UNIDENTIFIED' as const, interval: null, scoreInterval: null, samplingRadiusUpper: null, reasons: [...v.reasons, reason] })),
                uncertainty: { ...body.uncertainty, coverage: 'SUPPORT_BOUNDS_ONLY', sampling: 'UNIDENTIFIED', identification: reason, cost: 'UNKNOWN_DUE_TO_UNRESOLVED_MONETARY_NOTICES' },
                compute: { ...body.compute, moneyStatus: 'UNKNOWN' as const } } : {}), reasons: [...body.reasons, reason] };
        const digest = economicHash(qualifiedBody);
        assessment = immutableEconomic({ ...qualifiedBody, ref: { owner: 'S7', id: 'economic-assessment:' + digest, version: e.version, contentDigest: digest } });
    }
    const usage = assessment.compute;
    const computeBody: Omit<S7ModelComputeInvocation, 'id'> = { schema: 'finnor.model-compute-invocation.v1', semanticOwner: 'S7', tenantId: ctx.auth.tenantId, principalId: economicActor(ctx), rightsRef: String(original.event.rightsRef), inputRef: original.ref, outputRefs: [assessment.ref.id], requestedRoute: 'LOCAL_EXACT_BOUNDED', actualRoute: 'LOCAL_EXACT_BOUNDED', fallbacks: [], backend: { name: 'finnor-bigint-bounded-ht', version: e.version, sourceDigests: usage.sourceDigests, identityBasis: 'LOADED_SOURCE_SNAPSHOT' }, harness: { nodeVersion: process.version, platform: process.platform, architecture: process.arch, configuration: e.budgets, deterministicReplayClaimed: false }, attempts: [{ startedAt: assessedAt, finishedAt: new Date().toISOString(), status: 'COMPLETED' }], randomness: { used: false, seed: null }, usage: { elapsedMs: usage.elapsedMs, processCpuUserMicros: usage.processCpuUserMicros, processCpuSystemMicros: usage.processCpuSystemMicros, rssBeforeBytes: usage.rssBeforeBytes, rssAfterBytes: usage.rssAfterBytes, accountingScope: 'PROCESS_INTERVAL_INCLUSIVE_NOT_ISOLATED_PEAK' }, cost: { money: input.computeCost.amount, pricebookRef: input.computeCost.pricebookRef, meteringRef: input.computeCost.meteringRef, status: assessment.completeCosts ? 'METERED_SOURCE_CONDITIONAL' : 'LOCAL_COST_UNMETERED', sourceReadCalls: cut.evidence.length }, admission: { status: 'BLOCKED_EXTERNAL', receipt: null } };
    const computeInvocation = { ...computeBody, id: 'compute:' + economicHash(computeBody) };
    return persistEconomicRecord(ctx, { kind: 'ASSESSMENT', semanticRequestDigest, payload: { assessment, computeInvocation, inputs: request, noticeResolutionRefs, noticeQualification, unresolvedNotices, nativeHistory, protectedEventsComplete, eventReadbacks, nativeProgrammeSemantics, sourceCut: cut.evidence, sourceReadbacks: [...cut.readbacks.values()].map(v => ({ reference: { owner: v.reference.owner, id: v.reference.id, version: v.reference.version, contentDigest: v.reference.contentDigest }, receipt: v.receipt, protectionDomain: v.protectionDomain, qualification: v.qualification, preimageAvailability: 'IMMUTABLE_PROTECTED_REFERENCE_BY_ID' })) }, rightsRef: String(original.event.rightsRef), idempotencyKey: input.idempotencyKey, estimandId: original.ref.id, ...(input.priorAssessmentId ? { revisionOf: input.priorAssessmentId } : {}), validAt: input.lookAt, horizon: assessment.supportedHorizon, uncertainty: assessment.contrasts.some(c => c.identification === 'UNIDENTIFIED') ? 'UNIDENTIFIED' : 'DESIGN_CONDITIONAL_BOUNDS', dependencies: [original.ref, ...collectEconomicRefs({ request, noticeResolutionRefs }).filter(r => r.id !== original.ref.id), ...nativeHistory.records.filter(v => v.ref.id !== original.ref.id).map(v => v.ref)] });
}
export async function readEnterpriseEconomicExecutionEvidence(ctx: PeMutationContext, input: {
    estimandId: string;
    obligationId: string;
}) { await readStoredEconomicRecord(ctx, input.estimandId); return readOwnerTransportExecutionHandoff(identity(ctx), input.obligationId); }
export async function registerEnterpriseEconomicBenchmark(ctx: PeMutationContext, input: {
    registration: unknown;
    rightsRef: string;
    idempotencyKey?: string;
}) {
    const registration = parseEconomicBenchmarkRegistration(input.registration), semanticRequestDigest = economicHash({ registration, rightsRef: input.rightsRef }), key = input.idempotencyKey ?? registration.key, replay = await readEconomicReplay(ctx, 'BENCHMARK_REGISTRATION', key, semanticRequestDigest);
    if (replay)
        return replay;
    const estimandRecord = await readStoredEconomicRecord(ctx, registration.estimandRef.id);
    if (estimandRecord.kind !== 'PREREGISTRATION' || !same(estimandRecord.ref, registration.estimandRef))
        fail('BENCHMARK_ESTIMAND_BINDING_INVALID');
    const estimand = parseOutcomeEstimand(estimandRecord.payload.estimand);
    if (registration.controllers.some(c => { const e = estimand.controllers.find(v => v.id === c.id); return !e || e.role !== c.role || !same(e.programmeRef, c.pinnedVersionRef); }))
        fail('BENCHMARK_PINNED_REGIMES_MUST_MATCH_ESTIMAND');
    if (Date.now() >= Date.parse(estimand.outcomeAccessNotBefore) || Date.parse(registration.registeredAt) > Date.parse(estimand.outcomeAccessNotBefore))
        fail('BENCHMARK_MUST_FREEZE_BEFORE_SCORED_ACCESS');
    if (Date.parse(registration.registeredAt) > Date.now() + 1000)
        fail('BENCHMARK_REGISTRATION_CLOCK_INVALID');
    const cut = await resolveEconomicSourceCut(ctx, collectEconomicRefs(registration));
    return persistEconomicRecord(ctx, { kind: 'BENCHMARK_REGISTRATION', freezeBefore: estimand.outcomeAccessNotBefore, semanticRequestDigest, payload: { registration, sourceCut: cut.evidence }, rightsRef: input.rightsRef, idempotencyKey: key, validAt: registration.registeredAt, horizon: 'H1', uncertainty: 'SOURCE_OR_COST_GAPS', dependencies: collectEconomicRefs(registration) });
}
export async function assessEnterpriseEconomicBenchmark(ctx: PeMutationContext, input: {
    registrationId: string;
    assessments: Array<{
        controllerId: string;
        recordId: string;
        matchedEnvelopeRef: EconomicRef;
        protocolRef: EconomicRef;
        independentEvaluatorRef: EconomicRef;
    }>;
    gates: unknown[];
    idempotencyKey: string;
}) {
    const semanticRequestDigest = economicHash(input), replay = await readEconomicReplay(ctx, 'BENCHMARK_ASSESSMENT', input.idempotencyKey, semanticRequestDigest);
    if (replay)
        return replay;
    const stored = await readStoredEconomicRecord(ctx, input.registrationId);
    if (stored.kind !== 'BENCHMARK_REGISTRATION')
        fail('REGISTERED_BENCHMARK_REQUIRED');
    const registration = parseEconomicBenchmarkRegistration(stored.payload.registration), assessedAt = new Date().toISOString();
    const assessmentRecords: Awaited<ReturnType<typeof readStoredEconomicRecord>>[] = [];
    const assessments = await Promise.all(input.assessments.map(async (a) => {
        const record = await readStoredEconomicRecord(ctx, a.recordId);
        if (record.kind !== 'ASSESSMENT')
            fail('DURABLE_OWNER_ASSESSMENT_REQUIRED');
        assessmentRecords.push(record);
        return { controllerId: a.controllerId, assessment: record.payload.assessment as EconomicAssessment, matchedEnvelopeRef: a.matchedEnvelopeRef, protocolRef: a.protocolRef, independentEvaluatorRef: a.independentEvaluatorRef };
    }));
    const benchmarkOriginal = await readStoredEconomicRecord(ctx, registration.estimandRef.id), benchmarkEstimand = parseOutcomeEstimand(benchmarkOriginal.payload.estimand);
    const request = { schema: 'finnor.economic-benchmark-request.v1', registration, registrationRef: stored.ref, assessedAt, assessments, gates: input.gates };
    // Computed score preimages are authenticated through their native immutable wrappers.
    const scoreIds = new Set(assessments.map(v => v.assessment.ref.id));
    const benchmarkRefs = [...collectEconomicRefs(request).filter(v => !scoreIds.has(v.id)), ...assessmentRecords.map(v => v.ref)];
    const cut = await resolveEconomicSourceCut(ctx, benchmarkRefs, benchmarkEstimand);
    for (const gate of input.gates as any[]) {
        for (const ref of gate.evidenceRefs ?? []) {
            const p = economicSourceContent(cut.readbacks.get(ref.id));
            if (!p || p.schema !== 'finnor.independent-economic-benchmark-gate.v1' || p.controllerId !== gate.controllerId || !same(p.gate, (({ evidenceRefs, ...core }) => core)(gate))) {
                const v = cut.evidence.find(v => same(v.ref, ref));
                if (v)
                    v.status = 'UNVERIFIED';
            }
        }
    }
    parseEconomicBenchmarkInput({ ...request, evidence: [] });
    for (const a of assessments) {
        const p = cut.readbacks.get(a.independentEvaluatorRef.id)?.reference.content as any;
        const pinned = registration.controllers.find(c => c.id === a.controllerId)?.pinnedVersionRef;
        if (assessmentRecords.some(v => !cut.readbacks.has(v.ref.id)) || p?.schema !== 'finnor.independent-economic-evaluation.v1' || p.controllerId !== a.controllerId || !same(p.assessmentRef, a.assessment.ref) || !same(p.registrationRef, stored.ref) || !same(p.pinnedVersionRef, pinned)) {
            const v = cut.evidence.find(v => same(v.ref, a.independentEvaluatorRef));
            if (v)
                v.status = 'UNVERIFIED';
        }
    }
    const original = await readStoredEconomicRecord(ctx, registration.estimandRef.id), estimand = parseOutcomeEstimand(original.payload.estimand);
    for (const c of registration.controllers) {
        const e = estimand.controllers.find(v => v.id === c.id);
        if (!e || e.role !== c.role || !same(e.programmeRef, c.pinnedVersionRef)) {
            for (const v of cut.evidence)
                v.status = 'UNVERIFIED';
        }
    }
    const comparisonHistory = await listStoredEconomicHistory(ctx, registration.estimandRef.id, assessedAt);
    for (const record of assessmentRecords) {
        const history = comparisonHistory;
        if (!history.complete || history.records.some(v => v.kind === 'INVALIDATION') || economicHistoryHasNewNotices(history, economicAssessmentKnowledgeCut(record))) {
            for (const a of assessments.filter(v => same(v.assessment.ref, (record.payload.assessment as EconomicAssessment).ref))) {
                const descriptor = cut.evidence.find(v => same(v.ref, a.independentEvaluatorRef));
                if (descriptor) descriptor.status = 'UNVERIFIED';
            }
        }
    }
    const assessment = assessEconomicBenchmark({ ...request, evidence: cut.evidence });
    return persistEconomicRecord(ctx, { kind: 'BENCHMARK_ASSESSMENT', estimandId: registration.estimandRef.id, semanticRequestDigest, payload: { assessment, inputs: request, sourceCut: cut.evidence }, rightsRef: String(stored.event.rightsRef), idempotencyKey: input.idempotencyKey, validAt: assessedAt, horizon: 'H1', uncertainty: 'SOURCE_OR_COST_GAPS', dependencies: benchmarkRefs });
}

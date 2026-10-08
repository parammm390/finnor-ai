/** S7's reconciled aggregates and attenuated S8 learning readbacks. */
import { EconomicContractError, economicHash, parseOutcomeEstimand, sumEconomicIntervals } from '../../epistemic-runtime/src/economic-attribution';
import type { EconomicAssessment, EconomicRef } from '../../shared-types/src/economic-attribution';
import { resolveEconomicOwnerReference } from '../../governed-execution/src/owner-transport';
import { economicActor, persistEconomicRecord, readEconomicReplay, readStoredEconomicRecord, listStoredEconomicHistory, economicHistoryManifest, economicAssessmentKnowledgeCut, economicHistoryHasNewNotices } from './economic-store';
import type { PeMutationContext } from './types';
const fail = (code: string): never => { throw new EconomicContractError(code); };
const same = (a: unknown, b: unknown) => economicHash(a) === economicHash(b);
export async function reconcileEnterpriseEconomicAggregate(ctx: PeMutationContext, input: {
    level: 'PROGRAMME' | 'COMPANY' | 'PORTFOLIO';
    ownerBoundaryRef: EconomicRef;
    assessmentIds: string[];
    jointAssessmentId?: string;
    idempotencyKey: string;
}) {
    if (!input.assessmentIds.length || input.assessmentIds.length > 128 || new Set(input.assessmentIds).size !== input.assessmentIds.length)
        fail('AGGREGATE_COMPONENT_SET_INVALID');
    const semanticRequestDigest = economicHash(input), replay = await readEconomicReplay(ctx, 'AGGREGATION', input.idempotencyKey, semanticRequestDigest);
    if (replay)
        return replay;
    const ids = [...new Set([...input.assessmentIds, ...(input.jointAssessmentId ? [input.jointAssessmentId] : [])])], components = [];
    for (const id of ids) {
        const record = await readStoredEconomicRecord(ctx, id);
        if (record.kind !== 'ASSESSMENT' || !record.estimandId)
            fail('DURABLE_ECONOMIC_ASSESSMENT_REQUIRED');
        const original = await readStoredEconomicRecord(ctx, record.estimandId!), e = parseOutcomeEstimand(original.payload.estimand), a = record.payload.assessment as EconomicAssessment;
        if (!same(e.ownerBoundaryRef, input.ownerBoundaryRef))
            fail('AGGREGATE_OWNER_BOUNDARY_UNREGISTERED');
        const history = economicHistoryManifest(await listStoredEconomicHistory(ctx, original.ref.id));
        components.push({ record, original, e, a, history });
    }
    const first = components[0]!;
    if (components.some(c => c.e.currency !== first.e.currency || c.a.lookAt !== first.a.lookAt || !same(c.e.ownershipWaterfallRef, first.e.ownershipWaterfallRef)))
        fail('AGGREGATE_CURRENCY_DATE_OR_WATERFALL_MISMATCH');
    const selected = components.filter(c => input.assessmentIds.includes(c.record.ref.id)), joint = input.jointAssessmentId ? components.find(c => c.record.ref.id === input.jointAssessmentId) : undefined;
    const seen = new Set<string>(), overlaps: string[] = [];
    for (const c of selected)
        for (const s of (c.record.payload.inputs as any).accounting as any[])
            for (const i of s.items) {
                if (seen.has(i.canonicalId))
                    overlaps.push(i.canonicalId);
                seen.add(i.canonicalId);
            }
    if (joint) {
        const jointItems = new Set(((joint.record.payload.inputs as any).accounting as any[]).flatMap(s => s.items.map((i: any) => i.canonicalId)));
        if ([...seen].some(id => !jointItems.has(id)))
            fail('JOINT_ESTIMAND_DOES_NOT_COVER_COMPONENT_ITEMS');
    }
    const current = components.every(c => c.history.complete && !c.history.records.some(v => v.kind === 'INVALIDATION') && !economicHistoryHasNewNotices(c.history, economicAssessmentKnowledgeCut(c.record)));
    const observedOwnerWealth = current ? (joint ? sumEconomicIntervals(joint.a.accounting.map(a => a.wealth)) : overlaps.length ? null : sumEconomicIntervals(selected.flatMap(c => c.a.accounting.map(a => a.wealth)))) : null;
    const payload = { schema: 'finnor.s7.reconciled-aggregate.v1', level: input.level, ownerBoundaryRef: input.ownerBoundaryRef, currency: first.e.currency, asOf: first.a.lookAt, componentRefs: selected.map(c => c.record.ref), jointAssessmentRef: joint?.record.ref ?? null, observedOwnerWealth, overlappingItemIds: [...new Set(overlaps)], componentAssessments: selected.map(c => ({ ref: c.record.ref, population: c.a.population, contrasts: c.a.contrasts, completeCosts: c.a.completeCosts, supportedHorizon: c.a.supportedHorizon, uncertainty: c.a.uncertainty })), jointProgrammeContrasts: current ? joint?.a.contrasts ?? null : null, aggregateCausalCreditIdentified: !!joint && current && joint.a.contrasts.every(c => c.identification === 'DESIGN_BASED_CONDITIONAL'), allocation: 'JOINT_AND_UNALLOCATED_VALUE_RETAINED; COMPONENT_CONTRASTS_ARE_NOT_ADDED', historyCuts: components.map(c => ({ estimandRef: c.original.ref, ...c.history })), actionRewards: [], actionCreditsIdentified: false, executionAuthorityGranted: false, capabilityAdmissionGranted: false, qualification: observedOwnerWealth ? 'RECONCILED_OBSERVED_OWNER_WEALTH_WITH_COMPONENT_QUALIFICATION' : 'OVERLAP_UNKNOWN_INPUT_OR_HISTORY_GAP_REQUIRES_JOINT_ESTIMAND' };
    return persistEconomicRecord(ctx, { kind: 'AGGREGATION', semanticRequestDigest, payload, rightsRef: String(first.original.event.rightsRef), idempotencyKey: input.idempotencyKey, validAt: first.a.lookAt, horizon: current && joint?.a.supportedHorizon === 'H2' ? 'H2' : 'H1', uncertainty: 'JOINT_AND_UNALLOCATED_VALUE_PRESERVED', dependencies: [input.ownerBoundaryRef, ...components.map(c => c.record.ref)] });
}
export async function readEnterpriseEconomicLearningAssessment(ctx: PeMutationContext, input: {
    assessmentId: string;
    protectedReadback?: boolean;
}) {
    const record = await readStoredEconomicRecord(ctx, input.assessmentId);
    if (!['ASSESSMENT', 'AGGREGATION', 'BENCHMARK_ASSESSMENT'].includes(record.kind))
        fail('PERMITTED_VERSIONED_ECONOMIC_ASSESSMENT_REQUIRED');
    const aggregateCuts = (record.payload.historyCuts as Array<{ estimandRef: EconomicRef; knowledgeAt: string }> | undefined) ?? [];
    const historyCuts = aggregateCuts.length ? await Promise.all(aggregateCuts.map(async v => ({ cut: v.knowledgeAt, history: await listStoredEconomicHistory(ctx, v.estimandRef.id) }))) : record.estimandId ? [{ cut: economicAssessmentKnowledgeCut(record), history: await listStoredEconomicHistory(ctx, record.estimandId) }] : [];
    const history = historyCuts.length === 1 ? historyCuts[0]!.history : historyCuts.length ? { complete: historyCuts.every(v => v.history.complete), records: historyCuts.flatMap(v => v.history.records) } : null;
    const stale = historyCuts.some(v => economicHistoryHasNewNotices(v.history, v.cut));
    const protectedReadback = input.protectedReadback ? await resolveEconomicOwnerReference({ semanticOwner: 'S8', tenantId: ctx.auth.tenantId, principalId: economicActor(ctx) }, record.ref, { purpose: 'CONSUMER' }) : null;
    return { schema: 'finnor.s8.economic-learning-input.v1', semanticOwner: 'S8', assessmentRef: record.ref, assessment: record.payload, history, protectedReadback, qualification: history && !history.complete ? 'INCOMPLETE_HISTORY' : history?.records.some(v => v.kind === 'INVALIDATION') ? 'INVALIDATED_REQUIRES_NEW_QUALIFICATION' : stale ? 'NEW_ECONOMIC_NOTICES_REQUIRE_REASSESSMENT' : 'OWNER_VERSIONED_QUALIFICATION_ONLY', actionRewards: [], causalActionCreditsGranted: false, estimatorPromotionGranted: false, executionAuthorityGranted: false };
}

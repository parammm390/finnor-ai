/** S7 scientific/accounting owner. Pure qualification consumes independently
 * resolved source descriptors; HTTP callers never supply this authority. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { canonical } from '../../governed-execution/src/protocol';
import { ECONOMIC_COST_CATEGORIES, type OutcomeEstimand, type EconomicRef, type EconomicInterval, type EconomicAccountingSubmission, type EconomicEvidenceResolution, type EconomicAssessmentInput, type EconomicAssessment, type EconomicAccountingResult, type EconomicBenchmarkRegistration, type EconomicBenchmarkInput, type EconomicBenchmarkAssessment } from '../../shared-types/src/economic-attribution';
export class EconomicContractError extends Error {
    constructor(readonly code: string, message = code) { super(message); }
}
const refuse = (code: string): never => { throw new EconomicContractError(code); };
/** S7's bounded semantic encoding has the same bytes as S6 canonical JSON.
 * Large scientific inputs stay outside Ring-0; protected records use strings. */
export function canonicalEconomic(value: unknown): string {
    let nodes = 0, bytes = 0;
    const parts: string[] = [];
    // Reuse only bounded property-name tokens within this traversal, never values.
    const keyTokens = new Map<string, { text: string; bytes: number }>();
    const keyOrders = new Map<string, string[]>();
    const push = (s: string, ascii = false, byteLength?: number) => {
        bytes += byteLength ?? (ascii ? s.length : Buffer.byteLength(s));
        if (bytes > 8388608)
            refuse('ECONOMIC_SEMANTIC_BYTE_LIMIT');
        parts.push(s);
    };
    function visit(v: unknown, depth: number) {
        if (++nodes > 1000000 || depth > 64)
            refuse('ECONOMIC_SEMANTIC_COMPLEXITY_LIMIT');
        if (v === null || typeof v === 'string' || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)) {
            push(JSON.stringify(v), typeof v !== 'string');
            return;
        }
        if (Array.isArray(v)) {
            push('[', true);
            v.forEach((x, i) => {
                if (i)
                    push(',', true);
                visit(x, depth + 1);
            });
            push(']', true);
            return;
        }
        if (v && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
            push('{', true);
            const r = v as Record<string, unknown>;
            const keys = Object.keys(r);
            const shape = keys.length <= 64 && keys.every(k => k.length <= 128) ? JSON.stringify(keys) : null;
            let ordered = shape === null ? undefined : keyOrders.get(shape);
            if (!ordered) {
                ordered = keys.sort((a, b) => a.localeCompare(b));
                if (shape !== null && keyOrders.size < 32)
                    keyOrders.set(shape, ordered);
            }
            ordered.forEach((k, i) => {
                if (i)
                    push(',', true);
                let token = keyTokens.get(k);
                if (!token) {
                    const text = JSON.stringify(k) + ':';
                    token = { text, bytes: Buffer.byteLength(text) };
                    if (k.length <= 128 && keyTokens.size < 128)
                        keyTokens.set(k, token);
                }
                push(token.text, false, token.bytes);
                visit(r[k], depth + 1);
            });
            push('}', true);
            return;
        }
        refuse('ECONOMIC_NON_CANONICAL_JSON');
    }
    visit(value, 0);
    return parts.join('');
}
export const economicHash = (v: unknown) => createHash('sha256').update(canonicalEconomic(v)).digest('hex');
export function immutableEconomic<T>(v: T): T {
    if (v && typeof v === 'object') {
        for (const x of Object.values(v))
            immutableEconomic(x);
        Object.freeze(v);
    }
    return v;
}
const gcd = (a: bigint, b: bigint): bigint => {
    a = a < 0n ? -a : a;
    while (b) {
        const t = a % b;
        a = b;
        b = t;
    }
    return a;
};
class Q {
    readonly n: bigint;
    readonly d: bigint;
    constructor(n: bigint, d = 1n) {
        if (d === 0n)
            refuse('ZERO_DENOMINATOR');
        if (d < 0n) {
            n = -n;
            d = -d;
        }
        const g = gcd(n, d);
        this.n = n / g;
        this.d = d / g;
    }
    static dec(v: string) {
        if (typeof v !== 'string' || v.length > 36 || !/^\-?\d+(?:\.\d{1,12})?$/.test(v))
            refuse('INVALID_DECIMAL');
        const neg = v.startsWith('-'), [a, b = ''] = (neg ? v.slice(1) : v).split('.');
        return new Q(BigInt(a! + b) * (neg ? -1n : 1n), 10n ** BigInt(b.length));
    }
    add(b: Q) { return new Q(this.n * b.d + b.n * this.d, this.d * b.d); }
    sub(b: Q) { return new Q(this.n * b.d - b.n * this.d, this.d * b.d); }
    mul(b: Q) { const g = gcd(this.n, b.d), h = gcd(b.n, this.d); return new Q((this.n / g) * (b.n / h), (this.d / h) * (b.d / g)); }
    div(b: Q) { return new Q(this.n * b.d, this.d * b.n); }
    cmp(b: Q) { const x = this.n * b.d - b.n * this.d; return x < 0n ? -1 : x > 0n ? 1 : 0; }
    out(up: boolean) {
        const scale = 1000000000000n, n = this.n * scale;
        let v = n / this.d;
        if (n % this.d !== 0n && (up ? n > 0n : n < 0n))
            v += up ? 1n : -1n;
        const sign = v < 0n ? '-' : '', s = (v < 0n ? -v : v).toString().padStart(13, '0');
        return sign + s.slice(0, -12) + (s.slice(-12).replace(/0+$/, '') ? '.' + s.slice(-12).replace(/0+$/, '') : '');
    }
}
const ZERO = new Q(0n), ONE = new Q(1n), sum = (v: Q[]) => v.reduce((a, b) => a.add(b), ZERO), min = (v: Q[]) => v.reduce((a, b) => a.cmp(b) < 0 ? a : b), max = (v: Q[]) => v.reduce((a, b) => a.cmp(b) > 0 ? a : b);
type I = {
    l: Q;
    u: Q;
};
const interval = (v: EconomicInterval): I => ({ l: Q.dec(v.lower), u: Q.dec(v.upper) }), output = (v: I): EconomicInterval => ({ lower: v.l.out(false), upper: v.u.out(true) }), add = (a: I, b: I): I => ({ l: a.l.add(b.l), u: a.u.add(b.u) }), sub = (a: I, b: I): I => ({ l: a.l.sub(b.u), u: a.u.sub(b.l) }), scale = (a: I, b: Q): I => b.n >= 0n ? { l: a.l.mul(b), u: a.u.mul(b) } : { l: a.u.mul(b), u: a.l.mul(b) }, empty = (): I => ({ l: ZERO, u: ZERO });
/** ln(x) upper certificate: range reduction and atanh series, with an exact
 * positive remainder bound. No floating logarithm enters a claimed interval. */
function logUpper(x: Q): Q {
    if (x.cmp(ONE) < 0)
        refuse('LOG_DOMAIN');
    let k = 0;
    while (x.cmp(new Q(2n)) >= 0) {
        x = x.div(new Q(2n));
        k++;
    }
    const series = (y: Q) => {
        const a = y.sub(ONE).div(y.add(ONE)), a2 = a.mul(a);
        let power = a, total = ZERO;
        const terms = 24;
        for (let j = 0; j < terms; j++) {
            total = total.add(power.div(new Q(BigInt(2 * j + 1))));
            power = power.mul(a2);
        }
        return total.mul(new Q(2n)).add(power.mul(new Q(2n)).div(new Q(BigInt(2 * terms + 1)).mul(ONE.sub(a2))));
    };
    return series(x).add(series(new Q(2n)).mul(new Q(BigInt(k))));
}
function integerSqrt(n: bigint) {
    if (n < 0n)
        refuse('SQRT_DOMAIN');
    if (n < 2n)
        return n;
    let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
    for (;;) {
        const y = (x + n / x) / 2n;
        if (y >= x)
            return x;
        x = y;
    }
}
function sqrtUpper(v: Q) {
    const s = 1000000000000n, n = v.n * s * s;
    if (n < 0n)
        refuse('SQRT_DOMAIN');
    let x = integerSqrt(n / v.d);
    if (x * x * v.d < n)
        x++;
    return new Q(x, s);
}
const T = z.string().min(1).max(4096), D = z.string().regex(/^-?\d+(?:\.\d{1,12})?$/).max(36).refine(s => Q.dec(s).cmp(new Q(1000000000000n)) <= 0 && Q.dec(s).cmp(new Q(-1000000000000n)) >= 0), DT = z.string().datetime({ offset: true }), R = z.object({ owner: T.max(128), id: T, version: T.max(256), contentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const IS = z.object({ lower: D, upper: D }).strict().refine(v => Q.dec(v.lower).cmp(Q.dec(v.upper)) <= 0, 'Reversed interval');
const role = z.enum(['FINNOR', 'BUSINESS_AS_USUAL', 'PINNED_CURRENT_FINNOR', 'FRONTIER_SPECIALIST', 'MUSE', 'DOTS', 'EXPERT_PE']);
const costCategory = z.enum(ECONOMIC_COST_CATEGORIES), dest = z.enum(['CASH_OWNER', 'ADDITIONAL_CAPITAL', 'RESIDUAL_EQUITY', 'EXTRA_LIABILITY', 'COST_ONCE', 'EMBEDDED_COST', 'INTERNAL_TRANSFER']);
const assignment = z.discriminatedUnion('kind', [z.object({ kind: z.literal('INDEPENDENT_CLUSTER_RANDOMIZATION'), protocolRef: R, probabilities: z.record(D), independenceRef: R, exposureMappingRef: R, noBetweenClusterInterferenceRef: R }).strict(), z.object({ kind: z.literal('OBSERVATIONAL_UNIDENTIFIED'), protocolRef: R, exposureMappingRef: R, reasons: z.array(T).min(1).max(64) }).strict()]);
const estimandSchema = z.object({ schema: z.literal('finnor.outcome-estimand.v1'), version: z.literal('s7-bounded-owner-value-v1'), semanticOwner: z.literal('S7'), key: T.max(256), episodeId: T, mandateRef: R, ownerBoundaryRef: R, ownershipWaterfallRef: R, populationRef: R, currency: z.string().regex(/^[A-Z]{3}$/), registeredAt: DT, assignmentAt: DT, endpointAt: DT, horizonMonths: z.number().int().min(1).max(120), outcomeAccessNotBefore: DT,
    clusters: z.array(z.object({ id: T.max(256), weight: D, openingWealth: D, wealthSupport: IS, sourceManifestRef: R }).strict()).min(1).max(4096), controllers: z.array(z.object({ id: T.max(128), role, programmeRef: R, policyRefs: z.array(R).min(1).max(64), interventionRefs: z.array(R).min(1).max(64), adaptationRuleRef: R }).strict()).min(2).max(32), businessAsUsualId: T.max(128), assignment,
    discountSchedule: z.array(z.object({ at: DT, factor: D }).strict()).min(1).max(4096), capitalCarryRef: R, valuationProtocol: z.object({ ref: R, authorityRefs: z.array(R).min(1).max(32), methodRefs: z.array(R).min(1).max(32), independenceRef: R, conflictsBlindingRef: R, maxAsOfAgeMs: z.number().int().min(0).max(31536000000) }).strict(), analysis: z.object({ method: z.literal('BOUNDED_HT_HOEFFDING_V1'), alpha: z.literal('0.05'), registeredLooks: z.array(DT).min(1).max(32), minimumProbability: D, powerRegistrationRef: R }).strict(), allocationRef: R, requiredSourceRefs: z.array(R).max(256), assumptions: z.array(z.object({ id: T.max(128), meaning: T, status: z.enum(['SUPPORTED', 'DECLARED', 'UNKNOWN', 'CONTRADICTED']), evidenceRefs: z.array(R).max(32) }).strict()).max(64), budgets: z.object({ maximumClusters: z.number().int().min(1).max(4096), maximumItemsPerCluster: z.number().int().min(1).max(4096), maximumElapsedMs: z.number().int().min(1).max(30000), maximumInputBytes: z.number().int().min(1024).max(8388608) }).strict(), correctionOf: R.nullable() }).strict();
const unique = (v: string[], what: string) => {
    if (new Set(v).size !== v.length)
        refuse('DUPLICATE_' + what);
};
const sameRef = (a: EconomicRef, b: EconomicRef) => a.owner === b.owner && a.id === b.id && a.version === b.version && a.contentDigest === b.contentDigest;
export function parseOutcomeEstimand(value: unknown): OutcomeEstimand {
    const e = estimandSchema.parse(value) as OutcomeEstimand;
    unique(e.clusters.map(c => c.id), 'CLUSTER');
    unique(e.controllers.map(c => c.id), 'CONTROLLER');
    unique(e.analysis.registeredLooks, 'LOOK');
    unique(e.discountSchedule.map(v => v.at), 'DISCOUNT_DATE');
    unique(e.assumptions.map(v => v.id), 'ASSUMPTION');
    if (e.clusters.length > e.budgets.maximumClusters || sum(e.clusters.map(c => Q.dec(c.weight))).cmp(ONE) !== 0 || e.clusters.some(c => Q.dec(c.weight).cmp(ZERO) <= 0))
        refuse('FIXED_POPULATION_WEIGHTS_INVALID');
    if (e.controllers.filter(c => c.role === 'BUSINESS_AS_USUAL').length !== 1 || !e.controllers.some(c => c.id === e.businessAsUsualId && c.role === 'BUSINESS_AS_USUAL'))
        refuse('BUSINESS_AS_USUAL_REQUIRED');
    if (Date.parse(e.registeredAt) >= Date.parse(e.assignmentAt) || Date.parse(e.outcomeAccessNotBefore) < Date.parse(e.assignmentAt) || Date.parse(e.endpointAt) <= Date.parse(e.assignmentAt) || e.analysis.registeredLooks.some(t => Date.parse(t) > Date.parse(e.endpointAt)) || e.analysis.registeredLooks.some(t => Date.parse(t) < Date.parse(e.outcomeAccessNotBefore)))
        refuse('PREREGISTRATION_ALIGNMENT_INVALID');
    if (e.discountSchedule.some(v => Q.dec(v.factor).cmp(ZERO) <= 0 || Q.dec(v.factor).cmp(ONE) > 0))
        refuse('DISCOUNT_FACTOR_INVALID');
    if (e.assignment.protocolRef.owner !== 'S2' || e.allocationRef.owner !== 'S5' || e.mandateRef.owner !== 'BUSINESS_OWNER' || e.controllers.some(c => c.policyRefs.some(r => r.owner !== 'S4') || c.interventionRefs.some(r => r.owner !== 'S3')))
        refuse('SEMANTIC_OWNER_MISMATCH');
    if (e.assignment.kind === 'INDEPENDENT_CLUSTER_RANDOMIZATION') {
        const p = e.assignment.probabilities;
        if (Object.keys(p).length !== e.controllers.length || e.controllers.some(c => !Object.hasOwn(p, c.id) || Q.dec(p[c.id]!).cmp(Q.dec(e.analysis.minimumProbability)) < 0) || sum(Object.values(p).map(Q.dec)).cmp(ONE) !== 0 || Q.dec(e.analysis.minimumProbability).cmp(ZERO) <= 0)
            refuse('ASSIGNMENT_PROBABILITIES_INVALID');
    }
    return immutableEconomic(e);
}
const itemSchema = z.object({ canonicalId: T, sourceRef: R, ownerBoundaryRef: R, currency: z.string().regex(/^[A-Z]{3}$/), at: DT, destination: dest, amount: IS.nullable(), costCategory: costCategory.nullable(), embeddedIn: T.nullable(), reconciliationRefs: z.array(R).max(32) }).strict();
const accountSchema = z.object({ schema: z.literal('finnor.economic-accounting.v1'), estimandRef: R, clusterId: T, controllerId: T, knowledgeAt: DT, asOf: DT, closedLoopDays: z.number().int().min(0).max(100000), sourceManifestRef: R, items: z.array(itemSchema).max(4096), sourceTotals: z.array(z.object({ sourceRef: R, destination: dest, itemIds: z.array(T).max(4096), total: IS }).strict()).max(4096), costCoverage: z.array(z.object({ category: costCategory, status: z.enum(['COMPLETE', 'BOUNDED', 'UNKNOWN']), itemIds: z.array(T).max(4096), zeroCostEvidenceRef: R.nullable() }).strict()).max(13), valuations: z.array(z.object({ itemId: T, authorityRef: R, methodRef: R, asOf: DT, signedAssessmentRef: R, inputRefs: z.array(R).min(1).max(256), ownershipDebtRef: R, independenceRef: R }).strict()).max(4096), liabilityCoverageRef: R.nullable(), conservationRef: R.nullable(), correctionOf: R.nullable() }).strict();
export const parseEconomicAccountingSubmission = (v: unknown) => immutableEconomic(accountSchema.parse(v) as EconomicAccountingSubmission);
const resolutionSchema = z.object({ ref: R, status: z.enum(['RESOLVED_AUTHENTICATED', 'UNVERIFIED', 'UNAVAILABLE']), tenantId: z.string().uuid(), knowledgeAt: DT, protectedReceiptRef: R.nullable(), signatureVerified: z.boolean(), independent: z.boolean(), sourceOrigin: z.enum(['FIELD', 'GENERATED_CHALLENGE', 'RETROSPECTIVE', 'MODELED', 'UNKNOWN']).optional(), protectionDomain: z.enum(['REVIEWED_PROTECTED_DOMAIN', 'DISPOSABLE_TEST_AUTHORITY']).optional() }).strict();
const assignmentSchema = z.object({ clusterId: T, controllerId: T, assignedAt: DT, assignmentRef: R, protocolRef: R, stages: z.array(z.object({ stage: z.enum(['INTENDED', 'AUTHORIZED', 'ATTEMPTED', 'ACKNOWLEDGED', 'OBSERVED', 'VERIFIED', 'RECONCILED', 'FAILED', 'DECLINED', 'REJECTED', 'CANCELLED', 'PARTIAL', 'OVERRIDDEN', 'UNKNOWN', 'CENSORED']), ref: R }).strict()).max(256), actualExposureRefs: z.array(R).max(256) }).strict();
const computeCost = z.object({ amount: IS.nullable(), pricebookRef: R.nullable(), meteringRef: R.nullable() }).strict();
const requestSchema = z.object({ schema: z.literal('finnor.economic-assessment-request.v1'), tenantId: z.string().uuid(), principalId: z.string().uuid(), estimand: z.unknown(), estimandRef: R, assessedAt: DT, lookAt: DT, assignments: z.array(assignmentSchema).max(4096), accounting: z.array(accountSchema).max(4096), evidence: z.array(resolutionSchema).max(65536), priorAssessmentRef: R.nullable(), computeCost }).strict();
export function parseEconomicAssessmentInput(v: unknown): EconomicAssessmentInput {
    const r = requestSchema.parse(v), estimand = parseOutcomeEstimand(r.estimand);
    if (Buffer.byteLength(canonicalEconomic(v)) > estimand.budgets.maximumInputBytes)
        refuse('INPUT_BUDGET_EXCEEDED');
    if (r.accounting.reduce((n, a) => n + a.items.length, 0) > 65536)
        refuse('TOTAL_ITEMS_BUDGET_EXCEEDED');
    return { ...r, estimand } as EconomicAssessmentInput;
}
const resolutionIndexes = new WeakMap<readonly EconomicEvidenceResolution[], Map<string, EconomicEvidenceResolution[]>>();
function sourceResolutions(ref: EconomicRef, evidence: readonly EconomicEvidenceResolution[]) {
    let index = resolutionIndexes.get(evidence);
    if (!index) {
        index = new Map();
        for (const v of evidence) {
            const matches = index.get(v.ref.id) ?? [];
            matches.push(v);
            index.set(v.ref.id, matches);
        }
        resolutionIndexes.set(evidence, index);
    }
    return index.get(ref.id) ?? [];
}
const resolved = (r: EconomicRef | null, evidence: readonly EconomicEvidenceResolution[], tenantId: string, at?: string, independent = false) => !!r && sourceResolutions(r, evidence).some(v => sameRef(v.ref, r) && v.tenantId === tenantId && v.status === 'RESOLVED_AUTHENTICATED' && v.signatureVerified && v.protectedReceiptRef && (!at || Date.parse(v.knowledgeAt) <= Date.parse(at)) && (!independent || v.independent));
const field = (r: EconomicRef, evidence: readonly EconomicEvidenceResolution[], tenant: string, notBefore?: string) => sourceResolutions(r, evidence).some(v => sameRef(v.ref, r) && v.tenantId === tenant && v.status === 'RESOLVED_AUTHENTICATED' && v.signatureVerified && v.sourceOrigin === 'FIELD' && v.protectionDomain === 'REVIEWED_PROTECTED_DOMAIN' && (!notBefore || Date.parse(v.knowledgeAt) >= Date.parse(notBefore)));
export function reconcileEconomicAccounting(e: OutcomeEstimand, s: EconomicAccountingSubmission, ev: readonly EconomicEvidenceResolution[], tenant: string): EconomicAccountingResult {
    const reasons: string[] = [], cluster = e.clusters.find(c => c.id === s.clusterId) ?? refuse('ACCOUNTING_POPULATION_SUBSTITUTION'), controller = e.controllers.find(c => c.id === s.controllerId) ?? refuse('ACCOUNTING_POPULATION_SUBSTITUTION');
    if (s.items.length > e.budgets.maximumItemsPerCluster)
        refuse('ITEMS_BUDGET_EXCEEDED');
    unique(s.items.map(i => i.canonicalId), 'ECONOMIC_ITEM');
    unique(s.costCoverage.map(c => c.category), 'COST_CATEGORY');
    unique(s.valuations.map(v => v.itemId), 'VALUATION');
    const supported = (r: EconomicRef | null, ind = false) => resolved(r, ev, tenant, s.knowledgeAt, ind), legs = new Map<string, I>(), missing = new Set<string>();
    let completeCosts = true, independentResidual = true, sourceReconciled = true;
    if (!sameRef(s.sourceManifestRef, cluster.sourceManifestRef) || !supported(s.sourceManifestRef) || !supported(s.conservationRef) || !supported(s.liabilityCoverageRef)) {
        reasons.push('SOURCE_MANIFEST_CONSERVATION_OR_LIABILITY_COVERAGE_MISSING');
        sourceReconciled = false;
    }
    const totals = new Set<string>();
    for (const t of s.sourceTotals) {
        unique(t.itemIds, 'TOTAL_ITEM');
        const items = t.itemIds.map(id => s.items.find(i => i.canonicalId === id));
        if (!supported(t.sourceRef) || items.some(v => !v || v.destination !== t.destination || !v.amount) || t.itemIds.some(id => totals.has(id))) {
            sourceReconciled = false;
            reasons.push('SOURCE_TOTAL_UNSUPPORTED_OR_DUPLICATED');
            continue;
        }
        let value = empty();
        for (const i of items) {
            value = add(value, interval(i!.amount!));
            totals.add(i!.canonicalId);
        }
        if (value.l.cmp(Q.dec(t.total.lower)) !== 0 || value.u.cmp(Q.dec(t.total.upper)) !== 0) {
            sourceReconciled = false;
            reasons.push('SOURCE_TOTAL_MISMATCH');
        }
    }
    for (const item of s.items) {
        if (!sameRef(item.ownerBoundaryRef, e.ownerBoundaryRef) || item.currency !== e.currency || !supported(item.sourceRef) || !totals.has(item.canonicalId) || item.reconciliationRefs.length === 0 || item.reconciliationRefs.some(r => !supported(r)) || Date.parse(item.at) > Date.parse(s.asOf) || ['CASH_OWNER', 'ADDITIONAL_CAPITAL'].includes(item.destination) && Date.parse(item.at) < Date.parse(e.assignmentAt)) {
            missing.add(item.destination);
            sourceReconciled = false;
            reasons.push('ITEM_SOURCE_CURRENCY_DATE_OR_OWNER_UNSUPPORTED:' + item.canonicalId);
            continue;
        }
        if (!item.amount) {
            missing.add(item.destination);
            reasons.push('UNOBSERVED_AMOUNT:' + item.canonicalId);
            continue;
        }
        if (['ADDITIONAL_CAPITAL', 'RESIDUAL_EQUITY', 'EXTRA_LIABILITY', 'COST_ONCE', 'EMBEDDED_COST'].includes(item.destination) && Q.dec(item.amount.lower).cmp(ZERO) < 0)
            refuse('NEGATIVE_OWNER_OUTFLOW_OR_RESIDUAL');
        if (item.destination === 'EMBEDDED_COST') {
            const target = s.items.find(i => i.canonicalId === item.embeddedIn);
            if (!target || !['CASH_OWNER', 'RESIDUAL_EQUITY', 'EXTRA_LIABILITY'].includes(target.destination) || !item.costCategory) {
                completeCosts = false;
                reasons.push('EMBEDDED_COST_DESTINATION_UNSUPPORTED');
            }
            continue;
        }
        if (item.embeddedIn !== null)
            refuse('ACCOUNTING_DESTINATION_AMBIGUOUS');
        if (item.destination === 'INTERNAL_TRANSFER')
            continue;
        const factor = e.discountSchedule.find(v => v.at === item.at);
        if (!factor) {
            missing.add(item.destination);
            reasons.push('DISCOUNT_DATE_NOT_REGISTERED:' + item.canonicalId);
            continue;
        }
        if (['RESIDUAL_EQUITY', 'EXTRA_LIABILITY'].includes(item.destination) && Date.parse(item.at) !== Date.parse(s.asOf)) {
            missing.add(item.destination);
            reasons.push('ENDPOINT_ITEM_AS_OF_MISMATCH');
            continue;
        }
        if (item.destination === 'COST_ONCE' && !item.costCategory)
            refuse('COST_CATEGORY_REQUIRED');
        legs.set(item.destination, add(legs.get(item.destination) ?? empty(), scale(interval(item.amount), Q.dec(factor.factor))));
        if (item.destination === 'RESIDUAL_EQUITY') {
            const v = s.valuations.find(v => v.itemId === item.canonicalId);
            if (!v || !e.valuationProtocol.authorityRefs.some(r => sameRef(r, v.authorityRef)) || !e.valuationProtocol.methodRefs.some(r => sameRef(r, v.methodRef)) || !sameRef(v.ownershipDebtRef, e.ownershipWaterfallRef) || !sameRef(v.independenceRef, e.valuationProtocol.independenceRef) || Date.parse(v.asOf) > Date.parse(s.asOf) || Date.parse(s.asOf) - Date.parse(v.asOf) > e.valuationProtocol.maxAsOfAgeMs || !supported(v.signedAssessmentRef, true) || !supported(v.authorityRef, true) || !supported(v.independenceRef, true) || !supported(v.methodRef) || !supported(e.valuationProtocol.conflictsBlindingRef) || v.inputRefs.some(r => !supported(r))) {
                independentResidual = false;
                missing.add('RESIDUAL_EQUITY');
                reasons.push('RESIDUAL_NOT_INDEPENDENTLY_QUALIFIED:' + item.canonicalId);
            }
        }
    }
    if (!s.items.some(i => i.destination === 'RESIDUAL_EQUITY')) {
        independentResidual = false;
        missing.add('RESIDUAL_EQUITY');
        reasons.push('RESIDUAL_ZERO_OR_UNKNOWN_MUST_BE_OBSERVED');
    }
    const transfers = s.items.filter(i => i.destination === 'INTERNAL_TRANSFER');
    if (transfers.some(i => !i.amount) || transfers.length && (() => { const v = transfers.reduce((a, i) => add(a, interval(i.amount!)), empty()); return v.l.cmp(ZERO) !== 0 || v.u.cmp(ZERO) !== 0; })()) {
        sourceReconciled = false;
        reasons.push('INTERNAL_TRANSFER_NOT_CONSERVED');
    }
    for (const category of ECONOMIC_COST_CATEGORIES) {
        const c = s.costCoverage.find(v => v.category === category), items = s.items.filter(i => i.costCategory === category && ['COST_ONCE', 'EMBEDDED_COST'].includes(i.destination));
        if (!c || c.status !== 'COMPLETE' || economicHash([...c.itemIds].sort()) !== economicHash(items.map(i => i.canonicalId).sort()) || items.some(i => !i.amount || !supported(i.sourceRef)) || items.length === 0 && !supported(c.zeroCostEvidenceRef)) {
            completeCosts = false;
            reasons.push('COST_COVERAGE_INCOMPLETE:' + category);
        }
    }
    const leg = (name: string) => missing.has(name) ? null : output(legs.get(name) ?? empty());
    let wealth: I | null = sourceReconciled && completeCosts && independentResidual && missing.size === 0 ? empty() : null;
    if (wealth) {
        wealth = sub(add(sub(legs.get('CASH_OWNER') ?? empty(), legs.get('ADDITIONAL_CAPITAL') ?? empty()), sub(legs.get('RESIDUAL_EQUITY') ?? empty(), legs.get('EXTRA_LIABILITY') ?? empty())), legs.get('COST_ONCE') ?? empty());
        wealth = sub(wealth, { l: Q.dec(cluster.openingWealth), u: Q.dec(cluster.openingWealth) });
    }
    const endpoint = new Date(e.assignmentAt);
    endpoint.setUTCMonth(endpoint.getUTCMonth() + e.horizonMonths);
    const mature = wealth !== null && e.horizonMonths >= 36 && Date.parse(s.asOf) >= Date.parse(e.endpointAt) && Date.parse(s.asOf) >= endpoint.getTime() && s.closedLoopDays >= 90 && sourceReconciled && completeCosts && independentResidual && s.items.every(i => field(i.sourceRef, ev, tenant, i.at)) && field(s.sourceManifestRef, ev, tenant) && !!s.liabilityCoverageRef && field(s.liabilityCoverageRef, ev, tenant, s.asOf) && !!s.conservationRef && field(s.conservationRef, ev, tenant, s.asOf) && s.costCoverage.every(c => c.itemIds.length > 0 || !!c.zeroCostEvidenceRef && field(c.zeroCostEvidenceRef, ev, tenant, s.asOf)) && s.valuations.every(v => field(v.signedAssessmentRef, ev, tenant, v.asOf) && [v.signedAssessmentRef, v.authorityRef, v.methodRef, v.independenceRef, ...v.inputRefs].every(r => field(r, ev, tenant)));
    if (!mature)
        reasons.push('MATURE_FIELD_H2_NOT_ESTABLISHED');
    return { clusterId: s.clusterId, controllerId: s.controllerId, wealth: wealth ? output(wealth) : null, realizedOwnerCash: leg('CASH_OWNER'), additionalCapital: leg('ADDITIONAL_CAPITAL'), residualEquity: leg('RESIDUAL_EQUITY'), extraLiabilities: leg('EXTRA_LIABILITY'), onceCosts: leg('COST_ONCE'), completeCosts, independentResidual, sourceReconciled, supportedHorizon: mature ? 'H2' : 'H1', reasons: [...new Set(reasons)], itemIds: s.items.map(i => i.canonicalId) };
}
const loadedPath = fileURLToPath(import.meta.url), loadedSourceDigests = [loadedPath, fileURLToPath(new URL('../../shared-types/src/economic-attribution.ts', import.meta.url)), fileURLToPath(new URL('../../governed-execution/src/protocol.ts', import.meta.url))].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
export function assessEconomicAttribution(value: unknown): EconomicAssessment {
    const start = performance.now(), cpu = process.cpuUsage(), rss = process.memoryUsage().rss, r = parseEconomicAssessmentInput(value), e = r.estimand, reasons: string[] = [];
    unique(r.assignments.map(a => a.clusterId), 'ASSIGNMENT');
    unique(r.accounting.map(a => a.clusterId), 'ACCOUNTING');
    if (!e.analysis.registeredLooks.includes(r.lookAt) || Date.parse(r.assessedAt) < Date.parse(r.lookAt) || Date.parse(r.lookAt) > Date.parse(e.endpointAt))
        refuse('UNREGISTERED_OR_EARLY_LOOK');
    if (r.assignments.some(a => !e.clusters.some(c => c.id === a.clusterId) || !e.controllers.some(c => c.id === a.controllerId) || !sameRef(a.protocolRef, e.assignment.protocolRef)) || r.accounting.some(s => !sameRef(s.estimandRef, r.estimandRef) || !r.assignments.some(a => a.clusterId === s.clusterId && a.controllerId === s.controllerId) || Date.parse(s.asOf) > Date.parse(r.lookAt) || Date.parse(s.knowledgeAt) > Date.parse(r.assessedAt)))
        refuse('ASSIGNMENT_ACCOUNTING_CONTEXT_MISMATCH');
    const allRefs = collectEconomicRefs(e), authenticated = allRefs.every(ref => resolved(ref, r.evidence, r.tenantId, e.assignmentAt));
    const assignmentsComplete = r.assignments.length === e.clusters.length && r.assignments.every(a => a.assignmentRef.owner === 'S2' && resolved(a.assignmentRef, r.evidence, r.tenantId, r.assessedAt) && Date.parse(a.assignedAt) >= Date.parse(e.assignmentAt) && Date.parse(a.assignedAt) <= Date.parse(r.lookAt));
    const assumptions = ['CONSISTENCY', 'NO_BETWEEN_CLUSTER_INTERFERENCE', 'ALIGNED_TIME_ZERO', 'BOUNDED_POTENTIAL_WEALTH', 'FIXED_ELIGIBLE_POPULATION'].every(id => e.assumptions.some(a => a.id === id && a.status === 'SUPPORTED' && a.evidenceRefs.length > 0 && a.evidenceRefs.every(ref => resolved(ref, r.evidence, r.tenantId, e.assignmentAt, true))));
    const accounting = r.accounting.map(s => {
        const a = reconcileEconomicAccounting(e, s, r.evidence, r.tenantId), assigned = r.assignments.find(v => v.clusterId === s.clusterId);
        if (assigned) {
            const endpoint = new Date(assigned.assignedAt);
            endpoint.setUTCMonth(endpoint.getUTCMonth() + e.horizonMonths);
            if (Date.parse(s.asOf) < endpoint.getTime()) {
                a.supportedHorizon = 'H1';
                a.reasons.push('ACTUAL_ASSIGNMENT_HORIZON_INCOMPLETE');
            }
        }
        return a;
    });
    const analysisItems = r.accounting.flatMap(s => s.items.filter(i => r.computeCost.meteringRef && sameRef(i.sourceRef, r.computeCost.meteringRef) && ['COST_ONCE', 'EMBEDDED_COST'].includes(i.destination) && i.costCategory === 'COMPUTE'));
    const analysisTotal = analysisItems.reduce((a, i) => i.amount ? add(a, interval(i.amount)) : a, empty());
    const analysisCostsCovered = !!r.computeCost.amount && !!r.computeCost.meteringRef && resolved(r.computeCost.meteringRef, r.evidence, r.tenantId, r.assessedAt) && (analysisItems.length > 0 && analysisItems.every(i => i.amount) && analysisTotal.l.cmp(Q.dec(r.computeCost.amount.lower)) === 0 && analysisTotal.u.cmp(Q.dec(r.computeCost.amount.upper)) === 0 || Q.dec(r.computeCost.amount.lower).cmp(ZERO) === 0 && Q.dec(r.computeCost.amount.upper).cmp(ZERO) === 0 && r.accounting.length === e.clusters.length && r.accounting.every(s => s.costCoverage.some(c => c.category === 'COMPUTE' && c.status === 'COMPLETE' && c.itemIds.length === 0 && resolved(c.zeroCostEvidenceRef, r.evidence, r.tenantId, r.assessedAt))));
    if (!analysisCostsCovered)
        for (const a of accounting) {
            a.wealth = null;
            a.completeCosts = false;
            a.supportedHorizon = 'H1';
            a.reasons.push('ANALYSIS_COST_UNMETERED_OR_NOT_BOOKED_ONCE');
        }
    const claimed = new Set<string>();
    for (const s of r.accounting)
        for (const i of s.items) {
            const id = economicHash([i.ownerBoundaryRef, i.canonicalId]);
            if (claimed.has(id))
                refuse('DUPLICATE_ITEM_ACROSS_CLUSTERS');
            claimed.add(id);
        }
    const supportBroken = accounting.some(a => { const c = e.clusters.find(c => c.id === a.clusterId)!; return a.wealth && (Q.dec(a.wealth.lower).cmp(Q.dec(c.wealthSupport.lower)) < 0 || Q.dec(a.wealth.upper).cmp(Q.dec(c.wealthSupport.upper)) > 0); });
    const registeredBeforeAssignment = resolved(r.estimandRef, r.evidence, r.tenantId, e.assignmentAt);
    const design = e.assignment.kind === 'INDEPENDENT_CLUSTER_RANDOMIZATION' && registeredBeforeAssignment && authenticated && assignmentsComplete && assumptions && !supportBroken;
    if (!registeredBeforeAssignment)
        reasons.push('ORIGINAL_PROTECTED_PREREGISTRATION_NOT_PREASSIGNMENT');
    if (!authenticated)
        reasons.push('PREREGISTERED_SOURCE_OR_OWNER_REFERENCES_UNAUTHENTICATED');
    if (!assignmentsComplete)
        reasons.push('COMPLETE_AUTHENTIC_ASSIGNMENT_NOT_ESTABLISHED');
    if (!assumptions)
        reasons.push('IDENTIFICATION_ASSUMPTIONS_NOT_INDEPENDENTLY_SUPPORTED');
    if (supportBroken)
        reasons.push('REGISTERED_WEALTH_SUPPORT_REFUTED');
    const arms = e.controllers.filter(c => c.id !== e.businessAsUsualId), support = e.clusters.reduce((a, c) => add(a, scale(sub(interval(c.wealthSupport), interval(c.wealthSupport)), Q.dec(c.weight))), empty());
    const log = logUpper(new Q(BigInt(40 * arms.length * e.analysis.registeredLooks.length)));
    const contrasts = arms.map(arm => {
        let score = empty(), widthSquared = ZERO;
        if (design && e.assignment.kind === 'INDEPENDENT_CLUSTER_RANDOMIZATION') {
            const p = Q.dec(e.assignment.probabilities[arm.id]!), p0 = Q.dec(e.assignment.probabilities[e.businessAsUsualId]!);
            for (const c of e.clusters) {
                const assignment = r.assignments.find(a => a.clusterId === c.id)!, actual = accounting.find(a => a.clusterId === c.id), w = Q.dec(c.weight), range = interval(c.wealthSupport);
                const realized = actual?.wealth ? interval(actual.wealth) : range;
                if (assignment.controllerId === arm.id)
                    score = add(score, scale(realized, w.div(p)));
                else if (assignment.controllerId === e.businessAsUsualId)
                    score = add(score, scale(realized, w.div(p0).mul(new Q(-1n))));
                const low = min([ZERO, range.l.div(p), range.u.div(p0).mul(new Q(-1n))]), high = max([ZERO, range.u.div(p), range.l.div(p0).mul(new Q(-1n))]), width = high.sub(low).mul(w);
                widthSquared = widthSquared.add(width.mul(width));
            }
            const radius = sqrtUpper(widthSquared.mul(log).div(new Q(2n))), lower = max([support.l, score.l.sub(radius)]), upper = min([support.u, score.u.add(radius)]);
            if (lower.cmp(upper) > 0)
                refuse('DESIGN_SUPPORT_OR_NUMERICAL_CONTRADICTION');
            return { controllerId: arm.id, businessAsUsualId: e.businessAsUsualId, identification: 'DESIGN_BASED_CONDITIONAL' as const, interval: output({ l: lower, u: upper }), scoreInterval: output(score), samplingRadiusUpper: radius.out(true), support: output(support), reasons: accounting.some(a => !a.wealth) ? ['MISSING_OUTCOMES_RETAIN_FULL_REGISTERED_SUPPORT'] : [] };
        }
        return { controllerId: arm.id, businessAsUsualId: e.businessAsUsualId, identification: 'UNIDENTIFIED' as const, interval: supportBroken ? null : output(support), scoreInterval: null, samplingRadiusUpper: null, support: output(support), reasons: [...reasons, ...(e.assignment.kind === 'OBSERVATIONAL_UNIDENTIFIED' ? e.assignment.reasons : []), 'COUNTERFACTUAL_SUPPORT_ONLY_NO_POSITIVE_CAUSAL_CREDIT'] };
    });
    const completeCosts = accounting.length === e.clusters.length && accounting.every(a => a.completeCosts) && analysisCostsCovered;
    const protectedHistoryComplete = resolved(r.estimandRef, r.evidence, r.tenantId, e.assignmentAt) && assignmentsComplete && allRefs.every(ref => resolved(ref, r.evidence, r.tenantId));
    const mature = design && protectedHistoryComplete && completeCosts && accounting.length === e.clusters.length && accounting.every(a => a.supportedHorizon === 'H2') && e.assumptions.filter(a => a.status === 'SUPPORTED').every(a => a.evidenceRefs.every(ref => field(ref, r.evidence, r.tenantId))) && field(r.estimandRef, r.evidence, r.tenantId) && !!r.computeCost.meteringRef && field(r.computeCost.meteringRef, r.evidence, r.tenantId);
    if (!completeCosts)
        reasons.push('COMPLETE_ATTRIBUTABLE_COSTS_AND_ANALYSIS_COST_NOT_ESTABLISHED');
    if (!mature)
        reasons.push('MATURE_OWNER_ATTRIBUTION_H2_NOT_ESTABLISHED');
    if (performance.now() - start > e.budgets.maximumElapsedMs)
        refuse('ATTRIBUTION_COMPUTE_BUDGET_EXCEEDED');
    const used = process.cpuUsage(cpu), body: Omit<EconomicAssessment, 'ref'> = { schema: 'finnor.economic-assessment.v1', version: e.version, semanticOwner: 'S7', tenantId: r.tenantId, principalId: r.principalId, estimandRef: r.estimandRef, assessedAt: r.assessedAt, lookAt: r.lookAt, priorAssessmentRef: r.priorAssessmentRef, population: { eligibleClusters: e.clusters.length, assignedClusters: r.assignments.length, retainedClusters: e.clusters.length, excludedClusters: 0 }, accounting, contrasts, supportedHorizon: mature ? 'H2' : 'H1', evidenceClass: design ? 'PROBABILISTICALLY_SUPPORTED' : 'PARTIAL', completeCosts, protectedHistoryComplete, uncertainty: { coverage: design ? 'SIMULTANEOUS_95_CONDITIONAL' : 'SUPPORT_BOUNDS_ONLY', familyContrasts: arms.length, registeredLooks: e.analysis.registeredLooks.length, sampling: design ? 'BOUNDED_INDEPENDENT_CLUSTER_RANDOMIZATION' : 'UNIDENTIFIED', identification: design ? 'FIXED_FINITE_POPULATION_REGIME_ITT_CONDITIONAL_ON_REGISTERED_ASSUMPTIONS' : 'UNIDENTIFIED_COUNTERFACTUAL', measurement: 'SUPPORTED_SOURCE_INTERVALS_OR_FULL_REGISTERED_RANGE', valuation: 'INDEPENDENT_BOUNDS_REQUIRED_NO_SELF_CERTIFICATION', cost: completeCosts ? 'COMPLETE_AUTHENTICATED_SOURCE_COVERAGE' : 'INCOMPLETE_NOT_FREE', censoring: 'MISSING_ADVERSE_AND_FAILED_CASES_RETAINED_WITH_SUPPORT_BOUNDS', numerical: { arithmetic: 'BIGINT_RATIONAL', outwardDecimalPlaces: 12, maximumEndpointRoundingError: '0.000000000001', radius: 'EXACT_RATIONAL_LOG_UPPER_AND_SQRT_UPPER' } }, aggregateCredit: { programmeOnly: true, actionCreditsIdentified: false, jointAndUnallocatedValuePreserved: true }, compute: { elapsedMs: performance.now() - start, processCpuUserMicros: used.user, processCpuSystemMicros: used.system, rssBeforeBytes: rss, rssAfterBytes: process.memoryUsage().rss, cost: r.computeCost, moneyStatus: r.computeCost.amount ? 'METERED_SUPPLIED_UNVERIFIED' : 'UNKNOWN', sourceDigests: loadedSourceDigests, nodeVersion: process.version, actualRoute: 'LOCAL_EXACT_BOUNDED', admission: 'UNADMITTED', protectedReceipt: null }, reasons: [...new Set(reasons)], executionAuthorityGranted: false, capabilityAdmissionGranted: false, protectedReceipt: null };
    const digest = economicHash(body);
    return immutableEconomic({ ...body, ref: { owner: 'S7', id: 'economic-assessment:' + digest, version: e.version, contentDigest: digest } });
}
export function collectEconomicRefs(value: unknown): EconomicRef[] {
    const refs = new Map<string, EconomicRef>();
    function walk(v: any) {
        if (!v || typeof v !== 'object')
            return;
        if (typeof v.owner === 'string' && typeof v.id === 'string' && typeof v.version === 'string' && typeof v.contentDigest === 'string') {
            const prior = refs.get(v.id);
            if (prior && !sameRef(prior, v))
                refuse('REFERENCE_IDENTITY_CONFLICT');
            refs.set(v.id, R.parse(v));
            return;
        }
        for (const x of Object.values(v))
            walk(x);
    }
    walk(value);
    return [...refs.values()];
}
const benchmarkSchema = z.object({ schema: z.literal('finnor.economic-benchmark-registration.v1'), key: T.max(256), registeredAt: DT, protocolRef: R, estimandRef: R, matchedEnvelopeRef: R, controllers: z.array(z.object({ id: T, role, pinnedVersionRef: R, required: z.literal(true) }).strict()).min(7).max(32), epsilon: D, absoluteValueFloor: D, minimumDecisionPayoff: D, downsideLimit: D, primaryHorizonMonths: z.literal(36), minimumClosedLoopDays: z.literal(90), multiplicityRef: R, powerStoppingRef: R, pricebookRef: R, capabilityFrontierRef: R, refreshAsOf: DT, nextRefreshAt: DT }).strict();
export function parseEconomicBenchmarkRegistration(v: unknown): EconomicBenchmarkRegistration {
    const r = benchmarkSchema.parse(v) as EconomicBenchmarkRegistration;
    unique(r.controllers.map(c => c.id), 'BENCHMARK_CONTROLLER');
    for (const required of ['FINNOR', 'BUSINESS_AS_USUAL', 'PINNED_CURRENT_FINNOR', 'FRONTIER_SPECIALIST', 'MUSE', 'DOTS', 'EXPERT_PE'])
        if (!r.controllers.some(c => c.role === required))
            refuse('REQUIRED_BENCHMARK_BASELINE_MISSING');
    if (r.controllers.filter(c => c.role === 'FINNOR').length !== 1 || Q.dec(r.epsilon).cmp(ZERO) <= 0 || Q.dec(r.absoluteValueFloor).cmp(ZERO) <= 0 || Q.dec(r.minimumDecisionPayoff).cmp(ZERO) <= 0 || Q.dec(r.downsideLimit).cmp(ZERO) < 0 || Date.parse(r.nextRefreshAt) <= Date.parse(r.refreshAsOf) || Date.parse(r.nextRefreshAt) - Date.parse(r.refreshAsOf) > 92 * 86400000)
        refuse('BENCHMARK_MATERIALITY_OR_REFRESH_INVALID');
    return immutableEconomic(r);
}
export function parseEconomicBenchmarkInput(v: unknown): EconomicBenchmarkInput { const r = z.object({ schema: z.literal('finnor.economic-benchmark-request.v1'), registration: z.unknown(), registrationRef: R, assessedAt: DT, assessments: z.array(z.object({ controllerId: T, assessment: z.unknown(), matchedEnvelopeRef: R, protocolRef: R, independentEvaluatorRef: R }).strict()).max(32), gates: z.array(z.object({ controllerId: T, reach: z.enum(['PASS', 'FAIL', 'UNMEASURED']), resource: z.enum(['PASS', 'FAIL', 'UNMEASURED']), safety: z.enum(['PASS', 'FAIL', 'UNMEASURED']), downsideUpper: D.nullable(), decisionPayoffLower: D.nullable(), evidenceRefs: z.array(R).min(1).max(64) }).strict()).max(32), evidence: z.array(resolutionSchema).max(65536) }).strict().parse(v); return { ...r, registration: parseEconomicBenchmarkRegistration(r.registration) } as EconomicBenchmarkInput; }
export function assessEconomicBenchmark(value: unknown): EconomicBenchmarkAssessment {
    const r = parseEconomicBenchmarkInput(value), b = r.registration, reasons: string[] = [];
    unique(r.assessments.map(v => v.controllerId), 'BENCHMARK_ASSESSMENT');
    unique(r.gates.map(v => v.controllerId), 'BENCHMARK_GATE');
    const preregistered = collectEconomicRefs(b).every(ref => r.evidence.some(v => sameRef(v.ref, ref) && resolved(ref, r.evidence, v.tenantId, b.registeredAt))) && r.evidence.some(v => sameRef(v.ref, r.registrationRef) && resolved(r.registrationRef, r.evidence, v.tenantId, r.assessedAt));
    let familyRef: string | null = null;
    const comparisons = b.controllers.map(c => {
        const a = r.assessments.find(a => a.controllerId === c.id), g = r.gates.find(g => g.controllerId === c.id), why: string[] = [];
        let iv: EconomicInterval | null = null;
        if (!a)
            return { controllerId: c.id, role: c.role, status: 'UNMEASURED' as const, interval: null, reasons: ['COMPARATOR_UNRUN_OR_UNAVAILABLE'] };
        const { ref, ...body } = a.assessment;
        if (!ref || economicHash(body) !== ref.contentDigest || ref.id !== 'economic-assessment:' + ref.contentDigest)
            refuse('BENCHMARK_ASSESSMENT_PREIMAGE_INVALID');
        if (!familyRef)
            familyRef = ref.id;
        else if (ref.id !== familyRef)
            why.push('INCOMPATIBLE_SIMULTANEOUS_INFERENCE_FAMILY');
        if (!preregistered || !resolved(r.registrationRef, r.evidence, a.assessment.tenantId, a.assessment.lookAt) || Date.parse(b.registeredAt) >= Date.parse(a.assessment.lookAt))
            why.push('AUTHENTICATED_PREOUTCOME_BENCHMARK_REGISTRATION_REQUIRED');
        const contrast = c.role === 'BUSINESS_AS_USUAL' ? { interval: { lower: '0', upper: '0' }, identification: 'DESIGN_BASED_CONDITIONAL' } : a.assessment.contrasts.find(v => v.controllerId === c.id);
        iv = contrast?.interval ?? null;
        if (!sameRef(a.assessment.estimandRef, b.estimandRef) || !sameRef(a.matchedEnvelopeRef, b.matchedEnvelopeRef) || !sameRef(a.protocolRef, b.protocolRef) || a.assessment.supportedHorizon !== 'H2' || !a.assessment.completeCosts || !a.assessment.protectedHistoryComplete || contrast?.identification !== 'DESIGN_BASED_CONDITIONAL' || a.assessment.uncertainty.coverage !== 'SIMULTANEOUS_95_CONDITIONAL' || !iv)
            why.push('MATCHED_MATURE_IDENTIFIED_COST_COMPLETE_ASSESSMENT_REQUIRED');
        if (!resolved(a.independentEvaluatorRef, r.evidence, a.assessment.tenantId, r.assessedAt, true) || !field(a.independentEvaluatorRef, r.evidence, a.assessment.tenantId))
            why.push('INDEPENDENT_FIELD_EVALUATION_MISSING');
        if (!g || g.reach !== 'PASS' || g.resource !== 'PASS' || g.safety !== 'PASS' || g.downsideUpper === null || Q.dec(g.downsideUpper).cmp(Q.dec(b.downsideLimit)) > 0 || g.decisionPayoffLower === null || Q.dec(g.decisionPayoffLower).cmp(Q.dec(b.minimumDecisionPayoff)) < 0 || g.evidenceRefs.some(ref => !resolved(ref, r.evidence, a.assessment.tenantId, r.assessedAt, true) || !field(ref, r.evidence, a.assessment.tenantId)))
            why.push('REACH_RESOURCE_SAFETY_DOWNSIDE_OR_PAYOFF_UNQUALIFIED');
        if (Date.parse(r.assessedAt) > Date.parse(b.nextRefreshAt))
            why.push('FRONTIER_COMPARATORS_STALE');
        return { controllerId: c.id, role: c.role, status: why.length ? 'UNQUALIFIED' as const : 'QUALIFIED' as const, interval: iv, reasons: why };
    });
    const f = comparisons.find(c => c.role === 'FINNOR')!, baselines = comparisons.filter(c => c.role !== 'FINNOR'), all = comparisons.every(c => c.status === 'QUALIFIED'), known = baselines.every(c => c.interval !== null), upper = known ? max(baselines.map(c => Q.dec(c.interval!.upper))) : null, lower = known ? max(baselines.map(c => Q.dec(c.interval!.lower))) : null;
    let economic100x: EconomicBenchmarkAssessment['economic100x'] = 'INCONCLUSIVE', ratioInterval: EconomicInterval | null = null;
    if (all && f.interval && upper && lower && lower.cmp(Q.dec(b.epsilon)) >= 0) {
        economic100x = Q.dec(f.interval.lower).cmp(upper.mul(new Q(100n))) >= 0 && Q.dec(f.interval.lower).cmp(Q.dec(b.absoluteValueFloor)) >= 0 ? 'PASS' : Q.dec(f.interval.upper).cmp(lower.mul(new Q(100n))) < 0 ? 'FAIL' : 'INCONCLUSIVE';
        const ratios = [Q.dec(f.interval.lower).div(upper), Q.dec(f.interval.lower).div(lower), Q.dec(f.interval.upper).div(upper), Q.dec(f.interval.upper).div(lower)];
        ratioInterval = output({ l: min(ratios), u: max(ratios) });
    }
    else
        reasons.push('MISSING_QUALIFIED_STRONGEST_BASELINE_MATERIAL_DENOMINATOR_OR_MATURE_GATES');
    const named = (role: 'MUSE' | 'DOTS') => { const c = comparisons.find(c => c.role === role); return all && f.interval && c?.interval && Q.dec(c.interval.lower).cmp(Q.dec(b.epsilon)) >= 0 ? (Q.dec(f.interval.lower).cmp(Q.dec(c.interval.upper).mul(new Q(10n))) >= 0 ? 'PASS' : Q.dec(f.interval.upper).cmp(Q.dec(c.interval.lower).mul(new Q(10n))) < 0 ? 'FAIL' : 'INCONCLUSIVE') : 'INCONCLUSIVE'; };
    return immutableEconomic({ schema: 'finnor.economic-benchmark-assessment.v1', registrationRef: r.registrationRef, assessedAt: r.assessedAt, economic100x, named10x: { Muse: named('MUSE'), dots: named('DOTS') }, strongestBaselineUpper: upper?.out(true) ?? null, strongestBaselineLower: lower?.out(false) ?? null, ratioInterval, comparisons, reasons, capabilityDominance: 'SEPARATE_UNMEASURED', evidenceClass: 'PARTIAL', claimGranted: economic100x === 'PASS' && named('MUSE') === 'PASS' && named('DOTS') === 'PASS' } as EconomicBenchmarkAssessment);
}
/** Exact outward sum of independently reconciled, disjoint observed wealth. */
export function sumEconomicIntervals(values: Array<EconomicInterval | null>): EconomicInterval | null { return values.some(v => !v) ? null : output(values.reduce<I>((a, v) => add(a, interval(v!)), empty())); }

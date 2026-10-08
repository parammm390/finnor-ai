/** S8-owned ordinary contracts. No trust, reward, execution or fitting authority. */
import { createHash, verify } from 'node:crypto';
import { z } from 'zod';
import { canonical, LedgerFault } from '../../governed-execution/src/protocol';
export const S8_VERSION = 's8-capability-v1';
export const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
export const byteDigest = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
export function fault(code: string, status = 409): never { throw new LedgerFault(status, code); }
/** Keep classification in the module owning the fault; mixed .mts/.ts loaders
 * may instantiate distinct ESM and CJS wrappers for a dependency class. */
export function capabilityError(error: unknown) {
    if (error instanceof LedgerFault)
        return { status: error.status, body: { code: error.code, error: error.code } };
    if (error instanceof z.ZodError)
        return { status: 400, body: { code: 'S8_SCHEMA_INVALID', error: 'S8_SCHEMA_INVALID', fields: error.issues.map(i => ({ path: i.path, code: i.code })) } };
    return { status: 503, body: { code: 'S8_RUNTIME_UNAVAILABLE', error: 'S8_RUNTIME_UNAVAILABLE' } };
}
const text = z.string().min(1).max(4096), hex = z.string().regex(/^[a-f0-9]{64}$/), instant = z.string().datetime({ offset: true });
export const RefSchema = z.object({ owner: text, id: text, version: text, contentDigest: hex }).strict();
export type CapabilityRef = z.infer<typeof RefSchema>;
export const makeRef = (kind: string, body: unknown): CapabilityRef => ({ owner: 'S8', id: `${kind}:${digest(body)}`, version: S8_VERSION, contentDigest: digest(body) });
export const sameRef = (a: unknown, b: unknown) => digest(a) === digest(b);
export const SourcePinSchema = z.object({ path: text, sha256: hex }).strict();
export const AllocationMethodSchema = z.object({ schema: z.literal('finnor.s8.allocation-method.v1'), algorithm: z.enum(['ENUMERATE_EXACT', 'BRANCH_BOUND_EXACT']), order: z.enum(['CANONICAL', 'VALUE_IMPACT']), incumbent: z.enum(['FIRST_FEASIBLE', 'EMPTY_THEN_SEARCH']), maxPolicies: z.number().int().min(1).max(20), maximumNodes: z.number().int().min(1).max(2097151) }).strict();
export type AllocationMethod = z.infer<typeof AllocationMethodSchema>;
export const DomainSchema = z.object({ owner: z.literal('S5'), interface: z.literal('s5-joint-finite-v1'), maxPolicies: z.number().int().min(1).max(20), maxPeriods: z.number().int().min(1).max(64), maxScenarios: z.number().int().min(1).max(32), strata: z.array(text).min(1).max(64), rightsRef: text, validAfter: instant, validUntil: instant }).strict();
export const AllocationMethodAdmissionSchema = z.object({ body: z.object({ schema: z.literal('finnor.s8.s5-method-admission.v1'), domain: z.enum(['DISPOSABLE_TEST_AUTHORITY', 'REVIEWED_PROTECTED_DOMAIN']), tenantId: text, principalId: text, rightsRef: text, revisionRef: RefSchema, evaluationRef: RefSchema, admissionRef: RefSchema, payloadDigest: hex, dependencyDigest: hex, runtimeDigest: hex, validityDomainDigest: hex, resourceEnvelopeDigest: hex, validAfter: instant, validUntil: instant, executionAuthorityGranted: z.literal(false) }).strict(), signature: z.string().min(1).max(128) }).strict();
export type AllocationMethodAdmission = z.infer<typeof AllocationMethodAdmissionSchema>;
const EnvelopeSchema = z.object({ maxAttempts: z.number().int().min(1).max(4096), maxNodes: z.number().int().min(1).max(2097151), maxWallMs: z.number().int().min(1).max(30000), maxHumanSeconds: z.number().min(0).max(900), maxCost: z.number().min(0).max(10000), maxDecisionLoss: z.number().min(0).max(1000000000), maxUses: z.number().int().min(1).max(100000) }).strict();
export const RevisionBodySchema = z.object({ schema: z.literal('finnor.capability-revision.v1'), tenantId: text, principalId: text, episodeId: text, parents: z.array(RefSchema).max(32), owningInterface: z.literal('s5-joint-finite-v1'), payload: AllocationMethodSchema, dependencies: z.array(SourcePinSchema).min(1).max(64), runtime: z.object({ node: text, platform: text, architecture: text }).strict(), experience: z.object({ refs: z.array(RefSchema).min(1).max(256), knowledgeCut: instant, trainingCompanies: z.array(text).max(4096), dependenceGroups: z.array(text).max(4096), ownerAssessmentRef: RefSchema.optional(), historyCutDigest: hex.optional(), qualification: z.literal('AUTHENTICATED_OWNER_HISTORY_NO_CAUSAL_REWARD_ASSUMED') }).strict(), intendedImprovement: text, domain: DomainSchema, envelope: EnvelopeSchema, proposedAt: instant }).strict();
export type CapabilityRevisionBody = z.infer<typeof RevisionBodySchema>;
export type CapabilityRevision = CapabilityRevisionBody & {
    ref: CapabilityRef;
};
export const IntervalSchema = z.tuple([z.number().finite().min(0), z.number().finite().min(0)]).refine(([a, b]) => a <= b);
const GainIntervalSchema = z.tuple([z.number().finite(), z.number().finite()]).refine(([a, b]) => a <= b);
export const LifecycleCostSchema = z.object({ search: IntervalSchema.nullable(), training: IntervalSchema.nullable(), evaluation: IntervalSchema.nullable(), human: IntervalSchema.nullable(), computeData: IntervalSchema.nullable(), integration: IntervalSchema.nullable(), maintenance: IntervalSchema.nullable(), recovery: IntervalSchema.nullable(), deployment: IntervalSchema.nullable(), costRefs: z.array(RefSchema).max(256), currency: z.literal('USD'), basis: z.enum(['OBSERVED_COMPLETE', 'REGISTERED_GENERATIVE_MODEL', 'UNKNOWN']) }).strict();
export type LifecycleCost = z.infer<typeof LifecycleCostSchema>;
export const ProtocolSchema = z.object({ schema: z.literal('finnor.s8.evaluation-protocol.v1'), tenantId: text, principalId: text, revisionRef: RefSchema, evaluatorId: text, registeredAt: instant, trainingCutoff: instant, domain: DomainSchema, caseCommitments: z.array(hex).min(1).max(4096), companies: z.array(text).min(1).max(4096), dependenceGroups: z.array(text).min(1).max(4096), chronologicalStart: instant, chronologicalEnd: instant, strata: z.array(text).min(1).max(64), priorDomains: z.array(text).max(64), baselines: z.array(z.object({ id: text, kind: z.enum(['INCUMBENT', 'STRONG_FIXED', 'INDEPENDENT_EVOLUTION']), payloadDigest: hex, dependencyDigest: hex, resourceEnvelopeDigest: hex }).strict()).min(3).max(32), scoringAssetsDigest: hex, harnessDigest: hex, splitDigest: hex, oracle: z.enum(['EXACT_CANONICAL_REFERENCE', 'REFERENCE_QUALIFIED']), materialGain: z.number().positive(), scoreRange: z.number().positive(), confidence: z.literal(0.95), maxSubmissions: z.number().int().min(1).max(4096), maxWaves: z.number().int().min(1).max(256), minIndependentGroups: z.number().int().min(2).max(4096), floors: z.object({ correctness: z.number().min(0.95).max(1), regret: z.number().min(0).max(0.05), calibrationError: z.number().min(0).max(0.02), safetyViolations: z.literal(0), maxEpisodeCost: z.number().min(0).max(100), maxHumanSeconds: z.number().min(0).max(900) }).strict(), feedback: z.literal('FINAL_AGGREGATE_ONLY_ONE_USE'), horizon: z.literal('H1'), costAllocation: z.literal('COMPLETE_INCURRED_COST_NO_SPECULATIVE_REUSE') }).strict();
export type EvaluationProtocol = z.infer<typeof ProtocolSchema>;
export const EvaluationSummarySchema = z.object({ schema: z.literal('finnor.s8.evaluation-summary.v1'), protocolRef: RefSchema, revisionRef: RefSchema, evaluatorId: text, completedAt: instant, disposition: z.enum(['BENEFICIAL', 'HARMFUL', 'INCONCLUSIVE', 'REJECTED']), gain: GainIntervalSchema.nullable(), allFloorsPassed: z.boolean(), priorDomainsPassed: z.boolean(), costs: LifecycleCostSchema, failedCandidates: z.number().int().min(0), attemptsDigest: hex, resultsCommitment: hex, classification: z.enum(['DETERMINISTICALLY_VERIFIED', 'EMPIRICALLY_VERIFIED', 'PROBABILISTICALLY_SUPPORTED', 'PARTIAL', 'BLOCKED_EXTERNAL', 'UNKNOWN']), qualification: z.enum(['GENERATIVE_H1', 'PROSPECTIVE_H1']), reasons: z.array(text).max(256) }).strict();
export type EvaluationSummary = z.infer<typeof EvaluationSummarySchema>;
export interface Signed<T> {
    body: T;
    keyId: string;
    signature: string;
}
export interface AuthorityKey {
    id: string;
    principalId: string;
    publicKey: string;
    validAfter: string;
    validUntil: string;
    revoked: boolean;
}
export const assertSignature = <T>(signed: Signed<T>, keys: AuthorityKey[], principalId?: string) => {
    const key = keys.find(k => k.id === signed.keyId), now = Date.now();
    if (!key || key.revoked || principalId && key.principalId !== principalId || now < Date.parse(key.validAfter) || now >= Date.parse(key.validUntil) || !Number.isFinite(Date.parse(key.validUntil)) || typeof signed.signature !== 'string' || signed.signature.length > 128 || !verify(null, Buffer.from(canonical(signed.body)), key.publicKey, Buffer.from(signed.signature, 'base64')))
        fault('INDEPENDENT_SIGNATURE_OR_AUTHORITY_INVALID', 403);
    return key;
};
export const parseRevision = (input: unknown): CapabilityRevision => {
    const raw = z.object({ ref: RefSchema }).passthrough().parse(input);
    const { ref, ...rest } = raw, body = RevisionBodySchema.parse(rest);
    if (!sameRef(ref, makeRef('capability-revision', body)))
        fault('REVISION_CONTENT_IDENTITY_MISMATCH');
    if (body.domain.maxPolicies > body.payload.maxPolicies || body.payload.maximumNodes > body.envelope.maxNodes || Date.parse(body.domain.validUntil) <= Date.parse(body.domain.validAfter) || Date.parse(body.experience.knowledgeCut) > Date.parse(body.proposedAt) || new Set(body.experience.refs.map(r => r.id)).size !== body.experience.refs.length || new Set(body.domain.strata).size !== body.domain.strata.length || new Set(body.dependencies.map(d => d.path)).size !== body.dependencies.length)
        fault('REVISION_DOMAIN_OR_CUT_INVALID');
    return { ...body, ref };
};

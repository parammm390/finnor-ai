/** Authenticated ordinary S8 lifecycle; independent science/signatures stay external. */
import { assertCapabilitySourceClosure } from './source-closure';
import { assertCapabilityEconomicExperienceCurrent } from './experience';
import { ProtectedCapabilityEvents } from './protected-events';
import { verifyCapabilityMethod } from './protected-method';
import { ExecutionLineageSchema, verifyCapabilityEffectReconciliation, verifyCapabilityAdverseOutcome } from './reconciliation';
import { CanaryPlanSchema, CanaryLeaseSchema, verifyNativeCanaryPlan, verifyNativeCanaryUse, verifyNativeCanaryUncertainOutcome, assertNativeCanaryCapacity, type NativeCanaryPlan, type NativeCanaryUse } from './canary';
import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import type { CanonicalAllocationProblem } from '@finnor/shared-types';
import { verifyAllocationCertificateAsync } from '../../epistemic-runtime/src/allocation-verifier';
import { allocationSourcesCurrent } from '../../epistemic-runtime/src/allocation-producer';
import { runAllocationMethodProcess } from './search-process';
import { canonical } from '../../governed-execution/src/protocol';
import { readOwnerTransportReference, ownerTransportRoute, signOwnerDeliveryOrigin, deliverOwnerTransportIntent, resolveEconomicOwnerReference } from '../../governed-execution/src/owner-transport';
import { CapabilityJournal, privateFile, type JournalEntry } from './journal';
import { InterfaceCapabilityPort } from './interface-port';
import { digest, byteDigest, fault, parseRevision, makeRef, sameRef, RefSchema, ProtocolSchema, EvaluationSummarySchema, AllocationMethodAdmissionSchema, assertSignature, S8_VERSION, type Signed, type AuthorityKey, type CapabilityRevision, type EvaluationProtocol, type EvaluationSummary, type CapabilityRef, type AllocationMethodAdmission } from './contracts';
const Text = z.string().min(1).max(4096), Instant = z.string().datetime({ offset: true });
const KeySchema = z.object({ id: Text, principalId: Text, publicKey: Text, validAfter: Instant, validUntil: Instant, revoked: z.boolean() }).strict();
const PolicySchema = z.object({ schema: z.literal('finnor.s8.lifecycle-policy.v1'), domain: z.enum(['DISPOSABLE_TEST_AUTHORITY', 'REVIEWED_PROTECTED_DOMAIN']), tenantId: Text, principalId: Text, rightsRef: Text, responsibilityHandoff: z.object({ reference: RefSchema, previousSignedPolicy: z.object({ body: z.unknown(), keyId: Text, signature: Text }).strict(), previousReleaseRoot: Text }).strict().optional(), protectedEvents: z.object({ contract: z.literal('S8_CAPABILITY_EVENTS_V1'), maxRecoveryEvents: z.number().int().min(1).max(256) }).strict().optional(), validAfter: Instant, validUntil: Instant, actors: z.array(z.object({ id: Text, principalId: Text, tokenHash: z.string().regex(/^[a-f0-9]{64}$/), roles: z.array(z.enum(['PROPOSER', 'EVALUATOR', 'PROMOTER', 'CONSUMER', 'READER'])).min(1).max(2) }).strict()).min(4).max(64), evaluatorKeys: z.array(KeySchema).min(1).max(16), promotionKeys: z.array(KeySchema).min(1).max(16), costAuthorityPrincipalIds: z.array(Text).max(16), journalPublicKey: Text, allowedStrata: z.array(Text).min(1).max(64), maxEntries: z.number().int().min(1).max(100000), maxQueue: z.number().int().min(1).max(64), maxTotalCost: z.number().finite().min(0).max(1000000), maxTotalLoss: z.number().finite().min(0).max(1000000000), maxTotalUses: z.number().int().min(1).max(100000), sourcePins: z.array(z.object({ path: Text, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(64) }).strict();
type Policy = z.infer<typeof PolicySchema>;
type Actor = Policy['actors'][number];
interface Config {
    signedPolicy: Signed<Policy>;
    directory: string;
    signerPath: string;
    port?: number;
}
interface RevisionState {
    revision: CapabilityRevision;
    state: 'PROPOSED' | 'EVALUATED' | 'ADMITTED' | 'ACTIVATED' | 'SUPERSEDED' | 'REVOKED';
    protocols: Map<string, EvaluationProtocol>;
    evaluation: EvaluationSummary | null;
    admission: Signed<any> | null;
    activation: any | null;
}
export interface CapabilityUseLease {
    schema: 'finnor.s8.capability-use.v1';
    useId: string;
    revisionRef: CapabilityRef;
    payload: CapabilityRevision['payload'];
    domain: CapabilityRevision['domain'];
    activationRef: CapabilityRef;
    inputDigest: string;
    generation: number;
    mode: 'SHADOW' | 'CANARY' | 'FULL';
    maxDecisionLoss: number;
    reservedCost: number;
    expiresAt: string;
    status: 'PINNED_PENDING';
    executionAuthorityGranted: false;
    methodAdmission?: AllocationMethodAdmission;
    canary?: { plan: NativeCanaryPlan; binding: NativeCanaryUse };
}
export class CapabilityEvolution {
    private interfaces: InterfaceCapabilityPort;
    private states = new Map<string, RevisionState>();
    private active: string | null = null;
    private generation = 0;
    private uses = new Map<string, any>();
    private consumedGroups = new Set<string>();
    private consumedCases = new Set<string>();
    private totalCost = 0;
    private totalLoss = 0;
    private useCount = 0;
    private attempts: any[] = [];
    private queue: Promise<unknown> = Promise.resolve();
    private queued = 0;
    private protectedEvents: ProtectedCapabilityEvents | null;
    private handedOff = false;
    private importedLeases = new Map<string, CapabilityUseLease>();
    private inheritedHandoff: any = null;
    private constructor(readonly policy: Policy, private journal: CapabilityJournal) {
        this.interfaces = new InterfaceCapabilityPort(policy);
        this.protectedEvents = policy.protectedEvents ? new ProtectedCapabilityEvents({ ...policy, protectedEvents: policy.protectedEvents }, journal.policyDigest) : null;
        for (const e of journal.entries)
            this.replay(e);
    }
    static async open(path: string, root: string) {
        const cfg = JSON.parse((await privateFile(path)).toString()) as Config;
        const policy = PolicySchema.parse(cfg.signedPolicy.body);
        if (policy.domain === 'REVIEWED_PROTECTED_DOMAIN' && !policy.protectedEvents)
            fault('S8_PROTECTED_EVENT_CONTRACT_REQUIRED', 503);
        await assertCapabilitySourceClosure(policy.sourcePins);
        assertSignature(cfg.signedPolicy, [{ id: cfg.signedPolicy.keyId, principalId: 'RELEASE_ROOT', publicKey: root, validAfter: policy.validAfter, validUntil: policy.validUntil, revoked: false }]);
        if (new Set(policy.actors.map(a => a.id)).size !== policy.actors.length || [policy.evaluatorKeys, policy.promotionKeys].some(keys => new Set(keys.map(k => k.id)).size !== keys.length))
            fault('S8_AMBIGUOUS_AUTHORITY_IDENTITY', 503);
        const fingerprint = (value: string) => {
            const key = createPublicKey(value);
            if (key.asymmetricKeyType !== 'ed25519') fault('S8_AUTHORITY_KEY_TYPE_INVALID', 503);
            return byteDigest(key.export({ type: 'spki', format: 'der' }));
        };
        const evaluatorFingerprints = new Set(policy.evaluatorKeys.map(k => fingerprint(k.publicKey)));
        if (policy.promotionKeys.some(k => evaluatorFingerprints.has(fingerprint(k.publicKey))))
            fault('S8_AUTHORITY_NOT_SEPARATED', 503);
        const principals = new Set<string>(), tokens = new Set<string>();
        for (const a of policy.actors) {
            if (tokens.has(a.tokenHash))
                fault('S8_SHARED_ROLE_CREDENTIAL', 503);
            tokens.add(a.tokenHash);
            if (a.roles.includes('PROPOSER') && a.roles.some(r => ['EVALUATOR', 'PROMOTER'].includes(r)))
                fault('S8_SELF_ADMISSION_ROLE', 503);
            if (a.roles.includes('PROPOSER'))
                principals.add(a.principalId);
        }
        if (policy.costAuthorityPrincipalIds.some(id => principals.has(id)) || policy.evaluatorKeys.some(k => principals.has(k.principalId)) || policy.promotionKeys.some(k => principals.has(k.principalId)) || policy.evaluatorKeys.some(k => policy.promotionKeys.some(p => p.publicKey === k.publicKey)))
            fault('S8_AUTHORITY_NOT_SEPARATED', 503);
        await CapabilityEvolution.sources(policy.sourcePins);
        let recovered: any = null;
        const journal = await CapabilityJournal.open(cfg.directory, cfg.signerPath, policy.journalPublicKey, digest(policy), policy.maxEntries, async (tail, discarded) => {
            await CapabilityEvolution.verifyCheckpointTail(policy, tail);
            recovered = { schema: 'finnor.s8.journal-recovery.v1', policyDigest: digest(policy), retainedSequence: tail?.sequence ?? 0, retainedDigest: tail?.digest ?? null, discardedUnacceptedTail: discarded, qualification: 'VERIFIED_PREFIX_AND_S6_CHECKPOINT_BOUNDARY_ONLY_NO_OS_ADMIN_PROTECTION' };
        });
        const service = new CapabilityEvolution(policy, journal);
        try {
            await service.ensureRuntimeContinuityAnchor();
            await service.recoverCheckpoints();
            await service.importResponsibilities();
            if (recovered)
                await service.persist({ requestId: 'journal-recovery:' + digest(recovered), requestDigest: digest(recovered), actorId: 'SIGNED_POLICY_RECOVERY', operation: 'JOURNAL_RECOVERY', body: recovered, result: await service.commitReference('capability-journal-recovery', recovered) });
            await service.recoverPendingSearch();
            return service;
        }
        catch (error) {
            await service.close();
            throw error;
        }
    }
    private static async sources(pins: Array<{
        path: string;
        sha256: string;
    }>) {
        const { open } = await import('node:fs/promises');
        const { constants } = await import('node:fs');
        for (const pin of pins) {
            const fd = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const stat = await fd.stat();
                if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || byteDigest(await fd.readFile()) !== pin.sha256)
                    fault('S8_DEPENDENCY_BYTES_CHANGED');
            }
            finally {
                await fd.close();
            }
        }
    }
    private actor(token: string) {
        if (Date.now() < Date.parse(this.policy.validAfter) || Date.now() >= Date.parse(this.policy.validUntil))
            fault('S8_POLICY_EXPIRED', 403);
        const actor = this.policy.actors.find(a => a.tokenHash === byteDigest(token));
        if (!actor)
            fault('S8_IDENTITY_INVALID', 401);
        return actor;
    }
    private role(a: Actor, r: Actor['roles'][number]) {
        if (!a.roles.includes(r))
            fault('S8_OPERATION_NOT_AUTHORIZED', 403);
    }
    private state(ref: CapabilityRef) {
        const s = this.states.get(ref.id);
        if (!s || !sameRef(s.revision.ref, ref))
            fault('S8_REVISION_NOT_FOUND', 404);
        return s;
    }
    private scope(body: {
        tenantId?: string;
        principalId?: string;
    }) {
        if (body.tenantId !== this.policy.tenantId || body.principalId !== this.policy.principalId)
            fault('S8_TENANT_OR_OWNER_MISMATCH', 403);
    }
    private current(s: RevisionState) {
        const r = s.revision;
        this.scope(r);
        if (s.state === 'REVOKED' || !s.admission || Date.now() < Date.parse(r.domain.validAfter) || Date.now() >= Date.parse(r.domain.validUntil))
            fault('S8_REVISION_UNADMITTED_REVOKED_OR_EXPIRED', 403);
        assertSignature(s.admission, this.policy.evaluatorKeys);
    }
    private async currentExperience(r: CapabilityRevision) {
        const native = r.experience.ownerAssessmentRef || r.experience.historyCutDigest || r.experience.refs.some(ref => ref.owner === 'S7' && ref.version.startsWith('s7-economic-record-'));
        if (!native && this.policy.domain === 'DISPOSABLE_TEST_AUTHORITY')
            return;
        await assertCapabilityEconomicExperienceCurrent({ auth: { tenantId: r.tenantId, userId: r.principalId, employeeId: r.principalId, role: 'owner' } }, r);
    }
    private async currentUse(use: any) {
        const s = this.state(use.revisionRef);
        this.current(s);
        await this.currentExperience(s.revision);
        if (use.status !== 'PINNED_PENDING')
            fault('S8_USE_ALREADY_RECONCILED');
        if (this.active !== s.revision.ref.id || this.generation !== use.generation || Date.parse(use.expiresAt) <= Date.now())
            fault('S8_USE_STALE_OR_REVOKED');
        await CapabilityEvolution.sources(s.revision.dependencies);
        await this.protectedCurrent(makeRef('capability-admission', s.admission));
        if (!sameRef(use.methodAdmission ?? null, s.activation?.methodAdmission ?? null))
            fault('S8_USE_METHOD_ADMISSION_SUBSTITUTION');
        await this.currentMethod(s);
        await this.currentCanary(s, use);
    }
    private canaryScope() { return { tenantId: this.policy.tenantId, principalId: this.policy.principalId, rightsRef: this.policy.rightsRef, protectionDomain: this.policy.domain }; }
    private async currentCanary(s: RevisionState, use?: CapabilityUseLease, activation = s.activation) {
        if (!activation?.canaryPlan) {
            if (use?.canary || activation?.mode === 'CANARY') fault('S8_NATIVE_CANARY_PLAN_REQUIRED', 503);
            return;
        }
        const plan = CanaryPlanSchema.parse(activation.canaryPlan);
        if (Date.parse(activation.validUntil) > Date.parse(plan.stopAt)) fault('S8_CANARY_ACTIVATION_EXCEEDS_STOP');
        if (use) {
            const canary = CanaryLeaseSchema.parse(use.canary);
            if (!sameRef(canary.plan, plan) || use.reservedCost !== plan.reservedCostPerUse) fault('S8_CANARY_USE_PLAN_SUBSTITUTION');
            await verifyNativeCanaryUse(this.canaryScope(), s.revision, plan, canary.binding);
            assertNativeCanaryCapacity(plan, [...this.uses.values()], canary.binding, use.useId);
        } else {
            await verifyNativeCanaryPlan(this.canaryScope(), s.revision, plan);
            assertNativeCanaryCapacity(plan, [...this.uses.values()]);
        }
    }
    private async currentMethod(s: RevisionState, activation = s.activation) {
        if (!activation?.methodAdmission) {
            if (this.policy.domain === 'REVIEWED_PROTECTED_DOMAIN' || activation?.mode !== 'SHADOW')
                fault('S8_PROTECTED_METHOD_ADMISSION_REQUIRED', 503);
            return;
        }
        if (!s.evaluation || !s.admission)
            fault('S8_PROTECTED_METHOD_ADMISSION_REQUIRED', 503);
        if (Date.parse(activation.validUntil) > Date.parse(activation.methodAdmission.body.validUntil))
            fault('S8_ACTIVATION_EXCEEDS_METHOD_ADMISSION');
        await verifyCapabilityMethod({ revision: s.revision, evaluationRef: makeRef('capability-evaluation', s.evaluation), admissionRef: makeRef('capability-admission', s.admission), methodAdmission: activation.methodAdmission, protectionDomain: this.policy.domain });
    }
    private campaignDefinition(p: EvaluationProtocol) { return digest({ domain: p.domain, strata: p.strata, priorDomains: p.priorDomains, oracle: p.oracle, horizon: p.horizon, scoringAssetsDigest: p.scoringAssetsDigest, harnessDigest: p.harnessDigest, baselines: p.baselines, materialGain: p.materialGain, scoreRange: p.scoreRange, confidence: p.confidence, maxSubmissions: p.maxSubmissions, maxWaves: p.maxWaves, minIndependentGroups: p.minIndependentGroups, floors: p.floors, feedback: p.feedback, costAllocation: p.costAllocation }); }
    private async commitReference(kind: string, content: any) {
        return this.commitNamedReference(makeRef(kind, content), content);
    }
    private async commitNamedReference(ref: CapabilityRef, content: any) {
        const identity = { semanticOwner: 'S8', tenantId: this.policy.tenantId, principalId: this.policy.principalId }, route = await ownerTransportRoute(identity);
        if (!route)
            fault('S8_PROTECTED_REFERENCE_AUTHORITY_UNAVAILABLE', 503);
        if (route.protectionDomain !== this.policy.domain)
            fault('S8_REFERENCE_PROTECTION_DOMAIN_MISMATCH', 503);
        const payload = { reference: { ...ref, content }, rightsRefs: [this.policy.rightsRef] }, signed = await signOwnerDeliveryOrigin(route, { ...identity, kind: 'REFERENCE', identity: ref.id, payload });
        const answer = await deliverOwnerTransportIntent(identity, signed.envelope, signed.signature);
        return { ref, receipt: answer.receipt };
    }
    /** Target identity excludes the proof reference to avoid a circular hash. */
    static handoffTargetDigest(policy: unknown) { const { responsibilityHandoff: _proof, ...target } = PolicySchema.parse(policy); return digest(target); }
    private async handoffEntry(entry: JournalEntry) {
        if (entry.operation !== 'REVOKE' || entry.result.runtimeHandoff !== true) return;
        const ref = { owner: 'S8', id: `capability-handoff-entry:${this.journal.policyDigest}:${entry.sequence}`, version: S8_VERSION, contentDigest: digest(entry) };
        await this.commitNamedReference(ref, entry);
    }
    private async ensureRuntimeContinuityAnchor() {
        const identity = { semanticOwner: 'S8', tenantId: this.policy.tenantId, principalId: this.policy.principalId }, id = `capability-runtime-origin:${this.policy.tenantId}:${this.policy.principalId}`;
        let accepted: Awaited<ReturnType<typeof readOwnerTransportReference>> | null = null;
        try { accepted = await readOwnerTransportReference(identity, id); } catch (error: any) { if (error.code !== 'REFERENCE_NOT_FOUND') throw error; }
        if (!accepted) {
            if (this.policy.responsibilityHandoff) fault('S8_HANDOFF_ORIGINAL_RUNTIME_ANCHOR_REQUIRED');
            const content = { schema: 'finnor.s8.runtime-continuity-origin.v1', tenantId: this.policy.tenantId, principalId: this.policy.principalId, policyDigest: digest(this.policy), protectionDomain: this.policy.domain };
            await this.commitNamedReference({ owner: 'S8', id, version: S8_VERSION, contentDigest: digest(content) }, content);
            return;
        }
        const anchor = accepted.reference.content;
        if (accepted.reference.owner !== 'S8' || anchor.schema !== 'finnor.s8.runtime-continuity-origin.v1' || anchor.tenantId !== this.policy.tenantId || anchor.principalId !== this.policy.principalId || anchor.protectionDomain !== this.policy.domain)
            fault('S8_HANDOFF_ORIGINAL_RUNTIME_ANCHOR_REQUIRED');
        if (anchor.policyDigest === digest(this.policy)) return;
        if (!this.policy.responsibilityHandoff) fault('S8_POLICY_RESPONSIBILITY_HANDOFF_REQUIRED', 503);
        const proof = await this.resolveResponsibilityHandoff();
        let previous = PolicySchema.parse(this.policy.responsibilityHandoff.previousSignedPolicy.body);
        const ancestors = [...proof!.capsule.predecessorHandoffs].reverse();
        for (const ref of ancestors) {
            const configuration = previous.responsibilityHandoff;
            if (!configuration || !sameRef(configuration.reference, ref)) fault('S8_HANDOFF_ANCESTRY_SUBSTITUTION');
            const parent = PolicySchema.parse(configuration.previousSignedPolicy.body), key = createPublicKey(configuration.previousReleaseRoot);
            if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(parent)), key, Buffer.from(configuration.previousSignedPolicy.signature, 'base64'))
                || parent.tenantId !== this.policy.tenantId || parent.principalId !== this.policy.principalId || parent.rightsRef !== this.policy.rightsRef || parent.domain !== this.policy.domain) fault('S8_HANDOFF_ANCESTRY_SUBSTITUTION');
            const original = (await this.protectedCurrent(ref)).reference.content;
            if (ref.owner !== 'S8' || original.schema !== 'finnor.s8.responsibility-handoff.v1' || original.previousPolicyDigest !== digest(parent)
                || original.successorPolicyDigest !== CapabilityEvolution.handoffTargetDigest(previous)) fault('S8_HANDOFF_ANCESTRY_SUBSTITUTION');
            previous = parent;
        }
        if (previous.responsibilityHandoff || anchor.policyDigest !== digest(previous)) fault('S8_HANDOFF_ANCESTRY_SUBSTITUTION');
    }
    private async resolveResponsibilityHandoff() {
        const configured = this.policy.responsibilityHandoff;
        if (!configured) return null;
        const prior = PolicySchema.parse(configured.previousSignedPolicy.body), root = createPublicKey(configured.previousReleaseRoot);
        if (root.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(prior)), root, Buffer.from(configured.previousSignedPolicy.signature, 'base64'))
            || prior.tenantId !== this.policy.tenantId || prior.principalId !== this.policy.principalId || prior.rightsRef !== this.policy.rightsRef || prior.domain !== this.policy.domain)
            fault('S8_HANDOFF_PREDECESSOR_POLICY_OR_SCOPE_INVALID', 403);
        const accepted = await this.protectedCurrent(configured.reference), capsule = accepted.reference.content;
        if (configured.reference.owner !== 'S8' || capsule.schema !== 'finnor.s8.responsibility-handoff.v1' || capsule.previousPolicyDigest !== digest(prior)
            || capsule.successorPolicyDigest !== CapabilityEvolution.handoffTargetDigest(this.policy) || capsule.tenantId !== this.policy.tenantId
            || capsule.principalId !== this.policy.principalId || capsule.rightsRef !== this.policy.rightsRef || capsule.actionableActivationTransferred !== false
            || !Number.isSafeInteger(capsule.sequence) || capsule.sequence < 1 || capsule.sequence > prior.maxEntries || !Number.isSafeInteger(capsule.generation) || capsule.generation < 1)
            fault('S8_HANDOFF_TARGET_OR_IDENTITY_SUBSTITUTION');
        const row = await readOwnerTransportReference({ semanticOwner: 'S8', tenantId: this.policy.tenantId, principalId: this.policy.principalId }, `capability-handoff-entry:${digest(prior)}:${capsule.sequence}`), entry = row.reference.content as JournalEntry;
        const { digest: originalDigest, signature, ...entryBody } = entry, actor = prior.actors.find(a => a.id === entry.actorId), key = prior.promotionKeys.find(k => k.id === entry.body?.keyId), time = Date.parse(entry.knowledgeAt);
        if (originalDigest !== digest(entryBody) || entry.policyDigest !== digest(prior) || entry.sequence !== capsule.sequence || entry.operation !== 'REVOKE'
            || entry.result.runtimeHandoff !== true || !sameRef(entry.result.ref, configured.reference) || !actor?.roles.includes('PROMOTER') || !key || key.revoked || key.principalId !== actor.principalId
            || !Number.isFinite(time) || time < Date.parse(prior.validAfter) || time >= Date.parse(prior.validUntil) || time < Date.parse(key.validAfter) || time >= Date.parse(key.validUntil)
            || entry.body.body.runtimeHandoff !== true || entry.body.body.expectedGeneration + 1 !== capsule.generation || entry.body.body.successorPolicyDigest !== capsule.successorPolicyDigest
            || !verify(null, Buffer.from(canonical(entry.body.body)), key.publicKey, Buffer.from(entry.body.signature, 'base64'))
            || !verify(null, Buffer.from(canonical({ ...entryBody, digest: originalDigest })), prior.journalPublicKey, Buffer.from(signature, 'base64')))
            fault('S8_HANDOFF_ORIGINAL_SIGNED_ENTRY_REQUIRED', 403);
        const checkpoint = await CapabilityEvolution.verifyCheckpointTail(prior, entry);
        if (!checkpoint) fault('S8_HANDOFF_FINAL_CHECKPOINT_REQUIRED', 503);
        if (!Array.isArray(capsule.uses) || !Array.isArray(capsule.originalLeases) || !Array.isArray(capsule.attempts) || !Array.isArray(capsule.consumedGroups) || !Array.isArray(capsule.consumedCases)
            || !Array.isArray(capsule.predecessorHandoffs) || capsule.predecessorHandoffs.length > 8 || capsule.uses.length > 4096 || capsule.attempts.length > 4096
            || capsule.consumedGroups.length > 65536 || capsule.consumedCases.length > 65536 || capsule.originalLeases.length !== capsule.uses.length)
            fault('S8_HANDOFF_RETENTION_BOUND');
        const ids = new Set<string>();
        for (const use of capsule.uses) {
            const original = capsule.originalLeases.find((l: CapabilityUseLease) => l.useId === use.useId);
            if (!original || ids.has(use.useId) || original.domain.rightsRef !== this.policy.rightsRef || original.executionAuthorityGranted !== false
                || !['PINNED_PENDING', 'RECONCILED'].includes(use.status) || !sameRef(original.revisionRef, use.revisionRef) || original.inputDigest !== use.inputDigest
                || original.reservedCost !== use.reservedCost || original.maxDecisionLoss !== use.maxDecisionLoss || !Number.isFinite(use.reservedCost) || use.reservedCost < 0 || !Number.isFinite(use.maxDecisionLoss) || use.maxDecisionLoss < 0)
                fault('S8_HANDOFF_ORIGINAL_USE_SUBSTITUTION');
            ids.add(use.useId);
        }
        const calculatedCost = capsule.attempts.reduce((v: number, a: any) => v + a.reservedCost, 0) + capsule.uses.reduce((v: number, u: any) => v + u.reservedCost, 0), calculatedLoss = capsule.uses.reduce((v: number, u: any) => v + u.maxDecisionLoss, 0);
        const accounting = capsule.accounting;
        if (!accounting || !Number.isFinite(accounting.totalCost) || !Number.isFinite(accounting.totalLoss) || Math.abs(accounting.totalCost - calculatedCost) > 1e-9
            || Math.abs(accounting.totalLoss - calculatedLoss) > 1e-9 || accounting.useCount !== capsule.uses.length || accounting.totalCost > this.policy.maxTotalCost
            || accounting.totalLoss > this.policy.maxTotalLoss || accounting.useCount > this.policy.maxTotalUses || !Number.isFinite(calculatedCost) || !Number.isFinite(calculatedLoss))
            fault('S8_HANDOFF_ACCOUNTING_OR_SUCCESSOR_ENVELOPE_INVALID');
        return { capsule, entry, checkpoint, reference: configured.reference };
    }
    private async importResponsibilities() {
        const proof = await this.resolveResponsibilityHandoff();
        if (!proof) return;
        const prior = this.journal.entries.find(e => e.operation === 'JOURNAL_RECOVERY' && e.result.responsibilityImport === true);
        if (prior) {
            if (!sameRef(prior.result.capsule, proof.capsule) || !sameRef(prior.body.handoffRef, proof.reference)) fault('S8_HANDOFF_IMPORT_SUBSTITUTION');
            return;
        }
        if (this.journal.entries.length) fault('S8_HANDOFF_IMPORT_MUST_START_NEW_JOURNAL');
        const body = { schema: 'finnor.s8.responsibility-import.v1', handoffRef: proof.reference, predecessorCheckpoint: proof.checkpoint.receipt, actionableActivationTransferred: false };
        await this.persist({ requestId: 'responsibility-import:' + digest(body), requestDigest: digest(body), actorId: 'SIGNED_SUCCESSOR_POLICY', operation: 'JOURNAL_RECOVERY', body,
            result: { ...(await this.commitReference('capability-responsibility-import', body)), responsibilityImport: true, capsule: proof.capsule, liabilityBudgetReleased: false, executionAuthorityGranted: false } });
    }
    private checkpointId(sequence: number) { return `capability-checkpoint:${this.journal.policyDigest}:${sequence}`; }
    private static async readCheckpoint(policy: Policy, sequence: number) {
        try {
            return await readOwnerTransportReference({ semanticOwner: 'S8', tenantId: policy.tenantId, principalId: policy.principalId }, `capability-checkpoint:${digest(policy)}:${sequence}`);
        }
        catch (error) {
            if ((error as any)?.code === 'REFERENCE_NOT_FOUND')
                return null;
            throw error;
        }
    }
    private static async verifyCheckpointTail(policy: Policy, tail: JournalEntry | null | undefined) {
        if (await CapabilityEvolution.readCheckpoint(policy, (tail?.sequence ?? 0) + 1))
            fault('S8_JOURNAL_ROLLBACK_DETECTED', 503);
        if (!tail)
            return null;
        const accepted = await CapabilityEvolution.readCheckpoint(policy, tail.sequence);
        if (accepted) {
            const c = accepted.reference.content;
            if (c.policyDigest !== digest(policy) || c.sequence !== tail.sequence || c.entryDigest !== tail.digest || c.previousDigest !== tail.previous)
                fault('S8_JOURNAL_CHECKPOINT_SUBSTITUTION', 503);
        }
        return accepted;
    }
    private async checkpoint(entry: JournalEntry) {
        const content = { schema: 'finnor.s8.lifecycle-checkpoint.v1', policyDigest: this.journal.policyDigest, sequence: entry.sequence, entryDigest: entry.digest, previousDigest: entry.previous };
        return this.commitNamedReference({ owner: 'S8', id: this.checkpointId(entry.sequence), version: S8_VERSION, contentDigest: digest(content) }, content);
    }
    private async recoverCheckpoints() {
        const tail = this.journal.entries.at(-1), accepted = await CapabilityEvolution.verifyCheckpointTail(this.policy, tail);
        if (tail) await this.handoffEntry(tail);
        if (tail && !accepted)
            await this.checkpoint(tail);
        await this.protectedEvents?.recover(this.journal.entries);
    }
    private async persist(input: Omit<JournalEntry, 'sequence' | 'previous' | 'policyDigest' | 'digest' | 'signature' | 'knowledgeAt'>) {
        const entry = await this.journal.append(input);
        this.replay(entry);
        await this.handoffEntry(entry);
        await this.checkpoint(entry);
        await this.protectedEvents?.recover(this.journal.entries);
        return entry;
    }
    private async recoverPendingSearch() {
        for (const start of this.journal.entries.filter(e => e.operation === 'ATTEMPT' && e.result.managedRun)) {
            const attempt = this.attempts.find(a => a.attemptId === start.result.attempt.attemptId);
            if (attempt?.status !== 'PENDING')
                continue;
            const request = start.result.managedRun;
            const result = { attemptId: attempt.attemptId, completion: { status: 'UNKNOWN', actualCost: null, error: 'SERVICE_INTERRUPTED_AFTER_DURABLE_START', outputDigest: null, finishedAt: new Date().toISOString() }, result: null, computeRef: null, reservationRetained: true, automaticRetry: false, qualification: 'DISPOSABLE_BOUNDED_COMPUTATION_UNKNOWN_OUTCOME_NO_LIVE_AUTHORITY' };
            await this.persist({ requestId: request.requestId, requestDigest: request.requestDigest, actorId: start.actorId, operation: 'RUN_SEARCH', body: request.body, result });
        }
    }
    private async protectedCurrent(ref: CapabilityRef) {
        const row = await readOwnerTransportReference({ semanticOwner: 'S8', tenantId: this.policy.tenantId, principalId: this.policy.principalId }, ref.id);
        const { content, ...original } = row.reference;
        if (!sameRef(original, ref))
            fault('S8_PROTECTED_COMMITMENT_SUBSTITUTION');
        return row;
    }
    private replay(entry: JournalEntry) {
        if (entry.operation.startsWith('INTERFACE_')) { this.interfaces.replay(entry); return; }
        const b = entry.body, r = entry.result;
        if (entry.operation === 'JOURNAL_RECOVERY' && r.responsibilityImport === true) {
            const capsule = r.capsule;
            for (const use of capsule.uses) this.uses.set(use.useId, structuredClone(use));
            for (const lease of capsule.originalLeases) this.importedLeases.set(lease.useId, structuredClone(lease));
            this.attempts.push(...structuredClone(capsule.attempts));
            for (const group of capsule.consumedGroups) this.consumedGroups.add(group);
            for (const target of capsule.consumedCases) this.consumedCases.add(target);
            this.totalCost = capsule.accounting.totalCost; this.totalLoss = capsule.accounting.totalLoss; this.useCount = capsule.accounting.useCount;
            this.generation = capsule.generation; this.inheritedHandoff = b.handoffRef;
        }
        if (entry.operation === 'REVOKE' && r.runtimeHandoff === true) { if (this.active) this.states.get(this.active)!.state = 'SUPERSEDED'; this.active = null; this.handedOff = true; this.generation = r.generation; return; }
        if (entry.operation === 'PROPOSE')
            this.states.set(b.ref.id, { revision: b, state: 'PROPOSED', protocols: new Map(), evaluation: null, admission: null, activation: null });
        if (entry.operation === 'ATTEMPT') {
            this.attempts.push(structuredClone(r.attempt));
            this.totalCost += r.attempt.reservedCost;
        }
        if (entry.operation === 'RUN_SEARCH') {
            const attempt = this.attempts.find(a => a.attemptId === r.attemptId);
            if (!attempt)
                fault('S8_SEARCH_COMPLETION_WITHOUT_START', 503);
            Object.assign(attempt, r.completion);
        }
        if (entry.operation === 'REGISTER') {
            const s = this.state(b.body.revisionRef);
            s.protocols.set(r.ref.id, b.body);
            for (const g of b.body.dependenceGroups)
                this.consumedGroups.add(g);
            for (const c of b.body.caseCommitments)
                this.consumedCases.add(c);
        }
        if (entry.operation === 'EVALUATE') {
            const s = this.state(b.body.revisionRef);
            s.state = 'EVALUATED';
            s.evaluation = b.body;
        }
        if (entry.operation === 'ADMIT') {
            const s = this.state(b.body.revisionRef);
            s.admission = b;
            s.state = 'ADMITTED';
        }
        if (entry.operation === 'ACTIVATE') {
            if (this.active) {
                const old = this.states.get(this.active)!;
                if (old.state !== 'REVOKED')
                    old.state = 'SUPERSEDED';
            }
            const s = this.state(b.body.revisionRef);
            s.state = 'ACTIVATED';
            s.activation = { ...b.body, ref: r.ref };
            this.active = s.revision.ref.id;
            this.generation++;
        }
        if (entry.operation === 'REVOKE') {
            const s = this.state(b.body.revisionRef);
            s.state = 'REVOKED';
            if (this.active === s.revision.ref.id)
                this.active = null;
            this.generation++;
            if (b.body.predecessorRef) {
                const predecessor = this.state(b.body.predecessorRef);
                predecessor.state = 'ACTIVATED';
                predecessor.activation = { ...predecessor.activation, restoredBy: r.ref };
                this.active = predecessor.revision.ref.id;
            }
        }
        if (entry.operation === 'USE') {
            this.uses.set(r.lease.useId, structuredClone(r.lease));
            this.totalCost += r.lease.reservedCost;
            this.totalLoss += r.lease.maxDecisionLoss;
            this.useCount++;
        }
        if (entry.operation === 'RECONCILE') {
            const use = this.uses.get(b.useId);
            use.reconciliations ??= [];
            use.reconciliations.push({ evidenceRef: b.evidenceRef, outcome: b.outcome, priorEvidenceRef: b.priorEvidenceRef ?? null, reconciliationRef: r.ref, knowledgeAt: entry.knowledgeAt, effectLineage: r.effectLineage ?? null });
            if (r.effectLineage) { use.effectLineage = r.effectLineage; use.ownerLossDispositionQualified = false; }
            use.status = 'RECONCILED';
            use.outcome = b.outcome;
            use.evidenceRef = b.evidenceRef; /* Reservation totals never reset, even after rollback. */
        }
    }
    async command(token: string, input: {
        requestId: string;
        operation: string;
        body: any;
    }): Promise<any> {
        if (this.queued >= this.policy.maxQueue)
            fault('S8_QUEUE_BOUND', 429);
        this.queued++;
        const run = this.queue.then(async () => {
            const a = this.actor(token);
            if (!/^[A-Za-z0-9:_-]{1,256}$/.test(input.requestId))
                fault('S8_REQUEST_ID_INVALID', 400);
            await this.journal.assertIntegrity();
            await this.recoverCheckpoints();
            await this.recoverPendingSearch();
            const requestDigest = digest({ actorId: a.id, ...input }), prior = this.journal.entries.find(e => e.requestId === input.requestId);
            if (prior) {
                if (prior.requestDigest !== requestDigest)
                    fault('S8_IDEMPOTENCY_SUBSTITUTION');
                // Interface current-use reads are deliberately never journaled or
                // replayed from a cached admission. Every serve checks current use.
                if (input.operation.startsWith('INTERFACE_'))
                    await CapabilityEvolution.sources(this.policy.sourcePins);
                if (input.operation === 'USE') {
                    const use = this.uses.get(prior.result.lease.useId);
                    if (!use)
                        fault('S8_USE_IDENTITY_SUBSTITUTION');
                    await this.currentUse(use);
                }
                await this.checkpoint(prior);
                return prior.result;
            }
            await CapabilityEvolution.sources(this.policy.sourcePins);
            if (this.handedOff && input.operation !== 'READ') fault('S8_RUNTIME_RESPONSIBILITY_TRANSFERRED', 403);
            if (this.policy.responsibilityHandoff) await this.resolveResponsibilityHandoff();
            const b = input.body;
            let result: any, journalOperation = input.operation;
            if (input.operation.startsWith('INTERFACE_')) {
                const answer = await this.interfaces.command(a, input.operation, b,
                    (ref, content) => this.commitNamedReference(ref, content));
                if (!answer.readOnly)
                    await this.persist({ requestId: input.requestId, requestDigest, actorId: a.id,
                        operation: input.operation, body: b, result: answer.result });
                return answer.result;
            }
            switch (input.operation) {
                case 'READ': {
                    this.role(a, 'READER');
                    const page = z.object({ offset: z.number().int().min(0).max(100000).default(0), limit: z.number().int().min(1).max(256).default(256), atSequence: z.number().int().min(0).optional() }).strict().parse(b), sequence = this.journal.entries.at(-1)?.sequence ?? 0;
                    if (page.atSequence !== undefined && page.atSequence !== sequence)
                        fault('S8_READ_SNAPSHOT_CHANGED');
                    const take = <T>(items: T[]) => items.slice(page.offset, page.offset + page.limit), count = Math.max(this.states.size, this.attempts.length, this.uses.size, this.journal.entries.length), nextOffset = page.offset + page.limit < count ? page.offset + page.limit : null;
                    return { ...(this.handedOff || this.inheritedHandoff ? { responsibilityContinuity: { transferred: this.handedOff, inheritedHandoff: this.inheritedHandoff, actionableActivationTransferred: false } } : {}), active: this.active, generation: this.generation, revisions: take([...this.states.values()]).map(s => ({ ref: s.revision.ref, state: s.state, evaluation: s.evaluation, activation: s.activation })), attempts: take(this.attempts), uses: take([...this.uses.values()]), accounting: { totalCost: this.totalCost, totalLoss: this.totalLoss, useCount: this.useCount }, history: take(this.journal.entries).map(e => ({ sequence: e.sequence, operation: e.operation, requestId: e.requestId, digest: e.digest, knowledgeAt: e.knowledgeAt })), page: { offset: page.offset, limit: page.limit, sequence, nextOffset, complete: page.offset === 0 && nextOffset === null }, counts: { revisions: this.states.size, attempts: this.attempts.length, uses: this.uses.size, history: this.journal.entries.length }, protectedHistory: this.protectedEvents?.snapshot() ?? null, qualification: this.protectedEvents ? 'SIGNED_JOURNAL_AND_AUTHENTICATED_CONSECUTIVE_S6_EVENTS_NO_VALUE_OR_EFFECT_AUTHORITY' : 'ORDINARY_SIGNED_HISTORY_AND_S6_REFERENCE_COMMITMENTS_NO_PROTECTED_S8_EVENT_APPEND' };
                }
                case 'PROPOSE': {
                    this.role(a, 'PROPOSER');
                    const r = parseRevision(b);
                    this.scope(r);
                    if (r.domain.rightsRef !== this.policy.rightsRef || r.domain.strata.some(s => !this.policy.allowedStrata.includes(s)) || Date.parse(r.proposedAt) > Date.now() || r.runtime.node !== process.version || r.runtime.platform !== process.platform || r.runtime.architecture !== process.arch)
                        fault('S8_REVISION_DOMAIN_RUNTIME_OR_RIGHTS');
                    if (a.principalId !== r.principalId)
                        fault('S8_PROPOSER_PRINCIPAL_MISMATCH', 403);
                    if (this.states.has(r.ref.id))
                        fault('S8_REVISION_ALREADY_PROPOSED');
                    for (const parent of r.parents) {
                        this.current(this.state(parent));
                    }
                    if (digest(r.dependencies) !== digest(this.policy.sourcePins))
                        fault('S8_DEPENDENCY_CLOSURE_UNADMITTED');
                    await this.currentExperience(r);
                    await CapabilityEvolution.sources(r.dependencies);
                    const experience: any[] = [];
                    for (const ref of r.experience.refs) {
                        if (!/^S[1-7]$/.test(ref.owner))
                            fault('S8_EXPERIENCE_OWNER_INVALID');
                        const source = await resolveEconomicOwnerReference({ semanticOwner: 'S8', tenantId: r.tenantId, principalId: r.principalId }, ref, { purpose: 'CONSUMER', rightsRef: r.domain.rightsRef });
                        const value = source.reference.content;
                        const claimedKnowledge = value.knowledgeAt ?? value.payload?.knowledgeAt ?? source.receipt.appendAt;
                        const knowledgeAt = Math.max(Date.parse(claimedKnowledge), Date.parse(source.receipt.appendAt));
                        if (!Number.isFinite(knowledgeAt) || knowledgeAt > Date.parse(r.experience.knowledgeCut))
                            fault('S8_HINDSIGHT_EXPERIENCE');
                        experience.push({ ref, receipt: source.receipt, qualification: source.qualification, causalRewardGranted: false });
                    }
                    result = { ...(await this.commitReference('capability-revision', (({ ref, ...body }) => body)(r))), revision: r, experience, state: 'PROPOSED', executionAuthorityGranted: false };
                    break;
                }
                case 'ATTEMPT': {
                    this.role(a, 'PROPOSER');
                    const s = this.state(RefSchema.parse(b.revisionRef));
                    if (s.state !== 'PROPOSED' || s.protocols.size > 0)
                        fault('S8_SEARCH_AFTER_ADMISSION_REGISTRATION');
                    const attempt = z.object({ revisionRef: RefSchema, kind: z.enum(['SEARCH', 'EVALUATION', 'RETRY', 'DISCARDED', 'FAILURE', 'HUMAN_CORRECTION']), status: z.enum(['PENDING', 'SUCCEEDED', 'FAILED', 'DISCARDED', 'UNKNOWN']), reservedCost: z.number().finite().min(0), actualCost: z.number().finite().min(0).nullable(), allocationRef: RefSchema, modelIdentity: z.string().nullable(), modelComputeRef: RefSchema.nullable(), outputDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(), error: z.string().max(4096).nullable() }).strict().parse(b);
                    const previous = this.attempts.filter(v => v.revisionRef.id === s.revision.ref.id), count = previous.length;
                    if (count >= s.revision.envelope.maxAttempts || previous.reduce((v, a) => v + a.reservedCost, 0) + attempt.reservedCost > s.revision.envelope.maxCost || this.totalCost + attempt.reservedCost > this.policy.maxTotalCost || attempt.actualCost !== null && attempt.actualCost > attempt.reservedCost)
                        fault('S8_SEARCH_RESOURCE_ENVELOPE_EXCEEDED');
                    const allocated = await resolveEconomicOwnerReference({ semanticOwner: 'S8', tenantId: this.policy.tenantId, principalId: this.policy.principalId }, attempt.allocationRef, { purpose: 'CONSUMER', rightsRef: this.policy.rightsRef });
                    if (attempt.allocationRef.owner !== 'S5' || allocated.reference.content.schema !== 'finnor.allocation-certificate.v1' || Date.parse(allocated.reference.content.validUntil) <= Date.now())
                        fault('S8_S5_ALLOCATION_REQUIRED');
                    result = { attempt: { ...attempt, attemptId: makeRef('capability-attempt', { attempt, requestId: input.requestId, episodeId: s.revision.episodeId }).id, episodeId: s.revision.episodeId, allocationQualification: 'S5_ORIGINAL_CERTIFICATE_NO_NEW_EFFECT_AUTHORITY', costQualification: attempt.actualCost === null ? 'UNKNOWN' : 'REPORTED_REQUIRES_INDEPENDENT_COST_SOURCE' }, ...(await this.commitReference('capability-attempt', { attempt, requestId: input.requestId, episodeId: s.revision.episodeId })) };
                    break;
                }
                case 'RUN_SEARCH': {
                    this.role(a, 'PROPOSER');
                    const run = z.object({ revisionRef: RefSchema, allocationRef: RefSchema, problemRef: RefSchema, reservedCost: z.number().finite().min(0) }).strict().parse(b), s = this.state(run.revisionRef), r = s.revision;
                    // Native certificate mathematics and immutable snapshots are usable for a
                    // disposable computation. Current protected search funding/OS quotas are
                    // not supplied by the existing S6 method contract; field runs fail closed.
                    if (this.policy.domain !== 'DISPOSABLE_TEST_AUTHORITY')
                        fault('S8_PROTECTED_SEARCH_ALLOCATION_UNAVAILABLE', 503);
                    if (s.state !== 'PROPOSED' || s.protocols.size)
                        fault('S8_SEARCH_AFTER_ADMISSION_REGISTRATION');
                    const previous = this.attempts.filter(v => v.revisionRef.id === r.ref.id);
                    if (previous.length >= r.envelope.maxAttempts || previous.reduce((v, a) => v + a.reservedCost, 0) + run.reservedCost > r.envelope.maxCost || this.totalCost + run.reservedCost > this.policy.maxTotalCost || this.journal.entries.length + 2 > this.policy.maxEntries)
                        fault('S8_SEARCH_RESOURCE_ENVELOPE_EXCEEDED');
                    const identity = { semanticOwner: 'S8', tenantId: r.tenantId, principalId: r.principalId }, options = { purpose: 'CONSUMER' as const, rightsRef: r.domain.rightsRef };
                    const allocated = await resolveEconomicOwnerReference(identity, run.allocationRef, options), source = await resolveEconomicOwnerReference(identity, run.problemRef, options), problem = { ...source.reference.content, ref: run.problemRef } as CanonicalAllocationProblem, certificate = { ...allocated.reference.content, ref: run.allocationRef };
                    if (run.allocationRef.owner !== 'S5' || run.problemRef.owner !== 'S5' || !sameRef(certificate.problemRef, run.problemRef) || Date.parse(certificate.validUntil) <= Date.now() || !await allocationSourcesCurrent(certificate.compute.backend.sourceDigests))
                        fault('S8_CURRENT_NATIVE_S5_CERTIFICATE_REQUIRED');
                    await verifyAllocationCertificateAsync(problem, certificate);
                    if (problem.tenantId !== r.tenantId || problem.principalId !== r.principalId || problem.mandate.rightsRef !== r.domain.rightsRef || problem.methodVersion !== r.domain.interface || problem.policies.length > r.domain.maxPolicies || problem.mandate.horizon.periods > r.domain.maxPeriods || problem.jointModel.scenarios.length > r.domain.maxScenarios)
                        fault('S8_SEARCH_CASE_OUTSIDE_REVISION_DOMAIN');
                    const attempt = { revisionRef: r.ref, episodeId: r.episodeId, attemptId: makeRef('capability-attempt', { requestId: input.requestId, run }).id, kind: 'SEARCH', status: 'PENDING', reservedCost: run.reservedCost, actualCost: null, allocationRef: run.allocationRef, modelIdentity: 'FINITE_RATIONAL_IR_NO_MODEL_PROVIDER', modelComputeRef: null, outputDigest: null, error: null, allocationQualification: 'NATIVE_CURRENT_S5_CERTIFICATE_IMMUTABLE_SNAPSHOT_NOT_PROTECTED_SEARCH_FUNDING', costQualification: 'UNKNOWN_REQUIRES_INDEPENDENT_COST_SOURCE' };
                    await this.persist({ requestId: 'search-start:' + digest(input.requestId), requestDigest: digest({ requestDigest, phase: 'START' }), actorId: a.id, operation: 'ATTEMPT', body: run, result: { attempt, managedRun: { requestId: input.requestId, requestDigest, body: b } } });
                    let output: any = null, error: string | null = null;
                    const startedAt = new Date().toISOString();
                    try {
                        output = await runAllocationMethodProcess(problem, r.payload, { deadlineAt: performance.now() + Math.min(r.envelope.maxWallMs, problem.mandate.search.deadlineMs), maxExpansions: Math.min(r.envelope.maxNodes, problem.mandate.search.maxExpansions) });
                    }
                    catch (failure) {
                        error = failure instanceof Error ? failure.message : 'S8_SEARCH_RUNTIME_FAILURE';
                    }
                    const computeBody = { schema: 'finnor.model-compute-invocation.v1', semanticOwner: 'S8', tenantId: r.tenantId, principalId: r.principalId, rightsRef: r.domain.rightsRef, revisionRef: r.ref, inputRef: run.problemRef, allocationRef: run.allocationRef, outputRefs: output ? [`capability-output:${digest(output)}`] : [], requestedRoute: 'FINITE_RATIONAL_IR', actualRoute: 'SCRUBBED_NODE_CHILD', fallbacks: [], model: null, backend: { name: 'finnor-finite-rational-ir', version: S8_VERSION, sourceDigests: r.dependencies, identityBasis: 'LOADED_SOURCE_SNAPSHOT' }, harness: { nodeVersion: r.runtime.node, platform: r.runtime.platform, architecture: r.runtime.architecture, configuration: { revisionEnvelope: r.envelope, mandateSearch: problem.mandate.search, payloadDigest: digest(r.payload), memoryEnforcement: 'STRUCTURAL_AND_MEASURED_CHILD_USAGE_NO_HARD_OS_QUOTA' }, deterministicReplayClaimed: false }, attempts: [{ startedAt, finishedAt: new Date().toISOString(), status: error || !output?.complete ? 'FAILED' : 'COMPLETED', reason: error ?? (!output?.complete ? 'REGISTERED_SEARCH_EXHAUSTED' : null) }], randomness: { used: false, seed: null }, usage: output ? { ...output.usage, accountingScope: 'CHILD_PROCESS_INTERVAL_NOT_AGGREGATE_OS_PEAK' } : null, cost: { money: null, pricebookRef: null, status: 'LOCAL_COST_UNMETERED', externalCalls: 0 }, admission: { status: 'BLOCKED_EXTERNAL', receipt: null }, protectedExecution: false, executionAuthorityGranted: false };
                    const compute = { ...computeBody, id: `model-compute:${digest(computeBody)}` };
                    const computeRef = (await this.commitReference('capability-compute', compute)).ref;
                    result = { attemptId: attempt.attemptId, completion: { status: error || !output?.complete ? 'FAILED' : 'SUCCEEDED', actualCost: null, error: error ?? (!output?.complete ? 'REGISTERED_SEARCH_EXHAUSTED' : null), outputDigest: output ? digest(output) : null, modelComputeRef: computeRef, finishedAt: compute.attempts[0]!.finishedAt }, result: output, computeRef, reservationRetained: true, automaticRetry: false, qualification: 'ACTUAL_NATIVE_CERTIFICATE_AND_BOUNDED_DISPOSABLE_COMPUTATION_NO_PROTECTED_LIVE_SEARCH_AUTHORITY' };
                    break;
                }
                case 'REGISTER': {
                    this.role(a, 'EVALUATOR');
                    const p = ProtocolSchema.parse(b.body);
                    assertSignature(b, this.policy.evaluatorKeys, a.principalId);
                    this.scope(p);
                    const s = this.state(p.revisionRef);
                    const priorCampaign = [...this.states.values()].filter(v => v.revision.episodeId === s.revision.episodeId).flatMap(v => [...v.protocols.values()]);
                    if (priorCampaign.length >= p.maxSubmissions * p.maxWaves || priorCampaign.some(v => this.campaignDefinition(v) !== this.campaignDefinition(p)))
                        fault('S8_CAMPAIGN_MULTIPLICITY_OR_DEFINITION_CHANGED');
                    if (digest([...p.strata].sort()) !== digest([...s.revision.domain.strata].sort()))
                        fault('S8_ADMISSION_DOMAIN_HAS_UNTESTED_STRATA');
                    if (new Set(p.baselines.map(v => v.id)).size !== p.baselines.length || new Set(p.strata).size !== p.strata.length || new Set(p.priorDomains).size !== p.priorDomains.length)
                        fault('S8_DUPLICATE_ADMISSION_ENDPOINT');
                    if (s.state !== 'PROPOSED' || s.protocols.size >= p.maxSubmissions || p.evaluatorId !== a.principalId || Date.parse(p.registeredAt) > Date.now() || Date.parse(p.trainingCutoff) < Date.parse(s.revision.experience.knowledgeCut) || Date.parse(p.chronologicalStart) <= Date.parse(p.trainingCutoff) || Date.parse(p.chronologicalEnd) < Date.parse(p.chronologicalStart) || !sameRef(p.domain, s.revision.domain) || p.companies.some(c => s.revision.experience.trainingCompanies.includes(c)) || p.dependenceGroups.some(g => s.revision.experience.dependenceGroups.includes(g) || this.consumedGroups.has(g)) || p.caseCommitments.some(c => this.consumedCases.has(c)) || new Set(p.dependenceGroups).size !== p.dependenceGroups.length || new Set(p.caseCommitments).size !== p.caseCommitments.length || p.dependenceGroups.length < p.minIndependentGroups || p.strata.some(st => !p.domain.strata.includes(st)) || !['INCUMBENT', 'STRONG_FIXED', 'INDEPENDENT_EVOLUTION'].every(k => p.baselines.some(v => v.kind === k)))
                        fault('S8_PREREGISTRATION_SPLIT_OR_BASELINE_INVALID');
                    const allAttempts = this.attempts.filter(v => v.episodeId === s.revision.episodeId);
                    if (allAttempts.length === 0 || allAttempts.some(v => v.status === 'PENDING'))
                        fault('S8_UNACCOUNTED_SEARCH_BEFORE_REGISTRATION');
                    result = { ...(await this.commitReference('evaluation-protocol', p)), state: 'REGISTERED_TARGETS_CONSUMED_NO_REUSE', feedback: p.feedback };
                    break;
                }
                case 'EVALUATE': {
                    this.role(a, 'EVALUATOR');
                    const report = EvaluationSummarySchema.parse(b.body);
                    assertSignature(b, this.policy.evaluatorKeys, a.principalId);
                    const s = this.state(report.revisionRef), p = s.protocols.get(report.protocolRef.id);
                    if (!p || !sameRef(makeRef('evaluation-protocol', p), report.protocolRef) || s.state !== 'PROPOSED' || report.evaluatorId !== a.principalId || Date.parse(report.completedAt) < Date.parse(p.registeredAt) || Date.parse(report.completedAt) > Date.now())
                        fault('S8_EVALUATION_REGISTRATION_BINDING');
                    const attempts = this.attempts.filter(v => v.episodeId === s.revision.episodeId);
                    if (report.attemptsDigest !== digest(attempts) || report.failedCandidates < attempts.filter(v => ['FAILED', 'DISCARDED', 'UNKNOWN'].includes(v.status)).length)
                        fault('S8_SUPPRESSED_FAILED_SEARCH');
                    if (report.disposition === 'BENEFICIAL') {
                        const resolved = new Map<string, [
                            number,
                            number
                        ]>(), phases = new Map<string, [
                            number,
                            number
                        ]>();
                        const phaseNames = ['search', 'training', 'evaluation', 'human', 'computeData', 'integration', 'maintenance', 'recovery', 'deployment'] as const;
                        for (const ref of report.costs.costRefs) {
                            if (!['FINANCIAL_SOURCE', 'S7'].includes(ref.owner) || !this.policy.costAuthorityPrincipalIds.length)
                                fault('S8_INDEPENDENT_COST_SOURCE_REQUIRED');
                            const source = await resolveEconomicOwnerReference({ semanticOwner: 'S8', tenantId: this.policy.tenantId, principalId: this.policy.principalId }, ref, { purpose: 'CONSUMER', rightsRef: this.policy.rightsRef, allowedPrincipalIds: this.policy.costAuthorityPrincipalIds });
                            if (source.reference.content.schema === 'finnor.s8.independent-lifecycle-cost.v1') {
                                const cost = z.object({ schema: z.literal('finnor.s8.independent-lifecycle-cost.v1'), tenantId: Text, episodeId: Text, currency: z.literal('USD'), category: z.enum(phaseNames), amount: z.tuple([z.number().finite().min(0), z.number().finite().min(0)]), basis: z.enum(['OBSERVED_COMPLETE', 'REGISTERED_GENERATIVE_MODEL']), knowledgeAt: Instant }).strict().parse(source.reference.content);
                                if (cost.tenantId !== this.policy.tenantId || cost.episodeId !== s.revision.episodeId || cost.amount[0] > cost.amount[1] || cost.basis !== report.costs.basis || Date.parse(cost.knowledgeAt) > Date.parse(report.completedAt) || phases.has(cost.category))
                                    fault('S8_INDEPENDENT_COST_SOURCE_BINDING');
                                phases.set(cost.category, cost.amount);
                                continue;
                            }
                            const cost = z.object({ schema: z.literal('finnor.s8.independent-attempt-cost.v1'), tenantId: Text, episodeId: Text, currency: z.literal('USD'), attemptId: Text, amount: z.tuple([z.number().finite().min(0), z.number().finite().min(0)]), basis: z.enum(['OBSERVED_COMPLETE', 'REGISTERED_GENERATIVE_MODEL']), knowledgeAt: Instant }).strict().parse(source.reference.content);
                            if (cost.tenantId !== this.policy.tenantId || cost.episodeId !== s.revision.episodeId || cost.amount[0] > cost.amount[1] || cost.basis !== report.costs.basis || Date.parse(cost.knowledgeAt) > Date.parse(report.completedAt) || !attempts.some(a => a.attemptId === cost.attemptId) || resolved.has(cost.attemptId))
                                fault('S8_INDEPENDENT_COST_SOURCE_BINDING');
                            resolved.set(cost.attemptId, cost.amount);
                        }
                        if (phaseNames.some(name => !phases.has(name) || !report.costs[name] || report.costs[name]![0] < phases.get(name)![0] || report.costs[name]![1] < phases.get(name)![1]))
                            fault('S8_UNSOURCED_LIFECYCLE_COST_CATEGORY');
                        if (attempts.some(a => !resolved.has(a.attemptId)) || !report.costs.search || report.costs.search[0] < [...resolved.values()].reduce((v, a) => v + a[0], 0) || report.costs.search[1] < [...resolved.values()].reduce((v, a) => v + a[1], 0))
                            fault('S8_OMITTED_FAILED_OR_UNKNOWN_SEARCH_COST');
                    }
                    if (report.disposition === 'BENEFICIAL' && (!report.allFloorsPassed || !report.priorDomainsPassed || !report.gain || report.gain[0] < p.materialGain || Object.entries(report.costs).some(([k, v]) => !['costRefs', 'currency', 'basis'].includes(k) && v === null) || report.costs.basis === 'UNKNOWN' || report.qualification === 'PROSPECTIVE_H1' && report.costs.basis !== 'OBSERVED_COMPLETE'))
                        fault('S8_FALSE_FUTURE_GAIN');
                    result = { ...(await this.commitReference('capability-evaluation', report)), state: 'EVALUATED', disposition: report.disposition };
                    break;
                }
                case 'ADMIT': {
                    this.role(a, 'EVALUATOR');
                    assertSignature(b, this.policy.evaluatorKeys, a.principalId);
                    const s = this.state(RefSchema.parse(b.body.revisionRef));
                    if (s.state !== 'EVALUATED' || !s.evaluation || s.evaluation.disposition !== 'BENEFICIAL' || !sameRef(b.body.evaluationRef, makeRef('capability-evaluation', s.evaluation)) || b.body.payloadDigest !== digest(s.revision.payload) || b.body.dependencyDigest !== digest(s.revision.dependencies) || !sameRef(b.body.domain, s.revision.domain) || b.body.executionAuthorityGranted !== false || b.body.horizon !== 'H1' || b.body.evaluatorId !== a.principalId)
                        fault('S8_ADMISSION_BINDING_OR_GAIN_INVALID');
                    await this.currentExperience(s.revision);
                    await this.protectedCurrent(b.body.evaluationRef);
                    result = { ...(await this.commitReference('capability-admission', b)), state: 'ADMITTED', horizon: 'H1', qualification: s.evaluation.qualification };
                    break;
                }
                case 'ACTIVATE': {
                    this.role(a, 'PROMOTER');
                    assertSignature(b, this.policy.promotionKeys, a.principalId);
                    const s = this.state(RefSchema.parse(b.body.revisionRef));
                    this.current(s);
                    await this.currentExperience(s.revision);
                    const activation = z.object({ revisionRef: RefSchema, expectedGeneration: z.number().int().min(0), predecessorRef: RefSchema.nullable(), mode: z.enum(['SHADOW', 'CANARY', 'FULL']), maxDecisionLoss: z.number().finite().min(0), maxCost: z.number().finite().min(0), maxUses: z.number().int().min(1), validUntil: Instant, evidenceRefs: z.array(RefSchema).max(256), methodAdmission: AllocationMethodAdmissionSchema.optional(), canaryPlan: CanaryPlanSchema.optional() }).strict().parse(b.body);
                    if (activation.expectedGeneration !== this.generation || !sameRef(activation.predecessorRef, this.active ? this.states.get(this.active)!.revision.ref : null) || activation.maxDecisionLoss > s.revision.envelope.maxDecisionLoss || activation.maxCost > s.revision.envelope.maxCost || activation.maxUses > s.revision.envelope.maxUses || Date.parse(activation.validUntil) > Date.parse(s.revision.domain.validUntil) || Date.parse(activation.validUntil) <= Date.now() || activation.mode === 'FULL' && (s.evaluation?.qualification !== 'PROSPECTIVE_H1' || activation.evidenceRefs.length === 0) || s.evaluation?.qualification === 'GENERATIVE_H1' && activation.mode !== 'SHADOW' || this.policy.domain === 'DISPOSABLE_TEST_AUTHORITY' && activation.mode !== 'SHADOW')
                        fault('S8_ACTIVATION_ENVELOPE_OR_EVIDENCE_INVALID');
                    await this.currentMethod(s, activation);
                    await this.currentCanary(s, undefined, activation);
                    // Mechanical method binding does not supply a native canary assignment,
                    // allocation, effect lineage or independently qualified owner outcome.
                    if (activation.mode !== 'SHADOW')
                        fault('S8_NATIVE_CANARY_AUTHORITY_UNAVAILABLE', 503);
                    if (this.active && (this.active === s.revision.ref.id || !s.revision.parents.some(parent => sameRef(parent, this.states.get(this.active!)!.revision.ref))))
                        fault('S8_ACTIVATION_PREDECESSOR_LINEAGE_INVALID');
                    await CapabilityEvolution.sources(s.revision.dependencies);
                    await this.protectedCurrent(makeRef('capability-admission', s.admission));
                    result = { ...(await this.commitReference('capability-activation', b)), state: 'ACTIVATED', generation: this.generation + 1 };
                    break;
                }
                case 'REVOKE': {
                    this.role(a, 'PROMOTER');
                    assertSignature(b, this.policy.promotionKeys, a.principalId);
                    const body = z.object({ revisionRef: RefSchema, expectedGeneration: z.number().int().min(0), predecessorRef: RefSchema.nullable(), reason: Text }).strict().parse(b.body), s = this.state(body.revisionRef);
                    if (body.predecessorRef && (sameRef(body.predecessorRef, body.revisionRef) || this.active !== body.revisionRef.id || !s.revision.parents.some(parent => sameRef(parent, body.predecessorRef))))
                        fault('S8_ROLLBACK_PREDECESSOR_LINEAGE_INVALID');
                    if (body.expectedGeneration !== this.generation || s.state === 'REVOKED')
                        fault('S8_REVOKE_GENERATION_CONFLICT');
                    if (body.predecessorRef) {
                        const previous = this.state(body.predecessorRef);
                        this.current(previous);
                        if (!previous.activation || Date.parse(previous.activation.validUntil) <= Date.now() || previous.revision.domain.rightsRef !== s.revision.domain.rightsRef)
                            fault('S8_UNQUALIFIED_ROLLBACK_PREDECESSOR');
                        await CapabilityEvolution.sources(previous.revision.dependencies);
                        await this.protectedCurrent(makeRef('capability-admission', previous.admission));
                        await this.currentExperience(previous.revision);
                        await this.currentMethod(previous);
                        await this.currentCanary(previous);
                    }
                    result = { ...(await this.commitReference('capability-revocation', b)), state: 'REVOKED', generation: this.generation + 1, restored: body.predecessorRef, unresolvedUsesPreserved: [...this.uses.values()].filter(u => u.status !== 'RECONCILED').length };
                    break;
                }
                case 'USE': {
                    this.role(a, 'CONSUMER');
                    this.scope(b);
                    const s = this.active ? this.states.get(this.active)! : fault('S8_NO_ACTIVE_CAPABILITY', 403);
                    this.current(s);
                    await this.currentExperience(s.revision);
                    const act = s.activation, r = s.revision;
                    if (!act || Date.parse(act.validUntil) <= Date.now() || b.owner !== 'S5' || b.interface !== r.owningInterface || b.rightsRef !== r.domain.rightsRef || !r.domain.strata.includes(b.stratum) || b.policyCount > r.domain.maxPolicies || b.periods > r.domain.maxPeriods || b.scenarios > r.domain.maxScenarios || !Number.isSafeInteger(b.policyCount) || b.policyCount < 1 || !Number.isSafeInteger(b.periods) || b.periods < 1 || !Number.isSafeInteger(b.scenarios) || b.scenarios < 1 || typeof b.maxDecisionLoss !== 'number' || !Number.isFinite(b.maxDecisionLoss) || b.maxDecisionLoss < 0 || typeof b.reservedCost !== 'number' || !Number.isFinite(b.reservedCost) || b.reservedCost < 0)
                        fault('S8_USE_DOMAIN_OR_RIGHTS_INVALID');
                    const revisionUses = [...this.uses.values()].filter(u => u.revisionRef.id === r.ref.id);
                    if (this.useCount >= this.policy.maxTotalUses || revisionUses.length >= act.maxUses || this.totalCost + b.reservedCost > this.policy.maxTotalCost || this.totalLoss + b.maxDecisionLoss > this.policy.maxTotalLoss || revisionUses.reduce((v, u) => v + u.maxDecisionLoss, 0) + b.maxDecisionLoss > act.maxDecisionLoss || revisionUses.reduce((v, u) => v + u.reservedCost, 0) + b.reservedCost > act.maxCost || act.mode === 'SHADOW' && b.maxDecisionLoss !== 0)
                        fault('S8_CUMULATIVE_CANARY_LOSS_OR_RESOURCE_BOUND');
                    await CapabilityEvolution.sources(r.dependencies);
                    await this.protectedCurrent(makeRef('capability-admission', s.admission));
                    await this.currentMethod(s);
                    let canary: CapabilityUseLease['canary'];
                    if (act.canaryPlan) {
                        const plan = CanaryPlanSchema.parse(act.canaryPlan);
                        if (b.reservedCost !== plan.reservedCostPerUse) fault('S8_CANARY_USE_COST_SUBSTITUTION');
                        const checked = await verifyNativeCanaryUse(this.canaryScope(), r, plan, b.canaryBinding);
                        assertNativeCanaryCapacity(plan, [...this.uses.values()], checked.binding);
                        canary = { plan, binding: checked.binding };
                    } else if (b.canaryBinding !== undefined || act.mode === 'CANARY') fault('S8_NATIVE_CANARY_PLAN_REQUIRED', 503);
                    const lease: CapabilityUseLease = { schema: 'finnor.s8.capability-use.v1', useId: 'capability-use:' + digest({ requestId: input.requestId, revisionRef: r.ref, inputDigest: b.inputDigest }), revisionRef: r.ref, payload: r.payload, domain: r.domain, activationRef: act.ref, inputDigest: z.string().regex(/^[a-f0-9]{64}$/).parse(b.inputDigest), generation: this.generation, mode: act.mode, maxDecisionLoss: b.maxDecisionLoss, reservedCost: b.reservedCost, expiresAt: act.validUntil, status: 'PINNED_PENDING', executionAuthorityGranted: false, ...(act.methodAdmission ? { methodAdmission: act.methodAdmission } : {}), ...(canary ? { canary } : {}) };
                    result = { lease, ...(await this.commitReference('capability-use', lease)) };
                    break;
                }
                case 'RECHECK': {
                    this.role(a, 'CONSUMER');
                    const use = this.uses.get(b.useId);
                    if (!use || use.inputDigest !== b.inputDigest || !sameRef(use.revisionRef, b.revisionRef))
                        fault('S8_USE_IDENTITY_SUBSTITUTION');
                    await this.currentUse(use);
                    return { lease: use, current: true, executionAuthorityGranted: false };
                }
                case 'HANDOFF': {
                    this.role(a, 'PROMOTER'); assertSignature(b, this.policy.promotionKeys, a.principalId);
                    const request = z.object({ runtimeHandoff: z.literal(true), expectedGeneration: z.number().int().min(0), successorPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/), successorPolicy: z.unknown(), reason: Text }).strict().parse(b.body);
                    if (request.expectedGeneration !== this.generation || request.successorPolicyDigest === CapabilityEvolution.handoffTargetDigest(this.policy) || request.successorPolicyDigest !== CapabilityEvolution.handoffTargetDigest(request.successorPolicy)) fault('S8_HANDOFF_GENERATION_OR_TARGET_INVALID');
                    const successor = PolicySchema.parse(request.successorPolicy);
                    if (successor.responsibilityHandoff || successor.tenantId !== this.policy.tenantId || successor.principalId !== this.policy.principalId || successor.rightsRef !== this.policy.rightsRef || successor.domain !== this.policy.domain
                        || successor.maxTotalCost < this.totalCost || successor.maxTotalLoss < this.totalLoss || successor.maxTotalUses < this.useCount || Date.parse(successor.validUntil) <= Date.now()) fault('S8_HANDOFF_SUCCESSOR_DOMAIN_OR_ENVELOPE');
                    const originalLeases = [...this.uses.keys()].map(id => this.importedLeases.get(id) ?? this.journal.entries.find(e => e.operation === 'USE' && e.result.lease.useId === id)?.result.lease);
                    if (originalLeases.some(l => !l) || this.uses.size > 4096 || this.attempts.length > 4096) fault('S8_HANDOFF_RETENTION_BOUND');
                    const predecessors = this.policy.responsibilityHandoff ? [...(this.journal.entries.find(e => e.result.responsibilityImport === true)?.result.capsule.predecessorHandoffs ?? []), this.policy.responsibilityHandoff.reference] : [];
                    if (predecessors.length > 8) fault('S8_HANDOFF_RETENTION_BOUND');
                    const capsule = { schema: 'finnor.s8.responsibility-handoff.v1', tenantId: this.policy.tenantId, principalId: this.policy.principalId, rightsRef: this.policy.rightsRef,
                        previousPolicyDigest: digest(this.policy), successorPolicyDigest: request.successorPolicyDigest, sequence: this.journal.entries.length + 1, generation: this.generation + 1,
                        uses: [...this.uses.values()], originalLeases, attempts: this.attempts, consumedGroups: [...this.consumedGroups], consumedCases: [...this.consumedCases], predecessorHandoffs: predecessors,
                        accounting: { totalCost: this.totalCost, totalLoss: this.totalLoss, useCount: this.useCount }, actionableActivationTransferred: false, liabilityBudgetReleased: false, economicCreditGranted: false };
                    result = { ...(await this.commitReference('capability-responsibility-handoff', capsule)), runtimeHandoff: true, generation: capsule.generation, actionableActivationTransferred: false, liabilityBudgetReleased: false };
                    journalOperation = 'REVOKE'; break;
                }
                case 'RECONCILE': {
                    this.role(a, 'CONSUMER');
                    const report = z.object({ useId: Text, outcome: z.enum(['VERIFIED', 'UNKNOWN', 'FAILED', 'DECLINED', 'CENSORED']), evidenceRef: RefSchema, priorEvidenceRef: RefSchema.optional(), executionLineage: ExecutionLineageSchema.optional() }).strict().parse(b);
                    const use = this.uses.get(report.useId);
                    if (!use || (use.reconciliations?.length ?? 0) >= 64)
                        fault('S8_USE_RECONCILIATION_INVALID');
                    if (use.evidenceRef ? !report.priorEvidenceRef || !sameRef(use.evidenceRef, report.priorEvidenceRef) || sameRef(use.evidenceRef, report.evidenceRef) : report.priorEvidenceRef !== undefined)
                        fault('S8_RECONCILIATION_PRIOR_EVIDENCE_BINDING');
                    if (report.outcome === 'VERIFIED' && !report.executionLineage)
                        fault('S8_NATIVE_S7_USE_LINEAGE_UNAVAILABLE', 503);
                    const evidence = report.evidenceRef;
                    if (evidence.owner !== 'S7')
                        fault('S8_RECONCILIATION_OWNER_REQUIRED');
                    const original = (this.importedLeases.get(use.useId) ?? this.journal.entries.find(entry => entry.operation === 'USE' && entry.result.lease.useId === use.useId)?.result.lease) as CapabilityUseLease | undefined;
                    if (!original) fault('S8_USE_IDENTITY_SUBSTITUTION');
                    let effectLineage: any = null;
                    if (report.outcome === 'VERIFIED') effectLineage = await verifyCapabilityEffectReconciliation({ ...this.canaryScope(), lease: original, evidenceRef: evidence, executionLineage: report.executionLineage });
                    else if (use.effectLineage) await verifyCapabilityAdverseOutcome({ ...this.canaryScope(), lease: original, evidenceRef: evidence, outcome: report.outcome, priorLineage: use.effectLineage });
                    else if (use.canary) await verifyNativeCanaryUncertainOutcome(this.canaryScope(), original, evidence, report.outcome);
                    await resolveEconomicOwnerReference({ semanticOwner: 'S8', tenantId: this.policy.tenantId, principalId: this.policy.principalId }, evidence, { purpose: 'CONSUMER', rightsRef: this.policy.rightsRef });
                    result = { ...(await this.commitReference('capability-reconciliation', { ...report, revisionRef: use.revisionRef })), ...(effectLineage ? { effectLineage } : {}), liabilityBudgetReleased: false, outcomeQualification: effectLineage ? 'QUALIFIED_NATIVE_PHYSICAL_H0_ONLY_NO_CAUSAL_VALUE_OR_PROMOTION' : 'REPORTED_UNCERTAIN_OUTCOME_AUTHENTICATED_REFERENCE_NO_CAUSAL_CREDIT', executionAuthorityGranted: false, causalCreditGranted: false, economicCreditGranted: false };
                    break;
                }
                default: fault('S8_OPERATION_UNSUPPORTED', 404);
            }
            await this.persist({ requestId: input.requestId, requestDigest, actorId: a.id, operation: journalOperation, body: b, result });
            return result;
        });
        this.queue = run.catch(() => undefined);
        try {
            return await run;
        }
        finally {
            this.queued--;
        }
    }
    async close() { await this.queue; await this.journal.close(); }
}

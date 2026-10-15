/** FRONTIER5.X2 knowledge admission in the existing S8 journal. No executable
 * payload, protected qualification, external-state oracle or execution right. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { ApplicationActionModel, ApplicationModelCheck, ApplicationTransitionEvidence } from '@finnor/shared-types';
import type { AuthorizedApplicationProfile, OriginalApplicationParent } from '../../private-equity/src/application-semantics/ports';
import {
    ApplicationScopeSchema, ApplicationSnapshotSchema, ApplicationStateSchema, LearnedApplicationOperationSchema,
    ScopedApplicationIdentitySchema, SupportedApplicationDomainSchema,
    X2RefSchema, applicationRuntimeIdentity, boundedX2, parseApplicationCheck, parseApplicationComposition, parseApplicationModel, parseTransitionEvidence, x2Ref,
} from '../../private-equity/src/application-semantics/contracts';
import { ApplicationFreshAuthorityBodySchema, type ApplicationFreshAuthority } from '../../private-equity/src/application-semantics/native-contracts';
import { assertApplicationModelUse } from '../../private-equity/src/application-semantics/checker';
import { resolveEconomicOwnerReference } from '../../governed-execution/src/owner-transport';
import {
    assertSignature, byteDigest, digest, fault, LifecycleCostSchema, SourcePinSchema,
    type AuthorityKey, type CapabilityRef, type Signed,
} from './contracts';
import type { JournalEntry } from './journal';

/** Fresh original-source checks shared by the X2 owner and its consumer.
 * All paths are admitted before bounded read-only I/O; no validity is cached. */
export async function assertNativeApplicationSources(parent: OriginalApplicationParent, sourceRoot: string,
    sourcePins: readonly { path: string; sha256: string }[]) {
    const files = parent.dependencyPins.map(pin => {
        if (isAbsolute(pin.path) || pin.path !== relative(sourceRoot, resolve(sourceRoot, pin.path))
            || pin.path.startsWith('../')) fault('S8_APPLICATION_DEPENDENCY_PATH_ESCAPE', 403);
        const path = resolve(sourceRoot, pin.path);
        if (!sourcePins.some(source => source.path === path && source.sha256 === pin.sha256))
            fault('S8_APPLICATION_NATIVE_SOURCE_PIN_UNADMITTED');
        return { path, sha256: pin.sha256 };
    });
    for (let offset = 0; offset < files.length; offset += 8) {
        await Promise.all(files.slice(offset, offset + 8).map(async pin => {
            const fd = await open(pin.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const st = await fd.stat();
                if (!st.isFile() || st.size > 16 * 1024 * 1024 || byteDigest(await fd.readFile()) !== pin.sha256)
                    fault('S8_APPLICATION_SOURCE_CHANGED');
            } finally { await fd.close(); }
        }));
    }
    if (parent.runtimeDigest !== digest(applicationRuntimeIdentity())) fault('S8_APPLICATION_RUNTIME_CHANGED');
}

export const APPLICATION_S8_VERSION = 's8-application-capability-v1';
export const APPLICATION_S8_QUALIFICATION = 'PUBLIC_DEVELOPMENT_NOT_PROTECTED_X2' as const;
const text = z.string().min(1).max(256), hex = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const refs = (max = 256) => z.array(X2RefSchema).max(max);
const requestId = z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/);
export const ApplicationPortRefSchema = X2RefSchema.extend({
    owner: z.literal('S8'), version: z.literal(APPLICATION_S8_VERSION),
}).strict();
export type ApplicationPortRef = z.infer<typeof ApplicationPortRefSchema>;
export const applicationRef = (kind: string, body: unknown): ApplicationPortRef => ({
    owner: 'S8', id: `application-${kind}:${digest(body)}`, version: APPLICATION_S8_VERSION, contentDigest: digest(body),
});
const flags = {
    protectionDomain: z.literal('DISPOSABLE_TEST_AUTHORITY'),
    qualification: z.literal(APPLICATION_S8_QUALIFICATION),
    protectedAdmission: z.literal(false), executionAuthorityGranted: z.literal(false),
};
export const ApplicationPortConfigurationSchema = z.object({
    schema: z.literal('finnor.s8.application-port-policy.v1'),
    frontier: z.literal('FRONTIER5.X2'),
    sourceRoot: z.string().min(1).max(4096).refine(isAbsolute),
    transportContract: z.literal('BOUNDED_CONDITIONAL_APPLICATION_V1'),
    maxCurrentnessMs: z.number().int().min(100).max(30000),
    ...flags,
}).strict();
export type ApplicationPortConfiguration = z.infer<typeof ApplicationPortConfigurationSchema>;
export const OriginalApplicationParentSchema = z.object({
    originalParentRef: X2RefSchema, tenantRef: X2RefSchema, workRef: X2RefSchema,
    institutionalProgramRef: X2RefSchema.nullable(), authorityGrantRef: X2RefSchema,
    resourceGrantRef: X2RefSchema, baselineManifestRef: X2RefSchema, rightsRevision: text,
    deadlineAt: instant, validAfter: instant, dependencyLockDigest: hex, runtimeDigest: hex,
    schemaDigest: hex, dependencyPins: z.array(SourcePinSchema).min(1).max(128),
    producerRef: X2RefSchema, grammarRef: X2RefSchema, checkerRef: X2RefSchema,
    runtimeRef: X2RefSchema, costRefs: refs(), humanWorkRefs: refs(),
}).strict() satisfies z.ZodType<OriginalApplicationParent>;
/** Only this projection leaves the process. Never spread the private profile. */
export const ApplicationProfileBindingSchema = z.object({
    id: text, tenantId: text, principalId: text, application: text, account: text,
    actingPrincipal: text, role: text, grantRef: X2RefSchema, origin: text,
    allowedTargetsDigest: hex, validUntil: instant,
    sourceContract: z.literal('BOUNDED_CONDITIONAL_APPLICATION_V1'),
    protectionDomain: z.literal('DISPOSABLE_TEST_AUTHORITY'),
}).strict();
export type ApplicationProfileBinding = z.infer<typeof ApplicationProfileBindingSchema>;
function profileOrigin(binding: ApplicationProfileBinding) {
    const url = new URL(binding.origin);
    if (url.origin !== binding.origin || url.username || url.password || url.protocol !== 'http:'
        || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) fault('S8_APPLICATION_PROFILE_DOMAIN', 403);
}
export function applicationProfileBinding(profile: AuthorizedApplicationProfile): ApplicationProfileBinding {
    const binding = ApplicationProfileBindingSchema.parse({
        id: profile.id, tenantId: profile.tenantId, principalId: profile.principalId,
        application: profile.application, account: profile.account, actingPrincipal: profile.actingPrincipal,
        role: profile.role, grantRef: profile.grantRef, origin: profile.origin,
        allowedTargetsDigest: digest(profile.allowedTargets), validUntil: profile.validUntil,
        sourceContract: profile.sourceContract, protectionDomain: profile.protectionDomain,
    });
    profileOrigin(binding);
    if (!Array.isArray(profile.allowedTargets) || !profile.allowedTargets.length || profile.allowedTargets.length > 16
        || profile.allowedTargets.some(target => typeof target !== 'string' || !target.length || target.length > 1024)
        || new Set(profile.allowedTargets).size !== profile.allowedTargets.length) fault('S8_APPLICATION_PROFILE_DOMAIN', 403);
    return binding;
}
const OperationBindingSchema = z.object({
    operationId: text, role: text, grantRef: X2RefSchema, semanticRevision: text, renderingDigest: hex,
    observerContractRef: X2RefSchema, privateBindingRef: X2RefSchema, dependencyRefs: refs(128).min(1),
    effectClass: z.enum(['OBSERVATION', 'STATE_MUTATION', 'POSSIBLY_CONSEQUENTIAL']),
    replay: z.literal('NEVER_AFTER_POSSIBLE_EGRESS'), observationFields: z.array(text).min(1).max(16),
}).strict();
export const ApplicationDependenciesSchema = z.object({
    modelRef: X2RefSchema, checkRef: X2RefSchema, semanticRevisionRef: X2RefSchema,
    producerRef: X2RefSchema, checkerRef: X2RefSchema, grammarRef: X2RefSchema,
    observerRuntimeRef: X2RefSchema, transportRef: X2RefSchema, runtimeRef: X2RefSchema,
    validityContractRef: X2RefSchema, runtimeDigest: hex, dependencyLockDigest: hex, schemaDigest: hex,
    originalParentRef: X2RefSchema, authorityGrantRef: X2RefSchema, resourceGrantRef: X2RefSchema,
    rightsRevision: text, sourceRevisionVector: z.record(text, text),
    applicationFingerprints: z.record(text, hex), modelDependencyRefs: refs(),
    applicationIdentityAndVersionEvidence: refs().min(1), originalEvidenceRefs: refs().min(1),
    operationBindings: z.array(OperationBindingSchema).min(1).max(16),
    supportedDomain: SupportedApplicationDomainSchema, validAfter: instant, validUntil: instant,
}).strict();
export type ApplicationDependencies = z.infer<typeof ApplicationDependenciesSchema>;
const code = (parent: OriginalApplicationParent, kind: string, paths: string[], owner: string) => {
    const pins = paths.map(path => {
        const pin = parent.dependencyPins.find(p => p.path === path);
        if (!pin) fault('S8_APPLICATION_CODE_CONTRACT_PIN_MISSING', 503);
        return pin;
    });
    return x2Ref(owner, kind, { schema: 'finnor.s8.application-code-contract.v1', pins, runtimeDigest: parent.runtimeDigest });
};
export function applicationDependencies(model: ApplicationActionModel, check: ApplicationModelCheck,
    parent: OriginalApplicationParent): ApplicationDependencies {
    parseApplicationModel(model); parseApplicationCheck(check); OriginalApplicationParentSchema.parse(parent);
    const envelope = model.envelope;
    const parentBindings = {
        originalParentRef: parent.originalParentRef, tenant_ref: parent.tenantRef, work_ref: parent.workRef,
        institutional_program_ref: parent.institutionalProgramRef, authority_grant_ref: parent.authorityGrantRef,
        resource_grant_ref: parent.resourceGrantRef, baseline_manifest_ref: parent.baselineManifestRef,
        producer_revision: parent.producerRef, checkerRef: parent.checkerRef, grammarRef: parent.grammarRef,
        runtimeRef: parent.runtimeRef, rights_revision: parent.rightsRevision,
        dependency_lock_digest: parent.dependencyLockDigest, runtime_digest: parent.runtimeDigest,
        dependencyPins: parent.dependencyPins, validAfter: parent.validAfter, validUntil: parent.deadlineAt,
    };
    if (Object.entries(parentBindings).some(([key, value]) => digest(envelope[key as keyof typeof envelope]) !== digest(value))
        || digest(check.modelRef) !== digest(model.ref) || digest(check.checkerRef) !== digest(parent.checkerRef)
        || digest(check.originalEvidenceRefs) !== digest(model.source_observations)
        || Date.parse(check.checkedAt) < Date.parse(envelope.knowledge_cut) || Date.parse(check.checkedAt) > Date.now()
        || envelope.lifecycle_state === 'STALE' || envelope.lifecycle_state === 'REVOKED'
        || envelope.lifecycle_state === 'UNKNOWN'
        || new Set(parent.dependencyPins.map(p => p.path)).size !== parent.dependencyPins.length) {
        fault('S8_APPLICATION_PARENT_CHECK_OR_MODEL_BINDING');
    }
    return ApplicationDependenciesSchema.parse({
        modelRef: model.ref, checkRef: check.ref, semanticRevisionRef: envelope.revisionRef,
        producerRef: parent.producerRef, checkerRef: parent.checkerRef, grammarRef: parent.grammarRef,
        observerRuntimeRef: code(parent, 'application-observer-cut', [
            'finnor-os/packages/private-equity/src/application-semantics/source.ts',
            'finnor-os/packages/computer/src/application-provider.ts',
        ], 'S6'),
        transportRef: code(parent, 'application-transport-cut', [
            'finnor-os/packages/computer/src/application-provider.ts',
            'finnor-os/packages/governed-execution/src/adapter-contract.ts',
            'finnor-os/packages/db/governed-egress.ts',
            'finnor-os/packages/governed-execution/src/owner-transport.ts',
        ], 'S6'),
        validityContractRef: code(parent, 'application-validity-cut', [
            'finnor-os/packages/private-equity/src/application-semantics/validity.ts',
        ], 'S4'),
        runtimeRef: parent.runtimeRef, runtimeDigest: parent.runtimeDigest,
        dependencyLockDigest: parent.dependencyLockDigest, schemaDigest: parent.schemaDigest,
        originalParentRef: parent.originalParentRef, authorityGrantRef: parent.authorityGrantRef,
        resourceGrantRef: parent.resourceGrantRef, rightsRevision: parent.rightsRevision,
        sourceRevisionVector: envelope.source_revision_vector, applicationFingerprints: envelope.application_fingerprints,
        modelDependencyRefs: envelope.invalidation_dependencies,
        applicationIdentityAndVersionEvidence: model.application_identity_and_version_evidence,
        originalEvidenceRefs: check.originalEvidenceRefs,
        operationBindings: model.operations.map(operation => ({
            operationId: operation.id, role: operation.authorization.role, grantRef: operation.authorization.grantRef,
            semanticRevision: operation.semanticRevision, renderingDigest: operation.renderingDigest,
            observerContractRef: operation.observerContractRef, privateBindingRef: operation.privateBindingRef,
            dependencyRefs: operation.dependencies, effectClass: operation.effects.classification,
            replay: operation.effects.replay, observationFields: operation.effects.observationFields,
        })),
        supportedDomain: model.supported_domain, validAfter: envelope.validAfter, validUntil: envelope.validUntil,
    });
}
export const ApplicationCandidateBodySchema = z.object({
    schema: z.literal('finnor.s8.application-candidate.v1'), frontier: z.literal('FRONTIER5.X2'),
    owningInterface: z.literal('application-operation-v1'), tenantId: text, principalId: text, rightsRef: text,
    parents: z.array(ApplicationPortRefSchema).max(32), modelRef: X2RefSchema, checkRef: X2RefSchema,
    originalParent: OriginalApplicationParentSchema, scope: ApplicationScopeSchema,
    profiles: z.array(ApplicationProfileBindingSchema).min(1).max(8),
    dependencies: ApplicationDependenciesSchema, sourcePins: z.array(SourcePinSchema).min(1).max(128),
    proposedAt: instant, ...flags,
}).strict();
export type ApplicationCandidateBody = z.infer<typeof ApplicationCandidateBodySchema>;
export type ApplicationCandidate = ApplicationCandidateBody & { ref: ApplicationPortRef };
export function makeApplicationCandidate(input: {
    model: ApplicationActionModel; check: ApplicationModelCheck; originalParent: OriginalApplicationParent;
    profiles: AuthorizedApplicationProfile[]; sourcePins: Array<{ path: string; sha256: string }>;
    proposedAt: string; parents?: ApplicationPortRef[];
}): ApplicationCandidate {
    const model = parseApplicationModel(input.model), check = parseApplicationCheck(input.check);
    assertApplicationModelUse(model, check);
    const body = ApplicationCandidateBodySchema.parse({
        schema: 'finnor.s8.application-candidate.v1', frontier: 'FRONTIER5.X2',
        owningInterface: 'application-operation-v1', tenantId: model.scope.tenantId,
        principalId: model.scope.principalId, rightsRef: input.originalParent.rightsRevision, parents: input.parents ?? [],
        modelRef: model.ref, checkRef: check.ref, originalParent: input.originalParent, scope: model.scope,
        profiles: input.profiles.map(applicationProfileBinding).sort((a, b) => a.id.localeCompare(b.id)),
        dependencies: applicationDependencies(model, check, input.originalParent), sourcePins: input.sourcePins,
        proposedAt: input.proposedAt, protectionDomain: 'DISPOSABLE_TEST_AUTHORITY',
        qualification: APPLICATION_S8_QUALIFICATION, protectedAdmission: false, executionAuthorityGranted: false,
    });
    return parseApplicationCandidate({ ...body, ref: applicationRef('candidate', body) });
}
export function parseApplicationCandidate(input: unknown): ApplicationCandidate {
    boundedX2(input);
    const raw = z.object({ ref: ApplicationPortRefSchema }).passthrough().parse(input);
    const { ref, ...rest } = raw, body = ApplicationCandidateBodySchema.parse(rest);
    body.profiles.forEach(profileOrigin);
    if (digest(ref) !== digest(applicationRef('candidate', body))
        || digest(body.modelRef) !== digest(body.dependencies.modelRef)
        || digest(body.checkRef) !== digest(body.dependencies.checkRef)
        || body.modelRef.owner !== 'S4' || body.checkRef.owner !== 'S4'
        || body.scope.tenantId !== body.tenantId || body.scope.principalId !== body.principalId
        || body.originalParent.rightsRevision !== body.rightsRef
        || new Set(body.sourcePins.map(p => p.path)).size !== body.sourcePins.length
        || new Set(body.profiles.map(p => p.id)).size !== body.profiles.length
        || new Set(body.parents.map(p => p.id)).size !== body.parents.length
        || new Set(body.dependencies.operationBindings.map(p => p.operationId)).size !== body.dependencies.operationBindings.length
        || Date.parse(body.dependencies.validUntil) <= Date.parse(body.dependencies.validAfter)
        || Date.parse(body.proposedAt) > Date.now()
        || body.profiles.some(p => p.tenantId !== body.tenantId || p.principalId !== body.principalId
            || p.application !== body.scope.application || p.account !== body.scope.account
            || Date.parse(p.validUntil) < Date.parse(body.dependencies.validUntil))
        || !body.profiles.some(p => p.role === body.scope.role && digest(p.grantRef) === digest(body.scope.grantRef))
        || body.dependencies.operationBindings.some(operation => !body.profiles.some(p =>
            p.role === operation.role && digest(p.grantRef) === digest(operation.grantRef)))) {
        fault('S8_APPLICATION_CANDIDATE_IDENTITY_OR_DOMAIN');
    }
    return { ...body, ref };
}
export const applicationDependencyDigest = (candidate: ApplicationCandidateBody) => digest({
    dependencies: candidate.dependencies, originalParent: candidate.originalParent,
    profiles: candidate.profiles, sourcePins: candidate.sourcePins,
});
export const ApplicationProtocolSchema = z.object({
    schema: z.literal('finnor.s8.application-evaluation-protocol.v1'), tenantId: text, principalId: text,
    revisionRef: ApplicationPortRefSchema, evaluatorId: text, registeredAt: instant,
    dependencyDigest: hex, originalEvidenceRefs: refs().min(1), oracleRef: X2RefSchema,
    caseCommitments: z.array(hex).min(1).max(4096), ...flags,
}).strict();
export const ApplicationEvaluationSchema = z.object({
    schema: z.literal('finnor.s8.application-evaluation.v1'), tenantId: text, principalId: text,
    revisionRef: ApplicationPortRefSchema, protocolRef: ApplicationPortRefSchema, evaluatorId: text,
    completedAt: instant, dependencyDigest: hex, originalEvidenceRefs: refs().min(1),
    oracleRef: X2RefSchema, caseCommitments: z.array(hex).min(1).max(4096),
    resultsDigest: hex, evidenceRefs: refs().min(1),
    disposition: z.enum(['SUPPORTED_DEVELOPMENT', 'REFUSED', 'INCONCLUSIVE']),
    falseValid: z.number().int().min(0), falseInvalid: z.number().int().min(0),
    authorityViolations: z.number().int().min(0), duplicateEffects: z.number().int().min(0),
    falseCompletions: z.number().int().min(0), costs: LifecycleCostSchema,
    economicCreditGranted: z.literal(false), ...flags,
}).strict();
export const ApplicationAdmissionSchema = z.object({
    schema: z.literal('finnor.s8.application-admission.v1'), revisionRef: ApplicationPortRefSchema,
    evaluationRef: ApplicationPortRefSchema, dependencyDigest: hex, ...flags,
}).strict();
export const ApplicationActivationSchema = z.object({
    schema: z.literal('finnor.s8.application-activation.v1'), revisionRef: ApplicationPortRefSchema,
    admissionRef: ApplicationPortRefSchema, dependencyDigest: hex, expectedGeneration: z.number().int().min(0),
    predecessorRef: ApplicationPortRefSchema.nullable(), mode: z.literal('DEVELOPMENT'),
    validUntil: instant, maxCost: z.number().finite().min(0).max(100),
    maxUses: z.number().int().min(1).max(100000), evidenceRefs: refs().min(1), ...flags,
}).strict();
export const ApplicationRevocationSchema = z.object({
    schema: z.literal('finnor.s8.application-revocation.v1'), revisionRef: ApplicationPortRefSchema,
    expectedGeneration: z.number().int().min(0), expectedActivationRef: ApplicationPortRefSchema.nullable(),
    reason: text, evidenceRefs: refs().min(1), ...flags,
}).strict();
export const ApplicationCapabilityRequestSchema = z.object({
    requestId, inputDigest: hex, operationIds: z.array(text).min(1).max(8),
    applicationRevision: text,
    target: ScopedApplicationIdentitySchema, compositionRef: X2RefSchema.nullable(),
    allocationRef: X2RefSchema, reservationRef: X2RefSchema, resourceEnvelopeDigest: hex,
    deadlineAt: instant, reservedCost: z.number().finite().min(0).max(100), currentnessRef: X2RefSchema,
    freshAuthorityRef: X2RefSchema.nullable(),
}).strict();
export type ApplicationCapabilityRequest = z.infer<typeof ApplicationCapabilityRequestSchema>;
export const applicationRequestBindingDigest = (request: ApplicationCapabilityRequest) => {
    const { currentnessRef: _currentness, ...binding } = ApplicationCapabilityRequestSchema.parse(request);
    return digest(binding);
};
/** Original knowledge bindings may move to current grants only through S4's
 * actual immutable fresh-role handoff. This validates an owner preimage, not
 * a caller-issued permission or a generated model's authority claim. */
export function assertApplicationFreshBinding(body: unknown, ref: z.infer<typeof X2RefSchema>, input: {
    modelRef: z.infer<typeof X2RefSchema>; checkRef: z.infer<typeof X2RefSchema>;
    parent: OriginalApplicationParent; scope: z.infer<typeof ApplicationScopeSchema>;
    originalProfiles: ApplicationProfileBinding[]; profile: ApplicationProfileBinding;
    operationBindings: ApplicationDependencies['operationBindings']; request: ApplicationCapabilityRequest;
}): ApplicationFreshAuthority {
    const authority = ApplicationFreshAuthorityBodySchema.parse(body);
    const binding = authority.bindings.find(item => item.profileId === input.profile.id);
    const original = input.originalProfiles.find(item => item.id === input.profile.id);
    if (digest(ref) !== digest(x2Ref('S4', 'application-fresh-authority', authority))
        || authority.tenantId !== input.scope.tenantId || authority.principalId !== input.scope.principalId
        || authority.rightsRef !== input.parent.rightsRevision || digest(authority.modelRef) !== digest(input.modelRef)
        || digest(authority.checkRef) !== digest(input.checkRef)
        || digest(authority.originalParentRef) !== digest(input.parent.originalParentRef)
        || authority.deadlineAt !== input.parent.deadlineAt || digest(authority.target) !== digest(input.request.target)
        || !binding || !original || binding.role !== input.profile.role
        || digest(binding.currentGrantRef) !== digest(input.profile.grantRef)
        || digest(binding.originalGrantRef) !== digest(original.grantRef)
        || ['id', 'tenantId', 'principalId', 'application', 'account', 'actingPrincipal', 'role', 'origin', 'sourceContract', 'protectionDomain']
            .some(key => digest(original[key as keyof ApplicationProfileBinding]) !== digest(input.profile[key as keyof ApplicationProfileBinding]))
        || input.request.operationIds.some(id => !binding.operationIds.includes(id)
            || !input.operationBindings.some(operation => operation.operationId === id && operation.role === binding.role
                && digest(operation.grantRef) === digest(binding.originalGrantRef)))) {
        fault('S8_APPLICATION_FRESH_AUTHORITY_SUBSTITUTION', 403);
    }
    return authority;
}
/** A proposed native S4 output protocol, not a way to manufacture currentness.
 * Its publisher must check actual owners before retaining this preimage. */
export const ApplicationCurrentnessBodySchema = z.object({
    schema: z.literal('finnor.x2.application-s8-currentness.v1'), tenantId: text, principalId: text,
    rightsRef: text, modelRef: X2RefSchema, checkRef: X2RefSchema, originalParentRef: X2RefSchema,
    dependencyDigest: hex, profileBindingDigest: hex, requestBindingDigest: hex,
    applicationRevision: text, checkedAt: instant, expiresAt: instant,
    evidenceRefs: refs().min(1), liabilityRefs: refs(),
    current: z.literal(true), externalUniversalProof: z.literal(false), ...flags,
}).strict();
export type ApplicationCurrentnessBody = z.infer<typeof ApplicationCurrentnessBodySchema>;
export const ApplicationUseCommandSchema = z.object({
    revisionRef: ApplicationPortRefSchema, modelRef: X2RefSchema, checkRef: X2RefSchema,
    originalParentRef: X2RefSchema, originalParentDigest: hex, profile: ApplicationProfileBindingSchema,
    request: ApplicationCapabilityRequestSchema,
}).strict();
export type ApplicationUseCommand = z.infer<typeof ApplicationUseCommandSchema>;
export const ApplicationUseLeaseSchema = z.object({
    schema: z.literal('finnor.s8.application-use.v1'), useId: text, revisionRef: ApplicationPortRefSchema,
    modelRef: X2RefSchema, checkRef: X2RefSchema, originalParentRef: X2RefSchema,
    originalParentDigest: hex, activationRef: ApplicationPortRefSchema, dependencyDigest: hex,
    dependencies: ApplicationDependenciesSchema, profile: ApplicationProfileBindingSchema,
    requestBindingDigest: hex, request: ApplicationCapabilityRequestSchema,
    currentnessRef: X2RefSchema, evidenceRefs: refs().min(1), liabilityRefs: refs(),
    generation: z.number().int().min(1), reservedCost: z.number().finite().min(0).max(100),
    expiresAt: instant, status: z.literal('PINNED_PENDING'), mode: z.literal('DEVELOPMENT'),
    costQualification: z.literal('RESERVATION_ONLY_ACTUAL_COST_UNKNOWN_UNLESS_INDEPENDENTLY_REPORTED'), ...flags,
}).strict();
export type ApplicationCapabilityUseLease = z.infer<typeof ApplicationUseLeaseSchema>;
export const ApplicationRecheckCommandSchema = ApplicationUseCommandSchema.extend({
    useId: text, leaseDigest: hex,
}).strict();
export const ApplicationRecheckBodySchema = z.object({
    schema: z.literal('finnor.s8.application-recheck.v1'), useId: text, leaseDigest: hex,
    lease: ApplicationUseLeaseSchema, currentnessRef: X2RefSchema, checkedAt: instant, expiresAt: instant,
    evidenceRefs: refs().min(1), liabilityRefs: refs(), current: z.literal(true), ...flags,
}).strict();
export type ApplicationCapabilityRecheckBody = z.infer<typeof ApplicationRecheckBodySchema>;
export const ApplicationReconciliationSchema = z.object({
    useId: text, revisionRef: ApplicationPortRefSchema, evidenceRef: X2RefSchema,
    priorEvidenceRef: X2RefSchema.nullable(), outcome: z.enum(['OBSERVED', 'UNKNOWN', 'FAILED', 'DECLINED']),
}).strict();
const originalRequestSchema = z.object({
    schema: z.literal('finnor.s6.application-request.v1'), sessionId: z.string().uuid(),
    originalParentRef: X2RefSchema, obligationRef: X2RefSchema, requestId: z.string().uuid(),
    effectRef: z.object({ id: z.string().uuid(), semanticHash: hex, schemaVersion: z.literal(1) }).strict(),
    nodeId: text, privateWireDigest: hex, privateBindingRef: X2RefSchema, deadlineAt: instant,
    wireIdentityEncoding: z.literal('NATIVE_OPAQUE_REFERENCE_V1'),
    executionAuthorityGranted: z.literal(false), protectedReceipt: z.null(),
}).strict();
const originalObligationSchema = z.object({
    schema: z.literal('finnor.s6.application-obligation.v1'), tenantId: text, principalId: text, rightsRef: text,
    workId: z.string().uuid(), originalParentRef: X2RefSchema, modelRef: X2RefSchema, checkRef: X2RefSchema,
    allocationRef: X2RefSchema, reservationRef: X2RefSchema, operationRef: X2RefSchema, privateBindingRef: X2RefSchema,
    target: ScopedApplicationIdentitySchema, parameters: ApplicationStateSchema, before: ApplicationSnapshotSchema,
    effectRef: originalRequestSchema.shape.effectRef, deadlineAt: instant,
    protectionDomain: z.literal('DISPOSABLE_TEST_AUTHORITY'), executionAuthorityGranted: z.literal(false),
    replay: z.literal('NEVER_AFTER_POSSIBLE_EGRESS'), protectedReceipt: z.null(),
}).passthrough();

type Actor = { id: string; principalId: string; roles: readonly string[] };
export interface ApplicationLifecyclePolicy {
    domain: string; tenantId: string; principalId: string; rightsRef: string; validAfter: string; validUntil: string;
    evaluatorKeys: AuthorityKey[]; promotionKeys: AuthorityKey[];
    sourcePins: Array<{ path: string; sha256: string }>; maxTotalCost: number; maxTotalUses: number;
    costAuthorityPrincipalIds: string[];
    application?: ApplicationPortConfiguration;
}
interface State {
    candidate: ApplicationCandidate; protocol: Signed<z.infer<typeof ApplicationProtocolSchema>> | null;
    protocolRef: ApplicationPortRef | null; evaluation: Signed<z.infer<typeof ApplicationEvaluationSchema>> | null;
    evaluationRef: ApplicationPortRef | null; admission: Signed<z.infer<typeof ApplicationAdmissionSchema>> | null;
    admissionRef: ApplicationPortRef | null; activation: Signed<z.infer<typeof ApplicationActivationSchema>> | null;
    activationRef: ApplicationPortRef | null; revoked: boolean;
}
interface Use {
    lease: ApplicationCapabilityUseLease; actorPrincipal: string; reconciled: boolean;
    lastEvidenceRef: CapabilityRef | null; evidenceRefs: CapabilityRef[]; liabilityRefs: CapabilityRef[];
    possibleEffectRefs: CapabilityRef[];
}
const domainKey = (candidate: ApplicationCandidate) => digest({
    originalParentRef: candidate.originalParent.originalParentRef, scope: candidate.scope,
});
const retainedUnion = (a: CapabilityRef[], b: CapabilityRef[]) =>
    [...new Map([...a, ...b].map(ref => [digest(ref), ref])).values()];
/** Maps below are replay projections of CapabilityJournal, never another store. */
export class ApplicationCapabilityPort {
    private states = new Map<string, State>();
    private domains = new Map<string, { generation: number; active: string | null }>();
    private uses = new Map<string, Use>();
    private consumedCases = new Set<string>();
    constructor(private policy: ApplicationLifecyclePolicy) {}
    hasHistory() { return this.states.size > 0; }
    snapshot(offset: number, limit: number) {
        return {
            revisions: [...this.states.values()].slice(offset, offset + limit).map(state => ({
                ref: state.candidate.ref, modelRef: state.candidate.modelRef, checkRef: state.candidate.checkRef,
                originalParentRef: state.candidate.originalParent.originalParentRef, scope: state.candidate.scope,
                dependencyDigest: applicationDependencyDigest(state.candidate), revoked: state.revoked,
                protocolRef: state.protocolRef, evaluationRef: state.evaluationRef, admissionRef: state.admissionRef,
                activationRef: state.activationRef, domain: this.domain(state),
                disposition: state.evaluation?.body.disposition ?? null, costs: state.evaluation?.body.costs ?? null,
            })),
            uses: [...this.uses.values()].slice(offset, offset + limit).map(use => ({
                lease: use.lease, reconciled: use.reconciled, lastEvidenceRef: use.lastEvidenceRef,
                evidenceRefs: use.evidenceRefs, liabilityRefs: use.liabilityRefs, possibleEffectRefs: use.possibleEffectRefs,
            })),
            counts: { revisions: this.states.size, uses: this.uses.size, consumedCases: this.consumedCases.size },
            liabilityBudgetReleased: false, economicCreditGranted: false, ...this.flags(),
        };
    }
    replay(entry: JournalEntry) {
        const b = entry.body, r = entry.result;
        if (entry.operation === 'APPLICATION_PROPOSE') {
            const candidate = parseApplicationCandidate(b);
            this.states.set(candidate.ref.id, { candidate, protocol: null, protocolRef: null, evaluation: null,
                evaluationRef: null, admission: null, admissionRef: null, activation: null, activationRef: null, revoked: false });
        } else if (entry.operation === 'APPLICATION_REGISTER') {
            const state = this.state(b.body.revisionRef); state.protocol = b; state.protocolRef = r.ref;
            for (const commitment of b.body.caseCommitments) this.consumedCases.add(commitment);
        } else if (entry.operation === 'APPLICATION_EVALUATE') {
            const state = this.state(b.body.revisionRef); state.evaluation = b; state.evaluationRef = r.ref;
        } else if (entry.operation === 'APPLICATION_ADMIT') {
            const state = this.state(b.body.revisionRef); state.admission = b; state.admissionRef = r.ref;
        } else if (entry.operation === 'APPLICATION_ACTIVATE') {
            const state = this.state(b.body.revisionRef); state.activation = b; state.activationRef = r.ref;
            this.domains.set(domainKey(state.candidate), { generation: r.generation, active: state.candidate.ref.id });
        } else if (entry.operation === 'APPLICATION_REVOKE') {
            const state = this.state(b.body.revisionRef); state.revoked = true;
            const domain = this.domain(state);
            this.domains.set(domainKey(state.candidate), { generation: r.generation,
                active: domain.active === state.candidate.ref.id ? null : domain.active });
        } else if (entry.operation === 'APPLICATION_USE') {
            const lease = ApplicationUseLeaseSchema.parse(r.lease);
            this.uses.set(lease.useId, { lease, actorPrincipal: this.policy.principalId, reconciled: false,
                lastEvidenceRef: null, evidenceRefs: lease.evidenceRefs, liabilityRefs: lease.liabilityRefs, possibleEffectRefs: [] });
        } else if (entry.operation === 'APPLICATION_RECHECK') {
            const use = this.use(b.useId);
            use.evidenceRefs = retainedUnion(use.evidenceRefs, r.recheck.evidenceRefs);
            use.liabilityRefs = retainedUnion(use.liabilityRefs, r.recheck.liabilityRefs);
        } else if (entry.operation === 'APPLICATION_RECONCILE') {
            const use = this.use(b.useId); use.reconciled = r.outcomeResolved === true; use.lastEvidenceRef = b.evidenceRef;
            use.evidenceRefs = retainedUnion(use.evidenceRefs, [b.evidenceRef]);
            use.liabilityRefs = retainedUnion(use.liabilityRefs, r.liabilityRefs);
            use.possibleEffectRefs = retainedUnion(use.possibleEffectRefs, r.possibleEffectRefs);
        }
    }
    private state(ref: CapabilityRef) {
        const state = this.states.get(ref.id);
        if (!state || digest(state.candidate.ref) !== digest(ref)) fault('S8_APPLICATION_NOT_FOUND', 404);
        return state;
    }
    private use(id: string) {
        const use = this.uses.get(id); if (!use) fault('S8_APPLICATION_USE_NOT_FOUND', 404); return use;
    }
    private domain(state: State) { return this.domains.get(domainKey(state.candidate)) ?? { generation: 0, active: null }; }
    private configured(): ApplicationPortConfiguration {
        if (this.policy.domain !== 'DISPOSABLE_TEST_AUTHORITY' || process.env.NODE_ENV === 'production')
            fault('S8_PROTECTED_APPLICATION_DOMAIN_UNADMITTED', 403);
        if (!this.policy.application) fault('S8_APPLICATION_PORT_UNCONFIGURED', 503);
        return this.policy.application;
    }
    private scope(body: { tenantId: string; principalId: string; rightsRef?: string }) {
        if (body.tenantId !== this.policy.tenantId || body.principalId !== this.policy.principalId
            || body.rightsRef !== undefined && body.rightsRef !== this.policy.rightsRef) fault('S8_TENANT_OR_OWNER_MISMATCH', 403);
    }
    private role(actor: Actor, role: string) {
        if (!actor.roles.includes(role)) fault('S8_OPERATION_NOT_AUTHORIZED', 403);
    }
    private async sources(candidate: ApplicationCandidate) {
        const configuration = this.configured();
        if (digest(candidate.sourcePins) !== digest(this.policy.sourcePins)) fault('S8_APPLICATION_SOURCE_CLOSURE_SUBSTITUTION');
        await assertNativeApplicationSources(candidate.originalParent, configuration.sourceRoot, this.policy.sourcePins);
    }
    private async native(ref: CapabilityRef) {
        const resolved = await resolveEconomicOwnerReference({
            semanticOwner: 'S8', tenantId: this.policy.tenantId, principalId: this.policy.principalId,
        }, ref, { purpose: 'CONSUMER', rightsRef: this.policy.rightsRef });
        if (resolved.protectionDomain !== 'DISPOSABLE_TEST_AUTHORITY') fault('S8_APPLICATION_NATIVE_PROTECTION_DOMAIN', 403);
        return resolved.reference.content;
    }
    private async model(state: State) {
        const candidate = state.candidate;
        await this.sources(candidate);
        const [modelBody, checkBody, parent] = await Promise.all([
            this.native(candidate.modelRef), this.native(candidate.checkRef),
            this.native(candidate.originalParent.originalParentRef),
        ]);
        const model = parseApplicationModel({ ...modelBody, ref: candidate.modelRef });
        const check = parseApplicationCheck({ ...checkBody, ref: candidate.checkRef });
        assertApplicationModelUse(model, check);
        if (digest(applicationDependencies(model, check, candidate.originalParent)) !== digest(candidate.dependencies)
            || digest(model.scope) !== digest(candidate.scope)) fault('S8_APPLICATION_NATIVE_MODEL_SUBSTITUTION');
        const grantDigests = (value: unknown) => X2RefSchema.array().parse(value).map(ref => digest(ref)).sort();
        if (parent.schema !== 'finnor.s4.application-original-parent.v1' || parent.tenantId !== candidate.tenantId
            || parent.principalId !== candidate.principalId || parent.rightsRef !== candidate.rightsRef
            || parent.deadlineAt !== candidate.originalParent.deadlineAt || parent.validAfter !== candidate.originalParent.validAfter
            || parent.schemaDigest !== candidate.originalParent.schemaDigest
            || parent.runtimeDigest !== candidate.originalParent.runtimeDigest
            || parent.dependencyLockDigest !== candidate.originalParent.dependencyLockDigest
            || digest(grantDigests(parent.profileGrants)) !== digest(grantDigests(candidate.profiles.map(profile => profile.grantRef)))
            || parent.sourceCut !== digest({ pins: candidate.originalParent.dependencyPins,
                runtime: applicationRuntimeIdentity() })) {
            fault('S8_APPLICATION_NATIVE_ORIGINAL_PARENT_SUBSTITUTION');
        }
        return { model, check };
    }
    private admitted(state: State) {
        const candidate = state.candidate;
        if (state.revoked || !state.protocol || !state.evaluation || !state.admission
            || state.evaluation.body.disposition !== 'SUPPORTED_DEVELOPMENT'
            || Date.now() < Date.parse(candidate.dependencies.validAfter)
            || Date.now() >= Date.parse(candidate.dependencies.validUntil)) fault('S8_APPLICATION_UNADMITTED_REVOKED_OR_EXPIRED', 403);
        const evaluator = assertSignature(state.protocol, this.policy.evaluatorKeys, state.protocol.body.evaluatorId);
        assertSignature(state.evaluation, this.policy.evaluatorKeys, evaluator.principalId);
        const promoter = assertSignature(state.admission, this.policy.promotionKeys);
        if (evaluator.principalId === candidate.principalId || promoter.principalId === candidate.principalId
            || evaluator.principalId === promoter.principalId) fault('S8_AUTHORITY_NOT_SEPARATED', 403);
    }
    private activeDomain(state: State) {
        this.admitted(state);
        const domain = this.domain(state);
        if (!state.activation || !state.activationRef || domain.active !== state.candidate.ref.id
            || Date.now() >= Date.parse(state.activation.body.validUntil)) fault('S8_APPLICATION_NOT_ACTIVE', 403);
        assertSignature(state.activation, this.policy.promotionKeys);
        return domain;
    }
    private async active(state: State) {
        const domain = this.activeDomain(state);
        await this.model(state);
        return domain;
    }
    private async currentness(state: State, input: ApplicationUseCommand): Promise<ApplicationCurrentnessBody> {
        const candidate = state.candidate, request = input.request;
        if (digest(input.modelRef) !== digest(candidate.modelRef) || digest(input.checkRef) !== digest(candidate.checkRef)
            || digest(input.originalParentRef) !== digest(candidate.originalParent.originalParentRef)
            || input.originalParentDigest !== digest(candidate.originalParent)
            || !request.freshAuthorityRef && !candidate.profiles.some(profile => digest(profile) === digest(input.profile))
            || request.target.application !== candidate.scope.application || request.target.account !== candidate.scope.account
            || new Set(request.operationIds).size !== request.operationIds.length
            || request.operationIds.some(id => !candidate.dependencies.operationBindings.some(operation =>
                operation.operationId === id && operation.role === input.profile.role
                && (request.freshAuthorityRef || digest(operation.grantRef) === digest(input.profile.grantRef))))
            || request.allocationRef.owner !== 'S5' || request.reservationRef.owner !== 'S5'
            || digest(request.reservationRef) !== digest(candidate.originalParent.resourceGrantRef)
            || Date.parse(request.deadlineAt) > Date.parse(candidate.originalParent.deadlineAt)
            || Date.parse(request.deadlineAt) > Date.parse(input.profile.validUntil)
            || Date.parse(request.deadlineAt) <= Date.now() || Date.parse(input.profile.validUntil) <= Date.now()
            || request.currentnessRef.owner !== 'S4') fault('S8_APPLICATION_USE_BINDING', 403);
        const [handoff, allocation, reservation, compositionBody, currentBody] = await Promise.all([
            request.freshAuthorityRef ? this.native(request.freshAuthorityRef) : Promise.resolve(null),
            this.native(request.allocationRef), this.native(request.reservationRef),
            request.compositionRef ? this.native(request.compositionRef) : Promise.resolve(null),
            this.native(request.currentnessRef),
        ]);
        const fresh = request.freshAuthorityRef ? assertApplicationFreshBinding(
            handoff, request.freshAuthorityRef, {
                modelRef: candidate.modelRef, checkRef: candidate.checkRef, parent: candidate.originalParent,
                scope: candidate.scope, originalProfiles: candidate.profiles, profile: input.profile,
                operationBindings: candidate.dependencies.operationBindings, request,
            }) : null;
        // Immutable S5 preimages bind the original envelope. Fresh mutable
        // occupation/revocation must still be checked by the native validity owner.
        if (allocation.schema !== 'finnor.s5.application-allocation.v1'
            || allocation.tenantId !== candidate.tenantId || allocation.principalId !== candidate.principalId
            || allocation.rightsRef !== candidate.rightsRef || allocation.executionAuthorityGranted !== false
            || allocation.protectionDomain !== 'DISPOSABLE_TEST_AUTHORITY'
            || digest(allocation.originalParentRef) !== digest(candidate.originalParent.originalParentRef)
            || allocation.deadlineAt !== candidate.originalParent.deadlineAt || allocation.check?.exactResourceCheck !== true
            || !Array.isArray(allocation.check.envelopes) || !allocation.check.envelopes.length
            || digest(allocation.check.envelopes) !== request.resourceEnvelopeDigest
            || reservation.schema !== 'finnor.s5.application-reservation.v1'
            || reservation.tenantId !== candidate.tenantId || reservation.principalId !== candidate.principalId
            || digest(reservation.certificateRef) !== digest(request.allocationRef)
            || digest(reservation.envelopes) !== request.resourceEnvelopeDigest
            || reservation.executionAuthorityGranted !== false || reservation.status !== 'RESERVED'
            || reservation.revocationReason !== null) fault('S8_APPLICATION_ORIGINAL_RESOURCE_BINDING', 403);
        if (request.compositionRef) {
            const composition = parseApplicationComposition({
                ...compositionBody, ref: request.compositionRef,
            });
            if (composition.disposition !== 'COMPOSED_WITH_REQUIRED_OBSERVATIONS'
                || digest(composition.modelRef) !== digest(candidate.modelRef) || digest(composition.checkRef) !== digest(candidate.checkRef)
                || digest(composition.originalParentRef) !== digest(input.originalParentRef)
                || ['tenantId', 'principalId', 'application', 'account'].some(key =>
                    digest(composition.scope[key as keyof typeof composition.scope]) !== digest(candidate.scope[key as keyof typeof candidate.scope]))
                || (fresh ? !fresh.bindings.some(binding => binding.role === composition.scope.role
                    && digest(binding.currentGrantRef) === digest(composition.scope.grantRef))
                    : digest(composition.scope) !== digest(candidate.scope))
                || digest(composition.target) !== digest(request.target)
                || Date.parse(composition.deadlineAt) > Date.parse(candidate.originalParent.deadlineAt)
                || Date.parse(composition.deadlineAt) < Date.parse(request.deadlineAt)
                || request.operationIds.some(id => !composition.steps.some(step => step.operationId === id)))
                fault('S8_APPLICATION_COMPOSITION_BINDING', 403);
        }
        const current = ApplicationCurrentnessBodySchema.parse(currentBody);
        if (digest(request.currentnessRef) !== digest(x2Ref('S4', 'application-s8-currentness', current))
            || current.tenantId !== candidate.tenantId || current.principalId !== candidate.principalId
            || current.rightsRef !== candidate.rightsRef || digest(current.modelRef) !== digest(candidate.modelRef)
            || digest(current.checkRef) !== digest(candidate.checkRef)
            || digest(current.originalParentRef) !== digest(candidate.originalParent.originalParentRef)
            || current.dependencyDigest !== applicationDependencyDigest(candidate)
            || current.profileBindingDigest !== digest(input.profile)
            || current.requestBindingDigest !== applicationRequestBindingDigest(request)
            || current.applicationRevision !== request.applicationRevision
            || Date.parse(current.checkedAt) > Date.now() || Date.parse(current.expiresAt) <= Date.now()
            || Date.parse(current.expiresAt) <= Date.parse(current.checkedAt)
            || Date.parse(current.expiresAt) - Date.parse(current.checkedAt) > this.configured().maxCurrentnessMs
            || Date.parse(current.expiresAt) > Date.parse(request.deadlineAt)
            || request.freshAuthorityRef && !current.evidenceRefs.some(ref => digest(ref) === digest(request.freshAuthorityRef)))
            fault('S8_APPLICATION_CURRENTNESS_INVALID', 403);
        return current;
    }
    private async costs(state: State, costs: z.infer<typeof LifecycleCostSchema>, completedAt: string) {
        const phases = ['search', 'training', 'evaluation', 'human', 'computeData', 'integration', 'maintenance', 'recovery', 'deployment'] as const;
        if (costs.basis === 'UNKNOWN') return;
        if (!this.policy.costAuthorityPrincipalIds.length || phases.some(phase => costs[phase] === null))
            fault('S8_APPLICATION_COST_COVERAGE_UNKNOWN');
        const covered = new Set<string>();
        for (const ref of costs.costRefs) {
            if (!['FINANCIAL_SOURCE', 'S7'].includes(ref.owner)) fault('S8_INDEPENDENT_COST_SOURCE_REQUIRED');
            const resolved = await resolveEconomicOwnerReference({
                semanticOwner: 'S8', tenantId: this.policy.tenantId, principalId: this.policy.principalId,
            }, ref, { purpose: 'CONSUMER', rightsRef: this.policy.rightsRef, allowedPrincipalIds: this.policy.costAuthorityPrincipalIds });
            const source = z.object({
                schema: z.literal('finnor.s8.independent-lifecycle-cost.v1'), tenantId: text, episodeId: text,
                currency: z.literal('USD'), category: z.enum(phases),
                amount: z.tuple([z.number().finite().min(0), z.number().finite().min(0)]),
                basis: z.enum(['OBSERVED_COMPLETE', 'REGISTERED_GENERATIVE_MODEL']), knowledgeAt: instant,
            }).strict().parse(resolved.reference.content);
            const amount = costs[source.category];
            if (source.tenantId !== state.candidate.tenantId || source.episodeId !== state.candidate.originalParent.originalParentRef.id
                || source.basis !== costs.basis || covered.has(source.category) || !amount
                || source.amount[0] > source.amount[1] || amount[0] < source.amount[0] || amount[1] < source.amount[1]
                || Date.parse(source.knowledgeAt) > Date.parse(completedAt)) fault('S8_APPLICATION_COST_SOURCE_BINDING');
            covered.add(source.category);
        }
        if (phases.some(phase => !covered.has(phase))) fault('S8_UNSOURCED_LIFECYCLE_COST_CATEGORY');
    }
    async revalidateReplay(actor: Actor, operation: string, body: unknown, result: unknown) {
        if (operation !== 'APPLICATION_USE' && operation !== 'APPLICATION_RECHECK') return;
        this.configured(); this.role(actor, 'CONSUMER');
        const command = ApplicationUseCommandSchema.parse(
            operation === 'APPLICATION_USE' ? body : (({ useId: _id, leaseDigest: _digest, ...input }) => input)(ApplicationRecheckCommandSchema.parse(body)));
        const reply = result as { lease?: ApplicationCapabilityUseLease; recheck?: ApplicationCapabilityRecheckBody };
        const lease = reply.lease ?? reply.recheck?.lease;
        if (!lease) fault('S8_APPLICATION_USE_IDENTITY');
        await this.currentUse(actor, command, this.use(lease.useId));
    }
    private async currentUse(actor: Actor, input: ApplicationUseCommand, use: Use) {
        if (actor.principalId !== use.actorPrincipal || use.reconciled
            || digest(use.lease.revisionRef) !== digest(input.revisionRef)
            || use.lease.requestBindingDigest !== applicationRequestBindingDigest(input.request)
            || Date.parse(use.lease.expiresAt) <= Date.now()) fault('S8_APPLICATION_USE_STALE_OR_RECONCILED', 403);
        if (use.possibleEffectRefs.length) fault('S8_APPLICATION_USE_RECONCILIATION_REQUIRED', 403);
        const state = this.state(input.revisionRef), domain = this.activeDomain(state);
        if (domain.generation !== use.lease.generation || digest(state.activationRef) !== digest(use.lease.activationRef))
            fault('S8_APPLICATION_USE_STALE_OR_REVOKED', 403);
        const [, current] = await Promise.all([this.model(state), this.currentness(state, input)]);
        return current;
    }
    private async reconciliationBinding(use: Use, evidence: ApplicationTransitionEvidence) {
        const lease = use.lease, request = lease.request;
        // Resolve the immutable stamp that issued this lease, never the latest
        // recheck or another transition with the same parent/target/operation.
        const current = ApplicationCurrentnessBodySchema.parse(await this.native(lease.currentnessRef));
        const originals = current.evidenceRefs.filter(ref => ref.owner === 'S6' && ref.id.startsWith('application-request:'));
        if (originals.length !== 1 || digest(lease.currentnessRef) !== digest(x2Ref('S4', 'application-s8-currentness', current))
            || current.tenantId !== this.policy.tenantId || current.principalId !== this.policy.principalId
            || current.rightsRef !== this.policy.rightsRef || digest(current.modelRef) !== digest(lease.modelRef)
            || digest(current.checkRef) !== digest(lease.checkRef) || digest(current.originalParentRef) !== digest(lease.originalParentRef)
            || current.profileBindingDigest !== digest(lease.profile) || current.dependencyDigest !== lease.dependencyDigest
            || current.requestBindingDigest !== lease.requestBindingDigest
            || lease.requestBindingDigest !== applicationRequestBindingDigest(request))
            fault('S8_APPLICATION_RECONCILIATION_EVIDENCE');
        const requestRef = originals[0]!, original = originalRequestSchema.parse(await this.native(requestRef));
        const obligation = originalObligationSchema.parse(await this.native(original.obligationRef));
        const claim = LearnedApplicationOperationSchema.parse(await this.native(obligation.operationRef));
        const work = request.freshAuthorityRef
            ? ApplicationFreshAuthorityBodySchema.parse(await this.native(request.freshAuthorityRef))
            : await this.native(lease.originalParentRef);
        const beforeRef = x2Ref('COMPUTER', 'application-observation', obligation.before);
        const effectRef = { owner: 'S6', id: original.effectRef.id, version: 'business-effect-v1',
            contentDigest: original.effectRef.semanticHash };
        if (digest(requestRef) !== digest(x2Ref('S6', 'application-request', original))
            || original.requestId !== request.requestId || original.deadlineAt !== request.deadlineAt
            || digest(original.originalParentRef) !== digest(lease.originalParentRef)
            || digest(original.obligationRef) !== digest(evidence.obligationRef)
            || digest(original.effectRef) !== digest(obligation.effectRef) || digest(effectRef) !== digest(evidence.effectRef)
            || digest(original.privateBindingRef) !== digest(obligation.privateBindingRef)
            || obligation.tenantId !== this.policy.tenantId || obligation.principalId !== this.policy.principalId
            || obligation.rightsRef !== this.policy.rightsRef || obligation.deadlineAt !== request.deadlineAt
            || digest(obligation.originalParentRef) !== digest(lease.originalParentRef)
            || digest(obligation.modelRef) !== digest(lease.modelRef) || digest(obligation.checkRef) !== digest(lease.checkRef)
            || digest(obligation.allocationRef) !== digest(request.allocationRef)
            || digest(obligation.reservationRef) !== digest(request.reservationRef)
            || digest(obligation.target) !== digest(request.target) || digest(obligation.before) !== digest(evidence.before)
            || digest(obligation.parameters) !== digest(evidence.parameters)
            || claim.id !== evidence.operationId || !request.operationIds.includes(claim.id)
            || claim.authorization.role !== lease.profile.role
            || !current.evidenceRefs.some(ref => digest(ref) === digest(beforeRef))
            || work.tenantId !== this.policy.tenantId || work.principalId !== this.policy.principalId
            || work.workId !== obligation.workId || work.sessionId !== original.sessionId
            || typeof work.workInputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(work.workInputDigest)
            || request.inputDigest !== digest({ requestRef, wireDigest: original.privateWireDigest,
                operationId: claim.id, parameters: obligation.parameters, before: beforeRef, workInputDigest: work.workInputDigest }))
            fault('S8_APPLICATION_RECONCILIATION_EVIDENCE');
    }
    async command(actor: Actor, operation: string, body: unknown, requestIdentity: string,
        budget: { totalCost: number; useCount: number },
        commit: (ref: CapabilityRef, content: unknown) => Promise<{ ref: CapabilityRef; receipt: unknown }>): Promise<{ readOnly: boolean; result: unknown }> {
        this.configured();
        const roles: Record<string, string> = {
            APPLICATION_PROPOSE: 'PROPOSER', APPLICATION_REGISTER: 'EVALUATOR', APPLICATION_EVALUATE: 'EVALUATOR',
            APPLICATION_ADMIT: 'PROMOTER', APPLICATION_ACTIVATE: 'PROMOTER', APPLICATION_REVOKE: 'PROMOTER',
            APPLICATION_CURRENT: 'CONSUMER', APPLICATION_USE: 'CONSUMER', APPLICATION_RECHECK: 'CONSUMER',
            APPLICATION_RECONCILE: 'CONSUMER',
        };
        const role = roles[operation]; if (!role) fault('S8_OPERATION_UNSUPPORTED', 404); this.role(actor, role);
        let content: unknown, ref: ApplicationPortRef, extra: Record<string, unknown> = {};
        if (operation === 'APPLICATION_PROPOSE') {
            const candidate = parseApplicationCandidate(body); this.scope(candidate);
            if (actor.principalId !== candidate.principalId) fault('S8_APPLICATION_PROPOSER_IDENTITY', 403);
            if (this.states.has(candidate.ref.id)) fault('S8_APPLICATION_ALREADY_PROPOSED');
            if (Date.parse(candidate.dependencies.validAfter) < Date.parse(this.policy.validAfter)
                || Date.parse(candidate.dependencies.validUntil) > Date.parse(this.policy.validUntil))
                fault('S8_APPLICATION_EXCEEDS_POLICY');
            for (const parent of candidate.parents) this.scope(this.state(parent).candidate);
            const state: State = { candidate, protocol: null, protocolRef: null, evaluation: null,
                evaluationRef: null, admission: null, admissionRef: null, activation: null, activationRef: null, revoked: false };
            await this.model(state);
            const { ref: _ref, ...preimage } = candidate; content = preimage; ref = candidate.ref;
        } else if (operation === 'APPLICATION_CURRENT') {
            const input = z.object({ revisionRef: ApplicationPortRefSchema }).strict().parse(body), state = this.state(input.revisionRef);
            if (actor.principalId !== state.candidate.principalId) fault('S8_APPLICATION_CONSUMER_IDENTITY', 403);
            const domain = this.domain(state), current = !state.revoked && !!state.admission && !!state.activation
                && domain.active === state.candidate.ref.id && Date.parse(state.activation.body.validUntil) > Date.now();
            if (current) await this.active(state);
            return { readOnly: true, result: { current, revisionRef: state.candidate.ref, generation: domain.generation,
                admissionRef: current ? state.admissionRef : null, activationRef: current ? state.activationRef : null,
                dependencyDigest: applicationDependencyDigest(state.candidate), ...this.flags() } };
        } else if (operation === 'APPLICATION_USE' || operation === 'APPLICATION_RECHECK') {
            const recheck = operation === 'APPLICATION_RECHECK' ? ApplicationRecheckCommandSchema.parse(body) : null;
            const input = ApplicationUseCommandSchema.parse(recheck
                ? (({ useId: _id, leaseDigest: _digest, ...request }) => request)(recheck) : body);
            const state = this.state(input.revisionRef);
            if (actor.principalId !== state.candidate.principalId) fault('S8_APPLICATION_CONSUMER_IDENTITY', 403);
            if (recheck) {
                const use = this.use(recheck.useId);
                if (recheck.leaseDigest !== digest(use.lease)) fault('S8_APPLICATION_USE_IDENTITY');
                const current = await this.currentUse(actor, input, use);
                const record = ApplicationRecheckBodySchema.parse({
                    schema: 'finnor.s8.application-recheck.v1', useId: use.lease.useId, leaseDigest: digest(use.lease),
                    lease: use.lease, currentnessRef: input.request.currentnessRef, checkedAt: current.checkedAt,
                    expiresAt: new Date(Math.min(Date.parse(current.expiresAt), Date.parse(use.lease.expiresAt))).toISOString(),
                    evidenceRefs: current.evidenceRefs, liabilityRefs: retainedUnion(use.liabilityRefs, current.liabilityRefs),
                    current: true, ...this.flags(),
                });
                content = record; ref = applicationRef('recheck', content); extra = { recheck: record };
            } else {
                const domain = this.activeDomain(state);
                const [, current] = await Promise.all([this.model(state), this.currentness(state, input)]);
                const activation = state.activation!.body;
                const uses = [...this.uses.values()].filter(use => digest(use.lease.revisionRef) === digest(input.revisionRef));
                if (budget.useCount >= this.policy.maxTotalUses || uses.length >= activation.maxUses
                    || budget.totalCost + input.request.reservedCost > this.policy.maxTotalCost
                    || uses.reduce((sum, use) => sum + use.lease.reservedCost, 0) + input.request.reservedCost > activation.maxCost)
                    fault('S8_APPLICATION_CUMULATIVE_RESOURCE_BOUND', 429);
                const lease = ApplicationUseLeaseSchema.parse({
                    schema: 'finnor.s8.application-use.v1',
                    useId: 'application-use:' + digest({ requestId: requestIdentity, revisionRef: input.revisionRef,
                        requestBindingDigest: applicationRequestBindingDigest(input.request) }),
                    revisionRef: input.revisionRef, modelRef: input.modelRef, checkRef: input.checkRef,
                    originalParentRef: input.originalParentRef, originalParentDigest: input.originalParentDigest,
                    activationRef: state.activationRef, dependencyDigest: applicationDependencyDigest(state.candidate),
                    dependencies: state.candidate.dependencies, profile: input.profile,
                    requestBindingDigest: applicationRequestBindingDigest(input.request), request: input.request,
                    currentnessRef: input.request.currentnessRef, evidenceRefs: current.evidenceRefs, liabilityRefs: current.liabilityRefs,
                    generation: domain.generation, reservedCost: input.request.reservedCost,
                    expiresAt: new Date(Math.min(Date.parse(activation.validUntil), Date.parse(input.request.deadlineAt),
                        Date.parse(current.expiresAt))).toISOString(), status: 'PINNED_PENDING', mode: 'DEVELOPMENT',
                    costQualification: 'RESERVATION_ONLY_ACTUAL_COST_UNKNOWN_UNLESS_INDEPENDENTLY_REPORTED', ...this.flags(),
                });
                content = lease; ref = applicationRef('use', content); extra = { lease };
            }
        } else if (operation === 'APPLICATION_RECONCILE') {
            const input = ApplicationReconciliationSchema.parse(body), use = this.use(input.useId);
            if (actor.principalId !== use.actorPrincipal || digest(input.revisionRef) !== digest(use.lease.revisionRef)
                || digest(input.priorEvidenceRef) !== digest(use.lastEvidenceRef) || input.evidenceRef.owner !== 'S6')
                fault('S8_APPLICATION_RECONCILIATION_BINDING', 403);
            const evidence = parseTransitionEvidence({ ...await this.native(input.evidenceRef), ref: input.evidenceRef });
            await this.reconciliationBinding(use, evidence);
            const operation = use.lease.dependencies.operationBindings.find(binding => binding.operationId === evidence.operationId);
            if (digest(evidence.originalParentRef) !== digest(use.lease.originalParentRef)
                || !use.lease.request.operationIds.includes(evidence.operationId)
                || digest(evidence.before.target) !== digest(use.lease.request.target)
                || evidence.before.scope.tenantId !== this.policy.tenantId || evidence.before.scope.principalId !== actor.principalId
                || evidence.before.scope.application !== use.lease.profile.application
                || evidence.before.scope.account !== use.lease.profile.account || evidence.before.scope.role !== use.lease.profile.role
                || digest(evidence.before.scope.grantRef) !== digest(use.lease.profile.grantRef)
                || evidence.after && (digest(evidence.after.scope) !== digest(evidence.before.scope)
                    || digest(evidence.after.target) !== digest(evidence.before.target))
                || evidence.possibleEgress && operation?.effectClass !== 'OBSERVATION' && (!evidence.effectRef || !evidence.obligationRef)
                || use.possibleEffectRefs.length && (!evidence.effectRef || !use.possibleEffectRefs.some(r => digest(r) === digest(evidence.effectRef)))
                || input.outcome === 'OBSERVED' && (evidence.disposition !== 'OBSERVED' || evidence.independentOutcome !== 'ESTABLISHED'
                    || !evidence.after || evidence.after.observationQualification !== 'LAWFUL_INDEPENDENT_READBACK')
                || input.outcome === 'UNKNOWN' && !['UNKNOWN', 'PENDING'].includes(evidence.disposition)
                || input.outcome === 'FAILED'
                || input.outcome === 'DECLINED' && (evidence.disposition !== 'REJECTED' || evidence.independentOutcome !== 'DENIED'))
                fault('S8_APPLICATION_RECONCILIATION_EVIDENCE');
            content = input; ref = applicationRef('reconciliation', content);
            extra = { liabilityRefs: retainedUnion(use.liabilityRefs, evidence.obligationRef ? [evidence.obligationRef] : []),
                possibleEffectRefs: retainedUnion(use.possibleEffectRefs, evidence.possibleEgress && evidence.effectRef ? [evidence.effectRef] : []),
                outcomeResolved: input.outcome !== 'UNKNOWN' && evidence.independentOutcome !== 'UNAVAILABLE'
                    && evidence.disposition !== 'UNKNOWN' && evidence.disposition !== 'PENDING',
                liabilityBudgetReleased: false, economicCreditGranted: false, causalCreditGranted: false,
                outcomeQualification: 'REPORTED_NATIVE_TRANSITION_NO_NEW_BUSINESS_OR_ECONOMIC_AUTHORITY' };
        } else {
            const signed = z.object({ body: z.unknown(), keyId: text, signature: z.string().min(1).max(128) }).strict().parse(body);
            const schema = operation === 'APPLICATION_REGISTER' ? ApplicationProtocolSchema
                : operation === 'APPLICATION_EVALUATE' ? ApplicationEvaluationSchema
                    : operation === 'APPLICATION_ADMIT' ? ApplicationAdmissionSchema
                        : operation === 'APPLICATION_ACTIVATE' ? ApplicationActivationSchema : ApplicationRevocationSchema;
            const parsed = schema.parse(signed.body), state = this.state(parsed.revisionRef), candidate = state.candidate;
            const evaluatorOperation = role === 'EVALUATOR';
            const key = assertSignature({ ...signed, body: parsed },
                evaluatorOperation ? this.policy.evaluatorKeys : this.policy.promotionKeys, actor.principalId);
            if (key.principalId === candidate.principalId || (evaluatorOperation
                ? this.policy.promotionKeys.some(k => k.principalId === key.principalId)
                : this.policy.evaluatorKeys.some(k => k.principalId === key.principalId)))
                fault('S8_AUTHORITY_NOT_SEPARATED', 403);
            if (state.revoked) fault('S8_APPLICATION_REVOKED', 403);
            const inspected = operation !== 'APPLICATION_REVOKE' ? await this.model(state) : null;
            if (operation === 'APPLICATION_REGISTER') {
                const protocol = ApplicationProtocolSchema.parse(parsed); this.scope(protocol);
                const check = inspected!.check;
                if (state.protocol || protocol.evaluatorId !== actor.principalId
                    || protocol.dependencyDigest !== applicationDependencyDigest(candidate)
                    || digest(protocol.originalEvidenceRefs) !== digest(check.originalEvidenceRefs)
                    || Date.parse(protocol.registeredAt) < Date.parse(candidate.proposedAt) || Date.parse(protocol.registeredAt) > Date.now()
                    || new Set(protocol.caseCommitments).size !== protocol.caseCommitments.length
                    || protocol.caseCommitments.some(c => this.consumedCases.has(c))) fault('S8_APPLICATION_PROTOCOL_INVALID');
            } else if (operation === 'APPLICATION_EVALUATE') {
                const evaluation = ApplicationEvaluationSchema.parse(parsed); this.scope(evaluation);
                if (!state.protocol || !state.protocolRef || state.evaluation || evaluation.evaluatorId !== actor.principalId
                    || evaluation.evaluatorId !== state.protocol.body.evaluatorId
                    || digest(evaluation.protocolRef) !== digest(state.protocolRef)
                    || evaluation.dependencyDigest !== applicationDependencyDigest(candidate)
                    || digest(evaluation.caseCommitments) !== digest(state.protocol.body.caseCommitments)
                    || digest(evaluation.originalEvidenceRefs) !== digest(state.protocol.body.originalEvidenceRefs)
                    || digest(evaluation.oracleRef) !== digest(state.protocol.body.oracleRef)
                    || Date.parse(evaluation.completedAt) < Date.parse(state.protocol.body.registeredAt)
                    || Date.parse(evaluation.completedAt) > Date.now()) fault('S8_APPLICATION_EVALUATION_BINDING');
                assertSignature(state.protocol, this.policy.evaluatorKeys, evaluation.evaluatorId);
                await this.costs(state, evaluation.costs, evaluation.completedAt);
            } else if (operation === 'APPLICATION_ADMIT') {
                const admission = ApplicationAdmissionSchema.parse(parsed);
                const evaluation = state.evaluation?.body;
                if (state.admission || !evaluation || !state.evaluationRef || evaluation.disposition !== 'SUPPORTED_DEVELOPMENT'
                    || evaluation.falseValid || evaluation.falseInvalid || evaluation.authorityViolations
                    || evaluation.duplicateEffects || evaluation.falseCompletions
                    || digest(admission.evaluationRef) !== digest(state.evaluationRef)
                    || admission.dependencyDigest !== applicationDependencyDigest(candidate)
                    || evaluation.evaluatorId === actor.principalId) fault('S8_APPLICATION_ADMISSION_BINDING');
                assertSignature(state.evaluation!, this.policy.evaluatorKeys, evaluation.evaluatorId);
            } else if (operation === 'APPLICATION_ACTIVATE') {
                const activation = ApplicationActivationSchema.parse(parsed); this.admitted(state);
                const domain = this.domain(state), predecessor = domain.active ? this.states.get(domain.active)!.candidate.ref : null;
                if (activation.expectedGeneration !== domain.generation || digest(activation.predecessorRef) !== digest(predecessor)
                    || digest(activation.admissionRef) !== digest(state.admissionRef)
                    || activation.dependencyDigest !== applicationDependencyDigest(candidate)
                    || Date.parse(activation.validUntil) <= Date.now()
                    || Date.parse(activation.validUntil) > Date.parse(candidate.dependencies.validUntil)
                    || Date.parse(activation.validUntil) > Date.parse(this.policy.validUntil)
                    || activation.maxCost > this.policy.maxTotalCost || activation.maxUses > this.policy.maxTotalUses
                    || domain.active === candidate.ref.id || predecessor && !candidate.parents.some(p => digest(p) === digest(predecessor)))
                    fault('S8_APPLICATION_ACTIVATION_BINDING');
                extra = { generation: domain.generation + 1 };
            } else {
                const revocation = ApplicationRevocationSchema.parse(parsed), domain = this.domain(state);
                if (revocation.expectedGeneration !== domain.generation
                    || digest(revocation.expectedActivationRef) !== digest(state.activationRef)) fault('S8_APPLICATION_REVOCATION_BINDING');
                extra = { generation: domain.generation + (domain.active === candidate.ref.id ? 1 : 0), liabilityBudgetReleased: false,
                    unresolvedUsesPreserved: [...this.uses.values()].filter(use => !use.reconciled).length };
            }
            content = { ...signed, body: parsed };
            ref = applicationRef(operation.slice('APPLICATION_'.length).toLowerCase(), content);
        }
        const commitment = await commit(ref, content);
        if (digest(commitment.ref) !== digest(ref)) fault('S8_APPLICATION_COMMITMENT_SUBSTITUTION', 503);
        return { readOnly: false, result: { ref, receipt: commitment.receipt, ...extra, ...this.flags() } };
    }
    private flags() {
        return { protectionDomain: 'DISPOSABLE_TEST_AUTHORITY' as const, qualification: APPLICATION_S8_QUALIFICATION,
            protectedAdmission: false as const, executionAuthorityGranted: false as const };
    }
}

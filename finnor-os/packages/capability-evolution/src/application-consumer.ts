/** Native X2 consumer of the actual configured S8 owner. No auto-admission,
 * credential export, protected execution or alternative authority catalogue. */
import { createPublicKey, randomUUID, verify } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ApplicationActionModel, ApplicationModelCheck, ExperimentRef } from '@finnor/shared-types';
import type { AuthorizedApplicationProfile, OriginalApplicationParent } from '../../private-equity/src/application-semantics/ports';
import { assertApplicationModelUse } from '../../private-equity/src/application-semantics/checker';
import { X2RefSchema, x2Ref } from '../../private-equity/src/application-semantics/contracts';
import { canonical } from '../../governed-execution/src/protocol';
import { resolveEconomicOwnerReference } from '../../governed-execution/src/owner-transport';
import { byteDigest, digest, fault, SourcePinSchema } from './contracts';
import { privateFile } from './journal';
import { assertCapabilitySourceClosure } from './source-closure';
import {
    APPLICATION_S8_QUALIFICATION, ApplicationPortRefSchema, ApplicationCurrentnessBodySchema,
    ApplicationCapabilityRequestSchema, ApplicationUseCommandSchema, ApplicationUseLeaseSchema,
    ApplicationRecheckBodySchema, applicationDependencies, applicationProfileBinding,
    ApplicationReconciliationSchema,
    applicationRequestBindingDigest, applicationRef, applicationDependencyDigest,
    assertApplicationFreshBinding, assertNativeApplicationSources, parseApplicationCandidate,
    type ApplicationCapabilityRequest, type ApplicationCapabilityUseLease,
    type ApplicationCapabilityRecheckBody, type ApplicationPortRef, type ApplicationUseCommand,
} from './application-port';

const text = z.string().min(1).max(256), hex = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const flags = {
    protectionDomain: z.literal('DISPOSABLE_TEST_AUTHORITY'), qualification: z.literal(APPLICATION_S8_QUALIFICATION),
    protectedAdmission: z.literal(false), executionAuthorityGranted: z.literal(false),
};
export const ApplicationConsumerPolicySchema = z.object({
    schema: z.literal('finnor.s8.application-consumer-policy.v1'),
    tenantId: text, principalId: text, rightsRef: text,
    revisionRef: ApplicationPortRefSchema, modelRef: X2RefSchema, checkRef: X2RefSchema,
    originalParentRef: X2RefSchema, originalParentDigest: hex, dependencyDigest: hex,
    profileBindingDigests: z.array(hex).min(1).max(8),
    sourceRoot: z.string().min(1).max(4096).refine(isAbsolute),
    sourcePins: z.array(SourcePinSchema).min(1).max(128),
    endpoint: z.string().min(1).max(2048),
    tokenPath: z.string().min(1).max(4096).refine(isAbsolute), tokenHash: hex,
    validAfter: instant, validUntil: instant, timeoutMs: z.number().int().min(100).max(10000),
    maxCurrentnessMs: z.number().int().min(100).max(30000), ...flags,
}).strict();
export type ApplicationConsumerPolicy = z.infer<typeof ApplicationConsumerPolicySchema>;
export interface ApplicationConsumerScope { tenantId: string; principalId: string; rightsRef: string }
export interface ApplicationCapabilityInput {
    model: ApplicationActionModel;
    check: ApplicationModelCheck;
    originalParent: OriginalApplicationParent;
    /** Credentials stay local; only applicationProfileBinding(profile) is sent. */
    profile: AuthorizedApplicationProfile;
    request: ApplicationCapabilityRequest;
}
export type ApplicationCapabilityRecheckLease = ApplicationCapabilityRecheckBody & { ref: ApplicationPortRef };
const signedPolicySchema = z.object({
    body: ApplicationConsumerPolicySchema, keyId: text,
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();
export async function applicationConsumerPolicy(scope: ApplicationConsumerScope): Promise<ApplicationConsumerPolicy | null> {
    const file = process.env.FINNOR_S8_APPLICATION_CONSUMER_CONFIG;
    if (!file) return null;
    if (process.env.FINNOR_ENVIRONMENT !== 'staging' || process.env.FINNOR_X2_PROFILE !== 'ordinary_disposable')
        fault('S8_PROTECTED_APPLICATION_DOMAIN_UNADMITTED', 403);
    const root = process.env.FINNOR_S8_APPLICATION_CONSUMER_ROOT;
    if (!root) fault('S8_APPLICATION_CONSUMER_ROOT_UNAVAILABLE', 503);
    const signed = signedPolicySchema.parse(JSON.parse((await privateFile(file)).toString())), policy = signed.body;
    const key = createPublicKey(root);
    if (key.asymmetricKeyType !== 'ed25519'
        || !verify(null, Buffer.from(canonical(policy)), key, Buffer.from(signed.signature, 'base64'))
        || Date.now() < Date.parse(policy.validAfter) || Date.now() >= Date.parse(policy.validUntil)
        || Date.parse(policy.validUntil) <= Date.parse(policy.validAfter)) fault('S8_APPLICATION_CONSUMER_POLICY_INVALID', 403);
    if (policy.tenantId !== scope.tenantId || policy.principalId !== scope.principalId || policy.rightsRef !== scope.rightsRef)
        fault('S8_APPLICATION_CONSUMER_SCOPE', 403);
    const url = new URL(policy.endpoint);
    if (url.origin !== policy.endpoint || url.protocol !== 'http:' || url.username || url.password
        || !['127.0.0.1', '[::1]'].includes(url.hostname)) fault('S8_APPLICATION_CONSUMER_ENDPOINT', 403);
    if (new Set(policy.sourcePins.map(pin => pin.path)).size !== policy.sourcePins.length
        || new Set(policy.profileBindingDigests).size !== policy.profileBindingDigests.length)
        fault('S8_APPLICATION_CONSUMER_AMBIGUOUS_BINDING', 403);
    await assertCapabilitySourceClosure(policy.sourcePins);
    return policy;
}
async function inputCommand(policy: ApplicationConsumerPolicy, input: ApplicationCapabilityInput): Promise<ApplicationUseCommand> {
    assertApplicationModelUse(input.model, input.check);
    const dependencies = applicationDependencies(input.model, input.check, input.originalParent);
    const profile = applicationProfileBinding(input.profile), request = ApplicationCapabilityRequestSchema.parse(input.request);
    if (input.model.scope.tenantId !== policy.tenantId || input.model.scope.principalId !== policy.principalId
        || input.originalParent.rightsRevision !== policy.rightsRef || profile.tenantId !== policy.tenantId
        || profile.principalId !== policy.principalId || profile.application !== input.model.scope.application
        || profile.account !== input.model.scope.account || !policy.profileBindingDigests.includes(digest(profile))
        || digest(input.model.ref) !== digest(policy.modelRef) || digest(input.check.ref) !== digest(policy.checkRef)
        || digest(input.originalParent.originalParentRef) !== digest(policy.originalParentRef)
        || digest(input.originalParent) !== policy.originalParentDigest
        || !input.profile.allowedTargets.includes(request.target.id)
        || request.target.application !== profile.application || request.target.account !== profile.account
        || new Set(request.operationIds).size !== request.operationIds.length
        || request.operationIds.some(id => !dependencies.operationBindings.some(operation =>
                operation.operationId === id && operation.role === profile.role
                    && (request.freshAuthorityRef || digest(operation.grantRef) === digest(profile.grantRef))))
        || Date.parse(request.deadlineAt) > Date.parse(input.originalParent.deadlineAt)
        || Date.parse(request.deadlineAt) > Date.parse(profile.validUntil)
        || Date.parse(request.deadlineAt) > Date.parse(policy.validUntil) || Date.parse(request.deadlineAt) <= Date.now()) {
        fault('S8_APPLICATION_CONSUMER_INPUT_BINDING', 403);
    }
    const scope = { semanticOwner: 'S8', tenantId: policy.tenantId, principalId: policy.principalId };
    const [fresh] = await Promise.all([
        request.freshAuthorityRef ? Promise.all([
            resolveEconomicOwnerReference(scope, policy.revisionRef, { purpose: 'CONSUMER', rightsRef: policy.rightsRef }),
            resolveEconomicOwnerReference(scope, request.freshAuthorityRef, { purpose: 'CONSUMER', rightsRef: policy.rightsRef }),
        ]) : Promise.resolve(null),
        assertNativeApplicationSources(input.originalParent, policy.sourceRoot, policy.sourcePins),
    ]);
    if (fresh && request.freshAuthorityRef) {
        const [candidateSource, handoff] = fresh;
        const candidate = parseApplicationCandidate({ ...candidateSource.reference.content, ref: policy.revisionRef });
        if (candidateSource.protectionDomain !== 'DISPOSABLE_TEST_AUTHORITY'
            || applicationDependencyDigest(candidate) !== policy.dependencyDigest
            || digest(candidate.modelRef) !== digest(input.model.ref) || digest(candidate.checkRef) !== digest(input.check.ref)
            || digest(candidate.originalParent) !== policy.originalParentDigest) fault('S8_APPLICATION_CONSUMER_CANDIDATE_SUBSTITUTION', 403);
        if (handoff.protectionDomain !== 'DISPOSABLE_TEST_AUTHORITY') fault('S8_APPLICATION_FRESH_AUTHORITY_DOMAIN', 403);
        assertApplicationFreshBinding(handoff.reference.content, request.freshAuthorityRef, {
            modelRef: input.model.ref, checkRef: input.check.ref, parent: input.originalParent, scope: input.model.scope,
            originalProfiles: candidate.profiles, profile, operationBindings: dependencies.operationBindings, request,
        });
    }
    return ApplicationUseCommandSchema.parse({
        revisionRef: policy.revisionRef, modelRef: input.model.ref, checkRef: input.check.ref,
        originalParentRef: input.originalParent.originalParentRef, originalParentDigest: digest(input.originalParent),
        profile, request,
    });
}
async function command(policy: ApplicationConsumerPolicy, operation: string, body: unknown, requestId: string): Promise<unknown> {
    const token = await privateFile(policy.tokenPath, 4096);
    if (byteDigest(token) !== policy.tokenHash || !/^[\x21-\x7e]{16,4096}$/.test(token.toString()))
        fault('S8_APPLICATION_CONSUMER_TOKEN_INVALID', 403);
    const response = await fetch(policy.endpoint + '/command', {
        method: 'POST', headers: { authorization: 'Bearer ' + token.toString(), 'content-type': 'application/json' },
        body: canonical({ operation, body, requestId }), redirect: 'error', credentials: 'omit',
        signal: AbortSignal.timeout(policy.timeoutMs),
    });
    const reader = response.body?.getReader();
    if (!reader) fault('S8_APPLICATION_EMPTY_RESPONSE', 503);
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
        for (;;) {
            const part = await reader.read(); if (part.done) break;
            bytes += part.value.length;
            if (bytes > 2 * 1024 * 1024) fault('S8_APPLICATION_RESPONSE_BOUND', 413);
            chunks.push(part.value);
        }
    } finally { await reader.cancel().catch(() => undefined); }
    const result: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!response.ok) {
        const failure = z.object({ code: z.string().regex(/^[A-Z0-9_]{1,128}$/) }).passthrough().safeParse(result);
        fault(failure.success ? failure.data.code : 'S8_APPLICATION_COMMAND_REFUSED', response.status);
    }
    return result;
}
async function committed(policy: ApplicationConsumerPolicy, ref: ApplicationPortRef, body: unknown, receipt: unknown) {
    const result = await resolveEconomicOwnerReference({
        semanticOwner: 'S8', tenantId: policy.tenantId, principalId: policy.principalId,
    }, ref, { purpose: 'CONSUMER', rightsRef: policy.rightsRef });
    if (result.protectionDomain !== 'DISPOSABLE_TEST_AUTHORITY' || digest(result.reference.content) !== digest(body)
        || digest(result.receipt) !== digest(receipt)) fault('S8_APPLICATION_CONSUMER_COMMITMENT_SUBSTITUTION', 403);
}
function leaseBinding(policy: ApplicationConsumerPolicy, input: ApplicationCapabilityInput, request: ApplicationUseCommand,
    lease: ApplicationCapabilityUseLease) {
    if (digest(lease.revisionRef) !== digest(policy.revisionRef) || digest(lease.modelRef) !== digest(input.model.ref)
        || digest(lease.checkRef) !== digest(input.check.ref) || digest(lease.originalParentRef) !== digest(input.originalParent.originalParentRef)
        || lease.originalParentDigest !== digest(input.originalParent) || lease.dependencyDigest !== policy.dependencyDigest
        || digest(lease.dependencies) !== digest(applicationDependencies(input.model, input.check, input.originalParent))
        || digest(lease.profile) !== digest(request.profile)
        || lease.requestBindingDigest !== applicationRequestBindingDigest(request.request)
        || lease.requestBindingDigest !== applicationRequestBindingDigest(lease.request)
        || lease.reservedCost !== request.request.reservedCost || Date.parse(lease.expiresAt) <= Date.now()
        || Date.parse(lease.expiresAt) > Date.parse(input.originalParent.deadlineAt)
        || Date.parse(lease.expiresAt) > Date.parse(request.request.deadlineAt)
        || Date.parse(lease.expiresAt) > Date.parse(request.profile.validUntil)
        || Date.parse(lease.expiresAt) > Date.parse(policy.validUntil)) fault('S8_APPLICATION_CONSUMER_LEASE_SUBSTITUTION', 403);
}
async function currentness(policy: ApplicationConsumerPolicy, input: ApplicationUseCommand,
    evidenceRefs: unknown, liabilityRefs: unknown) {
    const resolved = await resolveEconomicOwnerReference({
        semanticOwner: 'S8', tenantId: policy.tenantId, principalId: policy.principalId,
    }, input.request.currentnessRef, { purpose: 'CONSUMER', rightsRef: policy.rightsRef });
    const current = ApplicationCurrentnessBodySchema.parse(resolved.reference.content);
    const retainedLiabilities = X2RefSchema.array().parse(liabilityRefs);
    if (resolved.protectionDomain !== 'DISPOSABLE_TEST_AUTHORITY'
        || digest(input.request.currentnessRef) !== digest(x2Ref('S4', 'application-s8-currentness', current))
        || current.tenantId !== policy.tenantId || current.principalId !== policy.principalId
        || current.rightsRef !== policy.rightsRef || digest(current.modelRef) !== digest(input.modelRef)
        || digest(current.checkRef) !== digest(input.checkRef) || digest(current.originalParentRef) !== digest(input.originalParentRef)
        || current.dependencyDigest !== policy.dependencyDigest || current.profileBindingDigest !== digest(input.profile)
        || current.requestBindingDigest !== applicationRequestBindingDigest(input.request)
        || current.applicationRevision !== input.request.applicationRevision
        || Date.parse(current.checkedAt) > Date.now() || Date.parse(current.expiresAt) <= Date.now()
        || Date.parse(current.expiresAt) <= Date.parse(current.checkedAt)
        || Date.parse(current.expiresAt) - Date.parse(current.checkedAt) > policy.maxCurrentnessMs
        || Date.parse(current.expiresAt) > Date.parse(input.request.deadlineAt)
        || digest(evidenceRefs) !== digest(current.evidenceRefs)
        || input.request.freshAuthorityRef && !current.evidenceRefs.some(ref => digest(ref) === digest(input.request.freshAuthorityRef))
        || current.liabilityRefs.some(ref => !retainedLiabilities.some(r => digest(ref) === digest(r))))
        fault('S8_APPLICATION_CONSUMER_CURRENTNESS_SUBSTITUTION', 403);
    return current;
}
const useReplySchema = z.object({
    ref: ApplicationPortRefSchema, receipt: z.unknown(), lease: ApplicationUseLeaseSchema, ...flags,
}).strict();
/** Missing optional configuration returns null. Invalid configuration, absent
 * owner references or unadmitted models throw; none cause local self-admission. */
export async function acquireApplicationCapability(input: ApplicationCapabilityInput): Promise<ApplicationCapabilityUseLease | null> {
    const policy = await applicationConsumerPolicy({ ...input.model.scope, rightsRef: input.originalParent.rightsRevision });
    if (!policy) return null;
    const request = await inputCommand(policy, input);
    const reply = useReplySchema.parse(await command(policy, 'APPLICATION_USE', request, 'x2-use:' + input.request.requestId));
    leaseBinding(policy, input, request, reply.lease);
    if (digest(reply.lease.request) !== digest(request.request) || digest(reply.lease.currentnessRef) !== digest(input.request.currentnessRef)
        || digest(reply.ref) !== digest(applicationRef('use', reply.lease))) fault('S8_APPLICATION_CONSUMER_USE_IDENTITY', 403);
    const current = await currentness(policy, request, reply.lease.evidenceRefs, reply.lease.liabilityRefs);
    if (Date.parse(reply.lease.expiresAt) > Date.parse(current.expiresAt)) fault('S8_APPLICATION_CONSUMER_LEASE_EXPIRY', 403);
    await committed(policy, reply.ref, reply.lease, reply.receipt);
    return reply.lease;
}
const recheckReplySchema = z.object({
    ref: ApplicationPortRefSchema, receipt: z.unknown(), recheck: ApplicationRecheckBodySchema, ...flags,
}).strict();
/** Supply fresh native currentness in input.request before every consequential
 * boundary. A new stamp cannot extend the immutable lease/original deadline. */
export async function recheckApplicationCapability(input: ApplicationCapabilityInput,
    lease: ApplicationCapabilityUseLease, requestId = 'x2-recheck:' + randomUUID()): Promise<ApplicationCapabilityRecheckLease> {
    const policy = await applicationConsumerPolicy({ ...input.model.scope, rightsRef: input.originalParent.rightsRevision });
    if (!policy) fault('S8_APPLICATION_CONSUMER_POLICY_REMOVED', 403);
    ApplicationUseLeaseSchema.parse(lease);
    const request = await inputCommand(policy, input); leaseBinding(policy, input, request, lease);
    const reply = recheckReplySchema.parse(await command(policy, 'APPLICATION_RECHECK', {
        ...request, useId: lease.useId, leaseDigest: digest(lease),
    }, requestId));
    if (digest(reply.recheck.lease) !== digest(lease) || reply.recheck.leaseDigest !== digest(lease)
        || reply.recheck.useId !== lease.useId || digest(reply.recheck.currentnessRef) !== digest(input.request.currentnessRef)
        || digest(reply.ref) !== digest(applicationRef('recheck', reply.recheck))
        || Date.parse(reply.recheck.expiresAt) > Date.parse(lease.expiresAt) || Date.parse(reply.recheck.expiresAt) <= Date.now())
        fault('S8_APPLICATION_CONSUMER_RECHECK_SUBSTITUTION', 403);
    const [current] = await Promise.all([
        currentness(policy, request, reply.recheck.evidenceRefs, reply.recheck.liabilityRefs),
        committed(policy, reply.ref, reply.recheck, reply.receipt),
    ]);
    if (reply.recheck.checkedAt !== current.checkedAt || Date.parse(reply.recheck.expiresAt) > Date.parse(current.expiresAt))
        fault('S8_APPLICATION_CONSUMER_RECHECK_EXPIRY', 403);
    return { ...reply.recheck, ref: reply.ref };
}

const reconciliationReplySchema = z.object({
    ref: ApplicationPortRefSchema, receipt: z.unknown(), liabilityRefs: X2RefSchema.array().max(256),
    possibleEffectRefs: X2RefSchema.array().max(256), outcomeResolved: z.boolean(),
    liabilityBudgetReleased: z.literal(false), economicCreditGranted: z.literal(false), causalCreditGranted: z.literal(false),
    outcomeQualification: z.literal('REPORTED_NATIVE_TRANSITION_NO_NEW_BUSINESS_OR_ECONOMIC_AUTHORITY'), ...flags,
}).strict();
/** Original leased knowledge-use bookkeeping after native S6 observation.
 * No currentness refresh, new execution permission or liability release. */
export async function reconcileApplicationCapability(parent: OriginalApplicationParent, lease: ApplicationCapabilityUseLease,
    evidenceRef: ExperimentRef, priorEvidenceRef: ExperimentRef | null, outcome: 'OBSERVED' | 'UNKNOWN' | 'DECLINED') {
    ApplicationUseLeaseSchema.parse(lease);
    const policy = await applicationConsumerPolicy({ ...lease.profile, rightsRef: parent.rightsRevision });
    if (!policy) fault('S8_APPLICATION_CONSUMER_POLICY_REMOVED', 403);
    if (digest(lease.revisionRef) !== digest(policy.revisionRef) || digest(lease.modelRef) !== digest(policy.modelRef)
        || digest(lease.checkRef) !== digest(policy.checkRef) || digest(lease.originalParentRef) !== digest(parent.originalParentRef)
        || digest(lease.originalParentRef) !== digest(policy.originalParentRef) || lease.originalParentDigest !== digest(parent)
        || lease.originalParentDigest !== policy.originalParentDigest || lease.dependencyDigest !== policy.dependencyDigest)
        fault('S8_APPLICATION_CONSUMER_RECONCILIATION_SUBSTITUTION', 403);
    const input = ApplicationReconciliationSchema.parse({ useId: lease.useId, revisionRef: lease.revisionRef,
        evidenceRef, priorEvidenceRef, outcome });
    const reply = reconciliationReplySchema.parse(await command(policy, 'APPLICATION_RECONCILE', input,
        'x2-reconcile:' + digest(input)));
    if (digest(reply.ref) !== digest(applicationRef('reconciliation', input))
        || reply.outcomeResolved !== (outcome !== 'UNKNOWN')
        || !reply.liabilityRefs.some(ref => lease.liabilityRefs.some(original => digest(ref) === digest(original))))
        fault('S8_APPLICATION_CONSUMER_RECONCILIATION_SUBSTITUTION', 403);
    await committed(policy, reply.ref, input, reply.receipt);
    return reply;
}

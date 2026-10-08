/** Actual S5 consumer: exact authenticated lease, fresh bytes, explicit shadow. */
import { randomUUID } from 'node:crypto';
import { verify } from 'node:crypto';
import { z } from 'zod';
import type { CanonicalAllocationProblem } from '@finnor/shared-types';
import { canonical } from '../../governed-execution/src/protocol';
import { privateFile } from './journal';
import { byteDigest, digest, fault, AllocationMethodSchema, AllocationMethodAdmissionSchema, DomainSchema, RefSchema, type Signed } from './contracts';
import { verifyCapabilityLeaseMethod } from './protected-method';
import { CanaryUseSchema, CanaryLeaseSchema, verifyNativeCanaryLease } from './canary';
import type { CapabilityUseLease } from './lifecycle';
const ConsumerPolicySchema = z.object({ schema: z.literal('finnor.s8.consumer-policy.v1'), domain: z.enum(['DISPOSABLE_TEST_AUTHORITY', 'REVIEWED_PROTECTED_DOMAIN']), tenantId: z.string(), principalId: z.string(), rightsRef: z.string(), endpoint: z.string(), tokenPath: z.string(), tokenHash: z.string().regex(/^[a-f0-9]{64}$/), stratum: z.string(), reservedCost: z.number().finite().min(0), maxDecisionLoss: z.number().finite().min(0), canaryAssignment: CanaryUseSchema.pick({ assignmentGroupRef: true, assignmentRef: true, clusterId: true }).optional(), validAfter: z.string().datetime({ offset: true }), validUntil: z.string().datetime({ offset: true }), timeoutMs: z.number().int().min(100).max(10000) }).strict();
type ConsumerPolicy = z.infer<typeof ConsumerPolicySchema>;
const LeaseSchema = z.object({ schema: z.literal('finnor.s8.capability-use.v1'), useId: z.string(), revisionRef: RefSchema, payload: AllocationMethodSchema, domain: DomainSchema, activationRef: RefSchema, inputDigest: z.string().regex(/^[a-f0-9]{64}$/), generation: z.number().int().min(1), mode: z.enum(['SHADOW', 'CANARY', 'FULL']), maxDecisionLoss: z.number().finite().min(0), reservedCost: z.number().finite().min(0), expiresAt: z.string().datetime({ offset: true }), status: z.literal('PINNED_PENDING'), executionAuthorityGranted: z.literal(false), methodAdmission: AllocationMethodAdmissionSchema.optional(), canary: CanaryLeaseSchema.optional() }).strict();
async function currentMethod(p: ConsumerPolicy, lease: CapabilityUseLease) {
    if (lease.methodAdmission)
        await verifyCapabilityLeaseMethod({ tenantId: p.tenantId, principalId: p.principalId, rightsRef: p.rightsRef, protectionDomain: p.domain, lease });
    else if (p.domain === 'REVIEWED_PROTECTED_DOMAIN' || lease.mode !== 'SHADOW')
        fault('S8_PROTECTED_METHOD_ADMISSION_REQUIRED', 503);
}
async function currentCanary(p: ConsumerPolicy, problem: CanonicalAllocationProblem, lease: CapabilityUseLease) {
    if (!p.canaryAssignment && !lease.canary) return;
    if (!p.canaryAssignment || !lease.canary) fault('S8_CANARY_CONSUMER_ASSIGNMENT_REQUIRED');
    const { policyRefs, mandateRef, ...assignment } = lease.canary.binding;
    if (digest(assignment) !== digest(p.canaryAssignment) || digest(mandateRef) !== digest(problem.mandate.ref)
        || policyRefs.length !== problem.policies.length || policyRefs.some(ref => !problem.policies.some(policy => digest(ref) === digest(policy.ref))))
        fault('S8_CANARY_CONSUMER_INPUT_SUBSTITUTION');
    await verifyNativeCanaryLease({ tenantId: p.tenantId, principalId: p.principalId, rightsRef: p.rightsRef, protectionDomain: p.domain }, lease);
}
async function configuration(problem: CanonicalAllocationProblem): Promise<ConsumerPolicy | null> {
    const path = process.env.FINNOR_S8_CONSUMER_CONFIG;
    if (!path)
        return null;
    const root = process.env.FINNOR_S8_CONSUMER_ROOT;
    if (!root)
        fault('S8_CONSUMER_RELEASE_ROOT_UNAVAILABLE', 503);
    const signed = JSON.parse((await privateFile(path)).toString()) as Signed<ConsumerPolicy>, p = ConsumerPolicySchema.parse(signed.body);
    if (!verify(null, Buffer.from(canonical(p)), root, Buffer.from(signed.signature, 'base64')) || Date.now() < Date.parse(p.validAfter) || Date.now() >= Date.parse(p.validUntil))
        fault('S8_CONSUMER_POLICY_SIGNATURE_OR_EXPIRY', 403);
    if (p.tenantId !== problem.tenantId || p.principalId !== problem.principalId || p.rightsRef !== problem.mandate.rightsRef)
        fault('S8_CONSUMER_OWNER_OR_RIGHTS', 403);
    const url = new URL(p.endpoint);
    if (url.origin !== p.endpoint || url.username || url.password || !(url.protocol === 'https:' || p.domain === 'DISPOSABLE_TEST_AUTHORITY' && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
        fault('S8_CONSUMER_ENDPOINT_UNSUPPORTED', 403);
    return p;
}
async function command(p: ConsumerPolicy, operation: string, body: any, requestId = 's8-consumer:' + randomUUID()) {
    const token = await privateFile(p.tokenPath, 4096);
    if (byteDigest(token) !== p.tokenHash)
        fault('S8_CONSUMER_TOKEN_CHANGED', 403);
    const result = await fetch(p.endpoint + '/command', { method: 'POST', headers: { authorization: 'Bearer ' + token.toString(), 'content-type': 'application/json' }, body: canonical({ requestId, operation, body }), redirect: 'error', signal: AbortSignal.timeout(p.timeoutMs) });
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (!result.body)
        fault('S8_CONSUMER_EMPTY_RESPONSE');
    const reader = result.body.getReader();
    try {
        for (;;) {
            const r = await reader.read();
            if (r.done)
                break;
            bytes += r.value.length;
            if (bytes > 2 * 1024 * 1024)
                fault('S8_CONSUMER_RESPONSE_BOUND');
            chunks.push(r.value);
        }
    }
    finally {
        await reader.cancel();
    }
    const response = JSON.parse(Buffer.concat(chunks).toString());
    if (!result.ok)
        fault(response.code ?? 'S8_CONSUMER_REQUEST_DENIED', result.status);
    return response;
}
export async function acquireAllocationCapability(problem: CanonicalAllocationProblem): Promise<CapabilityUseLease | null> {
    const p = await configuration(problem);
    if (!p)
        return null;
    const reply = await command(p, 'USE', { tenantId: problem.tenantId, principalId: problem.principalId, rightsRef: problem.mandate.rightsRef, owner: 'S5', interface: problem.methodVersion, stratum: p.stratum, policyCount: problem.policies.length, periods: problem.mandate.horizon.periods, scenarios: problem.jointModel.scenarios.length, inputDigest: digest(problem), reservedCost: p.reservedCost, maxDecisionLoss: p.maxDecisionLoss, ...(p.canaryAssignment ? { canaryBinding: { ...p.canaryAssignment, policyRefs: problem.policies.map(policy => policy.ref), mandateRef: problem.mandate.ref } } : {}) });
    const lease = LeaseSchema.parse(reply.lease);
    if (lease.inputDigest !== digest(problem) || lease.domain.rightsRef !== problem.mandate.rightsRef || lease.domain.interface !== problem.methodVersion || lease.payload.maxPolicies < problem.policies.length || lease.domain.maxPolicies < problem.policies.length || lease.domain.maxPeriods < problem.mandate.horizon.periods || lease.domain.maxScenarios < problem.jointModel.scenarios.length || !lease.domain.strata.includes(p.stratum) || Date.parse(lease.domain.validAfter) > Date.now() || Date.parse(lease.domain.validUntil) <= Date.now() || Date.parse(lease.expiresAt) > Date.parse(lease.domain.validUntil) || Date.parse(lease.expiresAt) <= Date.now() || lease.reservedCost !== p.reservedCost || lease.maxDecisionLoss !== p.maxDecisionLoss)
        fault('S8_CONSUMER_LEASE_BINDING');
    if (lease.mode !== 'SHADOW')
        fault('S8_NATIVE_CANARY_AUTHORITY_UNAVAILABLE', 503);
    await currentMethod(p, lease);
    await currentCanary(p, problem, lease);
    return lease;
}
export async function recheckAllocationCapability(problem: CanonicalAllocationProblem, lease: CapabilityUseLease) {
    const p = await configuration(problem);
    if (!p)
        fault('S8_CONSUMER_POLICY_REMOVED');
    const result = await command(p, 'RECHECK', { useId: lease.useId, revisionRef: lease.revisionRef, inputDigest: digest(problem) });
    if (!result.current || digest(result.lease) !== digest(lease))
        fault('S8_CONSUMER_CURRENT_LEASE_SUBSTITUTION');
    await currentMethod(p, lease);
    await currentCanary(p, problem, lease);
    return true;
}

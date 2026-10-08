/** Ordinary method consumer. The independent S6 contract authenticates admission. */
import { resolveEconomicOwnerReference, verifyOwnerTransportCapabilityMethod } from '../../governed-execution/src/owner-transport';
import { AllocationMethodAdmissionSchema, digest, fault, parseRevision, sameRef, type AllocationMethodAdmission, type CapabilityRevision, type CapabilityRef } from './contracts';
import type { CapabilityUseLease } from './lifecycle';
export async function verifyCapabilityMethod(input: { revision: CapabilityRevision; evaluationRef: CapabilityRef; admissionRef: CapabilityRef; methodAdmission: AllocationMethodAdmission; protectionDomain: 'DISPOSABLE_TEST_AUTHORITY' | 'REVIEWED_PROTECTED_DOMAIN' }) {
    const { revision: r } = input, method = AllocationMethodAdmissionSchema.parse(input.methodAdmission), body = method.body;
    if (body.domain !== input.protectionDomain || body.tenantId !== r.tenantId || body.principalId !== r.principalId || body.rightsRef !== r.domain.rightsRef || !sameRef(body.revisionRef, r.ref) || !sameRef(body.evaluationRef, input.evaluationRef) || !sameRef(body.admissionRef, input.admissionRef) || body.payloadDigest !== digest(r.payload) || body.dependencyDigest !== digest(r.dependencies) || body.runtimeDigest !== digest(r.runtime) || body.validityDomainDigest !== digest(r.domain) || body.resourceEnvelopeDigest !== digest(r.envelope) || Date.parse(body.validAfter) < Date.parse(r.domain.validAfter) || Date.parse(body.validUntil) > Date.parse(r.domain.validUntil) || Date.parse(body.validAfter) > Date.now() || Date.parse(body.validUntil) <= Date.now())
        fault('S8_PROTECTED_METHOD_ADMISSION_BINDING_INVALID');
    return verifyOwnerTransportCapabilityMethod({ semanticOwner: 'S8', tenantId: r.tenantId, principalId: r.principalId }, { revisionRef: r.ref, methodAdmission: method });
}

/** Resolve original accepted preimages with read-only credentials at the consumer. */
export async function verifyCapabilityLeaseMethod(input: { tenantId: string; principalId: string; rightsRef: string; protectionDomain: 'DISPOSABLE_TEST_AUTHORITY' | 'REVIEWED_PROTECTED_DOMAIN'; lease: CapabilityUseLease }) {
    const { lease } = input, method = AllocationMethodAdmissionSchema.parse(lease.methodAdmission);
    const identity = { semanticOwner: 'S8', tenantId: input.tenantId, principalId: input.principalId };
    const revision = await resolveEconomicOwnerReference(identity, lease.revisionRef, { rightsRef: input.rightsRef });
    const r = parseRevision({ ...revision.reference.content, ref: lease.revisionRef });
    if (revision.protectionDomain !== input.protectionDomain || r.tenantId !== input.tenantId || r.principalId !== input.principalId || r.domain.rightsRef !== input.rightsRef || !sameRef(r.payload, lease.payload) || !sameRef(r.domain, lease.domain) || lease.maxDecisionLoss > r.envelope.maxDecisionLoss || lease.reservedCost > r.envelope.maxCost || Date.parse(lease.expiresAt) > Date.parse(method.body.validUntil))
        fault('S8_CONSUMER_PROTECTED_METHOD_LEASE_BINDING');
    const activation = await resolveEconomicOwnerReference(identity, lease.activationRef, { rightsRef: input.rightsRef }), a = activation.reference.content?.body;
    if (activation.protectionDomain !== input.protectionDomain || !a || !sameRef(a.revisionRef, r.ref) || !sameRef(a.methodAdmission, method) || a.mode !== lease.mode || lease.maxDecisionLoss > a.maxDecisionLoss || lease.reservedCost > a.maxCost || lease.expiresAt !== a.validUntil)
        fault('S8_CONSUMER_PROTECTED_ACTIVATION_BINDING');
    return verifyCapabilityMethod({ revision: r, evaluationRef: method.body.evaluationRef, admissionRef: method.body.admissionRef, methodAdmission: method, protectionDomain: input.protectionDomain });
}

import type { PeMutationContext } from '../types';
import type { ProcedureCapsule, ProcedureUse } from './contracts';
import { currentCapsule } from './store';

/** This cut's S8 only authenticates finite allocation/P5 payloads. Never route
 * capsules through that validator or accept caller-provided signatures. */
export function requireProcedureMode(use: ProcedureUse) {
  if (use.mode === 'protected') throw Error('S8_VERSIONED_PROCEDURE_ADMISSION_AND_USE_PORT_REQUIRED');
  if (process.env.NODE_ENV === 'production' || process.env.FINNOR_P4_PROFILE !== 'ordinary_disposable')
    throw Error('P6_ORDINARY_DISPOSABLE_PROFILE_REQUIRED');
}
export async function checkProcedureUse(ctx: PeMutationContext, use: ProcedureUse) {
  requireProcedureMode(use);
  const capsule = await currentCapsule(ctx, use.capsuleId);
  if (capsule.admission !== null) throw Error('P6_UNSUPPORTED_OR_FORGED_ADMISSION');
  return { capsule, mode: 'ORDINARY_TEST_ONLY' as const, admission: null, executionAuthorityGranted: false };
}
export function procedureAdmissionRequest(capsule: ProcedureCapsule) {
  return {
    schema: 'finnor.p6.s8-procedure-admission-request.v1', requestedPort: 's8-procedure-capsule-v1',
    capsuleId: capsule.id, module: capsule.module, parameters: capsule.parameters, returns: capsule.returns,
    domain: capsule.applicability, preconditions: capsule.preconditions,
    independentEvidence: capsule.independentTests, counterexamples: capsule.counterexamples,
    expectedResources: capsule.expectedResources, sourceCut: capsule.support.cutDigest,
    requiredOwnerDecisions: ['PERMITTED_PAYLOAD_AND_MODULE_REGISTRATION', 'INDEPENDENT_EVALUATOR_CUSTODY_AND_RESULTS',
      'EXACT_RELEASE_DOMAIN_SIGNATURE', 'NONREPLAYABLE_CURRENT_USE_LEASE_AND_REVOCATION',
      'ADMITTED_FALLBACK_AND_PRODUCER', 'S6_HOST_AND_RESOURCE_QUALIFICATION'],
    admission: null, evaluatorAuthorityGranted: false, status: 'PROPOSED_UNSUPPORTED_PORT',
  };
}

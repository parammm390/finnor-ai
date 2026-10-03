/** Ordinary request compiler. A proposal is never an admission or dispatch grant. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { DurableObligation, ExperimentRef, GovernedRequestIR, GovernedRequestBinding } from '@finnor/shared-types';
import { epistemicHash, immutableControl, AllocationContractError } from '@finnor/epistemic-runtime';

export async function compileGovernedRequestProposal(obligation: DurableObligation, bindings: GovernedRequestBinding[]) {
  const channels = obligation.intervention.channels;
  if (!channels.length || channels.length > 64 || bindings.length !== channels.length) {
    throw new AllocationContractError('INVALID_REQUEST', 'Exactly one concrete binding per authorized channel is required');
  }
  const byExposure = new Map(bindings.map(binding => [binding.exposureId, binding]));
  if (byExposure.size !== channels.length || new Set(channels.map(channel => channel.exposureId)).size !== channels.length) {
    throw new AllocationContractError('INVALID_REQUEST', 'Channel identities must be unique and exact');
  }
  const physicalFields = new Set<string>();
  const members = channels.map(channel => {
    const binding = byExposure.get(channel.exposureId);
    // A single conditional replacement cannot silently collapse a multi-period schedule.
    if (!binding || channel.doses.length !== 1 || channel.permittedRefinements.length !== 0) {
      throw new AllocationContractError('INVALID_REQUEST', 'The conditional replacement proposal requires an exact single-dose channel');
    }
    const targetKey = JSON.stringify([binding.providerOrigin, binding.applicationAccountId, binding.recordKey, binding.field]);
    if (physicalFields.has(targetKey)) throw new AllocationContractError('INVALID_REQUEST', 'Overlapping physical fields require a separately admitted batch contract');
    physicalFields.add(targetKey);
    return {
      memberId: `request-member:${epistemicHash([obligation.ref, channel.exposureId])}`,
      methodRef: binding.methodRef,
      semantic: {
        exposureId: channel.exposureId, target: channel.target, operation: channel.operation,
        unit: channel.unit, dose: channel.doses[0]!, intendedExposure: channel.intendedExposure,
        permittedRefinements: [] as [],
      },
      request: {
        kind: 'CONDITIONAL_JSON_FIELDS_REPLACE' as const,
        providerOrigin: binding.providerOrigin, applicationAccountId: binding.applicationAccountId,
        recordKey: binding.recordKey, expectedVersion: binding.expectedVersion,
        changes: { [binding.field]: channel.doses[0]! },
      },
    };
  });
  const sourcePaths = [fileURLToPath(import.meta.url)];
  const compiler = { version: 's6-conditional-json-v1' as const, sourceDigests: await Promise.all(sourcePaths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }))) };
  const ir: GovernedRequestIR = {
    schema: 'finnor.s6.request-ir.v1', tenantId: obligation.tenantId, principalId: obligation.principalId,
    episodeId: obligation.episodeId, obligationRef: obligation.ref, effectRef: obligation.effectRef,
    mandateRef: obligation.mandateRef, rightsRef: obligation.rightsRef, policyRef: obligation.policyRef,
    decisionRef: obligation.decisionRef, allocationRef: obligation.allocationRef, reservationRef: obligation.reservationRef,
    consumptionRef: obligation.consumptionRef, interventionRef: obligation.interventionRef,
    intervention: obligation.intervention, preconditions: obligation.preconditions, deadline: obligation.deadline,
    resourceEnvelope: obligation.resourceEnvelope, compiler, members,
  };
  if (Buffer.byteLength(JSON.stringify(ir)) > 2 * 1024 * 1024) throw new AllocationContractError('LIMIT_EXCEEDED', 'Request IR exceeds 2 MiB');
  const contentDigest = epistemicHash(ir);
  const ref: ExperimentRef = { owner: 'S6', id: `request-ir:${contentDigest}`, version: 's6-conditional-json-v1', contentDigest };
  return immutableControl({ status: 'REQUEST_PROPOSED_UNADMITTED' as const, ref, ir, executionAuthorityGranted: false as const, protectedReceipt: null });
}

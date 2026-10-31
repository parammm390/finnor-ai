import type { NativeCut } from './native-contracts.js';
import { nativeRef, same } from './native-contracts.js';
import type { PublishedProgram } from './owner.js';
import { boundedJSON, digest, requireZ1 } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts.js';

/** Complete original delivery identities, reused verbatim after a lost claim.
 * S8 and each original owner still control actual consumption. */
export function originalProjectionDeliveries(publication: PublishedProgram, cuts: readonly NativeCut[]) {
  requireZ1(same(publication.reference, nativeRef('S3', 'z1-checked-publication', publication.body)),
    'Z1_DELIVERY_PUBLICATION_PREIMAGE_REQUIRED', 'COUNTEREXAMPLE');
  const projections = publication.body.candidate.workProjections;
  requireZ1(cuts.length >= 2 && cuts.length <= 1000 && projections.length === cuts.length &&
    new Set(cuts.map(cut => cut.workId)).size === cuts.length &&
    new Set(projections.map(projection => projection.workId)).size === cuts.length,
  'Z1_COMPLETE_ORIGINAL_DELIVERY_COVERAGE_REQUIRED', 'COUNTEREXAMPLE');
  const originals = new Map(cuts.map(cut => [cut.workId, cut]));
  const records = [];
  for (const projection of projections) {
    const cut = originals.get(projection.workId);
    requireZ1(cut && projection.binding.original.id === cut.workId &&
      projection.binding.original.resources.parentReservationRef === cut.parent.id &&
      projection.binding.original.resources.remainingBudgetRef === cut.parent.contentDigest &&
      projection.binding.original.inputRef === cut.inputId &&
      projection.bindingDigest === digest(projection.binding),
    'Z1_ORIGINAL_DELIVERY_PARENT_BINDING_REQUIRED', 'COUNTEREXAMPLE');
    if (!projection.result || projection.lifecycle !== 'ACTIVE' || projection.disposition === 'REVOKED') continue;
    const body = { publicationRef: publication.reference, workId: projection.workId, bindingDigest: projection.bindingDigest,
      resultDigest: digest(projection.result), originalParent: cut.parent.id, pendingS8: true, executionAuthorityGranted: false };
    const reference = nativeRef('S3', 'z1-original-projection-delivery', body);
    records.push({ workId: projection.workId, reference, body });
  }
  boundedJSON(records, 8388608);
  return records;
}
export function originalProjectionJobs(publication: PublishedProgram, cuts: readonly NativeCut[],
  scope: { tenantId: string; principalId: string; requestId: string; generation: number }) {
  requireZ1(Number.isSafeInteger(scope.generation) && scope.generation > 0 &&
    publication.body.candidate.workProjections.every(projection =>
      projection.binding.original.partition.tenantId === scope.tenantId &&
      projection.binding.original.partition.principalId === scope.principalId),
  'Z1_ORIGINAL_JOB_SCOPE_REQUIRED', 'REVOKED');
  const records = originalProjectionDeliveries(publication, cuts).map(({ workId }) => ({
    key: `z1:${scope.tenantId}:${scope.requestId}:${scope.generation}:${workId}:${publication.reference.contentDigest}`,
    // Producer jobs cover the whole cohort. A consumer job acts on exactly one
    // original under its canonical request/generation and immutable publication.
    payload: { ...scope, workIds: [workId], workId, publication: publication.reference },
  }));
  boundedJSON(records, 8388608);
  return records;
}

import type { AllocationOutstandingCommitment } from '@finnor/shared-types';

/** Occupation, not the number of selectable S4 policies. This structural check
 * grants no authority: the S5 definer binds origins/certificates and confirms the
 * complete tenant population before the snapshot can be used for admission. */
export const Z1_PORTFOLIO = Object.freeze({ originals: 1000, other: 256, resources: 16, periods: 64 });
export function isZ1OriginalCommitment(row: AllocationOutstandingCommitment): boolean {
  const ref = row.reservationRef, certificate = row.certificateRef;
  return ref.owner === 'S5' && ref.version === 'z1-native-owner-v1' &&
    /^[a-f0-9]{64}$/.test(ref.contentDigest) && ref.id === `z1-original-budget:${ref.contentDigest}` &&
    certificate?.owner === 'S5' && certificate.version === ref.version &&
    /^[a-f0-9]{64}$/.test(certificate.contentDigest) &&
    certificate.id === `z1-original-certificate:${certificate.contentDigest}` &&
    row.policyRefs.length === 0 && row.effectRefs.length === 0 && row.envelopes.length === 4 &&
    new Set(row.envelopes.map(envelope => envelope.resourceId)).size === 4 &&
    ['RESERVED', 'CONSUMPTION_PENDING', 'UNKNOWN_OUTCOME', 'PARTIALLY_RECONCILED', 'SETTLED_RETAINED'].includes(row.status);
}
export function originalPortfolioPopulation(rows: readonly AllocationOutstandingCommitment[]) {
  let originals = 0, other = 0;
  const seen = new Set<string>();
  let valid = rows.length <= Z1_PORTFOLIO.originals + Z1_PORTFOLIO.other;
  for (const row of rows) {
    valid &&= !seen.has(row.reservationRef.id);
    seen.add(row.reservationRef.id);
    const native = isZ1OriginalCommitment(row);
    // A malformed native reference cannot masquerade as legacy occupation.
    if (row.reservationRef.id.startsWith('z1-original-budget:') && !native) valid = false;
    if (native) originals++; else other++;
  }
  return { originals, other, valid: valid && originals <= Z1_PORTFOLIO.originals && other <= Z1_PORTFOLIO.other };
}

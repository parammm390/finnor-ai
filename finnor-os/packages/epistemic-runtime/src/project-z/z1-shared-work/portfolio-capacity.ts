import type { AllocationOutstandingCommitment, AllocationResource } from '@finnor/shared-types';
import { boundedJSON, digest, requireZ1 } from './contracts.js';
import { originalPortfolioPopulation, Z1_PORTFOLIO } from './portfolio-population.js';

/** Linear fold over complete opaque originals, not aggregation into a new
 * reservation. Prefix and occupancy quantities keep their S5 meanings. */
export function originalPortfolioCapacity(resource: AllocationResource,
  outstanding: readonly AllocationOutstandingCommitment[], requested: string) {
  const population = originalPortfolioPopulation(outstanding);
  requireZ1(population.valid, 'Z1_COMPLETE_S5_POPULATION_BOUND', 'INCOMPLETE');
  const periods = resource.horizon.periods + 1;
  requireZ1(Number.isSafeInteger(periods) && periods >= 2 && periods <= Z1_PORTFOLIO.periods + 1 &&
    ['CUMULATIVE_EXPENDITURE', 'OCCUPANCY'].includes(resource.kind) &&
    resource.existingUse.length === periods && resource.availability.length === periods,
  'Z1_S5_COMPLETE_RESOURCE_PERIODS_REQUIRED', 'INCOMPLETE');
  const nonnegative = (value: string) => {
    requireZ1(/^(?:0|[1-9][0-9]{0,15})$/.test(value),
      'Z1_S5_NONNEGATIVE_INTEGER_OCCUPATION_REQUIRED', 'INCOMPLETE');
    return BigInt(value);
  };
  const use = resource.existingUse.map(nonnegative);
  const occupancy = resource.kind === 'OCCUPANCY';
  for (const held of outstanding) for (const envelope of held.envelopes) {
    if (envelope.resourceId !== resource.resourceId) continue;
    requireZ1(envelope.unit === resource.unit && envelope.kind === resource.kind &&
      digest(envelope.horizon) === digest(resource.horizon) && envelope.quantities.length === periods &&
      envelope.minimumQuantities.length === periods, 'Z1_S5_COMPLETE_SHARED_HORIZON_REQUIRED', 'INCOMPLETE');
    for (let period = 0; period < periods; period++) {
      const quantity = nonnegative(envelope.quantities[period]!), minimum = nonnegative(envelope.minimumQuantities[period]!);
      requireZ1(minimum <= quantity, 'Z1_S5_INVALID_OCCUPATION_INTERVAL', 'INCOMPLETE');
      use[period] = use[period]! + quantity;
    }
  }
  const request = nonnegative(requested), margin = nonnegative(resource.safetyMargin), occupation: string[] = [];
  let prefix = 0n;
  for (let period = 0; period < periods; period++) {
    prefix = occupancy ? use[period]! : prefix + use[period]!;
    const available = resource.availability[period]!;
    requireZ1(available.amount !== null && available.basis === 'REPORTED_AVAILABLE',
      'Z1_S5_AVAILABLE_CAPACITY_UNKNOWN', 'INCOMPLETE');
    requireZ1(prefix + request <= nonnegative(available.amount) - margin,
      'Z1_SHARED_S5_RESOURCE_EXHAUSTED', 'INCOMPLETE');
    occupation.push(String(prefix));
  }
  const proof = { population, resourceId: resource.resourceId, requested, occupation,
    originalReservationDigest: digest(outstanding), semantics: occupancy ? 'PER_PERIOD_OCCUPANCY' : 'CUMULATIVE_PREFIX' };
  boundedJSON(proof, 8388608);
  return proof;
}

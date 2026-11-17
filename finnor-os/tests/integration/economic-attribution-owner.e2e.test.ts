import { describe } from 'vitest';
import { registerEconomicAttributionProof } from './economic-attribution-owner-proof';

describe('S7 native economic attribution proofs', () => {
  registerEconomicAttributionProof('integrated');
  registerEconomicAttributionProof('owner');
  registerEconomicAttributionProof('protected');
  registerEconomicAttributionProof('maturity');
});

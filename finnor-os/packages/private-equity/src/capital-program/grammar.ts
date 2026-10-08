import { add, cmp, mul, type DecimalString } from "@finnor/underwriting";
import { CAPITAL_PROGRAM_LIMITS, CapitalProgramError, type CapitalCandidate, type EntityBindings,
  type NativeBase, type NumericGrid, type PermittedChanges } from "./contracts";

const lexical = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Bounded iteration is intentional: never convert an arbitrary financial range to Number. */
export function enumerateGrid(grid: NumericGrid): DecimalString[] {
  if (cmp(grid.step, "0") <= 0 || cmp(grid.minimum, grid.maximum) > 0) {
    throw new CapitalProgramError("INVALID_GRID", "Grid step must be positive and minimum must not exceed maximum");
  }
  const values: DecimalString[] = [];
  let value = grid.minimum;
  while (cmp(value, grid.maximum) <= 0) {
    if (values.length === CAPITAL_PROGRAM_LIMITS.gridValues) {
      throw new CapitalProgramError("GRID_LIMIT", "Permitted grid exceeds the registered hard ceiling");
    }
    values.push(value);
    const next = add(value, grid.step);
    if (cmp(next, value) <= 0) throw new CapitalProgramError("GRID_PRECISION", "Grid step does not advance at native decimal precision");
    value = next;
  }
  return values;
}

function requiredScalar(base: NativeBase, nodeId: string): string {
  const value = base.snapshot.values[nodeId]?.value;
  if (typeof value !== "string") throw new CapitalProgramError("MISSING_NATIVE_INPUT", `${nodeId} is not a known native scalar`);
  return value;
}
function periodDates(base: NativeBase): Array<{ id: string; end: string }> {
  const distribution = base.snapshot.values["distributions.interim"]?.value;
  if (!distribution || typeof distribution !== "object") throw new CapitalProgramError("MISSING_NATIVE_INPUT", "Native distribution series is required");
  return Object.keys(distribution).sort(lexical).map(id => ({ id, end: id.split(":")[2]! }));
}

export function validatePermittedChanges(base: NativeBase, entities: EntityBindings, policy: PermittedChanges): void {
  if (policy.currency !== base.config.currency) throw new CapitalProgramError("CURRENCY_MISMATCH", "Change policy must use the exact native currency and scale 1");
  const entryDate = requiredScalar(base, "entry.valuation_date");
  const exitPeriodId = requiredScalar(base, "exit.period_id");
  const periods = periodDates(base), exitDate = periods.find(period => period.id === exitPeriodId)?.end;
  if (!exitDate) throw new CapitalProgramError("MISSING_NATIVE_INPUT", "Exact native exit date is unavailable");
  for (const tranche of base.config.debtTranches) {
    if (!Object.hasOwn(entities.lenderByTranche, tranche.id)) {
      throw new CapitalProgramError("MISSING_ENTITY_BINDING", `Native tranche ${tranche.id} has no explicit lender identity`);
    }
  }
  if (policy.entryEnterpriseValue) enumerateGrid(policy.entryEnterpriseValue);
  const ids = new Set<string>();
  for (const option of policy.financing) {
    if (ids.has(option.id)) throw new CapitalProgramError("DUPLICATE_FINANCING_PERMISSION", "Financing permission IDs must be unique");
    ids.add(option.id);
    const principals = enumerateGrid(option.principal), rates = enumerateGrid(option.annualRate);
    if (rates.some(rate => cmp(rate, "1") > 0)) {
      throw new CapitalProgramError("RATE_UNIT_MISMATCH", "Annual contractual rates are fractions between zero and one, not percent values");
    }
    if (option.maturityDate < exitDate || option.maturityDate <= entryDate) {
      throw new CapitalProgramError("UNSUPPORTED_MATURITY", "This core supports fixed term maturities on or after native exit only");
    }
    const existing = base.config.debtTranches.find(tranche => tranche.id === option.trancheId);
    if (option.mode === "AMEND_FIXED_TERM") {
      if (!existing || existing.kind !== "term" || existing.rateType !== "fixed") {
        throw new CapitalProgramError("INVALID_FINANCING_TARGET", "Amendment must target an existing fixed term facility");
      }
      if (entities.lenderByTranche[option.trancheId] !== option.lenderEntityId) {
        throw new CapitalProgramError("LENDER_SUBSTITUTION_UNSUPPORTED", "Changing an existing lender requires a separate operative refinance grammar");
      }
      if (requiredScalar(base, `debt_input.${option.trancheId}.maturity_date`) !== option.maturityDate) {
        throw new CapitalProgramError("MATURITY_CHANGE_UNSUPPORTED", "Existing term amendments change only amount, rate and explicit fee");
      }
      if (cmp(option.replacedBaseFee, requiredScalar(base, "entry.financing_fees")) > 0) {
        throw new CapitalProgramError("FEE_ALLOCATION_MISMATCH", "Explicitly replaced fee cannot exceed the native total financing fee");
      }
    } else {
      if (existing || option.trancheId === "total" || base.config.debtTranches.length >= CAPITAL_PROGRAM_LIMITS.tranches) {
        throw new CapitalProgramError("INVALID_NEW_FACILITY", "New fixed term identity must be absent, nonreserved and within the final tranche bound");
      }
      if (cmp(option.replacedBaseFee, "0") !== 0 || principals.some(principal => cmp(principal, "0") <= 0)) {
        throw new CapitalProgramError("INVALID_NEW_FACILITY", "New financing requires positive principal and cannot remove an existing fee");
      }
      if (Object.hasOwn(entities.lenderByTranche, option.trancheId) && entities.lenderByTranche[option.trancheId] !== option.lenderEntityId) {
        throw new CapitalProgramError("ENTITY_BINDING_MISMATCH", "New financing lender differs from its supplied entity binding");
      }
    }
  }
  const timing = policy.interimDistribution;
  if (timing) {
    const source = periods.find(period => period.end === timing.fromDate);
    if (!source || timing.fromDate > exitDate || timing.fromDate <= entryDate) {
      throw new CapitalProgramError("INVALID_DISTRIBUTION_DATE", "Timing source must be an exact native period end through exit");
    }
    const distributions = base.snapshot.values["distributions.interim"]!.value as Record<string, string>;
    if (cmp(distributions[source.id]!, "0") <= 0) {
      throw new CapitalProgramError("MISSING_DISTRIBUTION", "Only an explicitly existing positive distribution may be relocated");
    }
    for (const date of timing.allowedDates) {
      if (!periods.some(period => period.end === date) || date > exitDate || date <= entryDate) {
        throw new CapitalProgramError("INVALID_DISTRIBUTION_DATE", "Timing target must be an exact native period end through exit");
      }
    }
  }
}

export function generateCapitalCandidates(base: NativeBase, entities: EntityBindings, policy: PermittedChanges): CapitalCandidate[] {
  validatePermittedChanges(base, entities, policy);
  const offers: Array<DecimalString | null> = [null, ...(policy.entryEnterpriseValue ? enumerateGrid(policy.entryEnterpriseValue) : [])];
  const financing: CapitalCandidate["financing"][] = [null];
  for (const option of [...policy.financing].sort((left, right) => lexical(left.id, right.id))) {
    for (const principal of enumerateGrid(option.principal)) for (const fixedAnnualRate of enumerateGrid(option.annualRate)) {
      financing.push({
        optionId: option.id, mode: option.mode, trancheId: option.trancheId, principal,
        fixedAnnualRate, upfrontFee: mul(principal, option.upfrontFeeFraction),
      });
    }
  }
  const timing: Array<string | null> = [null, ...(policy.interimDistribution ?
    [...new Set(policy.interimDistribution.allowedDates)].sort(lexical) : [])];
  const generatedCount = offers.length * financing.length * timing.length;
  if (generatedCount > CAPITAL_PROGRAM_LIMITS.generatedDescriptors) {
    throw new CapitalProgramError("GENERATION_LIMIT", "Finite Cartesian grammar exceeds the registered descriptor ceiling");
  }
  const candidates: CapitalCandidate[] = [{ entryEnterpriseValue: null, financing: null, distributionDate: null }];
  for (const entryEnterpriseValue of offers) for (const loan of financing) for (const distributionDate of timing) {
    candidates.push({ entryEnterpriseValue, financing: loan, distributionDate });
  }
  return candidates;
}

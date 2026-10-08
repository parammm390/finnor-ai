import {
  add, assertSnapshotMatchesModel, canonicalSerialize, cmp, compileUnderwritingModel, createStandardLboModel,
  decimal, deepFreeze, div, executeUnderwritingModel, mul, parseDateOnly, sealInputSnapshot, semanticHash, sub,
  type CompiledUnderwritingModel, type DecimalString, type ModelValue, type ResolvedInput,
  type StandardLboModelConfig, type UnderwritingInputSnapshot,
} from "@finnor/underwriting";
import {
  CAPITAL_PROGRAM_LIMITS, CAPITAL_PROGRAM_VERSION, MANDATORY_CAPITAL_PROGRAM_OWNERS, CapitalProgramError,
  NativeConfigSchema, NativeSnapshotSchema, ownerBindingBlockers,
  type CapitalCandidate, type CapitalProgram, type CapitalProgramRequest, type EntityBindings,
  type NativeBase, type NativeCompilation, type NativeEconomics, type PermittedChanges,
  type SemanticChange, type SemanticPreimage,
} from "./contracts";

export interface ConstructedNativeCandidate {
  config: StandardLboModelConfig;
  snapshot: Readonly<UnderwritingInputSnapshot>;
  semanticPreimage: SemanticPreimage;
  semanticDigest: string;
  semanticChanges: SemanticChange[];
  implementationCost: DecimalString;
}
export interface CompiledNativeCandidate extends ConstructedNativeCandidate {
  compiled: CompiledUnderwritingModel;
  compilation: NativeCompilation;
}
const lexical = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
function scalar(snapshot: UnderwritingInputSnapshot, nodeId: string): DecimalString {
  const value = snapshot.values[nodeId]?.value;
  if (typeof value !== "string") throw new CapitalProgramError("MISSING_NATIVE_INPUT", `${nodeId} must be a known native scalar`);
  return decimal(value);
}
function text(snapshot: UnderwritingInputSnapshot, nodeId: string): string {
  const value = snapshot.values[nodeId]?.value;
  if (typeof value !== "string") throw new CapitalProgramError("MISSING_NATIVE_INPUT", `${nodeId} must be a known native string`);
  return value;
}
function series(snapshot: UnderwritingInputSnapshot, nodeId: string): Record<string, DecimalString> {
  const value = snapshot.values[nodeId]?.value;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CapitalProgramError("MISSING_NATIVE_INPUT", `${nodeId} must be an exact native series`);
  }
  return Object.fromEntries(Object.entries(value).map(([periodId, amount]) => [periodId, decimal(String(amount))]));
}

/** Reconstitute and validate real native preimages, not an owner/admission lookalike. */
export function prepareNativeBase(configInput: unknown, snapshotInput: unknown): Readonly<NativeBase> {
  const configResult = NativeConfigSchema.safeParse(configInput);
  if (!configResult.success) throw new CapitalProgramError("INVALID_NATIVE_CONFIG", configResult.error.message);
  const config: StandardLboModelConfig = configResult.data;
  if (config.entryValuationMethod !== "direct_enterprise_value" || config.revenueMethod !== "explicit" ||
      config.ebitdaMethod !== "explicit" || config.dAndATreatment !== "ebitda_equals_ebit" ||
      config.capexMethod !== "explicit" || config.workingCapitalMethod !== "explicit_nwc" ||
      config.debtTranches.some(tranche => tranche.id === "total" || tranche.kind !== "term" ||
        tranche.rateType !== "fixed" || tranche.interestBasis !== "beginning_balance" ||
        tranche.amortization !== "explicit_amount" || tranche.cashSweepEligible ||
        tranche.maturityTreatment !== "mandatory_repayment")) {
    throw new CapitalProgramError("UNSUPPORTED_NATIVE_DOMAIN",
      "Core v1 supports direct EV, explicit operations, fixed beginning-balance term debt, no sweep/PIK/amortization and no pre-exit maturity");
  }
  const snapshotResult = NativeSnapshotSchema.safeParse(snapshotInput);
  if (!snapshotResult.success) throw new CapitalProgramError("INVALID_NATIVE_SNAPSHOT", snapshotResult.error.message);
  const bytes = Buffer.byteLength(canonicalSerialize({ config, snapshot: snapshotResult.data }), "utf8");
  if (bytes > CAPITAL_PROGRAM_LIMITS.nativeBaseBytes) throw new CapitalProgramError("NATIVE_BASE_LIMIT", "Native base exceeds its registered byte ceiling");
  const snapshot = sealInputSnapshot(snapshotResult.data);
  const compiled = compileUnderwritingModel(createStandardLboModel(config));
  const inputIds = compiled.model.nodes.filter(node => node.kind === "input").map(node => node.id).sort(lexical);
  if (canonicalSerialize(inputIds) !== canonicalSerialize(Object.keys(snapshot.values).sort(lexical))) {
    throw new CapitalProgramError("NATIVE_INPUT_MEMBERSHIP_MISMATCH", "Base contains missing or extraneous native inputs");
  }
  for (const input of Object.values(snapshot.values)) {
    if (input.status !== "KNOWN" || input.truthClass === "UNKNOWN") {
      throw new CapitalProgramError(input.truthClass === "UNKNOWN" ? "UNKNOWN_INPUT" : `${input.status}_INPUT`,
        `${input.nodeId}: unresolved truth cannot be reconstituted as a construction base`);
    }
    if (input.valueType === "date") {
      if (typeof input.value !== "string") throw new CapitalProgramError("INVALID_NATIVE_DATE", "Native date must be scalar");
      parseDateOnly(input.value);
    }
  }
  assertSnapshotMatchesModel(compiled, snapshot);
  const entryDate = text(snapshot, "entry.valuation_date"), exitId = text(snapshot, "exit.period_id");
  const exit = compiled.periods.at(-1)!;
  if (exitId !== exit.id || entryDate >= compiled.periods[0]!.startDate) {
    throw new CapitalProgramError("UNSUPPORTED_NATIVE_TIMELINE", "Entry must precede forecast and exit must be the final native period");
  }
  for (const nodeId of ["cash.sweep_percentage", "entry.rollover_equity", "ownership.other"]) {
    if (cmp(scalar(snapshot, nodeId), "0") !== 0) throw new CapitalProgramError("UNSUPPORTED_NATIVE_DOMAIN", `${nodeId} must be zero in core v1`);
  }
  if (cmp(scalar(snapshot, "ownership.sponsor"), "1") !== 0) {
    throw new CapitalProgramError("UNSUPPORTED_NATIVE_DOMAIN", "Core v1 requires 100% sponsor ownership");
  }
  for (const tranche of config.debtTranches) {
    const prefix = `debt_input.${tranche.id}.`;
    if (cmp(scalar(snapshot, `${prefix}cash_interest_share`), "1") !== 0 ||
        cmp(scalar(snapshot, `${prefix}pik_interest_share`), "0") !== 0 ||
        Object.values(series(snapshot, `${prefix}mandatory_amortization_amount`)).some(amount => cmp(amount, "0") !== 0) ||
        text(snapshot, `${prefix}maturity_date`) < exit.endDate) {
      throw new CapitalProgramError("UNSUPPORTED_NATIVE_DOMAIN", "Debt must be cash-interest only, zero-amortizing and mature on/after exit");
    }
  }
  const body = {
    schema: "finnor.m3.immutable-native-base.v1" as const, source: "INDEPENDENT_NATIVE_CORE" as const,
    config: structuredClone(config), snapshot: structuredClone(snapshot),
  };
  return deepFreeze({ ...body, digest: semanticHash(body) });
}

export function validateNativeBase(input: unknown): Readonly<NativeBase> {
  if (!input || typeof input !== "object") throw new CapitalProgramError("MISSING_NATIVE_BASE", "An exact immutable independent native base is required");
  const body = input as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== "config,digest,schema,snapshot,source" ||
      body.schema !== "finnor.m3.immutable-native-base.v1" || body.source !== "INDEPENDENT_NATIVE_CORE") {
    throw new CapitalProgramError("INVALID_NATIVE_BASE", "Native base schema or exact field membership differs");
  }
  const prepared = prepareNativeBase(body.config, body.snapshot);
  if (body.digest !== prepared.digest) throw new CapitalProgramError("NATIVE_BASE_HASH_MISMATCH", "Base content differs from its immutable pin");
  return prepared;
}

export function constructNativeCandidate(
  base: NativeBase, entities: EntityBindings, permitted: PermittedChanges,
  candidate: CapitalCandidate, request: CapitalProgramRequest,
): ConstructedNativeCandidate {
  const config = structuredClone(base.config);
  const values = structuredClone(base.snapshot.values) as Record<string, ResolvedInput>;
  const changes: SemanticChange[] = [];
  let offerChanged = false, financingChanged = false, timingChanged = false;
  const entryDate = text(base.snapshot, "entry.valuation_date");
  const common = { agreement: "PROPOSED" as const, response: "UNKNOWN" as const };
  function override(nodeId: string, value: ModelValue): void {
    const prior = values[nodeId];
    if (!prior) throw new CapitalProgramError("INVALID_NATIVE_OVERRIDE", `${nodeId} is not a native input`);
    if (canonicalSerialize(prior.value) === canonicalSerialize(value)) return;
    values[nodeId] = {
      ...prior, value, truthClass: "SCENARIO_OVERRIDE", status: "KNOWN",
      reason: "Numerical PROPOSED hypothetical only; agreement and counterparty response remain unresolved",
    };
  }
  function money(term: SemanticChange["term"], entityId: string, before: string | null, after: string, instrumentId?: string): void {
    if (before !== null && cmp(before, after) === 0) return;
    changes.push({ term, entityId, effectiveDate: entryDate, unit: "MONEY",
      currency: config.currency, scale: "1", before, after, ...(instrumentId ? { instrumentId } : {}), ...common });
  }
  if (candidate.entryEnterpriseValue !== null) {
    const before = scalar(base.snapshot, "entry.enterprise_value");
    offerChanged = cmp(before, candidate.entryEnterpriseValue) !== 0;
    override("entry.enterprise_value", candidate.entryEnterpriseValue);
    money("ENTRY_ENTERPRISE_VALUE", entities.acquiredEntityId, before, candidate.entryEnterpriseValue);
  }
  const loan = candidate.financing;
  if (loan) {
    const permission = permitted.financing.find(option => option.id === loan.optionId);
    if (!permission || permission.mode !== loan.mode || permission.trancheId !== loan.trancheId) {
      throw new CapitalProgramError("INVALID_FINANCING_CANDIDATE", "Candidate differs from the finite permitted financing rule");
    }
    const prefix = `debt_input.${loan.trancheId}.`;
    const lender = permission.lenderEntityId;
    if (loan.mode === "ADD_FIXED_TERM") {
      const priority = Math.max(0, ...config.debtTranches.map(tranche => Math.max(tranche.seniority, tranche.sweepPriority))) + 1;
      config.debtTranches = [...config.debtTranches, {
        id: loan.trancheId, name: `Proposed fixed term ${loan.trancheId}`, kind: "term",
        seniority: priority, sweepPriority: priority, rateType: "fixed", interestBasis: "beginning_balance",
        amortization: "explicit_amount", cashSweepEligible: false, maturityTreatment: "mandatory_repayment",
      }];
      const inputNodes = createStandardLboModel(config).nodes.filter(node => node.kind === "input" && node.id.startsWith(prefix));
      const zeroSeries = Object.fromEntries(Object.keys(series(base.snapshot, "distributions.interim")).map(periodId => [periodId, decimal("0")]));
      const fields: Record<string, ModelValue> = {
        opening_principal: loan.principal, fixed_rate: loan.fixedAnnualRate, cash_interest_share: decimal("1"),
        pik_interest_share: decimal("0"), mandatory_amortization_amount: zeroSeries, maturity_date: permission.maturityDate,
      };
      for (const node of inputNodes) {
        const field = node.id.slice(prefix.length), value = fields[field];
        if (value === undefined) throw new CapitalProgramError("UNSUPPORTED_NATIVE_MAPPING", `${node.id} lacks an actual typed input mapping`);
        values[node.id] = {
          nodeId: node.id, valueType: node.valueType, unit: node.unit, shape: node.shape,
          ...(node.currency ? { currency: node.currency } : {}), value,
          truthClass: "SCENARIO_OVERRIDE", status: "KNOWN", provenance: [],
          reason: "New hypothetical proposed facility; no lender agreement or funding evidence",
        };
      }
      changes.push({ term: "FIXED_TERM_FACILITY", entityId: lender, instrumentId: loan.trancheId,
        effectiveDate: entryDate, unit: "FACILITY", before: null, after: "ADD_FIXED_TERM", ...common });
      money("FINANCING_PRINCIPAL", lender, null, loan.principal, loan.trancheId);
      changes.push({ term: "FIXED_ANNUAL_RATE", entityId: lender, instrumentId: loan.trancheId,
        effectiveDate: entryDate, unit: "FRACTION_PER_YEAR", before: null, after: loan.fixedAnnualRate, ...common });
      financingChanged = true;
    } else {
      const priorPrincipal = scalar(base.snapshot, `${prefix}opening_principal`);
      const priorRate = scalar(base.snapshot, `${prefix}fixed_rate`);
      financingChanged = cmp(priorPrincipal, loan.principal) !== 0 || cmp(priorRate, loan.fixedAnnualRate) !== 0;
      override(`${prefix}opening_principal`, loan.principal);
      override(`${prefix}fixed_rate`, loan.fixedAnnualRate);
      money("FINANCING_PRINCIPAL", lender, priorPrincipal, loan.principal, loan.trancheId);
      if (cmp(priorRate, loan.fixedAnnualRate) !== 0) {
        changes.push({ term: "FIXED_ANNUAL_RATE", entityId: lender, instrumentId: loan.trancheId,
          effectiveDate: entryDate, unit: "FRACTION_PER_YEAR", before: priorRate, after: loan.fixedAnnualRate, ...common });
      }
    }
    const baseFees = scalar(base.snapshot, "entry.financing_fees");
    const fees = add(sub(baseFees, permission.replacedBaseFee), loan.upfrontFee);
    financingChanged = financingChanged || cmp(baseFees, fees) !== 0;
    override("entry.financing_fees", fees);
    money("FINANCING_UPFRONT_FEE", lender, permission.replacedBaseFee, loan.upfrontFee, loan.trancheId);
    money("FINANCING_FEES_TOTAL", entities.sponsorEntityId, baseFees, fees);
  }
  if (candidate.distributionDate !== null && permitted.interimDistribution) {
    const rule = permitted.interimDistribution;
    const before = series(base.snapshot, "distributions.interim");
    const sourceId = Object.keys(before).find(periodId => periodId.split(":")[2] === rule.fromDate)!;
    const targetId = Object.keys(before).find(periodId => periodId.split(":")[2] === candidate.distributionDate)!;
    if (sourceId !== targetId) {
      const after = { ...before };
      after[sourceId] = decimal("0");
      after[targetId] = add(before[targetId]!, before[sourceId]!);
      override("distributions.interim", after);
      changes.push({ term: "INTERIM_DISTRIBUTION_DATE", entityId: entities.sponsorEntityId,
        effectiveDate: candidate.distributionDate, unit: "DATE", before: rule.fromDate, after: candidate.distributionDate,
        amount: before[sourceId]!, currency: config.currency, scale: "1", ...common });
      timingChanged = true;
    }
  }
  const snapshot = sealInputSnapshot({
    schemaVersion: base.snapshot.schemaVersion, investmentCaseId: base.snapshot.investmentCaseId,
    worldAt: base.snapshot.worldAt, values,
  });
  const { modelKey: _modelKey, modelVersion: _modelVersion, inputBindings: _bindings,
    debtTranches: tranches, ...nativeConventions } = config;
  const semanticPreimage: SemanticPreimage = {
    schema: "finnor.m3.capital-economics.v1", baseDigest: base.digest,
    investmentCaseId: snapshot.investmentCaseId, worldAt: snapshot.worldAt, entities: structuredClone(entities),
    nativeConventions: {
      ...nativeConventions,
      debtTranches: [...tranches].sort((left, right) => lexical(left.id, right.id)).map(({ name: _name, ...tranche }) => tranche),
    },
    inputs: Object.fromEntries(Object.entries(snapshot.values).map(([nodeId, value]) => [nodeId, {
      valueType: value.valueType, unit: value.unit, ...(value.currency ? { currency: value.currency } : {}),
      shape: value.shape, value: value.value,
    }])),
  };
  return {
    config, snapshot, semanticPreimage, semanticDigest: semanticHash(semanticPreimage), semanticChanges: changes,
    implementationCost: add(offerChanged ? request.costs.offerChange : "0",
      financingChanged ? request.costs.financingChange : "0", timingChanged ? request.costs.distributionTimingChange : "0"),
  };
}

/** Graph/module identities are minted only from this actual native compiler invocation. */
export function compileNativeCandidate(candidate: ConstructedNativeCandidate): CompiledNativeCandidate {
  const compiled = compileUnderwritingModel(createStandardLboModel(candidate.config));
  assertSnapshotMatchesModel(compiled, candidate.snapshot);
  const modulePreimage: NativeCompilation["modulePreimage"] = {
    schema: "finnor.m3.native-module.v1", configPreimage: candidate.config, modelPreimage: compiled.model,
    snapshotPreimage: candidate.snapshot, nativeModelDigest: compiled.semanticHash, nativeInputDigest: candidate.snapshot.semanticHash!,
  };
  const graphPreimage: NativeCompilation["graphPreimage"] = {
    schema: "finnor.m3.native-graph.v1", qualification: "NATIVE_DECLARED_GRAPH_NOT_COMPLETE_RUNTIME_DEPENDENCIES",
    nativeModelDigest: compiled.semanticHash, dependencyGraph: compiled.dependencyGraph, executionOrder: compiled.executionOrder,
  };
  return { ...candidate, compiled, compilation: {
    moduleDigest: semanticHash(modulePreimage), modulePreimage, graphDigest: semanticHash(graphPreimage), graphPreimage,
    declaredWorkUnits: compiled.model.nodes.length * (compiled.periods.length + 1),
  } };
}

export function executeNativeCandidate(candidate: CompiledNativeCandidate, request: CapitalProgramRequest): CapitalProgram {
  const nativeRun = executeUnderwritingModel(candidate.compiled, candidate.snapshot);
  let economics: NativeEconomics | null = null;
  if (nativeRun.status === "SUCCEEDED" && nativeRun.validity === "VALID" && nativeRun.sponsorCashFlows) {
    const cashFlows = nativeRun.sponsorCashFlows.map(flow => ({ amount: flow.amount, date: flow.date, periodId: flow.periodId ?? null }));
    let denominator = decimal("1"), discounted = decimal("0");
    // Compute sequential discounting without binary floating point or rate powers.
    for (const flow of cashFlows) {
      discounted = add(discounted, div(flow.amount, denominator));
      denominator = mul(denominator, add("1", request.objective.discountFraction));
    }
    const nativeScalar = (nodeId: string): DecimalString => decimal(String(nativeRun.values[nodeId]!.value));
    const nativeSeries = (nodeId: string): Record<string, DecimalString> =>
      Object.fromEntries(Object.entries(nativeRun.values[nodeId]!.value as Record<string, string>).map(([id, value]) => [id, decimal(value)]));
    economics = {
      entryEnterpriseValue: nativeScalar("transaction.entry_enterprise_value"),
      financingFees: scalar(candidate.snapshot, "entry.financing_fees"),
      sponsorEquity: nativeScalar("sources_uses.sponsor_equity"), exitEquity: nativeScalar("exit.equity_value"),
      cashByPeriod: nativeSeries("cash.ending"), cashInterestByPeriod: nativeSeries("debt.total.cash_interest"),
      sponsorCashFlows: cashFlows, discountedSponsorCashFlow: discounted, implementationCost: candidate.implementationCost,
      localValueBeforeSearchCost: sub(discounted, candidate.implementationCost),
    };
  }
  return deepFreeze({
    schema: "finnor.capital-program.v1", producerVersion: CAPITAL_PROGRAM_VERSION,
    state: "PROPOSED", resolution: "BLOCKED", source: "INDEPENDENT_NATIVE_CORE",
    agreement: "PROPOSED", response: "UNKNOWN", semanticDigest: candidate.semanticDigest,
    semanticPreimage: candidate.semanticPreimage, semanticChanges: candidate.semanticChanges,
    compilation: candidate.compilation, nativeRun, economics,
    ownerRefs: Object.fromEntries(MANDATORY_CAPITAL_PROGRAM_OWNERS.map(owner => [owner, null])) as CapitalProgram["ownerRefs"],
    blockers: ownerBindingBlockers(), executionAuthorityGranted: false, reservations: [],
  });
}

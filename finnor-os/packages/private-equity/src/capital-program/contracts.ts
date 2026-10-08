import { z } from "zod";
import { cmp, decimal, type DecimalString, type ModelValue, type StandardLboModelConfig,
  type UnderwritingInputSnapshot, type UnderwritingModelIR, type UnderwritingRunResult } from "@finnor/underwriting";

export const CAPITAL_PROGRAM_VERSION = "finnor-m3-native-construction/1.0.0" as const;
export const CAPITAL_PROGRAM_LIMITS = Object.freeze({
  gridValues: 16, financingAlternatives: 4, periods: 24, tranches: 8,
  generatedDescriptors: 4096, attempts: 4096, nativeExecutions: 1024,
  workUnits: 2_000_000, nativeBaseBytes: 2 * 1024 * 1024,
});

export class CapitalProgramError extends Error {
  constructor(readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CapitalProgramError";
  }
}

const text = z.string().min(1).max(256);
const trancheId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);
export const DecimalSchema = z.string().min(1).max(128).refine(value => {
  try { decimal(value); return true; } catch { return false; }
}, "An exact finite unformatted decimal string is required").transform(decimal);
export const NonnegativeDecimalSchema = DecimalSchema.refine(value => cmp(value, "0") >= 0);
export const FractionSchema = NonnegativeDecimalSchema.refine(value => cmp(value, "1") <= 0);
export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, "An exact valid civil date is required");
const GridSchema = z.object({
  minimum: NonnegativeDecimalSchema, maximum: NonnegativeDecimalSchema,
  step: NonnegativeDecimalSchema.refine(value => cmp(value, "0") > 0),
}).strict();

export const CapitalProgramRequestSchema = z.object({
  schema: z.literal("finnor.m3.capital-program-request.v1"),
  baseDigest: hash,
  objective: z.object({
    kind: z.literal("DISCOUNTED_SPONSOR_CASH_FLOW_DEV"),
    discountFraction: FractionSchema,
    discountUnit: z.literal("FRACTION_PER_NATIVE_PERIOD"),
    minimumNetImprovement: NonnegativeDecimalSchema,
  }).strict(),
  costs: z.object({
    currency, scale: z.literal("1"),
    perNativeExecution: NonnegativeDecimalSchema, offerChange: NonnegativeDecimalSchema,
    financingChange: NonnegativeDecimalSchema, distributionTimingChange: NonnegativeDecimalSchema,
  }).strict(),
  budget: z.object({
    maxAttempts: z.number().int().min(1).max(CAPITAL_PROGRAM_LIMITS.attempts),
    maxNativeExecutions: z.number().int().min(1).max(CAPITAL_PROGRAM_LIMITS.nativeExecutions),
    maxWorkUnits: z.number().int().min(1).max(CAPITAL_PROGRAM_LIMITS.workUnits),
  }).strict(),
}).strict();
export type CapitalProgramRequest = z.infer<typeof CapitalProgramRequestSchema>;
export function parseCapitalProgramRequest(input: unknown): CapitalProgramRequest {
  const parsed = CapitalProgramRequestSchema.safeParse(input);
  if (!parsed.success) throw new CapitalProgramError("INVALID_REQUEST", parsed.error.message);
  return parsed.data;
}

const FinancingSchema = z.object({
  id: text, mode: z.enum(["AMEND_FIXED_TERM", "ADD_FIXED_TERM"]),
  trancheId, lenderEntityId: text, principal: GridSchema, annualRate: GridSchema,
  upfrontFeeFraction: FractionSchema, replacedBaseFee: NonnegativeDecimalSchema,
  maturityDate: DateSchema,
}).strict();
export const PermittedChangesSchema = z.object({
  currency, scale: z.literal("1"), entryEnterpriseValue: GridSchema.optional(),
  financing: z.array(FinancingSchema).max(CAPITAL_PROGRAM_LIMITS.financingAlternatives),
  interimDistribution: z.object({
    fromDate: DateSchema, allowedDates: z.array(DateSchema).min(1).max(CAPITAL_PROGRAM_LIMITS.periods),
  }).strict().optional(),
}).strict();
export type NumericGrid = z.infer<typeof GridSchema>;
export type FinancingPermission = z.infer<typeof FinancingSchema>;
export type PermittedChanges = z.infer<typeof PermittedChangesSchema>;
export const EntityBindingsSchema = z.object({
  acquiredEntityId: text, sponsorEntityId: text, lenderByTranche: z.record(text),
}).strict();
export type EntityBindings = z.infer<typeof EntityBindingsSchema>;
export const ConstructionContextSchema = z.object({
  schema: z.literal("finnor.m3.native-construction-context.v1"),
  source: z.literal("INDEPENDENT_NATIVE_CORE"),
  base: z.unknown().nullable(), entities: EntityBindingsSchema, permitted: PermittedChangesSchema,
}).strict();

const SolverSchema = z.object({
  algorithm: z.literal("fixed_point"), initialState: z.enum(["opening_balance", "zero"]),
  absoluteTolerance: NonnegativeDecimalSchema, relativeTolerance: NonnegativeDecimalSchema,
  maxIterations: z.number().int().min(1).max(200),
}).strict();
const BindingSchema = z.object({
  kind: z.enum(["p1_assumption", "evidence_version", "artifact_anchor", "explicit", "model_parameter"]),
  assumptionId: text.optional(), evidenceVersionId: text.optional(), documentId: text.optional(),
  documentVersionId: text.optional(), anchorId: text.optional(), anchorHash: text.optional(),
  valuePath: text.optional(), valueSelector: text.optional(), staleAfterDays: z.number().int().nonnegative().optional(),
}).strict();
export const NativeConfigSchema = z.object({
  modelKey: text.optional(), modelVersion: text, currency,
  periodDefinition: z.object({
    frequency: z.enum(["annual", "quarterly", "monthly"]), forecastStart: DateSchema,
    count: z.number().int().min(1).max(CAPITAL_PROGRAM_LIMITS.periods),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  }).strict(),
  entryValuationMethod: z.enum(["direct_enterprise_value", "metric_multiple"]),
  revenueMethod: z.enum(["explicit", "growth"]), ebitdaMethod: z.enum(["explicit", "margin"]),
  dAndATreatment: z.enum(["explicit", "ebitda_equals_ebit"]),
  capexMethod: z.enum(["explicit", "percent_revenue"]),
  workingCapitalMethod: z.enum(["explicit_nwc", "percent_revenue"]),
  debtTranches: z.array(z.object({
    id: trancheId, name: text, kind: z.enum(["term", "revolver", "seller_note"]),
    seniority: z.number().int().nonnegative(), sweepPriority: z.number().int().nonnegative(),
    rateType: z.enum(["fixed", "floating"]), interestBasis: z.enum(["beginning_balance", "average_balance"]),
    amortization: z.enum(["original_principal_percent", "explicit_amount"]),
    cashSweepEligible: z.boolean(), maturityTreatment: z.enum(["mandatory_repayment", "unsupported"]),
  }).strict()).max(CAPITAL_PROGRAM_LIMITS.tranches),
  solver: SolverSchema.optional(), inputBindings: z.record(BindingSchema).optional(),
}).strict();
const ProvenanceSchema = z.object({
  kind: z.enum(["p1_assumption", "evidence_version", "model_parameter", "human_input", "artifact_anchor", "evidence_derivation"]),
  id: text, versionId: text.optional(), anchorId: text.optional(), semanticHash: text.optional(),
  effectiveAt: text.optional(), observedAt: text.optional(), retrievedAt: text.optional(),
}).strict();
const ScalarSchema = z.union([z.string().max(512), z.boolean()]);
export const NativeSnapshotSchema = z.object({
  schemaVersion: z.literal("underwriting-input-snapshot.v1"), investmentCaseId: text,
  worldAt: z.string().datetime({ offset: true }), semanticHash: hash.optional(),
  values: z.record(z.object({
    nodeId: text, valueType: z.enum(["decimal", "date", "boolean", "text"]),
    unit: z.enum(["money", "rate", "multiple", "ratio", "count", "date", "period", "boolean", "text"]),
    currency: currency.optional(), shape: z.enum(["scalar", "series"]),
    value: z.union([ScalarSchema, z.record(ScalarSchema), z.null()]),
    truthClass: z.enum(["OBSERVED_FACT", "CANONICAL_ASSUMPTION", "MODEL_PARAMETER", "SCENARIO_OVERRIDE", "DERIVED_VALUE", "EXTERNAL_CALCULATED_COMPARISON", "UNKNOWN"]),
    status: z.enum(["KNOWN", "UNKNOWN", "STALE", "CONFLICTING", "UNSUPPORTED"]),
    provenance: z.array(ProvenanceSchema).max(32), reason: z.string().max(2000).optional(),
  }).strict()),
}).strict();

export interface NativeBase {
  schema: "finnor.m3.immutable-native-base.v1";
  source: "INDEPENDENT_NATIVE_CORE";
  config: StandardLboModelConfig;
  snapshot: UnderwritingInputSnapshot;
  digest: string;
}
export interface NativeConstructionContext {
  schema: "finnor.m3.native-construction-context.v1";
  source: "INDEPENDENT_NATIVE_CORE";
  base: Readonly<NativeBase> | null;
  entities: EntityBindings;
  permitted: PermittedChanges;
}
export interface FinancingCandidate {
  optionId: string;
  mode: FinancingPermission["mode"];
  trancheId: string;
  principal: DecimalString;
  fixedAnnualRate: DecimalString;
  upfrontFee: DecimalString;
}
export interface CapitalCandidate {
  entryEnterpriseValue: DecimalString | null;
  financing: FinancingCandidate | null;
  distributionDate: string | null;
}
export interface SemanticChange {
  term: "ENTRY_ENTERPRISE_VALUE" | "FIXED_TERM_FACILITY" | "FINANCING_PRINCIPAL" |
    "FIXED_ANNUAL_RATE" | "FINANCING_UPFRONT_FEE" | "FINANCING_FEES_TOTAL" | "INTERIM_DISTRIBUTION_DATE";
  entityId: string;
  instrumentId?: string;
  effectiveDate: string;
  unit: "MONEY" | "FRACTION_PER_YEAR" | "DATE" | "FACILITY";
  currency?: string;
  scale?: "1";
  before: string | null;
  after: string;
  amount?: DecimalString;
  agreement: "PROPOSED";
  response: "UNKNOWN";
}
export const MANDATORY_CAPITAL_PROGRAM_OWNERS = ["WORK", "M1", "S1", "S3", "S4", "S5", "P1", "P3", "S6", "M4"] as const;
export type CapitalProgramOwner = typeof MANDATORY_CAPITAL_PROGRAM_OWNERS[number] | "P4" | "M3";
export interface CapitalProgramBlocker { owner: CapitalProgramOwner; code: string; reason: string; ref: null }
export interface SemanticPreimage {
  schema: "finnor.m3.capital-economics.v1";
  baseDigest: string;
  investmentCaseId: string;
  worldAt: string;
  entities: EntityBindings;
  nativeConventions: Omit<StandardLboModelConfig, "modelKey" | "modelVersion" | "inputBindings" | "debtTranches"> & {
    debtTranches: Array<Omit<StandardLboModelConfig["debtTranches"][number], "name">>;
  };
  inputs: Record<string, { valueType: string; unit: string; currency?: string; shape: string; value: ModelValue | null }>;
}
export interface NativeCompilation {
  moduleDigest: string;
  modulePreimage: {
    schema: "finnor.m3.native-module.v1";
    configPreimage: StandardLboModelConfig;
    modelPreimage: Readonly<UnderwritingModelIR>;
    snapshotPreimage: Readonly<UnderwritingInputSnapshot>;
    nativeModelDigest: string;
    nativeInputDigest: string;
  };
  graphDigest: string;
  graphPreimage: {
    schema: "finnor.m3.native-graph.v1";
    qualification: "NATIVE_DECLARED_GRAPH_NOT_COMPLETE_RUNTIME_DEPENDENCIES";
    nativeModelDigest: string;
    dependencyGraph: Readonly<Record<string, readonly string[]>>;
    executionOrder: readonly string[];
  };
  declaredWorkUnits: number;
}
export interface NativeEconomics {
  entryEnterpriseValue: DecimalString;
  financingFees: DecimalString;
  sponsorEquity: DecimalString;
  exitEquity: DecimalString;
  cashByPeriod: Record<string, DecimalString>;
  cashInterestByPeriod: Record<string, DecimalString>;
  sponsorCashFlows: Array<{ amount: DecimalString; date: string; periodId: string | null }>;
  discountedSponsorCashFlow: DecimalString;
  implementationCost: DecimalString;
  localValueBeforeSearchCost: DecimalString;
}
export interface CapitalProgram {
  schema: "finnor.capital-program.v1";
  producerVersion: typeof CAPITAL_PROGRAM_VERSION;
  state: "PROPOSED";
  resolution: "BLOCKED";
  source: "INDEPENDENT_NATIVE_CORE";
  agreement: "PROPOSED";
  response: "UNKNOWN";
  semanticDigest: string;
  semanticPreimage: SemanticPreimage;
  semanticChanges: SemanticChange[];
  compilation: NativeCompilation;
  nativeRun: Readonly<UnderwritingRunResult>;
  economics: NativeEconomics | null;
  ownerRefs: Record<typeof MANDATORY_CAPITAL_PROGRAM_OWNERS[number], null>;
  blockers: CapitalProgramBlocker[];
  executionAuthorityGranted: false;
  reservations: [];
}
export interface CapitalAttempt {
  index: number;
  isIncumbent: boolean;
  candidate: CapitalCandidate;
  semanticDigest: string | null;
  disposition: "EVALUATED" | "FAILED" | "REJECTED" | "DUPLICATE";
  duplicateOf: number | null;
  reason: string | null;
  declaredEvaluationCost: DecimalString;
  program: CapitalProgram | null;
}
export interface CapitalProgramSearchResult {
  schema: "finnor.m3.capital-program-search.v1";
  producerVersion: typeof CAPITAL_PROGRAM_VERSION;
  source: "INDEPENDENT_NATIVE_CORE";
  qualification: "H0_DEV_H1_FIXTURE_ONLY";
  status: "COMPLETE_DEV" | "PARTIAL_DEV" | "BLOCKED_INPUT";
  resolution: "BLOCKED";
  requestDigest: string;
  baseDigest: string | null;
  attempts: CapitalAttempt[];
  counts: { evaluated: number; failed: number; rejected: number; duplicate: number };
  costs: {
    nativeExecutions: number;
    declaredWorkUnits: number;
    declaredEvaluationLiability: DecimalString;
    actualMoney: null;
    accounting: "DECLARED_DEV_COSTS_ACTUAL_MONEY_UNMETERED";
    setupAndCompilationCost: "UNMETERED";
  };
  selection: {
    incumbentAttempt: 0;
    bestFiniteAttempt: number;
    selectedAttempt: number;
    costAdjustedImprovement: DecimalString;
    selectedNetChangeVsUnsearchedIncumbent: DecimalString;
    utilityOwner: "S4_UNBOUND_LOCAL_SURROGATE_ONLY";
  } | null;
  gap: {
    finiteDomainComplete: boolean;
    remainingGeneratedDescriptors: number | null;
    stopReason: string | null;
    externalOptimalityBound: null;
    globalOptimalityClaimed: false;
  };
  blockers: CapitalProgramBlocker[];
  executionAuthorityGranted: false;
}

export function ownerBindingBlockers(): CapitalProgramBlocker[] {
  return MANDATORY_CAPITAL_PROGRAM_OWNERS.map(owner => ({
    owner, code: `${owner}_AUTHENTIC_BINDING_MISSING`,
    reason: `No authentic ${owner} owner binding exists in the independent native core; local compilation supplies no admission or authority.`,
    ref: null,
  }));
}

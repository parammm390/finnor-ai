import { z } from "zod";

/** Ordinary R4 declarations. None of these input types is a protected receipt. */
export const R4_PROFILE = "R4_OBSERVATIONAL_ADMG_ID_IDC_V1" as const;
export const R4_LIMITS = {
  bundles: 8, graphs: 8, nodes: 12, edges: 132, laws: 32, costItems: 64,
  resources: 64, inputBytes: 512 * 1024, outputBytes: 64 * 1024 * 1024,
  astNodes: 65536, traceNodes: 4096, recursion: 96, digits: 256,
  nativeMs: 20000, episodeMs: 3600000, memoryBytes: 512 * 1024 * 1024,
} as const;

const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/);
const coordinate = z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const text = z.string().min(1).max(2000);
const unit = z.string().min(1).max(64);
export const IdentificationRationalSchema = z.object({
  numerator: z.string().regex(/^(0|[1-9][0-9]{0,255})$/),
  denominator: z.string().regex(/^[1-9][0-9]{0,255}$/),
}).strict();
export type IdentificationRational = z.infer<typeof IdentificationRationalSchema>;
const fraction = IdentificationRationalSchema;
const time = z.object({ start: z.string().datetime(), end: z.string().datetime() }).strict();
const scope = z.object({
  population: id, intervention: id, time, units: z.record(unit),
}).strict();
const premise = z.object({
  status: z.enum(["SATISFIED", "UNKNOWN", "CONTRADICTED", "UNSUPPORTED"]),
  basis: text, reason: text,
}).strict();
const premises = z.object({
  positivity: premise, denominator: premise, selection: premise,
  missingness: premise, measurement: premise, linkage: premise,
}).strict();
export const IdentificationLawSchema = z.object({
  id, kind: z.enum(["OBSERVATIONAL_JOINT", "EXPERIMENTAL", "TRANSPORT", "SELECTED"]),
  variables: z.array(coordinate).min(1).max(12), scope, premises,
  sourceRefs: z.array(id).min(1).max(32),
  rowLinkage: z.enum(["SINGLE_COHORT_JOINT", "WITNESSED_MARGINAL", "UNKNOWN"]),
  availability: z.enum(["OBSERVED", "PROSPECTIVE"]),
}).strict();
export const IdentificationGraphSchema = z.object({
  id, nodes: z.array(coordinate).min(1).max(12),
  directed: z.array(z.tuple([coordinate, coordinate])).max(132),
  bidirected: z.array(z.tuple([coordinate, coordinate])).max(66),
  observedNodes: z.array(coordinate).min(1).max(12),
  projection: z.enum(["NONE", "UNQUALIFIED_INDUCED_SUBGRAPH"]),
  assumptionBasis: z.literal("OWNER_DECLARED_UNADMITTED"),
}).strict();
const costBasis = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/), unit, valuationAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ownerShare: fraction, horizon: time, discount: text,
}).strict();
export const IdentificationBundleSchema = z.object({
  id, laws: z.array(IdentificationLawSchema).min(1).max(32), costItemIds: z.array(id).max(64),
  admissibility: z.object({
    rights: z.enum(["PERMITTED", "REJECTED", "UNKNOWN"]),
    s2: z.enum(["PERMITTED", "REJECTED", "UNKNOWN"]),
    privacy: z.enum(["PERMITTED", "REJECTED", "UNKNOWN"]),
    staffing: z.enum(["PERMITTED", "REJECTED", "UNKNOWN"]),
  }).strict(),
  schedule: z.object({ after: z.array(id).max(8), earliestStart: fraction, duration: fraction }).strict(),
  resources: z.array(z.object({ id, quantity: fraction }).strict()).max(64), exposure: fraction,
}).strict();
export const IdentificationProblemSchema = z.object({
  schema: z.literal("finnor.identification-problem.v1"), profile: z.literal(R4_PROFILE),
  query: z.object({
    id, outcomes: z.array(coordinate).min(1).max(12), treatments: z.array(coordinate).max(12),
    conditions: z.array(coordinate).max(12), scope, estimandRef: id,
  }).strict(),
  variables: z.array(z.object({ id: coordinate, unit }).strict()).min(1).max(64),
  graphs: z.array(IdentificationGraphSchema).min(1).max(8),
  baseline: z.array(IdentificationLawSchema).max(32), bundles: z.array(IdentificationBundleSchema).max(8),
  costItems: z.array(z.object({ id, amount: fraction.nullable(), basis: costBasis }).strict()).max(64),
  constraints: z.object({
    costBasis, scheduleUnit: z.literal("second"), resourceOrder: z.array(id).max(64),
    resources: z.array(z.object({ id, unit, capacity: fraction.nullable() }).strict()).max(64),
    exposureLimit: fraction.nullable(), collectBy: fraction,
  }).strict(),
  identities: z.object({ domain: id, owners: id, method: id, checker: id }).strict(),
}).strict();
export type IdentificationProblem = z.infer<typeof IdentificationProblemSchema>;
export type IdentificationLaw = z.infer<typeof IdentificationLawSchema>;
export type IdentificationGraph = z.infer<typeof IdentificationGraphSchema>;
export type IdentificationBundle = z.infer<typeof IdentificationBundleSchema>;

export type IdentificationExpression =
  | { op: "one" }
  | { op: "probability"; law: string; variables: string[]; given: string[] }
  | { op: "product"; terms: IdentificationExpression[] }
  | { op: "sum"; variables: string[]; expression: IdentificationExpression }
  | { op: "ratio"; numerator: IdentificationExpression; denominator: IdentificationExpression };

export interface IdentificationPlan {
  schema: "finnor.identification-plan.v1";
  targetQuery: IdentificationProblem["query"];
  selected: null | {
    mask: number; bundleIds: string[]; totalCost: IdentificationRational;
    completion: IdentificationRational; schedule: unknown; resourceUse: unknown;
  };
  alternatives: unknown[];
  identification: "CONDITIONAL" | "INVARIANT" | "UNIDENTIFIED" | "UNKNOWN";
  commonFunctional: { status: "PROVED" | "NOT_PROVED"; basis: string; premises: string[] };
  pairs: Array<{
    mask: number; graphId: string; structural: string; data: string; sufficient: boolean;
    proofId: string | null; lawId: string | null; reasons: string[]; conditions: unknown[];
    expression: IdentificationExpression | null;
  }>;
  masks: unknown[];
  minimality: { status: "PROVED" | "UNKNOWN"; masks: number; pairs: number; unresolvedMasks: number[]; basis: string };
  assumptions: string[];
  basis: "MODEL_RELATIVE_EXACT";
  graphTruthEstablished: false; effectEstimate: null; attributionGranted: false;
  executionAuthorityGranted: false; admission: null;
}

export interface IdentificationRunResponse {
  schema: "finnor.r4.run-response.v1";
  status: "COMPLETE" | "INCOMPLETE" | "INFEASIBLE" | "UNSUPPORTED" | "INVALIDATED" | "UNKNOWN";
  runId: string; artifact_ref: unknown | null; incumbent_ref: unknown | null;
  unresolved_claim_refs: string[]; resource_receipt_refs: string[];
}

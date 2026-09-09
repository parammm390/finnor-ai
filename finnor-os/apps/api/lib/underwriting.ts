import { ArtifactError } from "@finnor/artifacts";
import {
  PeDomainError,
  UnderwritingError,
  type PeMutationContext,
} from "@finnor/private-equity";
import type { TenantContext } from "@finnor/shared-types";
import { z } from "zod";
import { artifactErrorResponse, boundedJson } from "./artifacts";
import { errorResponse } from "./auth";

export const UnderwritingUuidSchema = z.string().uuid();
export const UnderwritingDecimalSchema = z.string().min(1).max(128).regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/);
const boundedText = z.string().trim().min(1).max(240);
const semanticHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const anchorHash = z.string().regex(/^[0-9a-f]{64}$/);
const modelScalar = z.union([z.string().max(4_096), z.boolean()]);
export const UnderwritingModelValueSchema = z.union([
  modelScalar,
  z.record(modelScalar).superRefine((value, context) => {
    if (Object.keys(value).length > 240) context.addIssue({ code: z.ZodIssueCode.too_big, maximum: 240, type: "array", inclusive: true, message: "Series exceeds 240 values" });
  }),
]);

const InputSourceBindingSchema = z.object({
  kind: z.enum(["p1_assumption", "evidence_version", "artifact_anchor", "explicit", "model_parameter"]),
  assumptionId: UnderwritingUuidSchema.optional(),
  evidenceVersionId: UnderwritingUuidSchema.optional(),
  documentId: UnderwritingUuidSchema.optional(),
  documentVersionId: UnderwritingUuidSchema.optional(),
  anchorId: z.string().min(1).max(2_048).optional(),
  anchorHash: anchorHash.optional(),
  valuePath: z.string().regex(/^[A-Za-z0-9_.-]{1,240}$/).optional(),
  valueSelector: z.string().min(1).max(240).optional(),
  staleAfterDays: z.number().int().min(0).max(36_500).optional(),
}).strict();

const NodeSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_.:-]{0,199}$/),
  kind: z.enum(["input", "constant", "expression", "series", "schedule", "aggregate", "check", "output"]),
  valueType: z.enum(["decimal", "date", "boolean", "text"]),
  unit: z.enum(["money", "rate", "multiple", "ratio", "count", "date", "period", "boolean", "text"]),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  shape: z.enum(["scalar", "series"]),
  dependencies: z.array(z.string().min(1).max(200)).max(10_000),
  source: InputSourceBindingSchema.optional(),
}).passthrough();

const SolverSettingsSchema = z.object({
  algorithm: z.literal("fixed_point"),
  initialState: z.enum(["opening_balance", "zero"]),
  absoluteTolerance: UnderwritingDecimalSchema,
  relativeTolerance: UnderwritingDecimalSchema,
  maxIterations: z.number().int().min(1).max(200),
}).strict();

export const UnderwritingModelDefinitionSchema = z.object({
  schemaVersion: z.literal("underwriting-model-ir.v1"),
  modelKey: z.string().regex(/^[a-z][a-z0-9_.:-]{0,99}$/),
  modelVersion: z.string().trim().min(1).max(80),
  financialConventionVersion: z.string().trim().min(1).max(120),
  minimumEngineVersion: z.string().trim().min(1).max(120),
  periodDefinition: z.object({
    frequency: z.enum(["annual", "quarterly", "monthly"]),
    forecastStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    count: z.number().int().min(1).max(240),
    fiscalYearStartMonth: z.number().int().min(1).max(12).optional(),
  }).strict(),
  nodes: z.array(NodeSchema).min(1).max(10_000),
  circularBlocks: z.array(z.object({
    id: z.string().min(1).max(200),
    nodeIds: z.array(z.string().min(1).max(200)).min(2).max(10_000),
    iterationOrder: z.array(z.string().min(1).max(200)).min(2).max(10_000),
    settings: SolverSettingsSchema,
  }).strict()).max(100),
  runtime: z.record(z.unknown()).optional(),
  metadata: z.record(z.union([z.string(), z.boolean(), z.number().finite()])).optional(),
}).strict();

const ProvenanceSchema = z.object({
  kind: z.enum(["p1_assumption", "evidence_version", "model_parameter", "human_input", "artifact_anchor"]),
  id: z.string().min(1).max(2_048),
  versionId: z.string().min(1).max(2_048).optional(),
  anchorId: z.string().min(1).max(2_048).optional(),
  semanticHash: z.string().min(1).max(160).optional(),
  effectiveAt: z.string().datetime({ offset: true }).optional(),
  observedAt: z.string().datetime({ offset: true }).optional(),
  retrievedAt: z.string().datetime({ offset: true }).optional(),
}).strict();

const ExplicitInputSchema = z.object({
  value: UnderwritingModelValueSchema.nullable(),
  truthClass: z.enum(["OBSERVED_FACT", "CANONICAL_ASSUMPTION", "MODEL_PARAMETER"]),
  status: z.enum(["KNOWN", "UNKNOWN", "STALE", "CONFLICTING", "UNSUPPORTED"]).optional(),
  provenance: z.array(ProvenanceSchema).max(32).optional(),
  reason: z.string().max(1_000).optional(),
}).strict();

const ScenarioOverrideSchema = z.object({
  nodeId: z.string().min(1).max(200),
  value: UnderwritingModelValueSchema,
  reason: z.string().max(1_000).optional(),
}).strict();

export const UnderwritingCreateModelSchema = z.object({
  investmentCaseId: UnderwritingUuidSchema,
  modelKey: z.string().regex(/^[a-z][a-z0-9_.:-]{0,99}$/),
  name: boundedText,
}).strict();

export const UnderwritingCreateModelVersionSchema = z.object({
  definition: UnderwritingModelDefinitionSchema,
  parentVersionId: UnderwritingUuidSchema.optional(),
}).strict();

export const UnderwritingCreateScenarioSchema = z.object({
  investmentCaseId: UnderwritingUuidSchema,
  modelVersionId: UnderwritingUuidSchema,
  parentScenarioId: UnderwritingUuidSchema.optional(),
  scenario: z.object({
    schemaVersion: z.literal("underwriting-scenario.v1"),
    name: boundedText,
    parentScenarioId: UnderwritingUuidSchema.optional(),
    overrides: z.array(ScenarioOverrideSchema).max(100),
    semanticHash: semanticHash.optional(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.parentScenarioId !== value.scenario.parentScenarioId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "parentScenarioId must match inside and outside the immutable scenario definition" });
  }
});

export const UnderwritingCreateRunSchema = z.object({
  investmentCaseId: UnderwritingUuidSchema,
  modelVersionId: UnderwritingUuidSchema,
  worldAt: z.string().datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(1).max(240),
  scenarioId: UnderwritingUuidSchema.optional(),
  workId: UnderwritingUuidSchema.optional(),
  explicitInputs: z.record(ExplicitInputSchema).optional(),
}).strict();

const SensitivityAxisSchema = z.object({
  nodeId: z.string().min(1).max(200),
  values: z.array(UnderwritingModelValueSchema).min(1).max(2_500),
  label: z.string().max(240).optional(),
}).strict();

export const UnderwritingCreateSensitivitySchema = z.object({
  baseRunId: UnderwritingUuidSchema,
  idempotencyKey: z.string().trim().min(1).max(180),
  definition: z.object({
    schemaVersion: z.literal("underwriting-sensitivity.v1"),
    name: boundedText,
    rowAxis: SensitivityAxisSchema,
    columnAxis: SensitivityAxisSchema.optional(),
    outputNodeIds: z.array(z.string().min(1).max(200)).min(1).max(100),
  }).strict(),
}).strict().superRefine((value, context) => {
  const cells = value.definition.rowAxis.values.length * (value.definition.columnAxis?.values.length ?? 1);
  if (cells > 2_500) context.addIssue({ code: z.ZodIssueCode.too_big, maximum: 2_500, type: "array", inclusive: true, message: "Sensitivity exceeds 2,500 cells" });
});

export const UnderwritingComparisonPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("EXACT_DECIMAL") }).strict(),
  z.object({ mode: z.literal("DECLARED_ROUNDED_VALUE"), decimalPlaces: z.number().int().min(0).max(34) }).strict(),
  z.object({ mode: z.literal("EXPLICIT_ABSOLUTE_TOLERANCE"), tolerance: UnderwritingDecimalSchema }).strict(),
  z.object({ mode: z.literal("EXPLICIT_RELATIVE_TOLERANCE"), tolerance: UnderwritingDecimalSchema }).strict(),
]);

export const UnderwritingCreateArtifactBindingSchema = z.object({
  investmentCaseId: UnderwritingUuidSchema,
  modelVersionId: UnderwritingUuidSchema,
  documentId: UnderwritingUuidSchema,
  documentVersionId: UnderwritingUuidSchema,
  direction: z.enum(["input", "output"]),
  bindingMode: z.enum(["read_only", "write_and_compare", "compare_only"]),
  modelNodeId: z.string().min(1).max(200),
  anchorId: z.string().min(1).max(2_048),
  anchorHash,
  valueSelector: z.string().min(1).max(240).optional(),
  comparisonPolicy: UnderwritingComparisonPolicySchema.optional(),
  supersedesBindingId: UnderwritingUuidSchema.optional(),
}).strict();

export const UnderwritingProjectionSchema = z.object({
  runId: UnderwritingUuidSchema,
  documentId: UnderwritingUuidSchema,
  baseVersionId: UnderwritingUuidSchema,
  idempotencyKey: z.string().trim().min(1).max(240),
}).strict();

export const UnderwritingArtifactComparisonSchema = z.object({
  runId: UnderwritingUuidSchema,
  documentId: UnderwritingUuidSchema,
  documentVersionId: UnderwritingUuidSchema,
}).strict();

export function underwritingContext(auth: TenantContext): PeMutationContext {
  return { auth, provenance: { sourceSystem: "@finnor/api", createdBy: auth.employeeId ?? auth.userId } };
}

export async function parseUnderwritingBody<T extends z.ZodTypeAny>(req: Request, schema: T, maxBytes = 1_048_576): Promise<z.infer<T>> {
  return schema.parse(await boundedJson(req, maxBytes));
}

export function underwritingJson(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

export function requiredUnderwritingQuery(url: URL, name: string, schema: z.ZodTypeAny = z.string().min(1).max(240)): string {
  return schema.parse(url.searchParams.get(name));
}

export function underwritingErrorResponse(error: unknown): Response {
  if (error instanceof z.ZodError) {
    return Response.json({ error: "Invalid underwriting request", code: "INVALID_REQUEST", issues: error.issues.slice(0, 20) }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  if (error instanceof UnderwritingError) {
    const status = /NOT_FOUND/.test(error.code) ? 404
      : /LIMIT|TOO_LARGE/.test(error.code) ? 413
        : /MISMATCH|CONFLICT|IDEMPOTENCY/.test(error.code) ? 409
          : /UNKNOWN_INPUT|STALE_INPUT|CONFLICTING_INPUT|MISSING_REQUIRED_INPUT|NON_CONVERGENT/.test(error.code) ? 422 : 400;
    return Response.json({ error: error.message, code: error.code, details: error.details }, { status, headers: { "cache-control": "no-store" } });
  }
  if (error instanceof PeDomainError) {
    const status = /NOT_FOUND|ENTITY_NOT_FOUND/.test(error.code) ? 404 : /CONFLICT|STALE/.test(error.code) ? 409 : 400;
    return Response.json({ error: error.message, code: error.code, details: error.details }, { status, headers: { "cache-control": "no-store" } });
  }
  if (error instanceof ArtifactError) return artifactErrorResponse(error);
  return errorResponse(error);
}

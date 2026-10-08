import { z } from "zod"

export const CanvasTruthStateSchema = z.enum(["KNOWN", "KNOWN_EMPTY", "PARTIAL", "STALE", "CONFLICTING", "UNKNOWN", "UNAVAILABLE"])
export type CanvasTruthState = z.infer<typeof CanvasTruthStateSchema>

export const CanvasSourceRefSchema = z.object({ owner: z.string().min(1), table: z.string().min(1), id: z.string().min(1), fieldPath: z.string().optional() }).strict()
export const CanvasEntityRefSchema = z.object({ namespace: z.string().min(1), owner: z.string().min(1), type: z.string().min(1), id: z.string().min(1) }).strict()
export const CanvasWorkRefSchema = z.object({ workId: z.string().uuid(), recordType: z.string().min(1), recordId: z.string().uuid().optional() }).strict()

const BaseBlockSchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  sourceKind: z.enum(["work", "company_brain", "underwriting", "ic"]),
  title: z.string().min(1),
  entityRefs: z.array(CanvasEntityRefSchema),
  sourceRefs: z.array(CanvasSourceRefSchema),
  workRefs: z.array(CanvasWorkRefSchema),
  truthState: CanvasTruthStateSchema,
  asOf: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

const StageSchema = z.object({ id: z.string(), label: z.string(), state: z.enum(["verified", "active", "waiting", "blocked"]), detail: z.string() }).strict()
const RowSchema = z.object({ id: z.string(), label: z.string(), state: z.string(), detail: z.string().optional() }).strict()
const UnderwritingOutputSchema = z.object({ nodeId: z.string(), label: z.string(), value: z.string(), unit: z.string(), truthClass: z.string() }).strict()
const UnderwritingCheckSchema = z.object({ nodeId: z.string(), code: z.string(), message: z.string(), severity: z.string() }).strict()

export const CanvasBlockSchema = z.discriminatedUnion("type", [
  BaseBlockSchema.extend({type:z.literal("interface_synthesis"),payload:z.object({root:z.object({entityType:z.string(),entityId:z.string().uuid()}).strict(),workId:z.string().uuid().nullable(),threadId:z.string().uuid()}).strict()}).strict(),
  BaseBlockSchema.extend({type:z.literal("deliberation_policy"),payload:z.object({root:z.object({entityType:z.string(),entityId:z.string().uuid()}).strict(),workId:z.string().uuid().nullable(),threadId:z.string().uuid()}).strict()}).strict(),
  BaseBlockSchema.extend({type:z.literal("compute_search"),payload:z.object({root:z.object({entityType:z.string(),entityId:z.string().uuid()}).strict(),workId:z.string().uuid().nullable(),threadId:z.string().uuid()}).strict()}).strict(),
  BaseBlockSchema.extend({type:z.literal("program_synthesis"),payload:z.object({root:z.object({entityType:z.string(),entityId:z.string().uuid()}).strict(),workId:z.string().uuid().nullable(),threadId:z.string().uuid()}).strict()}).strict(),
  BaseBlockSchema.extend({type:z.literal("evidence_execution"),payload:z.object({root:z.object({entityType:z.string(),entityId:z.string().uuid()}).strict(),workId:z.string().uuid().nullable()}).strict()}).strict(),
  BaseBlockSchema.extend({ type: z.literal("work_execution"), payload: z.object({ objective: z.string(), status: z.string(), stages: z.array(StageSchema), finalOutcome: z.string().nullable(), failure: z.string().nullable() }).strict() }).strict(),
  BaseBlockSchema.extend({ type: z.literal("closing_readiness"), payload: z.object({ conditions: z.array(RowSchema), openRisks: z.number().int().nonnegative(), sourceCoverage: z.string() }).strict() }).strict(),
  BaseBlockSchema.extend({ type: z.literal("risk_register"), payload: z.object({ risks: z.array(RowSchema) }).strict() }).strict(),
  BaseBlockSchema.extend({ type: z.literal("ic_readiness"), payload: z.object({ questions: z.array(RowSchema), decisions: z.array(RowSchema) }).strict() }).strict(),
  BaseBlockSchema.extend({ type: z.literal("evidence_matrix"), payload: z.object({ items: z.array(RowSchema), conflicts: z.number().int().nonnegative() }).strict() }).strict(),
  BaseBlockSchema.extend({ type: z.literal("decision_receipt"), payload: z.object({ status: z.string(), result: z.string(), finalizedAt: z.string().datetime().nullable(), failure: z.string().nullable() }).strict() }).strict(),
  BaseBlockSchema.extend({ type: z.literal("underwriting_summary"), payload: z.object({ investmentCaseTitle: z.string(), modelName: z.string(), modelVersion: z.string().nullable(), scenarioName: z.string(), runId: z.string().uuid().nullable(), status: z.string(), validity: z.string(), outputs: z.array(UnderwritingOutputSchema), failedChecks: z.array(UnderwritingCheckSchema) }).strict() }).strict(),
  BaseBlockSchema.extend({ type: z.literal("ic_governance"), payload: z.object({ caseTitle: z.string(), caseState: z.string(), terminalDecision: z.boolean(), votingEligible: z.boolean(), decisionEligible: z.boolean(), blockers: z.array(z.string()), quorum: z.object({ status: z.string(), actual: z.number(), required: z.number() }).nullable(), questions: z.array(RowSchema), votes: z.number().int().nonnegative(), dissents: z.number().int().nonnegative(), conditions: z.number().int().nonnegative(), decision: z.string().nullable() }).strict() }).strict(),
])

export const CanvasLayoutSchema = z.object({ mode: z.literal("document"), blockIds: z.array(z.string().min(1)) }).strict()
export const CanvasRevisionSchema = z.object({ uiRevision: z.number().int().nonnegative(), canonicalSignature: z.string().min(1), builtAt: z.string().datetime() }).strict()
export const CanvasDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  threadId: z.string().uuid(),
  title: z.string(),
  revision: CanvasRevisionSchema,
  layout: CanvasLayoutSchema,
  blocks: z.array(CanvasBlockSchema),
}).strict().superRefine((document, ctx) => {
  const ids = new Set(document.blocks.map((block) => block.id))
  if (ids.size !== document.blocks.length) ctx.addIssue({ code: "custom", message: "Canvas block ids must be unique" })
  if (document.layout.blockIds.some((id) => !ids.has(id))) ctx.addIssue({ code: "custom", message: "Canvas layout references an unknown block" })
})

/** Renderer boundary: validate document identity while isolating unsupported block versions. */
export const CanvasDocumentEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  threadId: z.string().uuid(),
  title: z.string(),
  revision: CanvasRevisionSchema,
  layout: CanvasLayoutSchema,
  blocks: z.array(z.unknown()),
}).strict().superRefine((document, ctx) => {
  const ids = document.blocks.map((block) => block && typeof block === "object" && !Array.isArray(block) ? (block as Record<string, unknown>).id : null)
  if (ids.some((id) => typeof id !== "string" || !id)) ctx.addIssue({ code: "custom", message: "Every Canvas block needs an identity" })
  const unique = new Set(ids)
  if (unique.size !== ids.length) ctx.addIssue({ code: "custom", message: "Canvas block ids must be unique" })
  if (document.layout.blockIds.some((id) => !unique.has(id))) ctx.addIssue({ code: "custom", message: "Canvas layout references an unknown block" })
})

export type CanvasSourceRef = z.infer<typeof CanvasSourceRefSchema>
export type CanvasEntityRef = z.infer<typeof CanvasEntityRefSchema>
export type CanvasWorkRef = z.infer<typeof CanvasWorkRefSchema>
export type CanvasBlock = z.infer<typeof CanvasBlockSchema>
export type CanvasDocument = z.infer<typeof CanvasDocumentSchema>

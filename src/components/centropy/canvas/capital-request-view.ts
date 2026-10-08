import { z } from "zod"
import { CapitalRefViewSchema } from "./capital-ref-view"

const text = z.string().min(1).max(128)
const decimal = z.string().max(48).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,18})?$/)
export const CapitalRequestViewSchema = z.object({
  schema: z.literal("finnor.capital-program-request.v2"), workId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(200), incumbentPolicyRef: CapitalRefViewSchema,
  purpose: z.enum(["COMMERCIAL", "ACQUISITION", "FINANCING"]),
  permitted: z.object({
    actionId: text, exposureId: text, unit: text, terms: z.array(decimal).min(1).max(16),
    startPeriods: z.array(z.number().int().min(0).max(23)).min(1).max(24),
    structures: z.array(z.enum(["IMMEDIATE", "STAGED", "OBSERVABLE_STAGE", "INQUIRY_OPTION", "WAIT_STOP"])).min(1).max(5),
    stageFractions: z.array(decimal).max(8), resourceRule: z.literal("SCALE_REGISTERED_ACTION_LINEAR"),
    agreement: z.enum(["UNILATERAL_PROPOSAL", "COUNTERPARTY_REQUIRED"]),
    milestone: z.object({ instrumentId: text, tokens: z.array(text).min(1).max(16) }).optional(),
    inquiryActionId: text.optional(),
  }),
  financial: z.object({
    investmentCaseId: z.string().uuid(), modelVersionId: z.string().uuid(), nodeId: text,
    semantics: z.record(z.unknown()),
    evidenceDerivationInputs: z.record(z.object({ derivationId: z.string().uuid(), output: text })).optional(),
  }).optional(),
  challengeEvidence: z.array(z.object({ searchId: z.string().uuid(), resultRef: CapitalRefViewSchema })).min(1).max(8).optional(),
  resource: z.object({
    deadlineMs: z.number().int().min(1).max(30000), maxAttempts: z.number().int().min(1).max(16),
    maxGenerated: z.number().int().min(1).max(256), maxExpansions: z.number().int().min(1).max(50000),
    maxRefinementSteps: z.number().int().min(0).max(4096), maxRefinementDepth: z.number().int().min(0).max(8),
    maxModuleBytes: z.number().int().min(1024).max(65536), maxResultBytes: z.number().int().min(1024).max(8388608),
  }),
})

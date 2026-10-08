import { z } from "zod"
import { CapitalRefViewSchema } from "./capital-ref-view"

const originalRef = CapitalRefViewSchema.extend({
  owner: z.literal("M4"), id: z.string().regex(/^challenge-result:[a-f0-9]{64}$/),
})
const outcome = z.enum(["FAILURE_WITNESS", "NO_WITNESS_WITHIN_BUDGET", "BLOCKED"])
const originalReport = z.object({
  schema: z.literal("finnor.m4.challenge-result.v1"), ref: originalRef,
  candidate: CapitalRefViewSchema.extend({ owner: z.literal("M3") }),
  identity: z.object({
    principalId: z.string().uuid(), workId: z.string().uuid(), workInputId: z.string().uuid(),
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  envelope: z.object({
    id: z.string().uuid(),
    work: z.object({ id: z.string().uuid(), inputId: z.string().uuid(), inputDigest: z.string() }),
    computeGrant: z.object({ searchId: z.string().uuid(), deadlineAt: z.string().datetime() }),
  }),
  executionAuthorityGranted: z.literal(false), result: outcome,
  claimRecords: z.array(z.object({
    ref: CapitalRefViewSchema, kind: z.string(), evaluation: z.record(z.unknown()),
    qualification: z.string(),
  })).max(64),
  witnessRecords: z.array(z.object({
    ref: CapitalRefViewSchema, class: z.string(), claimRef: CapitalRefViewSchema,
    original: z.record(z.unknown()), minimized: z.record(z.unknown()),
    validation: z.object({
      status: z.literal("VALID"), material: z.literal(true), qualification: z.string(),
      native: z.object({ checker: z.string(), observed: z.unknown(), trace: z.unknown() }),
      independent: z.object({ checker: z.string(), observed: z.unknown(), trace: z.unknown() }),
      predicate: z.object({ expected: z.unknown(), relation: z.string(), location: z.string(), unit: z.string().nullable() }),
    }),
    minimization: z.object({ status: z.string(), trace: z.array(z.unknown()), globallySmallest: z.literal(false) }),
  })).max(32),
  coverageGaps: z.array(z.object({
    ref: CapitalRefViewSchema, reason: z.string(), detail: z.string(), requiredOwner: z.string(),
  })),
  coverage: z.object({
    checkedCells: z.number().int(), totalDeclaredCells: z.number().int(),
    invalidCells: z.number().int(), unresolvedCells: z.number().int(), untestedCells: z.number().int(),
    unrestrictedCompleteness: z.literal(false),
  }),
  ledger: z.object({
    trials: z.number().int(), attempts: z.number().int(), wallMs: z.number().finite(),
    usd: z.null(), unknownAttemptCosts: z.boolean(),
  }),
  parentResultRef: originalRef.nullable(), repairReplay: z.array(z.unknown()),
  repairClosure: z.object({ affectedUses: z.array(z.string()), request: z.string(), authorityGranted: z.literal(false) }),
})
export const OriginalChallengeViewSchema = z.object({
  searchId: z.string().uuid(), status: z.string(), report: originalReport.nullable(),
  identity: z.object({
    principalId: z.string().uuid(), workId: z.string().uuid(), workInputId: z.string().uuid(),
    contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  applicability: z.object({ status: z.string(), reason: z.string() }),
  deadlineAt: z.string().datetime(), retainedUntil: z.string().datetime(),
  trials: z.number().int(), executionAuthorityGranted: z.literal(false),
  deliveryHistory: z.array(z.unknown()).optional(), ledger: z.array(z.unknown()).optional(),
  partialEvidence: z.object({
    schema: z.literal("finnor.m4.retained-partial-evidence.v1"),
    incomplete: z.literal(true), published: z.literal(false), currentUsePermitted: z.literal(false),
    acceptedChecks: z.array(z.unknown()), unresolved: z.array(z.unknown()),
  }).nullable().optional(),
})
export const OriginalChallengeAcceptedSchema = z.object({ searchId: z.string().uuid() })
export type OriginalChallengeView = z.infer<typeof OriginalChallengeViewSchema>

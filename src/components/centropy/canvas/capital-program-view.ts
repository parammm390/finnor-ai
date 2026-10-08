import { z } from "zod"

import { CapitalRefViewSchema } from "./capital-ref-view"
import { CapitalRequestViewSchema } from "./capital-request-view"
export { CapitalRefViewSchema } from "./capital-ref-view"
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const blocker = z.object({ code: z.string(), owner: z.string(), requirement: z.string() })
const amounts = z.record(z.number().finite())
const action = z.object({
  id: z.string(), kind: z.enum(["INTERVENE", "INQUIRE", "WAIT", "STOP"]),
  earliestPeriod: z.number().int(), lastPeriod: z.number().int(), cost: z.number().finite(),
  costUnit: z.string(), resources: amounts, occupancy: amounts, occupationPeriods: z.number().int(),
  exposures: z.record(z.array(z.number().finite())), informationDelayPeriods: z.number().int(),
  protocolRef: CapitalRefViewSchema.nullable(), tailLiability: z.number().finite(), humanSeconds: z.number().finite(),
  precondition: z.object({ afterActionIds: z.array(z.string()).max(8),
    observations: z.array(z.object({ instrumentId: z.string(), tokens: z.array(z.string()).max(16) })).max(8) }).optional(),
})
export const CapitalPolicyViewSchema = z.object({
  ref: CapitalRefViewSchema, resultState: z.string(),
  problem: z.object({ actions: z.array(action).max(8), observations: z.array(z.object({
    id: z.string(), variableId: z.string(), unit: z.string(), delayPeriods: z.number().int(),
    afterActionIds: z.array(z.string()).max(8),
    bins: z.array(z.object({ category: z.string(), lowerInclusive: z.number(), upperExclusive: z.number() })).max(16),
  })).max(8) }),
  mandate: z.object({
    horizon: z.object({ startAt: z.string(), periodMs: z.number(), periods: z.number().int() }),
    utility: z.object({ unit: z.string() }),
  }),
})
export const CapitalContextViewSchema = z.object({
  workId: z.string().uuid(), policies: z.array(CapitalPolicyViewSchema).max(256),
  executionAuthorityGranted: z.literal(false),
})
const candidate = z.object({
  semanticDigest: digest, structure: z.string(), disposition: z.string(), reason: z.string().nullable(),
  terms: z.array(z.object({ exposureId: z.string(), unit: z.string(), before: z.string(), after: z.string(), period: z.number().int() })),
  agreement: z.object({ status: z.literal("PROPOSED"), requiredStanding: z.string(), liveAgreementRef: z.null() }),
  policyRef: CapitalRefViewSchema.nullable(), moduleRef: CapitalRefViewSchema.nullable(),
  valueBasis: z.literal("S4_ROBUST_FIXED_JOINT_WORLDS_NO_PROBABILITIES"),
  valueBounds: z.tuple([z.number().finite(), z.number().finite()]).nullable(),
  blockers: z.array(blocker),
  nativeFinance: z.object({ modelRef: CapitalRefViewSchema, inputDigest: digest, resultDigest: digest,
    result: z.unknown(), qualification: z.string() }).nullable(),
})
/** Display validation does not establish rights, currentness, economics or
 * authority. Every refresh and inspection goes back to the authenticated owner. */
export const CapitalProgramViewSchema = z.object({
  schema: z.literal("finnor.capital-program.v2"), ref: CapitalRefViewSchema,
  valueUnit: z.string(),
  executionAuthorityGranted: z.literal(false),
  envelope: z.object({
    work: z.object({ id: z.string().uuid(), inputId: z.string().uuid(), inputDigest: digest }),
    knowledgeAt: z.string(), validAt: z.string(), validUntil: z.string(),
    parents: z.array(CapitalRefViewSchema),
    recompilation: z.object({ parentQueryId: z.string().uuid(), parents: z.array(CapitalRefViewSchema),
      changedDependencies: z.array(z.object({ key: z.string(), previousDigest: digest.nullable(), currentDigest: digest.nullable() })) }).nullable(),
    admission: z.object({ status: z.literal("BLOCKED_EXTERNAL"), receipt: z.null() }),
  }),
  challengeEvidence: z.array(CapitalRefViewSchema), evidenceSlice: CapitalRefViewSchema.nullable(), candidates: z.array(candidate).max(16),
  incumbentAndSearchGap: z.object({
    incumbentDigest: digest, selectedDigest: digest.nullable(), valueBounds: z.tuple([z.number().finite(), z.number().finite()]).nullable(),
    remainingDescriptors: z.number().int().nonnegative(), finiteDomainComplete: z.boolean(),
    upperBound: z.null(), globalOptimalityClaimed: z.literal(false), modeledImprovement: z.number().finite().nullable(),
    unsampledModelGap: z.literal("UNKNOWN"), identificationGap: z.literal("UNKNOWN"),
  }),
  blockers: z.array(blocker), limitations: z.array(z.string()),
  costs: z.object({
    money: z.null(), status: z.literal("UNMETERED"), wallMs: z.number().finite(),
    generated: z.number().int(), attempted: z.number().int(), refinementSteps: z.number().int(),
    expansions: z.number().int(), unknownAttemptIds: z.array(z.string()),
  }),
})
export const CapitalBranchReviewViewSchema = z.object({
  schema: z.literal("finnor.m3.native-branch-review.v2"), ref: CapitalRefViewSchema,
  status: z.literal("MODEL_BRANCH_REVIEWED"), queryId: z.string().uuid(), programRef: CapitalRefViewSchema,
  candidateDigest: digest, policyRef: CapitalRefViewSchema,
  decision: z.object({ knowledgeAt: z.string(), period: z.number().int() }),
  choice: z.object({ ref: CapitalRefViewSchema, status: z.string(), nodeId: z.string().nullable(), actionId: z.string().nullable() }),
  executionAuthorityGranted: z.literal(false), decisionCoverageGranted: z.literal(false), reservationCreated: z.literal(false), effectRef: z.null(),
})
export const CapitalQueryViewSchema = z.object({
  queryId: z.string().uuid(), workId: z.string().uuid(),
  request: CapitalRequestViewSchema, deadlineAt: z.string().datetime().nullable(),
  status: z.enum(["QUEUED", "RUNNING", "TESTED", "PARTIAL", "FAILED", "INVALIDATED", "CANCELLED"]),
  program: CapitalProgramViewSchema.nullable(), parentQueryId: z.string().uuid().nullable(),
  progress: z.object({ attempted: z.number().int(), generated: z.number().int(), refinementSteps: z.number().int() }),
  failure: z.object({ code: z.string(), requirement: z.string() }).nullable(),
  executionAuthorityGranted: z.literal(false),
  branchReviews: z.array(CapitalBranchReviewViewSchema).max(16),
  attemptCosts: z.array(z.object({
    attemptId: z.string().uuid(), state: z.enum(["RUNNING", "FINISHED", "FAILED", "FENCED"]),
    startedAt: z.string(), finishedAt: z.string().nullable(), deadlineAt: z.string(),
    physicalCostStatus: z.enum(["PENDING_READBACK", "UNKNOWN", "MEASURED_SUPERVISOR_INTERVAL"]),
    wallMs: z.number().finite().nullable(), cpuUserMicros: z.number().finite().nullable(),
    cpuSystemMicros: z.number().finite().nullable(), money: z.null(), aggregateChildUsageKnown: z.literal(false),
    accountingScope: z.literal("WORKER_HANDLER_BEFORE_TERMINAL_ACCOUNTING"),
  })).max(128),
})
export const CapitalAcceptedViewSchema = z.object({
  queryId: z.string().uuid(), workId: z.string().uuid(), status: z.string(), replayed: z.boolean(),
})
export const CapitalWitnessViewSchema = z.object({
  candidate, policy: CapitalPolicyViewSchema.extend({ nodes: z.array(z.object({
    id: z.string(), actionId: z.string(), period: z.number().int(), actionHistory: z.array(z.string()),
    observations: z.array(z.unknown()),
  })) }).nullable(),
  model: z.unknown(), kernel: z.unknown(), checks: z.array(z.unknown()),
  evidenceSlice: z.unknown(), executionAuthorityGranted: z.literal(false),
})
export const CapitalModuleViewSchema = z.object({
  ref: CapitalRefViewSchema, bytes: z.string().max(1_048_576), sha256: digest,
  contentType: z.literal("application/json"), executionAuthorityGranted: z.literal(false),
}).strict()
export type CapitalQueryView = z.infer<typeof CapitalQueryViewSchema>
export type CapitalPolicyView = z.infer<typeof CapitalPolicyViewSchema>
export type CapitalWitnessView = z.infer<typeof CapitalWitnessViewSchema>

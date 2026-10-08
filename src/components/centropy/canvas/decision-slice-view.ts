import { z } from "zod"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const DecisionSliceRefSchema = z.object({
  owner: z.literal("M1"), id: z.string().min(1).max(512),
  version: z.literal("m1-exact-dependency-v1"), contentDigest: digest,
}).strict()
export const P4InputBindingViewSchema = z.object({
  nodeId: z.string().min(1).max(240),
  derivationId: z.string().uuid(),
  output: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
}).strict()
const ownerRef = z.object({ owner: z.string(), id: z.string(), version: z.string(), contentDigest: z.string() })
const gap = z.object({
  id: z.string(), code: z.string(), status: z.string(), requirement: z.string(),
  requiredProducer: z.string(), affectedRoots: z.array(z.string()),
})
const variable = z.object({
  id: z.string(), nativeId: z.string(), kind: z.string(), qualification: z.string(), status: z.string(),
  ownerRef, candidateId: z.string().nullable(), unit: z.string().nullable(), currency: z.string().nullable(),
  periods: z.array(z.unknown()),
})
/** Presentation validation only. The authenticated owner, never this parser or a
 * browser cache, establishes rights, exact preimages, currentness and closure. */
export const DecisionSliceViewSchema = z.object({
  schema: z.literal("finnor.decision-slice.v1"), ref: DecisionSliceRefSchema,
  envelope: z.object({
    work: z.object({ id: z.string().uuid(), inputId: z.string().uuid() }),
    validAt: z.string(), knowledgeAt: z.string(), validUntil: z.string(),
    state: z.literal("PROPOSED_TESTED"), executionAuthorityGranted: z.literal(false),
    cost: z.object({ money: z.null(), status: z.literal("UNMETERED") }),
    admission: z.object({ status: z.literal("BLOCKED_EXTERNAL") }),
  }),
  materialVariables: z.array(variable).max(10000),
  candidateDependencies: z.object({
    roots: z.array(z.object({ id: z.string(), criterion: z.string(), hard: z.boolean() })),
    solverGroups: z.array(z.object({ id: z.string(), status: z.string(), members: z.array(z.string()) })),
  }),
  projectionLoss: z.null(), projectionLossReason: z.string(),
  projectionSupport: z.object({
    status: z.literal("EXACT_DEPENDENCY_PRESERVATION"),
    check: z.object({ status: z.literal("CHECKED"), exactPreservation: z.literal(true), independentlyAdmitted: z.literal(false) }),
    witness: z.object({ retainedIds: z.array(z.string()), omittedIds: z.array(z.string()), uncertaintyDomain: z.string(), limitations: z.array(z.string()) }),
  }),
  unresolvedCoverage: z.array(gap),
  evidenceDemands: z.array(z.object({
    ref: DecisionSliceRefSchema, requiredProducer: z.string(), status: z.string(), reason: z.string(),
    variableIds: z.array(z.string()), semantics: z.object({ unit: z.string().nullable(), currency: z.string().nullable(), coverage: z.string() }),
  })).max(128),
  limitations: z.array(z.string()),
})
export const DecisionContextViewSchema = z.object({
  schema: z.literal("finnor.m1.working-context.v1"), ref: DecisionSliceRefSchema,
  revision: z.number().int().positive(), qualifiedDigest: digest,
  notes: z.array(z.string()), agenda: z.array(z.string()), unresolved: z.array(gap),
})
export const DecisionWitnessViewSchema = z.object({
  sliceRef: DecisionSliceRefSchema, variable, native: z.array(z.unknown()),
  p4Derivation: z.object({
    id: z.string().uuid(), queryId: z.string().uuid(), qualification: z.string(),
    output: z.unknown(), witnesses: z.array(z.unknown()), independentChecks: z.array(z.unknown()),
  }).nullable(),
  executionAuthorityGranted: z.literal(false),
})
export type DecisionSliceView = z.infer<typeof DecisionSliceViewSchema>
export type DecisionContextView = z.infer<typeof DecisionContextViewSchema>
export type DecisionWitnessView = z.infer<typeof DecisionWitnessViewSchema>
export type DecisionSliceRef = z.infer<typeof DecisionSliceRefSchema>

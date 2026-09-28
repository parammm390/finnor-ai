import { z } from "zod"

const ReplayNodeSchema = z.object({ id: z.string(), stage: z.string(), title: z.string(), summary: z.string(), status: z.string(), occurredAt: z.string().datetime(), evidence: z.array(z.object({ source: z.string(), availability: z.string() }).passthrough()) }).passthrough()
const ReplayEdgeSchema = z.object({ id: z.string(), from: z.string(), to: z.string(), relation: z.string(), certainty: z.enum(["proven", "missing"]), evidenceRefs: z.array(z.string()), explanation: z.string() }).passthrough()

export const CausalReplaySchema = z.object({
  version: z.literal(1), mode: z.literal("read_only"),
  work: z.object({ id: z.string().uuid(), status: z.string(), objective: z.string() }).passthrough(),
  nodes: z.array(ReplayNodeSchema), edges: z.array(ReplayEdgeSchema),
  moments: z.array(z.object({ at: z.string().datetime(), nodeIds: z.array(z.string()), headline: z.string(), stage: z.string() }).passthrough()),
  explanation: z.object({ trigger: z.string(), context: z.string(), plan: z.string(), governance: z.string(), execution: z.string(), verification: z.string(), outcome: z.string(), gaps: z.array(z.string()) }).passthrough(),
  completeness: z.object({ status: z.string(), provenEdges: z.number(), missingEdges: z.number(), missing: z.array(z.string()) }).passthrough(),
  readOnlyGuarantee: z.object({ method: z.literal("GET"), sideEffectsPossible: z.literal(false), mutationControlsIncluded: z.literal(false) }).passthrough(),
  truncated: z.object({ nodes: z.boolean(), edges: z.boolean() }).passthrough(),
  asOf: z.string().datetime(),
}).passthrough()

export type CausalReplay = z.infer<typeof CausalReplaySchema>

/** The path is exactly the backend's declared edges; nearby timestamps create no relationship. */
export function causalPathRows(replay: CausalReplay) {
  const nodes = new Map(replay.nodes.map((node) => [node.id, node]))
  return replay.edges.map((edge) => ({
    id: edge.id,
    from: nodes.get(edge.from)?.title ?? "Source node unavailable",
    to: nodes.get(edge.to)?.title ?? "Target node unavailable",
    fromStage: nodes.get(edge.from)?.stage ?? null,
    toStage: nodes.get(edge.to)?.stage ?? null,
    relation: edge.relation,
    certainty: edge.certainty,
    explanation: edge.explanation,
    evidenceCount: edge.evidenceRefs.length,
  }))
}

import {
  baselineDurableEpistemicGraph,
  compareEpistemicAssessmentToOutcome,
  stageDurableEpistemicGraph,
} from "@finnor/epistemic-runtime";
import { buildPrivateEquityDurableGraphDefinition } from "./epistemic";
import {
  evaluateDealCloseEligibility,
  loadDealExecutionGraph,
  peTransaction,
} from "./repository";
import { loadPrivateEquityAssertions } from "./source-mapping";
import { PE_DIGITAL_TWIN_ENTITY_TYPES, type PeMutationContext } from "./types";

const MAX_ACTIVE_DEALS_PER_GRAPH = 250;
const MAX_DIGITAL_TWIN_FACTS_PER_GRAPH = 10_000;

/** Controlled release/backfill entrypoint. It derives one tenant graph from
 * current canonical PE owners, freezes it through the runtime, then advances a
 * bounded baseline. Repeated calls resume the same graph and baseline. */
export async function prepareTenantPrivateEquityEpistemicGraph(input: {
  ctx: PeMutationContext;
  baselineBatchSize?: number;
  baselineBatches?: number;
}): Promise<{
  status: "NO_ACTIVE_DEALS" | "BASELINE_PENDING" | "BASELINE_COMPLETE";
  graphVersionId?: string;
  graphHash?: string;
  propositionCount: number;
  bindingCount: number;
  evaluated: number;
}> {
  const batchSize = input.baselineBatchSize ?? 64;
  const batches = input.baselineBatches ?? 1;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 64) throw new Error("Baseline batch size must be 1..64");
  if (!Number.isSafeInteger(batches) || batches < 1 || batches > 160) throw new Error("Baseline batch count must be 1..160");
  const snapshot = await peTransaction(input.ctx, async (_db,client) => {
    const rows = await client.query<{ id: string }>(
      `SELECT id::text FROM finnor_os.pe_deals WHERE tenant_id=$1 AND status='active'
       ORDER BY id LIMIT $2`, [input.ctx.auth.tenantId,MAX_ACTIVE_DEALS_PER_GRAPH+1]);
    if (rows.rows.length > MAX_ACTIVE_DEALS_PER_GRAPH) throw new Error("Active Deal graph exceeds bounded Scope-5 registration limit");
    const control = await client.query<{ graph_structure_epoch: string }>(
      `SELECT graph_structure_epoch::text FROM finnor_os.epistemic_runtime_controls
       WHERE tenant_id=$1`,[input.ctx.auth.tenantId]);
    const twin = await client.query<{ entity_type: string; entity_id: string }>(
      `SELECT entity_type,entity_id::text FROM (
         SELECT DISTINCT ON (entity_type,entity_id) entity_type,entity_id,snapshot
         FROM finnor_os.canonical_entity_versions
         WHERE tenant_id=$1 AND entity_type=ANY($2::text[])
         ORDER BY entity_type,entity_id,entity_version DESC
       ) latest
       WHERE latest.snapshot->>'superseded_at' IS NULL
       ORDER BY entity_type,entity_id LIMIT $3`,
      [input.ctx.auth.tenantId,[...PE_DIGITAL_TWIN_ENTITY_TYPES],MAX_DIGITAL_TWIN_FACTS_PER_GRAPH+1]);
    if (twin.rows.length > MAX_DIGITAL_TWIN_FACTS_PER_GRAPH) {
      throw new Error("Digital Twin graph exceeds bounded Scope-5 registration limit");
    }
    return { dealIds:rows.rows.map((row) => row.id),
      digitalTwinSources:twin.rows.map((row) => ({entityType:row.entity_type,entityId:row.entity_id})),
      structureEpoch:control.rows[0]?.graph_structure_epoch ?? "0" };
  }, { readOnly:true });
  const dealIds = snapshot.dealIds;
  if (!dealIds.length && !snapshot.digitalTwinSources.length) {
    return { status:"NO_ACTIVE_DEALS",propositionCount:0,bindingCount:0,evaluated:0 };
  }
  const definitions = [];
  for (const dealId of dealIds) {
    const graph = await loadDealExecutionGraph(input.ctx,dealId);
    definitions.push({
      tenantId:input.ctx.auth.tenantId,
      principalId:input.ctx.auth.userId,
      dealId,
      graph,
      eligibility:await evaluateDealCloseEligibility(input.ctx,dealId),
      assertions:await loadPrivateEquityAssertions(input.ctx,dealId),
      asOf:graph.asOf,
    });
  }
  const graphDefinition = buildPrivateEquityDurableGraphDefinition(definitions,{
    tenantId:input.ctx.auth.tenantId,digitalTwinSources:snapshot.digitalTwinSources,
  });
  const staged = await stageDurableEpistemicGraph(graphDefinition,{ expectedStructureEpoch:snapshot.structureEpoch });
  let complete = false;
  let evaluated = 0;
  for (let batch = 0; batch < batches && !complete; batch += 1) {
    const result = await baselineDurableEpistemicGraph(input.ctx.auth.tenantId,batchSize);
    evaluated += result.evaluated;
    complete = result.complete;
  }
  return {
    status:complete ? "BASELINE_COMPLETE" : "BASELINE_PENDING",
    ...staged,propositionCount:graphDefinition.propositions.length,
    bindingCount:graphDefinition.bindings.length,evaluated,
  };
}

/** A tenant-authenticated PE request names the exact decision-time assessment,
 * later canonical Outcome and observed value path. No comparison is inferred
 * from text or from a shared Deal. The epistemic owner records the history. */
export function comparePrivateEquityOutcomeAssessment(ctx: PeMutationContext, input: {
  assessmentId: string; outcomeId: string; valuePath: string;
}): ReturnType<typeof compareEpistemicAssessmentToOutcome> {
  return compareEpistemicAssessmentToOutcome({
    tenantId:ctx.auth.tenantId,assessmentId:input.assessmentId,
    outcomeId:input.outcomeId,valuePath:input.valuePath,
  });
}

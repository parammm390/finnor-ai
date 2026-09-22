import { withTenantTransaction } from "@finnor/db";
import { compareDurableShadowWithOracle, processDurableEpistemicChange, recoverAcceptedEpistemicChanges, scanDueEpistemicFreshness } from "@finnor/epistemic-runtime";
import { prepareTenantPrivateEquityEpistemicGraph } from "@finnor/private-equity";
import { RetryableJobError, type JobHandler } from "../queue";

export const processEpistemicChange: JobHandler = async (payload, context) => {
  if (context?.protocolVersion !== 2 || payload.schemaVersion !== 2) throw new Error("Epistemic change requires protocol/schema version 2");
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : "";
  const changeId = typeof payload.changeId === "string" ? payload.changeId : "";
  if (!tenantId || !changeId || context.tenantId !== tenantId) throw new Error("Epistemic change has no matching durable tenant/change identity");
  const result = await processDurableEpistemicChange(tenantId,changeId);
  if (result.complete) return;
  throw new RetryableJobError(`Epistemic change deferred: ${result.reason}`,result.reason === "BASELINE_PENDING" ? 60_000 : 5_000);
};

export const scanEpistemicFreshness: JobHandler = async (payload, context) => {
  if (context?.protocolVersion !== 2) throw new Error("Epistemic freshness scan requires protocol 2");
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : "";
  if (!tenantId || context.tenantId !== tenantId) throw new Error("Epistemic freshness scan requires matching tenant");
  await scanDueEpistemicFreshness(tenantId);
};

export const recoverEpistemicChanges: JobHandler = async (payload, context) => {
  if (context?.protocolVersion !== 2) throw new Error("Epistemic recovery requires protocol 2");
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : "";
  if (!tenantId || context.tenantId !== tenantId) throw new Error("Epistemic recovery requires matching tenant");
  await recoverAcceptedEpistemicChanges(tenantId);
};

/** Graph assembly is a bounded Scope-3 maintenance obligation. A structural
 * change fences active execution at commit; this job rebuilds and verifies the
 * graph. Activation remains the explicit release gate with an exact SHA. */
export const refreshEpistemicGraph: JobHandler = async (payload, context) => {
  if (context?.protocolVersion !== 2) throw new Error("Epistemic graph refresh requires protocol 2");
  const tenantId = typeof payload.tenantId === "string" ? payload.tenantId : "";
  if (!tenantId || context.tenantId !== tenantId) throw new Error("Epistemic graph refresh requires matching tenant");
  const control = await withTenantTransaction(tenantId,{ readOnly:true },async (_db,client) =>
    (await client.query<{ mode:string; graph_structure_epoch:string; staged_structure_epoch:string;
      baseline_completed_at:Date|null; shadow_verified_at:Date|null }>(
      `SELECT mode,graph_structure_epoch::text,staged_structure_epoch::text,
         baseline_completed_at,shadow_verified_at
       FROM finnor_os.epistemic_runtime_controls WHERE tenant_id=$1`,[tenantId])).rows[0]);
  if (!control || control.graph_structure_epoch === control.staged_structure_epoch
    && (control.mode !== "refreshing" || control.shadow_verified_at)) return;
  const prepared = await prepareTenantPrivateEquityEpistemicGraph({
    ctx:{ auth:{ tenantId,userId:"system:epistemic-graph-worker",role:"owner" },
      provenance:{ sourceSystem:"scope5:graph-refresh",createdBy:"system:epistemic-graph-worker" } },
    baselineBatchSize:64,baselineBatches:16,
  });
  if (prepared.status === "BASELINE_PENDING") throw new RetryableJobError("Epistemic graph baseline remains bounded work",5_000);
  if (prepared.status === "NO_ACTIVE_DEALS") return;
  await compareDurableShadowWithOracle(tenantId);
};

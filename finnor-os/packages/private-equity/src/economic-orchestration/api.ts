import { z } from "zod";
import { DatabaseExecutionDeadlineError } from "@finnor/db";
import { EvidenceRootSchema } from "@finnor/shared-types";
import type { PoolClient } from "pg";
import type { PeMutationContext } from "../types";
import type { SearchRow } from "../compute-search/contracts";
import { authorize, principal, sha, tx, unavailable } from "../evidence-execution/store";
import { requestRow } from "../program-synthesis/store";
import { ComputeSearchRequestSchema, boundedDecode, SearchIdSchema } from "../compute-search/contracts";
import { handleComputeSearchOperation } from "../compute-search/api";
import { searchRow, currentSearch, append } from "../compute-search/store";
import { EconomicOrchestrationOptionsSchema } from "./contracts";
import { isEconomicSearch } from "./snapshot";
import { nativeMaterialDigest } from "./policy";
import { validateEconomicBinding, recordEconomicCancellationTx } from "./currentness";
import { persistNativeGapTx } from "./gaps";
import { recordNativeObservationsTx } from "./learning";
import { currentEconomicCutTx } from "./cut";
import { latestPublishedEconomicCapsuleTx } from "./capsules";
import { PrimaryResearchRequestSchema, readPrimaryResearch } from "./research";

export const EconomicOrchestrationRequestSchema = ComputeSearchRequestSchema.omit({ schema: true, deliberation: true }).extend({
  schema: z.literal("finnor.economic-orchestration-request.v1"), orchestration: EconomicOrchestrationOptionsSchema,
}).strict();
export const EconomicOrchestrationProjectionSchema = z.object({ root: EvidenceRootSchema, workId: z.string().uuid() }).strict();
export const ECONOMIC_ORCHESTRATION_OPERATION_SCHEMAS={
  "economic-orchestration-research": PrimaryResearchRequestSchema,
  "economic-orchestration-submit": EconomicOrchestrationRequestSchema,
  "economic-orchestration-read": SearchIdSchema,
  "economic-orchestration-projection": EconomicOrchestrationProjectionSchema,
  "economic-orchestration-cancel": SearchIdSchema,
  "economic-orchestration-resume": SearchIdSchema, "economic-orchestration-reconcile": SearchIdSchema,
  "economic-orchestration-invalidate": SearchIdSchema, "economic-orchestration-response-refresh": SearchIdSchema,
} as const;
export const ECONOMIC_ORCHESTRATION_OPERATIONS = Object.keys(ECONOMIC_ORCHESTRATION_OPERATION_SCHEMAS) as Array<keyof typeof ECONOMIC_ORCHESTRATION_OPERATION_SCHEMAS>;
export async function readEconomicOrchestration(ctx: PeMutationContext, id: string) {
  const s = await searchRow(ctx, id), q = await requestRow(ctx, s.program_id);
  if (!isEconomicSearch(s.request)) throw unavailable();
  await authorize(ctx, q.request.root, [{ type: "work", id: q.work_id }]);
  let current = true, reason: string | null = null;
  try { await currentSearch(ctx, s, q); } catch (error) {
    if (error instanceof DatabaseExecutionDeadlineError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "PE_ENTITY_NOT_FOUND") throw unavailable();
    current = false; reason = predicate(error);
  }
  const result = await tx(ctx, async c => {
    if (!current) {
      const costs = (await c.query("SELECT id,status,body->'w1Meter' meter FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 ORDER BY created_at,id", [s.tenant_id, s.principal_id, s.id])).rows;
      const historical = await latestPublishedEconomicCapsuleTx(ctx, s, c, { historical: true });
      return { capsule: null, historicalCapsuleDigest: historical ? sha(historical) : null, response: null, costs,
        currentness: "STALE", policyCurrentness: historical ? "INVALIDATED_OR_SUPERSEDED_BINDING" : "NOT_AVAILABLE", unmet: reason };
    }
    const live = await searchRow(ctx, s.id, c, true), qLive = await requestRow(ctx, s.program_id, c);
    const cut = live.context ? await currentEconomicCutTx(ctx, live, qLive, c) : null;
    const capsule = cut?.capsule ?? null, input = cut?.input ?? null;
    const policyCurrent = !cut?.invalidated && !!capsule && !!input && capsule.proposal.materialDigest === nativeMaterialDigest(input);
    const measurementGaps = (await c.query("SELECT body,digest FROM finnor_os.w1_measurement_gaps WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 ORDER BY created_at,id LIMIT 257",
      [s.tenant_id, s.principal_id, s.id])).rows;
    return { capsule: policyCurrent ? capsule : null, historicalCapsuleDigest: capsule ? sha(capsule) : null,
      response: input?.response ?? null, continuation: input?.continuation ?? null, measurementGaps,
      costs: { owner: "P2/S7", usd: null, status: "UNKNOWN", completeChildUsage: null },
      status: live.status, reason: live.reason, currentness: "CURRENT",
      policyCurrentness: capsule ? policyCurrent ? "CURRENT" : "INVALIDATED_OR_SUPERSEDED_BINDING" : "NOT_AVAILABLE",
      unmet: s.reason, originalOutcomeAccepted: q.status === "TESTED" };
  });
  await authorize(ctx, q.request.root, [{ type: "work", id: q.work_id }]);
  return { schema: "finnor.w1.native-current-reader.v1", searchId: s.id, programId: q.id, workId: q.work_id,
    workRevision: q.work_input_id, status: s.status, reason: s.reason, ...result,
    qualification: "DEVELOPMENT_NATIVE_ORCHESTRATION_NOT_PROTECTED_OR_FIELD_QUALIFIED",
    protectedAdmission: false, productionActivated: false, authorityGranted: false };
}
export interface EconomicOwnerPorts {
  reconcileDependenciesTx(ctx: PeMutationContext, search: SearchRow, client: PoolClient): Promise<string[]>;
}
export async function handleEconomicOrchestrationOperation(ctx: PeMutationContext, operation: string, body: unknown,
  owners?: EconomicOwnerPorts): Promise<{ status: number; body: unknown }> {
  try {
    boundedDecode(body);
    if (operation === "economic-orchestration-research")
      return { status: 200, body: await readPrimaryResearch(ctx, body) };
    if (operation === "economic-orchestration-submit") {
      const input = EconomicOrchestrationRequestSchema.parse(body), q = await requestRow(ctx, input.programId);
      await validateEconomicBinding(ctx, q, input);
      return handleComputeSearchOperation(ctx, "compute-search-submit", { ...input, schema: "finnor.compute-search-request.v1" });
    }
    if (operation === "economic-orchestration-projection") {
      const input = EconomicOrchestrationProjectionSchema.parse(body);
      await authorize(ctx, input.root, [{ type: "work", id: input.workId }]);
      const rows = await tx(ctx, async c => (await c.query(
        `SELECT s.id FROM finnor_os.p2_requests s JOIN finnor_os.p1_requests p
         ON p.tenant_id=s.tenant_id AND p.principal_id=s.principal_id AND p.id=s.program_id
         WHERE s.tenant_id=$1 AND s.principal_id=$2 AND p.work_id=$3 AND p.request->'root'=$4::jsonb
          AND s.request ? 'orchestration' ORDER BY s.created_at DESC LIMIT 20`,
        [ctx.auth.tenantId, principal(ctx), input.workId, JSON.stringify(input.root)],
      )).rows, true);
      const searches = [];
      for (const row of rows) searches.push(await readEconomicOrchestration(ctx, z.string().uuid().parse(row.id)));
      await authorize(ctx, input.root, [{ type: "work", id: input.workId }]);
      return { status: 200, body: { schema: "finnor.w1.work-projection.v1", workId: input.workId, searches } };
    }
    const id = SearchIdSchema.parse(body).searchId, s = await searchRow(ctx, id), q = await requestRow(ctx, s.program_id);
    if (!isEconomicSearch(s.request)) throw unavailable();
    await authorize(ctx, q.request.root, [{ type: "work", id: q.work_id }]);
    if (operation === "economic-orchestration-read") return { status: 200, body: await readEconomicOrchestration(ctx, id) };
    if (operation === "economic-orchestration-invalidate") {
      if (!owners) throw Error("W1_ACTUAL_P7_TYPED_OWNER_PORT_REQUIRED");
      const affected = await tx(ctx, c => owners.reconcileDependenciesTx(ctx, s, c));
      return { status: 200, body: { searchId: id, affected, originalEpisode: q.episode_id, authorityGranted: false } };
    }
    if (operation === "economic-orchestration-response-refresh") {
      await currentSearch(ctx, s, q);
      await tx(ctx, async c => {
        const live = await searchRow(ctx, s.id, c, true);
        await recordNativeObservationsTx(ctx, live, c);
        await append(ctx, live, "W1_NATIVE_RESPONSE_REFRESHED", { originalEpisode: q.episode_id, callerSuppliedObservations: false, costUSD: null }, c);
      });
      return { status: 200, body: await readEconomicOrchestration(ctx, id) };
    }
    const lifecycle: Readonly<Record<string, string>> = {
      "economic-orchestration-cancel": "compute-search-cancel",
      "economic-orchestration-resume": "compute-search-resume",
      "economic-orchestration-reconcile": "compute-search-reconcile",
    };
    const canonical = lifecycle[operation];
    if (canonical) {
      const result = await handleComputeSearchOperation(ctx, canonical, { searchId: id });
      if (operation === "economic-orchestration-cancel" && result.status >= 200 && result.status < 300) {
        try {
          await tx(ctx, async c => {
            const live = await searchRow(ctx, id, c, true);
            if (live.status === "CANCELLED") await recordEconomicCancellationTx(ctx, live, q, c);
          });
        } catch (error) {
          if (error instanceof DatabaseExecutionDeadlineError) throw error;
          // An instrumentation failure cannot undo or misreport a committed
          // original cancellation. Its absence is explicit, never zero cost.
          try { await tx(ctx, c => persistNativeGapTx(ctx, s, c, { kind: "CANCELLATION_OBSERVATION_UNAVAILABLE",
            subjectRef: s.id, contextRef: "original-search:" + s.id, evidenceRefs: ["p2-search:" + s.id] })); } catch { /* Original rows remain durable. */ }
          return { ...result, body: { ...(result.body as object), w1Measurement: { status: "UNAVAILABLE",
            predicate: predicate(error), originalCancellationRetained: true, value: null } } };
        }
      }
      return result;
    }
    return { status: 404, body: { code: "NOT_FOUND" } };
  } catch (error) {
    if (error instanceof DatabaseExecutionDeadlineError) throw error;
    if (error && typeof error === "object" && "code" in error && error.code === "PE_ENTITY_NOT_FOUND")
      return { status: 404, body: { code: "PE_ENTITY_NOT_FOUND", error: "Economic orchestration unavailable in authenticated scope" } };
    if (error instanceof z.ZodError) return { status: 400, body: { code: "W1_SCHEMA_INVALID", predicate: "BOUNDED_NATIVE_W1_REQUEST_REQUIRED" } };
    return { status: 422, body: { code: "W1_PREDICATE_UNPASSED", predicate: predicate(error), evidenceDigest: sha(predicate(error)) } };
  }
}
function predicate(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{0,159}$/.test(error.message) ? error.message : "W1_NATIVE_OWNER_OR_CHECK_PREDICATE_UNPASSED";
}

import type { PoolClient } from "pg";
import type { PeMutationContext } from "../types";
import type { SearchRow } from "../compute-search/contracts";
import { meterSchema } from "./contracts";
import { NATIVE_CONTINUATION_LIMITS } from "./continuation-contracts";

export function orderedNativeLockIds(ids: string[]): string[] {
  return [...new Set(ids.map(id => BigInt(id).toString()))].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
}
/** Principal gate precedes the complete sorted actual PostgreSQL bigint set.
 * The two-int gate uses PostgreSQL's separate advisory-lock namespace. */
export async function lockNativeContextsTx(ctx: PeMutationContext, c: PoolClient, contexts: string[]): Promise<string[]> {
  const { principal } = await import("../evidence-execution/store");
  await c.query("SELECT pg_advisory_xact_lock(1462840910,hashtext($1))", [ctx.auth.tenantId + ":" + principal(ctx)]);
  const rows = (await c.query("SELECT DISTINCT hashtextextended(context_key,0)::text lock_id FROM unnest($1::text[]) AS locks(context_key)", [[...new Set(contexts)]] )).rows;
  const ids = orderedNativeLockIds(rows.map(row => String(row.lock_id)));
  for (const id of ids) await c.query("SELECT pg_advisory_xact_lock($1::bigint)", [id]);
  return ids;
}
export function gapReasonsForAttempt(attempt: { status: string; body: Record<string, unknown> }): string[] {
  const result: string[] = [], meter = meterSchema.safeParse(attempt.body.w1Meter);
  if (!meter.success) result.push("MISSING_ROOT_METER");
  else result.push("ROOT_LIFETIME_RSS_NOT_INTERVAL_OR_CHILD_PEAK");
  if (["INTENT", "SUBMITTED"].includes(attempt.status)) result.push("PHYSICAL_MEASUREMENT_NOT_FINAL");
  if (attempt.status === "UNKNOWN") result.push("UNKNOWN_PHYSICAL_DISPOSITION");
  if (attempt.body.costUSD === null || attempt.body.costUSD === undefined) result.push("UNKNOWN_MONETARY_COST");
  if (!meter.success || meter.data.childCpuMs === null) result.push("UNMETERED_CHILD_CPU");
  if (!meter.success || meter.data.childPeakMemoryBytes === null) result.push("UNMETERED_CHILD_MEMORY");
  if (!Number.isSafeInteger(attempt.body.steps) || Number(attempt.body.steps) < 0) result.push("MISSING_ORIGINAL_STEP_DEBIT");
  result.push("UNMETERED_SUPERVISORY_AND_ENGINEERING_COST");
  return result;
}
export interface NativeGap { kind: string; subjectRef: string; contextRef: string; evidenceRefs: string[]; detail?: string }
export async function persistNativeGapTx(ctx: PeMutationContext, s: SearchRow, c: PoolClient, gap: NativeGap): Promise<string> {
  const { principal, sha, stable } = await import("../evidence-execution/store");
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(gap.kind) || gap.subjectRef.length > 1024 || gap.contextRef.length > 1024 ||
      gap.evidenceRefs.length > 16 || (gap.detail?.length ?? 0) > 2048) throw Error("W1_BOUNDED_MEASUREMENT_GAP_REQUIRED");
  await c.query("SELECT pg_advisory_xact_lock(1462840910,hashtext($1))", [s.tenant_id + ":" + principal(ctx)]);
  const idFor = (g: NativeGap) => "native-gap:" + sha({ search: s.id, kind: g.kind, subject: g.subjectRef, context: g.contextRef });
  let id = idFor(gap);
  if ((await c.query("SELECT id FROM finnor_os.w1_measurement_gaps WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND id=$4",
    [s.tenant_id, s.principal_id, s.id, id])).rowCount) return id;
  const count = Number((await c.query("SELECT count(*) n FROM finnor_os.w1_measurement_gaps WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3",
    [s.tenant_id, s.principal_id, s.id])).rows[0].n);
  if (count >= NATIVE_CONTINUATION_LIMITS.gaps) {
    gap = { kind: "GAP_RETENTION_BOUND", subjectRef: "original-physical-records-retained", contextRef: "original-search",
      evidenceRefs: ["p2-search:" + s.id], detail: "Further subjects remain in original P2 records; no costs or observations are erased." };
    id = idFor(gap);
  }
  const body = { schema: "finnor.w1.native-measurement-gap.v1", id, ...gap, value: null,
    observedAt: new Date().toISOString(), status: "AS_OF_EVIDENCE_GAP_NOT_A_CLAIM_OF_PERMANENT_ABSENCE",
    originalEpisodeRetained: true, originalRecordsRetained: true, authorityGranted: false };
  await c.query("INSERT INTO finnor_os.w1_measurement_gaps(tenant_id,principal_id,search_id,id,body,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING",
    [s.tenant_id, s.principal_id, s.id, id, stable(body), sha(body)]);
  return id;
}

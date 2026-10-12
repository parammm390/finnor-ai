import { AsyncLocalStorage } from "node:async_hooks";
import type { PeMutationContext } from "../types";
import { persistEconomicRecord, listStoredWorkCompute } from "../economic-store";
import { sha, tx, principal } from "../evidence-execution/store";

type Scope = { sourceAttempt: (grantId: string) => Promise<void>;
  checkerAttempt: () => Promise<void> };
const scope = new AsyncLocalStorage<Scope>();
const physicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const computePhases = ["COMPILE", "UPDATE_RECOGNITION", "PREPARATION", "RECOVERY"] as const;
export const withInstitutionMeter = <T>(input: Scope, run: () => Promise<T>) => scope.run(input, run);
export const recordInstitutionSourceAttempt = async (grantId: string) => { await scope.getStore()?.sourceAttempt(grantId); };
export const recordInstitutionCheckerAttempt = async () => { await scope.getStore()?.checkerAttempt(); };

/** Immutable S7 compute attribution uses physical delivery identities. Prices,
 * aggregate peak memory and human supervision remain unknown when unobserved. */
export async function persistInstitutionCompute(ctx: PeMutationContext, input: {
  requestId: string; workId: string; episodeId: string; jobId: string; deliveryAttemptId: string;
  parentReservation: { owner: string; id: string; version: string; contentDigest: string } | null;
  rightsRevision: string; startedAt: string; elapsedMs: number; status: string;
  phase: typeof computePhases[number]; observedAcquisitionAttempts: number; observedCheckerAttempts: number;
}) {
  if (!physicalUuid.test(input.deliveryAttemptId) || !physicalUuid.test(input.jobId)
      || !physicalUuid.test(input.requestId) || !computePhases.includes(input.phase)
      || !Number.isFinite(input.elapsedMs) || input.elapsedMs < 0)
    throw Error("X1_ACTUAL_PHYSICAL_COMPUTE_MEASUREMENT_REQUIRED");
  return persistEconomicRecord(ctx, { kind: "COMPUTE", rightsRef: `authority:${ctx.auth.tenantId}:${input.rightsRevision}`,
    idempotencyKey: `x1-compute:${input.deliveryAttemptId}:${input.phase}`,
    semanticRequestDigest: sha(["x1-physical-compute-v1", input.requestId, input.deliveryAttemptId, input.phase]),
    validAt: input.startedAt, horizon: "H0", uncertainty: "Observed physical work; money, aggregate memory and human cost incomplete",
    dependencies: input.parentReservation ? [input.parentReservation] : [],
    payload: { schema: "finnor.x1.native-compute.v1", ...input,
      process: { pid: process.pid, node: process.version, platform: process.platform, arch: process.arch,
        rssBytesAtObservation: process.memoryUsage().rss },
      money: null, moneyBasis: "ACTUAL_PRICE_UNAVAILABLE", humanSeconds: null,
      aggregatePeakMemoryBytes: null, modelCalls: [], costAllocation: "ONCE_PER_PHYSICAL_DELIVERY_UNDER_ORIGINAL_WORK_PARENT",
      businessWorkCredit: 0, qualification: "COMPUTE_ATTRIBUTION_NOT_FINANCIAL_VALUE_OR_CAPACITY_PROOF" } });
}

export async function readInstitutionComputeCosts(ctx: PeMutationContext, workId: string, compilerEpisodeId: string) {
  const native = await tx(ctx, async c => (await c.query<{ id: string }>(`SELECT id::text
    FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3`,
  [ctx.auth.tenantId, principal(ctx), workId])).rows[0], true);
  const episodeIds = [...new Set([compilerEpisodeId, ...(native ? [native.id] : [])])];
  const history = await listStoredWorkCompute(ctx, { workId, episodeIds, schema: "finnor.x1.native-compute.v1" });
  const seen = new Set<string>(), gaps: string[] = [], phases = new Map<string, { deliveries: number; attributedElapsedMs: number }>();
  const refs: Array<{ owner: "S7"; id: string; version: string; contentDigest: string }> = [];
  let attributedElapsedMs = 0, sampledProcessRssBytes = 0, rssSamples = 0;
  for (const record of history.records) {
    const p = record.payload;
    refs.push(record.ref);
    if (record.kind !== "COMPUTE" || p.workId !== workId || !episodeIds.includes(String(p.episodeId))
        || !physicalUuid.test(String(p.deliveryAttemptId)) || !physicalUuid.test(String(p.jobId))
        || !physicalUuid.test(String(p.requestId)) || typeof p.phase !== "string"
        || !(computePhases as readonly string[]).includes(p.phase)
        || typeof p.elapsedMs !== "number" || !Number.isFinite(p.elapsedMs) || p.elapsedMs < 0) {
      gaps.push(`X1_COMPUTE_MEASUREMENT_INVALID:${record.ref.id}`); continue;
    }
    const identity = JSON.stringify([p.deliveryAttemptId, p.phase]);
    if (seen.has(identity)) { gaps.push(`X1_COMPUTE_DELIVERY_DUPLICATE:${record.ref.id}`); continue; }
    seen.add(identity); attributedElapsedMs += p.elapsedMs;
    const phase = phases.get(p.phase) ?? { deliveries: 0, attributedElapsedMs: 0 };
    phase.deliveries++; phase.attributedElapsedMs += p.elapsedMs; phases.set(p.phase, phase);
    const rss = (p.process as { rssBytesAtObservation?: unknown } | undefined)?.rssBytesAtObservation;
    if (typeof rss === "number" && Number.isSafeInteger(rss) && rss >= 0) {
      rssSamples++;
      sampledProcessRssBytes = Math.max(sampledProcessRssBytes, rss);
    }
  }
  const meterGaps = await tx(ctx, async c => (await c.query<{ kind: string; body: unknown }>(`
    SELECT e.kind,e.body FROM finnor_os.x1_compiler_events e
      JOIN finnor_os.x1_compiler_requests r ON r.tenant_id=e.tenant_id AND r.id=e.request_id
      WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 AND r.episode_id=$4
        AND e.kind LIKE '%METER_GAP'
    UNION ALL
    SELECT e.kind,e.body FROM finnor_os.p1_events e
      JOIN finnor_os.p1_requests r ON r.tenant_id=e.tenant_id AND r.id=e.request_id
      WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.work_id=$3 AND r.episode_id::text=ANY($5::text[])
        AND e.kind LIKE '%METER_GAP' LIMIT 1025`,
  [ctx.auth.tenantId, principal(ctx), workId, compilerEpisodeId, episodeIds])).rows, true);
  if (!history.complete) gaps.push(history.reason!);
  if (meterGaps.length > 1024) gaps.push("X1_COMPUTE_METER_GAP_HISTORY_BOUND");
  return { basis: "EXISTING_S7_IMMUTABLE_PHYSICAL_DELIVERY_RECORDS", recordRefs: refs,
    registeredDeliveryPhases: seen.size, attributedElapsedMs, phases: Object.fromEntries(phases),
    sampledProcessRssBytes: rssSamples ? sampledProcessRssBytes : null,
    aggregatePeakMemoryBytes: null, monetaryCost: null, humanSeconds: null,
    coverage: "REGISTERED_NATIVE_COMPUTE_ONLY_OTHER_COSTS_UNKNOWN",
    status: "PARTIAL", gaps, meterGapEvents: meterGaps.slice(0, 1024),
    originalEpisodeIds: episodeIds, fullCostOrCapacityEstablished: false };
}

import { AsyncLocalStorage } from "node:async_hooks";
import type { PeMutationContext } from "../types";
import { persistEconomicRecord } from "../economic-store";
import { sha } from "../evidence-execution/store";

type Scope = { sourceAttempt: (grantId: string) => Promise<void>;
  checkerAttempt: () => Promise<void> };
const scope = new AsyncLocalStorage<Scope>();
export const withInstitutionMeter = <T>(input: Scope, run: () => Promise<T>) => scope.run(input, run);
export const recordInstitutionSourceAttempt = async (grantId: string) => { await scope.getStore()?.sourceAttempt(grantId); };
export const recordInstitutionCheckerAttempt = async () => { await scope.getStore()?.checkerAttempt(); };

/** Immutable S7 compute attribution uses physical delivery identities. Prices,
 * aggregate peak memory and human supervision remain unknown when unobserved. */
export async function persistInstitutionCompute(ctx: PeMutationContext, input: {
  requestId: string; workId: string; episodeId: string; jobId: string; deliveryAttemptId: string;
  parentReservation: { owner: string; id: string; version: string; contentDigest: string } | null;
  rightsRevision: string; startedAt: string; elapsedMs: number; status: string;
  phase: string; observedAcquisitionAttempts: number; observedCheckerAttempts: number;
}) {
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

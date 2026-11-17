/** Verification-process bounds, not additional product or episode resources. */
import assert from "node:assert/strict";

export const NATIVE_WORKER_LIMITS = Object.freeze({
  maximumTicks: 96,
  processMilliseconds: 60_000,
  batchMilliseconds: 20_000,
});

export async function drainNativeQueue(
  maximum: number,
  readPending: () => Promise<{ n: number; due: Date | null }>,
  runBatch: (remainingTicks: number, due: Date) => Promise<number>,
): Promise<void> {
  assert(Number.isSafeInteger(maximum) && maximum >= 1 && maximum <= NATIVE_WORKER_LIMITS.maximumTicks);
  let ticks = 0;
  for (;;) {
    const pending = await readPending();
    if (pending.n === 0) return;
    if (ticks === maximum) {
      throw new Error("W3_FINITE_QUEUE_PUMP_BOUND", { cause: { maximumTicks: maximum, usedTicks: ticks, pendingCount: pending.n } });
    }
    assert(pending.due instanceof Date && Number.isFinite(pending.due.getTime()), "W3_PENDING_QUEUE_DUE_TIME_REQUIRED");
    const used = await runBatch(maximum - ticks, pending.due);
    assert(Number.isSafeInteger(used) && used >= 1 && used <= maximum - ticks, "W3_BATCH_TICK_COUNT_INVALID");
    ticks += used;
  }
}

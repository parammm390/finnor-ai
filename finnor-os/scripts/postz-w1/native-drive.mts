import { strict as assert } from "node:assert";
import type pg from "pg";

/** Finite real queue driving. No due-date mutation or fixed-interval status polling:
 * an empty tick arms one timer for the next original durable run_at. */
const raced = <T,>(query: Promise<T>, signal: AbortSignal): Promise<T> => Promise.race([
  query,
  new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
]);

export async function driveNativeProgram(admin: pg.Client,
  queue: { tick(signal?: AbortSignal): Promise<boolean> }, programId: string, started: number) {
  const terminal = ["TESTED", "FAILED", "PARTIAL", "INVALIDATED", "CANCELLED"];
  for (let decision = 0; decision < 128; decision++) {
    const remaining = 120_000 - (performance.now() - started);
    assert(remaining > 0, "Finite native episode driver deadline");
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    const ran = await queue.tick(signal);
    // A physical status RPC is bounded by the same remaining-episode signal;
    // pg does not accept AbortSignal, so the driver stops waiting on abort.
    const parent = (await raced(admin.query("SELECT status FROM finnor_os.p1_requests WHERE id=$1", [programId]), signal)).rows[0];
    assert(parent, "Original P1 request required");
    // Never accept a terminal status observed after the episode deadline.
    assert(120_000 - (performance.now() - started) > 0, "W1_TERMINAL_STATUS_ACCEPTED_AFTER_DEADLINE");
    if (terminal.includes(parent.status)) return parent.status as string;
    if (!ran) {
      const next = (await admin.query(`SELECT extract(epoch FROM (min(run_at)-clock_timestamp()))*1000 AS wait_ms
        FROM finnor_os.jobs WHERE status='queued' AND type=ANY($1::text[])`,
        [["run_harness_program_v1", "run_evidence_derivation_v1", "run_compute_search_unit_v1"]])).rows[0];
      assert(next.wait_ms !== null, "W1_NO_ORIGINAL_SCHEDULED_CONTINUATION");
      // An empty actual queue tick also has a 2000ms claim-cache backoff.
      // A due job is not evidence that no original continuation exists.
      const waitMs = Math.max(2050, Math.ceil(Number(next.wait_ms)));
      assert(waitMs > 0 && waitMs < 120_000 - (performance.now() - started), "W1_NEXT_ORIGINAL_JOB_NOT_EXECUTABLE_WITHIN_DRIVER_BOUND");
      await new Promise<void>(resolve => setTimeout(resolve, waitMs));
    }
  }
  throw Error("W1_FINITE_REAL_QUEUE_DECISION_BOUND");
}

/** Failure-first boundary driver for native-drive.mts M4 (remaining-roots
 * failure contract v1). Drives the REAL driveNativeProgram against synthetic
 * clock/queue/admin fakes:
 * A: an unbounded physical status RPC must not hang the driver past the
 *    120s episode bound (watchdog observes M4_UNBOUNDED_PHYSICAL_STATUS_RPC).
 * B: a terminal status observed after the deadline must not be accepted as
 *    success (M4_TERMINAL_STATUS_ACCEPTED_AFTER_DEADLINE).
 * Status ALL_PASS only when both boundaries hold. */
import { driveNativeProgram } from "../../../finnor-os/scripts/postz-w1/native-drive.mjs";

type Row = { status: string };
const parentRow: Row = { status: "TESTED" };

async function caseUnboundedStatusRpc() {
  const started = performance.now() - 119_000; // 1s left in the episode
  const queue = { tick: async (signal?: AbortSignal) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 300);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); });
    }).catch(() => false);
    return true;
  } };
  const admin = { query: async () => new Promise<{ rows: Row[] }>(() => { /* physical RPC hangs */ }) };
  const watchdog = new Promise<string>((resolve) => setTimeout(() => resolve("WATCHDOG_3000MS"), 3_000));
  const outcome = await Promise.race([
    driveNativeProgram(admin as never, queue, "00000000-0000-4000-8000-000000000001", started)
      .then((status) => `RETURNED:${status}`)
      .catch((error) => `THREW:${error instanceof Error ? error.message : String(error)}`),
    watchdog,
  ]);
  const defect = outcome === "WATCHDOG_3000MS";
  return { case: "M4.unbounded-status-rpc", outcome,
    observed: defect ? "M4_UNBOUNDED_PHYSICAL_STATUS_RPC" : "BOUNDED_STATUS_RPC", defect };
}

async function caseTerminalAfterDeadline() {
  const started = performance.now() - 119_400; // 600ms left in the episode
  const queue = { tick: async (_signal?: AbortSignal) => {
    // A physical queue RPC that cannot be cancelled resolves past the bound.
    await new Promise((resolve) => setTimeout(resolve, 900));
    return true;
  } };
  const admin = { query: async () => ({ rows: [parentRow] }) };
  let outcome: string;
  try {
    outcome = `RETURNED:${await driveNativeProgram(admin as never, queue, "00000000-0000-4000-8000-000000000001", started)}`;
  } catch (error) {
    outcome = `THREW:${error instanceof Error ? error.message : String(error)}`;
  }
  const defect = outcome === "RETURNED:TESTED";
  return { case: "M4.terminal-after-deadline", outcome,
    observed: defect ? "M4_TERMINAL_STATUS_ACCEPTED_AFTER_DEADLINE" : "TERMINAL_STATUS_DEADLINE_RECHECKED", defect };
}

const cases = [await caseUnboundedStatusRpc(), await caseTerminalAfterDeadline()];
const defects = cases.filter((c) => c.defect).map((c) => c.case);
const result = { schema: "finnor.w1.native-drive-boundaries.v1", cases, defects,
  status: defects.length ? "DEFECTS_PRESENT" : "ALL_PASS" };
console.log(JSON.stringify(result, null, 2));
process.exit(defects.length ? 1 : 0);

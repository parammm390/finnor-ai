/** Disposable real-process SIGTERM and in-flight drain certification. */
import { JobQueue } from "../../../apps/worker/src/queue";
import { installWorkerDrainSignals } from "../../../apps/worker/src/drain-signals";
import { PRODUCTION_JOB_CONTRACTS, closePool } from "@finnor/db";
import { assertDisposableDatabaseTarget } from "../../../packages/db/production-target-guard";

const url = process.env.DATABASE_URL;
assertDisposableDatabaseTarget(url, "Scope-3 signal child");
if (process.env.FINNOR_SCOPE3_DISPOSABLE_DB !== "1" || !/^\/finnor_scope3_cert_[a-f0-9_]+$/.test(new URL(url).pathname)) {
  throw new Error("Scope-3 signal child requires the dedicated disposable database");
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const uninstall = installWorkerDrainSignals(controller);
  const queue = new JobQueue(`scope3:signal:${process.pid}`, 3, "INTERACTIVE");
  queue.register("process_instruction", async () => {
    process.stdout.write("IN_FLIGHT\n");
    await new Promise<void>((resolve) => {
      if (controller.signal.aborted) resolve();
      else controller.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
  }, PRODUCTION_JOB_CONTRACTS.process_instruction);
  try {
    await queue.runLoop(25, controller.signal, 1);
    process.stdout.write("DRAINED\n");
  } finally {
    uninstall();
    await closePool();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });

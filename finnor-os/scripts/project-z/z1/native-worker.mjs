/** One bounded actual queue worker, no scheduler, listener, seed or effects. */
import { JobQueue } from "../../../apps/worker/src/queue.ts";
import { getPool } from "../../../packages/db/index.ts";
import { PRODUCTION_JOB_CONTRACTS } from "../../../packages/db/compute-contract.ts";
import { createSharedWorkJobHandler, createSharedWorkProjectionJobHandler } from "../../../packages/orchestration/src/project-z/z1-shared-work/worker.ts";

const producer = "run_shared_work_program_v1", consumer = "consume_shared_work_projection_v1";
const originalCount = Number(process.env.FINNOR_Z1_ORIGINAL_WORK_COUNT ?? "3");
if (!process.send || process.env.FINNOR_Z1_NATIVE_AUTHORIZED !== "DISPOSABLE_ORIGINAL_Z1_EPISODE_ONLY" ||
    !/^[a-f0-9]{64}$/.test(process.env.FINNOR_Z1_RECOVERY_NONCE ?? "") ||
    !Number.isInteger(originalCount) || originalCount < 2 || originalCount > 1000) throw Error("OWNED_GUARDED_WORKER_ONLY");
const queue = new JobQueue(`z1-owned-proof:${process.pid}`, 30, "INTERACTIVE");
for (const [type, handler] of [[producer, createSharedWorkJobHandler()], [consumer, createSharedWorkProjectionJobHandler()]]) {
  const contract = PRODUCTION_JOB_CONTRACTS[type];
  if (!contract) throw Error("COORDINATOR_NATIVE_JOB_CONTRACT_NOT_INSTALLED");
  queue.register(type, handler, contract);
}
let stopped = false;
process.on("message", message => { if (message?.kind === "STOP") stopped = true; });
process.on("disconnect", () => { stopped = true; });
const deadline = Date.now() + (originalCount > 192 ? 590000 : 120000);
try {
  await queue.recoverExpiredRunningJobs();
  process.send({ kind: "READY", pid: process.pid });
  for (let tick = 0; !stopped && tick < Math.max(192, 4 * (originalCount + 1)) && Date.now() < deadline; tick++) {
    if (!await queue.tick()) await new Promise(resolve => setTimeout(resolve, 250));
  }
} catch {
  process.send?.({ kind: "FAILED", code: "BOUNDED_NATIVE_QUEUE_WORKER_FAILED", pid: process.pid });
  process.exitCode = 1;
} finally {
  await getPool().end();
  process.disconnect?.();
}

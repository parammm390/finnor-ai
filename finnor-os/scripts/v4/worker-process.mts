/** Dedicated disposable process using the actual physical queue, production
 * registry and production V4 handler. Never claims unrelated fixture intake jobs. */
import { JobQueue } from "../../apps/worker/src/queue";
import { PRODUCTION_JOB_CONTRACTS, closePool } from "@finnor/db";
import { runCapitalFormationJob } from "../../packages/private-equity/src/capital-formation/worker";

// The disposable database has the canonical pre-cutover monolith, not four
// fabricated compute-class heartbeats or an invented activation.
const queue = new JobQueue("v4-disposable:" + process.pid, 15, null);
queue.register("run_capital_formation_v1", runCapitalFormationJob, PRODUCTION_JOB_CONTRACTS.run_capital_formation_v1);
const begun = Date.now(), maximum = Number(process.env.FINNOR_V4_WORKER_WALL_SECONDS ?? 600) * 1000;
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });
process.send?.({ kind: "WORKER_READY", pid: process.pid, handler: "run_capital_formation_v1", physicalQueue: true });
try {
  while (!stopping && Date.now() - begun < maximum) {
    await queue.recoverExpiredRunningJobs();
    if (!await queue.tick()) await new Promise(resolve => setTimeout(resolve, 100));
  }
} finally { await closePool(); }

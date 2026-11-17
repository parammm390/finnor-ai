/** Real restricted production worker, with a bounded disposable process life. */
import { createWorker } from "../../apps/worker/src/index";
import { getPool, closePool } from "@finnor/db";
const maximum = Number(process.argv[2] ?? 1);
if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16) throw Error("W4_WORKER_TICK_BOUND");
try {
  for (let tick = 0; tick < maximum; tick++) {
    const began = performance.now();
    const role = (await getPool().query(`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (role.current_user !== "finnor_worker" || role.rolsuper || role.rolbypassrls) throw Error("W4_RESTRICTED_PHYSICAL_WORKER_REQUIRED");
    const queue = createWorker(), recovered = await queue.recoverExpiredRunningJobs(), worked = await queue.tick();
    console.log(JSON.stringify({ schema: "finnor.w4.worker-observation.v1", pid: process.pid, tick,
      registration: "ACTUAL_PRODUCTION_CREATE_WORKER", role, recovered, worked, elapsedMs: performance.now() - began }));
    if (!worked || performance.now() - began > 30000) break;
  }
} finally { await closePool() }

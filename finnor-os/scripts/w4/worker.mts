/** The disposable parent schedules bounded ticks on the real restricted production queue. */
import { on } from "node:events";
import { createWorker } from "../../apps/worker/src/index";
import { getPool, closePool } from "@finnor/db";
import { recoverStaleSteps } from "@finnor/workflow-runtime";

type WorkerRole = { current_user: string; rolsuper: boolean; rolbypassrls: boolean };
export type WorkerObservation = {
  schema: "finnor.w4.worker-observation.v1";
  pid: number;
  tick: number;
  registration: "ACTUAL_PRODUCTION_CREATE_WORKER";
  workloadClass: ReturnType<typeof createWorker>["workloadClass"];
  role: WorkerRole;
  recovered: number;
  steps: Awaited<ReturnType<typeof recoverStaleSteps>> | null;
  worked: boolean;
  elapsedMs: number;
};

if (!process.send || !process.connected) throw Error("W4_WORKER_CONTROL_REQUIRED");
const recoverTenant = process.argv.includes("--recover-workflow-steps") ? process.env.FINNOR_W3_TENANT : null;
if (recoverTenant === undefined) throw Error("W4_WORKER_RECOVERY_TENANT_REQUIRED");
try {
  const commands = on(process, "message", { close: ["disconnect"] });
  process.send("ready");
  for await (const [maximum] of commands) {
    if (maximum === "stop") break;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16) throw Error("W4_WORKER_TICK_BOUND");
    const observations: WorkerObservation[] = [];
    for (let tick = 0; tick < maximum; tick++) {
      const began = performance.now();
      const { rows } = await getPool().query<WorkerRole>(
        "SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
      const role = rows[0];
      if (role?.current_user !== "finnor_worker" || role.rolsuper || role.rolbypassrls)
        throw Error("W4_RESTRICTED_PHYSICAL_WORKER_REQUIRED");
      const queue = createWorker();
      const recovered = await queue.recoverExpiredRunningJobs();
      const steps = recoverTenant ? await recoverStaleSteps(recoverTenant) : null;
      const worked = await queue.tick();
      const elapsedMs = performance.now() - began;
      observations.push({ schema: "finnor.w4.worker-observation.v1", pid: process.pid, tick,
        registration: "ACTUAL_PRODUCTION_CREATE_WORKER", workloadClass: queue.workloadClass, role, recovered, steps, worked, elapsedMs });
      if (!worked || elapsedMs > 30000) break;
    }
    await new Promise<void>((resolve, reject) => {
      process.send!(observations, error => error ? reject(error) : resolve());
    });
  }
} finally {
  await closePool();
  if (process.connected) process.disconnect();
}

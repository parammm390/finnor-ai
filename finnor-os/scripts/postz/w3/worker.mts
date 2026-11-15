/** Disposable process wrapper, using the actual registry, queue and handlers. */
import { createWorker } from "../../../apps/worker/src/index";
import { closePool, getPool } from "@finnor/db";
import { recoverStaleSteps } from "@finnor/workflow-runtime";
import { createRequire } from "node:module";
import { NATIVE_WORKER_LIMITS } from "./worker-protocol.mts";
const args = process.argv.slice(2);
const parentGated = args.at(-1) === "--parent-gated";
if (parentGated) args.pop();
const maximumTicks = args.length === 0 ? 1
  : args.length === 2 && args[0] === "--maximum-ticks" && /^[1-9][0-9]*$/.test(args[1]!)
    ? Number(args[1]) : NaN;
if (!Number.isSafeInteger(maximumTicks) || maximumTicks < 1 || maximumTicks > NATIVE_WORKER_LIMITS.maximumTicks)
  throw Error("W3_WORKER_TICK_BOUND_INVALID");
if (parentGated && typeof process.send !== "function") throw Error("W3_WORKER_PARENT_IPC_REQUIRED");
let batchStarted: number | undefined;
try {
  for (let tick = 0; tick < maximumTicks; tick++) {
    const began = performance.now();
    if (process.env.FINNOR_W3_INSTALLED === "1")
      createRequire(import.meta.url)("@finnor/source-custody/installation.cjs").installedRuntime(true);
    const custodyCheckMs = process.env.FINNOR_W3_INSTALLED === "1" ? performance.now() - began : null;
    // The existing 60-second supervisor bounds startup and this entire batch.
    // The smaller work slice starts after its first mandatory full validation.
    batchStarted ??= performance.now();
    const role = (await getPool().query(`SELECT current_user,rolsuper,rolbypassrls
     FROM pg_roles WHERE rolname=current_user`)).rows[0];
    if (role?.current_user !== "finnor_worker" || role.rolsuper || role.rolbypassrls)
      throw Error("W3_RESTRICTED_PHYSICAL_WORKER_ROLE_REQUIRED");
    // Preserve the old per-tick authority/idle freshness. Only the physical
    // process and the existing metadata-sensitive byte-hash cache are reused.
    const queue = createWorker();
    const recovered = await queue.recoverExpiredRunningJobs();
    const steps = process.env.FINNOR_W3_TENANT ? await recoverStaleSteps(process.env.FINNOR_W3_TENANT) : null;
    if (parentGated) {
      const remaining = Math.floor(NATIVE_WORKER_LIMITS.batchMilliseconds - (performance.now() - batchStarted));
      if (remaining <= 0) break;
      const proceed = await new Promise<boolean>((accept, reject) => {
        const receive = (message: any) => {
          clearTimeout(timer); process.off("message", receive);
          if (message?.schema !== "finnor.w3.worker-scheduling.v1" || message.tick !== tick
            || !["CONTINUE", "STOP"].includes(message.action)) reject(Error("W3_WORKER_PARENT_ACK_INVALID"));
          else accept(message.action === "CONTINUE");
        };
        const timer = setTimeout(() => {
          process.off("message", receive); reject(Error("W3_WORKER_PARENT_ACK_TIME_BOUND"));
        }, remaining);
        process.on("message", receive);
        process.send!({ schema: "finnor.w3.worker-ready.v1", pid: process.pid, tick });
      });
      if (!proceed) break;
    }
    const worked = await queue.tick();
    console.log(JSON.stringify({ schema: "finnor.w3.worker-observation.v1", pid: process.pid,
      registration: "ACTUAL_PRODUCTION_CREATE_WORKER", role, recovered, steps, worked, tick,
      custodyCheckMs, elapsedMs: performance.now() - began }));
    if (!worked || performance.now() - batchStarted >= NATIVE_WORKER_LIMITS.batchMilliseconds) break;
  }
} finally { await closePool() }

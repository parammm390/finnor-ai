/** Scenario-owned delivery of the production worker's actual registration function. */
import { createWorker } from "../../../apps/worker/src/index";
import { closePool, getPool } from "@finnor/db";

const role = (await getPool().query(`SELECT current_user,rolsuper,rolbypassrls,
  pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker
  FROM pg_roles WHERE rolname=current_user`)).rows[0];
if (process.env.AUTH_DEV_BYPASS !== "0" || role.current_user !== "finnor_worker"
    || role.rolsuper || role.rolbypassrls || role.app_inherits_worker) throw Error("Z0_RESTRICTED_WORKER_ROLE_REQUIRED");

const controller = new AbortController(), queue = createWorker();
const stop = () => controller.abort();
process.once("SIGTERM", stop); process.once("SIGINT", stop);
console.log(JSON.stringify({ event: "Z0_WORKER_READY", pid: process.pid, role: role.current_user }));

// Reconcilable jobs whose lease expired go to quarantine through the queue's own
// recovery; they are never replayed blindly.
let recovering = false;
const recover = async () => {
  if (recovering || controller.signal.aborted) return;
  recovering = true;
  try {
    const count = await queue.recoverExpiredRunningJobs();
    if (count) console.log(JSON.stringify({ event: "Z0_EXPIRED_LEASE_RECOVERY", pid: process.pid, count }));
  } finally { recovering = false; }
};
const recoveryTimer = setInterval(() => { void recover().catch(e => console.error("recovery failed", e.message)); }, 2000);
try { await recover(); await queue.runLoop(200, controller.signal, 1); }
finally { clearInterval(recoveryTimer); await closePool(); }

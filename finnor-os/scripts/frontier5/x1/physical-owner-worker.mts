/** Physical delivery uses the production worker's actual registration function. */
import { createWorker } from "../../../apps/worker/src/index";
import { closePool, getPool } from "@finnor/db";
const role = (await getPool().query(`SELECT current_user,rolsuper,rolbypassrls,
  pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker
  FROM pg_roles WHERE rolname=current_user`)).rows[0];
if (process.env.AUTH_DEV_BYPASS !== "0" || role.current_user !== "finnor_worker"
    || role.rolsuper || role.rolbypassrls || role.app_inherits_worker) throw Error("X1_RESTRICTED_PHYSICAL_WORKER_ROLE_REQUIRED");
console.log(JSON.stringify({ event: "X1_PHYSICAL_WORKER_READY", pid: process.pid, role,
  authDevBypass: false, registration: "ACTUAL_PRODUCTION_CREATE_WORKER" }));
const controller = new AbortController(), queue = createWorker();
const stop = () => controller.abort();
process.once("SIGTERM", stop); process.once("SIGINT", stop);
const timer = setTimeout(stop, 600000);
try { await queue.runLoop(200, controller.signal, 1); }
finally { clearTimeout(timer); await closePool(); }

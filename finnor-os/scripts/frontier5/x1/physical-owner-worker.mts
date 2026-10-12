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
// The isolated environment has one worker. Reuse the production queue's actual
// conservative lease recovery; reconcilable jobs remain quarantined, never
// blindly replayed. This is the same recovery operation used by worker startup.
let recovering=false;
const recover=async()=>{if(recovering||controller.signal.aborted)return;recovering=true;
  try{const count=await queue.recoverExpiredRunningJobs();if(count)console.log(JSON.stringify({
    event:'X1_ACTUAL_EXPIRED_LEASE_RECOVERY',pid:process.pid,count}));}
  finally{recovering=false;}
};
const recoveryTimer=setInterval(()=>{void recover().catch(error=>console.error('Actual queue recovery failed',error.message));},2000);
try { await recover();await queue.runLoop(200, controller.signal, 1); }
finally { clearInterval(recoveryTimer);clearTimeout(timer); await closePool(); }

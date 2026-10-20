import { installedDevelopmentRuntime, assertInstalledDevelopmentSchema } from "../../../packages/private-equity/src/institution-program/installed-runtime";
import { setTimeout as delay } from 'node:timers/promises';

if (process.env.NODE_ENV === "production" || process.env.FINNOR_ENVIRONMENT === "production"
    || process.env.FINNOR_P4_PROFILE !== "ordinary_disposable" || process.env.AUTH_DEV_BYPASS !== "0")
  throw Error("X1_COMPILED_DEVELOPMENT_PROFILE_REQUIRED");
const installed = installedDevelopmentRuntime(true)!;
const database = new URL(process.env.DATABASE_URL ?? "");
if (!["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)) throw Error("X1_LOOPBACK_DATABASE_REQUIRED");
const { getPool, closePool } = await import("@finnor/db");
const role = (await getPool().query(`SELECT current_user,rolsuper,rolbypassrls,
  pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker
  FROM pg_roles WHERE rolname=current_user`)).rows[0];
if (!role || role.current_user !== "finnor_worker" || role.rolsuper || role.rolbypassrls || role.app_inherits_worker)
  throw Error("X1_RESTRICTED_COMPILED_WORKER_ROLE_REQUIRED");
assertInstalledDevelopmentSchema((await getPool().query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows.map(row => row.name), installed);
const { createWorker } = await import("./index");
const queue = createWorker(), controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGTERM", stop); process.once("SIGINT", stop);
const timer = setTimeout(stop, 600_000);
console.log(JSON.stringify({ event: "X1_PHYSICAL_WORKER_READY", compiled: true, pid: process.pid,
  role, manifestDigest: installed.manifestDigest,
  authDevBypass: false, registration: "ACTUAL_PRODUCTION_CREATE_WORKER" }));
let lastRecovery = 0;
try {
  if(process.env.FINNOR_X1_QUAL_NATIVE_CONTROL){
    const {runRegisteredNativeWorker}=await import('../../../scripts/frontier5/x1/qualification-native-worker.mjs');
    await runRegisteredNativeWorker(queue,controller.signal,{mode:'COMPILED_DEVELOPMENT',digest:installed.manifestDigest},
      ()=>{installedDevelopmentRuntime(true);});
  }else while (!controller.signal.aborted) {
    installedDevelopmentRuntime(true);
    if (Date.now() - lastRecovery >= 2000) {
      const count = await queue.recoverExpiredRunningJobs(); lastRecovery = Date.now();
      if (count) console.log(JSON.stringify({ event: "X1_ACTUAL_EXPIRED_LEASE_RECOVERY", pid: process.pid, count }));
    }
    if (!await queue.tick(controller.signal)) await delay(200, undefined, { signal: controller.signal })
      .catch(error => { if (!controller.signal.aborted) throw error; });
  }
} finally { clearTimeout(timer); await closePool(); }

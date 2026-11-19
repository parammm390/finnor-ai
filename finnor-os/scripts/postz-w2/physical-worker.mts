/** One disposable physical process, using production registration and claims. */
import { createWorker } from "../../apps/worker/src/index";
import { closePool, getPool } from "@finnor/db";
import { installedDevelopmentRuntime, assertInstalledDevelopmentSchema } from "../../packages/private-equity/src/institution-program/installed-runtime";
const installed = installedDevelopmentRuntime();
if (installed) {
  if (installed.manifest.schema !== "finnor.postz.w2.development-installation.v1" ||
      process.env.FINNOR_P4_PROFILE !== "ordinary_disposable" || process.env.NODE_ENV === "production")
    throw Error("W2_INSTALLED_DISPOSABLE_PROFILE_REQUIRED");
  assertInstalledDevelopmentSchema((await getPool().query("SELECT name FROM finnor_os._migrations ORDER BY name")).rows.map(row => row.name), installed);
}
const role = (await getPool().query(`SELECT current_user,rolsuper,rolbypassrls,
  pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker
  FROM pg_roles WHERE rolname=current_user`)).rows[0];
if (process.env.AUTH_DEV_BYPASS !== "0" || role.current_user !== "finnor_worker" ||
    role.rolsuper || role.rolbypassrls || role.app_inherits_worker) throw Error("W2_RESTRICTED_PHYSICAL_WORKER_REQUIRED");
const queue = createWorker(), controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGTERM", stop); process.once("SIGINT", stop);
const timer = setTimeout(stop, 600000);
console.log(JSON.stringify({ event: "W2_PHYSICAL_WORKER_READY", pid: process.pid, role,
  registration: "ACTUAL_PRODUCTION_CREATE_WORKER", authDevBypass: false }));
let lastRecovery = 0;
try {
  while (!controller.signal.aborted) {
    if (Date.now() - lastRecovery >= 1000) {
      const count = await queue.recoverExpiredRunningJobs(); lastRecovery = Date.now();
      if (count) console.log(JSON.stringify({ event: "W2_ACTUAL_EXPIRED_LEASE_RECOVERY", count, pid: process.pid }));
    }
    if (installed) installedDevelopmentRuntime(true);
    if (!await queue.tick(controller.signal))
      await new Promise<void>(resolve => setTimeout(resolve, 100));
  }
} finally { clearTimeout(timer); await closePool(); }

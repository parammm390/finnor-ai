/** Real canonical worker in a separate restricted-role process.
 * IPC controls only finite ticks/shutdown for disposable verification. */
import { createWorker } from "../../apps/worker/src/index";
import { getPool, closePool } from "@finnor/db";
import { getHeapStatistics } from "node:v8";
const queue = createWorker();
const role = (await getPool().query("SELECT current_user role")).rows[0].role;
process.send?.({ ready: true, registeredTypes: queue.registeredTypes(), role, pid: process.pid,
  execArgv: process.execArgv, heapLimitBytes: getHeapStatistics().heap_size_limit,
  rssBytes: process.memoryUsage().rss });
process.on("message", async (message: any) => {
  if (message.operation === "tick") {
    try { const recovered = await queue.recoverExpiredRunningJobs(); const claimed = await queue.tick(); process.send?.({ id: message.id, claimed, recovered }); }
    catch (e) { process.send?.({ id: message.id, error: String(e) }); }
  } else if (message.operation === "stop") {
    await closePool(); process.send?.({ id: message.id, stopped: true }); process.exit(0);
  }
});

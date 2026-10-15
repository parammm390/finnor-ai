/** Disposable driver for the real production registry and queue. */
import { createWorker } from "../../apps/worker/src/index";
import { closePool, withTenantTransaction } from "@finnor/db";

const [tenantId, principalId, sessionId, mode] = process.argv.slice(2);
if (!tenantId || !principalId || !sessionId || mode && !["ONE_DELIVERY", "RECOVER_ONLY"].includes(mode)) throw Error("REGISTERED_NATIVE_SESSION_REQUIRED");
const queue = createWorker();
try {
  if (mode === "RECOVER_ONLY") {
    console.log(JSON.stringify({ recovered: await queue.recoverExpiredRunningJobs() }));
  } else {
    for (let attempt = 0; attempt < 32; attempt++) {
      const ran = await queue.tick();
      const status = await withTenantTransaction(tenantId, { userId: principalId }, async (_db, c) =>
        (await c.query("SELECT status FROM finnor_os.application_semantics_sessions WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",
          [tenantId, principalId, sessionId])).rows[0]?.status);
      if (mode === "ONE_DELIVERY" || ["MODEL_READY", "COMPLETED", "UNKNOWN", "FAILED", "STALE", "BLOCKED", "CANCELLED"].includes(status)) break;
      if (!ran) throw Error("NATIVE_DURABLE_JOB_NOT_CLAIMABLE");
    }
  }
} finally { await closePool(); }

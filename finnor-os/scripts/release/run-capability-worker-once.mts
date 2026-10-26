import { randomUUID } from "node:crypto";
import { JobQueue } from "../../apps/worker/src/queue";
import { runCapabilityProvider } from "../../apps/worker/src/handlers/run-capability-provider";
import { PRODUCTION_JOB_CONTRACTS, getPool } from "../../packages/db/index";

if (process.env.NODE_ENV !== "test" || !/^postgres:\/\/finnor_worker:finnor_worker@127\.0\.0\.1:\d+\/finnor$/.test(process.env.DATABASE_URL ?? ""))
  throw new Error("DISPOSABLE_CAPABILITY_WORKER_ONLY");
const queue = new JobQueue(`disposable-child:${randomUUID()}`, 3, "HEAVY");
queue.register("run_capability_provider_v1", runCapabilityProvider, PRODUCTION_JOB_CONTRACTS.run_capability_provider_v1);
try { console.log(JSON.stringify({ workerId: queue.instanceId, worked: await queue.tick() })); }
finally { await getPool().end(); setTimeout(() => process.exit(), 2000); }

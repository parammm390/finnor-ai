/** Real worker registration and queue, with fixture-only loopback transport. */
import { createWorker } from "../../apps/worker/src/index";
import { closePool, getPool } from "@finnor/db";
import nodemailer from "nodemailer";
import { setEmailTransportForTesting } from "../../packages/tools/src/email";
import { setSourceAdapterForTesting } from "../../packages/tools/src/source-adapters";
import { assertDisposableDatabaseTarget } from "../../packages/db/production-target-guard";
import { observeOwnedSqlFailures } from "./sql-diagnostics.mts";
import { getHeapStatistics } from "node:v8";

assertDisposableDatabaseTarget(process.env.DATABASE_URL, "V1 owned worker");
if (process.env.NODE_ENV !== "test" || process.env.FINNOR_V1_PROFILE !== "ordinary_disposable") throw Error("V1_OWNED_WORKER_REQUIRED");
observeOwnedSqlFailures();
const port = Number(process.env.FINNOR_V1_SMTP_PORT);
if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) throw Error("OWNED_SMTP_PORT_REQUIRED");
const originalFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw Error("FIXTURE_EXTERNAL_NETWORK_FORBIDDEN");
  return originalFetch(input, init);
}) as typeof fetch;
setEmailTransportForTesting(nodemailer.createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true,
  connectionTimeout: 5000, socketTimeout: 12000 }));
setSourceAdapterForTesting("gmail", {
  provider: "gmail", scopes: ["sent_message_readback"],
  async readPage() { throw Error("ORIGINAL_SIGNED_V1_STATUS_INTERFACE_REQUIRED"); },
  async readObject() { return null; },
});
process.env.WORKER_JOB_LEASE_SECONDS = "10";
const queue = createWorker();
try {
  console.log(JSON.stringify({ boundary: "V1_WORKER_RESOURCE_CONTROL",
    observedAt: new Date().toISOString(),
    nodeOptions: process.env.NODE_OPTIONS ?? null, heapSizeLimitBytes: getHeapStatistics().heap_size_limit,
    actualProcessUsageAtQueueCreation: process.resourceUsage(), startupMemoryExcludedFromGrant: false }));
  const role = (await getPool().query("SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
  if (role.current_user !== "finnor_worker" || role.rolsuper || role.rolbypassrls) throw Error("ORDINARY_SEPARATE_V1_WORKER_REQUIRED");
  if (!queue.registeredTypes().includes("advance_bilateral_programme_v1") ||
    !queue.registeredTypes().includes("advance_primary_diligence_v1")) throw Error("FINAL_V1_V2_HANDLERS_NOT_REGISTERED");
  await queue.recoverExpiredRunningJobs();
  const claimed = await queue.tick();
  console.log(JSON.stringify({ workerRole: role, registeredV1: true, registeredV2: true, claimed }));
} finally { setEmailTransportForTesting(null); globalThis.fetch = originalFetch; await closePool(); }
process.exit(0);

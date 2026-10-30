/** Exclusive real queue runner. Guards precede all DB/native owner imports.
 * It never initializes a database, tenant, user, grant, listener or signer. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exactSourceHead } from "./source-identity";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
if (process.env.FINNOR_Z5_DISPOSABLE_AUTHORITY !== "EXPLICIT"
  || process.env.FINNOR_Z5_PROFILE !== "ordinary_disposable" || process.env.FINNOR_ENVIRONMENT !== "ordinary_disposable"
  || process.env.FINNOR_Z5_EXCLUSIVE_WORKER !== "1" || process.env.AUTH_DEV_BYPASS === "1"
  || process.env.NODE_ENV === "production" || !process.argv[2] || !path.isAbsolute(process.argv[2]))
  process.exit(2);
const authority = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  schema: string; repository: string; sourceHead: string; runId: string; expiresAt: string;
  database: { host: string; port: number; name: string; existingOnly: boolean };
  noLiveProviders: boolean; noRealFinancialEffects: boolean; exclusiveWorker: boolean;
};
if (authority.schema !== "finnor.z5.explicit-existing-disposable-authority.v1"
  || path.resolve(authority.repository) !== root || !Number.isFinite(Date.parse(authority.expiresAt)) || Date.parse(authority.expiresAt) <= Date.now()
  || !authority.noLiveProviders || !authority.noRealFinancialEffects || !authority.exclusiveWorker
  || !authority.database.existingOnly || !/^[-a-zA-Z0-9_]{1,128}$/.test(authority.database.name)
  || !["127.0.0.1", "::1", "localhost"].includes(authority.database.host)) process.exit(2);
const database = new URL(process.env.DATABASE_URL ?? "invalid:");
if (database.hostname !== authority.database.host || Number(database.port || 5432) !== authority.database.port
  || decodeURIComponent(database.pathname.slice(1)) !== authority.database.name) process.exit(2);
const head = await exactSourceHead(root);
if (head !== authority.sourceHead || !/^v22\./.test(process.version)) process.exit(2);
const { JobQueue } = await import("../../../apps/worker/src/queue");
const { PRODUCTION_JOB_CONTRACTS } = await import("../../../apps/worker/src/job-contracts");
const { linkInstitutionComponentsJob } = await import("../../../packages/private-equity/src/project-z/z5-institution-linker/worker");
const { getPool } = await import("../../../packages/db");
const registered = Reflect.get(PRODUCTION_JOB_CONTRACTS, "link_institution_components_v1");
if (!registered || registered.retrySafety !== "locally_idempotent" || registered.protocolVersions.length !== 1
  || registered.protocolVersions[0] !== 1 || registered.leaseRecovery !== "immediate_after_expiry")
  throw Error("Z5_COORDINATOR_APPLIED_EXACT_PRODUCTION_REGISTRY_REQUIRED");
const queue = new JobQueue("z5-owned:" + authority.runId + ":" + process.pid, 30, "INTERACTIVE");
queue.register("link_institution_components_v1", linkInstitutionComponentsJob, registered);
const abort = new AbortController();
process.once("SIGTERM", () => abort.abort()); process.once("SIGINT", () => abort.abort());
try { await queue.runLoop(250, abort.signal, 1); }
finally { await getPool().end(); }

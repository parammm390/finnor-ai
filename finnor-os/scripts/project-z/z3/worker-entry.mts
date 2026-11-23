/** Isolated Z3 disposable-proof worker entry (owned leaf, not the production
 * worker). Exactly the two Z3 handlers on one owned queue: no scheduler, no
 * SSE, no proactive scans, no recovery sweep — a physically killed job stays
 * "running" with a dead lease as durable evidence, and readViabilityPublic
 * reports it as a superseded delivery. Refuses production and auth bypass.
 *
 * The coordinator supplies the absolute source entry and runs it with this
 * installation's own tsx. Single-file bundling would break native source
 * identity and is not used. A short 30s lease (the
 * queue's non-test floor) keeps the three kill points inside the proof's
 * finite 90s windows; production lease defaults are untouched.
 */
import { ensureSecretsLoaded } from "@finnor/security";
import { JobQueue } from "../../../apps/worker/src/queue";
import { runZ3ViabilityRecoveryJob,
  runZ3ViabilitySynthesisJob } from "../../../packages/private-equity/src/project-z/z3-viability/worker";
import { viabilityRuntimeIdentity } from "../../../packages/private-equity/src/project-z/z3-viability/runtime";

if (process.env.AUTH_DEV_BYPASS) throw new Error("Z3 proof worker refuses an auth bypass");
let target: URL;
try { target = new URL(process.env.DATABASE_URL ?? ""); }
catch { throw new Error("Z3 proof worker requires an exact existing loopback database"); }
if (!["postgres:", "postgresql:"].includes(target.protocol) || !["127.0.0.1", "localhost"].includes(target.hostname)
  || process.env.DATABASE_URL !== process.env.FINNOR_Z3_DISPOSABLE_DATABASE_URL
  || process.env.SECRETS_PROVIDER !== "env" || process.env.FINNOR_SECRET_IDS
  || process.env.NODE_ENV === "production"
  || process.env.FINNOR_ENVIRONMENT !== "staging" || process.env.FINNOR_Z3_DISPOSABLE_RECOVERY !== "1"
  || process.env.FINNOR_Z3_AUTHORIZED_SOURCE !== (await viabilityRuntimeIdentity()).digest) {
  throw new Error("Z3 proof worker requires current-source-bound existing disposable authorization");
}
process.env.WORKER_JOB_LEASE_SECONDS = "30";

await ensureSecretsLoaded();
const queue = new JobQueue();
queue.register("run_z3_viability_synthesis_v1", runZ3ViabilitySynthesisJob,
  { protocolVersions: [1], retrySafety: "reconcilable" });
queue.register("run_z3_viability_recovery_v1", runZ3ViabilityRecoveryJob,
  { protocolVersions: [1], retrySafety: "reconcilable" });
const controller = new AbortController();
process.on("SIGTERM", () => controller.abort());
process.on("SIGINT", () => controller.abort());
await queue.runLoop(500, controller.signal, 1);
process.exit(0);

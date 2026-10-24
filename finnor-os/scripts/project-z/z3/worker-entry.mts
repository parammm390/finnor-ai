/** Isolated Z3 disposable-proof worker entry (owned leaf, not the production
 * worker). Exactly the two Z3 handlers on one owned queue: no scheduler, no
 * SSE, no proactive scans, no recovery sweep — a physically killed job stays
 * "running" with a dead lease as durable evidence, and readViabilityPublic
 * reports it as a superseded delivery. Refuses production and auth bypass.
 *
 * The coordinator's disposable authorization supplies this entry's BUNDLED
 * absolute path as workerEntry (plain Node cannot execute TypeScript); the
 * esbuild bundle command and its digest are recorded in
 * scope-z/phase-evidence/z3/integration-patches/. A short 30s lease (the
 * queue's non-test floor) keeps the three kill points inside the proof's
 * finite 90s windows; production lease defaults are untouched.
 */
import "dotenv/config";
import { ensureSecretsLoaded } from "@finnor/security";
import { JobQueue } from "../../../apps/worker/src/queue";
import { runZ3ViabilityRecoveryJob,
  runZ3ViabilitySynthesisJob } from "../../../packages/private-equity/src/project-z/z3-viability/worker";

if (process.env.AUTH_DEV_BYPASS) throw new Error("Z3 proof worker refuses an auth bypass");
if (process.env.FINNOR_ENVIRONMENT === "production") throw new Error("Z3 proof worker is disposable-only");
process.env.WORKER_JOB_LEASE_SECONDS ??= "30";

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

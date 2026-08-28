import { CURRENT_MIGRATION_HEAD } from "@finnor/db";
import { ensureSecretsLoaded, secretProviderStatus } from "@finnor/security";
import { getReleaseMetadata } from "../../../lib/release";
import { readWorkerFleetReadiness } from "../../../lib/worker-readiness";

/** Dependency readiness, deliberately separate from /api/health liveness. Optional
 * provider connections are tenant-level degradation and never make the whole API
 * unready; Postgres, the migration contract, a current worker, and the configured
 * secret backend are process-level dependencies. */
export async function GET(): Promise<Response> {
  const checks: Record<string, { ok: boolean; detail?: string | number }> = {};
  try {
    const readiness = await readWorkerFleetReadiness();
    checks.database = { ok: true };
    checks.migrations = { ok: readiness.migrationHead === CURRENT_MIGRATION_HEAD, detail: readiness.migrationHead ?? "none" };
    checks.workerFleet = { ok: readiness.healthyWorkers > 0, detail: readiness.healthyWorkers };
  } catch {
    checks.database = { ok: false, detail: "unavailable" };
    checks.migrations = { ok: false, detail: "unknown" };
    checks.workerFleet = { ok: false, detail: 0 };
  }

  try {
    await ensureSecretsLoaded();
    const status = secretProviderStatus();
    checks.secrets = {
      ok: process.env.NODE_ENV !== "production" || status.provider === "aws-secrets-manager",
      detail: status.provider,
    };
  } catch {
    checks.secrets = { ok: false, detail: "unavailable" };
  }

  const ok = Object.values(checks).every((check) => check.ok);
  return Response.json(
    { ok, service: "finnor-api", checks, provenance: getReleaseMetadata("finnor-api") },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}

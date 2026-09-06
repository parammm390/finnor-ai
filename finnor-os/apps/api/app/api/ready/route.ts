import { CURRENT_MIGRATION_HEAD, readProductRuntimeAuthority, recordCutoverCompatibleHeartbeat } from "@finnor/db";
import { ensureSecretsLoaded, secretProviderStatus } from "@finnor/security";
import { getReleaseMetadata } from "../../../lib/release";
import { readWorkerFleetReadiness } from "../../../lib/worker-readiness";

/** Dependency readiness, deliberately separate from /api/health liveness. Optional
 * provider connections are tenant-level degradation and never make the whole API
 * unready; Postgres, the migration contract, a current worker, and the configured
 * secret backend are process-level dependencies. */
export async function GET(): Promise<Response> {
  const checks: Record<string, { ok: boolean; detail?: string | number }> = {};
  const release = getReleaseMetadata("finnor-api");
  try {
    const readiness = await readWorkerFleetReadiness();
    const authority = await readProductRuntimeAuthority();
    checks.database = { ok: true };
    checks.migrations = { ok: readiness.migrationHead === CURRENT_MIGRATION_HEAD, detail: readiness.migrationHead ?? "none" };
    checks.workerFleet = { ok: readiness.healthyWorkers > 0, detail: readiness.healthyWorkers };
    checks.productAuthority = { ok: authority.activeProductVertical === "private_equity", detail: authority.state };
    await recordCutoverCompatibleHeartbeat({
      service: "api",
      instanceId: process.env.VERCEL_DEPLOYMENT_ID ?? process.env.FINNOR_API_INSTANCE_ID ?? `api:${process.pid}`,
      releaseSha: release.commitSha,
      buildId: release.buildId,
      version: release.version,
      releaseSource: release.source,
      coreCertificationId: release.coreCertificationId,
      migrationHead: CURRENT_MIGRATION_HEAD,
      deploymentId: release.deploymentId,
      capabilities: ["api", "private-equity", "historical-read"],
      environment: release.environment,
    });
  } catch {
    checks.database = { ok: false, detail: "unavailable" };
    checks.migrations = { ok: false, detail: "unknown" };
    checks.workerFleet = { ok: false, detail: 0 };
    checks.productAuthority = { ok: false, detail: "unavailable" };
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
    { ok, service: "finnor-api", checks, provenance: release },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}

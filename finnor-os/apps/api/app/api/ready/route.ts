import {
  CURRENT_MIGRATION_HEAD,
  PHASE5_CUTOVER_PROTOCOL,
  readProductRuntimeAuthoritySnapshot,
  recordCutoverCompatibleHeartbeat,
  type ProductRuntimeAuthoritySnapshot,
} from "@finnor/db";
import { ensureSecretsLoaded, secretProviderStatus } from "@finnor/security";
import { evaluateFinalPeReadiness, explicitDeploymentEnvironment } from "../../../lib/product-readiness";
import { getReleaseMetadata } from "../../../lib/release";
import { readWorkerFleetReadiness, type WorkerFleetReadiness } from "../../../lib/worker-readiness";

type ReadinessCheck = { ok: boolean; detail?: unknown };

/** Dependency readiness, deliberately separate from /api/health liveness. Optional
 * provider connections are tenant-level degradation and never make the whole API
 * unready; Postgres, the migration contract, a current worker, and the configured
 * secret backend are process-level dependencies. */
export async function GET(): Promise<Response> {
  const checks: Record<string, ReadinessCheck> = {};
  const release = getReleaseMetadata("finnor-api");
  const expectedReleaseSha = release.traceable ? release.commitSha : null;
  let authority: ProductRuntimeAuthoritySnapshot | null = null;
  let fleet: WorkerFleetReadiness | null = null;

  try {
    authority = await readProductRuntimeAuthoritySnapshot();
    checks.database = { ok: true };
  } catch {
    checks.database = { ok: false, detail: "unavailable" };
  }

  if (
    authority
    && authority.epoch >= PHASE5_CUTOVER_PROTOCOL
    && authority.minimumCutoverProtocol >= PHASE5_CUTOVER_PROTOCOL
    && authority.activeProductVertical === "private_equity"
    && ["preparing", "water_intake_frozen", "water_retired"].includes(authority.state)
  ) {
    try {
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
      checks.runtimeHeartbeat = { ok: true };
    } catch {
      checks.runtimeHeartbeat = { ok: false, detail: "unavailable" };
    }
  } else {
    checks.runtimeHeartbeat = { ok: false, detail: "product authority is not executable" };
  }

  if (checks.database.ok) {
    try {
      fleet = await readWorkerFleetReadiness(expectedReleaseSha);
      checks.migrations = { ok: fleet.migrationHead === CURRENT_MIGRATION_HEAD, detail: fleet.migrationHead ?? "none" };
      checks.workerFleet = {
        ok: fleet.healthyWorkers > 0,
        detail: { compatibleWorkers: fleet.healthyWorkers, freshRuntimes: fleet.freshRuntimes },
      };
    } catch {
      checks.migrations = { ok: false, detail: "unknown" };
      checks.workerFleet = { ok: false, detail: { compatibleWorkers: 0, freshRuntimes: 0 } };
    }
  } else {
    checks.migrations = { ok: false, detail: "unknown" };
    checks.workerFleet = { ok: false, detail: { compatibleWorkers: 0, freshRuntimes: 0 } };
  }

  const finalPe = evaluateFinalPeReadiness({
    explicitEnvironment: explicitDeploymentEnvironment(),
    authority,
    fleet,
    expectedReleaseSha,
    releaseTraceable: release.traceable,
  });
  checks.productAuthority = {
    ok: finalPe.productAuthority,
    detail: {
      state: authority?.state ?? null,
      activeProductVertical: authority?.activeProductVertical ?? null,
      epoch: authority?.epoch ?? null,
      minimumCutoverProtocol: authority?.minimumCutoverProtocol ?? null,
      waterIntakeFrozenAt: authority?.waterIntakeFrozenAt ?? null,
      waterRetiredAt: authority?.waterRetiredAt ?? null,
      finalPeGateRequired: finalPe.finalPeGateRequired,
    },
  };
  checks.runtimeEpoch = {
    ok: finalPe.runtimeEpoch,
    detail: {
      productEpochs: fleet?.productEpochs ?? [],
      mixedRuntimes: fleet?.mixedProductEpochRuntimes ?? null,
      expectedEpoch: authority?.epoch ?? null,
    },
  };
  checks.runtimeRelease = {
    ok: finalPe.runtimeRelease,
    detail: {
      releaseShas: fleet?.releaseShas ?? [],
      mixedRuntimes: fleet?.mixedReleaseRuntimes ?? null,
      mixedMigrationRuntimes: fleet?.mixedMigrationRuntimes ?? null,
      incompatibleProtocolRuntimes: fleet?.incompatibleProtocolRuntimes ?? null,
      expectedReleaseSha,
    },
  };

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

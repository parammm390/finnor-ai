import type { ProductRuntimeAuthoritySnapshot } from "@finnor/db";
import type { WorkerFleetReadiness } from "./worker-readiness";

export interface FinalPeReadinessInput {
  explicitEnvironment: string | null;
  authority: ProductRuntimeAuthoritySnapshot | null;
  fleet: WorkerFleetReadiness | null;
  expectedReleaseSha: string | null;
  releaseTraceable: boolean;
}

export interface FinalPeReadinessEvaluation {
  finalPeGateRequired: boolean;
  productAuthority: boolean;
  runtimeEpoch: boolean;
  runtimeRelease: boolean;
}

/** Only an explicitly deployed production environment gets the final-PE gate.
 * NODE_ENV is intentionally excluded: local `next build/start` also sets it to
 * production and must not require a fabricated retired authority. */
export function isFinalPeProductionEnvironment(explicitEnvironment: string | null): boolean {
  return explicitEnvironment?.trim().toLowerCase() === "production";
}

export function evaluateFinalPeReadiness(input: FinalPeReadinessInput): FinalPeReadinessEvaluation {
  const finalPeGateRequired = isFinalPeProductionEnvironment(input.explicitEnvironment);
  const productAuthority = input.authority !== null
    && input.authority.activeProductVertical === "private_equity"
    && (!finalPeGateRequired || input.authority.state === "water_retired");

  if (!finalPeGateRequired) {
    return { finalPeGateRequired, productAuthority, runtimeEpoch: true, runtimeRelease: true };
  }

  const fleet = input.fleet;
  const runtimeEpoch = fleet !== null
    && fleet.freshRuntimes > 0
    && fleet.productEpochs.length === 1
    && fleet.productEpochs[0] === input.authority?.epoch
    && fleet.mixedProductEpochRuntimes === 0;
  const runtimeRelease = fleet !== null
    && input.releaseTraceable
    && input.expectedReleaseSha !== null
    && fleet.freshRuntimes > 0
    && fleet.releaseShas.length === 1
    && fleet.releaseShas[0] === input.expectedReleaseSha
    && fleet.mixedReleaseRuntimes === 0
    && fleet.mixedMigrationRuntimes === 0
    && fleet.incompatibleProtocolRuntimes === 0;

  return { finalPeGateRequired, productAuthority, runtimeEpoch, runtimeRelease };
}

export function explicitDeploymentEnvironment(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.FINNOR_ENVIRONMENT?.trim() || env.VERCEL_ENV?.trim() || null;
}

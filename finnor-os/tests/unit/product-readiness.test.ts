import { describe, expect, it } from "vitest";
import { evaluateFinalPeReadiness, explicitDeploymentEnvironment } from "../../apps/api/lib/product-readiness";
import type { ProductRuntimeAuthoritySnapshot } from "@finnor/db";
import { CURRENT_MIGRATION_HEAD } from "../../packages/db/migration-head";
import type { WorkerFleetReadiness } from "../../apps/api/lib/worker-readiness";

const SHA = "a".repeat(40);
const retiredAuthority: ProductRuntimeAuthoritySnapshot = {
  epoch: 5,
  state: "water_retired",
  activeProductVertical: "private_equity",
  minimumCutoverProtocol: 5,
  waterIntakeFrozenAt: "2026-01-01T00:00:00.000Z",
  waterRetiredAt: "2026-01-01T00:01:00.000Z",
};
const convergedFleet: WorkerFleetReadiness = {
  migrationHead: CURRENT_MIGRATION_HEAD,
  healthyWorkers: 1,
  freshRuntimes: 5,
  releaseShas: [SHA],
  productEpochs: [5],
  mixedReleaseRuntimes: 0,
  mixedProductEpochRuntimes: 0,
  mixedMigrationRuntimes: 0,
  incompatibleProtocolRuntimes: 0,
};

function evaluate(overrides: Partial<Parameters<typeof evaluateFinalPeReadiness>[0]> = {}) {
  return evaluateFinalPeReadiness({
    explicitEnvironment: "production",
    authority: retiredAuthority,
    fleet: convergedFleet,
    expectedReleaseSha: SHA,
    releaseTraceable: true,
    ...overrides,
  });
}

describe("P8 final PE production readiness", () => {
  it.each(["preparing", "water_intake_frozen"])("rejects %s authority", (state) => {
    expect(evaluate({ authority: { ...retiredAuthority, state } }).productAuthority).toBe(false);
  });

  it("rejects a wrong active vertical and a missing authority row", () => {
    expect(evaluate({ authority: { ...retiredAuthority, activeProductVertical: "water" } }).productAuthority).toBe(false);
    expect(evaluate({ authority: null }).productAuthority).toBe(false);
  });

  it("rejects mixed product epochs", () => {
    const result = evaluate({
      fleet: { ...convergedFleet, productEpochs: [4, 5], mixedProductEpochRuntimes: 1 },
    });
    expect(result.runtimeEpoch).toBe(false);
  });

  it("rejects mixed releases, migrations, and cutover protocols", () => {
    for (const fleet of [
      { ...convergedFleet, releaseShas: [SHA, "b".repeat(40)], mixedReleaseRuntimes: 1 },
      { ...convergedFleet, mixedMigrationRuntimes: 1 },
      { ...convergedFleet, incompatibleProtocolRuntimes: 1 },
    ]) {
      expect(evaluate({ fleet }).runtimeRelease).toBe(false);
    }
  });

  it("accepts only a converged water_retired/private_equity production fleet", () => {
    expect(evaluate()).toEqual({
      finalPeGateRequired: true,
      productAuthority: true,
      runtimeEpoch: true,
      runtimeRelease: true,
    });
  });

  it("does not infer the final production gate from NODE_ENV", () => {
    expect(explicitDeploymentEnvironment({ NODE_ENV: "production" })).toBeNull();
    expect(evaluate({ explicitEnvironment: null, authority: { ...retiredAuthority, state: "preparing" }, fleet: null })).toEqual({
      finalPeGateRequired: false,
      productAuthority: true,
      runtimeEpoch: true,
      runtimeRelease: true,
    });
  });
});

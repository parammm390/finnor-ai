import { describe, expect, it } from "vitest";
import { assertKnownProductionMigrationLineage } from "../../packages/db/migrate";

describe("production migration lineage preflight", () => {
  it("accepts an older known subset and a fully applied release", () => {
    const available = ["0000_init.sql", "0001_local_app_role.sql", "0138_scope3_compute_plane.sql"];
    expect(() => assertKnownProductionMigrationLineage(available.slice(0, 2), available)).not.toThrow();
    expect(() => assertKnownProductionMigrationLineage(available, available)).not.toThrow();
    expect(() => assertKnownProductionMigrationLineage(
      ["0000_init.sql", "0102_product_truth_objective_realtime.sql", "0131_private_equity_release_baseline.sql"],
      available,
    )).not.toThrow();
  });

  it("fails closed on unfamiliar live migrations with stable, complete diagnostics", () => {
    expect(() => assertKnownProductionMigrationLineage(
      ["0900_unknown.sql", "0000_init.sql", "0140_unreviewed.sql", "0900_unknown.sql"],
      ["0000_init.sql", "0131_egress_bounded_read_indexes.sql"],
    )).toThrow(/0140_unreviewed\.sql, 0900_unknown\.sql/);
  });
});

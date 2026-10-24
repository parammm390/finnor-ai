import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-ignore Native ESM public finite fixture is outside the TS workspace.
import { publicProblem } from "../../scripts/y1/business-fixtures.mts";
import { constructEconomicTheoryAsync } from "../../packages/private-equity/src/economic-action-theory/constructor-process";

describe("economic construction process boundary", () => {
  it("keeps the parent event loop live during actual finite construction", async () => {
    const problem = publicProblem({ entityId: "00000000-0000-4000-8000-000000000001" },
      { startAt: "2026-01-01T00:00:00Z", endAt: "2027-01-01T00:00:00Z" }, "process");
    problem.meanings = problem.meanings.map(meaning => ({...meaning,
      sourceId:"00000000-0000-4000-8000-000000000002",
      versionId:"00000000-0000-4000-8000-000000000003",contentDigest:"a".repeat(64)}));
    let heartbeats = 0;
    const timer = setInterval(() => heartbeats++, 1);
    const started = performance.now();
    try {
      const result = await constructEconomicTheoryAsync(problem, Date.now() + 30_000);
      expect(result.status).toBe("CANDIDATE");
      expect(heartbeats).toBeGreaterThan(0);
      expect(result.candidate?.operators).toHaveLength(3);
      const directory = process.env.FINNOR_PRODUCTION_PREFLIGHT_EVIDENCE_DIR ?? join(tmpdir(), "finnor-constructor-process");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "constructor-liveness.json"), JSON.stringify({
        inputs: problem, steps: ["Start real constructor thread", "Count parent heartbeat turns", "Inspect finite construction output"],
        observed: { status: result.status, heartbeats, wallMs: performance.now() - started, result },
        rerun: "npm --prefix finnor-os test -- --run tests/integration/economic-constructor-process.test.ts",
      }, null, 2));
    } finally { clearInterval(timer); }
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { objectiveIterationJobKey } from "../../packages/orchestration/src/objective-loop";

const objectiveLoopSource = readFileSync(fileURLToPath(new URL("../../packages/orchestration/src/objective-loop.ts", import.meta.url)), "utf8");
const objectiveRouteSource = readFileSync(fileURLToPath(new URL("../../apps/api/app/api/objectives/route.ts", import.meta.url)), "utf8");

describe("production-correctness objective iteration delivery", () => {
  it("gives every recovery delivery a monotonic immutable identity", () => {
    const canonical = objectiveIterationJobKey("loop-1", 2, 3);
    const recovered = objectiveIterationJobKey("loop-1", 2, 3, "terminal-job-1");
    expect(canonical).toBe("objective:loop-1:revision:2:step:3");
    expect(recovered).toBe(`${canonical}:recovery-after:terminal-job-1`);
    expect(recovered).not.toBe(canonical);
  });

  it("commits the first Work transition and delivery inside objective creation and repairs both replay paths", () => {
    const start = objectiveLoopSource.slice(
      objectiveLoopSource.indexOf("export async function startWorkObjective"),
      objectiveLoopSource.indexOf("async function workerContext"),
    );
    expect(start).toContain("await db.insert(workEvents).values");
    expect(start).toContain("await scheduleIterationTx(db, created");
    expect(start).not.toContain("await transitionWork(");
    expect(objectiveRouteSource.match(/await ensureObjectiveIterationDelivery/g)).toHaveLength(2);
  });
});

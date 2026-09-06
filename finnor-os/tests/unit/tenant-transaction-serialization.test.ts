import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const transactionModules = [
  "../../packages/authority/src/index.ts",
  "../../packages/computer/src/repository.ts",
  "../../packages/orchestration/src/autonomy.ts",
  "../../packages/orchestration/src/durable-execution.ts",
  "../../packages/orchestration/src/event-waits.ts",
];

describe("tenant transaction-client serialization", () => {
  it.each(transactionModules)("does not issue concurrent queries in %s", async (path) => {
    const source = await readFile(new URL(path, import.meta.url), "utf8");

    expect(source).not.toContain("Promise.all");
  });
});

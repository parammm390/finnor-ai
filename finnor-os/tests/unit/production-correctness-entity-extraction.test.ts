import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractNamedExpressions } from "../../packages/orchestration/src/conversation-kernel";

const kernelSource = readFileSync(fileURLToPath(new URL("../../packages/orchestration/src/conversation-kernel.ts", import.meta.url)), "utf8");

describe("production-correctness entity expression extraction", () => {
  it.each([
    ["email jane smith", "jane smith", "party"],
    ["call JANE SMITH", "JANE SMITH", "party"],
    ["reschedule jane appointment", "jane", "appointment"],
    ["send the acme invoice", "acme", "invoice"],
  ])("extracts capitalization-independent targets from %s", (instruction, name, cue) => {
    expect(extractNamedExpressions(instruction)).toEqual(expect.arrayContaining([
      expect.objectContaining({ name, cue }),
    ]));
  });

  it("loads only request-scoped entity candidates without arbitrary tenant catalog caps", () => {
    const loader = kernelSource.slice(
      kernelSource.indexOf("async function loadCanonicalCatalog"),
      kernelSource.indexOf("function dedupeCatalog"),
    );

    expect(loader).not.toContain(".limit(2000)");
    expect(loader).toContain("expressionPredicate");
    expect(loader).toContain("idsFor(exactRefs");
    expect(loader).toContain("appointmentWhere");
    expect(loader).toContain("invoiceWhere");
    expect(loader).toContain("quoteWhere");
    expect(loader).toContain("proposalWhere");
  });

  it("discovers older exact references before the scoped catalog lookup", () => {
    const prepare = kernelSource.slice(kernelSource.indexOf("export async function prepareEmployeeConversationTurn"));
    expect(prepare.indexOf("searchEmployeeConversationMessages")).toBeGreaterThan(-1);
    expect(prepare.indexOf("resolutionSnapshotRefs(olderRelevantMessages)")).toBeGreaterThan(prepare.indexOf("searchEmployeeConversationMessages"));
    expect(prepare.indexOf("loadCanonicalCatalog(")).toBeGreaterThan(prepare.indexOf("resolutionSnapshotRefs(olderRelevantMessages)"));
    expect(prepare).toContain("directHistoryMatches");
  });
});

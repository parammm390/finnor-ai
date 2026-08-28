import { describe, expect, it } from "vitest";
import { isInstructionCancellationPayload } from "../../packages/orchestration/src/instruction-trace";

describe("instruction cancellation semantics", () => {
  it("recognizes instruction-level fences and canonical confirmations", () => {
    expect(isInstructionCancellationPayload({ fence: true, canonical: false })).toBe(true);
    expect(isInstructionCancellationPayload({ canonical: true })).toBe(true);
    expect(isInstructionCancellationPayload({ requestedBy: "owner" })).toBe(true);
  });

  it("does not widen a historical action rejection into global cancellation", () => {
    expect(isInstructionCancellationPayload({ actionId: "action-1" })).toBe(false);
    expect(isInstructionCancellationPayload({ actionId: "action-1", status: "rejected" })).toBe(false);
  });
});

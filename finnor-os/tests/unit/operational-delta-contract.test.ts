import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeOperationalCursor, encodeOperationalCursor, OperationalCursorError } from "../../packages/db/operational-deltas";

const SCOPE = "11111111-1111-4111-8111-111111111111";

describe("Phase 2 durable operational delta contract", () => {
  it("round-trips opaque bigint-safe cursors and rejects malformed input", () => {
    const cursor = encodeOperationalCursor(SCOPE, BigInt("9007199254740999"));
    expect(decodeOperationalCursor(cursor)).toEqual({ scope: SCOPE, seq: BigInt("9007199254740999") });
    expect(() => decodeOperationalCursor("1")).toThrow(OperationalCursorError);
    expect(() => decodeOperationalCursor(`${SCOPE}:-1`)).toThrow(OperationalCursorError);
  });
});

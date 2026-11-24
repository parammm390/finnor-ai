import { describe, expect, it } from "vitest"
import { z } from "zod"
import { CentropyApiError } from "./api"
import { userMessage } from "./user-message"

describe("userMessage", () => {
  it("hides schema failures behind the fallback", () => {
    let cause: unknown
    try { z.object({ works: z.array(z.string()) }).parse({}) } catch (error) { cause = error }
    expect(userMessage(cause, "Active Work unavailable")).toBe("Active Work unavailable")
  })

  it("hides raw JSON payloads", () => {
    expect(userMessage(new Error('{"code":"invalid_type"}'), "Search unavailable")).toBe("Search unavailable")
    expect(userMessage(new Error("  [ { } ]"), "Search unavailable")).toBe("Search unavailable")
  })

  it("keeps deliberate client messages", () => {
    expect(userMessage(new CentropyApiError("Sign in required", 401, false), "Unavailable")).toBe("Sign in required")
  })

  it("falls back for empty messages and non-errors", () => {
    expect(userMessage(new Error(""), "Unavailable")).toBe("Unavailable")
    expect(userMessage("boom", "Unavailable")).toBe("Unavailable")
    expect(userMessage(undefined, "Unavailable")).toBe("Unavailable")
  })
})

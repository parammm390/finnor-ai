import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry, IntegrationError } from "@finnor/tools";

describe("tool execution framework (§11–12, §22)", () => {
  it("rejects unknown tools with a typed result, not a throw", async () => {
    const reg = new ToolRegistry();
    const res = await reg.call("nope", {});
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown tool/);
  });

  it("validates input with zod before calling the integration", async () => {
    const run = vi.fn();
    const reg = new ToolRegistry();
    reg.register({
      name: "t",
      description: "",
      integration: "test",
      inputSchema: z.object({ phone: z.string() }),
      execution: { effect: "read_only", retrySafety: "repeatable", idempotency: { mode: "inherently_idempotent" }, verification: "none" },
      run,
    });
    const res = await reg.call("t", { phone: 42 });
    expect(res.ok).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("retries retryable failures with backoff, then reports integration unavailable (§30)", async () => {
    const reg = new ToolRegistry();
    const run = vi.fn().mockRejectedValue(new IntegrationError("test", "down", true));
    reg.register({
      name: "flaky",
      description: "",
      integration: "test",
      inputSchema: z.object({}),
      execution: { effect: "read_only", retrySafety: "repeatable", idempotency: { mode: "inherently_idempotent" }, verification: "none" },
      retryPolicy: { attempts: 3, baseDelayMs: 1, timeoutMs: 1000 },
      run,
    });
    const res = await reg.call("flaky", {});
    expect(run).toHaveBeenCalledTimes(3);
    expect(res.ok).toBe(false);
    expect(res.integrationUnavailable).toBe(true);
  });

  it("does not retry non-retryable errors", async () => {
    const reg = new ToolRegistry();
    const run = vi.fn().mockRejectedValue(new IntegrationError("test", "bad creds", false));
    reg.register({
      name: "fatal",
      description: "",
      integration: "test",
      inputSchema: z.object({}),
      execution: { effect: "read_only", retrySafety: "repeatable", idempotency: { mode: "inherently_idempotent" }, verification: "none" },
      retryPolicy: { attempts: 3, baseDelayMs: 1, timeoutMs: 1000 },
      run,
    });
    await reg.call("fatal", {});
    expect(run).toHaveBeenCalledTimes(1);
  });
});

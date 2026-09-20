// Observability — errorResponse() and ToolRegistry.call() must invoke Sentry on
// failure paths, no real DSN needed. @sentry/node's exports are non-configurable
// (vi.spyOn can't redefine them directly), so the whole module is mocked instead —
// same pattern secrets.test.ts already uses for @aws-sdk/client-secrets-manager.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";

function mockSentry() {
  const init = vi.fn();
  const addBreadcrumb = vi.fn();
  const captureException = vi.fn();
  const captureMessage = vi.fn();
  // A2.T2: errorResponse() now reads the correlation_id tag back off the current
  // scope (to attach it to the structured log line) — getScopeData().tags must
  // exist on the mock the same way it does on the real Scope.
  const setTag = vi.fn();
  const getScopeData = vi.fn(() => ({ tags: {} }));
  const getCurrentScope = vi.fn(() => ({ setTag, getScopeData }));
  vi.doMock("@sentry/node", () => ({ init, addBreadcrumb, captureException, captureMessage, getCurrentScope }));
  return { init, addBreadcrumb, captureException, captureMessage, getCurrentScope };
}

describe("observability — Sentry wiring", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.doUnmock("@sentry/node");
  });

  it("ToolRegistry.call() adds a breadcrumb and captures a message on failure", async () => {
    const { addBreadcrumb, captureMessage } = mockSentry();
    const { ToolRegistry } = await import("@finnor/tools");

    const reg = new ToolRegistry();
    reg.register({
      name: "always_fails",
      description: "",
      integration: "test",
      inputSchema: z.object({}).passthrough(),
      execution: { effect: "read_only", retrySafety: "repeatable", idempotency: { mode: "inherently_idempotent" }, verification: "none" },
      retryPolicy: { attempts: 1, baseDelayMs: 1, timeoutMs: 500 },
      async run() {
        throw new Error("boom");
      },
    });
    const result = await reg.call("always_fails", {});
    expect(result.ok).toBe(false);
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({ category: "tool", message: "always_fails" }));
    expect(captureMessage).toHaveBeenCalledWith("tool_failed:always_fails", expect.any(Object));
  });

  it("ToolRegistry.call() adds a breadcrumb (no captureMessage) on success", async () => {
    const { addBreadcrumb, captureMessage } = mockSentry();
    const { ToolRegistry } = await import("@finnor/tools");

    const reg = new ToolRegistry();
    reg.register({
      name: "always_succeeds",
      description: "",
      integration: "test",
      inputSchema: z.object({}).passthrough(),
      execution: { effect: "read_only", retrySafety: "repeatable", idempotency: { mode: "inherently_idempotent" }, verification: "none" },
      async run() {
        return { ok: true };
      },
    });
    await reg.call("always_succeeds", {});
    expect(addBreadcrumb).toHaveBeenCalledWith(expect.objectContaining({ category: "tool", message: "always_succeeds" }));
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("errorResponse() captures unexpected errors (not AuthError) via Sentry", async () => {
    const { captureException } = mockSentry();
    const { errorResponse } = await import("../../apps/api/lib/auth");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = errorResponse(new Error("unexpected"));
    expect(res.status).toBe(500);
    expect(captureException).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("errorResponse() does NOT report an AuthError to Sentry — expected auth failures aren't incidents", async () => {
    const { captureException } = mockSentry();
    const { errorResponse, AuthError } = await import("../../apps/api/lib/auth");

    const res = errorResponse(new AuthError("nope", 401));
    expect(res.status).toBe(401);
    expect(captureException).not.toHaveBeenCalled();
  });
});

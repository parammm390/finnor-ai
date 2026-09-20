// ToolRegistry PII minimization — a tool that opts in (piiAllowlist) must never see a
// field outside its declared allowlist; a tool that doesn't opt in keeps today's
// pass-through behavior unchanged (backward compatible, opt-in per tool).

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { ToolRegistry } from "@finnor/tools";

describe("ToolRegistry — PII minimization via piiAllowlist", () => {
  it("strips a disallowed field before run() is invoked when piiAllowlist is set", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true });
    const reg = new ToolRegistry();
    reg.register({
      name: "t",
      description: "",
      integration: "test",
      inputSchema: z.object({}).passthrough(),
      execution: { effect: "read_only", retrySafety: "repeatable", idempotency: { mode: "inherently_idempotent" }, verification: "none" },
      piiAllowlist: ["to", "subject"],
      run,
    });
    await reg.call("t", { to: "a@b.com", subject: "hi", ssn: "123-45-6789" });
    expect(run).toHaveBeenCalledWith({ to: "a@b.com", subject: "hi" });
  });

  it("tools without piiAllowlist keep today's pass-through behavior", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true });
    const reg = new ToolRegistry();
    reg.register({
      name: "t",
      description: "",
      integration: "test",
      inputSchema: z.object({}).passthrough(),
      execution: { effect: "read_only", retrySafety: "repeatable", idempotency: { mode: "inherently_idempotent" }, verification: "none" },
      run,
    });
    await reg.call("t", { to: "a@b.com", extra: "anything" });
    expect(run).toHaveBeenCalledWith({ to: "a@b.com", extra: "anything" });
  });

  it("an allowlisted field missing from input is simply omitted, never fabricated", async () => {
    const run = vi.fn().mockResolvedValue({ ok: true });
    const reg = new ToolRegistry();
    reg.register({
      name: "t",
      description: "",
      integration: "test",
      inputSchema: z.object({}).passthrough(),
      execution: { effect: "read_only", retrySafety: "repeatable", idempotency: { mode: "inherently_idempotent" }, verification: "none" },
      piiAllowlist: ["to", "subject", "cc"],
      run,
    });
    await reg.call("t", { to: "a@b.com", subject: "hi" });
    expect(run).toHaveBeenCalledWith({ to: "a@b.com", subject: "hi" });
  });
});

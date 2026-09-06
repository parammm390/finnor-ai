import { describe, it, expect } from "vitest";
import { VapiWebhookSchema } from "../../packages/policy-schema/src/index";

// Regression test for the zod call-object stripping bug (ground-truth §6 in
// jarvis-99-phase-10-16-execution-plan.md): the old `call` sub-schema was
// `z.object({ id: z.string() }).partial()` with NO .passthrough(), so zod's default
// unknown-key stripping deleted call.customer.number and call.phoneNumberId on every
// parse — silently breaking caller-identity resolution and tenant-by-phone routing.
describe("VapiWebhookSchema (call-object field preservation)", () => {
  const realisticToolCallsPayload = {
    message: {
      type: "tool-calls",
      call: {
        id: "call-abc123",
        phoneNumberId: "phone-xyz789",
        customer: { number: "+15551234567", name: "Jane Caller" },
        phoneNumber: { number: "+15559998888" },
        metadata: { pendingActionId: "action-1" },
      },
      toolCallList: [{ id: "tc-1", function: { name: "finnor_instruct", arguments: { instruction: "review the closing condition" } } }],
    },
  };

  it("preserves call.customer.number through parsing", () => {
    const parsed = VapiWebhookSchema.parse(realisticToolCallsPayload);
    expect(parsed.message.call?.customer?.number).toBe("+15551234567");
  });

  it("preserves call.phoneNumberId through parsing", () => {
    const parsed = VapiWebhookSchema.parse(realisticToolCallsPayload);
    expect(parsed.message.call?.phoneNumberId).toBe("phone-xyz789");
  });

  it("preserves call.phoneNumber.number (dialed number, expanded form)", () => {
    const parsed = VapiWebhookSchema.parse(realisticToolCallsPayload);
    expect(parsed.message.call?.phoneNumber?.number).toBe("+15559998888");
  });

  it("preserves call.metadata and call.id alongside the new fields", () => {
    const parsed = VapiWebhookSchema.parse(realisticToolCallsPayload);
    expect(parsed.message.call?.id).toBe("call-abc123");
    expect(parsed.message.call?.metadata).toEqual({ pendingActionId: "action-1" });
  });

  it("preserves unknown extra keys on call via passthrough (e.g. future Vapi fields)", () => {
    const parsed = VapiWebhookSchema.parse(realisticToolCallsPayload) as any;
    expect(parsed.message.call.customer.name).toBe("Jane Caller");
  });

  it("preserves the bounded causal envelope without requiring provider identifiers", () => {
    const parsed = VapiWebhookSchema.parse({
      message: {
        type: "end-of-call-report",
        call: {
          id: "call-causal-1",
          metadata: {
            direction: "outbound",
            agentKey: "deal-diligence",
            domainActionId: "action-causal-1",
            dealId: "deal-causal-1",
            requestId: "request-causal-1",
          },
        },
      },
    });
    expect(parsed.message.call?.metadata).toEqual({
      direction: "outbound",
      agentKey: "deal-diligence",
      domainActionId: "action-causal-1",
      dealId: "deal-causal-1",
      requestId: "request-causal-1",
    });
  });

  it("still accepts a payload with no call object at all", () => {
    const parsed = VapiWebhookSchema.parse({ message: { type: "status-update" } });
    expect(parsed.message.call).toBeUndefined();
  });
});

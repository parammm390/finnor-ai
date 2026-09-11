import { describe, expect, it } from "vitest";
import {
  requiredPlanningHealthCapability,
} from "@finnor/orchestration";

describe("Phase 6 current provider readiness", () => {
  it("does not invent an external provider dependency for internal messages", () => {
    expect(requiredPlanningHealthCapability("send_message", { channel: "internal" })).toBeNull();
  });

  it("maps email and voice actions to governed identity routes rather than notification providers", () => {
    expect(requiredPlanningHealthCapability("send_message", { channel: "email" })).toBe("governed_email");
    expect(requiredPlanningHealthCapability("notify_group", { channel: "email" })).toBe("governed_email");
    expect(requiredPlanningHealthCapability("place_call", {})).toBe("governed_voice");
  });

  it("recognizes the reserved SMS route as required health rather than silently treating it as provider-free", () => {
    expect(requiredPlanningHealthCapability("send_message", { channel: "sms" })).toBe("governed_sms");
    expect(requiredPlanningHealthCapability("notify_group", { channel: "sms" })).toBe("governed_sms");
  });
});

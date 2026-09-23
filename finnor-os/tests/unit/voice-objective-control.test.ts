import { describe, expect, it } from "vitest";
import { parseVoiceObjectiveCommand } from "../../apps/api/lib/voice-objective-command";

describe("voice objective control grammar", () => {
  it("recognizes explicit start, inspect, interruption, continuation, and redirect commands", () => {
    expect(parseVoiceObjectiveCommand("Own this objective: follow up with Avery until the outcome is recorded")).toEqual({ command: "start", objective: "follow up with Avery until the outcome is recorded" });
    expect(parseVoiceObjectiveCommand("Centropy, own this objective: follow up with Avery until the outcome is recorded")).toEqual({ command: "start", objective: "follow up with Avery until the outcome is recorded" });
    expect(parseVoiceObjectiveCommand("What is the objective status?")).toEqual({ command: "inspect" });
    expect(parseVoiceObjectiveCommand("Interrupt this objective")).toEqual({ command: "interrupt" });
    expect(parseVoiceObjectiveCommand("Resume the objective")).toEqual({ command: "continue" });
    expect(parseVoiceObjectiveCommand("Redirect this objective to verify the invoice instead")).toEqual({ command: "redirect", objective: "verify the invoice instead" });
  });

  it("does not reinterpret ordinary customer/action language as objective control", () => {
    expect(parseVoiceObjectiveCommand("Stop calling that customer")).toBeNull();
    expect(parseVoiceObjectiveCommand("Continue with the installation")).toBeNull();
    expect(parseVoiceObjectiveCommand("What is Avery's status? ")).toBeNull();
  });
});

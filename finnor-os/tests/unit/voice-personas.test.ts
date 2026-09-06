import { describe, expect, it } from "vitest";
import { agentKeyForPersona, VOICE_AGENT_KEYS } from "@finnor/tools";

describe("bounded voice persona attribution", () => {
  it("maps only source-owned personas to safe product keys", () => {
    expect(VOICE_AGENT_KEYS).toEqual(["jarvis"]);
    expect(agentKeyForPersona("main")).toBe("jarvis");
    expect(agentKeyForPersona("payment_collector")).toBeUndefined();
    expect(agentKeyForPersona("winback")).toBeUndefined();
  });

  it("does not create an agent edge for unknown or missing persona values", () => {
    expect(agentKeyForPersona("assistant-ready")).toBeUndefined();
    expect(agentKeyForPersona(undefined)).toBeUndefined();
  });
});

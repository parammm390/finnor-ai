// Critic — unconfigured state must be explicit and never attempt a real network call
// (same contract every other adapter holds), and the JSON-parsing contract must
// degrade to an honest "no verdict" rather than guessing, exactly like the planner
// treats its own malformed LLM output.

import { describe, it, expect, beforeEach } from "vitest";
import type { LLMProvider } from "@finnor/orchestration";

function fakeProvider(response: string): LLMProvider {
  return { name: "fake", complete: async () => response };
}

describe("critic — unconfigured state", () => {
  beforeEach(() => {
    delete process.env.AWS_BEDROCK_API_KEY;
  });

  it("criticConfigured reports false when no Bedrock key is set", async () => {
    const { criticConfigured } = await import("@finnor/orchestration");
    expect(criticConfigured()).toBe(false);
  });

  it("criticConfigured reports true once AWS_BEDROCK_API_KEY is set", async () => {
    process.env.AWS_BEDROCK_API_KEY = "test-key";
    const { criticConfigured } = await import("@finnor/orchestration");
    expect(criticConfigured()).toBe(true);
  });
});

describe("critic — reviewAction verdict parsing", () => {
  const input = {
    instruction: "Record a high-severity leverage finding for the Apex deal",
    actionType: "record_finding",
    payload: { severity: "high", statement: "Leverage exceeds the approved range" },
    summary: "Record the high-severity leverage finding for Apex.",
    reasoning: "The instruction names the deal, severity, and evidence statement.",
  };

  it("returns the parsed verdict when the model responds with clean JSON", async () => {
    const { reviewAction } = await import("@finnor/orchestration");
    const verdict = await reviewAction(input, fakeProvider('{"flagged": false, "reason": "Deal, severity, and statement match the instruction."}'));
    expect(verdict).toEqual({ flagged: false, reason: "Deal, severity, and statement match the instruction." });
  });

  it("surfaces a flagged verdict with its reason", async () => {
    const { reviewAction } = await import("@finnor/orchestration");
    const verdict = await reviewAction(
      { ...input, payload: { severity: "low", statement: "Leverage is within range" } },
      fakeProvider('{"flagged": true, "reason": "The drafted severity and evidence contradict the instruction."}'),
    );
    expect(verdict.flagged).toBe(true);
    expect(verdict.reason).toContain("contradict");
  });

  it("degrades to an honest unflagged default when the model response is not valid JSON", async () => {
    const { reviewAction } = await import("@finnor/orchestration");
    const verdict = await reviewAction(input, fakeProvider("not json at all"));
    expect(verdict.flagged).toBe(false);
    expect(verdict.reason).toMatch(/could not be parsed/i);
  });

  it("degrades to an honest unflagged default when the JSON doesn't match the expected shape", async () => {
    const { reviewAction } = await import("@finnor/orchestration");
    const verdict = await reviewAction(input, fakeProvider('{"unexpected": "shape"}'));
    expect(verdict.flagged).toBe(false);
    expect(verdict.reason).toMatch(/could not be parsed/i);
  });

  it("wraps and rethrows a provider failure rather than swallowing it", async () => {
    const { reviewAction } = await import("@finnor/orchestration");
    const failing: LLMProvider = {
      name: "failing",
      complete: async () => {
        throw new Error("network down");
      },
    };
    await expect(reviewAction(input, failing)).rejects.toThrow(/Critic LLM call failed.*network down/);
  });
});

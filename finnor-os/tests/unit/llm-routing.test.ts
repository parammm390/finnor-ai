import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  CompositeProvider,
  MistralProvider,
  describeLLMRoute,
  LLMProviderSelectionError,
  recordOutcome,
  resetProviderHealth,
  resolveProvider,
  resolveProviderForPurpose,
} from "@finnor/tools";

describe("Centropy model routing", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    for (const name of ["MISTRAL_API_KEY", "DEEPSEEK_API_KEY", "AWS_BEDROCK_API_KEY", "GROQ_API_KEY"]) vi.stubEnv(name, "");
    vi.unstubAllGlobals();
    resetProviderHealth();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetProviderHealth();
  });

  it("fails closed for an unnamed provider and never treats Groq as the route default", () => {
    vi.stubEnv("GROQ_API_KEY", "unit-test-only");

    expect(() => resolveProvider()).toThrow(/No LLM provider selected/);
    expect(describeLLMRoute("planning", "voice").providerNames).toEqual([]);
    expect(resolveProviderForPurpose("planning", "voice").name).toBe("route:planning:voice");
  });

  it("fails closed for an invalid explicit route instead of falling back to defaults", async () => {
    vi.stubEnv("MISTRAL_API_KEY", "unit-test-only");
    vi.stubEnv("LLM_PROVIDER_PLANNING_VOICE", "not-configured");
    vi.stubEnv("LLM_FALLBACKS_PLANNING_VOICE", "mistral");

    expect(describeLLMRoute("planning", "voice").providerNames).toEqual([]);
    const provider = resolveProviderForPurpose("planning", "voice");
    expect(provider.name).toBe("route:planning:voice");
    await expect(provider.complete({ system: "s", user: "u", purpose: "planning", channel: "voice" }))
      .rejects.toBeInstanceOf(LLMProviderSelectionError);
  });

  it("resolves Mistral from runtime configuration and preserves structured JSON mode", async () => {
    vi.stubEnv("MISTRAL_API_KEY", "unit-test-only");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"actions":[]}' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new MistralProvider();
    const deadlineAt = Date.now() + 1_000;
    const result = await provider.complete({ system: "system", user: "user", json: true, purpose: "planning", channel: "voice", deadlineAt });

    expect(result).toBe('{"actions":[]}');
    expect(provider.lastUsage).toEqual({ model: "mistral-small-latest", inputTokens: 3, outputTokens: 2 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "mistral-small-latest", response_format: { type: "json_object" } });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer unit-test-only");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("passes one absolute deadline and caller signal through every fallback attempt", async () => {
    const seen: Array<{ deadlineAt?: number; signal?: AbortSignal }> = [];
    const first = {
      name: "deadline-first",
      async complete(opts: { deadlineAt?: number; signal?: AbortSignal }) {
        seen.push(opts);
        throw new Error("first provider failed");
      },
    };
    const second = {
      name: "deadline-second",
      async complete(opts: { deadlineAt?: number; signal?: AbortSignal }) {
        seen.push(opts);
        return "ok";
      },
    };
    const signal = new AbortController().signal;
    const deadlineAt = Date.now() + 1_000;

    await expect(new CompositeProvider([first, second]).complete({ system: "s", user: "u", channel: "voice", signal, deadlineAt })).resolves.toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[0]!.deadlineAt).toBe(deadlineAt);
    expect(seen[1]!.deadlineAt).toBe(deadlineAt);
    expect(seen[0]!.signal).toBe(signal);
    expect(seen[1]!.signal).toBe(signal);
  });

  it("moves a predictably slow provider behind a fast one for voice", async () => {
    for (let i = 0; i < 3; i++) {
      recordOutcome("voice-slow", true, 2_000);
      recordOutcome("voice-fast", true, 100);
    }
    const calls: string[] = [];
    const slow = { name: "voice-slow", async complete() { calls.push("slow"); return "slow"; } };
    const fast = { name: "voice-fast", async complete() { calls.push("fast"); return "fast"; } };

    await expect(new CompositeProvider([slow, fast]).complete({ system: "s", user: "u", channel: "voice" })).resolves.toBe("fast");
    expect(calls).toEqual(["fast"]);
  });
});

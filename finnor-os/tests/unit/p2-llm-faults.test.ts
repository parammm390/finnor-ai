// Phase 2 provider fault matrix. Every response is an in-process fetch seam: this
// file never has a provider credential and never permits network egress.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompositeProvider,
  DeepSeekProvider,
  LLMDeadlineExceededError,
  MistralProvider,
  describeLLMRoute,
  resolveProvider,
  resetProviderHealth,
} from "@finnor/tools";

type FakeResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
};

function response(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
    json: async () => body,
  };
}

function successResponse(content = '{"actions":[]}'): FakeResponse {
  return response(200, { choices: [{ message: { content } }], usage: { prompt_tokens: 7, completion_tokens: 5 } });
}

describe("Phase 2 deterministic LLM fault matrix", () => {
  beforeEach(() => {
    vi.stubEnv("MISTRAL_API_KEY", "phase2-test-mistral");
    vi.stubEnv("DEEPSEEK_API_KEY", "phase2-test-deepseek");
    vi.stubEnv("AWS_BEDROCK_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.unstubAllGlobals();
    resetProviderHealth();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetProviderHealth();
  });

  it.each([429, 401, 500])("falls from an HTTP %s provider failure to the next configured provider", async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(status, `phase2-${status}`))
      .mockResolvedValueOnce(successResponse('{"fallback":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CompositeProvider([new MistralProvider(), new DeepSeekProvider()]);
    await expect(provider.complete({ system: "s", user: "u", purpose: "planning", channel: "text", deadlineMs: 2_000 }))
      .resolves.toBe('{"fallback":true}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(provider.selectedProviderName).toBe("deepseek");
  });

  it("falls over a malformed JSON response without losing the concrete provider", async () => {
    const malformed = response(200, "not-json");
    malformed.json = async () => { throw new Error("malformed provider response"); };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(malformed)
      .mockResolvedValueOnce(successResponse('{"repaired_by":"fallback"}'));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CompositeProvider([new MistralProvider(), new DeepSeekProvider()]);
    await expect(provider.complete({ system: "s", user: "u", json: true, purpose: "repair", channel: "console", deadlineMs: 2_000 }))
      .resolves.toBe('{"repaired_by":"fallback"}');
    expect(provider.selectedProviderName).toBe("deepseek");
  });

  it("converts an abortable provider timeout into a shared deadline error", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<never>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new MistralProvider().complete({ system: "s", user: "u", purpose: "planning", channel: "voice", deadlineMs: 20 }))
      .rejects.toBeInstanceOf(LLMDeadlineExceededError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves caller abort propagation instead of starting a fallback after cancellation", async () => {
    const controller = new AbortController();
    let fetchStarted = () => {};
    const started = new Promise<void>(resolve => { fetchStarted = resolve });
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<never>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("caller aborted"), { name: "AbortError" })), { once: true });
      fetchStarted();
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = new CompositeProvider([new MistralProvider(), new DeepSeekProvider()]).complete({
      system: "s", user: "u", purpose: "planning", channel: "voice", signal: controller.signal, deadlineMs: 2_000,
    });
    await started;
    controller.abort(new Error("caller aborted"));
    await expect(pending).rejects.toThrow("caller aborted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exposes every purpose/channel route with the configured Mistral/DeepSeek order", () => {
    const purposes = ["planning", "critic", "repair", "classification", "answer"] as const;
    const channels = ["voice", "text", "console", "background"] as const;
    for (const purpose of purposes) {
      for (const channel of channels) {
        const route = describeLLMRoute(purpose, channel);
        expect(route.providerNames).toHaveLength(2);
        const expected = purpose === "planning"
          ? channel === "background" ? ["deepseek", "mistral"] : ["mistral", "deepseek"]
          : purpose === "classification" || purpose === "answer" && channel !== "background"
            ? ["mistral", "deepseek"]
            : ["deepseek", "mistral"];
        expect(route.providerNames).toEqual(
          expected,
        );
        expect(route.deadlineMs).toBeGreaterThan(0);
      }
    }
  });

  it("routes GLM, Mistral, and DeepSeek through one Bedrock key with concrete model provenance", async () => {
    vi.stubEnv("MISTRAL_API_KEY", "");
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("AWS_BEDROCK_API_KEY", "phase2-test-bedrock");
    const fetchMock = vi.fn().mockResolvedValue(response(200, {
      output: { message: { content: [{ text: "BEDROCK_OK" }] } },
      usage: { inputTokens: 3, outputTokens: 2 },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const expectedModels = [
      ["glm", "zai.glm-4.7"],
      ["mistral", "mistral.mistral-small-2402-v1:0"],
      ["deepseek", "deepseek.v3.2"],
    ] as const;
    for (const [name, model] of expectedModels) {
      const provider = resolveProvider(name);
      await expect(provider.complete({ system: "s", user: "u", purpose: "answer", channel: "text", deadlineMs: 2_000 }))
        .resolves.toBe("BEDROCK_OK");
      expect(provider.lastUsage).toEqual({ model, inputTokens: 3, outputTokens: 2 });
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(url).toMatch(/^https:\/\/bedrock-runtime\.us-east-1\.amazonaws\.com\/model\/(zai\.glm-4\.7|mistral\.mistral-small-2402-v1:0|deepseek\.v3\.2)\/converse$/);
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer phase2-test-bedrock");
      expect(url).toContain("/converse");
    }
    for (const purpose of ["planning", "critic", "repair", "classification", "answer"] as const) {
      for (const channel of ["voice", "text", "console", "background"] as const) {
        expect(describeLLMRoute(purpose, channel).providerNames).toHaveLength(3);
      }
    }
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  ledgerRows: [] as Array<Record<string, unknown>>,
  breadcrumbs: [] as Array<{ category?: string; message?: string }>,
}));

vi.mock("@finnor/db", () => {
  const db = {
    select: () => ({ from: () => ({ where: async () => [] }) }),
    insert: () => ({ values: async (values: Record<string, unknown>) => { state.ledgerRows.push(values); } }),
  };
  return {
    withTenant: async (_tenantId: string, callback: (database: typeof db) => Promise<unknown>) => callback(db),
    decisionReceipts: {},
    llmCalls: {},
    tenantLlmBudgets: {},
    ComputeCapacityUnavailableError: class extends Error {},
  };
});

vi.mock("drizzle-orm", () => ({
  and: vi.fn(),
  eq: vi.fn(),
  gte: vi.fn(),
  sql: vi.fn(() => ({})),
}));

vi.mock("@sentry/node", () => ({
  init: vi.fn(),
  addBreadcrumb: (breadcrumb: { category?: string; message?: string }) => state.breadcrumbs.push(breadcrumb),
  captureMessage: vi.fn(),
}));

import { CompositeProvider, registerProvider, resolveProvider, type LLMProvider } from "../../packages/tools/src/llm";
import { healthSnapshot, resetProviderHealth } from "../../packages/tools/src/provider-health";

describe("LLM composite provenance", () => {
  beforeEach(() => {
    state.ledgerRows.length = 0;
    state.breadcrumbs.length = 0;
    resetProviderHealth();
  });

  it("records the concrete fallback provider and does not add a composite health sample", async () => {
    const first: LLMProvider = {
      name: "provenance-first",
      async complete() { throw new Error("first provider failed"); },
    };
    const second: LLMProvider = {
      name: "provenance-second",
      lastUsage: { model: "selected-model", inputTokens: 4, outputTokens: 2 },
      async complete() { return "ok"; },
    };
    registerProvider("provenance-composite-test", () => new CompositeProvider([first, second]));

    const provider = resolveProvider("provenance-composite-test");
    await expect(provider.complete({
      system: "system",
      user: "user",
      tenantId: "tenant-for-routing-test",
      traceId: "routing-provenance",
      purpose: "answer",
    })).resolves.toBe("ok");

    expect(provider.selectedProviderName).toBe("provenance-second");
    expect(state.ledgerRows).toHaveLength(1);
    expect(state.ledgerRows[0]).toMatchObject({ provider: "provenance-second", model: "selected-model" });
    expect(state.breadcrumbs).toContainEqual(expect.objectContaining({ category: "llm", message: "provenance-second" }));
    expect(healthSnapshot("provenance-first").window).toBe(1);
    expect(healthSnapshot("provenance-second").window).toBe(1);
    expect(healthSnapshot("composite").window).toBe(0);
  });
});

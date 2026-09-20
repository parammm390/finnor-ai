import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => {
  const query = vi.fn();
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query, release }));
  return { query, release, connect };
});

vi.mock("../../packages/db/index", () => ({ getPool: () => ({ connect: mocked.connect, query: mocked.query }) }));

import { withGovernedModelInvocation, withGovernedProviderInvocation } from "../../packages/db/compute-governor";

describe("distinct provider and model capacity contracts", () => {
  const original = process.env.FINNOR_ENVIRONMENT;

  beforeEach(() => {
    process.env.FINNOR_ENVIRONMENT = "production";
    mocked.query.mockReset();
    mocked.release.mockReset();
    mocked.connect.mockClear();
    mocked.query.mockImplementation(async (statement: string, params?: unknown[]) => {
      if (statement.includes("FROM compute_resource_policies")) {
        const keys = params?.[0] as string[];
        return {
          rows: keys.filter((key) => key === "provider:microsoft-graph" || key === "model-provider:groq")
            .map((resource_key) => ({ resource_key, capacity: 2, per_tenant_capacity: 1, interactive_reserve: 0, lease_seconds: 120, next_fence: "1" })),
        };
      }
      if (statement.includes("FROM compute_resource_leases") && statement.includes("count(*)")) {
        return { rows: [{ total: "0", tenant: "0" }] };
      }
      return { rows: [], rowCount: 1 };
    });
  });

  afterEach(() => {
    if (original === undefined) delete process.env.FINNOR_ENVIRONMENT;
    else process.env.FINNOR_ENVIRONMENT = original;
  });

  it("permits a configured Graph operation without an unrelated model:global policy", async () => {
    const invoke = vi.fn(async () => "provider-ok");
    await expect(withGovernedProviderInvocation({ provider: "microsoft-graph", tenantId: "tenant-a" }, invoke))
      .resolves.toBe("provider-ok");
    expect(invoke).toHaveBeenCalledOnce();
    expect(mocked.query).toHaveBeenCalledWith(expect.stringContaining("FROM compute_resource_policies"), [["provider:microsoft-graph"]]);
    expect(mocked.release).toHaveBeenCalledOnce();
  });

  it("fails closed when a model invocation lacks the mandatory model:global policy", async () => {
    const invoke = vi.fn(async () => "model-should-not-run");
    await expect(withGovernedModelInvocation({ provider: "groq", model: "test", tenantId: "tenant-a" }, invoke))
      .rejects.toThrow("Mandatory compute resource policy is absent or disabled: model:global");
    expect(invoke).not.toHaveBeenCalled();
    expect(mocked.release).toHaveBeenCalledOnce();
  });
});

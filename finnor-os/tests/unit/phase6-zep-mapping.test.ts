import { beforeEach, describe, expect, it, vi } from "vitest";

const zep = vi.hoisted(() => ({
  userAdd: vi.fn(async () => undefined),
  threadCreate: vi.fn(async () => undefined),
  threadAddMessages: vi.fn(async () => undefined),
  graphSearch: vi.fn(async () => ({ edges: [{ fact: "Sarah prefers the active sales sender", uuid: "edge-1", score: 0.91 }] })),
  projectGet: vi.fn(async () => ({ projectUuid: "project-1" })),
}));

vi.mock("@getzep/zep-cloud", () => ({
  ZepClient: class {
    user = { add: zep.userAdd };
    thread = { create: zep.threadCreate, addMessages: zep.threadAddMessages };
    graph = { search: zep.graphSearch };
    project = { get: zep.projectGet };
  },
}));

describe("Phase 6 Zep human/thread mapping", () => {
  beforeEach(() => {
    process.env.ZEP_API_KEY = "test-only-key";
    vi.clearAllMocks();
  });

  it("maps one graph per authenticated employee and one Zep thread per canonical Postgres thread", async () => {
    const {
      LEGACY_ZEP_GRAPH_POLICY,
      mirrorConversationMessageToZep,
      queryConsolidatedFacts,
      testZepProviderConnection,
      zepCanonicalThreadId,
      zepEmployeeUserId,
    } = await import("@finnor/memory");
    const tenantId = "00000000-0000-4000-8000-000000000001";
    const employeeId = "00000000-0000-4000-8000-000000000002";
    const otherEmployeeId = "00000000-0000-4000-8000-000000000003";
    const threadId = "00000000-0000-4000-8000-000000000004";

    expect(zepEmployeeUserId(tenantId, employeeId)).not.toBe(zepEmployeeUserId(tenantId, otherEmployeeId));
    expect(zepCanonicalThreadId(threadId)).toBe(`finnor-thread-${threadId}`);
    expect(LEGACY_ZEP_GRAPH_POLICY).toBe("quarantined_no_query_no_copy");
    await expect(testZepProviderConnection()).resolves.toEqual({ configured: true, healthy: true, reason: null });

    await mirrorConversationMessageToZep({ tenantId, employeeId, threadId, messageId: "user-message", role: "user", content: "Use my sales sender.", createdAt: new Date(0).toISOString() });
    await mirrorConversationMessageToZep({ tenantId, employeeId, threadId, messageId: "assistant-message", role: "assistant", content: "I inferred a preference.", createdAt: new Date(1).toISOString() });

    const userId = zepEmployeeUserId(tenantId, employeeId);
    expect(zep.userAdd).toHaveBeenCalledWith({ userId }, expect.objectContaining({ timeoutInSeconds: 5 }));
    expect(zep.threadCreate).toHaveBeenCalledWith({ threadId: zepCanonicalThreadId(threadId), userId }, expect.objectContaining({ timeoutInSeconds: 5 }));
    expect(zep.threadAddMessages).toHaveBeenNthCalledWith(1, zepCanonicalThreadId(threadId), expect.objectContaining({ messages: [expect.objectContaining({ role: "user", uuid: "user-message" })] }), expect.objectContaining({ timeoutInSeconds: 5 }));
    expect(zep.threadAddMessages).toHaveBeenNthCalledWith(2, zepCanonicalThreadId(threadId), expect.objectContaining({ ignoreRoles: ["assistant"], messages: [expect.objectContaining({ role: "assistant", uuid: "assistant-message" })] }), expect.objectContaining({ timeoutInSeconds: 5 }));

    const facts = await queryConsolidatedFacts(tenantId, employeeId, "sender preference");
    expect(zep.graphSearch).toHaveBeenCalledWith(expect.objectContaining({ userId, query: "sender preference" }), expect.objectContaining({ timeoutInSeconds: 5 }));
    expect(facts[0]).toMatchObject({ chunk: "Sarah prefers the active sales sender", sourceKind: "zep_employee_fact", provenance: { employeeId, legacyGraphPolicy: "quarantined_no_query_no_copy" } });
  });

  it("never queries a legacy tenant/session graph", async () => {
    const { queryConsolidatedFacts } = await import("@finnor/memory");
    expect(await queryConsolidatedFacts("tenant-legacy", "legacy query")).toEqual([]);
    expect(zep.userAdd).not.toHaveBeenCalled();
    expect(zep.threadCreate).not.toHaveBeenCalled();
    expect(zep.threadAddMessages).not.toHaveBeenCalled();
    expect(zep.graphSearch).not.toHaveBeenCalled();
  });

  it("fails open to canonical Postgres when configured Zep is unavailable", async () => {
    const { mirrorConversationMessageToZep, queryConsolidatedFacts, testZepProviderConnection } = await import("@finnor/memory");
    zep.projectGet.mockRejectedValueOnce(new Error("provider unavailable"));
    zep.userAdd.mockRejectedValueOnce(new Error("provider unavailable"));
    zep.graphSearch.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(testZepProviderConnection()).resolves.toEqual({ configured: true, healthy: false, reason: "Zep project authentication or availability check failed" });
    await expect(mirrorConversationMessageToZep({
      tenantId: "00000000-0000-4000-8000-000000000011",
      employeeId: "00000000-0000-4000-8000-000000000012",
      threadId: "00000000-0000-4000-8000-000000000013",
      messageId: "outage-message",
      role: "user",
      content: "This remains in canonical Postgres.",
      createdAt: new Date(0).toISOString(),
    })).resolves.toBeUndefined();
    await expect(queryConsolidatedFacts("tenant-outage", "employee-outage", "sender preference")).resolves.toEqual([]);
  });
});

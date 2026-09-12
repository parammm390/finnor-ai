import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { allPendingActions } from "../../apps/console/lib/api";

describe("production-correctness pending approvals", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drains every cursor page before reporting a complete console queue", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        actions: [{ id: "first" }],
        page: { hasMore: true, nextCursor: "cursor-2" },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        actions: [{ id: "second" }],
        page: { hasMore: false, nextCursor: null },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);

    await expect(allPendingActions<{ id: string }>("pending")).resolves.toEqual({
      actions: [{ id: "first" }, { id: "second" }],
      complete: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1]![0])).toContain("cursor=cursor-2");
  });

  it("uses keyset pagination and one bulk authority projection per API page", async () => {
    const route = await readFile(new URL("../../apps/api/app/api/actions/pending/route.ts", import.meta.url), "utf8");
    const authority = await readFile(new URL("../../packages/authority/src/index.ts", import.meta.url), "utf8");
    const consoleApi = await readFile(new URL("../../apps/console/lib/api.ts", import.meta.url), "utf8");

    expect(route).toContain(".limit(limit + 1)");
    expect(route).toContain("nextCursor");
    expect(route).toContain("eligibleApproversForActions(ctx.tenantId, actionIds)");
    expect(route).not.toContain("eligibleApproversForAction(ctx.tenantId");
    expect(authority).toContain("loadAuthorities(db, tenantId, candidates.map");
    expect(consoleApi).toContain("response.page.nextCursor");
  });
});

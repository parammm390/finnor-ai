import { afterEach, expect, it, vi } from "vitest"

const rejectAccess = vi.hoisted(() => vi.fn())

vi.mock("./centropy-auth", () => ({
  getCurrentAccessToken: () => "caller-token",
  getCurrentSessionKey: () => "unchanged-signed-session",
  getCurrentAccessGeneration: () => 0,
  rejectCurrentWorkspaceAccess: rejectAccess,
}))

import { centropyPost } from "./api"
import { publishBusinessInvalidation } from "./business-invalidation"

afterEach(() => { vi.unstubAllGlobals(); rejectAccess.mockClear() })

it.each(["acknowledged mutation", "business event"] as const)("rereads current state after %s while retaining concurrent-read sharing", async trigger => {
  let finishOld!: (response: Response) => void
  let finishCurrent!: (response: Response) => void
  const oldResponse = new Promise<Response>(resolve => { finishOld = resolve })
  const currentResponse = new Promise<Response>(resolve => { finishCurrent = resolve })
  let reads = 0
  const reply = (revision: string) => new Response(JSON.stringify({ revision }), {
    headers: { "content-type": "application/json" },
  })
  const transport = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer caller-token")
    if (String(_url).endsWith("/company-brain/program-submit")) return reply("acknowledged")
    reads++
    return reads === 1 ? oldResponse : currentResponse
  })
  vi.stubGlobal("fetch", transport)
  const input = { workId: "11111111-1111-4111-8111-111111111111" }
  const before = centropyPost("company-brain/program-projection", input)
  const concurrentBefore = centropyPost("company-brain/program-projection", input)
  try {
    expect(reads).toBe(1)
    if (trigger === "acknowledged mutation")
      await centropyPost("company-brain/program-submit", { instruction: "Recompute the current Work" })
    else publishBusinessInvalidation({ tags: ["work"], source: "business-event" })

    const after = centropyPost("company-brain/program-projection", input)
    expect(reads).toBe(2)
    finishOld(reply("before-change"))
    expect(await before).toEqual({ revision: "before-change" })
    expect(await concurrentBefore).toEqual({ revision: "before-change" })
    const concurrentAfter = centropyPost("company-brain/program-projection", input)
    expect(reads).toBe(2)
    finishCurrent(reply("after-change"))
    expect(await after).toEqual({ revision: "after-change" })
    expect(await concurrentAfter).toEqual({ revision: "after-change" })
  } finally {
    finishOld(reply("before-change"))
    finishCurrent(reply("after-change"))
    await Promise.allSettled([before, concurrentBefore])
  }
})

it.each([
  { status: 401, denied: false, closesWorkspace: false },
  { status: 403, denied: false, closesWorkspace: false },
  { status: 401, denied: true, closesWorkspace: true },
  { status: 403, denied: true, closesWorkspace: true },
])("only an explicit identity denial closes the workspace ($status, marker=$denied)", async ({ status, denied, closesWorkspace }) => {
  const response = new Response(JSON.stringify({ error: "Current route not authorized" }), {
    status,
    headers: { "content-type": "application/json", ...(denied ? { "x-finnor-identity-state": "denied" } : {}) },
  })
  const transport = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal("fetch", transport)
  await expect(centropyPost("company-brain/institution-link-projection", {
    workId: "11111111-1111-4111-8111-111111111111",
  })).rejects.toMatchObject({ status })
  expect(transport).toHaveBeenCalledTimes(1)
  expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Bearer caller-token")
  if (closesWorkspace) expect(rejectAccess).toHaveBeenCalledExactlyOnceWith("caller-token", 0)
  else expect(rejectAccess).not.toHaveBeenCalled()
})

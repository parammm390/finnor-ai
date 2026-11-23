import { afterEach, expect, it, vi } from "vitest"

const rejectAccess = vi.hoisted(() => vi.fn())

vi.mock("./centropy-auth", () => ({
  getCurrentAccessToken: () => "caller-token",
  getCurrentSessionKey: () => "unchanged-signed-session",
  getCurrentAccessGeneration: () => 0,
  rejectCurrentWorkspaceAccess: rejectAccess,
}))

import { centropyPost, centropyPostRead } from "./api"
import { publishBusinessInvalidation } from "./business-invalidation"

afterEach(() => { vi.unstubAllGlobals(); rejectAccess.mockClear() })

it.each(["projection", "institution-read"])("reobserves %s after a transient HTTP 500", async operation => {
  const transport = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ error: "Temporary read failure" }, { status: 500 }))
    .mockResolvedValueOnce(Response.json({ revision: "observed" }))
  vi.stubGlobal("fetch", transport)
  const input = operation === "projection"
    ? { root: { entityType: "pe_deal", entityId: "11111111-1111-4111-8111-111111111111" } }
    : { workId: "11111111-1111-4111-8111-111111111111", purpose: "WORK_OBSERVATION" }
  await expect(centropyPostRead(`company-brain/${operation}`, input, {
    signal: new AbortController().signal, isCurrent: () => true,
  })).resolves.toEqual({ revision: "observed" })
  expect(transport).toHaveBeenCalledTimes(2)
  expect(transport.mock.calls.map(([url, init]) => [
    url, new Headers(init?.headers).get("authorization"), init?.body,
  ])).toEqual(Array.from({ length: 2 }, () => [
    `/api/centropy/company-brain/${operation}`, "Bearer caller-token", JSON.stringify(input),
  ]))
})

it.each([
  { status: 403, current: true, aborted: false, attempts: 1 },
  { status: 404, current: true, aborted: false, attempts: 1 },
  { status: 500, current: false, aborted: false, attempts: 1 },
  { status: 500, current: true, aborted: true, attempts: 1 },
  { status: 500, current: true, aborted: false, attempts: 2 },
])("bounds read recovery for HTTP $status (current=$current, aborted=$aborted)", async ({ status, current, aborted, attempts }) => {
  const controller = new AbortController()
  let scopeCurrent = true
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => {
    scopeCurrent = current
    if (aborted) controller.abort()
    return Response.json({ error: "Read unavailable" }, { status })
  })
  vi.stubGlobal("fetch", transport)
  await expect(centropyPostRead("company-brain/institution-read", {}, {
    signal: controller.signal, isCurrent: () => scopeCurrent,
  })).rejects.toMatchObject({ status: aborted ? 0 : status })
  expect(transport).toHaveBeenCalledTimes(attempts)
})

it("does not start a read after its Work scope closed", async () => {
  const transport = vi.fn<typeof fetch>()
  vi.stubGlobal("fetch", transport)
  await expect(centropyPostRead("company-brain/institution-read", {}, {
    signal: new AbortController().signal, isCurrent: () => false,
  })).rejects.toMatchObject({ status: 401, retryable: false })
  expect(transport).not.toHaveBeenCalled()
})

it("refuses to use read recovery for a mutation", async () => {
  const transport = vi.fn<typeof fetch>()
  vi.stubGlobal("fetch", transport)
  await expect(centropyPostRead("company-brain/program-submit", {}, {
    signal: new AbortController().signal, isCurrent: () => true,
  })).rejects.toThrow("Expected a registered read operation")
  expect(transport).not.toHaveBeenCalled()
})

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

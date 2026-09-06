import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const getServiceTokenMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/jarvis/proxy-auth", () => ({ getServiceToken: getServiceTokenMock }))

import {
  GET,
  POST,
  PUT,
  DELETE,
} from "./route"
import { JARVIS_PROXY_READ_TIMEOUT_MS, JARVIS_PROXY_WRITE_TIMEOUT_MS } from "./proxy-config"

const fetchMock = vi.fn<typeof fetch>()
const AUTH = { authorization: "Bearer caller-token" }

function request(method: string, path: string, options: { headers?: Record<string, string>; query?: string; body?: unknown } = {}): NextRequest {
  const query = options.query ? `?${options.query}` : ""
  return new NextRequest(`http://localhost/api/jarvis/${path}${query}`, {
    method,
    headers: options.headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
}

function params(path: string): { params: { path: string[] } } {
  return { params: { path: path.split("/") } }
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_OS_API_URL = "https://os.example.test"
  getServiceTokenMock.mockResolvedValue("service-token")
  fetchMock.mockReset()
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }))
  vi.stubGlobal("fetch", fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("JARVIS proxy route contract", () => {
  it("forwards every role-facing read family, including the previously missing routes", async () => {
    const paths = [
      "health",
      "dispatch/map",
      "technician/my-day",
      "data-quality/findings",
      "policies/tenant-1/schedule_water_test",
      "price-book/tenant-1",
      "read-models/activity-snapshot",
      "read-models/readiness-slo",
      "documents/document-1",
      "operations/operation-1",
      "works/work-1/objective",
      "employees",
      "threads",
      "threads/thread-1",
    ]

    for (const path of paths) {
      const response = await GET(request("GET", path, { headers: path === "health" ? undefined : AUTH }), params(path))
      expect(response.status, path).toBe(200)
    }

    expect(fetchMock).toHaveBeenCalledTimes(paths.length)
  })

  it("forwards dispatch, technician, data-quality, and policy writes without widening arbitrary tunnels", async () => {
    const paths = [
      "dispatch/map",
      "technician/my-day",
      "data-quality/findings/finding-1/resolve",
      "policies/tenant-1/schedule_water_test/simulate",
      "policies/tenant-1/schedule_water_test",
      "price-book/tenant-1",
      "operations/operation-1/retry",
      "objectives",
      "works/work-1/objective",
      "works/work-1/handoff",
      "threads",
    ]

    for (const path of [...paths.slice(0, 4), ...paths.slice(6)]) {
      const response = await POST(request("POST", path, { headers: AUTH, body: {} }), params(path))
      expect(response.status, path).toBe(200)
    }
    const putPolicy = await PUT(request("PUT", paths[4]!, { headers: AUTH, body: {} }), params(paths[4]!))
    const putPriceBook = await PUT(request("PUT", paths[5]!, { headers: AUTH, body: {} }), params(paths[5]!))
    expect(putPolicy.status).toBe(200)
    expect(putPriceBook.status).toBe(200)

    const typedQuery = await POST(request("POST", "queries", {
      headers: AUTH,
      body: { intent: "business_state" },
    }), params("queries"))
    expect(typedQuery.status).toBe(200)

    const arbitrary = await POST(request("POST", "dispatch/anything", { headers: AUTH, body: {} }), params("dispatch/anything"))
    expect(arbitrary.status).toBe(404)
  })

  it("keeps only health anonymous and requires caller auth for tenant-bearing status reads", async () => {
    await GET(request("GET", "health"), params("health"))
    const healthInit = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect((healthInit.headers as Record<string, string>).authorization).toBeUndefined()
    expect(getServiceTokenMock).not.toHaveBeenCalled()

    const tenantBearingPaths = ["stats", "setup/status", "integrations/status"]
    for (const path of tenantBearingPaths) {
      const response = await GET(request("GET", path), params(path))
      expect(response.status, path).toBe(401)
    }
    expect(getServiceTokenMock).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)

    for (const path of tenantBearingPaths) {
      const response = await GET(request("GET", path, { headers: AUTH }), params(path))
      expect(response.status, path).toBe(200)
      const init = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]?.[1] as RequestInit
      expect((init.headers as Record<string, string>).authorization, path).toBe("Bearer caller-token")
    }
    expect(getServiceTokenMock).not.toHaveBeenCalled()
  })

  it("fails closed before touching the backend for missing auth, invalid queries, and unknown paths", async () => {
    expect((await GET(request("GET", "dispatch/map"), params("dispatch/map"))).status).toBe(401)
    expect((await GET(request("GET", "dispatch/map", { headers: AUTH, query: "bad-key=value" }), params("dispatch/map"))).status).toBe(400)
    expect((await GET(request("GET", "dispatch/anything", { headers: AUTH }), params("dispatch/anything"))).status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ["GET", JARVIS_PROXY_READ_TIMEOUT_MS, "dispatch/map"],
    ["POST", JARVIS_PROXY_WRITE_TIMEOUT_MS, "dispatch/map"],
  ])("turns an upstream %s hang into a bounded 504", async (method, timeoutMs, path) => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
    }))

    const pending = method === "GET"
      ? GET(request("GET", path, { headers: AUTH }), params(path))
      : POST(request("POST", path, { headers: AUTH, body: {} }), params(path))
    await vi.advanceTimersByTimeAsync(Number(timeoutMs) + 1)
    const response = await pending
    expect(response.status).toBe(504)
    await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining("timed out") })
  })

  it("turns a failed upstream connection into a retryable 502 instead of leaking a Next 500", async () => {
    fetchMock.mockRejectedValue(new TypeError("ECONNREFUSED"))
    const response = await GET(request("GET", "dispatch/map", { headers: AUTH }), params("dispatch/map"))
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ error: "Jarvis backend is unavailable" })
  })

  it("covers preference DELETEs through the same authenticated boundary", async () => {
    expect((await DELETE(request("DELETE", "user-prefs", { headers: AUTH }), params("user-prefs"))).status).toBe(200)
    expect((await DELETE(request("DELETE", "push-subscriptions", { headers: AUTH }), params("push-subscriptions"))).status).toBe(200)
    expect((await DELETE(request("DELETE", "dispatch/map", { headers: AUTH }), params("dispatch/map"))).status).toBe(404)
  })
})

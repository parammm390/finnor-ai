import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const getServiceTokenMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/jarvis/proxy-auth", () => ({ getServiceToken: getServiceTokenMock }))

import { DELETE, GET, POST, PUT } from "./route"
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

function params(path: string): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path: path.split("/") }) }
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

describe("Phase 8 JARVIS proxy boundary", () => {
  it("allows only the active PE read surface", async () => {
    for (const path of ["me", "workspace-config", "activity", "read-models/workforce-status"]) {
      expect((await GET(request("GET", path, { headers: AUTH }), params(path))).status, path).toBe(200)
    }
    for (const path of ["read-models/household-360", "dispatch/map", "resources/inventory", "dealer-zero/time-compression", "stats"]) {
      expect((await GET(request("GET", path, { headers: AUTH }), params(path))).status, path).toBe(404)
    }
  })

  it("allows the exact Company Brain, semantic Activity, action, and Workspace V3 write paths", async () => {
    for (const operation of ["roots", "projection", "search", "object", "traverse", "provenance", "history", "evidence-lineage", "decision-lineage", "actions", "context"]) {
      const path = `company-brain/${operation}`
      expect((await POST(request("POST", path, { headers: AUTH, body: {} }), params(path))).status, path).toBe(200)
    }
    expect((await POST(request("POST", "semantic-activity", { headers: AUTH, body: {} }), params("semantic-activity"))).status).toBe(200)
    expect((await POST(request("POST", "actions", { headers: AUTH, body: {} }), params("actions"))).status).toBe(200)
    expect((await PUT(request("PUT", "workspace-config", { headers: AUTH, body: {} }), params("workspace-config"))).status).toBe(200)
  })

  it("keeps only health anonymous and preserves a real caller identity", async () => {
    expect((await GET(request("GET", "health"), params("health"))).status).toBe(200)
    expect(getServiceTokenMock).not.toHaveBeenCalled()
    expect((await GET(request("GET", "me"), params("me"))).status).toBe(401)
    expect((await GET(request("GET", "health", { headers: AUTH }), params("health"))).status).toBe(200)
    const init = fetchMock.mock.calls.at(-1)?.[1] as RequestInit
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer caller-token")
  })

  it("fails closed before the backend for invalid requests and removed product paths", async () => {
    expect((await GET(request("GET", "workspace-config", { headers: AUTH, query: "bad-key=value" }), params("workspace-config"))).status).toBe(400)
    expect((await POST(request("POST", "company-brain/not-real", { headers: AUTH, body: {} }), params("company-brain/not-real"))).status).toBe(404)
    expect((await DELETE(request("DELETE", "workspace-config", { headers: AUTH }), params("workspace-config"))).status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ["GET", JARVIS_PROXY_READ_TIMEOUT_MS, "workspace-config"],
    ["POST", JARVIS_PROXY_WRITE_TIMEOUT_MS, "semantic-activity"],
  ])("turns an upstream %s hang into a bounded 504", async (method, timeoutMs, path) => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
    }))
    const pending = method === "GET"
      ? GET(request("GET", path, { headers: AUTH }), params(path))
      : POST(request("POST", path, { headers: AUTH, body: {} }), params(path))
    await vi.advanceTimersByTimeAsync(Number(timeoutMs) + 1)
    expect((await pending).status).toBe(504)
  })

  it("turns upstream connection failure into a stable retryable response", async () => {
    fetchMock.mockRejectedValue(new TypeError("ECONNREFUSED"))
    const response = await GET(request("GET", "workspace-config", { headers: AUTH }), params("workspace-config"))
    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ error: "Jarvis backend is unavailable" })
  })
})

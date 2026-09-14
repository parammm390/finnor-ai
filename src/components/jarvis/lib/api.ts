"use client"

// Single fetch surface for every JARVIS panel. Both reads and writes go through the
// same-origin /api/jarvis/* proxy and forward the caller's real Supabase session
// token — the finnor-os backend's own requireContext/RBAC decides what a signed-in
// user can see and do. A separately opt-in JARVIS test mode can use the legacy shared
// owner key from localStorage for repeated product testing without creating users; it
// is disabled unless NEXT_PUBLIC_JARVIS_TEST_MODE=1.

import { getCurrentAccessToken } from "./jarvis-auth"
import { mutationProjectionTags, publishBusinessInvalidation } from "./business-invalidation"

const TEST_KEY_STORAGE = "jarvis_admin_key"
const TEST_MODE = process.env.NEXT_PUBLIC_JARVIS_TEST_MODE === "1"

export function getJarvisTestKey(): string | null {
  if (!TEST_MODE || typeof window === "undefined") return null
  return window.localStorage.getItem(TEST_KEY_STORAGE)
}

export function setJarvisTestKey(key: string): void {
  if (!TEST_MODE || typeof window === "undefined") return
  window.localStorage.setItem(TEST_KEY_STORAGE, key)
}

export function clearJarvisTestKey(): void {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(TEST_KEY_STORAGE)
}

export class JarvisApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable = status === 0 || status >= 500,
    /** Parsed upstream error envelope. Durable mutation routes can include
     * identifiers (notably workId) even when the request ends in recovery. */
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = "JarvisApiError"
  }
}

// The server proxy owns a 20s upstream read budget. Give it enough time to return
// either the real response or its stable 504; aborting first would manufacture
// SOURCE UNAVAILABLE while the same request was still legitimately running.
export const JARVIS_GET_TIMEOUT_MS = 22_000
// The proxy owns a 60s durable-write budget. The browser waits slightly longer so
// it receives the proxy's authoritative response (including a stable 504) rather
// than aborting an action that may already have committed.
export const JARVIS_MUTATION_TIMEOUT_MS = 65_000

// ---------------------------------------------------------------------------
// Request telemetry — every REAL fetch this page makes is published here, so the
// SystemConsole can stream genuine backend traffic (method, status, measured ms).
// ---------------------------------------------------------------------------
export interface JarvisRequestLog {
  method: "GET" | "POST" | "PUT" | "DELETE"
  path: string
  status: number
  ms: number
  at: number
}
const requestListeners = new Set<(r: JarvisRequestLog) => void>()
export function onJarvisRequest(cb: (r: JarvisRequestLog) => void): () => void {
  requestListeners.add(cb)
  return () => requestListeners.delete(cb)
}
function publish(r: JarvisRequestLog): void {
  requestListeners.forEach((cb) => cb(r))
}

function authHeaders(): Record<string, string> | undefined {
  const token = getCurrentAccessToken()
  if (token) return { authorization: `Bearer ${token}` }
  const testKey = getJarvisTestKey()
  return testKey ? { "x-jarvis-key": testKey } : undefined
}

type JarvisMethod = "GET" | "POST" | "PUT" | "DELETE"

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "network failure"
}

async function readJson<T>(res: Response, method: JarvisMethod, path: string): Promise<T> {
  const text = await res.text()
  let json: unknown = undefined
  if (text.trim()) {
    try {
      json = JSON.parse(text)
    } catch {
      throw new JarvisApiError(`${method} ${path} returned invalid JSON`, 502)
    }
  }
  if (!res.ok) {
    const message = json && typeof json === "object" && "error" in json && typeof json.error === "string" ? json.error : `${method} ${path} failed (${res.status})`
    throw new JarvisApiError(message, res.status, undefined, json)
  }
  return json as T
}

async function jarvisRequest<T>(method: JarvisMethod, path: string, body?: unknown, params?: Record<string, string>): Promise<T> {
  const qs = params ? `?${new URLSearchParams(params).toString()}` : ""
  const started = performance.now()
  let status = 0
  const controller = new AbortController()
  const timeoutMs = method === "GET" ? JARVIS_GET_TIMEOUT_MS : JARVIS_MUTATION_TIMEOUT_MS
  const timeoutId = globalThis.setTimeout(() => controller.abort(), timeoutMs)
  const auth = authHeaders()
  try {
    if (method !== "GET" && !auth) {
      status = 401
      throw new JarvisApiError(auth ? "Sign in required" : "Test key or sign in required", 401, false)
    }
    const res = await fetch(`/api/jarvis/${path}${qs}`, {
      method,
      cache: "no-store",
      headers: {
        ...(auth ?? {}),
        ...(method !== "GET" ? { "content-type": "application/json" } : {}),
      },
      ...(method !== "GET" ? { body: JSON.stringify(body ?? {}) } : {}),
      signal: controller.signal,
    })
    status = res.status
    const value = await readJson<T>(res, method, path)
    if (method !== "GET") {
      publishBusinessInvalidation({ tags: mutationProjectionTags(path), source: "mutation", path })
    }
    return value
  } catch (error) {
    if (isAbortError(error)) {
      status = 504
      throw new JarvisApiError(`${method} ${path} timed out after ${timeoutMs / 1000} seconds`, 504)
    }
    if (error instanceof JarvisApiError) throw error
    status = 503
    throw new JarvisApiError(`${method} ${path} unavailable: ${errorMessage(error)}`, 503)
  } finally {
    globalThis.clearTimeout(timeoutId)
    publish({ method, path: `/${path}`, status, ms: Math.round(performance.now() - started), at: Date.now() })
  }
}

export async function jarvisGet<T>(path: string, params?: Record<string, string>): Promise<T> {
  return jarvisRequest<T>("GET", path, undefined, params)
}

export async function jarvisPost<T>(path: string, body: unknown): Promise<T> {
  return jarvisRequest<T>("POST", path, body)
}

export async function jarvisPut<T>(path: string, body: unknown): Promise<T> {
  return jarvisRequest<T>("PUT", path, body)
}

export async function jarvisDelete<T>(path: string): Promise<T> {
  return jarvisRequest<T>("DELETE", path)
}

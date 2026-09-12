// Server-side proxy between the public /jarvis marketing page and the finnor-os API.
// The finnor-os backend requires a real Supabase bearer token in production (header-
// based demo auth is intentionally disabled there). Phase 1.4: private paths now
// forward the CALLER's own bearer token verbatim — the backend's own requireContext/
// canApprove RBAC is the sole authorizer, this file makes no authorization decisions
// beyond "is there a token at all" and "is this path on the allowlist". Only the
// non-tenant health/liveness path accepts anonymous requests.
import { NextRequest } from "next/server"
import { z } from "zod"
import { getServiceToken } from "@/lib/jarvis/proxy-auth"
import { JARVIS_PROXY_READ_TIMEOUT_MS, JARVIS_PROXY_WRITE_TIMEOUT_MS } from "./proxy-config"

// Resolve this per request so a warmed serverless module cannot retain an old
// upstream URL after configuration changes, and so the boundary is easy to test.
function osApi(): string | undefined {
  return process.env.NEXT_PUBLIC_OS_API_URL
}

const COMPANY_BRAIN_OPERATIONS = new Set([
  "roots",
  "projection",
  "search",
  "object",
  "traverse",
  "provenance",
  "history",
  "evidence-lineage",
  "decision-lineage",
  "actions",
  "context",
])

function isPublicGet(segments: string[]): boolean {
  const [a] = segments
  if (segments.length === 1 && a === "health") return true
  return false
}

function isAllowedGet(segments: string[]): boolean {
  const [a, b] = segments
  if (segments.length === 1 && a === "health") return true
  if (segments.length === 1 && a === "me") return true
  // Raw activity remains an explicitly diagnostic endpoint. The primary PE
  // Activity Theater uses the semantic-activity projection below.
  if (segments.length === 1 && a === "activity") return true
  if (segments.length === 1 && a === "workspace-config") return true
  if (segments.length === 2 && a === "read-models" && b === "workforce-status") return true
  return false
}

function isAllowedPost(segments: string[]): boolean {
  const [a, b] = segments
  if (segments.length === 1 && a === "actions") return true
  if (segments.length === 2 && a === "company-brain" && COMPANY_BRAIN_OPERATIONS.has(b!)) return true
  if (segments.length === 1 && a === "semantic-activity") return true
  return false
}

// --- Boundary validation (§0.3.1): path segments and query params are constrained to
// a safe shape before anything downstream (the allowlist checks, the upstream fetch)
// ever sees them. The backend has its own zod schemas per route (e.g. AuditQuerySchema)
// — this is a proxy-layer floor, not a replacement for that.
const SegmentSchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
const QueryValueSchema = z.string().max(200).regex(/^[^\r\n]*$/);
const QueryKeySchema = z.string().min(1).max(40).regex(/^[a-zA-Z0-9_]+$/);

function validSegments(segments: string[]): boolean {
  // 4, not 3: Phase 7's run-control paths are workflows/runs/:id/{pause,resume,...}.
  return segments.length > 0 && segments.length <= 4 && segments.every((s) => SegmentSchema.safeParse(s).success);
}

function validQuery(url: URL): boolean {
  for (const [key, value] of url.searchParams) {
    if (!QueryKeySchema.safeParse(key).success) return false;
    if (!QueryValueSchema.safeParse(value).success) return false;
  }
  return true;
}

// --- Per-IP rate limiting on the public (keyless) tier only. Best-effort: an
// in-memory sliding window scoped to one warm serverless instance, not a distributed
// guarantee — proportionate here because the public tier is aggregate-only, no PII,
// and this is defense-in-depth against abuse, not the primary auth control.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;
const rateBuckets = new Map<string, { count: number; windowStart: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= RATE_LIMIT_MAX;
}

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "unknown";
}

function proxyError(error: string, status: number): Response {
  return Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
}

function hasBearer(req: NextRequest): string | null {
  const value = req.headers.get("authorization");
  return value && /^Bearer\s+\S+$/.test(value) ? value : null;
}

function hasTestKey(req: NextRequest): boolean {
  const configured = process.env.JARVIS_ADMIN_KEY;
  return process.env.JARVIS_TEST_MODE === "1" && Boolean(configured) && req.headers.get("x-jarvis-key") === configured;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Jarvis proxy auth timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

async function doForward(
  req: NextRequest,
  segments: string[],
  method: "GET" | "POST" | "PUT" | "DELETE",
  authorization?: string,
): Promise<Response> {
  const upstreamBase = osApi();
  if (!upstreamBase) return proxyError("Jarvis proxy is not configured", 500);

  let url: URL;
  try {
    url = new URL(`${upstreamBase}/api/${segments.join("/")}`);
  } catch {
    return proxyError("Jarvis proxy is misconfigured", 500);
  }
  req.nextUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));

  const controller = new AbortController();
  const timeoutMs = method === "GET" ? JARVIS_PROXY_READ_TIMEOUT_MS : JARVIS_PROXY_WRITE_TIMEOUT_MS;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const init: RequestInit = {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      "content-type": "application/json",
    },
    cache: "no-store",
    signal: controller.signal,
  };
  try {
    if (method === "POST" || method === "PUT") {
      const body = await req.text();
      init.body = body.length > 0 ? body : "{}";
    }
    const upstream = await fetch(url.toString(), init);
    // Keep the proxy byte-preserving even though active P8 projections are JSON.
    const body = await upstream.arrayBuffer();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return proxyError(`Jarvis backend timed out after ${timeoutMs / 1000} seconds`, 504);
    }
    // Keep upstream failures as stable retryable boundary responses. Letting a
    // rejected fetch escape turns a recoverable outage into an opaque Next.js 500.
    return proxyError("Jarvis backend is unavailable", 502);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function forwardPublic(req: NextRequest, segments: string[]): Promise<Response> {
  // finnor-os exposes /health without authentication. Do not make liveness
  // depend on the optional shared service-account credentials.
  if (segments.length === 1 && segments[0] === "health") return doForward(req, segments, "GET");
  let token: string;
  try {
    token = await withTimeout(getServiceToken(), JARVIS_PROXY_READ_TIMEOUT_MS);
  } catch (error) {
    if (error instanceof Error && error.message === "Jarvis proxy auth timed out") {
      return proxyError(`Jarvis proxy auth timed out after ${JARVIS_PROXY_READ_TIMEOUT_MS / 1000} seconds`, 504);
    }
    return proxyError("Jarvis proxy auth unavailable", 502);
  }
  return doForward(req, segments, "GET", `Bearer ${token}`);
}

async function forwardTest(req: NextRequest, segments: string[], method: "GET" | "POST" | "PUT" | "DELETE"): Promise<Response> {
  try {
    const token = await withTimeout(getServiceToken(), method === "GET" ? JARVIS_PROXY_READ_TIMEOUT_MS : JARVIS_PROXY_WRITE_TIMEOUT_MS);
    return doForward(req, segments, method, `Bearer ${token}`);
  } catch (error) {
    if (error instanceof Error && error.message === "Jarvis proxy auth timed out") {
      return proxyError(`Jarvis proxy auth timed out after ${(method === "GET" ? JARVIS_PROXY_READ_TIMEOUT_MS : JARVIS_PROXY_WRITE_TIMEOUT_MS) / 1000} seconds`, 504);
    }
    return proxyError("Jarvis test-mode owner session unavailable", 502);
  }
}

// Next 16's route contract supplies dynamic params asynchronously. Keep the
// exported handlers exact so generated production route types fail closed on drift.
type JarvisRouteContext = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, { params }: JarvisRouteContext): Promise<Response> {
  const segments = (await params).path;
  if (!validSegments(segments) || !validQuery(req.nextUrl)) return proxyError("Invalid request", 400);
  if (!isAllowedGet(segments)) return proxyError("Not found", 404);

  if (isPublicGet(segments)) {
    // "Public" means an anonymous caller is allowed to fall back to the narrowly
    // scoped service identity. It must not replace a real caller's identity: doing
    // so made authenticated Home reads resolve under another role/tenant.
    const callerAuth = hasBearer(req);
    if (callerAuth) return doForward(req, segments, "GET", callerAuth);
    if (!checkRateLimit(clientIp(req))) return proxyError("Rate limit exceeded — slow down and try again shortly.", 429);
    return forwardPublic(req, segments);
  }

  if (hasTestKey(req)) return forwardTest(req, segments, "GET");
  const auth = hasBearer(req);
  if (!auth) return proxyError("Sign in required", 401);
  return doForward(req, segments, "GET", auth);
}

export async function POST(req: NextRequest, { params }: JarvisRouteContext): Promise<Response> {
  const segments = (await params).path;
  if (!validSegments(segments) || !validQuery(req.nextUrl)) return proxyError("Invalid request", 400);
  if (!isAllowedPost(segments)) return proxyError("Not found", 404);

  if (hasTestKey(req)) return forwardTest(req, segments, "POST");
  const auth = hasBearer(req);
  if (!auth) return proxyError("Sign in required", 401);
  return doForward(req, segments, "POST", auth);
}

function isAllowedPut(segments: string[]): boolean {
  return segments.length === 1 && segments[0] === "workspace-config";
}

export async function PUT(req: NextRequest, { params }: JarvisRouteContext): Promise<Response> {
  const segments = (await params).path;
  if (!validSegments(segments) || !validQuery(req.nextUrl) || !isAllowedPut(segments)) return proxyError("Not found", 404);
  if (hasTestKey(req)) return forwardTest(req, segments, "PUT");
  const auth = hasBearer(req);
  if (!auth) return proxyError("Sign in required", 401);
  return doForward(req, segments, "PUT", auth);
}

export async function DELETE(req: NextRequest, { params }: JarvisRouteContext): Promise<Response> {
  const segments = (await params).path;
  if (!validSegments(segments) || !validQuery(req.nextUrl)) return proxyError("Invalid request", 400);
  return proxyError("Not found", 404);
}

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

const READ_MODEL_VIEWS = new Set([
  "pipeline-health",
  "activity-snapshot",
  "technician-load",
  "stock-risk",
  "cash-collections",
  "service-due",
  "sla-breaches",
  "follow-up-debt",
  "data-quality",
  "work-cases",
  "household-360",
  "reliability",
  "readiness",
  "readiness-slo",
  "failure-injections",
])
const RESOURCE_KINDS = new Set(["households", "inventory", "invoices", "technicians", "visits", "compliance-policy", "workflows"])

function isPublicGet(segments: string[]): boolean {
  const [a] = segments
  if (segments.length === 1 && a === "health") return true
  return false
}

const RUN_CONTROL_VERBS = new Set(["pause", "resume", "cancel", "retry", "escalate"])

function isAllowedGet(segments: string[]): boolean {
  const [a, b, c] = segments
  if (segments.length === 1 && a === "stats") return true
  if (segments.length === 1 && a === "health") return true
  if (segments.length === 2 && a === "actions" && b === "pending") return true
  if (segments.length === 2 && a === "workflows" && b === "runs") return true
  if (segments.length === 1 && a === "events") return true
  if (segments.length === 1 && (a === "business-world" || a === "operational-deltas")) return true
  if (segments.length === 1 && a === "employees") return true
  if (segments.length === 2 && a === "read-models" && READ_MODEL_VIEWS.has(b!)) return true
  if (segments.length === 1 && a === "comms") return true
  if (segments.length === 1 && a === "insights") return true
  if (segments.length === 2 && a === "setup" && b === "status") return true
  if (segments.length === 2 && a === "integrations" && b === "status") return true
  if (segments.length === 2 && a === "resources" && RESOURCE_KINDS.has(b!)) return true
  if (segments.length === 1 && a === "audit") return true
  // Phase 7 (the cockpit): "Why?" receipt lookups, the caller's own role, the daily
  // briefing, the data-quality/contradiction queue, the DLQ browser, and corrections.
  if (segments.length === 1 && a === "receipts") return true
  if (segments.length === 2 && a === "receipts") return true
  if (segments.length === 1 && a === "me") return true
  if (segments.length === 1 && a === "overview") return true
  if (segments.length === 1 && a === "dlq") return true
  if (segments.length === 2 && a === "dlq") return true
  if (segments.length === 1 && a === "corrections") return true
  // D1.T2/T3: pulse bar (/api/vitals) and activity theater (/api/activity) both need
  // to reach through here — flagged as a real gap by C1's own session (this proxy's
  // allowlist never grew to cover A2.T5/T6's routes when they shipped) and closed now
  // that D1 actually consumes them.
  if (segments.length === 1 && a === "vitals") return true
  if (segments.length === 1 && a === "activity") return true
  if (segments.length === 1 && a === "user-prefs") return true
  if (segments.length === 1 && a === "workspace-config") return true
  if (segments.length === 2 && a === "user-prefs" && b === "digest") return true
  if (segments.length === 2 && a === "data-quality" && b === "findings") return true
  if (segments.length === 2 && a === "dispatch" && b === "map") return true
  if (segments.length === 2 && a === "technician" && b === "my-day") return true
  if (segments.length === 3 && a === "policies") return true
  if (segments.length === 2 && a === "price-book") return true
  if (segments.length === 2 && a === "documents") return true
  // jarvis-v3 P3.T5: the instruction lifecycle trace (§7.1) — GET /instructions/:id
  // and GET /instructions/:id/events?after=. Deliberately does NOT include
  // "stream" — that path is served by the dedicated, non-buffering
  // src/app/api/jarvis/stream/route.ts (P3.T10), which Next.js's own static-segment
  // routing resolves in preference to this catch-all for the exact path
  // /api/jarvis/stream; it never reaches isAllowedGet at all.
  if (segments.length === 2 && a === "instructions") return true
  if (segments.length === 3 && a === "instructions" && c === "events") return true
  if (segments.length === 1 && a === "works") return true
  if (segments.length === 2 && a === "works") return true
  if (segments.length === 1 && a === "threads") return true
  if (segments.length === 2 && a === "threads") return true
  if (segments.length === 3 && a === "works" && c === "execution") return true
  if (segments.length === 3 && a === "works" && c === "objective") return true
  if (segments.length === 2 && a === "operations") return true
  if (segments.length === 3 && a === "computer" && b === "runs") return true
  return false
}

function isAllowedPost(segments: string[]): boolean {
  const [a, b, c, d] = segments
  if (segments.length === 1 && a === "actions") return true
  if (segments.length === 1 && a === "threads") return true
  if (segments.length === 1 && a === "objectives") return true
  if (segments.length === 1 && a === "queries") return true
  if (segments.length === 2 && a === "dispatch" && b === "map") return true
  if (segments.length === 3 && a === "actions" && (c === "confirm" || c === "reject" || c === "escalate" || c === "revert")) return true
  if (segments.length === 3 && a === "instructions" && c === "cancel") return true
  if (segments.length === 3 && a === "works" && c === "retry") return true
  if (segments.length === 3 && a === "works" && c === "objective") return true
  if (segments.length === 3 && a === "works" && c === "handoff") return true
  if (segments.length === 3 && a === "operations" && c === "retry") return true
  if (segments.length === 4 && a === "computer" && b === "runs" && d === "cancel") return true
  // Phase 7: run controls (owner-only server-side via canApprove) and DLQ replay/
  // discard (owner-only) both need the frontend to reach them at all first.
  if (segments.length === 4 && a === "workflows" && b === "runs" && RUN_CONTROL_VERBS.has(d!)) return true
  if (segments.length === 4 && a === "workflows" && b === "steps" && d === "compensate") return true
  if (segments.length === 3 && a === "dlq" && (c === "replay" || c === "discard")) return true
  if (segments.length === 1 && a === "corrections") return true
  if (segments.length === 4 && a === "data-quality" && b === "findings" && d === "resolve") return true
  if (segments.length === 2 && a === "technician" && b === "my-day") return true
  if (segments.length === 4 && a === "policies" && d === "simulate") return true
  if (segments.length === 1 && a === "push-subscriptions") return true
  // D8: owner/Dealer-Zero authorization remains entirely in finnor-os; this proxy
  // only exposes the one existing, read-only time-compression route.
  if (segments.length === 2 && a === "dealer-zero" && b === "time-compression") return true
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
    // Keep this byte-preserving: the allowlist includes the tenant-scoped
    // documents endpoint, whose response is a PDF rather than JSON.
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

export async function GET(req: NextRequest, { params }: { params: { path: string[] } }): Promise<Response> {
  const segments = params.path;
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

export async function POST(req: NextRequest, { params }: { params: { path: string[] } }): Promise<Response> {
  const segments = params.path;
  if (!validSegments(segments) || !validQuery(req.nextUrl)) return proxyError("Invalid request", 400);
  if (!isAllowedPost(segments)) return proxyError("Not found", 404);

  if (hasTestKey(req)) return forwardTest(req, segments, "POST");
  const auth = hasBearer(req);
  if (!auth) return proxyError("Sign in required", 401);
  return doForward(req, segments, "POST", auth);
}

// D6.T1: user preferences are the caller's own record. Keep the proxy surface as
// narrow as the backend route: no generic PUT/DELETE tunnel is introduced.
function isUserPrefs(segments: string[]): boolean {
  return segments.length === 1 && (segments[0] === "user-prefs" || segments[0] === "push-subscriptions");
}

function isAllowedPut(segments: string[]): boolean {
  return isUserPrefs(segments) || (segments.length === 1 && segments[0] === "workspace-config") || (segments.length === 3 && segments[0] === "policies") || (segments.length === 2 && segments[0] === "price-book");
}

export async function PUT(req: NextRequest, { params }: { params: { path: string[] } }): Promise<Response> {
  const segments = params.path;
  if (!validSegments(segments) || !validQuery(req.nextUrl) || !isAllowedPut(segments)) return proxyError("Not found", 404);
  if (hasTestKey(req)) return forwardTest(req, segments, "PUT");
  const auth = hasBearer(req);
  if (!auth) return proxyError("Sign in required", 401);
  return doForward(req, segments, "PUT", auth);
}

export async function DELETE(req: NextRequest, { params }: { params: { path: string[] } }): Promise<Response> {
  const segments = params.path;
  if (!validSegments(segments) || !validQuery(req.nextUrl) || !isUserPrefs(segments)) return proxyError("Not found", 404);
  if (hasTestKey(req)) return forwardTest(req, segments, "DELETE");
  const auth = hasBearer(req);
  if (!auth) return proxyError("Sign in required", 401);
  return doForward(req, segments, "DELETE", auth);
}

// Auth + tenant resolution (§17): Supabase Auth verifies the JWT; the users table maps
// identity → tenant_id + role. Every request context carries TenantContext from here on.
// AUTH_DEV_BYPASS=1 allows header-based identity for local dev and integration tests only.

import { randomUUID } from "node:crypto";
import type { TenantContext, Role } from "@finnor/shared-types";
import { ensureSecretsLoaded, resolveTenantFromBearerToken, AuthVerificationError } from "@finnor/security";
import { initObservability, Sentry, logWithTrace } from "@finnor/tools";
import { checkRateLimit, secondsUntilWindowReset } from "./rate-limit";
import { redactText } from "@finnor/security";
import { canExerciseAuthority, evaluateAuthority } from "@finnor/authority";
import { readProductRuntimeAuthority } from "@finnor/db";

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    // A4.T5: carries a 429's Retry-After (or any other response header a caller of
    // errorResponse() should honor) — never set for a plain 401/403.
    public readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Same convention as root/src/app/api/jarvis/[...path]/route.ts's own clientIp() —
 *  first hop of x-forwarded-for, falling back to x-real-ip, "unknown" if neither is
 *  present (a direct/local request with no proxy in front). */
function clientIp(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "unknown";
}

/** Phase 16(e): forward an inbound trace id (a caller's own retry/proxy hop) or mint a
 *  fresh one. Tagged onto the current Sentry scope so every breadcrumb/error this
 *  request produces — here and later in the worker, once threaded through enqueueJob —
 *  carries the same id, without adding any new tracing vendor. */
function resolveCorrelationId(req: Request): string {
  const correlationId = req.headers.get("x-correlation-id") ?? randomUUID();
  Sentry.getCurrentScope().setTag("correlation_id", correlationId);
  return correlationId;
}

export async function requireContext(req: Request): Promise<TenantContext> {
  await ensureSecretsLoaded();
  const correlationId = resolveCorrelationId(req);
  // Dev-bypass never applies in production, REGARDLESS of the env var's value — a
  // misconfigured prod deploy that left AUTH_DEV_BYPASS=1 set must not accept forged
  // x-tenant-id headers just because the flag was never flipped off.
  if (process.env.AUTH_DEV_BYPASS === "1" && process.env.NODE_ENV !== "production") {
    const tenantId = req.headers.get("x-tenant-id");
    const userId = req.headers.get("x-user-id") ?? "00000000-0000-4000-8000-0000000000aa";
    const role = (req.headers.get("x-user-role") ?? "owner") as Role;
    if (tenantId) {
      await enforceRateLimit(`tenant:${tenantId}`);
      await readProductRuntimeAuthority();
      return { tenantId, userId, role, correlationId };
    }
  }

  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) throw new AuthError("Missing bearer token", 401);
  const token = auth.slice("Bearer ".length);

  // A4.T5: real bearer-token verification (resolveTenantFromBearerToken, below) is a
  // real external call (Supabase Auth) — every attempt costs something regardless of
  // whether the token is valid. Before this, an invalid/expired/garbage token was
  // rejected for free with ZERO rate limiting (enforceRateLimit only ran AFTER a
  // successful resolve), so spraying junk tokens could hammer that external call
  // unthrottled. IP-keyed since there's no tenant yet at this point in the request.
  await enforceRateLimit(`ip:${clientIp(req)}`, Number(process.env.RATE_LIMIT_IP_PER_MINUTE ?? process.env.RATE_LIMIT_PER_MINUTE ?? 120));

  let ctx: Awaited<ReturnType<typeof resolveTenantFromBearerToken>>;
  try {
    ctx = await resolveTenantFromBearerToken(token);
  } catch (err) {
    if (err instanceof AuthVerificationError) throw new AuthError(err.message, err.status);
    throw err;
  }
  await enforceRateLimit(`tenant:${ctx.tenantId}`);
  await readProductRuntimeAuthority();
  return { ...ctx, correlationId };
}

async function enforceRateLimit(bucketKey: string, limit?: number): Promise<void> {
  const ok = limit === undefined ? await checkRateLimit(bucketKey) : await checkRateLimit(bucketKey, limit);
  if (!ok) {
    throw new AuthError("Rate limit exceeded — slow down and try again shortly.", 429, { "Retry-After": String(secondsUntilWindowReset()) });
  }
}

/** A4.T5: a tighter, route-specific bucket for a real auth-sensitive/expensive private
 *  action — layered ON TOP of requireContext's own generic per-tenant bucket, not a
 *  replacement for it. Exported so a specific route (POST /api/actions — the LLM
 *  planner intake path) can call it after requireContext resolves ctx. */
export async function enforceRouteRateLimit(bucketKey: string, limitPerMinute: number): Promise<void> {
  await enforceRateLimit(bucketKey, limitPerMinute);
}

/** RBAC (§18): can this role approve this action_type for this tenant? Config, not code. */
export async function canApprove(ctx: TenantContext, actionType: string): Promise<boolean> {
  const decision = await evaluateAuthority(ctx, {
    operation: "approval",
    capability: `approve:${actionType}`,
    resource: { type: "*" },
    risk: "medium",
  });
  return decision.outcome === "allowed";
}

/** Projection-only capability discovery. Unlike canApprove(), this records no
 * decision; the corresponding mutation route always re-authorizes durably. */
export async function canApproveReadOnly(ctx: TenantContext, actionType: string): Promise<boolean> {
  return canExerciseAuthority(ctx, {
    operation: "approval",
    capability: `approve:${actionType}`,
    resource: { type: "*" },
    risk: "medium",
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AuthError) {
    return Response.json({ error: err.message }, { status: err.status, headers: err.headers });
  }
  const message = err instanceof Error ? redactText(err.message).value : "Unexpected route failure";
  try {
    initObservability();
    Sentry.captureException(new Error(message));
  } catch (observabilityError) {
    // Observability is strictly best-effort. A missing Sentry/Axiom transport
    // must never replace the original route failure or turn its response into a
    // second, opaque 500.
    console.error("[observability] capture failed", observabilityError instanceof Error ? observabilityError.message : String(observabilityError));
  }
  // A2.T2: same correlation_id resolveCorrelationId() already tagged onto this
  // request's Sentry scope — reading it back here means this chokepoint (the one
  // every route's catch already flows through) needs no signature change anywhere.
  const traceId = Sentry.getCurrentScope().getScopeData().tags.correlation_id as string | undefined;
  // The driver's real root cause (e.g. drizzle's DrizzleQueryError wraps the actual
  // Postgres error — "relation does not exist", "permission denied", a real
  // connection failure — in `.cause`) was previously discarded here: every DB-level
  // failure logged as the same undifferentiated "Failed query: <sql>" with no way to
  // tell a missing-migration schema error apart from a connection outage apart from a
  // permissions error without reproducing it live. Surface it (redacted, server-log
  // only — the client-facing response below is unchanged) so the next one is
  // diagnosable from logs alone.
  const cause = err instanceof Error && err.cause instanceof Error ? redactText(err.cause.message).value : undefined;
  try {
    logWithTrace({ traceId }).error({ err: message, cause }, "unhandled route failure");
  } catch (loggingError) {
    console.error(
      "[route-error] unhandled route failure",
      JSON.stringify({ err: message, cause: cause ?? null, traceId: traceId ?? null, loggingError: loggingError instanceof Error ? loggingError.message : String(loggingError) }),
    );
  }
  // Keep one transport-independent, redacted line in serverless logs. The Pino
  // worker may be terminated with the function, so relying on its async flush can
  // otherwise leave a production 500 with no actionable root cause.
  if (process.env.NODE_ENV === "production") {
    console.error("[route-error] unhandled route failure", JSON.stringify({ err: message, cause: cause ?? null, traceId: traceId ?? null }));
  }
  // Plain language outward, details stay in server logs (§22).
  return Response.json(
    { error: "Something went wrong on our side. Try again shortly." },
    { status: 500, headers: traceId ? { "x-finnor-trace-id": traceId } : undefined },
  );
}

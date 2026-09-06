// Auth/rate-limit/replay/RBAC acceptance — the real work of Area 4. Checked
// tenant-isolation.test.ts first: it covers RLS, not auth/rate-limit/replay/RBAC, so
// this is genuinely new coverage, not a duplicate.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import { closePool, withTenant, rolePermissions } from "@finnor/db";
import { requireContext, canApprove, AuthError } from "../../apps/api/lib/auth";
import { checkProviderRateLimit, checkRateLimit, secondsUntilWindowReset } from "../../apps/api/lib/rate-limit";
import { checkAndRecordReceipt } from "../../apps/api/lib/webhook-replay";
import { POST as submitAction } from "../../apps/api/app/api/actions/route";
import { eq, and } from "drizzle-orm";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function dbUp(): Promise<boolean> {
  const c = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}
const available = await dbUp();

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/test", { headers });
}

describe.skipIf(!available)("authz — dev-bypass hardening, rate limiting, webhook replay, RBAC", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await seed(DB_URL);
  });
  afterAll(async () => {
    await closePool();
  });
  beforeEach(() => {
    process.env.AUTH_DEV_BYPASS = "1";
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("dev-bypass headers are accepted outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const ctx = await requireContext(req({ "x-tenant-id": SEED_TENANT_ID, "x-user-role": "owner" }));
    expect(ctx.tenantId).toBe(SEED_TENANT_ID);
  });

  it("dev-bypass headers are REJECTED when NODE_ENV=production, even with AUTH_DEV_BYPASS=1", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(requireContext(req({ "x-tenant-id": SEED_TENANT_ID, "x-user-role": "owner" }))).rejects.toThrow(AuthError);
  });

  it("rate limit trips after the configured number of requests in a window, then blocks further ones", async () => {
    const bucket = `test:${Date.now()}:${Math.random()}`;
    const results: boolean[] = [];
    for (let i = 0; i < 5; i++) results.push(await checkRateLimit(bucket, 3));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it("enforces one durable tenant/provider budget across concurrent worker-like callers", async () => {
    const tenantId = randomUUID();
    const provider = `phase5-${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 20 }, () => checkProviderRateLimit({
      tenantId,
      provider,
      action: "send",
      limitPerMinute: 5,
    })));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(results.filter((allowed) => !allowed)).toHaveLength(15);
  });

  it("secondsUntilWindowReset returns a sane value within the 60s fixed window", () => {
    const s = secondsUntilWindowReset();
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(60);
  });

  it("A4.T5: an invalid bearer token is IP-throttled BEFORE auth verification even runs, with 429 + Retry-After", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_DEV_BYPASS", "0");
    vi.stubEnv("RATE_LIMIT_IP_PER_MINUTE", "2");
    const ip = `203.0.113.${Math.floor(Math.random() * 255)}`; // unique per run, avoids bucket collision
    const garbageReq = () =>
      new Request("http://localhost/api/test", {
        headers: { authorization: "Bearer garbage-token-not-real", "x-forwarded-for": ip },
      });

    // First 2 (the configured limit) fail on auth verification itself — 401 when the
    // current test environment has Supabase auth configured, or 500 when it does not;
    // either is intentionally NOT 429, proving the IP throttle did not fire yet.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await requireContext(garbageReq());
        expect.unreachable("expected invalid bearer token to be rejected");
      } catch (err) {
        expect([401, 500]).toContain((err as AuthError).status);
      }
    }
    // The 3rd attempt within the same window trips the IP bucket BEFORE even reaching
    // auth verification — 429, with a real Retry-After header, not a generic error.
    try {
      await requireContext(garbageReq());
      expect.unreachable("expected the 3rd attempt to be rate-limited");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthError);
      const authErr = err as AuthError;
      expect(authErr.status).toBe(429);
      expect(authErr.headers?.["Retry-After"]).toBeDefined();
      expect(Number(authErr.headers?.["Retry-After"])).toBeGreaterThan(0);
    }
  });

  it("A4.T5: POST /api/actions enforces its own tighter intake bucket, independent of the generic tenant bucket", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("AUTH_DEV_BYPASS", "1");
    vi.stubEnv("RATE_LIMIT_INTAKE_PER_MINUTE", "2");
    vi.stubEnv("RATE_LIMIT_PER_MINUTE", "1000"); // generic tenant bucket stays wide open
    // A unique tenant id per run so this test's intake bucket never collides with the
    // rest of the suite's use of SEED_TENANT_ID.
    const tenantId = randomUUID();
    const makeReq = () =>
      new Request("http://localhost/api/actions", {
        method: "POST",
        headers: { "x-tenant-id": tenantId, "x-user-role": "owner", "content-type": "application/json" },
        // Deliberately invalid body — fails SubmitInstructionSchema and 400s WITHOUT
        // ever reaching the orchestrator/LLM planner. The rate-limit check runs before
        // that parse, so this still proves the intake bucket independent of body
        // content or actual planning cost.
        body: JSON.stringify({}),
      });

    const first = await submitAction(makeReq());
    const second = await submitAction(makeReq());
    expect(first.status).toBe(400); // failed schema validation, but got PAST the rate limiter
    expect(second.status).toBe(400);
    const third = await submitAction(makeReq());
    expect(third.status).toBe(429);
    const body = await third.json();
    expect(body.error).toMatch(/rate limit/i);
    expect(third.headers.get("Retry-After")).toBeDefined();
  });

  it("a replayed webhook payload is rejected the second time it's posted", async () => {
    const eventId = `evt-${Date.now()}-${Math.random()}`;
    const first = await checkAndRecordReceipt("test-provider", eventId, JSON.stringify({ hello: "world" }));
    const second = await checkAndRecordReceipt("test-provider", eventId, JSON.stringify({ hello: "world" }));
    expect(first).toBe("new");
    expect(second).toBe("duplicate");
  });

  it("canApprove defaults to deny for a role with no configured permission on an action type", async () => {
    const allowed = await canApprove({ tenantId: SEED_TENANT_ID, userId: "x", role: "technician" }, "__unconfigured_action_type__");
    expect(allowed).toBe(false);
  });

  it("canApprove defaults to allow for the owner role even with no configured row", async () => {
    const allowed = await canApprove({ tenantId: SEED_TENANT_ID, userId: "x", role: "owner" }, "__unconfigured_action_type__");
    expect(allowed).toBe(true);
  });

  it("canApprove honors an explicit grant row over the default", async () => {
    const actionType = "__test_explicit_grant__";
    await withTenant(SEED_TENANT_ID, (db) =>
      db.insert(rolePermissions).values({ tenantId: SEED_TENANT_ID, role: "technician", actionType, canApprove: true }),
    );
    const allowed = await canApprove({ tenantId: SEED_TENANT_ID, userId: "x", role: "technician" }, actionType);
    expect(allowed).toBe(true);
    await withTenant(SEED_TENANT_ID, (db) =>
      db.delete(rolePermissions).where(and(eq(rolePermissions.tenantId, SEED_TENANT_ID), eq(rolePermissions.actionType, actionType))),
    );
  });
});

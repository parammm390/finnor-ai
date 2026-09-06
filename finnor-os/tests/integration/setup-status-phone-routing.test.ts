// GET /api/setup/status gains a phoneRouting field (Phase 14): whether this tenant has
// a registered tenant_phone_numbers row, so an un-configured line shows up in the same
// "what's still left to configure" report as everything else on this endpoint.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { getPool, closePool } from "@finnor/db";
import { GET } from "../../apps/api/app/api/setup/status/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000e6"; // dedicated, isolated from other fixtures

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

function req(): Request {
  return new Request("http://localhost/api/setup/status", { headers: { "x-tenant-id": TENANT_ID, "x-user-role": "owner" } });
}

describe.skipIf(!available)("GET /api/setup/status — phoneRouting (Phase 14)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await getPool().query(`INSERT INTO tenants (id, name) VALUES ($1, 'Setup Status Phone Routing Test Tenant') ON CONFLICT (id) DO NOTHING`, [
      TENANT_ID,
    ]);
    // Reset any row left by a prior run of this suite against the same persistent DB —
    // test 1 asserts "unconfigured," which only holds on a clean slate.
    await getPool().query(`DELETE FROM tenant_phone_numbers WHERE tenant_id = $1 OR tenant_id = $2`, [
      TENANT_ID,
      "00000000-0000-4000-8000-0000000000e7",
    ]);
  });

  afterAll(async () => {
    await closePool();
  });

  it("reports unconfigured when the tenant has no registered phone line", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { phoneRouting: { configured: boolean; numbers: unknown[] } };
    expect(body.phoneRouting.configured).toBe(false);
    expect(body.phoneRouting.numbers).toEqual([]);
  });

  it("reports configured once a phone line is registered, without leaking another tenant's line", async () => {
    const OTHER_TENANT = "00000000-0000-4000-8000-0000000000e7";
    const myNumber = `+1555${randomUUID().replace(/-/g, "").slice(0, 7)}`;
    const otherNumber = `+1555${randomUUID().replace(/-/g, "").slice(0, 7)}`;
    await getPool().query(`INSERT INTO tenants (id, name) VALUES ($1, 'Other Tenant') ON CONFLICT (id) DO NOTHING`, [OTHER_TENANT]);
    await getPool().query(`INSERT INTO tenant_phone_numbers (tenant_id, phone_number, vapi_phone_number_id) VALUES ($1, $2, $3)`, [
      OTHER_TENANT,
      otherNumber,
      `other-${randomUUID()}`,
    ]);
    await getPool().query(
      `INSERT INTO tenant_phone_numbers (tenant_id, phone_number, vapi_phone_number_id, label) VALUES ($1, $2, $3, $4)`,
      [TENANT_ID, myNumber, `mine-${randomUUID()}`, "Main line"],
    );
    const res = await GET(req());
    const body = (await res.json()) as { phoneRouting: { configured: boolean; numbers: Array<{ phoneNumber: string }> } };
    expect(body.phoneRouting.configured).toBe(true);
    expect(body.phoneRouting.numbers).toHaveLength(1);
    expect(body.phoneRouting.numbers[0]!.phoneNumber).toBe(myNumber);
  });

  it("reports the active Core + Private Equity environment contract without credential values", async () => {
    const res = await GET(req());
    const body = (await res.json()) as {
      environment: {
        nodeEnv: string;
        secretProvider: { provider: string; loaded: boolean };
        activeProductVertical: string;
        capabilities: {
          employee_voice: { provider: string };
          transactional_email: { provider: string };
        };
        bootSafety: {
          authDevBypassConfigured: boolean;
          databaseRole: { currentUser: string; bypassRls: boolean };
          databaseConnectionFingerprint: string;
        };
      };
    };
    expect(body.environment.nodeEnv).toBeTruthy();
    expect(body.environment.secretProvider.provider).toBe("env"); // no SECRETS_PROVIDER set in this test run
    expect(body.environment.activeProductVertical).toBe("private_equity");
    expect(body.environment.capabilities).toEqual({
      employee_voice: { provider: "vapi" },
      transactional_email: { provider: "resend" },
    });
    expect(body.environment.bootSafety.authDevBypassConfigured).toBe(true);
    expect(body.environment.bootSafety.databaseRole.currentUser).toBeTruthy();
    expect(body.environment.bootSafety.databaseRole.bypassRls).toBeTypeOf("boolean");
    expect(body.environment.bootSafety.databaseConnectionFingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it("§5.1: reports embeddings as unconfigured (honest, not a guessed 'healthy') when EMBEDDINGS_API_KEY is unset", async () => {
    delete process.env.EMBEDDINGS_API_KEY;
    const res = await GET(req());
    const body = (await res.json()) as { integrations: { embeddings: { configured: boolean; healthy: boolean | null; provider: string } } };
    expect(body.integrations.embeddings).toEqual({ configured: false, healthy: false, provider: "voyage-3.5" });
  });

  it("§5.1: reports embeddings as configured once a real key is present", async () => {
    process.env.EMBEDDINGS_API_KEY = "voyage-test-key";
    try {
      const res = await GET(req());
      const body = (await res.json()) as { integrations: { embeddings: { configured: boolean } } };
      expect(body.integrations.embeddings.configured).toBe(true);
    } finally {
      delete process.env.EMBEDDINGS_API_KEY;
    }
  });
});

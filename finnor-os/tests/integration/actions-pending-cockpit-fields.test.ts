// The pending-action feed exposes the real async critic verdict without querying
// any retired vertical catalog or projection.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { actionLog, closePool, domainActions, tenants, withTenant } from "@finnor/db";
import { GET as pendingGET } from "../../apps/api/app/api/actions/pending/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000ec";

async function dbUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const available = await dbUp();

function request(): Request {
  return new Request("http://localhost/api/actions/pending", {
    headers: { "x-tenant-id": TENANT_ID, "x-user-role": "owner" },
  });
}

describe.skipIf(!available)("GET /api/actions/pending — critic evidence", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) =>
      db.insert(tenants).values({ id: TENANT_ID, name: "Approval evidence test" }).onConflictDoNothing(),
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it("returns null when no critic_review episode exists", async () => {
    const [action] = await withTenant(TENANT_ID, (db) =>
      db.insert(domainActions).values({
        tenantId: TENANT_ID,
        actionType: "record_finding",
        payload: {},
        status: "pending",
        summary: "No critic yet",
      }).returning(),
    );
    const response = await pendingGET(request());
    const body = await response.json();
    const found = body.actions.find((candidate: { id: string }) => candidate.id === action!.id);
    expect(found.critic).toBeNull();
  });

  it("returns the latest critic_review verdict", async () => {
    const [action] = await withTenant(TENANT_ID, (db) =>
      db.insert(domainActions).values({
        tenantId: TENANT_ID,
        actionType: "record_finding",
        payload: {},
        status: "pending",
        summary: "Has critic evidence",
      }).returning(),
    );
    await withTenant(TENANT_ID, (db) =>
      db.insert(actionLog).values({
        tenantId: TENANT_ID,
        domainActionId: action!.id,
        step: "critic_review",
        input: { instruction: "test" },
        output: { flagged: true, reason: "The evidence is incomplete" },
      }),
    );
    const response = await pendingGET(request());
    const body = await response.json();
    const found = body.actions.find((candidate: { id: string }) => candidate.id === action!.id);
    expect(found.critic).toEqual({ flagged: true, reason: "The evidence is incomplete" });
  });
});

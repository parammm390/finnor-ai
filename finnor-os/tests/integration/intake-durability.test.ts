import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { closePool, tenants, users, withTenant, workAggregate } from "@finnor/db";
import { POST as submitAction } from "../../apps/api/app/api/actions/route";
import { POST as startObjective } from "../../apps/api/app/api/objectives/route";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT = randomUUID();
const OWNER = randomUUID();

async function databaseAvailable(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}

const post = (path: string, body: Record<string, unknown>) => new Request(`http://localhost${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-tenant-id": TENANT, "x-user-id": OWNER, "x-user-role": "owner" },
  body: JSON.stringify(body),
});

const contextForAnotherWork = () => ({ version: 1, capturedAt: new Date().toISOString(), source: "text", surface: { id: "work" }, activeWork: { workId: randomUUID() } });

const available = await databaseAvailable();

describe.skipIf(!available)("an instruction is durable before anything can reject it", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    process.env.AUTH_DEV_BYPASS = "1";
    await migrate(DB_URL);
    await withTenant(TENANT, db => db.insert(tenants).values({ id: TENANT, name: "Durable intake" }));
    await withTenant(TENANT, db => db.insert(users).values({ id: OWNER, tenantId: TENANT, role: "owner", email: `intake-${OWNER}@example.test` }));
  });

  afterAll(async () => { await closePool(); });

  for (const [path, handler, field] of [["/api/actions", submitAction, "instruction"], ["/api/objectives", startObjective, "objective"]] as const) {
    it(`${path} keeps the employee's words as recoverable Work when their context is rejected`, async () => {
      const words = `Durable intake ${randomUUID()}`;
      const response = await handler(post(path, { [field]: words, channel: "text", activeContext: contextForAnotherWork() }));
      const body = await response.json() as { workId?: string; recoverable?: boolean };
      expect(response.ok, JSON.stringify(body)).toBe(false);
      expect(body).toMatchObject({ recoverable: true });
      const aggregate = await workAggregate(TENANT, body.workId!);
      expect(aggregate?.work).toMatchObject({ status: "failed" });
      expect((aggregate?.inputs as Array<{ instructionText: string }>).map(input => input.instructionText)).toEqual([words]);
    });
  }
});

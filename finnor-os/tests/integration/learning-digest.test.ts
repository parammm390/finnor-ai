// learning_digest handler acceptance: real domain_actions history crossing the
// concern threshold produces a real scanFindings row, never duplicates
// while one's still undigested, and stays silent when nothing crosses the bar.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { getPool, closePool, withTenant, domainActions, scanFindings } from "@finnor/db";
import { eq, and } from "drizzle-orm";
import { learningDigest } from "../../apps/worker/src/handlers/learning-digest";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000f3"; // dedicated, isolated from other fixtures

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

async function seedActions(actionType: string, statuses: string[]) {
  await withTenant(TENANT_ID, (db) =>
    db.insert(domainActions).values(statuses.map((status) => ({ tenantId: TENANT_ID, actionType, payload: {}, status: status as "completed" }))),
  );
}

async function resetFixtures() {
  await withTenant(TENANT_ID, (db) => db.delete(domainActions).where(eq(domainActions.tenantId, TENANT_ID)));
  await withTenant(TENANT_ID, (db) => db.delete(scanFindings).where(eq(scanFindings.tenantId, TENANT_ID)));
}

describe.skipIf(!available)("learning_digest handler", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await getPool().query(`INSERT INTO tenants (id, name) VALUES ($1, 'Learning Digest Test Tenant') ON CONFLICT (id) DO NOTHING`, [TENANT_ID]);
  });

  afterAll(async () => {
    await closePool();
  });

  it("is a no-op when nothing crosses the concern threshold", async () => {
    await resetFixtures();
    await seedActions("record_finding", Array(20).fill("completed").concat(Array(1).fill("failed"))); // 1/21 failure — well under 30%
    await learningDigest({ tenantId: TENANT_ID });
    const findings = await withTenant(TENANT_ID, (db) =>
      db.select().from(scanFindings).where(and(eq(scanFindings.tenantId, TENANT_ID), eq(scanFindings.scanType, "learning_digest"))),
    );
    expect(findings).toHaveLength(0);
  });

  it("records a real finding when an action_type is failing often enough on a real sample", async () => {
    await resetFixtures();
    await seedActions("record_finding", Array(5).fill("completed").concat(Array(5).fill("failed"))); // 50% failure, total 10
    await learningDigest({ tenantId: TENANT_ID });
    const findings = await withTenant(TENANT_ID, (db) =>
      db.select().from(scanFindings).where(and(eq(scanFindings.tenantId, TENANT_ID), eq(scanFindings.scanType, "learning_digest"))),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toContain("record_finding");
    expect(findings[0]!.summary).toContain("50%");
    expect((findings[0]!.details as Record<string, unknown>).actionType).toBe("record_finding");
  });

  it("records a finding driven by rejection rate among decided actions, not raw volume", async () => {
    await resetFixtures();
    // 10 decided (7 rejected, 3 completed) + 5 still pending — rejection rate must be
    // computed against the 10 decided, not all 15, or this would fall under threshold.
    await seedActions("raise_deal_risk", Array(7).fill("rejected").concat(Array(3).fill("completed")).concat(Array(5).fill("pending")));
    await learningDigest({ tenantId: TENANT_ID });
    const findings = await withTenant(TENANT_ID, (db) =>
      db.select().from(scanFindings).where(and(eq(scanFindings.tenantId, TENANT_ID), eq(scanFindings.scanType, "learning_digest"))),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.summary).toContain("raise_deal_risk");
    expect(findings[0]!.summary).toContain("70%");
  });

  it("does not duplicate a finding that's already undigested for the same action_type", async () => {
    await resetFixtures();
    await seedActions("record_finding", Array(5).fill("completed").concat(Array(5).fill("failed")));
    await learningDigest({ tenantId: TENANT_ID });
    await learningDigest({ tenantId: TENANT_ID }); // second tick, same underlying data
    const findings = await withTenant(TENANT_ID, (db) =>
      db.select().from(scanFindings).where(and(eq(scanFindings.tenantId, TENANT_ID), eq(scanFindings.scanType, "learning_digest"))),
    );
    expect(findings).toHaveLength(1);
  });
});

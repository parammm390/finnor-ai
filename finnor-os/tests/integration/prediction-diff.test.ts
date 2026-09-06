// B2.T3 acceptance: a stored prediction is compared only after a real execution
// result exists, persisted per action, and aggregated by action type in readiness.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { migrate } from "../../packages/db/migrate";
import { closePool, domainActions, tenants, withTenant } from "@finnor/db";
import { eq } from "drizzle-orm";
import { recordPredictionDiff } from "@finnor/orchestration";
import { reliability } from "@finnor/read-models";
import type { DomainAction } from "@finnor/shared-types";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const TENANT_ID = "00000000-0000-4000-8000-0000000000c3";
async function dbUp(): Promise<boolean> { const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2000 }); try { await client.connect(); await client.end(); return true; } catch { return false; } }
const available = await dbUp();
function actionFromRow(row: typeof domainActions.$inferSelect): DomainAction { return { id: row.id, tenantId: row.tenantId, actionType: row.actionType, payload: row.payload as Record<string, unknown>, policyId: row.policyId, status: row.status, createdAt: row.createdAt.toISOString() }; }

describe.skipIf(!available)("planner prediction diff", () => {
  beforeAll(async () => { process.env.DATABASE_URL = DB_URL; await migrate(DB_URL); await withTenant(TENANT_ID, (db) => db.insert(tenants).values({ id: TENANT_ID, name: "Prediction Diff Test Dealer" }).onConflictDoNothing()); });
  afterAll(async () => { await closePool(); });

  it("persists field-level match/mismatch and exposes per-type accuracy in reliability", async () => {
    const actionType = `prediction_test_${randomUUID().slice(0, 8)}`;
    const predictedReceipt = { version: 1, actionType: "prediction_test", simulation: { predicted: { expectedResult: { recordId: "record-1", confidence: 0.9 } } } };
    const [matchedRow] = await withTenant(TENANT_ID, (db) => db.insert(domainActions).values({ tenantId: TENANT_ID, actionType, payload: {}, status: "completed", predictedReceipt }).returning());
    const [mismatchedRow] = await withTenant(TENANT_ID, (db) => db.insert(domainActions).values({ tenantId: TENANT_ID, actionType, payload: {}, status: "completed", predictedReceipt }).returning());
    await recordPredictionDiff(actionFromRow(matchedRow!), { status: "success", output: { recordId: "record-1", confidence: 0.9 } });
    await recordPredictionDiff(actionFromRow(mismatchedRow!), { status: "success", output: { recordId: "record-1", confidence: 0.4 } });
    const [stored] = await withTenant(TENANT_ID, (db) => db.select({ diff: domainActions.predictionDiff }).from(domainActions).where(eq(domainActions.id, mismatchedRow!.id)));
    expect(stored!.diff).toMatchObject({ compared: 2, matched: 1, accuracy: 0.5 });
    expect((stored!.diff as { fields: unknown[] }).fields).toEqual(expect.arrayContaining([expect.objectContaining({ path: "recordId", matched: true }), expect.objectContaining({ path: "confidence", matched: false })]));
    const metrics = await reliability(TENANT_ID, 1);
    expect(metrics.predictionAccuracy).toContainEqual({ actionType, comparedFields: 4, matchedFields: 3, accuracy: 0.75 });
  });
});

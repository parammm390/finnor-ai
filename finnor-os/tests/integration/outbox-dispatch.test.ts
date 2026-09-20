// Scope 2 retirement acceptance. The historical outbox relay was a dormant,
// non-delivering substrate. Migration 0137 retires it only after a transactional
// zero-obligation inspection and permanently rejects new work rather than
// fabricating delivered state.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import {
  closePool,
  jobs,
  outboxEvents,
  runtimeSubstrateRetirements,
  withTenant,
} from "@finnor/db";
import { migrate } from "../../packages/db/migrate";
import { seed, SEED_TENANT_ID } from "../../packages/db/seed";
import { enqueueOutboxEvent } from "@finnor/workflow-runtime";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";

async function dbUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const available = await dbUp();

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\ncaused by: ");
}

async function expectDatabaseRejection(work: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await work;
  } catch (error) {
    expect(errorChain(error)).toMatch(pattern);
    return;
  }
  throw new Error(`Expected database operation to reject with ${pattern}`);
}

describe.skipIf(!available)("retired outbox and untracked provider jobs", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await seed(DB_URL);
  });

  afterAll(async () => {
    await closePool();
  });

  it("preserves the transactional zero-obligation evidence recorded at retirement", async () => {
    const rows = await withTenant(SEED_TENANT_ID, (db) => db.select().from(runtimeSubstrateRetirements));
    const outbox = rows.find((row) => row.substrate === "outbox");
    const providerJobs = rows.find((row) => row.substrate === "untracked_provider_jobs");

    expect(outbox?.retiredBy).toBe("migration:0137_scope2_durable_runtime");
    expect(outbox?.evidence).toMatchObject({
      unresolvedEvents: 0,
      openDeadLetters: 0,
      openReconciliationCases: 0,
      inspection: "transactional deployment guard",
    });
    expect(providerJobs?.evidence).toMatchObject({
      unresolvedJobs: 0,
      openDeliveryAttempts: 0,
      inspection: "transactional deployment guard",
    });
  });

  it("rejects both direct and helper-mediated creation of new outbox obligations", async () => {
    await expectDatabaseRejection(withTenant(SEED_TENANT_ID, (db) => db.insert(outboxEvents).values({
      tenantId: SEED_TENANT_ID,
      eventType: "must.not.exist",
      payload: { probe: true },
    })), /outbox substrate is retired/i);

    await expectDatabaseRejection(withTenant(SEED_TENANT_ID, (db) => enqueueOutboxEvent(db, {
      tenantId: SEED_TENANT_ID,
      eventType: "must.not.exist.via.helper",
      payload: { probe: true },
    })), /outbox substrate is retired/i);

    const count = await withTenant(SEED_TENANT_ID, (db) => db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ${outboxEvents}`,
    ));
    expect(count.rows[0]?.count).toBe(0);
  });

  it.each([
    "voice_confirm_request",
    "voice_notify_failure",
    "send_push_notification",
    "send_resend_email",
    "backup_db",
  ])("rejects retired provider job type %s before it becomes durable work", async (type) => {
    await expectDatabaseRejection(withTenant(SEED_TENANT_ID, (db) => db.insert(jobs).values({
      tenantId: SEED_TENANT_ID,
      type,
      payload: { tenantId: SEED_TENANT_ID },
      idempotencyKey: `retired:${type}:${crypto.randomUUID()}`,
    })), /provider job .* is retired/i);
  });
});

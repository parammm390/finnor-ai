// A2.T4 acceptance: startHeartbeat() upserts the same row repeatedly (never a new row
// per beat) and last_beat_at actually advances — the exact behavior /api/vitals (A2.T5)
// and a staged-worker-kill drill depend on for "the row went stale" to mean anything.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { getPool, closePool, workerHeartbeat } from "@finnor/db";
import { eq } from "drizzle-orm";
import { startHeartbeat, WORKER_HEARTBEAT_ID } from "../../apps/worker/src/heartbeat";

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

describe.skipIf(!available)("worker heartbeat", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await getPool().query("DELETE FROM worker_heartbeat WHERE id = $1", [WORKER_HEARTBEAT_ID]);
  });

  afterAll(async () => {
    await closePool();
  });

  it("upserts one row per beat, never inserting a duplicate, and advances last_beat_at", async () => {
    process.env.FINNOR_COMMIT_SHA = "a".repeat(40);
    process.env.FINNOR_BUILD_ID = `finnor-${"a".repeat(12)}`;
    process.env.FINNOR_VERSION = `0.1.0+${"a".repeat(12)}`;
    process.env.FINNOR_ENVIRONMENT = "production";
    process.env.FINNOR_RELEASE_SOURCE = "test";
    const { adminDb } = await import("@finnor/db");
    const controller = new AbortController();
    startHeartbeat(50, controller.signal);
    await new Promise((r) => setTimeout(r, 220)); // several ticks at a 50ms interval
    controller.abort();

    const rows = await adminDb().select().from(workerHeartbeat).where(eq(workerHeartbeat.id, WORKER_HEARTBEAT_ID));
    expect(rows).toHaveLength(1);
    const firstBeat = rows[0]!.lastBeatAt.getTime();

    await new Promise((r) => setTimeout(r, 60));
    const controller2 = new AbortController();
    startHeartbeat(30, controller2.signal);
    await new Promise((r) => setTimeout(r, 90));
    controller2.abort();

    let rows2 = await adminDb().select().from(workerHeartbeat).where(eq(workerHeartbeat.id, WORKER_HEARTBEAT_ID));
    // Abort stops future interval ticks but cannot cancel a beat already in flight.
    // Poll briefly for that committed write instead of racing it at millisecond
    // precision and making the release gate flaky.
    for (let attempt = 0; attempt < 10 && rows2[0]!.lastBeatAt.getTime() <= firstBeat; attempt++) {
      await new Promise((r) => setTimeout(r, 25));
      rows2 = await adminDb().select().from(workerHeartbeat).where(eq(workerHeartbeat.id, WORKER_HEARTBEAT_ID));
    }
    expect(rows2).toHaveLength(1); // still exactly one row — upsert, not insert
    expect(rows2[0]!.lastBeatAt.getTime()).toBeGreaterThan(firstBeat);
    expect(rows2[0]!.meta).toMatchObject({
      service: "finnor-worker",
      commitSha: "a".repeat(40),
      buildId: `finnor-${"a".repeat(12)}`,
      version: `0.1.0+${"a".repeat(12)}`,
      environment: "production",
      source: "test",
      traceable: true,
    });
    const cutoverRoles = await getPool().query<{ service: string; release_sha: string; migration_head: string }>(
      `SELECT service,release_sha,migration_head
         FROM service_release_heartbeats
        WHERE instance_id=$1 AND service=ANY($2::text[])
        ORDER BY service`,
      [WORKER_HEARTBEAT_ID, ["worker", "orchestrator", "scheduler-owner"]],
    );
    expect(cutoverRoles.rows).toEqual([
      { service: "orchestrator", release_sha: "a".repeat(40), migration_head: expect.stringMatching(/^0130_/) },
      { service: "scheduler-owner", release_sha: "a".repeat(40), migration_head: expect.stringMatching(/^0130_/) },
      { service: "worker", release_sha: "a".repeat(40), migration_head: expect.stringMatching(/^0130_/) },
    ]);
  });

  it("no-ops HEALTHCHECK_PING_URL silently when unset — never throws, never fakes a ping", async () => {
    const original = process.env.HEALTHCHECK_PING_URL;
    delete process.env.HEALTHCHECK_PING_URL;
    const controller = new AbortController();
    expect(() => startHeartbeat(20, controller.signal)).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    if (original) process.env.HEALTHCHECK_PING_URL = original;
  });
});

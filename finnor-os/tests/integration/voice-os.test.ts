// Voice OS (Phase 5, docs/jarvis-90-execution-blueprint.md §5) acceptance: real
// caller identity resolution, and — the concrete bug this replaces — confirmations
// bound to the specific session/action that drafted them, never "the tenant's newest
// pending action," which could previously cross-apply between unrelated callers.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { migrate } from "../../packages/db/migrate";
import { withTenant, closePool, tenants, domainActions, pendingConfirmations, handoffs } from "@finnor/db";
import { eq } from "drizzle-orm";
import {
  resolveVoiceIdentity,
  openVoiceSession,
  createPendingConfirmation,
  resolveOpenConfirmations,
  markConfirmationsResolved,
  createHandoff,
} from "@finnor/voice-os";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
// This suite used to share ...0f5 with bulk-notify and document tests. Vitest runs
// files concurrently, so either sibling could create the tenant without ownerPhone
// before this suite's `onConflictDoNothing()` insert; the owner-line assertion then
// depended on test scheduling. Keep the fixture tenant exclusive to Voice OS.
const TENANT_ID = "b8c6a2df-1f23-4e45-8a67-2ce8e46089b1";

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

async function draftDomainAction(): Promise<string> {
  const [row] = await withTenant(TENANT_ID, (db) =>
    db.insert(domainActions).values({ tenantId: TENANT_ID, actionType: "test_action", payload: {}, status: "pending" }).returning(),
  );
  return row!.id;
}

describe.skipIf(!available)("voice OS", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
    await withTenant(TENANT_ID, (db) =>
      db
        .insert(tenants)
        .values({ id: TENANT_ID, name: "Voice OS Test Fund", ownerPhone: "+15555550200" })
        .onConflictDoUpdate({ target: tenants.id, set: { ownerPhone: "+15555550200" } }),
    );
  });
  afterAll(async () => {
    await closePool();
  });

  it("resolves the tenant's registered owner line to role 'owner'", async () => {
    const identity = await resolveVoiceIdentity(TENANT_ID, "+15555550200");
    expect(identity.role).toBe("owner");
    // Idempotent: a second call for the same number returns the same identity row.
    const again = await resolveVoiceIdentity(TENANT_ID, "+15555550200");
    expect(again.id).toBe(identity.id);
  });

  it("an unrecognized number resolves to role 'unknown' — never silently owner", async () => {
    const identity = await resolveVoiceIdentity(TENANT_ID, "+15555559999");
    expect(identity.role).toBe("unknown");
  });

  it("openVoiceSession is idempotent by callExternalId", async () => {
    const s1 = await openVoiceSession(TENANT_ID, "call-idempotent-1");
    const s2 = await openVoiceSession(TENANT_ID, "call-idempotent-1");
    expect(s2.id).toBe(s1.id);
  });

  it("a session only ever resolves ITS OWN open confirmations — the cross-session bug fix", async () => {
    // Two independent sessions (simulating two different calls), each with its own
    // gated action pending confirmation.
    const sessionA = await openVoiceSession(TENANT_ID, "call-cross-session-a");
    const sessionB = await openVoiceSession(TENANT_ID, "call-cross-session-b");
    const actionA = await draftDomainAction();
    const actionB = await draftDomainAction();
    await createPendingConfirmation({ tenantId: TENANT_ID, voiceSessionId: sessionA.id, domainActionId: actionA, promptText: "action A" });
    await createPendingConfirmation({ tenantId: TENANT_ID, voiceSessionId: sessionB.id, domainActionId: actionB, promptText: "action B" });

    // Confirming session A's open confirmations must resolve ONLY action A.
    const openA = await resolveOpenConfirmations(TENANT_ID, sessionA.id);
    expect(openA.map((o) => o.domainActionId)).toEqual([actionA]);
    await markConfirmationsResolved(TENANT_ID, openA.map((o) => o.id), "confirmed");

    // Session B's confirmation must be untouched — still awaiting, still resolvable,
    // and still bound to actionB only.
    const stillOpenB = await resolveOpenConfirmations(TENANT_ID, sessionB.id);
    expect(stillOpenB.map((o) => o.domainActionId)).toEqual([actionB]);

    const [confirmationA] = await withTenant(TENANT_ID, (db) =>
      db.select().from(pendingConfirmations).where(eq(pendingConfirmations.domainActionId, actionA)),
    );
    expect(confirmationA!.status).toBe("confirmed");
    const [confirmationB] = await withTenant(TENANT_ID, (db) =>
      db.select().from(pendingConfirmations).where(eq(pendingConfirmations.domainActionId, actionB)),
    );
    expect(confirmationB!.status).toBe("awaiting");

    await withTenant(TENANT_ID, async (db) => {
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.domainActionId, actionA));
      await db.delete(pendingConfirmations).where(eq(pendingConfirmations.domainActionId, actionB));
      await db.delete(domainActions).where(eq(domainActions.id, actionA));
      await db.delete(domainActions).where(eq(domainActions.id, actionB));
    });
  });

  it("createHandoff records an escalation for an unresolved caller", async () => {
    const session = await openVoiceSession(TENANT_ID, "call-handoff-1");
    const { id } = await createHandoff({ tenantId: TENANT_ID, voiceSessionId: session.id, reason: "unresolved caller identity" });
    const [row] = await withTenant(TENANT_ID, (db) => db.select().from(handoffs).where(eq(handoffs.id, id)));
    expect(row!.status).toBe("open");
    expect(row!.reason).toBe("unresolved caller identity");
  });
});

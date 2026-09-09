import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applicationAccounts,
  authProfiles,
  closePool,
  configureTenantVertical,
  getPool,
  integrationSourceCoverageHistory,
  integrationSourceScopes,
  integrationSubscriptions,
  jobs,
  tenantIntegrations,
  withTenant,
} from "@finnor/db";
import { hashSubscriptionClientState } from "@finnor/provider-microsoft365";
import { and, desc, eq } from "drizzle-orm";
import { POST } from "../../apps/api/app/api/webhooks/microsoft-graph/route";
import { migrate } from "../../packages/db/migrate";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const available = await canConnect(SUPER_URL);

describe.skipIf(!available)("P2 Microsoft Graph webhook", () => {
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const directoryTenantId = randomUUID();
  const applicationAccountId = randomUUID();
  const authProfileId = randomUUID();
  const integrationId = randomUUID();
  const sourceScopeId = randomUUID();
  const subscriptionId = randomUUID();
  const providerSubscriptionId = `provider-${randomUUID()}`;
  const clientState = `state-${"a".repeat(40)}`;
  let admin: pg.Client;

  function request(overrides: Record<string, unknown> = {}): Request {
    return new Request("https://api.finnor.test/api/webhooks/microsoft-graph", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        value: [{
          subscriptionId: providerSubscriptionId,
          clientState,
          tenantId: directoryTenantId,
          changeType: "updated",
          resource: "users('mailbox-a')/messages('message-a')",
          ...overrides,
        }],
      }),
    });
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'P2 webhook project')", [tenantId, `p2-webhook-${randomUUID()}`]);
    await admin.query(
      "INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES ($1,$2,$3,'owner','active','P2 Webhook Owner')",
      [ownerId, tenantId, `p2-webhook-${randomUUID()}@test.invalid`],
    );
    process.env.DATABASE_URL = APP_URL;
    await closePool();
    await configureTenantVertical({ tenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: ownerId, sourceSystem: "test:m365-webhook" });
    await withTenant(tenantId, async (db) => {
      await db.insert(applicationAccounts).values({
        id: applicationAccountId,
        tenantId,
        accountKey: "microsoft-p2-webhook",
        application: "microsoft365",
        provider: "microsoft_graph",
        displayName: "Microsoft P2 webhook",
        providerAccountRef: directoryTenantId,
        metadata: { directoryTenantId, applicationClientId: randomUUID(), cloud: "global" },
      });
      await db.insert(authProfiles).values({
        id: authProfileId,
        tenantId,
        authProfileRef: "microsoft-p2-webhook-workload",
        principalType: "tenant",
        principalId: tenantId,
        applicationAccountId,
        purpose: "private-equity-source",
        credentialProvider: "aws-iam-federated",
        authMethod: "workload_identity",
        connectionStatus: "active",
        scope: { awsRegion: "us-east-1", federationAudience: "api://AzureADTokenExchange", federationConfigId: "test", signingAlgorithm: "ES384" },
        requiredScopes: ["Mail.Read"],
        grantedScopes: ["Mail.Read"],
      });
      await db.insert(tenantIntegrations).values({
        id: integrationId,
        tenantId,
        capability: "private_equity_source",
        binding: "microsoft_graph",
        mode: "real",
        applicationAccountId,
        authProfileId,
      });
      await db.insert(integrationSourceScopes).values({
        id: sourceScopeId,
        tenantId,
        integrationId,
        provider: "microsoft_graph",
        sourceKind: "outlook_mail_folder",
        providerScopeType: "mail_folder",
        providerResourceId: "mailbox-a/folder-a",
        scopeKey: "mail:mailbox-a:folder-a",
        syncStrategy: "delta",
        recoveryStrategy: "EXACT_DELTA",
        permissionMode: "SCOPED",
        requiredPermissions: ["Mail.Read"],
        effectivePermissions: ["Mail.Read"],
        coveragePolicy: { mailboxId: "mailbox-a", folderId: "folder-a" },
        freshnessPolicy: { recoveryCadenceMinutes: 15, maxAgeSeconds: 900 },
        configuration: { mailboxId: "mailbox-a", folderId: "folder-a" },
        configuredBy: ownerId,
      });
    });
  }, 120_000);

  beforeEach(async () => {
    await admin.query("DELETE FROM finnor_os.jobs WHERE payload->>'tenantId'=$1", [tenantId]);
    await admin.query("DELETE FROM finnor_os.integration_subscriptions WHERE tenant_id=$1", [tenantId]);
    await withTenant(tenantId, (db) => db.insert(integrationSubscriptions).values({
      id: subscriptionId,
      tenantId,
      integrationId,
      sourceScopeId,
      provider: "microsoft_graph",
      providerSubscriptionId,
      resource: "/users/mailbox-a/mailFolders/folder-a/messages",
      changeTypes: ["created", "updated", "deleted"],
      status: "active",
      expirationAt: new Date(Date.now() + 48 * 60 * 60_000),
      renewAt: new Date(Date.now() + 24 * 60 * 60_000),
      createdAtProvider: new Date(),
      clientStateHash: hashSubscriptionClientState(clientState),
    }));
  });

  afterAll(async () => {
    await closePool();
    await admin?.end();
    process.env.DATABASE_URL = SUPER_URL;
  });

  it("returns the URL-decoded validation token as exact non-HTML plain text without queueing", async () => {
    const token = "<script>alert('opaque')</script>&not-json";
    const response = await POST(new Request(`https://api.finnor.test/api/webhooks/microsoft-graph?validationToken=${encodeURIComponent(token)}`, { method: "POST" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe(token);
    expect((await getPool().query("SELECT count(*)::int count FROM finnor_os.jobs WHERE payload->>'tenantId'=$1", [tenantId])).rows[0]?.count).toBe(0);
  });

  it("validates the registered subscription and durably deduplicates a fast-path wake before returning 202", async () => {
    const started = Date.now();
    expect((await POST(request())).status).toBe(202);
    expect((await POST(request())).status).toBe(202);
    expect(Date.now() - started).toBeLessThan(3_000);
    const queued = await getPool().query("SELECT type,payload,status FROM finnor_os.jobs WHERE payload->>'tenantId'=$1", [tenantId]);
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]).toMatchObject({ type: "sync_source", status: "queued", payload: { tenantId, sourceScopeId } });
    const [subscription] = await withTenant(tenantId, (db) => db.select().from(integrationSubscriptions).where(eq(integrationSubscriptions.id, subscriptionId)));
    expect(subscription?.lastNotificationAt).toBeInstanceOf(Date);
  });

  it("fails closed for unknown subscription, clientState, provider resource, and directory mismatch", async () => {
    expect((await POST(request({ subscriptionId: "unknown-subscription" }))).status).toBe(404);
    expect((await POST(request({ clientState: `wrong-${"b".repeat(40)}` }))).status).toBe(401);
    expect((await POST(request({ resource: "users('other-mailbox')/messages('message-a')" }))).status).toBe(401);
    expect((await POST(request({ tenantId: randomUUID() }))).status).toBe(401);
    expect((await getPool().query("SELECT count(*)::int count FROM finnor_os.jobs WHERE payload->>'tenantId'=$1", [tenantId])).rows[0]?.count).toBe(0);
  });

  it("returns 5xx and rolls back notification state when durable queue insertion fails", async () => {
    await admin.query(`CREATE OR REPLACE FUNCTION finnor_os.test_reject_m365_job() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.payload->>'tenantId'='${tenantId}' THEN RAISE EXCEPTION 'injected durable queue failure'; END IF;
        RETURN NEW;
      END $$`);
    await admin.query("CREATE TRIGGER test_reject_m365_job BEFORE INSERT ON finnor_os.jobs FOR EACH ROW EXECUTE FUNCTION finnor_os.test_reject_m365_job()");
    try {
      expect((await POST(request())).status).toBe(503);
      const [subscription] = await withTenant(tenantId, (db) => db.select().from(integrationSubscriptions).where(eq(integrationSubscriptions.id, subscriptionId)));
      expect(subscription?.lastNotificationAt).toBeNull();
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS test_reject_m365_job ON finnor_os.jobs");
      await admin.query("DROP FUNCTION IF EXISTS finnor_os.test_reject_m365_job()");
    }
  });

  it("marks missed delivery RECOVERING immediately and enqueues exact source recovery", async () => {
    const response = await POST(request({ lifecycleEvent: "missed", changeType: "updated" }));
    expect(response.status).toBe(202);
    const [subscription, coverage, queued] = await Promise.all([
      withTenant(tenantId, (db) => db.select().from(integrationSubscriptions).where(eq(integrationSubscriptions.id, subscriptionId)).then((rows) => rows[0])),
      withTenant(tenantId, (db) => db.select().from(integrationSourceCoverageHistory)
        .where(eq(integrationSourceCoverageHistory.sourceScopeId, sourceScopeId))
        .orderBy(desc(integrationSourceCoverageHistory.coverageRevision)).limit(1).then((rows) => rows[0])),
      getPool().query("SELECT payload FROM finnor_os.jobs WHERE type='sync_source' AND payload->>'tenantId'=$1", [tenantId]),
    ]);
    expect(subscription).toMatchObject({ status: "active", recoveryState: "required", failureCode: "missed_notifications" });
    expect(coverage).toMatchObject({ state: "RECOVERING" });
    expect(queued.rows[0]?.payload).toMatchObject({ tenantId, sourceScopeId, forceRecovery: true });
  });

  it("marks subscriptionRemoved as removed and queues both replacement and source recovery", async () => {
    const response = await POST(request({ lifecycleEvent: "subscriptionRemoved", changeType: "updated" }));
    expect(response.status).toBe(202);
    const [subscription] = await withTenant(tenantId, (db) => db.select().from(integrationSubscriptions).where(and(
      eq(integrationSubscriptions.tenantId, tenantId),
      eq(integrationSubscriptions.id, subscriptionId),
    )));
    expect(subscription).toMatchObject({ status: "removed", recoveryState: "required", failureCode: "subscription_removed" });
    const queued = await getPool().query("SELECT type,payload FROM finnor_os.jobs WHERE payload->>'tenantId'=$1 ORDER BY type", [tenantId]);
    expect(queued.rows.map((row) => row.type)).toEqual(["maintain_integration_subscriptions", "sync_source"]);
  });

  it("queues reauthorization maintenance without exchanging a token in the request path", async () => {
    const response = await POST(request({ lifecycleEvent: "reauthorizationRequired", changeType: "updated" }));
    expect(response.status).toBe(202);
    const [subscription] = await withTenant(tenantId, (db) => db.select().from(integrationSubscriptions).where(eq(integrationSubscriptions.id, subscriptionId)));
    expect(subscription?.status).toBe("reauthorization_required");
    const queued = await getPool().query("SELECT type,payload FROM finnor_os.jobs WHERE payload->>'tenantId'=$1", [tenantId]);
    expect(queued.rows[0]).toMatchObject({ type: "maintain_integration_subscriptions", payload: { reason: "reauthorization_required" } });
  });
});

import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applicationAccounts,
  authProfiles,
  closePool,
  configureTenantVertical,
  getPool,
  integrationSourceCoverageHistory,
  integrationSourceScopes,
  integrationSubscriptions,
  tenantIntegrations,
  withTenant,
} from "@finnor/db";
import {
  clearMicrosoftGraphTokenCache,
  hashSubscriptionClientState,
  setMicrosoftIdentityTestOverrides,
} from "@finnor/provider-microsoft365";
import { and, desc, eq } from "drizzle-orm";
import { maintainIntegrationSubscriptions } from "../../apps/worker/src/handlers/maintain-integration-subscriptions";
import { RetryableJobError } from "../../apps/worker/src/queue";
import { migrate } from "../../packages/db/migrate";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const available = await canConnect(SUPER_URL);

describe.skipIf(!available)("P2 Microsoft subscription maintenance", () => {
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const directoryTenantId = randomUUID();
  const applicationClientId = randomUUID();
  const applicationAccountId = randomUUID();
  const authProfileId = randomUUID();
  const integrationId = randomUUID();
  const sourceScopeId = randomUUID();
  let admin: pg.Client;

  const job = { tenantId, integrationId, sourceScopeId, scope: "mail:mailbox-worker:folder-worker" };

  function configureIdentity(): void {
    setMicrosoftIdentityTestOverrides({
      stsSender: async () => "aws-outbound-identity-token",
      fetch: async () => Response.json({ access_token: "graph-access-token", expires_in: 3_600 }),
    });
  }

  function activeValues(overrides: Partial<typeof integrationSubscriptions.$inferInsert> = {}): typeof integrationSubscriptions.$inferInsert {
    const created = new Date();
    return {
      tenantId,
      integrationId,
      sourceScopeId,
      provider: "microsoft_graph",
      providerSubscriptionId: `active-${randomUUID()}`,
      resource: "/users/mailbox-worker/mailFolders/folder-worker/messages",
      changeTypes: ["created", "updated", "deleted"],
      status: "active",
      expirationAt: new Date(created.getTime() + 48 * 60 * 60_000),
      renewAt: new Date(created.getTime() + 24 * 60 * 60_000),
      createdAtProvider: created,
      clientStateHash: "b".repeat(64),
      ...overrides,
    };
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    process.env.AWS_REGION = "us-east-1";
    process.env.MICROSOFT_GRAPH_WEBHOOK_URL = "https://api.finnor.test/api/webhooks/microsoft-graph";
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'P2 subscription worker project')", [tenantId, `p2-sub-worker-${randomUUID()}`]);
    await admin.query(
      "INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES ($1,$2,$3,'owner','active','P2 Subscription Owner')",
      [ownerId, tenantId, `p2-sub-worker-${randomUUID()}@test.invalid`],
    );
    process.env.DATABASE_URL = APP_URL;
    await closePool();
    await configureTenantVertical({ tenantId, verticalKey: "private_equity", expectedVersion: 0, createdBy: ownerId, sourceSystem: "test:m365-subscriptions" });
    await withTenant(tenantId, async (db) => {
      await db.insert(applicationAccounts).values({
        id: applicationAccountId,
        tenantId,
        accountKey: "microsoft-p2-sub-worker",
        application: "microsoft365",
        provider: "microsoft_graph",
        displayName: "Microsoft P2 subscription worker",
        providerAccountRef: directoryTenantId,
        metadata: { directoryTenantId, applicationClientId, cloud: "global" },
      });
      await db.insert(authProfiles).values({
        id: authProfileId,
        tenantId,
        authProfileRef: "microsoft-p2-sub-worker-workload",
        principalType: "tenant",
        principalId: tenantId,
        applicationAccountId,
        purpose: "private-equity-source",
        credentialProvider: "aws-iam-federated",
        authMethod: "workload_identity",
        connectionStatus: "active",
        scope: {
          awsRegion: "us-east-1",
          federationAudience: "api://AzureADTokenExchange",
          federationConfigId: "p2-subscription-test",
          signingAlgorithm: "ES384",
          identityTokenDurationSeconds: 300,
        },
        requiredScopes: ["Mail.Read"],
        grantedScopes: ["Mail.Read"],
        restrictions: { exchangeApplicationRbac: true },
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
        providerResourceId: "mailbox-worker/folder-worker",
        scopeKey: "mail:mailbox-worker:folder-worker",
        syncStrategy: "delta",
        recoveryStrategy: "EXACT_DELTA",
        permissionMode: "SCOPED",
        requiredPermissions: ["Mail.Read"],
        effectivePermissions: ["Mail.Read"],
        providerRestrictionMethod: "Exchange Online Application RBAC",
        permissionVerifiedAt: new Date(),
        coveragePolicy: { mailboxId: "mailbox-worker", folderId: "folder-worker" },
        freshnessPolicy: { recoveryCadenceMinutes: 15, maxAgeSeconds: 900 },
        configuration: { mailboxId: "mailbox-worker", folderId: "folder-worker" },
        configuredBy: ownerId,
      });
    });
  }, 120_000);

  beforeEach(async () => {
    clearMicrosoftGraphTokenCache();
    configureIdentity();
    await admin.query("DELETE FROM finnor_os.jobs WHERE payload->>'tenantId'=$1", [tenantId]);
    await admin.query("DELETE FROM finnor_os.integration_subscriptions WHERE tenant_id=$1", [tenantId]);
    await withTenant(tenantId, async (db) => {
      await db.update(integrationSourceScopes).set({
        enabled: true,
        disabledAt: null,
        permissionVerifiedAt: new Date(),
        effectivePermissions: ["Mail.Read"],
      }).where(eq(integrationSourceScopes.id, sourceScopeId));
      await db.update(authProfiles).set({ connectionStatus: "active", reauthRequiredAt: null, lastConnectionErrorCode: null }).where(eq(authProfiles.id, authProfileId));
      await db.update(tenantIntegrations).set({ webhookStatus: "unknown", health: "unknown", lastError: null }).where(eq(tenantIntegrations.id, integrationId));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMicrosoftGraphTokenCache();
    setMicrosoftIdentityTestOverrides({ stsSender: null, fetch: null });
  });

  afterAll(async () => {
    await closePool();
    await admin?.end();
    process.env.DATABASE_URL = SUPER_URL;
  });

  it("creates the subscription before queueing initial sync, persists only the clientState hash, renews without plaintext, and disables without deleting history", async () => {
    const calls: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ method, url, body });
      if (method === "POST") return Response.json({
        id: `provider-created-${sourceScopeId}`,
        resource: body.resource,
        changeType: body.changeType,
        expirationDateTime: body.expirationDateTime,
        notificationUrl: body.notificationUrl,
        lifecycleNotificationUrl: body.lifecycleNotificationUrl,
      }, { status: 201 });
      if (method === "PATCH") return Response.json({
        id: `provider-created-${sourceScopeId}`,
        resource: "users/mailbox-worker/mailFolders/folder-worker/messages",
        changeType: "created,updated,deleted",
        expirationDateTime: body.expirationDateTime,
      });
      if (method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected Graph subscription call ${method} ${url}`);
    }));

    await maintainIntegrationSubscriptions(job);
    let [subscription] = await withTenant(tenantId, (db) => db.select().from(integrationSubscriptions)
      .where(eq(integrationSubscriptions.sourceScopeId, sourceScopeId)));
    expect(subscription).toMatchObject({ providerSubscriptionId: `provider-created-${sourceScopeId}`, status: "active", recoveryState: "none" });
    const plaintext = calls[0]?.body.clientState;
    expect(typeof plaintext).toBe("string");
    expect(subscription?.clientStateHash).toBe(hashSubscriptionClientState(String(plaintext)));
    expect(JSON.stringify(subscription)).not.toContain(String(plaintext));
    expect(calls[0]?.body).toMatchObject({
      notificationUrl: process.env.MICROSOFT_GRAPH_WEBHOOK_URL,
      lifecycleNotificationUrl: process.env.MICROSOFT_GRAPH_WEBHOOK_URL,
      changeType: "created,updated,deleted",
    });
    const initialJobs = await getPool().query("SELECT type,payload FROM finnor_os.jobs WHERE payload->>'tenantId'=$1", [tenantId]);
    expect(initialJobs.rows[0]).toMatchObject({ type: "sync_source", payload: { subscriptionEstablished: true, sourceScopeId } });

    await withTenant(tenantId, (db) => db.update(integrationSubscriptions).set({ renewAt: new Date(Date.now() - 1_000) })
      .where(eq(integrationSubscriptions.id, subscription!.id)));
    await maintainIntegrationSubscriptions(job);
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch).toBeDefined();
    expect(JSON.stringify(patch?.body)).not.toContain("clientState");
    [subscription] = await withTenant(tenantId, (db) => db.select().from(integrationSubscriptions)
      .where(eq(integrationSubscriptions.sourceScopeId, sourceScopeId)));
    expect(subscription).toMatchObject({ status: "active", failureCode: null });

    await withTenant(tenantId, (db) => db.update(integrationSourceScopes).set({
      enabled: false,
      disabledAt: new Date(),
      permissionVerifiedAt: null,
      effectivePermissions: [],
    })
      .where(eq(integrationSourceScopes.id, sourceScopeId)));
    await maintainIntegrationSubscriptions(job);
    [subscription] = await withTenant(tenantId, (db) => db.select().from(integrationSubscriptions)
      .where(eq(integrationSubscriptions.sourceScopeId, sourceScopeId)));
    expect(subscription?.status).toBe("disabled");
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
    const [coverage] = await withTenant(tenantId, (db) => db.select().from(integrationSourceCoverageHistory)
      .where(eq(integrationSourceCoverageHistory.sourceScopeId, sourceScopeId))
      .orderBy(desc(integrationSourceCoverageHistory.coverageRevision)).limit(1));
    expect(coverage?.state).toBe("DISABLED");
  });

  it("reconciles the create-response crash window from Graph clientState without issuing a duplicate create", async () => {
    const clientState = `reconcile-${"x".repeat(32)}`;
    await withTenant(tenantId, (db) => db.insert(integrationSubscriptions).values({
      tenantId,
      integrationId,
      sourceScopeId,
      provider: "microsoft_graph",
      resource: "/users/mailbox-worker/mailFolders/folder-worker/messages",
      changeTypes: ["created", "updated", "deleted"],
      status: "provisioning",
      clientStateHash: hashSubscriptionClientState(clientState),
    }));
    const graph = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json({ value: [{
        id: `provider-reconciled-${sourceScopeId}`,
        resource: "users/mailbox-worker/mailFolders/folder-worker/messages",
        changeType: "created,updated,deleted",
        expirationDateTime: new Date(Date.now() + 48 * 60 * 60_000).toISOString(),
        clientState,
      }] });
    });
    vi.stubGlobal("fetch", graph);
    await maintainIntegrationSubscriptions(job);
    const [subscription] = await withTenant(tenantId, (db) => db.select().from(integrationSubscriptions)
      .where(eq(integrationSubscriptions.sourceScopeId, sourceScopeId)));
    expect(subscription).toMatchObject({ status: "active", providerSubscriptionId: `provider-reconciled-${sourceScopeId}` });
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it("best-effort deletes a remote create when the local active commit fails and never claims active", async () => {
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({
          id: `provider-orphan-${sourceScopeId}`,
          resource: body.resource,
          changeType: body.changeType,
          expirationDateTime: body.expirationDateTime,
        }, { status: 201 });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      throw new Error("unexpected call");
    }));
    await admin.query(`CREATE OR REPLACE FUNCTION finnor_os.test_reject_m365_active() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tenant_id='${tenantId}'::uuid AND NEW.status='active' THEN RAISE EXCEPTION 'injected active persistence failure'; END IF;
        RETURN NEW;
      END $$`);
    await admin.query("CREATE TRIGGER test_reject_m365_active BEFORE UPDATE ON finnor_os.integration_subscriptions FOR EACH ROW EXECUTE FUNCTION finnor_os.test_reject_m365_active()");
    try {
      await expect(maintainIntegrationSubscriptions(job)).rejects.toBeInstanceOf(RetryableJobError);
      expect(methods).toEqual(["POST", "DELETE"]);
      const [subscription] = await withTenant(tenantId, (db) => db.select().from(integrationSubscriptions)
        .where(eq(integrationSubscriptions.sourceScopeId, sourceScopeId)));
      expect(subscription?.status).not.toBe("active");
      expect(subscription?.providerSubscriptionId).toBeNull();
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS test_reject_m365_active ON finnor_os.integration_subscriptions");
      await admin.query("DROP FUNCTION IF EXISTS finnor_os.test_reject_m365_active()");
    }
  });

  it.each([
    [401, "reauthorization_required", false],
    [403, "degraded", false],
    [429, "degraded", true],
  ] as const)("persists safe renewal failure state for Graph %s", async (status, expectedStatus, retryable) => {
    await withTenant(tenantId, (db) => db.insert(integrationSubscriptions).values(activeValues({ renewAt: new Date(Date.now() - 1_000) })));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: `test-${status}` } }), {
      status,
      headers: { "content-type": "application/json", ...(status === 429 ? { "retry-after": "1" } : {}) },
    })));
    const operation = maintainIntegrationSubscriptions(job);
    if (retryable) await expect(operation).rejects.toBeInstanceOf(RetryableJobError);
    else await operation;
    const [subscription] = await withTenant(tenantId, (db) => db.select().from(integrationSubscriptions)
      .where(eq(integrationSubscriptions.sourceScopeId, sourceScopeId)));
    expect(subscription?.status).toBe(expectedStatus);
  });

  it("recreates an expired subscription and marks the replacement sync as recovery", async () => {
    const expiredId = randomUUID();
    await withTenant(tenantId, (db) => db.insert(integrationSubscriptions).values(activeValues({
      id: expiredId,
      providerSubscriptionId: `provider-expired-${sourceScopeId}`,
      expirationAt: new Date(Date.now() - 1_000),
      renewAt: new Date(Date.now() - 60_000),
    })));
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        id: `provider-replacement-${sourceScopeId}`,
        resource: body.resource,
        changeType: body.changeType,
        expirationDateTime: body.expirationDateTime,
      }, { status: 201 });
    }));
    await maintainIntegrationSubscriptions(job);
    const rows = await withTenant(tenantId, (db) => db.select().from(integrationSubscriptions)
      .where(and(eq(integrationSubscriptions.tenantId, tenantId), eq(integrationSubscriptions.sourceScopeId, sourceScopeId))));
    expect(rows.find((row) => row.id === expiredId)?.status).toBe("expired");
    expect(rows.find((row) => row.providerSubscriptionId === `provider-replacement-${sourceScopeId}`)).toMatchObject({ status: "active", recoveryState: "running" });
    const queued = await getPool().query("SELECT payload FROM finnor_os.jobs WHERE type='sync_source' AND payload->>'tenantId'=$1", [tenantId]);
    expect(queued.rows[0]?.payload).toMatchObject({ sourceScopeId, forceRecovery: true });
  });
});

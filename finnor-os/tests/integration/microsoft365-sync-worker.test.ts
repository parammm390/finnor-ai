import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  applicationAccounts,
  authProfiles,
  externalRefObservations,
  integrationSourceCoverageHistory,
  integrationSourceScopes,
  integrationSubscriptions,
  integrationSyncCheckpoints,
  tenantIntegrations,
  closePool,
  configureTenantVertical,
  withTenant,
} from "@finnor/db";
import { clearMicrosoftGraphTokenCache, setMicrosoftIdentityTestOverrides } from "@finnor/provider-microsoft365";
import { syncSource } from "../../apps/worker/src/handlers/sync-source";
import { migrate } from "../../packages/db/migrate";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const available = await canConnect(SUPER_URL);

describe.skipIf(!available)("P2 Microsoft 365 sync/checkpoint runtime", () => {
  const tenantId = randomUUID();
  const ownerId = randomUUID();
  const directoryTenantId = randomUUID();
  const applicationClientId = randomUUID();
  const applicationAccountId = randomUUID();
  const authProfileId = randomUUID();
  const integrationId = randomUUID();
  const sourceScopeId = randomUUID();
  const authFailureScopeId = randomUUID();
  const malformedScopeId = randomUUID();
  const replayScopeId = randomUUID();
  let admin: pg.Client;

  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    process.env.AWS_REGION = "us-east-1";
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    await admin.query(
      "INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,'P2 Microsoft sync project')",
      [tenantId, `p2-m365-sync-${randomUUID()}`],
    );
    await admin.query(
      "INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES ($1,$2,$3,'owner','active','P2 Sync Owner')",
      [ownerId, tenantId, `p2-sync-${randomUUID()}@test.invalid`],
    );
    process.env.DATABASE_URL = APP_URL;
    await closePool();
    await configureTenantVertical({
      tenantId,
      verticalKey: "private_equity",
      expectedVersion: 0,
      createdBy: ownerId,
      sourceSystem: "test:microsoft365-sync",
    });
    await withTenant(tenantId, async (db) => {
      await db.insert(applicationAccounts).values({
        id: applicationAccountId,
        tenantId,
        accountKey: "microsoft-p2-sync",
        application: "microsoft365",
        provider: "microsoft_graph",
        displayName: "Microsoft 365 P2 sync",
        providerAccountRef: directoryTenantId,
        capabilities: ["private_equity_source"],
        metadata: { directoryTenantId, applicationClientId, cloud: "global" },
      });
      await db.insert(authProfiles).values({
        id: authProfileId,
        tenantId,
        authProfileRef: "microsoft-p2-sync-workload",
        principalType: "tenant",
        principalId: tenantId,
        applicationAccountId,
        purpose: "private-equity-source",
        scope: {
          awsRegion: "us-east-1",
          federationAudience: "api://AzureADTokenExchange",
          federationConfigId: "finnor-p2-test",
          signingAlgorithm: "ES384",
          identityTokenDurationSeconds: 300,
        },
        credentialProvider: "aws-iam-federated",
        authMethod: "workload_identity",
        connectionStatus: "active",
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
        providerResourceId: "mailbox-1/folder-1",
        scopeKey: "mail:mailbox-1:folder-1",
        syncStrategy: "delta" as const,
        recoveryStrategy: "EXACT_DELTA" as const,
        permissionMode: "SCOPED",
        requiredPermissions: ["Mail.Read"],
        effectivePermissions: ["Mail.Read"],
        providerRestrictionMethod: "Exchange Online Application RBAC",
        permissionVerifiedAt: new Date(),
        coveragePolicy: { mailboxId: "mailbox-1", folderId: "folder-1" },
        freshnessPolicy: { recoveryCadenceMinutes: 15, maxAgeSeconds: 900 },
        configuration: { mailboxId: "mailbox-1", folderId: "folder-1" },
        configuredBy: ownerId,
      });
      await db.insert(integrationSubscriptions).values({
        tenantId,
        integrationId,
        sourceScopeId,
        provider: "microsoft_graph",
        providerSubscriptionId: `subscription-sync-test-${sourceScopeId}`,
        resource: "/users/mailbox-1/mailFolders/folder-1/messages",
        changeTypes: ["created", "updated", "deleted"],
        status: "active",
        expirationAt: new Date(Date.now() + 2 * 24 * 60 * 60_000),
        renewAt: new Date(Date.now() + 24 * 60 * 60_000),
        createdAtProvider: new Date(),
        clientStateHash: "a".repeat(64),
      });
      const additionalScopes = [
        { id: authFailureScopeId, mailboxId: "mailbox-auth-failure", scopeKey: "mail:auth-failure" },
        { id: malformedScopeId, mailboxId: "mailbox-malformed", scopeKey: "mail:malformed" },
        { id: replayScopeId, mailboxId: "mailbox-replay", scopeKey: "mail:replay" },
      ];
      await db.insert(integrationSourceScopes).values(additionalScopes.map((item) => ({
        id: item.id,
        tenantId,
        integrationId,
        provider: "microsoft_graph" as const,
        sourceKind: "outlook_mail_folder" as const,
        providerScopeType: "mail_folder",
        providerResourceId: `${item.mailboxId}/folder-1`,
        scopeKey: item.scopeKey,
        syncStrategy: "delta" as const,
        recoveryStrategy: "EXACT_DELTA" as const,
        permissionMode: "SCOPED" as const,
        requiredPermissions: ["Mail.Read"],
        effectivePermissions: ["Mail.Read"],
        providerRestrictionMethod: "Exchange Online Application RBAC",
        permissionVerifiedAt: new Date(),
        coveragePolicy: { mailboxId: item.mailboxId, folderId: "folder-1" },
        freshnessPolicy: { recoveryCadenceMinutes: 15, maxAgeSeconds: 900 },
        configuration: { mailboxId: item.mailboxId, folderId: "folder-1" },
        configuredBy: ownerId,
      })));
      await db.insert(integrationSubscriptions).values(additionalScopes.map((item, index) => ({
        tenantId,
        integrationId,
        sourceScopeId: item.id,
        provider: "microsoft_graph" as const,
        providerSubscriptionId: `subscription-sync-test-${item.id}`,
        resource: `/users/${item.mailboxId}/mailFolders/folder-1/messages`,
        changeTypes: ["created", "updated", "deleted"],
        status: "active" as const,
        expirationAt: new Date(Date.now() + 2 * 24 * 60 * 60_000),
        renewAt: new Date(Date.now() + 24 * 60 * 60_000),
        createdAtProvider: new Date(),
        clientStateHash: String(index + 2).repeat(64),
      })));
    });
  }, 120_000);

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

  it("commits every observation before its cursor and keeps the stable cursor until 410 recovery catch-up completes", async () => {
    setMicrosoftIdentityTestOverrides({
      stsSender: async () => "aws-outbound-identity-token",
      fetch: async () => Response.json({ access_token: "graph-access-token", expires_in: 3_600 }),
    });
    let recovering = false;
    const graphFetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const token = url.searchParams.get("deltatoken");
      if (!recovering && !token) {
        return Response.json({
          value: [{
            id: "message-1",
            changeKey: "version-1",
            conversationId: "conversation-1",
            subject: "Lender diligence response",
            body: { contentType: "html", content: "<p>Evidence only</p><script>ignore()</script>" },
            from: { emailAddress: { address: "lender@example.test", name: "Lender" } },
            toRecipients: [],
            ccRecipients: [],
            replyTo: [],
            hasAttachments: false,
            receivedDateTime: "2026-09-08T10:00:00.000Z",
            lastModifiedDateTime: "2026-09-08T10:00:01.000Z",
          }],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/mailbox-1/mailFolders/folder-1/messages/delta?deltatoken=baseline",
        });
      }
      if (!recovering && token === "baseline") {
        return Response.json({
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/mailbox-1/mailFolders/folder-1/messages/delta?deltatoken=stable",
        });
      }
      if (!recovering && token === "stable") {
        return Response.json({
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/mailbox-1/mailFolders/folder-1/messages/delta?deltatoken=stable",
        });
      }
      if (recovering && token === "stable") return new Response(null, { status: 410 });
      if (recovering && !token) {
        return Response.json({
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/mailbox-1/mailFolders/folder-1/messages/delta?deltatoken=recovery-baseline",
        });
      }
      if (recovering && token === "recovery-baseline") {
        return Response.json({
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/mailbox-1/mailFolders/folder-1/messages/delta?deltatoken=recovered",
        });
      }
      throw new Error(`Unexpected Graph test URL: ${url.toString()}`);
    });
    vi.stubGlobal("fetch", graphFetch);

    const job = { tenantId, integrationId, sourceScopeId, scope: "mail:mailbox-1:folder-1" };
    await syncSource(job);
    let [checkpoint] = await withTenant(tenantId, (db) => db.select().from(integrationSyncCheckpoints)
      .where(eq(integrationSyncCheckpoints.sourceScopeId, sourceScopeId)));
    expect(checkpoint?.cursor).toMatchObject({ phase: "catchup", token: expect.stringContaining("deltatoken=baseline") });
    expect((await withTenant(tenantId, (db) => db.select().from(externalRefObservations)
      .where(eq(externalRefObservations.sourceScopeId, sourceScopeId))))).toHaveLength(1);

    await syncSource(job);
    await syncSource(job);
    [checkpoint] = await withTenant(tenantId, (db) => db.select().from(integrationSyncCheckpoints)
      .where(eq(integrationSyncCheckpoints.sourceScopeId, sourceScopeId)));
    expect(checkpoint?.cursor).toMatchObject({ phase: "incremental", token: expect.stringContaining("deltatoken=stable") });
    expect(checkpoint?.recovery).toEqual({});

    recovering = true;
    await syncSource({ ...job, forceRecovery: true });
    [checkpoint] = await withTenant(tenantId, (db) => db.select().from(integrationSyncCheckpoints)
      .where(eq(integrationSyncCheckpoints.sourceScopeId, sourceScopeId)));
    expect(checkpoint?.cursor).toMatchObject({ token: expect.stringContaining("deltatoken=stable") });
    expect(checkpoint?.recovery).toMatchObject({ cursor: { phase: "recovery" } });

    await syncSource({ ...job, forceRecovery: true });
    [checkpoint] = await withTenant(tenantId, (db) => db.select().from(integrationSyncCheckpoints)
      .where(eq(integrationSyncCheckpoints.sourceScopeId, sourceScopeId)));
    expect(checkpoint?.cursor).toMatchObject({ token: expect.stringContaining("deltatoken=stable") });
    expect(checkpoint?.recovery).toMatchObject({ cursor: { phase: "catchup", token: expect.stringContaining("deltatoken=recovery-baseline") } });

    await syncSource({ ...job, forceRecovery: true });
    const [finalCheckpoint, coverage] = await withTenant(tenantId, async (db) => Promise.all([
      db.select().from(integrationSyncCheckpoints).where(eq(integrationSyncCheckpoints.sourceScopeId, sourceScopeId)).then((rows) => rows[0]),
      db.select().from(integrationSourceCoverageHistory).where(eq(integrationSourceCoverageHistory.sourceScopeId, sourceScopeId))
        .orderBy(asc(integrationSourceCoverageHistory.coverageRevision)),
    ]));
    expect(finalCheckpoint?.cursor).toMatchObject({ phase: "incremental", token: expect.stringContaining("deltatoken=recovered") });
    expect(finalCheckpoint?.recovery).toEqual({});
    expect(coverage.map((row) => row.state)).toEqual(expect.arrayContaining(["INITIALIZING", "COMPLETE", "RECOVERING"]));
    expect((await withTenant(tenantId, (db) => db.select().from(externalRefObservations)
      .where(and(eq(externalRefObservations.sourceScopeId, sourceScopeId), eq(externalRefObservations.externalId, "mailbox-1/message-1")))))).toHaveLength(1);
    expect(graphFetch).toHaveBeenCalledTimes(6);
  });

  it("keeps an empty cursor and records BLOCKED_AUTH when workload token exchange fails persistently", async () => {
    setMicrosoftIdentityTestOverrides({
      stsSender: async () => "aws-outbound-identity-token",
      fetch: async () => Response.json({ error: "invalid_client", error_description: "federation rejected" }, { status: 401 }),
    });
    await syncSource({
      tenantId,
      integrationId,
      sourceScopeId: authFailureScopeId,
      scope: "mail:auth-failure",
    });
    const state = await admin.query<{
      cursor: Record<string, unknown>;
      status: string;
      error_code: string | null;
      coverage_state: string;
      observations: number;
    }>(
      `SELECT c.cursor,c.status,c.error_code,
        (SELECT h.state FROM finnor_os.integration_source_coverage_history h
          WHERE h.tenant_id=c.tenant_id AND h.source_scope_id=c.source_scope_id
          ORDER BY h.coverage_revision DESC LIMIT 1) coverage_state,
        (SELECT count(*)::int FROM finnor_os.external_ref_observations o
          WHERE o.tenant_id=c.tenant_id AND o.source_scope_id=c.source_scope_id) observations
       FROM finnor_os.integration_sync_checkpoints c
       WHERE c.tenant_id=$1 AND c.source_scope_id=$2`,
      [tenantId, authFailureScopeId],
    );
    expect(state.rows[0]).toEqual({
      cursor: {},
      status: "blocked",
      error_code: "auth_failure",
      coverage_state: "BLOCKED_AUTH",
      observations: 0,
    });
  });

  it("does not advance the cursor when normalization fails after a successful Graph page response", async () => {
    setMicrosoftIdentityTestOverrides({
      stsSender: async () => "aws-outbound-identity-token",
      fetch: async () => Response.json({ access_token: "graph-access-token", expires_in: 3_600 }),
    });
    const graphFetch = vi.fn(async () => Response.json({
      value: [{ subject: "Malformed provider item deliberately has no immutable id" }],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/mailbox-malformed/mailFolders/folder-1/messages/delta?deltatoken=must-not-commit",
    }));
    vi.stubGlobal("fetch", graphFetch);
    await syncSource({
      tenantId,
      integrationId,
      sourceScopeId: malformedScopeId,
      scope: "mail:malformed",
    });
    const state = await admin.query<{
      cursor: Record<string, unknown>;
      status: string;
      coverage_state: string;
      observations: number;
    }>(
      `SELECT c.cursor,c.status,
        (SELECT h.state FROM finnor_os.integration_source_coverage_history h
          WHERE h.tenant_id=c.tenant_id AND h.source_scope_id=c.source_scope_id
          ORDER BY h.coverage_revision DESC LIMIT 1) coverage_state,
        (SELECT count(*)::int FROM finnor_os.external_ref_observations o
          WHERE o.tenant_id=c.tenant_id AND o.source_scope_id=c.source_scope_id) observations
       FROM finnor_os.integration_sync_checkpoints c
       WHERE c.tenant_id=$1 AND c.source_scope_id=$2`,
      [tenantId, malformedScopeId],
    );
    expect(graphFetch).toHaveBeenCalledTimes(1);
    expect(state.rows[0]).toEqual({ cursor: {}, status: "degraded", coverage_state: "PARTIAL", observations: 0 });
  });

  it("replays a committed observation exactly once after a crash immediately before checkpoint advancement", async () => {
    setMicrosoftIdentityTestOverrides({
      stsSender: async () => "aws-outbound-identity-token",
      fetch: async () => Response.json({ access_token: "graph-access-token", expires_in: 3_600 }),
    });
    const messageId = "message-replay";
    const externalObjectId = `mailbox-replay/${messageId}`;
    const graphFetch = vi.fn(async () => Response.json({
      value: [{
        id: messageId,
        changeKey: "version-replay-1",
        conversationId: "conversation-replay",
        subject: "Replay-safe evidence",
        body: { contentType: "text", content: "Provider evidence only" },
        from: { emailAddress: { address: "source@example.test", name: "Source" } },
        toRecipients: [],
        ccRecipients: [],
        replyTo: [],
        hasAttachments: false,
        receivedDateTime: "2026-09-08T10:00:00.000Z",
        lastModifiedDateTime: "2026-09-08T10:00:01.000Z",
      }],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/mailbox-replay/mailFolders/folder-1/messages/delta?deltatoken=replay-baseline",
    }));
    vi.stubGlobal("fetch", graphFetch);
    await withTenant(tenantId, (db) => db.insert(integrationSyncCheckpoints).values({
      tenantId,
      integrationId,
      sourceScopeId: replayScopeId,
      sourceScope: "mail:replay",
      cursor: { version: 1, phase: "incremental" },
      cursorVersion: 1,
    }).onConflictDoNothing());
    await admin.query(`
      CREATE OR REPLACE FUNCTION finnor_os.test_p2_crash_before_checkpoint() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,finnor_os AS $$
      BEGIN
        IF NEW.source_scope_id='${replayScopeId}'::uuid AND NEW.cursor IS DISTINCT FROM OLD.cursor THEN
          RAISE EXCEPTION 'simulated crash before checkpoint advancement';
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS test_p2_crash_before_checkpoint ON finnor_os.integration_sync_checkpoints;
      CREATE TRIGGER test_p2_crash_before_checkpoint BEFORE UPDATE ON finnor_os.integration_sync_checkpoints
        FOR EACH ROW EXECUTE FUNCTION finnor_os.test_p2_crash_before_checkpoint();
    `);
    const job = { tenantId, integrationId, sourceScopeId: replayScopeId, scope: "mail:replay" };
    try {
      await expect(syncSource(job)).rejects.toThrow(/Failed query/i);
    } finally {
      await admin.query(`
        DROP TRIGGER IF EXISTS test_p2_crash_before_checkpoint ON finnor_os.integration_sync_checkpoints;
        DROP FUNCTION IF EXISTS finnor_os.test_p2_crash_before_checkpoint();
      `);
    }
    const failed = await admin.query<{ cursor: Record<string, unknown>; status: string; observations: number }>(
      `SELECT c.cursor,c.status,
        (SELECT count(*)::int FROM finnor_os.external_ref_observations o
          WHERE o.tenant_id=c.tenant_id AND o.source_scope_id=c.source_scope_id AND o.external_id=$3) observations
       FROM finnor_os.integration_sync_checkpoints c
       WHERE c.tenant_id=$1 AND c.source_scope_id=$2`,
      [tenantId, replayScopeId, externalObjectId],
    );
    expect(failed.rows[0]).toEqual({ cursor: { version: 1, phase: "incremental" }, status: "degraded", observations: 1 });

    await syncSource(job);
    const converged = await admin.query<{
      cursor: Record<string, unknown>;
      observations: number;
      versions: number;
      business_events: number;
      integration_events: number;
    }>(
      `SELECT c.cursor,
        (SELECT count(*)::int FROM finnor_os.external_ref_observations o
          WHERE o.tenant_id=c.tenant_id AND o.source_scope_id=c.source_scope_id AND o.external_id=$3) observations,
        (SELECT count(*)::int FROM finnor_os.evidence_source_versions v
          JOIN finnor_os.evidence_sources s ON s.id=v.source_id
          WHERE s.tenant_id=c.tenant_id AND s.metadata->>'externalObjectId'=$3) versions,
        (SELECT count(*)::int FROM finnor_os.business_events b
          WHERE b.tenant_id=c.tenant_id AND b.payload->>'externalObjectId'=$3) business_events,
        (SELECT count(*)::int FROM finnor_os.integration_events e
          WHERE e.tenant_id=c.tenant_id AND e.provider_message_id=$3) integration_events
       FROM finnor_os.integration_sync_checkpoints c
       WHERE c.tenant_id=$1 AND c.source_scope_id=$2`,
      [tenantId, replayScopeId, externalObjectId],
    );
    expect(converged.rows[0]).toMatchObject({
      cursor: { phase: "incremental", token: expect.stringContaining("deltatoken=replay-baseline") },
      observations: 1,
      versions: 1,
      business_events: 1,
      integration_events: 1,
    });
    expect(graphFetch).toHaveBeenCalledTimes(2);
  });
});

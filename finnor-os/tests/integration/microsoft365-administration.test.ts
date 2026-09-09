import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  applicationAccounts,
  applicationConsentRequests,
  authProfiles,
  closePool,
  configureTenantVertical,
  connectionEvents,
  integrationSourceCoverageHistory,
  integrationSourceScopes,
  jobs,
  tenantIntegrations,
  withTenant,
} from "@finnor/db";
import {
  beginMicrosoftGraphConnection,
  completeMicrosoftGraphAdminConsent,
  configureMicrosoft365Source,
  disableMicrosoft365Source,
  getMicrosoftGraphConnectionStatus,
  getMicrosoft365SourceScopeStatus,
  listMicrosoft365SourceScopes,
  Microsoft365AdministrationError,
  readMicrosoft365Coverage,
} from "@finnor/data-platform";
import {
  clearMicrosoftGraphTokenCache,
  setMicrosoftIdentityTestOverrides,
} from "@finnor/provider-microsoft365";
import { asc, eq } from "drizzle-orm";
import { migrate } from "../../packages/db/migrate";

const SUPER_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const APP_URL = SUPER_URL.replace(/\/\/[^@]+@/, "//finnor_app:finnor_app@");

async function canConnect(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); return true; } catch { return false; } finally { await client.end().catch(() => undefined); }
}

const available = await canConnect(SUPER_URL);

type Project = {
  tenantId: string;
  ownerId: string;
  employeeId: string;
  directoryTenantId: string;
  applicationClientId: string;
};

function jwt(project: Project, roles: string[]): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({
      tid: project.directoryTenantId,
      azp: project.applicationClientId,
      aud: "https://graph.microsoft.com",
      oid: randomUUID(),
      roles,
      exp: 1_900_000_000,
    })).toString("base64url"),
    "test-signature",
  ].join(".");
}

function stateFrom(result: Awaited<ReturnType<typeof beginMicrosoftGraphConnection>>): string {
  const state = new URL(result.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("Test consent URL did not contain state");
  return state;
}

describe.skipIf(!available)("P2 Microsoft 365 administrative control plane", () => {
  let admin: pg.Client;

  async function createProject(label: string): Promise<Project> {
    const project: Project = {
      tenantId: randomUUID(),
      ownerId: randomUUID(),
      employeeId: randomUUID(),
      directoryTenantId: randomUUID(),
      applicationClientId: randomUUID(),
    };
    await admin.query(
      "INSERT INTO finnor_os.tenants(id,client_key,name) VALUES ($1,$2,$3)",
      [project.tenantId, `p2m365-${label.slice(0, 12)}-${randomUUID().slice(0, 12)}`, `P2 M365 admin ${label}`],
    );
    await admin.query(
      `INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name)
       VALUES ($1,$2,$3,'owner','active','P2 M365 Owner'),($4,$2,$5,'dispatcher','active','Ordinary Employee')`,
      [
        project.ownerId,
        project.tenantId,
        `p2-m365-owner-${randomUUID()}@test.invalid`,
        project.employeeId,
        `p2-m365-employee-${randomUUID()}@test.invalid`,
      ],
    );
    await configureTenantVertical({
      tenantId: project.tenantId,
      verticalKey: "private_equity",
      expectedVersion: 0,
      createdBy: project.ownerId,
      sourceSystem: "test:microsoft365-administration",
    });
    return project;
  }

  async function begin(project: Project, actorId = project.ownerId, permissions = ["Mail.Read"]): Promise<Awaited<ReturnType<typeof beginMicrosoftGraphConnection>>> {
    return beginMicrosoftGraphConnection({
      tenantId: project.tenantId,
      actorId,
      directoryTenantId: project.directoryTenantId,
      applicationClientId: project.applicationClientId,
      requestedPermissions: permissions,
      auth: {
        kind: "federated_workload",
        awsRegion: "us-east-1",
        federationAudience: "api://AzureADTokenExchange",
        federationConfigId: `test-${project.tenantId}`,
        signingAlgorithm: "RS256",
        identityTokenDurationSeconds: 300,
      },
      redirectUri: "http://localhost:3100/api/connections/microsoft-graph/callback",
      traceId: randomUUID(),
    });
  }

  function useToken(project: Project, roles: string[]): string {
    const token = jwt(project, roles);
    setMicrosoftIdentityTestOverrides({
      stsSender: async () => "aws-outbound-identity-token",
      fetch: async () => Response.json({ access_token: token, token_type: "Bearer", expires_in: 3_600 }),
    });
    return token;
  }

  async function connect(project: Project, permissions = ["Mail.Read"]): Promise<Awaited<ReturnType<typeof beginMicrosoftGraphConnection>>> {
    const started = await begin(project, project.ownerId, permissions);
    useToken(project, permissions);
    const completed = await completeMicrosoftGraphAdminConsent({
      state: stateFrom(started),
      returnedDirectoryTenantId: project.directoryTenantId,
      adminConsent: true,
      traceId: randomUUID(),
    });
    expect(completed.status).toBe("active");
    return started;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = SUPER_URL;
    process.env.AWS_REGION = "us-east-1";
    await migrate(SUPER_URL);
    admin = new pg.Client({ connectionString: SUPER_URL });
    await admin.connect();
    await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");
    await admin.query("SET app.test_vertical_mode = 'explicit'");
    process.env.DATABASE_URL = APP_URL;
    await closePool();
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

  it("reuses one account/profile for three canonical capabilities, supersedes stale consent, and activates only after a real app-token probe", async () => {
    const project = await createProject("identity");
    const first = await begin(project, project.ownerId, ["Mail.Read", "Calendars.Read"]);
    const second = await begin(project, project.ownerId, ["Mail.Read", "Calendars.Read"]);
    const firstState = stateFrom(first);
    const secondState = stateFrom(second);
    expect(first.integrationIds).toEqual(second.integrationIds);
    expect(first.authProfileRef).toBe(second.authProfileRef);

    const consentUrl = new URL(second.authorizationUrl);
    expect(consentUrl.origin).toBe("https://login.microsoftonline.com");
    expect(consentUrl.pathname).toBe(`/${project.directoryTenantId}/v2.0/adminconsent`);
    expect(consentUrl.searchParams.get("client_id")).toBe(project.applicationClientId);
    expect(consentUrl.searchParams.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(consentUrl.searchParams.get("redirect_uri")).toBe("http://localhost:3100/api/connections/microsoft-graph/callback");

    const before = await getMicrosoftGraphConnectionStatus({ tenantId: project.tenantId });
    expect(before.summary).toMatchObject({ total: 1, active: 0, blocked: 1 });
    expect(before.connections[0]).toMatchObject({
      provider: "microsoft_graph",
      directoryTenantId: project.directoryTenantId,
      applicationClientId: project.applicationClientId,
      authKind: "federated_workload",
      status: "connecting",
      usable: false,
      requestedPermissions: ["Calendars.Read", "Mail.Read"],
    });
    expect((before.connections[0]?.capabilityBindings as Array<Record<string, unknown>>).map((row) => row.capability).sort())
      .toEqual(["communications", "documents", "scheduling"]);

    const persisted = await admin.query<{
      accounts: number;
      profiles: number;
      integrations: number;
      open_requests: number;
      expired_requests: number;
      raw_state_count: number;
      hashed_state_count: number;
      credential_ref_count: number;
    }>(
      `SELECT
         (SELECT count(*)::int FROM finnor_os.application_accounts WHERE tenant_id=$1) accounts,
         (SELECT count(*)::int FROM finnor_os.auth_profiles WHERE tenant_id=$1) profiles,
         (SELECT count(*)::int FROM finnor_os.tenant_integrations WHERE tenant_id=$1 AND binding='microsoft_graph') integrations,
         (SELECT count(*)::int FROM finnor_os.application_consent_requests WHERE tenant_id=$1 AND consumed_at IS NULL) open_requests,
         (SELECT count(*)::int FROM finnor_os.application_consent_requests WHERE tenant_id=$1 AND status='expired') expired_requests,
         (SELECT count(*)::int FROM finnor_os.application_consent_requests WHERE tenant_id=$1 AND state_hash=$2) raw_state_count,
         (SELECT count(*)::int FROM finnor_os.application_consent_requests WHERE tenant_id=$1 AND state_hash=$3) hashed_state_count,
         (SELECT count(*)::int FROM finnor_os.auth_profiles WHERE tenant_id=$1 AND credential_ref IS NOT NULL) credential_ref_count`,
      [project.tenantId, secondState, createHash("sha256").update(secondState).digest("hex")],
    );
    expect(persisted.rows[0]).toEqual({
      accounts: 1,
      profiles: 1,
      integrations: 3,
      open_requests: 1,
      expired_requests: 1,
      raw_state_count: 0,
      hashed_state_count: 1,
      credential_ref_count: 0,
    });

    await expect(completeMicrosoftGraphAdminConsent({
      state: firstState,
      returnedDirectoryTenantId: project.directoryTenantId,
      adminConsent: true,
    })).rejects.toMatchObject({ code: "invalid_state", status: 409 });

    const rawToken = useToken(project, ["Mail.Read", "Calendars.Read"]);
    const completed = await completeMicrosoftGraphAdminConsent({
      state: secondState,
      returnedDirectoryTenantId: project.directoryTenantId,
      adminConsent: true,
    });
    expect(completed).toMatchObject({
      tenantId: project.tenantId,
      authProfileRef: second.authProfileRef,
      status: "active",
      requestedPermissions: ["Calendars.Read", "Mail.Read"],
      effectivePermissions: ["Calendars.Read", "Mail.Read"],
      verifiedSourceScopes: 0,
      failedSourceScopes: 0,
    });
    await expect(completeMicrosoftGraphAdminConsent({
      state: secondState,
      returnedDirectoryTenantId: project.directoryTenantId,
      adminConsent: true,
    })).rejects.toMatchObject({ code: "invalid_state", status: 409 });

    const after = await getMicrosoftGraphConnectionStatus({ tenantId: project.tenantId, authProfileRef: second.authProfileRef });
    expect(after.summary).toMatchObject({ total: 1, active: 1, blocked: 0 });
    expect(after.connections[0]).toMatchObject({
      status: "active",
      usable: true,
      effectivePermissions: ["Calendars.Read", "Mail.Read"],
      lastVerifiedAt: expect.any(String),
      consent: { status: "verified", returnedDirectoryTenantId: project.directoryTenantId },
    });
    expect(JSON.stringify(after)).not.toContain(rawToken);
  });

  it("requires consequential authority, certifies exact scoped access, records the baseline, and disables without deleting truth", async () => {
    const project = await createProject("scope");
    await connect(project, ["Mail.Read"]);
    const graph = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(init?.method ?? "GET").toBe("GET");
      if (url.includes("mailbox-outside")) {
        return Response.json({ error: { code: "ErrorAccessDenied", message: "Denied by application RBAC" } }, { status: 403 });
      }
      return Response.json({ id: "inbox", parentFolderId: "root" });
    });
    vi.stubGlobal("fetch", graph);

    const configured = await configureMicrosoft365Source({
      tenantId: project.tenantId,
      actorId: project.ownerId,
      sourceKind: "outlook_mail_folder",
      permissionMode: "SCOPED",
      configuration: { mailboxId: "mailbox-allowed", folderId: "inbox" },
      negativeProbeConfiguration: { mailboxId: "mailbox-outside", folderId: "inbox" },
      freshnessPolicy: { maxAgeSeconds: 300, criticality: "consequential", staleBehavior: "refresh_then_block" },
      traceId: randomUUID(),
    });
    expect(configured).toMatchObject({
      sourceKind: "outlook_mail_folder",
      status: "initializing",
      coverageRevision: 1,
      subscriptionRequired: true,
      permissionVerification: {
        effectiveAccessVerified: true,
        leastPrivilegeCertified: true,
        positiveProbe: { passed: true },
        negativeProbe: { denied: true, status: 403 },
      },
    });
    expect(graph).toHaveBeenCalledTimes(2);

    const [scope] = await withTenant(project.tenantId, (db) => db.select().from(integrationSourceScopes)
      .where(eq(integrationSourceScopes.id, configured.sourceScopeId)));
    expect(scope).toMatchObject({
      provider: "microsoft_graph",
      sourceKind: "outlook_mail_folder",
      enabled: true,
      permissionMode: "SCOPED",
      requiredPermissions: ["Mail.Read"],
      effectivePermissions: ["Mail.Read"],
      providerRestrictionMethod: "Exchange Online Application RBAC",
      configuredBy: project.ownerId,
      freshnessPolicy: { maxAgeSeconds: 300, criticality: "consequential", staleBehavior: "refresh_then_block" },
    });
    expect(scope?.permissionVerifiedAt).toBeInstanceOf(Date);
    expect(scope?.metadata).toMatchObject({
      lastConfigurationAudit: { action: "activated", actorId: project.ownerId, authorityDecisionId: expect.any(String), at: expect.any(String) },
      permissionCertification: { result: { effectiveAccessVerified: true, leastPrivilegeCertified: true } },
    });

    const queued = await withTenant(project.tenantId, (db) => db.select().from(jobs));
    expect(queued.some((job) => job.type === "maintain_integration_subscriptions"
      && (job.payload as Record<string, unknown>).sourceScopeId === configured.sourceScopeId)).toBe(true);

    const status = await getMicrosoft365SourceScopeStatus({ tenantId: project.tenantId, sourceScopeId: configured.sourceScopeId });
    expect(status).toMatchObject({
      sourceScopeId: configured.sourceScopeId,
      freshness: { state: "unknown", policy: { criticality: "consequential", staleBehavior: "refresh_then_block" } },
      coverage: { revision: 1, state: "INITIALIZING", baselineStartedAt: expect.any(String) },
      permission: { mode: "SCOPED", verifiedAt: expect.any(String) },
    });
    const read = await readMicrosoft365Coverage({ tenantId: project.tenantId, sourceScopeId: configured.sourceScopeId });
    expect(read).toMatchObject({
      coverageWarnings: ["outlook_mail_folder:INITIALIZING"],
      unresolvedProviderObservations: 0,
      ambiguousProviderObservations: 0,
      sourceCoverage: [expect.objectContaining({ sourceScopeId: configured.sourceScopeId })],
    });
    const beforeDisableAt = read.asOf;
    const listed = await listMicrosoft365SourceScopes({ tenantId: project.tenantId });
    expect(listed.sourceScopes).toHaveLength(1);

    const disabled = await disableMicrosoft365Source({
      tenantId: project.tenantId,
      actorId: project.ownerId,
      sourceScopeId: configured.sourceScopeId,
      traceId: randomUUID(),
    });
    expect(disabled).toMatchObject({ status: "disabled", coverageRevision: 2, retainedHistory: true });
    const [retainedScope, coverageRows, events] = await withTenant(project.tenantId, async (db) => {
      const [current] = await db.select().from(integrationSourceScopes).where(eq(integrationSourceScopes.id, configured.sourceScopeId));
      const history = await db.select().from(integrationSourceCoverageHistory)
        .where(eq(integrationSourceCoverageHistory.sourceScopeId, configured.sourceScopeId))
        .orderBy(asc(integrationSourceCoverageHistory.coverageRevision));
      const audit = await db.select().from(connectionEvents).where(eq(connectionEvents.tenantId, project.tenantId));
      return [current, history, audit] as const;
    });
    expect(retainedScope).toMatchObject({ enabled: false, effectivePermissions: [], permissionVerifiedAt: null, disabledAt: expect.any(Date) });
    expect(coverageRows.map((row) => row.state)).toEqual(["INITIALIZING", "DISABLED"]);
    expect(events.some((event) => event.eventType === "disabled"
      && (event.metadata as Record<string, unknown>).sourceScopeId === configured.sourceScopeId)).toBe(true);
    expect((await listMicrosoft365SourceScopes({ tenantId: project.tenantId })).sourceScopes).toHaveLength(0);
    expect((await listMicrosoft365SourceScopes({ tenantId: project.tenantId, includeDisabled: true })).sourceScopes).toHaveLength(1);

    const historical = await readMicrosoft365Coverage({
      tenantId: project.tenantId,
      sourceScopeId: configured.sourceScopeId,
      at: beforeDisableAt,
    });
    expect(historical).toMatchObject({
      asOf: beforeDisableAt,
      coverageWarnings: ["outlook_mail_folder:INITIALIZING"],
      sourceCoverage: [expect.objectContaining({
        sourceScopeId: configured.sourceScopeId,
        enabled: true,
        disabledAt: null,
        descriptorAvailable: true,
        historicalProjection: true,
        permission: expect.objectContaining({ mode: "SCOPED", effective: ["Mail.Read"] }),
        coverage: expect.objectContaining({ revision: 1, state: "INITIALIZING" }),
        subscription: expect.objectContaining({ status: "NOT_HISTORICALLY_PROJECTED" }),
        integrationHealth: expect.objectContaining({ health: "NOT_HISTORICALLY_PROJECTED" }),
      })],
    });
    expect(Object.values(historical.integrationHealth)).toEqual([
      expect.objectContaining({ health: "NOT_HISTORICALLY_PROJECTED" }),
    ]);
  });

  it("fails closed on broad access without acknowledgement, false scoped isolation, wrong directories, and ordinary employees", async () => {
    const project = await createProject("negative");
    await connect(project, ["Mail.Read"]);
    await expect(configureMicrosoft365Source({
      tenantId: project.tenantId,
      actorId: project.ownerId,
      sourceKind: "outlook_mail_folder",
      permissionMode: "BROAD",
      configuration: { mailboxId: "mailbox", folderId: "inbox" },
    })).rejects.toMatchObject({ code: "broad_access_unacknowledged", status: 409 });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "readable" })));
    const blocked = await configureMicrosoft365Source({
      tenantId: project.tenantId,
      actorId: project.ownerId,
      sourceKind: "outlook_mail_folder",
      permissionMode: "SCOPED",
      configuration: { mailboxId: "mailbox", folderId: "inbox" },
      negativeProbeConfiguration: { mailboxId: "mailbox-that-should-be-denied", folderId: "inbox" },
    });
    expect(blocked).toMatchObject({
      status: "blocked_permission",
      permissionVerification: { effectiveAccessVerified: false, leastPrivilegeCertified: false, negativeProbe: { denied: false } },
    });
    const [blockedScope, blockedCoverage] = await withTenant(project.tenantId, async (db) => {
      const [current] = await db.select().from(integrationSourceScopes).where(eq(integrationSourceScopes.id, blocked.sourceScopeId));
      const [coverage] = await db.select().from(integrationSourceCoverageHistory)
        .where(eq(integrationSourceCoverageHistory.sourceScopeId, blocked.sourceScopeId));
      return [current, coverage] as const;
    });
    expect(blockedScope).toMatchObject({ permissionVerifiedAt: null, effectivePermissions: [] });
    expect(blockedCoverage?.state).toBe("BLOCKED_PERMISSION");

    const wrongDirectory = await createProject("wrong-directory");
    const pending = await begin(wrongDirectory);
    await expect(completeMicrosoftGraphAdminConsent({
      state: stateFrom(pending),
      returnedDirectoryTenantId: randomUUID(),
      adminConsent: true,
    })).rejects.toMatchObject({ code: "directory_mismatch", status: 409 });
    const wrongStatus = await getMicrosoftGraphConnectionStatus({ tenantId: wrongDirectory.tenantId });
    expect(wrongStatus.connections[0]).toMatchObject({ usable: false });
    expect(["degraded", "reauth_required"]).toContain(wrongStatus.connections[0]?.status);

    const excessivePermission = await createProject("excessive-role");
    const excessivePending = await begin(excessivePermission);
    useToken(excessivePermission, ["Mail.Read", "Mail.ReadWrite"]);
    await expect(completeMicrosoftGraphAdminConsent({
      state: stateFrom(excessivePending),
      returnedDirectoryTenantId: excessivePermission.directoryTenantId,
      adminConsent: true,
    })).rejects.toMatchObject({ code: "graph_permission", status: 403 });
    const excessiveStatus = await getMicrosoftGraphConnectionStatus({ tenantId: excessivePermission.tenantId });
    expect(excessiveStatus.connections[0]).toMatchObject({
      usable: false,
      status: "degraded",
      effectivePermissions: [],
      lastErrorCode: "graph_permission",
    });

    const unauthorized = await createProject("ordinary-employee");
    await expect(begin(unauthorized, unauthorized.employeeId)).rejects.toBeInstanceOf(Microsoft365AdministrationError);
    await expect(begin(unauthorized, unauthorized.employeeId)).rejects.toMatchObject({ status: 403 });
    const count = await admin.query<{ count: number }>(
      "SELECT count(*)::int count FROM finnor_os.application_accounts WHERE tenant_id=$1",
      [unauthorized.tenantId],
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it("reports the tenant transcript-policy denial as an explicit blocked configuration", async () => {
    const project = await createProject("transcript-disabled");
    await connect(project, ["OnlineMeetingTranscript.Read.All", "OnlineMeetings.Read.All"]);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: {
        code: "Forbidden",
        message: "Graph access to transcripts is disabled for this tenant",
        innerError: { code: "GraphAccessToTranscriptsDisabled" },
      },
    }, { status: 403 })));

    await expect(configureMicrosoft365Source({
      tenantId: project.tenantId,
      actorId: project.ownerId,
      sourceKind: "teams_transcript_organizer",
      permissionMode: "BROAD",
      acknowledgeBroadAccess: true,
      configuration: {
        organizerUserId: project.ownerId,
        startDateTime: "2026-09-01T00:00:00.000Z",
      },
    })).rejects.toMatchObject({
      code: "transcript_api_disabled",
      status: 409,
      message: "Microsoft tenant transcript API access is disabled",
    });

    const stored = await admin.query<{ count: number }>(
      "SELECT count(*)::int count FROM finnor_os.integration_source_scopes WHERE tenant_id=$1",
      [project.tenantId],
    );
    expect(stored.rows[0]?.count).toBe(0);
  });
});

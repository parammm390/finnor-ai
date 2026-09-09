import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAuthContext } from "@finnor/security";
import {
  clearMicrosoftGraphTokenCache,
  inspectMicrosoftGraphAppOnlyToken,
  probeMicrosoft365SourceAccess,
  setMicrosoftIdentityTestOverrides,
  type Microsoft365SourceScope,
  type MicrosoftGraphAppTokenInspection,
} from "@finnor/provider-microsoft365";

const TENANT_ID = "00000000-0000-4000-8000-000000000101";
const INTEGRATION_ID = "00000000-0000-4000-8000-000000000102";
const PROFILE_ID = "00000000-0000-4000-8000-000000000103";
const DIRECTORY_ID = "00000000-0000-4000-8000-000000000104";
const CLIENT_ID = "00000000-0000-4000-8000-000000000105";

function jwt(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "test-signature",
  ].join(".");
}

function auth(overrides: Partial<Extract<ProviderAuthContext, { kind: "federated_workload" }>> = {}): Extract<ProviderAuthContext, { kind: "federated_workload" }> {
  return {
    kind: "federated_workload",
    tenantId: TENANT_ID,
    integrationId: INTEGRATION_ID,
    provider: "microsoft_graph",
    authProfileId: PROFILE_ID,
    authProfileRef: "microsoft-probe-test",
    connectionRevision: 1,
    directoryTenantId: DIRECTORY_ID,
    applicationClientId: CLIENT_ID,
    cloud: "global",
    requiredPermissions: ["Mail.Read"],
    consentedPermissions: ["Mail.Read"],
    cacheKey: `${TENANT_ID}:${PROFILE_ID}:1`,
    awsRegion: "us-east-1",
    federationAudience: "api://AzureADTokenExchange",
    federationConfigId: "microsoft-probe-test",
    signingAlgorithm: "RS256",
    identityTokenDurationSeconds: 300,
    ...overrides,
  };
}

function inspection(roles: string[]): MicrosoftGraphAppTokenInspection {
  return {
    tokenType: "application",
    directoryTenantId: DIRECTORY_ID,
    applicationClientId: CLIENT_ID,
    servicePrincipalObjectId: "00000000-0000-4000-8000-000000000106",
    roles,
    expiresAt: "2026-09-08T12:00:00.000Z",
  };
}

function scope(
  sourceKind: Microsoft365SourceScope["sourceKind"],
  permissionMode: Microsoft365SourceScope["permissionMode"],
  configuration: Record<string, unknown>,
): Microsoft365SourceScope {
  return {
    id: "00000000-0000-4000-8000-000000000107",
    tenantId: TENANT_ID,
    integrationId: INTEGRATION_ID,
    provider: "microsoft_graph",
    sourceKind,
    scopeKey: `${sourceKind}:probe`,
    providerResourceId: "resource",
    providerParentId: null,
    permissionMode,
    coveragePolicy: {},
    freshnessPolicy: {},
    configuration,
  };
}

function tokenResponse(token: string): Response {
  return Response.json({ access_token: token, token_type: "Bearer", expires_in: 3_600 });
}

describe("Microsoft 365 effective-access certification", () => {
  beforeEach(() => {
    clearMicrosoftGraphTokenCache();
    setMicrosoftIdentityTestOverrides({
      stsSender: async () => "aws-outbound-identity-token",
      fetch: async () => tokenResponse("graph-access-token"),
    });
  });

  afterEach(() => {
    clearMicrosoftGraphTokenCache();
    setMicrosoftIdentityTestOverrides({ stsSender: null, fetch: null });
    vi.restoreAllMocks();
  });

  it("accepts only a tenant/application-bound Graph app token and returns no bearer material", async () => {
    const token = jwt({
      tid: DIRECTORY_ID,
      azp: CLIENT_ID,
      aud: "https://graph.microsoft.com/",
      oid: "00000000-0000-4000-8000-000000000106",
      roles: ["Mail.Read", "Calendars.Read", "Mail.Read"],
      exp: 1_900_000_000,
    });
    setMicrosoftIdentityTestOverrides({
      stsSender: async () => "aws-outbound-identity-token",
      fetch: async () => tokenResponse(token),
    });
    const result = await inspectMicrosoftGraphAppOnlyToken(auth());
    expect(result).toEqual({
      tokenType: "application",
      directoryTenantId: DIRECTORY_ID,
      applicationClientId: CLIENT_ID,
      servicePrincipalObjectId: "00000000-0000-4000-8000-000000000106",
      roles: ["Calendars.Read", "Mail.Read"],
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain(token);

    clearMicrosoftGraphTokenCache();
    setMicrosoftIdentityTestOverrides({
      stsSender: async () => "aws-outbound-identity-token",
      fetch: async () => tokenResponse(jwt({ tid: DIRECTORY_ID, azp: CLIENT_ID, aud: "https://graph.microsoft.com", scp: "Mail.Read", roles: ["Mail.Read"] })),
    });
    await expect(inspectMicrosoftGraphAppOnlyToken(auth())).rejects.toThrow(/delegated/i);

    clearMicrosoftGraphTokenCache();
    setMicrosoftIdentityTestOverrides({
      stsSender: async () => "aws-outbound-identity-token",
      fetch: async () => tokenResponse(jwt({ tid: "00000000-0000-4000-8000-000000000999", azp: CLIENT_ID, aud: "https://graph.microsoft.com", roles: ["Mail.Read"] })),
    });
    await expect(inspectMicrosoftGraphAppOnlyToken(auth())).rejects.toThrow(/different directory/i);
  });

  it("certifies scoped access only when the exact resource succeeds and a known non-covered resource returns 403", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const graph = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url });
      if (url.includes("mailbox-denied")) {
        return Response.json({ error: { code: "ErrorAccessDenied", message: "Denied" } }, { status: 403 });
      }
      return Response.json({ id: "folder-allowed", parentFolderId: "root" });
    });
    const result = await probeMicrosoft365SourceAccess({
      auth: auth(),
      scope: scope("outlook_mail_folder", "SCOPED", { mailboxId: "mailbox-allowed", folderId: "inbox" }),
      tokenInspection: inspection(["Mail.Read"]),
      negativeProbeConfiguration: { mailboxId: "mailbox-denied", folderId: "inbox" },
      fetch: graph as typeof fetch,
    });
    expect(result).toMatchObject({
      effectiveAccessVerified: true,
      leastPrivilegeCertified: true,
      providerRestrictionMethod: "Exchange Online Application RBAC",
      positiveProbe: { passed: true, status: 200 },
      negativeProbe: { configured: true, denied: true, status: 403, conclusive: true },
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls[0]?.url).toContain("/users/mailbox-allowed/mailFolders/inbox");
  });

  it("refuses least-privilege claims for readable or inconclusive negative resources", async () => {
    const readable = await probeMicrosoft365SourceAccess({
      auth: auth(),
      scope: scope("outlook_mail_folder", "SCOPED", { mailboxId: "allowed", folderId: "inbox" }),
      tokenInspection: inspection(["Mail.Read"]),
      negativeProbeConfiguration: { mailboxId: "also-readable", folderId: "inbox" },
      fetch: async () => Response.json({ id: "readable" }),
    });
    expect(readable).toMatchObject({
      effectiveAccessVerified: false,
      leastPrivilegeCertified: false,
      negativeProbe: { denied: false, conclusive: true, reason: "non_covered_resource_was_readable" },
    });

    let calls = 0;
    const missing = await probeMicrosoft365SourceAccess({
      auth: auth(),
      scope: scope("outlook_mail_folder", "SCOPED", { mailboxId: "allowed", folderId: "inbox" }),
      tokenInspection: inspection(["Mail.Read"]),
      negativeProbeConfiguration: { mailboxId: "unknown", folderId: "inbox" },
      fetch: async () => ++calls === 1
        ? Response.json({ id: "readable" })
        : Response.json({ error: { code: "ErrorItemNotFound", message: "Missing" } }, { status: 404 }),
    });
    expect(missing).toMatchObject({
      effectiveAccessVerified: false,
      leastPrivilegeCertified: false,
      negativeProbe: { denied: false, status: 404, conclusive: false },
    });
  });

  it("records the real tenant blast radius for broad access and never issues a write probe", async () => {
    const graph = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      return Response.json({ value: [] });
    });
    const result = await probeMicrosoft365SourceAccess({
      auth: auth({ requiredPermissions: ["Chat.Read.All"], consentedPermissions: ["Chat.Read.All"] }),
      scope: scope("teams_user_chat_feed", "BROAD", { userId: "configured-user" }),
      tokenInspection: inspection(["Chat.Read.All"]),
      fetch: graph as typeof fetch,
    });
    expect(result).toMatchObject({
      effectiveAccessVerified: true,
      leastPrivilegeCertified: false,
      providerRestrictionMethod: expect.stringMatching(/application-wide/i),
      negativeProbe: { configured: false, conclusive: true, reason: "broad_application_permission_has_tenant_blast_radius" },
    });
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["outlook_mail_folder", ["Mail.Read"], { mailboxId: "mailbox", folderId: "folder" }, "/users/mailbox/mailFolders/folder"],
    ["outlook_calendar_view", ["Calendars.Read"], { mailboxId: "mailbox", calendarId: "calendar", windowStart: "2026-09-01T00:00:00Z", windowEnd: "2026-10-01T00:00:00Z" }, "/users/mailbox/calendars/calendar"],
    ["teams_channel", ["ChannelMessage.Read.All"], { teamId: "team", channelId: "channel" }, "/teams/team/channels/channel/messages"],
    ["teams_chat", ["Chat.Read.All"], { chatId: "chat" }, "/chats/chat/messages"],
    ["teams_user_chat_feed", ["Chat.Read.All"], { userId: "user" }, "/users/user/chats/getAllMessages"],
    ["teams_transcript_organizer", ["OnlineMeetingTranscript.Read.All", "OnlineMeetings.Read.All"], { organizerUserId: "organizer", startDateTime: "2026-09-01T00:00:00Z" }, "/users/organizer/onlineMeetings/getAllTranscripts"],
    ["sharepoint_drive", ["Files.Read.All", "Sites.Read.All"], { siteId: "site", driveId: "drive" }, "/drives/drive/root"],
    ["sharepoint_list", ["Sites.Read.All"], { siteId: "site", listId: "list" }, "/sites/site/lists/list"],
  ] as const)("probes %s through its exact read-only resource path", async (sourceKind, roles, configuration, expectedPath) => {
    const requests: Array<{ url: string; method: string }> = [];
    const graph = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method ?? "GET" });
      return Response.json({ value: [] });
    });
    const result = await probeMicrosoft365SourceAccess({
      auth: auth({ requiredPermissions: [...roles], consentedPermissions: [...roles] }),
      scope: scope(sourceKind, "BROAD", configuration),
      tokenInspection: inspection([...roles]),
      fetch: graph as typeof fetch,
    });
    expect(result.effectiveAccessVerified).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url).toContain(expectedPath);
    if (sourceKind === "teams_transcript_organizer") {
      expect(requests[0]?.url).toContain("/delta?");
    }
  });

  it.each([
    {
      label: "SharePoint list Selected",
      sourceKind: "sharepoint_list" as const,
      roles: ["Lists.SelectedOperations.Selected"],
      configuration: { siteId: "site-allowed", listId: "list" },
      deniedConfiguration: { siteId: "site-denied", listId: "list" },
      restriction: /Selected permission/i,
    },
    {
      label: "organizer application-access policy",
      sourceKind: "teams_transcript_organizer" as const,
      roles: ["OnlineMeetingTranscript.Read.All", "OnlineMeetings.Read.All"],
      configuration: { organizerUserId: "organizer-allowed", startDateTime: "2026-09-01T00:00:00Z" },
      deniedConfiguration: { organizerUserId: "organizer-denied", startDateTime: "2026-09-01T00:00:00Z" },
      restriction: /application access policy/i,
    },
    {
      label: "Teams channel RSC",
      sourceKind: "teams_channel" as const,
      roles: ["ChannelMessage.Read.Group"],
      configuration: { teamId: "team-allowed", channelId: "channel" },
      deniedConfiguration: { teamId: "team-denied", channelId: "channel" },
      restriction: /resource-specific consent/i,
    },
    {
      label: "Teams chat RSC",
      sourceKind: "teams_chat" as const,
      roles: ["ChatMessage.Read.Chat"],
      configuration: { chatId: "chat-allowed" },
      deniedConfiguration: { chatId: "chat-denied" },
      restriction: /resource-specific consent/i,
    },
  ])("certifies $label only with an exact 403 negative probe", async ({ sourceKind, roles, configuration, deniedConfiguration, restriction }) => {
    const requests: string[] = [];
    const result = await probeMicrosoft365SourceAccess({
      auth: auth({ requiredPermissions: roles, consentedPermissions: roles }),
      scope: scope(sourceKind, "SCOPED", configuration),
      tokenInspection: inspection(roles),
      negativeProbeConfiguration: deniedConfiguration,
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        return url.includes("denied")
          ? Response.json({ error: { code: "ErrorAccessDenied", message: "Denied" } }, { status: 403 })
          : Response.json({ value: [] });
      },
    });
    expect(result).toMatchObject({
      effectiveAccessVerified: true,
      leastPrivilegeCertified: true,
      providerRestrictionMethod: expect.stringMatching(restriction),
      positiveProbe: { passed: true, status: 200 },
      negativeProbe: { configured: true, denied: true, status: 403, conclusive: true },
    });
    expect(requests).toHaveLength(2);
  });
});

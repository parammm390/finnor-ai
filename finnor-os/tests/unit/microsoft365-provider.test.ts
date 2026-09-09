import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAuthContext } from "@finnor/security";
import {
  Microsoft365ObservationAdapter,
  Microsoft365SubscriptionTransport,
  MicrosoftGraphClient,
  MicrosoftGraphError,
  allMicrosoft365SourceCapabilities,
  boundedSubscriptionExpiration,
  clearMicrosoftGraphTokenCache,
  generateSubscriptionClientState,
  hashSubscriptionClientState,
  normalizeDriveItem,
  normalizeListItem,
  normalizeOutlookMessage,
  normalizeOutlookEvent,
  normalizeTeamsMessage,
  normalizeTranscript,
  microsoftTeamsMeetingJoinIdentity,
  setMicrosoftIdentityTestOverrides,
  subscriptionRenewAt,
  verifySubscriptionClientState,
  acquireMicrosoftGraphAccessToken,
  type Microsoft365SourceScope,
} from "@finnor/provider-microsoft365";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const INTEGRATION_A = "00000000-0000-4000-8000-000000000011";
const SCOPE_A = "00000000-0000-4000-8000-000000000021";
const DIRECTORY_A = "00000000-0000-4000-8000-000000000031";
const CLIENT_A = "00000000-0000-4000-8000-000000000041";

function auth(overrides: Partial<Extract<ProviderAuthContext, { kind: "federated_workload" }>> = {}): Extract<ProviderAuthContext, { kind: "federated_workload" }> {
  return {
    kind: "federated_workload",
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    provider: "microsoft_graph",
    authProfileId: "00000000-0000-4000-8000-000000000051",
    authProfileRef: "m365-a",
    connectionRevision: 1,
    directoryTenantId: DIRECTORY_A,
    applicationClientId: CLIENT_A,
    cloud: "global",
    requiredPermissions: ["Mail.Read"],
    consentedPermissions: ["Mail.Read"],
    cacheKey: "tenant-a:profile-a:1",
    awsRegion: "us-east-1",
    federationAudience: "api://AzureADTokenExchange",
    federationConfigId: "aws-prod",
    signingAlgorithm: "RS256",
    identityTokenDurationSeconds: 300,
    ...overrides,
  };
}

function scope(sourceKind: Microsoft365SourceScope["sourceKind"], configuration: Record<string, unknown>, overrides: Partial<Microsoft365SourceScope> = {}): Microsoft365SourceScope {
  return {
    id: SCOPE_A,
    tenantId: TENANT_A,
    integrationId: INTEGRATION_A,
    provider: "microsoft_graph",
    sourceKind,
    scopeKey: `${sourceKind}:test`,
    providerResourceId: "configured-resource",
    permissionMode: "SCOPED",
    coveragePolicy: {},
    freshnessPolicy: {},
    configuration,
    ...overrides,
  };
}

function tokenResponse(token: string, expiresIn = 3_600): Response {
  return Response.json({ access_token: token, token_type: "Bearer", expires_in: expiresIn });
}

describe("Microsoft 365 provider authentication boundary", () => {
  beforeEach(() => {
    clearMicrosoftGraphTokenCache();
    setMicrosoftIdentityTestOverrides({ stsSender: null, fetch: null });
  });

  afterEach(() => {
    clearMicrosoftGraphTokenCache();
    setMicrosoftIdentityTestOverrides({ stsSender: null, fetch: null });
    vi.restoreAllMocks();
  });

  it("caches ephemeral tokens by tenant-bound revision and isolates two tenants", async () => {
    const sts = vi.fn(async (context: Extract<ProviderAuthContext, { kind: "federated_workload" }>) => `assertion:${context.tenantId}`);
    const exchange = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const assertion = new URLSearchParams(String(init?.body)).get("client_assertion")!;
      return tokenResponse(`token:${assertion}`);
    });
    setMicrosoftIdentityTestOverrides({ stsSender: sts, fetch: exchange as typeof fetch });
    const first = auth();
    const second = auth({
      tenantId: TENANT_B,
      integrationId: "00000000-0000-4000-8000-000000000012",
      authProfileId: "00000000-0000-4000-8000-000000000052",
      directoryTenantId: "00000000-0000-4000-8000-000000000032",
      cacheKey: "tenant-b:profile-b:1",
    });

    expect((await acquireMicrosoftGraphAccessToken(first)).accessToken).toContain(TENANT_A);
    expect((await acquireMicrosoftGraphAccessToken(first)).accessToken).toContain(TENANT_A);
    expect((await acquireMicrosoftGraphAccessToken(second)).accessToken).toContain(TENANT_B);
    expect(sts).toHaveBeenCalledTimes(2);
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it("refreshes a token whose safety-margin lifetime is already exhausted", async () => {
    const sts = vi.fn(async () => "assertion");
    const exchange = vi.fn(async () => tokenResponse(`token-${exchange.mock.calls.length}`, 1));
    setMicrosoftIdentityTestOverrides({ stsSender: sts, fetch: exchange as typeof fetch });
    const first = await acquireMicrosoftGraphAccessToken(auth());
    const second = await acquireMicrosoftGraphAccessToken(auth());
    expect(first.accessToken).not.toEqual(second.accessToken);
    expect(sts).toHaveBeenCalledTimes(2);
  });

  it("supports only the deliberate X.509 fallback contract and never needs a client secret", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const exchange = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("client_secret")).toBeNull();
      expect(form.get("client_assertion")?.split(".")).toHaveLength(3);
      return tokenResponse("certificate-token");
    });
    setMicrosoftIdentityTestOverrides({ fetch: exchange as typeof fetch });
    const {
      kind: _kind,
      awsRegion: _awsRegion,
      federationAudience: _federationAudience,
      federationConfigId: _federationConfigId,
      signingAlgorithm: _signingAlgorithm,
      identityTokenDurationSeconds: _identityTokenDurationSeconds,
      ...base
    } = auth();
    const certificateContext: Extract<ProviderAuthContext, { kind: "managed_certificate" }> = {
      ...base,
      kind: "managed_certificate",
      certificatePem: "not-read-when-thumbprint-is-explicit",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      certificateThumbprint: "11".repeat(20),
    };
    expect((await acquireMicrosoftGraphAccessToken(certificateContext)).accessToken).toBe("certificate-token");
  });

  it("rejects opaque cursor SSRF before any Graph call", async () => {
    const graphFetch = vi.fn();
    setMicrosoftIdentityTestOverrides({ stsSender: async () => "assertion", fetch: async () => tokenResponse("token") });
    const client = new MicrosoftGraphClient(auth(), { fetch: graphFetch as typeof fetch });
    await expect(client.requestJson({ operation: "test", pathOrUrl: "https://example.test/v1.0/users" })).rejects.toThrow(/outside the allowed host/i);
    expect(graphFetch).not.toHaveBeenCalled();
  });
});

describe("Microsoft 365 observation adapter", () => {
  beforeEach(() => {
    clearMicrosoftGraphTokenCache();
    setMicrosoftIdentityTestOverrides({ stsSender: async () => "assertion", fetch: async () => tokenResponse("graph-token") });
  });

  afterEach(() => {
    clearMicrosoftGraphTokenCache();
    setMicrosoftIdentityTestOverrides({ stsSender: null, fetch: null });
  });

  it("performs folder-scoped baseline delta, stores terminal cursor, then forces immediate catch-up", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const graphFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.includes("initial-terminal")) {
        return Response.json({
          value: [{
            id: "immutable-message-1",
            subject: "Lender update",
            body: { contentType: "html", content: "<script>ignore()</script><b>Ready</b>" },
            lastModifiedDateTime: "2026-09-08T08:00:00Z",
            changeKey: "CQAAABYAA",
            hasAttachments: false,
          }],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/mailbox-a/mailFolders/folder-a/messages/delta?$deltatoken=next-terminal",
        });
      }
      return Response.json({
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/mailbox-a/mailFolders/folder-a/messages/delta?$deltatoken=initial-terminal",
      });
    });
    const adapter = new Microsoft365ObservationAdapter(auth(), { fetch: graphFetch as typeof fetch });
    const sourceScope = scope("outlook_mail_folder", { mailboxId: "mailbox-a", folderId: "folder-a" });
    const baseline = await adapter.readPage(sourceScope, { version: 1 }, { traceId: "trace-baseline" });
    expect(baseline).toMatchObject({ hasMore: true, nextCursor: { phase: "catchup" }, coverage: { state: "INITIALIZING" } });
    expect(baseline.nextCursor.token).toContain("initial-terminal");
    const catchup = await adapter.readPage(sourceScope, baseline.nextCursor, { traceId: "trace-catchup" });
    expect(catchup).toMatchObject({ hasMore: false, nextCursor: { phase: "incremental" }, coverage: { state: "COMPLETE" } });
    expect(catchup.nextCursor.token).toContain("next-terminal");
    expect(catchup.observations).toHaveLength(1);
    expect(catchup.observations[0]).toMatchObject({
      providerSequence: null,
      providerVersion: "CQAAABYAA",
      externalObjectId: "mailbox-a/immutable-message-1",
      payload: { body: { normalizedText: "Ready", contentUntrusted: true } },
    });
    expect(catchup.observations[0]?.retrievedAt).toEqual(catchup.observations[0]?.retrievedAt);
    expect(calls.every((call) => call.headers.get("Prefer") === 'IdType="ImmutableId"')).toBe(true);
  });

  it.each([
    {
      sourceKind: "outlook_calendar_view" as const,
      permissions: ["Calendars.Read"],
      configuration: { mailboxId: "mailbox-a", calendarId: "calendar-a", windowStart: "2026-01-01T00:00:00Z", windowEnd: "2027-01-01T00:00:00Z" },
      value: [{ id: "event-a", changeKey: "event-v1", subject: "Board update", lastModifiedDateTime: "2026-09-01T00:00:00Z" }],
      deltaLink: "https://graph.microsoft.com/v1.0/users/mailbox-a/calendars/calendar-a/calendarView/delta?$deltatoken=calendar",
      expectedObjectId: "mailbox-a/event-a",
      expectedState: "INITIALIZING",
    },
    {
      sourceKind: "teams_channel" as const,
      permissions: ["ChannelMessage.Read.All"],
      configuration: { teamId: "team-a", channelId: "channel-a" },
      value: [{ id: "message-a", body: { contentType: "text", content: "Channel evidence" }, createdDateTime: "2026-09-01T00:00:00Z", replies: [{ id: "reply-a", body: { contentType: "text", content: "Reply evidence" }, createdDateTime: "2026-09-01T01:00:00Z" }] }],
      expectedObjectId: "team-a/channel-a/message-a",
      expectedState: "COMPLETE",
    },
    {
      sourceKind: "teams_chat" as const,
      permissions: ["Chat.Read.All"],
      configuration: { chatId: "chat-a" },
      value: [{ id: "message-a", body: { contentType: "text", content: "Chat evidence" }, createdDateTime: "2026-09-01T00:00:00Z" }],
      expectedObjectId: "chat-a/message-a",
      expectedState: "COMPLETE",
    },
    {
      sourceKind: "sharepoint_drive" as const,
      permissions: ["Files.Read.All", "Sites.Read.All"],
      configuration: { siteId: "site-a", driveId: "drive-a" },
      value: [{ id: "file-a", name: "Model.xlsx", eTag: "drive-v1", file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }, lastModifiedDateTime: "2026-09-01T00:00:00Z" }],
      deltaLink: "https://graph.microsoft.com/v1.0/drives/drive-a/root/delta?$deltatoken=drive",
      expectedObjectId: "drive-a/file-a",
      expectedState: "INITIALIZING",
    },
    {
      sourceKind: "sharepoint_list" as const,
      permissions: ["Sites.Read.All"],
      configuration: { siteId: "site-a", listId: "list-a", selectedFields: ["Status"] },
      value: [{ id: "item-a", eTag: "list-v1", fields: { Status: "Open" }, lastModifiedDateTime: "2026-09-01T00:00:00Z" }],
      deltaLink: "https://graph.microsoft.com/v1.0/sites/site-a/lists/list-a/items/delta?$deltatoken=list",
      expectedObjectId: "site-a/list-a/item-a",
      expectedState: "INITIALIZING",
    },
  ])("reads and normalizes the exact $sourceKind coverage unit", async (testCase) => {
    const graphFetch = vi.fn(async () => Response.json({
      value: testCase.value,
      ...(testCase.deltaLink ? { "@odata.deltaLink": testCase.deltaLink } : {}),
    }));
    const adapter = new Microsoft365ObservationAdapter(auth({
      requiredPermissions: testCase.permissions,
      consentedPermissions: testCase.permissions,
    }), { fetch: graphFetch as typeof fetch });
    const result = await adapter.readPage(scope(testCase.sourceKind, testCase.configuration, { permissionMode: "BROAD" }), { version: 1 }, { traceId: testCase.sourceKind });
    expect(result.coverage.state).toBe(testCase.expectedState);
    expect(result.observations.map((entry) => entry.externalObjectId)).toContain(testCase.expectedObjectId);
    expect(result.observations.every((entry) => entry.providerSequence === null && entry.provider === "microsoft_graph")).toBe(true);
  });

  it("uses organizer transcript delta and falls back only for speaker-attribution denial", async () => {
    const joinWebUrl = "https://teams.microsoft.com/l/meetup-join/exact-provider-identity";
    const graphFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/onlineMeetings/meeting-a?")) {
        return Response.json({ id: "meeting-a", joinWebUrl });
      }
      if (url.endsWith("/content")) {
        const accept = new Headers(init?.headers).get("accept") ?? "";
        if (accept.includes("text/vtt")) {
          return Response.json({ error: { code: "Forbidden", innerError: { code: "SpeakerAttributionNotAllowed" } } }, { status: 403 });
        }
        return new Response("Unattributed transcript evidence", { headers: { "content-type": "application/vnd.microsoft.graph.transcript+text" } });
      }
      return Response.json({
        value: [{ id: "transcript-a", meetingId: "meeting-a", createdDateTime: "2026-09-01T00:00:00Z" }],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/organizer-a/onlineMeetings/getAllTranscripts(meetingOrganizerUserId='organizer-a',startDateTime=2026-01-01T00:00:00.000Z)/delta?$deltatoken=transcript",
      });
    });
    const adapter = new Microsoft365ObservationAdapter(auth({
      requiredPermissions: ["OnlineMeetingTranscript.Read.All", "OnlineMeetings.Read.All"],
      consentedPermissions: ["OnlineMeetingTranscript.Read.All", "OnlineMeetings.Read.All"],
    }), { fetch: graphFetch as typeof fetch });
    const result = await adapter.readPage(scope("teams_transcript_organizer", {
      organizerUserId: "organizer-a",
      startDateTime: "2026-01-01T00:00:00Z",
    }, { permissionMode: "BROAD" }), { version: 1 }, { traceId: "transcript" });
    expect(result).toMatchObject({
      hasMore: true,
      coverage: { state: "INITIALIZING" },
      observations: [expect.objectContaining({
        externalObjectId: "organizer-a/meeting-a/transcript-a",
        payload: expect.objectContaining({ speakerAttribution: "disabled", content: "Unattributed transcript evidence" }),
        providerParentRefs: expect.arrayContaining([expect.objectContaining({
          externalObjectType: "microsoft_teams_meeting_join_identity",
          externalObjectId: microsoftTeamsMeetingJoinIdentity(joinWebUrl),
          relationship: "meeting",
        })]),
      })],
    });
    expect(graphFetch).toHaveBeenCalledTimes(4);
  });

  it("restarts an expanded calendar window as uncovered and completes only after its immediate catch-up", async () => {
    const calls: string[] = [];
    const graphFetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("expanded-baseline")) {
        return Response.json({
          value: [],
          "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/mailbox-a/calendars/calendar-a/calendarView/delta?$deltatoken=expanded-complete",
        });
      }
      return Response.json({
        value: [],
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/mailbox-a/calendars/calendar-a/calendarView/delta?$deltatoken=expanded-baseline",
      });
    });
    const adapter = new Microsoft365ObservationAdapter(auth({
      requiredPermissions: ["Calendars.Read"],
      consentedPermissions: ["Calendars.Read"],
    }), { fetch: graphFetch as typeof fetch });
    const expanded = scope("outlook_calendar_view", {
      mailboxId: "mailbox-a",
      calendarId: "calendar-a",
      windowStart: "2025-01-01T00:00:00Z",
      windowEnd: "2028-01-01T00:00:00Z",
    });
    const priorWindowCursor = {
      version: 1 as const,
      phase: "incremental" as const,
      token: "https://graph.microsoft.com/v1.0/users/mailbox-a/calendars/calendar-a/calendarView/delta?$deltatoken=old-window",
      windowStart: "2026-01-01T00:00:00.000Z",
      windowEnd: "2027-01-01T00:00:00.000Z",
    };
    const baseline = await adapter.readPage(expanded, priorWindowCursor, { traceId: "calendar-expanded" });
    expect(calls[0]).not.toContain("old-window");
    expect(calls[0]).toContain("startDateTime=2025-01-01T00%3A00%3A00.000Z");
    expect(baseline).toMatchObject({ hasMore: true, coverage: { state: "INITIALIZING" }, nextCursor: { phase: "catchup" } });
    const complete = await adapter.readPage(expanded, baseline.nextCursor, { traceId: "calendar-expanded-catchup" });
    expect(complete).toMatchObject({ hasMore: false, coverage: { state: "COMPLETE" }, nextCursor: {
      phase: "incremental",
      windowStart: "2025-01-01T00:00:00.000Z",
      windowEnd: "2028-01-01T00:00:00.000Z",
    } });
  });

  it("retains bounded mail attachment metadata without inventing a materialized Document", () => {
    const message = normalizeOutlookMessage({
      id: "message-with-attachment",
      changeKey: "mail-v1",
      hasAttachments: true,
      body: { contentType: "text", content: "Attachment metadata only" },
      lastModifiedDateTime: "2026-09-08T10:00:00Z",
    }, scope("outlook_mail_folder", { mailboxId: "mailbox-a", folderId: "folder-a" }), {
      directoryTenantId: DIRECTORY_A,
      ingestionMode: "incremental",
      traceId: "mail-attachment",
    }, "2026-09-08T10:00:01Z", [{
      id: "attachment-a",
      name: "Model.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 1234,
      "@odata.type": "#microsoft.graph.fileAttachment",
    }], true);
    expect(message.payload).toMatchObject({
      hasAttachments: true,
      attachmentsTruncated: true,
      attachments: [expect.objectContaining({ id: "attachment-a", contentMaterialized: false })],
    });
    expect(message.providerMetadata).toMatchObject({ binaryAttachmentsMaterialized: false });
  });

  it("fails closed when a terminal cursor changes resource family", async () => {
    const graphFetch = vi.fn(async () => Response.json({
      value: [],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/other/mailFolders/folder-a/messages/delta?$deltatoken=x",
    }));
    const adapter = new Microsoft365ObservationAdapter(auth(), { fetch: graphFetch as typeof fetch });
    await expect(adapter.readPage(scope("outlook_mail_folder", { mailboxId: "mailbox-a", folderId: "folder-a" }), { version: 1 }, { traceId: "trace" }))
      .rejects.toThrow(/crossed its configured source scope/i);
  });

  it("retains a bounded untrusted Teams body without executable HTML", () => {
    const observation = normalizeTeamsMessage({
      id: "message-1",
      body: { contentType: "html", content: "<img src=x onerror=alert(1)><script>steal()</script><p>Investment update</p>" },
      createdDateTime: "2026-09-01T00:00:00Z",
    }, scope("teams_chat", { chatId: "chat-1" }, { permissionMode: "BROAD" }), {
      directoryTenantId: DIRECTORY_A,
      ingestionMode: "exact_read",
      traceId: "trace",
    }, "2026-09-08T00:00:00Z", { chatId: "chat-1" });
    expect(JSON.stringify(observation.payload)).not.toContain("onerror");
    expect(JSON.stringify(observation.payload)).not.toContain("steal()");
    expect(observation.payload).toMatchObject({ body: { normalizedText: "Investment update", contentUntrusted: true } });
  });

  it("exposes the configured user feed's rolling historical boundary", async () => {
    const broad = auth({ requiredPermissions: ["Chat.Read.All"], consentedPermissions: ["Chat.Read.All"] });
    const graphFetch = vi.fn(async () => Response.json({
      value: [],
      "@odata.deltaLink": "https://graph.microsoft.com/v1.0/users/user-a/chats/getAllMessages/delta?$deltatoken=terminal",
    }));
    const adapter = new Microsoft365ObservationAdapter(broad, { fetch: graphFetch as typeof fetch });
    const sourceScope = scope("teams_user_chat_feed", { userId: "user-a" }, { permissionMode: "BROAD" });
    const baseline = await adapter.readPage(sourceScope, { version: 1 }, { traceId: "baseline" });
    const catchup = await adapter.readPage(sourceScope, baseline.nextCursor, { traceId: "catchup" });
    expect(catchup.coverage.state).toBe("HISTORY_LIMITED");
    expect(catchup.nextCursor.historyBoundary).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("declares seven exact source families without beta or obsolete Teams billing semantics", () => {
    const capabilities = allMicrosoft365SourceCapabilities();
    expect(capabilities.map((entry) => entry.sourceKind).sort()).toEqual([
      "outlook_calendar_view",
      "outlook_mail_folder",
      "sharepoint_drive",
      "sharepoint_list",
      "teams_channel",
      "teams_chat",
      "teams_transcript_organizer",
      "teams_user_chat_feed",
    ]);
    expect(new Set(capabilities.map((entry) => entry.family))).toEqual(new Set([
      "outlook_mail",
      "outlook_calendar",
      "teams_channel",
      "teams_chat",
      "teams_transcript",
      "sharepoint_drive",
      "sharepoint_list",
    ]));
    expect(capabilities.every((entry) => entry.supportsInitialEnumeration && entry.supportsExactRead)).toBe(true);
    expect(capabilities.find((entry) => entry.sourceKind === "teams_channel")).toMatchObject({
      supportsDelta: false,
      recoveryStrength: "BOUNDED_RECONCILIATION",
    });
    expect(capabilities.find((entry) => entry.sourceKind === "teams_chat")).toMatchObject({
      supportsDelta: false,
      recoveryStrength: "BOUNDED_RECONCILIATION",
    });
    expect(capabilities.find((entry) => entry.sourceKind === "teams_user_chat_feed")).toMatchObject({
      supportsDelta: true,
      historyLimit: { kind: "rolling_months", months: 8 },
    });
    expect(capabilities.find((entry) => entry.sourceKind === "teams_transcript_organizer")).toMatchObject({
      supportsDelta: true,
      supportsChangeNotifications: false,
      permissionProfiles: {
        SCOPED: ["OnlineMeetingTranscript.Read.All", "OnlineMeetings.Read.All"],
        BROAD: ["OnlineMeetingTranscript.Read.All", "OnlineMeetings.Read.All"],
      },
    });
    expect(JSON.stringify(capabilities)).not.toMatch(/(?:\/beta|model[=:][AB]|meter(?:ed|ing))/i);
  });

  it("keeps calendar cancellation as evidence and uses only provider removal as a tombstone", () => {
    const sourceScope = scope("outlook_calendar_view", {
      mailboxId: "mailbox-a",
      calendarId: "calendar-a",
      windowStart: "2026-01-01T00:00:00Z",
      windowEnd: "2027-01-01T00:00:00Z",
    });
    const context = { directoryTenantId: DIRECTORY_A, ingestionMode: "incremental" as const, traceId: "calendar" };
    const cancelled = normalizeOutlookEvent({
      id: "event-a",
      changeKey: "v2",
      createdDateTime: "2026-09-01T00:00:00Z",
      lastModifiedDateTime: "2026-09-02T00:00:00Z",
      isCancelled: true,
      onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/exact-calendar-a" },
      body: { contentType: "text", content: "Cancelled meeting" },
    }, sourceScope, context, "2026-09-03T00:00:00Z");
    expect(cancelled).toMatchObject({ deleted: false, providerVersion: "v2", observedAt: "2026-09-02T00:00:00.000Z" });
    expect(cancelled.payload).toMatchObject({ isCancelled: true, deleted: false });
    expect(cancelled.providerParentRefs).toEqual(expect.arrayContaining([expect.objectContaining({
      externalObjectType: "microsoft_teams_meeting_join_identity",
      externalObjectId: microsoftTeamsMeetingJoinIdentity("https://teams.microsoft.com/l/meetup-join/exact-calendar-a"),
      relationship: "meeting",
    })]));

    const removed = normalizeOutlookEvent({ id: "event-a", "@removed": { reason: "deleted" } }, sourceScope, context, "2026-09-04T00:00:00Z");
    expect(removed.deleted).toBe(true);
  });

  it("preserves Teams edit/thread/delete identity and gives deletion time precedence", () => {
    const sourceScope = scope("teams_channel", { teamId: "team-a", channelId: "channel-a" }, { permissionMode: "BROAD" });
    const context = { directoryTenantId: DIRECTORY_A, ingestionMode: "incremental" as const, traceId: "teams" };
    const edited = normalizeTeamsMessage({
      id: "reply-a",
      replyToId: "root-a",
      etag: "edit-2",
      createdDateTime: "2026-09-01T00:00:00Z",
      lastModifiedDateTime: "2026-09-02T00:00:00Z",
      body: { contentType: "text", content: "Edited" },
    }, sourceScope, context, "2026-09-03T00:00:00Z", { teamId: "team-a", channelId: "channel-a" });
    expect(edited).toMatchObject({
      externalObjectId: "team-a/channel-a/reply-a",
      providerVersion: "edit-2",
      providerParentRefs: expect.arrayContaining([
        expect.objectContaining({ externalObjectId: "team-a/channel-a/root-a", relationship: "thread" }),
      ]),
    });
    const deleted = normalizeTeamsMessage({
      id: "reply-a",
      createdDateTime: "2026-09-01T00:00:00Z",
      lastModifiedDateTime: "2026-09-02T00:00:00Z",
      deletedDateTime: "2026-09-04T00:00:00Z",
      body: { contentType: "text", content: "" },
    }, sourceScope, context, "2026-09-05T00:00:00Z", { teamId: "team-a", channelId: "channel-a" });
    expect(deleted).toMatchObject({ deleted: true, observedAt: "2026-09-04T00:00:00.000Z" });
  });

  it("keeps Drive identity stable across rename/move and bounds Lists without inventing Documents", () => {
    const context = { directoryTenantId: DIRECTORY_A, ingestionMode: "incremental" as const, traceId: "files" };
    const driveScope = scope("sharepoint_drive", { siteId: "site-a", driveId: "drive-a" }, { permissionMode: "BROAD" });
    const before = normalizeDriveItem({
      id: "item-a",
      name: "Old.xlsx",
      eTag: "v1",
      parentReference: { id: "folder-a", driveId: "drive-a" },
      file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      lastModifiedDateTime: "2026-09-01T00:00:00Z",
    }, driveScope, context, "2026-09-02T00:00:00Z");
    const after = normalizeDriveItem({
      id: "item-a",
      name: "Renamed.xlsx",
      eTag: "v2",
      parentReference: { id: "folder-b", driveId: "drive-a" },
      file: { mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      lastModifiedDateTime: "2026-09-03T00:00:00Z",
    }, driveScope, context, "2026-09-04T00:00:00Z");
    expect(after.externalObjectId).toBe(before.externalObjectId);
    expect(after.payload).toMatchObject({ name: "Renamed.xlsx", binaryContentMaterialized: false });

    const listScope = scope("sharepoint_list", {
      siteId: "site-a",
      listId: "list-a",
      selectedFields: ["Status", "Notes"],
    }, { permissionMode: "BROAD" });
    const listItem = normalizeListItem({
      id: "item-1",
      eTag: "list-v2",
      lastModifiedDateTime: "2026-09-04T00:00:00Z",
      fields: { Status: "Open", Notes: "N".repeat(10_000), SecretUnselected: "not retained" },
    }, listScope, context, "2026-09-05T00:00:00Z");
    expect(listItem.payload).toMatchObject({
      fields: { Status: "Open" },
      selectedFields: ["Status", "Notes"],
      fieldSnapshotTruncated: true,
      documentMaterialized: false,
    });
    expect(JSON.stringify(listItem.payload)).not.toContain("SecretUnselected");
    expect(Buffer.byteLength(String((listItem.payload.fields as Record<string, unknown>).Notes), "utf8")).toBeLessThanOrEqual(8_192);
  });

  it("bounds transcript content and preserves an exact meeting relationship", () => {
    const transcript = normalizeTranscript({
      id: "transcript-a",
      meetingId: "meeting-a",
      createdDateTime: "2026-09-01T00:00:00Z",
    }, "T".repeat(300 * 1_024), "disabled", scope("teams_transcript_organizer", {
      organizerUserId: "organizer-a",
      startDateTime: "2026-01-01T00:00:00Z",
    }, { permissionMode: "BROAD" }), {
      directoryTenantId: DIRECTORY_A,
      ingestionMode: "incremental",
      traceId: "transcript",
    }, "2026-09-02T00:00:00Z", { joinWebUrl: "https://teams.microsoft.com/l/meetup-join/exact-a" });
    expect(transcript).toMatchObject({
      externalObjectId: "organizer-a/meeting-a/transcript-a",
      providerParentRefs: expect.arrayContaining([
        expect.objectContaining({ externalObjectId: "organizer-a/meeting-a", relationship: "meeting" }),
        expect.objectContaining({
          externalObjectId: microsoftTeamsMeetingJoinIdentity("https://teams.microsoft.com/l/meetup-join/exact-a"),
          relationship: "meeting",
        }),
      ]),
      payload: expect.objectContaining({
        contentUntrusted: true,
        contentTruncated: true,
        speakerAttribution: "disabled",
      }),
    });
  });
});

describe("Microsoft Graph failure semantics", () => {
  beforeEach(() => {
    clearMicrosoftGraphTokenCache();
    setMicrosoftIdentityTestOverrides({ stsSender: async () => "assertion", fetch: async () => tokenResponse("graph-token") });
  });

  afterEach(() => {
    clearMicrosoftGraphTokenCache();
    setMicrosoftIdentityTestOverrides({ stsSender: null, fetch: null });
  });

  it("reacquires once on 401 and classifies 403/404/429/503 without inventing deletion", async () => {
    let calls = 0;
    const recovered = new MicrosoftGraphClient(auth(), { fetch: async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ error: { code: "InvalidAuthenticationToken" } }, { status: 401 })
        : Response.json({ value: [] });
    } });
    await expect(recovered.requestJson({ operation: "401", pathOrUrl: "/users" })).resolves.toMatchObject({ status: 200 });
    expect(calls).toBe(2);

    for (const [status, kind, retryable] of [
      [403, "permission", false],
      [404, "not_found", false],
      [429, "throttled", true],
      [503, "provider_down", true],
    ] as const) {
      clearMicrosoftGraphTokenCache();
      const client = new MicrosoftGraphClient(auth(), { fetch: async () => Response.json(
        { error: { code: `Graph${status}` } },
        { status, headers: status === 429 ? { "retry-after": "7" } : undefined },
      ) });
      const error = await client.requestJson({ operation: String(status), pathOrUrl: "/users" }).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(MicrosoftGraphError);
      expect(error).toMatchObject({ kind, retryable });
      if (status === 429) expect(error).toMatchObject({ retryAfterMs: 7_000 });
    }
  });

  it("rejects malformed, wrong-content-type, oversized, beta, and cross-resource responses", async () => {
    const cases: Array<{ response: Response; message: RegExp; maxResponseBytes?: number }> = [
      { response: new Response("{", { headers: { "content-type": "application/json" } }), message: /malformed JSON/i },
      { response: new Response("{}", { headers: { "content-type": "text/html" } }), message: /content type was not JSON/i },
      { response: new Response("{}", { headers: { "content-type": "application/json", "content-length": "999" } }), message: /size bound/i, maxResponseBytes: 8 },
    ];
    for (const item of cases) {
      clearMicrosoftGraphTokenCache();
      const client = new MicrosoftGraphClient(auth(), { fetch: async () => item.response });
      await expect(client.requestJson({ operation: "invalid", pathOrUrl: "/users", maxResponseBytes: item.maxResponseBytes }))
        .rejects.toThrow(item.message);
    }
    const client = new MicrosoftGraphClient(auth(), { fetch: vi.fn() });
    await expect(client.requestJson({ operation: "beta", pathOrUrl: "https://graph.microsoft.com/beta/users" }))
      .rejects.toThrow(/v1\.0/i);
  });
});

describe("Microsoft Graph subscription primitives", () => {
  it("stores only a hash-verifiable high-entropy clientState", () => {
    const generated = generateSubscriptionClientState();
    expect(generated.plaintext).not.toBe(generated.hash);
    expect(generated.hash).toBe(hashSubscriptionClientState(generated.plaintext));
    expect(verifySubscriptionClientState(generated.plaintext, generated.hash)).toBe(true);
    expect(verifySubscriptionClientState(`${generated.plaintext}x`, generated.hash)).toBe(false);
  });

  it("caps resource lifetime and computes deterministic 20 percent renewal lead", () => {
    const now = new Date("2026-09-08T00:00:00Z");
    const mail = scope("outlook_mail_folder", { mailboxId: "mailbox-a", folderId: "folder-a" });
    expect(boundedSubscriptionExpiration(mail, "2026-10-08T00:00:00Z", now)).toBe("2026-09-15T00:00:00.000Z");
    expect(subscriptionRenewAt("2026-09-08T00:00:00Z", "2026-09-10T00:00:00Z")).toBe("2026-09-09T14:24:00.000Z");
  });

  it("does not send clientState during renewal", async () => {
    const calls: Record<string, unknown>[] = [];
    const fakeClient = {
      requestJson: vi.fn(async (request: Record<string, unknown>) => {
        calls.push(request);
        return {
          value: {
            id: "subscription-a",
            resource: "users/mailbox-a/mailFolders/folder-a/messages",
            changeType: "created,updated,deleted",
            expirationDateTime: "2026-09-10T00:00:00Z",
          },
          status: 200,
          clientRequestId: "request",
          headers: new Headers(),
        };
      }),
    } as unknown as MicrosoftGraphClient;
    const transport = new Microsoft365SubscriptionTransport(fakeClient);
    await transport.renew(
      "subscription-a",
      scope("outlook_mail_folder", { mailboxId: "mailbox-a", folderId: "folder-a" }),
      "2026-09-10T00:00:00Z",
      new Date("2026-09-08T00:00:00Z"),
    );
    expect(calls[0]).toMatchObject({ method: "PATCH", body: { expirationDateTime: "2026-09-10T00:00:00.000Z" } });
    expect(JSON.stringify(calls[0])).not.toContain("clientState");
  });
});

import type { ProviderAuthContext } from "@finnor/security";
import type { ProviderObservation } from "@finnor/shared-types";
import { MicrosoftGraphClient } from "./client";
import { MicrosoftGraphError, isTranscriptSpeakerAttributionError } from "./errors";
import {
  normalizeDriveItem,
  normalizeListItem,
  normalizeOutlookEvent,
  normalizeOutlookMessage,
  normalizeTeamsMessage,
  normalizeTranscript,
} from "./normalization";
import { microsoft365SourceCapability } from "./source-capabilities";
import type {
  GraphCollectionPage,
  Microsoft365PageResult,
  Microsoft365ReadContext,
  Microsoft365SourceScope,
  MicrosoftGraphLogger,
  MicrosoftSourceCursor,
} from "./types";

type JsonObject = Record<string, unknown>;
type Collection = GraphCollectionPage<JsonObject> & Record<string, unknown>;

const OUTLOOK_IMMUTABLE_ID = { Prefer: 'IdType="ImmutableId"' } as const;
const MAIL_SELECT = [
  "id", "conversationId", "internetMessageId", "sender", "from", "toRecipients", "ccRecipients", "bccRecipients",
  "replyTo", "subject", "body", "bodyPreview", "importance", "hasAttachments", "createdDateTime", "sentDateTime",
  "receivedDateTime", "lastModifiedDateTime", "changeKey", "categories", "webLink",
].join(",");
const EVENT_SELECT = [
  "id", "subject", "body", "bodyPreview", "organizer", "attendees", "start", "end", "location", "locations",
  "isOnlineMeeting", "onlineMeetingProvider", "onlineMeeting", "responseStatus", "showAs", "sensitivity", "createdDateTime",
  "lastModifiedDateTime", "isCancelled", "iCalUId", "seriesMasterId", "type", "recurrence", "webLink", "changeKey",
].join(",");

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requireConfig(scope: Microsoft365SourceScope, key: string): string {
  const value = string(scope.configuration[key]);
  if (!value) throw new MicrosoftGraphError("blocked_config", `Microsoft source scope ${scope.scopeKey} requires ${key}`, null, false);
  if (Buffer.byteLength(value, "utf8") > 2_048) throw new MicrosoftGraphError("blocked_config", `Microsoft source scope ${key} exceeds its identity bound`, null, false);
  return value;
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function isoConfig(scope: Microsoft365SourceScope, key: string): string {
  const raw = requireConfig(scope, key);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new MicrosoftGraphError("blocked_config", `Microsoft source scope ${key} is not an ISO timestamp`, null, false);
  return new Date(parsed).toISOString();
}

function decodedSegments(url: URL): string[] | null {
  try {
    return url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
}

function exactSegments(expected: readonly (string | ((segment: string) => boolean))[]): (url: URL) => boolean {
  return (url) => {
    const actual = decodedSegments(url);
    return actual !== null && actual.length === expected.length && expected.every((part, index) =>
      typeof part === "string" ? actual[index] === part : part(actual[index] ?? ""));
  };
}

function beginsWithSegments(expected: readonly string[]): (url: URL) => boolean {
  return (url) => {
    const actual = decodedSegments(url);
    return actual !== null && actual.length >= expected.length && expected.every((part, index) => actual[index] === part);
  };
}

function query(path: string, values: Readonly<Record<string, string>>): string {
  const parameters = new URLSearchParams(values);
  return `${path}?${parameters.toString()}`;
}

function validCollection(value: unknown): Collection {
  const page = object(value) as Collection;
  if (!Array.isArray(page.value) || page.value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new MicrosoftGraphError("invalid_response", "Microsoft Graph collection response did not contain an object value array", 200, false);
  }
  for (const key of ["@odata.nextLink", "@odata.deltaLink"] as const) {
    if (page[key] !== undefined && typeof page[key] !== "string") {
      throw new MicrosoftGraphError("invalid_response", `Microsoft Graph ${key} was not an opaque URL`, 200, false);
    }
  }
  return page;
}

function highWatermark(observations: readonly ProviderObservation[]): string | undefined {
  let result: string | undefined;
  for (const observation of observations) {
    if (!result || observation.observedAt > result) result = observation.observedAt;
  }
  return result;
}

function monthsAgo(iso: string, months: number): string {
  const date = new Date(iso);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString();
}

function nextMode(cursor: MicrosoftSourceCursor): Microsoft365ReadContext["ingestionMode"] {
  if (cursor.phase === "recovery") return "recovery";
  if (cursor.phase === "incremental" || cursor.phase === "catchup") return "incremental";
  return "initial_backfill";
}

interface PagePlan {
  pathOrUrl: string;
  allowedOpaquePath: (url: URL) => boolean;
  headers?: Readonly<Record<string, string>>;
  normalize(page: Collection, retrievedAt: string, context: Microsoft365ReadContext): Promise<ProviderObservation[]>;
  region: Readonly<JsonObject>;
  exactDelta: boolean;
}

export interface Microsoft365ObservationAdapterOptions {
  client?: MicrosoftGraphClient;
  fetch?: typeof fetch;
  logger?: MicrosoftGraphLogger;
}

/** Provider transport only. This adapter cannot import or mutate PE domain state. */
export class Microsoft365ObservationAdapter {
  readonly provider = "microsoft_graph" as const;
  private readonly client: MicrosoftGraphClient;

  constructor(private readonly auth: ProviderAuthContext, options: Microsoft365ObservationAdapterOptions = {}) {
    this.client = options.client ?? new MicrosoftGraphClient(auth, { fetch: options.fetch, logger: options.logger });
  }

  private assertScope(scope: Microsoft365SourceScope): void {
    if (scope.tenantId !== this.auth.tenantId || scope.integrationId !== this.auth.integrationId || scope.provider !== this.provider) {
      throw new MicrosoftGraphError("blocked_config", "Microsoft source scope crosses its tenant-bound integration", null, false);
    }
    const capability = microsoft365SourceCapability(scope.sourceKind);
    const required = capability.permissionProfiles[scope.permissionMode];
    if (!required) throw new MicrosoftGraphError("blocked_config", `${scope.sourceKind} does not support ${scope.permissionMode} permission mode`, null, false);
    const missing = required.filter((permission) => !this.auth.consentedPermissions.includes(permission));
    if (missing.length) {
      throw new MicrosoftGraphError("permission", `Microsoft source scope is missing consented application permissions: ${missing.join(", ")}`, 403, false);
    }
  }

  private async attachments(mailboxId: string, message: JsonObject, signal?: AbortSignal): Promise<{ items: JsonObject[]; truncated: boolean }> {
    if (message.hasAttachments !== true || !string(message.id)) return { items: [], truncated: false };
    const path = query(`/users/${encoded(mailboxId)}/messages/${encoded(string(message.id)!)}/attachments`, {
      "$select": "id,name,contentType,size,isInline,lastModifiedDateTime",
      "$top": "250",
    });
    const result = await this.client.requestJson<Collection>({
      operation: "m365.mail.attachments.read",
      pathOrUrl: path,
      headers: OUTLOOK_IMMUTABLE_ID,
      signal,
      maxResponseBytes: 512 * 1024,
    });
    const page = validCollection(result.value);
    return { items: page.value, truncated: Boolean(string(page["@odata.nextLink"])) };
  }

  private plan(scope: Microsoft365SourceScope, cursor: MicrosoftSourceCursor, signal?: AbortSignal): PagePlan {
    const token = string(cursor.token);
    switch (scope.sourceKind) {
      case "outlook_mail_folder": {
        const mailboxId = requireConfig(scope, "mailboxId");
        const folderId = requireConfig(scope, "folderId");
        const allowed = exactSegments(["v1.0", "users", mailboxId, "mailFolders", folderId, "messages", "delta"]);
        return {
          pathOrUrl: token ?? query(`/users/${encoded(mailboxId)}/mailFolders/${encoded(folderId)}/messages/delta`, { "$select": MAIL_SELECT, "$top": "50" }),
          allowedOpaquePath: allowed,
          headers: OUTLOOK_IMMUTABLE_ID,
          exactDelta: true,
          region: { mailboxId, folderId },
          normalize: async (page, _retrievedAt, context) => {
            const material: Array<{ item: JsonObject; attachments: JsonObject[]; attachmentsTruncated: boolean }> = [];
            for (const item of page.value) {
              const attachments = await this.attachments(mailboxId, item, signal);
              material.push({ item, attachments: attachments.items, attachmentsTruncated: attachments.truncated });
            }
            const retrievedAt = new Date().toISOString();
            return material.map(({ item, attachments, attachmentsTruncated }) =>
              normalizeOutlookMessage(item, scope, context, retrievedAt, attachments, attachmentsTruncated));
          },
        };
      }
      case "outlook_calendar_view": {
        const mailboxId = requireConfig(scope, "mailboxId");
        const calendarId = requireConfig(scope, "calendarId");
        const windowStart = isoConfig(scope, "windowStart");
        const windowEnd = isoConfig(scope, "windowEnd");
        if (windowStart >= windowEnd) throw new MicrosoftGraphError("blocked_config", "Calendar coverage window start must precede its end", null, false);
        const allowed = exactSegments(["v1.0", "users", mailboxId, "calendars", calendarId, "calendarView", "delta"]);
        return {
          pathOrUrl: token ?? query(`/users/${encoded(mailboxId)}/calendars/${encoded(calendarId)}/calendarView/delta`, {
            startDateTime: windowStart,
            endDateTime: windowEnd,
            "$select": EVENT_SELECT,
            "$top": "50",
          }),
          allowedOpaquePath: allowed,
          headers: OUTLOOK_IMMUTABLE_ID,
          exactDelta: true,
          region: { mailboxId, calendarId, windowStart, windowEnd },
          normalize: async (page, retrievedAt, context) => page.value.map((item) => normalizeOutlookEvent(item, scope, context, retrievedAt)),
        };
      }
      case "teams_channel": {
        const teamId = requireConfig(scope, "teamId");
        const channelId = requireConfig(scope, "channelId");
        const allowed = exactSegments(["v1.0", "teams", teamId, "channels", channelId, "messages"]);
        return {
          pathOrUrl: token ?? query(`/teams/${encoded(teamId)}/channels/${encoded(channelId)}/messages`, { "$top": "50", "$expand": "replies" }),
          allowedOpaquePath: allowed,
          exactDelta: false,
          region: { teamId, channelId, providerHistory: "available enumeration" },
          normalize: async (page, retrievedAt, context) => page.value.flatMap((item) => {
            const root = normalizeTeamsMessage(item, scope, context, retrievedAt, { teamId, channelId });
            return [root, ...((Array.isArray(item.replies) ? item.replies : []) as JsonObject[]).map((reply) =>
              normalizeTeamsMessage(reply, scope, context, retrievedAt, { teamId, channelId, replyToId: string(item.id) }))];
          }),
        };
      }
      case "teams_chat": {
        const chatId = requireConfig(scope, "chatId");
        const allowed = exactSegments(["v1.0", "chats", chatId, "messages"]);
        return {
          pathOrUrl: token ?? query(`/chats/${encoded(chatId)}/messages`, { "$top": "50", "$orderby": "lastModifiedDateTime desc" }),
          allowedOpaquePath: allowed,
          exactDelta: false,
          region: { chatId, providerHistory: "available enumeration" },
          normalize: async (page, retrievedAt, context) => page.value.map((item) => normalizeTeamsMessage(item, scope, context, retrievedAt, { chatId })),
        };
      }
      case "teams_user_chat_feed": {
        const userId = requireConfig(scope, "userId");
        const allowed = exactSegments(["v1.0", "users", userId, "chats", "getAllMessages", "delta"]);
        return {
          pathOrUrl: token ?? query(`/users/${encoded(userId)}/chats/getAllMessages/delta`, { "$top": "50" }),
          allowedOpaquePath: allowed,
          exactDelta: true,
          region: { userId, rollingHistoryMonths: 8, permissionBlastRadius: "application Chat.Read.All" },
          normalize: async (page, retrievedAt, context) => page.value.map((item) => normalizeTeamsMessage(item, scope, context, retrievedAt, {
            chatId: string(item.chatId) ?? undefined,
            feedUserId: userId,
          })),
        };
      }
      case "teams_transcript_organizer": {
        const organizerUserId = requireConfig(scope, "organizerUserId");
        const startDateTime = isoConfig(scope, "startDateTime");
        const functionSegment = `getAllTranscripts(meetingOrganizerUserId='${organizerUserId.replaceAll("'", "''")}',startDateTime=${startDateTime})`;
        const allowed = (url: URL) => {
          const segments = decodedSegments(url);
          if (!segments) return false;
          if (segments.length === 6) {
            return segments[0] === "v1.0" && segments[1] === "users" && segments[2] === organizerUserId
              && segments[3] === "onlineMeetings" && segments[4] === functionSegment && segments[5] === "delta";
          }
          return segments.length === 5 && segments[0] === "v1.0" && segments[1] === `users(${organizerUserId})`
            && segments[2] === "onlineMeetings" && segments[3] === functionSegment && segments[4] === "delta";
        };
        return {
          pathOrUrl: token ?? `/users/${encoded(organizerUserId)}/onlineMeetings/${functionSegment}/delta`,
          allowedOpaquePath: allowed,
          exactDelta: true,
          region: { organizerUserId, startDateTime, providerHistory: "provider transcript availability" },
          normalize: async (page, _retrievedAt, context) => {
            const material: Array<{
              item: JsonObject;
              content: string;
              speakerAttribution: "available" | "disabled";
              onlineMeeting?: JsonObject;
            }> = [];
            const meetings = new Map<string, JsonObject>();
            for (const item of page.value) {
              if (Object.keys(object(item["@removed"])).length || item.deleted === true) {
                material.push({ item, content: "", speakerAttribution: "disabled" });
                continue;
              }
              const meetingId = requireConfig({ ...scope, configuration: { meetingId: item.meetingId ?? item.onlineMeetingId } }, "meetingId");
              const transcriptId = string(item.id);
              if (!transcriptId) throw new MicrosoftGraphError("invalid_response", "Transcript metadata lacked transcript identity", 200, false);
              let onlineMeeting = meetings.get(meetingId);
              if (!onlineMeeting) {
                const meeting = await this.client.requestJson<JsonObject>({
                  operation: "m365.transcript.online_meeting_identity",
                  pathOrUrl: `/users/${encoded(organizerUserId)}/onlineMeetings/${encoded(meetingId)}?$select=id,joinWebUrl`,
                  allowedOpaquePath: exactSegments(["v1.0", "users", organizerUserId, "onlineMeetings", meetingId]),
                  signal,
                  maxResponseBytes: 256 * 1024,
                });
                onlineMeeting = object(meeting.value);
                if (string(onlineMeeting.id) !== meetingId || !string(onlineMeeting.joinWebUrl)) {
                  throw new MicrosoftGraphError("invalid_response", "Microsoft online meeting identity did not match the transcript meeting", 200, false);
                }
                meetings.set(meetingId, onlineMeeting);
              }
              const contentPath = string(item.transcriptContentUrl)
                ?? `/users/${encoded(organizerUserId)}/onlineMeetings/${encoded(meetingId)}/transcripts/${encoded(transcriptId)}/content`;
              const contentAllowed = beginsWithSegments(["v1.0", "users", organizerUserId, "onlineMeetings", meetingId, "transcripts", transcriptId, "content"]);
              let content: string;
              let speakerAttribution: "available" | "disabled" = "available";
              try {
                content = (await this.client.requestText({
                  operation: "m365.transcript.content.attributed",
                  pathOrUrl: contentPath,
                  acceptedContentTypes: ["text/vtt"],
                  allowedOpaquePath: contentAllowed,
                  signal,
                  maxResponseBytes: 2 * 1024 * 1024,
                })).value;
              } catch (error) {
                if (!isTranscriptSpeakerAttributionError(error)) throw error;
                speakerAttribution = "disabled";
                content = (await this.client.requestText({
                  operation: "m365.transcript.content.unattributed",
                  pathOrUrl: contentPath,
                  acceptedContentTypes: ["application/vnd.microsoft.graph.transcript+text"],
                  allowedOpaquePath: contentAllowed,
                  signal,
                  maxResponseBytes: 2 * 1024 * 1024,
                })).value;
              }
              material.push({ item, content, speakerAttribution, onlineMeeting });
            }
            const retrievedAt = new Date().toISOString();
            return material.map(({ item, content, speakerAttribution, onlineMeeting }) =>
              normalizeTranscript(item, content, speakerAttribution, scope, context, retrievedAt, onlineMeeting));
          },
        };
      }
      case "sharepoint_drive": {
        const driveId = requireConfig(scope, "driveId");
        const rootItemId = string(scope.configuration.rootItemId);
        const expected = rootItemId
          ? ["v1.0", "drives", driveId, "items", rootItemId, "delta"] as const
          : ["v1.0", "drives", driveId, "root", "delta"] as const;
        return {
          pathOrUrl: token ?? query(rootItemId
            ? `/drives/${encoded(driveId)}/items/${encoded(rootItemId)}/delta`
            : `/drives/${encoded(driveId)}/root/delta`, { "$top": "100" }),
          allowedOpaquePath: exactSegments(expected),
          exactDelta: true,
          region: { driveId, rootItemId: rootItemId ?? null },
          normalize: async (page, retrievedAt, context) => page.value.map((item) => normalizeDriveItem(item, scope, context, retrievedAt)),
        };
      }
      case "sharepoint_list": {
        const siteId = requireConfig(scope, "siteId");
        const listId = requireConfig(scope, "listId");
        const selectedFields = Array.isArray(scope.configuration.selectedFields)
          ? scope.configuration.selectedFields.filter((field): field is string => typeof field === "string" && field.trim().length > 0).slice(0, 64)
          : [];
        if (!selectedFields.length) throw new MicrosoftGraphError("blocked_config", "SharePoint List scope requires selectedFields", null, false);
        const allowed = exactSegments(["v1.0", "sites", siteId, "lists", listId, "items", "delta"]);
        return {
          pathOrUrl: token ?? query(`/sites/${encoded(siteId)}/lists/${encoded(listId)}/items/delta`, {
            "$top": "100",
            "$expand": `fields($select=${selectedFields.join(",")})`,
          }),
          allowedOpaquePath: allowed,
          exactDelta: true,
          region: { siteId, listId, selectedFields },
          normalize: async (page, retrievedAt, context) => page.value.map((item) => normalizeListItem(item, scope, context, retrievedAt)),
        };
      }
    }
  }

  async readPage(
    scope: Microsoft365SourceScope,
    cursor: MicrosoftSourceCursor,
    input: Omit<Microsoft365ReadContext, "directoryTenantId" | "ingestionMode"> & { ingestionMode?: Microsoft365ReadContext["ingestionMode"] },
  ): Promise<Microsoft365PageResult> {
    this.assertScope(scope);
    const startedAt = new Date().toISOString();
    let phase = cursor.phase ?? (cursor.token ? "incremental" : "initial");
    let normalizedCursor: MicrosoftSourceCursor = { ...cursor, version: 1, phase };
    if (scope.sourceKind === "outlook_calendar_view" && cursor.token && cursor.windowStart && cursor.windowEnd) {
      const configuredStart = isoConfig(scope, "windowStart");
      const configuredEnd = isoConfig(scope, "windowEnd");
      if (cursor.windowStart !== configuredStart || cursor.windowEnd !== configuredEnd) {
        // A calendarView delta token is bound to its original date range. An
        // expanded or rolled window starts a new uncovered baseline and cannot
        // reuse the old token or inherit COMPLETE coverage.
        normalizedCursor = { version: 1, phase: "initial" };
        phase = "initial";
      }
    }
    const context: Microsoft365ReadContext = {
      directoryTenantId: this.auth.directoryTenantId,
      ingestionMode: input.ingestionMode ?? nextMode(normalizedCursor),
      traceId: input.traceId,
      signal: input.signal,
    };
    const plan = this.plan(scope, normalizedCursor, input.signal);
    let page: Collection;
    try {
      const response = await this.client.requestJson<Collection>({
        operation: `m365.${scope.sourceKind}.page`,
        pathOrUrl: plan.pathOrUrl,
        ...(plan.headers ? { headers: plan.headers } : {}),
        allowedOpaquePath: plan.allowedOpaquePath,
        signal: input.signal,
        maxResponseBytes: 2 * 1024 * 1024,
      });
      page = validCollection(response.value);
    } catch (error) {
      if (!(error instanceof MicrosoftGraphError) || error.kind !== "resync_required" || !plan.exactDelta) throw error;
      if (error.recoveryUrl) {
        const recovery = new URL(error.recoveryUrl);
        if (!plan.allowedOpaquePath(recovery)) {
          throw new MicrosoftGraphError("blocked_config", "Microsoft Graph recovery cursor did not match its configured resource family", 410, false);
        }
      }
      return {
        observations: [],
        nextCursor: {
          version: 1,
          phase: "recovery",
          ...(error.recoveryUrl ? { token: error.recoveryUrl } : {}),
          baselineStartedAt: cursor.baselineStartedAt ?? startedAt,
          ...(cursor.historyBoundary ? { historyBoundary: cursor.historyBoundary } : {}),
        },
        hasMore: true,
        coverage: { state: "RECOVERING", region: plan.region, reason: "provider-directed delta resynchronization" },
      };
    }
    const pageRetrievedAt = new Date().toISOString();
    const observations = await plan.normalize(page, pageRetrievedAt, context);
    const nextLink = string(page["@odata.nextLink"]);
    const deltaLink = string(page["@odata.deltaLink"]);
    if (nextLink) {
      const url = new URL(nextLink);
      if (!plan.allowedOpaquePath(url)) throw new MicrosoftGraphError("blocked_config", "Microsoft Graph nextLink crossed its configured source scope", null, false);
      return {
        observations,
        nextCursor: {
          ...normalizedCursor,
          token: nextLink,
          baselineStartedAt: cursor.baselineStartedAt ?? startedAt,
        },
        hasMore: true,
        highWatermark: highWatermark(observations),
        coverage: { state: phase === "recovery" ? "RECOVERING" : "INITIALIZING", region: plan.region },
      };
    }
    if (plan.exactDelta) {
      if (!deltaLink) throw new MicrosoftGraphError("invalid_response", "Microsoft Graph delta enumeration ended without a terminal deltaLink", 200, false);
      const url = new URL(deltaLink);
      if (!plan.allowedOpaquePath(url)) throw new MicrosoftGraphError("blocked_config", "Microsoft Graph deltaLink crossed its configured source scope", null, false);
      const boundary = cursor.historyBoundary ?? (scope.sourceKind === "teams_user_chat_feed" ? monthsAgo(pageRetrievedAt, 8) : undefined);
      const needsCatchup = phase === "initial" || phase === "recovery";
      return {
        observations,
        nextCursor: {
          version: 1,
          phase: needsCatchup ? "catchup" : "incremental",
          token: deltaLink,
          baselineStartedAt: cursor.baselineStartedAt ?? startedAt,
          ...(!needsCatchup ? { baselineCompletedAt: cursor.baselineCompletedAt ?? pageRetrievedAt } : {}),
          ...(boundary ? { historyBoundary: boundary } : {}),
          ...(scope.sourceKind === "outlook_calendar_view" ? {
            windowStart: String(plan.region.windowStart),
            windowEnd: String(plan.region.windowEnd),
          } : {}),
        },
        hasMore: needsCatchup,
        highWatermark: highWatermark(observations),
        coverage: needsCatchup
          ? { state: phase === "recovery" ? "RECOVERING" : "INITIALIZING", region: plan.region, reason: "terminal baseline stored; immediate catch-up required" }
          : scope.sourceKind === "teams_user_chat_feed"
            ? { state: "HISTORY_LIMITED", region: { ...plan.region, earliestRetrievableAt: boundary }, reason: "Microsoft Graph exposes a rolling eight-month delta horizon" }
            : { state: "COMPLETE", region: plan.region },
      };
    }
    return {
      observations,
      nextCursor: {
        version: 1,
        phase: "incremental",
        baselineStartedAt: cursor.baselineStartedAt ?? startedAt,
        baselineCompletedAt: cursor.baselineCompletedAt ?? pageRetrievedAt,
        reconciliationStartedAt: pageRetrievedAt,
      },
      hasMore: false,
      highWatermark: highWatermark(observations),
      coverage: context.ingestionMode === "recovery"
        ? { state: "PARTIAL", region: plan.region, reason: "bounded reconciliation cannot prove recovery of every missed edit or delete" }
        : { state: "COMPLETE", region: plan.region, reason: "complete provider enumeration at the recorded retrieval boundary" },
    };
  }

  async readObservationPage(
    scope: Microsoft365SourceScope,
    cursor: MicrosoftSourceCursor,
    input: Omit<Microsoft365ReadContext, "directoryTenantId" | "ingestionMode"> & { ingestionMode?: Microsoft365ReadContext["ingestionMode"] },
  ): Promise<import("@finnor/shared-types").ProviderObservationSyncPage> {
    const page = await this.readPage(scope, cursor, input);
    return {
      sourceScopeId: scope.id,
      sourceScope: scope.scopeKey,
      observations: page.observations,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      ...(page.highWatermark ? { highWatermark: page.highWatermark } : {}),
      coverage: page.coverage,
    };
  }
}

export { OUTLOOK_IMMUTABLE_ID };

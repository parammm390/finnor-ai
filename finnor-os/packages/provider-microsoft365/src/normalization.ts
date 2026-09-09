import { createHash } from "node:crypto";
import type { ProviderObservation, ProviderObservationParentRef } from "@finnor/shared-types";
import type { Microsoft365ReadContext, Microsoft365SourceScope } from "./types";
import { MicrosoftGraphError } from "./errors";

const MAX_BODY_BYTES = 96 * 1024;
const MAX_TRANSCRIPT_BYTES = 192 * 1024;
const MAX_SHORT_TEXT_BYTES = 8 * 1024;
const MAX_ID_BYTES = 2 * 1024;
const MAX_RECIPIENTS = 250;
const MAX_ATTENDEES = 500;
const MAX_MENTIONS = 250;
const MAX_ATTACHMENTS = 250;
const MAX_REACTIONS = 250;
const MAX_LIST_FIELDS = 64;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function boundedText(value: unknown, maxBytes = MAX_SHORT_TEXT_BYTES): {
  value: string | null;
  truncated: boolean;
  originalBytes?: number;
  originalHash?: string;
} {
  const raw = text(value);
  if (raw === null) return { value: null, truncated: false };
  const size = utf8Bytes(raw);
  if (size <= maxBytes) return { value: raw, truncated: false };
  const bytes = Buffer.from(raw, "utf8");
  const retained = new TextDecoder().decode(bytes.subarray(0, maxBytes));
  return {
    value: retained,
    truncated: true,
    originalBytes: size,
    originalHash: createHash("sha256").update(bytes).digest("hex"),
  };
}

function boundedId(value: unknown, label: string): string {
  const resolved = text(value);
  if (!resolved || utf8Bytes(resolved) > MAX_ID_BYTES) {
    throw new MicrosoftGraphError("invalid_response", `Microsoft Graph ${label} was missing or exceeded its identity bound`, 200, false);
  }
  return resolved;
}

function timestamp(value: unknown, fallback: string): { value: string; basis: "provider" | "retrieval_fallback" } {
  const resolved = text(value);
  if (resolved && Number.isFinite(Date.parse(resolved))) return { value: new Date(resolved).toISOString(), basis: "provider" };
  return { value: fallback, basis: "retrieval_fallback" };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
}

export function microsoftPayloadHash(payload: Readonly<JsonObject>): string {
  return createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
}

/**
 * Calendar events expose a Teams join URL while callTranscript exposes the
 * onlineMeeting ID. Graph can resolve that ID back to the same joinWebUrl. We
 * retain only a one-way exact identity so the sensitive URL never becomes a
 * mapping key or log value, and we never parse its unstable URL format.
 */
export function microsoftTeamsMeetingJoinIdentity(value: unknown): string | null {
  const joinWebUrl = text(value);
  if (!joinWebUrl || utf8Bytes(joinWebUrl) > 8_192) return null;
  return `join-web-url-sha256:${createHash("sha256").update(joinWebUrl, "utf8").digest("hex")}`;
}

function compoundId(...parts: string[]): string {
  const exact = parts.map((part) => encodeURIComponent(part)).join("/");
  if (utf8Bytes(exact) <= 1_024) return exact;
  return `sha256:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

function removed(item: JsonObject): boolean {
  return Object.keys(object(item["@removed"])).length > 0 || item.deleted === true || text(object(item.deleted).state) !== null;
}

function identity(value: unknown): JsonObject | null {
  const holder = object(value);
  const email = object(holder.emailAddress);
  const user = object(holder.user);
  const application = object(holder.application);
  const device = object(holder.device);
  const result: JsonObject = {};
  const displayName = boundedText(email.name ?? user.displayName ?? application.displayName ?? device.displayName, 512);
  const address = boundedText(email.address, 512);
  const id = boundedText(user.id ?? application.id ?? device.id, 512);
  const tenantId = boundedText(user.tenantId ?? application.tenantId, 128);
  if (displayName.value) result.displayName = displayName.value;
  if (address.value) result.address = address.value.toLowerCase();
  if (id.value) result.id = id.value;
  if (tenantId.value) result.tenantId = tenantId.value;
  return Object.keys(result).length ? result : null;
}

function identities(value: unknown, limit: number): { values: JsonObject[]; truncated: boolean } {
  const items = array(value);
  return {
    values: items.slice(0, limit).map(identity).filter((item): item is JsonObject => item !== null),
    truncated: items.length > limit,
  };
}

function recipients(value: unknown): { values: JsonObject[]; truncated: boolean } {
  return identities(value, MAX_RECIPIENTS);
}

function stripUntrustedHtml(value: string): string {
  return value
    .replace(/<(script|style|iframe|object|embed|svg|math)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function untrustedBody(value: unknown, maxBytes = MAX_BODY_BYTES): JsonObject {
  const body = object(value);
  const contentType = text(body.contentType)?.toLowerCase() === "html" ? "html" : "text";
  const raw = text(body.content) ?? "";
  const normalized = contentType === "html" ? stripUntrustedHtml(raw) : raw;
  const bounded = boundedText(normalized, maxBytes);
  return {
    contentType,
    normalizedText: bounded.value ?? "",
    contentUntrusted: true,
    contentTruncated: bounded.truncated,
    ...(bounded.originalBytes !== undefined ? { originalProviderBytes: bounded.originalBytes } : {}),
    ...(bounded.originalHash ? { originalProviderContentHash: bounded.originalHash } : {}),
  };
}

function parentRef(
  resourceKind: string,
  externalObjectType: string,
  externalObjectId: string,
  relationship: ProviderObservationParentRef["relationship"],
): ProviderObservationParentRef {
  return { resourceKind, externalObjectType, externalObjectId, relationship };
}

interface ObservationFields {
  resourceKind: string;
  externalObjectType: string;
  externalObjectId: string;
  providerParentRefs?: ProviderObservationParentRef[];
  providerVersion?: string | null;
  observedAt?: unknown;
  retrievedAt: string;
  deleted: boolean;
  payload: JsonObject;
  providerMetadata?: JsonObject;
}

function observation(
  scope: Microsoft365SourceScope,
  context: Microsoft365ReadContext,
  fields: ObservationFields,
): ProviderObservation {
  const observed = timestamp(fields.observedAt, fields.retrievedAt);
  const payload = stable(fields.payload) as JsonObject;
  return Object.freeze({
    tenantId: scope.tenantId,
    integrationId: scope.integrationId,
    sourceScopeId: scope.id,
    provider: "microsoft_graph",
    resourceKind: fields.resourceKind,
    externalObjectType: fields.externalObjectType,
    externalObjectId: fields.externalObjectId,
    providerParentRefs: Object.freeze(fields.providerParentRefs ?? []),
    providerVersion: fields.providerVersion ?? null,
    providerSequence: null,
    observedAt: observed.value,
    retrievedAt: fields.retrievedAt,
    deleted: fields.deleted,
    payloadHash: microsoftPayloadHash(payload),
    payload: Object.freeze(payload),
    providerMetadata: Object.freeze({
      directoryTenantId: context.directoryTenantId,
      sourceKind: scope.sourceKind,
      scopeKey: scope.scopeKey,
      providerResourceId: scope.providerResourceId,
      observedAtBasis: observed.basis,
      ...fields.providerMetadata,
    }),
    ingestionMode: context.ingestionMode,
    traceId: context.traceId,
  });
}

function attachmentMetadata(value: unknown): { values: JsonObject[]; truncated: boolean } {
  const items = array(value);
  const values = items.slice(0, MAX_ATTACHMENTS).map((entry) => {
    const item = object(entry);
    return {
      id: boundedText(item.id, 1_024).value,
      name: boundedText(item.name, 1_024).value,
      contentType: boundedText(item.contentType, 512).value,
      size: typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null,
      isInline: item.isInline === true,
      providerType: boundedText(item["@odata.type"], 256).value,
      contentMaterialized: false,
    };
  });
  return { values, truncated: items.length > MAX_ATTACHMENTS };
}

export function normalizeOutlookMessage(
  item: JsonObject,
  scope: Microsoft365SourceScope,
  context: Microsoft365ReadContext,
  retrievedAt: string,
  attachments: readonly JsonObject[] = [],
  providerAttachmentPageTruncated = false,
): ProviderObservation {
  const mailboxId = boundedId(scope.configuration.mailboxId, "mailbox identity");
  const folderId = boundedId(scope.configuration.folderId, "mail folder identity");
  const id = boundedId(item.id, "message identity");
  const to = recipients(item.toRecipients);
  const cc = recipients(item.ccRecipients);
  const replyTo = recipients(item.replyTo);
  const includeBcc = scope.configuration.includeBcc === true;
  const bcc = includeBcc ? recipients(item.bccRecipients) : { values: [], truncated: false };
  const attachmentResult = attachmentMetadata(attachments.length ? attachments : item.attachments);
  const conversationId = text(item.conversationId);
  const body = untrustedBody(item.body);
  const preview = boundedText(item.bodyPreview, 8_192);
  const subject = boundedText(item.subject, 8_192);
  const deleted = removed(item);
  return observation(scope, context, {
    resourceKind: "outlook_mail",
    externalObjectType: "microsoft_outlook_message",
    externalObjectId: compoundId(mailboxId, id),
    providerVersion: text(item.changeKey),
    observedAt: item.lastModifiedDateTime ?? item.receivedDateTime ?? item.sentDateTime,
    retrievedAt,
    deleted,
    providerParentRefs: [
      parentRef("outlook_mail_folder", "microsoft_outlook_mail_folder", compoundId(mailboxId, folderId), "container"),
      ...(conversationId ? [parentRef("outlook_conversation", "microsoft_outlook_conversation", compoundId(mailboxId, conversationId), "thread")] : []),
    ],
    payload: {
      id,
      mailboxId,
      folderId,
      conversationId,
      internetMessageId: boundedText(item.internetMessageId, 2_048).value,
      sender: identity(item.sender),
      from: identity(item.from),
      toRecipients: to.values,
      ccRecipients: cc.values,
      ...(includeBcc ? { bccRecipients: bcc.values } : {}),
      replyTo: replyTo.values,
      subject: subject.value,
      subjectTruncated: subject.truncated,
      body,
      bodyPreview: preview.value,
      bodyPreviewTruncated: preview.truncated,
      importance: boundedText(item.importance, 64).value,
      hasAttachments: item.hasAttachments === true,
      attachments: attachmentResult.values,
      attachmentsTruncated: attachmentResult.truncated || providerAttachmentPageTruncated,
      createdDateTime: text(item.createdDateTime),
      sentDateTime: text(item.sentDateTime),
      receivedDateTime: text(item.receivedDateTime),
      lastModifiedDateTime: text(item.lastModifiedDateTime),
      changeKey: text(item.changeKey),
      categories: array(item.categories).slice(0, 100).map((entry) => boundedText(entry, 256).value).filter(Boolean),
      webLink: boundedText(item.webLink, 4_096).value,
      deleted,
      recipientsTruncated: to.truncated || cc.truncated || replyTo.truncated || bcc.truncated,
    },
    providerMetadata: { immutableIdRequested: true, binaryAttachmentsMaterialized: false },
  });
}

export function normalizeOutlookEvent(
  item: JsonObject,
  scope: Microsoft365SourceScope,
  context: Microsoft365ReadContext,
  retrievedAt: string,
): ProviderObservation {
  const mailboxId = boundedId(scope.configuration.mailboxId, "calendar mailbox identity");
  const calendarId = boundedId(scope.configuration.calendarId, "calendar identity");
  const id = boundedId(item.id, "calendar event identity");
  const attendeeItems = array(item.attendees);
  const attendees = attendeeItems.slice(0, MAX_ATTENDEES).map((entry) => {
    const attendee = object(entry);
    return { identity: identity(attendee), type: boundedText(attendee.type, 64).value, status: object(attendee.status) };
  });
  const seriesMasterId = text(item.seriesMasterId);
  const meetingJoinIdentity = microsoftTeamsMeetingJoinIdentity(object(item.onlineMeeting).joinUrl);
  const body = untrustedBody(item.body);
  const preview = boundedText(item.bodyPreview, 8_192);
  // A cancelled meeting remains a real calendar event and must be retained as
  // current provider evidence. Only Graph's removal marker is a tombstone.
  const deleted = removed(item);
  return observation(scope, context, {
    resourceKind: "outlook_calendar",
    externalObjectType: "microsoft_calendar_event",
    externalObjectId: compoundId(mailboxId, id),
    providerVersion: text(item.changeKey),
    observedAt: item.lastModifiedDateTime ?? item.createdDateTime,
    retrievedAt,
    deleted,
    providerParentRefs: [
      parentRef("outlook_calendar", "microsoft_outlook_calendar", compoundId(mailboxId, calendarId), "container"),
      ...(seriesMasterId ? [parentRef("outlook_calendar_series", "microsoft_calendar_series", compoundId(mailboxId, seriesMasterId), "series")] : []),
      ...(meetingJoinIdentity ? [parentRef("teams_meeting", "microsoft_teams_meeting_join_identity", meetingJoinIdentity, "meeting")] : []),
    ],
    payload: {
      id,
      mailboxId,
      calendarId,
      subject: boundedText(item.subject).value,
      body,
      bodyPreview: preview.value,
      bodyPreviewTruncated: preview.truncated,
      organizer: identity(item.organizer),
      attendees,
      attendeesTruncated: attendeeItems.length > MAX_ATTENDEES,
      start: object(item.start),
      end: object(item.end),
      location: object(item.location),
      locations: array(item.locations).slice(0, 50).map(object),
      isOnlineMeeting: item.isOnlineMeeting === true,
      onlineMeetingProvider: boundedText(item.onlineMeetingProvider, 128).value,
      onlineMeeting: object(item.onlineMeeting),
      responseStatus: object(item.responseStatus),
      showAs: boundedText(item.showAs, 64).value,
      sensitivity: scope.configuration.includeSensitivity === true ? boundedText(item.sensitivity, 64).value : null,
      createdDateTime: text(item.createdDateTime),
      lastModifiedDateTime: text(item.lastModifiedDateTime),
      isCancelled: item.isCancelled === true,
      iCalUId: boundedText(item.iCalUId, 2_048).value,
      seriesMasterId,
      type: boundedText(item.type, 64).value,
      recurrence: object(item.recurrence),
      meetingJoinIdentity,
      webLink: boundedText(item.webLink, 4_096).value,
      deleted,
    },
    providerMetadata: {
      immutableIdRequested: true,
      coverageWindowStart: scope.configuration.windowStart,
      coverageWindowEnd: scope.configuration.windowEnd,
    },
  });
}

export function normalizeTeamsMessage(
  item: JsonObject,
  scope: Microsoft365SourceScope,
  context: Microsoft365ReadContext,
  retrievedAt: string,
  origin: { teamId?: string; channelId?: string; chatId?: string; feedUserId?: string; replyToId?: string | null },
): ProviderObservation {
  const id = boundedId(item.id, "Teams message identity");
  const teamId = origin.teamId ? boundedId(origin.teamId, "Team identity") : null;
  const channelId = origin.channelId ? boundedId(origin.channelId, "channel identity") : null;
  const chatId = origin.chatId ?? text(item.chatId);
  if (!teamId && !chatId) throw new MicrosoftGraphError("invalid_response", "Teams message lacked a configured Team or chat identity", 200, false);
  const type = teamId ? "microsoft_teams_channel_message" : "microsoft_teams_chat_message";
  const objectId = teamId ? compoundId(teamId, channelId!, id) : compoundId(chatId!, id);
  const replyToId = origin.replyToId ?? text(item.replyToId);
  const mentionItems = array(item.mentions);
  const attachmentItems = array(item.attachments);
  const reactionItems = array(item.reactions);
  const deleted = removed(item) || text(item.deletedDateTime) !== null;
  return observation(scope, context, {
    resourceKind: teamId ? "teams_channel" : "teams_chat",
    externalObjectType: type,
    externalObjectId: objectId,
    providerVersion: text(item.etag ?? item["@odata.etag"]),
    observedAt: deleted
      ? item.deletedDateTime ?? item.lastModifiedDateTime ?? item.createdDateTime
      : item.lastModifiedDateTime ?? item.createdDateTime,
    retrievedAt,
    deleted,
    providerParentRefs: teamId
      ? [
          parentRef("teams_channel", "microsoft_teams_channel", compoundId(teamId, channelId!), "container"),
          ...(replyToId ? [parentRef("teams_channel_thread", type, compoundId(teamId, channelId!, replyToId), "thread")] : []),
        ]
      : [parentRef("teams_chat", "microsoft_teams_chat", chatId!, "thread")],
    payload: {
      id,
      teamId,
      channelId,
      chatId,
      feedUserId: origin.feedUserId ?? null,
      replyToId,
      from: identity(item.from),
      createdDateTime: text(item.createdDateTime),
      lastModifiedDateTime: text(item.lastModifiedDateTime),
      deletedDateTime: text(item.deletedDateTime),
      subject: boundedText(item.subject).value,
      messageType: boundedText(item.messageType, 64).value,
      body: untrustedBody(item.body),
      mentions: mentionItems.slice(0, MAX_MENTIONS).map((entry) => {
        const mention = object(entry);
        return { id: mention.id, mentionText: boundedText(mention.mentionText, 1_024).value, mentioned: identity(mention.mentioned) };
      }),
      mentionsTruncated: mentionItems.length > MAX_MENTIONS,
      attachments: attachmentItems.slice(0, MAX_ATTACHMENTS).map((entry) => {
        const attachment = object(entry);
        return {
          id: boundedText(attachment.id, 1_024).value,
          contentType: boundedText(attachment.contentType, 512).value,
          contentUrl: boundedText(attachment.contentUrl, 4_096).value,
          name: boundedText(attachment.name, 1_024).value,
          thumbnailUrl: boundedText(attachment.thumbnailUrl, 4_096).value,
          contentMaterialized: false,
        };
      }),
      attachmentsTruncated: attachmentItems.length > MAX_ATTACHMENTS,
      reactions: reactionItems.slice(0, MAX_REACTIONS).map((entry) => {
        const reaction = object(entry);
        return { reactionType: boundedText(reaction.reactionType, 64).value, user: identity(reaction.user), createdDateTime: text(reaction.createdDateTime) };
      }),
      reactionsTruncated: reactionItems.length > MAX_REACTIONS,
      webUrl: boundedText(item.webUrl, 4_096).value,
      deleted,
    },
    providerMetadata: { richNotificationUsed: false, contentMaterializedByExactRead: true },
  });
}

export function normalizeTranscript(
  item: JsonObject,
  content: string,
  speakerAttribution: "available" | "disabled",
  scope: Microsoft365SourceScope,
  context: Microsoft365ReadContext,
  retrievedAt: string,
  onlineMeeting?: Readonly<JsonObject>,
): ProviderObservation {
  const organizerUserId = boundedId(scope.configuration.organizerUserId, "transcript organizer identity");
  const meetingId = boundedId(item.meetingId ?? item.onlineMeetingId, "online meeting identity");
  const transcriptId = boundedId(item.id, "transcript identity");
  const bounded = boundedText(content, MAX_TRANSCRIPT_BYTES);
  const meetingJoinIdentity = microsoftTeamsMeetingJoinIdentity(onlineMeeting?.joinWebUrl);
  return observation(scope, context, {
    resourceKind: "teams_transcript",
    externalObjectType: "microsoft_teams_transcript",
    externalObjectId: compoundId(organizerUserId, meetingId, transcriptId),
    providerVersion: text(item.contentCorrelationId ?? item.etag ?? item["@odata.etag"]),
    observedAt: item.createdDateTime,
    retrievedAt,
    deleted: removed(item),
    providerParentRefs: [
      parentRef("teams_meeting", "microsoft_teams_online_meeting", compoundId(organizerUserId, meetingId), "meeting"),
      ...(meetingJoinIdentity ? [parentRef("teams_meeting", "microsoft_teams_meeting_join_identity", meetingJoinIdentity, "meeting")] : []),
    ],
    payload: {
      id: transcriptId,
      organizerUserId,
      meetingId,
      createdDateTime: text(item.createdDateTime),
      content: bounded.value ?? "",
      contentType: speakerAttribution === "available" ? "text/vtt" : "application/vnd.microsoft.graph.transcript+text",
      contentUntrusted: true,
      contentTruncated: bounded.truncated,
      ...(bounded.originalBytes !== undefined ? { originalProviderBytes: bounded.originalBytes } : {}),
      ...(bounded.originalHash ? { originalProviderContentHash: bounded.originalHash } : {}),
      speakerAttribution,
      meetingJoinIdentity,
      deleted: removed(item),
    },
    providerMetadata: { organizerScoped: true },
  });
}

export function normalizeDriveItem(
  item: JsonObject,
  scope: Microsoft365SourceScope,
  context: Microsoft365ReadContext,
  retrievedAt: string,
): ProviderObservation {
  const driveId = boundedId(scope.configuration.driveId, "drive identity");
  const id = boundedId(item.id, "drive item identity");
  const parent = object(item.parentReference);
  const parentId = text(parent.id);
  const deleted = removed(item) || Object.keys(object(item.deleted)).length > 0;
  return observation(scope, context, {
    resourceKind: "sharepoint_drive",
    externalObjectType: "microsoft_drive_item",
    externalObjectId: compoundId(driveId, id),
    providerVersion: text(item.eTag ?? item.cTag ?? item["@odata.etag"]),
    observedAt: item.lastModifiedDateTime ?? item.createdDateTime,
    retrievedAt,
    deleted,
    providerParentRefs: parentId ? [parentRef("sharepoint_drive", "microsoft_drive_item", compoundId(driveId, parentId), "parent")] : [],
    payload: {
      id,
      driveId,
      parentReference: {
        driveId: boundedText(parent.driveId, 1_024).value,
        id: parentId,
        path: boundedText(parent.path, 4_096).value,
        siteId: boundedText(parent.siteId, 1_024).value,
      },
      name: boundedText(item.name, 4_096).value,
      itemType: Object.keys(object(item.file)).length ? "file" : Object.keys(object(item.folder)).length ? "folder" : "other",
      mimeType: boundedText(object(item.file).mimeType, 512).value,
      hashes: object(object(item.file).hashes),
      size: typeof item.size === "number" && Number.isSafeInteger(item.size) && item.size >= 0 ? item.size : null,
      createdDateTime: text(item.createdDateTime),
      lastModifiedDateTime: text(item.lastModifiedDateTime),
      eTag: text(item.eTag),
      cTag: text(item.cTag),
      webUrl: boundedText(item.webUrl, 4_096).value,
      createdBy: identity(item.createdBy),
      lastModifiedBy: identity(item.lastModifiedBy),
      deleted,
      folder: Object.keys(object(item.folder)).length ? { childCount: object(item.folder).childCount ?? null } : null,
      binaryContentMaterialized: false,
    },
    providerMetadata: { rootItemId: scope.configuration.rootItemId ?? null },
  });
}

function boundedField(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string") return boundedText(value, 8_192).value;
  if (Array.isArray(value)) return value.slice(0, 50).map(boundedField);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as JsonObject).slice(0, 25).map(([key, item]) => [key, boundedField(item)]));
  }
  return null;
}

export function normalizeListItem(
  item: JsonObject,
  scope: Microsoft365SourceScope,
  context: Microsoft365ReadContext,
  retrievedAt: string,
): ProviderObservation {
  const siteId = boundedId(scope.configuration.siteId, "SharePoint site identity");
  const listId = boundedId(scope.configuration.listId, "SharePoint list identity");
  const id = boundedId(item.id, "SharePoint list item identity");
  const rawFields = object(item.fields);
  const configured = array(scope.configuration.selectedFields)
    .filter((field): field is string => typeof field === "string" && field.trim().length > 0)
    .slice(0, MAX_LIST_FIELDS);
  if (configured.length === 0) {
    throw new MicrosoftGraphError("blocked_config", "SharePoint List scope requires an explicit bounded selectedFields allowlist", null, false);
  }
  const fields = Object.fromEntries(configured.filter((field) => Object.prototype.hasOwnProperty.call(rawFields, field)).map((field) => [field, boundedField(rawFields[field])]));
  const deleted = removed(item);
  return observation(scope, context, {
    resourceKind: "sharepoint_list",
    externalObjectType: "microsoft_list_item",
    externalObjectId: compoundId(siteId, listId, id),
    providerVersion: text(item.eTag ?? item["@odata.etag"] ?? object(item.fields)["@odata.etag"]),
    observedAt: item.lastModifiedDateTime ?? item.createdDateTime,
    retrievedAt,
    deleted,
    providerParentRefs: [parentRef("sharepoint_list", "microsoft_sharepoint_list", compoundId(siteId, listId), "container")],
    payload: {
      id,
      siteId,
      listId,
      contentType: object(item.contentType),
      createdDateTime: text(item.createdDateTime),
      lastModifiedDateTime: text(item.lastModifiedDateTime),
      eTag: text(item.eTag ?? item["@odata.etag"]),
      fields,
      selectedFields: configured,
      fieldSnapshotTruncated: Object.keys(rawFields).some((field) => !configured.includes(field)),
      deleted,
      documentMaterialized: false,
    },
    providerMetadata: { selectedFieldCount: configured.length },
  });
}

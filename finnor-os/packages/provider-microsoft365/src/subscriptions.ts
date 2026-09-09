import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { MicrosoftGraphClient } from "./client";
import { MicrosoftGraphError } from "./errors";
import { microsoft365SourceCapability } from "./source-capabilities";
import type {
  Microsoft365SourceScope,
  MicrosoftGraphSubscription,
  MicrosoftGraphSubscriptionInput,
} from "./types";

const MINUTE_MS = 60_000;

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function exactHttpsUrl(value: string, label: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch {
    throw new MicrosoftGraphError("blocked_config", `${label} must be a valid HTTPS URL`, null, false);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    throw new MicrosoftGraphError("blocked_config", `${label} must be a credential-free HTTPS URL`, null, false);
  }
  return parsed.toString();
}

function canonicalResource(value: string): string {
  const path = value.startsWith("/") ? value : `/${value}`;
  try { return decodeURIComponent(path).replace(/\/+$/, ""); } catch {
    throw new MicrosoftGraphError("invalid_response", "Microsoft Graph subscription resource was malformed", 200, false);
  }
}

function resourceSegments(value: string): string[] | null {
  if (!value || Buffer.byteLength(value, "utf8") > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(value.split("?", 1)[0] ?? ""); } catch { return null; }
  const raw = decoded.replace(/^https:\/\/graph\.microsoft\.com\/(?:v1\.0|beta)\//i, "").replace(/^\/+|\/+$/g, "");
  if (!raw) return null;
  const result: string[] = [];
  for (const segment of raw.split("/")) {
    const odata = /^([^()]+)\('((?:''|[^'])*)'\)$/.exec(segment);
    if (odata) {
      result.push(odata[1]!.toLowerCase(), odata[2]!.replace(/''/g, "'").toLowerCase());
    } else {
      result.push(segment.toLowerCase());
    }
  }
  return result;
}

function configured(scope: Microsoft365SourceScope, key: string): string | null {
  const item = scope.configuration[key];
  return typeof item === "string" && item.trim() ? item.trim() : null;
}

function begins(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length >= expected.length && expected.every((part, index) => actual[index] === part);
}

/** Validates only the provider resource identity carried by a wake notification.
 * The registered subscription, clientState hash, and directory tenant are separate
 * mandatory checks at ingress. Outlook folder and Teams user-feed notifications can
 * omit the parent scope in their instance resource; in those documented shapes the
 * registered subscription remains the exact coverage boundary. */
export function microsoft365NotificationMatchesScope(scope: Microsoft365SourceScope, resource: string): boolean {
  const actual = resourceSegments(resource);
  if (!actual) return false;
  const id = (key: string) => configured(scope, key)?.toLowerCase() ?? "";
  switch (scope.sourceKind) {
    case "outlook_mail_folder": {
      const mailbox = id("mailboxId");
      const folder = id("folderId");
      return begins(actual, ["users", mailbox, "mailfolders", folder, "messages"])
        || begins(actual, ["users", mailbox, "messages"]);
    }
    case "outlook_calendar_view": {
      const mailbox = id("mailboxId");
      const calendar = id("calendarId");
      return begins(actual, ["users", mailbox, "events"])
        || begins(actual, ["users", mailbox, "calendars", calendar, "events"]);
    }
    case "teams_channel":
      return begins(actual, ["teams", id("teamId"), "channels", id("channelId"), "messages"]);
    case "teams_chat":
      return begins(actual, ["chats", id("chatId"), "messages"]);
    case "teams_user_chat_feed":
      return begins(actual, ["users", id("userId"), "chats", "getallmessages"])
        || (actual[0] === "chats" && actual.length >= 3 && actual[2] === "messages");
    case "sharepoint_drive":
      return begins(actual, ["drives", id("driveId"), "root"])
        || begins(actual, ["drives", id("driveId"), "items"]);
    case "sharepoint_list":
      return begins(actual, ["sites", id("siteId"), "lists", id("listId")]);
    case "teams_transcript_organizer":
      return false;
  }
}

function validateSubscription(value: Record<string, unknown>, expectedResource: string): MicrosoftGraphSubscription {
  const id = string(value.id);
  const resource = string(value.resource);
  const changeType = string(value.changeType);
  const expirationDateTime = string(value.expirationDateTime);
  if (!id || !resource || !changeType || !expirationDateTime || !Number.isFinite(Date.parse(expirationDateTime))) {
    throw new MicrosoftGraphError("invalid_response", "Microsoft Graph returned an incomplete subscription", 200, false);
  }
  if (canonicalResource(resource) !== canonicalResource(expectedResource)) {
    throw new MicrosoftGraphError("invalid_response", "Microsoft Graph returned a subscription for a different resource", 200, false);
  }
  return {
    id,
    resource,
    changeType,
    expirationDateTime: new Date(expirationDateTime).toISOString(),
    ...(string(value.notificationUrl) ? { notificationUrl: string(value.notificationUrl)! } : {}),
    ...(string(value.lifecycleNotificationUrl) ? { lifecycleNotificationUrl: string(value.lifecycleNotificationUrl)! } : {}),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function generateSubscriptionClientState(): { plaintext: string; hash: string } {
  const plaintext = randomBytes(32).toString("base64url");
  return { plaintext, hash: hashSubscriptionClientState(plaintext) };
}

export function hashSubscriptionClientState(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function verifySubscriptionClientState(plaintext: string, expectedHash: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) return false;
  const actual = Buffer.from(hashSubscriptionClientState(plaintext), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export function boundedSubscriptionExpiration(
  scope: Microsoft365SourceScope,
  requestedAt: string,
  now = new Date(),
): string {
  const capability = microsoft365SourceCapability(scope.sourceKind);
  if (!capability.supportsChangeNotifications || !capability.maxSubscriptionMinutes) {
    throw new MicrosoftGraphError("blocked_config", `${scope.sourceKind} does not support a FINNOR P2 notification subscription`, null, false);
  }
  const requested = Date.parse(requestedAt);
  if (!Number.isFinite(requested) || requested <= now.getTime()) {
    throw new MicrosoftGraphError("blocked_config", "Microsoft subscription expiration must be a future ISO timestamp", null, false);
  }
  const maximum = now.getTime() + capability.maxSubscriptionMinutes * MINUTE_MS;
  return new Date(Math.min(requested, maximum)).toISOString();
}

export function subscriptionRenewAt(createdAtProvider: string, expirationAt: string): string {
  const created = Date.parse(createdAtProvider);
  const expiration = Date.parse(expirationAt);
  if (!Number.isFinite(created) || !Number.isFinite(expiration) || expiration <= created) {
    throw new MicrosoftGraphError("invalid_response", "Microsoft subscription lifetime is invalid", 200, false);
  }
  const lifetime = expiration - created;
  const lead = Math.min(12 * 60 * MINUTE_MS, Math.max(30 * MINUTE_MS, Math.floor(lifetime * 0.2)));
  return new Date(expiration - Math.min(lead, Math.max(MINUTE_MS, lifetime - MINUTE_MS))).toISOString();
}

export function microsoft365SubscriptionResource(scope: Microsoft365SourceScope): string {
  const descriptor = microsoft365SourceCapability(scope.sourceKind);
  if (!descriptor.subscriptionResource) {
    throw new MicrosoftGraphError("blocked_config", `${scope.sourceKind} has no supported notification resource`, null, false);
  }
  return descriptor.subscriptionResource(scope);
}

export function microsoft365SubscriptionChangeTypes(scope: Microsoft365SourceScope): readonly ("created" | "updated" | "deleted")[] {
  switch (scope.sourceKind) {
    case "sharepoint_drive":
    case "sharepoint_list":
      return ["updated"];
    case "outlook_mail_folder":
    case "outlook_calendar_view":
    case "teams_channel":
    case "teams_chat":
    case "teams_user_chat_feed":
      return ["created", "updated", "deleted"];
    case "teams_transcript_organizer":
      throw new MicrosoftGraphError("blocked_config", `${scope.sourceKind} has no supported notification resource`, null, false);
  }
}

function sameChangeTypes(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length
    && [...actual].sort().every((entry, index) => entry === [...expected].sort()[index]);
}

export class Microsoft365SubscriptionTransport {
  constructor(private readonly client: MicrosoftGraphClient) {}

  async create(
    scope: Microsoft365SourceScope,
    input: Omit<MicrosoftGraphSubscriptionInput, "resource"> & { resource?: string },
    now = new Date(),
  ): Promise<MicrosoftGraphSubscription> {
    const resource = microsoft365SubscriptionResource(scope);
    if (input.resource && canonicalResource(input.resource) !== canonicalResource(resource)) {
      throw new MicrosoftGraphError("blocked_config", "Subscription resource does not match the tenant-bound source scope", null, false);
    }
    if (!input.clientState || Buffer.byteLength(input.clientState, "utf8") < 32 || Buffer.byteLength(input.clientState, "utf8") > 128) {
      throw new MicrosoftGraphError("blocked_config", "Subscription clientState must contain 32 to 128 bytes of entropy-bearing text", null, false);
    }
    const changeTypes = [...new Set(input.changeTypes.map((entry) => entry.trim()).filter(Boolean))];
    if (!changeTypes.length || changeTypes.length > 8 || changeTypes.some((entry) => !["created", "updated", "deleted"].includes(entry))) {
      throw new MicrosoftGraphError("blocked_config", "Subscription change types are invalid or unbounded", null, false);
    }
    if (!sameChangeTypes(changeTypes, microsoft365SubscriptionChangeTypes(scope))) {
      throw new MicrosoftGraphError("blocked_config", "Subscription change types do not match the source capability", null, false);
    }
    if (!input.lifecycleNotificationUrl) {
      throw new MicrosoftGraphError("blocked_config", "lifecycleNotificationUrl is required for durable Microsoft subscription recovery", null, false);
    }
    const requestedExpirationAt = boundedSubscriptionExpiration(scope, input.requestedExpirationAt, now);
    const response = await this.client.requestJson<Record<string, unknown>>({
      operation: "m365.subscription.create",
      pathOrUrl: "/subscriptions",
      method: "POST",
      headers: microsoft365SourceCapability(scope.sourceKind).supportsImmutableId ? { Prefer: 'IdType="ImmutableId"' } : undefined,
      body: {
        changeType: changeTypes.join(","),
        notificationUrl: exactHttpsUrl(input.notificationUrl, "notificationUrl"),
        ...(input.lifecycleNotificationUrl ? { lifecycleNotificationUrl: exactHttpsUrl(input.lifecycleNotificationUrl, "lifecycleNotificationUrl") } : {}),
        resource: resource.replace(/^\//, ""),
        expirationDateTime: requestedExpirationAt,
        clientState: input.clientState,
      },
      maxResponseBytes: 128 * 1024,
    });
    const subscription = validateSubscription(response.value, resource);
    if (!sameChangeTypes(subscription.changeType.split(",").map((entry) => entry.trim()).filter(Boolean), changeTypes)) {
      throw new MicrosoftGraphError("invalid_response", "Microsoft Graph returned different subscription change types", response.status, false);
    }
    if (Date.parse(subscription.expirationDateTime) <= now.getTime()) {
      throw new MicrosoftGraphError("invalid_response", "Microsoft Graph returned an already expired subscription", response.status, false);
    }
    return subscription;
  }

  async renew(
    providerSubscriptionId: string,
    scope: Microsoft365SourceScope,
    requestedExpirationAt: string,
    now = new Date(),
  ): Promise<MicrosoftGraphSubscription> {
    if (!providerSubscriptionId.trim()) throw new MicrosoftGraphError("blocked_config", "Provider subscription ID is required", null, false);
    const resource = microsoft365SubscriptionResource(scope);
    const response = await this.client.requestJson<Record<string, unknown>>({
      operation: "m365.subscription.renew",
      pathOrUrl: `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
      method: "PATCH",
      body: { expirationDateTime: boundedSubscriptionExpiration(scope, requestedExpirationAt, now) },
      maxResponseBytes: 128 * 1024,
    });
    const subscription = validateSubscription(response.value, resource);
    if (subscription.id !== providerSubscriptionId) {
      throw new MicrosoftGraphError("invalid_response", "Microsoft Graph renewed a different subscription identity", response.status, false);
    }
    if (!sameChangeTypes(subscription.changeType.split(",").map((entry) => entry.trim()).filter(Boolean), microsoft365SubscriptionChangeTypes(scope))) {
      throw new MicrosoftGraphError("invalid_response", "Microsoft Graph returned different subscription change types", response.status, false);
    }
    return subscription;
  }

  /** Reconciles the narrow crash window after Graph accepted creation but before
   * FINNOR durably stored the returned ID. Graph returns clientState to the owning
   * app; compare only its hash and never expose or persist the plaintext. */
  async findCreatedByClientStateHash(
    scope: Microsoft365SourceScope,
    expectedClientStateHash: string,
  ): Promise<MicrosoftGraphSubscription | null> {
    if (!/^[0-9a-f]{64}$/.test(expectedClientStateHash)) {
      throw new MicrosoftGraphError("blocked_config", "Expected clientState hash is invalid", null, false);
    }
    const expectedResource = microsoft365SubscriptionResource(scope);
    const expectedChangeTypes = microsoft365SubscriptionChangeTypes(scope);
    let pathOrUrl = "/subscriptions?$top=100";
    const matches: MicrosoftGraphSubscription[] = [];
    for (let page = 0; page < 10; page += 1) {
      const response = await this.client.requestJson<Record<string, unknown>>({
        operation: "m365.subscription.reconcile_create",
        pathOrUrl,
        maxResponseBytes: 512 * 1024,
        allowedOpaquePath: pathOrUrl.startsWith("https:")
          ? (url) => url.pathname.toLowerCase() === "/v1.0/subscriptions"
          : undefined,
      });
      if (!Array.isArray(response.value.value) || response.value.value.some((entry) => !object(entry))) {
        throw new MicrosoftGraphError("invalid_response", "Microsoft Graph subscription list was malformed", response.status, false);
      }
      for (const entry of response.value.value as Record<string, unknown>[]) {
        const clientState = string(entry.clientState);
        const resource = string(entry.resource);
        const changeTypes = string(entry.changeType)?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
        if (!clientState || !resource || hashSubscriptionClientState(clientState) !== expectedClientStateHash
            || canonicalResource(resource) !== canonicalResource(expectedResource)
            || !sameChangeTypes(changeTypes, expectedChangeTypes)) continue;
        matches.push(validateSubscription(entry, expectedResource));
      }
      const next = string(response.value["@odata.nextLink"]);
      if (!next) break;
      pathOrUrl = next;
      if (page === 9) {
        throw new MicrosoftGraphError("invalid_response", "Microsoft Graph subscription reconciliation exceeded its page bound", response.status, false);
      }
    }
    if (matches.length > 1) {
      throw new MicrosoftGraphError("invalid_response", "Multiple Graph subscriptions matched one provisioning clientState", 200, false);
    }
    return matches[0] ?? null;
  }

  async reauthorize(providerSubscriptionId: string): Promise<void> {
    if (!providerSubscriptionId.trim()) throw new MicrosoftGraphError("blocked_config", "Provider subscription ID is required", null, false);
    await this.client.requestJson<Record<string, unknown>>({
      operation: "m365.subscription.reauthorize",
      pathOrUrl: `/subscriptions/${encodeURIComponent(providerSubscriptionId)}/reauthorize`,
      method: "POST",
      maxResponseBytes: 16 * 1024,
    });
  }

  async delete(providerSubscriptionId: string): Promise<void> {
    if (!providerSubscriptionId.trim()) throw new MicrosoftGraphError("blocked_config", "Provider subscription ID is required", null, false);
    try {
      await this.client.requestJson<Record<string, unknown>>({
        operation: "m365.subscription.delete",
        pathOrUrl: `/subscriptions/${encodeURIComponent(providerSubscriptionId)}`,
        method: "DELETE",
        maxResponseBytes: 16 * 1024,
      });
    } catch (error) {
      if (error instanceof MicrosoftGraphError && error.kind === "not_found") return;
      throw error;
    }
  }
}

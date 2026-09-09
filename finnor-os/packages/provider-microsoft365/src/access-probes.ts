import type { ProviderAuthContext } from "@finnor/security";
import type { Microsoft365SourceKind } from "@finnor/shared-types";
import { acquireMicrosoftGraphAccessToken } from "./auth";
import { MicrosoftGraphClient } from "./client";
import { MicrosoftGraphError, isTranscriptAccessDisabled } from "./errors";
import { microsoft365SourceCapability } from "./source-capabilities";
import type { Microsoft365SourceScope, MicrosoftGraphLogger, MicrosoftPermissionMode } from "./types";

type JsonObject = Record<string, unknown>;

const MICROSOFT_GRAPH_AUDIENCES = new Set([
  "00000003-0000-0000-c000-000000000000",
  "https://graph.microsoft.com",
]);

export interface MicrosoftGraphAppTokenInspection {
  tokenType: "application";
  directoryTenantId: string;
  applicationClientId: string;
  servicePrincipalObjectId: string | null;
  roles: string[];
  expiresAt: string;
}

export interface MicrosoftResourceProbeResult {
  sourceKind: Microsoft365SourceKind;
  permissionMode: MicrosoftPermissionMode;
  requiredPermissions: string[];
  effectivePermissions: string[];
  providerRestrictionMethod: string;
  positiveProbe: {
    passed: boolean;
    status: number | null;
    requestId: string | null;
    failureKind: string | null;
  };
  negativeProbe: {
    configured: boolean;
    denied: boolean | null;
    status: number | null;
    requestId: string | null;
    conclusive: boolean;
    reason: string;
  };
  effectiveAccessVerified: boolean;
  leastPrivilegeCertified: boolean;
  verifiedAt: string;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0 && Buffer.byteLength(item, "utf8") <= 256)
    .map((item) => item.trim()))].sort();
}

function stringClaim(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function decodeJwtPayload(token: string): JsonObject {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1] || parts[1].length > 65_536) {
    throw new MicrosoftGraphError("invalid_response", "Microsoft Graph access token was not a bounded JWT", null, false);
  }
  try {
    const bytes = Buffer.from(parts[1], "base64url");
    if (bytes.byteLength > 32_768) throw new Error("payload too large");
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("payload not object");
    return parsed as JsonObject;
  } catch {
    throw new MicrosoftGraphError("invalid_response", "Microsoft Graph access token claims were malformed", null, false);
  }
}

/** Inspect only safe app-identity and role claims in memory. The bearer token is
 * never returned, persisted, logged, or copied into a job/event payload. */
export async function inspectMicrosoftGraphAppOnlyToken(
  auth: ProviderAuthContext,
): Promise<MicrosoftGraphAppTokenInspection> {
  const acquired = await acquireMicrosoftGraphAccessToken(auth);
  const claims = decodeJwtPayload(acquired.accessToken);
  const tenant = stringClaim(claims.tid);
  const application = stringClaim(claims.azp) ?? stringClaim(claims.appid);
  const audience = stringClaim(claims.aud);
  const roles = strings(claims.roles);
  if (!tenant || tenant.toLowerCase() !== auth.directoryTenantId.toLowerCase()) {
    throw new MicrosoftGraphError("auth", "Microsoft app-only token belongs to a different directory", 401, false);
  }
  if (!application || application.toLowerCase() !== auth.applicationClientId.toLowerCase()) {
    throw new MicrosoftGraphError("auth", "Microsoft app-only token belongs to a different application", 401, false);
  }
  if (!audience || !MICROSOFT_GRAPH_AUDIENCES.has(audience.replace(/\/$/, ""))) {
    throw new MicrosoftGraphError("auth", "Microsoft app-only token audience is not Microsoft Graph", 401, false);
  }
  if (stringClaim(claims.scp) || roles.length === 0) {
    throw new MicrosoftGraphError("auth", "Microsoft runtime token is delegated or has no application roles", 401, false);
  }
  return {
    tokenType: "application",
    directoryTenantId: tenant,
    applicationClientId: application,
    servicePrincipalObjectId: stringClaim(claims.oid),
    roles,
    expiresAt: acquired.expiresAt,
  };
}

function configuredString(configuration: Readonly<JsonObject>, key: string): string {
  const value = configuration[key];
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value.trim(), "utf8") > 2_048) {
    throw new MicrosoftGraphError("blocked_config", `Microsoft effective-access probe requires ${key}`, null, false);
  }
  return value.trim();
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function transcriptFunction(configuration: Readonly<JsonObject>): string {
  const organizerUserId = configuredString(configuration, "organizerUserId");
  const start = configuredString(configuration, "startDateTime");
  const parsed = Date.parse(start);
  if (!Number.isFinite(parsed)) {
    throw new MicrosoftGraphError("blocked_config", "Microsoft transcript startDateTime is invalid", null, false);
  }
  return `getAllTranscripts(meetingOrganizerUserId='${organizerUserId.replaceAll("'", "''")}',startDateTime=${encodeURIComponent(new Date(parsed).toISOString())})`;
}

function probePath(sourceKind: Microsoft365SourceKind, configuration: Readonly<JsonObject>): string {
  switch (sourceKind) {
    case "outlook_mail_folder":
      return `/users/${encoded(configuredString(configuration, "mailboxId"))}/mailFolders/${encoded(configuredString(configuration, "folderId"))}?$select=id,parentFolderId`;
    case "outlook_calendar_view":
      return `/users/${encoded(configuredString(configuration, "mailboxId"))}/calendars/${encoded(configuredString(configuration, "calendarId"))}?$select=id`;
    case "teams_channel":
      return `/teams/${encoded(configuredString(configuration, "teamId"))}/channels/${encoded(configuredString(configuration, "channelId"))}/messages?$top=1`;
    case "teams_chat":
      return `/chats/${encoded(configuredString(configuration, "chatId"))}/messages?$top=1`;
    case "teams_user_chat_feed":
      return `/users/${encoded(configuredString(configuration, "userId"))}/chats/getAllMessages?$top=1`;
    case "teams_transcript_organizer": {
      const organizer = configuredString(configuration, "organizerUserId");
      // The organizer-wide surface is the stable delta function. There is no
      // non-delta getAllTranscripts collection at this path.
      return `/users/${encoded(organizer)}/onlineMeetings/${transcriptFunction(configuration)}/delta?$top=1`;
    }
    case "sharepoint_drive": {
      const drive = encoded(configuredString(configuration, "driveId"));
      const rootItem = typeof configuration.rootItemId === "string" && configuration.rootItemId.trim()
        ? `/items/${encoded(configuration.rootItemId.trim())}`
        : "/root";
      return `/drives/${drive}${rootItem}?$select=id,parentReference,file,folder`;
    }
    case "sharepoint_list":
      return `/sites/${encoded(configuredString(configuration, "siteId"))}/lists/${encoded(configuredString(configuration, "listId"))}?$select=id,displayName`;
  }
}

async function runProbe(
  client: MicrosoftGraphClient,
  sourceKind: Microsoft365SourceKind,
  configuration: Readonly<JsonObject>,
): Promise<{ passed: true; status: number; requestId: string | null } | { passed: false; status: number | null; requestId: string | null; error: MicrosoftGraphError }> {
  try {
    const result = await client.requestJson<JsonObject>({
      operation: `m365.${sourceKind}.effective_access_probe`,
      pathOrUrl: probePath(sourceKind, configuration),
      timeoutMs: 15_000,
      maxResponseBytes: 256 * 1024,
      ...(sourceKind === "outlook_mail_folder" || sourceKind === "outlook_calendar_view"
        ? { headers: { Prefer: 'IdType="ImmutableId"' } }
        : {}),
    });
    return { passed: true, status: result.status, requestId: result.requestId ?? null };
  } catch (error) {
    if (error instanceof MicrosoftGraphError) {
      // Tenant policy disabling transcript APIs is an actionable configuration
      // state, not an ordinary per-resource permission-probe failure. Preserve
      // the provider signal so the administration boundary can report it
      // explicitly and avoid persisting a misleading generic blocked scope.
      if (sourceKind === "teams_transcript_organizer" && isTranscriptAccessDisabled(error)) throw error;
      return { passed: false, status: error.status, requestId: error.requestId ?? null, error };
    }
    throw error;
  }
}

/** Verify the token role profile and actual readability of one exact configured
 * resource. A scoped isolation claim additionally requires a configured negative
 * resource to fail specifically with 403; 404 is deliberately inconclusive. */
export async function probeMicrosoft365SourceAccess(input: {
  auth: ProviderAuthContext;
  scope: Microsoft365SourceScope;
  tokenInspection?: MicrosoftGraphAppTokenInspection;
  negativeProbeConfiguration?: Readonly<JsonObject> | null;
  fetch?: typeof fetch;
  logger?: MicrosoftGraphLogger;
}): Promise<MicrosoftResourceProbeResult> {
  if (input.scope.tenantId !== input.auth.tenantId || input.scope.integrationId !== input.auth.integrationId) {
    throw new MicrosoftGraphError("blocked_config", "Microsoft effective-access probe crosses its tenant integration", null, false);
  }
  const capability = microsoft365SourceCapability(input.scope.sourceKind);
  const required = capability.permissionProfiles[input.scope.permissionMode];
  if (!required) {
    throw new MicrosoftGraphError("blocked_config", `${input.scope.sourceKind} does not support ${input.scope.permissionMode} access`, null, false);
  }
  const inspection = input.tokenInspection ?? await inspectMicrosoftGraphAppOnlyToken(input.auth);
  const missing = required.filter((permission) => !inspection.roles.includes(permission));
  const client = new MicrosoftGraphClient(input.auth, { fetch: input.fetch, logger: input.logger });
  const positive = missing.length === 0
    ? await runProbe(client, input.scope.sourceKind, input.scope.configuration)
    : null;
  let negative: MicrosoftResourceProbeResult["negativeProbe"];
  if (input.scope.permissionMode === "BROAD") {
    negative = {
      configured: false,
      denied: null,
      status: null,
      requestId: null,
      conclusive: true,
      reason: "broad_application_permission_has_tenant_blast_radius",
    };
  } else if (!input.negativeProbeConfiguration) {
    negative = {
      configured: false,
      denied: null,
      status: null,
      requestId: null,
      conclusive: false,
      reason: "known_non_covered_resource_not_configured",
    };
  } else {
    const result = await runProbe(client, input.scope.sourceKind, input.negativeProbeConfiguration);
    negative = result.passed
      ? { configured: true, denied: false, status: result.status, requestId: result.requestId, conclusive: true, reason: "non_covered_resource_was_readable" }
      : {
          configured: true,
          denied: result.status === 403,
          status: result.status,
          requestId: result.requestId,
          conclusive: result.status === 403,
          reason: result.status === 403 ? "provider_denied_non_covered_resource" : "negative_probe_failure_was_not_conclusive",
        };
  }
  const positivePassed = missing.length === 0 && positive?.passed === true;
  const leastPrivilegeCertified = input.scope.permissionMode === "SCOPED"
    && positivePassed
    && negative.configured
    && negative.denied === true
    && negative.conclusive;
  return {
    sourceKind: input.scope.sourceKind,
    permissionMode: input.scope.permissionMode,
    requiredPermissions: [...required],
    effectivePermissions: inspection.roles,
    providerRestrictionMethod: capability.providerRestriction[input.scope.permissionMode],
    positiveProbe: positivePassed
      ? { passed: true, status: positive.status, requestId: positive.requestId, failureKind: null }
      : {
          passed: false,
          status: positive && !positive.passed ? positive.status : null,
          requestId: positive && !positive.passed ? positive.requestId : null,
          failureKind: missing.length > 0 ? "token_role_missing" : positive && !positive.passed ? positive.error.kind : "unknown",
        },
    negativeProbe: negative,
    effectiveAccessVerified: positivePassed && (input.scope.permissionMode === "BROAD" || leastPrivilegeCertified),
    leastPrivilegeCertified,
    verifiedAt: new Date().toISOString(),
  };
}

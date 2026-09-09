import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  applicationConsentRequests,
  authProfiles,
  connectionEvents,
  getPool,
  integrationSourceScopes,
  jobs,
  tenantIntegrations,
  withTenant,
  withTenantTransaction,
  type Db,
} from "@finnor/db";
import {
  allMicrosoft365SourceCapabilities,
  inspectMicrosoftGraphAppOnlyToken,
  isTranscriptAccessDisabled,
  microsoft365SourceCapability,
  MicrosoftGraphError,
  probeMicrosoft365SourceAccess,
  type Microsoft365SourceScope,
  type MicrosoftGraphAppTokenInspection,
  type MicrosoftPermissionMode,
  type MicrosoftResourceProbeResult,
} from "@finnor/provider-microsoft365";
import {
  authorizeAuthProfileConnection,
  authorizeIntegrationAdministration,
  IdentityAccessError,
  ProviderAuthError,
  resolveMicrosoftProviderAuthContext,
} from "@finnor/security";
import type { Microsoft365SourceKind, SourceCoverageState } from "@finnor/shared-types";
import { and, eq, sql } from "drizzle-orm";
import { appendSourceCoverageTx } from "./source-coverage";

type JsonObject = Record<string, unknown>;
type RootType = "pe_strategy" | "pe_opportunity" | "pe_deal";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AWS_REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/;
const SOURCE_KINDS = new Set<Microsoft365SourceKind>(allMicrosoft365SourceCapabilities().map((row) => row.sourceKind));
const ROOT_TYPES = new Set<RootType>(["pe_strategy", "pe_opportunity", "pe_deal"]);
const CAPABILITIES = ["communications", "scheduling", "documents"] as const;
const ALLOWED_READ_PERMISSIONS = new Set([
  "Mail.Read",
  "Calendars.Read",
  "ChannelMessage.Read.Group",
  "ChannelMessage.Read.All",
  "ChatMessage.Read.Chat",
  "Chat.Read.All",
  "OnlineMeetingTranscript.Read.Chat",
  "OnlineMeetingTranscript.Read.All",
  "OnlineMeetings.Read.All",
  "Sites.Selected",
  "Files.SelectedOperations.Selected",
  "Lists.SelectedOperations.Selected",
  "ListItems.SelectedOperations.Selected",
  "Files.Read.All",
  "Sites.Read.All",
]);

export class Microsoft365AdministrationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "Microsoft365AdministrationError";
  }
}

export type MicrosoftConnectionAuthConfiguration =
  | {
      kind: "federated_workload";
      awsRegion: string;
      federationAudience: string;
      federationConfigId: string;
      signingAlgorithm: "ES384" | "RS256";
      identityTokenDurationSeconds?: number;
    }
  | {
      kind: "managed_certificate";
      credentialRef: string;
      credentialVersion?: string;
      certificateFallbackAcknowledged: true;
    };

export interface BeginMicrosoftGraphConnectionInput {
  tenantId: string;
  actorId: string;
  directoryTenantId: string;
  applicationClientId: string;
  requestedPermissions: readonly string[];
  auth: MicrosoftConnectionAuthConfiguration;
  redirectUri: string;
  traceId?: string;
}

export interface ConfigureMicrosoftSourceInput {
  tenantId: string;
  actorId: string;
  sourceKind: Microsoft365SourceKind;
  permissionMode: MicrosoftPermissionMode;
  configuration: Readonly<JsonObject>;
  negativeProbeConfiguration?: Readonly<JsonObject> | null;
  acknowledgeBroadAccess?: boolean;
  rootBinding?: { type: RootType; id: string } | null;
  freshnessPolicy?: Readonly<JsonObject>;
  traceId?: string;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value.trim())) {
    throw new Microsoft365AdministrationError("invalid_configuration", `${label} must be a UUID`);
  }
  return value.trim().toLowerCase();
}

function boundedString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string") throw new Microsoft365AdministrationError("invalid_configuration", `${label} is required`);
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Microsoft365AdministrationError("invalid_configuration", `${label} is invalid or exceeds its bound`);
  }
  return normalized;
}

function boundedObject(value: Readonly<JsonObject>, limit: number, label: string): JsonObject {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > limit) {
    throw new Microsoft365AdministrationError("invalid_configuration", `${label} exceeds its durable bound`);
  }
  if (/"[^"]*(?:secret|password|access[ _-]?token|refresh[ _-]?token|private[ _-]?key|api[ _-]?key|cookie)[^"]*"\s*:/i.test(serialized)) {
    throw new Microsoft365AdministrationError("invalid_configuration", `${label} contains a forbidden secret-shaped field`);
  }
  return value as JsonObject;
}

function exactKeys(value: Readonly<JsonObject>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Microsoft365AdministrationError("invalid_configuration", `${label} contains unsupported fields: ${unexpected.sort().join(", ")}`);
  }
}

function normalizedPermissions(values: readonly string[]): string[] {
  const permissions = [...new Set(values.map((value) => boundedString(value, "requested permission", 128)))].sort();
  if (permissions.length === 0 || permissions.length > 32 || permissions.some((permission) => !ALLOWED_READ_PERMISSIONS.has(permission))) {
    throw new Microsoft365AdministrationError("invalid_permission_profile", "Microsoft permissions must be a non-empty bounded P2 read-only profile");
  }
  return permissions;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function boundedMap<T, R>(values: readonly T[], concurrency: number, mapper: (value: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  for (let offset = 0; offset < values.length; offset += concurrency) {
    output.push(...await Promise.all(values.slice(offset, offset + concurrency).map(mapper)));
  }
  return output;
}

function validateRedirectUri(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch {
    throw new Microsoft365AdministrationError("invalid_redirect", "Microsoft admin-consent redirect URI is invalid");
  }
  const local = process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Microsoft365AdministrationError("invalid_redirect", "Microsoft admin-consent redirect URI must use HTTPS");
  }
  if (url.username || url.password || url.hash) {
    throw new Microsoft365AdministrationError("invalid_redirect", "Microsoft admin-consent redirect URI contains forbidden URL components");
  }
  const configured = (process.env.MICROSOFT_ADMIN_CONSENT_REDIRECT_URIS ?? process.env.MICROSOFT_ADMIN_CONSENT_REDIRECT_URI ?? "")
    .split(",").map((entry) => entry.trim()).filter(Boolean);
  if (configured.length > 0 && !configured.includes(url.toString())) {
    throw new Microsoft365AdministrationError("invalid_redirect", "Microsoft admin-consent redirect URI is not allowlisted");
  }
  if (configured.length === 0 && process.env.NODE_ENV === "production") {
    throw new Microsoft365AdministrationError("blocked_config", "Microsoft admin-consent redirect allowlist is not configured", 503);
  }
  if (configured.length === 0 && !local) {
    throw new Microsoft365AdministrationError("invalid_redirect", "Only a local redirect is allowed without an explicit Microsoft redirect allowlist");
  }
  return url.toString();
}

function validateConnectionAuth(
  tenantId: string,
  input: MicrosoftConnectionAuthConfiguration,
): { authMethod: "workload_identity" | "managed_secret"; credentialProvider: "aws-iam-federated" | "aws-secrets-manager"; credentialRef: string | null; credentialVersion: string | null; scope: JsonObject; restrictions: JsonObject } {
  if (input.kind === "federated_workload") {
    const awsRegion = boundedString(input.awsRegion, "AWS selected Region", 40);
    if (!AWS_REGION.test(awsRegion)) throw new Microsoft365AdministrationError("invalid_configuration", "AWS selected Region is invalid");
    const runtimeRegion = (process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION)?.trim();
    if (runtimeRegion && runtimeRegion !== awsRegion) {
      throw new Microsoft365AdministrationError("region_mismatch", "Microsoft workload federation must use the AWS runtime selected Region", 409);
    }
    const duration = input.identityTokenDurationSeconds ?? 300;
    if (!Number.isSafeInteger(duration) || duration < 60 || duration > 3_600) {
      throw new Microsoft365AdministrationError("invalid_configuration", "AWS identity token duration must be between 60 and 3600 seconds");
    }
    if (input.signingAlgorithm !== "ES384" && input.signingAlgorithm !== "RS256") {
      throw new Microsoft365AdministrationError("invalid_configuration", "AWS signing algorithm must be ES384 or RS256");
    }
    return {
      authMethod: "workload_identity",
      credentialProvider: "aws-iam-federated",
      credentialRef: null,
      credentialVersion: null,
      scope: boundedObject({
        awsRegion,
        federationAudience: boundedString(input.federationAudience, "federation audience", 512),
        federationConfigId: boundedString(input.federationConfigId, "federation configuration identity", 256),
        signingAlgorithm: input.signingAlgorithm,
        identityTokenDurationSeconds: duration,
      }, 16_384, "Microsoft workload configuration"),
      restrictions: { permissionModel: "application", certificateFallback: false },
    };
  }
  if (input.certificateFallbackAcknowledged !== true) {
    throw new Microsoft365AdministrationError("certificate_fallback_unacknowledged", "Certificate fallback requires an explicit administrative acknowledgement");
  }
  const reference = boundedString(input.credentialRef, "certificate credential reference", 1_024);
  if (!reference.startsWith(`finnor/tenants/${tenantId}/`)) {
    throw new Microsoft365AdministrationError("invalid_configuration", "Certificate credential reference is not tenant-bound");
  }
  return {
    authMethod: "managed_secret",
    credentialProvider: "aws-secrets-manager",
    credentialRef: reference,
    credentialVersion: input.credentialVersion ? boundedString(input.credentialVersion, "certificate credential version", 256) : null,
    scope: {},
    restrictions: { permissionModel: "application", certificateFallback: true },
  };
}

function sourceCapability(sourceKind: Microsoft365SourceKind): typeof CAPABILITIES[number] {
  if (sourceKind === "outlook_calendar_view") return "scheduling";
  if (sourceKind === "sharepoint_drive" || sourceKind === "sharepoint_list") return "documents";
  return "communications";
}

function sourceConfiguration(sourceKind: Microsoft365SourceKind, raw: Readonly<JsonObject>): JsonObject {
  boundedObject(raw, 32_768, "Microsoft source configuration");
  const value = (key: string) => boundedString(raw[key], key, 2_048);
  switch (sourceKind) {
    case "outlook_mail_folder":
      exactKeys(raw, ["mailboxId", "folderId"], "Outlook mail scope");
      return { mailboxId: value("mailboxId"), folderId: value("folderId") };
    case "outlook_calendar_view": {
      exactKeys(raw, ["mailboxId", "calendarId", "windowStart", "windowEnd"], "Outlook calendar scope");
      const windowStart = new Date(value("windowStart"));
      const windowEnd = new Date(value("windowEnd"));
      if (!Number.isFinite(windowStart.getTime()) || !Number.isFinite(windowEnd.getTime()) || windowStart >= windowEnd) {
        throw new Microsoft365AdministrationError("invalid_configuration", "Calendar window must contain valid increasing timestamps");
      }
      return { mailboxId: value("mailboxId"), calendarId: value("calendarId"), windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() };
    }
    case "teams_channel":
      exactKeys(raw, ["teamId", "channelId"], "Teams channel scope");
      return { teamId: value("teamId"), channelId: value("channelId") };
    case "teams_chat":
      exactKeys(raw, ["chatId"], "Teams chat scope");
      return { chatId: value("chatId") };
    case "teams_user_chat_feed":
      exactKeys(raw, ["userId"], "Teams user feed scope");
      return { userId: value("userId") };
    case "teams_transcript_organizer": {
      exactKeys(raw, ["organizerUserId", "startDateTime"], "Teams transcript scope");
      const start = new Date(value("startDateTime"));
      if (!Number.isFinite(start.getTime())) throw new Microsoft365AdministrationError("invalid_configuration", "Transcript startDateTime is invalid");
      return { organizerUserId: value("organizerUserId"), startDateTime: start.toISOString() };
    }
    case "sharepoint_drive": {
      exactKeys(raw, ["driveId", "siteId", "userId", "rootItemId"], "SharePoint drive scope");
      const siteId = typeof raw.siteId === "string" && raw.siteId.trim() ? boundedString(raw.siteId, "siteId", 2_048) : null;
      const userId = typeof raw.userId === "string" && raw.userId.trim() ? boundedString(raw.userId, "userId", 2_048) : null;
      if ((siteId === null) === (userId === null)) {
        throw new Microsoft365AdministrationError("invalid_configuration", "Drive scope requires exactly one siteId or userId owner");
      }
      return {
        driveId: value("driveId"),
        ...(siteId ? { siteId } : { userId: userId! }),
        ...(typeof raw.rootItemId === "string" && raw.rootItemId.trim() ? { rootItemId: boundedString(raw.rootItemId, "rootItemId", 2_048) } : {}),
      };
    }
    case "sharepoint_list": {
      exactKeys(raw, ["siteId", "listId", "selectedFields"], "SharePoint list scope");
      const selectedFields = raw.selectedFields === undefined ? [] : Array.isArray(raw.selectedFields)
        ? [...new Set(raw.selectedFields.map((field) => boundedString(field, "selected field", 128)))].sort()
        : (() => { throw new Microsoft365AdministrationError("invalid_configuration", "selectedFields must be an array"); })();
      if (selectedFields.length > 64) throw new Microsoft365AdministrationError("invalid_configuration", "selectedFields exceeds 64 entries");
      return { siteId: value("siteId"), listId: value("listId"), selectedFields };
    }
  }
}

function sourceIdentity(sourceKind: Microsoft365SourceKind, configuration: Readonly<JsonObject>): {
  providerScopeType: string;
  providerResourceId: string;
  providerParentId: string | null;
  region: JsonObject;
} {
  const join = (...keys: string[]) => keys.map((key) => String(configuration[key] ?? "")).join("/");
  switch (sourceKind) {
    case "outlook_mail_folder": return { providerScopeType: "mailbox_folder", providerResourceId: join("mailboxId", "folderId"), providerParentId: String(configuration.mailboxId), region: { mailboxId: configuration.mailboxId, folderId: configuration.folderId } };
    case "outlook_calendar_view": return { providerScopeType: "calendar_view", providerResourceId: join("mailboxId", "calendarId"), providerParentId: String(configuration.mailboxId), region: { mailboxId: configuration.mailboxId, calendarId: configuration.calendarId, windowStart: configuration.windowStart, windowEnd: configuration.windowEnd } };
    case "teams_channel": return { providerScopeType: "team_channel", providerResourceId: join("teamId", "channelId"), providerParentId: String(configuration.teamId), region: { teamId: configuration.teamId, channelId: configuration.channelId, providerHistory: "available_enumeration" } };
    case "teams_chat": return { providerScopeType: "chat", providerResourceId: String(configuration.chatId), providerParentId: null, region: { chatId: configuration.chatId, providerHistory: "available_enumeration" } };
    case "teams_user_chat_feed": return { providerScopeType: "user_chat_feed", providerResourceId: String(configuration.userId), providerParentId: null, region: { userId: configuration.userId, rollingHistoryMonths: 8 } };
    case "teams_transcript_organizer": return { providerScopeType: "meeting_organizer_transcripts", providerResourceId: String(configuration.organizerUserId), providerParentId: null, region: { organizerUserId: configuration.organizerUserId, startDateTime: configuration.startDateTime, providerHistory: "provider_transcript_availability" } };
    case "sharepoint_drive": return { providerScopeType: configuration.siteId ? "sharepoint_drive" : "onedrive", providerResourceId: join("driveId", "rootItemId"), providerParentId: String(configuration.siteId ?? configuration.userId), region: { driveId: configuration.driveId, owner: configuration.siteId ? { type: "site", id: configuration.siteId } : { type: "user", id: configuration.userId }, rootItemId: configuration.rootItemId ?? null } };
    case "sharepoint_list": return { providerScopeType: "sharepoint_list", providerResourceId: join("siteId", "listId"), providerParentId: String(configuration.siteId), region: { siteId: configuration.siteId, listId: configuration.listId, selectedFields: configuration.selectedFields } };
  }
}

function freshnessPolicy(sourceKind: Microsoft365SourceKind, input?: Readonly<JsonObject>): JsonObject {
  const fallback = microsoft365SourceCapability(sourceKind).defaultFreshnessPolicy;
  if (!input) return { ...fallback };
  exactKeys(input, ["maxAgeSeconds", "criticality", "staleBehavior"], "freshness policy");
  const maxAgeSeconds = Number(input.maxAgeSeconds ?? fallback.maxAgeSeconds);
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 60 || maxAgeSeconds > 7 * 24 * 60 * 60) {
    throw new Microsoft365AdministrationError("invalid_configuration", "freshness maxAgeSeconds must be between 60 seconds and 7 days");
  }
  const criticality = input.criticality ?? fallback.criticality;
  const staleBehavior = input.staleBehavior ?? fallback.staleBehavior;
  if (!new Set(["informational", "operational", "consequential"]).has(String(criticality))
      || !new Set(["allow_with_warning", "refresh_then_degrade", "refresh_then_block"]).has(String(staleBehavior))) {
    throw new Microsoft365AdministrationError("invalid_configuration", "freshness policy values are unsupported");
  }
  return { scope: sourceKind, maxAgeSeconds, criticality, staleBehavior };
}

function rootBinding(input?: ConfigureMicrosoftSourceInput["rootBinding"]): { type: RootType; id: string } | null {
  if (!input) return null;
  if (!ROOT_TYPES.has(input.type)) throw new Microsoft365AdministrationError("invalid_root", "Microsoft source root type is unsupported");
  return { type: input.type, id: normalizedUuid(input.id, "world root ID") };
}

function mapAdministrationError(error: unknown): Microsoft365AdministrationError {
  if (error instanceof Microsoft365AdministrationError) return error;
  if (error instanceof IdentityAccessError) return new Microsoft365AdministrationError(error.code, error.message, 403);
  if (error instanceof ProviderAuthError) return new Microsoft365AdministrationError(error.code, error.message, error.code === "blocked_config" ? 409 : 401);
  if (error instanceof MicrosoftGraphError) {
    const status = error.kind === "auth" ? 401 : error.kind === "permission" ? 403 : error.retryable ? 503 : 409;
    return new Microsoft365AdministrationError(`graph_${error.kind}`, error.message, status);
  }
  return new Microsoft365AdministrationError("administration_failed", "Microsoft 365 administration failed", 500);
}

export function isMicrosoft365AdministrationError(error: unknown): error is Microsoft365AdministrationError {
  return error instanceof Microsoft365AdministrationError;
}

export async function beginMicrosoftGraphConnection(input: BeginMicrosoftGraphConnectionInput): Promise<{
  authorizationUrl: string;
  expiresAt: string;
  authProfileRef: string;
  integrationIds: Record<typeof CAPABILITIES[number], string>;
  authKind: MicrosoftConnectionAuthConfiguration["kind"];
}> {
  try {
    const directoryTenantId = normalizedUuid(input.directoryTenantId, "Microsoft directory tenant ID");
    const applicationClientId = normalizedUuid(input.applicationClientId, "Microsoft application client ID");
    const expectedClientId = process.env.MICROSOFT_GRAPH_APPLICATION_CLIENT_ID?.trim().toLowerCase();
    if (process.env.NODE_ENV === "production" && !expectedClientId) {
      throw new Microsoft365AdministrationError("blocked_config", "The deployed FINNOR Microsoft application identity is not configured", 503);
    }
    if (expectedClientId && expectedClientId !== applicationClientId) {
      throw new Microsoft365AdministrationError("application_mismatch", "Microsoft application does not match the deployed FINNOR application", 409);
    }
    const redirectUri = validateRedirectUri(input.redirectUri);
    const permissions = normalizedPermissions(input.requestedPermissions);
    const auth = validateConnectionAuth(input.tenantId, input.auth);
    const authority = await authorizeIntegrationAdministration(input.tenantId, input.actorId);
    const identityHash = sha256(`${directoryTenantId}:${applicationClientId}`).slice(0, 24);
    const accountKey = `microsoft-graph-${identityHash}`;
    const authProfileRef = `microsoft-graph-${identityHash}`;
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 15 * 60_000);

    const integrationIds = await withTenantTransaction(input.tenantId, { userId: input.actorId }, async (db, client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5115))", [`${input.tenantId}:microsoft_graph_connection`]);
      const existingAccount = await client.query<{
        id: string;
        application: string;
        provider: string;
        provider_account_ref: string | null;
        metadata: JsonObject;
      }>(
        `SELECT id,application,provider,provider_account_ref,metadata
           FROM finnor_os.application_accounts
          WHERE tenant_id=$1::uuid AND account_key=$2
          FOR UPDATE`,
        [input.tenantId, accountKey],
      );
      let accountId: string;
      if (existingAccount.rows[0]) {
        const account = existingAccount.rows[0];
        const metadata = object(account.metadata);
        if (account.application !== "microsoft_graph" || account.provider !== "microsoft_graph"
            || account.provider_account_ref?.toLowerCase() !== directoryTenantId
            || String(metadata.directoryTenantId ?? "").toLowerCase() !== directoryTenantId
            || String(metadata.applicationClientId ?? "").toLowerCase() !== applicationClientId) {
          throw new Microsoft365AdministrationError("connection_conflict", "Existing Microsoft application account identity is inconsistent", 409);
        }
        accountId = account.id;
        await client.query(
          `UPDATE finnor_os.application_accounts
              SET status='active',display_name='Microsoft Graph application',
                  capabilities=$3::jsonb,updated_at=clock_timestamp()
            WHERE tenant_id=$1::uuid AND id=$2::uuid`,
          [input.tenantId, accountId, JSON.stringify(CAPABILITIES)],
        );
      } else {
        const created = await client.query<{ id: string }>(
          `INSERT INTO finnor_os.application_accounts(
             tenant_id,account_key,application,provider,display_name,provider_account_ref,status,capabilities,metadata
           ) VALUES ($1::uuid,$2,'microsoft_graph','microsoft_graph','Microsoft Graph application',$3,'active',$4::jsonb,$5::jsonb)
           RETURNING id`,
          [input.tenantId, accountKey, directoryTenantId, JSON.stringify(CAPABILITIES), JSON.stringify({ directoryTenantId, applicationClientId, cloud: "global" })],
        );
        accountId = created.rows[0]!.id;
      }

      const existingProfile = await client.query<{
        id: string;
        application_account_id: string;
        connection_status: string;
      }>(
        `SELECT id,application_account_id,connection_status
           FROM finnor_os.auth_profiles
          WHERE tenant_id=$1::uuid AND auth_profile_ref=$2
          FOR UPDATE`,
        [input.tenantId, authProfileRef],
      );
      let profileId: string;
      let priorStatus = "disconnected";
      if (existingProfile.rows[0]) {
        const profile = existingProfile.rows[0];
        if (profile.application_account_id !== accountId) {
          throw new Microsoft365AdministrationError("connection_conflict", "Existing Microsoft auth profile belongs to another application account", 409);
        }
        profileId = profile.id;
        priorStatus = profile.connection_status;
        await client.query(
          `UPDATE finnor_os.auth_profiles
              SET principal_type='tenant',principal_id=$1::uuid,purpose='source_ingestion',status='active',
                  auth_method=$4,credential_provider=$5,credential_ref=$6,credential_version=$7,
                  connection_required=true,connection_status='connecting',required_scopes=$8::text[],granted_scopes='{}'::text[],
                  provider_subject_ref=NULL,token_expires_at=NULL,last_verified_at=NULL,reauth_required_at=NULL,revoked_at=NULL,
                  scope=$9::jsonb,restrictions=$10::jsonb,capabilities=$11::jsonb,
                  last_connection_error_code=NULL,connection_revision=connection_revision+1,updated_at=clock_timestamp()
            WHERE tenant_id=$1::uuid AND id=$2::uuid AND application_account_id=$3::uuid`,
          [input.tenantId, profileId, accountId, auth.authMethod, auth.credentialProvider, auth.credentialRef, auth.credentialVersion,
            permissions, JSON.stringify(auth.scope), JSON.stringify(auth.restrictions), JSON.stringify(CAPABILITIES)],
        );
      } else {
        const created = await client.query<{ id: string }>(
          `INSERT INTO finnor_os.auth_profiles(
             tenant_id,auth_profile_ref,principal_type,principal_id,application_account_id,purpose,status,
             auth_method,credential_provider,credential_ref,credential_version,connection_required,connection_status,
             required_scopes,granted_scopes,scope,restrictions,capabilities
           ) VALUES ($1::uuid,$2,'tenant',$1::uuid,$3::uuid,'source_ingestion','active',$4,$5,$6,$7,true,'connecting',$8::text[],'{}'::text[],$9::jsonb,$10::jsonb,$11::jsonb)
           RETURNING id`,
          [input.tenantId, authProfileRef, accountId, auth.authMethod, auth.credentialProvider, auth.credentialRef,
            auth.credentialVersion, permissions, JSON.stringify(auth.scope), JSON.stringify(auth.restrictions), JSON.stringify(CAPABILITIES)],
        );
        profileId = created.rows[0]!.id;
      }

      const existingIntegrations = await client.query<{
        id: string;
        capability: typeof CAPABILITIES[number];
        binding: string;
        application_account_id: string | null;
        auth_profile_id: string | null;
      }>(
        `SELECT id,capability,binding,application_account_id,auth_profile_id
           FROM finnor_os.tenant_integrations
          WHERE tenant_id=$1::uuid AND capability=ANY($2::text[])
          FOR UPDATE`,
        [input.tenantId, CAPABILITIES],
      );
      for (const row of existingIntegrations.rows) {
        if (row.binding !== "microsoft_graph" || row.application_account_id !== accountId || row.auth_profile_id !== profileId) {
          throw new Microsoft365AdministrationError("capability_conflict", `Tenant capability ${row.capability} is already bound to another provider identity`, 409);
        }
      }
      const ids = {} as Record<typeof CAPABILITIES[number], string>;
      for (const capability of CAPABILITIES) {
        const existing = existingIntegrations.rows.find((row) => row.capability === capability);
        if (existing) {
          ids[capability] = existing.id;
          await client.query(
            `UPDATE finnor_os.tenant_integrations
                SET mode='real',health='unknown',last_error=NULL,updated_at=clock_timestamp()
              WHERE tenant_id=$1::uuid AND id=$2::uuid`,
            [input.tenantId, existing.id],
          );
        } else {
          const created = await client.query<{ id: string }>(
            `INSERT INTO finnor_os.tenant_integrations(
               tenant_id,capability,binding,mode,config,application_account_id,auth_profile_id,
               source_policy,freshness_policy,sync_scopes,outcome_packs,health,sync_status,freshness_state,webhook_status,reconciliation_status
             ) VALUES ($1::uuid,$2,'microsoft_graph','real','{}'::jsonb,$3::uuid,$4::uuid,
               '{}'::jsonb,'{}'::jsonb,'{}'::text[],'{}'::text[],'unknown','uninitialized','unknown','unknown','unknown')
             RETURNING id`,
            [input.tenantId, capability, accountId, profileId],
          );
          ids[capability] = created.rows[0]!.id;
        }
      }

      // A newer administrator-started consent flow supersedes every unused flow
      // for this exact profile. This prevents an older browser tab from applying
      // stale permission intent after a later configuration request.
      await db.update(applicationConsentRequests).set({
        status: "expired",
        consumedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(applicationConsentRequests.tenantId, input.tenantId),
        eq(applicationConsentRequests.authProfileId, profileId),
        sql`${applicationConsentRequests.consumedAt} IS NULL`,
      ));
      await db.insert(applicationConsentRequests).values({
        tenantId: input.tenantId,
        authProfileId: profileId,
        actorId: input.actorId,
        provider: "microsoft_graph",
        stateHash: sha256(state),
        expectedDirectoryTenantId: directoryTenantId,
        redirectUri,
        requestedPermissions: permissions,
        expiresAt,
      });
      await db.insert(connectionEvents).values({
        tenantId: input.tenantId,
        authProfileId: profileId,
        actorId: input.actorId,
        eventType: "consent_requested",
        fromStatus: priorStatus,
        toStatus: "connecting",
        traceId: input.traceId,
        metadata: {
          directoryTenantId,
          applicationClientId,
          requestedPermissions: permissions,
          authKind: input.auth.kind,
          authorityDecisionId: authority.authorityDecisionId,
          authorityRevision: authority.authorityRevision,
        },
      });

      const scopes = await client.query<{
        id: string;
        source_kind: Microsoft365SourceKind;
        recovery_strategy: "EXACT_DELTA" | "BOUNDED_RECONCILIATION" | "BEST_EFFORT_NOTIFICATION_RECOVERY";
        coverage_policy: JsonObject;
      }>(
        `SELECT id,source_kind,recovery_strategy,coverage_policy
           FROM finnor_os.integration_source_scopes
          WHERE tenant_id=$1::uuid AND integration_id=ANY($2::uuid[]) AND enabled`,
        [input.tenantId, Object.values(ids)],
      );
      for (const scope of scopes.rows) {
        await appendSourceCoverageTx(db, {
          tenantId: input.tenantId,
          sourceScopeId: scope.id,
          sourceKind: scope.source_kind,
          state: "BLOCKED_AUTH",
          recoveryStrength: scope.recovery_strategy,
          region: object(scope.coverage_policy),
          reason: "Microsoft administrative consent or app-only verification is pending",
          metadata: { provider: "microsoft_graph", authorityDecisionId: authority.authorityDecisionId, action: "consent_requested" },
        });
      }
      return ids;
    });

    const authorizationUrl = new URL(`https://login.microsoftonline.com/${directoryTenantId}/v2.0/adminconsent`);
    authorizationUrl.search = new URLSearchParams({
      client_id: applicationClientId,
      scope: "https://graph.microsoft.com/.default",
      redirect_uri: redirectUri,
      state,
    }).toString();
    return {
      authorizationUrl: authorizationUrl.toString(),
      expiresAt: expiresAt.toISOString(),
      authProfileRef,
      integrationIds,
      authKind: input.auth.kind,
    };
  } catch (error) {
    throw mapAdministrationError(error);
  }
}

type ConsumedConsent = {
  request_id: string;
  tenant_id: string;
  auth_profile_id: string;
  actor_id: string;
  provider: string;
  expected_directory_tenant_id: string;
  redirect_uri: string;
  requested_permissions: string[];
  failure_code?: "directory_mismatch";
};

type ConsentScope = {
  id: string;
  integrationId: string;
  sourceKind: Microsoft365SourceKind;
  scopeKey: string;
  providerResourceId: string;
  providerParentId: string | null;
  permissionMode: MicrosoftPermissionMode;
  coveragePolicy: JsonObject;
  freshnessPolicy: JsonObject;
  configuration: JsonObject;
  recoveryStrategy: "EXACT_DELTA" | "BOUNDED_RECONCILIATION" | "BEST_EFFORT_NOTIFICATION_RECOVERY";
  metadata: JsonObject;
  hadSuccessfulSync: boolean;
};

async function consumeMicrosoftConsent(input: {
  state: string;
  returnedDirectoryTenantId: string | null;
  succeeded: boolean;
}): Promise<ConsumedConsent> {
  if (!input.state || input.state.length > 512) {
    throw new Microsoft365AdministrationError("invalid_state", "Microsoft admin-consent state is invalid", 409);
  }
  const stateHash = sha256(input.state);
  let consumed = await getPool().query<ConsumedConsent>(
    "SELECT * FROM finnor_os.consume_application_consent_request($1,$2,$3)",
    [stateHash, input.returnedDirectoryTenantId, input.succeeded],
  );
  if (input.succeeded && consumed.rows.length === 0 && input.returnedDirectoryTenantId) {
    // Consume a valid state as failed after a directory mismatch. The first call
    // intentionally cannot reveal the expected directory or mutate another row.
    consumed = await getPool().query<ConsumedConsent>(
      "SELECT * FROM finnor_os.consume_application_consent_request($1,$2,false)",
      [stateHash, input.returnedDirectoryTenantId],
    );
    if (consumed.rows[0]) {
      return { ...consumed.rows[0], failure_code: "directory_mismatch" };
    }
  }
  const request = consumed.rows[0];
  if (!request || request.provider !== "microsoft_graph") {
    throw new Microsoft365AdministrationError("invalid_state", "Microsoft admin-consent state is invalid, expired, or already used", 409);
  }
  return request;
}

async function loadConsentVerificationTarget(request: ConsumedConsent): Promise<{
  profileRef: string;
  priorStatus: string;
  integrations: string[];
  scopes: ConsentScope[];
}> {
  return withTenantTransaction(request.tenant_id, { userId: request.actor_id, readOnly: true }, async (_db, client) => {
    const profile = await client.query<{ auth_profile_ref: string; connection_status: string; status: string }>(
      `SELECT auth_profile_ref,connection_status,status
         FROM finnor_os.auth_profiles
        WHERE tenant_id=$1::uuid AND id=$2::uuid`,
      [request.tenant_id, request.auth_profile_id],
    );
    if (!profile.rows[0] || profile.rows[0].status !== "active") {
      throw new Microsoft365AdministrationError("profile_changed", "Microsoft auth profile is no longer eligible", 409);
    }
    const integrations = await client.query<{ id: string }>(
      `SELECT id FROM finnor_os.tenant_integrations
        WHERE tenant_id=$1::uuid AND auth_profile_id=$2::uuid
          AND binding='microsoft_graph' AND mode='real'
        ORDER BY id`,
      [request.tenant_id, request.auth_profile_id],
    );
    if (integrations.rows.length === 0) {
      throw new Microsoft365AdministrationError("profile_changed", "Microsoft capability bindings are missing", 409);
    }
    const scopes = await client.query<{
      id: string;
      integration_id: string;
      source_kind: Microsoft365SourceKind;
      scope_key: string;
      provider_resource_id: string;
      provider_parent_id: string | null;
      permission_mode: MicrosoftPermissionMode;
      coverage_policy: JsonObject;
      freshness_policy: JsonObject;
      configuration: JsonObject;
      recovery_strategy: ConsentScope["recoveryStrategy"];
      metadata: JsonObject;
      last_successful_sync_at: Date | null;
    }>(
      `SELECT id,integration_id,source_kind,scope_key,provider_resource_id,provider_parent_id,
              permission_mode,coverage_policy,freshness_policy,configuration,recovery_strategy,metadata,last_successful_sync_at
         FROM finnor_os.integration_source_scopes
        WHERE tenant_id=$1::uuid AND integration_id=ANY($2::uuid[]) AND enabled
        ORDER BY id
        LIMIT 257`,
      [request.tenant_id, integrations.rows.map((row) => row.id)],
    );
    if (scopes.rows.length > 256) {
      throw new Microsoft365AdministrationError("scope_limit", "Microsoft consent verification exceeds the bounded source-scope limit", 409);
    }
    return {
      profileRef: profile.rows[0].auth_profile_ref,
      priorStatus: profile.rows[0].connection_status,
      integrations: integrations.rows.map((row) => row.id),
      scopes: scopes.rows.map((scope) => ({
        id: scope.id,
        integrationId: scope.integration_id,
        sourceKind: scope.source_kind,
        scopeKey: scope.scope_key,
        providerResourceId: scope.provider_resource_id,
        providerParentId: scope.provider_parent_id,
        permissionMode: scope.permission_mode,
        coveragePolicy: object(scope.coverage_policy),
        freshnessPolicy: object(scope.freshness_policy),
        configuration: object(scope.configuration),
        recoveryStrategy: scope.recovery_strategy,
        metadata: object(scope.metadata),
        hadSuccessfulSync: Boolean(scope.last_successful_sync_at),
      })),
    };
  });
}

function negativeConfiguration(metadata: JsonObject): JsonObject | null {
  const certification = object(metadata.permissionCertification);
  const value = certification.negativeProbeConfiguration;
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function scopeForProbe(tenantId: string, scope: ConsentScope): Microsoft365SourceScope {
  return {
    id: scope.id,
    tenantId,
    integrationId: scope.integrationId,
    provider: "microsoft_graph",
    sourceKind: scope.sourceKind,
    scopeKey: scope.scopeKey,
    providerResourceId: scope.providerResourceId,
    providerParentId: scope.providerParentId,
    permissionMode: scope.permissionMode,
    coveragePolicy: scope.coveragePolicy,
    freshnessPolicy: scope.freshnessPolicy,
    configuration: scope.configuration,
  };
}

async function persistConsentFailure(
  request: ConsumedConsent,
  target: Awaited<ReturnType<typeof loadConsentVerificationTarget>> | null,
  error: unknown,
  traceId?: string,
): Promise<void> {
  const graph = error instanceof MicrosoftGraphError ? error : null;
  const administration = error instanceof Microsoft365AdministrationError ? error : null;
  const consentBlocked = administration?.code === "admin_consent_denied" || administration?.code === "directory_mismatch";
  const connectionStatus = graph?.kind === "auth" || consentBlocked ? "reauth_required"
    : graph?.retryable ? "provider_unavailable"
      : "degraded";
  const coverageState: SourceCoverageState = graph?.kind === "auth" || consentBlocked ? "BLOCKED_AUTH" : "BLOCKED_PERMISSION";
  const reasonCode = graph ? `graph_${graph.kind}` : error instanceof Microsoft365AdministrationError ? error.code : "permission_verification_failed";
  await withTenantTransaction(request.tenant_id, { userId: request.actor_id }, async (db, client) => {
    await db.update(applicationConsentRequests).set({
      status: "failed",
      permissionVerification: {
        verified: false,
        reasonCode,
        status: graph?.status ?? null,
        requestId: graph?.requestId ?? null,
        verifiedAt: new Date().toISOString(),
      },
      updatedAt: new Date(),
    }).where(and(
      eq(applicationConsentRequests.tenantId, request.tenant_id),
      eq(applicationConsentRequests.id, request.request_id),
    ));
    await db.update(authProfiles).set({
      connectionStatus,
      lastConnectionErrorCode: reasonCode,
      ...(connectionStatus === "reauth_required" ? { reauthRequiredAt: new Date() } : {}),
      connectionRevision: sql`${authProfiles.connectionRevision} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(authProfiles.tenantId, request.tenant_id), eq(authProfiles.id, request.auth_profile_id)));
    await db.update(tenantIntegrations).set({
      health: connectionStatus === "provider_unavailable" ? "unknown" : "degraded",
      syncStatus: connectionStatus === "provider_unavailable" ? "degraded" : "blocked",
      reconciliationStatus: "blocked",
      lastError: "Microsoft app-only permission verification failed",
      lastCheckAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(tenantIntegrations.tenantId, request.tenant_id),
      eq(tenantIntegrations.authProfileId, request.auth_profile_id),
    ));
    await db.insert(connectionEvents).values({
      tenantId: request.tenant_id,
      authProfileId: request.auth_profile_id,
      actorId: request.actor_id,
      eventType: connectionStatus === "reauth_required" ? "reauth_required" : connectionStatus === "provider_unavailable" ? "provider_unavailable" : "connect_failed",
      fromStatus: target?.priorStatus ?? "connecting",
      toStatus: connectionStatus,
      reasonCode,
      traceId,
      metadata: { requestId: graph?.requestId ?? null, providerStatus: graph?.status ?? null },
    });
    for (const scope of target?.scopes ?? []) {
      await db.update(integrationSourceScopes).set({
        effectivePermissions: [],
        permissionVerifiedAt: null,
        freshnessState: "unknown",
        updatedAt: new Date(),
      }).where(and(eq(integrationSourceScopes.tenantId, request.tenant_id), eq(integrationSourceScopes.id, scope.id)));
      await appendSourceCoverageTx(db, {
        tenantId: request.tenant_id,
        sourceScopeId: scope.id,
        sourceKind: scope.sourceKind,
        state: coverageState,
        recoveryStrength: scope.recoveryStrategy,
        region: scope.coveragePolicy,
        reason: graph?.message ?? "Microsoft app-only permission verification failed",
        metadata: { provider: "microsoft_graph", reasonCode },
      });
    }
    // The raw client is intentionally used only inside this same transaction; no
    // provider call is made while a database lock is held.
    void client;
  });
}

export async function completeMicrosoftGraphAdminConsent(input: {
  state: string;
  returnedDirectoryTenantId?: string | null;
  adminConsent: boolean;
  providerErrorCode?: string | null;
  traceId?: string;
}): Promise<{
  tenantId: string;
  authProfileRef: string;
  status: "active" | "degraded";
  requestedPermissions: string[];
  effectivePermissions: string[];
  verifiedSourceScopes: number;
  failedSourceScopes: number;
}> {
  let request: ConsumedConsent | null = null;
  let target: Awaited<ReturnType<typeof loadConsentVerificationTarget>> | null = null;
  try {
    const returnedTenant = input.returnedDirectoryTenantId
      ? normalizedUuid(input.returnedDirectoryTenantId, "returned Microsoft directory tenant ID")
      : null;
    request = await consumeMicrosoftConsent({
      state: input.state,
      returnedDirectoryTenantId: returnedTenant,
      succeeded: input.adminConsent && !input.providerErrorCode,
    });
    target = await loadConsentVerificationTarget(request);
    await authorizeIntegrationAdministration(request.tenant_id, request.actor_id, target.integrations[0]);
    if (request.failure_code === "directory_mismatch") {
      throw new Microsoft365AdministrationError("directory_mismatch", "Microsoft admin consent returned from a different configured directory", 409);
    }
    if (!input.adminConsent || input.providerErrorCode) {
      throw new Microsoft365AdministrationError(
        "admin_consent_denied",
        "Microsoft administrator did not grant application consent",
        409,
      );
    }

    const authByIntegration = new Map<string, Awaited<ReturnType<typeof resolveMicrosoftProviderAuthContext>>>();
    for (const integrationId of target.integrations) {
      authByIntegration.set(integrationId, await resolveMicrosoftProviderAuthContext({
        tenantId: request.tenant_id,
        integrationId,
        allowConnecting: true,
      }));
    }
    const firstAuth = authByIntegration.get(target.integrations[0]!)!;
    const inspection = await inspectMicrosoftGraphAppOnlyToken(firstAuth);
    const missingRequested = request.requested_permissions.filter((permission) => !inspection.roles.includes(permission));
    const unexpectedEffective = inspection.roles.filter((permission) => !request!.requested_permissions.includes(permission));
    if (missingRequested.length > 0 || unexpectedEffective.length > 0) {
      throw new MicrosoftGraphError(
        "permission",
        missingRequested.length > 0
          ? "Microsoft app-only token is missing requested application roles"
          : "Microsoft app-only token contains application roles outside the requested read-only profile",
        403,
        false,
      );
    }

    const consentTenantId = request.tenant_id;
    const probes = await boundedMap(target.scopes, 8, async (scope): Promise<{ scope: ConsentScope; result: MicrosoftResourceProbeResult }> => {
      const auth = authByIntegration.get(scope.integrationId);
      if (!auth) throw new Microsoft365AdministrationError("profile_changed", "Microsoft source integration changed during verification", 409);
      const result = await probeMicrosoft365SourceAccess({
        auth,
        scope: scopeForProbe(consentTenantId, scope),
        tokenInspection: inspection,
        negativeProbeConfiguration: negativeConfiguration(scope.metadata),
      });
      return { scope, result };
    });
    const failed = probes.filter(({ result }) => !result.effectiveAccessVerified);
    const connectionStatus = failed.length === 0 ? "active" as const : "degraded" as const;
    const verifiedAt = new Date();
    const verification = {
      verified: connectionStatus === "active",
      tokenType: inspection.tokenType,
      directoryTenantId: inspection.directoryTenantId,
      applicationClientId: inspection.applicationClientId,
      servicePrincipalObjectId: inspection.servicePrincipalObjectId,
      requestedPermissions: request.requested_permissions,
      effectivePermissions: inspection.roles,
      verifiedAt: verifiedAt.toISOString(),
      sourceProbes: probes.map(({ scope, result }) => ({
        sourceScopeId: scope.id,
        sourceKind: scope.sourceKind,
        effectiveAccessVerified: result.effectiveAccessVerified,
        leastPrivilegeCertified: result.leastPrivilegeCertified,
        positiveProbe: result.positiveProbe,
        negativeProbe: result.negativeProbe,
        providerRestrictionMethod: result.providerRestrictionMethod,
      })),
    };

    await withTenantTransaction(request.tenant_id, { userId: request.actor_id }, async (db) => {
      await db.update(applicationConsentRequests).set({
        status: connectionStatus === "active" ? "verified" : "failed",
        permissionVerification: verification,
        updatedAt: verifiedAt,
      }).where(and(
        eq(applicationConsentRequests.tenantId, request!.tenant_id),
        eq(applicationConsentRequests.id, request!.request_id),
      ));
      await db.update(authProfiles).set({
        connectionStatus,
        grantedScopes: inspection.roles,
        providerSubjectRef: inspection.servicePrincipalObjectId,
        tokenExpiresAt: null,
        connectedAt: connectionStatus === "active" ? verifiedAt : undefined,
        lastRefreshedAt: verifiedAt,
        lastVerifiedAt: connectionStatus === "active" ? verifiedAt : null,
        reauthRequiredAt: null,
        revokedAt: null,
        lastConnectionErrorCode: connectionStatus === "active" ? null : "effective_access_probe_failed",
        connectionRevision: sql`${authProfiles.connectionRevision} + 1`,
        updatedAt: verifiedAt,
      }).where(and(eq(authProfiles.tenantId, request!.tenant_id), eq(authProfiles.id, request!.auth_profile_id)));
      await db.update(tenantIntegrations).set({
        health: connectionStatus === "active" ? "ok" : "degraded",
        syncStatus: connectionStatus === "active" ? "initializing" : "blocked",
        reconciliationStatus: connectionStatus === "active" ? "healthy" : "blocked",
        lastCheckAt: verifiedAt,
        lastError: connectionStatus === "active" ? null : "One or more configured Microsoft resources failed effective-access verification",
        updatedAt: verifiedAt,
      }).where(and(
        eq(tenantIntegrations.tenantId, request!.tenant_id),
        eq(tenantIntegrations.authProfileId, request!.auth_profile_id),
      ));
      await db.insert(connectionEvents).values([
        {
          tenantId: request!.tenant_id,
          authProfileId: request!.auth_profile_id,
          actorId: request!.actor_id,
          eventType: "consent_returned" as const,
          fromStatus: target!.priorStatus,
          toStatus: "connecting",
          traceId: input.traceId,
          metadata: { directoryTenantId: request!.expected_directory_tenant_id },
        },
        {
          tenantId: request!.tenant_id,
          authProfileId: request!.auth_profile_id,
          actorId: request!.actor_id,
          eventType: connectionStatus === "active" ? "permission_verified" as const : "connect_failed" as const,
          fromStatus: "connecting",
          toStatus: connectionStatus,
          reasonCode: connectionStatus === "active" ? undefined : "effective_access_probe_failed",
          traceId: input.traceId,
          metadata: {
            requestedPermissions: request!.requested_permissions,
            effectivePermissions: inspection.roles,
            verifiedSourceScopes: probes.length - failed.length,
            failedSourceScopes: failed.length,
          },
        },
      ]);
      for (const { scope, result } of probes) {
        const verified = result.effectiveAccessVerified;
        await db.update(integrationSourceScopes).set({
          effectivePermissions: verified ? result.effectivePermissions : [],
          providerRestrictionMethod: result.providerRestrictionMethod,
          permissionVerifiedAt: verified ? verifiedAt : null,
          freshnessState: "unknown",
          metadata: sql`${integrationSourceScopes.metadata} || ${JSON.stringify({
            permissionCertification: {
              ...object(scope.metadata.permissionCertification),
              result: {
                effectiveAccessVerified: result.effectiveAccessVerified,
                leastPrivilegeCertified: result.leastPrivilegeCertified,
                positiveProbe: result.positiveProbe,
                negativeProbe: result.negativeProbe,
                verifiedAt: result.verifiedAt,
              },
            },
          })}::jsonb`,
          updatedAt: verifiedAt,
        }).where(and(eq(integrationSourceScopes.tenantId, request!.tenant_id), eq(integrationSourceScopes.id, scope.id)));
        const coverage = await appendSourceCoverageTx(db, {
          tenantId: request!.tenant_id,
          sourceScopeId: scope.id,
          sourceKind: scope.sourceKind,
          state: verified ? (scope.hadSuccessfulSync ? "RECOVERING" : "INITIALIZING") : "BLOCKED_PERMISSION",
          recoveryStrength: scope.recoveryStrategy,
          region: scope.coveragePolicy,
          reason: verified
            ? scope.hadSuccessfulSync ? "Microsoft access restored; catch-up is required" : "Microsoft access verified; initial baseline is pending"
            : "Microsoft effective resource access or provider restriction verification failed",
          metadata: {
            provider: "microsoft_graph",
            permissionMode: scope.permissionMode,
            effectiveAccessVerified: result.effectiveAccessVerified,
            leastPrivilegeCertified: result.leastPrivilegeCertified,
          },
        });
        if (verified) {
          const supportsNotifications = microsoft365SourceCapability(scope.sourceKind).supportsChangeNotifications;
          await db.insert(jobs).values({
            type: supportsNotifications ? "maintain_integration_subscriptions" : "sync_source",
            payload: {
              tenantId: request!.tenant_id,
              integrationId: scope.integrationId,
              sourceScopeId: scope.id,
              scope: scope.scopeKey,
              reason: "permission_verified",
              ...(input.traceId ? { _correlationId: input.traceId } : {}),
            },
            lane: "batch",
            priority: supportsNotifications ? 25 : 20,
            idempotencyKey: `m365-consent-verified:${scope.id}:${coverage.revision}`,
          }).onConflictDoNothing({ target: jobs.idempotencyKey });
        }
      }
    });

    return {
      tenantId: request.tenant_id,
      authProfileRef: target.profileRef,
      status: connectionStatus,
      requestedPermissions: request.requested_permissions,
      effectivePermissions: inspection.roles,
      verifiedSourceScopes: probes.length - failed.length,
      failedSourceScopes: failed.length,
    };
  } catch (error) {
    if (request) await persistConsentFailure(request, target, error, input.traceId).catch(() => undefined);
    throw mapAdministrationError(error);
  }
}

async function microsoftIntegrationForSource(tenantId: string, sourceKind: Microsoft365SourceKind): Promise<{
  id: string;
  authProfileId: string;
  authProfileRef: string;
  connectionStatus: string;
}> {
  const capability = sourceCapability(sourceKind);
  const [row] = await withTenant(tenantId, (db) => db.select({
    id: tenantIntegrations.id,
    binding: tenantIntegrations.binding,
    mode: tenantIntegrations.mode,
    authProfileId: tenantIntegrations.authProfileId,
    authProfileRef: authProfiles.authProfileRef,
    profileStatus: authProfiles.status,
    connectionStatus: authProfiles.connectionStatus,
  }).from(tenantIntegrations).innerJoin(authProfiles, and(
    eq(authProfiles.tenantId, tenantId),
    eq(authProfiles.id, tenantIntegrations.authProfileId),
  )).where(and(
    eq(tenantIntegrations.tenantId, tenantId),
    eq(tenantIntegrations.capability, capability),
  )).limit(1));
  if (!row || row.binding !== "microsoft_graph" || row.mode !== "real" || !row.authProfileId || row.profileStatus !== "active") {
    throw new Microsoft365AdministrationError("connection_missing", `Microsoft ${capability} capability is not configured`, 409);
  }
  return { id: row.id, authProfileId: row.authProfileId, authProfileRef: row.authProfileRef, connectionStatus: row.connectionStatus };
}

export async function configureMicrosoft365Source(input: ConfigureMicrosoftSourceInput): Promise<{
  sourceScopeId: string;
  scopeKey: string;
  sourceKind: Microsoft365SourceKind;
  status: "initializing" | "blocked_permission";
  permissionVerification: MicrosoftResourceProbeResult;
  coverageRevision: number;
  subscriptionRequired: boolean;
}> {
  try {
    if (!SOURCE_KINDS.has(input.sourceKind)) throw new Microsoft365AdministrationError("invalid_source_kind", "Microsoft source kind is unsupported");
    if (input.permissionMode !== "SCOPED" && input.permissionMode !== "BROAD") {
      throw new Microsoft365AdministrationError("invalid_permission_mode", "Microsoft permission mode must be SCOPED or BROAD");
    }
    if (input.permissionMode === "BROAD" && input.acknowledgeBroadAccess !== true) {
      throw new Microsoft365AdministrationError("broad_access_unacknowledged", "BROAD mode requires explicit acknowledgement of the provider tenant blast radius", 409);
    }
    if (input.permissionMode === "SCOPED" && !input.negativeProbeConfiguration) {
      throw new Microsoft365AdministrationError("negative_probe_required", "SCOPED mode requires a known non-covered resource for provider restriction verification", 409);
    }
    const descriptor = microsoft365SourceCapability(input.sourceKind);
    const requiredPermissions = descriptor.permissionProfiles[input.permissionMode];
    if (!requiredPermissions) {
      throw new Microsoft365AdministrationError("unsupported_permission_mode", `${input.sourceKind} cannot use ${input.permissionMode} mode`, 409);
    }
    const configuration = sourceConfiguration(input.sourceKind, input.configuration);
    const negative = input.negativeProbeConfiguration
      ? sourceConfiguration(input.sourceKind, input.negativeProbeConfiguration)
      : null;
    const identity = sourceIdentity(input.sourceKind, configuration);
    if (negative && sourceIdentity(input.sourceKind, negative).providerResourceId === identity.providerResourceId) {
      throw new Microsoft365AdministrationError("invalid_negative_probe", "Negative probe must identify a different known resource", 409);
    }
    const root = rootBinding(input.rootBinding);
    const freshness = freshnessPolicy(input.sourceKind, input.freshnessPolicy);
    const integration = await microsoftIntegrationForSource(input.tenantId, input.sourceKind);
    await authorizeAuthProfileConnection(input.tenantId, input.actorId, "microsoft_graph", integration.authProfileRef);
    const access = await authorizeIntegrationAdministration(input.tenantId, input.actorId, integration.id);
    if (integration.connectionStatus !== "active") {
      throw new Microsoft365AdministrationError("connection_inactive", "Microsoft app-only connection is not active", 409);
    }
    const auth = await resolveMicrosoftProviderAuthContext({ tenantId: input.tenantId, integrationId: integration.id });
    const scopeKey = `${input.sourceKind}:${sha256(JSON.stringify(configuration)).slice(0, 40)}`;
    const transientScope: Microsoft365SourceScope = {
      id: randomUUID(),
      tenantId: input.tenantId,
      integrationId: integration.id,
      provider: "microsoft_graph",
      sourceKind: input.sourceKind,
      scopeKey,
      providerResourceId: identity.providerResourceId,
      providerParentId: identity.providerParentId,
      permissionMode: input.permissionMode,
      coveragePolicy: identity.region,
      freshnessPolicy: freshness,
      configuration,
    };
    const inspection = await inspectMicrosoftGraphAppOnlyToken(auth);
    if (!sameStrings(inspection.roles, auth.requiredPermissions)
        || !sameStrings(inspection.roles, auth.consentedPermissions)) {
      throw new MicrosoftGraphError(
        "permission",
        "Microsoft app-only token role profile changed and requires administrative recertification",
        403,
        false,
      );
    }
    const probe = await probeMicrosoft365SourceAccess({
      auth,
      scope: transientScope,
      tokenInspection: inspection,
      negativeProbeConfiguration: negative,
    });
    const verified = probe.effectiveAccessVerified;
    const configuredAt = new Date();
    const coverageRegion = boundedObject({
      directoryTenantId: auth.directoryTenantId,
      ...identity.region,
      permissionMode: input.permissionMode,
      providerRestrictionMethod: probe.providerRestrictionMethod,
      historyLimit: descriptor.historyLimit,
    }, 32_768, "Microsoft coverage region");
    const certification = boundedObject({
      negativeProbeConfiguration: negative,
      result: {
        requiredPermissions: probe.requiredPermissions,
        effectivePermissions: probe.effectivePermissions,
        effectiveAccessVerified: probe.effectiveAccessVerified,
        leastPrivilegeCertified: probe.leastPrivilegeCertified,
        positiveProbe: probe.positiveProbe,
        negativeProbe: probe.negativeProbe,
        providerRestrictionMethod: probe.providerRestrictionMethod,
        verifiedAt: probe.verifiedAt,
      },
      ...(input.permissionMode === "BROAD" ? { broadAccessAcknowledgedBy: input.actorId, broadAccessAcknowledgedAt: configuredAt.toISOString() } : {}),
    }, 28_000, "Microsoft permission certification");

    return await withTenantTransaction(input.tenantId, { userId: input.actorId }, async (db, client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5116))", [`${input.tenantId}:${integration.id}:${scopeKey}`]);
      const current = await client.query<{ connection_status: string; profile_id: string }>(
        `SELECT p.connection_status,p.id profile_id
           FROM finnor_os.tenant_integrations i
           JOIN finnor_os.auth_profiles p ON p.tenant_id=i.tenant_id AND p.id=i.auth_profile_id
          WHERE i.tenant_id=$1::uuid AND i.id=$2::uuid AND i.binding='microsoft_graph' AND i.mode='real'
          FOR UPDATE OF i,p`,
        [input.tenantId, integration.id],
      );
      if (!current.rows[0] || current.rows[0].profile_id !== integration.authProfileId || current.rows[0].connection_status !== "active") {
        throw new Microsoft365AdministrationError("connection_changed", "Microsoft connection changed during source verification", 409);
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO finnor_os.integration_source_scopes(
           tenant_id,integration_id,provider,source_kind,provider_scope_type,provider_resource_id,provider_parent_id,
           scope_key,enabled,root_binding_type,root_binding_id,sync_strategy,recovery_strategy,permission_mode,
           required_permissions,effective_permissions,provider_restriction_method,permission_verified_at,
           coverage_policy,freshness_policy,configuration,freshness_state,configured_by,configured_at,disabled_at,metadata
         ) VALUES (
           $1::uuid,$2::uuid,'microsoft_graph',$3,$4,$5,$6,$7,true,$8,$9::uuid,$10,$11,$12,
           $13::text[],$14::text[],$15,$16,$17::jsonb,$18::jsonb,$19::jsonb,'unknown',$20,$21,NULL,$22::jsonb
         )
         ON CONFLICT (tenant_id,integration_id,scope_key) DO UPDATE SET
           provider_scope_type=EXCLUDED.provider_scope_type,
           provider_resource_id=EXCLUDED.provider_resource_id,
           provider_parent_id=EXCLUDED.provider_parent_id,
           enabled=true,
           root_binding_type=EXCLUDED.root_binding_type,
           root_binding_id=EXCLUDED.root_binding_id,
           sync_strategy=EXCLUDED.sync_strategy,
           recovery_strategy=EXCLUDED.recovery_strategy,
           permission_mode=EXCLUDED.permission_mode,
           required_permissions=EXCLUDED.required_permissions,
           effective_permissions=EXCLUDED.effective_permissions,
           provider_restriction_method=EXCLUDED.provider_restriction_method,
           permission_verified_at=EXCLUDED.permission_verified_at,
           coverage_policy=EXCLUDED.coverage_policy,
           freshness_policy=EXCLUDED.freshness_policy,
           configuration=EXCLUDED.configuration,
           freshness_state='unknown',
           configured_by=EXCLUDED.configured_by,
           configured_at=EXCLUDED.configured_at,
           disabled_at=NULL,
           metadata=EXCLUDED.metadata,
           updated_at=clock_timestamp()
         RETURNING id`,
        [
          input.tenantId,
          integration.id,
          input.sourceKind,
          identity.providerScopeType,
          identity.providerResourceId,
          identity.providerParentId,
          scopeKey,
          root?.type ?? null,
          root?.id ?? null,
          descriptor.supportsDelta ? "delta" : "bounded_enumeration",
          descriptor.recoveryStrength,
          input.permissionMode,
          requiredPermissions,
          verified ? probe.effectivePermissions : [],
          probe.providerRestrictionMethod,
          verified ? configuredAt : null,
          JSON.stringify(coverageRegion),
          JSON.stringify(freshness),
          JSON.stringify(configuration),
          input.actorId,
          configuredAt,
          JSON.stringify({
            permissionCertification: certification,
            lastConfigurationAudit: {
              action: "activated",
              actorId: input.actorId,
              authorityDecisionId: access.authorityDecisionId,
              at: configuredAt.toISOString(),
            },
          }),
        ],
      );
      const sourceScopeId = inserted.rows[0]!.id;
      const coverage = await appendSourceCoverageTx(db, {
        tenantId: input.tenantId,
        sourceScopeId,
        sourceKind: input.sourceKind,
        state: verified ? "INITIALIZING" : "BLOCKED_PERMISSION",
        recoveryStrength: descriptor.recoveryStrength,
        region: coverageRegion,
        reason: verified
          ? "Effective Microsoft resource access verified; initial baseline is pending"
          : "Microsoft token role, positive resource access, or provider restriction verification failed",
        baselineStartedAt: verified ? configuredAt : null,
        metadata: {
          provider: "microsoft_graph",
          action: "activated",
          actorId: input.actorId,
          authorityDecisionId: access.authorityDecisionId,
          permissionMode: input.permissionMode,
          effectiveAccessVerified: verified,
          leastPrivilegeCertified: probe.leastPrivilegeCertified,
        },
      });
      await db.insert(connectionEvents).values({
        tenantId: input.tenantId,
        authProfileId: integration.authProfileId,
        actorId: input.actorId,
        eventType: verified ? "permission_verified" : "degraded",
        fromStatus: "active",
        toStatus: verified ? "active" : "degraded",
        reasonCode: verified ? undefined : "source_effective_access_failed",
        traceId: input.traceId,
        metadata: {
          sourceScopeId,
          sourceKind: input.sourceKind,
          providerResourceId: identity.providerResourceId,
          permissionMode: input.permissionMode,
          effectiveAccessVerified: verified,
          leastPrivilegeCertified: probe.leastPrivilegeCertified,
          authorityDecisionId: access.authorityDecisionId,
        },
      });
      await db.update(tenantIntegrations).set({
        health: verified ? "ok" : "degraded",
        syncStatus: verified ? "initializing" : "blocked",
        reconciliationStatus: verified ? "healthy" : "blocked",
        lastCheckAt: configuredAt,
        lastError: verified ? null : "Microsoft source effective-access verification failed",
        updatedAt: configuredAt,
      }).where(and(eq(tenantIntegrations.tenantId, input.tenantId), eq(tenantIntegrations.id, integration.id)));
      if (verified) {
        const subscriptionRequired = descriptor.supportsChangeNotifications;
        await db.insert(jobs).values({
          type: subscriptionRequired ? "maintain_integration_subscriptions" : "sync_source",
          payload: {
            tenantId: input.tenantId,
            integrationId: integration.id,
            sourceScopeId,
            scope: scopeKey,
            reason: "source_activated",
            ...(input.traceId ? { _correlationId: input.traceId } : {}),
          },
          lane: "batch",
          priority: subscriptionRequired ? 25 : 20,
          idempotencyKey: `m365-source-activated:${sourceScopeId}:${coverage.revision}`,
        }).onConflictDoNothing({ target: jobs.idempotencyKey });
      }
      return {
        sourceScopeId,
        scopeKey,
        sourceKind: input.sourceKind,
        status: verified ? "initializing" as const : "blocked_permission" as const,
        permissionVerification: probe,
        coverageRevision: coverage.revision,
        subscriptionRequired: descriptor.supportsChangeNotifications,
      };
    });
  } catch (error) {
    if (isTranscriptAccessDisabled(error)) {
      throw new Microsoft365AdministrationError("transcript_api_disabled", "Microsoft tenant transcript API access is disabled", 409);
    }
    throw mapAdministrationError(error);
  }
}

export async function disableMicrosoft365Source(input: {
  tenantId: string;
  actorId: string;
  sourceScopeId: string;
  traceId?: string;
}): Promise<{ sourceScopeId: string; status: "disabled"; coverageRevision: number; retainedHistory: true }> {
  try {
    const sourceScopeId = normalizedUuid(input.sourceScopeId, "source scope ID");
    const loaded = await withTenantTransaction(input.tenantId, { userId: input.actorId, readOnly: true }, async (_db, client) => {
      const result = await client.query<{
        integration_id: string;
        auth_profile_id: string;
        auth_profile_ref: string;
        source_kind: Microsoft365SourceKind;
        recovery_strategy: "EXACT_DELTA" | "BOUNDED_RECONCILIATION" | "BEST_EFFORT_NOTIFICATION_RECOVERY";
        coverage_policy: JsonObject;
        scope_key: string;
        enabled: boolean;
      }>(
        `SELECT s.integration_id,i.auth_profile_id,p.auth_profile_ref,s.source_kind,s.recovery_strategy,
                s.coverage_policy,s.scope_key,s.enabled
           FROM finnor_os.integration_source_scopes s
           JOIN finnor_os.tenant_integrations i ON i.tenant_id=s.tenant_id AND i.id=s.integration_id
           JOIN finnor_os.auth_profiles p ON p.tenant_id=i.tenant_id AND p.id=i.auth_profile_id
          WHERE s.tenant_id=$1::uuid AND s.id=$2::uuid AND s.provider='microsoft_graph' AND i.binding='microsoft_graph'`,
        [input.tenantId, sourceScopeId],
      );
      return result.rows[0] ?? null;
    });
    if (!loaded || !loaded.auth_profile_id) throw new Microsoft365AdministrationError("source_not_found", "Microsoft source scope was not found", 404);
    await authorizeAuthProfileConnection(input.tenantId, input.actorId, "microsoft_graph", loaded.auth_profile_ref);
    const access = await authorizeIntegrationAdministration(input.tenantId, input.actorId, loaded.integration_id);
    const disabledAt = new Date();
    return await withTenantTransaction(input.tenantId, { userId: input.actorId }, async (db, client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5116))", [`${input.tenantId}:${loaded.integration_id}:${loaded.scope_key}`]);
      const changed = await client.query<{ id: string }>(
        `UPDATE finnor_os.integration_source_scopes
            SET enabled=false,disabled_at=$3,permission_verified_at=NULL,effective_permissions='{}'::text[],
                freshness_state='unknown',
                metadata=metadata || $4::jsonb,updated_at=clock_timestamp()
          WHERE tenant_id=$1::uuid AND id=$2::uuid
          RETURNING id`,
        [input.tenantId, sourceScopeId, disabledAt, JSON.stringify({
          lastConfigurationAudit: {
            action: "disabled",
            actorId: input.actorId,
            authorityDecisionId: access.authorityDecisionId,
            at: disabledAt.toISOString(),
          },
        })],
      );
      if (!changed.rows[0]) throw new Microsoft365AdministrationError("source_not_found", "Microsoft source scope was not found", 404);
      const coverage = await appendSourceCoverageTx(db, {
        tenantId: input.tenantId,
        sourceScopeId,
        sourceKind: loaded.source_kind,
        state: "DISABLED",
        recoveryStrength: loaded.recovery_strategy,
        region: object(loaded.coverage_policy),
        effectiveFrom: disabledAt,
        reason: "Microsoft source scope disabled by an authorized administrator",
        metadata: {
          provider: "microsoft_graph",
          action: "disabled",
          actorId: input.actorId,
          authorityDecisionId: access.authorityDecisionId,
        },
      });
      await db.insert(connectionEvents).values({
        tenantId: input.tenantId,
        authProfileId: loaded.auth_profile_id,
        actorId: input.actorId,
        eventType: "disabled",
        fromStatus: "active",
        toStatus: "active",
        reasonCode: "source_scope_disabled",
        traceId: input.traceId,
        metadata: { sourceScopeId, sourceKind: loaded.source_kind, authorityDecisionId: access.authorityDecisionId },
      });
      await db.insert(jobs).values({
        type: "maintain_integration_subscriptions",
        payload: {
          tenantId: input.tenantId,
          integrationId: loaded.integration_id,
          sourceScopeId,
          scope: loaded.scope_key,
          reason: "source_disabled",
          ...(input.traceId ? { _correlationId: input.traceId } : {}),
        },
        lane: "batch",
        priority: 30,
        idempotencyKey: `m365-source-disabled:${sourceScopeId}:${coverage.revision}`,
      }).onConflictDoNothing({ target: jobs.idempotencyKey });
      return { sourceScopeId, status: "disabled" as const, coverageRevision: coverage.revision, retainedHistory: true as const };
    });
  } catch (error) {
    throw mapAdministrationError(error);
  }
}

export async function getMicrosoftGraphConnectionStatus(input: {
  tenantId: string;
  authProfileRef?: string;
}): Promise<{ connections: Array<Record<string, unknown>>; summary: Record<string, number> }> {
  try {
    const result = await withTenantTransaction(input.tenantId, { readOnly: true }, async (_db, client) => {
      const params: unknown[] = [input.tenantId];
      const profileFilter = input.authProfileRef
        ? (params.push(boundedString(input.authProfileRef, "auth profile reference", 128)), `AND p.auth_profile_ref=$${params.length}`)
        : "";
      const rows = await client.query<{
        profile_id: string;
        auth_profile_ref: string;
        auth_method: string;
        connection_status: string;
        connection_revision: number;
        required_scopes: string[];
        granted_scopes: string[];
        provider_subject_ref: string | null;
        connected_at: Date | null;
        last_verified_at: Date | null;
        last_connection_error_code: string | null;
        account_id: string;
        provider_account_ref: string | null;
        account_metadata: JsonObject;
        profile_scope: JsonObject;
        restrictions: JsonObject;
        integration_id: string;
        capability: string;
        health: string;
        sync_status: string;
        freshness_state: string;
        webhook_status: string;
        reconciliation_status: string;
        last_successful_sync_at: Date | null;
        last_observed_at: Date | null;
        source_lag_ms: number | null;
        unresolved_conflicts: number;
        consent_status: string | null;
        consent_requested_at: Date | null;
        consent_returned_directory: string | null;
        permission_verification: JsonObject | null;
      }>(
        `SELECT p.id profile_id,p.auth_profile_ref,p.auth_method,p.connection_status,p.connection_revision,
                p.required_scopes,p.granted_scopes,p.provider_subject_ref,p.connected_at,p.last_verified_at,p.last_connection_error_code,
                a.id account_id,a.provider_account_ref,a.metadata account_metadata,p.scope profile_scope,p.restrictions,
                i.id integration_id,i.capability,i.health,i.sync_status,i.freshness_state,i.webhook_status,
                i.reconciliation_status,i.last_successful_sync_at,i.last_observed_at,i.source_lag_ms,i.unresolved_conflicts,
                consent.status consent_status,consent.created_at consent_requested_at,
                consent.returned_directory_tenant_id consent_returned_directory,
                consent.permission_verification
           FROM finnor_os.auth_profiles p
           JOIN finnor_os.application_accounts a
             ON a.tenant_id=p.tenant_id AND a.id=p.application_account_id
           JOIN finnor_os.tenant_integrations i
             ON i.tenant_id=p.tenant_id AND i.auth_profile_id=p.id AND i.application_account_id=a.id
           LEFT JOIN LATERAL (
             SELECT status,created_at,returned_directory_tenant_id,permission_verification
               FROM finnor_os.application_consent_requests c
              WHERE c.tenant_id=p.tenant_id AND c.auth_profile_id=p.id
              ORDER BY c.created_at DESC LIMIT 1
           ) consent ON true
          WHERE p.tenant_id=$1::uuid AND a.provider='microsoft_graph' AND i.binding='microsoft_graph'
            ${profileFilter}
          ORDER BY p.auth_profile_ref,i.capability`,
        params,
      );
      const sourceCounts = await client.query<{
        profile_id: string;
        total: number;
        enabled: number;
        verified: number;
        blocked: number;
      }>(
        `SELECT i.auth_profile_id profile_id,count(s.id)::int total,
                count(s.id) FILTER (WHERE s.enabled)::int enabled,
                count(s.id) FILTER (WHERE s.enabled AND s.permission_verified_at IS NOT NULL)::int verified,
                count(s.id) FILTER (WHERE s.enabled AND s.permission_verified_at IS NULL)::int blocked
           FROM finnor_os.tenant_integrations i
           LEFT JOIN finnor_os.integration_source_scopes s
             ON s.tenant_id=i.tenant_id AND s.integration_id=i.id
          WHERE i.tenant_id=$1::uuid AND i.binding='microsoft_graph'
          GROUP BY i.auth_profile_id`,
        [input.tenantId],
      );
      return { rows: rows.rows, counts: new Map(sourceCounts.rows.map((row) => [row.profile_id, row])) };
    });
    const grouped = new Map<string, typeof result.rows>();
    for (const row of result.rows) grouped.set(row.profile_id, [...(grouped.get(row.profile_id) ?? []), row]);
    const connections = [...grouped.values()].map((rows) => {
      const row = rows[0]!;
      const account = object(row.account_metadata);
      const profileScope = object(row.profile_scope);
      const restrictions = object(row.restrictions);
      const counts = result.counts.get(row.profile_id);
      return {
        authProfileRef: row.auth_profile_ref,
        applicationAccountId: row.account_id,
        provider: "microsoft_graph",
        directoryTenantId: account.directoryTenantId ?? row.provider_account_ref,
        applicationClientId: account.applicationClientId ?? null,
        cloud: account.cloud ?? "global",
        authKind: row.auth_method === "workload_identity" ? "federated_workload" : "managed_certificate",
        authConfiguration: row.auth_method === "workload_identity" ? {
          awsRegion: profileScope.awsRegion ?? null,
          federationConfigId: profileScope.federationConfigId ?? null,
          signingAlgorithm: profileScope.signingAlgorithm ?? null,
        } : { certificateFallback: restrictions.certificateFallback === true },
        status: row.connection_status,
        usable: row.connection_status === "active",
        connectionRevision: row.connection_revision,
        requestedPermissions: row.required_scopes,
        effectivePermissions: row.granted_scopes,
        servicePrincipalObjectId: row.provider_subject_ref,
        connectedAt: row.connected_at?.toISOString() ?? null,
        lastVerifiedAt: row.last_verified_at?.toISOString() ?? null,
        lastErrorCode: row.last_connection_error_code,
        consent: {
          status: row.consent_status ?? "not_requested",
          requestedAt: row.consent_requested_at?.toISOString() ?? null,
          returnedDirectoryTenantId: row.consent_returned_directory,
          permissionVerification: row.permission_verification ?? {},
        },
        capabilityBindings: rows.map((integration) => ({
          integrationId: integration.integration_id,
          capability: integration.capability,
          health: integration.health,
          syncStatus: integration.sync_status,
          freshness: integration.freshness_state,
          webhook: integration.webhook_status,
          reconciliation: integration.reconciliation_status,
          lastSuccessfulSyncAt: integration.last_successful_sync_at?.toISOString() ?? null,
          lastObservedAt: integration.last_observed_at?.toISOString() ?? null,
          sourceLagMs: integration.source_lag_ms === null ? null : Number(integration.source_lag_ms),
          unresolvedConflicts: integration.unresolved_conflicts,
        })),
        sourceScopes: {
          total: counts?.total ?? 0,
          enabled: counts?.enabled ?? 0,
          permissionVerified: counts?.verified ?? 0,
          blocked: counts?.blocked ?? 0,
        },
      };
    });
    return {
      connections,
      summary: {
        total: connections.length,
        active: connections.filter((row) => row.status === "active").length,
        degraded: connections.filter((row) => row.status === "degraded").length,
        blocked: connections.filter((row) => !["active", "degraded"].includes(String(row.status))).length,
      },
    };
  } catch (error) {
    throw mapAdministrationError(error);
  }
}

type CoverageReadRow = {
  source_scope_id: string;
  integration_id: string;
  source_kind: Microsoft365SourceKind;
  provider_scope_type: string;
  provider_resource_id: string;
  provider_parent_id: string | null;
  scope_key: string;
  enabled: boolean;
  root_binding_type: RootType | null;
  root_binding_id: string | null;
  permission_mode: MicrosoftPermissionMode;
  required_permissions: string[];
  effective_permissions: string[];
  provider_restriction_method: string | null;
  permission_verified_at: Date | null;
  configuration: JsonObject;
  freshness_policy: JsonObject;
  freshness_state: string;
  last_successful_sync_at: Date | null;
  last_observed_at: Date | null;
  disabled_at: Date | null;
  configured_by: string;
  configured_at: Date;
  metadata: JsonObject;
  coverage_revision: number | null;
  coverage_recorded_at: Date | null;
  coverage_effective_from: Date | null;
  coverage_effective_to: Date | null;
  coverage_region: JsonObject | null;
  coverage_state: SourceCoverageState | null;
  coverage_reason: string | null;
  baseline_started_at: Date | null;
  baseline_completed_at: Date | null;
  earliest_provider_at: Date | null;
  latest_provider_at: Date | null;
  unresolved_observations: number | null;
  ambiguous_observations: number | null;
  source_descriptor: JsonObject | null;
  recovery_strength: string;
  subscription_status: string | null;
  subscription_expiration_at: Date | null;
  subscription_renew_at: Date | null;
  subscription_recovery_state: string | null;
  integration_health: string;
  integration_sync_status: string;
  integration_freshness_state: string;
  integration_reconciliation_status: string;
  source_last_observed_at: Date | null;
};

function descriptorDate(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function coverageProjection(row: CoverageReadRow, asOf: Date, historical: boolean): Record<string, unknown> {
  const descriptor = object(row.source_descriptor);
  const descriptorAvailable = Object.keys(descriptor).length > 0;
  const historicalValue = <T>(key: string, current: T, fallback: T): T => historical
    ? (descriptorAvailable && descriptor[key] !== undefined ? descriptor[key] as T : fallback)
    : current;
  const enabled = historicalValue("enabled", row.enabled, row.coverage_state !== "DISABLED");
  const rootBindingType = historicalValue<RootType | null>("rootBindingType", row.root_binding_type, null);
  const rootBindingId = historicalValue<string | null>("rootBindingId", row.root_binding_id, null);
  const freshnessState = historicalValue("freshnessState", row.freshness_state, "unknown");
  const lastSuccessfulSyncAt = historical
    ? descriptorDate(descriptor.lastSuccessfulSyncAt)
    : row.last_successful_sync_at?.toISOString() ?? null;
  const lastObservedAt = historical
    ? (descriptorDate(descriptor.lastObservedAt) ?? row.source_last_observed_at?.toISOString() ?? null)
    : row.last_observed_at?.toISOString() ?? null;
  return {
    sourceScopeId: row.source_scope_id,
    integrationId: row.integration_id,
    provider: "microsoft_graph",
    sourceKind: row.source_kind,
    providerScopeType: historicalValue("providerScopeType", row.provider_scope_type, "historical_descriptor_unavailable"),
    providerResourceId: historicalValue<string | null>("providerResourceId", row.provider_resource_id, null),
    providerParentId: historicalValue<string | null>("providerParentId", row.provider_parent_id, null),
    scopeKey: historicalValue("scopeKey", row.scope_key, row.scope_key),
    enabled,
    rootBinding: rootBindingType && rootBindingId ? { type: rootBindingType, id: rootBindingId } : null,
    permission: {
      mode: historicalValue("permissionMode", row.permission_mode, null),
      required: historicalValue("requiredPermissions", row.required_permissions, [] as string[]),
      effective: historicalValue("effectivePermissions", row.effective_permissions, [] as string[]),
      providerRestrictionMethod: historicalValue<string | null>("providerRestrictionMethod", row.provider_restriction_method, null),
      verifiedAt: historical ? descriptorDate(descriptor.permissionVerifiedAt) : row.permission_verified_at?.toISOString() ?? null,
      certification: historical ? {} : object(row.metadata).permissionCertification ?? {},
    },
    configuration: historicalValue("configuration", row.configuration, {} as JsonObject),
    configuredBy: historicalValue<string | null>("configuredBy", row.configured_by, null),
    configuredAt: historical ? descriptorDate(descriptor.configuredAt) : row.configured_at.toISOString(),
    disabledAt: historical ? descriptorDate(descriptor.disabledAt) : row.disabled_at?.toISOString() ?? null,
    freshness: {
      state: freshnessState,
      policy: historicalValue("freshnessPolicy", row.freshness_policy, {} as JsonObject),
      lastSuccessfulSyncAt,
      lastObservedAt,
    },
    coverage: row.coverage_state ? {
      revision: row.coverage_revision,
      state: row.coverage_state,
      recoveryStrength: historicalValue("recoveryStrength", row.recovery_strength, "UNKNOWN"),
      region: row.coverage_region ?? {},
      reason: row.coverage_reason,
      recordedAt: row.coverage_recorded_at?.toISOString() ?? null,
      effectiveFrom: row.coverage_effective_from?.toISOString() ?? null,
      effectiveTo: row.coverage_effective_to?.toISOString() ?? null,
      baselineStartedAt: row.baseline_started_at?.toISOString() ?? null,
      baselineCompletedAt: row.baseline_completed_at?.toISOString() ?? null,
      earliestProviderAt: row.earliest_provider_at?.toISOString() ?? null,
      latestProviderAt: row.latest_provider_at?.toISOString() ?? null,
      unresolvedObservations: row.unresolved_observations ?? 0,
      ambiguousObservations: row.ambiguous_observations ?? 0,
    } : {
      revision: null,
      state: "NOT_CONFIGURED",
      recoveryStrength: row.recovery_strength,
      region: {},
      reason: "No source coverage fact existed at the requested FINNOR knowledge time",
      recordedAt: null,
      effectiveFrom: null,
      effectiveTo: null,
      baselineStartedAt: null,
      baselineCompletedAt: null,
      earliestProviderAt: null,
      latestProviderAt: null,
      unresolvedObservations: 0,
      ambiguousObservations: 0,
    },
    subscription: historical ? {
      status: "NOT_HISTORICALLY_PROJECTED",
      expirationAt: null,
      renewAt: null,
      recoveryState: "unknown",
    } : {
      status: row.subscription_status ?? (enabled ? "not_provisioned" : "disabled"),
      expirationAt: row.subscription_expiration_at?.toISOString() ?? null,
      renewAt: row.subscription_renew_at?.toISOString() ?? null,
      recoveryState: row.subscription_recovery_state ?? "none",
    },
    integrationHealth: historical ? {
      health: "NOT_HISTORICALLY_PROJECTED",
      syncStatus: "unknown",
      freshness: freshnessState,
      reconciliation: "unknown",
    } : {
      health: row.integration_health,
      syncStatus: row.integration_sync_status,
      freshness: row.integration_freshness_state,
      reconciliation: row.integration_reconciliation_status,
    },
    historicalProjection: historical,
    descriptorAvailable: !historical || descriptorAvailable,
    asOf: asOf.toISOString(),
  };
}

async function queryMicrosoftCoverage(input: {
  tenantId: string;
  at?: string;
  sourceScopeId?: string;
  rootBinding?: { type: RootType; id: string };
  includeDisabled?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<{ rows: CoverageReadRow[]; asOf: Date; nextCursor: string | null }> {
  const asOf = input.at ? new Date(input.at) : new Date();
  const historical = input.at !== undefined;
  if (!Number.isFinite(asOf.getTime())) throw new Microsoft365AdministrationError("invalid_as_of", "Coverage as-of timestamp is invalid");
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
  const values: unknown[] = [input.tenantId, asOf, limit + 1];
  const clauses = ["s.tenant_id=$1::uuid", "s.provider='microsoft_graph'"];
  if (input.sourceScopeId) {
    values.push(normalizedUuid(input.sourceScopeId, "source scope ID"));
    clauses.push(`s.id=$${values.length}::uuid`);
  }
  if (input.rootBinding) {
    if (!ROOT_TYPES.has(input.rootBinding.type)) throw new Microsoft365AdministrationError("invalid_root", "Coverage root type is unsupported");
    values.push(normalizedUuid(input.rootBinding.id, "coverage root ID"));
    if (historical) {
      clauses.push(`coalesce(nullif(coverage.source_descriptor->>'rootBindingType',''),CASE WHEN s.updated_at<=$2 THEN s.root_binding_type END)='${input.rootBinding.type}'`);
      clauses.push(`coalesce(nullif(coverage.source_descriptor->>'rootBindingId',''),CASE WHEN s.updated_at<=$2 THEN s.root_binding_id::text END)=$${values.length}::text`);
    } else {
      clauses.push(`s.root_binding_type='${input.rootBinding.type}'`);
      clauses.push(`s.root_binding_id=$${values.length}::uuid`);
    }
  }
  if (input.includeDisabled !== true && !input.at) clauses.push("s.enabled");
  if (historical) clauses.push("(coverage.source_scope_id IS NOT NULL OR (s.configured_at<=$2 AND s.updated_at<=$2))");
  if (input.cursor) {
    values.push(normalizedUuid(input.cursor, "coverage cursor"));
    clauses.push(`s.id>$${values.length}::uuid`);
  }
  return withTenantTransaction(input.tenantId, { readOnly: true }, async (_db, client) => {
    const result = await client.query<CoverageReadRow>(
      `SELECT s.id source_scope_id,s.integration_id,s.source_kind,s.provider_scope_type,s.provider_resource_id,
              s.provider_parent_id,s.scope_key,s.enabled,s.root_binding_type,s.root_binding_id,s.permission_mode,
              s.required_permissions,s.effective_permissions,s.provider_restriction_method,s.permission_verified_at,
              s.configuration,s.freshness_policy,s.freshness_state,s.last_successful_sync_at,s.last_observed_at,
              s.disabled_at,s.configured_by,s.configured_at,s.metadata,s.recovery_strategy recovery_strength,
              coverage.coverage_revision,coverage.recorded_at coverage_recorded_at,
              coverage.effective_from coverage_effective_from,coverage.effective_to coverage_effective_to,
              coverage.coverage_region,coverage.state coverage_state,coverage.reason coverage_reason,
              coverage.baseline_started_at,coverage.baseline_completed_at,coverage.earliest_provider_at,
              coverage.latest_provider_at,coverage.unresolved_observations,coverage.ambiguous_observations,
              coverage.source_descriptor,
              subscription.status subscription_status,subscription.expiration_at subscription_expiration_at,
              subscription.renew_at subscription_renew_at,subscription.recovery_state subscription_recovery_state,
              i.health integration_health,i.sync_status integration_sync_status,
              i.freshness_state integration_freshness_state,i.reconciliation_status integration_reconciliation_status,
              source_observation.last_observed_at source_last_observed_at
         FROM finnor_os.integration_source_scopes s
         JOIN finnor_os.tenant_integrations i ON i.tenant_id=s.tenant_id AND i.id=s.integration_id
         LEFT JOIN LATERAL (
           SELECT c.* FROM finnor_os.integration_source_coverage_history c
            WHERE c.tenant_id=s.tenant_id AND c.source_scope_id=s.id
              AND c.effective_from<=$2 AND c.recorded_at<=$2
              AND (c.effective_to IS NULL OR c.effective_to>$2)
            ORDER BY c.coverage_revision DESC LIMIT 1
         ) coverage ON true
         LEFT JOIN LATERAL (
           SELECT sub.status,sub.expiration_at,sub.renew_at,sub.recovery_state
             FROM finnor_os.integration_subscriptions sub
            WHERE sub.tenant_id=s.tenant_id AND sub.source_scope_id=s.id
              AND sub.created_at<=$2
            ORDER BY sub.created_at DESC LIMIT 1
         ) subscription ON true
         LEFT JOIN LATERAL (
           SELECT max(observation.retrieved_at) last_observed_at
             FROM finnor_os.external_ref_observations observation
            WHERE observation.tenant_id=s.tenant_id AND observation.source_scope_id=s.id
              AND observation.retrieved_at<=$2 AND observation.received_at<=$2
         ) source_observation ON true
        WHERE ${clauses.join(" AND ")}
        ORDER BY s.id
        LIMIT $3`,
      values,
    );
    const page = result.rows.slice(0, limit);
    return { rows: page, asOf, nextCursor: result.rows.length > limit ? page[page.length - 1]!.source_scope_id : null };
  });
}

export async function listMicrosoft365SourceScopes(input: {
  tenantId: string;
  includeDisabled?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<{ sourceScopes: Array<Record<string, unknown>>; nextCursor: string | null }> {
  try {
    const result = await queryMicrosoftCoverage(input);
    return { sourceScopes: result.rows.map((row) => coverageProjection(row, result.asOf, false)), nextCursor: result.nextCursor };
  } catch (error) {
    throw mapAdministrationError(error);
  }
}

export async function getMicrosoft365SourceScopeStatus(input: {
  tenantId: string;
  sourceScopeId: string;
  at?: string;
}): Promise<Record<string, unknown>> {
  try {
    const result = await queryMicrosoftCoverage({ ...input, includeDisabled: true, limit: 1 });
    const row = result.rows[0];
    if (!row) throw new Microsoft365AdministrationError("source_not_found", "Microsoft source scope was not found", 404);
    return coverageProjection(row, result.asOf, input.at !== undefined);
  } catch (error) {
    throw mapAdministrationError(error);
  }
}

export async function readMicrosoft365Coverage(input: {
  tenantId: string;
  at?: string;
  sourceScopeId?: string;
  rootBinding?: { type: RootType; id: string };
  includeDisabled?: boolean;
  limit?: number;
  cursor?: string;
}): Promise<{
  asOf: string;
  sourceCoverage: Array<Record<string, unknown>>;
  coverageWarnings: string[];
  unresolvedProviderObservations: number;
  ambiguousProviderObservations: number;
  lastSourceObservationAt: string | null;
  integrationHealth: Record<string, unknown>;
  nextCursor: string | null;
}> {
  try {
    const result = await queryMicrosoftCoverage(input);
    const historical = input.at !== undefined;
    const sourceCoverage = result.rows.map((row) => coverageProjection(row, result.asOf, historical));
    const warningStates = new Set(["INITIALIZING", "PARTIAL", "RECOVERING", "BLOCKED_AUTH", "BLOCKED_PERMISSION", "HISTORY_LIMITED", "NOT_CONFIGURED", "DISABLED"]);
    const warnings = sourceCoverage.flatMap((scope) => {
      const coverage = object(scope.coverage);
      const state = String(coverage.state ?? "NOT_CONFIGURED");
      return warningStates.has(state) ? [`${String(scope.sourceKind)}:${state}`] : [];
    });
    const unresolved = result.rows.reduce((sum, row) => sum + Number(row.unresolved_observations ?? 0), 0);
    const ambiguous = result.rows.reduce((sum, row) => sum + Number(row.ambiguous_observations ?? 0), 0);
    const lastObserved = result.rows.map((row) => historical ? row.source_last_observed_at : row.last_observed_at).filter((value): value is Date => Boolean(value))
      .sort((left, right) => right.getTime() - left.getTime())[0] ?? null;
    return {
      asOf: result.asOf.toISOString(),
      sourceCoverage,
      coverageWarnings: [...new Set(warnings)].sort(),
      unresolvedProviderObservations: unresolved,
      ambiguousProviderObservations: ambiguous,
      lastSourceObservationAt: lastObserved?.toISOString() ?? null,
      integrationHealth: Object.fromEntries(result.rows.map((row) => [row.integration_id, historical ? {
        health: "NOT_HISTORICALLY_PROJECTED",
        syncStatus: "unknown",
        freshness: object(row.source_descriptor).freshnessState ?? "unknown",
        reconciliation: "unknown",
      } : {
        health: row.integration_health,
        syncStatus: row.integration_sync_status,
        freshness: row.integration_freshness_state,
        reconciliation: row.integration_reconciliation_status,
      }])),
      nextCursor: result.nextCursor,
    };
  } catch (error) {
    throw mapAdministrationError(error);
  }
}

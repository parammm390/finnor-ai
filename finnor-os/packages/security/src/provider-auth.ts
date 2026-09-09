import { applicationAccounts, authProfiles, connectionEvents, tenantIntegrations, withTenant } from "@finnor/db";
import { and, eq, sql } from "drizzle-orm";
import { resolveTenantBoundSecretBundle } from "./tenant-credentials";
import { writeAwsSecretReference } from "./secrets";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProviderAuthError extends Error {
  constructor(
    readonly code: "blocked_config" | "blocked_auth" | "blocked_permission",
    message: string,
  ) {
    super(message);
    this.name = "ProviderAuthError";
  }
}

interface MicrosoftProviderAuthBase {
  readonly tenantId: string;
  readonly integrationId: string;
  readonly provider: "microsoft_graph";
  readonly authProfileId: string;
  readonly authProfileRef: string;
  readonly connectionRevision: number;
  readonly directoryTenantId: string;
  readonly applicationClientId: string;
  readonly cloud: "global";
  readonly requiredPermissions: readonly string[];
  readonly consentedPermissions: readonly string[];
  readonly cacheKey: string;
}

export interface FederatedWorkloadAuthContext extends MicrosoftProviderAuthBase {
  readonly kind: "federated_workload";
  readonly awsRegion: string;
  readonly federationAudience: string;
  readonly federationConfigId: string;
  readonly signingAlgorithm: "ES384" | "RS256";
  readonly identityTokenDurationSeconds: number;
}

/** Runtime-only certificate material loaded through the existing tenant-secret
 * boundary. It must never enter logs, jobs, database rows, Evidence, or events. */
export interface ManagedCertificateAuthContext extends MicrosoftProviderAuthBase {
  readonly kind: "managed_certificate";
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly certificateThumbprint?: string;
}

export type ProviderAuthContext = FederatedWorkloadAuthContext | ManagedCertificateAuthContext;

/** A separate employee-bound OAuth profile used only for Office file writes and
 * Excel workbook sessions. This never replaces or mutates the P2 app-only profile. */
export interface MicrosoftDelegatedAuthContext {
  readonly kind: "delegated_user";
  readonly tenantId: string;
  readonly provider: "microsoft_graph";
  readonly authProfileId: string;
  readonly authProfileRef: string;
  readonly principalId: string;
  readonly connectionRevision: number;
  readonly directoryTenantId: string;
  readonly applicationClientId: string;
  readonly cloud: "global";
  readonly requiredPermissions: readonly string[];
  readonly consentedPermissions: readonly string[];
  readonly cacheKey: string;
  readonly accessToken?: string;
  readonly accessTokenExpiresAt?: string;
  readonly refreshToken: string;
  readonly persistTokens: (tokens: { accessToken: string; expiresAt: string; refreshToken?: string }) => Promise<void>;
  readonly markReauthorizationRequired: (reasonCode: string) => Promise<void>;
}

export type MicrosoftGraphAuthContext = ProviderAuthContext | MicrosoftDelegatedAuthContext;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))].sort()
    : [];
}

function requireUuid(value: unknown, label: string): string {
  const resolved = string(value);
  if (!resolved || !UUID.test(resolved)) throw new ProviderAuthError("blocked_config", `${label} is missing or invalid`);
  return resolved.toLowerCase();
}

function requireGlobalCloud(value: unknown): "global" {
  const cloud = string(value) ?? "global";
  if (cloud !== "global") throw new ProviderAuthError("blocked_config", `Microsoft cloud ${cloud} is not certified by this release`);
  return "global";
}

/**
 * Resolve one exact FINNOR tenant -> integration -> application account -> auth
 * profile chain. Browser/query/provider payload values are never accepted here.
 */
export async function resolveMicrosoftProviderAuthContext(input: {
  tenantId: string;
  integrationId: string;
  allowConnecting?: boolean;
}): Promise<ProviderAuthContext> {
  const [row] = await withTenant(input.tenantId, (db) => db.select({
    integrationId: tenantIntegrations.id,
    integrationBinding: tenantIntegrations.binding,
    integrationMode: tenantIntegrations.mode,
    integrationAccountId: tenantIntegrations.applicationAccountId,
    integrationProfileId: tenantIntegrations.authProfileId,
    accountId: applicationAccounts.id,
    accountProvider: applicationAccounts.provider,
    accountStatus: applicationAccounts.status,
    providerAccountRef: applicationAccounts.providerAccountRef,
    accountMetadata: applicationAccounts.metadata,
    profileId: authProfiles.id,
    profileRef: authProfiles.authProfileRef,
    profileStatus: authProfiles.status,
    authMethod: authProfiles.authMethod,
    credentialProvider: authProfiles.credentialProvider,
    credentialRef: authProfiles.credentialRef,
    credentialVersion: authProfiles.credentialVersion,
    connectionStatus: authProfiles.connectionStatus,
    connectionRevision: authProfiles.connectionRevision,
    requiredScopes: authProfiles.requiredScopes,
    grantedScopes: authProfiles.grantedScopes,
    profileScope: authProfiles.scope,
    restrictions: authProfiles.restrictions,
  }).from(tenantIntegrations).innerJoin(applicationAccounts, and(
    eq(applicationAccounts.tenantId, input.tenantId),
    eq(applicationAccounts.id, tenantIntegrations.applicationAccountId),
  )).innerJoin(authProfiles, and(
    eq(authProfiles.tenantId, input.tenantId),
    eq(authProfiles.id, tenantIntegrations.authProfileId),
    eq(authProfiles.applicationAccountId, applicationAccounts.id),
  )).where(and(
    eq(tenantIntegrations.tenantId, input.tenantId),
    eq(tenantIntegrations.id, input.integrationId),
  )).limit(1));

  if (!row || row.integrationBinding !== "microsoft_graph" || row.accountProvider !== "microsoft_graph") {
    throw new ProviderAuthError("blocked_config", "Microsoft integration account/auth-profile binding is missing or inconsistent");
  }
  if (row.integrationMode !== "real") throw new ProviderAuthError("blocked_config", "Microsoft provider truth requires a real integration binding");
  if (row.integrationAccountId !== row.accountId || row.integrationProfileId !== row.profileId) {
    throw new ProviderAuthError("blocked_config", "Microsoft integration crosses its configured application account or auth profile");
  }
  const permittedStatus = row.connectionStatus === "active" || (input.allowConnecting && row.connectionStatus === "connecting");
  if (row.accountStatus !== "active" || row.profileStatus !== "active" || !permittedStatus) {
    throw new ProviderAuthError("blocked_auth", "Microsoft application account/auth profile is not active");
  }

  const account = object(row.accountMetadata);
  const scope = object(row.profileScope);
  const restrictions = object(row.restrictions);
  const directoryTenantId = requireUuid(account.directoryTenantId ?? row.providerAccountRef, "Microsoft directory tenant ID");
  const applicationClientId = requireUuid(account.applicationClientId, "Microsoft application client ID");
  const cloud = requireGlobalCloud(account.cloud);
  const requiredPermissions = strings(row.requiredScopes);
  const consentedPermissions = strings(row.grantedScopes);
  const base = Object.freeze({
    tenantId: input.tenantId,
    integrationId: row.integrationId,
    provider: "microsoft_graph" as const,
    authProfileId: row.profileId,
    authProfileRef: row.profileRef,
    connectionRevision: row.connectionRevision,
    directoryTenantId,
    applicationClientId,
    cloud,
    requiredPermissions: Object.freeze(requiredPermissions),
    consentedPermissions: Object.freeze(consentedPermissions),
    cacheKey: `${input.tenantId}:${row.profileId}:${row.connectionRevision}:${directoryTenantId}:${applicationClientId}`,
  });

  if (row.authMethod === "workload_identity") {
    if (row.credentialProvider !== "aws-iam-federated" || row.credentialRef || row.credentialVersion) {
      throw new ProviderAuthError("blocked_config", "Microsoft workload identity profile has a secret-bearing or mismatched credential contract");
    }
    const runtimeRegion = string(process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION);
    const configuredRegion = string(scope.awsRegion);
    if (!runtimeRegion && !configuredRegion) throw new ProviderAuthError("blocked_config", "The AWS selected Region is not configured for workload federation");
    if (runtimeRegion && configuredRegion && runtimeRegion !== configuredRegion) {
      throw new ProviderAuthError("blocked_config", "The Microsoft workload profile Region does not match the AWS runtime selected Region");
    }
    const awsRegion = configuredRegion ?? runtimeRegion!;
    const federationAudience = string(scope.federationAudience);
    const federationConfigId = string(scope.federationConfigId);
    if (!federationAudience || !federationConfigId) {
      throw new ProviderAuthError("blocked_config", "Microsoft workload federation audience/configuration identity is missing");
    }
    const signingAlgorithm = string(scope.signingAlgorithm);
    if (signingAlgorithm !== "ES384" && signingAlgorithm !== "RS256") {
      throw new ProviderAuthError("blocked_config", "Microsoft workload signing algorithm must be ES384 or RS256");
    }
    const configuredDuration = Number(scope.identityTokenDurationSeconds ?? 300);
    if (!Number.isSafeInteger(configuredDuration) || configuredDuration < 60 || configuredDuration > 3600) {
      throw new ProviderAuthError("blocked_config", "AWS web identity token duration must be between 60 and 3600 seconds");
    }
    return Object.freeze({
      ...base,
      kind: "federated_workload" as const,
      awsRegion,
      federationAudience,
      federationConfigId,
      signingAlgorithm,
      identityTokenDurationSeconds: configuredDuration,
    });
  }

  const certificateEnabled = restrictions.certificateFallback === true;
  if (row.authMethod !== "managed_secret" || !certificateEnabled
      || row.credentialProvider !== "aws-secrets-manager" || !row.credentialRef) {
    throw new ProviderAuthError("blocked_config", "Microsoft production auth must use workload identity or an explicitly enabled certificate fallback");
  }
  const bundle = await resolveTenantBoundSecretBundle(input.tenantId, {
    credentialProvider: row.credentialProvider,
    credentialRef: row.credentialRef,
    credentialVersion: row.credentialVersion,
  });
  if (bundle.clientSecret || bundle.client_secret) {
    throw new ProviderAuthError("blocked_config", "Microsoft client-secret authentication cannot certify production P2");
  }
  const privateKeyPem = string(bundle.privateKeyPem ?? bundle.private_key_pem);
  const certificatePem = string(bundle.certificatePem ?? bundle.certificate_pem);
  if (!privateKeyPem || !certificatePem) throw new ProviderAuthError("blocked_config", "Microsoft certificate fallback material is incomplete");
  return Object.freeze({
    ...base,
    kind: "managed_certificate" as const,
    privateKeyPem,
    certificatePem,
    ...(string(bundle.certificateThumbprint ?? bundle.certificate_thumbprint)
      ? { certificateThumbprint: string(bundle.certificateThumbprint ?? bundle.certificate_thumbprint)! }
      : {}),
  });
}

/** Resolve one exact employee-linked delegated Microsoft profile. Access and
 * refresh tokens stay inside the managed-secret boundary and this runtime object. */
export async function resolveMicrosoftDelegatedAuthContext(input: {
  tenantId: string;
  principalId: string;
  purpose?: string;
}): Promise<MicrosoftDelegatedAuthContext> {
  const purpose = input.purpose ?? "artifact_excel";
  const [row] = await withTenant(input.tenantId, (db) => db.select({
    profileId: authProfiles.id,
    profileRef: authProfiles.authProfileRef,
    profileStatus: authProfiles.status,
    principalType: authProfiles.principalType,
    principalId: authProfiles.principalId,
    purpose: authProfiles.purpose,
    accountId: applicationAccounts.id,
    accountProvider: applicationAccounts.provider,
    accountStatus: applicationAccounts.status,
    providerAccountRef: applicationAccounts.providerAccountRef,
    accountMetadata: applicationAccounts.metadata,
    authMethod: authProfiles.authMethod,
    credentialProvider: authProfiles.credentialProvider,
    credentialRef: authProfiles.credentialRef,
    credentialVersion: authProfiles.credentialVersion,
    connectionStatus: authProfiles.connectionStatus,
    connectionRevision: authProfiles.connectionRevision,
    requiredScopes: authProfiles.requiredScopes,
    grantedScopes: authProfiles.grantedScopes,
    tokenExpiresAt: authProfiles.tokenExpiresAt,
  }).from(authProfiles).innerJoin(applicationAccounts, and(
    eq(applicationAccounts.tenantId, input.tenantId),
    eq(applicationAccounts.id, authProfiles.applicationAccountId),
  )).where(and(
    eq(authProfiles.tenantId, input.tenantId),
    eq(authProfiles.principalType, "employee"),
    eq(authProfiles.principalId, input.principalId),
    eq(authProfiles.purpose, purpose),
  )).orderBy(authProfiles.priority).limit(1));

  if (!row || row.accountProvider !== "microsoft_graph" || row.principalId !== input.principalId || row.purpose !== purpose) {
    throw new ProviderAuthError("blocked_config", "An employee-linked delegated Microsoft artifact profile is not configured");
  }
  if (row.profileStatus !== "active" || row.accountStatus !== "active" || row.connectionStatus !== "active") {
    throw new ProviderAuthError("blocked_auth", "The delegated Microsoft artifact profile requires reauthorization");
  }
  if (row.authMethod !== "oauth2" || row.credentialProvider !== "aws-secrets-manager" || !row.credentialRef) {
    throw new ProviderAuthError("blocked_config", "Delegated Microsoft artifacts require an AWS managed-secret OAuth profile");
  }
  const [p2Reuse] = await withTenant(input.tenantId, (db) => db.select({ id: tenantIntegrations.id })
    .from(tenantIntegrations).where(and(
      eq(tenantIntegrations.tenantId, input.tenantId),
      eq(tenantIntegrations.binding, "microsoft_graph"),
      eq(tenantIntegrations.authProfileId, row.profileId),
    )).limit(1));
  if (p2Reuse) throw new ProviderAuthError("blocked_config", "The P2 app-only profile cannot be reused as delegated Office authorization");

  const granted = strings(row.grantedScopes);
  const allowed = new Set(granted.map((value) => value.toLowerCase()));
  if (!["files.readwrite", "files.readwrite.all", "sites.readwrite.all"].some((scope) => allowed.has(scope))) {
    throw new ProviderAuthError("blocked_permission", "Delegated Microsoft Files.ReadWrite permission is not effective");
  }
  const metadata = object(row.accountMetadata);
  const directoryTenantId = requireUuid(metadata.directoryTenantId ?? row.providerAccountRef, "Microsoft directory tenant ID");
  const applicationClientId = requireUuid(metadata.applicationClientId, "Microsoft application client ID");
  const cloud = requireGlobalCloud(metadata.cloud);
  const bundle = await resolveTenantBoundSecretBundle(input.tenantId, {
    credentialProvider: row.credentialProvider,
    credentialRef: row.credentialRef,
    credentialVersion: row.credentialVersion,
  });
  const refreshToken = string(bundle.refreshToken ?? bundle.refresh_token);
  if (!refreshToken) throw new ProviderAuthError("blocked_auth", "The delegated Microsoft refresh token is unavailable");
  const accessToken = string(bundle.accessToken ?? bundle.access_token) ?? undefined;
  const accessTokenExpiresAt = string(bundle.expiresAt ?? bundle.expires_at) ?? row.tokenExpiresAt?.toISOString();
  if (bundle.clientSecret || bundle.client_secret) {
    throw new ProviderAuthError("blocked_config", "Delegated Microsoft artifact authorization must use a public-client PKCE profile; client-secret material is not accepted");
  }
  const credentialRef = row.credentialRef;
  const originalBundle = { ...bundle };
  const persistTokens = async (tokens: { accessToken: string; expiresAt: string; refreshToken?: string }): Promise<void> => {
    const next = {
      ...originalBundle,
      accessToken: tokens.accessToken,
      expiresAt: tokens.expiresAt,
      refreshToken: tokens.refreshToken ?? refreshToken,
    };
    const versionId = await writeAwsSecretReference(credentialRef, next);
    await withTenant(input.tenantId, async (db) => {
      await db.update(authProfiles).set({
        credentialVersion: `id:${versionId}`,
        tokenExpiresAt: new Date(tokens.expiresAt),
        lastRefreshedAt: new Date(),
        lastVerifiedAt: new Date(),
        lastConnectionErrorCode: null,
        connectionRevision: sql`${authProfiles.connectionRevision} + 1`,
        updatedAt: new Date(),
      }).where(and(eq(authProfiles.tenantId, input.tenantId), eq(authProfiles.id, row.profileId)));
      await db.insert(connectionEvents).values({ tenantId: input.tenantId, authProfileId: row.profileId, eventType: "refreshed", fromStatus: "active", toStatus: "active", reasonCode: "microsoft_delegated_refresh" });
    });
  };
  const markReauthorizationRequired = async (reasonCode: string): Promise<void> => {
    await withTenant(input.tenantId, async (db) => {
      await db.update(authProfiles).set({
        connectionStatus: "reauth_required",
        reauthRequiredAt: new Date(),
        lastConnectionErrorCode: reasonCode.slice(0, 160),
        connectionRevision: sql`${authProfiles.connectionRevision} + 1`,
        updatedAt: new Date(),
      }).where(and(eq(authProfiles.tenantId, input.tenantId), eq(authProfiles.id, row.profileId)));
      await db.insert(connectionEvents).values({ tenantId: input.tenantId, authProfileId: row.profileId, eventType: "reauth_required", fromStatus: "active", toStatus: "reauth_required", reasonCode: reasonCode.slice(0, 160) });
    });
  };
  return Object.freeze({
    kind: "delegated_user" as const,
    tenantId: input.tenantId,
    provider: "microsoft_graph" as const,
    authProfileId: row.profileId,
    authProfileRef: row.profileRef,
    principalId: input.principalId,
    connectionRevision: row.connectionRevision,
    directoryTenantId,
    applicationClientId,
    cloud,
    requiredPermissions: Object.freeze(strings(row.requiredScopes)),
    consentedPermissions: Object.freeze(granted),
    cacheKey: `${input.tenantId}:${row.profileId}:${row.connectionRevision}:${input.principalId}`,
    ...(accessToken ? { accessToken } : {}),
    ...(accessTokenExpiresAt ? { accessTokenExpiresAt } : {}),
    refreshToken,
    persistTokens,
    markReauthorizationRequired,
  });
}

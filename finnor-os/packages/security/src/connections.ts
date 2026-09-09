import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  applicationAccounts,
  authProfiles,
  communicationIdentities,
  connectionEvents,
  getPool,
  oauthConnectionRequests,
  withTenant,
} from "@finnor/db";
import { and, eq, sql } from "drizzle-orm";
import { authorizeAuthProfileConnection } from "./identity-access";
import { readAwsSecretReference, writeAwsSecretReference } from "./secrets";
import { resolveCredentialReferenceContext, resolveTenantBoundSecretBundle } from "./tenant-credentials";

export const GOOGLE_GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GOOGLE_IDENTITY_SCOPES = ["openid", "email"] as const;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const CONNECTION_OK = new Set(["active", "degraded"]);

export type ConnectionStatus =
  | "disconnected" | "connecting" | "active" | "degraded" | "expired"
  | "reauth_required" | "revoked" | "disabled" | "misconfigured" | "provider_unavailable";

export class ConnectionError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "ConnectionError";
  }
}

type GoogleFetch = typeof fetch;
let googleFetchOverride: GoogleFetch | null = null;
export function setGoogleConnectionFetchForTesting(value: GoogleFetch | null): void {
  googleFetchOverride = value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function oauthClient(): { clientId: string; clientSecret?: string } {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId) throw new ConnectionError("blocked_config", "Google OAuth client configuration is unavailable", 503);
  return { clientId, ...(clientSecret ? { clientSecret } : {}) };
}

function validateRedirectUri(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConnectionError("invalid_redirect", "OAuth redirect URI is invalid"); }
  if (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new ConnectionError("invalid_redirect", "OAuth redirect URI must use HTTPS");
  }
  const configured = (process.env.GOOGLE_OAUTH_REDIRECT_URIS ?? process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "")
    .split(",").map((entry) => entry.trim()).filter(Boolean);
  if (configured.length > 0 && !configured.includes(url.toString())) throw new ConnectionError("invalid_redirect", "OAuth redirect URI is not allowlisted");
  return url.toString();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

async function loadProfile(tenantId: string, authProfileRef: string) {
  const [row] = await withTenant(tenantId, (db) => db.select({
    id: authProfiles.id,
    ref: authProfiles.authProfileRef,
    status: authProfiles.status,
    authMethod: authProfiles.authMethod,
    connectionStatus: authProfiles.connectionStatus,
    requiredScopes: authProfiles.requiredScopes,
    grantedScopes: authProfiles.grantedScopes,
    providerSubjectRef: authProfiles.providerSubjectRef,
    tokenExpiresAt: authProfiles.tokenExpiresAt,
    credentialProvider: authProfiles.credentialProvider,
    credentialRef: authProfiles.credentialRef,
    credentialVersion: authProfiles.credentialVersion,
    application: applicationAccounts.application,
    provider: applicationAccounts.provider,
    providerAccountRef: applicationAccounts.providerAccountRef,
  }).from(authProfiles).innerJoin(applicationAccounts, and(
    eq(applicationAccounts.tenantId, tenantId),
    eq(applicationAccounts.id, authProfiles.applicationAccountId),
  )).where(and(eq(authProfiles.tenantId, tenantId), eq(authProfiles.authProfileRef, authProfileRef))).limit(1));
  if (!row) throw new ConnectionError("not_found", "Auth profile was not found", 404);
  return row;
}

async function authorizeConnection(tenantId: string, actorId: string, authProfileRef: string) {
  const profile = await loadProfile(tenantId, authProfileRef);
  await authorizeAuthProfileConnection(tenantId, actorId, profile.application, authProfileRef);
  if (profile.status !== "active") throw new ConnectionError("disabled", "Auth profile is not active", 409);
  return profile;
}

export interface BeginGoogleConnectionResult {
  authorizationUrl: string;
  state: string;
  verifier: string;
  expiresAt: string;
}

export async function beginGoogleConnection(input: {
  tenantId: string;
  actorId: string;
  authProfileRef: string;
  redirectUri: string;
  traceId?: string;
}): Promise<BeginGoogleConnectionResult> {
  const profile = await authorizeConnection(input.tenantId, input.actorId, input.authProfileRef);
  if (profile.provider !== "gmail" && profile.provider !== "google") throw new ConnectionError("provider_mismatch", "Auth profile is not a Google connection");
  if (profile.authMethod !== "oauth2") throw new ConnectionError("method_mismatch", "Auth profile is not configured for OAuth 2.0");
  if (profile.connectionStatus === "disabled") throw new ConnectionError("disabled", "Connection is disabled", 409);
  const redirectUri = validateRedirectUri(input.redirectUri);
  const { clientId } = oauthClient();
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = pkceChallenge(verifier);
  const required = stringArray(profile.requiredScopes);
  const scopes = [...new Set([...GOOGLE_IDENTITY_SCOPES, ...(required.length > 0 ? required : [GOOGLE_GMAIL_SEND_SCOPE])])];
  const expiresAt = new Date(Date.now() + 10 * 60_000);

  await withTenant(input.tenantId, async (db) => {
    await db.insert(oauthConnectionRequests).values({
      tenantId: input.tenantId,
      authProfileId: profile.id,
      actorId: input.actorId,
      provider: "google",
      stateHash: sha256(state),
      pkceChallenge: challenge,
      redirectUri,
      requestedScopes: scopes,
      expiresAt,
    });
    const fromStatus = profile.connectionStatus;
    await db.update(authProfiles).set({ connectionStatus: "connecting", lastConnectionErrorCode: null, updatedAt: new Date() })
      .where(and(eq(authProfiles.tenantId, input.tenantId), eq(authProfiles.id, profile.id)));
    await db.insert(connectionEvents).values({
      tenantId: input.tenantId,
      authProfileId: profile.id,
      actorId: input.actorId,
      eventType: "connect_started",
      fromStatus,
      toStatus: "connecting",
      traceId: input.traceId,
    });
  });

  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
  }).toString();
  return { authorizationUrl: url.toString(), state, verifier, expiresAt: expiresAt.toISOString() };
}

type ConsumedRequest = {
  request_id: string;
  tenant_id: string;
  auth_profile_id: string;
  actor_id: string;
  provider: string;
  pkce_challenge: string;
  redirect_uri: string;
  requested_scopes: string[];
};

async function failConsumedConnection(request: ConsumedRequest, code: string, status: ConnectionStatus): Promise<void> {
  await withTenant(request.tenant_id, async (db) => {
    await db.update(authProfiles).set({
      connectionStatus: status,
      lastConnectionErrorCode: code.slice(0, 120),
      ...(status === "reauth_required" ? { reauthRequiredAt: new Date() } : {}),
      connectionRevision: sql`${authProfiles.connectionRevision} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(authProfiles.tenantId, request.tenant_id), eq(authProfiles.id, request.auth_profile_id)));
    await db.insert(connectionEvents).values({
      tenantId: request.tenant_id,
      authProfileId: request.auth_profile_id,
      actorId: request.actor_id,
      eventType: "connect_failed",
      fromStatus: "connecting",
      toStatus: status,
      reasonCode: code.slice(0, 120),
    });
  });
}

export async function completeGoogleConnection(input: {
  state: string;
  verifier: string;
  code: string;
  traceId?: string;
}): Promise<{ tenantId: string; authProfileRef: string; status: "active"; account: string; grantedScopes: string[] }> {
  if (!input.state || !input.verifier || !input.code) throw new ConnectionError("invalid_callback", "OAuth callback is incomplete");
  const consumed = await getPool().query<ConsumedRequest>(
    "SELECT * FROM finnor_os.consume_oauth_connection_request($1)", [sha256(input.state)],
  );
  const request = consumed.rows[0];
  if (!request) throw new ConnectionError("invalid_state", "OAuth state is invalid, expired, or already used", 409);
  if (!safeEqual(pkceChallenge(input.verifier), request.pkce_challenge)) {
    await failConsumedConnection(request, "invalid_pkce", "disconnected");
    throw new ConnectionError("invalid_pkce", "OAuth PKCE verification failed", 409);
  }

  const [profile] = await withTenant(request.tenant_id, (db) => db.select({
    ref: authProfiles.authProfileRef,
    status: authProfiles.status,
    authMethod: authProfiles.authMethod,
    connectionStatus: authProfiles.connectionStatus,
    application: applicationAccounts.application,
    provider: applicationAccounts.provider,
    providerAccountRef: applicationAccounts.providerAccountRef,
  }).from(authProfiles).innerJoin(applicationAccounts, and(
    eq(applicationAccounts.tenantId, request.tenant_id),
    eq(applicationAccounts.id, authProfiles.applicationAccountId),
  )).where(and(eq(authProfiles.tenantId, request.tenant_id), eq(authProfiles.id, request.auth_profile_id))).limit(1));
  if (!profile || profile.status !== "active" || profile.authMethod !== "oauth2") {
    await failConsumedConnection(request, "profile_changed", "disabled");
    throw new ConnectionError("profile_changed", "Auth profile is no longer eligible", 409);
  }
  await authorizeAuthProfileConnection(request.tenant_id, request.actor_id, profile.application, profile.ref);

  const { clientId, clientSecret } = oauthClient();
  if (!clientSecret) {
    await failConsumedConnection(request, "oauth_client_secret_missing", "misconfigured");
    throw new ConnectionError("blocked_config", "Google OAuth client secret is unavailable", 503);
  }
  const tokenResponse = await (googleFetchOverride ?? fetch)(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: input.code,
      code_verifier: input.verifier,
      grant_type: "authorization_code",
      redirect_uri: request.redirect_uri,
    }),
  });
  const token = await tokenResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!tokenResponse.ok) {
    await failConsumedConnection(request, "token_exchange_failed", tokenResponse.status >= 500 ? "provider_unavailable" : "disconnected");
    throw new ConnectionError("token_exchange_failed", "Google OAuth token exchange failed", tokenResponse.status >= 500 ? 503 : 409);
  }
  const accessToken = typeof token.access_token === "string" ? token.access_token : null;
  const refreshToken = typeof token.refresh_token === "string" ? token.refresh_token : null;
  const expiresIn = typeof token.expires_in === "number" ? token.expires_in : Number(token.expires_in);
  const grantedScopes = new Set((typeof token.scope === "string" ? token.scope : "").split(/\s+/).filter(Boolean));
  if (!accessToken || !refreshToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    await failConsumedConnection(request, "invalid_token_envelope", "disconnected");
    throw new ConnectionError("invalid_token_envelope", "Google did not return a durable offline token", 409);
  }
  const missing = request.requested_scopes.filter((scope) => !GOOGLE_IDENTITY_SCOPES.includes(scope as typeof GOOGLE_IDENTITY_SCOPES[number]) && !grantedScopes.has(scope));
  if (missing.length > 0) {
    await failConsumedConnection(request, "insufficient_scope", "reauth_required");
    throw new ConnectionError("insufficient_scope", "Google connection is missing a required scope", 409);
  }

  const userResponse = await (googleFetchOverride ?? fetch)(GOOGLE_USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
  const user = await userResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!userResponse.ok) {
    await failConsumedConnection(request, "identity_lookup_failed", userResponse.status >= 500 ? "provider_unavailable" : "disconnected");
    throw new ConnectionError("identity_lookup_failed", "Google account identity could not be verified", userResponse.status >= 500 ? 503 : 409);
  }
  const subject = typeof user.sub === "string" ? user.sub : null;
  const email = typeof user.email === "string" ? user.email.toLowerCase() : null;
  const emailVerified = user.email_verified === true;
  if (!subject || !email || !emailVerified) {
    await failConsumedConnection(request, "identity_unverified", "disconnected");
    throw new ConnectionError("identity_unverified", "Google account email is not verified", 409);
  }
  if (profile.providerAccountRef && ![email, subject].includes(profile.providerAccountRef.toLowerCase())) {
    await failConsumedConnection(request, "account_mismatch", "disconnected");
    throw new ConnectionError("account_mismatch", "Google account does not match the configured application account", 409);
  }

  const expiresAt = new Date(Date.now() + expiresIn * 1_000);
  const reference = `finnor/tenants/${request.tenant_id}/gmail/oauth/${request.auth_profile_id}`;
  let versionId: string;
  try {
    versionId = await writeAwsSecretReference(reference, {
      user: email,
      accessToken,
      refreshToken,
      expiresAt: expiresAt.toISOString(),
      scopes: [...grantedScopes].sort().join(" "),
      subject,
    });
  } catch {
    await failConsumedConnection(request, "secret_store_unavailable", "provider_unavailable");
    throw new ConnectionError("secret_store_unavailable", "The managed credential store is unavailable", 503);
  }
  await withTenant(request.tenant_id, async (db) => {
    await db.update(authProfiles).set({
      credentialProvider: "aws-secrets-manager",
      credentialRef: reference,
      credentialVersion: `id:${versionId}`,
      connectionStatus: "active",
      grantedScopes: [...grantedScopes].sort(),
      providerSubjectRef: subject,
      tokenExpiresAt: expiresAt,
      connectedAt: new Date(),
      lastRefreshedAt: new Date(),
      lastVerifiedAt: new Date(),
      reauthRequiredAt: null,
      revokedAt: null,
      lastConnectionErrorCode: null,
      connectionRevision: sql`${authProfiles.connectionRevision} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(authProfiles.tenantId, request.tenant_id), eq(authProfiles.id, request.auth_profile_id)));
    await db.update(communicationIdentities).set({ authProfileId: request.auth_profile_id, updatedAt: new Date() }).where(and(
      eq(communicationIdentities.tenantId, request.tenant_id),
      eq(communicationIdentities.provider, "gmail"),
      eq(communicationIdentities.address, email),
    ));
    await db.insert(connectionEvents).values({
      tenantId: request.tenant_id,
      authProfileId: request.auth_profile_id,
      actorId: request.actor_id,
      eventType: profile.connectionStatus === "active" ? "reconnected" : "connected",
      fromStatus: profile.connectionStatus,
      toStatus: "active",
      traceId: input.traceId,
    });
  });
  return { tenantId: request.tenant_id, authProfileRef: profile.ref, status: "active", account: email, grantedScopes: [...grantedScopes].sort() };
}

export async function getConnectionStatus(input: { tenantId: string; actorId: string; authProfileRef: string }) {
  const profile = await authorizeConnection(input.tenantId, input.actorId, input.authProfileRef);
  return {
    authProfileRef: profile.ref,
    provider: profile.provider,
    authMethod: profile.authMethod,
    status: profile.connectionStatus as ConnectionStatus,
    usable: profile.status === "active" && CONNECTION_OK.has(profile.connectionStatus),
    requiredScopes: stringArray(profile.requiredScopes),
    grantedScopes: stringArray(profile.grantedScopes),
    tokenExpiresAt: profile.tokenExpiresAt?.toISOString() ?? null,
  };
}

export async function revokeConnection(input: { tenantId: string; actorId: string; authProfileRef: string; traceId?: string }) {
  const profile = await authorizeConnection(input.tenantId, input.actorId, input.authProfileRef);
  let providerRevoked = false;
  if (profile.authMethod === "oauth2" && profile.credentialProvider === "aws-secrets-manager" && profile.credentialRef) {
    try {
      const secret = await readAwsSecretReference(profile.credentialRef, profile.credentialVersion ?? undefined);
      const token = secret.refreshToken ?? secret.accessToken;
      if (token) {
        const response = await (googleFetchOverride ?? fetch)("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
        });
        providerRevoked = response.ok;
      }
    } catch {
      providerRevoked = false;
    }
  }
  await withTenant(input.tenantId, async (db) => {
    await db.update(authProfiles).set({
      connectionStatus: "revoked",
      credentialProvider: null,
      credentialRef: null,
      credentialVersion: null,
      tokenExpiresAt: null,
      revokedAt: new Date(),
      reauthRequiredAt: null,
      lastConnectionErrorCode: providerRevoked ? null : "provider_revocation_unconfirmed",
      connectionRevision: sql`${authProfiles.connectionRevision} + 1`,
      updatedAt: new Date(),
    }).where(and(eq(authProfiles.tenantId, input.tenantId), eq(authProfiles.id, profile.id)));
    await db.insert(connectionEvents).values({
      tenantId: input.tenantId,
      authProfileId: profile.id,
      actorId: input.actorId,
      eventType: "revoked",
      fromStatus: profile.connectionStatus,
      toStatus: "revoked",
      reasonCode: providerRevoked ? "provider_confirmed" : "local_revocation_enforced",
      traceId: input.traceId,
    });
  });
  return { authProfileRef: profile.ref, status: "revoked" as const, providerRevoked };
}

/** Trusted computer-runtime signal for a persistent browser profile whose saved
 * authentication is no longer usable. This never attempts to bypass MFA/CAPTCHA;
 * it removes the profile from future selection until a human reconnects it. */
export async function markBrowserConnectionReauthRequired(input: {
  tenantId: string;
  authProfileId: string;
  actorId?: string;
  reasonCode: string;
}): Promise<void> {
  await withTenant(input.tenantId, async (db) => {
    const [profile] = await db.update(authProfiles).set({
      connectionStatus: "reauth_required",
      reauthRequiredAt: new Date(),
      lastConnectionErrorCode: input.reasonCode.slice(0, 120),
      connectionRevision: sql`${authProfiles.connectionRevision} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(authProfiles.tenantId, input.tenantId),
      eq(authProfiles.id, input.authProfileId),
      eq(authProfiles.authMethod, "browser_profile"),
    )).returning({ id: authProfiles.id });
    if (!profile) return;
    await db.insert(connectionEvents).values({
      tenantId: input.tenantId,
      authProfileId: profile.id,
      actorId: input.actorId,
      eventType: "reauth_required",
      fromStatus: "active",
      toStatus: "reauth_required",
      reasonCode: input.reasonCode.slice(0, 120),
    });
  });
}

async function recordHealth(profile: Awaited<ReturnType<typeof loadProfile>>, tenantId: string, status: ConnectionStatus, reasonCode?: string): Promise<void> {
  const now = new Date();
  await withTenant(tenantId, async (db) => {
    await db.update(authProfiles).set({
      connectionStatus: status,
      ...(status === "active" ? { lastVerifiedAt: now } : {}),
      lastConnectionErrorCode: reasonCode ?? null,
      ...(status === "reauth_required" ? { reauthRequiredAt: now } : {}),
      connectionRevision: sql`${authProfiles.connectionRevision} + 1`,
      updatedAt: now,
    }).where(and(eq(authProfiles.tenantId, tenantId), eq(authProfiles.id, profile.id)));
    await db.insert(connectionEvents).values({
      tenantId,
      authProfileId: profile.id,
      eventType: status === "active" ? "verified" : status === "provider_unavailable" ? "provider_unavailable" : status === "reauth_required" ? "reauth_required" : "degraded",
      fromStatus: profile.connectionStatus,
      toStatus: status,
      reasonCode,
    });
  });
}

async function verifyProfileHealth(tenantId: string, profile: Awaited<ReturnType<typeof loadProfile>>) {
  if (profile.status !== "active" || profile.connectionStatus === "disabled" || profile.connectionStatus === "revoked") {
    return { authProfileRef: profile.ref, status: profile.connectionStatus as ConnectionStatus, usable: false, reasonCode: "connection_disabled" };
  }
  try {
    if (profile.authMethod === "oauth2") {
      if (profile.provider !== "gmail" || profile.credentialProvider !== "aws-secrets-manager" || !profile.credentialRef) {
        await recordHealth(profile, tenantId, "misconfigured", "oauth_reference_missing");
        return { authProfileRef: profile.ref, status: "misconfigured" as const, usable: false, reasonCode: "oauth_reference_missing" };
      }
      const context = await resolveCredentialReferenceContext(tenantId, "gmail", {
        credentialProvider: profile.credentialProvider,
        credentialRef: profile.credentialRef,
        credentialVersion: profile.credentialVersion,
        publicMetadata: profile.providerAccountRef ? { user: profile.providerAccountRef } : {},
        integration: { id: profile.id, capability: profile.application, binding: profile.provider },
      });
      if (!context.credentials.accessToken) throw new ConnectionError("reauth_required", "Google OAuth access token is unavailable", 409);
      const response = await (googleFetchOverride ?? fetch)("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
        headers: { authorization: `Bearer ${context.credentials.accessToken}` },
      });
      if (response.status === 401 || response.status === 403) {
        await recordHealth(profile, tenantId, "reauth_required", "provider_auth_rejected");
        return { authProfileRef: profile.ref, status: "reauth_required" as const, usable: false, reasonCode: "provider_auth_rejected" };
      }
      if (!response.ok) {
        await recordHealth(profile, tenantId, "provider_unavailable", "provider_health_failed");
        return { authProfileRef: profile.ref, status: "provider_unavailable" as const, usable: false, reasonCode: "provider_health_failed" };
      }
    } else if (profile.authMethod === "browser_profile") {
      if ((profile.credentialProvider !== "aws-secrets-manager" && profile.credentialProvider !== "os-keychain") || !profile.credentialRef) {
        await recordHealth(profile, tenantId, "misconfigured", "browser_profile_reference_missing");
        return { authProfileRef: profile.ref, status: "misconfigured" as const, usable: false, reasonCode: "browser_profile_reference_missing" };
      }
      const bundle = await resolveTenantBoundSecretBundle(tenantId, {
        credentialProvider: profile.credentialProvider,
        credentialRef: profile.credentialRef,
        credentialVersion: profile.credentialVersion,
      });
      if (!bundle.steelProfileId && !bundle.profileId && !bundle.steelNamespace && !bundle.namespace) {
        await recordHealth(profile, tenantId, "misconfigured", "browser_profile_handle_missing");
        return { authProfileRef: profile.ref, status: "misconfigured" as const, usable: false, reasonCode: "browser_profile_handle_missing" };
      }
      // Steel authentication is proven by the actual isolated session. The runner
      // marks reauth_required on login/MFA/CAPTCHA/session-expiry observations.
    } else if ((profile.credentialProvider === "aws-secrets-manager" || profile.credentialProvider === "os-keychain") && profile.credentialRef) {
      await resolveTenantBoundSecretBundle(tenantId, {
        credentialProvider: profile.credentialProvider,
        credentialRef: profile.credentialRef,
        credentialVersion: profile.credentialVersion,
      });
    }
    await recordHealth(profile, tenantId, "active");
    return { authProfileRef: profile.ref, status: "active" as const, usable: true, reasonCode: null };
  } catch (error) {
    const reauth = error instanceof ConnectionError && error.code === "reauth_required"
      || /reauthorization|invalid_grant/i.test(error instanceof Error ? error.message : "");
    const status = reauth ? "reauth_required" : "provider_unavailable";
    await recordHealth(profile, tenantId, status, reauth ? "refresh_rejected" : "health_check_unavailable");
    return { authProfileRef: profile.ref, status, usable: false, reasonCode: reauth ? "refresh_rejected" : "health_check_unavailable" };
  }
}

export async function verifyConnectionHealth(input: { tenantId: string; actorId: string; authProfileRef: string }) {
  const profile = await authorizeConnection(input.tenantId, input.actorId, input.authProfileRef);
  return verifyProfileHealth(input.tenantId, profile);
}

/** Worker-only fleet check. It consumes canonical required-profile rows and returns
 * safe status codes; it never reveals secret references or provider token text. */
export async function verifyRequiredConnectionsForTenant(tenantId: string) {
  const refs = await withTenant(tenantId, (db) => db.select({ ref: authProfiles.authProfileRef }).from(authProfiles).where(and(
    eq(authProfiles.tenantId, tenantId),
    eq(authProfiles.status, "active"),
    eq(authProfiles.connectionRequired, true),
  )));
  const results = [];
  for (const row of refs) results.push(await verifyProfileHealth(tenantId, await loadProfile(tenantId, row.ref)));
  return results;
}

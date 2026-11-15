import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { closePool, getPool } from "@finnor/db";
import {
  beginGoogleConnection,
  completeGoogleConnection,
  getConnectionStatus,
  markBrowserConnectionReauthRequired,
  resolveAuthProfileRef,
  resolveComputerAuthProfile,
  revokeConnection,
  setAwsSecretReaderForTesting,
  setAwsSecretWriterForTesting,
  setGoogleConnectionFetchForTesting,
  setTenantSecretReaderForTesting,
  verifyConnectionHealth,
} from "@finnor/security";
import { migrate } from "../../packages/db/migrate";

const DB_URL = process.env.DATABASE_URL ?? "postgres://finnor:finnor@localhost:5432/finnor";
const REDIRECT = "http://localhost:3001/api/connections/google/callback";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.send";

async function dbUp(): Promise<boolean> {
  const client = new pg.Client({ connectionString: DB_URL, connectionTimeoutMillis: 2_000 });
  try { await client.connect(); await client.end(); return true; } catch { return false; }
}
const available = await dbUp();

async function seedTenant(label: string) {
  const tenantId = randomUUID();
  const actorId = randomUUID();
  await getPool().query(
    "INSERT INTO tenants(id,client_key,name) VALUES ($1,$2,$3)",
    [tenantId, `p5-${label}-${tenantId.slice(0, 8)}`, `Phase 5 ${label}`],
  );
  await getPool().query(
    "INSERT INTO users(id,tenant_id,email,role,display_name) VALUES ($1,$2,$3,'owner','Phase 5 Owner')",
    [actorId, tenantId, `${label}-${actorId}@example.test`],
  );
  return { tenantId, actorId };
}

async function seedProfile(input: {
  tenantId: string;
  actorId: string;
  ref: string;
  application?: string;
  provider?: string;
  accountRef?: string;
  authMethod?: "oauth2" | "browser_profile" | "managed_secret";
  connectionStatus?: string;
  credentialRef?: string;
}) {
  const accountId = randomUUID();
  const profileId = randomUUID();
  const application = input.application ?? "gmail";
  const provider = input.provider ?? "gmail";
  await getPool().query(
    `INSERT INTO application_accounts
       (id,tenant_id,account_key,application,provider,display_name,provider_account_ref,status,capabilities)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'active','["send"]')`,
    [accountId, input.tenantId, `account-${input.ref}`, application, provider, `Account ${input.ref}`, input.accountRef ?? null],
  );
  const credentialProvider = input.credentialRef ? "aws-secrets-manager" : null;
  await getPool().query(
    `INSERT INTO auth_profiles
       (id,tenant_id,auth_profile_ref,principal_type,principal_id,application_account_id,purpose,
        credential_provider,credential_ref,status,capabilities,auth_method,connection_status,
        required_scopes,connection_required)
     VALUES ($1,$2,$3,'employee',$4,$5,'send',$6,$7,'active','["send"]',$8,$9,$10,true)`,
    [profileId, input.tenantId, input.ref, input.actorId, accountId, credentialProvider, input.credentialRef ?? null,
      input.authMethod ?? "oauth2", input.connectionStatus ?? "disconnected", [GMAIL_SCOPE]],
  );
  return { accountId, profileId };
}

describe.skipIf(!available)("Phase 5 governed connection lifecycle", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = DB_URL;
    await migrate(DB_URL);
  }, 30_000);

  beforeEach(() => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "google-client-id");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "google-client-secret");
    vi.stubEnv("GOOGLE_OAUTH_REDIRECT_URI", REDIRECT);
    setAwsSecretReaderForTesting(null);
    setAwsSecretWriterForTesting(null);
    setTenantSecretReaderForTesting(null);
    setGoogleConnectionFetchForTesting(null);
  });

  afterEach(() => {
    setAwsSecretReaderForTesting(null);
    setAwsSecretWriterForTesting(null);
    setTenantSecretReaderForTesting(null);
    setGoogleConnectionFetchForTesting(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  afterAll(async () => closePool());

  it("preserves revocation against an earlier callback and accepts a fresh connection", async () => {
    const { tenantId, actorId } = await seedTenant("stale-callback");
    const email = `stale-${tenantId.slice(0, 8)}@example.test`;
    const authProfileRef = "stale-callback-gmail";
    const { profileId } = await seedProfile({ tenantId, actorId, ref: authProfileRef, accountRef: email });
    const input = { tenantId, actorId, authProfileRef, redirectUri: REDIRECT };
    const provider = vi.fn<typeof fetch>(async (url) => String(url).includes("/token")
      ? Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, scope: `openid email ${GMAIL_SCOPE}` })
      : Response.json({ sub: "fixture-subject", email, email_verified: true }));
    const write = vi.fn(async () => "fixture-version");
    setGoogleConnectionFetchForTesting(provider);
    setAwsSecretWriterForTesting(write);

    const earlier = await beginGoogleConnection(input);
    await revokeConnection(input);
    const stale = await completeGoogleConnection({ ...earlier, code: "earlier-code" }).catch((error: unknown) => error);
    const { rows } = await getPool().query("SELECT connection_status,credential_version FROM auth_profiles WHERE id=$1", [profileId]);
    expect({ stale, profile: rows[0], providerCalls: provider.mock.calls.length, secretWrites: write.mock.calls.length }).toMatchObject({
      stale: expect.objectContaining({ status: 409 }),
      profile: { connection_status: "revoked", credential_version: null },
      providerCalls: 0,
      secretWrites: 0,
    });

    const fresh = await beginGoogleConnection(input);
    await expect(completeGoogleConnection({ ...fresh, code: "fresh-code" })).resolves.toMatchObject({ status: "active", authProfileRef });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("keeps revocation when an in-flight token exchange settles (success=%s)", async (succeeds) => {
    const { tenantId, actorId } = await seedTenant("in-flight-callback");
    const email = `in-flight-${tenantId.slice(0, 8)}@example.test`;
    const authProfileRef = "in-flight-callback-gmail";
    const { profileId } = await seedProfile({ tenantId, actorId, ref: authProfileRef, accountRef: email });
    const input = { tenantId, actorId, authProfileRef, redirectUri: REDIRECT };
    let enterExchange!: () => void;
    let releaseExchange!: () => void;
    const entered = new Promise<void>((resolve) => { enterExchange = resolve; });
    const release = new Promise<void>((resolve) => { releaseExchange = resolve; });
    const write = vi.fn(async () => "fixture-version");
    setAwsSecretWriterForTesting(write);
    setGoogleConnectionFetchForTesting(async (url) => {
      if (!String(url).includes("/token")) return Response.json({ sub: "fixture-subject", email, email_verified: true });
      enterExchange();
      await release;
      return succeeds
        ? Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, scope: `openid email ${GMAIL_SCOPE}` })
        : Response.json({ error: "invalid_grant" }, { status: 400 });
    });
    const started = await beginGoogleConnection(input);
    const callback = completeGoogleConnection({ ...started, code: "in-flight-code" }).catch((error: unknown) => error);
    try {
      await Promise.race([entered, callback.then(() => { throw new Error("Callback settled before token exchange barrier"); })]);
      await revokeConnection(input);
    } finally {
      releaseExchange();
    }
    const result = await callback;
    const { rows } = await getPool().query("SELECT connection_status,credential_version FROM auth_profiles WHERE id=$1", [profileId]);
    expect({ result, profile: rows[0], secretWrites: write.mock.calls.length }).toMatchObject({
      result: expect.objectContaining({ status: 409 }),
      profile: { connection_status: "revoked", credential_version: null },
      secretWrites: 0,
    });
  });

  it("keeps revocation when an in-flight health check reports success", async () => {
    const { tenantId, actorId } = await seedTenant("stale-health");
    const authProfileRef = "stale-health-gmail";
    const credentialRef = `finnor/tenants/${tenantId}/gmail/stale-health`;
    const input = { tenantId, actorId, authProfileRef };
    await seedProfile({ tenantId, actorId, ref: authProfileRef, connectionStatus: "active", credentialRef });
    setTenantSecretReaderForTesting(async () => ({
      user: "health@example.test", accessToken: "fixture-access", refreshToken: "fixture-refresh",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: GMAIL_SCOPE,
    }));
    setAwsSecretReaderForTesting(async () => ({ refreshToken: "fixture-refresh" }));
    let enterCheck!: () => void;
    let releaseCheck!: () => void;
    const entered = new Promise<void>((resolve) => { enterCheck = resolve; });
    const release = new Promise<void>((resolve) => { releaseCheck = resolve; });
    setGoogleConnectionFetchForTesting(async (url) => {
      if (String(url).endsWith("/profile")) {
        enterCheck();
        await release;
      }
      return new Response(null, { status: 200 });
    });
    const verification = verifyConnectionHealth(input);
    try {
      await Promise.race([entered, verification.then(() => { throw new Error("Health check settled before provider barrier"); })]);
      await revokeConnection(input);
    } finally {
      releaseCheck();
    }
    expect({ verification: await verification, profile: await getConnectionStatus(input) }).toMatchObject({
      verification: { status: "revoked", usable: false },
      profile: { status: "revoked", usable: false },
    });
  });

  it("leaves a new OAuth attempt intact during a connection health check", async () => {
    const { tenantId, actorId } = await seedTenant("connecting-health");
    const authProfileRef = "connecting-health-gmail";
    const input = { tenantId, actorId, authProfileRef, redirectUri: REDIRECT };
    await seedProfile({ tenantId, actorId, ref: authProfileRef });
    setAwsSecretWriterForTesting(async () => "connected-version");
    setGoogleConnectionFetchForTesting(async (url) => String(url).endsWith("/token")
      ? Response.json({ access_token: "fixture-access", refresh_token: "fixture-refresh", expires_in: 3600, scope: GMAIL_SCOPE })
      : Response.json({ sub: "fixture-subject", email: "health@example.test", email_verified: true }));
    const attempt = await beginGoogleConnection(input);
    expect(await verifyConnectionHealth(input)).toMatchObject({ status: "connecting", usable: false });
    await expect(completeGoogleConnection({ ...attempt, code: "fixture-code" })).resolves.toMatchObject({ status: "active" });
  });

  it("preserves a new connection when an earlier token refresh finishes", async () => {
    const { tenantId, actorId } = await seedTenant("stale-refresh");
    const authProfileRef = "stale-refresh-gmail";
    const input = { tenantId, actorId, authProfileRef, redirectUri: REDIRECT };
    const { profileId } = await seedProfile({ tenantId, actorId, ref: authProfileRef, connectionStatus: "active" });
    const credentialRef = `finnor/tenants/${tenantId}/gmail/oauth/${profileId}`;
    await getPool().query("UPDATE auth_profiles SET credential_provider='aws-secrets-manager', credential_ref=$2, credential_version='id:old' WHERE id=$1", [profileId, credentialRef]);
    setTenantSecretReaderForTesting(async () => ({
      user: "health@example.test", accessToken: "expired-access", refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(), scopes: GMAIL_SCOPE,
    }));
    let enterRefresh!: () => void;
    let releaseRefresh!: () => void;
    const entered = new Promise<void>((resolve) => { enterRefresh = resolve; });
    const release = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      enterRefresh();
      await release;
      return Response.json({ access_token: "old-refreshed-access", expires_in: 3600 });
    }));
    setAwsSecretWriterForTesting(async (_reference, credentials) =>
      credentials.accessToken === "new-access" ? "new-version" : "old-refresh-version");
    setGoogleConnectionFetchForTesting(async (url) => {
      if (String(url).endsWith("/profile")) return new Response(null, { status: 200 });
      return String(url).endsWith("/token")
        ? Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600, scope: GMAIL_SCOPE })
        : Response.json({ sub: "new-subject", email: "health@example.test", email_verified: true });
    });
    const verification = verifyConnectionHealth(input);
    try {
      await Promise.race([entered, verification.then(() => { throw new Error("Health check settled before refresh barrier"); })]);
      const attempt = await beginGoogleConnection(input);
      await completeGoogleConnection({ ...attempt, code: "new-code" });
    } finally {
      releaseRefresh();
    }
    await verification;
    const { rows } = await getPool().query("SELECT connection_status,credential_version FROM auth_profiles WHERE id=$1", [profileId]);
    expect(rows[0]).toEqual({ connection_status: "active", credential_version: "id:new-version" });
  });

  it("records a provider rejection against the credential refreshed by the current check", async () => {
    const { tenantId, actorId } = await seedTenant("refreshed-health");
    const authProfileRef = "refreshed-health-gmail";
    const credentialRef = `finnor/tenants/${tenantId}/gmail/refreshed-health`;
    const input = { tenantId, actorId, authProfileRef };
    const { profileId } = await seedProfile({ tenantId, actorId, ref: authProfileRef, connectionStatus: "active", credentialRef });
    setTenantSecretReaderForTesting(async () => ({
      user: "health@example.test", accessToken: "expired-access", refreshToken: "fixture-refresh",
      expiresAt: new Date(Date.now() - 60_000).toISOString(), scopes: GMAIL_SCOPE,
    }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ access_token: "refreshed-access", expires_in: 3600 })));
    setAwsSecretWriterForTesting(async () => "refreshed-version");
    setGoogleConnectionFetchForTesting(async () => new Response(null, { status: 401 }));
    expect(await verifyConnectionHealth(input)).toMatchObject({
      status: "reauth_required", usable: false, reasonCode: "provider_auth_rejected",
    });
    const { rows } = await getPool().query("SELECT connection_status,credential_version FROM auth_profiles WHERE id=$1", [profileId]);
    expect(rows[0]).toEqual({ connection_status: "reauth_required", credential_version: "id:refreshed-version" });
  });

  it("connects the configured personal mailbox with PKCE, one-time state, exact scopes, and no database token material", async () => {
    const { tenantId, actorId } = await seedTenant("personal");
    const email = `personal-${tenantId.slice(0, 8)}@example.test`;
    const { profileId } = await seedProfile({ tenantId, actorId, ref: "personal-gmail", accountRef: email });
    await getPool().query(
      `INSERT INTO communication_identities
         (tenant_id,identity_key,provider,channel,address,status,capabilities)
       VALUES ($1,'personal-email','gmail','email',$2,'active','["send"]')`,
      [tenantId, email],
    );

    const written: Array<{ reference: string; value: Record<string, string> }> = [];
    setAwsSecretWriterForTesting(async (reference, value) => {
      written.push({ reference, value });
      return "version-1";
    });
    setGoogleConnectionFetchForTesting(async (url) => {
      if (String(url).includes("/token")) return Response.json({
        access_token: "access-token-never-persisted",
        refresh_token: "refresh-token-never-persisted",
        expires_in: 3600,
        scope: `openid email ${GMAIL_SCOPE}`,
      });
      return Response.json({ sub: "google-subject", email, email_verified: true });
    });

    const started = await beginGoogleConnection({ tenantId, actorId, authProfileRef: "personal-gmail", redirectUri: REDIRECT });
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.hostname).toBe("accounts.google.com");
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.get("access_type")).toBe("offline");
    expect(authorization.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["openid", "email", GMAIL_SCOPE]));
    const request = await getPool().query("SELECT state_hash,pkce_challenge,consumed_at FROM oauth_connection_requests WHERE tenant_id=$1", [tenantId]);
    expect(request.rows[0].state_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(request.rows[0].state_hash).not.toBe(started.state);
    expect(request.rows[0].pkce_challenge).not.toBe(started.verifier);

    const completed = await completeGoogleConnection({ state: started.state, verifier: started.verifier, code: "authorization-code" });
    expect(completed).toMatchObject({ tenantId, authProfileRef: "personal-gmail", status: "active", account: email });
    expect(written).toHaveLength(1);
    expect(written[0]!.reference).toBe(`finnor/tenants/${tenantId}/gmail/oauth/${profileId}`);
    expect(written[0]!.value).toMatchObject({ accessToken: "access-token-never-persisted", refreshToken: "refresh-token-never-persisted" });

    const canonical = await getPool().query(
      `SELECT credential_provider,credential_ref,credential_version,connection_status,granted_scopes,provider_subject_ref
         FROM auth_profiles WHERE id=$1`, [profileId],
    );
    expect(canonical.rows[0]).toMatchObject({
      credential_provider: "aws-secrets-manager",
      credential_ref: `finnor/tenants/${tenantId}/gmail/oauth/${profileId}`,
      credential_version: "id:version-1",
      connection_status: "active",
      provider_subject_ref: "google-subject",
    });
    expect(JSON.stringify(canonical.rows[0])).not.toContain("access-token-never-persisted");
    expect(JSON.stringify(canonical.rows[0])).not.toContain("refresh-token-never-persisted");
    expect((await getConnectionStatus({ tenantId, actorId, authProfileRef: "personal-gmail" }))).not.toHaveProperty("credentialRef");
    await expect(completeGoogleConnection({ state: started.state, verifier: started.verifier, code: "replay" }))
      .rejects.toMatchObject({ code: "invalid_state" });
  });

  it("fails account mismatch truthfully and makes local revocation immediately authoritative", async () => {
    const { tenantId, actorId } = await seedTenant("revoke");
    await seedProfile({ tenantId, actorId, ref: "wrong-google", accountRef: "expected@example.test" });
    setAwsSecretWriterForTesting(async () => "unused");
    setGoogleConnectionFetchForTesting(async (url) => String(url).includes("/token")
      ? Response.json({ access_token: "a", refresh_token: "r", expires_in: 3600, scope: `openid email ${GMAIL_SCOPE}` })
      : Response.json({ sub: "other-subject", email: "other@example.test", email_verified: true }));
    const started = await beginGoogleConnection({ tenantId, actorId, authProfileRef: "wrong-google", redirectUri: REDIRECT });
    await expect(completeGoogleConnection({ state: started.state, verifier: started.verifier, code: "code" }))
      .rejects.toMatchObject({ code: "account_mismatch" });
    expect((await getPool().query("SELECT connection_status,last_connection_error_code FROM auth_profiles WHERE tenant_id=$1 AND auth_profile_ref='wrong-google'", [tenantId])).rows[0])
      .toEqual({ connection_status: "disconnected", last_connection_error_code: "account_mismatch" });

    const profile = await getPool().query<{ id: string }>("SELECT id FROM auth_profiles WHERE tenant_id=$1 AND auth_profile_ref='wrong-google'", [tenantId]);
    const reference = `finnor/tenants/${tenantId}/gmail/oauth/${profile.rows[0]!.id}`;
    await getPool().query(
      "UPDATE auth_profiles SET connection_status='active',credential_provider='aws-secrets-manager',credential_ref=$2,credential_version='id:v1' WHERE tenant_id=$1 AND auth_profile_ref='wrong-google'",
      [tenantId, reference],
    );
    setAwsSecretReaderForTesting(async () => ({ refreshToken: "provider-refresh" }));
    setGoogleConnectionFetchForTesting(async () => new Response(null, { status: 503 }));
    const revoked = await revokeConnection({ tenantId, actorId, authProfileRef: "wrong-google" });
    expect(revoked).toEqual({ authProfileRef: "wrong-google", status: "revoked", providerRevoked: false });
    expect(await getConnectionStatus({ tenantId, actorId, authProfileRef: "wrong-google" })).toMatchObject({ status: "revoked", usable: false });
    await expect(resolveAuthProfileRef(tenantId, actorId, "gmail", "send", "wrong-google"))
      .rejects.toMatchObject({ code: "auth_profile_inactive" });
  });

  it("marks expired OAuth and browser authentication unusable without exposing or bypassing auth state", async () => {
    const { tenantId, actorId } = await seedTenant("expiry");
    const oauthRef = `finnor/tenants/${tenantId}/gmail/oauth-expired`;
    await seedProfile({ tenantId, actorId, ref: "expired-gmail", accountRef: "expired@example.test", connectionStatus: "active", credentialRef: oauthRef });
    setTenantSecretReaderForTesting(async (reference): Promise<Record<string, string>> => {
      if (reference === oauthRef) return {
        user: "expired@example.test", accessToken: "expired-access", refreshToken: "expired-refresh",
        expiresAt: new Date(Date.now() - 60_000).toISOString(), scopes: GMAIL_SCOPE,
      };
      return { steelProfileId: "steel-profile-sensitive" };
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })));
    const oauthHealth = await verifyConnectionHealth({ tenantId, actorId, authProfileRef: "expired-gmail" });
    expect(oauthHealth).toMatchObject({ status: "reauth_required", usable: false, reasonCode: "refresh_rejected" });

    const browserRef = `finnor/tenants/${tenantId}/steel/browser`;
    const browser = await seedProfile({
      tenantId, actorId, ref: "supplier-browser", application: "supplier_portal", provider: "steel",
      authMethod: "browser_profile", connectionStatus: "active", credentialRef: browserRef,
    });
    const usable = await resolveComputerAuthProfile(tenantId, actorId, "supplier_portal", "send", "supplier-browser");
    expect(usable.steelSessionAuth).toEqual({ profileId: "steel-profile-sensitive" });
    expect(JSON.stringify(usable)).not.toMatch(/cookie|password|token/i);
    await markBrowserConnectionReauthRequired({ tenantId, authProfileId: browser.profileId, actorId, reasonCode: "login_required" });
    await expect(resolveComputerAuthProfile(tenantId, actorId, "supplier_portal", "send", "supplier-browser"))
      .rejects.toMatchObject({ code: "auth_profile_inactive" });
  });

  it("fails closed for suspended employees and cross-tenant profile references", async () => {
    const a = await seedTenant("tenant-a");
    const b = await seedTenant("tenant-b");
    const profile = await seedProfile({ tenantId: a.tenantId, actorId: a.actorId, ref: "tenant-a-gmail", connectionStatus: "active" });
    await getPool().query(
      `INSERT INTO communication_identities(tenant_id,identity_key,provider,channel,address,status,capabilities)
       VALUES ($1,'tenant-b-email','gmail','email','b@example.test','active','[]')`, [b.tenantId],
    );
    await expect(getPool().query(
      "UPDATE communication_identities SET auth_profile_id=$2 WHERE tenant_id=$1 AND identity_key='tenant-b-email'",
      [b.tenantId, profile.profileId],
    )).rejects.toThrow(/foreign key|tenant/i);
    await getPool().query("UPDATE users SET status='suspended' WHERE id=$1", [a.actorId]);
    await expect(getConnectionStatus({ tenantId: a.tenantId, actorId: a.actorId, authProfileRef: "tenant-a-gmail" }))
      .rejects.toThrow(/suspended|active|actor/i);
  });
});

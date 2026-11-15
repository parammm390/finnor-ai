import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { getPool, closePool } from "../../finnor-os/packages/db/index";
import { resolveTenantFromBearerToken, AuthVerificationError } from "../../finnor-os/packages/security/src/auth";

const out = process.argv[2];
if (!out || !process.env.DATABASE_URL) throw Error("PRIVATE_EVIDENCE_AND_DATABASE_REQUIRED");
const bindings = JSON.parse(process.env.WORKOS_IDENTITY_BINDINGS ?? "{}");
const [subject] = Object.keys(bindings);
if (!subject) throw Error("EXPLICIT_ACCOUNT_LINK_REQUIRED");
const binding = bindings[subject];
const originalBindings = process.env.WORKOS_IDENTITY_BINDINGS;
const { publicKey, privateKey } = await generateKeyPair("RS256");
const publicJwk = { ...await exportJWK(publicKey), kid: "controlled-auth-e2e", alg: "RS256", use: "sig" };
const actualFetch = globalThis.fetch;
const modes = { verified: true, externalId: binding.principalId, email: binding.loginEmail };
globalThis.fetch = async (input, init) => {
  const address = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (address === `https://api.workos.com/sso/jwks/${process.env.WORKOS_CLIENT_ID}`) return Response.json({ keys: [publicJwk] });
  if (address === `https://api.workos.com/user_management/users/${subject}`) return Response.json({
    id: subject, email: modes.email, email_verified: modes.verified, external_id: modes.externalId,
  });
  if (address.startsWith("https://api.workos.com/")) throw Error("UNEXPECTED_IDP_OPERATION");
  return actualFetch(input, init);
};
process.env.FINNOR_AUTH_PROVIDER = "workos";
process.env.WORKOS_API_KEY = "CONTROLLED_E2E_NON_SECRET";
const report: { classification: string; cases: { name: string; observed: number }[]; status: string } = {
  classification: "CONTROLLED_HTTP_PRODUCTION_AUTH_RESOLVER_REAL_READONLY_POSTGRES_EMULATED_IDP", cases: [], status: "RUNNING",
};
const server = createServer(async (req, res) => {
  try {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) throw new AuthVerificationError("Missing bearer", 401);
    const ctx = await resolveTenantFromBearerToken(authorization.slice(7));
    if (req.url === "/tenant-isolation") {
      const c = await getPool().connect();
      try {
        await c.query("BEGIN READ ONLY");
        await c.query("SELECT set_config('app.tenant_id',$1,true)", [ctx.tenantId]);
        await c.query("SELECT $1::uuid", [ctx.deliverySession?.sessionId]);
        const own = await c.query("SELECT id FROM finnor_os.users WHERE id=$1 AND tenant_id=$2", [ctx.userId, ctx.tenantId]);
        const foreign = await c.query("SELECT id FROM finnor_os.users WHERE tenant_id<>$1 LIMIT 1", [ctx.tenantId]);
        assert.equal(own.rows.length, 1);
        assert.equal(foreign.rows.length, 0);
        await c.query("ROLLBACK");
      } finally { c.release(); }
    }
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(ctx));
  } catch (error) {
    res.writeHead(error instanceof AuthVerificationError ? error.status : 500);
    res.end("refused");
  }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string") throw Error("OWNED_HTTP_SERVER_REQUIRED");
const base = `http://127.0.0.1:${address.port}`;
async function token(options: { issuer?: string; expires?: number; audience?: string; subject?: string; sessionId?: string } = {}) {
  let value = new SignJWT({ sid: options.sessionId ?? "session_controlled_e2e", role: "admin", org_id: "org_foreign_ignored" })
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setSubject(options.subject ?? subject).setIssuer(options.issuer ?? "https://api.workos.com")
    .setIssuedAt().setExpirationTime(options.expires ?? Math.floor(Date.now() / 1000) + 120);
  if (options.audience) value = value.setAudience(options.audience);
  return value.sign(privateKey);
}
async function check(name: string, bearer: string | null, status: number, path = "/identity") {
  const r = await actualFetch(base + path, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {}, signal: AbortSignal.timeout(20_000) });
  assert.equal(r.status, status, name);
  if (status === 200) {
    const identity = await r.json();
    assert.equal(identity.userId, binding.principalId);
    assert.equal(identity.tenantId, binding.tenantId);
    assert.equal(identity.role, "owner");
    assert.equal(identity.deliverySession.subject, subject);
    assert.match(identity.deliverySession.sessionId, /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    report.cases.push({ name, observed: r.status });
    return identity.deliverySession;
  }
  report.cases.push({ name, observed: r.status });
}
try {
  await check("missing authentication", null, 401);
  await check("unsigned forgery", "forged.token.value", 401);
  await check("expired token", await token({ expires: Math.floor(Date.now() / 1000) - 10 }), 401);
  await check("wrong issuer", await token({ issuer: "https://evil.example" }), 401);
  await check("wrong audience", await token({ audience: "client_other" }), 401);
  await check("unlinked subject", await token({ subject: "user_foreign" }), 401);
  modes.verified = false;
  await check("unverified email", await token(), 401);
  modes.verified = true; modes.externalId = "00000000-0000-4000-8000-000000000099";
  await check("changed external identity", await token(), 401);
  modes.externalId = binding.principalId; modes.email = "other@example.com";
  await check("changed login email", await token(), 401);
  modes.email = binding.loginEmail;
  process.env.WORKOS_IDENTITY_BINDINGS = "{}";
  await check("absent explicit account link", await token(), 401);
  process.env.WORKOS_IDENTITY_BINDINGS = JSON.stringify({ [subject]: { ...binding, tenantId: "99999999-9999-4999-8999-999999999990" } });
  await check("mismatched canonical tenant", await token(), 403);
  process.env.WORKOS_IDENTITY_BINDINGS = originalBindings;
  const fixtureFile = process.argv[3];
  if (fixtureFile) {
    const suspended = JSON.parse(readFileSync(fixtureFile, "utf8")).users.find((user: { status: string }) => user.status === "suspended");
    if (!suspended) throw Error("SUSPENDED_ACCOUNT_FIXTURE_REQUIRED");
    modes.externalId = suspended.id;
    process.env.WORKOS_IDENTITY_BINDINGS = JSON.stringify({ [subject]: { ...binding,
      principalId: suspended.id, tenantId: suspended.tenant_id, canonicalEmail: suspended.email,
    } });
    await check("suspended canonical employee", await token(), 403);
    modes.externalId = binding.principalId;
    process.env.WORKOS_IDENTITY_BINDINGS = originalBindings;
  }
  const previousEnvironment = process.env.FINNOR_ENVIRONMENT;
  process.env.FINNOR_ENVIRONMENT = "production";
  const originalKey = process.env.WORKOS_API_KEY;
  const originalWorkosEnvironment = process.env.WORKOS_ENVIRONMENT;
  process.env.WORKOS_ENVIRONMENT = "production";
  process.env.WORKOS_API_KEY = "sk_test_controlled_environment_key";
  await check("test credential refused in production", await token(), 401);
  process.env.WORKOS_API_KEY = "sk_controlled_production_key_format";
  delete process.env.WORKOS_ENVIRONMENT;
  await check("undeclared WorkOS environment refused in production", await token(), 401);
  process.env.WORKOS_ENVIRONMENT = "production";
  await check("documented production secret-key format accepted", await token(), 200);
  process.env.WORKOS_API_KEY = originalKey;
  if (originalWorkosEnvironment === undefined) delete process.env.WORKOS_ENVIRONMENT;
  else process.env.WORKOS_ENVIRONMENT = originalWorkosEnvironment;
  if (previousEnvironment === undefined) delete process.env.FINNOR_ENVIRONMENT;
  else process.env.FINNOR_ENVIRONMENT = previousEnvironment;
  const initial = await check("existing canonical identity; IdP org and role ignored", await token(), 200);
  const refreshed = await check("refresh preserves delivery revocation identity", await token({ expires: Math.floor(Date.now() / 1000) + 180 }), 200);
  assert.equal(refreshed.sessionId, initial.sessionId);
  const otherSession = await check("separate login has separate delivery identity", await token({ sessionId: "session_other_e2e" }), 200);
  assert.notEqual(otherSession.sessionId, initial.sessionId);
  await check("invalid session identity refused", await token({ sessionId: "wrong-prefix" }), 401);
  await check("real PostgreSQL tenant isolation", await token(), 200, "/tenant-isolation");
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL";
  throw error;
} finally {
  writeFileSync(out, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  globalThis.fetch = actualFetch;
  process.env.WORKOS_IDENTITY_BINDINGS = originalBindings;
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  await closePool();
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, classification: report.classification }));
}

import { createHash } from "node:crypto";
import { executionDeadlineMilliseconds } from "@finnor/db";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

const WorkOSUser = z.object({
  id: z.string().startsWith("user_"),
  email: z.string().email(),
  email_verified: z.literal(true),
  external_id: z.string().uuid(),
});

const IdentityBindings = z.record(z.string().regex(/^user_[a-z0-9]+$/i), z.object({
  principalId: z.string().uuid(),
  tenantId: z.string().uuid(),
  loginEmail: z.string().email(),
  canonicalEmail: z.string().email(),
}).strict());

let cachedKeys: { clientId: string; keys: ReturnType<typeof createRemoteJWKSet> } | undefined;

export async function verifyWorkOSIdentity(token: string): Promise<{ email: string; principalId: string; tenantId: string; deliverySession: { subject: string; sessionId: string; expiresAt: string } }> {
  const clientId = process.env.WORKOS_CLIENT_ID ?? "";
  const apiKey = process.env.WORKOS_API_KEY;
  if (!/^client_[a-z0-9]{26}$/i.test(clientId) || !apiKey) throw new Error("WORKOS_AUTH_NOT_CONFIGURED");
  if ((process.env.FINNOR_ENVIRONMENT === "production" || process.env.VERCEL_ENV === "production")
    && (process.env.WORKOS_ENVIRONMENT !== "production" || !/^sk_[A-Za-z0-9_+/=-]{20,}$/.test(apiKey)
      || apiKey.startsWith("sk_test_"))) throw new Error("WORKOS_PRODUCTION_ENVIRONMENT_REQUIRED");
  if (token.length > 16384) throw new Error("WORKOS_TOKEN_INVALID");
  if (cachedKeys?.clientId !== clientId) {
    cachedKeys = {
      clientId,
      keys: createRemoteJWKSet(new URL(`https://api.workos.com/sso/jwks/${clientId}`), { timeoutDuration: 5000 }),
    };
  }
  const issuers = (process.env.WORKOS_ISSUER ?? `https://api.workos.com/user_management/${clientId}`)
    .split(",").map(value => value.trim()).filter(Boolean);
  if (issuers.length === 0) throw new Error("WORKOS_AUTH_NOT_CONFIGURED");
  const { payload } = await jwtVerify(token, cachedKeys.keys, {
    issuer: issuers,
    algorithms: ["RS256"],
    requiredClaims: ["iss", "sub", "exp", "iat", "sid"],
  });
  if (typeof payload.sub !== "string" || !/^user_[a-z0-9]+$/i.test(payload.sub)
    || typeof payload.sid !== "string" || !/^session_[a-z0-9_]{1,100}$/i.test(payload.sid)
    || typeof payload.exp !== "number" || !Number.isSafeInteger(payload.exp)) throw new Error("WORKOS_TOKEN_INVALID");
  if (payload.aud !== undefined && payload.aud !== clientId
    && !(Array.isArray(payload.aud) && payload.aud.includes(clientId))) throw new Error("WORKOS_TOKEN_INVALID");

  const response = await fetch(`https://api.workos.com/user_management/users/${encodeURIComponent(payload.sub)}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(Math.min(5000, executionDeadlineMilliseconds() ?? 5000)),
  });
  if (!response.ok) throw new Error("WORKOS_IDENTITY_UNAVAILABLE");
  const user = WorkOSUser.parse(await response.json());
  if (user.id !== payload.sub) throw new Error("WORKOS_TOKEN_INVALID");
  const bindings = IdentityBindings.parse(JSON.parse(process.env.WORKOS_IDENTITY_BINDINGS ?? "{}"));
  const binding = bindings[user.id];
  if (!binding || binding.principalId !== user.external_id || binding.loginEmail.toLowerCase() !== user.email.toLowerCase()) {
    throw new Error("WORKOS_IDENTITY_NOT_LINKED");
  }
  // The delivery owner stores UUIDs. Stable, provider-namespaced session identity
  // lets its existing logout tombstone survive access-token refresh.
  const digest = createHash("sha256").update(JSON.stringify(["finnor-workos-delivery", clientId, payload.sub, payload.sid])).digest();
  digest[6] = (digest.readUInt8(6) & 0x0f) | 0x80;
  digest[8] = (digest.readUInt8(8) & 0x3f) | 0x80;
  const hex = digest.subarray(0, 16).toString("hex");
  const sessionId = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  return { email: binding.canonicalEmail, principalId: binding.principalId, tenantId: binding.tenantId,
    deliverySession: { subject: payload.sub, sessionId, expiresAt: new Date(payload.exp * 1000).toISOString() } };
}

import { GetWebIdentityTokenCommand, STSClient } from "@aws-sdk/client-sts";
import type { MicrosoftGraphAuthContext, ProviderAuthContext, MicrosoftDelegatedAuthContext } from "@finnor/security";
import { createHash, createSign, randomUUID, X509Certificate } from "node:crypto";
import { MicrosoftGraphError } from "./errors";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  usableUntil: number;
}

export interface MicrosoftGraphAccessToken {
  accessToken: string;
  expiresAt: string;
}

type StsSender = (context: Extract<ProviderAuthContext, { kind: "federated_workload" }>) => Promise<string>;
type TokenFetch = typeof fetch;

const tokenCache = new Map<string, CachedToken>();
const inflight = new Map<string, Promise<CachedToken>>();
let stsSenderOverride: StsSender | null = null;
let tokenFetchOverride: TokenFetch | null = null;

export function setMicrosoftIdentityTestOverrides(input: {
  stsSender?: StsSender | null;
  fetch?: TokenFetch | null;
}): void {
  if (Object.prototype.hasOwnProperty.call(input, "stsSender")) stsSenderOverride = input.stsSender ?? null;
  if (Object.prototype.hasOwnProperty.call(input, "fetch")) tokenFetchOverride = input.fetch ?? null;
}

export function clearMicrosoftGraphTokenCache(cacheKey?: string): void {
  if (cacheKey) {
    tokenCache.delete(cacheKey);
    inflight.delete(cacheKey);
  } else {
    tokenCache.clear();
    inflight.clear();
  }
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function certificateAssertion(context: Extract<ProviderAuthContext, { kind: "managed_certificate" }>): string {
  const now = Math.floor(Date.now() / 1_000);
  let thumbprint = context.certificateThumbprint;
  if (!thumbprint) {
    const certificate = new X509Certificate(context.certificatePem);
    thumbprint = createHash("sha1").update(certificate.raw).digest("base64url");
  } else if (/^[0-9a-f]{40}$/i.test(thumbprint)) {
    thumbprint = Buffer.from(thumbprint, "hex").toString("base64url");
  }
  const tokenEndpoint = `https://login.microsoftonline.com/${context.directoryTenantId}/oauth2/v2.0/token`;
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT", x5t: thumbprint }));
  const payload = base64url(JSON.stringify({
    aud: tokenEndpoint,
    iss: context.applicationClientId,
    sub: context.applicationClientId,
    jti: randomUUID(),
    nbf: now - 30,
    exp: now + 600,
  }));
  const unsigned = `${header}.${payload}`;
  try {
    const signature = createSign("RSA-SHA256").update(unsigned).end().sign(context.privateKeyPem);
    return `${unsigned}.${signature.toString("base64url")}`;
  } catch {
    throw new MicrosoftGraphError("blocked_config", "Microsoft certificate fallback cannot sign a client assertion", null, false);
  }
}

async function awsIdentityAssertion(context: Extract<ProviderAuthContext, { kind: "federated_workload" }>): Promise<string> {
  if (stsSenderOverride) return stsSenderOverride(context);
  const client = new STSClient({
    region: context.awsRegion,
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 6_000, requestTimeout: 15_000 },
  });
  try {
    const result = await client.send(new GetWebIdentityTokenCommand({
      Audience: [context.federationAudience],
      DurationSeconds: context.identityTokenDurationSeconds,
      SigningAlgorithm: context.signingAlgorithm,
    }));
    if (!result.WebIdentityToken) {
      throw new MicrosoftGraphError("auth", "AWS STS returned no outbound web identity token", null, false);
    }
    return result.WebIdentityToken;
  } catch (error) {
    if (error instanceof MicrosoftGraphError) throw error;
    const metadata = error && typeof error === "object" && "$metadata" in error
      ? (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      : undefined;
    const status = metadata?.httpStatusCode ?? null;
    const retryable = status === 429 || (status !== null && status >= 500);
    throw new MicrosoftGraphError("auth", "AWS outbound workload identity token acquisition failed", status, retryable);
  } finally {
    client.destroy();
  }
}

async function readBoundedJson(response: Response): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    throw new MicrosoftGraphError("invalid_response", "Microsoft identity token response content type was not JSON", response.status, false);
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 128 * 1024) {
    throw new MicrosoftGraphError("invalid_response", "Microsoft identity token response exceeded the allowed size", response.status, false);
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > 128 * 1024) {
          await reader.cancel();
          throw new MicrosoftGraphError("invalid_response", "Microsoft identity token response exceeded the allowed size", response.status, false);
        }
        chunks.push(chunk.value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    throw new MicrosoftGraphError("invalid_response", "Microsoft identity token response was not valid JSON", response.status, false);
  }
}

async function exchangeForGraphToken(context: ProviderAuthContext, assertion: string): Promise<CachedToken> {
  const tokenEndpoint = `https://login.microsoftonline.com/${context.directoryTenantId}/oauth2/v2.0/token`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await (tokenFetchOverride ?? fetch)(tokenEndpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        client_id: context.applicationClientId,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion,
      }),
    });
  } catch (error) {
    const timeoutFailure = error instanceof Error && error.name === "AbortError";
    throw new MicrosoftGraphError("auth", timeoutFailure ? "Microsoft identity token exchange timed out" : "Microsoft identity token exchange failed", null, true);
  } finally {
    clearTimeout(timeout);
  }
  const payload = await readBoundedJson(response);
  if (!response.ok) {
    const providerCode = typeof payload.error === "string" ? payload.error : undefined;
    const retryable = response.status === 429 || response.status >= 500;
    throw new MicrosoftGraphError("auth", "Microsoft Entra rejected the app-only token exchange", response.status, retryable, undefined, providerCode);
  }
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new MicrosoftGraphError("invalid_response", "Microsoft identity token envelope was incomplete", response.status, false);
  }
  const expiresInMs = Math.min(expiresIn * 1_000, 24 * 60 * 60_000);
  const expiresAt = Date.now() + expiresInMs;
  const safetyMargin = Math.min(5 * 60_000, Math.max(30_000, Math.floor(expiresInMs * 0.2)));
  return { accessToken, expiresAt, usableUntil: expiresAt - safetyMargin };
}

async function refreshDelegatedToken(context: MicrosoftDelegatedAuthContext, allowCurrent: boolean): Promise<CachedToken> {
  const currentExpiry = Date.parse(context.accessTokenExpiresAt ?? "");
  if (allowCurrent && context.accessToken && Number.isFinite(currentExpiry) && currentExpiry > Date.now() + 60_000) {
    return { accessToken: context.accessToken, expiresAt: currentExpiry, usableUntil: currentExpiry - 30_000 };
  }
  const tokenEndpoint = `https://login.microsoftonline.com/${context.directoryTenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: context.applicationClientId,
    grant_type: "refresh_token",
    refresh_token: context.refreshToken,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await (tokenFetchOverride ?? fetch)(tokenEndpoint, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body,
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    throw new MicrosoftGraphError("auth", timedOut ? "Microsoft delegated token refresh timed out" : "Microsoft delegated token refresh failed", null, true);
  } finally {
    clearTimeout(timeout);
  }
  const payload = await readBoundedJson(response);
  if (!response.ok) {
    const code = typeof payload.error === "string" ? payload.error : "delegated_refresh_failed";
    if (["invalid_grant", "interaction_required", "consent_required"].includes(code)) {
      await context.markReauthorizationRequired(code);
      throw new MicrosoftGraphError("auth", "Microsoft delegated authorization requires user reauthorization", response.status, false, undefined, code);
    }
    throw new MicrosoftGraphError("auth", "Microsoft Entra rejected delegated token refresh", response.status, response.status === 429 || response.status >= 500, undefined, code);
  }
  const accessToken = typeof payload.access_token === "string" ? payload.access_token : null;
  const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : undefined;
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new MicrosoftGraphError("invalid_response", "Microsoft delegated token envelope was incomplete", response.status, false);
  }
  const expiresInMs = Math.min(expiresIn * 1_000, 24 * 60 * 60_000);
  const expiresAt = Date.now() + expiresInMs;
  const expiresAtIso = new Date(expiresAt).toISOString();
  await context.persistTokens({ accessToken, expiresAt: expiresAtIso, ...(refreshToken ? { refreshToken } : {}) });
  return { accessToken, expiresAt, usableUntil: expiresAt - Math.min(300_000, Math.max(30_000, Math.floor(expiresInMs * 0.2))) };
}

async function acquireFresh(context: MicrosoftGraphAuthContext, allowDelegatedCurrent: boolean): Promise<CachedToken> {
  if (context.kind === "delegated_user") return refreshDelegatedToken(context, allowDelegatedCurrent);
  const assertion = context.kind === "federated_workload"
    ? await awsIdentityAssertion(context)
    : certificateAssertion(context);
  return exchangeForGraphToken(context, assertion);
}

/** Ephemeral, revision-keyed app-only Graph token. Nothing here persists tokens. */
export async function acquireMicrosoftGraphAccessToken(
  context: MicrosoftGraphAuthContext,
  forceRefresh = false,
): Promise<MicrosoftGraphAccessToken> {
  if (!forceRefresh) {
    const cached = tokenCache.get(context.cacheKey);
    if (cached && cached.usableUntil > Date.now()) {
      return { accessToken: cached.accessToken, expiresAt: new Date(cached.expiresAt).toISOString() };
    }
    const pending = inflight.get(context.cacheKey);
    if (pending) {
      const token = await pending;
      return { accessToken: token.accessToken, expiresAt: new Date(token.expiresAt).toISOString() };
    }
  } else {
    clearMicrosoftGraphTokenCache(context.cacheKey);
  }
  const pending = acquireFresh(context, !forceRefresh)
    .then((token) => {
      tokenCache.set(context.cacheKey, token);
      return token;
    })
    .finally(() => inflight.delete(context.cacheKey));
  inflight.set(context.cacheKey, pending);
  const token = await pending;
  return { accessToken: token.accessToken, expiresAt: new Date(token.expiresAt).toISOString() };
}

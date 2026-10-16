/**
 * Disposable GoTrue-compatible HTTP boundary, not a product/API stub.
 * No environment reads, DB access, logging, filesystem writes or import-time effects.
 * See scope-frontier5/x2-software-semantics-compiler/mounted-work-contract.md.
 * Runtime proof is caller-owned.
 */
import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type ServerOptions as TlsOptions } from "node:https";
import { inspect } from "node:util";

export interface FixtureIdentity {
  readonly userId: string;
  readonly email: string;
  readonly password: string;
}
export interface AuthIssue {
  readonly issueId: number;
  readonly userId: string;
  /** Digest of an opaque login family, not a credential or raw session_id. */
  readonly sessionRef: string;
  readonly generation: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
}
declare const opaqueAuthSession: unique symbol;
export interface AuthSessionHandle extends AuthIssue { readonly [opaqueAuthSession]: true }
export interface AuthObservation {
  readonly sequence: number;
  readonly at: string;
  readonly event: "password" | "refresh" | "user" | "logout" | "options" | "refusal" | "operator-revoke";
  readonly status: number;
  readonly userId?: string;
  readonly issueId?: number;
  readonly sessionRef?: string;
  readonly generation?: number;
  readonly expiresAt?: number;
  readonly reason?: string;
  readonly refreshOnly?: boolean;
  readonly caller?: "BROWSER" | "BACKEND_SDK" | "PRIVATE_HANDLE" | "OTHER_SERVER";
  readonly sdkVersion?: string;
}
export interface AuthenticatedHttpFixtureOptions {
  readonly frontendOrigin: string;
  /** These must be the two actual canonical active owner identities, not invented JWT subjects. */
  readonly identities: readonly [FixtureIdentity, FixtureIdentity];
  readonly port?: number;
  readonly accessTokenLifetimeSeconds?: number;
  readonly refreshTokenLifetimeSeconds?: number;
  readonly allowedApiOrigins?: readonly string[];
  /** Already-owned trusted material in memory only; no certificate discovery. */
  readonly tls?: Pick<TlsOptions, "key" | "cert">;
  readonly maxObservations?: number;
}
export interface AuthenticatedHttpFixture {
  readonly origin: string;
  readonly frontendOrigin: string;
  /** Disposable browser-publishable key; deliberately non-enumerable. */
  readonly publicAnonKey: string;
  readonly private: {
    credentials(userId: string): Readonly<{ email: string; password: string }>;
    nextPasswordAccessLifetime(userId: string, seconds: number): void;
    passwordSignIn(userId: string): Promise<AuthSessionHandle>;
    refresh(handle: AuthSessionHandle): Promise<AuthSessionHandle>;
    logout(handle: AuthSessionHandle): Promise<void>;
    sessionForIssue(issueId: number): AuthSessionHandle;
    accessToken(handle: AuthSessionHandle): string;
    describeAccessToken(token: string): (AuthIssue & { valid: boolean; reason?: string }) | null;
    probeUser(handle: AuthSessionHandle): Promise<{ status: number; code: string | null }>;
    allowApiOrigin(origin: string): void;
    call(handle: AuthSessionHandle, url: string, init?: RequestInit): Promise<Response>;
    revokeUserSessions(userId: string): void;
  };
  cursor(): number;
  observations(after?: number): readonly AuthObservation[];
  summary(): { issued: number; activeFamilies: number; observations: number; overflow: boolean };
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedHeaders = new Set([
  "authorization", "apikey", "content-type", "x-client-info", "x-supabase-api-version",
  "x-supabase-client-platform", "x-supabase-client-platform-version",
  "x-supabase-client-runtime", "x-supabase-client-runtime-version",
]);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const seconds = () => Math.floor(Date.now() / 1_000);
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const same = (left: string, right: string) => timingSafeEqual(
  createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest(),
);
function originOnly(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "localhost"].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("OWNED_LOOPBACK_ORIGIN_REQUIRED");
  }
  return url.origin;
}
function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error("AUTH_FIXTURE_BOUND_REQUIRED");
  return value;
}
function privateValue<T extends object>(value: T, label: string): T {
  const result = Object.create(null) as T;
  for (const [key, item] of Object.entries(value)) Object.defineProperty(result, key, { value: item });
  Object.defineProperty(result, "toJSON", { value: () => ({ private: label }) });
  Object.defineProperty(result, inspect.custom, { value: () => `[Private ${label}]` });
  return Object.freeze(result);
}
class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
    throw new HttpFailure(415, "json_required");
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 16_384) throw new HttpFailure(413, "body_bound");
    chunks.push(buffer);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new HttpFailure(400, "invalid_json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpFailure(400, "object_required");
  return parsed as Record<string, unknown>;
}

export async function startAuthenticatedHttpFixture(options: AuthenticatedHttpFixtureOptions): Promise<AuthenticatedHttpFixture> {
  const frontendOrigin = originOnly(options.frontendOrigin);
  const accessLifetime = boundedInteger(options.accessTokenLifetimeSeconds ?? 300, 2, 3_600);
  const refreshLifetime = boundedInteger(options.refreshTokenLifetimeSeconds ?? 3_600, 60, 86_400);
  const maxObservations = boundedInteger(options.maxObservations ?? 10_000, 100, 50_000);
  const port = boundedInteger(options.port ?? 0, 0, 65_535);
  if (options.identities.length !== 2 || new Set(options.identities.map(value => value.userId)).size !== 2
    || new Set(options.identities.map(value => value.email.toLowerCase())).size !== 2) {
    throw new Error("TWO_DISTINCT_CANONICAL_IDENTITIES_REQUIRED");
  }
  for (const identity of options.identities) {
    if (!UUID.test(identity.userId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email)
      || identity.email.length > 320 || identity.password.length < 16 || identity.password.length > 256) {
      throw new Error("CANONICAL_SYNTHETIC_IDENTITY_REQUIRED");
    }
  }
  const identities = new Map(options.identities.map(value => [value.userId, { ...value }]));
  const apiOrigins = new Set((options.allowedApiOrigins ?? []).map(originOnly));
  if (apiOrigins.size > 4) throw new Error("API_ORIGIN_BOUND");
  const secret = randomBytes(32);
  const publicAnonKey = `disposable-x2-${randomBytes(24).toString("base64url")}`;
  const createdAt = new Date().toISOString();
  const users = new Map(options.identities.map(identity => [identity.userId, {
    id: identity.userId, email: identity.email, aud: "authenticated", role: "authenticated",
    app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {},
    created_at: createdAt, updated_at: createdAt, confirmed_at: createdAt, email_confirmed_at: createdAt,
    is_anonymous: false,
    identities: [{ id: identity.userId, identity_id: randomUUID(), user_id: identity.userId, provider: "email",
      identity_data: { sub: identity.userId, email: identity.email, email_verified: true }, created_at: createdAt }],
  }]));
  type Family = { id: string; userId: string; live: boolean; generation: number; startedAt: number };
  type Issued = { handle: AuthSessionHandle; family: Family; access: string; refresh: string };
  type Refresh = { family: Family; expiresAt: number; used: boolean };
  const families = new Map<string, Family>();
  const refreshes = new Map<string, Refresh>();
  const issued = new Map<number, Issued>();
  const accessIndex = new Map<string, Issued>();
  const nextLifetimes = new Map<string, number>();
  const events: AuthObservation[] = [];
  let sequence = 0, issueSequence = 0, overflow = false, closed = false, origin = "";
  const assertOpen = () => { if (closed) throw new Error("AUTH_FIXTURE_CLOSED"); };
  const identityFor = (userId: string) => {
    assertOpen();
    const identity = identities.get(userId);
    if (!identity) throw new Error("CANONICAL_FIXTURE_IDENTITY_REQUIRED");
    return identity;
  };
  const observe = (event: Omit<AuthObservation, "sequence" | "at">) => {
    if (events.length >= maxObservations) { overflow = true; return; }
    events.push(Object.freeze({ sequence: ++sequence, at: new Date().toISOString(), ...event }));
  };
  const revoke = (userId: string) => {
    for (const family of families.values()) if (family.userId === userId) family.live = false;
  };
  function issue(family: Family, lifetime: number): Issued {
    if (issued.size >= 4_096) throw new HttpFailure(503, "issuance_bound");
    const issuedAt = seconds(), expiresAt = issuedAt + lifetime, nonce = randomUUID();
    const identity = identityFor(family.userId);
    const input = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
      iss: `${origin}/auth/v1`, aud: "authenticated", role: "authenticated",
      sub: identity.userId, email: identity.email, iat: issuedAt, exp: expiresAt,
      session_id: family.id, jti: nonce, aal: "aal1", amr: [{ method: "password", timestamp: family.startedAt }],
    })}`;
    const access = `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
    const refresh = randomBytes(32).toString("base64url");
    const handle = Object.freeze({
      issueId: ++issueSequence, userId: identity.userId, sessionRef: digest(family.id),
      generation: family.generation, issuedAt, expiresAt,
    }) as AuthSessionHandle;
    const value = { handle, family, access, refresh };
    issued.set(handle.issueId, value);
    accessIndex.set(digest(access), value);
    refreshes.set(digest(refresh), { family, expiresAt: issuedAt + refreshLifetime, used: false });
    return value;
  }
  function verify(token: string): { issued?: Issued; code?: string } {
    try {
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return { code: "bad_jwt" };
      const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
      const signature = Buffer.from(signaturePart, "base64url");
      const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest();
      if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) return { code: "bad_jwt" };
      const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
      const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
      const value = accessIndex.get(digest(token));
      if (header.alg !== "HS256" || header.typ !== "JWT" || !value
        || claims.iss !== `${origin}/auth/v1` || claims.aud !== "authenticated" || claims.role !== "authenticated"
        || claims.sub !== value.handle.userId || claims.email !== identities.get(value.handle.userId)?.email
        || claims.session_id !== value.family.id || claims.exp !== value.handle.expiresAt
        || claims.iat !== value.handle.issuedAt) return { code: "bad_jwt" };
      if (claims.exp <= seconds()) return { issued: value, code: "jwt_expired" };
      if (!value.family.live) return { issued: value, code: "session_not_found" };
      return { issued: value };
    } catch { return { code: "bad_jwt" }; }
  }
  function bearer(req: IncomingMessage): string {
    const value = req.headers.authorization;
    if (typeof value !== "string" || !/^Bearer [A-Za-z0-9_.-]+$/i.test(value)) throw new HttpFailure(401, "bad_jwt");
    return value.slice(7);
  }
  function tokenResponse(value: Issued) {
    return {
      access_token: value.access, refresh_token: value.refresh, token_type: "bearer",
      expires_in: value.handle.expiresAt - value.handle.issuedAt, expires_at: value.handle.expiresAt,
      user: { ...users.get(value.handle.userId)!, last_sign_in_at: new Date(value.family.startedAt * 1_000).toISOString() },
    };
  }
  async function handler(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("cache-control", "no-store");
    res.setHeader("content-type", "application/json");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-supabase-api-version", "2024-01-01");
    res.setHeader("vary", "Origin");
    let event: AuthObservation["event"] = "refusal", value: Issued | undefined, userId: string | undefined;
    let refreshOnly: boolean | undefined;
    const clientInfo = String(req.headers["x-client-info"] ?? "");
    const sdkVersion = /^(?:supabase-js-(?:web|node)\/|supabase-js\/)(\d+\.\d+\.\d+)(?:;|$)/.exec(clientInfo)?.[1];
    const caller: AuthObservation["caller"] = req.headers["x-finnor-fixture-client"] === "private-handle" ? "PRIVATE_HANDLE"
      : req.headers.origin === frontendOrigin ? "BROWSER"
        : sdkVersion && /^(?:supabase-js-node\/)|;\s*runtime=node(?:;|$)/.test(clientInfo) ? "BACKEND_SDK" : "OTHER_SERVER";
    const finish = (status: number, payload: unknown, reason?: string) => {
      observe({ event, status, ...(value ? value.handle : {}), ...(userId ? { userId } : {}),
        caller, ...(sdkVersion ? { sdkVersion } : {}), ...(reason ? { reason } : {}),
        ...(refreshOnly !== undefined ? { refreshOnly } : {}) });
      if (reason) res.setHeader("x-sb-error-code", reason === "jwt_expired" ? "bad_jwt" : reason);
      res.writeHead(status);
      res.end(status === 204 ? undefined : JSON.stringify(payload));
    };
    try {
      if (closed) throw new HttpFailure(503, "fixture_closed");
      if (overflow || events.length >= maxObservations) { overflow = true; throw new HttpFailure(503, "observation_bound"); }
      const requestOrigin = req.headers.origin;
      if (requestOrigin && requestOrigin !== frontendOrigin) throw new HttpFailure(403, "origin_refused");
      res.setHeader("access-control-allow-origin", frontendOrigin);
      const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
      const expectedMethod = url.pathname === "/auth/v1/user" ? "GET"
        : ["/auth/v1/token", "/auth/v1/logout"].includes(url.pathname) ? "POST" : null;
      if (!expectedMethod) throw new HttpFailure(404, "route_not_found");
      if (req.method === "OPTIONS") {
        event = "options";
        const headers = String(req.headers["access-control-request-headers"] ?? "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean);
        if (requestOrigin !== frontendOrigin || req.headers["access-control-request-method"] !== expectedMethod
          || headers.some(header => !allowedHeaders.has(header))) throw new HttpFailure(403, "preflight_refused");
        res.setHeader("access-control-allow-methods", `${expectedMethod}, OPTIONS`);
        res.setHeader("access-control-allow-headers", [...allowedHeaders].join(", "));
        finish(204, null); return;
      }
      if (req.method !== expectedMethod) throw new HttpFailure(405, "method_refused");
      if (!same(String(req.headers.apikey ?? ""), publicAnonKey)) throw new HttpFailure(401, "invalid_api_key");
      if (url.pathname === "/auth/v1/token") {
        const input = await jsonBody(req), grant = url.searchParams.get("grant_type");
        if (grant === "password") {
          event = "password";
          const identity = [...identities.values()].find(item => typeof input.email === "string" && same(input.email, item.email));
          if (!identity || typeof input.password !== "string" || !same(input.password, identity.password)) {
            throw new HttpFailure(400, "invalid_credentials");
          }
          userId = identity.userId;
          if (families.size >= 256) throw new HttpFailure(503, "session_bound");
          const family: Family = { id: randomUUID(), userId, live: true, generation: 0, startedAt: seconds() };
          families.set(family.id, family);
          value = issue(family, nextLifetimes.get(userId) ?? accessLifetime);
          nextLifetimes.delete(userId);
        } else if (grant === "refresh_token") {
          event = "refresh";
          refreshOnly = !Object.hasOwn(input, "password") && !Object.hasOwn(input, "email") && typeof input.refresh_token === "string";
          if (!refreshOnly) {
            throw new HttpFailure(400, "refresh_only_required");
          }
          const refresh = refreshes.get(digest(input.refresh_token as string));
          if (!refresh) throw new HttpFailure(400, "refresh_token_not_found");
          userId = refresh.family.userId;
          if (refresh.used) { refresh.family.live = false; throw new HttpFailure(400, "refresh_token_already_used"); }
          if (!refresh.family.live || refresh.expiresAt <= seconds()) throw new HttpFailure(400, "refresh_token_not_found");
          refresh.used = true;
          refresh.family.generation++;
          value = issue(refresh.family, accessLifetime);
        } else throw new HttpFailure(400, "unsupported_grant_type");
        finish(200, tokenResponse(value)); return;
      }
      const checked = verify(bearer(req));
      value = checked.issued;
      if (checked.code || !value) throw new HttpFailure(401, checked.code ?? "bad_jwt");
      userId = value.handle.userId;
      if (url.pathname === "/auth/v1/user") {
        event = "user";
        finish(200, users.get(userId)); return;
      }
      event = "logout";
      if ((url.searchParams.get("scope") ?? "global") !== "global") throw new HttpFailure(400, "global_scope_required");
      revoke(userId);
      finish(204, null);
    } catch (error) {
      const failure = error instanceof HttpFailure ? error : new HttpFailure(500, "fixture_internal_error");
      const message = failure.code === "invalid_credentials" ? "Invalid login credentials" : "Disposable authentication request refused";
      finish(failure.status, { code: failure.code === "jwt_expired" ? "bad_jwt" : failure.code,
        msg: message, message, error: "invalid_grant", error_description: message }, failure.code);
    }
  }
  const server = options.tls ? createHttpsServer(options.tls, (req, res) => { void handler(req, res); })
    : createServer((req, res) => { void handler(req, res); });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((yes, no) => {
    const fail = (error: Error) => { server.off("listening", ready); no(error); };
    const ready = () => { server.off("error", fail); yes(); };
    server.once("error", fail); server.once("listening", ready); server.listen(port, "127.0.0.1");
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("AUTH_FIXTURE_OWNED_PORT_REQUIRED");
  origin = `${options.tls ? "https" : "http"}://127.0.0.1:${address.port}`;

  const stored = (handle: AuthSessionHandle) => {
    assertOpen();
    const value = issued.get(handle.issueId);
    if (!value || value.handle !== handle) throw new Error("PRIVATE_FIXTURE_SESSION_HANDLE_REQUIRED");
    return value;
  };
  async function authRequest(path: string, init: RequestInit): Promise<Response> {
    assertOpen();
    const headers = new Headers(init.headers);
    headers.set("apikey", publicAnonKey);
    headers.set("x-finnor-fixture-client", "private-handle");
    return fetch(`${origin}/auth/v1/${path}`, {
      ...init, redirect: "error", signal: AbortSignal.timeout(5_000), headers,
    });
  }
  async function responseHandle(response: Response): Promise<AuthSessionHandle> {
    if (!response.ok) throw new Error(`AUTH_FIXTURE_GRANT_REFUSED_${response.status}`);
    const data = await response.json() as { access_token?: unknown };
    const value = typeof data.access_token === "string" ? accessIndex.get(digest(data.access_token)) : undefined;
    if (!value) throw new Error("AUTH_FIXTURE_ISSUED_RESPONSE_REQUIRED");
    return value.handle;
  }
  const fixture = {
    origin, frontendOrigin, publicAnonKey,
    private: Object.freeze({
      credentials(userId: string) {
        const { email, password } = identityFor(userId);
        return privateValue({ email, password }, "fixture credentials");
      },
      nextPasswordAccessLifetime(userId: string, lifetime: number) {
        identityFor(userId);
        nextLifetimes.set(userId, boundedInteger(lifetime, 2, 3_600));
      },
      async passwordSignIn(userId: string) {
        const { email, password } = identityFor(userId);
        return responseHandle(await authRequest("token?grant_type=password", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
        }));
      },
      async refresh(handle: AuthSessionHandle) {
        return responseHandle(await authRequest("token?grant_type=refresh_token", {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refresh_token: stored(handle).refresh }),
        }));
      },
      async logout(handle: AuthSessionHandle) {
        const response = await authRequest("logout?scope=global", { method: "POST", headers: { authorization: `Bearer ${stored(handle).access}` } });
        if (response.status !== 204) throw new Error(`AUTH_FIXTURE_LOGOUT_REFUSED_${response.status}`);
      },
      sessionForIssue(issueId: number) {
        assertOpen();
        const value = issued.get(issueId);
        if (!value) throw new Error("AUTH_FIXTURE_ISSUE_REQUIRED");
        return value.handle;
      },
      accessToken(handle: AuthSessionHandle) { return stored(handle).access; },
      describeAccessToken(token: string) {
        assertOpen();
        const result = verify(token);
        return result.issued ? { ...result.issued.handle, valid: !result.code, ...(result.code ? { reason: result.code } : {}) } : null;
      },
      async probeUser(handle: AuthSessionHandle) {
        const response = await authRequest("user", { method: "GET", headers: { authorization: `Bearer ${stored(handle).access}` } });
        const body = await response.json() as { code?: unknown };
        return { status: response.status, code: typeof body.code === "string" ? body.code : null };
      },
      allowApiOrigin(value: string) {
        assertOpen();
        if (apiOrigins.size >= 4 && !apiOrigins.has(originOnly(value))) throw new Error("API_ORIGIN_BOUND");
        apiOrigins.add(originOnly(value));
      },
      async call(handle: AuthSessionHandle, url: string, init: RequestInit = {}) {
        const target = new URL(url);
        if (target.username || target.password || !apiOrigins.has(target.origin)) throw new Error("EXPLICIT_OWNED_API_ORIGIN_REQUIRED");
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${stored(handle).access}`);
        return fetch(target, { ...init, headers, redirect: "error", signal: init.signal ?? AbortSignal.timeout(30_000) });
      },
      revokeUserSessions(userId: string) {
        identityFor(userId); revoke(userId);
        observe({ event: "operator-revoke", status: 204, userId });
      },
    }),
    cursor: () => sequence,
    observations: (after = 0) => events.filter(event => event.sequence > after).map(event => ({ ...event })),
    summary: () => ({ issued: issueSequence, activeFamilies: [...families.values()].filter(value => value.live).length,
      observations: events.length, overflow }),
    async close() {
      if (closed) return;
      closed = true;
      for (const family of families.values()) family.live = false;
      try {
        await new Promise<void>((yes, no) => {
          const timeout = setTimeout(() => no(new Error("AUTH_FIXTURE_CLOSE_TIMEOUT")), 5_000);
          server.close(() => { clearTimeout(timeout); yes(); }); server.closeAllConnections();
        });
      } finally {
        secret.fill(0);
        identities.clear(); users.clear(); nextLifetimes.clear(); refreshes.clear(); issued.clear(); accessIndex.clear(); families.clear();
      }
    },
  };
  Object.defineProperty(fixture, "publicAnonKey", { enumerable: false });
  return Object.freeze(fixture);
}

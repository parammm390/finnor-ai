/** Owned local asymmetric issuer and real bearer/user authentication, no bypass. */
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";
import type pg from "pg";

export async function httpFixture(admin: pg.Client) {
  const keys = await generateKeyPair("RS256"), kid = randomUUID();
  const jwk = { ...await exportJWK(keys.publicKey), kid, alg: "RS256", use: "sig" };
  const users = new Map<string, { id: string; email: string }>();
  const observed: any = { authenticatedUsers: 0, signatureRefusals: 0, calls: [] };
  let authOrigin = "";
  const auth = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/auth/v1/.well-known/jwks.json") return res.end(JSON.stringify({ keys: [jwk] }));
    if (req.url !== "/auth/v1/user") { res.writeHead(404); res.end("{}"); return; }
    try {
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const { payload } = await jwtVerify(bearer, keys.publicKey, {
        issuer: authOrigin + "/auth/v1", audience: "authenticated",
      });
      const user = users.get(String(payload.sub));
      if (!user) throw Error("ACTUAL_DISPOSABLE_USER_REQUIRED");
      observed.authenticatedUsers++;
      res.end(JSON.stringify({ ...user, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} }));
    } catch {
      observed.signatureRefusals++;
      res.writeHead(401); res.end('{"msg":"Invalid JWT"}');
    }
  });
  async function listen(server: Server) {
    await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("OWNED_LOOPBACK_PORT_REQUIRED");
    return "http://127.0.0.1:" + address.port;
  }
  authOrigin = await listen(auth);
  process.env.AUTH_DEV_BYPASS = "0";
  process.env.SUPABASE_URL = authOrigin;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "r4-disposable-auth-only";
  process.env.RATE_LIMIT_PER_MINUTE = "100000";
  process.env.RATE_LIMIT_IP_PER_MINUTE = "100000";
  async function issue(tenant: string, id: string) {
    const user = (await admin.query("SELECT id,email FROM finnor_os.users WHERE tenant_id=$1 AND id=$2", [tenant, id])).rows[0];
    if (!user) throw Error("DISPOSABLE_USER_NOT_FOUND");
    users.set(id, user);
    return new SignJWT({ email: user.email, role: "authenticated" }).setProtectedHeader({ alg: "RS256", kid })
      .setSubject(id).setIssuer(authOrigin + "/auth/v1").setAudience("authenticated")
      .setIssuedAt().setExpirationTime("1h").sign(keys.privateKey);
  }
  const route = await import("../../apps/api/app/api/identification-plans/[operation]/route");
  const api = createServer(async (req, res) => {
    try {
      if (req.method !== "POST") { res.writeHead(405); res.end("{}"); return; }
      const operation = new URL(req.url ?? "/", "http://127.0.0.1").pathname.split("/").at(-1)!;
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(key, value);
      // Preserve streaming and let the actual route enforce its registered bound.
      const { Readable } = await import("node:stream");
      const request = new Request("http://127.0.0.1/api/identification-plans/" + operation,
        { method: "POST", headers, body: Readable.toWeb(req), duplex: "half" } as RequestInit);
      const begin = performance.now(), response = await route.POST(request, { params: Promise.resolve({ operation }) });
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
      observed.calls.push({ operation, status: response.status, elapsedMs: performance.now() - begin });
    } catch { res.writeHead(500); res.end('{"code":"R4_OWNED_HTTP_FIXTURE_FAILURE"}'); }
  });
  const origin = await listen(api);
  async function call(f: any, operation: string, body: unknown, options: { bearer?: string | null; claimedTenant?: string; claimedPrincipal?: string } = {}) {
    const headers: Record<string, string> = { "content-type": "application/json",
      "x-tenant-id": options.claimedTenant ?? f.tenant, "x-user-id": options.claimedPrincipal ?? f.principal, "x-user-role": "owner" };
    const bearer = options.bearer === undefined ? f.bearer : options.bearer;
    if (bearer) headers.authorization = "Bearer " + bearer;
    const response = await fetch(origin + "/api/identification-plans/" + operation, {
      method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, body: await response.json() as any };
  }
  return { origin, authOrigin, issue, call, observed, close: async () => {
    for (const server of [api, auth]) { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); }
  } };
}

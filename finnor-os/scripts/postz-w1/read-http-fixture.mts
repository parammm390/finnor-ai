/** Loopback transport only. Production route, bearer resolver and SQL remain real. */
import { createServer, type Server } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type pg from "pg";

export async function economicReadHttpFixture(admin: pg.Client, actor: string, foreignActor: string, additionalActors: { peer: string; scoped: string }) {
  const users = (await admin.query<{ id: string; email: string }>(
    "SELECT id,email FROM finnor_os.users WHERE id=ANY($1::uuid[])", [[actor, foreignActor, additionalActors.peer, additionalActors.scoped]])).rows;
  const secret = randomBytes(32);
  const observed = { authRequests: 0, refusedSignatures: 0, api: [] as Array<{ method: string; path: string; status: number }> };
  const listen = async (server: Server) => {
    await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
    const address = server.address();
    if (!address || typeof address === "string") throw Error("LOCAL_PORT_REQUIRED");
    return `http://127.0.0.1:${address.port}`;
  };
  const auth = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url !== "/auth/v1/user") { res.writeHead(404); res.end("{}"); return; }
    observed.authRequests++;
    try {
      const [header, payload, signature] = String(req.headers.authorization ?? "").replace(/^Bearer /, "").split(".");
      if (!header || !payload || !signature) throw Error("SIGNATURE_REQUIRED");
      const actual = Buffer.from(signature, "base64url"), expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error("SIGNATURE_INVALID");
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      const user = users.find(row => row.id === claims.sub);
      if (!user || claims.exp <= Date.now() / 1000) throw Error("USER_INVALID");
      res.end(JSON.stringify({ id: user.id, email: user.email, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {} }));
    } catch { observed.refusedSignatures++; res.writeHead(401); res.end('{"msg":"Invalid JWT"}'); }
  });
  const authOrigin = await listen(auth);
  const prior = Object.fromEntries(["AUTH_DEV_BYPASS", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "RATE_LIMIT_PER_MINUTE", "RATE_LIMIT_IP_PER_MINUTE"].map(key => [key, process.env[key]]));
  process.env.AUTH_DEV_BYPASS = "0"; process.env.SUPABASE_URL = authOrigin;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "postz-w1-owned-disposable-auth";
  process.env.RATE_LIMIT_PER_MINUTE = "100000"; process.env.RATE_LIMIT_IP_PER_MINUTE = "100000";
  const issue = (id: string) => {
    const user = users.find(row => row.id === id);
    if (!user) throw Error("REAL_USER_REQUIRED");
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1000);
    const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: id, email: user.email, aud: "authenticated", role: "authenticated", iat: now, exp: now + 1800, iss: `${authOrigin}/auth/v1` })}`;
    return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  };
  const tokens = { actor: issue(actor), foreign: issue(foreignActor), peer: issue(additionalActors.peer), scoped: issue(additionalActors.scoped) };
  const forged = `${tokens.actor.split(".").slice(0, 2).join(".")}.${randomBytes(32).toString("base64url")}`;
  const headers = (identity: "actor" | "foreign" | "peer" | "scoped" | "anonymous" | "invalid" = "actor") => {
    const result: Record<string, string> = { "content-type": "application/json", "x-user-id": actor, "x-user-role": "owner" };
    if (identity !== "anonymous") result.authorization = `Bearer ${identity === "invalid" ? forged : tokens[identity]}`;
    return result;
  };
  const responseHeaders = (value: Headers) => {
    const result: Record<string, string> = {};
    value.forEach((entry, key) => { result[key] = entry; });
    return result;
  };
  const routes = new Map<string, (req: Request) => Promise<Response>>([
    ["/api/queries", (await import("../../apps/api/app/api/queries/route")).POST],
    ["/api/actions", (await import("../../apps/api/app/api/actions/route")).POST],
  ]);
  const listWork = (await import("../../apps/api/app/api/works/route")).GET;
  const readPrivateQuery = (await import("../../apps/api/app/api/queries/route")).GET;
  const readWork = (await import("../../apps/api/app/api/works/[id]/route")).GET;
  const execution = (await import("../../apps/api/app/api/works/[id]/execution/route")).GET;
  const retryWork = (await import("../../apps/api/app/api/works/[id]/retry/route")).POST;
  const api = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    try {
      const exact = req.method === "POST" ? routes.get(path) : undefined;
      const match = /^\/api\/works\/([0-9a-f-]{36})(?:\/(execution|retry))?$/i.exec(path);
      const handler = req.method === "GET" && path === "/api/queries" ? readPrivateQuery
        : req.method === "GET" && path === "/api/works" ? listWork
        : match && req.method === "GET" && !match[2] ? (input: Request) => readWork(input, { params: Promise.resolve({ id: match[1]! }) })
        : match && req.method === "GET" && match[2] === "execution" ? (input: Request) => execution(input, { params: Promise.resolve({ id: match[1]! }) })
        : match && req.method === "POST" && match[2] === "retry" ? (input: Request) => retryWork(input, { params: Promise.resolve({ id: match[1]! }) })
        : exact;
      if (!handler) { res.writeHead(404); res.end("{}"); return; }
      let body = "";
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) throw Error("REQUEST_BOUND"); }
      const copied = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === "string") copied.set(key, value);
      const response = await handler(new Request(`http://127.0.0.1${req.url}`, {
        method: req.method, headers: copied, ...(req.method === "POST" ? { body } : {}),
      }));
      observed.api.push({ method: req.method ?? "", path, status: response.status });
      res.writeHead(response.status, responseHeaders(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ code: "OWNED_HTTP_FIXTURE_FAILURE", error: String(error) })); }
  });
  const origin = await listen(api);
  return {
    observed,
    async call(path: "/api/queries" | "/api/actions" | `/api/works/${string}/retry`, body: unknown, identity: Parameters<typeof headers>[0] = "actor") {
      const response = await fetch(`${origin}${path}`, { method: "POST", headers: headers(identity), body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      return { status: response.status, headers: responseHeaders(response.headers), body: await response.json() as any };
    },
    async get(path: "/api/works" | `/api/works/${string}` | `/api/queries?${string}`, identity: Parameters<typeof headers>[0] = "actor") {
      const response = await fetch(`${origin}${path}`, { headers: headers(identity), signal: AbortSignal.timeout(30000) });
      return { status: response.status, headers: responseHeaders(response.headers), body: await response.json() as any };
    },
    async context(identity: Parameters<typeof headers>[0] = "actor") {
      return (await import("../../apps/api/lib/auth")).requireContext(new Request(`${origin}/api/queries`, { headers: headers(identity) }));
    },
    async close() {
      for (const server of [api, auth]) { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); }
      for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    },
  };
}

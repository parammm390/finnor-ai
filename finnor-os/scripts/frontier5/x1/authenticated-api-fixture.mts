/** Established LOCAL_AUTH_SERVICE transport from P1: actual handlers and bearer
 * verification, no reconstructed business API/owner/queue or completion mock. */
import { createServer } from "node:http";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export async function authenticatedApiFixture(repo: string, actor: string, record: (entry: unknown) => void,
  options: { frontendOrigin?: string; afterResponse?: (path:string,body:string,status:number)=>Promise<void> } = {}) {
  const secret = randomBytes(32), password = randomBytes(24).toString("hex"), email = actor + "@test.invalid";
  const refreshToken=randomBytes(32).toString('base64url');
  if(options.frontendOrigin&&!/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(options.frontendOrigin))
    throw Error('X1_OWNED_LOOPBACK_FRONTEND_REQUIRED');
  const user = { id: actor, aud: "authenticated", role: "authenticated", email,
    app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {},
    created_at: new Date().toISOString(), email_confirmed_at: new Date().toISOString() };
  const issue = () => {
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"), now = Math.floor(Date.now() / 1000);
    const body = encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ sub: actor, email,
      aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600 });
    return body + "." + createHmac("sha256", secret).update(body).digest("base64url");
  };
  const verify = (token: string) => {
    try { const [h, p, s] = token.split("."); if (!h || !p || !s) return false;
      const expected = createHmac("sha256", secret).update(h + "." + p).digest(), actual = Buffer.from(s, "base64url");
      const claims = JSON.parse(Buffer.from(p, "base64url").toString());
      return actual.length === expected.length && timingSafeEqual(actual, expected) && claims.sub === actor && claims.exp > Date.now() / 1000;
    } catch { return false; }
  };
  const listen = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw Error("LOCAL_PORT_UNAVAILABLE");
    return `http://127.0.0.1:${address.port}`;
  };
  const auth = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if(options.frontendOrigin){res.setHeader('access-control-allow-origin',options.frontendOrigin);
      res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');
      res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');res.setHeader('vary','Origin');}
    try {
      if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
      let raw = ""; for await (const b of req) { raw += b; if (raw.length > 16384) throw Error("AUTH_BODY_BOUND"); }
      if (req.url?.startsWith("/auth/v1/token")) {
        const input = JSON.parse(raw || "{}");
        const grant=new URL(req.url,'http://127.0.0.1').searchParams.get('grant_type');
        const allowed=grant==='password'&&input.email===email&&input.password===password
          ||grant==='refresh_token'&&input.refresh_token===refreshToken;
        if (!allowed) { res.writeHead(400); res.end('{"error":"invalid_credentials"}'); return; }
        record({path:'/auth/v1/token',method:req.method,grant,status:200,credentialsRecorded:false});
        res.end(JSON.stringify({ access_token: issue(), token_type: "bearer", expires_in: 3600,
          expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:refreshToken,user })); return;
      }
      if (req.url === "/auth/v1/user" && verify(String(req.headers.authorization ?? "").replace(/^Bearer /, ""))) {
        res.end(JSON.stringify(user)); return;
      }
      if(req.url?.startsWith('/auth/v1/logout')&&verify(String(req.headers.authorization??'').replace(/^Bearer /,''))){
        res.end('{}');return;}
      res.writeHead(401); res.end('{"error":"invalid_token"}');
    } catch { res.writeHead(400); res.end('{"error":"bad_request"}'); }
  });
  const authOrigin = await listen(auth);
  process.env.AUTH_DEV_BYPASS = "0"; process.env.SUPABASE_URL = authOrigin;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "disposable-local-auth-key";
  const apiRoot = join(repo, "finnor-os/apps/api/app/api"), routes: Array<{ file: string; parts: string[] }> = [];
  const scan = async (directory: string) => { for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name); if (item.isDirectory()) await scan(path);
    else if (item.name === "route.ts") routes.push({ file: path, parts: relative(apiRoot, directory).split("/") });
  } };
  await scan(apiRoot); routes.sort((a, b) => a.parts.filter(p => p.startsWith("[")).length - b.parts.filter(p => p.startsWith("[")).length);
  const api = createServer(async (req, res) => {
    const started = performance.now();
    try {
      const url = new URL(req.url ?? "/", "http://localhost"), parts = url.pathname.replace(/^\/api\//, "").split("/").map(decodeURIComponent);
      let selected: { file: string; params: Record<string, unknown> } | null = null;
      for (const route of routes) {
        const params: Record<string, unknown> = {}; let index = 0, ok = true;
        for (const p of route.parts) {
          if (p.startsWith("[...")) { params[p.slice(4, -1)] = parts.slice(index); index = parts.length; break; }
          if (index >= parts.length) { ok = false; break; }
          if (p.startsWith("[")) params[p.slice(1, -1)] = parts[index]; else if (p !== parts[index]) { ok = false; break; }
          index++;
        }
        if (ok && index === parts.length) { selected = { file: route.file, params }; break; }
      }
      if (!selected) { res.writeHead(404); res.end("{}"); return; }
      let body = ""; for await (const b of req) { body += b; if (body.length > 8388608) throw Error("BODY_BOUND"); }
      const module = await import(pathToFileURL(selected.file).href), handler = module[req.method ?? "GET"];
      if (!handler) { res.writeHead(405); res.end("{}"); return; }
      const headers = new Headers(); for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const response: Response = await handler(new Request(url, { method: req.method, headers,
        ...(!["GET", "HEAD"].includes(req.method ?? "GET") ? { body } : {}) }), { params: Promise.resolve(selected.params) });
      const out: Record<string, string> = {}; response.headers.forEach((v, k) => { out[k] = v; });
      const responseBytes=Buffer.from(await response.arrayBuffer());
      await options.afterResponse?.(url.pathname,body,response.status);
      res.writeHead(response.status, out); res.end(responseBytes);
      record({ path: url.pathname, method: req.method, status: response.status, bearer: Boolean(req.headers.authorization), elapsedMs: performance.now() - started });
    } catch (error) { record({ path: req.url, status: 500, predicate: String((error as Error).message) });
      res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"local_route_host_failed"}'); }
  });
  const origin = await listen(api);
  const session = await fetch(authOrigin + "/auth/v1/token?grant_type=password", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (session.status !== 200) throw Error("REAL_LOCAL_PASSWORD_SIGNIN_FAILED");
  const token = (await session.json()).access_token as string;
  return { origin, authOrigin, token, email, password, profile: "DISPOSABLE_LOCAL_AUTH_SERVICE_ACTUAL_BEARER_AND_RLS",
    close: async () => { await Promise.all([auth, api].map(server => new Promise<void>(resolve => server.close(() => resolve())))); } };
}

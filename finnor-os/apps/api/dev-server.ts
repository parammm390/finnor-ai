import { createServer, type Server } from "node:http";
import { installedDevelopmentRuntime, assertInstalledDevelopmentSchema } from "../../packages/private-equity/src/institution-program/installed-runtime";

export type DevelopmentRoute = { parts: string[]; source: string; sha256: string;
  load: () => Promise<Record<string, unknown>> };

/** Hosts the actual API handlers in the explicitly disposable development
 * installation. Authentication, authority, SQL and commands remain their owners. */
export async function startDevelopmentApi(routes: DevelopmentRoute[]): Promise<Server> {
  if (process.env.NODE_ENV === "production" || process.env.FINNOR_ENVIRONMENT === "production"
      || process.env.FINNOR_P4_PROFILE !== "ordinary_disposable" || process.env.AUTH_DEV_BYPASS !== "0")
    throw Error("X1_COMPILED_DEVELOPMENT_PROFILE_REQUIRED");
  installedDevelopmentRuntime(true);
  const database = new URL(process.env.DATABASE_URL ?? "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(database.hostname)) throw Error("X1_LOOPBACK_DATABASE_REQUIRED");
  const auth = new URL(process.env.SUPABASE_URL ?? "");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(auth.hostname)
      || !process.env.SUPABASE_SERVICE_ROLE_KEY) throw Error("X1_CONFIGURED_LOCAL_AUTH_SERVICE_REQUIRED");
  const { getPool } = await import("@finnor/db");
  const role = (await getPool().query(`SELECT current_user,rolsuper,rolbypassrls,
    pg_has_role('finnor_app','finnor_worker','MEMBER') app_inherits_worker
    FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if (!role || role.current_user !== "finnor_app" || role.rolsuper || role.rolbypassrls || role.app_inherits_worker)
    throw Error("X1_RESTRICTED_COMPILED_APP_ROLE_REQUIRED");
  assertInstalledDevelopmentSchema((await getPool().query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows.map(row => row.name));
  const installed = installedDevelopmentRuntime(true)!;
  for (const route of routes) if (!installed.manifest.files.some(p => p.path === route.source && p.sha256 === route.sha256))
    throw Error("X1_COMPILED_ROUTE_SOURCE_MISMATCH");
  const api = createServer(async (request, response) => {
    try {
      installedDevelopmentRuntime(true);
      const url = new URL(request.url ?? "/", "http://127.0.0.1"), method = request.method ?? "GET";
      if (!url.pathname.startsWith("/api/")) { response.writeHead(404); response.end("{}"); return; }
      const parts = url.pathname.slice(5).split("/").map(decodeURIComponent);
      let selected: { route: DevelopmentRoute; params: Record<string, unknown> } | undefined;
      for (const route of routes) {
        const params: Record<string, unknown> = {}; let at = 0, matches = true;
        for (const part of route.parts) {
          if (part.startsWith("[[...")) { params[part.slice(5, -2)] = parts.slice(at); at = parts.length; break; }
          if (part.startsWith("[...")) {
            if (at >= parts.length) { matches = false; break; }
            params[part.slice(4, -1)] = parts.slice(at); at = parts.length; break;
          }
          if (at >= parts.length) { matches = false; break; }
          if (part.startsWith("[")) params[part.slice(1, -1)] = parts[at];
          else if (part !== parts[at]) { matches = false; break; }
          at++;
        }
        if (matches && at === parts.length) { selected = { route, params }; break; }
      }
      if (!selected) { response.writeHead(404); response.end("{}"); return; }
      const module = await selected.route.load();
      const handler = module[method] as ((r: Request, c: { params: Promise<Record<string, unknown>> }) => Promise<Response>) | undefined;
      if (!handler) { response.writeHead(405); response.end("{}"); return; }
      const chunks: Buffer[] = []; let length = 0;
      for await (const chunk of request) {
        length += chunk.length; if (length > 8 * 1024 * 1024) throw Error("X1_DEVELOPMENT_HTTP_BODY_BOUND");
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      }
      const result = await handler(new Request(url, { method, headers,
        ...(!["GET", "HEAD"].includes(method) ? { body: Buffer.concat(chunks) } : {}) }),
      { params: Promise.resolve(selected.params) });
      const out: Record<string, string> = {}; result.headers.forEach((value, key) => { out[key] = value; });
      response.writeHead(result.status, out); response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      console.error(JSON.stringify({ event: "X1_COMPILED_API_REFUSAL", predicate: (error as Error).message }));
      response.writeHead(503, { "content-type": "application/json" }); response.end('{"error":"development_owner_unavailable"}');
    }
  });
  const port = Number(process.env.PORT ?? "3100");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("X1_LOCAL_PORT_INVALID");
  await new Promise<void>((resolve, reject) => { api.once("error", reject); api.listen(port, "127.0.0.1", resolve); });
  console.log(JSON.stringify({ event: "X1_COMPILED_API_READY", pid: process.pid, address: api.address(),
    manifestDigest: installed.manifestDigest, role: role.current_user, productionActive: false }));
  return api;
}

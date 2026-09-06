// Tenant-wide SSE gateway. Postgres NOTIFY is the existing shared wake signal;
// correctness comes from the tenant-scoped operational_deltas ledger, never from
// process memory or NOTIFY delivery. Business rows remain behind authenticated APIs.

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { Role, TenantContext } from "@finnor/shared-types";
import { readOperationalDeltas } from "@finnor/db";
import { resolveTenantFromBearerToken, AuthVerificationError } from "@finnor/security";
import { getLogger, getRuntimeReleaseMetadata } from "@finnor/tools";
import { onJarvisEvent, type JarvisEvent } from "./listener";

type IdentityContext = Omit<TenantContext, "correlationId">;
type DeltaPage = Awaited<ReturnType<typeof readOperationalDeltas>>;

const HEARTBEAT_MS = 15_000;

function allowedOrigins(): string[] {
  return (process.env.JARVIS_SSE_ALLOWED_ORIGINS ?? "http://localhost:3000,https://finnorai.com")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function corsHeaders(requestOrigin: string | undefined): Record<string, string> {
  const origins = allowedOrigins();
  const origin = requestOrigin && origins.includes(requestOrigin) ? requestOrigin : origins[0]!;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "authorization,last-event-id",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

async function authenticate(req: IncomingMessage, url: URL): Promise<IdentityContext> {
  if (process.env.AUTH_DEV_BYPASS === "1" && process.env.NODE_ENV !== "production") {
    const tenantId = (req.headers["x-tenant-id"] as string | undefined) ?? url.searchParams.get("tenantId") ?? undefined;
    if (tenantId) {
      const userId = (req.headers["x-user-id"] as string | undefined) ?? url.searchParams.get("userId") ?? "00000000-0000-4000-8000-0000000000aa";
      const role = ((req.headers["x-user-role"] as string | undefined) ?? url.searchParams.get("role") ?? "owner") as Role;
      return { tenantId, userId, role };
    }
  }
  const authHeader = req.headers.authorization;
  const token = typeof authHeader === "string" && authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
  if (!token) throw new AuthVerificationError("Missing bearer token", 401);
  return resolveTenantFromBearerToken(token);
}

function statusForError(error: unknown): number {
  if (error instanceof AuthVerificationError) return error.status;
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : null;
  if (code === "scope_mismatch") return 409;
  if (code === "invalid_cursor") return 400;
  return 503;
}

function handleEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
  authenticate(req, url)
    .then(async (ctx) => {
      const lastHeader = req.headers["last-event-id"];
      const lastEventId = typeof lastHeader === "string" ? lastHeader : undefined;
      // Resolve/validate before response headers so malformed and cross-tenant
      // cursors fail closed with an ordinary HTTP response.
      let pendingInitial: DeltaPage | null = await readOperationalDeltas(ctx.tenantId, lastEventId);

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...corsHeaders(req.headers.origin),
      });
      res.write(": connected\n\n");

      let cursor = pendingInitial.cursor;
      let closed = false;
      let draining = false;
      let drainAgain = false;

      const writePage = (page: DeltaPage) => {
        cursor = page.cursor;
        if (page.status === "resync_required") {
          res.write(`id: ${page.cursor}\n`);
          res.write("event: resync\n");
          res.write(`data: ${JSON.stringify({ status: page.status, cursor: page.cursor })}\n\n`);
          return;
        }
        for (const delta of page.deltas) {
          cursor = delta.cursor;
          res.write(`id: ${delta.cursor}\n`);
          res.write("event: operational_delta\n");
          res.write(`data: ${JSON.stringify(delta)}\n\n`);
        }
      };

      const drain = async () => {
        if (closed) return;
        if (draining) { drainAgain = true; return; }
        draining = true;
        try {
          do {
            drainAgain = false;
            if (pendingInitial) {
              writePage(pendingInitial);
              pendingInitial = null;
            }
            let page = await readOperationalDeltas(ctx.tenantId, cursor);
            writePage(page);
            while (!closed && page.status === "ok" && page.hasMore) {
              page = await readOperationalDeltas(ctx.tenantId, cursor);
              writePage(page);
            }
            // This read happens after subscription and therefore closes the
            // read-before-LISTEN race even when the initial page was empty.
          } while (drainAgain && !closed);
        } catch (error) {
          getLogger().error({ tenantId: ctx.tenantId, error: error instanceof Error ? error.message : String(error) }, "[sse] durable delta drain failed");
          if (!closed) res.write(`event: resync\ndata: ${JSON.stringify({ status: "resync_required" })}\n\n`);
        } finally {
          draining = false;
        }
      };

      const unsubscribe = onJarvisEvent((event: JarvisEvent) => {
        if (event.tenantId === ctx.tenantId && event.kind === "operational_delta") void drain();
      });
      void drain();

      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS);
      const cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.on("close", cleanup);
      res.on("error", cleanup);
    })
    .catch((error) => {
      if (res.headersSent) return;
      const message = error instanceof Error ? error.message : "Realtime unavailable";
      res.writeHead(statusForError(error), { "content-type": "application/json", ...corsHeaders(req.headers.origin) });
      res.end(JSON.stringify({ error: message }));
    });
}

export function createSseGateway(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://internal");
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders(req.headers.origin));
      res.end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      const release = getRuntimeReleaseMetadata("finnor-worker");
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store, max-age=0",
        "x-finnor-commit-sha": release.commitSha,
        "x-finnor-build-id": release.buildId,
        "x-finnor-environment": release.environment,
        "x-finnor-version": release.version,
      });
      res.end(JSON.stringify({ ok: true, release }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/events") {
      handleEvents(req, res, url);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

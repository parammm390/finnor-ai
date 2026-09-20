// B1.T2 — the SSE gateway's own deployable entrypoint, separate from index.ts's job-
// polling loop (which has no port). Run as `tsx apps/worker/src/sse-server.ts` — either
// its own persistent service, or a second process alongside the worker's job loop; either
// way it needs its own PORT because ingress routes by port, not by process. Also starts
// B1.T3's CQRS projector: both share the one dedicated jarvis_events LISTEN connection
// (packages/worker/src/sse/listener.ts) rather than opening two.

import "dotenv/config";

import type http from "node:http";
import { initObservability, getLogger } from "@finnor/tools";
import { startJarvisEventListener, stopJarvisEventListener, onJarvisEvent } from "./sse/listener";
import { createSseGateway, drainSseConnections } from "./sse/gateway";
import { onJarvisEventMarkProjectionsDirty } from "@finnor/projections";

const isMain = process.argv[1]?.endsWith("sse-server.ts") || process.argv[1]?.endsWith("sse-server.js");

export async function startSseServer(port: number, signal?: AbortSignal): Promise<http.Server> {
  await startJarvisEventListener();
  onJarvisEvent(onJarvisEventMarkProjectionsDirty);
  const server = createSseGateway();
  // Persistent runtime platforms route to a service's assigned port over
  // its private network interface, not just loopback — binding with no explicit host
  // can resolve to IPv6 `::`/loopback-only in some container network namespaces,
  // which the edge proxy can't reach (observed as a real 502 "Application failed to
  // respond" in staging even though the process itself was confirmed alive via a real
  // job completing). Binding "0.0.0.0" explicitly is the documented fix.
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
  signal?.addEventListener("abort", () => {
    drainSseConnections();
    server.close();
    void stopJarvisEventListener();
  });
  return server;
}

if (isMain) {
  initObservability();
  const log = getLogger();
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  const port = Number(process.env.SSE_PORT ?? process.env.PORT ?? 8090);
  startSseServer(port, controller.signal)
    .then(() => log.info({ port }, "[sse] gateway listening"))
    .catch((err) => {
      log.fatal({ err: err instanceof Error ? err.message : String(err) }, "[sse] gateway failed to start");
      process.exit(1);
    });
}

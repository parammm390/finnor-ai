import { createServer } from "node:http";
import { getRuntimeReleaseMetadata } from "@finnor/tools";
import type { WorkloadClass } from "@finnor/db";

/** ECS uses loopback health checks for non-ingress compute tasks.  Only REALTIME
 * owns the externally reachable SSE gateway; this endpoint is never attached to
 * an ALB or opened in the task security group. */
export function startClassHealthServer(workloadClass: WorkloadClass, port: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.url !== "/healthz") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(signal.aborted ? 503 : 200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({
        ok: !signal.aborted,
        serviceClass: workloadClass,
        realtime: false,
        release: getRuntimeReleaseMetadata("finnor-worker"),
      }));
    });
    server.once("error", reject);
    server.listen(port, "0.0.0.0", () => resolve());
    signal.addEventListener("abort", () => server.close(), { once: true });
  });
}

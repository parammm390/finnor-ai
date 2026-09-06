// Orchestrator service (§3 blueprint): a thin long-running host over the shared
// @finnor/orchestration package, exposing an internal HTTP surface for the API and
// worker to call when the canonical deployment contract requires a separate service.

import "dotenv/config";
import { createServer } from "node:http";
import { FinnorOrchestrator } from "@finnor/orchestration";
import { getRuntimeReleaseMetadata } from "@finnor/tools";
import { CURRENT_MIGRATION_HEAD, recordCutoverCompatibleHeartbeat } from "@finnor/db";
import { z } from "zod";
import { hostname } from "node:os";

const BodySchema = z.object({
  instruction: z.string().min(1),
  tenantId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.literal("owner"),
  sessionId: z.string().optional(),
});

const orchestrator = new FinnorOrchestrator();
const port = Number(process.env.ORCHESTRATOR_PORT ?? 3200);
const instanceId = process.env.FINNOR_ORCHESTRATOR_INSTANCE_ID?.trim()
  || `orchestrator:${hostname()}:${process.pid}`;

async function beat(): Promise<void> {
  const release = getRuntimeReleaseMetadata("finnor-orchestrator");
  await recordCutoverCompatibleHeartbeat({
    service: "orchestrator",
    instanceId,
    releaseSha: release.commitSha,
    buildId: release.buildId,
    version: release.version,
    releaseSource: release.source,
    coreCertificationId: process.env.FINNOR_CORE_CERTIFICATION_ID ?? null,
    migrationHead: CURRENT_MIGRATION_HEAD,
    deploymentId: process.env.FINNOR_ORCHESTRATOR_DEPLOYMENT_ID ?? null,
    capabilities: ["planning", "authority", "private-equity"],
    environment: release.environment,
  });
}

const server = createServer(async (req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") {
    const release = getRuntimeReleaseMetadata("finnor-orchestrator");
    return send(200, {
      ok: true,
      plugins: orchestrator.plugins.actionTypes(),
      release,
    });
  }
  if (req.method === "POST" && req.url === "/plan") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      try {
        const body = BodySchema.safeParse(JSON.parse(raw || "{}"));
        if (!body.success) return send(400, { error: body.error.issues.map((i) => i.message).join("; ") });
        const { instruction, sessionId, ...ctx } = body.data;
        const result = await orchestrator.handleInstructionResult(instruction, ctx, { sessionId });
        return send(result.objective ? 202 : 200, {
          planned: result.actions,
          ...(result.answer ? { answer: result.answer } : {}),
          ...(result.query ? { query: result.query } : {}),
          ...(result.objective ? { objective: result.objective } : {}),
          workId: result.workId,
          instructionId: result.instructionId,
        });
      } catch (err) {
        console.error(err);
        return send(500, { error: "Planning failed. Check orchestrator logs." });
      }
    });
    return;
  }
  send(404, { error: "Not found" });
});

const isMain = process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMain) {
  void beat().catch((error) => console.error("[orchestrator] cutover heartbeat failed", error));
  const heartbeat = setInterval(() => {
    void beat().catch((error) => console.error("[orchestrator] cutover heartbeat failed", error));
  }, 30_000);
  server.on("close", () => clearInterval(heartbeat));
  server.listen(port, () => console.log(`[orchestrator] listening on :${port}`));
}

export { server, orchestrator };

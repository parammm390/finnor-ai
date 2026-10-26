import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { z } from "zod";
import { ToolRegistry } from "../../packages/tools/src/registry";
import { registerProvider, resolveProvider } from "../../packages/tools/src/llm";
import { flushLangfuse, langfuseStatus } from "../../packages/tools/src/langfuse";
import { IntegrationError } from "../../packages/tools/src/errors";

/** Called only inside the ordinary-role disposable native delivery proof. */
export async function verifyRegisteredLangfuse(tenantId: string, principalId: string) {
  const received: Array<Record<string, unknown>> = [];
  let responseMode: "success" | "partial" | "stall" = "success";
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/api/public/otel/v1/traces");
      assert.equal(request.headers.authorization, `Basic ${Buffer.from("native-public:native-secret").toString("base64")}`);
      const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
      const body = z.object({ resourceSpans: z.array(z.object({ scopeSpans: z.array(z.object({ spans: z.array(z.record(z.unknown())) })) })) }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      for (const resource of body.resourceSpans) for (const scope of resource.scopeSpans) received.push(...scope.spans);
      response.writeHead(200, { "content-type": "application/json" });
      if (responseMode === "stall") { response.flushHeaders(); return; }
      response.end(responseMode === "partial" ? '{"partialSuccess":{"rejectedSpans":"1","errorMessage":"fixture rejection"}}' : "{}");
    } catch { response.writeHead(400); response.end("{}"); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); const address = server.address(); assert(address && typeof address !== "string");
  const keys = ["LANGFUSE_ENABLED", "LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_BASE_URL"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { LANGFUSE_ENABLED: "1", LANGFUSE_PUBLIC_KEY: "native-public", LANGFUSE_SECRET_KEY: "native-secret", LANGFUSE_BASE_URL: `http://127.0.0.1:${address.port}` });
  try {
    registerProvider("native-langfuse-proof", () => ({ name: "native-langfuse-proof", lastUsage: { model: "fixture-model", inputTokens: 9, outputTokens: 3 }, complete: async () => "PRIVATE_MODEL_OUTPUT" }));
    const model = resolveProvider("native-langfuse-proof"), registry = new ToolRegistry();
    registry.register({ name: "native_generation_probe", description: "Native registered-path proof", integration: "finnor-fixture", inputSchema: z.object({ tenantId: z.string().uuid(), privateInput: z.string() }).strict(),
      piiAllowlist: ["tenantId", "privateInput"], execution: { effect: "read_only", retrySafety: "repeatable", idempotency: { mode: "inherently_idempotent" }, verification: "none" },
      retryPolicy: { attempts: 1, baseDelayMs: 1, timeoutMs: 5000 },
      run: async () => ({ text: await model.complete({ tenantId, purpose: "answer", channel: "background", traceId: "registered-path-proof", system: "PRIVATE_SYSTEM_PROMPT", user: "PRIVATE_USER_PROMPT" }) }) });
    registry.register({ name: "native_failure_probe", description: "Handled tool failure", integration: "finnor-fixture", inputSchema: z.object({ tenantId: z.string().uuid() }).strict(),
      execution: { effect: "read_only", retrySafety: "repeatable", idempotency: { mode: "inherently_idempotent" }, verification: "none" },
      retryPolicy: { attempts: 1, baseDelayMs: 1, timeoutMs: 1000 }, run: async () => { throw new IntegrationError("finnor-fixture", "PRIVATE_EXCEPTION_MESSAGE", false, "validation"); } });
    const runtime = { tenantId, actorId: principalId, purpose: "verification" };
    const success = await registry.callWithRuntimeContext("native_generation_probe", { privateInput: "PRIVATE_TOOL_INPUT" }, runtime); assert.equal(success.ok, true);
    const failed = await registry.callWithRuntimeContext("native_failure_probe", {}, runtime); assert.equal(failed.ok, false);
    await flushLangfuse();
    const span = z.object({ name: z.string(), traceId: z.string(), spanId: z.string(), parentSpanId: z.string().optional(), status: z.object({ code: z.number() }), attributes: z.array(z.object({ key: z.string(), value: z.record(z.unknown()) })) });
    const spans = received.map(value => span.parse(value)), generation = spans.find(row => row.name === "llm:answer"), tool = spans.find(row => row.name === "native_generation_probe"), failure = spans.find(row => row.name === "native_failure_probe");
    assert(generation && tool && failure); assert.equal(generation.traceId, tool.traceId); assert.equal(generation.parentSpanId, tool.spanId); assert.equal(failure.status.code, 2);
    assert.equal(generation.attributes.find(a => a.key === "gen_ai.usage.input_tokens")?.value.intValue, "9");
    assert(!JSON.stringify(received).includes("PRIVATE_")); assert(!JSON.stringify(received).includes("native-secret"));
    responseMode = "partial"; const partialBefore = langfuseStatus(); await registry.callWithRuntimeContext("native_failure_probe", {}, runtime); await flushLangfuse(); const partialAfter = langfuseStatus();
    assert.equal(partialAfter.dropped - partialBefore.dropped, 1); assert.equal(partialAfter.exported - partialBefore.exported, 0);
    responseMode = "stall"; await registry.callWithRuntimeContext("native_failure_probe", {}, runtime); const started = performance.now(); await flushLangfuse(Date.now() + 300); const elapsedMs = performance.now() - started;
    assert(elapsedMs < 2000); assert.equal(langfuseStatus().inFlight, false);
    return { spans, partialRejected: 1, boundedDrain: { deadlineMs: 300, elapsedMs, status: langfuseStatus() }, contentExported: false,
      qualification: "REAL_REGISTERED_MODEL_WRAPPER_AND_TOOL_REGISTRY_ORDINARY_DATABASE_OTLP_HTTP_FIXTURE_NO_HOSTED_LANGFUSE_CLAIM" };
  } finally {
    for (const key of keys) { const value = previous[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
  }
}

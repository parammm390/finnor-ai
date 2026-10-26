import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { runPythonEngine } from "../../packages/tools/src/capabilities/python-runner";
import { observeAiOperation, flushLangfuse } from "../../packages/tools/src/langfuse";

const output = resolve(process.env.FINNOR_CAPABILITY_EVIDENCE_DIR ?? "../docs/release/generated/capability-engines");
await mkdir(output, { recursive: true });
const sourcePaths = ["packages/tools/src/capabilities/python-runner.ts", "packages/tools/src/capabilities/python/duckdb_engine.py", "packages/tools/src/langfuse.ts", "scripts/release/run-capability-engines-e2e.mts"];
const sourceCut = async () => Promise.all(sourcePaths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") })));
const before = await sourceCut();
const observations: unknown[] = [];
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.url, "/api/public/otel/v1/traces");
    assert.equal(request.headers["x-langfuse-ingestion-version"], "4");
    assert.equal(request.headers.authorization, `Basic ${Buffer.from("fixture-public:fixture-secret").toString("base64")}`);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const envelope = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    for (const resource of envelope.resourceSpans) for (const scope of resource.scopeSpans) observations.push(...scope.spans);
    response.writeHead(200, { "content-type": "application/json" }); response.end("{}");
  } catch { response.writeHead(400); response.end("{}"); }
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
process.env.LANGFUSE_ENABLED = "1";
process.env.LANGFUSE_PUBLIC_KEY = "fixture-public";
process.env.LANGFUSE_SECRET_KEY = "fixture-secret";
process.env.LANGFUSE_BASE_URL = `http://127.0.0.1:${address.port}`;
const data = Buffer.from("customer,revenue\na,40\nb,60\n");
const table = { name: "sales", format: "csv", bytesBase64: data.toString("base64"), sha256: createHash("sha256").update(data).digest("hex"), source: { fixture: "independent-two-customer-concentration" } };
const cases: Array<{ id: string; status: "PASS" | "FAIL"; inputs: unknown; observed?: unknown; error?: string }> = [];
async function check(id: string, inputs: unknown, run: () => Promise<unknown>) {
  try { cases.push({ id, inputs, status: "PASS", observed: await run() }); }
  catch (error) { cases.push({ id, inputs, status: "FAIL", error: String(error) }); }
  await writeFile(join(output, "partial-results.json"), JSON.stringify({ before, cases }, null, 2));
  console.log(JSON.stringify({ id, status: cases.at(-1)?.status, error: cases.at(-1)?.error }));
}
const limits = () => ({ timeoutMs: 3_000, deadlineAt: Date.now() + 3_000 });
try {
  await check("concentration-on-actual-duckdb", { table, query: "SELECT customer,revenue,revenue/sum(revenue) OVER() AS share FROM sales ORDER BY customer" }, async () => {
    const result = await runPythonEngine("duckdb", { tables: [table], query: "SELECT customer,revenue,revenue/sum(revenue) OVER() AS share FROM sales ORDER BY customer", maxRows: 10 }, limits());
    assert.deepEqual(result.result.rows, [["a", 40, 0.4], ["b", 60, 0.6]]);
    return result;
  });
  await check("duckdb-uuid-and-interval-results", { types: ["UUID", "INTERVAL"] }, async () => {
    const result = await runPythonEngine("duckdb", { tables: [table], query: "SELECT '123e4567-e89b-12d3-a456-426614174000'::UUID, INTERVAL '1 day'", maxRows: 1 }, limits());
    assert.deepEqual(result.result.rows, [["123e4567-e89b-12d3-a456-426614174000", "1 day, 0:00:00"]]); return result;
  });
  for (const [id, query] of [
    ["external-file-read-refused", "SELECT * FROM read_text('/etc/passwd')"],
    ["multiple-statements-refused", "SELECT 1; SELECT 2"],
    ["file-export-refused", "COPY sales TO '/tmp/finnor-forbidden-capability.csv'"],
    ["external-network-refused", "SELECT * FROM read_csv('https://example.com/private.csv')"],
  ]) await check(id, { query }, async () => {
    await assert.rejects(runPythonEngine("duckdb", { tables: [table], query }, limits()));
    return { refused: true };
  });
  await check("two-process-physical-concurrency-envelope", { attempts: 4, physicalLimit: 2 }, async () => {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => runPythonEngine("duckdb", { tables: [table], query: "SELECT sum(i) FROM range(10000000) t(i)" }, limits())));
    const fulfilled = results.filter(r => r.status === "fulfilled").length;
    const rejected = results.filter(r => r.status === "rejected").map(r => String(r.reason));
    assert.equal(fulfilled, 2, JSON.stringify({ fulfilled, rejected }));
    assert.equal(rejected.filter(r => r.includes("CAPABILITY_ENGINE_BUSY")).length, 2);
    return { fulfilled, rejected };
  });
  await check("absolute-deadline-prevents-dispatch", { deadlineOffsetMs: -1 }, async () => {
    await assert.rejects(runPythonEngine("duckdb", { tables: [table], query: "SELECT 1" }, { timeoutMs: 1000, deadlineAt: Date.now() - 1 }));
    return { refused: true };
  });
  await check("explicit-flush-delivers-entire-bounded-queue", { observations: 66 }, async () => {
    const tenantId = randomUUID();
    for (let index = 0; index < 66; index++) await observeAiOperation({ kind: "generation", name: "capability-e2e", tenantId, correlationId: "private-fixture-correlation" }, async () => "SECRET_FIXTURE_CONTENT_MUST_NEVER_BE_EXPORTED", () => ({ model: "fixture-model", inputTokens: 4, outputTokens: 2 }));
    await flushLangfuse();
    assert.equal(observations.length, 66);
    assert(!JSON.stringify(observations).includes("SECRET_FIXTURE_CONTENT_MUST_NEVER_BE_EXPORTED"));
    return { delivered: observations.length, protocol: "OTLP_HTTP_JSON_V4", contentExported: false };
  });
  await check("handled-failure-is-an-error-observation", { disposition: "ok_false" }, async () => {
    const start = observations.length;
    const usage = { model: "fixture-tool", failed: true };
    await observeAiOperation({ kind: "tool", name: "handled-failure", tenantId: randomUUID() }, async () => ({ ok: false }), () => usage);
    await flushLangfuse();
    const latest = observations.slice(start).filter(value => value !== null && typeof value === "object" && "name" in value && value.name === "handled-failure");
    assert.equal(latest.length, 1);
    assert.equal((latest[0] as { status: { code: number } }).status.code, 2);
    return { status: "ERROR" };
  });
} finally {
  await flushLangfuse();
  await new Promise<void>(done => server.close(() => done()));
}
const after = await sourceCut();
const sourcesUnchanged = JSON.stringify(before) === JSON.stringify(after);
const result = { schema: "finnor.capability-engines-e2e.v1", before, after, sourcesUnchanged, cases, observations,
  runtime: { node: process.version, python: process.env.FINNOR_CAPABILITY_PYTHON },
  qualification: "REAL_LOCAL_DUCKDB_CHILD_AND_OTLP_HTTP_PROTOCOL; NOT_HOSTED_LANGFUSE_OR_API_QUEUE_PROOF",
  rerun: "FINNOR_CAPABILITY_PYTHON=$PWD/.capability-venv/bin/python FINNOR_CAPABILITY_EVIDENCE_DIR=<fresh-directory> node --import=tsx scripts/release/run-capability-engines-e2e.mts" };
await writeFile(join(output, "results.json"), JSON.stringify(result, null, 2) + "\n");
const failed = !sourcesUnchanged || cases.some(c => c.status === "FAIL");
console.log(JSON.stringify({ output, failed }));
process.exitCode = failed ? 1 : 0;

import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { SteelProvider } from "../../packages/computer/src/steel-provider";

const destination = process.argv[2];
if (!destination?.startsWith("/")) throw new Error("FRESH_ABSOLUTE_OUTPUT_DIRECTORY_REQUIRED");
await mkdir(destination, { mode: 0o700 });

const cases = [
  { name: "missing", body: "{}", expected: null },
  { name: "explicit-null", body: '{"creditsUsed":null}', expected: null },
  { name: "negative", body: '{"creditsUsed":-1}', expected: null },
  { name: "numeric-string", body: '{"creditsUsed":"0"}', expected: null },
  { name: "overflowing-json-number", body: '{"creditsUsed":1e309}', expected: null },
  { name: "reported-zero", body: '{"creditsUsed":0}', expected: 0 },
  { name: "reported-finite", body: '{"creditsUsed":1.25}', expected: 1.25 },
  { name: "service-unavailable", body: '{"error":"usage unavailable"}', expected: null, httpStatus: 503 },
] as const;

const requestCounts = new Map<string, number>();
const server = createServer((request, response) => {
  const name = request.url?.replace("/v1/sessions/", "");
  const fixture = cases.find((item) => item.name === name);
  if (request.method !== "GET" || !fixture) {
    response.writeHead(404).end();
    return;
  }
  requestCounts.set(fixture.name, (requestCounts.get(fixture.name) ?? 0) + 1);
  response.writeHead("httpStatus" in fixture ? fixture.httpStatus : 200, { "content-type": "application/json" });
  response.end(fixture.body);
});
await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
const address = server.address();
if (!address || typeof address === "string") throw new Error("OWNED_LOOPBACK_ADDRESS_REQUIRED");
const provider = new SteelProvider({
  apiKey: randomBytes(32).toString("base64url"),
  baseURL: `http://127.0.0.1:${address.port}`,
});
const results: Array<Record<string, unknown>> = [];
try {
  for (const fixture of cases) {
    let actual: unknown;
    let errorCode: string | null = null;
    try {
      actual = await provider.cost({ sessionRef: fixture.name });
    } catch (error) {
      errorCode = error instanceof Error && "code" in error ? String(error.code) : "unclassified_error";
    }
    const requests = requestCounts.get(fixture.name) ?? 0;
    const creditsUsed = actual && typeof actual === "object" && "creditsUsed" in actual
      ? (actual as { creditsUsed: unknown }).creditsUsed : undefined;
    const pass = requests === 1 && ("httpStatus" in fixture
      ? errorCode !== null && actual === undefined
      : errorCode === null && creditsUsed === fixture.expected);
    results.push({
      name: fixture.name, rawResponse: fixture.body,
      expected: "httpStatus" in fixture ? "ERROR_WITHOUT_ZERO_OR_RETRY" : fixture.expected,
      actual: actual ?? null, errorCode, physicalRequests: requests, pass,
    });
  }
} finally {
  await new Promise<void>((accept, reject) => server.close((error) => error ? reject(error) : accept()));
}
const root = resolve(import.meta.dirname, "../../..");
const sources: Record<string, string> = {};
for (const path of [
  "finnor-os/package-lock.json",
  "finnor-os/packages/computer/src/contracts.ts",
  "finnor-os/packages/computer/src/steel-provider.ts",
  "finnor-os/packages/computer/src/runner.ts",
  "finnor-os/scripts/x2/verify-provider-usage.mts",
]) {
  sources[path] = createHash("sha256").update(await readFile(resolve(root, path))).digest("hex");
}
const failed = results.filter((item) => !item.pass).length;
await writeFile(resolve(destination, "result.json"), `${JSON.stringify({
  schema: "finnor.x2.provider-usage-adapter-proof.v1",
  qualification: "SDK_ADAPTER_ISOLATION_ONLY_NOT_X2_ACCEPTANCE_OR_VENDOR_BILLING",
  recordedAt: new Date().toISOString(), node: process.version, platform: process.platform,
  sources, results, passed: results.length - failed, failed,
  rerun: "cd <absolute-checkout>/finnor-os && node_modules/.bin/tsx scripts/x2/verify-provider-usage.mts <fresh-absolute-output>",
}, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ status: failed ? "FAIL" : "PASS_SDK_ADAPTER_ONLY", passed: results.length - failed, failed }));
process.exitCode = failed ? 1 : 0;

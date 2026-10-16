/** Real loopback source discovery/preparation, before the review repairs.
 * Literal fixture contracts, not native Work, admission or business truth. */
import { strict as assert } from "node:assert";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ApplicationSourceSession } from "../../packages/private-equity/src/application-semantics/source";
import { parameterBindingCode } from "../../packages/private-equity/src/application-semantics/checker";
import { projectApplicationSnapshot } from "../../packages/private-equity/src/application-semantics/observation";
import { applicationContentRef, ApplicationProviderFault } from "../../packages/computer/src/application-provider";
import type { AuthorizedApplicationProfile } from "../../packages/private-equity/src/application-semantics/ports";

type Case = { id: string; schema: Record<string, unknown>; value: string | boolean; expected: string; booleanState?: boolean;
  dispatchDrift?: "schema" | "context" | "version" };
const text = (pattern: string) => ({ type: "string", pattern, maxLength: 2048 });
const cases: Case[] = [
  { id: "overlapping-repetitions-bounded-nonmatch", schema: text("^a+a+a+a+a+a+a+a+$"), value: "a".repeat(2047) + "!", expected: "X2_PARAMETER_PATTERN_MISMATCH" },
  { id: "ordinary-exact-decimal-alternation", schema: text("^(0|[1-9][0-9]{0,17})\\.[0-9]{2}$"), value: "9007199254740993.01", expected: "PREPARED" },
  { id: "decimal-leading-zero-refused", schema: text("^(0|[1-9][0-9]{0,17})\\.[0-9]{2}$"), value: "01.00", expected: "X2_PARAMETER_PATTERN_MISMATCH" },
  { id: "unicode-literals", schema: text("^café😀$"), value: "café😀", expected: "PREPARED" },
  { id: "ranges-and-fixed-bounds", schema: text("^[A-Z][a-z0-9_-]{1,8}$"), value: "Ab_9", expected: "PREPARED" },
  { id: "overlapping-optionals", schema: text("^a?a?a?a?a?a?a?a?b$"), value: "aaaaab", expected: "PREPARED" },
  { id: "regular-empty-repeat-cycle", schema: text("^(a?)*b$"), value: "aaaaab", expected: "PREPARED" },
  { id: "compiled-state-bound", schema: text("^a{513}$"), value: "a", expected: "X2_UNSUPPORTED_SCHEMA_PATTERN" },
  { id: "unanchored-search", schema: text("cat"), value: "bobcatmore", expected: "PREPARED" },
  { id: "start-anchor-preserved", schema: text("^cat"), value: "bobcat", expected: "X2_PARAMETER_PATTERN_MISMATCH" },
  { id: "lookaround-unsupported", schema: text("^(?=a)a$"), value: "a", expected: "X2_UNSUPPORTED_SCHEMA_PATTERN" },
  { id: "backreference-unsupported", schema: text("^(a)\\1$"), value: "aa", expected: "X2_UNSUPPORTED_SCHEMA_PATTERN" },
  { id: "malformed-pattern-unsupported", schema: text("[A-"), value: "A", expected: "X2_UNSUPPORTED_SCHEMA_PATTERN" },
  { id: "boolean-enum-keeps-type-and-domain", schema: { type: "boolean", enum: [true] }, value: true, expected: "PREPARED" },
  { id: "boolean-enum-rejects-false", schema: { type: "boolean", enum: [true] }, value: false, expected: "X2_PARAMETER_SCHEMA_MISMATCH" },
  { id: "boolean-enum-state-false-keeps-type-and-coverage", schema: { type: "boolean", enum: [true] }, value: true,
    booleanState: false, expected: "PREPARED" },
  { id: "boolean-enum-state-true-keeps-type-and-coverage", schema: { type: "boolean", enum: [true] }, value: true,
    booleanState: true, expected: "PREPARED" },
  { id: "schema-drift-after-preparation-refused-before-wire", schema: text("^[a-z]+$"), value: "abc",
    dispatchDrift: "schema", expected: "X2_PRE_WIRE_SEMANTIC_OR_RENDERING_DRIFT" },
  { id: "context-drift-after-preparation-refused-before-wire", schema: text("^[a-z]+$"), value: "abc",
    dispatchDrift: "context", expected: "X2_PRE_WIRE_EXTERNAL_DRIFT" },
  { id: "version-drift-after-preparation-refused-before-wire", schema: text("^[a-z]+$"), value: "abc",
    dispatchDrift: "version", expected: "X2_PRE_WIRE_EXTERNAL_DRIFT" },
];
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
if (process.argv[2] === "--case") {
  const test = cases.find(item => item.id === process.argv[3]);
  assert(test, "DECLARED_SOURCE_CASE_REQUIRED");
  const secret = randomBytes(24).toString("base64url"), grant = "public-source-grant";
  const binding = { applicationId: "source-contract", accountId: "account", recordId: "record",
    principalId: "actor", grantId: grant, applicationVersion: "v1", schemaRevision: "1",
    semanticRevision: 1, renderingRevision: 1, authorityRevision: 1, grantRevision: 1 };
  const requestShape = { requestId: "", effectId: "", obligationId: "", idempotencyKey: "", parentId: "", deadline: "" };
  const objectShape = (value: Record<string, unknown>) => ({ type: "object", additionalProperties: false,
    required: Object.keys(value), properties: Object.fromEntries(Object.entries(value).map(([name, v]) =>
      [name, { type: typeof v === "number" ? "integer" : "string" }])) });
  const record = { ...binding, version: 1, phase: "READY", value: test.booleanState ?? test.value,
    observation: { available: ["version", "phase", "value"], unavailable: [] } };
  const schema = { openapi: "3.1.0", paths: {
    ...(test.booleanState !== undefined ? {
      "/records/{recordId}": { get: { responses: { "200": { content: { "application/json": {
        schema: { type: "object", required: ["phase", "value"], properties: {
          phase: { type: "string" }, value: { type: "boolean", enum: [false, true] },
        } },
      } } } } } },
    } : {}),
    "/records/{recordId}/change": { post: { operationId: "changeValue", summary: "Change value",
      requestBody: { content: { "application/json": { schema: { type: "object", additionalProperties: false,
        required: ["context", "request", "expectedVersion", "value"], properties: {
          context: objectShape(binding), request: objectShape(requestShape),
          expectedVersion: { type: "integer", minimum: 0 }, value: test.schema,
        } } } } } } },
  } };
  let changed = false, nativeWireCallbacks = 0;
  const server = createServer((req, res) => {
    process.send?.({ stage: "HTTP", method: req.method, path: req.url });
    if (req.headers.authorization !== "Bearer " + secret || req.headers["x-portal-grant"] !== grant) {
      res.writeHead(403).end(); return;
    }
    const currentSchema = changed && test.dispatchDrift === "schema"
      ? JSON.parse(JSON.stringify(schema).replace('"maxLength":2048', '"maxLength":1')) : schema;
    const body = req.url === "/schema" ? currentSchema : req.url === "/context"
      ? { binding, role: "editor", entities: [{ entityId: "entity", currency: "USD" }], recordIds: ["record"],
        ...(changed && test.dispatchDrift === "context" ? { permissions: ["changed-external-grant"] } : {}) }
      : req.url === "/records/record" ? { ...record, version: changed && test.dispatchDrift === "version" ? 2 : 1 } : null;
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(body));
  });
  await new Promise<void>(yes => server.listen(0, "127.0.0.1", yes));
  const address = server.address(); assert(address && typeof address !== "string");
  const deadline = new Date(Date.now() + 60000).toISOString();
  const profile: AuthorizedApplicationProfile = { id: "source-profile", tenantId: "tenant", principalId: "actor",
    application: "source-contract", account: "account", actingPrincipal: "actor", role: "editor",
    grantRef: applicationContentRef("source-fixture-grant", { grant }), origin: `http://127.0.0.1:${address.port}`,
    entrypoint: "/records/{recordId}", documentationPaths: ["/schema"], contextPath: "/context",
    recordPathTemplate: "/records/{recordId}", requestPathTemplate: null, allowedTargets: ["record"],
    validUntil: deadline, credentials: { headers: { authorization: "Bearer " + secret, "x-portal-grant": grant } },
    sourceContract: "BOUNDED_CONDITIONAL_APPLICATION_V1", protectionDomain: "DISPOSABLE_TEST_AUTHORITY", discoverySurface: "API" };
  const source = new ApplicationSourceSession(profile, async () => {}, { readFence: {
    beforeRead: async () => {}, afterRead: async () => {},
  } });
  let actual = "UNCLASSIFIED", parameterContract: unknown = null;
  try {
    const discovery = await source.discover();
    assert.equal(discovery.operations.length, 1, "ONE_REAL_DISCOVERED_OPERATION_REQUIRED");
    const operation = discovery.operations[0]!;
    if (test.booleanState !== undefined) {
      const field = discovery.fields.find(item => item.path === "value");
      assert.equal(field?.kind, "boolean", "BOOLEAN_ENUM_STATE_MUST_REMAIN_BOOLEAN");
      const observed = (await source.observe({
        kind: "identity", application: profile.application, account: profile.account, entity: "entity", id: "record",
      })).snapshot;
      const projected = projectApplicationSnapshot(observed, discovery.fields);
      assert.equal(projected.state.value, test.booleanState, "BOOLEAN_ENUM_STATE_MUST_REMAIN_EXACT");
      assert(!projected.unavailableFields.includes("value"), "BOOLEAN_ENUM_STATE_MUST_REMAIN_OBSERVABLE");
    }
    if (test.schema.type === "boolean") {
      assert.equal(operation.parameters[0]?.kind, "boolean", "BOOLEAN_ENUM_MUST_NOT_BECOME_TEXT_ENUM");
      assert.deepEqual(operation.parameters[0]?.values, [true]);
      assert.equal(parameterBindingCode(operation.parameters, { value: true }), null);
      assert.notEqual(parameterBindingCode(operation.parameters, { value: false }), null, "BOOLEAN_ENUM_DOMAIN_MUST_REMAIN_RESTRICTED");
      parameterContract = { kind: "boolean", trueAccepted: true, falseRefused: true };
    }
    process.send?.({ stage: "PREPARE" });
    const wire = await source.prepare(operation.id, {
      kind: "identity", application: profile.application, account: profile.account, entity: "entity", id: "record",
    }, { value: test.value }, { requestId: randomUUID(), effectId: randomUUID(), obligationId: randomUUID(),
      idempotencyKey: randomUUID(), parentId: randomUUID(), deadline });
    assert.equal(JSON.parse(wire.body!).value, test.value, "EXACT_TYPED_ARGUMENT_MUST_REACH_PRIVATE_WIRE");
    actual = "PREPARED";
    if (test.dispatchDrift) {
      changed = true;
      await source.dispatch(wire, {
        beforeWire: async () => { nativeWireCallbacks++; },
        afterWire: async () => {},
      });
      actual = "UNEXPECTED_DISPATCH";
    }
  } catch (error) {
    actual = error instanceof ApplicationProviderFault ? error.code
      : error instanceof Error && error.message.includes("BOOLEAN_ENUM") ? error.message : "UNCLASSIFIED";
  } finally {
    await source.close();
    await new Promise<void>(yes => server.close(() => yes()));
  }
  process.send?.({ stage: "RESULT", actual, parameterContract, nativeWireCallbacks });
  process.disconnect?.();
} else {
  const destination = process.argv[2];
  assert(destination && destination.startsWith("/"), "FRESH_ABSOLUTE_OUTPUT_REQUIRED");
  await mkdir(destination, { mode: 0o700 });
  await writeFile(resolve(destination, "reference-inputs.json"), JSON.stringify(cases, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  const results: Array<Record<string, unknown>> = [];
  for (const test of cases) {
    const started = performance.now(), http: unknown[] = [];
    const child = spawn(process.execPath, ["--import=tsx", import.meta.filename, "--case", test.id],
      { cwd: resolve(import.meta.dirname, "../.."), stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const observed = await new Promise<{ actual: string; parameterContract?: unknown; nativeWireCallbacks?: number }>(yes => {
      let settled = false;
      const finish = (value: { actual: string; parameterContract?: unknown; nativeWireCallbacks?: number }) => {
        if (settled) return; settled = true; clearTimeout(timer); yes(value);
      };
      let timer = setTimeout(() => { child.kill("SIGKILL"); finish({ actual: "SOURCE_CHILD_STARTUP_DEADLINE" }); }, 15000);
      child.on("message", (raw: { stage: string; actual?: string; parameterContract?: unknown; nativeWireCallbacks?: number;
        method?: string; path?: string }) => {
        if (raw.stage === "HTTP") http.push({ method: raw.method, path: raw.path });
        if (raw.stage === "PREPARE") {
          clearTimeout(timer);
          timer = setTimeout(() => { child.kill("SIGKILL"); finish({ actual: "UNINTERRUPTIBLE_SOURCE_PATTERN" }); }, 2000);
        }
        if (raw.stage === "RESULT") finish({ actual: raw.actual!, parameterContract: raw.parameterContract,
          nativeWireCallbacks: raw.nativeWireCallbacks });
      });
      child.once("error", () => finish({ actual: "SOURCE_CHILD_LAUNCH_FAILED" }));
      child.once("exit", () => finish({ actual: "SOURCE_CHILD_EXIT_WITHOUT_RESULT" }));
    });
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>(yes => child.once("exit", () => yes()));
    }
    const mutationRequests = http.filter(row => (row as { method: string }).method !== "GET").length;
    results.push({ id: test.id, expected: test.expected, ...observed, http, mutationRequests,
      pass: observed.actual === test.expected && mutationRequests === 0
        && (!test.dispatchDrift || observed.nativeWireCallbacks === 0), wallMs: performance.now() - started });
  }
  const root = resolve(import.meta.dirname, "../../.."), pins: Record<string, string> = {};
  for (const path of ["finnor-os/packages/private-equity/src/application-semantics/source.ts",
    "finnor-os/packages/private-equity/src/application-semantics/schema-pattern.ts",
    "finnor-os/packages/private-equity/src/application-semantics/checker.ts",
    "finnor-os/scripts/x2/verify-source-contracts.mts",
    "scope-frontier5/x2-software-semantics-compiler/review-repair-contract.md",
    "scope-frontier5/x2-software-semantics-compiler/continuation-boundary-contract.md"]) {
    pins[path] = digest(await readFile(resolve(root, path)));
  }
  const failed = results.filter(result => !result.pass).length;
  await writeFile(resolve(destination, "result.json"), JSON.stringify({
    qualification: "REAL_SOURCE_TRANSPORT_FINITE_CONTRACT_NOT_NATIVE_WORK_OR_INSTALLED_ADMISSION",
    node: process.version, pins, results, passed: results.length - failed, failed,
    rerun: "cd <absolute-checkout>/finnor-os && node --import=tsx scripts/x2/verify-source-contracts.mts <fresh-absolute-output>",
  }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ passed: results.length - failed, failed }));
  process.exitCode = failed ? 1 : 0;
}

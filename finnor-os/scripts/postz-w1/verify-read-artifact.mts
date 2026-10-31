/** Fail closed on the saved independent observations, even if a dependency exit hook loses a failing process exit code. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
const verificationStarted = performance.now();
let outerWatchdog = setTimeout(() => { process.stderr.write("W1_READ_VERIFIER_OUTER_WATCHDOG\n"); process.exit(124); }, 1_200_000);
async function readBounded(path: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([readFile(path), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Error(`FINITE_VERIFIER_READ_TIMEOUT:${path}`)), 10_000);
    })]);
  } finally { clearTimeout(timer); }
}
async function main() {
const directory = process.argv[2];
if (!directory) throw Error("EXACT_READ_EVIDENCE_DIRECTORY_REQUIRED");
const report = JSON.parse((await readBounded(resolve(directory, "results.json"))).toString("utf8"));
assert.ok(Number.isFinite(report.durationMs) && report.durationMs >= 0 && report.durationMs < 1_200_000);
clearTimeout(outerWatchdog);
outerWatchdog = setTimeout(() => { process.stderr.write("W1_READ_COMBINED_DRIVER_VERIFIER_LIMIT\n"); process.exit(124); },
  Math.max(1, 1_200_000 - report.durationMs - (performance.now() - verificationStarted)));
assert.equal(report.shutdown?.complete, true, "Hung/incomplete cleanup is not a completed episode");
assert.deepEqual(report.shutdown.failures, []);
assert.equal(report.shutdown.postgres?.status, "PASS", "Disposable PostgreSQL custody was not verified");
assert.equal(report.shutdown.postgres.clusterStopped, true);
assert.equal(report.shutdown.postgres.directoryRemoved, true);
assert.deepEqual(report.watchdog, { armedBeforeSetup: true, limitMs: 1_200_000 });
const objectiveIds = ["OBJ_PLAN_SCOPED_RESOLUTION", "OBJ_MULTI_QUERY_PRIVATE_CUSTODY", "OBJ_NATIVE_PROVENANCE_BINDING", "OBJ_ORIGINAL_HUMAN_ONLY",
  "OBJ_SAME_PRINCIPAL_REPLAY", "OBJ_COMMITTED_STEP_RECOVERY", "OBJ_UNCOMMITTED_PRIVATE_RECOVERY", "OBJ_CURRENT_GRANTS_REPLAY",
  "OBJ_SOURCE_RIGHTS_REPLAY", "OBJ_SHARED_REDACTION", "OBJ_MODEL_CONTEXT_NO_FACTS", "OBJ_QUEUE_INLINE_NO_ACTIVATION",
  "OBJ_REQUEST_CONFLICT_NODE_PROVENANCE", "OBJ_BUDGET_DEADLINE_NO_ACTIVATION", "OBJ_UNSUPPORTED_GENERAL_OBJECTIVE",
  "CANONICAL_HTTP_INSERT_ONLY", "CANONICAL_HTTP_METADATA_STABILITY", "OBJ_COMPLETE_PRIVATE_VALIDATION"];
const required = ["SOURCE_REVENUE", "SOURCE_BASIS_MISMATCH", "SOURCE_CURRENCY_MISMATCH", "SOURCE_QUOTE", "SOURCE_DELAYED", "SOURCE_STALE", "SOURCE_RIGHTS_REVOKED"];
if (!report.sourceOnly) {
  assert.equal(report.verificationProfile, "HTTP_V4", "The installed prior 47 alone cannot qualify native integration");
  required.push("TYPED_API_REVENUE", "NATURAL_AND_DUPLICATE", "CORE_PRIOR_CLASSIFICATION", "AUTHENTICATION", "FOREIGN_TENANT",
    "TYPED_API_QUOTE_CURRENT", "TYPED_API_REVENUE_DUPLICATE", "CORE_DUPLICATE",
    "NAMED_COMPANY_NO_SUBSTITUTION", "MIXED_NEGATION_EFFECT_PRESERVED", "MISSING_REPORTING_CALENDAR", "PROVISIONAL_CASH_FISCAL_REVENUE",
    "TYPED_API_STALE_QUOTE", "TYPED_API_UNAVAILABLE_QUOTE", "TYPED_API_QUOTE_REPLAY_REVOKED", "UNAVAILABLE_REPLAY_CURRENTNESS",
    "SHARED_ECONOMIC_REDACTION", "CONTEXT_READ_NO_FLEET", "REVENUE_NAMED_FORMS", "REVENUE_SELECTORS",
    "POSITIVE_EFFECT_VOCABULARY", "MULTILINE_NEGATION", "RESOLVED_RESOURCE_SCOPES", "SCOPED_GRANT_CURRENTNESS",
    "COMMITTED_RECEIPT_RECOVERY_NO_KEY", "TRACE_FAILURE_BEST_EFFORT", "QUOTE_EXPLICIT_SUBJECT",
    "SIMULTANEOUS_QUOTE_VALIDITY", "EXACT_CAPABILITY_DENIES", "SUPPLIED_ID_RECOVERY_CUSTODY",
    "PRIVATE_INSERT_ATOMIC_RECOVERY", "ANCILLARY_RESPONSE_FAILURE_REPLAY", "ASSISTANT_PROJECTION_FAILURE_REPLAY",
    "QUOTE_POSSESSIVE", "EFFECT_WORD_ENTITY", "TYPED_REQUEST_RECOVERY", "COMPLETE_OUTPUT_REPLAY_VALIDATION",
    "ORIGINAL_INPUT_PRINCIPAL_IDENTITY", "BACKGROUND_PRINCIPAL_NO_ACTIVATION", "IN_FLIGHT_DUPLICATE_RECEIPT");
  assert.equal(required.length, 47);
  required.push(...objectiveIds);
  assert.equal(required.length, 65);
  assert.equal(report.results.length, 65, "HTTP_V4 requires exactly the 65 registered owning observations");
  assert.equal(report.network?.installed, true, "Transport budget guard missing");
  assert.equal(report.network?.blockedExternalAttempts, 0, "Unexpected external network attempt");
  assert.ok(report.auth?.refusedSignatures >= 1, "Wrong-signature bearer did not reach the real verifier");
  assert.ok(report.network.loopbackGateChecks > 0);
} else assert.equal(report.verificationProfile, "SOURCE_V1", "Source-only artifacts are diagnostics, not HTTP proof");
assert.ok(report.migrationCount > 0, "Actual migrations did not run");
assert.ok(report.results.every((result: { status: string }) => result.status !== "FAIL"), "Saved native observations contain failures");
assert.equal(new Set(report.results.map((result: { id: string }) => result.id)).size, report.results.length, "Repeated predicate identity");
const tables = ["jobs", "workforce_assignments", "computer_runs", "sandbox_outbox", "s5_reservations", "business_effects", "compute_resource_leases", "work_planner_attempts"];
for (const id of required) {
  const observation = report.results.find((result: { id: string }) => result.id === id);
  assert.equal(observation?.status, "PASS", `Missing actual passed observation: ${id}`);
  assert.ok(observation.observation !== undefined, `No saved owning observation: ${id}`);
  assert.ok(Number.isFinite(observation.durationMs) && observation.durationMs >= 0);
  for (const table of tables) {
    assert.ok(Number.isSafeInteger(observation.before?.[table]) && observation.before[table] >= 0, `Missing before meter: ${id}/${table}`);
    assert.equal(observation.after?.[table], observation.before[table], `Activation delta: ${id}/${table}`);
  }
}
assert.ok(Number.isFinite(report.durationMs) && report.durationMs >= 0 && report.durationMs < 1_200_000, "Finite episode exceeded its declared budget");
assert.equal(report.status, report.sourceOnly ? "PASS_SOURCE_ONLY" : "PASS_LOCAL");
const freeze = JSON.parse((await readBounded(resolve(directory, "pre-run-freeze.json"))).toString("utf8"));
assert.ok(freeze.sourceIdentities?.length > 0 && freeze.sourceIdentities.every((entry: { sha256?: string }) => /^[a-f0-9]{64}$/.test(entry.sha256 ?? "")), "Incomplete source freeze");
assert.equal(freeze.verificationProfile, report.verificationProfile);
assert.equal(freeze.sourceOnly, report.sourceOnly);
assert.equal(freeze.episodeSecondsLimit, 1200);
assert.equal(freeze.outerWatchdogArmedBeforeSetup, true);
const frozenPaths = [
  "scripts/postz-w1/run-economic-reads-native.mts", "scripts/postz-w1/read-http-fixture.mts",
  "packages/private-equity/src/economic-reads/reader.ts",
  "packages/orchestration/src/economic-read-intake.ts", "scripts/postz-w1/read-network-guard.mjs", "scripts/postz-w1/verify-read-artifact.mts",
  "packages/shared-types/src/economic-reads.ts", "packages/shared-types/src/operational-queries.ts", "packages/shared-types/src/index.ts",
  "packages/private-equity/src/economic-reads/operational-query.ts", "packages/orchestration/src/fast-read-lane.ts",
  "packages/orchestration/src/economic-query-answer.ts", "packages/orchestration/src/economic-read-replay.ts",
  "packages/orchestration/src/operational-query-runtime.ts", "packages/orchestration/src/authority-runtime.ts", "packages/orchestration/src/index.ts",
  "apps/api/app/api/actions/route.ts", "apps/api/app/api/queries/route.ts", "packages/db/schema.ts",
  "packages/db/migrations/postz_w1_ordinary_economic_reads.sql", "package-lock.json",
  "packages/db/migrations/postz_w1_source_link_binding.sql", "packages/db/migrations-bundle.ts", "scripts/bundle-migrations.ts",
  "../scope-postz/w1-economic-orchestration/read-http-verification-v2.json",
  "scripts/postz-w1/read-review-v2-cases.mts", "scripts/postz-w1/run-read-intake.mts",
  "packages/db/index.ts", "packages/read-models/src/operational-queries.ts",
  "packages/orchestration/src/instruction-effects.ts", "packages/orchestration/src/instruction-routing.ts", "packages/orchestration/src/interaction-context.ts",
  "apps/api/app/api/works/[id]/route.ts", "apps/api/app/api/works/route.ts", "apps/api/app/api/works/[id]/execution/route.ts", "apps/api/app/api/works/[id]/retry/route.ts",
  "apps/worker/src/handlers/process-instruction.ts", "apps/worker/src/queue.ts",
  "packages/authority/src/index.ts", "packages/private-equity/src/enterprise-beliefs.ts", "packages/read-models/src/execution-projection.ts",
  "../scope-postz/w1-economic-orchestration/read-http-verification-v3.json",
  "scripts/postz-w1/read-objective-v1-cases.mts", "packages/orchestration/src/objective-economic-reads.ts",
  "packages/orchestration/src/objective-loop.ts", "packages/orchestration/src/objective-success.ts", "packages/orchestration/src/planner.ts",
  "packages/orchestration/src/orchestration-kernel.ts", "packages/orchestration/src/plan-runtime.ts", "packages/orchestration/src/plan-progress.ts",
  "packages/planning/src/canonical.ts", "packages/planning/src/builders.ts", "packages/planning/src/compiler.ts", "packages/planning/src/contracts.ts",
  "packages/shared-types/src/objectives.ts", "apps/worker/src/handlers/run-objective-iteration.ts",
  "apps/api/lib/auth.ts", "apps/api/lib/orchestrator.ts", "scripts/generate-openapi.ts",
  "packages/db/migrations/0195_private_input_responses.sql", "packages/db/migrations/postz_w1_objective_query_custody.sql",
  "packages/db/migrations/postz_w1_objective_budget_guard.sql",
  "../scope-postz/w1-economic-orchestration/read-http-verification-v4.json",
];
assert.equal(new Set(freeze.sourceIdentities.map((entry: { path: string }) => entry.path)).size, frozenPaths.length, "Missing or repeated source identity");
assert.equal(freeze.sourceIdentities.length, frozenPaths.length);
const ownerRoot = fileURLToPath(new URL("../../", import.meta.url));
for (const path of frozenPaths) {
  const entry = freeze.sourceIdentities.find((entry: { path: string }) => entry.path === path);
  assert.ok(entry, `Required source was not frozen: ${path}`);
  assert.equal(createHash("sha256").update(await readBounded(resolve(ownerRoot, path))).digest("hex"), entry.sha256,
    `Source changed after the execution freeze: ${path}`);
}
const migrationDirectory = resolve(ownerRoot, "packages/db/migrations");
const migrationNames = (await readdir(migrationDirectory)).filter(name => name.endsWith(".sql")).sort();
assert.ok(migrationNames.length > 0);
assert.deepEqual(freeze.registeredMigrations?.map((row: { name: string }) => row.name), migrationNames,
  "Complete SQL source population was not frozen before database setup");
for (const row of freeze.registeredMigrations) {
  assert.match(row.sha256, /^[a-f0-9]{64}$/);
  assert.equal(createHash("sha256").update(await readBounded(resolve(migrationDirectory, row.name))).digest("hex"), row.sha256,
    "Migration source changed after freeze: " + row.name);
}
assert.equal(report.migrationCount, migrationNames.length);
assert.deepEqual(report.migrationNames, migrationNames, "Migration return omits or duplicates a frozen source");
assert.deepEqual(report.observedMigrationNames, migrationNames, "Independent database inventory differs from frozen sources");
verifyPriorObservations(report);
if (!report.sourceOnly) await verifyNativeObservations(report, directory);
assert.ok(report.durationMs + performance.now() - verificationStarted < 1_200_000, "Driver plus mandatory verifier exceeded 1200 seconds");
process.stdout.write(JSON.stringify({ verified: true, sourceOnly: report.sourceOnly, verificationProfile: report.verificationProfile,
  predicateCount: required.length, qualification: report.sourceOnly ? "SOURCE_ONLY_DIAGNOSTIC" : "LOCAL_OWNING_BOUNDARY_ONLY" }) + "\n");
}

// Independent artifact checks deliberately do not call the reader, formatter,
// native origin builder, production schemas or production hash helpers.
const digest = (wire: string) => createHash("sha256").update(wire, "utf8").digest("hex");
const canonical = (value: any): string => value === undefined ? "null" : value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
const semantic = (value: unknown) => `sha256:${digest(canonical(value))}`;
function noFacts(value: unknown) {
  const wire = JSON.stringify(value);
  const secrets = ["950.25", "100.125", "41.75", "200.875", "999999", "finnor.recorded-revenue-statement", "finnor.recorded-market-quote"];
  const noLiteral = (text: string) => {
    for (const secret of secrets)
      assert.ok(!text.includes(secret), `Private source literal leaked into shared/error/model output: ${secret}`);
  };
  const visit = (node: any): void => {
    if (typeof node === "string") { noLiteral(node); return; }
    if (typeof node === "number") {
      for (const secret of secrets)
        assert.notEqual(node, Number(secret), `Private source literal leaked into shared/error/model output: ${secret}`);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(visit);
    for (const [key, child] of Object.entries(node)) {
      noLiteral(key);
      assert.ok(!["economicRead", "economicRevenue", "economicQuote", "price", "amount"].includes(key), `Private key escaped: ${key}`); visit(child);
    }
  };
  visit(wire === undefined ? undefined : JSON.parse(wire));
}
function denied(response: any) {
  assert.ok(Number.isInteger(response?.status) && response.status >= 400 && response.status < 500); noFacts(response.body);
}
function errorObserved(error: unknown) { assert.equal(typeof error, "string"); assert.ok((error as string).length > 0); noFacts(error); }
function queryOf(response: any) {
  const body = response?.body ?? response;
  return body.query ?? (body.request && body.result && (body.metadata ?? body.execution)
    ? { request: body.request, result: body.result, metadata: body.metadata ?? body.execution } : undefined);
}
const economic = (response: any) => {
  const body = response?.body ?? response;
  return body?.economicRead ?? queryOf(body)?.result?.economicRead ?? (body?.availability ? body : undefined);
};
function fullQuery(query: any, expectedStatus: "ok" | "unavailable" = "ok") {
  assert.ok(query?.request && query.result && query.metadata);
  const result = query.result, meta = query.metadata;
  assert.ok(["company_revenue", "stock_quote"].includes(query.request.intent));
  assert.equal(result.intent, query.request.intent); assert.equal(result.economicRead.intent, query.request.intent);
  assert.equal(result.kind, "operational_query_result"); assert.equal(result.version, 1); assert.equal(result.status, expectedStatus);
  assert.equal(result.execution.status, "succeeded"); assert.equal(result.execution.id, meta.queryId);
  assert.equal(typeof result.execution.executionKey, "string");
  assert.equal(meta.source, "postgresql"); assert.ok(Number.isFinite(meta.durationMs) && meta.durationMs >= 0);
  assert.ok(Number.isFinite(Date.parse(meta.startedAt)) && Date.parse(meta.completedAt) >= Date.parse(meta.startedAt));
  assert.equal(result.source.kind, "canonical_postgres"); assert.ok(result.source.tables.length > 0);
  assert.deepEqual(result.meta.source, result.source); assert.equal(result.meta.asOf, result.asOf);
  assert.equal(result.asOf, result.economicRead.observedAt); assert.equal(result.count, result.page.returned);
  assert.equal(result.page.hasMore, false); assert.equal(result.page.nextCursor, null); assert.equal(result.truncated, false);
  if (expectedStatus === "unavailable") {
    assert.equal(result.economicRead.availability, "UNAVAILABLE"); assert.deepEqual(result.economicRead.witnesses, []);
    assert.equal(result.count, 0); assert.equal(result.page.totalCount, 0); assert.equal(result.page.totalCountExact, true);
    assert.deepEqual(result.data, { availability: "UNAVAILABLE" });
  }
  return result.economicRead;
}
function literal(response: any, amount: "950.25" | "100.125" | "100.1" | "41.75") {
  const value = economic(response); assert.ok(value);
  assert.equal(amount === "100.125" || amount === "100.1" ? value.quote?.price : value.statement?.amount, amount);
  assert.ok(!JSON.stringify(value).includes("200.875") && !JSON.stringify(value).includes("999999"));
}
function unavailable(response: any) {
  const value = economic(response); assert.equal(value?.availability, "UNAVAILABLE");
  assert.equal(value.statement, undefined); assert.equal(value.quote, undefined);
}
function negativeCompanyEnvelope(response: any) {
  assert.equal(response.status, 201); unavailable(response);
  const query = queryOf(response), negative = fullQuery(query, "unavailable");
  assert.deepEqual(Object.keys(negative).sort(), ["availability", "intent", "observedAt", "reason", "witnesses"]);
  assert.equal(negative.intent, "company_revenue"); assert.equal(negative.availability, "UNAVAILABLE");
  assert.equal(negative.reason, "No owner-recorded reporting interpretation is configured for that company.");
  assert.ok(Number.isFinite(Date.parse(negative.observedAt)));
  assert.match(negative.observedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.deepEqual(negative.witnesses, []); noFacts(negative);
  assert.deepEqual(response.body.result.economicRead, negative);
  assert.deepEqual(fullQuery(response.body.answer.query, "unavailable"), negative);
  assert.deepEqual(response.body.answer.query, query);
  const negativeEnvelope = structuredClone(response);
  delete negativeEnvelope.body.result.economicRead; delete negativeEnvelope.body.answer.query.result.economicRead;
  noFacts(negativeEnvelope);
}
function positive(response: any, amount: "950.25" | "100.125" | "41.75" = "950.25") {
  if (response?.status !== undefined) assert.ok(response.status === 200 || response.status === 201);
  literal(response, amount); fullQuery(queryOf(response));
}
function privateBytes(snapshot: any) {
  assert.ok(Array.isArray(snapshot.privateRows));
  return snapshot.privateRows.map((row: any) => {
    assert.equal(digest(row.response_text), row.response_sha256);
    assert.deepEqual(JSON.parse(row.response_text), row.response);
    return { reply_key: row.reply_key, response_text: row.response_text, response_sha256: row.response_sha256 };
  });
}
function samePrivate(before: any, after: any) { assert.deepEqual(privateBytes(after), privateBytes(before)); }
function ordinaryPrivate(row: any) {
  assert.equal(row.reply_key, "input"); assert.equal(digest(row.response_text), row.response_sha256);
  assert.deepEqual(JSON.parse(row.response_text), row.response);
  assert.deepEqual(Object.keys(row.response).sort(), ["instructionId", "query", "workId", "workInputId"]);
  fullQuery(row.response.query); return row.response.query;
}

function verifyPriorObservations(report: any) {
  const get = (id: string) => {
    const row = report.results.find((item: any) => item.id === id);
    assert.equal(row?.status, "PASS"); assert.ok(row.observation !== undefined); return row.observation;
  };
  const revenue = get("SOURCE_REVENUE"); literal(revenue, "950.25");
  assert.equal(revenue.availability, "AVAILABLE"); assert.equal(revenue.statement.basis, "ACCRUAL"); assert.equal(revenue.statement.currency, "USD");
  unavailable(get("SOURCE_BASIS_MISMATCH")); unavailable(get("SOURCE_CURRENCY_MISMATCH"));
  for (const [id, state, price] of [["SOURCE_QUOTE", "CURRENT", "100.125"], ["SOURCE_DELAYED", "DELAYED", "100.1"]] as const) {
    const value = get(id); assert.equal(value.availability, state); literal(value, price);
  }
  const stale = get("SOURCE_STALE"); assert.equal(stale.availability, "STALE"); assert.equal(stale.quote, undefined); assert.equal(stale.lastKnown.price, "100.125");
  assert.equal(get("SOURCE_RIGHTS_REVOKED").rejected, true);
  if (report.sourceOnly) return;
  for (const id of ["TYPED_API_REVENUE", "TYPED_API_REVENUE_DUPLICATE"]) positive(get(id));
  assert.equal(get("TYPED_API_REVENUE").status, 201); assert.equal(get("TYPED_API_REVENUE_DUPLICATE").status, 200);
  assert.deepEqual(queryOf(get("TYPED_API_REVENUE")), queryOf(get("TYPED_API_REVENUE_DUPLICATE")));
  positive(get("TYPED_API_QUOTE_CURRENT"), "100.125");
  const natural = get("NATURAL_AND_DUPLICATE"); assert.equal(natural.first.status, 201); assert.equal(natural.replay.status, 200);
  positive(natural.first); positive(natural.replay); assert.deepEqual(queryOf(natural.first), queryOf(natural.replay));
  const core = get("CORE_PRIOR_CLASSIFICATION"), coreReplay = get("CORE_DUPLICATE");
  positive(core); positive(coreReplay); assert.deepEqual(core.actions, []); assert.equal(core.objective, undefined);
  assert.deepEqual(core.query, coreReplay.query); assert.equal(core.workInputId, coreReplay.workInputId);
  const auth = get("AUTHENTICATION"); assert.equal(auth.anonymous.status, 401); assert.equal(auth.invalid.status, 401); noFacts(auth);
  negativeCompanyEnvelope(get("FOREIGN_TENANT"));
  unavailable(get("NAMED_COMPANY_NO_SUBSTITUTION")); unavailable(get("MISSING_REPORTING_CALENDAR"));
  positive(get("PROVISIONAL_CASH_FISCAL_REVENUE"), "41.75");
  const cash = economic(get("PROVISIONAL_CASH_FISCAL_REVENUE"));
  assert.equal(cash.statement.basis, "CASH"); assert.equal(cash.statement.currency, "EUR"); assert.equal(cash.statement.reportingStatus, "PROVISIONAL");
  const staleHttp = get("TYPED_API_STALE_QUOTE"); assert.equal(staleHttp.status, 201);
  assert.equal(economic(staleHttp).availability, "STALE"); assert.equal(economic(staleHttp).quote, undefined); assert.equal(economic(staleHttp).lastKnown.price, "100.125");
  unavailable(get("TYPED_API_UNAVAILABLE_QUOTE")); assert.ok(!JSON.stringify(get("TYPED_API_UNAVAILABLE_QUOTE")).includes("200.875"));
  denied(get("TYPED_API_QUOTE_REPLAY_REVOKED")); denied(get("UNAVAILABLE_REPLAY_CURRENTNESS"));
  const effect = (response: any) => {
    assert.equal(response.status, 503); assert.equal(response.body.code, "worker_fleet_unavailable"); assert.equal(economic(response), undefined); noFacts(response.body);
  };
  effect(get("MIXED_NEGATION_EFFECT_PRESERVED"));
  const shared = get("SHARED_ECONOMIC_REDACTION"); assert.ok(shared.initialShared !== undefined); noFacts(shared.initialShared);
  assert.match(JSON.stringify(shared.originalPrivate), /950\.25|100\.125/);
  const context = get("CONTEXT_READ_NO_FLEET"); assert.ok(context.responses.length > 0);
  for (const item of context.responses) positive(item.response ?? item, economic(item.response ?? item)?.intent === "stock_quote" ? "100.125" : "950.25");
  const forms = get("REVENUE_NAMED_FORMS"); assert.equal(forms.length, 12);
  for (const item of forms) {
    assert.equal(item.response.status, 201);
    const request = queryOf(item.response).request; assert.equal(request.company.kind, "NAME"); assert.ok(item.instruction.includes(request.company.name));
    if (item.instruction.includes("Unrelated Holdings")) unavailable(item.response); else positive(item.response);
  }
  const selectors = get("REVENUE_SELECTORS"); unavailable(selectors.mismatch); positive(selectors.cash, "41.75");
  assert.equal(queryOf(selectors.mismatch).request.basis, "CASH"); assert.equal(queryOf(selectors.mismatch).request.currency, "EUR");
  assert.equal(selectors.calendars.length, 4);
  for (const item of selectors.calendars) { unavailable(item.response); assert.ok(["CALENDAR", "FISCAL"].includes(queryOf(item.response).request.calendar)); }
  const effects = get("POSITIVE_EFFECT_VOCABULARY"); assert.equal(effects.length, 7); effects.forEach((item: any) => effect(item.response));
  const multiline = get("MULTILINE_NEGATION"); effect(multiline.positive); positive(multiline.negative);
  const scoped = get("RESOLVED_RESOURCE_SCOPES"); assert.ok(scoped.responses.length > 0);
  for (const item of scoped.responses) positive(item.response ?? item, economic(item.response ?? item)?.intent === "stock_quote" ? "100.125" : "950.25");
  positive(scoped.core); negativeCompanyEnvelope(scoped.foreign);
  const grants = get("SCOPED_GRANT_CURRENTNESS"); positive(grants.original); assert.equal(grants.observations.length, 6);
  for (const item of grants.observations) { denied(item.fresh); denied(item.replay); }
  positive(grants.restored); assert.deepEqual(queryOf(grants.original), queryOf(grants.restored));
  function committed(snapshot: any) {
    assert.equal(snapshot.receipts.length, 1); assert.equal(snapshot.receipts[0].status, "succeeded"); assert.equal(snapshot.responses.length, 1);
    const reply = snapshot.responses[0].response, query = queryOf(reply); fullQuery(query);
    assert.equal(reply.workId, snapshot.work.id); assert.equal(reply.workInputId, snapshot.input.id); assert.equal(reply.instructionId, snapshot.input.instruction_id);
    assert.equal(query.result.execution.id, snapshot.receipts[0].id); assert.deepEqual(query.request, snapshot.receipts[0].request);
    noFacts({ work: snapshot.work, events: snapshot.events, traces: snapshot.traces, receipts: snapshot.receipts });
    return query;
  }
  for (const id of ["COMMITTED_RECEIPT_RECOVERY_NO_KEY", "SUPPLIED_ID_RECOVERY_CUSTODY", "PRIVATE_INSERT_ATOMIC_RECOVERY"]) {
    const row = get(id); assert.equal(row.first.status, 500); noFacts(row.first.body);
    if (id === "COMMITTED_RECEIPT_RECOVERY_NO_KEY") committed(row.before);
    else { assert.equal(row.before.responses.length, 0); assert.equal(row.before.receipts.filter((item: any) => item.status === "succeeded").length, 0); }
    const query = committed(row.recovery.after); positive(row.recovery.response); positive(row.duplicate);
    assert.equal(row.recovery.after.input.id, row.before.input.id); assert.deepEqual(queryOf(row.duplicate), query);
    if (id === "COMMITTED_RECEIPT_RECOVERY_NO_KEY") assert.deepEqual(row.before.responses, row.recovery.after.responses);
    if (id === "PRIVATE_INSERT_ATOMIC_RECOVERY") assert.equal(row.before.receipts[0].id, row.recovery.after.receipts[0].id);
  }
  const trace = get("TRACE_FAILURE_BEST_EFFORT"); positive(trace.first); committed(trace.s); assert.equal(trace.s.work.status, "completed");
  positive(get("QUOTE_EXPLICIT_SUBJECT").response, "100.125");
  const simultaneous = get("SIMULTANEOUS_QUOTE_VALIDITY"); assert.equal(simultaneous.duplicateWithinBindingRejected, true);
  assert.equal(new Set(simultaneous.sourceIdsInSqlOrder).size, 2); assert.equal(simultaneous.observations.length, 6);
  assert.equal(economic(simultaneous.observations[0].response).availability, "CURRENT");
  assert.equal(economic(simultaneous.observations[1].response).availability, "CURRENT");
  assert.equal(economic(simultaneous.observations[2]).availability, "STALE");
  for (const item of simultaneous.observations.slice(3)) { assert.equal(economic(item).availability, "CONFLICTED"); assert.equal(economic(item).quote, undefined); }
  const denies = get("EXACT_CAPABILITY_DENIES"); assert.equal(denies.length, 2);
  assert.equal(denies[0].status, 201); positive(denies[0]); denied(denies[1]);
  for (const id of ["ANCILLARY_RESPONSE_FAILURE_REPLAY", "ASSISTANT_PROJECTION_FAILURE_REPLAY"]) {
    const row = get(id); positive(row.first); positive(row.duplicate); const query = committed(row.s);
    assert.ok(row.first.body.projectionWarnings.some((warning: any) => warning.stage === (id === "ANCILLARY_RESPONSE_FAILURE_REPLAY" ? "response" : "assistant message")));
    assert.deepEqual(queryOf(row.duplicate), query);
    if (id === "ANCILLARY_RESPONSE_FAILURE_REPLAY") {
      assert.equal(row.duplicate.body.replayDegraded, true);
      assert.deepEqual(Object.keys(row.s.responses[0].response).sort(), ["instructionId", "query", "workId", "workInputId"]);
    }
  }
  const possessives = get("QUOTE_POSSESSIVE"); assert.equal(possessives.length, 3);
  possessives.forEach((item: any) => { positive(item.response, "100.125"); assert.equal(queryOf(item.response).request.instrument.kind, "NAME"); });
  const entities = get("EFFECT_WORD_ENTITY"); assert.equal(entities.length, 7);
  for (const item of entities) { const response = item.response ?? item.conjunction; if (response.status === 503) effect(response); else positive(response); }
  const typed = get("TYPED_REQUEST_RECOVERY"); assert.equal(typed.length, 2);
  for (const item of typed) {
    assert.equal(item.first.status, 500); const query = committed(item.recovery.after);
    assert.ok(item.recovery.after.input.instruction_text.startsWith("Typed economic query v1: "));
    assert.deepEqual(queryOf(item.duplicate), query); assert.equal(item.recovery.after.input.id, item.before.input.id);
  }
  const corrupt = get("COMPLETE_OUTPUT_REPLAY_VALIDATION"); assert.equal(corrupt.length, 26); corrupt.forEach((item: any) => denied(item.replay));
  const original = get("ORIGINAL_INPUT_PRINCIPAL_IDENTITY"); positive(original.first); assert.equal(original.observations.length, 3);
  original.observations.forEach((item: any) => errorObserved(item.rejection)); denied(original.retryByPeer); committed(original.after);
  const background = get("BACKGROUND_PRINCIPAL_NO_ACTIVATION");
  assert.deepEqual(background.principal, { current_user: "finnor_worker", rolsuper: false, rolbypassrls: false });
  assert.equal(background.observations.length, 2);
  for (const item of background.observations) { committed(item.s); assert.equal(item.s.work.status, "completed"); assert.equal(item.job.length, 1); assert.equal(item.job[0].status, "completed"); assert.equal(item.job[0].attempts, 1); }
  const inflight = get("IN_FLIGHT_DUPLICATE_RECEIPT"); assert.equal(inflight.inProgress.status, 202); noFacts(inflight.inProgress.body);
  assert.equal(inflight.inProgress.body.inProgress, true); assert.equal(inflight.inProgress.body.retryRequired, false);
  assert.deepEqual(queryOf(inflight.duplicate), committed(inflight.s));
}

async function verifyNativeObservations(report: any, directory: string) {
  const get = (id: string) => report.results.find((row: any) => row.id === id).observation;
  const sources = JSON.parse((await readBounded(resolve(directory, "objective-original-source-rows.json"))).toString("utf8"));
  function sourceBytes(rows: any) {
    assert.ok(rows.versions.length >= 3 && rows.observations.length >= 2 && rows.mappings.length >= 1 && rows.sourceLinks.length >= 1);
    for (const table of [rows.versions, rows.observations, rows.mappings, rows.sourceLinks])
      for (const row of table) assert.equal(digest(row.row_text), row.row_sha256);
    for (const row of rows.versions) {
      assert.equal(digest(row.snapshot_text), row.snapshot_sha256);
      assert.deepEqual(JSON.parse(row.snapshot_text), row.snapshot);
      const raw = JSON.parse(row.row_text);
      assert.equal(raw.id, row.id); assert.equal(raw.source_id, row.source_id); assert.equal(raw.content_hash, row.content_hash);
      assert.deepEqual(raw.snapshot, row.snapshot);
    }
  }
  sourceBytes(sources);
  const revenueSource = sources.versions.find((row: any) => row.snapshot.economicRevenue?.amount === "950.25");
  const cashSource = sources.versions.find((row: any) => row.snapshot.economicRevenue?.amount === "41.75");
  assert.ok(revenueSource && cashSource); assert.notEqual(revenueSource.tenant_id, cashSource.tenant_id);
  assert.equal(revenueSource.snapshot.economicRevenue.basis, "ACCRUAL"); assert.equal(cashSource.snapshot.economicRevenue.basis, "CASH");
  assert.equal(cashSource.snapshot.economicRevenue.currency, "EUR"); assert.equal(cashSource.snapshot.economicRevenue.reportingStatus, "PROVISIONAL");
  const setups = (await readBounded(resolve(directory, "objective-v1-setups.ndjson"))).toString("utf8").trim().split("\n").map((line: string) => JSON.parse(line));
  assert.equal(setups.length, 34); assert.equal(new Set(setups.map((row: any) => row.accepted.workId)).size, 34);
  function materialWait(locks: any[], holder: number, waiter: number) {
    assert.notEqual(holder, waiter);
    const waiting = locks.filter(row => row.pid === waiter && row.locktype === "advisory" && row.granted === false);
    assert.equal(waiting.length, 1); assert.equal(waiting[0].mode, "ExclusiveLock"); assert.equal(waiting[0].objsubid, 1);
    assert.ok(locks.some(row => row.pid === holder && row.locktype === "advisory" && row.granted === true
      && row.mode === waiting[0].mode && row.classid === waiting[0].classid && row.objid === waiting[0].objid
      && row.objsubid === waiting[0].objsubid));
  }
  for (const row of setups) {
    errorObserved(row.stopped); assert.equal(row.captures.length, 1); noFacts(row.captures);
    assert.equal(row.prepared.plans.length, 1); assert.equal(row.prepared.plans[0].status, "active");
    assert.equal(row.prepared.receipts.length, 0); assert.equal(row.prepared.loop.query_count, 0);
    assert.ok(row.prepared.steps.every((step: any) => !step.budget_reserved_at));
    assert.equal(row.attempts.length, 1); assert.equal(row.attempts[0].status, "succeeded");
    assert.equal(row.jobs.length, row.label === "primary" ? 1 : 0);
  }
  const initial = setups.find((row: any) => row.label === "primary"), probe = initial.materialFenceProbe;
  assert.equal(probe.before.work.id, initial.accepted.workId); assert.equal(probe.before.loop.id, initial.accepted.objectiveLoopId);
  assert.equal(probe.before.inputs[0].id, initial.accepted.workInputId); assert.equal(probe.before.steps.length, 0);
  assert.equal(probe.before.loop.step_count, 0); assert.equal(probe.loopRows.length, 1);
  assert.equal(probe.loopRows[0].id, initial.accepted.objectiveLoopId); assert.equal(probe.loopRows[0].step_count, 0);
  assert.equal(probe.loopRows[0].query_count, 0); assert.equal(probe.cursorRows.length, 1);
  assert.equal(probe.cursorRows[0].tenant_id, probe.before.loop.tenant_id);
  assert.equal(probe.waiting.usename, "finnor_app"); assert.equal(probe.waiting.wait_event_type, "Lock");
  assert.ok(probe.waiting.blockers.includes(probe.blocker.pid));
  assert.notEqual(probe.waiting.observer_pid, probe.blocker.pid); assert.notEqual(probe.waiting.observer_pid, probe.waiting.pid);
  assert.match(probe.waiting.query, /^\s*SELECT pg_advisory_xact_lock\(hashtextextended\('v3-material-cut:'/i);
  materialWait(probe.locks, probe.blocker.pid, probe.waiting.pid);
  assert.equal(probe.result.error, initial.stopped); assert.equal(probe.result.outcome, undefined);
  noFacts({ waiting: probe.waiting, locks: probe.locks, result: probe.result });
  const journal = (await readBounded(resolve(directory, "objective-v1-steps.ndjson"))).toString("utf8").trim().split("\n").map((line: string) => JSON.parse(line));
  assert.ok(journal.filter((row: any) => row.step === "REAL_SQL_FAULT_INSTALLED").length >= 43);
  assert.ok(journal.some((row: any) => row.step === "AUTHENTICATED_GET"));
  function native(snapshot: any, sourceRows = sources) {
    assert.ok(snapshot.receipts.length > 0); assert.equal(snapshot.receipts.length, snapshot.privateRows.length);
    privateBytes(snapshot);
    for (const receipt of snapshot.receipts) {
      assert.equal(receipt.status, "succeeded");
      const slot = snapshot.privateRows.find((row: any) => row.reply_key === `objective:${receipt.objective_step_id}`);
      assert.ok(slot); const reply = slot.response, origin = reply.objective;
      assert.deepEqual(Object.keys(reply).sort(), ["instructionId", "objective", "query", "workId", "workInputId"]);
      const step = snapshot.steps.find((row: any) => row.id === receipt.objective_step_id);
      const plan = snapshot.plans.find((row: any) => row.id === origin.planRevisionId);
      const input = snapshot.inputs.find((row: any) => row.id === reply.workInputId);
      assert.ok(input && step && plan);
      assert.equal(digest(input.row_text), input.row_sha256); assert.equal(JSON.parse(input.row_text).instruction_text, input.instruction_text);
      assert.equal(origin.kind, "objective_query");
      assert.equal(origin.originalPrincipalId, input.created_by); assert.equal(origin.originalPrincipalId, snapshot.loop.created_by);
      assert.equal(snapshot.principals.find((row: any) => row.id === input.created_by)?.status, "active");
      assert.equal(origin.originalWorkInputId, input.id); assert.equal(origin.originalInstructionId, input.instruction_id);
      assert.equal(origin.originalInputSha256, digest(input.instruction_text)); assert.equal(input.instruction_text, snapshot.loop.objective);
      assert.equal(origin.objectiveLoopId, snapshot.loop.id); assert.equal(origin.objectiveRevision, snapshot.loop.revision);
      assert.equal(origin.objectiveStepId, step.id); assert.equal(origin.planNodeId, step.plan_node_id);
      assert.equal(origin.planRevisionId, step.plan_revision_id); assert.equal(origin.attemptNumber, step.attempt_number);
      assert.equal(step.objective_revision, snapshot.loop.revision); assert.ok(step.budget_reserved_at);
      assert.equal(origin.acceptanceHash, semantic(snapshot.loop.success_condition));
      assert.equal(reply.workId, snapshot.work.id); assert.equal(reply.workInputId, input.id); assert.equal(reply.instructionId, input.instruction_id);
      assert.equal(plan.work_input_id, input.id); assert.equal(plan.work_id, snapshot.work.id);
      const goal = plan.goal_spec, graph = plan.plan_graph;
      assert.deepEqual(goal.successCondition, snapshot.loop.success_condition);
      assert.equal(goal.workId, snapshot.work.id); assert.equal(goal.workInputId, input.id); assert.equal(goal.statement, input.instruction_text.trim());
      const computedGoal = semantic({ workId: goal.workId, workInputId: goal.workInputId, statement: goal.statement,
        targets: goal.targets, successCondition: goal.successCondition, criteria: goal.criteria, deadline: goal.deadline,
        explicitNonGoals: goal.explicitNonGoals, source: goal.source });
      assert.equal(goal.semanticHash, computedGoal); assert.equal(plan.goal_hash, computedGoal); assert.equal(origin.goalSemanticHash, computedGoal);
      assert.equal(graph.goalHash, computedGoal);
      for (const criterion of goal.criteria) assert.equal(criterion.id, `criterion_${goal.criteria.indexOf(criterion) + 1}_${semantic(criterion.criterion).slice(7, 19)}`);
      const node = graph.nodes.find((row: any) => row.id === step.plan_node_id); assert.ok(node && node.kind === "query");
      for (const item of graph.nodes) {
        assert.ok(["query", "check"].includes(item.kind)); assert.deepEqual(item.preconditions, []);
        const candidate = { kind: item.kind, supports: [...item.supports].sort(), preconditions: [], expectedEffects: [], recovery: null,
          ...(item.kind === "query" ? { request: item.request } : { criterionId: item.criterionId, observation: {} }) };
        assert.equal(item.semanticHash, semantic(candidate), "Node hash must bind the actual original fixture candidate, not a supplied row hash");
        assert.equal(item.id, `node_${semantic({ semantic: item.semanticHash,
          dependencies: item.dependsOn.map((id: string) => graph.nodes.find((dependency: any) => dependency.id === id).semanticHash).sort() }).slice(7, 31)}`);
      }
      for (const edge of graph.edges) assert.equal(edge.semanticHash, semantic({
        from: graph.nodes.find((item: any) => item.id === edge.from).semanticHash,
        to: graph.nodes.find((item: any) => item.id === edge.to).semanticHash, kind: "causal_prerequisite" }));
      const graphProjection = { version: 1, goalHash: graph.goalHash, constraintHash: graph.constraintHash, snapshotHash: graph.snapshotHash,
        nodes: graph.nodes.map(({ id: _id, ...item }: any) => ({ ...item,
          dependsOn: item.dependsOn.map((id: string) => graph.nodes.find((candidate: any) => candidate.id === id).semanticHash).sort() }))
          .sort((a: any, b: any) => a.semanticHash.localeCompare(b.semanticHash)),
        edges: graph.edges.map((edge: any) => edge.semanticHash),
        completionCoverage: graph.completionCoverage.map((coverage: any) => ({ criterionId: coverage.criterionId,
          checkSemanticHash: graph.nodes.find((item: any) => item.id === coverage.checkNodeId).semanticHash }))
          .sort((a: any, b: any) => a.criterionId.localeCompare(b.criterionId)) };
      assert.equal(graph.semanticHash, semantic(graphProjection)); assert.equal(plan.semantic_hash, graph.semanticHash);
      assert.equal(origin.planSemanticHash, graph.semanticHash); assert.equal(origin.nodeSemanticHash, node.semanticHash);
      assert.equal(receipt.work_id, snapshot.work.id); assert.equal(receipt.work_input_id, input.id);
      assert.equal(receipt.execution_key, `objective-economic:${step.id}`); assert.deepEqual(receipt.request, node.request);
      const value = fullQuery(reply.query);
      assert.equal(reply.query.result.execution.id, receipt.id); assert.equal(reply.query.result.execution.executionKey, receipt.execution_key);
      assert.equal(reply.query.result.execution.workId, snapshot.work.id); assert.equal(reply.query.result.execution.workInputId, input.id);
      assert.deepEqual(reply.query.request, receipt.request); assert.equal(receipt.intent, reply.query.request.intent);
      assert.equal(receipt.duration_ms, Math.round(reply.query.metadata.durationMs));
      assert.equal(Date.parse(receipt.completed_at), Date.parse(reply.query.metadata.completedAt));
      assert.ok(value.witnesses.length > 0);
      for (const witness of value.witnesses) {
        const source = sourceRows.versions.find((row: any) => row.id === witness.versionId); assert.ok(source);
        assert.equal(witness.sourceId, source.source_id); assert.equal(witness.contentHash, source.content_hash);
        assert.equal(Date.parse(witness.asOf), Date.parse(source.as_of)); assert.equal(source.tenant_id, snapshot.work.tenant_id);
        if (receipt.intent === "company_revenue") {
          assert.deepEqual(value.statement, source.snapshot.economicRevenue); literal(reply, "950.25");
          assert.equal(value.statement.companyId, revenueSource.snapshot.economicRevenue.companyId);
          const observation = sourceRows.observations.find((row: any) => row.value.id === witness.observationId);
          assert.ok(observation); assert.equal(observation.value.evidence_version_id, source.id);
          assert.equal(Number(observation.value.value_numeric), 950.25); assert.equal(observation.value.metric_series_id, witness.metricSeriesId);
        } else {
          assert.deepEqual(value.quote, source.snapshot.economicQuote); literal(reply, "100.125");
          assert.equal(value.quote.instrument.symbol, "AAPL"); assert.equal(value.quote.instrument.exchange, "XNAS");
          assert.equal(value.quote.instrument.issuerCompanyId, revenueSource.snapshot.economicRevenue.companyId);
          assert.equal(value.quote.license.displayAllowed, true);
          const mapping = sourceRows.mappings.find((row: any) => row.value.evidence_version_id === source.id); assert.ok(mapping);
          assert.equal(mapping.value.canonical_entity_id, value.quote.instrument.issuerCompanyId);
          assert.ok(sourceRows.sourceLinks.some((row: any) => row.value.id === mapping.value.source_link_id && row.value.internal_id === value.quote.instrument.issuerCompanyId));
        }
      }
      assert.deepEqual(receipt.result_summary.originalSourceVersions, value.witnesses.map((row: any) => row.versionId));
    }
    return snapshot;
  }
  const queue = get("OBJ_QUEUE_INLINE_NO_ACTIVATION");
  assert.deepEqual(queue.principal, { current_user: "finnor_worker", rolsuper: false, rolbypassrls: false });
  assert.equal(queue.job.length, 1); assert.equal(queue.job[0].status, "completed"); assert.equal(queue.job[0].attempts, 1);
  native(queue.snapshot); assert.equal(queue.snapshot.receipts.length, 2); assert.equal(queue.snapshot.loop.state, "completed");
  const scoped = get("OBJ_PLAN_SCOPED_RESOLUTION"); native(scoped.snapshot); positive(scoped.response);
  assert.deepEqual(scoped.principal, { current_user: "finnor_app", rolsuper: false, rolbypassrls: false });
  assert.equal(scoped.captures.length, 1); noFacts(scoped.captures);
  const allows = scoped.grants.grants.filter((row: any) => row.effect === "allow");
  assert.deepEqual(allows.map((row: any) => row.capability).sort(), ["query:company_revenue", "query:stock_quote"]);
  assert.ok(allows.every((row: any) => row.resource_type === "external_organization"));
  assert.ok(scoped.grants.grants.some((row: any) => row.capability === "query:team_roster" && row.effect === "deny"));
  assert.equal(scoped.grants.assignments.length, 1);
  assert.deepEqual(scoped.grants.assignments[0].resource_scope, { kind: "resources", resourceType: "external_organization",
    resourceIds: [revenueSource.snapshot.economicRevenue.companyId] });
  const multiple = get("OBJ_MULTI_QUERY_PRIVATE_CUSTODY"); native(multiple.snapshot); assert.equal(multiple.snapshot.inputs.length, 1);
  assert.equal(multiple.snapshot.privateRows.length, 2); assert.equal(new Set(multiple.snapshot.receipts.map((row: any) => row.objective_step_id)).size, 2);
  assert.equal(multiple.ordinaryDuplicate.duplicate, true); assert.ok(!multiple.ordinaryDuplicate.response); noFacts(multiple.ordinaryDuplicate);
  multiple.responses.forEach((response: any) => { assert.equal(response.status, 200); nativeHttpMatches(response, multiple.snapshot); });
  native(multiple.chain.snapshot); assert.equal(multiple.chain.outcome, "completed");
  assert.equal(multiple.chain.snapshot.receipts.length, 3); assert.equal(multiple.chain.snapshot.loop.query_count, 3);
  const chainGraph = multiple.chain.snapshot.plans[0].plan_graph;
  const chainQueries = chainGraph.nodes.filter((node: any) => node.kind === "query");
  assert.equal(chainQueries.length, 3);
  const firstQuery = chainQueries.find((node: any) => node.dependsOn.length === 0); assert.ok(firstQuery);
  const secondQuery = chainQueries.find((node: any) => node.dependsOn.length === 1 && node.dependsOn[0] === firstQuery.id); assert.ok(secondQuery);
  const thirdQuery = chainQueries.find((node: any) => node.dependsOn.length === 1 && node.dependsOn[0] === secondQuery.id); assert.ok(thirdQuery);
  for (const query of chainQueries) {
    assert.ok(chainGraph.nodes.some((node: any) => node.kind === "check" && node.dependsOn.length === 1
      && node.dependsOn[0] === query.id && query.supports.includes(node.criterionId)));
    assert.ok(multiple.chain.snapshot.steps.some((step: any) => step.plan_node_id === query.id
      && step.completed_at && step.execution_state === "completed" && step.query_execution_id));
  }
  native(multiple.repeated.snapshot); assert.equal(multiple.repeated.outcome, "completed");
  assert.equal(multiple.repeated.snapshot.receipts.length, 2);
  assert.deepEqual(multiple.repeated.snapshot.receipts[0].request, multiple.repeated.snapshot.receipts[1].request);
  const repeatedGoal = multiple.repeated.snapshot.plans[0].goal_spec;
  assert.deepEqual(repeatedGoal.successCondition.criteria.map((criterion: any) => criterion.assertion),
    [{ path: ["status"], operator: "eq", expected: "ok" }, { path: ["execution", "status"], operator: "eq", expected: "succeeded" }]);
  const repeatedVerification = multiple.repeated.snapshot.loop.success_verification;
  assert.equal(repeatedVerification.state, "verified"); assert.ok(repeatedVerification.results.every((row: any) => row.satisfied));
  assert.equal(new Set(repeatedVerification.queryExecutionIds).size, 2);
  for (const [index, queryId] of repeatedVerification.queryExecutionIds.entries()) {
    const receipt = multiple.repeated.snapshot.receipts.find((row: any) => row.id === queryId); assert.ok(receipt);
    const step = multiple.repeated.snapshot.steps.find((row: any) => row.id === receipt.objective_step_id);
    const node = multiple.repeated.snapshot.plans[0].plan_graph.nodes.find((row: any) => row.id === step.plan_node_id);
    assert.ok(node.supports.includes(repeatedGoal.criteria[index].id));
  }
  native(multiple.barrier.snapshot); assert.equal(multiple.barrier.outcome, "completed");
  assert.equal(multiple.barrier.snapshot.receipts.length, 3); assert.equal(multiple.barrier.snapshot.steps.length, 6);
  const barrier = multiple.barrier.snapshot, barrierGraph = barrier.plans[0].plan_graph;
  let precedingQuery = barrierGraph.nodes.find((node: any) => node.kind === "query" && node.dependsOn.length === 0);
  assert.ok(precedingQuery);
  for (let index = 0; index < 2; index++) {
    const checkNode = barrierGraph.nodes.find((node: any) => node.kind === "check" && node.dependsOn.length === 1 && node.dependsOn[0] === precedingQuery.id);
    assert.ok(checkNode);
    const followingQuery = barrierGraph.nodes.find((node: any) => node.kind === "query" && node.dependsOn.length === 1 && node.dependsOn[0] === checkNode.id);
    assert.ok(followingQuery);
    const checkStep = barrier.steps.find((step: any) => step.plan_node_id === checkNode.id);
    const followingStep = barrier.steps.find((step: any) => step.plan_node_id === followingQuery.id);
    const precedingStep = barrier.steps.find((step: any) => step.plan_node_id === precedingQuery.id);
    assert.equal(checkStep.iteration_outcome, "continue"); assert.equal(checkStep.success_verification, null);
    assert.equal(checkStep.verification_result.state, "verified");
    assert.equal(checkStep.query_execution_id, null);
    assert.equal(checkStep.observation.queryExecutionId, precedingStep.query_execution_id);
    const proof = checkStep.verification_result;
    assert.equal(proof.version, 1); assert.equal(proof.planRevisionId, barrier.plans[0].id);
    assert.equal(proof.planNodeId, checkNode.id); assert.equal(proof.attemptNumber, checkStep.attempt_number);
    assert.deepEqual(proof.subject, { kind: "objective", id: barrier.loop.id });
    assert.deepEqual(proof.observationRefs, [{ type: "work_query_execution", id: precedingStep.query_execution_id }]);
    assert.deepEqual(proof.verifier, { kind: "objective_condition", rule: "accepted_objective_query_criterion_v1" });
    const acceptedCriterion = barrier.plans[0].goal_spec.successCondition.criteria[index];
    const originalResult = barrier.privateRows.find((row: any) => row.response.query.result.execution.id === precedingStep.query_execution_id).response.query.result;
    const criterionResult = { index, kind: "canonical_query", satisfied: true,
      basis: "The original native query receipt and current private use rights were independently checked.",
      evidenceRefs: [{ type: "work_query_execution", id: precedingStep.query_execution_id }],
      observed: { path: acceptedCriterion.assertion.path, operator: "eq", expected: acceptedCriterion.assertion.expected,
        actual: acceptedCriterion.assertion.path.length === 1 ? originalResult.status : originalResult.execution.status } };
    assert.equal(proof.evidenceHash, semantic({ state: proof.state, planRevisionId: proof.planRevisionId, planNodeId: proof.planNodeId,
      attemptNumber: proof.attemptNumber, subject: proof.subject, observationRefs: proof.observationRefs,
      verifier: proof.verifier, establishedAt: proof.establishedAt, evidence: criterionResult }));
    assert.equal(checkStep.observation.kind, "private_economic_criterion"); assert.equal(checkStep.observation.criterionIndex, index);
    for (const value of [checkStep.completed_at, followingStep.started_at, followingStep.budget_reserved_at])
      assert.equal(typeof value, "string");
    const completedAt = Date.parse(checkStep.completed_at), startedAt = Date.parse(followingStep.started_at);
    const reservedAt = Date.parse(followingStep.budget_reserved_at);
    assert.ok([completedAt, startedAt, reservedAt].every(Number.isFinite));
    assert.ok(completedAt <= startedAt); assert.ok(completedAt <= reservedAt);
    precedingQuery = followingQuery;
  }
  function nativeHttpMatches(response: any, snapshot: any) {
    assert.equal(response.status, 200); assert.equal(response.headers["cache-control"], "no-store");
    const reply = snapshot.privateRows.find((row: any) => row.response.query.result.execution.id === response.body.query.result.execution.id);
    assert.ok(reply); assert.deepEqual(response.body, reply.response);
  }
  const binding = get("OBJ_NATIVE_PROVENANCE_BINDING"); binding.selectors.forEach(denied); assert.equal(binding.selectors.length, 3);
  assert.equal(binding.fenced.length, 2);
  for (const row of binding.fenced) { assert.equal(row.reservation.state, "reserved"); assert.equal(row.snapshot.receipts.length, 0); assert.equal(row.snapshot.privateRows.length, 0); assert.notEqual(row.outcome, "completed"); }
  samePrivate(binding.primaryState, binding.after);
  const human = get("OBJ_ORIGINAL_HUMAN_ONLY"); assert.equal(human.denials.length, 5); human.denials.forEach((row: any) => denied(row.response));
  errorObserved(human.serviceError); denied(human.inactiveHttp); errorObserved(human.inactiveNative);
  assert.equal(human.inactiveSnapshot.principals.find((row: any) => row.id === human.pending.snapshot.inputs[0].created_by).status, "suspended");
  assert.notEqual(human.inactiveSnapshot.loop.state, "completed"); nativeHttpMatches(human.restored, human.pending.snapshot);
  assert.notEqual(human.primaryState.work.current_owner_id, human.primaryState.inputs[0].created_by);
  native(human.after); samePrivate(human.pending.snapshot, human.after);
  const replay = get("OBJ_SAME_PRINCIPAL_REPLAY"); native(replay.before); native(replay.after); samePrivate(replay.before, replay.after);
  assert.deepEqual(replay.before.receipts, replay.after.receipts); replay.responses.forEach((response: any) => nativeHttpMatches(response, replay.before));
  const recovery = get("OBJ_COMMITTED_STEP_RECOVERY"); assert.equal(recovery.scenarios.length, 2);
  for (const row of recovery.scenarios) {
    errorObserved(row.before.error); native(row.before.snapshot); native(row.after); samePrivate(row.before.snapshot, row.after);
    assert.equal(row.before.snapshot.loop.state, "continue"); assert.equal(row.after.loop.state, "completed");
    assert.deepEqual(row.after.receipts, row.before.snapshot.receipts); nativeHttpMatches(row.httpBefore, row.before.snapshot);
    if (row.afterProof) {
      assert.equal(row.before.snapshot.plans[0].status, "active");
      assert.equal(row.before.snapshot.plans[0].completion_proof, null);
    }
  }
  const bounded = recovery.boundedDelivery; native(bounded.before.snapshot); native(bounded.after);
  errorObserved(bounded.before.error); assert.equal(bounded.outcome, "completed");
  assert.equal(bounded.before.snapshot.loop.max_steps, 2); assert.equal(bounded.after.loop.max_steps, 2);
  assert.equal(bounded.before.snapshot.loop.step_count, 2); assert.equal(bounded.after.loop.step_count, 2);
  assert.equal(bounded.before.snapshot.steps.length, 2); assert.equal(bounded.after.steps.length, 2);
  assert.ok(bounded.before.snapshot.steps.find((row: any) => row.step_number === 1).completed_at);
  assert.equal(bounded.before.snapshot.steps.find((row: any) => row.step_number === 2).completed_at, null);
  assert.equal(bounded.after.loop.query_count, bounded.before.snapshot.loop.query_count);
  assert.equal(bounded.after.loop.node_attempt_count, bounded.before.snapshot.loop.node_attempt_count);
  samePrivate(bounded.before.snapshot, bounded.after); assert.deepEqual(bounded.after.receipts, bounded.before.snapshot.receipts);
  const uncommitted = get("OBJ_UNCOMMITTED_PRIVATE_RECOVERY"); errorObserved(uncommitted.error); errorObserved(uncommitted.unfencedError); errorObserved(uncommitted.staleClaimError);
  assert.equal(uncommitted.before.privateRows.length, 0); assert.equal(uncommitted.before.receipts.length, 1); assert.equal(uncommitted.before.receipts[0].status, "failed");
  assert.equal(uncommitted.unfenced.privateRows.length, 0); assert.deepEqual(uncommitted.before.receipts, uncommitted.unfenced.receipts);
  native(uncommitted.after); assert.equal(uncommitted.after.receipts[0].id, uncommitted.before.receipts[0].id); assert.equal(uncommitted.after.loop.query_count, 2);
  const current = get("OBJ_CURRENT_GRANTS_REPLAY"); assert.equal(current.observations.length, 3); native(current.before.snapshot);
  for (const row of current.observations) { denied(row.httpDenial); errorObserved(row.nativeError); assert.notEqual(row.snapshot.loop.state, "completed"); samePrivate(current.before.snapshot, row.snapshot); }
  assert.ok(current.observations[0].currentGrants.grants.every((row: any) => row.capability !== "query:company_revenue"));
  assert.notDeepEqual(current.observations[1].currentGrants.assignments[0].resource_scope, scoped.grants.assignments[0].resource_scope);
  assert.ok(current.observations[2].currentGrants.grants.some((row: any) => row.capability === "query:company_revenue" && row.effect === "deny"));
  nativeHttpMatches(current.restored, current.before.snapshot); native(current.after); samePrivate(current.before.snapshot, current.after);
  const conflict = get("OBJ_REQUEST_CONFLICT_NODE_PROVENANCE"); assert.equal(conflict.observations.length, 5);
  errorObserved(conflict.ownedFault);
  for (const row of conflict.observations) {
    errorObserved(row.error);
    const control = row.positiveControl; native(control.current); samePrivate(conflict.before, control.current);
    const original = conflict.before.privateRows[0].response, claim = control.claim;
    assert.deepEqual(control.result, original.query.result);
    const step = control.current.steps.find((item: any) => item.id === claim.stepId); assert.ok(step);
    assert.equal(step.completed_at, null); assert.equal(step.claim_owner, claim.leaseOwner);
    assert.equal(control.current.loop.lease_owner, claim.leaseOwner);
    assert.ok(Date.parse(step.claim_until) > Date.parse(control.checkedAt));
    assert.ok(Date.parse(control.current.loop.lease_until) > Date.parse(control.checkedAt));
    if (row.name === "different typed request") assert.notDeepEqual(row.request, original.query.request);
    else assert.deepEqual(row.request, original.query.request);
    if (row.name === "different key") assert.notEqual(row.executionKey, original.query.result.execution.executionKey);
    else assert.equal(row.executionKey, original.query.result.execution.executionKey);
    if (row.name === "different input") assert.notEqual(row.inputId, original.workInputId); else assert.equal(row.inputId, original.workInputId);
    if (row.name === "different principal") assert.notEqual(row.actor, original.objective.originalPrincipalId);
    else assert.equal(row.actor, original.objective.originalPrincipalId);
    if (row.name === "unbound node") assert.notEqual(row.claim.stepId, claim.stepId); else assert.equal(row.claim.stepId, claim.stepId);
    assert.equal(row.claim.leaseOwner, claim.leaseOwner);
  }
  native(conflict.before); native(conflict.after);
  samePrivate(conflict.before, conflict.after); assert.deepEqual(conflict.before.receipts, conflict.after.receipts);
  const budgets = get("OBJ_BUDGET_DEADLINE_NO_ACTIVATION"); assert.equal(budgets.observations.length, 4);
  const grantMigration = (await readBounded(fileURLToPath(new URL("../../packages/db/migrations/postz_w1_objective_budget_guard.sql", import.meta.url)))).toString("utf8");
  const grantBody = grantMigration.match(/AS \$\$([\s\S]*?)\$\$;/)?.[1]; assert.ok(grantBody);
  assert.equal(budgets.installedGrantGuard.length, 1);
  const grantGuard = budgets.installedGrantGuard[0]; assert.equal(grantGuard.body, grantBody);
  assert.equal(grantGuard.security_definer, false); assert.equal(grantGuard.enabled, "O");
  assert.deepEqual(grantGuard.configuration, ["search_path=pg_catalog, finnor_os"]);
  assert.deepEqual(budgets.elevatedGrantDenials.map((row: any) => [row.field, row.limit]),
    [["max_steps", 97], ["max_actions", 26], ["max_queries", 51]]);
  for (const row of budgets.elevatedGrantDenials) {
    assert.equal(row.denial.code, "P0001"); assert.match(row.denial.message, /Larger finite grant requires the original accepted closing Work/);
    assert.deepEqual(row.after.loop, row.before.loop); assert.ok(row.before.loop[row.field] < row.limit);
    assert.equal(row.before.receipts.length, 0); assert.equal(row.after.receipts.length, 0);
    assert.equal(row.before.privateRows.length, 0); assert.equal(row.after.privateRows.length, 0);
  }
  for (const row of budgets.observations) {
    assert.notEqual(row.outcome, "completed"); assert.equal(row.after.receipts.length, 0); assert.equal(row.after.privateRows.length, 0);
    assert.equal(row.after.loop.acceptance_text, row.before.loop.acceptance_text);
  }
  native(budgets.concurrent); assert.equal(budgets.concurrent.receipts.length, 1); assert.equal(budgets.concurrent.loop.query_count, 1);
  assert.equal(budgets.concurrent.loop.state, "completed"); assert.equal(budgets.deliveries.length, 2);
  assert.deepEqual(budgets.completionFences.map((row: any) => row.mode).sort(), ["deadline", "deadline_seal", "input"]);
  for (const row of budgets.completionFences) {
    native(row.before.snapshot); samePrivate(row.before.snapshot, row.after); assert.deepEqual(row.after.receipts, row.before.snapshot.receipts);
    assert.equal(row.blockedRead.usename, "finnor_app"); assert.equal(row.blockedRead.wait_event_type, "Lock");
    assert.match(row.blockedRead.query, /^\s*select\b/i); noFacts(row.blockedRead);
    assert.ok(row.blockedRead.blockers.includes(row.pauseOwnerPid));
    assert.notEqual(row.blockedRead.observer_pid, row.pauseOwnerPid); assert.notEqual(row.blockedRead.observer_pid, row.blockedRead.pid);
    if (row.mode === "deadline_seal") {
      assert.match(row.blockedRead.query, /^\s*SELECT id FROM .*work_plan_revisions.*FOR NO KEY UPDATE\s*$/i);
      assert.equal(row.intakeWait.usename, "finnor_app"); assert.equal(row.intakeWait.wait_event_type, "Lock");
      assert.ok(row.intakeWait.blockers.includes(row.blockedRead.pid));
      assert.equal(row.intakeWait.observer_pid, row.blockedRead.observer_pid);
      materialWait(row.intakeLocks, row.blockedRead.pid, row.intakeWait.pid);
      assert.equal(row.intakeCursorRows.length, 1); assert.equal(row.intakeCursorRows[0].tenant_id, row.before.snapshot.loop.tenant_id);
      assert.equal(row.intakeResult.error, undefined); assert.equal(row.intakeResult.received.created, true);
      assert.equal(row.intakeResult.received.duplicate, false); assert.equal(row.independentIntakeRows.length, 1);
      const original = row.independentIntakeRows[0], received = row.intakeResult.received;
      assert.equal(original.id, received.workId); assert.notEqual(original.id, row.before.snapshot.work.id);
      assert.equal(original.input_id, received.workInputId); assert.equal(original.instruction_id, received.instructionId);
      assert.equal(original.created_by, row.before.snapshot.loop.created_by); assert.equal(original.input_created_by, original.created_by);
      assert.equal(original.instruction_text, "An independent original-human intake waits for canonical material publication.");
      assert.equal(JSON.parse(original.input_row_text).instruction_text, original.instruction_text);
      assert.equal(JSON.parse(original.work_row_text).id, original.id);
      assert.equal(original.objective_count, 0); assert.equal(original.query_count, 0); assert.equal(original.planner_attempt_count, 0);
      noFacts({ intakeWait: row.intakeWait, locks: row.intakeLocks, original });
    } else assert.ok(row.blockedRead.query.includes("evidence_source_versions"));
    assert.equal(row.result.error, undefined); assert.equal(row.result.outcome, "continue");
    assert.equal(row.claimed.loop.lease_owner, row.claimed.steps.find((step: any) => !step.completed_at && step.claim_owner)?.claim_owner);
    assert.ok(Date.parse(row.claimUntil) > Date.parse(row.mutationAt));
    assert.equal(row.after.loop.state, "continue"); assert.notEqual(row.after.work.status, "completed");
    assert.equal(row.after.plans[0].status, "active"); assert.equal(row.after.plans[0].completion_proof, null);
    assert.equal(row.after.loop.acceptance_text, row.before.snapshot.loop.acceptance_text);
    assert.equal(row.after.loop.deadline_at, row.before.snapshot.loop.deadline_at);
    assert.equal(row.after.loop.query_count, row.before.snapshot.loop.query_count);
    assert.equal(row.after.loop.node_attempt_count, row.before.snapshot.loop.node_attempt_count);
    assert.ok(row.after.steps.some((step: any) => !step.completed_at));
    if (row.mode !== "input") {
      assert.ok(Date.parse(row.mutationAt) >= Date.parse(row.before.snapshot.loop.deadline_at));
      assert.equal(row.after.inputs.length, 1); assert.equal(row.newInput, undefined);
    } else {
      assert.equal(row.newInput.created, false); assert.equal(row.newInput.duplicate, false);
      assert.equal(row.newInput.workId, row.before.snapshot.work.id); assert.notEqual(row.newInput.workInputId, row.before.snapshot.inputs[0].id);
      assert.equal(row.after.inputs.at(-1).id, row.newInput.workInputId);
      assert.equal(row.after.inputs.at(-1).created_by, row.before.snapshot.inputs[0].created_by);
      assert.equal(digest(row.after.inputs.at(-1).row_text), row.after.inputs.at(-1).row_sha256);
    }
  }
  const unsupported = get("OBJ_UNSUPPORTED_GENERAL_OBJECTIVE"); assert.equal(unsupported.observations.length, 2);
  for (const row of unsupported.observations) {
    assert.equal(row.outcome, "blocked"); assert.equal(row.after.loop.state, "blocked"); assert.equal(row.after.work.status, "blocked");
    assert.equal(row.after.plans.length, 0); assert.equal(row.after.receipts.length, 0); assert.equal(row.after.privateRows.length, 0);
    assert.equal(row.before.loop.acceptance_text, row.after.loop.acceptance_text);
    assert.equal(row.beforeAcceptanceSha256, digest(row.before.loop.acceptance_text)); assert.equal(row.afterAcceptanceSha256, row.beforeAcceptanceSha256);
  }
  const model = get("OBJ_MODEL_CONTEXT_NO_FACTS"); positive(model.primer); assert.deepEqual(model.primerBefore, model.primerAfter);
  assert.ok(model.capture.opts.planningContext.queryExecutions.some((row: any) => row.id === model.primer.body.result.execution.id));
  noFacts(model.capture); noFacts(model.persisted); native(model.after);
  noFacts({ steps: model.after.steps, loop: model.after.loop, plans: model.after.plans, events: model.after.events, traces: model.after.traces, outcome: model.after.work.final_outcome });
  const shared = get("OBJ_SHARED_REDACTION"); noFacts(shared.shared); assert.equal(shared.responses.length, 6);
  shared.responses.forEach((row: any) => { assert.equal(row.response.status, 200); noFacts(row.response.body); });
  const complete = get("OBJ_COMPLETE_PRIVATE_VALIDATION");
  assert.deepEqual(complete.observations.map((row: any) => row.name).sort(),
    ["nested_request", "nested_outcome", "nested_execution", "nested_source", "nested_page", "nested_meta", "nested_timing", "native_origin", "native_node"].sort());
  for (const row of complete.observations) {
    native(row.original.snapshot); nativeHttpMatches(row.validHttp, row.original.snapshot); denied(row.httpDenial); errorObserved(row.nativeError);
    assert.equal(digest(row.corruptedResponseText), row.corruptedResponseSha256);
    assert.notEqual(row.corruptedResponseSha256, row.original.snapshot.privateRows[0].response_sha256);
    assert.notEqual(row.after.loop.state, "completed"); assert.equal(row.after.receipts.length, 1); assert.equal(row.after.receipts[0].status, "succeeded");
  }
  samePrivate(complete.originalBefore, complete.originalAfter); native(complete.originalAfter);
  const insertOnly = get("CANONICAL_HTTP_INSERT_ONLY"), principal = insertOnly.principal;
  assert.equal(principal.current_user, "finnor_app"); assert.equal(principal.rolsuper, false); assert.equal(principal.rolbypassrls, false);
  assert.equal(principal.can_select, true); assert.equal(principal.can_insert, true); assert.equal(principal.can_update, false); assert.equal(principal.can_delete, false);
  assert.equal(insertOnly.deniedUpdate.code, "42501"); positive(insertOnly.first); positive(insertOnly.duplicate);
  const originalQuery = ordinaryPrivate(insertOnly.original); assert.deepEqual(queryOf(insertOnly.first), originalQuery); assert.deepEqual(queryOf(insertOnly.duplicate), originalQuery);
  assert.ok(!insertOnly.duplicate.body.replayDegraded); assert.ok(!insertOnly.first.body.projectionWarnings?.some((row: any) => row.stage === "response"));
  const fault = insertOnly.ancillary; positive(fault.firstFault); positive(fault.replay); ordinaryPrivate(fault.committed);
  assert.equal(fault.faultKind, "REAL_BEFORE_INSERT_AFTER_ATOMIC_QUERY_COMMIT");
  assert.ok(fault.firstFault.body.projectionWarnings.some((row: any) => row.stage === "response")); assert.equal(fault.replay.body.replayDegraded, true);
  assert.deepEqual(queryOf(fault.replay), fault.committed.response.query); assert.equal(fault.diagnostics.length, 1); noFacts(fault.diagnostics);
  const timing = get("CANONICAL_HTTP_METADATA_STABILITY"); assert.equal(timing.observations.length, 3);
  for (const row of timing.observations) {
    const query = ordinaryPrivate(row.before); ordinaryPrivate(row.after); assert.equal(row.before.response_text, row.after.response_text);
    assert.equal(row.before.response_sha256, row.after.response_sha256); assert.deepEqual(queryOf(row.first), query); assert.deepEqual(queryOf(row.duplicate), query);
    assert.equal(row.first.status, 201); assert.equal(row.duplicate.status, 200); assert.equal(row.duplicate.body.duplicate, true);
    assert.equal(row.duplicate.headers["cache-control"], "no-store");
  }
  const rights = get("OBJ_SOURCE_RIGHTS_REPLAY"); native(rights.before.snapshot); assert.equal(rights.originalScope[0].enabled, true);
  assert.equal(rights.revokedScope[0].id, rights.originalScope[0].id); assert.equal(rights.revokedScope[0].enabled, false);
  denied(rights.scopeDenial); errorObserved(rights.scopeNativeError); nativeHttpMatches(rights.restored, rights.before.snapshot);
  sourceBytes(rights.shortSourceRows); denied(rights.changedDenial); errorObserved(rights.changedNativeError);
  native(rights.expiring.snapshot, rights.shortSourceRows); nativeHttpMatches(rights.originalHttp, rights.expiring.snapshot);
  assert.ok(Date.parse(rights.elapsedAt) >= Date.parse(rights.shortQuote.validUntil));
  denied(rights.elapsedHttp); errorObserved(rights.elapsedNativeError);
  samePrivate(rights.before.snapshot, rights.after); samePrivate(rights.expiring.snapshot, rights.expiryAfter);
  assert.notEqual(rights.after.loop.state, "completed"); assert.notEqual(rights.expiryAfter.loop.state, "completed");
  for (const row of sources.versions) assert.equal(rights.originalVersionsAfter.versions.find((item: any) => item.id === row.id).row_text, row.row_text);
}

try { await main(); } finally { clearTimeout(outerWatchdog); }

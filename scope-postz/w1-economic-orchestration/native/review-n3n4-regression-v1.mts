/** Registered before the N3/N4 repairs. Synthetic/isolated, not E2E.
 * N3: one completed EXECUTE_P1 + SQL VERIFY chain under one whole-treatment
 * reference must yield exactly one complete-chain observation (acceptance from
 * the original SQL acceptance, latency spanning both real stages, all actual
 * attempt costs); an execution still awaiting its check is not a failed
 * treatment; cancellation censors the chain. Stage-level observations are the
 * separate recordNativeStagesTx pipeline and are untouched here.
 * N4: an expired descriptive predecessor stays historical; a current context
 * starts a fresh validity-bounded lineage (previousRef null), while a
 * still-current predecessor keeps its append lineage without validity
 * extension, backdating, or silent reuse of expired samples. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { recordNativeObservationsTx } from "../../../finnor-os/packages/private-equity/src/economic-orchestration/learning";
import { sha } from "../../../finnor-os/packages/private-equity/src/evidence-execution/store";
import { parseResponseDataset, fitResponseState } from "../../../finnor-os/packages/epistemic-runtime/src/metalevel-policy/response";

const destination = process.argv[2] ?? "";
assert(isAbsolute(destination), "NEW_ABSOLUTE_REGRESSION_RECEIPT_REQUIRED");
const root = resolve(import.meta.dirname, "../../..");
const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const watched = [
  "finnor-os/packages/private-equity/src/economic-orchestration/learning.ts",
  "finnor-os/packages/epistemic-runtime/src/metalevel-policy/response.ts",
  "finnor-os/packages/private-equity/src/economic-orchestration/observations.ts",
  "finnor-os/packages/private-equity/src/economic-orchestration/gaps.ts",
  "finnor-os/packages/private-equity/src/economic-orchestration/contracts.ts",
  "finnor-os/packages/private-equity/src/compute-search/store.ts",
];
async function sources() {
  return Object.fromEntries(await Promise.all(watched.map(async path => [path, digest(await readFile(resolve(root, path)))])));
}
const before = await sources(), cases: any[] = [];
const startedAt = new Date().toISOString();
async function check(id: string, input: unknown, run: (observation: any) => unknown | Promise<unknown>) {
  const observation: any = {};
  try {
    await run(observation); cases.push({ id, status: "PASS", input, observed: observation });
  } catch (error) {
    cases.push({ id, status: "FAIL", input, observed: observation, error: String(error) });
  }
}

const TENANT = "tenant-n3n4", PRINCIPAL = "principal-n3n4", SEARCH = "search-n3n4", WORK = "work-n3n4";
const SOURCE_DIGEST = "a".repeat(64), INPUT_DIGEST = "b".repeat(64);
const UNIT_E = "11111111-1111-4111-8111-111111111111";
const UNIT_V = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_E = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_V = "44444444-4444-4444-8444-444444444444";
const MODULE = "module-A";
const TREATMENT = "p1-joint-treatment:n3n4-whole-chain";
const PINS = { sourceRef: "p4-source:" + SOURCE_DIGEST, modelRef: "P1_REGISTERED_EXACT_NATIVE_NO_MODEL",
  providerRef: "P1_LOCAL_NATIVE_REGISTERED_IR", methodRef: "p1-method-set:n3n4",
  priceRef: "s4-native-price:n3n4", checkerRef: "p1-original-numeric-checker:n3n4", runtimeRef: "p1-p2-runtime:n3n4" };
const FEATURES = { structureRef: "p1-dependency-shape:n3n4", outcomeClassRef: "p1-original-numeric-acceptance:n3n4", domainRef: "domain-n3n4" };
const PURPOSE = "purpose-n3n4", POPULATION = "population-n3n4";
const T0 = Date.parse("2026-10-29T10:00:00.000Z");
const FUTURE = new Date(Date.now() + 3600_000).toISOString();
const ctx = { auth: { tenantId: TENANT, userId: PRINCIPAL, employeeId: PRINCIPAL, role: "OWNER" } } as any;

const meter = (start: number, end: number, cpuMs: number, peakMemoryBytes: number) => ({
  schema: "finnor.w1.native-meter.v1", elapsedMs: end - start,
  startedAt: new Date(start).toISOString(), endedAt: new Date(end).toISOString(),
  cpuMs, peakMemoryBytes,
  scope: "ROOT_PROCESS_INTERVAL_NONADDITIVE_CHILDREN_UNMETERED",
  peakMemoryScope: "ROOT_PROCESS_LIFETIME_MAX_RSS_NOT_INTERVAL_PEAK",
  humanSeconds: 0, costUSD: null, costStatus: "UNKNOWN", childCpuMs: null, childPeakMemoryBytes: null,
});
function attempt(id: string, unitId: string, start: number, end: number, cpuMs: number, peak: number, groupRef: string) {
  const body = { w1Meter: meter(start, end, cpuMs, peak), w1SelectionGroupRef: groupRef,
    steps: 5, chargedNativeAttempts: 1, originalEpisode: "episode-n3n4",
    submittedAt: new Date(start).toISOString(), completedAt: end };
  return { id, unit_id: unitId, status: "COMPLETED", body, digest: sha(body), created_at: new Date(end).toISOString() };
}
function unit(id: string, kind: "EXECUTE_P1" | "VERIFY_P1", status: string, result: unknown = null) {
  const body = { moduleId: MODULE, prerequisites: kind === "VERIFY_P1" ? [UNIT_E] : [],
    sourceDigest: SOURCE_DIGEST, inputDigest: INPUT_DIGEST };
  const row: any = { id, tenant_id: TENANT, principal_id: PRINCIPAL, search_id: SEARCH, generation: 1, kind, status, body, digest: sha(body) };
  if (result) { row.result = result; row.result_digest = sha(result); }
  return row;
}
const verifyResult = { moduleId: MODULE, values: { K: { value: "42" } },
  checks: [{ id: "numeric:K", method: "POSTGRES_NUMERIC_ACCEPTED_EXPRESSION", status: "PASS", expected: "42", actual: "42" }] };
function selectionEvent(unitIds: string[], groupRef: string, validUntil: string, createdAt: string) {
  const body = { workId: WORK, treatmentRef: TREATMENT, treatmentUnitIds: unitIds, selectionGroupRef: groupRef,
    responseContext: { pins: PINS, features: FEATURES, purposeRef: PURPOSE, populationRef: POPULATION, validUntil } };
  return { kind: "W1_NEXT_COMPUTATION_APPLIED", body, digest: sha(body), created_at: createdAt };
}
const search: any = { tenant_id: TENANT, principal_id: PRINCIPAL, id: SEARCH, generation: 1, status: "RUNNING",
  request: { orchestration: { schema: "finnor.economic-orchestration-options.v1", purposeRef: PURPOSE, populationRef: POPULATION, domainRef: "domain-n3n4" } },
  context: { sourceResultDigest: SOURCE_DIGEST, inputDigest: INPUT_DIGEST, program: { acceptance: { targets: [{ key: "K" }] } } },
  binding: { resourceId: "resource-n3n4" } };

interface Fixture { units: any[]; events: any[]; attempts: any[]; priorStates?: any[]; existingObservations?: "all" | string[]; }
class FakeClient {
  observations: any[] = []; states: any[] = []; gaps: any[] = []; statements: string[] = [];
  constructor(private fixture: Fixture) {}
  async query(statement: string, params: any[] = []): Promise<any> {
    this.statements.push(statement);
    if (statement.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 0 };
    if (statement.includes("hashtextextended(context_key,0)")) return { rows: [{ lock_id: "2" }, { lock_id: "1" }], rowCount: 2 };
    if (statement.startsWith("SELECT * FROM finnor_os.p2_units")) return { rows: this.fixture.units, rowCount: this.fixture.units.length };
    if (statement.startsWith("SELECT") && statement.includes("FROM finnor_os.p2_events")) return { rows: this.fixture.events, rowCount: this.fixture.events.length };
    if (statement.includes("FROM finnor_os.p2_attempts") && statement.includes("unit_id=ANY")) {
      const ids = params[3] as string[], group = params[4] as string | null | undefined;
      const rows = this.fixture.attempts.filter(row => ids.includes(row.unit_id) && (group == null || row.body.w1SelectionGroupRef === group));
      return { rows, rowCount: rows.length };
    }
    if (statement.includes("FROM finnor_os.p2_attempts")) return { rows: this.fixture.attempts, rowCount: this.fixture.attempts.length };
    if (statement.includes("FROM finnor_os.w1_native_observations")) {
      const id = params[2] as string, existing = this.fixture.existingObservations;
      const found = existing === "all" || (Array.isArray(existing) && existing.includes(id)) || this.observations.some(row => row.id === id);
      return { rows: found ? [{ id }] : [], rowCount: found ? 1 : 0 };
    }
    if (statement.includes("FROM finnor_os.w1_response_states") && statement.includes("FOR SHARE")) {
      const rows = [...(this.fixture.priorStates ?? []), ...this.states];
      return { rows: rows.slice(-1), rowCount: rows.length ? 1 : 0 };
    }
    if (statement.includes("count(*)") && statement.includes("FROM finnor_os.w1_measurement_gaps"))
      return { rows: [{ n: String(this.gaps.length) }], rowCount: 1 };
    if (statement.includes("FROM finnor_os.w1_measurement_gaps")) return { rows: [], rowCount: 0 };
    if (statement.startsWith("INSERT INTO finnor_os.w1_measurement_gaps")) {
      const body = JSON.parse(params[4]);
      if (!this.gaps.some(row => row.id === body.id)) this.gaps.push(body);
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("INSERT INTO finnor_os.w1_native_observations")) { this.observations.push(JSON.parse(params[4])); return { rows: [], rowCount: 1 }; }
    if (statement.startsWith("INSERT INTO finnor_os.w1_response_states")) {
      this.states.push({ digest: params[2], dataset_digest: params[3], body: JSON.parse(params[4]), dataset: JSON.parse(params[5]) });
      return { rows: [], rowCount: 1 };
    }
    if (statement.startsWith("INSERT INTO finnor_os.p2_events")) return { rows: [], rowCount: 1 };
    throw Error("UNROUTED_SQL " + statement);
  }
}
async function reconcile(fixture: Fixture) {
  const client = new FakeClient(fixture);
  await recordNativeObservationsTx(ctx, search, client as any);
  return client;
}
const completeChain: Fixture = {
  units: [unit(UNIT_E, "EXECUTE_P1", "COMPLETED"), unit(UNIT_V, "VERIFY_P1", "COMPLETED", verifyResult)],
  events: [selectionEvent([UNIT_E], "group-execute", FUTURE, "2026-10-29T10:00:05.000Z"),
    selectionEvent([UNIT_V], "group-verify", FUTURE, "2026-10-29T10:00:30.000Z")],
  attempts: [attempt(ATTEMPT_E, UNIT_E, T0, T0 + 9975, 400, 1000, "group-execute"),
    attempt(ATTEMPT_V, UNIT_V, T0 + 9975, T0 + 18912, 300, 1500, "group-verify")],
};
function priorRevision(validUntil: string, knowledgeAt: string, observedAt: string) {
  const oldSample = { id: "p2-native-observation:prior", workId: WORK, unitId: "native-premise-unit:prior",
    split: "TRAIN", features: FEATURES, treatmentRef: TREATMENT, traceRef: "p2-native-treatment:prior",
    evidenceRefs: ["p2-attempt:prior"], premiseRefs: [PINS.sourceRef], assignmentRef: "p2-current-owner-selection:prior",
    assignmentProbability: "1", accepted: true, acceptanceRef: "p1-original-sql-acceptance:prior",
    censored: false, humanRescue: false, observedAt, latencyMs: 1000, cpuMs: 100, peakMemoryBytes: 1000,
    humanSeconds: 0, monetaryCost: { status: "UNKNOWN", reason: "NATIVE_BILLING_AND_CHILD_USAGE_UNRECONCILED" } };
  const dataset = parseResponseDataset({ schema: "finnor.orchestration-response-dataset.v1",
    datasetId: "native-response:n3n4-prior", tenantId: TENANT, principalId: PRINCIPAL, purposeRef: PURPOSE, populationRef: POPULATION,
    sourceClass: "CONTROLLED_NATIVE", protocol: { kind: "LOGGED_ASSOCIATION", ref: "logged-native-current-owner-assignment-v1", confidenceLevel: 0.95 },
    pins: PINS, knowledgeAt, validUntil, samples: [oldSample] });
  const state = fitResponseState(dataset, null);
  return { row: { body: state, dataset, digest: sha(state), dataset_digest: sha(dataset) }, ref: state.ref, validUntil };
}

await check("N3-complete-chain-yields-one-accepted-observation", { executeWallMs: 9975, verifyWallMs: 8937,
  contract: "one whole-treatment chain => one accepted complete-chain observation, not pooled false-execute/true-verify halves" }, async out => {
  const client = await reconcile(structuredClone(completeChain));
  Object.assign(out, { observationCount: client.observations.length, stateCount: client.states.length,
    observations: client.observations, states: client.states.map(row => row.body), gapKinds: client.gaps.map(gap => gap.kind) });
  assert.equal(client.observations.length, 1, "ONE_COMPLETE_CHAIN_OBSERVATION_NOT_STAGE_HALVES");
  assert.equal(client.states.length, 1, "ONE_RESPONSE_STATE_REVISION");
  const observation = client.observations[0];
  assert.equal(observation.accepted, true, "ORIGINAL_SQL_ACCEPTANCE_GOVERNS_THE_CHAIN");
  assert.equal(observation.censored, false);
  assert.equal(observation.treatmentRef, TREATMENT);
  assert.equal(observation.latencyMs, 18912, "LATENCY_COVERS_BOTH_REAL_STAGES");
  assert.equal(observation.cpuMs, 700, "ALL_ACTUAL_ATTEMPT_CPU_COST");
  assert.equal(observation.peakMemoryBytes, 1500);
  for (const ref of [ATTEMPT_E, ATTEMPT_V].map(id => "p2-attempt:" + id + ":"))
    assert(observation.evidenceRefs.some((entry: string) => entry.startsWith(ref)), "EVERY_PHYSICAL_ATTEMPT_IS_EVIDENCE " + ref);
  const estimate = client.states[0].body.estimates.find((entry: any) => entry.treatmentRef === TREATMENT);
  assert(estimate, "WHOLE_TREATMENT_ESTIMATE_REQUIRED");
  assert.equal(estimate.acceptanceMean, "1", "NEVER_POOL_FALSE_EXECUTE_TRUE_VERIFY_AS_ONE_HALF");
  assert.equal(estimate.latencyMeanMs, "18912");
  assert.equal(estimate.cpuMeanMs, "700");
});

await check("N3-execution-awaiting-check-is-not-a-failed-treatment", { verifyStatus: "RUNNING",
  contract: "no whole-treatment observation until the SQL check reaches a terminal durable state" }, async out => {
  const client = await reconcile({
    units: [unit(UNIT_E, "EXECUTE_P1", "COMPLETED"), unit(UNIT_V, "VERIFY_P1", "RUNNING")],
    events: [selectionEvent([UNIT_E], "group-execute", FUTURE, "2026-10-29T10:00:05.000Z")],
    attempts: [attempt(ATTEMPT_E, UNIT_E, T0, T0 + 9975, 400, 1000, "group-execute")],
  });
  Object.assign(out, { observationCount: client.observations.length, stateCount: client.states.length,
    observations: client.observations });
  assert.equal(client.observations.length, 0, "EXECUTION_AWAITING_SQL_CHECK_MUST_NOT_RECORD_A_FAILED_TREATMENT");
  assert.equal(client.states.length, 0);
});

await check("N3-cancelled-sql-check-censors-the-chain", { verifyStatus: "CANCELLED",
  contract: "the chain observation stays accepted=false and censored=true; censoring is never lost" }, async out => {
  const client = await reconcile({
    units: [unit(UNIT_E, "EXECUTE_P1", "COMPLETED"), unit(UNIT_V, "VERIFY_P1", "CANCELLED")],
    events: [selectionEvent([UNIT_E], "group-execute", FUTURE, "2026-10-29T10:00:05.000Z"),
      selectionEvent([UNIT_V], "group-verify", FUTURE, "2026-10-29T10:00:30.000Z")],
    attempts: [attempt(ATTEMPT_E, UNIT_E, T0, T0 + 9975, 400, 1000, "group-execute")],
  });
  Object.assign(out, { observationCount: client.observations.length, observations: client.observations });
  assert.equal(client.observations.length, 1, "ONE_CHAIN_OBSERVATION");
  assert.equal(client.observations[0].accepted, false);
  assert.equal(client.observations[0].censored, true, "CANCELLED_SQL_CHECK_MUST_CENSOR_THE_CHAIN");
  assert.equal(client.observations[0].latencyMs, 9975, "ONLY_ACTUAL_PHYSICAL_ATTEMPT_TIME");
});

await check("N3-single-event-whole-chain-control", { control: "PASS_ON_BOTH_EPOCHS",
  contract: "a single dispatch covering the complete chain keeps its accepted observation" }, async out => {
  const client = await reconcile({
    units: completeChain.units, events: [selectionEvent([UNIT_E, UNIT_V], "group-joint", FUTURE, "2026-10-29T10:00:05.000Z")],
    attempts: [attempt(ATTEMPT_E, UNIT_E, T0, T0 + 9975, 400, 1000, "group-joint"),
      attempt(ATTEMPT_V, UNIT_V, T0 + 9975, T0 + 18912, 300, 1500, "group-joint")],
  });
  Object.assign(out, { observationCount: client.observations.length, observations: client.observations });
  assert.equal(client.observations.length, 1);
  assert.equal(client.observations[0].accepted, true);
  assert.equal(client.observations[0].latencyMs, 18912);
});

await check("N3-idempotent-reconcile-control", { control: "PASS_ON_BOTH_EPOCHS",
  contract: "an already-recorded observation identity is never rewritten or duplicated" }, async out => {
  const client = await reconcile({ ...structuredClone(completeChain), existingObservations: "all" });
  Object.assign(out, { observationCount: client.observations.length, stateCount: client.states.length });
  assert.equal(client.observations.length, 0, "NO_DUPLICATE_OR_REWRITTEN_OBSERVATION");
  assert.equal(client.states.length, 0, "NO_STATE_ADVANCE_WITHOUT_A_NEW_SAMPLE");
});

await check("N4-expired-predecessor-starts-fresh-validity-bounded-lineage", { priorValidUntil: "2026-10-29T12:00:00.000Z",
  contract: "expired revision stays historical; fresh lineage previousRef=null bounded by the current context; no knowledge append beyond expiry" }, async out => {
  const prior = priorRevision("2026-10-29T12:00:00.000Z", "2026-10-29T12:00:00.000Z", "2026-10-29T11:59:00.000Z");
  const client = await reconcile({ ...structuredClone(completeChain), priorStates: [prior.row] });
  Object.assign(out, { observationCount: client.observations.length, stateCount: client.states.length,
    states: client.states, gapKinds: client.gaps.map(gap => gap.kind),
    updates: client.statements.filter(statement => statement.startsWith("UPDATE")) });
  assert.equal(client.observations.length, 1, "EXPIRED_REVISION_MUST_NOT_BLOCK_THE_CURRENT_OBSERVATION");
  assert.equal(client.states.length, 1, "ONE_NEW_STATE_REVISION");
  const state = client.states[0];
  assert.equal(state.body.previousRef, null, "FRESH_LINEAGE_NEVER_LINKS_THE_EXPIRED_REVISION");
  assert.equal(state.body.validUntil, FUTURE, "NEW_CONTEXT_VALIDITY_GOVERNS");
  assert.equal(state.dataset.samples.length, 1, "NO_SILENT_REUSE_OF_EXPIRED_SAMPLES");
  assert(!client.gaps.some(gap => gap.kind === "DESCRIPTIVE_RESPONSE_FIT_OR_RETENTION_UNPASSED"),
    "EXPIRED_PREDECESSOR_IS_NOT_A_FIT_FAILURE");
  assert.equal(out.updates.length, 0, "PINNED_EXPIRED_REVISION_REMAINS_HISTORICAL_UNTOUCHED");
});

await check("N4-current-predecessor-append-lineage-preserved", { control: "dual-root N3+N4",
  contract: "a still-current predecessor chains via previousRef without extending its validity" }, async out => {
  const knowledgeAt = new Date(Date.now() - 1800_000).toISOString();
  const validUntil = new Date(Date.now() + 7200_000).toISOString();
  const prior = priorRevision(validUntil, knowledgeAt, knowledgeAt);
  const client = await reconcile({ ...structuredClone(completeChain), priorStates: [prior.row] });
  Object.assign(out, { observationCount: client.observations.length, stateCount: client.states.length, states: client.states,
    updates: client.statements.filter(statement => statement.startsWith("UPDATE")) });
  assert.equal(client.observations.length, 1, "ONE_CHAIN_OBSERVATION");
  assert.equal(client.states.length, 1, "ONE_APPENDED_REVISION");
  assert.equal(client.states[0].body.previousRef, prior.ref, "STILL_CURRENT_LINEAGE_MUST_CHAIN");
  assert.equal(client.states[0].body.validUntil, validUntil, "APPEND_NEVER_EXTENDS_OLD_VALIDITY");
  assert.equal(client.states[0].dataset.samples.length, 2, "APPEND_TO_THE_CURRENT_LINEAGE");
  assert.equal(out.updates.length, 0, "HISTORICAL_REVISIONS_UNTOUCHED");
});

const after = await sources(), unchanged = JSON.stringify(before) === JSON.stringify(after);
const report = { schema: "finnor.w1.review-approved-isolated-regressions.v1", startedAt, completedAt: new Date().toISOString(),
  qualification: "SYNTHETIC_AND_ISOLATED_BOUNDARY_FAILURE_FIRST_NOT_OWNING_E2E_OR_W001_W060_OR_ECONOMIC_PROOF",
  fixture: "SELF_CONTAINED_SYNTHETIC_UNITS_EVENTS_ATTEMPTS_METERS_DERIVED_FROM_N3_N4_CONTRACT_AND_NATIVE0014_9975_8937_VALUES",
  before, after, sourcesUnchanged: unchanged,
  actualPostgres: false, actualHttp: false, productProviderCalls: 0, billingUSD: null, cases,
  summary: { total: cases.length, pass: cases.filter(c => c.status === "PASS").length, fail: cases.filter(c => c.status === "FAIL").length } };
await writeFile(destination, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ ...report.summary, sourcesUnchanged: unchanged, receipt: destination }));
process.exitCode = unchanged && report.summary.fail === 0 ? 0 : 1;

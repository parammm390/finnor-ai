/** Owning W011: actual dependent chain versus the equipped native P1 path. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { receiveWork } from "@finnor/db";
import { prepareNativeOwnerFixture } from "./native-stories.mjs";
import { nativeHttpFixture } from "../p7/native-http-fixture.mjs";
import { driveNativeProgram } from "./native-drive.mjs";
import { closeInternalResources } from "./native-internal-support.mjs";

export async function nativeSequentialStory(e: any) {
  const foreign = randomUUID();
  const f = await prepareNativeOwnerFixture(e, { beforeFit: async owner => {
    await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
      [foreign, owner.tenant, foreign + "@sequential.example.test"]);
  } });
  // This original search limit is set before the first search is submitted.
  // It is never changed after physical admission or on a continuation.
  f.search.limits = { ...f.search.limits, maxParallel: 1 };
  const directory = join(e.evidence, "internal-sequential");
  await mkdir(directory, { recursive: true });
  const artifact = (name: string, value: unknown) =>
    writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  const http = await nativeHttpFixture(e.admin, f.f.tenant, f.f.principal, foreign);
  const options = { schema: "finnor.economic-orchestration-options.v1", purposeRef: "W011-original-dependent-chain",
    populationRef: "W011-same-original-source-acceptance-and-parent", domainRef: "P1_LIABILITY_ARITHMETIC",
    responseRef: null, observationSplit: "TRAIN" };
  const submit = async (programId: string) => {
    const response = await http.call("economic-orchestration-submit", {
      ...f.search, schema: "finnor.economic-orchestration-request.v1", programId,
      idempotencyKey: randomUUID(), orchestration: options,
    });
    assert.equal(response.status, 202, JSON.stringify(response));
    return response.body.searchId as string;
  };
  const parent = async (programId: string) => (await e.admin.query(
    "SELECT e.* FROM finnor_os.p1_episodes e JOIN finnor_os.p1_requests p ON p.episode_id=e.id WHERE p.id=$1",
    [programId])).rows[0];
  const counters = async (searchId?: string) => ({
    grant: (await e.admin.query("SELECT * FROM finnor_os.p2_grant_usage WHERE tenant_id=$1 ORDER BY principal_id,resource_id",
      [f.f.tenant])).rows,
    attempts: searchId ? (await e.admin.query(
      "SELECT * FROM finnor_os.p2_attempts WHERE search_id=$1 ORDER BY created_at,id", [searchId])).rows : [],
    events: searchId ? (await e.admin.query(
      "SELECT * FROM finnor_os.p2_events WHERE search_id=$1 ORDER BY created_at,id", [searchId])).rows : [],
  });
  const finish = async (programId: string) => {
    assert.equal(await driveNativeProgram(e.admin, e.queue, programId, performance.now()), "TESTED");
    const response = await http.call("program-read", { programId });
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(response.body.status, "TESTED");
    assert.equal(response.body.program.result.values.netEquity.value, "43");
    assert.equal(response.body.program.result.values.leverage.value, "3.5");
    return response.body;
  };
  const followUp = async (nativeReference: boolean) => {
    const input = await receiveWork({ tenantId: f.f.tenant, userId: f.f.principal, workId: f.p.workId,
      instruction: f.request.instruction, channel: "console", idempotencyKey: randomUUID() });
    const request = { ...f.request, workInputId: input.workInputId, idempotencyKey: randomUUID() };
    if (nativeReference) delete request.computeSearch;
    const response = await http.call("program-submit", request);
    assert.equal(response.status, 202, JSON.stringify(response));
    return { input, request, programme: response.body };
  };
  let report: any = { schema: "finnor.w1.strong-sequential-owning.v1", status: "FAIL", caseIds: ["W011"] };
  try {
    assert.equal(process.env.AUTH_DEV_BYPASS, "0");
    const warmSearch = await submit(f.p.programId), warm = await finish(f.p.programId);
    const before = await parent(f.p.programId);
    await artifact("warm-original-prefix.json", { warmSearch, warm, before, counters: await counters(warmSearch) });
    const onInput = await followUp(false), onSearch = await submit(onInput.programme.programId);
    const onBefore = await parent(onInput.programme.programId), on = await finish(onInput.programme.programId);
    const onAfter = await parent(onInput.programme.programId), onCounters = await counters(onSearch);
    const onUnits = (await e.admin.query("SELECT * FROM finnor_os.p2_units WHERE search_id=$1 ORDER BY created_at,id", [onSearch])).rows;
    const floorEvents = onCounters.events.filter((row: any) => row.kind === "W1_OBSERVED_SINGLE_PATH_FLOOR_RETAINED");
    assert(floorEvents.length, "Actual original controller must retain the measured native single-path floor");
    assert(floorEvents.some((row: any) => row.body.remainingNativeCalls === 2));
    assert(floorEvents.some((row: any) => row.body.remainingNativeCalls === 1),
      "Retain the same minimum path between execute and its independent check");
    assert.equal(onCounters.attempts.length, 2, "No extra paid CONTROL or alternative candidate may be spawned for this floor");
    assert(onCounters.attempts.every((row: any) => row.status === "COMPLETED"));
    assert.equal(onUnits.filter((row: any) => row.kind === "EXECUTE_P1" && row.attempts > 0).length, 1);
    assert.equal(onUnits.filter((row: any) => row.kind === "VERIFY_P1" && row.attempts > 0).length, 1);
    assert.equal(onUnits.filter((row: any) => row.kind === "CONTROL_W1").length, 0);
    assert(onUnits.filter((row: any) => row.status === "CANCELLED").every((row: any) => row.attempts === 0));
    const referenceInput = await followUp(true), referenceBefore = await parent(referenceInput.programme.programId);
    const reference = await finish(referenceInput.programme.programId), referenceAfter = await parent(referenceInput.programme.programId);
    const referenceSearches = (await e.admin.query("SELECT * FROM finnor_os.p2_requests WHERE program_id=$1",
      [referenceInput.programme.programId])).rows;
    assert.equal(referenceSearches.length, 0, "The reference must run the actual native P1 path, not a renamed P2 strategy");
    for (const observed of [onBefore, onAfter, referenceBefore, referenceAfter]) {
      assert.equal(observed.id, before.id); assert.equal(String(observed.deadline_at), String(before.deadline_at));
      for (const field of ["max_attempts", "max_steps", "max_candidates"]) assert.equal(observed[field], before[field]);
    }
    assert(onAfter.attempts_used > onBefore.attempts_used);
    assert(referenceAfter.attempts_used > referenceBefore.attempts_used);
    assert(referenceAfter.attempts_used <= before.max_attempts);
    assert(referenceAfter.steps_used <= before.max_steps);
    const numerical = (await e.admin.query("SELECT 120::numeric-70::numeric-7::numeric net_equity,70::numeric/20::numeric leverage")).rows[0];
    assert.equal(on.program.result.values.netEquity.value, numerical.net_equity);
    assert.equal(reference.program.result.values.netEquity.value, numerical.net_equity);
    const referenceEvents = (await e.admin.query("SELECT * FROM finnor_os.p1_events WHERE request_id=$1 ORDER BY created_at,id",
      [referenceInput.programme.programId])).rows;
    const measured = {
      on: { input: onInput, searchId: onSearch, on, before: onBefore, after: onAfter, units: onUnits, ...onCounters },
      nativeReference: { input: referenceInput, reference, before: referenceBefore, after: referenceAfter,
        events: referenceEvents, searches: referenceSearches, grantAfter: (await counters()).grant },
    };
    await artifact("all-observed-cost-and-topology-receipts.json", measured);
    report = {
      ...report, status: "PASS_LOCAL_STRONG_SEQUENTIAL", originalEpisode: before.id,
      originalDeadline: before.deadline_at, originalGrant: f.search.computeGrant, originalLimits: f.request.limits,
      actualW1PhysicalCalls: onCounters.attempts.length, actualW1ControlCalls: 0,
      actualW1NativeChains: 1, equippedReference: "ORIGINAL_P1_NATIVE_PATH_WITH_SAME_OWNER_BINDINGS_SOURCE_ACCEPTANCE_AND_EPISODE",
      onAccepted: true, nativeReferenceAccepted: true, independentlyObservedNumerical: numerical,
      floorEvents, completeCost: { status: "UNKNOWN", usd: null, completeDescendantUsage: null,
        retained: "all-observed-cost-and-topology-receipts.json",
        gaps: ["EXCLUSIVE_TRANSITIVE_CHILD_CPU", "MONETARY_BILLING", "SUPERVISORY_HUMAN_TIME", "MATCHED_POPULATION_VALUE"],
        missingCostIsZero: false },
      economicsQualified: false, comparisonOrder: ["WARM", "W1_SINGLE_PATH", "EQUIPPED_NATIVE_REFERENCE"],
      orderAndSingleTaskConfoundingRetained: true, noOriginalBudgetRenewal: true,
      qualification: "ACTUAL_NATIVE_SINGLE_PATH_RETENTION_NOT_DOMAIN_OR_ECONOMIC_SUPERIORITY",
    };
    await artifact("oracle-input.json", { original: { episode: before, grant: f.search.computeGrant,
      request: f.request, search: f.search }, measured, report });
    const oracle = spawnSync(process.env.FINNOR_TEST_PYTHON!, [
      join(e.repo, "finnor-os/scripts/postz-w1/native-internal-oracle.py"), "sequential",
      join(directory, "oracle-input.json"), join(directory, "independent-oracle.json"),
    ], { encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
    await artifact("oracle-process.json", { status: oracle.status, signal: oracle.signal, stdout: oracle.stdout, stderr: oracle.stderr });
    assert.equal(oracle.status, 0, oracle.stderr || oracle.stdout);
    report.independentOracle = join(directory, "independent-oracle.json");
    return { directory, report };
  } catch (error) {
    report.status = "FAIL"; report.failure = String(error); report.stack = (error as Error).stack; throw error;
  } finally {
    try { await closeInternalResources(report, [() => http.close()]); }
    finally { await artifact("results.json", report); }
  }
}

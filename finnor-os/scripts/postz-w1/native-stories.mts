/** E2E hook only. Uses the original disposable P2 bootstrap and real signed-bearer fixture. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { allocationRef } from "@finnor/epistemic-runtime";
import { receiveWork } from "@finnor/db";
import { prepared } from "../p2/stories.mjs";
import { nativeHttpFixture } from "../p7/native-http-fixture.mjs";
import { observeNativeRun } from "./native-observe.mjs";
import { driveNativeProgram } from "./native-drive.mjs";

export function prepareNativeOwnerFixture(e: any, setup: { beforeFit: (owner: any) => Promise<void> }) {
  return prepared(e, "ADAPTIVE", { deferSearch: true, beforeFit: setup.beforeFit, beforePolicy: async (owner: any) => {
    const { ref: ignored, ...mandate } = owner.mandate;
    mandate.utility = { ...mandate.utility, deliberation: {
      schema: "finnor.s4.finite-deliberation-terms.v1", scope: "PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS",
      lossWithoutQualifiedResult: 100, lossWithQualifiedResult: 0, nativeAttemptCost: 1, controllerMsCost: .001,
      delayMsCost: 0, unit: "USD", qualification: "SUPPLIED_MODEL_RELATIVE_UTILITY_NOT_BILLING_OR_FIELD_WEALTH",
    } };
    owner.mandate = { ...mandate, ref: allocationRef("BUSINESS_OWNER", "mandate", mandate, "economic-mandate-v1") };
  } });
}
async function p7TerminalCurrentness(e: any, http: Awaited<ReturnType<typeof nativeHttpFixture>>, searchId: string, destination: string) {
  const cut = async () => (await e.admin.query(
    `SELECT s.status,s.head_id,s.revision,s.generation,p.work_id,p.work_input_id,p.episode_id,p.status program_status,
      e.deadline_at,e.max_attempts,e.max_steps,e.max_candidates,e.attempts_used,e.steps_used,e.candidates_used,
      s.request->'computeGrant' compute_grant,
      (SELECT spent FROM finnor_os.p2_grant_usage g WHERE g.tenant_id=s.tenant_id AND g.principal_id=s.principal_id
        AND g.grant_digest=s.request->'computeGrant'->>'contentDigest' AND g.resource_id=s.binding->>'resourceId') grant_spent,
      (SELECT count(*)::int FROM finnor_os.p2_attempts a WHERE a.tenant_id=s.tenant_id AND a.principal_id=s.principal_id AND a.search_id=s.id) attempt_count,
      (SELECT count(*)::int FROM finnor_os.jobs j WHERE j.tenant_id=s.tenant_id AND j.payload->>'searchId'=s.id::text) job_count
     FROM finnor_os.p2_requests s JOIN finnor_os.p1_requests p
       ON p.tenant_id=s.tenant_id AND p.principal_id=s.principal_id AND p.id=s.program_id
     JOIN finnor_os.p1_episodes e ON e.tenant_id=p.tenant_id AND e.principal_id=p.principal_id AND e.id=p.episode_id
     WHERE s.id=$1`, [searchId])).rows[0];
  const before = await cut();
  assert.equal(before.status, "STOPPED");
  const capsules = (await e.admin.query("SELECT digest FROM finnor_os.w1_capsules WHERE search_id=$1 ORDER BY digest", [searchId])).rows.map((row: any) => row.digest);
  assert(capsules.length, "Actual physically published capsule required");
  const policy = (await e.admin.query("SELECT * FROM finnor_os.compute_resource_policies WHERE resource_key='native:p2'")).rows[0];
  assert(policy && Number(policy.capacity) >= 2, "Original disposable P2 capacity must permit the registered attenuation");
  const observed: Record<string, unknown> = { schema: "finnor.w1.native-P7-currentness.v1", status: "RUNNING",
    before, originalPhysicalPolicy: policy, capsuleDigests: capsules,
    qualification: "ACTUAL_RESOURCE_TERMINAL_SLICE_NOT_FULL_W007_OR_PROTECTED_ADMISSION" };
  try {
    const unchanged = await http.call("economic-orchestration-invalidate", { searchId });
    observed.unchanged = unchanged;
    assert.equal(unchanged.status, 200, JSON.stringify(unchanged));
    assert.deepEqual(unchanged.body.affected, [], "Unchanged original owners must not invalidate the capsule");
    assert.deepEqual(await cut(), before);
    observed.attenuatedPhysicalPolicy = (await e.admin.query(
      `UPDATE finnor_os.compute_resource_policies SET capacity=capacity-1,
       per_tenant_capacity=least(per_tenant_capacity,capacity-1),
       interactive_reserve=least(interactive_reserve,capacity-2)
       WHERE resource_key='native:p2' RETURNING *`)).rows[0];
    const changed = await http.call("economic-orchestration-invalidate", { searchId });
    observed.changed = changed;
    assert.equal(changed.status, 200, JSON.stringify(changed));
    assert.deepEqual([...changed.body.affected].sort(), [...capsules].sort());
    const invalidations = (await e.admin.query(
      "SELECT capsule_digest,dependency_key,body FROM finnor_os.w1_invalidations WHERE search_id=$1 ORDER BY capsule_digest,dependency_key", [searchId])).rows;
    observed.invalidations = invalidations;
    for (const digest of capsules)
      assert(invalidations.some((row: any) => row.capsule_digest === digest && row.dependency_key === "native-facet:RESOURCE"));
    const current = await http.call("economic-orchestration-read", { searchId });
    observed.current = current;
    assert.equal(current.status, 200, JSON.stringify(current));
    assert.equal(current.body.capsule, null);
    assert(capsules.includes(current.body.historicalCapsuleDigest));
    assert.equal(current.body.policyCurrentness, "INVALIDATED_OR_SUPERSEDED_BINDING");
    observed.after = await cut();
    assert.deepEqual(observed.after, before, "P7 cannot revive or renew terminal original custody, counters, head, grant or physical work");
    observed.status = "PASS_CONTROLLED_NATIVE";
  } catch (error) {
    observed.status = "FAIL"; observed.failure = String(error); observed.terminal = await cut();
    throw error;
  } finally {
    try {
      observed.restoredPhysicalPolicy = (await e.admin.query(
        "UPDATE finnor_os.compute_resource_policies SET capacity=$1,per_tenant_capacity=$2,interactive_reserve=$3 WHERE resource_key='native:p2' RETURNING *",
        [policy.capacity, policy.per_tenant_capacity, policy.interactive_reserve])).rows[0];
    } finally {
      await writeFile(join(destination, "p7-currentness.json"), JSON.stringify(observed, null, 2) + "\n");
    }
  }
  return observed;
}
export async function nativeOwnerStory(e: any, scoredDriver?: (cut: {
  fixture: any; http: Awaited<ReturnType<typeof nativeHttpFixture>>;
  programId: string; searchId: string; before: any; input: any;
}) => Promise<{ evidence: string; receipt: any }>) {
  const foreign = randomUUID();
  const f = await prepareNativeOwnerFixture(e, { beforeFit: async owner => {
    // Creating a user changes the canonical authority revision. Set up foreign
    // identities before the original S4/S5 owners pin their current rights.
    await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
      [foreign, owner.tenant, foreign + "@w1.example.test"]);
  } });
  const http = await nativeHttpFixture(e.admin, f.f.tenant, f.f.principal, foreign);
  const started = performance.now(), destination = join(e.evidence, "w1-scored-native");
  await mkdir(destination, { recursive: false });
  let sample: Promise<void> | null = null, samples = 0;
  const observer = setInterval(() => {
    if (sample || samples++ >= 600) return;
    sample = (async () => {
      const rows = (await e.admin.query(`SELECT pid,state,wait_event_type,wait_event,
        pg_blocking_pids(pid) blockers,extract(epoch FROM clock_timestamp()-query_start)::float8 elapsed_seconds,
        left(query,384) query FROM pg_stat_activity WHERE datname=current_database()
        AND pid<>pg_backend_pid() AND state<>'idle' ORDER BY pid`)).rows;
      await appendFile(join(destination, "database-waits.jsonl"), JSON.stringify({ at: new Date().toISOString(), rows }) + "\n");
    })().catch(async error => {
      await appendFile(join(destination, "database-waits.jsonl"), JSON.stringify({ observerFailure: String(error) }) + "\n");
    }).finally(() => { sample = null; });
  }, 500);
  const options = { schema: "finnor.economic-orchestration-options.v1", purposeRef: "controlled-native-original-P1".padEnd(1024, "p"),
    populationRef: "same-original-Work-source-and-acceptance".padEnd(1024, "u"), domainRef: "P1_LIABILITY_ARITHMETIC".padEnd(2048, "d"), responseRef: null, observationSplit: "TRAIN" };
  const finish = (programId: string) => driveNativeProgram(e.admin, e.queue, programId, performance.now());
  try {
    assert.equal(process.env.AUTH_DEV_BYPASS, "0");
    const anonymous = await http.call("economic-orchestration-projection", { root: f.f.root, workId: f.p.workId }, "anonymous");
    assert.equal(anonymous.status, 401);
    const request = { ...f.search, schema: "finnor.economic-orchestration-request.v1", orchestration: options };
    const boundary: unknown[] = [];
    for (const field of ["purposeRef", "populationRef", "domainRef"] as const) {
      const refused = await http.call("economic-orchestration-submit", { ...request,
        orchestration: { ...options, [field]: options[field] + "x" } });
      assert.equal(refused.status, 400, JSON.stringify(refused));
      assert.equal(Number((await e.admin.query("SELECT count(*) n FROM finnor_os.p2_requests WHERE program_id=$1", [f.p.programId])).rows[0].n), 0);
      boundary.push({ field, length: options[field].length + 1, status: refused.status, originalSearches: 0 });
    }
    await writeFile(join(destination, "authenticated-context-bounds.json"), JSON.stringify({ boundary,
      positiveLengths: { purposeRef: options.purposeRef.length, populationRef: options.populationRef.length, domainRef: options.domainRef.length } }, null, 2) + "\n");
    const warm = await http.call("economic-orchestration-submit", request);
    assert.equal(warm.status, 202, JSON.stringify(warm));
    assert.equal(await finish(f.p.programId), "TESTED");
    const before = (await e.admin.query("SELECT e.* FROM finnor_os.p1_episodes e JOIN finnor_os.p1_requests p ON p.episode_id=e.id WHERE p.id=$1", [f.p.programId])).rows[0];
    const warmResponses = (await e.admin.query("SELECT digest,body FROM finnor_os.w1_response_states WHERE tenant_id=$1 AND principal_id=$2", [f.f.tenant, f.f.principal])).rows;
    assert(warmResponses.length, "Warm prefix must produce measured original native observations, not supplied fitted answers");
    await writeFile(join(destination, "warm-prefix.json"), JSON.stringify({ warm, before, warmResponses,
      qualification: "TRAINING_PREFIX_NOT_INDEPENDENT_HELDOUT_OR_CAUSAL_GAIN" }, null, 2) + "\n");
    // A new programme needs a real fresh native input, not merely a new
    // idempotency key. Canonical intake retains the Work's original owners.
    const input = await receiveWork({ tenantId: f.f.tenant, userId: f.f.principal, workId: f.p.workId,
      instruction: f.request.instruction, channel: "console", idempotencyKey: randomUUID() });
    assert.equal(input.workId, f.p.workId); assert.notEqual(input.workInputId, f.request.workInputId);
    assert.equal(input.created, false); assert.equal(input.duplicate, false);
    await writeFile(join(destination, "follow-up-input.json"), JSON.stringify({ input,
      previousInputId: f.request.workInputId, instructionUnchanged: true, intakeOwner: "CANONICAL_RECEIVE_WORK",
      originalEpisode: before.id, originalDeadlineAt: before.deadline_at }, null, 2) + "\n");
    const next = await http.call("program-submit", { ...f.request, workInputId: input.workInputId, idempotencyKey: randomUUID() });
    assert.equal(next.status, 202, JSON.stringify(next));
    const scored = await http.call("economic-orchestration-submit", { ...request, programId: next.body.programId, idempotencyKey: randomUUID() });
    assert.equal(scored.status, 202, JSON.stringify(scored));
    // Owning interruption fixtures reuse the exact real warm/intake/auth path.
    // Await before finally closes the signed transport and captures terminal SQL.
    if (scoredDriver) return await scoredDriver({ fixture: f, http, programId: next.body.programId,
      searchId: scored.body.searchId, before, input });
    assert.equal(await finish(next.body.programId), "TESTED");
    const after = (await e.admin.query("SELECT e.* FROM finnor_os.p1_episodes e JOIN finnor_os.p1_requests p ON p.episode_id=e.id WHERE p.id=$1", [next.body.programId])).rows[0];
    assert.equal(after.id, before.id); assert.equal(String(after.deadline_at), String(before.deadline_at));
    assert.equal(after.max_attempts, before.max_attempts); assert.equal(after.max_steps, before.max_steps);
    assert(after.attempts_used > before.attempts_used && after.attempts_used <= after.max_attempts);
    const program = await http.call("program-read", { programId: next.body.programId });
    assert.equal(program.status, 200);
    const forbidden = await http.call("economic-orchestration-read", { searchId: scored.body.searchId }, "other");
    assert.equal(forbidden.status, 404);
    const outcome = await observeNativeRun(e.admin, { fixture: "P1_LIABILITY_ARITHMETIC", tenantId: f.f.tenant,
      principalId: f.f.principal, programId: next.body.programId }, scored.body.searchId, program.body.program,
      { bypass: false, anonymousStatus: anonymous.status, foreignStatus: forbidden.status }, destination);
    const p7Currentness = await p7TerminalCurrentness(e, http, scored.body.searchId, destination);
    const receipt = { schema: "finnor.w1.native-warm-scored.v1", status: "PASS_CONTROLLED_NATIVE",
      originalEpisode: after.id, before, after, sourceAndAcceptanceUnchanged: true, originalGrant: f.search.computeGrant,
      followUpInput: input, originalInputId: f.request.workInputId, perProgrammeObserverSeconds: 120,
      outcome, p7Currentness, transport: http.observed, setupAuth: "ORIGINAL_DISPOSABLE_P2_FIXTURE_HEADER_BYPASS",
      scoredAuth: "ACTUAL_SIGNED_BEARER_AUTH_DEV_BYPASS_0", intervalMs: performance.now() - started,
      mounted: "NOT_RUN", interruption: "NOT_RUN", coldRuntime: "NOT_RUN", economicGainQualified: false,
      independentProtectedCustody: false, protectedAdmission: false };
    await writeFile(join(destination, "native-story.json"), JSON.stringify(receipt, null, 2) + "\n");
    return { evidence: destination, receipt };
  } finally {
    clearInterval(observer); if (sample) await sample;
    try {
      const cuts: Record<string, unknown> = { transport: http.observed, worker: e.queue.identity };
      for (const table of ["p1_requests", "p1_episodes", "p1_events", "p2_requests", "p2_units", "p2_attempts",
        "p2_events", "jobs", "job_delivery_attempts", "authority_states"]) {
        cuts[table] = (await e.admin.query("SELECT * FROM finnor_os." + table + " WHERE tenant_id=$1", [f.f.tenant])).rows;
      }
      await writeFile(join(destination, "terminal-owner-cuts.json"), JSON.stringify(cuts, null, 2) + "\n");
    } finally { await http.close(); }
  }
}

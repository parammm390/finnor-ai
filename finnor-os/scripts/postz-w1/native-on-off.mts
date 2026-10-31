/** Actual native ablation; mechanism/cost diagnostic, not protected empirical usefulness. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { receiveWork } from "@finnor/db";
import { prepareNativeOwnerFixture } from "./native-stories.mjs";
import { nativeHttpFixture } from "../p7/native-http-fixture.mjs";
import { driveNativeProgram } from "./native-drive.mjs";
import { observeNativeRun } from "./native-observe.mjs";

export async function nativeOnOffStory(e: any) {
  const directory = join(e.evidence, "on-off");
  await mkdir(directory, { recursive: false });
  const arms: any[] = [];
  // Registered OFF then ON order; retain the order/host confounding limitation.
  for (const enabled of [false, true]) {
    const began = performance.now(), foreign = randomUUID(), arm = enabled ? "ON" : "OFF";
    const destination = join(directory, arm);
    await mkdir(destination, { recursive: false });
    const f = await prepareNativeOwnerFixture(e, { beforeFit: async owner => {
      await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
        [foreign, owner.tenant, foreign + "@w1-comparison.example.test"]);
    } });
    const http = await nativeHttpFixture(e.admin, f.f.tenant, f.f.principal, foreign);
    const options = { schema: "finnor.economic-orchestration-options.v1", purposeRef: "matched-original-P1",
      populationRef: "matched-public-native-arithmetic", domainRef: "P1_LIABILITY_ARITHMETIC",
      responseRef: null, observationSplit: "TRAIN" };
    const submitSearch = async (programId: string) => {
      const body = { ...f.search, programId, idempotencyKey: randomUUID(),
        ...(enabled ? { schema: "finnor.economic-orchestration-request.v1", orchestration: options } : {}) };
      const result = await http.call(enabled ? "economic-orchestration-submit" : "compute-search-submit", body);
      assert.equal(result.status, 202, JSON.stringify(result));
      return result;
    };
    const episode = async (programId: string) => (await e.admin.query(
      "SELECT e.* FROM finnor_os.p1_episodes e JOIN finnor_os.p1_requests p ON p.episode_id=e.id WHERE p.id=$1",
      [programId])).rows[0];
    try {
      assert.equal(process.env.AUTH_DEV_BYPASS, "0");
      const originalEpisode = await episode(f.p.programId);
      const warm = await submitSearch(f.p.programId);
      assert.equal(await driveNativeProgram(e.admin, e.queue, f.p.programId, performance.now()), "TESTED");
      const before = await episode(f.p.programId);
      const input = await receiveWork({ tenantId: f.f.tenant, userId: f.f.principal, workId: f.p.workId,
        instruction: f.request.instruction, channel: "console", idempotencyKey: randomUUID() });
      assert.equal(input.workId, f.p.workId);
      assert.notEqual(input.workInputId, f.request.workInputId);
      const next = await http.call("program-submit", { ...f.request,
        workInputId: input.workInputId, idempotencyKey: randomUUID() });
      assert.equal(next.status, 202, JSON.stringify(next));
      const scored = await submitSearch(next.body.programId);
      assert.equal(await driveNativeProgram(e.admin, e.queue, next.body.programId, performance.now()), "TESTED");
      const after = await episode(next.body.programId);
      const current = await http.call("program-read", { programId: next.body.programId });
      assert.equal(current.status, 200, JSON.stringify(current));
      const searchIds = [warm.body.searchId, scored.body.searchId];
      const attempts = (await e.admin.query(
        "SELECT id,search_id,unit_id,delivery_id,claim_fence,status,body,created_at FROM finnor_os.p2_attempts WHERE search_id=ANY($1::uuid[]) ORDER BY created_at,id",
        [searchIds])).rows;
      const units = (await e.admin.query(
        "SELECT id,search_id,kind,status,body,result,attempts FROM finnor_os.p2_units WHERE search_id=ANY($1::uuid[]) ORDER BY created_at,id",
        [searchIds])).rows;
      const events = (await e.admin.query(
        "SELECT search_id,kind,body FROM finnor_os.p2_events WHERE search_id=ANY($1::uuid[]) ORDER BY created_at,id",
        [searchIds])).rows;
      const capsules = (await e.admin.query(
        "SELECT search_id,digest,body FROM finnor_os.w1_capsules WHERE search_id=ANY($1::uuid[]) ORDER BY created_at,id",
        [searchIds])).rows;
      const grant = (await e.admin.query(
        "SELECT * FROM finnor_os.p2_grant_usage WHERE tenant_id=$1 AND principal_id=$2",
        [f.f.tenant, f.f.principal])).rows;
      const sqlOracle = (await e.admin.query(
        "SELECT 120::numeric-70::numeric-7::numeric AS equity,70::numeric/20::numeric AS leverage")).rows[0];
      if (enabled) {
        const foreignRead = await http.call("economic-orchestration-read", { searchId: scored.body.searchId }, "other");
        const anonymous = await http.call("economic-orchestration-projection", { root: f.f.root, workId: f.p.workId }, "anonymous");
        assert.equal(foreignRead.status, 404);
        assert.equal(anonymous.status, 401);
        await observeNativeRun(e.admin, { fixture: "P1_LIABILITY_ARITHMETIC",
          tenantId: f.f.tenant, principalId: f.f.principal, programId: next.body.programId },
          scored.body.searchId, current.body.program, { bypass: false, anonymousStatus: 401, foreignStatus: 404 }, destination);
      }
      const record = { arm, enabled, originalEpisode, before, after, originalRequest: f.request,
        originalGrant: f.search.computeGrant, originalPolicy: f.search.policyRequest,
        warm, scored, input, program: current.body, attempts, units, events, capsules, grant, sqlOracle,
        elapsedIncludingSetupWarmupAndCheckingMs: performance.now() - began,
        billingUSD: null, humanSeconds: null, completeDescendantUsage: null,
        paidRuntimeProviderCalls: 0, auth: "ACTUAL_SIGNED_BEARER_AUTH_DEV_BYPASS_0" };
      arms.push(record);
      await writeFile(join(destination, "observed.json"), JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    } finally { await http.close(); }
  }
  const original = { schema: "finnor.w1.actual-native-on-off.v1", arms,
    order: ["OFF", "ON"], originalValues: { EV: "120", debt: "70", liability: "7", EBITDA: "20" },
    limitations: ["One public arithmetic assignment per arm, warm and scored inputs in one original episode",
      "Order and wall-clock confounding are not controlled by independent randomization",
      "No empirical usefulness, whole-programme ablation, competitive multiplier or economic claim",
      "Unknown material dollars and complete descendant CPU/memory remain unknown"] };
  const path = join(directory, "observations.json");
  await writeFile(path, JSON.stringify(original, null, 2) + "\n", { flag: "wx" });
  const oracle = spawnSync(process.env.FINNOR_TEST_PYTHON ?? "python3",
    [join(import.meta.dirname, "on-off-oracle.py"), path, join(directory, "independent-oracle.json")],
    { encoding: "utf8", timeout: 10_000 });
  await writeFile(join(directory, "oracle-process.json"),
    JSON.stringify({ exitCode: oracle.status, stdout: oracle.stdout, stderr: oracle.stderr }, null, 2) + "\n", { flag: "wx" });
  assert.equal(oracle.status, 0, oracle.stderr + oracle.stdout);
  return { directory, status: "PASS_LOCAL_NATIVE_DIAGNOSTIC", independentOracle: "PASS", empiricalGainQualified: false };
}

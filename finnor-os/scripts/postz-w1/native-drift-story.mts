/** W014: revise the actual existing P3 capability owner, then let the original
 * queue reject the old selection and perform its next fallback/STOP. No grant,
 * episode, native method implementation or fitted outcome is fabricated. */
import { strict as assert } from "node:assert";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { nativeOwnerStory } from "./native-stories.mjs";
import { driveNativeProgram } from "./native-drive.mjs";
import { closeInternalResources, committedEventObserver, internalOwnerCut,
  registerInternalHandlers, waitInternalBackoff } from "./native-internal-support.mjs";

const PREFIX = "finnor.w1.native-capability.v1:";
const MODEL = "P1_REGISTERED_EXACT_NATIVE_NO_MODEL";
export async function nativeDriftStory(e: any) {
  const directory = join(e.evidence, "internal-drift");
  await mkdir(directory, { recursive: true });
  const artifact = (name: string, value: unknown) => writeFile(join(directory, name),
    JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  const originalPolicy = (await e.admin.query(
    "SELECT * FROM finnor_os.compute_resource_policies WHERE resource_key='native:p2'")).rows[0];
  assert(originalPolicy);
  const observer = await committedEventObserver(e);
  const cases: any[] = [];
  let report: any = { schema: "finnor.w1.actual-capability-drift.v1", status: "FAIL", caseIds: ["W014"],
    originalPolicy, observerCatalogue: observer.catalogue };
  try {
    for (const facet of ["PRICE", "MODEL", "LATENCY"] as const) {
      const destination = join(directory, facet.toLowerCase());
      await mkdir(destination, { recursive: false });
      const observed: any = { facet, status: "FAIL" };
      let watch: any, queue: any;
      try {
        await e.admin.query("UPDATE finnor_os.compute_resource_policies SET source=$1 WHERE resource_key='native:p2'",
          [originalPolicy.source]);
        // Each independent subject retains its own original warm/scored Work,
        // episode and real S4/S5 reservation, under the same frozen catalogue.
        const result = await nativeOwnerStory({ ...e, evidence: destination }, async cut => {
          const { fixture: f, http, programId, searchId } = cut;
          queue = await e.createQueue(); await registerInternalHandlers(queue);
          watch = await observer.arm(queue, { tenantId: f.f.tenant, searchId,
            kind: "W1_NEXT_COMPUTATION_APPLIED", unitKind: "EXECUTE_P1" });
          observed.pause = await watch.drive();
          observed.before = await internalOwnerCut(e, f.f.tenant);
          observed.searchId = searchId; observed.programId = programId; observed.originalGrant = f.search.computeGrant;
          observed.originalEpisode = cut.before.id;
          const currentAttempts = observed.before.p2_attempts.filter((row: any) => row.search_id === searchId);
          assert.equal(currentAttempts.length, 1, "Pause must precede any selected native physical admission");
          assert.equal(observed.before.p2_units.find((row: any) => row.id === currentAttempts[0].unit_id).kind, "CONTROL_W1");
          assert.equal(currentAttempts[0].status, "COMPLETED");
          const capsule = observed.before.w1_capsules.filter((row: any) => row.search_id === searchId);
          assert.equal(capsule.length, 1, "A physically checked old capability/response revision is required");
          observed.oldCapsuleDigest = capsule[0].digest;
          assert.equal(capsule[0].body.proposal.status, "CHECKED_POLICY");
          observed.oldResponseRef = capsule[0].body.proposal.responseRef;
          const receipt = observed.before.p2_attempts.find((row: any) => row.search_id !== searchId &&
            row.status === "COMPLETED" && Number.isFinite(row.body.w1Meter?.elapsedMs) && row.body.w1Meter.elapsedMs > 0 &&
            observed.before.p2_units.some((unit: any) => unit.id === row.unit_id && unit.kind === "EXECUTE_P1"));
          assert(receipt, "Actual completed original native latency receipt required");
          const capability = {
            schema: "finnor.w1.native-capability.v1", revision: randomUUID(), recordedAt: new Date().toISOString(),
            modelRef: facet === "MODEL" ? "P1_UNAVAILABLE_REGISTERED_MODEL_REVISION" : MODEL,
            nativeAttemptCostMultiplier: facet === "PRICE" ? "200" : "1",
            stageLatencyPlanningMs: facet === "LATENCY" ? Math.ceil(receipt.body.w1Meter.elapsedMs) : 0,
            latencyEvidence: facet === "LATENCY" ? [{ attemptId: receipt.id, digest: receipt.digest }] : [],
            qualification: "P3_OPERATOR_SUPPLIED_ATTENUATION_NOT_BILLING_FUNDING_OR_MODEL_ADMISSION",
          };
          const source = PREFIX + JSON.stringify(capability);
          observed.ownerRevision = { capability, source,
            sourceSha256: createHash("sha256").update(source).digest("hex"),
            configurationOwner: "EXISTING_OPERATOR_OWNED_P3_NATIVE_RESOURCE_POLICY",
            measuredLatencyReceipt: facet === "LATENCY" ? receipt : null,
            noNewModelExecutionOrBillingClaim: true };
          observed.revisedPolicy = (await e.admin.query(
            "UPDATE finnor_os.compute_resource_policies SET source=$1 WHERE resource_key='native:p2' RETURNING *",
            [source])).rows[0];
          observed.invalidation = await http.call("economic-orchestration-invalidate", { searchId });
          assert.equal(observed.invalidation.status, 200, JSON.stringify(observed.invalidation));
          assert(observed.invalidation.body.affected.includes(observed.oldCapsuleDigest));
          observed.revised = await internalOwnerCut(e, f.f.tenant);
          assert(observed.revised.w1_invalidations.some((row: any) =>
            row.capsule_digest === observed.oldCapsuleDigest && row.dependency_key === "native-facet:" + facet));
          assert.equal(observed.revised.p2_attempts.length, observed.before.p2_attempts.length);
          await watch.release(); watch = null;
          // A joint old selection can have two queued jobs. Settle each actual
          // delivery under its original backoff before claiming fresh STOP or
          // fallback; one pre-admission rejection is not the whole reselection.
          const oldEvents = new Set(observed.revised.p2_events.map((row: any) => row.id));
          const expires = Date.now() + 120000;
          observed.reselectionSteps = [];
          for (let decision = 0; decision < 32; decision++) {
            const ran = await queue.tick();
            observed.reselected = await internalOwnerCut(e, f.f.tenant);
            const fresh = observed.reselected.p2_events.filter((row: any) =>
              row.search_id === searchId && !oldEvents.has(row.id));
            observed.reselectionSteps.push({ decision, ran, observedAt: observed.reselected.observedAt,
              eventIds: fresh.map((row: any) => row.id) });
            if (fresh.some((row: any) => facet === "LATENCY" ? row.kind === "W1_NATIVE_FALLBACK_APPLIED" :
                row.kind === "W1_NATIVE_COMPUTATION_STOPPED" && row.body.stoppedDisposition === "INCOMPLETE")) break;
            assert(decision < 31 && Date.now() < expires, "Actual fresh native reselection must occur in the original finite observation window");
            if (!ran) await waitInternalBackoff(e, queue, expires);
          }
          assert(observed.reselected.p2_events.some((row: any) => row.search_id === searchId &&
            row.kind === "W1_PRE_ADMISSION_REPLANNED"));
          if (facet === "LATENCY") {
            observed.nativeTerminalStatus = await driveNativeProgram(e.admin, queue, programId, performance.now());
            observed.result = await http.call("program-read", { programId });
            observed.terminal = await internalOwnerCut(e, f.f.tenant);
            assert.equal(observed.nativeTerminalStatus, "TESTED");
            assert.equal(observed.result.status, 200, JSON.stringify(observed.result));
            assert.equal(observed.result.body.program.result.values.netEquity.value, "43");
            observed.expectedNext = "FRESH_NATIVE_FALLBACK_UNDER_REVISED_LATENCY_CONFIGURATION";
          } else {
            const stopped = observed.reselected.p2_events.filter((row: any) => row.search_id === searchId &&
              row.kind === "W1_NATIVE_COMPUTATION_STOPPED" && row.body.stoppedDisposition === "INCOMPLETE");
            assert(stopped.length, "Unavailable or dominated future work must select actual STOP/incomplete");
            observed.expectedNext = "STOP_INCOMPLETE_WITHOUT_FUTURE_NATIVE_OR_MODEL_INVOCATION";
            observed.result = await http.call("program-read", { programId });
            assert.notEqual(observed.result.body.status, "TESTED");
          }
          observed.current = await http.call("economic-orchestration-read", { searchId });
          assert.equal(observed.current.status, 200, JSON.stringify(observed.current));
          assert.equal(observed.current.body.capsule, null);
          observed.terminal = await internalOwnerCut(e, f.f.tenant);
          observed.status = "PASS";
          return { evidence: destination, receipt: observed };
        });
        assert.equal(result.receipt, observed);
      } catch (error) { observed.failure = String(error); observed.stack = (error as Error).stack; }
      finally {
        try { await closeInternalResources(observed, [() => watch?.release(), () => queue?.close(),
          () => e.admin.query("UPDATE finnor_os.compute_resource_policies SET source=$1 WHERE resource_key='native:p2'",
            [originalPolicy.source])]); }
        finally { cases.push(observed); await artifact(facet.toLowerCase() + ".json", observed); }
      }
    }
    await artifact("owner-observations.json", { schema: report.schema, cases,
      costStatus: "ACTUAL_NATIVE_DEBITS_AND_ORIGINAL_SUPPLIED_UTILITY_PROXY_NOT_MONETARY_BILLING",
      modelScope: "REGISTERED_EXACT_NATIVE_ONLY_UNAVAILABLE_MODEL_REFUSED_NO_MODEL_ACQUISITION",
      economicsQualified: false, protectedAdmission: false });
    const oracle = spawnSync(process.env.FINNOR_TEST_PYTHON!,
      [join(e.repo, "finnor-os/scripts/postz-w1/native-internal-oracle.py"), "drift",
        join(directory, "owner-observations.json"), join(directory, "independent-oracle.json")],
      { encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
    await artifact("oracle-process.json", { status: oracle.status, signal: oracle.signal, stdout: oracle.stdout, stderr: oracle.stderr });
    assert.equal(oracle.status, 0, oracle.stderr || oracle.stdout);
    report = { ...report, status: "PASS_LOCAL_ACTUAL_PRICE_MODEL_LATENCY_RESELECTION",
      cases: cases.map(({ facet, status }) => ({ facet, status })),
      independentOracle: join(directory, "independent-oracle.json"), billingUSD: null, economicsQualified: false };
    return { directory, report };
  } catch (error) { report.failure = String(error); throw error; }
  finally {
    try { await closeInternalResources(report, [() => observer.close(),
      () => e.admin.query("UPDATE finnor_os.compute_resource_policies SET source=$1 WHERE resource_key='native:p2'",
        [originalPolicy.source])]); }
    finally { await artifact("results.json", report); }
  }
}

/** Owning W007 at all six W1 boundaries. Revocation is actual canonical intake
 * of a superseding input, not a fabricated "invalidated" flag or helper call. */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { receiveWork } from "@finnor/db";
import { prepareNativeOwnerFixture } from "./native-stories.mjs";
import { nativeHttpFixture } from "../p7/native-http-fixture.mjs";
import { driveNativeProgram } from "./native-drive.mjs";
import { nativeSubmitGate } from "./native-submit-gate.mjs";
import { closeInternalResources, committedEventObserver, INTERNAL_OPTIONS, internalOwnerCut, registerInternalHandlers,
  siblingInternalProgramme, submitInternalSearch } from "./native-internal-support.mjs";

const boundaries = ["SUBMIT", "CLAIM", "USE", "CHECK", "PUBLISH", "DISPATCH"] as const;
const proposal = [{ op: "propose_model", key: "explicit-original-arithmetic-model",
  assumptions: ["Only the four originally recorded inputs are used."], units: ["USD", "multiple"],
  mechanism: "Net equity is EV minus debt minus liability; leverage is debt divided by EBITDA." }];
export async function nativeRevocationStory(e: any) {
  const directory = join(e.evidence, "internal-revocation");
  await mkdir(directory, { recursive: true });
  const artifact = (name: string, value: unknown) => writeFile(join(directory, name),
    JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  const observer = await committedEventObserver(e);
  let gate: Awaited<ReturnType<typeof nativeSubmitGate>>;
  try { gate = await nativeSubmitGate(e); } catch (error) { await observer.close(); throw error; }
  const cases: any[] = [];
  let report: any = { schema: "finnor.w1.six-boundary-revocation.v1", status: "FAIL", caseIds: ["W007"],
    originalBoundaries: boundaries, observerCatalogue: observer.catalogue, submitCatalogue: gate.catalogue };
  try {
    for (const boundary of boundaries) {
      let http: any, queue: any, watch: any, pendingSubmit: Promise<any> | null = null;
      const observed: any = { boundary, status: "FAIL" };
      try {
        const other = randomUUID();
        const f = await prepareNativeOwnerFixture(e, { beforeFit: async owner => {
          await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
            [other, owner.tenant, other + "@revocation.example.test"]);
        } });
        f.search.limits = { ...f.search.limits, maxParallel: 1 };
        http = await nativeHttpFixture(e.admin, f.f.tenant, f.f.principal, other);
        queue = await e.createQueue(); await registerInternalHandlers(queue);
        const target = boundary === "DISPATCH" ?
          await siblingInternalProgramme(http, f, undefined, proposal) :
          { work: { workId: f.p.workId, workInputId: f.request.workInputId }, request: f.request, program: f.p };
        observed.target = target; observed.before = await internalOwnerCut(e, f.f.tenant);
        let searchId: string | null = null;
        if (boundary === "SUBMIT") {
          await gate.hold(f.f.tenant);
          pendingSubmit = http.call("economic-orchestration-submit", {
            ...f.search, schema: "finnor.economic-orchestration-request.v1", programId: target.program.programId,
            idempotencyKey: randomUUID(), orchestration: INTERNAL_OPTIONS,
          });
          observed.blocked = await gate.observedBlocked();
        } else {
          searchId = await submitInternalSearch(http, f, target.program.programId);
          observed.searchId = searchId;
          const criterion = boundary === "CLAIM" ?
            { kind: "W1_NATIVE_FALLBACK_APPLIED", unitKind: "EXECUTE_P1" } :
            boundary === "USE" ? { kind: "PHYSICAL_ATTEMPT_SUBMITTED", unitKind: "EXECUTE_P1" } :
            boundary === "CHECK" ? { kind: "W1_BOUNDARY_CURRENTNESS_CHECKED", boundary: "USE", unitKind: "VERIFY_P1" } :
            boundary === "PUBLISH" ? { kind: "W1_BOUNDARY_CURRENTNESS_CHECKED", boundary: "CHECK", unitKind: "VERIFY_P1" } :
            { kind: "UNIT_COMPLETED", unitKind: "VERIFY_P1" };
          watch = await observer.arm(queue, { tenantId: f.f.tenant, searchId, ...criterion });
          observed.pause = await watch.drive();
          observed.preRevocation = await internalOwnerCut(e, f.f.tenant);
          const unitId = observed.pause.event.unitId;
          const laterBoundary = observed.preRevocation.p2_events.filter((event: any) =>
            event.search_id === searchId && event.kind === "W1_BOUNDARY_CURRENTNESS_CHECKED" &&
            event.body.boundary === boundary && (!unitId || event.body.unitId === unitId));
          assert.equal(laterBoundary.length, 0, "A late pause cannot count as revocation before the intended boundary");
          if (boundary === "CLAIM") assert.equal(observed.preRevocation.p2_attempts.length, 0);
          if (boundary === "USE") assert.equal(observed.preRevocation.p2_attempts[0].status, "SUBMITTED");
        }
        observed.revoked = await receiveWork({ tenantId: f.f.tenant, userId: f.f.principal,
          workId: target.work.workId, instruction: target.request.instruction,
          channel: "console", idempotencyKey: randomUUID() });
        assert.notEqual(observed.revoked.workInputId, target.work.workInputId);
        observed.revocationCut = await internalOwnerCut(e, f.f.tenant);
        if (boundary === "SUBMIT") {
          await gate.release();
          observed.refusedSubmit = await pendingSubmit; pendingSubmit = null;
          assert([400, 404, 409, 422].includes(observed.refusedSubmit.status), JSON.stringify(observed.refusedSubmit));
          assert.equal(observed.refusedSubmit.body.predicate, "EXACT_WORK_REVISION_CHANGED",
            "An unrelated preflight/schema refusal is not canonical Work-currentness evidence");
          const targetSearches = (await internalOwnerCut(e, f.f.tenant)).p2_requests.filter((row: any) =>
            row.program_id === target.program.programId);
          assert.equal(targetSearches.length, 0, "Superseded Work cannot receive canonical acceptance");
        } else {
          await watch.release(); watch = null;
          if (boundary === "CLAIM" || boundary === "DISPATCH") await queue.tick();
          observed.fencedRead = await http.call("economic-orchestration-read", { searchId });
          assert.equal(observed.fencedRead.status, 200, JSON.stringify(observed.fencedRead));
          assert.equal(observed.fencedRead.body.capsule, null);
          assert.equal(observed.fencedRead.body.currentness, "STALE");
          observed.programRead = await http.call("program-read", { programId: target.program.programId });
          assert.equal(observed.programRead.status, 200, JSON.stringify(observed.programRead));
          assert.equal(observed.programRead.body.program, null);
          assert.notEqual(observed.programRead.body.status, "TESTED");
          observed.fenced = await internalOwnerCut(e, f.f.tenant);
          assert(!observed.fenced.p1_events.some((event: any) =>
            event.request_id === target.program.programId && event.kind === "OWNER_OPERATION_ATTEMPT"));
          const cancelled = await http.call("economic-orchestration-cancel", { searchId });
          assert.equal(cancelled.status, 200, JSON.stringify(cancelled));
          observed.ownedCleanup = cancelled;
        }
        // A separately received Work keeps the same authentic, unchanged
        // original S4/S5 resources. No revoked programme is "recovered" by
        // resetting its grant, input, episode, counters or deadline.
        const unaffected = await siblingInternalProgramme(http, f, undefined,
          boundary === "DISPATCH" ? proposal : undefined);
        const response = await http.call("economic-orchestration-submit", {
          ...f.search, schema: "finnor.economic-orchestration-request.v1", programId: unaffected.program.programId,
          idempotencyKey: randomUUID(), orchestration: { ...INTERNAL_OPTIONS,
            purposeRef: "W007-unaffected-independent-" + boundary },
        });
        assert.equal(response.status, 202, JSON.stringify(response));
        assert.equal(await driveNativeProgram(e.admin, queue, unaffected.program.programId, performance.now()), "TESTED");
        observed.unaffected = { ...unaffected, searchId: response.body.searchId,
          read: await http.call("program-read", { programId: unaffected.program.programId }) };
        assert.equal(observed.unaffected.read.body.program.result.values.netEquity.value, "43");
        observed.terminal = await internalOwnerCut(e, f.f.tenant);
        if (boundary === "DISPATCH") {
          assert(observed.terminal.p2_events.some((event: any) => event.search_id === response.body.searchId &&
            event.kind === "W1_BOUNDARY_CURRENTNESS_CHECKED" && event.body.boundary === "DISPATCH"));
          assert(observed.terminal.p1_events.some((event: any) =>
            event.request_id === unaffected.program.programId && event.kind === "OWNER_OPERATION_ATTEMPT"));
        }
        observed.originalGrant = f.search.computeGrant; observed.status = "PASS";
      } catch (error) { observed.failure = String(error); observed.stack = (error as Error).stack; }
      finally {
        try { await closeInternalResources(observed, [
          () => gate.release(),
          async () => { if (pendingSubmit) observed.pendingSubmitTerminal = await pendingSubmit; },
          () => watch?.release(), () => queue?.close(), () => http?.close(),
        ]); }
        finally { cases.push(observed); await artifact(boundary.toLowerCase() + ".json", observed); }
      }
    }
    await artifact("owner-observations.json", { schema: report.schema, cases,
      dispatchScope: "ACTUAL_P1_TO_ORIGINAL_OWNER_INVOCATION_NO_S6_EGRESS_AUTHORITY",
      originalClocksAndPaidLiabilitiesRetained: true });
    const oracle = spawnSync(process.env.FINNOR_TEST_PYTHON!,
      [join(e.repo, "finnor-os/scripts/postz-w1/native-revocation-oracle.py"),
        join(directory, "owner-observations.json"), join(directory, "independent-oracle.json")],
      { encoding: "utf8", timeout: 30000, maxBuffer: 65536 });
    await artifact("oracle-process.json", { status: oracle.status, signal: oracle.signal, stdout: oracle.stdout, stderr: oracle.stderr });
    assert.equal(oracle.status, 0, oracle.stderr || oracle.stdout);
    assert.equal(cases.filter(row => row.status === "PASS").length, 6);
    report = { ...report, status: "PASS_LOCAL_SIX_ACTUAL_BOUNDARY_RACES", cases: cases.map(({ boundary, status }) => ({ boundary, status })),
      independentOracle: join(directory, "independent-oracle.json"), protectedS6OrFieldQualified: false };
    return { directory, report };
  } catch (error) { report.failure = String(error); throw error; }
  finally {
    try { await closeInternalResources(report, [() => gate.close(), () => observer.close()]); }
    finally { await artifact("results.json", report); }
  }
}

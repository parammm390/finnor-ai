import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { familySpecifications, freshRequest, money } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");
const evidence = process.argv[2];
if (!evidence || !isAbsolute(evidence)) throw Error("ABSOLUTE_NEW_EVIDENCE_DIRECTORY_REQUIRED");
await mkdir(evidence, { recursive: false, mode: 0o700 });
const sha = (s) => createHash("sha256").update(s).digest("hex");
const codeFiles = [
  "finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work/contracts.ts",
  "finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work/relational.ts",
  "finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work/engine.ts",
  "finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work/original_checker.py",
  "finnor-os/packages/epistemic-runtime/src/project-z/z1-shared-work/producer-child.ts",
  "finnor-os/packages/private-equity/src/project-z/z1-shared-work/processes.ts",
  "finnor-os/packages/private-equity/src/project-z/z1-shared-work/owner.ts",
  "finnor-os/packages/orchestration/src/project-z/z1-shared-work/worker.ts",
  "finnor-os/package-lock.json",
  "finnor-os/scripts/project-z/z1/fixtures.mjs",
  "finnor-os/scripts/project-z/z1/verify.mjs",
  "finnor-os/scripts/project-z/z1/edge-cases.mjs",
  "finnor-os/scripts/project-z/z1/physical-recovery.mjs",
  "finnor-os/scripts/project-z/z1/reconstruct.py",
  "finnor-os/scripts/project-z/z1/check-syntax.mjs",
  "finnor-os/scripts/project-z/z1/typecheck.json",
];
const inventory = await Promise.all(codeFiles.map(async (path) => {
  try { const bytes = await readFile(resolve(root, path)); return { path, bytes: bytes.length, sha256: sha(bytes) }; }
  catch (e) { if (e.code === "ENOENT") return { path, missing: true }; throw e; }
}));
await writeFile(resolve(evidence, "source-inventory.json"), JSON.stringify(inventory, null, 2) + "\n", { flag: "wx" });
let engine;
try {
  engine = await import(new URL("../../../packages/epistemic-runtime/src/project-z/z1-shared-work/engine.ts", import.meta.url));
} catch (e) {
  await writeFile(resolve(evidence, "report.json"), JSON.stringify({
    scope: "Public original-semantics engine E2E, not native owner proof",
    status: "FAILED", reason: "ENGINE_ENTRY_UNAVAILABLE", detail: String(e.message),
    passed: 0, failed: 1, notRun: 256, inventory,
  }, null, 2) + "\n", { flag: "wx" });
  process.exitCode = 1;
}
const oracle = resolve(root, codeFiles[3]);
const canonical = (value) => value === null || typeof value !== "object" ? JSON.stringify(value) :
  Array.isArray(value) ? "[" + value.map(canonical).join(",") + "]" :
    "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
const reseal = (candidate) => {
  candidate.envelope.immutableArtifactDigest = "";
  candidate.envelope.immutableArtifactDigest = sha(canonical(candidate));
  return candidate;
};
function independentlyCheck(request, candidate) {
  const run = spawnSync("python3", [oracle], {
    input: JSON.stringify({ request, candidate }), encoding: "utf8", timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
    env: { PATH: process.env.PATH, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" },
  });
  if (run.error || run.status !== 0) throw Error("ORIGINAL_CHECKER_PROCESS_FAILED");
  return JSON.parse(run.stdout);
}
const accepted = (out) => {
  assert.equal(out.disposition, "UNKNOWN", out.reason);
  assert.ok(out.program);
  return out.program;
};
const results = [];
if (engine) {
  assert.ok(inventory.every(file => !file.missing), "DECLARED_RECONSTRUCTION_SOURCE_ASSET_MISSING");
  const { runtimeIdentity } = await import("../../../packages/private-equity/src/project-z/z1-shared-work/processes.ts");
  const buildIdentity = (await runtimeIdentity()).digest;
  for (let family = 0; family < familySpecifications.length; family++) {
    for (let obligation = 0; obligation < 8; obligation++) {
      const request = freshRequest(family, obligation, buildIdentity);
      const observation = { family, specification: familySpecifications[family], obligation, request, actions: [], nativeOwnerFlow: "NOT_RUN" };
      try {
        const produced = engine.produce(request);
        const candidate = accepted(produced);
        const checked = independentlyCheck(request, candidate);
        assert.equal(checked.disposition, "CHECKED_CANDIDATE", checked.reason);
        observation.actions.push({ kind: "initial", candidate, independent: checked });
        if (obligation < 2) {
          const direct = engine.produce(request, { mode: "DIRECT" });
          assert.equal(independentlyCheck(request, accepted(direct)).disposition, "CHECKED_CANDIDATE");
          const row = structuredClone(request.sources[0].rows[0]);
          const change = { sourceChanges: [{ sourceId: "ledger", fromRevision: request.sources[0].revision, toRevision: "inserted", insert: [row], retract: [] }] };
          const updated = engine.applyChanges(produced.checkpoint, change);
          const updateCheck = independentlyCheck(updated.checkpoint.request, accepted(updated));
          assert.equal(updateCheck.disposition, "CHECKED_CANDIDATE");
          const retracted = engine.applyChanges(updated.checkpoint, {
            sourceChanges: [{ sourceId: "ledger", fromRevision: "inserted", toRevision: "retracted", insert: [], retract: [row] }],
          });
          assert.equal(independentlyCheck(retracted.checkpoint.request, accepted(retracted)).disposition, "CHECKED_CANDIDATE");
          const editedWork = structuredClone(request.works[0]);
          editedWork.programmeRevision = "programme-2";
          editedWork.objectiveRevision = "objective-edited";
          editedWork.parameters.threshold = { type: money, value: "999999" };
          // This changes topology as well as the objective.
          const originalOutput = editedWork.programme.output;
          editedWork.programme.nodes.push({
            id: "edited-output", op: "project", input: originalOutput, semantics: "bag",
            fields: { revised: { op: "add", left: { op: "field", name: "amount" }, right: { op: "literal", type: money, value: "1" } } },
          });
          editedWork.programme.output = "edited-output";
          const edited = engine.applyChanges(retracted.checkpoint, {
            workEdits: [{ workId: editedWork.id, expectedProgrammeRevision: "programme-1", replacement: editedWork }],
          });
          assert.equal(independentlyCheck(edited.checkpoint.request, accepted(edited)).disposition, "CHECKED_CANDIDATE");
          const badRetraction = engine.applyChanges(edited.checkpoint, {
            sourceChanges: [{ sourceId: "ledger", fromRevision: "retracted", toRevision: "bad", insert: [], retract: [{ ...row, amount: "-999999" }] }],
          });
          assert.equal(badRetraction.disposition, "COUNTEREXAMPLE");
          const withdrawn = engine.applyChanges(edited.checkpoint, { withdrawWorkIds: [request.works[1].id] });
          const projection = accepted(withdrawn).workProjections.find((p) => p.workId === request.works[1].id);
          assert.equal(projection.lifecycle, "WITHDRAWN");
          assert.deepEqual(projection.unresolvedObligationRefs, request.works[1].unresolvedObligationRefs);
          assert.equal(independentlyCheck(withdrawn.checkpoint.request, withdrawn.program).disposition, "CHECKED_CANDIDATE");
          observation.actions.push({ kind: "initial-update-retract-edit-withdraw", updateCheck, checkpoint: withdrawn.checkpoint, badRetraction: badRetraction.reason });
        } else if (obligation === 2) {
          const forged = structuredClone(candidate);
          forged.workProjections[0].result.rows.push(structuredClone(forged.workProjections[0].result.rows[0] ?? {}));
          const falseResult = independentlyCheck(request, reseal(forged));
          assert.equal(falseResult.disposition, "COUNTEREXAMPLE");
          assert.equal(falseResult.reason, "ORIGINAL_SEMANTICS_COUNTEREXAMPLE");
          const omitted = structuredClone(candidate);
          omitted.workProjections.pop();
          assert.equal(independentlyCheck(request, reseal(omitted)).reason, "ORIGINAL_WORK_COVERAGE");
          const badGraph = structuredClone(candidate);
          badGraph.sharedDag[0].operator.sourceId = "wrong-original-source";
          assert.equal(independentlyCheck(request, reseal(badGraph)).reason, "SHARED_ORIGINAL_OPERATOR_COVERAGE");
          const badCosts = structuredClone(candidate);
          badCosts.costs.totalTicks = "0";
          assert.equal(independentlyCheck(request, reseal(badCosts)).reason, "TOTAL_SHARED_COST");
          observation.actions.push({ kind: "rehashed-false-output-omitted-original-graph-and-cost-rejected", falseResult });
        } else if (obligation === 3) {
          const unsupported = structuredClone(request);
          unsupported.works[0].programme.nodes[0].op = "floating-effect";
          assert.equal(engine.produce(unsupported).disposition, "UNSUPPORTED");
          observation.actions.push({ kind: "out-of-profile-no-infeasibility-claim" });
        } else if (obligation === 4) {
          const unauthorized = structuredClone(request);
          unauthorized.sources.find((s) => s.id === "ledger").partition.principalId = "other-private-principal";
          // Some original families do not use ledger at all; mutate their actual first source.
          const firstSourceId = unauthorized.works[0].programme.nodes.find((n) => n.op === "source").sourceId;
          unauthorized.sources.find((s) => s.id === firstSourceId).partition.principalId = "other-private-principal";
          assert.equal(engine.produce(unauthorized).disposition, "REVOKED");
          assert.throws(() => engine.projectForWork(candidate, request.works[0].id, { tenantId: "other", principalId: "other" }));
          observation.actions.push({ kind: "unauthorized-source-and-private-read-rejected" });
        } else if (obligation === 5) {
          for (const key of ["objectiveRevision", "termsRevision", "modelRevision", "unitsRevision", "codeRevision", "checkerRevision"]) {
            const changed = structuredClone(request); changed.works[0][key] += "-changed";
            assert.equal(engine.currentness(candidate, changed, request.works[0].id), "STALE");
            assert.equal(engine.currentness(candidate, changed, request.works[1].id), "CURRENT");
          }
          const revoked = engine.applyChanges(produced.checkpoint, { sourceChanges: [{
            sourceId: request.works[0].programme.nodes.find((n) => n.op === "source").sourceId,
            fromRevision: request.sources.find((s) => s.id === request.works[0].programme.nodes.find((n) => n.op === "source").sourceId).revision,
            toRevision: "revoked", insert: [], retract: [], revoked: true,
          }] });
          assert.equal(revoked.program.workProjections[0].disposition, "REVOKED");
          observation.actions.push({ kind: "all-revision-axes-and-revocation", program: revoked.program });
        } else if (obligation === 6) {
          const exhausted = structuredClone(request); exhausted.limits.maxTicks = 1;
          const out = engine.produce(exhausted);
          assert.equal(out.disposition, "INCOMPLETE");
          assert.equal(out.program, null);
          const deadline = structuredClone(request); deadline.limits.deadlineAt = "2000-01-01T00:00:00.000Z";
          assert.equal(engine.produce(deadline).disposition, "INCOMPLETE");
          observation.actions.push({ kind: "resource-and-expired-original-deadline" });
        } else {
          const reloaded = JSON.parse(JSON.stringify(produced.checkpoint));
          const duplicate = engine.produce(request, { previous: reloaded });
          assert.deepEqual(duplicate.program, candidate);
          assert.deepEqual(duplicate.checkpoint.charges, reloaded.charges);
          const rebudgeted = structuredClone(request);
          rebudgeted.works[0].resources.remainingTicks = "999999999";
          assert.equal(engine.produce(rebudgeted, { previous: reloaded }).disposition, "REVOKED");
          observation.actions.push({ kind: "serialized-checkpoint-duplicate-no-new-budget", physicalNativeInterruption: "NOT_RUN" });
        }
        observation.status = "PASSED";
      } catch (error) {
        observation.status = "FAILED";
        observation.failure = { name: error.name, message: String(error.message), stack: error.stack };
      }
      results.push({ family, obligation, status: observation.status, failure: observation.failure ?? null });
      await writeFile(resolve(evidence, `family-${String(family + 1).padStart(2, "0")}-case-${obligation + 1}.json`),
        JSON.stringify(observation, null, 2) + "\n", { flag: "wx" });
    }
  }
  const passed = results.filter((r) => r.status === "PASSED").length;
  const report = {
    scope: "Public original-semantics engine E2E only. Not 32×8 native/protected qualification.",
    status: passed === 256 ? "PASSED" : "FAILED", passed, failed: 256 - passed,
    familySpecificationsSha256: "6af201d06d54d33245dabb1addb0f8f72acd75c9f7a9fc50716e8e1d72a17222",
    results, inventory, node: process.version,
    realNativeOwnerFlow: "NOT_RUN", physicalNativeWorkerRecovery: "NOT_RUN",
    protectedAdmission: "NOT_RUN", equippedComparison: "NOT_RUN", financialOutcome: "NOT_RUN",
    replay: "Use Node 22 with the locked finnor-os tsx loader, this runner and a new absolute evidence directory",
  };
  await writeFile(resolve(evidence, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ status: report.status, passed, failed: report.failed, evidence }));
  if (report.failed) process.exitCode = 1;
}

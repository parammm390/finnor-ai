/** Whole public original-semantics/process episode. No DB/Auth/owner mocks and
 * no native owner-use claim. Oracle inputs are frozen before shared production. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freshRequest, money, scalar } from "./fixtures.mjs";
import { digest, RequestSchema } from "../../../packages/epistemic-runtime/src/project-z/z1-shared-work/contracts.ts";
import { runProducer, checkOriginal, runtimeIdentity } from "../../../packages/private-equity/src/project-z/z1-shared-work/processes.ts";

const output = process.argv[2];
if (!output || !isAbsolute(output)) throw Error("ABSOLUTE_NEW_EPISODE_ARTIFACT_REQUIRED");
await mkdir(output, { mode: 0o700 });
const save = (name, value) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const report = { schema: "finnor.z1.public-original-episode.v1", status: "IN_PROGRESS", stages: [],
  scope: "PUBLIC_SYNTHETIC_ORIGINAL_PROGRAMMES_NOT_EXISTING_NATIVE_WORK_IDENTITIES",
  databaseActions: 0, authenticatedNativeOwnerFlow: "NOT_RUN", protectedAdmission: false, money: null };
try {
  const runtime = await runtimeIdentity(), request = freshRequest(0, 0, runtime.digest);
  request.limits.deadlineAt = new Date(Date.now() + 120000).toISOString();
  for (const work of request.works) work.resources.originalDeadline = request.limits.deadlineAt;
  const field = name => ({ op: "field", name }), source = { id: "source", op: "source", sourceId: "ledger" };
  const sum = (id, input, keys) => ({ id, op: "sum", input, keys, values: { amount: field("amount") }, empty: "zero" });
  const select = (id, input) => ({ id, op: "select", input, limit: 2, ties: "CANONICAL_ROW",
    order: [{ field: "amount", direction: "desc" }, { field: "company", direction: "asc" }] });
  request.works[0].programme = { nodes: [source, { id: "scale", op: "project", input: "source", semantics: "bag",
    fields: { company: field("company"), amount: { op: "mul", left: field("amount"),
      right: { op: "literal", type: scalar, value: "3/2" } } } }, sum("answer", "scale", [])], output: "answer" };
  request.works[1].programme = { nodes: [source, sum("group", "source", ["company"]), select("answer", "group")], output: "answer" };
  request.works[1].unresolvedObligationRefs = [];
  const third = structuredClone(request.works[0]); third.id = "public-synthetic-third-original";
  third.resources = { ...third.resources, parentReservationRef: "public-synthetic-parent-third",
    assignmentRef: "public-synthetic-input-third" };
  third.unresolvedObligationRefs = ["public-synthetic-pending-obligation-not-canonical-S6"];
  third.programme = { nodes: [source, { id: "dimension", op: "source", sourceId: "dimension" },
    { id: "join", op: "join", left: "source", right: "dimension", on: [{ left: "company", right: "company" }], rightPrefix: "d_" },
    { id: "project", op: "project", input: "join", semantics: "bag",
      fields: { company: field("d_parent"), amount: field("amount") } }, sum("group", "project", ["company"]), select("answer", "group") ],
    output: "answer" };
  request.works.push(third);
  const initial = RequestSchema.parse(request), [a, b, c] = initial.works;
  const edited = structuredClone(b); edited.programmeRevision = "public-objective-edit-2"; edited.objectiveRevision = "public-objective-2";
  edited.programme.nodes.splice(2, 0, { id: "objective", op: "project", input: "group", semantics: "bag",
    fields: { company: field("company"), amount: { op: "add", left: field("amount"), right: { op: "literal", type: money, value: "1/3" } } } });
  edited.programme.nodes.find(node => node.id === "answer").input = "objective";
  const row = structuredClone(initial.sources.find(source => source.id === "ledger").rows[0]);
  const ledgerRevision = initial.sources.find(source => source.id === "ledger").revision;
  const dimensionRevision = initial.sources.find(source => source.id === "dimension").revision;
  const stages = [
    { name: "INITIAL" },
    { name: "INSERT", changes: { sourceChanges: [{ sourceId: "ledger", fromRevision: ledgerRevision, toRevision: "public-insert-2", insert: [row], retract: [] }] } },
    { name: "RETRACT", changes: { sourceChanges: [{ sourceId: "ledger", fromRevision: "public-insert-2", toRevision: "public-retract-3", insert: [], retract: [row] }] } },
    { name: "OBJECTIVE_EDIT", changes: { workEdits: [{ workId: b.id, expectedProgrammeRevision: b.programmeRevision, replacement: edited }] } },
    { name: "WITHDRAW", changes: { withdrawWorkIds: [a.id] } },
    { name: "REACTIVATE", changes: { workEdits: [{ workId: a.id, expectedProgrammeRevision: a.programmeRevision,
      replacement: { ...a, programmeRevision: "public-explicit-reactivation-2", withdrawn: false } }] } },
    { name: "REVOKE", changes: { sourceChanges: [{ sourceId: "dimension", fromRevision: dimensionRevision,
      toRevision: "public-revoked-2", insert: [], retract: [], revoked: true }] } },
  ];
  const consumers = { [a.id]: { owner: "S3", measureField: "amount" },
    [b.id]: { owner: "S4", valueField: "amount", actionField: "company", direction: "MAXIMIZE" },
    [c.id]: { owner: "S4", valueField: "amount", actionField: "company", direction: "MAXIMIZE" } };
  const oraclePath = fileURLToPath(new URL("./original-expectations.py", import.meta.url));
  let previousRequest = initial, checkpoint;
  await save("inputs.json", { initial, stages, consumers, runtime });
  for (const [index, stage] of stages.entries()) {
    const input = { request: previousRequest, ...(stage.changes ? { changes: stage.changes } : {}), consumers };
    const oracle = spawnSync("python3", [oraclePath], { input: JSON.stringify(input), encoding: "utf8", timeout: 15000,
      maxBuffer: 134217728, env: { PATH: process.env.PATH, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" } });
    assert.equal(oracle.status, 0, "INDEPENDENT_ORIGINAL_PROCESS_FAILED");
    assert.equal(oracle.signal, null);
    const expected = JSON.parse(oracle.stdout), original = RequestSchema.parse(expected.request);
    assert.equal(expected.requestDigest, digest(original));
    await save(`original-${index}.json`, { stage: stage.name, input, expected, exitCode: oracle.status });
    const produced = await runProducer(original, checkpoint, 15000);
    const candidate = produced.production.program;
    assert.ok(candidate, produced.production.reason);
    for (const projection of candidate.workProjections) {
      assert.deepEqual(projection.result, expected.outputs[projection.workId]);
      assert.equal(digest(projection.result), expected.digests[projection.workId]);
      if (projection.workId === c.id) assert.deepEqual(projection.unresolvedObligationRefs, c.unresolvedObligationRefs);
    }
    const check = await checkOriginal(original, candidate, 15000);
    assert.equal(check.disposition, "CHECKED_CANDIDATE");
    assert.equal(check.originalWorksChecked, 3);
    assert.equal(produced.receipt.lifetimeScope, "WAIT4_COMPLETE_EXITED_CHILD_AND_SEPARATE_SUPERVISOR");
    if (stage.name === "WITHDRAW") assert.equal(expected.outputs[a.id], null);
    if (stage.name === "REACTIVATE") assert.notEqual(expected.outputs[a.id], null);
    if (stage.name === "REVOKE") {
      assert.equal(expected.outputs[c.id], null);
      assert.notEqual(expected.outputs[a.id], null); assert.notEqual(expected.outputs[b.id], null);
    } else assert.equal(expected.ownerUses[c.id].choice, "WAIT_ORIGINAL_S6_RECONCILIATION");
    const observed = { stage: stage.name, requestDigest: expected.requestDigest, candidate,
      check, producerProcess: produced.receipt, oracleExit: oracle.status,
      ownerUseExpectations: expected.ownerUses, nativeOwnerUses: "NOT_RUN" };
    await save(`shared-${index}.json`, observed);
    report.stages.push({ stage: stage.name, candidateDigest: candidate.envelope.immutableArtifactDigest,
      originalResultDigests: expected.digests, producerPid: produced.receipt.pid, checkerPid: check.process.pid });
    checkpoint = produced.production.checkpoint; previousRequest = original;
  }
  report.status = "PASSED";
} catch (error) {
  report.status = "FAILED"; report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally { await save("report.json", report); }
console.log(JSON.stringify({ status: report.status, originalStages: report.stages.length, nativeOwnerFlow: "NOT_RUN" }));

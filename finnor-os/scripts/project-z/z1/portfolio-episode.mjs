/** One public source-process episode. No DB/Auth/owner mocks or native claims.
 * Run under the shared heavy lock, two CPUs and unchanged resource guards. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RequestSchema, digest, Z1_LOCK } from "../../../packages/epistemic-runtime/src/project-z/z1-shared-work/contracts.ts";
import { originalPortfolioPopulation } from "../../../packages/epistemic-runtime/src/project-z/z1-shared-work/portfolio-population.ts";
import { originalPortfolioCapacity } from "../../../packages/epistemic-runtime/src/project-z/z1-shared-work/portfolio-capacity.ts";
import { nativeRef } from "../../../packages/private-equity/src/project-z/z1-shared-work/native-contracts.ts";
import { originalProjectionDeliveries, originalProjectionJobs } from "../../../packages/private-equity/src/project-z/z1-shared-work/deliveries.ts";
import { runProducer, checkOriginal, runtimeIdentity } from "../../../packages/private-equity/src/project-z/z1-shared-work/processes.ts";

const output = process.argv[2], root = fileURLToPath(new URL("../../../../", import.meta.url));
if (!output || !isAbsolute(output)) throw Error("ABSOLUTE_NEW_PORTFOLIO_EPISODE_REQUIRED");
await mkdir(output, { mode: 0o700 });
const save = (name, body) => writeFile(resolve(output, name), JSON.stringify(body, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const report = { schema: "finnor.z1.public-portfolio-episode.v1", status: "IN_PROGRESS", cases: [], negatives: [],
  scope: "PUBLIC_SYNTHETIC_SOURCE_PORTFOLIO_AND_ACTUAL_PRODUCER_CHECKER_NOT_NATIVE_S5",
  databaseActions: 0, nativeOwnerFlow: "NOT_RUN", installedOwnerFlow: "NOT_RUN", nativePhysicalRecovery: "NOT_RUN",
  sharedRequestsApplied: false, protectedAdmission: false, financialQualification: "NOT_RUN", money: null };
const reject = (name, invoke, code) => {
  let error;
  try { invoke(); } catch (caught) { error = caught; }
  assert.equal(error?.message, code, name);
  report.negatives.push({ name, code: error.message, disposition: error.disposition });
};
const scalar = { kind: "rational", unit: "1", currency: null }, money = { kind: "rational", unit: "money", currency: "USD" };
const roles = ["logical", "cpu", "storage", "memory"], amounts = [10000, 1000000, 1048576, 1048576];
const partition = { tenantId: "public-portfolio-tenant", principalId: "public-portfolio-principal",
  permittedUse: "PUBLIC_SYNTHETIC_ORIGINAL_CALCULATION", rightsRevision: "public-rights-1", classification: "INTERNAL" };
const genericRef = (name, index) => {
  const hash = digest([name, index]);
  return { owner: "S5", id: `public-${name}:${hash}`, version: "s5-joint-finite-v1", contentDigest: hash };
};
const bodyForPublication = (candidate, check) => {
  const checkRef = nativeRef("S3", "z1-independent-original-check", check);
  const body = { schema: "finnor.z1.checked-publication.v1",
    envelope: { ...candidate.envelope, immutableArtifactDigest: "",
      checkerIdentityAndResultReferences: { identity: check.checker, resultReference: checkRef },
      gaps: candidate.envelope.gaps.filter(gap => gap !== "INDEPENDENT_CHECK_REQUIRED") },
    candidate, check, executionAuthorityGranted: false, protectedAdmission: false };
  body.envelope.immutableArtifactDigest = digest(body);
  return { reference: nativeRef("S3", "z1-checked-publication", body), body };
};

try {
  assert.match(process.version, /^v22\./);
  assert.equal(Object.keys(process.env).some(key => /^(DATABASE_URL|TEST_OWNER_|AWS_|OPENAI_API_KEY|ANTHROPIC_API_KEY)/.test(key)), false);
  const disk = await statfs(root), mem = await readFile("/proc/meminfo", "utf8");
  const memoryAvailableBytes = Number(mem.match(/^MemAvailable:\s+(\d+)/m)[1]) * 1024;
  report.guards = { diskFreeBytes: disk.bavail * disk.bsize, memoryAvailableBytes,
    diskMinimumBytes: 4 * 1024 ** 3, memoryMinimumBytes: 4 * 1024 ** 3, maximumProcessMs: 30000, heapMiB: 1536 };
  assert.ok(report.guards.diskFreeBytes >= report.guards.diskMinimumBytes && memoryAvailableBytes >= report.guards.memoryMinimumBytes,
    "UNCHANGED_FOUR_GIB_RESOURCE_GUARD_REFUSED");
  const runtime = await runtimeIdentity(), oraclePath = fileURLToPath(new URL("./portfolio-original.py", import.meta.url));
  report.runtime = runtime;
  report.episodeSourceSha256 = sha(await readFile(fileURLToPath(import.meta.url)));
  report.oracleSourceSha256 = sha(await readFile(oraclePath));
  const preservedRepair = { "engine.ts": "df98149cc1137b11f0e31380c02bf5e8347e008c5ff61e8de889be45864dda39",
    "original_checker.py": "f4d33f3e40e35b60898e7fd1bd9058fae6100fb512e31dfa86edb7e5ab245c32" };
  for (const [name, expected] of Object.entries(preservedRepair)) {
    assert.equal(runtime.files.find(file => file.path.endsWith("/" + name)).sha256, expected, "CURRENT_COORDINATOR_EXACT_REPAIR_PRESERVED");
  }
  let largest;
  for (const count of [2, 256, 257, 1000]) {
    const deadline = new Date(Date.now() + 120000).toISOString();
    const horizon = { startAt: "2026-10-26T00:00:00.000Z", periodMs: 3600000, periods: 3 };
    const resourceIds = roles.map(role => `public-portfolio-resource-${role}`);
    const envelope = (role, values) => ({ resourceId: resourceIds[role], kind: role === 3 ? "OCCUPANCY" : "CUMULATIVE_EXPENDITURE",
      unit: role === 0 ? "z1-logical-tick" : role === 1 ? "cpu-microseconds" : "byte", horizon,
      quantities: values.map(String), minimumQuantities: values.map(() => "0") });
    const parents = Array.from({ length: count }, (_, index) => {
      const certificateRef = nativeRef("S5", "z1-original-certificate", { publicOriginal: index, count });
      const reservationRef = nativeRef("S5", "z1-original-budget", { publicOriginal: index, count, certificateRef });
      return { reservationRef, certificateRef, status: ["RESERVED", "UNKNOWN_OUTCOME", "SETTLED_RETAINED"][index % 3],
        policyRefs: [], effectRefs: [], envelopes: amounts.map((amount, role) =>
          envelope(role, role === 3 ? Array(4).fill(amount) : [amount, 0, 0, 0])) };
    });
    const opaque = Array.from({ length: 3 }, (_, index) => ({
      reservationRef: genericRef("opaque-reservation", index),
      ...(index === 1 ? { demandRef: genericRef("opaque-demand", index) } : { certificateRef: genericRef("opaque-certificate", index) }),
      status: ["RESERVED", "UNKNOWN_OUTCOME", "SETTLED_RETAINED"][index], policyRefs: [], effectRefs: [],
      envelopes: roles.map((_, role) => envelope(role, [index + role + 1, index + 2, role + 1, index + 3])),
    }));
    const before = [...parents.slice(0, -1), ...opaque], after = [...parents, ...opaque];
    const resources = roles.map((role, index) => {
      const existingUse = [5, 1, 2, 3], safetyMargin = "7";
      const availability = existingUse.map((_, period) => {
        const indices = index === 3 ? [period] : Array.from({ length: period + 1 }, (_, i) => i);
        const used = indices.reduce((sum, i) => sum + BigInt(existingUse[i]), 0n) +
          BigInt(count * amounts[index]) + opaque.reduce((sum, row) => sum +
            indices.reduce((value, i) => value + BigInt(row.envelopes[index].quantities[i]), 0n), 0n);
        return { amount: String(used + 7n), basis: "REPORTED_AVAILABLE" };
      });
      return { resourceId: resourceIds[index], horizon, kind: index === 3 ? "OCCUPANCY" : "CUMULATIVE_EXPENDITURE",
        unit: index === 0 ? "z1-logical-tick" : index === 1 ? "cpu-microseconds" : "byte",
        existingUse: existingUse.map(String), availability, safetyMargin };
    });
    const request = RequestSchema.parse({ schema: "finnor.z1.request.v1",
      identity: { productLockDigest: Z1_LOCK, sourceCommit: "d14e18a5988a2608878b18d97979d294a5175cfe",
        sourceTree: "c280e54bddf7b5d7ac8f816472d4bd1921cc712d", producerBuildIdentity: runtime.digest,
        checkerIdentity: "z1-original-fraction-v1", ownerConsumerContractVersion: "z1-per-original-work-v1",
        reconstructionReference: "public-source-portfolio-not-native-installed" },
      sources: [{ id: "ledger", revision: "public-original-bag-1", partition, columns: { amount: money },
        rows: [1, 2, 3, 3, 4].map(value => ({ amount: String(value) })), revoked: false, evidenceClass: "deterministic" }],
      works: parents.map((parent, index) => ({ id: `public-portfolio-original-${count}-${index}`, partition,
        inputRef: `public-portfolio-input-${count}-${index}`, programmeRevision: "public-programme-1",
        objectiveRevision: `public-objective-${index}`, termsRevision: "public-terms-1", modelRevision: "public-model-1",
        unitsRevision: "public-units-1", codeRevision: runtime.digest, checkerRevision: "z1-original-fraction-v1",
        programme: { nodes: [{ id: "source", op: "source", sourceId: "ledger" },
          { id: "scale", op: "project", input: "source", semantics: "bag", fields: {
            amount: { op: "mul", left: { op: "field", name: "amount" }, right: { op: "param", name: "factor" } } } },
          { id: "answer", op: "sum", input: "scale", keys: [], values: { amount: { op: "field", name: "amount" } }, empty: "zero" }],
          output: "answer" },
        parameters: { factor: { type: scalar, value: `${(1n << 508n) + BigInt(index + 1)}/${(1n << 508n) + 1009n}` } },
        resources: { mandateRef: `public-original-mandate-${count}-${index}`, assignmentRef: `public-original-assignment-${count}-${index}`,
          parentReservationRef: parent.reservationRef.id, remainingBudgetRef: parent.reservationRef.contentDigest,
          originalDeadline: deadline, remainingTicks: "2000000" },
        unresolvedObligationRefs: [`public-original-S6-UNKNOWN-${count}-${index}`], withdrawn: false })),
      limits: { maxTicks: 2000000, maxBytes: 134217728, deadlineAt: deadline } });
    const input = { request, resources, before, after, requested: Object.fromEntries(resourceIds.map((id, i) => [id, String(amounts[i])])) };
    await save(`input-${count}.json`, input);
    const oracle = spawnSync("python3", [oraclePath], { input: JSON.stringify(input), encoding: "utf8", timeout: 15000,
      maxBuffer: 134217728, env: { PATH: process.env.PATH, LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" } });
    await save(`original-${count}.json`, { exitCode: oracle.status, signal: oracle.signal,
      expected: oracle.status === 0 ? JSON.parse(oracle.stdout) : null, diagnosticBytes: Buffer.byteLength(oracle.stderr ?? "") });
    assert.equal(oracle.status, 0, "INDEPENDENT_ORIGINAL_EXPECTATION_FAILED");
    const expected = JSON.parse(oracle.stdout);
    assert.equal(expected.requestDigest, digest(request));
    assert.equal(expected.maximumOriginalResultComponentBits, 512);
    assert.equal(expected.affinity.length, 2);
    const observed = { before: originalPortfolioPopulation(before), after: originalPortfolioPopulation(after), capacity: {} };
    for (const state of ["before", "after"]) {
      assert.equal(observed[state].valid, true);
      assert.equal(observed[state].originals, expected.population[state].originals);
      assert.equal(observed[state].other, expected.population[state].other);
    }
    assert.ok(observed.before.originals < 1000);
    for (const resource of resources) {
      const admitted = originalPortfolioCapacity(resource, before, input.requested[resource.resourceId]);
      const retained = originalPortfolioCapacity(resource, after, "0");
      assert.deepEqual(admitted.occupation, expected.capacityBefore[resource.resourceId].occupation);
      assert.deepEqual(retained.occupation, expected.capacityAfter[resource.resourceId].occupation);
      const short = structuredClone(resource);
      short.availability.at(-1).amount = String(BigInt(short.availability.at(-1).amount) - 1n);
      reject(`one-unit-short-${count}-${resource.resourceId}`, () => originalPortfolioCapacity(short, after, "0"), "Z1_SHARED_S5_RESOURCE_EXHAUSTED");
      observed.capacity[resource.resourceId] = { admitted, retained, independentShortage: expected.oneUnitShort[resource.resourceId] };
    }
    await save(`capacity-${count}.json`, observed);
    const produced = await runProducer(request, undefined, 30000);
    await save(`producer-${count}.json`, produced);
    const candidate = produced.production.program;
    assert.ok(candidate, produced.production.reason);
    for (const projection of candidate.workProjections) {
      assert.deepEqual(projection.result, expected.outputs[projection.workId]);
      assert.equal(digest(projection.result), expected.digests[projection.workId]);
      assert.deepEqual(projection.unresolvedObligationRefs, projection.binding.original.unresolvedObligationRefs);
    }
    assert.equal(candidate.sharedDag.filter(node => node.operator.op === "source").length, 1);
    const check = await checkOriginal(request, candidate, 30000);
    await save(`checker-${count}.json`, check);
    assert.equal(check.disposition, "CHECKED_CANDIDATE");
    assert.equal(check.originalWorksChecked, count);
    assert.equal(check.originalNodesChecked, 3 * count);
    const publication = bodyForPublication(candidate, check);
    const cuts = request.works.map((work, index) => ({ workId: work.id, inputId: work.inputRef, parent: parents[index].reservationRef }));
    const deliveries = originalProjectionDeliveries(publication, cuts);
    const jobs = originalProjectionJobs(publication, cuts, { tenantId: partition.tenantId, principalId: partition.principalId,
      requestId: `public-portfolio-request-${count}`, generation: 1 });
    assert.equal(deliveries.length, count); assert.equal(jobs.length, count);
    assert.equal(new Set(jobs.map(job => job.key)).size, count);
    assert.ok(jobs.every(job => job.payload.workIds.length === 1 && job.payload.workIds[0] === job.payload.workId));
    assert.deepEqual(originalProjectionDeliveries(JSON.parse(JSON.stringify(publication)), cuts), deliveries);
    assert.deepEqual(originalProjectionJobs(publication, cuts, { tenantId: partition.tenantId, principalId: partition.principalId,
      requestId: `public-portfolio-request-${count}`, generation: 1 }), jobs);
    await save(`delivery-plan-${count}.json`, { scope: "DETERMINISTIC_PUBLIC_PLAN_NOT_DATABASE_PERSISTENCE_OR_S8",
      publicationReference: publication.reference, deliveries, jobs });
    report.cases.push({ count, originalParents: count, opaqueOtherParents: opaque.length, status: "PASSED",
      independentlyCheckedOriginals: check.originalWorksChecked, originalNodes: check.originalNodesChecked,
      sharedNodes: candidate.sharedDag.length, originalResultBits: expected.maximumOriginalResultComponentBits,
      producerPid: produced.receipt.pid, checkerPid: check.process.pid, candidateDigest: candidate.envelope.immutableArtifactDigest,
      jobPlanBytes: Buffer.byteLength(JSON.stringify(jobs)), expectedBeforeProducer: true });
    largest = { input, publication, cuts, resources, after };
  }
  const duplicate = [...largest.after, largest.after[0]];
  reject("duplicate-original-parent", () => originalPortfolioCapacity(largest.resources[0], duplicate, "0"), "Z1_COMPLETE_S5_POPULATION_BOUND");
  const forged = structuredClone(largest.after); forged[0].certificateRef.version = "forged-label";
  reject("forged-native-label", () => originalPortfolioCapacity(largest.resources[0], forged, "0"), "Z1_COMPLETE_S5_POPULATION_BOUND");
  const stale = structuredClone(largest.after); stale[0].envelopes[0].horizon.periodMs += 1;
  reject("stale-opaque-horizon", () => originalPortfolioCapacity(largest.resources[0], stale, "0"), "Z1_S5_COMPLETE_SHARED_HORIZON_REQUIRED");
  const extra = structuredClone(largest.after[0]);
  extra.reservationRef = nativeRef("S5", "z1-original-budget", { publicOverflow: 1001 });
  const overflow = [...largest.after, extra];
  reject("1001-original-parents", () => originalPortfolioCapacity(largest.resources[0], overflow, "0"), "Z1_COMPLETE_S5_POPULATION_BOUND");
  const other = largest.after.filter(row => !row.reservationRef.id.startsWith("z1-original-budget:"));
  const generic256 = Array.from({ length: 256 }, (_, i) => ({ ...other[i % other.length], reservationRef: genericRef("other-bound", i) }));
  assert.deepEqual(originalPortfolioPopulation([...largest.after.slice(0, 1000), ...generic256]),
    { originals: 1000, other: 256, valid: true });
  assert.equal(originalPortfolioPopulation([...largest.after.slice(0, 1000), ...generic256,
    { ...generic256[0], reservationRef: genericRef("other-bound", 256) }]).valid, false);
  report.negatives.push({ name: "257-other-commitments", status: "REJECTED_WITH_1000_ORIGINALS",
    exactBoundary: { originals: 1000, other: 256, valid: true } });
  const request1001 = structuredClone(largest.input.request); request1001.works.push(structuredClone(request1001.works[0]));
  assert.equal(RequestSchema.safeParse(request1001).success, false);
  const missing = structuredClone(largest.publication); missing.body.candidate.workProjections.pop();
  missing.reference = nativeRef("S3", "z1-checked-publication", missing.body);
  reject("missing-original-delivery", () => originalProjectionDeliveries(missing, largest.cuts), "Z1_COMPLETE_ORIGINAL_DELIVERY_COVERAGE_REQUIRED");
  const changedParent = structuredClone(largest.cuts); changedParent[0].parent = extra.reservationRef;
  reject("changed-original-delivery-parent", () => originalProjectionDeliveries(largest.publication, changedParent), "Z1_ORIGINAL_DELIVERY_PARENT_BINDING_REQUIRED");
  await save("negative-boundaries.json", { negatives: report.negatives, request1001Admitted: false, producerStartedFor1001: false,
    nativeClaimDuplicateAndRecovery: "NOT_RUN", databaseBatchAtomicity: "NOT_RUN" });
  const tooWide = structuredClone(largest.input.request);
  tooWide.works = tooWide.works.slice(0, 2);
  tooWide.works[0].parameters.factor.value = String(1n << 512n);
  await save("original-513-bit-refusal.json", { request: tooWide, expected: "INCOMPLETE", numeratorBits: 513, expectedBeforeProducer: true });
  const refused = await runProducer(tooWide, undefined, 30000);
  await save("producer-513-bit-refusal.json", refused);
  assert.equal(refused.production.disposition, "INCOMPLETE");
  assert.equal(refused.production.program, null);
  report.bit513Refusal = "INCOMPLETE_WITHOUT_PUBLICATION";
  report.status = "PASSED_PUBLIC_SOURCE_PORTFOLIO_PROCESS_ONLY";
} catch (error) {
  report.status = "FAILED"; report.failure = { name: error.name, message: error.message, processReceipt: error.receipt ?? null };
  process.exitCode = 1;
} finally { await save("report.json", report); }
console.log(JSON.stringify({ status: report.status, cases: report.cases, failure: report.failure ?? null, nativeOwnerFlow: "NOT_RUN" }));

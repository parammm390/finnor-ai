import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import * as uw from "../../packages/underwriting/src/index";
import {
  captureR6NativeIdentity, checkDecisionProof, checkDecisionProofCurrentness, checkDecisionProofDomainMembership,
  proposeDecisionProof, r6OwnerEnvelopeCommitmentsDigest, r6Sha256, runVerifiedCapitalCompiler,
  type R6ResolvedProblem, type R6ProofPacket, type R6RunRequest, type R6CheckerOptions,
} from "../../packages/epistemic-runtime/src/verified-capital-compiler/index";
import type { R6InputDomain, R6MoneyConvention, R6ReferenceState } from "../../packages/shared-types/src/decision-proof";
import type { ExperimentRef } from "../../packages/shared-types/src/experiments";
const args = process.argv.slice(2), evidence = resolve(args[args.indexOf("--evidence") + 1]!);
const source = resolve(args[args.indexOf("--source-evidence") + 1]!);
const repo = resolve(process.env.R6_REPOSITORY_ROOT!), deps = resolve(process.env.R6_DEPS_ROOT!);
const owned = join(repo, "scope-r/r6-verified-capital-compiler/evidence-private/");
assert(evidence.startsWith(owned) && source.startsWith(owned) && evidence !== source);
const results: Array<Record<string, unknown>> = [];
let retainedBytes = 0;
async function retain(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value, null, 2) + "\n";
  retainedBytes += Buffer.byteLength(serialized); assert(retainedBytes <= 64 * 1024 * 1024);
  await writeFile(path, serialized, { flag: "wx" });
}
const ref = (id: string, value: unknown): ExperimentRef => ({
  owner: "@finnor/epistemic-runtime", id: `SYNTHETIC_R6_V2_${id}`, version: "2", contentDigest: uw.semanticHash(value),
});
function checkerOptions(dir: string): R6CheckerOptions {
  return {
    repositoryRoot: repo, pythonExecutable: "/usr/bin/python3", decimalModulePath: join(deps, "decimal.js/decimal.mjs"),
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    retainTranscript: transcript => retain(join(dir, "checker.transcript.json"), transcript),
  };
}
function request(problem: R6ResolvedProblem, dir: string): R6RunRequest {
  const grant = ref("UNISSUED_GRANT", { noGrantIssuance: true });
  return {
    envelope_inputs: {
      schema: "finnor.r6.artifact-envelope.v1", work_ref: ref("WORK", { synthetic: true }), work_revision: "2",
      tenant_ref: { owner: "@finnor/db", id: "SYNTHETIC_R6_V2_TENANT" },
      baseline_manifest_ref: ref("BASELINE", { commit: "4acb14f3399858b1cdf707479e0975bf3afc763a" }),
      producer_ref: { code_digest: problem.nativeIdentity.producerDigest, dependency_lock_digest: problem.nativeIdentity.dependencyLockDigest, admission_ref: null },
      input_refs: problem.domain.inputs.map(b => ({ owner_ref: b.ownerRef, revision: "1",
        content_digest: b.ownerRef.contentDigest, as_of: problem.witness.worldAt, rights_revision: 1 })),
      domain_ref: problem.domain.ref, assumptions_ref: ref("ASSUMPTIONS", problem.reference.assumptions),
      programme_grammar_ref: ref("NATIVE_METHOD", { ir: "underwriting-model-ir.v1", method: uw.NATIVE_RETURN_V2_POLICY }),
      resource_receipt_refs: [], budget_grant_ref: grant,
      invalidation_dependency_refs: [{ key: "SYNTHETIC_OWNER_RIGHTS", revision: 1, digest: uw.semanticHash({ rights: 1 }), nodeIds: [] }],
      lifecycle_event_refs: [],
    },
    problem_ref: ref("PROGRAMME", problem.programme), existing_work_revision: "2", domain_profile_ref: problem.domain.ref,
    budget_grant_ref: grant, cancellation_ref: ref("ORIGINAL_CANCELLATION", { issued: false }), problem, checker: checkerOptions(dir),
  };
}
function convention(model: uw.UnderwritingModelIR, snapshot: uw.UnderwritingInputSnapshot): R6MoneyConvention {
  const periods = uw.buildPeriods(model.periodDefinition);
  return {
    currency: "USD", valuationDate: "2026-01-01", ownerShare: { numerator: "1", denominator: "1" },
    discountConventionRef: ref("NO_DISCOUNT", { native: "no extra discount" }), timeBasis: "EXACT_NATIVE_FINANCIAL_PERIODS",
    semantics: { entityType: "investment_case", entityId: snapshot.investmentCaseId,
      periodStart: `${periods[0]!.startDate}T00:00:00.000Z`, periodEnd: `${periods.at(-1)!.endDate}T23:59:59.999Z`,
      unit: "currency", currencyCode: "USD", frequency: model.periodDefinition.frequency, calendar: "GREGORIAN",
      consolidation: "OWNER_SUBJECT_ONLY", instrument: "SYNTHETIC_NATIVE_R6_LBO_V2", scale: "1", sign: "AS_RECORDED" },
  };
}
type Original = { config: uw.StandardLboModelConfig; model: uw.UnderwritingModelIR;
  compiled: uw.CompiledUnderwritingModel; snapshot: uw.UnderwritingInputSnapshot;
  domain: R6InputDomain; inventory: R6ReferenceState[]; result: uw.UnderwritingRunResult };
function refresh(packet: R6ProofPacket): void {
  packet.proof.programmeDigest = uw.semanticHash(packet.programme);
  packet.proof.referenceDigest = uw.semanticHash(packet.reference);
  packet.proof.domainDigest = uw.semanticHash(packet.domain);
  packet.proof.bindingsDigest = uw.semanticHash(packet.programmeBindings);
  packet.proof.compiledProgrammeDigest = uw.semanticHash(packet.compiledProgramme);
  packet.proof.compiledReferenceDigest = uw.semanticHash(packet.compiledReference);
  packet.proof.nativeIdentityDigest = uw.semanticHash(packet.nativeIdentity);
  packet.proof.witnessDigest = uw.semanticHash(packet.witness);
}
function rehashResult(packet: R6ProofPacket): void {
  const result = packet.nativeWitness.programme;
  const { resultSemanticHash: _old, ...body } = result; result.resultSemanticHash = uw.semanticHash(body);
}
async function caseRun(id: string, action: (dir: string) => Promise<unknown>): Promise<void> {
  const dir = join(evidence, id); await mkdir(dir); const start = performance.now();
  try {
    const observed = await action(dir);
    const result = { id, status: "PASS", observed, elapsedMs: Math.round(performance.now() - start) };
    results.push(result); await retain(join(dir, "case.json"), result); console.log(`${id}: PASS`);
  } catch (error) {
    const result = { id, status: "FAIL", reason: String(error), stack: error instanceof Error ? error.stack : null,
      elapsedMs: Math.round(performance.now() - start) };
    results.push(result); await retain(join(dir, "case.json"), result); throw error;
  }
}
async function main(): Promise<void> {
  const disk = await statfs(repo); assert(Number(disk.bavail) * Number(disk.bsize) >= 160 * 1024 * 1024);
  const nativeIdentity = await captureR6NativeIdentity({ repositoryRoot: repo, dependencyRoot: deps,
    nativeReturnMethod: uw.NATIVE_RETURN_METHOD_V2 });
  await retain(join(evidence, "source-cut.json"), {
    head: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    tree: execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
    status: execFileSync("git", ["-C", repo, "status", "--short"], { encoding: "utf8" }),
    nativeIdentity, nativeMethod: uw.NATIVE_RETURN_V2_POLICY, runnerSha256: r6Sha256(await readFile(new URL(import.meta.url))),
  });
  const base: { packet: R6ProofPacket | null; run: Awaited<ReturnType<typeof runVerifiedCapitalCompiler>> | null } = { packet: null, run: null };
  for (const id of ["retained-original-one-period", "annual-9-late-exit", "annual-12-late-exit",
    "quarterly-12-late-exit", "monthly-12-late-exit", "average-balance-12-late-exit"]) {
    await caseRun(`whole-domain-${id}`, async dir => {
      const original = JSON.parse(await readFile(join(source, id, "native.json"), "utf8")) as Original;
      const programme = uw.createStandardLboModel({ ...original.config,
        modelVersion: `${original.config.modelVersion}+decimal34_horner_npv_v2`, returnMethod: uw.NATIVE_RETURN_METHOD_V2 });
      const referenceModel = { ...structuredClone(programme), modelKey: "r6-native-standard-lbo-v2-unapproved-reference" };
      const problem: R6ResolvedProblem = {
        programme, reference: {
          schema: "finnor.r6.reference-specification.v1", ref: ref(`UNAPPROVED_REFERENCE_${id}`, { model: referenceModel, inventory: original.inventory }),
          model: referenceModel, stateInventory: original.inventory,
          inventoryBasis: "ALL_DECLARED_REFERENCE_ITEMS_NOT_ALL_REAL_WORLD_OBLIGATIONS",
          moneyConventions: [convention(referenceModel, original.snapshot)],
          assumptions: [{ ref: ref("DECLARED_SYNTHETIC_MODEL_NOT_APPROVED", { id }),
            statement: "The full retained synthetic native financial inputs/inventory are unchanged. This is an explicitly selected NEW native ordered return operation, not old v1 arithmetic, independently approved business truth, legal completeness, checker admission or settlement authority.",
            qualification: "SUPPLIED_MODEL_RELATIVE" }], approval: null,
        },
        domain: original.domain, programmeBindings: original.inventory.map(s => ({ ledgerRef: s.ledgerRef, nodeId: s.nodeId, timing: s.timing })),
        witness: original.snapshot, nativeIdentity,
      };
      assert.equal(uw.canonicalSerialize(problem.domain), uw.canonicalSerialize(original.domain));
      assert.equal(uw.canonicalSerialize(programme.nodes), uw.canonicalSerialize(original.model.nodes));
      assert.equal(problem.reference.stateInventory.length, programme.nodes.length);
      const run = await runVerifiedCapitalCompiler(request(problem, dir));
      if (run.packet) await retain(join(dir, "packet.json"), run.packet);
      await retain(join(dir, "run-without-duplicate-packet.json"), { ...run, packet: run.packet ? { packetDigest: uw.semanticHash(run.packet) } : null });
      assert.equal(run.receipt?.disposition, "ACCEPTED", `${run.receipt?.predicate}: ${run.receipt?.reason}`);
      assert.equal(run.receipt.allInputEquivalence, true); assert.equal(run.receipt.universallyValid, true);
      assert.equal(run.status, "INCOMPLETE", "Ordinary acceptance is never admission or approved business reference");
      assert.equal(run.artifact_ref, null); assert.equal(run.proof?.executionAuthorityGranted, false);
      assert.equal(run.proof?.reservationGranted, false); assert.equal(run.proof?.qualification.referenceApproval, "NOT_ESTABLISHED");
      const certificate = (run.receipt as unknown as { specializedCertificate: { allExitBranches: unknown[]; noSampledUniversalProof: boolean } }).specializedCertificate;
      assert.equal(certificate.allExitBranches.length, original.config.periodDefinition.count);
      assert.equal(certificate.noSampledUniversalProof, true);
      if (id === "average-balance-12-late-exit") { base.packet = run.packet!; base.run = run; }
      return { mechanicalDisposition: run.receipt.disposition, producerStatus: run.status, fullDomainDigest: uw.semanticHash(problem.domain),
        unchangedOriginalDomain: true, allExitChoices: certificate.allExitBranches.length, domainCardinality: run.receipt.domainCardinality,
        nativeNodes: programme.nodes.length, fullInventory: original.inventory.length, nativeChecks: run.receipt.witnessChecks.length,
        nativeOutputs: Object.keys(run.packet!.nativeWitness.programme.outputs).length, packetDigest: uw.semanticHash(run.packet) };
    });
  }
  if (!base.packet || !base.run?.proof) throw new Error("Base average-balance proof case did not run");
  const basePacket = base.packet, baseRun = base.run;
  type Mutation = [string, (packet: R6ProofPacket) => void];
  const mutations: Mutation[] = [
    ["omit-required-input", p => { p.domain.inputs.pop(); }],
    ["widen-original-ev-lattice", p => { const b = p.domain.inputs.find(b => b.programmeNodeId === "entry.enterprise_value")!;
      if (b.components.$scalar!.kind === "DECIMAL_LATTICE") b.components.$scalar!.maximum = "102"; }],
    ["remove-twelfth-exit", p => { const b = p.domain.inputs.find(b => b.programmeNodeId === "exit.period_id")!;
      if (b.components.$scalar!.kind === "ENUMERATION") b.components.$scalar!.values.pop(); }],
    ["reference-silently-v1", p => { delete p.reference.model.runtime!.returnMethod;
      p.compiledReference = uw.compileUnderwritingModel(p.reference.model); }],
    ["omit-liability-state", p => { const i = p.reference.stateInventory.findIndex(s => s.role === "LIABILITY");
      p.reference.stateInventory.splice(i, 1); p.programmeBindings.splice(i, 1); p.proof.statements.splice(i, 1); }],
    ["misclassify-liability", p => { const s = p.reference.stateInventory.find(s => s.role === "LIABILITY")!;
      s.role = "CASH"; s.obligationStatus = "NOT_APPLICABLE"; s.obligationRef = null; }],
    ["unknown-liability", p => { p.reference.stateInventory.find(s => s.role === "LIABILITY")!.obligationStatus = "UNKNOWN"; }],
    ["unapproved-axiom", p => { (p.proof.axioms as unknown as string[]).push("approximate fractional power is exact"); }],
    ["unresolved-goal", p => { (p.proof.unresolvedGoals as unknown as string[]).push("all exit branches"); }],
    ["native-rounding-policy", p => { (p.nativeIdentity.decimalPolicy as unknown as { precision: number }).precision = 35; }],
    ["counterfeit-native-source", p => { p.nativeIdentity.sourcePins[1]!.sha256 = "0".repeat(64); }],
    ["missing-checker-helper-dependency", p => { p.nativeIdentity.checkerDependencyPins!.pop(); }],
    ["counterfeit-horner-partial", p => { p.nativeWitness.programme.returnSolverTraces![0]!.npvs[2]!.partials[1] = "7"; rehashResult(p); }],
    ["counterfeit-daily-root-power", p => { p.nativeWitness.programme.returnSolverTraces![1]!.dailyBrackets[1]!.steps[0]!.power = "7"; rehashResult(p); }],
    ["counterfeit-bisection-width", p => { p.nativeWitness.programme.returnSolverTraces![0]!.iterations[0]!.width = "0"; rehashResult(p); }],
    ["omit-return-trace", p => { delete p.nativeWitness.programme.returnSolverTraces; rehashResult(p); }],
    ["counterfeit-fixed-point-diagnostic", p => { p.nativeWitness.programme.solverDiagnostics[0]!.converged = false; rehashResult(p); }],
    ["counterfeit-native-ending-cash", p => { (p.nativeWitness.programme.values["cash.ending"]!.value as Record<string, string>)[p.compiledProgramme.periods[0]!.id] = "7"; rehashResult(p); }],
    ["mutate-hard-check", p => { p.nativeWitness.programme.checks[0]!.passed = false; rehashResult(p); }],
    ["mutate-state-settlement-time", p => { p.programmeBindings[0]!.timing = { kind: "AS_OF", date: "2026-01-02" }; }],
  ];
  assert(mutations.length <= 24);
  for (const [id, mutate] of mutations) await caseRun(id, async dir => {
    const packet = structuredClone(basePacket!); mutate(packet); refresh(packet);
    await retain(join(dir, "reconstructible-mutation.json"), {
      basePacket: "../whole-domain-average-balance-12-late-exit/packet.json", basePacketDigest: uw.semanticHash(basePacket),
      id, exactMutationFunction: mutate.toString(), refreshedProofBindings: true, modifiedPacketDigest: uw.semanticHash(packet),
      rerun: "Apply this exact function to the retained base packet, refresh with this pinned script's refresh(), and invoke the enrolled checker.",
    });
    const receipt = await checkDecisionProof(packet, checkerOptions(dir));
    await retain(join(dir, "receipt.json"), receipt); assert.notEqual(receipt.disposition, "ACCEPTED", receipt.predicate);
    assert.equal(receipt.universallyValid, false);
    return { disposition: receipt.disposition, predicate: receipt.predicate };
  });
  await caseRun("versioned-currentness-and-actual-membership", async dir => {
    const proof = baseRun!.proof!;
    const current = { workRevision: proof.envelope.work_revision, ownerEnvelopeDigest: r6OwnerEnvelopeCommitmentsDigest(proof.envelope),
      programmeDigest: proof.proofObject.programmeDigest, bindingsDigest: proof.proofObject.bindingsDigest,
      referenceDigest: proof.proofObject.referenceDigest, domainDigest: proof.proofObject.domainDigest,
      nativeIdentityDigest: proof.proofObject.nativeIdentityDigest, dependencies: proof.envelope.invalidation_dependency_refs };
    assert.equal(checkDecisionProofCurrentness(proof, current).status, "CURRENT");
    assert.equal(checkDecisionProofCurrentness(proof, { ...current, nativeIdentityDigest: uw.semanticHash({ oldV1: true }) }).status, "INVALIDATED");
    const inside = checkDecisionProofDomainMembership(basePacket!, baseRun!.receipt!, basePacket!.witness);
    assert.equal(inside.status, "INSIDE_DECLARED_DOMAIN");
    const later = structuredClone(basePacket!.witness);
    later.values["entry.enterprise_value"]!.value = uw.decimal("102");
    delete later.semanticHash; // sealInputSnapshot verifies any pre-existing hash
    const outside = checkDecisionProofDomainMembership(basePacket!, baseRun!.receipt!, uw.sealInputSnapshot(later));
    assert.equal(outside.status, "OUTSIDE_DECLARED_DOMAIN");
    await retain(join(dir, "currentness-membership.json"), { current, inside, outside });
    return { oldMethodInvalidates: true, actualLaterInputOutside: true, certificationOrAuthorityGranted: false };
  });
  await caseRun("original-v2-deadline", async dir => {
    const receipt = await checkDecisionProof(basePacket!, { ...checkerOptions(dir), deadlineAt: new Date(Date.now() - 1).toISOString() });
    assert.equal(receipt.disposition, "UNKNOWN"); return receipt.predicate;
  });
  await caseRun("original-v2-cancellation", async dir => {
    const controller = new AbortController(); controller.abort();
    const receipt = await checkDecisionProof(basePacket!, { ...checkerOptions(dir), signal: controller.signal });
    assert.equal(receipt.disposition, "UNKNOWN"); return receipt.predicate;
  });
  await caseRun("v2-retention-fails-closed", async dir => {
    const receipt = await checkDecisionProof(basePacket!, { ...checkerOptions(dir),
      retainTranscript: async t => { await retain(join(dir, "retained-before-sink-failure.json"), t); throw new Error("Synthetic retained sink failure"); } });
    assert.equal(receipt.disposition, "UNKNOWN"); assert.equal(receipt.predicate, "CHECKER_TRANSCRIPT_RETENTION");
    return receipt.predicate;
  });
}
let failure: unknown = null;
try { await main(); } catch (error) { failure = error; console.error(error); }
await retain(join(evidence, "summary.json"), {
  schema: "finnor.r6.versioned-standard-lbo-e2e.v1", engineeringChecks: failure ? "FAIL" : "PASS",
  allInputProof: failure ? "NOT_COMPLETED" : "CONDITIONAL_MECHANICS_ONLY", cases: results, retainedBytes,
  failure: failure ? String(failure) : null, oldV1FailuresRetained: true, domainNarrowed: false,
  referenceApproval: "NOT_ESTABLISHED", checkerAdmission: "NOT_ESTABLISHED", authorityGranted: false,
});
if (failure) process.exitCode = 1;

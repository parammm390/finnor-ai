import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import {
  constructOrganizationTransformation, checkOrganizationTransformation, applyTransformationDecision,
  planObligationBridge, qualifyOperatingBenefit, organizationDigest,
} from "../../../packages/private-equity/src/organization-transformation/index";

const output = process.argv[2];
assert(output && isAbsolute(output), "new absolute evidence directory required");
await mkdir(output, { recursive: false, mode: 0o700 });
const started = performance.now(), steps: unknown[] = [];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ref = (n: number, owner = "S1") => ({ owner, id: id(n), version: "1", contentDigest: "a".repeat(64) });
const at = "2030-01-01T00:00:00.000Z", end = "2030-01-08T00:00:00.000Z";
function fixture(family: string = "CUSTOMER_RESOLUTION", count = 1): any {
  const roles = [
    { id: "support", principalId: id(2), teamId: "service", kind: "HUMAN", capabilities: ["prepare_evidence", "coordinate"],
      availableSeconds: 20000, committedSeconds: 1000, compensationMinor: 50000, benefitsDigest: "benefits-1",
      safetyDigest: "safe-1", accessibilityDigest: "access-1", authorityRefs: [ref(20, "S6")] },
    { id: "approver", principalId: id(3), teamId: "finance", kind: "HUMAN", capabilities: ["approve"],
      availableSeconds: 10000, committedSeconds: 1000, compensationMinor: 50000, benefitsDigest: "benefits-2",
      safetyDigest: "safe-2", accessibilityDigest: "access-2", authorityRefs: [ref(21, "S6")] },
    { id: "digital", principalId: id(4), teamId: "service", kind: "DIGITAL", capabilities: ["prepare_evidence", "coordinate"],
      availableSeconds: 20000, committedSeconds: 0, compensationMinor: 0, benefitsDigest: "not-employee",
      safetyDigest: "safe-3", accessibilityDigest: "access-3", authorityRefs: [] },
    { id: "provider", principalId: id(5), teamId: "fulfillment", kind: "PROVIDER", capabilities: ["deliver"],
      availableSeconds: 20000, committedSeconds: 1000, compensationMinor: 40000, benefitsDigest: "contract-1",
      safetyDigest: "safe-4", accessibilityDigest: "access-4", authorityRefs: [ref(22, "S6")] },
  ];
  return { schema: "finnor.organization-transformation-input.v1", tenantId: id(1), principalId: id(6),
    companyId: id(7), workId: id(8), workInputId: id(9), sourceClass: "CONTROLLED",
    mandate: { ref: ref(10, "S4"), purpose: "Improve resolution without weakening original controls",
      originalDeadline: end, validFrom: at, materialImprovementSeconds: 30, maxMigrationHumanSeconds: 3600,
      maxAddedOperationHumanSeconds: 1200, maxMigrationCostMinor: 10000, currency: "USD",
      evaluatorPrincipalId: id(11), maxAlternatives: 16, requiredServiceIds: ["original-service"],
      trial: { assignmentRef: ref(12, "S2"), kind: "PARALLEL_RANDOMIZED", outcomeRangeSeconds: 3600,
        confidence: 0.95, minimumPerArm: 20, interference: "CONTROLLED", carryover: "NONE" } },
    organization: { ref: ref(13, "X1"), revision: "1", sourceRefs: [ref(14)], roles,
      processes: Array.from({ length: count }, (_, p) => ({ id: `process-${p}`, family, serviceId: "original-service",
        teamIds: ["service", "finance", "fulfillment"], nodes: [
          { id: `collect-${p}`, kind: "PREPARE", roleId: "support", operation: "prepare_evidence",
            after: [], requiredEvidence: ["invoice", "delivery"], mandatory: false, effortSeconds: 300 },
          { id: `approve-${p}`, kind: "APPROVE", roleId: "approver", operation: "approve", after: [`collect-${p}`],
            requiredEvidence: ["invoice", "delivery"], mandatory: true, effortSeconds: 60 },
          { id: `deliver-${p}`, kind: "EXECUTE", roleId: "provider", operation: "deliver", after: [`approve-${p}`],
            requiredEvidence: ["approval"], mandatory: true, effortSeconds: 180 },
        ] })),
      observations: Array.from({ length: count }, (_, p) => ({ processId: `process-${p}`, nodeId: `approve-${p}`,
        samples: 40, queueSeconds: 1000, incompleteEvidenceCount: 30, repeatedInterpretationSeconds: 500,
        repairHumanSeconds: 100, externalWaitSeconds: 20, evidenceRefs: [ref(15)] })),
      obligations: [{ id: "pending-payment", workId: id(16), meaningDigest: "original-meaning", termsDigest: "terms-1",
        deadline: end, reservationRef: ref(17, "S5"), consumedMinor: 250, unresolvedMinor: 1000, currency: "USD",
        accountableRoleId: "approver", processId: "process-0", nodeId: "approve-0", state: "UNKNOWN",
        effectRefs: [ref(18, "S6")], dependencyRefs: [ref(19)], attempts: 2 }] } };
}
const input = fixture();
await writeFile(resolve(output, "original.json"), JSON.stringify(input, null, 2) + "\n", { flag: "wx" });
let passed = false;
try {
  const program = constructOrganizationTransformation(input);
  assert.equal(checkOrganizationTransformation(input, program).status, "CHECKED");
  assert(program.alternatives.some((a: any) => a.kind === "RETAIN"));
  const changed = program.alternatives.find((a: any) => a.kind === "PREPARED_HANDOFF");
  assert(changed, "measured incomplete evidence must construct a prepared-handoff graph");
  const process = changed.processes[0]; assert(process);
  const nodes = process.nodes;
  assert(nodes.length > input.organization.processes[0].nodes.length);
  assert(nodes.some((n: any) => n.id === "approve-0" && n.mandatory && n.roleId === "approver"));
  const approver = nodes.find(n => n.id === "approve-0"); assert(approver);
  assert(approver.after.some((key: string) =>
    nodes.find((n: any) => n.id === key)?.kind === "EVIDENCE_GATE"));
  steps.push({ case: "W041/W042", status: "PASS", alternatives: program.alternatives.length });
  for (const family of ["PROCUREMENT", "ONBOARDING", "CLOSE_READINESS", "GROWTH_STRAIN", "IT_INCIDENT"]) {
    assert.equal(checkOrganizationTransformation(fixture(family), constructOrganizationTransformation(fixture(family))).status, "CHECKED");
  }
  const bypass = structuredClone(program);
  const bypassProcess = bypass.alternatives.find(a => a.id === changed.id)?.processes[0]; assert(bypassProcess);
  bypassProcess.nodes = nodes.filter((n: any) => n.id !== "approve-0");
  assert.equal(checkOrganizationTransformation(input, bypass).status, "REJECTED");
  const hidden = structuredClone(program);
  const hiddenRole = hidden.alternatives.find(a => a.id === changed.id)?.roles[0]; assert(hiddenRole);
  hiddenRole.availableSeconds = 999999;
  assert.equal(checkOrganizationTransformation(input, hidden).status, "REJECTED");
  steps.push({ case: "W042/W043", status: "PASS", mutations: ["removed-approval", "invented-capacity"] });
  const external = fixture();
  external.organization.observations[0].externalWaitSeconds = 10000;
  external.organization.observations[0].incompleteEvidenceCount = 0;
  external.organization.observations[0].repeatedInterpretationSeconds = 0;
  assert.equal(constructOrganizationTransformation(external).recommendedAlternativeId, "retain");
  const selected = applyTransformationDecision(program, { kind: "SELECT", alternativeId: changed.id, principalId: input.principalId, at });
  assert.equal(selected.status, "AWAITING_ADOPTION");
  const noConsent = planObligationBridge(input, selected, input.organization.obligations, "FORWARD");
  assert.equal(noConsent.status, "BLOCKED");
  let adopted = selected;
  for (const role of changed.roles) adopted = applyTransformationDecision(adopted, { kind: "ADOPT",
    alternativeId: changed.id, roleId: role.id, termsDigest: organizationDigest({ alternativeId: changed.id, role }),
    principalId: role.principalId, at });
  assert.equal(adopted.status, "ADOPTED");
  const forward = planObligationBridge(input, adopted, input.organization.obligations, "FORWARD");
  assert.equal(forward.status, "READY");
  assert.deepEqual(forward.obligations[0], input.organization.obligations[0]);
  const unknownMoney = fixture();
  unknownMoney.organization.obligations[0].consumedMinor = null;
  unknownMoney.organization.obligations[0].unresolvedMinor = null;
  unknownMoney.organization.obligations[0].currency = null;
  await writeFile(resolve(output, "original-unknown-money.json"), JSON.stringify(unknownMoney, null, 2) + "\n", { flag: "wx" });
  let unknownProgram = constructOrganizationTransformation(unknownMoney);
  const unknownAlternative = unknownProgram.alternatives.find(a => a.kind === "PREPARED_HANDOFF"); assert(unknownAlternative);
  unknownProgram = applyTransformationDecision(unknownProgram, { kind: "SELECT", alternativeId: unknownAlternative.id,
    principalId: unknownMoney.principalId, at });
  for (const role of unknownAlternative.roles) unknownProgram = applyTransformationDecision(unknownProgram, { kind: "ADOPT",
    alternativeId: unknownAlternative.id, roleId: role.id, principalId: role.principalId,
    termsDigest: organizationDigest({ alternativeId: unknownAlternative.id, role }), at });
  const unknownBridge = planObligationBridge(unknownMoney, unknownProgram, unknownMoney.organization.obligations, "FORWARD");
  assert.equal(unknownBridge.status, "READY", "UNKNOWN monetary liabilities must be representable without a fabricated zero");
  assert.equal(unknownBridge.obligations[0]?.consumedMinor, null);
  assert.equal(unknownBridge.obligations[0]?.unresolvedMinor, null);
  assert.equal(unknownBridge.obligations[0]?.currency, null);
  const inventedZero = structuredClone(unknownMoney.organization.obligations);
  inventedZero[0].consumedMinor = 0; inventedZero[0].unresolvedMinor = 0;
  assert.equal(planObligationBridge(unknownMoney, unknownProgram, inventedZero, "FORWARD").status, "BLOCKED",
    "absence of a monetary observation must not turn UNKNOWN into zero");
  steps.push({ case: "W045-canonical-UNKNOWN-money-contract", status: "PASS", consumedMinor: null,
    unresolvedMinor: null, currency: null, attemptsConvertedToMoney: false });
  const constrained = fixture();
  constrained.organization.resourceConstraints = [{
    schema: "finnor.organization-native-resource-constraint.v1", id: id(30),
    reservationRef: ref(30, "S5"), certificateRef: ref(31, "S5"), problemRef: ref(32, "S5"),
    nativeProblemDigest: "b".repeat(64), originalDeadline: end,
    canonicalRoots: [{ entityType: "COMPANY", entityId: constrained.companyId }], originalWorks: [],
    originalResourceEnvelope: [{ resourceId: "original-capacity", unit: "request", kind: "CUMULATIVE_EXPENDITURE",
      horizon: { startAt: at, periodMs: 86400000, periods: 1 }, quantities: ["10", "0"], minimumQuantities: ["10", "0"] }],
    reservationRevision: 2, reservationStatus: "UNKNOWN_OUTCOME", revocationReason: null,
    consumptions: [{ ref: ref(33, "S5"), status: "UNKNOWN_OUTCOME", effectRef: null }],
    monetaryExposure: { consumedMinor: null, unresolvedMinor: null, currency: null },
    retention: "EXISTING_S5_OWNER_CONSTRAINT_NOT_NEW_WORK_OR_RESOURCE_GRANT",
  }];
  await writeFile(resolve(output, "original-non-s6-resource-constraint.json"), JSON.stringify(constrained, null, 2) + "\n", { flag: "wx" });
  let constrainedProgram = constructOrganizationTransformation(constrained);
  assert.equal(checkOrganizationTransformation(constrained, constrainedProgram).status, "CHECKED");
  assert.deepEqual(constrainedProgram.originalResourceConstraints, constrained.organization.resourceConstraints);
  const constrainedAlternative = constrainedProgram.alternatives.find(a => a.kind === "PREPARED_HANDOFF");
  assert(constrainedAlternative);
  constrainedProgram = applyTransformationDecision(constrainedProgram, { kind: "SELECT", alternativeId: constrainedAlternative.id,
    principalId: constrained.principalId, at });
  for (const role of constrainedAlternative.roles) constrainedProgram = applyTransformationDecision(constrainedProgram, { kind: "ADOPT",
    alternativeId: constrainedAlternative.id, roleId: role.id, principalId: role.principalId,
    termsDigest: organizationDigest({ alternativeId: constrainedAlternative.id, role }), at });
  const constraintBridge = planObligationBridge(constrained, constrainedProgram, constrained.organization.obligations,
    "FORWARD", constrained.organization.resourceConstraints);
  assert.equal(constraintBridge.status, "READY");
  assert.deepEqual(constraintBridge.resourceConstraints, constrained.organization.resourceConstraints);
  assert.deepEqual(constraintBridge.resourceConstraints[0]?.originalWorks, [], "a pure company hold must not acquire a fictitious Work");
  assert.equal(constraintBridge.resourceConstraints[0]?.monetaryExposure.consumedMinor, null);
  assert.equal(planObligationBridge(constrained, constrainedProgram, constrained.organization.obligations, "FORWARD", []).status,
    "BLOCKED", "an original native hold must not disappear at migration");
  for (const change of ["envelope", "deadline", "meaning", "consumption", "revision"] as const) {
    const corrupted = structuredClone(constrained.organization.resourceConstraints);
    if (change === "envelope") corrupted[0].originalResourceEnvelope[0].quantities[0] = "0";
    if (change === "deadline") corrupted[0].originalDeadline = "2030-01-09T00:00:00.000Z";
    if (change === "meaning") corrupted[0].nativeProblemDigest = "c".repeat(64);
    if (change === "consumption") corrupted[0].consumptions = [];
    if (change === "revision") corrupted[0].reservationRevision = 1;
    assert.equal(planObligationBridge(constrained, constrainedProgram, constrained.organization.obligations, "ROLLBACK", corrupted).status,
      "BLOCKED", "rollback must preserve the original native resource constraint: " + change);
  }
  const forgedConstraintProgram = structuredClone(constrainedProgram);
  forgedConstraintProgram.originalResourceConstraints = [];
  assert.equal(checkOrganizationTransformation(constrained, forgedConstraintProgram).status, "REJECTED");
  assert.equal(planObligationBridge(constrained, constrainedProgram, constrained.organization.obligations,
    "ROLLBACK", constrained.organization.resourceConstraints).status, "READY");
  steps.push({ case: "W045-native-S5-constraint-domain-contract", status: "PASS",
    nativeObserved: false, pureCompanyOriginalWorkCount: 0, originalOwnerConstraintRetained: true,
    newWorkOrGrantCreated: false, resourcesReleased: false, monetaryEvidenceInferred: false });
  const linked = structuredClone(constrained), linkedConstraint = linked.organization.resourceConstraints[0];
  linkedConstraint.originalWorks = [{ workId: id(16), initialMeaningDigest: "d".repeat(64) }];
  const owner = { owner: "P1", id: id(34), parentId: null, workId: id(16), workInputId: id(35),
    workInputDigest: "a".repeat(64), requestDigest: "b".repeat(64), originalTermsDigest: "c".repeat(64),
    originalDeadline: end, originalLimits: { maxAttempts: 4, maxSteps: 1024, maxCandidates: 8, maxDepth: 12 },
    observedCounters: { attemptsUsed: 2, stepsUsed: 40, candidatesUsed: 2 }, generation: 1, status: "WAITING",
    currentNativeStateDigest: "a".repeat(64), physicalAttempts: [],
    physicalAttemptCoverage: "NOT_A_P2_PHYSICAL_ATTEMPT_METER",
    counterAccounting: "ORIGINAL_NATIVE_COUNTERS_NOT_ADDITIVE_MONEY" };
  linkedConstraint.nativeOwners = [owner, { ...owner, owner: "P2", id: id(36), parentId: id(34),
    originalLimits: { maxUnits: 8, maxParallel: 2 }, observedCounters: { physicalAttempts: 1, "nativeGrantSpent:original-capacity": 2 },
    physicalAttemptCoverage: "P2_NATIVE_ATTEMPT_ROWS_NOT_PROVIDER_BILLING",
    physicalAttempts: [{ id: id(37), unitId: id(38), deliveryId: id(39), claimFence: 1,
      status: "UNKNOWN", preimageDigest: "e".repeat(64) }] }];
  await writeFile(resolve(output, "original-owner-linked-resource-constraint.json"), JSON.stringify(linked, null, 2) + "\n", { flag: "wx" });
  let linkedProgram = constructOrganizationTransformation(linked);
  const linkedAlternative = linkedProgram.alternatives.find(a => a.kind === "PREPARED_HANDOFF"); assert(linkedAlternative);
  linkedProgram = applyTransformationDecision(linkedProgram, { kind: "SELECT", alternativeId: linkedAlternative.id, principalId: linked.principalId, at });
  for (const role of linkedAlternative.roles) linkedProgram = applyTransformationDecision(linkedProgram, { kind: "ADOPT",
    alternativeId: linkedAlternative.id, roleId: role.id, principalId: role.principalId,
    termsDigest: organizationDigest({ alternativeId: linkedAlternative.id, role }), at });
  assert.equal(planObligationBridge(linked, linkedProgram, linked.organization.obligations, "FORWARD",
    linked.organization.resourceConstraints).status, "READY");
  for (const change of ["request", "limits", "input", "counter", "parent", "attempt", "work"] as const) {
    const corrupted = structuredClone(linked.organization.resourceConstraints);
    if (change === "request") corrupted[0].nativeOwners[0].requestDigest = "f".repeat(64);
    if (change === "limits") corrupted[0].nativeOwners[0].originalLimits.maxAttempts++;
    if (change === "input") corrupted[0].nativeOwners[0].workInputDigest = "f".repeat(64);
    if (change === "counter") corrupted[0].nativeOwners[0].observedCounters.attemptsUsed--;
    if (change === "parent") corrupted[0].nativeOwners[1].parentId = id(40);
    if (change === "attempt") corrupted[0].nativeOwners[1].physicalAttempts = [];
    if (change === "work") corrupted[0].originalWorks = [];
    const rejected = change === "work" ? () => planObligationBridge(linked, linkedProgram, linked.organization.obligations,
      "ROLLBACK", corrupted) : null;
    if (rejected) assert.throws(rejected);
    else assert.equal(planObligationBridge(linked, linkedProgram, linked.organization.obligations, "ROLLBACK", corrupted).status,
      "BLOCKED", "native owner identity/counters/attempts must be retained: " + change);
  }
  const progressed = structuredClone(linked.organization.resourceConstraints);
  progressed[0].nativeOwners[0].observedCounters.attemptsUsed++;
  progressed[0].nativeOwners[1].physicalAttempts[0].status = "COMPLETED";
  progressed[0].nativeOwners[1].physicalAttempts[0].preimageDigest = "f".repeat(64);
  assert.equal(planObligationBridge(linked, linkedProgram, linked.organization.obligations, "ROLLBACK", progressed).status, "READY",
    "a genuine native owner's counter/status progress must not reset its immutable original terms");
  steps.push({ case: "W045-P1-P2-owner-binding-domain-contract", status: "PASS", nativeObserved: false,
    countersConvertedToMoney: false, originalWorkInputAndGrantRetained: true, unknownPhysicalAttemptIdentityRetained: true });
  const gate = nodes.find(n => n.kind === "EVIDENCE_GATE"); assert(gate);
  const live = [...input.organization.obligations, { ...input.organization.obligations[0], id: "new-customer",
    termsDigest: "new-terms", state: "ACCEPTED", nodeId: gate.id }];
  const rollback = planObligationBridge(input, adopted, live, "ROLLBACK");
  assert.equal(rollback.status, "BLOCKED", "rollback must not erase accepted work with no old destination");
  const changedTerms = structuredClone(input.organization.obligations);
  changedTerms[0].termsDigest = "terms-2";
  assert.equal(planObligationBridge(input, adopted, changedTerms, "FORWARD").status, "BLOCKED");
  steps.push({ case: "W044/W045/W046", status: "PASS", forward, rollback });
  const declined = applyTransformationDecision(selected, { kind: "DECLINE", alternativeId: changed.id,
    roleId: "support", principalId: id(2), at });
  assert.equal(declined.status, "PARTIAL");
  assert.throws(() => applyTransformationDecision(selected, { kind: "ADOPT", alternativeId: changed.id,
    roleId: "support", termsDigest: "wrong", principalId: input.principalId, at }));
  assert.equal(qualifyOperatingBenefit(input, { observations: [], assistance: [], completeCosts: false,
    sourceClass: "CONTROLLED", assignmentVerified: false }).status, "UNIDENTIFIED");
  const patch = qualifyOperatingBenefit(input, { observations: [], assistance: ["task-specific-builder-patch"],
    completeCosts: false, sourceClass: "CONTROLLED", assignmentVerified: false });
  assert.equal(patch.autonomous, false);
  steps.push({ case: "W046/W047-gating/W048", status: "PASS" });
  await writeFile(resolve(output, "program.json"), JSON.stringify(program, null, 2) + "\n", { flag: "wx" });
  passed = true;
} finally {
  const report = { schema: "finnor.w5.domain-e2e-evidence.v1", status: passed ? "PASS" : "FAILED_RETAINED",
    inputDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex"), steps,
    elapsedMs: performance.now() - started, runtime: process.version, qualification: "CONTROLLED_DOMAIN_NOT_NATIVE_OR_FIELD",
    rerun: `node --import tsx ${import.meta.filename} /absolute/new/evidence-directory` };
  await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(report));
}

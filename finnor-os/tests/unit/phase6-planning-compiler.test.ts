import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  buildConstraintSet,
  buildGoalSpec,
  buildPlanningWorldSnapshot,
  compileAndSelectPlans,
  DEFAULT_PLAN_BUDGETS,
  planNodeSemanticHash,
  sha256,
  type CandidateCompilationFacts,
  type CandidatePlan,
  type CandidatePlanNode,
  type ConstraintSet,
  type NodeCompilationFacts,
  type PlanningWorldSnapshot,
} from "@finnor/planning";

const TENANT_ID = "00000000-0000-4000-8000-000000000601";
const WORK_ID = "00000000-0000-4000-8000-000000000602";
const INPUT_ID = "00000000-0000-4000-8000-000000000603";
const ATTEMPT_ID = "00000000-0000-4000-8000-000000000604";

const goal = buildGoalSpec({
  objective: "Prove the current Work state.",
  workId: WORK_ID,
  workInputId: INPUT_ID,
  deadline: "2030-01-02T00:00:00.000Z",
  successCondition: {
    version: 1,
    statement: "The current Work is visible.",
    mode: "all",
    source: "explicit",
    criteria: [{ kind: "canonical_query", request: { intent: "work_list", recordId: WORK_ID }, assertion: { path: ["rows"], operator: "exists" } }],
  },
});
const criterionId = goal.criteria[0]!.id;

function capability(capabilityName: string, kind: "query" | "action" | "wait" | "check", irreversible = false) {
  return {
    capability: capabilityName,
    kind,
    modelProposable: true,
    available: true,
    health: "available" as const,
    risk: irreversible ? "high" as const : "low" as const,
    irreversible,
    requiredReferences: [],
    effectClass: irreversible ? "external_side_effect" : null,
    observationStrategy: kind === "query" ? "operational_query" as const : kind === "action" ? "business_effect" as const : kind === "wait" ? "integration_event" as const : "objective_success" as const,
    reversibility: kind === "query" ? "read_only" as const : irreversible ? "irreversible" as const : "reversible" as const,
    supportedRecoveryModes: ["retry", "replan", "recover", "escalate"] as Array<"retry" | "replan" | "recover" | "escalate">,
    externalSideEffect: irreversible,
    authorityRequirement: kind === "query" ? "query" as const : kind === "check" ? "human_attestation" as const : "policy" as const,
  };
}

function constraints(overrides: Partial<ConstraintSet["budgets"]> = {}, humanOnlyCapabilities: string[] = []): ConstraintSet {
  return buildConstraintSet({
    tenantId: TENANT_ID,
    verticalKey: "none",
    allowedCapabilities: ["query:work_list", "send_message", "wait:event", "check:objective_success"],
    humanOnlyCapabilities,
    prohibitedCapabilities: [],
    authorityRevision: 9,
    budgets: { ...DEFAULT_PLAN_BUDGETS, ...overrides },
    constraints: [],
    deadlineAt: "2030-01-02T00:00:00.000Z",
    softPreferences: [],
  });
}

function snapshot(overrides: Partial<PlanningWorldSnapshot> = {}): PlanningWorldSnapshot {
  return buildPlanningWorldSnapshot({
    workId: WORK_ID,
    workInputId: INPUT_ID,
    plannerAttemptId: ATTEMPT_ID,
    tenantId: TENANT_ID,
    verticalKey: "none",
    capturedAt: "2030-01-01T00:00:00.000Z",
    decisionContextHash: sha256({ work: WORK_ID }),
    canonicalStateHash: sha256({ status: "executing" }),
    work: { id: WORK_ID, status: "executing", inputId: INPUT_ID },
    interactionContextRef: null,
    canonicalEntities: [],
    canonicalVersions: [],
    activeObjective: null,
    completedEffects: [],
    outstandingEffects: [],
    policyRefs: [],
    evidenceRefs: [],
    epistemicWarnings: [],
    sourceRefs: [],
    authority: { employeeId: null, revision: 9, roles: ["owner"] },
    capabilities: [
      capability("query:work_list", "query"),
      capability("send_message", "action", true),
      capability("wait:event", "wait"),
      capability("check:objective_success", "check"),
    ],
    currentEffects: [],
    sourceHealth: { status: "complete", missing: [] },
    ...overrides,
  });
}

function queryCandidate(candidateKey = "query", nodeKey = "read", checkKey = "verify", reversed = false): CandidatePlan {
  const query: CandidatePlanNode = { key: nodeKey, kind: "query", request: { intent: "work_list", recordId: WORK_ID }, supports: [criterionId], rationale: "prose may change" };
  const check: CandidatePlanNode = { key: checkKey, kind: "check", criterionId, dependsOn: [nodeKey], observation: { source: "current Work" } };
  return { version: 1, candidateKey, nodes: reversed ? [check, query] : [query, check], rationale: "candidate prose" };
}

function actionCandidate(candidateKey = "action"): CandidatePlan {
  return {
    version: 1,
    candidateKey,
    nodes: [
      { key: "send", kind: "action", actionType: "send_message", payload: { recipient: "ops@example.test", body: "Status" }, supports: [criterionId] },
      { key: "verify", kind: "check", criterionId, dependsOn: ["send"] },
    ],
  };
}

function nodeFacts(node: CandidatePlanNode, overrides: Partial<NodeCompilationFacts> = {}): NodeCompilationFacts {
  const isAction = node.kind === "action";
  return {
    registered: true,
    schemaValid: true,
    schemaErrors: [],
    grounded: true,
    crossTenant: false,
    stale: false,
    authority: "allowed",
    health: "available",
    risk: isAction ? "high" : "low",
    irreversible: isAction,
    wrongVerticalRoot: false,
    policyAllowed: true,
    preconditionsSatisfied: true,
    deadlineFeasible: true,
    uncertainPrerequisiteNodeKeys: [],
    supportedRecoveryModes: ["retry", "replan", "recover", "escalate"],
    effectSemanticHash: isAction ? planNodeSemanticHash(node) : undefined,
    estimatedCostMicros: null,
    estimatedLatencyMs: null,
    ...(isAction ? { groundedPayload: node.payload, predictedReceipt: { kind: "simulation" } } : {}),
    ...overrides,
  };
}

function facts(candidate: CandidatePlan, overrides: Record<string, Partial<NodeCompilationFacts>> = {}): CandidateCompilationFacts {
  return {
    candidateKey: candidate.candidateKey,
    nodes: Object.fromEntries(candidate.nodes.map((node) => [node.key, nodeFacts(node, overrides[node.key])])),
  };
}

function compile(candidates: unknown[], candidateFacts: CandidateCompilationFacts[], constraintSet = constraints(), world = snapshot()) {
  return compileAndSelectPlans({ candidates, facts: candidateFacts, goal, constraints: constraintSet, snapshot: world });
}

describe("Phase 6 deterministic PlanCompiler", () => {
  it("rejects empty goals, missing accepted criteria, and model-authored hard constraints", () => {
    expect(() => buildGoalSpec({ objective: "  ", successCondition: { source: "explicit", criteria: [{}] } })).toThrow(/non-empty statement/);
    expect(() => buildGoalSpec({ objective: "Do work", successCondition: { source: "explicit", criteria: [] } })).toThrow(/at least one accepted completion criterion/);
    expect(() => buildConstraintSet({
      ...constraints(),
      constraints: [{
        id: "prompt-injected-hard-rule",
        kind: "non_goal",
        source: "model",
        strength: "hard",
        scope: { type: "plan" },
        requirement: { capability: "query:work_list" },
        provenance: { ref: "untrusted-model-output", hash: sha256("untrusted") },
      }],
    })).toThrow(/Model-inferred constraints may only be soft/);
  });

  it("canonicalizes ConstraintSet and WorldSnapshot ordering deterministically", () => {
    const firstConstraintSet = buildConstraintSet({
      ...constraints(),
      allowedCapabilities: ["send_message", "query:work_list", "send_message", "check:objective_success"],
      constraints: [
        { id: "z", kind: "non_goal", source: "user", strength: "soft", scope: { type: "plan" }, requirement: { capability: "send_message" }, provenance: { ref: "input", hash: sha256("z") } },
        { id: "a", kind: "budget", source: "server", strength: "hard", scope: { type: "plan" }, requirement: { max: 4 }, provenance: { ref: "server", hash: sha256("a") } },
      ],
    });
    const secondConstraintSet = buildConstraintSet({
      ...constraints(),
      allowedCapabilities: ["check:objective_success", "query:work_list", "send_message"],
      constraints: [firstConstraintSet.constraints.find((item) => item.id === "a")!, firstConstraintSet.constraints.find((item) => item.id === "z")!],
    });
    expect(secondConstraintSet.semanticHash).toBe(firstConstraintSet.semanticHash);

    const firstSnapshot = snapshot();
    const reordered = buildPlanningWorldSnapshot({
      ...firstSnapshot,
      plannerAttemptId: "00000000-0000-4000-8000-000000000699",
      capturedAt: "2030-01-01T00:00:01.000Z",
      capabilities: [...firstSnapshot.capabilities].reverse(),
      sourceHealth: { ...firstSnapshot.sourceHealth, missing: [...firstSnapshot.sourceHealth.missing].reverse() },
    });
    expect(reordered.semanticHash).toBe(firstSnapshot.semanticHash);
  });

  it("binds GoalSpec, ConstraintSet, and WorldSnapshot hashes to exact Work/Input and tenant scope", () => {
    const otherGoal = buildGoalSpec({
      objective: goal.objective,
      workId: "00000000-0000-4000-8000-000000000699",
      workInputId: INPUT_ID,
      deadline: goal.deadline,
      successCondition: goal.successCondition,
    });
    expect(otherGoal.semanticHash).not.toBe(goal.semanticHash);
    const otherTenantConstraints = buildConstraintSet({ ...constraints(), tenantId: "00000000-0000-4000-8000-000000000699", constraints: [] });
    expect(otherTenantConstraints.semanticHash).not.toBe(constraints().semanticHash);
    const otherTenantSnapshot = buildPlanningWorldSnapshot({ ...snapshot(), tenantId: "00000000-0000-4000-8000-000000000699" });
    expect(otherTenantSnapshot.semanticHash).not.toBe(snapshot().semanticHash);
  });

  it("accepts a causally complete query graph and emits explicit stable edges", () => {
    const candidate = queryCandidate();
    const result = compile([candidate], [facts(candidate)]);
    expect(result.selected?.candidateKey).toBe("query");
    expect(result.selected?.graph?.nodes).toHaveLength(2);
    expect(result.selected?.graph?.edges).toHaveLength(1);
    expect(result.selected?.graph?.completionCoverage).toEqual([{ criterionId, checkNodeId: expect.stringMatching(/^node_/) }]);
  });

  it("selects by deterministic risk/side-effect score, never provider order", () => {
    const read = queryCandidate("read");
    const write = actionCandidate("write");
    for (const ordered of [[write, read], [read, write]]) {
      const result = compile(ordered, ordered.map((candidate) => facts(candidate)));
      expect(result.selected?.candidateKey).toBe("read");
      expect(result.selected?.score.sideEffectCount).toBe(0);
    }
  });

  it("uses a stable semantic hash tie-break and refuses a model-declared winner field", () => {
    const left = queryCandidate("left", "left-read", "left-check");
    left.nodes[0] = { ...left.nodes[0]!, request: { intent: "work_list", recordId: WORK_ID, projection: "left" } } as CandidatePlanNode;
    const right = queryCandidate("right", "right-read", "right-check");
    right.nodes[0] = { ...right.nodes[0]!, request: { intent: "work_list", recordId: WORK_ID, projection: "right" } } as CandidatePlanNode;
    const forward = compile([left, right], [facts(left), facts(right)]);
    const reverse = compile([right, left], [facts(right), facts(left)]);
    expect(reverse.selected?.candidateSemanticHash).toBe(forward.selected?.candidateSemanticHash);
    expect(forward.selected?.score.semanticHash).toBe([
      ...forward.candidates.filter((entry) => entry.accepted).map((entry) => entry.score.semanticHash),
    ].sort()[0]);

    const forged = { ...queryCandidate("forged"), selected: true };
    const rejected = compile([forged], [facts(forged as CandidatePlan)]);
    expect(rejected.selected).toBeNull();
    expect(rejected.candidates[0]!.violations.map((item) => item.code)).toContain("CANDIDATE_SCHEMA_INVALID");
  });

  it("rejects ungrounded goal targets and duplicate consequential effects", () => {
    const targetedGoal = buildGoalSpec({
      objective: goal.objective,
      workId: WORK_ID,
      workInputId: INPUT_ID,
      targets: [{ kind: "entity", type: "deal", id: "00000000-0000-4000-8000-000000000699", sourceRef: "deal:missing" }],
      successCondition: goal.successCondition,
    });
    const query = queryCandidate("targeted");
    const targetResult = compileAndSelectPlans({ candidates: [query], facts: [facts(query)], goal: targetedGoal, constraints: constraints(), snapshot: snapshot() });
    expect(targetResult.selected).toBeNull();
    expect(targetResult.candidates[0]!.violations.map((item) => item.code)).toContain("GOAL_TARGET_UNGROUNDED");

    const duplicate = actionCandidate("duplicate-effects");
    duplicate.nodes.splice(1, 0, { key: "send-again", kind: "action", actionType: "send_message", payload: { recipient: "ops@example.test", body: "Status" }, supports: [criterionId] });
    duplicate.nodes[2]!.dependsOn = ["send", "send-again"];
    const duplicateResult = compile([duplicate], [facts(duplicate)]);
    expect(duplicateResult.selected).toBeNull();
    expect(duplicateResult.candidates[0]!.violations.map((item) => item.code)).toContain("DUPLICATE_CONSEQUENTIAL_EFFECT");
  });

  it("keeps semantic identity invariant under labels, rationale, and row order", () => {
    fc.assert(fc.property(fc.boolean(), fc.string({ maxLength: 80 }), (reversed, rationale) => {
      const first = queryCandidate("provider-label-a", "q_a", "c_a", false);
      const second = queryCandidate("completely-different-label", "renamed_query", "renamed_check", reversed);
      second.rationale = rationale || undefined;
      second.nodes.forEach((node) => { node.rationale = rationale || undefined; });
      const left = compile([first], [facts(first)]).selected!;
      const right = compile([second], [facts(second)]).selected!;
      expect(right.candidateSemanticHash).toBe(left.candidateSemanticHash);
      expect(right.graph?.semanticHash).toBe(left.graph?.semanticHash);
    }), { numRuns: 100 });
  });

  it.each([
    ["UNKNOWN_CAPABILITY", { registered: false }],
    ["PAYLOAD_SCHEMA_INVALID", { schemaValid: false, schemaErrors: ["bad payload"] }],
    ["UNGROUNDED_REFERENCE", { grounded: false }],
    ["CROSS_TENANT_REFERENCE", { crossTenant: true }],
    ["STALE_GROUNDING", { stale: true }],
    ["WRONG_VERTICAL_ROOT", { wrongVerticalRoot: true }],
    ["POLICY_CONFLICT", { policyAllowed: false }],
    ["PRECONDITION_UNSATISFIED", { preconditionsSatisfied: false }],
    ["AUTHORITY_DENIED", { authority: "denied" as const }],
    ["INTEGRATION_UNAVAILABLE", { health: "unavailable" as const }],
  ])("rejects hard execution-readiness failure %s", (code, override) => {
    const candidate = actionCandidate();
    const result = compile([candidate], [facts(candidate, { send: override })]);
    expect(result.selected).toBeNull();
    expect(result.candidates[0]!.violations.map((item) => item.code)).toContain(code);
  });

  it("rejects model-proposed human-only capabilities deterministically", () => {
    const candidate = actionCandidate();
    candidate.nodes[0] = { key: "send", kind: "action", actionType: "finalize_ic_decision", payload: {}, supports: [criterionId] };
    const result = compile([candidate], [facts(candidate)], buildConstraintSet({
      ...constraints(),
      allowedCapabilities: ["check:objective_success"],
      humanOnlyCapabilities: ["finalize_ic_decision"],
      constraints: [],
    }));
    expect(result.candidates[0]!.violations.map((item) => item.code)).toContain("HUMAN_ONLY_CAPABILITY");
  });

  it("rejects cycles, unknown dependencies, and orphaned consequential work", () => {
    const cyclic = queryCandidate();
    cyclic.nodes[0]!.dependsOn = ["verify"];
    const cycleResult = compile([cyclic], [facts(cyclic)]);
    expect(cycleResult.candidates[0]!.violations.map((item) => item.code)).toContain("DEPENDENCY_CYCLE");

    const unknown = queryCandidate("unknown");
    unknown.nodes[1]!.dependsOn = ["missing"];
    const unknownResult = compile([unknown], [facts(unknown)]);
    expect(unknownResult.candidates[0]!.violations.map((item) => item.code)).toContain("DEPENDENCY_UNKNOWN");

    const orphan = queryCandidate("orphan");
    orphan.nodes[1]!.dependsOn = [];
    const orphanResult = compile([orphan], [facts(orphan)]);
    expect(orphanResult.candidates[0]!.violations.map((item) => item.code)).toContain("COMPLETION_COVERAGE_MISSING");
  });

  it("rejects budget overflow, weak unbounded waits, and expired deadlines", () => {
    const candidate = queryCandidate();
    expect(compile([candidate], [facts(candidate)], constraints({ maxQueries: 0 })).candidates[0]!.violations.map((item) => item.code)).toContain("QUERY_BUDGET_EXCEEDED");

    const wait: CandidatePlan = {
      version: 1,
      candidateKey: "wait",
      nodes: [
        { key: "wait", kind: "wait", waitFor: { eventType: "something.happened" }, supports: [criterionId] },
        { key: "check", kind: "check", criterionId, dependsOn: ["wait"] },
      ],
    };
    expect(compile([wait], [facts(wait)]).candidates[0]!.violations.map((item) => item.code)).toContain("WAIT_CORRELATION_WEAK");

    const expired = snapshot({ capturedAt: "2031-01-01T00:00:00.000Z" });
    expect(compile([candidate], [facts(candidate)], constraints(), expired).candidates[0]!.violations.map((item) => item.code)).toContain("GOAL_DEADLINE_INVALID");
  });

  it("rejects unsupported recovery and irreversible work before uncertain observation", () => {
    const candidate = actionCandidate();
    const action = candidate.nodes[0]!;
    action.preconditions = [{ kind: "observation_satisfied", ref: "unobserved", requirement: { state: "known" }, certainty: "uncertain" }];
    action.recovery = { version: 1, on: ["failure"], mode: "compensate", maxAttempts: 1, neverReplayVerifiedIrreversibleEffect: true };
    const result = compile([candidate], [facts(candidate, { send: { supportedRecoveryModes: ["escalate"] } })]);
    const codes = result.candidates[0]!.violations.map((item) => item.code);
    expect(codes).toContain("UNSUPPORTED_RECOVERY");
    expect(codes).toContain("IRREVERSIBLE_BEFORE_UNCERTAIN_PREREQUISITE");
  });

  it("never selects a verified irreversible effect for replay", () => {
    const candidate = actionCandidate();
    const action = candidate.nodes[0]!;
    const effectHash = planNodeSemanticHash(action);
    const world = snapshot({
      currentEffects: [{ semanticHash: effectHash, status: "verified", irreversible: true }],
      completedEffects: [{ semanticHash: effectHash, irreversible: true, evidenceRef: "business_effect:verified" }],
    });
    const result = compile([candidate], [facts(candidate)], constraints(), world);
    expect(result.selected).toBeNull();
    expect(result.candidates[0]!.violations.map((item) => item.code)).toContain("VERIFIED_IRREVERSIBLE_REPLAY");
  });

  it("rejects duplicate candidate keys and a candidate envelope over the hard budget", () => {
    const one = queryCandidate("duplicate");
    const two = queryCandidate("duplicate", "read2", "check2");
    const duplicate = compile([one, two], [facts(one), facts(two)]);
    expect(duplicate.selected).toBeNull();
    expect(duplicate.candidates.every((candidate) => candidate.violations.some((item) => item.code === "CANDIDATE_KEY_DUPLICATE"))).toBe(true);

    const many = Array.from({ length: 5 }, (_, index) => queryCandidate(`candidate-${index}`, `read-${index}`, `check-${index}`));
    const overflow = compile(many, many.map((candidate) => facts(candidate)));
    expect(overflow.selected).toBeNull();
    expect(overflow.candidates.every((candidate) => candidate.violations.some((item) => item.code === "CANDIDATE_BUDGET_EXCEEDED"))).toBe(true);
  });

  it("retains unknown cost and latency instead of accepting model estimates", () => {
    const candidate = queryCandidate();
    const selected = compile([candidate], [facts(candidate)]).selected!;
    expect(selected.score.estimatedCostMicros).toBeNull();
    expect(selected.score.estimatedLatencyMs).toBeNull();
  });
});

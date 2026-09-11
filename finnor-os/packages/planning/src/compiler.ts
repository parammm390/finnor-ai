import { byteLength, sha256 } from "./canonical";
import { CandidatePlanSchema } from "./contracts";
import type {
  CandidateCompilationFacts,
  CandidatePlan,
  CandidatePlanNode,
  CompiledCandidate,
  ConstraintSet,
  GoalSpec,
  NodeCompilationFacts,
  ObservationSpec,
  PlanActionNode,
  PlanCompilationResult,
  PlanGraph,
  PlanNode,
  PlanScoreVector,
  PlanViolation,
  PlanViolationCode,
  PlanningWorldSnapshot,
  RecoverySpec,
} from "./contracts";

function violation(candidateKey: string, code: PlanViolationCode, message: string, nodeKey?: string, path?: string): PlanViolation {
  return { candidateKey, code, message, ...(nodeKey ? { nodeKey } : {}), ...(path ? { path } : {}) };
}

function capability(node: CandidatePlanNode): string {
  if (node.kind === "action") return node.actionType;
  if (node.kind === "query") return `query:${String(node.request.intent ?? "")}`;
  if (node.kind === "wait") return "wait:event";
  return "check:objective_success";
}

function nodeSemanticProjection(node: CandidatePlanNode): Record<string, unknown> {
  const common = {
    kind: node.kind,
    supports: [...(node.supports ?? [])].sort(),
    preconditions: [...(node.preconditions ?? [])].sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`)),
    expectedEffects: [...(node.expectedEffects ?? [])].sort((a, b) => sha256(a).localeCompare(sha256(b))),
    recovery: node.recovery ?? null,
  };
  if (node.kind === "action") return { ...common, actionType: node.actionType, payload: node.payload };
  if (node.kind === "query") return { ...common, request: node.request };
  if (node.kind === "wait") return { ...common, waitFor: node.waitFor, deadlineAt: node.deadlineAt ?? null };
  return { ...common, criterionId: node.criterionId, observation: node.observation ?? {} };
}

/** Public semantic identity for recovery deduplication. Candidate labels, array
 * position, rationale, timestamps, and generated row ids are deliberately absent. */
export function planNodeSemanticHash(node: CandidatePlanNode): string {
  return sha256(nodeSemanticProjection(node));
}

function defaultObservation(node: CandidatePlanNode, criterion?: Record<string, unknown>, facts?: NodeCompilationFacts): ObservationSpec {
  if (node.kind === "query") return { version: 1, source: "operational_query", assertion: { intent: node.request.intent ?? null, status: "ok" }, freshness: "current" };
  if (node.kind === "action") return facts?.risk === "low"
    ? { version: 1, source: "decision_receipt", assertion: { finalized: true, actionType: node.actionType }, freshness: "current" }
    : { version: 1, source: "business_effect", assertion: { state: "verified", actionType: node.actionType }, freshness: "current" };
  if (node.kind === "wait") return { version: 1, source: "integration_event", assertion: node.waitFor, freshness: "event_bound" };
  return { version: 1, source: "objective_success", assertion: node.observation ?? criterion ?? {}, freshness: "current" };
}

function defaultRecovery(node: CandidatePlanNode, facts: NodeCompilationFacts | undefined): RecoverySpec {
  if (node.recovery) return node.recovery;
  const preferred = node.kind === "query" ? "retry" : node.kind === "action" && facts?.irreversible ? "escalate" : "replan";
  const mode = facts?.supportedRecoveryModes?.includes(preferred)
    ? preferred
    : facts?.supportedRecoveryModes?.[0] ?? preferred;
  return {
    version: 1,
    on: node.kind === "wait" ? ["timeout", "divergence"] : ["failure", "stale", "divergence"],
    mode,
    maxAttempts: mode === "retry" ? 2 : 1,
    neverReplayVerifiedIrreversibleEffect: true,
  };
}

function strongWaitCorrelation(waitFor: Record<string, unknown>): boolean {
  return ["resourceId", "delegationId", "taskId", "acknowledgementRequestId", "computerRunId", "domainActionId", "providerConversationId", "providerMessageId", "applicationRef", "correlationId"]
    .some((key) => typeof waitFor[key] === "string" && String(waitFor[key]).trim().length > 0)
    || Boolean(waitFor.resource && typeof waitFor.resource === "object" && !Array.isArray(waitFor.resource) && typeof (waitFor.resource as Record<string, unknown>).id === "string");
}

function graphDepth(nodes: CandidatePlanNode[], candidateKey: string, violations: PlanViolation[]): number {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const state = new Map<string, 0 | 1 | 2>();
  const depths = new Map<string, number>();
  let cycleRecorded = false;
  const visit = (key: string): number => {
    const marker = state.get(key) ?? 0;
    if (marker === 1) {
      if (!cycleRecorded) violations.push(violation(candidateKey, "DEPENDENCY_CYCLE", "Plan dependencies contain a cycle", key));
      cycleRecorded = true;
      return 0;
    }
    if (marker === 2) return depths.get(key) ?? 1;
    state.set(key, 1);
    const node = byKey.get(key)!;
    let depth = 1;
    for (const dependency of node.dependsOn ?? []) {
      if (dependency === key) {
        violations.push(violation(candidateKey, "DEPENDENCY_SELF_REFERENCE", "A node cannot depend on itself", key, "dependsOn"));
        continue;
      }
      if (!byKey.has(dependency)) {
        violations.push(violation(candidateKey, "DEPENDENCY_UNKNOWN", `Unknown dependency ${dependency}`, key, "dependsOn"));
        continue;
      }
      depth = Math.max(depth, visit(dependency) + 1);
    }
    state.set(key, 2);
    depths.set(key, depth);
    return depth;
  };
  return Math.max(0, ...nodes.map((node) => visit(node.key)));
}

function compareScore(left: PlanScoreVector, right: PlanScoreVector): number {
  const numeric: Array<keyof Omit<PlanScoreVector, "semanticHash" | "estimatedCostMicros" | "estimatedLatencyMs">> = [
    "hardViolations", "completionGaps", "groundingUncertainty", "authorityFriction", "capabilityDegradation",
    "irreversibleRisk", "recoveryWeakness", "epistemicUncertainty", "sideEffectCount", "preferencePenalty", "nodeCount",
  ];
  for (const key of numeric) {
    const delta = (left[key] as number) - (right[key] as number);
    if (delta !== 0) return delta;
  }
  for (const key of ["estimatedCostMicros", "estimatedLatencyMs"] as const) {
    const leftValue = left[key] ?? Number.MAX_SAFE_INTEGER;
    const rightValue = right[key] ?? Number.MAX_SAFE_INTEGER;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return left.semanticHash.localeCompare(right.semanticHash);
}

function emptyScore(semanticHash: string, hardViolations: number): PlanScoreVector {
  return {
    hardViolations,
    completionGaps: 0,
    groundingUncertainty: 0,
    authorityFriction: 0,
    capabilityDegradation: 0,
    irreversibleRisk: 0,
    recoveryWeakness: 0,
    epistemicUncertainty: 0,
    sideEffectCount: 0,
    nodeCount: 0,
    estimatedCostMicros: null,
    estimatedLatencyMs: null,
    preferencePenalty: 0,
    semanticHash,
  };
}

function valueAtPath(value: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function transitiveDependency(candidate: CandidatePlan, fromKey: string, requiredKey: string): boolean {
  const byKey = new Map(candidate.nodes.map((node) => [node.key, node]));
  const seen = new Set<string>();
  const visit = (key: string): boolean => {
    if (key === requiredKey) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return (byKey.get(key)?.dependsOn ?? []).some(visit);
  };
  return visit(fromKey);
}

function expectedEffects(node: CandidatePlanNode): PlanNode["expectedEffects"] {
  if (node.expectedEffects) return node.expectedEffects;
  if (node.kind === "action") return [{ kind: "business_effect", assertion: { actionType: node.actionType, state: "verified" } }];
  if (node.kind === "query") return [{ kind: "query_result", assertion: { intent: node.request.intent ?? null, status: "ok" } }];
  if (node.kind === "wait") return [{ kind: "event", assertion: node.waitFor }];
  return [{ kind: "objective_progress", assertion: { criterionId: node.criterionId, satisfied: true } }];
}

function constraintViolation(
  constraint: ConstraintSet["constraints"][number],
  candidate: CandidatePlan,
  snapshot: PlanningWorldSnapshot,
  facts: CandidateCompilationFacts | undefined,
): string | null {
  if (constraint.strength !== "hard") return null;
  if (constraint.source === "model") return "A model-sourced constraint cannot be hard";
  const requirement = constraint.requirement;
  if (constraint.kind === "deadline") {
    const deadlineAt = typeof requirement.deadlineAt === "string" ? requirement.deadlineAt : null;
    if (!deadlineAt || !Number.isFinite(Date.parse(deadlineAt))) return "Hard deadline constraint is malformed";
    if (Date.parse(snapshot.capturedAt) >= Date.parse(deadlineAt)) return `Hard deadline ${deadlineAt} has expired`;
  }
  if (constraint.kind === "authority" && typeof requirement.revision === "number" && snapshot.authority.revision !== requirement.revision) {
    return `Authority revision ${String(snapshot.authority.revision)} does not match required revision ${requirement.revision}`;
  }
  if (constraint.kind === "policy") {
    const actionType = typeof requirement.actionType === "string" ? requirement.actionType : null;
    const version = typeof requirement.version === "number" ? requirement.version : null;
    if (actionType && version !== null && !snapshot.policyRefs.some((ref) => ref.actionType === actionType && ref.version === version)) {
      return `Policy ${actionType}@${version} is not present in the planning snapshot`;
    }
  }
  if (constraint.kind === "exact_target") {
    const path = typeof requirement.path === "string" ? requirement.path : null;
    if (!path || !("value" in requirement)) return "Exact-target constraint is malformed";
    const scoped = candidate.nodes.filter((node) => !constraint.scope.ref || node.key === constraint.scope.ref || capability(node) === constraint.scope.ref);
    const matched = scoped.some((node) => {
      const body = node.kind === "action" ? node.payload : node.kind === "query" ? node.request : node.kind === "wait" ? node.waitFor : node.observation ?? {};
      return canonicalEqual(valueAtPath(body, path), requirement.value);
    });
    if (!matched) return `No scoped node preserves required exact target ${path}`;
  }
  if (constraint.kind === "non_goal" || constraint.kind === "capability_prohibited") {
    const forbidden = typeof requirement.capability === "string" ? requirement.capability : null;
    if (forbidden && candidate.nodes.some((node) => capability(node) === forbidden)) return `Forbidden capability ${forbidden} appears in the candidate`;
  }
  if (constraint.kind === "state_precondition" && constraint.scope.ref) {
    const nodeFacts = facts?.nodes[constraint.scope.ref];
    if (!nodeFacts || nodeFacts.preconditionsSatisfied === false) return `State precondition for ${constraint.scope.ref} is not satisfied`;
  }
  return null;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return sha256(left) === sha256(right);
}

function compileOne(input: {
  candidate: unknown;
  facts?: CandidateCompilationFacts;
  goal: GoalSpec;
  constraints: ConstraintSet;
  snapshot: PlanningWorldSnapshot;
}): CompiledCandidate {
  const parsed = CandidatePlanSchema.safeParse(input.candidate);
  const fallbackKey = input.facts?.candidateKey ?? "invalid-candidate";
  if (!parsed.success) {
    const semanticHash = sha256({ invalid: parsed.error.issues.map((issue) => ({ path: issue.path, code: issue.code })) });
    const violations = [violation(fallbackKey, "CANDIDATE_SCHEMA_INVALID", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "))];
    return {
      candidateKey: fallbackKey,
      candidateSemanticHash: semanticHash,
      accepted: false,
      violations,
      graph: null,
      score: emptyScore(semanticHash, 1),
    };
  }
  const candidate = parsed.data as CandidatePlan;
  const violations: PlanViolation[] = [];
  if (input.goal.workId !== input.snapshot.workId || input.goal.workId !== input.snapshot.work.id
    || input.goal.workInputId !== input.snapshot.workInputId || input.goal.workInputId !== input.snapshot.work.inputId) {
    violations.push(violation(candidate.candidateKey, "GOAL_SCOPE_MISMATCH", "GoalSpec and PlanningWorldSnapshot do not identify the same Work/Input"));
  }
  const entityKeys = new Set(input.snapshot.canonicalEntities.map((entity) => `${entity.kind}:${entity.type}:${entity.id}`));
  for (const target of input.goal.targets) {
    if (!entityKeys.has(`${target.kind}:${target.type}:${target.id}`)) {
      violations.push(violation(candidate.candidateKey, "GOAL_TARGET_UNGROUNDED", `Goal target ${target.kind}:${target.type}:${target.id} is absent from the immutable world snapshot`));
    }
  }
  if (input.goal.deadline && (!Number.isFinite(Date.parse(input.goal.deadline)) || Date.parse(input.snapshot.capturedAt) >= Date.parse(input.goal.deadline))) {
    violations.push(violation(candidate.candidateKey, "GOAL_DEADLINE_INVALID", "Goal deadline is invalid or already expired in the planning snapshot"));
  }
  if (input.constraints.constraints.length > input.constraints.budgets.maxConstraints) {
    violations.push(violation(candidate.candidateKey, "HARD_CONSTRAINT_INVALID", `Constraint count exceeds ${input.constraints.budgets.maxConstraints}`));
  }
  for (const constraint of input.constraints.constraints) {
    const message = constraintViolation(constraint, candidate, input.snapshot, input.facts);
    if (message) violations.push(violation(candidate.candidateKey, constraint.source === "model" ? "HARD_CONSTRAINT_INVALID" : "HARD_CONSTRAINT_VIOLATED", message, constraint.scope.type === "node" ? constraint.scope.ref : undefined));
  }
  const keys = new Set<string>();
  for (const node of candidate.nodes) {
    if (keys.has(node.key)) violations.push(violation(candidate.candidateKey, "CANDIDATE_SCHEMA_INVALID", `Duplicate node key ${node.key}`, node.key, "key"));
    keys.add(node.key);
  }
  const depth = graphDepth(candidate.nodes, candidate.candidateKey, violations);
  if (depth > input.constraints.budgets.maxDepth) violations.push(violation(candidate.candidateKey, "PLAN_DEPTH_EXCEEDED", `Plan depth ${depth} exceeds ${input.constraints.budgets.maxDepth}`));

  const counts = {
    actions: candidate.nodes.filter((node) => node.kind === "action").length,
    queries: candidate.nodes.filter((node) => node.kind === "query").length,
    waits: candidate.nodes.filter((node) => node.kind === "wait").length,
  };
  const edgeCount = candidate.nodes.reduce((sum, node) => sum + (node.dependsOn?.length ?? 0), 0);
  if (candidate.nodes.length > input.constraints.budgets.maxNodes) violations.push(violation(candidate.candidateKey, "NODE_BUDGET_EXCEEDED", `Plan has ${candidate.nodes.length} nodes; limit is ${input.constraints.budgets.maxNodes}`));
  if (edgeCount > input.constraints.budgets.maxEdges) violations.push(violation(candidate.candidateKey, "EDGE_BUDGET_EXCEEDED", `Plan has ${edgeCount} edges; limit is ${input.constraints.budgets.maxEdges}`));
  if (counts.actions > input.constraints.budgets.maxActions) violations.push(violation(candidate.candidateKey, "ACTION_BUDGET_EXCEEDED", `Plan has ${counts.actions} actions; limit is ${input.constraints.budgets.maxActions}`));
  if (counts.queries > input.constraints.budgets.maxQueries) violations.push(violation(candidate.candidateKey, "QUERY_BUDGET_EXCEEDED", `Plan has ${counts.queries} queries; limit is ${input.constraints.budgets.maxQueries}`));
  if (counts.waits > input.constraints.budgets.maxWaits) violations.push(violation(candidate.candidateKey, "WAIT_BUDGET_EXCEEDED", `Plan has ${counts.waits} waits; limit is ${input.constraints.budgets.maxWaits}`));

  const allowed = new Set(input.constraints.allowedCapabilities);
  const humanOnly = new Set(input.constraints.humanOnlyCapabilities);
  const prohibited = new Set(input.constraints.prohibitedCapabilities);
  const knownCriteria = new Map(input.goal.criteria.map((criterion) => [criterion.id, criterion.criterion]));
  const verifiedIrreversibleEffects = new Set(
    input.snapshot.currentEffects
      .filter((effect) => effect.status === "verified" && effect.irreversible)
      .map((effect) => effect.semanticHash),
  );
  const semanticByKey = new Map(candidate.nodes.map((node) => [node.key, sha256(nodeSemanticProjection(node))]));
  const duplicateSemantics = new Map<string, string>();
  const effectHashes = new Map<string, string>();
  let knownCost = 0;
  let knownLatency = 0;
  let allCostKnown = true;
  let allLatencyKnown = true;
  for (const node of candidate.nodes) {
    const key = capability(node);
    const facts = input.facts?.nodes[node.key];
    if (facts?.estimatedCostMicros === undefined || facts.estimatedCostMicros === null) allCostKnown = false;
    else knownCost += facts.estimatedCostMicros;
    if (facts?.estimatedLatencyMs === undefined || facts.estimatedLatencyMs === null) allLatencyKnown = false;
    else knownLatency += facts.estimatedLatencyMs;
    const nodeSemanticHash = semanticByKey.get(node.key)!;
    const sameSemanticNode = duplicateSemantics.get(nodeSemanticHash);
    if (sameSemanticNode) violations.push(violation(candidate.candidateKey, "DUPLICATE_NODE_SEMANTICS", `Node duplicates semantic node ${sameSemanticNode}`, node.key));
    else duplicateSemantics.set(nodeSemanticHash, node.key);
    if (humanOnly.has(key)) violations.push(violation(candidate.candidateKey, "HUMAN_ONLY_CAPABILITY", `${key} is a human-only boundary and cannot be model-proposed`, node.key));
    else if (!allowed.has(key) || prohibited.has(key)) violations.push(violation(candidate.candidateKey, "CAPABILITY_NOT_ALLOWED", `${key} is not allowed by the hard constraint set`, node.key));
    if (!facts?.registered) violations.push(violation(candidate.candidateKey, "UNKNOWN_CAPABILITY", `${key} is not registered in the planning capability manifest`, node.key));
    if (facts && !facts.schemaValid) violations.push(violation(candidate.candidateKey, "PAYLOAD_SCHEMA_INVALID", facts.schemaErrors.join("; ") || "Payload failed its registered schema", node.key));
    if (facts && !facts.grounded) violations.push(violation(candidate.candidateKey, "UNGROUNDED_REFERENCE", "Node contains references that are not grounded in the tenant snapshot", node.key));
    if (facts?.crossTenant) violations.push(violation(candidate.candidateKey, "CROSS_TENANT_REFERENCE", "Node resolves outside the authenticated tenant", node.key));
    if (facts?.stale) violations.push(violation(candidate.candidateKey, "STALE_GROUNDING", "Node grounding is stale relative to the planning snapshot", node.key));
    if (facts?.wrongVerticalRoot) violations.push(violation(candidate.candidateKey, "WRONG_VERTICAL_ROOT", "Node reference belongs to the wrong vertical/root", node.key));
    if (facts?.policyAllowed === false) violations.push(violation(candidate.candidateKey, "POLICY_CONFLICT", "Current policy forbids this node", node.key));
    if (facts?.preconditionsSatisfied === false) violations.push(violation(candidate.candidateKey, "PRECONDITION_UNSATISFIED", "A required current-state precondition is not satisfied", node.key));
    if (facts?.deadlineFeasible === false) violations.push(violation(candidate.candidateKey, "DEADLINE_IMPOSSIBLE", "Known node constraints cannot meet the accepted deadline", node.key));
    if (facts?.authority === "denied" || facts?.authority === "unknown") violations.push(violation(candidate.candidateKey, "AUTHORITY_DENIED", "Current authority cannot permit this node", node.key));
    if (facts?.health === "unavailable") violations.push(violation(candidate.candidateKey, "INTEGRATION_UNAVAILABLE", "Required execution capability is unavailable", node.key));
    const effectSemanticHash = facts?.effectSemanticHash ?? nodeSemanticHash;
    if (node.kind === "action" && facts?.irreversible && verifiedIrreversibleEffects.has(effectSemanticHash)) {
      violations.push(violation(candidate.candidateKey, "VERIFIED_IRREVERSIBLE_REPLAY", "A verified irreversible effect cannot be replayed by a recovery plan", node.key));
    }
    if (node.kind === "action") {
      const duplicateEffect = effectHashes.get(effectSemanticHash);
      if (duplicateEffect) violations.push(violation(candidate.candidateKey, "DUPLICATE_CONSEQUENTIAL_EFFECT", `Action duplicates effect proposed by ${duplicateEffect}`, node.key));
      else effectHashes.set(effectSemanticHash, node.key);
    }
    if (node.recovery && facts?.supportedRecoveryModes && !facts.supportedRecoveryModes.includes(node.recovery.mode)) {
      violations.push(violation(candidate.candidateKey, "UNSUPPORTED_RECOVERY", `Recovery mode ${node.recovery.mode} is not supported by ${key}`, node.key));
    }
    if (facts?.irreversible) {
      const uncertainKeys = facts.uncertainPrerequisiteNodeKeys ?? [];
      if (uncertainKeys.some((required) => !transitiveDependency(candidate, node.key, required))
        || (node.preconditions ?? []).some((precondition) => precondition.certainty === "uncertain" && uncertainKeys.length === 0)) {
        violations.push(violation(candidate.candidateKey, "IRREVERSIBLE_BEFORE_UNCERTAIN_PREREQUISITE", "Irreversible work is ordered before a required uncertain prerequisite is observed", node.key));
      }
    }
    const body = node.kind === "action" ? node.payload : node.kind === "query" ? node.request : node.kind === "wait" ? node.waitFor : node.observation ?? {};
    if (byteLength(body) > input.constraints.budgets.maxPayloadBytes) violations.push(violation(candidate.candidateKey, "PAYLOAD_BUDGET_EXCEEDED", `Node payload exceeds ${input.constraints.budgets.maxPayloadBytes} bytes`, node.key));
    if (node.kind === "wait" && !strongWaitCorrelation(node.waitFor) && !node.deadlineAt) violations.push(violation(candidate.candidateKey, "WAIT_CORRELATION_WEAK", "A wait requires an exact correlation or bounded deadline", node.key));
    if (node.kind === "wait" && node.deadlineAt && input.constraints.deadlineAt && Date.parse(node.deadlineAt) > Date.parse(input.constraints.deadlineAt)) {
      violations.push(violation(candidate.candidateKey, "DEADLINE_IMPOSSIBLE", "Wait deadline extends beyond the accepted Work deadline", node.key));
    }
    if (node.kind === "check" && !knownCriteria.has(node.criterionId)) violations.push(violation(candidate.candidateKey, "COMPLETION_CLAIM_UNKNOWN", `Unknown completion criterion ${node.criterionId}`, node.key));
    for (const criterionId of node.supports ?? []) {
      if (!knownCriteria.has(criterionId)) violations.push(violation(candidate.candidateKey, "COMPLETION_CLAIM_UNKNOWN", `Unknown completion claim ${criterionId}`, node.key, "supports"));
    }
  }
  const cost = allCostKnown ? knownCost : null;
  const latency = allLatencyKnown ? knownLatency : null;
  if (cost !== null && cost > input.constraints.budgets.maxEstimatedCostMicros) violations.push(violation(candidate.candidateKey, "COST_BUDGET_EXCEEDED", `Known cost ${cost} exceeds ${input.constraints.budgets.maxEstimatedCostMicros}`));

  const checkByCriterion = new Map(candidate.nodes.filter((node): node is Extract<CandidatePlanNode, { kind: "check" }> => node.kind === "check").map((node) => [node.criterionId, node]));
  const materialNodes = candidate.nodes.filter((node) => node.kind !== "check");
  for (const criterion of input.goal.criteria) {
    const check = checkByCriterion.get(criterion.id);
    if (!check) {
      violations.push(violation(candidate.candidateKey, "COMPLETION_COVERAGE_MISSING", `No deterministic check covers completion criterion ${criterion.id}`));
      continue;
    }
    const supporters = materialNodes.filter((node) => (node.supports ?? []).includes(criterion.id));
    if (materialNodes.length > 0 && supporters.length === 0) {
      violations.push(violation(candidate.candidateKey, "COMPLETION_COVERAGE_MISSING", `Completion criterion ${criterion.id} has no material supporting node`, check.key));
    }
    for (const supporter of supporters) {
      if (!transitiveDependency(candidate, check.key, supporter.key)) {
        violations.push(violation(candidate.candidateKey, "COMPLETION_COVERAGE_MISSING", `Completion check for ${criterion.id} is not causally ordered after supporting node ${supporter.key}`, check.key));
      }
    }
  }
  for (const material of materialNodes) {
    if (![...checkByCriterion.values()].some((check) => transitiveDependency(candidate, check.key, material.key))) {
      violations.push(violation(candidate.candidateKey, "COMPLETION_COVERAGE_MISSING", "Material node is orphaned from every deterministic completion check", material.key));
    }
  }

  const nodeIdByKey = new Map(candidate.nodes.map((node) => [node.key, `node_${sha256({ semantic: semanticByKey.get(node.key), dependencies: (node.dependsOn ?? []).map((key) => semanticByKey.get(key) ?? "missing").sort() }).slice(7, 31)}`]));
  const nodes: PlanNode[] = candidate.nodes.map((node) => {
    const facts = input.facts?.nodes[node.key];
    const base = {
      id: nodeIdByKey.get(node.key)!,
      kind: node.kind,
      dependsOn: (node.dependsOn ?? []).map((key) => nodeIdByKey.get(key) ?? `missing_${key}`),
      supports: [...(node.supports ?? [])].sort(),
      preconditions: [...(node.preconditions ?? [])],
      expectedEffects: expectedEffects(node),
      observation: defaultObservation(node, node.kind === "check" ? knownCriteria.get(node.criterionId) : undefined, facts),
      recovery: defaultRecovery(node, facts),
      semanticHash: semanticByKey.get(node.key)!,
    };
    if (node.kind === "action") return {
      ...base,
      kind: "action",
      actionType: node.actionType,
      payload: node.payload,
      groundedPayload: facts?.groundedPayload ?? node.payload,
      predictedReceipt: facts?.predictedReceipt ?? null,
      authority: facts?.authority === "approval_required" ? "approval_required" : "allowed",
      risk: facts?.risk ?? "high",
      irreversible: facts?.irreversible ?? true,
    } satisfies PlanActionNode;
    if (node.kind === "query") return { ...base, kind: "query" as const, request: node.request };
    if (node.kind === "wait") return { ...base, kind: "wait" as const, waitFor: node.waitFor, ...(node.deadlineAt ? { deadlineAt: node.deadlineAt } : {}) };
    return { ...base, kind: "check" as const, criterionId: node.criterionId, assertion: node.observation ?? knownCriteria.get(node.criterionId) ?? {} };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const edges = candidate.nodes.flatMap((node) => (node.dependsOn ?? []).map((dependency) => {
    const from = nodeIdByKey.get(dependency) ?? `missing_${dependency}`;
    const to = nodeIdByKey.get(node.key)!;
    return {
      from,
      to,
      kind: "causal_prerequisite" as const,
      semanticHash: sha256({ from: semanticByKey.get(dependency) ?? dependency, to: semanticByKey.get(node.key), kind: "causal_prerequisite" }),
    };
  })).sort((left, right) => left.semanticHash.localeCompare(right.semanticHash));
  const candidateSemanticHash = sha256({
    nodes: candidate.nodes.map((node) => nodeSemanticProjection(node)).sort((a, b) => sha256(a).localeCompare(sha256(b))),
    edges: edges.map((edge) => edge.semanticHash),
  });
  const graphProjection = {
    version: 1,
    goalHash: input.goal.semanticHash,
    constraintHash: input.constraints.semanticHash,
    snapshotHash: input.snapshot.semanticHash,
    nodes: nodes.map(({ id: _id, ...node }) => ({ ...node, dependsOn: node.dependsOn.map((dependency) => nodes.find((candidateNode) => candidateNode.id === dependency)?.semanticHash ?? dependency).sort() }))
      .sort((a, b) => a.semanticHash.localeCompare(b.semanticHash)),
    edges: edges.map((edge) => edge.semanticHash),
    completionCoverage: input.goal.criteria.map((criterion) => ({ criterionId: criterion.id, checkSemanticHash: semanticByKey.get(checkByCriterion.get(criterion.id)?.key ?? "") ?? "missing" })).sort((a, b) => a.criterionId.localeCompare(b.criterionId)),
  };
  const graphHash = sha256(graphProjection);
  const graph: PlanGraph = {
    version: 1,
    goalHash: input.goal.semanticHash,
    constraintHash: input.constraints.semanticHash,
    snapshotHash: input.snapshot.semanticHash,
    nodes,
    edges,
    completionCoverage: input.goal.criteria.flatMap((criterion) => {
      const check = checkByCriterion.get(criterion.id);
      return check ? [{ criterionId: criterion.id, checkNodeId: nodeIdByKey.get(check.key)! }] : [];
    }).sort((a, b) => a.criterionId.localeCompare(b.criterionId)),
    semanticHash: graphHash,
  };
  const irreversibleRisk = candidate.nodes.reduce((sum, node) => sum + (input.facts?.nodes[node.key]?.irreversible ? 1 : 0), 0);
  const groundingUncertainty = candidate.nodes.reduce((sum, node) => sum + (input.facts?.nodes[node.key]?.grounded ? 0 : 1), 0);
  const capabilityDegradation = candidate.nodes.reduce((sum, node) => sum + (input.facts?.nodes[node.key]?.health === "degraded" ? 1 : 0), 0);
  const authorityFriction = candidate.nodes.reduce((sum, node) => sum + (input.facts?.nodes[node.key]?.authority === "approval_required" ? 1 : 0), 0);
  const recoveryWeakness = nodes.reduce((sum, node) => sum + (node.recovery.mode === "escalate" ? 2 : node.recovery.mode === "replan" || node.recovery.mode === "recover" ? 1 : 0), 0);
  const epistemicUncertainty = input.snapshot.epistemicWarnings.length + candidate.nodes.reduce((sum, node) => sum + (node.preconditions ?? []).filter((precondition) => precondition.certainty === "uncertain").length, 0);
  const sideEffectCount = candidate.nodes.filter((node) => node.kind === "action" && (input.facts?.nodes[node.key]?.risk ?? "high") !== "low").length;
  const declaredPreferences = new Set((candidate.softPreferences ?? []).map((preference) => preference.key));
  const preferencePenalty = Math.round(input.constraints.softPreferences.reduce((sum, preference) => sum - (declaredPreferences.has(preference.key) ? preference.weight : 0), 0));
  const score: PlanScoreVector = {
    hardViolations: violations.length,
    completionGaps: input.goal.criteria.filter((criterion) => !checkByCriterion.has(criterion.id)).length,
    groundingUncertainty,
    authorityFriction,
    capabilityDegradation,
    irreversibleRisk,
    recoveryWeakness,
    epistemicUncertainty,
    sideEffectCount,
    nodeCount: nodes.length,
    estimatedCostMicros: cost,
    estimatedLatencyMs: latency,
    preferencePenalty,
    semanticHash: graphHash,
  };
  return { candidateKey: candidate.candidateKey, candidateSemanticHash, accepted: violations.length === 0, violations, score, graph: violations.length === 0 ? graph : null };
}

/** The only selection authority. Candidate order, prose, labels, and provider order
 * are irrelevant: valid graphs are ranked by the explicit lexicographic vector. */
export function compileAndSelectPlans(input: {
  candidates: unknown[];
  facts: CandidateCompilationFacts[];
  goal: GoalSpec;
  constraints: ConstraintSet;
  snapshot: PlanningWorldSnapshot;
}): PlanCompilationResult {
  const factsByKey = new Map(input.facts.map((facts) => [facts.candidateKey, facts]));
  const keys = input.candidates.map((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate) && typeof (candidate as Record<string, unknown>).candidateKey === "string"
    ? String((candidate as Record<string, unknown>).candidateKey)
    : "invalid-candidate");
  const duplicateKeys = new Set(keys.filter((key, index) => keys.indexOf(key) !== index));
  const overCandidateBudget = input.candidates.length > input.constraints.budgets.maxCandidates;
  const compiled = input.candidates.map((candidate, index) => {
    const candidateKey = candidate && typeof candidate === "object" && !Array.isArray(candidate) && typeof (candidate as Record<string, unknown>).candidateKey === "string"
      ? String((candidate as Record<string, unknown>).candidateKey)
      : "invalid-candidate";
    const result = compileOne({ ...input, candidate, facts: factsByKey.get(candidateKey) });
    const added: PlanViolation[] = [
      ...(overCandidateBudget ? [violation(candidateKey, "CANDIDATE_BUDGET_EXCEEDED", `Candidate set has ${input.candidates.length} entries; limit is ${input.constraints.budgets.maxCandidates}`)] : []),
      ...(duplicateKeys.has(candidateKey) ? [violation(candidateKey, "CANDIDATE_KEY_DUPLICATE", `Candidate key ${candidateKey} is duplicated at index ${index}`)] : []),
    ];
    if (added.length === 0) return result;
    return {
      ...result,
      accepted: false,
      violations: [...result.violations, ...added],
      graph: null,
      score: { ...result.score, hardViolations: result.score.hardViolations + added.length },
    };
  });
  const selected = compiled.filter((candidate) => candidate.accepted).sort((left, right) =>
    compareScore(left.score, right.score)
      || left.candidateSemanticHash.localeCompare(right.candidateSemanticHash)
      || left.candidateKey.localeCompare(right.candidateKey),
  )[0] ?? null;
  return { version: 1, candidates: compiled, selected };
}

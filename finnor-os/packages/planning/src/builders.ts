import { sha256 } from "./canonical";
import type { ConstraintSet, GoalSpec, GoalTarget, PlanBudgets, PlanningConstraint, PlanningWorldSnapshot } from "./contracts";

export const DEFAULT_PLAN_BUDGETS: PlanBudgets = Object.freeze({
  maxCandidates: 4,
  maxNodes: 24,
  maxEdges: 72,
  maxConstraints: 64,
  maxActions: 8,
  maxQueries: 12,
  maxWaits: 4,
  maxDepth: 12,
  maxPayloadBytes: 32_768,
  maxEstimatedCostMicros: 5_000_000,
});

export function buildGoalSpec(input: {
  objective: string;
  workId?: string;
  workInputId?: string;
  targets?: GoalTarget[];
  deadline?: string | Date | null;
  explicitNonGoals?: string[];
  successCondition: Record<string, unknown> & { criteria?: unknown[]; source?: unknown };
}): GoalSpec {
  const criteria = (Array.isArray(input.successCondition.criteria) ? input.successCondition.criteria : []).map((criterion, index) => {
    const value = criterion && typeof criterion === "object" && !Array.isArray(criterion) ? criterion as Record<string, unknown> : { value: criterion };
    return { id: `criterion_${index + 1}_${sha256(value).slice(7, 19)}`, criterion: value };
  });
  if (criteria.length === 0) throw new Error("GoalSpec requires at least one accepted completion criterion");
  const source = input.successCondition.source === "explicit" || input.successCondition.source === "legacy_backfill" ? input.successCondition.source : "objective_first_policy";
  const statement = input.objective.trim();
  if (!statement) throw new Error("GoalSpec requires a non-empty statement");
  const deadline = input.deadline instanceof Date ? input.deadline.toISOString() : input.deadline ?? null;
  if (deadline && !Number.isFinite(Date.parse(deadline))) throw new Error("GoalSpec deadline must be an ISO timestamp");
  const targets = [...(input.targets ?? [])].sort((a, b) => `${a.kind}:${a.type}:${a.id}`.localeCompare(`${b.kind}:${b.type}:${b.id}`));
  const explicitNonGoals = [...new Set(input.explicitNonGoals ?? [])].map((value) => value.trim()).filter(Boolean).sort();
  const workId = input.workId ?? "00000000-0000-4000-8000-000000000006";
  const workInputId = input.workInputId ?? "00000000-0000-4000-8000-000000000006";
  const semanticHash = sha256({ workId, workInputId, statement, targets, successCondition: input.successCondition, criteria, deadline, explicitNonGoals, source });
  return {
    version: 1,
    statement,
    objective: statement,
    workId,
    workInputId,
    targets,
    successCondition: input.successCondition,
    criteria,
    deadline,
    explicitNonGoals,
    source,
    semanticHash,
  };
}

export function buildConstraintSet(input: Omit<ConstraintSet, "version" | "semanticHash" | "constraints" | "deadlineAt"> & {
  constraints?: PlanningConstraint[];
  deadlineAt?: string | null;
}): ConstraintSet {
  const generated: PlanningConstraint[] = [
    {
      id: `constraint_${sha256({ kind: "capability_allowlist", values: [...new Set(input.allowedCapabilities)].sort() }).slice(7, 23)}`,
      kind: "capability_allowlist",
      source: "capability",
      strength: "hard",
      scope: { type: "plan" },
      requirement: { capabilities: [...new Set(input.allowedCapabilities)].sort() },
      provenance: { ref: "planning-capability-manifest", hash: sha256([...new Set(input.allowedCapabilities)].sort()) },
    },
    ...((input.deadlineAt ?? null) ? [{
      id: `constraint_${sha256({ kind: "deadline", deadlineAt: input.deadlineAt }).slice(7, 23)}`,
      kind: "deadline" as const,
      source: "work" as const,
      strength: "hard" as const,
      scope: { type: "plan" as const },
      requirement: { deadlineAt: input.deadlineAt },
      provenance: { ref: "work.deadline_at", hash: sha256(input.deadlineAt) },
    }] : []),
  ];
  const constraints = [...generated, ...(input.constraints ?? [])]
    .sort((a, b) => a.id.localeCompare(b.id));
  if (constraints.length > input.budgets.maxConstraints) throw new Error(`ConstraintSet exceeds ${input.budgets.maxConstraints} constraints`);
  if (constraints.some((constraint) => constraint.strength === "hard" && constraint.source === "model")) {
    throw new Error("Model-inferred constraints may only be soft");
  }
  const normalized = {
    ...input,
    allowedCapabilities: [...new Set(input.allowedCapabilities)].sort(),
    humanOnlyCapabilities: [...new Set(input.humanOnlyCapabilities)].sort(),
    prohibitedCapabilities: [...new Set(input.prohibitedCapabilities)].sort(),
    constraints,
    deadlineAt: input.deadlineAt ?? null,
    softPreferences: [...input.softPreferences].sort((a, b) => a.key.localeCompare(b.key) || a.weight - b.weight || a.source.localeCompare(b.source)),
  };
  const semanticHash = sha256({
    tenantId: normalized.tenantId,
    verticalKey: normalized.verticalKey,
    allowedCapabilities: normalized.allowedCapabilities,
    humanOnlyCapabilities: normalized.humanOnlyCapabilities,
    prohibitedCapabilities: normalized.prohibitedCapabilities,
    authorityRevision: normalized.authorityRevision,
    budgets: normalized.budgets,
    constraints: normalized.constraints,
    deadlineAt: normalized.deadlineAt,
    softPreferences: normalized.softPreferences,
  });
  return { version: 1, ...normalized, semanticHash };
}

export function buildPlanningWorldSnapshot(input: Omit<PlanningWorldSnapshot,
  "version" | "semanticHash" | "work" | "interactionContextRef" | "canonicalEntities" | "canonicalVersions" | "activeObjective" | "completedEffects" | "outstandingEffects" | "policyRefs" | "evidenceRefs" | "epistemicWarnings" | "sourceRefs"
> & Partial<Pick<PlanningWorldSnapshot, "work" | "interactionContextRef" | "canonicalEntities" | "canonicalVersions" | "activeObjective" | "completedEffects" | "outstandingEffects" | "policyRefs" | "evidenceRefs" | "epistemicWarnings" | "sourceRefs">>): PlanningWorldSnapshot {
  const normalized = {
    ...input,
    work: input.work ?? { id: input.workId, status: null, inputId: input.workInputId },
    interactionContextRef: input.interactionContextRef ?? null,
    canonicalEntities: [...(input.canonicalEntities ?? [])].sort((a, b) => `${a.kind}:${a.type}:${a.id}`.localeCompare(`${b.kind}:${b.type}:${b.id}`)),
    canonicalVersions: [...(input.canonicalVersions ?? [])].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef)),
    activeObjective: input.activeObjective ?? null,
    completedEffects: [...(input.completedEffects ?? [])].sort((a, b) => a.semanticHash.localeCompare(b.semanticHash)),
    outstandingEffects: [...(input.outstandingEffects ?? [])].sort((a, b) => a.semanticHash.localeCompare(b.semanticHash)),
    policyRefs: [...(input.policyRefs ?? [])].sort((a, b) => a.actionType.localeCompare(b.actionType) || (a.version ?? -1) - (b.version ?? -1)),
    evidenceRefs: [...(input.evidenceRefs ?? [])].sort((a, b) => `${a.type}:${a.id}`.localeCompare(`${b.type}:${b.id}`)),
    epistemicWarnings: [...(input.epistemicWarnings ?? [])].sort((a, b) => `${a.code}:${a.sourceRef}`.localeCompare(`${b.code}:${b.sourceRef}`)),
    sourceRefs: [...(input.sourceRefs ?? [])].sort((a, b) => `${a.kind}:${a.ref}`.localeCompare(`${b.kind}:${b.ref}`)),
    authority: { ...input.authority, roles: [...new Set(input.authority.roles)].sort() },
    capabilities: [...input.capabilities].sort((a, b) => a.capability.localeCompare(b.capability)),
    currentEffects: [...input.currentEffects].sort((a, b) => a.semanticHash.localeCompare(b.semanticHash) || a.status.localeCompare(b.status)),
    sourceHealth: { ...input.sourceHealth, missing: [...new Set(input.sourceHealth.missing)].sort() },
  };
  const semanticHash = sha256({
    tenantId: normalized.tenantId,
    verticalKey: normalized.verticalKey,
    decisionContextHash: normalized.decisionContextHash,
    canonicalStateHash: normalized.canonicalStateHash,
    work: normalized.work,
    interactionContextRef: normalized.interactionContextRef,
    canonicalEntities: normalized.canonicalEntities,
    canonicalVersions: normalized.canonicalVersions,
    activeObjective: normalized.activeObjective,
    completedEffects: normalized.completedEffects,
    outstandingEffects: normalized.outstandingEffects,
    policyRefs: normalized.policyRefs,
    evidenceRefs: normalized.evidenceRefs,
    epistemicWarnings: normalized.epistemicWarnings,
    sourceRefs: normalized.sourceRefs,
    authority: normalized.authority,
    capabilities: normalized.capabilities,
    currentEffects: normalized.currentEffects,
    sourceHealth: normalized.sourceHealth,
  });
  return { version: 1, ...normalized, semanticHash };
}

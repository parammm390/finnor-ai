import { checkWorkforceExecutionProgram, isLiveWorkforceAssignment } from './checker';
import { addVectors, exactQuantity, ExactQuantity, fits, ONE, quantities, workforceDigest } from './exact';
import { workforceTermsDigestContext, workforceCanonicalGraph } from './graph';
import type { WorkforceActor, WorkforceAssignment, WorkforceCeiling, WorkforceCompileResult, WorkforceCompilerInput, WorkforceExecutionProgram, WorkforceTask } from './schema';

function includesCeiling(child: WorkforceCeiling, parent: WorkforceCeiling): boolean {
  return child.capabilities.every(x => parent.capabilities.includes(x))
    && child.dataScopes.every(x => parent.dataScopes.includes(x))
    && child.purposes.every(x => parent.purposes.includes(x))
    && child.effects.every(x => parent.effects.includes(x))
    && (!child.allowSubdelegation || parent.allowSubdelegation)
    && Date.parse(child.validFrom) >= Date.parse(parent.validFrom)
    && Date.parse(child.validUntil) <= Date.parse(parent.validUntil);
}
export function workforceCandidateReasons(actor: WorkforceActor, task: WorkforceTask, input: WorkforceCompilerInput, assigned: WorkforceAssignment[]): string[] {
  return candidateReasons(actor, task, input, assigned, workforceCanonicalGraph(input));
}
function candidateReasons(actor: WorkforceActor, task: WorkforceTask, input: WorkforceCompilerInput,
  assigned: WorkforceAssignment[], graph: ReturnType<typeof workforceCanonicalGraph>): string[] {
  const reasons: string[] = [];
  const now = Date.parse(input.now); const end = Date.parse(task.slot.endAt);
  const criterion = graph.criteria.find(x => x.id === task.criterionId);
  if (actor.tenantId !== input.tenantId || actor.status !== 'CURRENT') reasons.push('IDENTITY_NOT_CURRENT');
  if (!task.allowedActorKinds.includes(actor.kind)) reasons.push('ACTOR_KIND_INCOMPATIBLE');
  if (actor.id === criterion?.checkerActorId || actor.id === criterion?.evidenceCustodianActorId) reasons.push('INDEPENDENT_CHECKER_CANNOT_PRODUCE');
  if (task.assignmentMode === 'INTERNAL_AUTHORIZED' && (actor.kind === 'EXTERNAL_PROFESSIONAL' || actor.kind === 'PROVIDER')) reasons.push('EXTERNAL_REQUIRES_VOLUNTARY_TERMS');
  if (!task.requiredCapabilities.every(required => actor.capabilities.some(c => c.skill === required.skill && c.scope === required.scope
    && c.certainty === 'OBSERVED' && Date.parse(c.validUntil) >= end && Date.parse(c.validUntil) > now))) reasons.push('CAPABILITY_EVIDENCE_MISSING_OR_UNCERTAIN');
  if (!input.grants.some(g => !g.revoked && g.actorId === actor.id && g.tenantId === input.tenantId
    && includesCeiling(task.ceiling, g.ceiling) && Date.parse(g.ceiling.validFrom) <= now && Date.parse(g.ceiling.validUntil) > now)) reasons.push('CURRENT_GRANT_MISSING');
  const availability = actor.availability;
  if (availability.kind === 'UNKNOWN') return [...reasons, 'AVAILABILITY_UNKNOWN'];
  if (Date.parse(availability.validUntil) < end || Date.parse(availability.validUntil) <= now) reasons.push('AVAILABILITY_STALE');
  const overlaps = assigned.filter(a => a.actorId === actor.id && isLiveWorkforceAssignment(a)).flatMap(a => {
    const t = graph.tasks.find(t => t.id === a.taskId);
    return t && Date.parse(t.slot.startAt) < end && Date.parse(t.slot.endAt) > Date.parse(task.slot.startAt) ? [t] : [];
  });
  const slots = availability.slots.filter(s => Date.parse(s.startAt) <= Date.parse(task.slot.startAt) && Date.parse(s.endAt) >= end);
  if (!slots.some(s => exactQuantity(s.committed).add(exactQuantity(String(overlaps.length))).add(ONE).compare(exactQuantity(s.capacity)) <= 0
    && exactQuantity(s.committed).add(exactQuantity(String(overlaps.length))).add(ONE).compare(exactQuantity(String(availability.maxConcurrent))) <= 0)) reasons.push('OBSERVED_CAPACITY_EXHAUSTED');
  const human = actor.kind === 'INTERNAL_HUMAN' || actor.kind === 'EXTERNAL_PROFESSIONAL' || actor.kind === 'PROVIDER';
  if (human) {
    const limits = availability.humanLimits;
    if (limits.kind !== 'OBSERVED' || limits.fatigue !== 'WITHIN_LIMIT') reasons.push('HUMAN_LIMITS_UNKNOWN_OR_EXCEEDED');
    else {
      const effort = overlaps.reduce((n, t) => n.add(exactQuantity(t.effortSeconds)), exactQuantity(task.effortSeconds));
      const physicalSeconds = new ExactQuantity(BigInt(Math.max(0, end - Date.parse(task.slot.startAt))), 1000n);
      if (effort.add(exactQuantity(limits.alreadyCommittedSeconds)).compare(exactQuantity(limits.maxEffortSeconds)) > 0
        || exactQuantity(task.effortSeconds).compare(physicalSeconds) > 0) reasons.push('HUMAN_PHYSICAL_CAPACITY');
    }
  }
  return reasons;
}

export function compileWorkforceExecutionProgram(input: WorkforceCompilerInput): WorkforceCompileResult {
  const metrics: WorkforceCompileResult['metrics'] = { actorsConsidered: input.actors.length, tasksConsidered: input.outcome.tasks.length,
    candidateChecks: 0, maximumDepth: 0, matchingDecisions: [] };
  const fail = (status: WorkforceCompileResult['status'], code: string): WorkforceCompileResult => ({
    status, program: null, gaps: [{ taskId: '*', code, reasons: [code] }], metrics, executionAuthorityGranted: false,
  });
  if (input.historyAnchor.revision !== 0 || input.historyAnchor.commandsDigest !== workforceDigest([]))
    return fail('INVALID_INPUT', 'HISTORY_ANCHOR_MISMATCH');
  if (input.taskCreations?.length) return fail('INVALID_INPUT', 'TASK_CREATION_REQUIRES_COMMAND');
  if (input.actors.length > 128 || input.outcome.tasks.length > 512) return fail('LIMIT_EXCEEDED', 'REPRESENTATION_LIMIT');
  const tasks = new Map(input.outcome.tasks.map(t => [t.id, t]));
  if (tasks.size !== input.outcome.tasks.length || new Set(input.actors.map(a => a.id)).size !== input.actors.length) return fail('INVALID_INPUT', 'DUPLICATE_ORIGINAL_ID');
  const visiting = new Set<string>(); const depths = new Map<string, number>();
  function depth(id: string): number {
    const prior = depths.get(id); if (prior !== undefined) return prior;
    const task = tasks.get(id);
    if (!task || visiting.has(id)) return Number.POSITIVE_INFINITY;
    visiting.add(id);
    const d = task.parentTaskId === null ? 1 : depth(task.parentTaskId) + 1;
    visiting.delete(id); depths.set(id, d); return d;
  }
  for (const t of tasks.values()) metrics.maximumDepth = Math.max(metrics.maximumDepth, depth(t.id));
  if (!Number.isFinite(metrics.maximumDepth)) return fail('INVALID_INPUT', 'TASK_ANCESTRY_CYCLE_OR_DANGLING');
  if (metrics.maximumDepth > 8) return fail('LIMIT_EXCEEDED', 'DELEGATION_DEPTH_LIMIT');
  const digestContext = workforceTermsDigestContext(input.outcome), candidateGraph = workforceCanonicalGraph(input);
  const program: WorkforceExecutionProgram = {
    schema: 'finnor.workforce-execution-program.v1', id: input.programId, tenantId: input.tenantId, principalId: input.principalId,
    sourceClass: input.sourceClass, originalOutcome: structuredClone(input.outcome), originalOutcomeDigest: digestContext.originalOutcomeDigest,
    compiledSnapshotRef: structuredClone(input.snapshotRef), revision: 0, assignments: [],
    history: [], taskCreations: [], executionAuthorityGranted: false, method: 'CONSTRAINT_GUIDED_GREEDY_NO_GLOBAL_OPTIMALITY',
  };
  const gaps: WorkforceCompileResult['gaps'] = [];
  const pending = new Map(tasks);
  const initialCandidates = new Map([...tasks.values()].map(task => [task.id,
    input.actors.filter(actor => { metrics.candidateChecks++; return candidateReasons(actor, task, input, [], candidateGraph).length === 0; }).length]));
  let rootDemand = quantities([]);
  while (pending.size) {
    const ready = [...pending.values()].filter(t => (t.parentTaskId === null || !pending.has(t.parentTaskId))
      && t.dependsOn.every(d => !pending.has(d)));
    if (!ready.length) {
      for (const t of pending.values()) gaps.push({ taskId: t.id, code: 'DEPENDENCY_CYCLE_OR_UNASSIGNED', reasons: ['No topological continuation'] });
      break;
    }
    ready.sort((a, b) => (initialCandidates.get(a.id) ?? 0) - (initialCandidates.get(b.id) ?? 0)
      || Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
    const task = ready[0]; if (!task) break;
    const candidates = input.actors.map(actor => {
      metrics.candidateChecks++;
      return { actor, reasons: candidateReasons(actor, task, input, program.assignments, candidateGraph) };
    });
    pending.delete(task.id);
    const parent = task.parentTaskId === null ? null : program.assignments.find(a => a.taskId === task.parentTaskId);
    if (task.parentTaskId !== null && !parent) {
      gaps.push({ taskId: task.id, code: 'PARENT_UNASSIGNED', reasons: ['Accountable parent has no eligible observed actor'] }); continue;
    }
    const feasible = candidates.filter(c => !c.reasons.length);
    const observations = feasible.map(c => {
      const matches = (input.matchingObservations ?? []).filter(o => o.taskId === task.id && o.actorId === c.actor.id
        && Date.parse(o.validUntil) > Date.parse(input.now) && Date.parse(o.validUntil) >= Date.parse(task.slot.endAt));
      return matches.length === 1 ? matches[0] : undefined;
    });
    const decision: WorkforceCompileResult['metrics']['matchingDecisions'][number] = { taskId: task.id, factorsUsed: [], unavailableFactors: [] };
    const columns: Array<Map<string, ExactQuantity>> = [];
    for (const [field, name] of [
      ['cost', 'COST'], ['latencySeconds', 'LATENCY_SECONDS'], ['verificationEffortSeconds', 'VERIFICATION_EFFORT_SECONDS'],
    ] as const) {
      const values = new Map<string, ExactQuantity>();
      const costUnits = new Set<string>();
      for (const [i, candidate] of feasible.entries()) {
        const observation = observations[i]; const factor = observation?.[field];
        if (!factor || factor.kind !== 'EVIDENCED' || factor.admission !== 'ADMITTED') break;
        if (field === 'cost' && observation?.cost.kind === 'EVIDENCED') costUnits.add(observation.cost.unit);
        if (field === 'verificationEffortSeconds') {
          const verification = observation?.verificationEffortSeconds;
          const criterion = input.outcome.criteria.find(c => c.id === task.criterionId);
          if (verification?.kind !== 'EVIDENCED' || verification.checkerActorId !== criterion?.checkerActorId
            || verification.checkerActorId === candidate.actor.id || workforceDigest(verification.criterionRef) !== workforceDigest(criterion?.ref ?? null)) break;
        }
        values.set(candidate.actor.id, exactQuantity(factor.value));
      }
      if (feasible.length > 0 && values.size === feasible.length && (field !== 'cost' || costUnits.size === 1)) {
        decision.factorsUsed.push(name); columns.push(values);
      } else decision.unavailableFactors.push(name);
    }
    metrics.matchingDecisions.push(decision);
    feasible.sort((a, b) => {
      for (const column of columns) {
        const left = column.get(a.actor.id); const right = column.get(b.actor.id);
        if (left && right) { const order = left.compare(right); if (order) return order; }
      }
      const la = program.assignments.filter(x => x.actorId === a.actor.id).length;
      const lb = program.assignments.filter(x => x.actorId === b.actor.id).length;
      return la - lb || a.actor.id.localeCompare(b.actor.id);
    });
    const actor = feasible[0]?.actor;
    if (!actor) {
      gaps.push({ taskId: task.id, code: 'NO_ELIGIBLE_OBSERVED_ACTOR', reasons: [...new Set(candidates.flatMap(c => c.reasons))] }); continue;
    }
    const newRootDemand = task.parentTaskId === null ? addVectors(rootDemand, quantities(task.demand)) : rootDemand;
    const parentTask = parent ? tasks.get(parent.taskId) : null;
    const siblings = parentTask ? program.assignments.filter(a => a.parentAssignmentId === parent?.id)
      .flatMap(a => tasks.get(a.taskId)?.demand ?? []) : [];
    if (!fits(newRootDemand, input.outcome.resourceLimits) || (parentTask && !fits(quantities([...siblings, ...task.demand]), parentTask.demand))) {
      gaps.push({ taskId: task.id, code: 'RESOURCE_SEARCH_GAP', reasons: ['Greedy candidate would exceed original exact accounting frontier'] }); continue;
    }
    rootDemand = newRootDemand;
    program.assignments.push({
      id: `${input.programId}:${task.id}:1`, taskId: task.id, actorId: actor.id,
      delegatorActorId: parent?.actorId ?? task.delegatorActorId, parentAssignmentId: parent?.id ?? null,
      rootId: input.outcome.rootId, workId: input.outcome.workId, originalDeadline: input.outcome.deadline, attempt: 1,
      terms: structuredClone(task.terms), termsDigest: digestContext.termsDigest(task, actor.id, task.terms, task.ceiling),
      ceiling: structuredClone(task.ceiling), state: { kind: 'PROPOSED' },
    });
  }
  const checked = checkWorkforceExecutionProgram(program, input);
  for (const issue of checked.issues) {
    if (issue.code === 'TASK_UNASSIGNED' && gaps.length) continue;
    if (!gaps.some(g => g.code === issue.code && g.taskId === issue.assignmentId)) gaps.push({ taskId: issue.assignmentId ?? '*', code: issue.code, reasons: [issue.detail] });
  }
  return { status: gaps.length ? 'PARTIAL' : 'COMPLETE', program, gaps, metrics, executionAuthorityGranted: false };
}

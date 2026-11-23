import { addVectors, coordinate, exactQuantity, ExactQuantity, quantities, workforceDigest, ZERO, type ExactVector } from './exact';
import type { ExperimentRef } from '../../../shared-types/src/experiments';
import type { AuthenticatedWorkforceCommand, WorkforceAssignment, WorkforceCeiling, WorkforceCheck, WorkforceCompilerInput, WorkforceExecutionProgram, WorkforceIssue, WorkforceState, WorkforceTask } from './schema';
import { workforceTermsDigestContext, workforceChildIsVerified, workforceProgramGraph, workforceRequiredChildren } from './graph';

const same = (a: unknown, b: unknown) => a === undefined || b === undefined ? a === b : workforceDigest(a) === workforceDigest(b);
const refKey = (r: ExperimentRef) => `${r.owner}\u0000${r.id}`;
function groupBy<T>(values: readonly T[], key: (value: T) => string) {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value), bucket = grouped.get(id);
    if (bucket) bucket.push(value); else grouped.set(id, [value]);
  }
  return grouped;
}
function resolveRef<T extends { ref: ExperimentRef }>(values: readonly T[]) {
  const grouped = groupBy(values, value => value.ref.id);
  return (ref: ExperimentRef) => grouped.get(ref.id)?.find(value => same(value.ref, ref));
}
const humanKind = (kind: string) => kind === 'INTERNAL_HUMAN' || kind === 'EXTERNAL_PROFESSIONAL' || kind === 'PROVIDER';
export const isLiveWorkforceAssignment = (a: WorkforceAssignment): boolean =>
  !['CLOSED', 'DECLINED', 'EXPIRED', 'RETURNED'].includes(a.state.kind);

function withinResourceEnvelope(used: ExactVector, limits: WorkforceTask['demand']): boolean {
  for (const [key, values] of used) {
    const matching = limits.filter(limit => coordinate(limit) === key);
    if (matching.length !== 1) return false;
    const limit = matching[0];
    if (!limit || limit.quantities.length !== values.length) return false;
    let usagePrefix = ZERO; let limitPrefix = ZERO;
    for (const [period, usage] of values.entries()) {
      const bound = limit.quantities[period];
      if (bound === undefined) return false;
      const maximum = exactQuantity(bound);
      if (usage.compare(maximum) > 0) return false;
      usagePrefix = usagePrefix.add(usage); limitPrefix = limitPrefix.add(maximum);
      if ((limit.kind === 'STOCK' || limit.kind === 'CUMULATIVE_EXPENDITURE') && usagePrefix.compare(limitPrefix) > 0) return false;
    }
  }
  return true;
}

function boundedBy(small: WorkforceCeiling, large: WorkforceCeiling): boolean {
  for (const field of ['capabilities', 'dataScopes', 'purposes', 'effects'] as const) {
    const allowed = new Set(large[field]);
    if (small[field].some(value => !allowed.has(value))) return false;
  }
  return (!small.allowSubdelegation || large.allowSubdelegation)
    && Date.parse(small.validFrom) >= Date.parse(large.validFrom)
    && Date.parse(small.validUntil) <= Date.parse(large.validUntil);
}
const acceptedStates = new Set(['ACCEPTED', 'IN_PROGRESS', 'DELIVERED', 'VERIFIED']);
const priorStates: Record<AuthenticatedWorkforceCommand['action']['kind'], WorkforceState['kind'][]> = {
  OFFER: ['PROPOSED'], ACCEPT: ['OFFERED'], DECLINE: ['OFFERED'],
  START: ['ACCEPTED', 'BLOCKED'], BLOCK: ['ACCEPTED', 'IN_PROGRESS', 'DELIVERED', 'DISPUTED', 'UNKNOWN_EFFECT'],
  DELIVER: ['IN_PROGRESS', 'BLOCKED'], VERIFY: ['DELIVERED', 'DISPUTED'],
  DISPUTE: ['ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'DELIVERED', 'VERIFIED', 'CANCEL_REQUESTED'],
  RETURN: ['OFFERED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'DISPUTED'],
  EXPIRE: ['PROPOSED', 'OFFERED'],
  CANCEL: ['PROPOSED', 'OFFERED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'DELIVERED', 'VERIFIED', 'DISPUTED', 'UNKNOWN_EFFECT', 'RETURNED'],
  CONFIRM_CANCEL: ['CANCEL_REQUESTED'], MARK_UNKNOWN_EFFECT: ['ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'CANCEL_REQUESTED', 'DELIVERED'],
  RECONCILE: ['UNKNOWN_EFFECT', 'CANCELLED_WITH_RESIDUAL_EXPOSURE', 'BLOCKED'],
  CLOSE: ['VERIFIED', 'RETURNED', 'DECLINED', 'EXPIRED', 'CANCELLED_WITH_RESIDUAL_EXPOSURE'],
  REVISE_TERMS: ['PROPOSED', 'OFFERED', 'ACCEPTED', 'BLOCKED', 'DISPUTED'],
  REASSIGN: ['RETURNED', 'DECLINED', 'EXPIRED', 'BLOCKED', 'CANCELLED_WITH_RESIDUAL_EXPOSURE'],
  REVOKE: ['PROPOSED', 'OFFERED', 'ACCEPTED', 'IN_PROGRESS', 'BLOCKED', 'DELIVERED', 'DISPUTED', 'UNKNOWN_EFFECT'],
  SUBDELEGATE: ['ACCEPTED', 'IN_PROGRESS', 'BLOCKED'],
};

export function checkWorkforceExecutionProgram(program: WorkforceExecutionProgram, current: WorkforceCompilerInput): WorkforceCheck {
  const issues: WorkforceIssue[] = [];
  const add = (code: string, boundary: WorkforceIssue['boundary'], assignmentId: string | null, detail: string) =>
    issues.push({ code, boundary, assignmentId, detail });
  const actors = new Map(current.actors.map(a => [a.id, a]));
  const graph = { tasks: [...current.outcome.tasks, ...(program.taskCreations ?? []).map(c => c.task)],
    criteria: [...current.outcome.criteria, ...(program.taskCreations ?? []).map(c => c.criterion)] };
  const tasks = new Map(graph.tasks.map(t => [t.id, t]));
  const assignments = new Map(program.assignments.map(a => [a.id, a]));
  const now = Date.parse(current.now);
  const digestContext = workforceTermsDigestContext(current.outcome);
  const authoritiesByCommand = groupBy(current.commandAuthorities, value => value.commandId);
  const dispositionByRef = resolveRef(current.dispositions), deliveryByRef = resolveRef(current.deliveries),
    verificationByRef = resolveRef(current.verifications);
  let maximumDepth = 0;
  if (program.id !== current.programId || program.tenantId !== current.tenantId || program.principalId !== current.principalId)
    add('PROGRAM_IDENTITY', 'GRAPH', null, 'Programme must resolve to original tenant, principal and identity');
  if (program.sourceClass !== current.sourceClass)
    add('SOURCE_CLASS_MISMATCH', 'GRAPH', null, 'Programme labels cannot upgrade or merge independently resolved synthetic, controlled or native populations');
  if (program.history.length < current.historyAnchor.revision || program.revision < current.historyAnchor.revision
    || workforceDigest(program.history.slice(0, current.historyAnchor.revision)) !== current.historyAnchor.commandsDigest)
    add('HISTORY_ANCHOR_MISMATCH', 'LIFECYCLE', null, 'Immutable history must contain the independently resolved latest committed prefix unchanged');
  if (workforceDigest(program.originalOutcome) !== digestContext.originalOutcomeDigest ||
      program.originalOutcomeDigest !== digestContext.originalOutcomeDigest)
    add('ORIGINAL_OUTCOME_CHANGED', 'GRAPH', null, 'Original Work, meaning, criteria, graph and deadline must be immutable');
  if (current.actors.length > 128 || program.assignments.filter(isLiveWorkforceAssignment).length > 512 || tasks.size > 512)
    add('REPRESENTATION_LIMIT', 'PROFILE', null, 'The full 128 actor and 512 live assignment profile is enforced without truncation');
  if (issues.some(i => i.code === 'REPRESENTATION_LIMIT')) return {
    valid: false, issues, affectedAssignmentIds: program.assignments.map(a => a.id),
      checked: { actors: current.actors.length, assignments: program.assignments.length, tasks: graph.tasks.length,
      maximumDepth: 0, fundingRecords: current.funding.length, possibleEffects: current.effects.length }, executionAuthorityGranted: false,
  };
  for (const [name, items, key] of [
    ['actor', current.actors, (x: { id: string }) => x.id],
    ['task', graph.tasks, (x: { id: string }) => x.id],
    ['assignment', program.assignments, (x: { id: string }) => x.id],
  ] as const) if (new Set(items.map(key)).size !== items.length) add('DUPLICATE_ID', 'GRAPH', null, `Duplicate ${name} identity`);
  if (new Set(current.actors.map(a => refKey(a.identityRef))).size !== current.actors.length) add('DUPLICATE_IDENTITY_REF', 'GRAPH', null, 'One canonical actual identity cannot masquerade as several actors');
  if (new Set(graph.criteria.map(c => c.id)).size !== graph.criteria.length) add('DUPLICATE_CRITERION', 'GRAPH', null, 'Original and auxiliary criterion identities must be unique');
  const creations = program.taskCreations ?? [];
  const creationCommands = program.history.flatMap(c => c.action.kind === 'SUBDELEGATE' ? [c.action.taskCreationRef] : []);
  if (!same(creations.map(c => c.ref), creationCommands)) add('TASK_CREATION_ORDER', 'GRAPH', null, 'Each appended task observation requires exactly one ordered creation command');
  for (const fact of creations) {
    if (!(current.taskCreations ?? []).some(c => same(c.ref, fact.ref) && same(c, fact)))
      add('TASK_CREATION_PROVENANCE', 'GRAPH', fact.assignmentId, 'New work must independently resolve unchanged from its canonical creation owner');
    if (fact.task.criterionId !== fact.criterion.id || fact.task.parentTaskId === null
      || fact.task.delegatorActorId !== fact.actorId || !fact.task.returnTo.includes(fact.task.parentTaskId))
      add('TASK_CREATION_BINDING', 'GRAPH', fact.assignmentId, 'New work retains its actual parent, auxiliary criterion and operational return target');
  }
  const taskDepth = new Map<string, number>();
  const taskPath = new Set<string>();
  function visitTask(id: string): number {
    const known = taskDepth.get(id); if (known !== undefined) return known;
    const t = tasks.get(id);
    if (!t || taskPath.has(id)) {
      add('TASK_ANCESTRY_CYCLE_OR_DANGLING', 'GRAPH', null, `Invalid original task ancestry at ${id}`); return 9;
    }
    taskPath.add(id);
    const d = t.parentTaskId === null ? 1 : 1 + visitTask(t.parentTaskId);
    taskPath.delete(id); taskDepth.set(id, d); maximumDepth = Math.max(maximumDepth, d); return d;
  }
  const dependencyPath = new Set<string>(); const dependencyDone = new Set<string>();
  function visitDependency(id: string): void {
    if (dependencyDone.has(id)) return;
    const t = tasks.get(id);
    if (!t || dependencyPath.has(id)) { add('DEPENDENCY_CYCLE_OR_DANGLING', 'GRAPH', null, `Invalid dependency ${id}`); return; }
    dependencyPath.add(id);
    for (const d of [...t.dependsOn, ...creations.filter(c => c.task.parentTaskId === id).map(c => c.task.id)]) visitDependency(d);
    dependencyPath.delete(id); dependencyDone.add(id);
  }
  for (const t of tasks.values()) {
    visitTask(t.id); visitDependency(t.id);
    for (const r of t.returnTo) if (!tasks.has(r)) add('DANGLING_RETURN_EDGE', 'GRAPH', null, `Unknown operational return target ${r}`);
    if (!graph.criteria.some(c => c.id === t.criterionId)) add('ORIGINAL_CRITERION_MISSING', 'GRAPH', null, `No independent original or canonical auxiliary criterion for ${t.id}`);
    if (Date.parse(t.dueAt) > Date.parse(current.outcome.deadline) || Date.parse(t.slot.endAt) > Date.parse(t.dueAt)
      || Date.parse(t.slot.startAt) >= Date.parse(t.slot.endAt)
      || (t.parentTaskId !== null && Date.parse(t.dueAt) > Date.parse(tasks.get(t.parentTaskId)?.dueAt ?? current.outcome.deadline)))
      add('DEADLINE_ANCESTRY', 'GRAPH', null, `Original calendar/deadline cannot reset for ${t.id}`);
    if (t.context.includesCredentials || !t.context.dataScopes.every(s => t.ceiling.dataScopes.includes(s))
      || !t.context.purposes.every(p => t.ceiling.purposes.includes(p))) add('DISCLOSURE_CEILING', 'GRAPH', null, `Excess context or credential disclosure in ${t.id}`);
    if (!boundedBy(t.ceiling, current.outcome.ceiling)) add('ROOT_ATTENUATION', 'GRAPH', null, `Task ${t.id} exceeds original root authority`);
    if (new Set(t.demand.map(coordinate)).size !== t.demand.length) add('DUPLICATE_RESOURCE_COORDINATE', 'ACCOUNTING', null, `Task ${t.id} repeats a canonical resource coordinate`);
    if (!program.assignments.some(a => a.taskId === t.id)) add('TASK_UNASSIGNED', 'GRAPH', null, `Original task ${t.id} remains an explicit gap`);
  }
  if (new Set(current.outcome.resourceLimits.map(coordinate)).size !== current.outcome.resourceLimits.length)
    add('DUPLICATE_RESOURCE_COORDINATE', 'ACCOUNTING', null, 'The original root grant cannot be multiplied by repeating its resource coordinate');
  if (maximumDepth > 8) add('DELEGATION_DEPTH_LIMIT', 'PROFILE', null, 'Delegation depth exceeds eight');

  const stateById = new Map<string, WorkforceState>(program.assignments.map(a => [a.id, { kind: 'PROPOSED' }]));
  const termsById = new Map(program.assignments.map(a => [a.id, tasks.get(a.taskId)?.terms]));
  const accepted = new Map<string, WorkforceCompilerInput['dispositions'][number]>();
  const acceptedHistory = new Map<string, Array<{ at: string; compensation: string }>>();
  function requireReleasedObligations(assignment: WorkforceAssignment, cutoff: string, boundary: WorkforceIssue['boundary']): void {
    const facts = acceptedHistory.get(assignment.id) ?? [];
    const lastAcceptance = facts.at(-1);
    const lastPaidAcceptance = facts.filter(f => exactQuantity(f.compensation).compare(ZERO) > 0).at(-1);
    const actorKind = actors.get(assignment.actorId)?.kind;
    const labor = actorKind === undefined || humanKind(actorKind);
    for (const [kind, fact, code] of [
      ['ACCEPTED_LABOR', labor ? lastAcceptance : undefined, 'LABOR_RELEASE_UNKNOWN'],
      ['COMPENSATION', lastPaidAcceptance, 'COMPENSATION_RELEASE_UNKNOWN'],
    ] as const) {
      if (fact && !current.obligations.some(o => o.assignmentId === assignment.id && o.rootId === assignment.rootId && o.kind === kind
        && (o.status === 'RELEASED' || o.status === 'SETTLED') && Date.parse(o.at) >= Date.parse(fact.at)
        && Date.parse(o.at) <= Date.parse(cutoff) && Date.parse(o.at) <= now))
        add(code, boundary, assignment.id, `${kind} release or settlement after historical acceptance is UNKNOWN without an explicit authoritative same-root observation`);
    }
  }
  const delivered = new Map<string, WorkforceCompilerInput['deliveries'][number]>();
  const verified = new Map<string, WorkforceCompilerInput['verifications'][number]>();
  const commandIds = new Set<string>();
  const createdAssignments = new Set(program.assignments.filter(a => a.attempt === 1 && current.outcome.tasks.some(t => t.id === a.taskId)).map(a => a.id));
  for (let i = 0; i < program.history.length; i++) {
    const c = program.history[i]; if (!c) continue;
    const assignment = assignments.get(c.assignmentId); const task = assignment ? tasks.get(assignment.taskId) : undefined;
    if (!assignment || !task) { add('DANGLING_COMMAND', 'LIFECYCLE', c.assignmentId, 'History references an unknown assignment'); continue; }
    if (!createdAssignments.has(assignment.id)) { add('ASSIGNMENT_BEFORE_CREATION', 'LIFECYCLE', assignment.id, 'An assignment cannot act before its authenticated creation or replacement'); continue; }
    if (commandIds.has(c.id) || c.expectedRevision !== i || Date.parse(c.at) > now
      || (i > 0 && Date.parse(c.at) < Date.parse(program.history[i - 1]?.at ?? c.at))) add('COMMAND_ORDER', 'LIFECYCLE', c.assignmentId, 'Immutable history must be ordered and uniquely CAS-bound');
    commandIds.add(c.id);
    const authority = authoritiesByCommand.get(c.id)?.find(a => same(a.ref, c.authorityRef) && a.commandId === c.id
      && a.actorId === c.actorId && a.assignmentId === c.assignmentId && a.commandDigest === workforceDigest(c)
      && a.actions.includes(c.action.kind) && Date.parse(a.validFrom) <= Date.parse(c.at) && Date.parse(a.validUntil) >= Date.parse(c.at));
    if (!authority) add('COMMAND_AUTHORITY', 'LIFECYCLE', c.assignmentId, 'No separately resolved exact authenticated command authority');
    const before = stateById.get(c.assignmentId)?.kind ?? 'PROPOSED';
    if (!priorStates[c.action.kind].includes(before)) add('ILLEGAL_TRANSITION', 'LIFECYCLE', c.assignmentId, `${before} cannot receive ${c.action.kind}`);
    const criterion = graph.criteria.find(x => x.id === task.criterionId);
    const recipientActions = ['START', 'DELIVER', 'RETURN', 'DECLINE', 'SUBDELEGATE'];
    if ((recipientActions.includes(c.action.kind) && c.actorId !== assignment.actorId)
      || !actors.has(c.actorId) || actors.get(c.actorId)?.tenantId !== current.tenantId
      || (['BLOCK', 'DISPUTE'].includes(c.action.kind) && ![assignment.actorId, assignment.delegatorActorId, current.outcome.requesterActorId, criterion?.checkerActorId].includes(c.actorId))
      || (c.action.kind === 'ACCEPT' && c.actorId !== assignment.actorId && !(task.assignmentMode === 'INTERNAL_AUTHORIZED' && c.actorId === assignment.delegatorActorId))
      || (c.action.kind === 'VERIFY' && c.actorId !== criterion?.checkerActorId)
      || (!recipientActions.includes(c.action.kind) && !['ACCEPT', 'VERIFY', 'BLOCK', 'DISPUTE', 'RECONCILE', 'MARK_UNKNOWN_EFFECT'].includes(c.action.kind)
        && ![assignment.delegatorActorId, current.outcome.requesterActorId].includes(c.actorId)))
      add('COMMAND_ACTOR', 'LIFECYCLE', assignment.id, 'Authenticated principal is not the actor permitted for this operation');
    const action = c.action;
    switch (action.kind) {
      case 'OFFER': stateById.set(assignment.id, { kind: 'OFFERED', ref: action.offerRef }); break;
      case 'ACCEPT':
      case 'DECLINE': {
        const d = dispositionByRef(action.dispositionRef);
        const terms = termsById.get(assignment.id) ?? task.terms;
        const expectedDigest = digestContext.termsDigest(task, assignment.actorId, terms, assignment.ceiling, creations.find(f => f.task.id === task.id));
        if (!d || d.assignmentId !== assignment.id || d.actorId !== assignment.actorId || d.termsDigest !== expectedDigest
          || d.termsRevision !== terms.revision || d.mode !== task.assignmentMode || d.decision !== (action.kind === 'ACCEPT' ? 'ACCEPT' : 'DECLINE')
          || d.source !== (task.assignmentMode === 'EXTERNAL_VOLUNTARY' ? 'NATIVE_RECIPIENT_DISPOSITION' : 'NATIVE_INSTITUTIONAL_ASSIGNMENT')
          || Date.parse(d.at) > Date.parse(c.at) || Date.parse(d.at) > Date.parse(terms.expiresAt)
          || (d.revokedAt !== null && Date.parse(d.revokedAt) <= Date.parse(d.at)))
          add('ACCEPTANCE_BINDING', 'ACCEPTANCE', assignment.id, 'Actual actor, source, terms revision, disposition and digest must match exactly');
        else if (action.kind === 'ACCEPT') {
          accepted.set(assignment.id, d);
          acceptedHistory.set(assignment.id, [...(acceptedHistory.get(assignment.id) ?? []), { at: c.at, compensation: terms.compensation.value }]);
        }
        stateById.set(assignment.id, { kind: action.kind === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED', ref: action.dispositionRef });
        break;
      }
      case 'START': stateById.set(assignment.id, { kind: 'IN_PROGRESS', ref: action.observationRef }); break;
      case 'BLOCK': stateById.set(assignment.id, { kind: 'BLOCKED', ref: action.observationRef, reason: action.reason }); break;
      case 'DELIVER': {
        const required = creations.filter(f => f.parentAssignmentId === assignment.id && createdAssignments.has(f.assignmentId));
        if (required.some(f => !program.assignments.some(a => a.taskId === f.task.id && verified.has(a.id)
          && ['VERIFIED', 'CLOSED'].includes(stateById.get(a.id)?.kind ?? 'PROPOSED'))))
          add('REQUESTED_WORK_UNVERIFIED', 'LIFECYCLE', assignment.id, 'Requested child work must be independently verified before its requester reports delivery');
        const d = deliveryByRef(action.deliveryRef);
        if (!d || d.assignmentId !== assignment.id || d.actorId !== assignment.actorId || d.termsDigest !== assignment.termsDigest
          || d.evidenceRefs.length === 0 || Date.parse(d.at) > Date.parse(c.at)) add('DELIVERY_BINDING', 'ACCEPTANCE', assignment.id, 'Delivery must resolve to actual evidence under the exact accepted terms');
        else delivered.set(assignment.id, d);
        stateById.set(assignment.id, { kind: 'DELIVERED', ref: action.deliveryRef }); break;
      }
      case 'VERIFY': {
        const v = verificationByRef(action.verificationRef);
        const d = delivered.get(assignment.id);
        if (!v || !d || !same(v.deliveryRef, d.ref) || v.assignmentId !== assignment.id || !same(v.criterionRef, criterion?.ref)
          || v.checkerActorId !== criterion?.checkerActorId || v.custodianActorId !== criterion?.evidenceCustodianActorId
          || d.custodianActorId !== v.custodianActorId || v.checkerActorId === assignment.actorId || v.custodianActorId === assignment.actorId
          || !actors.has(v.checkerActorId) || !actors.has(v.custodianActorId)
          || v.evidenceRefs.length === 0 || !v.evidenceRefs.every(r => d.evidenceRefs.some(e => same(e, r)))
          || v.result !== 'SATISFIED' || Date.parse(v.at) > Date.parse(c.at) || Date.parse(v.at) < Date.parse(d.at))
          add('VERIFICATION_CUSTODY', 'ACCEPTANCE', assignment.id, 'Independent original checker, criterion and evidence custody are required');
        else verified.set(assignment.id, v);
        stateById.set(assignment.id, { kind: 'VERIFIED', ref: action.verificationRef }); break;
      }
      case 'DISPUTE': stateById.set(assignment.id, { kind: 'DISPUTED', ref: action.observationRef, reason: action.reason }); break;
      case 'RETURN': stateById.set(assignment.id, { kind: 'RETURNED', ref: action.observationRef, reason: action.reason }); break;
      case 'EXPIRE':
        if (Date.parse(c.at) < Date.parse((termsById.get(assignment.id) ?? task.terms).expiresAt)) add('PREMATURE_EXPIRY', 'LIFECYCLE', assignment.id, 'Silence is not acceptance and an unelapsed offer cannot expire');
        stateById.set(assignment.id, { kind: 'EXPIRED', ref: action.observationRef }); break;
      case 'CANCEL': stateById.set(assignment.id, { kind: 'CANCEL_REQUESTED', ref: action.observationRef }); break;
      case 'CONFIRM_CANCEL':
        stateById.set(assignment.id, { kind: 'CANCELLED_WITH_RESIDUAL_EXPOSURE', ref: action.observationRef }); break;
      case 'MARK_UNKNOWN_EFFECT': {
        const e = current.effects.find(e => same(e.ref, action.effectRef) && e.assignmentId === assignment.id);
        if (!e || !['UNKNOWN', 'MAY_HAVE_LEFT'].includes(e.status)) add('EFFECT_OBSERVATION', 'LIFECYCLE', assignment.id, 'Unknown effect must be an actual native S6 observation');
        stateById.set(assignment.id, { kind: 'UNKNOWN_EFFECT', ref: action.effectRef }); break;
      }
      case 'RECONCILE': {
        const r = current.reconciliations.find(r => same(r.ref, action.reconciliationRef) && r.rootId === assignment.rootId && r.effectId === task.effectId);
        if (!r) add('S6_RECONCILIATION', 'LIFECYCLE', assignment.id, 'Only the original authoritative S6 identity can reconcile possible egress');
        stateById.set(assignment.id, r?.status === 'UNKNOWN' ? { kind: 'UNKNOWN_EFFECT', ref: action.reconciliationRef }
          : { kind: 'BLOCKED', ref: action.reconciliationRef, reason: 'Reconciled. Requires current owner continuation.' }); break;
      }
      case 'CLOSE':
        requireReleasedObligations(assignment, c.at, 'ACCOUNTING');
        if (before === 'VERIFIED' && !verified.has(assignment.id)) add('CLOSURE_UNVERIFIED', 'LIFECYCLE', assignment.id, 'Delivery is not independent verification');
        stateById.set(assignment.id, { kind: 'CLOSED', ref: action.observationRef }); break;
      case 'REVISE_TERMS': {
        const change = current.termChanges.find(t => same(t.ref, action.termChangeRef) && t.taskId === task.id);
        if (!change || change.terms.revision <= (termsById.get(assignment.id)?.revision ?? 0)) add('TERMS_REVISION', 'ACCEPTANCE', assignment.id, 'Terms changes require a canonical increasing revision and fresh acceptance');
        else termsById.set(assignment.id, change.terms);
        stateById.set(assignment.id, { kind: 'PROPOSED' }); accepted.delete(assignment.id); break;
      }
      case 'REASSIGN': {
        requireReleasedObligations(assignment, c.at, 'LIFECYCLE');
        const replacement = assignments.get(action.replacementAssignmentId);
        if (!replacement || replacement.taskId !== assignment.taskId || replacement.actorId !== action.replacementActorId
          || replacement.attempt !== assignment.attempt + 1) add('REPLACEMENT_BINDING', 'LIFECYCLE', assignment.id, 'Replacement must retain the original task and increment the attempt without a new effect identity');
        if (current.obligations.some(o => o.assignmentId === assignment.id && o.status === 'OPEN')
          || current.funding.some(f => f.assignmentId === assignment.id && (f.status === 'HELD' ||
            [...quantities(f.unresolved).values()].some(values => values.some(value => value.compare(ZERO) > 0)))))
          add('REPLACEMENT_RESIDUAL', 'LIFECYCLE', assignment.id, 'Accepted labor, compensation and unresolved exposure must be authoritatively released or settled');
        if (task.effectId !== null && !current.reconciliations.some(r => same(r.ref, action.reconciliationRef)
          && r.effectId === task.effectId && r.rootId === assignment.rootId && r.status === 'CONFIRMED_NOT_LEFT'))
          add('REPLACEMENT_RECONCILIATION', 'LIFECYCLE', assignment.id, 'No replacement physical attempt before original S6 confirms it did not leave');
        if (replacement) termsById.set(replacement.id, termsById.get(assignment.id) ?? task.terms);
        if (replacement) {
          if (createdAssignments.has(replacement.id)) add('REPLACEMENT_BINDING', 'LIFECYCLE', replacement.id, 'A replacement cannot be created twice');
          createdAssignments.add(replacement.id);
        }
        stateById.set(assignment.id, { kind: 'RETURNED', ref: c.authorityRef, reason: 'Reassigned with original continuity retained' }); break;
      }
      case 'SUBDELEGATE': {
        const fact = creations.find(f => same(f.ref, action.taskCreationRef));
        const child = fact ? assignments.get(fact.assignmentId) : undefined;
        const terms = termsById.get(assignment.id) ?? task.terms;
        const disposition = accepted.get(assignment.id);
        const digest = digestContext.termsDigest(task, assignment.actorId, terms, assignment.ceiling, creations.find(f => f.task.id === task.id));
        if (!fact || !child || fact.parentAssignmentId !== assignment.id || fact.actorId !== assignment.actorId
          || fact.parentTermsDigest !== digest || disposition?.termsDigest !== digest
          || (disposition.revokedAt !== null && Date.parse(disposition.revokedAt) <= Date.parse(c.at))
          || !terms.subdelegation || !assignment.ceiling.allowSubdelegation
          || fact.task.parentTaskId !== task.id || child.parentAssignmentId !== assignment.id
          || child.taskId !== fact.task.id || child.actorId !== fact.recipientActorId || child.attempt !== 1
          || Date.parse(fact.at) > Date.parse(c.at) || Date.parse(fact.at) < Date.parse(disposition.at)
          || createdAssignments.has(child.id))
          add('TASK_CREATION_AUTHORITY', 'LIFECYCLE', assignment.id, 'Creation requires the actual accepted recipient, exact parent terms, new child identity and original ancestry');
        if (fact && (Date.parse(c.at) > Date.parse(terms.expiresAt) ||
          Date.parse(fact.task.slot.startAt) < Date.parse(task.slot.startAt) ||
          Date.parse(fact.task.slot.endAt) > Date.parse(task.slot.endAt) ||
          Date.parse(fact.task.terms.expiresAt) > Math.min(Date.parse(terms.expiresAt), Date.parse(task.slot.endAt),
            Date.parse(assignment.ceiling.validUntil), Date.parse(fact.task.dueAt), Date.parse(current.outcome.deadline))))
          add('TASK_CREATION_TERMS_CEILING', 'GRAPH', fact.assignmentId, 'New work cannot extend the accepted parent contract, promised slot or original time authority');
        if (fact?.kind === 'RECIPROCAL_REQUEST') {
          const upstream = new Set([current.outcome.requesterActorId, assignment.delegatorActorId]);
          let parent = assignment; const seen = new Set<string>();
          while (parent.parentAssignmentId && !seen.has(parent.id)) {
            seen.add(parent.id); const prior = assignments.get(parent.parentAssignmentId);
            if (!prior) break; upstream.add(prior.actorId); parent = prior;
          }
          if (fact.recipientActorId === assignment.actorId || !upstream.has(fact.recipientActorId))
            add('RECIPROCAL_REQUEST_BINDING', 'GRAPH', fact.assignmentId, 'A reciprocal request returns work to an actual upstream participant without reversing financial ancestry');
        }
        if (child) createdAssignments.add(child.id);
        break;
      }
      case 'REVOKE': stateById.set(assignment.id, { kind: 'BLOCKED', ref: action.observationRef, reason: action.reason }); break;
      default: { const exhaustive: never = action; throw Error(`Unknown command ${String(exhaustive)}`); }
    }
  }
  if (program.revision !== program.history.length) add('REVISION_HISTORY', 'LIFECYCLE', null, 'Revision must equal the immutable command count');

  for (const a of program.assignments) {
    const task = tasks.get(a.taskId); const actor = actors.get(a.actorId);
    if (!task) { add('DANGLING_TASK', 'GRAPH', a.id, 'Assignment has no original task'); continue; }
    if (a.rootId !== current.outcome.rootId || a.workId !== current.outcome.workId || a.originalDeadline !== current.outcome.deadline)
      add('ORIGINAL_ROOT', 'GRAPH', a.id, 'Every attempt retains original Work, root and deadline');
    const parent = a.parentAssignmentId === null ? null : assignments.get(a.parentAssignmentId);
    if ((task.parentTaskId === null && a.parentAssignmentId !== null)
      || (task.parentTaskId !== null && (!parent || parent.taskId !== task.parentTaskId))
      || a.delegatorActorId !== (parent?.actorId ?? task.delegatorActorId)) add('DELEGATION_EDGE', 'GRAPH', a.id, 'Delegator and budget parent must be reconstructed from original task ancestry');
    const lineage = new Set<string>(); let cursor: WorkforceAssignment | undefined = a;
    while (cursor) {
      if (lineage.has(cursor.id)) { add('ASSIGNMENT_CYCLE', 'GRAPH', a.id, 'Assignment ancestry is cyclic'); break; }
      lineage.add(cursor.id); cursor = cursor.parentAssignmentId === null ? undefined : assignments.get(cursor.parentAssignmentId);
    }
    if (lineage.size > 8) add('DELEGATION_DEPTH_LIMIT', 'PROFILE', a.id, 'Every live lineage is bounded by depth eight');
    if (a.attempt === 1 && a.id !== `${program.id}:${task.id}:1`)
      add('UNROOTED_INITIAL_ASSIGNMENT', 'GRAPH', a.id, 'A first attempt has one deterministic original or canonical child identity');
    if (!createdAssignments.has(a.id)) add('UNROOTED_TASK_CREATION', 'GRAPH', a.id, 'An additional task or attempt requires its actual creation command');
    const currentTerms = termsById.get(a.id) ?? task.terms;
    if (!same(a.terms, currentTerms) || a.termsDigest !== digestContext.termsDigest(task, a.actorId, currentTerms, a.ceiling, creations.find(f => f.task.id === task.id)))
      add('TERMS_DIGEST', 'ACCEPTANCE', a.id, 'Current exact terms bind the immutable original, canonical child creation and exact revisions');
    if (!same(a.state, stateById.get(a.id))) add('STATE_HISTORY', 'LIFECYCLE', a.id, 'Current lifecycle is not the independently replayed immutable history');
    if (a.attempt > 1 && !program.history.some(c => c.action.kind === 'REASSIGN' && c.action.replacementAssignmentId === a.id)) add('UNROOTED_ATTEMPT', 'GRAPH', a.id, 'An additional attempt requires an actual original reassignment command');
    if (acceptedStates.has(a.state.kind) && (!accepted.has(a.id) || accepted.get(a.id)?.termsDigest !== a.termsDigest))
      add('ACCEPTANCE_REQUIRED', 'ACCEPTANCE', a.id, 'Offer, arrival and performance never substitute for actual exact acceptance');
    const acceptance = accepted.get(a.id);
    if (isLiveWorkforceAssignment(a) && acceptance?.revokedAt !== null && acceptance?.revokedAt !== undefined && Date.parse(acceptance.revokedAt) <= now)
      add('ACCEPTANCE_REVOKED', 'ACCEPTANCE', a.id, 'Current acceptance has been revoked without erasing the earlier fact');
    if (a.state.kind === 'CLOSED' && program.assignments.some(child => {
      let c: WorkforceAssignment | undefined = child; const seen = new Set<string>();
      while (c?.parentAssignmentId && !seen.has(c.id)) {
        seen.add(c.id);
        if (c.parentAssignmentId === a.id && !['CLOSED', 'DECLINED', 'EXPIRED'].includes(child.state.kind)) return true;
        c = assignments.get(c.parentAssignmentId);
      }
      return false;
    })) add('OPEN_DESCENDANT', 'GRAPH', a.id, 'A parent cannot erase an open descendant');
    if (a.state.kind === 'CLOSED' && current.obligations.some(o => o.assignmentId === a.id && o.status === 'OPEN'))
      add('OPEN_OBLIGATION', 'ACCOUNTING', a.id, 'Closure cannot release accepted labor or compensation by assertion');
    if (a.state.kind === 'CLOSED' && current.funding.some(f => f.assignmentId === a.id
      && [...quantities(f.unresolved).values()].some(values => values.some(q => q.compare(ZERO) > 0))))
      add('CLOSURE_RESIDUAL', 'ACCOUNTING', a.id, 'Unresolved S5 exposure must survive cancellation and prevents closure');
    if (!isLiveWorkforceAssignment(a)) continue;
    if (program.assignments.some(b => b.id !== a.id && b.taskId === a.taskId && isLiveWorkforceAssignment(b))) add('DUPLICATE_LIVE_TASK', 'GRAPH', a.id, 'One original funded task cannot have duplicate live leaves');
    if (task.effectId !== null && program.assignments.some(b => b.id !== a.id && isLiveWorkforceAssignment(b)
      && tasks.get(b.taskId)?.effectId === task.effectId)) add('DUPLICATE_EFFECT_BINDING', 'GRAPH', a.id, 'A possible original physical effect cannot have duplicate funded live executors');
    if (!actor || actor.tenantId !== current.tenantId || actor.status !== 'CURRENT') add('ACTOR_IDENTITY', 'SUITABILITY', a.id, 'Recipient identity must resolve currently within tenant');
    if (!actors.has(a.delegatorActorId) || actors.get(a.delegatorActorId)?.tenantId !== current.tenantId) add('ACTOR_IDENTITY', 'SUITABILITY', a.id, 'Delegator must be an actual canonical identity');
    if (!actor) continue;
    if (!task.allowedActorKinds.includes(actor.kind)
      || (task.assignmentMode === 'INTERNAL_AUTHORIZED' && ['EXTERNAL_PROFESSIONAL', 'PROVIDER'].includes(actor.kind))) add('ACTOR_PAIRING', 'SUITABILITY', a.id, 'Actual actor kind is incompatible with the original assignment semantics');
    const criterion = graph.criteria.find(c => c.id === task.criterionId);
    if (criterion && [criterion.checkerActorId, criterion.evidenceCustodianActorId].some(id => {
      const checker = actors.get(id); return !checker || checker.tenantId !== current.tenantId || checker.status !== 'CURRENT';
    })) add('CHECKER_IDENTITY', 'SUITABILITY', a.id, 'Independent checking and custody require current canonical identities');
    if (actor.id === criterion?.checkerActorId || actor.id === criterion?.evidenceCustodianActorId) add('VERIFICATION_CUSTODY', 'SUITABILITY', a.id, 'The producing actor cannot be its own independent checker or evidence custodian');
    for (const required of task.requiredCapabilities) {
      const evidence = actor.capabilities.filter(c => c.skill === required.skill && c.scope === required.scope);
      if (!evidence.some(c => c.certainty === 'OBSERVED' && Date.parse(c.validUntil) >= Date.parse(task.slot.endAt) && Date.parse(c.validUntil) > now))
        add('CAPABILITY_EVIDENCE', 'SUITABILITY', a.id, `No observed current task-scoped evidence for ${required.skill}/${required.scope}`);
    }
    if (!boundedBy(a.ceiling, task.ceiling) || !boundedBy(a.ceiling, parent?.ceiling ?? current.outcome.ceiling)
      || (parent && (!parent.terms.subdelegation || !parent.ceiling.allowSubdelegation)))
      add('EDGE_ATTENUATION', 'GRAPH', a.id, 'Child capability, data, purpose, effect, time and subdelegation ceilings exceed the original edge');
    for (const actorId of [a.actorId, a.delegatorActorId]) if (!current.grants.some(g => g.actorId === actorId && g.tenantId === current.tenantId
      && !g.revoked && Date.parse(g.ceiling.validFrom) <= now && Date.parse(g.ceiling.validUntil) > now && boundedBy(a.ceiling, g.ceiling)))
      add('CURRENT_GRANT', 'SUITABILITY', a.id, `Current independently resolved grant does not contain this assignment for ${actorId}`);
    if (now > Date.parse(task.dueAt) || now > Date.parse(a.ceiling.validUntil) || now > Date.parse(a.terms.expiresAt))
      add('CURRENT_TIME', 'SUITABILITY', a.id, 'Original due time or current terms/authority window has elapsed');
    const availability = actor.availability;
    if (availability.kind !== 'OBSERVED' || Date.parse(availability.validUntil) <= now || Date.parse(availability.validUntil) < Date.parse(task.slot.endAt)) {
      add('CAPACITY', 'SUITABILITY', a.id, 'Observed current availability is missing or expired'); continue;
    }
    const actorTasks = program.assignments.filter(b => b.actorId === a.actorId && isLiveWorkforceAssignment(b))
      .flatMap(b => { const t = tasks.get(b.taskId); return t ? [t] : []; });
    const boundaries = new Set([Date.parse(task.slot.startAt), ...actorTasks.flatMap(t => [Date.parse(t.slot.startAt), Date.parse(t.slot.endAt)])]);
    for (const point of boundaries) {
      if (point < Date.parse(task.slot.startAt) || point >= Date.parse(task.slot.endAt)) continue;
      const concurrent = actorTasks.filter(t => Date.parse(t.slot.startAt) <= point && Date.parse(t.slot.endAt) > point).length;
      const available = availability.slots.filter(s => Date.parse(s.startAt) <= point && Date.parse(s.endAt) >= Date.parse(task.slot.endAt));
      if (!available.some(s => exactQuantity(String(concurrent)).add(exactQuantity(s.committed)).compare(exactQuantity(s.capacity)) <= 0
        && exactQuantity(String(concurrent)).add(exactQuantity(s.committed)).compare(exactQuantity(String(availability.maxConcurrent))) <= 0))
        add('CAPACITY', 'SUITABILITY', a.id, 'Schedule and shared competing reservations cannot accommodate simultaneous assignments');
    }
    if (humanKind(actor.kind)) {
      const limits = availability.humanLimits;
      if (limits.kind !== 'OBSERVED' || limits.fatigue !== 'WITHIN_LIMIT') add('HUMAN_CAPACITY', 'SUITABILITY', a.id, 'Human fatigue and physical limits are unknown or exceeded');
      else {
        const effort = actorTasks.reduce((n, t) => n.add(exactQuantity(t.effortSeconds)), ZERO).add(exactQuantity(limits.alreadyCommittedSeconds));
        const physical = new ExactQuantity(BigInt(Math.max(0, Date.parse(task.slot.endAt) - Date.parse(task.slot.startAt))), 1000n);
        if (effort.compare(exactQuantity(limits.maxEffortSeconds)) > 0 || exactQuantity(task.effortSeconds).compare(physical) > 0)
          add('HUMAN_CAPACITY', 'SUITABILITY', a.id, 'Accepted human work exceeds observed physical/schedule effort limits');
      }
    }
    if (['OFFERED', 'ACCEPTED', 'IN_PROGRESS'].includes(a.state.kind) && !current.funding.some(f => f.assignmentId === a.id && f.rootId === a.rootId && f.status === 'HELD'))
      add('NATIVE_FUNDING_REQUIRED', 'ACCOUNTING', a.id, 'An offer or accepted assignment needs a current canonical S5 reservation');
  }

  type AccountingNode = { id: string; parent: string | null; assignmentId: string | null; cap: WorkforceTask['demand']; direct: ExactVector; held: boolean };
  const nodes = new Map<string, AccountingNode>();
  const fundingByAssignment = new Map<string, WorkforceCompilerInput['funding'][number]>();
  for (const f of current.funding) {
    const a = assignments.get(f.assignmentId);
    if (f.rootId !== current.outcome.rootId) {
      if (a) add('FUNDING_ROOT', 'ACCOUNTING', a.id, 'Funding cannot acquire a foreign resource root'); continue;
    }
    const key = f.ref.id;
    if (nodes.has(key) || fundingByAssignment.has(f.assignmentId)) add('DUPLICATE_RESERVATION', 'ACCOUNTING', f.assignmentId, 'A canonical reservation can fund exactly one assignment once');
    fundingByAssignment.set(f.assignmentId, f);
    if (!a) add('DANGLING_FUNDING', 'ACCOUNTING', f.assignmentId, 'All failed and open attempts must remain reconstructible in the graph');
    const parent = a?.parentAssignmentId ? current.funding.find(p => p.assignmentId === a.parentAssignmentId) : null;
    if (a && f.parentReservationId !== (parent?.ref.id ?? null)) add('FUNDING_ANCESTRY', 'ACCOUNTING', a.id, 'Reservation ancestry must match original assignment ancestry');
    if (f.status === 'RELEASED' && [...quantities(f.directReserved).values()].some(v => v.some(q => q.compare(ZERO) > 0)))
      add('FALSE_CAPACITY_RELEASE', 'ACCOUNTING', f.assignmentId, 'Released reservation retains a direct live hold');
    nodes.set(key, { id: key, parent: f.parentReservationId, assignmentId: f.assignmentId, cap: f.envelope,
      direct: addVectors(addVectors(quantities(f.directReserved), quantities(f.spent)), quantities(f.unresolved)), held: f.status === 'HELD' });
    const task = a ? tasks.get(a.taskId) : null;
    if (task && !withinResourceEnvelope(quantities(f.envelope), task.demand)) add('RESERVATION_CEILING', 'ACCOUNTING', a?.id ?? null, 'Native reservation exceeds the original task resource ceiling');
  }
  for (const a of program.assignments) {
    if (fundingByAssignment.has(a.id) || !isLiveWorkforceAssignment(a)) continue;
    const task = tasks.get(a.taskId); if (!task) continue;
    const parent = a.parentAssignmentId === null ? null : fundingByAssignment.get(a.parentAssignmentId)?.ref.id ?? `proposal:${a.parentAssignmentId}`;
    nodes.set(`proposal:${a.id}`, { id: `proposal:${a.id}`, parent, assignmentId: a.id, cap: task.demand, direct: quantities([]), held: true });
  }
  const charged = new Map<string, ExactVector>(); const path = new Set<string>();
  function charge(node: AccountingNode): ExactVector {
    const known = charged.get(node.id); if (known) return known;
    if (path.has(node.id)) { add('BUDGET_ANCESTRY_CYCLE', 'ACCOUNTING', node.assignmentId, 'Canonical budget ancestry must remain acyclic even with reciprocal requests'); return quantities(node.cap); }
    path.add(node.id);
    let total = node.direct;
    for (const child of nodes.values()) if (child.parent === node.id) total = addVectors(total, charge(child));
    if (!withinResourceEnvelope(total, node.cap)) add('RESOURCE_LIMIT', 'ACCOUNTING', node.assignmentId, 'Direct work, spent, unresolved exposure and carved child frontier exceed the exact parent envelope');
    const result = node.held ? quantities(node.cap) : total;
    path.delete(node.id); charged.set(node.id, result); return result;
  }
  let rootCharge = quantities([]);
  for (const n of nodes.values()) {
    if (n.parent !== null && !nodes.has(n.parent)) add('DANGLING_RESERVATION', 'ACCOUNTING', n.assignmentId, 'No copied or detached funding ancestry is allowed');
    const q = charge(n);
    if (n.parent === null) rootCharge = addVectors(rootCharge, q);
  }
  if (!withinResourceEnvelope(rootCharge, current.outcome.resourceLimits)) add('RESOURCE_LIMIT', 'ACCOUNTING', null, 'Original root grant is exceeded by active frontier, direct work and retained failed-attempt exposure');
  for (const f of current.funding) for (const envelopes of [f.envelope, f.directReserved, f.spent, f.unresolved])
    if (new Set(envelopes.map(coordinate)).size !== envelopes.length) add('DUPLICATE_RESOURCE_COORDINATE', 'ACCOUNTING', f.assignmentId, 'Resource coordinates must be canonical and unique within each accounting category');
  for (const effect of current.effects) {
    const a = assignments.get(effect.assignmentId);
    if (!a) { if (effect.rootId === current.outcome.rootId) add('DANGLING_POSSIBLE_EFFECT', 'GRAPH', null, 'An original possible effect cannot disappear with its actor'); continue; }
    const task = tasks.get(a.taskId);
    if (effect.rootId !== current.outcome.rootId || effect.effectId !== task?.effectId) add('EFFECT_IDENTITY', 'GRAPH', a.id, 'Every possible effect retains the original S6 identity and root');
    if (['MAY_HAVE_LEFT', 'UNKNOWN'].includes(effect.status)) {
      const reconciled = current.reconciliations.some(r => r.authority === 'S6'
        && (same(r.ref, effect.reconciliationRef) || program.history.some(c => c.assignmentId === effect.assignmentId
          && c.action.kind === 'RECONCILE' && same(c.action.reconciliationRef, r.ref)))
        && r.effectId === effect.effectId && r.rootId === effect.rootId && r.status !== 'UNKNOWN'
        && Date.parse(r.at) >= Date.parse(effect.at) && Date.parse(r.at) <= now);
      if (!reconciled) add('POSSIBLE_EFFECT', 'USE', a.id, 'MAY_HAVE_LEFT or UNKNOWN is sticky until authoritative original S6 reconciliation');
    }
  }
  for (const invalidation of current.dependencyInvalidations ?? []) for (const id of invalidation.assignmentIds) {
    if (!assignments.has(id)) add('DEPENDENCY_COVERAGE', 'GRAPH', null, 'Changed canonical dependency names an omitted assignment');
    else add('CANONICAL_DEPENDENCY_CHANGED', 'USE', id, `${invalidation.sourceKind}:${invalidation.sourceId} no longer matches the checked original dependency pin`);
  }
  const affected = new Set(issues.flatMap(i => i.assignmentId === null ? program.assignments.map(a => a.id) : [i.assignmentId]));
  let changed = true;
  while (changed) {
    changed = false;
    const affectedTasks = new Set([...affected].flatMap(id => { const a = assignments.get(id); return a ? [a.taskId] : []; }));
    for (const a of program.assignments) {
      const task = tasks.get(a.taskId);
      if (!affected.has(a.id) && ((a.parentAssignmentId !== null && affected.has(a.parentAssignmentId))
        || task?.dependsOn.some(id => affectedTasks.has(id))
        || program.assignments.some(other => affected.has(other.id) && tasks.get(other.taskId)?.returnTo.includes(a.taskId))
        || creations.some(c => c.parentAssignmentId === a.id && affectedTasks.has(c.task.id)))) { affected.add(a.id); changed = true; }
    }
  }
  return { valid: issues.length === 0, issues, affectedAssignmentIds: [...affected],
    checked: { actors: current.actors.length, assignments: program.assignments.length, tasks: graph.tasks.length,
      maximumDepth, fundingRecords: current.funding.length, possibleEffects: current.effects.length }, executionAuthorityGranted: false };
}

export function checkWorkforceUse(program: WorkforceExecutionProgram, assignmentId: string, current: WorkforceCompilerInput): WorkforceCheck & { allowed: boolean } {
  const checked = checkWorkforceExecutionProgram(program, current);
  const assignment = program.assignments.find(a => a.id === assignmentId);
  const task = workforceProgramGraph(program).tasks.find(t => t.id === assignment?.taskId);
  const extra: WorkforceIssue[] = [];
  if (task && (Date.parse(current.now) < Math.max(Date.parse(task.slot.startAt), Date.parse(assignment!.ceiling.validFrom)) ||
      Date.parse(current.now) >= Date.parse(task.slot.endAt)))
    extra.push({ code: 'TASK_WINDOW_NOT_OPEN', boundary: 'USE', assignmentId, detail: 'Performance stays within the actual original schedule and authority window' });
  if (!assignment || assignment.state.kind !== 'IN_PROGRESS') extra.push({ code: 'NOT_IN_PROGRESS', boundary: 'USE', assignmentId, detail: 'Acceptance is not arrival or performance' });
  if (task?.dependsOn.some(id => !program.assignments.some(a => a.taskId === id && ['VERIFIED', 'CLOSED'].includes(a.state.kind))))
    extra.push({ code: 'DEPENDENCY_NOT_VERIFIED', boundary: 'USE', assignmentId, detail: 'Original prerequisite evidence has not been independently verified' });
  if (workforceRequiredChildren(program, assignmentId).some(a => !workforceChildIsVerified(program, a)))
    extra.push({ code: 'REQUESTED_WORK_UNVERIFIED', boundary: 'USE', assignmentId, detail: 'Required returned work has not been independently verified' });
  if (task?.effectId !== null && task?.effectId !== undefined && !current.effects.some(e => e.assignmentId === assignmentId
    && e.effectId === task.effectId && e.rootId === current.outcome.rootId))
    extra.push({ code: 'ORIGINAL_S6_IDENTITY_REQUIRED', boundary: 'USE', assignmentId, detail: 'An effectful task must resolve its original native S6 identity before any use' });
  return { ...checked, allowed: extra.length === 0 && !checked.affectedAssignmentIds.includes(assignmentId),
    issues: [...checked.issues, ...extra], executionAuthorityGranted: false };
}

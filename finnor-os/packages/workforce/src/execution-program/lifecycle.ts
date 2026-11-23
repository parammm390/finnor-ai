import { checkWorkforceExecutionProgram, checkWorkforceUse } from './checker';
import { workforceDigest } from './exact';
import { workforceCandidateReasons } from './compiler';
import { workforceAssignmentTermsDigest, workforceProgramGraph } from './graph';
import type { AuthenticatedWorkforceCommand, WorkforceAssignment, WorkforceCommandResult, WorkforceCompilerInput, WorkforceExecutionProgram, WorkforceIssue, WorkforceState } from './schema';

const same = (a: unknown, b: unknown) => workforceDigest(a) === workforceDigest(b);

export function applyWorkforceCommand(program: WorkforceExecutionProgram, command: AuthenticatedWorkforceCommand, current: WorkforceCompilerInput): WorkforceCommandResult {
  const reject = (code: string, detail: string, issues?: WorkforceIssue[]): WorkforceCommandResult => ({
    status: 'REJECTED', program, issues: issues ?? [{ code, detail, boundary: 'LIFECYCLE', assignmentId: command.assignmentId }], executionAuthorityGranted: false,
  });
  if (program.id !== current.programId || program.tenantId !== current.tenantId || program.principalId !== current.principalId)
    return reject('PROGRAM_IDENTITY', 'Current tenant/principal/Work programme is different');
  if (program.sourceClass !== current.sourceClass)
    return reject('SOURCE_CLASS_MISMATCH', 'Command replay cannot upgrade or merge independently resolved evidence populations');
  const assignment = program.assignments.find(a => a.id === command.assignmentId);
  const task = workforceProgramGraph(program).tasks.find(t => t.id === assignment?.taskId);
  if (!assignment || !task) return reject('ASSIGNMENT_UNKNOWN', 'Command does not name an original assignment and task');
  if (!current.actors.some(a => a.id === command.actorId && a.tenantId === current.tenantId && a.status === 'CURRENT'))
    return reject('COMMAND_ACTOR', 'Only a current canonical authenticated actor can issue a new command');
  const before = checkWorkforceExecutionProgram(program, current);
  if (before.issues.some(i => i.code === 'HISTORY_ANCHOR_MISMATCH'))
    return reject('HISTORY_ANCHOR_MISMATCH', 'Even idempotent replay must preserve the independently resolved latest committed prefix',
      before.issues.filter(i => i.code === 'HISTORY_ANCHOR_MISMATCH'));
  const prior = program.history.find(c => c.id === command.id);
  if (prior) return same(prior, command)
    ? { status: 'IDEMPOTENT', program, issues: [], executionAuthorityGranted: false }
    : reject('COMMAND_ID_COLLISION', 'An idempotency key cannot authorize different command bytes');
  if (program.revision !== command.expectedRevision) return reject('STALE_REVISION', 'Native persistence must compare-and-swap the exact programme revision');
  const now = Date.parse(current.now);
  const authority = current.commandAuthorities.find(a => same(a.ref, command.authorityRef) && a.commandId === command.id
    && a.actorId === command.actorId && a.assignmentId === command.assignmentId && a.commandDigest === workforceDigest(command)
    && a.actions.includes(command.action.kind) && Date.parse(a.validFrom) <= Date.parse(command.at)
    && Date.parse(a.validUntil) >= now && Date.parse(command.at) <= now);
  if (!authority) return reject('COMMAND_AUTHORITY', 'Runtime must authenticate this exact command and separately resolve its still-current authority');
  if (command.action.kind === 'START') {
    const acceptance = program.history.some(c => c.assignmentId === assignment.id && c.action.kind === 'ACCEPT'
      && current.dispositions.some(d => same(d.ref, c.action.kind === 'ACCEPT' ? c.action.dispositionRef : null)
        && d.termsDigest === assignment.termsDigest && d.revokedAt === null));
    if (!acceptance) return reject('ACCEPTANCE_REQUIRED', 'A current exact disposition, not arrival or silence, authorizes starting');
    const readiness = checkWorkforceUse(program, assignment.id, current);
    if (readiness.affectedAssignmentIds.includes(assignment.id) ||
        readiness.issues.some(issue => issue.boundary === 'USE' && issue.code !== 'NOT_IN_PROGRESS' &&
          (issue.assignmentId === null || issue.assignmentId === assignment.id)))
      return reject('CURRENT_USE_FENCED', 'Starting cannot bypass original readiness or requested-work conditions', readiness.issues);
  }
  if (command.action.kind === 'DELIVER') {
    const use = checkWorkforceUse(program, assignment.id, current);
    if (!use.allowed) return reject('CURRENT_USE_FENCED', 'Delivery cannot bypass original current-use conditions', use.issues);
  }
  const next = structuredClone(program);
  const selected = next.assignments.find(a => a.id === assignment.id);
  if (!selected) return reject('ASSIGNMENT_UNKNOWN', 'Assignment was not preserved by immutable cloning');
  const action = command.action;
  const creation = program.taskCreations?.find(c => c.task.id === task.id);
  let state: WorkforceState;
  switch (action.kind) {
    case 'OFFER': state = { kind: 'OFFERED', ref: action.offerRef }; break;
    case 'ACCEPT': state = { kind: 'ACCEPTED', ref: action.dispositionRef }; break;
    case 'DECLINE': state = { kind: 'DECLINED', ref: action.dispositionRef }; break;
    case 'START': state = { kind: 'IN_PROGRESS', ref: action.observationRef }; break;
    case 'BLOCK': state = { kind: 'BLOCKED', ref: action.observationRef, reason: action.reason }; break;
    case 'DELIVER': state = { kind: 'DELIVERED', ref: action.deliveryRef }; break;
    case 'VERIFY': state = { kind: 'VERIFIED', ref: action.verificationRef }; break;
    case 'DISPUTE': state = { kind: 'DISPUTED', ref: action.observationRef, reason: action.reason }; break;
    case 'RETURN': state = { kind: 'RETURNED', ref: action.observationRef, reason: action.reason }; break;
    case 'EXPIRE': state = { kind: 'EXPIRED', ref: action.observationRef }; break;
    case 'CANCEL': state = { kind: 'CANCEL_REQUESTED', ref: action.observationRef }; break;
    case 'CONFIRM_CANCEL': state = { kind: 'CANCELLED_WITH_RESIDUAL_EXPOSURE', ref: action.observationRef }; break;
    case 'MARK_UNKNOWN_EFFECT': state = { kind: 'UNKNOWN_EFFECT', ref: action.effectRef }; break;
    case 'RECONCILE': {
      const r = current.reconciliations.find(r => same(r.ref, action.reconciliationRef) && r.effectId === task.effectId && r.rootId === assignment.rootId);
      state = r?.status === 'UNKNOWN' ? { kind: 'UNKNOWN_EFFECT', ref: action.reconciliationRef }
        : { kind: 'BLOCKED', ref: action.reconciliationRef, reason: 'Reconciled. Requires current owner continuation.' }; break;
    }
    case 'CLOSE': state = { kind: 'CLOSED', ref: action.observationRef }; break;
    case 'REVISE_TERMS': {
      const change = current.termChanges.find(t => same(t.ref, action.termChangeRef) && t.taskId === assignment.taskId);
      if (!change) return reject('TERMS_REVISION', 'New exact terms must resolve from the canonical terms owner');
      selected.terms = structuredClone(change.terms);
      selected.termsDigest = workforceAssignmentTermsDigest(current.outcome, task, assignment.actorId, change.terms, selected.ceiling, creation);
      state = { kind: 'PROPOSED' }; break;
    }
    case 'REASSIGN': {
      if (next.assignments.some(a => a.id === action.replacementAssignmentId)) return reject('DUPLICATE_REPLACEMENT', 'Replacement assignment identity already exists');
      const replacement: WorkforceAssignment = {
        ...structuredClone(assignment), id: action.replacementAssignmentId, actorId: action.replacementActorId,
        attempt: assignment.attempt + 1, state: { kind: 'PROPOSED' },
        termsDigest: workforceAssignmentTermsDigest(current.outcome, task, action.replacementActorId, assignment.terms, assignment.ceiling, creation),
      };
      next.assignments.push(replacement);
      state = { kind: 'RETURNED', ref: command.authorityRef, reason: 'Reassigned with original continuity retained' }; break;
    }
    case 'SUBDELEGATE': {
      const fact = current.taskCreations?.find(c => same(c.ref, action.taskCreationRef));
      if (!fact || fact.parentAssignmentId !== assignment.id || fact.actorId !== command.actorId
        || fact.parentTermsDigest !== assignment.termsDigest || command.actorId !== assignment.actorId
        || !['ACCEPTED', 'IN_PROGRESS', 'BLOCKED'].includes(assignment.state.kind)
        || !assignment.terms.subdelegation || !assignment.ceiling.allowSubdelegation)
        return reject('TASK_CREATION_AUTHORITY', 'An accepted recipient and canonical exact bounded child-work observation are required');
      if (next.assignments.some(a => a.id === fact.assignmentId || a.taskId === fact.task.id)
        || workforceProgramGraph(next).tasks.some(t => t.id === fact.task.id))
        return reject('DUPLICATE_TASK_CREATION', 'A child task and its first assignment can be created only once');
      const recipient = current.actors.find(a => a.id === fact.recipientActorId);
      const reasons = recipient ? workforceCandidateReasons(recipient, fact.task, current, next.assignments) : ['IDENTITY_NOT_CURRENT'];
      if (reasons.length) return reject('CHILD_NOT_ELIGIBLE', reasons.join(','));
      next.taskCreations = [...(next.taskCreations ?? []), structuredClone(fact)];
      next.assignments.push({ id: fact.assignmentId, taskId: fact.task.id, actorId: fact.recipientActorId,
        delegatorActorId: assignment.actorId, parentAssignmentId: assignment.id,
        rootId: assignment.rootId, workId: assignment.workId, originalDeadline: assignment.originalDeadline, attempt: 1,
        terms: structuredClone(fact.task.terms), ceiling: structuredClone(fact.task.ceiling),
        termsDigest: workforceAssignmentTermsDigest(current.outcome, fact.task, fact.recipientActorId, fact.task.terms, fact.task.ceiling, fact),
        state: { kind: 'PROPOSED' } });
      state = structuredClone(selected.state); break;
    }
    case 'REVOKE': state = { kind: 'BLOCKED', ref: action.observationRef, reason: action.reason }; break;
    default: { const exhaustive: never = action; return reject('COMMAND_UNSUPPORTED', String(exhaustive)); }
  }
  selected.state = state;
  next.revision++;
  next.history.push(structuredClone(command));
  const after = checkWorkforceExecutionProgram(next, current);
  const recovery = ['BLOCK', 'RETURN', 'CANCEL', 'CONFIRM_CANCEL', 'MARK_UNKNOWN_EFFECT', 'RECONCILE', 'DISPUTE', 'REVOKE'].includes(action.kind);
  const oldIssues = new Set(before.issues.map(i => workforceDigest(i)));
  const newIssues = after.issues.filter(i => !oldIssues.has(workforceDigest(i)));
  if (newIssues.length) return reject('INVARIANT_REJECTED', 'Command would violate independently reconstructed lifecycle or graph invariants', newIssues);
  if (!recovery && after.affectedAssignmentIds.includes(assignment.id)) return reject('CURRENTNESS_FENCED', 'Current canonical suitability or authority fences this assignment', after.issues);
  if (action.kind === 'REASSIGN' && after.affectedAssignmentIds.includes(action.replacementAssignmentId))
    return reject('REPLACEMENT_FENCED', 'Replacement is not currently lawful or feasible', after.issues);
  if (action.kind === 'SUBDELEGATE') {
    const fact = next.taskCreations?.find(c => same(c.ref, action.taskCreationRef));
    if (!fact || after.affectedAssignmentIds.includes(fact.assignmentId))
      return reject('CHILD_FENCED', 'New child work is not currently lawful or feasible', after.issues);
  }
  return { status: 'APPLIED', program: next, issues: [], executionAuthorityGranted: false };
}

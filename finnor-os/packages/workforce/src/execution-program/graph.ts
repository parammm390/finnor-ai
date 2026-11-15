import { workforceDigest } from './exact';
import type { WorkforceAssignment, WorkforceCeiling, WorkforceCompilerInput, WorkforceExecutionProgram, WorkforceTask, WorkforceTaskCreation, WorkforceTerms } from './schema';

export function workforceProgramGraph(program: WorkforceExecutionProgram) {
  return {
    tasks: [...program.originalOutcome.tasks, ...(program.taskCreations ?? []).map(c => c.task)],
    criteria: [...program.originalOutcome.criteria, ...(program.taskCreations ?? []).map(c => c.criterion)],
  };
}

export function workforceCanonicalGraph(input: WorkforceCompilerInput) {
  return {
    tasks: [...input.outcome.tasks, ...(input.taskCreations ?? []).map(c => c.task)],
    criteria: [...input.outcome.criteria, ...(input.taskCreations ?? []).map(c => c.criterion)],
  };
}

export function workforceAssignmentTermsDigest(outcome: WorkforceCompilerInput['outcome'], task: WorkforceTask,
  actorId: string, terms: WorkforceTerms, ceiling: WorkforceCeiling, creation?: WorkforceTaskCreation) {
  return workforceTermsDigestContext(outcome).termsDigest(task, actorId, terms, ceiling, creation);
}

/** A fresh private context per compile/check invocation. No caller-supplied
 * digest, global memoization or cache spanning mutable canonical revisions. */
export function workforceTermsDigestContext(outcome: WorkforceCompilerInput['outcome']) {
  const originalOutcomeDigest = workforceDigest(outcome), rootId = outcome.rootId, originalDeadline = outcome.deadline;
  return { originalOutcomeDigest, termsDigest(task: WorkforceTask, actorId: string, terms: WorkforceTerms,
    ceiling: WorkforceCeiling, creation?: WorkforceTaskCreation) {
    const binding = { originalOutcomeDigest, taskId: task.id, actorId,
      rootId, originalDeadline, dueAt: task.dueAt, terms, ceiling, context: task.context };
    return workforceDigest(creation ? { ...binding, taskCreationDigest: workforceDigest(creation) } : binding);
  } };
}

export function workforceRequiredChildren(program: WorkforceExecutionProgram, assignmentId: string): WorkforceAssignment[] {
  return (program.taskCreations ?? []).filter(c => c.parentAssignmentId === assignmentId).flatMap(c => {
    const attempts = program.assignments.filter(a => a.taskId === c.task.id).sort((a, b) => b.attempt - a.attempt);
    return attempts[0] ? [attempts[0]] : [];
  });
}

export function workforceChildIsVerified(program: WorkforceExecutionProgram, assignment: WorkforceAssignment) {
  return ['VERIFIED', 'CLOSED'].includes(assignment.state.kind)
    && program.history.some(c => c.assignmentId === assignment.id && c.action.kind === 'VERIFY');
}

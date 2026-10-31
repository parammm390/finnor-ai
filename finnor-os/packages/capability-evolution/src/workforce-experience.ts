/** Owner-resolved, non-admitted task experience. S1 retains the observation;
 * qualification, X5 training consent and S8 admission are deliberately separate. */
import type { PoolClient } from "pg";
import type { TenantContext } from "@finnor/shared-types";
import { checkWorkforceExecutionProgram, workforceDigest, workforceProgramGraph } from "../../workforce/src/execution-program";
import { evidence, event, events, programRow, reject, resolveCanonicalInput } from "../../orchestration/src/workforce-execution/store";

export async function recordWorkforceOutcomeExperienceTx(ctx: TenantContext, c: PoolClient,
  programmeId: string, assignmentId: string) {
  const q = await programRow(ctx, programmeId, c), all = await events(ctx, q, c);
  const key = "outcome-experience:" + assignmentId + ":" + q.revision;
  const prior = all.find(event => event.event_id === key);
  if (prior) return { ref: prior.body.ref, key, observation: prior.body.observation };
  const assignment = q.program?.assignments.find(value => value.id === assignmentId);
  if (!assignment || !q.program) reject("S8_ORIGINAL_WORKFORCE_ASSIGNMENT_REQUIRED");
  const canonical = await resolveCanonicalInput(ctx, q, c), check = checkWorkforceExecutionProgram(q.program, canonical);
  const task = workforceProgramGraph(q.program).tasks.find(value => value.id === assignment.taskId)!;
  const delivery = all.filter(event => event.kind === "DELIVERY" &&
    (event.body.observation as { assignmentId?: string })?.assignmentId === assignmentId).at(-1);
  const verification = all.filter(event => event.kind === "VERIFICATION" &&
    (event.body.observation as { assignmentId?: string })?.assignmentId === assignmentId).at(-1);
  const physical = all.filter(event => ["S6_INTENDED", "S6_OBSERVATION", "READ_ONLY_RECOVERY"].includes(event.kind) &&
    event.body.assignmentId === assignmentId);
  const consumption = (await c.query(`SELECT co.body,st.status FROM finnor_os.s5_consumptions co
    JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
    WHERE co.tenant_id=$1 AND co.reservation_id=$2 AND co.body->>'nodeId'=$3 ORDER BY consumption_id LIMIT 2049`,
    [ctx.tenantId, q.budget.reservationRef.id, assignmentId])).rows;
  if (consumption.length > 2048) reject("S8_WORKFORCE_EXPERIENCE_CUT_INCOMPLETE");
  const economics = (await c.query(`SELECT record_id,content_digest,body FROM finnor_os.s7_economic_records
    WHERE tenant_id=$1 AND principal_id=$2 AND body->'payload'->>'programmeId'=$3
    ORDER BY knowledge_at,record_id LIMIT 2050`, [ctx.tenantId, q.principal_id, q.id])).rows;
  if (economics.length > 2049) reject("S8_WORKFORCE_COST_CUT_INCOMPLETE");
  const result = (verification?.body.observation as { result?: string } | undefined)?.result ?? "UNKNOWN";
  const observation = { schema: "finnor.s8.workforce-outcome-experience.v1", semanticOwner: "S8",
    tenantId: q.tenant_id, principalId: q.principal_id, originalWorkId: q.work_id, originalInputId: q.work_input_id,
    originalOutcomeDigest: q.program.originalOutcomeDigest, originalBudget: q.budget.ref,
    originalDeadline: q.original.outcome.deadline, programmeId: q.id, revision: q.revision, assignmentId,
    actorId: assignment.actorId, taskId: task.id, requiredSkills: task.requiredCapabilities,
    parentAssignmentId: assignment.parentAssignmentId,
    taskCreationRef: q.program.taskCreations?.find(value => value.task.id === task.id)?.ref ?? null,
    assignmentStateAtCut: assignment.state.kind,
    canonicalAvailabilityAtCut: canonical.actors.find(actor => actor.id === assignment.actorId)?.availability ?? null,
    acceptedObligationHistory: all.filter(value => value.kind === "OBLIGATION" &&
      (value.body.observation as { assignmentId?: string })?.assignmentId === assignmentId).map(value => value.body),
    sourceClass: q.original.sourceClass, knowledgeAt: new Date().toISOString(), result,
    resultCurrentlySupported: result === "SATISFIED" && !check.affectedAssignmentIds.includes(assignmentId) &&
      consumption.every(row => row.status === "RECONCILED"),
    delivery: delivery?.body ?? null, independentVerification: verification?.body ?? null,
    physicalHistory: physical.map(event => ({ id: event.event_id, kind: event.kind, body: event.body })),
    retainedResources: consumption, economicRecordRefs: economics.map(row => ({
      owner: "S7", id: row.record_id, version: "1", contentDigest: row.content_digest })),
    currentCheckDigest: workforceDigest(check), currentIssueCodes: check.issues.map(issue => issue.code),
    capabilityPromotionGranted: false, trainingRightsGranted: false, admissionGranted: false,
    causalReward: null, reputationJudgment: null, genuineHumanQualified: false,
    uncertainty: ["OPERATIONAL_RESULT_NOT_A_GENERAL_QUALIFICATION", "NO_X5_TRAINING_CONSENT",
      "MONEY_AND_HUMAN_SUPERVISION_NOT_IDENTIFIED", ...(consumption.some(row => row.status !== "RECONCILED") ? ["UNRESOLVED_ORIGINAL_RESOURCE_USE"] : [])] };
  const ref = await evidence(ctx, q, key, observation, c);
  await event(ctx, q, "S8_OUTCOME_OBSERVATION", key, { ref, observation,
    capabilityPromotionGranted: false, trainingRightsGranted: false }, c);
  return { ref, key, observation };
}

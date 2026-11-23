/** A concrete S6 observation reader for the existing finite local executor.
 * This is not protected execution admission, a human callback or an egress
 * receipt. An unknown/missing attempt never becomes safe merely by timing out. */
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { ExperimentRef, TenantContext } from "@finnor/shared-types";
import { allocationRef, sameAllocationRef } from "../../epistemic-runtime/src/allocation-contracts";
import { nativeWorkforceOriginalSchema, nativeWorkforceTaskCreationRecordSchema,
  workforceComputationSchema, WorkforceRuntimeError } from "../../orchestration/src/workforce-execution/contracts";
import { workforceDigest } from "../../workforce/src/execution-program/exact";

export const workforceLocalExecutorScript = `let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>1048576)throw Error('INPUT_BOUND');}
const input=JSON.parse(text);let value;
if(input.kind==='SUM_INTEGERS'){if(!Array.isArray(input.values)||input.values.length>4096||input.values.some(v=>typeof v!=='string'||!(/^-?(0|[1-9][0-9]{0,95})$/).test(v)))throw Error('INTEGER_INPUT');value=input.values.reduce((s,v)=>s+BigInt(v),0n).toString();}
else if(input.kind==='SORT_STRINGS'){if(!Array.isArray(input.values)||input.values.length>4096||input.values.some(v=>typeof v!=='string'||v.length>256))throw Error('STRING_INPUT');value=input.values.slice().sort();}
else throw Error('UNSUPPORTED_COMPUTATION');
console.log(JSON.stringify({value}));`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const fail = (code: string): never => { throw new WorkforceRuntimeError(code, 409); };

export async function readKnownWorkforceLocalAttemptTx(ctx: TenantContext, c: PoolClient,
  programmeId: string, assignmentId: string, originalBudget: ExperimentRef, originalReservation: ExperimentRef) {
  const q = (await c.query(`SELECT id,work_id,original_digest,original,program,budget FROM finnor_os.w2_programs
    WHERE tenant_id=$1 AND id=$2 AND principal_id=$3`,
  [ctx.tenantId, programmeId, ctx.employeeId ?? ctx.userId])).rows[0];
  if (!q?.program || !sameAllocationRef(q.budget.ref, originalBudget) ||
      !sameAllocationRef(q.budget.reservationRef, originalReservation))
    fail("WORKFORCE_S6_ORIGINAL_PROGRAMME_REQUIRED");
  const original = nativeWorkforceOriginalSchema.parse(q.original);
  const assignment = q.program.assignments.find((value: { id: string }) => value.id === assignmentId);
  if (!assignment || q.program.assignments.some((value: { parentAssignmentId: string | null }) =>
    value.parentAssignmentId === assignmentId)) fail("WORKFORCE_S6_DESCENDANT_OWNER_RECONCILIATION_REQUIRED");
  let task = original.outcome.tasks.find(value => value.id === assignment.taskId);
  let computation = original.operations.find(value => value.taskId === assignment.taskId)?.computation;
  if (!task) {
    const rows = (await c.query(`SELECT e.event_id,e.body,v.content,v.content_hash,s.source_key
      FROM finnor_os.w2_events e
      JOIN finnor_os.evidence_source_versions v ON v.tenant_id=e.tenant_id
        AND v.id::text=e.body->'observation'->'ref'->>'id'
      JOIN finnor_os.evidence_sources s ON s.tenant_id=v.tenant_id AND s.id=v.source_id
      WHERE e.tenant_id=$1 AND e.program_id=$2 AND e.kind='TASK_CREATION'
        AND e.body->'observation'->'task'->>'id'=$3 LIMIT 2`,
    [ctx.tenantId, programmeId, assignment.taskId])).rows;
    if (rows.length !== 1) fail("WORKFORCE_S6_ORIGINAL_TASK_SOURCE_REQUIRED");
    const row = rows[0]!, record = nativeWorkforceTaskCreationRecordSchema.parse(JSON.parse(row.content));
    if (sha(row.content) !== row.content_hash || row.content_hash !== row.body.observation.ref.contentDigest ||
        row.source_key !== `workforce:${programmeId}:${row.event_id}` ||
        record.programmeId !== programmeId || record.originalWorkId !== q.work_id ||
        record.originalMeaningDigest !== q.original_digest || record.task.id !== assignment.taskId ||
        record.authenticatedPrincipalId !== row.body.authenticatedPrincipal ||
        workforceDigest(record.task) !== workforceDigest(row.body.observation.task))
      fail("WORKFORCE_S6_ORIGINAL_TASK_PREIMAGE_CHANGED");
    task = record.task; computation = record.computation;
  }
  if (!task || task.effectId !== null || task.ceiling.effects.length || !computation ||
      computation.kind === "PARTICIPANT_INPUT") fail("WORKFORCE_S6_EFFECT_OWNER_RECONCILIATION_REQUIRED");
  computation = workforceComputationSchema.parse(computation);
  const events = (await c.query(`SELECT event_id,kind,body FROM finnor_os.w2_events
    WHERE tenant_id=$1 AND program_id=$2 AND (body->>'assignmentId'=$3 OR
      body->'observation'->>'assignmentId'=$3) AND kind IN
      ('S6_INTENDED','S6_OBSERVATION','READ_ONLY_RECOVERY','EFFECT','RECONCILIATION') LIMIT 4`,
  [ctx.tenantId, programmeId, assignmentId])).rows;
  const intended = events.filter(value => value.kind === "S6_INTENDED");
  const observed = events.filter(value => value.kind === "S6_OBSERVATION");
  if (events.length !== 2 || intended.length !== 1 || observed.length !== 1)
    fail("WORKFORCE_S6_WHOLE_KNOWN_ATTEMPT_REQUIRED");
  const intent = intended[0]!, observation = observed[0]!, result = observation.body.execution;
  if (intent.body.egressAuthority !== "NONE" || intent.body.originalRoot !== q.work_id ||
      intent.body.originalDeadline !== original.outcome.deadline || intent.body.protectedReceipt !== null ||
      intent.body.scriptDigest !== workforceDigest(workforceLocalExecutorScript) ||
      intent.body.inputDigest !== workforceDigest(computation) ||
      observation.body.physicalClaim !== intent.body.claimFence ||
      result?.exitCode !== 0 || result.termination !== "EXITED" || result.signal !== null ||
      result.provenance?.schema !== "finnor.s6.executor-provenance.v1" ||
      result.provenance.authority !== "NONE_OUTPUT_UNTRUSTED" ||
      result.provenance.scriptDigest !== sha(workforceLocalExecutorScript) ||
      result.provenance.inputDigest !== sha(JSON.stringify(computation)) ||
      result.provenance.compute?.cost?.externalCalls !== 0)
    fail("WORKFORCE_S6_ATTEMPT_NOT_KNOWN_NO_EGRESS");
  const ref = observation.body.evidenceRef;
  const version = (await c.query(`SELECT v.content,v.content_hash,v.version_number,s.source_key
    FROM finnor_os.evidence_source_versions v JOIN finnor_os.evidence_sources s
      ON s.tenant_id=v.tenant_id AND s.id=v.source_id WHERE v.tenant_id=$1 AND v.id::text=$2`,
  [ctx.tenantId, ref?.id ?? ""])).rows[0];
  if (!version || ref.owner !== "S1" || version.source_key !== `workforce:${programmeId}:s6:${assignmentId}` ||
      version.content_hash !== ref.contentDigest || sha(version.content) !== ref.contentDigest ||
      String(version.version_number) !== ref.version) fail("WORKFORCE_S6_OBSERVATION_PREIMAGE_UNAVAILABLE");
  const source = JSON.parse(version.content);
  if (source.schema !== "finnor.workforce-s6-observation.v1" || source.assignmentId !== assignmentId ||
      source.authority !== "NONE_OUTPUT_UNTRUSTED" || source.producerReceivedHiddenCriterion !== false ||
      workforceDigest(source.result) !== workforceDigest(result) ||
      workforceDigest(source.value) !== workforceDigest(observation.body.value) ||
      workforceDigest(JSON.parse(result.stdout).value) !== workforceDigest(source.value))
    fail("WORKFORCE_S6_OBSERVATION_PREIMAGE_CHANGED");
  const body = { schema: "finnor.s6.known-local-workforce-attempt.v1", programmeId, assignmentId,
    taskId: assignment.taskId, originalRoot: q.work_id, originalDeadline: original.outcome.deadline,
    originalBudget, originalReservation, consumptionRef: intent.body.consumptionRef as ExperimentRef,
    consumptionDecisionDigest: workforceDigest({ taskId: task.id, assignmentId, computation,
      termsDigest: assignment.termsDigest }),
    intentEventId: intent.event_id, observationEventId: observation.event_id,
    observationEvidenceRef: ref as ExperimentRef, executionDigest: workforceDigest(result),
    scriptDigest: intent.body.scriptDigest as string, computationDigest: intent.body.inputDigest as string,
    noEgressAuthority: true, possibleEffectsReleased: false, protectedAdmission: false,
    executionAuthorityGranted: false };
  return { ...body, ref: allocationRef("S6", "known-local-workforce-attempt", body, "s6-workforce-v1") };
}

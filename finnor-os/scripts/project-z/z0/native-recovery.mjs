/** Read-only recognition of an exact native delivery and its durable cut.
 * No product imports, queue writes, fabricated claim or business oracle. */
import { createHash } from "node:crypto";
import { originalDigest } from "./native-original-oracle.mjs";

const ensure = (condition, code) => { if (!condition) throw Error(code); };
const sha = value => createHash("sha256").update(value).digest("hex");
const same = (a, b) => a !== undefined && b !== undefined && originalDigest(a) === originalDigest(b);
const one = rows => rows.length === 1 ? rows[0] : null;
const owners = Object.freeze({
  run_x1_institution_compiler_v1: { collection: "compiler", key: "requestId", prefix: "x1-compiler" },
  run_x1_institution_continuation_v1: { collection: "programs", key: "programId", prefix: "x1" },
  run_application_semantics_v1: { collection: "applications", key: "sessionId", prefix: "x2" },
});
export const nativeRecoveryContract = Object.freeze({
  schema: "finnor.project-z.z0.exact-physical-recovery.v1",
  selector: ["type", "ownerId", "generation", "stage"],
  actualIdentity: "ONE_NATIVE_IDEMPOTENCY_KEY_JOB_UUID_TYPE_PROTOCOL_PAYLOAD_GENERATION_UNFINISHED_OWNED_DELIVERY",
  artifact: "EXACT_SELECTED_X2_SESSION_CHECKED_MODEL_AND_CHECK_PREIMAGES",
  ambiguity: "EXACT_SELECTED_X2_REQUEST_NODE_S5_CONSUMPTION_S6_OBLIGATION_EFFECT_AND_ACTION",
  recovery: "SAME_CAPTURED_JOB_AND_PAYLOAD_HIGHER_NEW_TOKEN_FENCE_PLUS_INDEPENDENT_TERMINAL_OUTCOME",
  simulation: false, databaseWrites: false,
});

export function validateRecoverySelector(fixture, boundary) {
  const selected = fixture.recoveryJob;
  ensure(selected && Object.keys(selected).sort().join(",") === "generation,ownerId,stage,type"
    && owners[selected.type] && /^[0-9a-f-]{36}$/.test(selected.ownerId ?? "")
    && Number.isSafeInteger(selected.generation) && selected.generation >= 0
    && typeof selected.stage === "string" && /^[A-Za-z0-9_:.-]{1,128}$/.test(selected.stage)
    && ["CLAIM", "ARTIFACT", "AMBIGUITY"].includes(boundary)
    && (boundary === "CLAIM" || selected.type === "run_application_semantics_v1")
    && (boundary !== "AMBIGUITY" || typeof fixture.recoveryNodeId === "string"
      && fixture.recoveryNodeId.length > 0 && fixture.recoveryNodeId.length <= 512),
  "Z0_INDEPENDENT_EXACT_RECOVERY_JOB_AND_BOUNDARY_SELECTOR_REQUIRED");
  const owner = owners[selected.type];
  return { ...selected, ...owner,
    idempotencyKey: `${owner.prefix}:${selected.ownerId}:${selected.generation}:${selected.stage}` };
}
function artifact(value, ref, schema) {
  if (!ref) return null;
  const row = one(value.applicationArtifacts.filter(item => item.artifact_id === ref.id));
  return row && row.semantic_owner === ref.owner && row.version === ref.version
    && row.content_digest === ref.contentDigest && originalDigest(row.body) === ref.contentDigest
    && row.body.schema === schema ? row : null;
}
function artifactIdentity(value, session) {
  const model = artifact(value, session.model_ref, "finnor.x2.application-action-model.v1");
  const check = artifact(value, session.check_ref, "finnor.x2.model-check.v1");
  if (!model || !check || check.body.disposition !== "ACCEPTED_EVIDENCED_DOMAIN"
    || check.body.falseValid !== 0 || check.body.falseInvalid !== 0 || check.body.counterexamples?.length !== 0
    || !same(check.body.modelRef, session.model_ref)
    || !same(model.body.envelope?.originalParentRef, session.original_parent_ref)
    || model.body.envelope?.executionAuthorityGranted !== false || model.body.envelope?.protectedAdmission !== false) return null;
  return { sessionId: session.id, modelRef: session.model_ref, checkRef: session.check_ref,
    modelSha256: model.content_digest, checkSha256: check.content_digest };
}
function ambiguous(row) {
  return row.possible_egress === true
    && (row.consumption_status === "UNKNOWN_OUTCOME" || ["executing", "reconciliation_required"].includes(row.effect_status))
    && (row.effect_status === "reconciliation_required" || row.application_status === "UNKNOWN");
}
function ambiguityIdentity(value, session, nodeId, requestId = null) {
  const row = one(value.obligations.filter(item => item.session_id === session.id
    && item.request_node_id === nodeId && item.consumption_node_id === `${session.id}:${nodeId}`
    && (!requestId || item.request_id === requestId) && ambiguous(item)));
  const action = row && one(value.actions.filter(item => item.id === row.domain_action_id
    && item.work_id === session.work_id && item.action_type === "execute_application_operation_v1"));
  if (!action || !row.request_ref || !row.binding_ref || !/^[a-f0-9]{64}$/.test(row.wire_digest ?? "")
    || !/^[a-f0-9]{64}$/.test(row.input_digest ?? "") || !/^[a-f0-9]{64}$/.test(row.effect_semantic_hash ?? "")) return null;
  const { status, ...frozenAction } = action;
  return { sessionId: session.id, nodeId, requestId: row.request_id, requestRef: row.request_ref,
    bindingRef: row.binding_ref, wireDigest: row.wire_digest, obligationId: row.obligation_id,
    consumptionId: row.consumption_id, effectId: row.effect_id, domainActionId: row.domain_action_id,
    inputDigest: row.input_digest, effectSemanticHash: row.effect_semantic_hash,
    canonicalActionSha256: originalDigest(frozenAction) };
}
export function physicalBoundary(value, fixture, boundary, worker, actor) {
  const selector = validateRecoverySelector(fixture, boundary);
  const job = one(value.jobs.filter(row => row.type === selector.type && row.idempotency_key === selector.idempotencyKey
    && row.protocol_version === 1 && row.payload?.[selector.key] === selector.ownerId
    && row.payload.generation === selector.generation && row.payload.tenantId === actor.tenantId
    && row.payload.principalId === actor.principalId));
  const owner = one(value[selector.collection].filter(row => row.id === selector.ownerId
    && row.generation === selector.generation && row.work_id === fixture.workId && row.work_input_id === fixture.workInputId));
  if (!job || !owner || job.status !== "running" || !job.claim_token || Number(job.claim_fence) <= 0
    || job.lease_owner !== worker.workerInstanceId || !(Date.parse(job.lease_expires_at) > Date.now())
    || owner.claim_token !== job.claim_token || Number(owner.claim_fence) !== Number(job.claim_fence)) return null;
  const delivery = one(value.deliveries.filter(row => row.job_id === job.id && row.claim_token === job.claim_token
    && Number(row.claim_fence) === Number(job.claim_fence) && row.worker_id === worker.workerInstanceId && row.finished_at === null));
  if (!delivery) return null;
  let durable = null;
  if (boundary === "CLAIM") {
    if (selector.collection === "applications" && (owner.model_ref || owner.check_ref)
      || selector.collection === "compiler" && owner.artifact_id
      || selector.collection === "programs" && value.applicationArtifacts.some(row =>
        row.body?.schema === "finnor.z0.original-owner-model-materialization.v1" && row.body.jobId === job.id)) return null;
  } else if (boundary === "ARTIFACT") {
    durable = artifactIdentity(value, owner);
    if (!durable || value.uses.some(row => row.kind === "P1_ORIGINAL_APPLICATION_MODEL_CONSUMED"
      && same(row.body?.modelRef, owner.model_ref))) return null;
  } else {
    durable = ambiguityIdentity(value, owner, fixture.recoveryNodeId);
    if (!durable) return null;
  }
  return { schema: nativeRecoveryContract.schema, boundary,
    job: { id: job.id, type: job.type, protocolVersion: job.protocol_version, generation: selector.generation,
      ownerId: owner.id, idempotencyKey: job.idempotency_key, payloadSha256: originalDigest(job.payload) },
    delivery: { id: delivery.id, claimFence: Number(job.claim_fence),
      claimTokenSha256: sha(job.claim_token), workerId: worker.workerInstanceId },
    durable };
}
export function recoveredExactJob(value, cut, worker) {
  const job = value.jobs.find(row => row.id === cut.job.id);
  return !!job && job.type === cut.job.type && job.protocol_version === cut.job.protocolVersion
    && job.idempotency_key === cut.job.idempotencyKey && originalDigest(job.payload) === cut.job.payloadSha256
    && value.deliveries.some(row => row.job_id === cut.job.id && row.id !== cut.delivery.id
      && Number(row.claim_fence) > cut.delivery.claimFence && row.claim_token
      && sha(row.claim_token) !== cut.delivery.claimTokenSha256 && row.worker_id === worker.workerInstanceId);
}
export function retainedRecoveryBoundary(value, cut) {
  if (cut.boundary === "CLAIM") return true;
  const session = value.applications.find(row => row.id === cut.job.ownerId && row.generation === cut.job.generation);
  if (!session) return false;
  const actual = cut.boundary === "ARTIFACT" ? artifactIdentity(value, session)
    : ambiguityIdentity(value, session, cut.durable.nodeId, cut.durable.requestId);
  return !!actual && same(actual, cut.durable);
}

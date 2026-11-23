/** Closed native observations and reversible source-identity faults.
 * No product code, SQL writer, queue hook or replacement owner is imported. */
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { originalDigest } from "./native-original-oracle.mjs";

const ensure = (condition, code) => { if (!condition) throw Error(code); };
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const codePaths = Object.freeze({
  CODE: "finnor-os/packages/private-equity/src/application-semantics/learner.ts",
  CHECKER: "finnor-os/packages/private-equity/src/application-semantics/checker.ts",
  CONSUMER: "finnor-os/packages/orchestration/src/project-z/z0-convergence/institution-consumer.ts",
});
const comment = "\n// FINNOR_Z0_DISPOSABLE_CURRENTNESS_REVISION_ONLY\n";
export const nativeCurrentnessContract = Object.freeze({
  schema: "finnor.project-z.z0.actual-currentness-boundary.v1",
  stages: {
    INTAKE: "ORIGINAL_WAITING_PARENT_BEFORE_INSTITUTIONAL_ACQUISITION",
    CLAIM: "EXACT_LIVE_OWNED_X2_JOB_AND_SESSION_FENCE_BEFORE_CHECKED_MODEL",
    USE: "CHECKED_ORIGINAL_MODEL_BEFORE_MATERIALIZATION_OR_NATIVE_DRAFT",
    DISPATCH: "EXACT_MODEL_DERIVED_FENCED_NATIVE_DRAFT_BEFORE_BUSINESS_ROW",
  },
  dependencyEvidence: "RELEVANT_NATIVE_REVISION_TERMS_SOURCE_PARENT_OR_EXACT_SOURCE_BYTES",
  codePaths, sourceFaultSuffix: comment, sourceFaults: "SEPARATE_EXPLICIT_DISPOSABLE_AUTHORITY_ONLY",
  simulation: false, databaseWrites: false,
});

function liveClaim(value, worker, predicate) {
  const job = value.jobs.find(row => predicate(row) && row.status === "running" && row.claim_token
    && Number(row.claim_fence) > 0 && row.lease_owner === worker.workerInstanceId
    && Date.parse(row.lease_expires_at) > Date.now()
    && value.deliveries.some(delivery => delivery.job_id === row.id && delivery.claim_token === row.claim_token
      && Number(delivery.claim_fence) === Number(row.claim_fence) && delivery.worker_id === worker.workerInstanceId));
  return job ? { jobId: job.id, claimFence: Number(job.claim_fence), claimTokenSha256: sha(job.claim_token),
    workerId: worker.workerInstanceId } : null;
}
export function currentnessStage(value, expected, stage, worker) {
  if (!expected || value.owner?.length !== 0) return null;
  const compiler = value.compiler.find(row => row.id === expected.compilerRequestId && row.program_id === expected.programId);
  const programme = value.programs.find(row => row.id === expected.programId);
  if (!compiler || !programme) return null;
  const sessions = value.applications.filter(row => row.id === row.parent_id
    && row.request?.institutionalOrigin?.programId === expected.programId
    && row.request.institutionalOrigin.responsibilityIdentity === expected.stableIdentity);
  const action = value.actions.find(row => row.id === expected.entityId);
  const material = value.applicationArtifacts.filter(row =>
    row.body?.schema === "finnor.z0.original-owner-model-materialization.v1"
    && row.body.originalProgrammeId === expected.programId && row.body.obligationIdentity === expected.stableIdentity);
  let claim = null, selected = sessions.length === 1 ? sessions[0] : null;
  if (stage === "INTAKE") {
    if (sessions.length || action || material.length || !["WAITING", "PARTIAL"].includes(compiler.status)) return null;
  } else if (stage === "CLAIM") {
    if (!selected || !["QUEUED", "ACQUIRING"].includes(selected.status)
      || selected.model_ref || selected.check_ref || action || material.length) return null;
    claim = liveClaim(value, worker, row => row.type === "run_application_semantics_v1"
      && row.payload.sessionId === selected.id && Number(row.payload.generation) === Number(selected.generation)
      && row.claim_token === selected.claim_token && Number(row.claim_fence) === Number(selected.claim_fence));
    if (!claim) return null;
  } else if (stage === "USE") {
    if (!selected || selected.status !== "MODEL_READY" || !selected.model_ref || !selected.check_ref
      || action || material.length) return null;
  } else if (stage === "DISPATCH") {
    if (!selected || selected.status !== "MODEL_READY" || !selected.model_ref || !selected.check_ref
      || action?.status !== "draft" || action.authority_context?.programId !== expected.programId
      || action.authority_context.stableIdentity !== expected.stableIdentity
      || action.authority_context.applicationModelInputDigest !== expected.actionSha256) return null;
    const row = material.find(item => item.artifact_id === action.authority_context.applicationModelUseRef?.id
      && item.body.ownerInputDigest === expected.actionSha256
      && item.content_digest === action.authority_context.applicationModelUseRef.contentDigest
      && originalDigest(item.body) === item.content_digest);
    if (!row) return null;
    claim = liveClaim(value, worker, job => job.id === row.body.jobId && job.payload.programId === expected.programId
      && Number(job.claim_fence) === Number(row.body.claimFence));
    if (!claim) return null;
  } else return null;
  return { schema: nativeCurrentnessContract.schema, stage, compilerRequestId: compiler.id,
    programId: programme.id, sessionId: selected?.id ?? null, canonicalActionId: action?.id ?? null,
    originalActionSha256: expected.actionSha256, liveDelivery: claim, businessRowAbsent: true };
}

export async function dependencyWitness(target, fixture, value) {
  const dependency = fixture.dependency;
  let nativeProjection;
  if (dependency in codePaths) {
    const relativePath = codePaths[dependency], path = resolve(target.root, relativePath);
    ensure(path.startsWith(target.root + sep) && await realpath(path) === path,
      "Z0_CURRENTNESS_SOURCE_CONTAINMENT_REQUIRED");
    nativeProjection = { path: relativePath, sha256: sha(await readFile(path)) };
  } else if (dependency === "RIGHTS") {
    ensure(value.authority.length === 1, "Z0_ACTUAL_CURRENT_RIGHTS_REVISION_REQUIRED");
    nativeProjection = value.authority;
  } else if (dependency === "SOURCE") {
    ensure(value.sourceGrants?.length > 0, "Z0_ACTUAL_ORIGINAL_SOURCE_REVISION_REQUIRED");
    nativeProjection = value.sourceGrants;
  } else if (dependency === "TERMS") {
    ensure(value.profileTerms?.length > 0, "Z0_ACTUAL_GOVERNED_PROFILE_TERMS_REQUIRED");
    nativeProjection = value.profileTerms.map(row => ({ id: row.id, terms_sha256: row.terms_sha256 }));
  } else if (dependency === "PARENT") {
    ensure(value.reservations.length === 1 && fixture.resourceBudgets?.length > 0,
      "Z0_ACTUAL_ORIGINAL_PARENT_AND_BUDGET_REQUIRED");
    nativeProjection = { reservations: value.reservations, charges: [...value.charges].sort((a, b) =>
      a.charge_key.localeCompare(b.charge_key)).map(row => ({ charge_key: row.charge_key,
      resource_id: row.resource_id, unit: row.unit, units: row.units })) };
  } else throw Error("Z0_CLOSED_CURRENTNESS_DEPENDENCY_REQUIRED");
  return { dependency, sha256: originalDigest(nativeProjection), source: nativeProjection.path ?? "ACTUAL_SCOPED_NATIVE_DB" };
}

export async function injectSourceRevision(target, fixture, permissions) {
  const relativePath = codePaths[fixture.dependency];
  ensure(relativePath && permissions?.sourceByteCurrentnessFaults === true
    && target.sourceByteFaultScope === "OWNED_SYNTHETIC_TARGET_EXACT_PREIMAGE_COMMENT_ONLY",
  "Z0_EXPLICIT_DISPOSABLE_SOURCE_BYTE_FAULT_AUTHORITY_REQUIRED");
  const pin = fixture.codeFault, path = resolve(target.root, relativePath);
  ensure(pin && Object.keys(pin).sort().join(",") === "faultSha256,path,preimageSha256"
    && pin.path === relativePath && /^[a-f0-9]{64}$/.test(pin.preimageSha256)
    && /^[a-f0-9]{64}$/.test(pin.faultSha256) && (!fixture.fault || fixture.fault.length === 0)
    && path.startsWith(target.root + sep) && await realpath(path) === path, "Z0_EXACT_CLOSED_SOURCE_FAULT_PREIMAGE_REQUIRED");
  const before = await readFile(path), changed = Buffer.concat([before, Buffer.from(comment)]);
  ensure(sha(before) === pin.preimageSha256 && sha(changed) === pin.faultSha256,
    "Z0_DECLARED_CURRENTNESS_SOURCE_BYTES_CHANGED");
  return {
    evidence: { kind: "EXACT_DISPOSABLE_SOURCE_REVISION", path: relativePath,
      preimageSha256: pin.preimageSha256, faultSha256: pin.faultSha256 },
    apply: async () => {
      ensure(await realpath(path) === path && sha(await readFile(path)) === pin.preimageSha256,
        "Z0_CURRENTNESS_SOURCE_CHANGED_BEFORE_WRITE");
      await writeFile(path, changed);
      ensure(sha(await readFile(path)) === pin.faultSha256, "Z0_ACTUAL_CURRENTNESS_SOURCE_WRITE_NOT_OBSERVED");
    },
    restore: async () => {
      const current = sha(await readFile(path));
      if (current === pin.preimageSha256) return;
      ensure(await realpath(path) === path && current === pin.faultSha256,
        "Z0_CONCURRENT_SOURCE_CHANGE_RESTORE_REFUSED");
      await writeFile(path, before);
      ensure(sha(await readFile(path)) === pin.preimageSha256, "Z0_CURRENTNESS_SOURCE_RESTORE_FAILED");
    },
  };
}

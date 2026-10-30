import type { PoolClient } from "pg";
import type { ExperimentRef } from "@finnor/shared-types";
import type { JobExecutionContext } from "../../../../../apps/worker/src/queue";
import type { PeMutationContext, PeWorldRootRef } from "@finnor/private-equity/src/types";
import type { ApplicationAcquireRequest } from "@finnor/private-equity/src/application-semantics/native-contracts";
import type { ApplicationSessionRow } from "@finnor/private-equity/src/application-semantics/store";
import { applicationArtifact } from "@finnor/private-equity/src/application-semantics/store";
import { authorize, principal, sha, tx, unavailable } from "@finnor/private-equity/src/evidence-execution/store";
import { assertInstitutionCompilerCurrent, compilerEpisode, compilerRow } from "@finnor/private-equity/src/institution-program/store";
import { InstitutionProgram } from "@finnor/private-equity/src/institution-program/contracts";
import { verifyInstitutionDutyPopulation } from "@finnor/private-equity/src/institution-program/responsibility";
import { isInstitutionRequest } from "@finnor/private-equity/src/program-synthesis/contracts";
import { assertProgramCurrent, nativeRequestRow } from "@finnor/private-equity/src/program-synthesis/store";
import { sameX2Ref, x2Digest, x2Fault, x2Ref } from "@finnor/private-equity/src/application-semantics/contracts";
import { assertInheritedDeadline, InstitutionApplicationSelectorSchema, type InstitutionApplicationSelector } from "./semantics";

export type InstitutionalAcquireRequest = ApplicationAcquireRequest & {
  institutionalOrigin?: InstitutionApplicationSelector;
};
export interface InstitutionApplicationOrigin {
  schema: "finnor.z0.institution-application-origin.v1";
  selector: InstitutionApplicationSelector;
  tenantId: string; principalId: string; root: PeWorldRootRef; workId: string;
  workInputId: string; workInputDigest: string;
  compilerEpisodeId: string; compilerGeneration: number; compilerRevision: number;
  programmeEpisodeId: string; programmeGeneration: number; planRevisionId: string;
  programmeRequestDigest: string; admissionId: string; programmeDigest: string;
  institutionalProgramRef: ExperimentRef; originalReservationRef: ExperimentRef;
  originalDemandDigest: string; sourceManifestDigest: string; sourceRevisions: Record<string, string>;
  rightsRevision: string; mandateRevision: string; dutyDigest: string;
  originalDeadlineAt: string; wallDeadlineAt: string; responsibilityDeadlineAt: string;
  programmeDeadlineAt: string; deadlineAt: string;
  purpose: "LEARN_APPLICATION_MODEL_THEN_RETURN_TO_ORIGINAL_P1";
  executionAuthorityGranted: false; protectedAdmission: false;
}
export type PreparedInstitutionOrigin = { ref: ExperimentRef; body: InstitutionApplicationOrigin };
export const institutionOriginRef = (body: InstitutionApplicationOrigin) => x2Ref("S4", "institution-application-origin", body);
export const originOf = (row: ApplicationSessionRow): ExperimentRef | null =>
  (row.parent as typeof row.parent & { institutionalOriginRef?: ExperimentRef }).institutionalOriginRef ?? null;

export async function lockInstitutionApplicationOwners(ctx: PeMutationContext, c: PoolClient) {
  // Canonical S5 writers take portfolio before source/currentness and owner rows.
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`s5-portfolio:${ctx.auth.tenantId}`]);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,5510))", [ctx.auth.tenantId]);
}

/** Selectors name owner records. They carry no supplied mandate, duty, grant or result. */
async function readOwnerOrigin(ctx: PeMutationContext, request: InstitutionalAcquireRequest, c: PoolClient,
  delivery?: Readonly<JobExecutionContext>) {
  const selector = InstitutionApplicationSelectorSchema.parse(request.institutionalOrigin);
  if (ctx.auth.role !== "owner" || principal(ctx) !== ctx.auth.userId) throw unavailable();
  await lockInstitutionApplicationOwners(ctx, c);
  const compiler = await compilerRow(ctx, selector.compilerRequestId, c, true);
  const episode = await compilerEpisode(ctx, compiler.episode_id, c, true);
  const native = await nativeRequestRow(ctx, selector.programId, c, true);
  if (!isInstitutionRequest(native.request) || native.proposed.schema !== "finnor.institution-harness-program.v1"
    || !["WAITING", "PARTIAL"].includes(compiler.status)
    || !(delivery ? native.status === "RUNNING" : ["WAITING", "PARTIAL", "FAILED"].includes(native.status))
    || compiler.program_id !== native.id || compiler.work_id !== request.workId || native.work_id !== request.workId
    || native.work_input_id !== compiler.work_input_id || native.work_input_digest !== compiler.work_input_digest
    || native.request.institution.compilerRequestId !== compiler.id
    || !compiler.artifact_id || !compiler.admission_id || !episode.parent_reservation || !episode.parent_demand
    || x2Digest(request.root) !== x2Digest(native.request.root)) x2Fault("Z0_CURRENT_ORIGINAL_X1_OWNER_REQUIRED");
  if (delivery) await assertInstitutionApplicationDeliveryClaim(ctx, native, delivery, c);
  const active = await c.query(`SELECT w.id FROM finnor_os.works w
    JOIN finnor_os.work_plan_revisions p ON p.tenant_id=w.tenant_id AND p.work_id=w.id
    WHERE w.tenant_id=$1 AND w.id=$2 AND w.created_by=$3
      AND w.status NOT IN('completed','cancelled','failed')
      AND p.id=$4 AND p.work_input_id=$5 AND p.status='active' FOR SHARE OF w,p`,
  [ctx.auth.tenantId, request.workId, principal(ctx), native.plan_revision_id, compiler.work_input_id]);
  if (active.rowCount !== 1) x2Fault("Z0_UNFINISHED_ORIGINAL_WORK_AND_ACTIVE_PLAN_REQUIRED");
  const artifact = (await c.query<{
    body: unknown; body_digest: string; input_manifest: { current: unknown };
    check_result: { disposition: string; inputDigest: string; candidateDigest: string; checkerRevision: string };
  }>(`SELECT body,body_digest,input_manifest,check_result FROM finnor_os.x1_compiler_artifacts
    WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND request_id=$4 AND generation=$5`,
  [ctx.auth.tenantId, principal(ctx), compiler.artifact_id, compiler.id, compiler.generation])).rows[0];
  if (!artifact || sha(artifact.body) !== artifact.body_digest
    || artifact.check_result.disposition !== "ACCEPTED_DEVELOPMENT"
    || sha(artifact.input_manifest.current) !== sha(compiler.input_manifest?.current)) x2Fault("Z0_ORIGINAL_X1_ARTIFACT_AND_CHECK_REQUIRED");
  const institution = InstitutionProgram.parse(artifact.body), frame = native.request.institution;
  verifyInstitutionDutyPopulation(frame.programme, frame.responsibilities, frame.unresolved);
  const checked = (await c.query<{ responsibilities: unknown[] }>(`SELECT responsibilities
    FROM finnor_os.x1_checked_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND admission_id=$4`,
  [ctx.auth.tenantId, principal(ctx), request.workId, compiler.admission_id])).rows[0];
  const duties = frame.responsibilities.filter(duty => duty.obligation.stableIdentity === selector.responsibilityIdentity);
  if (duties.length !== 1 || !checked?.responsibilities.some(duty => sha(duty) === sha(duties[0]))
    || compiler.programme_digest !== sha(frame.programme) || compiler.intent_digest !== sha(frame.actions ?? [])
    || frame.programme.admission.originalDigest !== artifact.check_result.inputDigest
    || frame.programme.admission.candidateDigest !== artifact.check_result.candidateDigest
    || frame.programme.admission.checkerDigest !== artifact.check_result.checkerRevision
    || !sameX2Ref(frame.reservationRef, episode.parent_reservation)
    || sha(frame.demand) !== sha(episode.parent_demand)
    || episode.parent_demand.chargeScope?.episodeId !== episode.id) x2Fault("Z0_CHECKED_ORIGINAL_RESPONSIBILITY_REQUIRED");
  const duty = duties[0]!.obligation;
  if (duty.responsiblePrincipal !== principal(ctx)) x2Fault("Z0_RESPONSIBLE_APPLICATION_PRINCIPAL_REQUIRED", 403);
  if (native.head_id) {
    const head = (await c.query<{ body: { observedPostconditions: Array<{ stableIdentity: string }> }; digest: string }>(
      "SELECT body,digest FROM finnor_os.p1_programs WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND request_id=$4",
      [ctx.auth.tenantId, principal(ctx), native.head_id, native.id])).rows[0];
    if (!head || sha(head.body) !== head.digest
      || head.body.observedPostconditions.some(item => item.stableIdentity === selector.responsibilityIdentity)) {
      x2Fault("Z0_UNFINISHED_ORIGINAL_RESPONSIBILITY_REQUIRED");
    }
  }
  await authorize(ctx, request.root, [{ type: "work", id: request.workId }], [], c);
  await assertInstitutionCompilerCurrent(ctx, compiler, compiler.input_manifest?.current, c, true);
  await assertProgramCurrent(ctx, native, c, true);
  const current = compiler.input_manifest?.current;
  if (!current) x2Fault("Z0_ORIGINAL_SOURCE_MANIFEST_REQUIRED");
  const deadlineAt = assertInheritedDeadline({
    requestedDeadlineAt: request.deadlineAt, originalDeadlineAt: episode.original_deadline.toISOString(),
    wallDeadlineAt: episode.wall_deadline.toISOString(), responsibilityDeadlineAt: duty.originalDeadline,
    programmeDeadlineAt: native.proposed.bounds.deadlineAt, nowMs: Date.now(),
  });
  // This references the actual whole immutable artifact, not its internal
  // semantic subdocument digest and not a caller-constructed programme.
  const institutionalProgramRef: ExperimentRef = { owner: "S4_P1", id: compiler.artifact_id,
    version: institution.envelope.schema_revision, contentDigest: artifact.body_digest };
  const body: InstitutionApplicationOrigin = {
    schema: "finnor.z0.institution-application-origin.v1", selector,
    tenantId: ctx.auth.tenantId, principalId: principal(ctx), root: request.root, workId: request.workId,
    workInputId: compiler.work_input_id, workInputDigest: compiler.work_input_digest,
    compilerEpisodeId: episode.id, compilerGeneration: compiler.generation, compilerRevision: compiler.revision,
    programmeEpisodeId: native.episode_id, programmeGeneration: native.generation, planRevisionId: native.plan_revision_id,
    programmeRequestDigest: native.request_digest, admissionId: compiler.admission_id,
    programmeDigest: compiler.programme_digest!, institutionalProgramRef,
    originalReservationRef: episode.parent_reservation, originalDemandDigest: episode.parent_demand.demandDigest,
    sourceManifestDigest: sha(current), sourceRevisions: current.sourceRevisions,
    rightsRevision: current.rightsRevision, mandateRevision: duty.rule.mandateRevision, dutyDigest: sha(duties[0]),
    originalDeadlineAt: episode.original_deadline.toISOString(), wallDeadlineAt: episode.wall_deadline.toISOString(),
    responsibilityDeadlineAt: duty.originalDeadline, programmeDeadlineAt: native.proposed.bounds.deadlineAt, deadlineAt,
    purpose: "LEARN_APPLICATION_MODEL_THEN_RETURN_TO_ORIGINAL_P1", executionAuthorityGranted: false, protectedAdmission: false,
  };
  return { ref: institutionOriginRef(body), body };
}

export async function prepareInstitutionApplicationOrigin(ctx: PeMutationContext, request: InstitutionalAcquireRequest,
  client?: PoolClient): Promise<PreparedInstitutionOrigin | null> {
  const read = async (c: PoolClient) => {
    if (!request.institutionalOrigin) {
      await assertStandaloneApplicationWork(ctx, request.workId, c);
      return null;
    }
    return readOwnerOrigin(ctx, request, c);
  };
  return client ? read(client) : tx(ctx, read);
}
export async function assertStandaloneApplicationWork(ctx: PeMutationContext, workId: string, c: PoolClient) {
  const parent = await c.query(`SELECT id FROM finnor_os.x1_compiler_episodes
    WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 LIMIT 1`,
  [ctx.auth.tenantId, principal(ctx), workId]);
  if (parent.rowCount) x2Fault("Z0_X1_WORK_CANNOT_RESET_AS_STANDALONE_X2");
}
export async function assertInstitutionApplicationOriginCurrent(ctx: PeMutationContext, origin: PreparedInstitutionOrigin,
  request: InstitutionalAcquireRequest, c: PoolClient, delivery?: Readonly<JobExecutionContext>) {
  if (!sameX2Ref(origin.ref, institutionOriginRef(origin.body))) x2Fault("Z0_ORIGINAL_INSTITUTION_BINDING_INTEGRITY");
  // An execution child's request is an application assignment and carries no
  // selector. The retained, digest-verified origin body is the owner selector.
  const acquire: InstitutionalAcquireRequest = request.institutionalOrigin ? request
    : { ...request, workId: origin.body.workId, root: origin.body.root, deadlineAt: origin.body.deadlineAt,
      institutionalOrigin: origin.body.selector };
  const actual = await readOwnerOrigin(ctx, acquire, c, delivery);
  if (!sameX2Ref(origin.ref, actual.ref)) x2Fault("Z0_ORIGINAL_INSTITUTION_BINDING_CHANGED");
  return actual;
}
export async function retainedInstitutionApplicationOrigin(ctx: PeMutationContext, row: ApplicationSessionRow, c?: PoolClient) {
  const ref = originOf(row);
  if (!ref) {
    if (row.parent.institutionalProgramRef) x2Fault("Z0_INSTITUTION_ORIGIN_PREIMAGE_REQUIRED");
    return null;
  }
  const body = await applicationArtifact<InstitutionApplicationOrigin>(ctx, ref, c);
  if (body.schema !== "finnor.z0.institution-application-origin.v1"
    || body.tenantId !== ctx.auth.tenantId || body.principalId !== principal(ctx)
    || body.workId !== row.work_id || body.workInputId !== row.work_input_id
    || body.workInputDigest !== row.work_input_digest || body.deadlineAt !== row.parent.deadlineAt
    || !sameX2Ref(body.originalReservationRef, row.reservation_ref)
    || !row.parent.institutionalProgramRef || !sameX2Ref(body.institutionalProgramRef, row.parent.institutionalProgramRef)
    || !sameX2Ref(institutionOriginRef(body), ref)) x2Fault("Z0_ORIGINAL_INSTITUTION_SESSION_SUBSTITUTION");
  return { ref, body };
}
export async function currentInstitutionApplicationSession(ctx: PeMutationContext, row: ApplicationSessionRow,
  c?: PoolClient, recovery = false, delivery?: Readonly<JobExecutionContext>) {
  const inspect = async (client: PoolClient) => {
    const origin = await retainedInstitutionApplicationOrigin(ctx, row, client);
    if (!origin) return;
    if (!recovery) await assertInstitutionApplicationOriginCurrent(ctx, origin,
      row.request as InstitutionalAcquireRequest, client, delivery);
    // Recovery observes the retained same effect. It cannot use a new compiler
    // head, generation or grant to continue forward; S6 keeps its exact wire ID.
  };
  return c ? inspect(c) : tx(ctx, inspect);
}

/** A RUNNING original owner is usable only by its actual current delivery.
 * Callers acquire the common portfolio/source locks before reading owner rows. */
export async function assertInstitutionApplicationDeliveryClaim(ctx: PeMutationContext,
  original: Awaited<ReturnType<typeof nativeRequestRow>>, execution: Readonly<JobExecutionContext>, c: PoolClient) {
  const job = await c.query(`SELECT id FROM finnor_os.jobs
    WHERE tenant_id=$1 AND id=$2 AND type IN('run_harness_program_v1','run_x1_institution_continuation_v1')
      AND protocol_version=1 AND status='running' AND claim_token=$3 AND claim_fence=$4
      AND lease_expires_at>clock_timestamp() AND payload->>'programId'=$5
      AND payload->>'principalId'=$6 AND (payload->>'generation')::integer=$7 FOR SHARE`,
  [ctx.auth.tenantId, execution.jobId, execution.claimToken, execution.claimFence,
    original.id, principal(ctx), original.generation]);
  if (job.rowCount !== 1 || original.tenant_id !== ctx.auth.tenantId || original.principal_id !== principal(ctx)
    || original.status !== "RUNNING" || original.claim_token !== execution.claimToken
    || String(original.claim_fence) !== String(execution.claimFence)) x2Fault("Z0_ACTUAL_ORIGINAL_P1_DELIVERY_REQUIRED");
}

/** Called only at acquisition acceptance, before physical discovery. */
export async function assertOriginalInstitutionOwnerIdle(ctx: PeMutationContext, origin: PreparedInstitutionOrigin, c: PoolClient) {
  await assertNoPendingInstitutionApplication(ctx, origin.body.selector.programId, c);
  const live = await c.query(`SELECT id FROM finnor_os.jobs WHERE tenant_id=$1
    AND type IN('run_harness_program_v1','run_x1_institution_continuation_v1')
    AND payload->>'programId'=$2 AND payload->>'principalId'=$3
    AND (payload->>'generation')::integer=$4 AND status IN('queued','running','quarantined')
    FOR SHARE`, [ctx.auth.tenantId, origin.body.selector.programId, principal(ctx), origin.body.programmeGeneration]);
  if (live.rowCount) x2Fault("Z0_ORIGINAL_P1_DELIVERY_MUST_BE_QUIESCENT");
}
/** Existing P1 jobs call this fence before owner use, including resumed jobs. */
export async function assertNoPendingInstitutionApplication(ctx: PeMutationContext, programId: string, c?: PoolClient) {
  const inspect = async (client: PoolClient) => {
    const pending = await client.query(`SELECT s.id FROM finnor_os.application_semantics_sessions s
      JOIN finnor_os.application_semantics_artifacts a ON a.tenant_id=s.tenant_id AND a.principal_id=s.principal_id
        AND a.artifact_id=s.parent->'institutionalOriginRef'->>'id'
      WHERE s.tenant_id=$1 AND s.principal_id=$2 AND a.body->'selector'->>'programId'=$3
      AND (s.status NOT IN('MODEL_READY','COMPLETED','CANCELLED','FAILED','STALE','BLOCKED')
        OR EXISTS(SELECT 1 FROM finnor_os.application_semantics_requests r
          WHERE r.tenant_id=s.tenant_id AND r.parent_id=s.id AND r.possible_egress AND r.status NOT IN('VERIFIED','DENIED')))
      LIMIT 1`, [ctx.auth.tenantId, principal(ctx), programId]);
    if (pending.rowCount) x2Fault("Z0_ORIGINAL_APPLICATION_SUBCOMPUTATION_PENDING");
  };
  return c ? inspect(c) : tx(ctx, inspect, true);
}

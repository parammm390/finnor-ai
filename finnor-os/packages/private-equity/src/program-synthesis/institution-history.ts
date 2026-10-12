import type { PoolClient } from "pg";
import type { PeMutationContext } from "../types";
import { principal, sha, stable } from "../evidence-execution/store";
import type { InstitutionCandidate } from "../institution-program/checker";
import { verifyInstitutionDutyPopulation, type InstitutionResponsibility } from "../institution-program/responsibility";
import { loadInstitutionProfile } from "../institution-program/store";
import { buildInstitutionDependencyGraph, compareInstitutionDependencies } from "../live-recompilation/institution-dependencies";
import type { InstitutionHarnessProgram } from "./contracts";
import { frozenDutyExpectation } from "./duty-observer";

type Checked = { candidate: InstitutionCandidate; responsibilities: InstitutionResponsibility[]; unresolved: any[] };

/** Historical creation is carried only from the actual parent compiler/native
 * head. The caller cannot nominate witnesses or an unaffected duty population. */
export async function readUnaffectedInstitutionHistory(ctx: PeMutationContext, c: PoolClient,
  compilerId: string, head: InstitutionHarnessProgram) {
  const row = (await c.query<{
    current_candidate: InstitutionCandidate; current_duties: InstitutionResponsibility[]; current_unresolved: any[];
    prior_compiler_id: string | null; prior_candidate: InstitutionCandidate | null;
    prior_artifact: unknown; prior_artifact_digest: string | null; prior_checked: Checked | null;
    prior_request: unknown; prior_request_digest: string | null;
    prior_head_id: string | null; prior_head: InstitutionHarnessProgram | null; prior_head_digest: string | null;
    prior_program_id: string | null; prior_episode_id: string | null;
  }>(`SELECT checked.candidate current_candidate,checked.responsibilities current_duties,
      checked.unresolved current_unresolved,previous.id::text prior_compiler_id,
      artifact.candidate prior_candidate,artifact.body prior_artifact,artifact.body_digest prior_artifact_digest,
      jsonb_build_object('candidate',prior_checked.candidate,'responsibilities',prior_checked.responsibilities,
        'unresolved',prior_checked.unresolved) prior_checked,
      native.request prior_request,native.request_digest prior_request_digest,
      saved.id::text prior_head_id,saved.body prior_head,saved.digest prior_head_digest,
      native.id::text prior_program_id,native.episode_id::text prior_episode_id
    FROM finnor_os.x1_compiler_requests current
    JOIN finnor_os.x1_checked_artifacts checked ON checked.tenant_id=current.tenant_id
      AND checked.principal_id=current.principal_id AND checked.admission_id=current.admission_id
    LEFT JOIN finnor_os.x1_compiler_requests previous ON previous.tenant_id=current.tenant_id
      AND previous.principal_id=current.principal_id AND previous.work_id=current.work_id
      AND previous.episode_id=current.episode_id AND previous.id=current.parent_request_id
    LEFT JOIN finnor_os.x1_compiler_artifacts artifact ON artifact.tenant_id=previous.tenant_id
      AND artifact.principal_id=previous.principal_id AND artifact.id=previous.artifact_id
      AND artifact.request_id=previous.id
    LEFT JOIN finnor_os.x1_checked_artifacts prior_checked ON prior_checked.tenant_id=previous.tenant_id
      AND prior_checked.principal_id=previous.principal_id AND prior_checked.admission_id=previous.admission_id
    LEFT JOIN finnor_os.p1_requests native ON native.tenant_id=previous.tenant_id
      AND native.principal_id=previous.principal_id AND native.work_id=previous.work_id AND native.id=previous.program_id
    LEFT JOIN finnor_os.p1_programs saved ON saved.tenant_id=native.tenant_id
      AND saved.principal_id=native.principal_id AND saved.request_id=native.id AND saved.id=native.head_id
    WHERE current.tenant_id=$1 AND current.principal_id=$2 AND current.work_id=$3 AND current.id=$4`,
  [ctx.auth.tenantId, principal(ctx), head.work.id, compilerId])).rows[0];
  if (!row || stable(row.current_duties) !== stable(head.institution.responsibilities)
      || stable(row.current_unresolved) !== stable(head.institution.unresolved))
    throw Error("X1_CURRENT_CHECKED_HISTORY_POPULATION_CHANGED");
  const prior = row.prior_head;
  if (!prior || !row.prior_candidate || !row.prior_head_id || !row.prior_program_id)
    return { observations: [], update: null, priorHead: null };
  if (sha(row.prior_artifact) !== row.prior_artifact_digest || sha(prior) !== row.prior_head_digest
      || sha(row.prior_request) !== row.prior_request_digest
      || prior.schema !== "finnor.institution-harness-program.v1"
      || prior.tenantId !== ctx.auth.tenantId || prior.principalId !== principal(ctx)
      || prior.work.id !== head.work.id || prior.id !== row.prior_program_id
      || row.prior_episode_id !== head.bounds.episodeId || prior.bounds.episodeId !== head.bounds.episodeId
      || stable(prior.reservationRef) !== stable(head.reservationRef)
      || prior.bounds.deadlineAt !== head.bounds.deadlineAt
      || prior.institution.compilerRequestId !== row.prior_compiler_id
      || !row.prior_checked || stable(row.prior_checked.candidate) !== stable(row.prior_candidate)
      || stable(row.prior_checked.responsibilities) !== stable(prior.institution.responsibilities)
      || stable(row.prior_checked.unresolved) !== stable(prior.institution.unresolved))
    throw Error("X1_PRIOR_IMMUTABLE_CREATION_HISTORY_CHANGED");
  verifyInstitutionDutyPopulation(prior.institution.programme,
    prior.institution.responsibilities, prior.institution.unresolved);
  const profile = loadInstitutionProfile();
  const update = compareInstitutionDependencies(
    buildInstitutionDependencyGraph(row.prior_candidate, prior.institution.responsibilities, profile),
    buildInstitutionDependencyGraph(row.current_candidate, head.institution.responsibilities, profile), profile);
  const preserved = new Set(update.preservedCurrentDutyIds);
  const priorHead = { programId: prior.id, headId: row.prior_head_id, headDigest: row.prior_head_digest! };
  const observations: InstitutionHarnessProgram["observedPostconditions"] = [];
  for (const observation of prior.observedPostconditions) {
    const old = prior.nodes.find(node => node.stableIdentity === observation.stableIdentity);
    const next = head.nodes.find(node => node.stableIdentity === observation.stableIdentity);
    if (!preserved.has(observation.stableIdentity) || !old?.action || !next?.action) continue;
    if (sha(old.action) !== sha(next.action) || old.operation !== next.operation
        || old.deadlineAt !== next.deadlineAt || old.postconditionRef !== next.postconditionRef
        || old.observerRef !== next.observerRef) continue;
    const expected = frozenDutyExpectation(ctx.auth.tenantId, old);
    if (observation.canonicalRef !== `${expected.entityType}:${expected.entityId}`
        || !/^[a-f0-9]{64}$/.test(observation.observerDigest)
        || observation.derivationRevision && observation.derivationRevision !== old.derivationRevision
        || observation.actionId && observation.actionId !== old.action.expectedEntityId
        || observation.frozenIntentDigest && observation.frozenIntentDigest !== sha(old.action)
        || observations.some(item => item.stableIdentity === observation.stableIdentity))
      throw Error("X1_PRIOR_SEALED_CREATION_WITNESS_CHANGED");
    observations.push({ ...observation, derivationRevision: next.derivationRevision,
      actionId: next.action.expectedEntityId, frozenIntentDigest: sha(next.action),
      carriedFrom: { ...priorHead, derivationRevision: old.derivationRevision } });
  }
  return { observations, update, priorHead };
}

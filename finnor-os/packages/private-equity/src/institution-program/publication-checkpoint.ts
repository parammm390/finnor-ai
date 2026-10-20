import type { PeMutationContext } from '../types';
import { sha, stable, tx } from '../evidence-execution/store';
import type { InstitutionHarnessRequest } from '../program-synthesis/contracts';
import type { InstitutionDependencyGraph } from '../live-recompilation/institution-dependencies';
import type { InstitutionArtifactEvidence } from './artifact';
import { assertInstitutionMappingReceiptsCurrent, type reconstructAndAdmitInstitutionSources } from './owner-admission';
import type { deriveInstitutionResponsibilities } from './responsibility';
import type { resolveInstitutionActions } from './action-resolution';
import { assertInstitutionCompilerCurrent, type CompilerRequestRow } from './store';

type Result = Awaited<ReturnType<typeof reconstructAndAdmitInstitutionSources>>;
export type PreparedInstitutionPublication = {
  result: Omit<Result, 'original'> & { original: InstitutionArtifactEvidence };
  lowered: ReturnType<typeof deriveInstitutionResponsibilities> | null;
  resolved: Awaited<ReturnType<typeof resolveInstitutionActions>>;
  graph: InstitutionDependencyGraph;
  updatePlan: unknown;
  admissionId: string | null;
};
type Checkpoint = {
  schema: 'finnor.x1.compiler-publication-checkpoint.v1'; requestId: string; generation: number;
  workInputDigest: string; grantIds: string[]; prepared: PreparedInstitutionPublication;
  nativeRequest: InstitutionHarnessRequest; digest: string;
};
const limit = 2 * 8 * 1024 * 1024;

/** Raw evidence remains at S1/Core. Retain only the checked projection inputs. */
export function publicationResult(result: Result): PreparedInstitutionPublication['result'] {
  return { ...result, original: { ...result.original, sources: result.original.sources.map(source => {
    const { rawUtf8: _text, rawBase64: _bytes, ...metadata } = source;
    return metadata;
  }) } };
}

export function compilerPublicationCheckpoint(q: CompilerRequestRow, prepared: PreparedInstitutionPublication,
  nativeRequest: InstitutionHarnessRequest): Checkpoint {
  const body = { schema: 'finnor.x1.compiler-publication-checkpoint.v1' as const, requestId: q.id,
    generation: q.generation, workInputDigest: q.work_input_digest, grantIds: q.grant_ids, prepared, nativeRequest };
  const checkpoint = { ...body, digest: sha(body) };
  if (Buffer.byteLength(stable(checkpoint)) > limit) throw Error('X1_PUBLICATION_CHECKPOINT_BOUND');
  return checkpoint;
}

/** A checkpoint grants no authority: current owners and their immutable checked
 * records must still agree before the original P1 request may be replayed. */
export async function readCompilerPublicationCheckpoint(ctx: PeMutationContext, q: CompilerRequestRow) {
  const retained = q.input_manifest?.publication as Checkpoint | undefined;
  const children = await tx(ctx, async c => (await c.query<{id:string;request:InstitutionHarnessRequest;request_digest:string}>(
    `SELECT id,request,request_digest FROM finnor_os.p1_requests WHERE tenant_id=$1 AND principal_id=$2
      AND work_id=$3 AND idempotency_key=$4 LIMIT 2`,
    [q.tenant_id,q.principal_id,q.work_id,`x1-compiler:${q.id}`])).rows, true);
  if (!retained) {
    if (children.length) throw Error('X1_ACCEPTED_CHILD_REQUIRES_ORIGINAL_PUBLICATION_CHECKPOINT');
    return null;
  }
  const {digest,...body} = retained;
  if (retained.schema !== 'finnor.x1.compiler-publication-checkpoint.v1' || sha(body) !== digest
      || Buffer.byteLength(stable(retained)) > limit || retained.requestId !== q.id || retained.generation !== q.generation
      || retained.workInputDigest !== q.work_input_digest || stable(retained.grantIds) !== stable(q.grant_ids)
      || !retained.prepared?.lowered || !retained.prepared.result?.original || !retained.nativeRequest
      || children.length > 1) throw Error('X1_PUBLICATION_CHECKPOINT_CHANGED');
  const p = retained.prepared, o = p.result.original, request = retained.nativeRequest;
  if (o.tenantId !== q.tenant_id || o.principalId !== q.principal_id || o.workId !== q.work_id
      || stable(o.current) !== stable(q.input_manifest!.current) || p.admissionId !== q.admission_id
      || sha(p.lowered!.programme) !== q.programme_digest || sha(p.resolved.actions) !== q.intent_digest
      || request.workId !== q.work_id || request.workInputId !== q.work_input_id
      || request.institution.compilerRequestId !== q.id || request.idempotencyKey !== `x1-compiler:${q.id}`
      || stable(request.institution.programme) !== stable(p.lowered!.programme)
      || stable(request.institution.responsibilities) !== stable(p.lowered!.responsibilities)
      || stable(request.institution.unresolved) !== stable(p.lowered!.unresolved)
      || stable(request.institution.actions) !== stable(p.resolved.actions)
      || children.some(child => child.request_digest !== sha(request) || stable(child.request) !== stable(request)))
    throw Error('X1_PUBLICATION_CHECKPOINT_OWNER_BINDING_CHANGED');
  await assertInstitutionCompilerCurrent(ctx,q,o.current);
  const checked = await tx(ctx, async c => (await c.query(`SELECT a.*,k.candidate,k.check_result,k.responsibilities,k.unresolved
    FROM finnor_os.x1_mapping_admissions a JOIN finnor_os.x1_checked_artifacts k
      ON k.tenant_id=a.tenant_id AND k.principal_id=a.principal_id AND k.work_id=a.work_id AND k.admission_id=a.id
    WHERE a.tenant_id=$1 AND a.principal_id=$2 AND a.work_id=$3 AND a.id=$4
      AND a.id=(SELECT id FROM finnor_os.x1_mapping_admissions WHERE tenant_id=$1 AND principal_id=$2
        AND work_id=$3 ORDER BY published_at DESC,id DESC LIMIT 1)`,
    [q.tenant_id,q.principal_id,q.work_id,q.admission_id])).rows[0],true);
  const check = p.result.check;
  if (!checked || check.disposition !== 'ACCEPTED_DEVELOPMENT' || checked.original_digest !== check.inputDigest
      || checked.candidate_digest !== check.candidateDigest || checked.checker_digest !== check.checkerRevision
      || stable(checked.candidate) !== stable(p.result.candidate) || stable(checked.check_result) !== stable(check)
      || stable(checked.responsibilities) !== stable(p.lowered!.responsibilities)
      || stable(checked.unresolved) !== stable(p.lowered!.unresolved) || stable(checked.receipts) !== stable(p.result.mappings))
    throw Error('X1_PUBLICATION_CHECKPOINT_CHECKED_OWNER_CHANGED');
  await assertInstitutionMappingReceiptsCurrent(ctx,o.canonical.entities.map(entity=>entity.ref),p.result.mappings);
  return { ...p, nativeRequest: request };
}

/** Ordinary S8 exact-derivation sibling. Producer output remains UNKNOWN.
 * This is neither an allocation-method admission nor protected evaluation. */
import type { PoolClient } from 'pg';
import type { ExperimentRef } from '@finnor/shared-types';
import type { PeMutationContext } from '../../types';
import { principal } from '../../owner-context';
import { withNativeTransaction as withS5PortfolioTransaction } from './resources.js';
import { checkedPublication, type PublishedProgram } from './owner.js';
import { runtimeIdentity } from './processes.js';
import { requireZ1, digest } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts.js';
import { developmentOnly, nativeRef, same, type NativeRow, type Submit } from './native-contracts.js';
import { readPublishedTx, enqueueProjectionJobsTx, eventTx, assertRowCurrentTx, assertProjectionDeliveryBatchTx } from './native-store.js';

interface Admission {
  schema: 'finnor.s8.z1-exact-derivation-admission.v1'; ref: ExperimentRef;
  domain: 'Z1_ORIGINAL_EXACT_RELATIONAL_DERIVATION'; protectionDomain: 'DISPOSABLE_LOCAL_DEVELOPMENT';
  tenantId: string; principalId: string; requestId: string; generation: number;
  publicationRef: ExperimentRef; checkDigest: string; requestDigest: string; originalCutsDigest: string;
  runtimeDigest: string; rightsRevision: string; admittedAt: string; validUntil: string;
  protectedAdmission: false; productionActivated: false; executionAuthorityGranted: false;
}
async function assertIndependent(publication: PublishedProgram) {
  const body = publication.body, check = body.check, runtime = await runtimeIdentity();
  requireZ1(same(body, checkedPublication(body.candidate, check, body.envelope.checkerIdentityAndResultReferences.resultReference)) &&
    check.disposition === 'CHECKED_CANDIDATE' && check.originalWorksChecked === body.candidate.workProjections.length &&
    check.originalWorksChecked >= 2 && check.originalNodesChecked > 0 &&
    check.checkerSha256 === runtime.files.find(file => file.path.endsWith('/original_checker.py'))?.sha256 &&
    check.process.executable === 'PYTHON3_ORIGINAL_CHECKER' && check.process.exitCode === 0 &&
    check.process.pid !== null && check.process.cpuMicros !== null &&
    check.process.lifetimeScope === 'WAIT4_COMPLETE_EXITED_CHILD_AND_SEPARATE_SUPERVISOR' &&
    body.candidate.workProjections.some(work => work.result && work.lifecycle === 'ACTIVE'),
  'Z1_S8_COMPLETE_INDEPENDENT_ORIGINAL_CHECK_REQUIRED', 'COUNTEREXAMPLE');
}
export async function currentSharedWorkAdmissionTx(ctx: PeMutationContext, c: PoolClient, row: NativeRow, publication: PublishedProgram): Promise<Admission> {
  developmentOnly(); await assertIndependent(publication);
  const admission = (await c.query<{ body: Admission }>(
    `SELECT body FROM finnor_os.s8_z1_shared_work_admissions WHERE tenant_id=$1 AND principal_id=$2 AND publication_id=$3`,
    [ctx.auth.tenantId, principal(ctx), publication.reference.id])).rows[0]?.body;
  requireZ1(admission, 'Z1_S8_ORDINARY_DERIVATION_UNADMITTED');
  const { ref, ...body } = admission;
  requireZ1(same(ref, nativeRef('S8', 'z1-exact-derivation-admission', body)) &&
    body.domain === 'Z1_ORIGINAL_EXACT_RELATIONAL_DERIVATION' && body.protectionDomain === 'DISPOSABLE_LOCAL_DEVELOPMENT' &&
    body.tenantId === ctx.auth.tenantId && body.principalId === principal(ctx) && body.requestId === row.id &&
    body.generation === row.generation && same(body.publicationRef, publication.reference) &&
    body.checkDigest === digest(publication.body.check) && body.requestDigest === row.request_digest &&
    body.originalCutsDigest === digest(row.cuts) && body.rightsRevision === row.rights_revision &&
    body.runtimeDigest === row.runtime.digest && Date.parse(body.validUntil) > Date.now() &&
    body.protectedAdmission === false && body.productionActivated === false && body.executionAuthorityGranted === false,
  'Z1_S8_CURRENT_NATIVE_ADMISSION_BINDING_REQUIRED', 'STALE');
  await assertProjectionDeliveryBatchTx(ctx, c, row, publication);
  return admission;
}
/** Explicit authenticated S8 owner operation, never called by producer publish. */
export async function admitSharedWorkProgram(ctx: PeMutationContext, reference: ExperimentRef, root: Submit['root']) {
  developmentOnly();
  return withS5PortfolioTransaction(ctx, async c => {
    const stored = (await c.query<{ body: PublishedProgram['body'] }>(
      'SELECT body FROM finnor_os.z1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND artifact_id=$3 AND kind=$4',
      [ctx.auth.tenantId, principal(ctx), reference.id, 'z1-checked-publication'])).rows[0];
    const eligible = stored?.body.candidate.workProjections.find(work => work.result && work.lifecycle === 'ACTIVE' &&
      work.disposition !== 'REVOKED');
    requireZ1(eligible, 'Z1_CANONICAL_CHECKED_PUBLICATION_REQUIRED');
    const { row, publication } = await readPublishedTx(ctx, c, reference, eligible.workId);
    await assertRowCurrentTx(ctx, c, row);
    requireZ1(same(row.root, root), 'Z1_ORIGINAL_ADMISSION_ROOT_REQUIRED', 'REVOKED');
    await assertIndependent(publication);
    const prior = (await c.query('SELECT admission_id FROM finnor_os.s8_z1_shared_work_admissions WHERE tenant_id=$1 AND principal_id=$2 AND publication_id=$3',
      [ctx.auth.tenantId, principal(ctx), reference.id])).rows[0];
    let admission: Admission;
    if (prior) admission = await currentSharedWorkAdmissionTx(ctx, c, row, publication);
    else {
      const body: Omit<Admission, 'ref'> = { schema: 'finnor.s8.z1-exact-derivation-admission.v1',
        domain: 'Z1_ORIGINAL_EXACT_RELATIONAL_DERIVATION', protectionDomain: 'DISPOSABLE_LOCAL_DEVELOPMENT',
        tenantId: ctx.auth.tenantId, principalId: principal(ctx), requestId: row.id, generation: row.generation,
        publicationRef: reference, checkDigest: digest(publication.body.check), requestDigest: row.request_digest,
        originalCutsDigest: digest(row.cuts), runtimeDigest: row.runtime.digest, rightsRevision: row.rights_revision,
        admittedAt: new Date().toISOString(), validUntil: row.deadline_at.toISOString(), protectedAdmission: false,
        productionActivated: false, executionAuthorityGranted: false };
      admission = { ...body, ref: nativeRef('S8', 'z1-exact-derivation-admission', body) };
      await c.query('INSERT INTO finnor_os.s8_z1_shared_work_admissions(tenant_id,principal_id,admission_id,request_id,publication_id,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
        [ctx.auth.tenantId, principal(ctx), admission.ref.id, row.id, reference.id, JSON.stringify(admission)]);
      await eventTx(ctx, c, row.id, null, `s8:${reference.contentDigest}`, { admissionRef: admission.ref, protectedAdmission: false,
        qualification: 'ORDINARY_EXACT_DERIVATION_ONLY_NO_ECONOMIC_OR_EFFECT_ADMISSION' });
    }
    await enqueueProjectionJobsTx(ctx, c, row, publication);
    return admission;
  });
}

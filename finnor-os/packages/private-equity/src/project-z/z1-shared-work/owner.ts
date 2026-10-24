import type { PoolClient } from 'pg';
import type { ExperimentRef } from '@finnor/shared-types';
import type { JobExecutionContext } from '../../../../../apps/worker/src/queue';
import type { PeMutationContext } from '../../types';
import { withS5PortfolioTransaction } from '../../allocation-store';
import { epistemicHash } from '../../../../epistemic-runtime/src/source-precedence';
import {
  digest, requireZ1, type Checkpoint, type Production, type SharedWorkProgram, type SharedWorkRequest, type WorkProjection,
} from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts.js';
import { currentness, projectForWork, verifyProgramDigest } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/engine.js';
import {
  checkOriginal, runProducer, runtimeIdentity, Z1ProcessFailure, type OriginalCheckReceipt, type ProcessReceipt,
} from './processes.js';

export const Z1_OWNER_CONTRACT = 'z1-per-original-work-v1';
export const Z1_JOB_TYPE = 'run_shared_work_program_v1';
export interface ClaimPayload {
  tenantId: string; principalId: string; requestId: string; generation: number; workIds: string[];
}
export interface ClaimedSnapshot {
  request: SharedWorkRequest; previous?: Checkpoint; version: number; remainingWallMs: number;
  originalRequestRef: ExperimentRef; publication?: PublishedProgram;
}
export interface CheckedPublicationBody {
  schema: 'finnor.z1.checked-publication.v1';
  envelope: Omit<SharedWorkProgram['envelope'], 'checkerIdentityAndResultReferences'> & {
    checkerIdentityAndResultReferences: { identity: string; resultReference: ExperimentRef };
  };
  candidate: SharedWorkProgram; check: OriginalCheckReceipt;
  executionAuthorityGranted: false; protectedAdmission: false;
}
export interface PublishedProgram { reference: ExperimentRef; body: CheckedPublicationBody }
export interface NativeOwnerReceipt {
  owner: 'S3' | 'S4'; workId: string; originalParentReservationRef: string;
  artifactRef: ExperimentRef; resultDigest: string; nativeResultRef: ExperimentRef;
  observation: 'INDEPENDENTLY_OBSERVED' | 'UNKNOWN'; unresolvedObligationRefs: string[];
  executionAuthorityGranted: false;
}
type Boundary = 'CLAIM' | 'CHECK' | 'PUBLICATION' | 'DELIVERY';
/**
 * Required canonical owner bindings, not implementations or optional approvals.
 * No default/file-backed substitute is provided. The coordinator must bind and
 * verify these against native intake, jobs, artifact/outbox and S3/S4 owners.
 */
export interface Z1NativePorts {
  contract: typeof Z1_OWNER_CONTRACT;
  contextForClaim(payload: ClaimPayload, claim: Readonly<JobExecutionContext>): Promise<PeMutationContext>;
  // Resolve original rooted Work inputs and current active authority from native
  // records, never from raw data or a role asserted in the job payload.
  loadClaimed(ctx: PeMutationContext, payload: ClaimPayload, claim: Readonly<JobExecutionContext>): Promise<ClaimedSnapshot>;
  assertCurrent(ctx: PeMutationContext, claim: Readonly<JobExecutionContext>, snapshot: ClaimedSnapshot, boundary: Boundary): Promise<void>;
  beginAttempt(ctx: PeMutationContext, claim: Readonly<JobExecutionContext>, snapshot: ClaimedSnapshot): Promise<ExperimentRef>;
  recordChildPid(ctx: PeMutationContext, attempt: ExperimentRef, kind: 'PRODUCER' | 'CHECKER', pid: number): Promise<void>;
  recordProcess(ctx: PeMutationContext, attempt: ExperimentRef, receipt: ProcessReceipt): Promise<void>;
  // This append must survive a lost claim. The original start remains a cost
  // liability if the worker dies before a complete physical receipt is observed.
  retainFailure(ctx: PeMutationContext, attempt: ExperimentRef, code: string, costsUnknown: boolean): Promise<void>;
  withOriginalComputePermit<T>(
    ctx: PeMutationContext, claim: Readonly<JobExecutionContext>, snapshot: ClaimedSnapshot,
    invoke: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  // Atomically fence the native jobs row, current generation and checkpoint
  // version, then debit every original remaining parent and persist all costs.
  saveCheckpoint(ctx: PeMutationContext, claim: Readonly<JobExecutionContext>, snapshot: ClaimedSnapshot, production: Production): Promise<number>;
  // Recheck source/rights/revisions and the same jobs fence under publication
  // transaction locks. Persist the exact check preimage before its canonical ref.
  retainCheck(ctx: PeMutationContext, claim: Readonly<JobExecutionContext>, snapshot: ClaimedSnapshot, check: OriginalCheckReceipt): Promise<ExperimentRef>;
  publishChecked(ctx: PeMutationContext, claim: Readonly<JobExecutionContext>, snapshot: ClaimedSnapshot,
    checkpointVersion: number, body: CheckedPublicationBody): Promise<PublishedProgram>;
  // Existing native outbox; idempotent by original publication + original Work.
  // Delivery responsibility is not an assertion that S3/S4 consumed it.
  enqueueOriginalProjection(ctx: PeMutationContext, claim: Readonly<JobExecutionContext>, snapshot: ClaimedSnapshot,
    publication: PublishedProgram, projection: WorkProjection): Promise<ExperimentRef>;
  finishAttempt(ctx: PeMutationContext, attempt: ExperimentRef, publication: ExperimentRef | null): Promise<void>;
  // These are invoked inside the actual existing S5 portfolio transaction.
  loadPublishedTx(ctx: PeMutationContext, client: PoolClient, reference: ExperimentRef, workId: string):
    Promise<{ publication: PublishedProgram; currentRequest: SharedWorkRequest }>;
  assertOriginalCapacityTx(ctx: PeMutationContext, client: PoolClient, projection: WorkProjection): Promise<void>;
  assertExistingS8ConsumptionAdmissionTx(ctx: PeMutationContext, client: PoolClient, publication: PublishedProgram, projection: WorkProjection): Promise<void>;
  consumeS3OrS4Tx(ctx: PeMutationContext, client: PoolClient, publication: PublishedProgram, projection: WorkProjection): Promise<NativeOwnerReceipt>;
  recordS7AndConsumptionTx(ctx: PeMutationContext, client: PoolClient, publication: PublishedProgram, receipt: NativeOwnerReceipt): Promise<void>;
}
function actor(ctx: PeMutationContext): string { return ctx.auth.employeeId ?? ctx.auth.userId; }
function developmentProfile(): void {
  requireZ1(process.env.FINNOR_Z1_PROFILE === 'ordinary_disposable' &&
    process.env.FINNOR_ENVIRONMENT === 'ordinary_disposable' && process.env.NODE_ENV !== 'production',
  'Z1_AUTHORIZED_DISPOSABLE_NATIVE_PROFILE_REQUIRED');
}
function assertPrincipal(ctx: PeMutationContext, request: SharedWorkRequest): void {
  requireZ1(ctx.auth.role === 'owner' && actor(ctx) === ctx.auth.userId &&
    request.works.every(work => work.partition.tenantId === ctx.auth.tenantId && work.partition.principalId === actor(ctx)),
  'CURRENT_NATIVE_ORIGINAL_PRINCIPAL_REQUIRED', 'REVOKED');
}
export function checkedPublication(candidate: SharedWorkProgram, check: OriginalCheckReceipt, checkRef: ExperimentRef): CheckedPublicationBody {
  requireZ1(verifyProgramDigest(candidate) && check.disposition === 'CHECKED_CANDIDATE' &&
    check.candidateDigest === candidate.envelope.immutableArtifactDigest && check.requestDigest === candidate.requestDigest &&
    check.checker === candidate.envelope.checkerIdentityAndResultReferences.identity &&
    check.originalWorksChecked === candidate.workProjections.length && checkRef.contentDigest === epistemicHash(check),
  'INDEPENDENT_CHECKED_PUBLICATION_BINDING', 'COUNTEREXAMPLE');
  const body: CheckedPublicationBody = {
    schema: 'finnor.z1.checked-publication.v1',
    envelope: { ...candidate.envelope, immutableArtifactDigest: '',
      checkerIdentityAndResultReferences: { identity: check.checker, resultReference: checkRef },
      gaps: candidate.envelope.gaps.filter(gap => gap !== 'INDEPENDENT_CHECK_REQUIRED') },
    candidate, check, executionAuthorityGranted: false, protectedAdmission: false,
  };
  body.envelope.immutableArtifactDigest = digest(body);
  return body;
}
function assertPublication(publication: PublishedProgram): void {
  const { body, reference } = publication;
  const expected = checkedPublication(body.candidate, body.check, body.envelope.checkerIdentityAndResultReferences.resultReference);
  requireZ1(reference.contentDigest === epistemicHash(body) && digest(body) === digest(expected),
  'NATIVE_PUBLICATION_PREIMAGE_REQUIRED', 'COUNTEREXAMPLE');
}
export async function runSharedWorkClaim(
  payload: ClaimPayload, claim: Readonly<JobExecutionContext>, ports: Z1NativePorts,
): Promise<void> {
  developmentProfile();
  requireZ1(ports.contract === Z1_OWNER_CONTRACT && claim.protocolVersion === 1 &&
    claim.tenantId === payload.tenantId && claim.claimToken && Number.isSafeInteger(claim.claimFence) && claim.claimFence > 0,
  'ACTUAL_CANONICAL_JOB_CLAIM_REQUIRED', 'REVOKED');
  const ctx = await ports.contextForClaim(payload, claim), snapshot = await ports.loadClaimed(ctx, payload, claim);
  assertPrincipal(ctx, snapshot.request);
  requireZ1(digest([...payload.workIds].sort()) === digest(snapshot.request.works.map(w => w.id).sort()) &&
    ctx.auth.tenantId === payload.tenantId && actor(ctx) === payload.principalId,
  'ORIGINAL_JOB_WORK_COVERAGE_REQUIRED', 'REVOKED');
  const runtime = await runtimeIdentity();
  requireZ1(runtime.digest === snapshot.request.identity.producerBuildIdentity, 'INSTALLED_Z1_BUILD_CHANGED', 'STALE');
  await ports.assertCurrent(ctx, claim, snapshot, 'CLAIM');
  const attempt = await ports.beginAttempt(ctx, claim, snapshot), started = performance.now();
  const claimLost = new AbortController();
  claim.registerHeartbeat(async () => {
    try { await ports.assertCurrent(ctx, claim, snapshot, 'CLAIM'); return true; }
    catch { claimLost.abort(); return false; }
  });
  let processInFlight = false;
  const remaining = (): number => Math.min(30000, snapshot.remainingWallMs - (performance.now() - started),
    Date.parse(snapshot.request.limits.deadlineAt) - Date.now(),
    ...snapshot.request.works.filter(w => !w.withdrawn).map(w => Date.parse(w.resources.originalDeadline) - Date.now()));
  try {
    await ports.withOriginalComputePermit(ctx, claim, snapshot, async permitSignal => {
      const signal = AbortSignal.any([permitSignal, claimLost.signal]);
      let publication = snapshot.publication;
      if (publication) {
        assertPublication(publication);
        requireZ1(publication.body.candidate.requestDigest === digest(snapshot.request), 'RECOVERED_PUBLICATION_STALE', 'STALE');
      } else {
        processInFlight = true;
        const produced = await runProducer(snapshot.request, snapshot.previous, remaining(), signal,
          pid => ports.recordChildPid(ctx, attempt, 'PRODUCER', pid));
        processInFlight = false;
        await ports.recordProcess(ctx, attempt, produced.receipt);
        const checkpointVersion = await ports.saveCheckpoint(ctx, claim, snapshot, produced.production);
        if (!produced.production.program) { await ports.finishAttempt(ctx, attempt, null); return; }
        const candidate = produced.production.program;
        await ports.assertCurrent(ctx, claim, snapshot, 'CHECK');
        processInFlight = true;
        const check = await checkOriginal(snapshot.request, candidate, remaining(), signal,
          pid => ports.recordChildPid(ctx, attempt, 'CHECKER', pid));
        processInFlight = false;
        await ports.recordProcess(ctx, attempt, check.process);
        requireZ1(check.disposition === 'CHECKED_CANDIDATE', 'ORIGINAL_SEMANTICS_CHECK_NOT_PASSED', check.disposition);
        requireZ1((await runtimeIdentity()).digest === runtime.digest, 'LOADED_Z1_RUNTIME_CHANGED', 'STALE');
        await ports.assertCurrent(ctx, claim, snapshot, 'PUBLICATION');
        const checkRef = await ports.retainCheck(ctx, claim, snapshot, check);
        publication = await ports.publishChecked(ctx, claim, snapshot, checkpointVersion, checkedPublication(candidate, check, checkRef));
        assertPublication(publication);
      }
      await ports.assertCurrent(ctx, claim, snapshot, 'DELIVERY');
      for (const projection of publication.body.candidate.workProjections) {
        if (!projection.result || projection.lifecycle !== 'ACTIVE' || projection.disposition === 'REVOKED') continue;
        await ports.enqueueOriginalProjection(ctx, claim, snapshot, publication, projection);
      }
      await ports.finishAttempt(ctx, attempt, publication.reference);
    });
  } catch (error) {
    if (error instanceof Z1ProcessFailure) await ports.recordProcess(ctx, attempt, error.receipt);
    await ports.retainFailure(ctx, attempt, error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ?
      error.message : 'NATIVE_Z1_OWNER_OR_STORAGE_FAILURE', processInFlight);
    throw error;
  }
}
/** Same S5 lock as existing owners, never a Z1 capacity/grant ledger. */
export async function consumeSharedWorkProjection(
  ctx: PeMutationContext, reference: ExperimentRef, workId: string, ports: Z1NativePorts,
): Promise<NativeOwnerReceipt> {
  developmentProfile();
  requireZ1(ports.contract === Z1_OWNER_CONTRACT, 'NATIVE_Z1_OWNER_BINDINGS_REQUIRED');
  return withS5PortfolioTransaction(ctx, async client => {
    const { publication, currentRequest } = await ports.loadPublishedTx(ctx, client, reference, workId);
    assertPublication(publication); assertPrincipal(ctx, currentRequest);
    requireZ1(currentness(publication.body.candidate, currentRequest, workId) === 'CURRENT', 'ORIGINAL_WORK_PROJECTION_NOT_CURRENT', 'STALE');
    requireZ1((await runtimeIdentity()).digest === publication.body.candidate.envelope.producerBuildIdentity, 'INSTALLED_Z1_BUILD_CHANGED', 'STALE');
    const projection = projectForWork(publication.body.candidate, workId, { tenantId: ctx.auth.tenantId, principalId: actor(ctx) });
    requireZ1(projection.result && projection.lifecycle === 'ACTIVE', 'USABLE_ORIGINAL_WORK_RESULT_REQUIRED');
    await ports.assertOriginalCapacityTx(ctx, client, projection);
    await ports.assertExistingS8ConsumptionAdmissionTx(ctx, client, publication, projection);
    const receipt = await ports.consumeS3OrS4Tx(ctx, client, publication, projection);
    requireZ1(['S3', 'S4'].includes(receipt.owner) && receipt.workId === workId &&
      receipt.originalParentReservationRef === projection.binding.original.resources.parentReservationRef &&
      receipt.resultDigest === digest(projection.result) && epistemicHash(receipt.artifactRef) === epistemicHash(reference) &&
      ['INDEPENDENTLY_OBSERVED', 'UNKNOWN'].includes(receipt.observation) &&
      receipt.executionAuthorityGranted === false && projection.unresolvedObligationRefs.every(ref => receipt.unresolvedObligationRefs.includes(ref)),
    'SEPARATE_NATIVE_OWNER_CONSUMPTION_BINDING', 'COUNTEREXAMPLE');
    await ports.recordS7AndConsumptionTx(ctx, client, publication, receipt);
    return receipt;
  });
}

import type { TenantContext } from '@finnor/shared-types';
import { fault, hash, type InputArtifact } from './contracts';
import { actor, artifact, head, readArtifact, tx, assertBasis } from './store';
import { currentInput } from './owners';
import { beginControl, finishControl } from './accounting';
export interface Checkpoint {
  schema: 'finnor.branch-checkpoint.v1'; tenantId: string; principalId: string; branchId: string;
  inputDigest: string; programmeDigest: string; kind: string; profile: string; generation: number;
  runtime: { node: string; architecture: string; platform: string }; state: Record<string, any> | null;
  stateDigest: string; candidate: any; consistency: string; credentialsIncluded: false; completed: boolean;
  rightsRevision: number; workDigest: string;
  resultId: string; resultDigest: string; checkVersion: string; checkDomain: string; environmentDigest: string;
}
async function createCheckpointBytes(ctx: TenantContext, branchId: string) {
  const h = await tx(ctx, c => head(c, ctx, branchId));
  if (h.status !== 'COMPLETE' || !h.result_id) fault('CONSISTENT_CHECKPOINT_UNAVAILABLE');
  const input = await tx(ctx, c => readArtifact<InputArtifact>(c, ctx, h.input_id, 'INPUT'));
  await currentInput(ctx, input);
  return tx(ctx, async c => {
    const fresh = await head(c, ctx, branchId, true); await assertBasis(c, ctx, fresh);
    if (fresh.result_id !== h.result_id || fresh.status !== 'COMPLETE') fault('CHECKPOINT_GENERATION_CHANGED');
    const result = await readArtifact<any>(c, ctx, h.result_id!, 'RESULT');
    if (!result.check.passed || result.generation !== h.generation) fault('CHECKPOINT_CHECKS_UNQUALIFIED');
    const state = result.candidate.state;
    const cp: Checkpoint = { schema: 'finnor.branch-checkpoint.v1', tenantId: ctx.tenantId, principalId: actor(ctx), branchId, inputDigest: hash(input), programmeDigest: input.programme.contentDigest, kind: input.kind, profile: input.profile, generation: h.generation, runtime: { node: process.version, architecture: process.arch, platform: process.platform }, state, stateDigest: hash(state), candidate: result.candidate, consistency: state === null ? 'IMMUTABLE_INPUT_RESTART' : 'COMMITTED_QUIESCENT_SQLITE_LOGICAL_STATE_AND_FSYNC_FILE', credentialsIncluded: false, completed: true, rightsRevision: input.basis.rightsRevision, workDigest: input.basis.inputDigest, resultId: h.result_id!, resultDigest: hash(result), checkVersion: result.check.version, checkDomain: result.check.domain, environmentDigest: hash(result.environmentAttestation) };
    const checkpointId = await artifact(c, ctx, h.work_id, 'CHECKPOINT', cp);
    await c.query('UPDATE finnor_os.p3_requests SET checkpoint_id=$2 WHERE id=$1', [branchId, checkpointId]);
    return { checkpointId, checkpointDigest: hash(cp), resumeProtocol: state ? 'VERIFIED_PRIVATE_LOGICAL_CLONE_FRESH_SESSION' : 'IDENTICAL_IMMUTABLE_INPUT_RESTART', qualification: 'LOGICAL_CHECKPOINT_NOT_PROCESS_MEMORY_SNAPSHOT' };
  });
}
async function verifyCheckpointBytes(ctx: TenantContext, input: InputArtifact, checkpointId: string) {
  await currentInput(ctx, input);
  const cp = await tx(ctx, c => readArtifact<Checkpoint>(c, ctx, checkpointId, 'CHECKPOINT'));
  if (cp.tenantId !== ctx.tenantId || cp.principalId !== actor(ctx)) fault('PERMITTED_BRANCH_UNAVAILABLE', 404);
  if (cp.schema !== 'finnor.branch-checkpoint.v1' || cp.inputDigest !== hash(input) || cp.programmeDigest !== input.programme.contentDigest || cp.kind !== input.kind || cp.profile !== input.profile || cp.runtime.node !== process.version || cp.runtime.platform !== process.platform || cp.runtime.architecture !== process.arch || cp.stateDigest !== hash(cp.state) || cp.credentialsIncluded !== false || cp.rightsRevision !== input.basis.rightsRevision || cp.workDigest !== input.basis.inputDigest) fault('CHECKPOINT_INCOMPATIBLE_OR_QUARANTINED');
  await tx(ctx, async c => {
    const source = await head(c, ctx, cp.branchId);
    if (source.result_id !== cp.resultId || source.input_id == null || source.generation !== cp.generation || source.status !== 'COMPLETE' || cp.completed !== true) fault('CHECKPOINT_RESULT_ORIGIN_INVALID');
    const result = await readArtifact<any>(c, ctx, cp.resultId, 'RESULT');
    if (hash(result) !== cp.resultDigest || result.check.passed !== true || cp.checkVersion !== result.check.version || cp.checkDomain !== result.check.domain || cp.environmentDigest !== hash(result.environmentAttestation) || hash(cp.candidate) !== hash(result.candidate) || hash(cp.state) !== hash(result.candidate.state)) fault('CHECKPOINT_STATE_OR_CHECK_ORIGIN_INVALID');
  });
  return cp;
}
export async function createCheckpoint(ctx: TenantContext, branchId: string) {
  const h = await tx(ctx, c => head(c, ctx, branchId));
  const control = await beginControl(ctx, h.work_id, 'CHECKPOINT_WRITE', 5000, { branchId });
  let checkpointId: string | null = null, outputBytes: number | null = null, failure: string | null = null;
  try {
    const result = await createCheckpointBytes(ctx, branchId); checkpointId = result.checkpointId;
    const bytes = await tx(ctx, c => readArtifact<Checkpoint>(c, ctx, checkpointId!, 'CHECKPOINT'));
    outputBytes = Buffer.byteLength(JSON.stringify(bytes));
    return result;
  } catch (e) { failure = e instanceof Error ? e.message : 'CHECKPOINT_WRITE_FAILED'; throw e; }
  finally { await finishControl(control, { branchId, checkpointId, outputBytes, storageBytes: outputBytes, failure, meterStatus: 'ORDINARY_SQL_LOGICAL_CHECKPOINT_BYTES_NOT_MEMORY_SNAPSHOT_IO' }); }
}
export async function verifyCheckpoint(ctx: TenantContext, input: InputArtifact, checkpointId: string) {
  const control = await beginControl(ctx, input.basis.workId, 'CHECKPOINT_READ_VERIFY', 5000, { checkpointId, inputId: null });
  let inputBytes: number | null = null, failure: string | null = null;
  try {
    const result = await verifyCheckpointBytes(ctx, input, checkpointId);
    inputBytes = Buffer.byteLength(JSON.stringify(result));
    return result;
  } catch (e) { failure = e instanceof Error ? e.message : 'CHECKPOINT_VERIFY_FAILED'; throw e; }
  finally { await finishControl(control, { checkpointId, inputBytes, failure, meterStatus: 'VERIFIED_ORDINARY_SQL_LOGICAL_CHECKPOINT_BYTES' }); }
}

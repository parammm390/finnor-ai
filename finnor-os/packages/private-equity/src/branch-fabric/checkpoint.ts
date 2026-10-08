import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import type { TenantContext } from '@finnor/shared-types';
import type { PoolClient } from 'pg';
import { canonical, fault, hash, Hex, Id, bytesHash, type InputArtifact } from './contracts';
import { actor, artifact, head, readArtifact, tx, assertBasis, workBasis, type Head } from './store';
import { currentInput } from './owners';
import { beginControl, finishControl } from './accounting';
import { checkpointCustody, withCheckpointKey } from './checkpoint-custody';
import { branchRemainingMs } from './budget';
import { verifiedLinuxProfile } from './linux';
export interface Checkpoint {
  schema: 'finnor.branch-checkpoint.v1'; tenantId: string; principalId: string; branchId: string;
  inputDigest: string; programmeDigest: string; kind: string; profile: string; generation: number;
  runtime: { node: string; architecture: string; platform: string }; state: Record<string, any> | null;
  stateDigest: string; candidate: any; consistency: string; credentialsIncluded: false; completed: boolean;
  rightsRevision: number; workDigest: string;
  resultId: string; resultDigest: string; checkVersion: string; checkDomain: string; environmentDigest: string;
}
const BindingSchema = z.object({
  tenantId: Id, principalId: Id, workId: Id, branchId: Id, rootDigest: Hex, rightsRevision: z.number().int().positive(),
  programmeDigest: Hex, runtimeDigest: Hex, imageDigest: Hex, inputDigest: Hex, scenarioDigest: Hex, grantDigest: Hex,
  parentCheckpointId: Id.nullable(), attemptId: Id, attemptDigest: Hex, resultId: Id, resultDigest: Hex,
  generation: z.number().int().positive(), epoch: z.number().int().nonnegative(), workDigest: Hex,
}).strict();
const SealedSchema = z.object({
  schema: z.literal('finnor.branch-checkpoint-sealed.v2'), recordId: Id, keyId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
  binding: BindingSchema, payloadDigest: Hex, plaintextBytes: z.number().int().min(1).max(3145728),
  kind: z.string(), profile: z.string(), consistency: z.string(), credentialsIncluded: z.literal(false),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  qualification: z.literal('ENCRYPTED_LOGICAL_STATE_NOT_PROCESS_MEMORY_OR_PROTECTED_CUSTODY'),
}).strict();
type Sealed = z.infer<typeof SealedSchema>;
async function checkpointBinding(c: PoolClient, ctx: TenantContext, input: InputArtifact, h: Head, result: any) {
  if (!h.attempt_id || !h.result_id) fault('CHECKPOINT_RESULT_ORIGIN_INVALID');
  const attempt = await readArtifact<any>(c, ctx, h.attempt_id, 'ATTEMPT');
  if (attempt.branchId !== h.id || attempt.generation !== h.generation || attempt.inputDigest !== hash(input))
    fault('CHECKPOINT_RESULT_ORIGIN_INVALID');
  const permits = (await c.query(`SELECT body FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2
    AND category='EVENT' AND body->>'attemptId'=$3 AND body->>'type'='RESOURCE_LEASES_ACQUIRED' ORDER BY id`,
    [ctx.tenantId, actor(ctx), h.attempt_id])).rows.map(r => r.body);
  const runtimeDigest = hash({ node: process.version, binaryDigest: bytesHash(await readFile(process.execPath)),
    architecture: process.arch, platform: process.platform, programme: input.programme.contentDigest });
  const imageDigest = input.profile === 'LINUX_GVISOR_DEVELOPMENT' ?
    hash((await verifiedLinuxProfile()).rootfsFiles) : runtimeDigest;
  return BindingSchema.parse({ tenantId: ctx.tenantId, principalId: actor(ctx), workId: h.work_id, branchId: h.id,
    rootDigest: hash(input.root), rightsRevision: input.basis.rightsRevision, programmeDigest: input.programme.contentDigest,
    runtimeDigest, imageDigest, inputDigest: hash(input), scenarioDigest: hash({ source: input.source, owners: input.ownerBindings }),
    grantDigest: hash({ leases: attempt.leases ?? null, permits, funding: null, admission: null }),
    parentCheckpointId: h.request.checkpointId ?? null, attemptId: h.attempt_id, attemptDigest: hash(attempt),
    resultId: h.result_id, resultDigest: hash(result), generation: h.generation, epoch: h.epoch,
    workDigest: input.basis.inputDigest });
}
const aad = (ctx: TenantContext, checkpointId: string, sealed: Sealed) => Buffer.from(canonical({
  schema: 'finnor.p3.checkpoint-payload.v2', checkpointId, tenantId: ctx.tenantId, principalId: actor(ctx),
  workId: sealed.binding.workId, metadataDigest: hash(sealed), keyId: sealed.keyId,
}));
async function createCheckpointBytes(ctx: TenantContext, branchId: string) {
  branchRemainingMs();
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
    const custody = await checkpointCustody(), binding = await checkpointBinding(c, ctx, input, fresh, result);
    const retention = (await c.query("SELECT retention_days FROM finnor_os.tenant_retention_policies WHERE tenant_id=$1 AND data_class='p3_checkpoint'", [ctx.tenantId])).rows[0];
    const now = Date.now(), expiresAt = new Date(now + Math.min(custody.maxRetentionMs, Number(retention?.retention_days ?? 1) * 86400000)).toISOString();
    const plain = Buffer.from(canonical(cp)), checkpointId = randomUUID();
    if (plain.length > 3145728) fault('CHECKPOINT_PAYLOAD_BOUND', 413);
    const sealed: Sealed = SealedSchema.parse({ schema: 'finnor.branch-checkpoint-sealed.v2', recordId: randomUUID(),
      keyId: custody.activeKeyId, binding, payloadDigest: hash(cp), plaintextBytes: plain.length, kind: input.kind,
      profile: input.profile, consistency: cp.consistency, credentialsIncluded: false, createdAt: new Date(now).toISOString(),
      expiresAt, qualification: 'ENCRYPTED_LOGICAL_STATE_NOT_PROCESS_MEMORY_OR_PROTECTED_CUSTODY' });
    try {
      const encrypted = await withCheckpointKey(custody.activeKeyId, bytes => {
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', bytes, nonce); cipher.setAAD(aad(ctx, checkpointId, sealed));
        const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
        return { nonce, tag: cipher.getAuthTag(), ciphertext };
      });
      const saved = await artifact(c, ctx, h.work_id, 'CHECKPOINT', sealed, checkpointId);
      if (saved !== checkpointId) fault('CHECKPOINT_IDENTITY_CONFLICT');
      await c.query(`INSERT INTO finnor_os.p3_checkpoint_payloads(tenant_id,principal_id,work_id,checkpoint_id,key_id,nonce,tag,ciphertext,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [ctx.tenantId, actor(ctx), h.work_id, checkpointId, sealed.keyId,
        encrypted.nonce, encrypted.tag, encrypted.ciphertext, expiresAt]);
    } finally { plain.fill(0); }
    await c.query('UPDATE finnor_os.p3_requests SET checkpoint_id=$2 WHERE id=$1', [branchId, checkpointId]);
    return { checkpointId, checkpointDigest: hash(sealed), payloadDigest: sealed.payloadDigest, keyId: sealed.keyId,
      expiresAt, resumeProtocol: state ? 'VERIFIED_PRIVATE_LOGICAL_CLONE_FRESH_SESSION' : 'IDENTICAL_IMMUTABLE_INPUT_RESTART',
      qualification: 'ENCRYPTED_LOGICAL_CHECKPOINT_NOT_PROCESS_MEMORY_OR_PROTECTED_CUSTODY' };
  });
}
async function verifyCheckpointBytes(ctx: TenantContext, input: InputArtifact, checkpointId: string) {
  branchRemainingMs();
  await currentInput(ctx, input);
  return tx(ctx, async c => {
    const parsed = SealedSchema.safeParse(await readArtifact<unknown>(c, ctx, checkpointId, 'CHECKPOINT'));
    if (!parsed.success) fault('CHECKPOINT_LEGACY_OR_INVALID_REQUIRES_RECAPTURE');
    const sealed = parsed.data, source = await head(c, ctx, sealed.binding.branchId, true);
    await assertBasis(c, ctx, source);
    if (source.status !== 'COMPLETE' || source.input_id == null || !source.result_id) fault('CHECKPOINT_RESULT_ORIGIN_INVALID');
    const result = await readArtifact<any>(c, ctx, source.result_id, 'RESULT');
    const binding = await checkpointBinding(c, ctx, input, source, result);
    if (hash(binding) !== hash(sealed.binding) || sealed.kind !== input.kind || sealed.profile !== input.profile)
      fault('CHECKPOINT_BINDING_MISMATCH');
    if ((await c.query('SELECT checkpoint_id FROM finnor_os.p3_checkpoint_revocations WHERE checkpoint_id=$1 FOR SHARE', [checkpointId])).rowCount)
      fault('CHECKPOINT_REVOKED');
    if (Date.parse(sealed.expiresAt) <= Date.now()) fault('CHECKPOINT_EXPIRED', 410);
    const p = (await c.query('SELECT * FROM finnor_os.p3_checkpoint_payloads WHERE checkpoint_id=$1 FOR SHARE', [checkpointId])).rows[0];
    if (!p) fault('CHECKPOINT_PAYLOAD_ERASED', 410);
    if (p.key_id !== sealed.keyId || p.tenant_id !== ctx.tenantId || p.principal_id !== actor(ctx) ||
      p.work_id !== input.basis.workId || p.expires_at.toISOString() !== sealed.expiresAt) fault('CHECKPOINT_BINDING_MISMATCH');
    const cp = await withCheckpointKey(sealed.keyId, bytes => {
      let plain: Buffer | undefined;
      try {
        const decipher = createDecipheriv('aes-256-gcm', bytes, p.nonce); decipher.setAAD(aad(ctx, checkpointId, sealed)); decipher.setAuthTag(p.tag);
        plain = Buffer.concat([decipher.update(p.ciphertext), decipher.final()]);
        if (plain.length !== sealed.plaintextBytes) fault('CHECKPOINT_AUTHENTICATION_FAILED');
        const value = JSON.parse(plain.toString()) as Checkpoint;
        if (hash(value) !== sealed.payloadDigest) fault('CHECKPOINT_AUTHENTICATION_FAILED');
        return value;
      } catch { return fault('CHECKPOINT_AUTHENTICATION_FAILED'); }
      finally { plain?.fill(0); }
    });
    if (cp.schema !== 'finnor.branch-checkpoint.v1' || cp.tenantId !== ctx.tenantId || cp.principalId !== actor(ctx) ||
      cp.branchId !== source.id || cp.resultId !== source.result_id || cp.generation !== source.generation ||
      cp.inputDigest !== hash(input) || cp.stateDigest !== hash(cp.state) || cp.credentialsIncluded !== false ||
      cp.completed !== true || hash(result) !== cp.resultDigest || result.check.passed !== true ||
      cp.checkVersion !== result.check.version || cp.checkDomain !== result.check.domain ||
      cp.environmentDigest !== hash(result.environmentAttestation) || hash(cp.candidate) !== hash(result.candidate) ||
      hash(cp.state) !== hash(result.candidate.state)) fault('CHECKPOINT_STATE_OR_CHECK_ORIGIN_INVALID');
    return cp;
  });
}
export async function createCheckpoint(ctx: TenantContext, branchId: string) {
  const h = await tx(ctx, c => head(c, ctx, branchId));
  const control = await beginControl(ctx, h.work_id, 'CHECKPOINT_WRITE', 5000, { branchId });
  let checkpointId: string | null = null, outputBytes: number | null = null, failure: string | null = null;
  try {
    const result = await createCheckpointBytes(ctx, branchId); checkpointId = result.checkpointId;
    outputBytes = await tx(ctx, async c => {
      const r = (await c.query('SELECT octet_length(ciphertext) AS bytes FROM finnor_os.p3_checkpoint_payloads WHERE checkpoint_id=$1', [checkpointId])).rows[0];
      return Number(r.bytes);
    });
    return result;
  } catch (e) { failure = e instanceof Error ? e.message : 'CHECKPOINT_WRITE_FAILED'; throw e; }
  finally { await finishControl(control, { branchId, checkpointId, outputBytes, storageBytes: outputBytes, failure, meterStatus: 'ORDINARY_SQL_LOGICAL_CHECKPOINT_BYTES_NOT_MEMORY_SNAPSHOT_IO' }); }
}
export async function revokeCheckpoint(ctx: TenantContext, branchId: string, checkpointId: string) {
  return tx(ctx, async c => {
    const h = await head(c, ctx, branchId); await workBasis(c, ctx, h.work_id);
    const parsed = SealedSchema.safeParse(await readArtifact(c, ctx, checkpointId, 'CHECKPOINT'));
    if (!parsed.success || parsed.data.binding.branchId !== branchId || parsed.data.binding.workId !== h.work_id)
      fault('PERMITTED_BRANCH_UNAVAILABLE', 404);
    await c.query(`INSERT INTO finnor_os.p3_checkpoint_revocations(tenant_id,principal_id,work_id,checkpoint_id,reason)
      VALUES($1,$2,$3,$4,'OWNER_REVOKED') ON CONFLICT(checkpoint_id) DO NOTHING`, [ctx.tenantId, actor(ctx), h.work_id, checkpointId]);
    await artifact(c, ctx, h.work_id, 'EVENT', { branchId, checkpointId, type: 'CHECKPOINT_REVOKED', payloadErased: false, liabilitiesRetained: true });
    return { checkpointId, status: 'REVOKED', immutableHistoryRetained: true };
  });
}
export async function purgeCheckpoints(ctx: TenantContext, branchId: string) {
  return tx(ctx, async c => {
    const h = await head(c, ctx, branchId); await workBasis(c, ctx, h.work_id);
    const r = await c.query(`WITH eligible AS MATERIALIZED(SELECT p.checkpoint_id FROM finnor_os.p3_checkpoint_payloads p
      WHERE p.tenant_id=$1 AND p.principal_id=$2 AND p.work_id=$3
      AND (p.expires_at<=clock_timestamp() OR EXISTS(SELECT 1 FROM finnor_os.p3_checkpoint_revocations r WHERE r.checkpoint_id=p.checkpoint_id))
      AND NOT EXISTS(SELECT 1 FROM finnor_os.data_retention_holds q WHERE q.tenant_id=$1 AND q.released_at IS NULL AND
        ((q.resource_type='work' AND q.resource_id=$3) OR (q.resource_type='p3_checkpoint' AND q.resource_id=p.checkpoint_id)))
      AND NOT EXISTS(SELECT 1 FROM finnor_os.tenant_retention_policies t WHERE t.tenant_id=$1 AND t.data_class='p3_checkpoint' AND t.legal_hold)
      ORDER BY p.expires_at,p.checkpoint_id LIMIT 128 FOR UPDATE SKIP LOCKED)
      DELETE FROM finnor_os.p3_checkpoint_payloads p USING eligible e WHERE p.checkpoint_id=e.checkpoint_id
      RETURNING p.checkpoint_id,octet_length(p.ciphertext) AS bytes`, [ctx.tenantId, actor(ctx), h.work_id]);
    if (r.rowCount) await artifact(c, ctx, h.work_id, 'CLEANUP', { branchId, type: 'ENCRYPTED_CHECKPOINT_PAYLOADS_ERASED',
      checkpointIds: r.rows.map(v => v.checkpoint_id), deletedBytes: r.rows.reduce((sum, v) => sum + Number(v.bytes), 0),
      immutableHistoryRetained: true, canonicalS6HistoryTouched: false, accountingLiabilitiesRetained: true });
    return { purgedPayloads: r.rowCount, immutableHistoryRetained: true, canonicalS6HistoryTouched: false, limit: 128 };
  });
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

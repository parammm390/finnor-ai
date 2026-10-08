/** Registered completion stories. Real signed API/ordinary SQL, no test authority. */
import assert from 'node:assert/strict';
import { createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { POST } from '../../apps/api/app/api/branches/[operation]/route';
import { actor, artifact, readArtifact, tx } from '../../packages/private-equity/src/branch-fabric/store';

interface Support {
  owner: any; other: any; appRun: any; admin: any; custodyDirectory: string;
  api: (f: any, operation: string, body: unknown) => Promise<any>;
  tickBranch: (branchId: string) => Promise<boolean>;
  challenge: (id: string, steps: string[], expected: string, invoke: () => Promise<unknown>) => Promise<void>;
  save: (name: string, value: unknown) => Promise<void>;
  expiredBodyDiagnostics?: boolean;
}
const canonical = (v: any): string => v === null || typeof v !== 'object' ? JSON.stringify(v) :
  Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' :
  '{' + Object.keys(v).sort((a, b) => a.localeCompare(b)).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
const digest = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
const ok = (r: any) => { assert(r.status >= 200 && r.status < 300, JSON.stringify(r)); return r.body; };

export async function checkpointSecurity(s: Support) {
  let checkpoint: any, metadata: any, payload: any;
  await s.challenge('CB-P3-encrypted-checkpoint', [
    'Real completed private fixture and ordinary checkpoint API',
    'Ordinary-role immutable metadata and ciphertext read',
    'Independent AES-GCM decode against the independently read private application state',
  ], 'No checkpoint plaintext in immutable metadata; tenant/Work/code/runtime/scenario/grant/attempt bindings authenticated', async () => {
    checkpoint = ok(await s.api(s.owner, 'checkpoint', { branchId: s.appRun.s.branchId }));
    metadata = await tx(s.owner.ctx, c => readArtifact<any>(c, s.owner.ctx, checkpoint.checkpointId, 'CHECKPOINT'));
    assert.equal(metadata.schema, 'finnor.branch-checkpoint-sealed.v2', 'Private checkpoint is still stored in plaintext');
    assert(!('state' in metadata)); assert(!('candidate' in metadata));
    for (const field of ['tenantId', 'principalId', 'workId', 'rootDigest', 'rightsRevision', 'programmeDigest',
      'runtimeDigest', 'imageDigest', 'inputDigest', 'scenarioDigest', 'grantDigest', 'parentCheckpointId', 'attemptId', 'attemptDigest'])
      assert(field in metadata.binding, 'Missing authenticated binding: ' + field);
    payload = await tx(s.owner.ctx, async c => (await c.query(
      'SELECT * FROM finnor_os.p3_checkpoint_payloads WHERE checkpoint_id=$1', [checkpoint.checkpointId])).rows[0]);
    assert(payload); assert.equal(payload.key_id, metadata.keyId);
    assert(!payload.ciphertext.includes(Buffer.from('feeCents')));
    const key = await readFile(join(s.custodyDirectory, 'keys', metadata.keyId + '.key'));
    try {
      const decrypt = createDecipheriv('aes-256-gcm', key, payload.nonce);
      decrypt.setAAD(Buffer.from(canonical({ schema: 'finnor.p3.checkpoint-payload.v2', checkpointId: checkpoint.checkpointId,
        tenantId: s.owner.ctx.tenantId, principalId: actor(s.owner.ctx), workId: s.owner.workId,
        metadataDigest: digest(metadata), keyId: metadata.keyId })));
      decrypt.setAuthTag(payload.tag);
      const original = JSON.parse(Buffer.concat([decrypt.update(payload.ciphertext), decrypt.final()]).toString());
      assert.equal(digest(original), metadata.payloadDigest);
      assert.deepEqual(original.state, s.appRun.branch.result.candidate.state);
      assert.equal(original.credentialsIncluded, false);
    } finally { key.fill(0); }
    return { checkpoint, metadata, payloadBytes: payload.ciphertext.length, independentlyDecodedStateMatches: true,
      qualification: 'Ordinary local custody and logical state, not protected key admission or process memory' };
  });
  await s.challenge('CB-P3-checkpoint-tamper-and-key-rotation', [
    'Append wrong-root/rights/input/grant/attempt metadata with retained ciphertext',
    'Tampered nonce/tag/ciphertext in newly inserted fault records, never mutate originals',
    'Rotate actual local active key; old version remains readable only while retained',
    'Remove old owned key; do not silently use a newer key',
  ], 'Wrong bindings/ciphertext/key refuse at exact guards, foreign principal gets no checkpoint metadata', async () => {
    assert.equal(metadata?.schema, 'finnor.branch-checkpoint-sealed.v2', 'Encrypted checkpoint prerequisite unpassed');
    const refusals = [];
    for (const [field, value] of [['rootDigest', '0'.repeat(64)], ['rightsRevision', metadata.binding.rightsRevision + 1],
      ['inputDigest', '0'.repeat(64)], ['grantDigest', '0'.repeat(64)], ['attemptId', randomUUID()]] as const) {
      const changed = { ...metadata, recordId: randomUUID(), binding: { ...metadata.binding, [field]: value } };
      const id = await tx(s.owner.ctx, c => artifact(c, s.owner.ctx, s.owner.workId, 'CHECKPOINT', changed));
      await insertPayload(id, payload);
      const r = await s.api(s.owner, 'resume', { branchId: s.appRun.s.branchId, checkpointId: id, idempotencyKey: randomUUID() });
      assert.equal(r.status, 409); assert.equal(r.body.code, 'CHECKPOINT_BINDING_MISMATCH'); refusals.push({ field, response: r });
    }
    for (const field of ['nonce', 'tag', 'ciphertext']) {
      const changed = { ...metadata, recordId: randomUUID() };
      const id = await tx(s.owner.ctx, c => artifact(c, s.owner.ctx, s.owner.workId, 'CHECKPOINT', changed));
      const bytes = Buffer.from(payload[field]); bytes[0] = bytes[0]! ^ 1;
      await insertPayload(id, { ...payload, [field]: bytes });
      const r = await s.api(s.owner, 'resume', { branchId: s.appRun.s.branchId, checkpointId: id, idempotencyKey: randomUUID() });
      assert.equal(r.status, 409); assert.equal(r.body.code, 'CHECKPOINT_AUTHENTICATION_FAILED'); refusals.push({ field, response: r });
    }
    const foreign = await s.api(s.other, 'resume', { branchId: s.appRun.s.branchId, checkpointId: checkpoint.checkpointId, idempotencyKey: randomUUID() });
    assert.equal(foreign.status, 404); assert.deepEqual(foreign.body, { code: 'PERMITTED_BRANCH_UNAVAILABLE' });
    const config = join(s.custodyDirectory, 'current.json'), before = await readFile(config);
    const oldPath = join(s.custodyDirectory, 'keys', metadata.keyId + '.key'), old = await readFile(oldPath);
    const nextId = 'disposable-p3-rotation-' + randomUUID().slice(0, 8), nextPath = join(s.custodyDirectory, 'keys', nextId + '.key');
    const next = randomBytes(32);
    try {
      await writeFile(nextPath, next, { flag: 'wx', mode: 0o600 });
      await writeFile(config, JSON.stringify({ ...JSON.parse(before.toString()), activeKeyId: nextId }), { mode: 0o600 });
      const accepted = ok(await s.api(s.owner, 'resume', { branchId: s.appRun.s.branchId, checkpointId: checkpoint.checkpointId, idempotencyKey: randomUUID() }));
      ok(await s.api(s.owner, 'cancel', { branchId: accepted.branchId })); await s.tickBranch(accepted.branchId);
      await unlink(oldPath); // Only this run's newly generated ephemeral key.
      const unavailable = await s.api(s.owner, 'resume', { branchId: s.appRun.s.branchId, checkpointId: checkpoint.checkpointId, idempotencyKey: randomUUID() });
      assert.equal(unavailable.status, 503); assert.equal(unavailable.body.code, 'CHECKPOINT_KEY_UNAVAILABLE');
      await writeFile(oldPath, next, { flag: 'wx', mode: 0o600 });
      const wrongKey = await s.api(s.owner, 'resume', { branchId: s.appRun.s.branchId, checkpointId: checkpoint.checkpointId, idempotencyKey: randomUUID() });
      assert.equal(wrongKey.status, 409); assert.equal(wrongKey.body.code, 'CHECKPOINT_AUTHENTICATION_FAILED');
      return { refusals, foreign, unavailable, wrongKey, activeKeyIdChangedWithoutReencryptingHistory: true };
    } finally {
      await writeFile(oldPath, old, { mode: 0o600 }); await writeFile(config, before, { mode: 0o600 });
      await unlink(nextPath); old.fill(0); next.fill(0);
    }
    async function insertPayload(id: string, p: any) {
      await tx(s.owner.ctx, c => c.query(`INSERT INTO finnor_os.p3_checkpoint_payloads(
        tenant_id,principal_id,work_id,checkpoint_id,key_id,nonce,tag,ciphertext,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [s.owner.ctx.tenantId, actor(s.owner.ctx), s.owner.workId,
        id, p.key_id, p.nonce, p.tag, p.ciphertext, p.expires_at]));
    }
  });
  await s.challenge('CB-P3-checkpoint-revocation-retention-erasure', [
    'Revoke exact retained checkpoint through signed owner API',
    'Expired fresh checkpoint with actual bounded local custody retention policy',
    'Canonical Work legal hold blocks erasure, not current use',
    'Release hold and delete only encrypted payload; immutable result/attempt/cost history remains',
  ], 'Expired/revoked checkpoints cannot resume; erasure preserves all audit and unknown accounting obligations', async () => {
    assert.equal(metadata?.schema, 'finnor.branch-checkpoint-sealed.v2', 'Encrypted checkpoint prerequisite unpassed');
    const originalResult = await tx(s.owner.ctx, c => readArtifact<any>(c, s.owner.ctx, metadata.binding.resultId, 'RESULT'));
    const revoked = ok(await s.api(s.owner, 'checkpoint-revoke', { branchId: s.appRun.s.branchId, checkpointId: checkpoint.checkpointId }));
    const refused = await s.api(s.owner, 'resume', { branchId: s.appRun.s.branchId, checkpointId: checkpoint.checkpointId, idempotencyKey: randomUUID() });
    assert.equal(refused.status, 409); assert.equal(refused.body.code, 'CHECKPOINT_REVOKED');
    const config = join(s.custodyDirectory, 'current.json'), before = await readFile(config);
    let expiring: any;
    try {
      await writeFile(config, JSON.stringify({ ...JSON.parse(before.toString()), maxRetentionMs: 150 }), { mode: 0o600 });
      expiring = ok(await s.api(s.owner, 'checkpoint', { branchId: s.appRun.s.branchId }));
    } finally { await writeFile(config, before, { mode: 0o600 }); }
    const hold = randomUUID();
    await s.admin.query(`INSERT INTO finnor_os.data_retention_holds(id,tenant_id,resource_type,resource_id,reason,held_by)
      VALUES($1,$2,'work',$3,'Track B generated retention story',$4)`, [hold, s.owner.ctx.tenantId, s.owner.workId, actor(s.owner.ctx)]);
    await new Promise(resolve => setTimeout(resolve, 180));
    const expired = await s.api(s.owner, 'resume', { branchId: s.appRun.s.branchId, checkpointId: expiring.checkpointId, idempotencyKey: randomUUID() });
    assert.equal(expired.status, 410); assert.equal(expired.body.code, 'CHECKPOINT_EXPIRED');
    const held = ok(await s.api(s.owner, 'checkpoint-purge', { branchId: s.appRun.s.branchId }));
    assert.equal(held.purgedPayloads, 0);
    await s.admin.query('UPDATE finnor_os.data_retention_holds SET released_at=clock_timestamp() WHERE id=$1', [hold]);
    const erased = ok(await s.api(s.owner, 'checkpoint-purge', { branchId: s.appRun.s.branchId }));
    assert(erased.purgedPayloads >= 2); assert.equal(erased.immutableHistoryRetained, true);
    const rows = await tx(s.owner.ctx, c => c.query('SELECT checkpoint_id FROM finnor_os.p3_checkpoint_payloads WHERE checkpoint_id=ANY($1::uuid[])',
      [[checkpoint.checkpointId, expiring.checkpointId]])); assert.equal(rows.rowCount, 0);
    const retained = await tx(s.owner.ctx, c => readArtifact<any>(c, s.owner.ctx, metadata.binding.resultId, 'RESULT'));
    assert.deepEqual(retained, originalResult);
    const inspection = ok(await s.api(s.owner, 'inspect', { branchId: s.appRun.s.branchId }));
    assert(inspection.artifacts.some((r: any) => r.category === 'ATTEMPT'));
    assert(inspection.artifacts.some((r: any) => r.category === 'COST' && r.body.moneyUSD === null));
    return { revoked, refused, expiring, expired, held, erased, retainedResultDigest: digest(retained),
      erasureScope: 'Encrypted logical checkpoint copy only; historical result and canonical S6 evidence are retained' };
  });
}

export async function deadlineSecurity(s: Support) {
  if (s.expiredBodyDiagnostics) await s.challenge('CB-P3-expired-before-body-acquisition', [
    'Real signed original route and stalled request stream',
    'Actual bounded params work spends the original 100 ms clock before abort timer dispatch',
    'Independent no-input/request/job publication observer; retain response before asserting',
  ], 'An already-exhausted original clock still physically cancels and unlocks the unread body without guard EOF', async () => {
    const warm = ok(await s.api(s.owner, 'list', { workId: s.owner.workId, limit: 1 }));
    const counts = async () => (await s.admin.query(`SELECT
      (SELECT count(*) FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND category='INPUT') AS inputs,
      (SELECT count(*) FROM finnor_os.p3_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3) AS requests,
      (SELECT count(*) FROM finnor_os.jobs WHERE tenant_id=$1 AND type='run_branch_fabric_v1') AS jobs`,
      [s.owner.ctx.tenantId, actor(s.owner.ctx), s.owner.workId])).rows[0];
    const before = await counts();
    let cancelled = false, guardSuppliedEOF = false, paramsCpuMs = 0;
    let stream: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(c) { stream = c; c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; },
    });
    const guard = setTimeout(() => { if (!cancelled) { guardSuppliedEOF = true; stream.close(); } }, 1000);
    const began = performance.now();
    let observed: any;
    try {
      const response = await POST(new Request('http://127.0.0.1/api/branches/prepare', {
        method: 'POST', headers: { authorization: 'Bearer ' + s.owner.token, 'content-type': 'application/json', 'x-branch-deadline-ms': '100' },
        body, duplex: 'half',
      } as RequestInit), { get params() {
        return Promise.resolve().then(() => {
          const start = performance.now();
          while (performance.now() - start < 120) { /* Actual bounded CPU, not a substituted clock. */ }
          paramsCpuMs = performance.now() - start;
          return { operation: 'prepare' };
        });
      } });
      observed = { originalDeadlineMs: 100, status: response.status, result: await response.json(),
        cancelled, bodyLocked: body.locked, guardSuppliedEOF, paramsCpuMs,
        elapsedMs: performance.now() - began, warm, before, after: await counts() };
      await s.save('deadline/expired-before-body-acquisition.json', observed);
    } finally { clearTimeout(guard); if (!cancelled && !body.locked) await body.cancel(); }
    assert.equal(observed.status, 408); assert.equal(observed.result.code, 'BRANCH_DEADLINE_EXHAUSTED');
    assert(observed.paramsCpuMs >= 120);
    assert(observed.cancelled && !observed.bodyLocked && !observed.guardSuppliedEOF, JSON.stringify(observed));
    assert.deepEqual(observed.after, observed.before);
    return observed;
  });
  await s.challenge('CB-P3-inclusive-body-deadline', ['48 repeated signed JWT stalled-body requests',
    'Exact original 100 ms auth/body deadline', 'In-flight and already-aborted external controls',
    'Independent no-input/request/job publication observer', 'Retain every response before asserting'],
    'Internal deadlines remain 408; explicit external cancellation remains 409; physical readers are cancelled', async () => {
      const counts = async () => (await s.admin.query(`SELECT
        (SELECT count(*) FROM finnor_os.p3_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND category='INPUT') AS inputs,
        (SELECT count(*) FROM finnor_os.p3_requests WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3) AS requests,
        (SELECT count(*) FROM finnor_os.jobs WHERE tenant_id=$1 AND type='run_branch_fabric_v1') AS jobs`,
        [s.owner.ctx.tenantId, actor(s.owner.ctx), s.owner.workId])).rows[0];
      const before = await counts(), observations = [];
      for (let i = 0; i < 48; i++) observations.push(await stalled('DEADLINE', i));
      const external = [await stalled('EXTERNAL_IN_FLIGHT', 0), await stalled('EXTERNAL_ALREADY_ABORTED', 0)];
      const after = await counts(), observed = { observations, external, before, after,
        qualification: 'REAL_SIGNED_LOCAL_ROUTE_REQUEST_STREAMS_NOT_MOUNTED_OR_LINUX_ADMISSION' };
      await s.save('deadline/body-boundary.json', observed);
      for (const row of observations) {
        assert.equal(row.status, 408, JSON.stringify(row));
        assert.equal(row.result.code, 'BRANCH_DEADLINE_EXHAUSTED', JSON.stringify(row));
        assert(row.cancelled && !row.bodyLocked, JSON.stringify(row)); assert(row.elapsedMs < 1000);
      }
      for (const row of external) {
        assert.equal(row.status, 409, JSON.stringify(row)); assert.equal(row.result.code, 'BRANCH_CANCELLED', JSON.stringify(row));
        assert(row.signalAborted && row.cancelled && !row.bodyLocked, JSON.stringify(row)); assert(row.elapsedMs < 1000);
      }
      assert.deepEqual(after, before);
      return observed;
      async function stalled(mode: 'DEADLINE' | 'EXTERNAL_IN_FLIGHT' | 'EXTERNAL_ALREADY_ABORTED', i: number) {
        let cancelled = false, guardSuppliedEOF = false, stream: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start(c) { stream = c; c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; },
        });
        const controller = new AbortController();
        if (mode === 'EXTERNAL_ALREADY_ABORTED') controller.abort('registered external cancellation');
        const externalTimer = mode === 'EXTERNAL_IN_FLIGHT' ?
          setTimeout(() => controller.abort('registered external cancellation'), 20) : undefined;
        const outerGuard = setTimeout(() => { if (!cancelled) { guardSuppliedEOF = true; stream.close(); } }, 1000);
        const start = performance.now();
        try {
          const response = await POST(new Request('http://127.0.0.1/api/branches/prepare', {
            method: 'POST', headers: { authorization: 'Bearer ' + s.owner.token, 'content-type': 'application/json', 'x-branch-deadline-ms': '100' },
            body, duplex: 'half', signal: controller.signal,
          } as RequestInit), { params: Promise.resolve({ operation: 'prepare' }) });
          return { mode, i, originalDeadlineMs: 100, status: response.status, result: await response.json() as any,
            cancelled, bodyLocked: body.locked, signalAborted: controller.signal.aborted,
            guardSuppliedEOF, elapsedMs: performance.now() - start };
        } finally { clearTimeout(outerGuard); if (externalTimer) clearTimeout(externalTimer); }
      }
    });
  await s.challenge('CB-P3-inclusive-owner-SQL-deadline', ['Lock actual Work owner row', 'Signed API preparation waits on ordinary owner SQL',
    'Original deadline cancels physical SQL', 'No input/result is published'], 'SQL cannot obtain a fresh per-phase clock or publish after the transport budget', async () => {
      await s.admin.query('BEGIN');
      await s.admin.query('SELECT id FROM finnor_os.works WHERE id=$1 FOR UPDATE', [s.owner.workId]);
      const outerGuard = setTimeout(() => { void s.admin.query('ROLLBACK'); }, 750);
      let result: any, status: number, elapsedMs: number;
      try {
        const begin = performance.now(), response = await POST(new Request('http://127.0.0.1/api/branches/prepare', {
          method: 'POST', headers: { authorization: 'Bearer ' + s.owner.token, 'content-type': 'application/json', 'x-branch-deadline-ms': '150' },
          body: JSON.stringify({ workId: s.owner.workId, root: { entityType: 'external_organization', entityId: s.owner.rootId },
            kind: 'pure', profile: 'TRUSTED_NATIVE_H0', source: { kind: 'public_fixture', fixture: 'allocation-abc-v1', parameters: { equity: 95, leverageTenths: 35, reserve: 0 } } }),
        }), { params: Promise.resolve({ operation: 'prepare' }) });
        result = await response.json(); status = response.status; elapsedMs = performance.now() - begin;
      } finally { clearTimeout(outerGuard); await s.admin.query('ROLLBACK'); }
      assert.equal(status, 408); assert.equal(result.code, 'BRANCH_DEADLINE_EXHAUSTED'); assert(elapsedMs < 1200);
      return { result, status, elapsedMs, lockedOwner: 'Actual agent-owned disposable Work, not a sleep mock' };
    });
}

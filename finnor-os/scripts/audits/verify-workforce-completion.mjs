import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const output = process.argv[2];
assert(output?.startsWith('/'), 'Absolute external receipt path required');
const { createNativeOwnerDatabase } = await import(pathToFileURL(root + '/finnor-os/scripts/s7/native-owner-database.mjs'));
const database = await createNativeOwnerDatabase();
const rows = [];
const sourcePaths = ['finnor-os/packages/orchestration/src/workforce-execution/worker.ts', 'finnor-os/packages/db/index.ts'];
const sources = await Promise.all(sourcePaths.map(async path => ({ path,
  sha256: createHash('sha256').update(await readFile(root + '/' + path)).digest('hex') })));
try {
  const owner = await import(pathToFileURL(root + '/finnor-os/packages/orchestration/src/workforce-execution/worker.ts'));
  assert.equal(typeof owner.completeWorkforceProgramTx, 'function', 'Production completion helper must first be extracted');
  const { receiveWork, configureTenantVertical, withTenantTransaction, transactionDb, transitionWorkTx,
    lockTenantMaterialCutTx } = database.db;
  const tenant = randomUUID(), principal = randomUUID();
  await database.admin.query("SET app.test_vertical_mode='explicit'");
  await database.admin.query("INSERT INTO finnor_os.tenants(id,name) VALUES($1,'W2 controlled canonical completion boundary')", [tenant]);
  await database.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",
    [principal, tenant, principal + '@fixture.invalid']);
  await configureTenantVertical({ tenantId: tenant, verticalKey: 'private_equity', expectedVersion: 0,
    createdBy: principal, sourceSystem: 'w2-completion-boundary:fixture' });
  const ctx = { tenantId: tenant, userId: principal, employeeId: principal, role: 'owner' };
  for (const kind of ['current', 'stale', 'cancelled']) {
    const input = await receiveWork({ tenantId: tenant, userId: principal,
      instruction: 'Controlled original workforce request: ' + kind, channel: 'console', idempotencyKey: randomUUID() });
    const programId = randomUUID();
    const q = { tenant_id: tenant, id: programId, principal_id: principal, work_id: input.workId,
      work_input_id: input.workInputId, original: { sourceClass: 'CONTROLLED_DOMAIN_BOUNDARY_FIXTURE' },
      budget: { ref: { owner: 'S5', id: 'CONTROLLED_CLOSURE_BOUNDARY_NOT_RESOURCE_ACCEPTANCE', version: '1', contentDigest: '0'.repeat(64) } } };
    const published = { status: 'CLOSED', program: { revision: 3 }, check: { valid: true,
      qualification: 'CONTROLLED_CLOSURE_INPUT_NOT_EXECUTED_ASSIGNMENTS' } };
    await database.admin.query(`INSERT INTO finnor_os.w2_programs
      (tenant_id,id,principal_id,work_id,work_input_id,idempotency_key,request_digest,original_digest,original,budget,status,revision,program)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8::jsonb,$9::jsonb,'CLOSED',3,$10::jsonb)`,
      [tenant, programId, principal, input.workId, input.workInputId, randomUUID(), '0'.repeat(64),
        JSON.stringify(q.original), JSON.stringify(q.budget), JSON.stringify(published.program)]);
    let continuation = null;
    if (kind === 'stale') continuation = await receiveWork({ tenantId: tenant, userId: principal, workId: input.workId,
      instruction: 'Genuine later instruction remains unfulfilled', channel: 'console', idempotencyKey: randomUUID() });
    if (kind === 'cancelled') await withTenantTransaction(tenant, { userId: principal },
      db => transitionWorkTx(db, tenant, input.workId, 'cancelled', 'controlled_cancellation', {},
        { expectedWorkInputId: input.workInputId }));
    const before = (await database.admin.query('SELECT status,final_outcome FROM finnor_os.works WHERE tenant_id=$1 AND id=$2',
      [tenant, input.workId])).rows[0];
    await withTenantTransaction(tenant, { userId: principal }, async (db, c) => {
      await lockTenantMaterialCutTx(db, tenant);
      await owner.completeWorkforceProgramTx(ctx, q, published, c);
    });
    const after = (await database.admin.query('SELECT status,final_outcome FROM finnor_os.works WHERE tenant_id=$1 AND id=$2',
      [tenant, input.workId])).rows[0];
    const events = (await database.admin.query('SELECT kind,body FROM finnor_os.w2_events WHERE tenant_id=$1 AND program_id=$2 ORDER BY created_at,event_id',
      [tenant, programId])).rows;
    const preserved = kind === 'current' ? after.status === 'completed' && after.final_outcome?.originalInput === input.workInputId
      : after.status === before.status && JSON.stringify(after.final_outcome) === JSON.stringify(before.final_outcome);
    rows.push({ kind, status: preserved ? 'PASS' : 'FAIL', input, continuation, before, after, events });
  }
} catch (error) {
  rows.push({ kind: 'harness', status: 'FAIL', error: error instanceof Error ? error.message : String(error) });
} finally {
  await database.stop();
  const receipt = { schema: 'finnor.w2.canonical-completion-boundary.v1', status: rows.every(r => r.status === 'PASS') && rows.length === 3 ? 'PASS' : 'FAIL',
    sources, cases: rows, qualification: 'CANONICAL_WORK_COMPLETION_BOUNDARY_ONLY_NOT_FULL_WORKFORCE_OR_SETTLEMENT_ACCEPTANCE',
    rerun: 'From finnor-os: node --import=tsx ' + import.meta.filename + ' <absolute receipt>' };
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ status: receipt.status, cases: rows.map(r => ({ kind: r.kind, status: r.status, error: r.error })) }));
  if (receipt.status !== 'PASS') process.exitCode = 1;
}

import { z } from 'zod';
import type { PeMutationContext } from '../../types';
import { principal } from '../../owner-context';
import { withNativeTransaction as withS5PortfolioTransaction } from './resources.js';
import { withDatabaseExecutionDeadline } from '../../../../db/execution-deadline';
import { Z1Fault, boundedJSON, digest, requireZ1 } from '../../../../epistemic-runtime/src/project-z/z1-shared-work/contracts.js';
import { UUID, RootSchema, RefSchema, BudgetSchema, SubmitSchema, developmentOnly, parsed, same } from './native-contracts.js';
import { reserveOriginalSharedWorkBudget } from './resources.js';
import { admitSharedWorkProgram } from './admission.js';
import { rowTx, eventTx, assertRowCurrentTx, readNativeWorkProjection, submitNativeSharedWork } from './native-store.js';

export const SharedWorkOperations = [
  'z1-reserve-original-budget', 'z1-submit-shared-work', 'z1-read-shared-work',
  'z1-admit-shared-work', 'z1-project-original-work', 'z1-cancel-shared-work',
] as const;
const original = z.object({ root: RootSchema, workId: UUID }).strict();
const read = z.object({ root: RootSchema, requestId: UUID,
  view: z.enum(['SUMMARY', 'ORIGINAL_REQUEST', 'PUBLICATION', 'TRACE']).default('SUMMARY'),
  afterEventId: z.string().regex(/^(?:0|[1-9]\d{0,18})$/).default('0') }).strict();
const admission = z.object({ root: RootSchema, publication: RefSchema }).strict();
const cancel = z.object({ root: RootSchema, requestId: UUID, expectedGeneration: z.number().int().positive() }).strict();
export const SharedWorkOperationSchemas = {
  'z1-reserve-original-budget': BudgetSchema, 'z1-submit-shared-work': SubmitSchema,
  'z1-read-shared-work': read, 'z1-admit-shared-work': admission,
  'z1-project-original-work': original, 'z1-cancel-shared-work': cancel,
} as const;

/** The shared HTTP delegate authenticates with requireContext before this bounded
 * reader. Submitted roles, tenants, rows and process identities confer no rights. */
export async function readSharedWorkBody(request: Request): Promise<unknown> {
  const maximum = 134217728, reader = request.body?.getReader();
  requireZ1(reader && request.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json',
    'Z1_TYPED_JSON_BODY_REQUIRED');
  const chunks: Uint8Array[] = []; let size = 0;
  const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 5000);
  const aborted = new Promise<never>((_resolve, reject) => stop.signal.addEventListener('abort',
    () => { void reader.cancel().catch(() => undefined); reject(new Z1Fault('INCOMPLETE', 'Z1_BODY_READ_DEADLINE')); }, { once: true }));
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), aborted]); if (chunk.done) break;
      size += chunk.value.byteLength;
      requireZ1(size <= maximum, 'Z1_NATIVE_REQUEST_BYTE_BOUND', 'INCOMPLETE'); chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    boundedJSON(value, maximum); return value;
  } finally {
    clearTimeout(timer); await reader.cancel().catch(() => undefined); reader.releaseLock();
  }
}
async function readRequest(ctx: PeMutationContext, value: unknown) {
  const input = parsed(read, value);
  return withS5PortfolioTransaction(ctx, async c => {
    const row = await rowTx(ctx, c, input.requestId);
    requireZ1(same(row.root, input.root), 'Z1_ORIGINAL_ROOT_REQUIRED', 'REVOKED');
    let current = true;
    try { await assertRowCurrentTx(ctx, c, row); } catch { current = false; }
    const summary = { requestId: row.id, generation: row.generation, status: row.status, current,
      requestDigest: row.request_digest, originalWorkIds: row.cuts.map(cut => cut.workId), runtime: row.runtime,
      originalDeadline: row.deadline_at.toISOString(), attemptsUsed: row.attempts_used,
      wallUsedMs: row.wall_used_ms, wallReservedMs: row.wall_reserved_ms,
      publication: current ? row.publication?.reference ?? null : null,
      protectedAdmission: false, businessCompletionGranted: false, executionAuthorityGranted: false };
    if (input.view === 'SUMMARY') return summary;
    if (input.view === 'ORIGINAL_REQUEST' || input.view === 'PUBLICATION') {
      requireZ1(current, 'Z1_CURRENT_ORIGINAL_PREIMAGES_REQUIRED', 'STALE');
      return input.view === 'ORIGINAL_REQUEST' ? { ...summary, request: row.request } :
        { ...summary, publication: row.publication ?? null };
    }
    const events = (await c.query<{ id: string; event_key: string; body: unknown }>(
      `SELECT id::text,event_key,body FROM finnor_os.z1_events
       WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND id>$4::bigint ORDER BY id LIMIT 65`,
      [ctx.auth.tenantId, principal(ctx), row.id, input.afterEventId])).rows;
    const parents = (await c.query<{ reservation_id: string; status: string; used: unknown; pending_cpu: string }>(
      `SELECT s.reservation_id,s.status,
         coalesce((SELECT jsonb_object_agg(t.resource_id,t.used) FROM
           (SELECT resource_id,sum(units)::text used FROM finnor_os.s5_governed_resource_charges g
            WHERE g.tenant_id=s.tenant_id AND g.reservation_id=s.reservation_id GROUP BY resource_id) t),'{}'::jsonb) used,
         coalesce((SELECT sum((co.body->>'maximumUnits')::bigint)::text FROM finnor_os.s5_consumptions co
          JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
          WHERE co.tenant_id=s.tenant_id AND co.reservation_id=s.reservation_id
          AND co.body->>'schema'='finnor.s5.z1-compute-hold.v1' AND st.status<>'RECONCILED'),'0') pending_cpu
       FROM finnor_os.s5_reservations s JOIN finnor_os.s5_reservation_origins o USING(tenant_id,reservation_id)
       WHERE s.tenant_id=$1 AND o.principal_id=$2 AND s.reservation_id=ANY($3::text[]) ORDER BY s.reservation_id`,
      [ctx.auth.tenantId, principal(ctx), row.cuts.map(cut => cut.parent.id)])).rows;
    const page = events.slice(0, 64);
    return { ...summary, events: page.map(event => ({ id: event.id, key: event.event_key, body: event.body,
      digest: digest(event.body) })), nextEventId: events.length > 64 ? page.at(-1)!.id : null, parents,
      unresolvedResponsibilityRetained: true, lifecycleFinancialCostComplete: false };
  });
}
async function cancelRequest(ctx: PeMutationContext, value: unknown) {
  const input = parsed(cancel, value);
  return withS5PortfolioTransaction(ctx, async c => {
    const row = await rowTx(ctx, c, input.requestId);
    requireZ1(same(row.root, input.root) && row.generation === input.expectedGeneration,
      'Z1_ORIGINAL_CANCELLATION_FENCED', 'STALE');
    if (row.status !== 'CANCELLED') {
      await c.query(`UPDATE finnor_os.z1_requests SET status='CANCELLED',generation=generation+1
        WHERE tenant_id=$1 AND principal_id=$2 AND id=$3`,
      [ctx.auth.tenantId, principal(ctx), row.id]);
      await eventTx(ctx, c, row.id, null, `cancel:${row.generation}`, { kind: 'ORIGINAL_REQUEST_CANCELLED',
        originalDeadline: row.deadline_at.toISOString(), originalWorkIds: row.cuts.map(cut => cut.workId),
        costsHoldsArtifactsAndS6ObligationsRetained: true, executionAuthorityGranted: false });
    }
    return { requestId: row.id, status: 'CANCELLED', generation: row.status === 'CANCELLED' ? row.generation : row.generation + 1,
      costsHoldsArtifactsAndS6ObligationsRetained: true, executionAuthorityGranted: false };
  });
}
export async function handleSharedWorkOperation(ctx: PeMutationContext, operation: string, value: unknown) {
  developmentOnly();
  requireZ1(SharedWorkOperations.some(item => item === operation), 'Z1_REGISTERED_OWNER_OPERATION_REQUIRED');
  const body = await withDatabaseExecutionDeadline(performance.now() + 30000, async () => {
    switch (operation) {
      case 'z1-reserve-original-budget': return reserveOriginalSharedWorkBudget(ctx, value);
      case 'z1-submit-shared-work': return submitNativeSharedWork(ctx, value);
      case 'z1-read-shared-work': return readRequest(ctx, value);
      case 'z1-admit-shared-work': {
        const input = parsed(admission, value); return admitSharedWorkProgram(ctx, input.publication, input.root);
      }
      case 'z1-project-original-work': {
        const input = parsed(original, value); return readNativeWorkProjection(ctx, input.root, input.workId);
      }
      case 'z1-cancel-shared-work': return cancelRequest(ctx, value);
      default: throw new Z1Fault('UNSUPPORTED', 'Z1_REGISTERED_OWNER_OPERATION_REQUIRED');
    }
  });
  return { status: 200, body };
}
export function sharedWorkResponseError(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'P0001' &&
    'message' in error && typeof error.message === 'string' && /^Z1 (?:S5|original storage|original identity|native)/.test(error.message))
    return { status: 422, body: { code: 'Z1_CANONICAL_ORIGINAL_BUDGET_OR_PREIMAGE_REFUSED', disposition: 'INCOMPLETE',
      error: 'The conserved original budget or current preimage is unavailable.',
      protectedAdmission: false, executionAuthorityGranted: false } };
  if (!(error instanceof Z1Fault) && !(error instanceof z.ZodError) && !(error instanceof SyntaxError)) return null;
  const code = error instanceof Z1Fault ? error.message : 'Z1_TYPED_REQUEST_REQUIRED';
  const disposition = error instanceof Z1Fault ? error.disposition : 'UNSUPPORTED';
  return { status: disposition === 'REVOKED' ? 403 : disposition === 'STALE' ? 409 : disposition === 'INCOMPLETE' ? 422 : 400,
    body: { code, disposition, error: 'The current original Work contract is unavailable or refused.',
      protectedAdmission: false, executionAuthorityGranted: false } };
}

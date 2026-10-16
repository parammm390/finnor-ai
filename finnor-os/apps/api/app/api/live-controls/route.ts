import { z } from 'zod';
import { ExactWorkIntakeConflict, receiveWork } from '@finnor/db';
import { evaluateAuthorityTx } from '@finnor/authority';
import { AuthVerificationError, endDeliverySession } from '@finnor/security';
import { attachWorkToDealGraph, PE_ENTITY_TYPES, type PeEntityRef } from '@finnor/private-equity';
import { operateLiveControl, type LiveControlPorts } from '../../../../../packages/private-equity/src/live-controls/service';
import { ControlObjectSchema, decodeControlBody, LIVE_CONTROL_OPERATION_SCHEMAS, LIVE_CONTROL_OPERATIONS, LiveControlError } from '../../../../../packages/private-equity/src/live-controls/contracts';
import { assertNativeControlActionTx } from '../../../../../packages/private-equity/src/live-controls/service';
import { assertActorActionTx, authorizeResourcesTx, canonicalObjectTx, controlTransaction } from '../../../../../packages/private-equity/src/live-controls/store';
import { AuthError, requireContext } from '../../../lib/auth';
import { getOrchestrator } from '../../../lib/orchestrator';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const beginSchema = LIVE_CONTROL_OPERATION_SCHEMAS.open.omit({ workId: true }).extend({ idempotencyKey: z.string().uuid(), focus: ControlObjectSchema }).strict();
const envelope = z.object({ operation: z.enum([...LIVE_CONTROL_OPERATIONS, 'begin', 'end-delivery']), input: z.unknown() }).strict();
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };
async function body(req: Request) {
  const reader = req.body?.getReader();
  if (!reader) throw new LiveControlError('CONTROL_BODY_REQUIRED', 'A typed control input is required', 400);
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new LiveControlError('INPUT_LIMIT', 'Control input exceeds 2 MiB', 413);
      }
      parts.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(parts).toString('utf8')); }
  catch { throw new LiveControlError('CONTROL_JSON_REQUIRED', 'A typed JSON control input is required', 400); }
}
export async function POST(req: Request): Promise<Response> {
  try {
    const auth = await requireContext(req);
    if (!auth.deliverySession) throw new AuthError('A verified provider delivery session is required', 401);
    const raw = await body(req); decodeControlBody(raw);
    const { operation, input } = envelope.parse(raw);
    if (operation === 'end-delivery') return Response.json(await endDeliverySession(auth), { headers });
    const ctx = { auth, provenance: { sourceSystem: 'api:live-institutional-control', createdBy: auth.employeeId ?? auth.userId } };
    if (operation === 'begin') {
      const start = beginSchema.parse(input);
      await controlTransaction(ctx, async client => {
        const refs = [{ type: start.root.entityType, id: start.root.entityId }, start.focus];
        await authorizeResourcesTx(ctx, refs, client);
        for (const ref of refs) await canonicalObjectTx(ctx, ref, client);
        const request = { operation: 'action' as const, capability: 'action:propose_control', resources: refs, risk: 'low' as const };
        await assertActorActionTx(ctx, request, client);
        if ((await evaluateAuthorityTx(auth, request, client)).outcome !== 'allowed') throw new LiveControlError('CONTROL_WORK_AUTHORITY_DENIED', 'Present authority cannot start a control Work', 403);
      }, { registerDelivery: true });
      const received = await receiveWork({ tenantId: auth.tenantId, userId: auth.employeeId ?? auth.userId, requireExactIntake: true,
        instruction: 'Direct institutional control review of the selected canonical object. No financial change is accepted by opening this Work.',
        channel: 'console', instructionId: start.idempotencyKey, idempotencyKey: start.idempotencyKey,
        activeContext: { selectedEntities: [start.root, { entityType: start.focus.type, entityId: start.focus.id }] },
        authorityContext: { employeeId: auth.employeeId, directControl: { root: start.root, focus: start.focus } } });
      if (PE_ENTITY_TYPES.includes(start.focus.type as PeEntityRef['entityType'])) {
        const selected = { entityType: start.focus.type as PeEntityRef['entityType'], entityId: start.focus.id };
        const dealId = await controlTransaction(ctx, async client => {
          await authorizeResourcesTx(ctx, [start.focus], client);
          return (await client.query<{ deal_id: string | null }>('SELECT finnor_os.pe_entity_deal($1,$2::uuid)::text deal_id',
            [selected.entityType, selected.entityId])).rows[0]?.deal_id;
        });
        if (dealId) await attachWorkToDealGraph(ctx, { dealId, workId: received.workId, entities: [selected] });
      }
      const opened = await operateLiveControl(ctx, 'open', { workId: received.workId, root: start.root, focus: start.focus });
      return Response.json(opened, { headers });
    }
    const ports: LiveControlPorts = {
      runKnownAction: async params => {
        if (params.principalId !== auth.employeeId) throw new AuthError('The canonical principal differs', 403);
        await controlTransaction(ctx, client => assertNativeControlActionTx(ctx, params.actionId, client), { financialFence: true });
        return getOrchestrator().draftKnownAction(params.actionType, params.payload, auth.tenantId, {
          actionId: params.actionId, workId: params.workId, initiatedBy: params.principalId,
          source: 'authenticated_direct_institutional_control', authorityContext: { liveControl: params.control },
        });
      },
    };
    const result = await operateLiveControl(ctx, operation, input, ports);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof ExactWorkIntakeConflict) return Response.json({ error: error.message, code: 'EXACT_WORK_INTAKE_CONFLICT' }, { status: 409, headers });
    if (error instanceof LiveControlError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers });
    if (error instanceof AuthError || error instanceof AuthVerificationError) return Response.json({ error: error.message }, { status: error.status, headers });
    if (error instanceof z.ZodError) return Response.json({ error: 'The typed control input does not match its installed contract',
      issues: error.issues.slice(0, 20).map(({ path, message }) => ({ path, message })) }, { status: 400, headers });
    const fault = error instanceof Error ? error : new Error('NON_ERROR_OWNER_FAILURE');
    const sqlFault = (fault.cause ?? fault) as { code?: unknown; table?: unknown; column?: unknown; constraint?: unknown };
    const identifier = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_]{1,160}$/.test(value) ? value : null;
    // Bounded server-only diagnostics never log request bytes, SQL parameters,
    // provider tokens or arbitrary owner error messages.
    console.error('[live-controls] original owner failure', {
      type: identifier(fault.name), predicate: identifier(fault.message), code: identifier(sqlFault.code),
      table: identifier(sqlFault.table), column: identifier(sqlFault.column), constraint: identifier(sqlFault.constraint),
      frames: fault.stack?.split('\n').filter(line => /^\s*at /.test(line)).slice(0, 8),
    });
    return Response.json({ error: 'The original control owner is unavailable. Reconcile the original identity, do not replay a mutation.' },
      { status: 500, headers });
  }
}

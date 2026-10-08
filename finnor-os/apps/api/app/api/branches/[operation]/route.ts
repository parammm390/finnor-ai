import { requireContext, AuthError, errorResponse } from '../../../../lib/auth';
import { branchError, decode, OperationSchemas } from '../../../../../../packages/private-equity/src/branch-fabric/contracts';
import { branchTransportDeadline, inBranchEpisode, readBranchBody } from '../../../../../../packages/private-equity/src/branch-fabric/budget';
import * as branches from '../../../../../../packages/private-equity/src/branch-fabric/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request, context: { params: Promise<{ operation: string }> }): Promise<Response> {
  try {
    return await inBranchEpisode(branchTransportDeadline(req), async () => {
    const ctx = await requireContext(req); // Authenticate before every identifier lookup.
    const { operation } = await context.params;
    if (!Object.hasOwn(OperationSchemas, operation)) return Response.json({ code: 'BRANCH_OPERATION_UNAVAILABLE' }, { status: 404 });
    if (!req.headers.get('content-type')?.startsWith('application/json')) return Response.json({ code: 'JSON_REQUIRED' }, { status: 415 });
    const value = await readBranchBody(req);
    const body: any = decode(OperationSchemas[operation as keyof typeof OperationSchemas] as any, value);
    let result: unknown;
    switch (operation) {
      case 'prepare': result = await branches.prepare(ctx, body); break;
      case 'submit': result = await branches.submit(ctx, body); break;
      case 'read': result = await branches.read(ctx, body.branchId); break;
      case 'list': result = await branches.list(ctx, body.workId, body.limit, body.after); break;
      case 'compare': result = await branches.compare(ctx, body.branchIds); break;
      case 'checkpoint': result = await branches.createCheckpoint(ctx, body.branchId); break;
      case 'checkpoint-revoke': result = await branches.revokeCheckpoint(ctx, body.branchId, body.checkpointId); break;
      case 'checkpoint-purge': result = await branches.purgeCheckpoints(ctx, body.branchId); break;
      case 'resume': result = await branches.resume(ctx, body.branchId, body.checkpointId, body.idempotencyKey); break;
      case 'cancel': result = await branches.cancel(ctx, body.branchId); break;
      case 'inspect': result = await branches.inspect(ctx, body.branchId); break;
      case 'continue': result = await branches.continuation(ctx, body.branchId); break;
    }
    return Response.json(result, { status: operation === 'submit' || operation === 'resume' ? 202 : 200, headers: { 'cache-control': 'no-store' } });
    }, req.signal);
  } catch (e) {
    if (e instanceof AuthError) return errorResponse(e);
    const mapped = branchError(e);
    return Response.json(mapped.body, { status: mapped.status, headers: { 'cache-control': 'no-store' } });
  } finally {
    if (req.body && !req.body.locked) void req.body.cancel().catch(() => undefined);
  }
}

import { z } from 'zod';
import { withDatabaseExecutionDeadline } from '@finnor/db';
import { elicitationOperation } from '@finnor/private-equity/src/r3/api';
import { PeDomainError } from '@finnor/private-equity';
import { requireContext, errorResponse } from '../../../../lib/auth';
export const runtime = 'nodejs';
async function bounded(req: Request, deadline: number) {
  const limit = 2 * 1024 * 1024;
  if (!req.body || Number(req.headers.get('content-length') ?? 0) > limit) throw Error('R3_REQUEST_BYTE_BOUND_OR_JSON_REQUIRED');
  const reader = req.body.getReader(), bytes = Buffer.alloc(limit); let size = 0;
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => undefined) }, Math.max(0, deadline - performance.now()));
  try {
    for (;;) {
      const chunk = await reader.read();
      if (expired || performance.now() >= deadline) throw Error('R3_INITIAL_RESPONSE_DEADLINE_EXHAUSTED');
      if (chunk.done) break;
      if (chunk.value.length > limit-size) { await reader.cancel(); throw Error('R3_REQUEST_BYTE_BOUND_OR_JSON_REQUIRED') }
      bytes.set(chunk.value,size);size+=chunk.value.length;
    }
    return JSON.parse(bytes.subarray(0,size).toString('utf8'));
  } finally { clearTimeout(timer); reader.releaseLock() }
}
function response(value: unknown, status = 200) {
  const body = JSON.stringify(value); if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw Error('R3_RESPONSE_BYTE_BOUND');
  return new Response(body, { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });
}
export async function POST(req: Request, { params }: { params: Promise<{ operation: string }> }): Promise<Response> {
  const deadline = performance.now() + 29000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      withDatabaseExecutionDeadline(deadline,async()=>{
        const [auth, route] = await Promise.all([requireContext(req), params]), input = await bounded(req, deadline);
        return response(await elicitationOperation({ auth }, route.operation, input));
      }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('R3_INITIAL_RESPONSE_DEADLINE_EXHAUSTED')), 29000) }),
    ]);
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return response({ code: 'R3_INVALID_REQUEST', error: 'Invalid bounded R3 request' }, 400);
    if (error instanceof PeDomainError) return response({ code: error.code, error: 'Permitted R3 context is unavailable' }, 404);
    if (error instanceof Error && /^R3_[A-Z0-9_:]+$/.test(error.message)) {
      const code = error.message, status = code.includes('DEADLINE_EXHAUSTED') ? 504 : code.includes('BYTE_BOUND') ? 413 : code.includes('NOT_FOUND') ? 404 :
        code.includes('UNAVAILABLE') || code.includes('UNSUPPORTED') ? 422 : code.includes('PRINCIPAL') ? 403 : 409;
      return response({ code, error: code, executionAuthorityGranted: false }, status);
    }
    return errorResponse(error);
  } finally { if (timer) clearTimeout(timer) }
}

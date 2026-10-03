import { z } from 'zod';
import { PE_WORLD_ROOT_TYPES, PeDomainError, fitEnterpriseInterventionModel, queryEnterpriseInterventionModel, validateEnterpriseInterventionModel,
  projectEnterpriseInterventionExperiment, designEnterpriseInterventionExperiment, recordEnterpriseInterventionAssessment } from '@finnor/private-equity';
import { ExperimentRefSchema, InterventionContractError, ExperimentContractError } from '@finnor/epistemic-runtime';
import { errorResponse, requireContext } from '../../../../lib/auth';

export const runtime = 'nodejs';
const fit = z.object({ request: z.unknown() }).strict();
const refit = fit.extend({ priorRef: z.unknown() });
const model = z.object({ modelRef: z.unknown() }).strict();
const query = model.extend({ query: z.unknown() });
const root = z.object({ entityType: z.enum(PE_WORLD_ROOT_TYPES), entityId: z.string().uuid() }).strict();
const experiment = model.extend({ root, request: z.unknown() });
const assessment = model.extend({ type: z.enum(['CORRECTION', 'HUMAN_OVERRIDE']), reason: z.string().min(1).max(2048), evidenceRefs: z.array(ExperimentRefSchema).max(32) });
function response(body: unknown, status = 200): Response {
  const bytes = JSON.stringify(body);
  if (Buffer.byteLength(bytes) > 8*1024*1024) throw new InterventionContractError('LIMIT_EXCEEDED', 'S3 response exceeds 8 MiB');
  return new Response(bytes, { status, headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' } });
}
async function boundedJson(req: Request): Promise<unknown> {
  const limit = 2*1024*1024;
  if (Number(req.headers.get('content-length') ?? 0) > limit) { await req.body?.cancel().catch(() => undefined); throw new InterventionContractError('LIMIT_EXCEEDED', 'S3 request exceeds 2 MiB'); }
  if (!req.body) throw new InterventionContractError('INVALID_REQUEST', 'S3 requires JSON');
  // POST authenticates before calling this reader. A fixed bounded buffer also
  // prevents arbitrarily many tiny chunks from creating unbounded object overhead.
  const reader = req.body.getReader(), bytes = Buffer.alloc(limit); let size = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break;
      if (chunk.value.byteLength > limit-size) { await reader.cancel().catch(() => undefined); throw new InterventionContractError('LIMIT_EXCEEDED', 'S3 request exceeds 2 MiB'); }
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    return JSON.parse(bytes.subarray(0, size).toString('utf8'));
  } catch (e) { if (e instanceof InterventionContractError) throw e; throw new InterventionContractError('INVALID_REQUEST', 'S3 requires JSON'); }
  finally { reader.releaseLock(); }
}
export async function POST(req: Request, { params }: { params: Promise<{ operation: string }> }): Promise<Response> {
  try {
    const [auth, route] = await Promise.all([requireContext(req), params]), ctx = { auth };
    const body = await boundedJson(req);
    switch (route.operation) {
      case 'fit': return response(await fitEnterpriseInterventionModel(ctx, fit.parse(body).request));
      case 'refit': { const input = refit.parse(body); return response(await fitEnterpriseInterventionModel(ctx, input.request, input.priorRef)); }
      case 'query': { const input = query.parse(body); return response(await queryEnterpriseInterventionModel(ctx, { modelRef: input.modelRef, query: input.query })); }
      case 'validate': return response(await validateEnterpriseInterventionModel(ctx, model.parse(body).modelRef));
      case 'experiment-projection': return response(await projectEnterpriseInterventionExperiment(ctx, model.parse(body).modelRef));
      case 'design-experiment': { const input = experiment.parse(body); return response(await designEnterpriseInterventionExperiment(ctx, { modelRef: input.modelRef, root: input.root, request: input.request })); }
      case 'assessment': { const input = assessment.parse(body); return response(await recordEnterpriseInterventionAssessment(ctx, { ...input, modelRef: input.modelRef })); }
      default: return response({ error: 'S3 operation was not found', code: 'NOT_FOUND' }, 404);
    }
  } catch (e) {
    if (e instanceof z.ZodError) return response({ error: 'Invalid S3 request', code: 'INVALID_REQUEST' }, 400);
    if (e instanceof InterventionContractError || e instanceof ExperimentContractError) return response({ error: e.message, code: e.code }, e.code === 'LIMIT_EXCEEDED' ? 413 : e.code === 'PERMITTED_CONTEXT_UNAVAILABLE' ? 404 : 400);
    if (e instanceof PeDomainError) return response({ error: e.message, code: e.code }, /NOT_FOUND/.test(e.code) ? 404 : /INVALID/.test(e.code) ? 400 : 422);
    return errorResponse(e);
  }
}

import { registerEnterpriseEconomicAssignmentProtocol, assignEnterpriseEconomicProgramme } from '../../../../../../packages/private-equity/src/enterprise-economic-assignments';
import { reconcileEnterpriseEconomicAggregate, readEnterpriseEconomicLearningAssessment } from '../../../../../../packages/private-equity/src/enterprise-economic-consumers';
import { z } from 'zod';
import type { EconomicAssignment, EconomicRef, EconomicAssessmentInput } from '../../../../../../packages/shared-types/src/economic-attribution';
import { registerEnterpriseOutcomeEstimand, readEnterpriseEconomicRecord, readEnterpriseEconomicHistory, appendEnterpriseEconomicRecord, assessEnterpriseEconomicAttribution, readEnterpriseEconomicExecutionEvidence, registerEnterpriseEconomicBenchmark, assessEnterpriseEconomicBenchmark } from '../../../../../../packages/private-equity/src/enterprise-economic-attribution';
import { EconomicContractError } from '../../../../../../packages/epistemic-runtime/src/economic-attribution';
import { LedgerFault } from '../../../../../../packages/governed-execution/src/protocol';
import { requireContext, errorResponse } from '../../../../lib/auth';
export const runtime = 'nodejs';
const text = z.string().min(1).max(4096), key = text.max(256), ref = z.object({ owner: text.max(128), id: text, version: text.max(256), contentDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const reply = (v: unknown, status = 200) => Response.json(v, { status, headers: { 'cache-control': 'private, no-store' } });
async function boundedJson(req: Request) { const limit = 8 * 1024 * 1024; if (Number(req.headers.get('content-length') ?? 0) > limit) {
    await req.body?.cancel();
    throw new LedgerFault(413, 'ECONOMIC_REQUEST_LIMIT');
} if (!req.body)
    throw new LedgerFault(400, 'ECONOMIC_JSON_REQUIRED'); const reader = req.body.getReader(), chunks: Uint8Array[] = []; let size = 0; try {
    for (;;) {
        const part = await reader.read();
        if (part.done)
            break;
        size += part.value.length;
        if (size > limit) {
            await reader.cancel();
            throw new LedgerFault(413, 'ECONOMIC_REQUEST_LIMIT');
        }
        chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
}
catch (e) {
    if (e instanceof LedgerFault)
        throw e;
    throw new LedgerFault(400, 'ECONOMIC_JSON_REQUIRED');
}
finally {
    reader.releaseLock();
} }
export async function POST(req: Request, { params }: {
    params: Promise<{
        operation: string;
    }>;
}) {
    try {
        const [auth, route, body] = await Promise.all([requireContext(req), params, boundedJson(req)]), ctx = { auth };
        switch (route.operation) {
            case 'register-assignment-protocol': {
                const v = z.object({ protocol: z.unknown(), rightsRef: text, idempotencyKey: key.optional() }).strict().parse(body);
                return reply(await registerEnterpriseEconomicAssignmentProtocol(ctx, { ...v, protocol: v.protocol }));
            }
            case 'assign-programme': return reply(await assignEnterpriseEconomicProgramme(ctx, z.object({ estimandId: text, protocolId: text, idempotencyKey: key }).strict().parse(body)));
            case 'reconcile-aggregate': return reply(await reconcileEnterpriseEconomicAggregate(ctx, z.object({ level: z.enum(['PROGRAMME', 'COMPANY', 'PORTFOLIO']), ownerBoundaryRef: ref, assessmentIds: z.array(text).min(1).max(128), jointAssessmentId: text.optional(), idempotencyKey: key }).strict().parse(body)));
            case 'learning-assessment': return reply(await readEnterpriseEconomicLearningAssessment(ctx, z.object({ assessmentId: text, protectedReadback: z.boolean().optional() }).strict().parse(body)));
            case 'register': {
                const v = z.object({ estimand: z.unknown(), rightsRef: text, idempotencyKey: key.optional(), mode: z.enum(['PROSPECTIVE', 'RETROSPECTIVE']).optional() }).strict().parse(body);
                return reply(await registerEnterpriseOutcomeEstimand(ctx, { ...v, estimand: v.estimand }));
            }
            case 'read': return reply(await readEnterpriseEconomicRecord(ctx, z.object({ id: text, protectedReadback: z.boolean().optional() }).strict().parse(body)));
            case 'history': return reply(await readEnterpriseEconomicHistory(ctx, z.object({ estimandId: text, knowledgeAt: z.string().datetime({ offset: true }).optional() }).strict().parse(body)));
            case 'append': {
                const v = z.object({ kind: z.enum(['SOURCE', 'ASSIGNMENT', 'EXPOSURE', 'MEASUREMENT', 'VALUATION', 'COST', 'CORRECTION', 'INVALIDATION']), estimandRefId: text, record: z.record(z.unknown()), sourceRefs: z.array(ref).max(256), validAt: z.string().datetime({ offset: true }), revisionOf: text.optional(), idempotencyKey: key }).strict().parse(body);
                return reply(await appendEnterpriseEconomicRecord(ctx, v));
            }
            case 'assess': {
                const v = z.object({ estimandId: text, lookAt: z.string().datetime({ offset: true }), assignments: z.array(z.unknown()).max(4096), accounting: z.array(z.unknown()).max(4096), idempotencyKey: key, priorAssessmentId: text.optional(), computeCost: z.unknown(), noticeResolutionRefs: z.array(ref).max(256).optional() }).strict().parse(body);
                return reply(await assessEnterpriseEconomicAttribution(ctx, { ...v, assignments: v.assignments as EconomicAssignment[], computeCost: v.computeCost as EconomicAssessmentInput['computeCost'] }));
            }
            case 'execution-evidence': return reply(await readEnterpriseEconomicExecutionEvidence(ctx, z.object({ estimandId: text, obligationId: text }).strict().parse(body)));
            case 'register-benchmark': {
                const v = z.object({ registration: z.unknown(), rightsRef: text, idempotencyKey: key.optional() }).strict().parse(body);
                return reply(await registerEnterpriseEconomicBenchmark(ctx, { ...v, registration: v.registration }));
            }
            case 'benchmark': {
                const v = z.object({ registrationId: text, assessments: z.array(z.object({ controllerId: text, recordId: text, matchedEnvelopeRef: ref, protocolRef: ref, independentEvaluatorRef: ref }).strict()).max(32), gates: z.array(z.unknown()).max(32), idempotencyKey: key }).strict().parse(body);
                return reply(await assessEnterpriseEconomicBenchmark(ctx, v));
            }
            default: return reply({ error: 'Economic operation not found', code: 'NOT_FOUND' }, 404);
        }
    }
    catch (e) {
        if (e instanceof z.ZodError)
            return reply({ error: 'Invalid economic contract', code: 'INVALID_REQUEST' }, 400);
        if (e instanceof EconomicContractError)
            return reply({ error: e.message, code: e.code }, /LIMIT|BUDGET/.test(e.code) ? 413 : /CONFLICT/.test(e.code) ? 409 : 400);
        if (e instanceof LedgerFault)
            return reply({ error: e.code, code: e.code }, e.status);
        return errorResponse(e);
    }
}

import { z } from 'zod';
import { beginWorkQueryExecution, finishWorkQueryExecution } from '@finnor/db';
import type { OperationalQueryOptions } from '@finnor/read-models';
import type { AcquisitionDecisionQueryRequest, AcquisitionDecisionQueryResult } from '@finnor/shared-types';
import { semanticHash } from '@finnor/underwriting';
import { peTransaction } from '../repository';
import { authorize } from '../evidence-execution/store';
import { listUnderwritingWorkspace } from '../underwriting-repository';
import type { PeMutationContext } from '../types';
import { readAcquisitionDecision } from './decision';
const schema = z.object({ intent: z.literal('acquisition_decision_v1'), workId: z.string().uuid(), dealId: z.string().uuid(), decisionId: z.string().uuid().optional(), investmentCaseId: z.string().uuid().optional() }).strict();
export async function executeAcquisitionDecisionQuery(tenantId: string, body: AcquisitionDecisionQueryRequest, options: OperationalQueryOptions = {}): Promise<AcquisitionDecisionQueryResult> {
    const request = schema.parse(body), principal = options.employeeId ?? options.userId;
    if (!principal || options.workId !== request.workId || !options.workInputId)
        throw Error('ACQUISITION_AUTHENTICATED_WORK_INPUT_REQUIRED');
    const ctx: PeMutationContext = { auth: { tenantId, userId: principal, employeeId: principal, role: 'owner' } };
    await authorize(ctx, { entityType: 'pe_deal', entityId: request.dealId }, [{ type: 'work', id: request.workId }]);
    const assertCurrent = () => peTransaction(ctx, async (_db, c) => {
        const user = (await c.query('SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2', [tenantId, principal])).rows[0];
        if (user?.status !== 'active' || user.role !== 'owner')
            throw Error('ACQUISITION_CURRENT_OWNER_REQUIRED');
        const input = (await c.query('SELECT id::text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', [tenantId, request.workId])).rows[0];
        if (input?.id !== options.workInputId)
            throw Error('ACQUISITION_WORK_REVISION_CHANGED');
    }, { readOnly: true });
    await assertCurrent();
    let data: Record<string, unknown>;
    if (request.decisionId) {
        const read = await readAcquisitionDecision(ctx, request.decisionId);
        if (read.workId !== request.workId || read.request.dealId !== request.dealId)
            throw Error('ACQUISITION_DECISION_SCOPE_MISMATCH');
        data = { ...read };
    }
    else {
        const cases = await peTransaction(ctx, async (_db, c) => (await c.query('SELECT id::text,title,state FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND deal_id=$2 ORDER BY created_at DESC,id LIMIT 51', [tenantId, request.dealId])).rows, { readOnly: true });
        const selected = request.investmentCaseId ?? (cases.length === 1 ? String(cases[0]!.id) : null);
        if (selected && !cases.some(c => c.id === selected))
            throw Error('ACQUISITION_INVESTMENT_CASE_SCOPE_MISMATCH');
        data = { status: 'WORKSPACE', dealId: request.dealId, investmentCases: cases.slice(0, 50), investmentCasesTruncated: cases.length > 50, financialWorkspace: selected ? await listUnderwritingWorkspace(ctx, selected) : null, requiredMandateFields: ['bidDomain', 'financingCases', 'constraints'], economicTargetsMayNotBeInvented: true };
    }
    await assertCurrent();
    const started = performance.now(), execution = await beginWorkQueryExecution({ tenantId, workId: request.workId, workInputId: options.workInputId, intent: request.intent, request: { ...request }, executionKey: options.executionKey ?? 'acquisition:' + semanticHash({ request, input: options.workInputId, data }) });
    const asOf = new Date().toISOString(), source = { kind: 'canonical_postgres' as const, tables: ['acquisition_decisions', 'underwriting_runs', 'underwriting_model_versions', 'work_inputs'] };
    const result: AcquisitionDecisionQueryResult = { kind: 'operational_query_result', status: data.status === 'TESTED' || data.status === 'WORKSPACE' ? 'ok' : 'partial', data, version: 1, intent: request.intent, source, asOf, count: 1, truncated: false, page: { limit: 1, returned: 1, totalCount: 1, totalCountExact: true, hasMore: false, nextCursor: null, truncated: false }, meta: { version: 1, source, asOf }, execution: { id: execution.id, workId: execution.workId, workInputId: execution.workInputId, executionKey: execution.executionKey, status: 'succeeded' } };
    await finishWorkQueryExecution({ tenantId, executionId: execution.id, status: 'succeeded', rowCount: 1, durationMs: performance.now() - started, resultSummary: { decisionId: request.decisionId ?? null, status: data.status, financialExecutionAuthority: false } });
    return result;
}

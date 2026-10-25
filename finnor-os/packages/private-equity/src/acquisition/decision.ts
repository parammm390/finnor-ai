import { randomUUID } from 'node:crypto';
import type {AcquisitionDecisionRead} from '@finnor/shared-types';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { decimal, d, semanticHash, applyScenario, assertSnapshotMatchesModel, UnderwritingError,type UnderwritingInputSnapshot } from '@finnor/underwriting';
import { acquireComputeResourceLeases, renewComputeResourceLeases, releaseComputeResourceLeases } from '@finnor/db/compute-governor';
import {ingestIntegrationEventTx,type Db} from '@finnor/db';
import type { JobExecutionContext } from '../../../../apps/worker/src/queue';
import {PeDomainError,type PeMutationContext} from '../types';
import { peTransaction } from '../repository';
import { authorize } from '../evidence-execution/store';
import { assertEvidenceSnapshotCurrent } from '../evidence-execution/consumer';
import { createUnderwritingRun, createUnderwritingScenario, getUnderwritingRun, prepareUnderwritingRun,createHarnessUnderwritingRun,assertUnderwritingRunsCurrent } from '../underwriting-repository';
import {submitAcquisitionHarnessProgram} from '../program-synthesis/api';
import {readCurrentProgram} from '../program-synthesis/store';
import {validateAcceptance} from '../program-synthesis/compiler';
import {p1ExecutionConfiguration} from '../program-synthesis/isolated-custody';
import {resolveNativeComputeGrant} from '../compute-search/owners';
import {handleComputeSearchOperation} from '../compute-search/api';
import {acquisitionAnalysisRequest,selectedAcquisitionParent} from './continuation';
import { AcquisitionRequestSchema, type AcquisitionRequest, type AcquisitionResult, type AcquisitionCandidate } from './contracts';
import {AcquisitionIntakeContextSchema,AcquisitionIntakeReviewSchema,acquisitionIntakeContext,reviewAcquisitionIntake} from './intake';
import {AcquisitionClosingContextSchema,readAcquisitionClosingContext} from './closing-context';
class AcquisitionError extends Error {
    constructor(readonly code: string, readonly status = 409) { super(code); }
}
function fail(code: string, status = 409): never { throw new AcquisitionError(code, status); }
const actor = (ctx: PeMutationContext) => ctx.auth.employeeId ?? ctx.auth.userId ?? fail('ACQUISITION_CURRENT_ACTOR_REQUIRED', 403);
const transaction = <T>(ctx: PeMutationContext, fn: (c: PoolClient,db:Db) => Promise<T>, readOnly = false) => peTransaction(ctx, (db, c) => fn(c,db), { readOnly });
const BaseSchema = z.object({ id: z.string().uuid(), investmentCaseId: z.string().uuid(), modelVersionId: z.string().uuid(), worldAt: z.coerce.date(), inputHash: z.string(), resultHash: z.string(), scenarioId: z.string().nullable(),status:z.string(),validity:z.string() }).passthrough();
const sourceProvenanceFailure=(e:unknown)=>e instanceof Error&&['DERIVATION_CONSUMER_PROVENANCE_OR_CURRENTNESS_FAILED','PRIMARY_CONSUMER_PROVENANCE_OR_CURRENTNESS_FAILED','HARNESS_CONSUMER_PROVENANCE_OR_CURRENTNESS_FAILED'].includes(e.message);
function candidateScenario(request:AcquisitionRequest,bid:string,financing:AcquisitionRequest['financingCases'][number]){
    return {schemaVersion:'underwriting-scenario.v1' as const,name:'Acquisition '+financing.key+' bid '+bid,
        overrides:[{nodeId:request.bidDomain.nodeId,value:decimal(bid),reason:'Declared finite bid candidate'},...financing.overrides.map(o=>({...o,value:decimal(o.value)}))]};
}
async function currentRun(ctx:PeMutationContext,id:string){
    try{return await getUnderwritingRun(ctx,id);}
    catch(error){if(error instanceof PeDomainError&&error.code==='STALE_EVIDENCE_DERIVATION')fail('ACQUISITION_SOURCE_CUT_CHANGED');throw error;}
}
interface DecisionRow {
    id: string;
    principal_id: string;
    work_id: string;
    work_input_id: string;
    work_input_digest: string;
    request_digest: string;
    request: AcquisitionRequest;
    base_input_hash: string;
    base_result_hash: string;
    status: AcquisitionDecisionRead['status'];
    result: AcquisitionResult | null;
    result_digest: string | null;
    deadline_at: Date | string;
    deadline_expired: boolean;
    failure: string | null;
    active_claim_token: string | null;
    active_claim_fence: string | number | null;
    parent_action_id:string|null;
    parent_plan_revision_id:string|null;
    analysis_program_id:string|null;
    analysis_base_run_id:string|null;
    analysis_result_digest:string|null;
}
// Work is already a canonical event resource. The exact child correlation is
// not a new canonical entity registration or another orchestration lifecycle.
const completionEvent=(id:string,workId:string)=>({eventType:'analysis.acquisition.terminal' as const,resource:{type:'work' as const,id:workId},correlationId:'acquisition:'+id});
/** Same transaction as the terminal result. A lost worker acknowledgement can
 * neither lose the wake nor create another logical event on redelivery. */
async function publishTerminalEvent(db:Db,ctx:PeMutationContext,r:DecisionRow,status:string,resultDigest:string|null){
    await ingestIntegrationEventTx(db,{tenantId:ctx.auth.tenantId,source:'acquisition_worker',sourceEventId:'acquisition:'+r.id+':terminal',...completionEvent(r.id,r.work_id),workId:r.work_id,
        payload:{status,workInputId:r.work_input_id,resultDigest},evidenceRefs:[{type:'acquisition_decision',id:r.id}],trustClass:'trusted_runtime'});
}
async function currentWork(ctx: PeMutationContext, workId: string, c: PoolClient) {
    const work = (await c.query<{
        id: string;
        body: unknown;
    }>('SELECT id::text,to_jsonb(i) body FROM finnor_os.work_inputs i WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1', [ctx.auth.tenantId, workId])).rows[0];
    if (!work)
        fail('ACQUISITION_WORK_UNAVAILABLE', 404);
    return { id: work.id, digest: semanticHash(work.body) };
}
async function row(ctx: PeMutationContext, id: string, c?: PoolClient, lock = false): Promise<DecisionRow> {
    const load = async (q: PoolClient) => { const found = (await q.query<DecisionRow>('SELECT *,clock_timestamp()>=deadline_at AS deadline_expired FROM finnor_os.acquisition_decisions WHERE tenant_id=$1 AND principal_id=$2 AND id=$3' + (lock ? ' FOR UPDATE' : ''), [ctx.auth.tenantId, actor(ctx), id])).rows[0]; if (!found)
        fail('ACQUISITION_UNAVAILABLE', 404); if (semanticHash(found.request) !== found.request_digest)
        fail('ACQUISITION_REQUEST_DIGEST_MISMATCH'); return found; };
    return c ? load(c) : transaction(ctx, load, true);
}
async function assertCurrent(ctx: PeMutationContext, r: DecisionRow, c?: PoolClient) {
    await authorize(ctx, { entityType: 'pe_deal', entityId: r.request.dealId }, [{ type: 'work', id: r.work_id }], [], c);
    const read = async (q: PoolClient) => {
        const user = (await q.query('SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2', [ctx.auth.tenantId, actor(ctx)])).rows[0];
        if (user?.status !== 'active' || user.role !== 'owner')
            fail('ACQUISITION_CURRENT_OWNER_REQUIRED', 403);
        return currentWork(ctx, r.work_id, q);
    };
    const work = c ? await read(c) : await transaction(ctx, read, true);
    if (work.id !== r.work_input_id || work.digest !== r.work_input_digest)
        fail('ACQUISITION_WORK_REVISION_CHANGED');
    const base = BaseSchema.parse(await currentRun(ctx, r.request.baseRunId));
    if (base.inputHash !== r.base_input_hash || base.resultHash !== r.base_result_hash)
        fail('ACQUISITION_SOURCE_CUT_CHANGED');
    return r.analysis_base_run_id?BaseSchema.parse(await currentRun(ctx,r.analysis_base_run_id)):base;
}
export async function validateAcquisitionDecisionInput(ctx: PeMutationContext, body: unknown) {
    const request = AcquisitionRequestSchema.parse(body);
    await authorize(ctx, { entityType: 'pe_deal', entityId: request.dealId }, [{ type: 'work', id: request.workId }]);
    const base = BaseSchema.parse(await currentRun(ctx, request.baseRunId));
    if (base.scenarioId !== null || base.status!=='SUCCEEDED' || base.validity!=='VALID')
        fail('ACQUISITION_CANONICAL_BASE_RUN_REQUIRED');
    const prepared = await prepareUnderwritingRun(ctx, { investmentCaseId: base.investmentCaseId, modelVersionId: base.modelVersionId, baseRunId: base.id, worldAt: base.worldAt.toISOString() });
    if(request.analysis){
        validateAcceptance(acquisitionAnalysisRequest(request));
        if(request.analysis.computeSearch){
            try{await resolveNativeComputeGrant(ctx,request.analysis.ownerBindings!.policyRef!,request.analysis.ownerBindings!.allocationRef!,false,{entityType:'pe_deal',entityId:request.dealId});}
            catch(error){if(error instanceof PeDomainError)throw error;const message=error instanceof Error?error.message:'';fail(/^(?:P2|S4|S5)_[A-Z0-9_]{1,140}$/.test(message)?message:'ACQUISITION_COMPUTE_GRANT_UNAVAILABLE',422);}
        }
        for(const [nodeId,output] of Object.entries(request.analysis.bindings)){
            const n=prepared.compiled.nodeById[nodeId],value=prepared.baseSnapshot.values[nodeId],target=request.analysis.acceptance.targets.find(t=>t.key===output);
            if(n?.kind!=='input'||n.shape!=='scalar'||n.valueType!=='decimal'||!n.evidenceSemantics||!value||!['MODEL_PARAMETER','CANONICAL_ASSUMPTION'].includes(value.truthClass)||n.source&&!['explicit','model_parameter'].includes(n.source.kind)||!target||n.unit!==(target.unit==='currency'?'money':target.unit)||n.currency!==(target.currencyCode??undefined)||n.allowedTruthClasses&&!n.allowedTruthClasses.includes('DERIVED_VALUE'))fail('ACQUISITION_ANALYSIS_BINDING_REJECTED');
        }
        if(request.analysis.bindings[request.bidDomain.nodeId]||request.financingCases.some(f=>f.overrides.some(o=>request.analysis!.bindings[o.nodeId])))fail('ACQUISITION_ANALYSIS_CANNOT_REPLACE_FINANCING_DOMAIN');
    }
    const price = prepared.compiled.nodeById[request.bidDomain.nodeId];
    if (price?.kind !== 'input' || price.valueType !== 'decimal' || price.shape !== 'scalar' || price.unit !== 'money' || price.currency !== request.bidDomain.currency)
        fail('ACQUISITION_BID_SEMANTICS_MISMATCH');
    const canonicalBids = request.bidDomain.values.map(decimal);
    if (canonicalBids.some(v => d(v).isNegative()) || new Set(canonicalBids).size !== canonicalBids.length)
        fail('ACQUISITION_DISTINCT_NONNEGATIVE_BIDS_REQUIRED');
    for (const f of request.financingCases)
        for (const o of f.overrides) {
            const n = prepared.compiled.nodeById[o.nodeId];
            if (n?.kind !== 'input' || n.valueType !== 'decimal' || n.shape !== 'scalar')
                fail('ACQUISITION_FINANCING_INPUT_UNAVAILABLE');
        }
    for (const constraint of request.constraints) {
        const n = prepared.compiled.nodeById[constraint.outputNodeId];
        if (n?.kind !== 'output' || n.valueType !== 'decimal' || n.shape !== 'scalar' || n.unit !== constraint.unit || n.currency !== constraint.currency)
            fail('ACQUISITION_CONSTRAINT_SEMANTICS_MISMATCH');
    }
    // Validate the finite domain with the same model and source owners used
    // by persistence. No scenario can relabel verified source values or evade
    // ModelVersion truth/range policy after an apparently successful enqueue.
    try{
        for(const bid of request.bidDomain.values)for(const financing of request.financingCases){
            const applied=applyScenario(prepared.compiled,prepared.baseSnapshot,candidateScenario(request,bid,financing));
            assertSnapshotMatchesModel(prepared.compiled,applied.snapshot);
            await assertEvidenceSnapshotCurrent(ctx,applied.snapshot);
        }
    }catch(error){
        if(error instanceof UnderwritingError||sourceProvenanceFailure(error))fail('ACQUISITION_SCENARIO_POLICY_REJECTED');
        throw error;
    }
    const source = await transaction(ctx, async (c) => { const user = (await c.query('SELECT role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2', [ctx.auth.tenantId, actor(ctx)])).rows[0]; if (user?.status !== 'active' || user.role !== 'owner')
        fail('ACQUISITION_CURRENT_OWNER_REQUIRED', 403); return (await c.query('SELECT deal_id::text FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND id=$2', [ctx.auth.tenantId, base.investmentCaseId])).rows[0]; }, true);
    if (source?.deal_id !== request.dealId)
        fail('ACQUISITION_DEAL_MODEL_SCOPE_MISMATCH');
    return { request, base };
}
export async function submitAcquisitionDecision(ctx: PeMutationContext, body: unknown,selectedActionId?:string) {
    const { request, base } = await validateAcquisitionDecisionInput(ctx, body);
    return transaction(ctx, async (c) => {
        await(await import('./reviewed-request')).assertReviewedAcquisitionAction(ctx,'start_acquisition_evaluation',request,request.workId,c);
        const selected=selectedActionId?(await c.query<{plan_revision_id:string|null}>(
            "SELECT plan_revision_id FROM finnor_os.domain_actions WHERE tenant_id=$1 AND initiated_by=$2 AND work_id=$3 AND id=$4 AND action_type='start_acquisition_evaluation'",
            [ctx.auth.tenantId,actor(ctx),request.workId,selectedActionId],
        )).rows[0]:null;
        if(selectedActionId&&!selected)fail('ACQUISITION_SELECTED_ACTION_UNAVAILABLE',403);
        const parent=selected?.plan_revision_id?await selectedAcquisitionParent(ctx,request,selectedActionId!,c):null;
        if(request.analysis&&!parent)fail('ACQUISITION_ANALYSIS_SELECTED_ACTION_REQUIRED');
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,4410))', [ctx.auth.tenantId + ':' + actor(ctx) + ':' + request.idempotencyKey]);
        const investment = (await c.query('SELECT deal_id::text FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND id=$2 FOR SHARE', [ctx.auth.tenantId, base.investmentCaseId])).rows[0];
        if (investment?.deal_id !== request.dealId)
            fail('ACQUISITION_DEAL_MODEL_SCOPE_MISMATCH');
        const work = await currentWork(ctx, request.workId, c), digest = semanticHash(request);
        const previous = (await c.query<DecisionRow>('SELECT * FROM finnor_os.acquisition_decisions WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3', [ctx.auth.tenantId, actor(ctx), request.idempotencyKey])).rows[0];
        if (previous) {
            if (previous.request_digest !== digest || previous.work_input_id !== work.id)
                fail('ACQUISITION_IDEMPOTENCY_CONFLICT');
            return { decisionId: previous.id, workId: previous.work_id, status: previous.status, replayed: true };
        }
        if(request.analysis){const executor=p1ExecutionConfiguration();if(!executor.configurationReady)fail(executor.reason!,422);}
        const id = randomUUID(), deadline = new Date(Math.min(Date.now() + request.limits.deadlineMs,parent?.constraint_set.deadlineAt?Date.parse(parent.constraint_set.deadlineAt):Infinity));
        await c.query('INSERT INTO finnor_os.acquisition_decisions(id,tenant_id,principal_id,work_id,work_input_id,work_input_digest,request_digest,idempotency_key,request,base_input_hash,base_result_hash,deadline_at,parent_action_id,parent_plan_revision_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)', [id, ctx.auth.tenantId, actor(ctx), request.workId, work.id, work.digest, digest, request.idempotencyKey, JSON.stringify(request), base.inputHash, base.resultHash, deadline,parent?.id??null,parent?.plan_id??null]);
        if(parent&&request.analysis){
            const child=await submitAcquisitionHarnessProgram(ctx,acquisitionAnalysisRequest(request,work.id),{owner:'acquisition',decisionId:id,planRevisionId:parent.plan_id},c);
            await c.query('UPDATE finnor_os.acquisition_decisions SET analysis_program_id=$4 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[ctx.auth.tenantId,actor(ctx),id,child.programId]);
        }
        await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety) VALUES($1,'evaluate_acquisition_v1',$2::jsonb,$3,'batch',1,'locally_idempotent')", [ctx.auth.tenantId, JSON.stringify({ tenantId: ctx.auth.tenantId, principalId: actor(ctx), decisionId: id }), 'acquisition:' + id]);
        if(request.analysis)await c.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety,run_at) VALUES($1,'evaluate_acquisition_v1',$2::jsonb,$3,'batch',1,'locally_idempotent',$4)",[ctx.auth.tenantId,JSON.stringify({tenantId:ctx.auth.tenantId,principalId:actor(ctx),decisionId:id}),'acquisition:'+id+':original-deadline',deadline]);
        return { decisionId: id, workId: request.workId, status: 'QUEUED', replayed: false };
    });
}
export async function readAcquisitionDecision(ctx: PeMutationContext, id: string):Promise<AcquisitionDecisionRead> {
    z.string().uuid().parse(id);
    const r = await row(ctx, id);
    const base = await assertCurrent(ctx, r);
    if (r.result && semanticHash(r.result) !== r.result_digest)
        fail('ACQUISITION_RESULT_DIGEST_MISMATCH');
    if(r.result?.maximumBid.qualification==='NO_FEASIBLE_CANDIDATE'){
        const effective=BaseSchema.parse(await currentRun(ctx,r.result.baseRunId));
        if(effective.workId!==r.work_id||effective.scenarioId!==null||effective.status!=='SUCCEEDED'||effective.validity!=='VALID'
          ||effective.inputHash!==base.inputHash||effective.resultHash!==base.resultHash
          ||effective.modelVersionId!==base.modelVersionId||effective.investmentCaseId!==base.investmentCaseId)
            fail('ACQUISITION_BASELINE_BINDING_MISMATCH');
    }
    if (r.result?.candidates.length)try{
        await assertUnderwritingRunsCurrent(ctx,r.result.candidates.map(candidate=>({runId:candidate.runId,resultHash:candidate.resultHash,workId:r.work_id})));
    }catch(error){
        if(error instanceof PeDomainError&&error.code==='STALE_EVIDENCE_DERIVATION')fail('ACQUISITION_SOURCE_CUT_CHANGED');
        if(error instanceof PeDomainError&&error.code==='UNDERWRITING_RUN_BINDING_MISMATCH')fail('ACQUISITION_CANDIDATE_BINDING_MISMATCH');
        throw error;
    }
    await assertCurrent(ctx, r);
    return { decisionId: r.id, workId: r.work_id, workInputId: r.work_input_id, status: r.status, request: r.request, result: r.result, reason: r.failure, deadlineAt: new Date(r.deadline_at).toISOString(),completionEvent:completionEvent(r.id,r.work_id),...(r.request.analysis?{analysis:{programId:r.analysis_program_id,baseRunId:r.analysis_base_run_id,resultDigest:r.analysis_result_digest,parentPlanRevisionId:r.parent_plan_revision_id}}:{}) };
}
export async function readWorkAcquisitionDecision(ctx:PeMutationContext,scope:{workId:string;dealId:string}){
    await authorize(ctx,{entityType:'pe_deal',entityId:scope.dealId},[{type:'work',id:scope.workId}]);
    const ids=await transaction(ctx,async c=>(await c.query<{id:string}>(`SELECT id::text FROM finnor_os.acquisition_decisions
     WHERE tenant_id=$1 AND principal_id=$2 AND work_id=$3 AND work_input_id=(
      SELECT id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1)
     ORDER BY created_at,id LIMIT 2`,[ctx.auth.tenantId,actor(ctx),scope.workId])).rows,true);
    if(ids.length>1)throw new PeDomainError('ACQUISITION_EXACT_DECISION_REQUIRED','Multiple acquisitions require an exact decision reference');
    if(!ids.length)return null;
    const decision=await readAcquisitionDecision(ctx,ids[0]!.id);
    if(decision.request.dealId!==scope.dealId)throw new PeDomainError('ACQUISITION_IC_SCOPE_MISMATCH','The acquisition belongs to a different Deal');
    return decision;
}
export async function runAcquisitionDecisionJob(payload: Record<string, unknown>, execution?: Readonly<JobExecutionContext>) {
    if (!execution || execution.protocolVersion !== 1 || execution.tenantId !== payload.tenantId || typeof payload.tenantId !== 'string' || typeof payload.principalId !== 'string' || typeof payload.decisionId !== 'string')
        fail('ACQUISITION_DURABLE_CLAIM_REQUIRED', 403);
    const ctx: PeMutationContext = { auth: { tenantId: payload.tenantId, userId: payload.principalId, employeeId: payload.principalId, role: 'owner' }, provenance: { sourceSystem: 'acquisition:worker', createdBy: payload.principalId } };
    const claimed = await transaction(ctx, async (c) => {
        const current=await row(ctx,String(payload.decisionId),c,true);
        if(['TESTED','PARTIAL','FAILED','INVALIDATED'].includes(current.status))return null;
        if (!await validClaim(c, ctx, execution))
            fail('ACQUISITION_JOB_FENCED');
        await c.query("UPDATE finnor_os.acquisition_decisions SET status='RUNNING',active_job_id=$4,active_claim_token=$5,active_claim_fence=$6,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3", [ctx.auth.tenantId, actor(ctx), current.id, execution.jobId, execution.claimToken, execution.claimFence]);
        return current;
    });
    if(!claimed)return;
    let r=claimed;
    let leases: Awaited<ReturnType<typeof acquireComputeResourceLeases>> | null = null;
    try {
        let base = await assertCurrent(ctx, r);
        if (r.deadline_expired || Date.now() >= new Date(r.deadline_at).getTime())
            fail('ACQUISITION_ORIGINAL_DEADLINE_EXHAUSTED');
        if(r.request.analysis&&!r.analysis_base_run_id){
            if(!r.parent_plan_revision_id)fail('ACQUISITION_ANALYSIS_PARENT_CHANGED');
            const binding={owner:'acquisition' as const,decisionId:r.id,planRevisionId:r.parent_plan_revision_id};
            const submitted=await submitAcquisitionHarnessProgram(ctx,acquisitionAnalysisRequest(r.request,r.work_input_id),binding);
            if(r.request.analysis.computeSearch){
                const original=r.request.analysis.ownerBindings!;
                const search=await handleComputeSearchOperation(ctx,'compute-search-submit',{schema:'finnor.compute-search-request.v1',programId:submitted.programId,policyRequest:original.policyRef,computeGrant:original.allocationRef,idempotencyKey:'acquisition:'+r.id+':original-search',mode:'production_analysis',strategy:'ADAPTIVE',limits:{maxUnits:8,maxParallel:2}});
                if(search.status!==202)fail('ACQUISITION_REQUIRED_SEARCH_UNAVAILABLE');
            }
            await transaction(ctx,async c=>{
                if(!await validClaim(c,ctx,execution))fail('ACQUISITION_JOB_FENCED');
                const saved=await c.query('UPDATE finnor_os.acquisition_decisions SET analysis_program_id=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND active_claim_token=$5 AND active_claim_fence=$6',[ctx.auth.tenantId,actor(ctx),r.id,submitted.programId,execution.claimToken,execution.claimFence]);
                if(saved.rowCount!==1)fail('ACQUISITION_JOB_FENCED');
            });
            const checked=await readCurrentProgram(ctx,submitted.programId);
            if(['FAILED','INVALIDATED','CANCELLED','PARTIAL'].includes(checked.status))fail(checked.status==='INVALIDATED'?'ACQUISITION_SOURCE_CUT_CHANGED':'ACQUISITION_REQUIRED_ANALYSIS_FAILED');
            if(checked.status!=='TESTED'){
                await transaction(ctx,async c=>{if(!await validClaim(c,ctx,execution))fail('ACQUISITION_JOB_FENCED');await c.query("UPDATE finnor_os.acquisition_decisions SET status='WAITING_ANALYSIS',updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND active_claim_token=$4 AND active_claim_fence=$5",[ctx.auth.tenantId,actor(ctx),r.id,execution.claimToken,execution.claimFence]);});
                return;
            }
            const derived=await createHarnessUnderwritingRun(ctx,{baseRunId:r.request.baseRunId,workId:r.work_id,workInputId:r.work_input_id,programId:submitted.programId,bindings:r.request.analysis.bindings,idempotencyKey:'acquisition:'+r.id+':checked-analysis-base'});
            await transaction(ctx,async c=>{if(!await validClaim(c,ctx,execution))fail('ACQUISITION_JOB_FENCED');const saved=await c.query('UPDATE finnor_os.acquisition_decisions SET analysis_base_run_id=$4,analysis_result_digest=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND active_claim_token=$6 AND active_claim_fence=$7',[ctx.auth.tenantId,actor(ctx),r.id,derived.id,derived.analysisResultDigest,execution.claimToken,execution.claimFence]);if(saved.rowCount!==1)fail('ACQUISITION_JOB_FENCED');});
            r=await row(ctx,r.id);base=await assertCurrent(ctx,r);
        }
        const admitted = await acquireComputeResourceLeases({ tenantId: ctx.auth.tenantId, resourceKeys: ['native:acquisition'], requiredResourceKeys: ['native:acquisition'], workloadClass: 'HEAVY', ownerId: 'acquisition:' + r.id + ':' + execution.claimFence });
        leases = admitted;
        execution.registerHeartbeat(async () => renewComputeResourceLeases(admitted));
        const candidates: AcquisitionCandidate[] = [];
        for (const bid of r.request.bidDomain.values)
            for (const financing of r.request.financingCases) {
                if (Date.now() >= new Date(r.deadline_at).getTime())
                    fail('ACQUISITION_ORIGINAL_DEADLINE_EXHAUSTED');
                r = await row(ctx, r.id);
                if (r.deadline_expired)
                    fail('ACQUISITION_ORIGINAL_DEADLINE_EXHAUSTED');
                await assertCurrent(ctx, r);
                await transaction(ctx, async (c) => { if (!await validClaim(c, ctx, execution) || r.active_claim_token !== execution.claimToken || Number(r.active_claim_fence) !== execution.claimFence)
                    fail('ACQUISITION_JOB_FENCED'); });
                if (!await renewComputeResourceLeases(leases))
                    fail('ACQUISITION_CAPACITY_FENCED');
                const scenario = await createUnderwritingScenario(ctx, { investmentCaseId: base.investmentCaseId, modelVersionId: base.modelVersionId, scenario: candidateScenario(r.request,bid,financing) });
                const computed = await createUnderwritingRun(ctx, { investmentCaseId: base.investmentCaseId, modelVersionId: base.modelVersionId, baseRunId: base.id, scenarioId: String(scenario.id), worldAt: base.worldAt.toISOString(), workId: r.work_id, idempotencyKey: 'acquisition:' + r.id + ':' + financing.key + ':' + decimal(bid) });
                const failedConstraints: string[] = [], unresolved: string[] = [];
                if (computed.result.status !== 'SUCCEEDED' || computed.result.validity !== 'VALID')
                    unresolved.push(computed.result.failure?.code ?? 'MODEL_OUTPUT_UNRESOLVED');
                for (const constraint of r.request.constraints) {
                    const output = computed.result.outputs[constraint.outputNodeId];
                    if (!output || typeof output.value !== 'string' || output.unit !== constraint.unit || output.currency !== constraint.currency) {
                        unresolved.push('OUTPUT_UNAVAILABLE:' + constraint.outputNodeId);
                        continue;
                    }
                    if (constraint.operator === 'gte' ? !d(output.value).gte(constraint.threshold) : !d(output.value).lte(constraint.threshold))
                        failedConstraints.push(constraint.outputNodeId);
                }
                candidates.push({ bid: decimal(bid), financingCaseKey: financing.key, runId: computed.id, resultHash: computed.result.resultSemanticHash, feasible: unresolved.length ? null : failedConstraints.length === 0, failedConstraints, unresolved });
            }
        const unknown = candidates.some(c => c.feasible === null), feasible = candidates.filter(c => c.feasible === true).sort((a, b) => d(b.bid).cmp(a.bid) || a.financingCaseKey.localeCompare(b.financingCaseKey)), best = feasible[0];
        let decisionBaseId=base.id;
        if(!unknown&&!best&&base.workId!==r.work_id){
            const baseline=await createUnderwritingRun(ctx,{investmentCaseId:base.investmentCaseId,modelVersionId:base.modelVersionId,baseRunId:base.id,worldAt:base.worldAt.toISOString(),workId:r.work_id,idempotencyKey:'acquisition:'+r.id+':checked-baseline'});
            if(baseline.result.resultSemanticHash!==base.resultHash||baseline.inputSnapshot.semanticHash!==base.inputHash)fail('ACQUISITION_BASELINE_BINDING_MISMATCH');
            decisionBaseId=baseline.id;
        }
        const result: AcquisitionResult = { schema: 'finnor.acquisition-decision.v1', baseRunId: decisionBaseId, inputHash: base.inputHash, candidates, completeSearch: !unknown, maximumBid: { value: best?.bid ?? null, financingCaseKey: best?.financingCaseKey ?? null, runId: best?.runId ?? null, qualification: unknown ? 'UNRESOLVED' : best ? 'MAXIMUM_IN_DECLARED_FINITE_DOMAIN' : 'NO_FEASIBLE_CANDIDATE' }, executionAuthorityGranted: false, realizedProfitEstablished: false, costUSD: null };
        await assertCurrent(ctx, r);
        await transaction(ctx, async (c,db) => {
            // Match the event fabric's tenant → owner → Work lock ordering.
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,904))',[ctx.auth.tenantId]);
            await row(ctx, r.id, c, true);
            await c.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE', [ctx.auth.tenantId, r.work_id]);
            const work = await currentWork(ctx, r.work_id, c);
            if (work.id !== r.work_input_id || work.digest !== r.work_input_digest)
                fail('ACQUISITION_WORK_REVISION_CHANGED');
            try{await assertEvidenceSnapshotCurrent(ctx,base.inputSnapshot as UnderwritingInputSnapshot,c,true);}
            catch(error){if(error instanceof PeDomainError&&error.code==='STALE_EVIDENCE_DERIVATION')fail('ACQUISITION_SOURCE_CUT_CHANGED');throw error;}
            if (Date.now() >= new Date(r.deadline_at).getTime())
                fail('ACQUISITION_ORIGINAL_DEADLINE_EXHAUSTED');
            if (!await validClaim(c, ctx, execution))
                fail('ACQUISITION_PUBLICATION_FENCED');
            const published = await c.query("UPDATE finnor_os.acquisition_decisions SET status=$4,result=$5::jsonb,result_digest=$6,failure=NULL,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND active_claim_token=$7 AND active_claim_fence=$8 AND result IS NULL AND deadline_at>clock_timestamp()", [ctx.auth.tenantId, actor(ctx), r.id, unknown ? 'PARTIAL' : 'TESTED', JSON.stringify(result), semanticHash(result), execution.claimToken, execution.claimFence]);
            if (published.rowCount !== 1) {
                if ((await row(ctx, r.id, c)).deadline_expired)
                    fail('ACQUISITION_ORIGINAL_DEADLINE_EXHAUSTED');
                fail('ACQUISITION_PUBLICATION_FENCED');
            }
            await publishTerminalEvent(db,ctx,r,unknown?'PARTIAL':'TESTED',semanticHash(result));
        });
    }
    catch (error) {
        const deterministicModelFailure=error instanceof UnderwritingError||sourceProvenanceFailure(error);
        const terminal = deterministicModelFailure?'FAILED':error instanceof AcquisitionError ? {
            ACQUISITION_ORIGINAL_DEADLINE_EXHAUSTED: 'FAILED', ACQUISITION_WORK_REVISION_CHANGED: 'INVALIDATED',
            ACQUISITION_SOURCE_CUT_CHANGED: 'INVALIDATED', ACQUISITION_CURRENT_OWNER_REQUIRED: 'INVALIDATED',
            ACQUISITION_REQUIRED_ANALYSIS_FAILED:'FAILED',ACQUISITION_ANALYSIS_PARENT_CHANGED:'INVALIDATED',
        }[error.code] : error instanceof Error&&error.message.startsWith('ACQUISITION_ANALYSIS_')?'INVALIDATED':undefined;
        if (!terminal)
            throw error;
        const recorded = await transaction(ctx, async (c,db) => {
            await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,904))',[ctx.auth.tenantId]);
            if (!await validClaim(c, ctx, execution))
                return false;
            const failure=error instanceof UnderwritingError?'ACQUISITION_UNDERWRITING_'+error.code:sourceProvenanceFailure(error)?'ACQUISITION_SCENARIO_POLICY_REJECTED':error instanceof AcquisitionError?error.code:(error as Error).message;
            const saved = await c.query("UPDATE finnor_os.acquisition_decisions SET status=$4,failure=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND active_claim_token=$6 AND active_claim_fence=$7 AND result IS NULL", [ctx.auth.tenantId, actor(ctx), r.id, terminal, failure, execution.claimToken, execution.claimFence]);
            if(saved.rowCount===1)await publishTerminalEvent(db,ctx,r,terminal,null);
            return saved.rowCount === 1;
        });
        if (!recorded)
            throw error;
    }
    finally {
        if (leases)
            await releaseComputeResourceLeases(leases, 'acquisition-calculation-finished');
    }
}
async function validClaim(c: PoolClient, ctx: PeMutationContext, x: Readonly<JobExecutionContext>) { return !!(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 FOR SHARE", [ctx.auth.tenantId, x.jobId, x.claimToken, x.claimFence])).rows[0]; }
export const ACQUISITION_OPERATIONS = ['acquisition-evaluate', 'acquisition-read','acquisition-intake-context','acquisition-intake-review','acquisition-closing-context'] as const;
export const AcquisitionOperationSchemas = {
    'acquisition-closing-context':AcquisitionClosingContextSchema,
    'acquisition-intake-context':AcquisitionIntakeContextSchema,
    'acquisition-intake-review':AcquisitionIntakeReviewSchema,
    'acquisition-evaluate': AcquisitionRequestSchema,
    'acquisition-read': z.object({ decisionId: z.string().uuid() }).strict(),
} as const;
export async function handleAcquisitionOperation(ctx: PeMutationContext, operation: string, body: unknown) {
    try {
        if(operation==='acquisition-closing-context')return {status:200,body:await readAcquisitionClosingContext(ctx,body)};
        if(operation==='acquisition-intake-context')return {status:200,body:await acquisitionIntakeContext(ctx,body)};
        if(operation==='acquisition-intake-review')return {status:200,body:await reviewAcquisitionIntake(ctx,body)};
        if (operation === 'acquisition-evaluate')
            return { status: 202, body: await submitAcquisitionDecision(ctx, body) };
        const input = AcquisitionOperationSchemas['acquisition-read'].parse(body);
        return { status: 200, body: await readAcquisitionDecision(ctx, input.decisionId) };
    }
    catch (error) {
        if(error instanceof PeDomainError&&error.code==='PE_ENTITY_NOT_FOUND')return {status:404,body:{code:error.code,error:'Acquisition inputs are unavailable in the authenticated scope'}};
        if(error instanceof UnderwritingError)return {status:422,body:{code:error.code,error:error.message}};
        if(error instanceof Error&&/^ACQUISITION_(?:INTAKE|CLOSING|IC)_[A-Z_]+$/.test(error.message))return {status:422,body:{code:error.message}};
        if(error instanceof Error&&/^CLOSING_[A-Z_]+$/.test(error.message))return {status:409,body:{code:error.message}};
        if(error instanceof Error&&/^REVIEWED_ACQUISITION_[A-Z_]+$/.test(error.message))return {status:409,body:{code:error.message}};
        if (error instanceof AcquisitionError)
            return { status: error.status, body: { code: error.code } };
        if (error instanceof z.ZodError)
            return { status: 400, body: { code: 'ACQUISITION_SCHEMA_INVALID', issues: error.issues.map(i => ({ path: i.path, message: i.message })) } };
        throw error;
    }
}

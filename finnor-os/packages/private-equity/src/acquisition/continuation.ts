import type {PoolClient} from 'pg';
import type {GoalSpec,PlanGraph} from '@finnor/planning';
import {semanticHash} from '@finnor/underwriting';
import type {PeMutationContext} from '../types';
import {principal,stable,tx} from '../evidence-execution/store';
import {AcquisitionActionSchema,type AcquisitionRequest} from './contracts';
import {HarnessRequestSchema,type HarnessRequest} from '../program-synthesis/contracts';

export interface AcquisitionProgramBinding {owner:'acquisition';decisionId:string;planRevisionId:string}
export function acquisitionAnalysisRequest(request:AcquisitionRequest,workInputId?:string){
 const a=request.analysis;if(!a)throw Error('ACQUISITION_ANALYSIS_UNAVAILABLE');
 return HarnessRequestSchema.parse({schema:'finnor.harness-request.v1',instruction:a.instruction,root:{entityType:'pe_deal',entityId:request.dealId},workId:request.workId,...(workInputId?{workInputId}:{}),idempotencyKey:'acquisition:'+request.idempotencyKey+':analysis',validAt:a.validAt,...(a.knowledgeAt?{knowledgeAt:a.knowledgeAt}:{}),mode:'production_analysis',sources:a.sources,acceptance:a.acceptance,...(a.limits?{limits:a.limits}:{}),...(a.procedure?{procedure:a.procedure}:{}),...(a.ownerBindings?{ownerBindings:a.ownerBindings}:{}),...(a.computeSearch?{computeSearch:a.computeSearch}:{})});
}
/** An executing action may consume its selected plan, never select another one.
 * This internal binding is reconstructed from canonical rows, not HTTP fields. */
export async function selectedAcquisitionParent(ctx:PeMutationContext,request:AcquisitionRequest,actionId:string,c:PoolClient,checkedEvidence=false){
 const parent=(await c.query<{id:string;plan_id:string;payload:unknown;goal_spec:GoalSpec;plan_graph:PlanGraph;constraint_set:{deadlineAt?:string}}>(`WITH RECURSIVE lineage AS (
  SELECT id,parent_revision_id,work_input_id,revision,0 depth FROM finnor_os.work_plan_revisions
   WHERE tenant_id=$1 AND work_id=$4 AND status IN('active','completed')
    AND work_input_id=(SELECT id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$4 ORDER BY created_at DESC,id DESC LIMIT 1)
  UNION ALL SELECT p.id,p.parent_revision_id,p.work_input_id,p.revision,l.depth+1
   FROM finnor_os.work_plan_revisions p JOIN lineage l ON l.parent_revision_id=p.id AND l.work_input_id=p.work_input_id AND p.revision<l.revision
   WHERE p.tenant_id=$1 AND p.work_id=$4 AND l.depth<256
 ) SELECT a.id::text,a.plan_revision_id::text plan_id,a.payload,p.goal_spec,p.plan_graph,p.constraint_set
  FROM finnor_os.domain_actions a JOIN finnor_os.work_plan_revisions p ON p.tenant_id=a.tenant_id AND p.id=a.plan_revision_id
  WHERE a.tenant_id=$1 AND a.id=$2 AND a.initiated_by=$3 AND a.work_id=$4 AND a.action_type='start_acquisition_evaluation'
   AND a.status NOT IN('failed','cancelled','superseded') AND (p.status='active' OR ($5::boolean AND a.status='completed' AND
    (p.status='completed' OR p.status='superseded' AND EXISTS(SELECT 1 FROM lineage WHERE id=p.id))))
   AND p.work_id=a.work_id AND p.work_input_id=(SELECT id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$4 ORDER BY created_at DESC,id DESC LIMIT 1)`,[ctx.auth.tenantId,actionId,principal(ctx),request.workId,checkedEvidence])).rows[0];
 if(!parent)throw Error('ACQUISITION_ANALYSIS_PARENT_PLAN_UNAVAILABLE');
 const clean=(v:unknown)=>AcquisitionActionSchema.parse(Object.fromEntries(Object.entries(v as Record<string,unknown>).filter(([k])=>!['tenantId','workId','idempotencyKey'].includes(k))));
 if(semanticHash(clean(parent.payload))!==semanticHash(clean(request)))throw Error('ACQUISITION_ANALYSIS_PARENT_INTENT_MISMATCH');
 return parent;
}
export async function acquisitionProgramPlan(ctx:PeMutationContext,binding:AcquisitionProgramBinding,request:HarnessRequest,c?:PoolClient,access:'execution'|'checked_evidence'='execution'){
 const read=async(client:PoolClient)=>{
  const r=(await client.query<{id:string;work_id:string;work_input_id:string;request:AcquisitionRequest;request_digest:string;parent_action_id:string;parent_plan_revision_id:string;deadline_at:Date;status:string}>(
   'SELECT * FROM finnor_os.acquisition_decisions WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[ctx.auth.tenantId,principal(ctx),binding.decisionId])).rows[0];
  if(!r||!r.request.analysis||semanticHash(r.request)!==r.request_digest||['FAILED','INVALIDATED'].includes(r.status)||r.parent_plan_revision_id!==binding.planRevisionId)throw Error('ACQUISITION_ANALYSIS_PARENT_CHANGED');
  if(r.status!=='TESTED'&&Date.now()>=new Date(r.deadline_at).getTime())throw Error('ACQUISITION_ANALYSIS_ORIGINAL_DEADLINE_EXHAUSTED');
  const checkedEvidence=access==='checked_evidence'&&r.status==='TESTED';
  const parent=await selectedAcquisitionParent(ctx,r.request,r.parent_action_id,client,checkedEvidence);
  const expected=acquisitionAnalysisRequest(r.request,r.work_input_id);
  // Parse defaults through the same public request grammar at construction.
  if(stable(request)!==stable(expected))throw Error('ACQUISITION_ANALYSIS_CHILD_INTENT_MISMATCH');
  return {goal:parent.goal_spec,planGraph:parent.plan_graph,planRevisionId:parent.plan_id,checkedEvidence,deadlineAt:new Date(Math.min(new Date(r.deadline_at).getTime(),parent.constraint_set.deadlineAt?Date.parse(parent.constraint_set.deadlineAt):Infinity)).toISOString()};
 };
 return c?read(c):tx(ctx,read,true);
}
/** Called in the checked/failed P1 publication transaction. Lost deliveries
 * replay this same child identity and cannot create another analysis. */
export async function wakeAcquisitionFromProgram(ctx:PeMutationContext,binding:AcquisitionProgramBinding,programId:string,generation:number,c:PoolClient){
 await c.query(`INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety)
  VALUES($1,'evaluate_acquisition_v1',$2::jsonb,$3,'batch',1,'locally_idempotent') ON CONFLICT(idempotency_key) DO NOTHING`,
  [ctx.auth.tenantId,stable({tenantId:ctx.auth.tenantId,principalId:principal(ctx),decisionId:binding.decisionId}),'acquisition:'+binding.decisionId+':analysis:'+programId+':'+generation+':terminal']);
}

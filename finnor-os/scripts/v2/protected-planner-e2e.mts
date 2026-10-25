import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {beginWorkPlannerAttempt} from '@finnor/db';
import {attachWorkToDealGraph,getUnderwritingRun} from '@finnor/private-equity';
import {FinnorOrchestrator,LLMPlanner,executeTenantOperationalQuery,parseObjectiveSuccessCondition,startWorkObjective} from '@finnor/orchestration';
import {selectAndMaterializePlan} from '../../packages/orchestration/src/plan-runtime';
import {assembleOperatingContext} from '../../packages/orchestration/src/operating-context';
import {driveDurableAction} from '../../tests/integration/helpers/durable-action';

export async function protectedPrimaryPlanner(e:any){
 const {ctx,admin,root,work,output,deadlineAt}=e,tenant=ctx.auth.tenantId,actor=ctx.auth.userId;
 const originalInput=(await admin.query('SELECT instruction_id::text,instruction_text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 AND id=$3',[tenant,work.workId,work.workInputId])).rows[0];assert(originalInput);
 const objective=originalInput.instruction_text;
 const successCondition=parseObjectiveSuccessCondition({version:1,statement:objective,mode:'all',source:'explicit',criteria:[{kind:'no_open_execution'},{kind:'decision_evidence',minimumCount:1,accepted:['canonical_query']}]});
 await attachWorkToDealGraph(ctx,{dealId:root.entityId,workId:work.workId,entities:[{entityType:'pe_deal',entityId:root.entityId,relationship:'about'}]});
 const roleId=randomUUID();
 await admin.query("INSERT INTO finnor_os.employee_roles(id,tenant_id,key,name) VALUES($1,$2,$3,'Controlled primary planner authority')",[roleId,tenant,'primary-'+roleId]);
 await admin.query("INSERT INTO finnor_os.employee_role_assignments(tenant_id,employee_id,role_id,resource_scope) VALUES($1,$2,$3,'{\"kind\":\"tenant\"}')",[tenant,actor,roleId]);
 await admin.query("INSERT INTO finnor_os.role_authority_grants(tenant_id,role_id,capability,resource_type,effect,max_risk,approval_required) VALUES($1,$2,'*','*','allow','high',false)",[tenant,roleId]);
 for(const action of ['start_primary_diligence','create_underwriting_run','start_acquisition_evaluation']){
  const id=randomUUID();
  await admin.query('INSERT INTO finnor_os.domain_policies(id,tenant_id,action_type,policy,requires_confirmation,version,effective_from) VALUES($1,$2,$3,\'{}\',false,1,now())',[id,tenant,action]);
  await admin.query('INSERT INTO finnor_os.domain_policy_revisions(id,tenant_id,policy_id,action_type,version,policy,requires_confirmation,effective_from) VALUES($1,$2,$3,$4,1,\'{}\',false,now())',[randomUUID(),tenant,id,action]);
 }
 const loop=await startWorkObjective(objective,ctx.auth,{workId:work.workId,workInputId:work.workInputId,instructionId:originalInput.instruction_id,channel:'console',successCondition,deferInitialIteration:true,maxSteps:12,maxActions:3,maxQueries:6,deadlineAt});
 assert.equal(loop.workId,work.workId);assert.equal(loop.workInputId,work.workInputId);
 await writeFile(join(output,'primary-planner-original-objective.json'),JSON.stringify({loop,originalInput,deadlineAt,driver:'Controlled native planner candidate proposer. No live model or complete Objective controller qualification.'},null,2));
 const options={userId:actor,employeeId:actor,workId:work.workId,workInputId:work.workInputId};
 const request={intent:'primary_diligence_v1',workId:work.workId,dealId:root.entityId};
 const context=await executeTenantOperationalQuery(tenant,request as any,options);assert.equal(context.data.status,'WORKSPACE');
 const orchestrator=new FinnorOrchestrator(),stages:any[]=[];
 async function plan(stage:string,node:any){
  let captured:any;
  const provider:any={name:'explicit-primary-contract-proposer',complete:async(input:any)=>{captured=JSON.parse(input.user);return JSON.stringify({candidates:[{version:1,candidateKey:stage,nodes:[{key:'operation',...node,supports:captured.goal.criteria.map((c:any)=>c.id)},...captured.goal.criteria.map((c:any,i:number)=>({key:'check_'+i,kind:'check',criterionId:c.id,dependsOn:['operation']}))]}]});}};
  const operating=await assembleOperatingContext(ctx.auth,{instruction:objective,workId:work.workId,activeContext:{entityType:'pe_deal',entityId:root.entityId},includeMemory:false,includeSemanticMemory:false,includeCanonicalBusinessState:false});
  const effects=(await admin.query('SELECT e.id,e.status,e.effect,e.verification FROM finnor_os.business_effects e JOIN finnor_os.domain_actions a ON a.tenant_id=e.tenant_id AND a.id=e.domain_action_id WHERE e.tenant_id=$1 AND a.work_id=$2',[tenant,work.workId])).rows;
  const attempt=await beginWorkPlannerAttempt({tenantId:tenant,workId:work.workId,workInputId:work.workInputId,attemptKey:stage});
  const planning=await new LLMPlanner(orchestrator.plugins,provider).plan(objective,ctx.auth,{shortTerm:null,longTerm:null,semantic:[],episodic:[],patterns:null},{workId:work.workId,workInputId:work.workInputId,plannerAttemptId:attempt.id,successCondition,channel:'console',operatingContext:operating.context,planningContext:{businessEffects:effects}});
  const proof={stage,captured,planning,modelInferenceQualified:false};stages.push(proof);await writeFile(join(output,'primary-planner-'+stage+'.json'),JSON.stringify(proof,null,2));
  assert(captured);assert(planning.compilation.selected,JSON.stringify(planning.compilation));
  return {captured,planning,attempt};
 }
 async function action(stage:string,actionType:string,payload:any):Promise<Record<string,unknown>>{
  const p=await plan(stage,{kind:'action',actionType,payload});
  const parent=(await admin.query("SELECT id::text FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND work_id=$2 AND status='active' ORDER BY revision DESC LIMIT 1",[tenant,work.workId])).rows[0];
  const selected=await selectAndMaterializePlan({planning:p.planning,tenantContext:ctx.auth,workId:work.workId,workInputId:work.workInputId,plannerAttemptId:p.attempt.id,objectiveLoopId:loop.objectiveLoopId,parentRevisionId:parent?.id,reason:parent?'observation':'initial'});
  const graph=p.planning.compilation.selected?.graph;assert(graph);
  const node=graph.nodes.find(n=>n.kind==='action');assert(node?.kind==='action');assert.equal(node.actionType,actionType);
  const drafted=await orchestrator.draftKnownAction(actionType,node.groundedPayload,tenant,{actionId:selected.actions[0]!.id,workId:work.workId,initiatedBy:actor,source:'controlled-primary-planner',planRevisionId:selected.planRevisionId,planNodeId:node.id,plannerAttemptId:p.attempt.id});
  const afterDraft=(await admin.query('SELECT status FROM finnor_os.domain_actions WHERE tenant_id=$1 AND id=$2',[tenant,drafted.action.id])).rows[0];
  Object.assign(stages.at(-1),{selected,draftedActionId:drafted.action.id,draftResult:drafted.result,afterDraft});
  await writeFile(join(output,'primary-planner-'+stage+'.json'),JSON.stringify(stages.at(-1),null,2));
  if(afterDraft.status==='pending'){
   if(actionType==='start_primary_diligence')assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.v2_programmes WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0].n,0);
   const effect=(await admin.query('SELECT semantic_hash FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2',[tenant,drafted.action.id])).rows[0];
   const approved=await orchestrator.decide(drafted.action.id,tenant,'approve',actor,{role:'owner',expectedEffectHash:effect.semantic_hash,typedConfirmation:true});assert.equal(approved.status,'success',JSON.stringify(approved));
   Object.assign(stages.at(-1),{approved});
  }
  const result=await driveDurableAction(tenant,drafted.action.id);
  Object.assign(stages.at(-1),{result});await writeFile(join(output,'primary-planner-'+stage+'.json'),JSON.stringify(stages.at(-1),null,2));
  assert.equal(result.status,'success',JSON.stringify(result));
  const receipt=(await admin.query('SELECT status,effect,verification FROM finnor_os.business_effects WHERE tenant_id=$1 AND domain_action_id=$2',[tenant,drafted.action.id])).rows[0];assert.equal(receipt.status,'verified');assert.equal(receipt.verification.state,'verified');
  Object.assign(stages.at(-1),{selected,draftedActionId:drafted.action.id,result,receipt});await writeFile(join(output,'primary-planner-'+stage+'.json'),JSON.stringify(stages.at(-1),null,2));
  const state=result.output.canonicalState;assert(state&&typeof state==='object'&&!Array.isArray(state));
  if(actionType==='start_primary_diligence')for(const field of ['findings','assertions','costReceipts'])assert.equal(Object.hasOwn(state,field),false,'Public creation receipt must not copy private primary evidence');
  return state as Record<string,unknown>;
 }
 async function primaryRead(programmeId:string,expected:string){
  const wanted={...request,programmeId},p=await plan('primary-read-'+expected.toLowerCase(),{kind:'query',request:wanted});
  assert(p.captured.snapshot.availableReads.some((r:any)=>r.request.intent===request.intent&&!r.request.programmeId&&r.request.workId===work.workId));
  assert(p.captured.snapshot.availableReads.some((r:any)=>r.request.programmeId===programmeId&&r.request.workId===work.workId));
  const read=await executeTenantOperationalQuery(tenant,wanted as any,options);assert.equal(read.data.status,expected);assert.equal(read.data.workId,work.workId);
  Object.assign(stages.at(-1),{queryResult:read});
  if(expected==='COMPLETE'){
   const events=(await admin.query("SELECT event_type,resource_id::text,correlation_id,payload FROM finnor_os.integration_events WHERE tenant_id=$1 AND source='primary_worker' AND correlation_id=$2",[tenant,'primary:'+programmeId+':'+(read.data.ref as any).revision])).rows;
   assert.equal(events.length,1);assert.equal(events[0].event_type,'analysis.primary.terminal');assert.equal(events[0].resource_id,work.workId);assert.equal(events[0].payload.status,'COMPLETE');assert.equal(events[0].payload.workInputId,work.workInputId);
   Object.assign(stages.at(-1),{terminalEvents:events});
  }
  await writeFile(join(output,'primary-planner-primary-read-'+expected.toLowerCase()+'.json'),JSON.stringify(stages.at(-1),null,2));
  return read;
 }
 return {
  context,stages,primaryRead,
  submit:async(intake:any)=>{const {schema:_schema,root:_root,workId:_work,idempotencyKey:_key,...register}=intake;const accepted:any=await action('primary-start','start_primary_diligence',{...register,dealId:root.entityId});await primaryRead(accepted.programmeId,'PROGRESS');return accepted;},
  createRun:async(payload:any)=>{const {worldAt:_clock,idempotencyKey:_key,workId:_work,...inputs}=payload;const created=await action('source-underwriting','create_underwriting_run',{...inputs,dealId:root.entityId});assert(typeof created.id==='string');return getUnderwritingRun(ctx,created.id);},
  evaluate:async(payload:any)=>{const {workId:_work,idempotencyKey:_key,...mandate}=payload;return action('financial-evaluation','start_acquisition_evaluation',mandate);},
 };
}

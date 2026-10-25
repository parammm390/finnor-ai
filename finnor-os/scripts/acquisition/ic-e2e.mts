import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {beginWorkPlannerAttempt} from '@finnor/db';
import {LLMPlanner} from '@finnor/orchestration';
import {assembleOperatingContext} from '../../packages/orchestration/src/operating-context';
import {selectAndMaterializePlan} from '../../packages/orchestration/src/plan-runtime';
import {activateInvestmentCase,createWorkstream,createFinding,createIcCommitteeConfiguration,getIcWorkspace} from '@finnor/private-equity';
import {executeTenantOperationalQuery} from '@finnor/orchestration';
import {inspectPrivateEquityIcBasis} from '../../packages/orchestration/src/private-equity-ic-basis';
import {evaluateObjectiveSuccessCondition,inspectCurrentObjectiveSuccessState} from '../../packages/orchestration/src/objective-success';
import {driveDurableAction} from '../../tests/integration/helpers/durable-action';
import {getArtifactBytes} from '@finnor/artifacts';
import {peTransaction,withPeMutationTransaction,terminateDeal} from '../../packages/private-equity/src/repository';
import {evaluateAuthority} from '@finnor/authority';
import {randomUUID} from 'node:crypto';

export async function prepareAcquisitionIcFixture(e:any){
 const {ctx,tenant,actor,admin,story,evidence}=e;
 const investmentCaseId=e.investmentCaseId??(await admin.query('SELECT investment_case_id::text FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2',[tenant,story.mandate.baseRunId])).rows[0].investment_case_id;
 const investment=(await admin.query('SELECT state,version FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND id=$2',[tenant,investmentCaseId])).rows[0];
 if(investment.state==='draft')await activateInvestmentCase(ctx,{investmentCaseId,expectedVersion:Number(investment.version)});
 const workstream=await createWorkstream(ctx,{dealId:story.mandate.dealId,kind:'financial_diligence',name:'Fixture material revenue-cutoff investigation',owner:{partyType:'employee',partyId:actor}});
 const finding=await createFinding(ctx,{dealId:story.mandate.dealId,workstreamId:String(workstream.row.id),statement:'Fixture input: revenue cutoff remains an open material diligence question; the selected statement alone does not establish cash collectability.',severity:'high',materiality:'material',owner:{partyType:'employee',partyId:actor}});
 const policy={schemaVersion:'pe-ic-policy.v1',quorum:{kind:'MIN_COUNT',minimum:1},threshold:{kind:'SIMPLE_MAJORITY'},abstentionsCountForQuorum:true,deferralsCountForQuorum:false,abstentionsCountAsNonApprove:true,deferralsCountAsNonApprove:true,memoChange:'REQUIRE_REVOTE',underwritingRunChange:'REQUIRE_NEW_RECOMMENDATION',requiredQuestionWaiverAllowed:false,conditionWaiverAllowed:false,allowedPrimaryRunValidities:['VALID']};
 const orgId=randomUUID(),policyId=randomUUID(),revisionId=randomUUID();
 await admin.query("INSERT INTO finnor_os.org_units(id,tenant_id,unit_key,name,kind,active) VALUES($1,$2,$3,'Fixture acquisition IC','team',true)",[orgId,tenant,'acquisition-ic-'+orgId]);
 await admin.query("INSERT INTO finnor_os.domain_policies(id,tenant_id,action_type,policy,requires_confirmation,version,effective_from) VALUES($1,$2,'private_equity:ic_process',$3::jsonb,false,1,now())",[policyId,tenant,JSON.stringify(policy)]);
 await admin.query("INSERT INTO finnor_os.domain_policy_revisions(id,tenant_id,policy_id,action_type,version,policy,requires_confirmation,effective_from) VALUES($1,$2,$3,'private_equity:ic_process',1,$4::jsonb,false,now())",[revisionId,tenant,policyId,JSON.stringify(policy)]);
 for(const action of ['open_ic_case','begin_ic_preparation','create_ic_memo_draft','select_ic_memo_version','prepare_ic_recommendation','request_ic_memo_review']){
  const id=randomUUID();await admin.query("INSERT INTO finnor_os.domain_policies(id,tenant_id,action_type,policy,requires_confirmation,version,effective_from) VALUES($1,$2,$3,'{}',false,1,now())",[id,tenant,action]);
  await admin.query("INSERT INTO finnor_os.domain_policy_revisions(id,tenant_id,policy_id,action_type,version,policy,requires_confirmation,effective_from) VALUES($1,$2,$3,$4,1,'{}',false,now())",[randomUUID(),tenant,id,action]);
 }
 const committee=await createIcCommitteeConfiguration(ctx,{committeeOrgUnitId:orgId,policyRevisionId:revisionId,members:[{employeeId:actor,memberRole:'CHAIR',chair:true,votingEligible:true,effectiveFrom:new Date(Date.now()-60000).toISOString()}],idempotencyKey:'acquisition-ic-fixture-'+orgId});
 let executionProfile;
 if(process.env.FINNOR_ACQUISITION_IC_CONTROLLER_E2E==='1'){
  const {configureAgentProfile}=await import('../../packages/orchestration/src/workforce-runtime');
  const {createDefaultPluginRegistry}=await import('../../packages/orchestration/src/plugin-registry');
  executionProfile=[];
  for(const [key,actions] of [['acquisition',['start_acquisition_evaluation']],['preparation',['open_ic_case','begin_ic_preparation','create_ic_memo_draft','select_ic_memo_version']],['review',['prepare_ic_recommendation','request_ic_memo_review']],['verification',[]]] as const){
   executionProfile.push(await configureAgentProfile(tenant,createDefaultPluginRegistry(),{
    key:'disposable-acquisition-ic-'+key,name:'Disposable acquisition IC '+key,actor:ctx.auth,
    capabilityGrants:[...actions.map(capability=>({kind:'action' as const,capability})),
     ...(key==='verification'?[...['closing_readiness','pe_world_state','acquisition_decision_v1'].map(intent=>({kind:'query' as const,capability:'query:'+intent})),{kind:'check' as const,capability:'check:objective_success'}]:[])],
    autonomyLimits:{maxActions:Math.max(1,actions.length),maxQueries:11,maxReplans:8,maxPlannerCalls:11,maxWallClockMs:3600000},
    maxConcurrentAssignments:key==='verification'?4:1,
    planningHints:{qualification:'DISPOSABLE_NATIVE_AUTOMATIC_CONTROLLER_NOT_LIVE_MODEL_INFERENCE'},
   }));
  }
 }
 const fixture={investmentCaseId,finding,committee,policy,executionProfile,qualification:'Explicit disposable committee and material-uncertainty input; no customer uncertainty or committee vote inferred from a finite bid result'};
 await writeFile(join(evidence,'acquisition-ic-owner-fixture.json'),JSON.stringify(fixture,null,2));return fixture;
}

export async function acquisitionIcE2E(e:any){
 if(process.env.FINNOR_ACQUISITION_IC_CONTROLLER_E2E==='1'){
  const driven=await (await import('./ic-controller-e2e.mts')).acquisitionIcController(e);
  return verifyAcquisitionIcPreparation({...e,...driven});
 }
 const {ctx,tenant,actor,admin,api,evidence,orchestrator,work,instruction,loop,successCondition,selected,decisionId,observed}=e;
 const request={intent:'acquisition_decision_v1' as const,workId:work.workId,dealId:observed.body.request.dealId,decisionId};
 let captured:any;
 const provider:any={name:'acquisition-ic-continuation-contract-fixture',complete:async(input:any)=>{
  captured=JSON.parse(input.user);return JSON.stringify({candidates:[{version:1,candidateKey:'read-checked-acquisition-before-ic',nodes:[
   {key:'read',kind:'query',request,supports:captured.goal.criteria.filter((c:any)=>c.criterion.kind==='decision_evidence').map((c:any)=>c.id)},
   ...captured.goal.criteria.map((c:any,i:number)=>({key:'check_'+i,kind:'check',criterionId:c.id,dependsOn:['read']})),
  ]}]});
 }};
 const operating=await assembleOperatingContext(ctx.auth,{instruction,workId:work.workId,activeContext:{entityType:'pe_deal',entityId:request.dealId},includeMemory:false,includeSemanticMemory:false,includeCanonicalBusinessState:false});
 const attempt=await beginWorkPlannerAttempt({tenantId:tenant,workId:work.workId,workInputId:work.workInputId,attemptKey:'checked-acquisition-ic-handoff'});
 const effects=(await admin.query('SELECT e.id,e.status,e.effect,e.verification FROM finnor_os.business_effects e JOIN finnor_os.domain_actions a ON a.tenant_id=e.tenant_id AND a.id=e.domain_action_id WHERE e.tenant_id=$1 AND a.work_id=$2',[tenant,work.workId])).rows;
 const planning=await new LLMPlanner(orchestrator.plugins,provider).plan(instruction,ctx.auth,{shortTerm:null,longTerm:null,semantic:[],episodic:[],patterns:null},{workId:work.workId,workInputId:work.workInputId,plannerAttemptId:attempt.id,successCondition,channel:'console',operatingContext:operating.context,planningContext:{businessEffects:effects}});
 assert(planning.compilation.selected,JSON.stringify(planning.compilation));
 const next=await selectAndMaterializePlan({planning,tenantContext:ctx.auth,workId:work.workId,workInputId:work.workInputId,plannerAttemptId:attempt.id,objectiveLoopId:loop.objectiveLoopId,parentRevisionId:selected.planRevisionId,reason:'observation'});
 const current=await api('acquisition-read',{decisionId});
 const proof={work,decisionId,priorPlan:selected.planRevisionId,next,captured,planning,current,qualification:'ACTUAL_NATIVE_PLAN_HANDOFF_NOT_MODEL_INTELLIGENCE_OR_IC_VOTE'};
 await writeFile(join(evidence,'acquisition-ic-plan-handoff.json'),JSON.stringify(proof,null,2));
 assert.equal(current.status,200,JSON.stringify(current));assert.equal(current.body.status,'TESTED');assert.deepEqual(current.body.result,observed.body.result);
 await executeTenantOperationalQuery(tenant,request,{userId:actor,employeeId:actor,workId:work.workId,workInputId:work.workInputId});
 await executeTenantOperationalQuery(tenant,{intent:'pe_world_state',root:{entityType:'pe_deal',entityId:request.dealId}},{userId:actor,employeeId:actor,workId:work.workId});
 const steps:any[]=[];let parentPlan=next.planRevisionId,caseId:string|undefined;
 const icInstruction='Prepare the investment committee review using the checked acquisition, declared bids and financing cases, and recorded material diligence finding.';
 const memory={shortTerm:null,longTerm:null,semantic:[],episodic:[],patterns:null};
 const inspect=async()=>({
  privateEquityIcBasis:await inspectPrivateEquityIcBasis(ctx.auth,request.dealId,work.workId),
  actions:(await admin.query("SELECT id,action_type AS \"actionType\",status FROM finnor_os.domain_actions WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at,id",[tenant,work.workId])).rows,
  businessEffects:(await admin.query("SELECT e.id,e.domain_action_id AS \"domainActionId\",e.status,e.observed_result AS \"observedResult\",e.effect,e.verification FROM finnor_os.business_effects e JOIN finnor_os.domain_actions a ON a.tenant_id=e.tenant_id AND a.id=e.domain_action_id WHERE e.tenant_id=$1 AND a.work_id=$2 ORDER BY e.created_at,e.id",[tenant,work.workId])).rows,
  queryExecutions:(await admin.query('SELECT id,intent,status FROM finnor_os.work_query_executions WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows,
 });
 for(const actionType of ['open_ic_case','begin_ic_preparation','create_ic_memo_draft','select_ic_memo_version','prepare_ic_recommendation','request_ic_memo_review']){
  const planningContext=await inspect();
  const icAttempt=await beginWorkPlannerAttempt({tenantId:tenant,workId:work.workId,workInputId:work.workInputId,attemptKey:'acquisition-ic-'+actionType});
  const icOperating=await assembleOperatingContext(ctx.auth,{instruction:icInstruction,workId:work.workId,activeContext:{entityType:'pe_deal',entityId:request.dealId},includeMemory:false,includeSemanticMemory:false,includeCanonicalBusinessState:false});
  const noModel:any={name:'no-model-for-native-ic-continuation',complete:async()=>{throw Error('Expected a grounded native IC step, not an unconfigured model response');}};
  const icPlanning=await new LLMPlanner(orchestrator.plugins,noModel).plan(icInstruction,ctx.auth,memory,{workId:work.workId,workInputId:work.workInputId,plannerAttemptId:icAttempt.id,successCondition,channel:'console',operatingContext:icOperating.context,planningContext});
  await writeFile(join(evidence,'acquisition-ic-'+actionType+'-planning.json'),JSON.stringify({planningContext,planning:icPlanning},null,2));
  assert(icPlanning.compilation.selected,JSON.stringify(icPlanning.compilation));
  const node=icPlanning.compilation.selected.graph!.nodes.find((n:any)=>n.kind==='action');assert(node&&node.kind==='action');assert.equal(node.actionType,actionType);
  if(actionType==='open_ic_case')assert.equal(node.groundedPayload.primaryUnderwritingRunId,observed.body.result.baseRunId,'NO_FEASIBLE must retain the effective checked source run, not the newest infeasible scenario');
  const materialized=await selectAndMaterializePlan({planning:icPlanning,tenantContext:ctx.auth,workId:work.workId,workInputId:work.workInputId,plannerAttemptId:icAttempt.id,objectiveLoopId:loop.objectiveLoopId,parentRevisionId:parentPlan,reason:'observation'});parentPlan=materialized.planRevisionId;
  const drafted=await orchestrator.draftKnownAction(actionType,node.groundedPayload,tenant,{actionId:materialized.actions[0]!.id,workId:work.workId,initiatedBy:actor,source:'acquisition-ic:e2e',planRevisionId:parentPlan,planNodeId:node.id,plannerAttemptId:icAttempt.id});
  assert.equal(drafted.result.status,'success',JSON.stringify(drafted.result));
  let approval;
  if(drafted.result.output.gated){
   if(actionType==='open_ic_case')assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.pe_ic_cases WHERE tenant_id=$1 AND deal_id=$2',[tenant,request.dealId])).rows[0].n,0,'A gated draft cannot open an IC case');
   const effect=(await admin.query('SELECT e.semantic_hash FROM finnor_os.business_effects e JOIN finnor_os.domain_actions a ON a.tenant_id=e.tenant_id AND a.business_effect_id=e.id WHERE a.tenant_id=$1 AND a.id=$2',[tenant,drafted.action.id])).rows[0];assert(effect?.semantic_hash);
   approval=await orchestrator.decide(drafted.action.id,tenant,'approve',actor,{role:'owner',expectedEffectHash:effect.semantic_hash,typedConfirmation:true});assert.equal(approval.status,'success',JSON.stringify(approval));
  }
  const executed=await driveDurableAction(tenant,drafted.action.id);
  const persisted=(await admin.query('SELECT a.status,e.effect,e.verification,e.observed_result,r.actual_result,r.failure,r.finalized_at FROM finnor_os.domain_actions a LEFT JOIN finnor_os.business_effects e ON e.tenant_id=a.tenant_id AND e.id=a.business_effect_id LEFT JOIN finnor_os.decision_receipts r ON r.tenant_id=a.tenant_id AND r.domain_action_id=a.id WHERE a.tenant_id=$1 AND a.id=$2',[tenant,drafted.action.id])).rows;
  await writeFile(join(evidence,'acquisition-ic-'+actionType+'-dispatch.json'),JSON.stringify({materialized,drafted,approval,executed,persisted},null,2));
  if(executed.status!=='success'){
   const producer=(await admin.query('SELECT q.status,q.proposed,q.evidence_query_id,p.body FROM finnor_os.p1_requests q LEFT JOIN finnor_os.p1_programs p ON p.tenant_id=q.tenant_id AND p.id=q.head_id WHERE q.tenant_id=$1 AND q.id=$2',[tenant,observed.body.analysis.programId])).rows[0];
   const revisions=(await admin.query('SELECT key,revision::text FROM finnor_os.p4_source_revisions WHERE tenant_id=$1 AND key=ANY($2::text[])',[tenant,(producer?.body?.dependencies??[]).map((d:any)=>d.key)])).rows;
   const original=(producer?.body?.dependencies??[]).map((d:any)=>({...d,currentRevision:Number(revisions.find((r:any)=>r.key===d.key)?.revision??0)}));
   const source=(await admin.query('SELECT q.status,d.body FROM finnor_os.p4_queries q LEFT JOIN finnor_os.p4_derivations d ON d.tenant_id=q.tenant_id AND d.id=q.derivation_id WHERE q.tenant_id=$1 AND q.id=$2',[tenant,producer.evidence_query_id])).rows[0];
   const checked=await (await import('../../packages/private-equity/src/program-synthesis/store')).currentCheckedHarnessProgram(ctx,observed.body.analysis.programId).then(()=>({current:true}),(error:any)=>({current:false,code:error.code,message:error.message,stack:error.stack}));
   await writeFile(join(evidence,'acquisition-ic-'+actionType+'-failure-source.json'),JSON.stringify({producerStatus:producer.status,dependencies:original,changed:original.filter((d:any)=>d.revision!==d.currentRevision),source,checked,currentAcquisition:await api('acquisition-read',{decisionId})},null,2));
  }
  assert.equal(executed.status,'success',JSON.stringify(executed));
  if(actionType==='open_ic_case')caseId=String((executed.output.entity as {entityId:string}).entityId);
  steps.push({actionType,materialized,drafted,approval,executed});await writeFile(join(evidence,'acquisition-ic-steps.json'),JSON.stringify(steps,null,2));
 }
 return verifyAcquisitionIcPreparation({...e,steps,caseId});
}

async function verifyAcquisitionIcPreparation(e:any){
 const {ctx,tenant,actor,work,loop,successCondition,decisionId,observed,evidence,steps,caseId}=e;
 const request={intent:'acquisition_decision_v1' as const,workId:work.workId,dealId:observed.body.request.dealId,decisionId};
 assert(caseId);const workspace=await getIcWorkspace(ctx,{icCaseId:caseId});assert.equal(workspace.case.primaryUnderwritingRunId,observed.body.result.baseRunId);assert.equal(workspace.case.state,'READY_FOR_REVIEW');assert.equal(workspace.currentRecommendation?.outcome,'CONTINUE_DILIGENCE');assert.equal(workspace.votes.length,0);
 assert(String(workspace.currentRecommendation?.rationale).includes('revenue cutoff'),'Recommendation must identify the recorded material finding, not an absent title');
 const {bytes,...artifact}=await getArtifactBytes({tenantId:tenant,userId:actor,role:'owner'},String(workspace.memo!.documentId),String(workspace.memo!.documentVersionId));
 await writeFile(join(evidence,'acquisition-ic-memo.docx'),bytes);
 const paragraphs=artifact.ir.nodes.filter(n=>n.kind==='paragraph').map(n=>String(n.data.text));const text=paragraphs.join('\n');
 assert(text.includes('930000')&&text.includes('operating_profit'));assert(text.includes('NO_FEASIBLE_CANDIDATE'));assert(text.includes('acquisition_decision:'+decisionId));
 assert(paragraphs.some(p=>p.startsWith('operating_profit:')&&p.includes('930000')&&p.includes('money USD')),'The recorded source currency must accompany its financial value');
 for(const bid of ['1900000','2000000','2100000'])for(const financing of ['cash','debt1000'])assert(paragraphs.some(p=>p.includes(bid)&&p.includes(financing)&&p.includes('INFEASIBLE')));
 const inspection=await inspectCurrentObjectiveSuccessState(tenant,work.workId,loop.objectiveLoopId);const verification=await evaluateObjectiveSuccessCondition({tenantId:tenant,workId:work.workId,loopId:loop.objectiveLoopId,stepNumber:1,condition:successCondition,inspection,evidence:[{kind:'canonical_query',request,assertion:{path:['data','status'],operator:'eq',expected:'TESTED'}}]});
 await writeFile(join(evidence,'acquisition-ic-preparation-proof.json'),JSON.stringify({work,decisionId,steps,workspace,artifact,verification,explicitUncertainty:e.icFixture?.finding,qualification:'Actual native IC preparation; no vote, investment approval, resolved material uncertainty, hosted auth or economic outcome'},null,2));
 assert.equal(verification.state,'verified',JSON.stringify(verification));
 const terminationAuthority=await evaluateAuthority(ctx.auth,{operation:'action',capability:'private_equity:terminate_deal',resource:{type:'pe_deal',id:request.dealId},risk:'high'});assert.equal(terminationAuthority.outcome,'allowed');
 const rollback=Error('ROLLBACK_DISPOSABLE_DEAL_REVISION');let materialChange:any;
 await assert.rejects(()=>withPeMutationTransaction(ctx,async()=>{
  const before=await peTransaction(ctx,async(_db,client)=>(await client.query('SELECT version,graph_version,status FROM finnor_os.pe_deals WHERE tenant_id=$1 AND id=$2',[tenant,request.dealId])).rows[0]);
  const mutation=await terminateDeal(ctx,{dealId:request.dealId,expectedVersion:before.version,reason:'Disposable negative control; rollback retains the original active Deal',governance:{authorityDecisionId:terminationAuthority.id}});
  const changed=mutation.row;assert.equal(changed.version,before.version+1);assert.equal(changed.graphVersion,before.graph_version);assert.equal(changed.status,'terminated');
  const versions={before,changed};
  const refusal=await getIcWorkspace(ctx,{icCaseId:caseId!}).then(()=>null,(error:any)=>({code:error.code??error.message}));
  materialChange={versions,refusal,terminationAuthority};assert.equal(refusal?.code,'STALE_EVIDENCE_DERIVATION');throw rollback;
 }),error=>error===rollback);
 const restored=await getIcWorkspace(ctx,{icCaseId:caseId});assert.equal(restored.case.state,'READY_FOR_REVIEW');
 await writeFile(join(evidence,'acquisition-ic-business-revision-refusal.json'),JSON.stringify({...materialChange,rollback:true,restoredCase:restored.case},null,2));
 return {workspace,verification,caseId};
}

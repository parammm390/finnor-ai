/** Real upstream setup and recipient-owned S4/S5/S6 E2E, no effect grants. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mjs';
import {POST as s3Post} from '../../apps/api/app/api/interventions/[operation]/route';
import {POST as s4Post} from '../../apps/api/app/api/policies/[operation]/route';
import {POST as s6Post} from '../../apps/api/app/api/obligations/[operation]/route';
import {allocationRef} from '../../packages/epistemic-runtime/src/allocation-contracts';
import {sha,quantity} from '../../packages/private-equity/src/confidential-computation/contracts';
export async function ownerSetup(input:{admin:any;privateDirectory:string;tenant:string;principal:string;root:any;
 nonrecipient?:string;executionBudget?:{requests:number;humanSeconds:number};
 deadlineAt:string;call:(owner:string,operation:string,body:unknown,principal?:string)=>Promise<any>}){
 const python=process.env.FINNOR_S3_PYTHON;
 if(!python)throw Error('Y4_PINNED_SCIENTIFIC_PYTHON_REQUIRED');
 // reference.py reads one bounded JSON command, never Y4 participant records.
 const rows=await new Promise<any[]>((yes,no)=>{
  const child=spawn(python,[join(import.meta.dirname,'../s3/reference.py')],{stdio:['pipe','pipe','pipe']});
  let out='',error='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error('Y4_S3_REFERENCE_DEADLINE'));},15000);
  child.stdout.on('data',b=>{out+=b;if(out.length>1048576)child.kill('SIGKILL');});
  child.stderr.on('data',b=>{error+=b;if(error.length>65536)child.kill('SIGKILL');});
  child.once('error',no);
  child.once('close',code=>{clearTimeout(timer);if(code!==0){no(Error('Y4_S3_SYNTHETIC_REFERENCE_FAILED'));return;}
   try{yes(JSON.parse(out).rows);}catch{no(Error('Y4_S3_REFERENCE_SCHEMA_FAILED'));}});
  child.stdin.end('{"operation":"equivalent"}');
 });
 const artifact=async(name:string,value:unknown)=>{
  const path=join(input.privateDirectory,'upstream',name);await mkdir(join(path,'..'),{recursive:true,mode:0o700});
  await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
 };
 const api=async(f:any,operation:string,body:unknown,handler?:unknown)=>{
  const owner=handler===s3Post?'interventions':handler===s4Post?'policies':handler===s6Post?'obligations':'allocations';
  const result=await input.call(owner,operation,body,f.principal);
  if(result.status!==200)await artifact('unexpected-'+owner+'-'+operation+'.json',result);
  return result;
 };
 const day=86400000,begin=new Date(Math.floor(Date.now()/day)*day-128*day).toISOString();
 const support=createUpstreamFixtureSupport({admin:()=>input.admin,generatedRows:rows,begin,day,fixtures:{},api,artifact});
 const other=input.nonrecipient?await support.fixture('y4-other-'+randomUUID().slice(0,8),2,
  [{id:'cash',unit:'USD',capacity:100,totalLimit:100}],{identity:{tenant:input.tenant,principal:input.nonrecipient},
   expiresAt:input.deadlineAt,deadlineMs:30000}):undefined;
 const dimensions=[{id:'cash',unit:'USD',capacity:100,totalLimit:100},
  ...(input.executionBudget?[{id:'compute',unit:'request',resourceClass:'COMPUTE',
   capacity:input.executionBudget.requests,totalLimit:input.executionBudget.requests},
   {id:'human',unit:'seconds',resourceClass:'HUMAN_ATTENTION',
    capacity:input.executionBudget.humanSeconds,totalLimit:input.executionBudget.humanSeconds}]:[])];
 const f=await support.fixture('y4-upstream-'+randomUUID().slice(0,8),2,
  dimensions,{existing:{tenant:input.tenant,principal:input.principal,root:input.root},
   expiresAt:input.deadlineAt,deadlineMs:30000});
 const otherPolicy=other?await support.policy(other,'nonrecipient-analysis',{cash:25}):undefined;
 const policy=await support.policy(f,'recipient-analysis',{cash:25,
  ...(input.executionBudget?{compute:input.executionBudget.requests,human:input.executionBudget.humanSeconds}:{})});
 await support.resource(f,'cash','USD','STOCK',['100','100','100']);
 if(input.executionBudget)for(const [id,unit,value] of [
  ['compute','request',input.executionBudget.requests],['human','seconds',input.executionBudget.humanSeconds]] as const)
   await support.resource(f,id,unit,'CUMULATIVE_EXPENDITURE',Array(3).fill(String(value)));
 const current=await api(f,'validate',{policyRef:policy.ref},s4Post);
 await artifact('original-policy-currentness.private.json',current);
 assert.equal(current.status,200);assert.equal(current.body.status,'CURRENT');
 return {f,policy,support,api,artifact,other,otherPolicy};
}
export async function ownerConsumption(input:{setup:Awaited<ReturnType<typeof ownerSetup>>;admin:any;tenant:string;
 principal:string;nonrecipient:string;semantics:any;workId:string;computationId:string;releaseId:string;opening:any;
 call:(operation:string,body:unknown,principal?:string)=>Promise<any>;
 ownerCall:(owner:string,operation:string,body:unknown,principal?:string)=>Promise<any>;
 scope:(principal:string,run:(client:any)=>Promise<unknown>)=>Promise<unknown>}){
 const {setup,computationId,releaseId,semantics}=input,{f,policy,support}=setup,
  binding={computationId,releaseId,output:'joint_liquidity'},
  guard={binding,semantics,minimum:'0',maximum:'100',
   qualification:'RECIPIENT_LOCAL_DERIVED_ADMISSIBILITY_NOT_S2_OBSERVATION'},
  decision={...support.decision(f,null),allocationRefs:[]};
 const ok=(r:any)=>{assert.equal(r.status,200);return r.body;};
 assert(setup.other&&setup.otherPolicy);
 const otherDecision={...support.decision(setup.other,null),allocationRefs:[]};
 assert.equal((await input.ownerCall('policies','decide',{policyRef:setup.otherPolicy.ref,
  decision:otherDecision},input.nonrecipient)).status,200);
 const current=await input.ownerCall('policies','validate',{policyRef:policy.ref});
 await setup.artifact('before-confidential-choice-currentness.private.json',current);
 const response=await input.call('confidential-control-choice',{policyRef:policy.ref,decision,confidentialGuard:guard});
 await setup.artifact('confidential-choice-response.private.json',response);
 const choice=ok(response);
 assert.equal(choice.status,'POLICY_AVAILABLE');
 const refused=await input.call('confidential-control-choice',{policyRef:policy.ref,decision,
  confidentialGuard:{...guard,minimum:'50'}});
 assert.equal(refused.status,409);
 const foreign=await input.call('confidential-control-choice',{policyRef:policy.ref,decision,confidentialGuard:guard},input.nonrecipient);
 assert(foreign.status>=400);
 const requestFor=(selected:any,label:string)=>{
  const clearing=support.clearing(f,{[label]:['0']},[],[],[selected]);
  for(const scenario of clearing.jointModel.scenarios){
   scenario.terms[0].evidenceRef={owner:'Y4_OUTPUT_PLACEHOLDER',id:[computationId,releaseId,'joint_liquidity'].join(':'),
    version:'y4-explicit-native-value-placeholder-v1',contentDigest:sha(binding)};
  }
  const {ref:_,...jointBody}=clearing.jointModel;
  clearing.jointModel.ref=allocationRef('BUSINESS_OWNER','joint-allocation-model',jointBody,'s5-joint-model-v1');
  return {clearing,request:{input:clearing,
   bindings:clearing.jointModel.scenarios.map((s:any)=>({scenarioId:s.id,termIndex:0,binding,semantics}))}};
 };
 const {clearing,request}=requestFor(policy,'recipient-analysis');
 const badSemantics=structuredClone(request);badSemantics.bindings[0].semantics.currencyCode='EUR';
 assert((await input.call('confidential-allocation',badSemantics)).status>=400);
 const allocated=ok(await input.call('confidential-allocation',request));
 assert.equal(allocated.status,'FEASIBLE');assert(allocated.reservation);
 assert(allocated.certificate.check.selectedPolicyIds.includes(policy.ref.id));
 assert.equal((await input.admin.query('SELECT $1::numeric=$2::numeric matches',
  [allocated.certificate.check.objective,quantity(input.opening.outputs[0])])).rows[0].matches,true);
 const durable=(await input.admin.query('SELECT problem FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND content_digest=$2',
  [input.tenant,allocated.certificate.ref.contentDigest])).rows[0].problem;
 const forged=structuredClone({...clearing,jointModel:durable.jointModel,idempotencyKey:randomUUID()});
 forged.jointModel.scenarios[0].terms[0].value='999';
 const {ref:__,...forgedBody}=forged.jointModel;
 forged.jointModel.ref=allocationRef('BUSINESS_OWNER','joint-allocation-model',forgedBody,'s5-joint-model-v1');
 assert((await input.ownerCall('allocations','clear',forged)).status>=400);
 await input.scope(input.nonrecipient,async c=>{
  for(const [table,column,id] of [['s5_proposals','content_digest',allocated.certificate.ref.contentDigest],
   ['s5_reservations','reservation_id',allocated.reservation.ref.id],['s5_reservation_origins','reservation_id',allocated.reservation.ref.id],
   ['s5_history','subject_id',allocated.reservation.ref.id]]){
   assert.equal((await c.query(`SELECT 1 FROM finnor_os.${table} WHERE tenant_id=$1 AND ${column}=$2`,[input.tenant,id])).rowCount,0);
  }
  assert.equal((await c.query('SELECT finnor_os.y4_allocation_context_complete() complete')).rows[0].complete,false);
 });
 assert((await input.ownerCall('allocations','resources',{},input.nonrecipient)).status>=400);
 const pendingPolicy=await support.policy(f,'recipient-followup-analysis',{cash:25});
 const pendingRequest=requestFor(pendingPolicy,'recipient-followup-analysis').request;
 const pendingAllocation=ok(await input.call('confidential-allocation',pendingRequest));
 assert.equal(pendingAllocation.status,'FEASIBLE');assert(pendingAllocation.reservation);
 assert(pendingAllocation.certificate.check.selectedPolicyIds.includes(pendingPolicy.ref.id));
 const pendingHandoff=ok(await input.ownerCall('policies','handoff',{policyRef:pendingPolicy.ref,
  decision:support.decision(f,pendingAllocation.certificate.ref),allocationRef:pendingAllocation.certificate.ref}));
 await setup.artifact('pending-native-handoff.private.json',{pendingRequest,pendingAllocation,pendingHandoff});
 assert(pendingHandoff.preparationRef&&pendingHandoff.consumptionRef);
 assert((await input.call('confidential-obligation',{policyRef:policy.ref,
  decision:support.decision(f,allocated.certificate.ref),allocationRef:allocated.certificate.ref,
  confidentialGuard:guard,workId:randomUUID()})).status>=400);
 const prepared=ok(await input.call('confidential-obligation',{policyRef:policy.ref,
  decision:support.decision(f,allocated.certificate.ref),allocationRef:allocated.certificate.ref,
  confidentialGuard:guard,workId:input.workId}));
 assert.equal(prepared.obligation.status,'PREPARED_UNADMITTED');
 assert.equal(prepared.obligation.executionAuthorityGranted,false);
 const native=(await input.admin.query(`SELECT d.status action_status,d.work_id,d.plan_revision_id,e.status effect_status,o.body
  FROM finnor_os.s6_obligation_origins o JOIN finnor_os.domain_actions d ON d.id=o.domain_action_id
   JOIN finnor_os.business_effects e ON e.id=o.effect_id
  WHERE o.tenant_id=$1 AND o.obligation_id=$2`,[input.tenant,prepared.obligation.ref.id])).rows[0];
 assert.equal(native.action_status,'draft');assert.equal(native.effect_status,'compiled');
 assert.equal(native.work_id,null);assert.equal(native.plan_revision_id,null);
 assert.equal(prepared.obligation.workLineage,undefined);
 await input.scope(input.nonrecipient,async c=>{
  assert.equal((await c.query('SELECT 1 FROM finnor_os.s6_obligation_origins WHERE obligation_id=$1',[prepared.obligation.ref.id])).rowCount,0);
  assert.equal((await c.query('SELECT 1 FROM finnor_os.business_effects WHERE id=$1',[prepared.obligation.effectRef.id])).rowCount,0);
  assert.equal((await c.query('SELECT 1 FROM finnor_os.domain_actions WHERE id=$1',[prepared.obligation.domainActionId])).rowCount,0);
  assert.equal((await c.query('SELECT finnor_os.y4_control_context_complete() complete')).rows[0].complete,false);
 });
 const hiddenChoice=await input.ownerCall('policies','decide',{policyRef:setup.otherPolicy.ref,
  decision:otherDecision},input.nonrecipient);
 assert.equal(hiddenChoice.status,400);
 assert.equal(hiddenChoice.body.error,'Outstanding effects require reconciliation before a new choice');
 await setup.artifact('recipient-owner-continuation.private.json',{request,choice,refused,foreign,allocated,prepared,native});
 return {allocated,prepared,pendingS6:{preparationRef:pendingHandoff.preparationRef,
  allocationRef:pendingAllocation.certificate.ref,consumptionRef:pendingHandoff.consumptionRef},
  summary:{actualS4Choice:true,actualS5OptimizationAndExactCheck:true,
  actualS5Reservation:true,actualS5Consumption:true,actualS6Obligation:true,
  nativeEffectStatus:'compiled',nativeActionStatus:'draft',executionAuthorityGranted:false,dispatchGranted:false,
  nonrecipientSqlBodiesHidden:true,hiddenReservationNeverOmitted:true,forgedValueAndSemanticsDenied:true,
  ownNonrecipientPolicyWorkedBeforeEffect:true,hiddenEffectNotTreatedAsZeroByActualS4:true,
  secondNativeReservationAndConsumptionRetainedForCommitRace:true}};
}

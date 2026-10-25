import assert from 'node:assert/strict';
import {writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {economicFixture} from '../s7/economic-fixtures.mts';
import {createEconomicLedger} from '../s7/ledger-fixture.mts';
import {deliverOwnerTransportBatch} from '../../packages/governed-execution/src/owner-delivery-store';
import {evaluateObjectiveSuccessCondition,inspectCurrentObjectiveSuccessState} from '../../packages/orchestration/src/objective-success';

export async function acquisitionEconomicWorkE2E(e:any){
 const {ctx,admin,work,output,http}=e,tenant=ctx.auth.tenantId,commands:any[]=[];
 const original=async()=>(await admin.query('SELECT to_jsonb(l) loop,(SELECT jsonb_agg(to_jsonb(i) ORDER BY created_at,id) FROM finnor_os.work_inputs i WHERE i.tenant_id=l.tenant_id AND i.work_id=l.work_id) inputs FROM finnor_os.work_objective_loops l WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0];
 const frozen=await original();
 const call=async(operation:string,input:unknown,identity?:'actor'|'other'|'anonymous'|'invalid',proxy=false)=>{
  const response=await(proxy?http.economicThroughProxy: http.economicPost)(operation,input,identity);commands.push({operation,input,response,identity:identity??'actor',proxy});
  await writeFile(join(output,'economic-work-native.json'),JSON.stringify({commands,frozen,qualification:'ORDINARY_NATIVE_TRACKING_ONLY; GENERATED_UNPROTECTED_ECONOMIC_SOURCES; NO_FIELD_OUTCOME_OR_CAUSAL_CREDIT'},null,2));return response;
 };
 const choose=await call('work-context',{workId:work.workId});assert.equal(choose.status,200);assert.equal(choose.body.state,'SELECT_REQUIREMENT');assert.equal(choose.body.criteria.length,2);
 const first=await call('work-context',{workId:work.workId,criterionIndex:3});assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.body.state,'NOT_BOUND');assert.equal(first.body.anchor.workInputId,work.workInputId);
 const previousTransport={config:process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG,root:process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT};
 const valuatorPrincipal=randomUUID(),ledger=await createEconomicLedger(tenant,ctx.auth.userId,valuatorPrincipal,{rightsRef:'declared-disposable-economic-rights',nativeBusinessOwner:true});
 try{
 const anchor=first.body.anchor,estimand=economicFixture(1,0,1).input.estimand;
 const registeredAt=new Date(),assignmentAt=new Date(Date.now()+300000),endpointAt=new Date(assignmentAt);endpointAt.setUTCMonth(endpointAt.getUTCMonth()+1);
 Object.assign(estimand,{key:'original-work-'+work.workInputId,episodeId:work.workId,registeredAt:registeredAt.toISOString(),assignmentAt:assignmentAt.toISOString(),endpointAt:endpointAt.toISOString(),outcomeAccessNotBefore:assignmentAt.toISOString(),horizonMonths:1});
 estimand.assignment={kind:'OBSERVATIONAL_UNIDENTIFIED',protocolRef:estimand.assignment.protocolRef,exposureMappingRef:estimand.assignment.exposureMappingRef,reasons:['Declared future observation only. No randomized assignment, actual field source, outcome or causal credit is established.']};
 estimand.analysis.registeredLooks=[estimand.endpointAt];estimand.discountSchedule=[{at:estimand.endpointAt,factor:'1'}];estimand.assumptions=estimand.assumptions.map((a:any)=>({...a,status:'UNKNOWN',evidenceRefs:[]}));
 const registered=await call('register',{estimand,rightsRef:'declared-disposable-economic-rights',mode:'PROSPECTIVE',idempotencyKey:'unbound:'+work.workInputId});assert.equal(registered.status,200,JSON.stringify(registered));
 const ref=registered.body.record.ref;
 const spoof=await call('append',{kind:'SOURCE',estimandRefId:ref.id,record:{schema:'finnor.s7.work-economic-binding.v1',anchor,estimandRef:ref,completionSatisfied:true},sourceRefs:[],validAt:registeredAt.toISOString(),idempotencyKey:'copied-binding:'+work.workInputId});assert.equal(spoof.status,200);
 assert.equal((await call('work-context',{workId:work.workId,criterionIndex:3})).body.state,'NOT_BOUND');
 const bindingInput={anchor,estimandRef:ref,idempotencyKey:'bind:'+work.workInputId};
 const bound=await Promise.all(Array.from({length:4},()=>call('bind-work',bindingInput)));assert(bound.every(r=>r.status===200),JSON.stringify(bound));
 const binding=bound[0].body.binding;assert.equal(binding.kind,'WORK_BINDING');assert(bound.every(r=>r.body.binding.ref.id===binding.ref.id));assert.equal(binding.payload.anchor.workInputId,work.workInputId);
 const duplicateContext=await call('work-context',{workId:work.workId,criterionIndex:4});assert.equal(duplicateContext.status,200);assert.equal(duplicateContext.body.anchor.criterionHash,anchor.criterionHash);assert.notEqual(duplicateContext.body.anchor.criterionIndex,anchor.criterionIndex);
 const duplicateBinding=await call('bind-work',{anchor:duplicateContext.body.anchor,estimandRef:ref,idempotencyKey:'bind-duplicate-clause:'+work.workInputId});assert.equal(duplicateBinding.status,200,JSON.stringify(duplicateBinding));assert.notEqual(duplicateBinding.body.binding.ref.id,binding.ref.id);
 const context=await call('work-context',{workId:work.workId,criterionIndex:3},undefined,true);assert.equal(context.status,200,JSON.stringify(context));assert.equal(context.body.tracking.bindingRef.id,binding.ref.id);assert.equal(context.body.completionSatisfied,false);assert.equal(context.body.causalCreditGranted,false);assert.equal(context.body.tracking.assignmentKind,'OBSERVATIONAL_UNIDENTIFIED');assert(context.body.tracking.sourceGaps.length>0);
 for(const bad of [{...bindingInput,anchor:{...anchor,workInputId:randomUUID()}},{...bindingInput,anchor:{...anchor,criterionHash:'0'.repeat(64)}},{...bindingInput,anchor:{...anchor,criterionIndex:1}}]){const denied=await call('bind-work',bad);assert(denied.status>=400,JSON.stringify(denied));}
 const foreign=await call('work-context',{workId:work.workId,criterionIndex:3},'other');assert.equal(foreign.status,404);assert.equal((await call('work-context',{workId:work.workId,criterionIndex:3},'invalid')).status,401);
 const corrected={...estimand,key:'corrected-'+work.workInputId,correctionOf:ref};
 const correction={anchor,estimand:corrected,rightsRef:'declared-disposable-economic-rights',replacesBindingRef:binding.ref,idempotencyKey:'correct:'+work.workInputId};
 const count=async()=>(await admin.query("SELECT kind,count(*)::int n FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND principal_id=$2 GROUP BY kind ORDER BY kind",[tenant,ctx.auth.userId])).rows;
 const before=await count();
 const wrongCurrency=await call('register-work',{...correction,estimand:{...corrected,currency:'EUR'},idempotencyKey:'wrong-currency:'+work.workInputId});assert.equal(wrongCurrency.status,409);assert.equal(wrongCurrency.body.code,'ECONOMIC_WORK_OWNER_CURRENCY_REQUIRED');assert.deepEqual(await count(),before);
 const accidental=await call('register-work',{...correction,replacesBindingRef:undefined,idempotencyKey:'accidental:'+work.workInputId});assert.equal(accidental.status,409);assert.deepEqual(await count(),before);
 await admin.query("CREATE FUNCTION finnor_os.economic_work_fixture_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='WORK_BINDING' THEN RAISE EXCEPTION 'DISPOSABLE_BINDING_WRITE_FAILURE'; END IF; RETURN NEW; END $$");
 await admin.query('CREATE TRIGGER economic_work_fixture_fail BEFORE INSERT ON finnor_os.s7_economic_records FOR EACH ROW EXECUTE FUNCTION finnor_os.economic_work_fixture_fail()');
 const rolledBack=await call('register-work',correction);assert.equal(rolledBack.status,500);assert.deepEqual(await count(),before,'Preregistration survived its failed atomic binding');
 await admin.query('DROP TRIGGER economic_work_fixture_fail ON finnor_os.s7_economic_records');await admin.query('DROP FUNCTION finnor_os.economic_work_fixture_fail()');
 http.dropNextEconomicResponse();await assert.rejects(()=>http.economicPost('register-work',correction));
 const recovered=await call('register-work',correction);assert.equal(recovered.status,200,JSON.stringify(recovered));const replacement=recovered.body.binding;assert.notEqual(replacement.ref.id,binding.ref.id);assert.equal(replacement.revisionOf,binding.ref.id);
 const finalContext=await call('work-context',{workId:work.workId,criterionIndex:3},undefined,true);assert.equal(finalContext.body.tracking.bindingRef.id,replacement.ref.id);assert.equal(finalContext.body.completionSatisfied,false);
 const retainedDuplicate=await call('work-context',{workId:work.workId,criterionIndex:4},undefined,true);assert.equal(retainedDuplicate.body.tracking.bindingRef.id,duplicateBinding.body.binding.ref.id);
 const retainedBinding=await call('read',{id:binding.ref.id});assert.equal(retainedBinding.status,200);assert.deepEqual(retainedBinding.body,binding);
 const staleCorrection=await call('register-work',{...correction,estimand:{...corrected,key:'fork-'+work.workInputId},idempotencyKey:'fork:'+work.workInputId});assert.equal(staleCorrection.status,409);
 const after=await count();assert.equal(after.find((r:any)=>r.kind==='PREREGISTRATION').n,2);assert.equal(after.find((r:any)=>r.kind==='WORK_BINDING').n,3);
 const correctedPreregistration=await call('read',{id:replacement.payload.estimandRef.id});assert.equal(correctedPreregistration.status,200);assert.equal(correctedPreregistration.body.kind,'PREREGISTRATION');
 const delivery=await deliverOwnerTransportBatch({semanticOwner:'S7',tenantId:tenant,principalId:ctx.auth.userId},{limit:32});
 assert.equal(delivery.accepted,10,JSON.stringify(delivery));assert.deepEqual(delivery.failures,[{identity:registered.body.record.event.eventId,code:'UNCOMMITTED_OR_UNAUTHORIZED_REFERENCE'},{identity:correctedPreregistration.body.event.eventId,code:'EVENT_NOT_FOUND'}]);
 const protectedBinding=await call('read',{id:replacement.ref.id,protectedReadback:true});assert.equal(protectedBinding.status,200);assert(protectedBinding.body.protectedReadback);assert.equal(protectedBinding.body.record.protectedReceipt,null);assert.equal(protectedBinding.body.qualification,'AUTHENTICATED_IMMUTABLE_BYTES_ONLY');
 const origins=(await admin.query("SELECT kind,identity FROM finnor_os.s6_owner_delivery_origins WHERE tenant_id=$1 AND principal_id=$2 AND semantic_owner='S7' ORDER BY kind,identity",[tenant,ctx.auth.userId])).rows;assert.equal(origins.length,12);
 const verification=await evaluateObjectiveSuccessCondition({tenantId:tenant,workId:work.workId,loopId:frozen.loop.id,stepNumber:920001,condition:frozen.loop.success_condition,inspection:await inspectCurrentObjectiveSuccessState(tenant,work.workId,frozen.loop.id),evidence:[]});
 assert.equal(verification.results.find(r=>r.kind==='manual_verification')?.satisfied,false);assert.notEqual(verification.state,'verified');const retained=await original();assert.deepEqual(retained,frozen);
 const observational=await(await import('./observational-economic-e2e.mts')).observationalEconomicE2E({ctx,http,ledger,valuatorPrincipal,estimand,anchor:duplicateContext.body.anchor,replacesBinding:duplicateBinding.body.binding.ref,previousEstimand:ref,output,admin});assert.deepEqual(await original(),frozen);
 const proof={commands,frozen,retained,choose,first,registered,spoof,binding,duplicateContext,duplicateBinding,retainedDuplicate,context,correction,rolledBack,recovered,finalContext,retainedBinding,staleCorrection,before,after,correctedPreregistration,delivery,protectedBinding,origins,verification,ownerDeliveryQualification:'SOURCE_GAPS_KEEP_TWO_PREREGISTRATION_EVENTS_UNACCEPTED',completionSatisfied:false,fieldOutcomeEstablished:false,causalCreditGranted:false};
 await writeFile(join(output,'economic-work-native.json'),JSON.stringify({...proof,observational},null,2));return {...proof,observational};
 }finally{await ledger.stop();await rm(ledger.root,{recursive:true,force:true});for(const [key,value]of [['FINNOR_S6_OWNER_TRANSPORT_CONFIG',previousTransport.config],['FINNOR_S6_OWNER_TRANSPORT_ROOT',previousTransport.root]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}}
}

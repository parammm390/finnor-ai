/** H1 uses actual S6 and a separately authorized synthetic loopback effect. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ownerSetup} from './owner-episode.mjs';
import {artifact} from './environment.mjs';
export async function effectPreservation(input:{
 admin:any;privateDirectory:string;evidence:string;foreignTenant:string;foreign:string;deadlineAt:string;
 installation:string;computationId:string;crash:()=>Promise<any>;restartApi:()=>Promise<void>;
 call:(operation:string,body:unknown)=>Promise<any>;
 ownerCall:(owner:string,operation:string,body:unknown,principal?:string)=>Promise<any>;
}){
 const root={entityType:'external_organization' as const,entityId:randomUUID()};
 await input.admin.query(`INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind)
  VALUES($1,$2,$3,'Y4 unrelated synthetic loopback effect','other')`,[root.entityId,input.foreignTenant,randomUUID()]);
 const setup=await ownerSetup({admin:input.admin,privateDirectory:join(input.privateDirectory,'unrelated-effect'),
  tenant:input.foreignTenant,principal:input.foreign,root,deadlineAt:input.deadlineAt,call:input.ownerCall,
  executionBudget:{requests:4,humanSeconds:4}}),
  {f,policy,support}=setup;
 const ok=(r:any)=>{assert.equal(r.status,200);return r.body;};
 const allocated=ok(await input.ownerCall('allocations','clear',support.clearing(f,{'recipient-analysis':['100']}),input.foreign));
 assert.equal(allocated.status,'FEASIBLE');
 const handoff=ok(await input.ownerCall('policies','handoff',{policyRef:policy.ref,allocationRef:allocated.certificate.ref,
  decision:support.decision(f,allocated.certificate.ref)},input.foreign));
 assert(handoff.preparationRef&&handoff.consumptionRef&&handoff.intervention);
 const obligation=ok(await input.ownerCall('obligations','prepare',{preparationRef:handoff.preparationRef,
  allocationRef:handoff.allocationRef,consumptionRef:handoff.consumptionRef},input.foreign));
 assert.equal(obligation.executionAuthorityGranted,false);
 const snapshot=async()=>(await input.admin.query(`SELECT jsonb_build_object(
  'effects',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM finnor_os.business_effects t WHERE tenant_id=$1),
  'actions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM finnor_os.domain_actions t WHERE tenant_id=$1),
  'reservations',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM finnor_os.s5_reservations t WHERE tenant_id=$1),
  'consumptions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM finnor_os.s5_consumptions t WHERE tenant_id=$1),
  'states',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM finnor_os.s5_consumption_states t WHERE tenant_id=$1),
  'history',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM finnor_os.s5_history t WHERE tenant_id=$1),
  'charges',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM finnor_os.s5_governed_resource_charges t WHERE tenant_id=$1)
 ) body`,[input.foreignTenant])).rows[0].body;
 const api=async(_f:any,operation:string,body:any)=>{
  const owner=['clear','resource','resources','settle','release'].includes(operation)||body.allocationRef&&!body.obligationRef&&['read','validate'].includes(operation)
   ?'allocations':'obligations';
  return input.ownerCall(owner,operation,body,input.foreign);
 };
 const module=await import(pathToFileURL(join(input.installation,'runtime/finnor-os/scripts/s6/governed-dispatch-proof.mts')).href);
 let preserved=false,crashSummary:any,unresolvedProviderOperationId:string|undefined;
 const cwd=process.cwd();
 let proof:any;
 try{
  process.chdir(join(input.installation,'runtime/finnor-os'));
  proof=await module.proveGovernedDispatch(f,obligation,api,input.admin,setup.artifact,false,undefined,false,{
   ownerCall:(operation:string,body:unknown)=>input.ownerCall('obligations',operation,body,input.foreign),
   onTransportConfigured:input.restartApi,
   onUnresolved:async(context:any)=>{
    assert.equal(context.accepted.body.status,'UNRESOLVED');
    assert.equal(context.uncertain[0].status,'UNKNOWN_OUTCOME');
    assert.equal(context.uncertain[0].reservation_status,'UNKNOWN_OUTCOME');
    assert.equal(context.requests.filter((r:any)=>r.method==='PATCH').length,1);
    unresolvedProviderOperationId=context.current.lastOperationId;assert(unresolvedProviderOperationId);
    const before=await snapshot(),recovery=await input.crash();crashSummary=recovery.summary;
    const cancelInput={computationId:input.computationId,idempotencyKey:randomUUID(),
     reason:'Stop this confidential computation without altering unrelated unresolved effect responsibility'},
     cancelled=await input.call('confidential-cancel',cancelInput);
    assert.equal(cancelled.status,200);assert.equal(cancelled.body.resourcesReplenished,false);
    assert.deepEqual(await input.call('confidential-cancel',cancelInput),cancelled);
    const after=await snapshot();assert.deepEqual(after,before);
    await setup.artifact('unresolved-effect-survives-y4.private.json',{before,after,cancelled,context});
    preserved=true;
   },
  });
 }finally{process.chdir(cwd);}
 assert(preserved);assert.equal(proof.requests.filter((r:any)=>r.method==='PATCH').length,1);
 assert.equal(proof.current.lastOperationId,unresolvedProviderOperationId);
 assert.equal(proof.steps[0].recovered.body.status,'VERIFIED');
 assert.equal(proof.steps[0].reconciled.body.consumption.status,'RECONCILED');
 assert.equal(proof.steps[0].reconciled.body.releaseGranted,false);
 const summary={actualNativeS4S5S6:true,actualAuthenticatedInstalledOwnerHttp:true,
  separatelyAuthorizedDisposableBusinessAndMethodSignatures:true,provider:'SYNTHETIC_LOOPBACK_TLS_ONLY',
  acceptedProviderMutationCount:1,lostAcceptedResponse:true,unknownOutcomeRetainedAcrossY4CrashAndCancel:true,
  nativeEffectActionReservationConsumptionChargeHistoryUnchangedByY4:true,
  actualColdS6ProtectedRecovery:true,originalProviderOperationIdentityRetained:true,duplicateMutationCount:0,
  independentReadOnlySettlement:'RECONCILED_NO_RESOURCE_RELEASE',y4Crash:crashSummary,
  productionAuthority:false,externalProvider:false,realFunds:false,protectedAdmission:false};
 await artifact(input.evidence,'effect-preservation.json',{schema:'finnor.y4.effect-preservation-e2e.v1',summary});
 return summary;
}

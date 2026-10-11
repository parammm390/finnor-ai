/** Reuse the original local S6 lost-acknowledgement owner proof. Only R1's
 * response is new: no alternate effect engine, grant ledger or settlement. */
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mts';
import {proveGovernedDispatch} from '../s6/governed-dispatch-proof.mts';
import {POST as s3} from '../../apps/api/app/api/interventions/[operation]/route';
import {POST as s4} from '../../apps/api/app/api/policies/[operation]/route';
import {POST as s5} from '../../apps/api/app/api/allocations/[operation]/route';
import {POST as s6} from '../../apps/api/app/api/obligations/[operation]/route';
import {ok} from './owner-fixture.mts';
import {epistemicHash} from '@finnor/epistemic-runtime';
export async function prepareS6BeforeR1Source(e:any,r1:any){
 const generated=spawnSync(process.env.FINNOR_S3_PYTHON!,[join(e.repo,'finnor-os/scripts/s3/reference.py')],{input:JSON.stringify({operation:'equivalent'}),encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
 const day=86400000,begin=new Date(Math.floor(Date.now()/day)*day-128*day).toISOString();
 const api=async(f:any,operation:string,body:any,handler=s5)=>e.http.api(r1.token,handler===s3?'interventions':handler===s4?'policies':handler===s6?'obligations':'allocations',operation,body);
 const support=createUpstreamFixtureSupport({admin:()=>e.admin,generatedRows:JSON.parse(generated.stdout).rows,begin,day,fixtures:{},api,artifact:e.artifact});
 const f=await support.fixture('r1-s6-original-obligation',3,[{id:'cash',unit:'USD',capacity:100,totalLimit:100},{id:'execution',unit:'request',capacity:200,totalLimit:200,resourceClass:'COMPUTE'},{id:'human',unit:'seconds',capacity:4,totalLimit:4,resourceClass:'HUMAN_ATTENTION'}],{identity:{tenant:r1.tenant,principal:r1.principal}});f.token=r1.token;
 const policy=await support.policy(f,'price',{cash:25,execution:130,human:4});await support.resource(f,'cash','USD','STOCK',['100','100','100','100']);await support.resource(f,'execution','request','CUMULATIVE_EXPENDITURE',['200','200','200','200']);await support.resource(f,'human','seconds','CUMULATIVE_EXPENDITURE',['4','4','4','4']);
 const {ref,...mandateBody}=r1.mandate;mandateBody.horizon=f.mandate.horizon;mandateBody.rightsRef=f.mandate.rightsRef;
 r1.mandate={...mandateBody,ref:{owner:'BUSINESS_OWNER',id:'mandate:'+epistemicHash(mandateBody),version:'economic-mandate-v1',contentDigest:epistemicHash(mandateBody)}};
 r1.model.horizon=f.mandate.horizon;r1.model.rightsRef=f.mandate.rightsRef;r1.model.mandateRef=r1.mandate.ref;
 for(const state of r1.model.states)state.semantics.rights.rightsRef=f.mandate.rightsRef;
 for(const instrument of r1.model.observationInstruments)instrument.rightsRef=f.mandate.rightsRef;
 await support.resource(f,'capital','USD','STOCK',['2','2','2','2'],undefined,[],{resourceClass:'CASH',permittedRoots:[f.root,r1.root]});
 await support.resource(f,'compute','native-attempt','CUMULATIVE_EXPENDITURE',['16','16','16','16'],undefined,[],{resourceClass:'COMPUTE',permittedRoots:[f.root,r1.root]});r1.resources=f.resources;
 const allocated=ok(await api(f,'clear',support.clearing(f,{price:['100']})));assert.equal(allocated.status,'FEASIBLE',JSON.stringify(allocated));const handoff=ok(await api(f,'handoff',{policyRef:policy.ref,allocationRef:allocated.certificate.ref,decision:support.decision(f,allocated.certificate.ref)},s4));assert(handoff.preparationRef&&handoff.consumptionRef);
 r1.s6={f,handoff,api};await e.artifact('s6-before-r1-original-inputs.json',{policy,allocated,handoff,sharedHorizon:f.mandate.horizon,sharedRights:f.mandate.rightsRef,resourcesIncludedInR1:f.resources.map((r:any)=>r.ref),qualification:'ORIGINAL_DISPOSABLE_NATIVE_OWNER_PROOF; NO_PRODUCTION_AUTHORITY'});
}
export async function proveS6R1Response(e:any,r1:any,observe:(value:any)=>Promise<void>){
 const {f,handoff,api}=r1.s6;
 const policyCurrent=await api(f,'validate',{policyRef:handoff.policyRef},s4),allocationCurrent=await api(f,'validate',{allocationRef:handoff.allocationRef},s5);await e.artifact('s6-owners-before-prepare.json',{policyCurrent,allocationCurrent});
 assert.equal(ok(policyCurrent).status,'CURRENT');assert.equal(ok(allocationCurrent).status,'CURRENT',JSON.stringify(allocationCurrent));
 const obligation=ok(await api(f,'prepare',{preparationRef:handoff.preparationRef,allocationRef:handoff.allocationRef,consumptionRef:handoff.consumptionRef},s6));assert.equal(obligation.executionAuthorityGranted,false);
 const proof=await proveGovernedDispatch(f,obligation,api,e.admin,e.artifact,false,undefined,false,{onUnresolved:observe});
 assert.equal(proof.requests.filter((r:any)=>r.method==='PATCH').length,1);return {physicalProviderAttempts:1,originalS6Evidence:'governed-dispatch.json',ordinaryHostedQualification:false,productionAdmission:false};
}

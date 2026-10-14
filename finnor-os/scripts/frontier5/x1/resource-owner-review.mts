/** Pre-repair frozen resource/meter oracle; every unit below is an actual HTTP
 * owner invocation under the original 520-request Work reservation. */
import assert from 'node:assert/strict';
import type pg from 'pg';
import type {PeMutationContext} from '../../../packages/private-equity/src/types';
import {readStoredAllocation,readAllocationConsumptions} from '../../../packages/private-equity/src/allocation-store';
export async function reviewResourceOwners(input:{ctx:PeMutationContext;admin:pg.Client;workId:string;requestId:string;
 api:(operation:string,body:unknown)=>Promise<{status:number;body:any}>;
 save:(name:string,value:unknown)=>Promise<unknown>;results:any[]}){
 const {ctx,admin,workId,requestId,api,save,results}=input,tenant=ctx.auth.tenantId,principal=ctx.auth.userId;
 const original=(await admin.query(`SELECT e.* FROM finnor_os.x1_compiler_episodes e JOIN finnor_os.x1_compiler_requests q
  ON q.tenant_id=e.tenant_id AND q.episode_id=e.id WHERE q.tenant_id=$1 AND q.principal_id=$2 AND q.id=$3`,[tenant,principal,requestId])).rows[0];
 assert.ok(original?.parent_reservation);const parent=original.parent_reservation;
 const charges=async()=>(await admin.query(`SELECT count(*)::int records,coalesce(sum(units),0)::int used FROM finnor_os.s5_governed_resource_charges
  WHERE tenant_id=$1 AND principal_id=$2 AND reservation_id=$3 AND unit='request'`,[tenant,principal,parent.id])).rows[0];
 const meters=async()=>(await admin.query(`SELECT record_id,body->'payload' payload FROM finnor_os.s7_economic_records WHERE tenant_id=$1 AND principal_id=$2
  AND body->'payload'->>'schema'='finnor.x1.api-compute.v1' AND body->'payload'->>'workId'=$3 ORDER BY record_id`,[tenant,principal,workId])).rows;
 const calls:any[]=[],started=await charges();assert.ok(started.records<513&&started.used<520);
 const call=async()=>{const before=await charges(),response=await api('institution-status',{requestId}),after=await charges();
  calls.push({at:new Date().toISOString(),operation:'institution-status',requestId,httpStatus:response.status,returnedStatus:response.body.status??null,before,after});return response;};
 for(let invocation=0;invocation<520&&Number((await charges()).records)<513;invocation++){
  assert.ok((await charges()).used<520,'The existing grant must reach 513 records without added resources');await call();
 }
 const at513=await charges();assert.equal(at513.records,513);assert.ok(at513.used<=520);
 const capture=async(read:()=>Promise<any>)=>{try{return {value:await read(),error:null};}catch(error){return {value:null,error:{message:String((error as Error).message),code:(error as any).code??null}};}};
 const stored=await capture(()=>readStoredAllocation(ctx,parent)),consumptions=await capture(()=>readAllocationConsumptions(ctx,parent));
 const actual=(await admin.query(`SELECT co.body,st.status,st.effect_ref FROM finnor_os.s5_consumptions co JOIN finnor_os.s5_consumption_states st USING(tenant_id,consumption_id)
  WHERE co.tenant_id=$1 AND co.principal_id=$2 AND co.reservation_id=$3 ORDER BY co.consumption_id`,[tenant,principal,parent.id])).rows;
 await save('resource-513-native-readback.json',{originalEpisodeId:original.id,parent,started,at513,stored,consumptions,actual,
  originalComputeRequests:520,originalHumanSeconds:900,originalWriteRowBound:1420,expectation:'Every one of 513 valid immutable charges remains readable; no budget increase or truncation'});
 results.push({id:'F-original-parent-513-consumption-readback',status:stored.value?.consumptions?.length===513&&consumptions.value?.length===513?'PASS':'FAIL',
  observed:{at513,storedError:stored.error,consumptionError:consumptions.error,storedCount:stored.value?.consumptions?.length??null,consumptionCount:consumptions.value?.length??null},
  basis:'ACTUAL_AUTHENTICATED_HTTP_WORK_ORIGINAL_S5_CHARGES_AND_RESTRICTED_NATIVE_READERS'});
 for(let invocation=0;invocation<520&&(await charges()).used<520;invocation++)await call();
 const exhausted=await charges();assert.equal(exhausted.used,520);
 const beforeMeters=await meters(),response=await call(),afterMeters=await meters(),ending=await charges();
 const priorIds=new Set(beforeMeters.map(row=>row.record_id)),newMeters=afterMeters.filter(row=>!priorIds.has(row.record_id));
 const meter=newMeters[0]?.payload;
 const unchanged=(await admin.query(`SELECT id,parent_reservation,parent_demand,original_deadline,wall_deadline FROM finnor_os.x1_compiler_episodes WHERE tenant_id=$1 AND id=$2`,[tenant,original.id])).rows[0];
 assert.deepEqual(unchanged.parent_reservation,parent);assert.deepEqual(unchanged.parent_demand,original.parent_demand);
 assert.equal(unchanged.original_deadline.valueOf(),original.original_deadline.valueOf());assert.equal(unchanged.wall_deadline.valueOf(),original.wall_deadline.valueOf());
 await save('resource-exhausted-api-physical-cost.json',{originalEpisodeId:original.id,parent,exhausted,response:{status:response.status,bodyStatus:response.body.status??null},beforeMeters,afterMeters,newMeters,ending,unchanged,calls,
  expectedAllocationRefusal:'X1_CHARGE_BUDGET_EXHAUSTED',expectedNewPhysicalMeters:1,newGrantOrParentIssued:false});
 const passed=newMeters.length===1&&meter.resourceCharge===null&&meter.resourceAllocation?.status==='REFUSED'
  &&meter.resourceAllocation.reason==='X1_CHARGE_BUDGET_EXHAUSTED'&&meter.elapsedMs>0&&meter.statusCode===response.status
  &&meter.money===null&&meter.humanSeconds===null&&JSON.stringify(meter.parentReservation)===JSON.stringify(parent)
  &&ending.used===520&&ending.records===exhausted.records;
 results.push({id:'F-exhausted-parent-retains-actual-api-cost',status:passed?'PASS':'FAIL',observed:{newMeters,exhausted,ending},
  basis:'KNOWN_PHYSICAL_HTTP_WORK_SURVIVES_S5_REFUSAL_IN_S7_ORIGINAL_PARENT_NO_RESOURCE_AUTHORITY_OR_VALUE_CREDIT'});
}

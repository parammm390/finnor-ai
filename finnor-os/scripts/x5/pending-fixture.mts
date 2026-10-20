/** Genuine pending responsibility from S3/S4/S5/S6. SQL controls only the
 * failure timing in the disposable database, never business state or grades. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mts';
import {artifact,repo} from '../x3/environment.mts';
import {quantity} from '../x3/business-fixtures.mts';
import {modes} from './business-fixtures.mts';

export async function preparePendingReplicas(f:{
 e:any;evidence:string;tenant:string;principal:string;token:string;root:any;application:any;
 values:(label:string,currency:string,lines:readonly string[],bank:string,isTransfer:boolean)=>Promise<any>;
 command:(action:string,record:any,input?:unknown,who?:string)=>Promise<any>;
}){
 const {e,evidence,tenant,principal,token,root}=f;
 const python=process.env.FINNOR_S3_PYTHON;
 assert(python&&python.startsWith('/'),'PINNED_S3_PYTHON_REQUIRED');
 const generated=spawnSync(python,[join(repo,'finnor-os/scripts/s3/reference.py')],{
  input:JSON.stringify({operation:'equivalent'}),encoding:'utf8',timeout:30000,
  env:{...process.env,OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1'},
 });
 assert.equal(generated.status,0,generated.stderr);
 const ok=(r:any)=>{assert.equal(r.status,200,JSON.stringify(r));return r.body;};
 const calls:any[]=[];
 const api=async(_fixture:any,operation:string,body:unknown)=>{
  const family=operation==='fit'?'interventions':['synthesize','handoff'].includes(operation)?'policies':'allocations';
  const response=await e.http.api(token,family,operation,body);
  calls.push({family,operation,input:body,...response});return response;
 };
 const day=86400000,begin=new Date(Math.floor(Date.now()/day)*day-128*day).toISOString();
 const support=createUpstreamFixtureSupport({admin:()=>e.admin,generatedRows:JSON.parse(generated.stdout).rows,begin,day,fixtures:{},api,
  artifact:(name,value)=>artifact(evidence,'pending-upstream/'+name,value)});
 const owner=await support.fixture('x5-pending-'+randomUUID().slice(0,8),2,[
  {id:'cash',unit:'USD',capacity:100,totalLimit:100},
 ],{existing:{tenant,principal,root},exposureUnit:'USD:minor:RECORDED_MINOR'});
 const result:any[]=[];
 // S4 correctly refuses new plans once a real outstanding S6 obligation exists.
 // Prepare all four upstream replicas before creating any such responsibility.
 const upstream:any[]=[];
 for(const [index,mode] of modes.entries()){
  const label='pending-'+index,policy=await support.policy(owner,label,{cash:25});
  if(index===0)await support.resource(owner,'cash','USD','STOCK',['100','100','100']);
  const cleared=ok(await api(owner,'clear',support.clearing(owner,{[label]:['100']},[],[],[policy])));
  assert.equal(cleared.status,'FEASIBLE',JSON.stringify(cleared));
  const handoff=ok(await api(owner,'handoff',{policyRef:policy.ref,allocationRef:cleared.certificate.ref,
   decision:support.decision(owner,cleared.certificate.ref)}));
  upstream.push({mode,handoff});
 }
 await e.admin.query(`CREATE FUNCTION finnor_os.x5_disposable_local_completion_failure() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN IF NEW.kind='S6_BOUND' AND NEW.application_id=TG_ARGV[0]::uuid
   THEN RAISE EXCEPTION 'X5_DISPOSABLE_AFTER_REAL_S6_COMMIT';END IF;RETURN NEW;END $$`);
 await e.admin.query(`CREATE TRIGGER x5_disposable_local_completion_failure BEFORE INSERT ON finnor_os.x3_events
  FOR EACH ROW EXECUTE FUNCTION finnor_os.x5_disposable_local_completion_failure('${f.application.id}')`);
 try{
  for(const {mode,handoff} of upstream){
   const channel=handoff.intervention.channels[0];
   assert.equal(channel.unit,'USD:minor:RECORDED_MINOR');assert.equal(channel.doses.length,1);
   const values=await f.values('N06:'+mode,'USD',[String(channel.doses[0])],String(channel.doses[0]),true);
   const q={...quantity(String(channel.doses[0]),'USD',root.entityId),time:{kind:'AS_OF',asOf:handoff.intervention.timing.startAt}};
   values.ledgerSlices={kind:'QUANTITY_LIST',entries:[q]};values.exportSlices={kind:'QUANTITY_LIST',entries:[q]};
   values.lotOperation=channel.operation;values.lotChannel=channel.exposureId;
   let record=ok(await f.command('create',null,values,'ledger')).record;
   for(const [action,who] of [['reconcile','ledger'],['approve','finance'],['prepare','ledger']]){
    const step=ok(await f.command(action!,record,{},who));assert(step.decision.allowed,JSON.stringify(step));record=step.record;
   }
   const input={applicationId:f.application.id,recordId:record.id,expectedRevision:record.revision,expectedReference:record.reference,
    preparationRef:handoff.preparationRef,allocationRef:handoff.allocationRef,consumptionRef:handoff.consumptionRef,idempotencyKey:randomUUID()};
   const interrupted=await e.http.api(token,'company-brain','application-prepare-effect',input);
   assert.equal(interrupted.status,500,'The local completion fault must occur after the canonical owner call');
   const retained=ok(await e.http.api(token,'company-brain','application-record',{applicationId:f.application.id,recordId:record.id}));
   assert(retained.pendingEffectId);assert.equal(retained.revision,record.revision+1);
   const native=(await e.admin.query(`SELECT o.body,e.status AS effect_status,e.effect,d.status AS action_status
    FROM finnor_os.s6_obligation_origins o JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id
    JOIN finnor_os.domain_actions d ON d.id=e.domain_action_id WHERE o.tenant_id=$1 AND o.body->'consumptionRef'->>'id'=$2`,
    [tenant,handoff.consumptionRef.id])).rows;
   assert.equal(native.length,1);assert.equal(native[0].effect_status,'compiled');assert.equal(native[0].action_status,'draft');
   assert.deepEqual(native[0].body.intervention,handoff.intervention);
   result.push({mode,record:retained,values,handoff,interrupted,native});
   await artifact(evidence,'pending-upstream/replica-'+mode+'.json',result.at(-1));
  }
 }finally{
  await e.admin.query('DROP TRIGGER x5_disposable_local_completion_failure ON finnor_os.x3_events');
  await e.admin.query('DROP FUNCTION finnor_os.x5_disposable_local_completion_failure()');
 }
 assert.equal((await e.admin.query('SELECT count(*)::int n FROM finnor_os.external_operations WHERE tenant_id=$1',[tenant])).rows[0].n,0);
 await artifact(evidence,'pending-upstream/calls.json',calls);
 return result;
}

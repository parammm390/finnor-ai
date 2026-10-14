/** Actual upstream owners and ordinary-role/native persistence. No protected authority fixture. */
import {strict as assert} from 'node:assert';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {spawnSync} from 'node:child_process';
import pg from 'pg';
import {closePool,withTenantTransaction} from '@finnor/db';
import {POST} from '../../apps/api/app/api/allocations/[operation]/route';
import {POST as s6Post} from '../../apps/api/app/api/obligations/[operation]/route';
import {POST as s4Post} from '../../apps/api/app/api/policies/[operation]/route';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mjs';
import {prepareEnterpriseDurableObligation,readEnterpriseDurableObligation,validateEnterpriseDurableObligation} from '../../packages/private-equity/src/enterprise-obligations.js';
import {authenticatedApiFixture} from '../frontier5/x1/authenticated-api-fixture.mts';
import {submitCommand} from '../../packages/workflow-runtime/src/commands';
const output=resolve(process.env.FINNOR_S6_OBLIGATION_EVIDENCE_DIR!);await mkdir(output,{recursive:true});
const repo=resolve('..');const admin=new pg.Client({connectionString:process.env.FINNOR_S6_ADMIN_DATABASE_URL});await admin.connect();await admin.query("SET app.test_vertical_mode='explicit'");
const results:any[]=[],calls:any[]=[],fixtures:Record<string,any>={};
const authenticatedLocal=process.env.FINNOR_S6_AUTHENTICATED_LOCAL==='1';
const authServices=new Map<string,Promise<Awaited<ReturnType<typeof authenticatedApiFixture>>>>(),authTraffic:any[]=[];
if(authenticatedLocal){process.env.AUTH_DEV_BYPASS='0';assert.notEqual(process.env.FINNOR_S6_DISPATCH_PROOF,'1');}
const artifact=async(name:string,value:any)=>{const path=join(output,name);await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,JSON.stringify(value,null,2)+'\n');return path;};
async function api(f:any,op:string,body:any,handler=POST){
 let response:Response;
 if(authenticatedLocal){
  if(!authServices.has(f.tenant)){
   assert.equal(authServices.size,0,'The selected authenticated guard fixture has one original tenant');
   const identity=await admin.query('UPDATE finnor_os.users SET email=$3 WHERE tenant_id=$1 AND id=$2 AND email=$4 RETURNING id,email',
    [f.tenant,f.principal,f.principal+'@test.invalid',f.name+'@s5.example.test']);
   assert.equal(identity.rowCount,1,'New disposable S5 fixture identity must match its actual local Auth-service email');
   await artifact('authenticated-disposable-identity.json',{rows:identity.rows,localServiceOnly:true,protectedAuthorityCreated:false});
   authServices.set(f.tenant,authenticatedApiFixture(repo,f.principal,(entry:unknown)=>{authTraffic.push(entry);}));
  }
  const service=await authServices.get(f.tenant)!;
  const owner=handler===s4Post?'policies':handler===s6Post?'obligations':handler===POST?'allocations':'interventions';
  response=await fetch(`${service.origin}/api/${owner}/${op}`,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+service.token},body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 }else response=await handler(new Request(`http://localhost/api/${handler===s4Post?'policies':handler===s6Post?'obligations':'allocations'}/${op}`,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':f.tenant,'x-user-id':f.principal},body:JSON.stringify(body)}),{params:Promise.resolve({operation:op})});
 const r={status:response.status,body:await response.json()};calls.push({op,...r});return r;
}
const python=process.env.FINNOR_S3_PYTHON!;
const generated=spawnSync(python,[join(repo,'finnor-os/scripts/s3/reference.py')],{input:JSON.stringify({operation:'equivalent'}),encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
const day=86400000,begin=new Date(Math.floor(Date.now()/day)*day-128*day).toISOString();
const nativeSupport=createUpstreamFixtureSupport({admin:()=>admin,generatedRows:JSON.parse(generated.stdout).rows,begin,day,fixtures,api,artifact});
const funded=process.env.FINNOR_S6_DISPATCH_PROOF==='1';
const {clearing,decision}=nativeSupport;
const fixture=(name:string,h:number,dimensions:any[],options:any={})=>nativeSupport.fixture(name,h,[...dimensions,...(funded?[{id:'execution',unit:'request',capacity:200,totalLimit:200,resourceClass:'COMPUTE'},{id:'human',unit:'seconds',capacity:4,totalLimit:4,resourceClass:'HUMAN_ATTENTION'}]:[])],options);
const policy=(f:any,name:string,amounts:any,options:any={})=>nativeSupport.policy(f,name,{...amounts,...(funded?{execution:130,human:4}:{})},options);
const resource=async(...args:Parameters<typeof nativeSupport.resource>)=>{const r=await nativeSupport.resource(...args);if(funded&&args[1]==='cash'){const f=args[0];await nativeSupport.resource(f,'execution','request','CUMULATIVE_EXPENDITURE',Array(f.mandate.horizon.periods+1).fill('200'));await nativeSupport.resource(f,'human','seconds','CUMULATIVE_EXPENDITURE',Array(f.mandate.horizon.periods+1).fill('4'));}return r;};
const selection=process.env.FINNOR_S6_OBLIGATION_CASE_FILTER;
async function challenge(id:string,fn:()=>Promise<any>){if(selection&&id!=='actual-upstream-handoff-and-one-native-responsibility'&&!selection.split(',').includes(id))return;try{results.push({id,status:'PASS',observed:await fn()});}catch(e){results.push({id,status:'FAIL',error:e instanceof Error?{message:e.message,stack:e.stack}:String(e)});}await artifact('results.json',{schema:'finnor.s6.obligation-e2e.v1',results,calls,node:process.version,qualification:authenticatedLocal?'Actual S1/S3/S4/S5/S6 owners; disposable bearer HTTP, no header bypass, ordinary PostgreSQL role. Preparation grants no protected authority, method or settlement.':'Actual S1/S3/S4/S5 owners; development headers, ordinary PostgreSQL role. Preparation grants no protected authority, method or settlement.',rerun:'python3 scripts/s6/run-obligation-local.py'});console.log(JSON.stringify({id,status:results.at(-1).status}));}
let f:any,handoff:any,obligation:any;
try{
 await challenge('actual-upstream-handoff-and-one-native-responsibility',async()=>{
  f=await fixture('s6-obligation-'+randomUUID().slice(0,8),2,[{id:'cash',unit:'USD',capacity:100,totalLimit:100}]);const p=await policy(f,'price',{cash:25});await resource(f,'cash','USD','STOCK',['100','100','100']);
  const cleared=await api(f,'clear',clearing(f,{price:['100']}));assert.equal(cleared.status,200,JSON.stringify(cleared));assert.equal(cleared.body.status,'FEASIBLE',JSON.stringify(cleared));
  const issued=await api(f,'handoff',{policyRef:p.ref,allocationRef:cleared.body.certificate.ref,decision:decision(f,cleared.body.certificate.ref)},s4Post);assert.equal(issued.status,200,JSON.stringify(issued));handoff=issued.body;assert(handoff.preparationRef&&handoff.consumptionRef&&handoff.intervention);
  const first=await Promise.all(Array.from({length:8},()=>api(f,'prepare',{preparationRef:handoff.preparationRef,allocationRef:handoff.allocationRef,consumptionRef:handoff.consumptionRef},s6Post)));assert(first.every(r=>r.status===200),JSON.stringify(first));obligation=first[0]!.body;assert(first.every(r=>r.body.ref.id===obligation.ref.id));
  assert.equal(obligation.executionAuthorityGranted,false);assert.equal(obligation.protectedReceipt,null);assert.equal(obligation.method.status,'UNADMITTED');assert.deepEqual(obligation.intervention,handoff.intervention);assert.equal(obligation.consumptionRef.id,handoff.consumptionRef.id);
  const native=await admin.query('SELECT d.status AS action_status,e.status AS effect_status,e.effect,o.body FROM finnor_os.s6_obligation_origins o JOIN finnor_os.business_effects e ON e.tenant_id=o.tenant_id AND e.id=o.effect_id JOIN finnor_os.domain_actions d ON d.id=e.domain_action_id WHERE o.tenant_id=$1',[f.tenant]);assert.equal(native.rowCount,1);assert.equal(native.rows[0].action_status,'draft');assert.equal(native.rows[0].effect_status,'compiled');assert.deepEqual(native.rows[0].effect.delta.values.intervention,handoff.intervention);return {handoff,obligation,native:native.rows};
 });
 await challenge('concurrent-retries-preserve-one-effect-and-consumption',async()=>{assert(obligation);const input={preparationRef:handoff.preparationRef,allocationRef:handoff.allocationRef,consumptionRef:handoff.consumptionRef};const retries=await Promise.all(Array.from({length:8},()=>prepareEnterpriseDurableObligation(f.ctx,input)));assert(retries.every(r=>r.ref.id===obligation.ref.id));assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1',[f.tenant])).rows[0].n,1);return retries.map(r=>r.effectRef);});
 await challenge('protocol3-rejects-institution-graphs-and-multiple-steps',async()=>{
  assert(obligation);const snapshot=async()=>(await admin.query(`SELECT
   (SELECT count(*) FROM finnor_os.commands WHERE tenant_id=$1)::int commands,
   (SELECT count(*) FROM finnor_os.jobs WHERE tenant_id=$1)::int jobs,
   (SELECT count(*) FROM finnor_os.workflow_steps WHERE tenant_id=$1)::int steps`,[f.tenant])).rows[0];
  const before=await snapshot(),payload={obligationRef:obligation.ref,notBefore:obligation.deadline.businessStartAt},step={stepType:'execute_governed_obligation',payload},refusals=[];
  for(const variant of [{workflowType:'institution_graph',steps:[step]},{workflowType:'single_action',steps:[step,step]}]){
   let predicate:string|null=null;
   try{await withTenantTransaction(f.tenant,{userId:f.principal},async db=>submitCommand(db,{tenantId:f.tenant,
    commandType:'execute_contingent_intervention',payload,protocolVersion:3,...variant}));}
   catch(error){predicate=String((error as Error).message);}
   assert.equal(predicate,'Governed obligation command requires one exact scheduled step');refusals.push({variant,predicate});
  }
  const after=await snapshot();assert.deepEqual(after,before);return {before,after,refusals,protectedAuthorityCreated:false};
 });
 await challenge('concrete-request-proposal-preserves-exact-upstream-meaning-without-admission',async()=>{assert(obligation);const channel=obligation.intervention.channels[0],methodDigest='1'.repeat(64);const binding={exposureId:channel.exposureId,methodRef:{owner:'S8',id:`method:${methodDigest}`,version:'json-field-replace-v1',contentDigest:methodDigest},providerOrigin:'https://staging.provider.example',applicationAccountId:randomUUID(),recordKey:'organization-price-adjustment/'+channel.target.entityId,field:'priceAdjustmentFraction',expectedVersion:'etag-test-1'};const input={obligationRef:obligation.ref,bindings:[binding]};const proposed=await api(f,'compile-request',input,s6Post);assert.equal(proposed.status,200,JSON.stringify(proposed));assert.equal(proposed.body.executionAuthorityGranted,false);assert.equal(proposed.body.status,'REQUEST_PROPOSED_UNADMITTED');const ir=proposed.body.ir;assert.deepEqual(ir.effectRef,obligation.effectRef);assert.deepEqual(ir.consumptionRef,obligation.consumptionRef);assert.deepEqual(ir.members[0].semantic,{exposureId:channel.exposureId,target:channel.target,operation:channel.operation,unit:channel.unit,dose:channel.doses[0],intendedExposure:channel.intendedExposure,permittedRefinements:[]});assert.deepEqual(ir.members[0].request.changes,{priceAdjustmentFraction:channel.doses[0]});const bad=await api(f,'compile-request',{...input,bindings:[{...binding,value:999,operation:'SUPPLIER_SWITCH'}]},s6Post);assert.equal(bad.status,400);const foreign=await api(f,'compile-request',{...input,bindings:[{...binding,exposureId:'foreign-channel'}]},s6Post);assert(foreign.status>=400);const credential=await api(f,'compile-request',{...input,bindings:[{...binding,providerOrigin:'https://secret@staging.provider.example'}]},s6Post);assert(credential.status>=400);return {input,proposed,bad,foreign,credential};});
 await challenge('forged-foreign-and-semantic-substitution',async()=>{assert(obligation);const input={preparationRef:handoff.preparationRef,allocationRef:handoff.allocationRef,consumptionRef:handoff.consumptionRef};for(const changed of [{...input,consumptionRef:{...input.consumptionRef,contentDigest:'0'.repeat(64)}},{...input,operation:'SUPPLIER_SWITCH'}, {...input,preparationRef:{...input.preparationRef,owner:'S5'}}])await assert.rejects(()=>prepareEnterpriseDurableObligation(f.ctx,changed));const foreign={...f.ctx,auth:{...f.ctx.auth,tenantId:randomUUID()}};await assert.rejects(()=>readEnterpriseDurableObligation(foreign,obligation.ref));
  const {claimExternalOperation}=await import('../../packages/tools/src/idempotent-call.js');
  const before=(await admin.query('SELECT count(*)::int n FROM finnor_os.external_operations WHERE tenant_id=$1',[f.tenant])).rows[0].n;
  await assert.rejects(()=>claimExternalOperation(f.tenant,obligation.domainActionId,'unsupported-s6-adapter:'+obligation.effectRef.id,obligation.effectRef.semanticHash,'s6-local-fixture',obligation.effectRef.id),{code:'S6_PROTECTED_EGRESS_ADAPTER_UNADMITTED'});
  assert.equal((await admin.query('SELECT count(*)::int n FROM finnor_os.external_operations WHERE tenant_id=$1',[f.tenant])).rows[0].n,before,'Unsupported adapter created unaccountable child/egress work');
  return {allDenied:true,unsupportedAdapterRefusedBeforeNativeOperation:true};});
 if(process.env.FINNOR_S6_DISPATCH_PROOF==='1')await challenge('protected-dispatch-unknown-recovery-and-native-s5-settlement',async()=>{assert(obligation);return (await import('./governed-dispatch-proof.mjs')).proveGovernedDispatch(f,obligation,api,admin,artifact);});
 if(process.env.FINNOR_S6_DISPATCH_PROOF==='1')await challenge('current-s5-revision-refuses-dispatch-before-credential-access',async()=>{const other=await fixture('s6-revoke-'+randomUUID().slice(0,8),2,[{id:'cash',unit:'USD',capacity:100,totalLimit:100}]),p=await policy(other,'price',{cash:25});await resource(other,'cash','USD','STOCK',['100','100','100']);const allocated=await api(other,'clear',clearing(other,{price:['100']}));assert.equal(allocated.status,200);const selected=await api(other,'handoff',{policyRef:p.ref,allocationRef:allocated.body.certificate.ref,decision:decision(other,allocated.body.certificate.ref)},s4Post);assert.equal(selected.status,200);const prepared=await api(other,'prepare',{preparationRef:selected.body.preparationRef,allocationRef:selected.body.allocationRef,consumptionRef:selected.body.consumptionRef},s6Post);assert.equal(prepared.status,200);return (await import('./governed-dispatch-proof.mjs')).proveGovernedDispatch(other,prepared.body,api,admin,artifact,true);});
 if(process.env.FINNOR_S6_DISPATCH_PROOF==='1')await challenge('protected-recovery-budget-survives-direct-call-and-process-restart',async()=>{const other=await fixture('s6-budget-'+randomUUID().slice(0,8),2,[{id:'cash',unit:'USD',capacity:100,totalLimit:100}]),p=await policy(other,'price',{cash:25});await resource(other,'cash','USD','STOCK',['100','100','100']);const allocated=await api(other,'clear',clearing(other,{price:['100']}));assert.equal(allocated.status,200);const selected=await api(other,'handoff',{policyRef:p.ref,allocationRef:allocated.body.certificate.ref,decision:decision(other,allocated.body.certificate.ref)},s4Post);assert.equal(selected.status,200);const prepared=await api(other,'prepare',{preparationRef:selected.body.preparationRef,allocationRef:selected.body.allocationRef,consumptionRef:selected.body.consumptionRef},s6Post);assert.equal(prepared.status,200);return (await import('./governed-dispatch-proof.mjs')).proveGovernedDispatch(other,prepared.body,api,admin,artifact,false,undefined,true);});
 if(process.env.FINNOR_S6_DISPATCH_PROOF==='1')for(const mode of ['delivery','cancel','crash','stale'] as const)await challenge(`native-durable-workflow-${mode}`,async()=>{const other=await fixture('s6-schedule-'+mode+'-'+randomUUID().slice(0,8),2,[{id:'cash',unit:'USD',capacity:100,totalLimit:100}],{additionalExposure:mode==='crash'}),p=await policy(other,'price',{cash:25});await resource(other,'cash','USD','STOCK',['100','100','100']);const allocated=await api(other,'clear',clearing(other,{price:['100']}));assert.equal(allocated.status,200);assert.equal(allocated.body.status,'FEASIBLE');const selected=await api(other,'handoff',{policyRef:p.ref,allocationRef:allocated.body.certificate.ref,decision:decision(other,allocated.body.certificate.ref)},s4Post);assert.equal(selected.status,200);const prepared=await api(other,'prepare',{preparationRef:selected.body.preparationRef,allocationRef:selected.body.allocationRef,consumptionRef:selected.body.consumptionRef},s6Post);assert.equal(prepared.status,200);return (await import('./governed-dispatch-proof.mjs')).proveGovernedDispatch(other,prepared.body,api,admin,artifact,false,mode);});
 await challenge('immutable-origin-and-revocation-retain-responsibility',async()=>{assert(obligation);let denied='';try{await withTenantTransaction(f.tenant,{userId:f.principal},async(_db,c)=>{await c.query("UPDATE finnor_os.s6_obligation_origins SET body='{}'::jsonb WHERE tenant_id=$1",[f.tenant]);throw Error('UNAUTHORIZED_CHANGE_ALLOWED');});}catch(e){denied=String(e);}assert.match(denied,/append-only/);await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1",[f.principal]);await assert.rejects(()=>readEnterpriseDurableObligation(f.ctx,obligation.ref));await admin.query("UPDATE finnor_os.users SET status='active' WHERE id=$1",[f.principal]);const read=await readEnterpriseDurableObligation(f.ctx,obligation.ref);assert.deepEqual(read.ref,obligation.ref);const current=await validateEnterpriseDurableObligation(f.ctx,obligation.ref);assert.equal(current.executionAuthorityGranted,false);const s5=await api(f,'release',{allocationRef:handoff.allocationRef,idempotencyKey:'premature-s6-release'});assert(s5.status>=400);return {denied,read,current,s5};});
}finally{
 await artifact('authentication-boundary.json',{authenticatedLocal,authDevBypass:process.env.AUTH_DEV_BYPASS,traffic:authTraffic,
  actualBearerHTTP:authenticatedLocal,hostedSupabaseQualification:false,protectedAuthorityCreated:false});
 for(const service of authServices.values())await (await service).close();
 await closePool();await admin.end();
}
if(results.some(r=>r.status!=='PASS'))process.exitCode=1;

/** Authenticated emitted-owner negatives. Ordinary foreign identity setup only;
 * no forged scientific terminal rows or replacement security implementation. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {configureTenantVertical} from '@finnor/db';
import {artifact} from '../x3/environment.mts';
export async function identificationSecurityProofs(f:{
 e:any;evidence:string;tenant:string;people:Record<string,string>;root:any;identificationId:string;view:any;request:any;
 api:(who:string,operation:string,body:unknown)=>Promise<any>;
}){
 const {e,evidence,tenant,identificationId,view,request,api}=f,proofs:any[]=[];
 const before=(await e.admin.query('SELECT experiment_count,observation_count,analysis_count,use_count FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND id=$2',[tenant,identificationId])).rows[0];
 const effects=(await e.admin.query('SELECT count(*)::int n FROM finnor_os.external_operations WHERE tenant_id=$1',[tenant])).rows[0].n;
 const foreignTenant=randomUUID(),foreign=randomUUID(),email=foreign+'@x4.example.test';
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'X4 foreign negative tenant')",[foreignTenant,randomUUID()]);
 await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[foreign,foreignTenant,email]);e.http.register(foreign,email);
 await configureTenantVertical({tenantId:foreignTenant,verticalKey:'private_equity',expectedVersion:0,createdBy:foreign,sourceSystem:'X4:ordinary-negative-input'});
 const token=await e.http.login(foreign);
 const experimentId=view.experiments[0].id;
 for(const [operation,body] of [
  ['read',{identificationId}],['history',{identificationId,limit:25}],['experiment',{identificationId,experimentId}],
  ['list',{root:f.root,workId:view.workId}],
 ] as const){
  const outsider=await api('outsider',operation,body),crossTenant=await e.http.api(token,'company-brain','identification-'+operation,body);
  assert.equal(outsider.status,404,JSON.stringify(outsider));
  if(operation==='list'){
   assert.equal(crossTenant.status,200,JSON.stringify(crossTenant));assert.deepEqual(crossTenant.body,{identifications:[]});
  }else assert.equal(crossTenant.status,404,JSON.stringify(crossTenant));
  assert(!JSON.stringify(outsider.body).includes(identificationId)&&!JSON.stringify(crossTenant.body).includes(identificationId));
  proofs.push({id:'unconsented-principal-and-cross-tenant-'+operation,outsider,crossTenant});
 }
 const malformed=[
  {id:'no-caller-actor-authority',operation:'read',body:{identificationId,principalId:f.people.replicator}},
  {id:'no-caller-mechanism-answer',operation:'submit',body:{...request,idempotencyKey:randomUUID(),mechanism:'snapshot-request'}},
  {id:'physical-experiment-ceiling',operation:'submit',body:{...request,idempotencyKey:randomUUID(),limits:{...request.limits,maxExperiments:65}}},
  {id:'observation-ceiling',operation:'submit',body:{...request,idempotencyKey:randomUUID(),limits:{...request.limits,maxObservationCalls:257}}},
  {id:'original-deadline-ceiling',operation:'submit',body:{...request,idempotencyKey:randomUUID(),limits:{...request.limits,deadlineMs:3600001}}},
  {id:'unsupported-noise-must-not-enter-deterministic-profile',operation:'submit',body:{...request,idempotencyKey:randomUUID(),domain:{...request.domain,assumptions:{...request.domain.assumptions,deterministic:false}}}},
  {id:'unsupported-production-claim',operation:'submit',body:{...request,idempotencyKey:randomUUID(),question:{...request.question,requestedClaimClass:'PRODUCTION_ACTIVE'}}},
 ];
 for(const probe of malformed){const response=await api('author',probe.operation,probe.body);assert.equal(response.status,400,JSON.stringify(response));proofs.push({id:probe.id,response});}
 const conflict=await api('author','submit',{...request,question:{...request.question,text:request.question.text+' Changed under the same invocation key.'}});
 assert.equal(conflict.status,409,JSON.stringify(conflict));assert.equal(conflict.body.code,'X4_IDEMPOTENCY_CONFLICT');proofs.push({id:'changed-payload-original-idempotency-key-conflicts',response:conflict});
 const after=(await e.admin.query('SELECT experiment_count,observation_count,analysis_count,use_count FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND id=$2',[tenant,identificationId])).rows[0];
 assert.deepEqual(after,before);assert.equal((await e.admin.query('SELECT count(*)::int n FROM finnor_os.external_operations WHERE tenant_id=$1',[tenant])).rows[0].n,effects);
 await artifact(evidence,'authenticated-security-proofs.json',{schema:'finnor.x4.authenticated-security-proof.v1',allPassed:true,proofs,before,after,effectsBefore:effects,effectsAfter:effects,
  authBypass:false,transport:'ACTUAL_BUILT_NEXT_API',foreignIdentities:'ORDINARY_DISPOSABLE_SETUP_ONLY',terminalRowsInserted:0,protectedQualification:false});
}

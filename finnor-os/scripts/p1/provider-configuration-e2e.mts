import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tx} from '../../packages/private-equity/src/evidence-execution/store';

/** Admission must refuse impossible configured routes before taking Work or
 * compute ownership. A syntactically configured route is not provider proof. */
export async function providerConfigurationE2E(e:any){
 const {api,request,root,ctx,admin,tenant,evidence}=e;
 const names=['FINNOR_P1_EXECUTOR','DAYTONA_API_KEY','DAYTONA_API_URL','FINNOR_DAYTONA_PROFILE'];
 const saved=Object.fromEntries(names.map(n=>[n,process.env[n]])),proof:any[]=[];
 const counts=async()=>(await admin.query(`SELECT
  (SELECT count(*)::int FROM finnor_os.works WHERE tenant_id=$1) works,
  (SELECT count(*)::int FROM finnor_os.p1_requests WHERE tenant_id=$1) programs,
  (SELECT count(*)::int FROM finnor_os.jobs WHERE tenant_id=$1) jobs`,[tenant])).rows[0];
 const variants=[
  {name:'credential',env:{FINNOR_P1_EXECUTOR:'daytona'},reason:'DAYTONA_CREDENTIAL_UNAVAILABLE'},
  {name:'endpoint',env:{FINNOR_P1_EXECUTOR:'daytona',DAYTONA_API_KEY:'disposable-no-provider-call',DAYTONA_API_URL:'http://unsafe.invalid'},reason:'DAYTONA_ENDPOINT_INVALID'},
  {name:'profile-missing',env:{FINNOR_P1_EXECUTOR:'daytona',DAYTONA_API_KEY:'disposable-no-provider-call'},reason:'DAYTONA_PINNED_PROFILE_REQUIRED'},
  {name:'profile-invalid',env:{FINNOR_P1_EXECUTOR:'daytona',DAYTONA_API_KEY:'disposable-no-provider-call',FINNOR_DAYTONA_PROFILE:'{}'},reason:'DAYTONA_PINNED_PROFILE_INVALID'},
  {name:'unknown-backend',env:{FINNOR_P1_EXECUTOR:'unknown'},reason:'P1_EXECUTOR_BACKEND_UNAVAILABLE'},
 ];
 try{
  for(const n of names)delete process.env[n];process.env.FINNOR_P1_EXECUTOR='local';
  const acceptedBody=request(),accepted=await api('program-submit',acceptedBody);assert.equal(accepted.status,202,JSON.stringify(accepted));
  const mutation=await tx(ctx,async c=>{
   const identity=(await c.query('SELECT current_user')).rows[0];assert.equal(identity.current_user,'finnor_app');
   await c.query("UPDATE finnor_os.p1_requests SET proposed=jsonb_set(proposed,'{executionBinding,backend}','\"daytona\"'::jsonb) WHERE tenant_id=$1 AND id=$2",[tenant,accepted.body.programId]);
  }).then(()=>null,(error:any)=>({code:error.code,message:error.message}));
  assert.equal(mutation?.code,'P0001');assert.match(mutation.message,/P1 admitted programme custody is immutable/);proof.push({name:'ordinary-role-cannot-rewrite-executor-binding',mutation});
  process.env.FINNOR_P1_EXECUTOR='daytona';
  const replayBefore=await counts(),replayed=await api('program-submit',acceptedBody),replayAfter=await counts();
  proof.push({name:'accepted-work-replay-after-configuration-loss',accepted,replayed,before:replayBefore,after:replayAfter});await writeFile(join(evidence,'provider-configuration-proof.json'),JSON.stringify({proof,hostedProviderQualified:false},null,2));
  assert.equal(replayed.status,202,JSON.stringify(replayed));assert.equal(replayed.body.programId,accepted.body.programId);assert.equal(replayed.body.replayed,true);assert.deepEqual(replayAfter,replayBefore);
  for(const variant of variants){
   for(const n of names)delete process.env[n];Object.assign(process.env,variant.env);
   const before=await counts(),ports=await api('program-ports',{root:root('A')}),submitted=await api('program-submit',request()),after=await counts();
   proof.push({name:variant.name,ports,submitted,before,after});await writeFile(join(evidence,'provider-configuration-proof.json'),JSON.stringify({proof,hostedProviderQualified:false},null,2));
   assert.equal(submitted.status,422,JSON.stringify(proof.at(-1)));assert.equal(submitted.body.predicate,variant.reason);
   assert.equal(ports.status,200);assert.equal(ports.body.runtime.mode,'production_analysis');
   assert.equal(ports.body.programExecution.configurationReady,false);assert.equal(ports.body.programExecution.reason,variant.reason);
   assert.deepEqual(after,before,'Invalid provider cannot take new Work or queue ownership');
   assert(!JSON.stringify(ports.body).includes('disposable-no-provider-call'));
  }
  for(const n of names)delete process.env[n];
  const local=await api('program-ports',{root:root('A')});assert.equal(local.body.programExecution.backend,'local');assert.equal(local.body.programExecution.configurationReady,true);proof.push({name:'local',ports:local});
  Object.assign(process.env,{FINNOR_P1_EXECUTOR:'daytona',DAYTONA_API_KEY:'disposable-no-provider-call',FINNOR_DAYTONA_PROFILE:JSON.stringify({snapshotId:randomUUID(),image:'fixture@sha256:'+'a'.repeat(64),target:'fixture',user:'analysis',nodeBinary:'/usr/bin/node',nodeDigest:'b'.repeat(64)})});
  const configured=await api('program-ports',{root:root('A')});assert.equal(configured.body.programExecution.configurationReady,true);assert.equal(configured.body.programExecution.providerQualification,'UNVERIFIED');assert(!JSON.stringify(configured.body).includes('fixture@sha256'));proof.push({name:'daytona-syntax-only',ports:configured});
  await writeFile(join(evidence,'provider-configuration-proof.json'),JSON.stringify({proof,hostedProviderQualified:false},null,2));return proof;
 }finally{for(const n of names)if(saved[n]===undefined)delete process.env[n];else process.env[n]=saved[n];}
}

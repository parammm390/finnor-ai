/** Preregistered F1/G1/E1 boundary episodes. This is an E2E driver, never a
 * replacement authorizer, queue, compiler, MPC engine or Work proof writer. */
import {strict as assert} from 'node:assert';
import {randomUUID,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {isAbsolute,join,resolve} from 'node:path';
import pg from 'pg';
import {configureTenantVertical,receiveWork,closePool} from '@finnor/db';
import {startEnvironment,artifact} from './environment.mjs';
import {lifecycleEpisode} from './product-lifecycle.mjs';
import {participantState} from './recovery-episode.mjs';

const args=process.argv.slice(2),option=(key:string)=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
process.umask(0o077);
const evidence=option('--evidence'),caseName=option('--case')??'lifecycle';
if(!args.includes('--evidence')||!evidence||!isAbsolute(evidence))throw Error('Y4_NEW_ABSOLUTE_EVIDENCE_DIRECTORY_REQUIRED');
await mkdir(evidence,{recursive:false,mode:0o700});
const privateDirectory=join(evidence,'PRIVATE-NOT-FOR-HANDOFF');await mkdir(privateDirectory,{mode:0o700});
const start=performance.now(),results:Array<Record<string,unknown>>=[];
let environment:Awaited<ReturnType<typeof startEnvironment>>|undefined;
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const driverInputs=await Promise.all(['product-episode.mts','product-lifecycle.mts','product-transport.mts',
 'environment.mts','installation.mts','browser-episode.mts','owner-episode.mts','s8-episode.mts',
 'recovery-episode.mts','effect-episode.mts','owner-adversarial-episode.mts','browser-e2e.ts','product-e2e.ts'].map(async name=>{
 const bytes=await readFile(join(import.meta.dirname,name));
 await mkdir(join(evidence,'episode-driver-source'),{recursive:true,mode:0o700});
 await writeFile(join(evidence,'episode-driver-source',name),bytes,{flag:'wx',mode:0o600});
 return {path:'finnor-os/scripts/y4/'+name,bytes:bytes.length,sha256:digest(bytes)};
}));
await artifact(evidence,'episode-driver-custody.json',{schema:'finnor.y4.product-driver-custody.v1',
 sourceCut:driverInputs,capturedBeforeEnvironmentAndExposure:true,privateRecordsIncluded:false});
async function record(id:string,predicate:string,run:()=>Promise<unknown>){
 const at=performance.now();
 try{results.push({id,predicate,status:'PASS',observed:await run(),wallMs:performance.now()-at});}
 catch(error){
  const code=String((error as any)?.code??'Y4_PRODUCT_PREDICATE_UNPASSED').replace(/[^A-Z0-9_]/g,'').slice(0,100);
  results.push({id,predicate,status:'FAIL',code,wallMs:performance.now()-at});
  // No inputs, output openings, tokens or connection strings in shared evidence.
  await writeFile(join(privateDirectory,'failure-'+id+'.json'),JSON.stringify({
   name:(error as Error).name,code,stack:String((error as Error).stack??'').replace(/postgres(?:ql)?:\/\/[^\s)]+/g,'[DATABASE_URL_REDACTED]'),
  },null,2)+'\n');
  throw error;
 }finally{await save();}
}
async function save(){
 await artifact(evidence!,'result.json',{schema:'finnor.y4.product-e2e.v1',case:caseName,
  status:results.some(r=>r.status==='FAIL')?'FAIL':results.length?'PASS':'NOT_RUN',
  results,wallMs:performance.now()-start,productionActive:false,protectedAdmission:false,
  separatelyAdministered:false,realEffects:false,moneyUSD:null,humanSeconds:null,
  driverInputs,
  omitted:['participant_inputs','private_output_values','opening_nonces','keys','credentials','private_native_logs']});
}
async function expectRefusal(client:pg.Client,sql:string,parameters:unknown[],codes:string[]){
 let refusal:string|undefined;
 try{await client.query(sql,parameters);}catch(error){refusal=String((error as any).code);}
 assert(refusal&&codes.includes(refusal),'Y4_EXPECTED_DURABLE_REFUSAL');
 return refusal;
}
async function storageEpisode(e:NonNullable<typeof environment>){
 const tenant=randomUUID(),actor=randomUUID(),other=randomUUID(),foreignTenant=randomUUID(),foreignActor=randomUUID();
 await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Y4 disposable storage'),($3,$4,'Y4 foreign storage')",
  [tenant,randomUUID(),foreignTenant,randomUUID()]);
 for(const [id,t] of [[actor,tenant],[other,tenant],[foreignActor,foreignTenant]])await e.admin.query(
  "INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','Y4 disposable')",
  [id,t,id+'@test.invalid']);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:actor,sourceSystem:'Y4:disposable-storage'});
 const intake=await receiveWork({tenantId:tenant,userId:actor,instruction:'Y4 storage constraint fixture, not an accepted function',
  channel:'console',idempotencyKey:randomUUID()});
 const app=new pg.Client({connectionString:e.appUrl});await app.connect();
 const as=async(t:string,u:string)=>{await app.query("SELECT set_config('app.tenant_id',$1,false),set_config('app.user_id',$2,false)",[t,u]);};
 const id=randomUUID(),cap=1048576;
 try{
  await as(tenant,actor);
  await app.query(`INSERT INTO finnor_os.y4_computations(tenant_id,id,principal_id,root_type,root_id,
   work_id,work_input_id,work_input_digest,request,request_digest,environment,deadline_at,max_attempts,idempotency_key)
   VALUES($1,$2,$3,'external_organization',$4,$5,$6,$7,$8::jsonb,$7,'{}',clock_timestamp()+interval '20 minutes',2,$9)`,
  [tenant,id,actor,randomUUID(),intake.workId,intake.workInputId,'0'.repeat(64),
   JSON.stringify({limits:{maxCpuSeconds:4,maxRetainedBytes:cap}}),randomUUID()]);
  const before=(await app.query('SELECT data_bytes,cpu_reserved_seconds FROM finnor_os.y4_computations WHERE id=$1',[id])).rows[0];
  assert(Number(before.data_bytes)>0);
  const deadline=await expectRefusal(app,"UPDATE finnor_os.y4_computations SET deadline_at=deadline_at+interval '1 second' WHERE id=$1",[id],['P0001']);
  const cpuRaised=await expectRefusal(app,"UPDATE finnor_os.y4_computations SET request=jsonb_set(request,'{limits,maxCpuSeconds}','5') WHERE id=$1",[id],['P0001']);
  await app.query('UPDATE finnor_os.y4_computations SET cpu_reserved_seconds=4 WHERE id=$1',[id]);
  const cpuRefund=await expectRefusal(app,'UPDATE finnor_os.y4_computations SET cpu_reserved_seconds=0 WHERE id=$1',[id],['P0001']);
  const cpuOver=await expectRefusal(app,'UPDATE finnor_os.y4_computations SET cpu_reserved_seconds=5 WHERE id=$1',[id],['23514']);
  const bytesRefund=await expectRefusal(app,'UPDATE finnor_os.y4_computations SET data_bytes=0 WHERE id=$1',[id],['P0001']);
  const bytesBefore=Number((await app.query('SELECT data_bytes FROM finnor_os.y4_computations WHERE id=$1',[id])).rows[0].data_bytes);
  const oversized=await expectRefusal(app,`INSERT INTO finnor_os.y4_events(tenant_id,computation_id,actor_id,kind,idempotency_key,body)
   VALUES($1,$2,$3,'STORAGE_PROBE',$4,$5::jsonb)`,[tenant,id,actor,randomUUID(),JSON.stringify({probe:'x'.repeat(cap)})],['23514','54000']);
  assert.equal(Number((await app.query('SELECT data_bytes FROM finnor_os.y4_computations WHERE id=$1',[id])).rows[0].data_bytes),bytesBefore);
  // DDL-only malformed parent has no actual function/source handles. Seed its
  // inert recipient row as administrator, never weaken the production writer.
  await e.admin.query("INSERT INTO finnor_os.y4_consents(tenant_id,computation_id,participant_id,principal_id,body,body_digest) VALUES($1,$2,'p0',$3,'{}',$4)",
   [tenant,id,actor,'0'.repeat(64)]);
  const release=randomUUID();
  await app.query("INSERT INTO finnor_os.y4_releases(tenant_id,id,computation_id,participant_id,principal_id,body,body_digest) VALUES($1,$2,$3,'p0',$4,'{}',$5)",
   [tenant,release,id,actor,'0'.repeat(64)]);
  assert.equal((await app.query('SELECT 1 FROM finnor_os.y4_releases WHERE id=$1',[release])).rowCount,1);
  await as(tenant,other);assert.equal((await app.query('SELECT 1 FROM finnor_os.y4_releases WHERE id=$1',[release])).rowCount,0);
  const foreignUpdate=await expectRefusal(app,"UPDATE finnor_os.y4_computations SET status='CANCELLED' WHERE id=$1",[id],['42501']);
  const forgedRevocation=await expectRefusal(app,`INSERT INTO finnor_os.y4_revocations
   (tenant_id,computation_id,participant_id,principal_id,body) VALUES($1,$2,'p0',$3,'{}')`,
  [tenant,id,other],['42501']);
  const forgedConsent=await expectRefusal(app,`INSERT INTO finnor_os.y4_consents
   (tenant_id,computation_id,participant_id,principal_id,body,body_digest) VALUES($1,$2,'p1',$3,'{}',$4)`,
  [tenant,id,actor,'0'.repeat(64)],['42501']);
  await as(foreignTenant,foreignActor);assert.equal((await app.query('SELECT 1 FROM finnor_os.y4_computations WHERE id=$1',[id])).rowCount,0);
  const roles=(await e.admin.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor_app','finnor_worker') ORDER BY rolname")).rows;
  assert(roles.every(r=>!r.rolsuper&&!r.rolbypassrls));
  return {schemaFixtureOnly:true,notAnAcceptedComputation:true,roles,immutableDeadline:deadline,immutableCpuGrant:cpuRaised,
   monotonicCpu:cpuRefund,cpuCeiling:cpuOver,monotonicRetainedBytes:bytesRefund,retainedCeiling:oversized,
   foreignTenantDenied:true,nonrecipientDenied:true,foreignUpdate,forgedRevocation,forgedConsent,
   schemaFixtureConsentSeededByAdmin:true,failedInsertDidNotRefundOrChargeUncommittedBytes:true};
 }finally{await app.end();}
}
try{
 environment=await startEnvironment(evidence,{migrationsOnly:true});
 await record('migration-upgrade-replay','all named migrations apply, prior rows survive and exact replay is empty',async()=>{
  const receipt=JSON.parse(await readFile(join(evidence,'migration-upgrade-replay.json'),'utf8'));
  assert.equal(receipt.allPassed,true);assert.deepEqual(receipt.replay,[]);
  assert(receipt.upgrade.includes('postx_y4_confidential_economic_computation.sql'));
  assert(receipt.upgrade.includes('postx_y4_confidential_owner_consumption.sql'));
  return {migrations:receipt.files.length,replay:receipt.replay,retainedPriorJobUnchanged:true,
   namespacedMigrationDigest:receipt.files.find((f:any)=>f.name==='postx_y4_confidential_economic_computation.sql').sha256};
 });
 await record('ordinary-role-durable-guards','RLS, original grants, monotonic counters and retained-byte ceilings hold under actual ordinary SQL role',
  ()=>storageEpisode(environment!));
 if(['lifecycle','authority','effect-preservation','owner-context','cancellation-disposal','owner-commit-race'].includes(caseName))await lifecycleEpisode(environment,evidence,caseName,record);
 else if(caseName==='recovery'){
  const crashed=await lifecycleEpisode(environment,evidence,'recovery',record);assert(crashed&&'recovery' in crashed);
  const originalRecovery=crashed.recovery;
  const freshDirectory=join(evidence,'fresh-authorized');
  await mkdir(freshDirectory,{mode:0o700});await mkdir(join(freshDirectory,'PRIVATE-NOT-FOR-HANDOFF'),{mode:0o700});
  const fresh=await lifecycleEpisode(environment,freshDirectory,'fresh-authorized',
   (id,predicate,run)=>record('fresh-'+id,predicate,run),crashed.owners);
  await record('fresh-separately-authorized-native-calculation',
   'new original Core records, Work, consents, allocation and cryptographic session succeed without resetting the same participants old disclosure ledger or crashed computation',
   async()=>{
    assert(fresh);assert.notEqual(fresh.computationId,crashed.computationId);assert.notEqual(fresh.workId,crashed.workId);
    assert.notEqual(fresh.sessionId,crashed.sessionId);assert.deepEqual(fresh.owners.institutions,crashed.owners.institutions);
    assert.deepEqual(fresh.owners.principals,crashed.owners.principals);assert.deepEqual(fresh.owners.states,crashed.owners.states);
    assert(fresh.sourceIds.every(id=>!crashed.sourceIds.includes(id)));
    const old=(await environment!.admin.query(`SELECT id,status,generation,attempt_count,cpu_reserved_seconds,deadline_at,session,runtime_receipt
     FROM finnor_os.y4_computations WHERE tenant_id=$1 AND id=$2`,[crashed.owners.tenant,crashed.computationId])).rows[0];
    assert.deepEqual(old,originalRecovery.retained);
    const disclosures=(await environment!.admin.query(`SELECT institution_id,source_key,computation_id FROM finnor_os.y4_disclosures
     WHERE tenant_id=$1 AND computation_id=$2 ORDER BY institution_id,source_key`,[crashed.owners.tenant,crashed.computationId])).rows;
    assert.deepEqual(disclosures,originalRecovery.originalDisclosures);
    const originalLocal=await participantState(crashed.owners.states,crashed.sessionId);
    assert(originalLocal.every(p=>p.state==='ABORTED'&&p.secretsBurned&&p.nonceBurned&&p.disclosures===2));
    const summary={sameInstitutionPrincipalAndDisclosureLedgers:true,newActualCoreOriginals:true,newExplicitConsents:true,
     newWorkAndAllocation:true,newCryptographicSession:true,freshNativeResultVerified:true,
     crashedComputationAndOriginalFailedCostsUnchanged:true,originalDisclosuresStillCharged:3,
     absoluteDeadlineNotExtended:true,automaticRetry:false,protectedAdmission:false};
    await artifact(evidence,'fresh-authorization.json',{schema:'finnor.y4.fresh-authorized-recovery-e2e.v1',summary});
    return summary;
   });
 }
 else if(caseName!=='migration')throw Object.assign(Error('Y4_PRODUCT_CASE_NOT_IMPLEMENTED'),{code:'Y4_PRODUCT_CASE_NOT_IMPLEMENTED'});
}catch(error){
 await writeFile(join(privateDirectory,'setup-or-episode-failure.json'),JSON.stringify({
  name:(error as Error).name,code:String((error as any)?.code??'Y4_DISPOSABLE_SETUP_FAILED'),
  stack:String((error as Error).stack??'').replace(/postgres(?:ql)?:\/\/[^\s)]+/g,'[DATABASE_URL_REDACTED]'),
 },null,2)+'\n');
 if(!results.some(r=>r.status==='FAIL'))results.push({id:'setup-or-unimplemented',status:'FAIL',code:
  String((error as any)?.code??'Y4_DISPOSABLE_SETUP_FAILED').replace(/[^A-Z0-9_]/g,'').slice(0,100)});
 process.exitCode=1;
}finally{
 await environment?.close();await closePool();await save();
}
console.log(JSON.stringify({evidence,case:caseName,passed:results.filter(r=>r.status==='PASS').length,
 failed:results.filter(r=>r.status==='FAIL').length,privateRecordsOmitted:true}));
// The dependency's beforeExit hook otherwise forces exit(0).
process.exit(results.some(r=>r.status==='FAIL')?1:0);

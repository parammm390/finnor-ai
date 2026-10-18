import {fork} from 'node:child_process';
import {resolve} from 'node:path';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,ComputeCapacityUnavailableError,type ComputeResourceLease} from '@finnor/db';
import type {EnterpriseApplicationRelease} from '@finnor/shared-types';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {applicationDigest,applicationCanonical,validateValuesAgainstModel,ApplicationFault} from './contracts';
import {validateProgram,type BuiltApplication} from './compiler';
import type {ApplicationCheck} from './checker';
import {currentApplicationEnvironment,applicationSourceRoot,X3_MIGRATION_HEAD,type ApplicationEnvironment} from './source-cut';
import {applicationTx,releaseTx,recordSnapshot,recordSetDigest,valueSetsFactsTx,assertAllocation,authorityTx,workCutTx,eventTx,enqueueBuildTx,tx,fail,newId,type ApplicationRow,type BuildRow,type RecordRow,type ReleaseBody} from './store';
const Payload=z.object({tenantId:z.string().uuid(),principalId:z.string().uuid(),applicationId:z.string().uuid(),buildId:z.string().uuid(),generation:z.number().int().positive(),stage:z.enum(['BUILD','INSTALL'])}).strict();
type Payload=z.infer<typeof Payload>;
interface ChildResult{ok:boolean;error?:string;built?:BuiltApplication;check?:ApplicationCheck;resources:{wallMs:number;cpuMicros:number;peakProcessRSSBytes:number;pid:number}}
async function physical(c:PoolClient,e:Readonly<JobExecutionContext>,p:Payload){
 const row=await c.query(`SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id
  WHERE j.id=$1 AND j.tenant_id=$2 AND j.type='build_enterprise_application_v1' AND j.status='running'
   AND j.claim_token=$3 AND j.claim_fence=$4 AND j.lease_expires_at>clock_timestamp()
   AND d.id=$5 AND d.claim_token=j.claim_token AND d.claim_fence=j.claim_fence AND d.outcome='running'
   AND j.payload=$6::jsonb FOR SHARE OF j,d`,[e.jobId,p.tenantId,e.claimToken,e.claimFence,e.deliveryAttemptId,JSON.stringify(p)]);
 if(row.rowCount!==1)fail('APPLICATION_PHYSICAL_DELIVERY_FENCE');
}
async function owned(ctx:PeMutationContext,c:PoolClient,p:Payload,e:Readonly<JobExecutionContext>){
 const a=await applicationTx(ctx,c,p.applicationId,'action:synthesize_enterprise_application');
 await physical(c,e,p);
 const b=(await c.query<BuildRow>('SELECT * FROM finnor_os.x3_builds WHERE tenant_id=$1 AND application_id=$2 AND id=$3 FOR UPDATE',[p.tenantId,a.id,p.buildId])).rows[0];
 if(!b||a.owner_id!==p.principalId||b.generation!==p.generation)fail('APPLICATION_JOB_DOMAIN_MISMATCH');
 if(a.status==='CANCELLED'||a.generation!==p.generation||['CANCELLED','INVALIDATED','INSTALLED','FAILED'].includes(b.status))return null;
 assertAllocation(a);
 const work=await workCutTx(c,a);
 if(work.id!==b.work_input_id||work.digest!==b.work_input_digest)fail('APPLICATION_WORK_CHANGED');
 if(a.head_release_id!==b.base_release_id)fail('APPLICATION_INSTALL_BASE_CHANGED');
 return {a,b};
}
async function childBuild(spec:BuildRow['specification'],deadline:number,stillCurrent:()=>Promise<boolean>){
 const root=await applicationSourceRoot();
 return new Promise<ChildResult>((yes,no)=>{
  const child=fork(resolve(root,'finnor-os/packages/private-equity/src/enterprise-applications/build-child.mts'),[],{
   cwd:resolve(root,'finnor-os'),execPath:process.execPath,execArgv:['--import=tsx','--max-old-space-size=256'],
   env:{PATH:process.env.PATH,NODE_ENV:process.env.NODE_ENV??'production',TZ:'UTC'},serialization:'json',stdio:['ignore','pipe','pipe','ipc'],
  });
  let result:ChildResult|undefined,reason:string|undefined,bytes=0,checking=false,finished=false;
  const kill=(code:string)=>{reason??=code;child.kill('SIGKILL');};
  const timer=setTimeout(()=>kill('APPLICATION_BUILD_HARD_DEADLINE'),Math.max(1,Math.min(30000,deadline-Date.now())));
  const monitor=setInterval(()=>{
   if(checking)return;checking=true;
   void stillCurrent().then(v=>{if(!v)kill('APPLICATION_BUILD_CANCELLED_OR_FENCED');}).catch(()=>kill('APPLICATION_BUILD_CURRENTNESS_UNAVAILABLE')).finally(()=>checking=false);
  },250);
  child.stdout!.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>16384)kill('APPLICATION_CHILD_OUTPUT_BOUND');});
  child.stderr!.on('data',(b:Buffer)=>{bytes+=b.length;if(bytes>16384)kill('APPLICATION_CHILD_OUTPUT_BOUND');});
  child.once('message',(message:unknown)=>{
   try{
    if(Buffer.byteLength(JSON.stringify(message))>8*1024*1024)kill('APPLICATION_BUILD_OUTPUT_BOUND');
    else result=message as ChildResult;
   }catch{kill('APPLICATION_BUILD_OUTPUT_INVALID');}
  });
  const finish=()=>{clearTimeout(timer);clearInterval(monitor);finished=true;};
  child.once('error',error=>{finish();no(error);});
  child.once('exit',()=>{
   if(finished)return;finish();
   if(reason||!result)no(new ApplicationFault(reason??'APPLICATION_BUILD_CHILD_EXIT','Physical compiler did not produce an accepted bounded result'));
   else yes(result);
  });
  child.send(spec);
 });
}
function packageFor(a:ApplicationRow,b:BuildRow,built:BuiltApplication,check:ApplicationCheck,environment:ApplicationEnvironment,e:Readonly<JobExecutionContext>,leases:ComputeResourceLease[],resources:ChildResult['resources'],authorityRevision:number,id:string,parent:ReleaseBody|null):EnterpriseApplicationRelease{
 return {schema:'finnor.enterprise-application-package.v1',id,applicationId:a.id,tenantId:a.tenant_id,principalId:a.owner_id,
  rights:{revision:authorityRevision,ref:'canonical-authority:'+a.tenant_id+':'+authorityRevision,evaluatedAt:new Date().toISOString()},
  work:{id:a.work_id,revision:b.work_input_id,inputDigest:b.work_input_digest},mandate:null,
  parents:parent?[{owner:'X3',id:parent.package.id,revision:String(parent.package.maintenance.generation),contentDigest:applicationDigest(parent,16*1024*1024)}]:[],
  inputsDigest:b.specification_digest,code:{version:'x3-stack-v1',sourceDigest:environment.sourceDigest,checkerDigest:environment.checkerDigest,schemaDigest:environment.schemaDigest},
  runtime:{node:environment.node,platform:environment.platform,architecture:environment.architecture,imageDigest:null,sourceDigest:environment.sourceDigest,lockDigest:environment.lockDigest,jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,workerId:e.workerId},
  validity:{profile:'PE_FIRM_TYPED_APPLICATION_V1',root:{entityType:a.root_type,entityId:a.root_id},validAfter:new Date().toISOString(),validUntil:a.deadline_at.toISOString(),production:false},
  resources:{allocationId:a.id,originalDeadlineAt:a.deadline_at.toISOString(),buildAttempts:a.build_count,wallMs:resources.wallMs,cpuMicros:resources.cpuMicros,peakProcessRSSBytes:resources.peakProcessRSSBytes,aggregatePeakRSSBytes:null,inputBytes:Buffer.byteLength(applicationCanonical(b.specification)),outputBytes:Buffer.byteLength(applicationCanonical(built)),usd:null,humanEffort:null,status:'LOCAL_COST_PARTIALLY_METERED'},
  proofs:{method:check.methods.join('+'),digest:applicationDigest(check),caseIds:check.caseIds,criticalRequirements:check.criticalRequirements,protectedCustody:false},
  admission:null,status:'STAGED',limitations:['DEVELOPMENT_NOT_PROTECTED_CUSTODY','X1_X2_COMPATIBILITY_UNESTABLISHED','NO_PRODUCTION_ACTIVATION','NO_DOCKER_ARM64_IMAGE_PROOF','NO_AGGREGATE_OR_FINANCIAL_COST_METER'],
  specification:{owner:'X3',id:b.id,revision:String(b.generation),contentDigest:b.specification_digest},
  sourceFiles:built.sources.map(s=>({path:s.path,digest:s.digest,bytes:Buffer.byteLength(s.bytes),language:s.language})),
  backend:{format:'X3_TYPED_STACK_V1',digest:applicationDigest(built.program),entrypoint:'application-command'},
  frontend:{format:'FINNOR_HOST_TYPED_FORMS_V1',digest:applicationDigest(built.frontend),entrypoint:'WORK_ENTERPRISE_APPLICATION'},
  database:{owner:'@finnor/db',migrationHead:X3_MIGRATION_HEAD,schemaDigest:environment.schemaDigest,dataPreservation:'TRANSACTIONAL_VALIDATE_AND_RETAIN_ORIGINAL'},
  dependencies:{manifestDigest:applicationDigest(built.dependencyManifest),hostContracts:[...built.dependencyManifest.hostContracts],guestDependencies:[]},
  deployment:{mode:'ORDINARY_DEVELOPMENT',api:'NEXT_ROUTE_HANDLER',worker:'DURABLE_JOB_V1',productionActive:false},
  maintenance:{generation:b.generation,priorReleaseId:b.base_release_id,changeClass:b.change_class,rollback:'VALIDATE_REAL_DATA_AND_OUTSTANDING_OBLIGATIONS'},
 };
}
export async function buildEnterpriseApplicationJob(raw:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 const p=Payload.parse(raw);
 if(!execution||execution.tenantId!==p.tenantId||execution.protocolVersion!==1)fail('APPLICATION_PHYSICAL_EXECUTION_REQUIRED');
 const e=execution,ctx:PeMutationContext={auth:{tenantId:p.tenantId,userId:p.principalId,employeeId:p.principalId,role:'owner'}};
 let leases:ComputeResourceLease[]=[];
 try{
  if(process.env.FINNOR_ENVIRONMENT==='production'||process.env.NODE_ENV==='production'&&!['development','ordinary_disposable'].includes(process.env.FINNOR_ENVIRONMENT??''))fail('APPLICATION_PRODUCTION_UNADMITTED','X3 production activation is a separate independent gate',403);
  const environment=await currentApplicationEnvironment();
  const current=await tx(ctx,c=>owned(ctx,c,p,e));if(!current)return;
  if(applicationDigest(environment)!==applicationDigest(current.b.environment))fail('APPLICATION_DEPENDENCY_OR_DEPLOYMENT_CHANGED');
  leases=await acquireComputeResourceLeases({tenantId:p.tenantId,resourceKeys:['native:x3-build'],requiredResourceKeys:['native:x3-build'],workloadClass:'INTERACTIVE',ownerId:'x3:'+e.deliveryAttemptId});
  const heartbeat=async()=>{
   if(!await renewComputeResourceLeases(leases))return false;
   return tx(ctx,async c=>!!await owned(ctx,c,p,e));
  };
  e.registerHeartbeat(heartbeat);
  if(p.stage==='BUILD'){
   if(current.b.status==='STAGED'){await tx(ctx,async c=>{const s=await owned(ctx,c,p,e);if(s)await enqueueBuildTx(c,s.a,s.b,'INSTALL');});return;}
   const started=await tx(ctx,async c=>{
    const s=await owned(ctx,c,p,e);if(!s)return null;
    if(s.a.build_count>=s.a.max_builds||s.a.release_count>=8)fail('ORIGINAL_APPLICATION_BUILD_BOUND');
    await c.query("UPDATE finnor_os.x3_applications SET status='BUILDING',build_count=build_count+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[p.tenantId,p.applicationId]);
    await c.query("UPDATE finnor_os.x3_builds SET status='BUILDING',attempt_count=attempt_count+1,active_delivery_id=$3,active_claim_token=$4,active_claim_fence=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[p.tenantId,p.buildId,e.deliveryAttemptId,e.claimToken,e.claimFence]);
    s.a.build_count++;s.b.attempt_count++;
    await eventTx(c,s.a,p.principalId,'BUILD_STARTED','build-start:'+e.deliveryAttemptId,applicationDigest(p),{jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,attempt:s.b.attempt_count,deadlineAt:s.a.deadline_at.toISOString(),leases:leases.map(({token:_,...receipt})=>receipt)},null,p.buildId);
    return s;
   });if(!started)return;
   const result=await childBuild(started.b.specification,started.a.deadline_at.getTime(),heartbeat);
   await tx(ctx,async c=>{
    const s=await owned(ctx,c,p,e);if(!s)return;
    await eventTx(c,s.a,p.principalId,'BUILD_METRICS','build-metrics:'+e.deliveryAttemptId,applicationDigest(p),{...result.resources,check:result.check??null,error:result.error??null,possibleUnknownEarlierAttempts:s.b.attempt_count-1,aggregatePeakRSSBytes:null,usd:null},null,p.buildId);
   });
   if(!result.ok||!result.built||result.check?.status!=='PASS')fail(result.error??'INDEPENDENT_APPLICATION_CHECK_FAILED');
   validateProgram(result.built.program);
   const after=await currentApplicationEnvironment();if(applicationDigest(after)!==applicationDigest(environment))fail('APPLICATION_SOURCE_CHANGED_DURING_BUILD');
   if(!await renewComputeResourceLeases(leases))fail('APPLICATION_COMPUTE_LEASE_LOST');
   await tx(ctx,async c=>{
    const s=await owned(ctx,c,p,e);if(!s)return;
    const authority=await authorityTx(ctx,c,s.a),releaseId=newId(),parent=s.b.base_release_id?await releaseTx(c,s.a,s.b.base_release_id):null;
    const body:ReleaseBody={package:packageFor(s.a,s.b,result.built!,result.check!,environment,e,leases,result.resources,Number(authority.authorityRevision),releaseId,parent),
     built:result.built!,check:result.check!,specification:s.b.specification,environment,migration:s.b.migration};
    await c.query('INSERT INTO finnor_os.x3_releases(tenant_id,id,application_id,build_id,body,body_digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[p.tenantId,releaseId,p.applicationId,p.buildId,JSON.stringify(body),applicationDigest(body,16*1024*1024)]);
    await c.query("UPDATE finnor_os.x3_builds SET status='STAGED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[p.tenantId,p.buildId]);
    await c.query("UPDATE finnor_os.x3_applications SET status='INSTALLING',release_count=release_count+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[p.tenantId,p.applicationId]);
    await eventTx(c,s.a,p.principalId,'RELEASE_STAGED','staged:'+p.buildId,applicationDigest(p),{releaseId,bodyDigest:applicationDigest(body,16*1024*1024),checkDigest:applicationDigest(result.check)},null,p.buildId);
    await enqueueBuildTx(c,s.a,s.b,'INSTALL');
   });
  }else{
   await tx(ctx,async c=>{
    const s=await owned(ctx,c,p,e);if(!s)return;
    if(s.b.status!=='STAGED')fail('APPLICATION_NOT_STAGED');
    const row=(await c.query<{id:string;body:ReleaseBody;body_digest:string}>('SELECT id,body,body_digest FROM finnor_os.x3_releases WHERE tenant_id=$1 AND application_id=$2 AND build_id=$3',[p.tenantId,p.applicationId,p.buildId])).rows[0];
    if(!row||applicationDigest(row.body,16*1024*1024)!==row.body_digest||row.body.check.status!=='PASS')fail('APPLICATION_RELEASE_INTEGRITY');
    const records=(await c.query<RecordRow>('SELECT * FROM finnor_os.x3_records WHERE tenant_id=$1 AND application_id=$2 ORDER BY id FOR UPDATE',[p.tenantId,p.applicationId])).rows;
    const before=recordSetDigest(records.map(recordSnapshot)),after:unknown[]=[];
    const migrated=records.map(r=>{
     if(r.pending_effect_id)fail('UNRESOLVED_APPLICATION_EFFECT_PREPARATION');
     const values={...r.values};
     for(const m of s.b.migration.filter(m=>m.entityId===r.entity_id)){
      if(Object.hasOwn(values,m.field)){if(applicationCanonical(values[m.field])!==applicationCanonical(m.value))fail('MIGRATION_WOULD_OVERWRITE_ORIGINAL_DATA');}
      else values[m.field]=m.value;
     }
     validateValuesAgainstModel(s.b.specification.model,r.entity_id,values);
     if(!s.b.specification.model.entities.find(x=>x.id===r.entity_id)?.states.includes(r.state))fail('MIGRATION_INCOMPATIBLE_REAL_STATE');
     return {r,values};
    });
    await valueSetsFactsTx(ctx,c,s.a,migrated.map(r=>r.values));
    for(const {r,values} of migrated){
     const changed=applicationCanonical(values)!==applicationCanonical(r.values),revision=r.content_revision+(changed?1:0);
     const contentDigest=changed?applicationDigest({applicationId:s.a.id,entityId:r.entity_id,recordId:r.id,revision,authorId:r.author_id,values}):r.content_digest;
     if(changed)await eventTx(c,s.a,p.principalId,'RECORD_SCHEMA_MIGRATED','migration:'+p.buildId+':'+r.id,s.b.specification_digest,{before:recordSnapshot(r),after:{values,contentDigest,revision},meaning:'ORIGINAL_RELEASE_AND_APPROVAL_HISTORY_RETAINED'},r.id,p.buildId);
     await c.query('UPDATE finnor_os.x3_records SET values=$4::jsonb,content_digest=$5,content_revision=$6,schema_release_id=$7,concurrency_revision=concurrency_revision+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND application_id=$2 AND id=$3',[p.tenantId,p.applicationId,r.id,JSON.stringify(values),contentDigest,revision,row.id]);
     after.push({id:r.id,values,contentDigest,revision,originalReleaseId:r.origin_release_id,decisionReleaseId:r.release_id,approvals:r.approvals,state:r.state});
    }
    await physical(c,e,p);assertAllocation(s.a);
    await c.query("UPDATE finnor_os.x3_builds SET status='INSTALLED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[p.tenantId,p.buildId]);
    await c.query("UPDATE finnor_os.x3_applications SET status='INSTALLED',head_release_id=$3,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[p.tenantId,p.applicationId,row.id]);
    await eventTx(c,s.a,p.principalId,'INSTALLED_DEVELOPMENT','installed:'+p.buildId,s.b.specification_digest,{releaseId:row.id,recordCount:records.length,beforeDataDigest:before,afterDataDigest:recordSetDigest(after),preservedOriginalData:true,jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,productionActive:false},null,p.buildId);
   });
  }
 }catch(error){
  if(error instanceof ComputeCapacityUnavailableError)throw error;
  // Retain accounting even if the initiating human has since lost authority.
  // Only this still-current physical/domain delivery may finalize its failure.
  try{await tx(ctx,async c=>{
   await physical(c,e,p);
   const a=(await c.query<ApplicationRow>('SELECT * FROM finnor_os.x3_applications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[p.tenantId,p.applicationId])).rows[0];
   if(!a||a.owner_id!==p.principalId||a.generation!==p.generation||a.status==='CANCELLED')return;
   const code=error instanceof ApplicationFault?error.code:'APPLICATION_HOST_BUILD_FAILED';
   await c.query("UPDATE finnor_os.x3_builds SET status='FAILED',failure=$3::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND status NOT IN('INSTALLED','CANCELLED')",[p.tenantId,p.buildId,JSON.stringify({code,previousAttemptsRetained:true})]);
   await c.query("UPDATE finnor_os.x3_applications SET status='FAILED',updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2",[p.tenantId,p.applicationId]);
   await eventTx(c,a,p.principalId,'BUILD_OR_INSTALL_FAILED','failure:'+e.deliveryAttemptId,applicationDigest(p),{code,unknownPhysicalCostPossible:true,originalAllocationRetained:true},null,p.buildId);
  });}catch{/* A stale delivery cannot write a failure over its successor. */}
  throw error;
 }finally{await releaseComputeResourceLeases(leases,'x3_job_finished').catch(()=>undefined);}
}

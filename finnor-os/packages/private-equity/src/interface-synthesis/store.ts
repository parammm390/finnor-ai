import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import type {PeMutationContext} from '../types';
import {authorize,codeIdentity,principal,sha,stable,tx,unavailable} from '../evidence-execution/store';
import {P5_VERSION,hash,reference,verifyCapability,type AcquisitionRequest,type GeneratedInterface,type InterfaceCapability,type PracticeResult,type Attempt,type CapabilityStatus,type InterfaceRef} from './contracts';
import {boundedFetch,type PracticePort} from './runtime';
import {checkUiWitness} from './ui';
import {readCurrentProgram,requestRow} from '../program-synthesis/store';
import {interfaceConsumerPolicy,currentInterfaceCandidate} from '../../../capability-evolution/src/interface-consumer';
import type {InterfaceCandidate} from '../../../capability-evolution/src/interface-port';
export interface AccessRow {id:string;tenant_id:string;principal_id:string;work_id:string;origin:string;account:string;document_path:string;ui_path:string|null;rights_ref:string;valid_until:Date;permit_practice:boolean;revoked:boolean}
export interface AcquisitionRow {
 id:string;tenant_id:string;principal_id:string;work_id:string;work_input_id:string;work_input_digest:string;episode_id:string;access_id:string;
 request:AcquisitionRequest;request_digest:string;code_digest:string;rights_revision:number;generation:number;status:string;head_id:string|null;
 claim_token:string|null;claim_fence:number|null;reason:string|null;source:unknown|null;source_digest:string|null;generated:GeneratedInterface|null;
 s8_candidate:InterfaceCandidate|null;s8_admission_ref:InterfaceRef|null;
}
export async function acquisition(ctx:PeMutationContext,id:string,c?:PoolClient,lock=false):Promise<AcquisitionRow>{
 const read=async(client:PoolClient)=>{const row=(await client.query<AcquisitionRow>('SELECT * FROM finnor_os.p5_acquisitions WHERE tenant_id=$1 AND principal_id=$2 AND id=$3'+(lock?' FOR UPDATE':''),[ctx.auth.tenantId,principal(ctx),id])).rows[0];if(!row)throw unavailable();if(sha(row.request)!==row.request_digest)throw Error('P5_ORIGINAL_REQUEST_INTEGRITY');return row;};
 return c?read(c):tx(ctx,read,true);
}
export async function access(ctx:PeMutationContext,id:string,workId:string,c?:PoolClient):Promise<AccessRow>{
 const read=async(client:PoolClient)=>{
  const row=(await client.query<AccessRow>('SELECT * FROM finnor_os.p5_test_access WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND work_id=$4',[ctx.auth.tenantId,principal(ctx),id,workId])).rows[0];
  if(!row||row.revoked||row.valid_until.getTime()<=Date.now())throw unavailable();
  const user=(await client.query("SELECT id FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active' AND role='owner'",[ctx.auth.tenantId,principal(ctx)])).rows[0];
  if(!user)throw unavailable();
  return row;
 };return c?read(c):tx(ctx,read,true);
}
export async function assertCurrent(ctx:PeMutationContext,row:AcquisitionRow,c?:PoolClient,fetchWitness=false){
 const rights=await authorize(ctx,row.request.root,[{type:'work',id:row.work_id}]);
 const grant=await access(ctx,row.access_id,row.work_id,c);
 if(grant.account!==row.request.operation.account)throw unavailable();
 if(rights.revision!==row.rights_revision)throw Error('P5_RIGHTS_REVISION_CHANGED');
 if(row.code_digest!==(await codeIdentity()).digest)throw Error('P5_LOADED_SOURCE_CHANGED');
 if(row.request.programId){
  const programme=await readCurrentProgram(ctx,row.request.programId),request=await requestRow(ctx,row.request.programId);
  if(programme.status!=='TESTED'||!programme.program||programme.workId!==row.work_id||programme.workRevision!==row.work_input_id||
   programme.program.work.inputDigest!==row.work_input_digest||stable(request.request.root)!==stable(row.request.root))throw Error('P5_ISSUED_PROGRAMME_NOT_CURRENT');
 }
 const read=async(client:PoolClient)=>{
  const input=(await client.query<{id:string;body:unknown}>('SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[row.tenant_id,row.work_id])).rows[0];
  if(input?.id!==row.work_input_id||sha(input.body)!==row.work_input_digest)throw Error('P5_EXACT_WORK_INPUT_CHANGED');
 };
 if(c)await read(c);else await tx(ctx,read,true);
 if(row.source!==null&&hash(row.source)!==row.source_digest)throw Error('P5_DISCOVERY_SOURCE_INTEGRITY');
 if(fetchWitness&&row.source_digest){
  const source=await boundedFetch(new URL(grant.document_path,grant.origin),'GET');
  if(hash(source)!==row.source_digest)throw Error('P5_INTERFACE_WITNESS_CHANGED');
  if(row.generated?.substrate==='UI'){
   if(!grant.ui_path)throw Error('P5_UI_INTERFACE_WITNESS_CHANGED');
   await checkUiWitness(row.generated,row.request.operation,row.source_digest,practicePort(ctx,row,grant),grant.ui_path,
    event=>append(ctx,row,'UI_CURRENT_EGRESS_REFUSED',event).then(()=>{}));
  }
 }
 return {rights,grant};
}
export async function append(ctx:PeMutationContext,row:AcquisitionRow,kind:string,body:unknown,c?:PoolClient){
 const write=(client:PoolClient)=>client.query('INSERT INTO finnor_os.p5_events(tenant_id,principal_id,acquisition_id,kind,body,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[row.tenant_id,row.principal_id,row.id,kind,stable(body),sha(body)]);
 return c?write(c):tx(ctx,write);
}
export async function attemptRow(ctx:PeMutationContext,row:AcquisitionRow,c?:PoolClient){
 const read=async(client:PoolClient)=>{
  const found=(await client.query<{body:Attempt;result:PracticeResult|null;result_digest:string|null;possible_egress:boolean;acknowledged:boolean}>('SELECT body,result,result_digest,possible_egress,acknowledged FROM finnor_os.p5_attempts WHERE tenant_id=$1 AND principal_id=$2 AND acquisition_id=$3 AND operation_id=$4',[row.tenant_id,row.principal_id,row.id,row.request.operation.operationId])).rows[0];
  if(found&&(found.result!==null&&sha(found.result)!==found.result_digest||found.body.possibleEgress!==found.possible_egress||found.body.acknowledged!==found.acknowledged))throw Error('P5_ATTEMPT_RESULT_INTEGRITY');
  return found??null;
 };return c?read(c):tx(ctx,read,true);
}
export function practicePort(ctx:PeMutationContext,row:AcquisitionRow,grant:AccessRow,claim?:{jobId:string;claimToken:string;claimFence:number}):PracticePort{
 return {origin:grant.origin,account:grant.account,expiresAt:grant.valid_until.toISOString(),disposable:true,
  authorize:async()=>{
   try{
    const fresh=await acquisition(ctx,row.id);
    if(fresh.generation!==row.generation||['CANCELLED','QUARANTINED','FAILED'].includes(fresh.status))return false;
    const current=await assertCurrent(ctx,fresh);
    if(!current.grant.permit_practice)return false;
    if(claim)return tx(ctx,async c=>!!(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp()",[row.tenant_id,claim.jobId,claim.claimToken,claim.claimFence])).rows[0],true);
    return true;
   }catch{return false;}
  },
  record:async event=>{
   await tx(ctx,async c=>{
    const locked=await acquisition(ctx,row.id,c,true);
    const attempt=event.attempt;
    const prior=await attemptRow(ctx,locked,c);
    if(prior&&hash({...prior.body,possibleEgress:attempt.possibleEgress,acknowledged:attempt.acknowledged})!==hash(attempt))throw Error('P5_ORIGINAL_ATTEMPT_SUBSTITUTION');
    if(event.stage==='INTENT'){
     await assertCurrent(ctx,locked,c);
     if(locked.generation!==row.generation||locked.status!=='RUNNING')throw Error('P5_INTENT_FENCED');
     await c.query('INSERT INTO finnor_os.p5_attempts(id,tenant_id,principal_id,acquisition_id,operation_id,binding_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(tenant_id,principal_id,acquisition_id,operation_id) DO NOTHING',
      [attempt.id,row.tenant_id,row.principal_id,row.id,attempt.operationId,attempt.bindingDigest,stable(attempt)]);
    }
    if(event.stage==='POSSIBLE_EGRESS'){
     await assertCurrent(ctx,locked,c);
     if(locked.generation!==row.generation||locked.status!=='RUNNING'||!grant.permit_practice)throw Error('P5_EGRESS_FENCED');
     if(!prior||prior.possible_egress)throw Error('P5_POSSIBLE_EGRESS_REPLAY_FORBIDDEN');
     if(claim){
      const job=(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 AND lease_expires_at>clock_timestamp() FOR SHARE",[row.tenant_id,claim.jobId,claim.claimToken,claim.claimFence])).rows[0];
      if(!job)throw Error('P5_EGRESS_JOB_FENCED');
     }
     const debit=await c.query('UPDATE finnor_os.p5_episodes SET wire_attempts=wire_attempts+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND wire_attempts<4 AND deadline_at>clock_timestamp() RETURNING id',[row.tenant_id,row.principal_id,row.episode_id]);if(!debit.rowCount)throw Error('P5_ORIGINAL_WIRE_BOUND_EXHAUSTED');
     await c.query('UPDATE finnor_os.p5_attempts SET possible_egress=true,body=$4::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[row.tenant_id,row.principal_id,attempt.id,stable(attempt)]);
    }
    if(event.stage==='ACKNOWLEDGED')await c.query('UPDATE finnor_os.p5_attempts SET acknowledged=true,body=$4::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[row.tenant_id,row.principal_id,attempt.id,stable(attempt)]);
    if(event.stage==='OBSERVATION'){
     const debit=await c.query('UPDATE finnor_os.p5_episodes SET reads_used=reads_used+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3 AND reads_used<64 RETURNING id',[row.tenant_id,row.principal_id,row.episode_id]);if(!debit.rowCount)throw Error('P5_RECOVERY_READ_BOUND_EXHAUSTED');
    }
    if(event.stage==='COMPLETED')await c.query('UPDATE finnor_os.p5_attempts SET result=$4::jsonb,result_digest=$5 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[row.tenant_id,row.principal_id,attempt.id,stable(event.body),sha(event.body)]);
    // Immutable events preserve every intermediate cut even when mutable recovery
    // projections change. A late event cannot publish a current capability.
    await append(ctx,locked,event.stage,{attempt,event:event.body??null,claim:claim?{jobId:claim.jobId,fence:claim.claimFence}:null},c);
   });
  }};
}
export function buildCapability(row:AcquisitionRow,generated:GeneratedInterface,practice:PracticeResult|null,execution:{workerId:string;jobId:string;deliveryAttemptId:string;claimFence:number},attempts:number,admission:InterfaceRef|null=null):InterfaceCapability{
 const now=new Date().toISOString(),o=row.request.operation;
 const components={
  operation:{original:o,meaningQualification:'NONCONSEQUENTIAL_TEST_REQUEST_NOT_S3_INTERVENTION'},
  schemaOrUiVersion:{documentDigest:row.source_digest,moduleWitnessDigest:generated.sourceDigest,version:generated.interfaceVersion,knowledgeAt:now,account:o.account,rightsRevision:row.rights_revision},
  adapterModule:generated.adapterModule,requestBinding:{original:o,bindingDigest:generated.bindingDigest,effectRef:null,parameters:['account','entity','value','priorRevision','operationId']},
  observerModule:generated.observerModule,postcondition:{account:o.account,entity:o.entity,field:o.field,unit:o.unit,currency:o.currency,value:o.value,tolerance:o.tolerance,priorRevision:o.priorRevision,operationId:o.operationId,missingIsNull:false,observation:practice?.observation??null},
  retryAndUnknown:{operationId:o.operationId,attemptId:practice?.attempt.id??null,possibleEgress:practice?.attempt.possibleEgress??false,afterPossibleEgress:'READ_ONLY_S6_SEMANTICS_NO_MUTATION_REPLAY',unknownResponsibilityRetained:practice?.status==='UNKNOWN',businessS6Obligation:null},
  credentialClass:{kind:'ADMIN_REGISTERED_NO_CREDENTIAL_DISPOSABLE_TEST_ACCESS',accessRef:row.access_id,brokerCapabilityRef:null,protectedExecution:false},
 };
 const status:CapabilityStatus=practice?.status==='VERIFIED'?(admission?'SUPPORTED_DISPOSABLE':'PRACTICED'):practice?.status??'PROTOTYPE';
 const body:InterfaceCapability={
  schema:'finnor.interface-capability.v1',id:row.id,tenantId:row.tenant_id,principalId:row.principal_id,sharing:{scope:'PRINCIPAL',policy:'CURRENT_S1_AUTHORIZATION'},
  rights:{revision:row.rights_revision,ref:'S1:revision:'+row.rights_revision,evaluatedAt:now},work:{id:row.work_id,revision:row.work_input_id,inputDigest:row.work_input_digest},mandate:null,parents:[],inputsDigest:row.request_digest,validAt:now,knowledgeAt:now,
  code:{version:P5_VERSION,digest:row.code_digest,schemaDigest:row.source_digest!},capability:{kind:'BOUNDED_INTERFACE_CAPABILITY',admission},
  runtime:{node:process.version,imageDigest:null,fabricInvocationId:null,workerId:execution.workerId,jobId:execution.jobId,
   deliveryAttemptId:execution.deliveryAttemptId,claimFence:execution.claimFence,childPid:null,leases:[]},
  domain:{entityScope:[row.request.root.entityId],interface:'p5-disposable-interface-v1',horizon:'H0',businessTruthCertified:false},dependencyRefs:['work:'+row.work_input_id,'S1:revision:'+row.rights_revision,'test-access:'+row.access_id],
  costs:{wallMs:practice?.cost.wallMs??0,cpuMicros:null,peakRSSBytes:null,inputBytes:Buffer.byteLength(stable(row.request)),outputBytes:Buffer.byteLength(stable(generated)),modelCalls:0,usd:null,status:'LOCAL_COST_UNMETERED',attempts,nativeInvocations:practice?.runtimeReceipts??[],unreconciledAttemptIds:practice?.status==='UNKNOWN'?[practice.attempt.id]:[]},
  status,admission,funding:null,unavailableBindings:['S3_S4_S5_S6_CONSEQUENTIAL_INTERFACE_OWNER_BINDING','P3_GENERATED_HARNESS_QUALIFICATION','PENDING_P7_COMMITTED_PORT','INDEPENDENT_GATE_P5','PROTECTED_S8_INTERFACE_ADMISSION','RECONCILED_DOLLARS_AGGREGATE_RESOURCES',...(admission?[]:['S8_INDEPENDENT_INTERFACE_EVALUATION_ADMISSION'])],
  operation:reference('operation',components.operation),schemaOrUiVersion:reference('schemaOrUiVersion',components.schemaOrUiVersion),adapterModule:reference('adapterModule',generated.adapterModule.bytes),requestBinding:reference('requestBinding',components.requestBinding),
  observerModule:reference('observerModule',generated.observerModule.bytes),postcondition:reference('postcondition',components.postcondition),retryAndUnknown:reference('retryAndUnknown',components.retryAndUnknown),credentialClass:reference('credentialClass',components.credentialClass),
  components,generated,practice,s8CandidateRef:row.s8_candidate?.ref??null,
 };
 return verifyCapability(body);
}
export async function publish(ctx:PeMutationContext,row:AcquisitionRow,body:InterfaceCapability,c:PoolClient){
 const id=randomUUID();await c.query('INSERT INTO finnor_os.p5_capabilities(id,tenant_id,principal_id,acquisition_id,generation,body,digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)',[id,row.tenant_id,row.principal_id,row.id,row.generation,stable(body),sha(body)]);
 await c.query('UPDATE finnor_os.p5_acquisitions SET head_id=$4,status=$5,reason=$6,s8_admission_ref=$7::jsonb WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[row.tenant_id,row.principal_id,row.id,id,body.status,body.practice?.reason??(body.admission?null:'S8_INDEPENDENT_ADMISSION_REQUIRED'),stable(body.admission)]);
 await append(ctx,row,'CAPABILITY_HEAD',{headId:id,digest:sha(body),status:body.status,admission:body.admission,originalEffectsRetained:true},c);
}
export async function readCurrent(ctx:PeMutationContext,id:string){
 let row=await acquisition(ctx,id);await authorize(ctx,row.request.root,[{type:'work',id:row.work_id}]);await access(ctx,row.access_id,row.work_id);
 if(!['CANCELLED','QUARANTINED','FAILED'].includes(row.status)){
  try{
   await assertCurrent(ctx,row,undefined,true);
   if(row.s8_admission_ref){
    const policy=await interfaceConsumerPolicy({tenantId:row.tenant_id,principalId:row.principal_id});
    if(!policy||!row.s8_candidate||hash(await currentInterfaceCandidate(row.s8_candidate,policy,'p5-read:'+randomUUID()))!==hash(row.s8_admission_ref))throw Error('P5_S8_INTERFACE_ADMISSION_NOT_CURRENT');
   }
  }catch(error){
   if((error as {code?:string}).code==='PE_ENTITY_NOT_FOUND')throw unavailable();
   const reason=String((error as Error).message).match(/^P5_[A-Z0-9_]+$/)?.[0]??'P5_CURRENT_OWNER_OR_INTERFACE_UNAVAILABLE';
   await tx(ctx,async c=>{const locked=await acquisition(ctx,id,c,true);if(locked.status==='CANCELLED')return;await c.query("UPDATE finnor_os.p5_acquisitions SET status='QUARANTINED',generation=generation+1,reason=$4 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[row.tenant_id,row.principal_id,id,reason]);await append(ctx,locked,'QUARANTINED',{reason,historyRetained:true,possibleEffectsRetained:true},c);});row=await acquisition(ctx,id);
  }
 }
 let capability:InterfaceCapability|null=null;
 if(row.head_id&&!['CANCELLED','QUARANTINED','FAILED'].includes(row.status)){
  capability=await tx(ctx,async c=>{const head=(await c.query<{body:InterfaceCapability;digest:string}>('SELECT body,digest FROM finnor_os.p5_capabilities WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[row.tenant_id,row.principal_id,row.head_id])).rows[0];if(!head||sha(head.body)!==head.digest)throw Error('P5_CAPABILITY_STORED_INTEGRITY');return verifyCapability(head.body);},true);
 }
 const attempted=await attemptRow(ctx,row),counts=await tx(ctx,async c=>(await c.query('SELECT attempts_used,wire_attempts,reads_used FROM finnor_os.p5_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[row.tenant_id,row.principal_id,row.episode_id])).rows[0],true);
 await authorize(ctx,row.request.root,[{type:'work',id:row.work_id}]);await access(ctx,row.access_id,row.work_id);
 return {schema:'finnor.p5.current-reader.v1',acquisitionId:id,workId:row.work_id,status:attempted?.possible_egress&&row.status==='RUNNING'?'UNKNOWN':row.status,
  root:row.request.root,requestedOperation:row.request.operation,sourceVersion:row.generated?.interfaceVersion??null,substrate:row.request.substrate,
  reason:row.reason,capability,practice:capability?.practice??(attempted?.result??null),admission:capability?.admission??null,protectedExecution:false,
  liabilityReleased:false,possibleEgress:attempted?.possible_egress??false,costs:{learningAttempts:counts.attempts_used,wireAttempts:counts.wire_attempts,recoveryReads:counts.reads_used,usd:null,status:'LOCAL_COST_UNMETERED'},p7:'PENDING_P7_COMMITTED_PORT'};
}

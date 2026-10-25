import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {reserveApplicationParent} from '../../application-semantics/allocation';
import type {PeMutationContext} from '../../types';
import {intakeProofWork,selectProofPlan} from './plan';
import {ownerSource} from './source';
import {artifact,authorize,codeIdentity,costs,current,event,job,obligations,original,principal,retain,revisions,setState,tx,workSnapshot,type Capsule,type JobRow,type JobState,type Original} from './store';
import {OPERATION_SCHEMAS,JOB,acceptedDefinition,canonical,consumeSchema,developmentOnly,listSchema,ref,safePredicate,sessionSchema,sha,submitSchema,type Submit} from './contracts';

export async function submitProof(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const request=submitSchema.parse(raw);
 if(ctx.auth.role!=='owner')throw Error('Z4_CURRENT_AUTHENTICATED_OWNER_REQUIRED');
 await authorize(ctx,request.root,[{type:'work',id:request.workId}]);
 const work=await workSnapshot(ctx,request),source=await ownerSource(ctx,request),code=await codeIdentity(),outstanding=await obligations(ctx);
 const existing=await tx(ctx,async c=>(await c.query<{id:string}>(
  "SELECT id::text FROM finnor_os.jobs WHERE tenant_id=$1 AND type=$2 AND payload->>'principalId'=$3 AND payload->>'workId'=$4 LIMIT 1",
  [ctx.auth.tenantId,JOB,principal(ctx),request.workId])).rows[0],true);
 if(existing){
  const row=await job(ctx,existing.id),o=await original(ctx,row);
  if(sha(o.request)!==sha(request))throw Error('Z4_ORIGINAL_WORK_SESSION_CANNOT_RESET');
  return {sessionId:row.id,workId:request.workId,status:row.payload.z4.status,replayed:true};
 }
 const sessionId=randomUUID(),createdAt=new Date().toISOString(),dependencies=await revisions(ctx,['rights:tenant','work-inputs:'+request.workId]);
 const preparation={schema:'finnor.z4.preparation.v1',sessionId,tenantId:ctx.auth.tenantId,principalId:principal(ctx),
  request,workInputDigest:work.digest,ownerSourceDigest:source.digest,rightsFingerprint:source.rightsFingerprint,
  sourceCodeDigest:code.digest,dependencies,obligations:outstanding,createdAt},preparationRef=ref('preparation',preparation);
 let stored:Original|undefined;
 await reserveApplicationParent(ctx,{originalParentRef:request.workRevisionRef,preparationRef,workId:request.workId,
  rightsRef:source.rightsRef,deadlineAt:request.deadlineAt,
  idempotencyKey:'z4-original:'+sha({tenant:ctx.auth.tenantId,principal:principal(ctx),workId:request.workId}),
  requestDigest:sha(request),demand:request.resourceDemand,root:request.root,onReserved:async(c,allocation)=>{
   await workSnapshot(ctx,request,c);
   const duplicate=(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND type=$2 AND payload->>'principalId'=$3 AND payload->>'workId'=$4 FOR UPDATE",
    [ctx.auth.tenantId,JOB,principal(ctx),request.workId])).rows[0];
   if(duplicate)throw Error('Z4_CONCURRENT_ORIGINAL_SUBMISSION_RETRY_SAME_KEY');
   const binding=sha({preparationRef,certificateRef:allocation.certificate.ref,reservationRef:allocation.reservation.ref,
    consumptionRef:allocation.rootConsumption.ref,originalDeadline:request.deadlineAt});
   stored={schema:'finnor.z4.original.v1',sessionId,tenantId:ctx.auth.tenantId,principalId:principal(ctx),request,
    exact:{program:request.program,initial:request.initial,inputs:source.inputs,binding},workInputDigest:work.digest,
    rightsRevision:source.rightsRevision,rightsRef:source.rightsRef,rightsFingerprint:source.rightsFingerprint,
    ownerSourceDigest:source.digest,dependencies,code,preparationRef,allocation,obligations:outstanding,createdAt};
   const originalDigest=await retain(ctx,'original',stored),retainedBytes=Buffer.byteLength(canonical(stored));
   if(retainedBytes>request.maxRetainedBytes)throw Error('Z4_ORIGINAL_RETAINED_BYTE_BUDGET_EXHAUSTED');
   const state:JobState={schema:'finnor.z4.job.v1',sessionId,principalId:principal(ctx),originalDigest,status:'QUEUED',attempts:0,
    events:[],cpuReservedSeconds:0,cpuLimitSeconds:request.maxCpuSeconds,retainedBytes,retainedByteLimit:request.maxRetainedBytes};
   await c.query(`INSERT INTO finnor_os.jobs(id,tenant_id,type,payload,idempotency_key,protocol_version,max_attempts,lane,retry_safety)
    VALUES($1,$2,$3,$4::jsonb,$5,1,$6,'batch','locally_idempotent')`,
    [sessionId,ctx.auth.tenantId,JOB,canonical({tenantId:ctx.auth.tenantId,principalId:principal(ctx),sessionId,workId:request.workId,
     workInputId:request.workInputId,workRevisionRef:request.workRevisionRef,definitionDigest:sha(acceptedDefinition(request)),z4:state}),
     'z4:'+sessionId,request.maxAttempts]);
  }});
 if(!stored){
  const replay=await tx(ctx,async c=>(await c.query<{id:string}>("SELECT id::text FROM finnor_os.jobs WHERE tenant_id=$1 AND type=$2 AND payload->>'principalId'=$3 AND payload->>'workId'=$4",
   [ctx.auth.tenantId,JOB,principal(ctx),request.workId])).rows[0],true);
  if(!replay)throw Error('Z4_ATOMIC_ORIGINAL_JOB_BINDING_REQUIRED');
  return {sessionId:replay.id,workId:request.workId,status:(await job(ctx,replay.id)).payload.z4.status,replayed:true};
 }
 await event(ctx,sessionId,'ORIGINAL_ACCEPTED',{workId:request.workId,workInputId:request.workInputId,
  workRevisionRef:request.workRevisionRef,definitionDigest:sha(acceptedDefinition(request)),reservationRef:stored.allocation.reservation.ref,
  originalDeadline:request.deadlineAt,unresolved:outstanding,executionAuthorityGranted:false});
 return {sessionId,workId:request.workId,status:'QUEUED',replayed:false};
}
export async function readProof(ctx:PeMutationContext,raw:unknown){
 const {sessionId}=sessionSchema.parse(raw),row=await job(ctx,sessionId),o=await original(ctx,row);
 let currentness='CURRENT',reason:string|null=null;
 try{await current(ctx,o,{historicalRead:true});}catch(e){currentness='STALE';reason=safePredicate(e);}
 const state=row.payload.z4;
 const c=currentness==='CURRENT'&&state.capsuleDigest?await artifact<Capsule>(ctx,'capsule',state.capsuleDigest):null;
 if(c&&(c.originalDigest!==state.originalDigest||c.sessionId!==sessionId))throw Error('Z4_CAPSULE_ORIGINAL_BINDING');
 return {sessionId,workId:o.request.workId,workInputId:o.request.workInputId,status:state.status,currentness,reason,
  originalDeadline:o.request.deadlineAt,remainingBudget:{allocationRef:o.allocation.certificate.ref,reservationRef:o.allocation.reservation.ref,
   cpuReservedSeconds:state.cpuReservedSeconds,cpuLimitSeconds:state.cpuLimitSeconds,retainedBytes:state.retainedBytes,retainedByteLimit:state.retainedByteLimit},
  program:currentness==='CURRENT'?o.request.program:null,steps:currentness==='CURRENT'?o.exact.inputs.length:null,
  definitionDigest:row.payload.definitionDigest,privateOutputsWithheld:currentness!=='CURRENT',
  capsule:c?{digest:state.capsuleDigest,envelope:c.envelope,statement:c.checked.statement,artifact:{profile:c.checked.artifact.profile,
   parameterHash:c.checked.artifact.parameterHash,planHash:c.checked.artifact.planHash,proofBytes:c.checked.artifact.proofHex.length/2},
   correspondence:c.checked.correspondence,verifier:{operation:c.checked.verifier.operation,binarySha256:c.checked.verifier.binarySha256,
    sourceDigest:c.checked.verifier.sourceDigest,meters:c.checked.verifier.meters,data:c.checked.verifier.data}}:null,
  delivery:state.delivery??null,unresolvedOriginalObligations:o.obligations,currentObligations:await obligations(ctx),
  costs:await costs(ctx,o,row),failure:state.failure??null,qualifications:{
   architecture:c?'IMPLEMENTED_NOT_INDEPENDENTLY_ADMITTED':'INCOMPLETE',internalSoftware:'IN_PROGRESS',installedDevelopment:'NOT_RUN',
   mathematicalSecurity:'NOT_RUN',protectedAdmission:'NOT_RUN',equippedIncrement:'NOT_RUN',operational100x:'NOT_RUN',
   financialHeadroom:'NOT_RUN',financial100x:'NOT_RUN',productionActivation:'NOT_RUN'},executionAuthorityGranted:false};
}
export async function listProofs(ctx:PeMutationContext,raw:unknown){
 const input=listSchema.parse(raw);await authorize(ctx,input.root,[{type:'work',id:input.workId}]);
 const ids=await tx(ctx,async c=>(await c.query<{id:string}>(
  "SELECT id::text FROM finnor_os.jobs WHERE tenant_id=$1 AND type=$2 AND payload->>'principalId'=$3 AND payload->>'workId'=$4 ORDER BY created_at DESC LIMIT 17",
  [ctx.auth.tenantId,JOB,principal(ctx),input.workId])).rows,true);
 if(ids.length>16)throw Error('Z4_SESSION_PAGINATION_REQUIRED');
 const sessions=[];
 for(const {id} of ids){const row=await job(ctx,id),o=await original(ctx,row);if(sha(o.request.root)===sha(input.root))sessions.push({sessionId:id,status:row.payload.z4.status});}
 return {workId:input.workId,sessions};
}
export async function cancelProof(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const {sessionId}=sessionSchema.parse(raw),row=await job(ctx,sessionId),o=await original(ctx,row);
 await authorize(ctx,o.request.root,[{type:'work',id:o.request.workId}]);
 await tx(ctx,async c=>{const fresh=await job(ctx,sessionId,c,true);await setState(ctx,fresh,{...fresh.payload.z4,status:'CANCELLED'},c);});
 await event(ctx,sessionId,'CANCELLED',{originalReservationRef:o.allocation.reservation.ref,originalDeadline:o.request.deadlineAt,
  unresolvedObligations:await obligations(ctx),releaseGranted:false,compensationGranted:false});
 return {sessionId,status:'CANCELLED',executionAuthorityGranted:false};
}
export async function handleProofOperation(ctx:PeMutationContext,operation:string,raw:unknown):Promise<{status:number;body:unknown}>{
 try{
  if(!Object.hasOwn(OPERATION_SCHEMAS,operation))return {status:404,body:{code:'NOT_FOUND'}};
  const value=OPERATION_SCHEMAS[operation as keyof typeof OPERATION_SCHEMAS].parse(raw);
  let body:unknown;
  if(operation==='execution-proof-intake')body=await intakeProofWork(ctx,value);
  else if(operation==='execution-proof-plan')body=await selectProofPlan(ctx,value);
  else if(operation==='execution-proof-submit')body=await submitProof(ctx,value);
  else if(operation==='execution-proof-read')body=await readProof(ctx,value);
  else if(operation==='execution-proof-list')body=await listProofs(ctx,value);
  else if(operation==='execution-proof-cancel')body=await cancelProof(ctx,value);
  else{
   const consumer=await import('./owner-consumer');
   body=operation==='execution-proof-audit'?await consumer.auditProof(ctx,value):await consumer.consumeProof(ctx,consumeSchema.parse(value));
  }
  if(Buffer.byteLength(JSON.stringify(body))>8*1024*1024)throw Error('Z4_RESPONSE_BYTE_BOUND');
  return {status:operation==='execution-proof-submit'?202:200,body};
 }catch(error){
  if(error instanceof z.ZodError)return {status:400,body:{code:'Z4_TYPED_DOMAIN_REQUIRED',error:'Unsupported exact computation request'}};
  if(error&&typeof error==='object'&&'code'in error&&error.code==='PE_ENTITY_NOT_FOUND')return {status:404,body:{code:'PE_ENTITY_NOT_FOUND',error:'Proof resource is unavailable in the authenticated scope'}};
  return {status:422,body:{code:'Z4_PREDICATE_UNPASSED',predicate:safePredicate(error),executionAuthorityGranted:false}};
 }
}

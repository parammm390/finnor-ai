import {randomBytes} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canExerciseAuthorityTx,employeeAuthoritySnapshotTx} from '@finnor/authority';
import type {PeMutationContext} from '../types';
import {authorize,unavailable} from '../owner-context';
import {workCutTx,assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
import {SourceHandleSchema,SubmitSchema,ConsentSchema,CommitmentSchema,ImportSchema,ReadSchema,ListSchema,ControlSchema,
 RevokeSchema,parse,sha,sourceHandleRefs,quantity,recipientOutputCommitment,fail,minimumNativeCpu,type OpaqueSourceHandle,type ConfidentialEconomicComputation} from './contracts';
import {currentEnvironment,runtimeConfiguration} from './process';
import {assertCompleteArtifact,completeConfidentialArtifact,constructionObservation} from './artifact';
import {tx,principal,newId,computationTx,allCurrentTx,allocated,workCurrentTx,captureSourcesTx,
 consentsTx,eventTx,enqueueTx,type ComputationRow} from './store';

export async function issueConfidentialSourceHandle(ctx:PeMutationContext,value:unknown){
 const input=parse(SourceHandleSchema,value);
 return tx(ctx,async c=>{
  const handle=(await c.query<{handle:OpaqueSourceHandle}>('SELECT finnor_os.y4_issue_source_handle($1,$2) handle',
   [input.workId,input.grantId])).rows[0]?.handle;
  if(!handle||handle.body.principalId!==principal(ctx))throw unavailable();
  return {...handle,...sourceHandleRefs(handle),sourceTruthProven:false,executionAuthorityGranted:false};
 });
}
export async function submitConfidential(ctx:PeMutationContext,value:unknown){
 const input=parse(SubmitSchema,value),environment=await currentEnvironment();
 if(Date.parse(input.limits.deadlineAt)<=Date.now()||Date.parse(input.limits.deadlineAt)>Date.now()+3600000)
  fail('Y4_ORIGINAL_ONE_HOUR_EPISODE_REQUIRED',400);
 return tx(ctx,async c=>{
  await authorize(ctx,input.root,[{type:'work',id:input.workId}],[],c);
  if(!await canExerciseAuthorityTx(ctx.auth,{operation:'action',capability:'action:confidential_economic_computation',
   resource:{type:input.root.entityType,id:input.root.entityId},risk:'low'},c))throw unavailable();
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['y4-submit:'+ctx.auth.tenantId+':'+principal(ctx)+':'+input.idempotencyKey]);
  const prior=(await c.query<ComputationRow>('SELECT * FROM finnor_os.y4_computations WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==sha(input))fail('Y4_IDEMPOTENCY_CONFLICT');return {computationId:prior.id,workId:prior.work_id,status:prior.status,replayed:true};}
  if((await c.query('SELECT 1 FROM finnor_os.y4_computations WHERE tenant_id=$1 AND work_id=$2',[ctx.auth.tenantId,input.workId])).rowCount)
   fail('Y4_ORIGINAL_WORK_ALREADY_ALLOCATED');
  const cut=await workCutTx(c,{tenant_id:ctx.auth.tenantId,work_id:input.workId});
  if(cut.id!==input.workInputId)fail('Y4_WORK_INPUT_CHANGED');
  const q=(await c.query<ComputationRow>(`INSERT INTO finnor_os.y4_computations
   (tenant_id,id,principal_id,root_type,root_id,work_id,work_input_id,work_input_digest,request,request_digest,
    environment,deadline_at,max_attempts,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14) RETURNING *`,
   [ctx.auth.tenantId,newId(),principal(ctx),input.root.entityType,input.root.entityId,input.workId,cut.id,cut.digest,
    JSON.stringify(input),sha(input),JSON.stringify(environment),input.limits.deadlineAt,input.limits.maxAttempts,input.idempotencyKey])).rows[0]!;
  await workCurrentTx(c,q);
  const jobId=await enqueueTx(c,q,'COMPILE','y4-compile:'+q.id);
  await eventTx(c,q,principal(ctx),'SUBMITTED','submit',{jobId,requestDigest:q.request_digest,sourceDigest:sha(environment),effectAuthorityGranted:false});
  return {computationId:q.id,jobId,workId:q.work_id,status:q.status,replayed:false};
 });
}
export async function consentConfidential(ctx:PeMutationContext,value:unknown){
 const input=parse(ConsentSchema,value);
 return tx(ctx,async c=>{
  const q=await computationTx(ctx,c,input.computationId,'action');allocated(q);await workCurrentTx(c,q);
  if(q.status!=='AWAITING_PARTICIPANTS')fail('Y4_CHECKED_COMPILATION_REQUIRED');
  const configuration=await runtimeConfiguration(q.tenant_id,q.request.function.participants);
  const index=q.request.function.participants.findIndex(p=>p.id===input.participantId),agent=configuration.agents[index];
  if(!agent||agent.principalId!==principal(ctx))throw unavailable();
  const certificate=createHash('sha256').update(await readFile(join(agent.stateDirectory,'Player-Data',`P${index}.pem`))).digest('hex');
  if(certificate!==input.certificateDigest)fail('Y4_INSTALLED_PARTICIPANT_CERTIFICATE_REQUIRED');
  const authority=await employeeAuthoritySnapshotTx(ctx.auth,c),sourceCuts=await captureSourcesTx(ctx,c,q,input.participantId);
  const boundary=Math.min(q.deadline_at.getTime(),...sourceCuts.map(s=>Date.parse(s.validUntil)),
   authority.validUntil?Date.parse(authority.validUntil):Infinity);
  if(Date.parse(input.validUntil)<=Date.now()||Date.parse(input.validUntil)>boundary)fail('Y4_CONSENT_WINDOW_EXCEEDS_ORIGINAL_RIGHTS');
  const body={request:input,sourceCuts,authorityRevision:String(authority.revision),
   functionDigest:sha(q.request.function),participantId:input.participantId};
  const prior=(await consentsTx(c,q)).find(r=>r.participant_id===input.participantId);
  if(prior){
   if(prior.principal_id!==principal(ctx)||sha(prior.body)!==sha(body))fail('Y4_IDEMPOTENCY_CONFLICT');
   return {computationId:q.id,participantId:input.participantId,consentDigest:prior.body_digest,replayed:true};
  }
  await c.query(`INSERT INTO finnor_os.y4_consents(tenant_id,computation_id,participant_id,principal_id,body,body_digest)
   VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[q.tenant_id,q.id,input.participantId,principal(ctx),JSON.stringify(body),sha(body)]);
  await eventTx(c,q,principal(ctx),'PARTICIPANT_CONSENT','consent:'+input.participantId,
   {participantId:input.participantId,certificateDigest:certificate,functionDigest:body.functionDigest});
  await allCurrentTx(ctx,c,q,false);
  return {computationId:q.id,participantId:input.participantId,consentDigest:sha(body),replayed:false,
   sourceTruthProven:false,protectedAdmission:false};
 });
}
export async function prepareConfidential(ctx:PeMutationContext,value:unknown){
 const input=parse(ReadSchema,value);
 return tx(ctx,async c=>{
  const q=await computationTx(ctx,c,input.computationId,'action');
  if(q.principal_id!==principal(ctx))throw unavailable();
  const consents=await allCurrentTx(ctx,c,q);
  if(q.session)return {computationId:q.id,protocol:q.protocol,session:q.session,replayed:true};
  if(q.status!=='AWAITING_PARTICIPANTS'||!q.protocol)fail('Y4_CHECKED_COMPILATION_REQUIRED');
  if(Math.floor((q.request.limits.maxCpuSeconds-q.cpu_reserved_seconds)*0.9)
   <minimumNativeCpu(q.request.function.participants.length))fail('Y4_ORIGINAL_TOTAL_CANNOT_FUND_NATIVE_SUPERVISION');
  // Reserve before any participant can prepare. Aborts never refund this
  // stable source identity, and a new label/version/Work cannot reset it.
  const keys=new Map<string,{institution:string;source:string}>();
  for(const port of q.request.function.inputs){
   const p=q.request.function.participants.find(p=>p.id===port.participantId)!;
   const source=sha({owner:port.sourceRef.owner,id:port.sourceRef.id});
   keys.set(p.institutionId+':'+source,{institution:p.institutionId,source});
  }
  for(const {institution,source} of [...keys.values()].sort((a,b)=>(a.institution+a.source).localeCompare(b.institution+b.source))){
   if((await c.query('SELECT 1 FROM finnor_os.y4_disclosures WHERE tenant_id=$1 AND institution_id=$2 AND source_key=$3',
    [q.tenant_id,institution,source])).rowCount)fail('Y4_CUMULATIVE_DISCLOSURE_BUDGET_CONSUMED');
   await c.query('INSERT INTO finnor_os.y4_disclosures(tenant_id,institution_id,source_key,computation_id) VALUES($1,$2,$3,$4)',
    [q.tenant_id,institution,source,q.id]);
  }
  const cryptographicDeadline=new Date(Math.min(q.deadline_at.getTime(),
   ...consents.map(row=>Date.parse(row.body.request.validUntil)),
   ...consents.flatMap(row=>row.body.sourceCuts.map(cut=>Date.parse(cut.validUntil))),
   ...q.request.function.inputs.map(port=>Date.parse(port.freshUntil)))).toISOString();
  const session={schema:'finnor.y4.session.v1',sessionId:randomBytes(16).toString('hex'),functionDigest:q.protocol.functionDigest,
   profileDigest:q.protocol.profileDigest,releaseCutDigest:sha(consents.map(r=>({participantId:r.participant_id,consentDigest:r.body_digest}))),
   deadlineAt:cryptographicDeadline,participantCertificateDigests:Object.fromEntries(consents.map(r=>[r.participant_id,r.body.request.certificateDigest]))};
  await c.query('UPDATE finnor_os.y4_computations SET session=$3::jsonb WHERE tenant_id=$1 AND id=$2',[q.tenant_id,q.id,JSON.stringify(session)]);
  await eventTx(c,q,principal(ctx),'SESSION_PREPARED','prepare',{sessionId:session.sessionId,abortsConsumeBudget:true,automaticRefund:false});
  await assertAuthorityTemporalBoundsTx(c,consents.map(r=>r.body.request.validUntil));
  return {computationId:q.id,protocol:q.protocol,session,replayed:false};
 });
}
export async function commitConfidential(ctx:PeMutationContext,value:unknown){
 const input=parse(CommitmentSchema,value);
 return tx(ctx,async c=>{
  const q=await computationTx(ctx,c,input.computationId,'action'),consents=await allCurrentTx(ctx,c,q);
  const own=consents.find(r=>r.participant_id===input.participantId);
  if(!own||own.principal_id!==principal(ctx)||input.commitment.participantId!==input.participantId)throw unavailable();
  if(!q.session||!q.protocol||input.commitment.sessionId!==q.session.sessionId
   ||input.commitment.functionDigest!==q.protocol.functionDigest)fail('Y4_EXACT_PREPARED_SESSION_REQUIRED');
  const ports=q.request.function.inputs.filter(p=>p.participantId===input.participantId);
  if(sha(ports.map(p=>p.key).sort())!==sha(input.commitment.inputs.map(p=>p.key).sort()))fail('Y4_ONLY_PARTICIPANT_OWN_COMMITMENTS');
  for(const commitment of input.commitment.inputs){
   const port=ports.find(p=>p.key===commitment.key)!;
   const prefix=sha({schema:'finnor.y4.input-binding.v1',sessionId:q.session.sessionId,
    functionDigest:q.protocol.functionDigest,profileDigest:q.protocol.profileDigest,
    releaseCutDigest:q.session.releaseCutDigest,deadlineAt:q.session.deadlineAt,
    participantCertificateDigests:q.session.participantCertificateDigests,port}).slice(0,32);
   if(prefix!==commitment.bindingPrefix)fail('Y4_EXACT_INPUT_SESSION_BINDING_REQUIRED');
  }
  const prior=(await c.query('SELECT body_digest FROM finnor_os.y4_commitments WHERE tenant_id=$1 AND computation_id=$2 AND participant_id=$3',
   [q.tenant_id,q.id,input.participantId])).rows[0];
  if(prior){if(prior.body_digest!==sha(input.commitment))fail('Y4_IDEMPOTENCY_CONFLICT');return {accepted:true,replayed:true};}
  if(q.status!=='AWAITING_PARTICIPANTS')fail('Y4_NO_REPLACEMENT_OF_ACCEPTED_INPUTS');
  await c.query(`INSERT INTO finnor_os.y4_commitments(tenant_id,computation_id,participant_id,principal_id,body,body_digest)
   VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[q.tenant_id,q.id,input.participantId,principal(ctx),JSON.stringify(input.commitment),sha(input.commitment)]);
  const all=(await c.query('SELECT body FROM finnor_os.y4_commitments WHERE tenant_id=$1 AND computation_id=$2 ORDER BY participant_id',[q.tenant_id,q.id])).rows;
  if(all.length===q.request.function.participants.length){
   // The independent Python checker validates the complete binding again
   // before native compilation or any participant input delivery.
   await c.query("UPDATE finnor_os.y4_computations SET status='READY' WHERE tenant_id=$1 AND id=$2",[q.tenant_id,q.id]);q.status='READY';
   await enqueueTx(c,q,'EXECUTE','y4-execute:'+q.id+':'+q.generation);
  }
  await eventTx(c,q,principal(ctx),'INPUT_COMMITMENT_ACCEPTED','commit:'+input.participantId,{participantId:input.participantId,sessionId:q.session.sessionId});
  return {accepted:true,status:q.status,replayed:false};
 });
}
export async function importConfidentialRelease(ctx:PeMutationContext,value:unknown){
 const input=parse(ImportSchema,value);
 return tx(ctx,async c=>{
  const q=await computationTx(ctx,c,input.computationId,'action'),consents=await allCurrentTx(ctx,c,q);
  if(q.status!=='COMPUTED'||!q.runtime_receipt||!q.protocol||!q.session)fail('Y4_COMPLETED_NATIVE_PROTOCOL_REQUIRED');
  const owner=consents.find(r=>r.participant_id===input.participantId);
  if(owner?.principal_id!==principal(ctx))throw unavailable();
  const receipt=q.runtime_receipt.receipts.find((r:any)=>r.participantId===input.participantId);
  const commitments=(await c.query('SELECT body,body_digest FROM finnor_os.y4_commitments WHERE tenant_id=$1 AND computation_id=$2 ORDER BY participant_id',
   [q.tenant_id,q.id])).rows;
  const binding={session:q.session,inputs:commitments.flatMap(row=>row.body.inputs)};
  const opening=recipientOutputCommitment(q.protocol,binding,input.participantId,input.releaseNonce,input.outputs);
  if(!receipt||receipt.state!=='COMPLETED'||receipt.nativeIndependentlyReconstructed!==true
   ||receipt.outputCommitment!==opening
   ||q.runtime_receipt.receipts.some((r:any)=>r.state!=='COMPLETED'||r.nativeIndependentlyReconstructed!==true
    ||r.outputCommitments?.[input.participantId]!==opening))
   fail('Y4_AUTHENTICATED_RECIPIENT_LOCAL_RELEASE_REQUIRED');
  const permitted=q.request.function.outputs.filter(o=>o.recipients.includes(input.participantId));
  if(sha(input.outputs.map(o=>o.key).sort())!==sha(permitted.map(o=>o.key).sort()))fail('Y4_EXACT_RELEASE_RECIPIENT_REQUIRED');
  const outputs=input.outputs.map(o=>{
   quantity(o);
   if(q.protocol!.outputs.find((p:any)=>p.key===o.key)?.scale!==o.scale)fail('Y4_CHECKED_RELEASE_SCALE_REQUIRED');
   return {...o,semantics:permitted.find(p=>p.key===o.key)!.semantics};
  });
  const prior=(await c.query('SELECT id,body FROM finnor_os.y4_releases WHERE tenant_id=$1 AND computation_id=$2 AND participant_id=$3 AND principal_id=$4',
   [q.tenant_id,q.id,input.participantId,principal(ctx)])).rows[0];
  if(prior){
   if(prior.body.releaseNonce!==input.releaseNonce||sha(prior.body.outputs)!==sha(outputs))fail('Y4_IDEMPOTENCY_CONFLICT');
   return {releaseId:prior.id,replayed:true};
  }
  const id=newId(),releaseFields={
   id:q.id,tenantId:q.tenant_id,principalId:principal(ctx),workId:q.work_id,workInputId:q.work_input_id,
   functionDigest:q.protocol.functionDigest,protocolDigest:sha(q.protocol),profileDigest:q.protocol.profileDigest,
   runtimeIdentity:q.environment,correspondence:q.correspondence!,releaseNonce:input.releaseNonce,outputCommitment:opening,
   sessionId:q.session.sessionId,releaseId:id,releasePolicy:q.request.function.release,
   participantIds:q.request.function.participants.map(p=>p.id),outputs,
   inputSourceStatus:q.request.function.inputs.map(p=>({key:p.key,status:p.sourceStatus,primaryEvidenceRef:p.primaryEvidenceRef})),
   currentness:'CURRENT' as const,truthClass:'DERIVED_VALUE' as const,sourceTruthProven:false as const,qualification:'LOCAL_ENGINEERING_ONLY' as const,
   protectedAdmission:false as const,productionActive:false as const,executionAuthorityGranted:false as const};
  const body:ConfidentialEconomicComputation=completeConfidentialArtifact(q,consents,commitments,
   input.participantId,releaseFields,new Date().toISOString());
  await c.query(`INSERT INTO finnor_os.y4_releases(tenant_id,id,computation_id,participant_id,principal_id,body,body_digest)
   VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,[q.tenant_id,id,q.id,input.participantId,principal(ctx),JSON.stringify(body),sha(body)]);
  // No output, opening nonce or unsalted low-entropy result hash in shared Work.
  await eventTx(c,q,principal(ctx),'RECIPIENT_RELEASE_IMPORTED','release:'+input.participantId,
   {releaseId:id,participantId:input.participantId,outputKeys:outputs.map(o=>o.key),truthClass:'DERIVED_VALUE'});
  return {releaseId:id,replayed:false,protectedAdmission:false};
 });
}
export async function readConfidential(ctx:PeMutationContext,value:unknown){
 const input=parse(ReadSchema,value);
 return tx(ctx,async c=>{
  const q=await computationTx(ctx,c,input.computationId);
  let current=true,currentnessReason:string|null=null;
  try{await allCurrentTx(ctx,c,q,false);}catch(error){current=false;currentnessReason=error instanceof Error?error.message:'Y4_CURRENTNESS_UNAVAILABLE';}
  const releases=current?(await c.query('SELECT id,body,body_digest FROM finnor_os.y4_releases WHERE tenant_id=$1 AND computation_id=$2 AND principal_id=$3',
   [q.tenant_id,q.id,principal(ctx)])).rows:[];
  for(const release of releases){
   if(sha(release.body)!==release.body_digest)fail('Y4_RETAINED_RELEASE_CONTENT_CHANGED');
   assertCompleteArtifact(release.body);
  }
  const history=(await c.query(`SELECT id::text,kind,actor_id,created_at,body FROM finnor_os.y4_events
   WHERE tenant_id=$1 AND computation_id=$2 ORDER BY id DESC LIMIT 64`,[q.tenant_id,q.id])).rows;
  const consents=await consentsTx(c,q),validUntil=new Date(Math.min(q.deadline_at.getTime(),
   ...q.request.function.inputs.map(p=>Date.parse(p.freshUntil)),
   ...consents.flatMap(r=>[Date.parse(r.body.request.validUntil),...r.body.sourceCuts.map(s=>Date.parse(s.validUntil))]))).toISOString();
  return {computationId:q.id,workId:q.work_id,status:q.status,current,currentnessReason,
   root:{entityType:q.root_type,entityId:q.root_id},validUntil,
   function:q.request.function,correspondence:q.correspondence,session:q.session,releases,history,
   construction:constructionObservation(q,current,releases[0]?.body),
   counters:{attempts:q.attempt_count,maxAttempts:q.max_attempts,dataBytes:Number(q.data_bytes),
    cpuReservedSeconds:q.cpu_reserved_seconds,cpuLimitSeconds:q.request.limits.maxCpuSeconds,deadlineAt:q.deadline_at.toISOString()},
   qualification:'LOCAL_ENGINEERING_ONLY',protectedAdmission:false,productionActive:false,executionAuthorityGranted:false};
 });
}
export async function listConfidential(ctx:PeMutationContext,value:unknown){
 const input=parse(ListSchema,value);
 return tx(ctx,async c=>{
  await authorize(ctx,input.root,[{type:'work',id:input.workId}],[],c);
  return {computations:(await c.query(`SELECT id,status FROM finnor_os.y4_computations
   WHERE tenant_id=$1 AND root_type=$2 AND root_id=$3 AND work_id=$4 ORDER BY created_at DESC,id LIMIT 64`,
  [ctx.auth.tenantId,input.root.entityType,input.root.entityId,input.workId])).rows};
 });
}
export async function controlConfidential(ctx:PeMutationContext,value:unknown,operation:'CANCEL'|'INVALIDATE'|'RETRY'|'RECONCILE'){
 const input=parse(ControlSchema,value);
 return tx(ctx,async c=>{
  const q=await computationTx(ctx,c,input.computationId,'action');
  if(q.principal_id!==principal(ctx))throw unavailable();
  const key=operation+':'+input.idempotencyKey,prior=(await c.query('SELECT body FROM finnor_os.y4_events WHERE tenant_id=$1 AND computation_id=$2 AND idempotency_key=$3',
   [q.tenant_id,q.id,key])).rows[0];
  if(prior){if(prior.body.requestDigest!==sha(input))fail('Y4_IDEMPOTENCY_CONFLICT');return prior.body;}
  if(operation==='RETRY'){
   allocated(q);await workCurrentTx(c,q);
   if(q.session||q.status!=='FAILED'||q.attempt_count>=q.max_attempts)fail('Y4_ONLY_PRE_INPUT_COMPILER_RETRY_ALLOWED');
   q.generation++;
   await c.query("UPDATE finnor_os.y4_computations SET status='QUEUED',generation=$3 WHERE tenant_id=$1 AND id=$2",[q.tenant_id,q.id,q.generation]);
   await enqueueTx(c,q,'COMPILE','y4-compile:'+q.id+':'+q.generation);
  }else if(operation==='RECONCILE'){
   if(!q.session||!['RUNNING','RECONCILIATION_REQUIRED'].includes(q.status))fail('Y4_POSSIBLE_INPUT_DELIVERY_REQUIRED');
   await c.query("UPDATE finnor_os.y4_computations SET status='RECONCILIATION_REQUIRED' WHERE tenant_id=$1 AND id=$2",[q.tenant_id,q.id]);
   await enqueueTx(c,q,'RECONCILE','y4-reconcile:'+q.id+':'+input.idempotencyKey);
  }else{
   q.generation++;
   await c.query('UPDATE finnor_os.y4_computations SET status=$3,generation=$4 WHERE tenant_id=$1 AND id=$2',
    [q.tenant_id,q.id,operation==='CANCEL'?'CANCELLED':'INVALIDATED',q.generation]);
  }
  const body={computationId:q.id,operation,requestDigest:sha(input),originalDeadlineAt:q.deadline_at.toISOString(),
   resourcesReplenished:false,disclosureRefunded:false,unrelatedS6Effects:'RETAINED',historyRetained:true};
  await eventTx(c,q,principal(ctx),operation,key,body);return body;
 });
}
export async function revokeConfidential(ctx:PeMutationContext,value:unknown){
 const input=parse(RevokeSchema,value);
 return tx(ctx,async c=>{
  const q=await computationTx(ctx,c,input.computationId,'action'),consent=(await consentsTx(c,q)).find(r=>r.participant_id===input.participantId);
  if(consent?.principal_id!==principal(ctx))throw unavailable();
  const prior=(await c.query('SELECT body FROM finnor_os.y4_revocations WHERE tenant_id=$1 AND computation_id=$2 AND participant_id=$3',
   [q.tenant_id,q.id,input.participantId])).rows[0];
  if(prior&&sha(prior.body)!==sha(input))fail('Y4_IDEMPOTENCY_CONFLICT');
  if(!prior)await c.query(`INSERT INTO finnor_os.y4_revocations(tenant_id,computation_id,participant_id,principal_id,body)
   VALUES($1,$2,$3,$4,$5::jsonb)`,[q.tenant_id,q.id,input.participantId,principal(ctx),JSON.stringify(input)]);
  await eventTx(c,q,principal(ctx),'CONSENT_REVOKED','revoke:'+input.participantId,
   {participantId:input.participantId,futureDerivativeUseDenied:true,previousDisclosuresNotUnlearned:true,unrelatedS6Effects:'RETAINED'});
  return {revoked:true,futureDerivativeUseDenied:true,previousDisclosuresNotUnlearned:true};
 });
}

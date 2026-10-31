import type {PoolClient} from 'pg';
import {acquireComputeResourceLeases,renewComputeResourceLeases,releaseComputeResourceLeases,reserveIdentificationResourceTx,ComputeCapacityUnavailableError,type ComputeResourceLease} from '@finnor/db';
import {evaluateAuthorityTx} from '@finnor/authority';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import type {DigitalExperimentProtocol,DigitalCondition,DigitalObservation,IdentificationFamily,IdentificationAnalysis,IdentificationIndependentCheck,
 DigitalHttpReceipt,DigitalIdentificationCheckInput,IdentifiedSystemRelease,DigitalInstrumentCertificate} from '@finnor/shared-types';
import {digitalConditions,conditionMatches,digitalTrial,analyzeDigitalObservations,forecastDigitalCondition,unanimousDigitalForecast,digitalForecastMatches} from '../../../epistemic-runtime/src/identification';
import {compileDigitalExperimentIntent,dispatchDigitalExperiment,reconcileDigitalExperimentTx,readDigitalProvider,digitalProviderBinding,requireDisposableIdentification,type DigitalProviderBinding} from '../../../tools/src/identification-provider';
import {createFindingTx,attachEvidenceTx} from '../repository';
import {assertAuthorityTemporalBoundsTx} from '../enterprise-applications/store';
import {ApplicationFault} from '../enterprise-applications/contracts';
import {JobSchema,sha,fail,type IdentificationJob,type IdentificationRow,type ExperimentRow,type InstrumentRow} from './contracts';
import {tx,principal,newId,rootOf,identificationTx,assertRunCurrentTx,assertModelCurrentTx,familyTx,instrumentTx,instrumentValidationTx,experimentsTx,rawCheckInputTx,modelTx,evidenceTx,eventTx,consentTx,vref,allocationRef,snapshot} from './store';
import {calibrateDigitalInstrument,measureDigitalPages} from './instrument';
import {runIdentificationChild} from './process';
import {bindIdentificationPlan,chooseModelDecisionCondition,commitIdentificationDecisionTx} from './consumer';
const pause=(ms:number)=>new Promise<void>(yes=>setTimeout(yes,ms));
async function physical(c:PoolClient,p:IdentificationJob,e:Readonly<JobExecutionContext>,leases:ComputeResourceLease[],margin=0){
 const r=await c.query(`SELECT j.id FROM finnor_os.jobs j JOIN finnor_os.job_delivery_attempts d ON d.job_id=j.id
  WHERE j.id=$1 AND j.tenant_id=$2 AND j.type='identify_digital_system_v1' AND j.status='running'
   AND j.claim_token=$3 AND j.claim_fence=$4 AND j.lease_expires_at>clock_timestamp()+($7::text||' milliseconds')::interval
   AND d.id=$5 AND d.claim_token=j.claim_token AND d.claim_fence=j.claim_fence AND d.outcome='running'
   AND j.payload=$6::jsonb FOR SHARE OF j,d`,[e.jobId,p.tenantId,e.claimToken,e.claimFence,e.deliveryAttemptId,JSON.stringify(p),margin]);
 if(r.rowCount!==1)fail('X4_PHYSICAL_DELIVERY_FENCE');
 for(const l of leases){
  const live=await c.query('SELECT id FROM finnor_os.compute_resource_leases WHERE resource_key=$1 AND lease_token=$2 AND fence=$3 AND owner_id=$4 AND released_at IS NULL AND expires_at>clock_timestamp()+($5::text||\' milliseconds\')::interval FOR SHARE',
   [l.resourceKey,l.token,l.fence,l.ownerId,margin]);
  if(live.rowCount!==1)fail('X4_PHYSICAL_COMPUTE_FENCE');
 }
}
async function owned(ctx:PeMutationContext,c:PoolClient,p:IdentificationJob,e:Readonly<JobExecutionContext>,leases:ComputeResourceLease[],margin=0){
 const cap=p.stage==='DISCOVER'?'action:run_system_identification':p.stage==='REPLICATE'?'action:replicate_identified_system':'action:use_identified_system';
 const a=await identificationTx(ctx,c,p.identificationId,cap);await physical(c,p,e,leases,margin);
 if(a.generation!==p.generation||['CANCELLED','INVALIDATED'].includes(a.status))return null;
 await assertRunCurrentTx(ctx,c,a);
 if(p.stage==='DISCOVER'){
  if(a.owner_id!==p.principalId)fail('X4_ORIGINAL_JOB_ACTOR_MISMATCH');
  if(['DEVELOPMENT_READY','AWAITING_REPLICATION','OBSERVATION_ONLY_PARTIAL','UNRESOLVED'].includes(a.status))return null;
 }else{
  const table=p.stage==='REPLICATE'?'x4_assignments':'x4_uses',id=p.stage==='REPLICATE'?p.assignmentId:p.useId;
  const assignment=(await c.query(`SELECT * FROM finnor_os.${table} WHERE tenant_id=$1 AND identification_id=$2 AND id=$3 FOR UPDATE`,[p.tenantId,a.id,id])).rows[0];
  if(!assignment||assignment.actor_id!==p.principalId)fail('X4_EXACT_ASSIGNMENT_ACTOR_REQUIRED');
  if(!['QUEUED','RUNNING'].includes(assignment.status))return null;
  if(p.stage==='REPLICATE'&&a.owner_id===p.principalId)fail('X4_INDEPENDENT_REPLICATION_PRINCIPAL_REQUIRED');
 }
 return a;
}
/** Ordinary queue entry, not a callable success-inserting fixture helper. */
export async function identifyDigitalSystemJob(raw:Record<string,unknown>,execution?:Readonly<JobExecutionContext>){
 const p=JobSchema.parse(raw);
 if(!execution||execution.tenantId!==p.tenantId||execution.protocolVersion!==1)fail('X4_PHYSICAL_EXECUTION_REQUIRED');
 const e=execution,ctx:PeMutationContext={auth:{tenantId:p.tenantId,userId:p.principalId,employeeId:p.principalId,role:'owner'}};
 let leases:ComputeResourceLease[]=[],sequence=0;
 const access=(c:PoolClient,margin=0)=>owned(ctx,c,p,e,leases,margin);
 const current=async()=>!!await renewComputeResourceLeases(leases)&&tx(ctx,async c=>!!await access(c));
 async function child<T>(operation:string,body:Record<string,unknown>):Promise<T>{
  const n=++sequence,started=await tx(ctx,async c=>{
   const a=await access(c);if(!a)fail('X4_CHILD_ABORTED_OR_FENCED');
   await reserveIdentificationResourceTx(c,{tenantId:a!.tenant_id,identificationId:a!.id,principalId:p.principalId,kind:'ANALYSIS',idempotencyKey:'child:'+e.deliveryAttemptId+':'+n,detail:{operation,deliveryAttemptId:e.deliveryAttemptId,inputDigest:sha(body)}});
   await eventTx(c,a!,p.principalId,'CHILD_REGISTERED','child-register:'+e.deliveryAttemptId+':'+n,{operation,inputDigest:sha(body),inputBytes:Buffer.byteLength(JSON.stringify(body)),physicalJobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,originalDeadlineAt:a!.deadline_at.toISOString()});
   return a!;
  });
  const result=await runIdentificationChild<T>({operation,...body},started.deadline_at.getTime(),current);
  await tx(ctx,async c=>{const a=await access(c);if(!a)fail('X4_CHILD_RESULT_FENCED');await eventTx(c,a!,p.principalId,'CHILD_RESOURCES','child-resource:'+e.deliveryAttemptId+':'+n,{operation,...result.resources,completeMoney:null,aggregateMemory:null});});
  return result.result;
 }
 async function read(target:DigitalProviderBinding,surface:Parameters<typeof readDigitalProvider>[1],delivery?:{experimentId:string;operationId:string;reconciliationOnly:boolean}){
  const key=newId(),a=await tx(ctx,async c=>{
   const a=await access(c);if(!a)fail('X4_OBSERVATION_ABORTED_OR_FENCED');
   if(delivery)await eventTx(c,a,p.principalId,'DELIVERY_CLASSIFIED','delivery:'+delivery.experimentId+':'+e.deliveryAttemptId,{...delivery,ackIsObservation:false});
   await reserveIdentificationResourceTx(c,{tenantId:a!.tenant_id,identificationId:a!.id,principalId:p.principalId,kind:'OBSERVATION',idempotencyKey:'read:'+key,detail:{targetId:target.id,surface,deliveryAttemptId:e.deliveryAttemptId}});
   await eventTx(c,a!,p.principalId,'OBSERVATION_ATTEMPT','read-attempt:'+key,{targetId:target.id,surface,physicalJobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,money:null});
   return a!;
  });
  return tx(ctx,async c=>{
   const live=await access(c,Math.min(6000,Math.max(1,a.deadline_at.getTime()-Date.now())));
   if(!live)fail('X4_OBSERVATION_CURRENT_OWNER_FENCE');
   const receipt=await readDigitalProvider(target,surface,a.deadline_at.getTime());
   // The separately committed attempt survives a transport failure. Retain its
   // raw result under the same locked owner, not a third authorization cut.
   await physical(c,p,e,leases);
   await consentTx(ctx,c,live.consent_id,live.root_id);
   await assertAuthorityTemporalBoundsTx(c,[live.deadline_at.toISOString(),target.validUntil]);
   await eventTx(c,live,p.principalId,'RAW_PROVIDER_READ','read-result:'+key,{targetId:target.id,surface,receipt});
   return receipt;
  });
 }
 async function instrument(a:IdentificationRow,target:DigitalProviderBinding){
  const prior=await tx(ctx,async c=>{
   if(!await access(c))return null;
   const row=(await c.query<InstrumentRow>("SELECT * FROM finnor_os.x4_instruments WHERE tenant_id=$1 AND identification_id=$2 AND body->>'principalId'=$3 AND body->>'targetId'=$4 AND body->>'disposition'='VALIDATED_DEVELOPMENT' ORDER BY created_at DESC,id DESC LIMIT 1",[a.tenant_id,a.id,p.principalId,target.id])).rows[0];
   if(row&&Date.parse(row.body.validUntil)>Date.now()&&sha(row.body)===row.body_digest)return {row,checked:await instrumentValidationTx(c,a,row)};
   return null;
  });
  async function independentlyValidate(row:InstrumentRow){
   if(!await child<boolean>('INSTRUMENT_CHECK',{certificate:row.body}))fail('X4_INSTRUMENT_INVALID');
   await tx(ctx,async c=>{const live=await access(c);if(!live)fail('X4_INSTRUMENT_CHECK_FENCED');
    await eventTx(c,live!,p.principalId,'INSTRUMENT_INDEPENDENTLY_VALIDATED','instrument-checked:'+row.id,{instrumentId:row.id,certificateDigest:row.body_digest,
     checkerDigest:a.environment.checkerDigest,controlsDigest:sha(row.body.controls),protectedCustody:false});});
  }
  if(prior){if(!prior.checked)await independentlyValidate(prior.row);return prior.row;}
  const id=newId();
  await tx(ctx,async c=>{const live=await access(c);if(!live)fail('X4_INSTRUMENT_ASSIGNMENT_FENCED');await eventTx(c,live!,p.principalId,'INSTRUMENT_REGISTERED','instrument-register:'+id,{instrumentId:id,targetId:target.id,instanceId:target.instanceId,instrumentDigest:a.environment.instrumentDigest,controls:'LITERAL_KNOWN_FINITE_CONTROLS_BEFORE_UNKNOWN_EXPERIMENT'});});
  const measured=await calibrateDigitalInstrument({targetId:target.id,instanceId:target.instanceId,applicationVersion:target.applicationVersion,role:target.role,principalId:p.principalId},id,a.environment.instrumentDigest,
   Math.min(a.deadline_at.getTime(),Date.parse(target.validUntil)),(controlId,cursor)=>read(target,{kind:'CONTROL',controlId,cursor}));
  const row=await tx(ctx,async(c,db)=>{
   const live=await access(c);if(!live)fail('X4_INSTRUMENT_RESULT_FENCED');
   const evidence=await evidenceTx(c,db,live!,p.principalId,'instrument:'+id,'X4 raw known-control instrument evidence',measured.certificate);
   const r=(await c.query<InstrumentRow>('INSERT INTO finnor_os.x4_instruments(tenant_id,id,identification_id,body,body_digest,evidence_source_id,evidence_version_id,evidence_digest) VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING *',
    [a.tenant_id,id,a.id,JSON.stringify(measured.certificate),sha(measured.certificate),evidence.sourceId,evidence.versionId,evidence.contentHash])).rows[0]!;
   await eventTx(c,live!,p.principalId,'INSTRUMENT_MEASURED','instrument-measured:'+id,{instrumentId:id,bodyDigest:r.body_digest,errors:measured.errors,evidenceRef:vref('CORE_EVIDENCE_VERSION',evidence.sourceId,evidence.contentHash,evidence.versionId)});
   return r;
  });
  await independentlyValidate(row);
  if(measured.errors.length)fail('X4_INSTRUMENT_INVALID');
  return row;
 }
 async function register(a:IdentificationRow,target:DigitalProviderBinding,measurement:InstrumentRow,family:IdentificationFamily,analysis:IdentificationAnalysis,
  phase:DigitalExperimentProtocol['phase'],condition:DigitalCondition,selection:DigitalExperimentProtocol['selection']){
  return tx(ctx,async c=>{
   const live=await access(c);if(!live)fail('X4_PROTOCOL_ASSIGNMENT_FENCED');
   let prior:ExperimentRow|undefined;
   if(p.stage==='REPLICATE'||p.stage==='USE'){
    const assignment=(await c.query(`SELECT experiment_id FROM finnor_os.${p.stage==='REPLICATE'?'x4_assignments':'x4_uses'} WHERE tenant_id=$1 AND id=$2`,[a.tenant_id,p.stage==='REPLICATE'?p.assignmentId:p.useId])).rows[0];
    prior=(await experimentsTx(c,a)).find(e=>e.id===assignment?.experiment_id);
   }else prior=(await experimentsTx(c,a)).find(e=>e.phase===phase&&e.protocol.condition.id===condition.id);
   if(prior)return prior;
   if(Date.parse(measurement.body.validUntil)<=Date.now()||measurement.body.principalId!==p.principalId)fail('X4_INSTRUMENT_EXPIRED_BEFORE_PROTOCOL');
   const consent=await consentTx(ctx,c,a.consent_id,a.root_id),id=newId(),trial=digitalTrial(a.request.domain,condition,target.instanceId,id,a.request.domain.records.map(()=>newId()));
   const protocol:DigitalExperimentProtocol={schema:'finnor.s2.digital-discrimination-protocol.v1',identificationId:a.id,workId:a.work_id,workInputId:a.work_input_id,workInputDigest:a.work_input_digest,
    phase,condition,trial,principalId:p.principalId,targetId:target.id,familyDigest:sha(family),hypothesisRevisionDigest:sha(analysis),forecast:forecastDigitalCondition(family,analysis,a.request.domain,condition),selection,
    instrumentRef:vref('S2_INSTRUMENT',measurement.id,measurement.body_digest,measurement.body.completedAt),consentRef:vref('X4_RIGHTS',a.consent_id,consent.body_digest),
    allocationRef:allocationRef(a),
    runtimeDigest:a.environment.runtimeDigest,checkerDigest:a.environment.checkerDigest,
    assignment:{unit:'FRESH_RECORD_SET',interference:'ASSUMED_ABSENT',missingness:'REFUSE',noise:'UNSUPPORTED',absoluteTolerance:0},
    timing:{clock:'SAME_HOST_DEVELOPMENT_UTC',slots:{beforeRequest:-1,betweenRequestAndStart:1,betweenStartAndCompletion:3}},
    stopping:{maxExperiments:a.max_experiments,maxObservationCalls:a.max_observations,originalDeadlineAt:a.deadline_at.toISOString(),postHocExtension:false},
    effect:{domainActionId:newId(),businessEffectId:newId(),operationKey:'x4:'+a.id+':'+id}};
   if(['FRESH','REPLICATION','DECISION_USE'].includes(phase)&&!unanimousDigitalForecast(protocol.forecast))fail('X4_FRESH_PREDICTION_NOT_UNANIMOUS');
   await reserveIdentificationResourceTx(c,{tenantId:a.tenant_id,identificationId:a.id,principalId:p.principalId,kind:'EXPERIMENT',idempotencyKey:'experiment:'+id,detail:{phase,protocolDigest:sha(protocol),trialId:id}});
   const result=(await c.query<ExperimentRow>('INSERT INTO finnor_os.x4_experiments(tenant_id,id,identification_id,actor_id,instrument_id,phase,protocol,protocol_digest) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING *',
    [a.tenant_id,id,a.id,p.principalId,measurement.id,phase,JSON.stringify(protocol),sha(protocol)])).rows[0]!;
   if(p.stage==='REPLICATE'||p.stage==='USE')await c.query(`UPDATE finnor_os.${p.stage==='REPLICATE'?'x4_assignments':'x4_uses'} SET experiment_id=$3,status='RUNNING' WHERE tenant_id=$1 AND id=$2`,
    [a.tenant_id,p.stage==='REPLICATE'?p.assignmentId:p.useId,id]);
   await eventTx(c,live!,p.principalId,'PROTOCOL_PREREGISTERED','protocol:'+id,{experimentId:id,phase,condition,protocolDigest:sha(protocol),forecast:protocol.forecast,hypothesisRevisionDigest:protocol.hypothesisRevisionDigest,
    originalAllocation:protocol.allocationRef,effect:protocol.effect,registeredBeforeDispatch:true});
   return result;
  });
 }
 async function experiment(a:IdentificationRow,row:ExperimentRow,target:DigitalProviderBinding){
  if(row.status==='OBSERVED')return row;
  if(row.status!=='REGISTERED')fail('X4_EXPERIMENT_ALREADY_UNRESOLVED_OR_INVALID');
  const protocol=row.protocol,binding={tenantId:a.tenant_id,rootId:a.root_id,protocol};
  const plan=await bindIdentificationPlan(ctx,a,protocol,current,c=>access(c));
  if(!plan.alreadyBound){
   await tx(ctx,async c=>{
    const live=await access(c);if(!live)fail('X4_EFFECT_INTENT_FENCED');
    const authority=await evaluateAuthorityTx(ctx.auth,{operation:'action',capability:'action:digital_identification_experiment',resource:{type:'pe_deal',id:a.root_id},risk:'low'},c);
    if(authority.outcome!=='allowed')fail('X4_CURRENT_EXPERIMENT_AUTHORITY_REQUIRED',403);
    const effect=compileDigitalExperimentIntent(binding,new Date().toISOString());
    await c.query("INSERT INTO finnor_os.domain_actions(id,tenant_id,action_type,payload,status,work_id,initiated_by,authority_decision_id,authority_revision,authority_context,summary,plan_revision_id,plan_node_id) VALUES($1,$2,'digital_identification_experiment',$3::jsonb,'approved',$4,$5,$6,$7,$8::jsonb,$9,$10,$11)",
     [protocol.effect.domainActionId,a.tenant_id,JSON.stringify({protocol,protocolDigest:sha(protocol)}),a.work_id,p.principalId,authority.id,authority.authorityRevision,JSON.stringify({risk:'low',resources:[{type:'pe_deal',id:a.root_id}],outcome:'allowed'}),'Exact consented development digital experiment; not scientific acceptance',plan.id,plan.nodeId]);
    await c.query("INSERT INTO finnor_os.business_effects(id,tenant_id,domain_action_id,semantic_hash,scope_hash,operation_class,effect,status,authorized_at) VALUES($1,$2,$3,$4,$5,'external_side_effect',$6::jsonb,'authorized',clock_timestamp())",
     [effect.id,a.tenant_id,protocol.effect.domainActionId,effect.semanticHash,effect.scopeHash,JSON.stringify(effect)]);
    await c.query('UPDATE finnor_os.domain_actions SET business_effect_id=$3 WHERE tenant_id=$1 AND id=$2',[a.tenant_id,protocol.effect.domainActionId,effect.id]);
    await eventTx(c,live!,p.principalId,'S4_SELECTED_S6_ORIGINAL_EFFECT','effect:'+row.id,{experimentId:row.id,planRef:vref('S4_WORK_PLAN',plan.id,plan.digest),planNodeId:plan.nodeId,effectId:effect.id,effectDigest:effect.semanticHash});
   });
  }
  const delivery=await dispatchDigitalExperiment(binding,target,async action=>tx(ctx,async c=>{
   const live=await access(c,6000);if(!live)fail('X4_DISPATCH_OWNER_FENCE');
   const selected=(await c.query(`SELECT d.id FROM finnor_os.domain_actions d JOIN finnor_os.work_plan_revisions r ON r.tenant_id=d.tenant_id AND r.id=d.plan_revision_id
    WHERE d.tenant_id=$1 AND d.id=$2 AND d.business_effect_id=$3 AND r.status='active' AND r.work_input_id=$4 FOR SHARE OF d,r`,
    [a.tenant_id,protocol.effect.domainActionId,protocol.effect.businessEffectId,a.work_input_id])).rowCount;
   if(selected!==1)fail('X4_S4_SELECTED_ACTION_NO_LONGER_CURRENT');
   const liveInstrument=await instrumentTx(c,a,row.instrument_id);
   const bounds=[live!.deadline_at.toISOString(),liveInstrument.body.validUntil,target.validUntil];
   if(Math.min(...bounds.map(Date.parse))<=Date.now()+5000)fail('X4_ORIGINAL_DISPATCH_WINDOW_INSUFFICIENT');
   return action(async()=>{await physical(c,p,e,leases,6000);await assertAuthorityTemporalBoundsTx(c,bounds);});
  }),a.deadline_at.getTime());
  const readbacks:DigitalHttpReceipt[]=[],pages:DigitalHttpReceipt[]=[];
  let final:DigitalHttpReceipt|undefined;
  for(let n=0;n<16&&Date.now()<a.deadline_at.getTime();n++){
   const receipt=await read(target,{kind:'READBACK',trialId:row.id,cursor:null},n===0?{experimentId:row.id,operationId:delivery.operation.id,reconciliationOnly:delivery.reconciliationOnly}:undefined);readbacks.push(receipt);
   const body=receipt.body as Record<string,unknown>;
   if(receipt.status===200&&body?.status==='COMPLETE'){final=receipt;break;}
   if(receipt.status===404||receipt.status!==200||body?.status==='FAILED')break;
   await pause(70);
  }
  if(!final){
   await tx(ctx,async c=>{const live=await access(c);if(!live)return;await eventTx(c,live,p.principalId,'ORIGINAL_OPERATION_UNRESOLVED','unresolved:'+row.id+':'+e.deliveryAttemptId,{experimentId:row.id,rawReadbacks:readbacks,possibleDeliveryRetained:true,automaticMutationRetry:false});});
   fail('X4_ORIGINAL_PROVIDER_OUTCOME_UNRESOLVED');
  }
  const measurement=await instrumentTxViaOwner(a,row.instrument_id);
  let output:{records:Array<{id:string;value:string}>};
  try{
   output=await measureDigitalPages(cursor=>read(target,{kind:'OBSERVATIONS',trialId:row.id,cursor}),measurement.body,a.deadline_at.getTime(),pages,row.id,(final.body as Record<string,unknown>).completedAt as string);
  }catch(error){
   await tx(ctx,async c=>{const live=await access(c);if(!live)return;await c.query("UPDATE finnor_os.x4_experiments SET status='INVALID',raw=$3::jsonb WHERE tenant_id=$1 AND id=$2 AND status='REGISTERED'",[a.tenant_id,row.id,JSON.stringify({readbacks,pages})]);await eventTx(c,live,p.principalId,'RAW_OBSERVATION_INVALID','invalid:'+row.id,{experimentId:row.id,raw:{readbacks,pages},modelUsePermitted:false});});
   throw error;
  }
  return tx(ctx,async(c,db)=>{
   const live=await access(c);if(!live)fail('X4_OBSERVATION_COMMIT_FENCE');
   const operation=await reconcileDigitalExperimentTx(db,binding,final!),result:DigitalObservation={experimentId:row.id,conditionId:protocol.condition.id,trial:protocol.trial,records:output.records};
   const raw={readbacks,pages},evidence=await evidenceTx(c,db,live!,p.principalId,'experiment:'+row.id,'X4 actual experiment readback and complete permitted observations',{protocolDigest:row.protocol_digest,raw,result,canonicalOperationId:operation.id});
   await c.query("UPDATE finnor_os.business_effects SET status='verified',observed_at=clock_timestamp(),verification=$3::jsonb WHERE tenant_id=$1 AND id=$2",
    [a.tenant_id,protocol.effect.businessEffectId,JSON.stringify({qualification:'EXACT_ACTUAL_DELIVERY_ONLY_NOT_SCIENTIFIC_ACCEPTANCE',operationId:operation.id,readbackDigest:sha(final),evidenceVersionId:evidence.versionId})]);
   await c.query("UPDATE finnor_os.domain_actions SET status='completed' WHERE tenant_id=$1 AND id=$2",[a.tenant_id,protocol.effect.domainActionId]);
   const updated=(await c.query<ExperimentRow>("UPDATE finnor_os.x4_experiments SET status='OBSERVED',result=$3::jsonb,raw=$4::jsonb,evidence_source_id=$5,evidence_version_id=$6,evidence_digest=$7 WHERE tenant_id=$1 AND id=$2 AND status='REGISTERED' RETURNING *",
    [a.tenant_id,row.id,JSON.stringify(result),JSON.stringify(raw),evidence.sourceId,evidence.versionId,evidence.contentHash])).rows[0];
   if(!updated)fail('X4_IMMUTABLE_OBSERVATION_COMMIT_CONFLICT');
   await eventTx(c,live!,p.principalId,'ACTUAL_EXPERIMENT_OBSERVED','observed:'+row.id,{experimentId:row.id,conditionId:protocol.condition.id,phase:protocol.phase,operationId:operation.id,
    resultDigest:sha(result),rawDigest:sha(raw),evidenceRef:vref('CORE_EVIDENCE_VERSION',evidence.sourceId,evidence.contentHash,evidence.versionId)});
   return updated!;
  });
 }
 async function instrumentTxViaOwner(a:IdentificationRow,id:string){return tx(ctx,async c=>{if(!await access(c))fail('X4_MEASUREMENT_OWNER_FENCE');return instrumentTx(c,a,id);});}
 try{
  requireDisposableIdentification();
  const initial=await tx(ctx,c=>access(c));if(!initial)return;
  leases=await acquireComputeResourceLeases({tenantId:p.tenantId,resourceKeys:['native:x4-experiment'],requiredResourceKeys:['native:x4-experiment'],workloadClass:'INTERACTIVE',ownerId:'x4:'+e.deliveryAttemptId});
  e.registerHeartbeat(current, { leaseSeconds: Math.min(...leases.map(lease => lease.leaseSeconds)) });
  await tx(ctx,async c=>{
   const a=await access(c);if(!a)return;
   if(p.stage==='DISCOVER')await c.query("UPDATE finnor_os.x4_identifications SET status='DISCOVERING' WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);
   else await c.query(`UPDATE finnor_os.${p.stage==='REPLICATE'?'x4_assignments':'x4_uses'} SET status='RUNNING' WHERE tenant_id=$1 AND id=$2`,[a.tenant_id,p.stage==='REPLICATE'?p.assignmentId:p.useId]);
   await eventTx(c,a,p.principalId,'PHYSICAL_OPERATION','physical:'+e.deliveryAttemptId,{stage:p.stage,jobId:e.jobId,deliveryAttemptId:e.deliveryAttemptId,claimFence:e.claimFence,
    leases:leases.map(({token:_,...v})=>v),originalDeadlineAt:a.deadline_at.toISOString(),originalAllocationRetained:true,money:null,aggregatePeakMemory:null});
  });
  const a=await tx(ctx,c=>access(c));if(!a)return;
  let family=await tx(ctx,async c=>(await c.query<{body:IdentificationFamily;body_digest:string}>('SELECT body,body_digest FROM finnor_os.x4_families WHERE tenant_id=$1 AND identification_id=$2',[a.tenant_id,a.id])).rows[0]);
  if(!family){
   if(p.stage!=='DISCOVER')fail('X4_FAMILY_REQUIRED_BEFORE_ASSIGNMENT');
   const generated=await child<IdentificationFamily>('GENERATE',{domain:a.request.domain});
   await tx(ctx,async c=>{const live=await access(c);if(!live)fail('X4_FAMILY_PUBLICATION_FENCE');await c.query('INSERT INTO finnor_os.x4_families(tenant_id,id,identification_id,body,body_digest) VALUES($1,$2,$3,$4::jsonb,$5)',[a.tenant_id,newId(),a.id,JSON.stringify(generated),sha(generated)]);
    await eventTx(c,live!,p.principalId,'COMPLETE_GRAMMAR_GENERATED','family',{familyDigest:sha(generated),predicateClasses:generated.predicates.length,rawSyntaxCount:generated.rawSyntaxCount,numericProgrammes:generated.numeric.length,representation:generated.representation,independentClosureCheck:'REQUIRED_BEFORE_MODEL_PUBLICATION_NOT_YET_PERFORMED'});});
   family={body:generated,body_digest:sha(generated)};
  }
  if(sha(family.body)!==family.body_digest)fail('X4_FAMILY_INTEGRITY');
  const f=family.body,targetId=p.stage==='REPLICATE'?a.request.replicationTargetId:a.request.sourceTargetId,
   target=await digitalProviderBinding({tenantId:a.tenant_id,rootId:a.root_id,principalId:p.principalId,targetId}),measurement=await instrument(a,target);
  if(p.stage==='DISCOVER'){
   for(let step=0;step<64;step++){
    const history=await tx(ctx,async c=>{if(!await access(c))return null;return experimentsTx(c,a);});if(!history)return;
    const pending=history.find(x=>x.status==='REGISTERED'&&x.actor_id===p.principalId);
    if(pending){await experiment(a,pending,target);continue;}
    if(history.some(x=>x.status!=='OBSERVED'))fail('X4_FAILED_EXPERIMENT_PREVENTS_CHECKED_RELEASE');
    const observations=history.map(h=>h.result!),next=await child<{analysis:IdentificationAnalysis;selection:ReturnType<typeof import('../../../epistemic-runtime/src/identification').selectDigitalExperiment>}>('NEXT',{domain:a.request.domain,family:f,observations});
    if(!next.analysis.predicateIds.length||!next.analysis.numericIds.length){
     await tx(ctx,async c=>{const live=await access(c);if(!live)return;await c.query("UPDATE finnor_os.x4_identifications SET status='UNRESOLVED' WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);await eventTx(c,live,p.principalId,'REPRESENTATION_REFUTED','representation-refuted',{analysis:next.analysis,searchExhaustionIsNonIdentifiability:false});});return;
    }
    await tx(ctx,async c=>{const live=await access(c);if(live)await eventTx(c,live,p.principalId,'HYPOTHESES_UPDATED','analysis:'+sha(observations),{analysis:next.analysis,survivingCartesianProduct:String(next.analysis.predicateIds.length*next.analysis.numericIds.length),equivalentAlternativesRetained:true});});
    if(history.some(h=>h.phase==='FRESH')){
     await tx(ctx,async c=>{const live=await access(c);if(!live)return;await c.query("UPDATE finnor_os.x4_identifications SET status='AWAITING_REPLICATION' WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);await eventTx(c,live,p.principalId,'FRESH_PREDICTION_CONFIRMED','fresh-confirmed',{freshExperimentId:history.find(h=>h.phase==='FRESH')!.id,analysisDigest:sha(next.analysis),awaitingIndependentPrincipalAndInstance:true});});return;
    }
    if(history.length&&a.request.mode==='OBSERVATION_ONLY'){
     await tx(ctx,async c=>{const live=await access(c);if(!live)return;await c.query("UPDATE finnor_os.x4_identifications SET status='OBSERVATION_ONLY_PARTIAL' WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);await eventTx(c,live,p.principalId,'OBSERVATION_ONLY_PARTIAL','passive',{analysis:next.analysis,causalContrastEstablished:false,modelPublished:false,notStrongestIncumbent:true});});return;
    }
    const cs=digitalConditions(a.request.domain),ordinary=cs.find(c=>conditionMatches(c,a.request.domain.ordinary))!,withheld=cs.find(c=>conditionMatches(c,a.request.domain.withheld))!;
    let phase:DigitalExperimentProtocol['phase'],condition:DigitalCondition,selection:DigitalExperimentProtocol['selection'];
    if(!history.length){phase='BASELINE';condition=ordinary;selection={criterion:'REGISTERED_ORDINARY',scores:[]};}
    else if(next.selection.condition){phase='DISCOVERY';condition=next.selection.condition;selection={criterion:'FINITE_MINIMAX_ELIMINATION_PER_COST',scores:next.selection.scores};}
    else{
     const forecast=forecastDigitalCondition(f,next.analysis,a.request.domain,withheld);
     if(!unanimousDigitalForecast(forecast)){
      await tx(ctx,async c=>{const live=await access(c);if(!live)return;await c.query("UPDATE finnor_os.x4_identifications SET status='UNRESOLVED' WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);await eventTx(c,live,p.principalId,'FINITE_SEARCH_EXHAUSTED','search-exhausted',{analysis:next.analysis,withheldForecast:forecast,globalNonIdentifiabilityProved:false});});return;
     }
     phase='FRESH';condition=withheld;selection={criterion:'WITHHELD_FRESH',scores:[]};
    }
    const protocol=await register(a,target,measurement,f,next.analysis,phase,condition,selection);
    const observed=await experiment(a,protocol,target);
    if(phase==='FRESH'){
     if(!digitalForecastMatches(protocol.protocol.forecast,protocol.protocol.trial,observed.result!.records))fail('X4_FRESH_PREDICTION_FAILED');
     await tx(ctx,async c=>{
      const live=await access(c);if(!live)fail('X4_FRESH_CONFIRMATION_FENCED');
      await c.query("UPDATE finnor_os.x4_identifications SET status='AWAITING_REPLICATION' WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);
      await eventTx(c,live,p.principalId,'FRESH_PREDICTION_CONFIRMED','fresh-confirmed',{freshExperimentId:observed.id,confirmedForecastDigest:sha(protocol.protocol.forecast),awaitingIndependentPrincipalAndInstance:true});
     });return;
    }
   }
   fail('X4_ORIGINAL_EXPERIMENT_BOUND_EXHAUSTED');
  }else if(p.stage==='REPLICATE'){
   const history=await tx(ctx,c=>experimentsTx(c,a)),fresh=history.find(e=>e.phase==='FRESH'&&e.status==='OBSERVED');
   if(!fresh)fail('X4_FRESH_PROTOCOL_REQUIRED_FOR_REPLICATION');
   const assignment=(await tx(ctx,c=>c.query('SELECT experiment_id FROM finnor_os.x4_assignments WHERE tenant_id=$1 AND id=$2',[a.tenant_id,p.assignmentId]))).rows[0];
   const prior=history.filter(e=>e.status==='OBSERVED'&&e.phase!=='DECISION_USE'&&e.id!==assignment?.experiment_id).map(e=>e.result!),
    analysis=await child<IdentificationAnalysis>('ANALYZE',{family:f,observations:prior});
   const protocol=await register(a,target,measurement,f,analysis,'REPLICATION',fresh.protocol.condition,{criterion:'INDEPENDENT_REPLICATION',scores:[]}),observed=await experiment(a,protocol,target);
   if(!digitalForecastMatches(protocol.protocol.forecast,protocol.protocol.trial,observed.result!.records))fail('X4_INDEPENDENT_REPLICATION_FAILED');
   const input=await tx(ctx,c=>rawCheckInputTx(c,a)),checked=await child<IdentificationIndependentCheck>('CHECK',{input});
   await tx(ctx,async(c,db)=>{
    const live=await access(c);if(!live)fail('X4_CHECKED_MODEL_PUBLICATION_FENCED');
    const nowInput=await rawCheckInputTx(c,live!);
    if(sha(nowInput)!==checked.inputDigest||sha(input)!==checked.inputDigest||checked.disposition!=='SUPPORTED_DEVELOPMENT')fail('X4_INDEPENDENT_CHECK_BINDING');
    const modelId=newId();
    {
     const checkEvidence=await evidenceTx(c,db,live!,p.principalId,'check:'+modelId,'X4 independently checked finite-domain scientific finding',{question:a.request.question,domainDigest:sha(a.request.domain),familyDigest:sha(f),check:checked,
      rawExperimentEvidence:nowInput.experiments.map(e=>({experimentId:e.protocol.trial.id,rawDigest:sha(e.raw),protocolDigest:sha(e.protocol),operationId:e.effectObservation.operationId}))});
     const finding=await createFindingTx(c,ctx,{dealId:a.root_id,workstreamId:a.request.decision.workstreamId,
      statement:JSON.stringify({kind:'CHECKED_FINITE_DIGITAL_IDENTIFICATION',claimClass:checked.claimClass,question:a.request.question,domainDigest:sha(a.request.domain),
       checkDigest:sha(checked),checkInputDigest:checked.inputDigest,familyDigest:sha(f),survivingCartesianProduct:String(checked.analysis.predicateIds.length*checked.analysis.numericIds.length),
       uniqueHiddenMechanism:false,productionTransport:false,conditionalAssumptions:a.request.domain.assumptions}),
      severity:'medium',materiality:'non_material',owner:{partyType:'employee',partyId:a.owner_id},requiredForWorkstreamCompletion:false});
     await attachEvidenceTx(c,ctx,{dealId:a.root_id,entity:{entityType:'pe_finding',entityId:String(finding.row.id)},evidenceSourceId:checkEvidence.sourceId,evidenceVersionId:checkEvidence.versionId,relationship:'verifies'});
     const all=(await experimentsTx(c,a)).filter(e=>nowInput.experiments.some(v=>v.protocol.trial.id===e.id)),instrumentIds=[...new Set(all.map(e=>e.instrument_id))],instruments=await Promise.all(instrumentIds.map(id=>instrumentTx(c,a,id)));
     const validUntil=new Date(Math.min(a.deadline_at.getTime(),...instruments.map(i=>Date.parse(i.body.validUntil)))).toISOString();
     const model:IdentifiedSystemRelease={schema:'finnor.identified-system-model.v1',id:modelId,identificationId:a.id,tenantId:a.tenant_id,principalId:a.owner_id,replicatorId:p.principalId,
      question:a.request.question,domain:a.request.domain,family:f,analysis:checked.analysis,familyDigest:sha(f),check:checked,checkDigest:sha(checked),
      instrumentRefs:instruments.flatMap(i=>[vref('S2_INSTRUMENT',i.id,i.body_digest,i.body.completedAt),vref('CORE_EVIDENCE_VERSION',i.evidence_source_id,i.evidence_digest,i.evidence_version_id)]),
      experimentRefs:all.map(e=>vref('S2_EXPERIMENT',e.id,e.protocol_digest)),observationRefs:[...all.map(e=>vref('CORE_EVIDENCE_VERSION',e.evidence_source_id!,e.evidence_digest!,e.evidence_version_id!)),vref('CORE_EVIDENCE_VERSION',checkEvidence.sourceId,checkEvidence.contentHash,checkEvidence.versionId)],
      freshPredictionRefs:all.filter(e=>e.phase==='FRESH').map(e=>vref('S2_EXPERIMENT',e.id,e.protocol_digest)),replicationRefs:all.filter(e=>e.phase==='REPLICATION').map(e=>vref('S2_EXPERIMENT',e.id,e.protocol_digest)),
      canonicalFindingRef:vref('PE_FINDING',String(finding.row.id),sha(snapshot(finding.row)),String(finding.row.version)),
      environment:{sourceDigest:a.environment.sourceDigest,checkerDigest:a.environment.checkerDigest,lockDigest:a.environment.lockDigest,schemaDigest:a.environment.schemaDigest,runtimeDigest:a.environment.runtimeDigest},
      createdAt:new Date().toISOString(),validUntil,achievedClaimClass:checked.claimClass,
      requestedClaimSatisfied:a.request.question.requestedClaimClass==='PREDICTIVE'||a.request.question.requestedClaimClass===checked.claimClass,
      equivalence:{scope:'EXACT_REGISTERED_FINITE_DOMAIN',survivingCartesianProduct:String(checked.analysis.predicateIds.length*checked.analysis.numericIds.length),uniqueHiddenMechanism:false},
      searchBoundary:{grammarCompleteWithinDomain:true,globalIdentifiabilityEstablished:false,noiseSupported:false,absoluteTolerance:0},
      qualification:'E2E_DEVELOPMENT_NOT_PROTECTED',productionActive:false,protectedAdmission:false};
     await c.query('INSERT INTO finnor_os.x4_models(tenant_id,id,identification_id,body,body_digest,dependencies) VALUES($1,$2,$3,$4::jsonb,$5,$6::jsonb)',[a.tenant_id,modelId,a.id,JSON.stringify(model),sha(model),JSON.stringify(a.dependencies)]);
    }
    await c.query("UPDATE finnor_os.x4_assignments SET status='COMPLETE',result=$3::jsonb WHERE tenant_id=$1 AND id=$2 AND status IN('QUEUED','RUNNING')",[a.tenant_id,p.assignmentId,JSON.stringify({modelId,experimentId:observed.id,checkDigest:sha(checked),checkInputDigest:checked.inputDigest,independentPrincipal:p.principalId,disposition:'SUPPORTED_DEVELOPMENT'})]);
    await c.query("UPDATE finnor_os.x4_identifications SET status='DEVELOPMENT_READY',head_model_id=$3 WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id,modelId]);
    await eventTx(c,live!,p.principalId,'CHECKED_MODEL_PUBLISHED_DEVELOPMENT','model:'+p.assignmentId,{modelId,assignmentId:p.assignmentId,checkDigest:sha(checked),disposition:checked.disposition,protectedAdmission:false,productionActive:false});
    await assertAuthorityTemporalBoundsTx(c,[a.deadline_at.toISOString(),measurement.body.validUntil,target.validUntil]);
   });
  }else{
   const start=await tx(ctx,async c=>{const live=await access(c);if(!live)return null;const u=(await c.query('SELECT * FROM finnor_os.x4_uses WHERE tenant_id=$1 AND id=$2',[a.tenant_id,p.useId])).rows[0]!,m=await modelTx(c,a,u.model_id);await assertModelCurrentTx(ctx,c,live,m.body);return m.body;});
   if(!start)return;
   const choice=chooseModelDecisionCondition(start);
   if(!choice){await tx(ctx,async c=>{const live=await access(c);if(live)await commitIdentificationDecisionTx(ctx,c,live,start,p.useId,null,'NO_CURRENT_SUPPORTED_COMPLETE_EXPORT_CONDITION');});return;}
   const protocol=await register(a,target,measurement,f,start.analysis,'DECISION_USE',choice.condition,{criterion:'CURRENT_DECISION_USE',scores:[]}),observed=await experiment(a,protocol,target);
   await tx(ctx,async c=>{const live=await access(c);if(!live)fail('X4_DECISION_COMMIT_FENCED');await commitIdentificationDecisionTx(ctx,c,live!,start,p.useId,observed);});
  }
 }catch(error){
  if(error instanceof ComputeCapacityUnavailableError)throw error;
  let waitCommitted=false;
  try{waitCommitted=(await tx(ctx,async c=>{
   await physical(c,p,e,[]);
   const a=(await c.query<IdentificationRow>('SELECT * FROM finnor_os.x4_identifications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',[p.tenantId,p.identificationId])).rows[0];
   if(!a||a.generation!==p.generation||['CANCELLED','INVALIDATED'].includes(a.status))return;
   const failure=error as {message?:string;physicalPid?:number;exitCode?:number|null;signal?:string|null;supervisorWallMs?:number;sampledPeakRSSBytes?:number;outputBytes?:number};
   const code=error instanceof ApplicationFault?error.code:/^X4_[A-Z0-9_]+$/.test(failure.message??'')?failure.message!:'X4_HOST_OPERATION_FAILED';
   let canonicalWait=false;
   if(p.stage==='DISCOVER')await c.query("UPDATE finnor_os.x4_identifications SET status='WAITING' WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);
   else if(p.stage==='USE'){
    const scoped=await identificationTx(ctx,c,a.id,'action:use_identified_system');
    if(scoped.owner_id!==p.principalId)fail('X4_CURRENT_ORIGINAL_DECISION_PRINCIPAL_REQUIRED');
    const use=(await c.query('SELECT model_id,experiment_id,status FROM finnor_os.x4_uses WHERE tenant_id=$1 AND identification_id=$2 AND id=$3 FOR UPDATE',[a.tenant_id,a.id,p.useId])).rows[0];
    if(!use||!['QUEUED','RUNNING'].includes(use.status))return;
    const model=await modelTx(c,a,use.model_id),experiment=(await experimentsTx(c,a)).find(v=>v.id===use.experiment_id)??null;
    await commitIdentificationDecisionTx(ctx,c,scoped,model.body,p.useId,experiment,code);
    canonicalWait=true;
   }else{
    await c.query("UPDATE finnor_os.x4_assignments SET status='FAILED',result=$3::jsonb WHERE tenant_id=$1 AND id=$2 AND status IN('QUEUED','RUNNING')",
     [a.tenant_id,p.assignmentId,JSON.stringify({error:code,originalEffectsRetained:true,unknownPhysicalCostPossible:true})]);
    await c.query("UPDATE finnor_os.x4_identifications SET status='INVALIDATED',generation=generation+1 WHERE tenant_id=$1 AND id=$2",[a.tenant_id,a.id]);
   }
   await eventTx(c,a,p.principalId,'OPERATION_FAILED','failure:'+e.deliveryAttemptId,{stage:p.stage,error:code,originalAllocationRetained:true,automaticMutationRetry:false,unknownPhysicalCostPossible:true,
    physicalReceipt:failure.physicalPid?{pid:failure.physicalPid,exitCode:failure.exitCode??null,signal:failure.signal??null,wallMs:failure.supervisorWallMs??null,sampledPeakRSSBytes:failure.sampledPeakRSSBytes??null,outputBytes:failure.outputBytes??null}:null});
   return canonicalWait;
  }))===true;}catch{/* A revoked or stale physical owner cannot publish over a successor. */}
  if(waitCommitted)return;
  throw error;
 }finally{await releaseComputeResourceLeases(leases,'x4_operation_finished').catch(()=>undefined);}
}

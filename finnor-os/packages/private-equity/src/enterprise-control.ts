import { constants } from 'node:fs';
import { mkdir, open, link, unlink, lstat,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { withTenantTransaction } from '@finnor/db';
import type { ContingentPolicy, ContingentChoiceHandoff, ControlDecisionInput, ControlProblem, EconomicMandate, ExperimentProtocol, ExperimentRef, S4ExperienceEvent } from '@finnor/shared-types';
import { assertContingentPolicy, AllocationContractError, ControlContractError, createInterventionControlAdapter, controlInstrumentSupports, controlSourcesCurrent, decideContingentPolicy, epistemicHash,
 ExperimentRefSchema, immutableControl, interventionSpecificationRef, parseControlDecision, parseControlProblem, parseEconomicMandate, prepareS4Experience, restoreInterventionControlAdapter, synthesizeContingentControl, checkPolicyAllocation, type InterventionControlSnapshot } from '@finnor/epistemic-runtime';
import { readEnterpriseInterventionMetadataForObservation, resolveEnterpriseInterventionModelForControl } from './enterprise-interventions';
import { loadEnterpriseBeliefView, validateBeliefViewPin } from './enterprise-beliefs';
import { validateEnterpriseExperiment, projectEnterpriseExperiment, projectEnterpriseControlObservation } from './enterprise-experiments';
import { PeDomainError, type PeMutationContext, type PeWorldRootRef } from './types';
import {enqueueNativeReferences,enqueueNativePreparedEvents,enqueueNativeMandate,nativeRecordReference,nativeReference,nativeOwnerTransportConfigured} from './native-experience-transport';

const actor=(ctx:PeMutationContext)=>ctx.auth.employeeId??ctx.auth.userId;
const unavailable=()=>new PeDomainError('PE_ENTITY_NOT_FOUND','Permitted S4 context is unavailable');
function storeRoot():string {if(!process.env.FINNOR_S4_POLICY_STORE)throw new ControlContractError('INVALID_REQUEST','S4 private proposal store is not configured');return resolve(process.env.FINNOR_S4_POLICY_STORE);}
function directory(ctx:PeMutationContext):string {if(![ctx.auth.tenantId,actor(ctx)].every(id=>/^[a-f0-9-]{36}$/i.test(id)))throw unavailable();return join(storeRoot(),ctx.auth.tenantId,actor(ctx));}
async function privateDirectory(path:string):Promise<void>{await mkdir(path,{recursive:true,mode:0o700});const info=await lstat(path),uid=process.getuid?.();if(info.isSymbolicLink()||!info.isDirectory()||uid===undefined||info.uid!==uid||(info.mode&0o077)!==0)throw unavailable();}
async function checkedStore(ctx:PeMutationContext):Promise<void>{const path=directory(ctx);await privateDirectory(storeRoot());await privateDirectory(join(storeRoot(),ctx.auth.tenantId));await privateDirectory(path);}
async function saveArtifact(ctx:PeMutationContext,category:string,digest:string,value:unknown):Promise<void>{
 if(!/^[a-f0-9]{64}$/.test(digest))throw new ControlContractError('INVALID_POLICY','Invalid S4 artifact reference');await checkedStore(ctx);const dir=join(directory(ctx),category);await privateDirectory(dir);
 const body=JSON.stringify(value);if(Buffer.byteLength(body)>8*1024*1024)throw new ControlContractError('LIMIT_EXCEEDED','S4 artifact exceeds 8 MiB');const temporary=join(dir,`.${randomUUID()}.tmp`),target=join(dir,`${digest}.json`);
 const file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o400);try{await file.writeFile(body);await file.sync();}finally{await file.close();}
 try{await link(temporary,target);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const prior=await open(target,constants.O_RDONLY|constants.O_NOFOLLOW);try{if(!(await prior.stat()).isFile()||(await prior.stat()).size>8*1024*1024||await prior.readFile('utf8')!==body)throw new ControlContractError('INVALID_POLICY','Conflicting immutable S4 artifact');}finally{await prior.close();}}finally{await unlink(temporary).catch(()=>undefined);}
 if(category!=='prepared-experience'&&await nativeOwnerTransportConfigured(ctx,'S4')){
  const record=nativeRecordReference(value),data=value as any;
  const rightsRef=data.rightsRef??data.mandate?.rightsRef??(data.policyRef?(await readPolicy(ctx,data.policyRef)).mandate.rightsRef:null);
  if(record&&rightsRef)await enqueueNativeReferences(ctx,[record],[rightsRef]);
 }
}
async function publishEventReferences(ctx:PeMutationContext,events:readonly S4ExperienceEvent[]){
 await enqueueNativeReferences(ctx,events.flatMap(event=>{
  const detail=event.detail as any,compute=detail.compute;
  const choices=[detail.choice,detail.handoff?.decision].map(nativeRecordReference).filter((ref):ref is NonNullable<typeof ref>=>ref!==null);
  return [...(compute?.id?[nativeReference('S4',compute.id,compute,'model-compute-v1')]:[]),...choices];
 }),events.map(e=>e.rightsRef));
}
async function saveEvents(ctx:PeMutationContext,events:readonly S4ExperienceEvent[]):Promise<void>{for(const event of events)await saveArtifact(ctx,'prepared-experience',event.eventId.replace('s4-event:',''),event);await publishEventReferences(ctx,events);await enqueueNativePreparedEvents(ctx,'S4',events);}
async function recoverPolicyExperience(ctx:PeMutationContext,policy:ContingentPolicy){
 if(!await nativeOwnerTransportConfigured(ctx,'S4'))return;
 await enqueueNativeMandate(ctx,policy.mandate);const reference=nativeRecordReference(policy)!;
 await enqueueNativeReferences(ctx,[reference], [policy.mandate.rightsRef]);
 const dir=join(directory(ctx),'prepared-experience');let names:string[];try{names=await readdir(dir);}catch(e:any){if(e.code==='ENOENT')return;throw e;}
 if(names.length>256)throw new ControlContractError('LIMIT_EXCEEDED','S4 prepared history requires bounded operator pagination');
 const events:S4ExperienceEvent[]=[];for(const name of names.sort()){
  if(!/^[a-f0-9]{64}\.json$/.test(name))throw unavailable();const fd=await open(join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const st=await fd.stat();if(!st.isFile()||st.size>8*1024*1024)throw unavailable();const event=JSON.parse(await fd.readFile('utf8'));if(event.eventId!==`s4-event:${name.slice(0,-5)}`)throw unavailable();if(event.tenantId===ctx.auth.tenantId&&event.principalId===actor(ctx)&&event.dependencyRefs?.includes(policy.mandate.ref.id)&&event.revisionRef===policy.ref.id)events.push(event);}finally{await fd.close();}
 }
 await publishEventReferences(ctx,events);await enqueueNativePreparedEvents(ctx,'S4',events);
}
async function readArtifact(ctx:PeMutationContext,category:string,digest:string):Promise<any>{
 try{if(!/^[a-f0-9]{64}$/.test(digest))throw unavailable();await checkedStore(ctx);await privateDirectory(join(directory(ctx),category));const file=await open(join(directory(ctx),category,`${digest}.json`),constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=await file.stat();if(!info.isFile()||info.size>8*1024*1024)throw unavailable();return JSON.parse(await file.readFile('utf8'));}finally{await file.close();}
 }catch{throw unavailable();}
}
async function readPolicy(ctx:PeMutationContext,value:unknown):Promise<ContingentPolicy>{const parsed=ExperimentRefSchema.safeParse(value);if(!parsed.success||parsed.data.owner!=='S4'||parsed.data.version!=='s4-finite-contingent-v1'||parsed.data.id!==`contingent-policy:${parsed.data.contentDigest}`)throw unavailable();
 try{await checkedStore(ctx);await privateDirectory(join(directory(ctx),'policies'));const file=await open(join(directory(ctx),'policies',`${parsed.data.contentDigest}.json`),constants.O_RDONLY|constants.O_NOFOLLOW);let policy:ContingentPolicy;
  try{if(!(await file.stat()).isFile()||(await file.stat()).size>8*1024*1024)throw unavailable();const data:unknown=JSON.parse(await file.readFile('utf8'));assertContingentPolicy(data);policy=data;}finally{await file.close();}
  if(policy.tenantId!==ctx.auth.tenantId||policy.principalId!==actor(ctx)||epistemicHash(policy.ref)!==epistemicHash(parsed.data))throw unavailable();return policy;
 }catch{throw unavailable();}}
async function readable(ctx:PeMutationContext,policy:ContingentPolicy):Promise<void>{for(const pin of policy.bindings.beliefPins)await loadEnterpriseBeliefView(ctx,{root:pin.root as PeWorldRootRef});await recoverPolicyExperience(ctx,policy);}
async function current(ctx:PeMutationContext,policy:ContingentPolicy):Promise<string|null>{
 if(Date.now()>=Date.parse(policy.validUntil))return 'POLICY_EXPIRED';if(!await controlSourcesCurrent(policy.compute.backend.sourceDigests))return 'S4_LOADED_METHOD_CHANGED';
 for(const pin of policy.bindings.beliefPins)if((await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')return 'S1_SOURCE_RIGHTS_COVERAGE_OR_INTERPRETATION_CHANGED';
 try{await resolveEnterpriseInterventionModelForControl(ctx,policy.bindings.modelRef);}catch{return 'S3_MODEL_REVISED_REVOKED_OR_UNSUPPORTED';}
 return null;
}
/** Existing durable effects are independently read. A caller cannot hide an
 * unknown pending effect by sending an empty obligation list. No S6 is invented. */
async function unresolvedEffects(ctx:PeMutationContext):Promise<number>{const result=await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx),readOnly:true},(_db,c)=>c.query("SELECT count(*)::int count FROM finnor_os.business_effects WHERE tenant_id=$1 AND status NOT IN ('verified','cancelled','compensated')",[ctx.auth.tenantId]));return result.rows[0].count;}
export async function synthesizeEnterpriseControl(ctx:PeMutationContext,input:{mandate?:unknown;problem?:unknown;protocols:unknown[];scenarios:{pathsPerMechanism:number;seed:number};priorPolicyRef?:unknown;reason?:string}):Promise<Awaited<ReturnType<typeof synthesizeContingentControl>>|{schema:'finnor.s4.policy-result.v1';status:'UNCERTAINTY_UNRESOLVED'|'MODEL_UNSUPPORTED'|'NUMERICAL_FAILURE'|'SEARCH_EXHAUSTED';policy:null;reasons:string[];experience:S4ExperienceEvent[];compute:unknown}> {
 const ownerStartedAt=performance.now(),m=parseEconomicMandate(input.mandate),p=parseControlProblem(input.problem);await checkedStore(ctx);
 if(ctx.auth.role!=='owner'||m.tenantId!==ctx.auth.tenantId||m.principalId!==actor(ctx)||m.businessOwnerRef.owner!=='BUSINESS_OWNER'||m.businessOwnerRef.id!==actor(ctx))throw unavailable();
 await enqueueNativeMandate(ctx,m);const problemRef=nativeReference('S4',`control-problem:${epistemicHash(p)}`,p,'s4-control-problem-v1');await enqueueNativeReferences(ctx,[problemRef],[m.rightsRef]);
 const prior=input.priorPolicyRef?await readPolicy(ctx,input.priorPolicyRef):null;if(prior)await readable(ctx,prior);
 const model=await resolveEnterpriseInterventionModelForControl(ctx,p.modelRef);
 const elapsed=p.continuation?.elapsedPeriods??0;
 if(prior&&(m.episodeId!==prior.episodeId||epistemicHash(m.horizon)!==epistemicHash(prior.mandate.horizon)||elapsed<(prior.problem.continuation?.elapsedPeriods??0)))throw new ControlContractError('INVALID_REQUEST','A linked policy revision cannot reset its episode, elapsed history or original consequence horizon');
 if(Date.parse(m.horizon.startAt)+elapsed*m.horizon.periodMs!==Date.parse(model.request.time.endAt)||m.horizon.periodMs!==model.request.time.periodMs||m.horizon.periods-elapsed>model.request.validity.maximumHorizon||elapsed&&!prior)throw new ControlContractError('INVALID_REQUEST','Mandate full horizon or linked continuation does not match the qualified S3 history cut');
 if(prior&&p.continuation&&(epistemicHash(m.utility)!==epistemicHash(prior.mandate.utility)||epistemicHash(m.horizon)!==epistemicHash(prior.mandate.horizon)))throw new ControlContractError('INVALID_REQUEST','A continuation cannot reinterpret the earlier utility or shorten its consequences');
 const protocols=input.protocols as ExperimentProtocol[];
 for(const protocol of protocols)if((await validateEnterpriseExperiment(ctx,protocol)).status!=='CURRENT')throw unavailable();
 const early=async(status:'UNCERTAINTY_UNRESOLVED'|'MODEL_UNSUPPORTED'|'NUMERICAL_FAILURE'|'SEARCH_EXHAUSTED',reason:string,compute:unknown=null)=>{const experience=[prepareS4Experience(m,'REJECTION',problemRef.id,{status,reason,originalProblemId:p.id,modelRef:model.ref,compute})];await saveEvents(ctx,experience);return {schema:'finnor.s4.policy-result.v1' as const,status,policy:null,reasons:[reason],experience,compute};};
 if(prior&&prior.problem.obligations.filter(o=>o.status!=='SETTLED'||o.terminalLiability!==0).some(o=>!p.obligations.some(next=>epistemicHash(next)===epistemicHash(o))))return early('UNCERTAINTY_UNRESOLVED','EARLIER_OBLIGATION_CANNOT_BE_DROPPED_REVERSED_OR_RELABELED_WITHOUT_S6_OWNER_RECONCILIATION');
 if(await unresolvedEffects(ctx))return early('UNCERTAINTY_UNRESOLVED','UNMODELED_OUTSTANDING_DURABLE_EFFECTS_REQUIRE_S6_EXPOSURE_RESOURCE_AND_LIABILITY_RECONCILIATION');
 if(m.ambiguity.kind==='UNRESOLVED')return early('UNCERTAINTY_UNRESOLVED','MANDATE_HAS_NO_AUTHORIZED_AMBIGUITY_SEMANTICS');
 if(performance.now()-ownerStartedAt>=m.search.deadlineMs)return early('SEARCH_EXHAUSTED','OWNER_RESOLUTION_CONSUMED_DECISION_DEADLINE');
 const kernel=await createInterventionControlAdapter(model,{context:p.context,regime:p.regime,horizon:m.horizon.periods-elapsed,...input.scenarios},m.search.deadlineMs-(performance.now()-ownerStartedAt));
 if(!kernel.adapter)return early(/IDENTIFICATION/.test(kernel.reason??'')?'UNCERTAINTY_UNRESOLVED':/BUSY|BUDGET|LIMIT|TIMEOUT/.test(kernel.reason??'')?'SEARCH_EXHAUSTED':/BACKEND/.test(kernel.reason??'')?'NUMERICAL_FAILURE':'MODEL_UNSUPPORTED',kernel.reason??'S3_JOINT_KERNEL_UNAVAILABLE',kernel.compute);
 const instruments=controlInstrumentSupports(protocols,model,m,p);
 for(const observation of p.continuation?.observations??[]){const instrument=p.observations.find(i=>i.id===observation.instrumentId);if(!instrument)return early('UNCERTAINTY_UNRESOLVED','OLD_INQUIRY_REALIZATION_TO_REVISED_S3_MECHANISM_TRANSPORT_UNJUSTIFIED',kernel.compute);const period=observation.availablePeriod-instrument.delayPeriods,start=Date.parse(m.horizon.startAt)+period*m.horizon.periodMs;
  if(period<0)throw new ControlContractError('INVALID_REQUEST','Temporal observation precedes the episode');const r=await projectEnterpriseControlObservation(ctx,{instrument,problem:p,model,periodStart:new Date(start).toISOString(),periodEnd:new Date(start+m.horizon.periodMs).toISOString(),availablePeriod:observation.availablePeriod});
  if(epistemicHash(r.ref)!==epistemicHash(observation.sourceRef)||r.token!==observation.token||Date.parse(r.knowledgeAt)>Date.parse(observation.knowledgeAt))throw new ControlContractError('INVALID_REQUEST','Continuation observation is not a current permitted S2 source realization');}
 const artifact={problem:p,protocols,kernelRef:kernel.adapter.ref,kernelCompute:kernel.compute},inputDigest=epistemicHash(artifact);
 await enqueueNativeReferences(ctx,[nativeReference('S4',`control-input:${inputDigest}`,artifact,'s4-input-v1')],[m.rightsRef]);
 const result=await synthesizeContingentControl({inputArtifactRef:{owner:'S4',id:`control-input:${inputDigest}`,version:'s4-input-v1',contentDigest:inputDigest},budgetStartedAt:ownerStartedAt,mandate:m,problem:p,dynamics:kernel.adapter,instruments,beliefPins:[...model.beliefBindings.map(b=>b.pin),...protocols.map(p=>p.beliefBinding.pin)],priorPolicyRef:prior?.ref??null,validUntilCap:new Date(Math.min(Date.parse(model.request.validity.validUntil),...protocols.map(p=>Date.parse(p.validUntil)))).toISOString()});
 await resolveEnterpriseInterventionModelForControl(ctx,p.modelRef);for(const protocol of protocols)if((await validateEnterpriseExperiment(ctx,protocol)).status!=='CURRENT')throw unavailable();
 const events=[...result.experience];if(prior)events.push(prepareS4Experience(m,'POLICY_REVISION',result.policy?.ref.id??p.id,{reason:input.reason??'Supplied linked revision',priorPolicyRef:prior.ref,newPolicyRef:result.policy?.ref??null,ordinaryReplanNotMethodAdmission:true},[prior.ref.id]));
 await saveEvents(ctx,events);await saveArtifact(ctx,'results',epistemicHash(result),result);
 if(result.policy){await saveArtifact(ctx,'mandates',m.ref.contentDigest,m);await saveArtifact(ctx,'demands',result.policy.demand.contentDigest,result.policy.demand);await saveArtifact(ctx,'kernels',kernel.snapshot!.ref.contentDigest,kernel.snapshot);await saveArtifact(ctx,'inputs',inputDigest,artifact);await saveArtifact(ctx,'policies',result.policy.ref.contentDigest,result.policy);if(await current(ctx,result.policy))throw unavailable();}
 return {...result,experience:events};
}
export async function readEnterpriseContingentPolicy(ctx:PeMutationContext,value:unknown):Promise<ContingentPolicy>{const policy=await readPolicy(ctx,value);await readable(ctx,policy);if(await current(ctx,policy))throw unavailable();await recoverPolicyExperience(ctx,policy);return immutableControl(policy);}
export async function replayEnterpriseContingentPolicy(ctx:PeMutationContext,value:unknown):Promise<{policyRef:ExperimentRef;programMatches:boolean;certificateMatches:boolean;status:string;protectedReceipt:null;qualification:string}>{
 const policy=await readEnterpriseContingentPolicy(ctx,value),model=await resolveEnterpriseInterventionModelForControl(ctx,policy.bindings.modelRef),snapshot:InterventionControlSnapshot=await readArtifact(ctx,'kernels',policy.bindings.dynamicsRef.contentDigest);
 const adapter=restoreInterventionControlAdapter(model,snapshot);
 const inputRef=policy.bindings.inputArtifactRef;if(!inputRef||inputRef.owner!=='S4'||inputRef.id!==`control-input:${inputRef.contentDigest}`)throw unavailable();
 const artifact=await readArtifact(ctx,'inputs',inputRef.contentDigest);if(epistemicHash(artifact)!==inputRef.contentDigest||artifact.kernelRef.id!==adapter.ref.id||epistemicHash(artifact.problem)!==epistemicHash(policy.problem))throw unavailable();const protocols:ExperimentProtocol[]=artifact.protocols;
 for(const p of protocols)if((await validateEnterpriseExperiment(ctx,p)).status!=='CURRENT')throw unavailable();
 const result=await synthesizeContingentControl({mandate:policy.mandate,problem:policy.problem,dynamics:adapter,instruments:controlInstrumentSupports(protocols,model,policy.mandate,policy.problem),now:policy.knowledgeAt,inputArtifactRef:policy.bindings.inputArtifactRef,beliefPins:policy.bindings.beliefPins,priorPolicyRef:policy.priorPolicyRef,validUntilCap:policy.validUntil});
 if(await current(ctx,policy))throw unavailable();return {policyRef:policy.ref,programMatches:epistemicHash(result.policy?.nodes)===epistemicHash(policy.nodes),certificateMatches:epistemicHash(result.policy?.certificate)===epistemicHash(policy.certificate),status:result.status,protectedReceipt:null,qualification:'RETAINED_EXACT_NUMERICAL_OUTPUT_AND_CURRENT_LOADED_SOURCE_LOCAL_REPLAY_NOT_ARBITRARY_BACKEND_DETERMINISM'};
}
export async function validateEnterpriseContingentPolicy(ctx:PeMutationContext,value:unknown):Promise<{status:'CURRENT'|'STALE_INPUT';reason:string;policyRef:ExperimentRef;executionAuthorityGranted:false}>{const policy=await readPolicy(ctx,value);await readable(ctx,policy);await recoverPolicyExperience(ctx,policy);const reason=await current(ctx,policy);if(reason)await saveEvents(ctx,[prepareS4Experience(policy.mandate,'INVALIDATION',policy.ref.id,{reason},[policy.ref.id])]);return {status:reason?'STALE_INPUT':'CURRENT',reason:reason??'CURRENT_PRODUCER_BINDINGS_ONLY_NOT_PROTECTED_ADMISSION',policyRef:policy.ref,executionAuthorityGranted:false};}
export async function observeEnterpriseControl(ctx:PeMutationContext,input:{policyRef:unknown;instrumentId:string;availablePeriod:number;modelRef?:unknown}){
 const policy=await readPolicy(ctx,input.policyRef);await readable(ctx,policy);const historical=await readEnterpriseInterventionMetadataForObservation(ctx,policy.bindings.modelRef),model=input.modelRef?await resolveEnterpriseInterventionModelForControl(ctx,input.modelRef):historical;
 const instrument=policy.problem.observations.find(i=>i.id===input.instrumentId);if(!instrument||input.availablePeriod<instrument.delayPeriods||input.availablePeriod>policy.mandate.horizon.periods||epistemicHash(model.request.stateVariables.find(v=>v.id===instrument.variableId))!==epistemicHash(historical.request.stateVariables.find(v=>v.id===instrument.variableId)))throw new ControlContractError('INVALID_REQUEST','Temporal instrument revision, period or measured target differs');
 const period=input.availablePeriod-instrument.delayPeriods,start=Date.parse(policy.mandate.horizon.startAt)+period*policy.mandate.horizon.periodMs;
 const realization=await projectEnterpriseControlObservation(ctx,{instrument,problem:policy.problem,model,periodStart:new Date(start).toISOString(),periodEnd:new Date(start+policy.mandate.horizon.periodMs).toISOString(),availablePeriod:input.availablePeriod});
 await saveArtifact(ctx,'temporal-observations',realization.ref.contentDigest,realization);await saveEvents(ctx,[prepareS4Experience(policy.mandate,'OBSERVATION',policy.ref.id,{realizationRef:realization.ref,source:realization.source,qualification:realization.qualification,requiresCurrentSourceBindingsOrLinkedReplan:true},[policy.ref.id],realization.knowledgeAt)]);return realization;
}
/** An authenticated correction/override assertion is recorded, not installed as
 * a new utility, feasible policy, authority grant or settled business choice. */
export async function recordEnterpriseControlAssessment(ctx:PeMutationContext,input:{policyRef:unknown;type:'CORRECTION'|'HUMAN_OVERRIDE';reason:string;requestedActionId:string|null;humanSeconds:number;evidenceRefs:ExperimentRef[]}):Promise<{event:S4ExperienceEvent;humanBudgetDemand:number;protectedReceipt:null;policyChanged:false;executionAuthorityGranted:false}>{
 const policy=await readPolicy(ctx,input.policyRef);await readable(ctx,policy);
 if(ctx.auth.role!=='owner'||!Number.isFinite(input.humanSeconds)||input.humanSeconds<0||input.humanSeconds>policy.mandate.search.maxHumanSeconds||input.requestedActionId&&!policy.problem.actions.some(a=>a.id===input.requestedActionId))throw new ControlContractError('INVALID_REQUEST','Override action or human resource envelope is unsupported');
 const event=prepareS4Experience(policy.mandate,input.type==='HUMAN_OVERRIDE'?'OVERRIDE':'INVALIDATION',policy.ref.id,{reason:input.reason,requestedActionId:input.requestedActionId,evidenceRefs:input.evidenceRefs,humanBudgetDemand:input.humanSeconds,actualHumanCost:null,qualification:'SUPPLIED_AUTHENTICATED_ASSERTION_NOT_PROTECTED_OVERRIDE_OR_METERED_COST',requiresLinkedReplanAndS5HumanBudgetClearance:true,changesMandateOrPolicy:false},[policy.ref.id]);await saveEvents(ctx,[event]);
 return {event,humanBudgetDemand:input.humanSeconds,protectedReceipt:null,policyChanged:false,executionAuthorityGranted:false};
}
export async function chooseEnterpriseControlBranch(ctx:PeMutationContext,input:{policyRef:unknown;decision?:unknown;allocationRef?:unknown;measurements?:Array<{protocol?:unknown;events:unknown[]}>}):Promise<ReturnType<typeof decideContingentPolicy>>{
 const policy=await readEnterpriseContingentPolicy(ctx,input.policyRef),decision=parseControlDecision(input.decision);
 if(Date.parse(decision.knowledgeAt)>Date.now())throw new ControlContractError('INVALID_REQUEST','Future knowledge time cannot supply a current branch');
 // Reference observations are accepted only through the actual S2 realization
 // projection. Its unauthenticated telemetry qualification remains visible.
 for(const observation of decision.observations){if(observation.availablePeriod>decision.period||Date.parse(observation.knowledgeAt)>Date.parse(decision.knowledgeAt))throw new ControlContractError('INVALID_REQUEST','Observation lies beyond the available decision information');let matched=false;
  const temporal=policy.problem.observations.find(i=>i.id===observation.instrumentId);
  if(temporal){const r=await observeEnterpriseControl(ctx,{policyRef:policy.ref,instrumentId:temporal.id,availablePeriod:observation.availablePeriod});matched=epistemicHash(r.ref)===epistemicHash(observation.sourceRef)&&r.token===observation.token&&Date.parse(r.knowledgeAt)<=Date.parse(decision.knowledgeAt);}
  for(const measurement of input.measurements??[]){const result=await projectEnterpriseExperiment(ctx,{protocol:measurement.protocol,events:measurement.events}),r=result.realization;
   if(!r.analysis.valid||r.unknownOutcomes.length||observation.sourceRef.owner!=='S2'||observation.sourceRef.id!==r.id||observation.sourceRef.contentDigest!==r.contentDigest||!policy.bindings.protocolRefs.some(p=>p.id===r.protocolRef)||Date.parse(r.knowledgeAt)>Date.parse(decision.knowledgeAt))continue;
   const protocol=measurement.protocol as ExperimentProtocol;const tokens=protocol.metrics.observations.filter(o=>epistemicHash(o.counts)===epistemicHash(r.analysis.counts)).map(o=>JSON.stringify({counts:o.counts,sampleSize:o.sampleSize,stop:o.stop}));
   if(tokens.includes(observation.token)&&observation.instrumentId===protocol.id)matched=true;
  }
  if(!matched)throw new ControlContractError('INVALID_REQUEST','Observation is not available in an authorized S2 measurement projection');
 }
 if(await unresolvedEffects(ctx))throw new ControlContractError('INVALID_REQUEST','Outstanding effects require reconciliation before a new choice');
 let resolvedAllocation=null;
 if(input.allocationRef)try{resolvedAllocation=await (await import('./enterprise-allocation')).resolveEnterprisePolicyAllocation(ctx,input.allocationRef,policy,decision.knowledgeAt);}catch(error){if(!(error instanceof AllocationContractError)||!['PERMITTED_CONTEXT_UNAVAILABLE','STALE_INPUT'].includes(error.code))throw error;resolvedAllocation=null;}
 const choice=decideContingentPolicy(policy,decision,resolvedAllocation);await saveArtifact(ctx,'choices',choice.ref.contentDigest,choice);await saveEvents(ctx,[prepareS4Experience(policy.mandate,'BRANCH_CHOICE',policy.ref.id,{choice,decision,observationQualification:'S2_REFERENCE_TELEMETRY_OR_PERMITTED_S1_TEMPORAL_COARSENING_UNVERIFIED_ERROR',referenceChoiceNotExecuted:true},[policy.ref.id],decision.knowledgeAt)]);
 if(await current(ctx,policy))throw unavailable();return choice;
}
export async function prepareEnterpriseContingentHandoff(ctx:PeMutationContext,input:{policyRef:unknown;decision?:unknown;allocationRef?:unknown;measurements?:Array<{protocol?:unknown;events:unknown[]}>}):Promise<ContingentChoiceHandoff>{
 const policy=await readEnterpriseContingentPolicy(ctx,input.policyRef),decision=await chooseEnterpriseControlBranch(ctx,input),allocationRef=input.allocationRef?ExperimentRefSchema.parse(input.allocationRef):null;
 // Only the S5 owner's current durable readback can supply conditional clearance.
 let resolvedAllocation=null;
 if(allocationRef)try{resolvedAllocation=await (await import('./enterprise-allocation')).resolveEnterprisePolicyAllocation(ctx,allocationRef,policy,(input.decision as ControlDecisionInput).knowledgeAt);}catch(error){if(!(error instanceof AllocationContractError)||!['PERMITTED_CONTEXT_UNAVAILABLE','STALE_INPUT'].includes(error.code))throw error;resolvedAllocation=null;}
 const allocation=checkPolicyAllocation(policy,resolvedAllocation,(input.decision as ControlDecisionInput).knowledgeAt);
 const model=await resolveEnterpriseInterventionModelForControl(ctx,policy.bindings.modelRef),node=policy.nodes.find(n=>n.id===decision.nodeId),action=policy.problem.actions.find(a=>a.id===node?.actionId);
 let intervention:ContingentChoiceHandoff['intervention']=null;
 if(action?.kind==='INTERVENE'){
  const duration=Object.values(action.exposures)[0]!.length;intervention={schema:'finnor.intervention-specification.v1',vocabularyVersion:'s3-intervention-v1',targets:model.request.roots,context:policy.problem.context,timing:{startAt:new Date(Date.parse(policy.mandate.horizon.startAt)+node!.period*policy.mandate.horizon.periodMs).toISOString(),periodMs:policy.mandate.horizon.periodMs,durationMs:duration*policy.mandate.horizon.periodMs},channels:model.request.exposures.map(e=>({exposureId:e.id,operation:e.operation,unit:e.unit,target:e.root,doses:action.exposures[e.id]!,intendedExposure:'REGISTERED_DOSE',permittedRefinements:[]}))};interventionSpecificationRef(intervention);
 }
 const result:ContingentChoiceHandoff={schema:'finnor.s4.choice-handoff.v1',status:decision.status==='POLICY_AVAILABLE'?allocation.status:decision.status,policyRef:policy.ref,decision,allocationRef,demandDigest:policy.demand.contentDigest,consumptionRef:null,intervention,interventionRef:intervention?interventionSpecificationRef(intervention):null,inquiryRef:action?.protocolRef??null,requiredContracts:[{owner:'BUSINESS_OWNER',requirement:'Protected authorized immutable mandate/utility/rights revision'},{owner:'S5',requirement:'Owner-resolved current mutually consistent policy/demand/mandate allocation, shared commitments and reservations'},{owner:'S6',requirement:'Protected IR, source/rights/allocation/method/fence rechecks, append receipt, concrete provider binding, execution/exposure/reconciliation/settlement'},{owner:'S7',requirement:'Independent prospective assignment/exposure/outcome/cost accounting and attribution'},{owner:'S8',requirement:'Independent admission of exact policy method and validity domain'}],executionAuthorityGranted:false,effectRef:null,settlementRef:null,attributionGranted:false,protectedReceipt:null};
 const plannedConsumptionKey=allocationRef&&resolvedAllocation&&decision.status==='POLICY_AVAILABLE'?`s4-handoff:${decision.contextDigest}`:null;
 const preparation={schema:'finnor.s4.handoff-preparation.v1' as const,handoff:result,plannedConsumptionKey,qualification:'PREPARED_NOT_CONSUMED_NOT_PROTECTED' as const},digest=epistemicHash(preparation);
 const preparationRef:ExperimentRef={owner:'S4',id:`contingent-handoff-preparation:${digest}`,version:'s4-handoff-preparation-v1',contentDigest:digest},prepared=immutableControl({...result,preparationRef});
 // All model construction and fallible S4 persistence precede durable S5 intent.
 // The S5 consumption transaction supplies the canonical consequence event.
 await saveArtifact(ctx,'handoff-preparations',digest,preparation);
 await saveEvents(ctx,[prepareS4Experience(policy.mandate,'HANDOFF',policy.ref.id,{handoff:prepared,plannedConsumptionKey,qualification:preparation.qualification,allocationOwnerResolved:resolvedAllocation!==null},[decision.ref.id],(input.decision as ControlDecisionInput).knowledgeAt)]);
 if(allocationRef&&plannedConsumptionKey){
  const consumed=await (await import('./enterprise-allocation')).consumeEnterpriseAllocation(ctx,{...input,allocationRef,policyRef:policy.ref,idempotencyKey:plannedConsumptionKey});
  return immutableControl({...prepared,consumptionRef:consumed.consumption.ref});
 }
 return prepared;
}

/** S6 resolves the actual immutable producer artifact. Caller bodies are never handoffs. */
export async function readEnterpriseContingentHandoffPreparation(ctx:PeMutationContext,value:unknown):Promise<{schema:'finnor.s4.handoff-preparation.v1';handoff:ContingentChoiceHandoff;plannedConsumptionKey:string|null;qualification:'PREPARED_NOT_CONSUMED_NOT_PROTECTED'}>{
 const ref=ExperimentRefSchema.parse(value);if(ref.owner!=='S4'||ref.version!=='s4-handoff-preparation-v1'||ref.id!==`contingent-handoff-preparation:${ref.contentDigest}`)throw unavailable();
 const preparation=await readArtifact(ctx,'handoff-preparations',ref.contentDigest);
 if(preparation.schema!=='finnor.s4.handoff-preparation.v1'||epistemicHash(preparation)!==ref.contentDigest||preparation.qualification!=='PREPARED_NOT_CONSUMED_NOT_PROTECTED'||preparation.handoff.executionAuthorityGranted!==false||preparation.handoff.protectedReceipt!==null||preparation.handoff.consumptionRef!==null)throw unavailable();
 await readEnterpriseContingentPolicy(ctx,preparation.handoff.policyRef);return immutableControl(preparation);
}

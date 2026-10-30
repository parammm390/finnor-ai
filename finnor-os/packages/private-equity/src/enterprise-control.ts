import {resolveExactControlSource} from './r1/source';
import {r1SourceCut} from './r1/runtime';
import {buildExactControlPolicy,evaluateExactContingentControl,EXACT_S4_VERSION} from '@finnor/epistemic-runtime';
import type {ExactControlPolicyProfile,S4ComputeInvocation} from '@finnor/shared-types';
import { constants } from 'node:fs';
import { mkdir, open, link, unlink, lstat,readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { withTenantTransaction } from '@finnor/db';
import type {PoolClient} from 'pg';
import type { InterventionModel, ContingentPolicy, ContingentChoiceHandoff, ControlDecisionInput, ControlDecision, ControlProblem, EconomicMandate, ExperimentProtocol, ExperimentRef, S4ExperienceEvent } from '@finnor/shared-types';
import { assertContingentPolicy, AllocationContractError, ControlContractError, createInterventionControlAdapter, controlInstrumentSupports, controlSourcesCurrent, decideContingentPolicy, epistemicHash,
 ExperimentRefSchema, immutableControl, interventionSpecificationRef, parseControlDecision, parseControlProblem, parseEconomicMandate, prepareS4Experience, restoreInterventionControlAdapter, synthesizeContingentControl, checkPolicyAllocation, type InterventionControlSnapshot } from '@finnor/epistemic-runtime';
import { readEnterpriseInterventionMetadataForObservation, resolveEnterpriseInterventionModelForControl } from './enterprise-interventions';
import { loadEnterpriseBeliefView, validateBeliefViewPin } from './enterprise-beliefs';
import { validateEnterpriseExperiment, projectEnterpriseExperiment, projectEnterpriseControlObservation } from './enterprise-experiments';
import { PeDomainError, type PeMutationContext, type PeWorldRootRef } from './types';
import {enqueueNativeReferences,enqueueNativePreparedEvents,enqueueNativeMandate,nativeRecordReference,nativeReference,nativeOwnerTransportConfigured} from './native-experience-transport';
import type {ExactContingentPolicy,R2CheckReceipt} from '@finnor/shared-types/src/robust-programme-search';
import {R2_VERSION} from '@finnor/shared-types/src/robust-programme-search';
import {r2Ref,loadR2Runtime} from './capital-program/r2-native';
import {chooseExactS4Branch} from './capital-program/r2-owners';
import {codeIdentity} from './evidence-execution/store';
import {readSourceObject} from './deliberation/store';
import {assessRevenueProfitTarget} from '../../epistemic-runtime/src/operating-profit';
import type {CoalitionSelection} from '@finnor/shared-types/src/coalition-programme';
import {R5_VERSION} from '@finnor/shared-types/src/coalition-programme';
import {coalitionCheckerIdentity} from './capital-program/r2-native';
import {assertR5SelectionCurrent} from './capital-program/r5-owners';

const actor=(ctx:PeMutationContext)=>ctx.auth.employeeId??ctx.auth.userId;
/** S4-owned finite sourcing policy. The score is registered mandate coverage per
 * remaining cost, never an inferred seller propensity or a causal value claim. */
export function chooseBilateralNext(input:{
 candidates:Array<{id:string;activity:'INQUIRE'|'APPROACH'|'CONFIRM'|'CHECK'|'RECONCILE';
  eligible:boolean;requiredInformation:number;costMicroUsd:string;delayMs:number|null}>;
 remainingContacts:number;remainingMicroUsd:string;deadline:string;at:string;cancelled:boolean;
}){
 if(input.cancelled)return {status:'STOPPED' as const,selected:null,reason:'CANCELLED_FUTURE_WORK_RETIRED',executionAuthorityGranted:false};
 if(Date.parse(input.at)>=Date.parse(input.deadline))return {status:'STOPPED' as const,selected:null,reason:'ORIGINAL_BILATERAL_DEADLINE_EXHAUSTED',executionAuthorityGranted:false};
 const candidates=input.candidates.filter(c=>c.eligible&&Number.isSafeInteger(c.requiredInformation)&&c.requiredInformation>0&&
  /^(0|[1-9]\d{0,95})$/.test(c.costMicroUsd)&&BigInt(c.costMicroUsd)<=BigInt(input.remainingMicroUsd)&&
  (['CHECK','RECONCILE'].includes(c.activity)||input.remainingContacts>0));
 candidates.sort((a,b)=>{
  if(a.activity==='RECONCILE'&&b.activity!=='RECONCILE')return -1;
  if(b.activity==='RECONCILE'&&a.activity!=='RECONCILE')return 1;
  const left=BigInt(a.requiredInformation)*(BigInt(b.costMicroUsd)||1n),right=BigInt(b.requiredInformation)*(BigInt(a.costMicroUsd)||1n);
  if(left!==right)return left>right?-1:1;
  if(a.delayMs!==b.delayMs)return a.delayMs===null?1:b.delayMs===null?-1:a.delayMs-b.delayMs;
  return a.id<b.id?-1:a.id>b.id?1:0;
 });
 return candidates.length?{status:'PROGRESS' as const,selected:candidates[0]!,reason:'REGISTERED_COVERAGE_COST_DELAY_CHOICE',executionAuthorityGranted:false}:
 {status:input.remainingContacts<=0?'STOPPED' as const:'WAITING' as const,selected:null,reason:input.remainingContacts<=0?'ORIGINAL_CONTACT_GRANT_EXHAUSTED':'NO_CURRENT_PERMITTED_INFORMATION_OR_CONTACT',executionAuthorityGranted:false};
}
/** S4's narrow factual-acquisition choice. Scores cover frozen material
 * obligations only; this is not expected revenue, causal value or measured gain. */
export function choosePrimaryAcquisition(input:{
 candidates:Array<{assertionId:string;sourceProfileId:string;eligible:boolean;materialObligations:number;reservedMicroUsd:string;revalidation:boolean}>;
 remainingRequests:number;deadline:string;at:string;
}){
 if(input.remainingRequests<=0||Date.parse(input.at)>=Date.parse(input.deadline))return {status:'STOPPED' as const,selected:null,reason:'ORIGINAL_REQUEST_OR_DEADLINE_EXHAUSTED',executionAuthorityGranted:false};
 const candidates=input.candidates.filter(c=>c.eligible&&Number.isSafeInteger(c.materialObligations)&&c.materialObligations>0&&/^(0|[1-9]\d{0,95})$/.test(c.reservedMicroUsd));
 candidates.sort((a,b)=>{
  if(a.revalidation!==b.revalidation)return a.revalidation?-1:1;
  const left=BigInt(a.materialObligations)*(BigInt(b.reservedMicroUsd)||1n),right=BigInt(b.materialObligations)*(BigInt(a.reservedMicroUsd)||1n);
  return left===right?(a.assertionId+':'+a.sourceProfileId).localeCompare(b.assertionId+':'+b.sourceProfileId):left>right?-1:1;
 });
 return candidates.length?{status:'PROGRESS' as const,selected:candidates[0]!,reason:'MATERIAL_COVERAGE_PER_RESERVED_COST_DELAY_UNKNOWN_STABLE_TIE',executionAuthorityGranted:false}:
 {status:'WAITING' as const,selected:null,reason:'NO_NEW_PERMITTED_PRIMARY_COVERAGE_OPPORTUNITY',executionAuthorityGranted:false};
}
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
async function readPolicy(ctx:PeMutationContext,value:unknown):Promise<ContingentPolicy>{const parsed=ExperimentRefSchema.safeParse(value);if(!parsed.success||parsed.data.owner!=='S4'||!['s4-finite-contingent-v1',EXACT_S4_VERSION].includes(parsed.data.version)||parsed.data.id!==`contingent-policy:${parsed.data.contentDigest}`)throw unavailable();
 try{await checkedStore(ctx);await privateDirectory(join(directory(ctx),'policies'));const file=await open(join(directory(ctx),'policies',`${parsed.data.contentDigest}.json`),constants.O_RDONLY|constants.O_NOFOLLOW);let policy:ContingentPolicy;
  try{if(!(await file.stat()).isFile()||(await file.stat()).size>8*1024*1024)throw unavailable();const data:unknown=JSON.parse(await file.readFile('utf8'));assertContingentPolicy(data);policy=data;}finally{await file.close();}
  if(policy.tenantId!==ctx.auth.tenantId||policy.principalId!==actor(ctx)||epistemicHash(policy.ref)!==epistemicHash(parsed.data))throw unavailable();return policy;
 }catch{throw unavailable();}}
async function readable(ctx:PeMutationContext,policy:ContingentPolicy):Promise<void>{for(const pin of policy.bindings.beliefPins)await loadEnterpriseBeliefView(ctx,{root:pin.root as PeWorldRootRef});await recoverPolicyExperience(ctx,policy);}
async function current(ctx:PeMutationContext,policy:ContingentPolicy):Promise<string|null>{
 if(policy.bindings.modelRef.version==='postx-y2-strategic-response-v1'){
  try{await (await import('./strategic-response/store')).assertStrategicPolicyCurrent(ctx,policy);return null;}
  catch{return 'Y2_STRATEGIC_MODEL_POLICY_OR_ADMISSION_NOT_CURRENT';}
 }
 if(policy.exactProfile){try{
  if(await unresolvedEffects(ctx))return 'R1_S6_OUTSTANDING_RESPONSIBILITY_RETAINED';
  const source=await resolveExactControlSource(ctx,policy.exactProfile.sourceRef);
  if(policy.exactProfile.modelBytes!==source.model_bytes||policy.exactProfile.modelDigest!==source.model_digest||
   epistemicHash(policy.mandate)!==epistemicHash(source.mandate)||
   epistemicHash(policy.bindings.beliefPins)!==epistemicHash(source.belief_pins)||
   epistemicHash(policy.exactProfile.beliefPins)!==epistemicHash(source.belief_pins))return 'R1_EXACT_POLICY_SOURCE_BINDING_CHANGED';
  if(JSON.stringify(policy.exactProfile.sourceDigests)!==JSON.stringify(source.source_cut.files))return 'R1_LOADED_METHOD_CHANGED';
  if(policy.exactProfile.durableRunId)await (await import('./r1/api')).assertR1PolicyPublished(ctx,policy.exactProfile.durableRunId,policy.ref);
  return null;
 }catch(error){return (error as Error).message.match(/^[A-Z][A-Z0-9_]+$/)?.[0]??'R1_CURRENT_OWNER_BINDING_UNPASSED';}}
 if(Date.now()>=Date.parse(policy.validUntil))return 'POLICY_EXPIRED';if(!await controlSourcesCurrent(policy.compute.backend.sourceDigests))return 'S4_LOADED_METHOD_CHANGED';
 for(const pin of policy.bindings.beliefPins)if((await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')return 'S1_SOURCE_RIGHTS_COVERAGE_OR_INTERPRETATION_CHANGED';
 try{await resolveEnterpriseInterventionModelForControl(ctx,policy.bindings.modelRef);}catch{return 'S3_MODEL_REVISED_REVOKED_OR_UNSUPPORTED';}
 return null;
}
/** Existing durable effects are independently read. A caller cannot hide an
 * unknown pending effect by sending an empty obligation list. No S6 is invented. */
export async function unresolvedEffects(ctx:PeMutationContext,client?:PoolClient):Promise<number>{
 const query=async(c:PoolClient):Promise<number>=>{
  const complete=(await c.query<{complete:boolean}>('SELECT finnor_os.y4_control_context_complete() complete')).rows[0]?.complete;
  if(complete!==true)return 1;
  const result=await c.query<{count:number}>("SELECT count(*)::int count FROM finnor_os.business_effects WHERE tenant_id=$1 AND status NOT IN ('verified','cancelled','compensated')",[ctx.auth.tenantId]);
  return result.rows[0]!.count;
 };
 return client?query(client):withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx),readOnly:true},(_db,c)=>query(c));
}
/** Additive S3 model family, same canonical S4 evaluator and mandate semantics.
 * No forecast is allowed to hide an outstanding S6 responsibility. */
export async function synthesizeEnterpriseStrategicControl(ctx:PeMutationContext,input:{
 modelId:string;query:import('../../shared-types/src/strategic-response').StrategicForecastRequest;
 mandate:unknown;problem:unknown;actionRules:import('../../epistemic-runtime/src/strategic-response/adapter').StrategicActionRule[];
}){
 const started=performance.now(),store=await import('./strategic-response/store'),
  {withS5PortfolioTransaction}=await import('./allocation-store'),
  {same,fail}=await import('./strategic-response/contracts'),
  {createStrategicControlAdapter}=await import('../../epistemic-runtime/src/strategic-response/adapter');
 store.developmentOnly();
 const {row}=await withS5PortfolioTransaction(ctx,c=>store.resolveCurrentModelTx(ctx,c,input.modelId));
 const m=parseEconomicMandate(input.mandate),p=parseControlProblem(input.problem);
 if(ctx.auth.role!=='owner'||m.tenantId!==ctx.auth.tenantId||m.principalId!==actor(ctx)||m.businessOwnerRef.id!==actor(ctx)||
  m.episodeId!==row.episode_id||p.episodeId!==row.episode_id||!same(p.modelRef,row.artifact!.envelope.contentRef)||
  m.horizon.periods!==input.query.ruleIds.length||m.utility.unit!==row.request.problem.payoff.unit||p.context!==input.query.context)
  fail('Y2_ORIGINAL_S4_OWNER_MANDATE_SCOPE_REQUIRED');
 if(await unresolvedEffects(ctx))fail('Y2_S6_OUTSTANDING_RESPONSIBILITY_RECONCILIATION_REQUIRED');
 const dynamics=createStrategicControlAdapter(row.request.problem,row.candidate!,input.query,p,input.actionRules);
 const result=await synthesizeContingentControl({mandate:m,problem:p,dynamics,instruments:[],
  inputArtifactRef:row.artifact!.envelope.contentRef,budgetStartedAt:started,
  validUntilCap:row.deadline_at.toISOString()});
 await withS5PortfolioTransaction(ctx,async c=>{
  await store.resolveCurrentModelTx(ctx,c,row.id);
  if(await unresolvedEffects(ctx,c))fail('Y2_S6_OUTSTANDING_RESPONSIBILITY_RECONCILIATION_REQUIRED');
 });
 return result;
}
/** Files are immutable preparation until the original physically fenced use
 * publishes. Generic S4 reads below require that durable CHECKED binding. */
export async function retainEnterpriseStrategicControl(ctx:PeMutationContext,result:Awaited<ReturnType<typeof synthesizeContingentControl>>){
 await saveEvents(ctx,result.experience);await saveArtifact(ctx,'results',epistemicHash(result),result);
 if(result.policy){
  await saveArtifact(ctx,'mandates',result.policy.mandate.ref.contentDigest,result.policy.mandate);
  await saveArtifact(ctx,'demands',result.policy.demand.contentDigest,result.policy.demand);
  await saveArtifact(ctx,'policies',result.policy.ref.contentDigest,result.policy);
 }
}
export async function synthesizeEnterpriseControl(ctx:PeMutationContext,input:{mandate?:unknown;problem?:unknown;protocols:unknown[];scenarios:{pathsPerMechanism:number;seed:number};priorPolicyRef?:unknown;reason?:string}):Promise<Awaited<ReturnType<typeof synthesizeContingentControl>>|{schema:'finnor.s4.policy-result.v1';status:'UNCERTAINTY_UNRESOLVED'|'MODEL_UNSUPPORTED'|'NUMERICAL_FAILURE'|'SEARCH_EXHAUSTED';policy:null;reasons:string[];experience:S4ExperienceEvent[];compute:unknown}> {
 const ownerStartedAt=performance.now(),m=parseEconomicMandate(input.mandate,{operatingProfit:true}),p=parseControlProblem(input.problem,{operatingProgramme:true});await checkedStore(ctx);
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
 const early=async(status:'UNCERTAINTY_UNRESOLVED'|'MODEL_UNSUPPORTED'|'NUMERICAL_FAILURE'|'SEARCH_EXHAUSTED',reason:string,compute:unknown=null)=>{const profitTargetAssessment=assessRevenueProfitTarget(m,null,false),experience=[prepareS4Experience(m,'REJECTION',problemRef.id,{status,reason,originalProblemId:p.id,modelRef:model.ref,compute,...(profitTargetAssessment?{profitTargetAssessment}:{})})];await saveEvents(ctx,experience);return {schema:'finnor.s4.policy-result.v1' as const,status,policy:null,reasons:[reason],experience,compute,...(profitTargetAssessment?{profitTargetAssessment}:{})};};
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
 // An unsuccessful revenue hurdle is an economic result too. Retain the exact
 // owner charter and numerical kernel, rather than only a rejection summary.
 if(result.policy||m.utility.operatingProfit?.profitTarget){await saveArtifact(ctx,'mandates',m.ref.contentDigest,m);await saveArtifact(ctx,'kernels',kernel.snapshot!.ref.contentDigest,kernel.snapshot);await saveArtifact(ctx,'inputs',inputDigest,artifact);}
 if(result.policy){await saveArtifact(ctx,'demands',result.policy.demand.contentDigest,result.policy.demand);await saveArtifact(ctx,'policies',result.policy.ref.contentDigest,result.policy);if(await current(ctx,result.policy))throw unavailable();}
 return {...result,experience:events};
}
export interface R3ControlPolicyRead {schema:'finnor.s4.r3-policy-read.v1';policyRef:ExperimentRef}
export async function readEnterpriseContingentPolicy(ctx:PeMutationContext,value:R3ControlPolicyRead):Promise<Awaited<ReturnType<typeof import('./r3/control').readR3UsePolicy>>>;
export async function readEnterpriseContingentPolicy(ctx:PeMutationContext,value:unknown):Promise<ContingentPolicy>;
export async function readEnterpriseContingentPolicy(ctx:PeMutationContext,value:unknown){
 if(value&&typeof value==='object'&&'schema' in value&&value.schema==='finnor.s4.r3-policy-read.v1')
  return (await import('./r3/control')).readR3UsePolicy(ctx,ExperimentRefSchema.parse((value as R3ControlPolicyRead).policyRef));
 const policy=await readPolicy(ctx,value);
 // Exact source resolution already authorizes and validates these same S1
 // pins. Keep that canonical current read and its durable publication fence.
 if(!policy.exactProfile)await readable(ctx,policy);
 if(await current(ctx,policy)){
  if(policy.exactProfile)await readable(ctx,policy);
  throw unavailable();
 }
 await recoverPolicyExperience(ctx,policy);return immutableControl(policy);
}
/** Narrow current S4-owned reader. A caller cannot add terms to a P2 request
 * or mistake supplied utility conversion for independently reconciled money. */
export async function readEnterpriseDeliberationConversion(ctx:PeMutationContext,value:unknown){
 const policy=await readEnterpriseContingentPolicy(ctx,value);return deriveEnterpriseDeliberationConversion(policy);
}
/** Pure conversion of the exact policy already checked by the current owner
 * reader. This helper neither checks access nor supplies execution authority. */
export function deriveEnterpriseDeliberationConversion(policy:ContingentPolicy){
 const terms=policy.mandate.utility.deliberation;
 if(!terms)return null;
 const {schema,...conversion}=terms,body={policyRequest:policy.ref,mandateRef:policy.mandateRef,utilityRef:policy.mandate.utilityRef,horizon:policy.mandate.horizon,terms};
 const contentDigest=epistemicHash(body);return {ref:{owner:'S4',id:'s4-deliberation-conversion:'+contentDigest,version:'s4-finite-deliberation-conversion-v1',contentDigest},...conversion};
}
export async function replayEnterpriseContingentPolicy(ctx:PeMutationContext,value:unknown):Promise<{policyRef:ExperimentRef;programMatches:boolean;certificateMatches:boolean;status:string;protectedReceipt:null;qualification:string}>{
 const policy=await readEnterpriseContingentPolicy(ctx,value);if(policy.exactProfile){const e=evaluateExactContingentControl(policy.exactProfile.modelBytes,{deadlineAt:Date.now()+policy.mandate.search.deadlineMs,maxSteps:4000000,reuse:policy.exactProfile.candidate&&policy.exactProfile.receipt?{candidate:policy.exactProfile.candidate,receipt:policy.exactProfile.receipt}:null});return {policyRef:policy.ref,programMatches:epistemicHash(e.selectedActions)===epistemicHash(policy.exactProfile.evaluation.selectedActions),certificateMatches:epistemicHash(e.values)===epistemicHash(policy.exactProfile.evaluation.values),status:e.status,protectedReceipt:null,qualification:'SUPPLIED_EXACT_INFORMATION_TABLE_CURRENT_OWNER_REPLAY_NO_FIELD_ADMISSION'};}if(policy.bindings.modelRef.version==='postx-y2-strategic-response-v1'){
  const store=await import('./strategic-response/store'),{DecisionRequest}=await import('./strategic-response/contracts'),
   {createStrategicControlAdapter}=await import('../../epistemic-runtime/src/strategic-response/adapter');
  const binding=await store.assertStrategicPolicyCurrent(ctx,policy),request=DecisionRequest.parse(binding.request),
   dynamics=createStrategicControlAdapter(binding.model.request.problem,binding.model.candidate!,request.query,policy.problem,request.actionRules);
  if(epistemicHash(dynamics.ref)!==epistemicHash(policy.bindings.dynamicsRef)||
   epistemicHash(policy.bindings.inputArtifactRef)!==epistemicHash(binding.model.artifact!.envelope.contentRef)||
   epistemicHash(parseEconomicMandate(request.mandate))!==epistemicHash(policy.mandate)||
   epistemicHash(parseControlProblem(request.problem))!==epistemicHash(policy.problem))throw unavailable();
  const result=await synthesizeContingentControl({mandate:policy.mandate,problem:policy.problem,dynamics,instruments:[],
   now:policy.knowledgeAt,inputArtifactRef:policy.bindings.inputArtifactRef,beliefPins:policy.bindings.beliefPins,
   priorPolicyRef:policy.priorPolicyRef,validUntilCap:policy.validUntil});
  if(await current(ctx,policy))throw unavailable();
  return {policyRef:policy.ref,programMatches:epistemicHash(result.policy?.nodes)===epistemicHash(policy.nodes),
   certificateMatches:epistemicHash(result.policy?.certificate)===epistemicHash(policy.certificate),status:result.status,
   protectedReceipt:null,qualification:'RETAINED_CHECKED_STRATEGIC_BINDINGS_CURRENT_S4_BINARY64_OWNER_REPLAY_NO_EFFECT_AUTHORITY'};
 }
 const model=await resolveEnterpriseInterventionModelForControl(ctx,policy.bindings.modelRef),snapshot:InterventionControlSnapshot=await readArtifact(ctx,'kernels',policy.bindings.dynamicsRef.contentDigest);
 const adapter=restoreInterventionControlAdapter(model,snapshot);
 const inputRef=policy.bindings.inputArtifactRef;if(!inputRef||inputRef.owner!=='S4'||inputRef.id!==`control-input:${inputRef.contentDigest}`)throw unavailable();
 const artifact=await readArtifact(ctx,'inputs',inputRef.contentDigest);if(epistemicHash(artifact)!==inputRef.contentDigest||artifact.kernelRef.id!==adapter.ref.id||epistemicHash(artifact.problem)!==epistemicHash(policy.problem))throw unavailable();const protocols:ExperimentProtocol[]=artifact.protocols;
 for(const p of protocols)if((await validateEnterpriseExperiment(ctx,p)).status!=='CURRENT')throw unavailable();
 const result=await synthesizeContingentControl({mandate:policy.mandate,problem:policy.problem,dynamics:adapter,instruments:controlInstrumentSupports(protocols,model,policy.mandate,policy.problem),now:policy.knowledgeAt,inputArtifactRef:policy.bindings.inputArtifactRef,beliefPins:policy.bindings.beliefPins,priorPolicyRef:policy.priorPolicyRef,validUntilCap:policy.validUntil});
 if(await current(ctx,policy))throw unavailable();return {policyRef:policy.ref,programMatches:epistemicHash(result.policy?.nodes)===epistemicHash(policy.nodes),certificateMatches:epistemicHash(result.policy?.certificate)===epistemicHash(policy.certificate),status:result.status,protectedReceipt:null,qualification:'RETAINED_EXACT_NUMERICAL_OUTPUT_AND_CURRENT_LOADED_SOURCE_LOCAL_REPLAY_NOT_ARBITRARY_BACKEND_DETERMINISM'};
}
export async function validateEnterpriseContingentPolicy(ctx:PeMutationContext,value:unknown):Promise<{status:'CURRENT'|'STALE_INPUT';reason:string;policyRef:ExperimentRef;executionAuthorityGranted:false}>{const policy=await readPolicy(ctx,value);await readable(ctx,policy);await recoverPolicyExperience(ctx,policy);const reason=await current(ctx,policy);if(reason)await saveEvents(ctx,[prepareS4Experience(policy.mandate,'INVALIDATION',policy.ref.id,{reason},[policy.ref.id])]);return {status:reason?'STALE_INPUT':'CURRENT',reason:reason??'CURRENT_PRODUCER_BINDINGS_ONLY_NOT_PROTECTED_ADMISSION',policyRef:policy.ref,executionAuthorityGranted:false};}
export async function observeEnterpriseControl(ctx:PeMutationContext,input:{policyRef:unknown;instrumentId:string;availablePeriod:number;modelRef?:unknown}){
 const policy=await readPolicy(ctx,input.policyRef);await readable(ctx,policy);
 if(policy.exactProfile){if(input.modelRef&&epistemicHash(input.modelRef)!==epistemicHash(policy.exactProfile.sourceRef))throw new ControlContractError('INVALID_REQUEST','Exact observation source revision differs');const realization=await (await import('./enterprise-experiments')).projectEnterpriseExactControlObservation(ctx,{modelBytes:policy.exactProfile.modelBytes,instrumentId:input.instrumentId,availablePeriod:input.availablePeriod});await saveArtifact(ctx,'temporal-observations',realization.ref.contentDigest,realization);await saveEvents(ctx,[prepareS4Experience(policy.mandate,'OBSERVATION',policy.ref.id,{realizationRef:realization.ref,source:realization.source,qualification:realization.qualification,requiresCurrentSourceBindingsOrLinkedReplan:true},[policy.ref.id],realization.knowledgeAt)]);return realization;}
 const historical=await readEnterpriseInterventionMetadataForObservation(ctx,policy.bindings.modelRef),model=input.modelRef?await resolveEnterpriseInterventionModelForControl(ctx,input.modelRef):historical;
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
export interface R3ControlChoice {schema:'finnor.s4.r3-choice-request.v1';policyRef:ExperimentRef}
type NumericControlChoice={policyRef:unknown;decision?:unknown;allocationRef?:unknown;measurements?:Array<{protocol?:unknown;events:unknown[]}>;confidentialGuard?:unknown;executionProofGuard?:unknown};
export async function chooseEnterpriseControlBranch(ctx:PeMutationContext,input:R3ControlChoice):Promise<Awaited<ReturnType<typeof import('./r3/control').chooseR3ControlBranch>>>;
export async function chooseEnterpriseControlBranch(ctx:PeMutationContext,input:NumericControlChoice):Promise<ReturnType<typeof decideContingentPolicy>>;
export async function chooseEnterpriseControlBranch(ctx:PeMutationContext,input:R3ControlChoice|NumericControlChoice){
 if('schema' in input&&input.schema==='finnor.s4.r3-choice-request.v1'){
  if(await unresolvedEffects(ctx))throw Error('R3_OUTSTANDING_NATIVE_EFFECTS_REQUIRE_S6_ACCOUNTING');
  return (await import('./r3/control')).chooseR3ControlBranch(ctx,{policyRef:ExperimentRefSchema.parse(input.policyRef)});
 }
 return chooseNumericEnterpriseControlBranch(ctx,input);
}
async function chooseNumericEnterpriseControlBranch(ctx:PeMutationContext,input:NumericControlChoice):Promise<ReturnType<typeof decideContingentPolicy>>{
 await (await import('./confidential-computation/owner-consumer')).assertConfidentialGuard(ctx,input.confidentialGuard);
 await (await import('./project-z/z4-execution-proof/owner-consumer')).assertExecutionProofGuard(ctx,input.executionProofGuard,'S4',input,'BEFORE');
 const policy=await readEnterpriseContingentPolicy(ctx,input.policyRef),decision=parseControlDecision(input.decision);
 if(Date.parse(decision.knowledgeAt)>Date.now())throw new ControlContractError('INVALID_REQUEST','Future knowledge time cannot supply a current branch');
 // Reference observations are accepted only through the actual S2 realization
 // projection. Its unauthenticated telemetry qualification remains visible.
 for(const observation of decision.observations){if(observation.availablePeriod>decision.period||Date.parse(observation.knowledgeAt)>Date.parse(decision.knowledgeAt))throw new ControlContractError('INVALID_REQUEST','Observation lies beyond the available decision information');let matched=false;
  const temporal=policy.problem.observations.find(i=>i.id===observation.instrumentId);
  if(temporal){const r=policy.exactProfile?await (await import('./enterprise-experiments')).projectEnterpriseExactControlObservation(ctx,{modelBytes:policy.exactProfile.modelBytes,instrumentId:temporal.id,availablePeriod:observation.availablePeriod}):await observeEnterpriseControl(ctx,{policyRef:policy.ref,instrumentId:temporal.id,availablePeriod:observation.availablePeriod});matched=epistemicHash(r.ref)===epistemicHash(observation.sourceRef)&&r.token===observation.token&&Date.parse(r.knowledgeAt)<=Date.parse(decision.knowledgeAt);}
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
 const choice=decideContingentPolicy(policy,decision,resolvedAllocation);await saveArtifact(ctx,'choices',choice.ref.contentDigest,choice);await saveEvents(ctx,[prepareS4Experience(policy.mandate,'BRANCH_CHOICE',policy.ref.id,{choice,decision,
  ...(input.confidentialGuard!==undefined?{confidentialGuard:input.confidentialGuard}:{}),
  ...(input.executionProofGuard!==undefined?{executionProofGuard:input.executionProofGuard}:{}),
  observationQualification:'S2_REFERENCE_TELEMETRY_OR_PERMITTED_S1_TEMPORAL_COARSENING_UNVERIFIED_ERROR',referenceChoiceNotExecuted:true},[policy.ref.id],decision.knowledgeAt)]);
 if(await current(ctx,policy))throw unavailable();
 await (await import('./confidential-computation/owner-consumer')).assertConfidentialGuard(ctx,input.confidentialGuard);
 await (await import('./project-z/z4-execution-proof/owner-consumer')).assertExecutionProofGuard(ctx,input.executionProofGuard,'S4',input,'AFTER');
 return choice;
}
export async function prepareEnterpriseContingentHandoff(ctx:PeMutationContext,input:NumericControlChoice):Promise<ContingentChoiceHandoff>{
 const policy=await readEnterpriseContingentPolicy(ctx,input.policyRef),decision=await chooseEnterpriseControlBranch(ctx,input),allocationRef=input.allocationRef?ExperimentRefSchema.parse(input.allocationRef):null;
 // Only the S5 owner's current durable readback can supply conditional clearance.
 let resolvedAllocation=null;
 if(allocationRef)try{resolvedAllocation=await (await import('./enterprise-allocation')).resolveEnterprisePolicyAllocation(ctx,allocationRef,policy,(input.decision as ControlDecisionInput).knowledgeAt);}catch(error){if(!(error instanceof AllocationContractError)||!['PERMITTED_CONTEXT_UNAVAILABLE','STALE_INPUT'].includes(error.code))throw error;resolvedAllocation=null;}
 const allocation=checkPolicyAllocation(policy,resolvedAllocation,(input.decision as ControlDecisionInput).knowledgeAt);
 const model=policy.exactProfile?null:await resolveEnterpriseInterventionModelForControl(ctx,policy.bindings.modelRef),node=policy.nodes.find(n=>n.id===decision.nodeId),action=policy.problem.actions.find(a=>a.id===node?.actionId);
 let intervention:ContingentChoiceHandoff['intervention']=null;
 if(action?.kind==='INTERVENE'&&model){
  const duration=Object.values(action.exposures)[0]!.length;intervention={schema:'finnor.intervention-specification.v1',vocabularyVersion:'s3-intervention-v1',targets:model.request.roots,context:policy.problem.context,timing:{startAt:new Date(Date.parse(policy.mandate.horizon.startAt)+node!.period*policy.mandate.horizon.periodMs).toISOString(),periodMs:policy.mandate.horizon.periodMs,durationMs:duration*policy.mandate.horizon.periodMs},channels:model.request.exposures.map(e=>({exposureId:e.id,operation:e.operation,unit:e.unit,target:e.root,doses:action.exposures[e.id]!,intendedExposure:'REGISTERED_DOSE',permittedRefinements:[]}))};interventionSpecificationRef(intervention);
 }
 const result:ContingentChoiceHandoff={schema:'finnor.s4.choice-handoff.v1',status:decision.status==='POLICY_AVAILABLE'?allocation.status:decision.status,policyRef:policy.ref,decision,allocationRef,demandDigest:policy.demand.contentDigest,consumptionRef:null,intervention,interventionRef:intervention?interventionSpecificationRef(intervention):null,inquiryRef:action?.protocolRef??null,requiredContracts:[{owner:'BUSINESS_OWNER',requirement:'Protected authorized immutable mandate/utility/rights revision'},...(policy.exactProfile?[{owner:'S3' as const,requirement:'Independent exact model adequacy and a qualified causal intervention specification; the supplied transition table alone does not issue it'}]:[]),{owner:'S5',requirement:'Owner-resolved current mutually consistent policy/demand/mandate allocation, shared commitments and reservations'},{owner:'S6',requirement:'Protected IR, source/rights/allocation/method/fence rechecks, append receipt, concrete provider binding, execution/exposure/reconciliation/settlement'},{owner:'S7',requirement:'Independent prospective assignment/exposure/outcome/cost accounting and attribution'},{owner:'S8',requirement:'Independent admission of exact policy method and validity domain'}],executionAuthorityGranted:false,effectRef:null,settlementRef:null,attributionGranted:false,protectedReceipt:null};
 const compositionContract=await (await import('./project-z/z5-institution-linker/consumer')).currentCompositionForHandoff(ctx,policy.ref,allocationRef??undefined);
 const plannedConsumptionKey=allocationRef&&resolvedAllocation&&decision.status==='POLICY_AVAILABLE'?`s4-handoff:${decision.contextDigest}`:null;
 const preparation={schema:'finnor.s4.handoff-preparation.v1' as const,handoff:result,plannedConsumptionKey,qualification:'PREPARED_NOT_CONSUMED_NOT_PROTECTED' as const,
  ...(compositionContract?{compositionContract}:{}),
  ...(input.confidentialGuard!==undefined?{confidentialGuard:input.confidentialGuard}:{})},digest=epistemicHash(preparation);
 const preparationRef:ExperimentRef={owner:'S4',id:`contingent-handoff-preparation:${digest}`,version:'s4-handoff-preparation-v1',contentDigest:digest},prepared=immutableControl({...result,preparationRef});
 // All model construction and fallible S4 persistence precede durable S5 intent.
 // The S5 consumption transaction supplies the canonical consequence event.
 await saveArtifact(ctx,'handoff-preparations',digest,preparation);
 if(compositionContract)await (await import('./project-z/z5-institution-linker/consumer')).recordCompositionHandoffConsumed(ctx,compositionContract,preparationRef);
 await saveEvents(ctx,[prepareS4Experience(policy.mandate,'HANDOFF',policy.ref.id,{handoff:prepared,plannedConsumptionKey,qualification:preparation.qualification,allocationOwnerResolved:resolvedAllocation!==null},[decision.ref.id],(input.decision as ControlDecisionInput).knowledgeAt)]);
 if(allocationRef&&plannedConsumptionKey){
  const consumed=await (await import('./enterprise-allocation')).consumeEnterpriseAllocation(ctx,{...input,allocationRef,policyRef:policy.ref,idempotencyKey:plannedConsumptionKey});
  return immutableControl({...prepared,consumptionRef:consumed.consumption.ref});
 }
 return prepared;
}

/** S6 resolves the actual immutable producer artifact. Caller bodies are never handoffs. */
export async function readEnterpriseContingentHandoffPreparation(ctx:PeMutationContext,value:unknown,options:{originalBeforeComposition?:boolean}={}):Promise<{schema:'finnor.s4.handoff-preparation.v1';handoff:ContingentChoiceHandoff;plannedConsumptionKey:string|null;qualification:'PREPARED_NOT_CONSUMED_NOT_PROTECTED';confidentialGuard?:unknown;compositionContract?:unknown}>{
 const ref=ExperimentRefSchema.parse(value);if(ref.owner!=='S4'||ref.version!=='s4-handoff-preparation-v1'||ref.id!==`contingent-handoff-preparation:${ref.contentDigest}`)throw unavailable();
 const preparation=await readArtifact(ctx,'handoff-preparations',ref.contentDigest);
 if(preparation.schema!=='finnor.s4.handoff-preparation.v1'||epistemicHash(preparation)!==ref.contentDigest||preparation.qualification!=='PREPARED_NOT_CONSUMED_NOT_PROTECTED'||preparation.handoff.executionAuthorityGranted!==false||preparation.handoff.protectedReceipt!==null||preparation.handoff.consumptionRef!==null)throw unavailable();
 if(options.originalBeforeComposition&&Object.prototype.hasOwnProperty.call(preparation,'compositionContract'))throw Error('Z5_ORIGINAL_PREPARATION_MUST_PRECEDE_COMPOSITION_SELECTION');
 await readEnterpriseContingentPolicy(ctx,preparation.handoff.policyRef);
 await (await import('./confidential-computation/owner-consumer')).assertConfidentialGuard(ctx,preparation.confidentialGuard);
 if(preparation.compositionContract)await (await import('./project-z/z5-institution-linker/consumer')).assertCompositionHandoffCurrent(ctx,preparation.compositionContract,preparation.handoff.policyRef,preparation.handoff.allocationRef);
 return immutableControl(preparation);
}

type InstitutionCompositionPlanBody={
 schema:'finnor.s4.institution-composition-plan.v1';tenantId:string;principalId:string;workId:string;rightsRef:string;
 policyRef:ExperimentRef;allocationRef:ExperimentRef;compositionContract:NonNullable<Awaited<ReturnType<typeof import('./project-z/z5-institution-linker/consumer').currentCompositionForHandoff>>>;
 planningCostRef:ExperimentRef;qualification:'EXACT_DECLARED_CONTRACT_PLANNING_ONLY_OLD_UNKNOWN_RETAINED';
 executionAuthorityGranted:false;protectedAdmission:false;
};
/** Actual S4 integration/replacement planning, including while an old S6
 * liability is UNKNOWN. This is deliberately NOT chooseBranch or a dispatch. */
export async function prepareEnterpriseInstitutionCompositionPlan(ctx:PeMutationContext,input:{policyRef:unknown;allocationRef:unknown}){
 const policy=await readEnterpriseContingentPolicy(ctx,input.policyRef),allocationRef=ExperimentRefSchema.parse(input.allocationRef),
  consumer=await import('./project-z/z5-institution-linker/consumer'),
  compositionContract=await consumer.currentCompositionForHandoff(ctx,policy.ref,allocationRef);
 if(!compositionContract)throw unavailable();
 const planningCostRef=await consumer.beginCompositionPlanning(ctx,compositionContract);
 const body:InstitutionCompositionPlanBody={schema:'finnor.s4.institution-composition-plan.v1',tenantId:ctx.auth.tenantId,
  principalId:actor(ctx),workId:compositionContract.workId,rightsRef:policy.mandate.rightsRef,policyRef:policy.ref,allocationRef,
  compositionContract,planningCostRef,qualification:'EXACT_DECLARED_CONTRACT_PLANNING_ONLY_OLD_UNKNOWN_RETAINED',
  executionAuthorityGranted:false,protectedAdmission:false},digest=epistemicHash(body),
  ref:ExperimentRef={owner:'S4',id:'contingent-institution-plan:'+digest,version:'z5-s4-composition-plan-v1',contentDigest:digest},
  plan=immutableControl({...body,ref});
 await saveArtifact(ctx,'institution-composition-plans',digest,plan);
 await consumer.recordCompositionPlanConsumed(ctx,compositionContract,ref);
 return plan;
}
/** Immutable producer-byte reader used by S4's real consumption recording.
 * It does not call the composition checker, avoiding recursive owner inspection. */
export async function readEnterpriseInstitutionCompositionPlanByRef(ctx:PeMutationContext,value:unknown):Promise<InstitutionCompositionPlanBody&{ref:ExperimentRef}>{
 const ref=ExperimentRefSchema.parse(value);
 if(ref.owner!=='S4'||ref.version!=='z5-s4-composition-plan-v1'||ref.id!=='contingent-institution-plan:'+ref.contentDigest)throw unavailable();
 const plan=await readArtifact(ctx,'institution-composition-plans',ref.contentDigest),{ref:stored,...body}=plan;
 if(body.schema!=='finnor.s4.institution-composition-plan.v1'||body.tenantId!==ctx.auth.tenantId||body.principalId!==actor(ctx)
  ||epistemicHash(body)!==ref.contentDigest||epistemicHash(stored)!==epistemicHash(ref)
  ||body.executionAuthorityGranted!==false||body.protectedAdmission!==false)throw unavailable();
 await readEnterpriseContingentPolicy(ctx,body.policyRef);
 return immutableControl(plan);
}

/** Exact current owner contexts. Nothing is cached across authenticated reads. */
type ControlDecisionContext={policy:ContingentPolicy;model:InterventionModel;kernel:InterventionControlSnapshot;protocols:ExperimentProtocol[]};
export async function readEnterpriseControlDecisionContext(ctx:PeMutationContext,value:unknown):Promise<ControlDecisionContext>{
 return (await readEnterpriseControlDecisionContexts(ctx,[value]))[0]!;
}
export async function readEnterpriseControlDecisionContexts(ctx:PeMutationContext,values:unknown[]):Promise<ControlDecisionContext[]>{
 if(values.length>16)throw new ControlContractError('LIMIT_EXCEEDED','At most sixteen current owner policy contexts may be read together');
 const policies:ContingentPolicy[]=[];
 for(const value of values)policies.push(await readPolicy(ctx,value));
 const models=new Map<string,InterventionModel>(),pins=new Map(policies.flatMap(p=>p.bindings.beliefPins).map(pin=>[epistemicHash(pin),pin])),
  methods=new Set<string>(),protocols=new Map<string,ExperimentProtocol>(),contexts:ControlDecisionContext[]=[];
 for(const pin of pins.values())if((await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')throw unavailable();
 for(const policy of policies){
  if(policy.exactProfile)throw new ControlContractError('INVALID_REQUEST','The exact supplied table has no learned mechanism proposal context; use its versioned original control reader');
 if(Date.now()>=Date.parse(policy.validUntil))throw unavailable();
  const method=epistemicHash(policy.compute.backend.sourceDigests);
  if(!methods.has(method)){
   if(!await controlSourcesCurrent(policy.compute.backend.sourceDigests))throw unavailable();
   methods.add(method);
  }
  const modelKey=epistemicHash(policy.bindings.modelRef);
  if(!models.has(modelKey))models.set(modelKey,await resolveEnterpriseInterventionModelForControl(ctx,policy.bindings.modelRef));
  const model=models.get(modelKey)!,snapshot:InterventionControlSnapshot=await readArtifact(ctx,'kernels',policy.bindings.dynamicsRef.contentDigest),
   adapter=restoreInterventionControlAdapter(model,snapshot);
  if(epistemicHash(adapter.ref)!==epistemicHash(policy.bindings.dynamicsRef))throw unavailable();
  const inputProtocols=await validatedControlProtocols(ctx,policy,protocols);
  await recoverPolicyExperience(ctx,policy);
  contexts.push({policy,model,kernel:snapshot,protocols:inputProtocols});
 }
 return immutableControl(contexts);
}
async function validatedControlProtocols(ctx:PeMutationContext,policy:ContingentPolicy,validated?:Map<string,ExperimentProtocol>):Promise<ExperimentProtocol[]>{
 const ref=policy.bindings.inputArtifactRef;
 if(!ref)throw unavailable();const input=await readArtifact(ctx,'inputs',ref.contentDigest);
 if(epistemicHash(input)!==ref.contentDigest||epistemicHash(input.problem)!==epistemicHash(policy.problem))throw unavailable();
 const protocols=input.protocols as ExperimentProtocol[];
 for(const protocol of protocols){
  const key=epistemicHash(protocol);
  if(!validated?.has(key)){
   if((await validateEnterpriseExperiment(ctx,protocol)).status!=='CURRENT')throw unavailable();
   validated?.set(key,protocol);
  }
 }
 return immutableControl(protocols);
}
/** Pure owner proposal. Neither economic terms nor original limits may expand. */
export async function synthesizeEnterpriseControlProposal(ctx:PeMutationContext,input:{
 incumbentPolicyRef:unknown;problem:unknown;remainingDeadlineMs:number;remainingExpansions:number;
}){
 const ownerStarted=performance.now(),{policy:incumbent,model,kernel,protocols}=await readEnterpriseControlDecisionContext(ctx,input.incumbentPolicyRef),
   problem=parseControlProblem(input.problem),m=incumbent.mandate;
 if(ctx.auth.role!=='owner'||incumbent.principalId!==actor(ctx)||problem.episodeId!==m.episodeId||
   epistemicHash(problem.modelRef)!==epistemicHash(incumbent.bindings.modelRef)||problem.context!==incumbent.problem.context||
   problem.regime!==incumbent.problem.regime||epistemicHash(problem.obligations)!==epistemicHash(incumbent.problem.obligations)||
   problem.continuation||incumbent.problem.continuation||problem.validUntil!==incumbent.problem.validUntil)
  throw new ControlContractError('INVALID_REQUEST','Proposal changed the authorized owner episode/model/context/history');
 if(!Number.isInteger(input.remainingDeadlineMs)||input.remainingDeadlineMs<1||input.remainingDeadlineMs>m.search.deadlineMs||
   !Number.isInteger(input.remainingExpansions)||input.remainingExpansions<1||input.remainingExpansions>m.search.maxExpansions)
  throw new ControlContractError('INVALID_REQUEST','Proposal cannot renew the original computation grant');
 if(await unresolvedEffects(ctx))throw new ControlContractError('INVALID_REQUEST','Unreconciled S6 effects require accounted continuation');
 const dynamics=restoreInterventionControlAdapter(model,kernel),
   instruments=controlInstrumentSupports(protocols,model,m,problem);
 const artifact={problem,protocols,kernelRef:dynamics.ref,kernelCompute:kernel.compute},digest=epistemicHash(artifact),
   inputArtifactRef:ExperimentRef={owner:'S4',id:`control-input:${digest}`,version:'s4-input-v1',contentDigest:digest};
 const result=await synthesizeContingentControl({mandate:m,problem,dynamics,instruments,
   beliefPins:incumbent.bindings.beliefPins,inputArtifactRef,priorPolicyRef:incumbent.ref,validUntilCap:incumbent.validUntil,
   budgetStartedAt:ownerStarted-(m.search.deadlineMs-input.remainingDeadlineMs),remainingExpansions:input.remainingExpansions});
 await readEnterpriseControlDecisionContext(ctx,incumbent.ref);
 await saveEvents(ctx,result.experience);await saveArtifact(ctx,'results',epistemicHash(result),result);
 if(result.policy){
  await saveArtifact(ctx,'inputs',digest,artifact);await saveArtifact(ctx,'demands',result.policy.demand.contentDigest,result.policy.demand);
  await saveArtifact(ctx,'policies',result.policy.ref.contentDigest,result.policy);
  if(await current(ctx,result.policy))throw unavailable();
 }
 return immutableControl(result);
}
export async function readEnterpriseControlBranchChoice(ctx:PeMutationContext,value:unknown):Promise<ReturnType<typeof decideContingentPolicy>>{
 const ref=ExperimentRefSchema.parse(value);
 if(ref.version===R2_VERSION){
  if(ref.owner!=='S4'||ref.id!==`branch-choice:${ref.contentDigest}`)throw unavailable();
  const choice=await readArtifact(ctx,'exact-choices',ref.contentDigest) as ControlDecision,{ref:actual,...body}=choice;
  if(choice.schema!=='finnor.s4.branch-choice.v1'||choice.executionAuthorityGranted!==false||epistemicHash(actual)!==epistemicHash(ref)||epistemicHash(body)!==ref.contentDigest)throw unavailable();
  await readEnterpriseExactControlPolicy(ctx,choice.policyRef);return immutableControl(choice);
 }
 if(ref.owner!=='S4'||!['s4-finite-contingent-v1',EXACT_S4_VERSION].includes(ref.version)||ref.id!==`branch-choice:${ref.contentDigest}`)throw unavailable();
 const choice:ReturnType<typeof decideContingentPolicy>=await readArtifact(ctx,'choices',ref.contentDigest),{ref:actual,...body}=choice;
 if(!['finnor.s4.branch-choice.v1','finnor.s4.branch-choice.exact.v2'].includes(choice.schema)||choice.executionAuthorityGranted!==false||
   epistemicHash(actual)!==epistemicHash(ref)||epistemicHash(body)!==ref.contentDigest)throw unavailable();
 await readEnterpriseContingentPolicy(ctx,choice.policyRef);return immutableControl(choice);
}
export async function listEnterpriseControlPolicies(ctx:PeMutationContext,root:PeWorldRootRef):Promise<ContingentPolicy[]>{
 await loadEnterpriseBeliefView(ctx,{root});await checkedStore(ctx);
 let names:string[];try{names=await readdir(join(directory(ctx),'policies'));}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}
 if(names.length>256)throw new ControlContractError('LIMIT_EXCEEDED','Policy discovery requires bounded operator pagination');
 const policies:ContingentPolicy[]=[];
 for(const name of names.sort()){
  if(!/^[a-f0-9]{64}\.json$/.test(name))throw unavailable();const digest=name.slice(0,-5);
  try{const stored=await readArtifact(ctx,'policies',digest);const policy=await readEnterpriseContingentPolicy(ctx,stored.ref);
   if(policy.bindings.beliefPins.some(pin=>epistemicHash(pin.root)===epistemicHash(root)))policies.push(policy);
  }catch(error){if(!(error instanceof PeDomainError&&error.code==='PE_ENTITY_NOT_FOUND'))throw error;}
  if(policies.length>=16)break;
 }
 return policies;
}

/** Called by the durable R1 publisher and S4's explicit original exact path.
 * R1 prepared files stay unreadable until the actual SQL publication head is
 * committed; current() checks that run fence before any consumer can use one. */
export async function publishEnterpriseExactControlPolicy(ctx:PeMutationContext,policy:ContingentPolicy){
 if(!policy.exactProfile||policy.version!==EXACT_S4_VERSION)throw unavailable();
 await resolveExactControlSource(ctx,policy.exactProfile.sourceRef);
 if(await unresolvedEffects(ctx))throw new ControlContractError('INVALID_REQUEST','Unreconciled S6 liability is retained; exact control cannot hide it');
 await checkedStore(ctx);await saveArtifact(ctx,'mandates',policy.mandate.ref.contentDigest,policy.mandate);
 await saveArtifact(ctx,'demands',policy.demand.contentDigest,policy.demand);
 await saveArtifact(ctx,'policies',policy.ref.contentDigest,policy);
}
export async function synthesizeEnterpriseExactControl(ctx:PeMutationContext,input:{sourceRef:ExperimentRef}){
 const started=performance.now(),startedAt=new Date().toISOString(),cpu=process.cpuUsage(),rss=process.memoryUsage().rss,source=await resolveExactControlSource(ctx,input.sourceRef),m=source.mandate,deadlineAt=Date.now()+m.search.deadlineMs-(performance.now()-started);
 if(await unresolvedEffects(ctx))return {schema:'finnor.s4.policy-result.v1',status:'UNCERTAINTY_UNRESOLVED',policy:null,reasons:['S6_UNMODELED_OUTSTANDING_DURABLE_LIABILITY_RETAINED']};
 const e=evaluateExactContingentControl(source.model_bytes,{deadlineAt,maxSteps:4000000,reuse:null});
 const cut=await r1SourceCut(),compute:S4ComputeInvocation={schema:'finnor.model-compute-invocation.v1',semanticOwner:'S4',id:'',tenantId:m.tenantId,principalId:m.principalId,rightsRef:m.rightsRef,inputRef:source.ref.id,outputRefs:[],requestedRoute:'LOCAL_FIXED_SCENARIO_SEARCH',actualRoute:'LOCAL_FIXED_SCENARIO_SEARCH',fallbacks:[],backend:{name:'finnor-nonanticipative-scenario-search',version:EXACT_S4_VERSION,sourceDigests:cut.files,nodeVersion:process.version,deterministicReplayClaimed:false},attempts:[{startedAt,finishedAt:new Date().toISOString(),status:e.status==='COMPLETE'?'POLICY_AVAILABLE':e.status==='INFEASIBLE'?'INFEASIBLE':e.status==='UNKNOWN'?'UNCERTAINTY_UNRESOLVED':'MODEL_UNSUPPORTED'}],usage:{elapsedMs:performance.now()-started,cpuUserMicros:process.cpuUsage(cpu).user,cpuSystemMicros:process.cpuUsage(cpu).system,rssBeforeBytes:rss,rssAfterBytes:process.memoryUsage().rss,expansions:e.stats.continuationEvaluations,transitionEvaluations:e.stats.steps,accountingScope:'PROCESS_INTERVAL_INCLUSIVE_NOT_CONTAINER_PEAK'},cost:{money:null,pricebookRef:null,status:'LOCAL_COST_UNMETERED',externalCalls:0},upstreamComputeRefs:[],admission:{status:'BLOCKED_EXTERNAL',receipt:null}};
 compute.id='model-compute:'+epistemicHash(compute);
 const profile:ExactControlPolicyProfile={schema:'finnor.s4.exact-policy-profile.v2',sourceRef:source.ref,modelBytes:source.model_bytes,modelDigest:source.model_digest,candidate:null,receipt:null,evaluation:e,authoritativeQuantities:'ORIGINAL_EXACT_SOURCE',legacyNumbers:'PRESENTATION_ONLY',dependencyDigest:epistemicHash(source.dependencies),beliefPins:source.belief_pins,sourceDigests:cut.files};
 const policy=buildExactControlPolicy(m,profile,compute,new Date().toISOString(),{deadlineAt,maxSteps:4000000});if(policy)await publishEnterpriseExactControlPolicy(ctx,policy);
 return {schema:'finnor.s4.policy-result.v1',status:policy?'POLICY_AVAILABLE':e.status==='INFEASIBLE'?'INFEASIBLE':e.status==='UNKNOWN'?'UNCERTAINTY_UNRESOLVED':'MODEL_UNSUPPORTED',policy,reasons:e.reasons,compute};
}

/** Versioned ordinary exact consumer. Only the internal independently accepted
 * original full-world checker can supply this writer; no route accepts receipts. */
export async function persistEnterpriseExactControlPolicy(ctx:PeMutationContext,policy:ExactContingentPolicy,check:R2CheckReceipt):Promise<void>{
 const {ref,...body}=policy;
 if(ctx.auth.role!=='owner'||policy.tenantId!==ctx.auth.tenantId||policy.principalId!==actor(ctx)||
  !check.feasible||check.lower!==policy.value||check.policyDigest!==epistemicHash({variant:policy.variant,decisions:policy.decisions,worldCourses:policy.worldCourses})||
  check.originalDigest!==epistemicHash(policy.original)||epistemicHash(ref)!==epistemicHash(r2Ref('exact-contingent-policy',body,'S4')))
  throw new ControlContractError('INVALID_POLICY','Independent exact original policy acceptance differs');
 await readEnterpriseControlDecisionContext(ctx,policy.original.incumbentPolicyRef);
 await saveArtifact(ctx,'exact-policy-checks',check.ref.contentDigest,check);
 await saveArtifact(ctx,'exact-policies',policy.ref.contentDigest,policy);
 await saveEvents(ctx,[prepareS4Experience(policy.original.mandate,'POLICY_SEARCH',policy.ref.id,{policyRef:policy.ref,checkerRef:check.ref,
  exactFiniteWorlds:policy.worldCourses.map(c=>c.worldId),qualification:'SUPPLIED_EXACT_FINITE_MODEL_UNADMITTED',executionAuthorityGranted:false},[policy.original.incumbentPolicyRef.id])]);
}
/** R5's versioned exact choice uses S4's actual private immutable store and
 * prepared experience owner. No route accepts a caller-supplied acceptance. */
export async function persistEnterpriseCoalitionSelection(ctx:PeMutationContext,selection:CoalitionSelection):Promise<void>{
 const {ref,...body}=selection,check=selection.checker;
 if(ctx.auth.role!=='owner'||selection.tenantId!==ctx.auth.tenantId||selection.principalId!==actor(ctx)||
  selection.version!==R5_VERSION||selection.executionAuthorityGranted!==false||selection.reservationGranted!==false||
  ref.owner!=='S4'||ref.version!==R5_VERSION||ref.id!=='coalition-selection:'+ref.contentDigest||
  ref.contentDigest!==epistemicHash(body)||check.originalDigest!==epistemicHash(selection.original)||
  check.candidateDigest!==epistemicHash(selection.candidate)||!check.feasible||check.lower!==selection.value||
  !check.provenance||epistemicHash(selection.tie.checkerIdentity)!==epistemicHash(await coalitionCheckerIdentity())||
  Date.now()>=Date.parse(selection.validUntil))
  throw new ControlContractError('INVALID_POLICY','Independent original joint choice/identity/tie acceptance differs');
 const context=await readEnterpriseControlDecisionContext(ctx,selection.incumbentPolicyRef);
 if(epistemicHash(context.policy.mandateRef)!==epistemicHash(selection.mandateRef)||
  context.policy.bindings.rightsRef!==selection.rightsRef||
  epistemicHash(context.model.ref)!==epistemicHash(selection.original.model.ref))
  throw new ControlContractError('INVALID_POLICY','Current S3/S4 mandate/model differs from exact original joint choice');
 await assertR5SelectionCurrent(ctx,selection);await saveArtifact(ctx,'coalition-selections',ref.contentDigest,selection);
 await saveEvents(ctx,[prepareS4Experience(context.policy.mandate,'POLICY_SEARCH',ref.id,{
  selectionRef:ref,originalRef:selection.originalRef,candidateDigest:check.candidateDigest,
  value:selection.value,demandDigest:selection.demandDigest,tie:selection.tie,
  qualification:selection.qualification,programmeExecutableQualified:false,reservationCreated:false,
  executionAuthorityGranted:false},[selection.incumbentPolicyRef.id,selection.originalRef.id])]);
}

export async function readEnterpriseCoalitionSelection(ctx:PeMutationContext,value:unknown):Promise<CoalitionSelection>{
 const ref=ExperimentRefSchema.parse(value);
 if(ref.owner!=='S4'||ref.version!==R5_VERSION||ref.id!=='coalition-selection:'+ref.contentDigest)throw unavailable();
 const selection=await readArtifact(ctx,'coalition-selections',ref.contentDigest) as CoalitionSelection;
 const {ref:actual,...body}=selection;
 if(selection.schema!=='finnor.s4.coalition-selection.v1'||selection.tenantId!==ctx.auth.tenantId||
  selection.principalId!==actor(ctx)||epistemicHash(actual)!==epistemicHash(ref)||
  epistemicHash(body)!==ref.contentDigest||selection.executionAuthorityGranted!==false||
  Date.now()>=Date.parse(selection.validUntil)||
  epistemicHash(selection.tie.checkerIdentity)!==epistemicHash(await coalitionCheckerIdentity()))throw unavailable();
 await readEnterpriseControlDecisionContext(ctx,selection.incumbentPolicyRef);
 await assertR5SelectionCurrent(ctx,selection);return immutableControl(selection);
}
export async function readEnterpriseExactControlPolicy(ctx:PeMutationContext,value:unknown):Promise<ExactContingentPolicy>{
 const ref=ExperimentRefSchema.parse(value);if(ref.owner!=='S4'||ref.version!==R2_VERSION||ref.id!==`exact-contingent-policy:${ref.contentDigest}`)throw unavailable();
 const policy=await readArtifact(ctx,'exact-policies',ref.contentDigest) as ExactContingentPolicy,{ref:actual,...body}=policy;
 if(policy.schema!=='finnor.s4.exact-contingent-policy.v1'||policy.version!==R2_VERSION||policy.tenantId!==ctx.auth.tenantId||policy.principalId!==actor(ctx)||
  epistemicHash(actual)!==epistemicHash(ref)||epistemicHash(body)!==ref.contentDigest||policy.executionAuthorityGranted!==false||policy.reservationGranted!==false||
  policy.admission.status!=='BLOCKED_EXTERNAL'||policy.admission.receipt!==null||Date.now()>=Date.parse(policy.validUntil))throw unavailable();
 const base=await readEnterpriseControlDecisionContext(ctx,policy.original.incumbentPolicyRef);
 if(epistemicHash(base.policy.mandate)!==epistemicHash(policy.original.mandate)||epistemicHash(base.policy.problem)!==epistemicHash(policy.original.problem)||
  epistemicHash(base.model.request)!==epistemicHash(policy.original.modelRequest)||epistemicHash((await codeIdentity()).files)!==epistemicHash(policy.sourceIdentity))throw unavailable();
 const source=policy.original.sourceRef,versionId=source.id.replace(/^source-version:/,''),
  sourceId=await withTenantTransaction(ctx.auth.tenantId,{userId:actor(ctx),readOnly:true},async(_db,c)=>(await c.query('SELECT source_id::text FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',[ctx.auth.tenantId,versionId])).rows[0]?.source_id);
 if(!sourceId)throw unavailable();const original=await readSourceObject(ctx,base.model.request.roots[0],sourceId,versionId);
 if(original.content_hash!==source.contentDigest||epistemicHash(JSON.parse(original.content))!==epistemicHash(policy.original.source))throw unavailable();
 const check=await readArtifact(ctx,'exact-policy-checks',policy.checkerReceipt.contentDigest) as R2CheckReceipt;
 const {ref:checkRef,...checkBody}=check;
 if(!check.feasible||check.lower!==policy.value||check.originalDigest!==epistemicHash(policy.original)||
  check.policyDigest!==epistemicHash({variant:policy.variant,decisions:policy.decisions,worldCourses:policy.worldCourses})||epistemicHash(check.ref)!==epistemicHash(policy.checkerReceipt)||
  checkRef.contentDigest!==epistemicHash(checkBody)||epistemicHash((await loadR2Runtime()).ref)!==epistemicHash(policy.runtimeRef)||
  epistemicHash(check.provenance.runtimeRef)!==epistemicHash(policy.runtimeRef))throw unavailable();
 return immutableControl(policy);
}
export async function chooseEnterpriseExactControlBranch(ctx:PeMutationContext,input:{policyRef:unknown;decision:unknown;measurements?:Array<{protocol?:unknown;events:unknown[]}>}):Promise<ControlDecision>{
 const policy=await readEnterpriseExactControlPolicy(ctx,input.policyRef),decision=parseControlDecision(input.decision);
 for(const observation of decision.observations){const instrument=policy.original.problem.observations.find(i=>i.id===observation.instrumentId);
  if(!instrument){let matched=false;
   for(const measurement of input.measurements??[]){const {realization:r}=await projectEnterpriseExperiment(ctx,{protocol:measurement.protocol,events:measurement.events}),protocol=measurement.protocol as ExperimentProtocol;
    if(!r.analysis.valid||r.unknownOutcomes.length||observation.sourceRef.owner!=='S2'||observation.sourceRef.id!==r.id||observation.sourceRef.contentDigest!==r.contentDigest||
     !policy.original.protocols.some(p=>p.ref.id===r.protocolRef&&p.ref.contentDigest===protocol.contentDigest)||Date.parse(r.knowledgeAt)>Date.parse(decision.knowledgeAt))continue;
    const tokens=protocol.metrics.observations.filter(o=>epistemicHash(o.counts)===epistemicHash(r.analysis.counts)).map(o=>JSON.stringify({counts:o.counts,sampleSize:o.sampleSize,stop:o.stop}));
    if(observation.instrumentId===protocol.id&&tokens.includes(observation.token))matched=true;
   }
   if(!matched)throw new ControlContractError('INVALID_REQUEST','Current original S2 realization is required for this exact inquiry branch');continue;
  }
  const original=await observeEnterpriseControl(ctx,{policyRef:policy.original.incumbentPolicyRef,instrumentId:instrument.id,availablePeriod:observation.availablePeriod});
  if(epistemicHash(original.ref)!==epistemicHash(observation.sourceRef)||original.token!==observation.token||Date.parse(original.knowledgeAt)>Date.parse(decision.knowledgeAt))
   throw new ControlContractError('INVALID_REQUEST','Exact branch cannot consume a forecast or caller supplied observation');
 }
 const choice=chooseExactS4Branch(policy,decision);await saveArtifact(ctx,'exact-choices',choice.ref.contentDigest,choice);
 await saveEvents(ctx,[prepareS4Experience(policy.original.mandate,'BRANCH_CHOICE',policy.ref.id,{choice,decision,qualification:'EXACT_ORIGINAL_MODEL_BRANCH_REVIEW_NO_EXECUTION'},[policy.ref.id],decision.knowledgeAt)]);
 await readEnterpriseExactControlPolicy(ctx,policy.ref);return choice;
}

/** Receives a conditional acquisition proposal under the existing owner's utility.
 * ACCEPT_FOR_PLANNING grants neither collection, a new policy nor a reservation. */
export async function reviewEnterpriseObservationalAcquisition(ctx:PeMutationContext,input:{
 incumbentPolicyRef:unknown;proposalRef:ExperimentRef|null;
 plan:import('../../shared-types/src/identification-plan').IdentificationPlan|null;
 disposition:'PROPOSE'|'DECLINE'|'WAIT';remainingDeadlineMs:number;originalEpisode:string;
}){
 const {policy}=await readEnterpriseControlDecisionContext(ctx,input.incumbentPolicyRef);
 if(ctx.auth.role!=='owner'||input.remainingDeadlineMs<0||!Number.isFinite(input.remainingDeadlineMs))
  throw unavailable();
 const review=(await import('./r4/owner-adapters')).acquisitionReview(policy,input);
 await saveArtifact(ctx,'acquisition-reviews',review.ref.contentDigest,review);
 const {ref,...content}=review;
 await enqueueNativeReferences(ctx,[{...ref,content}],[policy.mandate.rightsRef]);
 await saveEvents(ctx,[prepareS4Experience(policy.mandate,'POLICY_SEARCH',review.ref.id,{
  review,utilityUnchanged:true,collectionAuthorityGranted:false,policyChanged:false,
 },[policy.ref.id])]);
 await readEnterpriseControlDecisionContext(ctx,policy.ref);
 return immutableControl(review);
}
/** Additive operation algebra, not a relabelled numerical intervention policy.
 * The owner prepares its original reservation before any interface discovery. */
export async function prepareEnterpriseApplicationAcquisition(ctx:PeMutationContext,
 input:import('./application-semantics/native-contracts').ApplicationAcquireRequest){
 const {registerNativeApplicationAcquisition}=await import('./application-semantics/api');
 return registerNativeApplicationAcquisition(ctx,input);
}
/** S4 selects a composition from retained lawful state. P1 can invoke this seam,
 * but cannot supply a model, replace original evidence, or mint authority. */
export async function composeEnterpriseApplicationOperations(ctx:PeMutationContext,input:{
 sessionId:string;initial:import('@finnor/shared-types').ApplicationSnapshot;requiredFirstOperationId?:string;
},client?:PoolClient):Promise<import('@finnor/shared-types').CheckedApplicationComposition>{
 const store=await import('./application-semantics/store'),contracts=await import('./application-semantics/contracts'),
  composition=await import('./application-semantics/composition');
 const row=await store.applicationSession(ctx,input.sessionId,client),request=(await import('./application-semantics/native-contracts')).ApplicationExecuteSchema.parse(row.request);
 await store.currentApplicationWork(ctx,row,client);
 const {model,check}=await store.currentApplicationModel(ctx,row,client);
 const observedRef=contracts.x2Ref('COMPUTER','application-observation',input.initial);
 const observed=await store.applicationArtifact<import('@finnor/shared-types').ApplicationSnapshot>(ctx,observedRef,client);
 if(contracts.x2Digest(observed)!==contracts.x2Digest(input.initial)||request.targetId!==observed.target.id)
  contracts.x2Fault('X2_S4_ORIGINAL_FRESH_OBSERVATION_REQUIRED');
 const profiles=await Promise.all(row.profile_ids.map(id=>store.nativeApplicationProfile(ctx,id)));
 const selected=composition.composeApplicationActions({model,check,initial:observed,goal:request.goal,parameters:request.parameters,
  originalParentRef:row.original_parent_ref,deadlineAt:row.parent.deadlineAt,authorizedRoles:profiles.map(p=>p.profile.role),firstOperationId:input.requiredFirstOperationId});
 if(selected.disposition==='COMPOSED_WITH_REQUIRED_OBSERVATIONS')composition.assertApplicationComposition({composition:selected,model,check,initial:observed});
 const {ref,...body}=selected;
 await store.retainApplicationArtifact(ctx,ref,body,false,client,[row.parent.rightsRevision]);
 await store.applicationEvent(ctx,row,'S4_TYPED_OPERATION_COMPOSITION_SELECTED',{compositionRef:ref,modelRef:model.ref,checkRef:check.ref,
  exploredNodes:selected.exploredNodes,disposition:selected.disposition,originalDeadline:row.parent.deadlineAt,executionAuthorityGranted:false},client);
 return selected;
}

/** Mandatory versioned native map, not an optional caller-provided port. The
 * owned implementation resolves every original C index to current S4 source. */
export const Z3_GENERAL_OPERATION_BINDING='finnor.s4.z3-original-operation-binding.v2' as const;
export async function resolveEnterpriseViabilityBindingsTx(ctx:PeMutationContext,
 request:import('./project-z/z3-viability/general-owners').GeneralOwnerRequest,client:PoolClient){
 return (await import('./project-z/z3-viability/general-owners')).resolveGeneralS4BindingsTx(ctx,request,client);
}
export async function observeEnterpriseViabilityStateTx(ctx:PeMutationContext,
 request:import('./project-z/z3-viability/general-owners').GeneralOwnerRequest,observerId:string,
 invocation:import('./project-z/z3-viability/general-owners').GeneralOwnerInvocation,client:PoolClient){
 return (await import('./project-z/z3-viability/general-owners')).observeGeneralS4StateTx(ctx,request,observerId,invocation,client);
}
export async function dispatchEnterpriseViabilityOperationTx(ctx:PeMutationContext,
 request:import('./project-z/z3-viability/general-owners').GeneralOwnerRequest,edgeIndex:number,
 invocation:import('./project-z/z3-viability/general-owners').GeneralOwnerInvocation,client:PoolClient){
 return (await import('./project-z/z3-viability/general-owners')).dispatchGeneralS4OperationTx(ctx,request,edgeIndex,invocation,client);
}
/** S4-owned entry for the first original-Work Z3 native profile. This is a
 * finite observed prefix, not a verdict-only acknowledgement or effect grant. */
export async function continueEnterpriseViabilityTx(ctx:PeMutationContext,sessionId:string,
 claim:import('./project-z/z3-viability/contracts').ViabilityClaim,client:PoolClient,db:import('@finnor/db').Db){
 return (await import('./project-z/z3-viability/consumer')).consumeCheckedViabilityTx(ctx,sessionId,claim,client,db);
}
/** Independently versioned executable-operation selection. The application
 * owner's governed origin child is the explicit opt-in; the selection itself
 * grants nothing and is consumed under the application owner's own claim. */
export const Z3_EXECUTABLE_OPERATION_BINDING='finnor.s4.z3-original-executable-operation-binding.v1' as const;
export async function readEnterpriseViabilityExecutableSelectionTx(ctx:PeMutationContext,
 request:import('./project-z/z3-viability/general-owners').GeneralOwnerRequest,edgeIndex:number,
 invocation:import('./project-z/z3-viability/general-owners').GeneralOwnerInvocation,client:PoolClient){
 return (await import('./project-z/z3-viability/general-owners')).executableSelectionStateTx(ctx,request,edgeIndex,invocation,client);
}
export async function selectEnterpriseViabilityExecutableOperationTx(ctx:PeMutationContext,
 request:import('./project-z/z3-viability/general-owners').GeneralOwnerRequest,edgeIndex:number,
 invocation:import('./project-z/z3-viability/general-owners').GeneralOwnerInvocation,client:PoolClient){
 return (await import('./project-z/z3-viability/general-owners')).selectGeneralExecutableOperationTx(ctx,request,edgeIndex,invocation,client);
}

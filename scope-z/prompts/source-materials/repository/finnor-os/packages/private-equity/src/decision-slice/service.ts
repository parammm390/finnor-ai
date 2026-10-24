import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ComputeCapacityUnavailableError, withGovernedProviderInvocation } from '../../../db/compute-governor';
import { epistemicHash } from '../../../epistemic-runtime/src/source-precedence';
import type { PeMutationContext } from '../types';
import { resolveDecisionWork, resolveNativeDecision, authorizeNativeBinding, recheckNativeBinding, principal } from './adapters';
import { buildDecisionGraph, proposeExactProjection } from './graph';
import { checkDecisionProjection } from './checker';
import { compileEvidenceDemands } from './evidence-port';
import { evidenceComputeRefs } from '../evidence-execution/consumer';
import { contextSeed, retainContext, serveWorkingContext, patchWorkingContext } from './context';
import { readOptional, readPrivate, readRecord, writePrivate, writeRecord, withStoreLock } from './store';
import { assertBounded, m1Ref, p4Ref, M1_VERSION, RequestSchema, same, unavailable, DecisionSliceError,
  type DecisionSlice, type M1Ref, type NativeBinding, type ProjectionInput, type DecisionSliceRequest } from './contracts';
import { checkEpisode, episodeDeadline, withinM1Deadline } from './budget';

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../../../..');
const sourcePaths=[
  ...['contracts','adapters','graph','checker','evidence-port','p4-port','store','context','service','consumer','handler','budget']
    .map(name=>`finnor-os/packages/private-equity/src/decision-slice/${name}.ts`),
  'finnor-os/packages/private-equity/src/enterprise-beliefs.ts','finnor-os/packages/private-equity/src/world-state.ts',
  'finnor-os/packages/private-equity/src/enterprise-control.ts','finnor-os/packages/private-equity/src/enterprise-interventions.ts',
  'finnor-os/packages/private-equity/src/enterprise-allocation.ts','finnor-os/packages/private-equity/src/allocation-store.ts',
  'finnor-os/packages/private-equity/src/underwriting-repository.ts',
  ...['compiler','executor','snapshot','standard-lbo','decimal'].map(name=>`finnor-os/packages/underwriting/src/${name}.ts`),
  'finnor-os/packages/epistemic-runtime/src/intervention-control.ts','finnor-os/packages/epistemic-runtime/src/allocation-checker.ts',
  'finnor-os/packages/db/compute-governor.ts',
  'finnor-os/packages/db/execution-deadline.ts','finnor-os/packages/db/index.ts',
  'finnor-os/packages/private-equity/src/decision-slice/model-read-scope.ts','finnor-os/packages/private-equity/src/decision-slice/model-evidence-reader.ts',
  'finnor-os/packages/security/src/auth.ts','finnor-os/apps/api/app/api/company-brain/[operation]/route.ts',
];
const loadedSources=sourcePaths.map(path=>({path,sha256:createHash('sha256').update(readFileSync(resolve(repo,path))).digest('hex')}));
function currentCode():void{
  if(loadedSources.some(source=>createHash('sha256').update(readFileSync(resolve(repo,source.path))).digest('hex')!==source.sha256))
    throw new DecisionSliceError('STALE_INPUT','Loaded M1/native method sources changed; restart at an explicit version');
}
function nativeProfile():void{
  if(process.env.FINNOR_M1_PROFILE!=='DISPOSABLE_NATIVE'||process.env.NODE_ENV==='production'||process.env.FINNOR_ENVIRONMENT==='production')
    throw new DecisionSliceError('CONFIGURATION_REQUIRED','M1 ordinary native execution requires a configured disposable profile; protected funding/admission/runtime are unavailable');
}
interface WorkHead {generation:number;publishedGeneration:number|null;requestDigest:string;cancelled:boolean;publishedRef:M1Ref|null}
interface Publication {schema:'finnor.m1.publication.v1';sliceRef:M1Ref;bindingRef:M1Ref;contextSeedRef:M1Ref;
  generation:number;headKey:string;invocationRef:M1Ref}
const headKey=(workId:string)=>epistemicHash(`work:${workId}`);
export interface CurrentSlice {slice:DecisionSlice;binding:NativeBinding;publication:Publication;projectionInput:ProjectionInput}
const metering=new AsyncLocalStorage<{deadline:number;signal:AbortSignal;invocationRef:M1Ref}>();
export async function retainedDecisionWorkId(ctx:PeMutationContext,value:unknown):Promise<string>{
  return (await readRecord<Omit<DecisionSlice,'ref'>>(ctx,'slices',value)).envelope.work.id;
}
function timeCheck(deadline:number,signal?:AbortSignal):void{
  checkEpisode();
  if(signal?.aborted)throw new DecisionSliceError('CANCELLED','Shared compute permit was lost');
  if(performance.now()>=deadline)throw new DecisionSliceError('LIMIT_EXCEEDED','Whole M1 invocation deadline exhausted');
}
export async function measuredM1<T>(ctx:PeMutationContext,operation:string,workId:string,deadlineMs:number,
  invoke:(deadline:number,signal:AbortSignal,invocationRef:M1Ref)=>Promise<T>):Promise<T>{
  const parent=metering.getStore();
  if(parent){timeCheck(parent.deadline,parent.signal);return invoke(parent.deadline,parent.signal,parent.invocationRef);}
  nativeProfile();currentCode();await resolveDecisionWork(ctx,workId);
  const started=performance.now(),cpu=process.cpuUsage(),rss=process.memoryUsage().rss;
  const start={schema:'finnor.m1.native-invocation-start.v1',operation,tenantId:ctx.auth.tenantId,principalId:principal(ctx),
    workId,startedAt:new Date().toISOString(),actualRoute:'LOCAL_TRUSTED_NATIVE_OWNER_ADAPTERS',requestedRoute:'LOCAL_TRUSTED_NATIVE_OWNER_ADAPTERS',
    modelInvocations:[],fallbacks:[],sourceDigests:loadedSources,runtime:{nodeVersion:process.version,platform:process.platform,architecture:process.arch,imageAttestation:null},
    resource:{deadlineMs,financialAllocation:null},cost:{money:null,status:'UNMETERED',externalModelCalls:0},
    measurementScope:'PROCESS_INTERVAL_INCLUSIVE_NOT_CONTAINER_OR_AGGREGATE_PEAK',admission:'BLOCKED_EXTERNAL'};
  const ref=m1Ref('m1-invocation',start);await writeRecord(ctx,'attempts',ref,start);
  let result:T|undefined,status='FAILED',failure:string|null=null;
  try{
    result=await withGovernedProviderInvocation({provider:'m1-native',tenantId:ctx.auth.tenantId,ownerId:ref.id},
      async signal=>{
        const original=Math.min(started+deadlineMs,episodeDeadline(deadlineMs));
        const remaining=original-performance.now(),reserve=Math.min(100,Math.max(0,Math.floor(remaining/4)));
        const deadline=original-reserve;timeCheck(deadline,signal);
        return withinM1Deadline(deadline,()=>metering.run({deadline,signal,invocationRef:ref},()=>invoke(deadline,signal,ref)));
      });
    status='COMPLETED';return result;
  }catch(error){
    if(error instanceof ComputeCapacityUnavailableError){
      failure='SHARED_COMPUTE_CAPACITY_UNAVAILABLE';
      throw new DecisionSliceError('CONFLICT','Shared native compute capacity is unavailable; retry within the same resource envelope');
    }
    failure=error instanceof DecisionSliceError?error.code:'NATIVE_OWNER_OR_STORAGE_FAILURE';throw error;
  }
  finally{
    const usage=process.cpuUsage(cpu),finish={schema:'finnor.m1.native-invocation-finish.v1',startRef:ref,status,failure,
      finishedAt:new Date().toISOString(),usage:{elapsedMs:performance.now()-started,cpuUserMicros:usage.user,cpuSystemMicros:usage.system,
        rssBeforeBytes:rss,rssAfterBytes:process.memoryUsage().rss,resultBytes:result===undefined?null:Buffer.byteLength(JSON.stringify(result))},
      cost:{money:null,status:'UNMETERED',cancelledOrFailedLiabilityRetained:true,canonicalDestination:'M1_PRIVATE_PREPARED_ATTEMPT'},
      qualifiedExperienceLedgerAppendRef:null};
    const finishRef=m1Ref('m1-invocation-finish',finish);
    // Accounting persistence failures are not silently reported as a successful
    // fully reconciled invocation. The start record still retains the liability.
    await writeRecord(ctx,'attempts',finishRef,finish);
    await writePrivate(ctx,'heads',epistemicHash(`invocation:${ref.contentDigest}`),{finishRef});
  }
}
export async function compileDecisionSlice(ctx:PeMutationContext,value:unknown):Promise<{slice:DecisionSlice}>{
  assertBounded(value,64*1024);const request=RequestSchema.parse(value);
  return measuredM1(ctx,'COMPILE',request.workId,request.resource.deadlineMs,async(deadline,signal,invocationRef)=>{
    const key=headKey(request.workId),requestDigest=epistemicHash(request);
    const generation=await withStoreLock(ctx,key,async()=>{
      const prior=await readOptional<WorkHead>(ctx,'heads',key),generation=(prior?.generation??0)+1;
      await writePrivate(ctx,'heads',key,{generation,requestDigest,cancelled:false,
        publishedRef:prior?.cancelled?null:prior?.publishedRef??null,
        publishedGeneration:prior?.cancelled?null:prior?.publishedGeneration??null});return generation;
    },deadline);
    const binding=await resolveNativeDecision(ctx,request);timeCheck(deadline,signal);
    const graph=buildDecisionGraph(binding),witness=proposeExactProjection(graph);
    const check=checkDecisionProjection({binding,graph},witness);
    if(check.status!=='CHECKED'||!check.exactPreservation)throw new DecisionSliceError('CHECK_FAILED','Independent declared dependency projection check failed');
    const materialVariables=graph.nodes.filter(node=>witness.retainedIds.includes(node.id));
    const views=binding.views.map(view=>({root:view.root,pin:view.pin,ownerViewRef:view.id,coverage:view.coverage}));
    const universeBody={tenantId:binding.tenantId,principalId:binding.principalId,views,
      interpretation:'COMPLETE_PERMITTED_OWNER_VIEW_HANDLES_NOT_GLOBAL_ABSENCE',dependencyVector:binding.dependencyVector};
    const universeRef=m1Ref('permissioned-source-universe',universeBody);
    const fullEvidenceHandles={ref:universeRef,views,retrievalOperation:'belief-view' as const,
      p4:binding.p4.map(d=>({ownerRef:p4Ref(d),queryId:d.queryId,retrievalOperation:'evidence-read',handles:d.sourceHandles})),
      allPermittedSourcesAccessibleByOwner:true as const,globalAbsenceClaimsPermitted:false as const};
    const seed=contextSeed(binding,{materialVariables,unresolvedCoverage:binding.gaps,fullEvidenceHandles});
    const mandateRefs=[...new Map(binding.policies.map(p=>[p.policy.mandateRef.id,p.policy.mandateRef])).values()];
    const candidateRefs=[...binding.underwriting.flatMap(c=>[c.modelRef,...(c.scenarioRef?[c.scenarioRef]:[])]),...binding.policies.map(p=>p.policy.ref)];
    const incumbentRefs=request.source.kind==='POLICY'&&request.source.incumbentRef?[request.source.incumbentRef]:[];
    const policyRequestBody={mandateRefs,candidateRefs,incumbentRefs,work:binding.work,purpose:request.purpose,
      source:request.source,validAt:binding.views[0]?.validAt??new Date().toISOString(),dependencyDigest:epistemicHash(binding.dependencyVector)};
    const policyRequest={ref:m1Ref('decision-policy-request',policyRequestBody),
      kind:mandateRefs.length?'NATIVE_S4_POLICY_REQUEST' as const:'WORK_NUMERICAL_REQUEST_S4_MANDATE_UNAVAILABLE' as const,mandateRefs,candidateRefs,incumbentRefs};
    const upstreamComputeRefs=[...new Set(binding.policies.flatMap(p=>[p.policy.compute.id,p.model.compute.id,p.kernel.compute.id])
      .concat(binding.allocation?[binding.allocation.certificate.compute.id]:[])
      .concat(binding.p4.flatMap(evidenceComputeRefs)))];
    const evidenceDemands=compileEvidenceDemands(binding,graph,new Date(Date.now()+Math.max(0,deadline-performance.now())).toISOString());
    const body:Omit<DecisionSlice,'ref'>={
      schema:'finnor.decision-slice.v1',
      envelope:{tenantId:binding.tenantId,principalId:binding.principalId,sharingScope:'PRIVATE_PRINCIPAL',work:binding.work,
        mandateRefs,allowedChangeEnvelopeRef:mandateRefs.length?null:binding.work.ref,parents:candidateRefs,inputDigest:epistemicHash(binding),
        validAt:binding.views[0]?.validAt??new Date().toISOString(),knowledgeAt:binding.views[0]?.knowledgeAt??new Date().toISOString(),
        validUntil:binding.validUntil,rights:binding.views.map(v=>v.rights),ownerVector:binding.dependencyVector,
        producerVersion:M1_VERSION,sourceDigests:loadedSources,
        runtime:{nodeVersion:process.version,platform:process.platform,architecture:process.arch,imageAttestation:null},
        invocationRef,computeAllocationRef:null,cost:{money:null,status:'UNMETERED',accountingDestination:'M1_PRIVATE_PREPARED_ATTEMPT',
          upstreamComputeRefs,upstreamChargesDuplicated:false,
          upstreamP4:binding.p4.map(d=>({derivationRef:p4Ref(d),queryId:d.queryId,jobId:d.runtime.jobId,deliveryAttemptId:d.runtime.deliveryAttemptId,
            sourceAcquisitionReceipts:d.sourceHandles.flatMap(h=>h.acquisitionInvocations),nativeExecutionReceipts:d.costs.nativeInvocations,
            unreconciledAttemptIds:d.costs.unreconciledAttemptIds,accountingOwner:'P4',countedAsNewM1Work:false,usd:null,status:d.costs.status}))},
        admission:{status:'BLOCKED_EXTERNAL',receipt:null},
        state:'PROPOSED_TESTED',executionAuthorityGranted:false},
      policyRequest,candidateDependencies:graph,materialVariables,
      derivedEvidence:[...binding.underwriting.map(candidate=>({producer:'NATIVE' as const,ownerRef:candidate.modelRef,
        qualification:'AUTHENTICATED_S1_PINNED_NATIVE_INPUT_NOT_P4_DERIVATION',inputDigest:candidate.input.semanticHash!})),
        ...binding.policies.map(p=>({producer:'NATIVE' as const,ownerRef:p.policy.ref,qualification:'S4_OWNER_POLICY_WITH_RETAINED_S3_JOINT_LAW',inputDigest:epistemicHash(p)})),
        ...(binding.allocation?[{producer:'NATIVE' as const,ownerRef:binding.allocation.certificate.ref,
          qualification:'S5_EXACT_CONSTRAINT_CERTIFICATE_NOT_EFFECT_AUTHORITY',inputDigest:binding.allocation.problem.ref.contentDigest}]:[]),
        ...binding.p4.map(d=>({producer:'P4' as const,ownerRef:p4Ref(d),qualification:'P4_EXACT_TESTED_FINANCIAL_DERIVATION_NOT_FACT_OR_OPERATIVE_DOCUMENT_COMPLETENESS',
          inputDigest:d.inputsDigest}))],
      workingContext:{seedRef:seed.ref,qualifiedDigest:seed.qualifiedDigest},
      inquirySuggestions:binding.gaps.map(gap=>({schema:'finnor.m1.s2-protocol-suggestion.v1' as const,premiseId:gap.id,
        affectedRoots:gap.affectedRoots.length?gap.affectedRoots:graph.roots.map(r=>r.id),requirement:gap.requirement,
        status:'PROPOSED_ONLY' as const,measurementLaw:null,exposureGranted:false as const,selectionOwner:'S4' as const})),
      projectionLoss:null,projectionLossReason:'No S4-authorized numeric loss budget; separate checker proves only exact declared dependency preservation',
      projectionBudgetRequest:{schema:'finnor.m1.s4-projection-budget-request.v1',mandateRefs,authorizationGranted:false,
        requestedContract:['Immutable S4/business-owner loss definition, unit, scale, domain, joint numeric budget and authority qualification',
          'Hard feasibility/authority/rights/branch constraints cannot be relaxed by payoff error']},
      projectionSupport:{status:'EXACT_DEPENDENCY_PRESERVATION',witness,check},evidenceDemands,
      unresolvedCoverage:binding.gaps,fullEvidenceHandles,limitations:binding.qualifications,
    };
    assertBounded(body,request.resource.maxBytes);
    const slice={...body,ref:m1Ref('decision-slice',body)},bindingRef=m1Ref('native-binding',binding);
    await writeRecord(ctx,'bindings',bindingRef,binding);
    const {ref:graphRef,...graphBody}=graph;await writeRecord(ctx,'graphs',graphRef,graphBody);
    await retainContext(ctx,seed);
    await writeRecord(ctx,'slices',slice.ref,body);
    const publication:Publication={schema:'finnor.m1.publication.v1',sliceRef:slice.ref,bindingRef,contextSeedRef:seed.ref,generation,headKey:key,invocationRef};
    await withStoreLock(ctx,key,async()=>{
      const head=await readPrivate<WorkHead>(ctx,'heads',key);
      if(head.generation!==generation||head.cancelled||head.requestDigest!==requestDigest)throw new DecisionSliceError('CANCELLED','A newer Work generation superseded this producer');
      timeCheck(deadline,signal);await recheckNativeBinding(ctx,binding);timeCheck(deadline,signal);currentCode();
      // Dependency records and context/check are durable before the publication
      // manifest. A missing manifest is never served as an issued slice.
      for(const dependency of binding.dependencyVector){
        const indexKey=epistemicHash(dependency.key),prior=await readOptional<{entries:Array<{sliceRef:M1Ref;digest:string}>}>(ctx,'dependencies',indexKey);
        const entries=[...(prior?.entries??[]),{sliceRef:slice.ref,digest:dependency.digest}];
        if(entries.length>256)throw new DecisionSliceError('LIMIT_EXCEEDED','Dependency history requires operator compaction before further publication');
        await writePrivate(ctx,'dependencies',indexKey,{entries});
      }
      await writePrivate(ctx,'publications',slice.ref.contentDigest,publication,true);
      await writePrivate(ctx,'heads',key,{...head,publishedRef:slice.ref,publishedGeneration:generation});
    },deadline);
    return {slice};
  });
}
export async function readCurrentDecisionSlice(ctx:PeMutationContext,value:unknown):Promise<CurrentSlice>{
  checkEpisode();
  currentCode();
  const body=await readRecord<Omit<DecisionSlice,'ref'>>(ctx,'slices',value),slice={...body,ref:value as M1Ref};
  const publication=await readPrivate<Publication>(ctx,'publications',slice.ref.contentDigest);
  if(!same(publication.sliceRef,slice.ref))throw unavailable();
  const binding=await readRecord<NativeBinding>(ctx,'bindings',publication.bindingRef);
  await authorizeNativeBinding(ctx,binding);
  if(!same(loadedSources,slice.envelope.sourceDigests))throw new DecisionSliceError('STALE_INPUT','Slice producer/native source version differs');
  const head=await readPrivate<WorkHead>(ctx,'heads',publication.headKey);
  if(head.cancelled||head.publishedGeneration!==publication.generation||!same(head.publishedRef,slice.ref))
    throw new DecisionSliceError('STALE_INPUT','Decision slice generation is no longer current');
  try{await recheckNativeBinding(ctx,binding);}
  catch(error){
    if(error instanceof DecisionSliceError&&error.code==='STALE_INPUT'){
      const event={schema:'finnor.m1.slice-invalidation.v1',sliceRef:slice.ref,reason:error.message,
        dependencyVector:binding.dependencyVector,at:new Date().toISOString(),priorInvocationsRetained:true};
      await writeRecord(ctx,'invalidations',m1Ref('slice-invalidation',event),event);
    }
    throw error;
  }
  if(slice.envelope.inputDigest!==epistemicHash(binding)||!same(slice.candidateDependencies.bindingDigest,epistemicHash(binding)))throw unavailable();
  const projectionInput={binding,graph:slice.candidateDependencies},check=checkDecisionProjection(projectionInput,slice.projectionSupport.witness);
  if(check.status!=='CHECKED'||!same(check,slice.projectionSupport.check))throw new DecisionSliceError('CHECK_FAILED','Retained decision projection support failed replay');
  // Source/rights and generation checks are repeated immediately before serving.
  await authorizeNativeBinding(ctx,binding);
  const after=await readPrivate<WorkHead>(ctx,'heads',publication.headKey);
  if(after.publishedGeneration!==head.publishedGeneration||after.cancelled)throw new DecisionSliceError('STALE_INPUT','Decision changed during read');
  return {slice,binding,publication,projectionInput};
}
export async function decisionSliceContext(ctx:PeMutationContext,value:unknown){
  const current=await readCurrentDecisionSlice(ctx,value);
  return measuredM1(ctx,'CONTEXT_RECONSTRUCTION',current.binding.work.id,30000,async()=>{
    const result=await serveWorkingContext(ctx,current.slice);await readCurrentDecisionSlice(ctx,value);
    return {...result,sliceRef:current.slice.ref,executionAuthorityGranted:false};
  });
}
export async function decisionSlicePatch(ctx:PeMutationContext,value:unknown,expected:unknown,patch:unknown){
  const current=await readCurrentDecisionSlice(ctx,value);
  return measuredM1(ctx,'CONTEXT_PATCH',current.binding.work.id,30000,async()=>{
    const context=await patchWorkingContext(ctx,current.slice,expected,patch);
    await readCurrentDecisionSlice(ctx,value);return {context,sliceRef:current.slice.ref,executionAuthorityGranted:false};
  });
}
export async function cancelDecisionSlice(ctx:PeMutationContext,value:unknown){
  // Cancellation exposes no retained evidence and must not wait on the very
  // source computation it fences. Live Work/principal authority still applies.
  const body=await readRecord<Omit<DecisionSlice,'ref'>>(ctx,'slices',value);
  const publication=await readPrivate<Publication>(ctx,'publications',(value as M1Ref).contentDigest);
  if(!same(publication.sliceRef,value)||publication.headKey!==headKey(body.envelope.work.id))throw unavailable();
  await resolveDecisionWork(ctx,body.envelope.work.id);
  return withStoreLock(ctx,publication.headKey,async()=>{
    const head=await readPrivate<WorkHead>(ctx,'heads',publication.headKey);
    if(head.publishedGeneration!==publication.generation||!same(head.publishedRef,value))
      throw new DecisionSliceError('CONFLICT','Decision generation changed');
    await writePrivate(ctx,'heads',publication.headKey,{...head,generation:head.generation+1,cancelled:true});
    const event={schema:'finnor.m1.slice-cancellation.v1',sliceRef:value,at:new Date().toISOString(),
      attemptsAndCostLiabilityRetained:true,executionAuthorityGranted:false};
    const ref=m1Ref('slice-cancellation',event);await writeRecord(ctx,'invalidations',ref,event);return {...event,ref};
  });
}
export async function recompileDecisionSlice(ctx:PeMutationContext,value:unknown){
  // Invalidated records are not read as current. Resolve their retained request
  // only after current rights, then build a fresh closure with fresh owner clocks.
  const body=await readRecord<Omit<DecisionSlice,'ref'>>(ctx,'slices',value),publication=await readPrivate<Publication>(ctx,'publications',(value as M1Ref).contentDigest);
  const binding=await readRecord<NativeBinding>(ctx,'bindings',publication.bindingRef);await authorizeNativeBinding(ctx,binding);
  if(!same(publication.sliceRef,value)||body.envelope.inputDigest!==epistemicHash(binding))throw unavailable();
  const {validAt:_validAt,knowledgeAt:_knowledgeAt,...request}=binding.request;
  const source=request.source.kind==='UNDERWRITING'?(({worldAt:_worldAt,...source})=>source)(request.source):request.source;
  return compileDecisionSlice(ctx,{...request,source});
}
export async function inspectDependencyChanges(ctx:PeMutationContext,value:unknown){
  const body=await readRecord<Omit<DecisionSlice,'ref'>>(ctx,'slices',value),publication=await readPrivate<Publication>(ctx,'publications',(value as M1Ref).contentDigest);
  const binding=await readRecord<NativeBinding>(ctx,'bindings',publication.bindingRef);await authorizeNativeBinding(ctx,binding);
  const {validAt:_validAt,knowledgeAt:_knowledgeAt,...request}=binding.request;
  const current=await resolveNativeDecision(ctx,request as DecisionSliceRequest),before=new Map(binding.dependencyVector.map(d=>[d.key,d.digest]));
  const changed=[...new Set([...before.keys(),...current.dependencyVector.map(d=>d.key)])]
    .filter(key=>before.get(key)!==current.dependencyVector.find(d=>d.key===key)?.digest);
  return {sliceRef:value,status:changed.length?'INVALIDATED':'DEPENDENCIES_MATCH',changedKeys:changed,
    affectedRoots:changed.length?body.candidateDependencies.roots.map(r=>r.id):[],retainedUnchangedOwnerKeys:current.dependencyVector.filter(d=>before.get(d.key)===d.digest).map(d=>d.key),
    computationReused:false,reason:'Owner snapshot comparison, not a claim of incremental numerical reuse',executionAuthorityGranted:false};
}

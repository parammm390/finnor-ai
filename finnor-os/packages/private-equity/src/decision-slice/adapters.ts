import { withTenantTransaction } from '@finnor/db';
import { canExerciseAuthority, employeeAuthoritySnapshot } from '@finnor/authority';
import type { BeliefView, BeliefClaim, ExperimentRef } from '@finnor/shared-types';
import { compileUnderwritingModel, sealInputSnapshot, type UnderwritingModelIR, type UnderwritingInputSnapshot,
  type ResolvedInput } from '@finnor/underwriting';
import { epistemicHash } from '../../../epistemic-runtime/src/source-precedence';
import { loadEnterpriseBeliefView, authorizeBeliefResources, authorizeBeliefSourceScopes, validateBeliefViewPin } from '../enterprise-beliefs';
import { prepareUnderwritingRun } from '../underwriting-repository';
import { readEnterpriseControlDecisionContexts } from '../enterprise-control';
import { readEnterpriseAllocation, validateEnterpriseAllocation } from '../enterprise-allocation';
import { readAllocationSnapshot } from '../allocation-store';
import { authorizePrivateEquityWorldState } from '../world-state';
import type { PeMutationContext, PeWorldRootRef } from '../types';
import { copyJson, DecisionSliceError, unavailable, p4Ref, type DecisionSliceRequest, type Gap, type NativeBinding,
  type UnderwritingBinding, type WorkBinding } from './contracts';
import {permitsCompletedModelRead} from './model-read-scope';
import { checkEpisode } from './budget';
import { resolveP4Inputs, recheckP4Derivations } from './p4-port';

export const principal = (ctx:PeMutationContext):string => ctx.auth.employeeId??ctx.auth.userId;
const gap = (code:string,requirement:string,requiredProducer:Gap['requiredProducer'],status:Gap['status']='UNKNOWN',affectedRoots:string[]=[]):Gap => ({
  id:epistemicHash({code,requirement,requiredProducer,affectedRoots}),code,requirement,requiredProducer,status,affectedRoots,
});
export async function resolveDecisionWork(ctx:PeMutationContext,workId:string):Promise<WorkBinding>{
  checkEpisode();
  try{
    const authority=await employeeAuthoritySnapshot(ctx.auth);
    if(!await canExerciseAuthority(ctx.auth,{operation:'query',capability:'query:pe_world_state',resource:{type:'work',id:workId},risk:'low'}))throw unavailable();
    const result=await withTenantTransaction(ctx.auth.tenantId,{userId:principal(ctx),readOnly:true},async(_db,c)=>{
      const row=(await c.query<{id:string;status:string;current_owner_id:string|null;created_by:string|null}>(
        'SELECT id::text,status,current_owner_id::text,created_by::text FROM finnor_os.works WHERE tenant_id=$1 AND id=$2',[ctx.auth.tenantId,workId])).rows[0];
      const user=(await c.query("SELECT id,role FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 AND status='active'",[ctx.auth.tenantId,principal(ctx)])).rows[0];
      // The initial complete resource/liability adapter is owner-only. A claimed
      // role never substitutes for the authority owner's live principal record.
      if(!row||!user||user.role!=='owner'||ctx.auth.role!=='owner')throw unavailable();
      const input=(await c.query(
        'SELECT id::text,instruction_id::text,instruction_text,channel,context_snapshot_hash,created_by::text,created_at FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
        [ctx.auth.tenantId,workId])).rows[0];
      if(!input)throw unavailable();
      return {row,input};
    });
    if(authority.revision!==(await employeeAuthoritySnapshot(ctx.auth)).revision)throw unavailable();
    if(['cancelled','failed'].includes(result.row.status)||(result.row.status==='completed'&&!permitsCompletedModelRead({tenantId:ctx.auth.tenantId,principalId:principal(ctx),workId,workInputId:result.input.id})))throw new DecisionSliceError('STALE_INPUT','Work is no longer available for decision preparation');
    const body={workId:result.row.id,input:copyJson(result.input),owner:result.row.current_owner_id,rightsRevision:authority.revision};
    const inputDigest=epistemicHash(body);
    return {id:workId,inputId:result.input.id,inputDigest,status:result.row.status,
      ref:{owner:'@finnor/db',id:result.input.id,version:'work-input-v1',contentDigest:inputDigest}};
  }catch(error){if(error instanceof DecisionSliceError)throw error;throw unavailable();}
}
function stableView(view:BeliefView):unknown {
  return {root:view.root,pinDependency:view.pin.dependencyDigest,rightsRevision:view.rights.revision,
    interpretationVersion:view.interpretationVersion,coverage:view.coverage,contradictions:view.contradictions,
    claimRefs:view.claims.map(c=>c.ownerRef)};
}
function allowedClaim(view:BeliefView,kind:string,id:string):BeliefClaim|undefined{
  return view.claims.find(claim=>claim.ownerRef.entityType===kind&&claim.ownerRef.id===id);
}
async function resolveUnderwriting(ctx:PeMutationContext,request:DecisionSliceRequest,view:BeliefView,gaps:Gap[],
  external:Awaited<ReturnType<typeof resolveP4Inputs>>):Promise<UnderwritingBinding[]>{
  if(request.source.kind!=='UNDERWRITING')return [];
  const source=request.source;
  await authorizeBeliefResources(ctx,[{type:'pe_investment_case',id:source.investmentCaseId},{type:'underwriting_model_version',id:source.modelVersionId},
    ...(source.scenarioIds??[]).map(id=>({type:'underwriting_scenario',id}))]);
  const stored=await withTenantTransaction(ctx.auth.tenantId,{userId:principal(ctx),readOnly:true},async(_db,c)=>{
    const row=(await c.query<{model_definition:UnderwritingModelIR;semantic_hash:string}>(
      'SELECT model_definition,semantic_hash FROM finnor_os.underwriting_model_versions WHERE tenant_id=$1 AND investment_case_id=$2 AND id=$3',
      [ctx.auth.tenantId,source.investmentCaseId,source.modelVersionId])).rows[0];if(!row)throw unavailable();return row;
  });
  checkEpisode();
  if(stored.model_definition.nodes.length>request.resource.maxNodes)throw new DecisionSliceError('LIMIT_EXCEEDED','Native model exceeds the decision node envelope');
  const compiled=compileUnderwritingModel(stored.model_definition,checkEpisode);
  if(compiled.semanticHash!==stored.semantic_hash)throw unavailable();
  if(compiled.model.nodes.length>request.resource.maxNodes)throw new DecisionSliceError('LIMIT_EXCEEDED','Native model exceeds the decision node envelope');
  if(Object.keys(external.failures).some(id=>compiled.nodeById[id]?.kind!=='input'))
    throw new DecisionSliceError('INVALID_REQUEST','P4 input references must bind declared native input nodes');
  const resources:Array<{type:string;id:string}>=[],qualifications:UnderwritingBinding['inputQualifications']=[];
  let allSourcesVisible=true;
  for(const node of compiled.model.nodes){
    checkEpisode();
    if(node.kind!=='input')continue;
    const externalValue=external.values[node.id];
    if(externalValue){
      qualifications.push({nodeId:node.id,status:externalValue.status,reasons:externalValue.reason?[externalValue.reason]:[],witnesses:[...externalValue.provenance]});
      continue;
    }
    if(external.failures[node.id]){
      allSourcesVisible=false;
      qualifications.push({nodeId:node.id,status:'UNKNOWN',reasons:[external.failures[node.id]!],witnesses:[]});
      gaps.push(gap(external.failures[node.id]!,`Typed input ${node.id} requires a current complete P4 scalar with exact declared financial semantics.`,
        'P4',external.failures[node.id]==='P4_SEMANTIC_INPUT_MISMATCH'?'CONTRADICTORY':'UNKNOWN',[`${source.modelVersionId}:${node.id}`]));
      continue;
    }
    const b=node.source;let witness:unknown[]=[];
    let claim:BeliefClaim|undefined,status='NATIVE_PENDING',reason='';
    if(b?.kind==='p1_assumption'&&b.assumptionId){
      resources.push({type:'pe_assumption',id:b.assumptionId});claim=allowedClaim(view,'pe_assumption',b.assumptionId);
    }else if(b?.kind==='evidence_version'&&b.evidenceVersionId){
      resources.push({type:'evidence_source_version',id:b.evidenceVersionId});claim=allowedClaim(view,'evidence_source_version',b.evidenceVersionId);
    }else if(b?.kind==='artifact_anchor'&&b.documentId){
      resources.push({type:'document',id:b.documentId},{type:'document_version',id:b.documentVersionId!});
      // Current artifact clocks alone cannot certify historical S1 commit visibility.
      status='UNSUPPORTED';reason='ARTIFACT_INPUT_REQUIRES_P4_S1_COMMIT_VISIBLE_DOCUMENT_STANDING';
    }else{status='UNKNOWN';reason='EXPLICIT_MODEL_INPUT_REQUIRES_OWNER_RESOLVED_VALUE_NOT_CALLER_NUMBER';}
    if(claim)witness=[claim.ownerRef,...claim.provenance];
    else{allSourcesVisible=false;if(!reason){status='UNKNOWN';reason='BOUND_SOURCE_NOT_IN_PERMISSIONED_S1_KNOWLEDGE_CUT';}}
    qualifications.push({nodeId:node.id,status,reasons:reason?[reason]:[],witnesses:witness});
    if(reason)gaps.push(gap(reason,`Resolve exact entity/period/unit/source standing for ${node.id}`,'P4','PENDING_DEPENDENCY',[`${source.modelVersionId}:${node.id}`]));
  }
  if(resources.length)await authorizeBeliefResources(ctx,resources);
  const worldAt=source.worldAt??view.knowledgeAt;
  if(Date.parse(worldAt)>Date.parse(view.knowledgeAt))throw new DecisionSliceError('INVALID_REQUEST','Native worldAt is beyond the authorized S1 knowledge cut');
  if(source.worldAt&&worldAt!==view.knowledgeAt){
    gaps.push(gap('NATIVE_WORLD_KNOWLEDGE_CUT_MISMATCH','Use the same exact native and S1 knowledge cut; a business timestamp is not commit visibility','S1'));
    allSourcesVisible=false;
  }
  const nativeRef:ExperimentRef={owner:'@finnor/underwriting',id:source.modelVersionId,version:compiled.model.modelVersion,contentDigest:compiled.semanticHash};
  const results:UnderwritingBinding[]=[];
  for(const scenarioId of [undefined,...source.scenarioIds??[]]){
    checkEpisode();
    let input:UnderwritingInputSnapshot,scenarioRef:ExperimentRef|null=null;
    if(allSourcesVisible){
      const prepared=await prepareUnderwritingRun(ctx,{investmentCaseId:source.investmentCaseId,modelVersionId:source.modelVersionId,
        worldAt,scenarioId,evidenceDerivationInputs:source.evidenceDerivationInputs});
      input=copyJson(prepared.effectiveSnapshot);
      if(scenarioId)scenarioRef={owner:'@finnor/underwriting',id:scenarioId,version:'underwriting-scenario.v1',contentDigest:prepared.scenarioSemanticHash!};
      for(const q of qualifications){
        const value=input.values[q.nodeId];if(!value)throw unavailable();q.status=value.status;
        q.reasons=[...(value?.reason?[value.reason]:[]),...q.reasons];
        // Native assumption/evidence provenance must agree with the permitted S1
        // owner preimage. S1 records shaped JSON; exact financial decimals remain
        // native, rather than computed from nested JavaScript numbers.
        const baseValue=prepared.baseSnapshot.values[q.nodeId];
        if(baseValue?.truthClass==='CANONICAL_ASSUMPTION'){
          const node=compiled.nodeById[q.nodeId];if(!node||node.kind!=='input')throw unavailable();
          const claim=allowedClaim(view,'pe_assumption',node.source!.assumptionId!);
          const historyRef=baseValue.provenance.find(p=>p.kind==='p1_assumption')?.versionId;
          const history=historyRef?await withTenantTransaction(ctx.auth.tenantId,{userId:principal(ctx),readOnly:true},
            async(_db,c)=>(await c.query<{entity_version:number;snapshot_hash:string}>(
              "SELECT entity_version,snapshot_hash FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND id=$2 AND entity_type='pe_assumption'",
              [ctx.auth.tenantId,historyRef])).rows[0]):null;
          if(!claim||!history||claim.ownerRef.revisionId!==`canonical:pe_assumption:${node.source!.assumptionId}:${history.entity_version}`||
            claim.ownerRef.contentDigest!==history.snapshot_hash||baseValue.provenance.some(p=>p.effectiveAt&&Date.parse(p.effectiveAt)>Date.parse(view.knowledgeAt))||
            baseValue.value===null){
            q.status='UNKNOWN';q.reasons.push('NATIVE_ASSUMPTION_VERSION_DIFFERS_FROM_S1_COMMIT_VISIBLE_OWNER_PREIMAGE');
            const values={...input.values,[q.nodeId]:{...value,value:null,status:'UNKNOWN' as const,truthClass:'UNKNOWN' as const,
              reason:q.reasons.at(-1)}};
            input=copyJson(sealInputSnapshot({...input,values}));
          }
        }
        if(q.status!=='KNOWN')gaps.push(gap(`NATIVE_INPUT_${q.status}`,`${q.nodeId}: ${q.reasons.join('; ')||'Native input unresolved'}`,'P4','UNKNOWN',[`${scenarioId??source.modelVersionId}:${q.nodeId}`]));
      }
    }else{
      const values:Record<string,ResolvedInput>={};
      for(const node of compiled.model.nodes)if(node.kind==='input')values[node.id]=external.values[node.id]??{nodeId:node.id,valueType:node.valueType,
        unit:node.unit,...(node.currency?{currency:node.currency}:{}),shape:node.shape,value:null,status:'UNKNOWN',truthClass:'UNKNOWN',
        provenance:[],reason:'S1_SOURCE_OR_NATIVE_CLOCK_QUALIFICATION_UNAVAILABLE'};
      input=copyJson(sealInputSnapshot({schemaVersion:'underwriting-input-snapshot.v1',investmentCaseId:source.investmentCaseId,worldAt,values}));
      if(scenarioId)gaps.push(gap('SCENARIO_CANNOT_RESOLVE_WITHOUT_AUTHORIZED_BASE','Scenario needs the exact authorized base snapshot','S1'));
    }
    if(compiled.model.circularBlocks.length&&!compiled.model.runtime)gaps.push(gap('UNSUPPORTED_NATIVE_SOLVER_CYCLE','Generic native executor does not certify iterative solver blocks','S3','UNSUPPORTED'));
    if(compiled.model.runtime)gaps.push(gap('SPECIALIZED_RUNTIME_FULL_PRESERVATION','Retained complete LBO evaluator model/input; declared schedule graph is not a complete dependency certificate','S3','UNSUPPORTED'));
    results.push({candidateId:scenarioId??source.modelVersionId,modelRef:nativeRef,scenarioRef,definition:copyJson(compiled.model),
      modelDigest:compiled.semanticHash,input,inputQualifications:copyJson(qualifications)});
  }
  return results;
}
export async function resolveNativeDecision(ctx:PeMutationContext,request:DecisionSliceRequest):Promise<NativeBinding>{
  checkEpisode();
  const work=await resolveDecisionWork(ctx,request.workId),views:BeliefView[]=[],gaps:Gap[]=[];
  const policies:NativeBinding['policies']=[],underwriting:NativeBinding['underwriting']=[],p4:NativeBinding['p4']=[];
  let allocation:NativeBinding['allocation']=null,resourceSnapshot:NativeBinding['resourceSnapshot']=null;
  const requestedCut={...(request.validAt?{validAt:request.validAt}:{}),...(request.knowledgeAt?{knowledgeAt:request.knowledgeAt}:{})};
  const financialSource=request.source.kind==='UNDERWRITING'?request.source:
    request.source.kind==='POLICY'&&request.source.underwriting?{kind:'UNDERWRITING' as const,...request.source.underwriting}:null;
  if(financialSource){
    const source=financialSource,financialRequest={...request,source};
    await authorizeBeliefResources(ctx,[{type:'pe_investment_case',id:source.investmentCaseId}]);
    const dealId=await withTenantTransaction(ctx.auth.tenantId,{userId:principal(ctx),readOnly:true},async(_db,c)=>{
      const row=(await c.query<{deal_id:string}>('SELECT deal_id::text FROM finnor_os.pe_investment_cases WHERE tenant_id=$1 AND id=$2',
        [ctx.auth.tenantId,source.investmentCaseId])).rows[0];if(!row)throw unavailable();return row.deal_id;
    });
    const view=await loadEnterpriseBeliefView(ctx,{root:{entityType:'pe_deal',entityId:dealId},...requestedCut});
    views.push(view);
    if(Object.keys(source.evidenceDerivationInputs??{}).length)
      await authorizeBeliefResources(ctx,[{type:'underwriting_model_version',id:source.modelVersionId}]);
    const external=await resolveP4Inputs(ctx,financialRequest,work,view.knowledgeAt);p4.push(...external.derivations);
    underwriting.push(...await resolveUnderwriting(ctx,financialRequest,view,gaps,external));
    if(request.source.kind==='UNDERWRITING')
      gaps.push(gap('S4_MANDATE_UNAVAILABLE_FOR_NUMERICAL_REQUEST','Native numerical Work has no immutable S4 utility/mandate-choice binding; no business choice is authorized','S4'));
  }
  if(request.source.kind!=='UNDERWRITING'){
    const refs=request.source.kind==='POLICY'?[...request.source.policyRefs,...(request.source.incumbentRef?[request.source.incumbentRef]:[])]:[];
    const allocationRef=request.source.kind==='ALLOCATION'?request.source.allocationRef:request.source.allocationRef;
    if(allocationRef){
      const issued=await readEnterpriseAllocation(ctx,allocationRef);
      if((await validateEnterpriseAllocation(ctx,allocationRef)).status!=='CURRENT')throw new DecisionSliceError('STALE_INPUT','S5 allocation is no longer current');
      allocation={problem:copyJson(issued.problem),certificate:copyJson(issued.certificate),reservationRef:issued.reservation?.ref??null};
      resourceSnapshot=copyJson(await readAllocationSnapshot(ctx));
      refs.push(...issued.problem.policies.map(p=>p.ref));
    }
    const uniqueRefs=[...new Map(refs.map(ref=>[epistemicHash(ref),ref])).values()];
    checkEpisode();
    const resolved=await readEnterpriseControlDecisionContexts(ctx,uniqueRefs);
    checkEpisode();
    for(const {policy,model,kernel} of resolved){
      policies.push({policy:copyJson(policy),model:copyJson(model),kernel:copyJson(kernel)});
      if(!policy.certificate.completeSearch)gaps.push(gap('PARTIAL_CANDIDATE_SEARCH','S4 remaining search/ranking domain gap is retained','S4'));
      gaps.push(gap('S3_UNSAMPLED_IDENTIFICATION_GAP','Finite bootstrap scenarios are not posterior samples or complete field dynamics','S3'));
      for(const pin of policy.bindings.beliefPins){
        if(request.knowledgeAt&&Date.parse(request.knowledgeAt)<Date.parse(policy.knowledgeAt))throw new DecisionSliceError('INVALID_REQUEST','Policy is not available at the requested historical clock');
        if(!views.some(view=>view.root.entityType===pin.root.entityType&&view.root.entityId===pin.root.entityId))
          views.push(await loadEnterpriseBeliefView(ctx,{root:pin.root as PeWorldRootRef,...requestedCut}));
      }
    }
    if(!resourceSnapshot)resourceSnapshot=copyJson(await readAllocationSnapshot(ctx));
  }
  const obligations=await withTenantTransaction(ctx.auth.tenantId,{userId:principal(ctx),readOnly:true},async(_db,c)=>{
    const rows=(await c.query<{id:string;status:string;semantic_hash:string;effect:unknown}>(
      "SELECT id::text,status,semantic_hash,effect FROM finnor_os.business_effects WHERE tenant_id=$1 AND status NOT IN ('verified','cancelled','compensated') ORDER BY id LIMIT 1001",[ctx.auth.tenantId])).rows;
    if(rows.length>1000)throw new DecisionSliceError('LIMIT_EXCEEDED','Outstanding native effect domain exceeds the bounded owner view');
    return rows.map(row=>({id:row.id,status:row.status,digest:epistemicHash(row)}));
  });
  if(obligations.length)gaps.push(gap('S6_OUTSTANDING_EFFECT_LIABILITY_UNKNOWN','Existing durable effects require S6 resource/exposure/liability reconciliation','S5'));
  for(const view of views){
    if(view.coverage.canonicalStatus!=='COMPLETE'||view.coverage.truncated)gaps.push(gap('S1_BOUNDED_OR_HISTORICAL_COVERAGE','Full permitted recorded reconstruction remains unavailable or truncated','S1','INSUFFICIENT_COVERAGE'));
    if(view.coverage.status!=='COMPLETE')gaps.push(gap('S1_PROVIDER_DOCUMENT_STANDING_INCOMPLETE','Provider membership/current operative document standing is not established','P4','PENDING_DEPENDENCY'));
    if(view.contradictions.length)gaps.push(gap('MATERIAL_SOURCE_CONTRADICTIONS','Unresolved S1 contradictions require exact premise-specific reconciliation','P4','CONTRADICTORY'));
  }
  gaps.push(gap('OPERATIVE_DOCUMENT_COMPLETENESS_UNKNOWN','Permissioned full-room amendments/appendices and operative authority/covenant conditions are not certified by spreadsheet dependencies','P4','PENDING_DEPENDENCY'));
  if(request.purpose==='ACQUISITION')gaps.push(gap('CHANGE_OF_CONTROL_TERMINATION_UNKNOWN','Resolve material customer/financing change-of-control termination clauses, including remote appendices and amendments','P4','PENDING_DEPENDENCY'));
  if(request.purpose==='FINANCING'||request.financingChange)gaps.push(gap('COLLATERAL_ACCOUNT_RESTRICTION_UNKNOWN','New financing requires cross-collateralization, restricted accounts, consent and operative covenant evidence','P4','PENDING_DEPENDENCY'));
  const uniqueGaps=[...new Map(gaps.map(g=>[g.id,g])).values()];
  const dependencyVector:Array<{key:string;digest:string}>=[
    {key:`work-input:${work.id}`,digest:work.inputDigest},
    ...views.map(view=>({key:`s1-membership:${view.root.entityType}:${view.root.entityId}`,digest:epistemicHash(stableView(view))})),
    ...underwriting.map(candidate=>({key:`underwriting:${candidate.candidateId}`,digest:epistemicHash({model:candidate.modelRef,scenario:candidate.scenarioRef,
      inputs:candidate.input,qualifications:candidate.inputQualifications})})),
    ...policies.map(p=>({key:`policy:${p.policy.ref.id}`,digest:epistemicHash(p)})),
    ...p4.map(d=>({key:`P4:${d.id}`,digest:p4Ref(d).contentDigest})),
    ...(resourceSnapshot?[{key:'s5-complete-resources-and-outstanding',digest:resourceSnapshot.snapshotDigest}]:[]),
    {key:'s6-native-outstanding-membership',digest:epistemicHash(obligations)},
    {key:'decision-demand-domain',digest:epistemicHash({source:request.source,purpose:request.purpose,financingChange:request.financingChange??false,gaps:uniqueGaps})},
  ].sort((a,b)=>a.key.localeCompare(b.key));
  const validUntil=new Date(Math.min(Date.now()+300000,...policies.map(p=>Date.parse(p.policy.validUntil)),
    ...p4.flatMap(d=>d.sourceHandles.map(h=>Date.parse(h.expiresAt))),
    ...(allocation?[Date.parse(allocation.certificate.validUntil)]:[]))).toISOString();
  const pinnedRequest={...request,...(views[0]?{validAt:views[0].validAt,knowledgeAt:views[0].knowledgeAt}:{})};
  checkEpisode();
  return {schema:'finnor.m1.native-binding.v1',tenantId:ctx.auth.tenantId,principalId:principal(ctx),request:copyJson(pinnedRequest),work,views:copyJson(views),
    underwriting,policies,allocation,resourceSnapshot,obligations,p4,gaps:uniqueGaps,dependencyVector,validUntil,
    qualifications:['S1 integrity and authenticated owner identity are not scientific truth',
      'Numerical/constraint context only; material legal/authority and model gaps remain unresolved',
      'No numeric projection budget, global minimality, calibrated probability, funding or protected admission']};
}
/** Current rights are checked before any stored value can be returned. Historical
 * reconstruction never uses an old grant as access to currently revoked data. */
export async function authorizeNativeBinding(ctx:PeMutationContext,binding:NativeBinding):Promise<void>{
  if(binding.tenantId!==ctx.auth.tenantId||binding.principalId!==principal(ctx))throw unavailable();
  await resolveDecisionWork(ctx,binding.work.id);
  for(const view of binding.views){
    if(process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG)
      await loadEnterpriseBeliefView(ctx,{root:view.root as PeWorldRootRef});
    else await authorizePrivateEquityWorldState(ctx,view.root as PeWorldRootRef);
    await authorizeBeliefSourceScopes(ctx,view.root as PeWorldRootRef,
      view.claims.filter(c=>c.ownerRef.entityType==='evidence_source_version').map(c=>c.ownerRef.id));
  }
}
export async function recheckNativeBinding(ctx:PeMutationContext,binding:NativeBinding):Promise<NativeBinding>{
  checkEpisode();
  await authorizeNativeBinding(ctx,binding);
  if(Date.now()>=Date.parse(binding.validUntil))throw new DecisionSliceError('STALE_INPUT','Decision slice validity has expired');
  for(const view of binding.views){
    const validation=await validateBeliefViewPin(ctx,view.pin);
    // S1 deliberately refuses a sufficiency/current-use certificate for an
    // unchanged but incomplete view. Numerical Work may retain that exact view
    // as qualified evidence, never as a CURRENT S1 certificate or a decision.
    // The owner checks revision/rights/interpretation before this coverage reason.
    const unchangedQualifiedNumericalView=binding.underwriting.length>0
      &&validation.status==='INVALIDATED'&&validation.reason==='PERMITTED_COVERAGE_INCOMPLETE'
      &&binding.gaps.some(g=>g.code==='S1_BOUNDED_OR_HISTORICAL_COVERAGE');
    if(validation.status!=='CURRENT'&&!unchangedQualifiedNumericalView)
      throw new DecisionSliceError('STALE_INPUT','S1 source, membership, permission or interpretation changed');
  }
  try{await recheckP4Derivations(ctx,binding.p4);}
  catch(error){
    if((error as {code?:string}).code==='PE_ENTITY_NOT_FOUND')throw unavailable();
    checkEpisode();throw new DecisionSliceError('STALE_INPUT','P4 source, rights, code, schema or producer currentness changed');
  }
  const current=await resolveNativeDecision(ctx,binding.request);
  if(epistemicHash(current.dependencyVector)!==epistemicHash(binding.dependencyVector))
    throw new DecisionSliceError('STALE_INPUT','Decision owner dependency vector changed');
  return current;
}

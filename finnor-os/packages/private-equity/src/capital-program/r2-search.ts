import {randomUUID} from 'node:crypto';
import type {ExperimentRef} from '@finnor/shared-types';
import type {ExactContingentPolicy,JointSearchCertificate,R2CheckReceipt} from '@finnor/shared-types/src/robust-programme-search';
import {R2_VERSION,R2_PROFILE} from '@finnor/shared-types/src/robust-programme-search';
import {encodeR2Master,encodeR2Tie,decodeR2Policy} from '../../../epistemic-runtime/src/r2-encoding';
import {r2Quantity as q,r2String as s,r2Divide} from '../../../epistemic-runtime/src/r2-rational';
import {persistEnterpriseExactControlPolicy} from '../enterprise-control';
import {checkEnterpriseExactProgrammeResources} from '../enterprise-allocation';
import {m3Event,m3Tx,writeM3Record,type M3QueryRow} from './v2-store';
import {m3Hash,m3Ref,CapitalProgramV2Error,type CapitalProgramV2} from './v2-contracts';
import {m3Remaining} from './v2-budget';
import type {PeMutationContext} from '../types';
import {R2NativeSession,createR2PrivateDirectory,loadR2Runtime,r2Ref} from './r2-native';
import {assertR2Current} from './r2-owners';
import {readR2Artifact} from './r2-native';
import {r2Lp} from '../../../epistemic-runtime/src/r2-encoding';
import {constructExactProgramme} from '../program-synthesis/r2-programme';
import {affectedClosure} from '../live-recompilation/contracts';

const BASE={commit:'517003a4396bc8101a90be4b425ee01de9446740',tree:'07ba69b8e96f05944c2f9f14a74b2c400eb89e42'};
export async function searchRobustCapitalProgram(ctx:PeMutationContext,row:M3QueryRow,attemptId:string,checkpoint:()=>Promise<void>,priorCpuMs=0){
 const binding=row.acceptance,request=row.request,r=request.robust!,owned=binding.r2;
 if(!r||!owned)throw new CapitalProgramV2Error('CHECK_FAILED','Versioned current exact R2 owner input is absent');
 const started=performance.now(),cpu=process.cpuUsage(),rss=process.memoryUsage().rss,runtime=await loadR2Runtime();
 if(m3Hash(runtime.ref)!==m3Hash(owned.runtimeRef))throw new CapitalProgramV2Error('STALE_INPUT','Original R2 native runtime changed');
 const caps=binding.repairBudget?.r2Budget??r.budget,limits=binding.repairBudget?.remaining??request.resource;
 const original=owned.original,originalRef=r2Ref('original-domain',original,'S3'),directory=await createR2PrivateDirectory(ctx.auth.tenantId,ctx.auth.userId,row.id),
  deadlineAt=row.deadline_at!.getTime(),session=new R2NativeSession(runtime,directory,deadlineAt-2500,caps,async()=>{
    await checkpoint();await assertR2Current(ctx,request,binding);
  },async event=>{await m3Event(ctx,row.id,attemptId,'R2_PHYSICAL_CHILD',{...event,directory,originalDeadlineAt:new Date(deadlineAt).toISOString(),costsRetained:true});},checkpoint,priorCpuMs+(owned.admissionCost?.cpuMs??0),owned.admissionCost?.memoryBytes??0);
 const normalization=s(q(original.source.quantities['/mandate/scoring/normalization']!)),requestedThreshold=q(original.source.quantities['/mandate/scoring/maxRegret']!),
  threshold=s(requestedThreshold.compare(q('1/20'))>0?q('1/20'):requestedThreshold),checks:R2CheckReceipt[]=[],proofs:JointSearchCertificate['proofs']=[],iterations:JointSearchCertificate['iterations']=[],
  unresolved:JointSearchCertificate['unresolvedClaims']=[],worlds=[...r.initialWorlds];
 let lower:string|null=null,upper:string|null=null,incumbent:ExactContingentPolicy|null=null,status:JointSearchCertificate['status']='INCOMPLETE',grammarDigest=m3Hash({permitted:original.permitted}),
  constraintDigest=m3Hash({mandate:original.mandate,resources:original.resources,obligations:original.problem.obligations}),family:Awaited<ReturnType<R2NativeSession['build']>>|null=null;
 let infeasibilityProof:JointSearchCertificate['infeasibilityProof']=null;
 const interval=()=>{
  if(lower!==null&&upper!==null&&q(lower).compare(q(upper))>0)throw new CapitalProgramV2Error('CHECK_FAILED','R2 crossed independently accepted lower/upper interval; claim failed');
  const gap=lower!==null&&upper!==null?s(q(upper).sub(q(lower))):null;return {gap,normalized:gap===null?null:s(r2Divide(q(gap),q(normalization)))};
 };
 let tieBreak:NonNullable<JointSearchCertificate['tieBreak']>={status:'UNRESOLVED',basis:'ORIGINAL_VARIANT_THEN_FIXED_INFORMATION_HISTORY_ACTION_ORDER',receipt:null,proofRef:null,artifactRef:null,viprRef:null,reason:'No accepted qualified value/tie stage yet'};
 const retainProof=async(encoding:Parameters<R2NativeSession['solve']>[0],solved:Awaited<ReturnType<R2NativeSession['solve']>>,bound:R2CheckReceipt)=>{
  const artifact={schema:'finnor.r2.original-proof-artifact.v1',encoding,model:r2Lp(encoding),proof:await readR2Artifact(solved.proofPath,caps.maxProofBytes),
   proofSha256:solved.proofSha256,modelSha256:solved.modelSha256,proofRef:solved.proofRef,viprRef:solved.viprRef,checkerReceipt:bound,runtimeRef:runtime.ref},artifactRef=m3Ref('r2-proof-artifact',artifact);
  await writeM3Record(ctx,'graphs',artifactRef,artifact);return artifactRef;
 };
 const retain=async(decoded:ReturnType<typeof decodeR2Policy>,full:R2CheckReceipt,force=false):Promise<ExactContingentPolicy|null>=>{
  if(!full.feasible||full.lower===null||lower!==null&&(q(full.lower).compare(q(lower))<0||q(full.lower).compare(q(lower))===0&&!force))return incumbent;
  lower=full.lower;
  const body:Omit<ExactContingentPolicy,'ref'>={schema:'finnor.s4.exact-contingent-policy.v1',version:R2_VERSION,tenantId:ctx.auth.tenantId,principalId:ctx.auth.userId,
   episodeId:original.mandate.episodeId,knowledgeAt:original.owner.knowledgeAt,validUntil:original.owner.validUntil,mandateRef:original.mandate.ref,originalRef,original,
   ...decoded,value:lower,demandDigest:m3Hash(decoded.worldCourses.map(c=>({worldId:c.worldId,resourceUse:c.resourceUse,terminalLiability:c.terminalLiability}))),
   checkerReceipt:full.ref,certificateRef:r2Ref('search-basis',{originalRef,proofRefs:proofs.map(p=>p.proofRef),checkerRef:full.ref}),sourceIdentity:binding.code.files,
   runtimeRef:runtime.ref,executionAuthorityGranted:false,reservationGranted:false,admission:{status:'BLOCKED_EXTERNAL',receipt:null}};
  const retained={...body,ref:r2Ref('exact-contingent-policy',body,'S4')};await persistEnterpriseExactControlPolicy(ctx,retained,full);return retained;
 };
 try{
  family=await session.build(original);grammarDigest=m3Hash({permitted:original.permitted,variants:family.variants});
  for(let index=0;index<limits.maxAttempts;index++){
   if(m3Remaining()<2500){unresolved.push({claim:'NEXT_MASTER_OR_CHECK',reason:'Original remaining grant reserved for publication; accepted previous bounds retained'});break;}
   await checkpoint();await assertR2Current(ctx,request,binding);
   const encoding=encodeR2Master(original,family,worlds,caps),correspondence=await session.check(original,'encoding',{encoding});checks.push(correspondence);
   await m3Event(ctx,row.id,attemptId,'R2_ENCODING_ACCEPTED',{index,originalRef,encodingDigest:m3Hash(encoding),grammarDigest,
    fullWorldDigest:encoding.worldDigest,restrictedWorlds:[...worlds],checkerRef:correspondence.ref,variables:encoding.variables.length,rows:encoding.rows.length});
   const solved=await session.solve(encoding,index);
   let bound:R2CheckReceipt&{minimizationLower?:string;infeasibleProof?:boolean}|null=null;
   if(solved.viprRef){try{bound=await session.check(original,'proof',{encoding,proofPath:solved.proofPath});}catch(error){
    if(error instanceof CapitalProgramV2Error&&error.code==='STALE_INPUT')throw error;
    unresolved.push({claim:'MASTER_ORIGINAL_PROOF_BINDING',reason:String(error)});
   }}
   if(bound)checks.push(bound);
   else unresolved.push({claim:'MASTER_UPPER_BOUND',reason:solved.proofError??'Complete independent VIPR proof acceptance is absent; feasible primal remains separately checkable'});
   if(bound?.upper!==null&&bound?.upper!==undefined){upper=upper===null||q(bound.upper).compare(q(upper))<0?bound.upper:upper;
    proofs.push({restrictedWorlds:[...worlds],encodingDigest:m3Hash(encoding),modelSha256:solved.modelSha256,proofSha256:solved.proofSha256!,
      proofRef:solved.proofRef!,artifactRef:await retainProof(encoding,solved,bound),minimizationLower:bound.minimizationLower!,maximizationUpper:bound.upper,checkerReceipt:bound,viprReceipt:solved.viprRef!});}
   if(bound?.infeasibleProof){infeasibilityProof={restrictedWorlds:[...worlds],artifactRef:await retainProof(encoding,solved,bound),proofRef:solved.proofRef!,viprRef:solved.viprRef!,checkerReceipt:bound};status='INFEASIBLE';iterations.push({index,restrictedWorlds:[...worlds],candidateRef:null,candidateValue:null,lower,upper,gap:interval().gap,
     addedWorld:null,duplicateWitnesses:[],violations:[],adverseWorld:null,disposition:'CHECKED_INFEASIBLE_COMPLETE_RELAXATION'});break;}
   if(!solved.solution){unresolved.push({claim:'FEASIBLE_INCUMBENT',reason:'Native solve supplied no independently replayable primal'});break;}
   const decoded=decodeR2Policy(encoding,solved.solution),full=await session.check(original,'policy',{policy:decoded});checks.push(full);
   const value=full.worldValues.reduce((a,b)=>q(a.value).compare(q(b.value))<=0?a:b),candidateRef=r2Ref('original-policy-proposal',decoded,'S4');
   incumbent=await retain(decoded,full);
   const violations=full.violations,adverse=violations.find(v=>!worlds.includes(v.worldId))?.worldId??(!worlds.includes(value.worldId)?value.worldId:null),gap=interval(),
    duplicateWitnesses=[...new Set(violations.filter(v=>worlds.includes(v.worldId)).map(v=>v.worldId))];
   iterations.push({index,restrictedWorlds:[...worlds],candidateRef,candidateValue:full.feasible?full.lower:null,lower,upper,gap:gap.gap,
     addedWorld:adverse,duplicateWitnesses,violations,adverseWorld:value.worldId,disposition:full.feasible?'FULL_WORLD_FEASIBLE':'FULL_WORLD_CONSTRAINT_VIOLATION'});
   await m3Event(ctx,row.id,attemptId,'R2_FULL_WORLD_CHECKED',{index,checkerRef:full.ref,coverage:full.coverage,worldValues:full.worldValues,feasible:full.feasible,
    violations,lower,upper,gap:gap.gap,normalizedGap:gap.normalized,adverseWorld:value.worldId,addedWorld:adverse});
   await m3Tx(ctx,c=>c.query('UPDATE finnor_os.m3_queries SET attempted=attempted+1,generated=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',
    [ctx.auth.tenantId,ctx.auth.userId,row.id,family!.variants.length]));
   if(incumbent&&gap.normalized!==null&&q(gap.normalized).compare(q(threshold))<=0){status='COMPLETE';break;}
   if(adverse){worlds.push(adverse);continue;}
   unresolved.push({claim:'STOP_GATE',reason:'No new adverse world and the accepted interval does not pass the frozen threshold'});break;
  }
  if(status==='COMPLETE'&&lower!==null&&family){
   const encoding=encodeR2Tie(encodeR2Master(original,family,original.source.worlds.map(w=>w.id),caps),lower);
   checks.push(await session.check(original,'encoding',{encoding}));
   const solved=await session.solve(encoding,100000+iterations.length);
   if(!solved.viprRef||!solved.proofRef||!solved.solution)throw new CapitalProgramV2Error('CHECK_FAILED','Exact original owner tie proof is unaccepted: '+solved.proofError);
   const bound=await session.check(original,'proof',{encoding,proofPath:solved.proofPath});checks.push(bound);
   const cost=encoding.objective.terms.reduce((a,[id,c])=>a.add(q(c).mul(q(solved.solution![id]??'0'))),q('0'));
   if(bound.minimizationLower===undefined||q(bound.minimizationLower).compare(cost)!==0)
    throw new CapitalProgramV2Error('CHECK_FAILED','Original owner tie objective is not exactly proved optimal');
   const decoded=decodeR2Policy(encoding,solved.solution),full=await session.check(original,'policy',{policy:decoded});checks.push(full);
   if(!full.feasible||full.lower===null||q(full.lower).compare(q(lower))<0)throw new CapitalProgramV2Error('CHECK_FAILED','Tie stage lost original feasible value');
   incumbent=await retain(decoded,full,true);interval();
   tieBreak={status:'CHECKED',basis:'ORIGINAL_VARIANT_THEN_FIXED_INFORMATION_HISTORY_ACTION_ORDER',receipt:bound,proofRef:solved.proofRef,artifactRef:await retainProof(encoding,solved,bound),viprRef:solved.viprRef,reason:null};
   await m3Event(ctx,row.id,attemptId,'R2_ORIGINAL_TIE_CHECKED',{tieBreak,policyRef:incumbent?.ref??null,primaryLower:lower,primaryUpper:upper});
  }
 }catch(error){
  if(error instanceof CapitalProgramV2Error&&error.code==='STALE_INPUT')throw error;
  const reason=error instanceof Error?error.message:'R2 original predicate failed';
  unresolved.push({claim:'EXACT_SEARCH_COMPLETENESS',reason});
  status=/UNSUPPORTED|CONSTRUCTOR|ORIGINAL_TERM|GRAMMAR_PRODUCTION/.test(reason)?'UNSUPPORTED':'INCOMPLETE';
  await m3Event(ctx,row.id,attemptId,'R2_REJECTED_CLAIM',{reason,lower,upper,incumbentRef:incumbent?.ref??null,nativeReceipts:session.receipts.map(r=>r.ref),costsRetained:true});
 }finally{await session.cancel();}
 let s5:JointSearchCertificate['consumer']['s5']=null;
 if(incumbent&&m3Remaining()>800){try{const consumed=await checkEnterpriseExactProgrammeResources(ctx,incumbent,session);
  checks.push(consumed.check);s5={ref:consumed.ref,feasible:true,current:true,reservationCreated:false};
 }catch(error){if(error instanceof CapitalProgramV2Error&&error.code==='STALE_INPUT')throw error;
  unresolved.push({claim:'CURRENT_S5_CONSUMPTION',reason:String(error)});status='INCOMPLETE';
 }
 }else if(incumbent){unresolved.push({claim:'CURRENT_S5_CONSUMPTION',reason:'Original remaining grant insufficient for complete S5 owner consumption'});status='INCOMPLETE';}
 let programmeModule:CapitalProgramV2['programModule']=null,ownerBoundGraph:CapitalProgramV2['ownerBoundGraph']=null,moduleExecution:CapitalProgramV2['candidates'][number]['moduleExecution']=null;
 if(incumbent&&s5){try{
  const module=await constructExactProgramme(incumbent,session,limits);programmeModule=m3Ref('p1-exact-module',module);await writeM3Record(ctx,'modules',programmeModule,module);
  moduleExecution={termination:'EXITED',exitCode:0,provenance:{...module.execution,checkedHistoryCount:module.checkedHistoryCount,inputDigest:module.inputDigest,outputDigest:module.outputDigest}};
  const graph={schema:'finnor.p1.r2-owner-graph.v1',work:binding.work,plan:binding.plan,deadlineAt:new Date(deadlineAt).toISOString(),
   nodes:[{id:'original-domain',dependsOn:[],owner:'S1/S3',operation:'READ_ORIGINAL_CURRENT_EXACT_DOMAIN',ref:originalRef},
    {id:'bound-and-worlds',dependsOn:['original-domain'],owner:'R2',operation:'CHECK_FULL_FAMILY_BOUND_AND_COMPLETE_WORLDS',proofs:proofs.map(p=>p.artifactRef),checks:checks.map(c=>c.ref)},
    {id:'original-policy',dependsOn:['bound-and-worlds'],owner:'S4',operation:'CHOOSE_ORIGINAL_RECEIVED_HISTORY',ref:incumbent.ref},
    {id:'canonical-demand',dependsOn:['original-domain','original-policy'],owner:'S5',operation:'CHECK_CURRENT_CANONICAL_DEMAND',ref:s5.ref},
    {id:'executable-module',dependsOn:['original-policy','canonical-demand'],owner:'P1',operation:'EXECUTE_EXACT_PURE_POLICY_MODULE',ref:programmeModule}],
   dependencyClosure:{schema:'finnor.p7.r2-dependency-closure.v1',owner:'M3_EXISTING_REVISION_FENCES',sourceRef:original.sourceRef,
    originalPolicyRef:original.incumbentPolicyRef,originalGrammarDigest:grammarDigest,fullWorldDigest:m3Hash(original.source.worlds),originalConstraintDigest:constraintDigest,
    methodDigest:binding.code.digest,runtimeRef:runtime.ref,dependencies:binding.dependencies,
    affectedRegions:['R2_ORIGINAL_GRAMMAR','R2_COMPLETE_WORLDS','R2_ENCODING','R2_PRIMARY_AND_TIE_PROOFS','S4_ORIGINAL_POLICY','S5_CURRENT_DEMAND','P1_EXECUTABLE_MODULE'],
    continuation:'EXPLICIT_LINKED_M3_REVISION_ONLY_NO_NEW_EFFECT_OR_EPISODE_AUTHORITY'},
   executionAuthorityGranted:false,reservationCreated:false,effectProposals:[],admission:{status:'BLOCKED_EXTERNAL',receipt:null}};
  const closure=affectedClosure(graph.nodes,['original-domain']);
  const graphWithClosure={...graph,closureBasis:{version:'p7-native-analytical-continuation-v1',affectedRegions:closure.affectedNodes.map(n=>n.id),keptRegions:closure.keptNodes.map(n=>n.id)}};
  ownerBoundGraph=m3Ref('p1-exact-owner-graph',graphWithClosure);await writeM3Record(ctx,'graphs',ownerBoundGraph,graphWithClosure);
 }catch(error){if(error instanceof CapitalProgramV2Error&&error.code==='STALE_INPUT')throw error;status='INCOMPLETE';unresolved.push({claim:'P1_EXECUTABLE_ORIGINAL_PROGRAMME',reason:String(error)});}}
 const gaps=interval(),body:Omit<JointSearchCertificate,'ref'>={schema:'finnor.joint-search-certificate.v1',semanticOwner:'R2',version:R2_VERSION,status,
  checkingBasis:infeasibilityProof||lower!==null&&upper!==null?'MODEL_RELATIVE_EXACT':lower!==null?'MODEL_RELATIVE_BOUNDED':'UNKNOWN',
  envelope:{tenantId:ctx.auth.tenantId,principalId:ctx.auth.userId,work:{id:original.owner.workId,revision:original.owner.inputId,contentDigest:original.owner.inputDigest},
    baseline:BASE,producer:{sourceDigest:binding.code.digest,lockDigest:m3Hash(binding.code.files.filter(f=>f.path.endsWith('package-lock.json'))),runtimeRef:runtime.ref,admission:{status:'BLOCKED_EXTERNAL',receipt:null}},
    ownerInputs:original.owner,sourceRef:original.sourceRef,domainProfile:R2_PROFILE,
    assumptions:['Complete declared fixed worlds and original pure grammar; no probabilities','Supplied exact S3 finite hypotheses, not exactification of learned Float64 outputs',
      'Original unchanged mandate/accounting/constraints; omitted mechanisms, identification and field truth remain unknown'],
    grammarDigest,modelDigest:m3Hash(original.source),constraintDigest,worldDigest:m3Hash(original.source.worlds),originalDigest:m3Hash(original),
    deadlineAt:new Date(deadlineAt).toISOString(),budget:caps,invalidationDependencies:binding.dependencies},
  incumbent,lower,upper,gap:gaps.gap,normalizedGap:gaps.normalized,normalization:{range:normalization,threshold,basis:'ORIGINAL_OWNER_SCORING_FROZEN_BEFORE_SEARCH'},
  exactOptimalityClaimed:status==='COMPLETE'&&gaps.gap==='0'&&tieBreak.status==='CHECKED',tieBreak,proofs,infeasibilityProof,iterations,checks,unresolvedClaims:unresolved,
  consumer:{s4PolicyRef:incumbent?.ref??null,s5,m1DecisionCoverage:'NOT_GRANTED',executionAuthorityGranted:false},
  fallback:{status:status==='COMPLETE'?'NOT_NEEDED':'NO_COMPATIBLE_ADMITTED_FALLBACK',callee:null,
    reason:status==='COMPLETE'?null:'Current S4/M3 methods are ordinary and unadmitted; no compatible admitted exact-domain fallback exists'},
  lifecycle:[{state:'PROPOSED',at:original.owner.knowledgeAt,reason:'Owner resolved original exact source and finite domain'},
    {state:status==='COMPLETE'?'DEVELOPMENT_VERIFIED':'PROPOSED',at:new Date().toISOString(),reason:`${status}; no S8 admission or activation`}],
  costs:{wallMs:performance.now()-started,cpuMs:session.chargedCpuMs,peakMemoryBytes:session.aggregatePeakMemoryBytes,
    nativeCalls:session.receipts.length,phases:session.receipts.map(r=>({phase:r.phase,wallMs:r.wallMs,cpuMs:r.cpuMs,peakMemoryBytes:r.peakMemoryBytes,status:r.termination})),
    money:null,moneyStatus:'UNMETERED',failedAndCancelledRetained:true,buildCostRef:r2Ref('native-build',runtime.manifest.build)},
  gaps:{unsampledModel:'UNKNOWN',identification:'UNKNOWN',fieldRegret:'UNKNOWN',economicValue:'UNKNOWN'}};
 const certificate:JointSearchCertificate={...body,ref:r2Ref('joint-search-certificate',body)},selectedDigest=incumbent?m3Hash(incumbent.variant):null,
  blockers=[{code:'S8_ADMISSION_UNAVAILABLE',owner:'S8',requirement:'Independent protected admission and activation remain distinct'},
    {code:'M1_DECISION_COVERAGE_REQUIRED',owner:'M1',requirement:'Exact planning/branch/resource checks grant no legal decision coverage'}],usage=process.cpuUsage(cpu);
 const programBody:Omit<CapitalProgramV2,'ref'>={schema:'finnor.capital-program.v2',producerVersion:'m3-owner-economic-v2',originalCapability:'CapitalProgramSearch',deliveryAlias:'EconomicProgramSynthesis',
  state:'PROPOSED_BLOCKED',executionAuthorityGranted:false,envelope:{tenantId:ctx.auth.tenantId,principalId:ctx.auth.userId,sharingScope:'PRIVATE_PRINCIPAL',
    work:binding.work,plan:binding.plan,parents:[binding.policy.ref,original.sourceRef],requestRef:m3Ref('capital-program-request',request),inputDigest:m3Hash(binding),
    knowledgeAt:original.owner.knowledgeAt,validAt:original.mandate.horizon.startAt,validUntil:binding.validUntil,ownerVector:binding.ownerVector,
    recompilation:binding.recompilation??null,sourceDigests:binding.code.files,schemaDigest:binding.schemaDigest,runtime:{node:process.version,platform:process.platform,architecture:process.arch,imageAttestation:null},
    grant:{limits,qualification:'ORIGINAL_EPISODE_SHARED_SERIAL_NATIVE_CHILD_GRANT_EXACT_S5_PLANNING_NO_FUNDING',financialFundingRef:null,aggregatePhysicalLimits:'SHARED_R2_SERIAL_CHILD_GRANT',deadlineAt:new Date(deadlineAt).toISOString()},
    invocationRefs:session.receipts.map(r=>r.ref.id),admission:{status:'BLOCKED_EXTERNAL',receipt:null}},mandate:original.mandate.ref,programModule:programmeModule,ownerBoundGraph,valueUnit:original.mandate.utility.unit,
  evidenceSlice:null,mechanisms:[original.source.modelRef,originalRef],inquiries:original.protocols.map(p=>p.ref),allocationRequest:null,effectProposals:[],challengeEvidence:[],
  candidates:incumbent?[{semanticDigest:selectedDigest!,parentDigest:m3Hash(original.problem),operator:'FULL_ORIGINAL_POLICY_FAMILY_RATIONAL_MILP',structure:incumbent.variant.structure,
    terms:incumbent.variant.term===null?[]:[{exposureId:request.permitted.exposureId,unit:request.permitted.unit,before:original.source.quantities[`/problem/actions/${original.problem.actions.findIndex(a=>a.id===request.permitted.actionId)}/exposures/${request.permitted.exposureId}/0`]!,after:incumbent.variant.term,period:incumbent.variant.start!}],
    agreement:{status:'PROPOSED',targetDigest:m3Hash(original),requiredStanding:request.permitted.agreement,liveAgreementRef:null},disposition:'CHECKED_MODEL_RELATIVE',reason:null,
    policyRef:incumbent.ref,demandDigest:incumbent.demandDigest,moduleRef:programmeModule,moduleExecution,refinementSteps:incumbent.decisions.length,valueBasis:'S4_ROBUST_FIXED_JOINT_WORLDS_NO_PROBABILITIES',
    valueBounds:null,changedResponseRecomputed:true,finitePolicyComplete:status==='COMPLETE',nativeFinance:null,blockers:[]}]:[],
  allocation:{problem:null,checks:[],qualification:s5?'S5_EXACT_ORIGINAL_DEMAND_CURRENT_CANONICAL_RESOURCES_NO_RESERVATION':'CURRENT_S5_CHECK_UNAVAILABLE',reservationCreated:false},
  incumbentAndSearchGap:{incumbentDigest:m3Hash(original.incumbentPolicyRef),selectedDigest,valueBounds:null,generatedDescriptors:family?.variants.length??0,attemptedDescriptors:iterations.length,
    remainingDescriptors:status==='COMPLETE'?0:Math.max(1,(family?.variants.length??1)-iterations.length),finiteDomainComplete:status==='COMPLETE',upperBound:upper,globalOptimalityClaimed:certificate.exactOptimalityClaimed,
    modeledImprovement:null,unsampledModelGap:'UNKNOWN',identificationGap:'UNKNOWN',selectionQualification:'EXACT_SUPPLIED_MODEL_ORIGINAL_POLICY_NO_BUSINESS_AUTHORITY'},
  blockers,pendingRequests:[],unresolvedBindings:[],costs:{money:null,status:'UNMETERED',wallMs:performance.now()-started,cpuUserMicros:usage.user,cpuSystemMicros:usage.system,rssBeforeBytes:rss,rssAfterBytes:process.memoryUsage().rss,
    outputBytes:0,generated:family?.variants.length??0,attempted:iterations.length,refinementSteps:0,expansions:family?.courses.length??0,externalModelCalls:0,
    upstreamComputeRefs:[binding.model.compute.id,binding.kernel.compute.id,binding.policy.compute.id],upstreamChargesDuplicated:false,unknownAttemptIds:[],failedAttemptCostsRetained:true},
  limitations:['Exact supplied finite model and original pure grammar; no causal truth, omitted-world, field-regret or economic gain qualification',
    'No protected admission, business selection, reservation, funding or effect authority','Actual dollar meters are unavailable; economic cost gates remain unqualified'],jointSearchCertificate:certificate};
 programBody.costs.outputBytes=Buffer.byteLength(JSON.stringify(programBody));
 if(programBody.costs.outputBytes>limits.maxResultBytes)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Original exact result byte grant exhausted');
 await writeM3Record(ctx,'graphs',m3Ref('r2-certificate',certificate),certificate);
 return {program:{...programBody,ref:m3Ref('capital-program',programBody)},evidence:null};
}

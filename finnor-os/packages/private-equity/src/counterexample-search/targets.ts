import type { CurrentSlice } from '../decision-slice/service';
import { hash,ref,gap,type DiagnosticRequest,type CandidateClaim,type FaultTarget,type CoverageGap,
  type WitnessClass,type Evaluation,type FaultGraph } from './contracts';

const classFor=(e:Evaluation):WitnessClass=>e.kind==='SOURCE_LITERAL'||e.kind==='P4_TERM'?'GROUNDING_INTERPRETATION':
  e.kind==='POLICY_BOUND'?'POLICY_WORLD':e.kind==='EFFECT_FIXTURE'?'EFFECT_INTERFACE':'NUMERICAL_CONTRACT';
const checkerFor=(e:Evaluation)=>e.kind==='SOURCE_LITERAL'?'S1_CURRENT_ORIGINAL_RECORD_V1':
  e.kind==='P4_TERM'?'P4_SEPARATE_POSTGRES_NUMERIC_V1':e.kind==='POLICY_BOUND'?'M4_ORIGINAL_KERNEL_REFERENCE_V1':
  e.kind==='EFFECT_FIXTURE'?'M4_INDEPENDENT_LOOPBACK_GET_V1':e.kind.startsWith('ALLOCATION')?'M4_FRACTION_ORIGINAL_S5_V1':'M4_FRACTION_ORIGINAL_IR_V1';
const supported=(e:Evaluation):boolean=>e.kind==='SOURCE_LITERAL'||e.kind==='P4_TERM'?e.claimKind==='EXACT_SOURCE':
  e.kind==='EFFECT_FIXTURE'?e.claimKind==='EXACT_EFFECT':
  e.kind==='POLICY_BOUND'?e.claimKind==='MODEL_WORST_CASE':e.claimKind==='UNIVERSAL_DETERMINISTIC';
export function buildTargets(current:Pick<CurrentSlice,'slice'|'binding'>,request:DiagnosticRequest,graph:FaultGraph,
  capital?:import('../capital-program/challenge-reader').CapitalChallengeContext){
  const domainRef=ref('challenge-domain',{domain:request.domain,limits:request.limits,
    ownerDomain:current.binding.dependencyVector,checkerVersion:'ORIGINAL_INPUT_SEPARATE_FORMULATIONS_V1',
    modelFamily:'RETAINED_S3_JOINT_WORLDS_NO_PROBABILITIES',selectedUniverse:'RECORDED_OWNER_BYTES_NOT_GLOBAL_ABSENCE',
    ...(capital?{candidate:capital.program.ref,claims:capital.claims.map(c=>c.ref),
      modules:capital.modules.map(m=>({ref:m.ref,inputDigest:m.body.inputDigest,outputDigest:m.body.outputDigest,sha256:m.sha256}))}:{})});
  const claims:CandidateClaim[]=[],targets:FaultTarget[]=[],gaps:CoverageGap[]=[];
  for(const evaluation of request.evaluations){
    const candidateId='candidateId'in evaluation?evaluation.candidateId:null;
    const roots=graph.nodes.filter(n=>
      candidateId!==null?n.candidateId===candidateId&&n.nativeId===('nodeId'in evaluation?evaluation.nodeId:''):
      evaluation.kind==='POLICY_BOUND'?n.ownerRef.id===evaluation.policyId:
      evaluation.kind.startsWith('ALLOCATION')?n.id.includes('allocation:'):
      evaluation.kind==='SOURCE_LITERAL'?n.ownerRef.id===evaluation.entityId:
      evaluation.kind==='P4_TERM'?n.id===`p4:${evaluation.derivationId}:node:${evaluation.output}`:
      evaluation.kind==='EFFECT_FIXTURE'?n.id===`fixture-request:${hash(evaluation.request)}`:false).map(n=>n.id);
    const included=new Set(roots),pending=[...roots];
    while(pending.length){const id=pending.pop()!;
      for(const edge of graph.edges.filter(e=>e.from===id))if(!included.has(edge.to)){included.add(edge.to);pending.push(edge.to);}
    }
    const native=candidateId?current.binding.underwriting.find(c=>c.candidateId===candidateId):null;
    const source=evaluation.kind==='SOURCE_LITERAL'?current.binding.views.flatMap(v=>v.claims).find(
      c=>c.ownerRef.entityType===evaluation.entityType&&c.ownerRef.id===evaluation.entityId):null;
    const ownerPredicateRef=native?.modelRef??(evaluation.kind==='P4_TERM'?graph.nodes.find(n=>n.id===roots[0])?.ownerRef:null)??(source?{owner:source.ownerRef.owner,id:source.ownerRef.id,
      version:source.ownerRef.revisionId,contentDigest:source.ownerRef.contentDigest}:
      current.binding.allocation?.problem.ref??current.binding.policies.find(p=>evaluation.kind==='POLICY_BOUND'&&p.policy.ref.id===evaluation.policyId)?.policy.ref??current.binding.work.ref);
    const owned=capital?.claims.find(claim=>hash(claim.evaluation)===hash(evaluation));
    const body={evaluation,kind:evaluation.claimKind,predicateDigest:hash(evaluation),ownerPredicateRef:owned?.ref??ownerPredicateRef,
      regionIds:[...included].sort(),dependencyRefs:owned?[owned.ref,...owned.basis]:[ownerPredicateRef],quantifiedDomainRef:domainRef,
      semantics:{entity:source?.ownerRef.id??native?.input.investmentCaseId??null,unit:'unit'in evaluation?evaluation.unit:null,
        currency:'currency'in evaluation?evaluation.currency??null:null,
        time:native?.definition.periodDefinition??null,informationCut:current.slice.envelope.knowledgeAt},
      qualification:owned?'FROZEN_EXACT_PUBLISHED_M3_CLAIM_WITH_OWNER_PREIMAGES':'FROZEN_OWNER_ASSERTED_DIAGNOSTIC_PREDICATE_NOT_M3_CLAIM'};
    const claim={ref:ref('candidate-claim',body),...body};claims.push(claim);
    if(!supported(evaluation)){gaps.push(gap('CLAIM_PROTOCOL_UNSUPPORTED',
      `${evaluation.claimKind} requires its registered owning measurement/identification/agreement protocol; an adverse input is insufficient`,
      claim.ref,true,evaluation.claimKind==='AGREEMENT'?'S1':evaluation.claimKind==='CAUSAL'?'S3':'S2/S3/S4'));continue;}
    if(evaluation.kind==='SOURCE_LITERAL'&&evaluation.interpretation==='LEGAL_MEANING'){
      gaps.push(gap('LEGAL_INTERPRETATION_UNSUPPORTED','Literal equality cannot determine operative legal effect',claim.ref,true,'S1'));continue;
    }
    const targetBody={claimRef:claim.ref,class:classFor(evaluation),regionIds:claim.regionIds,
      operators:['BASELINE','SINGLE_PARAMETER','PERMITTED_PAIR','PERMITTED_TRIPLE','REMOVE_IRRELEVANT_COMPONENT'],
      checker:checkerFor(evaluation),reason:'Original predicate, discrete/joint thresholds and dependency closure are retained',
      requiredContextDigest:hash(current.binding.dependencyVector)};
    targets.push({ref:ref('fault-target',targetBody),...targetBody});
  }
  if(targets.length>request.limits.maxTargets)gaps.push(gap('TARGET_BUDGET_EXHAUSTED',
    'Material targets outside the frozen parent target bound remain untested',null,false,'M4'));
  return {domainRef,claims,targets:targets.slice(0,request.limits.maxTargets),gaps};
}

import type { ExperimentRef } from '@finnor/shared-types';
import type { CurrentSlice } from '../decision-slice/service';
import type { DecisionNode,DecisionEdge } from '../decision-slice/contracts';
import { hash,ref,ChallengeError,type DiagnosticRequest,type FrozenDiagnostic,type FaultGraph } from './contracts';

/** Owner-resolved diagnostic additions have their own identity. The genuine M1
 * graph and its independently checked projection are never edited or relabeled. */
export function buildFaultGraph(current:Pick<CurrentSlice,'slice'|'binding'|'projectionInput'>,request:DiagnosticRequest,p4:FrozenDiagnostic['p4']):FaultGraph{
  const nodes:DecisionNode[]=[...current.projectionInput.graph.nodes],edges:DecisionEdge[]=[...current.projectionInput.graph.edges];
  const add=(node:DecisionNode)=>{if(!nodes.some(n=>n.id===node.id))nodes.push(node);};
  const link=(from:string,to:string,kind:DecisionEdge['kind'],value:unknown)=>{
    if(!edges.some(e=>e.from===from&&e.to===to&&e.kind===kind))edges.push({from,to,kind,expressionDigest:hash(value),lagPeriods:null});
  };
  const work=`work:${current.binding.work.inputId}`;
  // M1's policy-only graph retains native effect liability but does not
  // enumerate S5's complete outstanding registry. Preserve it in the separate
  // diagnostic graph, without pretending this context grants new funding.
  for(const resource of current.binding.resourceSnapshot?.resources??[]){
    const id=`m4-resource:${resource.ref.contentDigest}`;
    add({id,nativeId:resource.resourceId,kind:'RESOURCE',candidateId:null,ownerRef:resource.ref,
      unit:resource.unit,currency:resource.currency,periods:[resource.horizon],definitionDigest:hash(resource),
      qualification:'COMPLETE_CURRENT_S5_REGISTRY_CONTEXT_NOT_NEW_FUNDING',status:resource.revoked?'REVOKED':'RETAINED'});
  }
  for(const outstanding of current.binding.resourceSnapshot?.outstanding??[]){
    const id=`m4-outstanding:${hash(outstanding)}`;
    add({id,nativeId:outstanding.reservationRef.id,kind:'OUTSTANDING_COMMITMENT',candidateId:null,
      ownerRef:outstanding.certificateRef,unit:null,currency:null,periods:[],
      definitionDigest:hash(outstanding),qualification:'CROSS_MANDATE_RESERVATION_UNKNOWN_OUTCOME_AND_RECOVERY',
      status:outstanding.status});
    link(id,work,'OWNER_CURRENTNESS',current.binding.work.ref);
    for(const envelope of outstanding.envelopes){
      const resource=current.binding.resourceSnapshot?.resources.find(r=>r.resourceId===envelope.resourceId);
      if(resource)link(id,`m4-resource:${resource.ref.contentDigest}`,'CONTRACTUAL',envelope);
    }
    for(const effect of outstanding.effectRefs)
      if(nodes.some(n=>n.id===`effect:${effect.id}`))link(id,`effect:${effect.id}`,'OWNER_CURRENTNESS',effect);
    for(const node of nodes.filter(n=>n.kind==='OWNER_OBJECT'&&
      current.binding.policies.some(p=>p.policy.ref.id===n.ownerRef.id)))
      link(node.id,id,'OWNER_CURRENTNESS',{snapshotDigest:current.binding.resourceSnapshot!.snapshotDigest,
        qualification:'CURRENT_SHARED_RESPONSIBILITY_NOT_A_NEW_ALLOCATION'});
  }
  for(const evaluation of request.evaluations){
    if(evaluation.kind==='SOURCE_LITERAL'){
      const claim=current.binding.views.flatMap(v=>v.claims).find(c=>c.ownerRef.entityType===evaluation.entityType&&c.ownerRef.id===evaluation.entityId);
      if(!claim)continue;
      const id=`source:${hash(claim.ownerRef)}:${evaluation.field}`,ownerRef:ExperimentRef={owner:claim.ownerRef.owner,
        id:claim.ownerRef.id,version:claim.ownerRef.revisionId,contentDigest:claim.ownerRef.contentDigest};
      add({id,nativeId:evaluation.field,kind:'OWNER_OBJECT',candidateId:null,ownerRef,unit:null,currency:null,
        periods:[{validFrom:claim.validFrom,validTo:claim.validTo,knowledgeAt:claim.knowledgeAt}],definitionDigest:hash(claim),
        qualification:'CURRENT_S1_ORIGINAL_RECORD_LOCATOR_NOT_LEGAL_EFFECT',status:claim.kind});
      link(id,work,'OWNER_CURRENTNESS',current.binding.work.ref);
      for(const candidate of current.binding.underwriting)for(const n of candidate.definition.nodes)
        if(n.kind==='input'&&n.source?.kind==='p1_assumption'&&n.source.assumptionId===claim.ownerRef.id)
          link(`${candidate.candidateId}:${n.id}`,id,'OWNER_CURRENTNESS',n.source);
    }
    if(evaluation.kind==='EFFECT_FIXTURE'){
      const id=`fixture-request:${hash(evaluation.request)}`;
      add({id,nativeId:evaluation.request.field,kind:'CONTRACTUAL',candidateId:null,
        ownerRef:ref('isolated-fixture-request',evaluation.request),unit:evaluation.request.unit,currency:evaluation.request.currency,
        periods:[],definitionDigest:hash(evaluation.request),qualification:'M4_ISOLATED_FIXTURE_ONLY_NO_S6_PROVIDER_OR_AUTHORITY',status:'SUPPLIED'});
      link(id,work,'OWNER_CURRENTNESS',current.binding.work.ref);
    }
  }
  for(const {evaluationIndex,body:d}of p4){
    const evaluation=request.evaluations[evaluationIndex];if(evaluation?.kind!=='P4_TERM')continue;
    const output=d.result?.outputs[evaluation.output];if(!output)continue;
    const ownerRef:ExperimentRef={owner:'P4',id:d.id,version:d.code.version,contentDigest:hash(d)},prefix=`p4:${d.id}:`;
    const required=new Set<string>(),pending=[evaluation.output];
    while(pending.length){const id=pending.pop()!;if(required.has(id))continue;required.add(id);
      const node=d.queryProgram.nodes.find(n=>n.id===id);if(!node)continue;
      if('input'in node)pending.push(node.input);if('left'in node)pending.push(node.left,node.right);
    }
    for(const node of d.queryProgram.nodes.filter(n=>required.has(n.id))){
      const id=prefix+'node:'+node.id;
      add({id,nativeId:node.id,kind:'OWNER_OBJECT',candidateId:null,ownerRef,unit:output.semantics?.unit??null,
        currency:output.semantics?.currencyCode??null,periods:output.semantics?[{start:output.semantics.periodStart,end:output.semantics.periodEnd}]:[],
        definitionDigest:hash(node),qualification:'AUTHENTIC_CURRENT_P4_PROGRAM_NOT_AN_INSTALLED_M1_P4_CONSUMER',status:d.status});
      if('input'in node)link(id,prefix+'node:'+node.input,'COMPUTATIONAL',node);
      if('left'in node){link(id,prefix+'node:'+node.left,'COMPUTATIONAL',node);link(id,prefix+'node:'+node.right,'COMPUTATIONAL',node);}
      link(id,work,'OWNER_CURRENTNESS',d.work);
      for(const witness of d.witnesses.filter(w=>output.witnessIds.includes(w.id)&&w.modulePath.includes('P4:node:'+node.id))){
        const sourceId=prefix+'source:'+witness.id;
        add({id:sourceId,nativeId:witness.field,kind:'CONTRACTUAL',candidateId:null,
          ownerRef:{owner:witness.owner,id:witness.recordId,version:witness.version,contentDigest:witness.contentDigest},
          unit:witness.semantics.unit,currency:witness.semantics.currencyCode,
          periods:[{start:witness.semantics.periodStart,end:witness.semantics.periodEnd}],
          definitionDigest:hash(witness),qualification:'P4_ORIGINAL_OWNER_RECORD_AND_LOCATOR_SELECTED_UNIVERSE_ONLY',status:'RETAINED'});
        link(id,sourceId,'CONTRACTUAL',{witnessId:witness.id,modulePath:witness.modulePath,anchor:witness.anchor});
      }
    }
  }
  if(nodes.length>4096||edges.length>8192)throw new ChallengeError('LIMIT_EXCEEDED','M4 original fault dependency closure exceeds its registered envelope');
  const known=new Set(nodes.map(n=>n.id));
  if(edges.some(e=>!known.has(e.from)||!known.has(e.to)))throw new ChallengeError('CHECK_FAILED','Original diagnostic fault dependency is unresolved');
  const body={schema:'finnor.m4.fault-dependency-graph.v1' as const,sourceSliceRef:current.slice.ref,
    sourceGraphRef:current.projectionInput.graph.ref,nodes,edges,qualification:'M4_DIAGNOSTIC_CLOSURE_NOT_A_MODIFIED_M1_GRAPH' as const};
  return {ref:ref('fault-dependency-graph',body),...body};
}

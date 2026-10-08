import { epistemicHash } from '../../../epistemic-runtime/src/source-precedence';
import { m1Ref, DecisionSliceError, type NativeBinding, type DecisionGraph, type EvidenceDemand } from './contracts';

/** M1 demands only. Source handles/execution/derivations belong to P4. */
export function compileEvidenceDemands(binding:NativeBinding,graph:DecisionGraph,deadlineAt:string):EvidenceDemand[]{
  const demands:EvidenceDemand[]=[];
  const base={schema:'finnor.decision-evidence-demand.v1' as const,tenantId:binding.tenantId,principalId:binding.principalId,
    work:binding.work,pins:binding.views.map(v=>v.pin),deadlineAt,resource:binding.request.resource};
  for(const candidate of binding.underwriting)for(const q of candidate.inputQualifications){
    const node=candidate.definition.nodes.find(n=>n.id===q.nodeId)!;
    const selected=binding.request.source.kind==='UNDERWRITING'?binding.request.source.evidenceDerivationInputs?.[q.nodeId]:undefined;
    const p4=selected&&binding.p4.find(d=>d.id===selected.derivationId),financial=p4?.result?.outputs[selected!.output]?.semantics;
    const body={...base,candidateId:candidate.candidateId,variableIds:[`${candidate.candidateId}:${q.nodeId}`],
      affectedRoots:graph.roots.filter(r=>r.id.startsWith(candidate.candidateId+':')).map(r=>r.id),
      requiredProducer:p4?'P4' as const:q.status==='KNOWN'?'NATIVE' as const:'P4' as const,
      protocol:p4?'finnor.evidence-request.v1' as const:q.status==='KNOWN'?'NATIVE_OWNER_READ_V1' as const:'finnor.evidence-request.v1' as const,
      semantics:{entityRefs:p4?p4.sourceHandles.map(h=>h.root):binding.views.map(v=>v.root),consolidation:financial?.consolidation??'OWNER_SUBJECT_ONLY_NO_UNREGISTERED_AGGREGATION',
        periods:financial?[{start:financial.periodStart,end:financial.periodEnd,frequency:financial.frequency,calendar:financial.calendar}]:[candidate.definition.periodDefinition],
        unit:node.unit,currency:node.currency??null,scale:financial?.scale??'NATIVE_EXACT_UNSCALED',
        instrument:financial?.instrument??'NATIVE_ASSUMPTION_OR_OWNER_SOURCE_NOT_A_NEW_MEASUREMENT',
        sourceStanding:p4?'P4_CURRENT_AUTHENTIC_SOURCE_HANDLES_NOT_OPERATIVE_DOCUMENT_COMPLETENESS':'EXACT_S1_KNOWLEDGE_VISIBLE_OWNER_VERSION',
        coverage:'DECLARED_NATIVE_INPUT_ONLY_NOT_GLOBAL_DOCUMENT_COMPLETENESS'},
      permittedOperations:p4?['EVIDENCE_READ','READ_WITNESS']:['AUTHENTICATED_OWNER_READ'],
      status:p4?'P4_RESOLVED' as const:q.status==='KNOWN'?'NATIVE_RESOLVED' as const:q.status==='CONFLICTING'?'CONTRADICTORY' as const:'UNKNOWN' as const,
      reason:q.reasons.join('; ')||'Exact native input with owner/S1 witness',nativeWitnessRefs:q.witnesses,
      ...(p4&&selected?{execution:{operation:'evidence-read' as const,queryId:p4.queryId,derivationId:p4.id,output:selected.output}}:{})};
    demands.push({...body,ref:m1Ref('evidence-demand',body)});
  }
  for(const gap of binding.gaps){
    const body={...base,candidateId:null,variableIds:[`gap:${gap.id}`],affectedRoots:gap.affectedRoots.length?gap.affectedRoots:graph.roots.map(r=>r.id),
      requiredProducer:gap.requiredProducer,protocol:gap.requiredProducer==='P4'?'finnor.evidence-request.v1' as const:'OWNER_CONTRACT_REQUEST_V1' as const,
      semantics:{entityRefs:binding.views.map(v=>v.root),consolidation:'EXACT_CANDIDATE_LEGAL_ENTITY_SCOPE',periods:[binding.request.validAt??binding.views[0]?.validAt??null],
        unit:null,currency:null,scale:'REGISTERED_CONTRACT_REQUIRED',instrument:'OPERATIVE_DOCUMENT_OR_OWNER_CONTRACT',
        sourceStanding:'CURRENT_OPERATIVE_VERSION_AND_AMENDMENT_CHAIN',
        coverage:gap.requirement},permittedOperations:gap.requiredProducer==='P4'?['SOURCE','PROJECT','RECONCILE','READ_WITNESS']:['PROPOSE_CONTRACT_REQUEST'],
      status:gap.status,reason:gap.requirement,nativeWitnessRefs:[]};
    demands.push({...body,ref:m1Ref('evidence-demand',body)});
  }
  if(demands.length>binding.request.resource.maxDemands)throw new DecisionSliceError('LIMIT_EXCEEDED','Material evidence demands exceed the episode envelope');
  return demands;
}
export function assertP4Protocol(value:{schema?:unknown;status?:unknown}):void{
  if(value.schema!=='finnor.evidence-derivation.v1')throw new DecisionSliceError('INVALID_REQUEST','Unsupported P4 derivation schema');
  // A caller-supplied response is never an authentic owner read.
  throw new DecisionSliceError('UNAVAILABLE','P4 owner-resolved versioned producer is required, not caller-supplied derivation JSON');
}
export const demandDigest=(demand:EvidenceDemand):string=>epistemicHash(demand);

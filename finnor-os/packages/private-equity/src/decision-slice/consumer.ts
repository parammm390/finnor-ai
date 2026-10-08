import { compileUnderwritingModel, executeUnderwritingModel } from '@finnor/underwriting';
import { epistemicHash } from '../../../epistemic-runtime/src/source-precedence';
import { verifyCanonicalAllocation } from '../../../epistemic-runtime/src/allocation-checker';
import { prepareUnderwritingRun, persistPreparedUnderwritingRun, explainUnderwritingOutput } from '../underwriting-repository';
import { chooseEnterpriseControlBranch } from '../enterprise-control';
import type { PeMutationContext } from '../types';
import { DecisionSliceError, same } from './contracts';
import { measuredM1, readCurrentDecisionSlice } from './service';

/** Evidence input is never an S4 policy, S5 clearance or S6 effect grant. */
export async function consumeDecisionSlice(ctx:PeMutationContext,value:unknown,use:'DECISION'|'NUMERICAL_ONLY',decision?:unknown){
  const current=await readCurrentDecisionSlice(ctx,value),{slice,binding}=current;
  return measuredM1(ctx,'NATIVE_CONSUMER',binding.work.id,30000,async(deadline,signal)=>{
    if(use==='DECISION'&&slice.unresolvedCoverage.length)
      return {status:'INSUFFICIENT_DECISION_COVERAGE',unresolvedCoverage:slice.unresolvedCoverage,executionAuthorityGranted:false,
        effectRef:null,allocationGranted:false,policyReplaced:false};
    if(binding.underwriting.length){
      if(binding.underwriting.some(c=>c.inputQualifications.some(q=>q.status!=='KNOWN')))
        return {status:'INSUFFICIENT_NATIVE_INPUT',unresolvedCoverage:slice.unresolvedCoverage,runs:[],executionAuthorityGranted:false};
      const runs=[];
      for(const candidate of binding.underwriting){
        if(signal.aborted||performance.now()>=deadline)throw new DecisionSliceError('LIMIT_EXCEEDED','Whole native consumer deadline exhausted');
        const compiled=compileUnderwritingModel(candidate.definition);
        const result=executeUnderwritingModel(compiled,candidate.input);
        const prepared=await prepareUnderwritingRun(ctx,{investmentCaseId:candidate.input.investmentCaseId,modelVersionId:candidate.modelRef.id,
          worldAt:candidate.input.worldAt,scenarioId:candidate.scenarioRef?.id,
          evidenceDerivationInputs:binding.request.source.kind==='UNDERWRITING'?binding.request.source.evidenceDerivationInputs:
            binding.request.source.kind==='POLICY'?binding.request.source.underwriting?.evidenceDerivationInputs:undefined});
        if(!same(prepared.effectiveSnapshot,candidate.input))throw new DecisionSliceError('STALE_INPUT','Authorized native inputs changed before consumer persistence');
        const persisted=await persistPreparedUnderwritingRun(ctx,{prepared,result,scenarioId:candidate.scenarioRef?.id,
          idempotencyKey:`m1:${slice.ref.contentDigest}:${candidate.candidateId}`,workId:binding.work.id});
        runs.push(persisted);
      }
      await readCurrentDecisionSlice(ctx,value);
      return {status:'NATIVE_NUMERICAL_ONLY',runs,unresolvedCoverage:slice.unresolvedCoverage,executionAuthorityGranted:false,
        qualification:'Exact native numerical/check outcomes, not an acquisition/financing recommendation; invalid outcomes remain invalid'};
    }
    if(binding.allocation){
      // Use the actual immutable S5 problem and selected certificate. Current S5
      // validation occurred at readCurrentDecisionSlice; this does not reserve again.
      const check=verifyCanonicalAllocation(binding.allocation.problem,binding.allocation.certificate.check.selectedPolicyIds);
      if(!check.feasible)throw new DecisionSliceError('CHECK_FAILED','Native S5 constraint consumer rejected its original problem');
      await readCurrentDecisionSlice(ctx,value);
      return {status:'NATIVE_CONSTRAINT_ONLY',allocationRef:binding.allocation.certificate.ref,check,
        outstanding:binding.resourceSnapshot?.outstanding??[],unresolvedCoverage:slice.unresolvedCoverage,
        executionAuthorityGranted:false,reservationCreated:false,effectRef:null};
    }
    const choices=[];
    if(decision)for(const {policy}of binding.policies)choices.push(await chooseEnterpriseControlBranch(ctx,{policyRef:policy.ref,decision}));
    await readCurrentDecisionSlice(ctx,value);
    return {status:decision?'NATIVE_POLICY_BRANCH_ONLY':'NATIVE_POLICY_EVIDENCE_ONLY',choices,policyRefs:binding.policies.map(p=>p.policy.ref),
      unresolvedCoverage:slice.unresolvedCoverage,executionAuthorityGranted:false,effectRef:null};
  });
}
export async function decisionSliceWitness(ctx:PeMutationContext,value:unknown,variableId:string){
  const {slice,binding}=await readCurrentDecisionSlice(ctx,value),variable=slice.materialVariables.find(v=>v.id===variableId);
  if(!variable)throw new DecisionSliceError('UNAVAILABLE','Permitted decision context is unavailable');
  const candidate=binding.underwriting.find(c=>c.candidateId===variable.candidateId),native:unknown[]=[];
  if(candidate){
    const input=candidate.input.values[variable.nativeId],qualification=candidate.inputQualifications.find(q=>q.nodeId===variable.nativeId);
    const definition=candidate.definition.nodes.find(n=>n.id===variable.nativeId);
    native.push({ownerRef:candidate.modelRef,definition,input:input??null,qualification:qualification??null,
      modelDigest:candidate.modelDigest,inputDigest:candidate.input.semanticHash,qualificationBasis:'ACTUAL_S1_PINNED_NATIVE_OWNER_INPUT'});
  }else{
    native.push({ownerRef:variable.ownerRef,definitionDigest:variable.definitionDigest,
      policy:binding.policies.find(p=>`policy:${p.policy.ref.contentDigest}`===variable.candidateId)??null,
      allocation:variable.id.startsWith('allocation:')?binding.allocation:null,
      resourceSnapshot:variable.kind==='RESOURCE'||variable.kind==='OUTSTANDING_COMMITMENT'?binding.resourceSnapshot:null,
      gap:binding.gaps.find(g=>`gap:${g.id}`===variable.id)??null});
  }
  const selected=binding.request.source.kind==='UNDERWRITING'?binding.request.source.evidenceDerivationInputs?.[variable.nativeId]:
    binding.request.source.kind==='POLICY'?binding.request.source.underwriting?.evidenceDerivationInputs?.[variable.nativeId]:undefined;
  const p4=binding.p4.find(d=>d.id===selected?.derivationId||variable.id===`p4:${d.id}:complete-owner`);
  const p4Derivation=p4?{id:p4.id,queryId:p4.queryId,code:p4.code,work:p4.work,program:p4.queryProgram,
    output:selected?p4.result?.outputs[selected.output]:null,witnesses:p4.witnesses,independentChecks:p4.independentChecks,
    coverage:p4.coverage,contradictions:p4.contradictions,invalidationKeys:p4.invalidationKeys,
    qualification:'P4_EXACT_FINANCIAL_DERIVATION_NOT_FACT_SCIENTIFIC_TRUTH_OPERATIVE_LEGAL_COMPLETENESS_OR_AUTHORITY'}:null;
  await readCurrentDecisionSlice(ctx,value);
  return {sliceRef:slice.ref,variable,native,p4Derivation,pins:binding.views.map(v=>v.pin),
    witnessDigest:epistemicHash({native,p4Derivation}),executionAuthorityGranted:false};
}

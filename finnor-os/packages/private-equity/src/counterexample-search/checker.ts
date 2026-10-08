import { compileUnderwritingModel, executeUnderwritingModel, applyScenario } from '@finnor/underwriting';
import { verifyCanonicalAllocation, certifyAllocationOptimization } from '../../../epistemic-runtime/src/allocation-checker';
import { allocationDerivedQuantity as quantity } from '../../../epistemic-runtime/src/allocation-contracts';
import { ExperimentRational } from '../../../epistemic-runtime/src/experiment-numerics';
import { independentReference } from './reference';
import { replayOriginalWorld } from './worlds';
import { executeEffectFixture } from './effect-fixture';
import { hash,type FrozenDiagnostic,type Proposal,type Validation,type CandidateClaim } from './contracts';
import type { PeMutationContext } from '../types';
import { currentDerivation } from '../evidence-execution/store';
import { checkBudget,remainingMs } from './budget';

function rational(value:string):ExperimentRational{
  if(/^-?\d+\/[1-9]\d*$/.test(value)){const [n,d]=value.split('/');return new ExperimentRational(BigInt(n!),BigInt(d!));}
  return quantity(value);
}
const compare=(a:string,b:string)=>rational(a).compare(rational(b));
const passes=(a:string,relation:'LTE'|'GTE'|'EQ',b:string)=>relation==='LTE'?compare(a,b)<=0:relation==='GTE'?compare(a,b)>=0:compare(a,b)===0;
const unresolved=(reason:string):Validation=>({status:'UNRESOLVED',reason,failureKey:null,material:false,
  qualification:'NO_INDEPENDENT_APPLICABLE_FAILURE',native:{checker:'NOT_CHECKED',observed:null,trace:null},
  independent:{checker:'NOT_CHECKED',observed:null,trace:null},predicate:{expected:null,relation:'UNRESOLVED',location:'',unit:null}});
const result=(claim:CandidateClaim,native:Validation['native'],independent:Validation['independent'],
  failed:boolean,predicate:Validation['predicate'],failureDetail:unknown,qualification:string):Validation=>({
    status:failed?'VALID':'INVALID',reason:failed?'ORIGINAL_PREDICATE_VIOLATED':'PREDICATE_HOLDS',
    failureKey:failed?hash({claim:claim.ref,predicate:claim.predicateDigest,location:predicate.location,failureDetail}):null,
    material:failed,qualification,native,independent,predicate,
  });

/** A proposal is never a validation certificate. Every path starts at original frozen owner bytes. */
export async function validateProposal(ctx:PeMutationContext,frozen:FrozenDiagnostic,p:Proposal,signal?:AbortSignal):Promise<Validation>{
  checkBudget();
  const claim=frozen.claims.find(c=>hash(c.ref)===hash(p.claimRef));
  if(!claim||p.contextDigest!==frozen.contextDigest||p.predicateDigest!==claim.predicateDigest)
    return unresolved('CLAIM_DOMAIN_OR_CONTEXT_MISMATCH');
  if(p.components.some(c=>!frozen.request.domain.parameters.some(a=>a.candidateId===c.candidateId&&
    a.nodeId===c.nodeId&&a.values.includes(c.value)))||p.components.length>frozen.request.domain.maxCombination)
    return unresolved('PROPOSAL_OUTSIDE_DECLARED_DOMAIN');
  const e=claim.evaluation;
  try{
    if(e.kind==='MECHANICAL_BOUND'||e.kind==='NATIVE_CHECK'){
      const candidate=frozen.binding.underwriting.find(c=>c.candidateId===e.candidateId);
      const node=candidate?.definition.nodes.find(n=>n.id===e.nodeId);
      if(!candidate||!node||e.kind==='NATIVE_CHECK'&&node.kind!=='check')return unresolved('NATIVE_ORIGINAL_PREDICATE_UNAVAILABLE');
      if(e.kind==='MECHANICAL_BOUND'&&(node.valueType!=='decimal'||node.shape!=='scalar'||node.unit!==e.unit||
        (node.currency??null)!==(e.currency??null)))return unresolved('EXACT_ENTITY_UNIT_CURRENCY_OR_SHAPE_MISMATCH');
      const compiled=compileUnderwritingModel(candidate.definition),snapshot=applyScenario(compiled,candidate.input,{
        schemaVersion:'underwriting-scenario.v1',name:'Frozen M4 hypothetical diagnostic, not source correction',
        overrides:p.components.filter(c=>c.candidateId===e.candidateId).map(c=>({nodeId:c.nodeId,value:c.value,reason:'SUPPLIED_H1_DOMAIN'})),
      }).snapshot;
      const native=executeUnderwritingModel(compiled,snapshot);
      if(native.status!=='SUCCEEDED')return unresolved('NATIVE_EXECUTION_ERROR_NOT_SAME_PREDICATE');
      const observed=native.values[e.nodeId]?.value;
      const independent=await independentReference({operation:'MODEL',model:candidate.definition,snapshot:candidate.input,
        components:p.components,candidateId:e.candidateId,nodeId:e.nodeId},signal);
      if(independent.status!=='CHECKED')return {...unresolved(independent.reason??'INDEPENDENT_CHECKER_UNAVAILABLE'),
        native:{checker:'NATIVE_UNDERWRITING_ORIGINAL_IR',observed,trace:native.checks},
        independent:{checker:'M4_FRACTION_ORIGINAL_IR_V1',observed:null,trace:independent}};
      if(e.kind==='NATIVE_CHECK'){
        if(typeof observed!=='boolean'||typeof independent.observed!=='boolean'||observed!==independent.observed)
          return unresolved('NATIVE_REFERENCE_DISAGREEMENT');
        return result(claim,{checker:'NATIVE_UNDERWRITING_ORIGINAL_IR',observed,trace:native.checks},
          {checker:independent.checker!,observed:independent.observed,trace:independent},!observed,
          {expected:true,relation:'ORIGINAL_CHECK',location:e.nodeId,unit:node.unit},false,'EXACT_SUPPLIED_MECHANICS_H1_NOT_PREMISE_TRUTH');
      }
      if(typeof observed!=='string'||typeof independent.observed!=='string'||compare(observed,independent.observed)!==0)
        return unresolved('NATIVE_REFERENCE_DISAGREEMENT_OR_ROUNDOFF_UNQUALIFIED');
      return result(claim,{checker:'NATIVE_UNDERWRITING_ORIGINAL_IR',observed,trace:{checks:native.checks,inputDigest:snapshot.semanticHash}},
        {checker:independent.checker!,observed:independent.observed,trace:independent},!passes(independent.observed,e.relation,e.value),
        {expected:e.value,relation:e.relation,location:e.nodeId,unit:e.unit},'BOUND_VIOLATION',
        'EXACT_SUPPLIED_MECHANICS_H1_NOT_PREMISE_TRUTH');
    }
    if(e.kind==='SOURCE_LITERAL'){
      const source=frozen.binding.views.flatMap(v=>v.claims).find(c=>c.ownerRef.entityType===e.entityType&&c.ownerRef.id===e.entityId);
      if(!source||!Object.hasOwn(source.value,e.field))return unresolved('SOURCE_UNAVAILABLE_OR_OUTSIDE_SELECTED_UNIVERSE');
      if(source.kind==='UNKNOWN'||source.uncertainty.representation!=='QUALIFIED_RECORD')return unresolved('SOURCE_STANDING_UNRESOLVED');
      const raw=source.exactSnapshotJson?JSON.parse(source.exactSnapshotJson):source.value;
      if(!Object.hasOwn(raw,e.field))return unresolved('ORIGINAL_SOURCE_LOCATOR_UNAVAILABLE');
      const actual=raw[e.field];if(!['string','boolean'].includes(typeof actual)&&actual!==null)return unresolved('SOURCE_LITERAL_DOMAIN_UNSUPPORTED');
      const native={checker:'S1_CURRENT_OWNER_PROJECTION',observed:source.value[e.field],trace:source.ownerRef};
      const independent={checker:'S1_ORIGINAL_EXACT_SNAPSHOT_LOCATOR',observed:actual,
        trace:{ownerRef:source.ownerRef,locator:e.entityType+':'+e.entityId+':'+e.field,knowledgeAt:source.knowledgeAt}};
      if(hash(native.observed)!==hash(actual))return unresolved('OWNER_ORIGINAL_SOURCE_DISAGREEMENT');
      return result(claim,native,independent,hash(actual)!==hash(e.expected),
        {expected:e.expected,relation:'EXACT_RECORDED_LITERAL',location:e.entityId+':'+e.field,unit:null},actual,
        'DETERMINISTIC_RECORD_CONTRADICTION_NOT_ADMITTED_LEGAL_EFFECT');
    }
    if(e.kind==='P4_TERM'){
      const d=await currentDerivation(ctx,e.derivationId),output=d.result?.outputs[e.output];
      if(!output||output.kind!=='scalar'||output.value===null||output.semantics?.unit!==e.unit||
        output.semantics.entityId!==e.entityId||output.semantics.entityType!==e.entityType)
        return unresolved('P4_EXACT_OUTPUT_SCOPE_OR_SEMANTICS_UNAVAILABLE');
      const checks=d.independentChecks.filter(c=>c.id==='numeric:'+e.output&&c.status==='PASS'&&typeof c.expected==='string');
      if(checks.length!==1||checks[0]!.expected===null)return unresolved('P4_SEPARATE_ORIGINAL_NUMERIC_CHECK_UNAVAILABLE');
      const independent=String(checks[0]!.expected);
      if(compare(output.value,independent)!==0)return unresolved('P4_REFERENCE_DISAGREEMENT');
      return result(claim,{checker:'P4_CURRENT_NATIVE_DERIVATION',observed:output.value,trace:{derivationId:d.id,code:d.code}},
        {checker:'P4_SEPARATE_POSTGRES_NUMERIC_V1',observed:independent,trace:{checks,witnesses:d.witnesses.filter(w=>output.witnessIds.includes(w.id))}},
        compare(independent,e.expected)!==0,{expected:e.expected,relation:'EQ',location:e.output,unit:e.unit},independent,
        'P4_ORIGINAL_TERM_H0_H1_SELECTED_UNIVERSE_NOT_GLOBAL_LEGAL_COVERAGE');
    }
    if(e.kind==='ALLOCATION_SELECTION'||e.kind==='ALLOCATION_BOUND'){
      const allocation=frozen.binding.allocation,problem=frozen.capital?.context.program.allocation.problem??allocation?.problem;
      if(!problem)return unresolved('ORIGINAL_S5_PROBLEM_UNAVAILABLE');
      if(problem.policies.length>8)return unresolved('S5_REFERENCE_DOMAIN_EXCEEDED');
      if(e.kind==='ALLOCATION_SELECTION'){
        const native=verifyCanonicalAllocation(problem,e.selectedPolicyIds);
        const independent=await independentReference({operation:'ALLOCATION',problem,mode:'SELECTION',selected:e.selectedPolicyIds},signal);
        if(independent.status!=='CHECKED'||independent.feasible!==native.feasible)return unresolved(independent.reason??'S5_NATIVE_REFERENCE_DISAGREEMENT');
        const violation=native.witnesses.find(w=>compare(w.margin,'0')<0);
        const proof=independent.witnesses?.find(w=>w.constraintId===violation?.constraintId&&w.scenarioId===violation?.scenarioId&&w.period===violation?.period);
        if(!native.feasible&&(!violation||!proof||compare(proof.used,violation.used)!==0||compare(proof.maximum,violation.maximum)!==0))
          return unresolved('NO_SAME_ORIGINAL_RATIONAL_CONSTRAINT_WITNESS');
        return result(claim,{checker:'S5_CANONICAL_ORIGINAL_ACTION_VERIFIER',observed:native.feasible,trace:native},
          {checker:'M4_FRACTION_ORIGINAL_S5_V1',observed:independent.feasible,trace:independent},!native.feasible,
          {expected:'ORIGINAL_CANONICAL_FEASIBILITY',relation:'FEASIBLE',location:violation?.constraintId??problem.ref.id,
            unit:problem.resources.find(r=>'resource:'+r.resourceId===violation?.constraintId)?.unit??null},
          violation?.constraintId??null,'ORIGINAL_S5_MODEL_RELATIVE_PROBLEM_NO_NEW_CLEARANCE');
      }
      const incumbent=allocation?.certificate.check.selectedPolicyIds??frozen.capital?.context.program.allocation.checks.find(c=>c.feasible)?.selectedPolicyIds??[];
      const native=certifyAllocationOptimization(problem,incumbent,{deadlineAt:performance.now()+remainingMs(),
        searchTermination:'M4_ORIGINAL_PROOF_REPLAY',solverUpperBoundEstimate:null}).optimization;
      const independent=await independentReference({operation:'ALLOCATION',problem,mode:'BOUND'},signal);
      if(independent.status!=='CHECKED'||independent.optimum==null||!native.completeSearch||
        compare(native.upperBound,independent.optimum)!==0)return unresolved('ORIGINAL_EXACT_BOUND_CHECK_UNAVAILABLE');
      return result(claim,{checker:'S5_ORIGINAL_EXACT_SUBSET_PROOF',observed:native.upperBound,trace:native},
        {checker:'M4_FRACTION_ORIGINAL_S5_V1',observed:independent.optimum,trace:independent},
        compare(independent.optimum,e.bound)>0,{expected:e.bound,relation:'UPPER_BOUND',location:problem.ref.id,unit:problem.mandate.utility.unit},
        'FALSE_UPPER_BOUND','EXACT_FINITE_ORIGINAL_S5_DOMAIN_NOT_FIELD_VALUE');
    }
    if(e.kind==='POLICY_BOUND'){
      const binding=frozen.binding.policies.find(p=>p.policy.ref.id===e.policyId);
      if(!binding||!p.worldId||binding.policy.mandate.utility.unit!==e.unit)return unresolved('ORIGINAL_POLICY_WORLD_OR_UNIT_UNAVAILABLE');
      const native=replayOriginalWorld(binding,p.worldId);
      if(native.status!=='CHECKED')return unresolved(native.reason);
      const independent=await independentReference({operation:'POLICY',...binding,worldId:p.worldId},signal);
      const tolerance=binding.policy.certificate.numericalTolerance;
      if(independent.status!=='CHECKED'||typeof independent.observed!=='number'||Math.abs(independent.observed-native.value)>tolerance||
        hash((independent.trace as any[])?.map(n=>({actionId:n.actionId,observations:n.observations})))!==
        hash((native.trace as any[]).map(n=>({actionId:n.actionId,observations:n.observations}))))
        return unresolved(independent.reason??'POLICY_NATIVE_REFERENCE_OR_INFORMATION_DISAGREEMENT');
      return result(claim,{checker:'S3_ORIGINAL_ADAPTER_LAWFUL_S4_TREE',observed:native.value,trace:native.trace},
        {checker:'M4_ORIGINAL_KERNEL_REFERENCE_V1',observed:independent.observed,trace:independent},
        native.value<Number(e.minimum)-tolerance,{expected:e.minimum,relation:'MODEL_WORST_CASE_MINIMUM',location:e.policyId,unit:e.unit},
        'MODEL_BOUND_VIOLATION','SUPPORTED_ORIGINAL_JOINT_WORLD_NOT_PROBABILITY_OR_FIELD_CAUSAL_TRUTH');
    }
    if(e.kind==='EFFECT_FIXTURE')return executeEffectFixture(e,signal);
    return unresolved('CHECKER_DOMAIN_UNSUPPORTED');
  }catch(error){
    checkBudget();
    return unresolved(error instanceof Error&&/^[A-Z][A-Z0-9_:]+$/.test(error.message)?error.message:'INDEPENDENT_OR_NATIVE_CHECK_ERROR');
  }
}
export { unresolved };

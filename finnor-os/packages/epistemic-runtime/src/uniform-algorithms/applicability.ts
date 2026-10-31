import type {CanonicalAllocationProblem} from '../../../shared-types/src/allocation';
import {inspectCanonicalAllocationLinearModel,verifyCanonicalAllocation} from '../allocation-checker';
import {allocationDerivedQuantity as q,allocationDecimal} from '../allocation-contracts';
import {ER_ZERO,ExperimentRational,sumRationals as sum} from '../experiment-numerics';
import {epistemicHash} from '../source-precedence';

const gcd=(a:bigint,b:bigint):bigint=>b===0n?a:gcd(b,a%b);
export function uniformProblemIdentity(p:CanonicalAllocationProblem){
 const {ref,knowledgeAt,...meaning}=p;return epistemicHash(meaning);
}
/** Sufficient structural recognition, never a solver or relaxed original task.
 * Every original row, including liabilities and signed covenants, is retained.
 * Interval bounds are exact rational consequences of the full Boolean box. */
export function recognizeUniformAllocation(p:CanonicalAllocationProblem){
 const model=inspectCanonicalAllocationLinearModel(p),reasons=[...model.initialReasons];
 if(p.policies.length>128)reasons.push('PRACTICAL_SIZE_UNSUPPORTED');
 if(model.variables.some(v=>!v.startsWith('x:')))reasons.push('NONADDITIVE_INTERACTION');
 const rowProofs=model.rows.map(row=>{
  const upper=sum(row.coefficients.map(c=>q(c.value)).filter(v=>v.n>0n)),maximum=q(row.maximum);
  if(upper.compare(maximum)>0)reasons.push('BOX_DECOMPOSITION_REJECTED:'+row.id);
  return {id:row.id,upper:allocationDecimal(upper),maximum:row.maximum,passes:upper.compare(maximum)<=0};
 });
 const hypotheses=model.objectives.map(s=>{
  const comparisons=model.objectives.map(t=>{
   const lower=q(t.base).sub(q(s.base)).add(sum(model.variables.map(v=>{
    const delta=q(t.coefficients.find(c=>c.variable===v)?.value??'0').sub(q(s.coefficients.find(c=>c.variable===v)?.value??'0'));
    return delta.n<0n?delta:ER_ZERO;
   })));
   return {scenario:t.id,lowerDifference:allocationDecimal(lower),passes:lower.n>=0n};
  });
  return {scenario:s.id,comparisons,passes:comparisons.every(c=>c.passes)};
 });
 const dominant=hypotheses.find(h=>h.passes),objective=model.objectives.find(s=>s.id===dominant?.scenario);
 if(!objective)reasons.push('NO_CHECKED_DOMINATING_ADDITIVE_SCENARIO');
 const weights=p.policies.map(policy=>q(objective?.coefficients.find(c=>c.variable==='x:'+policy.ref.id)?.value??'0'));
 let scale=1n;
 for(const w of weights){scale=scale/gcd(scale,w.d)*w.d;if(scale.toString().length>512){reasons.push('EXACT_SCALING_BIT_DOMAIN_UNSUPPORTED');break;}}
 const integers=weights.map(w=>(w.n*(scale/w.d)).toString());
 if(integers.some(w=>w.replace('-','').length>512))reasons.push('EXACT_SCALING_BIT_DOMAIN_UNSUPPORTED');
 const body={schema:'finnor.y5.allocation-applicability.v1',problemIdentity:uniformProblemIdentity(p),
  canonicalProblemRef:p.ref,snapshotDigest:p.snapshotDigest,structure:'ADDITIVE_BOX_WITH_DOMINATING_SCENARIO',
  applicable:reasons.length===0,reasons:[...new Set(reasons)],rowProofs,hypotheses,inspection:model.inspection,dominantScenario:dominant?.scenario??null,
  policyIds:p.policies.map(policy=>policy.ref.id),integerWeights:integers,positiveCommonScale:scale.toString(),
  objectiveBase:objective?.base??null,translationBasis:'PINNED_ORIGINAL_EXACT_CHECKER_ADAPTER_NOT_FORMALLY_VERIFIED',
  mathematicalSizeBound:null,practicalSizeBound:128,executionAuthorityGranted:false as const};
 if(Buffer.byteLength(JSON.stringify(body))>1024*1024){
  const unsupported={...body,applicable:false,reasons:['Y5_STRUCTURAL_EVIDENCE_BYTES_UNSUPPORTED'],rowProofs:[],hypotheses:[]};
  return {...unsupported,digest:epistemicHash(unsupported)};
 }
 return {...body,digest:epistemicHash(body)};
}
export function checkUniformAllocationResult(p:CanonicalAllocationProblem,app:ReturnType<typeof recognizeUniformAllocation>,selected:number[]){
 const fresh=recognizeUniformAllocation(p);
 if(!fresh.applicable||fresh.digest!==app.digest)throw Error('Y5_APPLICABILITY_CHANGED');
 const ids=selected.map(i=>app.policyIds[i]!);
 const check=verifyCanonicalAllocation(p,ids);
 const expected=q(app.objectiveBase!).add(sum(app.integerWeights.map(w=>new ExperimentRational(BigInt(w),BigInt(app.positiveCommonScale))).filter(w=>w.n>0n)));
 if(!check.feasible||check.objective===null||q(check.objective).compare(expected)!==0)throw Error('Y5_ORIGINAL_CANONICAL_RESULT_REJECTED');
 return {check,exactUpperBound:allocationDecimal(expected),optimality:'UNIFORM_ADDITIVE_THEOREM_WITH_EXACT_ORIGINAL_ADAPTER',
  uncertaintyGap:'UNKNOWN',identificationGap:'UNKNOWN',omittedModelGap:'UNKNOWN',fieldEconomicValue:'UNKNOWN'};
}

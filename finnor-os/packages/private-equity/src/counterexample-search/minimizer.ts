import type { PeMutationContext } from '../types';
import { ChallengeError,hash,type FrozenDiagnostic,type Proposal,type Validation,type ValidatedCounterexample } from './contracts';
import type { SearchExecution } from './internal-types';
import { proposal } from './generator';
import { validateProposal } from './checker';
import { remainingMs } from './budget';

/** Three-way deletion relation. An exception or different failure never substitutes for reproduction. */
export async function minimize(ctx:PeMutationContext,frozen:FrozenDiagnostic,original:Proposal,
  validation:Validation,execution:SearchExecution,remainingReductions:{value:number}){
  let reduced=original,checked=validation,complete=true;
  const trace:ValidatedCounterexample['minimization']['trace']=[];
  const target=frozen.targets.find(t=>hash(t.ref)===hash(original.targetRef))!;
  // Restart after a successful deletion, so every final surviving component has a recorded deletion test.
  let i=0;
  while(i<reduced.components.length){
    if(remainingReductions.value<=0||remainingMs()<1000){complete=false;break;}
    const removed=reduced.components[i]!,trial=proposal(frozen,target,reduced.components.filter((_,k)=>k!==i),reduced.worldId);
    let observed:Validation;
    try{
      await execution.debit('REDUCTION',{proposal:trial,originalRef:original.ref,removed});
      remainingReductions.value--;
      observed=await validateProposal(ctx,frozen,trial,execution.signal);
      await execution.retain('REDUCTION_CHECK',{proposal:trial,validation:observed,originalRef:original.ref,removed});
    }catch(error){
      if(error instanceof ChallengeError&&error.code==='CANCELLED')throw error;
      complete=false;trace.push({proposalRef:trial.ref,removed,outcome:'UNRESOLVED',reason:'REDUCTION_BUDGET_OR_CHECK_UNAVAILABLE'});break;
    }
    const same=observed.status==='VALID'&&observed.material&&observed.failureKey===validation.failureKey;
    const outcome=same?'FAIL':observed.status==='INVALID'?'PASS':'UNRESOLVED';
    trace.push({proposalRef:trial.ref,removed,outcome,reason:observed.status==='VALID'&&!same?'DIFFERENT_FAILURE':observed.reason});
    if(same){reduced=trial;checked=observed;i=0;}else{if(outcome==='UNRESOLVED')complete=false;i++;}
  }
  return {minimized:reduced,validation:checked,minimization:{
    status:complete?'ONE_MINIMAL_RECORDED_DELETIONS' as const:'SUFFICIENT_NOT_MINIMAL' as const,trace,
    relation:'SAME_CANDIDATE_CLAIM_CONTEXT_AND_FAILURE' as const,globallySmallest:false as const,
  }};
}

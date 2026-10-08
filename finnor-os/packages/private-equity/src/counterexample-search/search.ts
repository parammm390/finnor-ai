import type { PeMutationContext } from '../types';
import { ChallengeError,gap,hash,ref,type FrozenDiagnostic,type OwnerArtifactDiagnostic,type ValidatedCounterexample,type CoverageGap } from './contracts';
import type { SearchExecution } from './internal-types';
import { declaredCells,declaredCellCount,proposal } from './generator';
import { validateProposal } from './checker';
import { minimize } from './minimizer';
import { remainingMs } from './budget';

export interface SearchOutcome {
  witnesses:ValidatedCounterexample[];unresolved:CoverageGap[];result:OwnerArtifactDiagnostic['result'];
  coverage:OwnerArtifactDiagnostic['coverage'];repairDependencies:OwnerArtifactDiagnostic['repairDependencies'];
}
export async function searchFrozenDiagnostic(ctx:PeMutationContext,frozen:FrozenDiagnostic,execution:SearchExecution):Promise<SearchOutcome>{
  const witnesses:ValidatedCounterexample[]=[],unresolved=[...frozen.gaps],semantic=new Set<string>();
  const limits=frozen.request.limits,reductions={value:limits.maxReductions};
  let generated=0,checked=0,invalid=0,unknown=0;
  const visited=new Set<string>(),repairs=await execution.repairProposals();
  await execution.validateCurrent();
  await execution.retain('SCHEDULER',{schema:'finnor.m4.fixed-native-scheduler.v1',domainRef:frozen.domainRef,
    targets:frozen.targets.map(t=>t.ref),ordering:'SETTLED_REPAIR_THEN_BASELINE_SINGLE_PAIR_TRIPLE_ORIGINAL_JOINT_WORLD',
    futureOwner:'M2',missingPort:'AUTHENTIC_DELIBERATION_POLICY_READER',authorityGranted:false});
  function* cells(){
    for(const p of repairs){
      const target=frozen.targets.find(t=>hash(t.ref)===hash(p.targetRef));
      if(!target||hash(proposal(frozen,target,p.components,p.worldId))!==hash(p))
        throw new ChallengeError('CHECK_FAILED','Retained repair proposal differs from this exact domain');
      yield {target,components:p.components,worldId:p.worldId};
    }
    yield* declaredCells(frozen);
  }
  for(const cell of cells()){
    try{
    if(generated>=limits.maxCells||witnesses.length>=limits.maxWitnesses||remainingMs()<1000)break;
    const p=proposal(frozen,cell.target,cell.components,cell.worldId);
    if(visited.has(p.ref.contentDigest))continue;
    visited.add(p.ref.contentDigest);
    const prior=await execution.priorValidation(p);
    if(!prior&&!await execution.witnessCapacity(p)){
      unresolved.push(gap('WITNESS_ALLOCATION_EXHAUSTED','The root witness allowance cannot retain a new claim; checking stopped before acceptance',p.claimRef,true,'M4'));
      break;
    }
    // A committed check already owns its generation/validation debits. Retrying
    // must not spend a new trial before discovering that accepted evidence.
    if(!prior)await execution.debit('GENERATE',{proposal:p});
    generated++;
    if(!prior)await execution.debit('VALIDATE',{proposalRef:p.ref});
    const validation=prior??await validateProposal(ctx,frozen,p,execution.signal);
    await execution.retain(prior?'REUSED_SETTLED_CHECK':'CHECK',{proposal:p,validation});
    if(validation.status==='UNRESOLVED'){
      unknown++;unresolved.push(gap(validation.reason,'This generated hypothesis has no independent applicable predicate check',
        p.claimRef,false,cell.target.checker,1));continue;
    }
    checked++;if(validation.status==='INVALID'){invalid++;continue;}
    if(!validation.material||!validation.failureKey){unknown++;continue;}
    await execution.validateCurrent();
    // Persist the accepted original before reduction. A crash cannot erase an independently checked failure.
    await execution.retain('VALID_ORIGINAL',{proposal:p,validation});
    const saved=await execution.priorWitness(p);
    if(saved){
      if(hash(saved.claimRef)!==hash(p.claimRef)||hash(saved.targetRef)!==hash(p.targetRef)||
        saved.validation.failureKey!==validation.failureKey)
        throw new ChallengeError('CHECK_FAILED','Settled witness and original check disagree');
      witnesses.push(saved);
      semantic.add(hash({failureKey:saved.validation.failureKey,context:frozen.contextDigest,
        claim:p.claimRef,world:p.worldId,components:saved.minimized.components}));
      await execution.retain('REUSED_SETTLED_WITNESS',{witnessRef:saved.ref,originalRef:p.ref});
      if(saved.minimization.status==='SUFFICIENT_NOT_MINIMAL')
        unresolved.push(gap('MINIMIZATION_INCOMPLETE','Original validated witness retained; global smallestness is never claimed',p.claimRef));
      continue;
    }
    const minimized=await minimize(ctx,frozen,p,validation,execution,reductions);
    // Deduplicate only after the recorded same-failure relation has established
    // an identical reduced coupled input. A generic failed-predicate label is
    // insufficient, and every original/check/reduction still stays in the ledger.
    const key=hash({failureKey:validation.failureKey,context:frozen.contextDigest,claim:p.claimRef,
      world:p.worldId,components:minimized.minimized.components});
    if(semantic.has(key)){
      await execution.retain('SEMANTIC_DUPLICATE',{proposalRef:p.ref,minimizedRef:minimized.minimized.ref,
        failureKey:validation.failureKey,minimization:minimized.minimization});
      continue;
    }
    semantic.add(key);
    const body={class:cell.target.class,claimRef:p.claimRef,targetRef:cell.target.ref,candidateIdentity:frozen.identityDigest,
      contextDigest:frozen.contextDigest,original:p,...minimized,
      replay:{operation:'counterexample-witness-replay' as const,readOnly:true as const,effectReexecution:false as const}};
    const witness:ValidatedCounterexample={ref:ref('validated-counterexample',body),...body};
    await execution.retain('WITNESS',witness);witnesses.push(witness);
    if(minimized.minimization.status==='SUFFICIENT_NOT_MINIMAL')
      unresolved.push(gap('MINIMIZATION_INCOMPLETE','Original validated witness retained; global smallestness is never claimed',p.claimRef));
    }catch(error){
      // A logical cell/trial/reduction allocation stops further search, not the
      // coherent report. Actual cancellation, stale inputs and physical deadline
      // failures still fence publication in the worker.
      if(!(error instanceof ChallengeError)||error.code!=='LIMIT_EXCEEDED')throw error;
      unresolved.push(gap('SEARCH_BUDGET_EXHAUSTED','The one parent search allocation was exhausted before all independent checks'));
      break;
    }
  }
  const total=declaredCellCount(frozen),untested=total-generated+Math.max(0,generated-checked-unknown);
  if(untested)unresolved.push(gap('SEARCH_BUDGET_EXHAUSTED',`${untested} finite declared cells were not checked under the one parent episode`));
  if(!checked)unresolved.push(gap('NO_PERMITTED_INDEPENDENT_CHECK','Zero applicable independently checked cells cannot be a no-witness result',null,true));
  // Dedup only gap identity, not a distinct witness/world or failed attempt's accounting.
  const gaps=[...new Map(unresolved.map(g=>[g.ref.contentDigest,g])).values()];
  const claimRefs=witnesses.map(w=>w.claimRef),regionIds=new Set(frozen.claims.filter(c=>claimRefs.some(r=>hash(r)===hash(c.ref))).flatMap(c=>c.regionIds));
  // Backward closure is already frozen per claim. Include downstream uses without dropping unrelated regions from the graph.
  const uses=new Set(regionIds),pending=[...regionIds];
  while(pending.length){const id=pending.pop()!;
    for(const edge of frozen.faultGraph.edges.filter(e=>e.to===id))if(!uses.has(edge.from)){uses.add(edge.from);pending.push(edge.from);}}
  const regions=frozen.faultGraph.nodes.filter(n=>regionIds.has(n.id));
  const ownerRefs=[...new Map(regions.map(n=>[hash(n.ownerRef),n.ownerRef])).values()];
  const repair={regions,claimRefs,ownerRefs,faultGraphRef:frozen.faultGraph.ref,sourceSliceGraphRef:frozen.graph.ref,
    affectedUses:[...uses].sort(),request:'OWNER_REPAIR_OR_S4_FALLBACK' as const,authorityGranted:false as const};
  return {witnesses,unresolved:gaps,result:witnesses.length?'FAILURE_WITNESS':
    gaps.some(g=>g.fatal)||!checked?'BLOCKED':'NO_WITNESS_WITHIN_BUDGET',
    coverage:{generatedCells:generated,checkedCells:checked,invalidCells:invalid,unresolvedCells:unknown,
      totalDeclaredCells:total,untestedCells:untested,completeFiniteDeclaredCells:untested===0&&unknown===0,
      unrestrictedCompleteness:false},repairDependencies:{ref:ref('affected-dependency-closure',repair),...repair}};
}

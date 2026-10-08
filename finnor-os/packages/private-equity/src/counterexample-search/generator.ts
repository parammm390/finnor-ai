import { hash,ref,type Proposal,type FrozenDiagnostic,type FaultTarget,type Component } from './contracts';
export interface DeclaredCell {target:FaultTarget;components:Component[];worldId:string|null}
function* combinations(frozen:FrozenDiagnostic):Generator<Component[]>{
  const axes=frozen.request.domain.parameters,limit=frozen.request.domain.maxCombination;
  function* append(start:number,chosen:Component[],size:number):Generator<Component[]>{
    if(chosen.length===size){yield chosen;return;}
    for(let i=start;i<axes.length;i++)for(const value of axes[i]!.values){
      const next=[...chosen,{candidateId:axes[i]!.candidateId,nodeId:axes[i]!.nodeId,value}];
      yield* append(i+1,next,size);
    }
  }
  for(let size=0;size<=limit;size++)yield* append(0,[],size);
}
const worlds=(frozen:FrozenDiagnostic,policyId:string)=>frozen.binding.policies.find(p=>p.policy.ref.id===policyId)
  ?.kernel.mechanisms.flatMap(m=>m.scenarios.map(s=>s.id))??[];
/** Count the finite polynomial domain without materializing a powerset or untested cells. */
export function declaredCellCount(frozen:FrozenDiagnostic):number{
  const counts=[1,0,0,0];
  for(const axis of frozen.request.domain.parameters)for(let order=frozen.request.domain.maxCombination;order>0;order--)
    counts[order]!+=counts[order-1]!*axis.values.length;
  const parameterCells=counts.slice(0,frozen.request.domain.maxCombination+1).reduce((a,b)=>a+b,0);
  return frozen.targets.reduce((count,target)=>{
    const e=frozen.claims.find(c=>c.ref.contentDigest===target.claimRef.contentDigest)!.evaluation;
    return count+(e.kind==='POLICY_BOUND'?Math.max(1,worlds(frozen,e.policyId).length):
      e.kind==='MECHANICAL_BOUND'||e.kind==='NATIVE_CHECK'?parameterCells:1);
  },0);
}
/** Fixed finite, lazy scheduler. No utility changes, sampling or hidden-world mixing. */
export function* declaredCells(frozen:FrozenDiagnostic):Generator<DeclaredCell>{
  for(const target of frozen.targets){
    const claim=frozen.claims.find(c=>c.ref.contentDigest===target.claimRef.contentDigest)!;
    const e=claim.evaluation;
    if(e.kind==='POLICY_BOUND'){
      const ids=worlds(frozen,e.policyId);
      for(const worldId of ids)yield {target,components:[],worldId};
      if(!ids.length)yield {target,components:[],worldId:null};
    }else if(e.kind==='MECHANICAL_BOUND'||e.kind==='NATIVE_CHECK'){
      for(const components of combinations(frozen))yield {target,components,worldId:null};
    }else yield {target,components:[],worldId:null};
  }
}
export function proposal(frozen:FrozenDiagnostic,target:FaultTarget,components:Component[],worldId:string|null):Proposal{
  const claim=frozen.claims.find(c=>c.ref.contentDigest===target.claimRef.contentDigest)!;
  const body={targetRef:target.ref,claimRef:claim.ref,components:[...components].sort((a,b)=>
    `${a.candidateId}:${a.nodeId}`.localeCompare(`${b.candidateId}:${b.nodeId}`)),worldId,
    contextDigest:frozen.contextDigest,predicateDigest:claim.predicateDigest,
    qualification:worldId?'S3_BOOTSTRAP_JOINT_MODEL_RELATIVE_NOT_PROBABILITY':'SUPPLIED_H1_MECHANICS_OR_ISOLATED_H0_FIXTURE'};
  return {ref:ref('fault-proposal',body),...body};
}
/** A different coupled input never borrows a settled input's root allowance. */
export function witnessInputKey(candidate:string,p:Proposal):string{
  return hash({candidate,claim:p.claimRef,context:p.contextDigest,world:p.worldId,components:p.components});
}

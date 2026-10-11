import {env as runtimeEnvironment} from 'node:process';
import type {ExperimentRef} from '@finnor/shared-types';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {authorize,principal,stable,tx} from '../evidence-execution/store';
import {requestRow,assertProgramCurrent} from '../program-synthesis/store';
import {readEnterpriseContingentPolicy} from '../enterprise-control';
import {resolveSearchOwners} from '../compute-search/owners';
import {resolveExactControlSource} from './source';
import {readR1Responsibility} from './responsibility';
/** Versioned supplied-table review; preserves the learned owner context.
 * Only lawful original histories, observations and actions are projected.
 * Hidden-world selectors never enter this consumer view. */
export async function readExactControlReview(ctx:PeMutationContext,ref:ExperimentRef){
 const policy=await readEnterpriseContingentPolicy(ctx,ref),p=policy.exactProfile;if(!p)throw Error('R1_EXACT_POLICY_REVIEW_REQUIRED');
 const source=JSON.parse(p.modelBytes),e=p.evaluation;
 return {schema:'finnor.s4.exact-original-review.v1',policyRef:policy.ref,sourceRef:p.sourceRef,mandateRef:policy.mandateRef,
  rightsRef:policy.bindings.rightsRef,validUntil:policy.validUntil,knowledgeAt:policy.knowledgeAt,exactValue:e.values[e.root],utilityUnit:source.units.utility,moneyContext:source.units.money,
  originalChoices:Object.entries(e.optimalActions).map(([sid,actions])=>{const s=source.states.find((s:any)=>s.id===sid);return {period:s.period,actionHistory:s.history,observations:s.observations,optimalActions:actions,selectedAction:e.selectedActions[sid]??null};}),
  nodes:policy.nodes.map(n=>({id:n.id,period:n.period,actionHistory:n.actionHistory,observations:n.observations,actionId:n.actionId,branches:n.branches,alternatives:n.alternatives})),
  exactDemand:policy.demand.exact,assumptions:source.assumptions,limitations:policy.limitations,
  ownerChecks:{currentSource:true,currentPolicy:true,s5ReservationGrantedByReview:false,admission:policy.admission,causalQualification:'UNQUALIFIED',executionAuthorityGranted:false}};
}
export async function readR1Eligibility(ctx:PeMutationContext,workId:string,root:PeWorldRootRef){
 await authorize(ctx,root,[{type:'work',id:workId}]);
 const rows=await tx(ctx,async c=>(await c.query("SELECT q.id program_id,m.ref source_ref FROM finnor_os.p1_requests q JOIN finnor_os.r1_models m ON m.tenant_id=q.tenant_id AND m.principal_id=q.principal_id AND m.work_id=q.work_id AND m.work_input_id=q.work_input_id WHERE q.tenant_id=$1 AND q.principal_id=$2 AND q.work_id=$3 ORDER BY q.created_at DESC,m.created_at DESC LIMIT 17",[ctx.auth.tenantId,principal(ctx),workId])).rows,true);
 const candidates:any[]=[];
 for(const row of rows.slice(0,16)){
  const q=await requestRow(ctx,row.program_id);if(stable(q.request.root)!==stable(root))continue;
  try{
   if(runtimeEnvironment.NODE_ENV==='production'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')throw Error('R1_PROTECTED_DOMAIN_ADMISSION_AND_FUNDING_UNAVAILABLE');
   const responsibility=await readR1Responsibility(ctx);if(responsibility.unresolved.length||responsibility.hasMore)throw Error('R1_S6_OUTSTANDING_RESPONSIBILITY_RETAINED');
   if(['CANCELLED','INVALIDATED','FAILED','PARTIAL'].includes(q.status))throw Error('R1_ORIGINAL_PROGRAM_STOPPED');
   await assertProgramCurrent(ctx,q);const source=await resolveExactControlSource(ctx,row.source_ref),owners=q.request.ownerBindings;if(!owners?.policyRef||!owners.allocationRef)throw Error('R1_ORIGINAL_S4_S5_BINDINGS_UNAVAILABLE');
   const originalGrant=owners.allocationRef;
   const policy=await readEnterpriseContingentPolicy(ctx,owners.policyRef);
   if(policy.exactProfile?.modelDigest!==source.model_digest||stable(policy.mandateRef)!==stable(source.mandate.ref))throw Error('R1_SAME_ORIGINAL_EXACT_S4_INPUT_REQUIRED');
   const binding=await resolveSearchOwners(ctx,q,{schema:'finnor.compute-search-request.v1',programId:q.id,mode:'ordinary_disposable',policyRequest:owners.policyRef,computeGrant:owners.allocationRef,limits:{maxUnits:8,maxParallel:1},strategy:'FIXED_SEQUENTIAL',requestedKinds:[],routeIds:[],idempotencyKey:'r1-eligibility-read'});
   const state=await tx(ctx,async c=>{const episode=(await c.query('SELECT deadline_at,attempts_used,max_attempts FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[q.tenant_id,q.principal_id,q.episode_id])).rows[0],usage=(await c.query('SELECT spent FROM finnor_os.p2_grant_usage WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3 AND resource_id=$4',[q.tenant_id,q.principal_id,originalGrant.contentDigest,binding.resourceId])).rows[0];return {episode,used:Number(usage?.spent??0)};},true);
   if(!state.episode||state.episode.deadline_at.getTime()<=Date.now()||state.episode.attempts_used>=state.episode.max_attempts||state.used>=binding.capacity)throw Error('R1_ORIGINAL_EPISODE_OR_GRANT_EXHAUSTED');
   candidates.push({programId:q.id,workRevision:q.work_input_id,sourceRef:source.ref,policyRef:owners.policyRef,grantRef:owners.allocationRef,originalEpisode:q.episode_id,originalDeadlineAt:state.episode.deadline_at.toISOString(),remainingNativeAttempts:binding.capacity-state.used,
    state:'ELIGIBLE_ORDINARY_DEVELOPMENT',request:{schema:'finnor.r1.run.v1',problem_ref:source.ref,envelope_inputs:{programId:q.id,policyRequest:owners.policyRef,maxMathSteps:4000000},work_rev:q.work_input_id,domain:'finite-information-rational-v1',grant:owners.allocationRef,cancel:false}});
  }catch(error){candidates.push({programId:q.id,workRevision:q.work_input_id,state:'UNAVAILABLE',predicate:(error as Error).message.match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0]??'R1_CURRENT_OWNER_REQUIREMENT_UNPASSED'});}
 }
 await authorize(ctx,root,[{type:'work',id:workId}]);return {candidates,hasMore:rows.length>16,authority:false,domain:'finite-information-rational-v1',productionAdmissionAvailable:false};
}

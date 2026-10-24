/** Adapters into actual owners. No alternate policy, allocation or effect ledger. */
import type {PoolClient} from 'pg';
import type {CanonicalAllocationProblem,JointAllocationModel,ContingentPolicy,ExperimentRef,AllocationClearingInput} from '@finnor/shared-types';
import {AllocationOperationSchemas,allocationQuantity,allocationRef} from '../../../epistemic-runtime/src/allocation-contracts';
import {FinancialSemanticsSchema} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import {ControlConsumeSchema,AllocationConsumeSchema,ObligationConsumeSchema,ConfidentialGuardSchema,
 OutputBindingSchema,parse,quantity,sha,fail,type ConfidentialOutputBinding} from './contracts';
import {tx,computationTx,releaseTx,principal,eventTx} from './store';

export const RELEASE_OWNER='Y4_CONFIDENTIAL_RELEASE';
export const PLACEHOLDER_OWNER='Y4_OUTPUT_PLACEHOLDER';
export function confidentialReleaseRef(binding:ConfidentialOutputBinding,commitment:string):ExperimentRef{
 return {owner:RELEASE_OWNER,id:[binding.computationId,binding.releaseId,binding.output].join(':'),
  version:'y4-recipient-release-v1',contentDigest:commitment};
}
function fromRef(ref:ExperimentRef):ConfidentialOutputBinding{
 const [computationId,releaseId,...output]=ref.id.split(':');
 if(ref.owner!==RELEASE_OWNER||ref.version!=='y4-recipient-release-v1')fail('Y4_EXACT_RELEASE_REFERENCE_REQUIRED');
 return OutputBindingSchema.parse({computationId,releaseId,output:output.join(':')});
}
async function operand(ctx:PeMutationContext,c:PoolClient,binding:ConfidentialOutputBinding){
 const q=await computationTx(ctx,c,binding.computationId),release=await releaseTx(ctx,c,q,binding.releaseId),
  output=release.outputs.find(o=>o.key===binding.output);
 if(!output)fail('Y4_EXACT_RECIPIENT_OUTPUT_REQUIRED');
 return {q,release,output,ref:confidentialReleaseRef(binding,sha(release))};
}
export async function assertConfidentialGuard(ctx:PeMutationContext,raw:unknown,c?:PoolClient):Promise<void>{
 if(raw===undefined)return;
 const guard=ConfidentialGuardSchema.parse(raw);
 if(!c)return tx(ctx,client=>assertConfidentialGuard(ctx,guard,client));
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,5510))',[ctx.auth.tenantId]);
 const {output}=await operand(ctx,c,guard.binding);
 if(sha(output.semantics)!==sha(guard.semantics))fail('Y4_OWNER_GUARD_SEMANTICS_CHANGED');
 const value=allocationQuantity(quantity(output)),low=allocationQuantity(guard.minimum),high=allocationQuantity(guard.maximum);
 if(low.compare(high)>0||value.compare(low)<0||value.compare(high)>0)fail('Y4_RECIPIENT_DERIVED_GUARD_REFUSED');
}
/** Also called by native S5, including direct owner calls, replay and commit. */
export async function assertConfidentialAllocationCurrent(ctx:PeMutationContext,
 problem:Pick<CanonicalAllocationProblem,'jointModel'|'mandate'|'policies'>,c?:PoolClient):Promise<void>{
 const refs=problem.jointModel.sourceRefs.filter(r=>r.owner===RELEASE_OWNER);
 const terms=problem.jointModel.scenarios.flatMap(s=>s.terms).filter(t=>t.evidenceRef.owner===RELEASE_OWNER);
 if(!refs.length&&!terms.length)return;
 if(refs.length>16||!refs.length||terms.some(t=>!refs.some(r=>sha(r)===sha(t.evidenceRef))))
  fail('Y4_COMPLETE_CONFIDENTIAL_JOINT_BINDINGS_REQUIRED');
 if(!c)return tx(ctx,client=>assertConfidentialAllocationCurrent(ctx,problem,client));
 // Match Y4 revocation's existing S1-mutex-before-computation-row ordering.
 // Taking the row first can deadlock a concurrent source/consent revocation.
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,5510))',[ctx.auth.tenantId]);
 for(const ref of refs){
  const {q,output,ref:actual}=await operand(ctx,c,fromRef(ref)),s=FinancialSemanticsSchema.parse(output.semantics);
  if(sha(actual)!==sha(ref)||s.unit!=='currency'||s.currencyCode!==problem.mandate.utility.unit
   ||sha(q.request.function.jointSemanticsRef)!==sha(problem.mandate.utility.accountingConventionRef)
   ||Date.parse(s.periodStart)>Date.parse(problem.mandate.horizon.startAt)
   ||Date.parse(s.periodEnd)<Date.parse(problem.mandate.horizon.startAt)+problem.mandate.horizon.periodMs*problem.mandate.horizon.periods
   ||!problem.policies.length||problem.policies.some(p=>!p.bindings.beliefPins.some(pin=>
    pin.root.entityType===s.entityType&&pin.root.entityId===s.entityId)))
   fail('Y4_ORIGINAL_JOINT_VALUE_ENTITY_PERIOD_CURRENCY_OR_TERMS_MISMATCH');
  const bound=terms.filter(t=>sha(t.evidenceRef)===sha(ref));
  if(!bound.length||bound.some(t=>t.value!==quantity(output)))fail('Y4_EXACT_NATIVE_JOINT_VALUE_REQUIRED');
  allocationQuantity(quantity(output));
 }
}
export async function consumeConfidentialControl(ctx:PeMutationContext,raw:unknown){
 const input=parse(ControlConsumeSchema,raw);
 const {chooseEnterpriseControlBranch}=await import('../enterprise-control');
 return chooseEnterpriseControlBranch(ctx,input);
}
export async function consumeConfidentialAllocation(ctx:PeMutationContext,raw:unknown){
 const {input:rawInput,bindings}=parse(AllocationConsumeSchema,raw),
  input=AllocationOperationSchemas.clear.parse(rawInput) as AllocationClearingInput,
  joint=structuredClone(input.jointModel) as JointAllocationModel;
 const seen=new Set<string>();
 await tx(ctx,async c=>{
  for(const item of bindings){
   const identity=item.scenarioId+':'+item.termIndex;
   if(seen.has(identity))fail('Y4_DUPLICATE_NATIVE_TERM_BINDING');seen.add(identity);
   const term=joint.scenarios.find(s=>s.id===item.scenarioId)?.terms[item.termIndex],
    {output,ref}=await operand(ctx,c,item.binding);
   if(!term||term.value!=='0'||term.evidenceRef.owner!==PLACEHOLDER_OWNER
    ||term.evidenceRef.id!==[item.binding.computationId,item.binding.releaseId,item.binding.output].join(':')
    ||sha(output.semantics)!==sha(item.semantics))fail('Y4_EXPLICIT_UNBOUND_JOINT_TERM_REQUIRED');
   term.value=quantity(output);term.evidenceRef=ref;
   if(!joint.sourceRefs.some(r=>sha(r)===sha(ref)))joint.sourceRefs.push(ref);
  }
  if(joint.scenarios.some(s=>s.terms.some(t=>t.evidenceRef.owner===PLACEHOLDER_OWNER)))
   fail('Y4_ALL_NATIVE_VALUE_PLACEHOLDERS_REQUIRED');
 });
 const {ref:_,...body}=joint;
 joint.ref=allocationRef('BUSINESS_OWNER','joint-allocation-model',body,
  joint.schema==='finnor.joint-allocation-model.exact.v2'?'s5-joint-model-exact-v2':'s5-joint-model-v1');
 const {clearEnterprisePortfolio}=await import('../enterprise-allocation');
 return clearEnterprisePortfolio(ctx,{...input,jointModel:joint});
}
export async function consumeConfidentialObligation(ctx:PeMutationContext,raw:unknown){
 const input=parse(ObligationConsumeSchema,raw);
 await tx(ctx,async c=>{
  const {q}=await operand(ctx,c,input.confidentialGuard.binding);
  if(q.work_id!==input.workId)fail('Y4_ORIGINAL_OBLIGATION_WORK_REQUIRED');
 });
 const {prepareEnterpriseContingentHandoff}=await import('../enterprise-control');
 const handoff=await prepareEnterpriseContingentHandoff(ctx,input);
 if(!handoff.preparationRef||!handoff.consumptionRef)fail('Y4_ACTUAL_S4_S5_HANDOFF_REQUIRED');
 const {prepareEnterpriseDurableObligation}=await import('../enterprise-obligations');
 // This original Work authorizes analysis, not an action PlanNode. Retain its
 // provenance in Y4; never misrepresent it as S6 execution lineage.
 const obligation=await prepareEnterpriseDurableObligation(ctx,{preparationRef:handoff.preparationRef,
  allocationRef:input.allocationRef,consumptionRef:handoff.consumptionRef});
 await tx(ctx,async c=>{
  const {q}=await operand(ctx,c,input.confidentialGuard.binding);
  await eventTx(c,q,principal(ctx),'NATIVE_S4_S5_S6_PREPARED','obligation:'+obligation.ref.contentDigest,
   {policyRef:handoff.policyRef,allocationRef:input.allocationRef,obligationRef:obligation.ref,
    originalAnalysisWorkId:input.workId,
    executionAuthorityGranted:false,dispatchGranted:false});
 });
 return {handoff,obligation,executionAuthorityGranted:false,dispatchGranted:false};
}

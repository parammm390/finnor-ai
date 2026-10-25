import type {PoolClient} from 'pg';
import {attachWorkEntity} from '@finnor/db';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import {compileUnderwritingModel,decimal,runResultHash,type ResolvedInput,type UnderwritingModelIR,type UnderwritingInputSnapshot,type UnderwritingRunResult} from '@finnor/underwriting';
import {FinancialSemanticsSchema} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import {authorizeBeliefResources} from '../enterprise-beliefs';
import {createUnderwritingRun} from '../underwriting-repository';
import {ConsumeSchema,OutputBindingSchema,parse,sha,quantity,fail,type ConfidentialOutputBinding} from './contracts';
import {tx,computationTx,releaseTx,eventTx,allCurrentTx} from './store';

export function hasConfidentialSnapshot(snapshot:UnderwritingInputSnapshot):boolean{
 return Object.values(snapshot.values).some(value=>value.provenance.some(ref=>ref.kind==='confidential_computation'));
}
export function sealConfidentialRunResult(snapshot:UnderwritingInputSnapshot,result:UnderwritingRunResult):UnderwritingRunResult{
 if(!hasConfidentialSnapshot(snapshot))return result;
 if(runResultHash(result)!==result.resultSemanticHash||!snapshot.confidentialCommitmentSalt)
  fail('Y4_EXACT_CONSUMER_RESULT_AND_PRIVATE_HIDING_CONTEXT_REQUIRED');
 if(result.confidentialCommitmentSalt&&result.confidentialCommitmentSalt!==snapshot.confidentialCommitmentSalt)
  fail('Y4_CONSUMER_HIDING_CONTEXT_CHANGED');
 const body={...result,confidentialCommitmentSalt:snapshot.confidentialCommitmentSalt};
 return Object.freeze({...body,resultSemanticHash:runResultHash(body)});
}
export function refuseUnadmittedConfidentialSink(snapshot:UnderwritingInputSnapshot):void{
 if(hasConfidentialSnapshot(snapshot))fail('Y4_RECIPIENT_SCOPED_DISCLOSURE_OWNER_NOT_ADMITTED');
}
export async function resolveConfidentialUnderwritingInputs(ctx:PeMutationContext,investmentCaseId:string,modelVersionId:string,
 bindings:Readonly<Record<string,ConfidentialOutputBinding>>):Promise<Record<string,ResolvedInput>>{
 if(!Object.keys(bindings).length)return {};
 if(Object.keys(bindings).length>16)fail('Y4_CONSUMER_INPUT_BOUND');
 return tx(ctx,async c=>{
  await authorizeBeliefResources(ctx,[{type:'pe_investment_case',id:investmentCaseId}],c);
  const model=(await c.query<{definition:UnderwritingModelIR;target:string}>(`SELECT v.model_definition definition,d.target_organization_id::text target
   FROM finnor_os.underwriting_model_versions v JOIN finnor_os.pe_investment_cases i ON i.tenant_id=v.tenant_id AND i.id=v.investment_case_id
   JOIN finnor_os.pe_deals d ON d.tenant_id=i.tenant_id AND d.id=i.deal_id
   WHERE v.tenant_id=$1 AND v.investment_case_id=$2 AND v.id=$3`,
  [ctx.auth.tenantId,investmentCaseId,modelVersionId])).rows[0];
  if(!model)fail('Y4_EXACT_CONSUMER_MODEL_UNAVAILABLE');
  const compiled=compileUnderwritingModel(model.definition),resolved:Record<string,ResolvedInput>={};
  for(const [nodeId,raw] of Object.entries(bindings)){
   const binding=OutputBindingSchema.parse(raw),node=compiled.nodeById[nodeId];
   if(!node||node.kind!=='input'||node.shape!=='scalar'||node.valueType!=='decimal'
    ||node.source&&!['explicit','model_parameter'].includes(node.source.kind))fail('Y4_NO_BOUND_OR_NONSCALAR_INPUT_SHADOWING');
   const expected=FinancialSemanticsSchema.parse(node.evidenceSemantics);
   if(expected.entityType!=='external_organization'||expected.entityId!==model.target)fail('Y4_CONSUMER_TARGET_ENTITY_MISMATCH');
   const q=await computationTx(ctx,c,binding.computationId),release=await releaseTx(ctx,c,q,binding.releaseId);
   const output=release.outputs.find(o=>o.key===binding.output);
   if(!output||sha(output.semantics)!==sha(expected))fail('Y4_CONSUMER_ENTITY_PERIOD_SCOPE_MISMATCH');
   const unit=output.semantics.unit==='currency'?'money':output.semantics.unit;
   if(node.unit!==unit||node.currency!==(output.semantics.currencyCode??undefined))fail('Y4_CONSUMER_DIMENSION_MISMATCH');
   if(node.allowedTruthClasses&&!node.allowedTruthClasses.includes('DERIVED_VALUE'))fail('Y4_CONSUMER_DERIVED_TRUTH_CLASS_REFUSED');
   const value=quantity(output);
   if(value.replace(/[-.]/g,'').replace(/^0+/,'').length>34)fail('Y4_EXISTING_CONSUMER_PRECISION_DOMAIN_EXCEEDED');
   resolved[nodeId]={nodeId,valueType:'decimal',unit:node.unit,...(node.currency?{currency:node.currency}:{}),
    shape:'scalar',value,truthClass:'DERIVED_VALUE',status:'KNOWN',
    confidentialCommitmentSalt:sha({schema:'finnor.y4.recipient-consumer-hiding.v1',nonce:release.releaseNonce}),
    provenance:[{kind:'confidential_computation',id:q.id,versionId:release.releaseId,anchorId:output.key,semanticHash:sha(release),
     effectiveAt:output.semantics.periodEnd}],
    reason:'RECIPIENT_AUTHORIZED_CONFIDENTIAL_DERIVED_VALUE_NOT_SOURCE_TRUTH_OR_ADMISSION'};
  }
  return resolved;
 });
}
/** Called by the existing immutable Run/IC read and write boundaries. Other
 * recipients cannot inherit a grant merely by reading a shared run ID. */
export async function assertConfidentialSnapshotCurrent(ctx:PeMutationContext,snapshot:UnderwritingInputSnapshot,c?:PoolClient,lock=false):Promise<void>{
 return assertConfidentialInputsCurrent(ctx,Object.values(snapshot.values),c,lock);
}
export async function assertConfidentialInputsCurrent(ctx:PeMutationContext,inputs:readonly ResolvedInput[],c?:PoolClient,lock=false):Promise<void>{
 const refs=inputs.flatMap(input=>input.provenance.filter(ref=>ref.kind==='confidential_computation').map(ref=>({input,ref})));
 if(!refs.length)return;
 if(!c)return tx(ctx,client=>assertConfidentialInputsCurrent(ctx,inputs,client,true));
 if(lock)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['v3-material-cut:'+ctx.auth.tenantId]);
 await employeeAuthoritySnapshotTx(ctx.auth,c,lock);
 if(lock)await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,5510))',[ctx.auth.tenantId]);
 for(const {input,ref} of refs){
  const q=await computationTx(ctx,c,ref.id,'query',lock),release=await releaseTx(ctx,c,q,ref.versionId??'',lock);
  const output=release.outputs.find(o=>o.key===ref.anchorId);
  if(!output||input.truthClass!=='DERIVED_VALUE'||input.status!=='KNOWN'||decimal(quantity(output))!==input.value
   ||ref.semanticHash!==sha(release)
   ||input.confidentialCommitmentSalt!==sha({schema:'finnor.y4.recipient-consumer-hiding.v1',nonce:release.releaseNonce}))
   fail('Y4_CONSUMER_PROVENANCE_OR_CURRENTNESS_FAILED');
 }
}
export async function consumeConfidentialUnderwriting(ctx:PeMutationContext,value:unknown){
 const input=parse(ConsumeSchema,value);
 await tx(ctx,async c=>{
  await authorizeBeliefResources(ctx,[{type:'pe_investment_case',id:input.investmentCaseId},{type:'work',id:input.workId}],c);
  for(const binding of Object.values(input.bindings)){
   const q=await computationTx(ctx,c,binding.computationId);await releaseTx(ctx,c,q,binding.releaseId);
   if(q.work_id!==input.workId)fail('Y4_CONSUMER_ORIGINAL_WORK_REQUIRED');
  }
 });
 const result=await createUnderwritingRun(ctx,{investmentCaseId:input.investmentCaseId,modelVersionId:input.modelVersionId,
  worldAt:input.worldAt,idempotencyKey:input.idempotencyKey,workId:input.workId,confidentialInputs:input.bindings});
 if(result.result.status!=='SUCCEEDED'||result.result.validity!=='VALID')
  fail('Y4_NATIVE_CONSUMER_DID_NOT_ACCEPT');
 await attachWorkEntity(ctx.auth.tenantId,input.workId,{entityType:'pe_investment_case',entityId:input.investmentCaseId,source:'Y4:recipient-authorized-derived-input'});
 await tx(ctx,async(c,db)=>{
  for(const id of new Set(Object.values(input.bindings).map(b=>b.computationId))){
   const q=await computationTx(ctx,c,id);
   await allCurrentTx(ctx,c,q);
   await eventTx(c,q,ctx.auth.employeeId??ctx.auth.userId,'NATIVE_UNDERWRITING_CONSUMED','underwriting:'+result.id,
    {runId:result.id,investmentCaseId:input.investmentCaseId,truthClass:'DERIVED_VALUE',protectedAdmission:false,executionAuthorityGranted:false});
   const {workRevisionRef:_,...definition}=q.request.function;
   // allCurrentTx above already verifies any completed original plan/proof.
   // A replay reads that terminal outcome; it must not reopen its objective.
   const plan=(await c.query('SELECT status FROM finnor_os.work_plan_revisions WHERE tenant_id=$1 AND id=$2',
    [q.tenant_id,q.request.function.workRevisionRef.id])).rows[0];
   if(plan?.status==='active')await (await import('../../../orchestration/src/objective-loop')).schedulePreparedConfidentialObjectiveTx(db,{
     tenantId:q.tenant_id,workId:q.work_id,planRevisionId:q.request.function.workRevisionRef.id,
     computationId:q.id,definitionDigest:sha(definition)});
   else if(plan?.status!=='completed')fail('Y4_ORIGINAL_CONSUMER_PLAN_FENCED');
  }
 });
 return {...result,workId:input.workId,executionAuthorityGranted:false};
}

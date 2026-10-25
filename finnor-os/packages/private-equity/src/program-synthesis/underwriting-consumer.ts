import {compileUnderwritingModel,type ResolvedInput,type UnderwritingModelIR} from '@finnor/underwriting';
import {FinancialSemanticsSchema} from '@finnor/shared-types';
import type {PoolClient} from 'pg';
import {PeDomainError,type PeMutationContext} from '../types';
import {authorizeBeliefResources} from '../enterprise-beliefs';
import {stable,tx} from '../evidence-execution/store';
import {currentCheckedHarnessProgram} from './store';

async function current(ctx:PeMutationContext,id:string,c?:PoolClient,lock=false){
 try{return await currentCheckedHarnessProgram(ctx,id,c,lock);}
 catch(error){
  if(error instanceof Error&&['CURRENT_CHECKED_HARNESS_REQUIRED','EXACT_WORK_REVISION_CHANGED','CANONICAL_PLAN_REVISION_SUPERSEDED','PROGRAM_RUNTIME_SOURCE_CHANGED','PROGRAM_SCHEMA_CHANGED','SOURCE_RIGHTS_MEMBERSHIP_OR_WORK_CHANGED','DERIVATION_NOT_CURRENT_COMPLETE_TESTED','DERIVATION_RUNTIME_CHANGED','DERIVATION_SCHEMA_CHANGED','ACQUISITION_ANALYSIS_PARENT_CHANGED','ACQUISITION_ANALYSIS_PARENT_PLAN_UNAVAILABLE'].includes(error.message))throw new PeDomainError('STALE_EVIDENCE_DERIVATION','STALE_EVIDENCE_DERIVATION');
  throw error;
 }
}
/** Only a current, independently checked P1 producer can supply this truth
 * class. Public explicit inputs cannot manufacture harness provenance. */
export async function resolveHarnessUnderwritingInputs(ctx:PeMutationContext,input:{investmentCaseId:string;modelVersionId:string;programId:string;workId:string;workInputId:string;bindings:Record<string,string>}){
 await authorizeBeliefResources(ctx,[{type:'pe_investment_case',id:input.investmentCaseId}]);
 const model=await tx(ctx,async c=>(await c.query<{definition:UnderwritingModelIR;target:string;deal_id:string}>(`SELECT v.model_definition definition,d.target_organization_id::text target,d.id::text deal_id FROM finnor_os.underwriting_model_versions v
  JOIN finnor_os.pe_investment_cases i ON i.tenant_id=v.tenant_id AND i.id=v.investment_case_id JOIN finnor_os.pe_deals d ON d.tenant_id=i.tenant_id AND d.id=i.deal_id
  WHERE v.tenant_id=$1 AND v.investment_case_id=$2 AND v.id=$3`,[ctx.auth.tenantId,input.investmentCaseId,input.modelVersionId])).rows[0],true);
 if(!model)throw Error('EXACT_CONSUMER_MODEL_UNAVAILABLE');
 const {q,program}=await current(ctx,input.programId),compiled=compileUnderwritingModel(model.definition),resolved:Record<string,ResolvedInput>={};
 if(q.work_id!==input.workId||q.work_input_id!==input.workInputId||q.request.root.entityType!=='pe_deal'||q.request.root.entityId!==model.deal_id)throw Error('HARNESS_CONSUMER_WORK_OR_DEAL_MISMATCH');
 for(const [nodeId,key] of Object.entries(input.bindings)){
  const node=compiled.nodeById[nodeId],output=program.result!.values[key];
  if(!node||node.kind!=='input'||node.shape!=='scalar'||node.valueType!=='decimal'||node.source&&!['explicit','model_parameter'].includes(node.source.kind))throw Error('HARNESS_CANNOT_SHADOW_BOUND_OR_NONSCALAR_INPUT');
  const expected=FinancialSemanticsSchema.parse(node.evidenceSemantics);
  if(!output||output.truthClass!=='DERIVED_VALUE'||stable(output.semantics)!==stable(expected)||expected.entityType!=='external_organization'||expected.entityId!==model.target)throw Error('HARNESS_CONSUMER_ENTITY_PERIOD_UNIT_SCOPE_MISMATCH');
  if(node.unit!==(expected.unit==='currency'?'money':expected.unit)||node.currency!==(expected.currencyCode??undefined)||node.allowedTruthClasses&&!node.allowedTruthClasses.includes('DERIVED_VALUE'))throw Error('HARNESS_CONSUMER_UNIT_OR_TRUTH_CLASS_MISMATCH');
  if(output.value.replace(/[-.]/g,'').replace(/^0+/,'').length>34)throw Error('EXISTING_UNDERWRITING_ENGINE_PRECISION_DOMAIN_EXCEEDED');
  resolved[nodeId]={nodeId,valueType:'decimal',unit:node.unit,...(node.currency?{currency:node.currency}:{}),shape:'scalar',value:output.value,truthClass:'DERIVED_VALUE',status:'KNOWN',provenance:[{kind:'harness_program',id:q.id,versionId:q.head_id!,anchorId:key,semanticHash:program.result!.digest,effectiveAt:program.validAt,observedAt:program.knowledgeAt}],reason:'CURRENT_CHECKED_P1_ANALYSIS_NOT_OBSERVED_FACT_OR_ECONOMIC_ADMISSION'};
 }
 return {resolved,resultDigest:program.result!.digest};
}
export async function assertHarnessInputsCurrent(ctx:PeMutationContext,inputs:readonly ResolvedInput[],c?:PoolClient,lock=false){
 const checked=new Map<string,Awaited<ReturnType<typeof current>>>();
 for(const input of inputs)for(const ref of input.provenance.filter(p=>p.kind==='harness_program')){
  let producer=checked.get(ref.id);if(!producer){producer=await current(ctx,ref.id,c,lock);checked.set(ref.id,producer);}
  const {q,program}=producer,output=program.result!.values[ref.anchorId??''];
  if(!output||input.value!==output.value||input.truthClass!=='DERIVED_VALUE'||input.status!=='KNOWN'||q.head_id!==ref.versionId||ref.semanticHash!==program.result!.digest)throw Error('HARNESS_CONSUMER_PROVENANCE_OR_CURRENTNESS_FAILED');
 }
}

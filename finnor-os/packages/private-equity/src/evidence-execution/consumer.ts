import {z} from 'zod';
import {attachWorkEntity} from '@finnor/db';
import {compileUnderwritingModel,type ResolvedInput,type UnderwritingInputSnapshot,type UnderwritingModelIR} from '@finnor/underwriting';
import {FinancialSemanticsSchema,type FinancialSemantics} from '@finnor/shared-types';
import type {PoolClient} from 'pg';
import {createUnderwritingRun} from '../underwriting-repository';
import type {PeMutationContext} from '../types';
import {authorizeBeliefResources} from '../enterprise-beliefs';
import {assertDependencies,authorize,currentDerivation,sha,stable,tx} from './store';
export const EvidenceUnderwritingBindingSchema=z.object({derivationId:z.string().uuid(),output:z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)}).strict();
export type EvidenceUnderwritingBinding=z.infer<typeof EvidenceUnderwritingBindingSchema>;
export async function resolveEvidenceUnderwritingInputs(ctx:PeMutationContext,investmentCaseId:string,modelVersionId:string,bindings:Readonly<Record<string,EvidenceUnderwritingBinding>>):Promise<Record<string,ResolvedInput>>{
 if(!Object.keys(bindings).length)return {};if(Object.keys(bindings).length>16)throw Error('DERIVATION_CONSUMER_INPUT_BOUND');
 await authorizeBeliefResources(ctx,[{type:'pe_investment_case',id:investmentCaseId}]);
 const model=await tx(ctx,async c=>(await c.query<{definition:UnderwritingModelIR;target:string}>(`SELECT v.model_definition definition,d.target_organization_id::text target FROM finnor_os.underwriting_model_versions v
  JOIN finnor_os.pe_investment_cases i ON i.tenant_id=v.tenant_id AND i.id=v.investment_case_id JOIN finnor_os.pe_deals d ON d.tenant_id=i.tenant_id AND d.id=i.deal_id
  WHERE v.tenant_id=$1 AND v.investment_case_id=$2 AND v.id=$3`,[ctx.auth.tenantId,investmentCaseId,modelVersionId])).rows[0],true);if(!model)throw Error('EXACT_CONSUMER_MODEL_UNAVAILABLE');const compiled=compileUnderwritingModel(model.definition),resolved:Record<string,ResolvedInput>={};
 for(const [nodeId,raw] of Object.entries(bindings)){const binding=EvidenceUnderwritingBindingSchema.parse(raw),node=compiled.nodeById[nodeId];if(!node||node.kind!=='input'||node.shape!=='scalar'||node.valueType!=='decimal'||node.source&&!['explicit','model_parameter'].includes(node.source.kind))throw Error('DERIVATION_CANNOT_SHADOW_BOUND_OR_NONSCALAR_INPUT');
  const expected=FinancialSemanticsSchema.parse(node.evidenceSemantics);if(expected.entityType!=='external_organization'||expected.entityId!==model.target)throw Error('CONSUMER_MODEL_TARGET_ENTITY_MISMATCH');
  const derivation=await currentDerivation(ctx,binding.derivationId),output=derivation.result?.outputs[binding.output];if(!output||output.kind!=='scalar'||output.value===null||!output.semantics||stable(output.semantics)!==stable(expected))throw Error('DERIVATION_CONSUMER_ENTITY_PERIOD_UNIT_SCOPE_MISMATCH');
  const unit=output.semantics.unit==='currency'?'money':output.semantics.unit;if(node.unit!==unit||node.currency!==(output.semantics.currencyCode??undefined))throw Error('DERIVATION_CONSUMER_UNIT_CURRENCY_MISMATCH');
  if(node.allowedTruthClasses&&!node.allowedTruthClasses.includes('DERIVED_VALUE'))throw Error('CONSUMER_MODEL_DERIVED_TRUTH_CLASS_REFUSED');
  if(output.value.replace(/[-.]/g,'').replace(/^0+/,'').length>34)throw Error('EXISTING_UNDERWRITING_ENGINE_PRECISION_DOMAIN_EXCEEDED');
  resolved[nodeId]={nodeId,valueType:'decimal',unit:node.unit,...(node.currency?{currency:node.currency}:{}),shape:'scalar',value:output.value,truthClass:'DERIVED_VALUE',status:'KNOWN',provenance:[{kind:'evidence_derivation',id:derivation.id,versionId:derivation.id,anchorId:binding.output,semanticHash:derivation.result!.digest,effectiveAt:derivation.validAt,observedAt:derivation.knowledgeAt}],reason:'EXACT_TESTED_P4_DERIVATION_NOT_OBSERVED_FACT_OR_ADMISSION'};
 }
 return resolved;
}
export async function assertEvidenceSnapshotCurrent(ctx:PeMutationContext,snapshot:UnderwritingInputSnapshot,client?:PoolClient,lock=false){
 for(const input of Object.values(snapshot.values))for(const ref of input.provenance.filter(r=>r.kind==='evidence_derivation')){
  const derivation=await currentDerivation(ctx,ref.id),output=derivation.result?.outputs[ref.anchorId??''];if(!output||output.kind!=='scalar'||output.value!==input.value||input.truthClass!=='DERIVED_VALUE'||input.status!=='KNOWN'||ref.semanticHash!==derivation.result?.digest)throw Error('DERIVATION_CONSUMER_PROVENANCE_OR_CURRENTNESS_FAILED');
  if(client)await assertDependencies(ctx,derivation.invalidationKeys,client,lock);
 }
}
/** For existing IC transaction helpers without a context parameter, use only
 * the principal already bound by Core withTenantTransaction. Legacy runs have
 * no P4 dependency and keep their existing behavior. */
export async function assertEvidenceRunTransactionCurrent(client:PoolClient,tenantId:string,runId:string){
 const row=(await client.query<{input_snapshot:UnderwritingInputSnapshot}>('SELECT input_snapshot FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2',[tenantId,runId])).rows[0];
 if(!row||!Object.values(row.input_snapshot.values).some(v=>v.provenance.some(p=>p.kind==='evidence_derivation')))return false;
 const identity=(await client.query<{id:string;role:string;status:string}>("SELECT id::text,role,status FROM finnor_os.users WHERE tenant_id=$1 AND id=NULLIF(current_setting('app.user_id',true),'')::uuid",[tenantId])).rows[0];
 if(!identity||identity.status!=='active'||identity.role!=='owner')throw Error('CURRENT_AUTHENTICATED_PRINCIPAL_UNAVAILABLE');
 await assertEvidenceSnapshotCurrent({auth:{tenantId,userId:identity.id,employeeId:identity.id,role:'owner'},provenance:{sourceSystem:'P4:existing-consumer-currentness',createdBy:identity.id}},row.input_snapshot,client,true);return true;
}
export async function consumeEvidenceUnderwriting(ctx:PeMutationContext,body:unknown){const request=z.object({investmentCaseId:z.string().uuid(),modelVersionId:z.string().uuid(),worldAt:z.string().datetime({offset:true}),idempotencyKey:z.string().min(1).max(200),workId:z.string().uuid().optional(),bindings:z.record(EvidenceUnderwritingBindingSchema)}).strict().parse(body);
 const derivations=await Promise.all(Object.values(request.bindings).map(binding=>currentDerivation(ctx,binding.derivationId))),workIds=[...new Set(derivations.map(d=>d.work.id))];
 if(workIds.length!==1||request.workId&&request.workId!==workIds[0])throw Error('DERIVATION_CONSUMER_WORK_SCOPE_MISMATCH');const workId=workIds[0]!;
 await authorizeBeliefResources(ctx,[{type:'work',id:workId},{type:'pe_investment_case',id:request.investmentCaseId}]);
 const run=await createUnderwritingRun(ctx,{investmentCaseId:request.investmentCaseId,modelVersionId:request.modelVersionId,worldAt:request.worldAt,idempotencyKey:request.idempotencyKey,workId,evidenceDerivationInputs:request.bindings});
 // Underwriting owns the immutable run's existing work_id foreign key. Core
 // links only its already registered investment-case type; no new owner type.
 await attachWorkEntity(ctx.auth.tenantId,workId,{entityType:'pe_investment_case',entityId:request.investmentCaseId,source:'P4:typed-evidence-consumer'});
 return {...run,workId};
}

import {compileUnderwritingModel,type UnderwritingInputSnapshot,type UnderwritingModelIR,type UnderwritingRunResult} from '@finnor/underwriting';
import {FinancialSemanticsSchema,type EvidenceSource,type EvidenceWitness,type FinancialRow} from '@finnor/shared-types';
import {getUnderwritingRun} from '../underwriting-repository';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {authorize,currentDerivation,revisions,sha,stable,tx,unavailable} from './store';
import {canonicalExact} from './exact';
type ModelSource=Extract<EvidenceSource,{kind:'model'}>;
/** This registered domain is an existing immutable scalar OutputNode directly
 * referencing a current P4-backed InputNode with owner-authored semantics.
 * General model/forecast meanings are not inferred from names or timestamps. */
export async function readModelSource(ctx:PeMutationContext,source:ModelSource,times:{knowledgeAt:string;validAt:string}){
 await authorize(ctx,source.subject as PeWorldRootRef);
 const stored=await tx(ctx,async c=>(await c.query<{investment_case_id:string;deal_id:string;target:string;work_id:string|null;world_at:Date;computed_at:Date;created_at:Date;run_commit:Date|null;version_commit:Date|null;tracked:boolean;definition:UnderwritingModelIR;model_hash:string;input_hash:string;result_hash:string;input_snapshot:UnderwritingInputSnapshot;result:UnderwritingRunResult}>(`SELECT r.investment_case_id::text,i.deal_id::text,d.target_organization_id::text target,r.work_id::text,r.world_at,r.computed_at,v.created_at,
 pg_xact_commit_timestamp(r.xmin) run_commit,pg_xact_commit_timestamp(v.xmin) version_commit,current_setting('track_commit_timestamp')='on' tracked,
 v.model_definition definition,v.semantic_hash model_hash,r.input_hash,r.result_hash,r.input_snapshot,r.result
 FROM finnor_os.underwriting_runs r JOIN finnor_os.underwriting_model_versions v ON v.tenant_id=r.tenant_id AND v.id=r.model_version_id
 JOIN finnor_os.pe_investment_cases i ON i.tenant_id=r.tenant_id AND i.id=r.investment_case_id JOIN finnor_os.pe_deals d ON d.tenant_id=i.tenant_id AND d.id=i.deal_id
 WHERE r.tenant_id=$1 AND r.id=$2 AND r.model_version_id=$3`,[ctx.auth.tenantId,source.runId,source.modelVersionId])).rows[0],true);
 if(!stored||source.subject.entityType!=='external_organization'||stored.target!==source.subject.entityId)throw unavailable();
 await authorize(ctx,source.subject as PeWorldRootRef,[{type:'pe_investment_case',id:stored.investment_case_id},{type:'pe_deal',id:stored.deal_id},...(stored.work_id?[{type:'work',id:stored.work_id}]:[])]);
 const cut=Date.parse(times.knowledgeAt);if(!stored.tracked||!stored.run_commit||!stored.version_commit||stored.run_commit.getTime()>cut||stored.version_commit.getTime()>cut||stored.computed_at.getTime()>cut||stored.created_at.getTime()>cut)throw Error('MODEL_IMMUTABLE_COMMIT_VISIBILITY_UNAVAILABLE');
 const ownerScope=await tx(ctx,async c=>(await c.query<{entity_type:string;entity_id:string;entity_version:number;snapshot_hash:string;snapshot:Record<string,unknown>}>(`SELECT DISTINCT ON(entity_type,entity_id) entity_type,entity_id::text,entity_version,snapshot_hash,snapshot
 FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND ((entity_type='pe_investment_case' AND entity_id=$2) OR (entity_type='pe_deal' AND entity_id=$3))
 AND recorded_at<=$4 AND pg_xact_commit_timestamp(xmin)<=$4 ORDER BY entity_type,entity_id,recorded_at DESC,entity_version DESC`,[ctx.auth.tenantId,stored.investment_case_id,stored.deal_id,times.knowledgeAt])).rows,true);
 const historicalCase=ownerScope.find(v=>v.entity_type==='pe_investment_case'),historicalDeal=ownerScope.find(v=>v.entity_type==='pe_deal');
 if(ownerScope.length!==2||historicalCase?.snapshot.deal_id!==stored.deal_id||historicalDeal?.snapshot.target_organization_id!==source.subject.entityId)throw Error('MODEL_OWNER_IDENTITY_KNOWLEDGE_VISIBILITY_UNAVAILABLE');
 if(stored.world_at.getTime()>Date.parse(times.validAt))throw Error('MODEL_BUSINESS_CLOCK_OUTSIDE_REQUEST');
 await getUnderwritingRun(ctx,source.runId); // Existing owner verifies exact input/result hashes and current P4 basis.
 const compiled=compileUnderwritingModel(stored.definition);if(compiled.semanticHash!==stored.model_hash)throw Error('MODEL_SOURCE_SEMANTIC_HASH_MISMATCH');
 const outputNode=compiled.nodeById[source.output];if(!outputNode||outputNode.kind!=='output'||outputNode.shape!=='scalar'||outputNode.valueType!=='decimal')throw Error('MODEL_SOURCE_REGISTERED_SCALAR_OUTPUT_REQUIRED');
 const inputNode=compiled.nodeById[outputNode.sourceNodeId];if(!inputNode||inputNode.kind!=='input'||inputNode.shape!=='scalar'||inputNode.valueType!=='decimal')throw Error('MODEL_SOURCE_OWNER_FINANCIAL_SEMANTICS_UNAVAILABLE');
 const semantics=FinancialSemanticsSchema.parse(inputNode.evidenceSemantics),input=stored.input_snapshot.values[inputNode.id],output=stored.result.outputs[source.output];
 const basis=input?.provenance.filter(p=>p.kind==='evidence_derivation')??[];
 if(stored.result.status!=='SUCCEEDED'||stored.result.validity!=='VALID'||!input||input.status!=='KNOWN'||input.truthClass!=='DERIVED_VALUE'||!basis.length||!output||output.truthClass!=='DERIVED_VALUE'||typeof output.value!=='string'||typeof input.value!=='string'||canonicalExact(output.value)!==canonicalExact(input.value))throw Error('MODEL_CURRENT_DERIVED_OUTPUT_UNAVAILABLE');
 const unit=semantics.unit==='currency'?'money':semantics.unit;if(semantics.entityType!==source.subject.entityType||semantics.entityId!==source.subject.entityId||inputNode.unit!==unit||outputNode.unit!==unit||inputNode.currency!==(semantics.currencyCode??undefined)||outputNode.currency!==(semantics.currencyCode??undefined))throw Error('MODEL_OUTPUT_ENTITY_UNIT_CURRENCY_MISMATCH');
 const parents=await Promise.all(basis.map(ref=>currentDerivation(ctx,ref.id)));for(let i=0;i<parents.length;i++){const parent=parents[i]!,ref=basis[i]!,value=parent.result?.outputs[ref.anchorId??''];if(!value||value.kind!=='scalar'||value.value!==input.value||stable(value.semantics)!==stable(semantics)||ref.semanticHash!==parent.result?.digest)throw Error('MODEL_SOURCE_CURRENT_TYPED_INPUT_MISMATCH');}
 const value=canonicalExact(output.value),id=`model:${source.runId}:${source.modelVersionId}:${source.output}`;
 const modelWitness:EvidenceWitness={id,sourceKind:'model',owner:'EXISTING_UNDERWRITING_MODEL_VERSION',recordId:source.runId,version:source.modelVersionId,contentDigest:sha({model:stored.model_hash,input:stored.input_hash,result:stored.result_hash,ownerScope:ownerScope.map(v=>({entityType:v.entity_type,id:v.entity_id,revision:v.entity_version,digest:v.snapshot_hash}))}),field:`result.outputs.${source.output}.value`,rawValue:output.value,anchor:{},semantics,modulePath:['S1:committed-exact-model-owner-identity','UnderwritingModelVersion:'+source.modelVersionId,'UnderwritingRun:'+source.runId,'OutputNode:'+source.output,'P4:registered-direct-scalar-model-source'],uncertainty:['CONDITIONAL_MODEL_OUTPUT_NOT_OBSERVED_FACT','NO_CAUSAL_OR_ECONOMIC_ADMISSION']};
 const witnesses=[modelWitness,...parents.flatMap((p,i)=>p.witnesses.filter(w=>p.result!.outputs[basis[i]!.anchorId!]!.witnessIds.includes(w.id)).map(w=>({...w,modulePath:[...w.modulePath,'UnderwritingRun:'+source.runId]})))];
 const row:FinancialRow={recordId:source.runId,metricKey:source.output,value,semantics,witnessIds:[...new Set(witnesses.map(w=>w.id))],fields:{recordId:source.runId,metricKey:source.output,value,...semantics}};
 const parentDependencies=parents.flatMap(p=>p.invalidationKeys),keys=[`canonical:pe_investment_case:${stored.investment_case_id}`,`canonical:pe_deal:${stored.deal_id}`,`model-version:${source.modelVersionId}`,`model-run:${source.runId}`,...parents.map(p=>'derivation:'+p.id),...parentDependencies.map(d=>d.key)];
 const dependencies=await revisions(ctx,keys);for(const dependency of parentDependencies)if(dependencies.find(d=>d.key===dependency.key)?.revision!==dependency.revision)throw Error('MODEL_SOURCE_CHANGED_DURING_PERMISSIONED_READ');
 const currentScope=await tx(ctx,async c=>(await c.query("SELECT 1 FROM finnor_os.pe_investment_cases i JOIN finnor_os.pe_deals d ON d.tenant_id=i.tenant_id AND d.id=i.deal_id WHERE i.tenant_id=$1 AND i.id=$2 AND d.id=$3 AND d.target_organization_id=$4",[ctx.auth.tenantId,stored.investment_case_id,stored.deal_id,source.subject.entityId])).rowCount,true);if(currentScope!==1)throw unavailable();
 return {row,witnesses,dependencies,keys,modelDigest:modelWitness.contentDigest};
}

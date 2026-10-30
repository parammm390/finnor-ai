import {z} from 'zod';
import {attachWorkEntity} from '@finnor/db';
import {compileUnderwritingModel,type ResolvedInput,type UnderwritingInputSnapshot,type UnderwritingModelIR} from '@finnor/underwriting';
import {PrimaryUnderwritingInputsSchema,PrimaryUnderwritingScopeSchema,type PrimaryFindingBinding} from '@finnor/shared-types';
import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../types';
import {authorizeBeliefResources} from '../enterprise-beliefs';
import {createUnderwritingRun} from '../underwriting-repository';
import {actor,currentFinding,hash,reference,tx} from './store';
import {wakePrimaryObjective} from './plan';
export const PrimaryConsumeSchema=z.object({
 investmentCaseId:z.string().uuid(),modelVersionId:z.string().uuid(),worldAt:z.string().datetime({offset:true}),
 idempotencyKey:z.string().min(1).max(200),workId:z.string().uuid(),bindings:PrimaryUnderwritingInputsSchema,
}).strict();
function exactDecimal(n:string,d:string){
 let numerator=BigInt(n),denominator=BigInt(d),places=0;
 while(denominator%2n===0n){denominator/=2n;places++;}let fifths=0;while(denominator%5n===0n){denominator/=5n;fifths++;}
 if(denominator!==1n||Math.max(places,fifths)>18)throw Error('PRIMARY_UNDERWRITING_EXACT_DECIMAL_DOMAIN_EXCEEDED');
 const scale=Math.max(places,fifths),whole=numerator*10n**BigInt(scale)/BigInt(d),negative=whole<0n,chars=(negative?-whole:whole).toString().padStart(scale+1,'0');
 const value=(negative?'-':'')+(scale?chars.slice(0,-scale)+'.'+chars.slice(-scale):chars);
 if(value.replace(/[.-]/g,'').replace(/^0+/,'').length>34)throw Error('PRIMARY_UNDERWRITING_PRECISION_DOMAIN_EXCEEDED');
 return value.includes('.')?value.replace(/0+$/,'').replace(/\.$/,''):value;
}
export async function resolvePrimaryUnderwritingInputs(ctx:PeMutationContext,investmentCaseId:string,modelVersionId:string,bindings:Readonly<Record<string,PrimaryFindingBinding>>):Promise<Record<string,ResolvedInput>>{
 if(!Object.keys(bindings).length)return {};const parsed=PrimaryUnderwritingInputsSchema.parse(bindings);
 await authorizeBeliefResources(ctx,[{type:'pe_investment_case',id:investmentCaseId}]);
 const model=await tx(ctx,async c=>(await c.query<{definition:UnderwritingModelIR;target:string;opportunity_id:string|null;deal_id:string|null}>(
  `SELECT v.model_definition definition,COALESCE(d.target_organization_id,o.target_organization_id)::text target,i.opportunity_id::text,i.deal_id::text
  FROM finnor_os.underwriting_model_versions v JOIN finnor_os.pe_investment_cases i ON i.tenant_id=v.tenant_id AND i.id=v.investment_case_id
  LEFT JOIN finnor_os.pe_deals d ON d.tenant_id=i.tenant_id AND d.id=i.deal_id
  LEFT JOIN finnor_os.pe_opportunities o ON o.tenant_id=i.tenant_id AND o.id=i.opportunity_id
  WHERE v.tenant_id=$1 AND v.investment_case_id=$2 AND v.id=$3`,[ctx.auth.tenantId,investmentCaseId,modelVersionId])).rows[0],true);
 if(!model?.target)throw Error('EXACT_PRIMARY_CONSUMER_MODEL_UNAVAILABLE');
 const compiled=compileUnderwritingModel(model.definition),resolved:Record<string,ResolvedInput>={};
 for(const [nodeId,binding] of Object.entries(parsed)){
  const node=compiled.nodeById[nodeId];if(!node||node.kind!=='input'||node.shape!=='scalar'||node.valueType!=='decimal'||node.source&&!['explicit','model_parameter'].includes(node.source.kind))throw Error('PRIMARY_FINDING_CANNOT_SHADOW_BOUND_OR_NONSCALAR_INPUT');
  const expected=PrimaryUnderwritingScopeSchema.parse(node.primaryEvidenceScope),{finding:f,programme:p}=await currentFinding(ctx,binding.findingId);
  const assertion=p.intake.assertions.find(a=>a.assertionId===f.assertionRef.id&&String(a.revision)===f.assertionRef.revision);
  if(!assertion)throw Error('PRIMARY_CONSUMER_FROZEN_ASSERTION_UNAVAILABLE');
  const original=PrimaryUnderwritingScopeSchema.parse({
   predicateKind:assertion.predicateKind,field:assertion.field,economicRecordIds:assertion.economicRecordIds,semantics:assertion.semantics,
   requiredCoverage:assertion.requiredCoverage,acceptableSourceClasses:assertion.acceptableSourceClasses,
  });
  // A newly discovered single facility may narrow a completely checked lender
  // population. It may never widen it to enterprise debt, or infer an unobserved
  // participant. Every original semantic and coverage obligation is preserved.
  const witnesses=f.observedPopulationAndCoverage.sourceWitnesses.filter(w=>w.economicId===binding.economicId&&w.field===assertion.field);
  const narrow=!!binding.economicId&&original.predicateKind==='POPULATION_TOTAL'&&expected.predicateKind==='RECORD_VALUE'&&
   expected.economicRecordIds.length===1&&expected.economicRecordIds[0]===binding.economicId&&
   f.observedPopulationAndCoverage.coverageComplete&&f.observedPopulationAndCoverage.selectedEconomicIds.length===1&&
   f.observedPopulationAndCoverage.selectedEconomicIds[0]===binding.economicId&&witnesses.length>0&&
   witnesses.every(w=>hash(w.normalizedValue)===hash(f.establishedValueOrInterval))&&
   hash({...expected,predicateKind:original.predicateKind,economicRecordIds:original.economicRecordIds})===hash(original);
  if(expected.semantics.legalEntityId!==model.target||!(binding.economicId?narrow:hash(expected)===hash(original)))throw Error('PRIMARY_CONSUMER_ENTITY_FACILITY_PERIOD_BASIS_COVERAGE_MISMATCH');
  if(p.root.entityType==='pe_opportunity'&&p.root.entityId!==model.opportunity_id||p.root.entityType==='pe_deal'&&p.root.entityId!==model.deal_id)throw Error('PRIMARY_CONSUMER_CANONICAL_INVESTMENT_IDENTITY_MISMATCH');
  if(f.conclusion==='UNRESOLVED'||!f.acceptedClaims.some(r=>hash(r)===hash(f.assertionRef))||f.establishedValueOrInterval.kind!=='EXACT')throw Error('PRIMARY_UNRESOLVED_OR_NONQUANTITATIVE_CLAIM_NOT_KNOWN_INPUT');
  if(node.unit!=='money'||node.currency!==assertion.semantics.currency||assertion.semantics.units!=='dollars'||node.allowedTruthClasses&&!node.allowedTruthClasses.includes('OBSERVED_FACT'))throw Error('PRIMARY_CONSUMER_UNIT_OR_OBSERVED_TRUTH_CLASS_REFUSED');
  resolved[nodeId]={nodeId,valueType:'decimal',unit:node.unit,currency:node.currency,shape:'scalar',value:exactDecimal(f.establishedValueOrInterval.quantity.numerator,f.establishedValueOrInterval.quantity.denominator),
   truthClass:'OBSERVED_FACT',status:'KNOWN',provenance:[{kind:'primary_finding',id:f.artifactId,versionId:f.artifactId,anchorId:assertion.assertionId,semanticHash:f.contentDigest,effectiveAt:f.effectiveTime,observedAt:f.observationTime??f.knowledgeTime,retrievedAt:f.knowledgeTime}],
   reason:'INDEPENDENTLY_ESTABLISHED_EXACT_PRIMARY_SCOPE_DEVELOPMENT_NOT_ENTERPRISE_TOTAL_OR_S8_ADMISSION'};
 }
 return resolved;
}
export async function assertPrimarySnapshotCurrent(ctx:PeMutationContext,snapshot:UnderwritingInputSnapshot,c?:PoolClient,lock=false){
 for(const input of Object.values(snapshot.values))for(const ref of input.provenance.filter(p=>p.kind==='primary_finding')){
  const {finding:f,programme:p}=await currentFinding(ctx,ref.id,c,lock),a=p.intake.assertions.find(a=>a.assertionId===ref.anchorId);
  if(!a||f.conclusion==='UNRESOLVED'||f.establishedValueOrInterval.kind!=='EXACT'||input.value!==exactDecimal(f.establishedValueOrInterval.quantity.numerator,f.establishedValueOrInterval.quantity.denominator)||input.truthClass!=='OBSERVED_FACT'||input.status!=='KNOWN'||ref.semanticHash!==f.contentDigest)throw Error('PRIMARY_CONSUMER_PROVENANCE_OR_CURRENTNESS_FAILED');
 }
}
export async function bindPrimaryConsumerDependencies(ctx:PeMutationContext,c:PoolClient,runId:string,snapshot:UnderwritingInputSnapshot){
 for(const value of Object.values(snapshot.values))for(const ref of value.provenance.filter(p=>p.kind==='primary_finding')){
  const {finding}=await currentFinding(ctx,ref.id,c,true);
  await c.query("INSERT INTO finnor_os.v2_consumer_dependencies(tenant_id,finding_id,consumer_type,consumer_id,dependency_ref) VALUES($1,$2,'underwriting_run',$3,$4::jsonb) ON CONFLICT DO NOTHING",[ctx.auth.tenantId,finding.artifactId,runId,JSON.stringify(reference('V2',finding.artifactId,1,finding))]);
 }
}
export async function consumePrimaryUnderwriting(ctx:PeMutationContext,value:unknown){
 const input=PrimaryConsumeSchema.parse(value),findings=await Promise.all(Object.values(input.bindings).map(b=>currentFinding(ctx,b.findingId)));
 if(!findings.length||findings.some(({programme:p})=>p.work_id!==input.workId))throw Error('PRIMARY_CONSUMER_EXACT_WORK_SCOPE_MISMATCH');
 await authorizeBeliefResources(ctx,[{type:'work',id:input.workId},{type:'pe_investment_case',id:input.investmentCaseId}]);
 const run=await createUnderwritingRun(ctx,{investmentCaseId:input.investmentCaseId,modelVersionId:input.modelVersionId,worldAt:input.worldAt,idempotencyKey:input.idempotencyKey,workId:input.workId,primaryFindingInputs:input.bindings});
 await attachWorkEntity(ctx.auth.tenantId,input.workId,{entityType:'pe_investment_case',entityId:input.investmentCaseId,source:'V2:exact-primary-finding-underwriting-consumer'});
 // The consumer row is already durable. A refused wake leaves the original objective waiting and is reported, never rolled back.
 return {...run,workId:input.workId,objectiveWake:await wakePrimaryObjective(ctx,input.workId)};
}

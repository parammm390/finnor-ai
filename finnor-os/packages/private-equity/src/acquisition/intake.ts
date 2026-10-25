import {z} from 'zod';
import {PrimaryGovernanceSchema,PrimaryUnderwritingScopeSchema,UnderwritingExplicitInputSchema,type PrimaryGovernance,type VReference} from '@finnor/shared-types';
import type {AcquisitionIntakeContext,AcquisitionIntakeDraft} from '../../../shared-types/src/acquisition-intake';
import {compileUnderwritingModel,type UnderwritingModelIR} from '@finnor/underwriting';
import {readPrimaryContext} from '../primary-diligence/api';
import {hash,reference,rightsBinding} from '../primary-diligence/store';
import {peTransaction} from '../repository';
import {PeDomainError,type PeMutationContext} from '../types';
import {AcquisitionDomainSchema} from './contracts';
import {ReviewedAcquisitionRequestSchema,validateReviewedAcquisitionModel} from './reviewed-request';
import {selectPrimaryConsent} from '../enterprise-experiments';

const uuid=z.string().uuid(),nodeId=z.string().regex(/^[a-z][a-z0-9_.:-]{0,199}$/);
export const AcquisitionIntakeContextSchema=z.object({dealId:uuid,modelVersionId:uuid.optional()}).strict();
export const AcquisitionIntakeReviewSchema=z.object({dealId:uuid,modelVersionId:uuid,mandateId:uuid,grantId:uuid,
 sourceProfileIds:z.array(uuid).min(1).max(32),consentIds:z.array(uuid).min(1).max(32),
 assertions:z.array(z.object({nodeId,assertionId:uuid,question:z.string().trim().min(1).max(2000),rationale:z.string().trim().min(1).max(2000),
  materialityThreshold:z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).max(60),knownGaps:z.array(z.string().trim().min(1).max(1000)).max(128),observationPredicates:z.array(z.string().min(1).max(200)).min(1).max(64)}).strict()).min(1).max(16),
 explicitInputs:z.record(nodeId,UnderwritingExplicitInputSchema),acquisition:AcquisitionDomainSchema,
}).strict();
const unavailable=()=>new PeDomainError('PE_ENTITY_NOT_FOUND','Acquisition model or permissions are unavailable in the authenticated scope');
async function state(ctx:PeMutationContext,dealId:string,modelVersionId?:string){
 const root={entityType:'pe_deal' as const,entityId:dealId},registered=await readPrimaryContext(ctx,root);
 const rows=await peTransaction(ctx,async(_db,c)=>(await c.query<{id:string;name:string;investment_case_id:string;title:string;version_key:string;semantic_hash:string;model_definition:UnderwritingModelIR;target:string}>(
  `SELECT v.id::text,m.name,v.investment_case_id::text,i.title,v.version_key,v.semantic_hash,CASE WHEN v.id=$3::uuid THEN v.model_definition ELSE NULL END model_definition,d.target_organization_id::text target
   FROM finnor_os.underwriting_model_versions v JOIN finnor_os.underwriting_models m ON m.tenant_id=v.tenant_id AND m.id=v.model_id
   JOIN finnor_os.pe_investment_cases i ON i.tenant_id=v.tenant_id AND i.id=v.investment_case_id
   JOIN finnor_os.pe_deals d ON d.tenant_id=i.tenant_id AND d.id=i.deal_id
   WHERE v.tenant_id=$1 AND i.deal_id=$2 ORDER BY v.created_at DESC,v.id LIMIT 65`,[ctx.auth.tenantId,dealId,modelVersionId??null])).rows,{readOnly:true});
 if(rows.length>64)throw Error('ACQUISITION_INTAKE_MODEL_BOUND');
 const selected=modelVersionId?rows.find(row=>row.id===modelVersionId):null;if(modelVersionId&&!selected)throw unavailable();
 const now=Date.now(),target=selected?.target??rows[0]?.target;
 const profiles=registered.profiles.map(p=>({ref:p.ref,body:PrimaryGovernanceSchema.parse(p.body)})).filter(p=>(p.body.schema==='finnor.primary-authority.v1'?p.body.legalEntityIds.includes(target??''):p.body.legalEntityId===target)&&Date.parse(p.body.expiresAt)>now&&(!('validFrom'in p.body)||Date.parse(p.body.validFrom)<=now));
 return {root,rows,selected,profiles};
}
export async function acquisitionIntakeContext(ctx:PeMutationContext,value:unknown):Promise<AcquisitionIntakeContext>{
 const input=AcquisitionIntakeContextSchema.parse(value),{rows,selected,profiles}=await state(ctx,input.dealId,input.modelVersionId);
 let model:AcquisitionIntakeContext['model']=null;
 if(selected){
  const compiled=compileUnderwritingModel(selected.model_definition);if(compiled.semanticHash!==selected.semantic_hash)throw Error('MODEL_SEMANTIC_HASH_MISMATCH');
  const primaryInputs:NonNullable<AcquisitionIntakeContext['model']>['primaryInputs']=[],parameters:NonNullable<AcquisitionIntakeContext['model']>['parameters']=[],outputs:NonNullable<AcquisitionIntakeContext['model']>['outputs']=[];
  for(const node of selected.model_definition.nodes){
   if(node.kind==='input'&&node.primaryEvidenceScope)primaryInputs.push({id:node.id,label:node.label??node.id,scope:PrimaryUnderwritingScopeSchema.parse(node.primaryEvidenceScope)});
   else if(node.kind==='input'&&(!node.source||['explicit','model_parameter'].includes(node.source.kind)))parameters.push({id:node.id,label:node.label??node.id,valueType:node.valueType,unit:node.unit,currency:node.currency,shape:node.shape,required:node.required});
   if(node.kind==='output'&&node.shape==='scalar'&&['money','rate','multiple','ratio','count'].includes(node.unit))outputs.push({id:node.id,label:node.label??node.id,unit:node.unit as 'money'|'rate'|'multiple'|'ratio'|'count',currency:node.currency});
  }
  if(primaryInputs.length>16||parameters.length>64||outputs.length>64)throw Error('ACQUISITION_INTAKE_MODEL_PROJECTION_BOUND');
  model={id:selected.id,investmentCaseId:selected.investment_case_id,name:selected.name,version:selected.version_key,semanticHash:selected.semantic_hash,periods:compiled.periods.map(p=>p.id),primaryInputs,parameters,outputs};
 }
 const mandates:AcquisitionIntakeContext['mandates']=[],grants:AcquisitionIntakeContext['grants']=[],sources:AcquisitionIntakeContext['sources']=[],consents:AcquisitionIntakeContext['consents']=[];
 for(const {ref,body}of profiles){
  if(body.schema==='finnor.primary-mandate.v1')mandates.push({ref,objective:body.objective,assertionIds:body.assertionIds,authorityProfileId:body.authorityProfileId,sourceProfileIds:body.sourceProfileIds,deadline:body.stopping.deadline,environment:body.environment});
  if(body.schema==='finnor.primary-grant.v1')grants.push({ref,mandateId:body.mandateId,maximumMicroUsd:body.maximumMicroUsd,maximumRequests:body.maximumRequests,expiresAt:body.expiresAt});
  if(body.schema==='finnor.primary-source-profile.v1')sources.push({ref,issuer:body.issuer,system:body.system,sourceClass:body.sourceClass,fields:body.authoritativeFields,participants:body.accountOrParticipantIds,observationPredicates:body.observationPredicates,expiresAt:body.expiresAt});
  if(body.schema==='finnor.primary-consent.v1')consents.push({ref,sourceProfileIds:body.sourceProfileIds,participants:body.accountOrParticipantIds,periodStart:body.periodStart,periodEnd:body.periodEnd,expiresAt:body.expiresAt});
 }
 return {dealId:input.dealId,models:rows.map(r=>({id:r.id,name:r.name,investmentCaseId:r.investment_case_id,caseTitle:r.title,version:r.version_key})),model,mandates,grants,sources,consents,authorityGranted:false};
}
export async function reviewAcquisitionIntake(ctx:PeMutationContext,value:unknown){
 const draft=AcquisitionIntakeReviewSchema.parse(value) as AcquisitionIntakeDraft,{root,selected,profiles}=await state(ctx,draft.dealId,draft.modelVersionId);if(!selected)throw unavailable();
 function profile<S extends PrimaryGovernance['schema']>(id:string,schema:S){const found=profiles.find(p=>p.ref.id===id&&p.body.schema===schema);if(!found)throw unavailable();return found as {ref:VReference;body:Extract<PrimaryGovernance,{schema:S}>};}
 const mandate=profile(draft.mandateId,'finnor.primary-mandate.v1'),grant=profile(draft.grantId,'finnor.primary-grant.v1'),authority=profile(mandate.body.authorityProfileId,'finnor.primary-authority.v1');
 if(grant.body.mandateId!==mandate.ref.id)throw Error('ACQUISITION_INTAKE_GRANT_SCOPE_MISMATCH');
 const sources=draft.sourceProfileIds.map(id=>profile(id,'finnor.primary-source-profile.v1')),consents=draft.consentIds.map(id=>profile(id,'finnor.primary-consent.v1'));
 const semantics:VReference[]=[],compiled=compileUnderwritingModel(selected.model_definition);
 const assertions=draft.assertions.map(a=>{
  const node=compiled.nodeById[a.nodeId];if(!node||node.kind!=='input')throw Error('ACQUISITION_INTAKE_ASSERTION_NODE_REQUIRED');
  const scope=PrimaryUnderwritingScopeSchema.parse(node.primaryEvidenceScope),meaning=profile(scope.semantics.basisRef.id,'finnor.primary-reference-semantics.v1');
  if(hash(meaning.ref)!==hash(scope.semantics.basisRef))throw Error('ACQUISITION_INTAKE_SEMANTICS_CHANGED');
  if(!mandate.body.assertionIds.includes(a.assertionId)||scope.semantics.legalEntityId!==mandate.body.legalEntityId)throw Error('ACQUISITION_INTAKE_ASSERTION_MANDATE_MISMATCH');
  if(!sources.some(s=>s.body.authoritativeFields.includes(scope.field)&&a.observationPredicates.every(p=>s.body.observationPredicates.includes(p))&&scope.acceptableSourceClasses.includes(s.body.sourceClass)))throw Error('ACQUISITION_INTAKE_SOURCE_FIELD_REQUIRED');
  semantics.push(meaning.ref);const [integer,fraction='']=a.materialityThreshold.split('.');
  return {...scope,assertionId:a.assertionId,revision:1,subject:{entityType:'external_organization' as const,entityId:scope.semantics.legalEntityId},exactPredicate:a.question,
   amountOrState:{kind:'UNKNOWN' as const,reason:'Independent evidence requested; original claim value has not been established.'},startingSupportRefs:[],knownGaps:a.knownGaps,
   observationPredicates:a.observationPredicates,materiality:{decisionRef:mandate.body.decisionRef,rationale:a.rationale,threshold:{numerator:BigInt(integer+fraction).toString(),denominator:(10n**BigInt(fraction.length)).toString()},dependencyRefs:[reference('P4',selected.id,selected.version_key,{modelSemanticHash:selected.semantic_hash,nodeId:a.nodeId})]}};
 });
 if(new Set(assertions.map(a=>a.assertionId)).size!==assertions.length||hash([...mandate.body.assertionIds].sort())!==hash(assertions.map(a=>a.assertionId).sort()))throw Error('ACQUISITION_INTAKE_EXACT_ASSERTION_REGISTER_REQUIRED');
 const environment=mandate.body.environment;if([grant.body,authority.body,...sources.map(s=>s.body),...consents.map(c=>c.body)].some(p=>p.environment!==environment))throw Error('ACQUISITION_INTAKE_ENVIRONMENT_MISMATCH');
 const rights=(await rightsBinding(ctx,root)).rightsRef;
 if(sources.some(s=>!mandate.body.sourceProfileIds.includes(s.ref.id)||hash(s.body.rightsRef)!==hash(rights))||consents.some(c=>hash(c.body.rightsRef)!==hash(rights)))throw Error('ACQUISITION_INTAKE_SOURCE_PERMISSION_CHANGED');
 const request=ReviewedAcquisitionRequestSchema.parse({schema:'finnor.reviewed-acquisition-request.v1',dealId:draft.dealId,
  primary:{assertions,startingEvidenceRefs:[],mandateRef:mandate.ref,authorityProfileRef:authority.ref,budgetGrantRef:grant.ref,sourceProfileRefs:sources.map(s=>s.ref),consentRefs:consents.map(c=>c.ref),referenceSemanticsRefs:[...new Map(semantics.map(r=>[r.id,r])).values()],predecessorRef:null,mode:environment==='LIVE'?'protected':'ordinary_disposable'},
  underwriting:{investmentCaseId:selected.investment_case_id,modelVersionId:selected.id,explicitInputs:draft.explicitInputs,primaryAssertions:Object.fromEntries(draft.assertions.map(a=>[a.nodeId,{assertionId:a.assertionId,revision:1}]))},acquisition:draft.acquisition});
 for(const assertion of request.primary.assertions){
  const meaning=profile(assertion.semantics.basisRef.id,'finnor.primary-reference-semantics.v1');
  if(!sources.some(source=>selectPrimaryConsent(ctx,{assertion,source:source.body,consents:consents.map(c=>c.body),authority:authority.body,semantics:meaning.body,at:new Date().toISOString()})))throw Error('ACQUISITION_INTAKE_NO_ELIGIBLE_SOURCE_CONSENT');
 }
 await validateReviewedAcquisitionModel(ctx,request);
 return {request,reviewDigest:hash(request),deadlineAt:mandate.body.stopping.deadline,authorityGranted:false};
}

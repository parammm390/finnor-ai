import {z} from 'zod';
import type {PoolClient} from 'pg';
import {PrimaryIntakeSchema,PrimaryUnderwritingScopeSchema,UnderwritingExplicitInputSchema,EvidenceUnderwritingBindingSchema} from '@finnor/shared-types';
import {assertSnapshotMatchesModel,compileUnderwritingModel,decimal,type UnderwritingModelIR,type ResolvedInput} from '@finnor/underwriting';
import {peTransaction} from '../repository';
import type {PeMutationContext} from '../types';
import {validatePrimarySubmission} from '../primary-diligence/api';
import {actor,authorize,canonical,currentActor,currentFinding,hash} from '../primary-diligence/store';
import {assertPrimaryInputsCurrent} from '../primary-diligence/consumer';
import {assertEvidenceInputsCurrent,resolveEvidenceUnderwritingInputs} from '../evidence-execution/consumer';
import {currentDerivation} from '../evidence-execution/store';
import {AcquisitionRequestSchema,AcquisitionDomainSchema} from './contracts';

const uuid=z.string().uuid(),nodeId=z.string().regex(/^[a-z][a-z0-9_.:-]{0,199}$/);
const acquisition=AcquisitionDomainSchema;
export const ReviewedAcquisitionRequestSchema=z.object({
 schema:z.literal('finnor.reviewed-acquisition-request.v1'),dealId:uuid,
 primary:PrimaryIntakeSchema.omit({schema:true,root:true,workId:true,expectedWorkInputId:true,idempotencyKey:true}),
 underwriting:z.object({investmentCaseId:uuid,modelVersionId:uuid,
  primaryAssertions:z.record(nodeId,z.object({assertionId:uuid,revision:z.number().int().positive()}).strict()).refine(v=>Object.keys(v).length>0&&Object.keys(v).length<=16),
  explicitInputs:z.record(nodeId,UnderwritingExplicitInputSchema).optional(),
  evidenceDerivationInputs:z.record(nodeId,EvidenceUnderwritingBindingSchema).optional(),
 }).strict(),acquisition,
}).strict().superRefine((value,ctx)=>{
 const check=AcquisitionRequestSchema.safeParse({...value.acquisition,dealId:value.dealId,workId:value.dealId,baseRunId:value.dealId,idempotencyKey:'reviewed-original-domain-validation'});
 if(!check.success)for(const issue of check.error.issues)ctx.addIssue({...issue,path:['acquisition',...issue.path]});
 if(Buffer.byteLength(JSON.stringify(value))>48_000)ctx.addIssue({code:'custom',message:'Reviewed acquisition request exceeds its complete planner projection bound'});
});
export type ReviewedAcquisitionRequest=z.infer<typeof ReviewedAcquisitionRequestSchema>;
export interface AcquisitionAcceptance{
 schema:'finnor.acquisition-acceptance.v1';principalId:string;workId:string;workInputId:string;instructionId:string;
 requestDigest:string;requestedBudgets:Record<string,number|string|null>;
}
const AcceptanceSchema=z.object({schema:z.literal('finnor.acquisition-acceptance.v1'),principalId:uuid,workId:uuid,workInputId:uuid,instructionId:uuid,
 requestDigest:z.string().regex(/^[a-f0-9]{64}$/),requestedBudgets:z.record(z.string(), z.union([z.number(),z.string(),z.null()])),}).strict();

export async function validateReviewedAcquisitionRequest(ctx:PeMutationContext,value:unknown,work:{workId:string;workInputId:string;instructionId:string},requestedBudgets:AcquisitionAcceptance['requestedBudgets']){
 const request=ReviewedAcquisitionRequestSchema.parse(value);
 await validatePrimarySubmission(ctx,{...request.primary,schema:'finnor.primary-diligence.v1',root:{entityType:'pe_deal',entityId:request.dealId},workId:work.workId,expectedWorkInputId:work.workInputId,idempotencyKey:'reviewed-original-admission'});
 for(const binding of Object.values(request.underwriting.evidenceDerivationInputs??{}))if((await currentDerivation(ctx,binding.derivationId)).work.id!==work.workId)throw Error('REVIEWED_ACQUISITION_EVIDENCE_WORK_REQUIRED');
 if(request.underwriting.evidenceDerivationInputs)await resolveEvidenceUnderwritingInputs(ctx,request.underwriting.investmentCaseId,request.underwriting.modelVersionId,request.underwriting.evidenceDerivationInputs);
 const inputTypes=await validateReviewedAcquisitionModel(ctx,request);
 const acceptance:AcquisitionAcceptance={schema:'finnor.acquisition-acceptance.v1',principalId:actor(ctx),...work,requestDigest:hash(request),requestedBudgets};
 if(Buffer.byteLength(JSON.stringify({request,acceptance,inputTypes}))>64_000)throw Error('REVIEWED_ACQUISITION_COMPLETE_PROJECTION_BOUND');
 return {request,acceptance,inputTypes};
}

export async function validateReviewedAcquisitionModel(ctx:PeMutationContext,request:ReviewedAcquisitionRequest){
 const inputTypes=await peTransaction(ctx,async(_db,c)=>{
  const row=(await c.query<{model_definition:UnderwritingModelIR}>(`SELECT v.model_definition FROM finnor_os.underwriting_model_versions v
   JOIN finnor_os.pe_investment_cases i ON i.tenant_id=v.tenant_id AND i.id=v.investment_case_id
   WHERE v.tenant_id=$1 AND v.id=$2 AND i.id=$3 AND i.deal_id=$4`,[ctx.auth.tenantId,request.underwriting.modelVersionId,request.underwriting.investmentCaseId,request.dealId])).rows[0];
  if(!row)throw Error('REVIEWED_ACQUISITION_EXACT_MODEL_REQUIRED');
  const model=compileUnderwritingModel(row.model_definition),types:Record<string,Pick<ResolvedInput,'nodeId'|'valueType'|'unit'|'currency'|'shape'>>={};
  for(const [id,selection]of Object.entries(request.underwriting.primaryAssertions)){
   const node=model.nodeById[id],assertion=request.primary.assertions.find(a=>a.assertionId===selection.assertionId&&a.revision===selection.revision);
   if(!node||node.kind!=='input'||!assertion||node.valueType!=='decimal'||node.shape!=='scalar'||node.unit!=='money'||node.currency!==assertion.semantics.currency)throw Error('REVIEWED_ACQUISITION_ASSERTION_MODEL_SCOPE_REQUIRED');
   const scope=PrimaryUnderwritingScopeSchema.parse({predicateKind:assertion.predicateKind,field:assertion.field,economicRecordIds:assertion.economicRecordIds,semantics:assertion.semantics,requiredCoverage:assertion.requiredCoverage,acceptableSourceClasses:assertion.acceptableSourceClasses});
   if(hash(PrimaryUnderwritingScopeSchema.parse(node.primaryEvidenceScope))!==hash(scope))throw Error('REVIEWED_ACQUISITION_ASSERTION_MODEL_SCOPE_REQUIRED');
   if(request.underwriting.explicitInputs?.[id]||request.underwriting.evidenceDerivationInputs?.[id])throw Error('REVIEWED_ACQUISITION_INPUT_OWNERSHIP_CONFLICT');
  }
  for(const [id,input]of Object.entries(request.underwriting.explicitInputs??{})){
   const node=model.nodeById[id];
   if(!node||node.kind!=='input'||node.source&&!['explicit','model_parameter'].includes(node.source.kind))throw Error('REVIEWED_ACQUISITION_EXPLICIT_INPUT_MODEL_REQUIRED');
   if(node.valueType==='decimal'&&input.value!==null){for(const v of typeof input.value==='object'?Object.values(input.value):[input.value]){if(typeof v!=='string')throw Error('REVIEWED_ACQUISITION_EXACT_DECIMAL_REQUIRED');decimal(v);}}
   types[id]={nodeId:id,valueType:node.valueType,unit:node.unit,currency:node.currency,shape:node.shape};
  }
  const explicit=request.underwriting.explicitInputs??{};
  const explicitNodes=Object.fromEntries(Object.keys(explicit).map(id=>[id,model.nodeById[id]!]));
  const explicitValues=Object.fromEntries(Object.entries(explicit).map(([id,input]):[string,ResolvedInput]=>[id,{...types[id]!,...input,nodeId:id,status:input.status??'KNOWN',provenance:input.provenance??[]}]));
  // Future primary findings are still unknown. Validate only the declared
  // parameter projection with the same rules the native engine applies later.
  assertSnapshotMatchesModel({...model,nodeById:explicitNodes},{schemaVersion:'underwriting-input-snapshot.v1',investmentCaseId:request.underwriting.investmentCaseId,worldAt:new Date().toISOString(),values:explicitValues});
  for(const id of [request.acquisition.bidDomain.nodeId,...request.acquisition.financingCases.flatMap(f=>f.overrides.map(o=>o.nodeId))]){
   const node=model.nodeById[id];if(!node||node.kind!=='input'||node.shape!=='scalar'||node.valueType!=='decimal'||request.underwriting.primaryAssertions[id])throw Error('REVIEWED_ACQUISITION_FINANCING_MODEL_REQUIRED');
  }
  const bid=model.nodeById[request.acquisition.bidDomain.nodeId]!;
  if(bid.unit!=='money'||bid.currency!==request.acquisition.bidDomain.currency)throw Error('REVIEWED_ACQUISITION_BID_CURRENCY_REQUIRED');
  for(const constraint of request.acquisition.constraints){const node=model.nodeById[constraint.outputNodeId];if(!node||node.kind!=='output'||node.shape!=='scalar'||node.unit!==constraint.unit||node.currency!==constraint.currency)throw Error('REVIEWED_ACQUISITION_CONSTRAINT_MODEL_REQUIRED');}
  return types;
 },{readOnly:true});
 return inputTypes;
}

export async function readReviewedAcquisitionRequest(ctx:PeMutationContext,workId:string,workInputId?:string,client?:PoolClient){
 const read=async(c:PoolClient)=>{
  const row=(await c.query(`SELECT p.input,p.objective,p.success_condition,l.objective current_objective,l.success_condition current_success,
   l.created_by::text principal_id,(SELECT id::text FROM finnor_os.work_inputs WHERE tenant_id=p.tenant_id AND work_id=p.work_id ORDER BY created_at DESC,id DESC LIMIT 1) current_input
   FROM finnor_os.outcome_pack_runs p JOIN finnor_os.work_objective_loops l ON l.tenant_id=p.tenant_id AND l.id=p.objective_loop_id
   WHERE p.tenant_id=$1 AND p.work_id=$2`,[ctx.auth.tenantId,workId])).rows[0];
  if(!row?.input?.acquisitionRequest)return null;
  const request=ReviewedAcquisitionRequestSchema.parse(row.input.acquisitionRequest),acceptance=AcceptanceSchema.parse(row.input.acquisitionAcceptance);
  if(acceptance.principalId!==actor(ctx)||row.principal_id!==actor(ctx)||acceptance.workId!==workId||acceptance.workInputId!==row.current_input||workInputId&&acceptance.workInputId!==workInputId
   ||acceptance.requestDigest!==hash(request)||row.objective!==row.current_objective||canonical(row.success_condition)!==canonical(row.current_success))throw Error('REVIEWED_ACQUISITION_ORIGINAL_INPUT_OR_SCOPE_CHANGED');
  await currentActor(ctx,c);await authorize(ctx,{entityType:'pe_deal',entityId:request.dealId},workId,c);
  return {request,acceptance,inputTypes:row.input.acquisitionInputTypes as Record<string,unknown>,authorityGranted:false as const};
 };
 return client?read(client):peTransaction(ctx,(_db,c)=>read(c),{readOnly:true});
}

export async function assertReviewedAcquisitionAction(ctx:PeMutationContext,type:string,payload:Record<string,unknown>,workId:string,client:PoolClient){
 if(!['start_primary_diligence','create_underwriting_run','start_acquisition_evaluation'].includes(type))return;
 payload=Object.fromEntries(Object.entries(payload).filter(([key])=>!['tenantId','workId','idempotencyKey','worldAt'].includes(key)));
 const accepted=await readReviewedAcquisitionRequest(ctx,workId,undefined,client);if(!accepted)return;
 const {request,acceptance}=accepted;
 if(payload.dealId!==request.dealId)throw Error('REVIEWED_ACQUISITION_ACTION_SCOPE_CHANGED');
 if(type==='start_primary_diligence'){
  const {dealId:_deal,expectedWorkInputId,...primary}=payload;
  if(expectedWorkInputId!==acceptance.workInputId||hash(primary)!==hash(request.primary))throw Error('REVIEWED_ACQUISITION_PRIMARY_REQUEST_CHANGED');
 }else if(type==='create_underwriting_run'){
  if(payload.investmentCaseId!==request.underwriting.investmentCaseId||payload.modelVersionId!==request.underwriting.modelVersionId)throw Error('REVIEWED_ACQUISITION_UNDERWRITING_SCOPE_CHANGED');
  if(payload.baseRunId)await assertReviewedBaseRun(ctx,client,String(payload.baseRunId),request,acceptance);
  if(!payload.baseRunId){
   if(payload.scenario||payload.scenarioId||hash(payload.explicitInputs??{})!==hash(request.underwriting.explicitInputs??{})||hash(payload.evidenceDerivationInputs??{})!==hash(request.underwriting.evidenceDerivationInputs??{}))throw Error('REVIEWED_ACQUISITION_DECLARED_INPUTS_CHANGED');
   const bindings=payload.primaryFindingInputs as Record<string,{findingId:string}>|undefined;
   if(!bindings||Object.keys(bindings).sort().join('|')!==Object.keys(request.underwriting.primaryAssertions).sort().join('|'))throw Error('REVIEWED_ACQUISITION_EXACT_ASSERTION_BINDINGS_REQUIRED');
   for(const [id,selection]of Object.entries(request.underwriting.primaryAssertions)){
    const row=(await client.query(`SELECT f.body,p.intake,p.work_input_id::text FROM finnor_os.v2_findings f JOIN finnor_os.v2_programmes p ON p.tenant_id=f.tenant_id AND p.id=f.programme_id WHERE f.tenant_id=$1 AND f.id=$2 AND p.work_id=$3 AND p.principal_id=$4`,[ctx.auth.tenantId,bindings[id]!.findingId,workId,actor(ctx)])).rows[0];
    if(!row||row.work_input_id!==acceptance.workInputId||row.body.assertionRef.id!==selection.assertionId||row.body.assertionRef.revision!==String(selection.revision))throw Error('REVIEWED_ACQUISITION_EXACT_ASSERTION_BINDINGS_REQUIRED');
   }
  }
 }else{
  const {dealId:_deal,baseRunId,...domain}=payload;
  if(hash(domain)!==hash(request.acquisition))throw Error('REVIEWED_ACQUISITION_FINITE_DOMAIN_CHANGED');
  await assertReviewedBaseRun(ctx,client,String(baseRunId),request,acceptance);
 }
}

async function assertReviewedBaseRun(ctx:PeMutationContext,client:PoolClient,id:string,request:ReviewedAcquisitionRequest,acceptance:AcquisitionAcceptance){
 const run=(await client.query('SELECT input_snapshot FROM finnor_os.underwriting_runs WHERE tenant_id=$1 AND id=$2 AND work_id=$3 AND investment_case_id=$4 AND model_version_id=$5 AND scenario_id IS NULL AND status=\'SUCCEEDED\' AND validity=\'VALID\'',[ctx.auth.tenantId,id,acceptance.workId,request.underwriting.investmentCaseId,request.underwriting.modelVersionId])).rows[0];
 if(!run)throw Error('REVIEWED_ACQUISITION_EXACT_BASE_RUN_REQUIRED');
 const values=run.input_snapshot.values as Record<string,import('@finnor/underwriting').ResolvedInput>;
 for(const [nodeId,input]of Object.entries(request.underwriting.explicitInputs??{})){
  const value=values[nodeId];
  if(!value||hash(value.value)!==hash(input.value)||value.truthClass!==input.truthClass||value.status!==(input.status??'KNOWN'))throw Error('REVIEWED_ACQUISITION_BASE_PARAMETERS_CHANGED');
 }
 for(const [nodeId,selection]of Object.entries(request.underwriting.primaryAssertions)){
  const value=values[nodeId],refs=value?.provenance.filter(p=>p.kind==='primary_finding')??[];
  if(refs.length!==1)throw Error('REVIEWED_ACQUISITION_BASE_PRIMARY_PROOF_REQUIRED');
  const {finding,programme}=await currentFinding(ctx,refs[0]!.id,client);
  if(programme.work_id!==acceptance.workId||programme.work_input_id!==acceptance.workInputId||finding.assertionRef.id!==selection.assertionId||finding.assertionRef.revision!==String(selection.revision))throw Error('REVIEWED_ACQUISITION_BASE_PRIMARY_PROOF_REQUIRED');
  await assertPrimaryInputsCurrent(ctx,[value!],client);
 }
 for(const [nodeId,binding]of Object.entries(request.underwriting.evidenceDerivationInputs??{})){
  const value=values[nodeId],refs=value?.provenance.filter(p=>p.kind==='evidence_derivation')??[];
  if(refs.length!==1||refs[0]!.id!==binding.derivationId||refs[0]!.anchorId!==binding.output)throw Error('REVIEWED_ACQUISITION_BASE_EVIDENCE_BINDING_CHANGED');
  if((await currentDerivation(ctx,binding.derivationId,client)).work.id!==acceptance.workId)throw Error('REVIEWED_ACQUISITION_EVIDENCE_WORK_REQUIRED');
  await assertEvidenceInputsCurrent(ctx,[value!],client);
 }
}

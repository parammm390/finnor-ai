import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export async function guidedAcquisitionIntake(e:any){
 const {request,http,output,deadlineAt}=e;
 const context=await http.callThroughProxy('acquisition-intake-context',{dealId:request.dealId,modelVersionId:request.underwriting.modelVersionId});
 await writeFile(join(output,'guided-intake-context.json'),JSON.stringify(context,null,2));assert.equal(context.status,200,JSON.stringify(context));
 assert.equal(context.body.model.id,request.underwriting.modelVersionId);assert.equal(context.body.model.primaryInputs[0].scope.predicateKind,'POPULATION_TOTAL');
 const serialized=JSON.stringify(context.body);assert(!serialized.includes('credentialRef'));assert(!serialized.includes('responsePublicKeyPem'));assert(!serialized.includes('https://'));assert(!serialized.includes('5000000'));assert(!serialized.includes('additional-facility-1'));
 const assertion=request.primary.assertions[0];
 const draft={dealId:request.dealId,modelVersionId:request.underwriting.modelVersionId,
  mandateId:request.primary.mandateRef.id,grantId:request.primary.budgetGrantRef.id,
  sourceProfileIds:request.primary.sourceProfileRefs.map((r:any)=>r.id),consentIds:request.primary.consentRefs.map((r:any)=>r.id),
  assertions:[{nodeId:'facility',assertionId:assertion.assertionId,question:assertion.exactPredicate,rationale:assertion.materiality.rationale,materialityThreshold:'1',knownGaps:assertion.knownGaps,observationPredicates:assertion.observationPredicates}],
  explicitInputs:request.underwriting.explicitInputs,acquisition:request.acquisition,
 };
 const reviewed=await http.callThroughProxy('acquisition-intake-review',draft);await writeFile(join(output,'guided-intake-review.json'),JSON.stringify({draft,reviewed},null,2));assert.equal(reviewed.status,200,JSON.stringify(reviewed));
 assert.deepEqual(reviewed.body.request.acquisition,request.acquisition);assert.equal(reviewed.body.request.primary.assertions[0].exactPredicate,assertion.exactPredicate);assert.equal(reviewed.body.request.primary.assertions[0].amountOrState.kind,'UNKNOWN');
 assert.equal(reviewed.body.request.underwriting.primaryAssertions.facility.assertionId,assertion.assertionId);
 assert.equal(reviewed.body.request.primary.mode,'protected');
 for(const bad of [{...draft,assertions:[{...draft.assertions[0],question:''}]},{...draft,mandateId:request.underwriting.modelVersionId},{...draft,acceptance:{principalId:e.ctx.auth.userId}}]){
  const refused=await http.call('acquisition-intake-review',bad);assert(refused.status>=400,JSON.stringify(refused));
 }
 const foreign=await http.call('acquisition-intake-context',{dealId:request.dealId,modelVersionId:request.underwriting.modelVersionId},'other');assert.equal(foreign.status,200);for(const kind of ['mandates','grants','sources','consents'])assert.deepEqual(foreign.body[kind],[]);
 const privateChoice=await http.call('acquisition-intake-review',draft,'other');assert.equal(privateChoice.status,404);
 const {governance}=await import('../../packages/private-equity/src/primary-diligence/store');
 const consent=await governance<any>(e.ctx,request.primary.consentRefs[0],'finnor.primary-consent.v1');
 const incompatible=await e.call('primary-governance-put',{root:{entityType:'pe_deal',entityId:request.dealId},body:{...consent,consentId:randomUUID(),revision:1,accountOrParticipantIds:['different-permitted-population']},expectedRef:null},201);
 const incompatibleReview=await http.call('acquisition-intake-review',{...draft,consentIds:[incompatible.ref.id]});
 await writeFile(join(output,'guided-intake-consent-refusal.json'),JSON.stringify({incompatible,incompatibleReview},null,2));assert.equal(incompatibleReview.status,422);assert.equal(incompatibleReview.body.code,'ACQUISITION_INTAKE_NO_ELIGIBLE_SOURCE_CONSENT');
 const mixedReview=await http.callThroughProxy('acquisition-intake-review',{...draft,consentIds:[incompatible.ref.id,...draft.consentIds]});assert.equal(mixedReview.status,200,JSON.stringify(mixedReview));
 await writeFile(join(output,'guided-intake-multiple-consents.json'),JSON.stringify({mixedReview},null,2));
 return {...e,request:mixedReview.body.request,guidedIntake:{context,reviewed,draft,mixedReview},dropFirstPackResponse:true};
}

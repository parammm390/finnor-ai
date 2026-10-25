import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {collectEconomicRefs,economicHash} from '../../packages/epistemic-runtime/src/economic-attribution';
import {deliverOwnerTransportBatch} from '../../packages/governed-execution/src/owner-delivery-store';
import {parseEconomicMandate} from '../../packages/epistemic-runtime/src/control-contracts';
import {epistemicHash} from '../../packages/epistemic-runtime/src/source-precedence';
import {enqueueNativeMandate} from '../../packages/private-equity/src/native-experience-transport';
import {resolveEconomicSourceCut} from '../../packages/private-equity/src/enterprise-economic-attribution';
import {profitInput,profitRef,sealProfitMandate} from '../s4/operating-profit-fixtures';

export async function observationalEconomicE2E(input:any){
 const {ctx,http,ledger,valuatorPrincipal,estimand:previous,anchor,replacesBinding,previousEstimand,output,admin}=input;
 const commands:any[]=[],publish:any[]=[],tenant=ctx.auth.tenantId,principal=ctx.auth.userId;
 const save=()=>writeFile(join(output,'observational-economic-native.json'),JSON.stringify({commands,publish,qualification:'CONTROLLED_GENERATED_SOURCES_AND_NATIVE_OBSERVATIONAL_SELECTION; NO_FIELD_RESULT_EXECUTION_OR_CAUSAL_CREDIT'},null,2));
 const call=async(operation:string,body:unknown)=>{const response=await http.economicPost(operation,body);commands.push({operation,input:body,response});await save();return response;};
 const estimand=structuredClone(previous),now=Date.now();
 Object.assign(estimand,{key:'observed-'+anchor.workInputId,registeredAt:new Date(now).toISOString(),assignmentAt:new Date(now+12000).toISOString(),outcomeAccessNotBefore:new Date(now+55000).toISOString(),endpointAt:new Date(now+55000).toISOString(),correctionOf:previousEstimand});
 estimand.analysis.registeredLooks=[estimand.endpointAt];estimand.discountSchedule=[{at:estimand.endpointAt,factor:'1'}];
 const reasons=['Fixed programme selection for this generated acquisition. No randomization or identified causal contribution.'];
 estimand.assignment.reasons=reasons;
 estimand.valuationProtocol.authorityRefs[0].id=valuatorPrincipal;
 const mandateBody=profitInput().mandate;delete mandateBody.utility.operatingProfit;
 Object.assign(mandateBody,{tenantId:tenant,principalId:principal,episodeId:anchor.workId,knowledgeAt:new Date(now).toISOString(),validUntil:new Date(now+3600000).toISOString(),businessOwnerRef:profitRef(principal),rightsRef:ledger.rights});
 mandateBody.utility.periodTerms=[{variableId:'owner_wealth',unit:estimand.currency,coefficient:1}];
 mandateBody.utilityRef={owner:'BUSINESS_OWNER',id:'measurement-utility:'+epistemicHash(mandateBody.utility),version:'native-owner-preimage-v1',contentDigest:epistemicHash(mandateBody.utility)};
 const legacy=parseEconomicMandate(sealProfitMandate(mandateBody)),proposed=sealProfitMandate({...mandateBody,economicProgrammeAssignment:true});
 await writeFile(join(output,'canonical-economic-mandate-native.json'),JSON.stringify({legacy,proposed,qualification:'GENERATED_OWNER_DECLARATION_NOT_EXECUTION_OR_FIELD_ECONOMIC_AUTHORITY'},null,2));
 const nativeMandate=parseEconomicMandate(proposed);
 await enqueueNativeMandate(ctx,legacy);await enqueueNativeMandate(ctx,nativeMandate);
 const mandateDelivery=await deliverOwnerTransportBatch({semanticOwner:'BUSINESS_OWNER',tenantId:tenant,principalId:principal},{limit:8});assert.deepEqual(mandateDelivery.failures,[]);
 const mandateCut=await resolveEconomicSourceCut(ctx,[legacy.ref,nativeMandate.ref]);assert(mandateCut.evidence.every(v=>v.status==='RESOLVED_AUTHENTICATED'));
 assert.equal(Object.hasOwn(mandateCut.readbacks.get(legacy.ref.id)!.reference.content,'economicProgrammeAssignment'),false);assert.equal(mandateCut.readbacks.get(nativeMandate.ref.id)!.reference.content.economicProgrammeAssignment,true);
 const mandateProof={legacy,nativeMandate,mandateDelivery,evidence:mandateCut.evidence};await writeFile(join(output,'canonical-economic-mandate-native.json'),JSON.stringify(mandateProof,null,2));
 estimand.mandateRef=nativeMandate.ref;
 function updateRef(id:string,updated:unknown){const visit=(v:any)=>{if(v&&typeof v==='object'){if(v.id===id&&v.contentDigest)Object.assign(v,updated);for(const child of Object.values(v))visit(child);}};visit(estimand);}
 for(const ref of collectEconomicRefs(estimand)){
  if(ref.owner==='S7'||ref.id===estimand.assignment.protocolRef.id||ref.id===nativeMandate.ref.id)continue;
  const content=ref.id===estimand.mandateRef.id?{schema:'finnor.economic-mandate.v1',tenantId:tenant,principalId:principal,rightsRef:ledger.rights,economicProgrammeAssignment:true,validUntil:new Date(now+3600000).toISOString(),sourceOrigin:'GENERATED_CHALLENGE'}:ref.id===valuatorPrincipal?{schema:'finnor.independent-valuation-authority.v1',principalId:valuatorPrincipal,sourceOrigin:'GENERATED_CHALLENGE'}:{schema:'finnor.generated-source.v1',id:ref.id,sourceOrigin:'GENERATED_CHALLENGE'};
  const value={...ref,contentDigest:economicHash(content)};updateRef(ref.id,value);await ledger.publish({...value,content});publish.push({ref:value,content});
 }
 const protocol={schema:'finnor.s2.economic-assignment-protocol.v1',key:'fixed-selection:'+anchor.workInputId,mandateRef:estimand.mandateRef,populationRef:estimand.populationRef,clusterIds:['cluster-0'],controllerIds:['bau','finnor'],assignmentNotBefore:estimand.assignmentAt,outcomeAccessNotBefore:estimand.outcomeAccessNotBefore,randomization:'NONE_OBSERVATIONAL_V1',controllerByCluster:{'cluster-0':'finnor'},identificationReasons:reasons};
 const registered=await call('register-assignment-protocol',{protocol,rightsRef:ledger.rights,idempotencyKey:protocol.key});assert.equal(registered.status,200,JSON.stringify(registered));
 assert.equal(registered.body.record.content.randomization,'NONE_OBSERVATIONAL_V1');assert.deepEqual(registered.body.record.content.controllerByCluster,{'cluster-0':'finnor'});assert.equal(registered.body.record.content.probabilities,undefined);
 const protocolDelivery=await deliverOwnerTransportBatch({semanticOwner:'S2',tenantId:tenant,principalId:principal},{limit:8});assert.deepEqual(protocolDelivery.failures,[]);
 estimand.assignment.protocolRef=registered.body.record.ref;
 const forbiddenMapping=await call('register-assignment-protocol',{protocol:{...protocol,key:protocol.key+':missing',controllerByCluster:{}},rightsRef:ledger.rights});assert.equal(forbiddenMapping.status,400);
 const mixedLaw=await call('register-assignment-protocol',{protocol:{...protocol,key:protocol.key+':mixed',probabilityUnits:{bau:500000,finnor:500000}},rightsRef:ledger.rights});assert.equal(mixedLaw.status,400);
 const registration=await call('register-work',{anchor,estimand,rightsRef:ledger.rights,replacesBindingRef:replacesBinding,idempotencyKey:'observed-work:'+anchor.workInputId});assert.equal(registration.status,200,JSON.stringify(registration));
 const binding=registration.body.binding,question=await call('read',{id:binding.payload.estimandRef.id});assert.equal(question.status,200);assert.equal(question.body.payload.sourceQualification,'AUTHENTICATED_SOURCE_COMMITMENTS_ONLY');
 const delivery=await deliverOwnerTransportBatch({semanticOwner:'S7',tenantId:tenant,principalId:principal},{limit:32});assert(delivery.failures.every((v:any)=>['UNCOMMITTED_OR_UNAUTHORIZED_REFERENCE','EVENT_NOT_FOUND'].includes(v.code)),JSON.stringify(delivery));
 const source=await call('read',{id:question.body.ref.id,protectedReadback:true});assert(source.body.protectedReadback);assert.equal(source.body.qualification,'AUTHENTICATED_IMMUTABLE_BYTES_ONLY');
 const assignmentInput={estimandId:question.body.ref.id,protocolId:registered.body.record.ref.id,idempotencyKey:'observed-assignment:'+anchor.workInputId};
 const early=await call('assign-programme',assignmentInput);assert.equal(early.status,400);
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(estimand.assignmentAt)-Date.now()+10)));
 const attempts=await Promise.all(Array.from({length:4},()=>call('assign-programme',assignmentInput)));assert(attempts.every(r=>r.status===200),JSON.stringify(attempts));
 const assigned=attempts[0].body.record;assert(attempts.every(r=>r.body.record.ref.id===assigned.ref.id));assert.equal(assigned.assignments.length,1);assert.equal(assigned.assignments[0].controllerId,'finnor');assert.deepEqual(assigned.assignments[0].actualExposureRefs,[]);assert.equal(assigned.executionAuthorityGranted,false);assert.equal(assigned.content.economicCreditGranted,false);
 const changed=await call('assign-programme',{...assignmentInput,idempotencyKey:assignmentInput.idempotencyKey+':different'});assert.equal(changed.status,409);
 const rows=(await admin.query("SELECT record_id,body FROM finnor_os.s2_economic_assignment_records WHERE tenant_id=$1 AND principal_id=$2 AND estimand_id=$3 AND kind='ASSIGNMENT'",[tenant,principal,question.body.ref.id])).rows;assert.equal(rows.length,1);
 const assignmentDelivery=await deliverOwnerTransportBatch({semanticOwner:'S2',tenantId:tenant,principalId:principal},{limit:8});assert.deepEqual(assignmentDelivery.failures,[]);
 await new Promise(resolve=>setTimeout(resolve,Math.max(0,Date.parse(estimand.endpointAt)-Date.now()+10)));
 const assessment=await call('assess',{estimandId:question.body.ref.id,lookAt:estimand.endpointAt,assignments:assigned.assignments,accounting:[],idempotencyKey:'observed-assessment:'+anchor.workInputId,computeCost:{amount:null,pricebookRef:null,meteringRef:null}});assert.equal(assessment.status,200,JSON.stringify(assessment));assert(assessment.body.record.payload.assessment.contrasts.every((v:any)=>v.identification==='UNIDENTIFIED'&&v.scoreInterval===null));assert.equal(assessment.body.record.payload.assessment.completeCosts,false);
 const current=await call('work-context',{workId:anchor.workId,criterionIndex:anchor.criterionIndex});assert.equal(current.body.tracking.bindingRef.id,binding.ref.id);assert.equal(current.body.tracking.assignmentKind,'OBSERVATIONAL_UNIDENTIFIED');assert.equal(current.body.completionSatisfied,false);
 const proof={commands,publish,mandateProof,protocol,registered,protocolDelivery,forbiddenMapping,mixedLaw,registration,question,delivery,source,early,attempts,assigned,changed,rows,assignmentDelivery,assessment,current,fieldOutcomeEstablished:false,physicalExposureEstablished:false,causalCreditGranted:false};await writeFile(join(output,'observational-economic-native.json'),JSON.stringify(proof,null,2));return proof;
}

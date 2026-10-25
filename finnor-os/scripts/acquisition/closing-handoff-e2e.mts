import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {closingDigest} from '../../packages/private-equity/src/closing/compiler';
import {evaluateObjectiveSuccessCondition,inspectCurrentObjectiveSuccessState} from '../../packages/orchestration/src/objective-success';
import {createIcCase,beginIcPreparation,selectIcMemoVersion,createIcRecommendation,createIcCondition,activateIcCondition,satisfyIcCondition,failIcCondition,markIcReadyForReview,markIcReadyForVote,openIcVoting,recordIcVote,closeIcVoting,finalizeIcDecision,getIcWorkspace} from '@finnor/private-equity';

export async function acquisitionClosingHandoffE2E(e:any){
 const {ctx,admin,work,root,output,http,icFinalized}=e,tenant=ctx.auth.tenantId;
 assert(icFinalized);const prior=icFinalized.after;
 const original=async()=>(await admin.query('SELECT to_jsonb(l) loop,(SELECT jsonb_agg(to_jsonb(i) ORDER BY created_at,id) FROM finnor_os.work_inputs i WHERE i.tenant_id=l.tenant_id AND i.work_id=l.work_id) inputs FROM finnor_os.work_objective_loops l WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0];
 const frozen=await original(),commands:any[]=[];
 const context=async(icCaseId?:string)=>{
  const response=await http.callThroughProxy('acquisition-closing-context',{workId:work.workId,...(icCaseId?{icCaseId}:{})});
  commands.push({operation:'acquisition-closing-context',icCaseId,response});
  await writeFile(join(output,'closing-handoff-native.json'),JSON.stringify({commands,frozen,qualification:'ACTUAL_PROXY_AND_CANONICAL_RECONSIDERATION; NO_REAL_INVESTMENT_LEGAL_OR_PHYSICAL_CLOSING_AUTHORITY'},null,2));
  assert.equal(response.status,200,JSON.stringify(response));return response.body;
 };
 const negative=await context(String(prior.case.id));assert.equal(negative.eligible,false);
 assert(negative.blockers.includes('ACQUISITION_IC_INVESTMENT_DECISION_REQUIRED'));
 assert.equal(negative.selected.outcome,'CONTINUE_DILIGENCE');assert.equal(negative.authorityGranted,false);
 assert.equal(negative.continuation.workInputId,work.workInputId);assert.equal(negative.continuation.objectiveLoopId,frozen.loop.id);
 const deadline=new Date(frozen.loop.deadline_at).toISOString(),digest='0'.repeat(64);
 const ref={owner:'ADVERSARIAL_SCHEMA_ONLY',kind:'NOT_A_VALID_GRANT',id:'schema-only',version:'1',contentDigest:digest};
 const evidence=(kind:string)=>({kind,predicateDigest:digest,issuerIds:['schema-only'],channels:['schema-only'],maxAgeMs:1000});
 const spec={schema:'finnor.closing-spec.v1',transactionId:root.entityId,tenantId:tenant,approvedTermsRevision:'schema-only',approvedTermsDigest:digest,profileId:'schema-only',environment:'DEVELOPMENT',
  originalGrant:{episodeRef:ref,deadlineAt:deadline,maxSteps:96,maxHumanSeconds:0,maxComputeDataIntegrationUsd:'0'},
  documents:[{key:'agreement',required:true,dependsOn:[],evidence:evidence('DOCUMENT_EXECUTION'),documentId:randomUUID(),documentVersionId:randomUUID(),documentDigest:digest,approvedTermsRevision:'schema-only',signers:[{principalId:ctx.auth.userId,legalEntityId:root.entityId,roleRef:ref}]}],
  conditions:[],fundsFlows:[],rightsTransfers:[],funding:[],beneficiaries:[],continuingDuties:[],steps:[],
  legalEffectiveness:[{key:'effectiveness',required:true,dependsOn:[],evidence:evidence('LEGAL_EFFECTIVENESS'),jurisdiction:'schema-only',legalBasisDigest:digest,professionalScope:'schema-only',operationKey:null}],
  dependencyKeys:['schema-only'],assumptions:['ADVERSARIAL_SCHEMA_ONLY_NOT_A_VALID_SIGNED_LEGAL_APPROVAL'],unsupportedPredicates:[]};
 const specDigest=closingDigest(spec),closingInput={spec,expectedSpecDigest:specDigest,acceptedTermsEvidence:{sourceId:randomUUID(),versionId:randomUUID()},
  legalAcceptance:{schema:'finnor.closing-observation.v1',factId:randomUUID(),tenantId:tenant,transactionId:root.entityId,specDigest,approvedTermsRevision:'schema-only',requirementKey:'schema-only',predicateDigest:specDigest,kind:'LEGAL_SPEC_ACCEPTANCE',issuerId:'schema-only',channel:'schema-only',actorId:ctx.auth.userId,professionalScope:'closing-spec',status:'CONFIRMED',observedAt:new Date().toISOString(),validUntil:deadline,claims:{accepted:true,specDigest},supersedesFactIds:[],signature:'A'.repeat(86)+'=='},
  workId:work.workId,continuation:negative.continuation,acquisitionIcCaseId:String(prior.case.id),idempotencyKey:'closing-negative:'+work.workInputId};
 const programmeCount=async()=>(await admin.query('SELECT count(*)::int n FROM finnor_os.pe_closing_programmes WHERE tenant_id=$1 AND work_id=$2',[tenant,work.workId])).rows[0].n;
 const beforeProgrammes=await programmeCount(),closingRefusal=await http.closingPost('submit',closingInput);
 commands.push({operation:'closing/submit',input:closingInput,response:closingRefusal,qualification:'ADVERSARIAL_SCHEMA_ONLY; invalid legal signature intentionally cannot provide approval'});
 await writeFile(join(output,'closing-handoff-native.json'),JSON.stringify({commands,frozen,negative},null,2));
 assert.equal(closingRefusal.status,409,JSON.stringify(closingRefusal));assert.equal(closingRefusal.body.code,'ACQUISITION_IC_INVESTMENT_DECISION_REQUIRED');assert.equal(await programmeCount(),beforeProgrammes);
 const key='closing-handoff:'+work.workInputId;
 const created=await createIcCase(ctx,{dealId:root.entityId,investmentCaseId:String(prior.case.investmentCaseId),committeeConfigVersionId:String(prior.case.committeeConfigVersionId),primaryUnderwritingRunId:String(prior.case.primaryUnderwritingRunId),reconsidersDecisionId:String(prior.decision.id),workId:work.workId,idempotencyKey:key+':case'});
 const id=String(created.row.id);
 const prepared=await beginIcPreparation(ctx,{icCaseId:id,expectedVersion:Number(created.row.version)});
 const memo=await selectIcMemoVersion(ctx,{icCaseId:id,expectedCaseVersion:Number(prepared.row.version),artifactRole:'MEMO',documentId:String(prior.memo.documentId),documentVersionId:String(prior.memo.documentVersionId),underwritingRunId:String(prior.case.primaryUnderwritingRunId),evidenceCutoffAt:String(prior.memo.evidenceCutoffAt),sourceCompleteness:'COMPLETE',idempotencyKey:key+':memo'});
 const recommendation=await createIcRecommendation(ctx,{icCaseId:id,expectedCaseVersion:Number(memo.case.version),outcome:'INVEST_WITH_CONDITIONS',rationale:'Explicit disposable committee choice accepts the exact checked acquisition basis with its recorded unresolved revenue-cutoff risk and a current source-review duty. This fixture does not establish that risk resolved, customer investment approval, approved legal terms, settlement or profit.',memoId:String(memo.memo.id),underwritingRunId:String(prior.case.primaryUnderwritingRunId),idempotencyKey:key+':recommendation'});
 const monitoring=await createIcCondition(ctx,{icCaseId:id,expectedCaseVersion:Number(recommendation.case.version),conditionType:'MONITORING',title:'Retain independent liability-source review',description:'The selected native underwriting source must remain recorded. This current source review does not resolve the distinct revenue-cutoff uncertainty.',ownerEmployeeId:ctx.auth.userId,workId:work.workId,dueAt:deadline,required:true,evidenceRequired:true,idempotencyKey:key+':monitoring'});
 const activeMonitoring=await activateIcCondition(ctx,{icCaseId:id,conditionId:String(monitoring.condition.id),expectedConditionVersion:Number(monitoring.condition.version)});
 const failureDuty=await createIcCondition(ctx,{icCaseId:id,expectedCaseVersion:Number((await getIcWorkspace(ctx,{icCaseId:id})).case.version),conditionType:'MONITORING',title:'Retain required risk escalation',description:'A failed required post-decision monitoring duty must stop new closing work; it cannot be treated as successful fulfillment.',ownerEmployeeId:ctx.auth.userId,workId:work.workId,dueAt:deadline,required:true,evidenceRequired:true,idempotencyKey:key+':failure-duty'});
 const activeFailureDuty=await activateIcCondition(ctx,{icCaseId:id,conditionId:String(failureDuty.condition.id),expectedConditionVersion:Number(failureDuty.condition.version)});
 const preparedReview=await getIcWorkspace(ctx,{icCaseId:id});
 const review=await markIcReadyForReview(ctx,{icCaseId:id,expectedVersion:Number(preparedReview.case.version)});
 const ready=await markIcReadyForVote(ctx,{icCaseId:id,expectedVersion:Number(review.row.version)});
 const basis={icCaseId:id,recommendationId:String(recommendation.recommendation.id),memoId:String(memo.memo.id),underwritingRunId:String(prior.case.primaryUnderwritingRunId)};
 const opened=await openIcVoting(ctx,{...basis,expectedCaseVersion:Number(ready.row.version),idempotencyKey:key+':open'});
 const vote=await recordIcVote(ctx,{...basis,expectedVotingBasisVersion:Number(opened.case.votingBasisVersion),choice:'APPROVE',rationale:'Disposable explicit INVEST recommendation; no source finding is changed or represented as resolved.',idempotencyKey:key+':vote'});
 const voting=await getIcWorkspace(ctx,{icCaseId:id});
 const closed=await closeIcVoting(ctx,{icCaseId:id,expectedCaseVersion:Number(voting.case.version),expectedVoteSetVersion:Number(voting.case.voteSetVersion),idempotencyKey:key+':close'});
 const finalized=await finalizeIcDecision(ctx,{icCaseId:id,decisionProposalId:String(closed.proposal.id),expectedCaseVersion:Number(closed.case.version),title:'Disposable investing handoff under exact current source basis',rationale:'Native engineering fixture only. This explicit committee choice accepts recorded risk; independent approved legal terms and financial/provider authority remain required.',idempotencyKey:key+':finalize'});
 assert.equal(finalized.decision.decision,'INVEST_WITH_CONDITIONS');
 const positive=await context(id),old=await context(String(prior.case.id));assert.equal(positive.eligible,true,JSON.stringify(positive));assert.equal(positive.selected.decisionId,finalized.decision.id);assert.equal(positive.authorityGranted,false);assert.equal(old.eligible,false);assert(old.blockers.includes('ACQUISITION_IC_FINALIZED_PROOF_REQUIRED'));
 assert(positive.conditions.some((c:any)=>c.id===monitoring.condition.id&&c.required&&!c.discharged&&c.type==='MONITORING'));
 const missingDuty=await http.closingPost('submit',{...closingInput,acquisitionIcCaseId:id,idempotencyKey:key+':missing-duty'});assert.equal(missingDuty.status,409);assert.equal(missingDuty.body.code,'ACQUISITION_IC_MONITORING_HANDOFF_REQUIRED');
 const handedSpec={...spec,continuingDuties:positive.conditions.filter((c:any)=>c.required&&!c.discharged&&c.type==='MONITORING').map((obligation:any)=>({key:'monitoring:'+obligation.id,ownerPrincipalId:ctx.auth.userId,statement:obligation.title,dueAt:deadline,dependencyKeys:[],liability:null,obligationRef:{owner:'@finnor/private-equity',kind:'pe_ic_condition',id:obligation.id,version:String(obligation.revision),contentDigest:obligation.contentDigest}}))};
 assert.equal(handedSpec.continuingDuties.length,2);
 const legalGate=await http.closingPost('submit',{...closingInput,spec:handedSpec,expectedSpecDigest:closingDigest(handedSpec),acquisitionIcCaseId:id,idempotencyKey:key+':legal-gate'});
 assert.equal(legalGate.status,422,JSON.stringify(legalGate));assert.equal(legalGate.body.code,'QUALIFIED_CLOSING_PROFILE_UNAVAILABLE');assert.equal(await programmeCount(),beforeProgrammes);
 commands.push({operation:'closing/submit',missingDuty,legalGate,qualification:'Positive IC/duty prerequisite reaches the independent qualified-profile gate; no legal or physical approval supplied.'});
 const approvalRevision=async()=>(await admin.query("SELECT revision::text FROM finnor_os.p4_source_revisions WHERE tenant_id=$1 AND key=$2",[tenant,'ic-approval:'+id])).rows[0]?.revision;
 const approvalBefore=await approvalRevision();assert(approvalBefore);
 const monitoringBefore=await getIcWorkspace(ctx,{icCaseId:id});
 const fulfilled=await satisfyIcCondition(ctx,{icCaseId:id,conditionId:String(monitoring.condition.id),expectedConditionVersion:Number(activeMonitoring.row.version),verification:{source:{kind:'UNDERWRITING_RUN',underwritingRunId:String(prior.case.primaryUnderwritingRunId)},relationship:'VERIFIES',idempotencyKey:key+':monitoring-proof'}});
 const monitoringAfter=await getIcWorkspace(ctx,{icCaseId:id}),approvalAfter=await approvalRevision();
 assert(Number(monitoringAfter.case.version)>Number(monitoringBefore.case.version));assert.equal(approvalAfter,approvalBefore,'Fulfilling an actual monitoring duty invalidated investment approval');
 const afterMonitoring=await context(id);assert.equal(afterMonitoring.eligible,true);assert(afterMonitoring.conditions.some((c:any)=>c.id===monitoring.condition.id&&c.discharged));
 const verification=await evaluateObjectiveSuccessCondition({tenantId:tenant,workId:work.workId,loopId:frozen.loop.id,stepNumber:910003,condition:frozen.loop.success_condition,inspection:await inspectCurrentObjectiveSuccessState(tenant,work.workId,frozen.loop.id),evidence:[]});
 await writeFile(join(output,'closing-handoff-continued-goal.json'),JSON.stringify({verification,positive,afterMonitoring},null,2));
 assert.equal(verification.results.find(r=>r.kind==='private_equity_ic_preparation')?.satisfied,true,'Native investing reconsideration lost the same original Work preparation');
 const failedDuty=await failIcCondition(ctx,{icCaseId:id,conditionId:String(failureDuty.condition.id),expectedConditionVersion:Number(activeFailureDuty.row.version)});
 const afterFailure=await context(id),approvalAfterFailure=await approvalRevision();
 const failureRefusal=await http.closingPost('submit',{...closingInput,spec:handedSpec,expectedSpecDigest:closingDigest(handedSpec),acquisitionIcCaseId:id,idempotencyKey:key+':failed-duty'});
 await writeFile(join(output,'closing-handoff-monitoring-failure.json'),JSON.stringify({failedDuty,afterFailure,approvalAfter,approvalAfterFailure,failureRefusal},null,2));
 assert.equal(afterFailure.eligible,false,'A failed required monitoring duty remained eligible for closing');
 assert(afterFailure.blockers.includes('ACQUISITION_IC_REQUIRED_CONDITION_FAILED:'+failureDuty.condition.id));
 assert(Number(approvalAfterFailure)>Number(approvalAfter),'A failed required monitoring duty did not invalidate the prior approval pins');
 assert.equal(failureRefusal.status,409);assert.equal(failureRefusal.body.code,'ACQUISITION_IC_REQUIRED_CONDITION_FAILED:'+failureDuty.condition.id);assert.equal(await programmeCount(),beforeProgrammes);
 const retained=await original();assert.deepEqual(retained,frozen,'Reviewed closing context or native human commands changed the original Work contract');
 const proof={commands,frozen,retained,negative,closingRefusal,beforeProgrammes,positive,old,missingDuty,handedSpec,legalGate,verification,created,prepared,memo,recommendation,monitoring,activeMonitoring,fulfilled,monitoringBefore,monitoringAfter,approvalBefore,approvalAfter,afterMonitoring,failureDuty,activeFailureDuty,failedDuty,afterFailure,approvalAfterFailure,failureRefusal,review,ready,opened,vote,closed,finalized,legalTermsApproved:false,physicalClosingEstablished:false,economicOutcomeEstablished:false};
 await writeFile(join(output,'closing-handoff-native.json'),JSON.stringify(proof,null,2));return proof;
}

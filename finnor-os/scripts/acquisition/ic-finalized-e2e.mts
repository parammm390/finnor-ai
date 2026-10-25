import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type pg from 'pg';
import {getIcWorkspace} from '@finnor/private-equity';
import {readAcquisitionIcBasis} from '../../packages/private-equity/src/acquisition/ic';
import {evaluateObjectiveSuccessCondition,inspectCurrentObjectiveSuccessState} from '../../packages/orchestration/src/objective-success';
import type {PeMutationContext} from '../../packages/private-equity/src/types';
import type {ObjectiveSuccessCondition} from '@finnor/shared-types';

type IcHumanPath='ready-for-vote'|'voting/open'|'votes'|'voting/close'|'finalize';
type Fixture={http:{icPost:(caseId:string,path:IcHumanPath,body:unknown)=>Promise<{status:number;body:any}>};ctx:PeMutationContext;admin:pg.Client;root:{entityId:string};work:{workId:string;workInputId:string};output:string;caseId:string;loopId:string};
export async function finalizedAcquisitionIcE2E(e:Fixture){
 const {ctx,admin,work,output,caseId,loopId}=e,tenant=ctx.auth.tenantId,actor=ctx.auth.employeeId;
 assert(actor&&actor===ctx.auth.userId,'Registered disposable canonical human actor required');
 const save=async(name:string,value:unknown)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n');
 const httpCommands:Array<{path:IcHumanPath;input:Record<string,unknown>;status:number;output:unknown}>=[];
 const humanPost=async(path:IcHumanPath,input:Record<string,unknown>,expectedStatus=200)=>{
  const {icCaseId,...body}=input;assert.equal(icCaseId,caseId);
  const response=await e.http.icPost(caseId,path,body);
  httpCommands.push({path,input:body,status:response.status,output:response.body});
  await save('ic-finalized-http-commands.json',{transport:'ACTUAL_SIGNED_BEARER_HTTP_HUMAN_ROUTES',caseId,commands:httpCommands});
  assert.equal(response.status,expectedStatus,JSON.stringify({path,response}));return response.body;
 };
 const original=async()=>({
  loop:(await admin.query('SELECT id::text,work_id::text,created_by::text,revision,objective,success_condition,deadline_at,max_steps,max_actions,max_queries,max_planner_failures,max_consecutive_no_progress,max_parallel_nodes,max_node_attempts,max_waits,max_estimated_cost_micros FROM finnor_os.work_objective_loops WHERE tenant_id=$1 AND id=$2',[tenant,loopId])).rows[0],
  inputs:(await admin.query('SELECT id::text,instruction_id::text,instruction_text,created_by::text FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at,id',[tenant,work.workId])).rows,
  materialFindings:(await admin.query('SELECT to_jsonb(f) body FROM finnor_os.pe_findings f WHERE tenant_id=$1 AND deal_id=$2 ORDER BY id',[tenant,e.root.entityId])).rows,
 });
 const frozen=await original(),condition=frozen.loop.success_condition as ObjectiveSuccessCondition;
 assert.equal(frozen.inputs.length,1);assert.equal(frozen.inputs[0].id,work.workInputId);assert.equal(frozen.loop.work_id,work.workId);
 const evaluate=async(stepNumber:number)=>evaluateObjectiveSuccessCondition({tenantId:tenant,workId:work.workId,loopId,stepNumber,condition,
  inspection:await inspectCurrentObjectiveSuccessState(tenant,work.workId,loopId),evidence:[]});
 const preparation=(verification:Awaited<ReturnType<typeof evaluate>>)=>verification.results.find(result=>result.kind==='private_equity_ic_preparation');
 const before=await getIcWorkspace(ctx,{icCaseId:caseId}),beforeVerification=await evaluate(910001);
 assert.equal(before.case.state,'READY_FOR_REVIEW');assert.equal(before.currentRecommendation?.outcome,'CONTINUE_DILIGENCE');
 assert.equal(before.underwriting?.run.workId,work.workId);
 assert.equal(preparation(beforeVerification)?.satisfied,true,'Existing guided acquisition preparation must pass before native IC finalization');
 assert.equal(before.votes.length,0);assert(before.currentRecommendation&&before.memo&&before.underwriting);
 const basis={recommendationId:String(before.currentRecommendation.id),memoId:String(before.memo.id),underwritingRunId:String(before.underwriting.run.id)};
 const key=`guided-ic-finalized:${work.workInputId}`;
 const commands={
  actor:{tenantId:tenant,userId:ctx.auth.userId,employeeId:actor,role:ctx.auth.role},
  transport:'ACTUAL_SIGNED_BEARER_HTTP_THROUGH_EXISTING_HUMAN_IC_ROUTE_HANDLERS',
  ready:{icCaseId:caseId,expectedVersion:Number(before.case.version)},
  open:{icCaseId:caseId,...basis,expectedCaseVersion:Number(before.case.version)+1,idempotencyKey:key+':open'},
  vote:{icCaseId:caseId,...basis,expectedVotingBasisVersion:Number(before.case.version)+2,choice:'APPROVE' as const,rationale:'Disposable human choice ratifies the exact CONTINUE_DILIGENCE recommendation and its unresolved material uncertainty. It does not approve investment or authorize closing.',idempotencyKey:key+':vote'},
  close:{icCaseId:caseId,idempotencyKey:key+':close'},
  finalize:{icCaseId:caseId,title:'Continue acquisition diligence under the exact reviewed IC basis',rationale:'The committee ratifies CONTINUE_DILIGENCE. Material revenue-cutoff uncertainty remains unresolved. No approval to invest, close, waive evidence, or claim economic profit is given.',idempotencyKey:key+':finalize'},
 };
 await save('ic-finalized-frozen-inputs.json',{work,root:e.root,frozen,before,beforeVerification,commands,qualification:'DISPOSABLE_CANONICAL_HUMAN_LIFECYCLE_NOT_ACTUAL_CUSTOMER_VOTE_OR_INVESTMENT_APPROVAL'});
 const ready=await humanPost('ready-for-vote',commands.ready);
 assert.equal(ready.row.state,'READY_FOR_VOTE');assert.equal(Number(ready.row.version),commands.open.expectedCaseVersion);
 const opened=await humanPost('voting/open',commands.open);
 assert.equal(Number(opened.case.votingBasisVersion),commands.vote.expectedVotingBasisVersion);
 const voted=await humanPost('votes',commands.vote,201);
 assert.equal(voted.vote.employeeId,actor);assert.equal(voted.vote.choice,'APPROVE');
 const voteWorkspace=await getIcWorkspace(ctx,{icCaseId:caseId});
 const closeInput={...commands.close,expectedCaseVersion:Number(voteWorkspace.case.version),expectedVoteSetVersion:Number(voteWorkspace.case.voteSetVersion)};
 await save('ic-finalized-before-voting-close.json',{commands,ready,opened,voted,voteWorkspace,closeInput});
 const closed=await humanPost('voting/close',closeInput);
 assert.equal(closed.aggregation.process.status,'PROCESS_ELIGIBLE');assert.equal(closed.aggregation.proposedOutcome,'CONTINUE_DILIGENCE');
 const finalInput={...commands.finalize,decisionProposalId:String(closed.proposal.id),expectedCaseVersion:Number(closed.case.version)};
 await save('ic-finalized-before-finalization.json',{closeInput,closed,finalInput});
 const finalized=await humanPost('finalize',finalInput),replayed=await humanPost('finalize',finalInput);
 const after=await getIcWorkspace(ctx,{icCaseId:caseId}),retained=await original();
 const currentAcquisition=await readAcquisitionIcBasis(ctx,{workId:work.workId,dealId:e.root.entityId,underwritingRunId:basis.underwritingRunId});
 const afterVerification=await evaluate(910002),afterPreparation=preparation(afterVerification);
 const decisionCounts=(await admin.query(`SELECT
  (SELECT count(*)::int FROM finnor_os.pe_ic_decision_links WHERE tenant_id=$1 AND ic_case_id=$2) links,
  (SELECT count(*)::int FROM finnor_os.pe_decisions WHERE tenant_id=$1 AND id=$3) decisions,
  (SELECT count(*)::int FROM finnor_os.pe_ic_votes WHERE tenant_id=$1 AND ic_case_id=$2) votes`,[tenant,caseId,finalized.decision.id])).rows[0];
 const proof={work,root:e.root,commands,closeInput,finalInput,ready,opened,voted,closed,finalized,replayed,before,after,frozen,retained,beforeVerification,afterVerification,currentAcquisition,decisionCounts,httpCommands,
  qualification:'ACTUAL_SIGNED_BEARER_HTTP_HUMAN_IC_LIFECYCLE_AND_NATIVE_CANONICAL_OWNER_READBACK; DISPOSABLE_RATIFICATION_OF_CONTINUED_DILIGENCE_NOT_REAL_INVESTMENT_APPROVAL',
  investmentApprovalGranted:false,closingAuthorityGranted:false,materialUncertaintyResolved:false,realizedProfitEstablished:false,
  expectedContract:'Native DECIDED with exact final decision proof preserves same-Work IC preparation; unchanged full mission remains gated by close and economic evidence.'};
 await save('ic-finalized-native-proof.json',proof);
 assert.equal(after.case.state,'DECIDED');assert.equal(after.decision?.state,'final');assert.equal(after.decision?.decision,'CONTINUE_DILIGENCE');
 assert(after.decisionProof,'Native final decision proof must be read through the temporal workspace');
 assert.deepEqual(decisionCounts,{links:1,decisions:1,votes:1},'Native finalization retry must converge on exactly one decision and official vote');
 assert.equal(replayed.idempotent,true);assert.equal(replayed.decision.id,finalized.decision.id);
 assert.equal(after.currentRecommendation?.id,basis.recommendationId);assert.equal(after.memo?.id,basis.memoId);assert.equal(after.underwriting?.run.id,basis.underwritingRunId);
 assert.deepEqual(retained,frozen,'Native IC human commands changed the original Work input, goal or finite allowance');
 assert(currentAcquisition,'The exact same-Work acquisition source must remain current after native IC finalization');
 assert.notEqual(afterVerification.state,'verified','Close and realized economics cannot be satisfied by an IC decision');
 if(!afterPreparation?.satisfied){
  const observation=afterPreparation?.observed as Array<{gaps:string[]}>|undefined;
  const gaps=Array.isArray(observation)?observation.flatMap(item=>item.gaps):[];
  assert.deepEqual([...new Set(gaps)],['IC_CASE_NOT_PREPARED'],'IC finalization regression must not be an unrelated source or setup failure');
 }
 assert.equal(afterPreparation?.satisfied,true,'IC_PREPARATION_REGRESSED_AFTER_NATIVE_DECISION: IC_CASE_NOT_PREPARED');
 return proof;
}

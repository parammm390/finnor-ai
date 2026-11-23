import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {composeCanvasDocument} from '../../../../src/components/centropy/canvas/canvas-compose.ts';
const repo=fileURLToPath(new URL('../../../../',import.meta.url)),root=process.argv[2];
assert.ok(root?.startsWith('/'),'Fresh private evidence directory required');
await mkdir(root,{mode:0o700});
const now='2026-10-14T00:00:00.000Z',workId='10000000-0000-4000-8000-000000000001';
const rows=[
 ['prepared','not_started',null],['executing','not_started',null],
 ['reconciliation_required','reconciliation_required',{status:'unknown'}],
 ['verified','verified',{status:'created',summary:'Independent canonical owner observed the expected Request'}],
 ['verified','partially_verified',{status:'partial'}],['verified',null,{status:'recorded'}],['failed','unverified',null],
].map(([status,state,observedResult],index)=>({id:`10000000-0000-4000-8000-${String(index+2).padStart(12,'0')}`,
 domainActionId:null,status,effect:{operation:{name:'create_request'}},semanticHash:'fixture-'+index,observedResult,
 verification:state?{state,basis:'Read-only canonical Request observer',checkedAt:now}:null}));
const work={work:{id:workId,status:'running',initialInstruction:'Standing evidence responsibility',executionModel:'objective',
 currentOwnerId:null,assignedTo:null,createdAt:now,updatedAt:now,failure:null,recovery:null,finalOutcome:null},
 planRevisions:[],actions:[],businessEffects:rows,objectiveSteps:[],queryExecutions:[],eventWaits:[],receipts:[]};
const thread={id:'10000000-0000-4000-8000-000000000010',title:'Effect readback',revision:1};
const run=businessEffects=>composeCanvasDocument({thread,work:{...work,businessEffects},projection:null,builtAt:now});
const document=run(rows),empty=run([]),block=document.blocks.find(b=>b.type==='work_execution');
const stages=block.payload.stages,perEffect=stages.filter(s=>s.id.startsWith('business-effect:'));
const checks=[{id:'recorded-count-is-not-observed-count',passed:stages.find(s=>s.id==='execution').detail.includes('7 recorded business effects · 1 independently verified outcome')},
 {id:'complete-per-effect-owner-state',passed:perEffect.length===7&&perEffect.every((s,i)=>s.detail.includes('Recorded: '+rows[i].status)&&s.detail.includes('Verification: '+(rows[i].verification?.state??'UNKNOWN')))},
 {id:'prepared-intent-explicit',passed:perEffect[0]?.detail.includes('Prepared intent; execution not established')===true&&perEffect[0]?.state!=='verified'},
 {id:'possible-submission-retains-unknown',passed:[1,2].every(i=>perEffect[i]?.detail.includes('Outcome UNKNOWN; reconcile before retry')===true&&perEffect[i]?.state!=='verified')},
 {id:'one-independent-witness',passed:perEffect.filter(s=>s.state==='verified').length===1&&perEffect[3]?.detail.includes('Read-only canonical Request observer')===true&&perEffect[3]?.detail.includes(now)===true&&perEffect[3]?.detail.includes('Independent canonical owner observed the expected Request')===true},
 {id:'partial-missing-failed-not-complete',passed:[4,5,6].every(i=>perEffect[i]?.state!=='verified')&&perEffect[6]?.detail.includes('Recorded: failed')===true},
 {id:'empty-does-not-invent-effect',passed:empty.blocks[0].payload.stages.filter(s=>s.id.startsWith('business-effect:')).length===0&&empty.blocks[0].payload.stages.find(s=>s.id==='execution').detail.includes('0 independently verified outcomes')}];
// A Work is not independently verified by a prior revision, a finalized action
// receipt, or a read known to be truncated. These cases use the actual composer.
const plan=(revision,status,proof)=>({
  id:`10000000-0000-4000-8000-${String(revision+100).padStart(12,'0')}`,
  revision,status,reason:revision===1?'initial':'redirect',completionProof:proof
});
const actionReceipt=(id,finalizedAt)=>({
  id:`10000000-0000-4000-8000-${String(id+200).padStart(12,'0')}`,
  domainActionId:null,actualResult:{status:'recorded'},failure:null,finalizedAt
});
const completeRead={limit:100,complete:true,truncatedTables:[]};
const completedWork={...work.work,status:'completed',finalOutcome:{summary:'Persisted outcome'}};
const revised=composeCanvasDocument({thread,projection:null,builtAt:now,work:{
  ...work,work:completedWork,read:completeRead,
  planRevisions:[plan(1,'completed',{verified:true}),plan(2,'active',null)],
  receipts:[actionReceipt(1,now),actionReceipt(2,null)],businessEffects:[]
}});
const currentProof=composeCanvasDocument({thread,projection:null,builtAt:now,work:{
  ...work,work:completedWork,read:completeRead,
  planRevisions:[plan(1,'completed',{verified:true}),plan(2,'completed',{verified:true})],
  receipts:[actionReceipt(1,now)],businessEffects:[]
}});
const truncated=composeCanvasDocument({thread,projection:null,builtAt:now,work:{
  ...work,work:completedWork,read:{limit:100,complete:false,truncatedTables:['work_plan_revisions']},
  planRevisions:[plan(1,'completed',{verified:true}),plan(2,'completed',{verified:true})],
  receipts:[actionReceipt(1,now)],businessEffects:[]
}});
const stage=(doc,id)=>doc.blocks.find(b=>b.type==='work_execution')?.payload.stages.find(s=>s.id===id);
checks.push(
  {id:'latest-plan-not-oldest',passed:stage(revised,'plan')?.detail.includes('Revision 2 · redirect · active')===true},
  {id:'historical-proof-does-not-verify-new-plan',passed:['plan','execution','verification','outcome'].every(id=>stage(revised,id)?.state!=='verified')},
  {id:'latest-unfinalized-receipt-not-hidden',passed:revised.blocks.some(b=>b.type==='decision_receipt'&&b.payload.finalizedAt===null&&b.payload.status==='Pending')},
  {id:'finalized-action-receipt-not-work-proof',passed:stage(revised,'verification')?.state!=='verified'},
  {id:'current-completed-plan-proof-verifies-completed-work',passed:['plan','verification','outcome'].every(id=>stage(currentProof,id)?.state==='verified')},
  {id:'truncated-aggregate-blocks-verification',passed:truncated.blocks.find(b=>b.type==='work_execution')?.truthState==='PARTIAL'&&['plan','verification','outcome'].every(id=>stage(truncated,id)?.state!=='verified')},
  {id:'truncation-names-missing-source',passed:stage(truncated,'verification')?.detail.includes('work_plan_revisions')===true},
);
const pin=async path=>({path,sha256:createHash('sha256').update(await readFile(join(repo,path))).digest('hex')});
const result={status:checks.every(c=>c.passed)?'PASS':'FAIL',claimDomain:'ISOLATED_REAL_CANVAS_COMPOSER_AND_SCHEMA_ONLY',
 sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),runtime:process.version,
 pins:await Promise.all(['src/components/centropy/canvas/canvas-compose.ts','finnor-os/scripts/frontier5/x1/canvas-effect-cases.mjs',
 'finnor-os/scripts/frontier5/x1/reference/canvas-effect-native-review-contract.md'].map(pin)),inputs:{thread,work},document,empty,checks,
 actualBusinessCompletion:false,mountedVerification:false};
await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:result.status,checks}));
assert.equal(result.status,'PASS','FDD-006 recorded intent must not be presented as independently observed completion');

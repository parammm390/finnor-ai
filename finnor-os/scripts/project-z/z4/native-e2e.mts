/** Guarded real existing-target replay. No DB/Auth setup, grants or listeners. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import type {Browser,BrowserContext,Page} from '@playwright/test';
import {canonical,sha} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts.ts';
import {originalExecution} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/original.ts';
import {childEnvironment,applyRuntimeEnvironment,replayAuthority,writeRefusal,type ReplayAuthority} from './replay-authority.mts';
import {OwnedNativeGroups} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/process-groups.ts';

const argv=process.argv.slice(2),arg=(key:string)=>argv[argv.indexOf(key)+1],repository=arg('--repository')!,
 evidence=arg('--evidence')!,manifest=argv.includes('--manifest')?arg('--manifest'):undefined;
function check(ok:unknown,code:string):asserts ok{if(!ok)throw Error(code);}
let authority:ReplayAuthority|undefined;
try{authority=await replayAuthority(repository,manifest);}
catch(error){await writeRefusal(evidence,error);process.exitCode=78;}

if(authority){
 const a=authority,report:{schema:string;status:string;scopeDigest:string;sourceDigest:string;steps:unknown[];cases:unknown[];
  negatives:unknown[];nativeOwner:string;protectedAdmission:string;eligibleReuseN:number;failure?:string}={
  schema:'finnor.z4.native-e2e.v1',status:'RUNNING',scopeDigest:a.scopeDigest,sourceDigest:a.sourceDigest,
  steps:[],cases:[],negatives:[],nativeOwner:'NOT_YET_OBSERVED',protectedAdmission:'NOT_RUN',eligibleReuseN:0,
 };
 await mkdir(evidence,{recursive:false,mode:0o700});
 const flush=()=>writeFile(join(evidence,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 await flush();
 let browser:Browser|undefined,pool:{end():Promise<void>}|undefined;
 const contexts:BrowserContext[]=[],children=new Set<ChildProcess>();
 const nativeGroups=new Map<ChildProcess,OwnedNativeGroups>();
 function stopOwned(child:ChildProcess){
  if(!children.has(child)||!child.pid)return;
  nativeGroups.get(child)?.stop();
  try{process.kill(-child.pid,'SIGKILL');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
 }
 async function reapOwned(child:ChildProcess){
  if(!child.pid)return;
  if(child.exitCode!==null||child.signalCode!==null){stopOwned(child);return;}
  await new Promise<void>((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('Z4_OWNED_CHILD_REAP_TIMEOUT')),5000);
   child.once('close',()=>{clearTimeout(timer);resolve();});
   try{stopOwned(child);}catch(error){clearTimeout(timer);reject(error);}
  });
 }
 try{
  const {chromium,expect}=await import('@playwright/test');
  // Only the explicitly named, checked existing-target environment reaches runtime imports.
  applyRuntimeEnvironment(a);
  const {submitSchema,acceptedDefinition}=await import('../../../packages/private-equity/src/project-z/z4-execution-proof/contracts.ts');
  const db=await import('../../../packages/db/index.ts');pool=db.getPool();
  browser=await chromium.launch({headless:true,executablePath:a.target.chromiumExecutableFile,
   args:['--disable-background-networking','--disable-component-update',
   '--disable-domain-reliability','--disable-sync','--no-first-run']});
  const login=async(name:string)=>{
   const credentials=z.object({email:z.string().email(),password:z.string().min(1)}).strict().parse(JSON.parse(process.env[name]??'null'));
   const context=await browser!.newContext({baseURL:a.target.frontendOrigin});contexts.push(context);
   await context.route('**/*',async route=>{
    const u=new URL(route.request().url());
    if([a.target.frontendOrigin,a.target.backendOrigin,a.target.authOrigin].includes(u.origin))await route.continue();
    else await route.abort('blockedbyclient');
   });
   const page=await context.newPage();
   await page.goto('/centropy/login');
   await expect(page.getByRole('heading',{name:'Sign in to CENTROPY'})).toBeVisible();
   await page.getByLabel('Email',{exact:true}).fill(credentials.email);
   await page.getByLabel('Password',{exact:true}).fill(credentials.password);
   const mePromise=page.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname==='/api/centropy/me');
   await page.getByRole('button',{name:'Sign in',exact:true}).click();
   const me=await mePromise;
   check(me.status()===200,'Z4_REAL_OWNER_LOGIN_FAILED');
   const identity=z.object({tenantId:z.string().uuid(),userId:z.string(),employeeId:z.string().nullable(),role:z.string()}).parse(await me.json());
   const bearer=await me.request().headerValue('authorization');
   check(bearer?.startsWith('Bearer '),'Z4_REAL_SIGNED_BEARER_REQUIRED');
   return {page,context,identity,bearer:bearer!};
  };
  const owner=await login(a.scope.credentialsEnvironmentVariable);
  check(owner.identity.tenantId===a.scope.tenantId&&(owner.identity.employeeId??owner.identity.userId)===a.scope.principalId&&
   owner.identity.role==='owner','Z4_REAL_OWNER_IDENTITY_MISMATCH');
  const {requireContext}=await import('../../../apps/api/lib/auth.ts');
  const auth=await requireContext(new Request(a.target.backendOrigin+'/api/me',{headers:{authorization:owner.bearer}}));
  check(auth.tenantId===a.scope.tenantId&&(auth.employeeId??auth.userId)===a.scope.principalId,'Z4_BACKEND_AUTH_PROJECT_OR_PRINCIPAL_MISMATCH');
  const ctx={auth},store=await import('../../../packages/private-equity/src/project-z/z4-execution-proof/store.ts');
  const post=async(page:Page,bearer:string,operation:string,body:unknown)=>{
   await replayAuthority(repository,manifest);
   const response=await page.request.post('/api/centropy/company-brain/'+operation,
    {headers:{authorization:bearer},data:body,timeout:65000});
   const value=await response.json() as Record<string,unknown>;
   report.steps.push({operation,status:response.status(),requestSha256:sha(body),responseSha256:sha(value)});
   await flush();return {status:response.status(),body:value};
  };
  const read=async(sessionId:string)=>{
   const response=await post(owner.page,owner.bearer,'execution-proof-read',{sessionId});
   check(response.status===200,'Z4_NATIVE_RETAINED_READ_FAILED');
   return response.body as unknown as {sessionId:string;workId:string;workInputId:string;status:string;currentness:string;originalDeadline:string;
    remainingBudget:{allocationRef:unknown;reservationRef:unknown;cpuReservedSeconds:number;retainedBytes:number};
    capsule:null|{digest:string;statement:{finalState:string[];steps:number}};delivery:null|{state:string;useId:string;resultDigest?:string};
    currentObligations:{unknown:boolean;refs:Array<{id:string;status:string}>}};
  };
  const snapshot=async(sessionId:string)=>{
   const row=await store.job(ctx,sessionId),o=await store.original(ctx,row);
   const attempts=(await db.getPool().query(`SELECT id::text,claim_fence::text,worker_id,outcome,finished_at
    FROM finnor_os.job_delivery_attempts WHERE tenant_id=$1 AND job_id=$2 ORDER BY claim_fence,id`,
    [a.scope.tenantId,sessionId])).rows;
   return {sessionId,originalDigest:row.payload.z4.originalDigest,workId:o.request.workId,workInputId:o.request.workInputId,
    reservationRef:o.allocation.reservation.ref,allocationRef:o.allocation.certificate.ref,deadlineAt:o.request.deadlineAt,
    queueStatus:row.status,claimFence:Number(row.claim_fence),z4:row.payload.z4,attempts};
  };
  type Boundary='CLAIM'|'CHECKPOINT'|'OWNER_RESULT'|'OWNER_ACK';
  async function child(index:number,sessionId:string,mode:'queue'|'consume',stage?:Boundary,input?:unknown){
   await replayAuthority(repository,manifest);
   const nonce=randomBytes(16).toString('hex'),started=performance.now(),logs:Buffer[]=[],errors:Buffer[]=[];
   const processChild=spawn(process.execPath,['--import','tsx',join(repository,'finnor-os/scripts/project-z/z4/native-child.mts'),
    '--repository',repository,'--manifest',manifest!,'--case',String(index),'--session',sessionId,'--mode',mode],
    {cwd:join(repository,'finnor-os'),env:{...childEnvironment(a),FINNOR_Z4_REPLAY_PAUSE_AT:stage??'',
     FINNOR_Z4_REPLAY_NONCE:nonce},detached:true,stdio:['pipe','pipe','pipe','ipc']});
   children.add(processChild);
   const groups=new OwnedNativeGroups(processChild,sessionId,nonce);nativeGroups.set(processChild,groups);
   let total=0,reached=false,atBoundary:Awaited<ReturnType<typeof snapshot>>|undefined;
   const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{
    processChild.once('error',reject);processChild.once('close',(code,signal)=>resolve({code,signal}));
   });
   for(const [stream,list] of [[processChild.stdout,logs],[processChild.stderr,errors]] as const)stream!.on('data',(body:Buffer)=>{
    total+=body.length;if(total>1024*1024)stopOwned(processChild);else list.push(body);
   });
   let boundaryError:unknown;
   processChild.on('message',message=>{void(async()=>{
    if(groups.accept(message))return;
    const m=message as Record<string,unknown>;
    if(!stage||m.schema!=='finnor.z4.physical-boundary.v1'||m.sessionId!==sessionId||
     m.stage!==stage||m.nonce!==nonce||m.pid!==processChild.pid)return;
    check(!reached,'Z4_DUPLICATE_PHYSICAL_BARRIER');reached=true;
    atBoundary=await snapshot(sessionId);
    check(stage==='CLAIM'?atBoundary.z4.status==='RUNNING':
     stage==='CHECKPOINT'?!!atBoundary.z4.checkpointDigest:
      stage==='OWNER_RESULT'?atBoundary.z4.delivery?.state==='DELIVERING'&&!!atBoundary.z4.delivery.resultDigest&&
       atBoundary.z4.delivery.acks.includes('BEFORE')&&atBoundary.z4.delivery.acks.includes('AFTER'):
      atBoundary.z4.delivery?.state==='ACKNOWLEDGED',
    'Z4_REAL_DURABLE_BOUNDARY_NOT_OBSERVED');
    stopOwned(processChild);
   })().catch(error=>{boundaryError=error;stopOwned(processChild);});});
   if(input!==undefined)processChild.stdin!.end(JSON.stringify(input));else processChild.stdin!.end();
   const timer=setTimeout(()=>stopOwned(processChild),Math.max(1,Math.min(900000,Date.parse(a.scope.expiresAt)-Date.now())));
   let terminal:Awaited<typeof exit>;
   try{terminal=await exit;}finally{clearTimeout(timer);}
   stopOwned(processChild);children.delete(processChild);
   const name='child-'+index+'-'+mode+'-'+(stage??'complete')+'-'+nonce;
   await writeFile(join(evidence,name+'.stdout.log'),Buffer.concat(logs),{flag:'wx',mode:0o600});
   await writeFile(join(evidence,name+'.stderr.log'),Buffer.concat(errors),{flag:'wx',mode:0o600});
   const receipt={mode,stage:stage??null,sessionId,pid:processChild.pid,terminal,reached,
    wallMs:performance.now()-started,stdoutSha256:sha(Buffer.concat(logs)),stderrSha256:sha(Buffer.concat(errors)),
    nativeProcessGroups:groups.receipts,atBoundary};
   report.steps.push(receipt);await flush();
   if(boundaryError)throw boundaryError;
   check(total<=1024*1024,'Z4_NATIVE_CHILD_OUTPUT_BOUND');
   check(stage?reached&&terminal.signal==='SIGKILL':terminal.code===0,'Z4_NATIVE_PHYSICAL_CHILD_OUTCOME');
   return receipt;
  }
  const owners=new Set<string>();
  for(const [index,c] of a.scope.cases.entries()){
   const request=submitSchema.parse(JSON.parse(await readFile(c.requestFile,'utf8')));
   check(request.workId===c.workId&&request.workInputId===c.workInputId,'Z4_NATIVE_CASE_ORIGINAL_INPUT_MISMATCH');
   check(!c.recoverProducer||request.maxAttempts===3,'Z4_NATIVE_RECOVERY_ORIGINAL_ATTEMPT_ENVELOPE_REQUIRED');
   const expected=z.object({schema:z.literal('finnor.z4.native-expected.v1'),fixture:z.literal(false),
    ownerSourceDigest:z.string().regex(/^[a-f0-9]{64}$/),inputs:z.array(z.array(z.string())),
    finalState:z.array(z.string()),provenance:z.string().min(1).max(2000)}).strict().parse(JSON.parse(await readFile(c.expectedFile,'utf8')));
   const url='/centropy/world?'+new URLSearchParams({root:JSON.stringify(request.root),
    object:JSON.stringify({namespace:'core',owner:'@finnor/db',type:'work',id:c.workId}),workId:c.workId});
   await owner.page.goto(url);
   let panel=owner.page.getByRole('region',{name:'Execution proof capsule'});
   await expect(panel).toBeVisible({timeout:45000});
   let sessionId=c.sessionId;
   if(!sessionId){
    await panel.getByText('Exact computation and original Work controls',{exact:true}).click();
    await panel.getByLabel('Proof operation',{exact:true}).selectOption('submit');
    await panel.getByLabel('Typed ordinary-disposable definition',{exact:true}).fill(JSON.stringify(request));
    const accepted=owner.page.waitForResponse(r=>r.request().method()==='POST'&&
     new URL(r.url()).pathname==='/api/centropy/company-brain/execution-proof-submit');
    await panel.getByRole('button',{name:'Record proof request',exact:true}).click();
    const response=await accepted;
    check(response.status()===202,'Z4_MOUNTED_ORIGINAL_SUBMISSION_NOT_ACCEPTED');
    sessionId=z.object({sessionId:z.string().uuid(),workId:z.literal(c.workId)}).parse(await response.json()).sessionId;
   }
   const original=await store.original(ctx,await store.job(ctx,sessionId));
   check(sha(original.request)===sha(request)&&original.ownerSourceDigest===expected.ownerSourceDigest&&
    canonical(original.exact.inputs)===canonical(expected.inputs),'Z4_INDEPENDENT_ORIGINAL_HISTORY_PREIMAGE_MISMATCH');
   const full=originalExecution(original.exact);
   check(canonical(full.finalState)===canonical(expected.finalState),'Z4_INDEPENDENT_LITERAL_ORIGINAL_ORACLE_MISMATCH');
   const before=await snapshot(sessionId);
   if(request.qualification)check(!c.recoverProducer&&before.queueStatus==='queued'&&before.z4.status==='QUEUED'&&
    before.z4.attempts===0&&before.z4.cpuReservedSeconds===0&&!before.z4.checkpointDigest&&
    !before.z4.capsuleDigest&&!before.z4.delivery&&!before.z4.qualificationAttempt,
   'Z4_NATIVE_QUALIFICATION_REQUIRES_GENUINE_UNUSED_ORIGINAL');
   if(c.recoverProducer){
    check(before.queueStatus==='queued'&&before.z4.attempts===0,'Z4_RECOVERY_REQUIRES_UNDISPATCHED_ORIGINAL_JOB');
    await child(index,sessionId,'queue','CLAIM');
    await child(index,sessionId,'queue','CHECKPOINT');
    await child(index,sessionId,'queue');
   }else if(before.z4.status!=='CHECKED')await child(index,sessionId,'queue');
   const afterProduction=await snapshot(sessionId),view=await read(sessionId);
   check(afterProduction.z4.status==='CHECKED'&&view.currentness==='CURRENT'&&view.capsule&&
    canonical(view.capsule.statement.finalState)===canonical(expected.finalState),'Z4_ACTUAL_PROOF_ORIGINAL_OUTPUT_MISMATCH');
   if(request.qualification){
    const q=afterProduction.z4.qualificationAttempt;
    const events=await Promise.all(afterProduction.z4.events.map(d=>store.artifact<{
     kind:string;detail:{attemptId?:string;detail?:{operation?:string;newProofs?:number;failure?:string}}
    }>(ctx,'event',d)));
    const owned=events.filter(e=>e.detail.attemptId===q?.attemptId);
    check(q?.status==='COMPLETE'&&q.caseId===request.qualification.caseId&&
     q.registrationSha256===request.qualification.registrationSha256&&afterProduction.z4.attempts===1&&
     Number.isSafeInteger(q.costEventSlotsRemaining)&&q.costEventSlotsRemaining>=0&&
     afterProduction.z4.events.length+q.costEventSlotsRemaining<=store.EVENT_LIMIT&&
     owned.filter(e=>e.kind==='QUALIFICATION_STARTED').length===1&&
     owned.filter(e=>e.kind==='QUALIFICATION_COMPLETE'&&e.detail.detail?.newProofs===1).length===1&&
     owned.filter(e=>e.kind==='QUALIFICATION_NATIVE_COST'&&e.detail.detail?.operation==='prove'&&
      e.detail.detail.failure===undefined).length===1,'Z4_ACTUAL_FRESH_QUALIFICATION_EVIDENCE_REQUIRED');
   }
   if(c.recoverProducer)check(afterProduction.claimFence>=before.claimFence+3&&afterProduction.attempts.length>=3&&
    afterProduction.z4.events.length>before.z4.events.length,'Z4_ORIGINAL_FENCE_OR_RECOVERY_EVIDENCE_MISSING');
   const audit=await post(owner.page,owner.bearer,'execution-proof-audit',{sessionId});
   check(audit.status===200&&audit.body.status==='VERIFIED_COMPUTATION_ONLY','Z4_PINNED_REAL_VERIFIER_AUDIT_FAILED');
   const useKey=randomUUID(),capsuleDigest=view.capsule!.digest;
   if(c.recoverOwner){
    await child(index,sessionId,'consume','OWNER_RESULT',{bearer:owner.bearer,capsuleDigest,idempotencyKey:useKey});
    const acknowledged=await snapshot(sessionId);
    const recovered=await post(owner.page,owner.bearer,'execution-proof-consume',{sessionId,capsuleDigest,idempotencyKey:useKey});
    check(recovered.status===200&&recovered.body.nativeOwnerConsumed===true&&recovered.body.replayed===true,
     'Z4_DURABLE_OWNER_ACK_RECOVERY_NOT_OBSERVED');
    const redelivered=await snapshot(sessionId);
    check(acknowledged.z4.delivery?.useId===redelivered.z4.delivery?.useId&&
     acknowledged.z4.delivery?.resultDigest===redelivered.z4.delivery?.resultDigest,'Z4_ACKNOWLEDGED_OWNER_RESULT_REPLACED');
   }else{
    await panel.getByRole('button',{name:'Recheck execution proof',exact:true}).click();
    const used=owner.page.waitForResponse(r=>r.request().method()==='POST'&&
     new URL(r.url()).pathname==='/api/centropy/company-brain/execution-proof-consume');
    await panel.getByRole('button',{name:'Use exact native owner guard',exact:true}).click({timeout:45000});
    const response=await used;
    check(response.status()===200&&(await response.json() as {nativeOwnerConsumed?:boolean}).nativeOwnerConsumed===true,
     'Z4_MOUNTED_NATIVE_OWNER_USE_FAILED');
   }
   const end=Math.min(Date.parse(request.deadlineAt),Date.now()+180000);
   let completed:Record<string,unknown>|undefined;
   while(Date.now()<end){
    const response=await owner.page.request.get('/api/centropy/works/'+c.workId,{headers:{authorization:owner.bearer},timeout:25000});
    check(response.status()===200,'Z4_NATIVE_WORK_READ_FAILED');
    const work=(await response.json() as {work:Record<string,unknown>}).work;
    if((work.work as {status:string}).status==='completed'){completed=work;break;}
    await delay(1000);
   }
   check(completed,'Z4_ORIGINAL_CANONICAL_WORK_COMPLETION_NOT_OBSERVED');
   const plans=completed!.planRevisions as Array<{id:string;status:string;completionProof?:{verified?:boolean}}>;
   check(plans.some(p=>p.id===request.workRevisionRef.id&&p.status==='completed'&&p.completionProof?.verified===true),
    'Z4_EXACT_NATIVE_PLAN_COMPLETION_PROOF_REQUIRED');
   check((completed!.queryExecutions as Array<{intent:string;status:string}>).some(q=>q.intent==='execution_proof_capsule_v1'&&q.status==='succeeded'),
    'Z4_CANONICAL_NATIVE_QUERY_EXECUTION_REQUIRED');
   await store.workSnapshot(ctx,request,undefined,true);
   await owner.page.reload();panel=owner.page.getByRole('region',{name:'Execution proof capsule'});
   await expect(panel).toBeVisible({timeout:45000});
   await panel.getByRole('button',{name:'Recheck execution proof',exact:true}).click();
   await expect(panel).toContainText('acknowledged',{timeout:45000});
   await expect(panel.getByRole('heading',{name:'Checked integer result'})).toBeVisible();
   const screenshot=await panel.screenshot({path:join(evidence,'case-'+index+'-mounted.png'),animations:'disabled'});
   const after=await snapshot(sessionId),readAfter=await read(sessionId);
   check(before.originalDigest===after.originalDigest&&sha(before.reservationRef)===sha(after.reservationRef)&&
    sha(before.allocationRef)===sha(after.allocationRef)&&before.deadlineAt===after.deadlineAt&&
    after.z4.cpuReservedSeconds>=before.z4.cpuReservedSeconds&&after.z4.retainedBytes>=before.z4.retainedBytes,
   'Z4_ORIGINAL_RESPONSIBILITY_OR_REMAINING_BUDGET_RESET');
   if(request.qualification)check(after.z4.qualificationAttempt?.attemptId===afterProduction.z4.qualificationAttempt!.attemptId&&
    after.z4.qualificationAttempt.costEventSlotsRemaining<=afterProduction.z4.qualificationAttempt!.costEventSlotsRemaining&&
    after.z4.events.length+after.z4.qualificationAttempt.costEventSlotsRemaining<=store.EVENT_LIMIT,
   'Z4_ORIGINAL_QUALIFICATION_EVENT_RESERVE_RESET');
   check(view.currentObligations.refs.every(r=>readAfter.currentObligations.refs.some(n=>n.id===r.id&&n.status===r.status)),
    'Z4_EXISTING_S6_OBLIGATION_CHANGED');
   owners.add(request.ownerContract.owner);
   report.cases.push({name:c.name,owner:request.ownerContract.owner,sessionId,workId:c.workId,workInputId:c.workInputId,
    qualification:request.qualification?{caseId:request.qualification.caseId,freshProofs:1,
     attemptId:afterProduction.z4.qualificationAttempt!.attemptId,protectedAdmission:'NOT_RUN',eligibleReuseN:0}:null,
    definitionDigest:sha(acceptedDefinition(request)),expectedFileSha256:c.expectedSha256,expectedProvenance:expected.provenance,
    originalInteger:full,before,after,completedWorkSha256:sha(completed),screenshotSha256:sha(screenshot),status:'PASSED_NATIVE_ORDINARY_ONLY'});
   await flush();
  }
  check(owners.has('S3')&&owners.has('S4'),'Z4_BOTH_CONCRETE_NATIVE_OWNERS_REQUIRED');
  for(const n of a.scope.negatives){
   const actor=n.credentialsEnvironmentVariable?await login(n.credentialsEnvironmentVariable):owner;
   if(n.kind==='tenant')check(actor.identity.tenantId!==a.scope.tenantId,'Z4_REAL_FOREIGN_TENANT_ACTOR_REQUIRED');
   if(n.kind==='authority')check((actor.identity.employeeId??actor.identity.userId)!==a.scope.principalId,
    'Z4_REAL_DISTINCT_AUTHORITY_ACTOR_REQUIRED');
   const response=await post(actor.page,actor.bearer,n.operation,JSON.parse(await readFile(n.bodyFile,'utf8')));
   check(response.status===n.expectedStatus&&(response.body.predicate??response.body.code)===n.expectedPredicate,
    'Z4_NATIVE_NEGATIVE_EXACT_PREDICATE_MISMATCH');
   report.negatives.push({kind:n.kind,operation:n.operation,status:response.status,predicate:n.expectedPredicate,
    requestSha256:n.bodySha256,responseSha256:sha(response.body),passed:true});
   await flush();
  }
  report.status='PASSED_NATIVE_ORDINARY_ENGINEERING_ONLY';report.nativeOwner='OBSERVED_BOTH_S3_AND_S4';
 }catch(error){
  report.status='FAILED';report.failure=String((error as Error)?.message).match(/^[A-Z][A-Z0-9_]{0,159}$/)?.[0]??'Z4_NATIVE_REPLAY_FAILED';
  process.exitCode=1;
 }finally{
  const reaped=await Promise.allSettled([...children].map(reapOwned));
  if(reaped.some(r=>r.status==='rejected')){
   report.status='FAILED';report.failure='Z4_OWNED_CHILD_REAP_FAILED';process.exitCode=1;
  }
  for(const context of contexts)await context.close().catch(()=>undefined);
  await browser?.close().catch(()=>undefined);
  try{await pool?.end();}catch{report.status='FAILED';report.failure='Z4_DB_POOL_CLOSE_FAILED';process.exitCode=1;}
  await flush();
 }
 console.log(JSON.stringify({status:report.status,cases:report.cases.length,negatives:report.negatives.length,
  nativeOwner:report.nativeOwner,protectedAdmission:report.protectedAdmission,eligibleReuseN:0}));
}

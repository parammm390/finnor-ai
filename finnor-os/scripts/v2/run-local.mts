/** Frozen development oracle at real boundaries, not post-code unit tests.
 * Retains every assigned case, including failures and unavailable evidence. */
import {strict as assert} from 'node:assert';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {configureTenantVertical,withTenantTransaction,createEmployeeConversationThread,loadEmployeeConversationThread,receiveWork,closePool,getPool} from '@finnor/db';
import {createEvidenceSource,appendEvidenceVersion,searchEvidence} from '@finnor/memory';
import {createStrategy,transitionStrategy,createOpportunity,createOpportunityInvestmentCase,activateInvestmentCase,createDeal,createInvestmentCase,createUnderwritingModel,createUnderwritingModelVersion,getUnderwritingRun,type PeMutationContext} from '@finnor/private-equity';
import {putAllocationResource} from '../../packages/private-equity/src/allocation-store';
import {canonical,hash,reference,rightsBinding,methodIdentity} from '../../packages/private-equity/src/primary-diligence/store';
import {nativeHttpFixture} from '../p7/native-http-fixture.mts';
import {disposablePlatform} from './platform.mts';
import {PrimaryUnderwritingScopeSchema,type DiligenceAssertion,type PrimaryRecord} from '@finnor/shared-types';
import {browserHttpFixture} from './browser-http-fixture.mts';
import {mountedController} from './mounted-controller.mts';
import {packagedRuntime} from './packaged-runtime.mts';
import {groundIcSourceReference} from '../../packages/private-equity/src/ic-repository';
import {compareUnderwritingRunToArtifact,projectUnderwritingOutputs} from '../../packages/private-equity/src/underwriting-artifacts';
import {verificationBudget} from './verification-budget.mts';

const repo=resolve(import.meta.dirname,'../../..'),cumulativePlanPath=process.env.FINNOR_V2_CUMULATIVE_PLAN;
const output=process.env.FINNOR_V2_EVIDENCE_DIR??join(repo,'scope-v/v2-primary-reality-due-diligence/evidence','run-'+new Date().toISOString().replace(/[:.]/g,'-'));
if(process.env.FINNOR_V2_EVIDENCE_DIR)assert(cumulativePlanPath&&resolve(output)===output&&output.startsWith(join(repo,'scope-v/v2-primary-reality-due-diligence/evidence')+'/'));
const keyboardRecovery=process.env.FINNOR_V2_KEYBOARD_RECOVERY==='1',sessionRecovery=process.env.FINNOR_V2_SESSION_RECOVERY==='1',uiRecovery=process.env.FINNOR_V2_UI_RECOVERY==='1',qualification=keyboardRecovery||sessionRecovery||uiRecovery||process.env.FINNOR_V2_QUALIFICATION==='1',continuation=qualification||process.env.FINNOR_V2_CONTINUATION==='1',closure=continuation||process.env.FINNOR_V2_CLOSURE==='1';
if(cumulativePlanPath)assert(isAbsolute(cumulativePlanPath)&&closure&&!continuation&&!process.env.FINNOR_V2_MOUNTED&&!process.env.FINNOR_V2_PACKAGED);
const closurePlan=closure?JSON.parse(await readFile(cumulativePlanPath??join(repo,'scope-v/v2-primary-reality-due-diligence',keyboardRecovery?'keyboard-focus-verification-plan.json':sessionRecovery?'session-recovery-verification-plan.json':uiRecovery?'ui-recovery-verification-plan.json':qualification?'qualification-phase-plan.json':continuation?'continuation-phase-plan.json':'closure-phase-plan.json'),'utf8')):null;
if(cumulativePlanPath){
 assert.equal(closurePlan.schema,'finnor.v2.cumulative-custody-assignment.v1');
 assert.equal(closurePlan.priorAllocationsUnchanged,true);
 assert(Number.isSafeInteger(closurePlan.maximumWallSeconds)&&closurePlan.maximumWallSeconds>0&&closurePlan.maximumWallSeconds<=600);
 const began=Date.parse(closurePlan.startedAt),ends=Date.parse(closurePlan.hardStop);
 assert(Number.isFinite(began)&&Number.isFinite(ends)&&began<=Date.now()&&ends>began&&ends-began<=closurePlan.maximumWallSeconds*1000);
 assert.equal(closurePlan.limits.newSyntheticCpuAvailabilityMicros,'4000000000');
 assert.equal(closurePlan.limits.newSyntheticCashAvailabilityMicroUsd,'1000000000');
 assert.equal(output,join(repo,closurePlan.outputRelative));
}
if(closure&&Date.now()>=Date.parse(closurePlan.hardStop))throw Error('REGISTERED_CLOSURE_PHASE_EXHAUSTED');
if(keyboardRecovery){
 assert(!sessionRecovery&&!uiRecovery&&!process.env.FINNOR_V2_PACKAGED&&!process.env.FINNOR_V2_CASE_FILTER&&!process.env.FINNOR_V2_SHORTER_DEADLINE_MS);
 assert.equal(process.env.FINNOR_V2_MOUNTED,'1');assert.equal(closurePlan.limits.mountedAttempts,1);
 await writeFile(join(repo,'scope-v/v2-primary-reality-due-diligence/keyboard-focus-mounted-allocation.json'),JSON.stringify({schema:'finnor.v2.mounted-allocation.v1',allocatedAt:new Date().toISOString(),output,plan:'keyboard-focus-verification-plan.json',priorAllocationsUnchanged:true},null,2)+'\n',{flag:'wx'});
}
if(sessionRecovery){
 assert(!uiRecovery&&!process.env.FINNOR_V2_PACKAGED&&!process.env.FINNOR_V2_CASE_FILTER&&!process.env.FINNOR_V2_SHORTER_DEADLINE_MS);
 assert.equal(process.env.FINNOR_V2_MOUNTED,'1');assert.equal(closurePlan.limits.mountedAttempts,1);
 const correction=process.env.FINNOR_V2_SESSION_ORACLE_RETRY==='1'?JSON.parse(await readFile(join(repo,'scope-v/v2-primary-reality-due-diligence/session-oracle-correction.json'),'utf8')):null;
 if(correction){
  assert.equal(correction.maximumSupplementaryAttempts,1);
  assert(Date.now()<Date.parse(correction.originalVerificationCut));
  closurePlan.hardStop=correction.originalVerificationCut;closurePlan.sessionOracleCorrection=correction;
 }
 await writeFile(join(repo,'scope-v/v2-primary-reality-due-diligence',correction?'session-oracle-supplement-allocation.json':'session-recovery-mounted-allocation.json'),JSON.stringify({schema:'finnor.v2.mounted-allocation.v1',allocatedAt:new Date().toISOString(),output,plan:'session-recovery-verification-plan.json',correction,priorAllocationsUnchanged:true},null,2)+'\n',{flag:'wx'});
}
let uiRecoveryCut=Infinity,uiRecoverySetupCorrection:any=null;
if(uiRecovery){
 assert.equal(process.env.FINNOR_V2_MOUNTED,'1','UI_RECOVERY_ONLY_REGISTERS_MOUNTED_WORK');
 assert(!process.env.FINNOR_V2_PACKAGED&&!process.env.FINNOR_V2_CASE_FILTER&&!process.env.FINNOR_V2_SHORTER_DEADLINE_MS);
 assert.equal(closurePlan.limits.mountedAttempts,1);
 const scope=join(repo,'scope-v/v2-primary-reality-due-diligence');
 uiRecoverySetupCorrection=JSON.parse(await readFile(join(scope,'ui-recovery-setup-correction.json'),'utf8'));
 const failed=JSON.parse(await readFile(join(scope,uiRecoverySetupCorrection.failedEvidence),'utf8'));
 assert.equal(failed.status,'FAIL');assert.equal(failed.cases.length,1);
 assert(failed.cases[0].failure.message.includes('PRIMARY_FIXED_CAPACITY_UNKNOWN'));
 assert.equal(failed.effectiveDeadlineAt,uiRecoverySetupCorrection.originalVerificationCut);
 uiRecoveryCut=Date.parse(failed.effectiveDeadlineAt);
 assert(Date.now()<uiRecoveryCut,'ORIGINAL_UI_RECOVERY_ALLOCATION_EXPIRED');
 closurePlan.limits.newSyntheticCashAvailabilityMicroUsd=uiRecoverySetupCorrection.newSyntheticCashAvailabilityMicroUsd;
 closurePlan.limits.newSyntheticCpuAvailabilityMicros=uiRecoverySetupCorrection.newSyntheticCpuAvailabilityMicros;
 await writeFile(join(scope,'ui-recovery-setup-retry.json'),JSON.stringify({schema:'finnor.v2.setup-retry.v1',allocatedAt:new Date().toISOString(),output,originalVerificationCut:failed.effectiveDeadlineAt,failedEvidence:uiRecoverySetupCorrection.failedEvidence,priorAllocationsUnchanged:true},null,2)+'\n',{flag:'wx'});
}
await mkdir(output,{recursive:true});
const rows:any[]=[],children=new Set<ChildProcess>(),startedAt=new Date().toISOString(),identity=await methodIdentity();
const runSeconds=process.env.FINNOR_V2_PACKAGED==='1'?180:process.env.FINNOR_V2_CASE_FILTER?600:closure||process.env.FINNOR_V2_MOUNTED==='1'?1200:900;
const shorterDeadlineMs=process.env.FINNOR_V2_SHORTER_DEADLINE_MS?Number(process.env.FINNOR_V2_SHORTER_DEADLINE_MS):runSeconds*1000;
if(!Number.isSafeInteger(shorterDeadlineMs)||shorterDeadlineMs<=0||shorterDeadlineMs>runSeconds*1000)throw Error('SHORTER_VERIFICATION_DEADLINE_ONLY');
const budget=verificationBudget(Math.min(closurePlan?Date.parse(closurePlan.hardStop):Infinity,uiRecoveryCut,Date.parse(startedAt)+runSeconds*1000,Date.parse(startedAt)+shorterDeadlineMs));
const deadlineShorteningEvents:any[]=[],initialDeadlineAt=budget.deadlineAt;
const files=await Promise.all((await readdir(import.meta.dirname)).filter(p=>/\.(mts|mjs)$/.test(p)).sort().map(async name=>({path:'finnor-os/scripts/v2/'+name,sha256:createHash('sha256').update(await readFile(join(import.meta.dirname,name))).digest('hex')})));
for(const name of (await readdir(resolve(import.meta.dirname,'../acquisition'))).filter(name=>/\.(mts|mjs)$/.test(name)).sort())files.push({path:'finnor-os/scripts/acquisition/'+name,sha256:createHash('sha256').update(await readFile(resolve(import.meta.dirname,'../acquisition',name))).digest('hex')});
files.push({path:'src/components/centropy/thread/mission-submission.ts',sha256:createHash('sha256').update(await readFile(resolve(import.meta.dirname,'../../../src/components/centropy/thread/mission-submission.ts'))).digest('hex')});
files.push({path:'finnor-os/scripts/p7/native-http-fixture.mts',sha256:createHash('sha256').update(await readFile(resolve(import.meta.dirname,'../p7/native-http-fixture.mts'))).digest('hex')});
for(const name of ['economic-fixtures.mts','ledger-fixture.mts'])files.push({path:'finnor-os/scripts/s7/'+name,sha256:createHash('sha256').update(await readFile(resolve(import.meta.dirname,'../s7',name))).digest('hex')});
files.push({path:'finnor-os/scripts/s4/operating-profit-fixtures.ts',sha256:createHash('sha256').update(await readFile(resolve(import.meta.dirname,'../s4/operating-profit-fixtures.ts'))).digest('hex')});
await writeFile(join(output,'pre-run-freeze.json'),JSON.stringify({schema:'finnor.v2.run-freeze.v1',startedAt,command:'node --import=tsx scripts/v2/run-local.mts',harnessMode:process.env.FINNOR_V2_MOUNTED==='1'?'MOUNTED_PREREGISTERED_BOUNDARIES':'DEVELOPMENT_CAMPAIGN',caseFilter:process.env.FINNOR_V2_CASE_FILTER??null,apiPoolLimit:process.env.FINNOR_V2_ONE_CLIENT_PROOF==='1'?1:'LOCAL_DEFAULT',identity,files,node:process.version,productionAuthBypass:false,
 oracle:'Frozen synthetic source truth in failure-model.md, administered only by separate counterparty process. Not independently sealed blind-domain custody.',packagedOnly:process.env.FINNOR_V2_PACKAGED==='1',closureAssignment:closurePlan,uiRecoverySetupCorrection,deadlineSeconds:runSeconds,effectiveDeadlineAt:new Date(budget.deadlineAt).toISOString(),shorterDeadlineProbe:process.env.FINNOR_V2_SHORTER_DEADLINE_MS!==undefined,shorterDeadlineProbeAmendment:qualification&&process.env.FINNOR_V2_SHORTER_DEADLINE_MS?JSON.parse(await readFile(join(repo,'scope-v/v2-primary-reality-due-diligence/qualification-deadline-probe-amendment.json'),'utf8')):null,cleanInstall:false,LinuxImageProof:'NOT_RUN',V1Proof:'BLOCKED_PENDING_IMMUTABLE_HANDOFF'},null,2)+'\n');
let platform:Awaited<ReturnType<typeof disposablePlatform>>|undefined,http:Awaited<ReturnType<typeof nativeHttpFixture>>|Awaited<ReturnType<typeof browserHttpFixture>>|undefined,source:ChildProcess|undefined,publicDescriptor:any,scopeDirectory='';
const outcome=()=>rows.some(r=>r.status==='FAIL')?'FAIL':process.env.FINNOR_V2_MOUNTED==='1'?'PARTIAL_MOUNTED_DEVELOPMENT':rows.some(r=>r.status==='NOT_RUN')?'PARTIAL_LOCAL_DEVELOPMENT':'PASS_LOCAL_DEVELOPMENT';
const save=async()=>writeFile(join(output,'results.json'),JSON.stringify({schema:'finnor.v2.e2e.v1',startedAt,finishedAt:new Date().toISOString(),status:outcome(),caseFilter:process.env.FINNOR_V2_CASE_FILTER??null,cases:rows,
 effectiveDeadlineAt:new Date(budget.deadlineAt).toISOString(),initialDeadlineAt:new Date(initialDeadlineAt).toISOString(),deadlineShorteningEvents,deadlineExhausted:budget.signal.aborted||Date.now()>=budget.deadlineAt,
 boundaries:'signed Bearer -> actual Company Brain POST/auth/user lookup -> canonical Opportunity/Work -> existing S5 resources/reservation -> actual queue/final worker registration in separate process -> separate primary source -> canonical Evidence versions -> separate checker -> exact underwriting',
 qualification:{engineering:'DEVELOPMENT_ONLY',blindDomain:'NOT_RUN',S8:'NOT_ADMITTED',LIVE:'NOT_AUTHORIZED',field:'NOT_RUN',economicGain:'NOT_ESTABLISHED',LinuxImage:'NOT_RUN',hostedSupabase:'NOT_EXERCISED',V1:'BLOCKED'},rerun:'cd finnor-os && node --import=tsx scripts/v2/run-local.mts'},null,2)+'\n');
async function test(id:string,input:unknown,invariant:string,fn:()=>Promise<unknown>){
 if(budget.signal.aborted||Date.now()>=budget.deadlineAt){rows.push({id,input,invariant,status:'NOT_RUN',reason:'REGISTERED_VERIFICATION_DEADLINE_EXHAUSTED'});await save();return;}
 if(process.env.FINNOR_V2_CASE_FILTER&&!process.env.FINNOR_V2_CASE_FILTER.split(',').includes(id)){rows.push({id,input,invariant,status:'NOT_RUN'});await save();return;}
 const start=performance.now(),caseStartedAt=new Date().toISOString();let observed:unknown;
 try{observed=await fn();budget.assertCurrent();rows.push({id,input,invariant,status:'PASS',startedAt:caseStartedAt,finishedAt:new Date().toISOString(),observed,elapsedMs:performance.now()-start});}
 catch(error){rows.push({id,input,invariant,status:'FAIL',startedAt:caseStartedAt,finishedAt:new Date().toISOString(),failure:{message:(error as Error).message,stack:(error as Error).stack},...(observed===undefined?{}:{lateObserved:observed}),elapsedMs:performance.now()-start});}
 console.log(JSON.stringify({id,status:rows.at(-1)!.status,failure:rows.at(-1)!.failure?.message}));await save();
}
async function rpc(message:any){
 const id=randomUUID();return new Promise<any>((yes,no)=>{const timer=setTimeout(()=>{source!.off('message',listen);no(Error('CONTROLLED_SOURCE_RPC_DEADLINE'));},10000),listen=(m:any)=>{if(m.id!==id)return;clearTimeout(timer);source!.off('message',listen);yes(m);};source!.on('message',listen);source!.send({...message,id});});
}
async function worker(onStarted?:(child:ChildProcess)=>Promise<void>,expectedSignal?:NodeJS.Signals,runtimeEnvironment?:NodeJS.ProcessEnv,drainReady=false){
 budget.assertCurrent();
 const env:NodeJS.ProcessEnv={...process.env,DATABASE_URL:platform!.workerUrl,...runtimeEnvironment};
 if(runtimeEnvironment?.NODE_ENV==='production'){delete env.AUTH_DEV_BYPASS;delete env.ALLOW_PLAINTEXT_ENV_SECRETS;delete env.DATABASE_URL;}
 const child=spawn(process.execPath,['--import=tsx',join(import.meta.dirname,'physical-worker.mts'),...(drainReady?['--drain-ready']:[])],{cwd:resolve(import.meta.dirname,'../..'),env,stdio:['ignore','pipe','pipe']});children.add(child);
 let head='',tail='',captured=0;const capture=(b:Buffer)=>{const text=b.toString();captured+=text.length;if(head.length<16384)head=(head+text).slice(0,16384);tail=(tail+text).slice(-65536);};child.stdout.on('data',capture);child.stderr.on('data',capture);
 const ended=once(child,'exit'),stop=()=>child.kill('SIGKILL'),timer=setTimeout(stop,budget.remainingMs(90000));budget.signal.addEventListener('abort',stop,{once:true});
 await onStarted?.(child);
 const [code,signal]=await ended;clearTimeout(timer);budget.signal.removeEventListener('abort',stop);children.delete(child);
 // No environment or bearer/credential content is retained in worker logs.
 const log=captured<=65536?tail:head+'\n['+Math.max(0,captured-head.length-tail.length)+' middle log characters omitted]\n'+tail;
 const redacted=log.replace(/Bearer [^\s"]+/g,'Bearer [REDACTED]').replace(/postgres(?:ql)?:\/\/[^@\s]+@/g,'postgres://[REDACTED]@');
 await writeFile(join(output,'worker-'+child.pid+'.log'),redacted);
 budget.assertCurrent();if(expectedSignal){assert.equal(code,null);assert.equal(signal,expectedSignal);}else assert.equal(code,0,`ACTUAL_WORKER_EXIT_${code}_${signal}: ${redacted.slice(-2000)}`);
 return redacted;
}
async function killAfterSourceAcceptance(child:ChildProcess){
 await new Promise<void>((yes,no)=>{
  const cleanup=()=>{clearTimeout(timer);source!.off('message',listen);child.off('exit',early);};
  const early=()=>{cleanup();no(Error('WORKER_EXITED_BEFORE_PHYSICAL_ACCEPTANCE'));};
  const listen=(message:any)=>{if(message.type!=='accepted')return;cleanup();if(!child.kill('SIGKILL'))return no(Error('OWNED_WORKER_SIGKILL_FAILED'));yes();};
  const timer=setTimeout(()=>{cleanup();no(Error('PHYSICAL_ACCEPTANCE_DEADLINE'));},20000);
  source!.on('message',listen);child.once('exit',early);
 });
}
async function continueOriginal(read:any){return call('primary-advance',{...read.advanceBindings,programmeRef:read.ref,expectedRevision:Number(read.ref.revision),triggerRef:read.nextObligationRefs[0]??read.ref},202);}
async function sourceCalls(f:any){return (await rpc({type:'inspect'})).calls.filter((c:any)=>f.sourceProfiles.some((p:any)=>p.profileId===c.sourceProfileId));}
const periodStart='2025-01-01T00:00:00.000Z',periodEnd='2025-12-31T23:59:59.000Z',validFrom='2026-01-01T00:00:00.000Z',expiresAt=new Date(Date.now()+3600000).toISOString();
const fixtureRef=(owner:string,id:string)=>reference(owner,id,1,{fixture:id,qualification:'SYNTHETIC_DEVELOPMENT_NOT_LIVE'});
const tenant=randomUUID(),actor=randomUUID(),other=randomUUID(),company=randomUUID(),foreignCompany=randomUUID();
const ctx:PeMutationContext={auth:{tenantId:tenant,userId:actor,employeeId:actor,role:'owner'},provenance:{sourceSystem:'V2:registered-disposable-E2E',createdBy:actor}};
let root:any,caseId:string,startingRef:any,resourceRefs:any[],lastFacility:any,lastRevenue:any;
async function call(op:string,body:unknown,expected=200){budget.assertCurrent();const result=await http!.call(op,body);assert.equal(result.status,expected,JSON.stringify(result));return result.body;}
async function governance(body:any){return (await call('primary-governance-put',{root,body,expectedRef:null},201)).ref;}
async function build(kind:'facility'|'revenue',options:any={}){
 budget.assertCurrent();
 const environment=options.environment??'DEVELOPMENT';
 if(qualification&&process.env.FINNOR_V2_SHORTER_DEADLINE_MS)options={...options,singleSource:true,source:{...options.source,delayMs:10000}};
 const authorityId=randomUUID(),semanticsId=randomUUID(),mandateId=randomUUID(),grantId=randomUUID(),consentId=randomUUID(),profileIds=[randomUUID(),...(kind==='facility'&&!options.singleSource?[randomUUID()]:[])];
 const channel='synthetic-lender-primary',decision=fixtureRef('BUSINESS_OWNER','registered-primary-decision:'+root.entityId),pricebook=fixtureRef('S5','synthetic-fixed-primary-pricebook');
 const authority={schema:'finnor.primary-authority.v1',profileId:authorityId,revision:1,issuingPrincipalId:actor,legalEntityIds:[company],jurisdictions:['SYNTHETIC_US'],instrumentAndTransactionClasses:['SYNTHETIC_COMPANY_FINANCIAL_RECORDS'],
  activities:['ACCESS_RECORDS','INTERPRET','CONTACT','DISCLOSE'].map(activity=>({activity,actorIds:[actor],channelIds:[channel]})),professionalRequirements:[],approvedTemplateRefs:[fixtureRef('S6','fixed-primary-request-v1')],negotiationBoundsRef:null,
  disclosureRules:['EXACT_ASSERTION_SCOPE_ONLY'],confidentialityRules:['AUTHORIZED_COMPANY_SCOPE_ONLY'],contactLimits:{maximumRequests:64,minimumSpacingMs:0,suppressedParticipantIds:[]},
  exposureLimitMicroUsd:'2000000',reservationRequired:true,approvalRef:fixtureRef('BUSINESS_OWNER','synthetic-ordinary-source-approval'),validFrom,expiresAt,
  escalationConditions:['UNAUTHORIZED_OR_UNRESOLVED'],revocationConditions:['OWNER_REVOKED'],legalReviewEvidenceRefs:[fixtureRef('BUSINESS_OWNER','synthetic-record-purpose-only')],policyRevision:'synthetic-1',environment};
 const authorityRef=await governance(authority),review=fixtureRef('BUSINESS_OWNER','synthetic-explicit-recognition-profile-not-professional-certification');
 const rules=kind==='facility'?[{field:'outstanding',recordKinds:['FACILITY'],treatment:'EXACT_RECORDED_VALUE',requiredWitnessFields:['ledgerState'],excludedInterpretations:['ENTERPRISE_TOTAL_DEBT']}]:
  [{field:'classification',recordKinds:['BANK_TRANSACTION'],treatment:'EXACT_RECORDED_STATE',requiredWitnessFields:['ledgerState'],excludedInterpretations:['CASH_IS_REVENUE']},
   {field:'amount',recordKinds:['BANK_TRANSACTION'],treatment:'EXACT_RECORDED_VALUE',requiredWitnessFields:['ledgerState'],excludedInterpretations:['ANNUAL_REVENUE']},
   {field:'credit',recordKinds:['CREDIT_MEMO'],treatment:'EXACT_RECORDED_VALUE',requiredWitnessFields:['ledgerState'],excludedInterpretations:['ANNUAL_REVENUE']},
   {field:'revenue',recordKinds:['BANK_TRANSACTION','CREDIT_MEMO'],treatment:'EARNED_REVENUE',requiredWitnessFields:['performance','recognition','cutoff','grossNetTreatment','nonRevenueExclusions'],excludedInterpretations:['CASH_IS_EARNED_REVENUE']}];
 const meaning={schema:'finnor.primary-reference-semantics.v1',profileId:semanticsId,revision:1,issuerId:actor,acceptedBy:actor,authorityRef,legalEntityId:company,rules,grossNetTreatment:'SOURCE_SIGNED_GROSS_CREDIT_SEPARATE',recognitionRule:'PERFORMANCE_REQUIRED_OWNER_PROFILE',
  calendarRef:'SYNTHETIC_2025_CALENDAR',consolidationRef:'STANDALONE_TARGET_ONLY',professionalReviewRef:kind==='revenue'?review:null,environment,validFrom,expiresAt},semanticsRef=await governance(meaning);
 const members=[kind==='facility'?'lender-participant-1':'company-ledger-1'],rights=(await rightsBinding(ctx,root)).rightsRef;
 let sourceProfiles=profileIds.map((profileId,i)=>({schema:'finnor.primary-source-profile.v1',profileId,revision:1,issuer:'Synthetic independent lender',system:'Synthetic issuer primary ledger',legalEntityId:company,
  sourceClass:options.sourceClass??'EXTERNAL_AUTHORITATIVE_RECORD',sourceControl:options.sourceClass==='TARGET_CONTROLLED_RECORD'?'TARGET':'EXTERNAL_ISSUER',accountOrParticipantIds:members,products:['company-primary-records'],purpose:'PRIVATE_EQUITY_PRIMARY_DILIGENCE',channelId:channel,
  channelResolutionEvidenceRef:fixtureRef('S1','synthetic-issuer-resolved-channel'),endpoint:publicDescriptor.origin+'/primary',responsePublicKeyPem:publicDescriptor.publicKey,credentialRef:'source-'+profileId,
  authoritativeFields:kind==='facility'?['outstanding','ledgerState']:['classification','amount','credit','revenue','ledgerState','performance','recognition','cutoff','grossNetTreatment','nonRevenueExclusions'],
  respondentId:null,respondentRole:null,respondentKnowledge:[],respondentAuthorityRef:null,intermediary:null,availableHistory:{start:periodStart,end:periodEnd,reasons:[]},observationPredicates:['SIGNED_LEDGER_CUTOFF'],adapterVersion:'primary-records-http-v1',recovery:'IDEMPOTENT_REQUEST_WITH_STATUS',
  price:{pricebookRef:pricebook,maximumRequestMicroUsd:i?'100000':'50000',statusReadMicroUsd:'0'},rightsRef:rights,authorityEvidenceRefs:[fixtureRef('S1','synthetic-issuer-data-authority')],environment,admissionRef:null,validFrom,expiresAt}));
 if(options.admitSource)sourceProfiles=await Promise.all(sourceProfiles.map(options.admitSource));
 const sourceProfileRefs=[];for(const p of sourceProfiles)sourceProfileRefs.push(await governance(p));
 const consent={schema:'finnor.primary-consent.v1',consentId,revision:1,issuerId:actor,authorizedActorId:actor,legalEntityId:company,sourceProfileIds:profileIds,accountOrParticipantIds:members,products:['company-primary-records'],
  purposes:['PRIVATE_EQUITY_PRIMARY_DILIGENCE'],periodStart,periodEnd,validFrom,expiresAt,rightsRef:rights,permissionEvidenceRef:fixtureRef('S1','synthetic-company-record-consent'),
  retention:{rawUntil:options.rawRetentionMs?new Date(Date.now()+options.rawRetentionMs).toISOString():expiresAt,derivativesUntil:expiresAt,retainAfterRevocation:true},disclosureRules:['EXACT_ASSERTION_SCOPE_ONLY'],environment},consentRef=await governance(consent);
 const semantics={legalEntityId:company,perimeter:[company],accountOrParticipantIds:members,periodStart,periodEnd,cutoff:periodEnd,currency:'USD',units:'dollars',scale:{numerator:'1',denominator:'1'},signConvention:'AS_RECORDED',
  basisRef:semanticsRef,grossNetTreatment:meaning.grossNetTreatment,recognitionRule:meaning.recognitionRule,calendarRef:meaning.calendarRef,consolidationRef:meaning.consolidationRef,timeBasis:'CUTOFF'};
 const assertion=(field:string,predicateKind:string,ids:string[],expect:any,kinds:string[],complete=true):DiligenceAssertion=>({
  assertionId:randomUUID(),revision:1,subject:{entityType:'external_organization',entityId:company},exactPredicate:kind==='facility'?'Establish outstanding liabilities in the exact permitted lender population, including facilities absent from management support.':field==='revenue'?'The target annual earned revenue for 2025 is USD 40,000,000 under the explicit performance basis.':'Establish the exact '+field+' for '+ids.join(', ')+' at the frozen company/period/basis.',
  predicateKind:predicateKind as any,field,economicRecordIds:ids,amountOrState:expect,semantics:semantics as any,startingSupportRefs:kind==='facility'?[]:[startingRef],knownGaps:['MISSING_PERMITTED_PRIMARY_EVIDENCE'],
  materiality:{decisionRef:decision,rationale:'Material to the exact Opportunity underwriting dependency, not an enterprise-total inference',threshold:{numerator:'1',denominator:'1'},dependencyRefs:[fixtureRef('BUSINESS_OWNER','scoped-underwriting:'+caseId)]},
  acceptableSourceClasses:['EXTERNAL_AUTHORITATIVE_RECORD'],observationPredicates:['SIGNED_LEDGER_CUTOFF'],requiredCoverage:{populationId:kind==='facility'?'permitted-lender-facilities':'company-2025-ledger',populationRevision:'population-v1',members,requiredRecordKinds:kinds,completePopulation:complete,
   measurementDesignRef:null,minimumCoverage:{numerator:'1',denominator:'1'},errorTolerance:{numerator:'0',denominator:'1'}},
 });
 const assertions=kind==='facility'?[assertion('outstanding','POPULATION_TOTAL',[],{kind:'UNKNOWN',reason:'NOT_IN_STARTING_SUPPORT'},['FACILITY'])]:
  [assertion('classification','RECORD_CLASSIFICATION',['borrowing-1'],{kind:'STATE',state:'SALE'},['BANK_TRANSACTION'],false),
   assertion('amount','RECORD_VALUE',['borrowing-1'],{kind:'UNKNOWN',reason:'AMOUNT_REQUIRES_PRIMARY_RECORD'},['BANK_TRANSACTION'],false),
   assertion('credit','RECORD_VALUE',['credit-1'],{kind:'EXACT',quantity:{numerator:'0',denominator:'1'}},['CREDIT_MEMO'],false),
   assertion('revenue','POPULATION_TOTAL',[],{kind:'EXACT',quantity:{numerator:'40000000',denominator:'1'}},['BANK_TRANSACTION','CREDIT_MEMO'])];
 const originalDeadline=options.deadlineMs?new Date(Date.now()+options.deadlineMs).toISOString():expiresAt;
 const mandate={schema:'finnor.primary-mandate.v1',mandateId,revision:1,issuingPrincipalId:actor,legalEntityId:company,objective:'Actually acquire missing evidence and independently establish only registered scoped claims',permittedPurpose:'PRIVATE_EQUITY_PRIMARY_DILIGENCE',decisionRef:decision,authorityProfileId:authorityId,sourceProfileIds:profileIds,assertionIds:assertions.map(a=>a.assertionId),
  stopping:{maxAcquisitions:options.limitRequests??32,deadline:originalDeadline,waitUntil:new Date(Math.min(Date.parse(originalDeadline),Date.now()+180000)).toISOString(),stopOnRequiredCoverage:true,contradictionRevalidationRequired:true},priorityRule:'MATERIAL_COVERAGE_PER_RESERVED_COST_THEN_DELAY',validFrom,expiresAt,environment},mandateRef=await governance(mandate);
 const reservation=options.sharedReservation??await call('primary-reserve-budget',{root,resourceRefs,maximumMicroUsd:'2000000',maximumCpuMicros:'100000000',idempotencyKey:randomUUID(),validUntil:expiresAt},201);
 const grant={schema:'finnor.primary-grant.v1',grantId,revision:1,issuingPrincipalId:actor,mandateId,legalEntityId:company,maximumMicroUsd:'2000000',maximumRequests:options.limitRequests??32,maximumNativeCpuMicros:'100000000',maximumMemoryBytes:'536870912',maximumHumanSeconds:0,maximumStoredBytes:4194304,
  pricebook:{ref:pricebook,cpuMicroUsdPerSecond:{numerator:'1000',denominator:'1'},storageMicroUsdPerByte:options.storageTariff??{numerator:'0',denominator:'1'},orchestrationMicroUsdPerSecond:{numerator:'1000',denominator:'1'},humanMicroUsdPerSecond:{numerator:'0',denominator:'1'}},reservationRef:reservation.reservationRef,retainedObligationRefs:[],expiresAt,environment},budgetGrantRef=await governance(grant);
 const record=(id:string,kind:string,fields:PrimaryRecord['fields']):PrimaryRecord=>({issuerRecordId:'issuer-'+id,economicId:id,revision:1,kind,legalEntityId:company,accountOrParticipantId:members[0]!,periodStart,periodEnd,currency:'USD',units:'dollars',basisDigest:semanticsRef.contentDigest,state:'POSTED',
  replacesEconomicId:null,reversesEconomicId:null,aliasOf:null,effectiveAt:periodEnd,observedAt:validFrom,fields,witnessFields:{ledgerState:'POSTED',performance:'NOT_ESTABLISHED',recognition:meaning.recognitionRule,cutoff:periodEnd,grossNetTreatment:meaning.grossNetTreatment,nonRevenueExclusions:'NOT_ESTABLISHED'},relatedParty:'NO'});
 const future=kind==='facility'?[record('additional-facility-1','FACILITY',{outstanding:{kind:'EXACT',quantity:{numerator:'5000000',denominator:'1'}}})]:
  [record('borrowing-1','BANK_TRANSACTION',{classification:{kind:'STATE',state:'BORROWING'},amount:{kind:'EXACT',quantity:{numerator:'3000000',denominator:'1'}},revenue:{kind:'UNKNOWN',reason:'BANK_RECORD_DOES_NOT_ESTABLISH_PERFORMANCE'}}),
   record('credit-1','CREDIT_MEMO',{credit:{kind:'EXACT',quantity:{numerator:'-800000',denominator:'1'}},revenue:{kind:'UNKNOWN',reason:'CREDIT_NOT_ANNUAL_REVENUE_ESTIMATE'}})];
 const configs=[];for(const p of sourceProfiles){const credential=randomBytes(24).toString('base64url');await writeFile(join(scopeDirectory,p.credentialRef),credential,{mode:0o600});
  configs.push({public:p,credential,records:typeof options.records==='function'?options.records(future):options.records??future,recordKinds:kind==='facility'?['FACILITY']:['BANK_TRANSACTION','CREDIT_MEMO'],...options.source});}
 await rpc({type:'configure',profiles:configs});
 const opened=options.work??await call('primary-open-work',{root,instruction:assertions[0]!.exactPredicate,idempotencyKey:randomUUID()},201);
 return {intake:{schema:'finnor.primary-diligence.v1',root,workId:opened.workId,expectedWorkInputId:opened.workInputId,idempotencyKey:randomUUID(),assertions,startingEvidenceRefs:[startingRef],mandateRef,authorityProfileRef:authorityRef,budgetGrantRef,sourceProfileRefs,consentRefs:[consentRef],referenceSemanticsRefs:[semanticsRef],predecessorRef:null,mode:environment==='LIVE'?'protected':'ordinary_disposable'},assertions,sourceProfiles,consent,consentRef,authorityRef,semanticsRef,budgetGrantRef,reservation,mandate,grant};
}
async function finish(f:any){const accepted=await call('primary-submit',f.intake,202);await worker();const read=await call('primary-read',{programmeId:accepted.programmeId});return {...read,accepted};}
function scopeOf(a:DiligenceAssertion){return PrimaryUnderwritingScopeSchema.parse({predicateKind:a.predicateKind,field:a.field,economicRecordIds:a.economicRecordIds,semantics:a.semantics,requiredCoverage:a.requiredCoverage,acceptableSourceClasses:a.acceptableSourceClasses});}
async function model(a:DiligenceAssertion,scope:any,nodeId='facility'){
 const base={valueType:'decimal',unit:'money',currency:'USD',shape:'scalar'} as const;
 const m=await createUnderwritingModel(ctx,{investmentCaseId:caseId,modelKey:'primary-'+randomUUID(),name:'Exact primary scope, not enterprise-total debt'});
 const version=await createUnderwritingModelVersion(ctx,{modelId:String(m.id),definition:{schemaVersion:'underwriting-model-ir.v1',modelKey:String(m.modelKey??m.model_key),modelVersion:'1',financialConventionVersion:'finnor-pe-lbo/1.0.0',minimumEngineVersion:'finnor-underwriting-engine/1.0.0',periodDefinition:{frequency:'annual',forecastStart:'2026-01-01',count:1},nodes:[
  {id:nodeId,kind:'input',...base,dependencies:[],required:true,allowedTruthClasses:['OBSERVED_FACT'],source:{kind:'explicit'},primaryEvidenceScope:scope},
  {id:'scoped_output',kind:'output',...base,dependencies:[nodeId],sourceNodeId:nodeId},
 ],circularBlocks:[]}});
 return String(version.id);
}
try{
 platform=await disposablePlatform();
 await platform.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'Synthetic V2 target')",[tenant,randomUUID()]);
 await platform.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$3,$4,'owner','active','Synthetic V2 owner'),($2,$3,$5,'owner','active','Synthetic other owner')",[actor,other,tenant,actor+'@test.invalid',other+'@test.invalid']);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:actor,sourceSystem:'V2:disposable-E2E'});
 await platform.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'synthetic-v2-target','Synthetic Target A','other')",[company,tenant]);
 const strategy=await createStrategy(ctx,{name:'Synthetic existing PE strategy'});await transitionStrategy(ctx,{strategyId:String(strategy.row.id),expectedVersion:1,targetState:'active'});
 const protectedPlanner=process.env.FINNOR_V2_CASE_FILTER==='primary-protected-planner-acquisition';
 const economicTracking=process.env.FINNOR_V2_CASE_FILTER==='primary-protected-acquisition-economic-tracking';
 const closingHandoff=economicTracking||process.env.FINNOR_V2_CASE_FILTER==='primary-protected-acquisition-closing-handoff';
 const finalizeIc=closingHandoff||process.env.FINNOR_V2_CASE_FILTER==='primary-protected-guided-ic-finalized';
 const guidedIntake=finalizeIc||process.env.FINNOR_V2_CASE_FILTER==='primary-protected-guided-intake';
 const originalRequest=economicTracking||guidedIntake||process.env.FINNOR_V2_CASE_FILTER==='primary-protected-original-request';
 const protectedAcquisition=originalRequest||protectedPlanner||process.env.FINNOR_V2_CASE_FILTER==='primary-protected-acquisition';
 if(protectedAcquisition){
  const deal=await createDeal(ctx,{targetOrganizationId:company,name:'Synthetic protected acquisition',dealLeadEmployeeId:actor,signedLoiAt:new Date('2026-01-01'),targetClosingAt:new Date('2026-12-31')});root={entityType:'pe_deal',entityId:String(deal.row.id)};
  const c=await createInvestmentCase(ctx,{dealId:root.entityId,title:'Same Work source-bound acquisition'});caseId=String(c.row.id);
 }else{
  const opportunity=await createOpportunity(ctx,{strategyId:String(strategy.row.id),targetOrganizationId:company,name:'Synthetic pre-LOI opportunity'});root={entityType:'pe_opportunity',entityId:String(opportunity.row.id)};
  const c=await createOpportunityInvestmentCase(ctx,{opportunityId:root.entityId,title:'Pre-LOI exact primary underwriting'});caseId=String(c.row.id);await activateInvestmentCase(ctx,{investmentCaseId:caseId,expectedVersion:1});
 }
 const sourceEvidence=await createEvidenceSource(tenant,{sourceKey:'v2-starting-management',sourceType:'manual',title:'Synthetic incomplete management support'});
 const version=await appendEvidenceVersion(tenant,sourceEvidence.id,{content:'Management 2025 revenue USD 40,000,000; borrowing-1 classified SALE; credit-1 recorded credit 0. Facility population and recognition evidence unavailable.',snapshot:{managementRevenue:'40000000',borrowingClassification:'SALE',recordedCredit:'0'},asOf:new Date(periodEnd)});
 const raw=(await platform.admin.query('SELECT version_number,content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',[tenant,version.versionId])).rows[0];startingRef={owner:'S1',id:version.versionId,revision:String(raw.version_number),contentDigest:raw.content_hash};
 resourceRefs=[];
 for(const [name,unit,resourceClass] of [['cash','microUSD','CASH'],['cpu','cpu-microseconds','COMPUTE']] as const){
  const er=(owner:string,id:string)=>({owner,id,version:'1',contentDigest:hash({syntheticFixture:id})});
  const r=await putAllocationResource(ctx,{schema:'finnor.allocation-resource.v1',resourceId:'synthetic-v2-'+name,tenantId:tenant,ownerRef:er('BUSINESS_OWNER',actor),legalEntityRef:er('BUSINESS_OWNER',company),scopeRef:er('BUSINESS_OWNER',root.entityId),permittedRoots:[root],rightsRef:'synthetic-v2-resource-rights',unit,currency:unit==='microUSD'?'USD':null,kind:'CUMULATIVE_EXPENDITURE',resourceClass,
   horizon:{periods:1,periodMs:3600000,startAt:new Date().toISOString()},sourceRef:er('BUSINESS_OWNER','explicit-disposable-capacity'),asOf:new Date().toISOString(),knowledgeAt:new Date().toISOString(),validUntil:expiresAt,beliefPins:[],availability:[{amount:closure?(unit==='microUSD'?closurePlan.limits.newSyntheticCashAvailabilityMicroUsd:closurePlan.limits.newSyntheticCpuAvailabilityMicros):'1000000000',basis:'REPORTED_AVAILABLE'},{amount:closure?(unit==='microUSD'?closurePlan.limits.newSyntheticCashAvailabilityMicroUsd:closurePlan.limits.newSyntheticCpuAvailabilityMicros):'1000000000',basis:'REPORTED_AVAILABLE'}],existingUse:['0','0'],safetyMargin:'0',covenants:[],revoked:false,qualification:'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED'},null);
  resourceRefs.push({owner:r.ref.owner,id:r.ref.id,revision:r.ref.version,contentDigest:r.ref.contentDigest});
 }
 const browserHttp=process.env.FINNOR_V2_MOUNTED==='1'||process.env.FINNOR_V2_PACKAGED==='1'?await browserHttpFixture(platform.admin,tenant,actor,other):undefined;
 http=browserHttp??await nativeHttpFixture(platform.admin,tenant,actor,other);
 scopeDirectory=join(platform.directory,'v2-private');await mkdir(scopeDirectory,{mode:0o700});
 const protectedCase=protectedAcquisition||process.env.FINNOR_V2_CASE_FILTER==='primary-protected-liability';
 const protectedSource=protectedCase?await (await import('./https-source-fixture.mts')).preparePrimaryHttpsFixture(scopeDirectory,tenant,actor):undefined;
 source=spawn(process.execPath,['--import=tsx',join(import.meta.dirname,'controlled-source.mts'),scopeDirectory,...(protectedCase?['tls']:[])],{cwd:resolve(import.meta.dirname,'../..'),env:{PATH:process.env.PATH,NODE_ENV:'test'},stdio:['ignore','pipe','pipe','ipc']});children.add(source);
 publicDescriptor=await new Promise<any>((yes,no)=>{const timer=setTimeout(()=>no(Error('CONTROLLED_SOURCE_START_DEADLINE')),10000);source!.on('message',(m:any)=>{if(m.type==='ready'){clearTimeout(timer);yes(m);}});source!.once('exit',()=>no(Error('CONTROLLED_SOURCE_START_FAILED')));});
 if(qualification&&process.env.FINNOR_V2_SHORTER_DEADLINE_MS)source.on('message',(message:any)=>{
  if(message.type!=='accepted'||budget.signal.aborted||Date.now()>=budget.deadlineAt)return;
  const observedAt=Date.now(),previousDeadlineAt=budget.deadlineAt;budget.shorten(Math.min(previousDeadlineAt,observedAt+1000));
  deadlineShorteningEvents.push({requestId:message.requestId,observedAt:new Date(observedAt).toISOString(),previousDeadlineAt:new Date(previousDeadlineAt).toISOString(),effectiveDeadlineAt:new Date(budget.deadlineAt).toISOString(),rule:'ACTUAL_DURABLE_ACQUIRE_ACCEPTANCE_PLUS_1000_MS_OR_ORIGINAL_CUT_IF_EARLIER'});
 });
 process.env.FINNOR_PRIMARY_CREDENTIAL_DIRECTORY=scopeDirectory;
 if(process.env.FINNOR_V2_ONE_CLIENT_PROOF==='1'){
  await closePool();const pool=getPool();pool.options.max=1;assert.equal(pool.totalCount,0);
 }
 if(browserHttp&&process.env.FINNOR_V2_PACKAGED==='1'){
  await packagedRuntime({repo,output,platform,fixture:await build('facility',{singleSource:true}),http:browserHttp,call,sourceCalls,test,budget});
 }else if(browserHttp){
  await mountedController({repo,output,platform,ctx,root,fixture:await build('facility',{singleSource:true}),http:browserHttp,worker:async()=>{await worker();},sourceCalls,call,test,budget});
 }else{
 if(protectedCase){
 async function protectedWorker(){
  const secrets=await (await import('./local-managed-secrets.mts')).localManagedSecrets({DATABASE_URL:platform!.workerUrl});
  try{const log=await worker(undefined,undefined,{...secrets.environment,NODE_ENV:'production',DOTENV_CONFIG_PATH:join(scopeDirectory,'absent-env-file')},protectedPlanner||originalRequest);assert.deepEqual(secrets.observed,['DATABASE_URL']);assert.match(log,/"nodeEnvironment":"production"/);return {nodeEnvironment:'production',secretNames:secrets.observed,qualification:secrets.qualification};}
  finally{await secrets.close();}
 }
 async function originalRequestFixture(f:any,work:any){
  const scope=scopeOf(f.assertions[0]!),shape={valueType:'decimal',unit:'money',currency:'USD',shape:'scalar'} as const;
  const input=(id:string)=>({id,kind:'input' as const,...shape,dependencies:[],required:true,source:{kind:'model_parameter' as const}}),ref=(nodeId:string)=>({op:'ref' as const,nodeId}),minus=(id:string,a:string,b:string)=>({id,kind:'expression' as const,...shape,dependencies:[a,b],expression:{op:'subtract' as const,args:[ref(a),ref(b)]}});
  const model=await createUnderwritingModel(ctx,{investmentCaseId:caseId,modelKey:'original_acquisition',name:'Original reviewed population model'});
  const definition={schemaVersion:'underwriting-model-ir.v1' as const,modelKey:'original_acquisition',modelVersion:'1',financialConventionVersion:'finnor-pe-lbo/1.0.0',minimumEngineVersion:'finnor-underwriting-engine/1.0.0',periodDefinition:{frequency:'annual' as const,forecastStart:'2026-01-01',count:1},circularBlocks:[],nodes:[
   {...input('facility'),source:{kind:'explicit' as const},allowedTruthClasses:['OBSERVED_FACT' as const],primaryEvidenceScope:scope},input('price'),input('debt'),input('financing_cost'),
   {id:'exit_value',kind:'constant' as const,...shape,dependencies:[],value:'150000000',truthClass:'MODEL_PARAMETER' as const},minus('entry_equity','price','debt'),minus('exit_equity','exit_value','debt'),minus('after_facility','exit_equity','facility'),minus('before_cost','after_facility','entry_equity'),minus('profit','before_cost','financing_cost'),
   {id:'profit_output',kind:'output' as const,...shape,dependencies:['profit'],sourceNodeId:'profit'},{id:'equity_output',kind:'output' as const,...shape,dependencies:['entry_equity'],sourceNodeId:'entry_equity'}]};
  const version=await createUnderwritingModelVersion(ctx,{modelId:String(model.id),definition});
  const {schema:_schema,root:_root,workId:_work,expectedWorkInputId:_input,idempotencyKey:_key,...primary}=f.intake;
  const request={schema:'finnor.reviewed-acquisition-request.v1',dealId:root.entityId,primary,underwriting:{investmentCaseId:caseId,modelVersionId:String(version.id),primaryAssertions:{facility:{assertionId:f.assertions[0].assertionId,revision:1}},explicitInputs:{price:{value:'100000000',truthClass:'MODEL_PARAMETER'},debt:{value:'0',truthClass:'MODEL_PARAMETER'},financing_cost:{value:'0',truthClass:'MODEL_PARAMETER'}}},acquisition:{bidDomain:{nodeId:'price',currency:'USD',values:['90000000','100000000','110000000','120000000']},financingCases:[{key:'cash',name:'Declared cash case',overrides:[{nodeId:'debt',value:'0',reason:'No new borrowing'},{nodeId:'financing_cost',value:'0',reason:'No financing charge'}]},{key:'debt50',name:'Declared debt50m/cost5m',overrides:[{nodeId:'debt',value:'50000000',reason:'Declared financing assumption'},{nodeId:'financing_cost',value:'5000000',reason:'Declared financing charge'}]},{key:'debt70',name:'Declared debt70m/cost12m',overrides:[{nodeId:'debt',value:'70000000',reason:'Declared financing assumption'},{nodeId:'financing_cost',value:'12000000',reason:'Declared financing charge'}]}],constraints:[{outputNodeId:'profit_output',operator:'gte',threshold:'35000000',unit:'money',currency:'USD'},{outputNodeId:'equity_output',operator:'lte',threshold:'60000000',unit:'money',currency:'USD'}],limits:{maxCandidates:256,deadlineMs:120000}}};
  process.env.FINNOR_ORIGINAL_REQUEST_PROMPTS=join(output,'original-request-prompts.jsonl');
  return {ctx,admin:platform!.admin,root,work,request,http,worker:protectedWorker,call,output,deadlineAt:budget.deadlineAt};
 }
 await test('primary-protected-liability',{source:'separate HTTPS issuer',worker:'production mode with controlled managed-secret SDK',starting:'No facility identity or amount'},'authorized protected read traverses native owners and independent checker into same Work scoped underwriting; private read and revoked consent remain fenced',async()=>{
  assert(protectedSource);process.env.FINNOR_V2_PROFILE='production_primary';process.env.FINNOR_PRIMARY_TRANSPORT_POLICY_FILE=protectedSource.policyFile;
  const f=await build('facility',{singleSource:true,environment:'LIVE',admitSource:(profile:any)=>protectedSource.admit(profile)});
  const frozen={workId:f.intake.workId,inputId:f.intake.expectedWorkInputId,reservationRef:f.grant.reservationRef,maximumMicroUsd:f.grant.maximumMicroUsd,maximumCpuMicros:f.grant.maximumNativeCpuMicros,deadline:f.mandate.stopping.deadline};
  assert(!canonical(f.intake).includes('5000000'));assert(!canonical(f.intake).includes('additional-facility-1'));
  const accepted=await call('primary-submit',f.intake,202);
  const workerBootstrap=await protectedWorker();
  const read=await call('primary-read',{programmeId:accepted.programmeId});assert.equal(read.status,'COMPLETE',JSON.stringify(read));
  assert.equal(read.workId,frozen.workId);assert.equal(read.workRevision,frozen.inputId);
  const finding=read.findings[0];assert.equal(finding.environment,'LIVE');assert.equal(finding.conclusion,'SUPPORTED');
  assert.deepEqual(finding.establishedValueOrInterval,{kind:'EXACT',quantity:{numerator:'5000000',denominator:'1'}});assert.equal(finding.auditOpinion,false);
  assert(read.costReceipts.some((r:any)=>r.kind==='NATIVE'&&r.cpuMicros&&r.status==='RECONCILED'));
  protectedSource.policy.trustedIssuerKeys[0]!.validUntil=new Date(Date.now()-1).toISOString();await protectedSource.savePolicy();
  const retained=await call('primary-read',{programmeId:accepted.programmeId});assert.equal(retained.findings[0]?.artifactId,finding.artifactId);
  const newReadDenied=await http!.call('primary-submit',{...f.intake,idempotencyKey:randomUUID()});assert.equal(newReadDenied.status,422);assert.match(JSON.stringify(newReadDenied),/PRIMARY_TRANSPORT_EXACT_ADMISSION_OR_SCOPE_UNPASSED/);
  const persisted=(await platform!.admin.query('SELECT intake,starting_manifest FROM finnor_os.v2_programmes WHERE id=$1',[accepted.programmeId])).rows[0];
  assert.deepEqual(persisted.intake,f.intake);assert(!canonical(persisted.starting_manifest.evidence).includes('5000000'));
  const scope=scopeOf(f.assertions[0]!);scope.predicateKind='RECORD_VALUE';scope.economicRecordIds=['additional-facility-1'];
  const version=await model(f.assertions[0]!,scope),payload={investmentCaseId:caseId,modelVersionId:version,worldAt:new Date().toISOString(),idempotencyKey:randomUUID(),workId:read.workId,bindings:{facility:{findingId:finding.artifactId,economicId:'additional-facility-1'}}};
  const run=await call('primary-consume',payload);assert.equal(run.inputSnapshot.values.facility.value,'5000000');assert.equal(run.inputSnapshot.values.facility.truthClass,'OBSERVED_FACT');assert.equal(run.inputSnapshot.values.facility.status,'KNOWN');
  const wrong=structuredClone(scope);wrong.requiredCoverage.populationId='ENTERPRISE_TOTAL_DEBT';
  const refused=await http!.call('primary-consume',{...payload,modelVersionId:await model(f.assertions[0]!,wrong),idempotencyKey:randomUUID()});assert.equal(refused.status,422);assert.match(JSON.stringify(refused),/COVERAGE_MISMATCH/);
  const foreign=await http!.call('primary-read',{programmeId:accepted.programmeId},'other');assert.equal(foreign.status,404);
  const calls=await sourceCalls(f);assert.equal(calls.filter((c:any)=>c.operation==='ACQUIRE').length,1);assert.equal(calls.length,1);
  await call('primary-governance-revoke',{root,ref:f.consentRef,reason:'CONTROLLED_PROTECTED_DOWNSTREAM_REVOCATION'});
  const revoked=await call('primary-read',{programmeId:accepted.programmeId});assert.equal(revoked.findings.length,0);assert.equal(revoked.status,'BLOCKED');
  await assert.rejects(()=>getUnderwritingRun(ctx,run.id),/SOURCE_RIGHTS_MEMBERSHIP_OR_WORK_CHANGED/);assert.equal((await sourceCalls(f)).length,1);
  return {input:f.intake,frozen,read,retainedAfterTransportExpiry:retained,newReadDenied,run,sourceCalls:calls,foreign,scopeRefusal:refused,revoked,workerBootstrap,qualification:'CONTROLLED_PROTECTED_OWNER_PIPELINE_NOT_CUSTOMER_DOMAIN_OR_HOSTED_PRODUCTION_QUALIFICATION'};
 });
 await test(economicTracking?'primary-protected-acquisition-economic-tracking':closingHandoff?'primary-protected-acquisition-closing-handoff':finalizeIc?'primary-protected-guided-ic-finalized':guidedIntake?'primary-protected-guided-intake':originalRequest?'primary-protected-original-request':protectedPlanner?'primary-protected-planner-acquisition':'primary-protected-acquisition',{sourceFacility:'5000000 USD',declaredExit:'150000000 USD',minimumModelProfit:'35000000 USD',maximumEquity:'60000000 USD'},'actual primary evidence and independent parameters enter the same Deal/Work financial decision through the selected driver; revoked consent fences every dependent scenario',async()=>{
  assert(protectedSource);assert(http&&'createRun'in http);process.env.FINNOR_V2_PROFILE='production_primary';process.env.FINNOR_PRIMARY_TRANSPORT_POLICY_FILE=protectedSource.policyFile;
  const originalWork=await call('primary-open-work',{root,instruction:originalRequest?'Evaluate this acquisition, verify the financials, determine our maximum bid, compare financing, investigate material uncertainties, prepare IC, execute approved work, and track the economic outcome.':'Evaluate this acquisition, verify the financials, determine maximum bid and compare financing under the explicitly supplied constraints.',idempotencyKey:randomUUID()},201);
  const controller=protectedPlanner?await(await import('./protected-planner-e2e.mts')).protectedPrimaryPlanner({ctx,admin:platform!.admin,root,work:originalWork,output,deadlineAt:new Date(budget.deadlineAt)}):null;
  if(originalRequest)await(await import('../acquisition/original-request-e2e.mts')).prepareOriginalAcquisitionAuthority(ctx,platform!.admin);
  if(originalRequest){process.env.FINNOR_ACQUISITION_IC_CONTROLLER_E2E='1';await(await import('../acquisition/ic-e2e.mts')).prepareAcquisitionIcFixture({ctx,tenant,actor,admin:platform!.admin,investmentCaseId:caseId,story:{mandate:{dealId:root.entityId}},evidence:output});}
  const f=await build('facility',{singleSource:true,environment:'LIVE',work:originalWork,admitSource:(profile:any)=>protectedSource.admit(profile)});
  if(originalRequest){let e:any=await originalRequestFixture(f,originalWork);if(guidedIntake)e=await(await import('../acquisition/guided-intake-e2e.mts')).guidedAcquisitionIntake(e);return(await import('../acquisition/original-request-e2e.mts')).originalAcquisitionRequest({...e,finalizeIc,closingHandoff,economicTracking});}
  const accepted=controller?await controller.submit(f.intake):await call('primary-submit',f.intake,202);
  const primaryWorker=await protectedWorker(),read=await call('primary-read',{programmeId:accepted.programmeId});assert.equal(read.status,'COMPLETE',JSON.stringify(read));
  const plannerPrimaryRead=controller?await controller.primaryRead(accepted.programmeId,'COMPLETE'):null;
  assert.equal(read.workId,f.intake.workId);assert.equal(read.workRevision,f.intake.expectedWorkInputId);assert(!canonical(f.intake).includes('5000000'));
  const scope=scopeOf(f.assertions[0]!);scope.predicateKind='RECORD_VALUE';scope.economicRecordIds=['additional-facility-1'];
  const shape={valueType:'decimal',unit:'money',currency:'USD',shape:'scalar'} as const,input=(id:string)=>({id,kind:'input' as const,...shape,dependencies:[],required:true,source:{kind:'model_parameter' as const}}),ref=(nodeId:string)=>({op:'ref' as const,nodeId}),minus=(id:string,a:string,b:string)=>({id,kind:'expression' as const,...shape,dependencies:[a,b],expression:{op:'subtract' as const,args:[ref(a),ref(b)]}});
  const m=await createUnderwritingModel(ctx,{investmentCaseId:caseId,modelKey:'protected_acquisition',name:'Explicit one-period facility settlement model'});
  const definition={schemaVersion:'underwriting-model-ir.v1' as const,modelKey:'protected_acquisition',modelVersion:'1',financialConventionVersion:'finnor-pe-lbo/1.0.0',minimumEngineVersion:'finnor-underwriting-engine/1.0.0',periodDefinition:{frequency:'annual' as const,forecastStart:'2026-01-01',count:1},circularBlocks:[],nodes:[
   {...input('facility'),source:{kind:'explicit' as const},allowedTruthClasses:['OBSERVED_FACT' as const],primaryEvidenceScope:scope},input('price'),input('debt'),input('financing_cost'),
   {id:'exit_value',kind:'constant' as const,...shape,dependencies:[],value:'150000000',truthClass:'MODEL_PARAMETER' as const},minus('entry_equity','price','debt'),minus('exit_equity','exit_value','debt'),minus('after_facility','exit_equity','facility'),minus('before_cost','after_facility','entry_equity'),minus('profit','before_cost','financing_cost'),
   {id:'profit_output',kind:'output' as const,...shape,dependencies:['profit'],sourceNodeId:'profit'},{id:'equity_output',kind:'output' as const,...shape,dependencies:['entry_equity'],sourceNodeId:'entry_equity'}]};
  const version=await createUnderwritingModelVersion(ctx,{modelId:String(m.id),definition});
  const payload={investmentCaseId:caseId,modelVersionId:String(version.id),worldAt:new Date().toISOString(),idempotencyKey:randomUUID(),primaryFindingInputs:{facility:{findingId:read.findings[0].artifactId,economicId:'additional-facility-1'}},explicitInputs:{price:{value:'100000000',truthClass:'MODEL_PARAMETER'},debt:{value:'0',truthClass:'MODEL_PARAMETER'},financing_cost:{value:'0',truthClass:'MODEL_PARAMETER'}}};
  const response=controller?null:await http.createRun(payload);if(response)assert.equal(response.status,201,JSON.stringify(response));const run=controller?await controller.createRun(payload):response!.body;
  const replay=controller?null:await http.createRun({...payload,workId:f.intake.workId});if(replay){assert.equal(replay.status,200,JSON.stringify(replay));assert.equal(replay.body.id,run.id);}
  assert.equal(run.inputSnapshot.values.facility.value,'5000000');assert.equal(run.inputSnapshot.values.facility.truthClass,'OBSERVED_FACT');
  const persisted=(await platform!.admin.query('SELECT work_id::text FROM finnor_os.underwriting_runs WHERE id=$1',[run.id])).rows[0];assert.equal(persisted.work_id,f.intake.workId);
  const otherWork=await call('primary-open-work',{root,instruction:'Independent unrelated work',idempotencyKey:randomUUID()},201),foreignWork=await http.createRun({...payload,idempotencyKey:randomUUID(),workId:otherWork.workId});assert.equal(foreignWork.status,400);assert.match(JSON.stringify(foreignWork),/PRIMARY_CONSUMER_EXACT_WORK_SCOPE_MISMATCH/);
  const request={dealId:root.entityId,workId:f.intake.workId,baseRunId:run.id,idempotencyKey:randomUUID(),bidDomain:{nodeId:'price',currency:'USD',values:['90000000','100000000','110000000','120000000']},financingCases:[{key:'cash',name:'Declared cash case',overrides:[{nodeId:'debt',value:'0',reason:'No new borrowing'},{nodeId:'financing_cost',value:'0',reason:'No financing charge'}]},{key:'debt50',name:'Declared debt50m/cost5m',overrides:[{nodeId:'debt',value:'50000000',reason:'Explicit new financing assumption'},{nodeId:'financing_cost',value:'5000000',reason:'Explicit financing cost assumption'}]},{key:'debt70',name:'Declared debt70m/cost12m',overrides:[{nodeId:'debt',value:'70000000',reason:'Explicit new financing assumption'},{nodeId:'financing_cost',value:'12000000',reason:'Explicit financing cost assumption'}]}],constraints:[{outputNodeId:'profit_output',operator:'gte',threshold:'35000000',unit:'money',currency:'USD'},{outputNodeId:'equity_output',operator:'lte',threshold:'60000000',unit:'money',currency:'USD'}]};
  const decision=controller?await controller.evaluate(request):await call('acquisition-evaluate',request,202),decisionWorker=await protectedWorker(),observed=await call('acquisition-read',{decisionId:decision.decisionId});
  assert.equal(observed.status,'TESTED',JSON.stringify(observed));assert.equal(observed.workId,f.intake.workId);assert.equal(observed.workInputId,f.intake.expectedWorkInputId);assert.equal(observed.result.candidates.length,12);
  assert.equal(observed.result.maximumBid.value,'100000000');assert.equal(observed.result.maximumBid.financingCaseKey,'debt50');assert.equal(observed.result.maximumBid.qualification,'MAXIMUM_IN_DECLARED_FINITE_DOMAIN');assert.equal(observed.result.executionAuthorityGranted,false);assert.equal(observed.result.realizedProfitEstablished,false);
  const candidate=observed.result.candidates.find((c:any)=>c.bid==='110000000'&&c.financingCaseKey==='debt50');assert.equal(candidate.feasible,false);assert.deepEqual(candidate.failedConstraints,['profit_output']);
  assert.equal((await platform!.admin.query('SELECT count(*)::int n FROM finnor_os.work_inputs WHERE work_id=$1',[f.intake.workId])).rows[0].n,1);
  await call('primary-governance-revoke',{root,ref:f.consentRef,reason:'CONTROLLED_SOURCE_BOUND_ACQUISITION_REVOCATION'});
  const stale=await http!.call('acquisition-read',{decisionId:decision.decisionId});assert.equal(stale.status,409);assert.equal(stale.body.code,'ACQUISITION_SOURCE_CUT_CHANGED');assert.equal(stale.body.result,undefined);
  const calls=await sourceCalls(f);assert.equal(calls.length,1);assert.equal(calls[0].operation,'ACQUIRE');
  return {originalWork,input:f.intake,sourceRead:read,plannerPrimaryRead,plannerStages:controller?.stages,definition,run,replay,request,observed,foreignWork,stale,calls,primaryWorker,decisionWorker,qualification:'ACTUAL_PROTECTED_SOURCE_TO_SAME_ACQUISITION_WORK_WITH_EXPLICIT_SYNTHETIC_FINANCIAL_MODEL_NOT_ECONOMIC_GAIN_OR_PRODUCTION_DEPLOYMENT'};
 });
 }
 await test('cumulative-storage-accounting',{pages:2,replayFirstPageOnce:true,storageTariff:{numerator:'1',denominator:'3'}},'actual signed source pages, replay and retained S5 storage agree with independently summed unique canonical bytes',async()=>{
  const f=await build('facility',{singleSource:true,storageTariff:{numerator:'1',denominator:'3'},source:{totalPages:2,replayFirstPageOnce:true}}),read=await finish(f);
  assert.equal(read.status,'COMPLETE',JSON.stringify(read));
  const stored=(await platform!.admin.query('SELECT body FROM finnor_os.s1_primary_observations WHERE programme_id=$1 ORDER BY page_id',[read.programmeId])).rows;
  assert.equal(stored.length,2);
  const bytes=stored.reduce((sum,r)=>sum+Buffer.byteLength(canonical(r.body.raw)),0),expected=300n+(BigInt(bytes)+2n)/3n;
  const charges=(await platform!.admin.query("SELECT * FROM finnor_os.s5_primary_charges WHERE programme_id=$1 AND kind='ACQUISITION'",[read.programmeId])).rows;
  assert.equal(charges.length,1);assert.equal(Number(charges[0].bytes),bytes);assert.equal(charges[0].actual_micro_usd,expected.toString());
  assert.equal(charges[0].receipt.bytes,bytes);assert.equal(charges[0].receipt.microUsd,expected.toString());
  const ledger=(await platform!.admin.query("SELECT body FROM finnor_os.v2_events WHERE programme_id=$1 AND kind='RETAINED_STORAGE_RECONCILED' ORDER BY created_at,id",[read.programmeId])).rows;
  assert.equal(ledger.length,3);assert.equal(ledger.filter(e=>e.body.replayed).length,1);
  const replay=ledger.find(e=>e.body.replayed)!;assert.equal(replay.body.priorBytes,replay.body.receipt.bytes);
  const calls=await sourceCalls(f);assert.equal(calls.filter((r:any)=>r.operation==='ACQUIRE').length,1);assert.equal(calls.filter((r:any)=>r.cursor==='page-2').length,2);
  return {input:f.intake,programmeId:read.programmeId,uniqueStoredPages:stored.length,bytes,expectedMicroUsd:expected.toString(),charge:charges[0],ledger,calls};
 });
 await test('cumulative-storage-publication-rollback',{fault:'second observation INSERT'},'a real database publication fault rolls back the second page and storage increment while preserving the separately observed provider responsibility',async()=>{
  const f=await build('facility',{singleSource:true,storageTariff:{numerator:'1',denominator:'3'},source:{totalPages:2}}),accepted=await call('primary-submit',f.intake,202);
  await platform!.admin.query(`CREATE FUNCTION finnor_os.cumulative_storage_publication_fault() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN IF NEW.programme_id='${accepted.programmeId}'::uuid AND NEW.page_id='page-2' THEN RAISE EXCEPTION 'CONTROLLED_PUBLICATION_FAULT'; END IF; RETURN NEW; END $$;
   CREATE TRIGGER cumulative_storage_publication_fault BEFORE INSERT ON finnor_os.s1_primary_observations FOR EACH ROW EXECUTE FUNCTION finnor_os.cumulative_storage_publication_fault()`);
  try{await worker();}finally{await platform!.admin.query('DROP TRIGGER cumulative_storage_publication_fault ON finnor_os.s1_primary_observations; DROP FUNCTION finnor_os.cumulative_storage_publication_fault()');}
  const read=await call('primary-read',{programmeId:accepted.programmeId});assert.equal(read.status,'FAILED');assert.equal(read.reason,'CONTROLLED_PUBLICATION_FAULT');
  const stored=(await platform!.admin.query('SELECT body,evidence_source_id FROM finnor_os.s1_primary_observations WHERE programme_id=$1',[accepted.programmeId])).rows;assert.equal(stored.length,1);
  const bytes=Buffer.byteLength(canonical(stored[0].body.raw)),expected=300n+(BigInt(bytes)+2n)/3n;
  const charge=(await platform!.admin.query("SELECT * FROM finnor_os.s5_primary_charges WHERE programme_id=$1 AND kind='ACQUISITION'",[accepted.programmeId])).rows[0];
  assert.equal(Number(charge.bytes),bytes);assert.equal(charge.actual_micro_usd,expected.toString());assert.equal(charge.receipt.status,'RECONCILED');
  const versions=(await platform!.admin.query('SELECT count(*)::int n FROM finnor_os.evidence_source_versions WHERE source_id=$1',[stored[0].evidence_source_id])).rows[0].n;assert.equal(versions,1);
  const events=(await platform!.admin.query("SELECT kind,body FROM finnor_os.v2_events WHERE programme_id=$1 AND kind IN('PROVIDER_COST_RECONCILIATION','RETAINED_STORAGE_RECONCILED') ORDER BY created_at,id",[accepted.programmeId])).rows;
  assert.equal(events.filter(e=>e.kind==='PROVIDER_COST_RECONCILIATION').length,2);assert.equal(events.filter(e=>e.kind==='RETAINED_STORAGE_RECONCILED').length,1);
  return {input:f.intake,programmeId:accepted.programmeId,status:read.status,reason:read.reason,uniqueStoredPages:stored.length,versions,bytes,expectedMicroUsd:expected.toString(),charge,events};
 });
 await test('authenticated-boundary',{root},'invalid or absent Bearer cannot use forged owner headers; actual finnor_app has no RLS bypass',async()=>{
  const anonymous=await http!.call('primary-context',{root},'anonymous'),invalid=await http!.call('primary-context',{root},'invalid');assert.equal(anonymous.status,401);assert.equal(invalid.status,401);
  const role=await withTenantTransaction(tenant,{userId:actor,readOnly:true},async(_db,c)=>(await c.query('SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]);assert.equal(role.rolsuper,false);assert.equal(role.rolbypassrls,false);return {anonymous,invalid,role};
 });
 if(closure)await test('primary-new-work-thread-continuity',{},'canonical Work and owned Investigation link commit atomically; reload and duplicate retain the same Work while stale/cross-owner requests create no Work',async()=>{
  const thread=await createEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:actor,title:'Controlled primary Work continuity'});
  const input={root,instruction:'New Work from canonical Investigation',idempotencyKey:randomUUID(),investigation:{threadId:thread.id,expectedRevision:thread.revision}};
  const created=await call('primary-open-work',input,201),replayed=await call('primary-open-work',input,201);assert.deepEqual(replayed,created);
  const loaded=await loadEmployeeConversationThread({tenantId:tenant,ownerEmployeeId:actor,threadId:thread.id});assert(loaded);assert.equal(loaded.thread.activeWorkId,created.workId);assert.equal(loaded.thread.revision,thread.revision+1);
  assert(loaded.thread.activeReferences.some((ref:any)=>ref.entityType===root.entityType&&ref.entityId===root.entityId));
  const before=(await platform!.admin.query('SELECT count(*)::int n FROM finnor_os.works WHERE tenant_id=$1',[tenant])).rows[0].n;
  const stale=await http!.call('primary-open-work',{...input,idempotencyKey:randomUUID()}),foreign=await http!.call('primary-open-work',{...input,idempotencyKey:randomUUID(),investigation:{...input.investigation,expectedRevision:loaded.thread.revision}},'other');
  assert.equal(stale.status,422);assert.equal(stale.body.predicate,'WORK_THREAD_REVISION_CHANGED');assert.equal(foreign.status,422);assert.equal(foreign.body.predicate,'WORK_THREAD_NOT_FOUND');
  const after=(await platform!.admin.query('SELECT count(*)::int n FROM finnor_os.works WHERE tenant_id=$1',[tenant])).rows[0].n;assert.equal(after,before);
  return {created,replayed,thread:loaded.thread,stale,foreign,noOrphanWork:after===before};
 });
 await test('primary-liability',{starting:'No facility identity or 5m amount in starting input'},'actual acquisition discovers an absent exact facility, stops after sufficient coverage and independently supports 5m without enterprise-total debt',async()=>{
  const f=await build('facility'),intakeBytes=canonical(f.intake);assert(!intakeBytes.includes('5000000'));assert(!intakeBytes.includes('additional-facility-1'));lastFacility=await finish(f);
  assert.equal(lastFacility.status,'COMPLETE',JSON.stringify(lastFacility));const finding=lastFacility.findings[0];assert.equal(finding.conclusion,'SUPPORTED');assert.deepEqual(finding.establishedValueOrInterval,{kind:'EXACT',quantity:{numerator:'5000000',denominator:'1'}});
  assert.deepEqual(finding.observedPopulationAndCoverage.selectedEconomicIds,['additional-facility-1']);assert(finding.actualPrimaryObservationRefs.length>0);
  const starting=(await platform!.admin.query('SELECT starting_manifest FROM finnor_os.v2_programmes WHERE id=$1',[lastFacility.programmeId])).rows[0];assert(!canonical(starting.starting_manifest.evidence).includes('5000000'));assert(!canonical(starting.starting_manifest.evidence).includes('additional-facility-1'));
  const actual=await rpc({type:'inspect'}),posts=actual.calls.filter((c:any)=>c.operation==='ACQUIRE'&&f.sourceProfiles.some((p:any)=>p.profileId===c.sourceProfileId));assert.equal(posts.length,1);
  assert(lastFacility.costReceipts.some((r:any)=>r.kind==='NATIVE'&&r.cpuMicros&&r.status==='RECONCILED'));lastFacility.fixture=f;return {read:lastFacility,startingManifestDigest:hash(starting.starting_manifest),sourceCalls:posts};
 });
 await test('scoped-underwriting',{scope:'Only the actually discovered exact facility'},'canonical Opportunity InvestmentCase with no fabricated Deal consumes observed 5m only under compatible facility scope',async()=>{
  assert(lastFacility?.fixture,'DEPENDENT_PRIMARY_PROOF_UNAVAILABLE');const a=lastFacility.fixture.assertions[0],finding=lastFacility.findings[0],scope=scopeOf(a);scope.predicateKind='RECORD_VALUE';scope.economicRecordIds=['additional-facility-1'];
  const version=await model(a,scope),run=await call('primary-consume',{investmentCaseId:caseId,modelVersionId:version,worldAt:new Date().toISOString(),idempotencyKey:randomUUID(),workId:lastFacility.workId,bindings:{facility:{findingId:finding.artifactId,economicId:'additional-facility-1'}}});
  if(process.env.FINNOR_V2_ONE_CLIENT_PROOF==='1'){assert.equal(getPool().options.max,1);assert.equal(getPool().totalCount,1);assert.equal(getPool().waitingCount,0);}
  assert.equal(run.inputSnapshot.values.facility.value,'5000000');assert.equal(run.inputSnapshot.values.facility.truthClass,'OBSERVED_FACT');assert.equal(run.inputSnapshot.values.facility.status,'KNOWN');lastFacility.run=run;lastFacility.modelVersion=version;
  const caseRow=(await platform!.admin.query('SELECT deal_id,opportunity_id FROM finnor_os.pe_investment_cases WHERE id=$1',[caseId])).rows[0];assert.equal(caseRow.deal_id,null);assert.equal(caseRow.opportunity_id,root.entityId);
  const wrong=structuredClone(scope);wrong.requiredCoverage.populationId='ENTERPRISE_TOTAL_DEBT';const wrongVersion=await model(a,wrong);
  const rejected=await http!.call('primary-consume',{investmentCaseId:caseId,modelVersionId:wrongVersion,worldAt:new Date().toISOString(),idempotencyKey:randomUUID(),workId:lastFacility.workId,bindings:{facility:{findingId:finding.artifactId,economicId:'additional-facility-1'}}});assert.equal(rejected.status,422);assert.match(JSON.stringify(rejected),/COVERAGE_MISMATCH/);return {run,caseRow,rejected};
 });
 await test('revenue-discrepancies',{asserted:'40000000',borrowing:'3000000',omittedCredit:'800000'},'exact discrepancies are independently revalidated while annual revenue remains unresolved and 36.2m cannot fill a KNOWN annual input',async()=>{
  const f=await build('revenue');lastRevenue=await finish(f);assert.equal(lastRevenue.findings.length,4,JSON.stringify(lastRevenue));
  const byField=(field:string)=>lastRevenue.findings.find((finding:any)=>finding.assertionRef.id===f.assertions.find(a=>a.field===field)!.assertionId);
  assert.equal(byField('classification').conclusion,'CONTRADICTED');assert.deepEqual(byField('classification').establishedValueOrInterval,{kind:'STATE',state:'BORROWING'});
  assert.equal(byField('amount').conclusion,'SUPPORTED');assert.equal(byField('amount').establishedValueOrInterval.quantity.numerator,'3000000');
  assert.equal(byField('credit').conclusion,'CONTRADICTED');assert.equal(byField('credit').establishedValueOrInterval.quantity.numerator,'-800000');
  const revenue=byField('revenue');assert.equal(revenue.conclusion,'UNRESOLVED');assert.equal(revenue.establishedValueOrInterval.kind,'UNKNOWN');
  const original=lastRevenue.assertions.find((a:any)=>a.field==='revenue');assert.equal(original.amountOrState.quantity.numerator,'40000000');
  const version=await model(original,scopeOf(original),'annual_revenue'),refused=await http!.call('primary-consume',{investmentCaseId:caseId,modelVersionId:version,worldAt:new Date().toISOString(),idempotencyKey:randomUUID(),workId:lastRevenue.workId,bindings:{annual_revenue:{findingId:revenue.artifactId}}});assert.equal(refused.status,422);assert.match(JSON.stringify(refused),/UNRESOLVED/);
  const revalidations=(await platform!.admin.query('SELECT id,revalidation_of FROM finnor_os.s6_primary_requests WHERE programme_id=$1 AND revalidation_of IS NOT NULL',[lastRevenue.programmeId])).rows;assert.equal(revalidations.length,2);lastRevenue.fixture=f;return {read:lastRevenue,revalidations,refused,arithmeticOnly:'36200000_NOT_ESTABLISHED_ANNUAL_REVENUE'};
 });
 await test('duplicate-and-restart',{},'same immutable intake and delivered terminal job cannot produce another physical request or finding',async()=>{
  assert(lastFacility?.fixture,'DEPENDENT_PRIMARY_PROOF_UNAVAILABLE');const before=await rpc({type:'inspect'}),replayed=await call('primary-submit',lastFacility.fixture.intake,202);assert.equal(replayed.programmeId,lastFacility.programmeId);
  await worker();const read=await call('primary-read',{programmeId:lastFacility.programmeId}),after=await rpc({type:'inspect'});assert.equal(read.findings[0].artifactId,lastFacility.findings[0].artifactId);assert.equal(after.calls.filter((c:any)=>c.operation==='ACQUIRE').length,before.calls.filter((c:any)=>c.operation==='ACQUIRE').length);return {replayed,read};
 });
 await test('cross-principal-read',{},'another active same-tenant owner cannot retrieve the original principal private artifact',async()=>{
  assert(lastFacility,'DEPENDENT_PRIMARY_PROOF_UNAVAILABLE');const denied=await http!.call('primary-read',{programmeId:lastFacility.programmeId},'other');assert.equal(denied.status,404);assert(!JSON.stringify(denied).includes('5000000'));return denied;
 });
 if(closure){
  const rawScope=async(f:any)=>{const row=(await platform!.admin.query('SELECT o.evidence_source_id source_id,o.evidence_version_id version_id,r.body->>\'purpose\' purpose FROM finnor_os.s1_primary_observations o JOIN finnor_os.s6_primary_requests r ON r.tenant_id=o.tenant_id AND r.id=o.request_id WHERE o.programme_id=$1 LIMIT 1',[f.programmeId])).rows[0];assert(row,'ACTUAL_PRIMARY_OBSERVATION_REQUIRED');return row;};
  const rawCounts=async(f:any,user=actor,purpose?:string,bind=true)=>withTenantTransaction(tenant,{userId:user,readOnly:true},async(_db,c)=>{
   const raw=await rawScope(f);if(bind)await c.query("SELECT set_config('app.primary_programme_id',$1,true),set_config('app.primary_data_purpose',$2,true)",[f.programmeId,purpose??raw.purpose]);
   return (await c.query('SELECT (SELECT count(*) FROM finnor_os.evidence_sources WHERE id=$1)::int sources,(SELECT count(*) FROM finnor_os.evidence_source_versions WHERE id=$2)::int versions,(SELECT count(*) FROM finnor_os.evidence_chunks WHERE version_id=$2)::int chunks,(SELECT count(*) FROM finnor_os.research_run_hits WHERE source_id=$1)::int hits',[raw.source_id,raw.version_id])).rows[0];
  });
  await test('primary-raw-context-isolation',{},'known raw IDs require exact current actor/programme/purpose; generic actor and another owner cannot retrieve source, version or chunks',async()=>{
   assert(lastFacility);const generic=await rawCounts(lastFacility,actor,undefined,false),otherOwner=await rawCounts(lastFacility,other),wrongPurpose=await rawCounts(lastFacility,actor,'UNRELATED_RESEARCH'),allowed=await rawCounts(lastFacility);
   for(const denied of [generic,otherOwner,wrongPurpose])assert.deepEqual(denied,{sources:0,versions:0,chunks:0,hits:0});
   assert.equal(allowed.sources,1);assert.equal(allowed.versions,1);assert(allowed.chunks>0);return {generic,otherOwner,wrongPurpose,allowed};
  });
  await test('primary-raw-search-and-history',{},'generic lexical/vector/citation search and historical research excerpts exclude primary records while normal Evidence stays usable',async()=>{
   const raw=await rawScope(lastFacility),chunk=(await platform!.admin.query('SELECT id,scope FROM finnor_os.evidence_chunks WHERE version_id=$1 LIMIT 1',[raw.version_id])).rows[0],runId=randomUUID();
   await platform!.admin.query('INSERT INTO finnor_os.research_runs(id,tenant_id,query,as_of) VALUES($1,$2,$3,clock_timestamp())',[runId,tenant,'retained synthetic historical primary hit']);
   await platform!.admin.query('INSERT INTO finnor_os.research_run_hits(tenant_id,research_run_id,source_id,version_id,chunk_id,scope,rank,fused_score,excerpt) VALUES($1,$2,$3,$4,$5,$6,1,1,$7)',[tenant,runId,raw.source_id,raw.version_id,chunk.id,chunk.scope,'Synthetic private outstanding 5000000']);
   const provider={name:'closure-controlled-local-no-network',embed:async()=>Array(1024).fill(0)},hidden=await searchEvidence({tenantId:tenant,query:'5000000',embeddingProvider:provider,researchRunId:runId}),normal=await searchEvidence({tenantId:tenant,query:'Management',embeddingProvider:provider});
   assert.equal(hidden.hits.length,0);assert.equal(hidden.citations.length,0);assert(normal.hits.length>0);assert.equal((await rawCounts(lastFacility)).hits,0);
   return {hidden,normalEvidenceHitCount:normal.hits.length,historicalPrivateHitsVisible:0};
  });
  await test('primary-raw-starting-support-denied',{},'a known private raw version cannot be relabeled as ordinary starting support',async()=>{
   const raw=await rawScope(lastFacility),version=(await platform!.admin.query('SELECT version_number,content_hash FROM finnor_os.evidence_source_versions WHERE id=$1',[raw.version_id])).rows[0],intake=structuredClone(lastFacility.fixture.intake);
   intake.idempotencyKey=randomUUID();intake.startingEvidenceRefs=[{owner:'S1',id:raw.version_id,revision:String(version.version_number),contentDigest:version.content_hash}];
   const denied=await http!.call('primary-submit',intake);assert.equal(denied.status,422);assert.equal(denied.body.predicate,'STARTING_EVIDENCE_EXACT_REVISION_UNAVAILABLE');return denied;
  });
  await test('primary-raw-governance-revocation',{},'private custody identity cannot be downgraded; revocation denies even previously valid raw context and retains immutable evidence',async()=>{
   const f=await build('facility',{singleSource:true}),read=await finish(f),raw=await rawScope(read);
   assert.equal((await rawCounts(read)).versions,1);
   await assert.rejects(()=>withTenantTransaction(tenant,{userId:actor},async(_db,c)=>{await c.query("SELECT set_config('app.primary_programme_id',$1,true),set_config('app.primary_data_purpose',$2,true)",[read.programmeId,raw.purpose]);await c.query("UPDATE finnor_os.evidence_sources SET source_type='manual' WHERE id=$1",[raw.source_id]);}),/PRIMARY_EVIDENCE_CUSTODY_IDENTITY_IMMUTABLE|evidence source type is immutable after P1 temporal baseline/);
   await assert.rejects(()=>withTenantTransaction(tenant,{userId:actor},async(_db,c)=>{await c.query("SELECT set_config('app.primary_programme_id',$1,true),set_config('app.primary_data_purpose',$2,true)",[read.programmeId,raw.purpose]);await c.query("UPDATE finnor_os.evidence_sources SET metadata='{}'::jsonb WHERE id=$1",[raw.source_id]);}),/PRIMARY_EVIDENCE_CUSTODY_IDENTITY_IMMUTABLE/);
   await call('primary-governance-revoke',{root,ref:f.consentRef,reason:'CONTROLLED_RAW_CUSTODY_REVOCATION'});
   const denied=await rawCounts(read);assert.deepEqual(denied,{sources:0,versions:0,chunks:0,hits:0});
   const retained=(await platform!.admin.query('SELECT count(*)::int n FROM finnor_os.evidence_source_versions WHERE id=$1',[raw.version_id])).rows[0];assert.equal(retained.n,1);return {denied,retained};
  });
  await test('primary-raw-principal-loss',{},'inactive actual principal cannot use previously valid raw custody context; reactivation restores only unchanged permission',async()=>{
   assert.equal((await rawCounts(lastFacility)).versions,1);
   await platform!.admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[tenant,actor]);
   let denied;
   try{denied=await rawCounts(lastFacility);assert.deepEqual(denied,{sources:0,versions:0,chunks:0,hits:0});}
   finally{await platform!.admin.query("UPDATE finnor_os.users SET status='active' WHERE tenant_id=$1 AND id=$2",[tenant,actor]);}
   const reactivated=await rawCounts(lastFacility);assert.deepEqual(reactivated,{sources:0,versions:0,chunks:0,hits:0});
   const stale=await call('primary-read',{programmeId:lastFacility.programmeId});assert.equal(stale.status,'BLOCKED');assert.equal(stale.findings.length,0);
   const freshFixture=await build('facility',{singleSource:true}),fresh=await finish(freshFixture),freshScope=await rawCounts(fresh);
   assert.equal(fresh.status,'COMPLETE');assert.equal(freshScope.versions,1);
   return {denied,reactivated,stale,freshProgrammeId:fresh.programmeId,freshScope,oldPermissionNotRevived:true};
  });
  await test('primary-raw-profile-replacement',{},'actual authenticated profile replacement denies old private raw context and finding without erasing evidence',async()=>{
   const f=await build('facility',{singleSource:true}),read=await finish(f);assert.equal((await rawCounts(read)).versions,1);
   const updated=await call('primary-governance-put',{root,body:{...f.sourceProfiles[0],revision:2},expectedRef:f.intake.sourceProfileRefs[0]},201);
   const denied=await rawCounts(read);assert.deepEqual(denied,{sources:0,versions:0,chunks:0,hits:0});
   const blocked=await call('primary-read',{programmeId:read.programmeId});assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.findings.length,0);
   const retained=(await platform!.admin.query('SELECT count(*)::int n FROM finnor_os.s1_primary_observations WHERE programme_id=$1',[read.programmeId])).rows[0];assert.equal(retained.n,1);return {updated,denied,blocked,retained};
  });
  await test('primary-raw-retention-expiry',{rawRetentionMs:10000},'real expiry of the original raw retention window fences raw reads without changing stored facts',async()=>{
   const f=await build('facility',{singleSource:true,rawRetentionMs:10000}),read=await finish(f);assert.equal(read.status,'COMPLETE');
   const before=await rawCounts(read);assert.equal(before.versions,1);
   await new Promise(yes=>setTimeout(yes,Math.max(0,Date.parse(f.consent.retention.rawUntil)-Date.now()+100)));
   const denied=await rawCounts(read);assert.deepEqual(denied,{sources:0,versions:0,chunks:0,hits:0});
   return {originalRawUntil:f.consent.retention.rawUntil,checkedAt:new Date().toISOString(),before,denied};
  });
  if(continuation){
   await test('primary-work-input-change',{},'a real new canonical Work input fences the original programme, raw custody and finding',async()=>{
    const f=await build('facility',{singleSource:true}),read=await finish(f);assert.equal((await rawCounts(read)).versions,1);
    const changed=await receiveWork({tenantId:tenant,userId:actor,workId:read.workId,instruction:'Additional independent Work input changes the frozen obligation',channel:'console',idempotencyKey:randomUUID(),activeContext:{focusedEntityType:root.entityType,focusedEntityId:root.entityId,entityRefs:[root]}});
    assert.equal(changed.workId,read.workId);assert.notEqual(changed.workInputId,f.intake.expectedWorkInputId);
    const denied=await rawCounts(read),blocked=await call('primary-read',{programmeId:read.programmeId});assert.equal(denied.versions,0);assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.findings.length,0);return {changed,denied,blocked};
   });
   await test('primary-membership-change',{},'actual employee-role membership change and restoration cannot revive the old authority-bound permission',async()=>{
    const f=await build('facility',{singleSource:true}),read=await finish(f);
    const disabled=await platform!.admin.query('UPDATE finnor_os.employee_role_assignments SET active=false WHERE tenant_id=$1 AND employee_id=$2 AND active RETURNING id',[tenant,actor]);assert(disabled.rows.length>0);
    let denied;
    try{denied=await rawCounts(read);assert.equal(denied.versions,0);}
    finally{await platform!.admin.query('UPDATE finnor_os.employee_role_assignments SET active=true WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenant,disabled.rows.map(row=>row.id)]);}
    const restored=await rawCounts(read);assert.equal(restored.versions,0);return {changedMembershipIds:disabled.rows.map(row=>row.id),denied,restored,oldPermissionNotRevived:true};
   });
   await test('primary-profile-fresh-reacquisition',{},'new immutable profile revision reacquires through the source, creates exact revised Evidence provenance and never restores old raw scope',async()=>{
    const f=await build('facility',{singleSource:true}),old=await finish(f),oldRaw=await rawScope(old),profile={...f.sourceProfiles[0]!,revision:2};
    const updated=await call('primary-governance-put',{root,body:profile,expectedRef:f.intake.sourceProfileRefs[0]},201);
    const acquired=(await platform!.admin.query('SELECT body FROM finnor_os.s1_primary_observations WHERE programme_id=$1 LIMIT 1',[old.programmeId])).rows[0].body;
    await rpc({type:'configure',profiles:[{public:profile,credential:await readFile(join(scopeDirectory,profile.credentialRef),'utf8'),records:acquired.raw.body.records,recordKinds:['FACILITY']}]});
    const intake={...f.intake,idempotencyKey:randomUUID(),sourceProfileRefs:[updated.ref]},fresh=await finish({intake});assert.equal(fresh.status,'COMPLETE',JSON.stringify(fresh));const freshRaw=await rawScope(fresh);assert.notEqual(freshRaw.source_id,oldRaw.source_id);
    const metadata=(await platform!.admin.query('SELECT metadata FROM finnor_os.evidence_sources WHERE id=$1',[freshRaw.source_id])).rows[0].metadata;assert.deepEqual(metadata.sourceProfileRef,updated.ref);
    assert.equal((await rawCounts(fresh)).versions,1);assert.equal((await rawCounts(old)).versions,0);
    assert.equal((await sourceCalls(f)).filter((c:any)=>c.operation==='ACQUIRE').length,2);return {oldProgrammeId:old.programmeId,fresh,oldRaw,freshRaw,metadata};
   });
   await test('primary-deadline-before-dispatch',{originalDeadlineMs:1000},'expiry of the original mandate stopping deadline before worker dispatch performs no physical source call',async()=>{
    const f=await build('facility',{singleSource:true,deadlineMs:1000}),accepted=await call('primary-submit',f.intake,202);await new Promise(yes=>setTimeout(yes,1100));await worker();
    const read=await call('primary-read',{programmeId:accepted.programmeId}),calls=await sourceCalls(f);assert.equal(calls.length,0);assert(read.findings.every((finding:any)=>finding.conclusion==='UNRESOLVED'&&finding.establishedValueOrInterval.kind==='UNKNOWN'));assert(['STOPPED','BLOCKED'].includes(read.status));return {read,calls,originalDeadlineNotExtended:true};
   });
   await test('primary-revoked-downstream-binding',{},'revoked primary provenance fences canonical underwriting, IC grounding and artifact comparison/projection before destination lookup or any write',async()=>{
    const f=await build('facility',{singleSource:true}),read=await finish(f),a=f.assertions[0]!,scope=scopeOf(a);scope.predicateKind='RECORD_VALUE';scope.economicRecordIds=['additional-facility-1'];
    const version=await model(a,scope),run=await call('primary-consume',{investmentCaseId:caseId,modelVersionId:version,worldAt:new Date().toISOString(),idempotencyKey:randomUUID(),workId:read.workId,bindings:{facility:{findingId:read.findings[0].artifactId,economicId:'additional-facility-1'}}});
    await call('primary-governance-revoke',{root,ref:f.consentRef,reason:'CONTROLLED_DOWNSTREAM_CUSTODY_REVOCATION'});
    const denied:string[]=[];
    for(const [owner,invoke] of [
     ['underwriting',()=>getUnderwritingRun(ctx,run.id)],
     ['IC grounding',()=>groundIcSourceReference(ctx,{icCaseId:randomUUID(),source:{kind:'UNDERWRITING_RUN',underwritingRunId:run.id}})],
     ['artifact comparison',()=>compareUnderwritingRunToArtifact(ctx,{runId:run.id,documentId:randomUUID(),documentVersionId:randomUUID()})],
     ['artifact projection',()=>projectUnderwritingOutputs(ctx,{runId:run.id,documentId:randomUUID(),baseVersionId:randomUUID(),idempotencyKey:randomUUID()})],
    ] as const){await assert.rejects(invoke,/SOURCE_RIGHTS_MEMBERSHIP_OR_WORK_CHANGED/);denied.push(owner);}
    return {runId:run.id,denied,destinationIds:'Deliberately unavailable, fencing is required before destination lookup. Not successful IC/artifact workflow qualification.'};
   });
   await test('primary-reversal-population',{},'linked original and reversal are excluded by the independent checker while the surviving exact population is counted once',async()=>{
    const f=await build('facility',{singleSource:true,records:(records:PrimaryRecord[])=>{const old=records[0]!;return [old,{...old,issuerRecordId:'issuer-reversal',economicId:'reversal-1',reversesEconomicId:old.economicId,fields:{outstanding:{kind:'EXACT',quantity:{numerator:'-5000000',denominator:'1'}}}},{...old,issuerRecordId:'issuer-surviving',economicId:'surviving-facility',fields:{outstanding:{kind:'EXACT',quantity:{numerator:'7000000',denominator:'1'}}}}];}});
    const read=await finish(f);assert.equal(read.status,'COMPLETE');assert.equal(read.findings[0].establishedValueOrInterval.quantity.numerator,'7000000');assert.deepEqual(read.findings[0].observedPopulationAndCoverage.selectedEconomicIds,['surviving-facility']);return {read,calls:await sourceCalls(f)};
   });
  }
 }
 if(closure){
  await test('primary-multipage-population',{pages:3},'one actual acquisition and contiguous signed three-page custody independently establish 5m exactly once',async()=>{
   const f=await build('facility',{singleSource:true,source:{totalPages:3}}),read=await finish(f),calls=await sourceCalls(f);
   assert.equal(read.status,'COMPLETE',JSON.stringify(read));assert.equal(read.findings[0].establishedValueOrInterval.quantity.numerator,'5000000');
   assert.equal(calls.filter((c:any)=>c.operation==='ACQUIRE').length,1);assert.equal(calls.filter((c:any)=>c.operation==='READ_RESULT').length,2);
   assert.equal(read.findings[0].actualPrimaryObservationRefs.length,3);return {read,calls};
  });
  await test('primary-revision-and-alias-replay',{},'higher economic revision replaces its predecessor and a matching source alias cannot duplicate the scoped value',async()=>{
   const f=await build('facility',{singleSource:true,records:(records:PrimaryRecord[])=>{
    const old=records[0]!,current={...old,revision:2,issuerRecordId:'issuer-current-revision',fields:{outstanding:{kind:'EXACT' as const,quantity:{numerator:'7000000',denominator:'1'}}}};
    return [old,current,{...current,issuerRecordId:'issuer-alias',economicId:'same-facility-alias',aliasOf:current.economicId}];
   }}),read=await finish(f),calls=await sourceCalls(f);
   assert.equal(read.status,'COMPLETE',JSON.stringify(read));assert.equal(read.findings[0].conclusion,'SUPPORTED');assert.equal(read.findings[0].establishedValueOrInterval.quantity.numerator,'7000000');
   assert(!canonical(f.intake).includes('7000000'));assert.equal(calls.filter((c:any)=>c.operation==='ACQUIRE').length,1);return {read,calls};
  });
  await test('primary-nonfinal-provider-cost',{},'accepted financial scope cannot turn a nonfinal provider receipt into settled cash or release remaining exposure',async()=>{
   const f=await build('facility',{singleSource:true,source:{paymentUnknown:true}}),read=await finish(f),calls=await sourceCalls(f);
   assert.equal(read.status,'COMPLETE',JSON.stringify(read));assert.equal(read.findings[0].establishedValueOrInterval.quantity.numerator,'5000000');
   assert(read.costReceipts.some((cost:any)=>cost.kind==='ACQUISITION'&&cost.status==='UNKNOWN'&&cost.possibleAdditionalMicroUsd==='500'));
   assert.equal(calls.filter((c:any)=>c.operation==='ACQUIRE').length,1);return {read,calls};
  });
 }
 for(const assignment of [
  {id:'source-wrong-entity',source:{mutation:'wrong-entity',foreignEntity:foreignCompany}},
  {id:'source-wrong-units',source:{mutation:'wrong-units'}},
  {id:'source-wrong-basis',source:{mutation:'wrong-basis'}},
  {id:'source-wrong-request',source:{mutation:'wrong-request'},predicate:'PRIMARY_EXACT_RESPONSE_BINDING_INVALID'},
  {id:'source-wrong-signature',source:{mutation:'wrong-signature'},predicate:'PRIMARY_RESPONSE_SIGNATURE_INVALID'},
  {id:'source-partial',source:{partial:true}},
  {id:'source-nonresponse',source:{status:'NONRESPONSE'},records:[]},
  {id:'source-unavailable-history',source:{status:'UNAVAILABLE_HISTORY'},records:[]},
  {id:'source-empty-accessible-subset',source:{status:'EMPTY_ACCESSIBLE_SUBSET',partial:true},records:[]},
  {id:'source-target-controlled',source:{},sourceClass:'TARGET_CONTROLLED_RECORD'},
 ] as Array<{id:string;source:any;predicate?:string;records?:PrimaryRecord[];sourceClass?:string}>){
  await test(assignment.id,assignment,'the assigned source defect reaches its owning boundary without an established financial claim',async()=>{
   const f=await build('facility',{singleSource:true,...assignment}),read=await finish(f),calls=await sourceCalls(f);
   if(assignment.predicate){
    assert.equal(read.status,'RECONCILING');assert.equal(read.findings.length,0);
    const failures=(await platform!.admin.query("SELECT body FROM finnor_os.v2_events WHERE programme_id=$1 AND kind='UNKNOWN'",[read.programmeId])).rows;
    assert(failures.some(r=>r.body.predicate===assignment.predicate));
    assert(read.costReceipts.some((r:any)=>r.kind==='ACQUISITION'&&r.status==='UNKNOWN'));
   }else{
    assert.equal(read.findings.length,1,JSON.stringify(read));
    assert.equal(read.findings[0].conclusion,'UNRESOLVED');
    assert.equal(read.findings[0].establishedValueOrInterval.kind,'UNKNOWN');
    assert(read.costReceipts.some((r:any)=>r.kind==='NATIVE'&&r.status==='RECONCILED'));
   }
   assert.equal(calls.filter((c:any)=>c.operation==='ACQUIRE').length,assignment.sourceClass?0:1);
   return {read,calls};
  });
 }
 await test('cancel-before-dispatch',{},'cancellation before dispatch creates zero source requests and retains original Work/grant identity',async()=>{
  const f=await build('facility',{singleSource:true}),accepted=await call('primary-submit',f.intake,202);
  await call('primary-cancel',{programmeId:accepted.programmeId},202);await worker();await worker();
  const read=await call('primary-read',{programmeId:accepted.programmeId}),calls=await sourceCalls(f);
  assert.equal(read.status,'STOPPED');assert.equal(read.findings.length,0);assert.equal(calls.length,0);assert.equal(read.advanceBindings.budgetGrantRef.id,f.budgetGrantRef.id);
  return {read,calls};
 });
 await test('physical-unknown-recovery',{},'physical death after acceptance cannot automatically replay a reconcilable job; original authorized advance reconciles before private retrieval',async()=>{
  const f=await build('facility',{singleSource:true,source:{delayMs:1500}}),accepted=await call('primary-submit',f.intake,202);
  await worker(killAfterSourceAcceptance,'SIGKILL');await new Promise(yes=>setTimeout(yes,4000));await worker();
  const quarantined=(await platform!.admin.query("SELECT status,last_error,claim_fence FROM finnor_os.jobs WHERE payload->>'programmeId'=$1 ORDER BY id",[accepted.programmeId])).rows;
  assert.equal(quarantined.length,1);assert.equal(quarantined[0].status,'quarantined');assert.match(quarantined[0].last_error,/automatic replay is prohibited/);
  const before=await call('primary-read',{programmeId:accepted.programmeId});assert(before.costReceipts.some((r:any)=>r.status==='UNKNOWN'));
  await continueOriginal(before);await worker();
  const read=await call('primary-read',{programmeId:accepted.programmeId}),calls=await sourceCalls(f);
  assert.equal(read.status,'COMPLETE',JSON.stringify(read));assert.equal(read.findings[0].establishedValueOrInterval.quantity.numerator,'5000000');
  assert.deepEqual(calls.map((c:any)=>c.operation),['ACQUIRE','STATUS','READ_RESULT']);assert.equal(read.advanceBindings.budgetGrantRef.id,f.budgetGrantRef.id);
  assert(calls.every((c:any)=>c.requestId===calls[0].requestId));return {quarantined,before,read,calls};
 });
 await test('revoked-status-only-recovery',{},'revoked consent after physical acceptance permits only retained signed status/cost recovery, never a private balance read',async()=>{
  const f=await build('facility',{singleSource:true,source:{delayMs:1500}}),accepted=await call('primary-submit',f.intake,202);
  await worker(killAfterSourceAcceptance,'SIGKILL');
  await call('primary-governance-revoke',{root,ref:f.consentRef,reason:'SYNTHETIC_OWNER_REVOKED_AFTER_ACCEPTANCE'});
  await call('primary-cancel',{programmeId:accepted.programmeId},202);await worker();
  const read=await call('primary-read',{programmeId:accepted.programmeId}),calls=await sourceCalls(f);
  assert.equal(read.status,'STOPPED',JSON.stringify(read));assert.equal(read.findings.length,0);
  assert.deepEqual(calls.map((c:any)=>c.operation),['ACQUIRE','STATUS']);
  assert(read.costReceipts.some((r:any)=>r.kind==='ACQUISITION'&&r.status==='RECONCILED'&&r.microUsd==='300'));
  const raw=(await platform!.admin.query('SELECT count(*)::int n FROM finnor_os.s1_primary_observations WHERE programme_id=$1',[accepted.programmeId])).rows[0];assert.equal(raw.n,0);
  return {read,calls,raw};
 });
 await test('shared-original-grant',{},'a second canonical Work cannot refresh the original shared one-request acquisition allowance',async()=>{
  const f=await build('facility',{singleSource:true,limitRequests:1}),first=await finish(f);assert.equal(first.status,'COMPLETE');
  const opened=await call('primary-open-work',{root,instruction:'Second Work under the exact original one-request grant',idempotencyKey:randomUUID()},201);
  const second=await finish({...f,intake:{...f.intake,workId:opened.workId,expectedWorkInputId:opened.workInputId,idempotencyKey:randomUUID()}});
  assert.equal(second.status,'BLOCKED');assert.equal(second.reason,'ORIGINAL_SHARED_PRIMARY_GRANT_EXHAUSTED');
  const calls=await sourceCalls(f);assert.equal(calls.filter((c:any)=>c.operation==='ACQUIRE').length,1);return {first,second,calls};
 });
 await test('consumer-revocation',{},'revocation fences the consumed exact finding and the actual stored underwriting run without erasing history',async()=>{
  assert(lastFacility?.run,'DEPENDENT_UNDERWRITING_PROOF_UNAVAILABLE');
  await call('primary-governance-revoke',{root,ref:lastFacility.fixture.consentRef,reason:'SYNTHETIC_CONSUMED_FINDING_CONSENT_REVOKED'});
  const read=await call('primary-read',{programmeId:lastFacility.programmeId});assert.equal(read.status,'BLOCKED');assert.equal(read.findings.length,0);assert.equal(read.assertions.length,0);assert(!JSON.stringify({findings:read.findings,assertions:read.assertions}).includes('5000000'));
  await assert.rejects(()=>getUnderwritingRun(ctx,lastFacility.run.id),/SOURCE_RIGHTS_MEMBERSHIP_OR_WORK_CHANGED/);
  const refused=await http!.call('primary-consume',{investmentCaseId:caseId,modelVersionId:lastFacility.modelVersion,worldAt:new Date().toISOString(),idempotencyKey:randomUUID(),workId:lastFacility.workId,bindings:{facility:{findingId:lastFacility.findings[0].artifactId,economicId:'additional-facility-1'}}});assert.equal(refused.status,422);assert.equal(refused.body.predicate,'SOURCE_RIGHTS_MEMBERSHIP_OR_WORK_CHANGED');
  const retained=(await platform!.admin.query('SELECT digest FROM finnor_os.v2_findings WHERE id=$1',[lastFacility.findings[0].artifactId])).rows;assert.equal(retained.length,1);
  return {read,refused,retained,storedRunId:lastFacility.run.id};
 });
 }
 const exported={auth:http.observed,source:await rpc({type:'inspect'}),
  events:(await platform.admin.query('SELECT programme_id,semantic_owner,kind,body,created_at FROM finnor_os.v2_events ORDER BY created_at')).rows,
  observations:(await platform.admin.query('SELECT id,programme_id,evidence_source_id,evidence_version_id,body,digest FROM finnor_os.s1_primary_observations ORDER BY retrieved_at')).rows,
  costs:(await platform.admin.query('SELECT charge_key,programme_id,reserved_micro_usd,actual_micro_usd,possible_additional_micro_usd,reserved_cpu_micros,actual_cpu_micros,receipt FROM finnor_os.s5_primary_charges ORDER BY created_at')).rows,
  queue:(await platform.admin.query("SELECT id,type,status,claim_fence,protocol_version,retry_safety,payload FROM finnor_os.jobs WHERE type='advance_primary_diligence_v1' ORDER BY id")).rows,
 };
 const redact=(value:any):any=>value instanceof Date?value.toISOString():Array.isArray(value)?value.map(redact):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='token'&&typeof item==='string'?'REDACTED_EPHEMERAL_LEASE_TOKEN':redact(item)])):value;
 await writeFile(join(output,'actual-queue-source-meter-trace.json'),JSON.stringify(redact(exported),null,2)+'\n');
}catch(error){rows.push({id:'runner-boundary',status:'FAIL',failure:{message:(error as Error).message,stack:(error as Error).stack}});}
finally{
 budget.dispose();await save();for(const child of children)child.kill('SIGKILL');await http?.close().catch(()=>undefined);await platform?.close().catch(()=>undefined);
}
await new Promise<void>(yes=>process.stdout.write(JSON.stringify({status:outcome(),evidence:output,cases:rows.map(r=>({id:r.id,status:r.status,failure:r.failure?.message}))})+'\n',()=>yes()));
process.exit(rows.some(r=>r.status==='FAIL')?1:0);

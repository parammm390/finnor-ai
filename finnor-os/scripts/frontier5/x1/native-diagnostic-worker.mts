/** Existing Objective + registered production queue with equal raw-source/model
 * equipment. This private development collector never sees the hidden oracle. */
import {readFile,appendFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {FinnorOrchestrator} from '@finnor/orchestration';
import {createWorker} from '../../../apps/worker/src/index';
import {closePool,getPool} from '@finnor/db';
import {GroqProvider,registerProvider,type LLMProvider} from '../../../packages/tools/src/llm';
import {loadInstitutionProfile} from '../../../packages/private-equity/src/institution-program/store';
import {acquireInstitutionOriginal,readInstitutionMandate,withInstitutionOriginalReuse} from '../../../packages/private-equity/src/institution-program/source-authority';
import {withInstitutionMeter,persistInstitutionLifecycleCompute,type InstitutionPhysicalObservation} from '../../../packages/private-equity/src/institution-program/meter';
import {chargeInstitutionDemand} from '../../../packages/private-equity/src/allocation-store';
import {sha} from '../../../packages/private-equity/src/evidence-execution/store';
import type {PeMutationContext} from '../../../packages/private-equity/src/types';
import {employeeAuthoritySnapshot} from '@finnor/authority';

const controlPath=process.env.FINNOR_X1_DIAGNOSTIC_CONTROL;
if(!controlPath?.startsWith('/'))throw Error('PRIVATE_NATIVE_DIAGNOSTIC_CONTROL_REQUIRED');
const bytes=await readFile(controlPath);if(bytes.length>65536)throw Error('NATIVE_DIAGNOSTIC_CONTROL_BOUND');
const control=JSON.parse(bytes.toString('utf8'));
if(control.schema!=='finnor.x1.native-diagnostic-control.v1'||!['on','off'].includes(control.arm)
  ||!control.outputPath?.startsWith('/')||!Array.isArray(control.grantIds)||control.grantIds.length>16)
  throw Error('EXACT_NATIVE_DIAGNOSTIC_CONTROL_REQUIRED');
const ctx:PeMutationContext={auth:{tenantId:control.tenantId,userId:control.principalId,employeeId:control.principalId,role:'owner'},
  provenance:{sourceSystem:'X1:matched-native-development-collector',createdBy:control.principalId}};
const role=(await getPool().query(`SELECT current_user,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`)).rows[0];
if(role.current_user!=='finnor_worker'||role.rolsuper||role.rolbypassrls||process.env.AUTH_DEV_BYPASS!=='0')
  throw Error('RESTRICTED_NATIVE_DIAGNOSTIC_WORKER_REQUIRED');
const profile=loadInstitutionProfile();let sourceAttempts=0,modelCalls=0,actionAttempts=0,outputBytes=0;
const record=async(body:unknown)=>{
  const line=JSON.stringify({at:new Date().toISOString(),arm:control.arm,...body as object})+'\n';
  outputBytes+=Buffer.byteLength(line);if(outputBytes>64*1024*1024)throw Error('NATIVE_DIAGNOSTIC_OUTPUT_BOUND');
  await appendFile(control.outputPath,line,{mode:0o600});
};
registerProvider('x1-equipped-native',()=>{
  const actual=new GroqProvider(process.env.GROQ_API_KEY,'openai/gpt-oss-120b');
  const wrapper:LLMProvider={name:'groq',get lastUsage(){return actual.lastUsage;},
    get lastAttempts(){return actual.lastAttempts;},async complete(opts){
      if(++modelCalls>12)throw Error('ORIGINAL_MATCHED_MODEL_CALL_BOUND');
      const invocationId=randomUUID(),begun=performance.now(),startedAt=new Date().toISOString();
      const observations:InstitutionPhysicalObservation[]=[];let status='REFUSED',responseDigest:string|null=null;
      await chargeInstitutionDemand(ctx,control.parentReservation,{responsibilityIdentity:'x1-compiler-episode:'+control.episodeId,
        phase:'LIFECYCLE',ordinal:1,units:1,physicalInvocationId:invocationId});
      try{
        const originals=await withInstitutionMeter({physicalObservations:observations,
          sourceAttempt:async(grantId)=>{
            if(!control.grantIds.includes(grantId))throw Error('NATIVE_SOURCE_OUTSIDE_ORIGINAL_TASK');
            if(++sourceAttempts>profile.bounds.authorizedAcquisitionCalls)throw Error('ORIGINAL_NATIVE_ACQUISITION_BOUND');
            await chargeInstitutionDemand(ctx,control.parentReservation,{responsibilityIdentity:'x1-compiler-episode:'+control.episodeId,
              phase:'LIFECYCLE',ordinal:1,units:1,physicalInvocationId:randomUUID()});
          },checkerAttempt:async()=>{throw Error('NATIVE_BASELINE_MUST_NOT_CALL_X1_CHECKER');}},
          ()=>withInstitutionOriginalReuse(async()=>{
            const values=[];for(const grantId of control.grantIds)values.push(await acquireInstitutionOriginal(ctx,control.workId,grantId,profile));
            return values;
          }));
        const mandate=await readInstitutionMandate(ctx,control.workId);
        const rawEquipment={authorizedOriginals:originals,standingMandate:mandate,
          instruction:'Use these original owner records with the native query/action tools. Infer identities and duties yourself. No candidate mapping, expected obligation ledger or scoring result is supplied.'};
        const response=await actual.complete({...opts,maxOutputTokens:4096,
          user:opts.user+'\n\nCURRENT_AUTHORIZED_ORIGINAL_EQUIPMENT\n'+JSON.stringify(rawEquipment)});
        status='MODEL_RESPONSE';responseDigest=sha(response);return response;
      }finally{
        const measurement={invocationId,startedAt,elapsedMs:performance.now()-begun,status,responseDigest,
          sourceAttempts,physicalSourceObservations:observations,modelCalls,usage:actual.lastUsage??null,
          physicalModelAttempts:actual.lastAttempts??[],actualPriceUsd:null,
          requestedModel:'openai/gpt-oss-120b',outputTokenBound:4096,hiddenOracleExposed:false};
        await record({event:'ACTUAL_NATIVE_MODEL_AND_SOURCE_INVOCATION',...measurement});
        await persistInstitutionLifecycleCompute(ctx,{workId:control.workId,episodeId:control.episodeId,
          parentReservation:control.parentReservation,rightsRevision:String((await employeeAuthoritySnapshot(ctx.auth)).revision),
          invocationId,startedAt,elapsedMs:measurement.elapsedMs,operation:'DIAGNOSTIC',status,
          receiptDigest:sha(measurement),measurements:measurement});
      }
    }};return wrapper;
},()=>Boolean(process.env.GROQ_API_KEY));
for(const purpose of ['PLANNING','CRITIC','REPAIR','CLASSIFICATION','ANSWER'])process.env['LLM_PROVIDER_'+purpose]='x1-equipped-native';
process.env.P3_GOVERNORS='1';
if(control.arm==='off'){
  const draft=FinnorOrchestrator.prototype.draftObjectiveAction;
  FinnorOrchestrator.prototype.draftObjectiveAction=async function(params){
    if(params.workId!==control.workId||params.tenantId!==control.tenantId)throw Error('NATIVE_ACTION_OUTSIDE_ORIGINAL_TASK');
    if(++actionAttempts>25)throw Error('ORIGINAL_MATCHED_NATIVE_ACTION_BOUND');
    const invocationId=randomUUID(),begun=performance.now(),startedAt=new Date().toISOString();let outcome:unknown=null;
    await chargeInstitutionDemand(ctx,control.parentReservation,{responsibilityIdentity:'x1-compiler-episode:'+control.episodeId,
      phase:'EXECUTION',ordinal:actionAttempts,units:1});
    try{outcome=await draft.call(this,params);return outcome as Awaited<ReturnType<typeof draft>>;}
    finally{await record({event:'ACTUAL_NATIVE_ACTION_INVOCATION',invocationId,startedAt,elapsedMs:performance.now()-begun,
      actionAttempts,actionId:params.actionId,actionType:params.actionType,payloadDigest:sha(params.payload),
      resultDigest:outcome?sha(outcome):null,parentReservation:control.parentReservation});}
  };
  const orchestrator=new FinnorOrchestrator();
  const objective=await orchestrator.startObjective(control.instruction,ctx.auth,{channel:'console',
    workId:control.workId,workInputId:control.workInputId,instructionId:control.instructionId,
    idempotencyKey:control.originalIdempotencyKey,maxSteps:12,maxActions:25,maxQueries:12,
    maxPlannerFailures:3,maxConsecutiveNoProgress:3,deadlineAt:new Date(control.originalDeadline),
    successCondition:{version:1,statement:'Complete the standing responsibility using current original owner evidence.',
      mode:'all',source:'explicit',criteria:[{kind:'no_open_execution'},{kind:'all_objective_effects_verified',minimumCount:3}]}});
  await record({event:'ACTUAL_NATIVE_OBJECTIVE_STARTED',objective,originalParent:control.parentReservation});
}
console.log(JSON.stringify({event:'X1_PHYSICAL_WORKER_READY',pid:process.pid,role,arm:control.arm,
  registration:'ACTUAL_PRODUCTION_CREATE_WORKER',authDevBypass:false}));
const queue=createWorker(),controller=new AbortController();
const stop=()=>controller.abort();process.once('SIGTERM',stop);process.once('SIGINT',stop);
const timer=setTimeout(stop,600000);
try{await queue.runLoop(200,controller.signal,1);}finally{clearTimeout(timer);await closePool();}

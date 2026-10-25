import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Daytona,DaytonaError,DaytonaNotFoundError,type Sandbox} from '@daytona/sdk';
import {z} from 'zod';
import type {IsolatedNodeRequest,IsolatedNodeResult} from './executor';
import type {ExecutorJournalEntry,IsolatedExecutionCustody} from './executor-custody';
import {s6AdapterContract} from './adapter-contract';

const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const ProfileSchema=z.object({snapshotId:z.string().uuid(),image:z.string().regex(/^\S+@sha256:[a-f0-9]{64}$/),target:z.string().min(1).max(80),user:z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/).refine(v=>v!=='root'),nodeBinary:z.string().regex(/^\/[A-Za-z0-9_./-]+$/),nodeDigest:digest}).strict();
const IntentSchema=z.object({bindingDigest:digest,scriptDigest:digest,inputDigest:digest,profileDigest:digest,endpointDigest:digest,bootstrapDigest:digest,name:z.string().regex(/^finnor-[a-f0-9]{64}$/),session:z.literal('analysis'),directory:z.string().regex(/^\/tmp\/finnor-[a-f0-9]{64}$/),deadlineAt:z.string().datetime(),recoveryDeadlineAt:z.string().datetime(),originalDeadlineAt:z.string().datetime(),wallTimeMs:z.number().int().min(1).max(10000),profile:ProfileSchema}).strict();
const ResultSchema=z.object({schema:z.literal('finnor.daytona-node-result.v1'),scriptDigest:digest,inputDigest:digest,nodeDigest:digest,stdout:z.string(),stderr:z.string(),exitCode:z.number().int().nullable(),signal:z.string().nullable(),termination:z.enum(['EXITED','WALL_TIME_LIMIT','OUTPUT_LIMIT']),startedAt:z.string().datetime(),finishedAt:z.string().datetime(),outputBytes:z.number().int().nonnegative().max(131072)}).strict();
const get=(entries:ExecutorJournalEntry[],stage:ExecutorJournalEntry['stage'])=>entries.find(e=>e.stage===stage)?.body;
export class RemoteExecutionPendingError extends Error {constructor(){super('REMOTE_EXECUTION_RECONCILIATION_REQUIRED');}}
const sleep=(ms:number)=>new Promise<void>(yes=>setTimeout(yes,ms));
function credentials(){
 const key=process.env.DAYTONA_API_KEY;if(!key?.trim())throw Error('DAYTONA_CREDENTIAL_UNAVAILABLE');
 const endpoint=process.env.DAYTONA_API_URL??'https://app.daytona.io/api';let url:URL;try{url=new URL(endpoint);}catch{throw Error('DAYTONA_ENDPOINT_INVALID');}
 if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(process.env.NODE_ENV==='test'&&url.protocol==='http:'&&['127.0.0.1','::1','[::1]'].includes(url.hostname)))throw Error('DAYTONA_ENDPOINT_INVALID');
 return {key,endpoint};
}
function configuration(){
 const auth=credentials();let raw:unknown;try{raw=JSON.parse(process.env.FINNOR_DAYTONA_PROFILE??'');}catch{throw Error('DAYTONA_PINNED_PROFILE_REQUIRED');}
 const parsed=ProfileSchema.safeParse(raw);if(!parsed.success)throw Error('DAYTONA_PINNED_PROFILE_INVALID');
 return {...auth,profile:parsed.data};
}
/** Pin the validated endpoint/profile without provider calls or credentials. */
export function daytonaExecutionConfigurationDigest(){const config=configuration();return sha(JSON.stringify({endpoint:config.endpoint,profile:config.profile}));}
async function bounded<T>(deadline:number,fn:()=>Promise<T>):Promise<T>{
 const left=deadline-Date.now();if(left<=0)throw new RemoteExecutionPendingError();
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([fn(),new Promise<never>((_,no)=>{timer=setTimeout(()=>no(new RemoteExecutionPendingError()),left);})]);}finally{if(timer)clearTimeout(timer);}
}
async function find(client:Daytona,id:string):Promise<Sandbox|null>{try{return await client.get(id);}catch(error){if(error instanceof DaytonaNotFoundError)return null;throw error;}}
function assertSandboxIdentity(s:Sandbox,intent:z.infer<typeof IntentSchema>,acceptedId?:string){
 if(acceptedId&&s.id!==acceptedId||s.name!==intent.name||s.labels?.['finnor-attempt']!==intent.name||s.labels?.['finnor-binding']!==intent.bindingDigest)throw Error('DAYTONA_SANDBOX_SCOPE_MISMATCH');
}
async function assertAnalysisRuntime(s:Sandbox,intent:z.infer<typeof IntentSchema>,client:Daytona,deadline:number){
 const p=intent.profile,snapshot=s.snapshot?await bounded(deadline,()=>client.snapshot.get(s.snapshot!)):null;
 if(!snapshot||snapshot.id!==p.snapshotId||snapshot.imageName!==p.image||s.target!==p.target||s.user!==p.user||s.public!==false||s.networkBlockAll!==true||s.volumes?.length||s.linkedSandboxId)throw Error('DAYTONA_ANALYSIS_PROFILE_MISMATCH');
}
async function resultBytes(sandbox:Sandbox,path:string,deadline:number){
 const stream=await bounded(deadline,()=>sandbox.fs.downloadFileStream(path,Math.max(1,Math.ceil((deadline-Date.now())/1000))));
 const parts:Buffer[]=[];let size=0;
 try{await bounded(deadline,async()=>{for await(const raw of stream){const b=Buffer.from(raw);if((size+=b.length)>800000)throw Error('DAYTONA_RESULT_BYTE_BOUND');parts.push(b);}});}finally{stream.destroy();}
 return Buffer.concat(parts).toString('utf8');
}
/** Reconcile/delete only the original sandbox. This path never creates a VM,
 * uploads private inputs, dispatches a command or publishes a financial result. */
export async function reconcileDaytonaExecution(custody:IsolatedExecutionCustody){
 const entries=await custody.read(),intent=IntentSchema.parse(get(entries,'INTENT'));
 if(get(entries,'DELETED'))return;
 const config=credentials();if(sha(config.endpoint)!==intent.endpointDigest)throw Error('DAYTONA_ORIGINAL_ENDPOINT_CHANGED');
 const client=new Daytona({apiKey:config.key,apiUrl:config.endpoint,target:intent.profile.target,otelEnabled:false,requestTimeoutMs:3000});
 try{
 const accepted=get(entries,'SANDBOX_ACCEPTED'),id=typeof accepted?.id==='string'?accepted.id:intent.name;
 const sandbox=await find(client,id);
 if(!sandbox){
  // A missing accepted ID proves its removal. Name-only 404 cannot establish
  // that a timed-out creation was never accepted or will not appear later.
  if(accepted)await custody.record('DELETED',{id,observed:'ACCEPTED_ID_NOT_FOUND'});else throw new RemoteExecutionPendingError();
  return;
 }
 assertSandboxIdentity(sandbox,intent,accepted?String(accepted.id):undefined);
 await custody.record('DELETE_INTENT',{id:sandbox.id});
 await sandbox.delete(3,true);
 await custody.record('DELETED',{id:sandbox.id,observed:'PROVIDER_DESTROYED'});
 }finally{await client[Symbol.asyncDispose]();}
}

export async function launchDaytonaNodeExecutor(request:IsolatedNodeRequest,custody:IsolatedExecutionCustody):Promise<IsolatedNodeResult>{
 if(!/^[a-f0-9]{64}$/.test(custody.attemptKey))throw Error('DAYTONA_DURABLE_ATTEMPT_REQUIRED');
 const config=configuration(),input=JSON.stringify(request.input),bootstrap=await readFile(new URL('./daytona-bootstrap.mjs',import.meta.url),'utf8');if(input===undefined)throw Error('EXECUTOR_ENVELOPE_INVALID');
 const profileDigest=sha(JSON.stringify(config.profile)),bindingDigest=sha(JSON.stringify(custody.binding));
 const original=Date.parse(custody.originalDeadlineAt);if(!Number.isFinite(original))throw Error('DAYTONA_ORIGINAL_DEADLINE_REQUIRED');
 if(Date.now()>=original)throw Error('DAYTONA_ORIGINAL_EPISODE_DEADLINE_EXHAUSTED');
 await custody.assertCurrent();
 // Provisioning and result transport consume the original episode, not the
 // child's execution allowance. The supervisor starts that finite timer only
 // when it launches the module, and still stops at this original deadline.
 const proposed={bindingDigest,scriptDigest:sha(request.script),inputDigest:sha(input),profileDigest,endpointDigest:sha(config.endpoint),bootstrapDigest:sha(bootstrap),name:'finnor-'+custody.attemptKey,session:'analysis' as const,directory:'/tmp/finnor-'+custody.attemptKey,deadlineAt:custody.originalDeadlineAt,recoveryDeadlineAt:custody.originalDeadlineAt,originalDeadlineAt:custody.originalDeadlineAt,wallTimeMs:request.wallTimeMs,profile:config.profile};
 const claimed=await custody.record('INTENT',proposed),intent=IntentSchema.parse(claimed.body);
 for(const key of ['bindingDigest','scriptDigest','inputDigest','profileDigest','endpointDigest','bootstrapDigest','name','originalDeadlineAt'] as const)if(intent[key]!==proposed[key])throw Error('DAYTONA_ORIGINAL_ATTEMPT_BINDING_CHANGED');
 // Reconnection may observe an already completed original command after its
 // execution deadline. This does not authorize another upload or dispatch.
 const deadline=Date.parse(claimed.created?intent.deadlineAt:intent.recoveryDeadlineAt),client=new Daytona({apiKey:config.key,apiUrl:config.endpoint,target:config.profile.target,otelEnabled:false,requestTimeoutMs:Math.max(1,Math.min(3000,deadline-Date.now()))});
 let entries=await custody.read(),raw=get(entries,'RESULT');
 try{
  if(!raw){
   let sandbox:Sandbox|null=null;const accepted=get(entries,'SANDBOX_ACCEPTED');
   if(claimed.created){
    await custody.assertCurrent();
    const snapshot=await bounded(deadline,()=>client.snapshot.get(config.profile.snapshotId));
    if(snapshot.id!==config.profile.snapshotId||snapshot.imageName!==config.profile.image||snapshot.state!=='active')throw Error('DAYTONA_PINNED_SNAPSHOT_CHANGED');
    sandbox=await bounded(deadline,()=>client.create({name:intent.name,snapshot:config.profile.snapshotId,language:'javascript',user:config.profile.user,public:false,networkBlockAll:true,envVars:{},labels:{'finnor-attempt':intent.name,'finnor-binding':bindingDigest},ephemeral:true,autoStopInterval:1,ttlMinutes:2},{timeout:Math.max(1,Math.ceil((deadline-Date.now())/1000))}));
   }else{
    while(Date.now()<deadline&&!sandbox){sandbox=await bounded(deadline,()=>find(client,accepted?String(accepted.id):intent.name));if(!sandbox)await sleep(Math.min(100,Math.max(1,deadline-Date.now())));}
   }
   if(!sandbox)throw new RemoteExecutionPendingError();
   assertSandboxIdentity(sandbox,intent,accepted?String(accepted.id):undefined);
   await assertAnalysisRuntime(sandbox,intent,client,deadline);
   await custody.record('SANDBOX_ACCEPTED',{id:sandbox.id});
   if(sandbox.state!=='started')throw new RemoteExecutionPendingError();
   const command=`/usr/bin/env -i HOME=${intent.directory} TMPDIR=${intent.directory} LANG=C TZ=UTC NODE_ENV=production ${config.profile.nodeBinary} ${intent.directory}/bootstrap.mjs ${intent.directory}`;
   let dispatch=get(entries,'DISPATCH_INTENT');
   if(!dispatch){
    const dispatchDeadline=Date.parse(intent.deadlineAt);if(Date.now()>=dispatchDeadline)throw new RemoteExecutionPendingError();
    await custody.assertCurrent();
    try{const directory=await bounded(dispatchDeadline,()=>sandbox!.fs.getFileDetails(intent.directory));if(!directory.isDir)throw Error('DAYTONA_PRIVATE_DIRECTORY_INVALID');}catch(error){if(!(error instanceof DaytonaNotFoundError))throw error;await bounded(dispatchDeadline,()=>sandbox!.fs.createFolder(intent.directory,'700'));}
    await bounded(dispatchDeadline,()=>sandbox!.fs.uploadFiles([{source:Buffer.from(bootstrap),destination:intent.directory+'/bootstrap.mjs'},{source:Buffer.from(JSON.stringify({script:request.script,input:request.input,scriptDigest:intent.scriptDigest,inputDigest:intent.inputDigest,nodeDigest:config.profile.nodeDigest,wallTimeMs:intent.wallTimeMs,deadlineAt:intent.deadlineAt})),destination:intent.directory+'/envelope.json'}],Math.max(1,Math.ceil((dispatchDeadline-Date.now())/1000))));
    try{await bounded(dispatchDeadline,()=>sandbox!.process.getSession(intent.session));}catch(error){if(!(error instanceof DaytonaNotFoundError))throw error;await bounded(dispatchDeadline,()=>sandbox!.process.createSession(intent.session));}
    if(Date.now()>=dispatchDeadline)throw new RemoteExecutionPendingError();
    const registered=await custody.record('DISPATCH_INTENT',{sandboxId:sandbox.id,session:intent.session,commandDigest:sha(command)});dispatch=registered.body;
    if(registered.created){await custody.assertCurrent();const response=await bounded(dispatchDeadline,()=>sandbox!.process.executeSessionCommand(intent.session,{command,runAsync:true,suppressInputEcho:true}));if(!response.cmdId)throw new RemoteExecutionPendingError();await custody.record('COMMAND_ACCEPTED',{id:response.cmdId});}
   }
   if(dispatch.sandboxId!==sandbox.id||dispatch.commandDigest!==sha(command))throw Error('DAYTONA_ORIGINAL_COMMAND_CHANGED');
   let commandId=String(get(await custody.read(),'COMMAND_ACCEPTED')?.id??'');
   while(Date.now()<deadline){
    if(!commandId){const session=await bounded(deadline,()=>sandbox!.process.getSession(intent.session)),commands=session.commands.filter(c=>c.command===command);if(commands.length>1)throw Error('DAYTONA_DUPLICATE_PHYSICAL_COMMAND');if(commands[0]){commandId=commands[0].id;await custody.record('COMMAND_ACCEPTED',{id:commandId});}}
    if(commandId){const state=await bounded(deadline,()=>sandbox!.process.getSessionCommand(intent.session,commandId));if(state.command!==command)throw Error('DAYTONA_COMMAND_SCOPE_MISMATCH');if(state.exitCode!==undefined){if(state.exitCode!==0)throw Error('DAYTONA_SUPERVISOR_FAILED');const bytes=await resultBytes(sandbox,intent.directory+'/result.json',deadline);raw=ResultSchema.parse(JSON.parse(bytes));await custody.record('RESULT',raw);break;}}
    await sleep(Math.min(100,Math.max(1,deadline-Date.now())));
   }
   if(!raw)throw new RemoteExecutionPendingError();
  }
  const result=ResultSchema.parse(raw);
  if(result.scriptDigest!==intent.scriptDigest||result.inputDigest!==intent.inputDigest||result.nodeDigest!==config.profile.nodeDigest||Buffer.byteLength(result.stdout)+Buffer.byteLength(result.stderr)>131072||Date.parse(result.finishedAt)>Date.parse(intent.deadlineAt)+1000)throw Error('DAYTONA_RESULT_BINDING_INVALID');
  await custody.assertCurrent();
  try{await reconcileDaytonaExecution(custody);}catch{/* Durable cleanup owns unresolved deletion; no successful deletion is invented. */}
  entries=await custody.read();const accepted=get(entries,'SANDBOX_ACCEPTED')!,command=get(entries,'COMMAND_ACCEPTED')!;
  return {stdout:result.stdout,stderr:result.stderr,exitCode:result.exitCode,signal:result.signal,termination:result.termination,provenance:{schema:'finnor.s6.executor-provenance.v1',substrate:'DAYTONA_PRIVATE_ANALYSIS_V1',contract:s6AdapterContract('DAYTONA_PRIVATE_ANALYSIS_V1'),binding:custody.binding,attemptKey:custody.attemptKey,sandboxId:accepted.id,commandId:command.id,scriptDigest:intent.scriptDigest,inputDigest:intent.inputDigest,nodeDigest:result.nodeDigest,profileDigest,originalDeadlineAt:intent.originalDeadlineAt,deadlineAt:intent.deadlineAt,cleanup:get(entries,'DELETED')?'PROVIDER_DESTROYED':'RECONCILIATION_REQUIRED',cost:{money:null,status:'UNMETERED'},compute:{id:'daytona:'+custody.attemptKey},authority:'NONE_OUTPUT_UNTRUSTED',productionAdmission:'PROTECTED_EXECUTION_UNADMITTED',limits:{wallTimeMs:intent.wallTimeMs,outputBytes:131072,nodeOldSpaceMiB:128,totalMemory:'SNAPSHOT_ALLOCATION_NOT_INDEPENDENTLY_QUALIFIED',cpu:'UNQUALIFIED',pids:'UNQUALIFIED',diskBytes:'UNQUALIFIED'}}};
 }catch(error){
  if(error instanceof DaytonaError||error instanceof RemoteExecutionPendingError)throw new RemoteExecutionPendingError();
  // Reconciliation is deletion-only, including after currentness/rights loss.
  try{await reconcileDaytonaExecution(custody);}catch{/* Original custody/cleanup job and possible charges remain. */}
  throw error;
 }finally{await client[Symbol.asyncDispose]();}
}

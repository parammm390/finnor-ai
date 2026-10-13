/** Finite independently administered execution primitives. Actual authenticated
 * owner HTTP and durable exposure cursors; no candidate truth or signing keys. */
import {readFile,rename,mkdir,open,unlink,realpath,lstat} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import {digest} from '../../../packages/capability-evolution/src/contracts';

const hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true});
const scalar=z.union([z.string(),z.number().finite(),z.boolean(),z.null()]);
const path=z.array(z.union([z.string().min(1).max(128),z.number().int().nonnegative().max(150000)])).max(16);
const localOrigin=z.string().url().superRefine((value,ctx)=>{
  const url=new URL(value);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!url.port
    ||url.username||url.password||url.pathname!=='/'||url.hash||url.search)ctx.addIssue({code:'custom',message:'EXACT_REGISTERED_DISPOSABLE_LOOPBACK_ORIGIN_REQUIRED'});
});
const endpoint=z.object({origin:localOrigin,tenantId:z.string().uuid(),principalId:z.string().uuid(),
  tokenEnvironmentVariable:z.string().regex(/^FINNOR_X1_QUAL_[A-Z0-9_]+$/)}).strict();
const request=z.object({path:z.string().regex(/^\/api\/[A-Za-z0-9_\[\]/-]+$/).max(512),
  method:z.enum(['GET','POST']),body:z.record(z.unknown()).optional()}).strict();
const readPredicate=z.object({path,equals:scalar}).strict();
const observation=request.extend({readOnly:z.literal(true),
  admittedOwnerReadReceiptDigest:hex,responseIdentityPath:path,expectedOwnerIdentity:z.string().min(1).max(256),
  appliedStatePredicates:z.array(readPredicate).min(1).max(64)}).strict();
const assertReadOnly=(input:z.infer<typeof observation>)=>{
  const knownPostReads=new Set(['/api/company-brain/institution-read','/api/company-brain/institution-status',
    '/api/company-brain/institution-sources','/api/company-brain/institution-inputs']);
  if(input.method!=='GET'&&!knownPostReads.has(input.path))throw Error('INDEPENDENT_SELECTOR_MUST_USE_AN_EXISTING_READ_ONLY_OWNER');
};
export const QualificationExecutionEvent=z.object({id:z.string().min(1).max(256),workId:z.string().uuid(),replicaAt:instant,
  occurredAt:instant,availableAt:instant,dependsOn:z.array(z.string().min(1).max(256)).max(64),
  originalIdempotencyKey:z.string().min(1).max(160),owner:endpoint,request,
  reconciliation:observation,clockOwner:endpoint,clockRequest:request,
  clockObservation:observation,clockReplicaPath:path,clockReceiptPath:path,
  originalEpisodeId:z.string().uuid(),originalGrantDigest:hex,originalDeadline:instant}).strict();
export const QualificationExecutionJournal=z.object({schema:z.literal('finnor.x1.qualification-execution-journal.v1'),
  protocolDigest:hex,candidateCutDigest:hex,allocationConventionDigest:hex,
  environments:z.array(z.object({id:z.string().min(1),replicaStart:instant,replicaEnd:instant,
    events:z.array(QualificationExecutionEvent).min(1).max(50000)}).strict()).length(10)}).strict();
export type OwnerEndpoint=z.infer<typeof endpoint>;
export const OwnerEndpointSchema=endpoint;
export type OwnerRequest=z.infer<typeof request>;
export const ExecutionLimits=z.object({ref:z.string().min(1).max(256),registrationDigest:hex,
  maxAcquisitionCalls:z.number().int().positive(),maxOutputBytes:z.number().int().positive().max(64*1024*1024),
  maxAggregateWallMs:z.number().positive().finite()}).strict();
export const NativeWorkerRegistration=z.object({schema:z.literal('finnor.x1.qualification-native-worker-registration.v1'),
  protocolDigest:hex,candidateCutDigest:hex,allocationConventionDigest:hex,
  runtime:z.object({mode:z.enum(['SOURCE_DEVELOPMENT','COMPILED_DEVELOPMENT']),digest:hex}).strict(),
  databaseIdentityDigest:hex,phase:z.enum(['replay','soak']),
  originalEpisodes:z.array(z.object({tenantId:z.string().uuid(),principalId:z.string().uuid(),workId:z.string().uuid(),
    originalEpisodeId:z.string().uuid(),originalGrantDigest:hex,originalDeadline:instant}).strict()).min(1).max(3840),
  envelope:z.object({ref:z.string().min(1),registrationDigest:hex,maxNativeDeliveries:z.number().int().positive(),
    maxAggregateWallMs:z.number().positive().finite(),maxOutputBytes:z.number().int().positive().max(64*1024*1024)}).strict(),
}).strict();
type ExecutionSlice={id:string;pid:number;startedAt:string;lastObservedAt:string;reservedWallMs:number;
  observedElapsedMs:number;status:'STARTED'|'FINISHED'|'FAILED'|'INTERRUPTED';endedAt?:string;
  unobservedTail:boolean;predicate?:string};
type Resources={limits:z.infer<typeof ExecutionLimits>;limitsDigest:string;outputBytes:number;
  acquisitionExposures:number;acknowledgedAcquisitions:number;slices:ExecutionSlice[];
  countersAreDurableExposureUpperBounds:true;moneyUsd:null;humanSeconds:null;aggregatePeakMemoryBytes:null};
type ReceiptRef={path:string;sha256:string;bytes:number};
type Cursor={schema:'finnor.x1.qualification-execution-cursor.v2';journalDigest:string;protocolDigest:string;
  candidateCutDigest:string;allocationConventionDigest:string;revision:number;
  entries:Array<{environmentId:string;eventId:string;invocationId:string;status:'EXPOSED'|'ACCEPTED'|'APPLIED'|'UNKNOWN'|'REFUSED'|'RECONCILIATION_REQUIRED';
    exposedAt:string;originalIdempotencyKey:string;originalEpisodeId:string;originalGrantDigest:string;originalDeadline:string;
    responseDigest?:string;responseStatus?:number;receiptDigest?:string;receiptRefs:ReceiptRef[];predicate?:string}>;
  resources:Resources;protectedQualificationEstablished:false};
const get=(value:unknown,segments:Array<string|number>):unknown=>{
  let current=value;for(const part of segments){
    if(!current||typeof current!=='object'||['__proto__','constructor','prototype'].includes(String(part)))return undefined;
    current=(current as Record<string|number,unknown>)[part];
  }return current;
};
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const transportRequest=(input:OwnerRequest)=>request.parse({path:input.path,method:input.method,
  ...(input.body!==undefined?{body:input.body}:{})});
const verifiedOwnerRead=(result:{status:number;body:unknown},spec:z.infer<typeof observation>)=>{
  if(result.status!==200||get(result.body,spec.responseIdentityPath)!==spec.expectedOwnerIdentity)
    throw Error('ACTUAL_FROZEN_RECONCILIATION_OWNER_IDENTITY_REQUIRED');
  return spec.appliedStatePredicates.every(predicate=>{
    const actual=get(result.body,predicate.path);return actual!==undefined&&digest(actual)===digest(predicate.equals);
  });
};
export async function callAuthenticatedOwner(owner:OwnerEndpoint,input:OwnerRequest,options:{deadlineAt:number;maxResponseBytes:number}){
  endpoint.parse(owner);const wire=transportRequest(input);
  const token=process.env[owner.tokenEnvironmentVariable];if(!token)throw Error('EXISTING_OWNER_SERVICE_CREDENTIAL_REQUIRED');
  const remaining=options.deadlineAt-Date.now();if(remaining<=0)throw Error('ORIGINAL_EXECUTION_DEADLINE_EXHAUSTED');
  const response=await fetch(owner.origin.replace(/\/$/,'')+wire.path,{method:wire.method,
    headers:{authorization:'Bearer '+token,'content-type':'application/json'},redirect:'error',
    ...(wire.method==='POST'?{body:JSON.stringify(wire.body??{})}:{}),
    signal:AbortSignal.timeout(Math.min(15000,remaining))});
  const reader=response.body?.getReader();if(!reader)throw Error('OWNER_RESPONSE_BODY_UNAVAILABLE');
  const chunks:Buffer[]=[];let total=0;
  try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;
    if(total>options.maxResponseBytes)throw Error('ORIGINAL_OWNER_RESPONSE_BOUND');chunks.push(Buffer.from(next.value));}}
  catch(error){await reader.cancel().catch(()=>{});throw error;}
  const bytes=Buffer.concat(chunks),body=JSON.parse(bytes.toString('utf8'));
  return {status:response.status,body,responseDigest:sha(bytes),responseBytes:total,observedAt:new Date().toISOString()};
}
export async function authenticateOwner(owner:OwnerEndpoint,deadlineAt:number){
  const result=await callAuthenticatedOwner(owner,{method:'GET',path:'/api/me'},{deadlineAt,maxResponseBytes:65536});
  if(result.status!==200||result.body.tenantId!==owner.tenantId
    ||(result.body.employeeId??result.body.userId)!==owner.principalId||result.body.role!=='owner')
    throw Error('ACTUAL_REGISTERED_OWNER_IDENTITY_REQUIRED');
  return result;
}
export function validateExecutionJournal(value:unknown,registration:{protocolDigest:string;candidateCutDigest:string;
  allocationConventionDigest:string;environments:Array<{id:string;replayJournalCommitment:string}>}){
  const journal=QualificationExecutionJournal.parse(value);
  if(journal.protocolDigest!==registration.protocolDigest||journal.candidateCutDigest!==registration.candidateCutDigest
    ||journal.allocationConventionDigest!==registration.allocationConventionDigest)throw Error('ORIGINAL_EXECUTION_REGISTRATION_CHANGED');
  if(new Set(journal.environments.map(e=>e.id)).size!==10)throw Error('ORIGINAL_TEN_ENVIRONMENT_POPULATION_REQUIRED');
  for(const environment of journal.environments){
    const expected=registration.environments.find(e=>e.id===environment.id);
    if(!expected||expected.replayJournalCommitment!==digest(environment))throw Error('INDEPENDENT_REPLAY_JOURNAL_PREIMAGE_CHANGED');
    if(Date.parse(environment.replicaEnd)-Date.parse(environment.replicaStart)!==30*86400000)
      throw Error('ORIGINAL_THIRTY_REPLICA_DAYS_REQUIRED');
    const prior=new Set<string>();let clock=Date.parse(environment.replicaStart);
    for(const item of environment.events){
      if(prior.has(item.id)||item.dependsOn.some(id=>!prior.has(id))||Date.parse(item.replicaAt)<clock
        ||Date.parse(item.replicaAt)>Date.parse(environment.replicaEnd)||Date.parse(item.occurredAt)>Date.parse(item.availableAt))
        throw Error('ORIGINAL_CAUSAL_REPLAY_JOURNAL_INVALID');
      if(item.request.method==='POST'&&item.request.body?.idempotencyKey!==item.originalIdempotencyKey)
        throw Error('ORIGINAL_EVENT_IDEMPOTENCY_KEY_REQUIRED');
      prior.add(item.id);clock=Date.parse(item.replicaAt);
    }
  }return journal;
}
async function durableWrite(path:string,bytes:Buffer){
  const file=await open(path,'wx',0o600);
  try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}
}
async function atomicCursor(path:string,body:unknown){
  const temporary=path+'.'+randomUUID()+'.tmp';
  try{await durableWrite(temporary,Buffer.from(JSON.stringify(body,null,2)+'\n'));await rename(temporary,path);
    const directory=await open(dirname(path),'r');try{await directory.sync();}finally{await directory.close();}}
  finally{await unlink(temporary).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function privatePaths(evidenceRoot:string,cursor:string){
  const root=await realpath(resolve(evidenceRoot)),cursorPath=resolve(cursor);
  if(!cursorPath.startsWith(root+'/'))throw Error('PRIVATE_ORIGINAL_CURSOR_PATH_REQUIRED');
  await mkdir(dirname(cursorPath),{recursive:true,mode:0o700});
  if(!(await realpath(dirname(cursorPath))).startsWith(root+'/')&&await realpath(dirname(cursorPath))!==root)
    throw Error('PRIVATE_CURSOR_DIRECTORY_ESCAPED');
  try{if((await lstat(cursorPath)).isSymbolicLink())throw Error('CURSOR_SYMLINK_REFUSED');}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  return {root,cursorPath};
}
const lockBody=z.object({schema:z.literal('finnor.x1.execution-lock.v1'),pid:z.number().int().positive(),
  nonce:z.string().uuid(),cursorPath:z.string(),pinDigest:hex,at:instant}).strict();
const processHasExited=(pid:number)=>{
  try{process.kill(pid,0);return false;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return true;throw error;}
};
async function acquireCursorLock(cursorPath:string,pinDigest:string,recovery?:{expectedLockDigest:string}){
  const lockPath=cursorPath+'.lock',body=lockBody.parse({schema:'finnor.x1.execution-lock.v1',pid:process.pid,
    nonce:randomUUID(),cursorPath,pinDigest,at:new Date().toISOString()});
  const create=async()=>{
    const file=await open(lockPath,'wx',0o600);
    try{await file.writeFile(JSON.stringify(body)+'\n');await file.sync();return file;}
    catch(error){await file.close();await unlink(lockPath);throw error;}
  };
  let file;
  try{file=await create();}
  catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST'||!recovery)throw error;
    hex.parse(recovery.expectedLockDigest);
    // The exclusive recovery claim serializes the read/check/rename sequence.
    // A crashed recovery claim is retained for explicit operator inspection.
    const recoveryPath=lockPath+'.recovery',claim=await open(recoveryPath,'wx',0o600);
    try{
      await claim.writeFile(JSON.stringify(body)+'\n');await claim.sync();
      const previousBytes=await readFile(lockPath);if(previousBytes.length>65536)throw Error('LOCK_INPUT_BOUND');
      const previous=lockBody.parse(JSON.parse(previousBytes.toString('utf8')));
      if(sha(previousBytes)!==recovery.expectedLockDigest||previous.cursorPath!==cursorPath||previous.pinDigest!==pinDigest
        ||!processHasExited(previous.pid))throw Error('EXACT_OWNED_DEAD_PROCESS_LOCK_REQUIRED');
      await rename(lockPath,lockPath+'.interrupted-'+previous.nonce+'.json');file=await create();
    }finally{await claim.close();await unlink(recoveryPath);}
  }
  return async(retainForRecovery=false)=>{
    await file.close();const current=lockBody.parse(JSON.parse(await readFile(lockPath,'utf8')));
    if(current.nonce!==body.nonce||current.pid!==process.pid)throw Error('OWNED_EXECUTION_LOCK_CHANGED');
    if(!retainForRecovery)await unlink(lockPath);
  };
}
const newResources=(limits:z.infer<typeof ExecutionLimits>):Resources=>({limits,limitsDigest:digest(limits),outputBytes:0,
  acquisitionExposures:0,acknowledgedAcquisitions:0,slices:[],countersAreDurableExposureUpperBounds:true,
  moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null});
function validateResources(resources:Resources,limits:z.infer<typeof ExecutionLimits>){
  if(!resources||digest(resources.limits)!==digest(limits)||resources.limitsDigest!==digest(limits)
    ||!Number.isSafeInteger(resources.outputBytes)||resources.outputBytes<0||resources.outputBytes>limits.maxOutputBytes
    ||!Number.isSafeInteger(resources.acquisitionExposures)||resources.acquisitionExposures<0
    ||resources.acquisitionExposures>limits.maxAcquisitionCalls||!Number.isSafeInteger(resources.acknowledgedAcquisitions)
    ||resources.acknowledgedAcquisitions<0||resources.acknowledgedAcquisitions>resources.acquisitionExposures
    ||!Array.isArray(resources.slices)||resources.countersAreDurableExposureUpperBounds!==true)
    throw Error('ORIGINAL_AGGREGATE_EXECUTION_LIMITS_OR_COUNTERS_CHANGED');
  for(const slice of resources.slices){
    if(!['STARTED','FINISHED','FAILED','INTERRUPTED'].includes(slice.status)||!Number.isFinite(slice.reservedWallMs)
      ||slice.reservedWallMs<=0||!Number.isFinite(slice.observedElapsedMs)||slice.observedElapsedMs<0
      ||!Number.isFinite(Date.parse(slice.startedAt))||!Number.isFinite(Date.parse(slice.lastObservedAt)))
      throw Error('DURABLE_EXECUTION_SLICE_INVALID');
  }
}
const chargedWallMs=(resources:Resources)=>resources.slices.reduce((n,s)=>n+
  (s.status==='STARTED'||s.status==='INTERRUPTED'?Math.max(s.reservedWallMs,s.observedElapsedMs):s.observedElapsedMs),0);
function managedState<T extends {resources:Resources;revision:number}>(state:T,cursorPath:string,root:string,
  deadlineAt:number,limits:z.infer<typeof ExecutionLimits>){
  validateResources(state.resources,limits);
  for(const previous of state.resources.slices)if(previous.status==='STARTED'){
    if(!processHasExited(previous.pid))throw Error('PREVIOUS_EXECUTION_PROCESS_STILL_LIVE');
    previous.status='INTERRUPTED';previous.unobservedTail=true;
  }
  const began=performance.now(),reservedWallMs=deadlineAt-Date.now();
  if(reservedWallMs<=0||reservedWallMs>840000||chargedWallMs(state.resources)+reservedWallMs>limits.maxAggregateWallMs)
    throw Error('ORIGINAL_AGGREGATE_WALL_BOUND');
  const slice:ExecutionSlice={id:randomUUID(),pid:process.pid,startedAt:new Date().toISOString(),
    lastObservedAt:new Date().toISOString(),reservedWallMs,observedElapsedMs:0,status:'STARTED',unobservedTail:false};
  state.resources.slices.push(slice);
  let finalizing=false;
  const saveState=async()=>{
    slice.observedElapsedMs=performance.now()-began;slice.lastObservedAt=new Date().toISOString();state.revision++;
    const base=state.resources.outputBytes;let bytes=Buffer.from(JSON.stringify(state,null,2)+'\n');
    // Charge the cursor's temporary write as well as immutable owner receipts.
    for(let i=0;i<8;i++){
      state.resources.outputBytes=base+bytes.length;const next=Buffer.from(JSON.stringify(state,null,2)+'\n');
      if(next.length===bytes.length){bytes=next;break;}bytes=next;
    }
    // Preserve room for one final cursor and bounded status/error growth before
    // exposing any request. An exhausted payload budget still records the stop.
    const finalizationReserve=finalizing?0:bytes.length+65536;
    if(state.resources.outputBytes+finalizationReserve>limits.maxOutputBytes){
      state.resources.outputBytes=base;throw Error('ORIGINAL_AGGREGATE_OUTPUT_BOUND');}
    await atomicCursor(cursorPath,state);
  };
  const saveReceipt=async(name:string,body:unknown):Promise<ReceiptRef>=>{
    if(!/^[a-z][a-z0-9-]+\.json$/.test(name))throw Error('PRIVATE_RECEIPT_NAME_REQUIRED');
    const bytes=Buffer.from(JSON.stringify(body,null,2)+'\n');
    if(state.resources.outputBytes+bytes.length>limits.maxOutputBytes)throw Error('ORIGINAL_AGGREGATE_OUTPUT_BOUND');
    state.resources.outputBytes+=bytes.length;await saveState();
    await durableWrite(join(root,name),bytes);return {path:name,sha256:sha(bytes),bytes:bytes.length};
  };
  const call=async(owner:OwnerEndpoint,req:OwnerRequest)=>{
    endpoint.parse(owner);transportRequest(req);
    if(!process.env[owner.tokenEnvironmentVariable])throw Error('EXISTING_OWNER_SERVICE_CREDENTIAL_REQUIRED');
    if(Date.now()>=deadlineAt)throw Error('ORIGINAL_EXECUTION_DEADLINE_EXHAUSTED');
    if(state.resources.acquisitionExposures>=limits.maxAcquisitionCalls)throw Error('ORIGINAL_AGGREGATE_ACQUISITION_BOUND');
    state.resources.acquisitionExposures++;await saveState();
    const result=await callAuthenticatedOwner(owner,req,{deadlineAt,maxResponseBytes:req.path==='/api/me'?65536:6*1024*1024});
    state.resources.acknowledgedAcquisitions++;await saveState();return result;
  };
  const authenticate=async(owner:OwnerEndpoint)=>{
    const result=await call(owner,{method:'GET',path:'/api/me'});
    if(result.status!==200||result.body.tenantId!==owner.tenantId
      ||(result.body.employeeId??result.body.userId)!==owner.principalId||result.body.role!=='owner')
      throw Error('ACTUAL_REGISTERED_OWNER_IDENTITY_REQUIRED');
    return result;
  };
  const measureAcquisition=async<T,>(read:()=>Promise<T>)=>{
    if(Date.now()>=deadlineAt)throw Error('ORIGINAL_EXECUTION_DEADLINE_EXHAUSTED');
    if(state.resources.acquisitionExposures>=limits.maxAcquisitionCalls)throw Error('ORIGINAL_AGGREGATE_ACQUISITION_BOUND');
    state.resources.acquisitionExposures++;await saveState();
    const result=await read();state.resources.acknowledgedAcquisitions++;await saveState();return result;
  };
  return {slice,saveState,saveReceipt,call,authenticate,measureAcquisition,
    finish:async(error?:unknown)=>{slice.status=error?'FAILED':'FINISHED';slice.endedAt=new Date().toISOString();
      if(error)slice.predicate=String((error as Error).message);finalizing=true;await saveState();}};
}
/** One finite command keeps all prior uncertain/refused entries. An uncertain
 * mutation is never redelivered by this function, including after a crash. */
export async function executeReplaySlice(input:{journal:z.infer<typeof QualificationExecutionJournal>;cursorPath:string;
  evidenceRoot:string;deadlineAt:number;limits:z.infer<typeof ExecutionLimits>;maxEvents:number;
  recovery?:{expectedLockDigest:string}}){
  const journal=QualificationExecutionJournal.parse(input.journal),limits=ExecutionLimits.parse(input.limits);
  const {root,cursorPath}=await privatePaths(input.evidenceRoot,input.cursorPath);
  if(!Number.isSafeInteger(input.maxEvents)||input.maxEvents<1||input.maxEvents>50000
    ||!Number.isFinite(input.deadlineAt)||input.deadlineAt<=Date.now()||input.deadlineAt-Date.now()>840000)
    throw Error('REGISTERED_FINITE_REPLAY_ENVELOPE_REQUIRED');
  const release=await acquireCursorLock(cursorPath,digest({journalDigest:digest(journal),limits}),input.recovery);
  let managed:ReturnType<typeof managedState<Cursor>>|undefined,failure:unknown;
  try{
    let cursor:Cursor;
    try{cursor=JSON.parse(await readFile(cursorPath,'utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      cursor={schema:'finnor.x1.qualification-execution-cursor.v2',journalDigest:digest(journal),protocolDigest:journal.protocolDigest,
        candidateCutDigest:journal.candidateCutDigest,allocationConventionDigest:journal.allocationConventionDigest,
        revision:0,entries:[],resources:newResources(limits),protectedQualificationEstablished:false};}
    if(cursor.schema!=='finnor.x1.qualification-execution-cursor.v2'||cursor.journalDigest!==digest(journal)
      ||cursor.protocolDigest!==journal.protocolDigest||cursor.candidateCutDigest!==journal.candidateCutDigest
      ||cursor.allocationConventionDigest!==journal.allocationConventionDigest||!Number.isSafeInteger(cursor.revision)
      ||cursor.revision<0||!Array.isArray(cursor.entries)||cursor.protectedQualificationEstablished!==false
      ||new Set(cursor.entries.map(e=>JSON.stringify([e.environmentId,e.eventId]))).size!==cursor.entries.length)
      throw Error('ORIGINAL_DURABLE_EXECUTION_CURSOR_CHANGED');
    validateResources(cursor.resources,limits);
    for(const entry of cursor.entries){
      if(!journal.environments.some(e=>e.id===entry.environmentId&&e.events.some(item=>item.id===entry.eventId))
        ||!z.string().uuid().safeParse(entry.invocationId).success||!Array.isArray(entry.receiptRefs)
        ||!['EXPOSED','ACCEPTED','APPLIED','UNKNOWN','REFUSED','RECONCILIATION_REQUIRED'].includes(entry.status))
        throw Error('DURABLE_ORIGINAL_EVENT_ENTRY_INVALID');
      for(const receipt of entry.receiptRefs){
        if(!/^[a-z][a-z0-9-]+\.json$/.test(receipt.path)||!hex.safeParse(receipt.sha256).success
          ||!Number.isSafeInteger(receipt.bytes)||receipt.bytes<1||receipt.bytes>limits.maxOutputBytes)
          throw Error('DURABLE_RECEIPT_REFERENCE_INVALID');
        const bytes=await readFile(join(root,receipt.path));
        if(bytes.length!==receipt.bytes||sha(bytes)!==receipt.sha256)throw Error('DURABLE_OWNER_RECEIPT_PREIMAGE_CHANGED');
      }
    }
    managed=managedState(cursor,cursorPath,root,input.deadlineAt,limits);
    const {call,authenticate,saveReceipt,saveState}=managed;await saveState();
    let submitted=0;
    for(const environment of journal.environments)for(const item of environment.events){
      if(submitted>=input.maxEvents||Date.now()>=input.deadlineAt)break;
      const existing=cursor.entries.find(e=>e.environmentId===environment.id&&e.eventId===item.id);
      if(existing){
        if(existing.originalIdempotencyKey!==item.originalIdempotencyKey||existing.originalEpisodeId!==item.originalEpisodeId
          ||existing.originalGrantDigest!==item.originalGrantDigest||existing.originalDeadline!==item.originalDeadline)
          throw Error('ORIGINAL_EXPOSED_EVENT_IDENTITY_CHANGED');
        if(existing.status==='APPLIED'||existing.status==='REFUSED')continue;
        assertReadOnly(item.reconciliation);await authenticate(item.owner);
        const witness=await call(item.owner,item.reconciliation);
        const applied=verifiedOwnerRead(witness,item.reconciliation);
        existing.receiptRefs.push(await saveReceipt('reconciliation-'+existing.invocationId+'-'+randomUUID()+'.json',
          {existing:structuredClone(existing),witness,applied,
            qualification:'ACTUAL_OWNER_READ_NO_AUTOMATIC_EFFECT_RETRY_OR_COMPLETION_CREDIT'}));
        existing.status=applied?'APPLIED':'RECONCILIATION_REQUIRED';await saveState();
        continue;
      }
      if(item.dependsOn.some(id=>!cursor.entries.some(e=>e.environmentId===environment.id&&e.eventId===id&&e.status==='APPLIED')))continue;
      const entry:Cursor['entries'][number]={environmentId:environment.id,eventId:item.id,invocationId:randomUUID(),
        status:'EXPOSED',exposedAt:new Date().toISOString(),originalIdempotencyKey:item.originalIdempotencyKey,
        originalEpisodeId:item.originalEpisodeId,originalGrantDigest:item.originalGrantDigest,originalDeadline:item.originalDeadline,receiptRefs:[]};
      cursor.entries.push(entry);await saveState();submitted++;
      if(Date.now()>Date.parse(item.originalDeadline)){
        entry.status='REFUSED';entry.predicate='ORIGINAL_EVENT_DEADLINE_EXPIRED_BEFORE_EXPOSURE';await saveState();continue;
      }
      try{
        assertReadOnly(item.clockObservation);assertReadOnly(item.reconciliation);
        const identity=await authenticate(item.owner),clockIdentity=await authenticate(item.clockOwner);
        const clockSet=await call(item.clockOwner,item.clockRequest),clockWitness=await call(item.clockOwner,item.clockObservation);
        if(clockSet.status<200||clockSet.status>=300||clockWitness.status!==200
          ||!verifiedOwnerRead(clockWitness,item.clockObservation)
          ||get(clockWitness.body,item.clockReplicaPath)!==item.replicaAt||typeof get(clockWitness.body,item.clockReceiptPath)!=='string')
          throw Error('ACTUAL_ADMITTED_REPLICA_CLOCK_RECEIPT_REQUIRED');
        const result=await call(item.owner,item.request);entry.responseDigest=result.responseDigest;entry.responseStatus=result.status;
        entry.status=result.status>=200&&result.status<300?'ACCEPTED':'REFUSED';
        const receipt={environmentId:environment.id,entry:structuredClone(entry),identity,clockIdentity,clockSet,clockWitness,result,
          replicaAt:item.replicaAt,localObservedAt:result.observedAt,completionEstablished:false,
          moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null,protectedQualificationEstablished:false};
        entry.receiptDigest=digest(receipt);entry.receiptRefs.push(await saveReceipt('event-'+entry.invocationId+'.json',receipt));
        await saveState();
        if(entry.status==='ACCEPTED'){
          const witness=await call(item.owner,item.reconciliation),applied=verifiedOwnerRead(witness,item.reconciliation);
          entry.receiptRefs.push(await saveReceipt('applied-'+entry.invocationId+'.json',
            {eventReceiptDigest:entry.receiptDigest,witness,applied,completionEstablished:false,protectedQualificationEstablished:false}));
          entry.status=applied?'APPLIED':'RECONCILIATION_REQUIRED';
        }
      }catch(error){entry.status='UNKNOWN';entry.predicate=String((error as Error).message);
        await saveState();
        entry.receiptRefs.push(await saveReceipt('uncertain-'+entry.invocationId+'.json',
          {entry:structuredClone(entry),possibleEffectRetained:true,newIdentityIssued:false,protectedQualificationEstablished:false}));}
      await saveState();
    }
    return {cursor,submitted,observedElapsedMs:managed.slice.observedElapsedMs,
      completeExpectedEventCoverage:cursor.entries.length===journal.environments.reduce((n,e)=>n+e.events.length,0)
        &&cursor.entries.every(e=>e.status==='APPLIED'),
      replicaTimeIsNotElapsedLiveTime:true,protectedQualificationEstablished:false};
  }catch(error){failure=error;throw error;}
  finally{try{await managed?.finish(failure);}catch(error){await release(true);throw error;}await release();}
}

export const IndependentReadProjection=z.object({schema:z.literal('finnor.x1.independent-owner-read-projection.v1'),
  environmentId:z.string().min(1),owner:endpoint,request:observation,
  rowsPath:path,identityPath:path,semanticFields:z.array(path).min(1).max(64),
  semanticValuePath:path.optional(),
  semanticObjectFields:z.array(z.object({name:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/),path,
    normalization:z.enum(['EXACT','ISO_INSTANT']).optional()}).strict())
    .min(1).max(64).refine(fields=>new Set(fields.map(f=>f.name)).size===fields.length,'INDEPENDENT_OBJECT_FIELD_DUPLICATE').optional(),
  trustedVisibilityTimestampPath:path.refine(p=>['x1_committed_at','committedAt','x1_observed_at','observedAt'].includes(String(p.at(-1))),
    'CANONICAL_COMMIT_OR_INDEPENDENT_READ_TIMESTAMP_REQUIRED').optional(),
  nativeSelector:z.object({kind:z.enum(['S1_MAPPING_CLAIMS','P1_OBLIGATION_CLAIMS','REQUEST_ROWS','WORKSTREAM_ROWS','FINDING_ROWS']),
    workId:z.string().uuid(),originalEpisodeId:z.string().uuid(),originalGrantDigest:hex,originalDeadline:instant,
    sourceIds:z.array(z.string().min(1)).min(1).max(16).optional()}).strict().optional(),
  kind:z.enum(['MAPPING_CLAIMS','OBLIGATION_CLAIMS','POSTCONDITION_WITNESSES','CHANGE_WITNESSES']),
  acceptance:z.array(z.object({path,equals:scalar}).strict()).max(64)}).strict();
/** Uses actual independently pinned owner response rows. It receives neither
 * candidate-derived completion truth nor expected semantic/postcondition digests. */
export async function collectIndependentOwnerRead(value:unknown,deadlineAt:number){
  const projection=IndependentReadProjection.parse(value);assertReadOnly(projection.request);
  const identity=await authenticateOwner(projection.owner,deadlineAt);
  const response=projection.nativeSelector
    ?await (await import('./qualification-native-observation.mjs')).readNativeObservationSnapshot(projection.owner,projection.nativeSelector,deadlineAt)
    :await callAuthenticatedOwner(projection.owner,projection.request,{deadlineAt,maxResponseBytes:6*1024*1024});
  if(projection.nativeSelector&&projection.nativeSelector.workId!==projection.request.expectedOwnerIdentity)
    throw Error('ORIGINAL_NATIVE_OBSERVER_WORK_IDENTITY_CHANGED');
  return projectIndependentOwnerRead(projection,identity,response);
}
function projectIndependentOwnerRead(projection:z.infer<typeof IndependentReadProjection>,
  identity:Awaited<ReturnType<typeof authenticateOwner>>,response:Awaited<ReturnType<typeof callAuthenticatedOwner>>){
  if(response.status!==200||get(response.body,projection.request.responseIdentityPath)!==projection.request.expectedOwnerIdentity)
    throw Error('ACTUAL_INDEPENDENT_OWNER_RESPONSE_IDENTITY_REQUIRED');
  const appliedStatePredicatesSatisfied=verifiedOwnerRead(response,projection.request);
  const rows=get(response.body,projection.rowsPath);if(!Array.isArray(rows)||rows.length>150000)throw Error('INDEPENDENT_OWNER_ROWS_BOUND');
  const observations=rows.map(row=>{
    const id=get(row,projection.identityPath),values=projection.semanticFields.map(p=>get(row,p));
    if(typeof id!=='string'||!id||values.some(v=>v===undefined))throw Error('ACTUAL_OWNER_OBSERVATION_FIELD_MISSING');
    const object=projection.semanticObjectFields?Object.fromEntries(projection.semanticObjectFields.map(f=>{
      const value=get(row,f.path);
      if(f.normalization==='ISO_INSTANT'&&value!==null){
        if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw Error('ACTUAL_NATIVE_INSTANT_FIELD_REQUIRED');
        return [f.name,new Date(value).toISOString()];
      }
      return [f.name,value];
    })):null;
    if(object&&Object.values(object).some(value=>value===undefined))throw Error('ACTUAL_OWNER_OBJECT_OBSERVATION_FIELD_MISSING');
    const visible=projection.trustedVisibilityTimestampPath?get(row,projection.trustedVisibilityTimestampPath):response.observedAt;
    if(typeof visible!=='string'||!Number.isFinite(Date.parse(visible))||Date.parse(visible)>Date.parse(response.observedAt))
      throw Error('ACTUAL_OWNER_TRUSTED_VISIBILITY_TIMESTAMP_REQUIRED');
    const preimage=projection.semanticValuePath?get(row,projection.semanticValuePath):object??values;
    if(preimage===undefined)throw Error('ACTUAL_NATIVE_SEMANTIC_PREIMAGE_ABSENT');
    return {identity:id,semanticDigest:digest(preimage),accepted:appliedStatePredicatesSatisfied
      &&(!projection.nativeSelector||(row as {nativePredicatesSatisfied?:unknown}).nativePredicatesSatisfied===true)
      &&projection.acceptance.every(p=>{
      const value=get(row,p.path);return value!==undefined&&digest(value)===digest(p.equals);}),
      witnessDigest:digest({ownerIdentity:identity.responseDigest,ownerResponse:response.responseDigest,identity:id,preimage,visible}),
      observedAt:visible,independentReadAt:response.observedAt};
  });
  return {schema:'finnor.x1.independent-owner-observation-draft.v1',environmentId:projection.environmentId,
    kind:projection.kind,projectionDigest:digest(projection),identity,response,observations,
    appliedStatePredicatesSatisfied,disposition:appliedStatePredicatesSatisfied?'OBSERVED_OWNER_FIELDS':'UNRESOLVED_OWNER_STATE_PREDICATES',
    duplicatesRetained:true,signature:null,protectedQualificationEstablished:false,admissionOrEffectAuthorityGranted:false};
}

/** Bounded live observation. An independently authorized service supervisor may
 * invoke another slice under the same registration/cursor. Local elapsed time
 * is retained; independent unattended attestation and seven-day coverage are
 * deliberately not issued by this collector. */
export async function executeLiveObservationSlice(input:{projections:unknown[];cursorPath:string;evidenceRoot:string;
  protocolDigest:string;candidateCutDigest:string;allocationConventionDigest:string;durationSeconds:number;
  limits:z.infer<typeof ExecutionLimits>;pollIntervalMs:number;recovery?:{expectedLockDigest:string}}){
  const projections=input.projections.map(p=>IndependentReadProjection.parse(p));
  const limits=ExecutionLimits.parse(input.limits),{root,cursorPath}=await privatePaths(input.evidenceRoot,input.cursorPath);
  if(!Number.isInteger(input.durationSeconds)||input.durationSeconds<1||input.durationSeconds>840
    ||!Number.isInteger(input.pollIntervalMs)||input.pollIntervalMs<250||input.pollIntervalMs>60000
    ||projections.length<10||projections.length>160||new Set(projections.map(p=>p.environmentId)).size!==10)
    throw Error('ORIGINAL_TEN_ENVIRONMENT_FINITE_LIVE_ENVELOPE_REQUIRED');
  for(const projection of projections)assertReadOnly(projection.request);
  const phasePin={protocolDigest:hex.parse(input.protocolDigest),candidateCutDigest:hex.parse(input.candidateCutDigest),
    allocationConventionDigest:hex.parse(input.allocationConventionDigest),projectionDigests:projections.map(p=>digest(p))};
  const release=await acquireCursorLock(cursorPath,digest({phasePin,limits}),input.recovery);
  const startedAt=new Date().toISOString(),began=performance.now(),deadlineAt=Date.now()+input.durationSeconds*1000;
  type Segment={id:string;status:'STARTED'|'FINISHED'|'FAILED'|'INTERRUPTED';startedAt:string;endedAt?:string;
    monotonicElapsedMs:number;localWallElapsedMs:number;continuityGapMs:number|null;continuousWithPrevious:boolean|null;
    polls:number;receiptRefs:ReceiptRef[];observations:Array<{invocationId:string;environmentId:string;at:string;
      status:'EXPOSED'|'OBSERVED'|'UNRESOLVED'|'UNKNOWN';receiptRef?:ReceiptRef;predicate?:string}>;
    independentlyObservedUnattended:false;serviceFingerprint:string;fingerprintBasis:string;moneyUsd:null;humanSeconds:null;
    aggregatePeakMemoryBytes:null;sevenElapsedDaysEstablished:false;replicaTimeSubstituted:false;
    protectedQualificationEstablished:false;receiptDigest?:string};
  type State={schema:'finnor.x1.live-observation-cursor.v2';phasePin:typeof phasePin;
    resources:Resources;segments:Segment[];revision:number};
  let managed:ReturnType<typeof managedState<State>>|undefined,failure:unknown,segment:Segment|undefined;
  try{
    let state:State;
    try{state=JSON.parse(await readFile(cursorPath,'utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      state={schema:'finnor.x1.live-observation-cursor.v2',phasePin,resources:newResources(limits),segments:[],revision:0};}
    if(state.schema!=='finnor.x1.live-observation-cursor.v2'||digest(state.phasePin)!==digest(phasePin)
      ||!Number.isSafeInteger(state.revision)||state.revision<0||!Array.isArray(state.segments))
      throw Error('ORIGINAL_LIVE_OBSERVER_CURSOR_CHANGED');
    validateResources(state.resources,limits);
    for(const previous of state.segments){
      if(!Array.isArray(previous.receiptRefs)||!Array.isArray(previous.observations)
        ||!['STARTED','FINISHED','FAILED','INTERRUPTED'].includes(previous.status))throw Error('ORIGINAL_LIVE_SEGMENT_INVALID');
      if(previous.status==='STARTED')previous.status='INTERRUPTED';
      for(const receipt of previous.receiptRefs){
        if(!/^[a-z][a-z0-9-]+\.json$/.test(receipt.path)||receipt.bytes<1||receipt.bytes>limits.maxOutputBytes)
          throw Error('LIVE_RECEIPT_REFERENCE_INVALID');
        const bytes=await readFile(join(root,receipt.path));
        if(bytes.length!==receipt.bytes||sha(bytes)!==receipt.sha256)throw Error('LIVE_OWNER_RECEIPT_PREIMAGE_CHANGED');
      }
    }
    managed=managedState(state,cursorPath,root,deadlineAt,limits);
    const {saveState,saveReceipt,authenticate,call,measureAcquisition}=managed;
    const previous=state.segments.at(-1),gapMs=previous?.endedAt?Date.parse(startedAt)-Date.parse(previous.endedAt):null;
    segment={id:managed.slice.id,status:'STARTED',startedAt,monotonicElapsedMs:0,localWallElapsedMs:0,
      continuityGapMs:gapMs,continuousWithPrevious:previous?previous.status==='FINISHED'&&gapMs!==null&&gapMs>=0&&gapMs<=1000:null,
      polls:0,receiptRefs:[],observations:[],independentlyObservedUnattended:false,serviceFingerprint:digest(phasePin),
      fingerprintBasis:'PINNED_ENDPOINT_AND_CUT_REQUIRES_INDEPENDENT_INSTALLED_SERVICE_ATTESTATION',
      moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null,sevenElapsedDaysEstablished:false,
      replicaTimeSubstituted:false,protectedQualificationEstablished:false};
    state.segments.push(segment);await saveState();
    while(Date.now()<deadlineAt){
      for(const projection of projections){
        if(Date.now()>=deadlineAt)break;
        const invocationId=randomUUID();
        const observationEntry:Segment['observations'][number]={invocationId,environmentId:projection.environmentId,
          at:new Date().toISOString(),status:'EXPOSED'};
        segment.observations.push(observationEntry);await saveState();
        try{
          const identity=await authenticate(projection.owner),response=projection.nativeSelector
            ?await (await import('./qualification-native-observation.mjs')).readNativeObservationSnapshot(
              projection.owner,projection.nativeSelector,deadlineAt,measureAcquisition)
            :await call(projection.owner,projection.request);
          const result=projectIndependentOwnerRead(projection,identity,response);
          observationEntry.receiptRef=await saveReceipt('live-owner-'+invocationId+'.json',result);
          segment.receiptRefs.push(observationEntry.receiptRef);
          observationEntry.status=result.appliedStatePredicatesSatisfied?'OBSERVED':'UNRESOLVED';
        }catch(error){observationEntry.status='UNKNOWN';observationEntry.predicate=String((error as Error).message);
          await saveState();
          if(observationEntry.predicate==='ORIGINAL_EXECUTION_DEADLINE_EXHAUSTED'&&Date.now()>=deadlineAt)break;
          if(['ORIGINAL_AGGREGATE_OUTPUT_BOUND','ORIGINAL_AGGREGATE_ACQUISITION_BOUND',
            'ORIGINAL_EXECUTION_DEADLINE_EXHAUSTED'].includes(observationEntry.predicate))throw error;}
        segment.monotonicElapsedMs=performance.now()-began;segment.localWallElapsedMs=Date.now()-Date.parse(startedAt);
        await saveState();
      }
      segment.polls++;await saveState();const remaining=deadlineAt-Date.now();
      if(remaining>0)await new Promise(resolve=>setTimeout(resolve,Math.min(input.pollIntervalMs,remaining)));
    }
    segment.status='FINISHED';segment.endedAt=new Date().toISOString();segment.monotonicElapsedMs=performance.now()-began;
    segment.localWallElapsedMs=Date.parse(segment.endedAt)-Date.parse(startedAt);
    const summaryPreimage=structuredClone(segment);segment.receiptDigest=digest(summaryPreimage);
    const summary=await saveReceipt('live-segment-'+segment.id+'.json',summaryPreimage);
    segment.receiptRefs.push(summary);await saveState();
    return {segment,state,protectedQualificationEstablished:false};
  }catch(error){failure=error;if(segment){segment.status='FAILED';segment.endedAt=new Date().toISOString();
      segment.monotonicElapsedMs=performance.now()-began;segment.localWallElapsedMs=Date.parse(segment.endedAt)-Date.parse(startedAt);}throw error;}
  finally{try{await managed?.finish(failure);}catch(error){await release(true);throw error;}await release();}
}

/** The caller supplies the actual production JobQueue and independently reads
 * its native delivery ledger. Possible ticks and actual attempts stay distinct. */
export async function executeNativeQueueSlice(input:{registration:unknown;cursorPath:string;evidenceRoot:string;
  durationSeconds:number;signal:AbortSignal;runtime:z.infer<typeof NativeWorkerRegistration>['runtime'];
  databaseIdentityDigest:string;originalEpisodes:z.infer<typeof NativeWorkerRegistration>['originalEpisodes'];
  queue:Pick<import('../../../apps/worker/src/queue').JobQueue,'instanceId'|'tick'|'recoverExpiredRunningJobs'>;
  assertRuntime:()=>void|Promise<void>;
  readDeliveryAttempts:()=>Promise<Array<Record<string,unknown>>>;recovery?:{expectedLockDigest:string}}){
  const registration=NativeWorkerRegistration.parse(input.registration);
  if(digest(registration.runtime)!==digest(input.runtime)||registration.databaseIdentityDigest!==input.databaseIdentityDigest
    ||digest(registration.originalEpisodes)!==digest(input.originalEpisodes))throw Error('ACTUAL_NATIVE_RUNTIME_DATABASE_OR_ORIGINAL_EPISODES_CHANGED');
  if(!Number.isInteger(input.durationSeconds)||input.durationSeconds<1||input.durationSeconds>600)
    throw Error('ORIGINAL_SIX_HUNDRED_SECOND_WORKER_SLICE_BOUND');
  const {root,cursorPath}=await privatePaths(input.evidenceRoot,input.cursorPath),pinDigest=digest(registration);
  const limits=ExecutionLimits.parse({ref:registration.envelope.ref,registrationDigest:registration.envelope.registrationDigest,
    maxAcquisitionCalls:registration.envelope.maxNativeDeliveries,maxOutputBytes:registration.envelope.maxOutputBytes,
    maxAggregateWallMs:registration.envelope.maxAggregateWallMs});
  const release=await acquireCursorLock(cursorPath,digest({pinDigest,limits}),input.recovery);
  type Tick={id:string;ordinal:number;exposedAt:string;status:'EXPOSED'|'RETURNED'|'UNKNOWN';didWork?:boolean};
  type Segment={id:string;workerId:string;pid:number;status:'STARTED'|'FINISHED'|'FAILED'|'INTERRUPTED';
    ticks:Tick[];receiptRefs:ReceiptRef[];actualDeliveryAttempts:Array<Record<string,unknown>>;predicate?:string};
  type State={schema:'finnor.x1.native-worker-cursor.v1';pinDigest:string;registration:z.infer<typeof NativeWorkerRegistration>;
    resources:Resources;revision:number;segments:Segment[];counterMeaning:'CONSERVATIVE_NATIVE_TICK_EXPOSURES_NOT_HTTP_CALLS_OR_BUSINESS_WORK'};
  let managed:ReturnType<typeof managedState<State>>|undefined,segment:Segment|undefined,failure:unknown;
  try{
    let state:State;
    try{state=JSON.parse(await readFile(cursorPath,'utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      state={schema:'finnor.x1.native-worker-cursor.v1',pinDigest,registration,resources:newResources(limits),revision:0,segments:[],
        counterMeaning:'CONSERVATIVE_NATIVE_TICK_EXPOSURES_NOT_HTTP_CALLS_OR_BUSINESS_WORK'};}
    if(state.schema!=='finnor.x1.native-worker-cursor.v1'||state.pinDigest!==pinDigest||digest(state.registration)!==pinDigest
      ||!Number.isSafeInteger(state.revision)||state.revision<0||!Array.isArray(state.segments)
      ||state.counterMeaning!=='CONSERVATIVE_NATIVE_TICK_EXPOSURES_NOT_HTTP_CALLS_OR_BUSINESS_WORK')
      throw Error('ORIGINAL_NATIVE_WORKER_CURSOR_CHANGED');
    for(const previous of state.segments){
      if(!Array.isArray(previous.ticks)||!Array.isArray(previous.receiptRefs)||!Array.isArray(previous.actualDeliveryAttempts))
        throw Error('NATIVE_WORKER_SEGMENT_INVALID');
      if(previous.status==='STARTED')previous.status='INTERRUPTED';
      for(const ref of previous.receiptRefs){
        if(!/^[a-z][a-z0-9-]+\.json$/.test(ref.path)||ref.bytes<1||ref.bytes>limits.maxOutputBytes)throw Error('NATIVE_RECEIPT_REFERENCE_INVALID');
        const bytes=await readFile(join(root,ref.path));if(bytes.length!==ref.bytes||sha(bytes)!==ref.sha256)
          throw Error('NATIVE_DELIVERY_RECEIPT_PREIMAGE_CHANGED');
      }
    }
    const deadlineAt=Date.now()+input.durationSeconds*1000;
    managed=managedState(state,cursorPath,root,deadlineAt,limits);
    segment={id:managed.slice.id,workerId:input.queue.instanceId,pid:process.pid,status:'STARTED',ticks:[],receiptRefs:[],actualDeliveryAttempts:[]};
    state.segments.push(segment);await managed.saveState();let lastRecovery=0;
    while(Date.now()<deadlineAt&&!input.signal.aborted&&state.resources.acquisitionExposures<limits.maxAcquisitionCalls){
      await input.assertRuntime();
      if(Date.now()-lastRecovery>=2000){await input.queue.recoverExpiredRunningJobs();lastRecovery=Date.now();}
      const tick:Tick={id:randomUUID(),ordinal:state.resources.acquisitionExposures+1,exposedAt:new Date().toISOString(),status:'EXPOSED'};
      segment.ticks.push(tick);state.resources.acquisitionExposures++;await managed.saveState();
      try{
        tick.didWork=await input.queue.tick(input.signal);tick.status='RETURNED';state.resources.acknowledgedAcquisitions++;
        const attempts=await input.readDeliveryAttempts();
        if(attempts.length>limits.maxAcquisitionCalls||attempts.some(a=>a.worker_id!==input.queue.instanceId))
          throw Error('ACTUAL_NATIVE_DELIVERY_OWNER_OR_BOUND_CHANGED');
        segment.actualDeliveryAttempts=attempts;await managed.saveState();
      }catch(error){tick.status='UNKNOWN';await managed.saveState();throw error;}
      if(!tick.didWork&&Date.now()<deadlineAt&&!input.signal.aborted)
        await new Promise(resolve=>setTimeout(resolve,Math.min(200,deadlineAt-Date.now())));
    }
    segment.status='FINISHED';segment.receiptRefs.push(await managed.saveReceipt('native-segment-'+segment.id+'.json',{
      segment:structuredClone(segment),registrationDigest:pinDigest,originalEpisodes:registration.originalEpisodes,
      possibleNativeDeliveryExposures:state.resources.acquisitionExposures,actualNativeDeliveryAttempts:segment.actualDeliveryAttempts.length,
      conservativeIdleTicksReceiveNoBusinessCredit:true,protectedQualificationEstablished:false,sevenElapsedDaysEstablished:false,
      moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null}));
    await managed.saveState();return {state,segment,deliveryAllowanceExhausted:state.resources.acquisitionExposures>=limits.maxAcquisitionCalls,
      independentlyObservedUnattended:false,protectedQualificationEstablished:false,sevenElapsedDaysEstablished:false};
  }catch(error){failure=error;if(segment){segment.status='FAILED';segment.predicate=String((error as Error).message);}throw error;}
  finally{try{await managed?.finish(failure);}catch(error){await release(true);throw error;}await release();}
}

/** Finite real-owner exercise, not a protected institutional population. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {digest} from '../../../packages/capability-evolution/src/contracts';
import {QualificationExecutionJournal,executeReplaySlice,executeLiveObservationSlice,
  validateExecutionJournal,collectIndependentOwnerRead,type OwnerEndpoint} from './qualification-runtime.mts';
import {readQualificationCursor} from './qualification-state-journal.mts';
import {NativeWorkerControl} from './qualification-native-worker.mts';
import {bindOriginalNativeWorker} from './qualification-native-administration.mts';
import {collectQualificationObservation} from './qualification-observation-collection.mts';

const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
export async function startQualificationOwnerExercise(input:{evidenceRoot:string;owner:OwnerEndpoint;token:string;
  workId:string;compilerId:string;submitBody:Record<string,unknown>;episodeId:string;grantDigest:string;
  originalDeadline:string;candidateCutDigest:string;allocationConventionDigest:string}){
  const root=join(input.evidenceRoot,'qualification-execution');await mkdir(root,{mode:0o700});
  const clocks=join(root,'replica-clock');await mkdir(clocks,{mode:0o700});
  const variable=input.owner.tokenEnvironmentVariable;
  if(process.env[variable])throw Error('EXISTING_EXERCISE_BINDING_COLLISION');process.env[variable]=input.token;
  const clockRows=new Map<string,{replicaAt:string;receiptDigest:string;tenantId:string}>();
  const clockCalls:Array<Record<string,unknown>>=[];
  // This disposable service persists clock state only. Authentication is checked
  // by the actual owner API; it has no business writer or completion oracle.
  const clock=createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');
    try{
      const identity=await fetch(input.owner.origin+'/api/me',{headers:{authorization:String(req.headers.authorization??'')},
        signal:AbortSignal.timeout(10000)});const me=await identity.json();
      if(identity.status!==200||me.tenantId!==input.owner.tenantId||me.employeeId!==input.owner.principalId){
        res.writeHead(401);res.end(JSON.stringify({error:'ACTUAL_CLOCK_OWNER_IDENTITY_REFUSED'}));return;}
      if(req.url==='/api/me'&&req.method==='GET'){res.end(JSON.stringify(me));return;}
      const match=/^\/api\/clock\/([a-f0-9-]{36})$/.exec(req.url??'');
      if(!match){res.writeHead(404);res.end('{}');return;}
      const id=match[1]!;
      if(req.method==='POST'){
        let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>16384)throw Error('CLOCK_BODY_BOUND');}
        const value=JSON.parse(raw),previous=clockRows.get(id);
        if(!Number.isFinite(Date.parse(value.replicaAt))||typeof value.idempotencyKey!=='string'
          ||previous&&Date.parse(value.replicaAt)<Date.parse(previous.replicaAt))throw Error('ORIGINAL_MONOTONE_REPLICA_CLOCK_REQUIRED');
        const receipt={clockId:id,replicaAt:value.replicaAt,originalKey:value.idempotencyKey,at:new Date().toISOString(),
          ownerIdentityDigest:digest(me),businessCompletionIssued:false,elapsedLiveTimeIssued:false};
        const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n'),receiptDigest=sha(bytes);
        await writeFile(join(clocks,'clock-'+id+'-'+receiptDigest+'.json'),bytes,{flag:'wx',mode:0o600});
        clockRows.set(id,{replicaAt:value.replicaAt,receiptDigest,tenantId:input.owner.tenantId});
        clockCalls.push({id,method:'POST',replicaAt:value.replicaAt,receiptDigest});
      }else if(req.method!=='GET'){res.writeHead(405);res.end('{}');return;}
      const row=clockRows.get(id);if(!row){res.writeHead(404);res.end('{}');return;}
      res.end(JSON.stringify(row));
    }catch(error){res.writeHead(422);res.end(JSON.stringify({error:String((error as Error).message)}));}
  });
  let submitProxy:ReturnType<typeof createServer>|undefined;
  try{
    await new Promise<void>((resolve,reject)=>{clock.once('error',reject);clock.listen(0,'127.0.0.1',resolve);});
    const address=clock.address();assert.ok(address&&typeof address!=='string');
    const clockOwner={...input.owner,origin:'http://127.0.0.1:'+address.port};
    const replicaStart=new Date().toISOString(),replicaEnd=new Date(Date.parse(replicaStart)+30*86400000).toISOString();
    const ownerRead={path:'/api/company-brain/institution-read',method:'POST' as const,body:{requestId:input.compilerId},
      readOnly:true as const,admittedOwnerReadReceiptDigest:digest({owner:input.owner,path:'institution-read'}),
      responseIdentityPath:['workId'],expectedOwnerIdentity:input.workId,
      appliedStatePredicates:[{path:['status'],equals:'OBSERVED'}]};
    const journal=QualificationExecutionJournal.parse({schema:'finnor.x1.qualification-execution-journal.v1',
      protocolDigest:digest({kind:'LOCAL_OWNER_EXECUTION_EXERCISE',workId:input.workId}),candidateCutDigest:input.candidateCutDigest,
      allocationConventionDigest:input.allocationConventionDigest,environments:Array.from({length:10},()=>{
        const id=randomUUID(),common={workId:input.workId,occurredAt:replicaStart,availableAt:replicaStart,
          originalIdempotencyKey:String(input.submitBody.idempotencyKey),owner:input.owner,clockOwner,
          originalEpisodeId:input.episodeId,originalGrantDigest:input.grantDigest,originalDeadline:input.originalDeadline};
        const makeClock=(replicaAt:string,key:string)=>({clockRequest:{path:'/api/clock/'+id,method:'POST',body:{replicaAt,idempotencyKey:key}},
          clockObservation:{path:'/api/clock/'+id,method:'GET',readOnly:true,
            admittedOwnerReadReceiptDigest:digest({clockId:id,read:'PERSISTED_CLOCK_ONLY'}),responseIdentityPath:['tenantId'],
            expectedOwnerIdentity:input.owner.tenantId,appliedStatePredicates:[{path:['replicaAt'],equals:replicaAt}]},
          clockReplicaPath:['replicaAt'],clockReceiptPath:['receiptDigest']});
        const later=new Date(Date.parse(replicaStart)+86400000).toISOString();
        return {id,replicaStart,replicaEnd,events:[{...common,...makeClock(replicaStart,id+'-first'),id:'original-submit',
          replicaAt:replicaStart,dependsOn:[],request:{path:'/api/company-brain/institution-submit',method:'POST',body:input.submitBody},
          reconciliation:ownerRead},{...common,...makeClock(later,id+'-dependent'),id:'dependent-owner-read',replicaAt:later,
          dependsOn:['original-submit'],request:{path:'/api/me',method:'GET'},
          reconciliation:{path:'/api/me',method:'GET',readOnly:true,admittedOwnerReadReceiptDigest:digest({owner:input.owner,path:'me'}),
            responseIdentityPath:['tenantId'],expectedOwnerIdentity:input.owner.tenantId,
            appliedStatePredicates:[{path:['employeeId'],equals:input.owner.principalId}]}}]};})});
    // Retain a real owner 202 before the replay controller receives its body.
    // This proxy forwards the original request; it has no business writer.
    let proxyAccepted:(receipt:Record<string,unknown>)=>void=()=>{};
    const acceptance=new Promise<Record<string,unknown>>(resolve=>{proxyAccepted=resolve;});
    let heldResponse:import('node:http').ServerResponse|undefined;
    submitProxy=createServer(async(req,res)=>{
      try{
        const chunks:Buffer[]=[];let bytes=0;
        for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)throw Error('PROXY_REQUEST_BOUND');chunks.push(chunk);}
        const upstream=await fetch(input.owner.origin+(req.url??'/'),{method:req.method,
          headers:{authorization:String(req.headers.authorization??''),'content-type':'application/json'},
          ...(req.method==='POST'?{body:Buffer.concat(chunks)}:{}),signal:AbortSignal.timeout(10000),redirect:'error'});
        const body=Buffer.from(await upstream.arrayBuffer());res.statusCode=upstream.status;res.setHeader('content-type','application/json');
        if(req.url==='/api/company-brain/institution-submit'){
          heldResponse=res;proxyAccepted({status:upstream.status,responseSha256:sha(body),body:JSON.parse(body.toString('utf8')),
            originalKey:input.submitBody.idempotencyKey,ownerOrigin:input.owner.origin,clientAcknowledgementDelivered:false});
        }else res.end(body);
      }catch(error){res.statusCode=502;res.end(JSON.stringify({error:String((error as Error).message)}));}
    });
    await new Promise<void>((resolve,reject)=>{submitProxy!.once('error',reject);submitProxy!.listen(0,'127.0.0.1',resolve);});
    const proxyAddress=submitProxy.address();assert.ok(proxyAddress&&typeof proxyAddress!=='string');
    journal.environments[0]!.events[0]!.owner={...input.owner,origin:'http://127.0.0.1:'+proxyAddress.port};
    validateExecutionJournal(journal,{protocolDigest:journal.protocolDigest,candidateCutDigest:journal.candidateCutDigest,
      allocationConventionDigest:journal.allocationConventionDigest,environments:journal.environments.map(e=>
        ({id:e.id,replayJournalCommitment:digest(e)}))});
    const limits={ref:'original-development-validation-exercise',registrationDigest:digest(journal),
      maxAcquisitionCalls:160,maxOutputBytes:64*1024*1024,maxAggregateWallMs:180000};
    const cursorPath=join(root,'replay-cursor.json');
    await writeFile(join(root,'journal.json'),JSON.stringify(journal,null,2)+'\n',{flag:'wx',mode:0o600});
    const childControlPath=join(root,'interrupt-control.json');
    await writeFile(childControlPath,JSON.stringify({journal,evidenceRoot:root,cursorPath,deadlineAt:Date.now()+60000,limits,maxEvents:1}),{flag:'wx',mode:0o600});
    const childCode=`import {readFile} from 'node:fs/promises';import {executeReplaySlice} from ${JSON.stringify(new URL('./qualification-runtime.mts',import.meta.url).href)};
      await executeReplaySlice(JSON.parse(await readFile(process.env.FINNOR_X1_EXERCISE_CHILD_CONTROL,'utf8')));`;
    const child=spawn(process.execPath,['--max-old-space-size=512','--import=tsx','--input-type=module','-e',childCode],{
      cwd:process.cwd(),env:{PATH:process.env.PATH,NODE_ENV:'test',TSX_DISABLE_CACHE:'1',
        FINNOR_X1_EXERCISE_CHILD_CONTROL:childControlPath,[variable]:input.token},stdio:['ignore','pipe','pipe']});
    const terminal=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
    let childLogs='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{childLogs+=chunk.toString();
      if(Buffer.byteLength(childLogs)>1024*1024)child.kill('SIGTERM');});
    const watchdog=setTimeout(()=>child.kill('SIGTERM'),20000);
    let accepted:Record<string,unknown>;
    try{accepted=await Promise.race([acceptance,terminal.then(result=>{throw Error('REPLAY_CHILD_EXITED_BEFORE_REAL_ACCEPTANCE:'+JSON.stringify(result)+':'+childLogs);})]);
      assert.equal(accepted.status,202);child.kill('SIGKILL');const exit=await terminal;assert.equal(exit.signal,'SIGKILL');
      heldResponse?.destroy();
      const interrupted=await readQualificationCursor(cursorPath);assert.equal(interrupted.entries.length,1);
      assert.equal(interrupted.entries[0].status,'EXPOSED');assert.equal(interrupted.entries[0].originalIdempotencyKey,input.submitBody.idempotencyKey);
      await writeFile(join(root,'physical-controller-interruption.json'),JSON.stringify({childPid:child.pid,exit,accepted,
        childCodeDigest:sha(childCode),childLogs,interrupted,noMutationAcknowledgementReceived:true},null,2)+'\n',{flag:'wx',mode:0o600});
    }finally{clearTimeout(watchdog);}
    const lockBytes=await readFile(cursorPath+'.lock');
    const first=await executeReplaySlice({journal,evidenceRoot:root,cursorPath,deadlineAt:Date.now()+60000,limits,maxEvents:128,
      recovery:{expectedLockDigest:sha(lockBytes)}});
    assert.equal(first.cursor.entries.length,10);assert.equal(first.submitted,9);
    assert.ok(first.cursor.entries.every(e=>e.status==='RECONCILIATION_REQUIRED'));
    assert.equal(first.completeExpectedEventCoverage,false);assert.equal(clockCalls.length,10,
      '202 must not expose any dependent event before actual applied native state');
    await writeFile(join(root,'before-worker.json'),JSON.stringify({first,clockCalls,
      predicate:'ACTUAL_QUEUED_ACCEPTANCE_DOES_NOT_UNLOCK_DEPENDENT_EVENT',protectedPopulationClaimed:false},null,2)+'\n',{mode:0o600});
    return {root,journal,limits,cursorPath,first,clockCalls,ownerRead,clockOwner,
      close:async()=>{await new Promise<void>(resolve=>clock.close(()=>resolve()));
        await new Promise<void>(resolve=>submitProxy!.close(()=>resolve()));delete process.env[variable];}};
  }catch(error){await new Promise<void>(resolve=>clock.close(()=>resolve()));
    if(submitProxy)await new Promise<void>(resolve=>submitProxy!.close(()=>resolve()));delete process.env[variable];throw error;}
}

export async function createNativeWorkerExerciseControl(exercise:Awaited<ReturnType<typeof startQualificationOwnerExercise>>,
  input:{databaseIdentityDigest:string;runtime:{mode:'SOURCE_DEVELOPMENT'|'COMPILED_DEVELOPMENT';digest:string}}){
  const event=exercise.journal.environments[0]!.events[0]!,cursorPath=join(exercise.root,'native-worker-cursor.json');
  const registration=await bindOriginalNativeWorker({protocolDigest:exercise.journal.protocolDigest,
    candidateCutDigest:exercise.journal.candidateCutDigest,allocationConventionDigest:exercise.journal.allocationConventionDigest,
    runtime:input.runtime,phase:'soak',owners:[{owner:event.owner,workId:event.workId}],deadlineAt:Date.now()+30000,
    envelope:{ref:'original-development-native-worker-validation',registrationDigest:digest(exercise.journal),
      maxNativeDeliveries:160,maxAggregateWallMs:180000,maxOutputBytes:64*1024*1024}});
  assert.equal(registration.databaseIdentityDigest,input.databaseIdentityDigest);
  assert.deepEqual(registration.originalEpisodes,[{tenantId:event.owner.tenantId,principalId:event.owner.principalId,workId:event.workId,
    originalEpisodeId:event.originalEpisodeId,originalGrantDigest:event.originalGrantDigest,originalDeadline:event.originalDeadline}]);
  const control=NativeWorkerControl.parse({schema:'finnor.x1.qualification-native-worker-control.v1',registration,
    evidenceRoot:exercise.root,cursorPath,durationSeconds:20});
  const path=join(exercise.root,'native-worker-control-001.json'),bytes=Buffer.from(JSON.stringify(control,null,2)+'\n');
  await writeFile(path,bytes,{flag:'wx',mode:0o600});return {control,path,sha256:sha(bytes)};
}

export async function finishQualificationOwnerExercise(exercise:Awaited<ReturnType<typeof startQualificationOwnerExercise>>){
  const {root,journal,limits,cursorPath}=exercise;
  const resumed=await executeReplaySlice({journal,evidenceRoot:root,cursorPath,deadlineAt:Date.now()+60000,limits,maxEvents:128});
  assert.equal(resumed.completeExpectedEventCoverage,true);assert.equal(resumed.cursor.entries.length,20);
  assert.ok(resumed.cursor.entries.every(e=>e.status==='APPLIED'));assert.equal(exercise.clockCalls.length,20);
  assert.equal(resumed.cursor.resources.slices.length,3);
  assert.equal(resumed.cursor.resources.slices[0]!.status,'INTERRUPTED');
  assert.equal(resumed.cursor.resources.slices[0]!.unobservedTail,true);
  const beforeBytes=await readFile(cursorPath);
  await assert.rejects(executeReplaySlice({journal,evidenceRoot:root,cursorPath,deadlineAt:Date.now()+60000,
    limits:{...limits,maxAcquisitionCalls:161},maxEvents:128}),/ORIGINAL_AGGREGATE_EXECUTION_LIMITS_OR_COUNTERS_CHANGED/);
  assert.deepEqual(await readFile(cursorPath),beforeBytes,'refused enlargement must not rewrite the original cursor');
  for(const entry of resumed.cursor.entries){
    assert.ok(entry.receiptRefs.length>0);
    const event=entry.receiptRefs.find(p=>p.path==='event-'+entry.invocationId+'.json');
    if(event){const raw=await readFile(join(root,event.path)),receipt=JSON.parse(raw.toString('utf8'));
      assert.equal(sha(raw),event.sha256);assert.equal(digest(receipt),entry.receiptDigest,'immutable receipt digest survives cursor advancement');}
  }
  const originalEvent=journal.environments[0]!.events[0]!;
  const nativeBase={schema:'finnor.x1.independent-owner-read-projection.v1',environmentId:journal.environments[0]!.id,
    owner:originalEvent.owner,request:{path:'/api/company-brain/institution-sources',method:'POST',body:{workId:originalEvent.workId},
      readOnly:true,admittedOwnerReadReceiptDigest:digest({owner:originalEvent.owner,path:'native-canonical-snapshot'}),
      responseIdentityPath:['workId'],expectedOwnerIdentity:originalEvent.workId,
      appliedStatePredicates:[{path:['snapshotStatus'],equals:'ACTUAL_NATIVE_OWNER_ROWS_READ'}]},rowsPath:['rows'],
    nativeSelector:{workId:originalEvent.workId,originalEpisodeId:originalEvent.originalEpisodeId,
      originalGrantDigest:originalEvent.originalGrantDigest,originalDeadline:originalEvent.originalDeadline}};
  const nativeProbes=[];
  for(const spec of [
    {selector:'S1_MAPPING_CLAIMS',kind:'MAPPING_CLAIMS',identityPath:['objectId'],semanticFields:[['canonicalCandidate']],
      sourceIds:['crm-original','ledger-original','work-original'],acceptance:[]},
    {selector:'P1_OBLIGATION_CLAIMS',kind:'OBLIGATION_CLAIMS',identityPath:['stableIdentity'],semanticFields:[['operation'],['deadlineAt']],acceptance:[]},
    {selector:'REQUEST_ROWS',kind:'POSTCONDITION_WITNESSES',identityPath:['identity'],semanticFields:[['fields','request_text']],
      semanticObjectFields:[{name:'state',path:['fields','state']},{name:'request_text',path:['fields','request_text']}],
      trustedVisibilityTimestampPath:['x1_observed_at'],acceptance:[{path:['actionStatus'],equals:'completed'},
        {path:['effectStatus'],equals:'verified'},{path:['fields','state'],equals:'open'}]},
  ]){
    const {selector,sourceIds,...projection}=spec;
    const draft=await collectIndependentOwnerRead({...nativeBase,...projection,
      nativeSelector:{...nativeBase.nativeSelector,kind:selector,...(sourceIds?{sourceIds}:{})}},Date.now()+30000);
    assert.ok(draft.observations.length>0,'actual native selector '+selector);assert.ok(draft.observations.every(o=>o.accepted));
    await writeFile(join(root,'native-canonical-'+selector.toLowerCase().replaceAll('_','-')+'.json'),JSON.stringify(draft,null,2)+'\n',{mode:0o600});
    nativeProbes.push(draft);
  }
  const projections=journal.environments.map(e=>({schema:'finnor.x1.independent-owner-read-projection.v1',environmentId:e.id,
    owner:e.events[0]!.owner,request:{path:'/api/works',method:'GET',readOnly:true,
      admittedOwnerReadReceiptDigest:digest({owner:e.events[0]!.owner,path:'works'}),responseIdentityPath:['works',0,'tenantId'],
      expectedOwnerIdentity:e.events[0]!.owner.tenantId,appliedStatePredicates:[{path:['works',0,'status'],equals:'completed'}]},
    rowsPath:['works'],identityPath:['id'],semanticFields:[['id'],['status'],['tenantId']],kind:'POSTCONDITION_WITNESSES',
    acceptance:[{path:['id'],equals:e.events[0]!.workId},{path:['status'],equals:'completed'}]}));
  const live=await executeLiveObservationSlice({projections,evidenceRoot:root,cursorPath:join(root,'live-cursor.json'),
    protocolDigest:journal.protocolDigest,candidateCutDigest:journal.candidateCutDigest,
    allocationConventionDigest:journal.allocationConventionDigest,durationSeconds:3,pollIntervalMs:1000,
    limits:{...limits,ref:'original-development-live-observer-exercise',registrationDigest:digest(projections)}});
  assert.equal(live.segment.status,'FINISHED');assert.ok(live.segment.observations.filter(o=>o.status==='OBSERVED').length>=10);
  assert.equal(live.segment.sevenElapsedDaysEstablished,false);assert.equal(live.segment.independentlyObservedUnattended,false);
  const drafts=[];
  for(const ref of live.segment.receiptRefs.filter(p=>p.path.startsWith('live-owner-'))){
    const draft=JSON.parse(await readFile(join(root,ref.path),'utf8'));assert.equal(draft.signature,null);
    assert.equal(draft.protectedQualificationEstablished,false);assert.ok(draft.observations.some((o:any)=>o.accepted));drafts.push(ref);
  }
  const collectionDrafts=[];
  for(const projection of projections)collectionDrafts.push(await collectIndependentOwnerRead(projection,Date.now()+30000));
  const collection=await collectQualificationObservation({drafts:collectionDrafts,environmentIds:journal.environments.map(e=>e.id),
    expectedSelectorCount:projections.length,save:async(name,body)=>{await writeFile(join(root,name),JSON.stringify(body,null,2)+'\n',{mode:0o600,flag:'wx'});}});
  assert.equal(collection.allSelectorsObserved,true);assert.ok(collection.environments.every(e=>e.observed.completions.length===1));
  const nativeLive=await executeLiveObservationSlice({projections:journal.environments.map(environment=>({...nativeBase,
    environmentId:environment.id,nativeSelector:{...nativeBase.nativeSelector,kind:'REQUEST_ROWS'},
    identityPath:['identity'],semanticFields:[['fields','request_text']],kind:'POSTCONDITION_WITNESSES',
    semanticObjectFields:[{name:'state',path:['fields','state']},{name:'due_at',path:['fields','due_at'],normalization:'ISO_INSTANT'}],
    trustedVisibilityTimestampPath:['x1_observed_at'],acceptance:[{path:['actionStatus'],equals:'completed'},
      {path:['effectStatus'],equals:'verified'},{path:['fields','state'],equals:'open'}]})),
    evidenceRoot:root,cursorPath:join(root,'native-observer-live-cursor.json'),protocolDigest:journal.protocolDigest,
    candidateCutDigest:journal.candidateCutDigest,allocationConventionDigest:journal.allocationConventionDigest,
    durationSeconds:3,pollIntervalMs:1000,limits:{...limits,ref:'original-development-native-observer-exercise',
      registrationDigest:digest(nativeBase)}});
  assert.equal(nativeLive.segment.status,'FINISHED');assert.ok(nativeLive.segment.observations.some(o=>o.status==='OBSERVED'));
  assert.ok(nativeLive.state.resources.acquisitionExposures>=5,'authentication, native metadata and SQL reads retain durable exposures');
  const proof={schema:'finnor.x1.real-owner-execution-exercise.v1',beforeWorker:exercise.first.cursor.entries.map(e=>({
    environmentId:e.environmentId,eventId:e.eventId,status:e.status})),resumed,live,drafts,nativeProbes,collection,nativeLive,
    clockCalls:exercise.clockCalls,originalWorkAndEffectPreserved:true,completionBasis:'ACTUAL_NATIVE_OWNER_AND_SEPARATE_CANONICAL_OBSERVER',
    tenProtectedEnvironmentsEstablished:false,thirtyDayCoverageEstablished:false,sevenDayCoverageEstablished:false,
    protectedQualificationEstablished:false,moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null};
  await writeFile(join(root,'independent-execution-proof.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});return proof;
}

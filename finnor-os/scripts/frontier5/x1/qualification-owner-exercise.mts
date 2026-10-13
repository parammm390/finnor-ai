/** Finite real-owner exercise, not a protected institutional population. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {digest} from '../../../packages/capability-evolution/src/contracts';
import {QualificationExecutionJournal,executeReplaySlice,executeLiveObservationSlice,
  validateExecutionJournal,type OwnerEndpoint} from './qualification-runtime.mts';

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
    validateExecutionJournal(journal,{protocolDigest:journal.protocolDigest,candidateCutDigest:journal.candidateCutDigest,
      allocationConventionDigest:journal.allocationConventionDigest,environments:journal.environments.map(e=>
        ({id:e.id,replayJournalCommitment:digest(e)}))});
    const limits={ref:'original-development-validation-exercise',registrationDigest:digest(journal),
      maxAcquisitionCalls:160,maxOutputBytes:64*1024*1024,maxAggregateWallMs:180000};
    const cursorPath=join(root,'replay-cursor.json');
    await writeFile(join(root,'journal.json'),JSON.stringify(journal,null,2)+'\n',{flag:'wx',mode:0o600});
    const first=await executeReplaySlice({journal,evidenceRoot:root,cursorPath,deadlineAt:Date.now()+60000,limits,maxEvents:128});
    assert.equal(first.cursor.entries.length,10);assert.equal(first.submitted,10);
    assert.ok(first.cursor.entries.every(e=>e.status==='RECONCILIATION_REQUIRED'));
    assert.equal(first.completeExpectedEventCoverage,false);assert.equal(clockCalls.length,10,
      '202 must not expose any dependent event before actual applied native state');
    await writeFile(join(root,'before-worker.json'),JSON.stringify({first,clockCalls,
      predicate:'ACTUAL_QUEUED_ACCEPTANCE_DOES_NOT_UNLOCK_DEPENDENT_EVENT',protectedPopulationClaimed:false},null,2)+'\n',{mode:0o600});
    return {root,journal,limits,cursorPath,first,clockCalls,ownerRead,clockOwner,
      close:async()=>{await new Promise<void>(resolve=>clock.close(()=>resolve()));delete process.env[variable];}};
  }catch(error){await new Promise<void>(resolve=>clock.close(()=>resolve()));delete process.env[variable];throw error;}
}

export async function finishQualificationOwnerExercise(exercise:Awaited<ReturnType<typeof startQualificationOwnerExercise>>){
  const {root,journal,limits,cursorPath}=exercise;
  const resumed=await executeReplaySlice({journal,evidenceRoot:root,cursorPath,deadlineAt:Date.now()+60000,limits,maxEvents:128});
  assert.equal(resumed.completeExpectedEventCoverage,true);assert.equal(resumed.cursor.entries.length,20);
  assert.ok(resumed.cursor.entries.every(e=>e.status==='APPLIED'));assert.equal(exercise.clockCalls.length,20);
  assert.equal(resumed.cursor.resources.slices.length,2);
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
  const proof={schema:'finnor.x1.real-owner-execution-exercise.v1',beforeWorker:exercise.first.cursor.entries.map(e=>({
    environmentId:e.environmentId,eventId:e.eventId,status:e.status})),resumed,live,drafts,
    clockCalls:exercise.clockCalls,originalWorkAndEffectPreserved:true,completionBasis:'ACTUAL_NATIVE_OWNER_AND_SEPARATE_CANONICAL_OBSERVER',
    tenProtectedEnvironmentsEstablished:false,thirtyDayCoverageEstablished:false,sevenDayCoverageEstablished:false,
    protectedQualificationEstablished:false,moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null};
  await writeFile(join(root,'independent-execution-proof.json'),JSON.stringify(proof,null,2)+'\n',{mode:0o600});return proof;
}

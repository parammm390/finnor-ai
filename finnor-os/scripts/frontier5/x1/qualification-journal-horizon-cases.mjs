/** Synthetic STORAGE horizon only. It records zero elapsed live operation. */
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,open,stat} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function exerciseStorageHorizon({repo,root}) {await mkdir(root,{mode:0o700});
const began=performance.now(),sha=x=>createHash('sha256').update(x).digest('hex');
const {newQualificationJournalCodec,encodeQualificationJournalRecord,readQualificationCursor}=await import(
 pathToFileURL(join(repo,'finnor-os/scripts/frontier5/x1/qualification-state-journal.mts')));
const maximum=64*1024*1024,codec=newQualificationJournalCodec(),journal='qualification-state-'+randomUUID()+'.journal',
 cursorPath=join(root,'cursor.json'),frames=[];let journalBytes=0,revision=0,exposures=0,acks=0,externalBytes=0;
const refs=[];
for(let i=0;i<12;i++){
 const bytes=Buffer.from(JSON.stringify({schema:'PUBLIC_SYNTHETIC_SEMANTIC_SNAPSHOT_NOT_OWNER_EVIDENCE',
  selector:i%10,value:i>=10?'MATERIAL_CHANGE':'unchanged',duplicateMultiplicity:i===11?2:1,actualServiceObserved:false})+'\n'),
 name='live-owner-'+sha(bytes)+'.json';await writeFile(join(root,name),bytes,{flag:'wx',mode:0o600});
 externalBytes+=bytes.length;refs.push({path:name,sha256:sha(bytes),bytes:bytes.length});
}
const initial={schema:'finnor.x1.live-observation-cursor.v2',phasePin:{protocolDigest:sha('PUBLIC_STORAGE_ONLY'),
 candidateCutDigest:sha('PUBLIC_NO_RUNTIME_CLAIM'),allocationConventionDigest:sha('NO_PROTECTED_GRANT'),projectionDigests:Array.from({length:10},(_,i)=>sha('selector'+i))},
 resources:{limits:{ref:'SYNTHETIC_STORAGE_HORIZON',registrationDigest:sha('NO_AUTHORITY'),maxAcquisitionCalls:1000000,
  maxOutputBytes:maximum,maxAggregateWallMs:604800000},limitsDigest:sha('SYNTHETIC_LIMITS'),outputBytes:0,
 acquisitionExposures:0,acknowledgedAcquisitions:0,slices:[],countersAreDurableExposureUpperBounds:true,moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null},
 segments:[],revision:0,syntheticStorageChallengeNotElapsedLiveTime:true};
const pointer=Buffer.from(JSON.stringify({schema:'finnor.x1.qualification-state-journal.v1',journal,
 initialDigest:sha(JSON.stringify(initial)),originalCountersRetained:true})+'\n');
const emit=(changes,extra=0)=>{const frame=encodeQualificationJournalRecord({changes,externalBytes:extra},codec);
 frames.push(frame);journalBytes+=frame.length;assert.ok(journalBytes+pointer.length+externalBytes<maximum,'Frozen64MiB storage bound');
 if(codec.sequence%10000===0)assert.ok(performance.now()-began<180000,'Frozen180second encoding bound');};
const first=encodeQualificationJournalRecord({initial,externalBytes},codec);frames.push(first);journalBytes+=first.length;
const at=ms=>new Date(Date.parse('2026-10-01T00:00:00.000Z')+ms).toISOString();
const resources=(slice,elapsed)=>[
 [['revision'],++revision],[['resources','slices',slice,'observedElapsedMs'],elapsed],
 [['resources','slices',slice,'lastObservedAt'],at(slice*840000+elapsed)],
 [['resources','acquisitionExposures'],exposures],[['resources','acknowledgedAcquisitions'],acks],
];
for(let slice=0;slice<720;slice++){
 const id=randomUUID();emit([[['resources','slices',slice],{id,pid:999999,startedAt:at(slice*840000),lastObservedAt:at(slice*840000),reservedWallMs:840000,
 observedElapsedMs:0,status:'STARTED',unobservedTail:false}],[['segments',slice],{id,status:'STARTED',startedAt:at(slice*840000),observations:[],receiptRefs:refs.slice(0,10),polls:0}]]);
 for(let poll=0;poll<14;poll++)for(let environment=0;environment<10;environment++){
  const offset=poll*10+environment,ordinal=slice*140+offset,elapsed=poll*60000+environment*10,invocationId=id+':'+(offset+1),
   prefix=['segments',slice,'observations',offset],ref=ordinal===1234?refs[10]:ordinal===2345?refs[11]:refs[environment];
  exposures++;emit([[prefix,{invocationId,environmentId:'public-storage-selector-'+environment,at:at(slice*840000+elapsed),status:'EXPOSED'}],...resources(slice,elapsed)]);
  acks++;exposures++;emit(resources(slice,elapsed+1));
  acks++;emit([...resources(slice,elapsed+2),[[...prefix,'status'],ordinal===3333?'UNKNOWN':'OBSERVED'],
   [[...prefix,'receiptRef'],ref],[[...prefix,'ownerIdentityDigest'],sha('ACTUAL_READ_IDENTITY_SYNTHETIC_PLACEHOLDER')],
   [[...prefix,'ownerResponseDigest'],sha('different-physical-response-'+ordinal)],
   [[...prefix,'independentReadAt'],at(slice*840000+elapsed+2)],
   [[...prefix,'semanticSnapshotDigest'],ref.sha256],[[...prefix,'visibilityWitnesses'],[{identity:'synthetic-object',observedAt:at(slice*840000+elapsed+2)}]],
   ...(ordinal===3333?[[[...prefix,'predicate'],'SYNTHETIC_STORAGE_UNKNOWN_MUST_SURVIVE']]:[])]);
 }
 emit([[['segments',slice,'polls'],14],[['segments',slice,'status'],'FINISHED'],[['segments',slice,'endedAt'],at((slice+1)*840000)],
  [['resources','slices',slice,'status'],'FINISHED'],[['resources','slices',slice,'endedAt'],at((slice+1)*840000)],...resources(slice,840000)]);
}
assert.equal(exposures,201600);assert.equal(acks,201600);
await writeFile(cursorPath,pointer,{flag:'wx',mode:0o600});await writeFile(join(root,journal),Buffer.concat(frames),{flag:'wx',mode:0o600});
const reconstructed=await readQualificationCursor(cursorPath);
assert.equal(reconstructed.segments.length,720);assert.equal(reconstructed.segments.reduce((n,s)=>n+s.observations.length,0),100800);
assert.equal(reconstructed.resources.acquisitionExposures,201600);assert.equal(reconstructed.resources.acknowledgedAcquisitions,201600);
assert.equal(reconstructed.resources.outputBytes,journalBytes+pointer.length+externalBytes);
const observations=reconstructed.segments.flatMap(s=>s.observations);
assert.equal(observations[1234].receiptRef.sha256,refs[10].sha256);assert.equal(observations[2345].receiptRef.sha256,refs[11].sha256);
assert.equal(observations[3333].status,'UNKNOWN');assert.equal(observations[3333].predicate,'SYNTHETIC_STORAGE_UNKNOWN_MUST_SURVIVE');
const file=await open(join(root,journal),'r+'),before=Buffer.alloc(1);await file.read(before,0,1,24);
try{await file.write(Buffer.from([before[0]^1]),0,1,24);
 await assert.rejects(()=>readQualificationCursor(cursorPath),/QUALIFICATION_JOURNAL_FRAME_INTEGRITY_CHANGED/);
}finally{await file.write(before,0,1,24);await file.close();}
assert.equal(sha(await readFile(join(root,journal))),sha(Buffer.concat(frames)),'restored exact journal bytes after corruption challenge');
const truncatedName='qualification-state-'+randomUUID()+'.journal';
await writeFile(join(root,truncatedName),first.subarray(0,first.length-1),{flag:'wx',mode:0o600});
const truncatedPointer=join(root,'truncated-cursor.json');
await writeFile(truncatedPointer,JSON.stringify({...JSON.parse(pointer.toString()),journal:truncatedName})+'\n',{flag:'wx',mode:0o600});
await assert.rejects(()=>readQualificationCursor(truncatedPointer),/QUALIFICATION_JOURNAL_FRAME_INCOMPLETE/);
const receipt={status:'PASS_SEVEN_DAY_STORAGE_ENCODING_ONLY',syntheticProbeCount:100800,syntheticPhysicalAcquisitions:201600,
 finiteSlices:720,frameCount:codec.sequence,encodedJournalBytes:journalBytes,chargedOutputBytes:reconstructed.resources.outputBytes,
 originalMaxOutputBytes:maximum,exactReconstruction:true,materialChangeDuplicateAndUnknownRetained:true,
 corruptFrameRefused:true,truncatedFrameRefused:true,actualElapsedLiveDaysObserved:0,actualServiceCalls:0,protectedQualification:false,
 elapsedMs:performance.now()-began,monetaryCostUsd:null,humanSeconds:null,aggregateMemoryQualification:'UNKNOWN'};
await writeFile(join(root,'result.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify(receipt));

return {receipt,evidenceRoot:root};
}

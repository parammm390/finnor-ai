import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {proposeInstitutionModel} from '../../../packages/private-equity/src/institution-program/reconstruction.ts';
import {independentlyCheckInstitutionModel} from '../../../packages/private-equity/src/institution-program/checker.ts';
const repo=fileURLToPath(new URL('../../../../',import.meta.url)),root=process.argv[2];
assert.ok(root?.startsWith('/'));await mkdir(root,{mode:0o700});
const original=JSON.parse(await readFile(new URL('./reference/original-input.json',import.meta.url),'utf8'));
const profile=JSON.parse(await readFile(join(repo,'scope-frontier5/x1-institutional-programme-compiler/profile.json'),'utf8'));
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const results=[];
for(const elapsedMs of [0,900,31000]){
 const clock=Date.now,start=clock();let calls=0,candidate=null,error=null;
 try{Date.now=()=>start+(calls++===0?0:elapsedMs);candidate=await proposeInstitutionModel(original,profile);}
 catch(cause){error=String(cause.message);}finally{Date.now=clock;}
 const check=candidate?await independentlyCheckInstitutionModel(original,candidate,profile):null;
 results.push({elapsedMs,clockCalls:calls,candidate,error,check});
}
const checks=[{id:'both-original-checks-accepted',passed:results.slice(0,2).every(r=>r.check?.disposition==='ACCEPTED_DEVELOPMENT')},
 {id:'physical-clock-does-not-change-admitted-candidate',passed:sha(results[0].candidate)===sha(results[1].candidate)},
 {id:'original-thirty-second-bound-retained',passed:results[2].candidate===null&&results[2].error?.startsWith('X1_RECONSTRUCTION_BOUND:')===true},
 {id:'original-profile-unchanged',passed:profile.bounds.initialResponseSeconds===30&&profile.bounds.episodeWallSeconds===3600}];
const result={status:checks.every(c=>c.passed)?'PASS':'FAIL',originalDigest:sha(original),results,checks,
 sourceSha256:sha(await readFile(join(repo,'finnor-os/packages/private-equity/src/institution-program/reconstruction.ts'),'utf8')),
 clockDomain:'SYNTHETIC_COMPONENT_DATE_NOW_SAMPLES_ONLY',actualBusinessCompletion:false,actualElapsedQualification:false};
await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:result.status,checks,clockCalls:results.map(r=>r.clockCalls)}));
assert.equal(result.status,'PASS','Identical original institutional meaning must retain one admitted candidate identity');

/** Full offline administrator contract. All signed packets are public RFC test
 * fixtures; this command creates no protected authority or actual live history. */
import assert from 'node:assert/strict';
import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exerciseFullPopulation} from './qualification-full-population-cases.mjs';
import {exercisePublicAssessment} from './qualification-public-assessment-cases.mjs';
const repo=fileURLToPath(new URL('../../../../',import.meta.url));
const [root,locked]=process.argv.slice(2);
assert.ok(root?.startsWith('/')&&locked?.startsWith('/'),'Existing pinned locked source and fresh private evidence path required');
await mkdir(root,{mode:0o700});
const started=performance.now();
const generated=await exerciseFullPopulation({repo,root:join(root,'generator'),locked});
const assessed=await exercisePublicAssessment({repo,previous:generated.evidenceRoot,root:join(root,'assessment')});
const size=async(path)=>{
 let bytes=0;for(const entry of await readdir(path,{withFileTypes:true})){
  const full=join(path,entry.name);if(entry.isDirectory())bytes+=await size(full);
  else{const {stat}=await import('node:fs/promises');bytes+=(await stat(full)).size;}}
 return bytes;
};
const outputBytes=await size(root);assert.ok(outputBytes<64*1024*1024,'Original aggregate offline output allowance');
const result={status:'PASS_FULL_PUBLIC_QUALIFICATION_CONTRACT',generatorCases:generated.results.length,
 assessmentCases:assessed.results.length,outputBytes,elapsedMs:performance.now()-started,
 protectedQualification:false,actualLiveDaysObserved:0,actualServiceCalls:0,actualCustodyEstablished:false,
 publicTestVectorsNeverInstalledAsAuthority:true,originalLockedSource:generated.control.lockedSpecification,
 engineeringDeliveryComplete:false,moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null};
let encoded;
for(let i=0;i<8;i++){
 encoded=Buffer.from(JSON.stringify(result,null,2)+'\n');
 if(result.outputBytes===outputBytes+encoded.length)break;
 result.outputBytes=outputBytes+encoded.length;
}
assert.ok(result.outputBytes<=64*1024*1024&&result.outputBytes===outputBytes+encoded.length);
await writeFile(join(root,'result.json'),encoded,{flag:'wx',mode:0o600});
console.log(JSON.stringify(result));

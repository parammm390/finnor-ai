/** Amendment 48: independent original-information acceptance, no unit hooks. */
import { strict as assert } from 'node:assert';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync,type SpawnSyncReturns } from 'node:child_process';
import { compilePolicyAtlas } from '../../packages/epistemic-runtime/src/policy-atlas/compiler';
import { atlasHash,bytesHash } from '../../packages/epistemic-runtime/src/policy-atlas/exact';
import { fixtureInformation,fixtureSource } from './fixtures.mts';

const output=resolve(process.env.FINNOR_R7_EVIDENCE_DIR!),checker=resolve('packages/epistemic-runtime/src/policy-atlas/checker.py'),
  checkerDigest=bytesHash(await readFile(checker)),results:unknown[]=[];
await mkdir(output,{recursive:true});
for(const kind of ['positive','unobserved','reordered','conflicting'] as const){
  const source=fixtureSource('diagnostic',1,3,2,3);fixtureInformation(source,kind);
  let proposal,producerPredicate:string|null=null,check:any=null,status='FAIL';
  try{
    try{proposal=compilePolicyAtlas(source,checkerDigest);}
    catch(error){producerPredicate=String(error);if(kind==='positive')throw error;}
    // If producer validation refuses, use its independently registered positive
    // partition, rebinding only the supplied original input digest. The checker
    // must reject original information semantics before any label/hash mismatch.
    if(!proposal){
      const positive=fixtureSource('diagnostic',1,3,2,3,{tenantId:source.mandate.tenantId,principalId:source.mandate.principalId});
      positive.mandate=structuredClone(source.mandate);fixtureInformation(positive,'positive');
      proposal=compilePolicyAtlas(positive,checkerDigest);
      proposal.inputDigest=atlasHash(source);
    }
    const child:SpawnSyncReturns<string>=spawnSync(process.env.FINNOR_R7_PYTHON??'/usr/bin/python3',[checker],{
      input:JSON.stringify({source,proposal}),encoding:'utf8',timeout:60000,maxBuffer:33554432});
    assert.equal(child.status,0,child.stderr);check=JSON.parse(child.stdout).data;
    if(kind==='positive')assert.equal(check.status,'ACCEPTED');
    else{
      assert(producerPredicate?.includes(kind==='conflicting'?'OBSERVATION_EVENT_IDENTITY':'NONANTICIPATIVE_POLICY'));
      assert.equal(check.status,'REJECTED');
      assert.equal(check.predicate,kind==='conflicting'?'ORIGINAL_OBSERVATION_EVENT_IDENTITY':'ORIGINAL_NONANTICIPATIVE_POLICY');
    }
    status='PASS';
  }catch(error){producerPredicate??=String(error);}
  await writeFile(resolve(output,kind+'.json'),JSON.stringify({source,proposal,producerPredicate,check,status},null,2)+'\n');
  results.push({kind,status,producerPredicate,check});
}
await writeFile(resolve(output,'results.json'),JSON.stringify({schema:'finnor.r7.information-e2e.v1',checkerDigest,
  qualification:'EXACT_ORIGINAL_INFORMATION_MODEL_NOT_ACTUAL_S2_CONTINUATION',results},null,2)+'\n');
console.log(JSON.stringify({output,results}));
if(results.some((r:any)=>r.status==='FAIL'))process.exitCode=1;

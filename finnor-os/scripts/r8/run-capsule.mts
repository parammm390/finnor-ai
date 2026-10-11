/** Registered accepted-preimage challenges, without restarting synthesis or
 * borrowing a receipt for changed code. See the frozen failure model. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {assertCoverage} from '../../packages/epistemic-runtime/src/solver-synthesis/checker';
import {assertLowering} from '../../packages/epistemic-runtime/src/solver-synthesis/lowering';
import {validateCapsule} from '../../packages/private-equity/src/r8/capsule';
import {hash} from '../../packages/epistemic-runtime/src/solver-synthesis/contracts';
import {canonical} from '../../packages/governed-execution/src/protocol';
const path=resolve(process.env.FINNOR_R8_CAPSULE!),output=resolve(process.env.FINNOR_R8_EVIDENCE_DIR!);
await mkdir(output,{recursive:true,mode:0o700});
const capsule=validateCapsule(JSON.parse(await readFile(path,'utf8'))),startedAt=new Date().toISOString(),cases:any[]=[];
assertCoverage(capsule.receipt);assertLowering(capsule.program,capsule.module);
for(const variant of ['ast','ir','emitted','compiler','library']){
 const program=structuredClone(capsule.program),module=structuredClone(capsule.module);
 if(variant==='ast')program.output='bestValue';
 if(variant==='ir'){const ir=JSON.parse(module.compiled);ir.outputs[0].register='r0';module.compiled=canonical(ir);}
 if(variant==='emitted')module.typescript.emitted='export function compute(){return {mask:"0"}}';
 if(variant==='compiler')module.typescript.compiler.optionsDigest='0'.repeat(64);
 if(variant==='library')module.typescript.compiler.libraries[0]!.sha256='0'.repeat(64);
 let refusal='';try{assertLowering(program,module);}catch(error){refusal=String(error);}
 cases.push({variant,status:refusal?'PASS':'FAIL',boundary:'ACTUAL_REGISTERED_LOWERING_REBUILD',refusal});
}
for(const variant of ['omission','duplicate','candidate','checker','output','pairs','profile','optimal-set']){
 const receipt=structuredClone(capsule.receipt);
 if(variant==='omission')receipt.chunks.pop();
 if(variant==='duplicate')receipt.chunks[1]=receipt.chunks[0]!;
 if(variant==='candidate')receipt.chunks[0]!.moduleDigest='0'.repeat(64);
 if(variant==='checker')receipt.chunks[0]!.checkerDigest='0'.repeat(64);
 if(variant==='output')receipt.chunks[0]!.masks='0'.repeat(4096);
 if(variant==='pairs')receipt.chunks[0]!.pairs=4096;
 if(variant==='profile')receipt.specificationDigest='0'.repeat(64);
 if(variant==='optimal-set')receipt.chunks[0]!.optimalSets='00'.repeat(4096);
 receipt.chunkDigest=hash(receipt.chunks);
 let refusal='';try{assertCoverage(receipt);}catch(error){refusal=String(error);}
 cases.push({variant,status:refusal?'PASS':'FAIL',boundary:'ACTUAL_FULL_COVERAGE_ACCEPTED_PREIMAGE',refusal});
}
for(const variant of ['receipt','mapping','runtime','envelope']){
 const changed=structuredClone(capsule);
 if(variant==='receipt')changed.receipt.checkedPairs=262144 as typeof changed.receipt.checkedPairs;
 if(variant==='mapping')changed.ownerOutputMapping.reverse();
 if(variant==='runtime')changed.runtime.identityDigest='0'.repeat(64);
 if(variant==='envelope')changed.envelope.originalDeadlineAt=new Date(Date.now()+7200000).toISOString();
 let refusal='';try{validateCapsule(changed);}catch(error){refusal=String(error);}
 cases.push({variant,status:refusal?'PASS':'FAIL',boundary:'ACTUAL_CAPSULE_IDENTITY_NOT_DISPLAY_NAME',refusal});
}
const evidence={schema:'finnor.r8.accepted-preimage-e2e.v1',startedAt,finishedAt:new Date().toISOString(),capsuleRef:capsule.ref,
 receiptDigest:hash(capsule.receipt),input:path,cases,qualification:'REAL_PREVIOUSLY_FULLY_ACCEPTED_PREREQUISITE; NO_NEW_SYNTHESIS_OR_PROTECTED_ADMISSION',
 rerun:'FINNOR_R8_CAPSULE=<actual-accepted-capsule> FINNOR_R8_EVIDENCE_DIR=<fresh-private-dir> node --import=tsx scripts/r8/run-capsule.mts'};
await writeFile(resolve(output,'results.json'),JSON.stringify(evidence,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({status:cases.every(row=>row.status==='PASS')?'PASS':'FAIL',cases:cases.length,output}));
if(cases.some(row=>row.status!=='PASS'))process.exitCode=1;

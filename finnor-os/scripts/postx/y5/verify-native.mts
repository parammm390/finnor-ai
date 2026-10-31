import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {discoverUniformAlgorithm,checkUniformAlgorithm,executeUniformAlgorithm} from '../../../packages/epistemic-runtime/src/uniform-algorithms/index';
import {hash,jsonHash} from '../../../packages/epistemic-runtime/src/uniform-algorithms/syntax';
import {verifyNativeFaults} from './verify-native-faults.mts';

const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??'../evidence/y5-native');
await mkdir(evidence,{recursive:true});
const started=Date.now(),observations:unknown[]=[];
try{
 const result=await discoverUniformAlgorithm({deadlineAt:Date.now()+120000,scratch:resolve(evidence,'scratch'),developmentWeights:[['-3','0','5'],['2','-1'],[]]});
 assert.equal(result.status,'CHECKED');
 assert(result.capsule);
 assert(result.attempts.some(a=>a.status==='REFUTED'));
 const capsule=result.capsule;
 const checked=await checkUniformAlgorithm(capsule,{deadlineAt:Date.now()+30000,scratch:resolve(evidence,'independent')});
 assert.equal(checked.exactType,true);
 assert.equal(checked.kernelReplay,true);
 assert.equal(checked.trustPolicyApproval,'NOT_ESTABLISHED');
 assert(!checked.axioms.some(a=>/sorry|native|compiler|^Y5\./i.test(a)));
 observations.push({case:'N1',result,checked});
 for(const n of [0,1,17,128]){
  const weights=Array.from({length:n},(_,i)=>i%3===0?'-30000000000000000000000000000000000000000000000000000000000000000000000000000000':i%3===1?'0':'50000000000000000000000000000000000000000000000000000000000000000000000000000000');
  const execution=await executeUniformAlgorithm(capsule,weights,{deadlineAt:Date.now()+30000,scratch:resolve(evidence,'execute-'+n)});
  assert.deepEqual(execution.selected,weights.map((w,i)=>BigInt(w)>0n?i:-1).filter(i=>i>=0));
  assert.equal(execution.coordinateSteps,n);
  observations.push({case:'N3',n,execution});
 }
 const seal=(c:typeof capsule)=>{const {digest:_,...body}=c;c.digest=jsonHash(body);return c;};
 for(const [name,change] of [
  ['same-name-implementation',(s:string)=>s.replace('def algorithm := run decision','def algorithm := run (fun _ => true)')],
  ['same-name-wrong-theorem',(s:string)=>s.replace('theorem uniform : UniformStatement decision','theorem uniform : True')],
  ['sorry',(s:string)=>s.replace('theorem uniform : UniformStatement decision := by','theorem uniform : UniformStatement decision := by sorry\n/-')],
  ['extra-import',(s:string)=>'import Lean\n'+s],
 ] as const){
  const corrupt=structuredClone(capsule);corrupt.algorithmSource=change(corrupt.algorithmSource);
  corrupt.sourceDigest=hash(corrupt.algorithmSource);corrupt.checker.sourceDigest=corrupt.sourceDigest;seal(corrupt);
  await assert.rejects(()=>checkUniformAlgorithm(corrupt,{deadlineAt:Date.now()+30000,scratch:resolve(evidence,name)}),/Y5_SOURCE_CORRESPONDENCE/);
  observations.push({case:'N2-'+name,rejected:true,guard:'Y5_SOURCE_CORRESPONDENCE',digestResealed:true,kernelReached:false});
 }
 const unsafe=structuredClone(capsule);unsafe.checker.axioms.push('sorryAx');seal(unsafe);
 await assert.rejects(()=>checkUniformAlgorithm(unsafe,{deadlineAt:Date.now()+30000,scratch:resolve(evidence,'unsafe-axiom')}),/Y5_UNAPPROVED_OR_UNSAFE_AXIOM/);
 const stale=structuredClone(capsule);stale.search.wallMs++;
 await assert.rejects(()=>checkUniformAlgorithm(stale,{deadlineAt:Date.now()+30000,scratch:resolve(evidence,'integrity')}),/Y5_CAPSULE_INTEGRITY/);
 const object=structuredClone(capsule),bytes=Buffer.from(object.proofObject,'base64');bytes[bytes.length-1]=bytes[bytes.length-1]!^1;
 object.proofObject=bytes.toString('base64');object.proofObjectDigest=hash(bytes);object.checker.proofObjectDigest=object.proofObjectDigest;seal(object);
 await assert.rejects(()=>checkUniformAlgorithm(object,{deadlineAt:Date.now()+30000,scratch:resolve(evidence,'proof-object')}),/Y5_PROOF_SOURCE_CORRESPONDENCE/);
 observations.push({case:'N2-proof-object',rejected:true,guard:'Y5_PROOF_SOURCE_CORRESPONDENCE',independentElaborationReached:true});
 observations.push({case:'N2-unsafe-and-integrity',rejected:true,guards:['Y5_UNAPPROVED_OR_UNSAFE_AXIOM','Y5_CAPSULE_INTEGRITY'],kernelReached:false});
 await assert.rejects(()=>executeUniformAlgorithm(capsule,Array(129).fill('1'),{deadlineAt:Date.now()+30000,scratch:resolve(evidence,'oversize')}),/Y5_PRACTICAL_DOMAIN/);
 for(const weights of [['-0'],['01'],['1.0'],['9'.repeat(513)]]){
  await assert.rejects(()=>executeUniformAlgorithm(capsule,weights,{deadlineAt:Date.now()+30000,scratch:resolve(evidence,'invalid-number')}),/Y5_PRACTICAL_DOMAIN/);
 }
 const digitBoundary=await executeUniformAlgorithm(capsule,['9'.repeat(512),'-'+'9'.repeat(512)],{deadlineAt:Date.now()+30000,scratch:resolve(evidence,'digits-512')});
 assert.deepEqual(digitBoundary.selected,[0]);assert.equal(digitBoundary.coordinateSteps,2);
 observations.push({case:'N3-digits-512',execution:digitBoundary});
 observations.push(...await verifyNativeFaults(evidence));
 await writeFile(resolve(evidence,'report.json'),JSON.stringify({schema:'finnor.y5.native-verification.v1',status:'PASS',scope:'PUBLIC_DEVELOPMENT_NOT_QUALIFICATION',wallMs:Date.now()-started,observations},null,2)+'\n');
 console.log(JSON.stringify({status:'PASS',evidence,wallMs:Date.now()-started}));
}catch(error){
 await writeFile(resolve(evidence,'failure.json'),JSON.stringify({status:'FAIL',wallMs:Date.now()-started,error:String(error),observations},null,2)+'\n');
 throw error;
}

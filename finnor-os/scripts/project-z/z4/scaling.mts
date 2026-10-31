/** Five alternating full-lifecycle observations at every frozen T, not demand. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {canonical,sha,LENGTHS,type ExactRequest} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts';
import {originalExecution} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/original';
import {produceExecutionProof,checkExecutionProof} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/engine';
import {measureExecution,type ExecutionInterval} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/costs';
import {NativeFailure,nativeIdentity} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/native';
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const arg=(n:string)=>process.argv[process.argv.indexOf(n)+1];
const evidence=arg('--evidence'),steps=Number(arg('--steps')),observation=Number(arg('--observation'));
if(!evidence?.startsWith('/')||!(LENGTHS as readonly number[]).includes(steps)||!Number.isInteger(observation)||observation<0||observation>4)
 throw Error('Z4_FROZEN_SCALING_COORDINATES_REQUIRED');
await mkdir(evidence,{recursive:false,mode:0o700});
const request:ExactRequest={program:{schema:'finnor.z4.integer-program.v1',inputCount:1,inputUnits:['1'],
 registers:[{type:'i64',unit:'1'},{type:'bool',unit:'1'}],rounding:'EXACT_NO_CONVERSION',
 instructions:[{op:'add',dst:0,a:{reg:0},b:{input:0}},{op:'lt',dst:1,a:{reg:0},b:{const:'0'}}]},
 initial:['0','0'],inputs:Array.from({length:steps},(_,i)=>[String(i%7-3)]),binding:'0'.repeat(64)};
const sum=request.inputs.reduce((a,row)=>a+BigInt(row[0]!),0n),expected=[sum.toString(),sum<0n?'1':'0'];
const report:Record<string,unknown>={schema:'finnor.z4.scaling-observation.v1',steps,observation,expected,
 order:observation%2?'PROOF_THEN_ORIGINAL':'ORIGINAL_THEN_PROOF',request,nativeOwner:false,eligibleReuseN:0,
 protectedAdmission:'NOT_RUN',money:null,humanSeconds:null,aggregateRSS:null,status:'RUNNING'};
const nativeObservations:Array<Record<string,unknown>>=[];report.nativeObservations=nativeObservations;
const save=()=>writeFile(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
const intervals:ExecutionInterval[]=[];report.intervals=intervals;
const full=()=>{
 const start=performance.now(),cpu=process.cpuUsage(),original=originalExecution(request);
 if(canonical(original.finalState)!==canonical(expected))throw Error('Z4_SCALING_INDEPENDENT_CLOSED_FORM_MISMATCH');
 return {original,wallMs:performance.now()-start,cpuMicros:process.cpuUsage(cpu),rssAfterBytes:process.memoryUsage().rss,
  accountingScope:'PROCESS_INTERVAL_NOT_ISOLATED_PEAK'};
};
try{
 report.identity=await nativeIdentity();await save();
 if(observation%2===0)report.fullOriginal=full();
 const deadlineAt=arg('--deadline');
 if(!deadlineAt||!Number.isFinite(Date.parse(deadlineAt))||Date.parse(deadlineAt)<=Date.now())
  throw Error('Z4_ORIGINAL_MEASUREMENT_DEADLINE_REQUIRED');
 const limits={deadlineAt:new Date(Math.min(Date.parse(deadlineAt),Date.now()+600000)).toISOString(),
  maxMemoryBytes:2*1024**3,cpuSeconds:(op:string)=>op==='prove'?600:op==='verify'?90:10,
 };
 const production=await measureExecution('fresh-proof-production',observe=>produceExecutionProof(request,{...limits,
  observed:async receipt=>{
   observe(receipt.meters);
   nativeObservations.push({operation:receipt.operation,meters:receipt.meters,
    ...('failure'in receipt?{failure:receipt.failure}:{binarySha256:receipt.binarySha256,sourceDigest:receipt.sourceDigest})});
   await save();
  }}),async interval=>{intervals.push(interval);await save();});
 const checked=production.value;
 report.fullProofLifecycleWallMs=production.interval.wallMs;
 report.producerBreakdown=checked.productionMeters;
 if(canonical(checked.statement.finalState)!==canonical(expected))throw Error('Z4_SCALING_LITERAL_MISMATCH');
 if(observation%2===1)report.fullOriginal=full();
 const fullCheck=await measureExecution('complete-independent-proof-check',observe=>checkExecutionProof(request,checked,{...limits,
  observed:async receipt=>{
   observe(receipt.meters);nativeObservations.push({scope:'complete-independent-proof-check',operation:receipt.operation,
    meters:receipt.meters,...('failure'in receipt?{failure:receipt.failure}:{binarySha256:receipt.binarySha256,sourceDigest:receipt.sourceDigest})});
   await save();
  }}),async interval=>{intervals.push(interval);await save();});
 report.fullIndependentProofCheck=fullCheck.interval;
 report.fullIndependentVerifierReplayedOriginal=fullCheck.value.originalExecutionReplayed;
 report.crossover='NOT_ESTABLISHED_AT_ACTUAL_ELIGIBLE_N_ZERO';
 report.fullCostGaps=['process-tree total supplied by outer controller only','build','learning','storage','invalidation',
  'recovery','native install','provider money','human effort','matched eligible original owner demand'];
 const candidate={statement:checked.statement,artifact:checked.artifact},path=resolve(evidence,'candidate.json');
 await writeFile(path,canonical(candidate)+'\n',{mode:0o600,flag:'wx'});
 const native=resolve(repository,'finnor-os/packages/epistemic-runtime/native/z4-execution-proof');
 const child=spawn('/usr/bin/python3',[resolve(repository,'finnor-os/scripts/project-z/z4/offline-native.py'),
  '--native',native,'--mode','warm-verify','--candidate',path],{cwd:evidence,
  env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1',NODE_ENV:'production'},stdio:['ignore','pipe','pipe']});
 const chunks:Buffer[]=[];let size=0;child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>2*1024*1024)child.kill('SIGKILL');else chunks.push(b);});
 let errors=0;child.stderr.on('data',(b:Buffer)=>{errors+=b.length;if(errors>65536)child.kill('SIGKILL');});
 const exit=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('close',done);});
 if(exit!==0)throw Error('Z4_WARM_PROFILE_PROCESS_FAILED');
 const warm=JSON.parse(Buffer.concat(chunks).toString());
 if(warm.readings.length!==2||warm.readings.some((r:{response:{statementDigest:string;status:string}})=>
  r.response.status!=='VERIFIED_COMPUTATION_ONLY'||r.response.statementDigest!==sha(checked.statement)))throw Error('Z4_WARM_VERIFIER_PUBLIC_BINDING');
 report.coldAndWarmVerifier=warm;report.checkedDigest=sha(checked);report.proofBytes=checked.artifact.proofHex.length/2;
 report.warmVerifierScope='BARE_CRYPTOGRAPHIC_VERIFIER_NOT_END_TO_END_CHECKING';
 report.processes=checked.processes.map(p=>({operation:p.operation,meters:p.meters}));
 report.endToEndCheckingIsLinear=true;report.verifierExecutesOriginalProgramme=false;
 report.linearCheckingWork='ORIGINAL_INPUT_VALIDATION_COMMITMENT_AND_REQUEST_BINDING_NOT_VM_REPLAY';
 report.nativeComparison='NOT_RUN_NO_NATIVE_WORK_DEMAND';
 report.status='PASSED_OFFLINE_MEASUREMENT_ONLY';await save();
 console.log(JSON.stringify({steps,observation,status:report.status,output:evidence}));
}catch(error){
 report.status='FAILED';report.error=String((error as Error).message);
 if(error instanceof NativeFailure){report.failureMeters=error.meters;report.failurePhysical=error.physical??null;}
 await save();process.exitCode=1;
}

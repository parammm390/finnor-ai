import {proposeControlQuotient,evaluateExactContingentControl,controlBytesDigest,ExactControlError} from '@finnor/epistemic-runtime';
// Fixed numerical protocol: no database, network, effects or caller code path.
const parent=process.ppid,watch=setInterval(()=>{if(process.ppid!==parent||process.ppid===1)process.exit(72);},100);
let bytes=Buffer.alloc(0);
try{
 for await(const chunk of process.stdin){if(bytes.length+chunk.length>8*1024*1024)throw Error('R1_CHILD_INPUT_BOUND');bytes=Buffer.concat([bytes,chunk]);}
 const input=JSON.parse(bytes.toString('utf8'));
 if(!['PRODUCE','S4_EVALUATE','ORIGINAL_FALLBACK'].includes(input.stage)||typeof input.nonce!=='string'||typeof input.modelBytes!=='string'||!Number.isSafeInteger(input.maxSteps)||!Number.isFinite(input.deadlineAt))throw Error('R1_CHILD_PROTOCOL');
 const account={steps:0},budget={deadlineAt:input.deadlineAt,maxSteps:input.maxSteps,account,onStep:()=>{if(process.ppid!==parent||process.ppid===1)throw Error('R1_NATIVE_PARENT_GONE');}},start=performance.now(),cpu=process.cpuUsage(),rss=process.memoryUsage().rss,startedAt=new Date().toISOString();
 let result:unknown;
 try{result=input.stage==='PRODUCE'?proposeControlQuotient(input.modelBytes,budget):evaluateExactContingentControl(input.modelBytes,{...budget,reuse:input.stage==='S4_EVALUATE'?input.reuse:null});}
 catch(error){result={status:error instanceof ExactControlError?error.disposition:'UNKNOWN',predicate:error instanceof ExactControlError?error.predicate:'R1_NATIVE_CHILD_FAILURE'};}
 const used=process.cpuUsage(cpu),output={schema:'finnor.r1.native-return.v1',nonce:input.nonce,stage:input.stage,modelDigest:controlBytesDigest(input.modelBytes),pid:process.pid,parentPid:parent,result,
  physical:{startedAt,finishedAt:new Date().toISOString(),elapsedMs:performance.now()-start,cpuUserMicros:used.user,cpuSystemMicros:used.system,rssBeforeBytes:rss,rssAfterBytes:process.memoryUsage().rss,maxRssBytes:process.resourceUsage().maxRSS*1024,mathSteps:Math.min(input.maxSteps,account.steps),nodeVersion:process.version,usd:null,aggregateSimultaneousPeakKnown:false}};
 const wire=JSON.stringify(output);if(Buffer.byteLength(wire)>8*1024*1024)throw Error('R1_CHILD_OUTPUT_BOUND');process.stdout.write(wire);
}catch{process.exitCode=73;}finally{clearInterval(watch);}

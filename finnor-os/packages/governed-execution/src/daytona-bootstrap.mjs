// Trusted supervisor uploaded by FINNOR. The finite analytical module receives
// only JSON on stdin and a fixed environment. It cannot admit a business effect.
import {spawn} from 'node:child_process';
import {readFile,writeFile,rename,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const hash=value=>createHash('sha256').update(value).digest('hex');
const directory=process.argv[2];
try{
 if(!/^\/tmp\/finnor-[a-f0-9]{64}$/.test(directory)||process.getuid?.()===0)throw Error('BOOTSTRAP_SCOPE_INVALID');
 const file=join(directory,'envelope.json');if((await stat(file)).size>2200000)throw Error('BOOTSTRAP_INPUT_BOUND');
 const e=JSON.parse(await readFile(file,'utf8')),input=JSON.stringify(e.input);
 const nodeDigest=hash(await readFile(process.execPath));
 if(nodeDigest!==e.nodeDigest||hash(e.script)!==e.scriptDigest||hash(input)!==e.inputDigest||Buffer.byteLength(input)>1048576||Buffer.byteLength(e.script)>1048576)throw Error('BOOTSTRAP_BYTE_IDENTITY_INVALID');
 const remaining=Math.min(e.wallTimeMs,Date.parse(e.deadlineAt)-Date.now());
 if(!Number.isInteger(e.wallTimeMs)||e.wallTimeMs<1||e.wallTimeMs>10000||!Number.isFinite(remaining)||remaining<1)throw Error('BOOTSTRAP_ORIGINAL_DEADLINE_EXHAUSTED');
 const script=join(directory,'module.mjs');await writeFile(script,e.script,{mode:0o400});
 const child=spawn(process.execPath,['--max-old-space-size=128',script],{cwd:directory,env:{HOME:directory,TMPDIR:directory,LANG:'C',TZ:'UTC',NODE_ENV:'production'},stdio:['pipe','pipe','pipe'],detached:true});
 const output={stdout:[],stderr:[]};let bytes=0,termination='EXITED';const startedAt=new Date().toISOString();
 const kill=()=>{if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}};
 const timer=setTimeout(()=>{termination='WALL_TIME_LIMIT';kill();},remaining);
 for(const stream of ['stdout','stderr'])child[stream].on('data',value=>{const b=Buffer.from(value),take=Math.max(0,Math.min(b.length,131072-bytes));if(take){output[stream].push(b.subarray(0,take));bytes+=take;}if(take<b.length){termination='OUTPUT_LIMIT';kill();}});
 child.stdin.on('error',()=>undefined);child.stdin.end(input);
 const result=await new Promise((yes,no)=>{child.once('error',no);child.once('close',(code,signal)=>yes({code,signal}));}).finally(()=>{clearTimeout(timer);kill();});
 const record={schema:'finnor.daytona-node-result.v1',scriptDigest:e.scriptDigest,inputDigest:e.inputDigest,nodeDigest,stdout:Buffer.concat(output.stdout).toString(),stderr:Buffer.concat(output.stderr).toString(),exitCode:result.code,signal:result.signal,termination,startedAt,finishedAt:new Date().toISOString(),outputBytes:bytes};
 await writeFile(join(directory,'result.tmp'),JSON.stringify(record),{mode:0o400});await rename(join(directory,'result.tmp'),join(directory,'result.json'));
}catch{
 // No raw input, stack, environment or provider credential is printed.
 process.stderr.write('FINNOR_REMOTE_BOOTSTRAP_FAILED');process.exitCode=1;
}

import {spawnSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const [kind,out]=process.argv.slice(2);
if(!['acquisition','native','s8','ui-safety','programme','consumer','observation','crash'].includes(kind)||!out||!out.startsWith('/'))throw Error('Usage: node scripts/p5/run-local.mjs acquisition|native|s8|ui-safety|programme|consumer|observation|crash /absolute/fresh/evidence');
const backend=resolve(import.meta.dirname,'../..'),destination=resolve(out);
await mkdir(destination,{recursive:true});
const script='scripts/p5/run-'+(kind==='acquisition'?'acquisition-e2e':kind==='native'?'native-e2e':kind==='s8'?'s8-e2e':kind==='programme'?'programme-e2e':kind==='consumer'?'consumer-e2e':kind==='observation'?'observation-e2e':kind==='crash'?'crash-e2e':'ui-safety-e2e')+'.mts';
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'test',CI:'1',FINNOR_P5_EVIDENCE_DIR:destination,
 ...(process.env.FINNOR_P5_CASE_FILTER?{FINNOR_P5_CASE_FILTER:process.env.FINNOR_P5_CASE_FILTER}:{})};
const begun=new Date().toISOString(),command=[process.execPath,'--import=tsx',script];
const child=spawnSync(command[0],command.slice(1),{cwd:backend,env,encoding:'utf8',timeout:240000,maxBuffer:2*1024*1024});
await writeFile(join(destination,'runner.log'),child.stdout+(child.stderr??''),{flag:'wx',mode:0o600});
let counts=null,failure=null,sourceCheck=null;
try{
 const result=JSON.parse(await readFile(join(destination,'results.json'),'utf8'));
 counts=Object.fromEntries(['PASS','FAIL','NOT_RUN'].map(status=>[status,result.results.filter(r=>r.status===status).length]));
 if(counts.FAIL||!counts.PASS)failure='FAILED_OR_EMPTY_REGISTERED_RUN';
 sourceCheck=JSON.parse(await readFile(join(destination,'source-check.json'),'utf8'));
 if(sourceCheck.unchanged!==true||sourceCheck.sourceComplete!==true)failure??='INCOMPLETE_OR_CHANGED_SOURCE_CUT';
}catch{failure='MISSING_OR_INVALID_RESULTS';}
const status=failure||child.status!==0||child.error?1:0;
const receipt={schema:'finnor.p5.driver-receipt.v1',begun,finishedAt:new Date().toISOString(),command,cwd:backend,environmentNames:Object.keys(env),
 childExit:child.status,childSignal:child.signal,childError:child.error?.code??null,counts,
 sourceUnchanged:sourceCheck?.unchanged??null,sourceComplete:sourceCheck?.sourceComplete??null,
 missingSource:sourceCheck?.missing??null,failure,exitCode:status,
 executableSha256:createHash('sha256').update(await readFile(process.execPath)).digest('hex'),
 driverSha256:createHash('sha256').update(await readFile(import.meta.filename)).digest('hex'),
 qualification:'SCRUBBED_LOCAL_ORDINARY_REPLAY_NOT_CLEAN_INSTALL_OR_PRODUCTION_ADMISSION'};
await writeFile(join(destination,'driver-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({destination,...receipt}));
process.exit(status);

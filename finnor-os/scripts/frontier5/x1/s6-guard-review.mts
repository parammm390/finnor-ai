import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,appendFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export async function reviewS6Guards(input:{repo:string;evidence:string;adminUrl:string;results:any[]}){
 const root=join(input.evidence,'s6-guards');await mkdir(root,{mode:0o700});
 const configuration=JSON.parse(await readFile(join(input.repo,'scope-frontier5/x1-institutional-programme-compiler/verification-plan.json'),'utf8'));
 const selected=['protocol3-rejects-institution-graphs-and-multiple-steps','forged-foreign-and-semantic-substitution',
  'immutable-origin-and-revocation-retain-responsibility'];
 const argv=['--max-old-space-size=768','--import=tsx','scripts/s6/run-obligation-e2e.mts'];
 const paths=['finnor-os/scripts/s6/run-obligation-e2e.mts','finnor-os/scripts/s5/owner-fixture.mts',
  'finnor-os/packages/private-equity/src/enterprise-obligations.ts','finnor-os/packages/workflow-runtime/src/commands.ts'];
 const pins=await Promise.all(paths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(join(input.repo,path))).digest('hex')})));
 await writeFile(join(root,'freeze.json'),JSON.stringify({argv,pins,selected,wallLimitSeconds:180,nodeHeapMiB:768,
  authentication:'ACTUAL_DISPOSABLE_BEARER_HTTP_NO_HEADER_BYPASS',protectedDispatchProof:false,
  costAllocation:'INCLUDED_IN_ORIGINAL_X1_VALIDATOR_CONTAINING_INTERVAL',python:configuration.runtime.python},null,2)+'\n',{flag:'wx',mode:0o600});
 const began=performance.now();let bytes=0,logs=Promise.resolve(),timedOut=false;
 const child=spawn(process.execPath,argv,{cwd:join(input.repo,'finnor-os'),stdio:['ignore','pipe','pipe'],env:{
  PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'',NODE_ENV:'test',CI:'1',
  LOG_LEVEL:'silent',AUTH_DEV_BYPASS:'0',RATE_LIMIT_PER_MINUTE:'10000',FINNOR_TEST_MANAGED_EXTENSIONS:'omit',
  DATABASE_URL:process.env.DATABASE_URL,FINNOR_S6_ADMIN_DATABASE_URL:input.adminUrl,
  FINNOR_S6_OBLIGATION_EVIDENCE_DIR:root,FINNOR_S6_AUTHENTICATED_LOCAL:'1',
  FINNOR_S6_OBLIGATION_CASE_FILTER:selected.join(','),FINNOR_S3_PYTHON:configuration.runtime.python,
  FINNOR_S5_PYTHON:configuration.runtime.python,FINNOR_S4_POLICY_STORE:join(root,'ordinary-policies'),
  FINNOR_S3_MODEL_STORE:join(root,'ordinary-models'),
 }});
 const stop=()=>{
  const rows=execFileSync('ps',['-axo','pid=,ppid='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
  const owned=new Set([child.pid]);for(let i=0;i<rows.length;i++){const size=owned.size;for(const [pid,parent] of rows)if(owned.has(parent))owned.add(pid);if(size===owned.size)break;}
  for(const pid of [...owned].reverse())if(pid)try{process.kill(pid,'SIGKILL');}catch{}
 };
 const timer=setTimeout(()=>{timedOut=true;stop();},180000);
 for(const stream of [child.stdout!,child.stderr!])stream.on('data',chunk=>{
  bytes+=chunk.length;if(bytes>64*1024*1024){stop();return;}
  logs=logs.then(()=>appendFile(join(root,'runner.log'),chunk,{mode:0o600}));
 });
 let code:number|null=null,signal:string|null=null;
 try{await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',(exit,s)=>{code=exit;signal=s;resolve();});});}
 finally{clearTimeout(timer);await logs;}
 await writeFile(join(root,'execution.json'),JSON.stringify({argv,exitCode:code,signal,timedOut,elapsedMs:performance.now()-began,
  outputBytes:bytes,protectedAuthorityCreated:false},null,2)+'\n',{flag:'wx',mode:0o600});
 assert.equal(code,0,'Actual selected authenticated S6 owner driver must complete');assert.equal(timedOut,false);
 const report=JSON.parse(await readFile(join(root,'results.json'),'utf8'));
 const expected=['actual-upstream-handoff-and-one-native-responsibility',...selected];
 assert.deepEqual(report.results.map((row:any)=>row.id).sort(),expected.sort());
 assert.ok(report.results.every((row:any)=>row.status==='PASS'));
 const auth=JSON.parse(await readFile(join(root,'authentication-boundary.json'),'utf8'));
 assert.equal(auth.authDevBypass,'0');assert.equal(auth.actualBearerHTTP,true);
 assert.ok(auth.traffic.some((event:any)=>event.bearer===true&&event.status===200));
 for(const pin of pins)assert.equal(createHash('sha256').update(await readFile(join(input.repo,pin.path))).digest('hex'),pin.sha256);
 input.results.push({id:'C-S6-prepared-unadmitted-and-egress-protocol-guards',status:'PASS',observed:{cases:report.results.map((row:any)=>({id:row.id,status:row.status})),
  elapsedMs:performance.now()-began,actualBearerHTTP:true,authDevBypass:false,protectedDispatchEstablished:false},
  basis:'ACTUAL_AUTHENTICATED_S1_S3_S4_S5_S6_PREPARATION_NATIVE_INTENT_AND_EXACT_EGRESS_PROTOCOL_REFUSALS'});
}

import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {isAbsolute,join,resolve} from 'node:path';
import {verifyInstalledAssets} from './installed-assets.mjs';

const args=process.argv.slice(2),options=new Map();
for(let i=0;i<args.length;i+=2){
 const key=args[i],value=args[i+1];
 if(!['--runtime','--evidence'].includes(key)||options.has(key)||!value||!isAbsolute(value))throw Error('Y5_INSTALLED_VERIFY_ARGUMENT');
 options.set(key,resolve(value));
}
const runtime=options.get('--runtime'),evidence=options.get('--evidence');
if(!runtime||!evidence||existsSync(evidence)||realpathSync(runtime)!==runtime||
 evidence===runtime||evidence.startsWith(runtime+'/'))throw Error('Y5_INSTALLED_VERIFY_NEW_EVIDENCE_REQUIRED');
mkdirSync(evidence,{mode:0o700});
const save=(name,value)=>writeFileSync(join(evidence,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
const started=Date.now(),os=join(runtime,'finnor-os'),ownerEvidence=join(evidence,'owner');
const command=[process.execPath,'--import=tsx',join(os,'scripts/postx/y5/verify-total-owner.mts'),'--built-api','--installed-worker'];
save('registered-input.json',{runtime,command,cwd:os,ownerEvidence,
 predicate:'EXACT_INSTALLED_ASSETS_ACTUAL_BUILT_HTTP_EMITTED_WORKER_TWO_TYPED_USES_UNDER_ORIGINAL_DEADLINES',
 completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,protectedAdmission:false});
try{
 const before=verifyInstalledAssets(runtime);save('installed-assets-before.json',before);
 const result=spawnSync(command[0],command.slice(1),{cwd:os,encoding:'utf8',timeout:900000,maxBuffer:4194304,
  env:{...process.env,FINNOR_Y5_EVIDENCE_DIR:ownerEvidence,
   FINNOR_Y5_TOOLCHAIN_ROOT:join(runtime,'.y5-tools/lean-4.34.1-darwin_aarch64'),
   FINNOR_Y5_TOTAL_MODEL_ROOT:join(runtime,before.totalModel.root),
   FINNOR_S3_PYTHON:join(runtime,'.y5-tools/numerics/bin/python')}});
 save('owner-process.json',{status:result.status,signal:result.signal,error:result.error?String(result.error):null,stdout:result.stdout,stderr:result.stderr});
 assert.equal(result.status,0,result.stderr);
 const owner=JSON.parse(readFileSync(join(ownerEvidence,'results.json'),'utf8'));
 assert.equal(owner.status,'PASS');assert.equal(new Set(owner.checkedUses).size,2);
 const http=readFileSync(join(ownerEvidence,'http.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 const calls=http.filter(row=>row.path.startsWith('/api/uniform-algorithms/'));
 assert(calls.length>0&&calls.every(row=>row.transport==='ACTUAL_BUILT_NEXT_API'));
 assert(calls.some(row=>row.path.endsWith('/submit-total')&&row.status===202));
 const uses=calls.filter(row=>row.path.endsWith('/consume-total')&&row.status===200&&row.output.status==='CHECKED');
 assert.equal(new Set(uses.map(row=>row.output.digest)).size,2);
 assert(uses.every(row=>row.elapsedMs<28500&&row.output.actualMethod==='Y5_SAME_LEAN_TOTAL_DEFINITION'));
 const after=verifyInstalledAssets(runtime);assert.deepEqual(after,before);
 save('installed-assets-after.json',after);
 save('results.json',{status:'PASS',wallMs:Date.now()-started,scope:'INSTALLED_PUBLIC_V2_BUILT_HTTP_AND_EMITTED_WORKER_NOT_PROTECTED',
  checkedUses:owner.checkedUses,httpCheckedUseMs:uses.map(row=>row.elapsedMs),totalModel:before.totalModel,
  retainedV1DeadlineFailure:'UNCHANGED_NOT_FORGIVEN',completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,
  rerun:command,protectedAdmission:false,executionAuthorityGranted:false});
 console.log(JSON.stringify({status:'PASS',evidence}));
}catch(error){
 save('failure.json',{status:'FAIL',wallMs:Date.now()-started,error:String(error),stack:error.stack,
  installedHttpVerified:false,evidenceRetained:true});throw error;
}

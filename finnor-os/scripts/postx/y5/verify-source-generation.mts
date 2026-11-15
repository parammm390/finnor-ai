import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=resolve(import.meta.dirname,'../../../..'),os=join(root,'finnor-os');
const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??join(root,'evidence/y5-source-generation'));
await mkdir(evidence,{recursive:true,mode:0o700});
const save=(name:string,value:unknown)=>writeFile(join(evidence,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const source=await readFile(join(os,'scripts/postx/y5/generate-source.mts'));
await save('registered-input.json',{sourceDigest:createHash('sha256').update(source).digest('hex'),
 baseline:process.argv.includes('--baseline'),scope:'ACTUAL_SOURCE_GENERATOR_NOT_KERNEL_OR_INSTALLED_VERIFICATION'});
const run=(args:string[])=>{
 const command=['--import=tsx',join(os,'scripts/postx/y5/generate-source.mts'),...args];
 const r=spawnSync(process.execPath,command,{cwd:os,env:{...process.env,NODE_OPTIONS:'--max-old-space-size=768'},
  encoding:'utf8',timeout:30000,maxBuffer:1048576});
 return {command,exitCode:r.status,signal:r.signal,stdout:r.stdout,stderr:r.stderr};
};
const generated=run([]);await save('generation.json',generated);
if(process.argv.includes('--baseline')){
 assert.notEqual(generated.exitCode,0);
 assert(generated.stderr.includes('Y5_SOURCE_IMPORT_UNRESOLVED:next-env.d.ts:./.next/types/routes.d.ts'));
 await save('results.json',{status:'EXPECTED_BASELINE_FAILURE',generated});
}else{
 assert.equal(generated.exitCode,0,generated.stderr);
 const checked=run(['--check']);await save('check.json',checked);assert.equal(checked.exitCode,0,checked.stderr);
 const {currentUniformEnvironment}=await import('../../../packages/private-equity/src/uniform-algorithms/source-cut');
 const current=await currentUniformEnvironment(),paths=current.files.map(f=>f.path);
 for(const path of ['next-env.d.ts','finnor-os/apps/api/next-env.d.ts'])assert(!paths.includes(path));
 for(const path of ['finnor-os/packages/private-equity/src/allocation-total-episodes.ts',
  'finnor-os/packages/private-equity/src/allocation-total-task.ts',
  'finnor-os/packages/epistemic-runtime/src/uniform-algorithms/native-sandbox.sb',
  'finnor-os/packages/private-equity/src/uniform-algorithms/total-admission.ts'])assert(paths.includes(path));
 await save('results.json',{status:'PASS',sourceDigest:current.sourceDigest,files:paths.length,
  generated,checked,scope:'COMPLETE_CURRENT_SOURCE_CLOSURE_NOT_RUNTIME_OR_PROTECTED_QUALIFICATION'});
}
console.log(JSON.stringify({status:process.argv.includes('--baseline')?'EXPECTED_BASELINE_FAILURE':'PASS',evidence}));

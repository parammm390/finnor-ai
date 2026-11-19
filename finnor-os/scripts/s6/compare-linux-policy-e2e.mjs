/** Actual Linux kernel comparison. No jail installation or privilege changes. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join,isAbsolute} from 'node:path';
import {createRequire} from 'node:module';

assert.equal(process.platform,'linux');
assert.notEqual(process.getuid(),0);
assert.equal(process.version,'v22.22.3');
const output=process.argv[2];assert(output&&isAbsolute(output));
await mkdir(output,{mode:0o700});
const root=resolve(import.meta.dirname,'../..');
const policy=join(root,'packages/governed-execution/src/linux-node-policy.ts');
const fixed=await readFile(policy);
const hash=value=>createHash('sha256').update(value).digest('hex');
const base='df9111da8c7a1170f1f074e43fdf5984eaa55b8b';
const path='finnor-os/packages/governed-execution/src/executor-linux.ts';
const original=execFileSync('git',['show',`${base}:${path}`],{cwd:root,encoding:'utf8'});
const require=createRequire(import.meta.url),ts=require('typescript');
const parsed=ts.createSourceFile(path,original,ts.ScriptTarget.Latest,true);
const functions=parsed.statements.filter(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='nodeFilter');
assert.equal(functions.length,1,'Exact original production policy function required');
const before=Buffer.from('export '+functions[0].getText(parsed)+'\n');
const record={schema:'finnor.s6.kernel-policy-comparison.v1',status:'RUNNING',base,
  classification:'KERNEL_POLICY_COMPONENT_COMPARISON_NOT_INSTALLED_JAIL_OR_W_OWNING_PROOF',
  beforeRecipe:'Original production nodeFilter function body; export prefix only; current unchanged native harness',
  originalSourceSha256:hash(original),beforePolicySha256:hash(before),fixedPolicySha256:hash(fixed),
  actualNode:process.version,commands:[]};
const save=()=>writeFile(join(output,'comparison.json'),JSON.stringify(record,null,2)+'\n');
const run=name=>{
  const destination=join(output,name),args=['--import=tsx','scripts/s6/run-linux-policy-e2e.mts',destination];
  const child=spawnSync(process.execPath,args,{cwd:root,env:process.env,encoding:'utf8',timeout:150000,maxBuffer:2*1024*1024});
  record.commands.push({name,command:[process.execPath,...args],status:child.status,signal:child.signal,
    error:child.error?.message,stdout:child.stdout,stderr:child.stderr});
  return {child,destination};
};
try{
  await writeFile(policy,before);
  const baseline=run('before');
  assert.equal(hash(await readFile(policy)),hash(before),'Baseline source drift');
  const observed=JSON.parse(await readFile(join(baseline.destination,'results.json'),'utf8'));
  const unlink=observed.results.find(row=>row.name==='mq-unlink');
  assert.equal(baseline.child.status,1,'The original policy must fail the unchanged required defenses');
  assert.equal(unlink?.status,'FAIL');
  assert.equal(unlink.observed.value.errno,0,'The exact original policy must permit the owned unlink');
  assert.equal(unlink.observed.value.before.posixQueue.named,1);
  assert.equal(unlink.observed.value.after.posixQueue.named,0);
  assert.equal(observed.results.find(row=>row.name==='node-startup-private-io-crypto-worker')?.status,'PASS');
  record.beforeRegressionEstablished=true;
  await writeFile(policy,fixed);
  const repaired=run('after');
  assert.equal(hash(await readFile(policy)),hash(fixed),'Repaired source drift');
  const after=JSON.parse(await readFile(join(repaired.destination,'results.json'),'utf8'));
  assert.equal(repaired.child.status,0,repaired.child.stderr);
  assert.equal(after.status,'PASS');
  assert.equal(after.results.find(row=>row.name==='original-task-guard-threaded-reexec-escape')?.status,'PASS');
  assert.equal(after.results.find(row=>row.name==='trusted-guardian-threaded-reexec-lifetime')?.status,'PASS');
  record.status='PASS';
}catch(error){record.status='FAIL';record.error=String(error);}
finally{
  const actual=await readFile(policy);
  assert([hash(before),hash(fixed)].includes(hash(actual)),'Do not overwrite an unexpected external source edit');
  await writeFile(policy,fixed);
  record.sourceRestored=hash(await readFile(policy))===hash(fixed);
  record.finishedAt=new Date().toISOString();await save();
}
console.log(JSON.stringify({status:record.status,output,sourceRestored:record.sourceRestored}));
if(record.status!=='PASS')process.exitCode=1;

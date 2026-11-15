import assert from 'node:assert/strict';
import {mkdir,readdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {native,type ToolIdentity} from '../../../packages/epistemic-runtime/src/uniform-algorithms/native';
const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??'../evidence/y5-native-arguments');
await mkdir(evidence,{recursive:true,mode:0o700});
const tool:ToolIdentity={root:join(evidence,'deliberately-absent-tool'),archiveDigest:'0'.repeat(64),
 inventoryDigest:'0'.repeat(64),identityDigest:'0'.repeat(64)};
const requests=[[],['--help'],['--version'],['Candidate','Total'],['Init'],['../Candidate'],[''],
 ['Candidate'],['Total']];
const observed:unknown[]=[];
for(const [index,args] of requests.entries()){
 const scratch=join(evidence,'case-'+index);
 await assert.rejects(native(tool,['leanchecker',...args],{scratch,deadlineAt:Date.now()+5000},'refused'),
  {message:'Y5_NATIVE_REPLAY_ARGUMENT'});
 assert(!(await readdir(scratch)).some(name=>name.endsWith('.started.json')));
 observed.push({args,status:'REFUSED_BEFORE_NATIVE_START'});
}
const scratch=join(evidence,'descendant');
await mkdir(join(scratch,'Candidate'),{recursive:true,mode:0o700});
await writeFile(join(scratch,'Candidate.olean'),'PUBLIC_INVALID_OLEAN_NOT_EXECUTED',{mode:0o600});
await assert.rejects(native(tool,['leanchecker','Candidate'],{scratch,deadlineAt:Date.now()+5000},'refused'),
 {message:'Y5_NATIVE_REPLAY_ARGUMENT'});
assert(!(await readdir(scratch)).some(name=>name.endsWith('.started.json')));
observed.push({args:['Candidate'],directoryPresent:true,status:'REFUSED_BEFORE_NATIVE_START'});
await writeFile(join(evidence,'results.json'),JSON.stringify({status:'PASS',observed,
 scope:'ACTUAL_NATIVE_COMMAND_REFUSAL_NO_RUNTIME_ASSET_OR_KERNEL_EXECUTION',
 rerun:'FINNOR_Y5_EVIDENCE_DIR=<fresh> node_modules/.bin/tsx scripts/postx/y5/verify-native-arguments.mts'},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({status:'PASS',evidence,cases:observed.length}));

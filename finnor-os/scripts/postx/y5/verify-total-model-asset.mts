import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,copyFile,symlink,readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {toolIdentity} from '../../../packages/epistemic-runtime/src/uniform-algorithms/native';
import {installTotalModel,totalModelPath} from '../../../packages/epistemic-runtime/src/uniform-algorithms/total/proof';
import {hash} from '../../../packages/epistemic-runtime/src/uniform-algorithms/syntax';

const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??'../evidence/y5-total-model-asset');
await mkdir(evidence,{recursive:true,mode:0o700});
const started=Date.now(),observed:unknown[]=[],before=process.env.FINNOR_Y5_TOTAL_MODEL_ROOT;
const save=(name:string,value:unknown)=>writeFile(join(evidence,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
await save('registered-input.json',{scope:'PUBLIC_FROZEN_INTERPRETER_ASSET_NOT_CANDIDATE_OR_PROTECTED_ADMISSION',
 falsifiers:['unbound source','wrong object bytes','symlinked asset root','wrong runtime','missing setup provenance','silent recompilation or deadline extension']});
try{
 const assetRoot=join(evidence,'assets');
 const setup=spawnSync(process.execPath,['--import=tsx',resolve('scripts/postx/y5/prepare-total-model.mts'),'--output',assetRoot],{
  cwd:resolve('.'),env:process.env,encoding:'utf8',timeout:60000,maxBuffer:1048576});
 await save('setup-process.json',{status:setup.status,signal:setup.signal,stdout:setup.stdout,stderr:setup.stderr});
 assert.equal(setup.status,0,setup.stderr);
 process.env.FINNOR_Y5_TOTAL_MODEL_ROOT=assetRoot;
 const source=await readFile(totalModelPath,'utf8'),sourceDigest=hash(source),tool=await toolIdentity(Date.now()+30000),
  budget={deadlineAt:Date.now()+30000,scratch:join(evidence,'positive')};
 const installed=await installTotalModel(source,tool,budget);
 assert.equal(installed.native.length,1);assert.equal(installed.native[0]!.command[0],'leanchecker');
 assert.equal(installed.native[0]!.exitCode,0);
 assert.equal(installed.sourceCorrespondence,'FROZEN_SOURCE_COMPILED_PIN_REHASHED_AND_REPLAYED');
 observed.push({case:'matching owned asset',status:'REPLAYED',model:installed});
 const reject=async(label:string,root:string,body=source,identity=tool)=>{
  process.env.FINNOR_Y5_TOTAL_MODEL_ROOT=root;
  const scratch=join(evidence,'reject-'+observed.length);
  await assert.rejects(()=>installTotalModel(body,identity,{deadlineAt:Date.now()+30000,scratch}));
  const files=await readdir(scratch).catch(()=>[]);
  assert(!files.some(name=>name.endsWith('.started.json')),'Invalid asset must refuse before native launch');
  observed.push({case:label,status:'REJECTED_BEFORE_NATIVE'});
 };
 await reject('changed source',assetRoot,source+'\n');
 await reject('wrong runtime',assetRoot,source,{...tool,inventoryDigest:'0'.repeat(64)});
 await reject('missing asset',join(evidence,'missing'));
 const poisonRoot=join(evidence,'poison'),poison=join(poisonRoot,sourceDigest);
 await mkdir(poison,{recursive:true});
 await copyFile(join(assetRoot,sourceDigest,'setup.json'),join(poison,'setup.json'));
 const bytes=await readFile(join(assetRoot,sourceDigest,'Total.olean')),last=bytes.length-1;bytes[last]=bytes[last]!^1;
 await writeFile(join(poison,'Total.olean'),bytes);
 await reject('changed object',poisonRoot);
 const unreceiptedRoot=join(evidence,'no-receipt'),unreceipted=join(unreceiptedRoot,sourceDigest);
 await mkdir(unreceipted,{recursive:true});
 await copyFile(join(assetRoot,sourceDigest,'Total.olean'),join(unreceipted,'Total.olean'));
 await reject('missing setup provenance',unreceiptedRoot);
 const alias=join(evidence,'asset-root-symlink');await symlink(assetRoot,alias);
 await reject('symlinked asset root',alias);
 await save('results.json',{status:'PASS',wallMs:Date.now()-started,observed,
  scope:'PUBLIC_PINNED_INTERPRETER_REPLAY_AND_PRELAUNCH_REFUSALS_NOT_SANDBOX_OR_INDEPENDENT_COST_QUALIFICATION',
  completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null,
  rerun:'FINNOR_Y5_EVIDENCE_DIR=<new-directory> node_modules/.bin/tsx scripts/postx/y5/verify-total-model-asset.mts'});
 console.log(JSON.stringify({status:'PASS',evidence,wallMs:Date.now()-started}));
}catch(error){await save('failure.json',{status:'FAIL',error:String(error),stack:(error as Error).stack,observed});throw error;}
finally{if(before===undefined)delete process.env.FINNOR_Y5_TOTAL_MODEL_ROOT;else process.env.FINNOR_Y5_TOTAL_MODEL_ROOT=before;}

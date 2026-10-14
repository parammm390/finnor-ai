/** Finite public storage verification. Real transport and administrator runs
 * are distinct from the synthetic encoding horizon. No qualification is issued. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exerciseLiveStorage} from './qualification-live-storage-cases.mjs';
import {exerciseStorageResume} from './qualification-storage-resume-cases.mjs';
import {exerciseStorageHorizon} from './qualification-journal-horizon-cases.mjs';
import {exerciseAdminOutput} from './qualification-admin-output-cases.mjs';
const repo=fileURLToPath(new URL('../../../../',import.meta.url)),[root,publicCorpus]=process.argv.slice(2);
assert.ok(root?.startsWith('/')&&publicCorpus?.startsWith('/'),'Fresh private storage evidence and prior full public corpus required');
await mkdir(root,{mode:0o700});
const sha=b=>createHash('sha256').update(b).digest('hex'),began=performance.now();
const files=['qualification-runtime.mts','qualification-state-journal.mts','qualification-admin.mts',
 'qualification-observation-collection.mts','qualification-live-storage-cases.mjs','qualification-storage-resume-cases.mjs',
 'qualification-journal-horizon-cases.mjs','qualification-admin-output-cases.mjs','qualification-storage-cases.mjs'];
const pins=await Promise.all(files.map(async path=>({path,sha256:sha(await readFile(join(repo,'finnor-os/scripts/frontier5/x1',path)))})));
await writeFile(join(root,'freeze.json'),JSON.stringify({sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),
 sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:repo,encoding:'utf8'}).trim(),pins,publicCorpus,
 runtime:process.version,limits:{wallSeconds:180,nodeHeapMiB:768,outputBytes:64*1024*1024},
 publicTransportAndRFC8032FixturesOnly:true,actualBusinessCompletion:false,protectedQualification:false,actualElapsedLiveDaysObserved:0},null,2)+'\n',{flag:'wx',mode:0o600});
const physical=await exerciseLiveStorage({repo,root:join(root,'physical')});
assert.equal(physical.receipt.status,'PASS_FINITE_PHYSICAL_STORAGE_PROBE');
const resume=await exerciseStorageResume({repo,previous:physical.evidenceRoot,root:join(root,'resume')});
const horizon=await exerciseStorageHorizon({repo,root:join(root,'horizon')});
const admin=await exerciseAdminOutput({repo,corpusRoot:publicCorpus,root:join(root,'admin-existing'),bootstrap:true});
const initial=await exerciseAdminOutput({repo,corpusRoot:publicCorpus,root:join(root,'admin-initial'),bootstrap:false});
assert.ok([resume,horizon,admin,initial].every(r=>r.receipt.status.startsWith('PASS')));
for(const pin of pins)assert.equal(sha(await readFile(join(repo,'finnor-os/scripts/frontier5/x1',pin.path))),pin.sha256,'frozen source '+pin.path);
const size=async path=>{let bytes=0;for(const e of await readdir(path,{withFileTypes:true})){const full=join(path,e.name);bytes+=e.isDirectory()?await size(full):(await stat(full)).size;}return bytes;};
const outputBytes=await size(root);assert.ok(outputBytes<64*1024*1024);assert.ok(performance.now()-began<180000);
const result={status:'PASS_FINITE_PUBLIC_STORAGE_AND_ADMIN_CONTRACT',physicalHTTPCalls:physical.receipt.actualPhysicalCalls,
 resumeHTTPCalls:resume.receipt.resumeActualCalls,encodedSyntheticProbes:horizon.receipt.syntheticProbeCount,
 syntheticHorizonBytes:horizon.receipt.chargedOutputBytes,actualAdminCommands:4,outputBytes,elapsedMs:performance.now()-began,
 original64MiBLimitsRetained:true,frozenSourceUnchanged:true,actualBusinessCompletion:false,actualElapsedLiveDaysObserved:0,
 protectedQualification:false,moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null};
await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(result));

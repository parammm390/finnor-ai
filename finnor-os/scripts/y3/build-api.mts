/** Run the existing canonical API build and bind its emitted bytes to the
 * complete source preimages. A copied old .next tree is not an installed proof. */
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {sourceCut,emittedFiles} from './runtime-custody.mjs';
const repo=resolve(import.meta.dirname,'../../..'),backend=join(repo,'finnor-os');
assert.equal(process.env.FINNOR_Y3_ALLOW_DISK_HEAVY_VERIFICATION,'1','EXPLICIT_DISK_HEAVY_VERIFICATION_OPT_IN_REQUIRED');
const before=await sourceCut(),started=performance.now();assert.equal(before.dirty,false,'COMMITTED_BUILD_PREIMAGES_REQUIRED');
const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,
 NODE_ENV:'production',NODE_OPTIONS:'--max-old-space-size=4096',NEXT_TELEMETRY_DISABLED:'1'};
const built=spawnSync('npm',['run','build','--workspace','@finnor/api'],{cwd:backend,env,stdio:'inherit',timeout:900000});
assert.equal(built.status,0,'Y3_EMITTED_API_BUILD_FAILED');
const source=await sourceCut();assert.equal(source.preimageDigest,before.preimageDigest,'Y3_SOURCE_CHANGED_DURING_API_BUILD');
assert.equal(source.head,before.head);assert.equal(source.dirty,false,'REGENERATE_AND_COMMIT_SOURCE_STAMPS_BEFORE_BUILDING');
const root=join(backend,'apps/api/.next'),files=await emittedFiles(root,new Set(['y3-build-receipt.json'])),
 receipt={schema:'finnor.y3.emitted-api-build.v1',source,node:process.version,files,
  buildId:(await readFile(join(root,'BUILD_ID'),'utf8')).trim(),wallMs:performance.now()-started,
  protectedQualification:false,productionActivated:false};
await writeFile(join(root,'y3-build-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
console.log('Y3_EMITTED_API_SOURCE_RECEIPT',receipt.buildId,source.preimageDigest);

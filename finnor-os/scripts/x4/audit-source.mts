/** Release-file boundary audit. This checks raw source custody in the actual
 * emitted route trace, not just source-tree availability on the build host. */
import {strict as assert} from 'node:assert';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFile,stat} from 'node:fs/promises';
import {dirname,relative,resolve,join} from 'node:path';
import {IDENTIFICATION_SOURCE_PATHS} from '../../packages/private-equity/src/system-identification/source-paths';
import manifest from '../../packages/private-equity/src/system-identification/source-manifest.generated';
import {identifiedSystemSourcePaths} from '../../packages/capability-evolution/src/source-closure';
import {artifact,repo} from '../x3/environment.mts';

const evidence=resolve(process.env.FINNOR_X4_EVIDENCE_DIR??join(repo,'scope-x4/evidence/source-audit-'+Date.now()));
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const closure=await identifiedSystemSourcePaths();
const paths=[...new Set([...closure,...IDENTIFICATION_SOURCE_PATHS.map(p=>resolve(repo,p)),
 'finnor-os/packages/private-equity/src/system-identification/source-manifest.generated.ts',
 'finnor-os/apps/api/lib/auth.ts','finnor-os/packages/source-custody/index.cjs',
 'finnor-os/tsconfig.json','finnor-os/tsconfig.base.json','finnor-os/package-lock.json','package-lock.json',
].map(p=>resolve(repo,p)))].sort();
const files=await Promise.all(paths.map(async path=>({path:relative(repo,path),sha256:sha(await readFile(path)),bytes:(await stat(path)).size})));
const stampMismatches=manifest.files.filter(pin=>files.find(f=>f.path===pin.path)?.sha256!==pin.sha256);
const tracePath=resolve(repo,'finnor-os/apps/api/.next/server/app/api/company-brain/[operation]/route.js.nft.json');
const trace=JSON.parse(await readFile(tracePath,'utf8')),traced=new Set<string>(trace.files.map((p:string)=>resolve(dirname(tracePath),p)));
const missingTrace=paths.filter(path=>!traced.has(path)).map(path=>relative(repo,path));
const nativeRequire=createRequire(import.meta.url),native=nativeRequire('fs-ext');
const buildId=(await readFile(resolve(repo,'finnor-os/apps/api/.next/BUILD_ID'),'utf8')).trim();
const report={schema:'finnor.x4.release-source-audit.v1',allPassed:stampMismatches.length===0&&missingTrace.length===0&&closure.length<=256&&typeof native.flock==='function',
 buildId,scientificClosureCount:closure.length,scientificClosureCap:256,genericAllocationClosureCapUnchanged:128,files,stampMismatches,missingTrace,
 traceFile:relative(repo,tracePath),traceDigest:sha(await readFile(tracePath)),tracedFileCount:traced.size,
 scientificInterpreter:{source:'finnor-os/packages/private-equity/src/system-identification/core-child.mts',emitted:'finnor-os/packages/private-equity/src/system-identification/core-child.generated.mjs',
  regenerationCheck:'node --import=tsx scripts/x4/stamp-source.mts --check'},
 runtime:{node:process.version,abi:process.versions.modules,platform:process.platform,architecture:process.arch,nativeFlockLoaded:typeof native.flock==='function'},
 limits:{containerBuilt:false,arm64Executed:false,protectedCustody:false,productionActivation:false}};
await artifact(evidence,'release-source-audit.json',report);
console.log('X4_RELEASE_SOURCE_AUDIT',JSON.stringify({allPassed:report.allPassed,buildId,closureCount:closure.length,missingTrace,stampMismatches}));
assert(report.allPassed,'X4_RELEASE_SOURCE_AUDIT_FAILED');

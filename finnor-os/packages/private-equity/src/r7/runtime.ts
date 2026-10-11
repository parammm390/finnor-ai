import { readFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bytesHash, atlasHash } from '../../../epistemic-runtime/src/policy-atlas/exact';
import { R7Error } from './contracts';

const osRoot=fileURLToPath(new URL('../../../../',import.meta.url));
const repoRoot=fileURLToPath(new URL('../../../../../',import.meta.url));
export const r7CheckerPath=fileURLToPath(new URL('../../../epistemic-runtime/src/policy-atlas/checker.py',import.meta.url));
export const r7Python=()=>process.env.FINNOR_R7_PYTHON??'/usr/bin/python3';
export const R7_ADOPTION_BASE=Object.freeze({
  commit:'4a90ed33ca96afa252c51f511fea279e0034cddb',
  tree:'310a43fa2b7983bf33afc321795461c9678ce7f9',
});
async function identity(){
  const directories=['packages/private-equity/src/r7','packages/epistemic-runtime/src/policy-atlas'];
  const paths=(await Promise.all(directories.map(async d=>(await readdir(osRoot+d)).filter(p=>/\.(?:ts|mts|mjs|py)$/.test(p)).map(p=>d+'/'+p)))).flat();
  paths.push('packages/shared-types/src/decision-atlas.ts','packages/private-equity/src/enterprise-control.ts',
    'packages/private-equity/src/enterprise-allocation.ts','packages/private-equity/src/allocation-store.ts',
    'packages/epistemic-runtime/src/allocation-contracts.ts','packages/epistemic-runtime/src/allocation-checker.ts',
    'packages/epistemic-runtime/src/experiment-numerics.ts','packages/private-equity/src/enterprise-beliefs.ts',
    'packages/private-equity/src/live-recompilation/contracts.ts',
    'packages/db/compute-contract.ts','packages/db/migration-head.ts','packages/db/migrations-bundle.ts',
    'apps/worker/src/queue.ts','package-lock.json');
  const files=await Promise.all(paths.sort().map(async path=>({path,sha256:bytesHash(await readFile(osRoot+path))})));
  // Missing serial integration is part of identity, never a guessed migration.
  // Actual installed schema currentness is independently checked by the owner.
  const route='apps/api/app/api/decision-atlases/[operation]/route.ts';
  try{files.push({path:route,sha256:bytesHash(await readFile(osRoot+route))});}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;files.push({path:route,sha256:'NOT_INTEGRATED'});}
  const pythonPath=await realpath(r7Python()),pythonDigest=bytesHash(await readFile(pythonPath));
  const checkerDigest=bytesHash(await readFile(r7CheckerPath)),nodeDigest=bytesHash(await readFile(process.execPath));
  return {digest:atlasHash({files,pythonDigest,nodeDigest,rootLock:bytesHash(await readFile(repoRoot+'package-lock.json'))}),
    files,pythonDigest,checkerDigest,nodeDigest,pythonPath,baseline:R7_ADOPTION_BASE,
    qualification:'SOURCE_NATIVE_NOT_INSTALLED_IMAGE' as const};
}
let loaded:ReturnType<typeof identity>|null=null;
/** Compare loaded production method bytes at every current owner use. */
export async function r7Identity(){
  loaded??=identity();const pinned=await loaded,current=await identity();
  if(pinned.digest!==current.digest)throw new R7Error('STALE_INPUT','Loaded R7 method/checker/runtime changed');
  return pinned;
}

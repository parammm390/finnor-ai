/** Frozen public equations, not a native owner, dispatch authority or holdout. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {runtimePath} from './runtime-paths';
import {publicProofSchedule,type CompilerFreeze} from './qualification';

export const PUBLIC_REGISTRATION_SHA256='4479bce31a46945067d88b262bcb549040c20d91b2dc57e788e6b335bda4f163';
export async function frozenPublicPopulation(compiler:CompilerFreeze){
 const path=runtimePath(import.meta.url,'../../../../../scripts/project-z/z4/supplementary-positive.v3.json',
  'finnor-os/scripts/project-z/z4/supplementary-positive.v3.json');
 const raw=await readFile(path);
 if(raw.length>8*1024**2||createHash('sha256').update(raw).digest('hex')!==PUBLIC_REGISTRATION_SHA256)
  throw Error('Z4_QUALIFICATION_PUBLIC_REGISTRATION_CHANGED');
 return publicProofSchedule(JSON.parse(raw.toString()),compiler);
}

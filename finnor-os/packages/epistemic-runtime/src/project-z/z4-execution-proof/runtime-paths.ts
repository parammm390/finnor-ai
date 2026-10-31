/** Bundled source URLs must not select an old build checkout after extraction. */
import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function runtimePath(moduleUrl:string,sourceRelative:string,installedRelative:string){
 const root=(globalThis as unknown as Record<symbol,unknown>)[Symbol.for('finnor.z4.declared-runtime-root')];
 const source=fileURLToPath(moduleUrl),candidate=resolve(dirname(source),sourceRelative);
 if(root===undefined)return candidate;
 if(typeof root!=='string'||!isAbsolute(root))throw Error('Z4_DECLARED_RUNTIME_ROOT_REQUIRED');
 const fromRoot=relative(root,source);
 const actualSource=/\/src\/project-z\/z4-execution-proof\/[^/]+\.ts$/.test(source);
 return actualSource&&fromRoot!=='..'&&!fromRoot.startsWith('../')&&!isAbsolute(fromRoot)
  ?candidate:resolve(root,installedRelative);
}

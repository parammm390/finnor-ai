import {createRequire} from 'node:module';
import {dirname,relative,sep,resolve} from 'node:path';

/** The same actual dependency common root used by this installed Next config.
 * No machine username, checkout basename or external path is assumed. */
export function frontendTracingLayout(repo){
  const projectRoot=resolve(repo),nextPackagePath=createRequire(import.meta.url).resolve('next/package.json');
  const nextRoot=dirname(nextPackagePath);let tracingRoot=projectRoot;
  while(relative(tracingRoot,nextRoot)==='..'||relative(tracingRoot,nextRoot).startsWith('..'+sep)){
    const parent=dirname(tracingRoot);if(parent===tracingRoot)throw Error('X1_FRONTEND_DEPENDENCY_COMMON_ROOT_UNAVAILABLE');
    tracingRoot=parent;
  }
  return {tracingRoot,projectPath:relative(tracingRoot,projectRoot),nextPackagePath};
}

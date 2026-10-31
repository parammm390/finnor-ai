import {registerHooks} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const original=pathToFileURL(resolve(repository,'finnor-os/packages/epistemic-runtime/src/project-z/z4-execution-proof/original.ts')).href;
const source=`
export function originalExecution(){
 const key=Symbol.for('finnor.z4.no-replay-interpreter-trap');
 globalThis[key]=(globalThis[key]??0)+1;
 throw Error('Z4_NO_REPLAY_INTERPRETER_TRAP_CALLED');
}
`;
registerHooks({
 load(url,context,nextLoad){
  if(url===original)return {format:'module',source,shortCircuit:true};
  return nextLoad(url,context);
 },
});

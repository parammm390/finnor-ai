/** P1 executable/checker boundary shared with P2. P2 never evaluates an alternate
 * business objective or upgrades a model answer into a checked candidate. */
import type {NativeModule,HarnessRequest,HarnessValue} from './contracts';
import {executeNativeModule} from './native';
import {executeTypeScriptModule} from './typescript';
import {stable} from '../evidence-execution/store';
export async function executeHarnessCandidate(module:NativeModule,request:HarnessRequest,input:Record<string,string>,d:any,meter:()=>void,deadlineAt:number,onIsolatedReceipt:(receipt:any)=>Promise<void>) {
 const output=executeNativeModule(module,input,meter);meter();
 const isolated=await executeTypeScriptModule(module,input,deadlineAt-Date.now());
 await onIsolatedReceipt(isolated);
 if(!isolated.outputs||stable(isolated.outputs)!==stable(output))throw Error('ISOLATED_NATIVE_OUTPUT_DISAGREEMENT');
 const values:Record<string,HarnessValue>={};
 for(const target of request.acceptance.targets){
  const leaf=(e:any):string|null=>e.kind==='input'?e.key:e.kind==='if'?leaf(e.condition.left)??leaf(e.condition.right)??leaf(e.whenTrue)??leaf(e.whenFalse):e.left?leaf(e.left)??leaf(e.right):null;
  const source=d.result.outputs[leaf(target.expression)??''];if(!source?.semantics)throw Error('OUTPUT_SOURCE_SEMANTICS_UNAVAILABLE');
  values[target.key]={value:output[target.key]!,semantics:{...source.semantics,unit:target.unit,currencyCode:target.currencyCode,scale:'1',sign:'AS_RECORDED'},truthClass:'DERIVED_VALUE',witnessIds:d.witnesses.map((w:any)=>w.id)};
 }
 return {moduleId:module.id,values,isolated};
}

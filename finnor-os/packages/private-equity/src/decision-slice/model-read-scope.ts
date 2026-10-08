/** Additive M1 model-evidence read contract. It never applies to decision consumption. */
import {AsyncLocalStorage} from 'node:async_hooks';
export interface ModelReadCut {tenantId:string;principalId:string;workId:string;workInputId:string;programId:string}
const read=new AsyncLocalStorage<ModelReadCut>();
export const withModelReadCut=<T>(cut:ModelReadCut,invoke:()=>Promise<T>):Promise<T>=>read.run(cut,invoke);
export function permitsCompletedModelRead(cut:Omit<ModelReadCut,'programId'>){const current=read.getStore();return !!current&&Object.entries(cut).every(([k,v])=>current[k as keyof ModelReadCut]===v);}

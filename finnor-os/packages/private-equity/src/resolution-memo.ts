import {AsyncLocalStorage} from 'node:async_hooks';
import {epistemicHash} from '../../epistemic-runtime/src/source-precedence';
import type {PeMutationContext} from './types';

interface Shared{outcome:Promise<unknown>;compute:()=>Promise<unknown>;passed:boolean}
const scope=new AsyncLocalStorage<Map<string,Shared>>();

/** An owner resolution re-reads the same pinned S1 cuts, policy sources and resource rights once for every historical
 * record that cites them. Inside this scope an identical read-only visibility check runs once and its outcome,
 * refusal included, is shared with the repeats. Some inputs of these checks are not covered by the source-revision
 * fence (a later observation that ties evidence to a withdrawn source scope is one), so the resolution must call
 * recheckSharedWithinResolution() before its closing transaction. The memo ends with the callback and is never kept
 * between requests. */
export function withResolutionMemo<T>(run:()=>Promise<T>):Promise<T>{
 return scope.run(new Map(),run);
}

function shareIn(memo:Map<string,Shared>,key:string,compute:()=>Promise<unknown>){
 let shared=memo.get(key);
 if(!shared){
  const created:Shared={outcome:compute(),compute,passed:false};
  created.outcome.then(()=>{created.passed=true;},()=>undefined);
  memo.set(key,created);shared=created;
 }
 return shared;
}

/** The key names the exact principal, so a check made for one principal is never reused for another, and the
 * complete content of the subject. A subject that cannot be hashed is simply not shared. */
export function sharedWithinResolution<T>(ctx:PeMutationContext,kind:string,subject:unknown,compute:()=>Promise<T>):Promise<T>{
 const memo=scope.getStore();
 if(!memo)return compute();
 let key:string;
 try{
  const {tenantId,userId,employeeId,role,deliverySession}=ctx.auth;
  key=[kind,tenantId,userId,employeeId??'',role,deliverySession?.sessionId??'',epistemicHash(subject)].join('\u0000');
 }catch{return compute();}
 return shareIn(memo,key,compute).outcome as Promise<T>;
}

/** Runs every distinct check that passed once more, in a new scope that reuses nothing from the first pass, so a change
 * after the first read that the source-revision fence cannot see is still refused when the resolution closes. A check
 * that was refused already ended the resolution or was handled by its caller, and is not run again. */
export async function recheckSharedWithinResolution():Promise<void>{
 const memo=scope.getStore();
 if(!memo)return;
 const passed=[...memo.entries()].filter(([,shared])=>shared.passed),fresh=new Map<string,Shared>();
 await scope.run(fresh,async()=>{for(const [key,shared] of passed)await shareIn(fresh,key,shared.compute).outcome;});
}

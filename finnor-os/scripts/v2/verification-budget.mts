/** A verification deadline is not permission to renew a business grant. */
export function verificationBudget(deadlineAt:number){
 if(!Number.isFinite(deadlineAt)||deadlineAt<=Date.now())throw Error('REGISTERED_VERIFICATION_DEADLINE_EXHAUSTED');
 const controller=new AbortController();
 const assertCurrent=()=>{if(controller.signal.aborted||Date.now()>=deadlineAt)throw Error('REGISTERED_VERIFICATION_DEADLINE_EXHAUSTED');};
 const schedule=()=>{const timer=setTimeout(()=>controller.abort(Error('REGISTERED_VERIFICATION_DEADLINE_EXHAUSTED')),Math.max(1,deadlineAt-Date.now()));timer.unref();return timer;};
 let timer=schedule();
 return {get deadlineAt(){return deadlineAt;},signal:controller.signal,assertCurrent,remainingMs:(maximum:number)=>{assertCurrent();return Math.max(1,Math.min(maximum,deadlineAt-Date.now()));},
  shorten:(earlier:number)=>{assertCurrent();if(!Number.isFinite(earlier)||earlier>deadlineAt)throw Error('VERIFICATION_DEADLINE_EXTENSION_REFUSED');clearTimeout(timer);deadlineAt=earlier;timer=schedule();},
  dispose:()=>clearTimeout(timer)};
}

/** Finite public diagnostics. Raw owner evidence stays in its private custody. */
const causeCodes = new Set(['ECONNREFUSED','ECONNRESET','EPIPE','ETIMEDOUT','ENOTFOUND',
  'EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET','ABORT_ERR']);
const paths = new Set(['/api/closing/resume','/api/closing/submit','/api/closing/read',
  '/api/closing/stop','/api/closing/ports','/api/allocations/validate','/api/allocations/resources']);
const signals = new Set(['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV','SIGBUS','SIGQUIT']);
const boundedMs=(value:number)=>Number.isFinite(value)&&value>=0?Math.min(1_200_000,Math.round(value)):null;
function codes(error:unknown):string[]{
  const found=new Set<string>(),seen=new Set<unknown>();
  let current=error;
  for(let depth=0;depth<6&&current&&typeof current==='object'&&!seen.has(current);depth++){
    seen.add(current);
    const row=current as {code?:unknown;cause?:unknown};
    if(typeof row.code==='string'&&causeCodes.has(row.code))found.add(row.code);
    current=row.cause;
  }
  return [...found].sort();
}
export function finiteRequestFailure(error:unknown,path:string,method:'GET'|'POST',elapsedMs:number){
  const observed=codes(error),name=error instanceof Error?error.name:null;
  return {code:name==='TimeoutError'?'OWNER_REQUEST_TIMEOUT':
    observed.length||error instanceof TypeError?'OWNER_REQUEST_TRANSPORT_FAILED':'OWNER_REQUEST_FAILED',
    path:paths.has(path)?path:null,method,elapsedMs:boundedMs(elapsedMs),causeCodes:observed};
}
export function finiteFailureObservation(error:unknown,processes:readonly {name:string;exit:unknown}[],
 request?:ReturnType<typeof finiteRequestFailure>){
  return {schema:'finnor.v3.finite-first-failure.v1',at:new Date().toISOString(),
    code:request?.code??(error instanceof Error&&error.name==='AssertionError'?'OWNER_ASSERTION_FAILED':'OWNER_RUNTIME_FAILED'),
    request:request??null,
    // Copy now. Later cleanup exits must never rewrite this causal observation.
    processes:processes.slice(0,16).map(row=>{
      const exit=row.exit&&typeof row.exit==='object'?row.exit as {code?:unknown;signal?:unknown;at?:unknown}:null;
      return {name:/^(?:api|worker(?:-\d+)?|provider|checker|broker)$/.test(row.name)?row.name:'OTHER_OWNER_PROCESS',
        exit:exit?{code:typeof exit.code==='number'&&Number.isInteger(exit.code)&&exit.code>=0&&exit.code<=255?exit.code:null,
          signal:typeof exit.signal==='string'&&signals.has(exit.signal)?exit.signal:null,
          at:typeof exit.at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(exit.at)?exit.at:null}:null};
    })};
}

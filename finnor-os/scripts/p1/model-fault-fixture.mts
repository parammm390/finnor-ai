/** Real governed HTTP adapters; diagnostic replies never qualify live inference. */
import {createServer} from 'node:http';
import {strict as assert} from 'node:assert';
export type ModelFault='counterexample'|'invalid_json'|'throttled'|'timeout'|'acceptance_rewrite'|'no_usage'|'route_fallback';
export async function withModelFaultFixture<T>(targets:any[],run:(requests:any[])=>Promise<T>,fault:ModelFault='counterexample'):Promise<T>{
 const requests:any[]=[],timers=new Set<ReturnType<typeof setTimeout>>();
 const repair=targets.map(t=>({...t,expression:{kind:'add',left:t.expression,right:{kind:'literal',value:'0',unit:t.unit,currencyCode:t.currencyCode}}}));
 const server=createServer(async(req,res)=>{try{let bytes='';for await(const b of req)bytes+=b;const body=JSON.parse(bytes);assert(['/v1/chat/completions','/deepseek/chat/completions'].includes(req.url!));requests.push({path:req.url,body,fault,qualification:'DETERMINISTIC_HTTP_FAULT_DIAGNOSTIC_NOT_MODEL_INFERENCE'});
  if((fault==='route_fallback'&&req.url==='/v1/chat/completions')||(fault==='throttled'&&requests.length===1)){res.writeHead(429,{'content-type':'application/json'});res.end(JSON.stringify({error:'Explicit local diagnostic throttling'}));return;}
  let content=JSON.stringify({targets:repair});
  if(requests.length===1&&fault==='counterexample')content=JSON.stringify({targets:targets.map(t=>t.key==='netEquity'?{...t,expression:{kind:'subtract',left:t.expression,right:{kind:'literal',value:'1',unit:'currency',currencyCode:'USD'}}}:t)});
  if(requests.length===1&&fault==='invalid_json')content='{"targets":';
  if(requests.length===1&&fault==='acceptance_rewrite')content=JSON.stringify({targets:repair.map((t,i)=>i?t:{...t,key:'rewrittenAcceptance'})});
  const send=()=>{if(!res.destroyed){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({id:'diagnostic-'+requests.length,model:'p1-diagnostic-returned',choices:[{message:{content}}],...(fault==='no_usage'?{}:{usage:{prompt_tokens:1,completion_tokens:1}})}));}};
  if(fault==='timeout'){const timer=setTimeout(send,12000);timers.add(timer);}else send();
 }catch(error){res.writeHead(500);res.end(String(error));}});
 await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();assert(address&&typeof address!=='string');
 const values={MISTRAL_API_KEY:'DISPOSABLE_LOCAL_FIXTURE_TOKEN',MISTRAL_MODEL:'p1-diagnostic-transport',MISTRAL_API_BASE_URL:'http://127.0.0.1:'+address.port+'/v1',DEEPSEEK_API_KEY:'DISPOSABLE_LOCAL_FIXTURE_TOKEN',DEEPSEEK_MODEL:'p1-diagnostic-transport',DEEPSEEK_API_BASE_URL:'http://127.0.0.1:'+address.port+'/deepseek',LLM_PROVIDER_PLANNING_CONSOLE:'mistral',LLM_FALLBACKS_PLANNING_CONSOLE:fault==='route_fallback'?'deepseek':''},old=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));Object.assign(process.env,values);
 try{return await run(requests);}finally{for(const[k,v]of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;for(const t of timers)clearTimeout(t);server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
}

export async function checkExplicitOutputProfile(tenantId:string,targets:any[]){
 return withModelFaultFixture(targets,async requests=>{
  const provider=(await import('../../packages/tools/src/llm')).resolveProviderForPurpose('planning','console');
  const base={system:'Return the provided diagnostic JSON',user:'native transport probe',json:true,tenantId,purpose:'planning',channel:'console',deadlineMs:2000};
  await provider.complete({...base,maxOutputTokens:2048} as any);assert.equal(requests.length,1);assert.equal(requests[0].body.max_tokens,2048);
  const refusals=[];for(const value of [0,-1,4097,1.5,Number.NaN,Number.POSITIVE_INFINITY]){let failure;try{await provider.complete({...base,maxOutputTokens:value} as any);}catch(error){failure=String(error);}assert(failure);refusals.push({value:String(value),failure});}
  assert.equal(requests.length,1);return {requests,refusals,qualification:'ACTUAL_GOVERNED_LOCAL_HTTP_PROTOCOL_NOT_INFERENCE'};
 });
}

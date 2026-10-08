/** Preregistered mounted product E2E. Disposable issuer, real authentication,
 * proxy, production Work/Canvas composition, owner routes and durable worker. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readdir,readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createEmployeeConversationThread} from '@finnor/db';
import {createDeal} from '@finnor/private-equity';
import {POST as s3Post} from '../../apps/api/app/api/interventions/[operation]/route';

export async function mountedCapitalChallenge(input:{
 repo:string;output:string;support:any;admin:any;queue:any;api:any;artifact:any;
}){
 const {repo,output,support,admin,queue,api,artifact}=input,steps:any[]=[],traffic:any[]=[],qualification:string[]=[];
 const b=await support.fixture('m3-browser-native',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]);
 const deal=await createDeal(b.ctx,{targetOrganizationId:b.root.entityId,name:'M3 mounted economic arrangement',
  dealLeadEmployeeId:b.principal,signedLoiAt:new Date(Date.now()-86400000),targetClosingAt:new Date(Date.now()+86400000)});
 // Creating the actual linked Deal changes S1 membership. Refit before binding
 // policies instead of reusing an earlier model under a changed owner cut.
 const fit=await api(b,'fit',{request:b.model.request},s3Post);
 assert.equal(fit.status,200);assert.equal(fit.body.status,'FITTED');b.model=fit.body.model;
 b.incumbent=await support.policy(b,'browser-base',{cash:25});
 await support.resource(b,'cash','USD','STOCK',['200','200','200']);
 const {receiveWork}=await import('@finnor/db');
 b.workId=(await receiveWork({tenantId:b.tenant,userId:b.principal,instruction:'Construct permitted economic arrangements in this Work',
  channel:'console',idempotencyKey:'m3-browser-work'})).workId;
 const thread=await createEmployeeConversationThread({tenantId:b.tenant,ownerEmployeeId:b.principal,title:'M3 economic arrangements'});
 const dealRoot={entityType:'pe_deal',entityId:String(deal.row.id)};
 await admin.query('UPDATE finnor_os.employee_conversation_threads SET active_work_id=$3,active_references=$4::jsonb WHERE tenant_id=$1 AND id=$2',
  [b.tenant,thread.id,b.workId,JSON.stringify([dealRoot])]);
 await artifact('browser/inputs.json',{profile:'DISPOSABLE_ASYMMETRIC_LOCAL_ISSUER',tenant:b.tenant,principal:b.principal,
  workId:b.workId,threadId:thread.id,dealRoot,companyRoot:b.root,incumbent:b.incumbent.ref,
  terms:['0.3'],staging:'UPFRONT_TWO_PERIOD_COMMITMENT',agreement:'COUNTERPARTY_REQUIRED'});

 const email=`m3-browser-native@s5.example.test`,{privateKey,publicKey}=await generateKeyPair('RS256'),
  jwk={...await exportJWK(publicKey),alg:'RS256',use:'sig',kid:'m3-disposable-local'};
 const token=await new SignJWT({email,role:'authenticated'}).setProtectedHeader({alg:'RS256',kid:jwk.kid})
  .setSubject(b.principal).setIssuedAt().setExpirationTime('1h').sign(privateKey);
 const issuer=createServer((req,res)=>{
  res.setHeader('access-control-allow-origin','*');res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info');
  res.setHeader('content-type','application/json');
  if(req.method==='OPTIONS'){res.end();return;}
  if(req.url?.includes('.well-known/jwks.json')){res.end(JSON.stringify({keys:[jwk]}));return;}
  res.writeHead(404);res.end('{}');
 });
 const listen=async(server:ReturnType<typeof createServer>)=>{
  await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();
  assert(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}`;
 };
 const issuerUrl=await listen(issuer),prior={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY,bypass:process.env.AUTH_DEV_BYPASS};
 process.env.SUPABASE_URL=issuerUrl;process.env.SUPABASE_SERVICE_ROLE_KEY='m3-disposable-public-key';process.env.AUTH_DEV_BYPASS='0';
 const apiRoot=join(repo,'finnor-os/apps/api/app/api'),routes:Array<{file:string;parts:string[];dynamic:number}>=[];
 async function scan(directory:string){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const path=join(directory,entry.name);
   if(entry.isDirectory())await scan(path);
   else if(entry.name==='route.ts'){const parts=relative(apiRoot,directory).split('/');routes.push({file:path,parts,dynamic:parts.filter(p=>p.startsWith('[')).length});}
  }
 }
 await scan(apiRoot);routes.sort((a,b)=>a.dynamic-b.dynamic);
 const canonical=new Map<string,any>();
 const backend=createServer(async(req,res)=>{
  const start=performance.now();
  try{
   const url=new URL(req.url??'/','http://127.0.0.1'),parts=url.pathname.replace(/^\/api\//,'').split('/').map(decodeURIComponent);
   let found:{file:string;params:Record<string,string>}|undefined;
   for(const route of routes){
    if(route.parts.length!==parts.length)continue;
    const params:Record<string,string>={};let matched=true;
    for(let i=0;i<parts.length;i++){const segment=route.parts[i]!;
     if(segment.startsWith('[')&&!segment.startsWith('[...'))params[segment.slice(1,-1)]=parts[i]!;
     else if(segment!==parts[i]){matched=false;break;}
    }
    if(matched){found={file:route.file,params};break;}
   }
   if(!found){res.writeHead(404);res.end('{}');return;}
   let body='';for await(const bytes of req){body+=bytes;if(body.length>2_000_000)throw Error('FIXTURE_BODY_BOUND');}
   const module=await import(pathToFileURL(found.file).href),handler=module[req.method??'GET'];
   if(!handler){res.writeHead(405);res.end('{}');return;}
   const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
   const response:Response=await handler(new Request(url,{method:req.method,headers,
    ...(!['GET','HEAD'].includes(req.method??'GET')?{body}: {})}),{params:Promise.resolve(found.params)}),text=await response.text();
   if(url.pathname.startsWith('/api/company-brain/capital-program-')&&response.ok){
    const data=JSON.parse(text);
    if(data.program)canonical.set(data.queryId,data.program);
    if(data.bytes)canonical.set('module:'+data.ref.contentDigest,data);
   }
   res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json','cache-control':'no-store'});res.end(text);
   traffic.push({path:url.pathname,method:req.method,status:response.status,wallMs:performance.now()-start,
    bearerPresent:Boolean(req.headers.authorization),at:new Date().toISOString()});
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"Disposable route host failed"}');
   traffic.push({path:req.url,status:500,diagnostic:String(error)});}
 });
 const upstream=await listen(backend),next=spawn(process.execPath,[join(repo,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port','0','--webpack'],{
  cwd:repo,env:{...process.env,NODE_ENV:'development',NEXT_PUBLIC_OS_API_URL:upstream,NEXT_PUBLIC_SUPABASE_URL:issuerUrl,
   NEXT_PUBLIC_SUPABASE_ANON_KEY:'m3-disposable-public-key',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe'],
 });
 let log='',stopped=false,worker:Promise<void>=Promise.resolve();
 next.stdout!.on('data',bytes=>log+=bytes);next.stderr!.on('data',bytes=>log+=bytes);
 const desktop=Boolean(process.env.FACTORY_DESKTOP_CDP_PORT&&process.env.AGENT_BROWSER_CDP);
 const browserEnv={PATH:process.env.PATH!,HOME:process.env.HOME!,TMPDIR:process.env.TMPDIR!,
  AGENT_BROWSER_SESSION:process.env.AGENT_BROWSER_SESSION??'m3-mounted-native'};
 const ab=(args:string[],stdin?:string)=>new Promise<string>((yes,no)=>{
  const child=spawn('agent-browser',[...(desktop?['--cdp',process.env.AGENT_BROWSER_CDP!]:[]),...args],{
   cwd:repo,env:browserEnv,stdio:['pipe','pipe','pipe'],
  });
  child.stdin!.end(stdin??'');let out='',err='';child.stdout!.on('data',bytes=>out+=bytes);child.stderr!.on('data',bytes=>err+=bytes);
  const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error(`BROWSER_COMMAND_TIMEOUT:${args[0]}`));},45000);
  child.once('error',error=>{clearTimeout(timer);no(error);});
  child.once('close',code=>{clearTimeout(timer);code===0?yes(out):no(Error(`BROWSER_COMMAND_FAILED:${args[0]}:${err||out}`));});
 });
 const evaluate=async(source:string)=>{
  const raw=JSON.parse((await ab(['eval','--stdin'],source)).trim());return typeof raw==='string'?JSON.parse(raw):raw;
 };
 const button=(name:string)=>ab(['find','role','button','click','--name',name,'--exact']);
 const tick=async()=>{
  while(!stopped){await queue.tick();if(!stopped)await new Promise(yes=>setTimeout(yes,200));}
 };
 let url='',inputStatus='NOT_RUN';
 try{
  for(let tries=0;tries<600;tries++){
   const match=log.match(/Local:\s+(http:\/\/[^ \n]+)/);
   if(match){url=`${match[1]}/centropy/investigations/${thread.id}?root=${encodeURIComponent(JSON.stringify(dealRoot))}`;break;}
   if(next.exitCode!==null)throw Error('NEXT_START_FAILED');await new Promise(yes=>setTimeout(yes,100));
  }
  assert(url,'Next did not start');
  const origin=new URL(url).origin;
  for(const path of ['/api/centropy/me',`/api/centropy/threads/${thread.id}?limit=100`]){
   const started=performance.now(),response=await fetch(origin+path,{headers:{authorization:`Bearer ${token}`},
    signal:AbortSignal.timeout(45000)});
   await response.arrayBuffer();
   steps.push({action:'Actual signed-bearer development route readiness',path,status:response.status,wallMs:performance.now()-started});
   assert.equal(response.status,200,'Real development proxy must be ready before bounded browser interaction');
  }
  steps.push({action:'Mounted runtime profile',preparation:'PREPARED_LOCAL_DEVELOPMENT',
   coldStartQualified:false,hostedAuthenticationQualified:false});
  await ab(['open',url]);await ab(['wait','--text','Sign in']);
  const session={access_token:token,refresh_token:'disposable-unused',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,
   user:{id:b.principal,email,role:'authenticated',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}};
  await ab(['eval','--stdin'],`localStorage.setItem("sb-127-auth-token",${JSON.stringify(JSON.stringify(session))}); undefined`);
  await ab(['open',url]);await ab(['wait','--text','M3 economic arrangements']);
  await ab(['eval','--stdin'],`window.__m3WorkspaceInput=[];document.addEventListener("click",event=>{
   window.__m3WorkspaceInput.push({type:event.type,tag:event.target.tagName,trusted:event.isTrusted});
  },{capture:true}); undefined`);
  const beforeCanvas=await ab(['snapshot']);
  await button('Canvas');
  const canvasInput=await evaluate('JSON.stringify(window.__m3WorkspaceInput)');
  steps.push({action:'Native Canvas pointer activation',events:canvasInput,before:beforeCanvas,after:await ab(['snapshot'])});
  if(!canvasInput.some((event:any)=>event.trusted)){
   inputStatus='BLOCKED_TOOL';qualification.push('Assigned CDP click reported success but delivered no trusted DOM click. No synthetic activation substitute used.');
   return {contractStatus:'PARTIAL_VALIDATION',inputStatus,steps,qualification};
  }
  await ab(['wait','--text','Load current arrangements']);
  steps.push({action:'Actual authenticated Investigation Canvas',snapshot:await ab(['snapshot'])});
  await ab(['eval','--stdin'],`window.__m3Input=[];for(const name of ["click","keydown","keyup","input"])document.addEventListener(name,event=>{
   if(event.target?.closest?.(".ct-capital-program"))window.__m3Input.push({type:event.type,key:event.key??null,tag:event.target.tagName,trusted:event.isTrusted});
  },{capture:true}); undefined`);
  await button('Load current arrangements');await ab(['wait','--text','Choose an arrangement and its permitted parameter domain.']);
  // Labels resolve native controls. No DOM click/value mutation fallback may
  // turn a failed assigned-pane input driver into pointer/keyboard evidence.
  await ab(['select','.ct-capital-program label:nth-child(1) select',b.incumbent.ref.id]);
  await ab(['select','.ct-capital-program label:nth-child(2) select','programme-browser-base']);
  await ab(['select','.ct-capital-program label:nth-child(3) select','price']);
  await ab(['find','label','Exact owner unit','fill','fraction']);
  await ab(['find','label','Permitted new terms','fill','0.3']);
  await ab(['focus','.ct-capital-program button[type="submit"]']);await ab(['press','Enter']);
  const inputs=await evaluate('JSON.stringify(window.__m3Input)');
  const pointer=inputs.some((e:any)=>e.type==='click'&&e.trusted),keyboard=inputs.some((e:any)=>e.type==='keydown'&&e.key==='Enter'&&e.trusted);
  steps.push({action:'Pointer and keyboard dispatch',pointer,keyboard,events:inputs});
  if(!pointer||!keyboard){inputStatus='BLOCKED_TOOL';qualification.push('Assigned pane delivered no required trusted input; no DOM activation substitute used');return {contractStatus:'PARTIAL_VALIDATION',inputStatus,steps,qualification};}
  inputStatus='TRUSTED_POINTER_AND_KEYBOARD';
  await ab(['wait','--text','Durable search queued.']);url=(await ab(['get','url'])).trim();
  worker=tick().catch(error=>{steps.push({action:'Actual worker failure',diagnostic:String(error)});});
  await ab(['wait','--text','Modeled arrangements, not agreed transactions']);
  const queryId=await evaluate('JSON.stringify(new URL(location.href).searchParams.get("capitalQuery"))'),program=canonical.get(queryId);
  assert(program);assert(program.candidates.some((c:any)=>c.terms.some((t:any)=>t.after==='0.3')));
  await artifact('browser/current-program.json',program);
  steps.push({action:'Durable worker and canonical arrangement comparison',queryId,programRef:program.ref,snapshot:await ab(['snapshot'])});
  const inspect='.ct-capital-program__candidates article:first-child button:first-child';
  await ab(['click',inspect]);await ab(['wait','--text','Observable timeline and resource occupation']);
  assert.equal(await evaluate('JSON.stringify(document.activeElement?.getAttribute("aria-label"))'),'Arrangement witnesses');
  steps.push({action:'Current owner/M1 witnesses and inspection focus',snapshot:await ab(['snapshot'])});
  const sourceButtons=await evaluate('JSON.stringify([...document.querySelectorAll(".ct-capital-program button")].filter(b=>b.getAttribute("aria-label")?.startsWith("Inspect source witness for")).map(b=>b.getAttribute("aria-label")))');
  assert(sourceButtons.length);await button(sourceButtons[0]);await ab(['wait','--fn','Boolean(document.querySelector(".ct-capital-program [aria-label=\\"Arrangement witnesses\\"] pre"))']);
  steps.push({action:'Authentic M1 material variable witness',snapshot:await ab(['snapshot'])});
  await button('Close arrangement witnesses');
  assert.equal(await evaluate('JSON.stringify(document.activeElement?.textContent)'),'Inspect arrangement');
  const module=program.candidates[0].moduleRef,downloadPath=join(output,'browser/module-download.json');
  await ab(['download','.ct-capital-program__candidates article:first-child button:nth-child(2)',downloadPath]);
  const downloaded=await readFile(downloadPath),served=canonical.get('module:'+module.contentDigest);
  assert(served);assert.equal(createHash('sha256').update(downloaded).digest('hex'),served.sha256);
  steps.push({action:'Actual byte download',ref:module,sha256:served.sha256,path:downloadPath});
  await ab(['open',url]);await ab(['wait','--text','Modeled arrangements, not agreed transactions']);
  assert.equal(canonical.get(queryId).ref.contentDigest,program.ref.contentDigest);
  steps.push({action:'Reload reconstructs original durable bytes',snapshot:await ab(['snapshot'])});
  await ab(['screenshot',join(output,'browser/current.png')]);
  const audit=JSON.parse(await ab(['a11y','--selector','.ct-capital-program','--tags','wcag2a,wcag2aa','--json']));
  await artifact('browser/axe.json',audit);assert.equal(audit.data?.counts?.violations??audit.counts?.violations,0);
  if((audit.data?.counts?.incomplete??audit.counts?.incomplete??0)>0)qualification.push('Some rendered accessibility checks remain incomplete');
  steps.push({action:'Actual accessibility audit',audit});
  stopped=true;await worker;
  await receiveWork({tenantId:b.tenant,userId:b.principal,workId:b.workId,
   instruction:'Actual changed economic Work input for immutable linked recompilation',channel:'console',idempotencyKey:'m3-browser-revised-work'});
  await button('Recheck current sources');await ab(['wait','--text','invalidated']);
  steps.push({action:'Genuine revised Work invalidates original programme',snapshot:await ab(['snapshot'])});
  await button('Recompile current Work');await ab(['wait','--text','queued']);
  await button('Cancel search');await ab(['wait','--text','cancelled']);
  const cancelled=await evaluate('JSON.stringify(new URL(location.href).searchParams.get("capitalQuery"))');
  await queue.tick();const cancelledRow=(await admin.query('SELECT status,result_digest FROM finnor_os.m3_queries WHERE tenant_id=$1 AND id=$2',[b.tenant,cancelled])).rows[0];
  assert.equal(cancelledRow.status,'CANCELLED');assert.equal(cancelledRow.result_digest,null);
  await button('Resume original grant');await ab(['wait','--text','Owner refused:']);
  steps.push({action:'Real queued cancellation, fence and no renewed grant',queryId:cancelled,snapshot:await ab(['snapshot'])});
  await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[b.tenant,b.principal]);
  await ab(['open',url]);await ab(['wait','--fn','!document.querySelector(".ct-capital-program__candidates")']);
  steps.push({action:'Principal revocation clears product values',snapshot:await ab(['snapshot'])});
  assert(traffic.every(t=>!t.path?.startsWith('/api/company-brain/capital-program-')||t.bearerPresent));
  return {contractStatus:qualification.length?'PARTIAL_VALIDATION':'PASS',inputStatus,steps,qualification,
   boundary:'ACTUAL_CENTROPY_WORK_CANVAS_PROXY_ASYMMETRIC_BEARER_SQL_DURABLE_QUEUE_NATIVE_OWNERS',hostedAuthenticationQualified:false};
 }catch(error){
  await ab(['snapshot']).then(snapshot=>steps.push({action:'Failure snapshot',snapshot})).catch(()=>undefined);
  await artifact('browser/failure.json',{message:String(error),stack:(error as Error).stack});
  throw error;
 }finally{
  stopped=true;await worker;
  await artifact('browser/results.json',{url,inputStatus,steps,qualification,traffic});
  await artifact('browser/next-log.json',{log});
  next.kill('SIGTERM');if(next.exitCode===null)await new Promise<void>(yes=>{
   const timer=setTimeout(()=>{next.kill('SIGKILL');yes();},5000);next.once('exit',()=>{clearTimeout(timer);yes();});
  });
  await new Promise<void>(yes=>backend.close(()=>yes()));await new Promise<void>(yes=>issuer.close(()=>yes()));
  for(const [key,value]of Object.entries({SUPABASE_URL:prior.url,SUPABASE_SERVICE_ROLE_KEY:prior.key,AUTH_DEV_BYPASS:prior.bypass}))
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  if(!desktop)await ab(['close']).catch(()=>undefined);
 }
}

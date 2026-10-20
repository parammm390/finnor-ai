/** Shared emitted frontend transport for disposable signed-user campaigns.
 * No product routing, CSP, identity, Work, or application behavior is replaced. */
import {strict as assert} from 'node:assert';
import {createServer} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {artifact,repo} from './environment.mts';

export async function startMountedFrontend(evidence:string,endpoints:{apiBase:string;authBase:string}){
 assert([endpoints.apiBase,endpoints.authBase].every(value=>/^http:\/\/127\.0\.0\.1:\d+$/.test(value)));
 let child:ChildProcess|undefined,writes=Promise.resolve(),buildId:string|undefined;
 const probe=createServer();await new Promise<void>((yes,no)=>{probe.once('error',no);probe.listen(0,'127.0.0.1',yes);});
 const address=probe.address();assert(address&&typeof address!=='string');await new Promise<void>(yes=>probe.close(()=>yes()));
 const frontendBase='http://127.0.0.1:'+address.port;
 const frontdoor=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url??'/',frontendBase),target=url.pathname.startsWith('/auth/v1/')?endpoints.authBase:frontendBase;
   const headers=new Headers();
   for(const [key,value] of Object.entries(req.headers))if(typeof value==='string'&&!['connection','content-length','accept-encoding'].includes(key))headers.set(key,value);
   headers.set('accept-encoding','identity');
   const chunks:Buffer[]=[];let bytes=0;
   for await(const chunk of req){bytes+=chunk.length;assert(bytes<=8*1024*1024);chunks.push(chunk);}
   const response=await fetch(target+url.pathname+url.search,{method:req.method,headers,
    body:['GET','HEAD'].includes(req.method??'GET')?undefined:Buffer.concat(chunks),redirect:'manual',signal:AbortSignal.timeout(30000)});
   const output:Record<string,string>={};
   response.headers.forEach((value,key)=>{if(!['connection','content-length','content-encoding','transfer-encoding'].includes(key))output[key]=value;});
   res.writeHead(response.status,output);
   if(response.body)await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream),res);else res.end();
  }catch{if(!res.headersSent)res.writeHead(502);if(!res.writableEnded)res.end('Disposable frontend transport unavailable');}
 });
 const close=async()=>{
  frontdoor.closeAllConnections();if(frontdoor.listening)await new Promise<void>(yes=>frontdoor.close(()=>yes()));
  if(child&&child.exitCode===null&&child.signalCode===null){
   child.kill('SIGTERM');await Promise.race([new Promise(yes=>child!.once('exit',yes)),new Promise(yes=>setTimeout(yes,3000))]);
   if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(yes=>child!.once('exit',yes));child.kill('SIGKILL');await exited;}
  }
  await writes;
  await artifact(evidence,'frontend-process.json',{buildId,pid:child?.pid,exitCode:child?.exitCode,signal:child?.signalCode,taskOwned:true});
 };
 try{
  await new Promise<void>((yes,no)=>{frontdoor.once('error',no);frontdoor.listen(0,'127.0.0.1',yes);});
  const front=frontdoor.address();assert(front&&typeof front!=='string');const base='http://127.0.0.1:'+front.port;
  const env={PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,NODE_ENV:'production',NODE_OPTIONS:'--max-old-space-size=4096',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_OS_API_URL:endpoints.apiBase,NEXT_PUBLIC_SUPABASE_URL:base,NEXT_PUBLIC_SUPABASE_ANON_KEY:'r1-disposable-local-auth-key'};
  const record=(name:string)=>{for(const stream of [child!.stdout!,child!.stderr!])stream.on('data',bytes=>{writes=writes.then(()=>appendFile(join(evidence,name),bytes));});};
  const started=Date.now();
  child=spawn(process.execPath,['node_modules/next/dist/bin/next','build'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});record('frontend-build.log');
  const built=await new Promise<{code:number|null;signal:string|null}>((yes,no)=>{child!.once('error',no);child!.once('close',(code,signal)=>yes({code,signal}));});
  await artifact(evidence,'frontend-build.json',{...built,wallMs:Date.now()-started,qualification:'EMITTED_NEXT16_FRONTEND_WITH_DISPOSABLE_PUBLIC_TRANSPORT_ONLY'});
  assert.equal(built.code,0,'EMITTED_FRONTEND_BUILD_FAILED');
  buildId=(await readFile(join(repo,'.next/BUILD_ID'),'utf8')).trim();assert(buildId);
  const files:Array<{path:string;sha256:string;bytes:number}>=[];
  async function scan(relative:string){
   for(const entry of await readdir(join(repo,relative),{withFileTypes:true})){
    const path=relative+'/'+entry.name;
    if(entry.isDirectory()){if(entry.name!=='cache')await scan(path);}
    else if(entry.isFile()){const bytes=await readFile(join(repo,path));files.push({path,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length});}
   }
  }
  await scan('.next');files.sort((a,b)=>a.path.localeCompare(b.path));
  await artifact(evidence,'frontend-source.json',{buildId,node:process.execPath,nodeVersion:process.version,platform:process.platform,architecture:process.arch,files,environmentNames:Object.keys(env).sort(),imageProof:false});
  child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(address.port)],{cwd:repo,env,stdio:['ignore','pipe','pipe']});record('frontend.log');
  const until=Date.now()+30000;
  for(;;){
   try{if((await fetch(frontendBase+'/centropy/login',{signal:AbortSignal.timeout(1500)})).ok)break;}catch{/* Observe only this task-owned listener. */}
   assert(Date.now()<until,'EMITTED_FRONTEND_LISTENER_UNAVAILABLE');await new Promise(yes=>setTimeout(yes,100));
  }
  const csp=(await fetch(base+'/centropy/login')).headers.get('content-security-policy');assert(csp?.includes("connect-src 'self' https: wss:"));
  return {base,csp,buildId,close};
 }catch(error){await close();throw error;}
}

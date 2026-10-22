/** I1: real WORLD components, SDK authentication and emitted owner endpoints.
 * No mocked API bodies, synthetic Work projection, or private screenshots. */
import {strict as assert} from 'node:assert';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {build} from 'esbuild';
import {artifact} from './environment.mjs';
import type {localAuth} from './product-transport.mjs';

type Input={evidence:string;privateDirectory:string;sourceRepository:string;apiOrigin:string;auth:Awaited<ReturnType<typeof localAuth>>;
 root:{entityType:string;entityId:string};workId:string;recipient:string;nonrecipient:string};
const hash=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export async function mountedWorkBrowser(input:Input){
 const repo=await realpath(input.sourceRepository),dependencyRepository=resolve(import.meta.dirname,'../../..'),
  directory=join(input.privateDirectory,'browser');
 await mkdir(directory,{mode:0o700});
 const require=createRequire(join(dependencyRepository,'package.json')),react=dirname(require.resolve('react/package.json')),
  reactDom=dirname(require.resolve('react-dom/package.json')),entry=join(repo,'e2e/y4/browser-app.tsx');
 const bundle=await build({absWorkingDir:repo,entryPoints:[entry],outdir:directory,entryNames:'browser-app',bundle:true,
  platform:'browser',format:'iife',target:'chrome130',jsx:'automatic',metafile:true,write:true,
  tsconfig:join(repo,'tsconfig.json'),alias:{react,'react-dom':reactDom},
  nodePaths:[join(dependencyRepository,'node_modules')],
  define:{'process.env':'{}','process.env.NODE_ENV':'"development"','process.env.NEXT_PUBLIC_CENTROPY_TEST_MODE':'"0"',
   'process.env.NEXT_PUBLIC_SUPABASE_URL':JSON.stringify(input.auth.origin),
   'process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY':'"y4-local-public-anon-key"'}});
 const sourceCut=await Promise.all(Object.keys(bundle.metafile!.inputs).map(async path=>{
  if(path==='<define:process.env>')return {path,sourceKind:'ESBUILD_DEFINE_LITERAL',
   replacement:'{}',sha256:hash('{}')};
  const bytes=await readFile(resolve(repo,path));return {path,bytes:bytes.length,sha256:hash(bytes)};
 }));
 const script=await readFile(join(directory,'browser-app.js')),style=await readFile(join(directory,'browser-app.css'));
 const calls:Array<{method:string;path:string;status:number;wallMs:number}>=[];
 let holdNext=false,heldReady:(()=>void)|undefined,releaseHeld:(()=>void)|undefined;
 const server=createServer(async(req,res)=>{
  try{
   const path=new URL(req.url??'/','http://127.0.0.1').pathname;
   res.setHeader('cache-control','no-store');
   if(path==='/browser-app.js'){res.setHeader('content-type','text/javascript');res.end(script);return;}
   if(path==='/browser-app.css'){res.setHeader('content-type','text/css');res.end(style);return;}
   if(path==='/'){
    const context=JSON.stringify({root:input.root,workId:input.workId}).replace(/</g,'\\u003c');
    res.setHeader('content-type','text/html');
    res.setHeader('content-security-policy',`default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ${input.auth.origin}; object-src 'none'; frame-ancestors 'none'`);
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Y4 mounted WORLD Work</title><link rel="stylesheet" href="/browser-app.css">'+
     '<style>body{font:16px system-ui;max-width:1200px;margin:24px auto;padding:16px;background:#101923;color:#f4f7fa}button,input,select,textarea{font:inherit;margin:6px;padding:8px}button{cursor:pointer}textarea{width:90%;min-height:140px}article,section,details{padding:12px;border:1px solid #779;margin:12px 0}a{color:#9ed7ff}pre{white-space:pre-wrap}</style></head>'+
     '<body><div id="root"></div><script>window.__y4Context='+context+'</script><script src="/browser-app.js"></script></body></html>');return;
   }
   if(!/^\/api\/centropy\/[a-zA-Z0-9_/-]+$/.test(path)){res.writeHead(404);res.end('{}');return;}
   const started=performance.now();let bytes=Buffer.alloc(0);
   for await(const chunk of req){if(bytes.length+chunk.length>1048576)throw Error('Y4_BROWSER_BODY_BOUND');bytes=Buffer.concat([bytes,chunk]);}
   const authorization=String(req.headers.authorization??'');
   const upstream=await fetch(input.apiOrigin+path.replace('/api/centropy/','/api/'),{
    method:req.method,headers:{authorization,'content-type':'application/json'},
    ...(req.method==='GET'?{}:{body:bytes}),signal:AbortSignal.timeout(20000)});
   const body=Buffer.from(await upstream.arrayBuffer());
   calls.push({method:req.method??'GET',path,status:upstream.status,wallMs:performance.now()-started});
   if(holdNext&&path.endsWith('/confidential-read')&&authorization==='Bearer '+input.auth.tokens.get(input.recipient)){
    holdNext=false;heldReady?.();
    await new Promise<void>(yes=>{releaseHeld=yes;});
   }
   res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'application/json'});res.end(body);
  }catch{if(!res.headersSent)res.writeHead(503);res.end('{"error":"Y4_BROWSER_TRANSPORT_REFUSED"}');}
 });
 await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
 const address=server.address();if(!address||typeof address==='string')throw Error('Y4_BROWSER_LOOPBACK_REQUIRED');
 const origin='http://127.0.0.1:'+address.port;input.auth.allowBrowserOrigin(origin);
 const session=process.env.AGENT_BROWSER_SESSION??'y4-local',namespace='y4-'+hash(input.evidence).slice(0,16);
 let opened=false,closed=false,sequence=0,recipientVerified=false;
 const screenshot=join(dependencyRepository,'scope-postx/y4-confidential-economic-compiler/evidence',
  'browser-'+basename(input.evidence)+'-offline.png');
 const run=async(args:string[],stdin?:string)=>{
  const number=++sequence,child=spawn('agent-browser',['--session',session,'--namespace',namespace,'--json',...args],{
   env:{...process.env,AGENT_BROWSER_SESSION:session,AGENT_BROWSER_IDLE_TIMEOUT_MS:'3600000'},
   stdio:['pipe','pipe','pipe']});
  let output='',error='',size=0;
  const timer=setTimeout(()=>child.kill('SIGTERM'),45000);
  for(const [stream,append] of [[child.stdout,(s:string)=>{output+=s;}],[child.stderr,(s:string)=>{error+=s;}]] as const)
   stream.on('data',(bytes:Buffer)=>{size+=bytes.length;if(size>131072)child.kill('SIGTERM');else append(bytes.toString());});
  child.stdin.end(stdin??'');
  const code=await new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);}).finally(()=>clearTimeout(timer));
  if(code!==0){await writeFile(join(directory,'command-'+number+'.private.json'),JSON.stringify({args,code,output,error}),{mode:0o600});throw Error('Y4_BROWSER_COMMAND_REFUSED');}
  const result=JSON.parse(output);
  if(result.success===false)throw Error('Y4_BROWSER_COMMAND_REFUSED');
  const data=result.data??result;return data&&typeof data==='object'&&'result' in data?data.result:data;
 };
 const evaluate=(code:string)=>run(['eval','--stdin'],code);
 const wait=(code:string)=>run(['wait','--fn',code]);
 const present=`document.querySelector('[aria-label="Confidential economic computation"] dt')?.textContent==='joint_liquidity'`;
 const absent=`!document.querySelector('[aria-label="Confidential economic computation"] dt')`;
 const signIn=async(principal:string)=>{
  assert.equal(await evaluate(`(async()=>{try{return await window.__y4Browser.signIn(${JSON.stringify(principal)},${JSON.stringify(input.auth.browserPassword)})}catch{return false}})()`),true);
  await wait(`window.__y4Browser?.principal()===${JSON.stringify(principal)}&&window.__y4Browser.ready()`);
 };
 const close=async()=>{
  if(closed)return;closed=true;releaseHeld?.();
  if(opened){
   const errors=await run(['errors']).catch(()=>({diagnosticsUnavailable:true}));
   await writeFile(join(directory,'page-errors.private.json'),JSON.stringify(errors),{mode:0o600});
   await run(['close']).catch(()=>undefined);
  }
  await artifact(input.evidence,'browser-http-metadata.json',{calls,privateBodiesOmitted:true});
  server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));
 };
 try{
  await run(['doctor','--offline','--quick']);
  await run(['--allowed-domains','127.0.0.1','open',origin]);opened=true;
  await wait('Boolean(window.__y4Browser)');
  await signIn(input.recipient);
  await wait('Boolean(document.querySelector(\'[aria-label="Confidential economic computation"]\'))');
  const recheck='[aria-label="Confidential economic computation"] > button';
  await wait(`Boolean(document.querySelector('${recheck}'))&&!document.querySelector('${recheck}').disabled`);
  await run(['focus',recheck]);await run(['press','Enter']);
  await wait(`!document.querySelector('${recheck}')?.disabled`);
  assert.equal(await evaluate(absent),true);
  const initialEvidence={mountedOriginalWorld:true,realStoredWork:true,initialPrivateOutputAbsent:true,keyboardRecheckBeforeExposure:true,
   authBypass:false,mockedApiBodies:false,source:'RETAINED_INSTALLATION_SNAPSHOT',productionUiQualification:false};
  await artifact(input.evidence,'browser-observations.json',{schema:'finnor.y4.mounted-browser.v1',
   status:'AWAITING_MPC_AND_RELEASE',...initialEvidence,sourceCut,browserScriptSha256:hash(script),
   host:'LOCAL_COMPONENT_HOST_NOT_DEPLOYED_NEXT',browserSessionIdleLimitMs:3600000,privateBodiesOmitted:true});
  return {initialEvidence,verifyRecipient:async(expectedPrivateQuantity:string)=>{
  await run(['find','role','button','click','--name','Recheck confidential evidence']);await wait(present);
  const exact=JSON.stringify(expectedPrivateQuantity+' USD');
  assert.equal(await evaluate(`document.querySelector('[aria-label="Confidential economic computation"] dd')?.textContent===${exact}`),true);
  await run(['focus',recheck]);await run(['press','Enter']);await wait(present);
  await run(['reload']);await wait(present);
  await run(['set','offline','on']);await wait(absent);
  assert.equal(await evaluate(`!document.body.innerText.includes(${exact})`),true,'Y4_PRIVATE_SCREENSHOT_REFUSED');
  await mkdir(dirname(screenshot),{recursive:true});
  await run(['screenshot',screenshot]);
  await run(['set','offline','off']);await wait(present);
  const held=new Promise<void>(yes=>{heldReady=yes;});holdNext=true;
  await run(['find','role','button','click','--name','Recheck confidential evidence']);
  let timeout:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([held,new Promise<never>((_,no)=>{timeout=setTimeout(()=>no(Error('Y4_BROWSER_REAL_DELAY_NOT_REACHED')),10000);})]);}
  finally{if(timeout)clearTimeout(timeout);}
  await signIn(input.nonrecipient);await wait(absent);releaseHeld?.();await wait(absent);
  await signIn(input.recipient);await wait(present);
  await artifact(input.evidence,'browser-observations.json',{schema:'finnor.y4.mounted-browser.v1',status:'AWAITING_REVOCATION',
   actualWorldExplorer:true,actualWorldWorkRecord:true,actualConfidentialPanel:true,authBypass:false,mockedApiBodies:false,
   exactPrivateDisplayMatched:true,keyboardRefresh:true,reloadFromStoredEvidence:true,offlineCleared:true,
   delayedPriorPrincipalResponseDiscarded:true,nonrecipientHidden:true,principalABAFreshRead:true,screenshot,
   expectedRecipientDisplayAbsentFromOfflineScreenshot:true,
   host:'LOCAL_COMPONENT_HOST_NOT_DEPLOYED_NEXT',browserSessionIdleLimitMs:3600000,sourceCut,browserScriptSha256:hash(script),privateBodiesOmitted:true});
  recipientVerified=true;
  return {mountedOriginalWorld:true,realStoredEvidence:true,exactPrivateDisplayMatched:true,
   identityReloadOfflineFences:true,privateOutputOmitted:true,keyboardRefresh:true,screenshot,productionUiQualification:false};
  },afterRevocation:async()=>{
   assert(recipientVerified,'Y4_BROWSER_RECIPIENT_EPISODE_REQUIRED');
   await run(['find','role','button','click','--name','Recheck confidential evidence']);await wait(absent);
   await artifact(input.evidence,'browser-observations.json',{schema:'finnor.y4.mounted-browser.v1',status:'PASS',
    actualWorldExplorer:true,actualWorldWorkRecord:true,actualConfidentialPanel:true,authBypass:false,mockedApiBodies:false,
    exactPrivateDisplayMatched:true,keyboardRefresh:true,reloadFromStoredEvidence:true,offlineCleared:true,
    delayedPriorPrincipalResponseDiscarded:true,nonrecipientHidden:true,principalABAFreshRead:true,revocationCleared:true,
    expectedRecipientDisplayAbsentFromOfflineScreenshot:true,
    screenshot,host:'LOCAL_COMPONENT_HOST_NOT_DEPLOYED_NEXT',browserSessionIdleLimitMs:3600000,sourceCut,browserScriptSha256:hash(script),
    calls,privateBodiesOmitted:true,protectedAdmission:false,separatelyAdministered:false});
   return {mountedOriginalWorld:true,realStoredEvidence:true,identityReloadOfflineRevocationFences:true,
    privateOutputOmitted:true,keyboardRefresh:true,screenshot,productionUiQualification:false};
  },close};
 }catch(error){await close();throw error;}
}

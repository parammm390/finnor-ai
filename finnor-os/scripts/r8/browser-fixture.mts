/** Actual built API and mounted frontend with a disposable bearer issuer.
 * No business route, authorization result, capsule or checker receipt is mocked.
 * The local issuer is not hosted Supabase or protected authentication custody.
 */
import {createServer} from 'node:http';
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {createEmployeeConversationThread,updateEmployeeConversationThreadContext} from '@finnor/db';

export async function mountedSolverFixture(input:{fixture:any;request:any;accepted:any;output:string;
 save:(name:string,value:unknown)=>Promise<unknown>;launchWorker:()=>Promise<ChildProcess>}){
 const f=input.fixture,repo=resolve(import.meta.dirname,'../../..'),privateDir=join(input.output,'browser-private');
 await mkdir(privateDir,{recursive:true,mode:0o700});
 const root=f.browserRoot as {entityType:'pe_deal';entityId:string};
 if(!root)throw Error('R8_PREEXISTING_BROWSER_OWNER_ROOT_REQUIRED');
 const thread=await createEmployeeConversationThread({tenantId:f.tenant,ownerEmployeeId:f.principal,title:'R8 current solver Work'});
 const other=await createEmployeeConversationThread({tenantId:f.tenant,ownerEmployeeId:f.principal,title:'Other Work, no solver output'});
 await updateEmployeeConversationThreadContext({tenantId:f.tenant,ownerEmployeeId:f.principal,threadId:thread.id,
  activeWorkId:f.workId,activeReferences:[root]});
 await updateEmployeeConversationThreadContext({tenantId:f.tenant,ownerEmployeeId:f.principal,threadId:other.id,activeReferences:[root]});
 const secret=randomBytes(32),password=randomBytes(18).toString('base64url'),email=f.principal+'@test.invalid';
 const frontendOrigin='http://127.0.0.1:4790',apiOrigin='http://127.0.0.1:4791',authOrigin='http://127.0.0.1:4792';
 const user={id:f.principal,aud:'authenticated',role:'authenticated',email,email_confirmed_at:new Date().toISOString(),
  app_metadata:{provider:'email',providers:['email']},user_metadata:{},created_at:new Date().toISOString()};
 const issue=()=>{const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url'),now=Math.floor(Date.now()/1000);
  const body=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:f.principal,email,aud:'authenticated',role:'authenticated',iat:now,exp:now+3600,iss:authOrigin+'/auth/v1'});
  return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');};
 function verify(token:string){try{const[h,p,s]=token.split('.');if(!h||!p||!s)return false;
  const expected=createHmac('sha256',secret).update(h+'.'+p).digest(),actual=Buffer.from(s,'base64url'),claims=JSON.parse(Buffer.from(p,'base64url').toString());
  return expected.length===actual.length&&timingSafeEqual(expected,actual)&&claims.sub===f.principal&&claims.exp>Date.now()/1000;}catch{return false;}}
 let revokedAuth=false;
 const auth=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');res.setHeader('access-control-allow-origin',frontendOrigin);
  res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');
  res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');
  try{
   if(req.method==='OPTIONS'){res.end();return;}
   if(req.url?.startsWith('/auth/v1/token')){let bytes='';for await(const chunk of req){bytes+=chunk;if(bytes.length>16384)throw Error('BOUND');}
    const body=JSON.parse(bytes);if(body.email!==email||body.password!==password){res.writeHead(400);res.end('{"error":"invalid_credentials"}');return;}
    res.end(JSON.stringify({access_token:issue(),refresh_token:randomBytes(18).toString('base64url'),token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user}));return;}
   if(req.url==='/auth/v1/user'){if(revokedAuth||!verify(String(req.headers.authorization??'').replace(/^Bearer /,''))){res.writeHead(401);res.end('{}');return;}
    res.end(JSON.stringify(user));return;}
   if(req.url?.includes('logout')){res.end('{}');return;}res.writeHead(404);res.end('{}');
  }catch{res.writeHead(400);res.end('{}');}
 });
 await new Promise<void>((yes,no)=>{auth.once('error',no);auth.listen(4792,'127.0.0.1',yes);});
 const children=new Set<ChildProcess>();
 function start(name:string,command:string[],cwd:string,env:NodeJS.ProcessEnv){
  const child=spawn(command[0]!,command.slice(1),{cwd,env,stdio:['ignore','pipe','pipe']});children.add(child);
  let log='';child.stdout!.on('data',bytes=>log+=bytes);child.stderr!.on('data',bytes=>log+=bytes);
  child.once('close',()=>{children.delete(child);void writeFile(join(input.output,'browser-'+name+'.log'),log,{mode:0o600});});
  return child;
 }
 let finished=false,finish!:()=>void;const completion=new Promise<void>(yes=>{finish=()=>{finished=true;yes();};});
 const control=createServer(async(req,res)=>{
  if(req.method==='POST'&&req.url==='/revoke-auth'){
   revokedAuth=true;await input.save('browser-auth-revoked.json',{at:new Date().toISOString(),scope:'DISPOSABLE_LOCAL_BEARER_ISSUER',realBuiltApiFutureRequestsDenied:true});
   res.end('{}');return;
  }
  if(req.method==='POST'&&req.url==='/stop'){res.end('{}');finish();return;}
  res.writeHead(404);res.end('{}');
 });
 await new Promise<void>((yes,no)=>{control.once('error',no);control.listen(4793,'127.0.0.1',yes);});
 const worker=await input.launchWorker();children.add(worker);
 try{
  start('api',[process.execPath,join(repo,'finnor-os/node_modules/next/dist/bin/next'),'start','-p','4791','-H','127.0.0.1'],
   join(repo,'finnor-os/apps/api'),{...process.env,NODE_ENV:'production',AUTH_DEV_BYPASS:'0',SUPABASE_URL:authOrigin,SUPABASE_SERVICE_ROLE_KEY:'disposable-local-auth'});
  const frontEnv={...process.env,NODE_ENV:'production',NEXT_PUBLIC_SUPABASE_URL:authOrigin,NEXT_PUBLIC_SUPABASE_ANON_KEY:'disposable-local-auth',
   FINNOR_OS_API_URL:apiOrigin,NEXT_PUBLIC_OS_API_URL:apiOrigin};
  // NEXT_PUBLIC values are compile-time inputs. Execute the delivered frontend
  // build with this named disposable auth target, not a development server.
  const build=start('build',[process.execPath,join(repo,'node_modules/next/dist/bin/next'),'build'],repo,frontEnv);
  const buildExit=await new Promise<number|null>((yes,no)=>{build.once('error',no);build.once('close',yes);});
  if(buildExit!==0)throw Error('R8_MOUNTED_FRONTEND_BUILD_FAILED');
  start('frontend',[process.execPath,join(repo,'node_modules/next/dist/bin/next'),'start','-p','4790','-H','127.0.0.1'],repo,frontEnv);
  const url=(id:string)=>frontendOrigin+'/centropy/investigations/'+id+'?root='+encodeURIComponent(JSON.stringify(root));
  const fixture={profile:'DISPOSABLE_LOCAL_AUTH_SERVICE_ACTUAL_BUILT_API_AND_FRONTEND',hostedSupabaseQualified:false,
   email,password,frontendOrigin,apiOrigin,authOrigin,controlOrigin:'http://127.0.0.1:4793',
   url:url(thread.id)+'&solverRequest='+input.accepted.requestId,otherUrl:url(other.id),workId:f.workId,requestId:input.accepted.requestId,
   request:{...input.request,parentRequestId:input.accepted.requestId}};
  await writeFile(join(privateDir,'fixture.json'),JSON.stringify(fixture),{mode:0o600});
  await input.save('browser-ready.json',{url:fixture.url,otherUrl:fixture.otherUrl,privateFixture:join(privateDir,'fixture.json'),
   qualification:fixture.profile,hostedSupabaseQualified:false});
  console.log(JSON.stringify({browserFixture:'READY',privateFixture:join(privateDir,'fixture.json'),url:fixture.url}));
  const timer=setTimeout(()=>{completion.catch(()=>undefined);finish();},600000);try{await completion;}finally{clearTimeout(timer);}
  if(!finished)throw Error('R8_MOUNTED_BROWSER_OBSERVER_INCOMPLETE');
  const proof=JSON.parse(await readFile(join(input.output,'browser-proof.json'),'utf8'));
  if(proof.status!=='PASS'||proof.actualBuiltApi!==true||proof.mounted!==true||
   proof.workId!==f.workId||!proof.artifacts?.length||!proof.observations?.initiated||
   !proof.observations?.provisional||!proof.observations?.completeCoverage||!proof.observations?.fallback||
   !proof.observations?.reload||!proof.observations?.workSwitch||!proof.observations?.delayedResponseCleared||
   !proof.observations?.revokedAccessCleared||!revokedAuth)throw Error('R8_MOUNTED_BROWSER_PROOF_REQUIRED');
  return {privateFixture:join(privateDir,'fixture.json'),built:true,qualification:fixture.profile};
 }finally{
  for(const child of children){if(child.exitCode!==null||child.signalCode!==null)continue;
   const stopped=new Promise<void>(yes=>child.once('close',()=>yes()));child.kill('SIGTERM');await stopped;}
  for(const server of [auth,control]){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
 }
}

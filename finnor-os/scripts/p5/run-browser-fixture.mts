/** Owned local auth + generic route host. All product routes, SQL and jobs are real. */
import {createServer,type Server} from 'node:http';
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {join,relative} from 'node:path';
import {readdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createEmployeeConversationThread,updateEmployeeConversationThreadContext} from '@finnor/db';
import {createDeal} from '@finnor/private-equity';
import {nativeFixture} from './native-fixture.mts';
import {evidence,target,atomic,repo} from './test-support.mts';
const run=await evidence('mounted-browser-fixture'),e=await nativeFixture(),f=await target(run.directory);
const frontendOrigin=process.env.FINNOR_P5_FRONTEND_ORIGIN??'http://127.0.0.1:4695';
if(!/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(frontendOrigin))throw Error('OWNED_LOOPBACK_FRONTEND_REQUIRED');
const w=await e.work(f.origin,'API'),thread=await createEmployeeConversationThread({tenantId:e.tenant,ownerEmployeeId:e.actor,title:'Permitted disposable interface'}),
 other=await createEmployeeConversationThread({tenantId:e.tenant,ownerEmployeeId:e.actor,title:'Separate Work boundary'});
const deal=await createDeal({auth:{tenantId:e.tenant,userId:e.actor,employeeId:e.actor,role:'owner'},provenance:{createdBy:e.actor,sourceSystem:'P5_EXPLICIT_DISPOSABLE_BROWSER_FIXTURE'}},
 {targetOrganizationId:e.root.entityId,name:'Explicit disposable P5 browser deal',dealLeadEmployeeId:e.actor,signedLoiAt:new Date(),targetClosingAt:new Date(Date.now()+86400000)}),
 worldRoot={entityType:'pe_deal' as const,entityId:String(deal.row.id)};
await updateEmployeeConversationThreadContext({tenantId:e.tenant,ownerEmployeeId:e.actor,threadId:thread.id,activeWorkId:w.workId,activeReferences:[worldRoot]});
await updateEmployeeConversationThreadContext({tenantId:e.tenant,ownerEmployeeId:e.actor,threadId:other.id,activeReferences:[worldRoot]});
const identity=(await e.admin.query('SELECT email FROM finnor_os.users WHERE tenant_id=$1 AND id=$2',[e.tenant,e.actor])).rows[0],
 email=identity.email,password=randomBytes(18).toString('base64url'),secret=randomBytes(32),publicLocalKey='disposable-local-auth';
const user={id:e.actor,aud:'authenticated',role:'authenticated',email,email_confirmed_at:new Date().toISOString(),app_metadata:{provider:'email',providers:['email']},user_metadata:{},created_at:new Date().toISOString()};
async function listen(server:Server){await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});const address=server.address();if(!address||typeof address==='string')throw Error('OWNED_PORT_REQUIRED');return 'http://127.0.0.1:'+address.port;}
let authOrigin='';
const authTraffic={passwordRequests:0,refreshRequests:0,otherTokenRequests:0,userRequests:0,credentialRefusals:0,signatureRefusals:0,
 credentialComparisons:[] as Array<{grant:string;emailMatches:boolean;passwordMatches:boolean}>};
function issue(){const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url'),now=Math.floor(Date.now()/1000),body=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:e.actor,email,aud:'authenticated',role:'authenticated',iat:now,exp:now+3600,iss:authOrigin+'/auth/v1'});return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');}
function verify(token:string){try{const [h,p,s]=token.split('.');if(!h||!p||!s)return false;const actual=Buffer.from(s,'base64url'),expected=createHmac('sha256',secret).update(h+'.'+p).digest(),claims=JSON.parse(Buffer.from(p,'base64url').toString());return actual.length===expected.length&&timingSafeEqual(actual,expected)&&claims.sub===e.actor&&claims.exp>Date.now()/1000;}catch{return false;}}
async function text(req:import('node:http').IncomingMessage,max=65536){let result='';for await(const b of req){result+=b;if(Buffer.byteLength(result)>max)throw Error('FIXTURE_INPUT_BOUND');}return result;}
const auth=createServer(async(req,res)=>{
 res.setHeader('access-control-allow-origin',frontendOrigin);res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');res.setHeader('content-type','application/json');
 try{
  if(req.method==='OPTIONS'){res.end();return;}
  const input=JSON.parse(await text(req)||'{}');
  if(req.url?.startsWith('/auth/v1/token')){
   const requestedGrant=new URL(req.url,'http://127.0.0.1').searchParams.get('grant_type');
   const grant=requestedGrant==='password'?'password':requestedGrant==='refresh_token'?'refresh_token':'OTHER';
   if(grant==='password')authTraffic.passwordRequests++;else if(grant==='refresh_token')authTraffic.refreshRequests++;else authTraffic.otherTokenRequests++;
   const emailMatches=input.email===email,passwordMatches=input.password===password;
   if(authTraffic.credentialComparisons.length<32)authTraffic.credentialComparisons.push({grant,emailMatches,passwordMatches});
   if(!emailMatches||!passwordMatches){authTraffic.credentialRefusals++;res.writeHead(400);res.end('{"error":"invalid_credentials"}');return;}
   res.end(JSON.stringify({access_token:issue(),token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:randomBytes(18).toString('base64url'),user}));return;
  }
  if(req.url==='/auth/v1/user'){authTraffic.userRequests++;if(!verify(String(req.headers.authorization??'').replace(/^Bearer /,''))){authTraffic.signatureRefusals++;res.writeHead(401);res.end('{"msg":"Invalid JWT"}');return;}res.end(JSON.stringify(user));return;}
  if(req.url?.includes('logout')){res.end('{}');return;}res.writeHead(404);res.end('{}');
 }catch{res.writeHead(400);res.end('{}');}
});
authOrigin=await listen(auth);
process.env.AUTH_DEV_BYPASS='0';process.env.SUPABASE_URL=authOrigin;process.env.SUPABASE_SERVICE_ROLE_KEY=publicLocalKey;
process.env.RATE_LIMIT_PER_MINUTE='100000';process.env.RATE_LIMIT_IP_PER_MINUTE='100000';
const apiRoot=join(repo,'finnor-os/apps/api/app/api'),routes:Array<{path:string;parts:string[]}>=[];
async function scan(directory:string){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await scan(path);else if(entry.name==='route.ts')routes.push({path,parts:relative(apiRoot,directory).split('/')});}}
await scan(apiRoot);routes.sort((a,b)=>a.parts.filter(p=>p.startsWith('[')).length-b.parts.filter(p=>p.startsWith('[')).length);
let delayed:{workId:string;waiting:boolean;promise:Promise<void>;release:()=>void}|null=null,stopped=false;
const traffic:Array<{path:string;method:string;status:number;bearer:boolean}>=[];
const api=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url??'/','http://127.0.0.1'),parts=url.pathname.replace(/^\/api\//,'').split('/').map(decodeURIComponent);
  let match:{path:string;params:Record<string,string|string[]>}|null=null;
  for(const route of routes){
   const params:Record<string,string|string[]>={};let i=0,ok=true;
   for(const segment of route.parts){if(segment.startsWith('[...')){params[segment.slice(4,-1)]=parts.slice(i);i=parts.length;break;}if(i>=parts.length){ok=false;break;}if(segment.startsWith('['))params[segment.slice(1,-1)]=parts[i]!;else if(segment!==parts[i]){ok=false;break;}i++;}
   if(ok&&i===parts.length){match={path:route.path,params};break;}
  }
  if(!match){res.writeHead(404);res.end('{}');return;}
  const body=await text(req,2*1024*1024),module=await import(pathToFileURL(match.path).href),handler=module[req.method??'GET'];
  if(!handler){res.writeHead(405);res.end('{}');return;}
  const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(typeof v==='string')headers.set(k,v);
  const response:Response=await handler(new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method??'GET')?{body}: {})}),{params:Promise.resolve(match.params)});
  if(delayed&&url.pathname==='/api/company-brain/interface-projection'&&JSON.parse(body).workId===delayed.workId){delayed.waiting=true;await delayed.promise;}
  const output:Record<string,string>={};response.headers.forEach((v,k)=>{output[k]=v;});res.writeHead(response.status,output);res.end(Buffer.from(await response.arrayBuffer()));
  traffic.push({path:url.pathname,method:req.method??'GET',status:response.status,bearer:Boolean(req.headers.authorization)});
 }catch{res.writeHead(500,{'content-type':'application/json'});res.end('{"code":"FIXTURE_ROUTE_HOST_FAILURE"}');}
});
const apiOrigin=await listen(api);
let stop!:()=>void;const untilStopped=new Promise<void>(yes=>{stop=()=>{stopped=true;delayed?.release();yes();};});
const control=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 try{
  if(req.url==='/health'){res.end('{"ready":true}');return;}
  if(req.url==='/observation'){res.end(JSON.stringify({target:await f.reference(),acquisitions:(await e.admin.query('SELECT id,status,head_id,work_id FROM finnor_os.p5_acquisitions WHERE tenant_id=$1 ORDER BY created_at',[e.tenant])).rows}));return;}
  if(req.method==='POST'&&req.url==='/delay'){let release!:()=>void;const promise=new Promise<void>(yes=>{release=yes;});delayed={workId:w.workId,waiting:false,promise,release};res.end('{}');return;}
  if(req.url==='/delay-status'){res.end(JSON.stringify({waiting:delayed?.waiting??false}));return;}
  if(req.method==='POST'&&req.url==='/release'){delayed?.release();delayed=null;res.end('{}');return;}
  if(req.method==='POST'&&req.url==='/drift'){await f.control({variant:'beta'});res.end('{}');return;}
  if(req.method==='POST'&&req.url==='/observer-unavailable'){await f.control({mode:'no-observer'});res.end('{}');return;}
  if(req.method==='POST'&&req.url==='/observer-restored'){await f.control({mode:'normal'});res.end('{}');return;}
  if(req.method==='POST'&&req.url==='/revoke'){await e.admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[e.tenant,e.actor]);res.end('{}');return;}
  if(req.method==='POST'&&req.url==='/stop'){res.end('{}');stop();return;}
  res.writeHead(404);res.end('{}');
 }catch{res.writeHead(500);res.end('{"code":"FIXTURE_CONTROL_FAILURE"}');}
});
const controlOrigin=await listen(control),url=frontendOrigin+'/centropy/investigations/'+thread.id+'?root='+encodeURIComponent(JSON.stringify(worldRoot)),
 otherUrl=frontendOrigin+'/centropy/investigations/'+other.id+'?root='+encodeURIComponent(JSON.stringify(worldRoot));
await atomic(join(run.directory,'private-fixture.json'),{schema:'finnor.p5.private-browser-fixture.v1',email,password,frontendOrigin,apiOrigin,authOrigin,controlOrigin,root:e.root,workId:w.workId,accessId:w.accessId,threadId:thread.id,url,otherUrl});
await atomic(join(run.directory,'frontend-env.json'),{NEXT_PUBLIC_OS_API_URL:apiOrigin,NEXT_PUBLIC_SUPABASE_URL:authOrigin,NEXT_PUBLIC_SUPABASE_ANON_KEY:publicLocalKey});
console.log(JSON.stringify({status:'READY',fixture:join(run.directory,'private-fixture.json'),url,controlOrigin,qualification:'LOCAL_BEARER_VERIFICATION_ACTUAL_API_RLS_WORK_QUEUE_NOT_HOSTED_AUTH'}));
let ticking:Promise<unknown>|null=null;
const tick=async()=>{if(stopped)return;ticking=e.queue.tick().catch(()=>{});await ticking;ticking=null;if(!stopped)setTimeout(tick,150);};
void tick();const signal=()=>stop();process.once('SIGTERM',signal);process.once('SIGINT',signal);
try{await untilStopped;if(ticking)await ticking;await run.story('actual-browser-fixture-persistence',[],async()=>({target:await f.reference(),traffic,authTraffic,qualification:'REAL_NATIVE_FIXTURE_SETUP_NOT_BROWSER_VERDICT'}));}
finally{process.off('SIGTERM',signal);process.off('SIGINT',signal);for(const server of [api,auth,control]){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}await f.close();await e.close();await run.finish();}

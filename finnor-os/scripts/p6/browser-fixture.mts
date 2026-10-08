/** Local signed login service and generic actual route host, no product stubs. */
import {createServer,type Server} from 'node:http';
import {randomUUID,randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {join,relative,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {nativeFixture} from '../p5/native-fixture.mjs';
import {createEmployeeConversationThread,updateEmployeeConversationThreadContext} from '@finnor/db';
import {createDeal,createMetricSeries,recordMetricObservation} from '@finnor/private-equity';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
const repo=resolve(import.meta.dirname,'../../..'),out=process.env.FINNOR_P6_EVIDENCE_DIR;
const privateDir=process.env.FINNOR_P6_PRIVATE_DIR;
if(!out?.startsWith('/')||!privateDir?.startsWith('/'))throw Error('FRESH_EVIDENCE_AND_PRIVATE_TEMP_DIRECTORY_REQUIRED');
await mkdir(out,{recursive:true});await mkdir(privateDir,{recursive:true,mode:0o700});
const e=await nativeFixture(),frontendOrigin='http://127.0.0.1:4696';
const ctx={auth:{tenantId:e.tenant,userId:e.actor,employeeId:e.actor,role:'owner' as const},
 provenance:{createdBy:e.actor,sourceSystem:'P6:disposable-mounted-fixture'}};
await e.admin.query(await readFile(join(repo,'scope-pm/phase-12-p6-procedure-induction/handoff/schema.proposed.sql'),'utf8'));
await e.admin.query(`INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:p4',2,2,0,60,'Disposable P6 mounted fixture, no funding')`);
const contracts=(await import('../../packages/db/compute-contract')).PRODUCTION_JOB_CONTRACTS;
e.queue.register('run_harness_program_v1',(await import('../../packages/private-equity/src/program-synthesis/worker')).runHarnessProgramJob,contracts.run_harness_program_v1);
e.queue.register('run_evidence_derivation_v1',(await import('../../packages/private-equity/src/evidence-execution/worker')).runEvidenceDerivationJob,contracts.run_evidence_derivation_v1);
e.queue.register('run_procedure_induction_v1',(await import('../../packages/private-equity/src/procedure-induction/worker')).runProcedureInductionJob,contracts.run_procedure_induction_v1);
const programs:any[]=[];
for(let i=0;i<4;i++){
 const company=i===0||i===3?e.root.entityId:randomUUID(),root={entityType:'external_organization' as const,entityId:company};
 if(i>0&&i<3)await e.admin.query(`INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind)
 VALUES($1,$2,$3,'Disposable P6 company','other')`,[company,e.tenant,'p6-browser-'+i]);
 const source=await createEvidenceSource(e.tenant,{sourceKey:'p6-browser-'+i,sourceType:'manual',title:'Synthetic exact input'}),
  version=await appendEvidenceVersion(e.tenant,source.id,{content:'Permitted synthetic arithmetic only',snapshot:{price:100+i*50,debt:i===2?0:20+i*10},asOf:new Date('2025-01-01')});
 if(i<3)for(const [key,value]of Object.entries({price:String(100+i*50),debt:String(i===2?0:20+i*10)})){
  const series=await createMetricSeries(ctx,{subjectType:root.entityType,subjectId:company,metricKey:key,name:key,unit:'currency',currencyCode:'USD',frequency:'annual'});
  await recordMetricObservation(ctx,{metricSeriesId:String(series.row.id),periodStart:new Date('2025-01-01'),periodEnd:new Date('2025-12-31'),value:{type:'number',value},evidence:{evidenceSourceId:source.id,evidenceVersionId:version.versionId}});
 }
 const request={schema:'finnor.harness-request.v1',root,instruction:'Check source-bound synthetic arithmetic',idempotencyKey:randomUUID(),validAt:'2026-01-01T00:00:00.000Z',mode:'ordinary_disposable',
  sources:['price','debt'].map(key=>({key,source:{kind:'metric',subject:root,metricKey:key,periodStart:'2025-01-01T00:00:00.000Z',periodEnd:'2025-12-31T00:00:00.000Z',
   unit:'currency',currencyCode:'USD',frequency:'annual',calendar:'OWNER_RECORDED',consolidation:'OWNER_SUBJECT_ONLY',instrument:'UNSPECIFIED',scale:'1',sign:'AS_RECORDED'}})),
  acceptance:{requiredSourceKeys:['price','debt'],targets:[{key:'net',expression:{kind:i===2?'ratio':'subtract',left:{kind:'input',key:'price'},right:{kind:'input',key:'debt'}},
   unit:i===2?'multiple':'currency',currencyCode:i===2?null:'USD'}],deliverable:{kind:'analytical_draft',title:'Synthetic analytical draft'}}};
 const submitted=await (await import('../../packages/private-equity/src/program-synthesis/api')).submitHarnessProgram(ctx,request);
 let state:any;
 for(let n=0;n<40;n++){await e.queue.tick();state=await (await import('../../packages/private-equity/src/program-synthesis/store')).readCurrentProgram(ctx,submitted.programId);if(['TESTED','FAILED'].includes(state.status))break}
 if(state.status!==(i===2?'FAILED':'TESTED'))throw Error('MOUNTED_NATIVE_SETUP_FAILED');
 programs.push({...submitted,state:state.status,root});
}
const deal=await createDeal(ctx,{targetOrganizationId:e.root.entityId,name:'P6 disposable browser deal',dealLeadEmployeeId:e.actor,signedLoiAt:new Date(),targetClosingAt:new Date(Date.now()+86400000)});
const worldRoot={entityType:'pe_deal' as const,entityId:String(deal.row.id)},thread=await createEmployeeConversationThread({tenantId:e.tenant,ownerEmployeeId:e.actor,title:'P6 executable procedures'}),
 other=await createEmployeeConversationThread({tenantId:e.tenant,ownerEmployeeId:e.actor,title:'Other Work, no procedure'});
await updateEmployeeConversationThreadContext({tenantId:e.tenant,ownerEmployeeId:e.actor,threadId:thread.id,activeWorkId:programs[3].workId,activeReferences:[worldRoot]});
await updateEmployeeConversationThreadContext({tenantId:e.tenant,ownerEmployeeId:e.actor,threadId:other.id,activeReferences:[worldRoot]});
const email=e.actor+'@test.invalid',password=randomBytes(18).toString('base64url'),secret=randomBytes(32);
const user={id:e.actor,aud:'authenticated',role:'authenticated',email,email_confirmed_at:new Date().toISOString(),app_metadata:{provider:'email',providers:['email']},user_metadata:{},created_at:new Date().toISOString()};
async function listen(server:Server){await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes)});const a=server.address();if(!a||typeof a==='string')throw Error('OWNED_PORT_REQUIRED');return 'http://127.0.0.1:'+a.port}
let authOrigin='';
const issue=()=>{const enc=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url'),now=Math.floor(Date.now()/1000),body=enc({alg:'HS256',typ:'JWT'})+'.'+enc({sub:e.actor,email,iat:now,exp:now+3600,iss:authOrigin+'/auth/v1'});return body+'.'+createHmac('sha256',secret).update(body).digest('base64url')};
function verify(token:string){try{const[h,p,s]=token.split('.');if(!h||!p||!s)return false;const a=Buffer.from(s,'base64url'),b=createHmac('sha256',secret).update(h+'.'+p).digest(),c=JSON.parse(Buffer.from(p,'base64url').toString());return a.length===b.length&&timingSafeEqual(a,b)&&c.sub===e.actor&&c.exp>Date.now()/1000}catch{return false}}
async function body(req:import('node:http').IncomingMessage){let s='';for await(const b of req){s+=b;if(s.length>2*1024*1024)throw Error('BODY_BOUND')}return s}
const traffic:Array<{path:string;status:number;procedureCapsuleId?:string|null}>=[];
const authTraffic={tokenRequests:0,userRequests:0,refusals:0,credentialComparisons:[] as Array<{emailMatches:boolean;passwordMatches:boolean}>};
const auth=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');res.setHeader('access-control-allow-origin',frontendOrigin);res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');
 try{if(req.method==='OPTIONS'){res.end();return}
  if(req.url?.startsWith('/auth/v1/token')){authTraffic.tokenRequests++;const input=JSON.parse(await body(req));authTraffic.credentialComparisons.push({emailMatches:input.email===email,passwordMatches:input.password===password});if(input.email!==email||input.password!==password){authTraffic.refusals++;res.writeHead(400);res.end('{"error":"invalid_credentials"}');return}
   res.end(JSON.stringify({access_token:issue(),refresh_token:randomBytes(18).toString('base64url'),token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user}));return}
  if(req.url==='/auth/v1/user'){authTraffic.userRequests++;if(!verify(String(req.headers.authorization??'').replace(/^Bearer /,''))){authTraffic.refusals++;res.writeHead(401);res.end('{}');return}res.end(JSON.stringify(user));return}
  if(req.url?.includes('logout')){res.end('{}');return}res.writeHead(404);res.end('{}')
 }catch{res.writeHead(400);res.end('{}')}
});
authOrigin=await listen(auth);process.env.AUTH_DEV_BYPASS='0';process.env.SUPABASE_URL=authOrigin;process.env.SUPABASE_SERVICE_ROLE_KEY='disposable-local-auth';
process.env.RATE_LIMIT_PER_MINUTE='100000';process.env.RATE_LIMIT_IP_PER_MINUTE='100000';
const apiRoot=join(repo,'finnor-os/apps/api/app/api'),routes:Array<{path:string;parts:string[]}>=[];
async function scan(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await scan(p);else if(e.name==='route.ts')routes.push({path:p,parts:relative(apiRoot,dir).split('/')})}}
await scan(apiRoot);routes.sort((a,b)=>a.parts.filter(p=>p.startsWith('[')).length-b.parts.filter(p=>p.startsWith('[')).length);
const api=createServer(async(req,res)=>{
 try{const url=new URL(req.url??'/','http://127.0.0.1'),parts=url.pathname.replace(/^\/api\//,'').split('/').map(decodeURIComponent);
  let match:{path:string;params:Record<string,unknown>}|undefined;
  for(const route of routes){const params:Record<string,unknown>={};let n=0,ok=true;for(const p of route.parts){if(p.startsWith('[...')){params[p.slice(4,-1)]=parts.slice(n);n=parts.length;break}
   if(n>=parts.length){ok=false;break}if(p.startsWith('['))params[p.slice(1,-1)]=parts[n];else if(p!==parts[n]){ok=false;break}n++}if(ok&&n===parts.length){match={path:route.path,params};break}}
  if(!match){res.writeHead(404);res.end('{}');return}
  const text=await body(req),module=await import(pathToFileURL(match.path).href),handler=module[req.method??'GET'],headers=new Headers();
  for(const[k,v]of Object.entries(req.headers))if(typeof v==='string')headers.set(k,v);
  if(!handler){res.writeHead(405);res.end('{}');return}
  const response:Response=await handler(new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method??'GET')?{body:text}:{})}),{params:Promise.resolve(match.params)});
  const h:Record<string,string>={};response.headers.forEach((v,k)=>h[k]=v);res.writeHead(response.status,h);res.end(Buffer.from(await response.arrayBuffer()));traffic.push({path:url.pathname,status:response.status,
   ...(url.pathname.endsWith('/program-submit')?{procedureCapsuleId:JSON.parse(text).procedure?.capsuleId??null}:{})});
 }catch{res.writeHead(500);res.end('{"code":"OWNED_ROUTE_HOST_FAILURE"}')}
});
const apiOrigin=await listen(api);let stopped=false,stop!:()=>void;
const untilStop=new Promise<void>(yes=>{stop=()=>{stopped=true;yes()}});
const control=createServer(async(req,res)=>{
 if(req.method==='POST'&&req.url==='/stop'){res.end('{}');stop();return}
 if(req.method==='GET'&&req.url==='/observation'){
  res.setHeader('content-type','application/json');res.end(JSON.stringify({events:(await e.admin.query(
   `SELECT kind,body FROM finnor_os.p1_events WHERE tenant_id=$1 AND kind LIKE 'P6_%'`,[e.tenant])).rows}));return}
 res.writeHead(404);res.end('{}')
});
const controlOrigin=await listen(control),url=(id:string)=>frontendOrigin+'/centropy/investigations/'+id+'?root='+encodeURIComponent(JSON.stringify(worldRoot));
await writeFile(join(privateDir,'fixture.json'),JSON.stringify({email,password,frontendOrigin,apiOrigin,authOrigin,controlOrigin,url:url(thread.id)+'&programId='+programs[3].programId,otherUrl:url(other.id),workId:programs[3].workId,programIds:programs.slice(0,3).map(p=>p.programId)}),{mode:0o600});
await writeFile(join(privateDir,'frontend-env.json'),JSON.stringify({NEXT_PUBLIC_OS_API_URL:apiOrigin,NEXT_PUBLIC_SUPABASE_URL:authOrigin,NEXT_PUBLIC_SUPABASE_ANON_KEY:'disposable-local-auth'}),{mode:0o600});
await writeFile(join(out,'setup.json'),JSON.stringify({programs,qualification:'SYNTHETIC_NATIVE_SETUP_LOCAL_BEARER_NOT_BROWSER_VERDICT'},null,2));
console.log(JSON.stringify({ready:true,privateFixture:join(privateDir,'fixture.json')}));
let ticking:Promise<unknown>|null=null;
const tick=async()=>{if(stopped)return;ticking=e.queue.tick().catch(()=>undefined);await ticking;ticking=null;if(!stopped)setTimeout(tick,150)};
void tick();process.once('SIGTERM',stop);process.once('SIGINT',stop);
try{await untilStop;if(ticking)await ticking}
finally{for(const s of[api,auth,control]){s.closeAllConnections();await new Promise<void>(yes=>s.close(()=>yes()))}await writeFile(join(out,'traffic.json'),JSON.stringify({api:traffic,auth:authTraffic},null,2));await e.close();process.exit(0)}

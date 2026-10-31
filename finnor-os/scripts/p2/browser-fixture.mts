/** Disposable local bearer verification service + generic actual API route host.
 * No business API, authorizer, queue, or financial result is mocked here.
 * This is a named LOCAL_AUTH_SERVICE profile, not hosted Supabase qualification.
 */
import {createServer} from 'node:http';
import {randomBytes,randomUUID,createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {readdir,mkdir,writeFile,appendFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createDeal,restateMetricObservation} from '@finnor/private-equity';
import {createEmployeeConversationThread} from '@finnor/db';
export async function browserFixture(e:any){
 const {f,queue,repo,admin,evidence}=e,tenant=f.f.tenant,actor=f.f.principal,ctx=f.f.ctx;
 const delayedOperation=e.delayedOperation??'compute-search-projection';
 const companies={A:f.f.root.entityId},observations={'A.debt':f.f.p2Observations.debt.row.id};
 const observation=f.f.p2Observations.debt.row;const sourceRef={evidenceSourceId:String(observation.evidenceSourceId),evidenceVersionId:String(observation.evidenceVersionId)};
 const output=join(evidence,'browser');await mkdir(output,{recursive:true});
 const identity=(await admin.query('SELECT email,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2',[tenant,actor])).rows[0];
 if(!identity||identity.status!=='active'||typeof identity.email!=='string')throw Error('CANONICAL_FIXTURE_IDENTITY_UNAVAILABLE');
 const secret=randomBytes(32),email=identity.email,password='p2-disposable-only';
 const expiresIn=e.authExpiresSeconds??3600;
 if(!Number.isSafeInteger(expiresIn)||expiresIn<90||expiresIn>3600)throw Error('LOCAL_AUTH_EXPIRY_BOUND');
 const identities=new Map<string,any>();
 for(const id of [actor,...(f.f.browser.otherPrincipal?[f.f.browser.otherPrincipal.principalId]:[])]){
  const row=(await admin.query('SELECT id,email,status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2',[tenant,id])).rows[0];
  if(!row||row.status!=='active')throw Error('CANONICAL_FIXTURE_IDENTITY_UNAVAILABLE');
  identities.set(id,{id,aud:'authenticated',role:'authenticated',email:row.email,email_confirmed_at:new Date().toISOString(),app_metadata:{provider:'email',providers:['email']},user_metadata:{},created_at:new Date().toISOString()});
 }
 const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
 const sessions=new Map<string,{id:string;principalId:string;active:boolean}>(),refreshTokens=new Map<string,string>();
 const issuedTokenDigests=new Set<string>(),apiTokenDigests=new Set<string>();
 let passwordSignIns=0,refreshes=0,logouts=0;
 const authTraffic:unknown[]=[];
 const authObservation=()=>({passwordSignIns,refreshes,logouts,distinctTokenDigests:apiTokenDigests.size,
  distinctIssuedTokenDigests:issuedTokenDigests.size,expiresIn,rawTokensRecorded:false});
 function issue(principalId:string,sessionId:string){const encode=(o:unknown)=>Buffer.from(JSON.stringify(o)).toString('base64url');const now=Math.floor(Date.now()/1000),body=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:principalId,email:identities.get(principalId).email,aud:'authenticated',role:'authenticated',iat:now,exp:now+expiresIn,iss:'http://127.0.0.1:4692/auth/v1',session_id:sessionId,jti:randomUUID()});const token=body+'.'+createHmac('sha256',secret).update(body).digest('base64url');issuedTokenDigests.add(digest(token));return token;}
 function verify(token:string){try{const [h,p,s]=token.split('.');if(!h||!p||!s)return null;const signature=createHmac('sha256',secret).update(h+'.'+p).digest();const actual=Buffer.from(s,'base64url'),claims=JSON.parse(Buffer.from(p,'base64url').toString());const session=sessions.get(claims.session_id);return actual.length===signature.length&&timingSafeEqual(signature,actual)&&session?.active&&session.principalId===claims.sub&&identities.has(claims.sub)&&claims.exp>Date.now()/1000&&claims.iss==='http://127.0.0.1:4692/auth/v1'?session:null;}catch{return null;}}
 function tokenResponse(principalId:string,sessionId?:string){const id=sessionId??randomUUID();if(!sessions.has(id))sessions.set(id,{id,principalId,active:true});const refresh=randomBytes(32).toString('base64url');refreshTokens.set(digest(refresh),id);return {access_token:issue(principalId,id),token_type:'bearer',expires_in:expiresIn,expires_at:Math.floor(Date.now()/1000)+expiresIn,refresh_token:refresh,user:identities.get(principalId)};}
 const localBearer=()=>tokenResponse(actor).access_token;
 const auth=createServer(async(req,res)=>{
  const route={method:req.method,path:new URL(req.url??'/','http://127.0.0.1:4692').pathname,
   origin:req.headers.origin??null,requestedHeaders:req.headers['access-control-request-headers']??null,at:new Date().toISOString()};
  if(authTraffic.length<1024)authTraffic.push({...route,phase:'received'});
  res.once('finish',()=>{if(authTraffic.length<1024)authTraffic.push({...route,phase:'finished',status:res.statusCode});});
  res.setHeader('access-control-allow-origin','http://127.0.0.1:4690');res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');res.setHeader('content-type','application/json');if(req.method==='OPTIONS'){res.end();return;}let text='';for await(const b of req){text+=b;if(text.length>16384){res.writeHead(413);res.end('{}');return;}}let body:any;try{body=JSON.parse(text||'{}');}catch{res.writeHead(400);res.end('{}');return;}
  const url=new URL(req.url??'/','http://127.0.0.1:4692');
  if(url.pathname==='/auth/v1/token'&&req.method==='POST'){
   const user=[...identities.values()].find(user=>user.email===body.email);
   if(url.searchParams.get('grant_type')==='password'&&user&&body.password===password){passwordSignIns++;res.end(JSON.stringify(tokenResponse(user.id)));return;}
   if(url.searchParams.get('grant_type')==='refresh_token'&&typeof body.refresh_token==='string'){
    const key=digest(body.refresh_token),id=refreshTokens.get(key),session=id?sessions.get(id):null;
    if(session?.active){refreshTokens.delete(key);refreshes++;res.end(JSON.stringify(tokenResponse(session.principalId,session.id)));return;}
   }
   res.writeHead(400);res.end(JSON.stringify({error:'invalid_grant',msg:'Invalid local fixture credentials'}));return;
  }
  if(url.pathname==='/auth/v1/user'){const session=verify(String(req.headers.authorization??'').replace(/^Bearer /,''));if(!session){res.writeHead(401);res.end(JSON.stringify({msg:'Invalid JWT'}));return;}res.end(JSON.stringify(identities.get(session.principalId)));return;}
  if(url.pathname==='/auth/v1/logout'){const session=verify(String(req.headers.authorization??'').replace(/^Bearer /,''));if(session){session.active=false;for(const [key,id] of refreshTokens)if(id===session.id)refreshTokens.delete(key);logouts++;}res.end('{}');return;}res.writeHead(404);res.end('{}');
 });await new Promise<void>(yes=>auth.listen(4692,'127.0.0.1',yes));
 process.env.AUTH_DEV_BYPASS='0';process.env.SUPABASE_URL='http://127.0.0.1:4692';process.env.SUPABASE_SERVICE_ROLE_KEY='disposable-local-auth-key';process.env.RATE_LIMIT_PER_MINUTE='10000';process.env.RATE_LIMIT_IP_PER_MINUTE='10000';
 const {thread,otherThread,canvasRoot}=f.f.browser;
 const checks:any[]=[];
 const {readEnterpriseContingentPolicy}=await import('../../packages/private-equity/src/enterprise-control');
 const {validateBeliefViewPin,loadEnterpriseBeliefView}=await import('../../packages/private-equity/src/enterprise-beliefs');
 await f.artifact('browser-after-P1-view.json',await loadEnterpriseBeliefView(ctx,{root:f.f.root,validAt:f.policy.bindings.beliefPins[0].validAt}));
 for(const [name,identityCtx] of [['fixture',ctx],['bearer',{auth:await (await import('@finnor/security')).resolveTenantFromBearerToken(localBearer())}]] as const){
  try{const policy=await readEnterpriseContingentPolicy(identityCtx,f.policy.ref);checks.push({name,status:'CURRENT',policyRef:policy.ref});}
  catch(error){checks.push({name,status:'REFUSED',error:String(error),code:(error as any).code,pins:await Promise.all(f.policy.bindings.beliefPins.map(async(pin:any)=>({pin,validation:await validateBeliefViewPin(identityCtx,pin)})))});}
 }
 await writeFile(join(output,'owner-currentness-before-ui.json'),JSON.stringify(checks,null,2));
 const apiRoot=join(repo,'finnor-os/apps/api/app/api');const routes:Array<{file:string;parts:string[];dynamic:number}>=[];
 async function scan(directory:string){for(const item of await readdir(directory,{withFileTypes:true})){const path=join(directory,item.name);if(item.isDirectory())await scan(path);else if(item.name==='route.ts'){const parts=relative(apiRoot,directory).split('/');routes.push({file:path,parts,dynamic:parts.filter(p=>p.startsWith('[')).length});}}}await scan(apiRoot);routes.sort((a,b)=>a.dynamic-b.dynamic);
 const programRoot=f.f.root,other={threadId:otherThread.id,url:`http://127.0.0.1:4690/centropy/investigations/${otherThread.id}?root=${encodeURIComponent(JSON.stringify(canvasRoot))}`};
 let delayed:{workId:string;waiting:boolean;promise:Promise<void>;release:()=>void;observation:any}|null=null;
 const delayedObservations:any[]=[];
 const traffic:any[]=[];
 let sampleInFlight:Promise<unknown>|null=null,observationCount=0;
 const observer=setInterval(()=>{if(sampleInFlight||observationCount>=600)return;observationCount++;sampleInFlight=(async()=>{
  const rows=(await admin.query("SELECT pid,state,wait_event_type,wait_event,extract(epoch FROM clock_timestamp()-query_start)::float8 elapsed_seconds,left(query,256) query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle' ORDER BY pid")).rows;
  await appendFile(join(output,'database-and-runtime-observer.jsonl'),JSON.stringify({at:new Date().toISOString(),rows,memory:process.memoryUsage(),cpuMicros:process.cpuUsage(),qualification:'ACTUAL_LOCAL_SAMPLES_NOT_AGGREGATE_OS_ENFORCEMENT_OR_BILLING'})+'\n');
 })().catch(error=>traffic.push({observerError:String(error)})).finally(()=>{sampleInFlight=null;});},1000);
 const api=createServer(async(req,res)=>{const started=Date.now();try{if(typeof req.headers.authorization==='string')apiTokenDigests.add(digest(req.headers.authorization));const url=new URL(req.url??'/','http://127.0.0.1:4691');const parts=url.pathname.replace(/^\/api\//,'').split('/').map(decodeURIComponent);let matched:any;for(const route of routes){const params:Record<string,unknown>={};let ok=true,j=0;for(const segment of route.parts){if(segment.startsWith('[...')){params[segment.slice(4,-1)]=parts.slice(j);j=parts.length;break;}if(j>=parts.length){ok=false;break;}if(segment.startsWith('['))params[segment.slice(1,-1)]=parts[j];else if(segment!==parts[j]){ok=false;break;}j++;}if(ok&&j===parts.length){matched={...route,params};break;}}if(!matched){res.writeHead(404);res.end('{}');return;}
   let body='';for await(const b of req){body+=b;if(body.length>8388608)throw Error('BODY_BOUND');}const module=await import(pathToFileURL(matched.file).href),handler=module[req.method??'GET'];if(!handler){res.writeHead(405);res.end('{}');return;}const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);const request=new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method??'GET')?{body}: {})});const response:Response=await handler(request,{params:Promise.resolve(matched.params)});
   const requestWorkId=(()=>{try{return JSON.parse(body).workId??null;}catch{return null;}})();
   const projection=await (async()=>{if(!['/api/company-brain/compute-search-projection','/api/company-brain/economic-orchestration-projection'].includes(url.pathname)||response.status!==200)return null;const value=await response.clone().json();return {workId:value.workId,searches:value.searches?.map((row:any)=>({searchId:row.searchId,programId:row.programId,status:row.status,workRevision:row.workRevision,currentness:row.currentness,policyCurrentness:row.policyCurrentness})),eligiblePrograms:value.eligiblePrograms?.map((row:any)=>({programId:row.programId,status:row.status}))};})();
   const held=delayed&&url.pathname==='/api/company-brain/'+delayedOperation&&requestWorkId===delayed.workId&&!delayed.waiting?delayed:null;
   if(held){held.waiting=true;held.observation.handlerReturnedAt=new Date().toISOString();held.observation.status=response.status;await held.promise;}
   res.writeHead(response.status,(()=>{const out:Record<string,string>={};response.headers.forEach((value,key)=>{out[key]=value;});return out;})());res.end(Buffer.from(await response.arrayBuffer()));
   if(held)held.observation.finishedAt=new Date().toISOString();
   traffic.push({path:url.pathname,method:req.method,status:response.status,ms:Date.now()-started,bearer:Boolean(req.headers.authorization),workId:requestWorkId,delayId:held?.observation.id??null,projection,at:new Date().toISOString()});
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'Local route host failed'}));traffic.push({path:req.url,status:500,diagnostic:String(error),at:new Date().toISOString()});}await writeFile(join(output,'traffic.json'),JSON.stringify(traffic,null,2));
 });await new Promise<void>(yes=>api.listen(4691,'127.0.0.1',yes));
 let stopped=false;let stopFixture!:()=>void;const stoppedPromise=new Promise<void>(yes=>{stopFixture=()=>{stopped=true;yes();};});
 const control=createServer(async(req,res)=>{try{
  if(req.url==='/auth-observation'){res.end(JSON.stringify({...authObservation(),traffic:authTraffic}));return;}
  if(req.url==='/traffic-observation'){res.end(JSON.stringify({traffic,delayedObservations,rawTokensRecorded:false}));return;}
  if(req.method==='POST'&&req.url==='/delay-read'){if(delayed)throw Error('PREVIOUS_DELAY_MUST_BE_RELEASED');let body='';for await(const bytes of req)body+=bytes;const parsed=JSON.parse(body);let release!:()=>void;const promise=new Promise<void>(yes=>{release=yes;});const observation={id:randomUUID(),workId:parsed.workId,armedAt:new Date().toISOString(),handlerReturnedAt:null,status:null,releasedAt:null,finishedAt:null};delayedObservations.push(observation);delayed={workId:parsed.workId,waiting:false,promise,release,observation};res.end(JSON.stringify({id:observation.id}));return;}
  if(req.url==='/delay-status'){res.end(JSON.stringify({waiting:delayed?.waiting??false,workId:delayed?.workId??null,history:delayedObservations}));return;}
  if(req.method==='POST'&&req.url==='/release-read'){if(delayed){delayed.observation.releasedAt=new Date().toISOString();delayed.release();}delayed=null;res.end('{}');return;}
  if(req.method==='POST'&&req.url==='/stop'){delayed?.release();res.end('{}');stopFixture();return;}
  if(req.method==='POST'&&req.url==='/correct'){const correction=await restateMetricObservation(ctx,{priorObservationId:observations['A.debt'],expectedVersion:1,replacement:{value:{type:'number',value:'80'},evidence:sourceRef}});res.end(JSON.stringify({correction,expected:{netEquity:'33',leverage:'4'}}));return;}
  if(req.method==='POST'&&req.url==='/revoke'){await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[tenant,actor]);res.end('{}');return;}
  if(req.url==='/observation'){const oracle=(await admin.query('SELECT 120::numeric-70::numeric-7::numeric equity,70::numeric/20::numeric leverage')).rows[0],plans=(await admin.query('SELECT s.id,s.status,s.head_id,s.revision,p.work_id,p.work_input_id FROM finnor_os.p2_requests s JOIN finnor_os.p1_requests p ON p.id=s.program_id WHERE s.program_id=$1',[f.p.programId])).rows,program=(await admin.query('SELECT id,status FROM finnor_os.p1_requests WHERE id=$1',[f.p.programId])).rows,capsuleDigests=(await admin.query('SELECT digest FROM finnor_os.w1_capsules WHERE search_id=ANY($1::uuid[])',[plans.map((plan:any)=>plan.id)])).rows.map((row:any)=>row.digest),historicalPlans=(await admin.query('SELECT s.id,s.status,s.program_id,p.work_id,p.work_input_id FROM finnor_os.p2_requests s JOIN finnor_os.p1_requests p ON p.id=s.program_id WHERE p.work_id=$1 AND s.program_id<>$2 ORDER BY s.created_at',[f.p.workId,f.p.programId])).rows;res.end(JSON.stringify({oracle,plans,program,capsuleDigests,historicalPlans}));return;}
  if(req.url==='/native-oracle'&&delayedOperation==='economic-orchestration-projection'){
   const search=(await admin.query("SELECT id FROM finnor_os.p2_requests WHERE program_id=$1 AND request ? 'orchestration' ORDER BY created_at DESC LIMIT 1",[f.p.programId])).rows[0];
   if(!search||!f.f.browser.otherPrincipal)throw Error('ACTUAL_W1_NATIVE_SEARCH_AND_FOREIGN_PRINCIPAL_REQUIRED');
   const call=async(operation:string,body:unknown,bearer?:string)=>fetch('http://127.0.0.1:4691/api/company-brain/'+operation,{method:'POST',headers:{'content-type':'application/json',...(bearer?{authorization:'Bearer '+bearer}:{})},body:JSON.stringify(body)});
   const program=await call('program-read',{programId:f.p.programId},localBearer());
   if(program.status!==200)throw Error('ORIGINAL_CURRENT_PROGRAM_REQUIRED_FOR_NATIVE_ORACLE');
   const anonymous=await call('economic-orchestration-projection',{root:programRoot,workId:f.p.workId});
   const foreign=await call('economic-orchestration-read',{searchId:search.id},tokenResponse(f.f.browser.otherPrincipal.principalId).access_token);
   const outcome=await (await import('../postz-w1/native-observe.mjs')).observeNativeRun(admin,{fixture:'P1_LIABILITY_ARITHMETIC',tenantId:tenant,principalId:actor,programId:f.p.programId},search.id,(await program.json()).program,{bypass:false,anonymousStatus:anonymous.status,foreignStatus:foreign.status},join(evidence,'w1-scored-native'));
   res.end(JSON.stringify({status:'PASS',outcome}));return;
  }
  if(req.url==='/health'){res.end('ready');return;}res.writeHead(404);res.end('{}');
 }catch(error){res.writeHead(500);res.end(String(error));}});await new Promise<void>(yes=>control.listen(4693,'127.0.0.1',yes));
 const data={profile:'DISPOSABLE_LOCAL_AUTH_SERVICE_ACTUAL_BEARER_RLS_AND_OWNER_GRANT',hostedSupabaseQualified:false,email,password,tenant,actor,companyRoot:programRoot,canvasRoot,threadId:thread.id,workId:f.p.workId,programId:f.p.programId,url:`http://127.0.0.1:4690/centropy/investigations/${thread.id}?root=${encodeURIComponent(JSON.stringify(canvasRoot))}`,expected:{netEquity:'43',leverage:'3.5'},other,...(f.f.browser.otherCompany?{otherCompany:f.f.browser.otherCompany,otherWork:f.f.browser.otherWork,otherPrincipal:{...f.f.browser.otherPrincipal,email:identities.get(f.f.browser.otherPrincipal.principalId).email,password}}:{})};await writeFile(join(output,'fixture.json'),JSON.stringify(data,null,2));await writeFile(join(output,'frontend-env.json'),JSON.stringify({NEXT_PUBLIC_OS_API_URL:'http://127.0.0.1:4691',NEXT_PUBLIC_SUPABASE_URL:'http://127.0.0.1:4692',NEXT_PUBLIC_SUPABASE_ANON_KEY:'disposable-local-auth-key'},null,2));console.log(JSON.stringify({browserFixture:'READY',fixture:join(output,'fixture.json'),url:data.url}));
 let tickWork:Promise<unknown>|null=null;const tick=async()=>{if(stopped)return;tickWork=queue.tick().catch((error:unknown)=>traffic.push({workerError:String(error)}));await tickWork;tickWork=null;if(!stopped)setTimeout(tick,200);};void tick();
 const onSignal=()=>{delayed?.release();stopFixture();};process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);await stoppedPromise;if(tickWork)await tickWork;process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);
 clearInterval(observer);if(sampleInFlight)await sampleInFlight;
 await writeFile(join(output,'terminal-auth-observation.json'),JSON.stringify({...authObservation(),traffic:authTraffic},null,2)+'\n');
 await writeFile(join(output,'terminal-database-observer.json'),JSON.stringify({observedAt:new Date().toISOString(),program:(await admin.query('SELECT q.id,q.status,q.failure,q.generation,e.attempts_used,e.steps_used,e.deadline_at FROM finnor_os.p1_requests q JOIN finnor_os.p1_episodes e ON e.id=q.episode_id WHERE q.id=$1',[f.p.programId])).rows,searches:(await admin.query('SELECT id,status,reason,generation,revision FROM finnor_os.p2_requests WHERE program_id=$1',[f.p.programId])).rows,jobs:(await admin.query("SELECT id,type,status,attempts,last_error,run_at FROM finnor_os.jobs WHERE payload->>'programId'=$1 OR payload->>'workId'=$2 OR payload->>'searchId' IN(SELECT id::text FROM finnor_os.p2_requests WHERE program_id=$1::uuid)",[f.p.programId,f.p.workId])).rows},null,2));
 await Promise.all([new Promise<void>(yes=>auth.close(()=>yes())),new Promise<void>(yes=>api.close(()=>yes())),new Promise<void>(yes=>control.close(()=>yes()))]);
}

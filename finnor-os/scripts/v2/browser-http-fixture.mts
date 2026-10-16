/** Synthetic auth only; every business response comes from its actual owner route. */
import {createServer,type Server} from 'node:http';
import {createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import type pg from 'pg';

export async function browserHttpFixture(admin:pg.Client,tenant:string,actor:string,otherActor:string){
 const secret=randomBytes(32),apiDirectory=resolve(import.meta.dirname,'../../apps/api/app/api');
 const users=(await admin.query<{id:string;email:string}>('SELECT id,email FROM finnor_os.users WHERE tenant_id=$1 AND id=ANY($2::uuid[])',[tenant,[actor,otherActor]])).rows;
 const observed={userRequests:0,signatureRefusals:0,refreshRequests:0,apiRequests:[] as Array<{operation:string;status:number}>};
 const {NextRequest}=createRequire(import.meta.url)('next/server') as typeof import('next/server');
 let authOrigin='';
 const userBody=(u:{id:string;email:string})=>({id:u.id,email:u.email,aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()});
 let issued=0;const sessions=new Map(users.map(u=>[u.id,randomUUID()]));
 const issue=(id:string,lifetime=1800)=>{
  const user=users.find(u=>u.id===id);if(!user)throw Error('ACTUAL_DISPOSABLE_AUTH_USER_REQUIRED');
  const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url'),now=Math.floor(Date.now()/1000);
  const body=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:id,email:user.email,aud:'authenticated',role:'authenticated',iat:now,exp:now+lifetime,session_id:sessions.get(id),session_revision:++issued,iss:authOrigin+'/auth/v1'});
  return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');
 };
 const verify=(authorization:unknown)=>{
  const [h,p,s]=String(authorization??'').replace(/^Bearer /,'').split('.');if(!h||!p||!s)throw Error('INVALID_SYNTHETIC_TOKEN');
  const actual=Buffer.from(s,'base64url'),expected=createHmac('sha256',secret).update(h+'.'+p).digest();
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('INVALID_SYNTHETIC_SIGNATURE');
  const claims=JSON.parse(Buffer.from(p,'base64url').toString()),user=users.find(u=>u.id===claims.sub);
  if(!user||claims.exp<=Date.now()/1000)throw Error('INVALID_SYNTHETIC_USER');return user;
 };
 const auth=createServer(async(req,res)=>{
  const origin=String(req.headers.origin??'');if(/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))res.setHeader('access-control-allow-origin',origin);
  res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');
  res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');res.setHeader('content-type','application/json');
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  try{
   const url=new URL(req.url??'/','http://127.0.0.1');
   if(url.pathname==='/auth/v1/token'&&req.method==='POST'&&['password','refresh_token'].includes(url.searchParams.get('grant_type')??'')){
    let bytes='';for await(const chunk of req){bytes+=chunk;if(bytes.length>4096)throw Error('AUTH_INPUT_BOUND');}
    const input=JSON.parse(bytes),refresh=url.searchParams.get('grant_type')==='refresh_token',user=refresh?users.find(u=>input.refresh_token==='disposable-local-refresh-'+u.id):users.find(u=>u.email===input.email);
    // This public dummy input has no meaning or validity outside the owned fixture.
    if(!user||!refresh&&input.password!=='local-disposable-no-authority')throw Error('INVALID_SYNTHETIC_LOGIN');
    if(refresh)observed.refreshRequests++;
    res.end(JSON.stringify({access_token:issue(user.id,90),token_type:'bearer',expires_in:90,expires_at:Math.floor(Date.now()/1000)+90,refresh_token:'disposable-local-refresh-'+user.id,user:userBody(user)}));return;
   }
   if(url.pathname==='/auth/v1/user'){observed.userRequests++;res.end(JSON.stringify(userBody(verify(req.headers.authorization))));return;}
   if(url.pathname==='/auth/v1/logout'&&req.method==='POST'){verify(req.headers.authorization);res.writeHead(204);res.end();return;}
   res.writeHead(404);res.end('{}');
  }catch{observed.signatureRefusals++;res.writeHead(401);res.end('{"msg":"Invalid disposable auth"}');}
 });
 async function listen(server:Server){
  await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const address=server.address();if(!address||typeof address==='string')throw Error('OWNED_LOOPBACK_PORT_REQUIRED');return 'http://127.0.0.1:'+address.port;
 }
 authOrigin=await listen(auth);
 const prior=Object.fromEntries(['AUTH_DEV_BYPASS','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','RATE_LIMIT_PER_MINUTE','RATE_LIMIT_IP_PER_MINUTE'].map(k=>[k,process.env[k]]));
 process.env.AUTH_DEV_BYPASS='0';process.env.SUPABASE_URL=authOrigin;process.env.SUPABASE_SERVICE_ROLE_KEY='disposable-local-service-not-live';
 process.env.RATE_LIMIT_PER_MINUTE='100000';process.env.RATE_LIMIT_IP_PER_MINUTE='100000';
 const paths=(await readdir(apiDirectory,{recursive:true})).filter(p=>p==='route.ts'||p.endsWith('/route.ts')).map(file=>({
  file:join(apiDirectory,file),segments:file.split('/').slice(0,-1),
 })).sort((a,b)=>a.segments.filter(s=>s.startsWith('[')).length-b.segments.filter(s=>s.startsWith('[')).length);
 const api=createServer(async(req,res)=>{
  try{
   const url=new URL(req.url??'/','http://127.0.0.1'),segments=url.pathname.split('/').filter(Boolean).slice(1);
   if(!url.pathname.startsWith('/api/')||segments.some(s=>!/^[a-zA-Z0-9_-]+$/.test(s))){res.writeHead(404);res.end('{}');return;}
   const route=paths.find(r=>r.segments.length===segments.length&&r.segments.every((s,i)=>s.startsWith('[')||s===segments[i]));
   if(!route){res.writeHead(404);res.end('{}');return;}
   const params:Record<string,string>={};route.segments.forEach((s,i)=>{if(s.startsWith('['))params[s.slice(1,-1)]=segments[i]!;});
   const handler=(await import(pathToFileURL(route.file).href))[req.method??'GET'];
   if(typeof handler!=='function'){res.writeHead(405);res.end('{}');return;}
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1048576)throw Error('OWNED_REQUEST_BOUND');}
   const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
   const result:Response=await handler(new NextRequest(url,{method:req.method,headers,...(body?{body}:{})}),{params:Promise.resolve(params)});
   res.writeHead(result.status,{'content-type':result.headers.get('content-type')??'application/json'});res.end(Buffer.from(await result.arrayBuffer()));
   observed.apiRequests.push({operation:(req.method??'GET')+' '+url.pathname,status:result.status});
  }catch(error){console.error('OWNED_BROWSER_ROUTE_FAILURE',error instanceof Error?error.message:'UNKNOWN');res.writeHead(500);res.end('{"code":"OWNED_BROWSER_HTTP_FAILURE"}');}
 });
 const origin=await listen(api),token=issue(actor),otherToken=issue(otherActor);
 const request=async(path:string,body:unknown,identity:'actor'|'other'|'anonymous'|'invalid'='actor',upstream=origin)=>{
  if(!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path))throw Error('EXACT_OWNED_API_PATH_REQUIRED');
  const headers:Record<string,string>={'content-type':'application/json'};
  if(identity!=='anonymous')headers.authorization='Bearer '+(identity==='other'?otherToken:identity==='invalid'?'invalid.disposable.token':token);
  const response=await fetch(upstream+'/api/'+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  return {status:response.status,body:await response.json() as any};
 };
 const call=async(operation:string,body:unknown,identity:'actor'|'other'|'anonymous'|'invalid'='actor',upstream=origin)=>
  request('company-brain/'+operation,body,identity,upstream);
 return {origin,authOrigin,loginEmail:users.find(u=>u.id===actor)!.email,call,request,observed,close:async()=>{
  for(const server of [api,auth]){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
  for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 }};
}

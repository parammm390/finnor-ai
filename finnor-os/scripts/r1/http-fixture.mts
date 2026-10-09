/** Named disposable local Auth service and HTTP transport. Business routes,
 * bearer verification, RLS, owner resolvers and queue remain production code. */
import {createServer,type Server} from 'node:http';
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import {readdir,appendFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function startR1HttpFixture(repo:string,evidence:string,options?:{builtApi?:boolean}){
 if(process.env.NODE_ENV!=='test')throw Error('R1_DISPOSABLE_HTTP_PROFILE_REQUIRED');
 const identities=new Map<string,{id:string;email:string;password:string}>(),secret=randomBytes(32);
 const user=(id:any)=>({id:id.id,aud:'authenticated',role:'authenticated',email:id.email,email_confirmed_at:'2026-01-01T00:00:00.000Z',app_metadata:{provider:'email',providers:['email']},user_metadata:{},created_at:'2026-01-01T00:00:00.000Z'});
 const listen=async(s:Server)=>{await new Promise<void>((yes,no)=>{s.once('error',no);s.listen(0,'127.0.0.1',yes);});const a=s.address();if(!a||typeof a==='string')throw Error('R1_HTTP_LISTEN');return 'http://127.0.0.1:'+a.port;};
 let authBase='';
 function issue(id:any){const e=(v:any)=>Buffer.from(JSON.stringify(v)).toString('base64url'),now=Math.floor(Date.now()/1000),head=e({alg:'HS256',typ:'JWT'})+'.'+e({sub:id.id,email:id.email,aud:'authenticated',role:'authenticated',iat:now,exp:now+3600,iss:authBase+'/auth/v1'});return head+'.'+createHmac('sha256',secret).update(head).digest('base64url');}
 function verified(token:string){try{const [h,p,s]=token.split('.');if(!h||!p||!s)return null;const expected=createHmac('sha256',secret).update(h+'.'+p).digest(),actual=Buffer.from(s,'base64url'),c=JSON.parse(Buffer.from(p,'base64url').toString());return actual.length===expected.length&&timingSafeEqual(actual,expected)&&c.exp>Date.now()/1000&&identities.get(c.sub)?.email===c.email?identities.get(c.sub):null;}catch{return null;}}
 async function body(req:any,limit:number){let bytes=Buffer.alloc(0);for await(const b of req){if(bytes.length+b.length>limit)throw Error('R1_HTTP_FIXTURE_BODY_BOUND');bytes=Buffer.concat([bytes,b]);}return bytes;}
 const auth=createServer(async(req,res)=>{try{res.setHeader('content-type','application/json');res.setHeader('access-control-allow-origin','*');res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');if(req.method==='OPTIONS'){res.end();return;}
  if(req.url?.startsWith('/auth/v1/token')){const b=JSON.parse((await body(req,16384)).toString()||'{}'),id=[...identities.values()].find(i=>i.email===b.email&&i.password===b.password);if(!id){res.writeHead(400);res.end('{"msg":"Invalid local fixture credentials"}');return;}res.end(JSON.stringify({access_token:issue(id),token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:'disposable-refresh-'+id.id,user:user(id)}));return;}
  if(req.url==='/auth/v1/user'){const id=verified(String(req.headers.authorization??'').replace(/^Bearer /,''));res.writeHead(id?200:401);res.end(JSON.stringify(id?user(id):{msg:'Invalid JWT'}));return;}
  if(req.url?.includes('logout')){res.end('{}');return;}res.writeHead(404);res.end('{}');
 }catch{res.writeHead(400);res.end('{}');}});
 authBase=await listen(auth);process.env.AUTH_DEV_BYPASS='0';process.env.SUPABASE_URL=authBase;process.env.SUPABASE_SERVICE_ROLE_KEY='r1-disposable-local-auth-key';
 process.env.RATE_LIMIT_PER_MINUTE='100000';process.env.RATE_LIMIT_IP_PER_MINUTE='100000';
 const apiRoot=join(repo,'finnor-os/apps/api/app/api'),routes:any[]=[];
 async function scan(dir:string){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())await scan(p);else if(e.name==='route.ts'){const parts=relative(apiRoot,dir).split('/');routes.push({file:p,parts,dynamic:parts.filter(p=>p.startsWith('[')).length});}}}
 await scan(apiRoot);routes.sort((a,b)=>a.dynamic-b.dynamic);
 const built=options?.builtApi?await (await import('./built-api-fixture.mts')).startBuiltR1Api(repo,evidence).catch(async error=>{await new Promise<void>(yes=>{auth.closeAllConnections();auth.close(()=>yes());});throw error;}):null;
 let delayed:{workId:string;operation:string;waiting:boolean;gate:Promise<void>;release:()=>void}|null=null;
 const api=createServer(async(req,res)=>{const at=new Date().toISOString(),started=performance.now();let input:any=null;try{
  const url=new URL(req.url??'/','http://127.0.0.1'),parts=url.pathname.replace(/^\/api\//,'').split('/').map(decodeURIComponent);let matched:any;
  for(const r of routes){const params:any={};let ok=true,j=0;for(const part of r.parts){if(part.startsWith('[...')){params[part.slice(4,-1)]=parts.slice(j);j=parts.length;break;}if(j>=parts.length){ok=false;break;}if(part.startsWith('['))params[part.slice(1,-1)]=parts[j];else if(part!==parts[j]){ok=false;break;}j++;}if(ok&&j===parts.length){matched={...r,params};break;}}
  if(!matched){res.writeHead(404);res.end('{}');return;}const raw=await body(req,8*1024*1024);input=raw.length?JSON.parse(raw.toString()):null;
  const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(typeof v==='string'&&k!=='host')headers.set(k,v);
  const request=new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method??'GET')?{body:raw}: {})});
  let result:Response;
  if(built)result=await fetch(built.base+url.pathname+url.search,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:raw});
  else{const m=await import(pathToFileURL(matched.file).href),handler=m[req.method??'GET'];if(!handler){res.writeHead(405);res.end('{}');return;}result=await handler(request,{params:Promise.resolve(matched.params)});}
  const output=Buffer.from(await result.arrayBuffer());
  if(delayed&&parts.at(-1)===delayed.operation&&input?.workId===delayed.workId&&!delayed.waiting){delayed.waiting=true;await delayed.gate;}
  let observed:unknown;try{observed=JSON.parse(output.toString());}catch{observed={contentType:result.headers.get('content-type'),rawText:output.toString()};}
  await appendFile(join(evidence,'http.jsonl'),JSON.stringify({at,path:url.pathname,method:req.method,status:result.status,bearer:Boolean(req.headers.authorization),authBypass:false,transport:built?'ACTUAL_BUILT_NEXT_API':'SOURCE_ROUTE_OVER_HTTP',ownerRoute:relative(repo,matched.file),input,output:observed,elapsedMs:performance.now()-started})+'\n');
  const h:any={};result.headers.forEach((v,k)=>h[k]=v);res.writeHead(result.status,h);res.end(output);
 }catch(error){await appendFile(join(evidence,'http-fixture-errors.jsonl'),JSON.stringify({at,path:req.url,input,error:String(error),stack:(error as Error).stack})+'\n');if(!res.writableEnded){if(!res.headersSent)res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"Disposable HTTP transport failed"}');}}});
 const apiBase=await listen(api);
 return {apiBase,authBase,register:(id:string,email:string,password='r1-disposable-only')=>identities.set(id,{id,email,password}),
  login:async(id:string)=>{const i=identities.get(id);if(!i)throw Error('R1_AUTH_FIXTURE_IDENTITY_NOT_REGISTERED');const r=await fetch(authBase+'/auth/v1/token?grant_type=password',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:i.email,password:i.password})});if(r.status!==200)throw Error('R1_AUTH_LOGIN_FAILED');return (await r.json()).access_token as string;},
  api:async(token:string,family:string,operation:string,input:unknown)=>{const r=await fetch(apiBase+'/api/'+family+'/'+operation,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+token},body:JSON.stringify(input)});return {status:r.status,body:await r.json()};},
  delay:(workId:string,operation='r1-projection')=>{let release!:()=>void;const gate=new Promise<void>(yes=>release=yes);delayed={workId,operation,waiting:false,gate,release};return {waiting:()=>delayed?.waiting??false,release:()=>{release();delayed=null;}};},
  close:async()=>{delayed?.release();await built?.close();await Promise.all([auth,api].map(s=>new Promise<void>(yes=>{s.closeAllConnections();s.close(()=>yes());})));},
  qualification:'LOCAL_AUTH_SERVICE_WITH_REAL_SIGNATURE_EXPIRY_CHECK_REAL_SECURITY_OWNER_RLS_AND_HTTP; HOSTED_SUPABASE_NOT_QUALIFIED'};
}

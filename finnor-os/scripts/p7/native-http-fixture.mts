/** Local signed-bearer transport, actual auth/user lookup and Company Brain owner. */
import {createServer, type Server} from 'node:http';
import {createHash,createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import type pg from 'pg';
import {NextRequest} from 'next/server';
import {build} from 'esbuild';
import {createRequire,builtinModules} from 'node:module';
import {resolve,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';

export async function nativeHttpFixture(admin:pg.Client, tenant:string, actor:string, otherActor:string) {
  const secret=randomBytes(32);
  const users=(await admin.query<{id:string;email:string}>(
    'SELECT id,email FROM finnor_os.users WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
    [tenant,[actor,otherActor]])).rows;
  let authOrigin='';
  const issue=(id:string)=>{
    const user=users.find(u=>u.id===id);if(!user?.email)throw Error('REAL_AUTH_USER_REQUIRED');
    const encode=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
    const now=Math.floor(Date.now()/1000);
    const body=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:id,email:user.email,aud:'authenticated',role:'authenticated',iat:now,exp:now+600,iss:authOrigin+'/auth/v1'});
    return body+'.'+createHmac('sha256',secret).update(body).digest('base64url');
  };
  const observed={userRequests:0,signatureRefusals:0,apiRequests:[] as Array<{operation:string;status:number}>,frontendProxy:null as null|{bundleSha256:string;files:Array<{path:string;sha256:string}>}};
  const auth=createServer((req,res)=>{
    res.setHeader('content-type','application/json');
    if(req.url!=='/auth/v1/user'){res.writeHead(404);res.end('{}');return;}
    observed.userRequests++;
    try{
      const [h,p,s]=String(req.headers.authorization??'').replace(/^Bearer /,'').split('.');
      if(!h||!p||!s)throw Error('INVALID');
      const actual=Buffer.from(s,'base64url'),expected=createHmac('sha256',secret).update(h+'.'+p).digest();
      if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error('INVALID');
      const claims=JSON.parse(Buffer.from(p,'base64url').toString()),user=users.find(u=>u.id===claims.sub);
      if(!user||claims.exp<=Date.now()/1000)throw Error('INVALID');
      res.end(JSON.stringify({id:user.id,email:user.email,aud:'authenticated',role:'authenticated',app_metadata:{},user_metadata:{}}));
    }catch{observed.signatureRefusals++;res.writeHead(401);res.end('{"msg":"Invalid JWT"}');}
  });
  async function listen(server:Server){
    await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
    const address=server.address();if(!address||typeof address==='string')throw Error('OWNED_PORT_REQUIRED');
    return 'http://127.0.0.1:'+address.port;
  }
  authOrigin=await listen(auth);
  const prior=Object.fromEntries(['AUTH_DEV_BYPASS','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','RATE_LIMIT_PER_MINUTE','RATE_LIMIT_IP_PER_MINUTE','FINNOR_OS_API_URL'].map(k=>[k,process.env[k]]));
  process.env.AUTH_DEV_BYPASS='0';process.env.SUPABASE_URL=authOrigin;
  process.env.SUPABASE_SERVICE_ROLE_KEY='disposable-p7-local-auth';
  process.env.RATE_LIMIT_PER_MINUTE='100000';process.env.RATE_LIMIT_IP_PER_MINUTE='100000';
  const route=await import('../../apps/api/app/api/company-brain/[operation]/route');
  const underwriting=await import('../../apps/api/app/api/underwriting/runs/route');
  const outcomePacks=await import('../../apps/api/app/api/outcome-packs/route');
  const closing=await import('../../apps/api/app/api/closing/[operation]/route');
  const economic=await import('../../apps/api/app/api/economic-outcomes/[operation]/route');
  const icRoutes={
    'ready-for-vote':()=>import('../../apps/api/app/api/private-equity/ic/cases/[id]/ready-for-vote/route'),
    'voting/open':()=>import('../../apps/api/app/api/private-equity/ic/cases/[id]/voting/open/route'),
    'votes':()=>import('../../apps/api/app/api/private-equity/ic/cases/[id]/votes/route'),
    'voting/close':()=>import('../../apps/api/app/api/private-equity/ic/cases/[id]/voting/close/route'),
    'finalize':()=>import('../../apps/api/app/api/private-equity/ic/cases/[id]/finalize/route'),
  };
  type IcPath=keyof typeof icRoutes;
  const icPath=(path:string):path is IcPath=>Object.hasOwn(icRoutes,path);
  const icPattern=/^\/api\/private-equity\/ic\/cases\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(ready-for-vote|voting\/open|votes|voting\/close|finalize)$/i;
  let dropPackResponse=false,dropEconomicResponse=false;
  let frontend:Promise<{POST:(request:NextRequest,context:unknown)=>Promise<Response>}>|undefined;
  async function loadFrontend(){
    const root=new URL('../../../',import.meta.url).pathname,file=resolve(root,'src/app/api/centropy/[...path]/route.ts'),require=createRequire(file);
    const bundled=await build({entryPoints:[file],bundle:true,write:false,metafile:true,platform:'node',format:'esm',tsconfig:resolve(root,'tsconfig.json'),plugins:[{name:'owned-proxy-dependencies',setup(b){b.onResolve({filter:/^[^./]/},async a=>{
      if(a.path.startsWith('@/'))return b.resolve(resolve(root,'src',a.path.slice(2)),{kind:a.kind,resolveDir:root});
      return {path:builtinModules.includes(a.path)||a.path.startsWith('node:')?a.path:pathToFileURL(require.resolve(a.path)).href,external:true};
    });}}]});
    const bytes=bundled.outputFiles[0]!.contents,files=[];
    for(const path of Object.keys(bundled.metafile!.inputs)){const absolute=resolve(path);files.push({path:relative(root,absolute),sha256:createHash('sha256').update(await readFile(absolute)).digest('hex')});}
    observed.frontendProxy={bundleSha256:createHash('sha256').update(bytes).digest('hex'),files};
    return import('data:text/javascript;base64,'+Buffer.from(bytes).toString('base64'));
  }
  const api=createServer(async(req,res)=>{
    try{
      const underwritingRun=req.url==='/api/underwriting/runs';
      const outcomePack=req.url==='/api/outcome-packs';
      const closingOperation=req.url?.startsWith('/api/closing/');
      const economicOperation=req.url?.startsWith('/api/economic-outcomes/');
      const proxyFamily=req.url?.startsWith('/api/centropy/economic-outcomes/')?'economic-outcomes':'company-brain';
      const productProxy=req.url?.startsWith('/api/centropy/'+proxyFamily+'/');
      const pathname=new URL(req.url??'/','http://127.0.0.1').pathname;
      const operation=pathname.split('/').at(-1)!;
      const icMatch=icPattern.exec(pathname);
      const icOperation=icMatch?.[2];
      if(req.method!=='POST'){res.writeHead(405);res.end('{}');return;}
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)throw Error('REQUEST_BOUND');}
      const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
      const request=new Request('http://127.0.0.1'+req.url,{method:'POST',headers,body});
      if(productProxy)frontend??=loadFrontend();
      const result=icMatch&&icOperation&&icPath(icOperation)?await(await icRoutes[icOperation]()).POST(request,{params:Promise.resolve({id:icMatch[1]!})}):closingOperation?await closing.POST(request,{params:Promise.resolve({operation})}):economicOperation?await economic.POST(request,{params:Promise.resolve({operation})}):productProxy?await(await frontend!).POST(new NextRequest(request),{params:Promise.resolve({path:[proxyFamily,operation]})}):outcomePack?await outcomePacks.POST(request):underwritingRun?await underwriting.POST(request):await route.POST(request,{params:Promise.resolve({operation})});
      if(outcomePack&&dropPackResponse){dropPackResponse=false;observed.apiRequests.push({operation:'outcome-pack-response-dropped',status:result.status});res.destroy();return;}
      if(economicOperation&&dropEconomicResponse){dropEconomicResponse=false;observed.apiRequests.push({operation:'economic-response-dropped',status:result.status});res.destroy();return;}
      res.writeHead(result.status,{'content-type':'application/json'});res.end(Buffer.from(await result.arrayBuffer()));
      observed.apiRequests.push({operation:icMatch?'private-equity/ic/'+icOperation:underwritingRun?'underwriting/runs':operation,status:result.status});
    }catch(error){console.error('OWNED_HTTP_FIXTURE_FAILURE',String((error as Error).stack??error).slice(0,1800).replace(/Bearer [^\s"]+/g,'Bearer [REDACTED]').replace(/postgres(?:ql)?:\/\/[^@\s]+@/g,'postgres://[REDACTED]@'));res.writeHead(500);res.end('{"code":"OWNED_HTTP_FIXTURE_FAILURE"}');}
  });
  const origin=await listen(api),token=issue(actor),otherToken=issue(otherActor);
  process.env.FINNOR_OS_API_URL=origin;
  const segments=token.split('.'),signature=segments[2]!;
  const invalidToken=segments.slice(0,2).join('.')+'.'+(signature[0]==='A'?'B':'A')+signature.slice(1);
  const send=async(path:string,body:unknown,identity:'actor'|'other'|'anonymous'|'invalid'='actor')=>{
    const headers:Record<string,string>={'content-type':'application/json','x-tenant-id':tenant,'x-user-id':actor,'x-user-role':'owner'};
    if(identity!=='anonymous')headers.authorization='Bearer '+(identity==='other'?otherToken:identity==='invalid'?invalidToken:token);
    const response=await fetch(origin+path,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    return {status:response.status,body:await response.json() as any};
  };
  const call=(operation:string,body:unknown,identity?:'actor'|'other'|'anonymous'|'invalid')=>send('/api/company-brain/'+operation,body,identity);
  const callThroughProxy=(operation:string,body:unknown,identity?:'actor'|'other'|'anonymous'|'invalid')=>send('/api/centropy/company-brain/'+operation,body,identity);
  const createRun=(body:unknown,identity?:'actor'|'other'|'anonymous'|'invalid')=>send('/api/underwriting/runs',body,identity);
  const startPack=(body:unknown,identity?:'actor'|'other'|'anonymous'|'invalid')=>send('/api/outcome-packs',body,identity);
  const icPost=(caseId:string,path:IcPath,body:unknown)=>{
    const endpoint='/api/private-equity/ic/cases/'+caseId+'/'+path;
    if(!icPattern.test(endpoint)||!icPath(path))throw Error('EXACT_IC_CASE_AND_HUMAN_ROUTE_REQUIRED');
    return send(endpoint,body);
  };
  const closingPost=(operation:string,body:unknown)=>send('/api/closing/'+operation,body);
  const economicPost=(operation:string,body:unknown,identity?:'actor'|'other'|'anonymous'|'invalid')=>send('/api/economic-outcomes/'+operation,body,identity);
  const economicThroughProxy=(operation:string,body:unknown,identity?:'actor'|'other'|'anonymous'|'invalid')=>send('/api/centropy/economic-outcomes/'+operation,body,identity);
  return {call,callThroughProxy,createRun,startPack,icPost,closingPost,economicPost,economicThroughProxy,dropNextEconomicResponse:()=>{dropEconomicResponse=true;},dropNextPackResponse:()=>{dropPackResponse=true;},observed,close:async()=>{
    for(const server of [api,auth]){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
    for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }};
}

/** Local signed-bearer transport, actual auth/user lookup and Company Brain owner. */
import {createServer, type Server} from 'node:http';
import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';
import type pg from 'pg';

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
  const observed={userRequests:0,signatureRefusals:0,apiRequests:[] as Array<{operation:string;status:number}>};
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
  const prior=Object.fromEntries(['AUTH_DEV_BYPASS','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','RATE_LIMIT_PER_MINUTE','RATE_LIMIT_IP_PER_MINUTE'].map(k=>[k,process.env[k]]));
  process.env.AUTH_DEV_BYPASS='0';process.env.SUPABASE_URL=authOrigin;
  process.env.SUPABASE_SERVICE_ROLE_KEY='disposable-p7-local-auth';
  process.env.RATE_LIMIT_PER_MINUTE='100000';process.env.RATE_LIMIT_IP_PER_MINUTE='100000';
  const route=await import('../../apps/api/app/api/company-brain/[operation]/route');
  const api=createServer(async(req,res)=>{
    try{
      const operation=new URL(req.url??'/','http://127.0.0.1').pathname.split('/').at(-1)!;
      if(req.method!=='POST'){res.writeHead(405);res.end('{}');return;}
      let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>65536)throw Error('REQUEST_BOUND');}
      const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
      const result=await route.POST(new Request('http://127.0.0.1/api/company-brain/'+operation,{method:'POST',headers,body}),
        {params:Promise.resolve({operation})});
      res.writeHead(result.status,{'content-type':'application/json'});res.end(Buffer.from(await result.arrayBuffer()));
      observed.apiRequests.push({operation,status:result.status});
    }catch{res.writeHead(500);res.end('{"code":"OWNED_HTTP_FIXTURE_FAILURE"}');}
  });
  const origin=await listen(api),token=issue(actor),otherToken=issue(otherActor);
  const segments=token.split('.'),signature=segments[2]!;
  const invalidToken=segments.slice(0,2).join('.')+'.'+(signature[0]==='A'?'B':'A')+signature.slice(1);
  const call=async(operation:string,body:unknown,identity:'actor'|'other'|'anonymous'|'invalid'='actor')=>{
    const headers:Record<string,string>={'content-type':'application/json','x-tenant-id':tenant,'x-user-id':actor,'x-user-role':'owner'};
    if(identity!=='anonymous')headers.authorization='Bearer '+(identity==='other'?otherToken:identity==='invalid'?invalidToken:token);
    const response=await fetch(origin+'/api/company-brain/'+operation,{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    return {status:response.status,body:await response.json() as any};
  };
  return {call,observed,close:async()=>{
    for(const server of [api,auth]){server.closeAllConnections();await new Promise<void>(yes=>server.close(()=>yes()));}
    for(const [key,value]of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }};
}

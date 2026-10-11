/** Named disposable bearer issuer and HTTP host of actual production handlers.
 * Only transport and identity issuance are fixtures. No business route is mocked.
 * Tokens/issuer keys remain in memory and never enter evidence.
 */
import { createServer, type Server } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
export interface LocalActor {id:string;email:string}
export async function localHost(repo:string,actors:LocalActor[],traffic:unknown[],browser=false){
  const secret=randomBytes(32);
  let authUrl='';
  function issue(actor:LocalActor){
    const encode=(o:unknown)=>Buffer.from(JSON.stringify(o)).toString('base64url'),now=Math.floor(Date.now()/1000);
    const text=encode({alg:'HS256',typ:'JWT'})+'.'+encode({sub:actor.id,email:actor.email,aud:'authenticated',role:'authenticated',
      iat:now,exp:now+3600,iss:authUrl+'/auth/v1'});
    return text+'.'+createHmac('sha256',secret).update(text).digest('base64url');
  }
  function verify(token:string){
    try{const [h,p,s]=token.split('.');if(!h||!p||!s)return null;
      const expected=createHmac('sha256',secret).update(h+'.'+p).digest(),actual=Buffer.from(s,'base64url'),
        claims=JSON.parse(Buffer.from(p,'base64url').toString());
      if(expected.length!==actual.length||!timingSafeEqual(expected,actual)||claims.exp<=Date.now()/1000)return null;
      return actors.find(a=>a.id===claims.sub&&a.email===claims.email)??null;
    }catch{return null;}
  }
  const user=(actor:LocalActor)=>({id:actor.id,email:actor.email,aud:'authenticated',role:'authenticated',
    email_confirmed_at:new Date().toISOString(),created_at:new Date().toISOString(),app_metadata:{provider:'email',providers:['email']},user_metadata:{}});
  const auth=createServer(async(req,res)=>{
    res.setHeader('access-control-allow-origin','http://127.0.0.1:4790');
    res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');
    res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');res.setHeader('content-type','application/json');
    if(req.method==='OPTIONS'){res.end();return;}
    if(req.url==='/auth/v1/user'){
      const actor=verify(String(req.headers.authorization??'').replace(/^Bearer /,''));
      res.writeHead(actor?200:401);res.end(JSON.stringify(actor?user(actor):{msg:'Invalid local JWT'}));return;
    }
    if(req.url?.includes('logout')){res.end('{}');return;}
    if(req.url?.startsWith('/auth/v1/token')){
      let text='';for await(const b of req){text+=b;if(text.length>16384){res.writeHead(413);res.end('{}');return;}}
      let body:Record<string,unknown>;try{body=JSON.parse(text||'{}');}catch{res.writeHead(400);res.end('{}');return;}
      const actor=actors.find(a=>a.email===body.email);
      if(!actor||body.password!=='disposable-only'){res.writeHead(400);res.end(JSON.stringify({error:'invalid_credentials'}));return;}
      res.end(JSON.stringify({access_token:issue(actor),refresh_token:'disposable-unused-refresh',token_type:'bearer',expires_in:3600,
        expires_at:Math.floor(Date.now()/1000)+3600,user:user(actor)}));return;
    }
    res.writeHead(404);res.end('{}');
  });
  const listen=(server:Server,port:number)=>new Promise<number>((yes,no)=>{
    server.once('error',no);server.listen(port,'127.0.0.1',()=>{const a=server.address();if(!a||typeof a==='string')return no(Error('PORT_UNAVAILABLE'));yes(a.port);});
  });
  authUrl='http://127.0.0.1:'+await listen(auth,browser?4792:0);
  process.env.AUTH_DEV_BYPASS='0';process.env.SUPABASE_URL=authUrl;process.env.SUPABASE_SERVICE_ROLE_KEY='disposable-local-auth-key';
  process.env.RATE_LIMIT_PER_MINUTE='10000';process.env.RATE_LIMIT_IP_PER_MINUTE='10000';
  const root=join(repo,'finnor-os/apps/api/app/api'),routes:Array<{file:string;parts:string[];dynamic:number}>=[];
  async function scan(directory:string){for(const entry of await readdir(directory,{withFileTypes:true})){
    const path=join(directory,entry.name);if(entry.isDirectory())await scan(path);else if(entry.name==='route.ts'){
      const parts=relative(root,directory).split('/');routes.push({file:path,parts,dynamic:parts.filter(p=>p.startsWith('[')).length});
    }
  }}
  await scan(root);routes.sort((a,b)=>a.dynamic-b.dynamic);
  let delayed:{path:string;waiting:boolean;promise:Promise<void>;release:()=>void}|null=null;
  const api=createServer(async(req,res)=>{
    const begin=performance.now();try{
      const url=new URL(req.url??'/','http://127.0.0.1'),parts=url.pathname.replace(/^\/api\//,'').split('/').map(decodeURIComponent);
      let matched:{file:string;params:Record<string,unknown>}|undefined;
      for(const route of routes){
        const params:Record<string,unknown>={};let j=0,ok=true;
        for(const segment of route.parts){
          if(segment.startsWith('[...')){params[segment.slice(4,-1)]=parts.slice(j);j=parts.length;break;}
          if(j>=parts.length){ok=false;break;}
          if(segment.startsWith('['))params[segment.slice(1,-1)]=parts[j];else if(segment!==parts[j]){ok=false;break;}j++;
        }
        if(ok&&j===parts.length){matched={file:route.file,params};break;}
      }
      if(!matched){res.writeHead(404);res.end('{}');return;}
      let body='';for await(const b of req){body+=b;if(Buffer.byteLength(body)>8388608)throw Error('HOST_BYTE_BOUND');}
      const module=await import(pathToFileURL(matched.file).href),handler=module[req.method??'GET'];
      if(!handler){res.writeHead(405);res.end('{}');return;}
      const headers=new Headers();for(const [k,v]of Object.entries(req.headers))if(typeof v==='string')headers.set(k,v);
      const response:Response=await handler(new Request(url,{method:req.method,headers,
        ...(!['GET','HEAD'].includes(req.method??'GET')?{body}: {})}),{params:Promise.resolve(matched.params)});
      const bytes=Buffer.from(await response.arrayBuffer());
      let refusal:unknown=null;
      if(!response.ok&&url.pathname.startsWith('/api/decision-atlases/')){
        try{const decoded=JSON.parse(bytes.toString());refusal={code:decoded.code??null,requirement:decoded.requirement??null};}catch{refusal='NON_JSON_OWNER_RESPONSE';}
      }
      if(delayed?.path===url.pathname&&!delayed.waiting){delayed.waiting=true;await delayed.promise;}
      const responseHeaders:Record<string,string>={};response.headers.forEach((v,k)=>{responseHeaders[k]=v;});
      res.writeHead(response.status,responseHeaders);res.end(bytes);
      traffic.push({path:url.pathname,method:req.method,status:response.status,refusal,wallMs:performance.now()-begin,bearer:Boolean(req.headers.authorization),at:new Date().toISOString()});
    }catch(error){
      res.writeHead(500,{'content-type':'application/json'});res.end('{"code":"DISPOSABLE_HOST_FAILED"}');
      traffic.push({path:req.url,status:500,predicate:String(error),at:new Date().toISOString()});
    }
  });
  const apiUrl='http://127.0.0.1:'+await listen(api,browser?4791:0);
  return {authUrl,apiUrl,issue,
    delay:(path:string)=>{let release!:()=>void;const promise=new Promise<void>(yes=>{release=yes;});delayed={path,waiting:false,promise,release};},
    delayWaiting:()=>delayed?.waiting??false,
    release:()=>{delayed?.release();delayed=null;},
    close:async()=>{delayed?.release();for(const s of [api,auth]){s.closeAllConnections();await new Promise<void>(yes=>s.close(()=>yes()));}},
  };
}

/** Disposable transport only. Authentication still crosses the actual
 * Supabase getUser and native tenant/authority boundary in the emitted route. */
import {createServer} from 'node:http';
import {createHash,createHmac,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {appendFile,readFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';

export async function localAuth(principals:string[]){
 if(principals.length<3||principals.length>8||new Set(principals).size!==principals.length)
  throw Error('Y4_BOUNDED_DISTINCT_LOCAL_IDENTITIES_REQUIRED');
 const secret=randomBytes(32),password=randomBytes(24).toString('hex');
 const browserOrigins=new Set<string>();
 const tokens=new Map<string,string>();
 const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const issue=(id:string)=>{
  const now=Math.floor(Date.now()/1000),data=encode({alg:'HS256',typ:'JWT'})+'.'+encode({
   sub:id,email:id+'@test.invalid',aud:'authenticated',role:'authenticated',iat:now,exp:now+3600,
   session_id:randomUUID(),jti:randomUUID()});
  return data+'.'+createHmac('sha256',secret).update(data).digest('base64url');
 };
 const verify=(raw:string)=>{
  try{
   const parts=raw.split('.');if(parts.length!==3)return null;
   const [header,claims,signature]=parts as [string,string,string];
   if(JSON.parse(Buffer.from(header,'base64url').toString()).alg!=='HS256')return null;
   const expected=createHmac('sha256',secret).update(header+'.'+claims).digest(),
    supplied=Buffer.from(signature,'base64url'),body=JSON.parse(Buffer.from(claims,'base64url').toString());
   return supplied.length===expected.length&&timingSafeEqual(supplied,expected)
    &&principals.includes(body.sub)&&body.exp>Date.now()/1000?body.sub as string:null;
  }catch{return null;}
 };
 const user=(id:string)=>({id,email:id+'@test.invalid',aud:'authenticated',role:'authenticated',
  app_metadata:{provider:'email',providers:['email']},user_metadata:{},created_at:new Date().toISOString()});
 const auth=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  try{
   const origin=req.headers.origin;
   if(origin){
    if(!browserOrigins.has(origin)){res.writeHead(403);res.end('{"error":"origin_denied"}');return;}
    res.setHeader('access-control-allow-origin',origin);res.setHeader('vary','Origin');
    res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');
    res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');
    if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
   }
   const url=new URL(req.url??'/','http://127.0.0.1');
   if(req.method==='POST'&&url.pathname==='/auth/v1/token'&&url.searchParams.get('grant_type')==='password'){
    let bytes=Buffer.alloc(0);
    for await(const chunk of req){if(bytes.length+chunk.length>16384)throw Error('Y4_AUTH_BODY_BOUND');bytes=Buffer.concat([bytes,chunk]);}
    const input=JSON.parse(bytes.toString()),subject=principals.find(id=>input.email===id+'@test.invalid'&&input.password===password);
    if(!subject){res.writeHead(400);res.end('{"error":"invalid_credentials"}');return;}
    const token=issue(subject);tokens.set(subject,token);
    res.end(JSON.stringify({access_token:token,refresh_token:randomBytes(32).toString('hex'),
     token_type:'bearer',expires_in:3600,user:user(subject)}));return;
   }
   const subject=verify(String(req.headers.authorization??'').replace(/^Bearer /,''));
   if(req.method==='GET'&&url.pathname==='/auth/v1/user'&&subject){res.end(JSON.stringify(user(subject)));return;}
   if(req.method==='POST'&&url.pathname==='/auth/v1/logout'&&subject){res.writeHead(204);res.end();return;}
   res.writeHead(401);res.end('{"error":"invalid_token"}');
  }catch{res.writeHead(400);res.end('{"error":"bad_request"}');}
 });
 await new Promise<void>((yes,no)=>{auth.once('error',no);auth.listen(0,'127.0.0.1',yes);});
 const address=auth.address();if(!address||typeof address==='string')throw Error('Y4_LOCAL_AUTH_PORT_REQUIRED');
 const origin='http://127.0.0.1:'+address.port;
 try{
  for(const subject of principals){
   const response=await fetch(origin+'/auth/v1/token?grant_type=password',{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({email:subject+'@test.invalid',password}),
    signal:AbortSignal.timeout(5000)});
   if(response.status!==200)throw Error('Y4_REAL_LOCAL_SIGNIN_REQUIRED');
   const session=await response.json();if(!session.access_token)throw Error('Y4_LOCAL_AUTH_TOKEN_REQUIRED');
   tokens.set(subject,session.access_token);
  }
 }catch(error){auth.closeAllConnections();await new Promise<void>(yes=>auth.close(()=>yes()));throw error;}
 return {origin,tokens,serviceKey:randomBytes(24).toString('hex'),browserPassword:password,
  allowBrowserOrigin:(value:string)=>{
   const parsed=new URL(value);
   if(parsed.protocol!=='http:'||parsed.hostname!=='127.0.0.1'||parsed.origin!==value)throw Error('Y4_LOCAL_BROWSER_ORIGIN_REQUIRED');
   browserOrigins.add(value);
  },
  close:async()=>{auth.closeAllConnections();await new Promise<void>(yes=>auth.close(()=>yes()));}};
}

export async function installedProcess(kind:'api-host'|'worker-loop'|'capability-service',directory:string,
 environment:Record<string,string>,privateDirectory:string){
 if(!isAbsolute(directory))throw Error('Y4_ABSOLUTE_INSTALLATION_REQUIRED');
 const bytes=await readFile(join(directory,'installation.json')),
  expected=(await readFile(join(directory,'installation.sha256'),'utf8')).trim();
 if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Y4_INSTALLATION_MANIFEST_CHANGED');
 const child=spawn(process.execPath,['--max-old-space-size=1024',join(directory,'runtime/y4-runtime',kind+'.mjs')],{
  cwd:join(directory,'runtime'),stdio:['ignore','pipe','pipe','ipc'],env:{
   PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH,
   NODE_ENV:'test',NODE_OPTIONS:'',AUTH_DEV_BYPASS:'0',FINNOR_ENVIRONMENT:'ordinary_disposable',
   FINNOR_P4_PROFILE:'ordinary_disposable',FINNOR_TEST_MANAGED_EXTENSIONS:'omit',
   FINNOR_Y4_INSTALLATION:directory,FINNOR_Y4_INSTALLATION_DIGEST:expected,
   FINNOR_Y4_ASSETS:join(directory,'runtime/finnor-os/packages/private-equity/src/confidential-computation'),
   ...environment,
  }});
 let logged=0;
 for(const stream of [child.stdout,child.stderr])stream?.on('data',(data:Buffer)=>{
  logged+=data.length;
  if(logged<=1024*1024)void appendFile(join(privateDirectory,kind+'.log'),data,{mode:0o600}).catch(()=>undefined);
 });
 let sequence=0,closed=false;
 const close=async()=>{
  if(closed)return;closed=true;
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise<void>(yes=>{
   const timer=setTimeout(()=>child.kill('SIGKILL'),5000);
   child.once('exit',()=>{clearTimeout(timer);yes();});child.kill('SIGTERM');
  });
 };
 let ready:any;
 try{
  ready=await new Promise<any>((yes,no)=>{
   const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error('Y4_INSTALLED_STARTUP_DEADLINE'));},30000);
   if(kind==='capability-service'){
    let startup='';
    child.stdout?.on('data',(data:Buffer)=>{
     startup+=data.toString('utf8');
     if(startup.length>65536){clearTimeout(timer);child.kill('SIGKILL');no(Error('Y4_INSTALLED_STARTUP_BOUND'));return;}
     for(const line of startup.split('\n'))try{
      const state=JSON.parse(line);
      if(state.status==='READY'&&Number.isInteger(state.port)&&state.port>0&&state.port<65536){
       clearTimeout(timer);yes({kind:'READY',origin:'http://127.0.0.1:'+state.port,
        domain:state.domain,actualEmittedCapabilityService:true});
      }
     }catch{/* Wait for a complete startup line. */}
    });
   }
   child.on('message',message=>{
    if((message as any)?.kind==='READY'){clearTimeout(timer);yes(message);}
   });
   child.once('error',()=>{clearTimeout(timer);no(Error('Y4_INSTALLED_START_FAILED'));});
   child.once('exit',()=>{clearTimeout(timer);no(Error('Y4_INSTALLED_STARTUP_REFUSED'));});
  });
 }catch(error){await close();throw error;}
 const tick=async(deadlineAt:number)=>{
  const id=++sequence;
  if(!child.connected||deadlineAt<=Date.now())throw Error('Y4_ORIGINAL_WORKER_DEADLINE_EXPIRED');
  return new Promise<any>((yes,no)=>{
   const cleanup=()=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit);};
   const message=(value:any)=>{if(value?.id===id){cleanup();yes(value);}};
   const exit=()=>{cleanup();no(Error('Y4_INSTALLED_WORKER_DIED'));};
   const timer=setTimeout(()=>{cleanup();child.kill('SIGTERM');no(Error('Y4_ORIGINAL_WORKER_DEADLINE_EXPIRED'));},deadlineAt-Date.now());
   child.on('message',message);child.once('exit',exit);child.send({operation:'TICK',id});
  });
 };
 return {child:child as ChildProcess,ready,tick,close,installationDigest:expected};
}

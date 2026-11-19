/** Established LOCAL_AUTH_SERVICE transport from P1: actual handlers and bearer
 * verification, no reconstructed business API/owner/queue or completion mock. */
import { createServer } from "node:http";
import { randomBytes, createHmac, timingSafeEqual,createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from 'node:child_process';

export async function authenticatedApiFixture(repo: string, actor: string, record: (entry: unknown) => void,
  options: { frontendOrigin?: string; installation?: string; installationProfile?: "POSTZ_W2";
    additionalActors?:string[]; maximumActors?:number;
    afterResponse?: (path:string,body:string,status:number,request:{method:string;observer:boolean;body:string})=>Promise<void> } = {}) {
  const secret = randomBytes(32), password = randomBytes(24).toString("hex"), email = actor + "@test.invalid";
  const actors=[actor,...(options.additionalActors??[])];
  const maximumActors=options.maximumActors??2;
  if(!Number.isInteger(maximumActors)||maximumActors<1||maximumActors>16||actors.length>maximumActors
    ||new Set(actors).size!==actors.length)throw Error('X1_LOCAL_AUTH_IDENTITY_BOUND');
  const refreshTokens=new Map(actors.map(subject=>[subject,randomBytes(32).toString('base64url')]));
  if(options.frontendOrigin&&!/^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(options.frontendOrigin))
    throw Error('X1_OWNED_LOOPBACK_FRONTEND_REQUIRED');
  const userFor = (subject:string) => ({ id: subject, aud: "authenticated", role: "authenticated", email:subject+'@test.invalid',
    app_metadata: { provider: "email", providers: ["email"] }, user_metadata: {},
    created_at: new Date().toISOString(), email_confirmed_at: new Date().toISOString() });
  const issue = (subject=actor) => {
    const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url"), now = Math.floor(Date.now() / 1000);
    const body = encode({ alg: "HS256", typ: "JWT" }) + "." + encode({ sub: subject, email:subject+'@test.invalid',
      aud: "authenticated", role: "authenticated", iat: now, exp: now + 3600 });
    return body + "." + createHmac("sha256", secret).update(body).digest("base64url");
  };
  const verify = (token: string) => {
    try { const [h, p, s] = token.split("."); if (!h || !p || !s) return false;
      const expected = createHmac("sha256", secret).update(h + "." + p).digest(), actual = Buffer.from(s, "base64url");
      const claims = JSON.parse(Buffer.from(p, "base64url").toString());
      return actual.length === expected.length && timingSafeEqual(actual, expected) && actors.includes(claims.sub) && claims.exp > Date.now() / 1000
        ? claims.sub as string : false;
    } catch { return false; }
  };
  const listen = async (server: ReturnType<typeof createServer>) => {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address(); if (!address || typeof address === "string") throw Error("LOCAL_PORT_UNAVAILABLE");
    return `http://127.0.0.1:${address.port}`;
  };
  const auth = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if(options.frontendOrigin){res.setHeader('access-control-allow-origin',options.frontendOrigin);
      res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');
      res.setHeader('access-control-allow-methods','GET,POST,OPTIONS');res.setHeader('vary','Origin');}
    try {
      if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
      let raw = ""; for await (const b of req) { raw += b; if (raw.length > 16384) throw Error("AUTH_BODY_BOUND"); }
      if (req.url?.startsWith("/auth/v1/token")) {
        const input = JSON.parse(raw || "{}");
        const grant=new URL(req.url,'http://127.0.0.1').searchParams.get('grant_type');
        const subject=actors.find(subject=>grant==='password'&&input.email===subject+'@test.invalid'&&input.password===password
          ||grant==='refresh_token'&&input.refresh_token===refreshTokens.get(subject));
        if (!subject) { res.writeHead(400); res.end('{"error":"invalid_credentials"}'); return; }
        record({path:'/auth/v1/token',method:req.method,grant,status:200,subject,credentialsRecorded:false});
        res.end(JSON.stringify({ access_token: issue(subject), token_type: "bearer", expires_in: 3600,
          expires_at:Math.floor(Date.now()/1000)+3600,refresh_token:refreshTokens.get(subject),user:userFor(subject) })); return;
      }
      if (req.url === "/auth/v1/user" && verify(String(req.headers.authorization ?? "").replace(/^Bearer /, ""))) {
        res.end(JSON.stringify(userFor(verify(String(req.headers.authorization).replace(/^Bearer /,'')) as string))); return;
      }
      if(req.url?.startsWith('/auth/v1/logout')&&verify(String(req.headers.authorization??'').replace(/^Bearer /,''))){
        res.end('{}');return;}
      res.writeHead(401); res.end('{"error":"invalid_token"}');
    } catch { res.writeHead(400); res.end('{"error":"bad_request"}'); }
  });
  const authOrigin = await listen(auth);
  process.env.AUTH_DEV_BYPASS = "0"; process.env.SUPABASE_URL = authOrigin;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "disposable-local-auth-key";
  let compiled: ReturnType<typeof spawn> | undefined, compiledOrigin: string | undefined;
  const startCompiled=async()=>{
    if(!options.installation)throw Error('X1_INSTALLED_API_RESTART_UNAVAILABLE');
    const w2 = options.installationProfile === "POSTZ_W2";
    const manifest=JSON.parse(await readFile(join(options.installation,`finnor-os/${w2 ? 'w2' : 'x1'}-development-installation.json`),'utf8'));
    if(manifest.schema!==(w2 ? 'finnor.postz.w2.development-installation.v1' : 'finnor.x1.development-installation.v1')||manifest.productionActive!==false)
      throw Error('X1_INSTALLED_FIXTURE_MANIFEST_INVALID');
    compiled=spawn(process.execPath,['--max-old-space-size=1536',join(options.installation,manifest.entrypoints.api)],{
      cwd:join(options.installation,'finnor-os'),stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:'0',
        NODE_ENV:'test',NODE_OPTIONS:'',AUTH_DEV_BYPASS:'0',FINNOR_P4_PROFILE:'ordinary_disposable'}});
    try{compiledOrigin=await new Promise<string>((resolve,reject)=>{
      let output='',diagnostics='';const timer=setTimeout(()=>reject(Error('X1_COMPILED_API_STARTUP_BOUND')),30_000);
      compiled!.stdout!.on('data',chunk=>{
        output+=chunk.toString();if(output.length>65536){clearTimeout(timer);reject(Error('X1_COMPILED_API_STARTUP_OUTPUT_BOUND'));return;}
        while(output.includes('\n')){
          const at=output.indexOf('\n'),line=output.slice(0,at);output=output.slice(at+1);
          try{const entry=JSON.parse(line);record(entry);
            if(entry.event===(w2 ? 'W2_COMPILED_API_READY' : 'X1_COMPILED_API_READY')){
              clearTimeout(timer);resolve('http://127.0.0.1:'+entry.address.port);
            }}catch{/* Non-JSON owner logging is not an authority receipt. */}
        }
      });
      let diagnosticLines='';
      compiled!.stderr!.on('data',chunk=>{
        diagnostics+=chunk.toString();if(diagnostics.length>65536)diagnostics=diagnostics.slice(-65536);
        diagnosticLines+=chunk.toString();if(diagnosticLines.length>65536)diagnosticLines=diagnosticLines.slice(-65536);
        while(diagnosticLines.includes('\n')){
          const at=diagnosticLines.indexOf('\n'),line=diagnosticLines.slice(0,at);diagnosticLines=diagnosticLines.slice(at+1);
          try{const event=JSON.parse(line);if(event.event==='X1_COMPILED_API_REFUSAL')record(event);}catch{/* Other diagnostics stay private. */}
        }
      });
      compiled!.once('error',error=>{clearTimeout(timer);reject(error);});
      compiled!.once('exit',code=>{clearTimeout(timer);reject(Error('X1_COMPILED_API_EARLY_EXIT:'+code+':'+diagnostics));});
    });}catch(error){compiled.kill('SIGKILL');auth.close();throw error;}
  };
  if(options.installation)await startCompiled();
  const apiRoot = join(repo, "finnor-os/apps/api/app/api"), routes: Array<{ file: string; parts: string[] }> = [];
  const scan = async (directory: string) => { for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name); if (item.isDirectory()) await scan(path);
    else if (item.name === "route.ts") routes.push({ file: path, parts: relative(apiRoot, directory).split("/") });
  } };
  await scan(apiRoot); routes.sort((a, b) => a.parts.filter(p => p.startsWith("[")).length - b.parts.filter(p => p.startsWith("[")).length);
  const api = createServer(async (req, res) => {
    const started = performance.now();
    const finish=(path:string,status:number,headers:Record<string,string>,bytes:Buffer)=>{
      const responseDigest=createHash('sha256').update(bytes).digest('hex');let finished=false;
      res.once('finish',()=>{finished=true;record({event:'X1_ACTUAL_HTTP_RESPONSE_FINISH',responsePath:path,
        responseStatus:status,responseDigest,responseBytes:bytes.length,at:new Date().toISOString(),
        elapsedMs:performance.now()-started,socketDestroyed:res.socket?.destroyed??null,
        clientRenderingEstablished:false});});
      res.once('close',()=>record({event:'X1_ACTUAL_HTTP_RESPONSE_CLOSE',responsePath:path,responseStatus:status,
        responseDigest,at:new Date().toISOString(),finished,writableFinished:res.writableFinished,
        clientRenderingEstablished:false}));
      res.writeHead(status,headers);res.end(bytes);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost"), parts = url.pathname.replace(/^\/api\//, "").split("/").map(decodeURIComponent);
      if(compiledOrigin){
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>8388608)throw Error('BODY_BOUND');}
        const headers=new Headers();for(const [name,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(name,value);
        const response=await fetch(compiledOrigin+url.pathname+url.search,{method:req.method,headers,
          ...(!['GET','HEAD'].includes(req.method??'GET')?{body}:{})});
        const bytes=Buffer.from(await response.arrayBuffer()),out:Record<string,string>={};response.headers.forEach((v,k)=>{out[k]=v;});
        await options.afterResponse?.(url.pathname,bytes.toString('utf8'),response.status,
          {method:req.method??'GET',observer:req.headers['x-x1-observer']==='1',body});
        finish(url.pathname,response.status,out,bytes);
        record({path:url.pathname,method:req.method,status:response.status,bearer:Boolean(req.headers.authorization),
          elapsedMs:performance.now()-started,compiledApi:true});return;
      }
      let selected: { file: string; params: Record<string, unknown> } | null = null;
      for (const route of routes) {
        const params: Record<string, unknown> = {}; let index = 0, ok = true;
        for (const p of route.parts) {
          if (p.startsWith("[...")) { params[p.slice(4, -1)] = parts.slice(index); index = parts.length; break; }
          if (index >= parts.length) { ok = false; break; }
          if (p.startsWith("[")) params[p.slice(1, -1)] = parts[index]; else if (p !== parts[index]) { ok = false; break; }
          index++;
        }
        if (ok && index === parts.length) { selected = { file: route.file, params }; break; }
      }
      if (!selected) { res.writeHead(404); res.end("{}"); return; }
      let body = ""; for await (const b of req) { body += b; if (body.length > 8388608) throw Error("BODY_BOUND"); }
      const module = await import(pathToFileURL(selected.file).href), handler = module[req.method ?? "GET"];
      if (!handler) { res.writeHead(405); res.end("{}"); return; }
      const headers = new Headers(); for (const [name, value] of Object.entries(req.headers)) if (typeof value === "string") headers.set(name, value);
      const response: Response = await handler(new Request(url, { method: req.method, headers,
        ...(!["GET", "HEAD"].includes(req.method ?? "GET") ? { body } : {}) }), { params: Promise.resolve(selected.params) });
      const out: Record<string, string> = {}; response.headers.forEach((v, k) => { out[k] = v; });
      const responseBytes=Buffer.from(await response.arrayBuffer());
      await options.afterResponse?.(url.pathname,responseBytes.toString('utf8'),response.status,
        {method:req.method??'GET',observer:req.headers['x-x1-observer']==='1',body});
      finish(url.pathname,response.status,out,responseBytes);
      record({ path: url.pathname, method: req.method, status: response.status, bearer: Boolean(req.headers.authorization), elapsedMs: performance.now() - started });
    } catch (error) { record({ path: req.url, status: 500, predicate: String((error as Error).message) });
      res.writeHead(500, { "content-type": "application/json" }); res.end('{"error":"local_route_host_failed"}'); }
  });
  const origin = await listen(api);
  const session = await fetch(authOrigin + "/auth/v1/token?grant_type=password", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (session.status !== 200) throw Error("REAL_LOCAL_PASSWORD_SIGNIN_FAILED");
  const token = (await session.json()).access_token as string;
  return { origin, authOrigin, token, email, password, compiledPid:compiled?.pid,
    additionalIdentities:actors.slice(1).map(subject=>({actor:subject,email:subject+'@test.invalid',password})),
    profile: "DISPOSABLE_LOCAL_AUTH_SERVICE_ACTUAL_BEARER_AND_RLS",
    restartCompiled:async()=>{
      if(!compiled||compiled.exitCode!==null||compiled.signalCode!==null)throw Error('X1_INSTALLED_API_NOT_RUNNING');
      const previousPid=compiled.pid,child=compiled;
      await new Promise<void>(resolve=>{
        const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');
      });
      await startCompiled();return {previousPid,currentPid:compiled!.pid,origin:compiledOrigin};
    },
    close: async () => {
      if(compiled&&compiled.exitCode===null&&compiled.signalCode===null){
        const child=compiled;await new Promise<void>(resolve=>{
          const timer=setTimeout(()=>child.kill('SIGKILL'),5000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill('SIGTERM');
        });
      }
      await Promise.all([auth, api].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    } };
}

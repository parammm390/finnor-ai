import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { generateKeyPair,exportJWK,SignJWT } from 'jose';
import { createServer } from 'node:http';
import { spawn,type ChildProcess } from 'node:child_process';
import { mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { receiveWork } from '@finnor/db';
import { createUnderwritingRun,listUnderwritingWorkspace,attachWorkToDealGraph } from '@finnor/private-equity';
import { POST } from '../../apps/api/app/api/company-brain/[operation]/route';
import { GET as me } from '../../apps/api/app/api/me/route';

/** The assigned pane, mounted product and actual authenticated worker path. */
export async function browserChallenges(e:any){
  const {f:base,repo,output,admin,queue,challenge,artifact}=e;
  await challenge('browser-exact-scope','Mounted Work UI renders exact independently observed fields, bounded repair/history/currentness and fail-closed revoked reads',async()=>{
    const f={...base,workId:(await receiveWork({tenantId:base.tenant,userId:base.principal,
      instruction:'M4 mounted authenticated exact-scope diagnostic',channel:'console',idempotencyKey:'m4-browser-work'})).workId};
    await attachWorkToDealGraph(f.ctx,{workId:f.workId,dealId:f.dealId,entities:[{entityType:'pe_investment_case',entityId:f.caseId}]});
    const steps:any[]=[],processes:ChildProcess[]=[],running=new Set<Promise<unknown>>();
    let log='',url='',opened=false,keyboardStatus='NOT_RUN',inputStatus='NATIVE_INPUT',fixtureCreated=false;
    const fixtureName='jarvis-m4-e2e-fixture',fixtureRoute=join(repo,'src/app',fixtureName);
    const prior={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY};
    const {privateKey,publicKey}=await generateKeyPair('RS256');
    const jwk={...await exportJWK(publicKey),alg:'RS256',use:'sig',kid:'m4-disposable-issuer'};
    const token=await new SignJWT({email:'m4@example.test',role:'authenticated'}).setProtectedHeader({alg:'RS256',kid:jwk.kid})
      .setSubject(f.principal).setIssuedAt().setExpirationTime('1h').sign(privateKey);
    const issuer=createServer((req,res)=>{
      res.setHeader('content-type','application/json');res.setHeader('access-control-allow-origin','*');
      res.setHeader('access-control-allow-headers','authorization,apikey,content-type');
      if(req.method==='OPTIONS'){res.end();return;}
      if(req.url?.includes('.well-known/jwks.json')){res.end(JSON.stringify({keys:[jwk]}));return;}
      res.statusCode=404;res.end('{"error":"Unsupported disposable issuer operation"}');
    });
    const listen=async(server:ReturnType<typeof createServer>)=>{
      await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
      const address=server.address();assert(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}`;
    };
    const issuerUrl=await listen(issuer);
    process.env.SUPABASE_URL=issuerUrl;process.env.SUPABASE_SERVICE_ROLE_KEY='m4-disposable-public-key';
    const backend=createServer(async(req,res)=>{
      try{
        let body='';for await(const bytes of req){body+=bytes;if(Buffer.byteLength(body)>65536)throw Error('REQUEST_BOUND');}
        const headers=new Headers();for(const [name,value] of Object.entries(req.headers))if(typeof value==='string')headers.set(name,value);
        assert(!headers.has('x-tenant-id')&&!headers.has('x-user-id'),'Browser must use actual bearer identity');
        const request=new Request('http://127.0.0.1'+req.url,{method:req.method,headers,...(req.method==='POST'?{body}:{})});
        const operation=req.url!.split('/').at(-1)!,started=performance.now();
        const response=req.url==='/api/me'?await me(request):await POST(request,{params:Promise.resolve({operation})});
        const bytes=await response.text();
        steps.push({boundary:'REAL_BEARER_SQL_API',operation,status:response.status,elapsedMs:performance.now()-started});
        res.statusCode=response.status;res.setHeader('content-type','application/json');res.end(bytes);
        if(response.status===202&&['counterexample-diagnostic-submit','counterexample-repair-request'].includes(operation)){
          const task=queue.tick().catch((error:Error)=>steps.push({boundary:'ACTUAL_QUEUE_FAILURE',reason:error.message}));
          running.add(task);void task.finally(()=>running.delete(task));
        }
      }catch{res.statusCode=500;res.end('{"error":"Disposable browser bridge refused"}');}
    });
    const upstream=await listen(backend),desktop=Boolean(process.env.FACTORY_DESKTOP_CDP_PORT&&process.env.AGENT_BROWSER_CDP);
    const browserEnv={PATH:process.env.PATH!,HOME:process.env.HOME!,TMPDIR:process.env.TMPDIR!,
      AGENT_BROWSER_SESSION:process.env.AGENT_BROWSER_SESSION??'m4-scoped-product-e2e'};
    const ab=async(args:string[],stdin?:string)=>new Promise<string>((yes,no)=>{
      const child=spawn('agent-browser',[...(desktop?['--cdp',process.env.AGENT_BROWSER_CDP!,'--no-pin-tab']:[]),...args],
        {cwd:repo,env:browserEnv,stdio:['pipe','pipe','pipe']});
      child.stdin!.end(stdin??'');let out='',err='';
      child.stdout!.on('data',bytes=>out+=bytes);child.stderr!.on('data',bytes=>err+=bytes);
      const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error('BROWSER_COMMAND_TIMEOUT:'+args[0]));},45000);
      child.once('exit',code=>{clearTimeout(timer);code===0?yes(out):no(Error('BROWSER_COMMAND_FAILED:'+args[0]+':'+(err||out)));});
      child.once('error',error=>{clearTimeout(timer);no(error);});
    });
    const evaluate=async(source:string)=>JSON.parse((await ab(['eval','--stdin'],source)).trim());
    const observe=async()=>{
      const value=await evaluate(`(()=>{const panel=document.querySelector(".ct-counterexample");return {
        result:panel?.querySelector(":scope > h5")?.textContent??null,text:panel?.textContent??"",
        observations:[...panel?.querySelectorAll("article dl")??[]].map(dl=>JSON.parse(dl.querySelectorAll("dd pre")[1].textContent)),
        historyButtons:[...panel?.querySelectorAll("details button")??[]].map(b=>b.textContent),
        replayDisabled:[...panel?.querySelectorAll("article button")??[]].every(b=>b.disabled),
        busy:panel?.getAttribute("aria-busy")};})()`);
      return value;
    };
    const click=async(name:string)=>{
      await evaluate('if(!window.__m4ClickWatch){window.__m4ClickWatch=true;document.addEventListener("click",e=>{const b=e.target.closest?.("button");if(b)window.__m4Click={label:b.textContent,trusted:e.isTrusted};},true);}window.__m4Click=null; null');
      await ab(['find','role','button','click','--name',name,'--exact']);
      const clicked=await evaluate('window.__m4Click');
      if(clicked?.label!==name){
        inputStatus='DOM_ACTIVATION_NATIVE_POINTER_BLOCKED';
        await evaluate(`(()=>{const button=[...document.querySelectorAll("button")].find(b=>b.textContent===${JSON.stringify(name)});
          if(!button||button.disabled)throw Error("Exact enabled product control unavailable");button.click();return null;})()`);
      }
    };
    const configure=async(fixture:string,operation='SET',value:string|null='20')=>{
      const evaluations=[{kind:'EFFECT_FIXTURE',fixture,request:{entityId:'C_01',field:'credit_limit',operation,value,
        unit:'USD',currency:'USD',idempotencyKey:randomUUID()},claimKind:'EXACT_EFFECT'}];
      await evaluate('document.querySelector(".ct-counterexample > details").open=true; null');
      const text=JSON.stringify(evaluations),domain='{"parameters":[],"maxCombination":1}';
      await ab(['find','label','Evaluations (strict JSON)','fill',text]);
      await ab(['find','label','Parameter domain (strict JSON)','fill',domain]);
      if((await evaluate('document.querySelector(".ct-counterexample textarea").value'))!==text){
        inputStatus='DOM_ACTIVATION_NATIVE_POINTER_BLOCKED';
        await evaluate(`(()=>{const values=${JSON.stringify([text,domain])};const fields=document.querySelectorAll(".ct-counterexample textarea");
          fields.forEach((field,i)=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,values[i]);
          field.dispatchEvent(new Event("input",{bubbles:true}));});return null;})()`);
      }
      await artifact('browser/request-'+steps.length+'.json',{evaluations,domain:JSON.parse(domain)});
    };
    const completed=async(result:string)=>{
      await ab(['wait','--fn',`document.querySelector(".ct-counterexample > h5")?.textContent === ${JSON.stringify(result)} &&
        document.querySelector(".ct-counterexample")?.getAttribute("aria-busy")==="false"`]);
      return observe();
    };
    try{
      await createUnderwritingRun(f.ctx,{investmentCaseId:f.caseId,modelVersionId:f.versionId,worldAt:new Date().toISOString(),
        workId:f.workId,idempotencyKey:'m4-browser-original-run'});
      const dataPath=await artifact('browser/workspace.json',await listUnderwritingWorkspace(f.ctx,f.caseId));
      await mkdir(fixtureRoute);fixtureCreated=true;
      await writeFile(join(fixtureRoute,'page.tsx'),`import {readFile} from "node:fs/promises"\nimport {Fixture} from "./fixture"\nexport default async function Page(){return <Fixture workspace={JSON.parse(await readFile(${JSON.stringify(dataPath)},"utf8"))} workId=${JSON.stringify(f.workId)} />}\n`);
      await writeFile(join(fixtureRoute,'fixture.tsx'),`"use client"\nimport {CentropyAuthProvider as JarvisAuthProvider,useCentropyAuth as useJarvisAuth} from "@/components/centropy/lib/centropy-auth"\nimport {UnderwritingScenarioLab} from "@/components/centropy/canvas/UnderwritingScenarioLab"\nfunction Content({workspace,workId}:{workspace:any;workId:string}){const auth=useJarvisAuth();return <main><h1>M4 authenticated Work fixture</h1>{auth.loading||auth.roleLoading?<p role="status">Restoring authenticated owner</p>:!auth.session||auth.role!=="owner"||auth.roleError?<p role="alert">Decision context unavailable</p>:<><p role="status">Authenticated fixture owner ready</p><h2>Bound Work</h2><h3>Original financial model</h3><UnderwritingScenarioLab workspace={workspace} workId={workId} writable onRefresh={()=>{}} /></>}</main>}\nexport function Fixture(props:{workspace:any;workId:string}){return <JarvisAuthProvider><Content {...props}/></JarvisAuthProvider>}\n`);
      const next=spawn(process.execPath,[join(repo,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port','0','--webpack'],
        {cwd:repo,env:{...process.env,NODE_ENV:'development',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_SUPABASE_URL:issuerUrl,
          NEXT_PUBLIC_SUPABASE_ANON_KEY:'m4-disposable-public-key',NEXT_PUBLIC_OS_API_URL:upstream},stdio:['ignore','pipe','pipe']});
      processes.push(next);next.stdout!.on('data',bytes=>log+=bytes);next.stderr!.on('data',bytes=>log+=bytes);
      for(let i=0;i<300;i++){
        const match=log.match(/Local:\s+(http:\/\/[^ \n]+)/);if(match){url=match[1]+'/'+fixtureName;break;}
        if(next.exitCode!==null)throw Error('NEXT_START_FAILED');await new Promise(yes=>setTimeout(yes,100));
      }
      assert(url,'Isolated Next server did not expose a loopback port');
      await ab(['open',url]);await ab(['wait','--text','M4 authenticated Work fixture']);opened=true;
      const session={access_token:token,refresh_token:'disposable-unused',token_type:'bearer',expires_in:3600,
        expires_at:Math.floor(Date.now()/1000)+3600,user:{id:f.principal,email:'m4@example.test',role:'authenticated',
          aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}};
      await ab(['eval','--stdin'],`localStorage.setItem("sb-127-auth-token",${JSON.stringify(JSON.stringify(session))}); null`);
      await ab(['open',url]);await ab(['wait','--text','Authenticated fixture owner ready']);
      await evaluate('window.__m4Keys=[];window.__m4Click=null;document.addEventListener("keydown",e=>window.__m4Keys.push({key:e.key,trusted:e.isTrusted}),true);document.addEventListener("click",e=>{const b=e.target.closest?.("button");if(b)window.__m4Click={label:b.textContent,trusted:e.isTrusted};},true);null');
      await ab(['focus','.ct-decision-slice > .ct-decision-slice__actions > button:first-child']);await ab(['press','Enter']);
      const keys=await evaluate('window.__m4Keys');
      keyboardStatus=keys.some((key:any)=>key.trusted)?'NATIVE_KEYBOARD_OBSERVED':'BLOCKED_TOOL';
      if(!(await evaluate('window.__m4Click'))?.label)await click('Compile decision context');
      await ab(['wait','--text','Bounded counterexample search']);steps.push({action:'Actual mounted M1 to M4',keyboardStatus,inputStatus});
      const observed:any[]=[];
      for(const fixture of ['WRONG_TARGET','WRONG_AMOUNT','CLEAR','UNKNOWN','CORRECT']){
        await configure(fixture);await click('Submit bounded diagnostic');
        const state=await completed(fixture==='UNKNOWN'?'BLOCKED':fixture==='CORRECT'?'NO_WITNESS_WITHIN_BUDGET':'FAILURE_WITNESS');
        observed.push({fixture,state});
        if(state.observations.length){
          const value=state.observations[0];assert.equal(value.requestedEntity,'C_01');assert.equal(value.field,'credit_limit');
          assert.equal(value.requested,'20');assert.equal(value.observedEntity,fixture==='WRONG_TARGET'?'C_010':'C_01');
          assert.equal(value.observed,fixture==='WRONG_AMOUNT'?'200':fixture==='CLEAR'?null:'20');
          assert.equal(value.unit,'USD');assert.equal(value.currency,'USD');
          await click('Recheck witness (effects are read-only)');
          await ab(['wait','--fn','document.querySelector(".ct-counterexample")?.getAttribute("aria-busy")==="false"']);
        }
        if(fixture==='WRONG_AMOUNT'){
          await configure('CORRECT');await click('Request linked diagnostic repair');
          const repaired=await completed('NO_WITNESS_WITHIN_BUDGET');
          assert(repaired.text.includes('Earlier failure retained, explicit repair scope changes'));assert(repaired.historyButtons.length);
          observed.push({fixture:'LINKED_REPAIR',state:repaired});
        }
      }
      await configure('CORRECT','CLEAR',null);await click('Submit bounded diagnostic');
      const exactNull=await completed('NO_WITNESS_WITHIN_BUDGET');observed.push({fixture:'EXACT_NULL',state:exactNull});
      await click('Reload currentness and trial ledger');
      await ab(['wait','--text','Complete persisted trial events']);
      steps.push({action:'Exact effect fields, positive, unknown, repair, null and trial ledger',observed});
      await ab(['open',url]);await ab(['wait','--text','NO_WITNESS_WITHIN_BUDGET']);
      const restored=await observe();assert(restored.text.includes('No observed witness in this checked region, not a safety certificate.'));
      steps.push({action:'Authenticated reconstruction',state:restored});
      const ownCache=await evaluate(`(()=>{const key=Object.keys(sessionStorage).find(key=>key.startsWith("finnor-m4-search:"));
        if(!key)throw Error("Mounted Work cache unavailable");return {key,id:sessionStorage.getItem(key)};})()`);
      const invoke=async(operation:string,body:unknown)=>{
        const response=await fetch(upstream+'/api/company-brain/'+operation,{method:'POST',
          headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body)});
        const value=await response.json();assert(response.ok,JSON.stringify({status:response.status,value}));return value as any;
      };
      const otherWork=(await receiveWork({tenantId:f.tenant,userId:f.principal,
        instruction:'Separate actual Work for reportless scope refusal',channel:'console'})).workId;
      const otherSlice=(await invoke('decision-slice-compile',{schema:'finnor.decision-slice-request.v1',workId:otherWork,
        source:{kind:'UNDERWRITING',investmentCaseId:f.caseId,modelVersionId:f.versionId},purpose:'MODEL_EVIDENCE',
        resource:{deadlineMs:30000,maxNodes:2048,maxBytes:4194304,maxDemands:128}})).slice;
      const other=await invoke('counterexample-diagnostic-submit',{schema:'finnor.m4.diagnostic-request.v1',
        workId:otherWork,sliceRef:otherSlice.ref,idempotencyKey:randomUUID(),
        evaluations:[{kind:'MECHANICAL_BOUND',candidateId:f.versionId,nodeId:'score',relation:'LTE',
          value:'-1',unit:'ratio',claimKind:'UNIVERSAL_DETERMINISTIC'}],domain:{parameters:[],maxCombination:1},
        limits:{deadlineMs:30000,maxTargets:64,maxCells:128,maxTrials:512,maxReductions:0,maxWitnesses:32,maxBytes:4194304}});
      await invoke('counterexample-cancel',{searchId:other.searchId});
      const reportless=await invoke('counterexample-read',{searchId:other.searchId});
      assert.equal(reportless.report,null);
      await evaluate(`sessionStorage.setItem(${JSON.stringify(ownCache.key)},${JSON.stringify(other.searchId)});null`);
      await ab(['open',url]);await ab(['wait','--text','Bounded counterexample search']);
      await ab(['wait','--fn','document.querySelector(".ct-counterexample")?.textContent.includes("Challenge unavailable.")']);
      const wrongWork=await observe();assert(!wrongWork.text.includes(other.searchId));
      assert(!wrongWork.text.includes('Retained partial'));
      steps.push({action:'Same-principal reportless search from another Work refused',otherWork,reportless,wrongWork});
      await evaluate(`sessionStorage.setItem(${JSON.stringify(ownCache.key)},${JSON.stringify(ownCache.id)});null`);
      await ab(['open',url]);await ab(['wait','--text','NO_WITNESS_WITHIN_BUDGET']);
      // Fresh adverse evidence remains visible at this security boundary.
      await configure('WRONG_AMOUNT');await click('Submit bounded diagnostic');await completed('FAILURE_WITNESS');
      await receiveWork({tenantId:f.tenant,userId:f.principal,workId:f.workId,instruction:'Browser source/Work cut advances',
        channel:'console',idempotencyKey:'m4-browser-next-input'});
      await click('Reload currentness and trial ledger');
      await ab(['wait','--text','COMPLETED · STALE']);
      const stale=await observe();assert.equal(stale.result,'FAILURE_WITNESS');assert(stale.replayDisabled);
      steps.push({action:'Historical failure, current use refused',state:stale});
      await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1",[f.principal]);
      try{
        await click('Reload currentness and trial ledger');
        await ab(['wait','--fn','document.querySelector(".ct-counterexample")?.getAttribute("aria-busy")==="false"']);
        const revoked=await observe();
        steps.push({action:'Revoked authenticated read',state:revoked});
        assert.equal(revoked.observations.length,0,'Revoked read retained private independent observations');
        assert.equal(revoked.result,null,'Revoked read retained an issued private report');
        assert(!revoked.text.includes('Complete persisted trial events'));
      }finally{await admin.query("UPDATE finnor_os.users SET status='active' WHERE id=$1",[f.principal]);}
      await ab(['screenshot',join(output,'browser/current.png')]).then(()=>steps.push({action:'Screenshot',status:'CAPTURED'}))
        .catch(()=>steps.push({action:'Screenshot',status:'BLOCKED_TOOL'}));
      await ab(['a11y','--selector','main','--json']).then(text=>{
        const audit=JSON.parse(text);steps.push({action:'Accessibility',audit});
        if(audit.data?.counts)assert.equal(audit.data.counts.violations,0);
      }).catch(error=>{
        if(String(error).includes('AssertionError'))throw error;
        steps.push({action:'Accessibility',status:'BLOCKED_TOOL'});
      });
      return {keyboardStatus,inputStatus,validationStatus:keyboardStatus==='BLOCKED_TOOL'||inputStatus!=='NATIVE_INPUT'||
        steps.some(step=>step.status==='BLOCKED_TOOL')?'PARTIAL_TOOL_QUALIFICATION':'PASS',
        qualification:'Actual local signed bearer/proxy/SQL/queue/rendered owner diagnostic; not hosted JWT, M3 or provider admission'};
    }catch(error){
      if(opened)await observe().then(state=>steps.push({action:'Failure state',state})).catch(()=>undefined);
      throw error;
    }finally{
      if(opened)await ab(['eval','--stdin'],'localStorage.removeItem("sb-127-auth-token");null').catch(()=>undefined);
      await Promise.allSettled([...running]);
      for(const child of processes){child.kill('SIGTERM');if(child.exitCode===null)await new Promise<void>(yes=>{
        const timer=setTimeout(()=>{child.kill('SIGKILL');yes();},5000);child.once('exit',()=>{clearTimeout(timer);yes();});
      });}
      await new Promise<void>(yes=>backend.close(()=>yes()));await new Promise<void>(yes=>issuer.close(()=>yes()));
      if(fixtureCreated){
        await rm(fixtureRoute,{recursive:true,force:true});
        await rm(join(repo,'.next/dev/types/app',fixtureName,'page.ts'),{force:true});
      }
      const validator=join(repo,'.next/dev/types/validator.ts');
      if((await readFile(validator,'utf8').catch(()=>'' )).includes(fixtureName))await rm(validator);
      if(prior.url===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=prior.url;
      if(prior.key===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=prior.key;
      if(!desktop)await ab(['close']).catch(()=>undefined);
      await artifact('browser/results.json',{url,steps,keyboardStatus,inputStatus,qualification:'Disposable session keys are not exported'});
      await artifact('browser/next-log.json',{log});
    }
  });
}

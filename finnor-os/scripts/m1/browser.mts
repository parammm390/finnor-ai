/** Public browser E2E contract, authored before the M1 presenter. Uses a local
 * cryptographically verified issuer fixture, real proxy, SQL identity and API.
 * This is not evidence of a hosted Supabase deployment or protected admission. */
import { strict as assert } from 'node:assert';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { POST as m1Post } from '../../apps/api/app/api/company-brain/[operation]/route';
import { GET as meGet } from '../../apps/api/app/api/me/route';
import { GET as diffGet } from '../../apps/api/app/api/underwriting/runs/diff/route';
import { listUnderwritingWorkspace } from '@finnor/private-equity';

export async function browserChallenge(input:{
  repo:string;output:string;fixture:any;admin:any;request:any;
  artifact:(name:string,value:unknown)=>Promise<string>;
  prepareP4UI:()=>Promise<{derivationId:string;nodeId:string;output:string;modelVersionId:string}>;
}){
  const {repo,output,fixture:f,admin,artifact}=input,steps:any[]=[],processes:ChildProcess[]=[];
  // UI join extension, registered before the presenter change. The binding
  // control carries IDs only; the real owner still resolves every value/check.
  const p4UiRequirements=['Bind installed P4 financial evidence','Input node ID','P4 derivation ID','P4 output name'];
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  const jwk={...await exportJWK(publicKey),alg:'RS256',use:'sig',kid:'m1-local-issuer'};
  const token=await new SignJWT({email:'m1@example.test',role:'authenticated'})
    .setProtectedHeader({alg:'RS256',kid:jwk.kid}).setSubject(f.principal)
    .setIssuedAt().setExpirationTime('1h').sign(privateKey);
  const issuer=createServer((req,res)=>{
    res.setHeader('access-control-allow-origin','*');
    res.setHeader('access-control-allow-headers','authorization,apikey,content-type');
    res.setHeader('content-type','application/json');
    if(req.method==='OPTIONS'){res.end();return;}
    if(req.url?.includes('.well-known/jwks.json')){res.end(JSON.stringify({keys:[jwk]}));return;}
    res.statusCode=404;res.end(JSON.stringify({error:'Unsupported local issuer operation'}));
  });
  const listen=async(server:ReturnType<typeof createServer>)=>{
    await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
    const address=server.address();assert(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}`;
  };
  const issuerUrl=await listen(issuer),priorAuth={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY};
  process.env.SUPABASE_URL=issuerUrl;process.env.SUPABASE_SERVICE_ROLE_KEY='m1-public-local-issuer-key';
  const backend=createServer(async(req,res)=>{
    try{
      let body='';for await(const chunk of req){body+=chunk;if(body.length>65536)throw Error('Fixture request bound');}
      const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
      const request=new Request(`http://127.0.0.1${req.url}`,{method:req.method,headers,...(req.method==='POST'?{body}: {})});
      const response=req.url==='/api/me'?await meGet(request)
        :req.method==='GET'&&req.url?.startsWith('/api/underwriting/runs/diff?')?await diffGet(request)
        :await m1Post(request,{params:Promise.resolve({operation:req.url!.split('/').at(-1)!})});
      steps.push({boundary:'REAL_BEARER_SQL_API',path:req.url,status:response.status});
      res.statusCode=response.status;res.setHeader('content-type','application/json');res.end(await response.text());
    }catch{res.statusCode=500;res.end('{"error":"Local browser driver failed"}');}
  });
  const upstream=await listen(backend);
  const fixtureName='jarvis-m1-e2e-fixture',fixtureRoute=join(repo,'src/app',fixtureName),dataPath=join(output,'browser-workspace.json');
  await mkdir(fixtureRoute);
  // A generated, agent-owned test page imports the actual integrated component,
  // not a parallel presenter. It is removed in finally and never shipped.
  const workspace=await listUnderwritingWorkspace(f.ctx,f.caseId);
  await writeFile(dataPath,JSON.stringify(workspace));
  await writeFile(join(fixtureRoute,'page.tsx'),`import { readFile } from "node:fs/promises"\nimport { Fixture } from "./fixture"\nexport default async function Page(){return <Fixture workspace={JSON.parse(await readFile(${JSON.stringify(dataPath)},"utf8"))} workId=${JSON.stringify(f.workId)} />}\n`);
  await writeFile(join(fixtureRoute,'fixture.tsx'),`"use client"\nimport { JarvisAuthProvider, useJarvisAuth } from "@/components/jarvis/lib/jarvis-auth"\nimport { UnderwritingScenarioLab } from "@/components/centropy/canvas/UnderwritingScenarioLab"\nfunction Content({workspace,workId}:{workspace:any;workId:string}){const auth=useJarvisAuth();return <main><h1>M1 public authenticated Work fixture</h1>{auth.loading||auth.roleLoading?<p role="status">Restoring authenticated owner</p>:!auth.session||auth.role!=="owner"?<p role="alert">Decision context unavailable</p>:<><p role="status">Authenticated fixture owner ready</p><h2>Bound Work view</h2><h3>Financial model</h3><UnderwritingScenarioLab workspace={workspace} workId={workId} writable onRefresh={()=>{}} /></>}</main>}\nexport function Fixture(props:{workspace:any;workId:string}){return <JarvisAuthProvider><Content {...props} /></JarvisAuthProvider>}\n`);
  const next=spawn(process.execPath,[join(repo,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port','0'],{
    cwd:repo,env:{...process.env,NODE_ENV:'development',NEXT_PUBLIC_SUPABASE_URL:issuerUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY:'m1-public-local-issuer-key',NEXT_PUBLIC_OS_API_URL:upstream,NEXT_TELEMETRY_DISABLED:'1',
      FINNOR_M1_E2E_NEXT:'1'},stdio:['ignore','pipe','pipe']});
  processes.push(next);let log='';next.stdout!.on('data',b=>log+=b);next.stderr!.on('data',b=>log+=b);
  const nativeRuntime=Boolean(process.env.FINNOR_AGENT_BROWSER&&process.env.FINNOR_BROWSER_EXECUTABLE);
  const desktop=!nativeRuntime&&Boolean(process.env.FACTORY_DESKTOP_CDP_PORT&&process.env.AGENT_BROWSER_CDP);
  const nativeSession='finnor-m1-'+randomUUID(),config=join(output,'browser-agent-config.json');
  if(nativeRuntime)await writeFile(config,'{}\n',{mode:0o600,flag:'wx'});
  const browserEnv={PATH:process.env.PATH!,HOME:process.env.HOME!,TMPDIR:process.env.TMPDIR!,
    AGENT_BROWSER_SESSION:nativeRuntime?nativeSession:process.env.AGENT_BROWSER_SESSION??'m1-public-e2e',
    ...(nativeRuntime?{AGENT_BROWSER_EXECUTABLE_PATH:process.env.FINNOR_BROWSER_EXECUTABLE!}:{})};
  const ab=async(args:string[],stdin?:string)=>new Promise<string>((yes,no)=>{
    // Factory CDP addresses this single embedded pane. Clear our prior stale
    // pin rather than treating it as a shared multi-tab Chrome endpoint.
    const child=spawn(nativeRuntime?process.env.FINNOR_AGENT_BROWSER!:join(repo,'.m1-tools/node_modules/.bin/agent-browser'),
      [...(nativeRuntime?['--config',config,'--session',nativeSession]:desktop?['--cdp',process.env.AGENT_BROWSER_CDP!,'--no-pin-tab']:[]),...args],
      {cwd:repo,env:browserEnv,stdio:['pipe','pipe','pipe']});
    child.stdin!.end(stdin??'');
    let out='',err='';child.stdout!.on('data',b=>out+=b);child.stderr!.on('data',b=>err+=b);
    const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error(`BROWSER_COMMAND_TIMEOUT:${args.join(' ')}`));},45000);
    child.on('exit',code=>{clearTimeout(timer);if(code===0)yes(out);else no(Error(`BROWSER_COMMAND_FAILED:${args.join(' ')}:${err||out}`));});
    child.on('error',error=>{clearTimeout(timer);no(error);});
  });
  let url='',fixtureOpened=false;
  try{
    if(!nativeRuntime&&!desktop)throw Error('VERIFIED_BROWSER_RUNTIME_REQUIRED');
    for(let i=0;i<200;i++){const match=log.match(/Local:\s+(http:\/\/[^ \n]+)/);if(match){url=match[1]+'/'+fixtureName;break;}if(next.exitCode!==null)throw Error('NEXT_START_FAILED');await new Promise(r=>setTimeout(r,100));}
    assert(url,'Next did not expose its isolated local port');
    steps.push({action:'Open integrated Work laboratory'});
    try{await ab(['open',url]);}
    catch(error){
      if(!String(error).includes('tab_gone'))throw error;
      const listed=JSON.parse(await ab(['tab','list','--json']));
      const prior=listed.data?.tabs?.find((tab:any)=>{
        try{const parsed=new URL(tab.url);return parsed.hostname==='127.0.0.1'&&parsed.pathname==='/'+fixtureName;}catch{return false;}
      });
      if(!prior)throw error;
      // Rebind only the returned target for our disposable fixture in the same
      // assigned pane, never a different user's tab or a new headless browser.
      await ab(['tab',prior.targetId]);await ab(['open',url]);
      steps.push({action:'Recover closed assigned-pane fixture binding',status:'REBOUND_PUBLIC_FIXTURE'});
    }
    await ab(['wait','--text','M1 public authenticated Work fixture']);
    fixtureOpened=true;
    // Tokens are generated solely for this disposable issuer, never read from a
    // user's browser/session. Do not persist them in evidence or command logs.
    const session={access_token:token,refresh_token:'local-fixture-unused',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,user:{id:f.principal,email:'m1@example.test',role:'authenticated',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}};
    await ab(['eval','--stdin'],`localStorage.setItem("sb-127-auth-token",${JSON.stringify(JSON.stringify(session))}); undefined`);
    steps.push({action:'Restore local fixture session'});
    await ab(['open',url]);await ab(['wait','--text','Authenticated fixture owner ready']);
    const selectRegisteredBase=async(current:any,modelVersionId:string)=>{
      const runs=current.runs.filter((run:any)=>!run.scenarioId&&!run.sensitivityCell&&run.modelVersionId===modelVersionId)
        .sort((a:any,b:any)=>Date.parse(b.computedAt)-Date.parse(a.computedAt));
      if(!runs.length){assert(!current.runs.some((run:any)=>!run.scenarioId&&!run.sensitivityCell),'Registered model must have an actual selectable base');assert.equal(current.modelVersions[0]?.id,modelVersionId);return;}
      const tree=await ab(['snapshot','-i']),lines=tree.split('\n').filter(line=>line.includes('combobox "Base run" '));
      assert.equal(lines.length,1,'Actual Base run selector required');const reference=lines[0]!.match(/ref=([a-z]\d+)/)?.[1];assert(reference);
      await ab(['scrollintoview','@'+reference]);await ab(['select','@'+reference,runs[0].id]);
      steps.push({action:'Select exact registered model through actual Base run control',modelVersionId,runId:runs[0].id});
    };
    await selectRegisteredBase(workspace,input.request.source.modelVersionId);
    const bindingControls=await ab(['eval','--stdin'],'document.querySelector(".ct-decision-slice")?.textContent ?? ""');
    for(const text of p4UiRequirements)assert(bindingControls.includes(text),`Missing typed P4 UI control: ${text}`);
    // The embedded Electron view can have DOM focus without native input focus.
    // A harmless heading click focuses that view before keyboard-only activation.
    const headingSnapshot=await ab(['snapshot']),headingRef=headingSnapshot.match(/heading "M1 public authenticated Work fixture"[^\n]*ref=([a-z]\d+)/)?.[1];
    assert(headingRef,'Actual mounted fixture heading reference required');
    await ab(['click','@'+headingRef]);
    const controls=await ab(['snapshot','-i']),compileRef=controls.match(/button "Compile decision context"[^\n]*ref=([a-z]\d+)/)?.[1];
    assert(compileRef,'Compile control must have a keyboard-accessible button reference');
    await ab(['focus','@'+compileRef]);
    const focus=await ab(['eval','--stdin'],'window.__m1Keys=[]; for(const name of ["keydown","keyup","click"])document.addEventListener(name,event=>window.__m1Keys.push({type:event.type,key:event.key,target:event.target?.textContent,trusted:event.isTrusted}),{capture:true}); JSON.stringify({tag:document.activeElement?.tagName,label:document.activeElement?.textContent,disabled:document.activeElement?.hasAttribute("disabled"),documentFocused:document.hasFocus()})');
    steps.push({action:'Keyboard focus',focus});assert(focus.includes('Compile decision context'));
    if(nativeRuntime){
      // The current native CLI delivered trusted keydown/up without default
      // button activation. Attach a keyboard driver only to this already owned
      // session; never launch a replacement browser or dispatch a DOM click.
      let endpoint:any=(await ab(['get','cdp-url'])).trim();
      try{endpoint=JSON.parse(endpoint);}catch{}
      const parsed=new URL(endpoint);
      assert(parsed.protocol==='ws:'&&parsed.hostname==='127.0.0.1','Owned local session CDP endpoint required');
      const playwrightPath=join(repo,'node_modules/playwright/package.json'),playwright=await readFile(playwrightPath,'utf8');
      await artifact('browser/keyboard-runtime.json',{path:playwrightPath,version:JSON.parse(playwright).version,
        sha256:createHash('sha256').update(playwright).digest('hex'),driver:'Same existing agent-browser session, Playwright native keyboard; no new browser/context/page'});
      const script=`import {chromium} from "playwright";try{const browser=await chromium.connectOverCDP(process.env.M1_OWNED_CDP,{timeout:10000,noDefaults:true});const pages=browser.contexts().flatMap(context=>context.pages()).filter(page=>page.url()===process.env.M1_BROWSER_URL);if(pages.length!==1)throw Error("Exact owned fixture target required");const button=pages[0].getByRole("button",{name:"Compile decision context",exact:true});await button.focus({timeout:15000});await button.press("Enter",{timeout:15000});console.log(JSON.stringify({status:"NATIVE_KEY_SENT",page:pages[0].url()}));process.exit(0);}catch(error){console.error(String(error));process.exit(1);}`;
      const keyResult=await new Promise<string>((yes,no)=>{
        const child=spawn(process.execPath,['--input-type=module','--eval',script],{cwd:repo,
          env:{...browserEnv,M1_OWNED_CDP:endpoint,M1_BROWSER_URL:url},stdio:['ignore','pipe','pipe']});
        let out='',err='';child.stdout!.on('data',bytes=>out+=bytes);child.stderr!.on('data',bytes=>err+=bytes);
        const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error('NATIVE_KEYBOARD_COMMAND_TIMEOUT'));},45000);
        child.once('exit',code=>{clearTimeout(timer);if(code===0)yes(out.trim());else no(Error('NATIVE_KEYBOARD_COMMAND_FAILED:'+err));});
        child.once('error',error=>{clearTimeout(timer);no(error);});
      });
      steps.push({action:'Native keyboard in the same owned browser',result:JSON.parse(keyResult)});
    }else await ab(['press','Enter']);
    const keyLog=await ab(['eval','--stdin'],'JSON.stringify(window.__m1Keys)');
    const keyEvents=JSON.parse(JSON.parse(keyLog.trim()));
    steps.push({action:'Browser key dispatch',events:keyEvents});
    let keyboardStatus=keyEvents.some((event:any)=>event.type==='keydown')?'NATIVE_INPUT_OBSERVED':'BLOCKED_TOOL';
    if(nativeRuntime&&keyboardStatus==='NATIVE_INPUT_OBSERVED')
      assert(keyEvents.some((event:any)=>event.type==='keydown'&&event.trusted&&event.target==='Compile decision context'),'Actual native trusted keyboard event required');
    if(keyboardStatus==='BLOCKED_TOOL'&&desktop){
      const keyboard=await new Promise<string>(yes=>{
        const script=`import {chromium} from "playwright";try{const browser=await chromium.connectOverCDP(process.env.AGENT_BROWSER_CDP,{timeout:10000});const page=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url()===process.env.M1_BROWSER_URL);if(!page)throw Error("Target unavailable");const button=page.getByRole("button",{name:"Compile decision context",exact:true});await button.focus();await button.press("Enter");console.log(JSON.stringify({status:"DISPATCHED",events:await page.evaluate(()=>window.__m1Keys)}));}catch{console.log(JSON.stringify({status:"UNAVAILABLE"}));}process.exit(0);`;
        const child=spawn(process.execPath,['--input-type=module','--eval',script],{cwd:repo,env:{...browserEnv,AGENT_BROWSER_CDP:process.env.AGENT_BROWSER_CDP!,M1_BROWSER_URL:url},stdio:['ignore','pipe','ignore']});
        let result='';child.stdout!.on('data',bytes=>result+=bytes);
        const timer=setTimeout(()=>{child.kill('SIGKILL');yes('{"status":"UNAVAILABLE"}');},15000);
        child.once('exit',()=>{clearTimeout(timer);yes(result.trim()||'{"status":"UNAVAILABLE"}');});
        child.once('error',()=>{clearTimeout(timer);yes('{"status":"UNAVAILABLE"}');});
      });
      const observed=JSON.parse(keyboard);steps.push({action:'Same assigned pane native keyboard driver',observed});
      if(observed.events?.some((event:any)=>event.type==='keydown'&&event.trusted))keyboardStatus='NATIVE_INPUT_OBSERVED';
    }
    if(keyboardStatus==='BLOCKED_TOOL'){
      steps.push({action:'Keyboard validation blocked',reason:'Assigned Electron CDP accepts press but delivers no DOM key events; focus is verified, not a keyboard activation pass'});
      await ab(['eval','--stdin'],'[...document.querySelectorAll(".ct-decision-slice button")].find(button=>button.textContent==="Compile decision context").click(); "DOM activation, not native keyboard proof"');
    }
    steps.push({action:'Keyboard activation',snapshot:await ab(['snapshot'])});
    await ab(['wait','--text','Evidence producer coverage']);
    const snapshot=await ab(['snapshot']);steps.push({action:'Compile through authenticated proxy',inputMethod:keyboardStatus==='BLOCKED_TOOL'?'DOM_ACTIVATION':'KEYBOARD',snapshot});
    assert(snapshot.includes('Incomplete decision coverage'));assert(!snapshot.includes('Safe to execute'));
    const clickButton=async(name:string)=>{
      if(keyboardStatus==='BLOCKED_TOOL')await ab(['eval','--stdin'],`[...document.querySelectorAll(".ct-decision-slice button")].find(button=>button.getAttribute("aria-label")===${JSON.stringify(name)}||button.textContent===${JSON.stringify(name)}).click(); "DOM activation"`);
      else if(nativeRuntime){
        const tree=await ab(['snapshot','-i']),matching=tree.split('\n').filter(line=>line.includes('button '+JSON.stringify(name)+' '));
        assert.equal(matching.length,1,'Exact current native button reference required: '+name);
        const reference=matching[0]!.match(/ref=([a-z]\d+)/)?.[1];assert(reference,'Native button reference required');
        await ab(['scrollintoview','@'+reference]);await ab(['click','@'+reference]);
      }else await ab(['find','role','button','click','--name',name]);
    };
    await clickButton('Inspect witness for x');
    await ab(['wait','--text','Exact native witness']);
    steps.push({action:'One-action witness',snapshot:await ab(['snapshot'])});
    await clickButton('Check decision readiness');
    await ab(['wait','--text','Decision refused: material coverage is unresolved']);
    await ab(['find','label','Notes (presentation only)','fill','Agenda note, not a canonical fact']);
    if(keyboardStatus==='BLOCKED_TOOL')await ab(['eval','--stdin'],'const textarea=document.querySelector(".ct-decision-slice textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(textarea,"Agenda note, not a canonical fact");textarea.dispatchEvent(new Event("input",{bubbles:true}));"DOM input, not native typing proof"');
    await clickButton('Save presentation notes');
    await ab(['wait','--text','Presentation saved']);
    await ab(['open',url]);await ab(['wait','--fn','document.querySelector(".ct-decision-slice textarea")?.value === "Agenda note, not a canonical fact"']);
    steps.push({action:'Reload, authenticated context reconstruction',snapshot:await ab(['snapshot'])});
    const openP4Bindings=async()=>{
      if(nativeRuntime){
        const selector='.ct-decision-slice > details:first-of-type > summary';
        await ab(['wait','--fn',`document.querySelector(${JSON.stringify(selector)})?.textContent === "Bind installed P4 financial evidence"`]);
        await ab(['scrollintoview',selector]);await ab(['click',selector]);
        await ab(['wait','--fn',`document.querySelector(${JSON.stringify(selector)})?.parentElement?.open === true`]);
        steps.push({action:'Native financial-binding disclosure opened',selector});
      }else await ab(['find','text','Bind installed P4 financial evidence','click','--exact']);
    };
    const absentProducer=randomUUID();
    if(keyboardStatus==='BLOCKED_TOOL'){
      await ab(['eval','--stdin'],`document.querySelector(".ct-decision-slice details").open=true;const labels=[["Input node ID","x"],["P4 derivation ID",${JSON.stringify(absentProducer)}],["P4 output name","equity"]];for(const [name,value] of labels){const input=[...document.querySelectorAll(".ct-decision-slice label")].find(label=>label.textContent===name).querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));}"DOM metadata input, not keyboard proof"`);
    }else{
      await openP4Bindings();
      await ab(['find','label','Input node ID','fill','x']);
      await ab(['find','label','P4 derivation ID','fill',absentProducer]);
      await ab(['find','label','P4 output name','fill','equity']);
    }
    await clickButton('Add typed P4 reference');
    await ab(['open',url]);await ab(['wait','--text','Authenticated fixture owner ready']);
    if(keyboardStatus==='BLOCKED_TOOL')await ab(['eval','--stdin'],'document.querySelector(".ct-decision-slice details").open=true; "DOM disclosure, not keyboard proof"');
    else await openP4Bindings();
    await ab(['wait','--text',absentProducer]);
    steps.push({action:'Scoped IDs-only P4 reference survives reload',snapshot:await ab(['snapshot']),qualification:'Nonexistent ID metadata only, never accepted evidence or producer proof'});
    await clickButton('Compile decision context');await ab(['wait','--text','Decision context unavailable']);
    await clickButton('Remove x binding');await ab(['wait','--fn','document.querySelector(".ct-decision-slice textarea")?.value === "Agenda note, not a canonical fact"']);
    const p4=await input.prepareP4UI();
    const p4Workspace=await listUnderwritingWorkspace(f.ctx,f.caseId);
    await writeFile(dataPath,JSON.stringify(p4Workspace));
    await ab(['open',url]);await ab(['wait','--text','Authenticated fixture owner ready']);
    await selectRegisteredBase(p4Workspace,p4.modelVersionId);
    assert(!(await ab(['eval','--stdin'],'document.querySelector(".ct-decision-slice")?.textContent ?? ""')).includes(absentProducer),'New model scope must not retain a prior P4 binding');
    if(keyboardStatus==='BLOCKED_TOOL'){
      await ab(['eval','--stdin'],`document.querySelector(".ct-decision-slice details").open=true;const labels=[["Input node ID",${JSON.stringify(p4.nodeId)}],["P4 derivation ID",${JSON.stringify(p4.derivationId)}],["P4 output name",${JSON.stringify(p4.output)}]];for(const [name,value] of labels){const input=[...document.querySelectorAll(".ct-decision-slice label")].find(label=>label.textContent===name).querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,value);input.dispatchEvent(new Event("input",{bubbles:true}));}"DOM metadata input, not keyboard proof"`);
    }else{
      await openP4Bindings();
      await ab(['find','label','Input node ID','fill',p4.nodeId]);await ab(['find','label','P4 derivation ID','fill',p4.derivationId]);await ab(['find','label','P4 output name','fill',p4.output]);
    }
    await clickButton('Add typed P4 reference');await clickButton('Compile decision context');await ab(['wait','--text','P4_RESOLVED']);
    await clickButton('Inspect witness for equity');await ab(['wait','--text','Authentic P4 financial witness']);
    const p4Snapshot=await ab(['snapshot']);assert(p4Snapshot.includes(p4.derivationId));assert(p4Snapshot.includes('50'));
    steps.push({action:'Actual installed P4 producer reaches Work UI financial witness',inputMethod:keyboardStatus==='BLOCKED_TOOL'?'DOM_ACTIVATION':'NATIVE_INPUT',snapshot:p4Snapshot,owner:p4});
    await clickButton('Check decision readiness');await ab(['wait','--text','Decision refused: material coverage is unresolved']);
    await ab(['screenshot',join(output,'browser-current.png')])
      .then(()=>steps.push({action:'Renderer screenshot',status:'CAPTURED'}))
      .catch(()=>steps.push({action:'Renderer screenshot',status:'BLOCKED_TOOL'}));
    let audit:any;
    if(nativeRuntime){
      const axePath=join(repo,'node_modules/axe-core/axe.min.js'),axe=await readFile(axePath,'utf8');
      const version=JSON.parse(await readFile(join(repo,'node_modules/axe-core/package.json'),'utf8')).version;
      await artifact('browser/axe-runtime.json',{path:axePath,version,sha256:createHash('sha256').update(axe).digest('hex'),
        scope:'Actual installed full default axe rules in the same rendered main; no filtered rules or protected attestation'});
      await ab(['eval','--stdin'],axe+'\nundefined');
      const result=await ab(['eval','--stdin'],'(async()=>{const report=await window.axe.run(document.querySelector("main"));return JSON.stringify({data:{counts:{violations:report.violations.length,incomplete:report.incomplete.length,passes:report.passes.length,inapplicable:report.inapplicable.length},report}});})()');
      audit=JSON.parse(result);if(typeof audit==='string')audit=JSON.parse(audit);
      assert(audit?.data?.counts,'Actual complete accessibility report required');
      steps.push({action:'Accessibility audit',result:audit});
    }else{
      await ab(['a11y','--selector','main','--json'])
        .then(result=>{audit=JSON.parse(result);steps.push({action:'Accessibility audit',result:audit});})
        .catch(()=>steps.push({action:'Accessibility audit',status:'BLOCKED_TOOL'}));
    }
    if(audit?.data){
      assert.equal(audit.data.counts.violations,0,'Real accessibility violations are not a tool qualification');
      if(audit.data.counts.incomplete)steps.push({action:'Accessibility incomplete checks',status:'BLOCKED_TOOL',reason:'Assigned pane cannot establish the retained contrast checks'});
    }
    await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1",[f.principal]);
    try{
      await ab(['open',url]);await ab(['wait','--text','Decision context unavailable']);
      const denied=await ab(['snapshot']);assert(!denied.includes('Inspect witness for x'));steps.push({action:'Revoked reload',snapshot:denied});
    }finally{await admin.query("UPDATE finnor_os.users SET status='active' WHERE id=$1",[f.principal]);}
    return {url,steps,keyboardStatus,validationStatus:keyboardStatus==='BLOCKED_TOOL'||steps.some(step=>step.status==='BLOCKED_TOOL')?'PARTIAL_VALIDATION':'PASS',
      qualification:'Real asymmetric local fixture token, proxy and ordinary-role SQL owner/API; hosted Supabase remains untested'};
  }catch(error){
    if(/BROWSER_COMMAND_FAILED:.*(?:tab_gone|No target with given session id)/s.test(String(error))||
      !fixtureOpened&&String(error).startsWith('Error: BROWSER_COMMAND_TIMEOUT:')){
      steps.push({action:'Assigned pane unavailable',status:'BLOCKED_TOOL',reason:'Assigned browser command could not open/identify the fixture; stale target or physical command timeout, no substitute browser or rendered-pass claim'});
      return {url,steps,keyboardStatus:'BLOCKED_TOOL',validationStatus:'BLOCKED_TOOL',
        qualification:'Current rendered, keyboard, visual and accessibility validation did not complete; native API passes do not substitute'};
    }
    await ab(['snapshot']).then(snapshot=>steps.push({action:'Failure snapshot',snapshot})).catch(()=>undefined);
    throw error;
  }finally{
    await artifact('browser/results.json',{url,steps,qualification:'Local issuer public fixture, no hosted auth/admission claim'});
    await artifact('browser/next-log.json',{log});
    for(const child of processes){
      child.kill('SIGTERM');
      if(child.exitCode===null)await new Promise<void>(yes=>{const timer=setTimeout(()=>{child.kill('SIGKILL');yes();},5000);child.once('exit',()=>{clearTimeout(timer);yes();});});
    }
    await new Promise<void>(yes=>backend.close(()=>yes()));await new Promise<void>(yes=>issuer.close(()=>yes()));
    await rm(fixtureRoute,{recursive:true,force:true});
    const validator=join(repo,'.next/dev/types/validator.ts');
    if((await readFile(validator,'utf8').catch(()=>'' )).includes(fixtureName))await rm(validator);
    if(priorAuth.url===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=priorAuth.url;
    if(priorAuth.key===undefined)delete process.env.SUPABASE_SERVICE_ROLE_KEY;else process.env.SUPABASE_SERVICE_ROLE_KEY=priorAuth.key;
    if(!desktop)await ab(['close']).catch(()=>undefined);
  }
}

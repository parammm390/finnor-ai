/** Registered real mounted Capital Work proof. Transport holds are external to
 * product code; signed identity, business routes, SQL and workers are real. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createEmployeeConversationThread, receiveWork } from '@finnor/db';
import { createDeal } from '@finnor/private-equity';
import type pg from 'pg';
import type { localHost } from './local-host.mts';
import type { OwnerFixture } from './run-owner.mts';

export async function mountedAtlas(input:{
  repo:string;output:string;admin:pg.Client;host:Awaited<ReturnType<typeof localHost>>;
  fixture:(name:string)=>Promise<OwnerFixture>;resource:(f:OwnerFixture)=>Promise<unknown>;worker:()=>Promise<unknown>;
  call:(f:OwnerFixture,operation:string,body:unknown,family?:string)=>Promise<{status:number;body:any}>;
  artifact:(name:string,value:unknown)=>Promise<string>;
}){
  const desktop=Boolean(process.env.FACTORY_DESKTOP_CDP_PORT&&process.env.AGENT_BROWSER_CDP),
    assignedTab=process.env.FINNOR_R7_BROWSER_TAB,assignedTarget=process.env.FINNOR_R7_BROWSER_TARGET;
  assert(!desktop||(assignedTab&&/^t\d+$/.test(assignedTab)&&assignedTarget&&/^[A-Fa-f0-9]{32}$/.test(assignedTarget)),
    'Explicit freshly verified assigned pane tab and target are required');
  const {repo,output,admin,host,artifact}=input,p=await input.fixture('r7-mounted'),
    deal=await createDeal(p.ctx,{targetOrganizationId:p.root.entityId,name:'R7 mounted exact policy company',
      dealLeadEmployeeId:p.principal,signedLoiAt:new Date(Date.now()-86400000),targetClosingAt:new Date(Date.now()+86400000)}),
    dealRoot={entityType:'pe_deal',entityId:String(deal.row.id)};
  const thread=await createEmployeeConversationThread({tenantId:p.tenant,ownerEmployeeId:p.principal,title:'R7 checked policy Work'}),
    otherWork=(await receiveWork({tenantId:p.tenant,userId:p.principal,instruction:'Separate actual Work, no atlas bound',channel:'console',
      idempotencyKey:'r7-browser-other-work',activeContext:{entityRefs:[p.root]}})).workId,
    other=await createEmployeeConversationThread({tenantId:p.tenant,ownerEmployeeId:p.principal,title:'R7 separate private Work'});
  for(const [id,workId]of [[thread.id,p.workId],[other.id,otherWork]])
    await admin.query('UPDATE finnor_os.employee_conversation_threads SET active_work_id=$3,active_references=$4::jsonb WHERE tenant_id=$1 AND id=$2',
      [p.tenant,id,workId,JSON.stringify([dealRoot])]);
  // The S5 input pin must include the final actual Work/Deal membership, not a
  // preliminary fixture world from before those legitimate owner changes.
  await input.resource(p);
  const {ref:resourceRef,revision:_revision,priorRef:_prior,...resourceBody}=p.resource!;
  const scoped=await input.call(p,'resource',{resource:{...resourceBody,permittedRoots:[p.root,dealRoot]},expectedRef:resourceRef},'allocations');
  assert.equal(scoped.status,200,'The actual registered S5 cash scope must include the mounted Deal');
  p.resource=scoped.body;
  const origin='http://127.0.0.1:4790',path=(id:string)=>origin+'/centropy/investigations/'+id+'?root='+encodeURIComponent(JSON.stringify(dealRoot)),
    url=path(thread.id),steps:unknown[]=[],
    browserEnv={PATH:process.env.PATH!,HOME:process.env.HOME!,TMPDIR:process.env.TMPDIR!,
      AGENT_BROWSER_SESSION:process.env.AGENT_BROWSER_SESSION??'r7-mounted-isolated',
      ...(desktop?{FACTORY_DESKTOP_CDP_PORT:process.env.FACTORY_DESKTOP_CDP_PORT!,AGENT_BROWSER_CDP:process.env.AGENT_BROWSER_CDP!}:{})};
  const foreground=async()=>{
    if(!desktop)return;
    if(process.platform==='darwin')await new Promise<void>((yes,no)=>{
      const cp=spawn('osascript',['-e','tell application "Factory" to activate'],{stdio:'ignore'});
      const timer=setTimeout(()=>{cp.kill('SIGKILL');no(Error('BOUNDED_NATIVE_APP_FOCUS_TIMEOUT'));},5000);
      cp.once('error',error=>{clearTimeout(timer);no(error);});
      cp.once('close',code=>{clearTimeout(timer);code===0?yes():no(Error('NATIVE_FACTORY_APP_FOCUS_FAILED'));});
    });
    // The supplied endpoint is browser-scoped. A sessionless Page command can
    // activate Factory's host document rather than its assigned embedded pane.
    // Rebind only our already registered tab, never discover/create a target.
    const endpoint=process.env.AGENT_BROWSER_CDP!,url=new URL(endpoint);
    if(!['ws:','wss:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)){
      throw Error('ASSIGNED_LOCAL_PAGE_ENDPOINT_REQUIRED');
    }
    // This supplied endpoint's default Page is the browser host. Bringing its
    // window forward is native host focus, not proof of the guest pane identity.
    await new Promise<void>((yes,no)=>{
      const ws=new WebSocket(endpoint),timer=setTimeout(()=>{ws.close();no(Error('BOUNDED_NATIVE_HOST_FOCUS_TIMEOUT'));},5000);
      ws.addEventListener('open',()=>ws.send(JSON.stringify({id:1,method:'Page.bringToFront'})));
      ws.addEventListener('message',event=>{
        const response=JSON.parse(String(event.data));
        if(response.id!==1)return;clearTimeout(timer);ws.close();
        response.error?no(Error('NATIVE_BROWSER_HOST_FOCUS_FAILED')):yes();
      });
      ws.addEventListener('error',()=>{clearTimeout(timer);ws.close();no(Error('NATIVE_BROWSER_HOST_FOCUS_FAILED'));});
    });
    const selected=JSON.parse(await ab(['tab',assignedTab!,'--json']));
    assert(selected.success&&selected.data.tabId===assignedTab&&
      selected.data.targetId===assignedTarget,'Only the freshly verified assigned target may receive input');
    steps.push({action:'Native host window focus and assigned pane binding',method:'SUPPLIED_HOST_PAGE_FOCUS_THEN_REGISTERED_TAB_REBIND',targetId:selected.data.targetId});
  };
  const ab=async(args:string[],stdin?:string)=>{
    if(['click','focus','press','keyboard'].includes(args[0]!)&&!args[1]?.startsWith('@'))await foreground();
    return new Promise<string>((yes,no)=>{
    const started=performance.now(),step={command:args[0],target:args[0]==='eval'?'READ_OR_CAPTURE_NATIVE_EVENTS':args[1],status:'RUNNING',wallMs:0};
    steps.push(step);
    const cp=spawn('agent-browser',[...(desktop?['--cdp',process.env.AGENT_BROWSER_CDP!]:[]),...args],{cwd:repo,env:browserEnv,stdio:['pipe','pipe','pipe']});
    cp.stdin.end(stdin??'');let out='',err='';cp.stdout.on('data',b=>out+=b);cp.stderr.on('data',b=>err+=b);
    const timer=setTimeout(()=>{cp.kill('SIGKILL');no(Error('BOUNDED_BROWSER_COMMAND_TIMEOUT:'+args[0]));},45000);
    cp.once('error',error=>{clearTimeout(timer);no(error);});
    cp.once('close',code=>{clearTimeout(timer);step.status=code===0?'RETURNED':'FAILED';step.wallMs=performance.now()-started;
      code===0?yes(out):no(Error('BROWSER_COMMAND_FAILED:'+args[0]+':'+(err||out)));});
    });
  };
  const button=async(name:string,activation:'pointer'|'keyboard'=name==='Canvas'?'keyboard':'pointer')=>{
    await foreground();
    const fresh=await ab(['snapshot','-i']),lines=fresh.split('\n').filter(line=>line.includes('- button '+JSON.stringify(name)+' '));
    assert.equal(lines.length,1,'Exactly one current accessible button: '+name);
    const ref=lines[0]!.match(/\[ref=(e\d+)\]/)?.[1];assert(ref,'Current accessible button reference');
    await ab(['scrollintoview','@'+ref]);
    const position=await read(`JSON.stringify((()=>{
      const b=[...document.querySelectorAll("button")].find(b=>b.textContent?.trim()===${JSON.stringify(name)});
      if(!b)return null;const r=b.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);
      return {x,y,visible:!!r.width&&!!r.height,hit:hit?.closest("button")?.textContent?.trim(),focus:document.hasFocus()};
    })())`);
    steps.push({action:'Current native pointer target',name,position});
    assert(position?.visible&&position.hit===name,'Native target must own its actual hit point');
    if(activation==='keyboard'){
      await ab(['focus','@'+ref]);await ab(['press','Enter']);
    }else{
      await ab(['click','@'+ref]);
    }
  },
    snapshot=()=>ab(['snapshot','-s','[aria-label="Decision atlas review"]']),
    read=async(code:string)=>{const value=JSON.parse((await ab(['eval','--stdin'],code)).trim());return typeof value==='string'?JSON.parse(value):value;},
    next=spawn(process.execPath,[join(repo,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port','4790','--webpack'],{
      cwd:repo,env:{...process.env,NODE_ENV:'development',NEXT_PUBLIC_OS_API_URL:host.apiUrl,
        NEXT_PUBLIC_SUPABASE_URL:host.authUrl,NEXT_PUBLIC_SUPABASE_ANON_KEY:'disposable-local-auth-key',NEXT_TELEMETRY_DISABLED:'1'},
      stdio:['ignore','pipe','pipe'],
    });
  let log='',status='FAIL';next.stdout.on('data',b=>log+=b);next.stderr.on('data',b=>log+=b);
  try{
    await artifact('browser/inputs.json',{url,workId:p.workId,alternateWork:otherWork,threadId:thread.id,original:p.source,
      profile:'PREPARED_LOCAL_NEXT_REAL_SUPABASE_CLIENT_LOCAL_SIGNED_ISSUER',coldStartQualified:false,hostedAuthenticationQualified:false});
    for(let i=0;i<300&&!log.includes('Ready in');i++){
      if(next.exitCode!==null)throw Error('LOCAL_NEXT_EXITED');await new Promise(yes=>setTimeout(yes,100));
    }
    assert(log.includes('Ready in'),'Prepared local Next readiness within registered preparation interval');
    // Preparation is charged and not misreported as qualified cold response.
    await fetch(origin+'/centropy/login',{signal:AbortSignal.timeout(60000)});
    // The assigned Factory pane rejects Target.createTarget. Stay on its
    // authorized target; do not launch an unassigned headless substitute.
    await foreground();
    await ab(['--pin-tab','open',origin+'/centropy/login']);await ab(['wait','#centropy-login-password']);
    // Fixture authentication bootstrap uses an actually signed local bearer.
    // This is not login-form input proof. No hosted/user credentials are used.
    const email=p.principal+'@r7.test.invalid',session={access_token:host.issue({id:p.principal,email}),refresh_token:'disposable-unused',
      token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,
      user:{id:p.principal,email,role:'authenticated',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}};
    await ab(['eval','--stdin'],`localStorage.setItem("sb-127-auth-token",${JSON.stringify(JSON.stringify(session))}); undefined`);
    for(const route of ['/api/centropy/me',`/api/centropy/threads/${thread.id}?limit=100`]){
      const start=performance.now(),response=await fetch(origin+route,{headers:{authorization:'Bearer '+session.access_token},signal:AbortSignal.timeout(30000)});
      await response.arrayBuffer();steps.push({action:'Charged prepared development route readiness',route,status:response.status,wallMs:performance.now()-start});
      assert.equal(response.status,200);
    }
    await ab(['open',url]);await ab(['wait','--text','R7 checked policy Work']);
    await foreground();
    await ab(['eval','--stdin'],'window.focus(); undefined');
    await ab(['eval','--stdin'],'window.__r7Inputs=[]; for (const type of ["pointerdown","click","keydown","input"]) document.addEventListener(type,e=>window.__r7Inputs.push({type:e.type,trusted:e.isTrusted,key:e.key??null,pointerType:e.pointerType??null}),{capture:true}); undefined');
    steps.push({action:'Assigned rendered target input readiness',observed:await read('JSON.stringify({url:location.href,focus:document.hasFocus(),visibility:document.visibilityState,activeElement:document.activeElement?.tagName})')});
    await button('Canvas');await ab(['wait','--text','Exact decision atlas']);
    steps.push({action:'Actual Investigation Canvas mounts additive Capital atlas review',snapshot:await snapshot()});
    await ab(['focus','[aria-label="Immutable S1 affine source version"]']);
    await ab(['keyboard','type',p.evidenceVersionId]);
    steps.push({action:'Native binding input',observed:await read('JSON.stringify({value:document.querySelector(\'[aria-label="Immutable S1 affine source version"]\')?.value,events:window.__r7Inputs})')});
    await ab(['press','Enter']);
    await ab(['wait','--text','Parameter revision 1.']);await button('Build checked atlas');
    await ab(['wait','--text','Build QUEUED']);await input.worker();
    await ab(['wait','--text','Build COMPLETE']);await button('Query exact cell');
    await ab(['wait','--text','Recommended policy A']);steps.push({action:'Bearer proxy, durable queue, separate checked children, actual current original recommendation',snapshot:await snapshot()});
    for(const [value,expected,ties,worlds]of [['1/4','A','A, B','w0'],['1/2','A','A','w0, w1'],['2/3','A','A','w1'],
      ['20000000000001/30000000000000','B','B','w0, w1'],['3/4','B','B','w0, w1']] as const){
      await ab(['focus','[aria-label="Exact parameter x0"]']);await ab(['press','End']);
      const before=await read(`JSON.stringify((()=>{
        const i=document.querySelector('[aria-label="Exact parameter x0"]');
        return {value:i.value,start:i.selectionStart,end:i.selectionEnd};
      })())`);
      assert(before.value.length<=170&&before.start===before.value.length&&before.end===before.value.length,
        'Bounded native clearing starts at the actual end of the exact field');
      for(let i=0;i<before.value.length;i++)await ab(['press','Backspace']);
      assert.equal(await read('JSON.stringify(document.querySelector(\'[aria-label="Exact parameter x0"]\').value)'),'');
      await ab(['keyboard','type',value]);
      const entered=await read('JSON.stringify(document.querySelector(\'[aria-label="Exact parameter x0"]\').value)');
      assert.equal(entered,value,'Native field must contain the exact registered query value before submission');
      steps.push({action:'Native exact field replacement',before:before.value,entered});
      await ab(['press','Enter']);
      await ab(['wait','--text','Typed owner parameter revision persisted.']);
      await button('Query exact cell');await ab(['wait','--text','Recommended policy '+expected]);
      const text=await snapshot();assert(text.includes('Tied alternatives: '+ties+'.'));
      assert(text.includes('Worst complete worlds: '+worlds+'.'));
      steps.push({action:'Native exact owner parameter edit',value,expected,ties,worlds,snapshot:text});
    }
    const native=await read('JSON.stringify(window.__r7Inputs)');
    assert(native.some((e:any)=>e.type==='pointerdown'&&e.trusted&&e.pointerType==='mouse')&&
      native.some((e:any)=>e.type==='keydown'&&e.key==='Enter'&&e.trusted),
      'Trusted pointer and keyboard input required, no synthetic activation substitute');
    const context=(await input.call(p,'context',{workId:p.workId,root:dealRoot})).body;
    assert.deepEqual(context.parameters.values,['3/4']);assert.equal(context.lastQuery.choice.policyId,'B');
    await ab(['open',url]);await ab(['wait','--text','R7 checked policy Work']);await button('Canvas');
    await ab(['wait','--text','Recommended policy B']);
    steps.push({action:'Reload reconstructs durable current parameter and query bytes',snapshot:await snapshot(),parameterRef:context.parameters.ref});
    await ab(['screenshot',join(output,'browser/current.png')]);
    host.delay('/api/decision-atlases/query');await button('Query exact cell');
    for(let i=0;i<300&&!host.delayWaiting();i++)await new Promise(yes=>setTimeout(yes,50));
    assert(host.delayWaiting(),'Actual completed business response held in fixture transport');
    await ab(['pushstate',path(other.id)]);await ab(['wait','--text','R7 separate private Work']);host.release();
    await button('Canvas');await ab(['wait','--text','Exact decision atlas']);
    await ab(['wait','--fn','!document.querySelector(\'[aria-label="Checked atlas recommendation"]\')']);
    assert(!(await snapshot()).includes('synthetic-diagnostic'));
    steps.push({action:'Actual SPA Work switch fences delayed private response',snapshot:await snapshot()});
    await ab(['open',url]);await ab(['wait','--text','R7 checked policy Work']);await button('Canvas');
    await ab(['wait','--text','Recommended policy B']);
    host.delay('/api/decision-atlases/query');await button('Query exact cell');
    for(let i=0;i<300&&!host.delayWaiting();i++)await new Promise(yes=>setTimeout(yes,50));
    assert(host.delayWaiting());await ab(['click','[aria-label="Account menu"]']);await button('Sign out');host.release();
    await ab(['wait','--fn','!document.querySelector(\'[aria-label="Checked atlas recommendation"]\')']);
    assert(!(await ab(['snapshot'])).includes('Recommended policy B'));
    steps.push({action:'Real Supabase sign-out clears private outputs and fences delayed query',snapshot:await ab(['snapshot'])});
    await ab(['screenshot',join(output,'browser/private-cleared.png')]);status='PASS';
    return {status,steps,native,boundary:'ACTUAL_WORK_CANVAS_BEARER_PROXY_API_SQL_QUEUE_PHYSICAL_CHILDREN',coldStartQualified:false,hostedAuthenticationQualified:false};
  }catch(error){
    steps.push({action:'Native input failure evidence',observed:await read('JSON.stringify(window.__r7Inputs??[])').catch(()=>null)});
    const context=await input.call(p,'context',{workId:p.workId,root:dealRoot}).catch(()=>null);
    if(context?.status===200&&context.body.builds[0]&&context.body.parameters){
      const diagnostic=await input.call(p,'query',{buildId:context.body.builds[0].id,parameterRef:context.body.parameters.ref,
        idempotencyKey:'browser-failure-diagnostic',fallback:'REQUIRE_ADMITTED'}).catch(()=>null);
      steps.push({action:'Actual owner failure diagnostic',context,diagnostic});
    }
    steps.push({action:'Failure snapshot',snapshot:await ab(['snapshot']).catch(()=>'<browser unavailable>'),predicate:String(error)});
    throw error;
  }finally{
    host.release();await artifact('browser/results.json',{status,steps,log});
    next.kill('SIGTERM');if(next.exitCode===null)await new Promise<void>(yes=>{const timer=setTimeout(()=>{next.kill('SIGKILL');yes();},5000);next.once('exit',()=>{clearTimeout(timer);yes();});});
    if(!desktop)await ab(['close']).catch(()=>undefined);
  }
}

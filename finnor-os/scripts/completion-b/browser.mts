/** Preregistered mounted product E2E. Disposable issuer, real authentication,
 * proxy, production Work/Canvas composition, owner routes and durable worker. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {readdir,readFile} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createEmployeeConversationThread} from '@finnor/db';
import {createDeal} from '@finnor/private-equity';
import {POST as s3Post} from '../../apps/api/app/api/interventions/[operation]/route';

export async function mountedOriginalChallenge(input:{
 repo:string;output:string;support:any;admin:any;queue:any;api:any;artifact:any;
}){
 const {repo,output,support,admin,queue,api,artifact}=input,steps:any[]=[],traffic:any[]=[],qualification:string[]=[];
 const b=await support.fixture('b-original-browser-native',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]);
 await admin.query(`INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source)
  VALUES('provider:m4-native',2,2,0,120,true,'B original mounted disposable capacity') ON CONFLICT(resource_key) DO NOTHING`);
 const deal=await createDeal(b.ctx,{targetOrganizationId:b.root.entityId,name:'M3 mounted economic arrangement',
  dealLeadEmployeeId:b.principal,signedLoiAt:new Date(Date.now()-86400000),targetClosingAt:new Date(Date.now()+86400000)});
 // Creating the actual linked Deal changes S1 membership. Refit before binding
 // policies instead of reusing an earlier model under a changed owner cut.
 const fit=await api(b,'fit',{request:b.model.request},s3Post);
 assert.equal(fit.status,200);assert.equal(fit.body.status,'FITTED');b.model=fit.body.model;
 b.incumbent=await support.policy(b,'browser-base',{cash:25});
 await support.resource(b,'cash','USD','STOCK',['200','200','200']);
 const {receiveWork}=await import('@finnor/db');
 b.workId=(await receiveWork({tenantId:b.tenant,userId:b.principal,instruction:'Construct permitted economic arrangements in this Work',
  channel:'console',idempotencyKey:'m3-browser-work'})).workId;
 const thread=await createEmployeeConversationThread({tenantId:b.tenant,ownerEmployeeId:b.principal,title:'M3 economic arrangements'});
 const dealRoot={entityType:'pe_deal',entityId:String(deal.row.id)};
 await admin.query('UPDATE finnor_os.employee_conversation_threads SET active_work_id=$3,active_references=$4::jsonb WHERE tenant_id=$1 AND id=$2',
  [b.tenant,thread.id,b.workId,JSON.stringify([dealRoot])]);
 await artifact('browser/inputs.json',{profile:'DISPOSABLE_ASYMMETRIC_LOCAL_ISSUER',tenant:b.tenant,principal:b.principal,
  workId:b.workId,threadId:thread.id,dealRoot,companyRoot:b.root,incumbent:b.incumbent.ref,
  terms:['0.15'],repairTerms:['0.45'],structure:'IMMEDIATE',agreement:'UNILATERAL_PROPOSAL',
  originalDeadlinesUnchanged:true,usd:null});

 const identity=(await admin.query('SELECT email FROM finnor_os.users WHERE tenant_id=$1 AND id=$2',[b.tenant,b.principal])).rows[0];
 assert(identity&&typeof identity.email==='string','Actual disposable authenticated identity required');
 const email=identity.email,{privateKey,publicKey}=await generateKeyPair('RS256'),
  jwk={...await exportJWK(publicKey),alg:'RS256',use:'sig',kid:'m3-disposable-local'};
 const token=await new SignJWT({email,role:'authenticated'}).setProtectedHeader({alg:'RS256',kid:jwk.kid})
  .setSubject(b.principal).setIssuedAt().setExpirationTime('1h').sign(privateKey);
 const issuer=createServer((req,res)=>{
  res.setHeader('access-control-allow-origin','*');res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info');
  res.setHeader('content-type','application/json');
  if(req.method==='OPTIONS'){res.end();return;}
  if(req.url?.includes('.well-known/jwks.json')){res.end(JSON.stringify({keys:[jwk]}));return;}
  res.writeHead(404);res.end('{}');
 });
 const listen=async(server:ReturnType<typeof createServer>)=>{
  await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const address=server.address();
  assert(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}`;
 };
 const issuerUrl=await listen(issuer),prior={url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY,bypass:process.env.AUTH_DEV_BYPASS};
 process.env.SUPABASE_URL=issuerUrl;process.env.SUPABASE_SERVICE_ROLE_KEY='m3-disposable-public-key';process.env.AUTH_DEV_BYPASS='0';
 const apiRoot=join(repo,'finnor-os/apps/api/app/api'),routes:Array<{file:string;parts:string[];dynamic:number}>=[];
 async function scan(directory:string){
  for(const entry of await readdir(directory,{withFileTypes:true})){
   const path=join(directory,entry.name);
   if(entry.isDirectory())await scan(path);
   else if(entry.name==='route.ts'){const parts=relative(apiRoot,directory).split('/');routes.push({file:path,parts,dynamic:parts.filter(p=>p.startsWith('[')).length});}
  }
 }
 await scan(apiRoot);routes.sort((a,b)=>a.dynamic-b.dynamic);
 const canonical=new Map<string,any>(),issued=new Map<string,any>();
 const backend=createServer(async(req,res)=>{
  const start=performance.now();
  try{
   const url=new URL(req.url??'/','http://127.0.0.1'),parts=url.pathname.replace(/^\/api\//,'').split('/').map(decodeURIComponent);
   let found:{file:string;params:Record<string,string>}|undefined;
   for(const route of routes){
    if(route.parts.length!==parts.length)continue;
    const params:Record<string,string>={};let matched=true;
    for(let i=0;i<parts.length;i++){const segment=route.parts[i]!;
     if(segment.startsWith('[')&&!segment.startsWith('[...'))params[segment.slice(1,-1)]=parts[i]!;
     else if(segment!==parts[i]){matched=false;break;}
    }
    if(matched){found={file:route.file,params};break;}
   }
   if(!found){res.writeHead(404);res.end('{}');return;}
   let body='';for await(const bytes of req){body+=bytes;if(body.length>2_000_000)throw Error('FIXTURE_BODY_BOUND');}
   const module=await import(pathToFileURL(found.file).href),handler=module[req.method??'GET'];
   if(!handler){res.writeHead(405);res.end('{}');return;}
   const headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(typeof value==='string')headers.set(key,value);
   const response:Response=await handler(new Request(url,{method:req.method,headers,
    ...(!['GET','HEAD'].includes(req.method??'GET')?{body}: {})}),{params:Promise.resolve(found.params)}),text=await response.text();
   if(url.pathname.startsWith('/api/company-brain/capital-program-')&&response.ok){
    const data=JSON.parse(text);
    if(data.program)canonical.set(data.queryId,data.program);
    if(data.bytes)canonical.set('module:'+data.ref.contentDigest,data);
   }
   if(url.pathname.startsWith('/api/company-brain/counterexample-')&&response.ok){
    const data=JSON.parse(text);if(data.report)issued.set(data.searchId,data);
   }
   res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json','cache-control':'no-store'});res.end(text);
   traffic.push({path:url.pathname,method:req.method,status:response.status,wallMs:performance.now()-start,
    bearerPresent:Boolean(req.headers.authorization),at:new Date().toISOString()});
  }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"Disposable route host failed"}');
   traffic.push({path:req.url,status:500,diagnostic:String(error)});}
 });
 const upstream=await listen(backend),next=spawn(process.execPath,[join(repo,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port','0'],{
  cwd:repo,env:{...process.env,NODE_ENV:'development',NEXT_PUBLIC_OS_API_URL:upstream,NEXT_PUBLIC_SUPABASE_URL:issuerUrl,
   NEXT_PUBLIC_SUPABASE_ANON_KEY:'m3-disposable-public-key',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe'],
 });
 let log='',stopped=false,worker:Promise<void>=Promise.resolve();
 next.stdout!.on('data',bytes=>log+=bytes);next.stderr!.on('data',bytes=>log+=bytes);
 const desktop=Boolean(process.env.FACTORY_DESKTOP_CDP_PORT&&process.env.AGENT_BROWSER_CDP);
 const browserEnv={PATH:process.env.PATH!,HOME:process.env.HOME!,TMPDIR:process.env.TMPDIR!,
  AGENT_BROWSER_SESSION:process.env.AGENT_BROWSER_SESSION??'m3-mounted-native'};
 const ab=(args:string[],stdin?:string)=>new Promise<string>((yes,no)=>{
  const began=performance.now();
  const child=spawn('agent-browser',[...(desktop?['--cdp',process.env.AGENT_BROWSER_CDP!]:[]),...args],{
   cwd:repo,env:browserEnv,stdio:['pipe','pipe','pipe'],
  });
  child.stdin!.end(stdin??'');let out='',err='';child.stdout!.on('data',bytes=>out+=bytes);child.stderr!.on('data',bytes=>err+=bytes);
  const timer=setTimeout(()=>{child.kill('SIGKILL');no(Error(`BROWSER_COMMAND_TIMEOUT:${args[0]}`));},45000);
  child.once('error',error=>{clearTimeout(timer);no(error);});
  child.once('close',code=>{clearTimeout(timer);steps.push({action:'Browser command completion, not input proof',
   command:args[0],exitCode:code,wallMs:performance.now()-began});
   code===0?yes(out):no(Error(`BROWSER_COMMAND_FAILED:${args[0]}:${err||out}`));});
 });
 const evaluate=async(source:string)=>{
  const raw=JSON.parse((await ab(['eval','--stdin'],source)).trim());return typeof raw==='string'?JSON.parse(raw):raw;
 };
 const nativeTarget=async(kind:'button'|'label',name:string,selector?:string,scrolls=0,mode:'pointer'|'focus'='pointer')=>{
  const box=await evaluate(`JSON.stringify((()=>{
   const found=${selector?`document.querySelector(${JSON.stringify(selector)})`:`[...document.querySelectorAll(${JSON.stringify(kind)})].find(element=>
    (element.getAttribute("aria-label")??${kind==='label'?'[...element.childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join("")':'element.textContent'}??"").trim()===${JSON.stringify(name)})`};
   const target=${kind==='button'?'found':'found?.querySelector("input,select,textarea")'};
   if(!target)return null;const rect=target.getBoundingClientRect();
   let node=target;const parts=[];while(node&&parts.length<64){
    const siblings=node.parentElement?[...node.parentElement.children].filter(element=>element.localName===node.localName):[node];
    parts.unshift(node.localName+":nth-of-type("+(siblings.indexOf(node)+1)+")");node=node.parentElement;
   }
   let scroller=target.parentElement;while(scroller&&!(scroller.scrollHeight>scroller.clientHeight&&
    ["auto","scroll"].includes(getComputedStyle(scroller).overflowY)))scroller=scroller.parentElement;
   const scrollRect=scroller?.getBoundingClientRect();
   return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,bottom:rect.bottom,top:rect.top,documentUrl:location.href,
    targetWidth:rect.width,targetHeight:rect.height,height:innerHeight,width:innerWidth,
    positionSelector:node?null:parts.join(" > "),
    scrollPoint:scrollRect?{x:Math.max(1,Math.min(innerWidth-1,scrollRect.x+scrollRect.width/2)),
     y:Math.max(1,Math.min(innerHeight-1,(Math.max(0,scrollRect.top)+Math.min(innerHeight,scrollRect.bottom))/2))}:null,
    hit:document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)?.tagName,
    hitWithin:target.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)),
    disabled:target.disabled,focus:document.hasFocus(),visibility:document.visibilityState};})())`);
  assert(box,'Native '+kind+' target not found: '+name);
  steps.push({action:'Native target geometry',kind,name,selector,box});
  assert(box.targetWidth>0&&box.targetHeight>0,'Native target is not rendered: '+name);
  assert.equal(box.disabled,false,'Native target is disabled: '+name);
  assert.equal(box.visibility,'visible','Native target page is hidden: '+name);
  assert(scrolls<8,'Native scroll bound: '+name);
  if(box.top<0||box.bottom>box.height){
   assert(box.positionSelector,'Position-only selector bound: '+name);
   steps.push({action:'Position-only scroll, not activation',kind,name,selector:box.positionSelector});
   await ab(['scrollintoview',box.positionSelector]);
   await ab(['wait','--fn',`(()=>{
    const target=document.querySelector(${JSON.stringify(box.positionSelector)});if(!target)return false;
    const rect=target.getBoundingClientRect();return rect.top>=0&&rect.bottom<=innerHeight;})()`]);
   return nativeTarget(kind,name,selector,scrolls+1,mode);
  }
  assert(box.x>=0&&box.x<box.width,'Native target lies outside horizontal viewport: '+name);
  assert(box.hitWithin,'Native target is covered: '+name);
  assert(box.positionSelector,'Exact rendered target selector bound: '+name);
  await ab(['focus',box.positionSelector]);
  await ab(['wait','--fn',`document.activeElement===document.querySelector(${JSON.stringify(box.positionSelector)})`]);
  steps.push({action:'Exact control focus, not activation',kind,name,mode});
  if(mode==='focus')return;
  const x=Math.round(box.x),y=Math.round(box.y);
  await ab(['mouse','move',String(x),String(y)]);
  const rechecked=await evaluate(`JSON.stringify((()=>{
   const target=document.querySelector(${JSON.stringify(box.positionSelector)});if(!target)return null;
   const rect=target.getBoundingClientRect(),hit=document.elementFromPoint(${x},${y});
   return {documentUrl:location.href,visible:document.visibilityState==="visible",disabled:target.disabled,
    hitWithin:target.contains(hit),pointInside:${x}>=rect.left&&${x}<rect.right&&${y}>=rect.top&&${y}<rect.bottom,
    viewportInside:${x}>=0&&${x}<innerWidth&&${y}>=0&&${y}<innerHeight};})())`);
  assert(rechecked,'Native target disappeared after movement: '+name);
  assert.equal(rechecked.documentUrl,box.documentUrl,'Native target document changed after movement');
  assert(rechecked.visible&&!rechecked.disabled&&rechecked.hitWithin&&rechecked.pointInside&&rechecked.viewportInside,
   'Native target changed or became covered after movement: '+name);
  steps.push({action:'Exact integer pointer target rechecked before down',kind,name,x,y,rechecked});
  try{await ab(['mouse','down','left']);}finally{await ab(['mouse','up','left']);}
 };
 const button=(name:string)=>nativeTarget('button',name);
 const keyboardButton=async(name:string)=>{
  await nativeTarget('button',name,undefined,0,'focus');await ab(['press','Enter']);
 };
 const fill=async(name:string,value:string)=>{
  await nativeTarget('label',name,undefined,0,'focus');await ab(['press','Meta+a']);await ab(['keyboard','type',value]);
 };
 const choose=async(name:string,index:number)=>{
  await nativeTarget('label',name);await ab(['press','Home']);
  for(let i=0;i<index;i++)await ab(['press','ArrowDown']);await ab(['press','Enter']);
 };
 const tick=async()=>{
  while(!stopped){await queue.tick();if(!stopped)await new Promise(yes=>setTimeout(yes,200));}
 };
 let url='',inputStatus='NOT_RUN';
 try{
  for(let tries=0;tries<600;tries++){
   const match=log.match(/Local:\s+(http:\/\/[^ \n]+)/);
   if(match){url=`${match[1]}/centropy/investigations/${thread.id}?root=${encodeURIComponent(JSON.stringify(dealRoot))}`;break;}
   if(next.exitCode!==null)throw Error('NEXT_START_FAILED');await new Promise(yes=>setTimeout(yes,100));
  }
  assert(url,'Next did not start');
  await ab(['open',url]);await ab(['wait','--text','Sign in']);
  const session={access_token:token,refresh_token:'disposable-unused',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+3600,
   user:{id:b.principal,email,role:'authenticated',aud:'authenticated',app_metadata:{},user_metadata:{},created_at:new Date().toISOString()}};
  await ab(['eval','--stdin'],`localStorage.setItem("sb-127-auth-token",${JSON.stringify(JSON.stringify(session))}); undefined`);
  await ab(['open',url]);await ab(['wait','--text','M3 economic arrangements']);
  const viewport=await evaluate('JSON.stringify({width:innerWidth,height:innerHeight,focused:document.hasFocus(),visible:document.visibilityState==="visible"})');
  steps.push({action:'Actual assigned product viewport',viewport});
  if(!viewport.visible||viewport.width<=0||viewport.height<=0){
   inputStatus='BLOCKED_TOOL';qualification.push('Assigned authenticated product document has no visible nonzero viewport. No emulated viewport or synthetic input substituted.');
   return {contractStatus:'PARTIAL_VALIDATION',inputStatus,steps,qualification};
  }
  await ab(['eval','--stdin'],`window.__m3WorkspaceInput=[];for(const name of ["click","keydown","keyup","pointerdown","pointerup"])
   document.addEventListener(name,event=>{
    window.__m3WorkspaceInput.push({type:event.type,key:event.key??null,tag:event.target.tagName,trusted:event.isTrusted,
     exactCanvas:(event.target?.textContent??"").trim()==="Canvas"});
   },{capture:true}); undefined`);
  const beforeCanvas=await ab(['snapshot']);
  await keyboardButton('Canvas');
  await ab(['wait','--fn','window.__m3WorkspaceInput.some(event=>event.trusted&&event.exactCanvas&&event.type==="keydown"&&event.key==="Enter")']).catch(error=>{
   steps.push({action:'Trusted Canvas event wait refused',diagnostic:String(error)});
  });
  const canvasInput=await evaluate('JSON.stringify(window.__m3WorkspaceInput)');
  steps.push({action:'Native exact Canvas keyboard activation',events:canvasInput,before:beforeCanvas,after:await ab(['snapshot'])});
  if(!canvasInput.some((event:any)=>event.trusted&&event.exactCanvas&&event.type==='keydown'&&event.key==='Enter')){
   inputStatus='BLOCKED_TOOL';qualification.push('Assigned native Enter delivered no trusted keydown on the exact Canvas button. No synthetic activation substitute used.');
   return {contractStatus:'PARTIAL_VALIDATION',inputStatus,steps,qualification};
  }
  await ab(['wait','--text','Load current arrangements']);
  steps.push({action:'Actual authenticated Investigation Canvas',snapshot:await ab(['snapshot'])});
  await ab(['eval','--stdin'],`window.__m3Input=[];for(const name of ["click","keydown","keyup","input","pointerdown","pointerup"])document.addEventListener(name,event=>{
   if(event.target?.closest?.(".ct-capital-program"))window.__m3Input.push({type:event.type,key:event.key??null,tag:event.target.tagName,trusted:event.isTrusted});
  },{capture:true}); undefined`);
  await button('Load current arrangements');await ab(['wait','--text','Choose an arrangement and its permitted parameter domain.']);
  // Labels resolve native controls. No DOM click/value mutation fallback may
  // turn a failed assigned-pane input driver into pointer/keyboard evidence.
  await choose('Incumbent arrangement',1);await choose('Commitment',1);await choose('Economic parameter',1);
  await fill('Exact owner unit','fraction');await fill('Permitted new terms','0.15');
  await nativeTarget('label','Include a two-period committed exposure');
  await choose('Agreement requirement',1);
  await nativeTarget('label','Include wait/stop alternatives');
  await ab(['focus','.ct-capital-program button[type="submit"]']);await ab(['press','Enter']);
  const inputs=await evaluate('JSON.stringify(window.__m3Input)');
  const pointer=inputs.some((e:any)=>e.type==='pointerdown'&&e.trusted)&&inputs.some((e:any)=>e.type==='click'&&e.trusted),
   keyboard=inputs.some((e:any)=>e.type==='keydown'&&e.key==='Enter'&&e.trusted);
  steps.push({action:'Pointer and keyboard dispatch',pointer,keyboard,events:inputs});
  if(!pointer||!keyboard){inputStatus='BLOCKED_TOOL';qualification.push('Assigned pane delivered no required trusted input; no DOM activation substitute used');return {contractStatus:'PARTIAL_VALIDATION',inputStatus,steps,qualification};}
  inputStatus='TRUSTED_POINTER_AND_KEYBOARD';
  await ab(['wait','--text','Durable search queued.']);url=(await ab(['get','url'])).trim();
  worker=tick().catch(error=>{steps.push({action:'Actual worker failure',diagnostic:String(error)});});
  await ab(['wait','--text','Modeled arrangements, not agreed transactions']);
  const queryId=await evaluate('JSON.stringify(new URL(location.href).searchParams.get("capitalQuery"))'),program=canonical.get(queryId);
  assert(program);assert(program.candidates.some((c:any)=>c.terms.some((t:any)=>t.after==='0.15')));
  await artifact('browser/current-program.json',program);
  steps.push({action:'Durable worker and canonical arrangement comparison',queryId,programRef:program.ref,snapshot:await ab(['snapshot'])});
  await fill('Changed repair terms','0.45');await keyboardButton('Challenge current programme');
  await ab(['wait','--text','NO_WITNESS_WITHIN_BUDGET']);
  const originalSearchId=await evaluate('JSON.stringify(new URL(location.href).searchParams.get("capitalChallenge"))'),
   original=issued.get(originalSearchId);
  assert(original?.report);assert.equal(original.report.schema,'finnor.m4.challenge-result.v1');
  assert.equal(original.report.candidate.contentDigest,program.ref.contentDigest);
  await keyboardButton('Construct challenged economic repair');
  await ab(['wait','--fn',`new URL(location.href).searchParams.get("capitalQuery")!==${JSON.stringify(queryId)}&&Boolean(document.querySelector(".ct-capital-program__candidates"))`]);
  const repairId=await evaluate('JSON.stringify(new URL(location.href).searchParams.get("capitalQuery"))'),
   repair=canonical.get(repairId);
  assert(repair);assert.deepEqual(repair.challengeEvidence,[original.report.ref]);
  assert(repair.candidates.some((candidate:any)=>candidate.terms.some((term:any)=>term.after==='0.45')&&candidate.changedResponseRecomputed));
  const originalRow=(await admin.query('SELECT deadline_at,attempted,refinement_steps FROM finnor_os.m3_queries WHERE id=$1',[queryId])).rows[0],
   childRow=(await admin.query('SELECT deadline_at,attempted,refinement_steps FROM finnor_os.m3_queries WHERE id=$1',[repairId])).rows[0];
  assert.equal(childRow.deadline_at.getTime(),originalRow.deadline_at.getTime());
  await keyboardButton('Rechallenge repaired programme');
  await ab(['wait','--fn',`new URL(location.href).searchParams.get("capitalChallenge")!==${JSON.stringify(originalSearchId)}&&Boolean(new URL(location.href).searchParams.get("capitalChallenge"))&&document.querySelector('[aria-label="Original programme challenge"]')?.textContent?.includes("NO_WITNESS_WITHIN_BUDGET")`]);
  const linkedSearchId=await evaluate('JSON.stringify(new URL(location.href).searchParams.get("capitalChallenge"))'),
   linked=issued.get(linkedSearchId);
  assert(linked?.report);assert.equal(linked.report.schema,'finnor.m4.challenge-result.v1');
  assert.deepEqual(linked.report.parentResultRef,original.report.ref);
  assert.equal(linked.report.candidate.contentDigest,repair.ref.contentDigest);assert.equal(linked.deadlineAt,original.deadlineAt);
  assert(original.trials+linked.trials<=512);
  await artifact('browser/original-loop.json',{queryId,repairId,program,repair,original,linked,originalRow,childRow,
   originalEvidenceUnchanged:true,qualification:'LOCAL_NATIVE_MOUNTED_NOT_ADMISSION',usd:null});
  steps.push({action:'Actual original challenge, changed economic repair and linked original rechallenge',
   queryId,repairId,originalSearchId,linkedSearchId,snapshot:await ab(['snapshot'])});
  await ab(['screenshot',join(output,'browser/original-loop.png')]);
  const repairedCandidateIndex=repair.candidates.findIndex((candidate:any)=>candidate.moduleRef&&candidate.terms.some((term:any)=>term.after==='0.45'));
  assert(repairedCandidateIndex>=0,'Actual changed module candidate required');
  const repairedCandidate=repair.candidates[repairedCandidateIndex],article=`.ct-capital-program__candidates article:nth-child(${repairedCandidateIndex+1})`;
  await nativeTarget('button','Inspect arrangement',article+' button:first-child');await ab(['wait','--text','Observable timeline and resource occupation']);
  assert.equal(await evaluate('JSON.stringify(document.activeElement?.getAttribute("aria-label"))'),'Arrangement witnesses');
  steps.push({action:'Current owner/M1 witnesses and inspection focus',snapshot:await ab(['snapshot'])});
  const sourceButtons=await evaluate('JSON.stringify([...document.querySelectorAll(".ct-capital-program button")].filter(b=>b.getAttribute("aria-label")?.startsWith("Inspect source witness for")).map(b=>b.getAttribute("aria-label")))');
  assert(sourceButtons.length);await button(sourceButtons[0]);await ab(['wait','--fn','Boolean(document.querySelector(".ct-capital-program [aria-label=\\"Arrangement witnesses\\"] pre"))']);
  steps.push({action:'Authentic M1 material variable witness',snapshot:await ab(['snapshot'])});
  await button('Close arrangement witnesses');
  assert.equal(await evaluate('JSON.stringify(document.activeElement?.textContent)'),'Inspect arrangement');
  const module=repairedCandidate.moduleRef,downloadPath=join(output,'browser/module-download.json');
  await ab(['download',article+' button:nth-child(2)',downloadPath]);
  const downloaded=await readFile(downloadPath),served=canonical.get('module:'+module.contentDigest);
  assert(served);assert.equal(createHash('sha256').update(downloaded).digest('hex'),served.sha256);
  steps.push({action:'Actual byte download',ref:module,sha256:served.sha256,path:downloadPath});
  url=(await ab(['get','url'])).trim();
  await ab(['open',url]);await ab(['wait','--text','Modeled arrangements, not agreed transactions']);
  assert.equal(canonical.get(repairId).ref.contentDigest,repair.ref.contentDigest);
  steps.push({action:'Reload reconstructs original durable bytes',snapshot:await ab(['snapshot'])});
  await ab(['screenshot',join(output,'browser/current.png')]);
  const audit=JSON.parse(await ab(['a11y','--selector','.ct-capital-program','--tags','wcag2a,wcag2aa','--json']));
  await artifact('browser/axe.json',audit);assert.equal(audit.data?.counts?.violations??audit.counts?.violations,0);
  if((audit.data?.counts?.incomplete??audit.counts?.incomplete??0)>0)qualification.push('Some rendered accessibility checks remain incomplete');
  steps.push({action:'Actual accessibility audit',audit});
  stopped=true;await worker;
  await receiveWork({tenantId:b.tenant,userId:b.principal,workId:b.workId,
   instruction:'Actual changed economic Work input for immutable linked recompilation',channel:'console',idempotencyKey:'m3-browser-revised-work'});
  await button('Recheck current sources');await ab(['wait','--text','invalidated']);
  steps.push({action:'Genuine revised Work invalidates original programme',snapshot:await ab(['snapshot'])});
  await button('Recompile current Work');await ab(['wait','--text','queued']);
  await button('Cancel search');await ab(['wait','--text','cancelled']);
  const cancelled=await evaluate('JSON.stringify(new URL(location.href).searchParams.get("capitalQuery"))');
  await queue.tick();const cancelledRow=(await admin.query('SELECT status,result_digest FROM finnor_os.m3_queries WHERE tenant_id=$1 AND id=$2',[b.tenant,cancelled])).rows[0];
  assert.equal(cancelledRow.status,'CANCELLED');assert.equal(cancelledRow.result_digest,null);
  await button('Resume original grant');await ab(['wait','--text','Owner refused:']);
  steps.push({action:'Real queued cancellation, fence and no renewed grant',queryId:cancelled,snapshot:await ab(['snapshot'])});
  await admin.query("UPDATE finnor_os.users SET status='suspended' WHERE tenant_id=$1 AND id=$2",[b.tenant,b.principal]);
  await ab(['open',url]);await ab(['wait','--fn','!document.querySelector(".ct-capital-program__candidates")']);
  steps.push({action:'Principal revocation clears product values',snapshot:await ab(['snapshot'])});
  assert(traffic.every(t=>!t.path?.startsWith('/api/company-brain/capital-program-')||t.bearerPresent));
  return {contractStatus:qualification.length?'PARTIAL_VALIDATION':'PASS',inputStatus,steps,qualification,
   boundary:'ACTUAL_CENTROPY_WORK_CANVAS_PROXY_ASYMMETRIC_BEARER_SQL_DURABLE_QUEUE_NATIVE_OWNERS',hostedAuthenticationQualified:false};
 }catch(error){
  await ab(['snapshot']).then(snapshot=>steps.push({action:'Failure snapshot',snapshot})).catch(()=>undefined);
  await artifact('browser/failure.json',{message:String(error),stack:(error as Error).stack});
  throw error;
 }finally{
  stopped=true;await worker;
  if(url)await ab(['eval','--stdin'],`if(location.origin===new URL(${JSON.stringify(url)}).origin)localStorage.removeItem("sb-127-auth-token"); undefined`).catch(()=>undefined);
  await artifact('browser/results.json',{url,inputStatus,steps,qualification,traffic});
  await artifact('browser/next-log.json',{log});
  next.kill('SIGTERM');if(next.exitCode===null)await new Promise<void>(yes=>{
   const timer=setTimeout(()=>{next.kill('SIGKILL');yes();},5000);next.once('exit',()=>{clearTimeout(timer);yes();});
  });
  await new Promise<void>(yes=>backend.close(()=>yes()));await new Promise<void>(yes=>issuer.close(()=>yes()));
  for(const [key,value]of Object.entries({SUPABASE_URL:prior.url,SUPABASE_SERVICE_ROLE_KEY:prior.key,AUTH_DEV_BYPASS:prior.bypass}))
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  if(!desktop)await ab(['close']).catch(()=>undefined);
 }
}

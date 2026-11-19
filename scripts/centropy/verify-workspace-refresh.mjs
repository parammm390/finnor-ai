import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'

const root=resolve(import.meta.dirname,'../..'),require=createRequire(join(root,'finnor-os/package.json'))
const output=process.argv[2],baseline=process.argv.find(a=>a.startsWith('--baseline='))?.slice(11)
assert(output?.startsWith('/')&&(!baseline||/^[a-f0-9]{40}$/.test(baseline)))
await mkdir(output,{recursive:false})
const directory=await mkdtemp(join(tmpdir(),'finnor-workspace-refresh-'))
const workspace='src/components/centropy/shell/CentropyWorkspace.tsx'
const override=baseline?execFileSync('git',['show',baseline+':'+workspace],{cwd:root,encoding:'utf8',maxBuffer:1024*1024}):null
const navigation=join(directory,'navigation.mjs')
await writeFile(navigation,`import {useSyncExternalStore} from 'react';
const subscribe=fn=>{window.addEventListener('popstate',fn);return()=>window.removeEventListener('popstate',fn)};
const current=()=>useSyncExternalStore(subscribe,()=>location.pathname+location.search);
window.__navigate=url=>{history.pushState({},'',url);window.dispatchEvent(new PopStateEvent('popstate'))};
export const usePathname=()=>{current();return location.pathname};
export const useSearchParams=()=>{current();return new URLSearchParams(location.search)};
export const useRouter=()=>({push:window.__navigate,replace:window.__navigate});`)
await require('esbuild').build({entryPoints:[join(root,'scripts/centropy/workspace-refresh.fixture.tsx')],
 outdir:join(directory,'assets'),bundle:true,splitting:true,format:'esm',platform:'browser',jsx:'automatic',
 alias:{'@':join(root,'src'),'next/navigation':navigation},nodePaths:[join(root,'node_modules')],
 define:{'process.env':JSON.stringify({NODE_ENV:'production',NEXT_PUBLIC_FINNOR_AUTH_PROVIDER:'workos'})},
 logLevel:'error',plugins:[{name:'pinned-workspace-baseline',setup(build){build.onLoad({filter:/CentropyWorkspace\.tsx$/},
  args=>override&&args.path===join(root,workspace)?{contents:override,loader:'tsx'}:undefined)}}]})
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const rootRef={entityType:'pe_fund',entityId:id(30)},at='2026-11-15T00:00:00.000Z'
let principal=1,mode='ok',held=[];const calls=[],rows=[]
const thread=n=>({id:id(n),title:`Authored Investigation ${n}`,summary:null,revision:1,activeWorkId:id(n+10),
 activeObjectiveLoopId:null,lastActivityAt:at,createdAt:at,summaryThroughSequence:0,activeReferences:[],unresolvedReferences:[],outcomeRefs:[]})
const work=workId=>({work:{id:workId,status:'completed',initialInstruction:'Authored refresh regression Work',executionModel:'objective',
 currentOwnerId:null,assignedTo:null,createdAt:at,updatedAt:at,failure:null,recovery:null,finalOutcome:null},
 read:{limit:100,complete:true,truncatedTables:[]},planRevisions:[],receipts:[],actions:[],businessEffects:[],objectiveSteps:[],queryExecutions:[],eventWaits:[]})
const send=(response,status,body)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});response.end(JSON.stringify(body))}
const server=createServer(async(request,response)=>{
 const url=new URL(request.url,'http://localhost'),path=url.pathname
 if(path==='/__control'){
  const chunks=[];for await(const chunk of request)chunks.push(chunk)
  const input=JSON.parse(Buffer.concat(chunks).toString());if(input.mode)mode=input.mode;if(input.principal)principal=input.principal
  if(input.release){for(const entry of held)if(!entry.response.destroyed)send(entry.response,200,{work:work(entry.workId)});held=[]}
  return send(response,200,{mode,principal,held:held.length})
 }
 if(path.startsWith('/api/')){
  calls.push({path,method:request.method})
  if(path==='/api/auth/session')return send(response,200,{session:{user:{id:id(principal)},access_token:'authored-renderer-'+principal,expires_at:Math.floor(Date.now()/1000)+3600}})
  if(path==='/api/centropy/me')return send(response,200,{userId:id(principal),employeeId:null,tenantId:id(90),role:'owner',authority:null})
  if(path==='/api/centropy/threads')return send(response,200,{threads:[thread(40),thread(41)],nextCursor:null})
  if(/^\/api\/centropy\/threads\/[^/]+\/canvas$/.test(path))return send(response,200,{state:null})
  const selectedThread=path.match(/^\/api\/centropy\/threads\/([^/]+)$/)
  if(selectedThread)return send(response,200,{thread:thread(selectedThread[1]===id(40)?40:41),messages:[]})
  const selectedWork=path.match(/^\/api\/centropy\/works\/([^/]+)$/)
  if(selectedWork){
   if(mode==='hold'){held.push({response,workId:selectedWork[1]});return}
   if(mode==='503'||mode==='404')return send(response,Number(mode),{error:mode==='404'?'PE_ENTITY_NOT_FOUND':'TEMPORARY_RENDERER_FAULT'})
   return send(response,200,{work:work(selectedWork[1])})
  }
  if(path==='/api/centropy/company-brain/projection')return send(response,200,{root:rootRef,asOf:at,nodes:[],edges:[],
   temporal:{support:'authored',completeness:'complete',baseline:null,reasons:[]},sourceStatus:[],bounds:{nodes:0,edges:0,truncated:false,maxNodes:100,maxEdges:100}})
  if(path==='/api/centropy/company-brain/application-projection'){
   const chunks=[];for await(const chunk of request)chunks.push(chunk)
   const input=JSON.parse(Buffer.concat(chunks).toString())
   return send(response,200,{schema:'finnor.x2.work-projection.v1',tenantId:id(90),principalId:id(principal),workId:input.workId,root:rootRef,sessions:[]})
  }
  return send(response,404,{error:'AUTHORED_RENDERER_HAS_NO_OTHER_BUSINESS_API'})
 }
 if(path.startsWith('/centropy')){response.writeHead(200,{'content-type':'text/html'});return response.end('<!doctype html><html><link rel="stylesheet" href="/assets/workspace-refresh.fixture.css"><div id="root"></div><script type="module" src="/assets/workspace-refresh.fixture.js"></script></html>')}
 const file=resolve(directory,path.slice(1));if(!file.startsWith(directory+'/'))return send(response,403,{})
 try{response.writeHead(200,{'content-type':path.endsWith('.css')?'text/css':'text/javascript'});response.end(await readFile(file))}catch{return send(response,404,{})}
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const origin=`http://127.0.0.1:${server.address().port}`,route=n=>`/centropy/investigations/${id(n)}?root=${encodeURIComponent(JSON.stringify(rootRef))}`
const {chromium}=require('playwright'),browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],
 ...(process.env.FINNOR_TEST_CHROMIUM?{executablePath:process.env.FINNOR_TEST_CHROMIUM}:{})})
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[]
page.on('pageerror',error=>errors.push(error.message.slice(0,160)))
await page.addInitScript(()=>{window.IntersectionObserver=class{observe(){}unobserve(){}disconnect(){}takeRecords(){return[]}}})
const control=async input=>{const r=await fetch(origin+'/__control',{method:'POST',body:JSON.stringify(input)});assert(r.ok)}
const open=async()=>{await page.getByRole('navigation',{name:'Canvas instruments'}).getByRole('button',{name:/Work and verification$/}).click();
 await page.locator('.ct-application-semantics[data-application-work="'+id(50)+'"]').waitFor({timeout:5000})}
const refresh=()=>page.getByRole('button',{name:'Refresh Canvas sources',exact:true}).click()
let stage='INITIAL_WORK'
try{
 await page.goto(origin+route(40));await open()
 rows.push({id:'actual-workspace-private-source-and-application-mount',status:'PASS'})
 const panel=page.locator('.ct-application-semantics');await panel.evaluate(node=>node.dataset.retentionProof='same-instance')
 stage='HELD_SAME_SCOPE_REFRESH';await control({mode:'hold'});await refresh()
 await page.getByText('Checking sources…',{exact:true}).waitFor()
 assert.equal(await panel.count(),1,'same-scope refresh unmounted the application instrument')
 assert.equal(await panel.getAttribute('data-retention-proof'),'same-instance')
 rows.push({id:'held-refresh-retains-same-mounted-instance',status:'PASS'})
 await control({mode:'ok',release:true});await page.getByRole('button',{name:'Refresh Canvas sources',exact:true}).waitFor()
 stage='RETRYABLE_SOURCE_FAILURE';await control({mode:'503'});await refresh()
 await page.getByText('Checking sources…',{exact:true}).waitFor({state:'detached'})
 assert.equal(await panel.getAttribute('data-retention-proof'),'same-instance')
 rows.push({id:'retryable-read-failure-retains-instance',status:'PASS'})
 stage='HARD_SOURCE_REFUSAL';await control({mode:'404'});await refresh();await panel.waitFor({state:'detached'})
 rows.push({id:'hard-refusal-clears-private-instrument',status:'PASS'})
 await control({mode:'ok'});await refresh();await open()
 stage='WORK_SWITCH_AND_LATE_OLD_RESPONSE';await control({mode:'hold'});await refresh()
 await page.evaluate(url=>window.__navigate(url),route(41));await panel.waitFor({state:'detached'})
 await control({mode:'ok',release:true});
 await page.getByRole('navigation',{name:'Canvas instruments'}).getByRole('button',{name:/Work and verification$/}).click()
 await page.locator('.ct-application-semantics[data-application-work="'+id(51)+'"]').waitFor()
 assert.equal(await page.locator('.ct-application-semantics[data-application-work="'+id(50)+'"]').count(),0)
 rows.push({id:'work-switch-rejects-late-old-response',status:'PASS'})
 stage='PRINCIPAL_REPLACEMENT';await control({principal:2,mode:'404'})
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')))
 await panel.waitFor({state:'detached'})
 assert(!calls.some(c=>/application-(?:acquire|execute|cancel)$|\/actions$/.test(c.path)))
 rows.push({id:'principal-replacement-clears-private-scope-without-effects',status:'PASS'})
 assert.deepEqual(errors,[])
}catch(error){rows.push({id:'workspace-refresh',status:'FAIL',stage,error:error.message.slice(0,300),browserErrors:errors});process.exitCode=1}
finally{
 const paths=[workspace,'src/components/centropy/canvas/use-canvas-sources.ts','src/components/centropy/lib/use-private-request-scope.ts',
  'src/components/centropy/canvas/CanvasDocument.tsx','src/components/centropy/canvas/ApplicationSemanticsPanel.tsx',
  'scripts/centropy/workspace-refresh.fixture.tsx','scripts/centropy/verify-workspace-refresh.mjs']
 const inputs=Object.fromEntries(await Promise.all(paths.map(async path=>[path,createHash('sha256').update(path===workspace&&override?override:await readFile(join(root,path))).digest('hex')])))
 await writeFile(join(output,'result.json'),JSON.stringify({schema:'finnor.workspace-refresh-e2e.v1',status:rows.length===6&&rows.every(r=>r.status==='PASS')?'PASS':'FAIL',
  baseline:baseline??null,rows,inputs,browser:await browser.version(),calls,
  qualification:'ACTUAL_PRODUCTION_WORKSPACE_AUTH_PRIVATE_HOOKS_CANVAS_AND_APPLICATION_PANEL_WITH_AUTHORED_READ_ONLY_HTTP_AND_NEXT_ROUTER_ADAPTER_NOT_NATIVE_Z0_ACCEPTANCE',
  rerun:'FINNOR_TEST_CHROMIUM=<matching local browser> node scripts/centropy/verify-workspace-refresh.mjs <new absolute evidence directory>'},null,2)+'\n')
 await browser.close();for(const entry of held)entry.response.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
}
assert(rows.length===6&&rows.every(row=>row.status==='PASS'),'Workspace refresh E2E failed; inspect result.json')

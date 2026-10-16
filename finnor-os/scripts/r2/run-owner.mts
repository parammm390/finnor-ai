import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {appendFile,mkdir,mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {join,resolve,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:http';
import {spawnSync,spawn} from 'node:child_process';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import {closePool,getPool,receiveWork,createEmployeeConversationThread,configureTenantVertical} from '@finnor/db';
import {migrate} from '../../packages/db/migrate';
import {createDeal} from '@finnor/private-equity';
import {createEvidenceSource} from '@finnor/memory';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mts';
import {POST as allocationPost} from '../../apps/api/app/api/allocations/[operation]/route';
import {POST as s3Post} from '../../apps/api/app/api/interventions/[operation]/route';
import {POST as s4Post} from '../../apps/api/app/api/policies/[operation]/route';
import {POST as s6Post} from '../../apps/api/app/api/obligations/[operation]/route';
import {POST as p1Post} from '../../apps/api/app/api/coalition-programmes/[operation]/route';
import {quantities,originalDecimal,hash,ref} from './fixtures.mts';
import {R2_PROFILE,R2_VERSION} from '../../packages/shared-types/src/robust-programme-search';
import {writeM3Record,readM3Record} from '../../packages/private-equity/src/capital-program/v2-store';
import {loadEnterpriseBeliefView} from '../../packages/private-equity/src/enterprise-beliefs';
import {m3Ref,m3Hash} from '../../packages/private-equity/src/capital-program/v2-contracts';
import {r2Ref} from '../../packages/private-equity/src/capital-program/r2-native';
const repo=resolve('..'),out=process.env.FINNOR_R2_EVIDENCE_DIR!,cases:any[]=[],traffic:any[]=[],began=new Date().toISOString(),serve=process.argv.includes('--serve'),caseFlag=process.argv.indexOf('--case'),lane=caseFlag<0?'positive':process.argv[caseFlag+1];
assert(['positive','responsibility','compatibility','diagnostic','coalition'].includes(lane??''),'Unknown registered owner lane');
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const artifact=async(name:string,value:unknown)=>{const path=join(out,name);await mkdir(resolve(path,'..'),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(value,null,2));return path;};
const onlyIndex=process.argv.indexOf('--only'),only=onlyIndex<0?null:new Set(process.argv[onlyIndex+1]?.split(','));
async function challenge(id:string,run:()=>Promise<unknown>){if(only&&!only.has(id)&&!['authenticated-contingent-owner','authentication-and-private-scope'].includes(id))return;const start=performance.now();try{cases.push({id,status:'PASS',observed:await run(),wallMs:performance.now()-start});}catch(error){cases.push({id,status:'FAIL',error:String(error),stack:(error as Error).stack,wallMs:performance.now()-start});}console.log(JSON.stringify({id,status:cases.at(-1).status}));await save();}
async function save(){await artifact('results.json',{schema:lane==='coalition'?'finnor.r5.durable-native-component-e2e.v1':'finnor.r2.owner-e2e.v1',began,finishedAt:new Date().toISOString(),cases,traffic,money:null,moneyStatus:'UNMETERED',rerun:'python3 finnor-os/scripts/r2/run-owner-local.py'+(lane==='coalition'?' --case coalition':''),qualification:lane==='coalition'?'Actual authenticated R5 durable native component only. Canonical S4/S5/S6 functional completion NOT CLAIMED. Mounted, installed, protected admission and economic gain NOT RUN.':'Disposable real signed bearer, ordinary SQL role, actual owners and protocol-2 worker. Protected admission/production activation/economic gain NOT RUN.'});}
const listen=async(server:ReturnType<typeof createServer>)=>{await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const addr=server.address();assert(addr&&typeof addr!=='string');return `http://127.0.0.1:${addr.port}`;};
const portServer=createServer(),portUrl=await listen(portServer),port=Number(new URL(portUrl).port);await new Promise<void>(yes=>portServer.close(()=>yes()));
const pgdir=await mkdtemp(join(tmpdir(),'finnor-r2-owner-')),postgres=new EmbeddedPostgres({databaseDir:pgdir,user:'finnor',password:'finnor',port,persistent:lane==='compatibility',onLog:(message:string)=>{void appendFile(join(out,"postgres.log"),message+"\n").catch(()=>undefined);}});
let admin:pg.Client|undefined,issuer:ReturnType<typeof createServer>|undefined,backend:ReturnType<typeof createServer>|undefined,next:ReturnType<typeof spawn>|undefined,upstream='',token='',workerUrl='',acceptedQueryId='',coalitionSelectionRef:any=null,coalitionAllocationRef:any=null,coalitionScheduleRef:any=null,coalitionP1Ref:any=null,f:any,request:any,stopped=false;const privateIdentities:Array<{scope:string;id:string;tenant:string;email:string}>=[];
const fixtureApi=async(scope:any,operation:string,body:unknown,handler=allocationPost)=>{const response=await handler(new Request('http://127.0.0.1/api/'+operation,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':scope.tenant,'x-user-id':scope.principal,...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)}),{params:Promise.resolve({operation})});return {status:response.status,body:await response.json() as any};};
const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
const api=async(operation:string,body:unknown,bearer=token)=>{const response=await fetch(upstream+'/api/company-brain/'+operation,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bearer},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as any};};
let tickNumber=0,activeWorker:ReturnType<typeof spawn>|undefined,preparedWorker:{child:ReturnType<typeof spawn>;stdout:string;stderr:string;started:number;ready:number;exit:Promise<number|null>}|undefined;
async function prepareTick(){
 if(preparedWorker)return;
 const started=performance.now(),child=spawn(process.execPath,['--import','tsx','scripts/r2/worker-child.mts','--wait'],{cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:workerUrl},stdio:['pipe','pipe','pipe']}),prepared={child,stdout:'',stderr:'',started,ready:0,exit:Promise.resolve<number|null>(null)};
 prepared.exit=new Promise((yes,no)=>{child.once('error',no);child.once('exit',yes);});child.stdout.on('data',bytes=>prepared.stdout+=bytes);child.stderr.on('data',bytes=>prepared.stderr+=bytes);
 for(let i=0;i<300&&!prepared.stdout.includes('R2_ACTUAL_WORKER_READY');i++){if(child.exitCode!==null)throw Error(prepared.stderr);await new Promise(yes=>setTimeout(yes,100));}
 assert(prepared.stdout.includes('R2_ACTUAL_WORKER_READY'),'Actual worker registry startup exceeded fixture preparation bound');prepared.ready=performance.now();preparedWorker=prepared;
}
async function tick(flags:string[]=[],allowKilled=false){
 const number=++tickNumber,start=performance.now(),warm=flags.length===0?preparedWorker:undefined; if(warm)preparedWorker=undefined;
 const child=warm?.child??spawn(process.execPath,['--import','tsx','scripts/r2/worker-child.mts',...flags],{cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:workerUrl},stdio:['ignore','pipe','pipe']});activeWorker=child;
 let stdout='',stderr='';if(!warm){child.stdout!.on('data',bytes=>stdout+=bytes);child.stderr!.on('data',bytes=>stderr+=bytes);}else child.stdin!.end('go');
 const code=await(warm?.exit??new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('exit',yes);}));stdout=warm?.stdout??stdout;stderr=warm?.stderr??stderr;
 await artifact('worker/tick-'+number+'.json',{pid:child.pid,code,signal:child.signalCode,stdout,stderr,wallMs:performance.now()-start,preparationWallMs:warm?warm.ready-warm.started:0,preparationBeforeAdmission:Boolean(warm)});
 if(!allowKilled)assert.equal(code,0,stderr+'\n'+stdout);return {pid:child.pid,code,signal:child.signalCode};
}
async function drain(id:string){
 const deadline=(await admin!.query('SELECT deadline_at FROM finnor_os.m3_queries WHERE id=$1',[id])).rows[0].deadline_at.getTime();
 let value:any;await durable(id);
 for(let i=0;i<16&&Date.now()<deadline;i++){await tick();value=ok(await api('capital-program-read',{queryId:id}));await durable(id);if(!['QUEUED','RUNNING'].includes(value.status))break;await new Promise(yes=>setTimeout(yes,250));}
 assert(value&&!['QUEUED','RUNNING'].includes(value.status),JSON.stringify(value));return value;
}
async function durable(id:string){await artifact('durable/'+id+'.json',{query:(await admin!.query('SELECT * FROM finnor_os.m3_queries WHERE id=$1',[id])).rows,events:(await admin!.query('SELECT * FROM finnor_os.m3_events WHERE query_id=$1 ORDER BY created_at,id',[id])).rows,jobs:(await admin!.query("SELECT * FROM finnor_os.jobs WHERE payload->>'queryId'=$1",[id])).rows,leases:(await admin!.query("SELECT * FROM finnor_os.compute_resource_leases WHERE owner_id LIKE $1",['r2:'+id+':%'])).rows});}
async function newQuery(label:string){await prepareTick();const workId=(await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'R2 original-domain '+label,channel:'console',idempotencyKey:randomUUID()})).workId;
 return ok(await api('capital-program-submit',{...request,workId,idempotencyKey:label+':'+randomUUID()}),202);}
async function nativeChild(id:string,phase:string){
 for(let n=0;n<600;n++){
  const event=(await admin!.query("SELECT body FROM finnor_os.m3_events WHERE query_id=$1 AND kind='R2_PHYSICAL_CHILD' AND body->>'state'='STARTED' AND body->>'phase'=$2 ORDER BY created_at DESC LIMIT 1",[id,phase])).rows[0];
  if(event){const supervisor=Number(event.body.supervisorPid),children=spawnSync('/usr/bin/pgrep',['-P',String(supervisor)],{encoding:'utf8'}).stdout.trim().split(/\s+/).map(Number).filter(Number.isSafeInteger);
   for(const pid of children){if(pid<=0)continue;const identity=spawnSync('/bin/ps',['-o','ppid=','-o','comm=','-p',String(pid)],{encoding:'utf8'}).stdout.trim(),parts=identity.split(/\s+/),command=parts.slice(1).join(' ');if(Number(parts[0])===supervisor&&command&&command!=='ps'&&!command.endsWith('/ps')){try{process.kill(pid,'SIGSTOP');return {pid,supervisor,command,event:event.body};}catch{}}}
  }await new Promise(yes=>setTimeout(yes,20));
 }await durable(id);throw Error('INTENDED_PHYSICAL_CHILD_NOT_OBSERVED:'+phase);
}
async function exited(pid:number){for(let n=0;n<200;n++){try{process.kill(pid,0);}catch{return true;}await new Promise(yes=>setTimeout(yes,20));}return false;}
try{
 await postgres.initialise();await appendFile(join(pgdir,'postgresql.conf'),'\ntrack_commit_timestamp=on\n');await postgres.start();await postgres.createDatabase('r2_owner');
 const url=`postgres://finnor:finnor@127.0.0.1:${port}/r2_owner`;
 if(lane==='compatibility'){
  const directory=join(repo,'finnor-os/packages/db/migrations'),files=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')&&name!=='0183_r2_robust_programme_search.sql').map(async name=>({name,sql:await readFile(join(directory,name),'utf8')})));
  await migrate(url,files);const prior=new pg.Client({connectionString:url});await prior.connect();const before=(await prior.query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows;await prior.end();
  const applied=await migrate(url);await postgres.stop();await postgres.start();const after=new pg.Client({connectionString:url});await after.connect();await artifact('migration-upgrade-restart.json',{before,applied,after:(await after.query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows,roles:(await after.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor_app','finnor_worker')")).rows});await after.end();assert.deepEqual(applied,['0183_r2_robust_programme_search.sql']);
 }else await migrate(url);
 admin=new pg.Client({connectionString:url});await admin.connect();admin.on("error",error=>{console.log(JSON.stringify({event:"DISPOSABLE_DATABASE_CONNECTION_LOST",error:String(error)}));});await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");await admin.query("ALTER ROLE finnor_worker LOGIN PASSWORD 'finnor_worker'");await admin.query("SET app.test_vertical_mode='explicit'");
 workerUrl=`postgres://finnor_worker:finnor_worker@127.0.0.1:${port}/r2_owner`;
 process.env.DATABASE_URL=`postgres://finnor_app:finnor_app@127.0.0.1:${port}/r2_owner`;await closePool();
 const generated=spawnSync(process.env.FINNOR_S3_PYTHON!,[join(repo,'finnor-os/scripts/s3/reference.py')],{input:JSON.stringify({operation:'equivalent'}),encoding:'utf8',timeout:30000});assert.equal(generated.status,0,generated.stderr);
 const rows=JSON.parse(generated.stdout).rows;
 // The existing S3 convex-hull guard correctly requires the registered
 // quadratic action doses to be present on the observed feature manifold.
 // These are declared synthetic observations, not fitted values or receipts.
 for(const row of rows){const residual=row.states.outcome-row.exposures.price;row.exposures.price=[0,.15,.3,-.15][row.period%4];row.states.outcome=row.exposures.price+residual;}
 const day=86400000,support=createUpstreamFixtureSupport({admin:()=>admin,generatedRows:rows,begin:new Date(Math.floor(Date.now()/day)*day-128*day).toISOString(),day,fixtures:{},api:fixtureApi,artifact});
 f=await support.fixture('r2-owner-contingent',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200,...(lane==='coalition'?{resourceClass:'CASH'}:{})}]);
 for(const scope of ['other-principal','other-tenant']){const id=randomUUID(),email=scope+'-'+id+'@r2.example.test',tenant=scope==='other-tenant'?randomUUID():f.tenant;
  if(scope==='other-tenant')await admin.query('INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,$3)',[tenant,randomUUID(),'R2 private scope challenge']);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[id,tenant,email]);privateIdentities.push({scope,id,tenant,email});
 }
 const deal=await createDeal(f.ctx,{targetOrganizationId:f.root.entityId,name:'R2 declared-world commitments',dealLeadEmployeeId:f.principal,signedLoiAt:new Date(Date.now()-day),targetClosingAt:new Date(Date.now()+day)});
 const modelRequest=structuredClone(f.model.request);modelRequest.roots.push({entityType:'pe_deal',entityId:String(deal.row.id)});modelRequest.mechanisms[0].equations[0].features=[{kind:'CONSTANT'},{kind:'EXPOSURE',id:'price',lag:0},{kind:'PRODUCT',left:{kind:'EXPOSURE',id:'price',lag:0},right:{kind:'EXPOSURE',id:'price',lag:0}}];
 const fit=ok(await fixtureApi(f,'fit',{request:modelRequest},s3Post));assert.equal(fit.status,'FITTED');f.model=fit.model;
 const base=await support.policy(f,'incumbent',{cash:25}),problem=structuredClone(base.problem);
 problem.observations=[{schema:'finnor.s2.control-observation.v1',id:'public-milestone',sourceRef:ref('registered-public-milestone','S2'),variableId:'outcome',unit:'normalized-value',delayPeriods:1,afterActionIds:['programme-incumbent'],bins:[{category:'LOW',lowerInclusive:-6,upperExclusive:.3},{category:'HIGH',lowerInclusive:.3,upperExclusive:6}],qualification:'SUPPLIED_DETERMINISTIC_COARSENING_UNVERIFIED'}];
 const replanned=ok(await fixtureApi(f,'replan',{mandate:f.mandate,problem,protocols:[],scenarios:{pathsPerMechanism:4,seed:20261002},priorPolicyRef:base.ref,reason:'Original owner milestone for bounded contingent commitments'},s4Post));assert.equal(replanned.status,'POLICY_AVAILABLE');f.incumbent=replanned.policy;
 await support.resource(f,'cash','USD','STOCK',['200','200','200'],undefined,[],{permittedRoots:f.incumbent.bindings.beliefPins.map((pin:any)=>pin.root)});
 f.workId=(await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'Compare complete permitted observable commitments under declared adverse worlds',channel:'console',idempotencyKey:randomUUID()})).workId;
 const thread=await createEmployeeConversationThread({tenantId:f.tenant,ownerEmployeeId:f.principal,title:'R2 declared-world arrangements'}),dealRoot={entityType:'pe_deal',entityId:String(deal.row.id)};
 await admin.query('UPDATE finnor_os.employee_conversation_threads SET active_work_id=$3,active_references=$4::jsonb WHERE tenant_id=$1 AND id=$2',[f.tenant,thread.id,f.workId,JSON.stringify([dealRoot])]);
 const modelHistory=f.model.history.rows.slice(-3).map((row:any)=>({states:row.states,exposures:row.exposures})),initialHistory=modelHistory.map((row:any)=>({states:Object.fromEntries(Object.entries(row.states).map(([k,v])=>[k,originalDecimal(v as number)])),exposures:Object.fromEntries(Object.entries(row.exposures).map(([k,v])=>[k,originalDecimal(v as number)]))}));
 const source={schema:'finnor.s3.exact-control-source.v1',qualification:'SUPPLIED_EXACT_FINITE_MODEL_UNADMITTED',mandateRef:f.mandate.ref,problemDigest:hash(f.incumbent.problem),modelRef:f.model.ref,
  quantities:quantities({mandate:f.mandate,problem:f.incumbent.problem,history:modelHistory}),accounting:{ref:f.mandate.utility.accountingConventionRef,entityRef:ref(f.root.entityId,'S1'),unit:'USD',currency:'USD',valuationDate:f.mandate.horizon.startAt,ownerShare:'1',timeBasis:f.mandate.horizon,discountConvention:'ORIGINAL_OWNER_FACTORS'},mechanisms:modelRequest.mechanisms.map((m:any)=>({id:m.id,equations:m.equations})),stateUnits:{outcome:'normalized-value'},stateRanges:{outcome:['-6','6']},exposureIds:['price'],
  worlds:[{id:'C',mechanismId:'registered',initialHistory,coefficients:[['0','8/3','-40/3']],shocks:[['0'],['2']],inquiryTokens:{},accruedUtility:'0'},{id:'A',mechanismId:'registered',initialHistory,coefficients:[['0','4','-40/9']],shocks:[['0'],['0']],inquiryTokens:{},accruedUtility:'0'}],completeWorldDeclaration:'ALL_DECLARED_JOINT_WORLDS_NO_PROBABILITIES'};
 const sourceId=(await createEvidenceSource(f.tenant,{sourceKey:'r2-exact-'+randomUUID(),sourceType:'pe_document_claim',title:'Declared exact finite adverse hypotheses'})).id,versionId=randomUUID(),content=JSON.stringify(source),contentDigest=sha(content);
 await admin.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at) VALUES($1,$2,'tenant',$3,1,$4,$5,$6::jsonb,clock_timestamp(),clock_timestamp(),clock_timestamp())",[versionId,sourceId,f.tenant,contentDigest,content,JSON.stringify({worldRoot:f.root,claims:[{propositionId:'r2-exact-worlds',predicate:'reported',value:'Supplied exact finite H1 hypotheses; no causal or economic qualification'}]})]);
 // The existing permissioned source-object reader uses the actual immutable
 // S1 tenant version, its worldRoot snapshot, byte hash and provider rights.
 // A supplied hypothesis is not a metric observation or a canonical root edit.
 request={schema:'finnor.capital-program-request.v2',workId:f.workId,idempotencyKey:'r2-owner-positive',incumbentPolicyRef:f.incumbent.ref,purpose:'COMMERCIAL',permitted:{actionId:'programme-incumbent',exposureId:'price',unit:'fraction',terms:['0.3'],startPeriods:[0],structures:['IMMEDIATE','OBSERVABLE_STAGE'],stageFractions:['0.5'],resourceRule:'SCALE_REGISTERED_ACTION_LINEAR',agreement:'UNILATERAL_PROPOSAL',milestone:{instrumentId:'public-milestone',tokens:['HIGH']}},
  robust:{schema:'finnor.r2.request.v1',domainProfile:R2_PROFILE,source:{sourceId,versionId,contentDigest},initialWorlds:['C'],budget:{maxPaths:50000,maxHistories:50000,maxVariables:100000,maxRows:300000,maxProofBytes:8388608,cpuMs:30000,memoryMiB:2048,maxNativeCalls:128}},resource:{deadlineMs:30000,maxAttempts:8,maxGenerated:64,maxExpansions:50000,maxRefinementSteps:4096,maxRefinementDepth:6,maxModuleBytes:65536,maxResultBytes:8388608}};
 await artifact('inputs.json',{fixture:f,request,source,independentExpected:{incumbent:{A:'50',C:'210'},immediate:{A:'80',C:'160'},observable:{A:'100',C:'210'},optimum:'100',chosenStructure:'OBSERVABLE_STAGE',restrictedUpper:'210',originalAdmission:'UNADMITTED'}});
 const keys=await generateKeyPair('RS256'),jwk={...await exportJWK(keys.publicKey),alg:'RS256',use:'sig',kid:'r2-disposable'},email='r2-owner-contingent@s5.example.test';
 token=await new SignJWT({email,role:'authenticated'}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setSubject(f.principal).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
 issuer=createServer(async(req,res)=>{res.setHeader('access-control-allow-origin','*');res.setHeader('access-control-allow-headers','authorization,apikey,content-type,x-client-info,x-supabase-api-version');res.setHeader('content-type','application/json');if(req.method==='OPTIONS'){res.end();return;}if(req.url?.includes('.well-known/jwks.json')){res.end(JSON.stringify({keys:[jwk]}));return;}
  if(req.url?.startsWith('/auth/v1/token')){let body='';for await(const bytes of req)body+=bytes;const input=JSON.parse(body||'{}');if(input.email!==email||input.password!=='r2-disposable-local-password'){res.writeHead(400);res.end('{"error":"invalid_grant","error_description":"Invalid disposable credentials"}');return;}res.end(JSON.stringify({access_token:token,refresh_token:'r2-disposable',token_type:'bearer',expires_in:3600,user:{id:f.principal,email,role:'authenticated',aud:'authenticated',app_metadata:{provider:'email'},user_metadata:{},created_at:began}}));return;}
  if(req.url?.startsWith('/auth/v1/user')){res.end(JSON.stringify({id:f.principal,email,role:'authenticated',aud:'authenticated',app_metadata:{},user_metadata:{}}));return;}res.writeHead(404);res.end('{}');});
 const issuerUrl=await listen(issuer);process.env.SUPABASE_URL=issuerUrl;process.env.SUPABASE_SERVICE_ROLE_KEY='r2-disposable-public-key';process.env.AUTH_DEV_BYPASS='0';
 const routeRoot=join(repo,'finnor-os/apps/api/app/api'),routes:any[]=[];
 async function scan(dir:string){for(const entry of await readdir(dir,{withFileTypes:true})){const path=join(dir,entry.name);if(entry.isDirectory())await scan(path);else if(entry.name==='route.ts'){const parts=relative(routeRoot,dir).split('/');routes.push({path,parts,dynamic:parts.filter(p=>p.startsWith('[')).length});}}}await scan(routeRoot);routes.sort((a,b)=>a.dynamic-b.dynamic);
 backend=createServer(async(req,res)=>{try{const url=new URL(req.url??'/','http://127.0.0.1'),parts=url.pathname.replace(/^\/api\//,'').split('/').map(decodeURIComponent),route=routes.find(route=>route.parts.length===parts.length&&route.parts.every((p:string,i:number)=>p.startsWith('[')||p===parts[i]));if(!route){res.writeHead(404);res.end('{}');return;}const params=Object.fromEntries(route.parts.flatMap((p:string,i:number)=>p.startsWith('[')?[[p.slice(1,-1),parts[i]]]:[]));let body='';for await(const bytes of req){body+=bytes;if(body.length>2_000_000)throw Error('HTTP_BODY_BOUND');}const module=await import(pathToFileURL(route.path).href),headers=new Headers();for(const[k,v]of Object.entries(req.headers))if(typeof v==='string')headers.set(k,v);const response=await module[req.method??'GET'](new Request(url,{method:req.method,headers,...(!['GET','HEAD'].includes(req.method??'GET')?{body}:{})}),{params:Promise.resolve(params)});const text=await response.text();res.writeHead(response.status,{'content-type':'application/json','cache-control':'no-store'});res.end(text);traffic.push({path:url.pathname,status:response.status,bearerPresent:headers.has('authorization'),at:new Date().toISOString()});}catch(error){res.writeHead(500,{'content-type':'application/json'});res.end('{"error":"Disposable route host failure"}');traffic.push({path:req.url,status:500,error:String(error)});}});upstream=await listen(backend);
 if(lane==='coalition')await challenge('authenticated-coalition-durable-native-component',async()=>{
  const otherRoot={entityType:'external_organization',entityId:randomUUID()};
  await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$3,'other')",
   [otherRoot.entityId,f.tenant,'r5-party-'+otherRoot.entityId]);
  const snapshot=ok(await fixtureApi(f,'resources',{})),cash=snapshot.resources.find((r:any)=>r.resourceId==='cash');
  const {ref:cashRef,revision:_revision,priorRef:_prior,...cashBody}=cash;
  const revised=ok(await fixtureApi(f,'resource',{resource:{...cashBody,permittedRoots:[...cashBody.permittedRoots,otherRoot]},expectedRef:cashRef}));
  const second=await support.resource(f,'party-1-cash','USD','STOCK',['200','200','200'],undefined,[],{
   legalEntityRef:ref(otherRoot.entityId,'S1'),resourceClass:'CASH',permittedRoots:[f.root,otherRoot,dealRoot]});
  const compute=await support.resource(f,'compute','native-attempt','CUMULATIVE_EXPENDITURE',['4','4','4'],undefined,[],{
   resourceClass:'COMPUTE',permittedRoots:[f.root,otherRoot,dealRoot]});
  const corpus=spawnSync(process.env.FINNOR_R2_PYTHON!,['-c',"import sys,json;sys.path.insert(0,sys.argv[1]);from corpus import joint;print(json.dumps(joint(2)))",
   join(repo,'finnor-os/scripts/r5')],{encoding:'utf8'});assert.equal(corpus.status,0,corpus.stderr);
  const original=JSON.parse(corpus.stdout),resources=[revised,second,compute];
  const workInput=(await admin!.query('SELECT id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[f.tenant,f.workId])).rows[0];
  original.owner={...original.owner,tenantId:f.tenant,principalId:f.principal,workId:f.workId,workRevision:workInput.id,
   originalEpisodeId:'supplied-original-'+f.workId,originalBudgetGrantRef:ref('supplied-capped-native-descriptor-'+f.workId,'BUSINESS_OWNER'),
   originalDeadline:new Date(Date.now()+600000).toISOString(),dependencies:[]};
  original.model.ref=f.model.ref;original.objective.mandateRef=f.mandate.ref;original.unit=f.mandate.utility.unit;
  original.controlDemand={schema:'finnor.r5.control-demand.v1',
   dimensions:f.mandate.resources.dimensions.map((dimension:any)=>({dimensionId:dimension.id,totalResourceId:dimension.id,occupancyResourceId:null})),
   humanSecondsByOperator:Object.fromEntries(original.grammar.operators.map((operator:any)=>[operator.id,'0'])),
   staffing:'NO_EXISTING_EMPLOYMENT_OR_BENEFIT_CHANGE',terminalLiabilityResourceId:null};
  original.dates=Array.from({length:3},(_,date)=>new Date(Date.parse(f.mandate.horizon.startAt)+date*f.mandate.horizon.periodMs).toISOString());
  original.valuationDate=original.dates[0];original.discountFactors=['1','1','1'];
  original.resources=resources.map(r=>({id:r.resourceId,sourceRef:r.ref,unit:r.unit,kind:'CUMULATIVE_EXPENDITURE',
   available:Object.fromEntries(original.worlds.map((w:any)=>[w.id,r.resourceId==='compute'?['4','4','4']:['200','200','200']]))}));
  original.parties.forEach((party:any,index:number)=>{
   party.partyRef=ref('canonical:external_organization:'+[f.root,otherRoot][index].entityId,'S1');
   party.fundingRef=resources[index].ref;
   party.settledCash=Object.fromEntries(original.worlds.map((w:any)=>[w.id,['200','200','200']]));
  });
  original.grammar.operators.forEach((operator:any)=>{
   operator.modelRef=f.model.ref;
   operator.grantChoices=operator.grantChoices.map((grant:any)=>Object.fromEntries(resources.map(r=>[r.resourceId,
    [...(grant[r.resourceId]??['0','0']),'0']])));
  });
  const canonicalSnapshot=ok(await fixtureApi(f,'resources',{}));
  original.canonicalAllocation={schema:'finnor.r5.canonical-allocation-basis.v1',mandate:f.mandate,
   resources:canonicalSnapshot.resources,outstanding:canonicalSnapshot.outstanding,
   snapshotDigest:canonicalSnapshot.snapshotDigest,knowledgeAt:new Date().toISOString()};
  const coalitionSourceId=(await createEvidenceSource(f.tenant,{sourceKey:'r5-original-'+randomUUID(),sourceType:'pe_document_claim',title:'R5 supplied exact joint coalition programme'})).id;
  const coalitionVersion=randomUUID(),bytes=JSON.stringify(original),contentDigest=sha(bytes);
  await admin!.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at) VALUES($1,$2,'tenant',$3,1,$4,$5,$6::jsonb,clock_timestamp(),clock_timestamp(),clock_timestamp())",
   [coalitionVersion,coalitionSourceId,f.tenant,contentDigest,bytes,JSON.stringify({worldRoot:f.root,claims:[{predicate:'reported',value:'Supplied unadmitted mathematical model; no consent/effect/admission claim'}]})]);
  const {robust:_robust,...transport}=request;
  request={...transport,idempotencyKey:'r5-durable-native-component',coalition:{schema:'finnor.r5.owner-request.v1',
   source:{sourceId:coalitionSourceId,versionId:coalitionVersion,contentDigest}}};
  await artifact('r5-inputs.json',{original,request,expected:{qualification:'DURABLE_NATIVE_COMPONENT_NOT_FUNCTIONAL_OWNER_PASS',lower:'9',upper:'9'}});
  await prepareTick();const submitted=ok(await api('capital-program-submit',request),202);acceptedQueryId=submitted.queryId;
  const value=await drain(submitted.queryId),programme=value.program?.coalitionProgramme;assert(programme,JSON.stringify(value));
  assert.equal(value.status,'PARTIAL');assert.equal(programme.status,'INCOMPLETE');assert.equal(programme.lower,'9');assert.equal(programme.upper,'9');
  assert.equal(programme.checker.candidateDigest,m3Hash(programme.candidate));assert.equal(programme.checker.feasible,true);
  assert.equal(programme.executionAuthorityGranted,false);assert.equal(programme.owners.s5JointReservationRef,null);
  assert(programme.owners.s4SelectionRef,'Canonical S4 choice was not reached');
  const selected=ok(await fixtureApi(f,'coalition-read',{selectionRef:programme.owners.s4SelectionRef},s4Post));
  coalitionSelectionRef=selected.ref;
  assert.equal(selected.schema,'finnor.s4.coalition-selection.v1');assert.equal(selected.value,'9');
  assert.equal(selected.checker.candidateDigest,m3Hash(programme.candidate));
  const nativeReadback=await readM3Record<{candidate:unknown}>(f.ctx,'modules',programme.nativeComponentRef);
  assert.equal(selected.tie.originalCandidateDigest,m3Hash(nativeReadback.body.candidate));
  assert.equal(selected.programmeExecutableQualified,false);assert.equal(selected.executionAuthorityGranted,false);
  assert.equal(selected.reservationGranted,false);
  const point=value.program.allocation.checks[0];assert(point?.feasible,'Original canonical S5 point was not reached');
  assert.equal(point.objective,'9');assert(point.witnesses.some((w:any)=>w.constraintId==='resource:cash'));
  assert(point.envelopes.some((e:any)=>e.resourceId==='cash'&&e.quantities.some((v:string)=>v!=='0')),
   'Original coordination costs and signed payer responsibility were omitted');
  assert(programme.consents.every((c:any)=>c.status==='PROPOSED'&&c.evidenceRef===null));
  const jobs=(await admin!.query("SELECT type,status,protocol_version FROM finnor_os.jobs WHERE payload->>'queryId'=$1",[submitted.queryId])).rows;
  assert(jobs.every(job=>job.type==='run_coalition_programme_v1'&&job.protocol_version===2));
  const physical=(await admin!.query("SELECT body FROM finnor_os.m3_events WHERE query_id=$1 AND kind='R5_PHYSICAL_CHILD'",[submitted.queryId])).rows;
  assert(physical.some(event=>event.body.state==='EXITED'&&event.body.receipt.physicalExitObserved));
  await artifact('r5-durable-native-component.json',{submitted,value,jobs,physical});
  assert(programme.owners.p1ProgrammeRef,'Actual selected P1 programme was not compiled/checked');
  coalitionP1Ref=programme.owners.p1ProgrammeRef;
  const p1Module=ok(await fixtureApi(f,'read',{programmeRef:coalitionP1Ref},p1Post));
  assert.equal(p1Module.module.candidateDigest,m3Hash(programme.candidate));
  assert.equal(p1Module.checked.result.programmeQualified,true);
  assert.equal(p1Module.module.executionAuthorityGranted,false);
  const handoff=ok(await fixtureApi(f,'run',{programmeRef:coalitionP1Ref},p1Post));
  assert.equal(handoff.stage,'STOP_UNADMITTED_EFFECT');assert.equal(handoff.settlementEstablished,false);
  assert.deepEqual(ok(await fixtureApi(f,'run',{programmeRef:coalitionP1Ref},p1Post)),handoff);
  const ownerAttempts=(await admin!.query("SELECT body FROM finnor_os.m3_events WHERE query_id=$1 AND body->>'phase' LIKE 'P1_OWNER_HANDOFF_%' ORDER BY created_at,id",
   [submitted.queryId])).rows;
  assert.equal(ownerAttempts.filter(event=>event.body.phase==='P1_OWNER_HANDOFF_STARTED').length,1);
  assert(ownerAttempts.some(event=>event.body.phase==='P1_OWNER_HANDOFF_FINISHED'&&event.body.originalBudgetReplenished===false));
  await artifact('r5-selected-p1-owner-handoff.json',{p1Module,handoff,ownerAttempts});
  const prefix='r5-p1:'+coalitionP1Ref.contentDigest;
  const allocationInput={selectionRef:selected.ref,idempotencyKey:prefix+':reservation'};
  const cleared=ok(await fixtureApi(f,'coalition-clear',allocationInput));
  coalitionAllocationRef=cleared.certificate.ref;
  assert.equal(cleared.certificate.schema,'finnor.s5.coalition-allocation-certificate.v1');
  assert.equal(cleared.certificate.check.objective,'9');assert.equal(cleared.reservation.status,'CONSUMPTION_PENDING');
  assert.deepEqual(cleared.certificate.ref,handoff.allocationRef);
  const replay=ok(await fixtureApi(f,'coalition-clear',allocationInput));assert.deepEqual(replay.reservation,cleared.reservation);
  const reservedReadback=ok(await fixtureApi(f,'coalition-read',{allocationRef:cleared.certificate.ref}));
  assert.deepEqual(reservedReadback.certificate,cleared.certificate);
  await artifact('r5-reservation-currentness-inputs.json',{issued:reservedReadback,
   actual:ok(await fixtureApi(f,'resources',{})),selection:selected});
  const sourceResponse=await fixtureApi(f,'coalition-read',{selectionRef:selected.ref},s4Post);
  if(sourceResponse.status!==200){
   const {readEnterpriseCoalitionSelection}=await import('../../packages/private-equity/src/enterprise-control');
   try{await readEnterpriseCoalitionSelection(f.ctx,selected.ref);}
   catch(error){await artifact('r5-own-currentness-error.json',{message:String(error),stack:(error as Error).stack});throw error;}
  }
  const sourceAfterReservation=ok(sourceResponse);
  assert.deepEqual(sourceAfterReservation,selected,'Verified own commitment invalidated its original S4 source');
  const consumeInput={allocationRef:cleared.certificate.ref,idempotencyKey:prefix+':consumption'};
  const consumed=ok(await fixtureApi(f,'coalition-consume',consumeInput));
  assert.equal(consumed.status,'INTENDED_PENDING_S6');assert.equal(consumed.effectRef,null);
  assert.deepEqual(consumed.envelope,point.envelopes);
  assert.deepEqual(ok(await fixtureApi(f,'coalition-consume',consumeInput)),consumed);
  const released=await fixtureApi(f,'coalition-release',{allocationRef:cleared.certificate.ref,idempotencyKey:'r5-blocked-release'});
  assert.equal(released.status,422);assert.equal(released.body.code,'BLOCKED_AUTHORITY');
  const held=ok(await fixtureApi(f,'coalition-read',{allocationRef:cleared.certificate.ref}));
  assert.equal(held.reservation.status,'CONSUMPTION_PENDING');assert.deepEqual(held.reservation.envelopes,point.envelopes);
  const scheduleInput={allocationRef:cleared.certificate.ref,consumptionRef:consumed.ref};
  const schedule=ok(await fixtureApi(f,'coalition-prepare',scheduleInput,s6Post));coalitionScheduleRef=schedule.ref;
  assert.deepEqual(schedule.ref,handoff.scheduleRef);
  assert.equal(schedule.schema,'finnor.s6.coalition-proposed-schedule.v1');
  assert.equal(schedule.status,'PROPOSED_UNADMITTED');assert.equal(schedule.executionAuthorityGranted,false);
  assert.equal(schedule.settlementEstablished,false);assert.equal(schedule.candidateDigest,programme.checker.candidateDigest);
  assert.deepEqual(schedule.payments.map((p:any)=>p.division),programme.candidate.division);
  assert(schedule.requiredConsents.every((c:any)=>c.status==='PROPOSED'&&c.acceptanceObserved===false));
  assert.deepEqual(ok(await fixtureApi(f,'coalition-prepare',scheduleInput,s6Post)),schedule);
  assert.deepEqual(ok(await fixtureApi(f,'coalition-read',{scheduleRef:schedule.ref},s6Post)),schedule);
  const reportInput={scheduleRef:schedule.ref,partyId:schedule.requiredConsents[0].partyId,proposalVersion:schedule.proposalVersion,
   reportedStatus:'NO_RESPONSE',idempotencyKey:'r5-no-response'};
  const report=ok(await fixtureApi(f,'coalition-consent',reportInput,s6Post));assert.equal(report.acceptanceObserved,false);
  assert.deepEqual(ok(await fixtureApi(f,'coalition-consent',reportInput,s6Post)),report);
  const forgedAcceptance=await fixtureApi(f,'coalition-consent',{...reportInput,reportedStatus:'REPORTED_ACCEPTED',idempotencyKey:'r5-no-evidence'},s6Post);
  assert.equal(forgedAcceptance.status,400);assert.equal(forgedAcceptance.body.code,'INVALID_REQUEST');
  const history=ok(await fixtureApi(f,'coalition-consent-history',{scheduleRef:schedule.ref},s6Post));
  assert.deepEqual(history,[report]);
  const configuredProfile=process.env.FINNOR_M3_PROFILE;
  let blockedReservation:any,blockedReport:any;
  try{
   process.env.FINNOR_M3_PROFILE='UNQUALIFIED';
   blockedReservation=await fixtureApi(f,'coalition-clear',allocationInput);
   blockedReport=await fixtureApi(f,'coalition-consent',{...reportInput,idempotencyKey:'r5-profile-blocked'},s6Post);
   assert.equal(blockedReservation.body.code,'BLOCKED_AUTHORITY');assert.equal(blockedReport.body.code,'BLOCKED_AUTHORITY');
   assert.deepEqual(ok(await fixtureApi(f,'coalition-consent-history',{scheduleRef:schedule.ref},s6Post)),history);
  }finally{process.env.FINNOR_M3_PROFILE=configuredProfile;}
  assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1',[f.tenant])).rows[0].n,0);
  await artifact('r5-proposed-s6-schedule.json',{schedule,report,history,forgedAcceptance,blockedReservation,blockedReport});
  const queryGrants=(await admin!.query("SELECT DISTINCT g.id,g.effect FROM finnor_os.role_authority_grants g JOIN finnor_os.employee_role_assignments a ON a.tenant_id=g.tenant_id AND a.role_id=g.role_id WHERE a.tenant_id=$1 AND a.employee_id=$2 AND a.active AND (g.capability='*' OR g.capability='query:*' OR g.capability='query:pe_world_state')",
   [f.tenant,f.principal])).rows;
  assert(queryGrants.length,'Actual participant query-grant fixture is absent');
  const responsibilityBefore=(await admin!.query("SELECT status,envelopes,revision FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2",
   [f.tenant,cleared.reservation.ref.id])).rows;
  let deniedS5:any,deniedS6:any,deniedP1:any;
  try{
   await admin!.query("UPDATE finnor_os.role_authority_grants SET effect='deny' WHERE tenant_id=$1 AND id=ANY($2::uuid[])",
    [f.tenant,queryGrants.map(grant=>grant.id)]);
   deniedS5=await fixtureApi(f,'coalition-read',{allocationRef:cleared.certificate.ref});
   deniedS6=await fixtureApi(f,'coalition-read',{scheduleRef:schedule.ref},s6Post);
   deniedP1=await fixtureApi(f,'read',{programmeRef:coalitionP1Ref},p1Post);
   await artifact('r5-rights-denial-responses.json',{queryGrants,deniedS5,deniedS6,deniedP1});
   assert.equal(deniedS5.status,404);assert.equal(deniedS6.status,404);
   assert([404,409].includes(deniedP1.status),JSON.stringify(deniedP1));
   assert.equal(deniedS5.body.problem,undefined);assert.equal(deniedS6.body.selectedProgrammes,undefined);
   assert.equal(deniedP1.body.module,undefined);
   const responsibilityAfter=(await admin!.query("SELECT status,envelopes,revision FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND reservation_id=$2",
    [f.tenant,cleared.reservation.ref.id])).rows;
   assert.deepEqual(responsibilityAfter,responsibilityBefore);
   await artifact('r5-rights-denied-retained-responsibility.json',{queryGrants,deniedS5,deniedS6,deniedP1,
    responsibilityBefore,responsibilityAfter,sourceRevisionRestored:false,executionAuthorityGranted:false});
  }finally{
   for(const grant of queryGrants)await admin!.query("UPDATE finnor_os.role_authority_grants SET effect=$3 WHERE tenant_id=$1 AND id=$2",
    [f.tenant,grant.id,grant.effect]);
  }
  const historical=ok(await api('capital-program-read',{queryId:acceptedQueryId}));
  assert.equal(historical.status,'INVALIDATED','Original search snapshot must retain the actual S5 dependency fence');
  await durable(acceptedQueryId);
  await artifact('r5-canonical-joint-reservation.json',{cleared,replay,reservedReadback,consumed,released,held,historical});
  return {submitted,programmeRef:programme.ref,qualification:'ACTUAL_AUTHENTICATED_DURABLE_NATIVE_COMPONENT_ONLY',missingOwners:programme.unresolvedClaims};
 });
 // Registered owner variants below: every Work, root, source and resource is an
 // actual disposable owner object. Fixture-only labels select authored inputs;
 // nothing here is a test-only production hook. Original grants stay 30s.
 if(lane==='coalition'){
  const coalitionTransport=(()=>{const {robust:_robust,coalition:_coalition,...transport}=request;return transport;})();
  // Each registered variant runs against its own actual disposable owner
  // fixture (fresh tenant/principal/model/mandate/policy), so a prior lane's
  // legitimate rights/source advances can never fence a later variant and the
  // variant's own commitments never weaken the primary lane's evidence.
  const variantFixture=async(label:string)=>{
   const tenant=randomUUID(),principal=randomUUID(),email='r5-variant-'+label+'@s5.example.test';
   await admin!.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,$3)",[tenant,randomUUID(),'R5 owner variant '+label]);
   await admin!.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[principal,tenant,email]);
   await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:principal,sourceSystem:'s5:e2e'});
   const bearer=await new SignJWT({email,role:'authenticated'}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setSubject(principal).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
   const saved=token;token=bearer;
   try{
    const fx=await support.fixture('r5-variant-'+label,2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200,resourceClass:'CASH'}],{identity:{tenant,principal}});
    const base=await support.policy(fx,'incumbent',{cash:25}),problem=structuredClone(base.problem);
    problem.observations=[{schema:'finnor.s2.control-observation.v1',id:'public-milestone',sourceRef:ref('registered-public-milestone','S2'),variableId:'outcome',unit:'normalized-value',delayPeriods:1,afterActionIds:['programme-incumbent'],bins:[{category:'LOW',lowerInclusive:-6,upperExclusive:.3},{category:'HIGH',lowerInclusive:.3,upperExclusive:6}],qualification:'SUPPLIED_DETERMINISTIC_COARSENING_UNVERIFIED'}];
    const replanned=ok(await fixtureApi(fx,'replan',{mandate:fx.mandate,problem,protocols:[],scenarios:{pathsPerMechanism:4,seed:20261002},priorPolicyRef:base.ref,reason:'Original owner milestone for bounded contingent commitments'},s4Post));
    assert.equal(replanned.status,'POLICY_AVAILABLE');fx.incumbent=replanned.policy;
    await support.resource(fx,'cash','USD','STOCK',['200','200','200'],undefined,[],{permittedRoots:fx.incumbent.bindings.beliefPins.map((pin:any)=>pin.root)});
    return {fx,bearer,transport:{...coalitionTransport,incumbentPolicyRef:fx.incumbent.ref}};
   }finally{token=saved;}
  };
  const buildCoalition=async(fx:any,label:string,parties:number,computeAvailability:string[],mutate?:(original:any)=>void)=>{
   const roots=[fx.root];
   for(let index=1;index<parties;index++){
    const org={entityType:'external_organization',entityId:randomUUID()};
    await admin!.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$3,'other')",
     [org.entityId,fx.tenant,'r5-party-'+org.entityId]);
    roots.push(org);
   }
   const permitted=[...roots];
   // Earlier challenges legitimately advance the owner's rights/source witness,
   // so every revision/creation here carries the actual current belief pin.
   const freshPins=[(await loadEnterpriseBeliefView(fx.ctx,{root:fx.root})).pin];
   for(const resource of ok(await fixtureApi(fx,'resources',{})).resources){
    const {ref:expectedRef,revision:_revision,priorRef:_prior,...body}=resource;
    const missing=roots.filter(root=>!body.permittedRoots.some((permitted:any)=>permitted.entityType===root.entityType&&permitted.entityId===root.entityId));
    if(missing.length)ok(await fixtureApi(fx,'resource',{resource:{...body,beliefPins:freshPins,permittedRoots:[...body.permittedRoots,...missing]},expectedRef}));
   }
   for(let index=1;index<parties;index++)
    await support.resource(fx,label+'-cash-'+index,'USD','STOCK',['200','200','200'],undefined,[],{
     legalEntityRef:ref(roots[index]!.entityId,'S1'),resourceClass:'CASH',permittedRoots:permitted,beliefPins:freshPins});
   await support.resource(fx,label+'-compute','native-attempt','CUMULATIVE_EXPENDITURE',computeAvailability,undefined,[],{
    resourceClass:'COMPUTE',permittedRoots:permitted,beliefPins:freshPins});
   const complete=ok(await fixtureApi(fx,'resources',{}));
   const cashes=roots.map((_root:any,index:number)=>complete.resources.find((r:any)=>
    index===0?r.resourceId==='cash':r.resourceId===label+'-cash-'+index));
   assert(cashes.every(Boolean),'Actual party funding resources missing from the complete current registry');
   const corpus=spawnSync(process.env.FINNOR_R2_PYTHON!,[ '-c',"import sys,json;sys.path.insert(0,sys.argv[1]);from corpus import joint;print(json.dumps(joint("+parties+")))",
    join(repo,'finnor-os/scripts/r5')],{encoding:'utf8'});assert.equal(corpus.status,0,corpus.stderr);
   const original=JSON.parse(corpus.stdout);
   original.model.ref=fx.model.ref;original.objective.mandateRef=fx.mandate.ref;original.unit=fx.mandate.utility.unit;
   original.dates=Array.from({length:3},(_,date)=>new Date(Date.parse(fx.mandate.horizon.startAt)+date*fx.mandate.horizon.periodMs).toISOString());
   original.valuationDate=original.dates[0];original.discountFactors=['1','1','1'];
   original.resources=complete.resources.map((r:any)=>({id:r.resourceId,sourceRef:r.ref,unit:r.unit,kind:'CUMULATIVE_EXPENDITURE',
    available:Object.fromEntries(original.worlds.map((w:any)=>[w.id,r.availability.map((a:any)=>a.amount)]))}));
   original.parties.forEach((party:any,index:number)=>{
    party.partyRef=ref('canonical:external_organization:'+roots[index]!.entityId,'S1');
    party.fundingRef=cashes[index].ref;
    party.settledCash=Object.fromEntries(original.worlds.map((w:any)=>[w.id,['200','200','200']]));
   });
   const computeId=label+'-compute';
   original.grammar.operators.forEach((operator:any)=>{
    operator.modelRef=fx.model.ref;
    operator.grantChoices=operator.grantChoices.map((grant:any)=>{
     const carried=grant.compute??['0','0'];delete grant.compute;
     return Object.fromEntries(complete.resources.map((r:any)=>[r.resourceId,[...(r.resourceId===computeId?carried:(grant[r.resourceId]??['0','0'])),'0']]));
    });
   });
   // The corpus names its expenditure resource 'compute'; every GRANT feature inside the
   // family/budget terms must be rebound to this fixture's actual resource id alongside
   // the grantChoice key remap above, or the packaged child rejects ORIGINAL_GRANT_BINDING.
   const remapGrantFeature=(node:unknown):void=>{if(Array.isArray(node)){node.forEach(remapGrantFeature);return;}if(node&&typeof node==='object'){const record=node as Record<string,unknown>;if(record.kind==='GRANT'&&record.resourceId==='compute')record.resourceId=computeId;for(const value of Object.values(record))remapGrantFeature(value);}};
   remapGrantFeature(original);
   if(mutate)mutate(original);
   // Human demand keys must name the FINAL operator set (a variant may rename/add
   // operators): parseCoalitionProblem requires ORIGINAL_COMPLETE_HUMAN_DEMAND.
   original.controlDemand={schema:'finnor.r5.control-demand.v1',
    dimensions:fx.mandate.resources.dimensions.map((dimension:any)=>({dimensionId:dimension.id,totalResourceId:dimension.id,occupancyResourceId:null})),
    humanSecondsByOperator:Object.fromEntries(original.grammar.operators.map((operator:any)=>[operator.id,'0'])),
    staffing:'NO_EXISTING_EMPLOYMENT_OR_BENEFIT_CHANGE',terminalLiabilityResourceId:null};
   original.canonicalAllocation={schema:'finnor.r5.canonical-allocation-basis.v1',mandate:fx.mandate,
    resources:complete.resources,outstanding:complete.outstanding,
    snapshotDigest:complete.snapshotDigest,knowledgeAt:new Date().toISOString()};
   return {original,roots,complete};
  };
  const submitCoalition=async(fx:any,transport:any,label:string,built:{original:any},workId:string)=>{
   const original=structuredClone(built.original);
   const workInput=(await admin!.query('SELECT id FROM finnor_os.work_inputs WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[fx.tenant,workId])).rows[0];
   original.owner={...original.owner,tenantId:fx.tenant,principalId:fx.principal,workId,workRevision:workInput.id,
    originalEpisodeId:'supplied-original-'+workId,originalBudgetGrantRef:ref('supplied-capped-native-descriptor-'+workId,'BUSINESS_OWNER'),
    originalDeadline:new Date(Date.now()+600000).toISOString(),dependencies:[]};
   const sourceId=(await createEvidenceSource(fx.tenant,{sourceKey:'r5-original-'+randomUUID(),sourceType:'pe_document_claim',title:'R5 supplied exact joint coalition programme'})).id;
   const versionId=randomUUID(),bytes=JSON.stringify(original),contentDigest=sha(bytes);
   await admin!.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at) VALUES($1,$2,'tenant',$3,1,$4,$5,$6::jsonb,clock_timestamp(),clock_timestamp(),clock_timestamp())",
    [versionId,sourceId,fx.tenant,contentDigest,bytes,JSON.stringify({worldRoot:fx.root,claims:[{predicate:'reported',value:'Supplied unadmitted mathematical model; no consent/effect/admission claim'}]})]);
   const submitted=ok(await api('capital-program-submit',{...transport,workId,idempotencyKey:label+':'+randomUUID(),
    coalition:{schema:'finnor.r5.owner-request.v1',source:{sourceId,versionId,contentDigest}}}),202);
   const value=await drain(submitted.queryId),programme=value.program?.coalitionProgramme;
   assert(programme,JSON.stringify(value));
   assert.equal(value.status,'PARTIAL');assert.equal(programme.status,'INCOMPLETE');
   assert.equal(programme.executionAuthorityGranted,false);
   return {submitted,value,programme,original};
  };
  await challenge('authenticated-coalition-owner-thirds-division',async()=>{
   const env=await variantFixture('thirds'),fx=env.fx,saved=token;token=env.bearer;
   try{
   const built=await buildCoalition(fx,'thirds',2,['4','4','4'],(original:any)=>{
    original.transfers[0].bounds={'party-0':['1/3','1/3'],'party-1':['-1/3','-1/3']};
   });
   const workId=(await receiveWork({tenantId:fx.tenant,userId:fx.principal,instruction:'R5 owner-authored fixed signed thirds division',channel:'console',idempotencyKey:randomUUID()})).workId;
   const {submitted,programme}=await submitCoalition(fx,env.transport,'r5-thirds',built,workId);
   assert.equal(programme.lower,'9');assert.equal(programme.upper,'9');
   assert.deepEqual(programme.candidate.division[0].amounts,{'party-0':'1/3','party-1':'-1/3'});
   const handoff=ok(await fixtureApi(fx,'run',{programmeRef:programme.owners.p1ProgrammeRef},p1Post));
   assert.equal(handoff.stage,'STOP_UNADMITTED_EFFECT');assert.equal(handoff.settlementEstablished,false);
   const schedule=ok(await fixtureApi(fx,'coalition-read',{scheduleRef:handoff.scheduleRef},s6Post));
   const legs=JSON.stringify(schedule.payments);
   assert(legs.includes('"1/3"')&&legs.includes('"-1/3"'),'Original nonterminating division was not retained exactly in the S6 legs');
   assert(!legs.includes('0.333'),'Decimal approximation of the original division leaked into the S6 legs');
   const held=ok(await fixtureApi(fx,'coalition-read',{allocationRef:handoff.allocationRef}));
   assert.equal(held.reservation.status,'CONSUMPTION_PENDING');
   const envelope=JSON.stringify(held.reservation.envelopes);
   assert(!envelope.includes('0.333'),'Decimal approximation leaked into the retained S5 envelope');
   const consumption=(await admin!.query("SELECT body FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND reservation_id=$2",[fx.tenant,held.reservation.ref.id])).rows[0].body;
   assert.equal(consumption.status,'INTENDED_PENDING_S6');assert.equal(consumption.effectRef,null);
   await artifact('r5-owner-thirds-division.json',{submitted,programme,handoff,schedule,held,consumption});
   return {programmeRef:programme.ref,division:programme.candidate.division[0].amounts,qualification:'ACTUAL_OWNER_EXACT_RATIONAL_DIVISION_ONLY'};
   }finally{token=saved;}
  });
  await challenge('authenticated-coalition-four-party-two-branch',async()=>{
   const env=await variantFixture('quad'),fx=env.fx,saved=token;token=env.bearer;
   try{
   const built=await buildCoalition(fx,'quad',4,['4','4','4'],(original:any)=>{
    const pairA=original.grammar.operators[1];
    pairA.id='joint-pair-a';pairA.eligibleParties=['party-0','party-1'];pairA.requiredParties=[...pairA.eligibleParties];
    const pairB=structuredClone(pairA);
    pairB.id='joint-pair-b';pairB.eligibleParties=['party-2','party-3'];pairB.requiredParties=[...pairB.eligibleParties];
    original.grammar.operators.push(pairB);
   });
   const workId=(await receiveWork({tenantId:fx.tenant,userId:fx.principal,instruction:'R5 four-party two eligible joint branches',channel:'console',idempotencyKey:randomUUID()})).workId;
   const {submitted,programme}=await submitCoalition(fx,env.transport,'r5-quad',built,workId);
   assert.equal(programme.lower,'18');assert.equal(programme.upper,'18');
   assert.equal(programme.candidate.selectedOptionIds.length,2);
   const handoff=ok(await fixtureApi(fx,'run',{programmeRef:programme.owners.p1ProgrammeRef},p1Post));
   assert.equal(handoff.stage,'STOP_UNADMITTED_EFFECT');
   const held=ok(await fixtureApi(fx,'coalition-read',{allocationRef:handoff.allocationRef}));
   assert.equal(held.reservation.status,'CONSUMPTION_PENDING');
   assert(held.reservation.envelopes.some((e:any)=>e.resourceId==='quad-compute'&&e.quantities.some((q:string)=>q!=='0')),
    'Actual joint reservation omitted the shared compute envelope');
   const reservations=(await admin!.query("SELECT reservation_id,status FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND allocation_digest=$2",[fx.tenant,handoff.allocationRef.contentDigest])).rows;
   assert.equal(reservations.length,1,'Joint programme must hold exactly one actual coherent S5 reservation');
   const schedule=ok(await fixtureApi(fx,'coalition-read',{scheduleRef:handoff.scheduleRef},s6Post));
   assert.equal(schedule.requiredConsents.length,4);
   assert(schedule.requiredConsents.every((c:any)=>c.status==='PROPOSED'&&c.acceptanceObserved===false));
   await artifact('r5-four-party-two-branch.json',{submitted,programme,handoff,held,reservations,schedule});
   return {programmeRef:programme.ref,selected:programme.candidate.selectedOptionIds.length,qualification:'ACTUAL_FOUR_PARTY_TWO_BRANCH_RESERVATION_ONLY'};
   }finally{token=saved;}
  });
  await challenge('authenticated-coalition-competing-works-currentness',async()=>{
   const env=await variantFixture('contention'),fx=env.fx,saved=token;token=env.bearer;
   try{
   const built=await buildCoalition(fx,'contention',2,['1','1','1']);
   const workA=(await receiveWork({tenantId:fx.tenant,userId:fx.principal,instruction:'R5 competing Work A on one shared compute snapshot',channel:'console',idempotencyKey:randomUUID()})).workId;
   const workB=(await receiveWork({tenantId:fx.tenant,userId:fx.principal,instruction:'R5 competing Work B on one shared compute snapshot',channel:'console',idempotencyKey:randomUUID()})).workId;
   const a=await submitCoalition(fx,env.transport,'r5-contention-a',built,workA);
   const b=await submitCoalition(fx,env.transport,'r5-contention-b',built,workB);
   assert.equal(a.programme.lower,'9');assert.equal(b.programme.lower,'9');
   const selectionA=ok(await fixtureApi(fx,'coalition-read',{selectionRef:a.programme.owners.s4SelectionRef},s4Post));
   const selectionB=ok(await fixtureApi(fx,'coalition-read',{selectionRef:b.programme.owners.s4SelectionRef},s4Post));
   assert.equal(selectionA.resourceSnapshotDigest,selectionB.resourceSnapshotDigest,
    'Both Works must reach actual checked publication on the same complete S5 snapshot');
   const snapshotBefore=(await admin!.query("SELECT count(*)::int n FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND envelopes::text LIKE '%contention-compute%'",[fx.tenant])).rows[0].n;
   assert.equal(snapshotBefore,0,'Contention compute must be untouched before either handoff');
   const handoffA=ok(await fixtureApi(fx,'run',{programmeRef:a.programme.owners.p1ProgrammeRef},p1Post));
   assert.equal(handoffA.stage,'STOP_UNADMITTED_EFFECT');
   const refused=await fixtureApi(fx,'run',{programmeRef:b.programme.owners.p1ProgrammeRef},p1Post);
   assert.equal(refused.status,409,JSON.stringify(refused));
   assert.equal(refused.body.code,'STALE_INPUT','Competing Work must refuse stale original S5 currentness');
   const bAttempts=(await admin!.query("SELECT count(*)::int n FROM finnor_os.m3_events WHERE query_id=$1 AND body->>'phase' LIKE 'P1_OWNER_HANDOFF_%'",[b.submitted.queryId])).rows[0].n;
   assert.equal(bAttempts,0,'Refused stale Work must not start a P1 owner attempt');
   const bCertificates=(await admin!.query("SELECT count(*)::int n FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND certificate->'selectionRef'->>'contentDigest'=$2",[fx.tenant,selectionB.ref.contentDigest])).rows[0].n;
   assert.equal(bCertificates,0,'Refused Work must not hold any S5 certificate or reservation');
   const bConsumptions=(await admin!.query("SELECT count(*)::int n FROM finnor_os.s5_consumptions WHERE tenant_id=$1 AND policy_id=$2",[fx.tenant,selectionB.ref.id])).rows[0].n;
   assert.equal(bConsumptions,0,'Refused Work must not record any consumption');
   const heldContention=(await admin!.query("SELECT reservation_id,status,envelopes FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND envelopes::text LIKE '%contention-compute%'",[fx.tenant])).rows;
   assert.equal(heldContention.length,1,'Exactly one actual held envelope may survive the competition');
   assert.equal(heldContention[0].status,'CONSUMPTION_PENDING');
   assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.business_effects WHERE tenant_id=$1',[fx.tenant])).rows[0].n,0);
   const historicalB=ok(await api('capital-program-read',{queryId:b.submitted.queryId}));
   assert.equal(historicalB.status,'INVALIDATED','Competing original search snapshot must retain the actual S5 dependency fence');
   await durable(b.submitted.queryId);
   await artifact('r5-competing-works-currentness.json',{a:{submitted:a.submitted,programmeRef:a.programme.ref},b:{submitted:b.submitted,programmeRef:b.programme.ref},
    selectionA,selectionB,handoffA,refused,bAttempts,bCertificates,bConsumptions,heldContention,historicalB});
   return {winnerProgrammeRef:a.programme.ref,refusedProgrammeRef:b.programme.ref,refusal:refused.body.code,qualification:'ACTUAL_COMPETING_WORK_STALE_CURRENTNESS_REFUSAL_ONLY'};
   }finally{token=saved;}
  });
 }
 if(lane!=='coalition')await challenge('authenticated-contingent-owner',async()=>{await prepareTick();const submitted=ok(await api('capital-program-submit',request),202);acceptedQueryId=submitted.queryId;
  const application=(await getPool().query("SELECT current_user,rolsuper,rolbypassrls,pg_has_role(current_user,'finnor_worker','MEMBER') AS worker_member FROM pg_roles WHERE rolname=current_user")).rows[0],unscopedJobs=(await getPool().query("SELECT id FROM finnor_os.jobs WHERE payload->>'queryId'=$1",[acceptedQueryId])).rows;
  await artifact('database-role-boundary.json',{application,unscopedJobs});assert.equal(application.current_user,'finnor_app');assert.equal(application.worker_member,false);assert.equal(unscopedJobs.length,0);
  const value=await drain(submitted.queryId);assert(value.program,JSON.stringify(value));const c=value.program.jointSearchCertificate;assert(c,JSON.stringify(c));assert.equal(c.status,'COMPLETE',JSON.stringify(c.unresolvedClaims));assert.equal(c.lower,'100');assert.equal(c.upper,'100');assert.equal(c.incumbent.variant.structure,'OBSERVABLE_STAGE');assert(c.iterations.length>=2);assert.equal(c.iterations[0].upper,'210');assert(c.consumer.s5?.current&&c.consumer.s5.feasible);assert.equal(c.exactOptimalityClaimed,true);assert.equal(c.consumer.executionAuthorityGranted,false);await artifact('positive-program.json',value);
  const input={queryId:submitted.queryId,candidateDigest:value.program.candidates[0].semanticDigest,idempotencyKey:'r2-exact-branch',intent:'MODEL_BRANCH_REVIEW'},review=ok(await api('capital-program-select',input));assert.equal(review.review.choice.status,'POLICY_AVAILABLE');assert.equal(review.review.choice.actionId,'programme-incumbent');assert.equal(review.review.reservationCreated,false);const replay=ok(await api('capital-program-select',input));assert.equal(replay.replayed,true);const readback=ok(await api('capital-program-read',{queryId:submitted.queryId}));assert.equal(readback.exactBranchReviews.length,1);await artifact('branch-review.json',{review,replay,readback});return {submitted,certificateRef:c.ref,policyRef:c.incumbent.ref,resourceRef:c.consumer.s5.ref,review:review.review.ref};});
 await challenge('authentication-and-private-scope',async()=>{
  assert(acceptedQueryId,'Accepted query prerequisite missing');const invalid=await api('capital-program-submit',request,'invalid');assert.equal(invalid.status,401);
  const observed=[];
  for(const {scope,id,tenant,email:identityEmail} of privateIdentities){
   const stranger=await new SignJWT({email:identityEmail,role:'authenticated'}).setProtectedHeader({alg:'RS256',kid:jwk.kid}).setSubject(id).setIssuedAt().setExpirationTime('1h').sign(keys.privateKey),
    read=await api('capital-program-read',{queryId:acceptedQueryId},stranger),submit=await api('capital-program-submit',{...request,idempotencyKey:scope},stranger);
   if(lane==='coalition'){
    const response=await fetch(upstream+'/api/policies/coalition-read',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+stranger},
     body:JSON.stringify({selectionRef:coalitionSelectionRef})});
    assert.equal(response.status,404,'Foreign principal/tenant could read actual S4 coalition preimage');
    const allocationResponse=await fetch(upstream+'/api/allocations/coalition-read',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+stranger},
     body:JSON.stringify({allocationRef:coalitionAllocationRef})});
    assert.equal(allocationResponse.status,404,'Foreign principal/tenant could read the actual S5 joint commitment');
    const scheduleResponse=await fetch(upstream+'/api/obligations/coalition-read',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+stranger},
     body:JSON.stringify({scheduleRef:coalitionScheduleRef})});
    assert.equal(scheduleResponse.status,404,'Foreign principal/tenant could read the actual S6 proposed terms');
    const programmeResponse=await fetch(upstream+'/api/coalition-programmes/read',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+stranger},
     body:JSON.stringify({programmeRef:coalitionP1Ref})});
    assert.equal(programmeResponse.status,404,'Foreign principal/tenant could read the actual selected P1 programme');
   }
   observed.push({scope,id,tenant,read,submit});await artifact('authentication.json',{invalid,observed});
   assert([401,403,404].includes(read.status),JSON.stringify(read));assert([401,403,404].includes(submit.status),JSON.stringify(submit));
  }return {invalid,observed};
 });
 if(lane==='diagnostic'&&cases[0].status==='PASS')await challenge('matched-owner-resolved-off-on',async()=>{
  const on=JSON.parse(await readFile(join(out,'positive-program.json'),'utf8')),onCertificate=on.program.jointSearchCertificate;
  await prepareTick();const submitted=ok(await api('capital-program-submit',{...request,idempotencyKey:'matched-all-worlds',robust:{...request.robust,initialWorlds:source.worlds.map(w=>w.id)}}),202),off=await drain(submitted.queryId),offCertificate=off.program.jointSearchCertificate;
  const domain=(c:any)=>{const o=c.incumbent.original;return {mandate:o.mandate,problem:o.problem,source:o.source,modelRequest:o.modelRequest,modelHistory:o.modelHistory,permitted:o.permitted,resources:o.resources,protocols:o.protocols,resourceScopeRoots:o.resourceScopeRoots,ownerVector:o.owner.ownerVector,dependencies:o.owner.dependencies,workId:o.owner.workId,inputDigest:o.owner.inputDigest};};
  assert.deepEqual(domain(onCertificate),domain(offCertificate),'Matched owner domain or permitted information changed');assert.deepEqual(onCertificate.envelope.budget,offCertificate.envelope.budget);
  assert.equal(offCertificate.status,'COMPLETE');assert.equal(offCertificate.lower,'100');assert.equal(offCertificate.upper,'100');assert.equal(offCertificate.consumer.s5.feasible,true);
  assert.deepEqual(onCertificate.incumbent.worldCourses,offCertificate.incumbent.worldCourses);assert(off.program.programModule&&off.program.ownerBoundGraph);
  const jobs=(await admin!.query("SELECT payload->>'queryId' AS query_id,accepted_at,started_at,completed_at,attempts,status FROM finnor_os.jobs WHERE payload->>'queryId'=ANY($1::text[])",[[acceptedQueryId,submitted.queryId]])).rows;
  const result={on,off,jobs,domainDigest:hash(domain(onCertificate)),totalGrantIdentical:true,noQualityGain:true,allConstructionSolveProofCheckSeparationLiftStorageCostsRetained:true,preparationScope:'Actual shared owner setup and separately recorded warmed worker startup',money:null,moneyStatus:'UNMETERED',protectedGain:'NOT_RUN',adapterGainNotCredited:true};
  await artifact('matched-diagnostic.json',result);return result;
 });
 if(lane==='responsibility'&&cases[0].status==='PASS'){
  await challenge('method-replacement-during-check-and-restart',async()=>{
   const path=join(repo,'finnor-os/packages/epistemic-runtime/src/r2-encoding.ts'),originalBytes=await readFile(path),observed=[];
   for(const mode of ['during-check','fresh-worker']){
    const admitted=await newQuery('method-replacement-'+mode),before=(await admin!.query('SELECT deadline_at,acceptance FROM finnor_os.m3_queries WHERE id=$1',[admitted.queryId])).rows[0];
    let child:Awaited<ReturnType<typeof nativeChild>>|null=null,running:ReturnType<typeof tick>|null=null;
    try{
     if(mode==='during-check'){running=tick();child=await nativeChild(admitted.queryId,'check-policy');}
     else{const prepared=preparedWorker!;preparedWorker=undefined;prepared.child.kill('SIGTERM');await prepared.exit;}
     const changedBytes=Buffer.concat([originalBytes,Buffer.from('\n// Disposable method identity revision '+randomUUID()+'\n')]);
     await artifact('method-replacement/'+mode+'-source.json',{path,originalSha256:sha(originalBytes),replacementSha256:sha(changedBytes),originalCode:before.acceptance.code.digest});
     await writeFile(path,changedBytes);
     if(child)process.kill(child.pid,'SIGCONT');
     await(running??tick());if(child)assert(await exited(child.pid));
     const row=(await admin!.query('SELECT status,deadline_at,result_digest,failure FROM finnor_os.m3_queries WHERE id=$1',[admitted.queryId])).rows[0],
      publications=(await admin!.query('SELECT * FROM finnor_os.m3_publications WHERE query_id=$1',[admitted.queryId])).rows,
      physical=(await admin!.query("SELECT body FROM finnor_os.m3_events WHERE query_id=$1 AND kind='R2_PHYSICAL_CHILD'",[admitted.queryId])).rows;
     assert(['INVALIDATED','FAILED'].includes(row.status),JSON.stringify(row));assert.equal(row.result_digest,null);assert.equal(publications.length,0);
     assert.equal(row.deadline_at.toISOString(),before.deadline_at.toISOString());
     if(mode==='during-check')assert(physical.some(v=>v.body.phase==='check-proof'&&v.body.state==='EXITED'));
     else assert.equal(physical.length,0);
     await durable(admitted.queryId);observed.push({mode,admitted,child,row,publications,nativeEvents:physical.length,originalDeadlineRetained:true,newGrant:false});
    }finally{
     await writeFile(path,originalBytes);
     if(child){try{process.kill(child.pid,'SIGCONT');}catch{}}
     if(running)await running;
    }
    const read=ok(await api('capital-program-read',{queryId:admitted.queryId}));assert.equal(read.program,null);
   }
   assert.equal(sha(await readFile(path)),sha(originalBytes));return observed;
  });
  await challenge('ordinary-producer-false-certificate-claims',async()=>{
   const published=JSON.parse(await readFile(join(out,'positive-program.json'),'utf8')),observed=[];
   for(const mode of ['false-zero-gap','false-infeasible','checker-receipt-identity']){
    const program=structuredClone(published.program),c=program.jointSearchCertificate;
    if(mode==='false-zero-gap'){
     const removed=c.proofs.pop();c.checks=c.checks.filter((r:any)=>r.ref.contentDigest!==removed.checkerReceipt.ref.contentDigest);c.upper='210';
    }else if(mode==='false-infeasible'){
     const p=c.proofs[0];c.status='INFEASIBLE';c.infeasibilityProof={restrictedWorlds:p.restrictedWorlds,artifactRef:p.artifactRef,proofRef:p.proofRef,viprRef:p.viprReceipt,checkerReceipt:p.checkerReceipt};c.exactOptimalityClaimed=false;
    }else c.checks[0].provenance.checkerIdentity[0].sha256='0'.repeat(64);
    const {ref:_certificate,...certificateBody}=c;c.ref=r2Ref('joint-search-certificate',certificateBody);await writeM3Record(f.ctx,'graphs',m3Ref('r2-certificate',c),c);
    const {ref:_program,...programBody}=program;program.ref=m3Ref('capital-program',programBody);await writeM3Record(f.ctx,'programs',program.ref,programBody);
    const queryId=randomUUID();
    // Disposable SQL fault injection models an ordinary producer publishing a
    // bad claim around real accepted receipts. Original rows remain immutable;
    // no native grant, checker receipt, authority or effect is fabricated.
    await admin!.query(`INSERT INTO finnor_os.m3_queries(id,tenant_id,principal_id,work_id,work_input_id,work_input_digest,plan_id,plan_digest,idempotency_key,request_digest,request,acceptance,status,generation,result_digest,deadline_at)
     SELECT $2,tenant_id,principal_id,work_id,work_input_id,work_input_digest,plan_id,plan_digest,$3,request_digest,request,acceptance,'PARTIAL',generation,$4,deadline_at FROM finnor_os.m3_queries WHERE id=$1`,[acceptedQueryId,queryId,mode,program.ref.contentDigest]);
    await admin!.query('INSERT INTO finnor_os.m3_publications(tenant_id,principal_id,query_id,generation,result_digest) VALUES($1,$2,$3,1,$4)',[f.tenant,f.principal,queryId,program.ref.contentDigest]);
    const result=await api('capital-program-read',{queryId});assert.equal(result.status,422);assert(JSON.stringify(result).includes('R2_CERTIFICATE_CLAIM_MISMATCH'),JSON.stringify(result));await durable(queryId);observed.push({mode,queryId,result,originalAcceptedReceipts:true,newGrant:false});
   }return observed;
  });
  await challenge('scientific-runtime-currentness-during-check',async()=>{
   const runtime=process.env.FINNOR_R2_RUNTIME!,observed=[],scientificIndex=process.argv.indexOf('--scientific-only'),
    modes=scientificIndex<0?['solver-binary','unsafe-cut-configuration','checker-source']:[process.argv[scientificIndex+1]];
   assert(modes.every(mode=>['solver-binary','unsafe-cut-configuration','checker-source'].includes(mode!)),'Unknown scientific identity probe');
   for(const mode of modes){
    const path=mode==='solver-binary'?join(runtime,'bin/scip'):mode==='unsafe-cut-configuration'?join(runtime,'manifest.json'):join(repo,'finnor-os/packages/epistemic-runtime/python/r2_check.py'),
     originalBytes=await readFile(path),admitted=await newQuery('scientific-identity-'+mode),before=(await admin!.query('SELECT tenant_id,principal_id,acceptance,deadline_at FROM finnor_os.m3_queries WHERE id=$1',[admitted.queryId])).rows[0],
     running=tick(),child=await nativeChild(admitted.queryId,'check-policy');
    try{
     const accepted=[],graphDir=join(process.env.FINNOR_M3_STORE!,before.tenant_id,before.principal_id,'graphs');
     for(const name of await readdir(graphDir)){
      if(!name.endsWith('.json'))continue;const record=JSON.parse(await readFile(join(graphDir,name),'utf8'));
      if(record.body?.schema==='finnor.r2.original-proof-artifact.v1'&&record.body.encoding.originalDigest===m3Hash(before.acceptance.r2.original)&&['210','100'].includes(record.body.checkerReceipt.upper))
       accepted.push({ref:record.ref,body:(await readM3Record<any>(f.ctx,'graphs',record.ref)).body});
     }
     const proofChecks=(await admin!.query("SELECT body FROM finnor_os.m3_events WHERE query_id=$1 AND kind='R2_PHYSICAL_CHILD' AND body->>'phase'='check-proof' AND body->>'state'='EXITED'",[admitted.queryId])).rows;
     assert(accepted.length&&proofChecks.some(v=>v.body.receipt.exitCode===0),'Genuine original accepted upper proof prerequisite missing');
     let changedBytes:Buffer;
     if(mode==='unsafe-cut-configuration'){const manifest=JSON.parse(originalBytes.toString());manifest.configuration.cuts=true;changedBytes=Buffer.from(JSON.stringify(manifest));}
     else changedBytes=Buffer.concat([originalBytes,Buffer.from(mode==='checker-source'?'\n# Disposable original checker identity revision\n':'\n')]);
     await artifact('scientific-identity/'+mode+'.json',{mode,path,originalSha256:sha(originalBytes),replacementSha256:sha(changedBytes),originalGrantRenewed:false});
     await writeFile(path,changedBytes);try{process.kill(child.pid,'SIGCONT');}catch{}await running;assert(await exited(child.pid));await durable(admitted.queryId);
     const row=(await admin!.query('SELECT status,deadline_at,result_digest,failure FROM finnor_os.m3_queries WHERE id=$1',[admitted.queryId])).rows[0],
      publications=(await admin!.query('SELECT * FROM finnor_os.m3_publications WHERE query_id=$1',[admitted.queryId])).rows;
     assert.equal(row.result_digest,null);assert.equal(publications.length,0);assert.equal(row.deadline_at.toISOString(),before.deadline_at.toISOString());
     observed.push({mode,admitted,child,row,publications,accepted,proofChecks});
    }finally{await writeFile(path,originalBytes);try{process.kill(child.pid,'SIGCONT');}catch{}await running;}
    assert.equal(sha(await readFile(path)),sha(originalBytes));const current=ok(await api('capital-program-read',{queryId:admitted.queryId}));assert.equal(current.program,null);
   }return observed;
  });
  await challenge('live-work-input-and-principal-fences',async()=>{
   const published=JSON.parse(await readFile(join(out,'positive-program.json'),'utf8')),
    graph=(await readM3Record<any>(f.ctx,'graphs',published.program.ownerBoundGraph)).body,observed=[];
   assert.deepEqual(graph.closureBasis.affectedRegions,['original-domain','bound-and-worlds','original-policy','canonical-demand','executable-module']);
   assert.deepEqual(graph.closureBasis.keptRegions,[]);await artifact('p7-r2-owner-closure.json',graph);
   for(const mode of ['new-work-input','principal-suspended']){
    const admitted=await newQuery('live-fence-'+mode),before=(await admin!.query('SELECT work_id,work_input_id,deadline_at FROM finnor_os.m3_queries WHERE id=$1',[admitted.queryId])).rows[0],
     running=tick(),child=await nativeChild(admitted.queryId,'check-policy');let revision:unknown;
    try{
     if(mode==='new-work-input')revision=await receiveWork({tenantId:f.tenant,userId:f.principal,workId:before.work_id,instruction:'Actual revised R2 Work input',channel:'console',idempotencyKey:randomUUID()});
     else await admin!.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1 AND tenant_id=$2",[f.principal,f.tenant]);
     try{process.kill(child.pid,'SIGCONT');}catch{}
     await running;assert(await exited(child.pid));await durable(admitted.queryId);
     const row=(await admin!.query('SELECT status,deadline_at,result_digest,failure FROM finnor_os.m3_queries WHERE id=$1',[admitted.queryId])).rows[0],
      publications=(await admin!.query('SELECT * FROM finnor_os.m3_publications WHERE query_id=$1',[admitted.queryId])).rows;
     assert.equal(row.result_digest,null);assert.equal(publications.length,0);assert.equal(row.deadline_at.toISOString(),before.deadline_at.toISOString());
     observed.push({mode,admitted,before,child,revision,row,publications,originalDeadlineRetained:true,newGrant:false});
    }finally{
     if(mode==='principal-suspended')await admin!.query("UPDATE finnor_os.users SET status='active' WHERE id=$1 AND tenant_id=$2",[f.principal,f.tenant]);
     try{process.kill(child.pid,'SIGCONT');}catch{}await running;
    }
    const current=ok(await api('capital-program-read',{queryId:admitted.queryId}));assert.equal(current.program,null);assert(!['COMPLETE','PARTIAL'].includes(current.status));await durable(admitted.queryId);
   }return {graph,observed,independentNewP7Executor:'NOT_REQUESTED_OR_RUN',continuationAuthority:'EXISTING_LINKED_M3_ONLY'};
  });
  await challenge('original-budget-with-and-without-incumbent',async()=>{
   const observed=[];
   for(const calls of [1,7]){
    await prepareTick();const workId=(await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'Original bounded R2 child grant '+calls,channel:'console',idempotencyKey:randomUUID()})).workId,
     submitted=ok(await api('capital-program-submit',{...request,workId,idempotencyKey:'native-calls-'+calls,robust:{...request.robust,budget:{...request.robust.budget,maxNativeCalls:calls}}}),202),value=await drain(submitted.queryId),c=value.program.jointSearchCertificate;
    assert.equal(c.status,'INCOMPLETE');assert.equal(c.exactOptimalityClaimed,false);assert.equal(c.fallback.status,'NO_COMPATIBLE_ADMITTED_FALLBACK');assert.equal(c.costs.nativeCalls,calls);
    if(calls===1)assert.equal(c.lower,null);else{assert(['50','100'].includes(c.lower));assert.equal(c.incumbent.worldCourses.find((w:any)=>w.worldId==='C').utility,'210');assert(['50','100'].includes(c.incumbent.worldCourses.find((w:any)=>w.worldId==='A').utility));}
    assert.equal(c.upper,calls===1?null:'210');assert.equal(c.consumer.s5,null);
    const rows=(await admin!.query("SELECT body FROM finnor_os.m3_events WHERE query_id=$1 AND kind='R2_PHYSICAL_CHILD' AND body->>'state'='EXITED'",[submitted.queryId])).rows;
    assert(rows.every(row=>row.body.receipt.aggregatePeakMemoryBytes<=request.robust.budget.memoryMiB*1048576));observed.push({calls,submitted,value,physicalMemoryAccounting:rows.map(row=>row.body.receipt.memoryAccountingScope)});
   }return observed;
  });
  await challenge('standing-and-original-recompile-budget',async()=>{
   const missing=await api('capital-program-submit',{...request,idempotencyKey:'missing-acceptance',permitted:{...request.permitted,agreement:'COUNTERPARTY_REQUIRED'}});
   assert.equal(missing.status,409);assert(JSON.stringify(missing).includes('ACCEPTANCE_PRIMITIVE_UNAVAILABLE'));
   const before=(await admin!.query('SELECT count(*)::int n FROM finnor_os.m3_queries WHERE tenant_id=$1',[f.tenant])).rows[0].n,
    original=(await admin!.query('SELECT deadline_at FROM finnor_os.m3_queries WHERE id=$1',[acceptedQueryId])).rows[0].deadline_at;
   // Wait only for the actual admitted deadline, then exercise a changed grammar.
   await new Promise(yes=>setTimeout(yes,Math.max(0,original.getTime()-Date.now()+25)));
   const idempotencyKey='spent-recompile',replacement={...request,idempotencyKey,permitted:{...request.permitted,terms:['0.15','0.3']}},
    recompile=await api('capital-program-recompile',{queryId:acceptedQueryId,idempotencyKey,replacement});
   assert.equal(recompile.status,413);assert(JSON.stringify(recompile).includes('deadline exhausted'));
   assert.equal((await admin!.query('SELECT count(*)::int n FROM finnor_os.m3_queries WHERE tenant_id=$1',[f.tenant])).rows[0].n,before);
   return {missing,recompile,originalDeadline:original.toISOString(),newGrant:false};
  });
  await challenge('duplicate-and-stale-delivery',async()=>{
   const before=(await admin!.query("SELECT count(*)::int n FROM finnor_os.m3_events WHERE query_id=$1 AND kind='R2_PHYSICAL_CHILD'",[acceptedQueryId])).rows[0].n,
    job=(await admin!.query("SELECT tenant_id,type,payload,protocol_version FROM finnor_os.jobs WHERE payload->>'queryId'=$1",[acceptedQueryId])).rows[0];
   await admin!.query("INSERT INTO finnor_os.jobs(tenant_id,type,payload,idempotency_key,lane,protocol_version,retry_safety) VALUES($1,$2,$3::jsonb,$4,'interactive',$5,'locally_idempotent')",[job.tenant_id,job.type,JSON.stringify({...job.payload,generation:0}),'r2-stale:'+randomUUID(),job.protocol_version]);
   await tick();await durable(acceptedQueryId);const after=(await admin!.query("SELECT count(*)::int n FROM finnor_os.m3_events WHERE query_id=$1 AND kind='R2_PHYSICAL_CHILD'",[acceptedQueryId])).rows[0].n;assert.equal(after,before);
   const value=ok(await api('capital-program-read',{queryId:acceptedQueryId}));assert.equal(value.program.jointSearchCertificate.lower,'100');return {before,after,originalDeadlineAt:value.deadlineAt,grantRenewed:false};
  });
  await challenge('cancel-accepted-native-child',async()=>{
   const admitted=await newQuery('cancel-child'),running=tick(),child=await nativeChild(admitted.queryId,'construction'),before=(await admin!.query('SELECT deadline_at FROM finnor_os.m3_queries WHERE id=$1',[admitted.queryId])).rows[0].deadline_at.toISOString();
   const cancelled=ok(await api('capital-program-cancel',{queryId:admitted.queryId}));assert.equal(cancelled.status,'CANCELLED');process.kill(child.pid,'SIGCONT');await running;assert(await exited(child.pid));await durable(admitted.queryId);
   const current=ok(await api('capital-program-read',{queryId:admitted.queryId}));assert.equal(current.status,'CANCELLED');assert.equal(current.deadlineAt,before);assert.equal(current.program,null);assert.equal((await api('capital-program-resume',{queryId:admitted.queryId})).status,409);
   const permits=(await admin!.query("SELECT released_at,release_reason FROM finnor_os.compute_resource_leases WHERE owner_id LIKE $1",['r2:'+admitted.queryId+':%'])).rows;assert(permits.length&&permits.every(row=>row.released_at));return {admitted,child,cancelled,current,permits};
  });
  await challenge('checker-sigkill-after-accepted-bound',async()=>{
   const admitted=await newQuery('checker-death'),running=tick(),child=await nativeChild(admitted.queryId,'check-policy');process.kill(child.pid,'SIGKILL');await running;assert(await exited(child.pid));await durable(admitted.queryId);
   const current=ok(await api('capital-program-read',{queryId:admitted.queryId})),certificate=current.program.jointSearchCertificate;assert.equal(certificate.status,'INCOMPLETE');assert.equal(certificate.lower,null);assert.equal(certificate.upper,'210');assert.equal(certificate.exactOptimalityClaimed,false);assert.equal(certificate.fallback.status,'NO_COMPATIBLE_ADMITTED_FALLBACK');
   assert(certificate.costs.phases.some((p:any)=>p.phase==='check-policy'));return {admitted,child,current};
  });
  await challenge('shared-native-grant-two-works',async()=>{
   // Both actual registries are prepared before either episode starts. Cold
   // worker import is preparation, not time silently borrowed from stopped A.
   await prepareTick();const contender=preparedWorker!;preparedWorker=undefined;
   const a=await newQuery('capacity-A'),first=tick(),child=await nativeChild(a.queryId,'construction');preparedWorker=contender;
   const b=await newQuery('capacity-B'),second=await tick();
   const occupied=(await admin!.query("SELECT owner_id,resource_key,units,released_at FROM finnor_os.compute_resource_leases WHERE resource_key='native:r2' AND released_at IS NULL AND expires_at>clock_timestamp()" )).rows;assert.equal(occupied.length,1);assert(occupied[0].owner_id.startsWith('r2:'+a.queryId+':'));
   process.kill(child.pid,'SIGCONT');await first;await durable(a.queryId);await durable(b.queryId);
   const denied=ok(await api('capital-program-read',{queryId:b.queryId}));assert.equal(denied.program,null);assert.equal((await admin!.query("SELECT count(*)::int n FROM finnor_os.m3_events WHERE query_id=$1 AND kind='R2_PHYSICAL_CHILD'",[b.queryId])).rows[0].n,0);
   const admitted=ok(await api('capital-program-read',{queryId:a.queryId}));assert.equal(admitted.program.jointSearchCertificate.lower,'100');assert.equal(admitted.program.jointSearchCertificate.consumer.s5.feasible,true);
   return {a,b,child,second,occupied,denied,currentFeasibleIncumbent:admitted.program.jointSearchCertificate.incumbent.ref,financialReservationAuthority:'NONE',effectAuthority:'NONE'};
  });
  await challenge('worker-sigkill-and-expired-claim',async()=>{
   const admitted=await newQuery('worker-death'),running=tick([],true),child=await nativeChild(admitted.queryId,'check-policy'),worker=activeWorker!.pid!;activeWorker!.kill('SIGKILL');const stopped=await running;assert.equal(stopped.signal,'SIGKILL');assert(await exited(child.pid));
   const original=(await admin!.query('SELECT deadline_at FROM finnor_os.m3_queries WHERE id=$1',[admitted.queryId])).rows[0].deadline_at.toISOString(),job=(await admin!.query("SELECT lease_expires_at FROM finnor_os.jobs WHERE payload->>'queryId'=$1",[admitted.queryId])).rows[0];
   const waitMs=Math.max(0,job.lease_expires_at.getTime()-Date.now()+100);await new Promise(yes=>setTimeout(yes,waitMs));await tick(['--recover']);await durable(admitted.queryId);
   const value=ok(await api('capital-program-read',{queryId:admitted.queryId}));assert.equal(value.deadlineAt,original);assert.equal(value.program,null);assert.equal(value.status,'FAILED');
   const abandoned=(await admin!.query("SELECT body FROM finnor_os.m3_events WHERE query_id=$1 AND body->>'code'='DURABLE_CLAIM_LOST'",[admitted.queryId])).rows;assert(abandoned.some(row=>row.body.unknownPhysicalCost===true));return {admitted,worker,child,stopped,waitMs,value,abandoned};
  });
  await challenge('source-resource-rights-currentness',async()=>{
   const quiescence=[];
   for(let n=0;n<5;n++){
    const leases=(await admin!.query("SELECT owner_id,expires_at FROM finnor_os.compute_resource_leases WHERE resource_key='native:r2' AND released_at IS NULL AND expires_at>clock_timestamp()")).rows;
    if(!leases.length)break;const waitMs=Math.max(1,Math.min(30000,Math.max(...leases.map(row=>row.expires_at.getTime()-Date.now()+25))));
    quiescence.push({leases,waitMs,observation:'Earlier abandoned native grant remains occupied until its real expiry; no new episode admitted while waiting'});await artifact('native-quiescence.json',quiescence);await new Promise(yes=>setTimeout(yes,waitMs));
   }
   const retained=(await admin!.query('SELECT result_digest FROM finnor_os.m3_queries WHERE id=$1',[acceptedQueryId])).rows[0].result_digest;
   const resourceQuery=await newQuery('current-resource-revision');
   const resource=f.resources[0],{ref:previous,revision:_revision,priorRef:_prior,...input}=resource;
   const revisedResource={...input,existingUse:['1','1','1']},response=await fetch(upstream+'/api/allocations/resource',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({resource:revisedResource,expectedRef:previous})}),updated=await response.json() as any;
   assert.equal(response.status,200,JSON.stringify(updated));assert.equal(updated.revision,resource.revision+1);
   const resourceQueued=ok(await api('capital-program-read',{queryId:resourceQuery.queryId}));assert.equal(resourceQueued.status,'INVALIDATED');assert.equal(resourceQueued.program,null);await durable(resourceQuery.queryId);
   const resourceRead=ok(await api('capital-program-read',{queryId:acceptedQueryId}));assert.equal(resourceRead.program,null);assert.equal((await admin!.query('SELECT result_digest FROM finnor_os.m3_queries WHERE id=$1',[acceptedQueryId])).rows[0].result_digest,retained);
   f.resources[0]=updated;f.labels[f.incumbent.ref.id]='current';
   const reservationQuery=await newQuery('current-s5-reservation'),allocationInput=support.clearing(f,{current:['50']},[],[],[f.incumbent]),
    clearResponse=await fetch(upstream+'/api/allocations/clear',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(allocationInput)}),clear=await clearResponse.json() as any;
   assert.equal(clearResponse.status,200,JSON.stringify(clear));assert.equal(clear.status,'FEASIBLE');assert(clear.reservation);
   const reservationRead=ok(await api('capital-program-read',{queryId:reservationQuery.queryId}));assert.equal(reservationRead.status,'INVALIDATED');assert.equal(reservationRead.program,null);await durable(reservationQuery.queryId);
   const reservations=(await admin!.query("SELECT reservation_id,status,revision FROM finnor_os.s5_reservations WHERE tenant_id=$1 AND status<>'RELEASED'",[f.tenant])).rows;assert.equal(reservations.length,1);
   const worldQuery=await newQuery('current-world-revision'),query=(await admin!.query('SELECT result_digest FROM finnor_os.m3_queries WHERE id=$1',[acceptedQueryId])).rows[0],revised=structuredClone(source);revised.worlds[0].shocks[1][0]='-2';const bytes=JSON.stringify(revised),version=randomUUID();
   await admin!.query("INSERT INTO finnor_os.evidence_source_versions(id,source_id,scope,tenant_id,version_number,content_hash,content,snapshot,as_of,retrieved_at,created_at) VALUES($1,$2,'tenant',$3,2,$4,$5,$6::jsonb,clock_timestamp(),clock_timestamp(),clock_timestamp())",[version,sourceId,f.tenant,sha(bytes),bytes,JSON.stringify({worldRoot:f.root,claims:[]})]);
   const invalidated=ok(await api('capital-program-read',{queryId:acceptedQueryId}));assert.equal(invalidated.status,'INVALIDATED');assert.equal(invalidated.program,null);assert.equal((await admin!.query('SELECT result_digest FROM finnor_os.m3_queries WHERE id=$1',[acceptedQueryId])).rows[0].result_digest,query.result_digest);await durable(acceptedQueryId);
   const worldQueued=ok(await api('capital-program-read',{queryId:worldQuery.queryId}));assert.equal(worldQueued.status,'INVALIDATED');assert.equal(worldQueued.program,null);await durable(worldQuery.queryId);
   // A real S6 UNKNOWN kernel row is retained. No provider attempt, invented
   // cancellation or settlement is used to clear this liability.
   for(let n=0;n<3;n++)await tick();
   await prepareTick();const workId=(await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'Current S6 UNKNOWN while native checking',channel:'console',idempotencyKey:randomUUID()})).workId,
    revisedRequest={...request,workId,idempotencyKey:'unknown-during-check',robust:{...request.robust,source:{sourceId,versionId:version,contentDigest:sha(bytes)}}},
    s6Query=ok(await api('capital-program-submit',revisedRequest),202),running=tick(),child=await nativeChild(s6Query.queryId,'construction'),
    effectId=randomUUID(),effect={fixture:'retained-unknown-liability',physicalAttempt:'NOT_DISPATCHED_BY_R2',qualification:'DISPOSABLE_SQL_FAULT_INJECTION'};
   await admin!.query("INSERT INTO finnor_os.business_effects(id,tenant_id,semantic_hash,scope_hash,operation_class,effect,status) VALUES($1,$2,$3,$4,'financial_write',$5::jsonb,'reconciliation_required')",[effectId,f.tenant,hash(effect),hash(f.root),JSON.stringify(effect)]);
   const unknown=ok(await api('capital-program-read',{queryId:s6Query.queryId}));assert.equal(unknown.status,'INVALIDATED');assert.equal(unknown.program,null);await durable(s6Query.queryId);await running;assert(await exited(child.pid));await durable(s6Query.queryId);
   const blocked=await api('capital-program-submit',{...revisedRequest,idempotencyKey:'unsettled-s6'});assert.equal(blocked.status,409);assert(JSON.stringify(blocked).includes('R2_UNACCOUNTED_S6_OBLIGATION'));
   const retainedEffect=(await admin!.query('SELECT id,status FROM finnor_os.business_effects WHERE id=$1',[effectId])).rows;assert.equal(retainedEffect[0].status,'reconciliation_required');
   await admin!.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1 AND tenant_id=$2",[f.principal,f.tenant]);const denied=await api('capital-program-read',{queryId:acceptedQueryId});assert.equal(denied.status,403);
   return {effectId,s6Query,child,unknown,blocked,retainedEffect,unknownBasis:'ACTUAL_S6_SQL_STATE_NOT_PROVIDER_PROOF',updated,resourceQuery,resourceQueued,resourceRead,reservationQuery,clear,reservations,reservationRead,version,worldQuery,worldQueued,invalidated,retainedHistoricalDigest:query.result_digest,denied};
  });
 }
 if(lane==='compatibility'&&cases[0].status==='PASS'){
  await challenge('legacy-job-executes-unchanged',async()=>{
   // Same disposable governor setup as the existing M3 owner runner. This
   // supplies its ordinary M1 prerequisite, not an R2 effect/funding grant.
   await admin!.query("INSERT INTO finnor_os.compute_resource_policies(resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,enabled,source) VALUES('provider:m1-native',2,2,0,120,true,'R2 compatibility uses existing M3 disposable M1 capacity') ON CONFLICT(resource_key) DO NOTHING");
   const workId=(await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'Legacy economic descriptor compatibility',channel:'console',idempotencyKey:randomUUID()})).workId,
    {robust:_robust,...legacy}=request,submitted=ok(await api('capital-program-submit',{...legacy,workId,idempotencyKey:'legacy-compatibility',permitted:{...legacy.permitted,terms:['0.15'],structures:['IMMEDIATE']}}),202);
   await tick(['--legacy']);const value=await drain(submitted.queryId);assert(value.program,JSON.stringify(value));assert.equal(value.program.jointSearchCertificate,undefined);
   assert.equal(value.program.incumbentAndSearchGap.upperBound,null);assert.equal(value.program.incumbentAndSearchGap.globalOptimalityClaimed,false);
   const jobs=(await admin!.query("SELECT type,status,protocol_version FROM finnor_os.jobs WHERE payload->>'queryId'=$1",[submitted.queryId])).rows;assert(jobs.every(job=>job.type==='run_capital_program_v2'&&job.protocol_version===2));
   return {submitted,value,jobs};
  });
  await challenge('old-new-job-compatibility',async()=>{
   const admitted=await newQuery('new-job-contract'),before=(await admin!.query("SELECT attempts,status,protocol_version FROM finnor_os.jobs WHERE payload->>'queryId'=$1",[admitted.queryId])).rows[0];await tick(['--legacy']);
   const after=(await admin!.query("SELECT attempts,status,protocol_version FROM finnor_os.jobs WHERE payload->>'queryId'=$1",[admitted.queryId])).rows[0];assert.deepEqual(after,before);
   await admin!.query("UPDATE finnor_os.jobs SET protocol_version=3 WHERE payload->>'queryId'=$1",[admitted.queryId]);await tick();assert.equal((await admin!.query("SELECT attempts FROM finnor_os.jobs WHERE payload->>'queryId'=$1",[admitted.queryId])).rows[0].attempts,0);
   await durable(admitted.queryId);return {admitted,before,after,incompatibleProtocolLeftQueued:true};
  });
 }
 if(serve&&cases[0].status==='PASS'){
  const catalogue=ok(await api('capital-program-context',{workId:f.workId,root:f.root}));await artifact('catalogue-before-browser.json',catalogue);
  const {validateBeliefViewPin}=await import('../../packages/private-equity/src/enterprise-beliefs');await artifact('owner-pins-before-browser.json',await Promise.all(f.incumbent.bindings.beliefPins.map((pin:any)=>validateBeliefViewPin(f.ctx,pin))));
  assert(catalogue.policies.some((p:any)=>p.ref.id===f.incumbent.ref.id),'Actual deal catalogue lacks the current incumbent');
  let log='';const frontendLog=createWriteStream(join(out,'next-live.log'),{flags:'wx',mode:0o600});frontendLog.on('error',error=>console.error('FRONTEND_EVIDENCE_WRITE_FAILED',String(error)));
  next=spawn(process.execPath,["--max-old-space-size=1024",join(repo,'node_modules/next/dist/bin/next'),'dev','--hostname','127.0.0.1','--port','0','--webpack'],{cwd:repo,env:{...process.env,NODE_ENV:'development',NEXT_PUBLIC_OS_API_URL:upstream,NEXT_PUBLIC_SUPABASE_URL:issuerUrl,NEXT_PUBLIC_SUPABASE_ANON_KEY:'r2-disposable-public-key',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});for(const stream of [next.stdout!,next.stderr!])stream.on('data',b=>{log+=b;frontendLog.write(b);});next.once('exit',()=>frontendLog.end());
  let frontend='';for(let i=0;i<300;i++){const match=log.match(/http:\/\/127\.0\.0\.1:(\d+)/);if(match){frontend='http://127.0.0.1:'+match[1];break;}if(next.exitCode!==null)throw Error(log);await new Promise(yes=>setTimeout(yes,100));}assert(frontend,log);
  await artifact('ready.json',{frontend,issuerUrl,upstream,login:frontend+'/centropy/login',workUrl:frontend+'/centropy/investigations/'+thread.id+'?root='+encodeURIComponent('pe_deal:'+dealRoot.entityId),email,password:'r2-disposable-local-password',workId:f.workId,policyId:f.incumbent.ref.id,sourceId,expectedLower:'100'});console.log('R2_BROWSER_READY '+out);
  let workerLog='',workerError='';const liveWorker=spawn(process.execPath,['--import','tsx','scripts/r2/worker-child.mts','--loop'],{cwd:join(repo,'finnor-os'),env:{...process.env,DATABASE_URL:workerUrl},stdio:['ignore','pipe','pipe']});
  liveWorker.stdout.on('data',bytes=>workerLog+=bytes);liveWorker.stderr.on('data',bytes=>workerError+=bytes);
  const workerExit=new Promise<number|null>((yes,no)=>{liveWorker.once('error',no);liveWorker.once('exit',yes);});
  let browserResult:any=null;for(let i=0;i<2400;i++){const bytes=await readFile(join(out,'browser-done.json'),'utf8').catch(()=>null);if(bytes){browserResult=JSON.parse(bytes);break;}if(liveWorker.exitCode!==null)throw Error('Physical browser worker exited before observation');await new Promise(yes=>setTimeout(yes,250));}
  liveWorker.kill('SIGTERM');const exitCode=await workerExit;await artifact('worker/browser-persistent-worker.json',{pid:liveWorker.pid,exitCode,workerLog,workerError});
  for(const q of (await admin!.query('SELECT id FROM finnor_os.m3_queries WHERE tenant_id=$1 AND principal_id=$2',[f.tenant,f.principal])).rows)await durable(q.id);
  cases.push({id:'mounted-Work',status:browserResult?.status==='PASS'?'PASS':'FAIL',observed:browserResult,reason:browserResult?.status==='PASS'?null:browserResult?'Observed browser predicate failed':'Finite browser observation window exhausted; no mounted success claimed'});
  stopped=true;await artifact('next.log.json',{log});
 }
}catch(error){cases.push({id:'owner-setup-or-runtime',status:'FAIL',error:String(error),stack:(error as Error).stack});}
finally{stopped=true;if(activeWorker&&activeWorker.exitCode===null&&activeWorker.signalCode===null){activeWorker.kill('SIGTERM');await new Promise<void>(yes=>activeWorker!.once('exit',()=>yes()));}preparedWorker?.child.kill('SIGTERM');if(preparedWorker)await preparedWorker.exit;next?.kill('SIGTERM');backend?.close();issuer?.close();await admin?.end();await closePool();await postgres.stop();await save();}
console.log(JSON.stringify({output:out,cases:cases.map(c=>({id:c.id,status:c.status}))}));if(cases.some(c=>c.status==='FAIL'))process.exitCode=1;

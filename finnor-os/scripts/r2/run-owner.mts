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
import {closePool,getPool,receiveWork,createEmployeeConversationThread} from '@finnor/db';
import {migrate} from '../../packages/db/migrate';
import {createDeal} from '@finnor/private-equity';
import {createEvidenceSource} from '@finnor/memory';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mts';
import {POST as allocationPost} from '../../apps/api/app/api/allocations/[operation]/route';
import {POST as s3Post} from '../../apps/api/app/api/interventions/[operation]/route';
import {POST as s4Post} from '../../apps/api/app/api/policies/[operation]/route';
import {quantities,originalDecimal,hash,ref} from './fixtures.mts';
import {R2_PROFILE,R2_VERSION} from '../../packages/shared-types/src/robust-programme-search';
import {writeM3Record,readM3Record} from '../../packages/private-equity/src/capital-program/v2-store';
import {m3Ref} from '../../packages/private-equity/src/capital-program/v2-contracts';
import {r2Ref} from '../../packages/private-equity/src/capital-program/r2-native';
const repo=resolve('..'),out=process.env.FINNOR_R2_EVIDENCE_DIR!,cases:any[]=[],traffic:any[]=[],began=new Date().toISOString(),serve=process.argv.includes('--serve'),caseFlag=process.argv.indexOf('--case'),lane=caseFlag<0?'positive':process.argv[caseFlag+1];
assert(['positive','responsibility','compatibility','diagnostic'].includes(lane??''),'Unknown registered owner lane');
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const artifact=async(name:string,value:unknown)=>{const path=join(out,name);await mkdir(resolve(path,'..'),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(value,null,2));return path;};
const onlyIndex=process.argv.indexOf('--only'),only=onlyIndex<0?null:new Set(process.argv[onlyIndex+1]?.split(','));
async function challenge(id:string,run:()=>Promise<unknown>){if(only&&!only.has(id)&&!['authenticated-contingent-owner','authentication-and-private-scope'].includes(id))return;const start=performance.now();try{cases.push({id,status:'PASS',observed:await run(),wallMs:performance.now()-start});}catch(error){cases.push({id,status:'FAIL',error:String(error),stack:(error as Error).stack,wallMs:performance.now()-start});}console.log(JSON.stringify({id,status:cases.at(-1).status}));await save();}
async function save(){await artifact('results.json',{schema:'finnor.r2.owner-e2e.v1',began,finishedAt:new Date().toISOString(),cases,traffic,money:null,moneyStatus:'UNMETERED',rerun:'python3 finnor-os/scripts/r2/run-owner-local.py',qualification:'Disposable real signed bearer, ordinary SQL role, actual owners and protocol-2 worker. Protected admission/production activation/economic gain NOT RUN.'});}
const listen=async(server:ReturnType<typeof createServer>)=>{await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));const addr=server.address();assert(addr&&typeof addr!=='string');return `http://127.0.0.1:${addr.port}`;};
const portServer=createServer(),portUrl=await listen(portServer),port=Number(new URL(portUrl).port);await new Promise<void>(yes=>portServer.close(()=>yes()));
const pgdir=await mkdtemp(join(tmpdir(),'finnor-r2-owner-')),postgres=new EmbeddedPostgres({databaseDir:pgdir,user:'finnor',password:'finnor',port,persistent:lane==='compatibility',onLog:(message:string)=>{void appendFile(join(out,"postgres.log"),message+"\n").catch(()=>undefined);}});
let admin:pg.Client|undefined,issuer:ReturnType<typeof createServer>|undefined,backend:ReturnType<typeof createServer>|undefined,next:ReturnType<typeof spawn>|undefined,upstream='',token='',workerUrl='',acceptedQueryId='',f:any,request:any,stopped=false;const privateIdentities:Array<{scope:string;id:string;tenant:string;email:string}>=[];
const fixtureApi=async(scope:any,operation:string,body:unknown,handler=allocationPost)=>{const response=await handler(new Request('http://127.0.0.1/api/'+operation,{method:'POST',headers:{'content-type':'application/json','x-tenant-id':scope.tenant,'x-user-id':scope.principal},body:JSON.stringify(body)}),{params:Promise.resolve({operation})});return {status:response.status,body:await response.json() as any};};
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
  const directory=join(repo,'finnor-os/packages/db/migrations'),files=await Promise.all((await readdir(directory)).filter(name=>name.endsWith('.sql')&&!name.startsWith('0172_')).map(async name=>({name,sql:await readFile(join(directory,name),'utf8')})));
  await migrate(url,files);const prior=new pg.Client({connectionString:url});await prior.connect();const before=(await prior.query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows;await prior.end();
  const applied=await migrate(url);await postgres.stop();await postgres.start();const after=new pg.Client({connectionString:url});await after.connect();await artifact('migration-upgrade-restart.json',{before,applied,after:(await after.query('SELECT name FROM finnor_os._migrations ORDER BY name')).rows,roles:(await after.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN('finnor_app','finnor_worker')")).rows});await after.end();assert.deepEqual(applied,['0172_r2_robust_programme_search.sql']);
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
 f=await support.fixture('r2-owner-contingent',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]);
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
 await challenge('authenticated-contingent-owner',async()=>{await prepareTick();const submitted=ok(await api('capital-program-submit',request),202);acceptedQueryId=submitted.queryId;
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
   const runtime=process.env.FINNOR_R2_RUNTIME!,observed=[];
   for(const mode of ['solver-binary','unsafe-cut-configuration','checker-source']){
    const path=mode==='solver-binary'?join(runtime,'bin/scip'):mode==='unsafe-cut-configuration'?join(runtime,'manifest.json'):join(repo,'finnor-os/packages/epistemic-runtime/python/r2_check.py'),
     originalBytes=await readFile(path),admitted=await newQuery('scientific-identity-'+mode),before=(await admin!.query('SELECT deadline_at FROM finnor_os.m3_queries WHERE id=$1',[admitted.queryId])).rows[0],
     running=tick(),child=await nativeChild(admitted.queryId,'check-policy');
    try{
     let changedBytes:Buffer;
     if(mode==='unsafe-cut-configuration'){const manifest=JSON.parse(originalBytes.toString());manifest.configuration.cuts=true;changedBytes=Buffer.from(JSON.stringify(manifest));}
     else changedBytes=Buffer.concat([originalBytes,Buffer.from(mode==='checker-source'?'\n# Disposable original checker identity revision\n':'\n')]);
     await artifact('scientific-identity/'+mode+'.json',{mode,path,originalSha256:sha(originalBytes),replacementSha256:sha(changedBytes),originalGrantRenewed:false});
     await writeFile(path,changedBytes);try{process.kill(child.pid,'SIGCONT');}catch{}await running;assert(await exited(child.pid));await durable(admitted.queryId);
     const row=(await admin!.query('SELECT status,deadline_at,result_digest,failure FROM finnor_os.m3_queries WHERE id=$1',[admitted.queryId])).rows[0],
      publications=(await admin!.query('SELECT * FROM finnor_os.m3_publications WHERE query_id=$1',[admitted.queryId])).rows,
      accepted=(await admin!.query("SELECT body FROM finnor_os.m3_events WHERE query_id=$1 AND kind='R2_REJECTED_CLAIM' AND body->>'upper' IN('210','100')",[admitted.queryId])).rows,
      proofChecks=(await admin!.query("SELECT body FROM finnor_os.m3_events WHERE query_id=$1 AND kind='R2_PHYSICAL_CHILD' AND body->>'phase'='check-proof' AND body->>'state'='EXITED'",[admitted.queryId])).rows;
     assert.equal(row.result_digest,null);assert.equal(publications.length,0);assert.equal(row.deadline_at.toISOString(),before.deadline_at.toISOString());
     assert(accepted.length&&proofChecks.some(v=>v.body.receipt.exitCode===0),'Genuine original accepted upper proof prerequisite missing');observed.push({mode,admitted,child,row,publications,accepted,proofChecks});
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

/** Pre-implementation S2 integrated challenges. No production numerical helper
 * supplies expected answers. Real S1/authority/HTTP handlers use disposable PG.
 * Reference telemetry is explicitly unadmitted; no real effect is dispatched. */
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, mkdtemp, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { spawnSync } from "node:child_process";
import { migrate } from "../../packages/db/migrate";
import { closePool, configureTenantVertical, withTenantTransaction } from "@finnor/db";
import { loadEnterpriseBeliefView, createMetricSeries, designEnterpriseExperiments, validateEnterpriseExperiment,
  type PeMutationContext } from "@finnor/private-equity";
import { designExperiments, projectExperimentRealization, resumeExperimentRealization, prepareExperimentCollectionHandoff,
  referenceExperimentTelemetry } from "@finnor/epistemic-runtime";
import { POST as experimentPost } from "../../apps/api/app/api/experiments/[operation]/route";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = resolve(process.env.FINNOR_S2_EVIDENCE_DIR ?? join(repo, "scope-2/scope-evidence", `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0,8)}`));
await mkdir(output, {recursive:true});
const startedAt = new Date().toISOString();
const cases: any[] = []; const workloads: any[] = [];
const paths = ["finnor-os/scripts/s2/run-s2-e2e.mts", "finnor-os/scripts/s2/run-s2-cold.mts", "finnor-os/scripts/s2/reference.py", "scope-2/scope-plan.md", "scope-2/scope-evidence/failure-model.md",
  "finnor-os/packages/shared-types/src/experiments.ts", "finnor-os/packages/epistemic-runtime/src/experiments.ts", "finnor-os/packages/epistemic-runtime/src/experiment-numerics.ts",
  "finnor-os/packages/epistemic-runtime/src/experiment-realization.ts", "finnor-os/packages/private-equity/src/enterprise-experiments.ts", "finnor-os/apps/api/app/api/experiments/[operation]/route.ts",
  "finnor-os/packages/private-equity/src/enterprise-beliefs.ts", "finnor-os/packages/shared-types/src/enterprise-beliefs.ts", "finnor-os/packages/authority/src/index.ts", "package-lock.json", "finnor-os/package-lock.json"];
const manifest = await Promise.all(paths.map(async path => { const bytes=await readFile(resolve(repo,path)),snapshot=join(output,"source-snapshot",path);await mkdir(dirname(snapshot),{recursive:true});await writeFile(snapshot,bytes);return {path,sha256:createHash("sha256").update(bytes).digest("hex")}; }));
let databaseVersion = "unavailable"; let migrationCount=0;
const versions:Record<string,string> = {node:process.version, python:spawnSync("python3",["--version"],{encoding:"utf8"}).stdout.trim()};
for(const name of["zod","tsx","typescript","next","pg","embedded-postgres"])versions[name]=JSON.parse(await readFile(resolve(repo,"finnor-os/node_modules",name,"package.json"),"utf8")).version;
const save = () => writeFile(join(output,"results.json"), JSON.stringify({schema:"finnor.s2.e2e.v1", startedAt, generatedAt:new Date().toISOString(),
  status:cases.some(c=>c.status==="FAIL")?"FAIL":"PASS_LOCAL",versions,databaseVersion,migrationCount,manifest,cases,workloads,
  evidenceBoundary:"Disposable PG and actual handlers. Supplied synthetic likelihoods/priors; unadmitted reference S4/S6/S7 telemetry; no protected receipt, real closed-loop policy, prospective enterprise or H2 validity.",
  rerun:"See scope-2/scope-evidence/README.md"},null,2)+"\n");
async function challenge(id:string,input:any,expected:string,fn:()=>Promise<any>){const t=performance.now();try{cases.push({id,input,expected,status:"PASS",observed:await fn(),durationMs:performance.now()-t});}catch(e){cases.push({id,input,expected,status:"FAIL",observed:e instanceof Error?{message:e.message,stack:e.stack}:String(e),durationMs:performance.now()-t});}await save();}
const tenant=randomUUID(), actor=randomUUID(), otherTenant=randomUUID(), otherActor=randomUUID(), company=randomUUID(), otherCompany=randomUUID();
const ctx:PeMutationContext={auth:{tenantId:tenant,userId:actor,employeeId:actor,role:"owner"}};
const root={entityType:"external_organization",entityId:company} as const;
const ref=(owner:string,id:string)=>({owner,id,version:"supplied-1",contentDigest:createHash("sha256").update(`${owner}:${id}`).digest("hex")});
const now=()=>new Date().toISOString();
function fixture(samples=8, sequential=false):any{
  const start=now(),end=new Date(Date.now()+3600000).toISOString();
  const candidate=(id:string,probabilities:string[][])=>({id,instrumentRef:ref("SUPPLIED",id),endpoint:{id:"binary-measurement",unit:"category",categories:["negative","positive"]},
    populationRef:ref("SUPPLIED","population"),measurementUnit:"independent-item",assignment:{kind:"OBSERVATIONAL",unit:"independent-item",probability:"1"},
    timing:{startAt:start,endAt:end,minimumIntervalMs:0},process:{methodRef:ref("SUPPLIED","measurement-method"),instrumentError:"IN_LIKELIHOOD",missingness:"NONE",dependence:"CONDITIONAL_IID",interference:"NONE",reactivity:"NONE",nuisance:"FIXED_SUPPLIED"},
    likelihood:{status:"SUPPLIED_CONDITIONAL",probabilities,calibrationRef:null,assumptions:["Synthetic supplied IID likelihood; no field calibration"]},samples,
    stopping:{method:sequential?"ANYTIME_LR":"FIXED_SAMPLE",alpha:"0.05",beta:"0.05",minimumPower:"0"},
    costEstimate:{money:{value:"0",unit:"USD"},elapsedMs:100,humanSeconds:0,dataBytes:1024,integrationUnits:0,computeMs:null},
    exposure:{unitsPerSample:"1",privacyUnitsPerSample:"0",riskAssumptions:["Local fixture only"]}});
  return {schema:"finnor.s2.design-request.v1",inquiryId:"registered-inquiry",episodeId:"s2-e2e",mandateRef:ref("SUPPLIED","mandate"),
    decisionContext:{ref:ref("SUPPLIED","decision"),utilityRef:ref("SUPPLIED","utility"),horizonEnd:end,lossUnit:"normalized-loss",actionIds:["a0","a1"],lossByHypothesis:[["0","1"],["1","0"]]},
    hypotheses:[{ref:ref("SUPPLIED","h0"),prior:"0.5",meaning:"Synthetic H0"},{ref:ref("SUPPLIED","h1"),prior:"0.5",meaning:"Synthetic H1"}],requiredClaimRefs:[],validUntil:end,maxBeliefAgeMs:3600000,
    constraints:{maxSamples:24,maxElapsedMs:3600000,maxExposureUnits:"24",maxPrivacyUnits:"0",moneyLimit:{value:"0",unit:"USD"},permittedPopulationRefs:[ref("SUPPLIED","population")],permittedInstrumentRefs:[ref("SUPPLIED","informative"),ref("SUPPLIED","irrelevant")]},
    candidates:[candidate("informative",[["0.8","0.2"],["0.2","0.8"]]),candidate("irrelevant",[["0.5","0.5"],["0.5","0.5"]])]};
}
function oracle(request:any):any{const result=spawnSync("python3",[resolve(repo,"finnor-os/scripts/s2/reference.py")],{input:JSON.stringify(request),encoding:"utf8",maxBuffer:4*1024*1024});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
const q=(x:any)=>({numerator:x.numerator,denominator:x.denominator});
function compare(bundle:any,expected:any){for(const design of bundle.designs){if(!design.protocol)continue;const got=design.protocol.metrics,exp=expected[design.candidateId];for(const key of ["baselineRisk","terminalRisk","riskReduction","expectedSamples"])assert.deepEqual(q(got[key]),exp[key],`${design.candidateId}:${key}`);for(const key of ["massByHypothesis","rejectH0ByHypothesis","rejectH1ByHypothesis","inconclusiveByHypothesis"])assert.deepEqual(got[key].map(q),exp[key],`${design.candidateId}:${key}`);
  const sort=(a:any,b:any)=>a.sampleSize-b.sampleSize||a.counts.reduce((v:number,c:number,i:number)=>v||c-b.counts[i],0)||a.stop.localeCompare(b.stop);assert.deepEqual([...got.observations].sort(sort),[...exp.terminalEncoding].sort(sort),`${design.candidateId}:complete-distribution`);}}
const directory=await mkdtemp(join(tmpdir(),"finnor-s2-e2e-"));
const port=await new Promise<number>((yes,no)=>{const s=createServer();s.once("error",no);s.listen(0,"127.0.0.1",()=>{const a=s.address();if(!a||typeof a==="string")return no(Error("port"));s.close(()=>yes(a.port));});});
const postgres=new EmbeddedPostgres({databaseDir:directory,user:"finnor",password:"finnor",port,persistent:false,onLog:()=>undefined});
let admin:pg.Client|undefined;
let view:any;let protocol:any;let baseRequest:any;
async function api(operation:string,body:any,t=tenant,a=actor){return experimentPost(new Request(`http://localhost/api/experiments/${operation}`,{method:"POST",headers:{"content-type":"application/json","x-tenant-id":t,"x-user-id":a},body:JSON.stringify(body)}),{params:Promise.resolve({operation})});}
const actorBinding=()=>({tenantId:tenant,principalId:actor,now:now()});
function telemetry(p:any,kind:string,data:any,parents:string[]=[],knowledgeAt=now()):any{return referenceExperimentTelemetry({tenantId:tenant,principalId:actor,protocolRef:p.id,kind:kind as any,data,parents,validAt:knowledgeAt,knowledgeAt,sourceRef:ref(["SELECTION","BUSINESS_STOP"].includes(kind)?"S4":kind==="ALLOCATION"?"S5":"S6",`reference-${kind}`)});}
function sampleEvents(p:any,index:number,category="positive"){const unitId=`unit-${index}`;const assignment=telemetry(p,"ASSIGNMENT",{unitId,targetRef:p.candidate.populationRef,probability:"1"});
  const attempt=telemetry(p,"ATTEMPT",{unitId,assignmentId:assignment.id,effectRef:ref("S6",`effect-${index}`)},[assignment.id]);
  const acknowledgment=telemetry(p,"ACKNOWLEDGMENT",{attemptId:attempt.id,status:"ACKNOWLEDGED"},[attempt.id]);
  const exposure=telemetry(p,"EXPOSURE",{unitId,attemptId:attempt.id,quantity:"1",unit:"independent-item",status:"MEASURED"},[attempt.id,acknowledgment.id]);
  const observation=telemetry(p,"OBSERVATION",{unitId,exposureId:exposure.id,originId:`origin-${index}`,instrumentRef:p.candidate.instrumentRef,endpointId:p.candidate.endpoint.id,category,status:"MEASURED",observationRef:ref("S6",`observation-${index}`)},[exposure.id]);
  const verification=telemetry(p,"VERIFICATION",{observationId:observation.id,status:"VERIFIED",methodRef:ref("S6","reference-independent-readback")},[observation.id]);return [assignment,attempt,acknowledgment,exposure,observation,verification];}

try{
  process.env.FINNOR_TEST_MANAGED_EXTENSIONS="omit";await postgres.initialise();await appendFile(join(directory,"postgresql.conf"),"\ntrack_commit_timestamp=on\n");await postgres.start();await postgres.createDatabase("s2_e2e");
  const url=`postgres://finnor:finnor@127.0.0.1:${port}/s2_e2e`;migrationCount=(await migrate(url)).length;admin=new pg.Client({connectionString:url});await admin.connect();databaseVersion=(await admin.query("SELECT version() version")).rows[0].version;
  await admin.query("ALTER ROLE finnor_app LOGIN PASSWORD 'finnor_app'");await admin.query("SET app.test_vertical_mode='explicit'");
  await admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,'S2 A'),($3,$4,'S2 B')",[tenant,randomUUID(),otherTenant,randomUUID()]);
  await admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active'),($4,$5,$6,'owner','active')",[actor,tenant,`${actor}@test.invalid`,otherActor,otherTenant,`${otherActor}@test.invalid`]);
  process.env.DATABASE_URL=`postgres://finnor_app:finnor_app@127.0.0.1:${port}/s2_e2e`;await closePool();
  for(const [t,a]of[[tenant,actor],[otherTenant,otherActor]])await configureTenantVertical({tenantId:t!,verticalKey:"private_equity",expectedVersion:0,createdBy:a!,sourceSystem:"s2:e2e"});
  await admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,'s2-local','S2 local','other'),($3,$4,'s2-foreign','FORBIDDEN-S2','other')",[company,tenant,otherCompany,otherTenant]);
  view=await loadEnterpriseBeliefView(ctx,{root});baseRequest=fixture();
  await writeFile(join(output,"preregistered-inputs.json"),JSON.stringify({baseRequest,domain:"s2-finite-v1",seed:20261001,episodesPerHypothesis:2000,calibrationCases:6,frequencyTolerance:0.06,manifest},null,2));
  await challenge("real-s1-api-design",baseRequest,"Real qualified S1 records feed one immutable protocol; exact reference agrees; no append or effect authority",async()=>{
    const res=await api("design",{root,request:baseRequest});assert.equal(res.status,200);const bundle:any=await res.json();compare(bundle,oracle(baseRequest));protocol=bundle.designs[0]!.protocol;
    assert(protocol);assert.equal(protocol.semanticOwner,"S2");assert.equal(protocol.beliefBinding.posteriorCalibrated,false);assert.equal(protocol.admission.executionAuthorityGranted,false);assert.equal(protocol.experience.receipt,null);
    assert.equal(bundle.preferredDesignRef,protocol.id);assert.equal(protocol.metrics.terminalRisk.unit,"normalized-loss");return bundle;});
  await challenge("exact-boundaries-and-sequential",{n:[1,8,12,24],k:3,orderedSequentialLimit:12},"Exact fixed/optional stopped risk and all hypothesis masses agree with an independent solver",async()=>{
    const observed=[];for(const sequential of[false,true])for(const n of[1,8,12,24]){const request=fixture(n,sequential);request.candidates[0].endpoint.categories=["low","middle","high"];request.candidates[0].likelihood.probabilities=[["0.7","0.2","0.1"],["0.1","0.2","0.7"]];request.candidates=request.candidates.slice(0,1);
      const bundle=await designEnterpriseExperiments(ctx,{root,request});compare(bundle,oracle(request));observed.push(bundle.designs[0]!.protocol?.metrics);}return observed;});
  await challenge("largest-fixed-composite-and-zero-laws",{hypotheses:4,actions:8,candidates:8,n:24,k:3},"Largest registered finite design and zero-probability support match independent exact totals and complete distribution encoding",async()=>{
    const r=fixture(24);r.hypotheses=[0,1,2,3].map(h=>({ref:ref("SUPPLIED",`h${h}`),prior:"0.25",meaning:`Synthetic H${h}`}));r.decisionContext.actionIds=Array.from({length:8},(_,a)=>`a${a}`);
    r.decisionContext.lossByHypothesis=Array.from({length:4},(_,h)=>Array.from({length:8},(_,a)=>a%4===h?"0":"1"));
    const base=r.candidates[0];base.endpoint.categories=["a","b","c"];base.likelihood.probabilities=[["1","0","0"],["0","1","0"],["0","0","1"],["0.2","0.3","0.5"]];
    r.candidates=Array.from({length:8},(_,i)=>({...structuredClone(base),id:`largest-${i}`,instrumentRef:ref("SUPPLIED",`largest-${i}`)}));r.constraints.permittedInstrumentRefs=r.candidates.map((c:any)=>c.instrumentRef);
    const before=process.memoryUsage().rss,t=performance.now();const bundle=await designEnterpriseExperiments(ctx,{root,request:r});const elapsed=performance.now()-t;compare(bundle,oracle(r));assert.equal(bundle.designs.length,8);assert(bundle.designs.every(d=>d.protocol));
    const bytes=Buffer.byteLength(JSON.stringify(bundle));assert(bytes<=4*1024*1024);assert(elapsed<=5000);return {bytes,elapsedMs:elapsed,sampledEndRssDelta:Math.max(0,process.memoryUsage().rss-before),designs:bundle.designs.map(d=>({id:d.candidateId,metrics:d.protocol!.metrics}))};});
  await challenge("unsupported-law-and-adversaries",{families:["unknown","cluster","missing","reactive","nuisance","interference"]},"Material unsupported assumptions remain UNKNOWN/UNSUPPORTED; no invented calibrated power",async()=>{
    const out=[];for(const [field,value]of[["dependence","CLUSTERED"],["missingness","INFORMATIVE"],["reactivity","PRESENT"],["nuisance","UNKNOWN"],["interference","PRESENT"]]){const request=fixture();request.candidates[0].process[field!]=value;request.candidates=request.candidates.slice(0,1);const result=await designEnterpriseExperiments(ctx,{root,request});assert.equal(result.designs[0]!.protocol,null);assert.equal(result.designs[0]!.status,"UNSUPPORTED");out.push(result);}
    const request=fixture();request.candidates[0].likelihood={status:"UNKNOWN",reasons:["No instrument likelihood"]};request.candidates=request.candidates.slice(0,1);const result=await designEnterpriseExperiments(ctx,{root,request});assert.equal(result.designs[0]!.protocol,null);return [...out,result];});
  await challenge("irrelevance-cost-exposure-power",{},"Decision-irrelevant information, insufficient power and infeasible cost/exposure are explicit",async()=>{
    const irrelevant=fixture();irrelevant.decisionContext.lossByHypothesis=[["0","1"],["0","1"]];const i=await designEnterpriseExperiments(ctx,{root,request:irrelevant});assert(i.designs.every((d:any)=>d.protocol.metrics.riskReduction.numerator==="0"));
    const equality=fixture(1);equality.candidates=equality.candidates.slice(0,1);equality.constraints.maxExposureUnits="1";const boundary=await designEnterpriseExperiments(ctx,{root,request:equality});assert.equal(boundary.designs[0]!.status,"SUPPORTED");
    const results=[i,boundary];for(const modify of[(r:any)=>r.constraints.maxExposureUnits="1",(r:any)=>r.candidates[0].costEstimate.money.value="1",(r:any)=>r.candidates[0].stopping.minimumPower="0.99"]){const r=fixture(2);r.candidates=r.candidates.slice(0,1);modify(r);const b=await designEnterpriseExperiments(ctx,{root,request:r});assert.notEqual(b.designs[0]!.status,"SUPPORTED");results.push(b);}return results;});
  await challenge("malformed-and-foreign-input",{},"Malformed decimals/sums/nonfinite/future/foreign refs fail safely; oversized stream bounded",async()=>{
    const observed=[];for(const mutate of[(r:any)=>r.hypotheses[0].prior="0.8",(r:any)=>r.candidates[0].likelihood.probabilities[0]=["0.9","0.9"],(r:any)=>r.candidates[0].samples=10000,(r:any)=>r.requiredClaimRefs=["foreign-or-missing"]]){const r=fixture();mutate(r);const res=await api("design",{root,request:r});assert(res.status>=400);observed.push({status:res.status,body:await res.json()});}
    const foreign=await api("design",{root:{entityType:"external_organization",entityId:otherCompany},request:fixture()});assert.equal(foreign.status,404);assert(!JSON.stringify(await foreign.json()).includes("FORBIDDEN-S2"));
    const huge=await experimentPost(new Request("http://localhost/api/experiments/design",{method:"POST",headers:{"x-tenant-id":tenant,"x-user-id":actor},body:"x".repeat(70000)}),{params:Promise.resolve({operation:"design"})});assert.equal(huge.status,413);return observed;});
  await challenge("realization-lineage-replay-unknown",{},"Separate immutable stages; crash/restart cumulative samples; unknown blocks new collection",async()=>{
    const request=fixture(8,true);const p=(await designEnterpriseExperiments(ctx,{root,request})).designs[0]!.protocol!;const events=[...sampleEvents(p,0),...sampleEvents(p,1,"negative")];
    const before=JSON.stringify(p);const realization=projectExperimentRealization(p,events,actorBinding());assert.equal(realization.analyzableSample.length,2);assert.equal(realization.actualExposures.length,2);assert.equal(realization.assignments.length,2);assert.equal(realization.attempts.length,2);assert.equal(JSON.stringify(p),before);
    const restart=projectExperimentRealization(JSON.parse(JSON.stringify(p)),JSON.parse(JSON.stringify(events)),actorBinding());assert.deepEqual(restart.analysis,realization.analysis);
    const unknown=sampleEvents(p,2).slice(0,2);const unresolved=projectExperimentRealization(p,[...events,...unknown],actorBinding());assert.equal(unresolved.collectionDisposition,"RECONCILE_UNKNOWN");assert.equal(unresolved.analyzableSample.length,2);
    const handoff=prepareExperimentCollectionHandoff(p,unresolved,actorBinding());assert.equal(handoff.executionAuthorityGranted,false);assert.equal(handoff.status,"BLOCKED_EXTERNAL");return {realization,restart,unresolved,handoff};});
  await challenge("real-api-resume-and-immutable-revision",{},"Actual realization/resume handlers retain prior sample/error budget; altered protocols and foreign actors rejected",async()=>{
    const p=(await designEnterpriseExperiments(ctx,{root,request:fixture(8,true)})).designs[0]!.protocol!;
    const first=await api("realization",{protocol:p,events:sampleEvents(p,0)});assert.equal(first.status,200);const firstBody:any=await first.json();assert.equal(firstBody.realization.analyzableSample.length,1);
    const resumed=await api("resume",{protocol:p,prior:firstBody.realization,events:sampleEvents(p,1,"negative")});assert.equal(resumed.status,200);const body:any=await resumed.json();assert.equal(body.realization.analyzableSample.length,2);assert.equal(body.realization.priorRealizationRef,firstBody.realization.id);
    const immutable=JSON.stringify(p);assert.throws(()=>{(p as any).candidate.endpoint.id="rewritten"});assert.equal(JSON.stringify(p),immutable);
    const changed=JSON.parse(immutable);changed.candidate.endpoint.id="rewritten";assert.equal((await api("realization",{protocol:changed,events:[]})).status,400);
    const foreign=await api("realization",{protocol:p,events:[]},otherTenant,otherActor);assert.equal(foreign.status,404);return {first:firstBody,resumed:body};});
  await challenge("statistical-stop-correction-and-noncompliance",{},"Statistical stop survives resume; extra collection, changed exposure and measurement correction invalidate analysis without erasing original history",async()=>{
    const p=(await designEnterpriseExperiments(ctx,{root,request:fixture(8,true)})).designs[0]!.protocol!;const events=[...sampleEvents(p,0),...sampleEvents(p,1),...sampleEvents(p,2)];const stopped=projectExperimentRealization(p,events,actorBinding());assert.equal(stopped.collectionDisposition,"STATISTICAL_STOP");
    const extra=resumeExperimentRealization(p,stopped,sampleEvents(p,3),actorBinding());assert.equal(extra.analysis.valid,false);assert(extra.deviations.some(d=>d.code==="COLLECTION_AFTER_REGISTERED_STOP"));assert.equal(extra.analyzableSample.length,4);
    const correction=telemetry(p,"CORRECTION",{supersedesEventId:events[4]!.id,reason:"Independent readback correction"},[events[4]!.id]);const corrected=resumeExperimentRealization(p,stopped,[correction],actorBinding());assert.equal(corrected.analysis.valid,false);assert.equal(corrected.history.length,events.length+1);assert.equal(corrected.protocolRef,p.id);
    const noncompliant=sampleEvents(p,9);noncompliant[3]=telemetry(p,"EXPOSURE",{...noncompliant[3].data,quantity:"2"},noncompliant[3].parents);const mismatch=projectExperimentRealization(p,noncompliant.slice(0,4),actorBinding());assert(mismatch.deviations.some(d=>d.code==="EXPOSURE_NONCOMPLIANCE"));return {stopped,extra,corrected,mismatch};});
  await challenge("no-hindsight-and-business-stop",{},"Knowledge clock filters late records; S4 business stop stays distinct from statistical and collection-limit stopping",async()=>{
    const p=(await designEnterpriseExperiments(ctx,{root,request:fixture(8,true)})).designs[0]!.protocol!;const cutoff=now();const later=new Date(Date.parse(cutoff)+1000).toISOString();const future=telemetry(p,"BUSINESS_STOP",{policyRef:ref("S4","policy"),reason:"Supplied S4 economic stop"},[],later);
    const past=projectExperimentRealization(p,[future],{...actorBinding(),now:cutoff});assert.equal(past.history.length,0);const present=projectExperimentRealization(p,[future],{...actorBinding(),now:later});assert.equal(present.collectionDisposition,"BUSINESS_STOP");assert.equal(present.analysis.statisticalStop,"CONTINUE");return {past,present};});
  await challenge("supplied-s6-reconciliation",{},"Typed S6 reference readback resolves an unknown without replaying its attempt or inventing protected settlement",async()=>{
    const p=(await designEnterpriseExperiments(ctx,{root,request:fixture(8,true)})).designs[0]!.protocol!;const events=sampleEvents(p,0).slice(0,2);const unknown=projectExperimentRealization(p,events,actorBinding());assert.equal(unknown.collectionDisposition,"RECONCILE_UNKNOWN");
    const recon=telemetry(p,"RECONCILIATION",{unknownEventId:events[1]!.id,resolution:"NO_EXPOSURE",resolvedExposureId:null,evidenceRef:ref("S6","supplied-independent-readback"),reason:"Reference S6 observed no exposure"},[events[1]!.id]);
    const resolved=resumeExperimentRealization(p,unknown,[recon],actorBinding());assert.equal(resolved.unknownOutcomes.length,0);assert.equal(resolved.attempts.length,1);assert.equal(resolved.analyzableSample.length,0);assert.equal(resolved.failures.length,1);assert.equal(resolved.analysis.valid,false);assert.equal(resolved.admission.receipt,null);return {unknown,resolved};});
  await challenge("duplicate-correction-noncompliance",{},"Duplicates cannot increase sample/error budget; corrections/deviations retain original design and history",async()=>{
    const events=sampleEvents(protocol,0);const r=projectExperimentRealization(protocol,[...events,...events],actorBinding());assert.equal(r.analyzableSample.length,1);assert.equal(r.history.length,events.length);
    const duplicate=sampleEvents(protocol,1);duplicate[4]=telemetry(protocol,"OBSERVATION",{...duplicate[4].data,originId:"origin-0"},duplicate[4].parents);duplicate[5]=telemetry(protocol,"VERIFICATION",{...duplicate[5].data,observationId:duplicate[4].id},[duplicate[4].id]);
    const dup=projectExperimentRealization(protocol,[...events,...duplicate],actorBinding());assert(dup.deviations.some((d:any)=>d.code==="DUPLICATE_ORIGIN"));assert.equal(dup.analysis.valid,false);
    const missing=sampleEvents(protocol,2);missing[4]=telemetry(protocol,"OBSERVATION",{...missing[4].data,category:null,status:"CENSORED"},missing[4].parents);const censored=projectExperimentRealization(protocol,[...events,...missing.slice(0,5)],actorBinding());assert.equal(censored.censored.length,1);assert.equal(censored.analysis.valid,false);
    return {deduplicated:r,duplicateOrigin:dup,censored};});
  await challenge("cost-corrections-and-overrun",{},"Actual money/effort/data/compute distinct; supersession counted once; overruns/dependency unknown halt",async()=>{
    const c1=telemetry(protocol,"COST",{itemId:"invoice",dimension:"money",amount:"1",unit:"USD",supersedes:null});const c2=telemetry(protocol,"COST",{itemId:"invoice",dimension:"money",amount:"2",unit:"USD",supersedes:c1.id},[c1.id]);const unknown=telemetry(protocol,"COST",{itemId:"human",dimension:"humanSeconds",amount:null,unit:"seconds",supersedes:null});
    const r=projectExperimentRealization(protocol,[c1,c2,c2,unknown],actorBinding());assert.equal(r.actualCosts.find((q:any)=>q.dimension==="money")!.amount,"2");assert.equal(r.actualCosts.find((q:any)=>q.dimension==="humanSeconds")!.amount,null);assert(r.deviations.some((d:any)=>d.code==="MONEY_LIMIT_EXCEEDED"));return r;});
  await challenge("stale-expired-revoked",{},"Current read-only source witnesses checked; expired and changed rights cannot yield authority",async()=>{
    const current=await validateEnterpriseExperiment(ctx,protocol);assert.equal(current.status,"CURRENT");assert.equal(current.executionAuthorityGranted,false);
    const expired=JSON.parse(JSON.stringify(protocol));expired.validUntil="2000-01-01T00:00:00.000Z";const e=await api("validate",{protocol:expired});assert(e.status>=400);
    await admin!.query("UPDATE finnor_os.users SET status='suspended' WHERE id=$1",[actor]);const revoked=await validateEnterpriseExperiment(ctx,protocol);assert.notEqual(revoked.status,"CURRENT");await admin!.query("UPDATE finnor_os.users SET status='active' WHERE id=$1",[actor]);return {current,revoked};});
  await challenge("heldout-calibration-and-misspecification",{seed:20261001,episodes:2000,tolerance:0.06},"Held-out generated laws match conditional predictions; misspecified law visibly fails calibration",async()=>{
    let seed=20261001;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};const summary=[];
    for(const sequential of[false,true])for(const n of[1,4,8]){const request=fixture(n,sequential);request.candidates=request.candidates.slice(0,1);const p=(await designEnterpriseExperiments(ctx,{root,request})).designs[0]!.protocol!;
      const probabilities=[0.2,0.8];let totalLoss=0;for(let h=0;h<2;h++){let reject0=0,reject1=0,loss=0;for(let episode=0;episode<2000;episode++){let ratio=1,ones=0,size=0,stop="SAMPLE_LIMIT";for(size=1;size<=n;size++){const y=random()<probabilities[h]!;if(y)ones++;ratio*=y?4:0.25;if((sequential||size===n)&&ratio>=20){stop="REJECT_H0";break;}if((sequential||size===n)&&ratio<=0.05){stop="REJECT_H1";break;}}if(stop==="REJECT_H0")reject0++;if(stop==="REJECT_H1")reject1++;const action=ones>(Math.min(size,n)/2)?1:0;if(action!==h)loss++;}
        const r0=Number(p.metrics.rejectH0ByHypothesis[h]!.display),r1=Number(p.metrics.rejectH1ByHypothesis[h]!.display);assert(Math.abs(reject0/2000-r0)<=0.06);assert(Math.abs(reject1/2000-r1)<=0.06);totalLoss+=loss;summary.push({sequential,n,h,reject0,reject1,loss,expectedReject0:r0,expectedReject1:r1});}assert(Math.abs(totalLoss/4000-Number(p.metrics.terminalRisk.display))<=0.06);}
    const r=fixture(8);r.candidates=r.candidates.slice(0,1);const p=(await designEnterpriseExperiments(ctx,{root,request:r})).designs[0]!.protocol!;let misspecReject=0;for(let i=0;i<2000;i++){let ratio=1;for(let j=0;j<8;j++)ratio*=random()<0.9?4:0.25;if(ratio>=20)misspecReject++;}const gap=Math.abs(misspecReject/2000-Number(p.metrics.rejectH0ByHypothesis[0]!.display));assert(gap>0.06);return {summary,misspecified:{actualPositiveProbability:0.9,declaredH0PositiveProbability:0.2,observedRejectRate:misspecReject/2000,gap,conclusion:"Model-conditional numeric correctness does not establish field calibration"}};});
  await challenge("cold-warm-adverse-compute",{n:24,k:3,budgetMs:5000,rss:268435456},"Registered largest/adverse requests bounded; actual route/runtime/usage recorded",async()=>{
    for(const mode of["cold","warm","adverse"]){const r=fixture(24,true);r.candidates=r.candidates.slice(0,1);r.candidates[0].endpoint.categories=["a","b","c"];r.candidates[0].likelihood.probabilities=mode==="adverse"?[["0.000001","0.999998","0.000001"],["0.000001","0.000001","0.999998"]]:[["0.7","0.2","0.1"],["0.1","0.2","0.7"]];
      const times=[];let last:any;const before=process.memoryUsage().rss;let peak=before;for(let i=0;i<6;i++){if(mode==="cold")await closePool();const t=performance.now();last=await designEnterpriseExperiments(ctx,{root,request:r});times.push(performance.now()-t);peak=Math.max(peak,process.memoryUsage().rss);}const sorted=[...times].sort((a,b)=>a-b),p95=sorted[Math.ceil(sorted.length*0.95)-1]!;const measured={mode,timesMs:times,p95Ms:p95,sampledIncrementalRss:Math.max(0,peak-before),compute:last.compute};workloads.push(measured);assert(p95<=5000);assert(measured.sampledIncrementalRss<=268435456);assert.equal(last.compute.actualRoute,"LOCAL_EXACT_FINITE");assert.equal(last.compute.model,null);assert.equal(last.compute.cost.money,null);}return workloads;});
  await challenge("fresh-process-cold-compute",{runs:6,n:24,k:3,budgetMs:5000},"Fresh process startup plus exact design meets declared deadline; process and backend usage preserved separately",async()=>{
    const request=fixture(24,true);request.candidates=request.candidates.slice(0,1);request.candidates[0].endpoint.categories=["a","b","c"];request.candidates[0].likelihood.probabilities=[["0.7","0.2","0.1"],["0.1","0.2","0.7"]];
    const captured=await loadEnterpriseBeliefView(ctx,{root}),input=join(output,"cold-input.json");await writeFile(input,JSON.stringify({beliefView:captured,request}));const runs=[];
    for(let i=0;i<6;i++){const t=performance.now();const result=spawnSync(resolve(repo,"finnor-os/node_modules/.bin/tsx"),[resolve(repo,"finnor-os/scripts/s2/run-s2-cold.mts"),input],{encoding:"utf8",env:process.env,maxBuffer:1024*1024,timeout:10000});assert.equal(result.status,0,result.stderr);const elapsed=performance.now()-t;assert(elapsed<=5000);runs.push({elapsedIncludingStartupMs:elapsed,result:JSON.parse(result.stdout)});}
    workloads.push({mode:"fresh-process-cold",runs,p95Ms:Math.max(...runs.map(r=>r.elapsedIncludingStartupMs))});return runs;});
  await challenge("no-effects-or-ledger-substitute",{},"Collection handoff is typed and blocked; no effect/receipt/ledger append exposed",async()=>{
    const r=projectExperimentRealization(protocol,[],actorBinding());const h=prepareExperimentCollectionHandoff(protocol,r,actorBinding());assert.equal(h.status,"BLOCKED_EXTERNAL");assert.equal(h.executionAuthorityGranted,false);assert.equal(h.receipt,null);
    const append=await api("append",{protocol});assert.equal(append.status,404);const execute=await api("collect",{protocol});assert.equal(execute.status,404);
    const counts=await withTenantTransaction(tenant,{userId:actor,readOnly:true},(_db,c)=>c.query("SELECT (SELECT count(*) FROM finnor_os.business_effects WHERE tenant_id=$1)::int effects,(SELECT count(*) FROM finnor_os.decision_receipts WHERE tenant_id=$1)::int receipts",[tenant]));assert.equal(counts.rows[0].effects,0);assert.equal(counts.rows[0].receipts,0);return {handoff:h,counts:counts.rows[0],missingOwners:["S4 closed-loop inquiry selection","S5 commitments","S6 protected ledger/collection","S7 attribution"]};});
  await challenge("real-source-revision-invalidation",{},"Actual canonical owner revision invalidates S2's earlier S1 dependency witness; old protocol remains immutable",async()=>{
    const p=(await designEnterpriseExperiments(ctx,{root,request:fixture()})).designs[0]!.protocol!,before=JSON.stringify(p);assert.equal((await validateEnterpriseExperiment(ctx,p)).status,"CURRENT");
    const marker=await createMetricSeries(ctx,{subjectType:"external_organization",subjectId:company,metricKey:"s2-revision-marker",name:"S2 fixture source change",unit:"count",frequency:"monthly"});
    const invalid=await validateEnterpriseExperiment(ctx,p);assert.equal(invalid.status,"INVALIDATED");assert.equal(invalid.executionAuthorityGranted,false);assert(invalid.experience);assert.equal(JSON.stringify(p),before);return {fixtureOwnerRevision:marker,invalid};});
}catch(e){cases.push({id:"setup-or-unhandled",input:{},expected:"All challenges execute, no hidden skip",status:"FAIL",observed:e instanceof Error?{message:e.message,stack:e.stack}:String(e)});}finally{await save();await closePool().catch(()=>undefined);await admin?.end().catch(()=>undefined);await postgres.stop().catch(()=>undefined);await rm(directory,{recursive:true,force:true});}
console.log(JSON.stringify({output,passed:cases.filter(c=>c.status==="PASS").length,failed:cases.filter(c=>c.status==="FAIL").length}));if(cases.some(c=>c.status==="FAIL"))process.exit(1);

/** Real S1 records -> exact S3 -> S4 baseline -> issued S5 grant -> original P1.
 * All values are predeclared hypothetical inputs; none qualifies economics. */
import {strict as assert} from 'node:assert';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {configureTenantVertical,receiveWork} from '@finnor/db';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {createMetricSeries,recordMetricObservation,loadEnterpriseBeliefView} from '@finnor/private-equity';
import {epistemicHash} from '@finnor/epistemic-runtime';
import {createUpstreamFixtureSupport} from '../s5/owner-fixture.mts';
import {finiteFixture,rational,reference} from './fixtures.mts';
export const ok=(r:any,status=200)=>{assert.equal(r.status,status,JSON.stringify(r));return r.body;};
export async function prepareR1Owners(e:any,options:{upper?:boolean;grantAttempts?:number;name?:string;deadlineMs?:number;tail?:boolean;identity?:any;work?:any;zeroReduction?:boolean;thread?:boolean;modifyModel?:(model:any)=>void;beforeSource?:(fixture:any)=>Promise<void>;programDeadlineMs?:number;periodMs?:number}={}){
 const model=finiteFixture(options.name??'r1-owner-'+randomUUID(),options.upper?12:3,options.upper?8:4,options.upper);
 const f:any={name:model.id,tenant:options.identity?.tenant??model.tenantId,principal:options.identity?.principal??model.principalId,root:options.identity?.root??model.root,policies:[],labels:{},resources:[],model};
 model.tenantId=f.tenant;model.principalId=f.principal;model.root=f.root;
 const email=f.principal+'@r1.example.test',ctx=f.ctx={auth:{tenantId:f.tenant,userId:f.principal,employeeId:f.principal,role:'owner'},provenance:{sourceSystem:'R1:disposable-e2e',createdBy:f.principal}};
 const dir=join(e.evidence,f.name);await mkdir(dir,{recursive:true});const artifact=async(name:string,value:unknown)=>writeFile(join(dir,name),JSON.stringify(value,null,2)+'\n');
 if(!options.identity){
  await e.admin.query("INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,$3)",[f.tenant,randomUUID(),f.name]);
  await e.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status,display_name) VALUES($1,$2,$3,'owner','active','R1 disposable')",[f.principal,f.tenant,email]);
  await e.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$3,'other')",[f.root.entityId,f.tenant,f.name]);
  await configureTenantVertical({tenantId:f.tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:f.principal,sourceSystem:'R1:disposable-e2e'});
  await (await import('../../packages/orchestration/src/workforce-runtime')).configureAgentProfile(f.tenant,(await import('../../packages/orchestration/src/plugin-registry')).createDefaultPluginRegistry(),{key:'r1-native',name:'Disposable actual native query executor',actor:ctx.auth,capabilityGrants:[{kind:'query',capability:'query:harness_program_v1'},{kind:'check',capability:'check:objective_success'},{kind:'wait',capability:'wait:event'}],autonomyLimits:{maxActions:1,maxQueries:8,maxReplans:6,maxPlannerCalls:8,maxWallClockMs:3600000}});
  const source=await createEvidenceSource(f.tenant,{sourceKey:f.name,sourceType:'manual',title:'Predeclared hypothetical exact model and analytical values'});
  const version=await appendEvidenceVersion(f.tenant,source.id,{content:'Hypothetical exact table; equally lawful choices yield seven model USD, original action capital is one third USD. EV120 debt70 liability7 EBITDA20. No field calibration.',snapshot:{qualification:'PREDECLARED_HYPOTHETICAL_INPUT_NOT_BUSINESS_TRUTH',input:{EV:'120',debt:'70',liability:'7',EBITDA:'20'}},asOf:new Date('2025-01-01T00:00:00Z')});
  f.evidence={evidenceSourceId:source.id,evidenceVersionId:version.versionId};f.observations={};
  for(const [key,value] of Object.entries({EV:'120',debt:'70',liability:'7',EBITDA:'20'})){const series=await createMetricSeries(ctx,{subjectType:f.root.entityType,subjectId:f.root.entityId,metricKey:key,name:key,unit:'currency',currencyCode:'USD',frequency:'annual'});f.observations[key]=await recordMetricObservation(ctx,{metricSeriesId:String(series.row.id),periodStart:new Date('2025-01-01T00:00:00Z'),periodEnd:new Date('2025-12-31T00:00:00Z'),value:{type:'number',value},evidence:f.evidence});}
 }else {f.evidence=options.identity.evidence;f.observations=options.identity.observations;}
 e.http.register(f.principal,email);f.token=await e.http.login(f.principal);
 const instruction='Produce a source-cited analytical draft of equity after all recorded debt and liability, and leverage. No execution or IC approval.';
 f.work=options.work??await receiveWork({tenantId:f.tenant,userId:f.principal,instruction,channel:'console',idempotencyKey:randomUUID()});
 if(options.thread)f.thread=await (await import('@finnor/db')).createEmployeeConversationThread({tenantId:f.tenant,ownerEmployeeId:f.principal,title:'R1 original owner-bound Work'});
 const now=new Date(Date.now()-1).toISOString(),h=model.horizon.periods,attempts=options.grantAttempts??8;
 model.horizon={startAt:new Date(Date.now()-1000).toISOString(),periodMs:options.periodMs??60000,periods:h};
 // The chosen history differs from the reducer's first state/member ordering.
 // This exposes a leaked representative history at the real later branch API.
 [model.actions[0],model.actions[1]]=[model.actions[1],model.actions[0]];
 model.states[0].transitions.sort((a:any,b:any)=>model.actions.findIndex((x:any)=>x.id===a.actionId)-model.actions.findIndex((x:any)=>x.id===b.actionId));
 model.units.resources.compute='native-attempt';
 const body={schema:'finnor.economic-mandate.v1',tenantId:f.tenant,principalId:f.principal,episodeId:f.name,knowledgeAt:now,validUntil:new Date(Date.now()+3600000).toISOString(),businessOwnerRef:reference(f.principal,'BUSINESS_OWNER'),rightsRef:model.rightsRef,utilityRef:reference(f.name+':utility','BUSINESS_OWNER'),horizon:model.horizon,utility:{unit:'USD',accountingConventionRef:reference(f.name+':complete-cash-discount','BUSINESS_OWNER'),periodTerms:[],discountFactors:Array(h+1).fill(1),terminalTerms:[],tail:{status:'SUPPLIED_COMPLETE_FINITE_HORIZON',terminalLiability:0,ref:reference(f.name+':tail','BUSINESS_OWNER')}},risk:{kind:'HARD_WORST_PATH_UTILITY_FLOOR',minimumUtility:-100000},ambiguity:{kind:'ROBUST_FIXED_JOINT_SCENARIOS',authorizationRef:reference(f.name+':fixed-worlds','BUSINESS_OWNER')},resources:{dimensions:[{id:'capital',unit:'USD',capacity:100000,totalLimit:100000,resourceClass:'CASH'},{id:'compute',unit:'native-attempt',capacity:attempts,totalLimit:attempts,resourceClass:'COMPUTE'}],couplings:[]},search:{maxExpansions:50000,deadlineMs:options.deadlineMs??30000,maxWorlds:512,maxPolicyNodes:50000,maxHumanSeconds:900},scoring:{normalization:100,maxRegret:.05},authorization:{basis:'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED',protectedReceipt:null}};
 f.mandate={...body,ref:{owner:'BUSINESS_OWNER',id:'mandate:'+epistemicHash(body),version:'economic-mandate-v1',contentDigest:epistemicHash(body)}};
 model.mandateRef=f.mandate.ref;model.units.money={currency:'USD',unit:'USD',valuationAt:now,ownerShare:rational(1),timeBasis:'DECLARED_FINITE_PERIODS',discountConventionRef:body.utility.accountingConventionRef,qualification:'SUPPLIED_OWNER_ASSERTION_UNADMITTED'};
 for(const a of model.actions){const active=a.kind==='INTERVENE';a.resources={capital:active?rational(1,3):rational(0),compute:rational(active?attempts:0)};a.occupancy.compute=rational(0);if(options.tail&&active){a.cost=rational(2);a.tailLiability=rational(3);}}
 for(const s of model.states){const active=s.history[0]?.startsWith('choice');s.semantics.resources.capacity.compute=rational(attempts);s.semantics.resources.totalLimit.compute=rational(attempts);s.semantics.resources.used={capital:active?rational(1,3):rational(0),compute:rational(active?attempts:0)};s.semantics.resources.reserved.compute=rational(0);s.semantics.resources.occupancy.compute=Array.from({length:h+1},()=>rational(0));
  for(const w of s.worlds){const u=s.semantics.resources.worldUse[w];u.used={capital:active?rational(1,3):rational(0),compute:rational(active?attempts:0)};u.occupancy.compute=Array.from({length:h+1},()=>rational(0));if(options.tail&&active){s.semantics.terminalLiabilities[w]=rational(3);s.semantics.accruedUtility[w]=rational(s.period===h?7:10);}}
  for(const t of s.transitions){const a=model.actions.find((a:any)=>a.id===t.actionId);for(const o of t.outcomes){o.resourceDelta=a.resources;o.occupancyDelta.compute=Array.from({length:h+1},()=>rational(0));if(options.tail&&a.kind==='INTERVENE'){o.grossUtility=rational(12);o.immediateUtility=rational(10);}}}
 }
 if(options.zeroReduction)for(const s of model.states)if(s.history.length)s.semantics.maturity=[{id:'original-commitment-'+s.history[0],duePeriod:h,amount:rational(1),unit:'USD'}];
 options.modifyModel?.(model);await options.beforeSource?.(f);
 const view=await loadEnterpriseBeliefView(ctx,{root:f.root});
 model.sourceRefs=view.claims.filter((c:any)=>c.kind==='SOURCE_ASSERTION').map((c:any)=>({owner:c.ownerRef.owner,id:c.ownerRef.id,version:c.ownerRef.revisionId,contentDigest:c.ownerRef.contentDigest}));
 assert(model.sourceRefs.length>0,'Actual authorized S1 source assertion required');
 const sourceInput={workId:f.work.workId,workRevision:f.work.workInputId,modelBytes:JSON.stringify(model),mandate:f.mandate};
 f.source=ok(await e.http.api(f.token,'interventions','exact-control-model',sourceInput));f.model={ref:f.source.sourceRef};
 const baseline=ok(await e.http.api(f.token,'policies','synthesize-exact',{sourceRef:f.source.sourceRef}));assert.equal(baseline.status,'POLICY_AVAILABLE',JSON.stringify(baseline));f.baseline=baseline.policy;f.policies=[baseline.policy];f.labels[baseline.policy.ref.id]='baseline';
 const support=createUpstreamFixtureSupport({admin:()=>e.admin,generatedRows:[],begin:now,day:30000,fixtures:{},api:(g:any,op:string,b:any)=>e.http.api(g.token,'allocations',op,b),artifact});
 if(!f.resources.some((r:any)=>r.resourceId==='capital'))await support.resource(f,'capital','USD','STOCK',Array(h+1).fill(options.tail?'5':'2'));
 if(!f.resources.some((r:any)=>r.resourceId==='compute'))await support.resource(f,'compute','native-attempt','CUMULATIVE_EXPENDITURE',Array(h+1).fill(String(2*attempts)));
 const clearing=support.clearing(f,{baseline:['7']});if(options.tail)clearing.funding=[{policyRef:f.baseline.ref,actionCostResourceId:'capital',terminalLiabilityResourceId:'capital',humanSecondsResourceId:null}];
 f.allocation=ok(await e.http.api(f.token,'allocations','clear',clearing));await artifact('initial-clearing.json',{clearing,allocation:f.allocation});
 if(options.tail)return {...f,originalModel:model,support,artifact,dir};
 assert.equal(f.allocation.status,'FEASIBLE',JSON.stringify(f.allocation));assert(f.allocation.certificate&&f.allocation.reservation);
 const descriptor=(key:string)=>({kind:'metric',subject:f.root,metricKey:key,periodStart:'2025-01-01T00:00:00.000Z',periodEnd:'2025-12-31T00:00:00.000Z',unit:'currency',currencyCode:'USD',frequency:'annual',calendar:'OWNER_RECORDED',consolidation:'OWNER_SUBJECT_ONLY',instrument:'UNSPECIFIED',scale:'1',sign:'AS_RECORDED'});
 const input=(key:string)=>({kind:'input',key}),sub=(left:any,right:any)=>({kind:'subtract',left,right});
 f.programRequest={schema:'finnor.harness-request.v1',instruction,root:f.root,validAt:now,mode:'ordinary_disposable',computeSearch:'P2_REQUIRED',workId:f.work.workId,workInputId:f.work.workInputId,idempotencyKey:randomUUID(),sources:['EV','debt','liability','EBITDA'].map(key=>({key,source:descriptor(key)})),acceptance:{requiredSourceKeys:['EV','debt','liability','EBITDA'],targets:[{key:'netEquity',expression:sub(sub(input('EV'),input('debt')),input('liability')),unit:'currency',currencyCode:'USD'},{key:'leverage',expression:{kind:'ratio',left:input('debt'),right:input('EBITDA')},unit:'multiple',currencyCode:null}],deliverable:{kind:'analytical_draft',title:'Original liability complete draft'}},ownerBindings:{policyRef:f.baseline.ref,allocationRef:f.allocation.certificate.ref},limits:{maxCandidates:8,maxAttempts:8,maxSteps:4096,deadlineMs:options.programDeadlineMs??300000}};
 if(f.thread)f.programRequest.threadId=f.thread.id;
 const programResponse=await e.http.api(f.token,'company-brain','program-submit',f.programRequest);
 if(programResponse.status!==202){
  // Retain a private diagnostic from the same actual owner and idempotency
  // request. This never substitutes for the failed HTTP proof or supplies a
  // grant, receipt, programme row or expected answer.
  try{const ownerDiagnostic=await (await import('../../packages/private-equity/src/program-synthesis/api')).submitHarnessProgram(ctx,f.programRequest);await artifact('p1-owner-diagnostic.json',{programResponse,ownerDiagnostic,qualification:'DIAGNOSTIC_ONLY_HTTP_PROOF_REMAINS_FAILED'});}
  catch(error){await artifact('p1-owner-diagnostic.json',{programResponse,error:String(error),stack:(error as Error).stack,cause:String((error as any).cause),qualification:'DIAGNOSTIC_ONLY_HTTP_PROOF_REMAINS_FAILED'});}
 }
 f.program=ok(programResponse,202);
 f.runRequest={schema:'finnor.r1.run.v1',problem_ref:f.source.sourceRef,envelope_inputs:{programId:f.program.programId,policyRequest:f.baseline.ref,maxMathSteps:4000000},work_rev:f.program.workRevision,domain:'finite-information-rational-v1',grant:f.allocation.certificate.ref,cancel:false,idempotencyKey:randomUUID()};
 await artifact('owner-inputs-and-issued-records.json',{sourceInput,source:f.source,baseline,clearing,allocation:f.allocation,programRequest:f.programRequest,program:f.program,runRequest:f.runRequest,qualification:e.http.qualification});
 return {...f,originalModel:model,support,artifact,dir};
}

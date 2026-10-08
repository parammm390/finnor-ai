/** Prospective construction contracts at real owners, API, queue and store.
 * Registered in continuation-contracts.md before the corresponding repairs.
 * Reference values come from a separate Fraction interpreter, never M3. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {receiveWork,withTenantTransaction} from '@finnor/db';
import {createDeal,createInvestmentCase,createAssumption,createUnderwritingModel,createUnderwritingModelVersion,createMetricSeries,
 attachCanonicalEvidenceToWorld,recordMetricObservation,restateMetricObservation,loadPrivateEquityWorldState} from '@finnor/private-equity';
import {UNDERWRITING_ENGINE_VERSION,FINANCIAL_CONVENTION_VERSION} from '@finnor/underwriting';
import {readEnterpriseControlDecisionContext} from '../../packages/private-equity/src/enterprise-control';
import {checkDecisionProjection} from '../../packages/private-equity/src/decision-slice/checker';
import {epistemicHash} from '../../packages/epistemic-runtime/src/source-precedence';
import {POST as s3Post} from '../../apps/api/app/api/interventions/[operation]/route';
import {POST as s4Post} from '../../apps/api/app/api/policies/[operation]/route';
import {POST as s5Post} from '../../apps/api/app/api/allocations/[operation]/route';

export async function ownerConstructionContracts(e:any){
 const {challenge,support,api,ok,submit,request,reference,fraction,artifact,repo,admin,businessRows,queue,drain}=e;
 const ref=(id:string,owner='SUPPLIED')=>({owner,id,version:'fixture-v1',contentDigest:createHash('sha256').update(id).digest('hex')});
 const seal=(owner:string,prefix:string,body:any,version:string)=>{
  // Owner wire commitment, not a candidate value oracle.
  const stable=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':
   '{'+Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+stable(x)).join(',')+'}';
  const digest=createHash('sha256').update(stable(body)).digest('hex');return {owner,id:`${prefix}:${digest}`,version,contentDigest:digest};
 };
 async function work(f:any,instruction:string){
  f.workId=(await receiveWork({tenantId:f.tenant,userId:f.principal,instruction,channel:'console',idempotencyKey:randomUUID()})).workId;
 }
 async function compare(f:any,candidate:any,directory:string){
  const context=await readEnterpriseControlDecisionContext(f.ctx,candidate.policyRef);
  const oracle=reference({operation:'policy',problem:context.policy.problem,mandate:context.policy.mandate,
   model:context.model,kernel:context.kernel,protocols:context.protocols});
  assert(oracle.value!==null);assert(Math.abs(candidate.valueBounds[0]-fraction(oracle.value))<=1e-8);
  await artifact(`${directory}/${candidate.semanticDigest}.json`,{context,oracle,candidate});return context;
 }
 await challenge('core-work-link-temporal-owner','Core Work root relationships retain exact current and committed historical versions, cannot promote a pre-baseline cut, and permit a real S3 refit without ignoring coverage',async()=>{
  const f=await support.fixture('m3-core-work-history',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]),
   before=await loadPrivateEquityWorldState(f.ctx,f.root);
  const received=await receiveWork({tenantId:f.tenant,userId:f.principal,instruction:'Retain this canonical root relationship',
   channel:'console',idempotencyKey:randomUUID(),activeContext:{entityRefs:[f.root]}});
  const attached=await loadPrivateEquityWorldState(f.ctx,f.root);
  await artifact('core-work-history/attachment.json',{before,received,attached});
  assert.equal(attached.temporalCompleteness.status,'complete','An actual Work attachment must have complete retained canonical history');
  const link=attached.workLinks.find((row:any)=>row.workId===received.workId&&row.entityId===f.root.entityId);assert(link);
  const historicalBefore=await loadPrivateEquityWorldState(f.ctx,f.root,{knowledgeAt:before.knowledgeAt});
  assert(!historicalBefore.workLinks.some((row:any)=>row.workId===received.workId),'A later commit cannot appear at an earlier knowledge cut');
  const refitted=ok(await api(f,'fit',{request:f.model.request},s3Post));assert.equal(refitted.status,'FITTED');
  await withTenantTransaction(f.tenant,{userId:f.principal},(_db,c)=>c.query(
   "UPDATE finnor_os.work_entity_links SET source='recorded-owner-revision' WHERE tenant_id=$1 AND id=$2",[f.tenant,link.id]));
  const revised=await loadPrivateEquityWorldState(f.ctx,f.root),
   historicalAttached=await loadPrivateEquityWorldState(f.ctx,f.root,{knowledgeAt:attached.knowledgeAt});
  assert.equal(revised.workLinks.find((row:any)=>row.id===link.id)?.source,'recorded-owner-revision');
  assert.equal(historicalAttached.workLinks.find((row:any)=>row.id===link.id)?.source,'work_intake.active_context');
  // A controlled owning-SQL deletion is an explicit fault, not a mocked reader.
  await admin.query('DELETE FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND id=$2',[f.tenant,link.id]);
  const removed=await loadPrivateEquityWorldState(f.ctx,f.root),
   historicalRevised=await loadPrivateEquityWorldState(f.ctx,f.root,{knowledgeAt:revised.knowledgeAt});
  assert(!removed.workLinks.some((row:any)=>row.id===link.id));
  assert.equal(historicalRevised.workLinks.find((row:any)=>row.id===link.id)?.source,'recorded-owner-revision');
  await assert.rejects(withTenantTransaction(f.tenant,{userId:f.principal},(_db,c)=>c.query(
   "UPDATE finnor_os.canonical_entity_versions SET snapshot='{}'::jsonb WHERE tenant_id=$1 AND entity_type='work_entity_link'",[f.tenant])));
  const coverage=(await admin.query("SELECT coverage_started_at FROM finnor_os.canonical_history_coverage WHERE entity_type='work_entity_link'")).rows[0];assert(coverage);
  let unavailable:any;
  try{
   await admin.query("UPDATE finnor_os.canonical_history_coverage SET coverage_started_at=clock_timestamp()+interval '1 hour' WHERE entity_type='work_entity_link'");
   unavailable=await loadPrivateEquityWorldState(f.ctx,f.root);assert.equal(unavailable.temporalCompleteness.status,'partial');
   assert(unavailable.temporalCompleteness.reasons.some((reason:string)=>/Work.*history|history.*Work/i.test(reason)));
  }finally{await admin.query("UPDATE finnor_os.canonical_history_coverage SET coverage_started_at=$1 WHERE entity_type='work_entity_link'",[coverage.coverage_started_at]);}
  const versions=(await admin.query("SELECT entity_version,snapshot,snapshot_hash,recorded_at,previous_version_id FROM finnor_os.canonical_entity_versions WHERE tenant_id=$1 AND entity_type='work_entity_link' AND entity_id=$2 ORDER BY entity_version",[f.tenant,link.id])).rows;
  assert.equal(versions.length,3);
  await artifact('core-work-history/complete.json',{before,received,attached,historicalBefore,refitted,revised,historicalAttached,removed,historicalRevised,unavailable,versions,
   faults:['Recorded Core source update','Owning SQL relationship deletion','Denied application history rewrite','Temporary future coverage boundary, restored']});
  return {workId:received.workId,linkId:link.id,versions:versions.length,qualification:'EXACT_CORE_RELATIONSHIP_HISTORY_NOT_GLOBAL_PROVIDER_OR_LEGAL_COMPLETENESS'};
 });
 await challenge('lawful-observable-stage','Generated second commitment is token/history gated by the real S4 constructor, never hidden worlds or late milestones; emitted bytes and complete reference agree',async()=>{
  const f=await support.fixture('m3-observable',3,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]);
  const base=await support.policy(f,'observable-base',{cash:25}),problem=structuredClone(base.problem);
  const instrument={schema:'finnor.s2.control-observation.v1',id:'received-public-outcome',sourceRef:ref('registered-public-outcome-bins','S2'),
   variableId:'outcome',unit:'normalized-value',delayPeriods:1,afterActionIds:['programme-observable-base'],
   bins:[{category:'LOW',lowerInclusive:-6,upperExclusive:0.15},{category:'HIGH',lowerInclusive:0.15,upperExclusive:6}],
   qualification:'SUPPLIED_DETERMINISTIC_COARSENING_UNVERIFIED'};
  problem.observations=[instrument];
  const incumbent=ok(await api(f,'replan',{mandate:f.mandate,problem,protocols:[],scenarios:{pathsPerMechanism:4,seed:20261002},
   priorPolicyRef:base.ref,reason:'Preregistered lawful public temporal observation'},s4Post)).policy;
  assert(incumbent);await support.resource(f,'cash','USD','STOCK',['200','200','200','200']);
  await work(f,'Construct an observable two-commitment proposal, with no live payment authority');
  const permitted={...request.permitted,actionId:'programme-observable-base',terms:['0.3'],structures:['OBSERVABLE_STAGE'],stageFractions:['0.5'],
   milestone:{instrumentId:instrument.id,tokens:['HIGH']}};
  const before=await businessRows(f),trial=await submit({workId:f.workId,incumbentPolicyRef:incumbent.ref,permitted},f);
  const candidate=trial.result.program?.candidates.find((c:any)=>c.structure==='OBSERVABLE_STAGE'&&c.policyRef);
  assert(candidate,'A lawful observable composition must be executed, not retained as a missing-primitive placeholder');
  assert.equal(candidate.moduleExecution.termination,'EXITED');
  const context=await compare(f,candidate,'observable-reference');
  const release=context.policy.problem.actions.find((a:any)=>a.id!==permitted.actionId&&a.precondition);
  assert(release?.precondition);assert(release.precondition.afterActionIds.includes(permitted.actionId));
  assert.deepEqual(release.precondition.observations,[{instrumentId:instrument.id,tokens:['HIGH']}]);
  const releases=context.policy.nodes.filter((n:any)=>n.actionId===release.id);assert(releases.length);
  for(const node of releases){
   assert(node.actionHistory.includes(permitted.actionId));
   assert(node.observations.some((o:any)=>o.instrumentId===instrument.id&&o.token==='HIGH'&&o.availablePeriod<=node.period));
  }
  const hostile=structuredClone(problem);hostile.actions[0].precondition={afterActionIds:[],observations:[{instrumentId:'hidden-world',tokens:['winner']}]};
  assert.equal((await api(f,'synthesize',{mandate:f.mandate,problem:hostile,protocols:[],scenarios:{pathsPerMechanism:4,seed:20261002}},s4Post)).status,400);
  const lateProblem=structuredClone(problem);lateProblem.observations[0].delayPeriods=3;
  const late=ok(await api(f,'replan',{mandate:f.mandate,problem:lateProblem,protocols:[],scenarios:{pathsPerMechanism:4,seed:20261002},
   priorPolicyRef:incumbent.ref,reason:'Registered late milestone cannot extend funding horizon'},s4Post)).policy;
  const delayed=await submit({workId:f.workId,incumbentPolicyRef:late.ref,permitted},f);
  assert(delayed.result.program?.candidates.some((c:any)=>c.structure==='OBSERVABLE_STAGE'&&c.blockers.some((b:any)=>b.code==='MILESTONE_MISSES_FUNDING_DEADLINE')));
  assert.deepEqual(await businessRows(f),before);
  return {trial,delayed,qualification:'MODEL_RELATIVE_LAWFUL_COARSENING_NOT_A_RECEIVED_LIVE_ACCEPTANCE_OR_CALIBRATED_SENSOR'};
 });
 await challenge('authentic-inquiry-composition','Actual current S2 protocol is executed before a new delayed commitment, with full cost and no implicit world probabilities; complete separate reference and pure S5 agree',async()=>{
  const f=await support.fixture('m3-inquiry',3,[{id:'cash',unit:'USD',capacity:200,totalLimit:200},
   {id:'exposure',unit:'sample-exposure',capacity:2,totalLimit:2,resourceClass:'INQUIRY_EXPOSURE'}]);
  const fitRequest=structuredClone(f.model.request);
  fitRequest.mechanisms.push({...structuredClone(fitRequest.mechanisms[0]),id:'second-supplied-mechanism',meaning:'Second separately registered response hypothesis'});
  f.model=ok(await api(f,'fit',{request:fitRequest},s3Post)).model;
  const original=await support.policy(f,'inquiry-base',{cash:25}),design=JSON.parse(await readFile(join(repo,'finnor-os/scripts/s3/instrument-design.json'),'utf8'));
  design.episodeId=f.mandate.episodeId;design.mandateRef=f.mandate.ref;design.validUntil=f.mandate.validUntil;
  design.decisionContext.utilityRef=f.mandate.utilityRef;design.decisionContext.lossUnit=f.mandate.utility.unit;
  design.decisionContext.horizonEnd=new Date(Date.parse(f.mandate.horizon.startAt)+3*f.mandate.horizon.periodMs).toISOString();
  design.decisionContext.actionIds=['programme-inquiry-base','wait','stop','inspect'];
  design.decisionContext.lossByHypothesis=[['0','1','1','1'],['1','0','1','1']];
  design.hypotheses=f.model.request.mechanisms.map((mechanism:any,index:number)=>{
   const r=seal('S3','mechanism',{modelRef:f.model.ref,mechanism},'s3-temporal-linear-v1');
   return {ref:r,prior:index===0?'0.25':'0.75',meaning:mechanism.meaning};
  });
  design.candidates=design.candidates.slice(0,1);
  const supplied=design.candidates[0];supplied.samples=1;supplied.timing={startAt:new Date().toISOString(),endAt:f.mandate.validUntil,minimumIntervalMs:0};
  supplied.costEstimate.money={value:'1',unit:'USD'};supplied.costEstimate.humanSeconds=0;supplied.exposure.unitsPerSample='1';
  supplied.exposure.privacyUnitsPerSample='0';supplied.likelihood.probabilities=[['1','0'],['0','1']];
  design.constraints.moneyLimit={value:'10',unit:'USD'};
  const designed=ok(await api(f,'design-experiment',{modelRef:f.model.ref,root:f.root,request:design},s3Post));
  const protocol=designed.bundle.designs[0].protocol;assert(protocol);
  const problem=structuredClone(original.problem),zeros={cash:0,exposure:1};
  problem.actions.push({id:'inspect',kind:'INQUIRE',cost:1,costUnit:'USD',resources:zeros,occupancy:{cash:0,exposure:0},occupationPeriods:1,
   tailLiability:0,earliestPeriod:0,lastPeriod:2,atMostOnce:true,exposures:{},
   protocolRef:{owner:'S2',id:protocol.id,version:protocol.version,contentDigest:protocol.contentDigest},informationDelayPeriods:1,humanSeconds:0});
  const incumbent=ok(await api(f,'replan',{mandate:f.mandate,problem,protocols:[protocol],scenarios:{pathsPerMechanism:4,seed:20261002},
   priorPolicyRef:original.ref,reason:'Registered real inquiry alternative'},s4Post)).policy;assert(incumbent);
  await support.resource(f,'cash','USD','STOCK',['200','200','200','200']);
  await support.resource(f,'exposure','sample-exposure','CUMULATIVE_EXPENDITURE',['2','2','2','2']);
  await work(f,'Insert an actual current inquiry before the new term');
  const trial=await submit({workId:f.workId,incumbentPolicyRef:incumbent.ref,permitted:{...request.permitted,actionId:'programme-inquiry-base',
   inquiryActionId:'inspect',terms:['0.3'],structures:['INQUIRY_OPTION'],stageFractions:[]}},f);
  const candidate=trial.result.program?.candidates.find((c:any)=>c.structure==='INQUIRY_OPTION'&&c.policyRef);
  assert(candidate,'Inquiry composition must survive actual module, owner and evidence execution');
  const context=await compare(f,candidate,'inquiry-reference');
  assert(context.policy.nodes.some((n:any)=>n.actionId==='inspect'));
  const commitments=context.policy.nodes.filter((n:any)=>n.actionId==='programme-inquiry-base');assert(commitments.length);
  for(const node of commitments){
   assert(node.actionHistory.includes('inspect'));assert(node.period>=1);
   assert(node.observations.some((o:any)=>o.instrumentId===protocol.id&&o.availablePeriod<=node.period));
  }
  assert(trial.result.program.allocation.problem,'Common complete inquiry paths must produce an actual pure S5 proposal');
  const allocation=reference({operation:'allocation',problem:trial.result.program.allocation.problem});
  for(const checked of trial.result.program.allocation.checks){
   const expected=allocation.subsets.find((row:any)=>JSON.stringify(row.selectedPolicyIds)===JSON.stringify([...checked.selectedPolicyIds].sort()));
   assert.equal(checked.feasible,expected.feasible);
  }
  return {trial,protocolRef:problem.actions.at(-1).protocolRef,allocation,qualification:'SUPPLIED_NONREACTIVE_CONDITIONAL_LAW_NOT_FIELD_CALIBRATION'};
 });
 await challenge('fresh-evidence-and-native-finance','An authentic owner-bound financing rate produces exact financial consequences and fresh M1 financial closure; wrong entity/unit and source correction refuse',async()=>{
  const f=await support.fixture('m3-financial',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]);
  const deal=await createDeal(f.ctx,{targetOrganizationId:f.root.entityId,name:'M3 exact financial term fixture',dealLeadEmployeeId:f.principal,
   signedLoiAt:new Date(Date.now()-86400000),targetClosingAt:new Date(Date.now()+86400000)});
  const investment=await createInvestmentCase(f.ctx,{dealId:String(deal.row.id),title:'Exact source-backed financing'});
  const caseId=String(investment.row.id),semantics={entityType:'external_organization',entityId:f.root.entityId,
   periodStart:f.model.request.time.endAt,periodEnd:new Date(Date.parse(f.model.request.time.endAt)+2*f.model.request.time.periodMs).toISOString(),
   unit:'rate',currencyCode:null,frequency:'instant',calendar:'OWNER_RECORDED',consolidation:'OWNER_SUBJECT_ONLY',instrument:'REGISTERED_FIXED_RATE',scale:'1',sign:'AS_RECORDED'};
  const inputs:any={};for(const [id,value,unit] of [['rate','0.15','rate'],['ev','120','money'],['principal','70','money'],['fees','0.01','money']]){
   inputs[id as string]=String((await createAssumption(f.ctx,{dealId:String(deal.row.id),investmentCaseId:caseId,assumptionKey:`m3-${id}`,
    statement:`Registered exact financial ${id}`,valueType:unit==='money'?'currency':'percent',value:Number(value),unit:unit as string,
    ...(unit==='money'?{currencyCode:'USD'}:{})})).row.id);
  }
  const node=(id:string,source:string,unit:string)=>({id,kind:'input',valueType:'decimal',shape:'scalar',unit,...(unit==='money'?{currency:'USD'}:{}),
   dependencies:[],required:true,source:{kind:'p1_assumption',assumptionId:inputs[source]},...(unit==='rate'?{evidenceSemantics:semantics}:{})});
  const expression=(id:string,op:string,args:string[])=>({id,kind:'expression',valueType:'decimal',shape:'scalar',unit:'money',currency:'USD',
   dependencies:args,expression:{op,args:args.map(nodeId=>({op:'ref',nodeId}))}});
  const definition={schemaVersion:'underwriting-model-ir.v1',modelKey:'m3-exact-term',modelVersion:'1',
   financialConventionVersion:FINANCIAL_CONVENTION_VERSION,minimumEngineVersion:UNDERWRITING_ENGINE_VERSION,
   periodDefinition:{frequency:'annual',forecastStart:new Date(f.model.request.time.endAt).toISOString().slice(0,10),count:1},
   nodes:[node('debt_input.term.fixed_rate','rate','rate'),node('entry.enterprise_value','ev','money'),node('debt_input.term.opening_principal','principal','money'),
    node('entry.financing_fees','fees','money'),expression('total_uses','add',['entry.enterprise_value','entry.financing_fees']),
    expression('sponsor_equity','subtract',['total_uses','debt_input.term.opening_principal']),
    expression('interest','multiply',['debt_input.term.opening_principal','debt_input.term.fixed_rate']),
    ...['total_uses','sponsor_equity','interest'].map(sourceNodeId=>({id:sourceNodeId+'_out',kind:'output',valueType:'decimal',shape:'scalar',unit:'money',
     currency:'USD',dependencies:[sourceNodeId],sourceNodeId}))],circularBlocks:[]};
  const model=await createUnderwritingModel(f.ctx,{investmentCaseId:caseId,modelKey:definition.modelKey,name:'Registered exact term arithmetic'});
  const version=await createUnderwritingModelVersion(f.ctx,{modelId:String(model.id),definition:definition as any});
  const financialSeries=String((await createMetricSeries(f.ctx,{subjectType:'external_organization',subjectId:f.root.entityId,
   metricKey:'registered-financial-rate',name:'Registered proposed fixed rate',unit:'rate',frequency:'daily'})).row.id);
  const source=(await admin.query('SELECT evidence_source_id,evidence_version_id FROM finnor_os.pe_metric_observations WHERE tenant_id=$1 AND metric_series_id=$2 LIMIT 1',
   [f.tenant,f.series.price])).rows[0];
  await attachCanonicalEvidenceToWorld(f.ctx,{worldRoot:f.root,entity:{entityType:'pe_metric_series',entityId:financialSeries},
   evidenceSourceId:source.evidence_source_id,evidenceVersionId:source.evidence_version_id,relationship:'supports'});
  await admin.query(`INSERT INTO finnor_os.pe_metric_observations(id,tenant_id,metric_series_id,period_start,period_end,value_type,value_numeric,evidence_source_id,evidence_version_id,source_system,created_by)
   SELECT gen_random_uuid(),tenant_id,$3,period_start,period_end,value_type,value_numeric,evidence_source_id,evidence_version_id,'m3:registered-financing-fixture',created_by
   FROM finnor_os.pe_metric_observations WHERE tenant_id=$1 AND metric_series_id=$2`,[f.tenant,f.series.price,financialSeries]);
  const fittedRequest=structuredClone(f.model.request);fittedRequest.exposures[0].seriesId=financialSeries;
  fittedRequest.exposures[0].unit='rate';fittedRequest.exposures[0].operation='FINANCING_CHANGE';
  f.model=ok(await api(f,'fit',{request:fittedRequest},s3Post)).model;
  const incumbent=await support.policy(f,'financial-base',{cash:25});await support.resource(f,'cash','USD','STOCK',['200','200','200']);
  await work(f,'Construct a proposed exact fixed-rate alternative and retain all financial and legal dependencies');
  const financial={investmentCaseId:caseId,modelVersionId:String(version.id),nodeId:'debt_input.term.fixed_rate',semantics},
   trial=await submit({workId:f.workId,incumbentPolicyRef:incumbent.ref,purpose:'FINANCING',financial,
    permitted:{...request.permitted,actionId:'programme-financial-base',unit:'rate',terms:['0.3'],structures:['IMMEDIATE'],stageFractions:[]}},f);
  const changed=trial.result.program?.candidates.find((c:any)=>c.structure==='IMMEDIATE'&&c.nativeFinance);
  assert(changed,'A supported exact rate must reach the actual native financial engine');
  assert.equal(changed.nativeFinance.result.status,'SUCCEEDED');assert(changed.policyRef);
  const oracle=reference({operation:'finance',values:{rate:'0.3',ev:'120',principal:'70',fees:'0.01'}});
  for(const [id,value]of Object.entries(oracle))assert.equal(changed.nativeFinance.result.outputs[id+'_out'].value,value);
  const witness=ok(await api(f,'capital-program-witness',{queryId:trial.accepted.queryId,candidateDigest:changed.semanticDigest}));
  assert(witness.evidenceSlice.materialVariables.some((v:any)=>v.nativeId==='interest'),'M1 must retain the newly introduced native financial expression');
  assert(witness.evidenceSlice.unresolvedCoverage.some((g:any)=>/COLLATERAL|OPERATIVE/.test(g.code)));
  for(const invalid of [{...financial,semantics:{...semantics,entityId:randomUUID()}},{...financial,semantics:{...semantics,unit:'ratio'}}]){
   const refused=await api(f,'capital-program-submit',{...trial.input,idempotencyKey:randomUUID(),financial:invalid});
   assert([400,422].includes(refused.status),'An authenticated model cannot legitimize a different entity or unit');
  }
  const datedDefinition=structuredClone(definition);
  datedDefinition.modelVersion='calendar-negative-2';
  datedDefinition.nodes.push({id:'dated-interest',kind:'series',valueType:'decimal',shape:'series',unit:'money',currency:'USD',
   dependencies:['interest'],expression:{op:'ref',nodeId:'interest'}} as any);
  const dated=await createUnderwritingModelVersion(f.ctx,{modelId:String(model.id),definition:datedDefinition as any}),
   calendarRefusal=await api(f,'capital-program-submit',{...trial.input,idempotencyKey:randomUUID(),
    financial:{...financial,modelVersionId:String(dated.id)}});
  await artifact('finance/dated-calendar-negative.json',{datedDefinition,calendarRefusal});
  assert.equal(calendarRefusal.status,400,'Annual native series cannot silently fit a two-day S4 consequence horizon');
  await artifact('finance/independent.json',{definition,trial,oracle,witness});
  return {trial,oracle,qualification:'EXACT_ENTRY_BRIDGE_AND_SIMPLE_INTEREST_NOT_AN_LBO_OR_S4_WEALTH_OR_AGREED_FUNDING'};
 });
 await challenge('authentic-p4-work-rebind','Authentic P4 advances Work, supplies typed native/M1 input, and source correction refuses old read/witness/module/selection before a coherent child rederive',async()=>{
  const f=await support.fixture('m3-p4-finance',2,[{id:'cash',unit:'USD',capacity:200,totalLimit:200}]),
   deal=await createDeal(f.ctx,{targetOrganizationId:f.root.entityId,name:'M3 source-bound finance',dealLeadEmployeeId:f.principal,
    signedLoiAt:new Date('2025-01-01'),targetClosingAt:new Date('2027-01-01')}),
   investment=await createInvestmentCase(f.ctx,{dealId:String(deal.row.id),title:'P4 exact financial input'}),
   caseId=String(investment.row.id);
  const evSeries=String((await createMetricSeries(f.ctx,{subjectType:'external_organization',subjectId:f.root.entityId,
   metricKey:'m3-ev',name:'Source EV',unit:'currency',currencyCode:'USD',frequency:'annual'})).row.id);
  const evidence=(await admin.query('SELECT evidence_source_id,evidence_version_id FROM finnor_os.pe_metric_observations WHERE tenant_id=$1 AND metric_series_id=$2 LIMIT 1',
   [f.tenant,f.series.price])).rows[0],sourceRef={evidenceSourceId:evidence.evidence_source_id,evidenceVersionId:evidence.evidence_version_id};
  await attachCanonicalEvidenceToWorld(f.ctx,{worldRoot:f.root,entity:{entityType:'pe_metric_series',entityId:evSeries},...sourceRef,relationship:'supports'});
  const observation=await recordMetricObservation(f.ctx,{metricSeriesId:evSeries,periodStart:new Date('2025-01-01'),
   periodEnd:new Date('2026-01-01'),value:{type:'number',value:'120'},evidence:sourceRef});
  const financialMeaning={entityType:'external_organization',entityId:f.root.entityId,periodStart:f.model.request.time.endAt,
   periodEnd:new Date(Date.parse(f.model.request.time.endAt)+2*f.model.request.time.periodMs).toISOString(),unit:'rate',currencyCode:null,
   frequency:'instant',calendar:'OWNER_RECORDED',consolidation:'OWNER_SUBJECT_ONLY',instrument:'REGISTERED_FIXED_RATE',scale:'1',sign:'AS_RECORDED'};
  const evMeaning={...financialMeaning,periodStart:'2025-01-01T00:00:00.000Z',periodEnd:'2026-01-01T00:00:00.000Z',
   unit:'currency',currencyCode:'USD',frequency:'annual',instrument:'UNSPECIFIED'};
  const assumptions:any={};
  for(const [key,value]of [['rate',0.15],['principal',70],['fees',0.01]] as const)assumptions[key]=String((await createAssumption(f.ctx,{
   dealId:String(deal.row.id),investmentCaseId:caseId,assumptionKey:`p4-${key}`,statement:`Supplied financial ${key}`,
   valueType:key==='rate'?'percent':'currency',value,unit:key==='rate'?'rate':'money',...(key==='rate'?{}:{currencyCode:'USD'})})).row.id);
  const input=(id:string,key:string,unit:string)=>({id,kind:'input',valueType:'decimal',shape:'scalar',unit,dependencies:[],required:true,
   ...(unit==='money'?{currency:'USD'}:{}),source:{kind:'p1_assumption',assumptionId:assumptions[key]},
   ...(key==='rate'?{evidenceSemantics:financialMeaning}:{})});
  const definition={schemaVersion:'underwriting-model-ir.v1',modelKey:'m3-p4-finance',modelVersion:'1',
   financialConventionVersion:FINANCIAL_CONVENTION_VERSION,minimumEngineVersion:UNDERWRITING_ENGINE_VERSION,
   periodDefinition:{frequency:'annual',forecastStart:'2026-01-01',count:1},nodes:[
    {id:'entry.enterprise_value',kind:'input',valueType:'decimal',shape:'scalar',unit:'money',currency:'USD',
     dependencies:[],required:true,evidenceSemantics:evMeaning,allowedTruthClasses:['DERIVED_VALUE']},
    input('debt_input.term.fixed_rate','rate','rate'),input('debt_input.term.opening_principal','principal','money'),input('entry.financing_fees','fees','money'),
    {id:'sponsor_equity',kind:'expression',valueType:'decimal',shape:'scalar',unit:'money',currency:'USD',
     dependencies:['entry.enterprise_value','debt_input.term.opening_principal'],expression:{op:'subtract',args:[
      {op:'ref',nodeId:'entry.enterprise_value'},{op:'ref',nodeId:'debt_input.term.opening_principal'}]}},
    {id:'equity_out',kind:'output',valueType:'decimal',shape:'scalar',unit:'money',currency:'USD',
     dependencies:['sponsor_equity'],sourceNodeId:'sponsor_equity'}],circularBlocks:[]};
  const model=await createUnderwritingModel(f.ctx,{investmentCaseId:caseId,modelKey:definition.modelKey,name:'Source-bound native equity bridge'}),
   version=await createUnderwritingModelVersion(f.ctx,{modelId:String(model.id),definition:definition as any});
  const series=String((await createMetricSeries(f.ctx,{subjectType:'external_organization',subjectId:f.root.entityId,metricKey:'p4-finance-rate',
   name:'Registered rate',unit:'rate',frequency:'daily'})).row.id);
  await attachCanonicalEvidenceToWorld(f.ctx,{worldRoot:f.root,entity:{entityType:'pe_metric_series',entityId:series},...sourceRef,relationship:'supports'});
  await admin.query(`INSERT INTO finnor_os.pe_metric_observations(id,tenant_id,metric_series_id,period_start,period_end,value_type,value_numeric,evidence_source_id,evidence_version_id,source_system,created_by)
   SELECT gen_random_uuid(),tenant_id,$3,period_start,period_end,value_type,value_numeric,evidence_source_id,evidence_version_id,'m3:p4-native-rate',created_by
   FROM finnor_os.pe_metric_observations WHERE tenant_id=$1 AND metric_series_id=$2`,[f.tenant,f.series.price,series]);
  const fitting=structuredClone(f.model.request);fitting.exposures[0].seriesId=series;fitting.exposures[0].unit='rate';fitting.exposures[0].operation='FINANCING_CHANGE';
  f.model=ok(await api(f,'fit',{request:fitting},s3Post)).model;
  const policy=await support.policy(f,'p4-base',{cash:25});await support.resource(f,'cash','USD','STOCK',['200','200','200']);
  await work(f,'Construct source-bound proposed financing');
  const old=await submit({workId:f.workId,incumbentPolicyRef:policy.ref,permitted:{...request.permitted,actionId:'programme-p4-base',
   unit:'rate',terms:['0.3'],structures:['IMMEDIATE'],stageFractions:[]}},f);
  async function acquire(){
   const {entityType:_type,entityId:_id,...meaning}=evMeaning;
   const handles=ok(await api(f,'evidence-handles',{root:f.root,inputs:[{inputId:'EV',source:{kind:'metric',subject:f.root,metricKey:'m3-ev',...meaning}}]})).handles;
   const accepted=ok(await api(f,'evidence-submit',{schema:'finnor.evidence-request.v1',workId:f.workId,
    question:'Resolve exact source EV for this revised economic Work',root:f.root,mode:'ordinary_disposable',idempotencyKey:randomUUID(),
    inputs:handles.map((h:any)=>({inputId:h.inputId,handleId:h.id})),
    program:{schema:'finnor.derivation-ir.v1',nodes:[{id:'rows',op:'source',inputId:'EV'},{id:'ev',op:'unique',input:'rows'}],outputs:['ev']},
    acceptance:{selectedUniverse:'COMPLETE',absoluteTolerance:'0',materialOutputs:['ev']}}),202);
   let current:any;for(let i=0;i<32;i++){await queue.tick();current=ok(await api(f,'evidence-read',{queryId:accepted.queryId}));
    if(!['QUEUED','RUNNING'].includes(current.status))break;}
   assert.equal(current.status,'TESTED',JSON.stringify(current));
   const witness=ok(await api(f,'evidence-witness',{queryId:accepted.queryId,output:'ev'}));
   assert(witness.witnesses.some((w:any)=>w.recordId===String(observation.row.id)||w.sourceKind==='canonical'));
   return {accepted,current,witness};
  }
  const acquired=await acquire(),stale=ok(await api(f,'capital-program-read',{queryId:old.accepted.queryId}));
  assert.equal(stale.status,'INVALIDATED');assert.equal(stale.program,null);
  await artifact('p4-finance/before-economic.json',{acquired,stale,
   policyValidation:await api(f,'validate',{policyRef:policy.ref},s4Post)});
  // Actual P4 intake attaches the root to the revised Work. Rebind the
  // permissioned S3/S4 membership rather than weakening their old pin.
  f.model=ok(await api(f,'fit',{request:fitting},s3Post)).model;
  const evidencePolicy=await support.policy(f,'p4-evidence-base',{cash:25});
  for(let i=0;i<f.resources.length;i++){
   const {ref:expectedRef,revision:_revision,priorRef:_priorRef,...body}=f.resources[i];
   f.resources[i]=ok(await api(f,'resource',{resource:{...body,beliefPins:evidencePolicy.bindings.beliefPins},expectedRef},s5Post));
  }
  const financial={investmentCaseId:caseId,modelVersionId:String(version.id),nodeId:'debt_input.term.fixed_rate',
   semantics:financialMeaning,evidenceDerivationInputs:{'entry.enterprise_value':{derivationId:acquired.current.derivation.id,output:'ev'}}};
  const trialInput={...request,idempotencyKey:randomUUID(),workId:f.workId,incumbentPolicyRef:evidencePolicy.ref,purpose:'FINANCING',financial,
   permitted:{...request.permitted,actionId:'programme-p4-evidence-base',unit:'rate',terms:['0.3'],structures:['IMMEDIATE'],stageFractions:[]}},
   trialAccepted=ok(await api(f,'capital-program-recompile',{queryId:old.accepted.queryId,idempotencyKey:trialInput.idempotencyKey,replacement:trialInput}),202),
   trial={input:trialInput,accepted:trialAccepted,result:await drain(trialAccepted.queryId,f)};
  assert(trial.result.program?.envelope.parents.some((ref:any)=>ref.id===old.result.program.ref.id&&ref.contentDigest===old.result.program.ref.contentDigest));
  const candidate=trial.result.program?.candidates.find((c:any)=>c.structure==='IMMEDIATE'&&c.policyRef);assert(candidate);
  assert.equal(candidate.nativeFinance.result.outputs.equity_out.value,'50');
  const witness=ok(await api(f,'capital-program-witness',{queryId:trial.accepted.queryId,candidateDigest:candidate.semanticDigest}));
  assert(witness.evidenceSlice.derivedEvidence.some((d:any)=>d.producer==='P4'&&d.ownerRef.id===acquired.current.derivation.id));
  assert(trial.result.program.costs.upstreamComputeRefs.includes(acquired.current.derivation.runtime.fabricInvocationId));
  const native=ok(await api(f,'decision-slice-read',{sliceRef:witness.evidenceSlice.ref})),
   p4Root=native.slice.materialVariables.find((node:any)=>node.ownerRef.owner==='P4'&&node.nativeId===acquired.current.derivation.id);
  assert(p4Root);
  const omitted=structuredClone(native.slice.projectionSupport.witness);
  omitted.retainedIds=omitted.retainedIds.filter((id:string)=>id!==p4Root.id);omitted.omittedIds.push(p4Root.id);
  assert.equal(checkDecisionProjection(native.projectionInput,omitted).status,'REJECTED');
  const altered=structuredClone(native.projectionInput),edge=altered.graph.edges.find((row:any)=>row.kind==='PROVENANCE'&&row.to===p4Root.id);
  assert(edge);edge.expressionDigest='0'.repeat(64);
  const {ref:_graphRef,...alteredBody}=altered.graph,digest=epistemicHash(alteredBody);
  altered.graph.ref={...altered.graph.ref,contentDigest:digest,id:'decision-graph:'+digest};
  assert.equal(checkDecisionProjection(altered,{...native.slice.projectionSupport.witness,graphDigest:digest}).status,'REJECTED');
  const consumed=ok(await api(f,'decision-slice-consume',{sliceRef:native.slice.ref,use:'NUMERICAL_ONLY'}));
  assert.equal(consumed.status,'NATIVE_NUMERICAL_ONLY');assert.equal(consumed.runs[0].result.status,'SUCCEEDED');
  assert.equal(consumed.runs[0].result.outputs.equity_out.value,'50');
  await restateMetricObservation(f.ctx,{priorObservationId:String(observation.row.id),expectedVersion:1,
   replacement:{value:{type:'number',value:'125'},evidence:sourceRef}});
  const invalidated=ok(await api(f,'capital-program-read',{queryId:trial.accepted.queryId}));assert.equal(invalidated.status,'INVALIDATED');
  for(const [operation,body]of [
   ['capital-program-witness',{queryId:trial.accepted.queryId,candidateDigest:candidate.semanticDigest}],
   ['capital-program-module',{queryId:trial.accepted.queryId,moduleDigest:candidate.moduleRef.contentDigest}],
   ['capital-program-select',{queryId:trial.accepted.queryId,candidateDigest:candidate.semanticDigest,idempotencyKey:randomUUID()}]] as const){
   assert.equal((await api(f,operation,body)).status,409);
  }
  assert.equal((await api(f,'evidence-witness',{queryId:acquired.accepted.queryId,output:'ev'})).status,422);
  const rederived=await acquire();
  // Refit the authentic S3 owner after its broad subject/source pin changed.
  f.model=ok(await api(f,'fit',{request:fitting},s3Post)).model;
  const replacement=await support.policy(f,'p4-corrected',{cash:25});
  for(let i=0;i<f.resources.length;i++){
   const {ref:expectedRef,revision:_revision,priorRef:_priorRef,...body}=f.resources[i];
   f.resources[i]=ok(await api(f,'resource',{resource:{...body,beliefPins:replacement.bindings.beliefPins},expectedRef},s5Post));
  }
  const nextInput={...trial.input,idempotencyKey:randomUUID(),incumbentPolicyRef:replacement.ref,
   financial:{...financial,evidenceDerivationInputs:{'entry.enterprise_value':{derivationId:rederived.current.derivation.id,output:'ev'}}},
   permitted:{...trial.input.permitted,actionId:'programme-p4-corrected'}},
   nextAccepted=ok(await api(f,'capital-program-recompile',{queryId:trial.accepted.queryId,idempotencyKey:nextInput.idempotencyKey,replacement:nextInput}),202),
   next={input:nextInput,accepted:nextAccepted,result:await drain(nextAccepted.queryId,f)};
  assert(next.result.program?.envelope.parents.some((ref:any)=>ref.id===trial.result.program.ref.id&&ref.contentDigest===trial.result.program.ref.contentDigest));
  assert.equal(next.result.program.envelope.recompilation.parentQueryId,trial.accepted.queryId);
  assert(next.result.program.envelope.recompilation.changedDependencies.length);
  const updated=next.result.program?.candidates.find((c:any)=>c.structure==='IMMEDIATE'&&c.policyRef);assert(updated);
  assert.equal(updated.nativeFinance.result.outputs.equity_out.value,'55');
  assert.equal(next.result.program.envelope.work.inputId,rederived.current.derivation.work.revision);
  assert.notEqual(next.result.program.envelope.work.inputId,trial.result.program.envelope.work.inputId);
  await artifact('p4-finance/material-input.json',{old,acquired,stale,trial,witness,invalidated,rederived,next});
  return {oldQueryId:old.accepted.queryId,trialQueryId:trial.accepted.queryId,nextQueryId:next.accepted.queryId,
   before:'50',after:'55',qualification:'ACTUAL_P4_NATIVE_FINANCE_M1_CURRENTNESS_DEVELOPMENT_NOT_AGREED_OR_IDENTIFIED_VALUE'};
 });
}

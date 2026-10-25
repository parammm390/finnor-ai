import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ingestArtifact,bindArtifact} from '@finnor/artifacts';
import {createDeal,createInvestmentCase,createUnderwritingModel,createUnderwritingModelVersion} from '@finnor/private-equity';
import {dataRoomWorkbook,dataRoomContext} from './data-room-fixtures.mts';

/** One real owner story, beyond the native parser: immutable uploaded bytes →
 * source binding → authenticated handles/API → restricted queue worker → SQL
 * checks → typed underwriting API → acquisition queue → checked bid. */
export async function dataRoomE2E(e:any){
 const {test,ctx,tenant,actor,companies,api,handles,submit,finish,descriptor,root,evidence,validAt,runAcquisitionWorker,admin}=e;
 const company='P4 A',artifactActor={tenantId:tenant,userId:actor,employeeId:actor,role:'owner' as const};
 let story:any=null;
 async function upload(options:Parameters<typeof dataRoomWorkbook>[0],prior?:any){
  const bytes=dataRoomWorkbook({company,...options});
  const file=await ingestArtifact(artifactActor,{title:'Atlas income statement.xlsx',bytes,origin:'manual_upload',sourceSystem:'p4:data-room-e2e',...(prior?{documentId:prior.documentId,parentVersionId:prior.version.id,expectedHead:prior.version.id}:{})});
  const anchor=file.ir.nodes[0];assert(anchor,'Real artifact interpreter must provide a bindable source anchor');
  await bindArtifact(artifactActor,file.documentId,{versionId:file.version.id,anchorId:anchor.id,anchorHash:anchor.hash,targetKind:'canonical_entity',targetEntityType:'external_organization',targetId:companies.A});
  await writeFile(join(evidence,file.version.id+'.xlsx'),bytes);
  return {file,sha256:createHash('sha256').update(bytes).digest('hex')};
 }
 function source(file:any,metricKey:string,cell:string,label:string,numberFormat='COMMA_GROUPED'){
  return {...descriptor('A',metricKey,{calendar:'GREGORIAN',consolidation:'CONSOLIDATED',instrument:'OPERATING',scale:'1000'}),kind:'artifact',documentId:file.documentId,documentVersionId:file.version.id,
   layout:{format:'xlsx',sheet:'Income statement',selection:{kind:'financial_cells',numberFormat,context:dataRoomContext(company),values:[{cell,label:{cell:cell==='B5'?'A5':'A6',text:label}}]}}};
 }
 await test('ordinary-data-room-numeric-storage',{raw:'1.234',displayNumberFormat:'DOT_GROUPED',scale:'1000',expected:'1234'},'Native OOXML numeric storage uses decimal notation even when displayed with dot-grouped locale; independent SQL replay must preserve 1234, not 1234000',async()=>{
  const uploaded=await upload({revenue:'1.234',numericRevenue:true});
  const hs=await handles('A',[{inputId:'revenue',source:source(uploaded.file,'net_revenue','B5','Net revenue','DOT_GROUPED')}]);
  const done=await finish(await submit('A',{handles:hs,program:{schema:'finnor.derivation-ir.v1',nodes:[{id:'rows',op:'source',inputId:'revenue'},{id:'revenue',op:'unique',input:'rows'}],outputs:['revenue']},acceptance:{selectedUniverse:'COMPLETE',absoluteTolerance:'0',materialOutputs:['revenue']}}));
  assert.equal(done.status,'TESTED',JSON.stringify(done));assert.equal(done.derivation.result.outputs.revenue.value,'1234');
  assert(done.derivation.independentChecks.some((c:any)=>c.method==='POSTGRES_NUMERIC'&&c.status==='PASS'));
  return {uploaded,done,productionAuthenticationVerified:false};
 });
 await test('ordinary-data-room-to-acquisition',{revenue:'1,234.50',costs:'(70)',scale:'1000',expected:{operatingProfit:'1164500',maximumBid:'1900000',financing:'debt1000'}},'Ordinary financial cells with explicit source-checked semantics and accounting signs survive independent SQL and typed HTTP underwriting; their actual values drive the maximum bid in the same Work',async()=>{
  const uploaded=await upload({});
  const hs=await handles('A',[{inputId:'revenue',source:source(uploaded.file,'net_revenue','B5','Net revenue')},{inputId:'costs',source:source(uploaded.file,'operating_costs','B6','Operating costs')}]);
  const program={schema:'finnor.derivation-ir.v1',nodes:[{id:'revenueRows',op:'source',inputId:'revenue'},{id:'revenue',op:'unique',input:'revenueRows'},{id:'costRows',op:'source',inputId:'costs'},{id:'costs',op:'unique',input:'costRows'},{id:'operatingProfit',op:'add',left:'revenue',right:'costs'}],outputs:['revenue','costs','operatingProfit']};
  const done=await finish(await submit('A',{handles:hs,program,acceptance:{selectedUniverse:'COMPLETE',absoluteTolerance:'0',materialOutputs:program.outputs}}));
  assert.equal(done.status,'TESTED',JSON.stringify(done));
  assert.equal(done.derivation.result.outputs.revenue.value,'1234500');assert.equal(done.derivation.result.outputs.costs.value,'-70000');assert.equal(done.derivation.result.outputs.operatingProfit.value,'1164500');
  assert(done.derivation.independentChecks.length>0&&done.derivation.independentChecks.every((c:any)=>c.status==='PASS'));
  assert(done.derivation.witnesses.every((w:any)=>w.contentDigest===uploaded.sha256&&w.interpretation.scope==='EXPLICIT_SELECTED_ANCHORS'));
  const deal=await createDeal(ctx,{targetOrganizationId:companies.A,name:'Source-bound acquisition',dealLeadEmployeeId:actor,signedLoiAt:new Date('2026-01-01'),targetClosingAt:new Date('2026-12-31')});
  const dealId=String(deal.row.id),investment=await createInvestmentCase(ctx,{dealId,title:'Financial-file acquisition decision'}),investmentCaseId=String(investment.row.id);
  const model=await createUnderwritingModel(ctx,{investmentCaseId,modelKey:'source_bound_acquisition',name:'Source-bound financial decision'});
  const money={valueType:'decimal' as const,unit:'money' as const,currency:'USD',shape:'scalar' as const};
  const parameter=(id:string)=>({id,kind:'input',...money,dependencies:[],required:true,source:{kind:'model_parameter'},...(id==='debt'?{minimum:'0',maximum:'1000000'}:{})});
  const ref=(nodeId:string)=>({op:'ref',nodeId});
  const binary=(id:string,op:string,left:string,right:string)=>({id,kind:'expression',...money,dependencies:[left,right],expression:{op,args:[ref(left),ref(right)]}});
  const output=(id:string,sourceNodeId:string)=>({id,kind:'output',...money,dependencies:[sourceNodeId],sourceNodeId});
  const definition={schemaVersion:'underwriting-model-ir.v1',modelKey:'source_bound_acquisition',modelVersion:'1',financialConventionVersion:'finnor-pe-lbo/1.0.0',minimumEngineVersion:'finnor-underwriting-engine/1.0.0',periodDefinition:{frequency:'annual',forecastStart:'2026-01-01',count:1},circularBlocks:[],nodes:[
   {id:'operating_profit',kind:'input',...money,dependencies:[],required:true,allowedTruthClasses:['DERIVED_VALUE'],evidenceSemantics:done.derivation.result.outputs.operatingProfit.semantics},
   parameter('price'),parameter('debt'),parameter('financing_cost'),
   {id:'exit_multiple',kind:'constant',valueType:'decimal',unit:'multiple',shape:'scalar',dependencies:[],value:'2',truthClass:'MODEL_PARAMETER'},
   binary('exit_value','multiply','operating_profit','exit_multiple'),binary('gross_gain','subtract','exit_value','price'),binary('net_gain','subtract','gross_gain','financing_cost'),binary('equity','subtract','price','debt'),output('profit_output','net_gain'),output('equity_output','equity'),
  ]};
  const version=await createUnderwritingModelVersion(ctx,{modelId:String(model.id),definition:definition as Parameters<typeof createUnderwritingModelVersion>[1]['definition']});
  const request={investmentCaseId,modelVersionId:String(version.id),worldAt:validAt,workId:done.workId,idempotencyKey:'data-room-base',evidenceDerivationInputs:{operating_profit:{derivationId:done.derivation.id,output:'operatingProfit'}},explicitInputs:{price:{value:'1900000',truthClass:'MODEL_PARAMETER'},debt:{value:'0',truthClass:'MODEL_PARAMETER'},financing_cost:{value:'0',truthClass:'MODEL_PARAMETER'}}};
  const post=(await import('../../apps/api/app/api/underwriting/runs/route')).POST;
  const response=await post(new Request('http://localhost/api/underwriting/runs',{method:'POST',headers:{'content-type':'application/json','x-tenant-id':tenant,'x-user-id':actor},body:JSON.stringify(request)}));
  const base=await response.json();assert.equal(response.status,201,JSON.stringify(base));
  assert.equal(base.inputSnapshot.values.operating_profit.value,'1164500');assert.equal(base.inputSnapshot.values.operating_profit.truthClass,'DERIVED_VALUE');assert.equal(base.inputSnapshot.values.operating_profit.provenance[0].kind,'evidence_derivation');
  const mandate={dealId,workId:done.workId,baseRunId:base.id,idempotencyKey:'data-room-acquisition',bidDomain:{nodeId:'price',currency:'USD',values:['1900000','2000000','2100000']},financingCases:[{key:'cash',name:'Cash',overrides:[{nodeId:'debt',value:'0',reason:'Declared cash case'},{nodeId:'financing_cost',value:'0',reason:'Declared cash case'}]},{key:'debt1000',name:'Debt1000000 fee50000',overrides:[{nodeId:'debt',value:'1000000',reason:'Declared financing case'},{nodeId:'financing_cost',value:'50000',reason:'Declared financing case'}]}],constraints:[{outputNodeId:'profit_output',operator:'gte',threshold:'300000',unit:'money',currency:'USD'},{outputNodeId:'equity_output',operator:'lte',threshold:'1000000',unit:'money',currency:'USD'}]};
  // These are owner-policy boundaries, not formula assertions: a financing
  // case cannot rewrite source-derived profit or evade the model's debt cap.
  // The HTTP response must refuse before a decision or paid job is created.
  const beforeInvalid=(await admin.query("SELECT count(*)::int n FROM finnor_os.jobs WHERE tenant_id=$1 AND type='evaluate_acquisition_v1'",[tenant])).rows[0].n;
  const rejected=[];
  for(const probe of [{key:'source',nodeId:'operating_profit',value:'9999999'},{key:'debt-cap',nodeId:'debt',value:'1000000.01'}]){
   const response=await api('acquisition-evaluate',{...mandate,idempotencyKey:'invalid-'+probe.key,financingCases:[{key:'invalid',name:'Invalid financing input',overrides:[{nodeId:probe.nodeId,value:probe.value,reason:'Attempted policy violation'}]}]});
   rejected.push({probe,response});
   await writeFile(join(evidence,'rejected-financing-inputs.json'),JSON.stringify(rejected,null,2));
   assert.equal(response.status,409,JSON.stringify(response));
   assert.equal(response.body.code,'ACQUISITION_SCENARIO_POLICY_REJECTED');
  }
  assert.equal((await admin.query("SELECT count(*)::int n FROM finnor_os.jobs WHERE tenant_id=$1 AND type='evaluate_acquisition_v1'",[tenant])).rows[0].n,beforeInvalid);
  const submitted=await api('acquisition-evaluate',mandate);assert.equal(submitted.status,202,JSON.stringify(submitted));
  await runAcquisitionWorker();
  const decision=await api('acquisition-read',{decisionId:submitted.body.decisionId});assert.equal(decision.status,200,JSON.stringify(decision));assert.equal(decision.body.status,'TESTED');
  assert.equal(decision.body.result.maximumBid.value,'1900000');assert.equal(decision.body.result.maximumBid.financingCaseKey,'debt1000');assert.equal(decision.body.workId,done.workId);
  // A later financial-file version must change the actual investment decision.
  // Existing scalar/parser tests cannot observe stale publication or an API
  // that refuses to consume the replacement source in the original Work.
  const pending=await api('acquisition-evaluate',{...mandate,idempotencyKey:'queued-before-file-correction'});
  assert.equal(pending.status,202);
  const corrected=await upload({revenue:'1,000.00'},uploaded.file);
  assert.equal(corrected.file.documentId,uploaded.file.documentId);assert.notEqual(corrected.file.version.id,uploaded.file.version.id);
  const stale=await api('acquisition-read',{decisionId:submitted.body.decisionId});
  assert.equal(stale.status,409,JSON.stringify(stale));assert.equal(stale.body.code,'ACQUISITION_SOURCE_CUT_CHANGED');assert(!stale.body.result);
  await runAcquisitionWorker();
  const invalidated=(await admin.query('SELECT status,result,failure FROM finnor_os.acquisition_decisions WHERE tenant_id=$1 AND id=$2',[tenant,pending.body.decisionId])).rows[0];
  assert.equal(invalidated.status,'INVALIDATED',JSON.stringify(invalidated));assert.equal(invalidated.result,null);assert.equal(invalidated.failure,'ACQUISITION_SOURCE_CUT_CHANGED');
  const oldEvidence=await api('evidence-read',{queryId:done.queryId});assert.equal(oldEvidence.body.status,'INVALIDATED');assert(!oldEvidence.body.derivation?.result);
  const correctedHandles=await handles('A',[{inputId:'revenue',source:source(corrected.file,'net_revenue','B5','Net revenue')},{inputId:'costs',source:source(corrected.file,'operating_costs','B6','Operating costs')}]);
  const revised=await finish(await submit('A',{workId:done.workId,handles:correctedHandles,program,acceptance:{selectedUniverse:'COMPLETE',absoluteTolerance:'0',materialOutputs:program.outputs}}));
  assert.equal(revised.status,'TESTED',JSON.stringify(revised));assert.equal(revised.workId,done.workId);assert.equal(revised.derivation.result.outputs.operatingProfit.value,'930000');
  const revisedRequest={...request,idempotencyKey:'data-room-corrected-base',evidenceDerivationInputs:{operating_profit:{derivationId:revised.derivation.id,output:'operatingProfit'}}};
  const revisedResponse=await post(new Request('http://localhost/api/underwriting/runs',{method:'POST',headers:{'content-type':'application/json','x-tenant-id':tenant,'x-user-id':actor},body:JSON.stringify(revisedRequest)}));
  const revisedBase=await revisedResponse.json();assert.equal(revisedResponse.status,201,JSON.stringify(revisedBase));assert.equal(revisedBase.inputSnapshot.values.operating_profit.value,'930000');
  const revisedSubmission=await api('acquisition-evaluate',{...mandate,baseRunId:revisedBase.id,idempotencyKey:'data-room-corrected-acquisition'});assert.equal(revisedSubmission.status,202,JSON.stringify(revisedSubmission));
  await runAcquisitionWorker();
  const revisedDecision=await api('acquisition-read',{decisionId:revisedSubmission.body.decisionId});
  assert.equal(revisedDecision.status,200,JSON.stringify(revisedDecision));assert.equal(revisedDecision.body.status,'TESTED');assert.equal(revisedDecision.body.workId,done.workId);
  assert.equal(revisedDecision.body.result.maximumBid.value,null);assert.equal(revisedDecision.body.result.maximumBid.qualification,'NO_FEASIBLE_CANDIDATE');
  const observed={uploaded,handles:hs,done,definition,request,base,mandate,rejected,submitted,decision,correction:{corrected,pending,stale,invalidated,oldEvidence,revised,revisedRequest,revisedBase,revisedSubmission,revisedDecision},qualification:'SOURCE_ASSERTIONS_AND_EXPLICIT_MODEL_PARAMETERS_NOT_REALIZED_PROFIT'};
  story=observed;
  await writeFile(join(evidence,'source-bound-acquisition.json'),JSON.stringify(observed,null,2));
  return {...observed,financialInterpretation:'EXPLICIT_SELECTED_ANCHORS_NOT_AUTOMATIC_DOCUMENT_WIDE_TRUTH',productionAuthenticationVerified:false};
 });
 if(process.env.FINNOR_ACQUISITION_ANALYSIS_E2E==='1')await test('ordinary-data-room-to-acquisition-child',{initialProfit:'1164500',sourceProfit:'930000',maximumBid:null},'A checked child must update the same acquisition decision without replacing its original Work/input/plan; later source correction must withhold the stale result',async()=>{
  assert(story,'The source acquisition fixture must have completed');
  const proof=await (await import('../acquisition/analysis-e2e.mts')).acquisitionAnalysisE2E({ctx,tenant,actor,admin,api,evidence,story,upload,browserFixtureContext:e,workerDatabaseUrl:e.workerDatabaseUrl,sources:[{key:'revenue',source:source(story.correction.corrected.file,'net_revenue','B5','Net revenue')},{key:'costs',source:source(story.correction.corrected.file,'operating_costs','B6','Operating costs')}],runWorker:e.runAnalysisWorker});
  return proof;
 });
}

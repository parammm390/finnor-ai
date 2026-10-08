/** Public diagnostic, not sealed qualification. Baseline implementations import
 * only existing S/P4/query/numerical/artifact owners, never the P1 compiler,
 * module builder, worker, expected result or checked programme. All three receive
 * the same accepted arithmetic, authenticated source scopes and native tools.
 * The legacy planner is actually called and its autonomy limit remains explicit.
 */
import {strict as assert} from 'node:assert';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createDeal,createInvestmentCase,createUnderwritingModel,createUnderwritingModelVersion} from '@finnor/private-equity';
import {compileUnderwritingModel} from '@finnor/underwriting';
import {groundedMemoBytes,ingestArtifact,getArtifactBytes,interpret} from '@finnor/artifacts';
import {resolveProviderForPurpose,describeLLMRoute} from '../../packages/tools/src/llm';
import {LLMPlanner,createDefaultPluginRegistry,executeTenantOperationalQuery,planningCapabilitiesForVertical} from '@finnor/orchestration';
import {beginWorkPlannerAttempt} from '@finnor/db';
import {buildGoalSpec,buildPlanningWorldSnapshot} from '@finnor/planning';
const hash=(value:unknown)=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
function refs(expression:any):string[]{if(!expression||typeof expression!=='object')return [];if(expression.op==='ref')return [expression.nodeId];return [...new Set(Object.values(expression).flatMap(value=>Array.isArray(value)?value.flatMap(refs):typeof value==='object'?refs(value):[]))].sort();}
const nativeKey=(key:string)=>({EV:'ev',EBITDA:'ebitda',netEquity:'net_equity'} as Record<string,string>)[key]??key;
const ref=(nodeId:string)=>({op:'ref',nodeId:nativeKey(nodeId)}),zero={op:'literal',value:'0',valueType:'decimal',unit:'money',currency:'USD'};
const prepared={netEquity:{op:'if',condition:{op:'compare',comparison:'gt',left:ref('EV'),right:ref('debt')},then:{op:'subtract',args:[{op:'subtract',args:[ref('EV'),ref('debt')]},ref('liability')]},else:zero},leverage:{op:'if',condition:{op:'compare',comparison:'gt',left:ref('EBITDA'),right:zero},then:{op:'if',condition:{op:'compare',comparison:'eq',left:ref('debt'),right:zero},then:{op:'literal',value:'0',valueType:'decimal',unit:'multiple'},else:{op:'divide',args:[{op:'literal',value:'1',valueType:'decimal',unit:'multiple'},{op:'divide',args:[ref('EBITDA'),ref('debt')]}]}},else:{op:'literal',value:'0',valueType:'decimal',unit:'multiple'}}};
export async function equippedComparison(e:any){
 const {ctx,actor,tenant,companies,root,descriptor,api,submit,finish,request,create,complete,admin,evidence}=e;
 const profileId=process.env.FINNOR_P1_COMPARISON_PROFILE??'LEGACY_8S_700';if(!['LEGACY_8S_700','COMPLETION_30S_2048'].includes(profileId))throw Error('REGISTERED_COMPARISON_PROFILE_REQUIRED');
 const providerBudgetMs=profileId==='COMPLETION_30S_2048'?30000:8000,outputTokens=profileId==='COMPLETION_30S_2048'?2048:700;
 const keys=['EV','debt','EBITDA','liability'],accepted:any=request();
 const input=(key:string)=>({kind:'input',key}),money=(value:string)=>({kind:'literal',value,unit:'currency',currencyCode:'USD'});
 accepted.acceptance.targets[0].expression={kind:'if',condition:{comparison:'gt',left:input('EV'),right:input('debt')},whenTrue:accepted.acceptance.targets[0].expression,whenFalse:money('0')};
 accepted.acceptance.targets[1].expression={kind:'if',condition:{comparison:'gt',left:input('EBITDA'),right:money('0')},whenTrue:accepted.acceptance.targets[1].expression,whenFalse:{kind:'literal',value:'0',unit:'multiple',currencyCode:null}};
 const protocol={schema:'finnor.p1.equipped-public-protocol.v1',registeredAt:new Date().toISOString(),taskPopulation:['ONE_PUBLIC_A_LIABILITY_CONDITIONAL_DRAFT'],trials:['cold','warm-current-source-recheck'],order:['S_PLUS_P4_PREPARED_NATIVE','PUBLIC_EQUIPPED_REAL_MODEL','P1','P1','PUBLIC_EQUIPPED_REAL_MODEL','S_PLUS_P4_PREPARED_NATIVE'],acceptedCriteria:accepted.acceptance,route:describeLLMRoute('planning','console'),requestedModel:process.env.GROQ_MODEL,originalEnvelope:{capitalExposure:1,eachResourcePool:1,humanSeconds:900,computeDataIntegrationUSD:100,peakMemoryGiB:16,responseSeconds:30,episodeSeconds:3600,preparationHumanHours:80,preparationUSD:10000},localProfile:{id:profileId,mode:'ordinary_disposable',providerProposalsPerController:2,sharedProviderDeadlineMs:providerBudgetMs,outputTokensPerPhysicalCall:outputTokens,matchedPermittedAllowanceForAllControllers:true,previousProfileResultsRetained:true,nativeDecimalSignificantDigits:34,aggregateResourcesQualified:false},oracle:'Actual PostgreSQL numeric from reacquired owner-bound P4 scalars plus independent ArtifactIR reinterpretation and durable byte reread',sealed:false,completedS1S8:{status:'BLOCKED_EXTERNAL',predicate:'SIGNED_GENERIC_HARNESS_S8_AND_COMPLETE_RESOURCE_DOMAIN_UNAVAILABLE'},qualifiedComparisons:0,qualification:'Public authorable diagnostic; prepared human integration is charged but unpriced; no frontier dominance or 100x claim'};
 await writeFile(join(evidence,'equipped-protocol.json'),JSON.stringify(protocol,null,2));
 const report:any={schema:'finnor.p1.equipped-public-results.v1',protocolSha256:hash(protocol),startedAt:new Date().toISOString(),preparation:{humanSeconds:null,integrationUSD:null,preparedProcedureSha256:hash(prepared),amortizationEpisodes:2},cells:[],unknownCostScopes:['provider invoices','native runtime and child peak memory','human preparation and assistance','data/integration','storage and maintenance'],completedS1S8:protocol.completedS1S8,independentQualifiedEpisodes:0,sealed:false,superiority:'INCONCLUSIVE',totalUSD:null};
 const save=()=>writeFile(join(evidence,'equipped-comparison.json'),JSON.stringify(report,null,2));
 const preparedAt=performance.now();
 const deal=await createDeal(ctx,{targetOrganizationId:companies.A,name:'Public equipped comparison',dealLeadEmployeeId:actor,signedLoiAt:new Date('2025-01-01'),targetClosingAt:new Date('2027-01-01')});
 const investment=await createInvestmentCase(ctx,{dealId:String(deal.row.id),title:'Same permitted public financial sources'}),investmentCaseId=String(investment.row.id);
 const models:any={};for(const name of ['native','model'])models[name]=await createUnderwritingModel(ctx,{investmentCaseId,modelKey:'p1-public-'+name,name:'Existing native equipped '+name});
 report.preparation.nativeSetupWallMs=performance.now()-preparedAt;await save();
 let modelExpressions:any,modelVersionId:string|null=null,nativeVersionId:string|null=null;
 const sourceProgram={schema:'finnor.derivation-ir.v1',nodes:keys.flatMap(key=>[{id:key+'_rows',op:'source',inputId:key},{id:key,op:'unique',input:key+'_rows'}]),outputs:keys};
 async function sources(){const hs=await api('evidence-handles',{root:root('A'),validAt:accepted.validAt,inputs:keys.map(key=>({inputId:key,source:descriptor('A',key)}))});assert.equal(hs.status,200,JSON.stringify(hs));const result=await finish(await submit('A',{handles:hs.body.handles,program:sourceProgram,acceptance:{selectedUniverse:'COMPLETE',absoluteTolerance:'0',materialOutputs:keys}}));assert.equal(result.status,'TESTED',JSON.stringify(result));return result;}
 function definition(d:any,expressions:any,name:string){
  const nodes=keys.map(id=>({id:nativeKey(id),kind:'input',dependencies:[],valueType:'decimal',unit:'money',currency:'USD',shape:'scalar',required:true,allowedTruthClasses:['DERIVED_VALUE'],evidenceSemantics:d.derivation.result.outputs[id].semantics}));
  for(const key of ['netEquity','leverage'])nodes.push({id:nativeKey(key)+'_calc',kind:'expression',dependencies:refs(expressions[key]),valueType:'decimal',unit:key==='netEquity'?'money':'multiple',...(key==='netEquity'?{currency:'USD'}:{}),shape:'scalar',expression:expressions[key]} as any);
  for(const key of ['netEquity','leverage'])nodes.push({id:nativeKey(key),kind:'output',dependencies:[nativeKey(key)+'_calc'],sourceNodeId:nativeKey(key)+'_calc',valueType:'decimal',unit:key==='netEquity'?'money':'multiple',...(key==='netEquity'?{currency:'USD'}:{}),shape:'scalar'} as any);
  return {schemaVersion:'underwriting-model-ir.v1',modelKey:'p1-public-'+name,modelVersion:'1',financialConventionVersion:'finnor-pe-lbo/1.0.0',minimumEngineVersion:'finnor-underwriting-engine/1.0.0',periodDefinition:{frequency:'annual',forecastStart:'2026-01-01',count:1},nodes,circularBlocks:[]};
 }
 async function artifact(d:any,values:any,name:string,trial:string){
  const actual=keys.map(key=>d.derivation.result.outputs[key].value),oracle=(await admin.query('SELECT CASE WHEN $1::numeric>$2::numeric THEN $1::numeric-$2::numeric-$3::numeric ELSE 0 END equity,CASE WHEN $4::numeric>0 THEN $2::numeric/$4::numeric ELSE 0 END leverage',[actual[0],actual[1],actual[3],actual[2]])).rows[0];
  assert.equal(values.netEquity.value,oracle.equity);assert.equal(values.leverage.value,oracle.leverage.replace(/0+$/,'').replace(/\.$/,''));
  const sourceRef='evidence_derivation:'+d.derivation.id,sections=[{heading:'Checked analytical values — draft',paragraphs:Object.entries(values).map(([key,value]:any)=>({text:key+': '+value.value+' '+(key==='netEquity'?'currency USD':'multiple')+'; DERIVED_VALUE; accepted required sources: '+keys.join(', '),sourceRefs:[sourceRef]}))},{heading:'Qualifications',paragraphs:[{text:'Source-cited analytical draft. No IC selection, execution authority, resource reservation, field identification, independent admission or owner value established.',sourceRefs:[sourceRef]}]}];
  const bytes=groundedMemoBytes(accepted.acceptance.deliverable.title,sections),ir=await interpret(bytes),serialized=JSON.stringify(ir);for(const text of ['netEquity: '+oracle.equity,'leverage: '+values.leverage.value,'liability',sourceRef])assert(serialized.includes(text),text);assert.equal((await api('evidence-read',{queryId:d.queryId})).body.status,'TESTED');
  const stored=await ingestArtifact({...ctx.auth,userId:actor},{title:accepted.acceptance.deliverable.title+'.docx',bytes,origin:'finnor_generated',sourceSystem:'p1_equipped_public_diagnostic',sourceRef:name+':'+trial+':'+d.queryId});
  const persisted=await getArtifactBytes({...ctx.auth,userId:actor},stored.documentId,stored.version.id);assert.equal(hash(persisted.bytes),hash(bytes));assert.equal(persisted.ir.semanticHash,ir.semanticHash);await writeFile(join(evidence,name+'-'+trial+'.docx'),bytes);
  return {documentId:stored.documentId,versionId:stored.version.id,sha256:hash(bytes),semanticHash:ir.semanticHash,oracle,sourceRef,liabilityWitnesses:d.derivation.witnesses.filter((w:any)=>w.field==='liability'||w.metricKey==='liability'),qualification:'CURRENT_CHECKED_ANALYTICAL_DRAFT; NOT_CANONICAL_IC_PROJECTION'};
 }
 async function nativePlanner(d:any){
  const provider=resolveProviderForPurpose('planning','console'),registry=createDefaultPluginRegistry(),goal=buildGoalSpec({objective:accepted.instruction,workId:d.workId,workInputId:d.derivation.work.revision,targets:[{kind:'entity',type:root('A').entityType,id:companies.A,sourceRef:'S1:authenticated-root'}],successCondition:{version:1,statement:accepted.instruction,source:'explicit',mode:'all',criteria:[{kind:'canonical_query',request:{intent:'pe_world_state',root:root('A')},assertion:{path:['data','root','entityId'],operator:'eq',expected:companies.A}}]}});
  const attempt=await beginWorkPlannerAttempt({tenantId:tenant,workId:d.workId,workInputId:d.derivation.work.revision,attemptKey:'equipped-legacy-planner:'+randomUUID()});
  const snapshot=buildPlanningWorldSnapshot({tenantId:tenant,verticalKey:'private_equity',workId:d.workId,workInputId:d.derivation.work.revision,plannerAttemptId:attempt.id,capturedAt:new Date().toISOString(),decisionContextHash:hash(accepted.acceptance),canonicalStateHash:d.derivation.result.digest,canonicalEntities:[{kind:'entity',type:root('A').entityType,id:companies.A,versionHash:null,sourceRef:'S1:authenticated-root'}],authority:{revision:d.derivation.beliefView.rights.revision,roles:['owner'],employeeId:actor},capabilities:planningCapabilitiesForVertical(registry,'private_equity') as any,currentEffects:[],sourceHealth:{status:'complete',missing:[]}});
  try{
   const planning=await new LLMPlanner(registry,{name:provider.name,get lastUsage(){return provider.lastUsage;},get lastAttempts(){return provider.lastAttempts;},complete:options=>provider.complete({...options,maxOutputTokens:outputTokens})}).plan(accepted.instruction,{tenantId:tenant,userId:actor,employeeId:actor,role:'owner'},{shortTerm:null,longTerm:null,semantic:[],episodic:[],patterns:null},{channel:'console',workId:d.workId,workInputId:d.derivation.work.revision,plannerAttemptId:attempt.id,goalSpec:goal,planningSnapshot:snapshot,deadlineMs:providerBudgetMs});
   const queries:any[]=[];for(const node of planning.compilation.selected?.graph?.nodes??[])if(node.kind==='query')queries.push(await executeTenantOperationalQuery(tenant,node.request as any,{userId:actor,employeeId:actor,workId:d.workId,workInputId:d.derivation.work.revision,executionKey:randomUUID()}));
   return {status:planning.compilation.selected?'EXECUTED_SELECTED_NATIVE_QUERY_PLAN':'REJECTED_NATIVE_PLAN',planning,queries,usage:provider.lastUsage??null,physicalAttempts:provider.lastAttempts??null,fullArtifactAutonomy:'PARTIAL_PREPARED_HUMAN_TOOL_INTEGRATION',qualification:'Accepted native goal covers the actual read. The common final artifact oracle remains an additional diagnostic controller gate, not retroactively a legacy Objective completion proof.'};
  }catch(error){return {status:'ACTUAL_PLANNER_ATTEMPT_FAILED',error:String(error),usage:provider.lastUsage??null,physicalAttempts:provider.lastAttempts??null,fullArtifactAutonomy:'PARTIAL_PREPARED_HUMAN_TOOL_INTEGRATION'};}
 }
 async function modelProposal(d:any){
  const provider=resolveProviderForPurpose('planning','console'),deadlineAt=Date.now()+providerBudgetMs,attempts:any[]=[];let prior:any=null;
  for(let attempt=0;attempt<2&&Date.now()<deadlineAt;attempt++){
   const id=randomUUID(),started=performance.now();let raw:string|undefined;
   try{
    raw=await provider.complete({system:'You are a public diagnostic equipped financial agent. Construct a finite native UnderwritingModelIR expression for each accepted output. Return JSON with exactly netEquity and leverage. Available native tools: authenticated P4 source acquisition and witnesses; exact decimal underwriting compiler/solver with ref/literal/add/subtract/multiply/divide/min/max/compare/if; checked pure DOCX artifact writer and independent byte reread. You have the same original criteria and information as P1. No P1 compiler or procedure lookup is available. Preserve exact units, required liability, conditional semantics and all owner boundaries. Expression examples only: {op:"ref",nodeId:"ev"}, {op:"subtract",args:[expression,expression]}, {op:"compare",comparison:"gt",left:expression,right:expression}, {op:"if",condition:expression,then:expression,else:expression}. Money literal: {op:"literal",value:"0",valueType:"decimal",unit:"money",currency:"USD"}; leverage output unit multiple, not ratio. Native money/money division returns ratio. Native multiple/ratio division returns multiple. Bind exact native lowercase input IDs; no implicit unit conversion or currency:null. No expected numerical answer is supplied.',user:JSON.stringify({instruction:accepted.instruction,acceptedCriteria:accepted.acceptance,inputPorts:keys.map(key=>({key,nativeId:nativeKey(key),semantics:d.derivation.result.outputs[key].semantics,truthClass:'DERIVED_VALUE',value:d.derivation.result.outputs[key].value})),priorFailure:prior}),json:true,tenantId:tenant,traceId:id,purpose:'planning',channel:'console',deadlineAt,maxOutputTokens:outputTokens});
    assert(Buffer.byteLength(raw)<=32768);const expressions=JSON.parse(raw);assert.deepEqual(Object.keys(expressions).sort(),['leverage','netEquity']);compileUnderwritingModel(definition(d,expressions,'model') as any);
    attempts.push({id,status:'NATIVE_COMPILER_ACCEPTED',raw,rawSha256:hash(raw),elapsedMs:performance.now()-started,usage:provider.lastUsage??null,physicalAttempts:provider.lastAttempts??null,costUSD:null,deadlineAt});return {expressions,attempts};
   }catch(error){prior={predicate:String(error)};attempts.push({id,status:'FAILED',raw:raw??null,rawSha256:raw?hash(raw):null,elapsedMs:performance.now()-started,usage:provider.lastUsage??null,physicalAttempts:provider.lastAttempts??null,costUSD:null,deadlineAt,failures:prior});}
  }
  return {expressions:null,attempts};
 }
 for(const trial of ['cold','warm'])for(const name of trial==='cold'?['native','model','p1']:['p1','model','native']){
  const at=performance.now(),cell:any={name,trial,startedAt:new Date().toISOString(),status:'INCOMPLETE',billingUSD:null,authorityGranted:false};report.cells.push(cell);await save();
  try{
   if(name==='p1'){
    const p=await create({...accepted,idempotencyKey:randomUUID(),proposalSource:'GOVERNED_MODEL',limits:{maxCandidates:4,maxAttempts:4}}),read=await complete(p);cell.program=read;cell.invocations=read.program?.costs??read.incurredCosts;assert.equal(read.status,'TESTED',JSON.stringify(read));const native=await api('program-artifact',{programId:p.programId});assert.equal(native.status,200);const bytes=Buffer.from(native.body.bytesBase64,'base64'),ir=await interpret(bytes);for(const text of ['netEquity: 43','leverage: 3.5','liability'])assert(JSON.stringify(ir).includes(text));await writeFile(join(evidence,'p1-'+trial+'.docx'),bytes);cell.artifact={...native.body,bytesBase64:undefined};cell.noPresetCaseLookup=true;
   }else{
    const d=await sources();cell.sources=d;const sourceValues=d.derivation.result.outputs;cell.currentSources=sourceValues;
    let versionId=name==='native'?nativeVersionId:modelVersionId;
    if(trial==='cold'){
     if(name==='native')cell.actualExistingPlanner=await nativePlanner(d);
     const proposal=name==='native'?{expressions:prepared,attempts:[]}:await modelProposal(d);cell.modelProposal=proposal;if(!proposal.expressions)throw Error('ACTUAL_MODEL_METHOD_UNAVAILABLE');if(name==='model')modelExpressions=proposal.expressions;
     const version=await createUnderwritingModelVersion(ctx,{modelId:String(models[name].id),definition:definition(d,proposal.expressions,name) as any});versionId=String(version.id);if(name==='native')nativeVersionId=versionId;else modelVersionId=versionId;
    }else{assert(versionId,'NO_CHECKED_COLD_PROCEDURE_AVAILABLE');cell.warmRecheck={cachedModelVersionId:versionId,expressionsDigest:hash(name==='native'?prepared:modelExpressions),newSourceDerivationId:d.derivation.id,preparationAmortizationEpisodes:2};}
    const used=await api('evidence-consume',{investmentCaseId,modelVersionId:versionId,worldAt:accepted.validAt,idempotencyKey:randomUUID(),bindings:Object.fromEntries(keys.map(key=>[nativeKey(key),{derivationId:d.derivation.id,output:key}]))});assert.equal(used.status,200,JSON.stringify(used));cell.nativeRun=used.body;assert.equal(used.body.workId,d.workId);for(const key of keys)assert.equal(used.body.inputSnapshot.values[nativeKey(key)].truthClass,'DERIVED_VALUE');cell.artifact=await artifact(d,Object.fromEntries(['netEquity','leverage'].map(key=>[key,used.body.result.outputs[nativeKey(key)]])),name,trial);cell.noP1SynthesisImports=true;
   }
   cell.status='CHECKED_PUBLIC_DRAFT';
  }catch(error){cell.failure=String(error);cell.status='INCOMPLETE';}
  cell.wallMs=performance.now()-at;cell.supervisorResourceSnapshot={usage:process.resourceUsage(),rssBytes:process.memoryUsage().rss,qualification:'SUPERVISOR_SNAPSHOT_NOT_CHILD_OR_AGGREGATE_PEAK'};await save();
 }
 report.finishedAt=new Date().toISOString();report.counts={checkedPublicDrafts:report.cells.filter((c:any)=>c.status==='CHECKED_PUBLIC_DRAFT').length,incomplete:report.cells.filter((c:any)=>c.status==='INCOMPLETE').length,independentQualified:0};await save();return report;
}

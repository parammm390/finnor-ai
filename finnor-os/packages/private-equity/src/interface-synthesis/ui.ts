/** Mechanical disposable browser IR. It never inherits protected browser rights. */
import type {Page} from 'playwright';
import {fail,hash,moduleFor,parseOperation,readModule,type GeneratedInterface,type Operation} from './contracts';
import {wireValue} from './compiler';
import {requireAccess,permittedOrigin,originalAttempt,observeHttp,type PracticePort} from './runtime';
import {existingUiGuard,guardUiPage} from './browser';
function formSelector(operation:Operation){return `form[data-account="${operation.account}"][data-entity="${operation.entity}"]`;}
async function locate(page:Page,operation:Operation){
 const form=page.locator(formSelector(operation));
 if(await form.count()!==1)fail('P5_UI_AMBIGUOUS_ENTITY');
 const control=form.locator(`[data-field="${operation.field}"]`),request=form.locator('[data-role="operationId"]');
 if(await control.count()!==1||await request.count()!==1)fail('P5_UI_AMBIGUOUS_CONTROLS');
 return {form,control,request};
}
async function inspectUi(page:Page,operation:Operation,observerSource:string){
 const {form,control,request}=await locate(page,operation);
 const boundary=await form.getAttribute('data-boundary'),controlName=await control.getAttribute('name'),operationName=await request.getAttribute('name');
 const unit=await control.getAttribute('data-unit'),currency=await control.getAttribute('data-currency'),places=Number(await control.getAttribute('data-places'));
 if(boundary!=='submit'&&boundary!=='autosave')fail('P5_UI_MUTATION_BOUNDARY_UNSUPPORTED');
 if(unit!==operation.unit||currency!==operation.currency||!controlName||!operationName||!Number.isInteger(places)||places<0||places>6)fail('P5_UI_UNIT_OR_FIELD_UNSUPPORTED');
 if(boundary==='submit'&&await form.locator('button[type="submit"]').count()!==1)fail('P5_UI_AMBIGUOUS_SUBMIT');
 const explicitNull=await form.locator('[data-action="explicit-null"]').count()===1;
 if(operation.value===null&&(!explicitNull||boundary==='autosave'))fail('P5_UI_EXPLICIT_NULL_UNSUPPORTED');
 wireValue(operation.value,places,'major_decimal_string');
 const module=moduleFor({schema:'finnor.p5.ui-module.v1',kind:'ADAPTER',entrypoint:'interact',formAttributes:['data-account','data-entity'],
  fieldAttribute:'data-field',controlName,operationName,explicitNull,boundary,decimalPlaces:places,field:operation.field,unit:operation.unit,currency:operation.currency,imports:[],runtime:'ORDINARY_DISPOSABLE_BROWSER',maxActions:6});
 const witness={observerSource,boundary,controlName,operationName,explicitNull,places,unit,currency,field:operation.field};
 return {module,witness,revision:await form.getAttribute('data-revision')};
}
export async function synthesizeUi(page:Page,requested:unknown,observer:GeneratedInterface):Promise<GeneratedInterface>{
 const operation=parseOperation(requested);
 const {module,witness,revision}=await inspectUi(page,operation,observer.sourceDigest);
 if(observer.bindingDigest!==hash(operation))fail('P5_UI_OBSERVER_BINDING');
 if(revision!==operation.priorRevision)fail('P5_UI_STRONG_REVISION_MISMATCH');
 return {...observer,substrate:'UI',sourceDigest:hash(witness),adapterModule:module,
  semanticDigest:hash({observer:observer.semanticDigest,witness}),qualification:'MECHANICAL_DISPOSABLE_UI_AND_INDEPENDENT_API_OBSERVER_NOT_PROTECTED_BROWSER_ADMISSION'};
}
export async function checkUiWitness(generated:GeneratedInterface,operation:Operation,documentDigest:string,port:PracticePort,path:string,onRefused:(body:unknown)=>Promise<void>){
 await requireAccess(port,operation);
 const {chromium}=await import('playwright'),browser=await chromium.launch({headless:true});
 try{
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();
  const guard=await guardUiPage(page,port,operation,path,onRefused);
  await page.goto(new URL(path,port.origin).toString(),{timeout:3000,waitUntil:'networkidle'});
  const {module,witness}=await inspectUi(page,operation,documentDigest);
  if(guard.violations.length||hash(witness)!==generated.sourceDigest||module.digest!==generated.adapterModule.digest)fail('P5_UI_INTERFACE_WITNESS_CHANGED');
 }finally{await browser.close();}
}
export async function practiceUi(page:Page,generated:GeneratedInterface,requested:unknown,port:PracticePort,prior?:Parameters<typeof originalAttempt>[2]){
 const operation=parseOperation(requested),attempt=originalAttempt(generated,operation,prior),module=readModule(generated.adapterModule);
 if(module.schema!=='finnor.p5.ui-module.v1'||generated.substrate!=='UI')fail('P5_UI_MODULE_REQUIRED');
 permittedOrigin(port,operation);
 if(new URL(page.url()).origin!==port.origin)fail('P5_UI_ORIGIN_SUBSTITUTION');
 const guard=existingUiGuard(page)??await guardUiPage(page,port,operation,new URL(page.url()).pathname,async()=>{});
 const observer=readModule(generated.observerModule);
 if(observer.schema!=='finnor.p5.http-module.v1'||observer.kind!=='OBSERVER')fail('P5_UI_INDEPENDENT_OBSERVER_REQUIRED');
 if(guard.violations.length)fail('P5_UI_DISCOVERY_EGRESS_REFUSED');
 if(!attempt.possibleEgress){
  await requireAccess(port,operation);const {form,control,request}=await locate(page,operation);
  if(await form.getAttribute('data-revision')!==operation.priorRevision||await control.getAttribute('name')!==module.controlName||await request.getAttribute('name')!==module.operationName||
   await form.getAttribute('data-boundary')!==module.boundary||await control.getAttribute('data-currency')!==operation.currency||await control.getAttribute('data-unit')!==operation.unit)fail('P5_UI_WITNESS_CHANGED');
  await port.record({stage:'INTENT',attempt,body:{moduleDigest:generated.adapterModule.digest,actions:module.maxActions}});
  // Filling a value may autosave. Original attempt must be durable before any
  // potentially mutating keyboard/pointer action, not just before submit.
  await requireAccess(port,operation);attempt.possibleEgress=true;
  await port.record({stage:'POSSIBLE_EGRESS',attempt,body:{boundary:module.boundary,protectedBrowserAdmission:false}});
  const wire={url:new URL(observer.path.replace('{'+observer.parameters.account+'}',encodeURIComponent(operation.account)).replace('{'+observer.parameters.entity+'}',encodeURIComponent(operation.entity)),port.origin).toString(),
   body:JSON.stringify({[observer.valueField]:wireValue(operation.value,observer.decimalPlaces,observer.encoding)}),revision:operation.priorRevision,operationId:operation.operationId};
  guard.arm(wire);
  const response=page.waitForResponse(r=>r.request().method()==='PATCH'&&r.url()===wire.url,{timeout:2000}).then(()=>true,()=>false);
  try{
   await request.fill(operation.operationId);
   if(module.explicitNull)await form.locator('[data-action="explicit-null"]').setChecked(operation.value===null);
   await control.fill(operation.value===null?'':String(wireValue(operation.value,module.decimalPlaces,'major_decimal_string')));
   if(module.boundary==='submit')await form.locator('button[type="submit"]').click();else await control.press('Tab');
   attempt.acknowledged=await response;
   if(attempt.acknowledged)await port.record({stage:'ACKNOWLEDGED',attempt,body:{toastIsVerification:false,inputQualification:'PLAYWRIGHT_BROWSER_EVENTS_NOT_TRUSTED_OS_ADMISSION'}});
   await page.waitForLoadState('networkidle',{timeout:3000}).catch(()=>{});
  }catch{/* A browser interruption cannot authorize replay or a favorable result. */}
  finally{guard.disarm();}
 }
 const result=await observeHttp(generated,operation,port,attempt);
 if(guard.violations.length){result.status='DISCREPANCY';result.reason='P5_UI_FORBIDDEN_OR_DUPLICATE_EGRESS_REFUSED';}
 await port.record({stage:'COMPLETED',attempt,body:result});return result;
}

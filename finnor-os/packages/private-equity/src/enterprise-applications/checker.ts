/** Independent tree semantics and reverse-translation checker.
 * No compiler, stack executor, decimal helper or acceptance-output imports.
 * This is bounded development verification, not protected oracle custody. */
import {createHash} from 'node:crypto';
import type {BusinessSpecification,ApplicationExpression,ApplicationExecutionContext,ApplicationValue,ApplicationQuantity,ApplicationValues} from './contracts';
import type {ApplicationInstruction,ApplicationProgram,ActionDecision} from './program';
import type {BuiltApplication} from './compiler';

const encode=(v:unknown):string=>Array.isArray(v)?'['+v.map(encode).join(',')+']':v!==null&&typeof v==='object'?
 '{'+Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+encode(x)).join(',')+'}':JSON.stringify(v);
const hash=(v:unknown)=>createHash('sha256').update(encode(v)).digest('hex');
class CheckFault extends Error {constructor(readonly code:string){super(code);}}
const requireThat=(v:unknown,code:string):void=>{if(!v)throw new CheckFault(code);};
const unknown=(reason:string)=>({kind:'UNKNOWN' as const,reason});
const isUnknown=(v:unknown):v is {kind:'UNKNOWN';reason:string}=>!!v&&typeof v==='object'&&'kind' in v&&v.kind==='UNKNOWN';
const unknownOutcome=(reason:string)=>['CURRENCY_MISMATCH','ENTITY_MISMATCH','UNITS_MISMATCH','TIME_MISMATCH',
 'ACCOUNTING_BASIS_MISMATCH','SOURCE_STALE','UNSUPPORTED_THRESHOLD_CURRENCY'].includes(reason)?reason:
 reason.startsWith('MISSING_FIELD:')?'MISSING_FIELD':'UNKNOWN_VALUE';
const cmp=(a:bigint,b:bigint,c:string)=>c==='lt'?a<b:c==='lte'?a<=b:c==='eq'?a===b:c==='gte'?a>=b:a>b;
function rational(s:string):[bigint,bigint]{
 requireThat(typeof s==='string'&&/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(s)&&s.replace('.','').replace(/^0+/,'').length<=38,'INVALID_QUANTITY');
 const [a,b='']=s.split('.');return [BigInt(a!+b),10n**BigInt(b.length)];
}
function compare(a:string,b:string,c:string){const [an,ad]=rational(a),[bn,bd]=rational(b);return cmp(an*bd,bn*ad,c);}
function dimension(q:ApplicationQuantity){const {amount:ignored,...rest}=q;return encode(rest);}
function tree(e:ApplicationExpression,c:ApplicationExecutionContext,values:ApplicationValues,state:string):ApplicationValue{
 switch(e.op){
  case 'literal':return e.value;
  case 'field':return (e.source==='input'?c.input:values)[e.field]??unknown('MISSING_FIELD:'+e.field);
  case 'state':return state===e.is;
  case 'known':return !isUnknown(tree(e.value,c,values,state));
  case 'not':{const v=tree(e.value,c,values,state);return typeof v==='boolean'?!v:v;}
  case 'all':case 'any':{
   const vs=e.args.map(x=>tree(x,c,values,state)),dominant=e.op==='any';
   return vs.includes(dominant)?dominant:vs.find(isUnknown)??!dominant;
  }
  case 'current-evidence':{
   const v=tree(e.value,c,values,state);if(isUnknown(v))return v;
   return c.currentEvidence.some(x=>encode(x)===encode(v))?true:unknown('SOURCE_STALE');
  }
  case 'sum':{
   const v=tree(e.value,c,values,state);if(isUnknown(v))return v;
   if(typeof v!=='object'||!('kind' in v)||v.kind!=='QUANTITY_LIST')throw new CheckFault('INVALID_QUANTITY');
   requireThat(v.entries.length>=1&&v.entries.length<=128,'INVALID_QUANTITY_LIST');
   const first=v.entries[0]!,dim=dimension(first);
   let numerator=0n,denominator=1n;
   for(const q of v.entries){
    if(dimension(q)!==dim)return unknown(q.currency!==first.currency?'CURRENCY_MISMATCH':encode(q.entity)!==encode(first.entity)?'ENTITY_MISMATCH':q.units!==first.units?'UNITS_MISMATCH':encode(q.time)!==encode(first.time)?'TIME_MISMATCH':'ACCOUNTING_BASIS_MISMATCH');
    const [n,d]=rational(q.amount);if(d>denominator){numerator*=d/denominator;denominator=d;}numerator+=n*(denominator/d);
   }
   const places=denominator.toString().length-1,raw=numerator.toString().padStart(places+1,'0');
   const result=places?(raw.slice(0,-places)+'.'+raw.slice(-places)).replace(/0+$/,'').replace(/\.$/,''):raw;
   try{rational(result);}catch{throw new CheckFault('QUANTITY_OVERFLOW');}
   return {...first,amount:result};
  }
  case 'equal':case 'same-quantity':case 'compare':case 'difference':{
   const a=tree(e.left,c,values,state),b=tree(e.right,c,values,state);if(isUnknown(a)||isUnknown(b))return isUnknown(a)?a:b;
   if(e.op==='equal'&&!(typeof a==='object'&&'kind' in a&&a.kind==='QUANTITY'&&typeof b==='object'&&'kind' in b&&b.kind==='QUANTITY'))return encode(a)===encode(b);
   const aq=a as ApplicationQuantity,bq=b as ApplicationQuantity;
   if(dimension(aq)!==dimension(bq))return unknown(aq.currency!==bq.currency?'CURRENCY_MISMATCH':encode(aq.entity)!==encode(bq.entity)?'ENTITY_MISMATCH':aq.units!==bq.units?'UNITS_MISMATCH':encode(aq.time)!==encode(bq.time)?'TIME_MISMATCH':'ACCOUNTING_BASIS_MISMATCH');
   if(e.op==='difference'){
    const [an,ad]=rational(aq.amount),[bn,bd]=rational(bq.amount),d=ad>bd?ad:bd,n=an*(d/ad)-bn*(d/bd),negative=n<0n;
    const places=d.toString().length-1,raw=(negative?-n:n).toString().padStart(places+1,'0');
    const text=places?(raw.slice(0,-places)+'.'+raw.slice(-places)).replace(/0+$/,'').replace(/\.$/,''):raw;
    return (negative?'-':'')+text;
   }
   return compare(aq.amount,bq.amount,e.op==='compare'?e.comparison:'eq');
  }
  case 'currency-threshold':{
   const value=tree(e.value,c,values,state);if(isUnknown(value))return value;
   const q=value as ApplicationQuantity,t=e.thresholds.find(x=>x.currency===q.currency);
   if(!t)return unknown('UNSUPPORTED_THRESHOLD_CURRENCY');
   if(q.units!==t.units)return unknown('UNITS_MISMATCH');
   if(q.accountingBasis!==t.accountingBasis)return unknown('ACCOUNTING_BASIS_MISMATCH');
   if(q.time.kind!==t.timeMode)return unknown('TIME_MISMATCH');
   return compare(q.amount,t.amount,e.comparison);
  }
 }
}
/** Separate semantic projection: tree evaluation and rational coefficients,
 * rather than generated instructions and fixed-scale arithmetic. */
function interpret(spec:BusinessSpecification,c:ApplicationExecutionContext):Pick<ActionDecision,'allowed'|'outcome'|'nextState'|'evaluatedAssignments'>{
 let evaluatedAssignments:ApplicationValues|undefined;
 const record=c.record,state=record?.state,deny=(outcome:string)=>({allowed:false,outcome,...(state?{nextState:state}:{}),...(evaluatedAssignments?{evaluatedAssignments}:{})});
 try{
  const action=spec.actions.find(a=>a.id===c.actionId&&a.entityId===c.entityId);
  if(!action)return deny('UNKNOWN_ACTION');
  if(c.actor.tenantId!==c.tenantId)return deny('TENANT_DENIED');
  if(c.actor.scopeId!==c.scopeId)return deny('SCOPE_DENIED');
  if(!c.actor.authorityCurrent)return deny('AUTHORITY_REVOKED');
  if(!action.roles.some(r=>c.actor.canonicalRoles.includes(spec.model.roles.find(x=>x.id===r)!.canonicalRole)))return deny('ROLE_DENIED');
  if(action.kind!=='create'){
   if(!record||record.entityId!==action.entityId)return deny('RECORD_ENTITY_MISMATCH');
   if(record.releaseId!==c.installedReleaseId)return deny('RELEASE_CHANGED');
   if(record.recordDigest!==c.expectedRecordDigest||encode(record.reference)!==encode(c.expectedRecordReference))return deny('RECORD_REF_MISMATCH');
   if(!action.fromStates.includes(record.state))return deny('INVALID_STATE');
  }
  const entity=spec.model.entities.find(x=>x.id===action.entityId)!;
  let values:ApplicationValues={...record?.values,...c.input};
  if(action.kind==='update')for(const id of new Set(spec.actions.filter(a=>a.entityId===entity.id).flatMap(a=>a.assignments.map(x=>x.field)))){
   if(action.inputFields.includes(id)||action.assignments.some(x=>x.field===id))continue;
   if(entity.fields.find(f=>f.id===id)!.allowUnknown)values[id]=unknown('BUSINESS_CONTENT_CHANGED');else delete values[id];
  }
  const assigned:ApplicationValues={};
  for(const a of action.assignments)assigned[a.field]=tree(a.value,c,values,state??entity.initialState);
  values={...values,...assigned};
  for(const field of entity.fields){
   const value=values[field.id];if(value===undefined){if(field.required)return deny('MISSING_REQUIRED_FIELD');continue;}
   if(isUnknown(value)){if(!field.allowUnknown)return deny('UNKNOWN_NOT_ALLOWED');continue;}
   if(field.type==='quantity'||field.type==='quantity-list'){
    const qs=field.type==='quantity'?[value as ApplicationQuantity]:(value as {entries:ApplicationQuantity[]}).entries;
    for(const q of qs){rational(q.amount);if(!spec.model.currencies.includes(q.currency))return deny('UNSUPPORTED_CURRENCY');}
   }
  }
  evaluatedAssignments=assigned;
  for(const g of action.guards){
   const v=tree(g.condition,c,values,state??entity.initialState);
   if(v!==true)return deny(isUnknown(v)?g.unknownCode??unknownOutcome(v.reason):g.denialCode);
  }
  let pending=false;
  const source=action.approval?action:action.requiresApprovalsFrom?spec.actions.find(a=>a.id===action.requiresApprovalsFrom):undefined;
  if(source?.approval){
   const p=source.approval,required:string[]=[];
   for(const requirement of p.requirements){
    const value=tree(requirement.when,c,values,state!);
    if(isUnknown(value))return deny(unknownOutcome(value.reason));
    if(value===true)required.push(requirement.role);
   }
   if(!required.length)return deny('APPROVAL_POLICY_EMPTY');
   const receipts=c.approvals.filter(r=>r.actionId===source.id);
   for(const r of receipts){
    if(r.recordDigest!==record?.recordDigest||r.releaseId!==c.installedReleaseId||r.tenantId!==c.tenantId||r.scopeId!==c.scopeId||encode(r.recordReference)!==encode(record?.reference))return deny('APPROVAL_BINDING_MISMATCH');
    const canonical=spec.model.roles.find(x=>x.id===r.role)!.canonicalRole;
    if(!c.currentAuthorities.some(a=>a.principalId===r.principalId&&a.canonicalRole===canonical&&a.authorityRevision===r.authorityRevision&&a.current&&a.tenantId===c.tenantId&&a.scopeId===c.scopeId))return deny('APPROVER_AUTHORITY_REVOKED');
   }
   if(action.approval){
    if(p.noSelfApproval&&c.actor.principalId===record!.authorPrincipalId)return deny('SELF_APPROVAL_DENIED');
    const roles=required.filter(r=>c.actor.canonicalRoles.includes(spec.model.roles.find(x=>x.id===r)!.canonicalRole));
    const role=c.approvalRole??roles.find(r=>receipts.some(x=>x.role===r&&x.principalId===c.actor.principalId))??roles.find(r=>!receipts.some(x=>x.role===r));
    if(!role||!roles.includes(role))return deny('ROLE_DENIED');
    const prior=receipts.find(r=>r.role===role);
    if(prior&&prior.principalId!==c.actor.principalId)return deny('APPROVAL_ALREADY_RECORDED');
    if(!prior){
     if(p.distinctPrincipals&&receipts.some(r=>r.principalId===c.actor.principalId))return deny('PRINCIPAL_SEPARATION_DENIED');
     receipts.push({role,actionId:action.id,principalId:c.actor.principalId,recordDigest:record!.recordDigest,recordReference:record!.reference,releaseId:c.installedReleaseId,authorityRevision:c.actor.authorityRevision,tenantId:c.tenantId,scopeId:c.scopeId});
    }
   }
   pending=required.some(role=>!receipts.some(r=>r.role===role));
   if(pending&&action.requiresApprovalsFrom)return deny('APPROVALS_INCOMPLETE');
  }
  const nextState=pending?state!:action.toState;
  for(const i of spec.invariants.filter(i=>i.entityId===entity.id))if(tree(i.condition,c,values,nextState)!==true)return deny(i.denialCode);
  return {allowed:true,outcome:pending?action.approval!.pendingOutcome:action.outcome,nextState,evaluatedAssignments};
 }catch(error){return deny(error instanceof CheckFault?error.code:'INDEPENDENT_INTERPRETER_UNSUPPORTED');}
}
function decompile(code:ApplicationInstruction[]):ApplicationExpression{
 const stack:ApplicationExpression[]=[],pop=()=>{const x=stack.pop();if(!x)throw new CheckFault('STACK_UNDERFLOW');return x;};
 for(const i of code){
  if(i.op==='PUSH')stack.push({op:'literal',value:i.value});
  else if(i.op==='LOAD')stack.push({op:'field',source:i.source,field:i.field});
  else if(i.op==='STATE')stack.push({op:'state',is:i.is});
  else if(i.op==='ALL'||i.op==='ANY'){requireThat(stack.length>=i.count,'STACK_UNDERFLOW');stack.push({op:i.op==='ALL'?'all':'any',args:stack.splice(stack.length-i.count,i.count)});}
  else if(i.op==='CURRENCY_THRESHOLD')stack.push({op:'currency-threshold',value:pop(),comparison:i.comparison,thresholds:i.thresholds});
  else if(i.op==='EQUAL'||i.op==='SAME_QUANTITY'||i.op==='COMPARE'||i.op==='DIFFERENCE'){
   const right=pop(),left=pop();stack.push(i.op==='COMPARE'?{op:'compare',comparison:i.comparison,left,right}:{op:i.op==='EQUAL'?'equal':i.op==='DIFFERENCE'?'difference':'same-quantity',left,right});
  }else stack.push({op:({SUM:'sum',KNOWN:'known',CURRENT_EVIDENCE:'current-evidence',NOT:'not'} as const)[i.op],value:pop()});
 }
 requireThat(stack.length===1,'STACK_RESULT_ARITY');return stack[0]!;
}
export interface ApplicationCheck {
 schema:'finnor.x3.independent-check.v1';status:'PASS'|'FAIL';specificationDigest:string;programDigest:string;
 methods:string[];caseIds:string[];criticalRequirements:string[];checks:{id:string;pass:boolean;expected:unknown;actual:unknown}[];
 protectedCustody:false;wholeSystemProof:false;
}
export function checkBuiltApplication(spec:BusinessSpecification,built:BuiltApplication,execute:(p:ApplicationProgram,c:ApplicationExecutionContext)=>ActionDecision):ApplicationCheck{
 const retain=(v:unknown)=>encode(v)?.length>4096?{contentDigest:hash(v),bytes:Buffer.byteLength(encode(v)),preimage:'EXACT_SPECIFICATION_OR_RELEASE_ASSET'}:v;
 const checks:ApplicationCheck['checks']=[],check=(id:string,expected:unknown,actual:unknown)=>checks.push({id,pass:encode(expected)===encode(actual),expected:retain(expected),actual:retain(actual)});
 const p=built.program,critical=spec.requirements.filter(r=>r.critical).map(r=>r.id);
 try{
  check('identity',{id:spec.id,version:spec.version,title:spec.title,owner:spec.owner},p.identity);
  check('specification-digest',hash(spec),p.specificationDigest);check('model',spec.model,p.model);check('requirements',spec.requirements,p.requirements);
  check('actions',spec.actions,p.actions.map(a=>{
   const {assignments,guards,approval,...rest}=a;return {...rest,
    assignments:assignments.map(({code,...r})=>({...r,value:decompile(code)})),
    guards:guards.map(({code,...r})=>({...r,condition:decompile(code)})),
    ...(approval?{approval:{...approval,requirements:approval.requirements.map(({code,...r})=>({...r,when:decompile(code)}))}}:{})};
  }));
  check('invariants',spec.invariants,p.invariants.map(({code,...r})=>({...r,condition:decompile(code)})));
  check('asset-coverage',['backend/program.json','frontend/forms.json','dependencies.json',...spec.model.entities.map(e=>'forms/'+encodeURIComponent(e.id)+'.html')].sort(),built.sources.map(s=>s.path).sort());
  for(const s of built.sources)check('asset:'+s.path,createHash('sha256').update(s.bytes).digest('hex'),s.digest);
  check('backend-asset',encode(p),built.sources.find(s=>s.path==='backend/program.json')?.bytes);
  check('frontend-asset',encode(built.frontend),built.sources.find(s=>s.path==='frontend/forms.json')?.bytes);
  check('form-entities',spec.model.entities.map(e=>({id:e.id,fields:e.fields,actions:spec.actions.filter(a=>a.entityId===e.id).map(a=>a.id)})),
   built.frontend.entities.map(e=>({id:e.entityId,fields:e.fields.map(({encoding:ignored,unknownEncoding:alsoIgnored,...f})=>f),actions:e.actions.map(a=>a.id)})));
  check('no-guest-dependencies',[],built.dependencyManifest.executableGuestDependencies);
  for(const id of critical)check('critical-case-coverage:'+id,true,spec.acceptanceCases.some(c=>c.requirementIds.includes(id)));
  for(const c of spec.acceptanceCases){
   const candidate=execute(p,c.input),oracle=interpret(spec,c.input),project=(d:Pick<ActionDecision,'allowed'|'outcome'|'nextState'>)=>({
    allowed:d.allowed,outcome:d.outcome,...(c.expected.nextState===undefined?{}:{nextState:d.nextState})});
   check('literal:'+c.id,c.expected,project(candidate));check('tree:'+c.id,c.expected,project(oracle));
   if(candidate.evaluatedAssignments!==undefined&&oracle.evaluatedAssignments!==undefined)check('independent-assigned-values:'+c.id,oracle.evaluatedAssignments,candidate.evaluatedAssignments);
  }
 }catch(error){checks.push({id:'checker-refusal',pass:false,expected:'COMPLETE_SUPPORTED_CHECK',actual:String(error)});}
 return {schema:'finnor.x3.independent-check.v1',status:checks.every(c=>c.pass)?'PASS':'FAIL',specificationDigest:hash(spec),programDigest:hash(p),
  methods:['REVERSE_TRANSLATION_EQUIVALENCE','INDEPENDENT_RATIONAL_TREE_INTERPRETER','LITERAL_VECTOR_EXECUTION'],caseIds:spec.acceptanceCases.map(c=>c.id),criticalRequirements:critical,checks,protectedCustody:false,wholeSystemProof:false};
}

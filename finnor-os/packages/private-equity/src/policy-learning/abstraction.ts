import {applicationCanonical,parseBusinessSpecification,type BusinessSpecification,type ApplicationExpression,type ApplicationAction,type ApplicationValues} from '../enterprise-applications/contracts';
import {applicationSumQuantities,applicationDimensionMismatch,applicationExactInteger} from '../enterprise-applications/exact';
import {PolicySchema,sha,fail,type BoundedPolicy,type ControllerClass} from './contracts';

export interface ReconciliationBinding{
 entityId:string;initialState:string;reconciledState:string;acceptedState:string;
 reconciliationAction:string;approvalAction:string;leftField:string;rightField:string;totalField:string;deltaField:string;
 evidenceFields:string[];statusFields:string[];supported:boolean;semanticsDigest:string;specificationDigest:string;
}
function conjunction(e:ApplicationExpression):ApplicationExpression[]{
 return e.op==='all'?e.args.flatMap(conjunction):[e];
}
function guards(action:ApplicationAction){return action.guards.flatMap(g=>conjunction(g.condition));}
function sumField(e:ApplicationExpression):string|null{
 return e.op==='sum'&&e.value.op==='field'&&e.value.source==='record'?e.value.field:null;
}
function evidenceFields(action:ApplicationAction){
 return guards(action).flatMap(e=>e.op==='current-evidence'&&e.value.op==='field'&&e.value.source==='record'?[e.value.field]:[]);
}
function fieldLiteral(e:ApplicationExpression,field:string,value:string){
 return e.op==='equal'&&(
  e.left.op==='field'&&e.left.source==='record'&&e.left.field===field&&e.right.op==='literal'&&e.right.value===value||
  e.right.op==='field'&&e.right.source==='record'&&e.right.field===field&&e.left.op==='literal'&&e.left.value===value);
}
function statusGuarded(action:ApplicationAction,field:string){
 const clauses=guards(action);
 return clauses.some(e=>fieldLiteral(e,field,'KNOWN'))||
  ['UNKNOWN','CONFLICTING'].every(value=>clauses.some(e=>e.op==='not'&&fieldLiteral(e.value,field,value)));
}
function originalApprovalFloor(action:ApplicationAction,totalField:string){
 const requirements=action.approval!.requirements;
 return requirements.some(v=>v.when.op==='literal'&&v.when.value===true)&&requirements.some(v=>{
  const e=v.when;
  return e.op==='currency-threshold'&&e.comparison==='gte'&&e.value.op==='field'&&e.value.source==='record'&&e.value.field===totalField&&
   ['USD','INR'].every(currency=>e.thresholds.some(t=>t.currency===currency&&t.units==='minor'&&t.accountingBasis==='RECORDED_MINOR'&&t.timeMode==='AS_OF'&&
    applicationExactInteger(t.amount)<=applicationExactInteger('100000')));
 });
}
/** Semantic dominance is independent of names, prose and applicant-supplied cases.
 * An equality under ANY/NOT cannot establish a mandatory reconciliation. */
export function bindReconciliation(raw:unknown):ReconciliationBinding{
 const spec=parseBusinessSpecification(raw);
 const candidates=spec.actions.filter(a=>a.kind==='transition'&&!a.approval&&!a.preparedEffect&&!a.inputFields.length&&guards(a).some(e=>e.op==='same-quantity'&&sumField(e.left)&&sumField(e.right)));
 const viable=candidates.flatMap(action=>{
  const eq=guards(action).filter((e):e is Extract<ApplicationExpression,{op:'equal'|'same-quantity'|'difference'}>=>e.op==='same-quantity');
  const total=action.assignments.find(a=>sumField(a.value));
  const delta=action.assignments.find(a=>a.value.op==='difference'&&sumField(a.value.left)&&sumField(a.value.right));
  if(!total||!delta||delta.value.op!=='difference')return [];
  const left=sumField(delta.value.left)!,right=sumField(delta.value.right)!;
  if(left===right||sumField(total.value)!==left||!eq.some(e=>[sumField(e.left),sumField(e.right)].sort().join('|')===[left,right].sort().join('|')))return [];
  if(action.assignments.length!==2||total.field===delta.field||[left,right].some(f=>action.assignments.some(a=>a.field===f)))return [];
  const entity=spec.model.entities.find(e=>e.id===action.entityId);
  const approval=spec.actions.filter(a=>a.entityId===action.entityId&&a.approval?.noSelfApproval&&a.approval.distinctPrincipals&&a.fromStates.length===1&&a.fromStates[0]===action.toState&&a.kind==='transition'&&!a.preparedEffect&&!a.assignments.length);
  if(!entity||action.fromStates.length!==1||action.fromStates[0]!==entity.initialState||approval.length!==1)return [];
  const check=approval[0]!,observations=[...new Set(evidenceFields(action))].sort();
  if(observations.length<2||observations.some(f=>!evidenceFields(check).includes(f)))return [];
  if(entity.fields.filter(f=>f.required&&f.type==='evidence').some(f=>!observations.includes(f.id)))return [];
  if(![left,right].every(f=>entity.fields.some(v=>v.id===f&&v.type==='quantity-list')))return [];
  // No other legal transition path may reach acceptance while omitting the
  // identified reconciliation edge, including renamed permissive workflows.
  const reached=new Set([entity.initialState]);
  for(let i=0;i<16;i++)for(const edge of spec.actions.filter(a=>a.entityId===entity.id&&a.id!==action.id&&a.kind!=='create')){
   if(edge.fromStates.some(s=>reached.has(s)))reached.add(edge.toState);
  }
  if(reached.has(check.toState)||check.toState===entity.initialState||check.toState===action.toState)return [];
  const statusFields=entity.fields.filter(f=>f.type==='enum'&&f.options?.includes('KNOWN')&&f.options.includes('UNKNOWN')&&f.options.includes('CONFLICTING')).map(f=>f.id);
  if(statusFields.length<2||statusFields.some(f=>!statusGuarded(action,f)||!statusGuarded(check,f))||!originalApprovalFloor(check,total.field))return [];
  if(![left,right].every(f=>[action,check].every(a=>guards(a).some(e=>e.op==='known'&&e.value.op==='field'&&e.value.source==='record'&&e.value.field===f))))return [];
  const semantic={entity:entity.id,reconciliation:action,approval:check,invariants:spec.invariants};
  return [{entityId:entity.id,initialState:entity.initialState,reconciledState:action.toState,acceptedState:check.toState,
   reconciliationAction:action.id,approvalAction:check.id,leftField:left,rightField:right,totalField:total.field,deltaField:delta.field,
   evidenceFields:observations,statusFields,supported:eq.length===1,semanticsDigest:sha(semantic),specificationDigest:sha(spec)}];
 });
 if(viable.length!==1)fail('X5_MANDATORY_RECONCILIATION_CONTRACT_REQUIRED',422);
 return viable[0]!;
}
export function structuralState(binding:ReconciliationBinding,record:{state:string;values:ApplicationValues;currentness:string;pendingEffectId?:string|null}){
 const a=record.values[binding.leftField],b=record.values[binding.rightField];
 const lists=a&&typeof a==='object'&&'kind'in a&&a.kind==='QUANTITY_LIST'&&b&&typeof b==='object'&&'kind'in b&&b.kind==='QUANTITY_LIST';
 let known=!!lists&&binding.statusFields.every(f=>record.values[f]==='KNOWN'),agreement=false;
 try{
  if(lists){
   const x=applicationSumQuantities(a.entries),y=applicationSumQuantities(b.entries);
   if(x.kind==='QUANTITY'&&y.kind==='QUANTITY')agreement=!applicationDimensionMismatch(x,y)&&applicationExactInteger(x.amount)===applicationExactInteger(y.amount);
   else known=false;
  }
 }catch{known=false;}
 return [1,+known,+agreement,+(record.currentness==='CURRENT'),+!record.pendingEffectId,+(record.state===binding.initialState),+(record.state===binding.reconciledState),+(record.state===binding.acceptedState)];
}
export function lawfulStructuralLabel(features:readonly number[]):ControllerClass{
 if(!features[4]||!features[1]||!features[2]||!features[3])return 'WAIT';
 return features[7]?'STOP_ACCEPTED':features[6]?'REQUEST_INDEPENDENT_CHECK':features[5]?'RECONCILE':'WAIT';
}
export function compilePolicy(deadlineAt:string,maxUses:number):BoundedPolicy{
 return PolicySchema.parse({schema:'finnor.x5.bounded-policy.v1',profile:'PE_FIRM_DELAYED_RECONCILIATION_V1',
  input:'CURRENT_NATIVE_X3_RECORD_AND_FRESH_SEMANTIC_BINDING',abstraction:'STRUCTURAL_BOOLEANS_8_V1',
  instructions:['OBSERVE_CURRENT_OWNER_STATE','LOAD_EXACT_CONTROLLER','CLASSIFY','ENFORCE_NATIVE_PRECONDITIONS','DISPATCH_RECONCILIATION_OR_WAIT','REQUIRE_CURRENT_INDEPENDENT_ACCEPTANCE'],
  operations:['X3_READ_CURRENT_RECORD','X3_EXACT_RECONCILIATION','X3_REQUEST_INDEPENDENT_APPROVAL'],
  preconditions:['CURRENT_TENANT_PRINCIPAL_WORK_RIGHTS','COMPLETE_OBSERVATIONS','EXACT_DIMENSIONS','NO_PENDING_EFFECT','ORIGINAL_RESOURCES'],
  postconditions:['MANDATORY_RECONCILIATION_PRECEDES_ACCEPTANCE','DISTINCT_CURRENT_NONAUTHOR_APPROVERS','NATIVE_EXACT_VALUES_UNCHANGED'],
  guard:'CURRENT_CONSENT_AND_SOURCE_CLOSURE_AND_SUPPORTED_BINDING_AND_NATIVE_INTERPRETER',
  failureMonitor:'NO_MODEL_AUTHORITY_NO_EFFECT_REPLAY_NO_FALSE_COMPLETION',
  fallback:'CURRENT_NATIVE_X3_INTERPRETER_OR_WAIT_BLOCK_STOP_WITHIN_ORIGINAL_GRANT',
  invalidation:'EVIDENCE_RIGHTS_PARTITIONS_POLICY_CHECKPOINT_OPERATIONS_CHECKER_RUNTIME_ADMISSION',
  bounds:{maxUses,deadlineAt,childWallMs:30000,childHeapMiB:256}});
}
export function bindingMatches(spec:BusinessSpecification,binding:ReconciliationBinding){return applicationCanonical(bindReconciliation(spec))===applicationCanonical(binding);}

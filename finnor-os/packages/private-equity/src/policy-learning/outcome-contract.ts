/** Independent exact outcome semantics. No imports from the candidate binder,
 * feature extractor, trainer, interpreter, compiler or checker. */
import type {ApplicationExpression,ApplicationQuantity,ApplicationValues,BusinessSpecification} from '../enterprise-applications/contracts';
import {sha} from './contracts';
export type ExactQuantity={kind:'EXACT';amount:bigint;dimension:unknown;sample:ApplicationQuantity};
export function number(v:string){
 if(!/^(0|[1-9]\d*)(\.\d{1,12})?$/.test(v)||v.length>51)throw Error('UNSUPPORTED_EXACT_AMOUNT');
 const [a,b='']=v.split('.');return BigInt(a!)*10n**12n+BigInt(b.padEnd(12,'0'));
}
export function decimal(v:bigint){
 const negative=v<0n;v=negative?-v:v;
 const fraction=(v%10n**12n).toString().padStart(12,'0').replace(/0+$/,'');
 return (negative?'-':'')+(v/10n**12n).toString()+(fraction?'.'+fraction:'');
}
export function quantity(value:unknown):ExactQuantity{
 const q=value as ApplicationQuantity;
 if(!q||q.kind!=='QUANTITY')throw Error('UNKNOWN_QUANTITY');
 return {kind:'EXACT',amount:number(q.amount),dimension:{currency:q.currency,entity:q.entity,units:q.units,time:q.time,accountingBasis:q.accountingBasis},sample:q};
}
export function total(value:unknown):ExactQuantity{
 const v=value as {kind:string;entries:ApplicationQuantity[]};
 if(!v||v.kind!=='QUANTITY_LIST'||!v.entries?.length)throw Error('UNKNOWN_LIST');
 const rows=v.entries.map(quantity),base=rows[0]!;
 if(rows.some(r=>sha(r.dimension)!==sha(base.dimension)))throw Error('INCONSISTENT_DIMENSIONS');
 return {...base,amount:rows.reduce((n,q)=>n+q.amount,0n)};
}
function exact(value:unknown):ExactQuantity{
 return value&&typeof value==='object'&&'kind'in value&&value.kind==='EXACT'?value as ExactQuantity:quantity(value);
}
function compare(a:bigint,b:bigint,op:string){return op==='lt'?a<b:op==='lte'?a<=b:op==='eq'?a===b:op==='gt'?a>b:a>=b;}
export function expression(e:ApplicationExpression,values:ApplicationValues,state:string,current:unknown[]):unknown{
 const get=(x:ApplicationExpression)=>expression(x,values,state,current);
 switch(e.op){
  case 'literal':return e.value;
  case 'field':if(e.source!=='record')throw Error('INPUT_GUARD_UNSUPPORTED');return values[e.field];
  case 'sum':return total(get(e.value));
  case 'state':return state===e.is;
  case 'all':return e.args.every(x=>get(x)===true);
  case 'any':return e.args.some(x=>get(x)===true);
  case 'not':return get(e.value)===false;
  case 'known':{const v=get(e.value);return v!==undefined&&v!==null&&!(typeof v==='object'&&'kind'in v&&v.kind==='UNKNOWN');}
  case 'current-evidence':return current.some(v=>sha(v)===sha(get(e.value)));
  case 'equal':return sha(get(e.left)??null)===sha(get(e.right)??null);
  case 'same-quantity':{const a=exact(get(e.left)),b=exact(get(e.right));return sha(a.dimension)===sha(b.dimension)&&a.amount===b.amount;}
  case 'difference':{const a=exact(get(e.left)),b=exact(get(e.right));if(sha(a.dimension)!==sha(b.dimension))throw Error('DIMENSIONS');return decimal(a.amount-b.amount);}
  case 'compare':{const a=exact(get(e.left)),b=exact(get(e.right));return sha(a.dimension)===sha(b.dimension)&&compare(a.amount,b.amount,e.comparison);}
  case 'currency-threshold':{
   const a=exact(get(e.value)),q=a.sample,t=e.thresholds.find(t=>t.currency===q.currency&&t.units===q.units&&t.accountingBasis===q.accountingBasis&&t.timeMode===q.time.kind);
   return !!t&&compare(a.amount,number(t.amount),e.comparison);
  }
 }
}
export function children(e:ApplicationExpression):ApplicationExpression[]{return e.op==='all'?e.args.flatMap(children):[e];}
export function sumField(e:ApplicationExpression){return e.op==='sum'&&e.value.op==='field'&&e.value.source==='record'?e.value.field:null;}
export function originalMethod(spec:BusinessSpecification,entityId:string){
 const possible=spec.actions.filter(action=>action.entityId===entityId&&action.kind==='transition'&&!action.approval&&!action.preparedEffect&&
  action.assignments.some(v=>sumField(v.value))&&action.guards.flatMap(g=>children(g.condition)).some(x=>x.op==='same-quantity'));
 if(possible.length!==1)return null;
 const rec=possible[0]!,delta=rec.assignments.find(v=>v.value.op==='difference');
 if(!delta||delta.value.op!=='difference')return null;
 const left=sumField(delta.value.left),right=sumField(delta.value.right),value=rec.assignments.find(v=>sumField(v.value)===left);
 if(rec.inputFields.length||rec.assignments.length!==2||new Set(rec.assignments.map(v=>v.field)).size!==2||
  rec.assignments.some(v=>v.field===left||v.field===right))return null;
 const initial=spec.model.entities.find(v=>v.id===entityId)?.initialState;
 const check=spec.actions.filter(action=>action.entityId===entityId&&action.approval?.noSelfApproval&&action.approval.distinctPrincipals&&
  action.fromStates.length===1&&action.fromStates[0]===rec.toState&&!action.assignments.length&&!action.preparedEffect);
 if(!left||!right||left===right||!value||rec.fromStates.length!==1||rec.fromStates[0]!==initial||check.length!==1)return null;
 const primaryEquality=rec.guards.flatMap(v=>children(v.condition)).some(e=>e.op==='same-quantity'&&
  [sumField(e.left),sumField(e.right)].sort().join('|')===[left,right].sort().join('|'));
 return primaryEquality?{rec,check:check[0]!,left,right,valueField:value.field,deltaField:delta.field,initial}:null;
}

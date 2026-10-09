import {ExactControlError,ControlFraction as Q,controlMeter,type ExactControlBudget} from './exact';
/** JSON.parse alone silently drops duplicate members. Validate the lexical
 * source as well; source rational limits apply to every nested semantic label.
 * Derived certificate quantities have their separately bounded wire domain. */
export function readOriginalExactJson(bytes:string,budget:ExactControlBudget):unknown{
 let value:unknown;try{value=JSON.parse(bytes);}catch{throw new ExactControlError('UNSUPPORTED','ORIGINAL_MODEL_JSON');}
 const meter=controlMeter(budget);let at=0;
 const fail=(p:string):never=>{throw new ExactControlError('UNSUPPORTED',p);};
 const space=()=>{while(/\s/.test(bytes[at]??'')&&at<bytes.length)at++;};
 function string(){const start=at++;while(at<bytes.length){const c=bytes[at++]!;if(c==='"')return JSON.parse(bytes.slice(start,at)) as string;if(c==='\\')at++;}return fail('ORIGINAL_MODEL_JSON');}
 function token(depth:number){meter.step();if(depth>128)fail('ORIGINAL_SOURCE_STRUCTURE_BOUND');space();const c=bytes[at];
  if(c==='{'){at++;space();const keys=new Set<string>();if(bytes[at]==='}'){at++;return;}for(;;){space();const key=string();if(keys.has(key))fail('DUPLICATE_JSON_MEMBER');keys.add(key);space();at++;token(depth+1);space();if(bytes[at++]==='}')return;}}
  else if(c==='['){at++;space();if(bytes[at]===']'){at++;return;}for(;;){token(depth+1);space();if(bytes[at++]===']')return;}}
  else if(c==='"')string();else {while(at<bytes.length&&!/[,\]}\s]/.test(bytes[at]!))at++;}
 }
 token(0);
 function original(v:unknown,depth:number){meter.step();if(depth>128)fail('ORIGINAL_SOURCE_STRUCTURE_BOUND');
  if(typeof v==='number'&&!Number.isSafeInteger(v))fail('FLOAT64_SOURCE_NOT_EXACT');
  if(!v||typeof v!=='object')return;
  if(!Array.isArray(v)&&(Object.hasOwn(v,'numerator')||Object.hasOwn(v,'denominator'))){Q.read(v);return;}
  for(const item of Object.values(v))original(item,depth+1);
 }
 original(value,0);return value;
}

import {createHash} from 'node:crypto';
import type {ControlRational} from '@finnor/shared-types';

export class ExactControlError extends Error {
 constructor(readonly disposition:'INCOMPLETE'|'UNSUPPORTED'|'UNKNOWN',readonly predicate:string){super(predicate);}
}
export const R1_LIMITS=Object.freeze({states:128,actions:8,periods:12,worlds:512,inputBytes:2*1024*1024,inputDigits:128,intermediateDigits:512,steps:4000000,policyNodes:50000});
const integer=/^-?(?:0|[1-9]\d*)$/;
function gcd(a:bigint,b:bigint):bigint{a=a<0n?-a:a;while(b){[a,b]=[b,a%b];}return a;}
export class ControlFraction {
 readonly n:bigint;readonly d:bigint;
 constructor(n:bigint,d:bigint=1n){if(d<=0n)throw new ExactControlError('UNSUPPORTED','RATIONAL_DENOMINATOR');const g=gcd(n,d);this.n=n/g;this.d=d/g;if(this.n.toString().length>R1_LIMITS.intermediateDigits||this.d.toString().length>R1_LIMITS.intermediateDigits)throw new ExactControlError('INCOMPLETE','RATIONAL_INTEGER_GROWTH_BOUND');}
 static read(value:unknown):ControlFraction {
  return ControlFraction.readBound(value,R1_LIMITS.inputDigits);
 }
 static readDerived(value:unknown):ControlFraction {return ControlFraction.readBound(value,R1_LIMITS.intermediateDigits);}
 private static readBound(value:unknown,digits:number):ControlFraction {
  const v=value as ControlRational;if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!=='denominator,numerator'||typeof v.numerator!=='string'||typeof v.denominator!=='string'||!integer.test(v.numerator)||!integer.test(v.denominator)||v.numerator.length>digits||v.denominator.length>digits)throw new ExactControlError('UNSUPPORTED','RATIONAL_SOURCE_ENCODING');
  return new ControlFraction(BigInt(v.numerator),BigInt(v.denominator));
 }
 add(b:ControlFraction){return new ControlFraction(this.n*b.d+b.n*this.d,this.d*b.d);}
 sub(b:ControlFraction){return new ControlFraction(this.n*b.d-b.n*this.d,this.d*b.d);}
 mul(b:ControlFraction){return new ControlFraction(this.n*b.n,this.d*b.d);}
 compare(b:ControlFraction){const x=this.n*b.d-b.n*this.d;return x<0n?-1:x>0n?1:0;}
 wire():ControlRational{return {numerator:String(this.n),denominator:String(this.d)};}
 key(){return this.n+'/'+this.d;}
}
export const CQ_ZERO=new ControlFraction(0n),CQ_ONE=new ControlFraction(1n);
export function controlCanonical(value:unknown):string{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(controlCanonical).join(',')+']';
 const v=value as Record<string,unknown>;
 if(Object.hasOwn(v,'numerator')||Object.hasOwn(v,'denominator'))return JSON.stringify(ControlFraction.readDerived(v).wire());
 return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+controlCanonical(v[k])).join(',')+'}';
}
export const controlBytesDigest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export interface ExactControlBudget {deadlineAt:number;maxSteps:number;signal?:AbortSignal;onStep?:(steps:number)=>void;account?:{steps:number}}
export function controlMeter(budget:ExactControlBudget){
 if(!Number.isFinite(budget.deadlineAt)||!Number.isSafeInteger(budget.maxSteps)||budget.maxSteps<1||budget.maxSteps>R1_LIMITS.steps)throw new ExactControlError('UNSUPPORTED','ORIGINAL_R1_BUDGET_REQUIRED');
 const account=budget.account??{steps:0};return {step(n=1){account.steps+=n;budget.signal?.throwIfAborted();if(account.steps>budget.maxSteps)throw new ExactControlError('INCOMPLETE','ORIGINAL_R1_STEP_BOUND');if(Date.now()>=budget.deadlineAt)throw new ExactControlError('INCOMPLETE','ORIGINAL_R1_DEADLINE');budget.onStep?.(account.steps);},get steps(){return account.steps;}};
}

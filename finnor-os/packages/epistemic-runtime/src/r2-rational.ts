import {ExperimentRational} from './experiment-numerics';

/** Original decimal/integer/rational tokens only. No Float64 trajectory conversion. */
export function r2Quantity(value:string):ExperimentRational {
  if(typeof value!=='string'||value.length>1025||!/^[-+]?(?:0|[1-9]\d*)(?:\.\d+)?(?:\/[1-9]\d*)?$/.test(value))throw Error('R2_INVALID_RATIONAL');
  const [top,bottom]=value.split('/');
  if(bottom&&top!.includes('.'))throw Error('R2_INVALID_RATIONAL');
  let n:bigint,d:bigint;
  if(bottom){n=BigInt(top!);d=BigInt(bottom);}else{const [a,b='']=top!.split('.');d=10n**BigInt(b.length);n=BigInt(a!.replace(/^[+]/,''))*d+(a!.startsWith('-')?-1n:1n)*BigInt(b||'0');}
  if(n.toString().length>512||d.toString().length>512)throw Error('R2_RATIONAL_PRECISION_LIMIT');
  return new ExperimentRational(n,d);
}
/** A finite measurement's decimal report, never an original exact-model token. */
export function r2MeasuredQuantity(value:number):ExperimentRational {
  if(!Number.isFinite(value))throw Error('R2_NONFINITE_MEASUREMENT');
  const report=String(value),at=report.search(/[eE]/);
  if(at<0)return r2Quantity(report);
  const amount=r2Quantity(report.slice(0,at)),shift=Number(report.slice(at+1));
  return shift>=0?amount.mul(r2Quantity('1'+'0'.repeat(shift))):amount.div(r2Quantity('1'+'0'.repeat(-shift)));
}
export const r2String=(q:ExperimentRational):string=>{if(q.n.toString().length>512||q.d.toString().length>512)throw Error('R2_RATIONAL_PRECISION_LIMIT');return q.d===1n?q.n.toString():`${q.n}/${q.d}`;};
export const r2Zero=()=>r2Quantity('0');
export const r2Sum=(v:ExperimentRational[])=>v.reduce((a,b)=>a.add(b),r2Zero());
export function r2Divide(a:ExperimentRational,b:ExperimentRational):ExperimentRational {if(b.n===0n)throw Error('R2_ZERO_DIVISOR');return new ExperimentRational(a.n*b.d*(b.n<0n?-1n:1n),a.d*(b.n<0n?-b.n:b.n));}
export function r2Lcm(a:bigint,b:bigint):bigint {let x=a,y=b;while(y){const r=x%y;x=y;y=r;}const n=a/x*b;if(n.toString().length>2048)throw Error('R2_ROW_PRECISION_LIMIT');return n;}

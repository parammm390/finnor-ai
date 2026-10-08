/** Exact bounded decimal arithmetic. Financial values never pass through Number. */
export interface ExactDecimal {n:bigint;s:number}
const pow=(s:number)=>{if(!Number.isInteger(s)||s<0||s>512)throw Error('DECIMAL_EXPONENT_BOUND');return 10n**BigInt(s);};
export function parseExact(input:string):ExactDecimal{
 if(typeof input!=='string'||input.length>256||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d{1,3})?$/.test(input))throw Error('EXACT_DECIMAL_REQUIRED');
 const [mantissa,exp='0']=input.split(/[eE]/);const exponent=Number(exp);if(Math.abs(exponent)>100)throw Error('DECIMAL_EXPONENT_BOUND');
 const negative=mantissa!.startsWith('-');const clean=mantissa!.replace(/^[-+]/,'');const [whole,fraction='']=clean.split('.');let n=BigInt((whole||'0')+fraction)*(negative?-1n:1n),s=fraction.length-exponent;
 if(s<0){n*=pow(-s);s=0;}while(s>0&&n%10n===0n){n/=10n;s--;}return {n,s};
}
export function formatExact(a:ExactDecimal):string{let n=a.n,s=a.s;while(s>0&&n%10n===0n){n/=10n;s--;}const negative=n<0n;n=negative?-n:n;let digits=n.toString();if(digits.length+s>2048)throw Error('DECIMAL_OUTPUT_BOUND');if(s){digits=digits.padStart(s+1,'0');digits=digits.slice(0,-s)+'.'+digits.slice(-s);}return (negative?'-':'')+digits;}
export const canonicalExact=(a:string)=>formatExact(parseExact(a));
export function exactCompare(a:string,b:string):number{const x=parseExact(a),y=parseExact(b),s=Math.max(x.s,y.s),d=x.n*pow(s-x.s)-y.n*pow(s-y.s);return d<0n?-1:d>0n?1:0;}
export function exactBinary(op:'add'|'subtract'|'multiply'|'ratio'|'growth',a:string,b:string,places=18):string{
 const x=parseExact(a),y=parseExact(b);
 if(op==='multiply')return formatExact({n:x.n*y.n,s:x.s+y.s});
 if(op==='add'||op==='subtract'){const s=Math.max(x.s,y.s);return formatExact({n:x.n*pow(s-x.s)+(op==='add'?1n:-1n)*y.n*pow(s-y.s),s});}
 if(y.n===0n)throw Error('ZERO_DENOMINATOR');
 const numerator=(op==='growth'?parseExact(exactBinary('subtract',a,b)):x);
 const n=numerator.n*pow(y.s+places),denominator=y.n*pow(numerator.s);const q=n/denominator,rem=n%denominator;
 // The initial exact-tolerance domain refuses nonterminating material values.
 // A future rounded protocol must supply and independently check its error bound.
 if(rem!==0n)throw Error('NON_TERMINATING_RATIO_AT_DECLARED_PRECISION');
 return formatExact({n:q,s:places});
}
export const exactScale=(a:string,scale:string,sign:string)=>exactBinary('multiply',a,sign==='NEGATE'?'-'+scale:scale);

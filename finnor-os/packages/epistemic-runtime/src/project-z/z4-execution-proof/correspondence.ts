/** Independent, complete primitive-constraint contract for the runtime program.
 * Native synthesis enforces this entire image, not a producer-declared flag. */
import {PROFILE,BACKEND,COMPILER,canonical,fail,sha,validateProgram,type Operand,type Program} from './contracts';
type Linear=Array<[string,string]>;
type Recipe={kind:string;[key:string]:unknown};
type Wire={name:string;recipe:Recipe};
type Gate={kind:'r1cs';a:Linear;b:Linear;c:Linear}|{kind:'poseidon250';inputs:string[];output:string};
export interface ConstraintPlan {compiler:string;wires:Wire[];gates:Gate[];outputs:string[]}
const t=(name:string,n:bigint|number):[string,string]=>[name,String(n)];
export function originalConstraintContract(raw:Program,binding:string):ConstraintPlan {
 const p=validateProgram(raw);
 if(!/^[a-f0-9]{64}$/.test(binding))fail('Z4_BINDING_DIGEST');
 const semanticBinding=sha({domain:'finnor.z4.semantic-state-binding.v1',profile:PROFILE,backend:BACKEND,compiler:COMPILER,program:p,binding});
 const image:ConstraintPlan={compiler:COMPILER,wires:[],gates:[],outputs:[]};
 const allocate=(name:string,recipe:Recipe)=>{image.wires.push({name,recipe});return name;};
 const equation=(a:Linear,b:Linear,c:Linear)=>image.gates.push({kind:'r1cs',a,b,c});
 const equal=(a:Linear,c:Linear)=>equation(a,[t('one',1)],c);
 const bool=(name:string)=>equation([t(name,1)],[t(name,1),t('one',-1)],[]);
 const range=(name:string,width:number,offset:bigint)=>{
  const packed:Linear=[],names:string[]=[];
  for(let bit=0;bit<width;bit++){
   const b=allocate(`${name}.b${bit}`,{kind:'bit',source:name,bit,offset:String(offset)});
   bool(b);packed.push(t(b,1n<<BigInt(bit)));names.push(b);
  }
  equal([t(name,1),...(offset===0n?[]:[t('one',offset)])],packed);
  return names;
 };
 for(let i=0;i<14;i++)allocate(`z${i}`,{kind:'external',index:i});
 for(let i=0;i<8;i++){
  if(i>=p.registers.length)equal([t(`z${i}`,1)],[]);
  range(`z${i}`,64,1n<<63n);
  if(p.registers[i]?.type==='bool')bool(`z${i}`);
 }
 range('z8',9,0n);
 for(let i=0;i<4;i++)equal([t(`z${i+10}`,1)],[t('one',BigInt('0x'+semanticBinding.slice(i*16,i*16+16)))]);
 for(let i=0;i<p.inputCount;i++){allocate(`x${i}`,{kind:'input',index:i});range(`x${i}`,32,1n<<31n);}
 const registers=Array.from({length:8},(_,i)=>`z${i}`);
 const operand=(o:Operand,index:number,label:string):string=>{
  if('reg'in o)return registers[o.reg]!;
  if('input'in o)return `x${o.input}`;
  const n=allocate(`i${index}.${label}`,{kind:'constant',value:o.const});
  equal([t(n,1)],[t('one',BigInt(o.const))]);return n;
 };
 p.instructions.forEach((i,index)=>{
  const a=operand(i.a,index,'a'),b=operand(i.b,index,'b'),out=`i${index}.out`;
  if(i.op==='add'||i.op==='sub'){
   const terms=[t(a,1),t(b,i.op==='add'?1:-1)];
   allocate(out,{kind:'linear',terms});equal(terms,[t(out,1)]);
  }else if(i.op==='mul'){
   allocate(out,{kind:'product',a,b});equation([t(a,1)],[t(b,1)],[t(out,1)]);
  }else if(i.op==='lt'){
   const difference=`i${index}.difference`,terms=[t(a,1),t(b,-1),t('one',1n<<64n)];
   allocate(difference,{kind:'linear',terms});equal(terms,[t(difference,1)]);
   const bits=range(difference,65,0n),select=[t('one',1),t(bits[64]!, -1)];
   allocate(out,{kind:'linear',terms:select});equal(select,[t(out,1)]);
  }else if(i.op==='eq'){
   allocate(out,{kind:'equal',a,b});const inverse=allocate(`i${index}.inverse`,{kind:'inverse',a,b});
   equation([t(a,1),t(b,-1)],[t(inverse,1)],[t('one',1),t(out,-1)]);
   equation([t(a,1),t(b,-1)],[t(out,1)],[]);
  }else{
   const c=operand(i.c!,index,'c');allocate(out,{kind:'select',a,b,c});bool(c);
   equation([t(a,1),t(b,-1)],[t(c,1)],[t(out,1),t(b,-1)]);
  }
  if(p.registers[i.dst]!.type==='bool')bool(out);else range(out,64,1n<<63n);
  registers[i.dst]=out;
 });
 const counter=[t('z8',1),t('one',1)];
 allocate('counter',{kind:'linear',terms:counter});equal(counter,[t('counter',1)]);range('counter',9,0n);
 allocate('domain',{kind:'constant',value:'1513376049'});equal([t('domain',1)],[t('one',1513376049)]);
 const inputs=['domain','z8','z9',...Array.from({length:p.inputCount},(_,i)=>`x${i}`)];
 allocate('accumulator',{kind:'hash',inputs});image.gates.push({kind:'poseidon250',inputs,output:'accumulator'});
 image.outputs=[...registers,'counter','accumulator','z10','z11','z12','z13'];
 return image;
}
export function checkCorrespondence(program:Program,binding:string,actual:unknown){
 const start=performance.now(),expected=originalConstraintContract(program,binding);
 if(canonical(actual)!==canonical(expected))fail('Z4_ORIGINAL_CONSTRAINT_CORRESPONDENCE_REJECTED');
 return {status:'CHECKED_EXACT_CONSTRAINT_IMAGE' as const,compiler:COMPILER,planHash:sha(expected),
  wires:expected.wires.length,gates:expected.gates.length,wallMs:performance.now()-start,
  universalCompilerTheorem:false,hashGadget:'PINNED_NOVA_POSEIDON_WIDE_250',rangeArgument:'SIGNED64_AND_PRODUCT_LT_2_POW_127_LT_PALLAS_FIELD'};
}

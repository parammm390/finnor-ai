import {createHash} from 'node:crypto';
import {z} from 'zod';

export const PROFILE = 'Z4_I32_I64_PALLAS_VESTA_IPA_V1' as const;
export const BACKEND = 'nova-01b1e2d662a847ed7029770ecbaf6687398899dd-0.76.0' as const;
export const COMPILER = 'z4-r1cs-integer-v2' as const;
export const LENGTHS = [1,2,4,8,16,64,256] as const;
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const integerSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,19}|-[1-9][0-9]{0,19})$/);
const unit = z.string().regex(/^[A-Za-z0-9_:/.-]{1,64}$/);
const operand = z.union([
 z.object({reg:z.number().int().min(0).max(7)}).strict(),
 z.object({input:z.number().int().min(0).max(7)}).strict(),
 z.object({const:integerSchema}).strict(),
]);
export const programSchema = z.object({
 schema:z.literal('finnor.z4.integer-program.v1'), inputCount:z.number().int().min(1).max(8),
 registers:z.array(z.object({type:z.enum(['i64','bool']),unit}).strict()).min(1).max(8),
 inputUnits:z.array(unit).min(1).max(8), rounding:z.literal('EXACT_NO_CONVERSION'),
 instructions:z.array(z.object({op:z.enum(['add','sub','mul','lt','eq','select']),
  dst:z.number().int().min(0).max(7),a:operand,b:operand,c:operand.optional()}).strict()).min(1).max(16),
}).strict();
export const requestSchema = z.object({
 program:programSchema,initial:z.array(integerSchema).min(1).max(8),
 inputs:z.array(z.array(integerSchema).min(1).max(8)).min(1).max(256),
 binding:digestSchema,
}).strict();
export const statementSchema = z.object({
 profile:z.literal(PROFILE),backend:z.literal(BACKEND),compiler:z.literal(COMPILER),
 program:programSchema,binding:digestSchema,initial:z.array(integerSchema).min(1).max(8),
 finalState:z.array(integerSchema).min(1).max(8),steps:z.number().int().refine(x=>(LENGTHS as readonly number[]).includes(x)),
 inputCommitment:digestSchema,
}).strict();
export const artifactSchema=z.object({profile:z.literal(PROFILE),planHash:digestSchema,
 parameterHash:digestSchema,proofHex:z.string().min(2).max(8*1024*1024).regex(/^(?:[a-f0-9]{2})+$/)}).strict();
export type Program=z.infer<typeof programSchema>;
export type Operand=z.infer<typeof operand>;
export type ExactRequest=z.infer<typeof requestSchema>;
export type Statement=z.infer<typeof statementSchema>;
export type ProofArtifact=z.infer<typeof artifactSchema>;
export function canonical(v:unknown):string {
 if(v===null||typeof v==='string'||typeof v==='boolean')return JSON.stringify(v);
 if(typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);
 if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
 if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical((v as Record<string,unknown>)[k])).join(',')+'}';
 throw Error('Z4_NONCANONICAL_VALUE');
}
export const sha=(v:unknown)=>createHash('sha256').update(Buffer.isBuffer(v)?v:canonical(v)).digest('hex');
export const fail=(code:string):never=>{throw Error(code);};
export function checked64(v:bigint):bigint {
 if(v<-(1n<<63n)||v>=(1n<<63n))fail('Z4_SIGNED64_RANGE');
 return v;
}
export function exactInteger(v:string):bigint {
 if(!integerSchema.safeParse(v).success)fail('Z4_CANONICAL_INTEGER');
 return checked64(BigInt(v));
}
export function validateProgram(raw:unknown):Program {
 const p=programSchema.parse(raw);
 if(p.inputCount!==p.inputUnits.length)fail('Z4_INPUT_ARITY');
 if(p.registers.some(r=>r.type==='bool'&&r.unit!=='1'))fail('Z4_REGISTER_TYPE_OR_UNIT');
 const get=(o:Operand):string=>{
  if('reg'in o)return p.registers[o.reg]?.unit??fail('Z4_REGISTER_BOUND');
  if('input'in o)return p.inputUnits[o.input]??fail('Z4_INPUT_BOUND');
  exactInteger(o.const);return '1';
 };
 for(const i of p.instructions){
  const dst=p.registers[i.dst]??fail('Z4_REGISTER_BOUND'),a=get(i.a),b=get(i.b),pred=i.op==='lt'||i.op==='eq';
  if(pred!==(dst.type==='bool'))fail('Z4_RESULT_TYPE');
  if(i.op==='mul'){
   if(a!=='1'&&b!=='1'||dst.unit!==(a==='1'?b:a))fail('Z4_UNSUPPORTED_SCALE_CONVERSION');
  }else if(a!==b||!pred&&dst.unit!==a)fail('Z4_UNIT_MISMATCH');
  if(i.op==='select'){
   if(!i.c||!('reg'in i.c)||p.registers[i.c.reg]?.type!=='bool')fail('Z4_BOOLEAN_SELECT_REQUIRED');
  }else if(i.c!==undefined)fail('Z4_UNUSED_OPERAND');
 }
 return p;
}
export function validateRequest(raw:unknown):ExactRequest {
 const r=requestSchema.parse(raw),p=validateProgram(r.program);
 if(!(LENGTHS as readonly number[]).includes(r.inputs.length)||r.initial.length!==p.registers.length)fail('Z4_ACTUAL_LENGTH_OR_STATE_BOUND');
 r.initial.forEach((v,i)=>{const n=exactInteger(v);if(p.registers[i]!.type==='bool'&&n!==0n&&n!==1n)fail('Z4_BOOLEAN_RANGE');});
 for(const row of r.inputs){
  if(row.length!==p.inputCount)fail('Z4_INPUT_ARITY');
  for(const v of row){const n=exactInteger(v);if(n<-(1n<<31n)||n>=(1n<<31n))fail('Z4_SIGNED32_RANGE');}
 }
 return r;
}
export function assertStatement(raw:unknown):Statement {
 const s=statementSchema.parse(raw);validateProgram(s.program);
 if(s.initial.length!==s.program.registers.length||s.finalState.length!==s.initial.length)fail('Z4_ACTUAL_LENGTH_OR_STATE_BOUND');
 for(const state of [s.initial,s.finalState])state.forEach((v,i)=>{
  const n=exactInteger(v);if(s.program.registers[i]!.type==='bool'&&n!==0n&&n!==1n)fail('Z4_BOOLEAN_RANGE');
 });
 return s;
}

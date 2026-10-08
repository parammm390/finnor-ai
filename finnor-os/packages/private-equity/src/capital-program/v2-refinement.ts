import ts from 'typescript';
import {launchIsolatedNodeExecutor} from '../../../governed-execution/src/executor';
import type {ControlProblem} from '@finnor/shared-types';
import {checkEconomicLowering,type EconomicDescriptor} from './v2-grammar';
import {m3Hash,m3Ref,m3Bounded,CapitalProgramV2Error,type CapitalProgramV2Module,type CapitalProgramV2Request} from './v2-contracts';
import {m3Remaining} from './v2-budget';

type Term={kind:'LITERAL';value:string;unit:string}|{kind:'SUBTRACT'|'MULTIPLY'|'RATIO';left:Term;right:Term;unit:string}|
  {kind:'SCALE_REGISTERED_RESOURCE';amount:string;term:string;base:string;unit:string};
const rank=(term:Term):number=>term.kind==='LITERAL'?0:term.kind==='SCALE_REGISTERED_RESOURCE'?3:1+Math.max(rank(term.left),rank(term.right));
const literal=(value:string,unit:string):Term=>({kind:'LITERAL',value,unit});
const product=(left:Term,right:Term,unit:string):Term=>({kind:'MULTIPLY',left,right,unit});
const runtime=`
type Q={n:bigint;d:bigint};
const q=(s:string):Q=>{if(!/^-?(?:0|[1-9]\\d*)(?:\\.\\d{1,18})?$/.test(s))throw Error("INVALID_DECIMAL");
const parts=s.replace("-","").split("."),w=parts[0]!,f=parts[1]??"";return {n:BigInt(w+f)*(s.startsWith("-")?-1n:1n),d:10n**BigInt(f.length)};};
const mul=(a:Q,b:Q):Q=>({n:a.n*b.n,d:a.d*b.d});
const ratio=(a:Q,b:Q):Q=>{if(b.n===0n)throw Error("ZERO_DENOMINATOR");return {n:a.n*b.d,d:a.d*b.n};};
const sub=(a:Q,b:Q):Q=>({n:a.n*b.d-b.n*a.d,d:a.d*b.d});
const number=(a:Q):number=>{const value=Number(a.n)/Number(a.d);if(!Number.isFinite(value)||Math.abs(value)>1e9)throw Error("NONFINITE_OR_BOUND");return value;};
`;

/** A bounded economic-only refinement calculus, not universal P1 synthesis.
 * Its abstract resource task is expanded recursively into typed lower-rank
 * arithmetic. Source is emitted from these reductions, then actually invoked. */
export async function refineEconomicModule(input:{
 descriptor:EconomicDescriptor;base:ControlProblem;request:CapitalProgramV2Request;
 remainingSteps:number;onPrepared:(preimage:unknown)=>Promise<void>;
}):Promise<{module:CapitalProgramV2Module;problem:ControlProblem;steps:number}>{
 const {descriptor,base,request}=input,trace:CapitalProgramV2Module['refinement']=[];
 let steps=0;
 function lower(term:Term,parentId:string|null=null,depth=1):string{
  if(++steps>input.remainingSteps)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','REFINEMENT_BUDGET_EXHAUSTED');
  if(depth>request.resource.maxRefinementDepth)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','REFINEMENT_DEPTH_EXHAUSTED');
  const id=`refine-${trace.length}`,r=rank(term);let child:Term[]=[];
  if(term.kind==='SCALE_REGISTERED_RESOURCE'){
   const quotient:Term={kind:'RATIO',left:literal(term.term,request.permitted.unit),right:literal(term.base,request.permitted.unit),unit:'ratio'};
   child=[product(literal(term.amount,term.unit),quotient,term.unit)];
  }else if(term.kind!=='LITERAL'){
   if(term.kind==='SUBTRACT'&&term.left.unit!==term.right.unit||term.kind==='RATIO'&&term.left.unit!==term.right.unit||
     term.kind==='MULTIPLY'&&term.right.unit!=='ratio')
    throw new CapitalProgramV2Error('CHECK_FAILED','Economic dimensional algebra failed before execution');
   child=[term.left,term.right];
  }
  if(child.some(c=>rank(c)>=r))throw new CapitalProgramV2Error('CHECK_FAILED','Refinement measure did not strictly decrease');
  trace.push({id,parentId,task:term.kind,rank:r,childRanks:child.map(rank),depth,primitive:term.kind==='SCALE_REGISTERED_RESOURCE'?null:term.kind});
  if(term.kind==='LITERAL')return `q(${JSON.stringify(term.value)})`;
  const emitted=child.map(c=>lower(c,id,depth+1));
  return term.kind==='SCALE_REGISTERED_RESOURCE'?emitted[0]!:`${term.kind==='RATIO'?'ratio':term.kind==='MULTIPLY'?'mul':'sub'}(${emitted.join(',')})`;
 }
 const action=base.actions.find(a=>a.id===request.permitted.actionId)!,
   target=descriptor.problem.actions.find(a=>a.id===action.id),term=descriptor.term,
   original=String(action.exposures[request.permitted.exposureId]![0]);
 let statements:string[]=[];
 if(descriptor.structure==='WAIT_STOP')statements=['problem.actions=problem.actions.filter(a=>a.kind==="WAIT"||a.kind==="STOP");'];
 else if(target&&descriptor.structure!=='INCUMBENT'){
  statements.push(`const action=problem.actions.find(a=>a.id===${JSON.stringify(action.id)});if(!action)throw Error("ACTION_UNAVAILABLE");`,
   `action.earliestPeriod=${target.earliestPeriod};action.lastPeriod=${target.lastPeriod};`);
  if(target.precondition)statements.push(`action.precondition=${JSON.stringify(target.precondition)};`);
  for(const key of ['resources','occupancy'] as const)for(const [id,amount]of Object.entries(action[key])){
   const unit=request.permitted.unit==='USD'?'USD':id;
   statements.push(`action.${key}[${JSON.stringify(id)}]=number(${lower({kind:'SCALE_REGISTERED_RESOURCE',amount:String(amount),term,base:original,unit})});`);
  }
  for(const key of ['cost','tailLiability'] as const)statements.push(
   `action.${key}=number(${lower({kind:'SCALE_REGISTERED_RESOURCE',amount:String(action[key]),term,base:original,unit:'USD'})});`);
  for(const [id,doses]of Object.entries(action.exposures)){
   const dose=id===request.permitted.exposureId?term:String(doses[0]),unit=id===request.permitted.exposureId?request.permitted.unit:id;
   if(descriptor.structure==='STAGED'){
    const share=literal(descriptor.stageFraction!,'ratio'),rest:Term={kind:'SUBTRACT',left:literal('1','ratio'),right:share,unit:'ratio'};
    statements.push(`action.exposures[${JSON.stringify(id)}]=[number(${lower(product(literal(dose,unit),share,unit))}),number(${lower(product(literal(dose,unit),rest,unit))})];`);
   }else statements.push(`action.exposures[${JSON.stringify(id)}]=[number(${lower(literal(dose,unit))})];`);
  }
  if(descriptor.structure==='OBSERVABLE_STAGE'){
   const release=descriptor.problem.actions.find(a=>!base.actions.some(b=>b.id===a.id));
   if(!release)throw new CapitalProgramV2Error('CHECK_FAILED','Registered observable second commitment is unavailable');
   statements.push('const release=JSON.parse(JSON.stringify(action)) as Action;',
    `release.id=${JSON.stringify(release.id)};release.earliestPeriod=${release.earliestPeriod};release.lastPeriod=${release.lastPeriod};`,
    `release.precondition=${JSON.stringify(release.precondition)};`);
   const share=literal(descriptor.stageFraction!,'ratio'),rest:Term={kind:'SUBTRACT',left:literal('1','ratio'),right:share,unit:'ratio'};
   for(const key of ['resources','occupancy'] as const)for(const [id,amount]of Object.entries(action[key])){
    const total:Term={kind:'SCALE_REGISTERED_RESOURCE',amount:String(amount),term,base:original,unit:id};
    statements.push(`action.${key}[${JSON.stringify(id)}]=number(${lower(product(total,share,id))});`,
     `release.${key}[${JSON.stringify(id)}]=number(${lower(product(total,rest,id))});`);
   }
   for(const key of ['cost','tailLiability','humanSeconds'] as const){
    const total:Term=key==='humanSeconds'?literal(String(action[key]),'seconds'):
     {kind:'SCALE_REGISTERED_RESOURCE',amount:String(action[key]),term,base:original,unit:'USD'};
    const unit=key==='humanSeconds'?'seconds':'USD';
    statements.push(`action.${key}=number(${lower(product(total,share,unit))});release.${key}=number(${lower(product(total,rest,unit))});`);
   }
   for(const [id,doses]of Object.entries(action.exposures)){
    const unit=id===request.permitted.exposureId?request.permitted.unit:id,total=literal(id===request.permitted.exposureId?term:String(doses[0]),unit);
    statements.push(`action.exposures[${JSON.stringify(id)}]=[number(${lower(product(total,share,unit))})];`,
     `release.exposures[${JSON.stringify(id)}]=[number(${lower(product(total,rest,unit))})];`);
   }
   statements.push('problem.actions.push(release);');
  }
  if(descriptor.structure==='INQUIRY_OPTION'){
   const inquiry=descriptor.problem.actions.find(a=>a.id===request.permitted.inquiryActionId)!;
   statements.push(`const inquiry=problem.actions.find(a=>a.id===${JSON.stringify(inquiry.id)});if(!inquiry)throw Error("INQUIRY_UNAVAILABLE");`,
    `inquiry.earliestPeriod=${inquiry.earliestPeriod};inquiry.lastPeriod=${inquiry.lastPeriod};`);
  }
 }
 if(!steps){lower(literal('0','ratio'));}
 const source=runtime+`
type Action={id:string;kind:string;earliestPeriod:number;lastPeriod:number;resources:Record<string,number>;occupancy:Record<string,number>;
cost:number;tailLiability:number;humanSeconds:number;exposures:Record<string,number[]>;
precondition?:{afterActionIds:string[];observations:{instrumentId:string;tokens:string[]}[]}};
type Problem={id:string;actions:Action[]};
export function construct(input:Problem):Problem{
 const problem=JSON.parse(JSON.stringify(input)) as Problem;
 ${statements.join('\n')}
 problem.id=${JSON.stringify(descriptor.problem.id)};
 return problem;
}
`;
 m3Bounded(source,request.resource.maxModuleBytes);
 const name='/m3-emitted-economic.ts',options:ts.CompilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,
   strict:true,noLib:true,noEmitOnError:true};
 // No filesystem/module resolver is available to the generated programme.
 const library=`interface Array<T>{length:number;[n:number]:T;find(predicate:(value:T)=>boolean):T|undefined;filter(predicate:(value:T)=>boolean):T[];join(separator?:string):string;push(value:T):number;}
interface Boolean{} interface CallableFunction{} interface Function{} interface IArguments{} interface NewableFunction{} interface Number{} interface Object{}
interface RegExp{test(value:string):boolean;} interface String{length:number;replace(search:string,replacement:string):string;split(separator:string):string[];startsWith(search:string):boolean;}
type Record<K extends string,T>={[P in K]:T};
declare function BigInt(value:string|number):bigint;
declare const Number:{(value:string|bigint):number;isFinite(value:number):boolean};
declare const Math:{abs(value:number):number};
declare const JSON:{parse(value:string):unknown;stringify(value:unknown):string};
declare function Error(message:string):Error;interface Error{}
`;
 const inputs=new Map([[name,source],['/m3-library.d.ts',library]]);
 let javascript='';
 const host:ts.CompilerHost={getSourceFile:(file,language)=>inputs.has(file)?ts.createSourceFile(file,inputs.get(file)!,language,true):undefined,
   getDefaultLibFileName:()=>'/m3-library.d.ts',writeFile:(_file,body)=>{javascript=body;},getCurrentDirectory:()=>'/',
   getDirectories:()=>[],fileExists:file=>inputs.has(file),readFile:file=>inputs.get(file),getCanonicalFileName:file=>file,
   useCaseSensitiveFileNames:()=>true,getNewLine:()=>'\n'};
 const program=ts.createProgram([name,'/m3-library.d.ts'],options,host),
   diagnostics=ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,' '));
 if(diagnostics.length)throw new CapitalProgramV2Error('CHECK_FAILED','EMITTED_TYPECHECK_FAILED: '+diagnostics.slice(0,4).join('; '));
 program.emit();if(!javascript)throw new CapitalProgramV2Error('CHECK_FAILED','Emitted economic bytes unavailable');
 // Transport shim is fixed; only the checked pure constructor is generated.
 javascript+=`\nimport{readFileSync}from"node:fs";const input=JSON.parse(readFileSync(0,"utf8"));process.stdout.write(JSON.stringify(construct(input)));`;
 if(Buffer.byteLength(javascript)>request.resource.maxModuleBytes)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','MODULE_BYTE_GRANT_EXHAUSTED');
 const executionInput=structuredClone(base),inputDigest=m3Hash(executionInput);
 await input.onPrepared({source,javascript,inputDigest,refinement:trace,compiler:{name:'typescript',version:ts.version,diagnostics}});
 const execution=await launchIsolatedNodeExecutor({script:javascript,input:executionInput,wallTimeMs:Math.min(10000,m3Remaining())});
 if(execution.termination!=='EXITED'||execution.exitCode!==0)throw new CapitalProgramV2Error('CHECK_FAILED','ISOLATED_ECONOMIC_MODULE_REFUSED: '+execution.termination);
 let problem:ControlProblem;try{problem=JSON.parse(execution.stdout) as ControlProblem;}catch{throw new CapitalProgramV2Error('CHECK_FAILED','Untrusted isolated economic output is not JSON');}
 checkEconomicLowering(descriptor,problem);
 const body:Omit<CapitalProgramV2Module,'ref'>={schema:'finnor.m3.executable-economic-module.v2',source,javascript,
   compiler:{name:'typescript',version:ts.version,diagnostics:[],typeChecked:true},inputDigest,outputDigest:m3Hash(problem),
   validityDomain:'FINITE_REGISTERED_EXPOSURE_LINEAR_RESOURCE_SCALE_TWO_PERIOD_OR_LAWFUL_OBSERVABLE_OR_INQUIRY_COMMITMENTS',
   refinement:trace,execution:{termination:execution.termination,exitCode:execution.exitCode,provenance:execution.provenance},
   checks:[{predicate:'EXACT_DESCRIPTOR_SCHEDULE_RESOURCE_AND_HISTORY_PREIMAGE',status:'PASS',
     qualification:'SEPARATE_HOST_CONSTRUCTION_CHECK_AND_EXTERNAL_REFERENCE_IN_E2E_NOT_S8_ADMISSION'}]};
 const module={...body,ref:m3Ref('economic-module',body)};m3Bounded(module,request.resource.maxModuleBytes*8);
 return {module,problem,steps};
}

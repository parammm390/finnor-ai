import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {ExactContingentPolicy} from '@finnor/shared-types/src/robust-programme-search';
import {m3Hash,m3Same,CapitalProgramV2Error} from '../capital-program/v2-contracts';
import type {R2NativeSession} from '../capital-program/r2-native';

/** P1's versioned finite selector consumes a checked original S4 policy.
 * Exact amounts stay as rational strings. It has no consequential operation. */
export async function constructExactProgramme(policy:ExactContingentPolicy,session:R2NativeSession,limits:{maxModuleBytes:number;maxRefinementSteps:number}){
 if(policy.decisions.length>limits.maxRefinementSteps)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Original P1 history-expansion grant exhausted');
 const ir={schema:'finnor.p1.exact-original-history-ir.v1',policyRef:policy.ref,variant:policy.variant,decisions:policy.decisions,
  originalDigest:m3Hash(policy.original),checks:['LAWFUL_ORIGINAL_RECEIVED_HISTORY','EXACT_ORIGINAL_ACTION_AND_DEMAND','NO_EFFECT_OR_RESERVATION_AUTHORITY']},
  source=`type Observation={instrumentId:string;token:string;availablePeriod:number};\ntype History={period:number;actionHistory:string[];observations:Observation[]};\ntype Decision=History&{key:string;actionId:string};\ntype Action={id:string;kind:string;cost:string;resources:Record<string,string>;occupancy:Record<string,string>;[key:string]:unknown};\nconst decisions=JSON.parse(${JSON.stringify(JSON.stringify(policy.decisions))}) as Decision[];\nconst actions=JSON.parse(${JSON.stringify(JSON.stringify(policy.variant.actions))}) as Action[];\nexport function choose(input:History):Action {\nif(!input||Object.keys(input).sort().join(',')!=='actionHistory,observations,period'||!Number.isInteger(input.period)||input.actionHistory.length!==input.period||input.observations.some(o=>o.availablePeriod>input.period))throw Error('ORIGINAL_LAWFUL_HISTORY_REQUIRED');\nconst matches=decisions.filter(d=>d.period===input.period&&JSON.stringify(d.actionHistory)===JSON.stringify(input.actionHistory)&&JSON.stringify(d.observations)===JSON.stringify(input.observations));\nif(matches.length!==1)throw Error('ORIGINAL_HISTORY_OUTSIDE_POLICY');\nconst action=actions.find(a=>a.id===matches[0]!.actionId);if(!action)throw Error('ORIGINAL_ACTION_MISSING');return action;\n}\n`,
  file=resolve('finnor-p1-exact-policy.generated.ts'),options:ts.CompilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,lib:['lib.es2022.d.ts'],types:[],strict:true,noUncheckedIndexedAccess:true,noEmitOnError:true,skipLibCheck:false};
 if(Buffer.byteLength(source)>limits.maxModuleBytes)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Original P1 exact source byte grant exhausted');
 const host=ts.createCompilerHost(options),getSourceFile=host.getSourceFile.bind(host),readFile=host.readFile.bind(host),fileExists=host.fileExists.bind(host);let emitted='';
 host.getSourceFile=(name,language,onError,create)=>name===file?ts.createSourceFile(file,source,language,true):getSourceFile(name,language,onError,create);
 host.readFile=name=>name===file?source:readFile(name);host.fileExists=name=>name===file||fileExists(name);host.writeFile=(name,bytes)=>{if(name.endsWith('.js'))emitted=bytes;};
 const program=ts.createProgram([file],options,host),diagnostics=ts.getPreEmitDiagnostics(program).map(d=>ts.flattenDiagnosticMessageText(d.messageText,'\n')),emission=program.emit();
 if(diagnostics.length||emission.emitSkipped||!emitted)throw new CapitalProgramV2Error('CHECK_FAILED','P1 exact semantic compilation failed: '+diagnostics.slice(0,4).join('; '));
 const libraries=program.getSourceFiles().filter(f=>f.fileName!==file).map(f=>({path:f.fileName.split('/').pop()!,sha256:createHash('sha256').update(readFileSync(f.fileName)).digest('hex')})),
  javascript=emitted+`\nimport{readFileSync}from'node:fs';const input=JSON.parse(readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(input.histories.map(choose)));`,
  histories=policy.decisions.map(({period,actionHistory,observations})=>({period,actionHistory,observations})),execution=await session.executeProgramme(javascript,histories,limits.maxModuleBytes),
  expected=policy.decisions.map(d=>policy.variant.actions.find(a=>a.id===d.actionId));
 if(!m3Same(execution.outputs,expected))throw new CapitalProgramV2Error('CHECK_FAILED','P1 isolated exact action/demand output differs from original S4 policy');
 return {schema:'finnor.p1.exact-policy-module.v1',ir,source,javascript,compiler:{name:'typescript',version:ts.version,optionsDigest:m3Hash(options),libraries,diagnostics:[],typeChecked:true},
  sourceDigest:m3Hash(source),emittedDigest:m3Hash(javascript),inputDigest:m3Hash(histories),outputDigest:m3Hash(expected),execution,
  checkedHistoryCount:histories.length,executionAuthorityGranted:false,reservationGranted:false,admission:{status:'BLOCKED_EXTERNAL',receipt:null}};
}

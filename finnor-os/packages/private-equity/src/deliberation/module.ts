import ts from 'typescript';
import {readFileSync,openSync,fstatSync,closeSync,constants} from 'node:fs';
import {resolve,basename,dirname} from 'node:path';
import {createContext,Script} from 'node:vm';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {sha,stable} from '../evidence-execution/store';
import {ModuleSnapshotSchema,ModuleProposalSchema,CurrentExecutableModuleBodySchema,boundedObject,type ModuleSnapshot} from './contracts';
import {ESTIMATOR_CONFIG} from './calibration';
const sourcePath=resolve(import.meta.dirname,'metacontroller.ts');
const compilerPath=createRequire(import.meta.url).resolve('typescript');
const loadedCompilerImplementationDigest=sha(safeBytes(compilerPath,33554432));
const compilerOptions:ts.CompilerOptions={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None,strict:true,noEmitOnError:true,skipLibCheck:true,types:[],lib:['lib.es2022.d.ts']};
let cached:ReturnType<typeof compile>|undefined;
function safeBytes(path:string,maxBytes=4194304){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const st=fstatSync(fd);if(!st.isFile()||st.size>maxBytes)throw Error('M2_MODULE_REGULAR_FILE_BOUND');return readFileSync(fd);}finally{closeSync(fd);}}
function compile(){
 const started=performance.now(),cpu=process.cpuUsage();
 const source=safeBytes(sourcePath,65536).toString('utf8'),file=resolve(import.meta.dirname,'registered-m2-module.ts'),implementationDigest=sha(safeBytes(compilerPath,33554432));let emitted='';
 if(implementationDigest!==loadedCompilerImplementationDigest)throw Error('M2_LOADED_MODULE_OR_COMPILER_CHANGED');
 const host=ts.createCompilerHost(compilerOptions),get=host.getSourceFile.bind(host),read=host.readFile.bind(host),exists=host.fileExists.bind(host);
 host.getSourceFile=(name,language,error,again)=>name===file?ts.createSourceFile(file,source,language,true):get(name,language,error,again);
 host.fileExists=name=>name===file||exists(name);host.readFile=name=>name===file?source:read(name);host.writeFile=(name,data)=>{if(name.endsWith('.js'))emitted=data;};
 const program=ts.createProgram([file],compilerOptions,host),diagnostics=ts.getPreEmitDiagnostics(program);const emission=program.emit();
 if(diagnostics.length||emission.emitSkipped||emission.diagnostics.length||!emitted)throw Error('M2_SEMANTIC_COMPILATION_FAILED');
 const libraries=program.getSourceFiles().filter(f=>f.fileName!==file).map(f=>({file:basename(f.fileName),digest:sha(safeBytes(f.fileName))})).sort((a,b)=>a.file.localeCompare(b.file));
 const hostSourceDigests=['contracts.ts','store.ts','calibration.ts','module.ts','ports.ts','api.ts','deadline.ts'].map(file=>({file,digest:sha(safeBytes(resolve(import.meta.dirname,file)))}));
 const producerCodeDigest=sha({sourceDigest:sha(source),hostSourceDigests,compilerImplementationDigest:implementationDigest,estimatorConfigDigest:sha(ESTIMATOR_CONFIG)});
 const body=CurrentExecutableModuleBodySchema.parse({schema:'finnor.m2.executable-module.v2',source,sourceDigest:sha(source),emitted,emittedDigest:sha(emitted),entrypoint:'deliberate',producerCodeDigest,
  compiler:{name:'typescript',version:ts.version,implementationDigest,optionsDigest:sha(compilerOptions),libraries,librariesDigest:sha(libraries),diagnostics:[]},
  runtime:{node:process.version,binaryDigest:sha(readFileSync(process.execPath)),imageDigest:null,kind:'REGISTERED_BOUNDED_VM_NO_PROTECTED_ISOLATION' as const},
  config:{maxUnits:8,maxParallel:2,maxChains:256,executionTimeoutMs:25,maxRuns:32,maxInputBytes:65536,maxOutputBytes:131072,controlUnitLifecycle:'BOUNDED_EPISODE_CONTINUATION'},
  featureSchema:'finnor.m2.module-snapshot.v2',estimatorVersion:ESTIMATOR_CONFIG.version,
  estimatorConfigDigest:sha(ESTIMATOR_CONFIG),
  hostSourceDigests,
  producerAdmission:null});
 const digest=sha(body),ref={owner:'M2',id:'m2-module:'+digest,version:'m2-semantic-module-v2',contentDigest:digest},usage=process.cpuUsage(cpu);
 const preparation={schema:'finnor.m2.preparation-receipt.v1',id:randomUUID(),kind:'M2_REGISTERED_SEMANTIC_COMPILATION' as const,moduleRef:ref,elapsedMs:performance.now()-started,cpuMicros:usage.user+usage.system,node:process.version,processId:process.pid,costUSD:null,chargedAsEpisodeAttempt:false as const,accounting:'SHARED_OR_DEVELOPMENT_PREPARATION_NONADDITIVE_NOT_S5_FUNDING' as const};
 return {ref,body,preparation};
}
export function currentModule(){cached??=compile();const lib=dirname(ts.getDefaultLibFilePath(compilerOptions));if(sha(safeBytes(sourcePath,65536))!==cached.body.sourceDigest||sha(safeBytes(compilerPath,33554432))!==cached.body.compiler.implementationDigest||sha(ESTIMATOR_CONFIG)!==cached.body.estimatorConfigDigest||cached.body.hostSourceDigests.some(s=>sha(safeBytes(resolve(import.meta.dirname,s.file)))!==s.digest)||ts.version!==cached.body.compiler.version||cached.body.compiler.libraries.some(l=>sha(safeBytes(resolve(lib,l.file)))!==l.digest))throw Error('M2_LOADED_MODULE_OR_COMPILER_CHANGED');return structuredClone(cached);}
export function executeMetacontroller(raw:ModuleSnapshot){
 const started=performance.now(),cpu=process.cpuUsage();boundedObject(raw);const input=ModuleSnapshotSchema.parse(raw),module=currentModule();
 const context=createContext({snapshotJSON:stable(input)},{codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'});
 const script=new Script(module.body.emitted+'\nJSON.stringify(deliberate(JSON.parse(snapshotJSON)))',{filename:'content-addressed:'+module.ref.contentDigest});
 const serialized=script.runInContext(context,{timeout:module.body.config.executionTimeoutMs});
 if(typeof serialized!=='string'||Buffer.byteLength(serialized)>module.body.config.maxOutputBytes)throw Error('M2_MODULE_OUTPUT_BOUND');
 const output=ModuleProposalSchema.parse(JSON.parse(serialized));if(new Set(output.selectedUnitIds).size!==output.selectedUnitIds.length||output.selectedUnitIds.some(id=>!input.units.some(u=>u.id===id&&u.status==='PENDING'&&u.prerequisites.every(p=>input.units.some(v=>v.id===p&&v.status==='COMPLETED')))))throw Error('M2_MODULE_PROPOSAL_NOT_READY');
 const usage=process.cpuUsage(cpu),id=randomUUID(),body={schema:'finnor.m2.module-run.v1',id,executed:true,moduleDigest:module.ref.contentDigest,input,inputDigest:sha(input),output,outputDigest:sha(output),elapsedMs:performance.now()-started,cpuMicros:usage.user+usage.system,runtime:module.body.runtime,configDigest:sha(module.body.config),compilerDigest:sha(module.body.compiler),costUSD:null,stepCharge:output.visited,qualification:'EXECUTED_REGISTERED_VM_PROPOSAL_P2_MUST_ADMIT_NO_AUTHORITY'};
 return {module,input,output,body,ref:{owner:'M2',id:'m2-run:'+id,version:'m2-module-run-v1',contentDigest:sha(body)}};
}

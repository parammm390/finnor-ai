/** Predeclared adversarial process E2E, with retained real proofs and refusals. */
import {mkdir,readFile,writeFile,unlink,rmdir,symlink,readlink,realpath} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {canonical,sha,COMPILER,PROFILE,BACKEND,validateRequest,type ExactRequest,type Program} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts';
import {produceExecutionProof,checkExecutionProof} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/engine';
import {checkCorrespondence,type ConstraintPlan} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/correspondence';
import {originalExecution} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/original';
import {nativeIdentity,runNative,NativeFailure} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/native';
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const evidence=process.argv[process.argv.indexOf('--evidence')+1]??'';
if(!evidence.startsWith('/'))throw Error('Z4_ABSOLUTE_EVIDENCE_REQUIRED');
await mkdir(evidence,{recursive:false,mode:0o700});
const native=resolve(repository,'finnor-os/packages/epistemic-runtime/native/z4-execution-proof');
const limits=()=>({deadlineAt:new Date(Date.now()+900000).toISOString(),maxMemoryBytes:2*1024**3,cpuSeconds:180});
const rows:Array<Record<string,unknown>>=[];
const report:Record<string,unknown>={schema:'finnor.z4.critical-falsifiers.v1',rows,status:'RUNNING',nativeOwner:false,
 securityAdmission:'NOT_RUN',protectedAdmission:'NOT_RUN',eligibleReuseN:0,money:null,humanSeconds:null,aggregateRSS:null};
const save=()=>writeFile(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
async function predicate(name:string,expected:string[],action:()=>Promise<unknown>|unknown){
 const row:Record<string,unknown>={name,expected};rows.push(row);
 try{await action();row.status='FAILED_ACCEPTED';}
 catch(error){
  const code=String((error as Error).message);
  row.observed=code;row.status=expected.includes(code)?'PASSED_NAMED_REFUSAL':'FAILED_WRONG_PREDICATE';
  if(error instanceof NativeFailure){row.meters=error.meters;row.physical=error.physical??null;}
 }
 await save();
}
async function python(mode:string,path?:string){
 const args=[resolve(repository,'finnor-os/scripts/project-z/z4/offline-native.py'),'--native',native,'--mode',mode,
  ...(path?['--candidate',path]:[])];
 const child=spawn('/usr/bin/python3',args,{cwd:evidence,env:{PATH:'/usr/bin:/bin',NODE_ENV:'production',PYTHONDONTWRITEBYTECODE:'1'},
  stdio:['ignore','pipe','pipe']});
 const chunks:Buffer[]=[],errors:Buffer[]=[];let size=0,err=0;
 child.stdout.on('data',(b:Buffer)=>{size+=b.length;if(size>2*1024*1024)child.kill('SIGKILL');else chunks.push(b);});
 child.stderr.on('data',(b:Buffer)=>{err+=b.length;if(err>65536)child.kill('SIGKILL');else errors.push(b);});
 const exit=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('close',done);});
 if(exit!==0){
  await writeFile(resolve(evidence,mode+'-failure.log'),Buffer.concat(errors),{mode:0o600,flag:'wx'});
  report.diagnosticFailure={mode,pid:child.pid??null,exitCode:exit,stderrBytes:err};
  throw Error('Z4_OFFLINE_DIAGNOSTIC_PROCESS_FAILED');
 }
 return JSON.parse(Buffer.concat(chunks).toString());
}
try{
 const identity=await nativeIdentity();report.identity=identity;await save();
 const frozen=JSON.parse(await readFile(resolve(repository,'scope-z/phase-evidence/z4/public-cases.pre-code.json'),'utf8'));
 const request=validateRequest({...frozen.cases[0].request,binding:'0'.repeat(64)});
 const checked=await produceExecutionProof(request,limits());
 const valid={statement:checked.statement,artifact:checked.artifact};
 await writeFile(resolve(evidence,'valid.json'),canonical(valid)+'\n',{flag:'wx',mode:0o600});
 report.original=frozen.cases[0].expectedFinal;report.validDigest=sha(valid);
 const mutations:Array<[string,string[],(v:typeof valid)=>void]>=[
  ['wrong-output',['Z4_PUBLIC_OUTPUT_OR_COMMITMENT_MISMATCH'],v=>{v.statement.finalState[0]=(BigInt(v.statement.finalState[0]!)+1n).toString();}],
  ['wrong-initial',['Z4_CRYPTOGRAPHIC_VERIFIER_REJECTED'],v=>{v.statement.initial[0]=(BigInt(v.statement.initial[0]!)+1n).toString();}],
  ['wrong-actual-T',['Z4_CRYPTOGRAPHIC_VERIFIER_REJECTED'],v=>{v.statement.steps=1;}],
  ['wrong-input-commitment',['Z4_PUBLIC_OUTPUT_OR_COMMITMENT_MISMATCH'],v=>{v.statement.inputCommitment='0'.repeat(64);}],
  ['wrong-context-binding',['Z4_RELATION_CHANGED'],v=>{v.statement.binding='1'.repeat(64);}],
  ['wrong-runtime-constant',['Z4_RELATION_CHANGED'],v=>{v.statement.program.instructions[0]!.b={const:'4'};}],
  ['wrong-runtime-opcode',['Z4_RELATION_CHANGED'],v=>{v.statement.program.instructions[0]!.op='add';}],
  ['unused-register-unit',['Z4_RELATION_CHANGED'],v=>{v.statement.program.registers[4]!.unit='USD';}],
  ['unused-register-type',['Z4_REGISTER_TYPE_OR_UNIT'],v=>{(v.statement.program.registers[4] as {type:string}).type='float64';}],
  ['rounding',['Z4_UNSUPPORTED_PROGRAM_DOMAIN'],v=>{(v.statement.program as {rounding:string}).rounding='FLOOR';}],
  ['compiler-version',['Z4_SECURITY_PROFILE_IDENTITY'],v=>{(v.statement as {compiler:string}).compiler='z4-r1cs-integer-v1';}],
  ['backend-version',['Z4_SECURITY_PROFILE_IDENTITY'],v=>{(v.statement as {backend:string}).backend='unadmitted';}],
  ['profile-version',['Z4_SECURITY_PROFILE_IDENTITY'],v=>{(v.statement as {profile:string}).profile='PRIVATE_INPUT_ZK';}],
  ['parameter-hash',['Z4_PARAMETER_IDENTITY'],v=>{v.artifact.parameterHash='0'.repeat(64);}],
  ['plan-hash',['Z4_RELATION_CHANGED'],v=>{v.artifact.planHash='0'.repeat(64);}],
  ['proof-bit-flip',['Z4_PROOF_ENCODING','Z4_CRYPTOGRAPHIC_VERIFIER_REJECTED'],v=>{
   const bytes=Buffer.from(v.artifact.proofHex,'hex');bytes[Math.floor(bytes.length/2)]!^=1;v.artifact.proofHex=bytes.toString('hex');}],
  ['proof-truncation',['Z4_PROOF_ENCODING'],v=>{v.artifact.proofHex=v.artifact.proofHex.slice(0,-4);}],
  ['proof-trailing-bytes',['Z4_PROOF_TRAILING_BYTES'],v=>{v.artifact.proofHex+='00';}],
 ];
 for(const [name,expected,mutate] of mutations){
  const candidate=structuredClone(valid);mutate(candidate);
  await predicate(name,expected,()=>runNative('verify',candidate,limits()));
 }
 const changedRequest=structuredClone(request);changedRequest.program.registers[4]!.unit='USD';
 const changed=await runNative<{statement:typeof valid.statement;artifact:typeof valid.artifact}>('prove',changedRequest,limits());
 const rebound={statement:changed.data.statement,artifact:{...changed.data.artifact,proofHex:valid.artifact.proofHex}};
 await predicate('unit-mutation-even-after-attacker-rebinds-all-public-metadata',['Z4_CRYPTOGRAPHIC_VERIFIER_REJECTED'],
  ()=>runNative('verify',rebound,limits()));
 await predicate('original-semantics-rejects-alternative-claim',['Z4_ORIGINAL_STATEMENT_MISMATCH'],
  ()=>checkExecutionProof(request,changed.data,limits()));
 const plan=await runNative<ConstraintPlan>('plan',request,limits());
 for(const [name,mutate] of [
  ['missing-range-equation',(p:ConstraintPlan)=>{p.gates.splice(64,1);}],
  ['wrong-witness-recipe',(p:ConstraintPlan)=>{p.wires[14]!.recipe.offset='0';}],
  ['wrong-output-wiring',(p:ConstraintPlan)=>{p.outputs[0]='z0';}],
  ['missing-input-commitment',(p:ConstraintPlan)=>{p.gates=p.gates.filter(g=>g.kind!=='poseidon250');}],
 ] as Array<[string,(p:ConstraintPlan)=>void]>){
  const bad=structuredClone(plan.data);mutate(bad);
  await predicate(name,['Z4_ORIGINAL_CONSTRAINT_CORRESPONDENCE_REJECTED'],()=>checkCorrespondence(request.program,request.binding,bad));
 }
 const simple:ExactRequest={program:{schema:'finnor.z4.integer-program.v1',inputCount:1,inputUnits:['1'],
  registers:[{type:'i64',unit:'1'}],rounding:'EXACT_NO_CONVERSION',instructions:[{op:'add',dst:0,a:{reg:0},b:{input:0}}]},
  initial:['0'],inputs:[['1']],binding:'0'.repeat(64)};
 const badInputs:Array<[string,string,unknown]>=[
  ['negative-zero','Z4_CANONICAL_INTEGER','-0'],['leading-zero','Z4_CANONICAL_INTEGER','01'],
  ['scientific-notation','Z4_CANONICAL_INTEGER','1e3'],['fractional-string','Z4_CANONICAL_INTEGER','1.5'],
  ['float-json','Z4_REQUEST_SCHEMA',1.5],['signed32-overflow','Z4_SIGNED32_RANGE','2147483648'],
 ];
 for(const [name,expected,value] of badInputs){
  const r=structuredClone(simple) as unknown as {inputs:unknown[][]};r.inputs[0]![0]=value;
  await predicate(name,[expected],()=>runNative('interpret',r,limits()));
 }
 for(const n of [0,3,257]){
  const r={...simple,inputs:Array.from({length:n},()=>['0'])};
  await predicate('actual-length-'+n,['Z4_ACTUAL_LENGTH_OR_STATE_BOUND'],()=>runNative('interpret',r,limits()));
 }
 const over={...simple,initial:['9223372036854775807']};
 await predicate('original-signed64-overflow',['Z4_SIGNED64_RANGE'],()=>originalExecution(over));
 await predicate('native-signed64-overflow',['Z4_SIGNED64_OVERFLOW'],()=>runNative('prove',over,limits()));
 const floating={...simple,program:{...simple.program,registers:[{type:'float64',unit:'1'}]}};
 await predicate('floating-register',['Z4_REGISTER_TYPE_OR_UNIT'],()=>runNative('interpret',floating,limits()));
 const bool={...simple,program:{...simple.program,registers:[{type:'bool',unit:'1'}],
  instructions:[{op:'eq',dst:0,a:{input:0},b:{input:0}}]},initial:['2']};
 await predicate('nonboolean-state',['Z4_BOOLEAN_RANGE'],()=>runNative('interpret',bool,limits()));
 const select={...simple,program:{...simple.program,instructions:[{op:'select',dst:0,a:{reg:0},b:{input:0},c:{reg:0}}]}};
 await predicate('nonboolean-select',['Z4_BOOLEAN_SELECT_REQUIRED'],()=>runNative('interpret',select,limits()));
 const mixed={...simple,program:{...simple.program,inputUnits:['USD']}};
 await predicate('mixed-units',['Z4_UNIT_MISMATCH'],()=>runNative('interpret',mixed,limits()));
 const multiplication={...mixed,program:{...mixed.program,registers:[{type:'i64',unit:'USD'}],
  instructions:[{op:'mul',dst:0,a:{reg:0},b:{input:0}}]}};
 await predicate('unadmitted-scale-conversion',['Z4_UNSUPPORTED_SCALE_CONVERSION'],()=>runNative('interpret',multiplication,limits()));
 await predicate('private-input-claim',['Z4_REQUEST_SCHEMA'],()=>runNative('interpret',{...simple,privateInputSecurity:true},limits()));
 await predicate('expired-original-deadline',['Z4_ORIGINAL_DEADLINE_EXHAUSTED'],()=>runNative('prove',simple,{...limits(),deadlineAt:'2000-01-01T00:00:00Z'}));
 await predicate('memory-ceiling',['Z4_PROCESS_MEMORY_BOUND'],()=>runNative('prove',simple,{...limits(),maxMemoryBytes:2*1024**3+1}));
 await predicate('cpu-ceiling',['Z4_PROCESS_CPU_BOUND'],()=>runNative('prove',simple,{...limits(),cpuSeconds:901}));
 const boundaryProgram:Program={schema:'finnor.z4.integer-program.v1',inputCount:1,inputUnits:['1'],rounding:'EXACT_NO_CONVERSION',
  registers:[{type:'i64',unit:'1'},{type:'i64',unit:'1'},{type:'bool',unit:'1'},{type:'bool',unit:'1'}],
  instructions:[{op:'lt',dst:2,a:{reg:0},b:{reg:1}},{op:'eq',dst:3,a:{reg:0},b:{reg:1}},
   {op:'select',dst:0,a:{reg:0},b:{reg:1},c:{reg:2}},{op:'sub',dst:1,a:{reg:1},b:{const:'1'}}]};
 const boundary=await produceExecutionProof({program:boundaryProgram,initial:['-9223372036854775808','9223372036854775807','0','0'],
  inputs:[['0']],binding:'0'.repeat(64)},limits());
 const expected=['-9223372036854775808','9223372036854775806','1','0'];
 if(canonical(boundary.statement.finalState)!==canonical(expected))throw Error('Z4_SIGNED_BOUNDARY_LITERAL_MISMATCH');
 await writeFile(resolve(evidence,'signed-boundary.json'),canonical(boundary)+'\n',{mode:0o600,flag:'wx'});
 report.signedBoundary={expected,observed:boundary.statement.finalState,verifier:boundary.verifier};
 const field=await python('field-prove'),fieldPath=resolve(evidence,'valid-field-only-proof.json');
 await writeFile(fieldPath,canonical(field.readings[0].response)+'\n',{mode:0o600,flag:'wx'});
 const verifiedField=await python('field-verify',fieldPath);
 if(verifiedField.readings[0].response.status!=='VALID_FIELD_PROOF_NOT_SIGNED_INTEGER_PROOF')throw Error('Z4_REAL_FIELD_PROOF_PRECONDITION');
 report.fieldOnlyRelation={production:field.process,independentVerifier:verifiedField,
  admissibleAsZ4:false,notAnIntegerProof:true,notAZeroKnowledgeClaim:true};
 const simpleValid=await runNative<{statement:typeof valid.statement;artifact:typeof valid.artifact}>('prove',simple,limits());
 const fieldCandidate={statement:{...simpleValid.data.statement,initial:over.initial,finalState:['9223372036854775808']},
  artifact:{...simpleValid.data.artifact,proofHex:field.readings[0].response.proofHex}};
 await predicate('genuine-valid-field-proof-invalid-signed-claim',['Z4_SIGNED64_RANGE'],()=>runNative('verify',fieldCandidate,limits()));
 fieldCandidate.statement.finalState=['-9223372036854775808'];
 await predicate('field-proof-cannot-bypass-range-by-labeling-output-as-wrapped',['Z4_CRYPTOGRAPHIC_VERIFIER_REJECTED'],
  ()=>runNative('verify',fieldCandidate,limits()));
 // Fresh isolated metadata readers see changed asset bytes before any launch.
 const fixture=resolve(repository,'scope-z/phase-evidence/z4','.asset-falsifiers-'+process.pid+'-'+Date.now()),
  created:Array<{path:string;hash:string}>=[],directories=new Set<string>();
 await mkdir(fixture,{recursive:false,mode:0o700});directories.add(fixture);
 const modules=await realpath(resolve(repository,'finnor-os/node_modules'));
 if(!modules.startsWith(repository+'/'))throw Error('Z4_DIAGNOSTIC_INSTALLED_MODULE_FALLBACK');
 await symlink(modules,resolve(fixture,'node_modules'),'dir');
 const put=async(relative:string,bytes:Buffer|string)=>{
  const path=resolve(fixture,relative);let dir=dirname(path);
  while(dir.startsWith(fixture)){directories.add(dir);if(dir===fixture)break;dir=dirname(dir);}
  await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{flag:'wx',mode:0o600});
  created.push({path,hash:sha(Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes))});
 };
 try{
  for(const kind of ['binary','source'] as const){
   const prefix=kind+'/runtime/',asset=prefix+'native/z4-execution-proof/';
   for(const source of identity.sourceFiles){
    let bytes=await readFile(resolve(native,source.path));
    if(kind==='source'&&source.path==='src/plan.rs')bytes=Buffer.concat([bytes,Buffer.from('\n// adversarial changed source\n')]);
    await put(asset+source.path,bytes);
   }
   await put(asset+'build-identity.json',await readFile(resolve(native,'build-identity.json')));
   for(const name of ['z4-proof','z4-field-falsifier']){
    const bytes=await readFile(resolve(native,'bin',name));if(kind==='binary'&&name==='z4-proof')bytes[0]!^=1;
    await put(asset+'bin/'+name,bytes);
   }
   for(const name of ['contracts','native','process-groups','runtime-paths'])await put(prefix+'src/project-z/z4-execution-proof/'+name+'.ts',
    await readFile(resolve(repository,'finnor-os/packages/epistemic-runtime/src/project-z/z4-execution-proof',name+'.ts')));
   const expected=kind==='binary'?'Z4_INSTALLED_BINARY_CHANGED':'Z4_NATIVE_SOURCE_CHANGED';
   await put(kind+'/check.mts',"import {nativeIdentity} from './runtime/src/project-z/z4-execution-proof/native.ts';\n"+
    "try{await nativeIdentity();process.exitCode=1;}catch(e){if(e.message!=="+JSON.stringify(expected)+")throw e;console.log(e.message);}\n");
   const child=spawn(process.execPath,['--import','tsx',resolve(fixture,kind,'check.mts')],{cwd:resolve(repository,'finnor-os'),
    env:{PATH:'/usr/bin:/bin',NODE_ENV:'production',
     NODE_OPTIONS:'--import='+resolve(repository,'finnor-os/scripts/project-z/z4/isolation-loader.mjs')},
    stdio:['ignore','pipe','pipe']});
   let output='';child.stdout.on('data',b=>{output+=b;if(output.length>4096)child.kill('SIGKILL');});child.stderr.resume();
   const exit=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('close',done);});
   rows.push({name:'installed-'+kind+'-tamper',expected:[expected],observed:output.trim(),processExit:exit,
    status:exit===0&&output.trim()===expected?'PASSED_NAMED_REFUSAL':'FAILED_ASSET_GUARD'});
  }
 }finally{
  report.assetFixtures=created.map(f=>({relative:f.path.slice(fixture.length+1),sha256:f.hash}));
  for(const f of created){if(sha(await readFile(f.path))!==f.hash)throw Error('Z4_DIAGNOSTIC_FIXTURE_CHANGED_DURING_CLEANUP');await unlink(f.path);}
  if(await readlink(resolve(fixture,'node_modules'))!==modules)throw Error('Z4_DIAGNOSTIC_MODULE_LINK_CHANGED');
  await unlink(resolve(fixture,'node_modules'));
  for(const dir of [...directories].sort((a,b)=>b.length-a.length))await rmdir(dir);
  report.temporaryAssetFixturesRemoved=true;
 }
 report.compiler=COMPILER;report.profile=PROFILE;report.backend=BACKEND;
 report.status=rows.some(r=>String(r.status).startsWith('FAILED'))?'FAILED':'PASSED_OFFLINE_CRITICAL_FALSIFIERS_ONLY';
 await save();console.log(JSON.stringify({status:report.status,rows:rows.length,output:evidence}));
 if(report.status==='FAILED')process.exitCode=1;
}catch(error){report.status='FAILED';report.error=String((error as Error).message);await save();process.exitCode=1;}

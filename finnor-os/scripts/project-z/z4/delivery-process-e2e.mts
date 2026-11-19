/** Predeclared credential-free CLI process E2E. Never launches scientific binaries. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,'../../../..');
const i=process.argv.indexOf('--evidence'),out=i<0?'':process.argv[i+1]!;
if(!out.startsWith('/'))throw Error('Z4_E2E_ABSOLUTE_EVIDENCE_REQUIRED');
await mkdir(out,{recursive:false,mode:0o700});
const sha=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const entry=resolve(here,'supplementary-qualification.mts');
const commands:Array<Record<string,unknown>>=[];
const record:Record<string,unknown>={schema:'finnor.z4.delivery-process-e2e.v1',status:'RUNNING',commands,
 nativeExecutions:0,protectedAdmission:'NOT_RUN',businessEvidence:false,eligibleReuseN:0};
const save=()=>writeFile(resolve(out,'report.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});
const check=(v:unknown,code:string)=>{if(!v)throw Error(code);};
async function run(name:string,args:string[],expectedExit=0,expectedCode?:string){
 const target=resolve(out,name),argv=['--import','tsx',entry,'--evidence',target,...args];
 const env={PATH:dirname(process.execPath)+':/usr/bin:/bin',HOME:out,TMPDIR:out,
  NODE_OPTIONS:'--max-old-space-size=1024 --import='+resolve(here,'isolation-loader.mjs'),
  TSX_DISABLE_CACHE:'1',PYTHONDONTWRITEBYTECODE:'1',CI:'1'};
 const mark=performance.now(),child=spawn(process.execPath,argv,{cwd:resolve(root,'finnor-os'),env,stdio:['ignore','pipe','pipe']});
 const chunks:Buffer[]=[],errors:Buffer[]=[];let bytes=0;
 const stop=()=>child.kill('SIGKILL');
 for(const [stream,list] of [[child.stdout,chunks],[child.stderr,errors]] as const)stream.on('data',(v:Buffer)=>{
  bytes+=v.length;if(bytes>1024*1024)stop();else list.push(v);
 });
 const timer=setTimeout(stop,60000);
 const exit=await new Promise<number|null>((done,reject)=>{child.once('error',reject);child.once('close',done);}).finally(()=>clearTimeout(timer));
 await writeFile(resolve(out,name+'.stdout.log'),Buffer.concat(chunks),{flag:'wx',mode:0o600});
 await writeFile(resolve(out,name+'.stderr.log'),Buffer.concat(errors),{flag:'wx',mode:0o600});
 const body=JSON.parse(await readFile(resolve(target,'report.json'),'utf8')) as Record<string,unknown>;
 commands.push({name,command:[process.execPath,...argv],cwd:resolve(root,'finnor-os'),environmentVariableNames:Object.keys(env),
  pid:child.pid,exit,expectedExit,expectedCode:expectedCode??null,wallMs:performance.now()-mark,observed:body});
 await save();
 check(exit===expectedExit,'Z4_E2E_EXIT:'+name);
 if(expectedCode)check(body.error===expectedCode,'Z4_E2E_PREDICATE:'+name);
 return body;
}
async function input(name:string,value:unknown){
 const path=resolve(out,name+'.input.json');await writeFile(path,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});return path;
}
try{
 await save();
 const prepared=await run('public-prepare',['--mode','prepare']);
 check(prepared.positiveDenominator===256&&prepared.selectedFreshProofs===256&&prepared.proofPassed===0,'Z4_E2E_FULL_SCHEDULE');
 const original=await run('public-original',['--mode','original']);
 check(original.positivePassed===256&&original.proofPassed===0&&original.nativeExecutions===0,'Z4_E2E_ORIGINAL_ONLY');
 const publicData=JSON.parse(await readFile(resolve(here,'supplementary-positive.v3.json'),'utf8'));
 const one=structuredClone(publicData.cases[0]);
 one.id='public-interface-equipment-not-a-withheld-function';
 const constant=one.request.program.instructions.flatMap((v:{a:object;b:object})=>[v.a,v.b])
  .find((v:object)=>'const'in v);
 if(constant)constant.const='917';
 const definitions=Array.from({length:40},(_,n)=>({...structuredClone(one),id:'public-shape-equipment-'+n}));
 const freeze={digest:'a'.repeat(64),frozenAt:'2026-10-26T00:00:00Z'};
 const base={schema:'finnor.z4.protected-definitions.v1',compiler:freeze,
  definitions,release:{custodianDigest:'b'.repeat(64),receiptDigest:'c'.repeat(64),
   revealedAt:'2026-10-26T00:00:01Z',definitionsDigest:'d'.repeat(64)}};
 await run('protected-count',['--mode','protected-shape','--input',await input('protected-count',{...base,definitions:definitions.slice(0,39)})],1,'Z4_WITHHELD_COUNT');
 await run('protected-duplicate',['--mode','protected-shape','--input',await input('protected-duplicate',base)],1,'Z4_WITHHELD_DUPLICATE_FUNCTION');
 await run('protected-public',['--mode','protected-shape','--input',await input('protected-public',{...base,
  definitions:Array.from({length:40},(_,n)=>({...publicData.cases[n],id:'public-reuse-'+n}))})],1,'Z4_WITHHELD_PUBLIC_FUNCTION');
 await run('protected-freeze',['--mode','protected-shape','--input',await input('protected-freeze',{...base,
  release:{...base.release,revealedAt:'2026-10-25T23:59:59Z'}})],1,'Z4_WITHHELD_COMPILER_NOT_FROZEN');
 await run('protected-custody',['--mode','protected-custody','--input',await input('protected-custody',base)],1,'Z4_WITHHELD_INDEPENDENT_CUSTODY_REQUIRED');

 const binding={programDigest:'1'.repeat(64),requestDigest:'2'.repeat(64),sourceDigest:'3'.repeat(64),
  targetDigest:'4'.repeat(64),resourcesDigest:'5'.repeat(64),comparatorDigest:'6'.repeat(64),
  horizonDigest:'7'.repeat(64),ownerBindingDigest:'9'.repeat(64),permittedUseDigest:'a'.repeat(64),
  inputRevisionDigest:'b'.repeat(64),originalReservationDigest:'c'.repeat(64)};
 const fixed=['build','learning','native-install','setup','compile','prove','storage','invalidation','recovery','provider','human'];
 const amounts=(cpuMicros:number)=>({cpuMicros,wallMs:cpuMicros,usdMicros:null,humanMillis:null});
 const uses=Array.from({length:3},(_,n)=>({useId:sha(['use',n]),ownerReceipt:sha(['owner',n]),observedAt:100+n}));
 let tick=0;
 const receipt=(arm:string,phase:string,cpu:number,useId?:string)=>{
  const id=sha(['receipt',tick,arm,phase]),startMs=tick++;
  return {id,arm,phase,role:'TOTAL',covers:phase==='check'?[]:[phase],attemptId:id,processScope:id,
   startMs,endMs:startMs+1,outcome:'COMPLETE',binding,amounts:amounts(cpu),...(useId?{useId}:{})};
 };
 const receipts=fixed.flatMap(phase=>['PROOF','FULL'].map(arm=>receipt(arm,phase,
  arm==='FULL'?0:({setup:2,compile:3,prove:5,storage:1,recovery:1,'native-install':1,build:1} as Record<string,number>)[phase]??0)));
 for(const u of uses)receipts.push(receipt('PROOF','check',2,u.useId),receipt('FULL','check',10,u.useId));
 const ledger={schema:'finnor.z4.full-cost.v1',evidenceClass:'PUBLIC_EQUIPMENT',binding,uses,receipts};
 const cost=await run('cost-base',['--mode','cost','--input',await input('cost-base',ledger)]);
 const metrics=cost.dimensions as Record<string,{proofTotal:number|null;fullTotal:number|null;firstFavorableObservedUse:number|null;ratio:number|null}>;
 check(metrics.cpuMicros?.proofTotal===20&&metrics.cpuMicros.fullTotal===30&&metrics.cpuMicros.firstFavorableObservedUse===2&&metrics.cpuMicros.ratio===1.5,
  'Z4_E2E_DIRECT_COST_ARITHMETIC');
 check(cost.eligibleReuseN===0&&cost.fullCostAccepted===false&&metrics.usdMicros?.ratio===null,'Z4_E2E_NO_PUBLIC_VALUE_ADMISSION');
 const failed={...receipt('PROOF','prove',5),outcome:'FAILED'};
 const failureCost=await run('cost-failure',['--mode','cost','--input',await input('cost-failure',{...ledger,receipts:[...receipts,failed]})]);
 const fm=(failureCost.dimensions as typeof metrics).cpuMicros!;
 check(fm.proofTotal===25&&fm.firstFavorableObservedUse===3,'Z4_E2E_FAILED_COST_RETAINED');
 const parent=receipts.find(r=>r.arm==='PROOF'&&r.phase==='prove')!;
 const breakdown={...parent,id:sha('component'),role:'BREAKDOWN',parentId:parent.id,amounts:amounts(5)};
 const component=await run('cost-component',['--mode','cost','--input',await input('cost-component',{...ledger,receipts:[...receipts,breakdown]})]);
 check((component.dimensions as typeof metrics).cpuMicros?.proofTotal===20,'Z4_E2E_NO_COMPONENT_DOUBLE_COUNT');
 await run('cost-duplicate',['--mode','cost','--input',await input('cost-duplicate',{...ledger,receipts:[...receipts,receipts[0]]})],1,'Z4_COST_DUPLICATE_RECEIPT');
 await run('cost-mismatch',['--mode','cost','--input',await input('cost-mismatch',{...ledger,receipts:receipts.map((r,n)=>n? r:
  {...r,binding:{...binding,resourcesDigest:'8'.repeat(64)}})})],1,'Z4_COST_BINDING_MISMATCH');
 const zero=await run('cost-zero',['--mode','cost','--input',await input('cost-zero',{...ledger,uses:[],receipts:receipts.filter(r=>r.phase!=='check')})]);
 check(zero.crossover==='NOT_ESTABLISHED_NO_ELIGIBLE_DEMAND','Z4_E2E_ZERO_DEMAND');
 record.status='PASSED_PUBLIC_NON_NATIVE_PROCESS_EQUIPMENT_ONLY';
 record.expected={publicDenominator:256,originalPasses:256,newProofs:0,cpuFixture:{proof:20,full:30,firstObservedCrossover:2,ratio:1.5},
  failedProofCpuFixture:{proof:25,firstObservedCrossover:3},protectedAdmission:'NOT_RUN',eligibleReuseN:0};
 await save();console.log(JSON.stringify({status:record.status,commands:commands.length,output:out}));
}catch(error){
 record.status='FAILED_STOPPED';record.error=(error as Error).message;await save();process.exitCode=1;
 console.error(JSON.stringify({status:record.status,error:record.error}));
}

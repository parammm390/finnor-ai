import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {table,contingent,boundary,delayedInquiry,continuationAccrual,pendingAfterStop,fixedCorrelation,reseal,caps,hash} from './fixtures.mts';
import type {R2OriginalProblem,R2Encoding} from '../../packages/shared-types/src/robust-programme-search';
import {R2NativeSession,loadR2Runtime,r2Repository} from '../../packages/private-equity/src/capital-program/r2-native';
import {inM3Episode} from '../../packages/private-equity/src/capital-program/v2-budget';
import {encodeR2Master,encodeR2Tie,decodeR2Policy} from '../../packages/epistemic-runtime/src/r2-encoding';
import {r2Quantity as q,r2String as s} from '../../packages/epistemic-runtime/src/r2-rational';
import {canonicalJson} from '../../packages/epistemic-runtime/src/source-precedence';
const out=resolve(process.env.FINNOR_R2_EVIDENCE_DIR??join(r2Repository,'scope-r/r2-robust-programme-search/evidence/mathematics/run-'+new Date().toISOString().replaceAll(':','-')+'-'+randomUUID())),
 runtime=await loadR2Runtime(),cases:Array<Record<string,unknown>>=[],began=new Date().toISOString(),diagnostic=process.argv.includes('--diagnostic');
await mkdir(out,{recursive:true,mode:0o700});
const caseIndex=process.argv.indexOf('--case'),selected=caseIndex<0?null:process.argv[caseIndex+1];
if(caseIndex>=0&&!selected)throw new Error('--case requires a registered case id');
const save=async()=>writeFile(join(out,'results.json'),JSON.stringify({schema:'finnor.r2.mathematics-e2e.v1',began,finishedAt:new Date().toISOString(),cases,
 runtimeRef:runtime.ref,checkerIdentity:runtime.checkerIdentity,corpus:JSON.parse(await readFile(join(r2Repository,'finnor-os/scripts/r2/corpus.json'),'utf8')),
 qualification:'Exact finite development reference. Mathematical runner has no business owner/queue lease and makes no integrated or protected claim.',money:null,moneyStatus:'UNMETERED',rerun:'cd finnor-os && node --import tsx scripts/r2/run-mathematics.mts'},null,2));
function reference(original:R2OriginalProblem,extra:Record<string,unknown>={}){
 const encoding=extra.encoding as R2Encoding|undefined,payload={operation:'enumerate',maximumAssignments:50000,original,caps,...extra,
  canonical:{original:canonicalJson(original),problem:canonicalJson(original.problem),grammar:canonicalJson({permitted:original.permitted,variants:encoding?.variants??[]}),worlds:canonicalJson(original.source.worlds)}};
 const result=spawnSync(runtime.python,[join(r2Repository,'finnor-os/packages/epistemic-runtime/python/r2_check.py')],{input:JSON.stringify(payload),encoding:'utf8',timeout:15000,maxBuffer:8388608});
 const parsed=JSON.parse(result.stdout||'{}');return {parsed,exit:result.status,stderr:result.stderr,input:payload};
}
async function challenge(id:string,run:(directory:string)=>Promise<unknown>){
 if(selected&&selected!==id)return;
 const directory=join(out,id);await mkdir(directory,{mode:0o700});const start=performance.now();
 try{cases.push({id,status:'PASS',observed:await run(directory),wallMs:performance.now()-start});}
 catch(error){cases.push({id,status:'FAIL',error:String(error),stack:(error as Error).stack,wallMs:performance.now()-start});}
 console.log(JSON.stringify({id,status:cases.at(-1)!.status}));await save();
}
async function search(original:R2OriginalProblem,directory:string,allWorlds=false){
 const oracle=reference(original);assert.equal(oracle.exit,0,JSON.stringify(oracle.parsed));
 await writeFile(join(directory,'reference.json'),JSON.stringify(oracle,null,2));
 return inM3Episode(30000,async()=>{
  const session=new R2NativeSession(runtime,directory,Date.now()+28000,caps,async()=>{}),worlds=allWorlds?original.source.worlds.map(w=>w.id):[original.source.worlds[0]!.id],iterations:any[]=[],proofs:any[]=[],started=performance.now();
  let lower:string|null=null,upper:string|null=null,winner:ReturnType<typeof decodeR2Policy>|null=null;
  try{
   const family=await session.build(original);
   for(let index=0;index<32;index++){
    const encoding=encodeR2Master(original,family,worlds,caps);await session.check(original,'encoding',{encoding});
    const solved=await session.solve(encoding,index);assert(solved.viprRef,solved.proofError??'No VIPR acceptance');
    const bound=await session.check(original,'proof',{encoding,proofPath:solved.proofPath});proofs.push({encoding,solved,bound});
    if(bound.infeasibleProof){assert.equal(oracle.parsed.reference.value,null);return {status:'INFEASIBLE',oracle:oracle.parsed.reference,proofs,receipts:session.receipts};}
    assert(bound.upper!==null);upper=upper===null||q(bound.upper).compare(q(upper))<0?bound.upper:upper;
    assert(solved.solution);const policy=decodeR2Policy(encoding,solved.solution),full=await session.check(original,'policy',{policy});
    if(full.feasible&&full.lower!==null&&(lower===null||q(full.lower).compare(q(lower))>0)){lower=full.lower;winner=policy;}
    assert(q(upper).compare(q(oracle.parsed.reference.value))>=0,'Accepted upper excludes independent optimum');
    if(lower!==null)assert(q(lower).compare(q(oracle.parsed.reference.value))<=0,'Accepted lower exceeds independent optimum');
    const worst=[...full.worldValues].sort((a,b)=>q(a.value).compare(q(b.value)))[0]!,adverse=full.violations.find(v=>!worlds.includes(v.worldId))?.worldId??(!worlds.includes(worst.worldId)?worst.worldId:null);
    iterations.push({index,restrictedWorlds:[...worlds],lower,upper,full,adverse});
    if(lower!==null&&q(lower).compare(q(upper))===0)break;
    assert(adverse,'Unresolved interval without adverse witness');worlds.push(adverse);
   }
   assert.equal(lower,oracle.parsed.reference.value);assert.equal(upper,lower);
   const tie=encodeR2Tie(encodeR2Master(original,family,original.source.worlds.map(w=>w.id),caps),lower!);await session.check(original,'encoding',{encoding:tie});
   const solved=await session.solve(tie,1000);assert(solved.viprRef&&solved.solution,solved.proofError??'Tie unaccepted');
   const checked=await session.check(original,'proof',{encoding:tie,proofPath:solved.proofPath});
   const cost=tie.objective.terms.reduce((v,[id,c])=>v.add(q(c).mul(q(solved.solution![id]??'0'))),q('0'));assert.equal(checked.minimizationLower,s(cost));
   assert.equal(checked.upper,null,'Tie objective must never become a primary value upper');winner=decodeR2Policy(tie,solved.solution);
   const replay=await session.check(original,'policy',{policy:winner});assert(replay.feasible);assert.equal(replay.lower,lower);
   assert.deepEqual(winner.worldCourses.map(c=>c.id),oracle.parsed.reference.policy.worldCourses.map((c:any)=>c.id),'Original owner tie order differs');
   return {status:'COMPLETE',originalDigest:hash(original),lower,upper,policy:winner,oracle:oracle.parsed.reference,iterations,proofs,tie:{encoding:tie,solved,checked},wallMs:performance.now()-started,receipts:session.receipts};
  }finally{await session.cancel();await writeFile(join(directory,'physical.json'),JSON.stringify(session.receipts,null,2));}
 });
}
if(diagnostic){
 await challenge('matched-diagnostic',async directory=>{
  const ownerIndex=process.argv.indexOf('--owner-original'),ownerPath=ownerIndex<0?null:process.argv[ownerIndex+1];
  if(!ownerPath)throw Error('Matched diagnostic requires --owner-original containing actual immutable owner-resolved original');
  const retained=JSON.parse(await readFile(ownerPath,'utf8')),original:R2OriginalProblem=retained.body?.original??retained.original??retained;await mkdir(join(directory,'restricted'));await mkdir(join(directory,'all'));
  const on=await search(original,join(directory,'restricted')),off=await search(original,join(directory,'all'),true);
  assert.equal(on.lower,off.lower);assert.deepEqual(on.policy!.worldCourses,off.policy!.worldCourses);
  return {ownerOriginalPath:ownerPath,original,on,off,ownerResolutionScope:'Immutable real S1/S3/S4/S5/M3 input reused identically; search-only ablation, original owner lift/storage receipts supplied separately',noQualityGain:on.lower===off.lower,protectedGain:'NOT_RUN',adapterGainNotCredited:true,noGainRetained:on.wallMs!>=off.wallMs!,money:null};
 });
}else{
 for(const [id,original]of [['prd12.2-original-three',table()],['prd12.2-payoff-revision',table(true)],['observable-two-commitments',contingent()],['profile-24-periods-32-worlds-8-actions-8-instruments',boundary()]] as const)
  await challenge(id,dir=>search(original,dir));
 await challenge('nonterminating-rational',async directory=>{const o=table();for(const w of o.source.worlds)w.coefficients=[['1/3','0']];return search(o,directory);});
 await challenge('full-family-infeasible',async directory=>{const o=table();o.mandate.risk.minimumUtility=20;reseal(o);return search(o,directory);});
 for(const [id,original,expected]of [['delayed-inquiry',delayedInquiry(),'4'],['continuation-accrual',continuationAccrual(),'6'],['pending-after-stop',pendingAfterStop(),'3'],['fixed-world-correlation',fixedCorrelation(),'0']] as const)
  await challenge(id,async directory=>{const result=await search(original,directory);assert.equal(result.lower,expected);
   if(id==='pending-after-stop'){assert.equal(result.policy!.worldCourses[0]!.terminalLiability,'1');assert.equal(result.policy!.worldCourses[0]!.resourceUse.capital![0],'3');assert.equal(result.policy!.decisions[0]!.actionId,'stop');}
   if(id==='delayed-inquiry'){assert.equal(result.policy!.decisions.find(d=>d.period===0)!.actionId,'inquire');assert.deepEqual(result.policy!.worldCourses.map(c=>c.utility),['8','4']);}
   return result;});
 await challenge('constraint-world-not-payoff-worst',async directory=>{const o=table(),world=structuredClone(o.source.worlds[0]!);world.id='D';world.coefficients=[['101','0']];o.source.worlds.push(world);const result=await search(o,directory);assert.equal(result.lower,'1');assert.equal(result.iterations[0].adverse,'D');assert.equal(result.iterations[0].full.worldValues.reduce((a:any,b:any)=>q(a.value).compare(q(b.value))<0?a:b).worldId,'C');return result;});
 await challenge('profitable-joint-resource-infeasible',async directory=>{const o=table();o.resources.resources[0]!.availability.forEach(v=>v.amount='3');const result=await search(o,directory);assert.equal(result.lower,'1');assert.equal(result.policy!.worldCourses[0]!.resourceUse.capital![0],'3');return result;});
 await challenge('near-equality',async directory=>{const o=table(),epsilon=q('1/'+('1'+'0'.repeat(30)));for(const w of o.source.worlds)w.coefficients=[[s(q('1').sub(epsilon.mul(q('4')))),s(q('-2/3').add(epsilon.mul(q('4'))))]];const result=await search(o,directory);assert.equal(result.lower,'1/3');assert.equal(result.policy!.decisions[0]!.actionId,'Immediate');return result;});
 await challenge('proof-responsibility',async directory=>{
  const original=table(),result=await search(original,directory),accepted=result.proofs[0],proof=await readFile(accepted.solved.proofPath,'utf8'),checks=[];
  const mutations:Array<[string,(text:string)=>string,string]>= [
   ['dual-corruption',text=>text.replace(/(DualBound_\d+ G )(-?[0-9/]+)/,(all,prefix,value)=>prefix+s(q(value).add(q('1')))),'NATIVE_REJECT'],
   ['partial-proof',text=>text.slice(0,text.lastIndexOf('\nDualBound'))+'\n','NATIVE_REJECT'],
   ['weak-proof-without-completion',text=>text.replace('{ lin','{ incomplete'),'INCOMPLETE_CUT_CERTIFICATE'],
   ['unverified-transformation',text=>text.replace(/\bt_z\b/g,'presolved_z'),'PROOF_ORIGINAL_VARIABLES'],
   ['wrong-original-proof',text=>text.replace(/OBJ min\s+(\d+)\s+(\d+)\s+-1/,'OBJ min $1 $2 1'),'PROOF_ORIGINAL_OBJECTIVE'],
  ];
  for(const [id,mutate,expected]of mutations){const path=join(directory,id+'.vipr'),text=mutate(proof);assert.notEqual(text,proof,id);await writeFile(path,text);
   const native=spawnSync(runtime.vipr,[path],{encoding:'utf8',timeout:3000,maxBuffer:1048576}),binding=reference(original,{operation:'proof',encoding:accepted.encoding,proofPath:path});
   if(expected==='NATIVE_REJECT')assert(!/Successfully verified/.test(native.stdout),id);else{assert.equal(binding.exit,2,id);assert(String(binding.parsed.reason).includes(expected),binding.parsed.reason);}
   checks.push({id,expected,path,native:{exit:native.status,signal:native.signal,stdout:native.stdout,stderr:native.stderr},binding});
  }
  const feasible=reference(original,{operation:'policy',policy:result.policy});assert.equal(feasible.exit,0);assert.equal(feasible.parsed.lower,'1');assert.equal(feasible.parsed.upper,null);
  await writeFile(join(directory,'rejections.json'),JSON.stringify({checks,feasibleOnly:feasible},null,2));return {checks:checks.map(c=>({id:c.id,native:c.native.exit,reason:c.binding.parsed.reason})),feasibleOnly:{lower:'1',upper:null,exactOptimalityClaimed:false}};
 });
 await challenge('semantic-mutations',async directory=>{
  const original=table();const familyModule=await import('../../packages/epistemic-runtime/src/r2-encoding');
  const family=familyModule.constructR2Family(original,caps,()=>{}),encoding=encodeR2Master(original,family,['A'],caps),negative:Array<Record<string,unknown>>=[];
  const variants:Array<[string,(o:R2OriginalProblem,e:R2Encoding)=>void,string]>= [
   ['missing-acceptance',o=>{o.permitted.agreement='COUNTERPARTY_REQUIRED';},'ACCEPTANCE_PRIMITIVE_UNAVAILABLE'],
   ['resource-scope',o=>{o.resources.resources[0]!.permittedRoots=[];},'CANONICAL_RESOURCE_SCOPE'],
   ['resource-currency',o=>{o.resources.resources[0]!.currency='EUR';},'CANONICAL_RESOURCE_CURRENCY'],
   ['quantity',o=>{o.source.quantities['/problem/actions/1/resources/capital']='1';},'ORIGINAL_QUANTITY_BINDING'],
   ['currency',o=>{o.source.accounting.currency='EUR';},'ACCOUNTING_BINDING'],
   ['time',o=>{o.source.accounting.timeBasis={...o.mandate.horizon,periods:2};},'ACCOUNTING_BINDING'],
   ['owner-share',o=>{o.source.accounting.ownerShare='1/2';},'ACCOUNTING_BINDING'],
   ['normalization',o=>{o.mandate.scoring.normalization=0;reseal(o);},'FIXED_NORMALIZATION'],
   ['world-membership',(_o,e)=>{e.restrictedWorlds=['absent'];},'RESTRICTED_WORLD_MEMBERSHIP'],
   ['grammar-term',o=>{o.permitted.terms.push('2');},'CANONICAL_ORIGINAL_PREIMAGE:grammar'],
   ['grammar-production',o=>{o.permitted.structures.push('WAIT_STOP');},'CANONICAL_ORIGINAL_PREIMAGE:grammar'],
   ['row-omission',(_o,e)=>{e.rows.pop();},'ENCODING_ORIGINAL_CORRESPONDENCE'],
   ['bad-big-m',(_o,e)=>{e.coverage.bigMUsed=true as never;},'ENCODING_ORIGINAL_CORRESPONDENCE'],
   ['sign',(_o,e)=>{e.objective.terms=[['z','1']];},'ENCODING_ORIGINAL_CORRESPONDENCE'],
   ['original-digest',(_o,e)=>{e.originalDigest='0'.repeat(64);},'ENCODING_ORIGINAL_DIGESTS'],
   ['grammar-digest',(_o,e)=>{e.grammarDigest='0'.repeat(64);},'ENCODING_ORIGINAL_DIGESTS'],
   ['world-digest',(_o,e)=>{e.worldDigest='0'.repeat(64);},'ENCODING_ORIGINAL_DIGESTS'],
   ['malformed-rational',o=>{o.source.worlds[0]!.coefficients[0]![0]='1/0';},'RATIONAL_SYNTAX'],
   ['probabilistic-profile',o=>{o.mandate.ambiguity.kind='UNRESOLVED';},'PROBABILISTIC_OR_UNRESOLVED_PROFILE'],
   ['randomized-world',o=>{(o.source.worlds[0] as any).probability='1/2';},'UNSUPPORTED_RANDOMIZED_OR_PROBABILISTIC_WORLD'],
   ['continuous-domain',o=>{(o.source as any).continuousAdversary={lower:'0',upper:'1'};},'UNSUPPORTED_SOURCE_DOMAIN_FIELDS'],
   ['nonlinear-feature',o=>{const f:any={kind:'SIN',id:'dose',lag:1};o.source.mechanisms[0]!.equations[0]!.features[0]=f;o.modelRequest.mechanisms[0]!.equations[0]!.features[0]=f;},'UNSUPPORTED_MECHANISM_FEATURE'],
   ['empty-worlds',o=>{o.source.worlds=[];},'COMPLETE_WORLD_MEMBERSHIP'],
   ['duplicate-worlds',o=>{o.source.worlds.push(structuredClone(o.source.worlds[0]!));},'COMPLETE_WORLD_MEMBERSHIP'],
   ['original-history',o=>{o.source.worlds[0]!.initialHistory[0]!.states.payoff='1';},'ORIGINAL_OBSERVED_HISTORY_BINDING'],
   ['state-units',o=>{o.source.stateUnits.payoff='EUR';},'STATE_EXPOSURE_UNITS'],
   ['discount',o=>{o.source.quantities['/mandate/utility/discountFactors/0']='1/2';},'ORIGINAL_QUANTITY_BINDING'],
   ['unknown-obligation',o=>{o.problem.obligations=[{ref:o.sourceRef,effectRef:o.sourceRef,actionId:null,status:'UNKNOWN',exposures:null,resources:null,occupancy:null,lockedExposureIds:null,occupationUntilPeriod:0,terminalLiability:null}];reseal(o);},'UNKNOWN_OR_PARTIAL_OBLIGATION'],
   ['continuation-history',o=>{o.problem.continuation={elapsedPeriods:1,actionHistory:[],observations:[],accruedUtility:{value:0,unit:'USD',sourceRef:o.sourceRef},usedResources:{capital:0},humanSeconds:0,accountingRef:o.sourceRef};reseal(o);},'CONTINUATION_HISTORY'],
  ];
  for(const [id,mutate,expected]of variants){const o=structuredClone(original),e=structuredClone(encoding);mutate(o,e);
   const result=reference(o,{operation:'encoding',encoding:e});assert.equal(result.exit,2,`${id}:accepted`);assert(String(result.parsed.reason).includes(expected),`${id}: ${result.parsed.reason}`);negative.push({id,expected,...result});}
  const oracle=reference(contingent());assert.equal(oracle.exit,0);const originalContingent=contingent(),policy=oracle.parsed.reference.policy;
  for(const [id,mutate,expected]of [
   ['primal-utility',(p:any)=>p.worldCourses[0].utility='999','ORIGINAL_POLICY_PAYOFF_OR_DEMAND_TAMPER'],
   ['demand',(p:any)=>p.worldCourses[0].resourceUse.capital[0]='0','ORIGINAL_POLICY_PAYOFF_OR_DEMAND_TAMPER'],
   ['dropped-liability',(p:any)=>p.worldCourses[0].terminalLiability='1','ORIGINAL_POLICY_PAYOFF_OR_DEMAND_TAMPER'],
   ['hidden-history',(p:any)=>p.decisions[0].actionHistory=['private-world-A'],'LAWFUL_ORIGINAL_POLICY_HISTORY'],
   ['late-observation',(p:any)=>p.decisions.find((d:any)=>d.observations.length)?.observations.push({instrumentId:'outcome',token:'HIGH',availablePeriod:2}),'LAWFUL_ORIGINAL_POLICY_HISTORY'],
   ['partial-world-check',(p:any)=>p.worldCourses.pop(),'ORIGINAL_POLICY_PAYOFF_OR_DEMAND_TAMPER'],
  ] as const){const altered=structuredClone(policy);mutate(altered);const result=reference(originalContingent,{operation:'policy',policy:altered});assert.equal(result.exit,2,id);assert(String(result.parsed.reason).includes(expected),id+':'+result.parsed.reason);negative.push({id,expected,...result});}
  const limited=spawnSync(runtime.python,[join(r2Repository,'finnor-os/packages/epistemic-runtime/python/r2_check.py')],{input:JSON.stringify({...reference(original).input,caps:{...caps,maxPaths:1}}),encoding:'utf8',timeout:3000});assert.equal(limited.status,2);assert(limited.stdout.includes('CONSTRUCTION_PATH_CAP_INCOMPLETE'));negative.push({id:'construction-cap',stdout:limited.stdout,expected:'CONSTRUCTION_PATH_CAP_INCOMPLETE'});
  await writeFile(join(directory,'rejections.json'),JSON.stringify(negative,null,2));return negative.map(x=>({id:x.id,reason:(x.parsed as any)?.reason??x.expected}));
 });
}
await save();console.log(JSON.stringify({output:out,passed:cases.filter(c=>c.status==='PASS').length,failed:cases.filter(c=>c.status==='FAIL').length}));
assert(cases.length>0,'No registered case selected');
if(cases.some(c=>c.status!=='PASS'))process.exitCode=1;

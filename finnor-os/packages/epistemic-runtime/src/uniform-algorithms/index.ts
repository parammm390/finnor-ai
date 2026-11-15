import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {AlgorithmTheoryCapsule,UniformDecisionExpression,UniformKernelReceipt,UniformSearchAttempt,UniformProofPlan} from '../../../shared-types/src/algorithm-theory';
import {evaluateExpression,expectedStatement,hash,jsonHash,renderCandidate,localPlans,uniformPlans,inspectionSource,executionSource,parseExpression} from './syntax';
import {toolIdentity,specificationPath,prepareScratch,installSpecification,native,withNativeCapacity,type NativeBudget,type ToolIdentity} from './native';
import {parseCapsule} from './capsule';
export type {AlgorithmTheoryCapsule,UniformSearchAttempt} from '../../../shared-types/src/algorithm-theory';

function unsigned(c:AlgorithmTheoryCapsule){const {digest,...body}=c;return body;}
function integers(weights:string[]){
 if(!Array.isArray(weights)||weights.length>128||weights.some(w=>typeof w!=='string'||w.replace('-','').length>512||!/^-?(?:0|[1-9][0-9]*)$/.test(w)||w==='-0'))throw Error('Y5_PRACTICAL_DOMAIN');
 return weights.map(w=>BigInt(w));
}
async function check(c:AlgorithmTheoryCapsule,budget:NativeBudget,tool:ToolIdentity):Promise<UniformKernelReceipt>{
 parseExpression(c.expression);
 const spec=await readFile(specificationPath,'utf8');
 if(c.algorithmSource!==renderCandidate(c.expression,c.proofPlan)||hash(c.algorithmSource)!==c.sourceDigest||
  c.specification.source!==spec||hash(spec)!==c.specification.digest||c.theorem.statement!==expectedStatement||
  c.runtime.identityDigest!==tool.identityDigest||c.runtime.archiveDigest!==tool.archiveDigest||c.runtime.inventoryDigest!==tool.inventoryDigest||
  hash(Buffer.from(c.proofObject,'base64'))!==c.proofObjectDigest)throw Error('Y5_SOURCE_CORRESPONDENCE');
 await installSpecification(budget,spec,tool);
 const dir=await prepareScratch(budget.scratch);
 await writeFile(join(dir,'Candidate.lean'),c.algorithmSource,{mode:0o600});
 const build=await native(tool,['lean','-M','2048','-T','200000','-o','Candidate.olean','Candidate.lean'],budget,'independent-build');
 if(build.exitCode!==0)throw Object.assign(Error('Y5_INDEPENDENT_ELABORATION'),{receipt:build});
 if(hash(await readFile(join(dir,'Candidate.olean')))!==c.proofObjectDigest)throw Error('Y5_PROOF_SOURCE_CORRESPONDENCE');
 await writeFile(join(dir,'Candidate.olean'),Buffer.from(c.proofObject,'base64'),{mode:0o600});
 const replay=await native(tool,['leanchecker','Candidate'],budget,'independent-kernel-replay');
 if(replay.exitCode!==0)throw Object.assign(Error('Y5_KERNEL_REPLAY'),{receipt:replay});
 await writeFile(join(dir,'Inspection.lean'),inspectionSource,{mode:0o600});
 const inspected=await native(tool,['lean','-M','2048','-T','200000','Inspection.lean'],budget,'expected-type-and-axioms');
 if(inspected.exitCode!==0)throw Object.assign(Error('Y5_EXPECTED_TYPE'),{receipt:inspected});
 const inventories=[...inspected.stdout.matchAll(/'Y5\.uniform' depends on axioms:\s*\[([^\]]*)\]/g)];
 const empty=inspected.stdout.includes("'Y5.uniform' does not depend on any axioms");
 if(inventories.length+(empty?1:0)!==1||!inspected.stdout.includes('Y5.uniform :'))throw Error('Y5_AXIOM_INVENTORY_MISSING');
 const axioms=empty?[]:inventories[0]![1]!.split(',').map(a=>a.trim());
 if(axioms.some(a=>!['propext','Classical.choice','Quot.sound'].includes(a)))throw Error('Y5_UNAPPROVED_OR_UNSAFE_AXIOM');
 return {schema:'finnor.y5.kernel-check.v1',exactType:true,kernelReplay:true,theorem:'Y5.uniform',
  specificationDigest:hash(spec),sourceDigest:c.sourceDigest,proofObjectDigest:c.proofObjectDigest,runtimeDigest:tool.identityDigest,
  importInventoryDigest:tool.inventoryDigest,axioms,trustPolicyApproval:'NOT_ESTABLISHED',
  governance:'LOCAL_SEPARATE_PROCESS_NOT_PROTECTED_CUSTODY',native:[build,replay,inspected]};
}
export async function checkUniformAlgorithm(c:AlgorithmTheoryCapsule,budget:NativeBudget){
 c=parseCapsule(c);
 return withNativeCapacity(async()=>check(c,budget,await toolIdentity(budget.deadlineAt)));
}
function developmentCounterexample(e:UniformDecisionExpression,weights:string[]){
 const ws=integers(weights);if(ws.length>10)throw Error('Y5_DEVELOPMENT_CASE_BOUND');
 let best:bigint|null=null,bestCount=Infinity;
 for(let mask=0;mask<2**ws.length;mask++){
  let value=0n,count=0;ws.forEach((w,i)=>{if(mask&(2**i)){value+=w;count++;}});
  if(best===null||value>best||value===best&&count<bestCount){best=value;bestCount=count;}
 }
 const selected=ws.map(w=>evaluateExpression(e,w)),value=ws.reduce((v,w,i)=>v+(selected[i]?w:0n),0n);
 return value!==best||selected.filter(Boolean).length!==bestCount?{weights,selected,value:value.toString(),oracleMaximum:best!.toString(),oracleMinimumCardinality:bestCount}:null;
}
export async function discoverUniformAlgorithm(budget:NativeBudget&{developmentWeights:string[][]}):Promise<{status:'CHECKED'|'INCOMPLETE';capsule:AlgorithmTheoryCapsule|null;attempts:UniformSearchAttempt[]}>{
 return withNativeCapacity(async()=>{
  const started=performance.now(),tool=await toolIdentity(budget.deadlineAt),spec=await readFile(specificationPath,'utf8'),attempts:UniformSearchAttempt[]=[];
  if(budget.developmentWeights.length>64)throw Error('Y5_DEVELOPMENT_CASE_BOUND');
  await installSpecification(budget,spec,tool);
  const expressions:UniformDecisionExpression[]=['FALSE','TRUE','NEGATIVE','NONPOSITIVE','POSITIVE','NONNEGATIVE'].map(op=>({op} as UniformDecisionExpression));
  for(const expression of expressions){
   const counterexample=budget.developmentWeights.map(ws=>developmentCounterexample(expression,ws)).find(Boolean);
   if(counterexample){attempts.push({expression,stage:'DEVELOPMENT',status:'REFUTED',counterexample});continue;}
   for(let local=0;local<localPlans.length;local++){
    const plan:UniformProofPlan={local,uniform:0},dir=await prepareScratch(budget.scratch);
    await writeFile(join(dir,'Candidate.lean'),renderCandidate(expression,plan,true),{mode:0o600});
    const built=await native(tool,['lean','-M','2048','-T','200000','Candidate.lean'],budget,'local-'+attempts.length);
    attempts.push({expression,stage:'LOCAL_LEMMA',status:built.exitCode===0?'PROVED':'REJECTED',proofPlan:plan,native:built});
    if(built.exitCode!==0)continue;
    for(let uniform=0;uniform<uniformPlans.length;uniform++){
     const proofPlan={local,uniform},algorithmSource=renderCandidate(expression,proofPlan);
     await writeFile(join(dir,'Candidate.lean'),algorithmSource,{mode:0o600});
     const proved=await native(tool,['lean','-M','2048','-T','200000','-o','Candidate.olean','Candidate.lean'],budget,'uniform-'+attempts.length);
     attempts.push({expression,stage:'UNIFORM_PROOF',status:proved.exitCode===0?'PROVED':'REJECTED',proofPlan,native:proved});
     if(proved.exitCode!==0)continue;
     const object=await readFile(join(dir,'Candidate.olean'));
     const capsule:AlgorithmTheoryCapsule={
      schema:'finnor.algorithm-theory-capsule.v1',kind:'AlgorithmTheoryCapsule',digest:'',
      specification:{id:'INTEGER_ADDITIVE_BINARY_BOX_V1',source:spec,digest:hash(spec),acceptance:'EXISTING_S5_SEMANTICS_DEVELOPMENT_REFINEMENT_NOT_PROTECTED_ACCEPTANCE'},
      structure:{hypothesis:'ADDITIVE_BOX_WITH_DOMINATING_SCENARIO',lemma:'Y5.discovered_lemma',nonempty:'EVERY_FINITE_INTEGER_LIST_HAS_ALL_FALSE_FEASIBLE_WITNESS',origin:'RUNTIME_EXPRESSION_AND_PROOF_SEARCH',newProtectedStructure:false},
      expression,proofPlan,algorithmSource,sourceDigest:hash(algorithmSource),proofObject:object.toString('base64'),proofObjectDigest:hash(object),
      theorem:{name:'Y5.uniform',statement:expectedStatement,mathematicalSizes:'ALL_FINITE_LIST_LENGTHS',termination:'LEAN_STRUCTURAL_RECURSION',quality:'EXACT_MAXIMUM_WITH_FREE_ZERO_OMITTED',costModel:'ONE_COORDINATE_STEP_PER_ITEM_EXACT_INTEGER_PREDICATE_AS_PRIMITIVE',bitOrWallTimeBound:false},
      checker:null as unknown as UniformKernelReceipt,
      runtime:{version:'4.34.1',archiveDigest:tool.archiveDigest,inventoryDigest:tool.inventoryDigest,identityDigest:tool.identityDigest,profile:'NATIVE_DARWIN_ARM64_LEAN_INTERPRETER',maximumDecisions:128,maximumIntegerDigits:512},
      reuse:{definitions:true,genericTactics:true,successfulSuppliedFamilyProof:false,discoveryCredit:'PUBLIC_DEVELOPMENT_ONLY_NOT_PROTECTED_DISCOVERY'},
      search:{attempts,wallMs:performance.now()-started,completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null},
      admission:{status:'UNADMITTED',protectedAdmission:false,productionActive:false,executionAuthorityGranted:false},
     };
     capsule.checker=await check(capsule,{...budget,scratch:join(budget.scratch,'checker')},tool);
     capsule.search.wallMs=performance.now()-started;capsule.digest=jsonHash(unsigned(capsule));
     return {status:'CHECKED',capsule,attempts};
    }
   }
  }
  return {status:'INCOMPLETE',capsule:null,attempts};
 });
}
export async function executeUniformAlgorithm(c:AlgorithmTheoryCapsule,weights:string[],budget:NativeBudget){
 integers(weights);c=parseCapsule(c);
 return withNativeCapacity(async()=>{
  const tool=await toolIdentity(budget.deadlineAt);
  const checker=await check(c,budget,tool),dir=await prepareScratch(budget.scratch);
  await writeFile(join(dir,'Execution.lean'),executionSource,{mode:0o600});
  await writeFile(join(dir,'input.json'),JSON.stringify(weights),{mode:0o600});
  const receipt=await native(tool,['lean','-M','2048','-T','200000','--run','Execution.lean','input.json'],budget,'same-definition-execution');
  if(receipt.exitCode!==0)throw Object.assign(Error('Y5_EXECUTABLE_FAILED'),{receipt});
  const output=JSON.parse(receipt.stdout.trim()) as {selected:number[];coordinateSteps:number};
  if(!Array.isArray(output.selected)||output.selected.some(i=>!Number.isSafeInteger(i)||i<0||i>=weights.length)||
   new Set(output.selected).size!==output.selected.length||output.coordinateSteps!==weights.length)throw Error('Y5_EXECUTABLE_CONTRACT');
  return {...output,sourceDigest:c.sourceDigest,proofObjectDigest:c.proofObjectDigest,checker,receipt};
 });
}

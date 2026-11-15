import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import type {TotalAlgorithmTheoryCapsule,TotalKernelReceipt,TotalSearchAttempt,ResolvedTotalSpecification} from '../../../../shared-types/src/total-algorithm-theory';
import {native,toolIdentity,withNativeCapacity,type NativeBudget} from '../native';
import {hash,jsonHash} from '../syntax';
import {parseTotalCapsule,parseResolvedTotalSpecification} from './capsule';
import {newSearchState,programCandidates,propositionCandidates,retainAttempt,totalSearchLimitsSchema,type TotalSearchLimits} from './search';
import {programOperationBound} from './syntax';
import {totalModelPath,installTotalModel,renderTotalCandidate,totalGrammarDigest,expectedTotalStatement,inductionPlans,
 uniformPlans,totalInspectionSource,boundedObject,totalExecutionSource} from './proof';

export interface TotalDiscoveryBudget extends NativeBudget{
 developmentInputs:string[][];limits:TotalSearchLimits;episodeCutDigest?:string;
 episodeSelectionRule?:TotalAlgorithmTheoryCapsule['origin']['selectionRule'];
}
type ProofBundle=Omit<TotalAlgorithmTheoryCapsule,'checker'|'digest'|'origin'|'search'|'admission'>;
export type TotalDiscoveryResult=
 |{status:'CHECKED';capsule:TotalAlgorithmTheoryCapsule;attempts:TotalSearchAttempt[];wallMs:number}
 |{status:'INCOMPLETE';reason:string;attempts:TotalSearchAttempt[];wallMs:number;programsExamined:number;propositionsExamined:number};
async function current(budget:NativeBudget){
 if(!Number.isFinite(budget.deadlineAt)||Date.now()>=budget.deadlineAt||budget.current&&!await budget.current())
  throw Error('Y5_TOTAL_ORIGINAL_DEADLINE_OR_FENCE');
}
async function check(c:ProofBundle,expected:ResolvedTotalSpecification,budget:NativeBudget):Promise<TotalKernelReceipt>{
 await current(budget);
 if(jsonHash(c.specification)!==jsonHash(expected))throw Error('Y5_TOTAL_OWNER_SPECIFICATION_CHANGED');
 const source=await readFile(totalModelPath,'utf8'),algorithm=renderTotalCandidate(expected.definition,c.program,c.invariant,c.proofPlan),
  bound=programOperationBound(c.program);
 if(c.interpreterSource!==source||c.interpreterDigest!==hash(source)||c.grammarDigest!==totalGrammarDigest||
  c.algorithmSource!==algorithm||c.sourceDigest!==hash(algorithm)||c.theorem.statement!==expectedTotalStatement||
  jsonHash(c.theorem.operationBound)!==jsonHash(bound))throw Error('Y5_TOTAL_SOURCE_OR_INTERPRETER_CORRESPONDENCE');
 const proof=Buffer.from(c.proofObject,'base64');
 if(hash(proof)!==c.proofObjectDigest)throw Error('Y5_TOTAL_PROOF_OBJECT_INTEGRITY');
 const tool=await toolIdentity(Math.min(budget.deadlineAt,Date.now()+30000));
 if(c.runtime.archiveDigest!==tool.archiveDigest||c.runtime.inventoryDigest!==tool.inventoryDigest||
  c.runtime.identityDigest!==tool.identityDigest)throw Error('Y5_TOTAL_RUNTIME_CHANGED');
 const model=await installTotalModel(source,tool,budget);
 if(model.objectDigest!==c.interpreterProofObjectDigest)throw Error('Y5_TOTAL_INTERPRETER_OBJECT_CORRESPONDENCE');
 await writeFile(join(budget.scratch,'Candidate.lean'),algorithm,{mode:0o600});
 const rebuilt=await native(tool,['lean','-M','2048','-T','200000','-o','Candidate.olean','Candidate.lean'],budget,'total-check-source');
 if(rebuilt.exitCode!==0)throw Object.assign(Error('Y5_TOTAL_SOURCE_RECHECK'),{receipt:rebuilt});
 if(hash(await boundedObject(join(budget.scratch,'Candidate.olean')))!==c.proofObjectDigest)throw Error('Y5_TOTAL_PROOF_SOURCE_CORRESPONDENCE');
 await writeFile(join(budget.scratch,'Candidate.olean'),proof,{mode:0o600});
 const replay=await native(tool,['leanchecker','Candidate'],budget,'total-check-supplied-object');
 if(replay.exitCode!==0)throw Object.assign(Error('Y5_TOTAL_SUPPLIED_OBJECT_REPLAY'),{receipt:replay});
 await writeFile(join(budget.scratch,'Inspection.lean'),totalInspectionSource(expected,c.program,c.invariant),{mode:0o600});
 const inspected=await native(tool,['lean','-M','2048','-T','200000','Inspection.lean'],budget,'total-check-owner-target');
 if(inspected.exitCode!==0)throw Object.assign(Error('Y5_TOTAL_EXACT_OWNER_EXPECTED_TYPE'),{receipt:inspected});
 const axioms=new Set<string>();
 for(const name of ['uniform','counted_correspondence','operation_bound','sized_nonempty','uniform_additive_equivalence']){
  const match=inspected.stdout.match(new RegExp("'Y5Total\\."+name+"' (?:does not depend on any axioms|depends on axioms: \\[([^\\]]*)\\])"));
  if(!match)throw Error('Y5_TOTAL_AXIOM_INVENTORY_UNAVAILABLE');
  for(const axiom of (match[1]??'').split(',').map(s=>s.trim()).filter(Boolean)){
   if(!['propext','Classical.choice','Quot.sound'].includes(axiom))throw Error('Y5_TOTAL_UNSAFE_AXIOM');axioms.add(axiom);
  }
 }
 const proofTerm=inspected.stdout.split(/'Y5Total\.uniform' (?:depends|does not depend)/)[0]??'';
 if(!/\b(?:Y5Total\.)?discovered_lemma\b/.test(proofTerm))throw Error('Y5_TOTAL_UNUSED_STRUCTURAL_LEMMA');
 const imports=[...new Set([...inspected.stdout.matchAll(/Y5_TOTAL_IMPORT:([A-Za-z0-9_.]+)/g)].map(m=>m[1]!))].sort();
 if(!imports.length||!imports.includes('Total')||!imports.includes('Candidate')||
  imports.some(name=>!['Total','Candidate'].includes(name)&&!/^(?:Init|Lean|Std)(?:\.|$)/.test(name)))throw Error('Y5_TOTAL_UNAPPROVED_IMPORT');
 await current(budget);
 return {schema:'finnor.y5.total-kernel-check.v2',exactOwnerExpectedType:true,suppliedProofObjectReplayed:true,
  loadBearingLemmaInProof:true,countedDenotationAgreement:true,allSizeOperationBound:true,
  definitionDigest:expected.definitionDigest,programDigest:jsonHash(c.program),propositionDigest:jsonHash(c.invariant),
  sourceDigest:c.sourceDigest,proofObjectDigest:c.proofObjectDigest,interpreterDigest:c.interpreterDigest,
  interpreterProofObjectDigest:model.objectDigest,runtimeDigest:tool.identityDigest,importInventoryDigest:tool.inventoryDigest,
  modelSourceCorrespondence:model.sourceCorrespondence,modelSourcePinDigest:model.pinDigest,sharedModelSetupRef:model.setupRef,
  imports,axioms:[...axioms].sort(),native:[...model.native,rebuilt,replay,inspected],
  independentImplementation:false,protectedCustody:false,trustPolicyApproval:'NOT_ESTABLISHED'};
}
export async function discoverTotalAlgorithm(specification:ResolvedTotalSpecification,budget:TotalDiscoveryBudget):Promise<TotalDiscoveryResult>{
 const expected=parseResolvedTotalSpecification(specification),limits=totalSearchLimitsSchema.parse(budget.limits);
 if(budget.deadlineAt>Date.now()+3600000)throw Error('Y5_TOTAL_CAMPAIGN_WALL_BOUND');
 return withNativeCapacity(async()=>{
  const started=Date.now(),state=newSearchState();
  const incomplete=(reason:string):TotalDiscoveryResult=>({status:'INCOMPLETE',reason,attempts:state.attempts,
   wallMs:Date.now()-started,programsExamined:state.programsExamined,propositionsExamined:state.propositionsExamined});
  let preparation:{tool:Awaited<ReturnType<typeof toolIdentity>>;source:string;model:Awaited<ReturnType<typeof installTotalModel>>}|undefined;
  for await(const program of programCandidates(expected.definition,budget.developmentInputs,limits,budget,state)){
   for await(const invariant of propositionCandidates(expected.definition,program,budget.developmentInputs,limits,budget,state)){
    if(!preparation){
     const tool=await toolIdentity(Math.min(budget.deadlineAt,Date.now()+30000)),source=await readFile(totalModelPath,'utf8'),
      model=await installTotalModel(source,tool,budget);
     preparation={tool,source,model};
    }
    const {tool,source,model}=preparation;
    for(let induction=0;induction<inductionPlans.length;induction++)for(let uniform=0;uniform<uniformPlans.length;uniform++){
     if(state.proofAttempts>=limits.maxProofAttempts)return incomplete('PROOF_ATTEMPT_LIMIT');
     await current(budget);
     const proofPlan={induction,uniform},programDigest=jsonHash(program),propositionDigest=jsonHash(invariant),
      localSource=renderTotalCandidate(expected.definition,program,invariant,proofPlan,true);
     await writeFile(join(budget.scratch,`attempt-${state.proofAttempts+1}-lemma.lean.txt`),localSource,{mode:0o600});
     await writeFile(join(budget.scratch,'Candidate.lean'),localSource,{mode:0o600});state.proofAttempts++;
     const local=await native(tool,['lean','-M','2048','-T','200000','Candidate.lean'],budget,`total-lemma-${state.proofAttempts}`);
     if(!retainAttempt(state,limits,{stage:'CONJECTURE_PROOF',programDigest,propositionDigest,
      status:local.exitCode===0?'PROVED':'UNPROVED',proofPlan,sourceDigest:hash(localSource),native:local}))return incomplete(state.stopReason!);
     if(local.exitCode!==0)continue;
     if(state.proofAttempts>=limits.maxProofAttempts)return incomplete('PROOF_ATTEMPT_LIMIT');
     const algorithmSource=renderTotalCandidate(expected.definition,program,invariant,proofPlan),sourceDigest=hash(algorithmSource);
     await writeFile(join(budget.scratch,`attempt-${state.proofAttempts+1}-uniform.lean.txt`),algorithmSource,{mode:0o600});
     await writeFile(join(budget.scratch,'Candidate.lean'),algorithmSource,{mode:0o600});state.proofAttempts++;
     const built=await native(tool,['lean','-M','2048','-T','200000','-o','Candidate.olean','Candidate.lean'],budget,`total-uniform-${state.proofAttempts}`);
     if(!retainAttempt(state,limits,{stage:'UNIFORM_PROOF',programDigest,propositionDigest,
      status:built.exitCode===0?'PROVED':'UNPROVED',proofPlan,sourceDigest,native:built}))return incomplete(state.stopReason!);
     if(built.exitCode!==0)continue;
     const proofObject=(await boundedObject(join(budget.scratch,'Candidate.olean'))).toString('base64');
     const payload:ProofBundle={
      schema:'finnor.algorithm-theory-capsule.v2',kind:'AlgorithmTheoryCapsule',specification:expected,program,invariant,proofPlan,
      grammarDigest:totalGrammarDigest,interpreterSource:source,interpreterDigest:hash(source),interpreterProofObjectDigest:model.objectDigest,
      algorithmSource,sourceDigest,proofObject,proofObjectDigest:hash(Buffer.from(proofObject,'base64')),
      theorem:{name:'Y5Total.uniform',statement:expectedTotalStatement,domain:'ALL_FINITE_INTEGER_LISTS',nonemptyEachSize:true,
       feasibleWitnessEveryInput:true,quality:'EXACT_LEAST_INITIAL_STATE',prefixCorrespondence:true,
       operationBound:programOperationBound(program),bitOrWallTimeBound:false},
      runtime:{version:'4.34.1',archiveDigest:tool.archiveDigest,inventoryDigest:tool.inventoryDigest,identityDigest:tool.identityDigest,
       profile:'NATIVE_DARWIN_ARM64_TOTAL_CLOSED_AST',maximumInputItems:128,maximumIntegerDigits:512},
     };
     const checker=await check(payload,expected,{...budget,scratch:join(budget.scratch,'independent-check')});
     const search:TotalAlgorithmTheoryCapsule['search']={attempts:state.attempts,programsExamined:state.programsExamined,
      propositionsExamined:state.propositionsExamined,proofAttempts:state.proofAttempts,stateTypesExamined:state.stateTypesExamined,
      developmentInputs:budget.developmentInputs,limits,nativePreparation:model.native,sharedModelSetupRef:model.setupRef,wallMs:Date.now()-started,
      completeMoney:null,completeHumanSeconds:null,aggregatePeakBytes:null};
     if(Buffer.byteLength(JSON.stringify(search))>limits.maxRetainedBytes)return incomplete('RETAINED_SEARCH_BYTE_LIMIT');
     const selectionRule=budget.episodeSelectionRule??'PUBLIC_LIBRARY_DEVELOPMENT_INPUTS_NOT_OWNER_CENSUS',
      episodeCutDigest=selectionRule==='ALL_ORIGINAL_S5_EPISODES_FOR_AUTHENTICATED_PRINCIPAL'?budget.episodeCutDigest??null:null;
     if(selectionRule==='ALL_ORIGINAL_S5_EPISODES_FOR_AUTHENTICATED_PRINCIPAL'&&!episodeCutDigest)throw Error('Y5_TOTAL_COMPLETE_EPISODE_CUT_REQUIRED');
     const unsigned={...payload,checker,origin:{episodeCutDigest,selectionRule,
      developmentExamplesDigest:jsonHash(budget.developmentInputs),newProtectedStructure:false as const},search,
      admission:{status:'UNADMITTED' as const,protectedAdmission:false as const,productionActive:false as const,executionAuthorityGranted:false as const}};
     const capsule=parseTotalCapsule({...unsigned,digest:jsonHash(unsigned)});
     return {status:'CHECKED',capsule,attempts:state.attempts,wallMs:Date.now()-started};
    }
   }
  }
  return incomplete(state.stopReason??'BOUNDED_TYPED_FRONTIER_EXHAUSTED_NO_ALL_SIZE_CAPSULE');
 });
}
export async function checkTotalAlgorithm(value:unknown,specification:ResolvedTotalSpecification,budget:NativeBudget){
 const capsule=parseTotalCapsule(value),expected=parseResolvedTotalSpecification(specification);
 return withNativeCapacity(()=>check(capsule,expected,budget));
}
const batch=z.array(z.array(z.string().regex(/^(?:0|-?[1-9][0-9]*)$/).refine(s=>s.replace('-','').length<=512)).max(128)).min(1).max(64);
export async function executeTotalAlgorithm(value:unknown,specification:ResolvedTotalSpecification,inputs:unknown,budget:NativeBudget){
 const capsule=parseTotalCapsule(value),expected=parseResolvedTotalSpecification(specification),xs=batch.parse(inputs);
 return withNativeCapacity(async()=>{
  // check() ends with its own currentness fence, and native() opens with one before the run.
  const checked=await check(capsule,expected,budget);
  await writeFile(join(budget.scratch,'Execution.lean'),totalExecutionSource,{mode:0o600});
  await writeFile(join(budget.scratch,'input.json'),JSON.stringify(xs),{mode:0o600});
  const tool=await toolIdentity(Math.min(budget.deadlineAt,Date.now()+30000));
  const execution=await native(tool,['lean','-M','2048','-T','200000','--run','Execution.lean','input.json'],budget,'total-execute-same-definition');
  if(execution.exitCode!==0)throw Object.assign(Error('Y5_TOTAL_NATIVE_EXECUTION'),{receipt:execution});
  const executions=z.array(z.object({value:z.string().regex(/^(?:0|-?[1-9][0-9]*)$/).max(2049),
   operations:z.number().int().nonnegative()}).strict()).length(xs.length).parse(JSON.parse(execution.stdout.trim()));
  const {coefficient,constant}=capsule.theorem.operationBound;
  for(let i=0;i<executions.length;i++)if(executions[i]!.operations>coefficient*xs[i]!.length+constant)throw Error('Y5_TOTAL_COUNTED_BOUND_MISMATCH');
  await current(budget);
  return {executions,checked,execution,semantics:'SAME_KERNEL_CHECKED_TOTAL_DEFINITION_NOT_TS_SURROGATE' as const};
 });
}

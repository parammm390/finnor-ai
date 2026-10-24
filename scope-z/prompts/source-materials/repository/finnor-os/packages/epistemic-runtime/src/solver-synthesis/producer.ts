/** Actual metered Rosette CEGIS. Independent checker remains outside search. */
import {runScientific} from './process';
import {programForChoices} from './grammar';
import {lowerProgram,assertLowering} from './lowering';
import {validateProgram} from './grammar';
import {checkCounterexample,verifyCompleteDomain,assertCoverage,type Witness} from './checker';
import {sourceIdentity,assertSourceIdentity,loadRuntime,runtimeReadPaths,scientificPath} from './runtime';
import {hash,SPECIFICATION,GRAMMAR,type Choices,type Counterexample,type Trial,type SemanticReceipt,type CoverageChunk} from './contracts';

const INITIAL_EXAMPLES=[
 {input:[0,0,0,0,0,0],mask:0},{input:[1,7,7,1,0,0],mask:1},
 {input:[7,1,7,0,1,0],mask:2},{input:[7,7,1,0,0,1],mask:4},
 {input:[7,7,7,7,0,0],mask:1},{input:[7,7,7,0,7,0],mask:2},{input:[7,7,7,0,0,7],mask:4},
 {input:[0,0,0,0,0,1],mask:4},
];
export interface SynthesisHooks {
 onQuery?:(event:unknown)=>Promise<void>;
 onTrial?:(trial:Trial)=>Promise<void>;
 onChunk?:(chunk:CoverageChunk)=>Promise<void>;
 onCandidate?:(trial:Trial)=>Promise<void>;
 onAcceptance?:(trial:Trial,receipt:SemanticReceipt)=>Promise<void>;
 current?:()=>Promise<void>;
}
export async function synthesizeSolver(input:{deadlineAt:number;signal?:AbortSignal;maximumRounds?:number;hooks?:SynthesisHooks;
 retainedTrials?:Trial[];retainedCandidate?:Trial;retainedChunks?:CoverageChunk[];
 retainedIncumbent?:{trial:Trial;receipt:SemanticReceipt}}) {
 const began=performance.now(),runtime=await loadRuntime(),pins=await sourceIdentity(),trials:Trial[]=structuredClone(input.retainedTrials??[]),archive:Counterexample[]=[];
 const examples=structuredClone(INITIAL_EXAMPLES),queries:unknown[]=[];
 for(const retained of trials){
  const alternative=retained.query&&typeof retained.query==='object'&&!Array.isArray(retained.query)&&
   (retained.query as Record<string,unknown>).operation==='POST_ACCEPTANCE_COST_ALTERNATIVE';
  if(!['REJECTED','ACCEPTED','INCOMPLETE'].includes(retained.status)||
   !alternative&&hash(retained.program)!==hash(programForChoices(retained.choices))||
   retained.module.runtime.closureDigest!==hash(pins))throw Error('R8_RETAINED_TRIAL_SOURCE_OR_IDENTITY_CHANGED');
  assertLowering(retained.program,retained.module,hash(pins));
  for(const ce of retained.counterexamples){
   if(ce.candidateDigest!==hash(retained.program)||ce.specificationDigest!==hash(SPECIFICATION))throw Error('R8_RETAINED_COUNTEREXAMPLE_BINDING');
   if(!archive.some(old=>old.id===ce.id))archive.push(ce);
   if(!examples.some(example=>hash(example.input)===hash(ce.input)))examples.push({input:ce.input,mask:(ce.witness as unknown as Witness).reference.mask});
  }
 }
 const maximumRounds=input.maximumRounds??16;
 if(!Number.isSafeInteger(maximumRounds)||maximumRounds<0||maximumRounds>16||
  maximumRounds===0&&!input.retainedCandidate&&!input.retainedIncumbent)throw Error('R8_ORIGINAL_ROUND_BOUND');
 const query=async(request:unknown)=>{
  await input.hooks?.current?.();await assertSourceIdentity(pins);
  const started=Date.now(),deadlineAt=Math.min(input.deadlineAt,started+45000);
  if(deadlineAt<=started||input.signal?.aborted)throw Error('R8_ORIGINAL_SYNTHESIS_BUDGET_EXHAUSTED');
  const result=await runScientific({python:runtime.python.path,supervisor:scientificPath('supervise.py'),executable:runtime.racket.path,
   args:[scientificPath('engine.rkt')],environment:{PLTUSERHOME:runtime.userHome,PLT_PKG_BUILD_SERVICE:'1',FINNOR_R8_Z3:runtime.solver.path},
   readPaths:[...runtimeReadPaths(runtime),scientificPath('engine.rkt')],request,deadlineAt,signal:input.signal});
  const event={request,result,startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),
   queryBasis:{bitwidth:null,freshVC:true,originalDomain:hash(SPECIFICATION),grammar:hash(GRAMMAR),solver:runtime.solver},costUSD:null};
  queries.push(event);await input.hooks?.onQuery?.(event);return result.response as {status:string;choices?:Choices;input?:number[]};
 };
 let receipt:SemanticReceipt|null=null,incumbent:Trial|null=null;
 const accept=async(trial:Trial,retainedChunks?:CoverageChunk[])=>{
  await input.hooks?.current?.();
  const verified=await verifyCompleteDomain({program:trial.program,module:trial.module,runtime,sourcePins:pins,
   deadlineAt:input.deadlineAt,signal:input.signal,retainedChunks,
   onChunk:async chunk=>{await input.hooks?.current?.();await input.hooks?.onChunk?.(chunk);}});
  trial.status='ACCEPTED';trial.resource={usage:verified.resource,receiptDigest:hash(verified),chunkDigest:verified.chunkDigest};
  trials.push(trial);
  // Preserve the full independent preimage even when a later cost alternative
  // replaces the first incumbent. Durable owners retain this append-only event.
  if(input.hooks?.onAcceptance)await input.hooks.onAcceptance(trial,verified);
  else{
   await input.hooks?.onQuery?.({operation:'WHOLE_DOMAIN_ACCEPTANCE',programDigest:hash(trial.program),receipt:verified});
   await input.hooks?.onTrial?.(trial);
  }
  return verified;
 };
 if(input.retainedIncumbent){
  const retained=input.retainedIncumbent;assertCoverage(retained.receipt);
  if(retained.trial.status!=='ACCEPTED'||!trials.some(trial=>hash(trial)===hash(retained.trial))||
   retained.receipt.programDigest!==hash(retained.trial.program)||
   retained.receipt.moduleDigest!==retained.trial.module.compiledDigest||
   retained.receipt.runtimeDigest!==hash(runtime))throw Error('R8_RETAINED_INCUMBENT_RECEIPT_IDENTITY');
  assertLowering(retained.trial.program,retained.trial.module,hash(pins));
  receipt=retained.receipt;incumbent=retained.trial;
  await input.hooks?.onQuery?.({operation:'ACCEPTED_INCUMBENT_RECOVERY',programDigest:hash(incumbent.program),
   receiptDigest:hash(receipt),originalDeadlineAt:new Date(input.deadlineAt).toISOString()});
 }
 if(input.retainedCandidate&&!receipt){
  const retained=structuredClone(input.retainedCandidate);
  if(retained.status!=='INCOMPLETE'||retained.round!==trials.length||retained.counterexamples.length||
   hash(retained.program)!==hash(programForChoices(retained.choices)))throw Error('R8_RECOVERY_CANDIDATE_IDENTITY');
  assertLowering(retained.program,retained.module,hash(pins));
  for(const ce of archive){
   const replay=await checkCounterexample(retained.program,retained.module,ce.input,runtime,input.deadlineAt,input.signal);
   if(replay.witness.failures.length)throw Error('R8_RECOVERY_RETAINED_VIOLATION');
  }
  // No second synthesis or candidate debit. Only previously owner-accepted
  // chunks for these exact bytes/checker can be reused by the independent gate.
  const verification=await query({operation:'VERIFY',choices:retained.choices});
  if(verification.status==='COUNTEREXAMPLE'){
   const checked=await checkCounterexample(retained.program,retained.module,verification.input,runtime,input.deadlineAt,input.signal);
   if(!checked.witness.failures.length)throw Error('R8_SYMBOLIC_COUNTEREXAMPLE_NOT_INDEPENDENTLY_REPRODUCED');
   const identity={input:checked.witness.input,specificationDigest:hash(SPECIFICATION),candidateDigest:hash(retained.program),failure:checked.witness.failures};
   const counterexample:Counterexample={...identity,id:'counterexample:'+hash(identity),witness:checked.witness as unknown as Record<string,unknown>,
    emittedMask:checked.emitted,resource:checked.resource};
   retained.counterexamples=[counterexample];retained.status='REJECTED';retained.resource=checked.resource;
   trials.push(retained);archive.push(counterexample);await input.hooks?.onTrial?.(retained);
   if(!examples.some(example=>hash(example.input)===hash(counterexample.input)))
    examples.push({input:counterexample.input,mask:checked.witness.reference.mask});
  }else{
   if(verification.status!=='UNSAT_ORIGINAL_D_NOT_ACCEPTANCE')throw Error('R8_SYMBOLIC_VERIFIER_UNKNOWN_NO_ACCEPTANCE');
   receipt=await accept(retained,input.retainedChunks);incumbent=retained;
  }
 }
 for(let round=0;round<maximumRounds;round++){
  if(receipt)break;
  let choices:Choices|null=null;const roundQueries:unknown[]=[];
  for(let enabledLimit=0;enabledLimit<=7;enabledLimit++){
   const proposed=await query({operation:'SYNTHESIZE',examples,enabledLimit});roundQueries.push(proposed);
   if(proposed.status==='SAT'&&proposed.choices){choices=proposed.choices;break;}
   if(proposed.status!=='UNSAT')throw Error('R8_SOLVER_UNKNOWN_OR_INCOMPLETE');
  }
  if(!choices)throw Error('R8_CURRENT_GRAMMAR_UNSAT_NOT_BUSINESS_INFEASIBILITY');
  const program=programForChoices(choices),module=lowerProgram(program,hash(pins));
  const trial:Trial={round:trials.length,choices,program,module,query:roundQueries,status:'INCOMPLETE',counterexamples:[],resource:{costUSD:null}};
  await input.hooks?.onCandidate?.(trial);
  // Replay every retained witness against actual executable bytes before search
  // can advance. A contradictory producer cannot silently forget an example.
  for(const retained of archive){
   const replay=await checkCounterexample(program,module,retained.input,runtime,input.deadlineAt,input.signal);
   if(replay.witness.failures.length)throw Error('R8_RETAINED_VIOLATION_REPEATED');
  }
  const verification=await query({operation:'VERIFY',choices});
  if(verification.status==='COUNTEREXAMPLE'){
   const checked=await checkCounterexample(program,module,verification.input,runtime,input.deadlineAt,input.signal);
   if(!checked.witness.failures.length)throw Error('R8_SYMBOLIC_COUNTEREXAMPLE_NOT_INDEPENDENTLY_REPRODUCED');
   const identity={input:checked.witness.input,specificationDigest:hash(SPECIFICATION),candidateDigest:hash(program),failure:checked.witness.failures};
   const counterexample:Counterexample={...identity,id:'counterexample:'+hash(identity),witness:checked.witness as unknown as Record<string,unknown>,
    emittedMask:checked.emitted,resource:checked.resource};
   if(!archive.some(w=>w.id===counterexample.id))archive.push(counterexample);
   trial.counterexamples=[counterexample];trial.status='REJECTED';trial.resource=checked.resource;trials.push(trial);await input.hooks?.onTrial?.(trial);
   if(!examples.some(e=>hash(e.input)===hash(counterexample.input)))examples.push({input:counterexample.input,mask:(checked.witness as Witness).reference.mask});
   continue;
  }
  if(verification.status!=='UNSAT_ORIGINAL_D_NOT_ACCEPTANCE')throw Error('R8_SYMBOLIC_VERIFIER_UNKNOWN_NO_ACCEPTANCE');
  receipt=await accept(trial);incumbent=trial;break;
 }
 if(!receipt)throw Error('R8_ROUND_BUDGET_EXHAUSTED_NO_WHOLE_DOMAIN_CLAIM');
 if(!archive.length||!trials.some(t=>t.status==='REJECTED'))throw Error('R8_NONTRIVIAL_CEGIS_NOT_DEMONSTRATED');
 const optimization:Record<string,unknown>={plan:'ONE_REDUNDANT_ALL_ENABLED_GUARD_ALTERNATIVE',
  costOrder:['compiledBytes','ssaRegisters','astBytes'],globalCheapestClaim:false,status:'NO_REMAINING_BUDGET'};
 const cost=(candidate:Trial)=>[
  candidate.module.bounds.bytes,candidate.module.bounds.steps,Buffer.byteLength(JSON.stringify(candidate.program))];
 const earlierAlternative=trials.find(trial=>trial.status==='ACCEPTED'&&trial.query&&typeof trial.query==='object'&&!Array.isArray(trial.query)&&
  (trial.query as Record<string,unknown>).operation==='POST_ACCEPTANCE_COST_ALTERNATIVE');
 if(earlierAlternative){
  const basis=(earlierAlternative.query as Record<string,unknown>).basis,original=trials.find(trial=>hash(trial.program)===basis);
  if(!original||original.status!=='ACCEPTED')throw Error('R8_RETAINED_OPTIMIZATION_BASIS_CHANGED');
  optimization.status='COMPLETE';optimization.before=cost(original);optimization.after=cost(earlierAlternative);
  optimization.selected=hash(incumbent!.program)===hash(earlierAlternative.program);
  optimization.recoveredFromImmutableAcceptance=true;
 }
 const pendingAlternative=input.retainedIncumbent&&input.retainedCandidate&&input.retainedCandidate.query&&
  typeof input.retainedCandidate.query==='object'&&!Array.isArray(input.retainedCandidate.query)&&
  (input.retainedCandidate.query as Record<string,unknown>).operation==='POST_ACCEPTANCE_COST_ALTERNATIVE'?input.retainedCandidate:undefined;
 if(incumbent&&incumbent.choices.enabled.every(Boolean)&&(pendingAlternative||
  trials.length-(input.retainedTrials?.length??0)<maximumRounds)&&
  !trials.some(trial=>trial.query&&typeof trial.query==='object'&&!Array.isArray(trial.query)&&
   (trial.query as Record<string,unknown>).operation==='POST_ACCEPTANCE_COST_ALTERNATIVE')&&
  input.deadlineAt>Date.now()&&!input.signal?.aborted){
  const program=structuredClone(incumbent.program),loop=program.body.find(statement=>statement.op==='for');
  if(loop?.op==='for'&&loop.body.length===1&&loop.body[0]?.op==='if'){
   // All seven masks are enabled in the accepted incumbent. Propose a smaller
   // grammar tree, then independently recheck it, not a copied receipt.
   loop.body=loop.body[0].then;validateProgram(program);
   const module=lowerProgram(program,hash(pins));
   const trial:Trial=pendingAlternative?structuredClone(pendingAlternative):{round:trials.length,choices:incumbent.choices,program,module,
    query:{operation:'POST_ACCEPTANCE_COST_ALTERNATIVE',basis:hash(incumbent.program)},
    status:'INCOMPLETE',counterexamples:[],resource:{usd:null}};
   if(pendingAlternative&&(trial.status!=='INCOMPLETE'||trial.round!==trials.length||trial.counterexamples.length||
    hash(trial.program)!==hash(program)||hash(trial.module)!==hash(module)||
    (trial.query as Record<string,unknown>).basis!==hash(incumbent.program)))throw Error('R8_RECOVERY_COST_ALTERNATIVE_IDENTITY');
   // The verifier already clamps itself to min(original deadline, 600000 ms).
   // Requiring a fresh full 600000 ms here made every shorter original grant
   // unable even to attempt this registered finite alternative.
   optimization.originalDeadlineAt=new Date(input.deadlineAt).toISOString();
   optimization.remainingOriginalMs=input.deadlineAt-Date.now();
   optimization.verificationCapMs=600000;
   const started=performance.now();if(!pendingAlternative)await input.hooks?.onCandidate?.(trial);
   try{
    const checked=await accept(trial,pendingAlternative?input.retainedChunks:undefined);
    const before=cost(incumbent),after=cost(trial),difference=after.findIndex((value,i)=>value!==before[i]);
    const selected=difference>=0&&after[difference]!<before[difference]!;
    optimization.status='COMPLETE';optimization.before=before;optimization.after=after;
    optimization.alternativeReceiptDigest=hash(checked);optimization.selected=selected;
    if(selected){receipt=checked;incumbent=trial;}
   }catch(error){
    if(trial.status==='ACCEPTED')throw error;
    const reason=error instanceof Error?error.message:'R8_COST_SEARCH_UNKNOWN';
    if(/SOURCE|CURRENT|CHANGED|CANCEL|CLAIM|DEPENDENCY|RIGHTS/.test(reason))throw error;
    trial.resource={reason,usd:null};trials.push(trial);await input.hooks?.onTrial?.(trial);
    optimization.status='INCOMPLETE_INCUMBENT_PRESERVED';optimization.reason=reason;
   }
   optimization.elapsedMs=performance.now()-started;
  }
 }
 return {schema:'finnor.r8.synthesis-result.v1' as const,status:'COMPLETE' as const,program:incumbent!.program,module:incumbent!.module,
  receipt,trials,counterexamples:archive,queries,sourcePins:pins,runtime,visibleExamples:INITIAL_EXAMPLES,
  resources:{elapsedMs:performance.now()-began,queries:queries.length,rounds:trials.length,optimization,usd:null,humanSeconds:null,
   aggregatePeakMemoryBytes:null,qualification:'ACTUAL_CHILD_USAGE_AND_WALL_NO_COMPLETE_DOLLAR_HUMAN_OR_AGGREGATE_METER'},
  domainQualification:null,admission:null,protectedActivation:false as const};
}
export type SynthesisResult=Awaited<ReturnType<typeof synthesizeSolver>>;

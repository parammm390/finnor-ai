import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {evaluateDevelopmentProgram} from '../../../packages/epistemic-runtime/src/uniform-algorithms/total/syntax';

const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??'../evidence/y5-total-search');
await mkdir(evidence,{recursive:true,mode:0o700});
const started=Date.now(),save=(name:string,value:unknown)=>writeFile(join(evidence,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
try{
 const api=await import(new URL('../../../packages/epistemic-runtime/src/uniform-algorithms/total/search.ts',import.meta.url).href);
 const definition={schema:'finnor.y5.total-family-definition.v2',input:'ALL_FINITE_INTEGER_LISTS',output:'MATHEMATICAL_INTEGER',semanticState:'INT',
  safe:{op:'LE',left:{op:'INT',value:'0'},right:{op:'VAR',index:0}},advance:{op:'ADD',left:{op:'VAR',index:0},right:{op:'VAR',index:1}},
  objective:'LEAST_FEASIBLE_INITIAL_STATE',prefixes:'INCLUDING_EMPTY_AND_COMPLETE',numericalMeaning:'EXACT_UNBOUNDED_INTEGER',
  tie:'EQUAL_INTEGER_OUTPUT',costModel:'CLOSED_AST_NODE_AND_FOLD_STEPS_UNIT_INTEGER_ARITHMETIC_V2'};
 const developmentInputs=[[],['-1'],['1'],['-2','3'],['2','-3'],['1','-2','1'],['-2','-1','4']];
 const limits={maxPrograms:20000,maxPropositions:10000,maxProofAttempts:12,maxRetainedBytes:8388608};
 const state=api.newSearchState(),budget={deadlineAt:Date.now()+30000,current:async()=>true};
 const iterator=api.programCandidates(definition,developmentInputs,limits,budget,state);
 const next=await iterator.next();await iterator.return?.();assert(!next.done,'No program proposal within the registered frontier');
 const program=next.value;
 const words:bigint[][]=[[]];let frontier:bigint[][]=[[]];
 for(let n=1;n<=4;n++){frontier=frontier.flatMap(xs=>[-2n,-1n,0n,1n,2n].map(x=>[...xs,x]));words.push(...frontier);}
 const observed=words.map(xs=>{
  const answer=evaluateDevelopmentProgram(program,xs);
  const valid=(c:bigint)=>{if(c<0n)return false;for(const x of xs){c+=x;if(c<0n)return false;}return true;};
  const feasible=[];for(let c=0n;c<=8n;c++)if(valid(c))feasible.push(c);
  assert.equal(answer,feasible[0]);return {input:xs.map(String),answer:answer.toString()};
 });
 const propositions=[];
 for await(const p of api.propositionCandidates(definition,program,developmentInputs,limits,budget,state)){
  propositions.push(p);if(propositions.length>=12)break;
 }
 assert(propositions.length);assert(state.attempts.some((a:any)=>a.stage==='PROGRAM_DEVELOPMENT'&&a.status==='REFUTED'));
 assert(state.attempts.some((a:any)=>a.stage==='CONJECTURE_DEVELOPMENT'&&a.status==='REFUTED'));
 assert(state.stateTypesExamined.length>=4,'The search must actually examine different algorithm-state types');
 assert.equal((await api.programCandidates(definition,developmentInputs,limits,{...budget,current:async()=>false},api.newSearchState()).next()).done,true);
 await save('results.json',{status:'PASS',scope:'FINITE_RUNTIME_TYPED_PROGRAM_AND_PROPOSITION_SEARCH_NOT_ALL_SIZE_PROOF',
  wallMs:Date.now()-started,definition,developmentInputs,limits,program,propositions,search:state,independentOriginalPrefixCases:observed,
  mathematicalQualification:'UNPROVED_UNTIL_NATIVE_UNIFORM_THEOREM',protectedFamilyCredit:false,
  rerun:'FINNOR_Y5_EVIDENCE_DIR=<new-directory> node_modules/.bin/tsx scripts/postx/y5/verify-total-search.mts'});
 console.log(JSON.stringify({status:'PASS',evidence,programs:state.programsExamined,propositions:state.propositionsExamined}));
}catch(error){await save('failure.json',{status:'FAIL',error:String(error),stack:(error as Error).stack});throw error;}

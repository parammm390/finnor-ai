import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {jsonHash,hash} from '../../../packages/epistemic-runtime/src/uniform-algorithms/syntax';
import type {ResolvedTotalSpecification} from '../../../packages/shared-types/src/total-algorithm-theory';

const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??'../evidence/y5-total-native');
await mkdir(evidence,{recursive:true,mode:0o700});
const started=Date.now(),deadlineAt=started+300000,observed:unknown[]=[];
const save=(name:string,value:unknown)=>writeFile(join(evidence,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const definition={schema:'finnor.y5.total-family-definition.v2' as const,input:'ALL_FINITE_INTEGER_LISTS' as const,
 output:'MATHEMATICAL_INTEGER' as const,semanticState:'INT' as const,safe:{op:'LE' as const,left:{op:'INT' as const,value:'0'},right:{op:'VAR' as const,index:0}},
 advance:{op:'ADD' as const,left:{op:'VAR' as const,index:0},right:{op:'VAR' as const,index:1}},
 objective:'LEAST_FEASIBLE_INITIAL_STATE' as const,prefixes:'INCLUDING_EMPTY_AND_COMPLETE' as const,
 numericalMeaning:'EXACT_UNBOUNDED_INTEGER' as const,tie:'EQUAL_INTEGER_OUTPUT' as const,
 costModel:'CLOSED_AST_NODE_AND_FOLD_STEPS_UNIT_INTEGER_ARITHMETIC_V2' as const};
const expected:ResolvedTotalSpecification={schema:'finnor.y5.resolved-specification.v2',
 sourceRef:{owner:'WORK_INPUT',id:'public-native-input-not-an-owner-receipt',version:'y5-work-specification-v2',contentDigest:jsonHash(definition)},
 definition,definitionDigest:jsonHash(definition),
 acceptance:{status:'PUBLIC_DEVELOPMENT',reason:'NO_INDEPENDENT_ACCEPTANCE_RECEIPT',protectedFamilyCredit:false}};
await save('registered-input.json',{expected,deadlineAt:new Date(deadlineAt).toISOString(),nativeCallLimitMs:30000,
 scope:'PUBLIC_LIBRARY_PROOF_BOUNDARY_NOT_AUTHENTICATED_OWNER_OR_INDEPENDENT_ACCEPTANCE',
 falsifiers:['finite-only agreement','unused structural lemma','missed empty prefix','wrong owner target','changed AST or interpreter','substituted proof object','unmetered nested work']});
try{
 const api=await import(new URL('../../../packages/epistemic-runtime/src/uniform-algorithms/total/index.ts',import.meta.url).href);
 const budget={deadlineAt,scratch:join(evidence,'native')};
 const developmentInputs=[[],['-1'],['1'],['-2','3'],['2','-3'],['1','-2','1'],['-2','-1','4']];
 const result=await api.discoverTotalAlgorithm(expected,{...budget,developmentInputs,
  episodeCutDigest:jsonHash({scope:'PUBLIC_LIBRARY_ONLY',developmentInputs}),
  limits:{maxPrograms:20000,maxPropositions:10000,maxProofAttempts:12,maxRetainedBytes:8388608}});
 await save('discovery.json',result);assert.equal(result.status,'CHECKED');
 const capsule=result.capsule;assert(capsule);
 assert.equal(capsule.schema,'finnor.algorithm-theory-capsule.v2');
 assert.equal(capsule.theorem.domain,'ALL_FINITE_INTEGER_LISTS');assert(capsule.theorem.nonemptyEachSize);
 assert(capsule.theorem.feasibleWitnessEveryInput);assert(capsule.theorem.prefixCorrespondence);
 assert(capsule.checker.loadBearingLemmaInProof);assert(capsule.checker.countedDenotationAgreement);
 assert(capsule.checker.allSizeOperationBound);assert.equal(capsule.origin.newProtectedStructure,false);
 assert(result.attempts.some((a:any)=>a.status==='REFUTED'));
 const checked=await api.checkTotalAlgorithm(capsule,expected,{...budget,scratch:join(evidence,'checker')});
 assert(checked.exactOwnerExpectedType&&checked.suppliedProofObjectReplayed);
 const inputs=[[],['1','-3','4'],['-4','2','-3','8'],['2','2','-1'],['9'.repeat(80),'-'+'9'.repeat(80),'-1']];
 const execution=await api.executeTotalAlgorithm(capsule,expected,inputs,{...budget,scratch:join(evidence,'execution')});
 assert.equal(execution.executions.length,inputs.length);
 for(let i=0;i<inputs.length;i++){
  const xs=inputs[i]!.map(BigInt),answer=execution.executions[i],r=BigInt(answer.value);
  const prefixBalances=(initial:bigint)=>{const balances=[initial];for(const x of xs)balances.push(balances[balances.length-1]!+x);return balances;};
  assert(prefixBalances(r).every(v=>v>=0n));assert(prefixBalances(r-1n).some(v=>v<0n));
  if(xs.every(v=>v>=-10n&&v<=10n)){
   const exhaustive=[];for(let c=0n;c<=30n;c++)if(prefixBalances(c).every(v=>v>=0n))exhaustive.push(c);
   assert.equal(r,exhaustive[0]);
  }
  assert(answer.operations<=capsule.theorem.operationBound.coefficient*xs.length+capsule.theorem.operationBound.constant);
  observed.push({input:inputs[i],answer,independentEveryPrefixFeasible:true,oneLessRefuted:true});
 }
 const resign=(c:any)=>{const {digest:_,...body}=c;return {...body,digest:jsonHash(body)};};
 const reject=async(name:string,c:any,spec=expected)=>{
  await assert.rejects(()=>api.checkTotalAlgorithm(resign(c),spec,{...budget,scratch:join(evidence,'reject-'+observed.length)}));
  observed.push({case:name,status:'REJECTED'});
 };
 await reject('changed program after proof',{...capsule,program:{...capsule.program,initial:{op:'INT',value:'1'}}});
 await reject('changed structural proposition',{...capsule,invariant:{op:'TRUE'}});
 await reject('changed interpreter',{...capsule,interpreterSource:capsule.interpreterSource+'\n'});
 await reject('substituted proof object',{...capsule,proofObject:'eA==',proofObjectDigest:hash('x')});
 await reject('different independently expected task',capsule,{...expected,
  definition:{...definition,safe:{op:'BOOL',value:true}},definitionDigest:jsonHash({...definition,safe:{op:'BOOL',value:true}})});
 await save('results.json',{status:'PASS',scope:'PUBLIC_RUNTIME_SYNTHESIS_KERNEL_ALL_SIZE_SAME_DEFINITION_NOT_OWNER_OR_PROTECTED',
  wallMs:Date.now()-started,capsuleDigest:capsule.digest,checked,execution,observed,
  rerun:'FINNOR_Y5_EVIDENCE_DIR=<new-directory> node_modules/.bin/tsx scripts/postx/y5/verify-total-native.mts'});
 console.log(JSON.stringify({status:'PASS',evidence,wallMs:Date.now()-started}));
}catch(error){await save('failure.json',{status:'FAIL',error:String(error),stack:(error as Error).stack,receipt:(error as any).receipt??null,observed});throw error;}

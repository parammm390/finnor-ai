import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';

const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??'../evidence/y5-total-boundary');
await mkdir(evidence,{recursive:true,mode:0o700});
const started=Date.now(),observed:{case:string;status:string}[]=[];
const save=(name:string,value:unknown)=>writeFile(join(evidence,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
try{
 const api=await import(new URL('../../../packages/epistemic-runtime/src/uniform-algorithms/total/syntax.ts',import.meta.url).href);
 const zero={op:'INT',value:'0'},head={op:'VAR',index:0},tail={op:'VAR',index:1};
 const definition={schema:'finnor.y5.total-family-definition.v2',input:'ALL_FINITE_INTEGER_LISTS',output:'MATHEMATICAL_INTEGER',
  semanticState:'INT',safe:{op:'LE',left:zero,right:head},advance:{op:'ADD',left:head,right:tail},
  objective:'LEAST_FEASIBLE_INITIAL_STATE',prefixes:'INCLUDING_EMPTY_AND_COMPLETE',numericalMeaning:'EXACT_UNBOUNDED_INTEGER',
  tie:'EQUAL_INTEGER_OUTPUT',costModel:'CLOSED_AST_NODE_AND_FOLD_STEPS_UNIT_INTEGER_ARITHMETIC_V2'};
 const parsed=api.parseDefinition(definition);assert.deepEqual(parsed,definition);
 const reject=(name:string,f:()=>unknown)=>{assert.throws(f,name);observed.push({case:name,status:'REJECTED'});};
 reject('task cannot supply an algorithm',()=>api.parseDefinition({...definition,program:{}}));
 reject('task cannot supply an invariant',()=>api.parseDefinition({...definition,invariant:'assume true'}));
 reject('empty prefix cannot be removed',()=>api.parseDefinition({...definition,prefixes:'NONEMPTY_ONLY'}));
 reject('unsafe source is not an expression',()=>api.parseDefinition({...definition,advance:{op:'RAW_LEAN',source:'axiom false : False'}}));
 reject('transition variables are typed and bounded',()=>api.parseDefinition({...definition,advance:{op:'VAR',index:2}}));
 reject('safety must be Boolean',()=>api.parseDefinition({...definition,safe:zero}));
 reject('integer strings are canonical',()=>api.parseDefinition({...definition,advance:{op:'INT',value:'-0'}}));
 const program={schema:'finnor.y5.total-program.v2',recursion:'RIGHT_STRUCTURAL_FOLD',stateType:'INT',initial:zero,
  step:{op:'ADD',left:head,right:tail},result:head};
 assert.deepEqual(api.parseProgram(program),program);
 assert.equal(api.evaluateDevelopmentProgram(program,[1n,2n,-4n]),-1n);
 const pair={...program,stateType:{product:['INT','INT']},initial:{op:'PAIR',left:zero,right:zero},
  step:{op:'PAIR',left:head,right:{op:'FIRST',arg:tail}},result:{op:'SECOND',arg:head}};
 assert.deepEqual(api.parseProgram(pair),pair);assert.equal(api.evaluateDevelopmentProgram(pair,[3n,4n,5n]),4n);
 const list={...program,stateType:{list:'INT'},initial:{op:'EMPTY',element:'INT'},
  step:{op:'CONS',left:head,right:tail},result:{op:'HEAD',arg:head}};
 assert.deepEqual(api.parseProgram(list),list);assert.equal(api.evaluateDevelopmentProgram(list,[7n,8n]),7n);
 assert.equal(api.evaluateDevelopmentProgram(list,[]),0n);
 reject('product projection cannot read an integer',()=>api.parseProgram({...program,result:{op:'FIRST',arg:head}}));
 reject('algorithm initial state is closed',()=>api.parseProgram({...program,initial:head}));
 reject('algorithm state does not borrow economic state variables',()=>api.parseProgram({...program,step:{op:'VAR',index:2}}));
 reject('recursion cannot be caller source',()=>api.parseProgram({...program,recursion:'while true'}));
 let deep:any=zero;for(let n=0;n<40;n++)deep={op:'ADD',left:zero,right:deep};
 reject('expression depth is bounded before recursive parsing',()=>api.parseProgram({...program,initial:deep}));
 const cyclic:any={op:'NOT'};cyclic.arg=cyclic;
 reject('cyclic input is rejected',()=>api.parseProgram({...program,initial:cyclic}));
 const nonThreshold={op:'OR',left:{op:'SAFE',arg:{op:'OUTPUT'}},right:{op:'NOT',arg:{op:'FEASIBLE',arg:{op:'INITIAL'}}}};
 assert.deepEqual(api.parseProposition(nonThreshold),nonThreshold);
 assert.deepEqual(api.parseProposition({op:'FALSE'}),{op:'FALSE'});
 reject('proposition language cannot inject a proof',()=>api.parseProposition({...nonThreshold,proof:'sorry'}));
 const huge=BigInt('9'.repeat(80));
 assert.equal(api.evaluateDevelopmentProgram(program,[huge,1n,-huge]),1n);
 assert(api.developmentFeasible(definition,[1n,-3n,4n],2n));
 assert(!api.developmentFeasible(definition,[1n,-3n,4n],1n));
 assert(!api.developmentFeasible(definition,[],-1n));
 const source=api.renderProgram(program);assert.equal(api.renderProgram(JSON.parse(JSON.stringify(program))),source);
 assert(!source.includes('sorry'));assert(!source.includes('unsafe'));
 observed.push({case:'scalar, product and list state, generic propositions, exact integers and prefix meaning',status:'PASS'});
 await save('results.json',{status:'PASS',scope:'PUBLIC_TYPED_LIBRARY_BOUNDARY_NOT_NATIVE_PROOF_OR_OWNER_COMPLETION',
  wallMs:Date.now()-started,inputs:{definition,program,pair,list,nonThreshold},observed,renderedProgram:source,
  rerun:'FINNOR_Y5_EVIDENCE_DIR=<new-directory> node_modules/.bin/tsx scripts/postx/y5/verify-total-boundary.mts'});
 console.log(JSON.stringify({status:'PASS',evidence,cases:observed.length}));
}catch(error){await save('failure.json',{status:'FAIL',error:String(error),stack:(error as Error).stack,observed});throw error;}

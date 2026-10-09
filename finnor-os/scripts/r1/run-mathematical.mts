/** Registered real S4/checker boundary plus independent complete-policy oracle.
 * Authoring contract and retention: scope-r/r1-certified-state-reduction/failure-model.md. */
import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {extendedRegisteredModels} from './fixtures.mts';
const output=process.env.FINNOR_R1_EVIDENCE_DIR;if(!output)throw Error('R1_PRIVATE_EVIDENCE_DIRECTORY_REQUIRED');await mkdir(output,{recursive:true});
const production=await import('../../packages/epistemic-runtime/src/certified-state-reduction/index.ts');
const control=await import('../../packages/epistemic-runtime/src/contingent-control.ts');
const records:any[]=[],cases=extendedRegisteredModels(),sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const budget=()=>({deadlineAt:Date.now()+30000,maxSteps:4000000});
const filter=process.env.FINNOR_R1_CASE_FILTER?.split(',');
const write=async(name:string,value:unknown)=>writeFile(output+'/'+name+'.json',JSON.stringify(value,null,2)+'\n');
async function test(id:string,contract:string,fn:()=>Promise<any>){
 if(filter&&!filter.some(f=>id.includes(f))){records.push({id,status:'NOT_RUN',contract});return;}
 const start=performance.now();try{const evidence=await fn();records.push({id,status:'PASS',contract,elapsedMs:performance.now()-start});await write(id,{id,status:'PASS',contract,evidence,elapsedMs:performance.now()-start});}
 catch(error){const evidence={error:String(error),stack:(error as Error).stack};records.push({id,status:'FAIL',contract,evidence,elapsedMs:performance.now()-start});await write(id,{id,status:'FAIL',contract,evidence});}
 await save();
}
async function save(){await write('mathematical-results',{schema:'finnor.r1.mathematical-e2e.v2',records,claim:'EXHAUSTIVE_REGISTERED_COMPLETE_POLICIES_AND_INDEPENDENT_FULL_RELATION_NOT_FIELD_ADMISSION',rerun:'python3 finnor-os/scripts/r1/run-native.py mathematical',referenceSha256:sha(await readFile(fileURLToPath(new URL('./reference.py',import.meta.url))))});}
const ordered=(v:any):any=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
const vectors=(evaluation:any)=>{const root=evaluation.family[evaluation.root]??[],best=evaluation.values[evaluation.root],q=(v:any)=>[BigInt(v.numerator),BigInt(v.denominator)];
 const [bn,bd]=q(best);return [...new Set(root.filter((a:any)=>{const vs=Object.values(a.worldValues).map(q),[n,d]=vs.reduce((a,b)=>a[0]*b[1]<=b[0]*a[1]?a:b);return n*bd===bn*d;}).map((a:any)=>JSON.stringify(ordered(a.worldValues))))].sort();};
for(const model of cases)await test('complete-'+model.id,'Complete independent original and reconstructed quotient enumeration, global current/later ties, original feasible family and exact optimum/world vectors',async()=>{
 const bytes=JSON.stringify(model),candidate=production.proposeControlQuotient(bytes,budget()),accepted=await production.checkControlQuotient(bytes,candidate,budget());assert.equal(accepted.status,'COMPLETE',JSON.stringify(accepted));
 const reference=spawnSync(process.env.FINNOR_R1_PYTHON??'python3',[fileURLToPath(new URL('./reference.py',import.meta.url))],{input:JSON.stringify({model,candidate}),encoding:'utf8',timeout:30000,maxBuffer:16*1024*1024});
 assert.equal(reference.status,0,reference.stderr);const oracle=JSON.parse(reference.stdout);
 const off=control.evaluateExactContingentControl(bytes,{...budget(),reuse:null}),on=control.evaluateExactContingentControl(bytes,{...budget(),reuse:{candidate,receipt:accepted}});
 assert.equal(on.status,oracle.states[model.roots[0]!].status,JSON.stringify(on.reasons));assert.equal(off.status,on.status);assert.deepEqual(on.values,off.values);assert.deepEqual(on.optimalActions,off.optimalActions);
 if(on.status==='COMPLETE'){
  for(const root of model.roots){assert.deepEqual(on.values[root],oracle.states[root].optimum);assert.deepEqual(Object.fromEntries(Object.entries(on.optimalActions).map(([id,v]:any)=>[id,[...v].sort()])),oracle.states[root].optimalActions);assert.equal(off.family[root]!.length,oracle.states[root].feasiblePolicyCount);assert.deepEqual(vectors(off),oracle.states[root].optimalWorldVectors.map((v:string)=>JSON.stringify(JSON.parse(v))));assert.deepEqual(vectors(on),vectors(off));}
  assert.deepEqual(on.selectedActions,off.selectedActions);assert.deepEqual(on.selectedWorldValues,off.selectedWorldValues);
 }
 if(model.id==='equivalent-histories'){assert(candidate.blocks.length<model.states.length);assert(on.stats.reuseHits>0);assert(on.stats.continuationEvaluations<off.stats.continuationEvaluations);}
 if(model.id==='identity-quotient')assert.equal(candidate.blocks.length,model.states.length);
 return {modelBytes:bytes,sourceDigest:sha(bytes),candidate,accepted,oracle,off,on};
});
const base=cases[0]!,bytes=JSON.stringify(base),candidate=production.proposeControlQuotient(bytes,budget());
const accepted=await production.checkControlQuotient(bytes,candidate,budget());
const sourceCases:Array<{id:string;predicate:string;edit:(m:any)=>void;raw?:(s:string)=>string}>=[
 {id:'negative-denominator',predicate:'RATIONAL_DENOMINATOR',edit:m=>m.actions[0].cost.denominator='-1'},
 {id:'zero-denominator',predicate:'RATIONAL_DENOMINATOR',edit:m=>m.actions[0].cost.denominator='0'},
 {id:'unit-mismatch',predicate:'EXACT_ACTION_CONTRACT',edit:m=>m.actions[0].costUnit='OTHER'},
 {id:'quantity-mismatch',predicate:'ORIGINAL_ACTION_RESOURCE_OR_S6_OBLIGATION',edit:m=>m.states[0].transitions[0].outcomes[0].resourceDelta.capital={numerator:'1',denominator:'3'}},
 {id:'time-mismatch',predicate:'WORLD_IDENTITY_TEMPORAL_OR_HISTORY_CLOSURE',edit:m=>m.states[0].transitions[0].outcomes[0].successor='root'},
 {id:'duplicate-state',predicate:'DUPLICATE_STATE_OR_ACTION',edit:m=>m.states.push(structuredClone(m.states[0]))},
 {id:'duplicate-action',predicate:'DUPLICATE_STATE_OR_ACTION',edit:m=>m.actions.push(structuredClone(m.actions[0]))},
 {id:'hidden-world-branch',predicate:'NON_MARKOV_CONTROLLER_INFORMATION',edit:m=>{const s=structuredClone(m.states[1]);s.id='hidden-state';m.states.push(s);}},
 {id:'duplicate-json-member',predicate:'DUPLICATE_JSON_MEMBER',edit:()=>undefined,raw:s=>s.replace('"schema":','"schema":"ignored","schema":')},
 {id:'semantic-source-digit-bound',predicate:'RATIONAL_SOURCE_ENCODING',edit:m=>{for(const s of m.states)s.semantics.maturity=[{amount:{numerator:'1'.repeat(129),denominator:'1'}}];}},
 {id:'malformed-money-owner-ref',predicate:'EXACT_OWNER_BINDINGS',edit:m=>m.units.money.discountConventionRef={id:'fake'}},
 {id:'probability-root-mass',predicate:'PROBABILITY_ROOT_MASS',edit:m=>{m.uncertainty.kind='EXACT_PROBABILITY_LAW';m.uncertainty.lawRef=m.sourceRefs[0];m.uncertainty.worldWeights=Object.fromEntries(m.uncertainty.worlds.map((w:string)=>[w,{numerator:'1',denominator:'3'}]));}}
];
await write('case-registration',{registeredBeforeRun:true,sourceCases:sourceCases.map(({id,predicate})=>({id,predicate})),completeCases:cases.map(m=>({id:m.id,states:m.states.length,actions:m.actions.length,periods:m.horizon.periods})),oracle:'reference.py v2 complete independent policies / reconstructed quotient; checker.py direct original-byte predicate'});
for(const c of sourceCases)await test('source-'+c.id,'Independent original-byte contract rejects the named malformed source predicate',async()=>{
 const model=structuredClone(base);c.edit(model);const original=c.raw?.(JSON.stringify(model))??JSON.stringify(model);
 const bound=structuredClone(candidate);bound.modelDigest=sha(original);
 if(c.id==='semantic-source-digit-bound')for(const b of bound.blocks)(b.label as any).semantics.maturity=model.states[0].semantics.maturity;
 const receipt=await production.checkControlQuotient(original,bound,budget());let ownerValidation:any;try{production.parseExactInformationModel(original,budget());ownerValidation={accepted:true};}catch(e){ownerValidation={accepted:false,predicate:(e as Error).message};}
 await write('observed-source-'+c.id,{originalBytes:original,bound,receipt,ownerValidation});assert.equal(receipt.predicate,c.predicate);assert.notEqual(receipt.status,'COMPLETE');
 // Source-owner validation must also reject; two paths protect independently
 // callable original OFF and separate checker transport, not duplicate oracles.
 assert.throws(()=>production.parseExactInformationModel(original,budget()));
 return {originalBytes:original,receipt};
});
const candidateCases:Array<{id:string;predicate:string;edit:(m:any)=>void}>=[
 {id:'membership',predicate:'RELATION_MEMBER_COVERAGE',edit:m=>m.blocks[0].members.pop()},
 {id:'label',predicate:'QUOTIENT_ORIGINAL_LABEL_OR_EDGE',edit:m=>m.blocks[0].label.period++},
 {id:'action',predicate:'QUOTIENT_ORIGINAL_LABEL_OR_EDGE',edit:m=>{const b=m.blocks.find((b:any)=>b.transitions.length);b.transitions.pop();}},
 {id:'world-map',predicate:'QUOTIENT_ORIGINAL_LABEL_OR_EDGE',edit:m=>m.blocks[0].label.worlds.reverse()},
 {id:'mass',predicate:'QUOTIENT_ORIGINAL_LABEL_OR_EDGE',edit:m=>{const b=m.blocks.find((b:any)=>b.transitions.length);b.transitions[0].outcomes[0].mass.denominator='2';}},
 {id:'immediate-change',predicate:'QUOTIENT_ORIGINAL_LABEL_OR_EDGE',edit:m=>{const b=m.blocks.find((b:any)=>b.transitions.length);b.transitions[0].outcomes[0].label.immediateUtility.numerator='123';}},
 {id:'lifting',predicate:'ORIGINAL_INFORMATION_LIFT',edit:m=>m.lift[0].period++},
 {id:'root-map',predicate:'ROOT_OR_RELATION_MAP',edit:m=>m.roots[0]='fabricated'},
 {id:'version',predicate:'ORIGINAL_BYTES_VERSION_BINDING',edit:m=>m.producerVersion='unapproved'},
 {id:'claim-authority',predicate:'EQUIVALENCE_CLAIM_SCOPE',edit:m=>m.witness.qualification='PROTECTED'}
];
for(const c of candidateCases)await test('candidate-'+c.id,'Independent relation checking reaches and rejects the changed complete relation premise',async()=>{
 const mutation=structuredClone(candidate);c.edit(mutation);const receipt=await production.checkControlQuotient(bytes,mutation,budget());assert.equal(receipt.predicate,c.predicate);assert.notEqual(receipt.status,'COMPLETE');return {modelBytes:bytes,mutation,receipt};
});
for(const field of ['checkerDigest','checkerVersion','modelDigest','candidateDigest','profile','relationComplete','executionAuthorityGranted'])await test('consumption-'+field,'Real S4 refuses changed receipt identity/claim rather than accepting a producer-shaped certificate',async()=>{
 const receipt:any=structuredClone(accepted);receipt[field]=typeof receipt[field]==='boolean'?!receipt[field]:'untrusted-replacement';
 const result=control.evaluateExactContingentControl(bytes,{...budget(),reuse:{candidate,receipt}});assert.equal(result.status,'UNSUPPORTED');assert.deepEqual(result.reasons,['CURRENT_INDEPENDENT_ACCEPTANCE_REQUIRED']);return {receipt,result};
});
await test('probability-unqualified-owner-law','Exact mass branch checked, but S4 cannot manufacture an admitted probability owner law',async()=>{
 const model=structuredClone(base);model.uncertainty.kind='EXACT_PROBABILITY_LAW';model.uncertainty.lawRef=model.sourceRefs[0]!;model.uncertainty.worldWeights=Object.fromEntries(model.uncertainty.worlds.map(w=>[w,{numerator:'1',denominator:String(model.uncertainty.worlds.length)}]));
 const source=JSON.stringify(model),proposed=production.proposeControlQuotient(source,budget()),receipt=await production.checkControlQuotient(source,proposed,budget());assert.equal(receipt.status,'COMPLETE');assert.equal(receipt.probabilityLawQualified,false);
 const result=control.evaluateExactContingentControl(source,{...budget(),reuse:{candidate:proposed,receipt}});assert.equal(result.status,'UNSUPPORTED');assert.deepEqual(result.reasons,['CURRENT_QUALIFIED_S3_PROBABILITY_LAW_REQUIRED']);return {model,proposed,receipt,result};
});
await save();process.exitCode=records.some(r=>r.status==='FAIL')?1:0;

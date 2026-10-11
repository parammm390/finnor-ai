import { strict as assert } from 'node:assert';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { compilePolicyAtlas } from '../../packages/epistemic-runtime/src/policy-atlas/compiler';
import { lookupAtlas } from '../../packages/epistemic-runtime/src/policy-atlas/query';
import { atlasHash, bytesHash } from '../../packages/epistemic-runtime/src/policy-atlas/exact';
import { DEFAULT_ATLAS_BUDGET } from '../../packages/epistemic-runtime/src/policy-atlas/contracts';
import { fixtureSource } from './fixtures.mts';
import type { AtlasProposal } from '../../packages/shared-types/src/decision-atlas';

const output=resolve(process.env.FINNOR_R7_EVIDENCE_DIR??'../scope-r/r7-policy-atlas-compiler/evidence/exact');
await mkdir(output,{recursive:true});
const checker=resolve('packages/epistemic-runtime/src/policy-atlas/checker.py'),checkerDigest=bytesHash(await readFile(checker)),
  reference=resolve('scripts/r7/reference.py'),corpus=JSON.parse(await readFile(resolve('scripts/r7/corpus.json'),'utf8'));
const results:unknown[]=[],mutations:unknown[]=[],started=Date.now();
const python=process.env.FINNOR_R7_PYTHON??'/usr/bin/python3';
function child(path:string,input:unknown){
  const run=spawnSync(python,[path],{input:JSON.stringify(input),encoding:'utf8',maxBuffer:33554432,timeout:60000});
  assert.equal(run.status,0,run.stderr);return JSON.parse(run.stdout);
}
async function save(){await writeFile(resolve(output,'results.json'),JSON.stringify({schema:'finnor.r7.exact-e2e.v1',
  inputCorpusDigest:bytesHash(await readFile(resolve('scripts/r7/corpus.json'))),checkerDigest,referenceDigest:bytesHash(await readFile(reference)),
  startedAt:new Date(started).toISOString(),finishedAt:new Date().toISOString(),runtime:process.version,results,mutations,
  qualification:'DETERMINISTIC_SYNTHETIC_MODEL_RELATIVE_WHOLE_CELL_NOT_ADMISSION_OR_FIELD',money:null},null,2)+'\n');}
let diagnostic:{source:ReturnType<typeof fixtureSource>;atlas:AtlasProposal}|null=null;
for(const c of corpus.cases){
  const t=performance.now();try{
    if(c.kind==='unsupported'){
      const s=fixtureSource('diagnostic');(s.worlds[0]!.paths[0]!.states[0]!.net as unknown as Record<string,unknown>).product=['x0','x0'];
      assert.throws(()=>compilePolicyAtlas(s,checkerDigest),/Unsupported/);
      results.push({id:c.id,status:'PASS',predicate:'UNSUPPORTED_AFFINE_ORIGINAL_INPUT'});continue;
    }
    const source=fixtureSource(c.kind,c.parameters,c.policies,c.worlds,c.periods),
      budget={...DEFAULT_ATLAS_BUDGET,...(c.maxNodes?{maxNodes:c.maxNodes}:{})};
    if(c.expectedError){assert.throws(()=>compilePolicyAtlas(source,checkerDigest,budget),new RegExp(c.expectedError));results.push({id:c.id,status:'PASS',predicate:c.expectedError});continue;}
    const atlas=compilePolicyAtlas(source,checkerDigest,budget),check=child(checker,{source,proposal:atlas}).data;
    await writeFile(resolve(output,c.id+'.json'),JSON.stringify({input:source,atlas,check},null,2));
    assert.equal(check.status,'ACCEPTED',JSON.stringify(check));
    if(c.expectedCoverage)assert.equal(atlas.coverage,c.expectedCoverage);
    else assert.equal(atlas.coverage,'COMPLETE');
    const points=c.points?.map((p:{x:string})=>[p.x])??[source.parameterValues];
    if(c.expectedAtThreeQuarters)points.push(['3/4']);
    const ref=child(reference,{source,points});
    for(const row of ref.arrangement.points){
      const q=lookupAtlas(source,atlas,row.point);if(q.disposition==='GAP')continue;
      assert.equal(q.label?.winnerPolicyId,row.expected.winner);
      assert.deepEqual(q.label?.tiedPolicyIds,row.expected.ties);
      assert.equal(q.value,row.expected.value);
    }
    for(let i=0;i<points.length;i++){
      const q=lookupAtlas(source,atlas,points[i]);if(q.disposition==='GAP')continue;
      assert.equal(q.label?.winnerPolicyId,ref.queries[i].winner);assert.deepEqual(q.label?.tiedPolicyIds,ref.queries[i].ties);
      if(c.points){assert.equal(q.label?.winnerPolicyId,c.points[i].winner);assert.deepEqual(q.label?.tiedPolicyIds,c.points[i].ties);
        if(c.points[i].worst)assert.deepEqual(q.label?.policies.find(p=>p.policyId===q.label?.winnerPolicyId)?.worstWorldIds,c.points[i].worst);}
      if(Object.hasOwn(c,'expectedWinner'))assert.equal(q.label?.winnerPolicyId,c.expectedWinner);
      if(c.expectedValue)assert.equal(q.value,c.expectedValue);
      if(c.expectedWorstWorlds)assert.equal(q.label?.policies.find(p=>p.policyId===q.label?.winnerPolicyId)?.worstWorldIds.length,c.expectedWorstWorlds);
      if(c.expectedAtThreeQuarters&&i===1)assert.equal(q.label?.winnerPolicyId,c.expectedAtThreeQuarters);
    }
    if(c.id==='authoring-diagnostic')diagnostic={source,atlas};
    results.push({id:c.id,status:'PASS',durationMs:performance.now()-t,costs:atlas.costs,check,reference:ref.arrangement});
  }catch(error){results.push({id:c.id,status:'FAIL',observed:String(error),durationMs:performance.now()-t});}
  finally{await save();}
}
assert(diagnostic);
for(const id of corpus.mutations){
  const source=structuredClone(diagnostic.source),proposal=structuredClone(diagnostic.atlas),
    cell=proposal.nodes.find(node=>node.kind==='CELL')!,split=proposal.nodes.find(node=>node.kind==='SPLIT')!;
  assert(cell.kind==='CELL'&&split.kind==='SPLIT');
  if(id==='wrong-vertex')cell.geometry.vertices[0]![0]='100/1';
  if(id==='missing-vertex')cell.geometry.vertices.pop();
  if(id==='wrong-hull')cell.geometry.affineDimension=4;
  if(id==='empty-cell-lie')proposal.nodes[proposal.nodes.indexOf(cell)]={id:cell.id,kind:'EMPTY'};
  if(id==='dropped-zero-child')proposal.nodes=proposal.nodes.filter(node=>node.id!==split.zero);
  if(id==='conflicting-overlap')split.positive=split.negative;
  if(id==='coverage-by-samples')(proposal as unknown as Record<string,unknown>).coverageSamples=[0,1];
  if(id==='narrowed-family')source.policies.pop();
  if(id==='wrong-tie-order')source.tieOrder.reverse();
  if(id==='missing-worst-world'){
    const p=proposal.nodes.filter(node=>node.kind==='CELL').flatMap(node=>node.kind==='CELL'?node.label.policies:[]).find(p=>p.worstWorldIds.length>1)!;
    p.worstWorldIds.pop();
  }
  if(id==='swapped-coefficient')source.worlds[0]!.paths[2]!.states[1]!.net!.a[0]='2/1';
  if(id==='swapped-policy-ref')source.policies[0]!.ref.contentDigest='a'.repeat(64);
  if(id==='swapped-checker-digest')proposal.checkerDigest='a'.repeat(64);
  if(id==='unsupported-farkas-proof')(cell.geometry as unknown as Record<string,unknown>).multipliers=[{sign:-1,constant:99}];
  if(id==='wrong-input-digest')proposal.inputDigest='a'.repeat(64);
  // Input mutations pass the outer digest binding and reach original reconstruction.
  if(['narrowed-family','wrong-tie-order','swapped-coefficient','swapped-policy-ref'].includes(id))proposal.inputDigest=atlasHash(source);
  const result=child(checker,{source,proposal}).data;
  mutations.push({id,status:result.status==='REJECTED'?'PASS':'FAIL',check:result});
  await save();
}
if(results.some((r:any)=>r.status==='FAIL')||mutations.some((r:any)=>r.status==='FAIL'))process.exitCode=1;
console.log(JSON.stringify({output,results:results.map((r:any)=>({id:r.id,status:r.status,observed:r.observed})),mutations:mutations.map((m:any)=>({id:m.id,status:m.status,predicate:m.check.predicate}))}));

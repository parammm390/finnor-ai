/** Actual native programme, document bytes, ordinary SQL role and route refusals. */
import {strict as assert} from 'node:assert';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {groundedMemoBytes} from '../../packages/artifacts/src/creation';
import {checkDraftBytes} from '../../packages/private-equity/src/program-synthesis/checker';
import {tx} from '../../packages/private-equity/src/evidence-execution/store';

export async function artifactAdversarialFixture(e:any){
 await e.test('accepted-contract-and-exact-artifact-adversaries',{},'actual route refuses hostile contracts; ordinary SQL cannot rewrite accepted programme; independent DOCX paragraphs reject decimal-prefix, currency, citation, omission and duplicate-row mutants',async()=>{
  const request=e.request(),p=await e.create(request),done=await e.complete(p);assert.equal(done.status,'TESTED');
  const sourceRef='evidence_derivation:'+done.program.semanticBindings[0].id;
  const binding={values:done.program.result.values,requiredSourceKeys:request.acceptance.requiredSourceKeys,sourceRef};
  const paragraphs=Object.entries(binding.values).map(([key,v]:[string,any])=>({text:key+': '+v.value+' '+v.semantics.unit+(v.semantics.currencyCode?' '+v.semantics.currencyCode:'')+'; DERIVED_VALUE; accepted required sources: '+binding.requiredSourceKeys.join(', '),sourceRefs:[sourceRef]}));
  const make=(rows:any[])=>groundedMemoBytes('Native independent byte challenge',[{heading:'Checked analytical values — draft',paragraphs:rows}]);
  const good=await checkDraftBytes(make(paragraphs),binding);assert.equal(good.status,'PASS');
  const mutants=[
   {id:'decimal-prefix',rows:paragraphs.map(x=>({...x,text:x.text.replace('netEquity: 43 currency','netEquity: 43.9 currency')}))},
   {id:'currency',rows:paragraphs.map(x=>({...x,text:x.text.replace('currency USD','currency EUR')}))},
   {id:'unbound-future-citation',rows:paragraphs.map(x=>({...x,sourceRefs:['evidence_derivation:'+randomUUID()]}))},
   {id:'missing-liability',rows:paragraphs.map(x=>({...x,text:x.text.replace(', liability','')}))},
   {id:'duplicate-conflicting-row',rows:[...paragraphs,{...paragraphs[0],text:paragraphs[0].text.replace('netEquity: 43 currency','netEquity: 50 currency')}]},
  ];
  const artifactChecks=[];for(const mutant of mutants){const bytes=make(mutant.rows);await writeFile(join(e.evidence,'artifact-mutant-'+mutant.id+'.docx'),bytes);artifactChecks.push({id:mutant.id,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),check:await checkDraftBytes(bytes,binding)});}
  await writeFile(join(e.evidence,'artifact-mutant-checks.json'),JSON.stringify({good,binding,artifactChecks},null,2));
  assert(artifactChecks.every(x=>x.check.status==='FAIL'),JSON.stringify(artifactChecks));
  const variants:Array<{id:string;change:(r:any)=>void}>=[];
  for(const [field,value] of Object.entries({currencyCode:'EUR',scale:'1000',frequency:'quarterly',periodEnd:'2025-06-30T00:00:00.000Z',consolidation:'FOREIGN_SCOPE',sign:'INVERTED'}))variants.push({id:'financial-'+field,change:r=>r.sources[1].source[field]=value});
  variants.push(
   {id:'duplicate-source',change:r=>r.sources.push(structuredClone(r.sources[0]))},
   {id:'unresolved-port',change:r=>r.acceptance.targets[0].expression={kind:'input',key:'foreign'}},
   {id:'duplicate-target',change:r=>r.acceptance.targets.push(structuredClone(r.acceptance.targets[0]))},
   {id:'caller-graph-cycle',change:r=>r.graph=[{id:'x',dependsOn:['x']}]},
   {id:'caller-oracle-grade',change:r=>r.oracle={grade:'PASS',sealed:true}},
   {id:'caller-credential',change:r=>r.credentials={token:'DISPOSABLE_HOSTILE_INPUT_NOT_A_CREDENTIAL'}},
   {id:'unsupported-hard-memory',change:r=>r.limits={requiredAggregateLimits:{memoryBytes:16*1024**3}}},
   {id:'unknown-operation',change:r=>r.operations=[{op:'eval',key:'host',code:'process.env'}]},
   {id:'exponent',change:r=>r.acceptance.targets[0].expression={kind:'literal',value:'1e99999',unit:'currency',currencyCode:'USD'}},
   {id:'byte-flood',change:r=>r.padding='x'.repeat(70000)},
   {id:'deep-recursion',change:r=>{let expression:any={kind:'input',key:'EV'};for(let i=0;i<60;i++)expression={kind:'add',left:expression,right:{kind:'input',key:'debt'}};r.acceptance.targets[0].expression=expression;}},
  );
  const refusals=[];for(const variant of variants){const body=structuredClone(request);body.idempotencyKey=randomUUID();variant.change(body);const response=await e.api('program-submit',body);assert([400,413,422].includes(response.status),JSON.stringify({id:variant.id,response}));assert(!response.body.program&&!response.body.bytesBase64);refusals.push({id:variant.id,response});}
  const weakened=structuredClone(request);weakened.acceptance.requiredSourceKeys=['EV','debt','EBITDA'];weakened.acceptance.targets[0].expression={kind:'subtract',left:{kind:'input',key:'EV'},right:{kind:'input',key:'debt'}};const conflict=await e.api('program-submit',weakened);assert.equal(conflict.status,422);
  let immutableRefusal:any;try{await tx(e.ctx,async c=>c.query("UPDATE finnor_os.p1_programs SET body=jsonb_set(body,'{acceptanceDigest}',to_jsonb('forged'::text)) WHERE request_id=$1",[p.programId]));}catch(error:any){immutableRefusal={code:error.code??error.cause?.code,message:String(error.message)};}assert(immutableRefusal,'Ordinary role rewrote immutable programme');
  const after=await e.api('program-read',{programId:p.programId});assert.equal(after.body.status,'TESTED');assert.equal(after.body.program.acceptanceDigest,done.program.acceptanceDigest);assert.equal(after.body.program.result.digest,done.program.result.digest);assert.equal(after.body.program.result.values.netEquity.value,'43');
  return {p,good,artifactChecks,refusals,conflict,immutableRefusal,unchangedAcceptanceDigest:done.program.acceptanceDigest,unchangedResultDigest:done.program.result.digest,authorityGranted:false,sealedOracleAvailable:false};
 });
}

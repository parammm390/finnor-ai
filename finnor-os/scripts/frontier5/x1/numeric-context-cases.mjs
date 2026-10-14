import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {independentlyCheckInstitutionModel} from '../../../packages/private-equity/src/institution-program/checker.ts';
const repo=fileURLToPath(new URL('../../../../',import.meta.url)),root=process.argv[2];
assert.ok(root?.startsWith('/'));await mkdir(root,{mode:0o700});
const load=async n=>JSON.parse(await readFile(new URL('./reference/'+n,import.meta.url),'utf8'));
const original=await load('original-input.json'),candidate=await load('base-candidate.json');
const profile=JSON.parse(await readFile(join(repo,'scope-frontier5/x1-institutional-programme-compiler/profile.json'),'utf8'));
const cases=[{id:'numeric-unit-is-not-text',field:'unit',value:1,expected:'QUANTITY'},
 {id:'numeric-currency-is-not-text',field:'currency',value:123,expected:'QUANTITY'},
 {id:'literal-supported-text-unit-control',field:'unit',value:'units',expected:'ACCEPTED'},
 {id:'literal-unsupported-text-unit-remains-unresolved',field:'unit',value:'1',expected:'COVERAGE'},
 {id:'native-financial-numeric-unit-is-not-text',field:'unit',value:1,native:true,expected:'QUANTITY'}];
const results=[];
for(const spec of cases){
 const o=structuredClone(original),c=structuredClone(candidate),rows=JSON.parse(o.sources[1].rawUtf8);
 for(const row of rows){row[spec.field]=spec.value;if(spec.native){row.amount=row.value;row.account=row.factKey;row.accountingBasis=row.basis;
  delete row.kind;delete row.value;delete row.factKey;delete row.basis;}}
 o.sources[1].rawUtf8=JSON.stringify(rows);for(const q of c.quantities)q[spec.field]=spec.value;
 const check=await independentlyCheckInstitutionModel(o,c,profile),observed=check.disposition==='REJECTED'?check.guard:'ACCEPTED';
 results.push({...spec,observed,passed:observed===spec.expected,original:o,candidate:c,check});
}
const result={status:results.every(r=>r.passed)?'PASS':'FAIL',results,runtime:process.version,
 claimDomain:'INDEPENDENT_ORIGINAL_BYTE_CHECKER_COMPONENT_ONLY',sourcePins:await Promise.all(['checker.ts','checker-raw.ts'].map(async n=>({path:n,
  sha256:createHash('sha256').update(await readFile(join(repo,'finnor-os/packages/private-equity/src/institution-program',n))).digest('hex')}))),actualBusinessCompletion:false};
await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:result.status,cases:results.map(({id,expected,observed,passed})=>({id,expected,observed,passed}))}));
assert.equal(result.status,'PASS','Numeric nominal context cannot silently become a text quantity context');

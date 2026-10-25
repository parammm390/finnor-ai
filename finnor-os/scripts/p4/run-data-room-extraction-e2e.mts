import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {dataRoomWorkbook} from './data-room-fixtures.mts';

const output=resolve(process.env.FINNOR_DATA_ROOM_EVIDENCE??'../.data-room-evidence');
await mkdir(output,{recursive:true});
const source={kind:'artifact',subject:{entityType:'external_organization',entityId:'2a0eb69a-c42a-4e58-a572-c523ca7683ed'},documentId:'5008bb22-d90a-4b4f-a8c9-ac75020d13a4',documentVersionId:'6b61c3d3-a111-41c4-bb83-e1b048e367fa',metricKey:'net_revenue',periodStart:'2025-01-01T00:00:00.000Z',periodEnd:'2025-12-31T00:00:00.000Z',unit:'currency',currencyCode:'USD',frequency:'annual',calendar:'GREGORIAN',consolidation:'CONSOLIDATED',instrument:'OPERATING',scale:'1000',sign:'AS_RECORDED'};
const results:Array<{id:string;status:string;observed?:unknown;error?:string}>=[];
const xlsx=(formula=false,revenue='1,234.50',numericRevenue=false)=>dataRoomWorkbook({formula,revenue,numericRevenue});
function pdf(){
 const lines=['Atlas Software','USD in thousands','2025-01-01 to 2025-12-31','Net revenue 1,234.50'];
 const content='BT /F1 12 Tf 50 750 Td '+lines.map((s,i)=>(i?'0 -20 Td ':'')+'('+s+') Tj').join('\n')+' ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`];
 let text='%PDF-1.4\n';const offsets=[0];for(const [i,o]of objects.entries()){offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${o}\nendobj\n`;}const start=Buffer.byteLength(text);text+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return Buffer.from(text);
}
const context=[{role:'entity',cell:'A1',text:'Atlas Software'},{role:'period',cell:'A3',text:'2025-01-01 to 2025-12-31'},{role:'currency',cell:'A2',text:'USD in thousands'},{role:'scale',cell:'A2',text:'USD in thousands'}];
const selection={kind:'financial_cells',numberFormat:'COMMA_GROUPED',context,values:[{cell:'B5',label:{cell:'A5',text:'Net revenue'}}]};
async function native(id:string,bytes:Buffer,layout:unknown){
 const file=join(output,id+(String((layout as {format:string}).format)==='pdf'?'.pdf':'.xlsx'));await writeFile(file,bytes);
 const input={mode:'document',payload:{source:{...source,layout},bytes:bytes.toString('base64'),version:source.documentVersionId,digest:createHash('sha256').update(bytes).digest('hex')}};
 await writeFile(join(output,id+'.input.json'),JSON.stringify(input,null,2));
 const run=spawnSync(process.execPath,['--import=tsx',resolve('packages/private-equity/src/evidence-execution/native-child.mts')],{input:JSON.stringify(input),encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024,env:{PATH:process.env.PATH,LANG:'en_US.UTF-8',NODE_ENV:'production'}});
 assert.equal(run.status,0,run.stderr);const result=JSON.parse(run.stdout);await writeFile(join(output,id+'.output.json'),JSON.stringify({pid:run.pid,result},null,2));return result;
}
async function scenario(id:string,fn:()=>Promise<unknown>){try{results.push({id,status:'PASS',observed:await fn()});}catch(e){results.push({id,status:'FAIL',error:String(e)});}}
await scenario('ordinary-xlsx',async()=>{const r=await native('ordinary-xlsx',xlsx(),{format:'xlsx',sheet:'Income statement',selection});assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.data.rows.map((x:any)=>x.value),['1234500']);assert.equal(r.data.witnesses[0].anchor.cell,'B5');assert.equal(r.data.witnesses[0].rawValue,'1,234.50');assert.equal(r.data.witnesses[0].interpretation.context.length,5);return r;});
await scenario('signed-accounting-value',async()=>{const r=await native('signed-accounting-value',xlsx(),{format:'xlsx',sheet:'Income statement',selection:{...selection,values:[{cell:'B6',label:{cell:'A6',text:'Operating costs'}}]}});assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.data.rows.map((x:any)=>x.value),['-70000']);assert.equal(r.data.witnesses[0].rawValue,'(70)');return r;});
await scenario('numeric-xlsx-storage-format',async()=>{const r=await native('numeric-xlsx-storage-format',xlsx(false,'1.234',true),{format:'xlsx',sheet:'Income statement',selection:{...selection,numberFormat:'DOT_GROUPED'}});assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.data.rows.map((x:any)=>x.value),['1234']);return r;});
await scenario('context-mismatch',async()=>{const r=await native('context-mismatch',xlsx(),{format:'xlsx',sheet:'Income statement',selection:{...selection,context:context.map(c=>c.role==='period'?{...c,text:'2024-01-01 to 2024-12-31'}:c)}});assert.equal(r.ok,false);assert.equal(r.predicate,'DOCUMENT_MAPPING_CONTEXT_MISMATCH');return r;});
await scenario('label-mismatch',async()=>{const r=await native('label-mismatch',xlsx(),{format:'xlsx',sheet:'Income statement',selection:{...selection,values:[{cell:'B5',label:{cell:'A5',text:'Adjusted EBITDA'}}]}});assert.equal(r.ok,false);assert.equal(r.predicate,'DOCUMENT_MAPPING_CONTEXT_MISMATCH');return r;});
await scenario('formula-cache',async()=>{const r=await native('formula-cache',xlsx(true),{format:'xlsx',sheet:'Income statement',selection});assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.data.rows.length,0);assert(r.data.reasons.includes('XLSX_MATERIAL_FORMULA_CACHE_UNVERIFIED'));return r;});
await scenario('ambiguous-number',async()=>{const r=await native('ambiguous-number',xlsx(false,'1,23'),{format:'xlsx',sheet:'Income statement',selection});assert.equal(r.ok,false);assert.equal(r.predicate,'DOCUMENT_NUMBER_FORMAT_MISMATCH');return r;});
await scenario('ordinary-pdf',async()=>{const r=await native('ordinary-pdf',pdf(),{format:'pdf',selection:{kind:'financial_text',numberFormat:'COMMA_GROUPED',context:context.map(({role,text})=>({role,page:1,quote:text})),values:[{page:1,quote:'Net revenue 1,234.50',valueText:'1,234.50',label:'Net revenue'}]}});assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(r.data.rows.map((x:any)=>x.value),['1234500']);assert.equal(r.data.witnesses[0].anchor.page,1);assert.equal(r.data.witnesses[0].anchor.quote,'Net revenue 1,234.50');return r;});
await writeFile(join(output,'results.json'),JSON.stringify({schema:'finnor.data-room-native-extraction-e2e.v1',command:'cd finnor-os && node --import=tsx scripts/p4/run-data-room-extraction-e2e.mts',boundary:'real immutable file bytes -> production fixed native child -> financial rows/witnesses; authorization and SQL independent replay require existing authenticated owner run',source,results},null,2));
process.stdout.write(JSON.stringify({output,results:results.map(({id,status,error})=>({id,status,error}))})+'\n');
process.exit(results.some(x=>x.status==='FAIL')?1:0);

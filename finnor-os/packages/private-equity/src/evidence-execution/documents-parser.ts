import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {OfficePackage,NS,children,descendants,textContent,sha256} from '@finnor/ooxml';
import {parseWorkbook} from '@finnor/spreadsheet-ir';
import {EvidenceSourceSchema,FinancialSemanticsSchema,type EvidenceSource,type FinancialRow,type EvidenceWitness,type FinancialDocumentSelection} from '@finnor/shared-types';
import {canonicalExact,exactScale} from './exact';
type Source=Extract<EvidenceSource,{kind:'artifact'}>;
export interface DocumentPayload {bytes:string;source:Source;digest:string;version:string}
export interface DocumentExtraction {rows:FinancialRow[];witnesses:EvidenceWitness[];reasons:string[];sourceCounts:Array<{id:string;expected:number;actual:number}>;nativeOperations:unknown[]}
const HEADERS=['entityId','metricKey','value','periodStart','periodEnd','currencyCode','frequency','unit','calendar','consolidation','instrument','scale','sign'] as const;
type Cell={value:string;formula:boolean;valueType:'numeric'|'text'|'unsupported'};
function workbookCells(bytes:Buffer,source:Source){
 if(bytes.length<4||bytes.readUInt32LE(0)!==0x04034b50)throw Error('XLSX_MAGIC_REQUIRED');
 const pkg=new OfficePackage(bytes),ir=parseWorkbook(pkg);
 const sheet=source.layout.sheet?ir.sheets.find(s=>s.name===source.layout.sheet):ir.sheets.length===1?ir.sheets[0]:undefined;
 if(!sheet)throw Error('REGISTERED_XLSX_SHEET_UNAVAILABLE');
 const part=pkg.relationships(pkg.mainPart).find(r=>r.type.endsWith('/sharedStrings'))?.resolved;
 const strings=part?children(pkg.xml(part),'si',NS.sheet).map(n=>descendants(n,'t',NS.sheet).map(textContent).join('')):[];
 const cells=new Map<string,Cell>();
 for(const c of descendants(pkg.xml(sheet.part),'c',NS.sheet)){
  const address=c.attrs.r;if(!address||cells.has(address))throw Error('XLSX_CELL_ADDRESS_UNAVAILABLE');
  let value=children(c,'v',NS.sheet)[0]?.text??'';
  if(c.attrs.t==='inlineStr')value=descendants(c,'t',NS.sheet).map(textContent).join('');
  else if(c.attrs.t==='s'){const i=Number(value);if(!Number.isInteger(i)||i<0||i>=strings.length)throw Error('XLSX_SHARED_STRING_UNAVAILABLE');value=strings[i]!;}
  const valueType=!c.attrs.t||c.attrs.t==='n'?'numeric':['inlineStr','s','str'].includes(c.attrs.t)?'text':'unsupported';
  cells.set(address,{value,formula:children(c,'f',NS.sheet).length>0,valueType});
 }
 return {sheet,cells};
}
function mappedNumber(raw:string,format:FinancialDocumentSelection['numberFormat']):string{
 let text=raw.trim();if(text.length>256)throw Error('DOCUMENT_NUMBER_FORMAT_MISMATCH');
 const negative=text.startsWith('(')&&text.endsWith(')');
 if(negative){text=text.slice(1,-1);if(/^[+-]/.test(text))throw Error('DOCUMENT_NUMBER_FORMAT_MISMATCH');}
 if(format==='COMMA_GROUPED'){
  if(!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text))throw Error('DOCUMENT_NUMBER_FORMAT_MISMATCH');
  text=text.replaceAll(',','');
 }else if(format==='DOT_GROUPED'){
  if(!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/.test(text))throw Error('DOCUMENT_NUMBER_FORMAT_MISMATCH');
  text=text.replaceAll('.','').replace(',','.');
 }
 try{return canonicalExact((negative?'-':'')+text);}catch{throw Error('DOCUMENT_NUMBER_FORMAT_MISMATCH');}
}
async function extractSelection(input:DocumentPayload,source:Source,bytes:Buffer,selection:FinancialDocumentSelection):Promise<DocumentExtraction>{
 if((source.layout.format==='xlsx')!==(selection.kind==='financial_cells')||source.layout.format==='image'||source.layout.columns)throw Error('DOCUMENT_MAPPING_FORMAT_MISMATCH');
 const roles=new Set(selection.context.map(c=>c.role));
 if(!roles.has('entity')||!roles.has('period')||(source.unit==='currency'&&!roles.has('currency'))||(source.scale!=='1'&&!roles.has('scale')))throw Error('DOCUMENT_MAPPING_SEMANTIC_CONTEXT_REQUIRED');
 const semantics=FinancialSemanticsSchema.parse({entityType:source.subject.entityType,entityId:source.subject.entityId,...Object.fromEntries(Object.entries(source).filter(([key])=>!['kind','subject','documentId','documentVersionId','metricKey','layout'].includes(key)))});
 if(semantics.periodStart>semantics.periodEnd)throw Error('DOCUMENT_PERIOD_INTERPRETATION_UNAVAILABLE');
 const context:NonNullable<EvidenceWitness['interpretation']>['context']=[];
 const selected:Array<{anchor:EvidenceWitness['anchor'];rawValue:string;formula:boolean;numberFormat:FinancialDocumentSelection['numberFormat'];storageEncoding:'OOXML_NUMERIC'|'TEXT';unsupported?:boolean}>=[];
 const reasons:string[]=[];
 if(selection.kind==='financial_cells'){
  const {sheet,cells}=workbookCells(bytes,source);
  const check=(cell:string,text:string,role:string)=>{
   const actual=cells.get(cell);if(!actual||actual.value!==text)throw Error('DOCUMENT_MAPPING_CONTEXT_MISMATCH');
   if(actual.formula)throw Error('XLSX_MAPPING_CONTEXT_FORMULA_UNVERIFIED');
   context.push({role,anchor:{sheet:sheet.name,cell},text:actual.value});
  };
  for(const c of selection.context)check(c.cell,c.text,c.role);
  const seen=new Set<string>();
  for(const value of selection.values){
   if(seen.has(value.cell))throw Error('DOCUMENT_MAPPING_DUPLICATE_ANCHOR');seen.add(value.cell);
   check(value.label.cell,value.label.text,'metric');
   const actual=cells.get(value.cell);if(!actual)throw Error('DOCUMENT_MAPPING_VALUE_UNAVAILABLE');
   // OOXML stores numbers in decimal notation independently of display locale.
   // The declared locale applies to text cells, never to numeric storage bytes.
   selected.push({anchor:{sheet:sheet.name,cell:value.cell},rawValue:actual.value,formula:actual.formula,numberFormat:actual.valueType==='numeric'?'PLAIN_DECIMAL':selection.numberFormat,storageEncoding:actual.valueType==='numeric'?'OOXML_NUMERIC':'TEXT',unsupported:actual.valueType==='unsupported'});
  }
 }else{
  if(bytes.subarray(0,5).toString()!=='%PDF-')throw Error('PDF_MAGIC_REQUIRED');
  const {interpret}=await import('@finnor/artifacts');const ir=await interpret(bytes,{timeoutMs:25000});
  if(ir.nodes.some(n=>n.data.status!=='TEXT_AVAILABLE'))reasons.push('PDF_OCR_REQUIRED_OR_PARTIAL_TEXT');
  const pages=new Map(ir.nodes.map(n=>[Number(n.data.page),String(n.data.text??'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean)]));
  const check=(page:number,quote:string)=>{const matches=pages.get(page)?.filter(line=>line===quote)??[];if(matches.length!==1)throw Error('DOCUMENT_MAPPING_CONTEXT_MISMATCH');};
  for(const c of selection.context){check(c.page,c.quote);context.push({role:c.role,anchor:{page:c.page,quote:c.quote},text:c.quote});}
  const seen=new Set<string>();
  for(const value of selection.values){
   const key=value.page+':'+value.quote;if(seen.has(key))throw Error('DOCUMENT_MAPPING_DUPLICATE_ANCHOR');seen.add(key);check(value.page,value.quote);
   if(!value.quote.startsWith(value.label)||value.quote.split(value.valueText).length!==2||value.quote.indexOf(value.valueText)<value.label.length)throw Error('DOCUMENT_MAPPING_VALUE_UNAVAILABLE');
   context.push({role:'metric',anchor:{page:value.page,quote:value.quote},text:value.label});
   selected.push({anchor:{page:value.page,quote:value.quote},rawValue:value.valueText,formula:false,numberFormat:selection.numberFormat,storageEncoding:'TEXT'});
  }
 }
 const rows:FinancialRow[]=[],witnesses:EvidenceWitness[]=[],mappingDigest=sha256(Buffer.from(JSON.stringify(selection)));
 for(const [ordinal,record]of selected.entries()){
  if(record.formula){reasons.push('XLSX_MATERIAL_FORMULA_CACHE_UNVERIFIED');continue;}
  if(record.unsupported){reasons.push('XLSX_MATERIAL_VALUE_TYPE_UNSUPPORTED');continue;}
  const value=exactScale(mappedNumber(record.rawValue,record.numberFormat),semantics.scale,semantics.sign),normalized={...semantics,scale:'1' as const,sign:'AS_RECORDED' as const};
  const id=source.layout.format+':'+input.version+':mapping:'+mappingDigest+':'+ordinal;
  witnesses.push({id,sourceKind:source.layout.format,owner:'S1_BOUND_DOCUMENT_VERSION',recordId:source.documentId,version:input.version,contentDigest:input.digest,field:'value',rawValue:record.rawValue,anchor:record.anchor,semantics,modulePath:['DocumentVersion:immutable-bytes',selection.kind==='financial_cells'?'SpreadsheetIR:raw-xml-value':'PDFParse:actual-page-text','P4:explicit-financial-mapping','P4:exact-scale-sign'],uncertainty:['SOURCE_ASSERTION_NOT_CANONICAL_TRUTH','FINANCIAL_SEMANTICS_MAPPING_ASSERTION','EXPLICIT_SELECTED_ANCHORS_NOT_DOCUMENT_WIDE_COVERAGE'],interpretation:{numberFormat:record.numberFormat,storageEncoding:record.storageEncoding,mappingDigest,scope:'EXPLICIT_SELECTED_ANCHORS',context}});
  rows.push({recordId:source.documentId+':mapping:'+mappingDigest+':'+ordinal,metricKey:source.metricKey,value,semantics:normalized,witnessIds:[id],fields:{...Object.fromEntries(Object.entries(normalized).map(([key,v])=>[key,v])),value,metricKey:source.metricKey}});
 }
 if(!rows.length)reasons.push('EXACT_REGISTERED_DOCUMENT_VALUE_UNAVAILABLE');
 return {rows,witnesses,reasons,nativeOperations:[],sourceCounts:[{id:'explicit-selected-document-anchors:'+mappingDigest,expected:selection.values.length,actual:rows.length}]};
}
export async function parseDocumentPayload(input:DocumentPayload):Promise<DocumentExtraction>{
 const source=EvidenceSourceSchema.parse(input.source);if(source.kind!=='artifact')throw Error('ARTIFACT_SOURCE_REQUIRED');const bytes=Buffer.from(input.bytes,'base64');if(bytes.length>6_000_000||sha256(bytes)!==input.digest)throw Error('DOCUMENT_BYTES_DIGEST_OR_BOUND_MISMATCH');
 if(source.layout.selection)return extractSelection(input,source,bytes,source.layout.selection);
 const rows:FinancialRow[]=[],witnesses:EvidenceWitness[]=[],reasons:string[]=[],nativeOperations:unknown[]=[];let allRecords=0;let records:Array<{values:Record<string,string>;anchor:EvidenceWitness['anchor'];formula:boolean;rawValue:string;ordinal:number}>=[];
 if(source.layout.format==='xlsx'){
  const {sheet,cells}=workbookCells(bytes,source);
  const columns=source.layout.columns;if(!columns)throw Error('REGISTERED_XLSX_COLUMN_LAYOUT_REQUIRED');for(const h of HEADERS){if(!/^[A-Z]{1,3}$/.test(columns[h]))throw Error('XLSX_COLUMN_ADDRESS_REQUIRED');const header=cells.get(columns[h]+source.layout.headerRow);if(header?.value!==h||header.formula)throw Error('XLSX_HEADER_SCHEMA_MISMATCH');}
  const numbers=[...new Set([...cells.keys()].map(a=>Number(a.replace(/^[A-Z]+/,''))).filter(n=>n>source.layout.headerRow))].sort((a,b)=>a-b);if(numbers.length>1000)throw Error('XLSX_SOURCE_ROW_BOUND');
  for(const ordinal of numbers){const values=Object.fromEntries(HEADERS.map(h=>[h,cells.get(columns[h]+ordinal)?.value??'']));if(HEADERS.every(h=>!values[h]))continue;allRecords++;const material=cells.get(columns.value+ordinal);records.push({values,anchor:{sheet:sheet.name,cell:columns.value+ordinal},formula:HEADERS.some(h=>cells.get(columns[h]+ordinal)?.formula),rawValue:material?.value??'',ordinal});}
 }else if(source.layout.format==='pdf'){
  if(bytes.subarray(0,5).toString()!=='%PDF-')throw Error('PDF_MAGIC_REQUIRED');const {interpret}=await import('@finnor/artifacts');const ir=await interpret(bytes,{timeoutMs:25000});if(ir.nodes.some(n=>n.data.status!=='TEXT_AVAILABLE'))reasons.push('PDF_OCR_REQUIRED_OR_PARTIAL_TEXT');let headerSeen=false;
  for(const page of ir.nodes){const pageNum=Number(page.data.page),text=String(page.data.text??'');for(const quote of text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)){if(quote===HEADERS.join('|')){headerSeen=true;continue;}if(/^--\s*\d+\s+of\s+\d+\s*--$/.test(quote))continue;if(!headerSeen||quote.split('|').length!==HEADERS.length){reasons.push('PDF_UNPARSED_MATERIAL_TEXT');continue;}const values=Object.fromEntries(HEADERS.map((h,i)=>[h,quote.split('|')[i]!.trim()]));allRecords++;records.push({values,anchor:{page:pageNum,quote},formula:false,rawValue:values.value!,ordinal:allRecords});}}
  if(!headerSeen)throw Error('PDF_REGISTERED_TABLE_HEADER_UNAVAILABLE');
 }else{
  const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes[0]===255&&bytes[1]===216;if(!png&&!jpeg)throw Error('SUPPORTED_IMAGE_MAGIC_REQUIRED');
  const executable=process.env.FINNOR_P4_OCR_BINARY,expected=process.env.FINNOR_P4_OCR_SHA256;if(!executable||!expected)throw Error('ACTUAL_IMAGE_OCR_RUNTIME_UNAVAILABLE');if(createHash('sha256').update(readFileSync(executable)).digest('hex')!==expected)throw Error('OCR_EXECUTABLE_DIGEST_MISMATCH');
  const result=spawnSync(executable,[],{input:bytes,timeout:20000,maxBuffer:1048576,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8',NODE_ENV:'production'}});if(result.status!==0)throw Error('ACTUAL_IMAGE_OCR_FAILED');const parsed=JSON.parse(result.stdout.toString());nativeOperations.push({route:'APPLE_VISION_FIXED_NATIVE_OCR',binaryDigest:expected,usage:parsed.usage??null,costUSD:null,status:'LOCAL_COST_UNMETERED'});const lines=parsed.lines as Array<{text:string;confidence:number;region:number[]}>;if(!Array.isArray(lines)||lines.length>1000)throw Error('OCR_LINE_BOUND');
  let headerSeen=false;for(const line of lines.sort((a,b)=>a.region[1]!-b.region[1]!)){const quote=line.text.trim();if(quote.split('|').map(h=>h.trim().toLowerCase()).join('|')===HEADERS.map(h=>h.toLowerCase()).join('|')){headerSeen=true;continue;}if(!headerSeen||quote.split('|').length!==HEADERS.length){reasons.push('OCR_UNPARSED_MATERIAL_REGION');continue;}const values=Object.fromEntries(HEADERS.map((h,i)=>[h,quote.split('|')[i]!.trim()]));allRecords++;records.push({values,anchor:{page:1,quote,region:line.region},formula:false,rawValue:values.value!,ordinal:allRecords});if(line.confidence<0.95)reasons.push('OCR_LOW_CONFIDENCE_NOT_CALIBRATED');}
  if(!headerSeen)throw Error('OCR_REGISTERED_TABLE_HEADER_UNAVAILABLE');
 }
 for(const record of records){const v=record.values;if(HEADERS.some(h=>!v[h])){reasons.push('INCOMPLETE_TABULAR_ROW');continue;}if(record.formula){reasons.push('XLSX_MATERIAL_FORMULA_CACHE_UNVERIFIED');continue;}
  const explicitDate=(raw:string)=>/^\d{4}-\d{2}-\d{2}$/.test(raw)?raw+'T00:00:00.000Z':raw;
  const startText=FinancialSemanticsSchema.shape.periodStart.safeParse(explicitDate(v.periodStart!)),endText=FinancialSemanticsSchema.shape.periodEnd.safeParse(explicitDate(v.periodEnd!));
  if(!startText.success||!endText.success){reasons.push('DOCUMENT_PERIOD_INTERPRETATION_UNAVAILABLE');continue;}
  const start=new Date(startText.data),end=new Date(endText.data);if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime())||start.getTime()>end.getTime()){reasons.push('DOCUMENT_PERIOD_INTERPRETATION_UNAVAILABLE');continue;}
  const parsed=FinancialSemanticsSchema.safeParse({entityType:source.subject.entityType,entityId:v.entityId,periodStart:start.toISOString(),periodEnd:end.toISOString(),unit:v.unit,currencyCode:v.currencyCode==='NONE'?null:v.currencyCode,frequency:v.frequency,calendar:v.calendar,consolidation:v.consolidation,instrument:v.instrument,scale:v.scale,sign:v.sign});if(!parsed.success){reasons.push('DOCUMENT_FINANCIAL_SEMANTICS_OR_IDENTITY_INTERPRETATION_UNAVAILABLE');continue;}const semantics=parsed.data;
  if(semantics.entityId!==source.subject.entityId||v.metricKey!==source.metricKey||semantics.periodStart!==source.periodStart||semantics.periodEnd!==source.periodEnd)continue;
  if(semantics.unit!==source.unit||semantics.currencyCode!==source.currencyCode||semantics.frequency!==source.frequency||semantics.calendar!==source.calendar||semantics.consolidation!==source.consolidation||semantics.instrument!==source.instrument||semantics.scale!==source.scale||semantics.sign!==source.sign){reasons.push('DOCUMENT_FINANCIAL_SEMANTICS_MISMATCH');continue;}
  const value=exactScale(canonicalExact(v.value!),semantics.scale,semantics.sign),normalized={...semantics,scale:'1' as const,sign:'AS_RECORDED' as const};const id=source.layout.format+':'+input.version+':'+record.ordinal+':value';
  const witness:EvidenceWitness={id,sourceKind:source.layout.format,owner:'S1_BOUND_DOCUMENT_VERSION',recordId:source.documentId,version:input.version,contentDigest:input.digest,field:'value',rawValue:record.rawValue,anchor:record.anchor,semantics,modulePath:['DocumentVersion:immutable-bytes',source.layout.format==='xlsx'?'SpreadsheetIR:raw-xml-value':source.layout.format==='pdf'?'PDFParse:actual-page-text':'AppleVision:actual-image-regions',...(source.layout.format==='image'?['AppleVision:binary:'+process.env.FINNOR_P4_OCR_SHA256]:[]),'P4:registered-table-layout','P4:exact-scale-sign'],uncertainty:['SOURCE_ASSERTION_NOT_CANONICAL_TRUTH',...(source.layout.format==='image'?['OCR_CONFIDENCE_NOT_CALIBRATED']:[])]};
  witnesses.push(witness);rows.push({recordId:source.documentId+':'+record.ordinal,metricKey:v.metricKey!,value,semantics:normalized,witnessIds:[id],fields:{...v,value,entityType:normalized.entityType,scale:'1',sign:'AS_RECORDED'}});
 }
 if(!rows.length)reasons.push('EXACT_REGISTERED_DOCUMENT_VALUE_UNAVAILABLE');return {rows,witnesses,nativeOperations,reasons:[...new Set(reasons)],sourceCounts:[{id:'parsed-tabular-records',expected:allRecords,actual:records.length}]};
}

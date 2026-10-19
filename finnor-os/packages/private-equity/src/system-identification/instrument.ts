/** S2 measurement path. It does not import the checker, generator or fixture.
 * Literal known controls calibrate the same permitted HTTP surface as unknowns. */
import type {DigitalHttpReceipt,DigitalControlReceipt,DigitalInstrumentCertificate} from '@finnor/shared-types';
type Binding={targetId:string;instanceId:string;applicationVersion:string;role:'analyst'|'auditor';principalId:string};
function invalid(code:string):never{throw Error('X4_INSTRUMENT_'+code);}
function record(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))invalid('OBJECT');return v as Record<string,unknown>;}
const pause=(ms:number)=>new Promise<void>(yes=>setTimeout(yes,ms));
/** Keep receipts even on a failed walk; no local normalization can erase them. */
export async function measureDigitalPages(read:(cursor:string|null)=>Promise<DigitalHttpReceipt>,b:Omit<Binding,'targetId'|'principalId'>,deadline:number,
 receipts:DigitalHttpReceipt[],experimentId?:string,completedAt?:string){
 let cursor:string|null=null,last:Record<string,unknown>|null=null;const seen=new Set<string>(),ids=new Set<string>(),rows:Array<{id:string;value:string}>=[];
 for(let step=0;step<64&&Date.now()<deadline;step++){
  const receipt=await read(cursor);receipts.push(receipt);
  if(receipt.status!==200||receipt.cursor!==cursor)invalid('HTTP_OR_CURSOR');
  const page=record(receipt.body);
  if(page.instanceId!==b.instanceId||page.applicationVersion!==b.applicationVersion||page.role!==b.role||page.units!=='count')invalid('STALE_IDENTITY_ROLE_UNIT');
  if(typeof page.experimentId!=='string'||experimentId&&page.experimentId!==experimentId)invalid('EXPERIMENT_IDENTITY');
  if(!Number.isFinite(Date.parse(String(page.observedAt)))||Date.parse(String(page.observedAt))>Date.parse(receipt.receivedAt)+1000)invalid('CLOCK');
  if(!Array.isArray(page.records)||page.records.length>16)invalid('RECORD_BOUND');
  if(page.available===false){
   if(page.records.length||cursor!==null||page.nextCursor!==null)invalid('PENDING_NOT_EMPTY');
   await pause(70);continue;
  }
  if(page.available!==true||typeof page.completedAt!=='string'||completedAt&&page.completedAt!==completedAt||
   !Number.isFinite(Date.parse(page.completedAt))||Date.parse(page.completedAt)>Date.parse(String(page.observedAt)))invalid('UNAVAILABLE_OR_STALE_CLOCK');
  for(const v of page.records){
   const r=record(v);
   if(typeof r.id!=='string'||ids.has(r.id))invalid('DUPLICATE_ID');
   if(typeof r.value!=='string'||!/^(0|-?[1-9][0-9]{0,15})$/.test(r.value)||BigInt(r.value)>9007199254740991n||BigInt(r.value)< -9007199254740991n)invalid('INTEGER');
   ids.add(r.id);rows.push({id:r.id,value:r.value});
  }
  last=page;
  if(page.nextCursor===null)return {records:rows,last};
  if(typeof page.nextCursor!=='string'||!page.nextCursor||page.nextCursor.length>256||seen.has(page.nextCursor))invalid('REPEATED_CURSOR');
  seen.add(page.nextCursor);cursor=page.nextCursor;
 }
 return invalid('UNRESOLVED_OR_DEADLINE');
}
const controlledRows=(prefix:string,values:string[])=>values.map((value,i)=>({id:prefix+String(i+1).padStart(12,'0'),value}));
export async function calibrateDigitalInstrument(b:Binding,id:string,instrumentDigest:string,deadline:number,read:(controlId:string,cursor:string|null)=>Promise<DigitalHttpReceipt>){
 const registeredAt=new Date().toISOString(),controls:DigitalControlReceipt[]=[],errors:string[]=[];
 const known=[
  {id:'empty',rows:[]},
  {id:'pagination',rows:controlledRows('10000000-0000-4000-8000-',['-4','0','7','23','101'])},
  {id:'timing',rows:controlledRows('20000000-0000-4000-8000-',['11'])},
  {id:'role-'+b.role,rows:controlledRows('30000000-0000-4000-8000-',b.role==='analyst'?['13']:['13','17'])},
  {id:'integer-units',rows:controlledRows('40000000-0000-4000-8000-',['-9007199254740991','0','9007199254740991'])},
  {id:'delayed',rows:controlledRows('70000000-0000-4000-8000-',['31'])},
  {id:'duplicates',rows:controlledRows('50000000-0000-4000-8000-',['19']),negative:true},
  {id:'stale',rows:controlledRows('60000000-0000-4000-8000-',['29']),negative:true},
  {id:'repeated-cursor',rows:controlledRows('80000000-0000-4000-8000-',['2','3','5','7','11']),negative:true},
  {id:'skipped-cursor',rows:controlledRows('90000000-0000-4000-8000-',['2','3','5','7','11']),negative:true},
 ];
 for(const k of known){
  const requests:DigitalHttpReceipt[]=[];let error:string|null=null,valid=false;
  try{
   const answer=await measureDigitalPages(cursor=>read(k.id,cursor),b,deadline,requests);
   valid=JSON.stringify(answer.records)===JSON.stringify(k.rows);
   if(k.id==='pagination'&&requests.length!==3)valid=false;
   if(k.id==='delayed'&&!requests.some(r=>record(r.body).available===false))valid=false;
   if(k.id==='timing'){
    const time=record(answer.last.timing);
    valid=valid&&time.requestedAt==='2026-01-01T00:00:00.000Z'&&time.startedAt==='2026-01-01T00:00:00.120Z'&&time.completedAt==='2026-01-01T00:00:00.240Z'&&Array.isArray(time.events)&&time.events.length===3;
   }
  }catch(e){error=e instanceof Error&&/^X4_INSTRUMENT_[A-Z_]+$/.test(e.message)?e.message:'X4_INSTRUMENT_CONTROL_UNAVAILABLE';}
  if(k.negative?valid||!requests.length||requests.some(r=>r.status!==200):!valid)errors.push('X4_INSTRUMENT_CONTROL_'+k.id.toUpperCase().replaceAll('-','_'));
  controls.push({controlId:k.id,requests,error});
 }
 const missing=await read('missing',null);controls.push({controlId:'missing',requests:[missing],error:null});
 if(missing.status!==404)errors.push('X4_INSTRUMENT_MISSING_NOT_EMPTY');
 const certificate:DigitalInstrumentCertificate={schema:'finnor.s2.digital-instrument-certificate.v1',id,...b,registeredAt,completedAt:new Date().toISOString(),
  validUntil:new Date(deadline).toISOString(),instrumentDigest,controls,disposition:errors.length?'INVALID':'VALIDATED_DEVELOPMENT',limitations:['FINITE_KNOWN_CONTROLS_NOT_UNIVERSAL_MEASUREMENT_PROOF']};
 return {certificate,errors};
}

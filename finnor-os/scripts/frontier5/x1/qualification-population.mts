/** Custodian-side source population generation. No compiler/checker/inference,
 * fixture corpus, candidate output or signing-key imports. */
import {readFile,mkdir,writeFile,realpath,stat} from 'node:fs/promises';
import {createHash,createHmac} from 'node:crypto';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {writeZip} from '@finnor/ooxml';
import {QualificationExecutionEvent,QualificationExecutionJournal} from './qualification-runtime.mts';
import {OracleLedger} from '../../../packages/private-equity/src/institution-qualification/contracts';
import {ExpectedEnvironment} from '../../../packages/private-equity/src/institution-qualification/scoring';
import {mappingMeaning,mappingIdentity,dutyIdentity,obligationMeaning,nativeCreationMeaning} from './qualification-meaning.mts';

const hex=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid(),instant=z.string().datetime({offset:true});
const pin=z.object({path:z.string().startsWith('/'),sha256:hex}).strict();
const rules=z.object({id:z.string().min(1),triggerKind:z.string().min(1),
  operation:z.enum(['create_deal_request','open_workstream','record_finding']),principalId:uuid,deadlineAt:instant,
  materiality:z.literal('material'),postconditionRef:z.string().min(1),observerRef:z.string().min(1),
  targetRegistrationIds:z.array(z.string().min(1)).min(1).max(1000),
  fixedBusinessWeight:z.number().positive().finite(),critical:z.boolean(),
  postconditionFields:z.record(z.union([z.string(),z.number().finite(),z.boolean(),z.null()])).refine(
    fields=>Object.keys(fields).length>0,'INDEPENDENT_NATIVE_POSTCONDITION_FIELDS_REQUIRED'),
  triggerFields:z.record(z.union([z.string(),z.number().int(),z.boolean()])).superRefine((fields,ctx)=>{
    const reserved=new Set(['id','kind','registrationId','triggerKind','occurredAt','availableAt','request',
      '__proto__','constructor','prototype']);
    if(Object.keys(fields).some(key=>reserved.has(key)))ctx.addIssue({code:'custom',message:'ORIGINAL_GENERATED_IDENTITY_AND_CHRONOLOGY_ARE_RESERVED'});
  })}).strict();
const nativeAsset=z.object({kind:z.enum(['fund','vehicle','deal','counterparty','person','document','metric','facility',
  'relationship','investment_case','work','request','finding','decision']),registrationId:z.string().min(1).max(160),
  canonicalRef:z.string().min(1),ownerSnapshotDigest:hex}).strict();
export const PopulationGeneratorControl=z.object({schema:z.literal('finnor.x1.independent-population-generator-control.v1'),
  protocolId:z.string().min(1),seedEnvironmentVariable:z.string().regex(/^FINNOR_X1_QUAL_SEED_[A-Z0-9_]+$/),
  generationInstant:instant,
  candidateCutDigest:hex,allocationConventionDigest:hex,
  seedCommitment:hex,previouslyExposedSeedCommitments:z.array(hex).max(10000),profile:pin,lockedSpecification:pin,
  ownerInputs:z.array(z.object({environmentId:z.string().min(1),institutionId:z.string().min(1),tenantId:uuid,
    principalId:uuid,workId:uuid,originalEpisodeId:uuid,originalGrantDigest:hex,originalDeadline:instant,
    existingOwnerSnapshotDigest:hex,custodyReceiptDigest:hex,nativeAssets:z.array(nativeAsset).min(2).max(1000),
    mandateRules:z.array(rules).min(1).max(3),sourceGrants:z.array(z.object({id:uuid,sourceId:z.string().min(1),sourceClass:z.string().min(1),
      rightsRevision:z.string().min(1),expiresAt:instant,ownerReceiptDigest:hex}).strict()).min(8).max(16),
    publicOwnerHandles:pin,permissionEventRequests:pin,ownerEventBindings:pin,soakExpectedEnvironment:pin,
    originalEpisodeCatalog:z.array(z.object({workId:uuid,originalEpisodeId:uuid,originalGrantDigest:hex,originalDeadline:instant,
      businessAssignmentRegistrationId:z.string().min(1),ownerReceiptDigest:hex}).strict()).min(1).max(3840)}).strict()).length(10),
}).strict();
export const InitialPopulationControl=PopulationGeneratorControl.extend({
  schema:z.literal('finnor.x1.independent-initial-population-control.v1'),
  ownerInputs:z.array(PopulationGeneratorControl.shape.ownerInputs.element.omit({
    permissionEventRequests:true,ownerEventBindings:true,soakExpectedEnvironment:true,originalEpisodeCatalog:true})).length(10),
});
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const canonical=(value:unknown):string=>{
  if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0)
    .map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  if(value===undefined)throw Error('GENERATOR_UNDEFINED_SEMANTIC_VALUE');return JSON.stringify(value);
};
const hash=(value:unknown)=>sha(canonical(value));
const xml=(s:string)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&apos;');
type Row=Record<string,string>;
function expectedDuty(record:Row,sourceId:string,rule:z.infer<typeof rules>,targetCanonicalRef:string,environmentId:string){
  const boundFields=Object.fromEntries(Object.entries(rule.postconditionFields).map(([key,value])=>[key,
    typeof value==='string'&&value.startsWith('GENERATED_FIELD:')?record[value.slice('GENERATED_FIELD:'.length)]
      ??(()=>{throw Error('INDEPENDENT_POSTCONDITION_FIELD_ABSENT');})():value]));
  const completionFields=nativeCreationMeaning(rule.operation,{dealId:targetCanonicalRef.split(':')[1]?.split('@')[0],
    owner:{partyType:'employee',partyId:rule.principalId},workstreamId:boundFields.workstream_id,
    requestedFromDealPartyId:boundFields.requested_from_deal_party_id,requestText:record.requestText,
    requestedAt:record.occurredAt,dueAt:rule.deadlineAt,requiresAcceptedDeliverable:record.requiresAcceptedDeliverable==='true',
    kind:record.workstreamKind,name:record.workstreamName,statement:record.findingStatement,severity:record.findingSeverity,
    materiality:rule.materiality,requiredForWorkstreamCompletion:record.requiredForWorkstreamCompletion==='true'});
  const meaning=obligationMeaning({sourceId,recordId:record.id!,ruleId:rule.id,canonicalRef:targetCanonicalRef,
    operation:rule.operation,principalId:rule.principalId,deadlineAt:rule.deadlineAt,businessFields:completionFields});
  return {identity:dutyIdentity(sourceId,record.id!,rule.id),sourceId,recordId:record.id!,ruleId:rule.id,
    semanticDigest:hash(meaning),meaning,postconditionDigest:hash(completionFields),completionFields,
    deadlineAt:rule.deadlineAt,critical:rule.critical,businessAssignmentId:environmentId+'/'+record.id+'/'+rule.id,
    fixedBusinessWeight:rule.fixedBusinessWeight,targetCanonicalRef,operation:rule.operation,originalRecord:structuredClone(record),
    postconditionRef:rule.postconditionRef,observerRef:rule.observerRef};
}
function seeded(seed:Buffer,label:string){
  let counter=0;
  const bytes=()=>createHmac('sha256',seed).update(label+'\0'+String(counter++)).digest();
  const integer=(limit:number)=>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>1000000)throw Error('GENERATOR_INTEGER_BOUND');
    const ceiling=Math.floor(0x100000000/limit)*limit;
    for(;;){const n=bytes().readUInt32BE(0);if(n<ceiling)return n%limit;}
  };
  const identifier=()=>{const b=bytes().subarray(0,16);b[6]=(b[6]!&15)|64;b[8]=(b[8]!&63)|128;
    const s=b.toString('hex');return [s.slice(0,8),s.slice(8,12),s.slice(12,16),s.slice(16,20),s.slice(20)].join('-');};
  const shuffle=<T,>(values:T[])=>{const result=[...values];for(let i=result.length-1;i>0;i--){
    const j=integer(i+1);[result[i],result[j]]=[result[j]!,result[i]!];}return result;};
  return {integer,identifier,shuffle};
}
function dated(value:number,offsetMinutes:number){
  if(offsetMinutes===0)return new Date(value).toISOString();
  const sign=offsetMinutes<0?'-':'+',absolute=Math.abs(offsetMinutes);
  return new Date(value+offsetMinutes*60000).toISOString().replace('Z',sign+
    String(Math.floor(absolute/60)).padStart(2,'0')+':'+String(absolute%60).padStart(2,'0'));
}
const calendarDate=(value:string)=>new Date(value).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
function encode(protocol:string,rows:Row[],columns:string[]):Buffer{
  if(protocol==='json_records')return Buffer.from(JSON.stringify(rows));
  if(protocol==='paginated_json'){
    const split=Math.max(1,Math.floor(rows.length/2));
    return Buffer.from(JSON.stringify({pages:[{cursor:'start',nextCursor:rows.length>split?'continuation':null,records:rows.slice(0,split)},
      ...(rows.length>split?[{cursor:'continuation',nextCursor:null,records:rows.slice(split)}]:[])]}));
  }
  if(protocol==='csv'||protocol==='tsv'){
    const separator=protocol==='csv'?',':'\t',cell=(v:string)=>'"'+v.replace(/"/g,'""')+'"';
    return Buffer.from([columns,...rows.map(r=>columns.map(c=>r[c]??''))].map(r=>r.map(cell).join(separator)).join('\r\n')+'\r\n');
  }
  if(protocol==='financial_xml')return Buffer.from('<records>'+rows.map(r=>'<'+(r.kind??'entity')+' '+
    Object.entries(r).map(([k,v])=>k+'="'+xml(v)+'"').join(' ')+'/>').join('')+'</records>');
  if(protocol==='html')return Buffer.from('<!doctype html><html><body><table><tr>'+columns.map(c=>'<th>'+xml(c)+'</th>').join('')+
    '</tr>'+rows.map(r=>'<tr>'+columns.map(c=>'<td>'+xml(r[c]??'')+'</td>').join('')+'</tr>').join('')+'</table></body></html>');
  if(protocol==='text')return Buffer.from(rows.map(r=>Object.entries(r).map(([k,v])=>
    (k==='id'?'Record ID':k)+': '+v).join('\n')).join('\n\n')+'\n');
  if(protocol==='rfc822'){
    if(rows.length!==1)throw Error('ONE_RFC822_MESSAGE_PER_GENERATED_OBJECT_REQUIRED');const r=rows[0]!;
    return Buffer.from('Message-ID: <'+r.id+'@qualification.test.invalid>\r\nFrom: custodian@test.invalid\r\nTo: firm@test.invalid\r\n'+
      'Date: '+new Date(r.occurredAt!).toUTCString()+'\r\nSubject: Evidence and requested exception\r\n'+
      'X-Institution-Entity-Type: '+r.entityType+'\r\nX-Institution-Registration-ID: '+r.registrationId+
      '\r\nX-Institution-Available-At: '+r.availableAt+'\r\n\r\n'+
      (r.body??'An exception is requested. This message supplies no approval, permission or current authority.')+'\r\n');
  }
  if(protocol==='icalendar')return Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'+rows.map(r=>
    'BEGIN:VEVENT\r\nUID:'+r.id+'\r\nDTSTART:'+calendarDate(r.occurredAt!)+'\r\nDTEND:'+
    calendarDate(new Date(Date.parse(r.occurredAt!)+30000).toISOString())+
    '\r\nSUMMARY:Original responsibility evidence\r\nX-INSTITUTION-ENTITY-TYPE:'+r.entityType+
    '\r\nX-INSTITUTION-REGISTRATION-ID:'+r.registrationId+'\r\nX-INSTITUTION-AVAILABLE-AT:'+r.availableAt+
    '\r\nEND:VEVENT\r\n').join('')+'END:VCALENDAR\r\n');
  if(protocol==='xlsx'){
    const addresses=(n:number)=>{let s='';for(let x=n+1;x>0;x=Math.floor((x-1)/26))s=String.fromCharCode(65+(x-1)%26)+s;return s;};
    const values=[columns,...rows.map(r=>columns.map(c=>r[c]??''))];
    const parts={
      '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
      '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      'xl/workbook.xml':'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Originals" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+values.map((r,i)=>
        '<row r="'+(i+1)+'">'+r.map((v,c)=>'<c r="'+addresses(c)+(i+1)+'" t="inlineStr"><is><t>'+xml(v)+'</t></is></c>').join('')+'</row>').join('')+'</sheetData></worksheet>',
    };return writeZip(new Map(Object.entries(parts).map(([k,v])=>[k,Buffer.from(v)])));
  }throw Error('UNSUPPORTED_GENERATOR_PROTOCOL:'+protocol);
}
async function pinnedJson(value:z.infer<typeof pin>){
  if((await stat(value.path)).size>64*1024*1024)throw Error('GENERATOR_PIN_INPUT_BOUND');
  const bytes=await readFile(value.path);if(sha(bytes)!==value.sha256)throw Error('INDEPENDENT_GENERATOR_PREIMAGE_CHANGED');
  return JSON.parse(bytes.toString('utf8'));
}

async function generatePopulation(value:unknown,paths:{publicRoot:string;withheldRoot:string},initialOnly:boolean){
  const parsed=initialOnly?InitialPopulationControl.parse(value):PopulationGeneratorControl.parse(value);
  const control={...parsed,ownerInputs:parsed.ownerInputs.map(owner=>({...owner,
    permissionEventRequests:'permissionEventRequests' in owner?owner.permissionEventRequests:undefined,
    ownerEventBindings:'ownerEventBindings' in owner?owner.ownerEventBindings:undefined,
    soakExpectedEnvironment:'soakExpectedEnvironment' in owner?owner.soakExpectedEnvironment:undefined,
    originalEpisodeCatalog:'originalEpisodeCatalog' in owner?owner.originalEpisodeCatalog:undefined}))};
  const seedText=process.env[control.seedEnvironmentVariable];
  if(!seedText||!/^[a-f0-9]{64}$/.test(seedText))throw Error('EXISTING_CUSTODIAN_256_BIT_SEED_BINDING_REQUIRED');
  const seed=Buffer.from(seedText,'hex');
  if(sha(seed)!==control.seedCommitment||control.previouslyExposedSeedCommitments.includes(control.seedCommitment))
    throw Error('INDEPENDENT_UNEXPOSED_SEED_COMMITMENT_REQUIRED');
  const publicRoot=resolve(paths.publicRoot),withheldRoot=resolve(paths.withheldRoot);
  if(publicRoot===withheldRoot||publicRoot.startsWith(withheldRoot+'/')||withheldRoot.startsWith(publicRoot+'/'))
    throw Error('SEPARATE_CUSTODIAN_AND_CANDIDATE_DIRECTORIES_REQUIRED');
  await realpath(dirname(publicRoot));await realpath(dirname(withheldRoot));
  await mkdir(publicRoot,{mode:0o700});await mkdir(withheldRoot,{mode:0o700});
  const profile=await pinnedJson(control.profile),lockedBytes=await readFile(control.lockedSpecification.path);
  if(sha(lockedBytes)!==control.lockedSpecification.sha256)throw Error('ORIGINAL_LOCKED_SPECIFICATION_CHANGED');
  const locked=lockedBytes.toString('utf8'),start=locked.indexOf('**Frozen frontier design.**'),end=locked.indexOf('**Fixed floors.**',start);
  if(start<0||end<=start||!locked.includes('≥1,000 concurrent missions')||!locked.includes('T=36 months'))
    throw Error('FULL_ORIGINAL_GENERATOR_REACH_AND_HORIZON_SOURCE_REQUIRED');
  const coordinates={sourceSha256:control.lockedSpecification.sha256,originalGenerationText:locked.slice(start,end),
    originalReachText:locked.split('\n').find(line=>line.startsWith('**Absolute FINNOR reach gate.**')),
    originalHorizonText:locked.split('\n').find(line=>line.startsWith('**Horizon and attribution.**')),
    originalFloorsText:locked.split('\n').find(line=>line.startsWith('**Fixed floors.**')),
    originalEnvelopeText:locked.split('\n').find(line=>line.startsWith('Keep the frozen controller resource envelope:')),
    specificationIsNotQualifiedBenchmark:true};
  if(Object.values(coordinates).some(v=>v===undefined))throw Error('ORIGINAL_LOCKED_COORDINATE_TEXT_MISSING');
  const began=performance.now();let outputBytes=0;
  const writeBytes=async(root:string,name:string,bytes:Buffer)=>{
    if(performance.now()-began>180000)throw Error('ORIGINAL_GENERATOR_FINITE_WALL_BOUND');
    if(outputBytes+bytes.length>64*1024*1024)throw Error('ORIGINAL_GENERATOR_AGGREGATE_OUTPUT_BOUND');
    outputBytes+=bytes.length;await writeFile(join(root,name),bytes,{flag:'wx',mode:0o600});
    return {name,sha256:sha(bytes),bytes:bytes.length};
  };
  const write=(root:string,name:string,body:unknown)=>writeBytes(root,name,Buffer.from(JSON.stringify(body,null,2)+'\n'));
  const frozenAt=control.generationInstant,manifest:any[]=[],executionEnvironments:any[]=[];
  if(Date.parse(frozenAt)>Date.now())throw Error('INDEPENDENT_GENERATION_CUTOFF_CANNOT_BE_IN_THE_FUTURE');
  const classes=['crm_deals','financial_ledger','document_dms','email','calendar','work_tracking','approval_records','lender_portal'];
  const allStructures=new Set<string>();
  for(const [ordinal,owner]of control.ownerInputs.entries()){
    if(control.ownerInputs.filter(e=>e.environmentId===owner.environmentId).length!==1
      ||new Set(owner.nativeAssets.map(a=>a.canonicalRef)).size!==owner.nativeAssets.length)
      throw Error('ORIGINAL_ENVIRONMENT_OR_NATIVE_IDENTITY_DUPLICATE');
    if(owner.mandateRules.some(r=>r.principalId!==owner.principalId||Date.parse(r.deadlineAt)>Date.parse(owner.originalDeadline)))
      throw Error('CURRENT_ORIGINAL_MANDATE_PRINCIPAL_AND_DEADLINE_REQUIRED');
    const handles=await pinnedJson(owner.publicOwnerHandles);
    const permissionPatterns=initialOnly?[]:await pinnedJson(owner.permissionEventRequests!),
      bindings=initialOnly?[]:await pinnedJson(owner.ownerEventBindings!);
    if(!initialOnly&&(!Array.isArray(permissionPatterns)||permissionPatterns.length<2||permissionPatterns.some((p:any)=>!Array.isArray(p.events))
      ||!Array.isArray(bindings)||bindings.length!==30))
      throw Error('THIRTY_ACTUAL_OWNER_DAY_BINDINGS_AND_PERMISSION_EVENTS_REQUIRED');
    const random=seeded(seed,owner.environmentId),envId=random.identifier(),sources:any[]=[],expectedMappings:any[]=[],expectedObligations:any[]=[],journal:any[]=[];
    const sourceRows=new Map<string,{rows:Row[];columns:string[];protocol:string;sourceId:string}>();
    const permissions=initialOnly?[]:permissionPatterns[random.integer(permissionPatterns.length)].events;
    const catalog=initialOnly?[]:owner.originalEpisodeCatalog!;
    if(!initialOnly&&(new Set(catalog.map(e=>e.workId)).size!==catalog.length
      ||new Set(catalog.map(e=>e.originalEpisodeId)).size!==catalog.length
      ||new Set(catalog.map(e=>e.businessAssignmentRegistrationId)).size!==catalog.length
      ||!catalog.some(e=>e.workId===owner.workId&&e.originalEpisodeId===owner.originalEpisodeId
        &&e.originalGrantDigest===owner.originalGrantDigest&&e.originalDeadline===owner.originalDeadline)))
      throw Error('INDEPENDENT_ORIGINAL_ASSIGNMENT_CATALOG_REQUIRED');
    if(permissions.some((p:any)=>!Number.isInteger(p.day)||p.day<0||p.day>=30))
      throw Error('EVERY_SELECTED_PERMISSION_EVENT_REQUIRES_AN_ORIGINAL_REPLAY_DAY');
    const offset=[0,330,-240][ordinal%3]!,baseTime=Math.floor(Date.parse(frozenAt)/1000)*1000-30*86400000;
    const availableAt=dated(Date.parse(frozenAt)-60000,offset),occurredAt=dated(baseTime,offset);
    const assets=random.shuffle(owner.nativeAssets),deals=assets.filter(a=>a.kind==='deal');
    if(deals.length<2)throw Error('MULTIPLE_EXISTING_CANONICAL_DEALS_REQUIRED');
    const branches=2+ordinal%4,dutyCount=1+ordinal;
    if(dutyCount>profile.bounds.derivedObligations)throw Error('ORIGINAL_GENERATOR_OBLIGATION_BOUND');
    for(const [index,sourceClass]of random.shuffle(classes).entries()){
      const grant=owner.sourceGrants.filter(g=>g.sourceClass===sourceClass);
      if(grant.length!==1||Date.parse(grant[0]!.expiresAt)<Date.parse(owner.originalDeadline))
        throw Error('EXISTING_SOURCE_CLASS_GRANT_AND_ORIGINAL_EXPIRY_REQUIRED');
      const sourceId=grant[0]!.sourceId,protocols=profile.sourceClasses.find((s:any)=>s.id===sourceClass)?.protocols;
      if(!protocols)throw Error('ORIGINAL_PROFILE_SOURCE_CLASS_MISSING');
      const preferred:Record<string,string[]>= {crm_deals:['csv','paginated_json'],financial_ledger:['tsv','financial_xml','csv'],
        document_dms:['text','xlsx'],email:['rfc822'],calendar:['icalendar'],work_tracking:['json_records','csv','paginated_json'],
        approval_records:['financial_xml','text'],lender_portal:['html','financial_xml','csv']};
      const options=preferred[sourceClass]!,protocol=options[(ordinal+index)%options.length]!;
      if(!protocols.includes(protocol))throw Error('ORIGINAL_PROFILE_PROTOCOL_NOT_ADMITTED');
      let rows:Row[]=[];
      if(sourceClass==='work_tracking')for(let duty=0;duty<dutyCount;duty++){
        const rule=owner.mandateRules[(duty+ordinal)%owner.mandateRules.length]!,id=random.identifier();
        const eligible=deals.filter(a=>rule.targetRegistrationIds.includes(a.registrationId));
        if(!eligible.length||rule.targetRegistrationIds.some(id=>!deals.some(a=>a.registrationId===id)))
          throw Error('ORIGINAL_RULE_NATIVE_TARGET_BINDING_REQUIRED');
        const target=eligible[duty%eligible.length]!;
        const record:Row={id,kind:'trigger',registrationId:target.registrationId,triggerKind:rule.triggerKind,occurredAt,availableAt,
          request:'Original material evidence '+random.identifier(),...Object.fromEntries(Object.entries(rule.triggerFields).map(([k,v])=>[k,String(v)]))};
        for(const field of ['requestText','workstreamName','findingStatement'])if(record[field])
          record[field]+=' '+random.identifier();
        rows.push(record);expectedObligations.push(expectedDuty(record,sourceId,rule,target.canonicalRef,envId));
      }else if(sourceClass==='financial_ledger'||sourceClass==='lender_portal'){
        const count=1+(ordinal+index)%3;for(let i=0;i<count;i++){
          const target=deals[i%deals.length]!,id=random.identifier();
          rows.push({id,kind:'quantity',registrationId:target.registrationId,factKey:'facility_balance',value:String(20+random.integer(980))+'.00',
            currency:'USD',unit:'units',period:new Date(baseTime).toISOString().slice(0,7),basis:'outstanding',occurredAt,availableAt});
          expectedMappings.push({identity:sourceId+'/'+id,sourceId,recordId:id,targetCanonicalRef:target.canonicalRef,kind:'quantity',originalFields:rows.at(-1)});
        }
      }else{
        const selected=sourceClass==='email'?[deals[ordinal%deals.length]!]:assets.slice(0,Math.min(assets.length,branches+(index%2)));
        rows=selected.map(a=>({id:random.identifier(),kind:'entity',entityType:a.kind,registrationId:a.registrationId,
          displayName:'Overlapping institutional name',occurredAt,availableAt}));
        rows.forEach((row,i)=>expectedMappings.push({identity:sourceId+'/'+row.id,sourceId,recordId:row.id,targetCanonicalRef:selected[i]!.canonicalRef,
          kind:'entity',originalFields:row}));
      }
      const columns=random.shuffle([...new Set(rows.flatMap(r=>Object.keys(r)))]);
      const orderedRows=random.shuffle(rows),bytes=encode(protocol,orderedRows,columns),name=envId+'-'+index+'.bin';
      if(bytes.length>profile.bounds.objectBytes||rows.length>profile.bounds.tabularRowsPerObject)throw Error('ORIGINAL_RAW_OBJECT_OR_ROWS_BOUND');
      await writeBytes(publicRoot,name,bytes);
      sources.push({sourceId,sourceClass,protocol,originalFile:name,sha256:sha(bytes),bytes:bytes.length,grantId:grant[0]!.id,
        rightsRevision:grant[0]!.rightsRevision,columnOrder:columns,objectCount:1,rowCount:rows.length});
      sourceRows.set(sourceClass,{rows:structuredClone(orderedRows),columns,protocol,sourceId});
      for(const mapping of expectedMappings.filter(m=>m.sourceId===sourceId)){
        mapping.originalSha256=sha(bytes);mapping.identity=mappingIdentity(sourceId,mapping.recordId,sha(bytes));
        mapping.meaning=mappingMeaning({sourceId,recordId:mapping.recordId,originalSha256:sha(bytes),
          canonicalRef:mapping.targetCanonicalRef,record:mapping.originalFields});mapping.semanticDigest=hash(mapping.meaning);
      }
    }
    if(sources.reduce((n,s)=>n+s.bytes,0)>profile.bounds.rawBytes||sources.length>profile.bounds.sourceInstances)
      throw Error('ORIGINAL_GENERATOR_SOURCE_OR_RAW_BYTE_BOUND');
    const faultKinds=['CORRECT_AMOUNT','REPORT_MEANING_CHANGE','REQUESTED_EXCEPTION_WITHOUT_APPROVAL','REVOKE_SOURCE_RIGHT',
      'RESTORE_CURRENT_SOURCE_RIGHT','DUPLICATE_OBSERVATION','DELAYED_AVAILABILITY','PROCESS_BRANCH_CHANGE'];
    const executionEvents:z.infer<typeof QualificationExecutionEvent>[]=[],coveredClasses=new Set<string>();
    const assign=(body:Record<string,unknown>,segments:Array<string|number>,value:string,placeholder:string)=>{
      if(!segments.length||segments.length>16||segments.some(p=>['__proto__','constructor','prototype'].includes(String(p))))
        throw Error('REGISTERED_SOURCE_OR_CLOCK_PAYLOAD_PATH_REQUIRED');
      let current:any=body;for(const part of segments.slice(0,-1)){
        current=current?.[part];if(!current||typeof current!=='object')throw Error('REGISTERED_OWNER_BODY_PATH_MISSING');}
      const last=segments.at(-1)!;if(current[last]!==placeholder)throw Error('ORIGINAL_OWNER_REQUEST_FIELD_PREIMAGE_CHANGED');
      current[last]=value;
    };
    for(let day=0;day<(initialOnly?0:30);day++){
      const binding=bindings[day],originalOwner=catalog.find(e=>e.originalEpisodeId===binding.originalEpisodeId);
      if(binding.day!==day||!binding.originalIdempotencyKey||!originalOwner
        ||binding.originalGrantDigest!==originalOwner.originalGrantDigest||binding.originalDeadline!==originalOwner.originalDeadline)
        throw Error('ACTUAL_REPLAY_OWNER_BINDING_OR_ORIGINAL_ENVELOPE_CHANGED');
      const eventKind=faultKinds[(day+ordinal)%faultKinds.length]!,replicaAt=dated(baseTime+day*86400000,offset);
      const originalEvent=QualificationExecutionEvent.parse(binding.event),event=structuredClone(originalEvent);
      if(event.originalEpisodeId!==originalOwner.originalEpisodeId||event.originalGrantDigest!==originalOwner.originalGrantDigest
        ||event.originalDeadline!==originalOwner.originalDeadline||event.workId!==originalOwner.workId||event.owner.tenantId!==owner.tenantId
        ||event.owner.principalId!==owner.principalId)throw Error('ACTUAL_EVENT_OWNER_OR_ORIGINAL_IDENTITY_CHANGED');
      event.replicaAt=replicaAt;
      if(!event.clockRequest.body||!Array.isArray(binding.clockReplicaWritePath))throw Error('EXISTING_ADMITTED_CLOCK_WRITE_BINDING_REQUIRED');
      assign(event.clockRequest.body,binding.clockReplicaWritePath,replicaAt,'GENERATED_REPLICA_INSTANT');
      // The frozen read predicate is material; it is bound to the same new
      // replica instant rather than an unobserved local timestamp.
      let clockPredicateBound=false;
      for(const predicate of event.clockObservation.appliedStatePredicates)if(predicate.equals==='GENERATED_REPLICA_INSTANT'){
        predicate.equals=replicaAt;clockPredicateBound=true;}
      if(!clockPredicateBound)throw Error('FROZEN_APPLIED_CLOCK_PREDICATE_BINDING_REQUIRED');
      if(!Array.isArray(binding.sourcePayloadBindings)||binding.sourcePayloadBindings.length!==classes.length
        ||new Set(binding.sourcePayloadBindings.map((p:any)=>p.sourceClass)).size!==classes.length
        ||classes.some(c=>!binding.sourcePayloadBindings.some((p:any)=>p.sourceClass===c)))
        throw Error('ACTUAL_OWNER_SOURCE_PAYLOAD_BINDINGS_REQUIRED');
      const dayPermissions=permissions.filter((p:any)=>p.day===day);
      if(['REVOKE_SOURCE_RIGHT','RESTORE_CURRENT_SOURCE_RIGHT'].includes(eventKind)
        &&!dayPermissions.some((p:any)=>p.faultKind===eventKind))throw Error('ACTUAL_SELECTED_PERMISSION_FAULT_BINDING_REQUIRED');
      const sourceMutations:Array<{sourceId:string;sourceClass:string;beforeSha256:string;afterSha256:string;rows:Row[]}> = [];
      for(const payload of binding.sourcePayloadBindings){
        const source=sourceRows.get(payload.sourceClass);if(!source||!event.request.body)throw Error('REGISTERED_SOURCE_OWNER_BODY_REQUIRED');
        coveredClasses.add(payload.sourceClass);
        const beforeSha256=sha(encode(source.protocol,source.rows,source.columns));
        if(eventKind==='CORRECT_AMOUNT'&&['financial_ledger','lender_portal'].includes(payload.sourceClass))
          for(const row of source.rows)if(row.kind==='quantity')
            row.value=String(20+(Number.parseInt(row.value!,10)-20+1+random.integer(979))%980)+'.00';
        if(eventKind==='REPORT_MEANING_CHANGE'&&payload.sourceClass==='lender_portal')
          for(const row of source.rows)if(row.kind==='quantity'){
            row.factKey=row.factKey==='total_drawn'?'facility_balance':'total_drawn';
            row.basis=row.factKey==='total_drawn'?'total_drawn':'outstanding';}
        if(eventKind==='DELAYED_AVAILABILITY')for(const row of source.rows.filter(r=>r.kind==='quantity'))
          row.availableAt=dated(Date.parse(availableAt)+(day+1)*1000,offset);
        if(eventKind==='PROCESS_BRANCH_CHANGE'&&payload.sourceClass==='work_tracking'){
          const row=structuredClone(source.rows[0]!);row.id=random.identifier();
          row.request='Original additional branch evidence '+random.identifier();
          for(const field of ['requestText','workstreamName','findingStatement'])if(row[field])row[field]+=' '+random.identifier();
          const applicable=owner.mandateRules.filter(rule=>rule.triggerKind===row.triggerKind);
          const target=deals.find(a=>a.registrationId===row.registrationId);if(!target||!applicable.length)
            throw Error('INDEPENDENT_PROCESS_BRANCH_RULE_AND_TARGET_REQUIRED');
          for(const rule of applicable){
            if(!rule.targetRegistrationIds.includes(target.registrationId))throw Error('ORIGINAL_BRANCH_TARGET_NOT_ELIGIBLE');
            expectedObligations.push(expectedDuty(row,source.sourceId,rule,target.canonicalRef,envId));
          }
          source.rows.push(row);
        }
        if(eventKind==='REQUESTED_EXCEPTION_WITHOUT_APPROVAL'&&payload.sourceClass==='email'){
          const row=source.rows[0]!;row.id=random.identifier();
          row.body='An exception is requested for original replay day '+day+'. This supplies no approval, permission or current authority.';
        }
        source.columns=[...new Set([...source.columns,...source.rows.flatMap(r=>Object.keys(r))])];
        const bytes=encode(source.protocol,source.rows,source.columns);
        if(bytes.length>profile.bounds.objectBytes||source.rows.length>profile.bounds.tabularRowsPerObject)
          throw Error('ORIGINAL_REPLAY_SOURCE_OBJECT_BOUND');
        sourceMutations.push({sourceId:source.sourceId,sourceClass:payload.sourceClass,beforeSha256,afterSha256:sha(bytes),
          rows:structuredClone(source.rows)});
        for(const row of source.rows.filter(r=>r.kind==='entity'||r.kind==='quantity')){
          const identity=mappingIdentity(source.sourceId,row.id!,sha(bytes));
          if(expectedMappings.some(m=>m.identity===identity))continue;
          const targets=assets.filter(a=>a.registrationId===row.registrationId&&(row.kind==='quantity'?a.kind==='deal':a.kind===row.entityType));
          if(targets.length!==1)throw Error('INDEPENDENT_REPLAY_MAPPING_TARGET_REQUIRED');
          const target=targets[0]!,meaning=mappingMeaning({sourceId:source.sourceId,recordId:row.id!,originalSha256:sha(bytes),
            canonicalRef:target.canonicalRef,record:row});
          expectedMappings.push({identity,sourceId:source.sourceId,recordId:row.id,originalSha256:sha(bytes),kind:row.kind,
            targetCanonicalRef:target.canonicalRef,originalFields:structuredClone(row),meaning,semanticDigest:hash(meaning)});
        }
        assign(event.request.body,payload.bodyPath,bytes.toString('base64'),'GENERATED_ORIGINAL_BASE64');
      }
      if(eventKind==='DUPLICATE_OBSERVATION'){
        const previous=executionEvents.filter(e=>e.owner.tenantId===event.owner.tenantId&&e.owner.principalId===event.owner.principalId
          &&e.workId===event.workId&&e.originalEpisodeId===event.originalEpisodeId&&e.request.path===event.request.path).at(-1);
        // The first day can expose the original payload; a separate delivery
        // of that same payload/key is then frozen as the duplicate event.
        if(previous){event.request=structuredClone(previous.request);event.originalIdempotencyKey=previous.originalIdempotencyKey;}
        const duplicate=structuredClone(event);duplicate.id=event.id+'-duplicate-delivery';duplicate.dependsOn=[event.id];
        executionEvents.push(QualificationExecutionEvent.parse(event));executionEvents.push(QualificationExecutionEvent.parse(duplicate));
      }
      if(!['REVOKE_SOURCE_RIGHT','RESTORE_CURRENT_SOURCE_RIGHT','DUPLICATE_OBSERVATION'].includes(eventKind)
        &&!sourceMutations.some(s=>s.beforeSha256!==s.afterSha256))throw Error('GENERATED_FAULT_HAS_NO_SOURCE_MUTATION');
      if(eventKind!=='DUPLICATE_OBSERVATION')executionEvents.push(QualificationExecutionEvent.parse(event));
      for(const permission of dayPermissions){
        const permissionEvent=QualificationExecutionEvent.parse(permission.event);
        const originalPermissionOwner=catalog.find(e=>e.originalEpisodeId===permissionEvent.originalEpisodeId);
        if(!originalPermissionOwner||permissionEvent.workId!==originalPermissionOwner.workId||permissionEvent.owner.tenantId!==owner.tenantId
          ||permissionEvent.owner.principalId!==owner.principalId||permissionEvent.originalGrantDigest!==originalPermissionOwner.originalGrantDigest
          ||permissionEvent.originalDeadline!==originalPermissionOwner.originalDeadline||!permissionEvent.clockRequest.body
          ||!Array.isArray(permission.clockReplicaWritePath))throw Error('ACTUAL_REGISTERED_PERMISSION_EVENT_BINDING_REQUIRED');
        permissionEvent.replicaAt=replicaAt;
        assign(permissionEvent.clockRequest.body,permission.clockReplicaWritePath,replicaAt,'GENERATED_REPLICA_INSTANT');
        let bound=false;
        for(const predicate of permissionEvent.clockObservation.appliedStatePredicates)if(predicate.equals==='GENERATED_REPLICA_INSTANT'){
          predicate.equals=replicaAt;bound=true;}
        if(!bound)throw Error('REGISTERED_PERMISSION_CLOCK_READ_REQUIRED');
        executionEvents.push(QualificationExecutionEvent.parse(permissionEvent));
      }
      journal.push({day,replicaAt,ownerBinding:binding,eventDigest:hash(event),
        eventKind,permissionEvents:dayPermissions,sourceMutations,
        affectedSourceIds:sourceMutations.filter(s=>s.beforeSha256!==s.afterSha256).map(s=>s.sourceId),
        originalEpisodeId:originalOwner.originalEpisodeId,
        originalGrantDigest:originalOwner.originalGrantDigest,originalDeadline:originalOwner.originalDeadline,
        newEffectIdentityIssued:false,candidateHumanPatchPermitted:false});
    }
    if(!initialOnly&&classes.some(c=>!coveredClasses.has(c)))throw Error('EACH_ORIGINAL_SYSTEM_CLASS_REQUIRES_ACTUAL_REPLAY_OWNER_BINDING');
    // Same-day permission and source events are ordered by their frozen graph.
    // Unknown dependencies and cycles are refused; no selected event is dropped.
    const orderedEvents:z.infer<typeof QualificationExecutionEvent>[]=[],prior=new Set<string>();
    if(new Set(executionEvents.map(e=>e.id)).size!==executionEvents.length)throw Error('GENERATED_EVENT_IDENTITY_DUPLICATE');
    for(let day=0;day<30;day++){
      const at=Date.parse(dated(baseTime+day*86400000,offset));
      const pending=executionEvents.filter(e=>Date.parse(e.replicaAt)===at);
      while(pending.length){
        const index=pending.findIndex(e=>e.dependsOn.every(id=>prior.has(id)));
        if(index<0)throw Error('SELECTED_PERMISSION_OR_SOURCE_CAUSAL_GRAPH_INVALID');
        const event=pending.splice(index,1)[0]!;orderedEvents.push(event);prior.add(event.id);
      }
    }
    if(orderedEvents.length!==executionEvents.length)throw Error('GENERATED_EVENT_COVERAGE_CHANGED');
    const executionEnvironment={id:owner.environmentId,replicaStart:dated(baseTime,offset),replicaEnd:dated(baseTime+30*86400000,offset),
      events:orderedEvents};
    if(!initialOnly)executionEnvironments.push(executionEnvironment);
    const structure={branches,dutyCount,sourceOrder:sources.map(s=>s.sourceClass),protocols:sources.map(s=>s.protocol),
      rowCounts:sources.map(s=>s.rowCount),normativeOperationOrder:expectedObligations.map(o=>o.operation),
      faultOrder:journal.map(e=>e.eventKind),dateOffsetMinutes:offset};
    const structuralDigest=hash(structure);if(allStructures.has(structuralDigest))throw Error('RENAMED_IDENTICAL_STRUCTURE_REFUSED');
    allStructures.add(structuralDigest);
    const publicPacket={schema:'finnor.x1.generated-original-institution-inputs.v1',environmentId:owner.environmentId,institutionId:owner.institutionId,
      ownerHandles:handles,sources,mandateRules:owner.mandateRules.map(({fixedBusinessWeight,critical,triggerFields,postconditionFields,
        postconditionRef,observerRef,targetRegistrationIds,...r})=>r),
      independentHiddenOracleIncluded:false,protectedCustodyEstablished:false};
    const publicPin=await write(publicRoot,envId+'-inputs.json',publicPacket);
    const oracle={schema:'finnor.x1.generated-withheld-institution-ledger.v1',protocolId:control.protocolId,environmentId:owner.environmentId,
      frozenAt,ownerSnapshotDigest:owner.existingOwnerSnapshotDigest,custodyReceiptDigest:owner.custodyReceiptDigest,
      expectedMappings,expectedObligations,journal,structure,structuralDigest,originalEpisodeCatalog:catalog,
      criticalCasesFrozenBeforeExposure:true,
      semanticDigestDefinition:'CANONICAL_JSON_SHA256_OF_INDEPENDENT_SOURCE_AND_NATIVE_TARGET_FIELDS',
      expectedValuesIndependentOfCandidate:true,signature:null,protectedCustodyEstablished:false};
    const oraclePin=await write(withheldRoot,envId+'-ledger.json',oracle);
    const expected={mappings:expectedMappings.map(m=>({identity:m.identity,semanticDigest:m.semanticDigest})),
      obligations:expectedObligations.map(({identity,semanticDigest,postconditionDigest,deadlineAt,critical,businessAssignmentId,fixedBusinessWeight})=>
        ({identity,semanticDigest,postconditionDigest,deadlineAt,critical,businessAssignmentId,fixedBusinessWeight})),
      changes:orderedEvents.map(e=>({identity:e.id,occurredAt:e.occurredAt,availableAt:e.availableAt}))};
    const soakExpected=initialOnly?null:ExpectedEnvironment.parse(await pinnedJson(owner.soakExpectedEnvironment!));
    const scoringBody=initialOnly?null:OracleLedger.parse({schema:'finnor.x1.protected-oracle-ledger.v1',protocolId:control.protocolId,
      environmentId:owner.environmentId,frozenAt,expected:{replay:expected,soak:soakExpected},
      criticalCasesFrozen:true,unseenCustodyCommitment:owner.custodyReceiptDigest,replayJournalCommitment:hash(executionEnvironment)});
    const scoringOraclePin=await write(withheldRoot,envId+'-scoring-oracle-draft.json',{
      schema:'finnor.x1.unsigned-oracle-ledger-draft.v1',body:scoringBody,signature:null,
      independentSignatureAndUnseenCustodyRequired:true,protectedCustodyEstablished:false});
    if(!initialOnly)await write(withheldRoot,envId+'-phase-expectation-custody.json',{
      replayExpectedDigest:hash(expected),soakExpectedPin:owner.soakExpectedEnvironment,soakExpectedDigest:hash(soakExpected),
      replayDerivedFromIndependentOriginalVersions:true,soakReadFromIndependentPinnedInput:true,candidateOutputRead:false,
      originalEpisodeCatalog:catalog});
    manifest.push({environmentId:owner.environmentId,publicPin,oraclePin,scoringOraclePin,structuralDigest,
      systemClasses:sources.map(s=>s.sourceClass),replayDays:initialOnly?0:30,separateElapsedLiveDaysRequired:7,
      randomizationCommitments:{identifiers:hash(sources.map(s=>[s.sourceId,s.sha256])),schemaOrganization:hash(sources.map(s=>s.columnOrder)),
        dateConventions:hash({offset,occurredAt,availableAt}),permissions:hash(permissions),processVariants:hash(structure)}});
  }
  const result={schema:'finnor.x1.generated-independent-population-manifest.v1',protocolId:control.protocolId,
    generatorRevision:'finnor.x1.independent-population-generator.v1',initialOnly,seedCommitment:control.seedCommitment,
    inputDigest:hash(parsed),profileSha256:control.profile.sha256,coordinates,qualificationThresholds:profile.qualification,
    environments:manifest,allTenStructuresDistinct:true,minimumSystemClassesEach:8,
    generatorCreatesNoKeysGrantsOrAdmission:true,resources:{outputBytes,elapsedMs:performance.now()-began,
      measurementPhase:'BEFORE_FINAL_MANIFEST_WRITES',
      moneyUsd:null,humanSeconds:null,aggregatePeakMemoryBytes:null,lifecycleCostOwnerReceiptRequired:true},
    protectedCustodyEstablished:false,previouslyUnseenPopulationEstablished:false,
    admittedLiveServicesOrBusinessCompletionEstablished:false,thirtyDayExecutionEstablished:false,sevenElapsedDaysEstablished:false};
  await write(withheldRoot,'generation-manifest.json',result);
  // The signed registration is issued after generation. Its protocol digest
  // binds this immutable environment preimage without a circular self-hash.
  if(!initialOnly)QualificationExecutionJournal.parse({schema:'finnor.x1.qualification-execution-journal.v1',protocolDigest:'0'.repeat(64),
    candidateCutDigest:control.candidateCutDigest,allocationConventionDigest:control.allocationConventionDigest,
    environments:executionEnvironments});
  await write(withheldRoot,'execution-journal-draft.json',{schema:'finnor.x1.qualification-execution-journal-draft.v1',
    candidateCutDigest:control.candidateCutDigest,allocationConventionDigest:control.allocationConventionDigest,
    environments:executionEnvironments,registrationProtocolDigestRequired:true,protectedQualificationEstablished:false});
  if(!initialOnly)await write(publicRoot,'public-original-episode-catalogue-draft.json',{
    schema:'finnor.x1.original-episode-catalogue-draft.v1',candidateCutDigest:control.candidateCutDigest,
    allocationConventionDigest:control.allocationConventionDigest,
    environments:control.ownerInputs.map(owner=>({environmentId:owner.environmentId,
      originalEpisodes:owner.originalEpisodeCatalog!.map(({workId,originalEpisodeId,originalGrantDigest,originalDeadline})=>({
        tenantId:owner.tenantId,principalId:owner.principalId,workId,originalEpisodeId,originalGrantDigest,originalDeadline}))})),
    includeInSignedPublicInputEnvironmentBeforeExposure:true,signature:null,protectedQualificationEstablished:false});
  await write(publicRoot,'public-generation-manifest.json',{...result,environments:manifest.map(({oraclePin,scoringOraclePin,...e})=>e)});
  return result;
}
export const generateIndependentPopulation=(value:unknown,paths:{publicRoot:string;withheldRoot:string})=>
  generatePopulation(value,paths,false);
export const generateIndependentInitialPopulation=(value:unknown,paths:{publicRoot:string;withheldRoot:string})=>
  generatePopulation(value,paths,true);

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),at=(flag:string)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
  const control=at('--control'),publicRoot=at('--public'),withheldRoot=at('--withheld');
  if(!control?.startsWith('/')||!publicRoot?.startsWith('/')||!withheldRoot?.startsWith('/'))
    throw Error('USE_ABSOLUTE_PINNED_CONTROL_PUBLIC_AND_WITHHELD_DIRECTORIES');
  const result=await generateIndependentPopulation(JSON.parse(await readFile(control,'utf8')),{publicRoot,withheldRoot});
  console.log(JSON.stringify({status:'GENERATED_UNSIGNED_INDEPENDENT_POPULATION',environments:result.environments.length,
    protectedCustodyEstablished:false,previouslyUnseenPopulationEstablished:false,publicRoot,withheldRoot}));
}

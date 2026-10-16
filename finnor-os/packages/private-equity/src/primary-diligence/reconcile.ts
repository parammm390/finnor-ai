import type {DiligenceAssertion,DiligenceValue,ExactQuantity,PrimaryObservation,PrimaryReconciliation,PrimaryReferenceSemantics,VReference} from '@finnor/shared-types';
import {canonical,hash,reference} from './store';

/** Producer-owned replay of the frozen acceptance contract. No checker imports,
 * checker conclusions, or checker reconciliation are used to construct this. */
const unique=(values:string[])=>[...new Set(values)].sort();
const eq=(left:unknown,right:unknown)=>canonical(left)===canonical(right);
const within=(start:string,end:string,first:string,last:string)=>Date.parse(start)<=Date.parse(first)&&Date.parse(end)>=Date.parse(last);
const contains=(members:string[],required:string[])=>required.every(id=>members.includes(id));
const order=(left:string[],right:string[])=>{for(let i=0;i<left.length;i++){if(left[i]!<right[i]!)return -1;if(left[i]!>right[i]!)return 1;}return 0;};
function rational(n:bigint,d:bigint):ExactQuantity{
 if(d===0n)throw Error('PRIMARY_ZERO_DENOMINATOR');if(d<0n){n=-n;d=-d;}
 if(n.toString().length>384||d.toString().length>384)throw Error('PRIMARY_RATIONAL_INTERMEDIATE_BOUND');
 let a=n<0n?-n:n,b=d;while(b){const remainder=a%b;a=b;b=remainder;}
 const value={numerator:(n/(a||1n)).toString(),denominator:(d/(a||1n)).toString()};
 if(value.numerator.replace('-','').length>96||value.denominator.length>96)throw Error('PRIMARY_RATIONAL_OUTPUT_BOUND');
 return value;
}
export function sumQuantities(a:ExactQuantity,b:ExactQuantity,sign=1n){
 return rational(BigInt(a.numerator)*BigInt(b.denominator)+sign*BigInt(b.numerator)*BigInt(a.denominator),BigInt(a.denominator)*BigInt(b.denominator));
}
function reduced(value:DiligenceValue):DiligenceValue{
 return value.kind==='EXACT'?{kind:'EXACT',quantity:rational(BigInt(value.quantity.numerator),BigInt(value.quantity.denominator))}:value;
}
export function scaled(value:DiligenceValue,a:DiligenceAssertion):DiligenceValue{
 return value.kind==='EXACT'?{kind:'EXACT',quantity:rational(BigInt(value.quantity.numerator)*BigInt(a.semantics.scale.numerator)*(a.semantics.signConvention==='NEGATE'?-1n:1n),BigInt(value.quantity.denominator)*BigInt(a.semantics.scale.denominator))}:value;
}
type Cell={record:PrimaryObservation['raw']['body']['records'][number];observation:PrimaryObservation;index:number};
export function reconcilePrimary(a:DiligenceAssertion,input:PrimaryObservation[],meaning:PrimaryReferenceSemantics,context:{checkedAt:string;authorityRef:VReference}):PrimaryReconciliation{
 const observations=input.filter(o=>o.request.assertionRefs.some(r=>r.id===a.assertionId&&r.contentDigest===hash(a)));
 const uncertainty:PrimaryReconciliation['uncertainty']={identity:[],measurement:[],sampling:[],interpretation:[]};
 const gaps:string[]=[],blockers=new Set<string>(),coverageReasons=new Set<string>(),exclusions:PrimaryReconciliation['excludedEconomicIds']=[];
 const note=(axis:keyof typeof uncertainty,reason:string,blocking=true)=>{gaps.push(reason);uncertainty[axis].push(reason);if(blocking)blockers.add(reason);};
 const coverage=(reason:string)=>{coverageReasons.add(reason);note('measurement',reason,false);};
 const rules=meaning.rules.filter(rule=>rule.field===a.field),rule=rules.length===1?rules[0]:undefined;
 if(!rule)note('interpretation','NO_UNIQUE_FIELD_RULE');
 if(!eq(a.semantics.basisRef,reference('S2',meaning.profileId,meaning.revision,meaning))||
  meaning.legalEntityId!==a.semantics.legalEntityId||meaning.grossNetTreatment!==a.semantics.grossNetTreatment||
  meaning.recognitionRule!==a.semantics.recognitionRule||meaning.calendarRef!==a.semantics.calendarRef||meaning.consolidationRef!==a.semantics.consolidationRef)note('interpretation','REFERENCE_SEMANTICS_BINDING');
 if(!eq(meaning.authorityRef,context.authorityRef)||Date.parse(context.checkedAt)<Date.parse(meaning.validFrom)||Date.parse(context.checkedAt)>=Date.parse(meaning.expiresAt))note('interpretation','SEMANTICS_AUTHORITY_CURRENTNESS');
 if(new Set(a.semantics.perimeter).size!==a.semantics.perimeter.length||!eq(unique(a.requiredCoverage.members),unique(a.semantics.accountOrParticipantIds)))note('identity','REGISTERED_PERIMETER_MEMBERS');
 if(a.semantics.perimeter.length!==1)note('identity','MULTI_ENTITY_PERIMETER_UNSUPPORTED');
 if(a.requiredCoverage.measurementDesignRef||a.amountOrState.kind==='INTERVAL')note('sampling','MEASUREMENT_DESIGN_NOT_EXECUTABLE');
 if(rule&&!contains(a.requiredCoverage.requiredRecordKinds,rule.recordKinds))note('interpretation','RULE_KINDS_NOT_REGISTERED');
 if(rule?.treatment==='EARNED_REVENUE'&&(!contains(rule.requiredWitnessFields,['performance','recognition','cutoff','grossNetTreatment','nonRevenueExclusions'])||!meaning.professionalReviewRef))note('interpretation','REVENUE_REFERENCE_WITNESSES');
 if(rule?.treatment==='EXACT_RECORDED_STATE'&&a.predicateKind==='POPULATION_TOTAL')note('interpretation','STATE_POPULATION_UNSUPPORTED');
 if(a.predicateKind==='RECORD_CLASSIFICATION'&&rule?.treatment!=='EXACT_RECORDED_STATE')note('interpretation','CLASSIFICATION_REQUIRES_STATE_RULE');
 const pageSets=new Map<string,PrimaryObservation[]>(),members:string[]=[],cells:Cell[]=[];
 for(const observation of observations){
  const {request:q,sourceProfile:source,raw:{body}}=observation;
  if(rule&&!contains(q.fieldNames,rule.requiredWitnessFields))note('interpretation','REFERENCE_FIELDS_NOT_REQUESTED:'+observation.observationId);
  if(!within(source.availableHistory.start,source.availableHistory.end,q.periodStart,q.periodEnd))coverage('SOURCE_HISTORY_INCOMPLETE:'+observation.observationId);
  if(body.populationId!==q.populationId||body.populationRevision!==q.populationRevision)note('identity','RESPONSE_POPULATION_BINDING:'+observation.observationId);
  if(!contains(q.requiredMembers,body.observedMembers)||!contains(q.requiredMembers,body.coverage.completeForMembers))note('identity','RESPONSE_MEMBER_BINDING:'+observation.observationId);
  if(body.suspiciousReasons.length)note('identity','SUSPICIOUS_REVALIDATION_REQUIRED:'+observation.observationId);
  body.coverage.missingReasons.forEach(reason=>coverage('SOURCE_MISSING:'+reason));
  if(!['OBSERVED','NO_RECORD'].includes(body.status))note('measurement','SOURCE_STATUS_'+body.status+':'+observation.observationId);
  if(body.status!=='OBSERVED'&&body.records.length)note('measurement','STATUS_RECORD_CONFLICT:'+observation.observationId);
  if(body.coverage.measurementDesignRef)note('sampling','SOURCE_SAMPLE_NOT_EXECUTABLE:'+observation.observationId);
  members.push(...body.observedMembers.filter(id=>q.requiredMembers.includes(id)));
  const key=canonical([q.sourceProfileRef,q.populationId,q.populationRevision,unique(q.requiredMembers),q.periodStart,q.periodEnd,unique(q.fieldNames)]);
  pageSets.set(key,[...(pageSets.get(key)??[]),observation]);
  if(body.status!=='OBSERVED'||body.suspiciousReasons.length)continue;
  body.records.forEach((record,index)=>{
   if(!body.coverage.availableRecordKinds.includes(record.kind))note('measurement','RAW_RECORD_COVERAGE_BINDING:'+record.economicId);
   if(record.legalEntityId!==a.semantics.legalEntityId||!q.accountOrParticipantIds.includes(record.accountOrParticipantId)||!body.observedMembers.includes(record.accountOrParticipantId)){
    note('identity','RAW_RECORD_IDENTITY:'+record.economicId);exclusions.push({id:record.economicId,reason:'IDENTITY_BINDING'});return;
   }
   if(record.currency!==a.semantics.currency||record.units!==a.semantics.units||record.basisDigest!==a.semantics.basisRef.contentDigest||
    Date.parse(record.periodStart)>Date.parse(record.periodEnd)||Date.parse(record.periodStart)<Date.parse(q.periodStart)||Date.parse(record.periodEnd)>Date.parse(q.periodEnd)||
    Date.parse(record.effectiveAt)<Date.parse(q.periodStart)||Date.parse(record.effectiveAt)>Date.parse(q.cutoff)||Date.parse(record.observedAt)>Date.parse(body.observedAt)){
    note('interpretation','RAW_RECORD_SEMANTICS:'+record.economicId);exclusions.push({id:record.economicId,reason:'SEMANTICS_BINDING'});return;
   }
   cells.push({record,index,observation});
  });
 }
 const pageContents=(o:PrimaryObservation)=>{
  const body={...o.raw.body} as Record<string,unknown>;for(const key of ['requestId','requestDigest','observedAt','providerCost'])delete body[key];return body;
 };
 const covered:string[]=[];let allComplete=pageSets.size>0;
 for(const pages of pageSets.values()){
  const first=pages[0]!,head=first.raw.body,byOrdinal=new Map<number,PrimaryObservation>();let complete=true,chain=true;
  for(const page of pages){
   const body=page.raw.body,c=body.coverage,match=/^(?:page-)?([1-9][0-9]{0,2})$/.exec(c.pageId),ordinal=match?Number(match[1]):0;
   if(!ordinal||ordinal>c.totalPages||c.totalPages!==head.coverage.totalPages||body.sourceRevision!==head.sourceRevision||body.populationRevision!==head.populationRevision||body.populationId!==head.populationId){complete=false;chain=false;}
   const prior=byOrdinal.get(ordinal);
   if(prior&&!eq(pageContents(prior),pageContents(page))) {note('measurement',`CONFLICTING_PAGE:${page.sourceProfile.profileId}:${c.pageId}`);complete=false;chain=false;}
   else byOrdinal.set(ordinal,page);
   if(!['OBSERVED','NO_RECORD'].includes(body.status)||body.suspiciousReasons.length||c.missingReasons.length||!c.completePopulation||
    !eq(unique(c.completeForMembers),unique(page.request.requiredMembers))||!contains(c.availableRecordKinds,a.requiredCoverage.requiredRecordKinds)||
    !within(c.historyStart,c.historyEnd,a.semantics.periodStart,a.semantics.periodEnd)||c.measurementDesignRef)complete=false;
  }
  if(byOrdinal.size!==head.coverage.totalPages){complete=false;chain=false;}
  for(let ordinal=1;ordinal<=head.coverage.totalPages;ordinal++){
   const page=byOrdinal.get(ordinal),next=byOrdinal.get(ordinal+1);
   if(!page||(ordinal===head.coverage.totalPages?page.raw.body.coverage.nextCursor!==null:!next||page.raw.body.coverage.nextCursor!==next.raw.body.coverage.pageId)){complete=false;chain=false;}
  }
  if(!chain)note('measurement','PAGINATION_INCOMPLETE:'+first.sourceProfile.profileId);
  if(complete)covered.push(...first.request.requiredMembers);
  else{allComplete=false;coverage('POPULATION_STREAM_INCOMPLETE:'+first.sourceProfile.profileId);}
 }
 const coverageComplete=allComplete&&contains(unique(covered),a.requiredCoverage.members);
 if(a.requiredCoverage.completePopulation||['POPULATION_TOTAL','ABSENCE'].includes(a.predicateKind)){
  coverageReasons.forEach(reason=>blockers.add(reason));if(!coverageComplete)note('measurement','REGISTERED_POPULATION_INCOMPLETE');
 }
 if(!observations.length)note('measurement','NO_PRIMARY_OBSERVATIONS');
 const content=(record:Cell['record'],alias=false)=>{
  const body={...record} as Record<string,unknown>;for(const key of ['issuerRecordId','observedAt','economicId','revision'])delete body[key];if(alias)delete body.aliasOf;
  body.fields=Object.fromEntries(Object.entries(record.fields).map(([key,value])=>[key,reduced(value)]));return body;
 };
 const histories=new Map<string,Map<number,Cell[]>>(),latest=new Map<string,Cell[]>();
 for(const cell of cells){const versions=histories.get(cell.record.economicId)??new Map<number,Cell[]>();versions.set(cell.record.revision,[...(versions.get(cell.record.revision)??[]),cell]);histories.set(cell.record.economicId,versions);}
 for(const [id,versions] of histories){
  const sequence=[...versions.keys()].sort((a,b)=>a-b);
  for(const copies of versions.values())if(copies.some(cell=>!eq(content(cell.record),content(copies[0]!.record))))note('measurement','ECONOMIC_REVISION_CONFLICT:'+id);
  for(let i=1;i<sequence.length;i++){const before=versions.get(sequence[i-1]!)![0]!.record,after=versions.get(sequence[i]!)![0]!.record;
   if(['REMOVED','REVERSED'].includes(before.state)&&after.state==='POSTED'||before.state==='POSTED'&&after.state==='PENDING')note('measurement','UNSUPPORTED_REVISION_TRANSITION:'+id);
  }
  latest.set(id,versions.get(sequence.at(-1)!)!);
 }
 function root(id:string):string|null{
  let cursor=id;const walked=new Set<string>();
  while(latest.get(cursor)?.[0]?.record.aliasOf){if(walked.has(cursor)){note('identity','ALIAS_CYCLE:'+id);return null;}walked.add(cursor);cursor=latest.get(cursor)![0]!.record.aliasOf!;}
  if(!latest.has(cursor)){note('identity','ALIAS_TARGET_MISSING:'+id);return null;}return cursor;
 }
 const groups=new Map<string,Cell[]>();
 for(const [id,copies] of latest){
  const target=root(id);if(!target){exclusions.push({id,reason:'ALIAS_UNRESOLVED'});continue;}
  if(target!==id){if(!eq(content(copies[0]!.record,true),content(latest.get(target)![0]!.record,true)))note('measurement','ALIAS_VALUE_CONFLICT:'+id);exclusions.push({id,reason:'ALIAS_OF:'+target});}
  groups.set(target,[...(groups.get(target)??[]),...copies]);
 }
 for(const [id,copies] of groups)groups.set(id,[...latest.get(id)!,...copies.filter(c=>c.record.economicId!==id)]);
 const retired=new Set<string>(),successor=new Map<string,string>(),reversal=new Map<string,string>();
 for(const [id,copies] of groups){
  const record=copies[0]!.record;
  if(record.replacesEconomicId){
   const target=root(record.replacesEconomicId),prior=target?groups.get(target)?.[0]?.record:null;
   if(!target||target===id||record.state!=='POSTED'||!prior||!['PENDING','POSTED'].includes(prior.state)||successor.has(target)&&successor.get(target)!==id)note('measurement','REPLACEMENT_UNRESOLVED:'+id);
   else{if(record.accountOrParticipantId!==prior.accountOrParticipantId||record.revision<prior.revision)note('identity','REPLACEMENT_BINDING:'+id);successor.set(target,id);retired.add(target);exclusions.push({id:target,reason:'REPLACED_BY:'+id});}
  }
  if(record.reversesEconomicId){
   const target=root(record.reversesEconomicId),prior=target?groups.get(target)?.[0]?.record:null,current=record.fields[a.field],original=prior?.fields[a.field];
   const inverse=current?.kind==='EXACT'&&original?.kind==='EXACT'?
    (record.state==='POSTED'?sumQuantities(current.quantity,original.quantity).numerator==='0':eq(reduced(current),reduced(original))):
    record.state!=='POSTED'&&current!==undefined&&original!==undefined&&eq(current,original);
   if(!target||target===id||!prior||prior.state!=='POSTED'||!['POSTED','REVERSED'].includes(record.state)||prior.accountOrParticipantId!==record.accountOrParticipantId||!inverse||reversal.has(target)&&reversal.get(target)!==id)note('measurement','REVERSAL_UNRESOLVED:'+id);
   else{reversal.set(target,id);retired.add(target);retired.add(id);exclusions.push({id:target,reason:'REVERSED_BY:'+id},{id,reason:'REVERSAL_OF:'+target});}
  }
 }
 for(const origin of successor.keys()){let cursor=origin;const seen=new Set<string>();while(successor.has(cursor)){if(seen.has(cursor)){note('identity','REPLACEMENT_CYCLE:'+origin);break;}seen.add(cursor);cursor=successor.get(cursor)!;}}
 for(const id of reversal.keys())if(successor.has(id))note('measurement','REPLACED_REVERSAL_CONFLICT:'+id);
 const requested=unique(a.economicRecordIds.map(id=>{let cursor=latest.has(id)?root(id)??id:id;const seen=new Set<string>();while(successor.has(cursor)&&!seen.has(cursor)){seen.add(cursor);cursor=successor.get(cursor)!;}return cursor;}));
 const selected:string[]=[],values:DiligenceValue[]=[],witnesses:PrimaryReconciliation['sourceWitnesses']=[];
 for(const [id,copies] of [...groups].sort(([a],[b])=>order([a],[b]))){
  const record=copies[0]!.record,population=['POPULATION_TOTAL','ABSENCE'].includes(a.predicateKind);
  if(population?a.economicRecordIds.length>0&&!requested.includes(id):!requested.includes(id)){exclusions.push({id,reason:'OUTSIDE_EXACT_PREDICATE'});continue;}
  let usable=true;
  if(rule)for(const copy of copies)for(const field of rule.requiredWitnessFields)if(!copy.record.witnessFields[field]?.trim()||!copy.observation.sourceProfile.authoritativeFields.includes(field)||!copy.observation.request.fieldNames.includes(field)){note('interpretation',`REQUIRED_FIELD_WITNESS:${id}:${field}`);usable=false;}
  if(retired.has(id))continue;
  if(['REMOVED','REVERSED'].includes(record.state)){exclusions.push({id,reason:record.state});continue;}
  if(record.state==='PENDING'){note('measurement','PENDING_RECORD:'+id);exclusions.push({id,reason:'PENDING'});continue;}
  if(!rule||!rule.recordKinds.includes(record.kind)){exclusions.push({id,reason:'OUTSIDE_RULE_KINDS'});continue;}
  const field=record.fields[a.field];
  if(!field||['UNKNOWN','INTERVAL'].includes(field.kind)){note('measurement','EXACT_FIELD_UNAVAILABLE:'+id);exclusions.push({id,reason:'UNKNOWN_FIELD'});continue;}
  for(const copy of copies)if(rule.treatment==='EARNED_REVENUE'&&
   (copy.record.witnessFields.performance!=='SATISFIED'||copy.record.witnessFields.recognition!==meaning.recognitionRule||copy.record.witnessFields.cutoff!==a.semantics.cutoff||
    copy.record.witnessFields.grossNetTreatment!==meaning.grossNetTreatment||copy.record.witnessFields.nonRevenueExclusions!=='BORROWING_TRANSFERS_ADVANCES_EXCLUDED'||copy.record.relatedParty==='UNKNOWN')){note('interpretation','REVENUE_RECOGNITION_UNESTABLISHED:'+id);usable=false;}
  if((rule.treatment==='EXACT_RECORDED_STATE')!==(field.kind==='STATE')){note('interpretation','FIELD_TREATMENT_MISMATCH:'+id);usable=false;}
  if(!usable){exclusions.push({id,reason:'INSUFFICIENT_FIELD_WITNESSES'});continue;}
  selected.push(id);values.push(scaled(field,a));
  for(const copy of copies)witnesses.push({observationRef:copy.observation.sourceRef,issuerRecordId:copy.record.issuerRecordId,economicId:copy.record.economicId,sourceRevision:copy.observation.raw.body.sourceRevision,
   field:a.field,rawPointer:`/body/records/${copy.index}/fields/${a.field.replace(/~/g,'~0').replace(/\//g,'~1')}`,rawValue:copy.record.fields[a.field]!,normalizedValue:scaled(copy.record.fields[a.field]!,a),semantics:a.semantics,sourceClass:copy.observation.sourceClass});
 }
 if(['RECORD_VALUE','RECORD_CLASSIFICATION'].includes(a.predicateKind))for(const id of requested)if(!selected.includes(id))note('measurement','EXACT_RECORD_UNESTABLISHED:'+id);
 const unknown:DiligenceValue={kind:'UNKNOWN',reason:'INSUFFICIENT_PRIMARY_EVIDENCE'};
 let observedValue:DiligenceValue=unknown,discrepancy:PrimaryReconciliation['discrepancy']=null;
 if(!blockers.size){
  if(a.predicateKind==='ABSENCE')observedValue={kind:'STATE',state:selected.length?'PRESENT':'ABSENT'};
  else if(values.every(v=>v.kind==='EXACT')&&rule?.treatment!=='EXACT_RECORDED_STATE')observedValue={kind:'EXACT',quantity:values.reduce<ExactQuantity>((total,v)=>sumQuantities(total,(v as Extract<DiligenceValue,{kind:'EXACT'}>).quantity),{numerator:'0',denominator:'1'})};
  else if(values.length&&values.every(v=>v.kind==='STATE'&&eq(v,values[0])))observedValue=values[0]!;
  else note('interpretation','INCOMPATIBLE_RECORD_STATES');
 }
 if(observedValue.kind!=='UNKNOWN'&&!blockers.size){
  const expected=a.amountOrState;
  if(expected.kind==='EXACT'&&observedValue.kind==='EXACT'){
   const difference=sumQuantities(observedValue.quantity,expected.quantity,-1n),magnitude=BigInt(difference.numerator)<0n?-BigInt(difference.numerator):BigInt(difference.numerator),tolerance=a.requiredCoverage.errorTolerance;
   if(magnitude*BigInt(tolerance.denominator)>BigInt(tolerance.numerator)*BigInt(difference.denominator))discrepancy={asserted:expected,observed:observedValue,difference:{kind:'EXACT',quantity:difference}};
  }else if(expected.kind==='STATE'&&observedValue.kind==='STATE'){
   if(expected.state!==observedValue.state)discrepancy={asserted:expected,observed:observedValue,difference:{kind:'UNKNOWN',reason:'STATE_DIFFERENCE_NOT_QUANTITY'}};
  }else if(expected.kind!=='UNKNOWN'){note('interpretation','EXPECTED_VALUE_TYPE_INCOMPATIBLE');observedValue=unknown;}
 }
 witnesses.sort((a,b)=>order([a.observationRef.id,a.rawPointer,a.economicId],[b.observationRef.id,b.rawPointer,b.economicId]));
 return {assertionRef:reference('V2',a.assertionId,a.revision,a),sourceWitnesses:witnesses,selectedEconomicIds:unique(selected),excludedEconomicIds:[...new Map(exclusions.map(v=>[canonical(v),v])).values()].sort((a,b)=>order([a.id,a.reason],[b.id,b.reason])),
  observedMembers:unique(members),requiredMembers:unique(a.requiredCoverage.members),coverageComplete,observedValue,gaps:unique(gaps),discrepancy,
  uncertainty:Object.fromEntries(Object.entries(uncertainty).map(([key,value])=>[key,unique(value)])) as typeof uncertainty,
  excludedInterpretations:unique(['AUDIT_OPINION','S8_ADMISSION','SOURCE_SIGNATURE_IS_TRUTH','PARTIAL_POPULATION_POINT_ESTIMATE','TARGET_RECORD_IS_EXTERNAL_AUTHORITY','FORWARDED_REPLY_IS_DIRECT_CONFIRMATION','CASH_IS_EARNED_REVENUE','UNOBSERVED_REMAINDER_IS_ZERO',...rules.flatMap(r=>r.excludedInterpretations)])};
}

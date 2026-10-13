/** Public observation normal form; no inference, rule selection or expectations. */
export const normalizedInstant=(value:unknown):string|null=>{
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string'||!Number.isFinite(Date.parse(value)))throw Error('INDEPENDENT_MEANING_INSTANT_REQUIRED');
  return new Date(value).toISOString();
};
export function mappingMeaning(input:{sourceId:string;recordId:string;originalSha256:string;canonicalRef:string;
  record:Record<string,unknown>}){
  const r=input.record;
  const fields={schema:'finnor.x1.qualification-mapping-meaning.v1',sourceId:input.sourceId,recordId:input.recordId,
    originalSha256:input.originalSha256,canonicalRef:input.canonicalRef,kind:r.kind,registrationId:r.registrationId,
    entityType:r.kind==='entity'?r.entityType:null,
    factKey:r.kind==='quantity'?r.factKey:null,value:r.kind==='quantity'?r.value:null,
    currency:r.kind==='quantity'?r.currency:null,unit:r.kind==='quantity'?r.unit:null,
    period:r.kind==='quantity'?r.period:null,basis:r.kind==='quantity'?r.basis:null,
    occurredAt:r.kind==='quantity'?normalizedInstant(r.occurredAt):null,
    availableAt:r.kind==='quantity'?normalizedInstant(r.availableAt):null};
  if(Object.values(fields).some(v=>v===undefined))throw Error('INDEPENDENT_MAPPING_MEANING_FIELD_ABSENT');
  return fields;
}
export const mappingIdentity=(sourceId:string,recordId:string,sha256:string)=>JSON.stringify([sourceId,recordId,sha256]);
export const dutyIdentity=(sourceId:string,recordId:string,ruleId:string)=>JSON.stringify([sourceId,recordId,ruleId]);
export function obligationMeaning(input:{sourceId:string;recordId:string;ruleId:string;canonicalRef:string;
  operation:string;principalId:string;deadlineAt:string;businessFields:Record<string,unknown>}){
  return {schema:'finnor.x1.qualification-obligation-meaning.v1',sourceId:input.sourceId,recordId:input.recordId,
    ruleId:input.ruleId,canonicalRef:input.canonicalRef,operation:input.operation,principalId:input.principalId,
    deadlineAt:normalizedInstant(input.deadlineAt),businessFields:input.businessFields};
}
export function normalizeCanonicalFields(fields:Record<string,unknown>){
  return Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,
    /(?:_at|At)$/.test(key)&&value!==null?normalizedInstant(value):value]));
}
/** Closed three-operation canonical creation contract. Business inputs required. */
export function nativeCreationMeaning(operation:string,payload:Record<string,unknown>){
  const text=(value:unknown)=>typeof value==='string'?value.trim():value;
  const owner=payload.owner as {partyType?:unknown;partyId?:unknown}|undefined;
  const shared={deal_id:payload.dealId,owner_party_type:owner?.partyType,owner_party_id:owner?.partyId,archived_at:null};
  const fields=operation==='create_deal_request'?{...shared,workstream_id:payload.workstreamId,
    requested_from_deal_party_id:payload.requestedFromDealPartyId,request_text:text(payload.requestText),
    requested_at:normalizedInstant(payload.requestedAt),due_at:normalizedInstant(payload.dueAt),
    requires_accepted_deliverable:payload.requiresAcceptedDeliverable,state:'open',acknowledged_at:null,fulfilled_at:null,cancelled_at:null}
    :operation==='open_workstream'?{...shared,kind:payload.kind,name:text(payload.name),state:'not_started',completed_at:null,cancelled_at:null}
    :operation==='record_finding'?{...shared,workstream_id:payload.workstreamId,related_request_id:payload.relatedRequestId??null,
      related_deliverable_id:payload.relatedDeliverableId??null,statement:text(payload.statement),severity:payload.severity,
      materiality:payload.materiality,required_for_workstream_completion:payload.requiredForWorkstreamCompletion,
      state:'open',disposition:null,resolved_at:null,accepted_at:null,superseded_at:null}:null;
  if(!fields||Object.values(fields).some(v=>v===undefined)||!shared.deal_id||!shared.owner_party_id
    ||!['employee','team'].includes(String(shared.owner_party_type)))throw Error('INDEPENDENT_NATIVE_CREATION_FIELDS_REQUIRED');
  return fields;
}

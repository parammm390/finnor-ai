import {redactStructured} from '@finnor/security';
import {ExactQuantitySchema,FinancialSemanticsSchema} from '@finnor/shared-types';
import {decimal} from '@finnor/underwriting';
import {AcquisitionRequestSchema} from '../../private-equity/src/acquisition/contracts';
import {ReviewedAcquisitionRequestSchema} from '../../private-equity/src/acquisition/reviewed-request';

const record=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value)&&!(value instanceof Date);
const numericUnits=new Set(['money','currency','rate','ratio','multiple','count']);

function financialNumber(original:unknown,safe:unknown):unknown{
 if(typeof original!=='string')return safe;
 try{decimal(original);return original;}catch{return safe;}
}

function restoreFinancialNumbers(original:unknown,safe:unknown):unknown{
 if(Array.isArray(original)&&Array.isArray(safe))return original.map((value,index)=>restoreFinancialNumbers(value,safe[index]));
 if(!record(original)||!record(safe))return safe;
 const result=Object.fromEntries(Object.entries(safe).map(([key,value])=>[key,restoreFinancialNumbers(original[key],value)]));
 if(original.valueType==='decimal'&&typeof original.nodeId==='string'&&numericUnits.has(String(original.unit))
   &&(original.unit!=='money'||typeof original.currency==='string'&&/^[A-Z]{3}$/.test(original.currency))){
  if(original.shape==='scalar')result.value=financialNumber(original.value,result.value);
  if(original.shape==='series'&&record(original.value)&&record(result.value)){
   for(const [period,value]of Object.entries(original.value))if(/^FY\d{4}(?:-Q[1-4]|-M(?:0[1-9]|1[0-2]))?$/.test(period))result.value[period]=financialNumber(value,result.value[period]);
  }
 }
 if('numerator'in original&&'denominator'in original&&ExactQuantitySchema.safeParse(original).success){
  result.numerator=financialNumber(original.numerator,result.numerator);
  result.denominator=financialNumber(original.denominator,result.denominator);
 }
 if(record(original.semantics)&&FinancialSemanticsSchema.safeParse(original.semantics).success){
  if('value'in original)result.value=financialNumber(original.value,result.value);
  if('rawValue'in original)result.rawValue=financialNumber(original.rawValue,result.rawValue);
 }
 if('bidDomain'in original&&'baseRunId'in original&&AcquisitionRequestSchema.safeParse(original).success){
  const domain=original.bidDomain as {values:string[]},safeDomain=result.bidDomain as {values:unknown[]};
  safeDomain.values=domain.values.map((value,index)=>financialNumber(value,safeDomain.values[index]));
  const cases=original.financingCases as Array<{overrides:Array<{value:string}>}>,safeCases=result.financingCases as Array<{overrides:Array<{value:unknown}>}>;
  cases.forEach((financing,index)=>financing.overrides.forEach((override,offset)=>{safeCases[index]!.overrides[offset]!.value=financialNumber(override.value,safeCases[index]!.overrides[offset]!.value);}));
  const constraints=original.constraints as Array<{threshold:string}>,safeConstraints=result.constraints as Array<{threshold:unknown}>;
  constraints.forEach((constraint,index)=>{safeConstraints[index]!.threshold=financialNumber(constraint.threshold,safeConstraints[index]!.threshold);});
 }
 if(original.schema==='finnor.acquisition-decision.v1'){
  if(record(original.maximumBid)&&record(result.maximumBid))result.maximumBid.value=financialNumber(original.maximumBid.value,result.maximumBid.value);
  if(Array.isArray(original.candidates)&&Array.isArray(result.candidates))original.candidates.forEach((candidate,index)=>{
   const target=(result.candidates as unknown[])[index];if(record(candidate)&&record(target))target.bid=financialNumber(candidate.bid,target.bid);
  });
 }
 return result;
}

/** Financial types in model-authored history do not establish financial truth. */
export function redactFinancialInspection<T>(value:T):T{
 const safe=redactStructured(value);
 if(record(value)&&record(safe)){
  const target:Record<string,unknown>=safe;
  for(const field of ['privateEquityIcBasis','businessState'])if(field in value)target[field]=restoreFinancialNumbers(value[field],target[field]);
  const reviewed=value.reviewedAcquisition,safeReviewed=target.reviewedAcquisition;
  if(record(reviewed)&&record(safeReviewed)&&record(reviewed.request)&&record(safeReviewed.request)&&ReviewedAcquisitionRequestSchema.safeParse(reviewed.request).success){
   const request=reviewed.request,safeRequest=safeReviewed.request;
   safeRequest.primary=restoreFinancialNumbers(request.primary,safeRequest.primary);
   const acceptance=record(reviewed.acceptance)?reviewed.acceptance:{};
   const originalDomain=record(request.acquisition)?request.acquisition:{},safeDomain=record(safeRequest.acquisition)?safeRequest.acquisition:{};
   const domain=restoreFinancialNumbers({...originalDomain,dealId:request.dealId,workId:acceptance.workId,baseRunId:request.dealId,idempotencyKey:'reviewed-original-financial-projection'},
    {...safeDomain,dealId:request.dealId,workId:acceptance.workId,baseRunId:request.dealId,idempotencyKey:'reviewed-original-financial-projection'});
   if(record(domain)){const {dealId:_deal,workId:_work,baseRunId:_base,idempotencyKey:_key,...financial}=domain;safeRequest.acquisition=financial;}
   if(record(request.underwriting)&&record(safeRequest.underwriting)&&record(request.underwriting.explicitInputs)&&record(safeRequest.underwriting.explicitInputs)&&record(reviewed.inputTypes)){
    for(const [id,input]of Object.entries(request.underwriting.explicitInputs)){
     const type=reviewed.inputTypes[id],safeInput=safeRequest.underwriting.explicitInputs[id];
     if(record(type)&&record(input)&&record(safeInput)){
      const restored=restoreFinancialNumbers({...type,value:input.value},{...type,value:safeInput.value});
      if(record(restored))safeInput.value=restored.value;
     }
    }
   }
  }
 }
 return safe;
}

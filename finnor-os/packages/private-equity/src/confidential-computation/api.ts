import {performance} from 'node:perf_hooks';
import {withDatabaseExecutionDeadline} from '@finnor/db';
import type {PeMutationContext} from '../types';
import {IntakeSchema,SourceHandleSchema,PlanSchema,SubmitSchema,ReadSchema,ListSchema,ConsentSchema,RevokeSchema,ControlSchema,CommitmentSchema,ImportSchema,ConsumeSchema,ControlConsumeSchema,AllocationConsumeSchema,ObligationConsumeSchema,fail} from './contracts';
import {receiveConfidentialWork,selectConfidentialPlan} from './plan';
import {issueConfidentialSourceHandle,submitConfidential,readConfidential,listConfidential,consentConfidential,revokeConfidential,
 prepareConfidential,commitConfidential,importConfidentialRelease,controlConfidential} from './service';
import {consumeConfidentialUnderwriting} from './consumer';
import {consumeConfidentialControl,consumeConfidentialAllocation,consumeConfidentialObligation} from './owner-consumer';
import {S8ProposalSchema,S8CurrentSchema,proposeConfidentialAdmission,readConfidentialAdmission} from './admission';

export const CONFIDENTIAL_OPERATION_SCHEMAS={
 'confidential-intake':IntakeSchema,'confidential-source-handle':SourceHandleSchema,
 'confidential-plan':PlanSchema,
 'confidential-submit':SubmitSchema,'confidential-read':ReadSchema,'confidential-list':ListSchema,
 'confidential-consent':ConsentSchema,'confidential-revoke':RevokeSchema,'confidential-prepare':ReadSchema,
 'confidential-commit':CommitmentSchema,'confidential-import-release':ImportSchema,
 'confidential-cancel':ControlSchema,'confidential-invalidate':ControlSchema,
 'confidential-retry':ControlSchema,'confidential-reconcile':ControlSchema,'confidential-underwriting':ConsumeSchema,
 'confidential-control-choice':ControlConsumeSchema,'confidential-allocation':AllocationConsumeSchema,
 'confidential-obligation':ObligationConsumeSchema,
 'confidential-s8-propose':S8ProposalSchema,'confidential-s8-current':S8CurrentSchema,
};
export const CONFIDENTIAL_OPERATIONS=[
 'confidential-intake','confidential-source-handle',
 'confidential-plan',
 'confidential-submit','confidential-read','confidential-list','confidential-consent','confidential-revoke',
 'confidential-prepare','confidential-commit','confidential-import-release','confidential-cancel',
 'confidential-invalidate','confidential-retry','confidential-reconcile','confidential-underwriting',
 'confidential-control-choice','confidential-allocation','confidential-obligation',
 'confidential-s8-propose','confidential-s8-current',
] as const;
const operations:Record<keyof typeof CONFIDENTIAL_OPERATION_SCHEMAS,(ctx:PeMutationContext,v:unknown)=>Promise<unknown>>={
 'confidential-intake':receiveConfidentialWork,'confidential-source-handle':issueConfidentialSourceHandle,
 'confidential-plan':selectConfidentialPlan,
 'confidential-submit':submitConfidential,'confidential-read':readConfidential,'confidential-list':listConfidential,
 'confidential-consent':consentConfidential,'confidential-revoke':revokeConfidential,'confidential-prepare':prepareConfidential,
 'confidential-commit':commitConfidential,'confidential-import-release':importConfidentialRelease,
 'confidential-cancel':(ctx,v)=>controlConfidential(ctx,v,'CANCEL'),
 'confidential-invalidate':(ctx,v)=>controlConfidential(ctx,v,'INVALIDATE'),
 'confidential-retry':(ctx,v)=>controlConfidential(ctx,v,'RETRY'),
 'confidential-reconcile':(ctx,v)=>controlConfidential(ctx,v,'RECONCILE'),
 'confidential-underwriting':consumeConfidentialUnderwriting,
 'confidential-control-choice':consumeConfidentialControl,'confidential-allocation':consumeConfidentialAllocation,
 'confidential-obligation':consumeConfidentialObligation,
 'confidential-s8-propose':proposeConfidentialAdmission,'confidential-s8-current':readConfidentialAdmission,
};
export async function handleConfidentialOperation(ctx:PeMutationContext,operation:string,value:unknown){
 if(!Object.hasOwn(operations,operation))fail('Y4_OPERATION_NOT_FOUND',404);
 if(!['confidential-read','confidential-list'].includes(operation)
  &&(process.env.FINNOR_ENVIRONMENT==='production'||process.env.NODE_ENV==='production'
   &&!['development','ordinary_disposable'].includes(process.env.FINNOR_ENVIRONMENT??'')))fail('Y4_PRODUCTION_UNADMITTED',403);
 return withDatabaseExecutionDeadline(performance.now()+20000,async()=>{
  const body=await operations[operation as keyof typeof operations](ctx,value);
  if(Buffer.byteLength(JSON.stringify(body))>4*1024*1024)fail('Y4_RESPONSE_BOUND',413);
  return {body,status:['confidential-submit','confidential-retry','confidential-reconcile'].includes(operation)?202:200};
 });
}

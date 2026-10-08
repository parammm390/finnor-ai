import {z} from 'zod';
import type {ExperimentRef} from '@finnor/shared-types';
import type {HarnessValue} from '../program-synthesis/contracts';
export const P2_VERSION='p2-compute-search-v1';
const ref=z.object({owner:z.string().min(1).max(64),id:z.string().min(1).max(256),version:z.string().min(1).max(80),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export const ComputeSearchRequestSchema=z.object({
 schema:z.literal('finnor.compute-search-request.v1'),programId:z.string().uuid(),policyRequest:ref,computeGrant:ref,
 idempotencyKey:z.string().min(1).max(200),mode:z.enum(['ordinary_disposable','protected']),
 strategy:z.enum(['ADAPTIVE','FIXED_SEQUENTIAL','FIXED_WIDE']).default('ADAPTIVE'),
 limits:z.object({maxUnits:z.number().int().min(2).max(8),maxParallel:z.number().int().min(1).max(2)}).strict(),
 requestedKinds:z.array(z.literal('MODEL_REFINE')).max(1).default([]),routeIds:z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)).max(4).default([]),
 deliberation:z.object({moduleRef:ref,valueEvidenceRef:ref.nullable(),sourceInspectionRef:z.object({sourceId:z.string().uuid(),versionId:z.string().uuid(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().nullable()}).strict().optional(),
}).strict();
export type ComputeSearchRequest=z.infer<typeof ComputeSearchRequestSchema>;
export const SearchIdSchema=z.object({searchId:z.string().uuid()}).strict();
// Existing callers retain the complete projection. The optional method owner
// narrows discovery only; it confers no owner, grant or execution authority.
export const SearchProjectionSchema=z.object({root:z.object({entityType:z.string(),entityId:z.string().uuid()}).strict(),workId:z.string().uuid(),methodOwner:z.enum(['P2','M2']).optional()}).strict();
export function boundedDecode(value:unknown):void {
 if(Buffer.byteLength(JSON.stringify(value))>65536)throw Error('P2_REQUEST_BYTE_BOUND');
 let nodes=0;const seen=new Set<object>();
 function walk(v:unknown,depth:number):void {if(++nodes>4096||depth>24)throw Error('P2_REQUEST_EXPANSION_BOUND');if(v&&typeof v==='object'){if(seen.has(v))throw Error('P2_REQUEST_CYCLE');seen.add(v);for(const c of Object.values(v))walk(c,depth+1);seen.delete(v);}}
 walk(value,0);
}
export type UnitKind='EXECUTE_P1'|'VERIFY_P1'|'MODEL_REFINE'|'INSPECT_SOURCE'|'CONTROL_M2';
export type SearchStatus='ACCEPTED'|'RUNNING'|'WAITING'|'STOPPED'|'FAILED'|'CANCELLED'|'INVALIDATED';
export interface SearchRow {id:string;tenant_id:string;principal_id:string;program_id:string;generation:number;status:SearchStatus;request:ComputeSearchRequest;request_digest:string;binding:any;context:any|null;head_id:string|null;revision:number;reason:string|null}
export interface UnitRow {id:string;tenant_id:string;principal_id:string;search_id:string;generation:number;kind:UnitKind;status:string;body:{moduleId?:string;prerequisites:string[];mechanism:string;sourceDigest:string;inputDigest:string;routeIds:string[];logicalControlRevision?:number;controlStateDigest?:string;controlContinuation?:number};digest:string;result:any|null;result_digest:string|null;claim_token:string|null;claim_fence:number|null;job_id:string|null;attempts:number}
export interface CheckedIncumbent {moduleId:string;values:Record<string,HarnessValue>;checks:any[];unitId:string;sourceResultDigest:string;inputDigest:string;acceptanceDigest:string}
export interface ComputeSearchPlan {
 schema:'finnor.compute-search-plan.v1';id:string;version:typeof P2_VERSION;revision:number;status:SearchStatus;
 work:{id:string;revision:string;inputDigest:string;planRevisionId:string};programId:string;
 policyRequest:ExperimentRef;computeGrant:ExperimentRef;frontier:unknown[];next:unknown[];
 quotaProfile:unknown[];incumbent:CheckedIncumbent|null;
 stop:{heuristic:boolean;reason:string|null;certifiedGap?:never;lossUnit:string;remainingPredicates:string[]};
 outstanding:unknown[];costs:{usd:null;status:'UNMETERED';physicalAttempts:number;nativeAttempts:number;modelAttempts:number;recoveryAttempts:number;usage:unknown[];parent:unknown;accountingScope:string};
 bottleneck:unknown;topology:unknown;bindings:unknown;qualifications:string[];
 deliberationPolicyRef?:ExperimentRef;
}

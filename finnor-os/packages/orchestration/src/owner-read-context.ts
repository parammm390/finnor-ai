import type {OperationalQueryRequest} from '@finnor/shared-types';
import {sha256 as planningHash} from '@finnor/planning';

const record=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};

export function observedOwnerRead(request:OperationalQueryRequest,value:unknown,objectiveRevision:number){
 if(!['primary_diligence_v1','acquisition_decision_v1'].includes(request.intent))return undefined;
 const result=record(value),execution=record(result.execution),data=record(result.data);
 if(!execution.id||!execution.workInputId||execution.status!=='succeeded')return undefined;
 const allFindings=Array.isArray(data.findings)?data.findings:[];
 let projectionComplete=result.truncated===false&&allFindings.length<=16;
 const findings=allFindings.slice(0,16).map(value=>{
  const f=record(value),coverage=record(f.observedPopulationAndCoverage),freshness=record(f.freshnessAndReacquisitionConditions);
  return {artifactId:f.artifactId,assertionRef:f.assertionRef,contentDigest:f.contentDigest,conclusion:f.conclusion,
   coverageComplete:coverage.coverageComplete,expiresAt:freshness.expiresAt,
   materialGapCount:Array.isArray(f.unobservedRemainderAndMaterialGaps)?f.unobservedRemainderAndMaterialGaps.length:null};
 });
 const compact={programmeId:data.programmeId,decisionId:data.decisionId,workId:data.workId,workRevision:data.workRevision,
  status:data.status,reason:data.reason,completionEvent:data.completionEvent,deadlineAt:data.deadlineAt,
  ...(request.intent==='primary_diligence_v1'?{findings}:{}),
  ...(request.intent==='acquisition_decision_v1'?{completeSearch:record(data.result).completeSearch}:{}),
 };
 if(JSON.stringify(compact).length>18_000)projectionComplete=false;
 return {schema:'finnor.observed-owner-read.v1',intent:request.intent,request,queryExecutionId:execution.id,
  workInputId:execution.workInputId,objectiveRevision,observedAt:result.asOf,projectionComplete,
  data:projectionComplete?compact:{status:data.status,programmeId:data.programmeId,decisionId:data.decisionId,continuationRequired:true},
  currentness:'OBSERVED_ONLY_NATIVE_OWNER_REVALIDATES_BEFORE_CONSUMPTION'};
}

export function ownerReadContext(params:{steps:unknown[];queries:unknown[];workId:string;workInputId:string;objectiveRevision:number}){
 const queries=new Map(params.queries.map(v=>{const q=record(v);return [q.id,q];})),seen=new Set<string>(),result:unknown[]=[];
 const steps=params.steps.map(record).sort((a,b)=>Number(b.stepNumber)-Number(a.stepNumber));
 for(const step of steps){
  const read=record(record(step.observation).ownerRead),query=queries.get(step.queryExecutionId);
  if(!step.completedAt||step.objectiveRevision!==params.objectiveRevision||read.schema!=='finnor.observed-owner-read.v1'
   ||read.queryExecutionId!==step.queryExecutionId||read.objectiveRevision!==params.objectiveRevision||read.workInputId!==params.workInputId
   ||!query||query.status!=='succeeded'||query.workId!==params.workId||query.workInputId!==params.workInputId
   ||planningHash(query.request)!==planningHash(read.request))continue;
  const data=record(read.data),key=String(read.intent)+':'+String(data.programmeId??data.decisionId??'workspace');
  if(seen.has(key))continue;seen.add(key);result.push(read);
  if(result.length===4)break;
 }
 return result;
}

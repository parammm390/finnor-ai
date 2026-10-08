import type {PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import type {PeMutationContext} from '../types';
import type {SearchRow,UnitRow,ComputeSearchPlan} from '../compute-search/contracts';
import type {ProgramRow} from '../program-synthesis/store';
import {requestRow} from '../program-synthesis/store';
import {units,incumbentOf} from '../compute-search/store';
import {sha,stable,tx,authorize,principal,unavailable} from '../evidence-execution/store';
import {currentModule} from './module';
import {DeliberationPolicySchema,DeliberationModuleReaderSchema,MissingOwnerRequestSchema,M2_VERSION,ModuleSnapshotSchema,ModuleValueModelSchema,ModuleRunReceiptSchema,RefSchema,type ModuleSnapshot} from './contracts';
import {ESTIMATOR_CONFIG} from './calibration';
import {PENDING_PRODUCER_PORTS} from './ports';
const ref=(prefix:string,body:unknown,version:string)=>{const contentDigest=sha(body);return {owner:'M2',id:prefix+':'+contentDigest,version,contentDigest};};
/** Exact permissioned immutable source reader, shared by calibration/inspection.
 * This port reads real S1 source bytes; it never creates an evidence receipt. */
export async function readSourceObject(ctx:PeMutationContext,root:any,sourceId:string,versionId:string,c?:PoolClient){
 await authorize(ctx,root,[],[sourceId]);
 const read=async(client:PoolClient)=>{const v=(await client.query<any>('SELECT v.id,v.source_id,v.content,v.content_hash,v.snapshot,v.as_of,v.retrieved_at,v.version_number,(SELECT max(h.version_number) FROM finnor_os.evidence_source_versions h WHERE h.source_id=v.source_id AND h.tenant_id=v.tenant_id) latest FROM finnor_os.evidence_source_versions v WHERE v.tenant_id=$1 AND v.scope=\'tenant\' AND v.source_id=$2 AND v.id=$3',[ctx.auth.tenantId,sourceId,versionId])).rows[0];
  if(!v||stable(v.snapshot?.worldRoot)!==stable(root))throw unavailable();
  if(Number(v.latest)!==Number(v.version_number))throw Error('M2_SOURCE_OBJECT_CURRENTNESS_CHANGED');
  if(Buffer.byteLength(v.content)>262144||sha(v.content)!==v.content_hash)throw Error('M2_SOURCE_OBJECT_BYTE_BOUND_OR_DIGEST');
  return v;};
 return c?read(c):tx(ctx,read,true);
}
export async function readCalibration(ctx:PeMutationContext,raw:unknown,root:any,objectiveRef:any,workId:string,policyRef:any,c?:PoolClient){
 const r=RefSchema.parse(raw);if(r.owner!=='M2'||r.version!=='m2-calibration-v1'||r.id!=='m2-calibration:'+r.contentDigest)throw unavailable();
 const read=async(client:PoolClient)=>(await client.query('SELECT body,digest,source_id,version_id FROM finnor_os.m2_calibration_reports WHERE tenant_id=$1 AND principal_id=$2 AND digest=$3',[ctx.auth.tenantId,principal(ctx),r.contentDigest])).rows[0];
 const entry=c?await read(c):await tx(ctx,read,true);
 if(!entry||sha(entry.body)!==entry.digest||stable(entry.body.root)!==stable(root)||stable(entry.body.report.objectiveRef)!==stable(objectiveRef)||entry.body.workId!==workId||stable(entry.body.policyRequest)!==stable(policyRef))throw unavailable();
 if(Date.parse(entry.body.validUntil)<=Date.now()||entry.body.report.configDigest!==sha(ESTIMATOR_CONFIG))throw Error('M2_FROZEN_VALUE_MODEL_EXPIRED_OR_CONFIG_CHANGED');
 const source=await readSourceObject(ctx,root,entry.source_id,entry.version_id,c);if(sha(source.snapshot.dataset)!==entry.body.report.datasetDigest)throw Error('M2_VALUE_DATASET_CURRENTNESS_CHANGED');
 return entry.body;
}
export async function validateDeliberationBinding(ctx:PeMutationContext,q:ProgramRow,request:any){
 if(!request.deliberation)return;
 const module=currentModule();if(stable(module.ref)!==stable(request.deliberation.moduleRef))throw Error('M2_ACTUAL_REGISTERED_MODULE_REQUIRED');
 if(request.deliberation.valueEvidenceRef){const policy=await (await import('../enterprise-control')).readEnterpriseContingentPolicy(ctx,request.policyRequest);await readCalibration(ctx,request.deliberation.valueEvidenceRef,q.request.root,policy.mandate.utilityRef,q.work_id,request.policyRequest);}
 if(request.deliberation.sourceInspectionRef){const v=request.deliberation.sourceInspectionRef,source=await readSourceObject(ctx,q.request.root,v.sourceId,v.versionId);if(source.content_hash!==v.contentDigest)throw Error('M2_EXACT_SOURCE_OBJECT_DIGEST_REQUIRED');}
}
export async function readStoredModule(ctx:PeMutationContext,s:SearchRow,c?:PoolClient){
 const reference=s.request.deliberation?.moduleRef;if(!reference)throw unavailable();
 const read=async(client:PoolClient)=>{
  const row=(await client.query('SELECT body,digest FROM finnor_os.m2_modules WHERE tenant_id=$1 AND principal_id=$2 AND digest=$3',[s.tenant_id,s.principal_id,reference.contentDigest])).rows[0];
  if(!row)throw unavailable();
  if(sha(row.body)!==row.digest||row.digest!==reference.contentDigest||sha(row.body.source)!==row.body.sourceDigest||sha(row.body.emitted)!==row.body.emittedDigest)throw Error('M2_STORED_MODULE_DIGEST_MISMATCH');
  return DeliberationModuleReaderSchema.parse({ref:reference,body:row.body});
 };
 return c?read(c):tx(ctx,read,true);
}
export async function controlSnapshot(ctx:PeMutationContext,s:SearchRow,c:PoolClient):Promise<ModuleSnapshot>{
 const q=await requestRow(ctx,s.program_id,c),frontier=(await units(ctx,s,c)).filter(u=>u.kind!=='CONTROL_M2');
 const episode=(await c.query('SELECT max_attempts-attempts_used remaining,extract(epoch FROM(deadline_at-clock_timestamp()))*1000 remaining_ms FROM finnor_os.p1_episodes WHERE tenant_id=$1 AND principal_id=$2 AND id=$3',[s.tenant_id,s.principal_id,q.episode_id])).rows[0];
 if(!episode)throw Error('M2_ORIGINAL_PARENT_EPISODE_REQUIRED');
 const grant=(await c.query('SELECT spent FROM finnor_os.p2_grant_usage WHERE tenant_id=$1 AND principal_id=$2 AND grant_digest=$3 AND resource_id=$4',[s.tenant_id,s.principal_id,s.request.computeGrant.contentDigest,s.binding.resourceId])).rows[0];
 const conversion=s.binding.deliberationConversion;
 let valueModel=null;
 if(s.request.deliberation?.valueEvidenceRef){
  const evidence=await readCalibration(ctx,s.request.deliberation.valueEvidenceRef,q.request.root,s.binding.utilityRef,q.work_id,s.request.policyRequest,c);
  // Only the frozen fit/calibration parameters enter execution. Held-out rows
  // and outcomes are deliberately excluded from the module's input.
  const mechanisms=['EXECUTE_CHECK_CHAIN','UNVERIFIED_EXECUTION'] as const;
  const bins=mechanisms.flatMap(mechanism=>{
   const fit=evidence.report.bins.find((b:any)=>b.key==='mechanics|finite-local|'+mechanism+'|P1_NATIVE');
   return fit?[{key:fit.key,mechanism,beforeLoss:fit.beforeLoss,predictedGain:fit.predictedGain,completionProbability:fit.completionProbability,acceptanceProbability:fit.acceptanceProbability,meanElapsedMs:fit.meanElapsedMs,qualifiedPublicDiagnostic:fit.qualifiedPublicDiagnostic,population:fit.population,calibrationPopulation:fit.calibrationPopulation,intervals:fit.intervals}]:[];
  });
  valueModel=ModuleValueModelSchema.parse({ref:s.request.deliberation.valueEvidenceRef,datasetDigest:evidence.report.datasetDigest,configDigest:evidence.report.configDigest,estimatorVersion:evidence.report.version,objectiveRef:evidence.report.objectiveRef,lossUnit:evidence.report.lossUnit,scope:evidence.report.scope,fieldRoutingAdmitted:false,bins});
 }
 const times=(await c.query('SELECT u.kind,avg((a.body->>\'elapsedMs\')::numeric)::float8 duration FROM finnor_os.p2_attempts a JOIN finnor_os.p2_units u ON u.id=a.unit_id AND u.tenant_id=a.tenant_id AND u.principal_id=a.principal_id WHERE a.tenant_id=$1 AND a.principal_id=$2 AND a.search_id=$3 AND a.body ? \'elapsedMs\' GROUP BY u.kind',[s.tenant_id,s.principal_id,s.id])).rows;
 return ModuleSnapshotSchema.parse({units:frontier.map(u=>({id:u.id,kind:u.kind,status:u.status,prerequisites:u.body.prerequisites,mechanism:u.body.mechanism,steps:s.context?.program.modules.find((m:any)=>m.id===u.body.moduleId)?.bounds.steps??1,durationMs:times.find(t=>t.kind===u.kind)?.duration??null,correlationGroup:sha({source:u.body.sourceDigest,acceptance:s.context?.acceptanceDigest,utility:s.binding.utilityRef})})),
  incumbentQualified:!!incumbentOf(s,frontier),lossGap:conversion?conversion.lossWithoutQualifiedResult-conversion.lossWithQualifiedResult:null,nativeAttemptCost:conversion?.nativeAttemptCost??null,delayMsCost:conversion?.delayMsCost??null,valueModel,
  // Reserve one original parent attempt for P1's final checked artifact. It is
  // not a new grant and cannot be used by a controller/child.
  remainingAttempts:Math.max(0,Math.min(Number(episode.remaining)-1,s.binding.capacity-Number(grant?.spent??0))),remainingMs:Number(episode.remaining_ms),maxParallel:s.request.limits.maxParallel,strategy:s.request.strategy,active:frontier.filter(u=>['QUEUED','RUNNING'].includes(u.status)).length,sourceObligation:!!s.request.deliberation?.sourceInspectionRef,sourcePremiseChanged:frontier.some(u=>u.kind==='INSPECT_SOURCE'&&u.status==='COMPLETED'&&u.result?.changesPremise===true),unknownAttempt:frontier.some(u=>u.status==='UNKNOWN')});
}
/** State commitment ignores clock and the controller's own just-spent attempt.
 * P2 rechecks remaining counters and all exact owner/source/fence predicates
 * before applying IDs. A changed result/frontier cannot reuse a proposal. */
export function controlState(input:ModuleSnapshot){const {remainingAttempts,remainingMs,...state}=input;return sha(state);}
/** A logical controller is ongoing. Physical completion and publication, not
 * the logical unit's terminal state, determine whether a proposal is usable.
 * Historical receipts without a proven attempt remain cost evidence only. */
async function moduleRuns(ctx:PeMutationContext,s:SearchRow,c:PoolClient){
 const module=await readStoredModule(ctx,s,c);
 const rows=(await c.query<any>(`SELECT r.id,r.unit_id,r.attempt_id,r.body,r.digest,
   a.id actual_attempt_id,a.unit_id attempt_unit_id,a.status attempt_status,
   a.body attempt_body,a.digest attempt_digest,a.delivery_id,a.claim_fence,
   parent.episode_id parent_episode,parent.proposed->'bounds'->>'deadlineAt' parent_deadline
  FROM finnor_os.m2_module_runs r
   JOIN finnor_os.p2_requests search ON search.tenant_id=r.tenant_id
    AND search.principal_id=r.principal_id AND search.id=r.search_id
   JOIN finnor_os.p1_requests parent ON parent.tenant_id=search.tenant_id
    AND parent.principal_id=search.principal_id AND parent.id=search.program_id
   LEFT JOIN finnor_os.p2_attempts a
   ON a.tenant_id=r.tenant_id AND a.principal_id=r.principal_id
    AND a.search_id=r.search_id AND a.unit_id=r.unit_id
    AND (a.id=r.attempt_id OR (r.attempt_id IS NULL
     AND r.body->>'schema'='finnor.m2.module-run.v1' AND a.body->'moduleRun'=r.body))
  WHERE r.tenant_id=$1 AND r.principal_id=$2 AND r.search_id=$3
  ORDER BY r.created_at,r.id LIMIT 33`,[s.tenant_id,s.principal_id,s.id])).rows;
 if(rows.length>32||new Set(rows.map(r=>r.id)).size!==rows.length)throw Error('M2_MODULE_RECEIPT_OR_RUN_BOUND');
 return rows.map(row=>{
  const body=ModuleRunReceiptSchema.parse(row.body);
  if(sha(body)!==row.digest||body.id!==row.id||body.moduleDigest!==module.ref.contentDigest||sha(body.input)!==body.inputDigest||sha(body.output)!==body.outputDigest||body.stepCharge!==body.output.visited||body.configDigest!==sha(module.body.config)||body.compilerDigest!==sha(module.body.compiler)||stable(body.runtime)!==stable(module.body.runtime))throw Error('M2_EXECUTED_MODULE_RECEIPT_DIGEST_MISMATCH');
  if(row.actual_attempt_id&&sha(row.attempt_body)!==row.attempt_digest)throw Error('M2_ACTUAL_CONTROL_ATTEMPT_DIGEST_MISMATCH');
  if(body.schema==='finnor.m2.module-run.v2'){
   const e=body.execution,a=row.attempt_body;
   if(!row.actual_attempt_id||row.attempt_id!==e.attemptId||row.actual_attempt_id!==e.attemptId||row.unit_id!==e.unitId||row.attempt_unit_id!==e.unitId||row.delivery_id!==e.deliveryAttemptId||String(row.claim_fence)!==String(e.claimFence)||a.jobId!==e.jobId||a.deliveryAttemptId!==e.deliveryAttemptId||String(a.claimFence)!==String(e.claimFence)||a.unitId!==e.unitId||a.unitBodyDigest!==e.unitBodyDigest||a.unitInvocation!==e.unitInvocation||a.workKind!=='CONTROL_M2'||a.protocolVersion!==2||a.originalEpisode!==e.originalEpisode||e.originalEpisode!==row.parent_episode||a.originalDeadlineAt!==e.originalDeadlineAt||e.originalDeadlineAt!==row.parent_deadline||module.body.schema!=='finnor.m2.executable-module.v2'||e.controlUnitLifecycle!==module.body.config.controlUnitLifecycle)throw Error('M2_ACTUAL_CONTROL_INVOCATION_BINDING_REQUIRED');
  }
  const published=row.attempt_status==='COMPLETED'&&stable(row.attempt_body.moduleRun)===stable(body);
  if(row.attempt_status==='COMPLETED'&&!published)throw Error('M2_CONTROL_PUBLICATION_RECEIPT_MISMATCH');
  return {body,digest:row.digest,published};
 });
}
const moduleRunRef=(body:ReturnType<typeof ModuleRunReceiptSchema.parse>)=>ref('m2-run',body,body.schema==='finnor.m2.module-run.v2'?'m2-module-run-v2':'m2-module-run-v1');
export async function latestControl(ctx:PeMutationContext,s:SearchRow,c:PoolClient){return (await moduleRuns(ctx,s,c)).filter(r=>r.published).at(-1)?.body??null;}
export async function buildPolicy(ctx:PeMutationContext,s:SearchRow,q:ProgramRow,plan:ComputeSearchPlan,planId:string,c:PoolClient){
 const module=currentModule();if(stable(module.ref)!==stable(s.request.deliberation?.moduleRef))throw Error('M2_POLICY_MODULE_CHANGED');
 await c.query('INSERT INTO finnor_os.m2_modules(tenant_id,principal_id,digest,body) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[s.tenant_id,s.principal_id,module.ref.contentDigest,stable(module.body)]);
 const preparationRef=ref('m2-preparation',module.preparation,'m2-preparation-v1');
 await c.query('INSERT INTO finnor_os.m2_preparations(tenant_id,principal_id,digest,body) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[s.tenant_id,s.principal_id,preparationRef.contentDigest,stable(module.preparation)]);
 const frontier=await units(ctx,s,c),runs=await moduleRuns(ctx,s,c);
 const last=runs.filter(r=>r.published).at(-1)?.body,terminal=['CANCELLED','INVALIDATED','FAILED'].includes(s.status),conversion=s.binding.deliberationConversion??null;
 const premiseChanged=frontier.some(u=>u.kind==='INSPECT_SOURCE'&&u.status==='COMPLETED'&&u.result?.changesPremise===true),incumbent=terminal||premiseChanged?null:incumbentOf(s,frontier),valueRefs:Array<ReturnType<typeof ref>>=[];
 if(last&&!terminal){const body={schema:'finnor.m2.computation-value-evidence.v1',moduleRunRef:moduleRunRef(last),policyRequest:s.request.policyRequest,utilityRef:s.binding.utilityRef,lossUnit:s.binding.loss.unit,conversionRef:conversion?.ref??null,sourceResultDigest:s.context?.sourceResultDigest??null,inputDigest:s.context?.inputDigest??null,chains:last.output.chains,
   fieldRoutingAdmitted:false,predictionSupport:last.input.valueModel?.scope??null,conditionalFiniteGain:conversion?'OWNER_SUPPLIED_SAME_OBJECTIVE_ACCEPTED_OUTPUT_LOSS':'UNKNOWN',estimatorVersion:module.body.estimatorVersion,calibrationRef:s.request.deliberation?.valueEvidenceRef??null,uncertainty:last.input.valueModel?'EMPIRICAL_PUBLIC_RESIDUAL_DIAGNOSTIC_NOT_FIELD_COVERAGE':conversion?'FINITE_CONDITIONAL_GAIN_COMPLETION_UNIDENTIFIED':'UNIDENTIFIED',forwardControllerCallsIncluded:true,marginalConvention:'CURRENT_CONTROL_IS_SUNK_KNOWN_FORWARD_NATIVE_MINIMUM_DOES_NOT_ZERO_UNKNOWN_TIME_DATA_OR_BILLING',remainingDollarPrices:'UNKNOWN',qualification:'CONDITIONAL_FINITE_BOUND_IS_NOT_FIELD_EXPECTED_VALUE_OR_S7_WEALTH'};
  const evidence=ref('m2-value',body,'m2-computation-value-v1');await c.query('INSERT INTO finnor_os.m2_values(tenant_id,principal_id,search_id,digest,body) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING',[s.tenant_id,s.principal_id,s.id,evidence.contentDigest,stable(body)]);valueRefs.push(evidence);
 }
 const qualifiedBound=!terminal&&s.status==='STOPPED'&&conversion&&last?.output.boundUpper===0&&last?.input.incumbentQualified&&incumbent;
 const ownerRequests=[],domain=conversion&&!premiseChanged?'PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS':'ORDINARY_CHECK_BOTTLENECK_HEURISTIC';
 const missing:Array<{owner:string;required:string;actualOwnerPort:string|null;observedContract?:unknown}>=[
  ...(!conversion||premiseChanged?[{owner:'S4',required:premiseChanged?'CURRENT_S4_PREMISE_AND_UTILITY_RECOMPUTATION_WITH_ORIGINAL_S5_ENVELOPE_AND_P1_EPISODE':'CURRENT_S4_OWNER_LOSS_NATIVE_COST_AND_DELAY_CONVERSION',actualOwnerPort:'/api/policies/synthesize'}]:[]),
  {owner:'S2',required:'PERMITTED_INDEPENDENT_BEFORE_AFTER_EVENTUAL_DECISION_LOSS_LABELS_WITH_ASSIGNMENT_SELECTION_CENSORING_AND_S3_TRANSPORT_DOMAIN',actualOwnerPort:null},
  {owner:'S5',required:'CURRENT_MONETARY_RESOURCE_PRICEBOOK_PROVIDER_USAGE_INVOICE_AND_RECONCILED_COST_EVIDENCE_WITHOUT_NATIVE_GRANT_CONVERSION',actualOwnerPort:'/api/allocations/read'},
  {owner:'S6',required:'PROTECTED_EXECUTION_ISOLATION_EGRESS_AND_AGGREGATE_PHYSICAL_RESOURCE_ENFORCEMENT_WITH_CURRENT_AUTHORITY',actualOwnerPort:null},
  {owner:'S8',required:'INDEPENDENT_EVALUATOR_SEAL_NUMERICAL_PROTOCOL_AND_EXACT_M2_METHOD_DOMAIN_ADMISSION',actualOwnerPort:null},
  ...PENDING_PRODUCER_PORTS,
 ];
 const inspected=frontier.find(u=>u.kind==='INSPECT_SOURCE'&&u.status==='COMPLETED'&&u.result?.changesPremise);
 for(const need of missing){const request=MissingOwnerRequestSchema.parse({schema:'finnor.m2.missing-owner-request.v1',...need,observedContract:need.observedContract??null,work:plan.work,policyRequest:s.request.policyRequest,utilityRef:s.binding.utilityRef,mandateRef:s.binding.mandateRef,originalComputeGrant:s.request.computeGrant,resourceRef:s.binding.resourceRef,sourceRef:s.request.deliberation?.sourceInspectionRef??null,sourceResultDigest:s.context?.sourceResultDigest??null,inputDigest:s.context?.inputDigest??null,metacontroller:module.ref,domain,observedObjectDigest:need.owner==='S4'?inspected?.result.objectDigest??null:null,operativeClause:need.owner==='S4'?inspected?.result.operativeClause??null:null,responseRef:null,authorityGranted:false,newFundingRequested:false});
  const reference=ref('m2-owner-request',request,'m2-owner-request-v1');await c.query('INSERT INTO finnor_os.m2_components(tenant_id,principal_id,search_id,digest,kind,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING',[s.tenant_id,s.principal_id,s.id,reference.contentDigest,'owner-request',stable(request)]);ownerRequests.push(reference);
 }
 const remaining=['UNSEEN_FIELD_PREMISES_OUTSIDE_FINITE_OBJECTIVE','INDEPENDENT_SEALED_M2_GATE','ACTUAL_BILLING_AND_PROTECTED_ENVELOPE'];
 if(premiseChanged)remaining.push('MATERIAL_SOURCE_PREMISE_CURRENT_S4_RECOMPUTATION');
 if(!conversion)remaining.push('CURRENT_S4_FINITE_UTILITY_AND_DELAY_CONVERSION');if(!s.request.deliberation?.valueEvidenceRef)remaining.push('PERMITTED_DEVELOPMENT_EVENTUAL_LOSS_CALIBRATION');
 const programmeRef={owner:'P1',id:q.id,version:q.proposed.producer.version,contentDigest:sha(q.proposed)};
 const allAttempts=(await c.query<any>('SELECT id,unit_id,status,body,digest FROM finnor_os.p2_attempts WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 ORDER BY created_at,id',[s.tenant_id,s.principal_id,s.id])).rows;
 const correctionEvents=(await c.query<any>("SELECT id,body,digest FROM finnor_os.p2_events WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND kind LIKE 'PHYSICAL_ATTEMPT_%' ORDER BY created_at,id",[s.tenant_id,s.principal_id,s.id])).rows;
 if(allAttempts.length>32||allAttempts.some(a=>sha(a.body)!==a.digest)||correctionEvents.some(e=>sha(e.body)!==e.digest))throw Error('M2_COMPLETE_COST_HISTORY_DIGEST_OR_BOUND');
 if(s.request.deliberation?.valueEvidenceRef){
  // Invalidation removes private decision contents, not the already incurred
  // preparation time. Read only its digest-checked historical cost receipt.
  const record=(await c.query<any>('SELECT body,digest FROM finnor_os.m2_calibration_reports WHERE tenant_id=$1 AND principal_id=$2 AND digest=$3',[s.tenant_id,s.principal_id,s.request.deliberation.valueEvidenceRef.contentDigest])).rows[0];
  if(record&&sha(record.body)===record.digest){const prep={...record.body.preparation,originRef:s.request.deliberation.valueEvidenceRef};await c.query('INSERT INTO finnor_os.m2_preparations(tenant_id,principal_id,digest,body) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[s.tenant_id,s.principal_id,sha(prep),stable(prep)]);}
 }
 const preparationRows=(await c.query<any>('SELECT body,digest FROM finnor_os.m2_preparations WHERE tenant_id=$1 AND principal_id=$2 AND ((body->\'moduleRef\'->>\'contentDigest\')=$3 OR (body->\'originRef\'->>\'contentDigest\')=$4) ORDER BY created_at,digest LIMIT 33',[s.tenant_id,s.principal_id,module.ref.contentDigest,s.request.deliberation?.valueEvidenceRef?.contentDigest??null])).rows;
 if(preparationRows.length>32||preparationRows.some(p=>sha(p.body)!==p.digest))throw Error('M2_PREPARATION_RECEIPT_BOUND_OR_DIGEST');
 const preparations=preparationRows.map(p=>({ref:ref('m2-preparation',p.body,'m2-preparation-v1'),kind:p.body.kind,elapsedMs:p.body.elapsedMs,cpuMicros:p.body.cpuMicros,costUSD:null,chargedAsEpisodeAttempt:false,accounting:'SHARED_OR_DEVELOPMENT_PREPARATION_NONADDITIVE_NOT_S5_FUNDING'}));
 const equivalent=sha({programmeRef,source:s.context?.sourceResultDigest??null,acceptance:q.proposed.acceptanceDigest,utility:s.binding.utilityRef});
 const nextWork=frontier.filter(u=>['QUEUED','RUNNING'].includes(u.status)&&!terminal).map(u=>{
  const native=s.context?.program.modules.find((m:any)=>m.id===u.body.moduleId),latestAttempt=allAttempts.filter(a=>a.unit_id===u.id).at(-1);
  const chain=last?.output.chains.filter((v:any)=>v.unitIds.includes(u.id)).sort((a:any,b:any)=>(b.expectedNet??b.netUpper??-Infinity)-(a.expectedNet??a.netUpper??-Infinity)||a.unitIds.length-b.unitIds.length)[0];
  const moduleRef=u.kind==='CONTROL_M2'?module.ref:native?{owner:'P1',id:native.id,version:native.runtime.version,contentDigest:sha(native)}:null;
  return {unitId:u.id,kind:u.kind,meaning:u.kind==='CONTROL_M2'?'Execute bounded current frontier/value metacontroller':u.kind==='INSPECT_SOURCE'?'Inspect the exact authorized source object':u.kind==='VERIFY_P1'?'Independently check original numerical acceptance':u.kind==='EXECUTE_P1'?'Execute the authentic compiled P1 candidate':'Propose a distinct structure requiring native execution and independent checking',prerequisites:u.body.prerequisites,owner:'P2',routeIds:u.body.routeIds,
   target:{programmeRef,root:q.request.root,sourceInspectionRef:u.kind==='INSPECT_SOURCE'?s.request.deliberation?.sourceInspectionRef??null:null},
   inputs:{workRevision:q.work_input_id,inputDigest:u.body.inputDigest,sourceResultDigest:u.body.sourceDigest,acceptanceDigest:q.proposed.acceptanceDigest,utilityRef:s.binding.utilityRef,valueEvidenceRef:s.request.deliberation?.valueEvidenceRef??null,moduleRef},
   expectedResult:{kind:u.kind==='CONTROL_M2'?'MODULE_PROPOSAL':u.kind==='INSPECT_SOURCE'?'SOURCE_OBJECT_INSPECTION':u.kind==='EXECUTE_P1'?'NUMERICAL_VALUES':u.kind==='VERIFY_P1'?'INDEPENDENT_ACCEPTANCE_CHECKS':'NATIVE_MODULE_PROPOSAL',outputKeys:q.request.acceptance.targets.map(t=>t.key),qualification:'TYPED_COMPUTATIONAL_RESULT_ORIGINAL_P1_INDEPENDENT_ACCEPTANCE_STILL_REQUIRED'},
   checker:{owner:['CONTROL_M2','INSPECT_SOURCE'].includes(u.kind)?'M2':'P1',method:u.kind==='CONTROL_M2'?'BOUNDED_TYPED_MODULE_PROPOSAL':u.kind==='INSPECT_SOURCE'?'EXACT_SOURCE_ENTITY_PERIOD_UNIT_DIGEST':'POSTGRES_NUMERIC_ACCEPTED_EXPRESSION',acceptanceDigest:q.proposed.acceptanceDigest,independentlyAcceptedRequired:true},
   resources:{episodeId:q.episode_id,deadlineAt:q.proposed.bounds.deadlineAt,maxAttempts:q.proposed.bounds.maxAttempts,maxSteps:q.proposed.bounds.maxSteps,maxCandidates:q.proposed.bounds.maxCandidates,maxUnits:s.request.limits.maxUnits,maxParallel:s.request.limits.maxParallel,selectedUnitSteps:u.kind==='CONTROL_M2'?256:u.kind==='EXECUTE_P1'?(native?.bounds.steps??0)+1:1,currentGrant:s.request.computeGrant,sourcePermissionsRef:s.binding.rightsRef},
   admission:{logicalState:u.status,physicalState:latestAttempt?.status??'NOT_ADMITTED',attemptId:latestAttempt?.id??null,producerAdmission:null,executionAuthorityGranted:false},
   estimate:{lossUnit:s.binding.loss.unit,expectedGain:chain?.expectedGain??null,conditionalGain:chain?.conditionalGain??null,completionProbability:chain?.completionProbability??null,acceptanceProbability:chain?.acceptanceProbability??null,knownNativeCost:chain?.incrementalCost??null,delayLoss:chain?.delayLoss??null,completionDelayMs:chain?.predictedCompletionDelayMs??null,costUSD:null,support:chain?.support==='PUBLIC_MODEL_RELATIVE_DIAGNOSTIC'?'PUBLIC_MODEL_RELATIVE_DIAGNOSTIC':chain?.conditionalGain!==null&&chain?.conditionalGain!==undefined?'FINITE_CONDITIONAL_ONLY':'UNAVAILABLE',evidenceRef:valueRefs[0]??null,nonadditiveChain:true},
   correlation:{premiseDigest:sha({source:u.body.sourceDigest,acceptance:s.context?.acceptanceDigest??q.proposed.acceptanceDigest,utility:s.binding.utilityRef}),equivalenceGroup:equivalent,independentPremises:1,novelty:u.kind==='VERIFY_P1'?'INDEPENDENT_NUMERICAL_CHECK':u.kind==='INSPECT_SOURCE'?'MATERIAL_SOURCE_QUERY':u.kind==='EXECUTE_P1'?'PROCEDURAL_ALTERNATIVE':u.kind==='MODEL_REFINE'?'UNVERIFIED_PROPOSAL':'CONTROLLER_ONLY'},
   lifecycle:{cancelPath:'/api/company-brain/deliberation-cancel',reconcilePath:'/api/company-brain/deliberation-reconcile',retry:'ORIGINAL_EPISODE_ONLY_RECONCILE_UNKNOWN_BEFORE_ANY_RETRY',latePublication:'FENCED_COST_ONLY',newBudgetGranted:false}};
 });
 const id=randomUUID(),body={schema:'finnor.deliberation-policy.v1' as const,version:M2_VERSION,status:s.status,
  envelope:{schema:'finnor.m2.producer-envelope.v1' as const,id,revision:plan.revision,tenantId:s.tenant_id,principalId:s.principal_id,work:plan.work,mandateRef:s.binding.mandateRef,
   parents:[s.request.policyRequest,s.request.computeGrant,programmeRef,module.ref],inputs:[{kind:'P1_ACCEPTANCE',digest:q.proposed.acceptanceDigest,knownAt:q.proposed.knowledgeAt},{kind:'WORK',digest:q.work_input_digest,knownAt:q.proposed.knowledgeAt},...(s.context?[{kind:'P4_CURRENT_SELECTED_SOURCE',digest:s.context.sourceResultDigest,knownAt:q.proposed.knowledgeAt}]:[])],rightsRef:s.binding.rightsRef,ownerRevisionVector:[{owner:'S4',ref:s.request.policyRequest},{owner:'S5',ref:s.request.computeGrant},{owner:'P1',ref:programmeRef}],producerAdmission:null,executionAuthorityGranted:false,
   codeDigest:module.body.producerCodeDigest,runtime:module.body.runtime,actualInvocations:runs.map(r=>moduleRunRef(r.body)),domain,invalidationKeys:(s.context?.dependencies??[]).map((d:any)=>d.key),currentGrant:s.request.computeGrant,costLedger:{owner:'P2',searchId:s.id,physicalAttempts:plan.costs.physicalAttempts,controllerRuns:runs.length,usd:null},state:terminal?s.status==='INVALIDATED'?'INVALIDATED':'FAILED':runs.some(r=>r.published)?'TESTED':'PROPOSED'},
  policyRequest:s.request.policyRequest,computeGrant:s.request.computeGrant,frontier:frontier.map(u=>{const accepted=!terminal&&!premiseChanged&&!!incumbentOf(s,[u]);return {candidateId:u.body.moduleId??u.id,unitId:u.id,kind:u.kind,status:u.status,premiseDigest:sha({source:u.body.sourceDigest,acceptance:s.context?.acceptanceDigest??q.proposed.acceptanceDigest,utility:s.binding.utilityRef}),moduleId:u.body.moduleId??null,prerequisites:u.body.prerequisites,accepted,support:terminal?'COST_ONLY':accepted?'INDEPENDENT_CURRENT_SQL_CHECK':'UNVERIFIED',completion:u.status==='COMPLETED',resultDigest:terminal?null:u.result_digest,programmeRef,businessProgramRef:null,challengeRef:null,candidateRole:u.kind==='CONTROL_M2'?'M2_CONTROLLER':u.kind==='INSPECT_SOURCE'?'SOURCE_OBLIGATION':'P1_PROCEDURE',equivalenceGroup:equivalent,representation:s.context?.program.modules.find((m:any)=>m.id===u.body.moduleId)?.format??null,decisionLoss:{unit:s.binding.loss.unit,lower:!terminal&&!premiseChanged&&conversion?conversion.lossWithQualifiedResult:null,upper:!terminal&&!premiseChanged&&conversion?accepted?conversion.lossWithQualifiedResult:conversion.lossWithoutQualifiedResult:null,kind:!terminal&&!premiseChanged&&conversion?'OWNER_FINITE_ACCEPTED_OUTPUT_INTERVAL':'UNAVAILABLE',provenance:!terminal&&!premiseChanged?conversion?.ref??null:null,fieldValueQualified:false},independentChecks:terminal?[]:u.result?.checks??[],unresolvedPremises:['S4_BUSINESS_FEASIBILITY_AND_FIELD_LOSS_NOT_ESTABLISHED','M3_CAPITALPROGRAM_AND_M4_CHALLENGE_JOIN_PENDING',...(premiseChanged?['MATERIAL_SOURCE_PREMISE_CURRENT_S4_RECOMPUTATION']:[])],remainingCosts:{nativeAttemptsLower:['PENDING','QUEUED'].includes(u.status)?1:0,costUSD:null,delayLoss:null,priceStatus:'UNKNOWN_UNRECONCILED'}};}),
  metacontroller:module.ref,nextWork,marginalValueEvidence:valueRefs,incumbent,
  stop:{heuristic:!qualifiedBound,reason:s.reason,technicalOnly:true,businessSelectionOwner:'S4',bound:qualifiedBound?{upper:0,unit:s.binding.loss.unit,scope:'PUBLIC_FINITE_ACCEPTED_OUTPUT_MECHANICS',allAvailableChainsEnumerated:true,evidenceRef:valueRefs[0]}:null,remainingPredicates:remaining},
  outstandingCosts:{owner:'P2',ledgerSearchId:s.id,retained:true,usd:null,status:'UNKNOWN_UNRECONCILED',physicalAttempts:plan.costs.physicalAttempts,controllerRuns:runs.length,controllerElapsedMs:runs.reduce((n,r)=>n+r.body.elapsedMs,0),controllerCpuMicros:runs.reduce((n,r)=>n+r.body.cpuMicros,0),sunkUtilityCost:conversion?plan.costs.physicalAttempts*conversion.nativeAttemptCost+runs.reduce((n,r)=>n+r.body.elapsedMs,0)*conversion.controllerMsCost:null,sunkChargedAgain:false,attempts:plan.outstanding,
   history:allAttempts.map(a=>({attemptId:a.id,unitId:a.unit_id,status:a.status,receiptDigest:a.digest,chargedNativeAttempts:a.body.chargedNativeAttempts,steps:a.body.steps,requestedRoute:a.body.requestedRoute,requestedModel:a.body.requestedModel??null,actualProvider:a.body.actualProvider??null,actualModel:a.body.actualModel??null,usage:a.body.usage??null,elapsedMs:a.body.elapsedMs??null,submittedAt:a.body.submittedAt??null,physicalOutcome:a.body.physicalOutcome??(a.status==='COMPLETED'?'RETURNED':null),responsibility:['INTENT','SUBMITTED'].includes(a.status)?'AWAIT_RETURN':a.status==='UNKNOWN'?'RECONCILE_UNKNOWN':'RETAIN_USAGE_AND_RECONCILE_BILLING',liabilityRetained:true,refundGranted:false,costUSD:null,invoiceRef:null,corrections:correctionEvents.filter(e=>e.body.attemptId===a.id).map(e=>({owner:'P2',id:'p2-event:'+e.id,version:'p2-physical-event-v1',contentDigest:e.digest}))})),preparation:preparations,
   originalParentCostWitness:(()=>{const p=plan.costs.parent as any;return {digest:p.digest,attempts:p.attempts,steps:p.steps,wallMs:p.wallMs,nativeInvocationCount:p.nativeInvocationCount,modelInvocationCount:p.modelInvocationCount};})(),accountingScope:'P2_ATTEMPTS_OVERLAP_P1_PARENT_NOT_SUMMED_PREPARATION_NONADDITIVE',unknownCosts:['ACTUAL_NATIVE_AND_PROVIDER_USD','DATA_COST','HUMAN_PREPARATION_AND_SUPPORT_TIME','UNOBSERVED_QUEUE_IDLE_MAINTENANCE_AND_PHYSICAL_OVERHEAD','INVOICES_AND_EXTERNAL_SETTLEMENT'],externalEffectOwner:'S6'},utilityConversion:conversion,qualifications:['ORDINARY_EXECUTED_P2_CONTROL_UNIT_AND_CURRENT_P1_CHECKS','CONTROLLER_AND_WORK_USE_ORIGINAL_S5_NATIVE_ATTEMPT_GRANT','NO_BUSINESS_SELECTION_OR_EFFECT_AUTHORITY','CONDITIONAL_BOUND_IS_MODEL_RELATIVE','COMPLETION_NOT_GAIN_NOT_ACCEPTANCE_NOT_WEALTH','USD_AND_PROTECTED_GATE_UNPASSED',...remaining]};
 const {frontier:frontierView,incumbent:incumbentView,stop:stopView,outstandingCosts:costView,...metadata}=body;
 const projection={frontier:frontierView,incumbent:incumbentView,stop:stopView,outstandingCosts:costView},components:Record<string,any>={};
 for(const [kind,component] of Object.entries(projection)){
  if(kind==='incumbent'&&component===null){components[kind]=null;continue;}
  const reference=ref('m2-'+kind,component,'m2-current-component-v1');components[kind]=reference;
  await c.query('INSERT INTO finnor_os.m2_components(tenant_id,principal_id,search_id,digest,kind,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING',[s.tenant_id,s.principal_id,s.id,reference.contentDigest,kind,stable(component)]);
 }
 const wire={...metadata,...components,projection,ownerRequests};const committed={...wire,ref:ref('deliberation-policy',wire,M2_VERSION)};
 // Normalize repeated object identities before strict validation. JSON wire
 // sharing is not execution authority; every field and array remains bounded.
 const policy=DeliberationPolicySchema.parse(JSON.parse(stable(committed)));if(Buffer.byteLength(stable(policy))>1048576)throw Error('M2_POLICY_BYTE_BOUND');return policy;
}
export async function persistPolicy(ctx:PeMutationContext,s:SearchRow,policy:any,plan:ComputeSearchPlan,planId:string,c:PoolClient){await c.query('INSERT INTO finnor_os.m2_policies(id,tenant_id,principal_id,search_id,revision,plan_id,plan_digest,body,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[policy.envelope.id,s.tenant_id,s.principal_id,s.id,plan.revision,planId,sha(plan),stable(policy),sha(policy)]);}
export async function readStoredPolicy(ctx:PeMutationContext,s:SearchRow){return tx(ctx,async c=>{const row=(await c.query('SELECT m.body,m.digest,m.plan_digest,p.body plan,p.digest actual_plan_digest FROM finnor_os.m2_policies m JOIN finnor_os.p2_plans p ON p.id=m.plan_id AND p.tenant_id=m.tenant_id AND p.principal_id=m.principal_id WHERE m.tenant_id=$1 AND m.principal_id=$2 AND m.search_id=$3 AND m.plan_id=$4',[s.tenant_id,s.principal_id,s.id,s.head_id])).rows[0];if(!row||sha(row.body)!==row.digest||sha(row.plan)!==row.actual_plan_digest||row.plan_digest!==row.actual_plan_digest||stable(row.plan.deliberationPolicyRef)!==stable(row.body.ref))throw Error('M2_COHERENT_POLICY_PLAN_DIGEST_REQUIRED');const policy=DeliberationPolicySchema.parse(row.body),{ref:reference,...body}=policy;if(sha(body)!==reference.contentDigest)throw Error('M2_POLICY_CONTENT_COMMITMENT_MISMATCH');
 for(const kind of ['frontier','incumbent','stop','outstandingCosts'] as const){const reference=policy[kind];if(!reference)continue;const component=(await c.query('SELECT body FROM finnor_os.m2_components WHERE tenant_id=$1 AND principal_id=$2 AND search_id=$3 AND digest=$4 AND kind=$5',[s.tenant_id,s.principal_id,s.id,reference.contentDigest,kind])).rows[0];if(!component||sha(component.body)!==reference.contentDigest||stable(component.body)!==stable(policy.projection[kind]))throw Error('M2_CURRENT_COMPONENT_BYTES_REQUIRED');}return policy;},true);}

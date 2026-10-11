import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {executionDeadlineMilliseconds} from '@finnor/db';
import type {BeliefViewPin,EconomicMandate,ExperimentRef} from '@finnor/shared-types';
import {parseEconomicMandate,parseExactInformationModel,ControlFraction as Q,controlBytesDigest,epistemicHash,ExactControlError,allocationNumber} from '@finnor/epistemic-runtime';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import {loadEnterpriseBeliefView,validateBeliefViewPin} from '../enterprise-beliefs';
import {authorize,principal,tx,sha,stable,revisions,assertDependencies,unavailable} from '../evidence-execution/store';
import {r1SourceCut} from './runtime';
export interface ExactSourceRow {id:string;tenant_id:string;principal_id:string;work_id:string;work_input_id:string;work_input_digest:string;ref:ExperimentRef;model_bytes:string;model_digest:string;source_digest:string;mandate:EconomicMandate;belief_pins:BeliefViewPin[];dependencies:any[];source_cut:Awaited<ReturnType<typeof r1SourceCut>>}
function deadline(milliseconds:number){return Date.now()+Math.min(milliseconds,executionDeadlineMilliseconds()??milliseconds);}
export async function lockExactSourceCurrent(ctx:PeMutationContext,row:ExactSourceRow,c:PoolClient){
 const user=(await c.query('SELECT status,role FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 FOR SHARE',[ctx.auth.tenantId,principal(ctx)])).rows[0];if(user?.status!=='active'||user.role!=='owner')throw unavailable();
 await c.query('SELECT id FROM finnor_os.works WHERE tenant_id=$1 AND id=$2 FOR SHARE',[row.tenant_id,row.work_id]);
 const latest=(await c.query('SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[row.tenant_id,row.work_id])).rows[0];
 if(latest?.id!==row.work_input_id||sha(latest.body)!==row.work_input_digest)throw Error('R1_ORIGINAL_WORK_REVISION_CHANGED');
 await assertDependencies(ctx,row.dependencies,c,true);
}
export async function prepareExactControlSource(ctx:PeMutationContext,input:{workId:string;workRevision:string;modelBytes:string;mandate?:unknown}){
 const startedAt=new Date().toISOString(),account={steps:0},started=performance.now(),cpu=process.cpuUsage(),rss=process.memoryUsage().rss;
 const m=parseEconomicMandate(input.mandate),model=parseExactInformationModel(input.modelBytes,{deadlineAt:deadline(m.search.deadlineMs),maxSteps:4000000,account});
 if(ctx.auth.role!=='owner'||m.tenantId!==ctx.auth.tenantId||m.principalId!==principal(ctx)||m.businessOwnerRef.id!==principal(ctx)||model.tenantId!==m.tenantId||model.principalId!==m.principalId||epistemicHash(model.mandateRef)!==epistemicHash(m.ref)||model.rightsRef!==m.rightsRef||epistemicHash(model.horizon)!==epistemicHash(m.horizon)||model.units.utility!==m.utility.unit)throw unavailable();
 // These are independently checked lossless source-encoding premises. No
 // bootstrap output, rounding, decimal print or new probability law is adopted.
 const same=(q:unknown,n:number)=>{const left=Q.read(q),right=allocationNumber(n);return left.n===right.n&&left.d===right.d;};
 if(!same(model.economics.minimumUtility,m.risk.minimumUtility)||!same(model.economics.terminalLiability,m.utility.tail.terminalLiability)||!same(model.economics.normalization,m.scoring.normalization)||model.economics.discountFactors.some((q,i)=>!same(q,m.utility.discountFactors[i]!)))throw new ExactControlError('UNSUPPORTED','NON_LOSSLESS_MANDATE_ENCODING_REQUIRES_VERSIONED_OWNER_REVISION');
 if(epistemicHash(model.units.money.discountConventionRef)!==epistemicHash(m.utility.accountingConventionRef)||Date.parse(model.units.money.valuationAt)>Date.parse(m.knowledgeAt))throw new ExactControlError('UNSUPPORTED','ORIGINAL_MONEY_VALUATION_OR_DISCOUNT_CONTEXT');
 const dimensions=m.resources.dimensions.map(d=>d.id).sort();if(dimensions.join('|')!==Object.keys(model.units.resources).sort().join('|')||m.resources.dimensions.some(d=>model.units.resources[d.id]!==d.unit||model.states.some(s=>!same(s.semantics.resources.capacity[d.id],d.capacity)||!same(s.semantics.resources.totalLimit[d.id],d.totalLimit))))throw new ExactControlError('UNSUPPORTED','ORIGINAL_RESOURCE_UNIT_OR_CAPACITY_ENCODING');
 await authorize(ctx,model.root as PeWorldRootRef,[{type:'work',id:input.workId}]);
 const view=await loadEnterpriseBeliefView(ctx,{root:model.root as PeWorldRootRef});if(view.coverage.canonicalStatus!=='COMPLETE'||view.coverage.truncated)throw Error('R1_S1_CURRENT_COMPLETE_SOURCE_REQUIRED');
 const retainedRefs=new Set(view.claims.flatMap(claim=>[claim.ownerRef,...claim.provenance]).map(ref=>epistemicHash({owner:ref.owner,id:ref.id,version:ref.revisionId,contentDigest:ref.contentDigest})));
 if(model.sourceRefs.some(ref=>!retainedRefs.has(epistemicHash(ref))))throw new ExactControlError('UNSUPPORTED','R1_DECLARED_SOURCE_NOT_IN_CURRENT_AUTHORIZED_S1_VIEW');
 if(model.states.some(s=>!same(s.semantics.humanLimit,m.search.maxHumanSeconds)))throw new ExactControlError('UNSUPPORTED','ORIGINAL_HUMAN_LIMIT_ENCODING');
 const pin:BeliefViewPin={tenantId:view.tenantId,principalId:view.principalId,root:view.root,validAt:view.validAt,knowledgeAt:view.knowledgeAt,dependencyDigest:view.dependencyDigest,rightsRevision:view.rights.revision,interpretationVersion:view.interpretationVersion};
 const cut=await r1SourceCut(),modelDigest=controlBytesDigest(input.modelBytes);
 const result=await tx(ctx,async c=>{
  const work=(await c.query('SELECT id::text,to_jsonb(w) body FROM finnor_os.work_inputs w WHERE tenant_id=$1 AND work_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1',[ctx.auth.tenantId,input.workId])).rows[0];if(work?.id!==input.workRevision)throw Error('R1_ORIGINAL_WORK_REVISION_CHANGED');
  const dependencyKeys=['work:'+input.workId,'rights:'+principal(ctx),'entity:'+model.root.entityId,...model.sourceRefs.map(ref=>'source:'+ref.id)];
  const dependencies=await revisions(ctx,dependencyKeys,c,true),sourceDigest=sha({modelDigest,workId:input.workId,workRevision:input.workRevision,workDigest:sha(work.body),mandate:m.ref,pin,dependencies,cut});
  const ref:ExperimentRef={owner:'S3',id:'exact-information-model:'+sourceDigest,version:'finite-information-rational-v1',contentDigest:sourceDigest};
  const row={id:randomUUID(),tenant_id:ctx.auth.tenantId,principal_id:principal(ctx),work_id:input.workId,work_input_id:input.workRevision,work_input_digest:sha(work.body),ref,model_bytes:input.modelBytes,model_digest:modelDigest,source_digest:sourceDigest,mandate:m,belief_pins:[pin],dependencies,source_cut:cut};
  await lockExactSourceCurrent(ctx,row,c);
  await c.query('INSERT INTO finnor_os.r1_models(id,tenant_id,principal_id,work_id,work_input_id,work_input_digest,ref,model_bytes,model_digest,source_digest,mandate,belief_pins,dependencies,source_cut) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb) ON CONFLICT(tenant_id,principal_id,source_digest) DO NOTHING',[row.id,row.tenant_id,row.principal_id,row.work_id,row.work_input_id,row.work_input_digest,stable(ref),input.modelBytes,modelDigest,sourceDigest,stable(m),stable([pin]),stable(dependencies),stable(cut)]);
  const stored=(await c.query<ExactSourceRow>('SELECT * FROM finnor_os.r1_models WHERE tenant_id=$1 AND principal_id=$2 AND source_digest=$3',[row.tenant_id,row.principal_id,sourceDigest])).rows[0]!;const usage=process.cpuUsage(cpu);return {sourceRef:stored.ref,sourceId:stored.id,workId:stored.work_id,workRevision:stored.work_input_id,preparation:{elapsedMs:performance.now()-started,cpuUserMicros:usage.user,cpuSystemMicros:usage.system,rssBeforeBytes:rss,rssAfterBytes:process.memoryUsage().rss,usd:null,scope:'SOURCE_VALIDATION_AND_PERSISTENCE_PROCESS_INTERVAL_NOT_PEAK'},qualification:'SUPPLIED_FINITE_MODEL_UNADMITTED',causalQualification:'UNQUALIFIED',probabilityLawQualified:false,executionAuthorityGranted:false};
 });
 const usage=process.cpuUsage(cpu),preparation={schema:'finnor.r1.source-preparation.v1',sourceRef:result.sourceRef,workId:result.workId,workRevision:result.workRevision,startedAt,finishedAt:new Date().toISOString(),
  mathSteps:account.steps,elapsedMs:performance.now()-started,cpuUserMicros:usage.user,cpuSystemMicros:usage.system,rssBeforeBytes:rss,rssAfterBytes:process.memoryUsage().rss,usd:null,aggregateSimultaneousPeak:null,
  scope:'SOURCE_VALIDATION_OWNER_RESOLUTION_AND_COMMITTED_MODEL_PERSISTENCE_PROCESS_INTERVAL',receiptRecordingExcluded:true};
 const receiptId=randomUUID(),digest=sha(preparation);await tx(ctx,c=>c.query('INSERT INTO finnor_os.r1_preparation_receipts(id,tenant_id,principal_id,model_id,body,digest) VALUES($1,$2,$3,$4,$5::jsonb,$6)',[receiptId,ctx.auth.tenantId,principal(ctx),result.sourceId,stable(preparation),digest]));
 return {...result,preparation,preparationRef:{owner:'S3' as const,id:'r1-preparation:'+receiptId,version:'finnor.r1.source-preparation.v1',contentDigest:digest}};
}
export async function resolveExactControlSource(ctx:PeMutationContext,ref:ExperimentRef):Promise<ExactSourceRow>{
 if(ref.owner!=='S3'||ref.version!=='finite-information-rational-v1'||ref.id!=='exact-information-model:'+ref.contentDigest)throw unavailable();
 const row=await tx(ctx,async c=>(await c.query<ExactSourceRow>('SELECT * FROM finnor_os.r1_models WHERE tenant_id=$1 AND principal_id=$2 AND source_digest=$3',[ctx.auth.tenantId,principal(ctx),ref.contentDigest])).rows[0],true);if(!row||epistemicHash(row.ref)!==epistemicHash(ref)||controlBytesDigest(row.model_bytes)!==row.model_digest)throw unavailable();
 // The immutable S3 record was fully validated when prepared. Currentness
 // checks its original bytes and retained owner pins, rather than spending a
 // fresh unrecorded numerical budget on every owner read. Numerical consumers
 // and the independent checker still validate the complete original table.
 const root=row.belief_pins[0]?.root;if(!root)throw unavailable();await authorize(ctx,root as PeWorldRootRef,[{type:'work',id:row.work_id}]);
 if((await r1SourceCut()).codeDigest!==row.source_cut.codeDigest)throw Error('R1_EXACT_SOURCE_METHOD_CHANGED');
 if(Date.now()>=Date.parse(row.mandate.validUntil))throw Error('R1_EXACT_SOURCE_EXPIRED');
 for(const pin of row.belief_pins)if((await validateBeliefViewPin(ctx,pin)).status!=='CURRENT')throw Error('R1_S1_SOURCE_OR_RIGHTS_REVISED');
 await tx(ctx,c=>lockExactSourceCurrent(ctx,row,c));return row;
}

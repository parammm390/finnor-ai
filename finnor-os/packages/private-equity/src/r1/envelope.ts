import type {PoolClient} from 'pg';
import type {ControlQuotientReceipt,ExperimentRef,R1ArtifactEnvelope} from '@finnor/shared-types';
import type {PeMutationContext} from '../types';
import type {ExactSourceRow} from './source';
import type {R1RunRow} from './api';
import {sha} from '../evidence-execution/store';

type Saved={id:string;digest:string};
const reference=(saved:Saved,kind='artifact'):ExperimentRef=>({owner:'R1',id:kind+':'+saved.id,version:kind==='event'?'finnor.r1.lifecycle-event.v1':'finnor.r1.immutable-artifact.v1',contentDigest:saved.digest});

/** Called within the same fenced publication transaction. Every emitted ref
 * points to an actual canonical source or retained immutable record. */
export async function createR1ArtifactEnvelope(ctx:PeMutationContext,r:R1RunRow,source:ExactSourceRow,receipt:ControlQuotientReceipt|null,c:PoolClient,persist:(kind:string,body:unknown)=>Promise<Saved>):Promise<R1ArtifactEnvelope>{
 const model=JSON.parse(source.model_bytes),events=(await c.query('SELECT id,kind,body,digest FROM finnor_os.r1_events WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3 ORDER BY created_at,id LIMIT 257',[r.tenant_id,r.principal_id,r.id])).rows;
 if(events.length>256||events.some(e=>sha(e.body)!==e.digest))throw Error('R1_COMPLETE_IMMUTABLE_LIFECYCLE_REFS_REQUIRED');
 const preparation=events.find(e=>e.kind==='COMMON_PREPARATION_CHARGED')?.body;
 if(!preparation)throw Error('R1_ORIGINAL_COMMON_PREPARATION_REQUIRED');
 const baseline=await persist('BASELINE_MANIFEST',{schema:'finnor.r1.baseline-manifest.v1',integrationParent:source.source_cut.baseCommit,sourceCut:source.source_cut,originalModelRef:source.ref,originalS4:preparation.originalS4,originalS5:preparation.originalS5,sharedPreparationAllocation:preparation.allocation,qualification:'SUPPLIED_EXACT_ADAPTER_ABLATION_NOT_COMPLETED_CUMULATIVE_X',completedCumulativeXRef:null});
 const assumptions=await persist('MODEL_ASSUMPTIONS',{schema:'finnor.r1.model-assumptions.v1',sourceRef:source.ref,modelDigest:source.model_digest,assumptions:model.assumptions,qualification:'SUPPLIED_MODEL_PREMISES_NOT_CAUSAL_ADMISSION'});
 const grammar=await persist('ORIGINAL_ACTION_CATALOGUE',{schema:'finnor.r1.original-action-catalogue.v1',sourceRef:source.ref,modelDigest:source.model_digest,actions:model.actions,observationInstruments:model.observationInstruments,horizon:model.horizon,policyFamily:'ORIGINAL_LAWFUL_FIXED_WORLD_CONTINUATIONS',tieRule:'FIRST_GLOBAL_OPTIMAL_FAMILY_IN_ORIGINAL_OWNER_CATALOGUE_ORDER'});
 const artifacts=(await c.query('SELECT id,kind,body,digest FROM finnor_os.r1_artifacts WHERE tenant_id=$1 AND principal_id=$2 AND run_id=$3 AND generation=$4 ORDER BY created_at,id',[r.tenant_id,r.principal_id,r.id,r.generation])).rows;
 if(artifacts.some(a=>sha(a.body)!==a.digest))throw Error('R1_IMMUTABLE_ARTIFACT_CHANGED');
 const checker=artifacts.find(a=>a.kind==='CHECK_RECEIPT'&&sha(a.body)===sha(receipt));
 const claimId='r1:'+r.id+':complete-original-information-relation',claims:R1ArtifactEnvelope['claims']=[];
 if(receipt?.status==='COMPLETE'&&receipt.relationComplete){
  if(!checker)throw Error('R1_ACTUAL_INDEPENDENT_RECEIPT_REF_REQUIRED');
  const statement=await persist('RELATION_CLAIM_STATEMENT',{schema:'finnor.r1.claim-statement.v1',claimId,statement:'Every declared original information state and its complete action/world/successor labels satisfy the retained exact relation and original-history lifting obligations.',sourceRef:source.ref,modelDigest:source.model_digest,checkerVersion:receipt.checkerVersion,checkerDigest:receipt.checkerDigest,candidateDigest:receipt.candidateDigest,probabilityLawQualified:false,causalQualification:'UNQUALIFIED',effectAuthority:false});
  claims.push({claim_id:claimId,statement_ref:reference(statement),domain_ref:source.ref,checker_receipt_ref:reference(checker)});
 }
 const rightsRevision=source.belief_pins[0]?.rightsRevision??null;
 const inputs=[{ref:source.ref,asOf:source.belief_pins[0]?.knowledgeAt??null},{ref:r.request.envelope_inputs.policyRequest,asOf:preparation.originalS4.asOf??null},{ref:r.request.grant,asOf:preparation.originalS5.asOf??null}];
 const gaps:R1ArtifactEnvelope['gaps']=[
  {kind:'CAUSAL_ADEQUACY_UNQUALIFIED',reason:'The owner supplied a finite exact model; its field mechanisms and forecast adequacy have no independent qualification.',affected_claim_ids:[claimId]},
  {kind:'INDEPENDENT_ADMISSION_UNAVAILABLE',reason:'No current independently issued S8 checker/method/domain admission is available. Ordinary receipts do not substitute for it.',affected_claim_ids:[claimId]},
  {kind:'COMPLETED_CUMULATIVE_X_UNAVAILABLE',reason:'The retained baseline is the exact adapter ablation and integration parent, not a completed equipped cumulative-X comparison actor.',affected_claim_ids:[claimId]},
  {kind:'PROTECTED_COMPARISON_NOT_RUN',reason:'No protected post-X gain comparison has run.',affected_claim_ids:[claimId]},
  {kind:'ECONOMIC_RELEASE_UNQUALIFIED',reason:'No mature independently valued S7 field outcome or H2 qualification exists for this supplied-model proof.',affected_claim_ids:[claimId]},
  {kind:'USD_AND_AGGREGATE_PEAK_UNMETERED',reason:'Retained process/child/time/attempt receipts do not establish dollar cost or aggregate simultaneous peak memory.',affected_claim_ids:[claimId]},
 ];
 if(!claims.length)gaps.push({kind:'COMPLETE_RELATION_UNACCEPTED',reason:receipt?.predicate??'No independent complete relation receipt was returned.',affected_claim_ids:[claimId]});
 if(inputs.some(i=>i.asOf===null)||rightsRevision===null)gaps.push({kind:'OWNER_METADATA_UNKNOWN',reason:'A canonical input ref has no retained as-of or permission revision; the missing value is null, never invented.',affected_claim_ids:[claimId]});
 const resourceRefs=[...artifacts.filter(a=>/^(?:PRODUCE_RETURN|CHECK_RECEIPT|S4_EVALUATE_RETURN|ORIGINAL_FALLBACK_RETURN)$/.test(a.kind)).map(a=>reference(a)),...preparation.source.map((a:Saved)=>({owner:'S3',id:'r1-preparation:'+a.id,version:'finnor.r1.source-preparation.v1',contentDigest:a.digest})),...events.filter(e=>['COMMON_PREPARATION_CHARGED','OWNER_PROJECTION_RETURNED'].includes(e.kind)).map(e=>reference(e,'event'))];
 return {schema:'finnor.r1.artifact-envelope.v1',artifact_id:'control-quotient:'+r.id,artifact_kind:'ControlQuotient',artifact_schema_revision:'finnor.control-quotient.v1',work_ref:{owner:'@finnor/db',id:r.work_id,version:r.work_input_id,contentDigest:source.work_input_digest},work_revision:r.work_input_id,tenant_ref:{owner:'@finnor/db',id:ctx.auth.tenantId},baseline_manifest_ref:reference(baseline),producer_ref:{code_digest:source.source_cut.codeDigest,dependency_lock_digest:source.source_cut.lockDigest,admission_ref:null},input_refs:inputs.map(i=>({owner_ref:i.ref,revision:i.ref.version,content_digest:i.ref.contentDigest,as_of:i.asOf,rights_revision:rightsRevision})),domain_ref:source.ref,assumptions_ref:reference(assumptions),programme_grammar_ref:reference(grammar),check_basis:claims.length?'MODEL_RELATIVE_EXACT':'UNKNOWN',claims,gaps,resource_receipt_refs:resourceRefs,budget_grant_ref:r.request.grant,invalidation_dependency_refs:source.dependencies,lifecycle_event_refs:events.map(e=>reference(e,'event'))};
}

import type {PoolClient} from 'pg';
import {employeeAuthoritySnapshotTx} from '@finnor/authority';
import type {PeMutationContext} from '../types';
import {authorize,principal} from '../owner-context';
import type {EconomicProgramme} from '../economic-control';
import {readEconomicReservationTx} from '../economic-allocation';
import {currentInteractionAdmissionTx} from '../../../capability-evolution/src/interaction-port';
import {digest,fail,type Y3Ref} from './contracts';
import {reference,same,type ProtocolRow,type InteractionTerms,type InteractionRun,type InteractionHistory,type ProgrammeBinding} from './product-contracts';
import {sourceClaimTx} from './store';
import {assertCoalitionTerms} from '../project-z/z2-coalitions/guard';
import {assertParticipantWorksTx} from '../project-z/z2-coalitions/participant-work-guard';

export function responsibleContext(row:Pick<ProtocolRow,'tenant_id'|'principal_id'>):PeMutationContext{
 return {auth:{tenantId:row.tenant_id,userId:row.principal_id,employeeId:row.principal_id,role:'owner'}};
}
export function participantId(ctx:PeMutationContext,row:ProtocolRow){
 const party=row.request.problem.participants.find(p=>p.principalId===principal(ctx));
 if(!party)fail('Y3_PARTICIPANT_UNAVAILABLE',404);
 return party.id;
}
export async function termsTx(c:PoolClient,row:ProtocolRow,ref?:Y3Ref):Promise<InteractionTerms>{
 const found=(await c.query<{body:InteractionTerms}>(`SELECT body FROM finnor_os.s4_interaction_terms
  WHERE tenant_id=$1 AND protocol_id=$2 AND ($3::uuid IS NULL OR id=$3) ORDER BY revision DESC LIMIT 1 FOR SHARE`,
 [row.tenant_id,row.id,row.current_terms_id])).rows[0]?.body;
 if(!found)fail('Y3_TERMS_UNAVAILABLE',404);
 const {ref:stored,...body}=found;
 if(!same(stored,reference('S4','interaction-terms',body))||ref&&!same(ref,stored)||
  found.protocolId!==row.id||found.tenantId!==row.tenant_id||found.principalId!==row.principal_id||
  !same(found.protocolRef,row.artifact?.envelope.contentRef)||!same(found.lowering,row.request.lowering)||
  found.candidateDigest!==digest(row.candidate)||!same(found.participants,row.request.problem.participants)||
  (!row.current_terms_id||found.id!==row.current_terms_id||Date.parse(found.validUntil)<=Date.now()))
  fail('Y3_EXACT_CURRENT_TERMS_REQUIRED');
 assertCoalitionTerms(row,found);
 return found;
}
export async function participantAuthorityTx(ctx:PeMutationContext,c:PoolClient,row:ProtocolRow){
 participantId(ctx,row);
 const user=(await c.query<{status:string}>('SELECT status FROM finnor_os.users WHERE tenant_id=$1 AND id=$2 FOR SHARE',
  [row.tenant_id,principal(ctx)])).rows[0];
 if(user?.status!=='active')fail('Y3_ACTIVE_PARTICIPANT_REQUIRED',403);
 await authorize(ctx,row.root,[{type:'work',id:row.work_id}],[],c);
 const authority=await employeeAuthoritySnapshotTx(ctx.auth,c);
 if(String(authority.revision)!==row.rights_revision||authority.validUntil&&Date.parse(authority.validUntil)<=Date.now())
  fail('Y3_CURRENT_PARTICIPANT_RIGHTS_REQUIRED',403);
 return authority;
}
export async function requireConsentsTx(c:PoolClient,row:ProtocolRow,terms:InteractionTerms,scope:'TERMS'|'EFFECT',subjectDigest:string,expected?:string[]){
 const latest=(await c.query<{consent_id:string;principal_id:string;decision:string;body:Record<string,unknown>}>(
  `SELECT DISTINCT ON(principal_id) consent_id,principal_id,decision,body FROM finnor_os.s4_interaction_consents
   WHERE tenant_id=$1 AND protocol_id=$2 AND terms_id=$3 AND scope=$4 AND subject_digest=$5 ORDER BY principal_id,id DESC`,
 [row.tenant_id,row.id,terms.id,scope,subjectDigest])).rows;
 const ids:string[]=[];
 for(const party of row.request.problem.participants){
  const consent=latest.find(v=>v.principal_id===party.principalId),ctx=responsibleContext({tenant_id:row.tenant_id,principal_id:party.principalId});
  if(!consent||consent.decision!=='ACCEPT'||consent.body.principalId!==party.principalId||
   consent.body.participant!==party.id||consent.body.rightsRevision!==row.rights_revision||
   consent.body.subjectDigest!==subjectDigest||consent.body.scope!==scope||!same(consent.body.termsRef,terms.ref))
   fail(scope==='TERMS'?'Y3_BOTH_EXACT_TERMS_CONSENTS_REQUIRED':'Y3_BOTH_EXACT_EFFECT_CONSENTS_REQUIRED');
  await participantAuthorityTx(ctx,c,row);ids.push(consent.consent_id);
 }
 if(expected&&!same([...ids].sort(),[...expected].sort()))fail('Y3_ORIGINAL_CONSENT_HEADS_CHANGED');
 await assertParticipantWorksTx(c,row,terms);
 return ids;
}
export async function historyTx(c:PoolClient,run:InteractionRun):Promise<InteractionHistory[]>{
 const rows=(await c.query<InteractionHistory>(`SELECT h.id::text AS id,h.event_id,h.principal_id,h.kind,h.body FROM finnor_os.s4_interaction_history h
  WHERE h.tenant_id=$1 AND h.run_id=$2 ORDER BY h.id LIMIT 257`,[run.tenant_id,run.id])).rows;
 if(rows.length>256)fail('Y3_ORIGINAL_HISTORY_BOUND');
 return rows;
}
export function observationTimesCurrent(claim:Record<string,unknown>){
 const observed=typeof claim.observedAt==='string'?Date.parse(claim.observedAt):NaN,
  expires=typeof claim.validUntil==='string'?Date.parse(claim.validUntil):NaN;
 return Number.isFinite(observed)&&observed<=Date.now()&&Number.isFinite(expires)&&expires>Date.now();
}
export async function assertHistoryCurrentTx(c:PoolClient,row:ProtocolRow,history:InteractionHistory[]){
 for(const event of history){
  const party=row.request.problem.participants.find(p=>p.id===event.body.participant);
  if(!party||party.principalId!==event.principal_id||party.principalId!==event.body.principalId)fail('Y3_HISTORY_ACTOR_PREIMAGE');
  if(event.kind!=='OBSERVATION'||!event.body.effective)continue;
  if(event.body.classification!=='SOURCED_FACT'||!event.body.source)fail('Y3_ASSERTION_CANNOT_BECOME_FACT');
  const claim=await sourceClaimTx(responsibleContext({tenant_id:row.tenant_id,principal_id:party.principalId}),c,row.root,event.body.source);
  if(!claim||claim.kind!=='INTERACTION_OBSERVATION'||claim.problemDigest!==digest(row.request.problem)||
   claim.participant!==party.id||claim.date!==event.body.date||claim.observationKey!==event.body.key||claim.value!==event.body.value||
   claim.classification!=='SOURCED_FACT'||!observationTimesCurrent(claim))fail('Y3_LOCAL_OBSERVATION_REVISED_OR_UNQUALIFIED');
 }
}
/** Called inside each original Y1 S4/S6 transaction. A second API or an old
 * native programme cannot bypass Y3's current terms, consent and history. */
export async function assertInteractionProgrammeCurrentTx(ctx:PeMutationContext,c:PoolClient,programme:EconomicProgramme){
 const binding=(await c.query<{body:ProgrammeBinding}>(`SELECT body FROM finnor_os.s4_interaction_programme_bindings
  WHERE tenant_id=$1 AND programme_id=$2`,[ctx.auth.tenantId,programme.id])).rows[0]?.body;
 if(!binding)return;
 const {ref,...body}=binding;
 if(!same(ref,reference('S4','interaction-programme-binding',body))||body.programmeId!==programme.id||
  !same(body.programmeRef,programme.ref)||body.externalEffects!==false||body.executionAuthorityGranted!==false)
  fail('Y3_NATIVE_PROGRAMME_BINDING');
 const {row,admission}=await currentInteractionAdmissionTx(ctx,c,body.protocolId),terms=await termsTx(c,row,body.termsRef);
 if(!same(terms.admissionRef,admission.ref)||!same(terms.protocolRef,body.protocolRef)||programme.theoryId!==row.theory_id||
  !same(programme.reservationRef,terms.reservationRef)||programme.episodeId===row.episode_id||
  body.originalEpisodeId!==row.episode_id||!same(body.intent.termsRef,terms.ref))fail('Y3_OWNER_MEANING_AND_EPISODE_BINDING');
 const run=(await c.query<InteractionRun>('SELECT * FROM finnor_os.s4_interaction_runs WHERE tenant_id=$1 AND id=$2 FOR SHARE',
  [row.tenant_id,body.runId])).rows[0];
 if(!run||run.programme_id!==programme.id||run.status!=='MATERIALIZED'||!same(run.intent,body.intent))fail('Y3_ORIGINAL_RUN_INTENT_REQUIRED');
 const history=await historyTx(c,run);
 if(body.intent.historyDigest!==digest(history.map(e=>({id:e.event_id,kind:e.kind,body:e.body}))))fail('Y3_EFFECT_HISTORY_PREIMAGE');
 await assertHistoryCurrentTx(c,row,history);
 await requireConsentsTx(c,row,terms,'TERMS',terms.ref.contentDigest,body.termsConsentIds);
 await requireConsentsTx(c,row,terms,'EFFECT',body.intent.ref.contentDigest,body.effectConsentIds);
 await readEconomicReservationTx(ctx,c,programme.reservationRef);
}

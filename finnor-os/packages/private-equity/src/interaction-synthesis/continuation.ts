import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../types';
import {principal} from '../owner-context';
import {readEconomicReservationTx} from '../economic-allocation';
import {createEconomicProgrammeTx,readEconomicProgrammeTx} from '../economic-control';
import {currentInteractionAdmissionTx} from '../../../capability-evolution/src/interaction-port';
import {compileGame,protocolControlKeys,type CompiledNode,type ObservationToken} from './game';
import {InteractionFault,digest,fail,participantIndex,type Party} from './contracts';
import {q,ZERO} from './exact';
import {reference,same,TermsSchema,ConsentSchema,StartSchema,ObserveSchema,ActionSchema,MaterializeSchema,
 type ProtocolRow,type InteractionTerms,type InteractionRun,type InteractionHistory,type InteractionIntent,type Outcome,type ProgrammeBinding} from './product-contracts';
import {withS5PortfolioTransaction as transaction} from '../allocation-store';
import {coalitionTermsBinding,assertCoalitionTerms} from '../project-z/z2-coalitions/guard';
import {ensureParticipantWork} from '../project-z/z2-coalitions/participant-work';
import {participantWorkViewTx} from '../project-z/z2-coalitions/participant-work-guard';
import {developmentOnly,protocolTx,eventTx,currentChangesTx,sourceClaimTx} from './store';
import {responsibleContext,participantId,participantAuthorityTx,termsTx,requireConsentsTx,historyTx,assertHistoryCurrentTx,
 observationTimesCurrent} from './execution-guard';

type Frontier={modelId:string;node:CompiledNode};
function frontier(row:ProtocolRow,history:InteractionHistory[]):Frontier[]{
 const actions=history.filter(e=>e.kind==='ACTION'),facts=history.filter(e=>e.kind==='OBSERVATION'&&e.body.effective),found:Frontier[]=[];
 for(const model of row.request.problem.models){
  const game=compileGame(row.request.problem,model,row.candidate!.policy);
  function walk(id:string,index:number){
   const node=game.nodes[id]!;
   if(node.kind==='CHANCE'||node.kind==='PROTOCOL'){for(const edge of node.edges)walk(edge.next,index);return;}
   if(node.kind==='DECISION'&&index<actions.length){
    const event=actions[index]!;
    if(node.original.kind!=='DECISION'||node.original.participant!==event.body.participant||node.informationKey!==event.body.informationKey)return;
    const edge=node.edges.find(e=>e.actionId===event.body.actionId);if(edge)walk(edge.next,index+1);return;
   }
   if(index!==actions.length)return;
   if(facts.every(e=>node.observations[participantIndex(e.body.participant)]!.some(o=>
    o.date===e.body.date&&o.key===e.body.key&&o.value===e.body.value)))found.push({modelId:model.id,node});
  }
  walk(game.root,0);
 }
 return found;
}
const effectMeaning=(o:Outcome)=>o.kind==='NO_EFFECT'?{kind:o.kind,before:o.before,after:o.after}:
 {kind:o.kind,operatorId:o.operatorId,before:o.before,after:o.after,parameters:o.parameters};
function commonObservations(front:Frontier[],party:Party){
 if(!front.length)return [];
 const index=participantIndex(party);
 return front[0]!.node.observations[index]!.filter(o=>front.every(f=>f.node.observations[index]!.some(v=>same(v,o))));
}
function modelObservation(row:ProtocolRow,o:ObservationToken,history:InteractionHistory[],party:Party){
 const classification=row.request.problem.observationRules.find(r=>r.key===o.key)!.classification;
 const verifiedFact=classification==='SOURCED_FACT'&&history.some(e=>e.kind==='OBSERVATION'&&e.body.effective&&
  e.body.date===o.date&&e.body.key===o.key&&e.body.value===o.value&&(e.body.participant===party||o.visibility==='PUBLIC'));
 return {...o,classification,verifiedFact,basis:verifiedFact?'CURRENT_CANONICAL_OBSERVATION':'MODEL_RELATIVE_TOKEN_NOT_VERIFIED_TRUTH'};
}
function localView(ctx:PeMutationContext,row:ProtocolRow,terms:InteractionTerms,run:InteractionRun,history:InteractionHistory[]){
 const party=participantId(ctx,row),front=frontier(row,history),observations=commonObservations(front,party).map(o=>modelObservation(row,o,history,party)),
  isTurn=front.length>0&&front.every(f=>f.node.original.kind==='DECISION'&&f.node.original.participant===party),
  keys=new Set(front.map(f=>f.node.informationKey)),exact=isTurn&&keys.size===1,
  node=exact?front[0]!.node:null,missingFacts=observations.filter(o=>o.classification==='SOURCED_FACT'&&!o.verifiedFact),
  notBefore=node?row.request.problem.dates[node.date]:null,
  available=!!node&&!missingFacts.length&&Date.parse(notBefore!)<=Date.now()&&run.status==='ACTIVE',
  actions=available?node.edges.map(edge=>({id:edge.actionId,prescribedProbability:row.candidate!.strategy[node.informationKey!]![edge.actionId],
   permittedDeviation:true})):[],
  body={runId:run.id,revision:run.revision,protocolId:row.id,termsRef:terms.ref,participant:party,principalId:principal(ctx),
   informationKey:node?.informationKey??null,observations,recall:node?.recall[participantIndex(party)]??[],notBefore,
   actions,status:!front.length?'UNKNOWN':front.every(f=>f.node.kind==='TERMINAL')?'TERMINAL':
    !isTurn?'NOT_YOUR_TURN':!exact?'NEEDS_LAWFUL_OBSERVATION':missingFacts.length?'NEEDS_CANONICAL_OBSERVATION':
     !available?'WAITING_ORIGINAL_DATE':'AWAITING_LOCAL_ACTION',missingCanonicalObservationKeys:missingFacts.map(o=>o.key)};
 return {...body,viewDigest:digest(body),privateModelNodeSelectionAccepted:false as const};
}
function visibleIntent(intent:InteractionIntent|null){
 if(!intent)return null;
 return {schema:intent.schema,ref:intent.ref,termsRef:intent.termsRef,runId:intent.runId,historyDigest:intent.historyDigest,
  reservationRef:intent.reservationRef,reservationRevision:intent.reservationRevision,effect:effectMeaning(intent.outcome),
  validUntil:intent.validUntil,externalEffects:false,financialSettlement:false,executionAuthorityGranted:false};
}
export function visibleTerms(row:ProtocolRow,terms:InteractionTerms){
 assertCoalitionTerms(row,terms);
 const effects=[...new Map(terms.lowering.outcomes.map(o=>[digest(effectMeaning(o)),effectMeaning(o)])).values()];
 return {...coalitionTermsBinding(row),schema:terms.schema,ref:terms.ref,id:terms.id,protocolId:terms.protocolId,protocolRef:terms.protocolRef,revision:terms.revision,
  workId:terms.workId,participants:terms.participants.map(p=>({id:p.id,principalId:p.principalId})),reservationRef:terms.reservationRef,
  reservationRevision:terms.reservationRevision,initialState:terms.initialState,contingentInternalEffects:effects,
  publicPolicy:protocolControlKeys(row.request.problem).map(k=>({controlId:k.controlId,date:k.date,
   publicObservations:k.publicObservations,selectedOption:row.candidate!.policy[k.key]})),
  modelStatus:'SUPPLIED_EXACT_MODELS_NOT_FIELD_IDENTIFICATION',validUntil:terms.validUntil,externalEffects:false,financialSettlement:false,
  termsConsentDoesNotAuthorizeEffects:true,executionAuthorityGranted:false,protectedQualification:false};
}
async function runTx(ctx:PeMutationContext,c:PoolClient,id:string){
 const run=(await c.query<InteractionRun>('SELECT * FROM finnor_os.s4_interaction_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
  [ctx.auth.tenantId,id])).rows[0];
 if(!run)fail('Y3_RUN_UNAVAILABLE',404);
 const row=await protocolTx(ctx,c,run.protocol_id,false),{ref,...origin}=run.body;
 if(!same(ref,reference('S4','interaction-run',origin))||run.body.id!==id||!same(run.body.protocolRef,row.artifact?.envelope.contentRef))
  fail('Y3_ORIGINAL_RUN_PREIMAGE');
 return {run,row};
}
async function currentRunTx(ctx:PeMutationContext,c:PoolClient,id:string){
 const {run,row}=await runTx(ctx,c,id),current=await currentInteractionAdmissionTx(responsibleContext(row),c,row.id),
  terms=await termsTx(c,current.row,run.body.termsRef);
 await participantAuthorityTx(ctx,c,row);
 if(run.terms_id!==terms.id)fail('Y3_RUN_TERMS_CHANGED');
 await requireConsentsTx(c,row,terms,'TERMS',terms.ref.contentDigest);
 const history=await historyTx(c,run);await assertHistoryCurrentTx(c,row,history);
 return {run,row:current.row,terms,history};
}
async function readRunTx(ctx:PeMutationContext,c:PoolClient,id:string){
 const {run,row}=await runTx(ctx,c,id),changes=await currentChangesTx(responsibleContext(row),c,row),
  nativeProgramme=run.programme_id&&principal(ctx)===row.principal_id?await readEconomicProgrammeTx(ctx,c,run.programme_id):null;
 const invalid=(reasons:string[])=>({runId:run.id,protocolId:row.id,workId:row.work_id,root:row.root,participant:participantId(ctx,row),
  current:false,status:'INVALIDATED_RESPONSIBILITY_RETAINED',currentnessReasons:reasons,programmeId:run.programme_id,
  local:null,intent:null,history:[],nativeProgramme,protectedQualification:false,financialEfficacyEstablished:false});
 if(changes.length||row.cancelled||row.status!=='CHECKED'||run.terms_id!==row.current_terms_id)
  return invalid(changes);
 const terms=await termsTx(c,row,run.body.termsRef),history=await historyTx(c,run);
 try{
  await assertHistoryCurrentTx(c,row,history);
  await requireConsentsTx(c,row,terms,'TERMS',terms.ref.contentDigest);
 }
 catch(error){
  if(error instanceof InteractionFault)return invalid([error.code]);
  throw error;
 }
 return {runId:run.id,protocolId:row.id,workId:row.work_id,root:row.root,participant:participantId(ctx,row),current:true,status:run.status,
  local:localView(ctx,row,terms,run,history),terms:visibleTerms(row,terms),intent:visibleIntent(run.intent),programmeId:run.programme_id,
  nativeProgramme,
  history:history.filter(e=>e.body.participant===participantId(ctx,row)).map(e=>({id:e.event_id,kind:e.kind,body:e.body})),
  protectedQualification:false,financialEfficacyEstablished:false};
}
export const readInteractionRun=(ctx:PeMutationContext,id:string)=>transaction(ctx,c=>readRunTx(ctx,c,id));
async function refreshIntentTx(c:PoolClient,row:ProtocolRow,terms:InteractionTerms,run:InteractionRun,history:InteractionHistory[]){
 if(run.intent)return;
 const front=frontier(row,history);
 if(!front.length||front.some(f=>f.node.kind!=='TERMINAL'))return;
 const outcomes=front.map(f=>row.request.lowering.outcomes.find(o=>o.modelId===f.modelId&&o.terminalNodeId===f.node.id)!);
 if(outcomes.some(o=>!o)||outcomes.some(o=>!same(effectMeaning(o),effectMeaning(outcomes[0]!))))return;
 const held=await readEconomicReservationTx(responsibleContext(row),c,terms.reservationRef);
 if(held.revision!==terms.reservationRevision||!same(held.economicState.state,terms.initialState))fail('Y3_ORIGINAL_RESERVATION_REVISED',409);
 const body:Omit<InteractionIntent,'ref'>={schema:'finnor.s4.interaction-effect-intent.v1',protocolRef:terms.protocolRef,termsRef:terms.ref,
  runId:run.id,historyDigest:digest(history.map(e=>({id:e.event_id,kind:e.kind,body:e.body}))),reservationRef:terms.reservationRef,
  reservationRevision:held.revision,outcome:outcomes[0]!,matchingTerminalDigests:outcomes.map(o=>o.terminalDigest).sort(),
  actualActorActions:history.filter(e=>e.kind==='ACTION').map(e=>({participant:e.body.participant,principalId:e.principal_id,
   informationKey:e.body.informationKey!,actionId:e.body.actionId!})),validUntil:terms.validUntil,externalEffects:false,executionAuthorityGranted:false};
 const intent={...body,ref:reference('S4','interaction-effect-intent',body)};
 await c.query("UPDATE finnor_os.s4_interaction_runs SET intent=$3::jsonb,status='READY' WHERE tenant_id=$1 AND id=$2",
  [row.tenant_id,run.id,JSON.stringify(intent)]);
 await eventTx(c,row,'S4_EXACT_EFFECT_INTENT','intent:'+run.id,{runId:run.id,intentRef:intent.ref,historyDigest:intent.historyDigest,
  allParticipantExactEffectConsentsRequired:true,hiddenModelSelection:false,executionAuthorityGranted:false});
}
export async function createInteractionTerms(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const input=TermsSchema.parse(raw);
 return transaction(ctx,async c=>{
  const {row,admission}=await currentInteractionAdmissionTx(ctx,c,input.protocolId),requestDigest=digest(input),
   prior=(await c.query<{body:InteractionTerms;request_digest:string}>(`SELECT body,request_digest FROM finnor_os.s4_interaction_terms
    WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`,[row.tenant_id,row.principal_id,input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)fail('Y3_TERMS_IDEMPOTENCY_CONFLICT',409);return visibleTerms(row,prior.body);}
  if(row.request.problem.models.some(m=>m.nodes.some(n=>[...n.payments,...n.liabilities].some(v=>q(v).compare(ZERO)!==0))))
   fail('Y3_FINANCIAL_EFFECT_ADAPTER_UNSUPPORTED');
  if(Date.parse(row.request.problem.dates[2])>=row.deadline_at.getTime())fail('Y3_HORIZON_OUTSIDE_ORIGINAL_EPISODE');
  const held=await readEconomicReservationTx(ctx,c,input.reservationRef),first=row.request.lowering.outcomes[0]!;
  if(held.revision!==input.expectedRevision||held.certificate.theoryId!==row.theory_id||
   !same(held.certificate.theoryRef,row.request.lowering.theoryRef)||!same(held.economicState.state,first.before)||
   row.request.lowering.outcomes.some(o=>!same(o.before,first.before)))fail('Y3_EXACT_ORIGINAL_S5_RESERVATION_REQUIRED',409);
  const revision=Number((await c.query<{revision:number}>('SELECT coalesce(max(revision),0)+1 revision FROM finnor_os.s4_interaction_terms WHERE tenant_id=$1 AND protocol_id=$2',
   [row.tenant_id,row.id])).rows[0]!.revision);
  if(revision>32)fail('Y3_ORIGINAL_TERMS_REVISION_BOUND');
  const body:Omit<InteractionTerms,'ref'>={...coalitionTermsBinding(row),schema:'finnor.s4.interaction-terms.v1',id:randomUUID(),protocolId:row.id,
   protocolRef:row.artifact!.envelope.contentRef,candidateDigest:digest(row.candidate),admissionRef:admission.ref,tenantId:row.tenant_id,
   principalId:row.principal_id,workId:row.work_id,episodeId:row.episode_id,revision,participants:row.request.problem.participants,
   reservationRef:input.reservationRef,reservationRevision:held.revision,initialState:held.economicState.state,lowering:row.request.lowering,
   modelRefs:row.request.problem.actorModelRefs,sourceBindings:row.request.sources,rightsRevision:row.rights_revision,
   validUntil:row.deadline_at.toISOString(),createdAt:new Date().toISOString(),externalEffects:false,financialSettlement:false,executionAuthorityGranted:false},
   terms={...body,ref:reference('S4','interaction-terms',body)};
  await c.query(`INSERT INTO finnor_os.s4_interaction_terms(tenant_id,id,principal_id,protocol_id,episode_id,revision,body,request_digest,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,[row.tenant_id,terms.id,row.principal_id,row.id,row.episode_id,revision,JSON.stringify(terms),requestDigest,input.idempotencyKey]);
  await c.query('UPDATE finnor_os.y3_requests SET current_terms_id=$3 WHERE tenant_id=$1 AND id=$2',[row.tenant_id,row.id,terms.id]);
  await eventTx(c,row,'S4_TERMS_PUBLISHED','terms:'+terms.id,{termsRef:terms.ref,revision,oldConsentsRetainedNotRebound:true,
   originalEpisodeId:row.episode_id,executionAuthorityGranted:false});
  return visibleTerms(row,terms);
 });
}
export async function localInteraction(ctx:PeMutationContext,id:string){
 developmentOnly();
 return transaction(ctx,async c=>{
  const row=await protocolTx(ctx,c,id,false),changes=await currentChangesTx(responsibleContext(row),c,row),
   current=!changes.length&&!row.cancelled&&row.status==='CHECKED'&&!!row.admission;
  const terms=current&&row.current_terms_id?await termsTx(c,row):null;
  const consents=(await c.query('SELECT consent_id,scope,subject_digest,decision,created_at FROM finnor_os.s4_interaction_consents WHERE tenant_id=$1 AND protocol_id=$2 AND principal_id=$3 ORDER BY id DESC LIMIT 64',
   [row.tenant_id,row.id,principal(ctx)])).rows;
  const runs=(await c.query('SELECT id,status,revision,programme_id FROM finnor_os.s4_interaction_runs WHERE tenant_id=$1 AND protocol_id=$2 ORDER BY created_at DESC,id DESC LIMIT 33',
   [row.tenant_id,row.id])).rows;
  return {protocolId:row.id,tenantId:row.tenant_id,principalId:principal(ctx),participant:participantId(ctx,row),workId:row.work_id,root:row.root,
   current,currentnessReasons:changes,status:row.cancelled?'CANCELLED_RESPONSIBILITY_RETAINED':changes.length?'INVALIDATED':row.status,
   terms:terms?visibleTerms(row,terms):null,
   ...(terms?await participantWorkViewTx(c,row,terms,principal(ctx)):{}),
   consents,runs:runs.slice(0,32),truncated:runs.length>32,
   privateModelDataIncluded:false,protectedQualification:false,productionActivated:false,financialEfficacyEstablished:false};
 });
}
export async function recordInteractionConsent(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const input=ConsentSchema.parse(raw);
 const result=await transaction(ctx,async c=>{
  const requestDigest=digest(input),prior=(await c.query<{body:unknown;request_digest:string}>(`SELECT body,request_digest FROM finnor_os.s4_interaction_consents
   WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`,[ctx.auth.tenantId,principal(ctx),input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)fail('Y3_CONSENT_IDEMPOTENCY_CONFLICT',409);return {consent:prior.body,replayed:true};}
  // Withdrawal remains possible for the exact old consent after source/terms
  // invalidation. It confers no new access or authority.
  const row=input.decision==='WITHDRAW'?(await c.query<ProtocolRow>(`SELECT r.*,e.deadline_at FROM finnor_os.y3_requests r
   JOIN finnor_os.y3_episodes e ON e.tenant_id=r.tenant_id AND e.id=r.episode_id WHERE r.tenant_id=$1 AND r.id=$2 FOR UPDATE OF r`,
  [ctx.auth.tenantId,input.protocolId])).rows[0]:await protocolTx(ctx,c,input.protocolId,false);
  if(!row)fail('Y3_PARTICIPANT_UNAVAILABLE',404);
  const party=participantId(ctx,row),terms=(await c.query<{body:InteractionTerms}>(`SELECT body FROM finnor_os.s4_interaction_terms
   WHERE tenant_id=$1 AND protocol_id=$2 AND body->'ref'->>'contentDigest'=$3`,
  [row.tenant_id,row.id,input.termsRef.contentDigest])).rows[0]?.body;
  if(!terms||!same(terms.ref,input.termsRef))fail('Y3_EXACT_CONSENT_TERMS_REQUIRED');
  if(input.scope==='TERMS'&&input.subjectDigest!==terms.ref.contentDigest)fail('Y3_TERMS_CONSENT_SUBJECT');
  if(input.scope==='EFFECT'&&!(await c.query(`SELECT 1 FROM finnor_os.s4_interaction_runs WHERE tenant_id=$1 AND protocol_id=$2
   AND terms_id=$3 AND intent->'ref'->>'contentDigest'=$4`,[row.tenant_id,row.id,terms.id,input.subjectDigest])).rowCount)
   fail('Y3_EXACT_EFFECT_INTENT_REQUIRED');
  if(input.decision==='ACCEPT'){
   await currentInteractionAdmissionTx(responsibleContext(row),c,row.id);await termsTx(c,row,input.termsRef);
   await participantAuthorityTx(ctx,c,row);
  }
  const body={schema:'finnor.s4.interaction-consent.v1',consentId:randomUUID(),protocolId:row.id,termsRef:terms.ref,
   participant:party,principalId:principal(ctx),scope:input.scope,subjectDigest:input.subjectDigest,decision:input.decision,
   rightsRevision:row.rights_revision,recordedAt:new Date().toISOString(),validUntil:terms.validUntil,
   authentication:'CURRENT_SIGNED_BEARER_CANONICAL_PARTICIPANT',assertionNotSourcedTruth:true,executionAuthorityGranted:false};
  await c.query(`INSERT INTO finnor_os.s4_interaction_consents(tenant_id,consent_id,principal_id,protocol_id,terms_id,episode_id,
   scope,subject_digest,decision,body,request_digest,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
  [row.tenant_id,body.consentId,principal(ctx),row.id,terms.id,row.episode_id,input.scope,input.subjectDigest,input.decision,
   JSON.stringify(body),requestDigest,input.idempotencyKey]);
  await eventTx(c,row,'PARTICIPANT_CONSENT','consent:'+body.consentId,{consentId:body.consentId,participant:party,scope:input.scope,
   termsRef:terms.ref,subjectDigest:input.subjectDigest,decision:input.decision,oldConsentsNotRebound:true});
  return {consent:body,replayed:false};
 });
 if(input.scope==='TERMS'&&input.decision==='ACCEPT')
  return {...result,participantWork:await ensureParticipantWork(ctx,input.protocolId,input.termsRef)};
 return result;
}
export async function startInteraction(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const input=StartSchema.parse(raw);
 return transaction(ctx,async c=>{
  const {row}=await currentInteractionAdmissionTx(ctx,c,input.protocolId),terms=await termsTx(c,row,input.termsRef),requestDigest=digest(input),
   prior=(await c.query<{id:string;request_digest:string}>(`SELECT id,request_digest FROM finnor_os.s4_interaction_runs
    WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`,[row.tenant_id,row.principal_id,input.idempotencyKey])).rows[0];
  if(prior){if(prior.request_digest!==requestDigest)fail('Y3_START_IDEMPOTENCY_CONFLICT',409);return readRunTx(ctx,c,prior.id);}
  await requireConsentsTx(c,row,terms,'TERMS',terms.ref.contentDigest);
  const held=await readEconomicReservationTx(ctx,c,terms.reservationRef);
  if(held.revision!==terms.reservationRevision||!same(held.economicState.state,terms.initialState))fail('Y3_ORIGINAL_RESERVATION_REVISED',409);
  if(!(await c.query('UPDATE finnor_os.y3_episodes SET uses_used=uses_used+1 WHERE tenant_id=$1 AND id=$2 AND uses_used<32 RETURNING id',
   [row.tenant_id,row.episode_id])).rowCount)fail('Y3_ORIGINAL_CONTINUATION_BOUND');
  const id=randomUUID(),body={schema:'finnor.s4.interaction-run.v1' as const,id,protocolRef:terms.protocolRef,termsRef:terms.ref,createdAt:new Date().toISOString()},
   origin={...body,ref:reference('S4','interaction-run',body)};
  await c.query(`INSERT INTO finnor_os.s4_interaction_runs(tenant_id,id,principal_id,protocol_id,terms_id,episode_id,body,request_digest,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,[row.tenant_id,id,row.principal_id,row.id,terms.id,row.episode_id,JSON.stringify(origin),requestDigest,input.idempotencyKey]);
  await eventTx(c,row,'S4_CONTINUATION_STARTED','run:'+id,{runId:id,termsRef:terms.ref,originalEpisodeId:row.episode_id,
   noHiddenStateOrModelNodeAccepted:true});
  return readRunTx(ctx,c,id);
 });
}
async function historyReplayTx(ctx:PeMutationContext,c:PoolClient,idempotencyKey:string,requestDigest:string,runId:string){
 const prior=(await c.query<{run_id:string;request_digest:string}>(`SELECT run_id,request_digest FROM finnor_os.s4_interaction_history
  WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3`,[ctx.auth.tenantId,principal(ctx),idempotencyKey])).rows[0];
 if(!prior)return null;
 if(prior.request_digest!==requestDigest||prior.run_id!==runId)fail('Y3_HISTORY_IDEMPOTENCY_CONFLICT',409);
 return readRunTx(ctx,c,runId);
}
export async function recordInteractionObservation(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const input=ObserveSchema.parse(raw);
 return transaction(ctx,async c=>{
  const requestDigest=digest(input),replay=await historyReplayTx(ctx,c,input.idempotencyKey,requestDigest,input.runId);if(replay)return replay;
  const {run,row,terms,history}=await currentRunTx(ctx,c,input.runId),party=participantId(ctx,row),
   rule=row.request.problem.observationRules.find(r=>r.key===input.key),front=frontier(row,history);
  if(run.revision!==input.expectedRevision||run.status!=='ACTIVE')fail('Y3_CURRENT_HISTORY_REVISION_REQUIRED',409);
  if(!rule||rule.classification!==input.classification||!rule.allowedRecipients.some(r=>r===party||r==='PUBLIC')||
   Date.parse(row.request.problem.dates[input.date]!)>Date.now()||
   !front.some(f=>f.node.observations[participantIndex(party)]!.some(o=>o.date===input.date&&o.key===input.key&&o.value===input.value)))
   fail('Y3_LAWFULLY_AVAILABLE_OBSERVATION_REQUIRED');
  const effective=input.classification==='SOURCED_FACT';
  if(effective){
   if(!input.source)fail('Y3_CANONICAL_FACT_SOURCE_REQUIRED');
   const claim=await sourceClaimTx(ctx,c,row.root,input.source);
   if(!claim||claim.kind!=='INTERACTION_OBSERVATION'||claim.problemDigest!==digest(row.request.problem)||claim.participant!==party||
    claim.date!==input.date||claim.observationKey!==input.key||claim.value!==input.value||claim.classification!=='SOURCED_FACT'||
    !observationTimesCurrent(claim))
    fail('Y3_EXACT_CANONICAL_OBSERVATION_REQUIRED');
  }
  const body={participant:party,principalId:principal(ctx),date:input.date,key:input.key,value:input.value,
   classification:input.classification,...(input.source?{source:input.source}:{}),effective};
  await c.query(`INSERT INTO finnor_os.s4_interaction_history(tenant_id,event_id,principal_id,run_id,protocol_id,episode_id,kind,body,request_digest,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,'OBSERVATION',$7::jsonb,$8,$9)`,[row.tenant_id,randomUUID(),principal(ctx),run.id,row.id,row.episode_id,
   JSON.stringify(body),requestDigest,input.idempotencyKey]);
  const next=await historyTx(c,run);
  if(!frontier(row,next).length)fail('Y3_OBSERVATION_CONTRADICTS_ORIGINAL_HISTORY');
  await c.query('UPDATE finnor_os.s4_interaction_runs SET revision=revision+1 WHERE tenant_id=$1 AND id=$2',[row.tenant_id,run.id]);
  await refreshIntentTx(c,row,terms,run,next);return readRunTx(ctx,c,run.id);
 });
}
export async function recordInteractionAction(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const input=ActionSchema.parse(raw);
 return transaction(ctx,async c=>{
  const requestDigest=digest(input),replay=await historyReplayTx(ctx,c,input.idempotencyKey,requestDigest,input.runId);if(replay)return replay;
  const {run,row,terms,history}=await currentRunTx(ctx,c,input.runId),view=localView(ctx,row,terms,run,history);
  if(run.revision!==input.expectedRevision||view.viewDigest!==input.viewDigest)fail('Y3_EXACT_PARTICIPANT_LOCAL_VIEW_REQUIRED',409);
  if(!view.informationKey||!view.actions.some(a=>a.id===input.actionId))fail('Y3_LOCAL_PERMITTED_ACTION_REQUIRED');
  const body={participant:view.participant,principalId:principal(ctx),informationKey:view.informationKey,actionId:input.actionId,viewDigest:input.viewDigest};
  await c.query(`INSERT INTO finnor_os.s4_interaction_history(tenant_id,event_id,principal_id,run_id,protocol_id,episode_id,kind,body,request_digest,idempotency_key)
   VALUES($1,$2,$3,$4,$5,$6,'ACTION',$7::jsonb,$8,$9)`,[row.tenant_id,randomUUID(),principal(ctx),run.id,row.id,row.episode_id,
   JSON.stringify(body),requestDigest,input.idempotencyKey]);
  await c.query('UPDATE finnor_os.s4_interaction_runs SET revision=revision+1 WHERE tenant_id=$1 AND id=$2',[row.tenant_id,run.id]);
  await refreshIntentTx(c,row,terms,run,await historyTx(c,run));return readRunTx(ctx,c,run.id);
 });
}
export async function materializeInteraction(ctx:PeMutationContext,raw:unknown){
 developmentOnly();const input=MaterializeSchema.parse(raw);
 return transaction(ctx,async c=>{
  const {run,row,terms,history}=await currentRunTx(ctx,c,input.runId);
  if(principal(ctx)!==row.principal_id)fail('Y3_RESPONSIBLE_OWNER_REQUIRED',403);
  if(!run.intent||!same(run.intent.ref,input.intentRef))fail('Y3_EXACT_EFFECT_INTENT_REQUIRED');
  const {ref,...intentBody}=run.intent;
  if(!same(ref,reference('S4','interaction-effect-intent',intentBody))||
   run.intent.historyDigest!==digest(history.map(e=>({id:e.event_id,kind:e.kind,body:e.body}))))fail('Y3_EFFECT_INTENT_PREIMAGE');
  if(run.programme_id)return {runId:run.id,programmeId:run.programme_id,intentRef:run.intent.ref,replayed:true};
  const termsConsentIds=await requireConsentsTx(c,row,terms,'TERMS',terms.ref.contentDigest),
   effectConsentIds=await requireConsentsTx(c,row,terms,'EFFECT',run.intent.ref.contentDigest),outcome=run.intent.outcome;
  if(outcome.kind==='NO_EFFECT')return {runId:run.id,programmeId:null,status:'MODEL_TERMINAL_NO_EFFECT',observedEconomicOutcome:false};
  const programme=await createEconomicProgrammeTx(ctx,c,{theoryId:row.theory_id,reservationRef:terms.reservationRef,
   expectedRevision:run.intent.reservationRevision,goalState:outcome.after,parameters:outcome.parameters,idempotencyKey:'y3:'+input.idempotencyKey},
  {operatorId:outcome.operatorId,parameters:outcome.parameters,before:outcome.before,after:outcome.after});
  const body:Omit<ProgrammeBinding,'ref'>={schema:'finnor.s4.interaction-programme-binding.v1',protocolId:row.id,
   protocolRef:terms.protocolRef,termsRef:terms.ref,runId:run.id,programmeId:programme.id,programmeRef:programme.ref,
   intent:run.intent,termsConsentIds,effectConsentIds,originalEpisodeId:row.episode_id,externalEffects:false,executionAuthorityGranted:false},
   binding={...body,ref:reference('S4','interaction-programme-binding',body)};
  await c.query(`INSERT INTO finnor_os.s4_interaction_programme_bindings(tenant_id,programme_id,principal_id,protocol_id,terms_id,run_id,episode_id,body)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[row.tenant_id,programme.id,row.principal_id,row.id,terms.id,run.id,row.episode_id,JSON.stringify(binding)]);
  await c.query("UPDATE finnor_os.s4_interaction_runs SET programme_id=$3,status='MATERIALIZED' WHERE tenant_id=$1 AND id=$2",
   [row.tenant_id,run.id,programme.id]);
  await eventTx(c,row,'P1_S4_S5_FIXED_LOWERING','programme:'+programme.id,{bindingRef:binding.ref,programmeRef:programme.ref,
   exactIntentRef:run.intent.ref,termsConsentIds,effectConsentIds,originalEpisodeId:row.episode_id,externalEffects:false});
  return {runId:run.id,programmeId:programme.id,programmeRef:programme.ref,intentRef:run.intent.ref,replayed:false};
 });
}
export async function interactionProgramme(ctx:PeMutationContext,runId:string,recovery=false){
 return transaction(ctx,async c=>{
  const {run,row}=await runTx(ctx,c,runId);
  if(principal(ctx)!==row.principal_id)fail('Y3_RESPONSIBLE_OWNER_REQUIRED',403);
  if(!run.programme_id)fail('Y3_NATIVE_PROGRAMME_REQUIRED');
  if(!recovery)await currentRunTx(ctx,c,runId);
  return {programmeId:run.programme_id,protocolId:row.id,workId:row.work_id};
 });
}

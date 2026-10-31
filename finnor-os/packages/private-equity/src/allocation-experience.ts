import {z} from 'zod';
import type {AllocationCertificate,AllocationResource,CanonicalAllocationProblem,ExperimentRef,S5ExperienceEvent} from '@finnor/shared-types';
import {AllocationContractError,AllocationOperationSchemas,allocationRef,sameAllocationRef} from '../../epistemic-runtime/src/allocation-contracts';
import {verifyAllocationCertificateAsync} from '../../epistemic-runtime/src/allocation-verifier';
import {epistemicHash} from '../../epistemic-runtime/src/source-precedence';
import {withS5PortfolioTransaction,authorizeAllocationResourceReads} from './allocation-store';
import {assertEnterpriseAllocationInputVisibility,assertEnterpriseAllocationSourceVisibility} from './enterprise-allocation';
import {revisions} from './owner-context';
import type {PeMutationContext} from './types';
import {assertTotalTypedSources} from './allocation-total-episodes';

const requestSchema=z.object({knowledgeCut:z.string().datetime()}).strict();
const selectionRule='ALL_ORIGINAL_S5_EPISODES_FOR_AUTHENTICATED_PRINCIPAL' as const;
function fail(message:string):never{throw new AllocationContractError('PERMITTED_CONTEXT_UNAVAILABLE',message);}
interface EventRow{event_id:string;body:S5ExperienceEvent;recorded_at:Date;known_at:Date|null}
interface ProposalRow{content_digest:string;problem:CanonicalAllocationProblem;certificate:AllocationCertificate;created_at:Date;known_at:Date|null}
export interface AllocationEpisodeCut{
 schema:'finnor.s5.owner-episode-cut.v1';semanticOwner:'S5';tenantId:string;principalId:string;knowledgeCut:string;
 selectionRule:typeof selectionRule;episodes:string[];
 records:{ref:ExperimentRef;episodeId:string;kind:S5ExperienceEvent['type'];knowledgeAt:string;body:S5ExperienceEvent}[];
 acceptedAllocations:{problem:CanonicalAllocationProblem;certificate:AllocationCertificate;knowledgeAt:string;
  acceptance:'ORIGINAL_S5_CERTIFICATE_INDEPENDENTLY_RECHECKED_MODEL_ONLY'}[];
 futureKnowledgeExcluded:ExperimentRef[];sourceRevisions:Awaited<ReturnType<typeof revisions>>;
 cutDigest:string;businessCompletionAccepted:false;protectedReceipt:null;
 qualification:'COMPLETE_BOUNDED_PRINCIPAL_S5_CENSUS_NOT_INDEPENDENT_FAMILY_ACCEPTANCE_OR_FIELD_TRUTH';
}

function committedAt(created:Date,known:Date|null,declared?:string){
 const claimed=declared?Date.parse(declared):0;
 if(!known||!Number.isFinite(known.getTime())||!Number.isFinite(claimed))fail('S5_EPISODE_IMMUTABLE_COMMIT_CLOCK_REQUIRED');
 return new Date(Math.max(created.getTime(),known.getTime(),claimed));
}

/** S5 owns the census. A caller cannot omit an adverse sibling by naming a head. */
export async function readAllocationEpisodeCut(ctx:PeMutationContext,value:unknown,deadlineAt=Date.now()+28500):Promise<AllocationEpisodeCut>{
 const parsed=requestSchema.safeParse(value);if(!parsed.success)fail('S5_EPISODE_REQUEST_OR_SELECTION_INVALID');
 const input=parsed.data,cut=Date.parse(input.knowledgeCut),principalId=ctx.auth.employeeId??ctx.auth.userId;
 if(!Number.isFinite(cut)||cut>Date.now())fail('S5_EPISODE_KNOWLEDGE_CUT_INVALID');
 const budget=()=>{if(Date.now()>=deadlineAt)throw new AllocationContractError('LIMIT_EXCEEDED','S5_EPISODE_ORIGINAL_READ_DEADLINE');};
 const load=()=>withS5PortfolioTransaction(ctx,async c=>{
  budget();
  if((await c.query("SELECT current_setting('track_commit_timestamp') enabled")).rows[0]?.enabled!=='on')
   fail('S5_EPISODE_IMMUTABLE_COMMIT_CLOCK_REQUIRED');
  const session=(await c.query("SELECT finnor_os.request_tenant_id() tenant_id,nullif(current_setting('app.user_id',true),'') principal_id")).rows[0];
  if(session?.tenant_id!==ctx.auth.tenantId||session?.principal_id!==principalId)fail('S5_EPISODE_PRINCIPAL_CENSUS_CONTEXT_UNAVAILABLE');
  const events=(await c.query<EventRow>(`SELECT event_id,body,recorded_at,pg_xact_commit_timestamp(xmin) known_at
   FROM finnor_os.s5_experience WHERE tenant_id=$1 AND principal_id=$2 ORDER BY recorded_at,event_id LIMIT 1025`,
   [ctx.auth.tenantId,principalId])).rows;
  const proposals=(await c.query<ProposalRow>(`SELECT content_digest,problem,certificate,created_at,pg_xact_commit_timestamp(xmin) known_at
   FROM finnor_os.s5_proposals WHERE tenant_id=$1 AND principal_id=$2 AND demand IS NULL
   ORDER BY created_at,content_digest LIMIT 65`,[ctx.auth.tenantId,principalId])).rows;
  if(events.length>1024||proposals.length>64)throw new AllocationContractError('LIMIT_EXCEEDED','S5_EPISODE_COMPLETE_CENSUS_BOUND');
  const episodeIds=new Set(events.map(e=>e.body.episodeId));
  if(episodeIds.size>32||proposals.some(p=>!episodeIds.has(p.problem.episodeId)))fail('S5_EPISODE_COMPLETE_CENSUS_UNAVAILABLE');
  const requested=events.filter(e=>e.body.type==='REQUEST').map(e=>AllocationOperationSchemas.clear.parse(e.body.detail.input));
  const refs=[...new Map(requested.flatMap(r=>r.resourceRefs).map(r=>[r.contentDigest,r])).values()];
  if(refs.length>128)throw new AllocationContractError('LIMIT_EXCEEDED','S5_EPISODE_RESOURCE_PREIMAGE_BOUND');
  const resources=refs.length?(await c.query<{body:AllocationResource}>(
   'SELECT body FROM finnor_os.s5_resources WHERE tenant_id=$1 AND content_digest=ANY($2::text[]) ORDER BY content_digest LIMIT 129',
   [ctx.auth.tenantId,refs.map(r=>r.contentDigest)])).rows.map(r=>r.body):[];
  if(resources.length!==refs.length||refs.some(ref=>!resources.some(r=>sameAllocationRef(ref,r.ref))))fail('S5_EPISODE_RESOURCE_PREIMAGE_UNAVAILABLE');
  await authorizeAllocationResourceReads(ctx,c,resources);
  const sourceRevisions=await revisions(ctx,['rights:tenant','m3:s5-complete'],c,true);
  const result={events,proposals,resources,sourceRevisions};
  if(Buffer.byteLength(JSON.stringify(result))>8388608)throw new AllocationContractError('LIMIT_EXCEEDED','S5_EPISODE_COMPLETE_BYTES_BOUND');
  return result;
 });
 const initial=await load();
 for(const event of initial.events){
  budget();const {eventId,...body}=event.body;
  if(eventId!==event.event_id||eventId!==`s5-event:${epistemicHash(body)}`||
    event.body.tenantId!==ctx.auth.tenantId||event.body.principalId!==principalId||
    event.body.contentDigest!==epistemicHash(event.body.detail))fail('S5_EPISODE_IMMUTABLE_EVENT_INVALID');
  if(event.body.type==='REQUEST'){
   const request=AllocationOperationSchemas.clear.parse(event.body.detail.input);
   await assertEnterpriseAllocationInputVisibility(ctx,request,initial.resources.filter(r=>request.resourceRefs.some(ref=>sameAllocationRef(ref,r.ref))));
  }
 }
 await assertTotalTypedSources(ctx,initial.events.map(row=>({body:row.body,kind:row.body.type,ref:{
  owner:'S5',id:row.event_id,version:'s5-experience-v1',contentDigest:epistemicHash(row.body)}})),deadlineAt);
 const accepted:AllocationEpisodeCut['acceptedAllocations']=[];
 for(const proposal of initial.proposals){
  budget();const {ref,...body}=proposal.certificate,{ref:problemRef,...problemBody}=proposal.problem;
  if(proposal.content_digest!==ref.contentDigest||!sameAllocationRef(ref,allocationRef('S5','allocation-certificate',body))||
    !sameAllocationRef(problemRef,allocationRef('S5','allocation-problem',problemBody))||
    !sameAllocationRef(proposal.certificate.problemRef,problemRef)||proposal.problem.tenantId!==ctx.auth.tenantId||
    proposal.problem.principalId!==principalId)fail('S5_EPISODE_IMMUTABLE_PROPOSAL_INVALID');
  await assertEnterpriseAllocationSourceVisibility(ctx,proposal.problem);
  const known=committedAt(proposal.created_at,proposal.known_at);
  if(known.getTime()<=cut){
   await verifyAllocationCertificateAsync(proposal.problem,proposal.certificate,Math.max(1,deadlineAt-Date.now()));
   accepted.push({problem:proposal.problem,certificate:proposal.certificate,knowledgeAt:known.toISOString(),
    acceptance:'ORIGINAL_S5_CERTIFICATE_INDEPENDENTLY_RECHECKED_MODEL_ONLY'});
  }
 }
 const final=await load();
 if(epistemicHash(initial)!==epistemicHash(final))fail('S5_EPISODE_SOURCE_OR_COMPLETE_CENSUS_CHANGED');
 const records:AllocationEpisodeCut['records']=[],futureKnowledgeExcluded:ExperimentRef[]=[];
 for(const row of initial.events){
  const known=committedAt(row.recorded_at,row.known_at,row.body.knowledgeAt),ref:ExperimentRef={
   owner:'S5',id:row.event_id,version:'s5-experience-v1',contentDigest:epistemicHash(row.body)};
  if(known.getTime()>cut)futureKnowledgeExcluded.push(ref);
  else records.push({ref,episodeId:row.body.episodeId,kind:row.body.type,knowledgeAt:known.toISOString(),body:row.body});
 }
 for(const p of initial.proposals)if(committedAt(p.created_at,p.known_at).getTime()>cut)futureKnowledgeExcluded.push(p.certificate.ref);
 const core={schema:'finnor.s5.owner-episode-cut.v1' as const,semanticOwner:'S5' as const,tenantId:ctx.auth.tenantId,principalId,
  knowledgeCut:input.knowledgeCut,selectionRule,episodes:[...new Set(records.map(r=>r.episodeId))].sort(),records,
  acceptedAllocations:accepted,futureKnowledgeExcluded,sourceRevisions:initial.sourceRevisions,
  businessCompletionAccepted:false as const,protectedReceipt:null,
  qualification:'COMPLETE_BOUNDED_PRINCIPAL_S5_CENSUS_NOT_INDEPENDENT_FAMILY_ACCEPTANCE_OR_FIELD_TRUTH' as const};
 return {...core,cutDigest:epistemicHash(core)};
}

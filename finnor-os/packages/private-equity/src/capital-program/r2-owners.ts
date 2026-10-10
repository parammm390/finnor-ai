import {z} from 'zod';
import type {ControlDecisionInput,ControlDecision,ExperimentRef,ContingentPolicy} from '@finnor/shared-types';
import type {ExactControlSource,R2OriginalProblem,ExactContingentPolicy} from '@finnor/shared-types/src/robust-programme-search';
import {R2_PROFILE,R2_VERSION} from '@finnor/shared-types/src/robust-programme-search';
import {controlInstrumentSupports} from '../../../epistemic-runtime/src/control-observations';
import {r2Quantity as q} from '../../../epistemic-runtime/src/r2-rational';
import {readSourceObject} from '../deliberation/store';
import {revisions,assertDependencies} from '../evidence-execution/store';
import type {PeMutationContext,PeWorldRootRef} from '../types';
import type {CapitalOwnerBinding} from './v2-owners';
import type {CapitalProgramV2Request} from './v2-contracts';
import {m3Hash,m3Same,CapitalProgramV2Error} from './v2-contracts';
import {loadR2Runtime,r2Ref,type R2Runtime} from './r2-native';
import {m3Tx} from './v2-store';

const token=z.string().min(1).max(1025),id=z.string().min(1).max(256),ref=z.object({owner:id,id:z.string().min(1).max(512),version:id,contentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const sourceSchema=z.object({schema:z.literal('finnor.s3.exact-control-source.v1'),qualification:z.literal('SUPPLIED_EXACT_FINITE_MODEL_UNADMITTED'),
 mandateRef:ref,problemDigest:z.string().regex(/^[a-f0-9]{64}$/),modelRef:ref,quantities:z.record(token),
 accounting:z.object({ref,entityRef:ref,unit:id,currency:z.string().regex(/^[A-Z]{3}$/).nullable(),valuationDate:z.string().datetime(),ownerShare:token,
  timeBasis:z.object({startAt:z.string().datetime(),periodMs:z.number().int().positive(),periods:z.number().int().min(1).max(24)}).strict(),discountConvention:z.literal('ORIGINAL_OWNER_FACTORS')}).strict(),
 mechanisms:z.array(z.object({id,equations:z.array(z.object({variableId:id,features:z.array(z.unknown()).min(1).max(64)}).strict()).min(1).max(8)}).strict()).min(1).max(8),
 stateUnits:z.record(id),stateRanges:z.record(z.tuple([token,token])),exposureIds:z.array(id).min(1).max(4),
 worlds:z.array(z.object({id,mechanismId:id,initialHistory:z.array(z.object({states:z.record(token),exposures:z.record(token)}).strict()).min(1).max(3),
  coefficients:z.array(z.array(token).min(1).max(64)).min(1).max(8),shocks:z.array(z.array(token).min(1).max(8)).min(1).max(24),
  inquiryTokens:z.record(z.array(z.string().min(1).max(4096)).min(1).max(24)),accruedUtility:token}).strict()).min(1).max(32),
 completeWorldDeclaration:z.literal('ALL_DECLARED_JOINT_WORLDS_NO_PROBABILITIES')}).strict();

export interface R2OwnerBinding {original:R2OriginalProblem;runtimeRef:ExperimentRef;runtimeManifest:R2Runtime['manifest'];checkerIdentity:R2Runtime['checkerIdentity'];admissionCost?:{cpuMs:number;wallMs:number;memoryBytes:number;money:null}}
/** Catalogue current S1 bytes under the already authorized root. A catalogue
 * entry is a supplied hypothesis, not qualification or a source receipt. */
export async function listR2ExactSources(ctx:PeMutationContext,root:PeWorldRootRef,policies:ContingentPolicy[]){
 const roots=[root,...policies.flatMap(p=>p.bindings.beliefPins.map(pin=>pin.root))].filter((r,i,all)=>all.findIndex(p=>m3Same(p,r))===i);
 const rows=await m3Tx(ctx,async client=>(await client.query<{source_id:string;id:string;content:string;snapshot:{worldRoot:PeWorldRootRef}}>(
  `SELECT v.source_id,v.id,v.content,v.snapshot FROM finnor_os.evidence_source_versions v
   WHERE v.tenant_id=$1 AND v.scope='tenant' AND v.snapshot->'worldRoot'=ANY($2::jsonb[])
    AND v.content LIKE '%"finnor.s3.exact-control-source.v1"%'
    AND v.version_number=(SELECT max(h.version_number) FROM finnor_os.evidence_source_versions h WHERE h.tenant_id=v.tenant_id AND h.source_id=v.source_id)
   ORDER BY v.source_id LIMIT 33`,[ctx.auth.tenantId,roots.map(r=>JSON.stringify(r))])).rows,true);
 if(rows.length>32)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Current exact-source catalogue exceeds its bounded reader');
 const sources=[];for(const item of rows){
  const row=await readSourceObject(ctx,item.snapshot.worldRoot,item.source_id,item.id);let parsed:ReturnType<typeof sourceSchema.safeParse>;
  try{parsed=sourceSchema.safeParse(JSON.parse(row.content));}catch{continue;}
  if(!parsed.success)continue;const source=parsed.data;
  if(Date.parse(row.as_of)>Date.now()||Date.parse(row.retrieved_at)>Date.now())continue;
  const policy=policies.find(p=>m3Same(p.mandateRef,source.mandateRef)&&m3Same(p.problem.modelRef,source.modelRef)&&m3Hash(p.problem)===source.problemDigest);
  if(policy)sources.push({sourceId:item.source_id,versionId:item.id,contentDigest:row.content_hash,policyRef:policy.ref,
   worldIds:source.worlds.map(w=>w.id),qualification:source.qualification});
 }return sources;
}
export async function resolveR2Owners(ctx:PeMutationContext,request:CapitalProgramV2Request,binding:CapitalOwnerBinding):Promise<R2OwnerBinding>{
 const r=request.robust!;if(!r)throw new CapitalProgramV2Error('INVALID_REQUEST','R2 exact source request is absent');
 if(request.financial)throw new CapitalProgramV2Error('INVALID_REQUEST','This exact finite owner profile requires original S4 utility; a separate native finance IR needs its own exact correspondence adapter');
 if(request.permitted.agreement!=='UNILATERAL_PROPOSAL')
  throw new CapitalProgramV2Error('BLOCKED_SELECTION','R2_ACCEPTANCE_PRIMITIVE_UNAVAILABLE: the exact finite adapter cannot establish received acceptance of new counterparty terms');
 if(binding.outstandingEffects.length)
  throw new CapitalProgramV2Error('BLOCKED_SELECTION','R2_UNACCOUNTED_S6_OBLIGATION: resolve retained unknown/partial effects through the current S6 owner before an exact financial feasibility claim');
 const root=binding.model.request.roots[0];if(!root)throw new CapitalProgramV2Error('CHECK_FAILED','Original exact model has no permitted owner root');
 const row=await readSourceObject(ctx,root,r.source.sourceId,r.source.versionId);
 if(row.content_hash!==r.source.contentDigest||Date.parse(row.as_of)>Date.now()||Date.parse(row.retrieved_at)>Date.now())
  throw new CapitalProgramV2Error('STALE_INPUT','Exact source bytes, knowledge time or current version differs');
 let source:ExactControlSource;
 try{source=sourceSchema.parse(JSON.parse(row.content)) as ExactControlSource;}catch{throw new CapitalProgramV2Error('INVALID_REQUEST','Complete versioned supplied exact S3 source is required');}
 if(!m3Same(source.mandateRef,binding.policy.mandateRef)||source.problemDigest!==m3Hash(binding.policy.problem)||!m3Same(source.modelRef,binding.model.ref)||
  !m3Same(source.mechanisms,binding.model.request.mechanisms.map(m=>({id:m.id,equations:m.equations})))||
  !m3Same(source.accounting.ref,binding.policy.mandate.utility.accountingConventionRef)||source.accounting.entityRef.id!==root.entityId||
  source.accounting.unit!==binding.policy.mandate.utility.unit||!m3Same(source.accounting.timeBasis,binding.policy.mandate.horizon)||
  source.accounting.currency!==(/^[A-Z]{3}$/.test(source.accounting.unit)?source.accounting.unit:null))
  throw new CapitalProgramV2Error('CHECK_FAILED','Exact supplied model changed original mandate, mechanism, entity, unit, currency or time conventions');
 if(new Set(source.worlds.map(w=>w.id)).size!==source.worlds.length||r.initialWorlds.some(id=>!source.worlds.some(w=>w.id===id)))
  throw new CapitalProgramV2Error('INVALID_REQUEST','Complete/initial world membership differs');
 for(const value of Object.values(source.quantities))q(value);
 const runtime=await loadR2Runtime(),supports=controlInstrumentSupports(binding.protocols,binding.model,binding.policy.mandate,binding.policy.problem),
  protocols=supports.map(p=>{
   const index=binding.policy.problem.actions.findIndex(a=>m3Same(a.protocolRef,p.protocolRef)),registered=binding.protocols.find(protocol=>protocol.id===p.protocolRef.id&&protocol.contentDigest===p.protocolRef.contentDigest),
    completeCost=source.quantities[`/problem/actions/${index}/cost`];
   if(index<0||!registered?.candidate.costEstimate.money||!completeCost||q(registered.candidate.costEstimate.money.value).compare(q(completeCost))>0)
    throw new CapitalProgramV2Error('CHECK_FAILED','Exact original S2 complete inquiry cost is unknown or omitted');
   return {ref:p.protocolRef,tokensByMechanism:p.tokensByMechanism,delayPeriods:p.delayPeriods,completeCost};
  });
 const original:R2OriginalProblem={schema:'finnor.r2.original.v1',version:R2_VERSION,profile:R2_PROFILE,source,
  sourceRef:{owner:'S1',id:`source-version:${r.source.versionId}`,version:'current-exact-source-v1',contentDigest:r.source.contentDigest},
  mandate:binding.policy.mandate,problem:binding.policy.problem,incumbentPolicyRef:binding.policy.ref,modelRequest:binding.model.request,
  modelHistory:binding.model.history.rows.slice(-3).map(row=>({states:row.states,exposures:row.exposures})),
  resourceScopeRoots:binding.policy.bindings.beliefPins.map(pin=>pin.root),
  permitted:request.permitted,protocols,
  resources:binding.resources,owner:{tenantId:ctx.auth.tenantId,principalId:ctx.auth.userId,workId:binding.work.id,inputId:binding.work.inputId,inputDigest:binding.work.inputDigest,
    planId:binding.plan.id,planDigest:binding.plan.semanticHash,ownerVector:binding.ownerVector,dependencies:binding.dependencies,
    knowledgeAt:new Date().toISOString(),validUntil:binding.validUntil,outstandingEffects:binding.outstandingEffects}};
 return {original,runtimeRef:runtime.ref,runtimeManifest:runtime.manifest,checkerIdentity:runtime.checkerIdentity};
}
export async function assertR2Current(ctx:PeMutationContext,request:CapitalProgramV2Request,binding:CapitalOwnerBinding):Promise<void>{
 if(!binding.r2)return;
 await assertDependencies(ctx,binding.dependencies);
 const root=binding.model.request.roots[0]!,r=request.robust!,row=await readSourceObject(ctx,root,r.source.sourceId,r.source.versionId),runtime=await loadR2Runtime();
 if(row.content_hash!==r.source.contentDigest||!m3Same(runtime.ref,binding.r2.runtimeRef)||Date.now()>=Date.parse(binding.validUntil))
  throw new CapitalProgramV2Error('STALE_INPUT','R2 exact source, scientific runtime/checker or original validity changed');
}
export const r2SourceDependencies=(ctx:PeMutationContext,request:CapitalProgramV2Request)=>revisions(ctx,[`evidence:${request.robust!.source.sourceId}`,`source-version:${request.robust!.source.versionId}`]);

/** Same S4 original action-history and received-observation lookup. This adapter
 * never accepts a private-world selector, resource clearance or solver receipt. */
export function chooseExactS4Branch(policy:ExactContingentPolicy,decision:ControlDecisionInput):ControlDecision{
 const now=Date.parse(decision.knowledgeAt),o=policy.original;
 if(!Number.isFinite(now)||now>Date.now()||now<Date.parse(policy.knowledgeAt)||now>=Date.parse(policy.validUntil)||
  decision.rightsRef!==o.mandate.rightsRef||!m3Same(decision.obligations,o.problem.obligations)||
  decision.actionHistory.length!==decision.period||decision.observations.some(v=>v.availablePeriod>decision.period||Date.parse(v.knowledgeAt)>now))
  throw new CapitalProgramV2Error('STALE_INPUT','Original exact branch knowledge, rights, observations or obligations differ');
 const observations=decision.observations.map(({instrumentId,token,availablePeriod})=>({instrumentId,token,availablePeriod})),
  node=policy.decisions.find(d=>d.period===decision.period&&m3Same(d.actionHistory,decision.actionHistory)&&m3Same(d.observations,observations)),
  body={schema:'finnor.s4.branch-choice.v1' as const,policyRef:policy.ref,status:node?'POLICY_AVAILABLE' as const:'MODEL_UNSUPPORTED' as const,
   nodeId:node?r2Ref('original-history',node,'S4').id:null,actionId:node?.actionId??null,contextDigest:m3Hash(decision),
   reasons:node?['MODEL_RELATIVE_EXACT_ORIGINAL_HISTORY_NO_AUTHORITY']:['ORIGINAL_HISTORY_OUTSIDE_CHECKED_POLICY'],executionAuthorityGranted:false as const};
 return {...body,ref:r2Ref('branch-choice',body,'S4')};
}

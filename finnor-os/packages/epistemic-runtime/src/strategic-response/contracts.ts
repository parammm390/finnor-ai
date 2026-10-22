import {createHash} from 'node:crypto';
import {z} from 'zod';
import profile from './profile.json';
import {PE_WORLD_ROOT_TYPES} from '../../../shared-types/src/private-equity';
import type {StrategicResponseProblem,StrategicForecastRequest} from '../../../shared-types/src/strategic-response';
// Locale-independent key order is shared only as a wire format, not numerical
// logic, with the independent interpreter. S4 keeps its existing owner digests.
export function canonical(value:unknown):string {
 if(value===undefined)return 'null';
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.keys(value).filter(k=>(value as Record<string,unknown>)[k]!==undefined).sort()
  .map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
}
export const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex'),
 bytesDigest=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
export const PROFILE=Object.freeze(profile),VERSION=PROFILE.version,PROFILE_DIGEST=digest(PROFILE);
export const same=(a:unknown,b:unknown)=>digest(a)===digest(b);
export class StrategicFault extends Error {constructor(readonly code:string,readonly status=422){super(code);}}
export function fail(code:string,status=422):never{throw new StrategicFault(code,status);}
export function reference(owner:string,kind:string,body:unknown){
 const contentDigest=digest(body);return {owner,id:kind+':'+contentDigest,version:VERSION,contentDigest};
}
export const Id=z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,47}$/),Hex=z.string().regex(/^[a-f0-9]{64}$/);
const int=z.number().int().min(-PROFILE.scoreIntegerMagnitude).max(PROFILE.scoreIntegerMagnitude),choice=z.union([z.literal(0),z.literal(1)]);
export const ActorChoices=z.record(Id,choice),DateTime=z.string().datetime({offset:true});
export const Root=z.object({entityType:z.enum(PE_WORLD_ROOT_TYPES),entityId:z.string().uuid()}).strict();
export const SourcePin=z.object({sourceId:z.string().uuid(),versionId:z.string().uuid(),contentDigest:Hex}).strict();
export const Rule=z.object({id:Id,incentive:int,interaction:z.number().int().min(0).max(2),
 peerDisclosure:z.enum(['LAGGED_PEER_COUNT','NONE']),settlement:z.literal('ALL_ACTORS_PARTICIPATE'),
 allocation:z.literal('JOINT_ALL_OR_NONE'),transfer:z.literal('DECLARED_FIXED_INCENTIVE')}).strict();
const Episode=z.object({id:Id,origin:z.enum(['OBSERVED','SIMULATED','REQUESTED_EXPERIMENT']),
 assignment:z.enum(['INCUMBENT_OBSERVATIONAL','PERMITTED_RANDOMIZED','CONFOUNDED']),execution:z.enum(['OBSERVED','REQUESTED']),
 observedAt:DateTime,initial:ActorChoices,rounds:z.array(z.object({ruleId:Id,outsideOptions:z.record(Id,int),
  commonSignal:int,choices:ActorChoices}).strict()).min(1).max(PROFILE.maximumPeriods)}).strict();
const ProblemObject=z.object({schema:z.literal('finnor.strategic-response-problem.v1'),
 actors:z.array(z.object({id:Id,role:z.enum(['LENDER','CAPITAL_PROVIDER','COUNTERPARTY','APPROVER']),
  privateInformation:z.literal('OWN_OUTSIDE_OPTION_AND_OWN_PREVIOUS_CHOICE'),outcomeVisibility:z.literal('PUBLIC')}).strict())
  .min(PROFILE.actors.minimum).max(PROFILE.actors.maximum),
 rules:z.array(Rule).min(1).max(PROFILE.maximumRules),training:z.array(Episode).min(PROFILE.minimumTrainingEpisodes).max(PROFILE.maximumEpisodes),
 holdout:z.array(Episode).min(PROFILE.minimumHoldoutEpisodes).max(PROFILE.maximumEpisodes),
 assumptions:z.object({sequentialExogeneity:z.boolean(),completeActorInformation:z.boolean(),stablePreferences:z.boolean()}).strict(),
 transport:z.object({status:z.enum(['CONDITIONAL','WITHDRAWN']),contexts:z.array(Id).min(1).max(8),
  outsideOptionRange:z.tuple([int,int]),commonSignalRange:z.tuple([int,int]),validUntil:DateTime,omittedModelGap:z.literal('UNKNOWN')}).strict(),
 payoff:z.object({unit:z.string().regex(/^[A-Z]{3}$/),currency:z.string().regex(/^[A-Z]{3}$/),scale:z.literal('1'),entityRoot:Root,
  accountingBasis:z.literal('GROSS_JOINT_PAYOFF_BEFORE_ACTION_COSTS'),
  jointPayoff:z.string().regex(/^(0|[1-9][0-9]{0,6})$/).refine(v=>BigInt(v)<=BigInt(PROFILE.moneyIntegerMagnitude))}).strict()
}).strict();
export const ProblemSchema=ProblemObject.superRefine((p,ctx)=>{
 const bad=(message:string)=>ctx.addIssue({code:z.ZodIssueCode.custom,message});
 const ids=p.actors.map(a=>a.id),rules=new Map(p.rules.map(r=>[r.id,r])),episodes=[...p.training,...p.holdout];
 const keys=(r:Record<string,unknown>)=>Object.keys(r).length===ids.length&&ids.every(id=>Object.hasOwn(r,id));
 if(new Set(ids).size!==ids.length||rules.size!==p.rules.length||new Set(episodes.map(e=>e.id)).size!==episodes.length)bad('UNIQUE_ACTOR_RULE_EPISODE_IDS_REQUIRED');
 if(episodes.length>PROFILE.maximumEpisodes||p.payoff.unit!==p.payoff.currency)bad('REGISTERED_EPISODE_OR_MONEY_DOMAIN');
 if(p.transport.outsideOptionRange[0]>p.transport.outsideOptionRange[1]||p.transport.commonSignalRange[0]>p.transport.commonSignalRange[1])bad('ORDERED_TRANSPORT_INTERVALS_REQUIRED');
 for(const e of episodes){
  if(!keys(e.initial))bad('COMPLETE_ACTOR_INITIAL_STATE_REQUIRED');
  if(e.origin==='REQUESTED_EXPERIMENT'&&e.execution!=='REQUESTED')bad('REQUEST_IS_NOT_OBSERVATION');
  for(const r of e.rounds){
   if(!rules.has(r.ruleId)||!keys(r.outsideOptions)||!keys(r.choices))bad('COMPLETE_REGISTERED_JOINT_ROUND_REQUIRED');
   if(Object.values(r.outsideOptions).some(v=>v<p.transport.outsideOptionRange[0]||v>p.transport.outsideOptionRange[1])||
    r.commonSignal<p.transport.commonSignalRange[0]||r.commonSignal>p.transport.commonSignalRange[1])bad('ROUND_OUTSIDE_DECLARED_TRANSPORT_DOMAIN');
   if(e.assignment==='INCUMBENT_OBSERVATIONAL'&&rules.get(r.ruleId)?.interaction!==0)bad('INCUMBENT_OBSERVATIONAL_CANNOT_ASSERT_INTERVENTION_IDENTIFICATION');
  }
 }
});
export const ForecastSchema=z.object({context:Id,ruleIds:z.array(Id).min(1).max(PROFILE.maximumPeriods),initial:ActorChoices,
 jointPrivatePaths:z.array(z.object({id:Id,outsideOptions:z.record(Id,z.array(int).min(1).max(PROFILE.maximumPeriods))}).strict()).min(1).max(PROFILE.maximumJointPrivatePaths),
 sharedSignalPaths:z.array(z.object({id:Id,values:z.array(int).min(1).max(PROFILE.maximumPeriods)}).strict()).min(1).max(PROFILE.maximumSharedSignalPaths)}).strict();
export function assertForecast(p:StrategicResponseProblem,q:StrategicForecastRequest){
 ForecastSchema.parse(q);const ids=p.actors.map(a=>a.id),h=q.ruleIds.length;
 const keys=(r:Record<string,unknown>)=>Object.keys(r).length===ids.length&&ids.every(id=>Object.hasOwn(r,id));
 if(p.transport.status!=='CONDITIONAL'||!p.transport.contexts.includes(q.context)||Date.parse(p.transport.validUntil)<=Date.now())fail('Y2_TRANSPORT_UNSUPPORTED');
 if(q.ruleIds.some(id=>!p.rules.some(r=>r.id===id))||!keys(q.initial))fail('Y2_RULE_OR_INITIAL_INFORMATION_UNSUPPORTED');
 if(new Set(q.jointPrivatePaths.map(p=>p.id)).size!==q.jointPrivatePaths.length||new Set(q.sharedSignalPaths.map(s=>s.id)).size!==q.sharedSignalPaths.length)fail('Y2_UNIQUE_JOINT_PATHS_REQUIRED');
 for(const path of q.jointPrivatePaths)if(!keys(path.outsideOptions)||Object.values(path.outsideOptions).some(v=>v.length!==h||v.some(x=>x<p.transport.outsideOptionRange[0]||x>p.transport.outsideOptionRange[1])))fail('Y2_PRIVATE_PATH_TRANSPORT_UNSUPPORTED');
 for(const path of q.sharedSignalPaths)if(path.values.length!==h||path.values.some(x=>x<p.transport.commonSignalRange[0]||x>p.transport.commonSignalRange[1]))fail('Y2_SHARED_REGIME_TRANSPORT_UNSUPPORTED');
}

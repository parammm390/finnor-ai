import { z } from 'zod';
import type { EconomicMandate, ControlProblem, ControlDecisionInput, ContingentPolicy } from '@finnor/shared-types';
import { ExperimentRefSchema } from './experiments';
import { epistemicHash } from './source-precedence';

export class ControlContractError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'INVALID_POLICY' | 'LIMIT_EXCEEDED' | 'PERMITTED_CONTEXT_UNAVAILABLE', message: string) { super(message); this.name='ControlContractError'; }
}
const text=z.string().min(1).max(256), time=z.string().datetime({offset:true}), number=z.number().finite().min(-1e9).max(1e9), nonnegative=number.nonnegative();
const amounts=z.record(text,nonnegative), schedules=z.record(text,z.array(number).min(1).max(24));
const term=z.object({variableId:text,unit:text,coefficient:number}).strict();
const obligation=z.object({ref:ExperimentRefSchema,effectRef:ExperimentRefSchema,actionId:text.nullable(),status:z.enum(['KNOWN_PENDING','UNKNOWN','PARTIAL','SETTLED']),exposures:schedules.nullable(),resources:amounts.nullable(),occupancy:amounts.nullable(),lockedExposureIds:z.array(text).max(4).nullable(),occupationUntilPeriod:z.number().int().min(0).max(24),terminalLiability:nonnegative.nullable()}).strict();
export const ControlObservationSchema=z.object({schema:z.literal('finnor.s2.control-observation.v1'),id:text,sourceRef:ExperimentRefSchema,variableId:text,unit:text,delayPeriods:z.number().int().min(1).max(24),afterActionIds:z.array(text).min(1).max(8),bins:z.array(z.object({category:text,lowerInclusive:number,upperExclusive:number}).strict()).min(1).max(16),qualification:z.literal('SUPPLIED_DETERMINISTIC_COARSENING_UNVERIFIED')}).strict();
const mandateSchema=z.object({schema:z.literal('finnor.economic-mandate.v1'),ref:ExperimentRefSchema,tenantId:z.string().uuid(),principalId:z.string().uuid(),episodeId:text,knowledgeAt:time,validUntil:time,businessOwnerRef:ExperimentRefSchema,rightsRef:text,utilityRef:ExperimentRefSchema,
 horizon:z.object({startAt:time,periodMs:z.number().int().positive().max(31536000000),periods:z.number().int().min(1).max(24)}).strict(),
 utility:z.object({unit:text,accountingConventionRef:ExperimentRefSchema,periodTerms:z.array(term).max(8),discountFactors:z.array(nonnegative).min(2).max(25),terminalTerms:z.array(term).max(8),tail:z.object({status:z.literal('SUPPLIED_COMPLETE_FINITE_HORIZON'),terminalLiability:nonnegative,ref:ExperimentRefSchema}).strict()}).strict(),
 risk:z.object({kind:z.literal('HARD_WORST_PATH_UTILITY_FLOOR'),minimumUtility:number}).strict(),ambiguity:z.object({kind:z.enum(['ROBUST_FIXED_JOINT_SCENARIOS','UNRESOLVED']),authorizationRef:ExperimentRefSchema}).strict(),
 resources:z.object({dimensions:z.array(z.object({id:text,unit:text,capacity:nonnegative,totalLimit:nonnegative,resourceClass:z.enum(['CASH','BORROWING_HEADROOM','COMMITTED_CAPITAL','OPERATIONAL_CAPACITY','HUMAN_ATTENTION','COMPUTE','INQUIRY_EXPOSURE','COUNTERPARTY_EXPOSURE','OTHER_RESTRICTED']).optional()}).strict()).min(1).max(8),couplings:z.array(z.object({id:text,weights:amounts,maxPerPeriod:nonnegative}).strict()).max(16)}).strict(),
 search:z.object({maxExpansions:z.number().int().min(1).max(50000),deadlineMs:z.number().int().min(1).max(30000),maxWorlds:z.number().int().min(1).max(512),maxPolicyNodes:z.number().int().min(1).max(50000),maxHumanSeconds:nonnegative.max(900)}).strict(),scoring:z.object({normalization:z.number().finite().positive().max(1e9),maxRegret:nonnegative.max(1)}).strict(),authorization:z.object({basis:z.literal('AUTHENTICATED_OWNER_ASSERTION_UNADMITTED'),protectedReceipt:z.null()}).strict()}).strict();
const actionSchema=z.object({id:text,kind:z.enum(['INQUIRE','INTERVENE','WAIT','STOP']),cost:nonnegative,costUnit:text,resources:amounts,occupancy:amounts,occupationPeriods:z.number().int().min(1).max(24),tailLiability:nonnegative,earliestPeriod:z.number().int().min(0).max(23),lastPeriod:z.number().int().min(0).max(23),atMostOnce:z.boolean(),exposures:z.record(text,z.array(number).min(1).max(24)),protocolRef:ExperimentRefSchema.nullable(),informationDelayPeriods:z.number().int().min(1).max(24),humanSeconds:nonnegative.max(900)}).strict();
const continuation=z.object({elapsedPeriods:z.number().int().min(1).max(23),actionHistory:z.array(text).min(1).max(23),observations:z.array(z.object({instrumentId:text,token:text,availablePeriod:z.number().int().min(0).max(24),knowledgeAt:time,sourceRef:ExperimentRefSchema}).strict()).max(192),accruedUtility:z.object({value:number,unit:text,sourceRef:ExperimentRefSchema}).strict(),usedResources:amounts,humanSeconds:nonnegative.max(900),accountingRef:ExperimentRefSchema}).strict();
const problemSchema=z.object({schema:z.literal('finnor.control-problem.v1'),id:text,episodeId:text,modelRef:ExperimentRefSchema,context:text,regime:text,baselineExposures:schedules,actions:z.array(actionSchema).min(1).max(8),observations:z.array(ControlObservationSchema).max(8),obligations:z.array(obligation).max(32),validUntil:time,continuation:continuation.optional()}).strict();
const observation=z.object({instrumentId:text,token:text,availablePeriod:z.number().int().min(0).max(24),knowledgeAt:time,sourceRef:ExperimentRefSchema}).strict();
const decisionSchema=z.object({knowledgeAt:time,period:z.number().int().min(0).max(24),actionHistory:z.array(text).max(24),observations:z.array(observation).max(192),rightsRef:text,obligations:z.array(obligation).max(32),allocationRefs:z.array(ExperimentRefSchema).max(16)}).strict();
export function immutableControl<T>(v:T):T {const copy=structuredClone(v);const freeze=(x:unknown):void=>{if(x&&typeof x==='object'){for(const y of Object.values(x))freeze(y);Object.freeze(x);}};freeze(copy);return copy;}
function parse<T>(schema:z.ZodTypeAny,v:unknown):T{const parsed=schema.safeParse(v);if(!parsed.success)throw new ControlContractError('INVALID_REQUEST','Unsupported or incomplete S4 contract');return parsed.data as T;}
export function parseEconomicMandate(v:unknown):EconomicMandate {
 const m=parse<EconomicMandate>(mandateSchema,v),{ref,...body}=m;
 if(ref.owner!=='BUSINESS_OWNER'||ref.version!=='economic-mandate-v1'||ref.contentDigest!==epistemicHash(body)||ref.id!==`mandate:${ref.contentDigest}`)throw new ControlContractError('INVALID_REQUEST','Mandate commitment is invalid; S4 cannot repair economic objectives');
 if(m.utility.discountFactors.length!==m.horizon.periods+1||Date.parse(m.validUntil)<=Date.parse(m.knowledgeAt)||new Set(m.resources.dimensions.map(x=>x.id)).size!==m.resources.dimensions.length)throw new ControlContractError('INVALID_REQUEST','Mandate time, discount or resource semantics are incomplete');
 if(new Set(m.resources.couplings.map(c=>c.id)).size!==m.resources.couplings.length)throw new ControlContractError('INVALID_REQUEST','Duplicate coupled resource identity');
 if(m.resources.couplings.some(c=>Object.keys(c.weights).some(id=>!m.resources.dimensions.some(d=>d.id===id))))throw new ControlContractError('INVALID_REQUEST','Unknown coupled resource dimension');
 return immutableControl(m);
}
export function parseControlProblem(v:unknown):ControlProblem {
 const p=parse<ControlProblem>(problemSchema,v);
 if(new Set(p.actions.map(a=>a.id)).size!==p.actions.length||new Set(p.observations.map(a=>a.id)).size!==p.observations.length||new Set(p.obligations.map(a=>a.effectRef.id)).size!==p.obligations.length)throw new ControlContractError('INVALID_REQUEST','Duplicate action, instrument or effect obligation');
 if(p.actions.some(a=>a.earliestPeriod>a.lastPeriod||(!['WAIT','STOP'].includes(a.kind)&&!a.atMostOnce)||(['WAIT','STOP'].includes(a.kind)&&a.atMostOnce)||(a.kind==='INQUIRE')!==Boolean(a.protocolRef)||(a.kind==='INTERVENE')!==Boolean(Object.keys(a.exposures).length)))throw new ControlContractError('INVALID_REQUEST','Action meaning, commitment or inquiry binding is incomplete');
 return immutableControl(p);
}
export const parseControlDecision=(v:unknown)=>immutableControl(parse<ControlDecisionInput>(decisionSchema,v));
export const CONTROL_ADMISSION=Object.freeze({status:'BLOCKED_EXTERNAL' as const,executionAuthorityGranted:false as const,appendAuthorityGranted:false as const,methodAdmitted:false as const,receipt:null});
export function assertContingentPolicy(v:unknown):asserts v is ContingentPolicy {
 if(!v||typeof v!=='object')throw new ControlContractError('INVALID_POLICY','S4 policy unavailable');
 const p=v as ContingentPolicy,{ref,...body}=p;
 if(p.schema!=='finnor.contingent-policy.v1'||p.version!=='s4-finite-contingent-v1'||ref?.owner!=='S4'||ref.version!==p.version||ref.contentDigest!==epistemicHash(body)||ref.id!==`contingent-policy:${ref.contentDigest}`||epistemicHash(p.admission)!==epistemicHash(CONTROL_ADMISSION))throw new ControlContractError('INVALID_POLICY','S4 policy commitment or admission is invalid');
 parseEconomicMandate(p.mandate);parseControlProblem(p.problem);
}

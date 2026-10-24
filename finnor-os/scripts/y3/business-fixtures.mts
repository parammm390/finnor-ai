/** Public original business inputs. No candidate, checker reply, admission,
 * successful effect or observation-result row is supplied by this fixture. */
import {randomUUID} from 'node:crypto';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {dynamicFixture} from './math-fixtures.mts';
import {PROFILE_DIGEST,digest,type InteractionProblem,type Y3Ref} from '../../packages/private-equity/src/interaction-synthesis/contracts';
import {reference,type SubmitRequest,type SourceBinding,type Outcome} from '../../packages/private-equity/src/interaction-synthesis/product-contracts';

export async function claimSource(tenant:string,root:unknown,claim:Record<string,unknown>):Promise<SourceBinding>{
 const source=await createEvidenceSource(tenant,{sourceKey:'y3:public:'+randomUUID(),sourceType:'manual',title:'Public Y3 development claim'}),
  snapshot={worldRoot:root,interactionClaims:[claim],qualification:'PUBLIC_DISPOSABLE_INPUT_NOT_PROTECTED_OR_FIELD_TRUTH'},
  version=await appendEvidenceVersion(tenant,source.id,{content:JSON.stringify(claim),snapshot,asOf:new Date()});
 return {sourceId:source.id,versionId:version.versionId,contentDigest:digest(claim),claimKey:String(claim.key),
  ref:reference('S1','interaction-claim',claim)};
}
export async function canonicalClaim(admin:any,tenant:string,root:unknown,claim:Record<string,unknown>){
 const source=await claimSource(tenant,root,claim),head=(await admin.query(
  'SELECT content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',[tenant,source.versionId])).rows[0];
 return {...source,contentDigest:head.content_hash} as SourceBinding;
}
export async function interactionInput(admin:any,tenant:string,principal:string,peer:string,root:any,theory:any,label:string,
 change?:(p:InteractionProblem)=>void):Promise<{request:SubmitRequest;modelSource:SourceBinding;specificationSource:SourceBinding}>{
 const problem=dynamicFixture(),validUntil=new Date(Date.now()+3600000).toISOString(),
  modelClaim={key:'supplied:'+label,kind:'SUPPLIED_MODEL_QUALIFICATION',profileDigest:PROFILE_DIGEST,modelId:'supplied',
   exactModelSemantics:'SUPPLIED_NOT_EMPIRICALLY_IDENTIFIED',protectionDomain:'DISPOSABLE_LOCAL_DEVELOPMENT',validUntil},
  modelSource=await canonicalClaim(admin,tenant,root,modelClaim),modelRef=modelSource.ref;
 problem.id='installed_'+label;problem.title='Public dynamic interaction '+label;
 problem.participants[0].principalId=principal;problem.participants[1].principalId=peer;
 problem.dates=[3000,2000,1000].map(gap=>new Date(Date.now()-gap).toISOString()) as [string,string,string];
 problem.fixedOperatorRefs=[theory.view.artifact.envelope.contentRef as Y3Ref];problem.actorModelRefs=[modelRef];
 const rebase=(v:any)=>{v.sourceRef=modelRef;};
 problem.participants.forEach(p=>rebase(p.outsideOption.basis));
 rebase(problem.goal.minimumOwnerValue.basis);
 [...problem.quantityBasis.utilities,problem.quantityBasis.ownerValue].forEach(rebase);
 [...problem.financialLimits.absolutePayments,...problem.financialLimits.liabilities].forEach(q=>rebase(q.basis));
 problem.observationRules.forEach(rule=>{rule.sourceRef=modelRef;});
 problem.resourceLimits=Object.fromEntries(theory.request.problem.quantities.map((quantity:any)=>[quantity.id,{value:'5',
  basis:{unit:quantity.unit,currency:quantity.currency,owner:quantity.entityId,
   timeBasis:quantity.accountingBasis+':'+quantity.period.startAt+'/'+quantity.period.endAt,
   rounding:'EXACT',sourceStatus:'SUPPLIED_MODEL',sourceRef:modelRef}}]));
 const before={available:'3',committed:'2'},after={available:'1',committed:'4'};
 for(const model of problem.models){
  model.qualificationRef=modelRef;
  for(const node of model.nodes){
   node.resources={...(node.kind==='TERMINAL'&&node.id.endsWith('-done')?after:before)};
   if(node.kind==='CHANCE')node.probabilityBasis.identificationRef=modelRef;
  }
 }
 change?.(problem);
 const outcomes:Outcome[]=problem.models.flatMap(model=>model.nodes.filter(node=>node.kind==='TERMINAL').map(node=>{
  const after=Object.fromEntries(Object.entries(node.resources).map(([id,value])=>[id,value]));
  return {modelId:model.id,terminalNodeId:node.id,terminalDigest:digest(node),before,after,
   ...(digest(before)===digest(after)?{kind:'NO_EFFECT' as const}:{kind:'RIGHT_TRANSITION' as const,
    operatorId:theory.request.problem.operators.find((o:any)=>o.id.startsWith('shift_')).id,parameters:{amount:'2'}})};
 }));
 const lowering={schema:'finnor.y3.fixed-y1-lowering.v1' as const,theoryId:theory.accepted.theoryId,
  theoryRef:theory.view.artifact.envelope.contentRef,outcomes},
  specificationClaim={key:'specification:'+label,kind:'INTERACTION_SPECIFICATION',profileDigest:PROFILE_DIGEST,
   problem,lowering,protectionDomain:'DISPOSABLE_LOCAL_DEVELOPMENT',validUntil},
  specificationSource=await canonicalClaim(admin,tenant,root,specificationClaim),
  request:SubmitRequest={schema:'finnor.interaction-request.v1',root,workId:theory.request.workId,problem,lowering,
   sources:[modelSource,specificationSource],idempotencyKey:randomUUID()};
 return {request,modelSource,specificationSource};
}
export async function observationSource(admin:any,tenant:string,root:unknown,request:SubmitRequest,participant:'P0'|'P1',
 date:0|1|2,key:string,value:string){
 return canonicalClaim(admin,tenant,root,{key:'observation:'+randomUUID(),kind:'INTERACTION_OBSERVATION',
  problemDigest:digest(request.problem),participant,date,observationKey:key,value,classification:'SOURCED_FACT',
  observedAt:new Date().toISOString(),validUntil:new Date(Date.now()+3600000).toISOString(),
  protectionDomain:'DISPOSABLE_LOCAL_DEVELOPMENT'});
}

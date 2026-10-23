/** Public data only. Bodies and laws are not inputs to the economic compiler. */
import {randomUUID} from 'node:crypto';
import {createEvidenceSource,appendEvidenceVersion} from '@finnor/memory';
import {receiveWork} from '@finnor/db';
import {digest,type EconomicProblem} from '../../packages/private-equity/src/economic-action-theory/contracts';
export const ref=(id:string,owner='BUSINESS_OWNER')=>({owner,id,version:'public-owner-input-v1',contentDigest:digest({id,owner})});
export function publicProblem(root:{entityId:string},period:{startAt:string;endAt:string},label:string):EconomicProblem{
 const quantity=(id:string)=>({id,unit:'USD',currency:'USD',entityId:root.entityId,accountingBasis:'DECLARED_INTERNAL_RESERVATION_RIGHTS',
  period,meaningKey:'accounting',values:['0','1','2','3','4','5']});
 const requirements=[{key:'owner',kind:'AUTHORITY',subjectId:root.entityId},{key:'consent',kind:'CONSENT',subjectId:root.entityId},
  {key:'observations',kind:'OBSERVATION',subjectId:root.entityId}];
 const examples:Record<string,any[]>={shift:[],return:[],consolidate:[]};
 for(let left=0;left<=5;left++)for(let right=0;right<=5-left;right++)for(const amount of [1,2]){
  const before={available:String(left),committed:String(right)},parameters={amount:String(amount)};
  examples.shift!.push({before,parameters,after:left>=amount?{available:String(left-amount),committed:String(right+amount)}:null});
  examples.return!.push({before,parameters,after:right>=amount?{available:String(left+amount),committed:String(right-amount)}:null});
  examples.consolidate!.push({before,parameters,after:{available:'0',committed:String(left+right)}});
 }
 return {schema:'finnor.economic-construction-problem.v1',goal:{id:'goal_'+label,title:'Public finite right substitution '+label},
  quantities:[quantity('available'),quantity('committed')],parameters:[{...quantity('amount'),values:['1','2']}],
  meanings:['accounting','consent','observations'].map(key=>({key,kind:key==='accounting'?'INTERPRETATION':key==='consent'?'CONSENT':'OBSERVATION',
   subjectId:root.entityId,sourceId:null,versionId:null,contentDigest:null})),
  invariants:[{id:'accountable_total',terms:[{quantityId:'available',coefficient:1},{quantityId:'committed',coefficient:1}],relation:'LE',constant:'5',meaningKey:'accounting'}],
  operators:Object.entries(examples).map(([id,values])=>({id:id+'_'+label,title:'Opaque event '+randomUUID(),examples:values,requirements}))} as EconomicProblem;
}
export function meaningClaims(problem:EconomicProblem){
 return problem.meanings.map(m=>({key:m.key,kind:m.kind,subjectId:m.subjectId,
  dimensions:problem.quantities.concat(problem.parameters).filter(q=>q.meaningKey===m.key).map(q=>({
   unit:q.unit,currency:q.currency,entityId:q.entityId,accountingBasis:q.accountingBasis,period:q.period})),
  invariants:problem.invariants.filter(i=>i.meaningKey===m.key).map(i=>({id:i.id,digest:digest(i)})),
  operatorExamples:problem.operators.filter(o=>o.requirements.some(r=>r.key===m.key&&r.kind==='OBSERVATION'))
   .map(o=>({operatorId:o.id,examplesDigest:digest(o.examples)})),
  permittedOperatorIds:problem.operators.map(o=>o.id),validUntil:new Date(Date.now()+3600000).toISOString(),
  protectionDomain:'DISPOSABLE_LOCAL_DEVELOPMENT',externalEffects:false}));
}
export async function bindCanonicalInputs(admin:any,tenant:string,principal:string,root:any,problem:EconomicProblem,label:string){
 const source=await createEvidenceSource(tenant,{sourceKey:'y1:'+label+':'+randomUUID(),sourceType:'manual',title:'Public declared finite observations '+label}),
  snapshot={worldRoot:root,economicMeanings:meaningClaims(problem),qualification:'PUBLIC_DEVELOPMENT_INPUT_NOT_PROTECTED_OR_BUSINESS_TRUTH'};
 const version=await appendEvidenceVersion(tenant,source.id,{content:JSON.stringify({label,examples:problem.operators.map(o=>o.examples)}),snapshot,asOf:new Date()});
 const hash=(await admin.query('SELECT content_hash FROM finnor_os.evidence_source_versions WHERE tenant_id=$1 AND id=$2',[tenant,version.versionId])).rows[0].content_hash;
 problem.meanings=problem.meanings.map(m=>({...m,sourceId:source.id,versionId:version.versionId,contentDigest:hash}));
 const work=await receiveWork({tenantId:tenant,userId:principal,channel:'console',instruction:'Y1 public development Work '+label,idempotencyKey:randomUUID(),
  entityAttachments:[{...root,source:'Y1:public-development'}]});
 return {sourceId:source.id,versionId:version.versionId,snapshot,work,
  request:{schema:'finnor.economic-theory-request.v1',root,workId:work.workId,problem,idempotencyKey:randomUUID()}};
}
export function resourceInput(tenant:string,principal:string,root:any,horizon:any,label:string,availability='5'){
 const now=new Date().toISOString();
 return {schema:'finnor.allocation-resource.v1',resourceId:'y1_'+label,tenantId:tenant,ownerRef:ref(principal),
  legalEntityRef:ref(root.entityId,'S1'),scopeRef:ref(root.entityId),permittedRoots:[root],rightsRef:'S1:current-owner-assertion',
  unit:'USD',currency:'USD',kind:'STOCK',resourceClass:'CASH',horizon,sourceRef:ref('public_declared_capacity_'+label),
  asOf:now,knowledgeAt:now,validUntil:new Date(Date.now()+3600000).toISOString(),beliefPins:[],
  availability:[{amount:availability,basis:'REPORTED_AVAILABLE'},{amount:availability,basis:'REPORTED_AVAILABLE'}],
  existingUse:['0','0'],safetyMargin:'0',covenants:[],revoked:false,qualification:'AUTHENTICATED_OWNER_ASSERTION_UNADMITTED'};
}

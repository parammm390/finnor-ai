/** Protected mechanical dispatch. The ordinary native owners supply current facts.
 * ATTEMPT persistence precedes possible egress; recovery never repeats a mutation. */
import {verify,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {canonical,LedgerFault} from './protocol.js';
import type {ExperienceLedger} from './ledger.js';
import {brokerHash as hash,brokerPrivateFile,brokerSourceDigests,brokerOrigin,brokerToken,brokerRequest} from './broker-io.js';
import {s6AdapterContract,S6_EXECUTOR_CONTRACT_VERSION} from './adapter-contract.js';
type ObjectValue=Record<string,any>;
const fail=(status:number,code:string):never=>{throw new LedgerFault(status,code);};
const object=(v:any):ObjectValue=>v&&typeof v==='object'&&!Array.isArray(v)?v:fail(400,'BROKER_OBJECT_REQUIRED');
const exact=(v:ObjectValue,keys:string[])=>{if(Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail(400,'BROKER_FIELD_SET_INVALID');};
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
const signature=(v:ObjectValue,key:string)=>{const {signature,...body}=v;if(typeof signature!=='string'||signature.length>256||!verify(null,Buffer.from(canonical(body)),key,Buffer.from(signature,'base64')))fail(403,'BROKER_SIGNATURE_INVALID');return body;};
const sourcePaths=['enterprise-obligations.ts','enterprise-allocation.ts','enterprise-control.ts','enterprise-beliefs.ts','allocation-store.ts','obligation-contracts.ts'].map(name=>fileURLToPath(new URL('../../private-equity/src/'+name,import.meta.url))).concat(fileURLToPath(new URL('../../../apps/api/app/api/obligations/[operation]/route.ts',import.meta.url)));

export class GovernedDispatchBroker {
 private queue:Promise<unknown>=Promise.resolve();private queued=0;
 private constructor(private ledger:ExperienceLedger,private path:string,private root:string,private policy:ObjectValue,private owner:any){}
 static async open(ledger:ExperienceLedger,path:string,root:string){
  if(!root)fail(503,'BROKER_RELEASE_ROOT_REQUIRED');const config=object(JSON.parse((await brokerPrivateFile(path)).toString()));exact(config,['policy','signature']);
  const body=signature({ ...object(config.policy),signature:config.signature},root),policy=object(body);
  exact(policy,['schema','domain','validUntil','protectedTokenPath','protectedTokenSha256','businessOwnerPublicKey','authority','routes']);
  if(policy.schema!=='finnor.s6.dispatch-policy.v1'||!['DISPOSABLE_TEST_AUTHORITY','REVIEWED_PROTECTED_DOMAIN'].includes(policy.domain)||!Number.isFinite(Date.parse(policy.validUntil))||Date.parse(policy.validUntil)<=Date.now())fail(503,'BROKER_POLICY_UNADMITTED');
  const authority=object(policy.authority);exact(authority,['endpoint','tokenPath','tokenSha256','publicKey','sourceDigests']);brokerOrigin(authority.endpoint,policy.domain);
  if(!same(authority.sourceDigests,await brokerSourceDigests(sourcePaths)))fail(503,'CURRENT_OWNER_SOURCE_VERSION_UNADMITTED');
  if(!Array.isArray(policy.routes)||policy.routes.length<1||policy.routes.length>64)fail(503,'BROKER_ROUTE_BOUND');
  const routes=new Set<string>();for(const raw of policy.routes){const route=object(raw);exact(route,['providerOrigin','applicationAccountId','contract','tokenPath','tokenSha256','caPath','caSha256']);const url=brokerOrigin(route.providerOrigin,policy.domain);if(url.protocol!=='https:'||route.contract!=='CONDITIONAL_JSON_RECORD_V1'||typeof route.applicationAccountId!=='string'||!/^[a-f0-9-]{36}$/i.test(route.applicationAccountId))fail(503,'BROKER_ROUTE_UNADMITTED');const identity=canonical([route.providerOrigin,route.applicationAccountId]);if(routes.has(identity))fail(503,'BROKER_ROUTE_AMBIGUOUS');routes.add(identity);}
  const owner=ledger.authenticate(brokerToken(await brokerPrivateFile(policy.protectedTokenPath,policy.protectedTokenSha256)));
  if(owner.owner!=='S6'||owner.protectedExecution!==true||!owner.append||!owner.read)fail(503,'BROKER_PROTECTED_IDENTITY_REQUIRED');
  return new GovernedDispatchBroker(ledger,path,root,policy,owner);
 }
 private serialized<T>(fn:()=>Promise<T>):Promise<T>{if(this.queued>=32)return Promise.reject(new LedgerFault(429,'BROKER_BACKLOG_BOUND'));this.queued++;const next=this.queue.then(fn,fn);this.queue=next.catch(()=>undefined);return next.finally(()=>{this.queued--;});}
 private async currentPolicy(){const value=object(JSON.parse((await brokerPrivateFile(this.path)).toString()));exact(value,['policy','signature']);signature({...object(value.policy),signature:value.signature},this.root);if(!same(value.policy,this.policy)||Date.parse(this.policy.validUntil)<=Date.now())fail(503,'BROKER_POLICY_CHANGED_OR_EXPIRED');}
 private async currentOwner(obligation:any,requestRef:any,memberId:string,deadlineAt:number,delivery?:ObjectValue){
  const nonce=randomUUID(),authority=this.policy.authority,url=new URL('/api/obligations/check-dispatch',authority.endpoint);
  const reply=await brokerRequest(url,{method:'POST',token:brokerToken(await brokerPrivateFile(authority.tokenPath,authority.tokenSha256)),body:{obligationRef:obligation.ref,requestRef,memberId,nonce,...(delivery?{delivery}:{})},deadlineAt});
  if(reply.status!==200)fail(403,'CURRENT_OWNER_REFUSED');const assessment=object(reply.body),body=signature(assessment,authority.publicKey);
  const now=Date.now(),checked=Date.parse(body.checkedAt),until=Date.parse(body.validUntil);
  if(body.schema!=='finnor.s6.current-owner-assessment.v1'||body.status!=='CURRENT'||body.nonce!==nonce||body.tenantId!==obligation.tenantId||body.principalId!==obligation.principalId||body.rightsRef!==obligation.rightsRef||!same(body.obligationRef,obligation.ref)||!same(body.requestRef,requestRef)||body.memberId!==memberId||!same(body.effectRef,obligation.effectRef)||!same(body.allocationRef,obligation.allocationRef)||!same(body.consumptionRef,obligation.consumptionRef)||!same(body.sourceDigests,authority.sourceDigests)||!Number.isFinite(checked)||!Number.isFinite(until)||checked>now||until<=now||until-checked>5000||now-checked>5000)fail(403,'CURRENT_OWNER_ASSESSMENT_INVALID');
  if(!same(body.delivery??null,delivery??null))fail(403,'CURRENT_OWNER_DELIVERY_SUBSTITUTION');return assessment;
 }
 private async reserveUnits(obligation:any,requestRef:any,memberId:string,phase:'EXECUTION'|'RECOVERY'|'HUMAN',ordinal:number,units:number,deadlineAt:number){
  const nonce=randomUUID(),authority=this.policy.authority;
  const reply=await brokerRequest(new URL('/api/obligations/check-budget',authority.endpoint),{method:'POST',token:brokerToken(await brokerPrivateFile(authority.tokenPath,authority.tokenSha256)),body:{obligationRef:obligation.ref,requestRef,memberId,phase,ordinal,units,nonce},deadlineAt});
  if(reply.status!==200)fail(409,'S5_RESOURCE_OWNER_REFUSED');
  const assessment=object(reply.body),body=signature(assessment,authority.publicKey),now=Date.now(),checked=Date.parse(body.checkedAt),until=Date.parse(body.validUntil);
  if(body.schema!=='finnor.s6.resource-owner-assessment.v1'||body.status!=='RESERVED'||body.nonce!==nonce||body.tenantId!==obligation.tenantId||body.principalId!==obligation.principalId||body.rightsRef!==obligation.rightsRef||!same(body.obligationRef,obligation.ref)||!same(body.requestRef,requestRef)||body.memberId!==memberId||body.phase!==phase||body.ordinal!==ordinal||body.units!==units||!same(body.effectRef,obligation.effectRef)||!same(body.allocationRef,obligation.allocationRef)||!same(body.reservationRef,obligation.reservationRef)||!same(body.consumptionRef,obligation.consumptionRef)||!same(body.sourceDigests,authority.sourceDigests)||body.executionAuthorityGranted!==false||!Number.isFinite(checked)||!Number.isFinite(until)||checked>now||until<=now||until-checked>5000||now-checked>5000)fail(403,'S5_RESOURCE_ASSESSMENT_INVALID');
  const charge=object(body.charge),{ref,...preimage}=charge;
  if(ref?.owner!=='S5'||ref.contentDigest!==hash(preimage)||ref.id!==`allocation-governed-charge:${ref.contentDigest}`||!same(charge.requestRef,requestRef)||!same(charge.obligationRef,obligation.ref)||charge.memberId!==memberId||charge.phase!==phase||charge.ordinal!==ordinal||charge.units!==units||charge.costs?.releaseSufficient!==false)fail(403,'S5_RESOURCE_CHARGE_SUBSTITUTION');
  return assessment;
 }
 private authorization(value:any,request:any,obligation:any){
  const grant=object(value);exact(grant,['body','signature']);const body=signature({...object(grant.body),signature:grant.signature},this.policy.businessOwnerPublicKey);
  exact(body,['schema','domain','tenantId','principalId','rightsRef','obligationRef','requestRef','effectRef','mandateRef','allocationRef','consumptionRef','resourceEnvelope','validAfter','validUntil']);
  if(body.schema!=='finnor.business-owner.effect-authorization.v1'||body.domain!==this.policy.domain||!Number.isFinite(Date.parse(body.validAfter))||!Number.isFinite(Date.parse(body.validUntil))||Date.parse(body.validAfter)>Date.now()||Date.parse(body.validUntil)<=Date.now())fail(403,'BUSINESS_OWNER_AUTHORIZATION_EXPIRED_OR_INVALID');
  for(const key of ['tenantId','principalId','rightsRef','obligationRef','effectRef','mandateRef','allocationRef','consumptionRef','resourceEnvelope'])if(!same(body[key],key==='obligationRef'?obligation.ref:obligation[key]))fail(403,'BUSINESS_OWNER_AUTHORIZATION_SUBSTITUTION');
  if(!same(body.requestRef,request.ref))fail(403,'BUSINESS_OWNER_REQUEST_SUBSTITUTION');return body;
 }
 private async append(obligation:any,requestRef:any,type:string,detail:ObjectValue,parent?:any){
  const now=new Date().toISOString(),body={schema:'finnor.s6.experience.v1',semanticOwner:'S6',tenantId:obligation.tenantId,principalId:obligation.principalId,rightsRef:obligation.rightsRef,episodeId:obligation.episodeId,type,revisionRef:obligation.ref.id,contentDigest:hash(detail),knowledgeAt:now,validAt:now,preparedParentRefs:parent?[parent.event.eventId]:[],causalParents:parent?[parent.event.eventId]:[],dependencyRefs:[obligation.ref.id,requestRef.id],horizon:'H0',uncertainty:'EXECUTION_EVIDENCE_NOT_CAUSAL_OR_ECONOMIC_ATTRIBUTION',detail,protectedReceipt:null,appendAuthorityGranted:false};
  const event={...body,eventId:'s6-event:'+hash(body)},answer=await this.ledger.append(this.owner,{event,parents:parent?[parent.receipt]:[],references:[]});return {event,receipt:answer.receipt};
 }
 private base(obligation:any,requestRef:any){return {schema:'finnor.s6.protected-execution.v1',executorContract:s6AdapterContract('CONDITIONAL_JSON_RECORD_V1'),obligationRef:obligation.ref,requestRef,effectRef:obligation.effectRef,allocationRef:obligation.allocationRef,reservationRef:obligation.reservationRef,consumptionRef:obligation.consumptionRef,resourceEnvelope:obligation.resourceEnvelope,costs:{money:null,pricebookRef:null,status:'UNMETERED',billingBound:'UNKNOWN',releaseSufficient:false}};}
 takeover(caller:any,input:unknown){
  if(caller.owner!=='S6'||caller.dispatch!==true||caller.tenantId!==this.owner.tenantId||caller.principalId!==this.owner.principalId||caller.rightsRefs.some((r:string)=>!this.owner.rightsRefs.includes(r)))return Promise.reject(new LedgerFault(403,'OPERATOR_TAKEOVER_NOT_AUTHORIZED'));
  return this.serialized(async()=>{
   await this.currentPolicy();const value=object(input);exact(value,['obligationId','requestRef','expectedCheckpoint','idempotencyKey','humanSeconds','reason']);
   if(typeof value.obligationId!=='string'||value.obligationId.length>256||!/^durable-obligation:[a-f0-9]{64}$/.test(value.obligationId)||!/^request-ir:[a-f0-9]{64}$/.test(value.requestRef?.id)||!/^[a-f0-9]{64}$/.test(value.expectedCheckpoint)||typeof value.idempotencyKey!=='string'||!/^[a-f0-9-]{36}$/i.test(value.idempotencyKey)||!Number.isSafeInteger(value.humanSeconds)||value.humanSeconds<1||value.humanSeconds>900||typeof value.reason!=='string'||value.reason.length<1||value.reason.length>1024)fail(400,'OPERATOR_TAKEOVER_INPUT_INVALID');
   const accepted=await this.ledger.readReference(this.owner,value.obligationId),obligation={...accepted.reference.content,ref:{id:accepted.reference.id,owner:accepted.reference.owner,version:accepted.reference.version,contentDigest:accepted.reference.contentDigest}};
   if(obligation.tenantId!==caller.tenantId||obligation.principalId!==caller.principalId||!caller.rightsRefs.includes(obligation.rightsRef))fail(403,'OPERATOR_OBLIGATION_IDENTITY_MISMATCH');
   const history=await this.ledger.readObligationHistory(this.owner,value.obligationId),intent=history.find(row=>row.event.type==='INTENT'),claims=history.filter(row=>row.event.type==='RECONCILIATION'&&row.event.detail.kind==='OPERATOR_TAKEOVER'),inputDigest=hash(value),prior=claims.find(row=>row.event.detail.idempotencyKey===value.idempotencyKey);
   if(prior){if(prior.event.detail.inputDigest!==inputDigest)fail(409,'OPERATOR_TAKEOVER_IDENTITY_IMMUTABLE');return {receipt:prior.receipt,responsibilityRetained:true,automaticMutationRetry:false,resourceReleaseGranted:false,semanticReplay:true};}
   if(!intent||!same(intent.event.detail.requestRef,value.requestRef)||!same(intent.event.detail.executorContract,s6AdapterContract('CONDITIONAL_JSON_RECORD_V1')))fail(409,'OPERATOR_COMPATIBLE_ORIGINAL_REQUEST_REQUIRED');
   if(history.at(-1)?.receipt.checkpointDigest!==value.expectedCheckpoint)fail(409,'OPERATOR_TAKEOVER_STALE_CHECKPOINT');
   if(claims.length>=64)fail(409,'OPERATOR_TAKEOVER_RECORD_BOUND');
   const memberId=(intent??fail(409,'OPERATOR_ORIGINAL_INTENT_REQUIRED')).event.detail.request.ir.members[0].memberId,funding=await this.reserveUnits(obligation,value.requestRef,memberId,'HUMAN',claims.length+1,value.humanSeconds,Date.now()+30000);
   const result=await this.append(obligation,value.requestRef,'RECONCILIATION',{...this.base(obligation,value.requestRef),kind:'OPERATOR_TAKEOVER',idempotencyKey:value.idempotencyKey,inputDigest,reason:value.reason,operator:{tenantId:caller.tenantId,principalId:caller.principalId,rightsRef:obligation.rightsRef,identityBasis:'AUTHENTICATED_EXACT_CONTROL_IDENTITY_AND_CURRENT_NATIVE_RESOURCE_OWNER'},funding,priorCheckpoint:value.expectedCheckpoint,originalAttemptIds:history.filter(row=>row.event.type==='ATTEMPT').map(row=>row.event.eventId),originalObservationOrdinals:history.filter(row=>row.event.detail.kind==='OBSERVATION_ATTEMPT').map(row=>row.event.detail.observationOrdinal),status:'READ_ONLY_RESPONSIBILITY_TAKEN_OVER',responsibilityRetained:true,automaticMutationRetry:false,newMutationAuthorityGranted:false,attemptFenceOrBudgetReset:false,resourceReleaseGranted:false},history.at(-1));
   return {receipt:result.receipt,responsibilityRetained:true,automaticMutationRetry:false,resourceReleaseGranted:false,semanticReplay:false};
  });
 }
 execute(caller:any,input:unknown,reconcile=false){
  if(caller.owner!=='S6'||caller.dispatch!==true||caller.tenantId!==this.owner.tenantId||caller.principalId!==this.owner.principalId||caller.rightsRefs.some((r:string)=>!this.owner.rightsRefs.includes(r)))return Promise.reject(new LedgerFault(403,'PROTECTED_DISPATCH_NOT_AUTHORIZED'));
  return this.serialized(async()=>{
   const deadlineAt=Date.now()+30000;await this.currentPolicy();const value=object(input);exact(value,['request','authorization',...(Object.hasOwn(value,'delivery')?['delivery']:[])]);const delivery=value.delivery===undefined?undefined:object(value.delivery);
   if(delivery){
    const recovery=delivery.kind==='RECOVERY';exact(delivery,['workflowStepId','claimFence','dispatchGeneration','runVersion',...(recovery?['kind','jobId','jobDeliveryAttemptId','jobClaimToken','jobClaimFence']:['claimToken'])]);
    const identities=recovery?[delivery.workflowStepId,delivery.jobId,delivery.jobDeliveryAttemptId,delivery.jobClaimToken]:[delivery.workflowStepId,delivery.claimToken];
    if(!identities.every(v=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v))||![delivery.claimFence,delivery.dispatchGeneration,delivery.runVersion,...(recovery?[delivery.jobClaimFence]:[])].every(v=>Number.isSafeInteger(v)&&v>=0)||delivery.claimFence<1||recovery&&delivery.jobClaimFence<1)fail(400,'BROKER_DELIVERY_FENCE_INVALID');
   }
   const request=object(value.request);exact(request,['ref','ir','admissions']);if(Buffer.byteLength(canonical(value))>2*1024*1024)fail(413,'BROKER_REQUEST_BOUND');
   const accepted=await this.ledger.readReference(this.owner,object(request.ir).obligationRef.id),obligation={...accepted.reference.content,ref:{id:accepted.reference.id,owner:accepted.reference.owner,version:accepted.reference.version,contentDigest:accepted.reference.contentDigest}};
   if(obligation.tenantId!==caller.tenantId||obligation.principalId!==caller.principalId||!caller.rightsRefs.includes(obligation.rightsRef))fail(403,'BROKER_OBLIGATION_IDENTITY_MISMATCH');
   let history=await this.ledger.readObligationHistory(this.owner,obligation.ref.id);
   if(history.some(row=>!same(row.event.detail.requestRef,request.ref)))fail(409,'OBLIGATION_CONCRETE_REQUEST_ALREADY_BOUND');
   const intent=history.find(row=>row.event.type==='INTENT');
   if(intent&&!same(intent.event.detail.request,request))fail(409,'BOUND_EXECUTION_REQUEST_CHANGED');
   if(intent&&(!same(intent.event.detail.executorContract,s6AdapterContract('CONDITIONAL_JSON_RECORD_V1'))||intent.event.detail.executorContract.version!==S6_EXECUTOR_CONTRACT_VERSION))fail(409,'EXECUTOR_VERSION_INCOMPATIBLE_RESPONSIBILITY_RETAINED');
   const verified=history.find(row=>row.event.type==='VERIFICATION'&&row.event.detail.status==='VERIFIED');
   if(verified)return {status:'VERIFIED',receipt:verified.receipt,settlement:verified.event.detail,semanticReplay:true};
   if(!intent){
    if(reconcile)fail(409,'NO_PROTECTED_ATTEMPT_RECORDED');
    await this.ledger.verifyRequest(this.owner,request);const authorization=this.authorization(value.authorization,request,obligation);
    if(Date.now()<Date.parse(obligation.deadline.businessStartAt)||Date.now()>=Date.parse(obligation.deadline.businessPeriodEndAt))fail(409,'S4_BUSINESS_TIME_NOT_CURRENT');
    for(const member of request.ir.members){if(!this.policy.routes.some((route:any)=>route.providerOrigin===member.request.providerOrigin&&route.applicationAccountId===member.request.applicationAccountId))fail(403,'EXACT_PROVIDER_ROUTE_UNADMITTED');if(!/^"[^"\r\n]{1,500}"$/.test(member.request.expectedVersion))fail(400,'STRONG_PROVIDER_VERSION_REQUIRED');}
    await this.ledger.registerReference(this.owner,{reference:{...request.ref,content:request.ir},rightsRefs:[obligation.rightsRef]});
    history.push(await this.append(obligation,request.ref,'INTENT',{...this.base(obligation,request.ref),request,authorization,status:'RESPONSIBILITY_RETAINED'}));
   }
   const attempts=history.filter(row=>row.event.type==='ATTEMPT');
   if(!reconcile&&history.filter(row=>row.event.type==='RECONCILIATION'&&row.event.detail.kind==='OBSERVATION_ATTEMPT').length<64){
    let dispatched=false;
    for(const member of request.ir.members){
     // An immutable possible-delivery marker is sticky across every restart,
     // queue claim and backend. Continuation is only for original untouched members.
     if(attempts.some(row=>row.event.detail.memberId===member.memberId))continue;
     if(Date.now()>=deadlineAt)break;
     const route=this.policy.routes.find((route:any)=>route.providerOrigin===member.request.providerOrigin&&route.applicationAccountId===member.request.applicationAccountId);
     if(!route)fail(503,'RECOVERY_PROVIDER_ROUTE_UNAVAILABLE');
     try{await this.ledger.verifyRequest(this.owner,request);this.authorization(value.authorization,request,obligation);await this.currentOwner(obligation,request.ref,member.memberId,deadlineAt,delivery);}
     catch(error){
      if(!attempts.length)throw error;
      return {status:'UNRESOLVED',receipt:history.at(-1)!.receipt,responsibilityRetained:true,automaticMutationRetry:false,continuationRefused:error instanceof LedgerFault?error.code:'CURRENT_CONTINUATION_UNAVAILABLE'};
     }
     const funding=await this.reserveUnits(obligation,request.ref,member.memberId,'EXECUTION',1,1,deadlineAt);
     // Credentials are confined to this protected process and fixed signed route.
     const token=brokerToken(await brokerPrivateFile(route.tokenPath,route.tokenSha256)),ca=await brokerPrivateFile(route.caPath,route.caSha256);
     const mechanical=await this.ledger.verifyRequest(this.owner,request),grant=this.authorization(value.authorization,request,obligation);
     const operationId='effect-member:'+hash([obligation.ref,request.ref,member.memberId]);
     const attempt=await this.append(obligation,request.ref,'ATTEMPT',{...this.base(obligation,request.ref),funding,memberId:member.memberId,operationId,status:'MAY_HAVE_LEFT',providerRequest:member.request,automaticMutationRetry:false},history.at(-1));history.push(attempt);attempts.push(attempt);dispatched=true;
     let outcome:any;
     try{
      await this.ledger.health(this.owner);const current=await this.currentOwner(obligation,request.ref,member.memberId,deadlineAt,delivery);
      const authorityExpiresAt=Math.min(Date.parse(current.validUntil),Date.parse(mechanical.assessment.validUntil),Date.parse(grant.validUntil),Date.parse(this.policy.validUntil),Date.parse(obligation.deadline.businessPeriodEndAt));
      history.push(await this.append(obligation,request.ref,'RECONCILIATION',{...this.base(obligation,request.ref),kind:'CURRENT_AUTHORITY',memberId:member.memberId,operationId,assessment:current,methodAssessment:mechanical.assessment,authorizationValidUntil:grant.validUntil,wireAuthorityUntil:new Date(authorityExpiresAt).toISOString(),status:'CURRENT_BEFORE_POSSIBLE_WIRE'},history.at(-1)));
      if(Date.now()>=authorityExpiresAt)fail(403,'CURRENT_AUTHORITY_EXPIRED_BEFORE_WIRE');
      const url=new URL(`/accounts/${encodeURIComponent(member.request.applicationAccountId)}/records/${encodeURIComponent(member.request.recordKey)}`,route.providerOrigin);
      const result=await brokerRequest(url,{method:'PATCH',token,ca,deadlineAt:Math.min(deadlineAt,authorityExpiresAt),ifMatch:member.request.expectedVersion,body:{changes:member.request.changes,operationId}});
      outcome={status:'ACKNOWLEDGED_UNSETTLED',httpStatus:result.status,responseDigest:result.responseDigest,compute:{schema:'finnor.model-compute-invocation.v1',semanticOwner:'S6',id:'model-compute:'+hash([attempt.event.eventId,result.responseDigest]),tenantId:obligation.tenantId,principalId:obligation.principalId,rightsRef:obligation.rightsRef,inputRef:request.ref,outputRefs:[result.responseDigest],requestedRoute:route.providerOrigin,actualRoute:route.providerOrigin,fallbacks:[],model:null,backend:{name:'CONDITIONAL_JSON_RECORD_V1',version:S6_EXECUTOR_CONTRACT_VERSION,sourceDigests:this.ledger.releaseIdentity().sourceDigests,identityBasis:'SIGNED_RELEASE_SOURCE_AND_TLS_ACCOUNT_BINDINGS_DOMAIN_QUALIFIED'},harness:{nodeVersion:process.version,platform:process.platform,architecture:process.arch,deterministicReplayClaimed:false},attempts:[{startedAt:attempt.receipt.appendAt,finishedAt:new Date().toISOString(),status:'ACKNOWLEDGED_UNSETTLED'}],usage:{externalCalls:1,accountingScope:'ONE_PHYSICAL_REQUEST_OBSERVED_NO_PROVIDER_CPU_MEMORY_OR_BILLING_MEASUREMENT'},cost:{money:null,pricebookRef:null,status:'UNMETERED'},admission:{domain:this.policy.domain,productionEstablished:false}}};
     }catch(error){outcome={status:'UNKNOWN',reason:error instanceof LedgerFault?error.code:'TRANSPORT_OR_OWNER_UNAVAILABLE'};}
     if(!outcome.compute){const computeBody={schema:'finnor.model-compute-invocation.v1',semanticOwner:'S6',tenantId:obligation.tenantId,principalId:obligation.principalId,rightsRef:obligation.rightsRef,inputRef:request.ref,outputRefs:[],requestedRoute:route.providerOrigin,actualRoute:null,fallbacks:[],model:null,backend:{name:'CONDITIONAL_JSON_RECORD_V1',version:S6_EXECUTOR_CONTRACT_VERSION,sourceDigests:this.ledger.releaseIdentity().sourceDigests,identityBasis:'SIGNED_RELEASE_SOURCE_ROUTE_ACCOUNT_BINDING_PHYSICAL_OUTCOME_UNKNOWN'},harness:{nodeVersion:process.version,platform:process.platform,architecture:process.arch,deterministicReplayClaimed:false},attempts:[{startedAt:attempt.receipt.appendAt,finishedAt:new Date().toISOString(),status:'UNKNOWN',reason:outcome.reason}],usage:{externalCalls:null,possibleExternalCalls:1,accountingScope:'POSSIBLE_EGRESS_NO_CONFIRMED_PROVIDER_USAGE_OR_BILLING'},cost:{money:null,pricebookRef:null,status:'UNMETERED'},admission:{domain:this.policy.domain,productionEstablished:false}};outcome.compute={...computeBody,id:'model-compute:'+hash(computeBody)};}
     history.push(await this.append(obligation,request.ref,'ACKNOWLEDGMENT',{...this.base(obligation,request.ref),memberId:member.memberId,operationId,...outcome},history.at(-1)));
    }
    if(dispatched)return {status:'UNRESOLVED',receipt:history.at(-1)!.receipt,responsibilityRetained:true,automaticMutationRetry:false};
   }
   const observations:any[]=[];
   let observationCount=history.filter(row=>row.event.type==='RECONCILIATION'&&row.event.detail.kind==='OBSERVATION_ATTEMPT').length;
   const exhausted=async()=>{
    const prior=history.find(row=>row.event.type==='RECONCILIATION'&&row.event.detail.kind==='OBSERVATION_BUDGET_EXHAUSTED');
    const retained=prior??await this.append(obligation,request.ref,'RECONCILIATION',{...this.base(obligation,request.ref),kind:'OBSERVATION_BUDGET_EXHAUSTED',status:'REQUIRES_OPERATOR',observationCount,observationLimit:64,responsibilityRetained:true,automaticMutationRetry:false},history.at(-1));
    return {status:'UNRESOLVED',receipt:retained.receipt,responsibilityRetained:true,automaticMutationRetry:false};
   };
   for(const member of request.ir.members){
    const attempt=attempts.find(row=>row.event.detail.memberId===member.memberId);if(!attempt)continue;
    if(observationCount>=64)return exhausted();
    const route=this.policy.routes.find((route:any)=>route.providerOrigin===member.request.providerOrigin&&route.applicationAccountId===member.request.applicationAccountId);if(!route)fail(503,'RECOVERY_PROVIDER_ROUTE_UNAVAILABLE');
    // Claim before credentials or sensitive network egress. A crash consumes
    // this ordinal; neither a caller nor a cold restart can reset the budget.
    const funding=await this.reserveUnits(obligation,request.ref,member.memberId,'RECOVERY',observationCount+1,1,deadlineAt);
    const claim=await this.append(obligation,request.ref,'RECONCILIATION',{...this.base(obligation,request.ref),funding,kind:'OBSERVATION_ATTEMPT',memberId:member.memberId,operationId:attempt.event.detail.operationId,observationOrdinal:++observationCount,observationLimit:64,status:'READ_MAY_HAVE_LEFT'},history.at(-1));history.push(claim);
    let detail:any;
    try{
     const url=new URL(`/accounts/${encodeURIComponent(member.request.applicationAccountId)}/records/${encodeURIComponent(member.request.recordKey)}`,route.providerOrigin);
     const result=await brokerRequest(url,{method:'GET',token:brokerToken(await brokerPrivateFile(route.tokenPath,route.tokenSha256)),ca:await brokerPrivateFile(route.caPath,route.caSha256),deadlineAt});
     const record=result.body,fields=record?.fields,shape=record&&typeof record==='object'&&!Array.isArray(record)&&same(Object.keys(record).sort(),['applicationAccountId','fields','lastOperationId','recordKey','version'])&&fields&&typeof fields==='object'&&!Array.isArray(fields)&&same(Object.keys(fields).sort(),Object.keys(member.request.changes).sort());
     const matched=result.status===200&&shape&&record.applicationAccountId===member.request.applicationAccountId&&record.recordKey===member.request.recordKey&&typeof record.version==='string'&&/^"[^"\r\n]{1,500}"$/.test(record.version)&&record.version!==member.request.expectedVersion&&result.etag===record.version&&record.lastOperationId===attempt.event.detail.operationId&&same(fields,member.request.changes);
     detail={status:matched?'MATCHED':'UNRESOLVED',httpStatus:result.status,responseDigest:result.responseDigest,...(shape?{observed:record}:{}),observationContract:'EXACT_RECORD_ACCOUNT_FIELDS_OPERATION_AND_STRONG_VERSION'};
    }catch(error){detail={status:'UNRESOLVED',reason:error instanceof LedgerFault?error.code:'OBSERVATION_UNAVAILABLE'};}
    const observation=await this.append(obligation,request.ref,'OBSERVATION',{...this.base(obligation,request.ref),memberId:member.memberId,operationId:attempt.event.detail.operationId,...detail},history.at(-1));history.push(observation);observations.push(observation);
   }
   if(observations.length===request.ir.members.length&&observations.every(row=>row.event.detail.status==='MATCHED')){
    const settlement=await this.append(obligation,request.ref,'VERIFICATION',{...this.base(obligation,request.ref),status:'VERIFIED',memberCount:request.ir.members.length,intentEventId:history.find(row=>row.event.type==='INTENT')!.event.eventId,observationEventIds:observations.map(row=>row.event.eventId),providerAcknowledgmentSufficient:false,executorSuccessSufficient:false,releaseGranted:false},history.at(-1));return {status:'VERIFIED',receipt:settlement.receipt,settlement:settlement.event.detail,semanticReplay:false};
   }
   return {status:'UNRESOLVED',receipt:history.at(-1)?.receipt??null,responsibilityRetained:true,automaticMutationRetry:false};
  });
 }
}

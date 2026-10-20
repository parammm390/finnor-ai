/** S6 ordinary disposable digital-experiment adapter. Credentials are private
 * host configuration, never model/programme/protocol/UI inputs. */
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {request as httpRequest} from 'node:http';
import {z} from 'zod';
import {withTenantTransaction,type Db} from '@finnor/db';
import type {BusinessEffectSet,DigitalTrial,DigitalHttpReceipt,DigitalExperimentProtocol} from '@finnor/shared-types';
import {brokerPrivateFile} from '../../governed-execution/src/broker-io';
import {canonical} from '../../governed-execution/src/canonical';
import {claimOwnedExternalOperation,readOwnedExternalOperationTx,prepareProviderInvocation,markProviderRequestMayHaveLeft,
 recordProviderInvocationAcknowledged,recordProviderInvocationFailure,reconcileOwnedExternalOperationTx,type ExternalOperationRow,type ProviderInvocationContext} from './idempotent-call';
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const id=z.string().uuid();
const Binding=z.object({id,tenantId:id,rootId:id,principalIds:z.array(id).min(1).max(8),role:z.enum(['analyst','auditor']),
 instanceId:id,applicationVersion:z.string().min(1).max(128),baseUrl:z.string().max(256),
 token:z.string().regex(/^[A-Za-z0-9_-]{24,256}$/),validUntil:z.string().datetime({offset:true})}).strict();
const Configuration=z.object({schema:z.literal('finnor.x4.disposable-bindings.v1'),targets:z.array(Binding).min(1).max(32)}).strict();
export type DigitalProviderBinding=z.infer<typeof Binding>&{bindingDigest:string};
export const DIGITAL_PROVIDER_INTERFACE={schema:'finnor.s6.x4-digital-http.v1',domain:'DISPOSABLE_LOOPBACK_ONLY',
 submit:'POST /v1/experiments',readback:'GET /v1/experiments/:originalTrialId',observe:'GET /v1/experiments/:originalTrialId/observations',
 controls:'GET /v1/controls/:registeredControl',maximumResponseBytes:262144,timeoutMs:5000,
 retry:'READ_ORIGINAL_ONLY_NEVER_RESUBMIT_POSSIBLE_DELIVERY',observation:'RAW_ROLE_BOUND_PAGINATION_NOT_ACK'} as const;
export function requireDisposableIdentification(){
 let database:URL;try{database=new URL(process.env.DATABASE_URL??'');}catch{throw Error('X4_DISPOSABLE_DATABASE_REQUIRED');}
 if(process.env.FINNOR_X4_PROFILE!=='DISPOSABLE'||!['ordinary_disposable','development'].includes(process.env.FINNOR_ENVIRONMENT??'')||
  !['127.0.0.1','[::1]'].includes(database.hostname)||process.versions.node.split('.')[0]!=='22')throw Error('X4_DISPOSABLE_NODE_22_RUNTIME_REQUIRED');
}
function validateOrigin(value:string){
 const u=new URL(value);
 if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||u.origin!==value||u.username||u.password)throw Error('X4_PROVIDER_ORIGIN_UNADMITTED');
}
async function bindings(){
 requireDisposableIdentification();
 const path=process.env.FINNOR_X4_BINDINGS;
 if(!path||!isAbsolute(path))throw Error('X4_PRIVATE_HOST_BINDINGS_REQUIRED');
 let bytes:Buffer;try{bytes=await brokerPrivateFile(path,undefined,65536);}catch{throw Error('X4_PRIVATE_HOST_BINDINGS_UNSAFE');}
 const config=Configuration.parse(JSON.parse(bytes.toString()));
 if(new Set(config.targets.map(t=>t.id)).size!==config.targets.length)throw Error('X4_DUPLICATE_HOST_BINDING');
 for(const t of config.targets)validateOrigin(t.baseUrl);
 return config.targets.map(t=>({...t,bindingDigest:hash(t)}));
}
export function publicDigitalBinding(b:DigitalProviderBinding){
 return {id:b.id,instanceId:b.instanceId,applicationVersion:b.applicationVersion,role:b.role,validUntil:b.validUntil,bindingDigest:b.bindingDigest};
}
export async function digitalProviderBindings(scope:{tenantId:string;principalId:string;rootId:string}){
 return (await bindings()).filter(t=>t.tenantId===scope.tenantId&&t.rootId===scope.rootId&&t.principalIds.includes(scope.principalId)&&Date.parse(t.validUntil)>Date.now());
}
export async function digitalProviderBinding(scope:{tenantId:string;principalId:string;rootId:string;targetId:string}){
 const b=(await digitalProviderBindings(scope)).find(t=>t.id===scope.targetId);
 if(!b)throw Error('X4_PROVIDER_BINDING_UNAVAILABLE');
 return b;
}
/** Metadata only, for a consent owner's exact replica cut. This never releases
 * the separately administered replica's bearer or permitted principal list. */
export async function digitalProviderTarget(scope:{tenantId:string;rootId:string;targetId:string}){
 const b=(await bindings()).find(t=>t.tenantId===scope.tenantId&&t.rootId===scope.rootId&&t.id===scope.targetId&&Date.parse(t.validUntil)>Date.now());
 if(!b)throw Error('X4_PROVIDER_BINDING_UNAVAILABLE');
 return publicDigitalBinding(b);
}
const controls=new Set(['empty','pagination','timing','role-analyst','role-auditor','integer-units','delayed','missing','duplicates','stale','repeated-cursor','skipped-cursor']);
function route(surface:{kind:'CONTROL';controlId:string;cursor:string|null}|{kind:'READBACK'|'OBSERVATIONS';trialId:string;cursor:string|null}){
 let path:string;
 if(surface.kind==='CONTROL'){if(!controls.has(surface.controlId))throw Error('X4_CONTROL_ROUTE_UNADMITTED');path='/v1/controls/'+surface.controlId;}
 else{if(!id.safeParse(surface.trialId).success)throw Error('X4_ORIGINAL_TRIAL_ID_REQUIRED');path='/v1/experiments/'+surface.trialId+(surface.kind==='OBSERVATIONS'?'/observations':'');}
 if(surface.cursor!==null){if(surface.cursor.length>256||!surface.cursor)throw Error('X4_CURSOR_BOUND');path+='?'+new URLSearchParams({cursor:surface.cursor});}
 return path;
}
function wire(b:DigitalProviderBinding,path:string,deadline:number,body?:DigitalTrial):Promise<DigitalHttpReceipt>{
 requireDisposableIdentification();validateOrigin(b.baseUrl);
 const remaining=Math.min(5000,deadline-Date.now(),Date.parse(b.validUntil)-Date.now());
 if(remaining<=0)return Promise.reject(Error('X4_ORIGINAL_WIRE_DEADLINE'));
 return new Promise((yes,no)=>{
  let done=false;
  const finish=(error:Error|null,value?:DigitalHttpReceipt)=>{if(done)return;done=true;clearTimeout(timer);error?no(error):yes(value!);};
  const bytes=body===undefined?null:Buffer.from(canonical(body));
  const request=httpRequest(new URL(path,b.baseUrl),{method:bytes?'POST':'GET',agent:false,
   headers:{authorization:'Bearer '+b.token,accept:'application/json','content-type':'application/json','cache-control':'no-cache',...(bytes?{'content-length':bytes.length}:{})}},response=>{
    const chunks:Buffer[]=[];let count=0;
    response.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>262144){response.destroy();finish(Error('X4_RESPONSE_BOUND'));}else chunks.push(chunk);});
    response.on('error',()=>finish(Error('X4_TRANSPORT_UNAVAILABLE')));
    response.on('end',()=>{try{
     const status=response.statusCode??0;if(status>=300&&status<400)throw Error('X4_REDIRECT_UNADMITTED');
     const result=JSON.parse(Buffer.concat(chunks,count).toString());
     // A provider may not smuggle a host credential into retained scientific data.
     if(canonical(result).includes(b.token))throw Error('X4_RESPONSE_CREDENTIAL_ECHO');
     finish(null,{cursor:null,status,body:result,receivedAt:new Date().toISOString()});
    }catch{finish(Error('X4_RESPONSE_INVALID'));}});
   });
  const timer=setTimeout(()=>{request.destroy();finish(Error('X4_TRANSPORT_DEADLINE'));},remaining);
  request.on('error',()=>finish(Error('X4_TRANSPORT_UNAVAILABLE')));
  request.end(bytes??undefined);
 });
}
export async function readDigitalProvider(b:DigitalProviderBinding,surface:Parameters<typeof route>[0],deadline:number){
 const r=await wire(b,route(surface),deadline);return {...r,cursor:surface.cursor};
}
export interface DigitalEffectBinding{tenantId:string;rootId:string;protocol:DigitalExperimentProtocol}
const owner=(b:DigitalEffectBinding)=>({type:'domain_action' as const,key:b.protocol.effect.domainActionId,domainActionId:b.protocol.effect.domainActionId});
export function compileDigitalExperimentIntent(b:DigitalEffectBinding,compiledAt:string):BusinessEffectSet{
 const p=b.protocol,actionType='digital_identification_experiment';
 const source={domainActionId:p.effect.domainActionId,actionType,workId:p.workId,objectiveStepId:null};
 const targets:BusinessEffectSet['targets']=[{kind:'entity',type:'pe_deal',id:b.rootId,sourcePath:'rootId'}];
 const delta={operation:actionType,values:{protocolDigest:hash(p),trial:p.trial,targetId:p.targetId,interfaceDigest:hash(DIGITAL_PROVIDER_INTERFACE)}};
 const scope={actionType,operationClass:'external_side_effect' as const,targets,bindings:[],delta,exposure:null};
 const expected={observation:'provider_delivery' as const,state:{originalTrialId:p.trial.id,deliveredDigest:hash(p.trial),operationKey:p.effect.operationKey}};
 return {id:p.effect.businessEffectId,schemaVersion:1,semanticHash:hash({source,...scope,expected}),scopeHash:hash(scope),source,mode:'consequential',
  operation:{name:actionType,class:'external_side_effect',external:true},targets,bindings:[],preconditions:[],before:[],delta,expected,exposure:null,
  authority:{capability:'action:digital_identification_experiment',risk:'low',policyId:null,policyVersion:null},
  approval:{required:false,typedConfirmation:false,summary:'Exact previously scoped experimental consent; disposable test data only'},
  reversibility:{classification:'unknown_provider_dependent',compensationCapability:null},
  uncertainty:{unknownOutcome:'reconcile_before_retry',stalePrecondition:'block_and_recompile'},
  provenance:{compiler:'finnor_effect_compiler',compilerVersion:1,compiledAt,replacementForEffectId:null,compensationForEffectId:null}};
}
export async function digitalExperimentOperation(b:DigitalEffectBinding){
 return withTenantTransaction(b.tenantId,{userId:b.protocol.principalId},db=>readOwnedExternalOperationTx(db,b.tenantId,owner(b),b.protocol.effect.operationKey));
}
/** No prior identity, even a pre-wire failure, is blindly resubmitted. A
 * conservative irrecoverable absence stays UNKNOWN under that original ID. */
export async function dispatchDigitalExperiment(b:DigitalEffectBinding,target:DigitalProviderBinding,
 boundary:<T>(action:(recheck:()=>Promise<void>)=>Promise<T>)=>Promise<T>,deadline:number){
 const p=b.protocol;
 if(target.tenantId!==b.tenantId||target.rootId!==b.rootId||target.id!==p.targetId||target.instanceId!==p.trial.instanceId||
  target.role!==p.trial.role||target.applicationVersion!==p.trial.applicationVersion||!target.principalIds.includes(p.principalId))throw Error('X4_EXACT_PROVIDER_BINDING_CHANGED');
 const prior=await digitalExperimentOperation(b);
 if(prior){
  if(prior.requestHash!==hash(p.trial)||prior.businessEffectId!==p.effect.businessEffectId)throw Error('X4_ORIGINAL_OPERATION_CHANGED');
  return {operation:prior,reconciliationOnly:true};
 }
 const claim=await claimOwnedExternalOperation(b.tenantId,owner(b),p.effect.operationKey,hash(p.trial),'x4_digital_disposable_v1',p.effect.businessEffectId,undefined,
  {principalId:p.principalId,protocolVersion:2,targetKey:p.targetId,retrySafety:'readback_required',verification:'readback',idempotency:{mode:'readback'}});
 if(!claim.claimed)return {operation:claim.existing,reconciliationOnly:true};
 const context:ProviderInvocationContext={tenantId:b.tenantId,principalId:p.principalId,provider:'x4_digital_disposable_v1',
  providerOperationAttemptId:claim.providerOperationAttemptId,requestHash:hash(p.trial),transportLayer:'provider_adapter'};
 const invocation=await prepareProviderInvocation(context,1);let possible=false;
 try{
  const response=await boundary(async recheck=>{
   await markProviderRequestMayHaveLeft(b.tenantId,invocation,p.principalId);possible=true;
   await recheck();return wire(target,'/v1/experiments',deadline,p.trial);
  });
  if(response.status<200||response.status>=300)throw Error('X4_PROVIDER_RESPONSE_NOT_EXECUTION_PROOF');
  await recordProviderInvocationAcknowledged(context,invocation,{trialId:p.trial.id,protocolDigest:hash(p),qualification:'ACK_ONLY_NOT_OBSERVATION'}, {advanceLogicalOperation:false});
  return {operation:claim.operation,reconciliationOnly:false};
 }catch(error){
  await recordProviderInvocationFailure(context,invocation,{kind:'x4_original_outcome_unresolved',message:'Read original experiment only; no blind repetition',definitePreDispatch:!possible});
  if(!possible)throw error;
  return {operation:claim.operation,reconciliationOnly:true};
 }
}
export async function reconcileDigitalExperimentTx(db:Db,b:DigitalEffectBinding,receipt:DigitalHttpReceipt):Promise<ExternalOperationRow>{
 const p=b.protocol,body=receipt.body as Record<string,unknown>;
 if(receipt.status!==200||!body||body.status!=='COMPLETE'||body.id!==p.trial.id||body.instanceId!==p.trial.instanceId||
  body.applicationVersion!==p.trial.applicationVersion||body.role!==p.trial.role||body.units!=='count'||hash(body.delivered)!==hash(p.trial))throw Error('X4_ACTUAL_DELIVERY_UNRESOLVED_OR_DIVERGENT');
 const operation=await readOwnedExternalOperationTx(db,b.tenantId,owner(b),p.effect.operationKey);
 if(!operation||operation.requestHash!==hash(p.trial)||operation.businessEffectId!==p.effect.businessEffectId)throw Error('X4_CANONICAL_ORIGINAL_OPERATION_MISSING');
 if(operation.executionState==='reconciled')return operation;
 return reconcileOwnedExternalOperationTx(db,b.tenantId,operation.id,'succeeded',{trialId:p.trial.id,actualExposureDigest:hash(body.delivered),
  readbackDigest:hash(receipt),qualification:'EXACT_DELIVERY_ONLY_NOT_SCIENTIFIC_ACCEPTANCE'});
}

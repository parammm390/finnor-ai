import assert from 'node:assert/strict';
import {randomUUID,randomBytes,generateKeyPairSync,createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve,isAbsolute} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import type {PrimaryRequest,PrimarySourceProfile} from '@finnor/shared-types';
import {primarySourceOperation} from '../../packages/governed-execution/src/primary-records';
import {preparePrimaryHttpsFixture} from '../v2/https-source-fixture.mts';

const evidence=process.argv[2];if(!evidence||!isAbsolute(evidence)||process.version!=='v22.22.3')throw Error('EXTERNAL_EVIDENCE_AND_FIXED_NODE_REQUIRED');
await mkdir(evidence,{recursive:false});
const directory=await mkdtemp(join(tmpdir(),'finnor-primary-https-')),cases:any[]=[],startedAt=new Date().toISOString();
const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const ref=(owner:string,id:string,body:unknown)=>({owner,id,revision:'1',contentDigest:hash(body)});
const tenantId=randomUUID(),principalId=randomUUID(),legalEntityId=randomUUID();
const {identity,validFrom,expiresAt,policy,policyFile,savePolicy,admit:admission}=await preparePrimaryHttpsFixture(directory,tenantId,principalId);
const envNames=['NODE_ENV','FINNOR_V2_PROFILE','FINNOR_PRIMARY_TRANSPORT_POLICY_FILE'];
const prior=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
Object.assign(process.env,{NODE_ENV:'test',FINNOR_V2_PROFILE:'production_primary',FINNOR_PRIMARY_TRANSPORT_POLICY_FILE:policyFile});
await writeFile(join(evidence,'pre-run-freeze.json'),JSON.stringify({startedAt,node:process.version,identity,fixtures:await Promise.all(['primary-transport-e2e.mts','../v2/controlled-source.mts','../v2/https-source-fixture.mts'].map(async p=>({path:p,sha256:createHash('sha256').update(await readFile(resolve(import.meta.dirname,p))).digest('hex')}))),qualification:'ACTUAL_HTTPS_BROKER_AND_INDEPENDENTLY_SIGNED_PUBLIC_FIXTURE; TRANSPORT_ONLY; NO_CUSTOMER_OR_DOMAIN_ADMISSION'},null,2));
let child:ReturnType<typeof spawn>|undefined,descriptor:any,sequence=0,calls:any[]=[],failure:any;
async function rpc(type:string,body:any={}){
 assert(child?.connected);const id=++sequence;
 return new Promise<any>((yes,no)=>{const timer=setTimeout(()=>{child!.off('message',listen);no(Error('OWNED_SOURCE_RPC_DEADLINE'));},5000);const listen=(m:any)=>{if(m.id!==id)return;clearTimeout(timer);child!.off('message',listen);yes(m);};child!.on('message',listen);child!.send({type,id,...body});});
}
async function observe(){calls=(await rpc('inspect')).calls;return calls;}
async function test(id:string,fn:()=>Promise<unknown>){const start=performance.now();try{const observed=await fn();cases.push({id,status:'PASS',observed,elapsedMs:performance.now()-start});}catch(error:any){cases.push({id,status:'FAIL',code:error.code??null,message:error.message});throw error;}}
function request(profile:PrimarySourceProfile):PrimaryRequest{
 return {schema:'finnor.primary-request.v1',requestId:randomUUID(),tenantId,principalId,programmeId:randomUUID(),assertionRefs:[ref('V2',randomUUID(),{exactFacility:'public-fixture-facility'})],
  sourceProfileRef:ref('S1',profile.profileId,profile),consentRef:ref('S1',randomUUID(),{publicFixture:true}),authorityRef:ref('S6',randomUUID(),{publicFixture:true}),mandateRef:ref('S4',randomUUID(),{publicFixture:true}),grantRef:ref('S5',randomUUID(),{publicFixture:true}),semanticsRef:ref('S2',randomUUID(),{publicFixture:true}),
  legalEntityId,accountOrParticipantIds:['public-lender'],purpose:profile.purpose,product:profile.products[0]!,fieldNames:['outstanding','ledgerState'],periodStart:'2025-01-01T00:00:00.000Z',periodEnd:'2025-12-31T23:59:59.000Z',cutoff:'2025-12-31T23:59:59.000Z',populationId:'public-facilities',populationRevision:'1',requiredMembers:['public-lender'],economicRecordIds:['public-fixture-facility'],knowledgeCut:new Date().toISOString(),requestedAt:new Date().toISOString(),expiresAt};
}
async function configure(profile:PrimarySourceProfile){
 const credential=randomBytes(24).toString('base64url');await writeFile(join(directory,profile.credentialRef!),credential,{mode:0o600});
 await rpc('configure',{profiles:[{public:profile,credential,recordKinds:['FACILITY'],records:[{issuerRecordId:'issuer-public-facility',economicId:'public-fixture-facility',revision:1,kind:'FACILITY',legalEntityId,accountOrParticipantId:'public-lender',periodStart:'2025-01-01T00:00:00.000Z',periodEnd:'2025-12-31T23:59:59.000Z',currency:'USD',units:'dollars',basisDigest:'a'.repeat(64),state:'POSTED',replacesEconomicId:null,reversesEconomicId:null,aliasOf:null,effectiveAt:'2025-12-31T23:59:59.000Z',observedAt:validFrom,fields:{outstanding:{kind:'EXACT',quantity:{numerator:'5000000',denominator:'1'}}},witnessFields:{ledgerState:'POSTED'},relatedParty:'NO'}]}]});
}
async function denied(profile:PrimarySourceProfile,q:PrimaryRequest,operation:'ACQUIRE'|'STATUS'|'PAGE'|'READ_RESULT',code:string){
 const before=(await observe()).length;let observed:any;
 await assert.rejects(()=>primarySourceOperation(profile,q,{operation,...(operation==='PAGE'?{cursor:'page-2'}:{}),deadlineAt:Date.now()+5000}),error=>{observed={code:(error as any).code};return observed.code===code;});
 assert.equal((await observe()).length,before);return {before,after:calls.length,refused:observed};
}
try{
 child=spawn(process.execPath,['--import=tsx',resolve(import.meta.dirname,'../v2/controlled-source.mts'),directory,'tls'],{cwd:resolve(import.meta.dirname,'../..'),env:{PATH:process.env.PATH,NODE_ENV:'test'},stdio:['ignore','ignore','ignore','ipc']});
 descriptor=await new Promise<any>((yes,no)=>{const timer=setTimeout(()=>no(Error('OWNED_TLS_SOURCE_START_DEADLINE')),10000);child!.on('message',(m:any)=>{if(m.type==='ready'){clearTimeout(timer);yes(m);}});child!.once('exit',()=>{clearTimeout(timer);no(Error('OWNED_TLS_SOURCE_START_FAILED'));});});
 const base:any={schema:'finnor.primary-source-profile.v1',profileId:randomUUID(),revision:1,issuer:'Independent public fixture issuer',system:'Independent public facility ledger',legalEntityId,sourceClass:'EXTERNAL_AUTHORITATIVE_RECORD',sourceControl:'EXTERNAL_ISSUER',accountOrParticipantIds:['public-lender'],products:['public-primary-records'],purpose:'PUBLIC_FIXTURE_PRIMARY_DILIGENCE',channelId:'public-fixture-ledger',channelResolutionEvidenceRef:ref('S1','public-channel',{publicFixture:true}),endpoint:descriptor.origin+'/primary',responsePublicKeyPem:descriptor.publicKey,credentialRef:'public-fixture-credential',authoritativeFields:['outstanding','ledgerState'],respondentId:null,respondentRole:null,respondentKnowledge:[],respondentAuthorityRef:null,intermediary:null,availableHistory:{start:'2025-01-01T00:00:00.000Z',end:'2025-12-31T23:59:59.000Z',reasons:[]},observationPredicates:['SIGNED_LEDGER_CUTOFF'],adapterVersion:'primary-records-http-v1',recovery:'IDEMPOTENT_REQUEST_WITH_STATUS',price:{pricebookRef:ref('S5','public-pricebook',{publicFixture:true}),maximumRequestMicroUsd:'1000',statusReadMicroUsd:'0'},rightsRef:ref('S1','public-rights',{publicFixture:true}),authorityEvidenceRefs:[ref('S1','public-issuer',{publicFixture:true})],environment:'LIVE',validFrom,expiresAt};
 const profile=await admission(base),q=request(profile);await configure(profile);
 await test('admitted-live-https-read',async()=>{const result=await primarySourceOperation(profile,q,{operation:'ACQUIRE',deadlineAt:Date.now()+5000});assert.equal(result.status,200);assert.equal(result.response?.body.records[0]?.fields.outstanding?.kind,'EXACT');assert.deepEqual(result.response?.body.records[0]?.fields.outstanding,{kind:'EXACT',quantity:{numerator:'5000000',denominator:'1'}});assert.equal((await observe()).filter(c=>c.operation==='ACQUIRE'&&c.requestId===q.requestId).length,1);return {requestId:q.requestId,response:result.response,transportDigest:result.transportDigest,providerCalls:calls.length};});
 await test('foreign-principal-before-egress',()=>denied(profile,{...q,principalId:randomUUID()},'READ_RESULT','PRIMARY_TRANSPORT_EXACT_ADMISSION_OR_SCOPE_UNPASSED'));
 await test('changed-profile-before-egress',()=>denied({...profile,purpose:'FOREIGN_PURPOSE'},q,'ACQUIRE','PRIMARY_TRANSPORT_EXACT_ADMISSION_OR_SCOPE_UNPASSED'));
 const wrongRuntime=await admission(base,expiresAt,{transportIdentityDigest:'0'.repeat(64)});
 await test('wrong-runtime-before-egress',()=>denied(wrongRuntime,request(wrongRuntime),'ACQUIRE','PRIMARY_TRANSPORT_EXACT_ADMISSION_OR_SCOPE_UNPASSED'));
 const wrongSigner=await admission(base,expiresAt,{},generateKeyPairSync('ed25519').privateKey);
 await test('wrong-independent-signature-before-egress',()=>denied(wrongSigner,request(wrongSigner),'ACQUIRE','PRIMARY_TRANSPORT_INDEPENDENT_SIGNATURE_INVALID'));
 await test('revoked-trust-before-egress',async()=>{policy.trustedIssuerKeys[0]!.revoked=true;await savePolicy();try{return await denied(profile,q,'STATUS','PRIMARY_TRANSPORT_EXACT_ADMISSION_OR_SCOPE_UNPASSED');}finally{policy.trustedIssuerKeys[0]!.revoked=false;await savePolicy();}});
 await test('tls-verification-remains-required',async()=>{delete policy.caFile;await savePolicy();try{return await denied(profile,q,'READ_RESULT','BROKER_TRANSPORT_UNAVAILABLE');}finally{policy.caFile=join(directory,'source-tls.crt');await savePolicy();}});
 const expiredSource=await admission({...base,expiresAt:new Date(Date.now()-250).toISOString()}),expiredSourceRequest=request(expiredSource);
 expiredSourceRequest.requestedAt=new Date(Date.now()-1000).toISOString();
 await test('admission-cannot-extend-source-validity',()=>denied(expiredSource,expiredSourceRequest,'ACQUIRE','PRIMARY_TRANSPORT_EXACT_ADMISSION_OR_SCOPE_UNPASSED'));
 await test('admission-cannot-extend-request-validity',()=>denied(profile,{...q,requestId:randomUUID(),requestedAt:new Date(Date.now()-2000).toISOString(),expiresAt:new Date(Date.now()-1000).toISOString()},'ACQUIRE','PRIMARY_TRANSPORT_EXACT_ADMISSION_OR_SCOPE_UNPASSED'));
 const until=new Date(Date.now()+2500).toISOString(),shortProfile=await admission({...base,profileId:randomUUID(),credentialRef:'public-recovery-credential',expiresAt:until},until),original=request(shortProfile);original.expiresAt=until;await configure(shortProfile);
 await test('expired-admission-original-status-only',async()=>{await primarySourceOperation(shortProfile,original,{operation:'ACQUIRE',deadlineAt:Date.now()+2000});await new Promise(yes=>setTimeout(yes,Math.max(1,Date.parse(until)-Date.now()+50)));const status=await primarySourceOperation(shortProfile,original,{operation:'STATUS',deadlineAt:Date.now()+5000});assert.equal(status.requestStatus?.body.requestId,original.requestId);assert.equal(status.requestStatus?.body.outcome,'ACKNOWLEDGED');assert.equal(status.response,null);for(const operation of ['ACQUIRE','PAGE','READ_RESULT']as const)await denied(shortProfile,original,operation,'PRIMARY_TRANSPORT_EXACT_ADMISSION_OR_SCOPE_UNPASSED');const physical=(await observe()).filter(c=>c.requestId===original.requestId);assert.deepEqual(physical.map(c=>c.operation),['ACQUIRE','STATUS']);return {requestId:original.requestId,physical,status:status.requestStatus};});
}catch(error:any){failure={code:error.code??null,message:error.message,stack:error.stack};}
finally{
 if(child?.connected){try{await observe();}catch{}const ended=once(child,'exit');child.send({type:'stop'});const timer=setTimeout(()=>child?.kill('SIGKILL'),5000);await ended;clearTimeout(timer);}
 await rm(directory,{recursive:true,force:true});for(const[k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 const result={schema:'finnor.primary-transport-e2e.v1',startedAt,finishedAt:new Date().toISOString(),status:failure?'FAIL':'PASS_TRANSPORT_ONLY',cases,calls,failure,allOwnedResourcesRemoved:true,productionApiWorkerAndFinancialReleaseQualified:false,qualification:'Actual broker HTTPS and source signature protocol with independent public fixture issuer. No live customer data or real domain/S8 admission.',rerun:{node:process.execPath,args:['--import=tsx','scripts/acquisition/primary-transport-e2e.mts','FRESH_EXTERNAL_EVIDENCE_DIRECTORY']}};await writeFile(join(evidence,'results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({status:result.status,evidence,cases:cases.length}));
}
process.exit(failure?1:0);

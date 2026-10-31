import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {resolve,join} from 'node:path';
import {receiveWork,configureTenantVertical} from '@finnor/db';
import {canonical} from '../../../packages/governed-execution/src/protocol';
import {jsonHash} from '../../../packages/epistemic-runtime/src/uniform-algorithms/syntax';
import {startEnvironment} from '../../x3/environment.mts';

const evidence=resolve(process.env.FINNOR_Y5_EVIDENCE_DIR??'../evidence/y5-specification-owner');
await mkdir(evidence,{recursive:true,mode:0o700});
const save=(name:string,value:unknown)=>writeFile(join(evidence,name),JSON.stringify(value,null,2)+'\n',{mode:0o600});
const policyPath=join(evidence,'disposable-public-policy.json');
process.env.FINNOR_Y5_PROFILE='ORDINARY_NATIVE_DIAGNOSTIC';
process.env.FINNOR_Y5_SPECIFICATION_POLICY=policyPath;
const env=await startEnvironment(evidence),started=Date.now(),observed:unknown[]=[];
try{
 const tenant=randomUUID(),principal=randomUUID(),other=randomUUID(),root={entityType:'external_organization' as const,entityId:randomUUID()};
 await env.admin.query('INSERT INTO finnor_os.tenants(id,client_key,name) VALUES($1,$2,$3)',[tenant,randomUUID(),'Y5 specification boundary']);
 for(const id of [principal,other])await env.admin.query("INSERT INTO finnor_os.users(id,tenant_id,email,role,status) VALUES($1,$2,$3,'owner','active')",[id,tenant,id+'@y5.example.test']);
 await env.admin.query("INSERT INTO finnor_os.external_organizations(id,tenant_id,organization_key,name,kind) VALUES($1,$2,$3,$3,'other')",[root.entityId,tenant,randomUUID()]);
 await configureTenantVertical({tenantId:tenant,verticalKey:'private_equity',expectedVersion:0,createdBy:principal,sourceSystem:'y5:specification-e2e'});
 env.http!.register(principal,principal+'@y5.example.test');env.http!.register(other,other+'@y5.example.test');
 const token=await env.http!.login(principal),otherToken=await env.http!.login(other);
 const definition={schema:'finnor.y5.total-family-definition.v2',input:'ALL_FINITE_INTEGER_LISTS',output:'MATHEMATICAL_INTEGER',semanticState:'INT',
  safe:{op:'LE',left:{op:'INT',value:'0'},right:{op:'VAR',index:0}},advance:{op:'ADD',left:{op:'VAR',index:0},right:{op:'VAR',index:1}},
  objective:'LEAST_FEASIBLE_INITIAL_STATE',prefixes:'INCLUDING_EMPTY_AND_COMPLETE',numericalMeaning:'EXACT_UNBOUNDED_INTEGER',
  tie:'EQUAL_INTEGER_OUTPUT',costModel:'CLOSED_AST_NODE_AND_FOLD_STEPS_UNIT_INTEGER_ARITHMETIC_V2'};
 const create=(body:unknown)=>receiveWork({tenantId:tenant,userId:principal,channel:'console',instruction:JSON.stringify(body),
  idempotencyKey:randomUUID(),entityAttachments:[{...root,source:'Y5:public-specification-boundary'}]});
 const read=async(workId:string,extra:unknown={},auth=token)=>{
  const r=await env.http!.api(auth,'uniform-algorithms','specification',{root,workId,...extra as object});
  observed.push({operation:'specification',status:r.status,resolution:r.body?.status,reason:r.body?.reason});return r;
 };
 const plain=await create({schema:'finnor.y5.work-specification.v2',definition,acceptanceReceipt:null});
 const publicResult=await read(plain.workId);assert.equal(publicResult.status,200);
 assert.equal(publicResult.body.status,'PUBLIC_DEVELOPMENT');
 assert.equal(publicResult.body.specification.sourceRef.owner,'WORK_INPUT');
 assert.equal(publicResult.body.specification.acceptance.protectedFamilyCredit,false);
 const sourceRef=publicResult.body.specification.sourceRef;
 assert.equal((await read(plain.workId,{expectedSourceRef:sourceRef})).status,200);
 assert.equal((await read(plain.workId,{definition})).status,400);
 assert.equal((await read(plain.workId,{},otherToken)).status,404);
 const suppliedAlgorithm=await create({schema:'finnor.y5.work-specification.v2',definition:{...definition,program:'supplied optimum'},acceptanceReceipt:null});
 assert.equal((await read(suppliedAlgorithm.workId)).body.status,'UNAVAILABLE');
 const {publicKey,privateKey}=generateKeyPairSync('ed25519');
 const receiptBody={schema:'finnor.y5.semantic-acceptance.v2',issuerId:'disposable-test-issuer',keyId:'test-key',receiptId:randomUUID(),
  tenantId:tenant,definitionDigest:jsonHash(definition),policyRevision:'test-policy-v1',scope:'finnor.y5.total-family-definition.v2',
  acceptedAt:new Date(Date.now()-1000).toISOString(),validUntil:new Date(Date.now()+600000).toISOString()};
 const receipt={...receiptBody,signature:sign(null,Buffer.from(canonical(receiptBody)),privateKey).toString('base64')};
 const signed=await create({schema:'finnor.y5.work-specification.v2',definition,acceptanceReceipt:receipt});
 const absent=await read(signed.workId);assert.equal(absent.body.status,'UNAVAILABLE');
 const policy={schema:'finnor.y5.semantic-policy.v2',profile:'PUBLIC_DEVELOPMENT_FIXTURE',revision:'test-policy-v1',
  approvalRef:{owner:'EXTERNAL_SEMANTIC_POLICY',id:'DISPOSABLE_NOT_APPROVED',version:'v1',contentDigest:jsonHash('disposable')},
  validAfter:new Date(Date.now()-60000).toISOString(),validUntil:new Date(Date.now()+600000).toISOString(),
  revokedReceiptIds:[],issuers:[{id:receipt.issuerId,keyId:receipt.keyId,principalId:other,
   role:'INDEPENDENT_TASK_SEMANTICS_ACCEPTOR',status:'ACTIVE',tenantIds:[tenant],scopes:[receipt.scope],
   publicKey:publicKey.export({type:'spki',format:'pem'}).toString()}]};
 await save('disposable-public-policy.json',policy);
 const local=await read(signed.workId);assert.equal(local.body.status,'PUBLIC_DEVELOPMENT');
 assert.equal(local.body.specification.acceptance.reason,'DISPOSABLE_POLICY_NOT_INDEPENDENT_ACCEPTANCE');
 assert.equal(local.body.specification.acceptance.protectedFamilyCredit,false);
 const forged=await create({schema:'finnor.y5.work-specification.v2',definition,acceptanceReceipt:{...receipt,definitionDigest:jsonHash('another task')}});
 assert.equal((await read(forged.workId)).body.status,'UNAVAILABLE');
 await save('disposable-public-policy.json',{...policy,revokedReceiptIds:[receipt.receiptId]});
 assert.equal((await read(signed.workId)).body.status,'UNAVAILABLE');
 await receiveWork({tenantId:tenant,userId:principal,workId:plain.workId,channel:'console',instruction:'The previous specification is superseded.',idempotencyKey:randomUUID()});
 assert.equal((await read(plain.workId,{expectedSourceRef:sourceRef})).status,409);
 await save('results.json',{status:'PASS',scope:'AUTHENTICATED_NATIVE_WORK_SPECIFICATION_RESOLVER_NOT_INDEPENDENT_ACCEPTANCE',
  wallMs:Date.now()-started,sourceRef,definition,observed,localPolicyDidNotCreateAcceptedState:true,
  rerun:'FINNOR_Y5_EVIDENCE_DIR=<new-directory> node_modules/.bin/tsx scripts/postx/y5/verify-specification-owner.mts'});
 console.log(JSON.stringify({status:'PASS',evidence}));
}catch(error){await save('failure.json',{status:'FAIL',error:String(error),stack:(error as Error).stack,observed});throw error;}
finally{await env.close();}

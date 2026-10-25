import {randomUUID,generateKeyPairSync,createHash,sign,type KeyObject} from 'node:crypto';
import {writeFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {PrimarySourceProfile} from '@finnor/shared-types';
import {primaryTransportIdentity} from '../../packages/capability-evolution/src/primary-admission';

const canonical=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canonical).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const ref=(id:string,body:unknown)=>({owner:'S8',id,revision:'1',contentDigest:hash(body)});

export async function preparePrimaryHttpsFixture(directory:string,tenantId:string,principalId:string){
 const issuer=generateKeyPairSync('ed25519'),identity=await primaryTransportIdentity();
 const validFrom=new Date(Date.now()-60000).toISOString(),expiresAt=new Date(Date.now()+3600000).toISOString();
 const policy={admissionDirectory:directory,credentialDirectory:directory,caFile:join(directory,'source-tls.crt') as string|undefined,
  trustedIssuerKeys:[{id:'independent-public-fixture-key',principalId:'independent-public-fixture-reviewer',
   publicKey:issuer.publicKey.export({format:'pem',type:'spki'}).toString(),validAfter:validFrom,validUntil:expiresAt,revoked:false}]};
 const policyFile=join(directory,'transport-policy.json');
 const savePolicy=()=>writeFile(policyFile,JSON.stringify(policy),{mode:0o600});
 const config=join(directory,'tls.cnf');
 await writeFile(config,'[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=127.0.0.1\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n',{mode:0o600});
 await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-sha256','-nodes','-days','1','-config',config,'-keyout',join(directory,'source-tls.key'),'-out',join(directory,'source-tls.crt')]);
 await chmod(join(directory,'source-tls.key'),0o600);await chmod(join(directory,'source-tls.crt'),0o600);await savePolicy();
 async function admit(profile:Omit<PrimarySourceProfile,'admissionRef'>&{admissionRef?:PrimarySourceProfile['admissionRef']},validUntil=expiresAt,overrides:Record<string,unknown>={},signer:KeyObject=issuer.privateKey){
  const {admissionRef:_old,...preimage}=profile,receiptId=randomUUID();
  const body={schema:'finnor.s8.primary-transport-admission.v1',owner:'S8',domain:'PRIMARY_SOURCE_READ_TRANSPORT',receiptId,revision:1,
   issuerPrincipalId:policy.trustedIssuerKeys[0]!.principalId,tenantId,principalId,profileDigest:hash(preimage),transportIdentityDigest:identity.digest,environment:'LIVE',
   independentReviewRef:ref('public-fixture-review',{synthetic:true}),evaluatorReceiptRef:ref('public-fixture-transport-proof',{synthetic:true}),retainedStatusRecovery:true,
   activityAuthorityGranted:false,economicQualificationGranted:false,validFrom,validUntil,...overrides};
  const signed={body,keyId:policy.trustedIssuerKeys[0]!.id,signature:sign(null,Buffer.from(canonical(body)),signer).toString('base64')};
  await writeFile(join(directory,receiptId+'.json'),JSON.stringify(signed),{mode:0o600});
  return {...preimage,admissionRef:ref(receiptId,signed)} as PrimarySourceProfile;
 }
 return {identity,validFrom,expiresAt,policy,policyFile,savePolicy,admit};
}

import {createHash,createPublicKey,verify} from 'node:crypto';
import {createRequire} from 'node:module';
import {isAbsolute,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {VReferenceSchema,PrimaryRequestSchema,PrimarySourceProfileSchema,type PrimaryRequest,type PrimarySourceProfile} from '@finnor/shared-types';
import {brokerPrivateFile,brokerSourceDigests} from '../../governed-execution/src/broker-io';
import {canonical,LedgerFault} from '../../governed-execution/src/protocol';

const hash=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const instant=z.string().datetime({offset:true}),hex=z.string().regex(/^[a-f0-9]{64}$/);
const absolutePath=z.string().min(1).max(4096).refine(isAbsolute);
export const PrimaryTransportPolicySchema=z.object({
 admissionDirectory:absolutePath,credentialDirectory:absolutePath,caFile:absolutePath.optional(),
 trustedIssuerKeys:z.array(z.object({id:z.string().min(1).max(160),principalId:z.string().min(1).max(200),
  publicKey:z.string().min(40).max(4096).startsWith('-----BEGIN PUBLIC KEY-----'),validAfter:instant,validUntil:instant,revoked:z.boolean()}).strict()).min(1).max(32),
}).strict().superRefine((policy,ctx)=>{
 if(new Set(policy.trustedIssuerKeys.map(key=>key.id)).size!==policy.trustedIssuerKeys.length
  ||policy.trustedIssuerKeys.some(key=>Date.parse(key.validUntil)<=Date.parse(key.validAfter)))ctx.addIssue({code:'custom',message:'Unique issuer identities and ordered validity are required'});
});
export const PrimaryTransportAdmissionSchema=z.object({
 body:z.object({schema:z.literal('finnor.s8.primary-transport-admission.v1'),owner:z.literal('S8'),
  domain:z.literal('PRIMARY_SOURCE_READ_TRANSPORT'),receiptId:z.string().uuid(),revision:z.number().int().positive(),
  issuerPrincipalId:z.string().min(1).max(200),tenantId:z.string().uuid(),principalId:z.string().uuid(),
  profileDigest:hex,transportIdentityDigest:hex,environment:z.literal('LIVE'),
  independentReviewRef:VReferenceSchema,evaluatorReceiptRef:VReferenceSchema,
  retainedStatusRecovery:z.literal(true),activityAuthorityGranted:z.literal(false),economicQualificationGranted:z.literal(false),
  validFrom:instant,validUntil:instant,
 }).strict(),keyId:z.string().min(1).max(160),signature:z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();

const sourceCustody=createRequire(import.meta.url)('@finnor/source-custody') as {sourceURL(path:string):string};
const sourcePaths=[
 'finnor-os/packages/capability-evolution/src/primary-admission.ts',
 'finnor-os/packages/governed-execution/src/primary-records.ts',
 'finnor-os/packages/governed-execution/src/broker-io.ts',
 'finnor-os/packages/governed-execution/src/protocol.ts',
 'finnor-os/packages/shared-types/src/primary-diligence.ts',
 'finnor-os/packages/source-custody/index.cjs',
];
async function currentIdentity(){
 const directory=dirname(fileURLToPath(sourceCustody.sourceURL(sourcePaths[0]!)));
 const names=[...sourcePaths,'finnor-os/package-lock.json','package-lock.json'];
 const paths=[...sourcePaths.map(path=>fileURLToPath(sourceCustody.sourceURL(path))),resolve(directory,'../../../package-lock.json'),resolve(directory,'../../../../package-lock.json')];
 const files=await brokerSourceDigests(paths);
 return {digest:hash({files:files.map((file,i)=>({path:names[i],sha256:file.sha256})),node:process.version,platform:process.platform,arch:process.arch}),files};
}
const loadedIdentity=currentIdentity();
export async function primaryTransportIdentity(){
 const loaded=await loadedIdentity;
 if(loaded.digest!==(await currentIdentity()).digest)throw new LedgerFault(409,'PRIMARY_TRANSPORT_SOURCE_CHANGED');
 return loaded;
}

type PrimarySourceUse={kind:'current';tenantId:string;principalId:string}|{kind:'request';request:PrimaryRequest;operation:'ACQUIRE'|'STATUS'|'PAGE'|'READ_RESULT'};
export async function admittedPrimarySource(profile:PrimarySourceProfile,use:PrimarySourceUse){
 profile=PrimarySourceProfileSchema.parse(profile);
 use=use.kind==='request'?{...use,request:PrimaryRequestSchema.parse(use.request)}:use;
 const request=use.kind==='request'?use.request:null,scope=use.kind==='request'?use.request:use;
 const policyFile=process.env.FINNOR_PRIMARY_TRANSPORT_POLICY_FILE;
 if(process.env.FINNOR_V2_PROFILE!=='production_primary'||!policyFile||!profile.admissionRef||profile.admissionRef.owner!=='S8'
  ||!z.string().uuid().safeParse(profile.admissionRef.id).success)throw new LedgerFault(424,'PRIMARY_TRANSPORT_ADMISSION_REQUIRED');
 const policy=PrimaryTransportPolicySchema.parse(JSON.parse((await brokerPrivateFile(policyFile)).toString('utf8')));
 const admission=PrimaryTransportAdmissionSchema.parse(JSON.parse((await brokerPrivateFile(policy.admissionDirectory+'/'+profile.admissionRef.id+'.json')).toString('utf8')));
 const {body}=admission,key=policy.trustedIssuerKeys.find(key=>key.id===admission.keyId),now=Date.now();
 const {admissionRef:_admission,...preimage}=profile;
 const issuedAt=Date.parse(body.validFrom),expiresAt=Date.parse(body.validUntil),requestedAt=request?Date.parse(request.requestedAt):now;
 const statusRecovery=use.kind==='request'&&use.operation==='STATUS'&&body.retainedStatusRecovery&&requestedAt>=issuedAt&&requestedAt<expiresAt;
 if(profile.environment!=='LIVE'||body.tenantId!==scope.tenantId||body.principalId!==scope.principalId
  ||body.receiptId!==profile.admissionRef.id||String(body.revision)!==profile.admissionRef.revision||hash(admission)!==profile.admissionRef.contentDigest
  ||body.profileDigest!==hash(preimage)||body.transportIdentityDigest!==(await primaryTransportIdentity()).digest
  ||body.independentReviewRef.owner!=='S8'||body.evaluatorReceiptRef.owner!=='S8'
  ||!key||key.revoked||key.principalId!==body.issuerPrincipalId||key.principalId===scope.principalId
  ||issuedAt>=expiresAt||now<issuedAt||requestedAt>now||requestedAt<issuedAt||requestedAt>=expiresAt
  ||now>=expiresAt&&!statusRecovery
  ||requestedAt<Date.parse(profile.validFrom)||requestedAt>=Date.parse(profile.expiresAt)
  ||!statusRecovery&&(now>=Date.parse(profile.expiresAt)||request!==null&&now>=Date.parse(request.expiresAt))
  ||Date.parse(key.validAfter)>issuedAt||Date.parse(key.validUntil)<=issuedAt
  ||!statusRecovery&&(now<Date.parse(key.validAfter)||now>=Date.parse(key.validUntil))
  ||request!==null&&(request.sourceProfileRef.id!==profile.profileId||request.sourceProfileRef.revision!==String(profile.revision)||request.sourceProfileRef.contentDigest!==hash(profile)
   ||request.legalEntityId!==profile.legalEntityId||request.purpose!==profile.purpose||!profile.products.includes(request.product)
   ||request.accountOrParticipantIds.some(id=>!profile.accountOrParticipantIds.includes(id))||request.fieldNames.some(field=>!profile.authoritativeFields.includes(field))))
  throw new LedgerFault(403,'PRIMARY_TRANSPORT_EXACT_ADMISSION_OR_SCOPE_UNPASSED');
 let valid=false;
 try{const publicKey=createPublicKey(key.publicKey);valid=publicKey.asymmetricKeyType==='ed25519'&&verify(null,Buffer.from(canonical(body)),publicKey,Buffer.from(admission.signature,'base64'));}catch{}
 if(!valid)throw new LedgerFault(403,'PRIMARY_TRANSPORT_INDEPENDENT_SIGNATURE_INVALID');
 return {credentialDirectory:policy.credentialDirectory,...(policy.caFile?{ca:await brokerPrivateFile(policy.caFile)}:{})};
}

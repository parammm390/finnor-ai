/** Offline, source-bound authority checks. This module never opens a network or DB. */
import {constants} from 'node:fs';
import {open,readdir,readFile,realpath,stat} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {X509Certificate} from 'node:crypto';
import {isIP} from 'node:net';
import {z} from 'zod';
import {sha,canonical} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts.ts';

const digest=z.string().regex(/^[a-f0-9]{64}$/),uuid=z.string().uuid(),commit=z.string().regex(/^[a-f0-9]{40}$/);
const absolute=z.string().refine(isAbsolute),envName=z.string().regex(/^FINNOR_Z4_REPLAY_[A-Z0-9_]+$/);
const caseSchema=z.object({name:z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),workId:uuid,workInputId:uuid,
 requestFile:absolute,requestSha256:digest,expectedFile:absolute,expectedSha256:digest,
 sessionId:uuid.optional(),recoverProducer:z.boolean(),recoverOwner:z.boolean()}).strict();
const negativeSchema=z.object({kind:z.enum(['tenant','private-use','authority','currentness','budget','cancellation','unsupported','incomplete']),
 operation:z.enum(['execution-proof-read','execution-proof-audit','execution-proof-consume','execution-proof-cancel','execution-proof-submit']),
 bodyFile:absolute,bodySha256:digest,credentialsEnvironmentVariable:envName.optional(),
 expectedStatus:z.union([z.literal(400),z.literal(404),z.literal(422)]),expectedPredicate:z.string().regex(/^[A-Z][A-Z0-9_]{1,159}$/)}).strict();
const scopeSchema=z.object({phase:z.literal('Z4'),mode:z.literal('ordinary_disposable'),publicInputOnly:z.literal(true),
 existingTargetOnly:z.literal(true),noInitialization:z.literal(true),noListeners:z.literal(true),noExternalEffects:z.literal(true),
 sourceCommit:commit,sourceTree:commit,ownedSourceDigest:digest,nativeSourceDigest:digest,nativeBinarySha256:digest,
 tenantId:uuid,principalId:uuid,targetReceiptFile:absolute,targetReceiptSha256:digest,
 credentialsEnvironmentVariable:envName,databaseEnvironmentVariable:envName,
 runtimeEnvironmentVariableNames:z.array(z.string().regex(/^[A-Z][A-Z0-9_]+$/)).max(32),
 grantedAt:z.string().datetime({offset:true}),expiresAt:z.string().datetime({offset:true}),
 cases:z.array(caseSchema).min(2).max(8),negatives:z.array(negativeSchema).min(8).max(16),
}).strict();
const manifestSchema=z.object({schema:z.literal('finnor.z4.replay-authority.v1'),fixture:z.literal(false),
 scope:scopeSchema,grantReceiptPath:absolute,grantReceiptSha256:digest}).strict();
const targetSchema=z.object({schema:z.literal('finnor.z4.existing-native-target.v1'),fixture:z.literal(false),
 production:z.literal(false),initializationAlreadyComplete:z.literal(true),authProjectSame:z.literal(true),
 liveProvidersDisabled:z.literal(true),externalEffectsDisabled:z.literal(true),exclusiveHeavyWorker:z.literal(true),
 frontendOrigin:z.string().url(),backendOrigin:z.string().url(),authOrigin:z.string().url(),
 authCertificateFile:absolute.optional(),authCertificateSha256:digest.optional(),authCertificateSpkiSha256:digest.optional(),
 frontendBuildIdFile:absolute,frontendBuildIdSha256:digest,backendBuildIdFile:absolute,backendBuildIdSha256:digest,
 chromiumExecutableFile:absolute,chromiumExecutableSha256:digest,
 databaseHost:z.enum(['127.0.0.1','localhost','::1']),databasePort:z.number().int().min(1024).max(65535),
 databaseName:z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),targetFingerprint:digest,
}).strict();
export type ReplayAuthority=Awaited<ReturnType<typeof replayAuthority>>;
export class ReplayRefusal extends Error {constructor(readonly predicate:string){super(predicate);}}
export function refuse(predicate:string):never{throw new ReplayRefusal(predicate);}
const roots=[
 'finnor-os/packages/epistemic-runtime/src/project-z/z4-execution-proof',
 'finnor-os/packages/epistemic-runtime/native/z4-execution-proof',
 'finnor-os/packages/private-equity/src/project-z/z4-execution-proof',
 'finnor-os/packages/orchestration/src/project-z/z4-execution-proof','finnor-os/scripts/project-z/z4',
];
const registration='scope-z/phase-evidence/z4/public-cases.pre-code.json';
const registrationSha='3992c3111ed0ba6fb700ae99095720780e713f7b55b1b9e938a6534004514d94';
const excluded=new Set(['target','.cargo-home','.cargo','.toolchain','bin']);
export async function ownedInventory(repository:string){
 const files:Array<{path:string;sha256:string;bytes:number}>=[];
 for(const root of roots){
  const paths:string[]=[];
  async function walk(path:string){
   for(const entry of await readdir(path,{withFileTypes:true})){
    if(entry.isSymbolicLink())continue;
    const absolute=join(path,entry.name),rel=relative(join(repository,root),absolute);
    if(root.endsWith('native/z4-execution-proof')&&excluded.has(rel.split('/')[0]!))continue;
    if(entry.isDirectory())await walk(absolute);else if(entry.isFile())paths.push(absolute);
   }
  }
  await walk(join(repository,root));
  for(const path of paths.sort()){
   const body=await readFile(path);files.push({path:relative(repository,path),sha256:sha(body),bytes:body.length});
  }
 }
 const body=await readFile(join(repository,registration));
 if(sha(body)!==registrationSha)refuse('Z4_FROZEN_REGISTRATION_CHANGED');
 files.push({path:registration,sha256:sha(body),bytes:body.length});
 return {files,digest:sha(files)};
}
async function privateJSON(path:string){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const info=await file.stat();
  if(!info.isFile()||info.size>128*1024||info.uid!==process.getuid?.()||(info.mode&0o077)!==0)refuse('Z4_REPLAY_PRIVATE_MANIFEST_REQUIRED');
  const body=await file.readFile();return {body,value:JSON.parse(body.toString('utf8')) as unknown};
 }finally{await file.close();}
}
function origin(value:string,loopback=false){
 const u=new URL(value);
 if(u.origin!==value||u.username||u.password||(!['http:','https:'].includes(u.protocol))||
  loopback&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname))refuse('Z4_REPLAY_ORIGIN_SCOPE');
 if(!loopback&&u.protocol!=='https:')refuse('Z4_REPLAY_AUTH_TLS_REQUIRED');
 return u.origin;
}
async function declaredCertificate(path:string,expected:string){
 try{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  let body:Buffer;
  try{
   const info=await file.stat();
   if(!info.isFile()||info.size>64*1024||info.uid!==process.getuid?.()||(info.mode&0o022)!==0)refuse('Z4_REPLAY_AUTH_CERTIFICATE_MISMATCH');
   body=await file.readFile();
  }finally{await file.close();}
  // The file is the whole extra trust set Node receives, so it must hold exactly one PEM block.
  if(sha(body)!==expected||body.toString('latin1').split('-----BEGIN ').length!==2)refuse('Z4_REPLAY_AUTH_CERTIFICATE_MISMATCH');
  return new X509Certificate(body);
 }catch(error){if(error instanceof ReplayRefusal)throw error;return refuse('Z4_REPLAY_AUTH_CERTIFICATE_MISMATCH');}
}
/** Https Auth transport plus the single certificate the replay may add to Node's trust. Offline. */
export async function authTransport(target:z.infer<typeof targetSchema>,env:NodeJS.ProcessEnv=process.env){
 const authOrigin=origin(target.authOrigin);
 if(env.NODE_TLS_REJECT_UNAUTHORIZED!==undefined)refuse('Z4_REPLAY_TLS_VERIFICATION_DISABLED');
 const fields=[target.authCertificateFile,target.authCertificateSha256,target.authCertificateSpkiSha256];
 if(fields.every(value=>value===undefined)){
  if(env.NODE_EXTRA_CA_CERTS!==undefined)refuse('Z4_REPLAY_AUTH_TRUST_UNDECLARED');
  return {authOrigin,certificateFile:undefined,spkiSha256Base64:undefined};
 }
 if(fields.some(value=>value===undefined))refuse('Z4_REPLAY_AUTH_CERTIFICATE_DECLARATION_INCOMPLETE');
 const file=target.authCertificateFile!;
 // Node reads NODE_EXTRA_CA_CERTS once at startup; the startup value must be the declared file itself.
 if(env.NODE_EXTRA_CA_CERTS!==file)refuse('Z4_REPLAY_AUTH_TRUST_UNDECLARED');
 const certificate=await declaredCertificate(file,target.authCertificateSha256!);
 const spki=certificate.publicKey.export({type:'spki',format:'der'});
 if(sha(spki)!==target.authCertificateSpkiSha256)refuse('Z4_REPLAY_AUTH_CERTIFICATE_MISMATCH');
 const hostname=new URL(authOrigin).hostname,host=hostname.replace(/^\[|\]$/g,'');
 // A CA certificate would extend trust to any name it signs; only a self-signed loopback leaf is accepted.
 // X509Certificate.checkIssued also demands keyCertSign, which a leaf must not carry, so self-signature is checked directly.
 if(!['localhost','127.0.0.1','[::1]'].includes(hostname)||certificate.ca||certificate.subject!==certificate.issuer||
  !certificate.verify(certificate.publicKey))refuse('Z4_REPLAY_AUTH_CERTIFICATE_SCOPE');
 if((isIP(host)?certificate.checkIP(host):certificate.checkHost(host,{subject:'never'}))===undefined)
  refuse('Z4_REPLAY_AUTH_CERTIFICATE_HOST_MISMATCH');
 const now=Date.now();
 if(!(Date.parse(certificate.validFrom)<=now&&now<Date.parse(certificate.validTo)))refuse('Z4_REPLAY_AUTH_CERTIFICATE_NOT_CURRENT');
 return {authOrigin,certificateFile:file,spkiSha256Base64:Buffer.from(sha(spki),'hex').toString('base64')};
}
export async function replayAuthority(repository:string,path?:string){
 if(!isAbsolute(repository)||!path||!isAbsolute(path))refuse('Z4_REPLAY_AUTHORITY_MANIFEST_REQUIRED');
 let manifest:z.infer<typeof manifestSchema>;
 try{manifest=manifestSchema.parse((await privateJSON(path)).value);}catch(error){
  if(error instanceof ReplayRefusal)throw error;refuse('Z4_REPLAY_MANIFEST_SCHEMA');
 }
 const m=manifest!,s=m.scope,now=Date.now();
 if(!(Date.parse(s.grantedAt)<=now&&now<Date.parse(s.expiresAt))||Date.parse(s.expiresAt)-Date.parse(s.grantedAt)>3600000)
  refuse('Z4_REPLAY_MANIFEST_NOT_CURRENT');
 if(process.env.FINNOR_Z4_REPLAY_AUTHORITY_SHA256!==m.grantReceiptSha256)refuse('Z4_REPLAY_OUT_OF_BAND_GRANT_REQUIRED');
 const requiredGrant=join(repository,'scope-z/orchestration/replay-grants/z4',m.grantReceiptSha256+'.json');
 if(resolve(m.grantReceiptPath)!==requiredGrant)refuse('Z4_REPLAY_COORDINATOR_RECEIPT_PATH_REQUIRED');
 const grant=await privateJSON(m.grantReceiptPath);
 if(sha(grant.body)!==m.grantReceiptSha256)refuse('Z4_REPLAY_GRANT_RECEIPT_MISMATCH');
 const receipt=z.object({schema:z.literal('finnor.z4.replay-grant.v1'),fixture:z.literal(false),
  grantedBy:z.literal('dfd67166-a075-4f36-94a7-e1df86369259'),scopeDigest:digest,
  permissions:z.tuple([z.literal('NATIVE_PROOF_WORK_WRITE'),z.literal('EXCLUSIVE_JOB_CLAIM_RECOVERY'),
   z.literal('NATIVE_ANALYTICAL_GUARD_USE'),z.literal('OWNED_CHILD_SIGKILL'),z.literal('MOUNTED_OWNER_UI')]),
 }).strict().parse(grant.value);
 if(receipt.scopeDigest!==sha(s))refuse('Z4_REPLAY_GRANT_SCOPE_MISMATCH');
 const inventory=await ownedInventory(repository);
 if(inventory.digest!==s.ownedSourceDigest)refuse('Z4_REPLAY_CURRENT_SOURCE_DIGEST_MISMATCH');
 let gitHead:string,gitTree:string;
 try{
  const top=execFileSync('git',['-C',repository,'rev-parse','--show-toplevel'],
   {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  if(await realpath(top)!==await realpath(repository))refuse('Z4_PARENT_GIT_IS_NOT_INSTALLED_PROVENANCE');
  gitHead=execFileSync('git',['-C',repository,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  gitTree=execFileSync('git',['-C',repository,'rev-parse','HEAD^{tree}'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 }catch{
  const p=JSON.parse(await readFile(join(repository,'z4-reconstruction-source.json'),'utf8'));
  if(p.ownedSourceDigest!==inventory.digest)refuse('Z4_REPLAY_INSTALLED_PROVENANCE_REQUIRED');
  gitHead=p.sourceCommit;gitTree=p.sourceTree;
 }
 if(gitHead!==s.sourceCommit||gitTree!==s.sourceTree||!/^v22\./.test(process.version))refuse('Z4_REPLAY_SOURCE_IDENTITY_MISMATCH');
 const native=join(repository,roots[1]!),identity=JSON.parse(await readFile(join(native,'build-identity.json'),'utf8'));
 const sourceFiles:Array<{path:string;sha256:string}>=[];
 for(const entry of identity.sourceFiles as Array<{path:string;sha256:string}>){
  if(!/^(Cargo\.(toml|lock)|rust-toolchain\.toml|supervise\.py|src\/[a-z_]+\.rs)$/.test(entry.path))refuse('Z4_REPLAY_NATIVE_SOURCE_PATH');
  const actual=sha(await readFile(join(native,entry.path)));
  if(actual!==entry.sha256)refuse('Z4_REPLAY_NATIVE_SOURCE_CHANGED');
  sourceFiles.push({path:entry.path,sha256:actual});
 }
 if(sha(sourceFiles)!==s.nativeSourceDigest||identity.sourceDigest!==s.nativeSourceDigest||
  identity.binarySha256!==s.nativeBinarySha256||sha(await readFile(join(native,'bin/z4-proof')))!==s.nativeBinarySha256)
  refuse('Z4_REPLAY_NATIVE_IDENTITY_MISMATCH');
 const targetBytes=await privateJSON(s.targetReceiptFile);
 if(sha(targetBytes.body)!==s.targetReceiptSha256)refuse('Z4_REPLAY_TARGET_RECEIPT_MISMATCH');
 const target=targetSchema.parse(targetBytes.value);
 origin(target.frontendOrigin,true);origin(target.backendOrigin,true);const authTrust=await authTransport(target);
 for(const [path,expected] of [[target.frontendBuildIdFile,target.frontendBuildIdSha256],[target.backendBuildIdFile,target.backendBuildIdSha256]])
  if(sha(await readFile(path!))!==expected)refuse('Z4_REPLAY_INSTALLED_BUILD_ID_MISMATCH');
 if(sha(await readFile(target.chromiumExecutableFile))!==target.chromiumExecutableSha256)
  refuse('Z4_REPLAY_BROWSER_BINARY_MISMATCH');
 for(const c of s.cases)for(const [file,expected] of [[c.requestFile,c.requestSha256],[c.expectedFile,c.expectedSha256]]){
  const info=await stat(file!);if(!info.isFile()||info.size>128*1024||sha(await readFile(file!))!==expected)refuse('Z4_REPLAY_CASE_PREIMAGE_MISMATCH');
 }
 for(const n of s.negatives)if(sha(await readFile(n.bodyFile))!==n.bodySha256)refuse('Z4_REPLAY_NEGATIVE_PREIMAGE_MISMATCH');
 if(!s.cases.some(c=>c.recoverProducer)||!s.cases.some(c=>c.recoverOwner)||
  !['tenant','private-use','authority','currentness','budget','cancellation','unsupported','incomplete']
   .every(k=>s.negatives.some(n=>n.kind===k))||
  s.negatives.some(n=>['tenant','authority'].includes(n.kind)&&!n.credentialsEnvironmentVariable))
  refuse('Z4_REPLAY_NATIVE_COVERAGE_REQUIRED');
 if([s.credentialsEnvironmentVariable,s.databaseEnvironmentVariable,
  ...s.negatives.flatMap(n=>n.credentialsEnvironmentVariable?[n.credentialsEnvironmentVariable]:[])]
  .some(name=>!process.env[name]))refuse('Z4_REPLAY_CREDENTIALS_ABSENT');
 const db=new URL(process.env[s.databaseEnvironmentVariable]!);
 if(!['postgres:','postgresql:'].includes(db.protocol)||db.hostname.replace(/^\[|\]$/g,'')!==target.databaseHost||
  Number(db.port||5432)!==target.databasePort||db.pathname!==('/'+target.databaseName))refuse('Z4_REPLAY_DATABASE_SCOPE_MISMATCH');
 const allowed=new Set(['SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','FINNOR_S3_MODEL_STORE',
  'FINNOR_S4_POLICY_STORE','FINNOR_Z4_CAPSULE_STORE','FINNOR_S2_EXPERIMENT_STORE','FINNOR_S5_STORE','FINNOR_SOURCE_CUSTODY_STORE']);
 if(s.runtimeEnvironmentVariableNames.some(name=>!allowed.has(name)||!process.env[name]))refuse('Z4_REPLAY_RUNTIME_ENVIRONMENT_UNGRANTED');
 if(process.env.SUPABASE_URL&&new URL(process.env.SUPABASE_URL).origin!==target.authOrigin)refuse('Z4_REPLAY_AUTH_PROJECT_MISMATCH');
 if(Date.now()>=Date.parse(s.expiresAt))refuse('Z4_REPLAY_MANIFEST_NOT_CURRENT');
 return {repository,manifestPath:path,manifest:m,scope:s,target,authTrust,scopeDigest:sha(s),sourceDigest:inventory.digest};
}
export function childEnvironment(a:ReplayAuthority){
 const env:NodeJS.ProcessEnv={PATH:process.execPath.slice(0,process.execPath.lastIndexOf('/'))+':/usr/bin:/bin',
  NODE_ENV:'development',NODE_OPTIONS:'--max-old-space-size=1024 --import='+join(a.repository,'finnor-os/scripts/project-z/z4/isolation-loader.mjs'),FINNOR_ENVIRONMENT:'staging',
  FINNOR_Z4_PROFILE:'ordinary_disposable',DATABASE_URL:process.env[a.scope.databaseEnvironmentVariable],
  FINNOR_Z4_REPLAY_AUTHORITY_SHA256:a.manifest.grantReceiptSha256,
  ...(a.authTrust.certificateFile?{NODE_EXTRA_CA_CERTS:a.authTrust.certificateFile}:{})};
 for(const name of [a.scope.credentialsEnvironmentVariable,a.scope.databaseEnvironmentVariable,...a.scope.runtimeEnvironmentVariableNames,
  ...a.scope.negatives.flatMap(n=>n.credentialsEnvironmentVariable?[n.credentialsEnvironmentVariable]:[])])
  env[name]=process.env[name];
 return env;
}
export function applyRuntimeEnvironment(a:ReplayAuthority,preserveBarrier=false){
 const clean=childEnvironment(a);
 if(preserveBarrier){
  for(const name of ['FINNOR_Z4_REPLAY_PAUSE_AT','FINNOR_Z4_REPLAY_NONCE'])
   if(process.env[name])clean[name]=process.env[name];
 }
 for(const name of Object.keys(process.env))delete process.env[name];
 Object.assign(process.env,clean);
}
export async function writeRefusal(evidence:string,error:unknown){
 const {mkdir,writeFile}=await import('node:fs/promises');
 await mkdir(evidence,{recursive:true,mode:0o700});
 const code=error instanceof ReplayRefusal?error.predicate:'Z4_REPLAY_MANIFEST_OR_CHANNEL_UNAVAILABLE';
 const report={schema:'finnor.z4.replay-guard.v1',status:'REFUSED',code,networkCallsAttempted:0,databaseCallsAttempted:0,
  authCallsAttempted:0,guardsPassedMarkerWritten:false};
 await writeFile(join(evidence,'replay-guard.json'),canonical(report)+'\n',{flag:'wx',mode:0o600});
 console.error(JSON.stringify(report));
}

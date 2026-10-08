/** Preregistered S7 transport contract through the real separate ledger process. */
import {strict as assert} from 'node:assert';
import {createHash,generateKeyPairSync,randomUUID,randomBytes,sign,verify} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {spawn,type ChildProcess} from 'node:child_process';

export async function createEconomicLedger(tenant:string,principal:string,valuatorPrincipal:string,options:{nativeAllocation?:boolean;capabilityLifecycle?:boolean;sealedEvaluation?:boolean;rightsRef?:string;financialPrincipal?:string;transportEndpoint?:string;compiledSubstrate?:{sourceDirectory:string;policyExtensions:Record<string,unknown>}}={}){
const root=await realpath(await mkdtemp(join(tmpdir(),'finnor-s7-ledger-')));
const encode=(v:any):string=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(encode).join(',')+']':'{'+Object.keys(v).sort((a,b)=>a.localeCompare(b)).map(k=>JSON.stringify(k)+':'+encode(v[k])).join(',')+'}';
const hash=(v:unknown)=>createHash('sha256').update(encode(v)).digest('hex');
const substrate=options.compiledSubstrate?.sourceDirectory??resolve('packages/governed-execution/src');
const fsExt=dirname(createRequire(join(substrate,'ledger.js')).resolve('fs-ext/package.json'));
const names=['ledger.ts','ledger-server.mts','protocol.ts','request-verifier.ts','adapter-contract.ts',...(options.compiledSubstrate?['dispatch-broker.ts','broker-io.ts','capability-verifier.ts']:[])];
const paths=names.map(n=>join(substrate,n)).concat(['fs-ext.js','build/Release/fs_ext.node','package.json'].map(n=>join(fsExt,n)));
const snapshotPaths=[...paths,...(options.compiledSubstrate?names.map(n=>join(substrate,n.replace(/\.mts$/,'.mjs').replace(/\.ts$/,'.js'))):[]),resolve('packages/governed-execution/src/owner-transport.ts'),resolve('scripts/s7/ledger-fixture.mts')];
const snapshot=()=>Promise.all(snapshotPaths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(path)).digest('hex')})));
const before=await snapshot(),sourceDigests=before.slice(0,paths.length),signer=generateKeyPairSync('ed25519'),reviewer=generateKeyPairSync('ed25519');
const pub=signer.publicKey.export({type:'spki',format:'pem'}).toString(),reviewPub=reviewer.publicKey.export({type:'spki',format:'pem'}).toString();
const rights=options.rightsRef??'generated-owner-rights',tokens=Object.fromEntries(['S2','S3','S4','S5','S6','S7','S8','BUSINESS_OWNER','FINANCIAL_SOURCE','INDEPENDENT_VALUER','READER','S8_READER',...(options.sealedEvaluation?['S8_EVALUATOR']:[])].map(k=>[k,randomUUID()+randomUUID()]));
const byteHash=(v:string)=>createHash('sha256').update(v).digest('hex');
const owners=Object.entries(tokens).map(([owner,token])=>({owner:owner==='READER'?'S7':['S8_READER','S8_EVALUATOR'].includes(owner)?'S8':owner,tokenHash:byteHash(token),append:!['READER','S8_READER','S8_EVALUATOR'].includes(owner),tenantId:tenant,principalId:owner==='INDEPENDENT_VALUER'?valuatorPrincipal:owner==='FINANCIAL_SOURCE'?(options.financialPrincipal??principal):principal,rightsRefs:[rights],read:true,sealedAppend:options.sealedEvaluation===true&&owner==='S7',sealedRead:owner==='S8_EVALUATOR'}));
const policy={schema:'finnor.s6.ledger-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',owners,signerPublicKey:pub,maxEntries:100000,...(options.compiledSubstrate?.policyExtensions??{})};
const releaseBody={schema:options.compiledSubstrate?'finnor.s6.ledger-release.v4':'finnor.s6.ledger-release.v2',releaseId:'s7-disposable-candidate',sourceDigests,runtime:{node:process.version,nodeAbi:process.versions.modules,platform:process.platform,arch:process.arch},policyDigest:hash(policy),validUntil:new Date(Date.now()+3600000).toISOString()};
const release={...releaseBody,signature:sign(null,Buffer.from(encode(releaseBody)),reviewer.privateKey).toString('base64')};
await writeFile(join(root,'signer.pem'),signer.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});await mkdir(join(root,'protected'),{mode:0o700});await mkdir(join(root,'ordinary'),{mode:0o700});
const sealedEncryptionKeyPath=options.sealedEvaluation?join(root,'sealed.key'):undefined;
if(sealedEncryptionKeyPath)await writeFile(sealedEncryptionKeyPath,randomBytes(32),{mode:0o600});
const config={policy,release,signerPath:join(root,'signer.pem'),protectedDirectory:join(root,'protected'),contentDirectory:join(root,'ordinary'),port:0,...(sealedEncryptionKeyPath?{sealedEncryptionKeyPath}:{})},configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify(config),{mode:0o600});
let child:ChildProcess|null=null,base='',logs='';
async function start(){logs='';child=spawn(process.execPath,options.compiledSubstrate?[join(substrate,'ledger-server.mjs')]:['--import=tsx','packages/governed-execution/src/ledger-server.mts'],{env:{...process.env,FINNOR_S6_LEDGER_CONFIG:configPath,FINNOR_S6_LEDGER_RELEASE_ROOT:reviewPub},stdio:['ignore','pipe','pipe']});await new Promise<void>((ok,fail)=>{const timer=setTimeout(()=>fail(Error('ledger boot timeout:'+logs)),15000);child!.stdout!.on('data',b=>{logs+=b;for(const line of logs.split('\n'))try{const state=JSON.parse(line);if(state.status==='READY'){base='http://127.0.0.1:'+state.port;clearTimeout(timer);ok();}}catch{}});child!.stderr!.on('data',b=>{logs+=b;});child!.once('exit',()=>{clearTimeout(timer);fail(Error('ledger exited:'+logs));});});}
async function stop(){if(!child||child.exitCode!==null||child.signalCode!==null)return;await new Promise<void>(ok=>{child!.once('close',()=>ok());child!.kill('SIGKILL');});}
async function call(path:string,payload?:any,token=tokens.S7){const r=await fetch(base+path,{method:payload===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},...(payload===undefined?{}:{body:encode(payload)}),signal:AbortSignal.timeout(10000)});return {status:r.status,body:await r.json() as any};}

await start();
const verifierDigest=hash(sourceDigests),routes=[];const origin=generateKeyPairSync('ed25519'),originPub=origin.publicKey.export({type:'spki',format:'pem'}).toString(),originPath=join(root,'origin.pem');await writeFile(originPath,origin.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
const validAfter=new Date(Date.now()-60000).toISOString(),validUntil=new Date(Date.now()+3600000).toISOString();
const routeDefinitions:Array<[string,string,string]>=[['S2','OWNER','S2'],...(options.nativeAllocation?[['S5','OWNER','S5'] as [string,string,string]]:[]),['S7','OWNER','S7'],['S7','CONSUMER','READER'],['S8','CONSUMER','S8_READER'],...(options.capabilityLifecycle?[['S8','OWNER','S8'] as [string,string,string]]:[])];
for(const [semanticOwner,purpose,tokenKey] of routeDefinitions){const tokenPath=join(root,tokenKey+'.token');await writeFile(tokenPath,tokens[tokenKey]!,{mode:0o600});routes.push({semanticOwner,tenantId:tenant,principalId:principal,purpose,rightsRefs:[rights],originKeys:[{id:'test-origin',publicKey:originPub,validAfter,validUntil,revoked:false}],...(purpose==='OWNER'?{originSigner:{keyId:'test-origin',path:originPath}}:{}),tokenPath,tokenSha256:byteHash(tokens[tokenKey]!),ledger:{endpoint:options.transportEndpoint??base,acceptedReceipts:[{signerPublicKey:pub,releaseId:releaseBody.releaseId,verifierDigest,policyDigest:hash(policy)}]},requestTimeoutMs:5000,leaseMs:20000});}
const transportPolicy={schema:'finnor.s6.owner-transport-policy.v1',domain:'DISPOSABLE_TEST_AUTHORITY',validAfter,validUntil,routes},transportPath=join(root,'transport.json');await writeFile(transportPath,JSON.stringify({policy:transportPolicy,signature:sign(null,Buffer.from(encode(transportPolicy)),reviewer.privateKey).toString('base64')}),{mode:0o600});process.env.FINNOR_S6_OWNER_TRANSPORT_CONFIG=transportPath;process.env.FINNOR_S6_OWNER_TRANSPORT_ROOT=reviewPub;
let evaluatorTransportPath:string|null=null;
if(options.sealedEvaluation){
 const tokenPath=join(root,'S8_EVALUATOR.token');await writeFile(tokenPath,tokens.S8_EVALUATOR!,{mode:0o600});
 const evaluatorPolicy={...transportPolicy,routes:routes.filter(route=>route.semanticOwner==='S8'&&route.purpose==='CONSUMER').map(route=>({...route,tokenPath,tokenSha256:byteHash(tokens.S8_EVALUATOR!)}))};
 evaluatorTransportPath=join(root,'evaluator-transport.json');await writeFile(evaluatorTransportPath,JSON.stringify({policy:evaluatorPolicy,signature:sign(null,Buffer.from(encode(evaluatorPolicy)),reviewer.privateKey).toString('base64')}),{mode:0o600});
}
return {root,rights,before,call,start,stop,endpoint:()=>base,publicKey:pub,policy,release,verifyCapabilityMethod:async(input:any)=>call('/verify-capability-method',input,tokens.S8_READER),appendCapability:async(input:any)=>call('/append',input,tokens.S8),readCapabilityEvent:async(id:string)=>call('/events/'+encodeURIComponent(id),undefined,tokens.S8_READER),publish:async(reference:any)=>{const a=await call('/references',{reference,rightsRefs:[rights]},tokens[reference.owner]);assert.equal(a.status,200,JSON.stringify(a));return a;},appendDenied:async()=>call('/append',{event:{}},tokens.READER),evaluatorTransportPath,transportRoot:reviewPub,sealed:options.sealedEvaluation?{publish:async(reference:any)=>{const answer=await call('/references',{reference,rightsRefs:[rights],sealed:true},tokens.S7);assert.equal(answer.status,200,JSON.stringify(answer));return answer;},read:async(id:string,evaluator=false)=>call('/references/'+encodeURIComponent(id),undefined,evaluator?tokens.S8_EVALUATOR:tokens.S8_READER)}:null};

}

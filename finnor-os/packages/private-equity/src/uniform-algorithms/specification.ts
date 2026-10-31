import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {createPublicKey,verify} from 'node:crypto';
import {z} from 'zod';
import type {TotalSemanticReceipt,TotalSemanticAcceptance,TotalSpecificationResolution} from '../../../shared-types/src/total-algorithm-theory';
import {ExperimentRefSchema} from '../../../epistemic-runtime/src/experiments';
import {parseWorkSpecification} from '../../../epistemic-runtime/src/uniform-algorithms/total/syntax';
import {canonical} from '../../../governed-execution/src/protocol';
import type {PeMutationContext} from '../types';
import {unavailable} from '../owner-context';
import {tx,authorizeTx,principal} from './store';
import {RootSchema,digest,diagnosticProfile,fail} from './contracts';

export const SpecificationReadSchema=z.object({root:RootSchema,workId:z.string().uuid(),
 expectedSourceRef:ExperimentRefSchema.optional()}).strict();
const text=z.string().min(1).max(256),scope='finnor.y5.total-family-definition.v2' as const;
const policySchema=z.object({
 schema:z.literal('finnor.y5.semantic-policy.v2'),
 profile:z.enum(['INDEPENDENT_EXTERNAL_AUTHORITY','PUBLIC_DEVELOPMENT_FIXTURE']),
 revision:text,approvalRef:ExperimentRefSchema.refine(r=>r.owner==='EXTERNAL_SEMANTIC_POLICY'),
 validAfter:z.string().datetime(),validUntil:z.string().datetime(),
 revokedReceiptIds:z.array(text).max(1024),
 issuers:z.array(z.object({id:text,keyId:text,principalId:z.string().uuid(),
  role:z.literal('INDEPENDENT_TASK_SEMANTICS_ACCEPTOR'),status:z.enum(['ACTIVE','REVOKED']),
  tenantIds:z.array(z.string().uuid()).min(1).max(128),scopes:z.array(z.literal(scope)).min(1).max(16),
  publicKey:z.string().min(32).max(4096),
 }).strict()).min(1).max(32),
}).strict();
type Policy=z.infer<typeof policySchema>;

async function readPolicy():Promise<{policy:Policy;digest:string}>{
 const path=process.env.FINNOR_Y5_SPECIFICATION_POLICY;
 if(!path||!isAbsolute(path))throw Error('Y5_SEMANTIC_POLICY_REQUIRED');
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const before=await file.stat();
  if(!before.isFile()||before.size>65536)throw Error('Y5_SEMANTIC_POLICY_BOUND');
  const raw=await file.readFile(),after=await file.stat();
  if(raw.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs)throw Error('Y5_SEMANTIC_POLICY_CHANGED');
  const policy=policySchema.parse(JSON.parse(raw.toString('utf8')));
  if(new Set(policy.issuers.map(i=>i.id+'\0'+i.keyId)).size!==policy.issuers.length)throw Error('Y5_SEMANTIC_ISSUER_AMBIGUOUS');
  return {policy,digest:digest(policy)};
 }finally{await file.close();}
}
async function receiptAcceptance(ctx:PeMutationContext,definitionDigest:string,receipt:TotalSemanticReceipt|null):Promise<TotalSemanticAcceptance>{
 if(!receipt)return {status:'PUBLIC_DEVELOPMENT',reason:'NO_INDEPENDENT_ACCEPTANCE_RECEIPT',protectedFamilyCredit:false};
 const {policy,digest:policyDigest}=await readPolicy(),now=Date.now();
 const issuer=policy.issuers.find(i=>i.id===receipt.issuerId&&i.keyId===receipt.keyId);
 if(!issuer||issuer.status!=='ACTIVE'||issuer.principalId===principal(ctx)||
  !issuer.tenantIds.includes(ctx.auth.tenantId)||!issuer.scopes.includes(scope)||
  receipt.tenantId!==ctx.auth.tenantId||receipt.definitionDigest!==definitionDigest||
  receipt.scope!==scope||receipt.policyRevision!==policy.revision||
  policy.revokedReceiptIds.includes(receipt.receiptId)||
  Date.parse(policy.validAfter)>now||Date.parse(policy.validUntil)<=now||
  Date.parse(receipt.acceptedAt)>now||Date.parse(receipt.acceptedAt)<Date.parse(policy.validAfter)||
  Date.parse(receipt.validUntil)<=now||Date.parse(receipt.validUntil)>Date.parse(policy.validUntil)||
  Date.parse(receipt.acceptedAt)>=Date.parse(receipt.validUntil))throw Error('Y5_SEMANTIC_RECEIPT_SCOPE_OR_LIFETIME');
 const key=createPublicKey(issuer.publicKey),signature=Buffer.from(receipt.signature,'base64');
 const {signature:_,...body}=receipt;
 if(key.asymmetricKeyType!=='ed25519'||signature.length!==64||signature.toString('base64')!==receipt.signature||
  !verify(null,Buffer.from(canonical(body)),key,signature))throw Error('Y5_SEMANTIC_SIGNATURE');
 if(policy.profile==='PUBLIC_DEVELOPMENT_FIXTURE')return {
  status:'PUBLIC_DEVELOPMENT',reason:'DISPOSABLE_POLICY_NOT_INDEPENDENT_ACCEPTANCE',protectedFamilyCredit:false,
  policyDigest,receiptDigest:digest(receipt),validUntil:receipt.validUntil,
 };
 return {status:'ACCEPTED',issuerId:issuer.id,receiptId:receipt.receiptId,scope,
  policyRevision:policy.revision,policyDigest,policyApprovalRef:policy.approvalRef,validUntil:receipt.validUntil,
  protectedFamilyCredit:false,
  qualification:'SIGNATURE_UNDER_EXTERNALLY_CONFIGURED_POLICY_NOT_PROTECTED_CAMPAIGN_CUSTODY'};
}

export async function resolveTotalSpecification(ctx:PeMutationContext,value:unknown):Promise<TotalSpecificationResolution>{
 diagnosticProfile();const input=SpecificationReadSchema.parse(value);
 const read=()=>tx(ctx,async c=>{
  await authorizeTx(ctx,c,input.root,input.workId);
  const row=(await c.query<{id:string;instruction_text:string;created_by:string;context_snapshot:unknown;context_snapshot_hash:string;status:string;current_owner_id:string|null}>(
   `SELECT i.id,i.instruction_text,i.created_by,i.context_snapshot,i.context_snapshot_hash,w.status,w.current_owner_id
    FROM finnor_os.work_inputs i JOIN finnor_os.works w ON w.tenant_id=i.tenant_id AND w.id=i.work_id
    WHERE i.tenant_id=$1 AND i.work_id=$2 ORDER BY i.created_at DESC,i.id DESC LIMIT 1 FOR SHARE OF w`,
   [ctx.auth.tenantId,input.workId])).rows[0];
  if(!row||row.created_by!==principal(ctx))throw unavailable();
  if(['failed','cancelled','completed'].includes(row.status)||row.current_owner_id&&row.current_owner_id!==principal(ctx))
   fail('Y5_SPECIFICATION_WORK_NOT_CURRENT');
  const {status:_,current_owner_id:__,...source}=row;
  const sourceRef={owner:'WORK_INPUT',id:row.id,version:'y5-work-specification-v2',contentDigest:digest(source)};
  if(input.expectedSourceRef&&digest(input.expectedSourceRef)!==digest(sourceRef))fail('Y5_SPECIFICATION_CURRENT_REF_CHANGED');
  return {source,sourceRef};
 });
 const initial=await read();let supplied;
 try{
  if(Buffer.byteLength(initial.source.instruction_text)>32768)throw Error('Y5_SPECIFICATION_BYTES');
  supplied=parseWorkSpecification(JSON.parse(initial.source.instruction_text));
 }catch{return {status:'UNAVAILABLE',reason:'TYPED_OWNER_SPECIFICATION_UNAVAILABLE'};}
 const definitionDigest=digest(supplied.definition);let acceptance:TotalSemanticAcceptance;
 try{acceptance=await receiptAcceptance(ctx,definitionDigest,supplied.acceptanceReceipt);}
 catch{return {status:'UNAVAILABLE',reason:'SEMANTIC_ACCEPTANCE_NOT_ESTABLISHED'};}
 if(digest(await read())!==digest(initial))fail('Y5_SPECIFICATION_SOURCE_CHANGED_DURING_RESOLUTION');
 if('policyDigest'in acceptance){
  try{if((await readPolicy()).digest!==acceptance.policyDigest)fail('Y5_SEMANTIC_POLICY_CHANGED_DURING_RESOLUTION');}
  catch{return {status:'UNAVAILABLE',reason:'SEMANTIC_ACCEPTANCE_NOT_ESTABLISHED'};}
 }
 const specification={schema:'finnor.y5.resolved-specification.v2' as const,sourceRef:initial.sourceRef,
  definition:supplied.definition,definitionDigest,acceptance};
 return {status:acceptance.status,specification};
}

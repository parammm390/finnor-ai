import {randomUUID} from 'node:crypto';
import type {ExactBranchReview,ExactContingentPolicy} from '@finnor/shared-types/src/robust-programme-search';
import {R2_VERSION} from '@finnor/shared-types/src/robust-programme-search';
import type {PeMutationContext} from '../types';
import {readEnterpriseExactControlPolicy,chooseEnterpriseExactControlBranch,readEnterpriseControlBranchChoice} from '../enterprise-control';
import {readEnterpriseExactProgrammeResourceCheck} from '../enterprise-allocation';
import {assertDependencies} from '../evidence-execution/store';
import {m3Tx,m3Query,m3Event,writeM3Record,readM3Record,type M3QueryRow} from './v2-store';
import {m3Hash,m3Same,m3Ref,CapitalProgramV2Error,CAPITAL_PROGRAM_V2_VERSION,type CapitalProgramV2} from './v2-contracts';
import {assertR2Current} from './r2-owners';
import {r2Ref} from './r2-native';
import {createHash} from 'node:crypto';
import {r2Lp} from '../../../epistemic-runtime/src/r2-encoding';
import type {R2Encoding,R2CheckReceipt} from '@finnor/shared-types/src/robust-programme-search';
import {assertCapitalOwnerBinding,recheckCapitalOwners} from './v2-owners';
import {resolveDecisionWork} from '../decision-slice/adapters';
import {r2Quantity as q,r2String as s,r2Divide} from '../../../epistemic-runtime/src/r2-rational';
import type {JointSearchCertificate} from '@finnor/shared-types/src/robust-programme-search';

/** Derive display/claim fields from the retained independently accepted evidence.
 * An ordinary producer cannot turn a genuine weak bound into a zero-gap claim. */
function assertCertificateClaims(c:JointSearchCertificate){
 const fail=(reason:string):never=>{throw new CapitalProgramV2Error('CHECK_FAILED','R2_CERTIFICATE_CLAIM_MISMATCH:'+reason);};
 const original=c.incumbent?.original;
 for(const receipt of c.checks){const {ref,...body}=receipt;
  if(receipt.disposition!=='ACCEPTED'||receipt.originalDigest!==c.envelope.originalDigest||!m3Same(ref,r2Ref('independent-check',body))||
   !m3Same(receipt.provenance.runtimeRef,c.envelope.producer.runtimeRef))fail('ACCEPTED_RECEIPT_IDENTITY');
 }
 const feasible=c.checks.filter(r=>r.feasible&&r.lower!==null&&r.claims.includes('COMPLETE_ORIGINAL_FULL_WORLD_POLICY')),
  lower=feasible.reduce<string|null>((value,r)=>value===null||q(r.lower!).compare(q(value))>0?r.lower:value,null),
  upper=c.proofs.reduce<string|null>((value,p)=>{
   if(!p.checkerReceipt.claims.includes('PROOF_ORIGINAL_MODEL_BINDING')||p.checkerReceipt.upper!==p.maximizationUpper||
    s(q('0').sub(q(p.minimizationLower)))!==p.maximizationUpper||!c.checks.some(r=>m3Same(r,p.checkerReceipt)))fail('PRIMARY_BOUND_RECEIPT');
   return value===null||q(p.maximizationUpper).compare(q(value))<0?p.maximizationUpper:value;
  },null);
 if(c.lower!==lower||c.upper!==upper)fail('RETAINED_INTERVAL');
 if(lower!==null&&upper!==null&&q(lower).compare(q(upper))>0)fail('CROSSED_INTERVAL');
 if(q(c.normalization.range).n<=0n)fail('GAP_OR_NORMALIZATION');
 const gap=lower!==null&&upper!==null?s(q(upper).sub(q(lower))):null,
  normalized=gap===null?null:s(r2Divide(q(gap),q(c.normalization.range)));
 if(c.gap!==gap||c.normalizedGap!==normalized)fail('GAP_OR_NORMALIZATION');
 if(original){
  const threshold=q(original.source.quantities['/mandate/scoring/maxRegret']!);
  if(c.normalization.range!==s(q(original.source.quantities['/mandate/scoring/normalization']!))||
   c.normalization.threshold!==s(threshold.compare(q('1/20'))>0?q('1/20'):threshold)||c.incumbent!.value!==lower||
   !m3Same(c.consumer.s4PolicyRef,c.incumbent!.ref)||!feasible.some(r=>m3Same(r.ref,c.incumbent!.checkerReceipt)&&r.lower===lower))fail('ORIGINAL_FEASIBLE_POLICY_AND_FIXED_SCALE');
 }
 if(c.status==='COMPLETE'&&(lower===null||upper===null||normalized===null||q(normalized).compare(q(c.normalization.threshold))>0||!c.consumer.s5?.feasible))fail('COMPLETE_GATE');
 if(c.status==='INFEASIBLE'&&(!c.infeasibilityProof||(c.infeasibilityProof.checkerReceipt as R2CheckReceipt&{infeasibleProof?:boolean}).infeasibleProof!==true||lower!==null||c.incumbent))fail('INFEASIBILITY');
}

export async function readRobustProgramme(ctx:PeMutationContext,q:M3QueryRow,program:CapitalProgramV2){
 const c=program.jointSearchCertificate;
 if(!q.request.robust||!q.acceptance.r2||!c)throw new CapitalProgramV2Error('CHECK_FAILED','Exact programme lacks its original owner binding');
 const {ref,...body}=c;
 assertCertificateClaims(c);
 if(c.schema!=='finnor.joint-search-certificate.v1'||c.version!==R2_VERSION||!m3Same(ref,r2Ref('joint-search-certificate',body))||
  c.envelope.tenantId!==q.tenant_id||c.envelope.principalId!==q.principal_id||c.envelope.originalDigest!==m3Hash(q.acceptance.r2.original)||
  c.envelope.deadlineAt!==q.deadline_at?.toISOString()||c.consumer.executionAuthorityGranted!==false||
  c.status==='INFEASIBLE'&&!c.infeasibilityProof||c.exactOptimalityClaimed&&(c.status!=='COMPLETE'||c.gap!=='0'||!c.proofs.length||c.tieBreak?.status!=='CHECKED'))
  throw new CapitalProgramV2Error('CHECK_FAILED','Immutable R2 certificate identity, proof or authority differs');
 await assertR2Current(ctx,q.request,q.acceptance);await recheckCapitalOwners(ctx,q.request,q.acceptance);
 const retained=await readM3Record(ctx,'graphs',m3Ref('r2-certificate',c));
 if(!m3Same(retained.body,c))throw new CapitalProgramV2Error('CHECK_FAILED','Retained exact certificate preimage differs');
 for(const proof of [...c.proofs.map(p=>({artifactRef:p.artifactRef,proofRef:p.proofRef,receipt:p.checkerReceipt})),...(c.tieBreak?.artifactRef?[{artifactRef:c.tieBreak.artifactRef,proofRef:c.tieBreak.proofRef,receipt:c.tieBreak.receipt}]:[]),...(c.infeasibilityProof?[{artifactRef:c.infeasibilityProof.artifactRef,proofRef:c.infeasibilityProof.proofRef,receipt:c.infeasibilityProof.checkerReceipt}]:[])]){
  const stored=await readM3Record<{encoding:R2Encoding;model:string;proof:string;proofSha256:string;modelSha256:string;proofRef:unknown;checkerReceipt:R2CheckReceipt;runtimeRef:unknown}>(ctx,'graphs',proof.artifactRef),a=stored.body;
  const sha=(v:string)=>createHash('sha256').update(v).digest('hex');
  if(a.encoding.originalDigest!==c.envelope.originalDigest||!m3Same(a.runtimeRef,q.acceptance.r2.runtimeRef)||a.model!==r2Lp(a.encoding)||sha(a.model)!==a.modelSha256||sha(a.proof)!==a.proofSha256||
   !m3Same(a.proofRef,proof.proofRef)||!m3Same(a.checkerReceipt,proof.receipt))throw new CapitalProgramV2Error('CHECK_FAILED','Current original proof artifact bytes or correspondence changed');
 }
 if(c.status==='COMPLETE'&&c.incumbent&&(!program.programModule||!program.ownerBoundGraph))throw new CapitalProgramV2Error('CHECK_FAILED','Current original P1 programme module/owner graph absent');
 if(program.programModule)await readM3Record(ctx,'modules',program.programModule);
 if(program.ownerBoundGraph)await readM3Record(ctx,'graphs',program.ownerBoundGraph);
 let policy:ExactContingentPolicy|null=null;
 if(c.incumbent){policy=await readEnterpriseExactControlPolicy(ctx,c.incumbent.ref);
  if(!m3Same(policy,c.incumbent)||c.status==='COMPLETE'&&!c.consumer.s5)throw new CapitalProgramV2Error('CHECK_FAILED','Exact S4/S5 current consumption is absent');
  if(c.consumer.s5)await readEnterpriseExactProgrammeResourceCheck(ctx,policy,c.consumer.s5.ref);
 }
 const rows=await m3Tx(ctx,async client=>(await client.query<{body:ExactBranchReview}>(
  'SELECT body FROM finnor_os.m3_branch_reviews WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 ORDER BY created_at,idempotency_key LIMIT 17',
  [ctx.auth.tenantId,ctx.auth.userId,q.id])).rows,true);
 if(rows.length>16)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Exact branch readback exceeds sixteen records');
 const reviews=[];for(const row of rows)reviews.push(await checkedExactReview(ctx,program,row.body));
 await assertCapitalOwnerBinding(ctx,q.acceptance);return {policy,reviews};
}
async function checkedExactReview(ctx:PeMutationContext,program:CapitalProgramV2,review:ExactBranchReview){
 const {ref,...body}=review,c=program.jointSearchCertificate,choice=await readEnterpriseControlBranchChoice(ctx,review.choice.ref);
 if(!c?.incumbent||!c.consumer.s5||review.schema!=='finnor.m3.exact-branch-review.v1'||!m3Same(ref,m3Ref('exact-branch-review',body))||
  !m3Same(review.programRef,program.ref)||!m3Same(review.certificateRef,c.ref)||!m3Same(review.policyRef,c.incumbent.ref)||
  !m3Same(choice,review.choice)||review.reservationCreated!==false||review.executionAuthorityGranted!==false||review.effectRef!==null)
  throw new CapitalProgramV2Error('CHECK_FAILED','Exact branch owner preimage differs');
 await readM3Record(ctx,'branch-reviews',ref);await readEnterpriseExactProgrammeResourceCheck(ctx,c.incumbent,review.resourceCheckRef);return review;
}
export async function reviewExactBranch(ctx:PeMutationContext,input:{queryId:string;candidateDigest:string;idempotencyKey:string;intent:string}){
 const q=await m3Query(ctx,input.queryId);await resolveDecisionWork(ctx,q.work_id);
 if(!q.request.robust||!q.result_digest||!['PARTIAL','TESTED'].includes(q.status))throw new CapitalProgramV2Error('STALE_INPUT','Current exact programme publication required');
 const programRef={owner:'M3' as const,id:`capital-program:${q.result_digest}`,version:CAPITAL_PROGRAM_V2_VERSION,contentDigest:q.result_digest},
  record=await readM3Record<Omit<CapitalProgramV2,'ref'>>(ctx,'programs',programRef),program={...record.body,ref:programRef};
 const publication=await m3Tx(ctx,async client=>(await client.query('SELECT result_digest FROM finnor_os.m3_publications WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3 AND generation=$4',
  [ctx.auth.tenantId,ctx.auth.userId,q.id,q.generation])).rows[0],true);
 if(publication?.result_digest!==q.result_digest||program.envelope.tenantId!==q.tenant_id||program.envelope.principalId!==q.principal_id||program.envelope.work.inputDigest!==q.work_input_digest)
  throw new CapitalProgramV2Error('CHECK_FAILED','Exact immutable original programme/publication differs');
 const {policy}=await readRobustProgramme(ctx,q,program),c=program.jointSearchCertificate!,candidate=program.candidates.find(x=>x.semanticDigest===input.candidateDigest);
 if(!policy||!candidate?.policyRef||!m3Same(candidate.policyRef,policy.ref)||!c.consumer.s5)
  throw new CapitalProgramV2Error('BLOCKED_SELECTION','Current independently feasible exact S4/S5 policy required');
 const requestDigest=m3Hash(input),prior=await m3Tx(ctx,async client=>(await client.query<{request_digest:string;body:ExactBranchReview}>(
  'SELECT request_digest,body FROM finnor_os.m3_branch_reviews WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
  [ctx.auth.tenantId,ctx.auth.userId,input.idempotencyKey])).rows[0],true);
 if(prior){if(prior.request_digest!==requestDigest)throw new CapitalProgramV2Error('CONFLICT','Exact branch key binds a different programme');return {review:await checkedExactReview(ctx,program,prior.body),replayed:true};}
 const continuation=policy.original.problem.continuation,decision={knowledgeAt:new Date().toISOString(),period:continuation?.elapsedPeriods??0,
  actionHistory:continuation?.actionHistory??[],observations:continuation?.observations??[],rightsRef:policy.original.mandate.rightsRef,
  obligations:policy.original.problem.obligations,allocationRefs:[]},choice=await chooseEnterpriseExactControlBranch(ctx,{policyRef:policy.ref,decision});
 if(choice.status!=='POLICY_AVAILABLE')throw new CapitalProgramV2Error('BLOCKED_SELECTION','Exact original S4 branch unavailable');
 const body:Omit<ExactBranchReview,'ref'>={schema:'finnor.m3.exact-branch-review.v1',queryId:q.id,programRef:program.ref,certificateRef:c.ref,
  candidateDigest:candidate.semanticDigest,policyRef:policy.ref,choice,decision,resourceCheckRef:c.consumer.s5.ref,executionAuthorityGranted:false,reservationCreated:false,effectRef:null},
  review={...body,ref:m3Ref('exact-branch-review',body)};
 await writeM3Record(ctx,'branch-reviews',review.ref,body);
 await recheckCapitalOwners(ctx,q.request,q.acceptance);await readEnterpriseExactProgrammeResourceCheck(ctx,policy,c.consumer.s5.ref);
 return m3Tx(ctx,async client=>{
  await assertDependencies(ctx,q.acceptance.dependencies,client,true);const current=await m3Query(ctx,q.id,client,true);
  if(current.generation!==q.generation||!['PARTIAL','TESTED'].includes(current.status)||current.result_digest!==program.ref.contentDigest)
   throw new CapitalProgramV2Error('STALE_INPUT','Exact branch publication fenced');
  const replay=(await client.query<{request_digest:string;body:ExactBranchReview}>(
   'SELECT request_digest,body FROM finnor_os.m3_branch_reviews WHERE tenant_id=$1 AND principal_id=$2 AND idempotency_key=$3',
   [ctx.auth.tenantId,ctx.auth.userId,input.idempotencyKey])).rows[0];
  if(replay){if(replay.request_digest!==requestDigest)throw new CapitalProgramV2Error('CONFLICT','Exact branch key binds a different programme');return {review:replay.body,replayed:true};}
  const count=(await client.query<{n:number}>('SELECT count(*)::int n FROM finnor_os.m3_branch_reviews WHERE tenant_id=$1 AND principal_id=$2 AND query_id=$3',[ctx.auth.tenantId,ctx.auth.userId,q.id])).rows[0]!.n;
  if(count>=16)throw new CapitalProgramV2Error('LIMIT_EXCEEDED','Exact branch review cap');
  await client.query('INSERT INTO finnor_os.m3_branch_reviews(tenant_id,principal_id,query_id,idempotency_key,request_digest,body) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
   [ctx.auth.tenantId,ctx.auth.userId,q.id,input.idempotencyKey,requestDigest,JSON.stringify(review)]);
  await m3Event(ctx,q.id,randomUUID(),'SELECTION',{intent:input.intent,reviewRef:review.ref,executionAuthorityGranted:false,reservationCreated:false},client);
  return {review,replayed:false};
 });
}

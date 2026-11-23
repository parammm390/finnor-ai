/** One canonical publication protocol. No issuer, clock or admission is minted here. */
import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { canonical } from "../../governed-execution/src/protocol";
import { assertSignature, byteDigest, digest, fault, RefSchema, type AuthorityKey,
  type Signed } from "./contracts";

const text=z.string().min(1).max(4096), hex=z.string().regex(/^[a-f0-9]{64}$/);
export const integer=z.string().regex(/^(0|[1-9][0-9]{0,30})$/);
const interval=z.object({lower:integer,upper:integer}).strict()
  .refine(v=>BigInt(v.lower)<=BigInt(v.upper));
const window=z.object({name:text,lower:integer,upper:integer}).strict()
  .refine(v=>BigInt(v.lower)<BigInt(v.upper));
const key=z.object({id:text,principalId:text,publicKey:text,validAfter:text,
  validUntil:text,revoked:z.boolean()}).strict();
const signature=z.object({keyId:text,signature:z.string().min(1).max(128)}).strict();
export const primarySchema=z.object({systemIdentifier:integer,databaseOid:integer,
  timeline:integer,postmasterStartedAt:text,incarnation:hex}).strict();
export type Primary=z.infer<typeof primarySchema>;
const origin=z.object({id:text,kind:z.enum(["GUARDIAN","JOB","CONTROLLER","P3","COMBINED_ABORT",
  "S8_AUTHORITY","SOURCE_RUNTIME_HOST"]),publicKey:text,bootId:text,
  streamId:text,genesisDigest:hex}).strict();
export const enrollmentSchema=z.object({
  schema:z.literal("finnor.s8.canonical-specialist-enrollment.v1"),
  tenantId:text,principalId:text,rightsRef:text,policyDigest:hex,quorumPolicyDigest:hex,quorumRootFingerprint:hex,
  historyDigest:hex,s6PrefixDigest:hex,holdsDigest:hex,protectedWitnessDigest:hex,
  sourceClosureDigest:hex,runtimeDigest:hex,sqlDefinitionDigest:hex,sqlAclDigest:hex,
  participatingCodeDigest:hex,qualifiedDeploymentRef:RefSchema,initialHistoryEvidenceRef:RefSchema,
  validAfter:text,validUntil:text,primary:primarySchema,
  roles:z.object({adapter:text,candidate:text,proof:text,projection:text,reader:text}).strict(),
  origins:z.array(origin).min(7).max(64),
  clockAuthorityKeys:z.array(key).min(1).max(16),
  proofAuthorityKeys:z.array(key).min(1).max(16),
  linearization:z.literal("ORIGINAL_CANDIDATE_COMMIT"),
  requiredPhysicalEvents:z.array(z.enum(["WAL_DURABLE","REPLICA_ACK","CLIENT_RECEIPT"])).max(3),
  requiredBounds:z.array(text).min(1).max(128),
}).strict();
export type Enrollment=z.infer<typeof enrollmentSchema>;
export const quorumPolicySchema=z.object({
  schema:z.literal("finnor.s8.applicable-publication-quorum.v1"),
  tenantId:text,principalId:text,rightsRef:text,validAfter:text,validUntil:text,
  rules:z.array(z.object({id:text,applicableDomain:z.literal("WORKFORCE_SPECIALIST_PUBLICATION"),
    threshold:z.number().int().min(1).max(16),keys:z.array(key).min(1).max(16)}).strict()).max(32),
}).strict();
export type QuorumPolicy=z.infer<typeof quorumPolicySchema>;
export type VerifiedEnrollment={readonly body:Enrollment;readonly digest:string;
  readonly originalReadOnly:boolean;readonly authorityBounds:readonly z.infer<typeof window>[]};
const enrolled=new WeakSet<object>();
export function immutable<T>(value:T):T{
  if(value&&typeof value==="object"){
    for(const child of Object.values(value))immutable(child);
    Object.freeze(value);
  }
  return value;
}
const fingerprint=(pem:string)=>{
  const parsed=createPublicKey(pem);
  if(parsed.asymmetricKeyType!=="ed25519")fault("SPECIALIST_AUTHORITY_KEY_TYPE",503);
  return byteDigest(parsed.export({type:"spki",format:"der"}));
};
function rootSignature(body:unknown,signature:string,root:string){
  if(!verify(null,Buffer.from(canonical(body)),createPublicKey(root),Buffer.from(signature,"base64")))
    fault("SPECIALIST_EXISTING_ISSUER_SIGNATURE_REQUIRED",403);
}
function currentWindow(name:string,after:string,until:string,originalReadOnly=false){
  const a=Date.parse(after),b=Date.parse(until),now=Date.now();
  if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a>=b||!originalReadOnly&&(now<a||now>=b))
    fault("SPECIALIST_AUTHORITY_WINDOW_INVALID",403);
  return{name,lower:String(BigInt(a)*1000n),upper:String(BigInt(b)*1000n)};
}
export function assertVerifiedEnrollment(value:VerifiedEnrollment){
  if(!enrolled.has(value))fault("SPECIALIST_GENUINE_ENROLLMENT_HANDLE_REQUIRED",503);
}
/** Historical signature check. The original signed key, not today's clock,
 * bounds the complete original proof interval. It never confers invocation. */
export function assertOriginalSignature<T>(signed: Signed<T>, keys: readonly AuthorityKey[],
  interval?: { lower: bigint; upper: bigint }): AuthorityKey {
  const key = keys.find(candidate => candidate.id === signed.keyId);
  if (!key || key.revoked) fault("SPECIALIST_ORIGINAL_SIGNER_UNAVAILABLE", 403);
  const lower = Date.parse(key.validAfter), upper = Date.parse(key.validUntil);
  if (!Number.isSafeInteger(lower) || !Number.isSafeInteger(upper) || lower >= upper
    || interval && (interval.lower <= BigInt(lower) * 1000n || interval.upper >= BigInt(upper) * 1000n)
    || createPublicKey(key.publicKey).asymmetricKeyType !== "ed25519"
    || !verify(null, Buffer.from(canonical(signed.body)), createPublicKey(key.publicKey),
      Buffer.from(signed.signature, "base64")))
    fault("SPECIALIST_ORIGINAL_SIGNATURE_OR_WINDOW_INVALID", 403);
  return key;
}
export function assertCurrentEnrollment(value: VerifiedEnrollment) {
  assertVerifiedEnrollment(value);
  const now = BigInt(Date.now()) * 1000n;
  if (value.originalReadOnly || value.authorityBounds.some(bound =>
    now <= BigInt(bound.lower) || now >= BigInt(bound.upper)))
    fault("SPECIALIST_CURRENT_ENROLLMENT_REQUIRED", 403);
}
/** Inputs come from the already release-root-authenticated S8 policy, never a caller. */
export function verifyEnrollment(input:{
  signed:Signed<unknown>;releaseRoot:string;policyDigest:string;tenantId:string;principalId:string;rightsRef:string;
  evaluatorKeys:AuthorityKey[];promotionKeys:AuthorityKey[];
  quorum:Signed<unknown>;quorumRoot:string;expectedQuorumDigest:string;
  originalReadOnly?:boolean;
  approvals:Array<{role:"EVALUATOR"|"PROMOTER"|string;keyId:string;signature:string}>;
}):VerifiedEnrollment{
  const body=enrollmentSchema.parse(input.signed.body),quorum=quorumPolicySchema.parse(input.quorum.body);
  rootSignature(body,input.signed.signature,input.releaseRoot);
  if(body.quorumRootFingerprint!==fingerprint(input.quorumRoot))
    fault("SPECIALIST_APPLICABLE_QUORUM_ROOT_SUBSTITUTED",403);
  rootSignature(quorum,input.quorum.signature,input.quorumRoot);
  if(body.policyDigest!==input.policyDigest||body.tenantId!==input.tenantId
    ||body.principalId!==input.principalId||body.rightsRef!==input.rightsRef
    ||body.quorumPolicyDigest!==input.expectedQuorumDigest||digest(quorum)!==input.expectedQuorumDigest
    ||quorum.tenantId!==body.tenantId||quorum.principalId!==body.principalId||quorum.rightsRef!==body.rightsRef)
    fault("SPECIALIST_ENROLLMENT_OR_APPLICABLE_QUORUM_SUBSTITUTED",403);
  const bounds=[currentWindow("ENROLLMENT",body.validAfter,body.validUntil,input.originalReadOnly),
    currentWindow("APPLICABLE_QUORUM_POLICY",quorum.validAfter,quorum.validUntil,input.originalReadOnly)];
  const allKeys=[...input.evaluatorKeys,...input.promotionKeys,...quorum.rules.flatMap(r=>r.keys)];
  const principals=new Map<string,string>(),fingerprints=new Map<string,string>();
  for(const [role,keys]of [["EVALUATOR",input.evaluatorKeys],["PROMOTER",input.promotionKeys],
    ...quorum.rules.map(rule=>[rule.id,rule.keys]as const)]as const){
    for(const k of keys){
      const fp=fingerprint(k.publicKey);
      if(k.principalId===input.principalId||fp===fingerprint(input.releaseRoot)
        ||principals.has(k.principalId)&&principals.get(k.principalId)!==role
        ||fingerprints.has(fp)&&fingerprints.get(fp)!==role)
        fault("SPECIALIST_ENROLLMENT_ROLE_SEPARATION",403);
      principals.set(k.principalId,role);fingerprints.set(fp,role);
    }
  }
  if(new Set(quorum.rules.map(r=>r.id)).size!==quorum.rules.length
    ||quorum.rules.some(r=>r.id==="EVALUATOR"||r.id==="PROMOTER"||r.threshold>r.keys.length)
    ||[input.evaluatorKeys,input.promotionKeys,...quorum.rules.map(r=>r.keys)]
      .some(keys=>new Set(keys.map(k=>k.id)).size!==keys.length))
    fault("SPECIALIST_ENROLLMENT_AMBIGUOUS_AUTHORITY",403);
  const statement={schema:"finnor.s8.canonical-specialist-approval.v1",enrollmentDigest:digest(body)};
  for(const rule of [{id:"EVALUATOR",keys:input.evaluatorKeys,threshold:1},
    {id:"PROMOTER",keys:input.promotionKeys,threshold:1},...quorum.rules]){
    const used=new Set<string>();
    for(const approval of input.approvals.filter(a=>a.role===rule.id)){
      if(used.has(approval.keyId))fault("SPECIALIST_DUPLICATE_QUORUM_SIGNATURE",403);
      const authority=input.originalReadOnly ? assertOriginalSignature({...approval,body:statement},rule.keys)
        : assertSignature({...approval,body:statement},rule.keys);
      used.add(authority.id);
      bounds.push(currentWindow(rule.id+":"+authority.id,authority.validAfter,authority.validUntil,input.originalReadOnly));
    }
    if(used.size<rule.threshold)fault("SPECIALIST_APPLICABLE_QUORUM_NOT_MET",403);
  }
  const originKinds=new Set(body.origins.map(o=>o.kind));
  if(["GUARDIAN","JOB","CONTROLLER","P3","COMBINED_ABORT","S8_AUTHORITY","SOURCE_RUNTIME_HOST"]
    .some(k=>!originKinds.has(k as Enrollment["origins"][number]["kind"]))
    ||new Set(body.origins.map(o=>o.id)).size!==body.origins.length
    ||new Set(body.origins.map(o=>o.streamId)).size!==body.origins.length
    ||new Set(body.requiredBounds).size!==body.requiredBounds.length
    ||new Set(Object.values(body.roles)).size!==5
    ||new Set(body.requiredPhysicalEvents).size!==body.requiredPhysicalEvents.length)
    fault("SPECIALIST_ENROLLMENT_COVERAGE_AMBIGUOUS",403);
  for(const o of body.origins)fingerprint(o.publicKey);
  for(const k of [...body.clockAuthorityKeys,...body.proofAuthorityKeys])fingerprint(k.publicKey);
  // allKeys is intentionally not a source of new keys: only authenticated policy inputs supplied it.
  if(!allKeys.length)fault("SPECIALIST_EXISTING_ISSUER_KEYS_REQUIRED",403);
  const value=Object.freeze({body:immutable(structuredClone(body)),digest:digest(body),originalReadOnly:input.originalReadOnly===true,
    authorityBounds:Object.freeze(bounds.map(b=>Object.freeze(b)))});
  enrolled.add(value);return value;
}

export const candidateSchema=z.object({
  schema:z.literal("finnor.w2.original-publication-candidate.v1"),
  publicationId:hex,tenantId:text,principalId:text,programmeId:text,assignmentId:text,
  originalWorkId:text,originalInputId:text,originalMeaningDigest:hex,originalScopeDigest:hex,
  intentDigest:hex,bindingDigest:hex,resultDigest:hex,resultRef:RefSchema,
  budgetRef:RefSchema,reservationRef:RefSchema,consumptionRef:RefSchema,
  nativeRevision:z.number().int().nonnegative(),nativeDigest:hex,proposedDeltaDigest:hex,
  sourceClosureDigest:hex,runtimeDigest:hex,hostDigest:hex,bootId:text,
  guardianId:text,cgroupId:text,processIdentity:hex,originalMonotonicStart:integer,
  originalMonotonicDeadline:integer,bounds:z.array(window).min(1).max(128),
  requiredOriginIds:z.array(text).min(7).max(64),s8Epoch:integer,
  enrollmentDigest:hex,primary:primarySchema,jobId:text,claimFence:integer,claimTokenDigest:hex,
  physicalContract:z.enum(["LOGICAL_COMMIT","WAL_DURABLE","REPLICA_ACK","CLIENT_RECEIPT"]),
}).strict();
export type PublicationCandidate=z.infer<typeof candidateSchema>;
export const observationSchema=z.object({
  candidateDigest:hex,publicationId:hex,xid8:integer,primary:primarySchema,
  phase:z.enum(["BEFORE_COMMIT","AFTER_COMMITTED"]),
  observedUtcMicros:integer,commitStatus:z.enum(["in progress","committed"]),
  commitUtcMicros:integer.nullable(),trackCommitTimestamp:z.literal(true),
  synchronousCommit:text,serverVersion:z.number().int().min(140000),
}).strict();
export type CommitObservation=z.infer<typeof observationSchema>;
export const clockSealSchema=z.object({
  schema:z.literal("finnor.specialist.qualified-clock-relation.v1"),
  enrollmentDigest:hex,publicationId:hex,primary:primarySchema,bootId:text,
  referenceUtcMicros:integer,referenceMonotonicNs:integer,
  utcErrorMicros:integer,dbErrorMicros:integer,driftPartsPerBillion:integer,
  qualifiedUtcCoverage:interval,qualifiedMonotonicCoverage:interval,
  qualificationRef:RefSchema,qualificationDigest:hex,sequence:integer,previousDigest:hex,
}).strict();
export type ClockSeal=z.infer<typeof clockSealSchema>;
export const originSealSchema=z.object({
  schema:z.literal("finnor.specialist.original-origin-coverage.v1"),
  enrollmentDigest:hex,publicationId:hex,candidateDigest:hex,originId:text,streamId:text,bootId:text,
  sequence:integer,previousDigest:hex,fromMonotonicNs:integer,throughMonotonicNs:integer,
  referenceUtcMicros:integer,referenceMonotonicNs:integer,utcErrorMicros:integer,
  driftPartsPerBillion:integer,
  events:z.array(z.object({kind:z.enum(["ABORT","AUTHORITY_LOSS","CLOCK_STEP","GUARDIAN_LOSS",
    "PROCESS_LOSS","CGROUP_LOSS","SOURCE_CHANGE","HOST_CHANGE"]),atMonotonicNs:integer}).strict()).max(4096),
}).strict();
export type OriginSeal=z.infer<typeof originSealSchema>;
export interface SignedSeal<T>{body:T;keyId:string;signature:string}
export function verifyClockSeal(enrollment:VerifiedEnrollment,raw:SignedSeal<unknown>):ClockSeal{
  assertVerifiedEnrollment(enrollment);
  const body=clockSealSchema.parse(raw.body);
  assertOriginalSignature({...raw,body},enrollment.body.clockAuthorityKeys,
    {lower:BigInt(body.qualifiedUtcCoverage.lower),upper:BigInt(body.qualifiedUtcCoverage.upper)});
  if(body.enrollmentDigest!==enrollment.digest||digest(body.primary)!==digest(enrollment.body.primary))
    fault("SPECIALIST_CLOCK_AUTHORITY_OR_PRIMARY_CHANGED",503);
  return body;
}
function errorAt(value:bigint,reference:bigint,error:bigint,drift:bigint){
  return error+((value>=reference?value-reference:reference-value)*drift+999999999n)/1000000000n;
}
function monotonicToUtc(value:bigint,seal:{referenceUtcMicros:string;referenceMonotonicNs:string;
  utcErrorMicros:string;driftPartsPerBillion:string}){
  const ref=BigInt(seal.referenceMonotonicNs),delta=value-ref;
  const lowerDelta=delta>=0n?delta/1000n:-((-delta+999n)/1000n);
  const upperDelta=delta>=0n?(delta+999n)/1000n:-((-delta)/1000n);
  const error=errorAt(value,ref,BigInt(seal.utcErrorMicros)*1000n,BigInt(seal.driftPartsPerBillion));
  const micros=(error+999n)/1000n;
  return{lower:BigInt(seal.referenceUtcMicros)+lowerDelta-micros,
    upper:BigInt(seal.referenceUtcMicros)+upperDelta+micros};
}
export function encloseOriginalCommit(candidate:PublicationCandidate,pre:CommitObservation,
  post:CommitObservation,clock:ClockSeal){
  const identity=digest(candidate),primary=digest(candidate.primary);
  if(pre.phase!=="BEFORE_COMMIT"||post.phase!=="AFTER_COMMITTED"||pre.commitStatus!=="in progress"
    ||post.commitStatus!=="committed"||pre.xid8!==post.xid8||pre.commitUtcMicros!==null
    ||!post.commitUtcMicros||pre.publicationId!==candidate.publicationId||post.publicationId!==candidate.publicationId
    ||pre.candidateDigest!==identity||post.candidateDigest!==identity
    ||digest(pre.primary)!==primary||digest(post.primary)!==primary||digest(clock.primary)!==primary
    ||clock.publicationId!==candidate.publicationId||clock.bootId!==candidate.bootId
    ||clock.enrollmentDigest!==candidate.enrollmentDigest)
    fault("SPECIALIST_ORIGINAL_COMMIT_BRACKET_UNAVAILABLE",503);
  // Lower bound is a real pre-COMMIT primary statement; upper is a real later
  // committed-status observation. Commit timestamp is checked, NEVER used as the upper bound.
  const lower=BigInt(pre.observedUtcMicros)-BigInt(clock.dbErrorMicros),
    upper=BigInt(post.observedUtcMicros)+BigInt(clock.dbErrorMicros);
  if(lower>upper||BigInt(post.commitUtcMicros)<lower||BigInt(post.commitUtcMicros)>upper
    ||lower<BigInt(clock.qualifiedUtcCoverage.lower)||upper>BigInt(clock.qualifiedUtcCoverage.upper))
    fault("SPECIALIST_QUALIFIED_COMMIT_INTERVAL_UNAVAILABLE",503);
  const maxOffset=[lower,upper].reduce((m,t)=>{
    const d=t-BigInt(clock.referenceUtcMicros);return d<0n?(-d>m?-d:m):(d>m?d:m);
  },0n);
  const drift=BigInt(clock.driftPartsPerBillion),denominator=1000000000n-drift;
  if(denominator<=0n)fault("SPECIALIST_CLOCK_DRIFT_UNQUALIFIED",503);
  // Invert the monotonic-to-UTC error relation conservatively, including
  // uncertainty's own drift. Multiplying only the UTC span would underbound it.
  const uncertainty=(BigInt(clock.utcErrorMicros)*1000000000n+maxOffset*drift
    +denominator-1n)/denominator;
  const monoLower=BigInt(clock.referenceMonotonicNs)
    +(lower-BigInt(clock.referenceUtcMicros)-uncertainty)*1000n;
  const monoUpper=BigInt(clock.referenceMonotonicNs)
    +(upper-BigInt(clock.referenceUtcMicros)+uncertainty)*1000n;
  if(monoLower<BigInt(clock.qualifiedMonotonicCoverage.lower)
    ||monoUpper>BigInt(clock.qualifiedMonotonicCoverage.upper)
    ||monoLower<=BigInt(candidate.originalMonotonicStart)
    ||monoUpper>=BigInt(candidate.originalMonotonicDeadline))
    fault("SPECIALIST_ORIGINAL_MONOTONIC_INTERVAL_EXCEEDED",503);
  return{utc:{lower,upper},monotonic:{lower:monoLower,upper:monoUpper}};
}
export function assertAllOriginCoverage(enrollment:VerifiedEnrollment,candidate:PublicationCandidate,
  interval:{utc:{lower:bigint;upper:bigint}},chains:Array<Array<SignedSeal<unknown>>>){
  assertVerifiedEnrollment(enrollment);
  const expected=enrollment.body.origins;
  if(digest([...candidate.requiredOriginIds].sort())!==digest(expected.map(o=>o.id).sort())
    ||chains.length!==expected.length)fault("SPECIALIST_ALL_ABORT_ORIGINS_REQUIRED",503);
  const seen=new Set<string>();
  for(const chain of chains){
    const initial=chain[0];
    if(!initial)fault("SPECIALIST_ORIGIN_PREFIX_UNAVAILABLE",503);
    const first=originSealSchema.parse(initial.body),origin=expected.find(o=>o.id===first.originId);
    if(!origin||seen.has(origin.id))fault("SPECIALIST_ORIGIN_SUBSTITUTED",503);
    seen.add(origin.id);
    let previous=origin.genesisDigest,sequence=0n,through:bigint|null=null,coveredFrom:bigint|null=null;
    let last=first;
    for(const raw of chain){
      const seal=originSealSchema.parse(raw.body);
      if(seal.enrollmentDigest!==enrollment.digest||seal.publicationId!==candidate.publicationId
        ||seal.candidateDigest!==digest(candidate)||seal.originId!==origin.id
        ||seal.streamId!==origin.streamId||seal.bootId!==origin.bootId
        ||BigInt(seal.sequence)!==++sequence||seal.previousDigest!==previous
        ||BigInt(seal.fromMonotonicNs)>BigInt(seal.throughMonotonicNs)
        ||through!==null&&BigInt(seal.fromMonotonicNs)!==through
        ||!verify(null,Buffer.from(canonical(seal)),createPublicKey(origin.publicKey),
          Buffer.from(raw.signature,"base64")))
        fault("SPECIALIST_ORIGIN_AUTHENTICATED_PREFIX_INVALID",503);
      const from=monotonicToUtc(BigInt(seal.fromMonotonicNs),seal);
      if(coveredFrom===null)coveredFrom=from.upper;
      for(const event of seal.events){
        const at=BigInt(event.atMonotonicNs);
        if(at<BigInt(seal.fromMonotonicNs)||at>BigInt(seal.throughMonotonicNs)
          ||monotonicToUtc(at,seal).lower<=interval.utc.upper)
          fault("SPECIALIST_ABORT_OR_AUTHORITY_LOSS_BEFORE_PROVEN_COMMIT",503);
      }
      through=BigInt(seal.throughMonotonicNs);previous=digest(seal);last=seal;
      // Inspect the entire supplied authenticated history. A later record
      // reporting an earlier abort cannot hide behind an already-covered prefix.
    }
    if(coveredFrom===null||coveredFrom>=interval.utc.lower
      ||monotonicToUtc(BigInt(last.throughMonotonicNs),last).lower<interval.utc.upper)
      fault("SPECIALIST_REMOTE_ORIGIN_COVERAGE_INCOMPLETE",503);
  }
}
export function assertOriginalBounds(enrollment:VerifiedEnrollment,candidate:PublicationCandidate,
  interval:{utc:{lower:bigint;upper:bigint}}){
  assertVerifiedEnrollment(enrollment);
  if(candidate.enrollmentDigest!==enrollment.digest
    ||candidate.sourceClosureDigest!==enrollment.body.sourceClosureDigest
    ||candidate.runtimeDigest!==enrollment.body.runtimeDigest
    ||digest(candidate.primary)!==digest(enrollment.body.primary)
    ||new Set(candidate.bounds.map(b=>b.name)).size!==candidate.bounds.length
    ||enrollment.body.requiredBounds.some(name=>!candidate.bounds.some(b=>b.name===name)))
    fault("SPECIALIST_ORIGINAL_AUTHORITY_BOUNDS_INCOMPLETE",503);
  for(const bound of [...candidate.bounds,...enrollment.authorityBounds])
    if(interval.utc.lower<=BigInt(bound.lower)||interval.utc.upper>=BigInt(bound.upper))
      fault("SPECIALIST_COMMIT_INTERVAL_OUTSIDE_ORIGINAL_BOUND",503);
}

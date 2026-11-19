/** Read ONLY genuine root-custodied seals. No producer JSON, clock or signer fallback. */
import { createPublicKey, verify } from "node:crypto";
import { canonical } from "./protocol";
import { join } from "node:path";
import { z } from "zod";
import { readSpecialistRootBytes } from "./specialist-root-custody";
import { assertOriginalClockStart, assertOriginalClockEnd, assertOriginalQualifiedClockEvidence } from "./specialist-clock-evidence";
import { readOriginalClockQualification } from "./specialist-clock-qualification";
import { digest, fault } from "../../capability-evolution/src/contracts";
import { assertVerifiedEnrollment, assertAllOriginCoverage, assertOriginalBounds, encloseOriginalCommit,
  verifyClockSeal, assertOriginalSignature, integer, primarySchema, immutable, type VerifiedEnrollment,
  type PublicationCandidate, type CommitObservation, type SignedSeal } from "../../capability-evolution/src/specialist-publication-protocol";

const text=z.string().min(1).max(4096),hex=z.string().regex(/^[a-f0-9]{64}$/);
const envelope=z.object({
  schema:z.literal("finnor.specialist.root-publication-witness.v1"),
  publicationId:hex,candidateDigest:hex,bootId:text,guardianId:text,cgroupId:text,processIdentity:hex,
  clock:z.object({body:z.unknown(),keyId:text,signature:text}).strict(),
  origins:z.array(z.array(z.object({body:z.unknown(),keyId:text,signature:text}).strict())
    .min(1).max(4096)).min(7).max(64),
  physicalEvents:z.array(z.object({body:z.unknown(),keyId:text,signature:text}).strict()).max(3),
}).strict();
const physical=z.object({
  schema:z.literal("finnor.specialist.original-physical-event.v1"),
  enrollmentDigest:hex,publicationId:hex,candidateDigest:hex,xid8:integer,primary:primarySchema,
  event:z.enum(["WAL_DURABLE","REPLICA_ACK","CLIENT_RECEIPT"]),
  enclosingUtcMicros:z.object({lower:integer,upper:integer}).strict(),
  qualificationDigest:hex,
}).strict();
async function rootFile(directory:string,name:string){
  if(!/^[a-f0-9]{64}\.json$/.test(name))
    fault("SPECIALIST_ROOT_WITNESS_PATH_INVALID",503);
  return JSON.parse((await readSpecialistRootBytes(join(directory,name),8*1024*1024)).toString("utf8"));
}
const verified=new WeakSet<object>();
const verifiedTailWitnesses=new WeakMap<object,()=>void>();
export interface VerifiedPublicationWitness{
  readonly candidateDigest:string;
  readonly interval:{readonly utc:{readonly lower:string;readonly upper:string};
    readonly monotonic:{readonly lower:string;readonly upper:string}};
  readonly evidenceDigest:string;readonly evidence:unknown;
}
export function assertVerifiedPublicationWitness(value:VerifiedPublicationWitness){
  if(!verified.has(value)||!verifiedTailWitnesses.has(value))
    fault("SPECIALIST_GENUINE_ROOT_WITNESS_WITH_CURRENT_TAILS_REQUIRED",503);
  verifiedTailWitnesses.get(value)!();
}
export function assertVerifiedPublicationWitnessCurrentTails(value:VerifiedPublicationWitness){
  assertVerifiedPublicationWitness(value);
}
export async function readOriginalPublicationWitness(input:{
  directory:string;expectedDirectory:string;enrollment:VerifiedEnrollment;
  candidate:PublicationCandidate;pre:CommitObservation;post:CommitObservation;originalSourceDigest:string;signal?:AbortSignal;
}):Promise<VerifiedPublicationWitness>{
  assertVerifiedEnrollment(input.enrollment);
  if(input.directory!==input.expectedDirectory)fault("SPECIALIST_UNENROLLED_ROOT_WITNESS_PATH",503);
  const c=input.candidate,e=input.enrollment,
    raw=envelope.parse(await rootFile(input.directory,c.publicationId+".json"));
  if(raw.publicationId!==c.publicationId||raw.candidateDigest!==digest(c)||raw.bootId!==c.bootId
    ||raw.guardianId!==c.guardianId||raw.cgroupId!==c.cgroupId||raw.processIdentity!==c.processIdentity)
    fault("SPECIALIST_ORIGINAL_ROOT_PROCESS_OR_CGROUP_CHANGED",503);
  const original=await readOriginalAttemptIdentity({enrollment:e,directory:input.directory,
    publicationId:c.publicationId,bindingDigest:c.bindingDigest,expectedHostDigest:c.hostDigest,
    expectedOriginalSourceDigest:input.originalSourceDigest,expectedMonotonicDeadline:c.originalMonotonicDeadline});
  if(original.bootId!==c.bootId||original.guardianId!==c.guardianId||original.cgroupId!==c.cgroupId
    ||original.processIdentity!==c.processIdentity||original.originalMonotonicStart!==c.originalMonotonicStart
    ||original.originalMonotonicDeadline!==c.originalMonotonicDeadline
    ||digest(original.originalUtcBounds)!==digest(c.bounds))
    fault("SPECIALIST_ORIGINAL_ATTEMPT_SEAL_SUBSTITUTED",503);
  const clock=verifyClockSeal(e,raw.clock),signedClock={...raw.clock,body:clock},
    signedRecord=z.object({body:z.unknown(),keyId:text,signature:text}).strict(),
    clockStartRaw=signedRecord.parse(await rootFile(join(input.directory,"clock-starts"),c.publicationId+".json")),
    clockEndRaw=signedRecord.parse(await rootFile(join(input.directory,"clock-ends"),c.publicationId+".json")),
    clockStart=assertOriginalClockStart({enrollment:e,candidate:c,clock:signedClock,start:clockStartRaw,
      originalAttemptDigest:digest(original.signed),clockNamespaceDevice:original.clockNamespaceDevice,
      clockNamespaceInode:original.clockNamespaceInode});
  const clockEnd=assertOriginalClockEnd({enrollment:e,candidate:c,clock:signedClock,start:clockStart,end:clockEndRaw}),
    actualQualification=await readOriginalClockQualification(e,clock.qualificationRef);
  assertOriginalQualifiedClockEvidence({enrollment:e,qualification:actualQualification.body,candidate:c,
    clock:signedClock,start:clockStart,end:clockEnd,witnessDirectory:input.directory,hostPolicyDigest:original.hostPolicyDigest});
  const interval=encloseOriginalCommit(c,input.pre,input.post,clock);
  assertOriginalBounds(e,c,interval);
  assertAllOriginCoverage(e,c,interval,raw.origins);
  let verifiedOriginalUpper=interval.utc.upper;
  const needed=new Set(e.body.requiredPhysicalEvents);
  if(c.physicalContract!=="LOGICAL_COMMIT")needed.add(c.physicalContract);
  const seen=new Set<string>();
  for(const signed of raw.physicalEvents){
    const body=physical.parse(signed.body);
    assertOriginalSignature({...signed,body},e.body.proofAuthorityKeys,
      {lower:BigInt(body.enclosingUtcMicros.lower),upper:BigInt(body.enclosingUtcMicros.upper)});
    const lower=BigInt(body.enclosingUtcMicros.lower),upper=BigInt(body.enclosingUtcMicros.upper);
    if(seen.has(body.event)||!needed.has(body.event)||body.publicationId!==c.publicationId
      ||body.candidateDigest!==digest(c)||body.enrollmentDigest!==e.digest
      ||body.xid8!==input.pre.xid8||digest(body.primary)!==digest(c.primary)
      ||body.qualificationDigest!==clock.qualificationDigest||lower>upper
      ||lower<interval.utc.lower||upper<BigInt(input.post.commitUtcMicros!))
      fault("SPECIALIST_GENUINE_PHYSICAL_EVENT_PROOF_REQUIRED",503);
    assertOriginalBounds(e,c,{utc:{lower,upper}});
    if(lower<BigInt(clock.qualifiedUtcCoverage.lower)||upper>BigInt(clock.qualifiedUtcCoverage.upper))
      fault("SPECIALIST_PHYSICAL_EVENT_CLOCK_UNQUALIFIED",503);
    const distance=(upper>=BigInt(clock.referenceUtcMicros)?upper-BigInt(clock.referenceUtcMicros)
      :BigInt(clock.referenceUtcMicros)-upper),drift=BigInt(clock.driftPartsPerBillion),
      divisor=1000000000n-drift;
    if(divisor<=0n)fault("SPECIALIST_PHYSICAL_EVENT_CLOCK_UNQUALIFIED",503);
    const error=(BigInt(clock.utcErrorMicros)*1000000000n+distance*drift+divisor-1n)/divisor;
    const monoUpper=BigInt(clock.referenceMonotonicNs)
      +(upper-BigInt(clock.referenceUtcMicros)+error)*1000n;
    if(monoUpper>=BigInt(c.originalMonotonicDeadline)
      ||monoUpper>BigInt(clock.qualifiedMonotonicCoverage.upper))
      fault("SPECIALIST_PHYSICAL_DURABILITY_OR_ACK_TOO_LATE",503);
    // A required later physical event also needs ALL origins covered through it.
    assertAllOriginCoverage(e,c,{utc:{lower:interval.utc.lower,upper}},raw.origins);
    if(upper>verifiedOriginalUpper)verifiedOriginalUpper=upper;
    seen.add(body.event);
  }
  if([...needed].some(kind=>!seen.has(kind)))fault("SPECIALIST_PHYSICAL_EVENT_UNAVAILABLE",503);
  // Mandatory exact-read tail brand. Fresh metadata never changes frozen evidence.
  const {readCurrentOriginalOriginCoverage,assertVerifiedCurrentOriginalOriginTails}=
    await import("./specialist-origin-collector-client");
  const currentTailInput={enrollment:e,candidate:structuredClone(c),clock:structuredClone(signedClock),
    pre:structuredClone(input.pre),post:structuredClone(input.post),frozenOrigins:structuredClone(raw.origins),
    verifiedRequiredPhysicalUpperUtcMicros:String(verifiedOriginalUpper),
    signal:input.signal??AbortSignal.timeout(5000)};
  const currentTail=await readCurrentOriginalOriginCoverage(currentTailInput);
  assertVerifiedCurrentOriginalOriginTails(currentTail,currentTailInput);
  const value=immutable({candidateDigest:digest(c),
    interval:{utc:{lower:String(interval.utc.lower),upper:String(interval.utc.upper)},
      monotonic:{lower:String(interval.monotonic.lower),upper:String(interval.monotonic.upper)}},
    evidenceDigest:digest({witness:raw,originalAttempt:original.signed,clockStart:clockStartRaw,clockEnd:clockEndRaw,
      clockQualification:actualQualification}),
    evidence:{witness:raw,originalAttempt:original.signed,clockStart:clockStartRaw,clockEnd:clockEndRaw,
      clockQualification:actualQualification}});
  verified.add(value);
  verifiedTailWitnesses.set(value,()=>assertVerifiedCurrentOriginalOriginTails(currentTail,currentTailInput));
  assertVerifiedPublicationWitnessCurrentTails(value);return value;
}

export const originalAttemptIdentitySchema=z.object({
  schema:z.literal("finnor.specialist.root-original-attempt.v1"),
  enrollmentDigest:hex,publicationId:hex,bindingDigest:hex,hostDigest:hex,hostPolicyDigest:hex,originalSourceDigest:hex,
  bootId:text,guardianId:text,cgroupId:text,processIdentity:hex,
  clockNamespaceDevice:integer,clockNamespaceInode:integer,
  originalMonotonicStart:integer,originalMonotonicDeadline:integer,
  originalUtcBounds:z.array(z.object({name:text,lower:integer,upper:integer}).strict()).min(1).max(128),
}).strict();
export async function readOriginalAttemptIdentity(input:{
  enrollment:VerifiedEnrollment;directory:string;publicationId:string;bindingDigest:string;expectedHostDigest:string;
  expectedOriginalSourceDigest:string;expectedHostPolicyDigest?:string;expectedMonotonicDeadline:string;
}){
  assertVerifiedEnrollment(input.enrollment);
  const raw=z.object({body:originalAttemptIdentitySchema,keyId:text,signature:text}).strict()
    .parse(await rootFile(join(input.directory,"attempts"),input.publicationId+".json"));
  const guardians=input.enrollment.body.origins.filter(o=>o.kind==="GUARDIAN"),
    guardian=guardians.find(o=>o.id===raw.keyId);
  if(!guardian||raw.body.enrollmentDigest!==input.enrollment.digest
    ||raw.body.publicationId!==input.publicationId||raw.body.bindingDigest!==input.bindingDigest
    ||guardian.bootId!==raw.body.bootId||guardian.id!==raw.body.guardianId
    ||raw.body.hostDigest!==input.expectedHostDigest
    ||raw.body.originalSourceDigest!==input.expectedOriginalSourceDigest
    ||(input.expectedHostPolicyDigest!==undefined&&raw.body.hostPolicyDigest!==input.expectedHostPolicyDigest)
    ||raw.body.originalMonotonicDeadline!==input.expectedMonotonicDeadline
    ||!verify(null,Buffer.from(canonical(raw.body)),createPublicKey(guardian.publicKey),
      Buffer.from(raw.signature,"base64")))
    fault("SPECIALIST_GENUINE_ORIGINAL_GUARDIAN_IDENTITY_REQUIRED",503);
  return immutable({...raw.body,signed:raw});
}

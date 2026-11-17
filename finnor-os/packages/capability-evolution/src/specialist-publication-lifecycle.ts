/** Actual FS/S6 mutation coordinator, not a second authority or a currentness cache. */
import { digest, fault, RefSchema, sameRef, type AuthorityKey, type Signed } from "./contracts";
import { type CapabilityJournal } from "./journal";
import { type ProtectedCapabilityEvents } from "./protected-events";
import { readOwnerTransportReference } from "../../governed-execution/src/owner-transport";
import { CanonicalSpecialistAuthority, historySchema, type CanonicalHistory, type CanonicalMutation } from "./specialist-publication-authority";
import { verifyEnrollment, enrollmentSchema, immutable } from "./specialist-publication-protocol";
import { installedWorkforceSpecialistIdentity } from "./specialist-source";

interface Policy{
  tenantId:string;principalId:string;rightsRef:string;validAfter:string;validUntil:string;
  evaluatorKeys:AuthorityKey[];promotionKeys:AuthorityKey[];specialistAnalysis?:unknown;
}
export interface CanonicalLifecycleConfiguration{
  enrollment:Signed<unknown>;quorumPolicy:Signed<unknown>;quorumRoot:string;
  approvals:Array<{role:string;keyId:string;signature:string}>;client:unknown;
}
type HistorySource={journal:CapabilityJournal;events:ProtectedCapabilityEvents|null;
  canonicalState:()=>unknown};
export class CanonicalS8JournalBoundary{
  private active:CanonicalMutation|null=null;
  private prior:CanonicalHistory|null=null;
  private startupPending=false;
  private startupIdentity:unknown=null;
  private constructor(private policy:Policy,readonly authority:CanonicalSpecialistAuthority|null){}
  static async open(policy:Policy,root:string,config?:CanonicalLifecycleConfiguration){
    immutable(policy);
    if(!policy.specialistAnalysis)return new CanonicalS8JournalBoundary(policy,null);
    if(!config)return new CanonicalS8JournalBoundary(policy,null); // Legacy history remains read-only, not migrated.
    const body=enrollmentSchema.parse(config.enrollment.body);
    const enrollment=verifyEnrollment({signed:config.enrollment,releaseRoot:root,
      policyDigest:digest(policy),tenantId:policy.tenantId,principalId:policy.principalId,rightsRef:policy.rightsRef,
      evaluatorKeys:policy.evaluatorKeys,promotionKeys:policy.promotionKeys,
      quorum:config.quorumPolicy,quorumRoot:config.quorumRoot,expectedQuorumDigest:body.quorumPolicyDigest,
      approvals:config.approvals});
    const installed=await installedWorkforceSpecialistIdentity();
    const authority=await CanonicalSpecialistAuthority.open(enrollment,config.client,installed);
    if(authority.config.role!=="adapter")fault("S8_CANONICAL_AUTHENTICATED_ADAPTER_REQUIRED",503);
    return new CanonicalS8JournalBoundary(policy,authority);
  }
  async beforeMutation(kind:string,identity:string,payload:unknown){
    if(!this.policy.specialistAnalysis)return;
    if(!this.authority||!this.active)fault("S8_SPECIALIST_CANONICAL_PENDING_FENCE_REQUIRED",503);
    await this.authority.beforeMutation(this.active,{kind,identity,payloadDigest:digest(payload)});
  }
  private assertNoAmbiguousOriginals(journal:CapabilityJournal){
    for(const intent of journal.entries.filter(e=>e.operation.endsWith("_COMMIT_INTENT"))){
      const b=intent.body,requestDigest=digest({actorId:intent.actorId,requestId:b.requestId,
        operation:b.operation,body:b.input});
      const terminal=journal.entries.some(e=>!e.operation.endsWith("_COMMIT_INTENT")
        &&e.operation===b.operation&&e.actorId===intent.actorId&&e.requestId===b.requestId
        &&e.requestDigest===requestDigest&&b.originalRequestDigest===requestDigest
        &&digest({actorId:e.actorId,requestId:e.requestId,operation:e.operation,body:e.body})===requestDigest
        &&RefSchema.safeParse(e.result?.ref).success&&sameRef(e.result.ref,b.ref));
      if(!terminal)fault("S8_CANONICAL_ORIGINAL_COMMIT_STILL_UNRESOLVED",503);
    }
  }
  async history(source:HistorySource,previousHistoryDigest:string):Promise<CanonicalHistory>{
    await source.journal.assertIntegrity();
    if(!source.events)fault("S8_CANONICAL_PROTECTED_HISTORY_REQUIRED",503);
    const actualEvents=await source.events.authenticatedHistory(source.journal.entries);
    const scope={semanticOwner:"S8",tenantId:this.policy.tenantId,principalId:this.policy.principalId},
      entries=source.journal.entries,policyDigest=source.journal.policyDigest,
      references:Array<{owner:string;id:string;version:string;contentDigest:string}>=[];
    for(const entry of entries){
      const content={schema:"finnor.s8.lifecycle-checkpoint.v1",policyDigest,
        sequence:entry.sequence,entryDigest:entry.digest,previousDigest:entry.previous};
      const ref={owner:"S8",id:`capability-checkpoint:${policyDigest}:${entry.sequence}`,
        version:"s8-capability-v1",contentDigest:digest(content)};
      const accepted=await readOwnerTransportReference(scope,ref.id);
      if(!accepted.receipt||digest(accepted.reference)!==digest({...ref,content}))
        fault("S8_CANONICAL_ORIGINAL_CHECKPOINT_DISAGREEMENT",503);
      references.push(ref);
      if(entry.operation.startsWith("SPECIALIST_")&&entry.operation!=="SPECIALIST_COMMIT_INTENT"){
        const original=RefSchema.parse(entry.result.ref),remote=await readOwnerTransportReference(scope,original.id);
        const {ref:_ref,...proposal}=entry.body;
        const expected=entry.operation==="SPECIALIST_PROPOSE"?proposal:entry.body;
        if(!remote.receipt||digest(remote.reference)!==digest({...original,content:expected}))
          fault("S8_CANONICAL_ORIGINAL_SPECIALIST_CONTENT_DISAGREEMENT",503);
        references.push(original);
      }
    }
    const state=source.canonicalState(),records=entries.map(e=>e.digest),
      historyDigest=digest({policyDigest,records,actualEvents,canonicalState:state});
    return immutable({policyDigest,sequence:entries.length,historyDigest,previousHistoryDigest,
      s6PrefixDigest:digest(references),holdsDigest:digest((state as any).caseHolds),
      protectedWitnessDigest:digest(actualEvents),canonicalStateDigest:digest(state),
      entryDigests:records,acceptedReferences:references,protectedEventsDigest:digest(actualEvents)});
  }
  async prepareStartup(){
    if(!this.policy.specialistAnalysis)return;
    if(!this.authority)fault("S8_CANONICAL_ENROLLMENT_REQUIRED_BEFORE_FS_OPEN",503);
    const current=await this.authority.startupOriginal();
    this.prior=current.history;
    const original=current.pendingOriginal??{schema:"finnor.s8.canonical-startup.v1",
      policyDigest:digest(this.policy),originalEpoch:current.epoch,historyDigest:current.history.historyDigest};
    this.startupPending=current.pendingOriginal!==null;
    this.startupIdentity=original;
    this.active=await this.authority.begin(original,current.history,[]);
  }
  async enrollOriginalHistory(source:HistorySource){
    if(!this.authority)fault("S8_GENUINE_CANONICAL_ENROLLMENT_REQUIRED",503);
    this.assertNoAmbiguousOriginals(source.journal);
    const e=this.authority.enrollment.body,ref=e.initialHistoryEvidenceRef,
      accepted=await readOwnerTransportReference({semanticOwner:"S8",tenantId:e.tenantId,principalId:e.principalId},ref.id);
    const original=historySchema.parse(accepted.reference.content),
      actual=await this.history(source,original.previousHistoryDigest);
    if(!accepted.receipt||digest(accepted.reference)!==digest({...ref,content:original})
      ||digest(original)!==digest(actual)||actual.historyDigest!==e.historyDigest
      ||actual.s6PrefixDigest!==e.s6PrefixDigest||actual.holdsDigest!==e.holdsDigest
      ||actual.protectedWitnessDigest!==e.protectedWitnessDigest)
      fault("S8_ORIGINAL_AUTHENTICATED_ENROLLMENT_HISTORY_DISAGREES",503);
    await this.authority.enroll(actual,source.canonicalState(),{schema:"finnor.s8.original-history-enrollment.v1",
      originalHistoryEvidenceRef:ref,authenticatedReceiptDigest:digest(accepted.receipt)});
  }
  async startup<T>(normal:()=>Promise<T>,recoverOnly:()=>Promise<T>,source:()=>HistorySource){
    if(!this.policy.specialistAnalysis)return normal();
    if(!this.authority||!this.active||!this.prior)
      fault("S8_CANONICAL_STARTUP_PENDING_REQUIRED",503);
    const prior=this.prior,original=this.startupIdentity;
    try{
      const result=this.startupPending?await recoverOnly():await normal();
      this.assertNoAmbiguousOriginals(source().journal);
      const final=await this.history(source(),prior.historyDigest);
      await this.authority.finish(this.active,final,source().canonicalState(),
        {phase:"EXACT_ORIGINAL_STARTUP_RECONCILIATION",original});
      return result;
    }finally{this.active=null;this.prior=null;this.startupIdentity=null;}
  }
  async run<T>(original:unknown,admitNoEffect:()=>Promise<void>,normal:()=>Promise<T>,recoverOnly:()=>Promise<T>,source:()=>HistorySource,
    holds:Array<{commitment:string;originalOwnerDigest:string}>=[]):Promise<T>{
    if(!this.policy.specialistAnalysis)return normal();
    if(!this.authority)fault("S8_SPECIALIST_CANONICAL_ENROLLMENT_REQUIRED_FOR_MUTATION",503);
    const current=await this.authority.startupOriginal(),prior=current.history;
    if(current.pendingOriginal&&digest(current.pendingOriginal)!==digest(original))
      fault("S8_CANONICAL_DIFFERENT_ORIGINAL_PENDING",503);
    // Verify the currently canonical history before a fresh original. An unresolved
    // original instead reconciles its authenticated old prefix; never resubmit it.
    if(!current.pendingOriginal){
      const actual=await this.history(source(),prior.previousHistoryDigest);
      if(digest(actual)!==digest(prior))fault("S8_FS_S6_CANONICAL_HISTORY_DISAGREEMENT",503);
      // Definite syntax/op/RBAC refusal must not consume a domain-wide original.
      // Existing ambiguous originals skip fresh admission and only reconcile.
      await admitNoEffect();
    }
    this.prior=prior;this.active=await this.authority.begin(original,prior,holds);
    try{
      const result=this.active.created?await normal():await recoverOnly();
      this.assertNoAmbiguousOriginals(source().journal);
      const final=await this.history(source(),prior.historyDigest);
      await this.authority.finish(this.active,final,source().canonicalState(),
        {phase:"EXACT_ORIGINAL_AUTHENTICATED_FS_S6_FINALIZATION",original});
      return result;
    }finally{this.active=null;this.prior=null;}
  }
  async current(source:HistorySource){
    if(!this.authority)fault("S8_ENROLLED_CANONICAL_CURRENTNESS_UNAVAILABLE",503);
    this.assertNoAmbiguousOriginals(source.journal);
    const before=await this.authority.readEpoch(),actual=await this.history(source,before.history.previousHistoryDigest);
    return this.authority.readEpoch(actual);
  }
  async invalidate(reason:string,source:HistorySource){
    if(!this.authority)fault("S8_CANONICAL_INVALIDATION_UNAVAILABLE",503);
    const prior=await this.authority.startupOriginal();
    // Attenuation is committed and intentionally NOT finalized by an invalid source.
    await this.authority.begin({schema:"finnor.s8.shared-authority-invalidation.v1",reason,
      policyDigest:digest(this.policy),originalHistoryDigest:prior.history.historyDigest},prior.history,[]);
  }
  async close(){await this.authority?.close();}
}

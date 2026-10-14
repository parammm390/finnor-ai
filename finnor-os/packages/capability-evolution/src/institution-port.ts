import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installedDevelopmentRuntime } from '../../private-equity/src/institution-program/installed-runtime';
import { z } from "zod";
import { assertSignature, byteDigest, digest, fault, RefSchema, sameRef,
  type AuthorityKey, type CapabilityRef, type Signed } from "./contracts";
import type { JournalEntry } from "./journal";

/** Actual installed intrinsic bytes are a proposal identity. Reading this
 * descriptor neither registers nor admits it through the signed lifecycle. */
async function readInstalledInstitutionCompilerIdentity(){
  const paths=["contracts.ts","reconstruction.ts","source-decoder.ts","checker.ts","checker-raw.ts","responsibility.ts",
    "resource-demand.ts","completion-contracts.ts","action-resolution.ts","canonical-json.ts",
    "canonical-owners.ts","owner-admission.ts","source-authority.ts","source-scope.ts","source-locks.ts","checker-process.ts","installed-runtime.ts",
    "store.ts","worker.ts","api.ts","inputs.ts","artifact.ts","baseline.ts","meter.ts","installed-source.ts"].map(path=>
      new URL(`../../private-equity/src/institution-program/${path}`,import.meta.url));
  for(const path of ["institution-dependencies.ts","institution-worker.ts"])
    paths.push(new URL(`../../private-equity/src/live-recompilation/${path}`,import.meta.url));
  for(const path of ["contracts.ts","plan.ts","owners.ts","store.ts","institution.ts",
    "institution-history.ts","institution-continuation.ts","institution-recovery.ts","duty-observer.ts","request-observer.ts"])
    paths.push(new URL(`../../private-equity/src/program-synthesis/${path}`,import.meta.url));
  for(const path of ["allocation-store.ts","economic-store.ts","digital-twin.ts"])
    paths.push(new URL(`../../private-equity/src/${path}`,import.meta.url));
  paths.push(new URL("./institution-port.ts",import.meta.url));
  paths.push(new URL('./institution-consumer.ts',import.meta.url));
  for(const path of ['finnor-os/package-lock.json','package-lock.json',
    'scope-frontier5/x1-institutional-programme-compiler/profile.json','finnor-os/packages/db/migration-head.ts',
    'finnor-os/packages/db/migrations-bundle.ts'])paths.push(new URL('../../../../'+path,import.meta.url));
  const installation=installedDevelopmentRuntime();
  if(installation){paths.push(pathToFileURL(installation.manifestPath));
    paths.push(new URL('../../source-custody/installation.cjs',import.meta.url));
    paths.push(new URL('../../source-custody/index.cjs',import.meta.url));}
  const sources=await Promise.all(paths.map(async path=>({path:fileURLToPath(path),sha256:byteDigest(await readFile(path))})));
  const body={schema:"finnor.s8.installed-institution-compiler.v1",sources,
    runtime:{node:process.version,platform:process.platform,architecture:process.arch,
      ...(installation?{compiledInstallationDigest:installation.manifestDigest}: {})},
    state:"INSTALLED_PROPOSAL_UNADMITTED",protectedQualification:false,executionAuthorityGranted:false};
  return {...body,ref:institutionCapabilityRef("installed-proposal",body)};
}
const loadedInstitutionIdentity=readInstalledInstitutionCompilerIdentity();
void loadedInstitutionIdentity.catch(()=>undefined);
export async function installedInstitutionCompilerIdentity(){
  const loaded=await loadedInstitutionIdentity,current=await readInstalledInstitutionCompilerIdentity();
  if(loaded.ref.contentDigest!==current.ref.contentDigest)fault("X1_LOADED_COMPILER_METHOD_CHANGED",503);
  return loaded;
}

const text=z.string().min(1).max(4096),hex=z.string().regex(/^[a-f0-9]{64}$/),instant=z.string().datetime({offset:true});
const pin=z.object({path:text,sha256:hex}).strict();
const CandidateBody=z.object({schema:z.literal("finnor.s8.institution-compiler.v1"),tenantId:text,principalId:text,
  rightsRef:text,owningInterface:z.literal("x1-institution-programme-v1"),profileDigest:hex,
  profileRef:RefSchema,dependencies:z.array(pin).min(1).max(64),checkerRevision:hex,
  runtimeDigest:hex,proposedAt:instant,validAfter:instant,validUntil:instant,
  payload:z.object({algorithm:z.literal("NATIVE_EVIDENCE_HYPOTHESES_ORIGINAL_INVARIANTS"),
    producerModule:pin,checkerModule:pin,incrementalModule:pin}).strict(),
  protectedAdmission:z.literal(false),executionAuthorityGranted:z.literal(false)}).strict();
export type InstitutionCompilerCandidate=z.infer<typeof CandidateBody>&{ref:CapabilityRef};
export const institutionCapabilityRef=(kind:string,body:unknown):CapabilityRef=>({owner:"S8",
  id:`institution-${kind}:${digest(body)}`,version:"s8-institution-compiler-v1",contentDigest:digest(body)});
export function parseInstitutionCompilerCandidate(value:unknown):InstitutionCompilerCandidate {
  const raw=z.object({ref:RefSchema}).passthrough().parse(value),{ref,...rest}=raw,body=CandidateBody.parse(rest);
  if(!sameRef(ref,institutionCapabilityRef("candidate",body))||Date.parse(body.validUntil)<=Date.parse(body.validAfter)
    ||new Set(body.dependencies.map(p=>p.path)).size!==body.dependencies.length
    ||body.payload.producerModule.path===body.payload.checkerModule.path
    ||[body.payload.producerModule,body.payload.checkerModule,body.payload.incrementalModule].some(p=>
      !body.dependencies.some(d=>d.path===p.path&&d.sha256===p.sha256)))fault("S8_X1_CONTENT_OR_SOURCE_CLOSURE_INVALID");
  return {...body,ref};
}
const Protocol=z.object({schema:z.literal("finnor.s8.institution-evaluation.v1"),tenantId:text,principalId:text,
  revisionRef:RefSchema,evaluatorId:text,profileDigest:hex,payloadDigest:hex,registeredAt:instant,
  caseCommitments:z.array(hex).min(1).max(4096),qualification:z.literal("PUBLIC_DEVELOPMENT_ONLY")}).strict();
const Evaluation=Protocol.omit({registeredAt:true}).extend({schema:z.literal("finnor.s8.institution-evaluation-result.v1"),
  protocolRef:RefSchema,completedAt:instant,resultsDigest:hex,disposition:z.enum(["SUPPORTED_DISPOSABLE","REFUSED","INCONCLUSIVE"]),
  falseCompletions:z.number().int().nonnegative(),authorityViolations:z.number().int().nonnegative(),
  monetaryCostUsd:z.number().nonnegative().nullable(),humanSeconds:z.number().nonnegative().nullable()}).strict();
const Admission=z.object({schema:z.literal("finnor.s8.institution-admission.v1"),revisionRef:RefSchema,evaluationRef:RefSchema,
  profileDigest:hex,payloadDigest:hex,protectionDomain:z.literal("DISPOSABLE_TEST_AUTHORITY"),
  protectedQualification:z.literal(false),productionActive:z.literal(false),executionAuthorityGranted:z.literal(false)}).strict();
const Revocation=z.object({revisionRef:RefSchema,expectedAdmissionRef:RefSchema,reason:text}).strict();
type Actor={id:string;principalId:string;roles:readonly string[]};
type Policy={domain:string;tenantId:string;principalId:string;rightsRef:string;validAfter:string;validUntil:string;
  evaluatorKeys:AuthorityKey[];promotionKeys:AuthorityKey[];
  institutionCompiler?:{profileDigest:string;sourcePins:Array<{path:string;sha256:string}>}};
type State={candidate:InstitutionCompilerCandidate;protocol:Signed<z.infer<typeof Protocol>>|null;protocolRef:CapabilityRef|null;
  evaluation:Signed<z.infer<typeof Evaluation>>|null;evaluationRef:CapabilityRef|null;
  admission:Signed<z.infer<typeof Admission>>|null;admissionRef:CapabilityRef|null;revoked:boolean};

/** An additive domain inside CapabilityEvolution's existing journal protocol. */
export class InstitutionCapabilityPort {
  private states=new Map<string,State>();
  private consumedCases=new Set<string>();
  constructor(private policy:Policy){
    if(policy.institutionCompiler&&policy.evaluatorKeys.some(evaluator=>
      policy.promotionKeys.some(promoter=>promoter.principalId===evaluator.principalId)))
      fault("S8_X1_AUTHORITY_NOT_SEPARATED",503);
  }
  replay(entry:JournalEntry){
    if(entry.operation==="INSTITUTION_PROPOSE"){
      const candidate=parseInstitutionCompilerCandidate(entry.body);
      this.states.set(candidate.ref.id,{candidate,protocol:null,protocolRef:null,evaluation:null,evaluationRef:null,admission:null,admissionRef:null,revoked:false});
    }else if(entry.operation.startsWith("INSTITUTION_")){
      const s=this.state(entry.body.body?.revisionRef??entry.body.revisionRef);
      if(entry.operation==="INSTITUTION_REGISTER"){s.protocol=entry.body;s.protocolRef=entry.result.ref;for(const c of entry.body.body.caseCommitments)this.consumedCases.add(c);}
      if(entry.operation==="INSTITUTION_EVALUATE"){s.evaluation=entry.body;s.evaluationRef=entry.result.ref;}
      if(entry.operation==="INSTITUTION_ADMIT"){s.admission=entry.body;s.admissionRef=entry.result.ref;}
      if(entry.operation==="INSTITUTION_REVOKE")s.revoked=true;
    }
  }
  private state(ref:CapabilityRef){const s=this.states.get(ref.id);if(!s||!sameRef(s.candidate.ref,ref))fault("S8_X1_REVISION_NOT_FOUND",404);return s;}
  private async dependencies(s:State){
    const domain=this.policy.institutionCompiler;
    if(!domain||domain.profileDigest!==s.candidate.profileDigest||digest(domain.sourcePins)!==digest(s.candidate.dependencies))
      fault("S8_X1_REGISTERED_DOMAIN_OR_CLOSURE_UNAVAILABLE");
    for(const p of domain.sourcePins)if(byteDigest(await readFile(p.path))!==p.sha256)fault("S8_X1_SOURCE_CHANGED");
  }
  private current(s:State){
    if(s.revoked||!s.admission||!s.evaluation||s.evaluation.body.disposition!=="SUPPORTED_DISPOSABLE"
      ||Date.now()<Date.parse(s.candidate.validAfter)||Date.now()>=Date.parse(s.candidate.validUntil))return false;
    assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId);
    assertSignature(s.admission,this.policy.promotionKeys);
    return true;
  }
  async command(actor:Actor,operation:string,body:any,commit:(ref:CapabilityRef,content:unknown)=>Promise<unknown>){
    const read=operation==="INSTITUTION_CURRENT"||operation==="INSTITUTION_CATALOGUE";
    const role=operation==="INSTITUTION_PROPOSE"?"PROPOSER":operation==="INSTITUTION_ADMIT"||operation==="INSTITUTION_REVOKE"?"PROMOTER":"EVALUATOR";
    if(read?!actor.roles.some(r=>r==="CONSUMER"||r==="READER"):!actor.roles.includes(role))fault("S8_OPERATION_NOT_AUTHORIZED",403);
    if(this.policy.domain!=="DISPOSABLE_TEST_AUTHORITY"||!this.policy.institutionCompiler)fault("S8_X1_DOMAIN_POLICY_UNAVAILABLE",403);
    let content:unknown,ref:CapabilityRef;
    if(operation==="INSTITUTION_PROPOSE"){
      const c=parseInstitutionCompilerCandidate(body);
      if(c.tenantId!==this.policy.tenantId||c.principalId!==this.policy.principalId||c.principalId!==actor.principalId
        ||c.rightsRef!==this.policy.rightsRef||Date.parse(c.validAfter)<Date.parse(this.policy.validAfter)
        ||Date.parse(c.validUntil)>Date.parse(this.policy.validUntil)||this.states.has(c.ref.id))fault("S8_X1_SCOPE_OR_PROPOSAL_INVALID");
      await this.dependencies({candidate:c} as State);const {ref:ignored,...preimage}=c;content=preimage;ref=c.ref;
    }else if(operation==="INSTITUTION_CURRENT"){
      const s=this.state(z.object({revisionRef:RefSchema}).strict().parse(body).revisionRef);await this.dependencies(s);
      const current=this.current(s);return {readOnly:true,result:{current,revisionRef:s.candidate.ref,
        candidate:current?s.candidate:null,admissionRef:current?s.admissionRef:null,
        protectedQualification:false,productionActive:false,executionAuthorityGranted:false}};
    }else if(operation==="INSTITUTION_CATALOGUE"){
      const q=z.object({profileDigest:hex}).strict().parse(body),reusable=[];
      for(const s of this.states.values())if(s.candidate.profileDigest===q.profileDigest&&this.current(s)){
        await this.dependencies(s);reusable.push({revisionRef:s.candidate.ref,admissionRef:s.admissionRef});
      }
      return {readOnly:true,result:{reusable,protectedQualification:false,executionAuthorityGranted:false}};
    }else{
      const raw=z.object({body:z.unknown(),keyId:text,signature:z.string().min(1).max(128)}).strict().parse(body);
      const parsed=(operation==="INSTITUTION_REGISTER"?Protocol:operation==="INSTITUTION_EVALUATE"?Evaluation:
        operation==="INSTITUTION_ADMIT"?Admission:operation==="INSTITUTION_REVOKE"?Revocation:null)?.parse(raw.body);
      if(!parsed)fault("S8_OPERATION_UNSUPPORTED",404);
      const signed={...raw,body:parsed},s=this.state(parsed.revisionRef);await this.dependencies(s);
      assertSignature(signed,role==="PROMOTER"?this.policy.promotionKeys:this.policy.evaluatorKeys,actor.principalId);
      if(operation==="INSTITUTION_REGISTER"){
        const p=Protocol.parse(parsed);
        if(s.protocol||p.tenantId!==s.candidate.tenantId||p.principalId!==s.candidate.principalId
          ||p.evaluatorId!==actor.principalId||p.profileDigest!==s.candidate.profileDigest
          ||p.payloadDigest!==s.candidate.ref.contentDigest||new Set(p.caseCommitments).size!==p.caseCommitments.length
          ||p.caseCommitments.some(c=>this.consumedCases.has(c)))fault("S8_X1_EVALUATION_REGISTRATION_INVALID");
      }else if(operation==="INSTITUTION_EVALUATE"){
        const e=Evaluation.parse(parsed),p=s.protocol?.body;
        if(!p||s.evaluation||!sameRef(e.protocolRef,s.protocolRef)||e.evaluatorId!==p.evaluatorId
          ||e.tenantId!==p.tenantId||e.principalId!==p.principalId
          ||e.profileDigest!==p.profileDigest||e.payloadDigest!==p.payloadDigest
          ||digest(e.caseCommitments)!==digest(p.caseCommitments)||Date.parse(e.completedAt)<Date.parse(p.registeredAt)
          ||Date.parse(e.completedAt)>Date.now()
          ||e.disposition==="SUPPORTED_DISPOSABLE"&&(e.falseCompletions!==0||e.authorityViolations!==0))fault("S8_X1_EVALUATION_BINDING_INVALID");
      }else if(operation==="INSTITUTION_ADMIT"){
        const a=Admission.parse(parsed);
        if(!s.evaluation||s.evaluation.body.disposition!=="SUPPORTED_DISPOSABLE"||s.admission
          ||!sameRef(a.evaluationRef,s.evaluationRef)||a.profileDigest!==s.candidate.profileDigest
          ||a.payloadDigest!==s.candidate.ref.contentDigest)fault("S8_X1_ADMISSION_BINDING_INVALID");
        assertSignature(s.evaluation,this.policy.evaluatorKeys,s.evaluation.body.evaluatorId);
      }else if(!sameRef(Revocation.parse(parsed).expectedAdmissionRef,s.admissionRef))fault("S8_X1_REVOCATION_BINDING_INVALID");
      content=signed;ref=institutionCapabilityRef(operation.toLowerCase(),content);
    }
    await commit(ref,content);
    const result={ref,protectedQualification:false,productionActive:false,executionAuthorityGranted:false};
    this.replay({operation,body:operation==="INSTITUTION_PROPOSE"?body:content,result} as JournalEntry);
    return {readOnly:false,result};
  }
}

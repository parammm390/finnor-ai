import {z} from 'zod';
import type {ResolvedTotalSpecification,TotalAlgorithmTheoryCapsule} from '../../../../shared-types/src/total-algorithm-theory';
import {NativeReceiptSchema} from '../capsule';
import {jsonHash} from '../syntax';
import {parseDefinition,parseProgram,parseProposition,parseTotalType} from './syntax';
import {totalSearchLimitsSchema} from './search';
const digest=z.string().regex(/^[a-f0-9]{64}$/);
const ref=z.object({owner:z.string().min(1).max(128),id:z.string().min(1).max(256),
 version:z.string().max(256),contentDigest:digest}).strict();
const acceptance=z.union([
 z.object({status:z.literal('PUBLIC_DEVELOPMENT'),reason:z.literal('NO_INDEPENDENT_ACCEPTANCE_RECEIPT'),protectedFamilyCredit:z.literal(false)}).strict(),
 z.object({status:z.literal('PUBLIC_DEVELOPMENT'),reason:z.literal('DISPOSABLE_POLICY_NOT_INDEPENDENT_ACCEPTANCE'),protectedFamilyCredit:z.literal(false),
  policyDigest:digest,receiptDigest:digest,validUntil:z.string().max(64)}).strict(),
 z.object({status:z.literal('ACCEPTED'),issuerId:z.string().max(128),receiptId:z.string().max(128),scope:z.string().max(128),
  policyRevision:z.string().max(128),policyDigest:digest,policyApprovalRef:ref,validUntil:z.string().max(64),protectedFamilyCredit:z.literal(false),
  qualification:z.literal('SIGNATURE_UNDER_EXTERNALLY_CONFIGURED_POLICY_NOT_PROTECTED_CAMPAIGN_CUSTODY')}).strict(),
]);
const specification=z.object({schema:z.literal('finnor.y5.resolved-specification.v2'),sourceRef:ref,
 definition:z.unknown().transform(parseDefinition),definitionDigest:digest,acceptance}).strict();
export function parseResolvedTotalSpecification(value:unknown):ResolvedTotalSpecification{
 const parsed=specification.parse(value);
 if(parsed.definitionDigest!==jsonHash(parsed.definition))throw Error('Y5_TOTAL_SPECIFICATION_DIGEST');
 return parsed;
}
const plan=z.object({induction:z.number().int().min(0).max(1),uniform:z.literal(0)}).strict();
const attempt=z.object({ordinal:z.number().int().positive(),stage:z.enum(['PROGRAM_DEVELOPMENT','CONJECTURE_DEVELOPMENT','CONJECTURE_PROOF','UNIFORM_PROOF']),
 programDigest:digest,propositionDigest:digest.optional(),status:z.enum(['REFUTED','UNPROVED','PROVED']),counterexample:z.unknown().optional(),
 native:NativeReceiptSchema.optional(),proofPlan:plan.optional(),sourceDigest:digest.optional(),failureCode:z.string().max(256).optional()}).strict();
const kernel=z.object({schema:z.literal('finnor.y5.total-kernel-check.v2'),exactOwnerExpectedType:z.literal(true),suppliedProofObjectReplayed:z.literal(true),
 loadBearingLemmaInProof:z.literal(true),countedDenotationAgreement:z.literal(true),allSizeOperationBound:z.literal(true),
 definitionDigest:digest,programDigest:digest,propositionDigest:digest,sourceDigest:digest,proofObjectDigest:digest,
 interpreterDigest:digest,interpreterProofObjectDigest:digest,runtimeDigest:digest,importInventoryDigest:digest,
 modelSourceCorrespondence:z.literal('FROZEN_SOURCE_COMPILED_PIN_REHASHED_AND_REPLAYED'),modelSourcePinDigest:digest,sharedModelSetupRef:ref,
 imports:z.array(z.string().max(256)).min(1).max(4096),axioms:z.array(z.string().max(128)).max(16),
 native:z.array(NativeReceiptSchema).length(4),independentImplementation:z.literal(false),protectedCustody:z.literal(false),
 trustPolicyApproval:z.literal('NOT_ESTABLISHED')}).strict();
const schema=z.object({
 schema:z.literal('finnor.algorithm-theory-capsule.v2'),kind:z.literal('AlgorithmTheoryCapsule'),digest,
 specification,program:z.unknown().transform(parseProgram),invariant:z.unknown().transform(parseProposition),proofPlan:plan,
 grammarDigest:digest,interpreterSource:z.string().max(131072),interpreterDigest:digest,interpreterProofObjectDigest:digest,
 algorithmSource:z.string().max(131072),sourceDigest:digest,
 proofObject:z.string().min(4).max(12582912).regex(/^[A-Za-z0-9+/]*={0,2}$/),proofObjectDigest:digest,
 theorem:z.object({name:z.literal('Y5Total.uniform'),statement:z.string().max(256),domain:z.literal('ALL_FINITE_INTEGER_LISTS'),
  nonemptyEachSize:z.literal(true),feasibleWitnessEveryInput:z.literal(true),quality:z.literal('EXACT_LEAST_INITIAL_STATE'),
  prefixCorrespondence:z.literal(true),operationBound:z.object({coefficient:z.number().int().positive().max(100000),
   constant:z.number().int().positive().max(100000)}).strict(),bitOrWallTimeBound:z.literal(false)}).strict(),
 checker:kernel,runtime:z.object({version:z.literal('4.34.1'),archiveDigest:digest,inventoryDigest:digest,identityDigest:digest,
  profile:z.literal('NATIVE_DARWIN_ARM64_TOTAL_CLOSED_AST'),maximumInputItems:z.literal(128),maximumIntegerDigits:z.literal(512)}).strict(),
 origin:z.object({episodeCutDigest:digest.nullable(),selectionRule:z.enum(['ALL_ORIGINAL_S5_EPISODES_FOR_AUTHENTICATED_PRINCIPAL',
  'PUBLIC_LIBRARY_DEVELOPMENT_INPUTS_NOT_OWNER_CENSUS']),developmentExamplesDigest:digest,newProtectedStructure:z.literal(false)}).strict(),
 search:z.object({attempts:z.array(attempt).max(30024),programsExamined:z.number().int().nonnegative().max(20000),
  propositionsExamined:z.number().int().nonnegative().max(10000),proofAttempts:z.number().int().nonnegative().max(12),
  stateTypesExamined:z.array(z.unknown().transform(parseTotalType)).max(5),
  developmentInputs:z.array(z.array(z.string().regex(/^(?:0|-?[1-9][0-9]*)$/).max(513)).max(12)).min(1).max(64),
  limits:totalSearchLimitsSchema,nativePreparation:z.array(NativeReceiptSchema).length(1),sharedModelSetupRef:ref,
  wallMs:z.number().finite().nonnegative(),completeMoney:z.null(),completeHumanSeconds:z.null(),aggregatePeakBytes:z.null()}).strict(),
 admission:z.object({status:z.literal('UNADMITTED'),protectedAdmission:z.literal(false),productionActive:z.literal(false),
  executionAuthorityGranted:z.literal(false)}).strict(),
}).strict();
export function parseTotalCapsule(value:unknown):TotalAlgorithmTheoryCapsule{
 let body:string|undefined;
 try{
  let bytes=0,nodes=0;const parents:object[]=[];
  body=JSON.stringify(value,function(_key,item:unknown){
   if(++nodes>1000000)throw Error('bound');
   while(parents.length&&parents.at(-1)!==this)parents.pop();
   if(item&&typeof item==='object'){if(parents.includes(item)||parents.length>=64)throw Error('bound');parents.push(item);}
   if(typeof item==='string'){bytes+=Buffer.byteLength(item);if(bytes>16777216)throw Error('bound');}return item;
  });
  if(!body||Buffer.byteLength(body)>16777216)throw Error('bound');
 }catch{throw Error('Y5_TOTAL_CAPSULE_BOUND');}
 const c=schema.parse(JSON.parse(body)),{digest:claimed,...unsigned}=c;
 if(claimed!==jsonHash(unsigned))throw Error('Y5_TOTAL_CAPSULE_INTEGRITY');
 if(Buffer.from(c.proofObject,'base64').toString('base64')!==c.proofObject)throw Error('Y5_TOTAL_PROOF_ENCODING');
 parseResolvedTotalSpecification(c.specification);
 const k=c.checker;
 if(k.definitionDigest!==c.specification.definitionDigest||k.programDigest!==jsonHash(c.program)||k.propositionDigest!==jsonHash(c.invariant)||
  k.sourceDigest!==c.sourceDigest||k.proofObjectDigest!==c.proofObjectDigest||k.interpreterDigest!==c.interpreterDigest||
  k.interpreterProofObjectDigest!==c.interpreterProofObjectDigest||k.runtimeDigest!==c.runtime.identityDigest||
  k.importInventoryDigest!==c.runtime.inventoryDigest)throw Error('Y5_TOTAL_KERNEL_RECEIPT_BINDING');
 if(k.axioms.some(a=>!['propext','Classical.choice','Quot.sound'].includes(a)))throw Error('Y5_TOTAL_UNSAFE_AXIOM');
 if(c.origin.selectionRule==='ALL_ORIGINAL_S5_EPISODES_FOR_AUTHENTICATED_PRINCIPAL'&&!c.origin.episodeCutDigest||
  c.origin.selectionRule==='PUBLIC_LIBRARY_DEVELOPMENT_INPUTS_NOT_OWNER_CENSUS'&&c.origin.episodeCutDigest!==null||
  c.origin.developmentExamplesDigest!==jsonHash(c.search.developmentInputs))throw Error('Y5_TOTAL_ORIGIN_BINDING');
 if(c.search.programsExamined>c.search.limits.maxPrograms||c.search.propositionsExamined>c.search.limits.maxPropositions||
  c.search.proofAttempts>c.search.limits.maxProofAttempts||Buffer.byteLength(JSON.stringify(c.search))>c.search.limits.maxRetainedBytes)
  throw Error('Y5_TOTAL_SEARCH_ENVELOPE');
 return c;
}

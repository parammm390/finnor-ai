import {z} from 'zod';
import type {AlgorithmTheoryCapsule} from '../../../shared-types/src/algorithm-theory';
import {expressionSchema,jsonHash,parseExpression} from './syntax';

const digest=z.string().regex(/^[0-9a-f]{64}$/),text=z.string().max(1048576);
const plan=z.object({local:z.number().int().min(0).max(2),uniform:z.number().int().min(0).max(2)}).strict();
const receipt=z.object({
 command:z.array(z.string().max(4096)).max(32),pid:z.number().int(),exitCode:z.number().int().nullable(),signal:z.string().max(64).nullable(),
 wallMs:z.number().finite().nonnegative(),outputBytes:z.number().int().nonnegative(),stdout:text,stderr:text,memoryLimitMiB:z.literal(2048).nullable(),
 memoryEnforcement:z.enum(['LEAN_OPTION','DEADLINE_ONLY_REPLAY_MEMORY_UNQUALIFIED']),aggregatePeakBytes:z.null(),
 isolation:z.enum(['CLOSED_SYNTAX_SANITIZED_ENV_PROCESS_GROUP_NOT_OS_SANDBOX','DARWIN_SEATBELT_DENY_NETWORK_SCOPED_FILESYSTEM']),
 sandboxPolicyDigest:digest.optional(),memorySample:z.object({
  scope:z.literal('CALLER_PROCESS_AND_DESCENDANTS_NOT_FULL_EPISODE'),intervalMs:z.literal(250),samples:z.number().int().nonnegative(),
  failures:z.number().int().nonnegative(),peakResidentSumBytes:z.number().finite().nonnegative().nullable(),
  observedLimitBytes:z.literal(17179869184),hardEnforcement:z.literal(false),
 }).strict().optional(),
 supervision:z.literal('INDEPENDENT_IPC_DEADLINE_GUARDIAN').optional(),guardianPid:z.number().int().positive().optional(),childCloseObserved:z.literal(true).optional(),
}).strict();
export const NativeReceiptSchema=receipt;
const kernel=z.object({
 schema:z.literal('finnor.y5.kernel-check.v1'),exactType:z.literal(true),kernelReplay:z.literal(true),theorem:z.literal('Y5.uniform'),
 specificationDigest:digest,sourceDigest:digest,proofObjectDigest:digest,runtimeDigest:digest,importInventoryDigest:digest,
 axioms:z.array(z.string().max(128)).max(16),trustPolicyApproval:z.literal('NOT_ESTABLISHED'),
 governance:z.literal('LOCAL_SEPARATE_PROCESS_NOT_PROTECTED_CUSTODY'),native:z.array(receipt).length(3),
}).strict();
const schema=z.object({
 schema:z.literal('finnor.algorithm-theory-capsule.v1'),kind:z.literal('AlgorithmTheoryCapsule'),digest,
 specification:z.object({id:z.literal('INTEGER_ADDITIVE_BINARY_BOX_V1'),source:z.string().max(65536),digest,
  acceptance:z.literal('EXISTING_S5_SEMANTICS_DEVELOPMENT_REFINEMENT_NOT_PROTECTED_ACCEPTANCE')}).strict(),
 structure:z.object({hypothesis:z.literal('ADDITIVE_BOX_WITH_DOMINATING_SCENARIO'),lemma:z.literal('Y5.discovered_lemma'),
  nonempty:z.literal('EVERY_FINITE_INTEGER_LIST_HAS_ALL_FALSE_FEASIBLE_WITNESS'),origin:z.literal('RUNTIME_EXPRESSION_AND_PROOF_SEARCH'),newProtectedStructure:z.literal(false)}).strict(),
 expression:expressionSchema,proofPlan:plan,algorithmSource:z.string().max(65536),sourceDigest:digest,
 proofObject:z.string().min(4).max(4194304).regex(/^[A-Za-z0-9+/]*={0,2}$/),proofObjectDigest:digest,
 theorem:z.object({name:z.literal('Y5.uniform'),statement:z.string().max(256),mathematicalSizes:z.literal('ALL_FINITE_LIST_LENGTHS'),
  termination:z.literal('LEAN_STRUCTURAL_RECURSION'),quality:z.literal('EXACT_MAXIMUM_WITH_FREE_ZERO_OMITTED'),
  costModel:z.literal('ONE_COORDINATE_STEP_PER_ITEM_EXACT_INTEGER_PREDICATE_AS_PRIMITIVE'),bitOrWallTimeBound:z.literal(false)}).strict(),
 checker:kernel,
 runtime:z.object({version:z.literal('4.34.1'),archiveDigest:digest,inventoryDigest:digest,identityDigest:digest,
  profile:z.literal('NATIVE_DARWIN_ARM64_LEAN_INTERPRETER'),maximumDecisions:z.literal(128),maximumIntegerDigits:z.literal(512)}).strict(),
 reuse:z.object({definitions:z.literal(true),genericTactics:z.literal(true),successfulSuppliedFamilyProof:z.literal(false),discoveryCredit:z.literal('PUBLIC_DEVELOPMENT_ONLY_NOT_PROTECTED_DISCOVERY')}).strict(),
 search:z.object({attempts:z.array(z.object({expression:expressionSchema,stage:z.enum(['DEVELOPMENT','LOCAL_LEMMA','UNIFORM_PROOF']),
  status:z.enum(['REFUTED','REJECTED','PROVED']),counterexample:z.unknown().optional(),proofPlan:plan.optional(),native:receipt.optional()}).strict()).max(128),
  wallMs:z.number().finite().nonnegative(),completeMoney:z.null(),completeHumanSeconds:z.null(),aggregatePeakBytes:z.null()}).strict(),
 admission:z.object({status:z.literal('UNADMITTED'),protectedAdmission:z.literal(false),productionActive:z.literal(false),executionAuthorityGranted:z.literal(false)}).strict(),
}).strict();

export function parseCapsule(value:unknown):AlgorithmTheoryCapsule{
 let body:string|undefined;
 try{
  let bytes=0,nodes=0;const parents:object[]=[];
  body=JSON.stringify(value,function(_key,item:unknown){
   if(++nodes>100000)throw Error('bound');
   while(parents.length&&parents.at(-1)!==this)parents.pop();
   if(item&&typeof item==='object'){
    if(parents.includes(item)||parents.length>=64)throw Error('bound');parents.push(item);
   }
   if(typeof item==='string'){bytes+=Buffer.byteLength(item);if(bytes>8388608)throw Error('bound');}
   return item;
  });
  if(!body||Buffer.byteLength(body)>8388608)throw Error('bound');
 }catch{throw Error('Y5_CAPSULE_BOUND');}
 const parsed=schema.safeParse(JSON.parse(body));if(!parsed.success)throw Error('Y5_CAPSULE_SCHEMA');
 const c=parsed.data as AlgorithmTheoryCapsule,{digest:claimed,...unsigned}=c;
 parseExpression(c.expression);c.search.attempts.forEach(a=>parseExpression(a.expression));
 if(claimed!==jsonHash(unsigned))throw Error('Y5_CAPSULE_INTEGRITY');
 if(Buffer.from(c.proofObject,'base64').toString('base64')!==c.proofObject)throw Error('Y5_PROOF_ENCODING');
 if(c.checker.sourceDigest!==c.sourceDigest||c.checker.specificationDigest!==c.specification.digest||
  c.checker.proofObjectDigest!==c.proofObjectDigest||c.checker.runtimeDigest!==c.runtime.identityDigest||
  c.checker.importInventoryDigest!==c.runtime.inventoryDigest)throw Error('Y5_KERNEL_RECEIPT_BINDING');
 if(c.checker.axioms.some(a=>!['propext','Classical.choice','Quot.sound'].includes(a)))throw Error('Y5_UNAPPROVED_OR_UNSAFE_AXIOM');
 return c;
}

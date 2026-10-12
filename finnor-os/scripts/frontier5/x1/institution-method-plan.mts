/** Metadata-only existing-authority handoff. No signer/grant creation, service
 * mutation or independently qualified outcome is produced by this command. */
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { RefSchema,digest } from '../../../packages/capability-evolution/src/contracts';
import { createInstalledInstitutionCompilerProposal } from '../../../packages/capability-evolution/src/institution-consumer';
import { DigitalInstitutionProfile } from '../../../packages/private-equity/src/institution-program/contracts';

const args=process.argv.slice(2),option=(name:string)=>{const at=args.indexOf(name);return at<0?null:args[at+1]??null;};
if(args.some((arg,i)=>i%2===0&&!['--scope-file','--evidence'].includes(arg)))throw Error('X1_METHOD_PLAN_EXACT_ARGUMENTS_REQUIRED');
const scopeFile=option('--scope-file'),directory=option('--evidence');
if(!scopeFile||!directory||!isAbsolute(scopeFile)||!isAbsolute(directory))
  throw Error('Use --scope-file <existing-owner-scope.json> --evidence <fresh-absolute-private-directory>');
const input=z.object({tenantId:z.string().min(1),principalId:z.string().min(1),rightsRef:z.string().min(1),
  profileRef:RefSchema,validAfter:z.string().datetime({offset:true}),validUntil:z.string().datetime({offset:true})}).strict()
  .parse(JSON.parse(await readFile(scopeFile,'utf8')));
const profile=DigitalInstitutionProfile.parse(JSON.parse(await readFile(new URL('../../../../scope-frontier5/x1-institutional-programme-compiler/profile.json',import.meta.url),'utf8')));
const candidate=await createInstalledInstitutionCompilerProposal({...input,profileDigest:digest(profile)});
await mkdir(directory,{mode:0o700});
await writeFile(resolve(directory,'candidate.json'),JSON.stringify(candidate,null,2)+'\n',{flag:'wx',mode:0o600});
await writeFile(resolve(directory,'continuation.json'),JSON.stringify({
  schema:'finnor.x1.s8-method-continuation.v1',candidateRef:candidate.ref,profileDigest:candidate.profileDigest,
  runtimeDigest:candidate.runtimeDigest,commands:[
    {operation:'INSTITUTION_PROPOSE',actor:'existing authorized proposer',bodyFile:'candidate.json'},
    {operation:'INSTITUTION_REGISTER',actor:'existing independent evaluator',requires:'signed protocol with independently frozen case commitments'},
    {operation:'INSTITUTION_EVALUATE',actor:'same registered independent evaluator',requires:'actual outcomes bound to that protocol; no producer-issued PASS'},
    {operation:'INSTITUTION_ADMIT',actor:'distinct existing promoter',requires:'signed disposable-only admission referencing the actual evaluation'},
    {operation:'INSTITUTION_CURRENT',actor:'existing configured compiler consumer',requires:'signed scoped consumer policy and existing private token'},
    {operation:'INSTITUTION_CURRENT',actor:'same consumer after actual S8 service restart',expected:'same admitted candidate and original journal'},
    {operation:'INSTITUTION_REVOKE',actor:'existing promoter',requires:'exact existing admission ref; final dependent effect remains unauthorized'},
    {operation:'INSTITUTION_CURRENT',actor:'same consumer after revocation',expected:'current false and compiler currentness refusal without downgrade'},
  ],originalAuthorityEnvelope:{tenantId:input.tenantId,principalId:input.principalId,rightsRef:input.rightsRef,
    validAfter:input.validAfter,validUntil:input.validUntil,resourceEnvelope:'existing original Work/S5 parent; no replacement'},
  missingAssets:['existing signed S8 lifecycle policy/release root/journal signer',
    'existing scoped proposer/evaluator/promoter/consumer tokens and signing authority',
    'independent evaluator observations and signed outcome','signed compiler consumer configuration'],
  consumerVariables:['FINNOR_S8_INSTITUTION_CONSUMER_CONFIG','FINNOR_S8_INSTITUTION_CONSUMER_ROOT'],
  resultDestination:resolve(directory,'actual-s8-consumer-results.json'),sourceCommand:fileURLToPath(import.meta.url),
  metadataOnly:true,serviceCommandsExecuted:false,protectedQualification:false,productionActive:false,
  executionAuthorityGranted:false,keysPoliciesOrGrantsCreated:false,
},null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({status:'METADATA_ONLY_PROPOSAL_PACKET',evidence:directory,candidateRef:candidate.ref,
  keysPoliciesOrGrantsCreated:false,protectedQualification:false}));

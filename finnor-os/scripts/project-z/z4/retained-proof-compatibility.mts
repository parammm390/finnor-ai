/** Existing real proofs must keep their relation, parameters and input commitments. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
import {canonical,validateRequest,assertStatement,artifactSchema} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts';
import {nativeIdentity,runNative} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/native';
const arg=(name:string)=>process.argv[process.argv.indexOf(name)+1];
const input=arg('--input'),evidence=arg('--evidence');
if(!input||!evidence||!isAbsolute(input)||!isAbsolute(evidence))throw Error('Z4_ABSOLUTE_COMPATIBILITY_INPUTS_REQUIRED');
await mkdir(evidence,{recursive:false,mode:0o700});
const rows:Array<Record<string,unknown>>=[];
const report:Record<string,unknown>={schema:'finnor.z4.retained-proof-compatibility.v1',status:'RUNNING',rows,
 nativeOwner:'NOT_RUN',securityAdmission:'NOT_RUN',protectedAdmission:'NOT_RUN',eligibleReuseN:0};
const save=()=>writeFile(resolve(evidence,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
try{
 const fixture=JSON.parse(await readFile(input,'utf8'));
 if(fixture.schema!=='finnor.z4.public-retained-compatibility-input.v1'||fixture.cases.length!==5)
  throw Error('Z4_FIVE_RETAINED_ORIGINAL_COORDINATES_REQUIRED');
 report.identity=await nativeIdentity();
 for(const item of fixture.cases){
  const request=validateRequest(item.request),statement=assertStatement(item.candidate.statement),
   artifact=artifactSchema.parse(item.candidate.artifact);
  const limits=(cpuSeconds:number)=>({deadlineAt:new Date(Date.now()+180000).toISOString(),maxMemoryBytes:2*1024**3,cpuSeconds});
  const commitment=await runNative<{inputCommitment:string}>('commit',request,limits(10));
  if(commitment.data.inputCommitment!==statement.inputCommitment)throw Error('Z4_RETAINED_COMMITMENT_CHANGED');
  const verifier=await runNative<{status:string;parameterHash:string;planHash:string}>('verify',{statement,artifact},limits(90));
  if(verifier.data.status!=='VERIFIED_COMPUTATION_ONLY'||verifier.data.parameterHash!==artifact.parameterHash||
   verifier.data.planHash!==artifact.planHash||canonical(statement.finalState)!==canonical(item.expectedFinal))
   throw Error('Z4_RETAINED_PROOF_OR_PARAMETER_CHANGED');
  rows.push({name:item.name,status:'PASSED',inputCommitment:commitment.data.inputCommitment,
   parameterHash:artifact.parameterHash,planHash:artifact.planHash,commitMeters:commitment.meters,verifyMeters:verifier.meters});
  await save();
 }
 report.status='PASSED_RETAINED_REAL_PROOF_COMPATIBILITY_ONLY';await save();
}catch(error){report.status='FAILED';report.failure=(error as Error).message;await save();process.exitCode=1;}
console.log(JSON.stringify({status:report.status,rows:rows.length,evidence,failure:report.failure??null}));

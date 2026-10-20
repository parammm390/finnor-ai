/** Independent-checker controls over bytes retrieved from an actual installed
 * release. The altered candidates never enter installation or protected claims. */
import {readFile} from 'node:fs/promises';
import {checkBuiltApplication} from '../../packages/private-equity/src/enterprise-applications/checker';
import {runApplicationProgram,validateProgram} from '../../packages/private-equity/src/enterprise-applications/program';
import {applicationCanonical,applicationDigest,applicationBytesDigest} from '../../packages/private-equity/src/enterprise-applications/contracts';
const {specification,built}=JSON.parse(await readFile(process.argv[2]!,'utf8'));
const base=checkBuiltApplication(specification,built,runApplicationProgram);
function changed(kind:string){
 const candidate=structuredClone(built);
 if(kind==='MUTATED_INSTRUCTION')candidate.program.actions.find((a:any)=>a.id==='execute').guards[0].code=[{op:'PUSH',value:true}];
 else candidate.program.actions=candidate.program.actions.filter((a:any)=>a.id!=='execute');
 validateProgram(candidate.program);
 const asset=candidate.sources.find((a:any)=>a.path==='backend/program.json');
 asset.bytes=applicationCanonical(candidate.program);asset.digest=applicationBytesDigest(asset.bytes);
 candidate.digest=applicationDigest({program:candidate.program,sources:candidate.sources,frontend:candidate.frontend,dependencyManifest:candidate.dependencyManifest});
 return {kind,selfConsistentAssetHashes:true,programDigest:applicationDigest(candidate.program),check:checkBuiltApplication(specification,candidate,runApplicationProgram)};
}
console.log(JSON.stringify({base,controls:['MUTATED_INSTRUCTION','OMITTED_ACTION'].map(changed)}));

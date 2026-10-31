/** Emit and independently re-read installed provenance without DB/Auth imports. */
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceIdentity,codeIdentity} from '../../../packages/private-equity/src/project-z/z4-execution-proof/identity';
import {sha} from '../../../packages/epistemic-runtime/src/project-z/z4-execution-proof/contracts';

const repository=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
const lineage=JSON.parse(await readFile(resolve(repository,'z4-reconstruction-source.json'),'utf8'));
if(!/^[a-f0-9]{40}$/.test(lineage.sourceCommit)||!/^[a-f0-9]{40}$/.test(lineage.sourceTree))
 throw Error('Z4_DECLARED_SOURCE_LINEAGE_REQUIRED');
const identity=await sourceIdentity(),body=JSON.stringify({schema:'finnor.z4.installed-provenance.v1',
 sourceCommit:lineage.sourceCommit,sourceTree:lineage.sourceTree,sourceDigest:identity.digest,
 sharedPatchSha256:lineage.sharedPatchSha256,gitObjectsRequired:false,
 nativeBinarySha256:identity.native.binarySha256,nativeSourceDigest:identity.native.sourceDigest},null,2)+'\n';
const file=resolve(repository,'scope-z/phase-evidence/z4/installed-provenance.json');
await mkdir(dirname(file),{recursive:true,mode:0o700});
let previous:string|undefined;
try{previous=await readFile(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
if(previous!==undefined&&previous!==body){
 const position=process.argv.indexOf('--replace-sha256'),expected=position<0?undefined:process.argv[position+1];
 if(!expected||sha(Buffer.from(previous))!==expected)throw Error('Z4_INSTALLED_PROVENANCE_PREIMAGE_REQUIRED');
}
if(previous!==body)await writeFile(file,body,{flag:previous===undefined?'wx':'w',mode:0o600});
const observed=await codeIdentity();
if(observed.basis!=='DECLARED_ARCHIVE_IDENTITY_WITH_CURRENT_SOURCE_VERIFICATION_NOT_GIT_OBSERVATION'||
 observed.digest!==identity.digest)throw Error('Z4_INSTALLED_PROVENANCE_NOT_OBSERVED');
console.log(JSON.stringify({schema:'finnor.z4.installed-identity-observation.v1',sourceDigest:identity.digest,
 sourceCommit:observed.sourceCommit,sourceTree:observed.sourceTree,basis:observed.basis,
 provenanceFileSha256:sha(Buffer.from(body)),nativeBinarySha256:identity.native.binarySha256,
 databaseActions:0,authActions:0,nativeOwner:'NOT_RUN'}));

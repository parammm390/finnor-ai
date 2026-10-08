/** Capture generated shared outputs from an isolated proposal overlay only. */
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import openapiTS,{astToString} from 'openapi-typescript';
const [overlay,destination]=process.argv.slice(2);
if(!overlay?.startsWith('/')||!destination?.startsWith('/'))throw Error('ABSOLUTE_OVERLAY_AND_HANDOFF_REQUIRED');
const base='a72b4f402cfa1bbf51e518891db2d893b9a71aca',root=resolve(overlay);
if(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==base)
 throw Error('EXACT_C_DISPOSABLE_OVERLAY_REQUIRED');
const source=await readFile(join(root,'finnor-os/openapi.json'),'utf8'),sha=b=>createHash('sha256').update(b).digest('hex');
const client='// Generated from finnor-os/openapi.json, SHA-256 '+sha(source)+'.\n'+astToString(await openapiTS(JSON.parse(source)));
await writeFile(join(root,'src/lib/centropy/openapi-types.ts'),client);
const paths=['finnor-os/openapi.json','src/lib/centropy/openapi-types.ts','src/lib/centropy/capability-manifest.generated.json'];
const patch=execFileSync('git',['-C',root,'diff','--binary',base,'--',...paths],{maxBuffer:16777216});
const files=await Promise.all(paths.map(async path=>({path,
 preimage:sha(execFileSync('git',['-C',root,'show',base+':'+path],{maxBuffer:16777216})),
 proposed:sha(await readFile(join(root,path)))})));
await writeFile(join(destination,'shared-generated.exact-c.patch'),patch);
await writeFile(join(destination,'shared-generated-preimages.json'),JSON.stringify({
 schema:'finnor.p6.generated-shared-proposal.v1',base,files,patchDigest:sha(patch),
 status:'PROPOSED_NOT_SERIAL_OWNER_ADOPTED',order:'AFTER_SHARED_NATIVE_PROPOSAL',
 legacyIgnoredJarvisAliasGenerated:false,oldAllocationBehaviourModified:false},null,2)+'\n');
console.log(JSON.stringify({generatedFiles:paths.length,patchDigest:sha(patch)}));

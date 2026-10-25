/** Source/native identity only. Importing this module cannot open DB or Auth. */
import {readFile,realpath} from 'node:fs/promises';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {nativeIdentity} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/native';
import {sha} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/contracts';
import {runtimePath} from '../../../../epistemic-runtime/src/project-z/z4-execution-proof/runtime-paths';

const repository=runtimePath(import.meta.url,'../../../../../..','.');
const codeFiles=[
 ...['contracts','original','correspondence','native','process-groups','runtime-paths','engine'].map(p=>`finnor-os/packages/epistemic-runtime/src/project-z/z4-execution-proof/${p}.ts`),
 ...['contracts','identity','store','source','plan','api','worker','owner-consumer','operational-query','recovery-boundary'].map(p=>`finnor-os/packages/private-equity/src/project-z/z4-execution-proof/${p}.ts`),
 'finnor-os/packages/orchestration/src/project-z/z4-execution-proof/index.ts',
 'finnor-os/packages/private-equity/src/owner-context.ts','finnor-os/packages/private-equity/src/enterprise-beliefs.ts',
 'finnor-os/packages/private-equity/src/enterprise-interventions.ts','finnor-os/packages/private-equity/src/enterprise-control.ts',
 'finnor-os/packages/private-equity/src/application-semantics/allocation.ts','finnor-os/packages/private-equity/src/allocation-store.ts',
 'finnor-os/packages/authority/src/index.ts','finnor-os/apps/worker/src/queue.ts',
 'finnor-os/apps/worker/src/index.ts','finnor-os/packages/db/compute-contract.ts',
 'finnor-os/packages/shared-types/src/operational-queries.ts','finnor-os/packages/db/schema.ts',
 ...['operational-query-runtime','plugin-registry','fast-read-lane','objective-loop','objective-success'].map(p=>`finnor-os/packages/orchestration/src/${p}.ts`),
 'finnor-os/packages/orchestration/src/project-z/z0-convergence/semantics.ts',
 'finnor-os/packages/private-equity/src/project-z/z4-execution-proof/ExecutionProofPanel.tsx',
 'finnor-os/apps/api/app/api/company-brain/[operation]/route.ts','finnor-os/apps/api/app/api/queries/route.ts','finnor-os/packages/source-custody/index.cjs',
 'finnor-os/apps/api/next.config.mjs','package.json','finnor-os/package.json','package-lock.json','finnor-os/package-lock.json',
 'next.config.mjs','src/components/centropy/world/WorldWorkRecord.tsx',
 'tsconfig.json','finnor-os/tsconfig.json','finnor-os/tsconfig.base.json','finnor-os/apps/api/tsconfig.json',
 'finnor-os/apps/api/lib/auth.ts',
 'src/components/centropy/lib/api.ts','src/components/centropy/lib/use-private-request-scope.ts',
 'src/lib/centropy/capability-manifest.generated.json','src/app/api/centropy/[...path]/route.ts',
].sort();
let loadedDigest:string|undefined;
export async function sourceIdentity(){
 if(!/^v22\./.test(process.version))throw Error('Z4_NODE22_REQUIRED');
 const files=await Promise.all(codeFiles.map(async path=>({path,sha256:sha(await readFile(resolve(repository,path)))})));
 const native=await nativeIdentity(),digest=sha({files,node:process.version,native});
 if(loadedDigest&&loadedDigest!==digest)throw Error('Z4_LOADED_CODE_OR_NATIVE_CHANGED');
 loadedDigest=digest;
 return {digest,files,native,node:process.version};
}
export async function codeIdentity(){
 const identity=await sourceIdentity();
 let sourceCommit:string,sourceTree:string,basis:string;
 try{
  const top=execFileSync('git',['-C',repository,'rev-parse','--show-toplevel'],
   {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  if(await realpath(top)!==await realpath(repository))throw Error('Z4_PARENT_GIT_IS_NOT_INSTALLED_PROVENANCE');
  sourceCommit=execFileSync('git',['-C',repository,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  sourceTree=execFileSync('git',['-C',repository,'rev-parse','HEAD^{tree}'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  basis='ACTUAL_GIT_HEAD_PLUS_CURRENT_SOURCE_DIGEST';
 }catch{
  const p=JSON.parse(await readFile(resolve(repository,'scope-z/phase-evidence/z4/installed-provenance.json'),'utf8'));
  if(p.sourceDigest!==identity.digest||!/^[a-f0-9]{40}$/.test(p.sourceCommit)||!/^[a-f0-9]{40}$/.test(p.sourceTree))
   throw Error('Z4_INSTALLED_SOURCE_PROVENANCE_REQUIRED');
  ({sourceCommit,sourceTree}=p);basis='DECLARED_ARCHIVE_IDENTITY_WITH_CURRENT_SOURCE_VERIFICATION_NOT_GIT_OBSERVATION';
 }
 return {...identity,sourceCommit,sourceTree,basis};
}

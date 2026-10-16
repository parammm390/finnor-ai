import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import type {CanonicalAllocationProblem,EvidenceDependency,ExperimentRef} from '@finnor/shared-types';
import type {SolverRequest} from '../../../shared-types/src/solver-capsule';
import type {PeMutationContext} from '../types';
import {resolveDecisionWork} from '../decision-slice/adapters';
import * as enterpriseAllocation from '../enterprise-allocation';
import {assertDependencies,revisions,tx,unavailable,schemaIdentity} from '../evidence-execution/store';
import {projectSolverProblem,type SolverProjection} from './projection';
import {R8_SOURCE_PATHS,sourceIdentity} from '../../../epistemic-runtime/src/solver-synthesis/runtime';
import {hash,bytesHash,type SourcePin} from '../../../epistemic-runtime/src/solver-synthesis/contracts';

const paths=['owners.ts','capsule.ts','projection.ts','store.ts','api.ts','worker.ts','selection.ts',
 '../../../shared-types/src/solver-capsule.ts','s8/contracts.ts','s8/port.ts','s8/consumer.ts','s8/source-closure.ts',
 '../../../capability-evolution/src/lifecycle.ts','../../../capability-evolution/src/source-closure.ts',
 '../enterprise-allocation.ts','../enterprise-control.ts','../enterprise-beliefs.ts','../allocation-store.ts',
 '../decision-slice/adapters.ts','../../../epistemic-runtime/src/allocation-checker.ts',
 '../../../epistemic-runtime/src/allocation-verifier.ts','../../../epistemic-runtime/src/allocation-producer.ts',
 '../../../epistemic-runtime/src/allocation-contracts.ts','../../../epistemic-runtime/src/control-contracts.ts',
 '../../../db/compute-contract.ts','../../../db/compute-governor.ts','../../../db/migration-head.ts',
 '../../../db/migrations-bundle.ts','../../../db/migrate.ts',
 '../../../../apps/api/app/api/company-brain/[operation]/route.ts','../../../../apps/worker/src/queue.ts',
 '../../../../apps/worker/src/index.ts','../../../../package-lock.json',
].map(path=>fileURLToPath(new URL(path,import.meta.url)));
const all=[...new Set([...paths,...R8_SOURCE_PATHS])].sort();
export const ownerSourceIdentity=()=>Promise.all(all.map(async path=>({path,sha256:bytesHash(await readFile(path))})));
const loaded=ownerSourceIdentity();void loaded.catch(()=>undefined);
export async function ownerSourcesCurrent(expected?:SourcePin[]){
 const before=await loaded,current=await ownerSourceIdentity();
 if(hash(before)!==hash(current)||expected&&hash(expected)!==hash(current))throw Error('R8_LOADED_OWNER_MODULE_OR_CHECKER_CHANGED');
 return current;
}
export interface SolverOwnerBinding {
 work:Awaited<ReturnType<typeof resolveDecisionWork>>;problem:CanonicalAllocationProblem;
 projection:SolverProjection|null;unsupportedReasons:string[];dependencies:EvidenceDependency[];
 sourcePins:SourcePin[];semanticSourcePins:SourcePin[];rightsRevision:string;
 schemaDigest:string;
 inputDigest:string;ownerInputs:Array<{ref:ExperimentRef;asOf:string;rightsRevision:string}>;
}
export async function resolveSolverOwners(ctx:PeMutationContext,request:SolverRequest):Promise<SolverOwnerBinding>{
 // R4 has no public pure S5 resolver for this request. Do not fork its owner or
 // silently import the lead's shared replacement. The integrator installs the
 // preimage-bound S5 export; its absence is a concrete closed integration gate.
 type Resolver=(ctx:PeMutationContext,input:Parameters<typeof enterpriseAllocation.clearEnterprisePortfolio>[1])=>Promise<CanonicalAllocationProblem>;
 const resolve=(enterpriseAllocation as unknown as {resolveEnterpriseAllocationProblem?:Resolver}).resolveEnterpriseAllocationProblem;
 if(typeof resolve!=='function')throw Error('R8_SHARED_S5_RESOLVER_NOT_INSTALLED');
 const work=await resolveDecisionWork(ctx,request.workId),problem=await resolve(ctx,{
  mandate:request.mandate,jointModel:request.jointModel,policyRefs:request.policyRefs,resourceRefs:request.resourceRefs,
  demandBindings:request.demandBindings as CanonicalAllocationProblem['demandBindings'],
  funding:request.funding as CanonicalAllocationProblem['funding'],idempotencyKey:request.idempotencyKey,
 });
 const roots=problem.policies.flatMap(policy=>policy.bindings.beliefPins.map(pin=>pin.root));
 const links=await tx(ctx,async c=>(await c.query<{entity_type:string;entity_id:string}>(
  'SELECT entity_type,entity_id::text FROM finnor_os.work_entity_links WHERE tenant_id=$1 AND work_id=$2',
  [ctx.auth.tenantId,request.workId])).rows,true);
 if(!links.length||roots.some(root=>!links.some(link=>link.entity_type===root.entityType&&link.entity_id===root.entityId)))throw unavailable();
 const rightsRevision=String(problem.policies[0]?.bindings.beliefPins[0]?.rightsRevision??'');
 if(!rightsRevision||problem.policies.some(policy=>policy.bindings.beliefPins.some(pin=>String(pin.rightsRevision)!==rightsRevision)))throw unavailable();
 const keys=['rights:tenant','work-inputs:'+request.workId,'r8:s5-complete','r8:s6-effects',
  ...problem.policies.flatMap(policy=>policy.bindings.beliefPins.map(pin=>'r8:root:'+pin.root.entityType+':'+pin.root.entityId))];
 const dependencies=await revisions(ctx,keys),sourcePins=await ownerSourcesCurrent(),semanticSourcePins=await sourceIdentity(),schemaDigest=await schemaIdentity(ctx);
 const recognized=projectSolverProblem(problem),refs=[problem.mandate.ref,problem.jointModel.ref,
  ...problem.policies.map(p=>p.ref),...problem.resources.map(r=>r.ref),...problem.jointModel.sourceRefs];
 const ownerInputs=refs.map(ref=>({ref,asOf:problem.knowledgeAt,rightsRevision}));
 // knowledgeAt is a fresh owner observation, not decision input identity.
 const {ref,knowledgeAt,...stableProblem}=problem;
 return {work,problem,projection:recognized.projection,unsupportedReasons:recognized.reasons,dependencies,sourcePins,
  semanticSourcePins,schemaDigest,rightsRevision,ownerInputs,inputDigest:hash({work,problem:stableProblem,rightsRevision,schemaDigest})};
}
export async function assertSolverOwnersCurrent(ctx:PeMutationContext,request:SolverRequest,binding:SolverOwnerBinding){
 await ownerSourcesCurrent(binding.sourcePins);await assertDependencies(ctx,binding.dependencies);
 const current=await resolveSolverOwners(ctx,request);
 if(current.work.inputId!==binding.work.inputId||current.inputDigest!==binding.inputDigest||
  hash(current.semanticSourcePins)!==hash(binding.semanticSourcePins))throw Error('R8_WORK_SOURCE_RIGHTS_OR_RESOURCE_CUT_CHANGED');
 return current;
}

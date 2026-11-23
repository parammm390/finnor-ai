#!/usr/bin/env python3
"""Freeze exact shared-file pre/postimages ONLY inside the Z5 owned evidence.
No shared file, coordinator gate, DB, migration, tenant, Auth or listener write.
The coordinator independently applies/rebases these proposals."""
import difflib
import hashlib
import json
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[4]
source, destination = map(pathlib.Path, sys.argv[1:3])
source, destination = source.resolve(), destination.resolve()
if not destination.is_relative_to(ROOT / "scope-z/phase-evidence/z5/integration"):
    raise RuntimeError("OWNED_PHASE_INTEGRATION_DESTINATION_REQUIRED")
destination.mkdir(parents=True, exist_ok=False)
changes = {}
sha = lambda b: hashlib.sha256(b).hexdigest()

def edit(relative, before, after):
    if relative not in changes:
        original = (source / relative).read_text()
        changes[relative] = [original, original]
    value = changes[relative][1]
    if value.count(before) != 1:
        raise RuntimeError(f"EXACT_SINGLE_SHARED_SEAM_REQUIRED:{relative}:{before[:100]}")
    changes[relative][1] = value.replace(before, after, 1)

api = "finnor-os/apps/api/app/api/company-brain/[operation]/route.ts"
edit(api, 'export const runtime = "nodejs";', '''import {Z5_OPERATIONS,handleInstitutionLinkOperation,readInstitutionBody} from '@finnor/private-equity/src/project-z/z5-institution-linker/api';
import {intakeInstitutionComposition} from '../../../../../../packages/orchestration/src/project-z/z5-institution-linker/intake';
export const runtime = "nodejs";''')
edit(api, "  try {const route=await params;", """  try {const route=await params;
    if((Z5_OPERATIONS as readonly string[]).includes(route.operation)){
      const auth=await requireContext(req);
      if(!auth.deliverySession||Date.parse(auth.deliverySession.expiresAt)<=Date.now())
        return response({code:'Z5_REAL_AUTHENTICATED_OWNER_SESSION_REQUIRED'},401);
      try{
        const body=await readInstitutionBody(req);
        const result=route.operation==='institution-link-submit'
          ?await intakeInstitutionComposition(auth,body):await handleInstitutionLinkOperation({auth},route.operation,body);
        return response(result.body,result.status);
      }catch(error){
        const code=error instanceof Error&&/^Z5_[A-Z0-9_]+$/.test(error.message)?error.message:'Z5_INVALID_BOUNDED_JSON';
        return response({code,error:'The bounded original-owner request was refused'},/DEADLINE/.test(code)?408:/BOUND/.test(code)?413:400);
      }
    }""")

registry = "finnor-os/packages/db/compute-contract.ts"
edit(registry, "export const PRODUCTION_JOB_CONTRACTS = {", """export const PRODUCTION_JOB_CONTRACTS = {
  link_institution_components_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "Z5 exact fixed coupled product, independent original-semantics check and S4/S8 declared-contract planning under the original Work and S5 allowance; all old S6 liabilities retained, no effects or protected admission.", {leaseRecovery:"immediate_after_expiry"}),""")
worker = "finnor-os/apps/worker/src/index.ts"
edit(worker, "export function createWorker(): JobQueue {", """import {linkInstitutionComponentsJob} from '../../../packages/private-equity/src/project-z/z5-institution-linker/worker';
export function createWorker(): JobQueue {""")
edit(worker, "  const queue = new JobQueue();", """  const queue = new JobQueue();
  queue.register('link_institution_components_v1',linkInstitutionComponentsJob,PRODUCTION_JOB_CONTRACTS.link_institution_components_v1);""")

s4 = "finnor-os/packages/private-equity/src/enterprise-control.ts"
edit(s4, "export async function readEnterpriseContingentHandoffPreparation(ctx:PeMutationContext,value:unknown):",
     "export async function readEnterpriseContingentHandoffPreparation(ctx:PeMutationContext,value:unknown,options:{originalBeforeComposition?:boolean}={}):")
edit(s4, " await readEnterpriseContingentPolicy(ctx,preparation.handoff.policyRef);",
""" if(options.originalBeforeComposition&&Object.prototype.hasOwnProperty.call(preparation,'compositionContract'))throw Error('Z5_ORIGINAL_PREPARATION_MUST_PRECEDE_COMPOSITION_SELECTION');
 await readEnterpriseContingentPolicy(ctx,preparation.handoff.policyRef);""")
edit(s4, " const plannedConsumptionKey=allocationRef&&resolvedAllocation&&decision.status==='POLICY_AVAILABLE'?",
""" const compositionContract=await (await import('./project-z/z5-institution-linker/consumer')).currentCompositionForHandoff(ctx,policy.ref,allocationRef??undefined);
 const plannedConsumptionKey=allocationRef&&resolvedAllocation&&decision.status==='POLICY_AVAILABLE'?""")
edit(s4, "  ...(input.confidentialGuard!==undefined?{confidentialGuard:input.confidentialGuard}:{})},digest=epistemicHash(preparation);",
"""  ...(compositionContract?{compositionContract}:{}),
  ...(input.confidentialGuard!==undefined?{confidentialGuard:input.confidentialGuard}:{})},digest=epistemicHash(preparation);""")
edit(s4, " await saveArtifact(ctx,'handoff-preparations',digest,preparation);",
""" await saveArtifact(ctx,'handoff-preparations',digest,preparation);
 if(compositionContract)await (await import('./project-z/z5-institution-linker/consumer')).recordCompositionHandoffConsumed(ctx,compositionContract,preparationRef);""")
edit(s4, "qualification:'PREPARED_NOT_CONSUMED_NOT_PROTECTED';confidentialGuard?:unknown}>",
     "qualification:'PREPARED_NOT_CONSUMED_NOT_PROTECTED';confidentialGuard?:unknown;compositionContract?:unknown}>")
edit(s4, " return immutableControl(preparation);",
""" if(preparation.compositionContract)await (await import('./project-z/z5-institution-linker/consumer')).assertCompositionHandoffCurrent(ctx,preparation.compositionContract,preparation.handoff.policyRef,preparation.handoff.allocationRef);
 return immutableControl(preparation);""")
edit(s4, "/** Exact current owner contexts. Nothing is cached across authenticated reads. */", """type InstitutionCompositionPlanBody={
 schema:'finnor.s4.institution-composition-plan.v1';tenantId:string;principalId:string;workId:string;rightsRef:string;
 policyRef:ExperimentRef;allocationRef:ExperimentRef;compositionContract:NonNullable<Awaited<ReturnType<typeof import('./project-z/z5-institution-linker/consumer').currentCompositionForHandoff>>>;
 planningCostRef:ExperimentRef;qualification:'EXACT_DECLARED_CONTRACT_PLANNING_ONLY_OLD_UNKNOWN_RETAINED';
 executionAuthorityGranted:false;protectedAdmission:false;
};
/** Actual S4 integration/replacement planning, including while an old S6
 * liability is UNKNOWN. This is deliberately NOT chooseBranch or a dispatch. */
export async function prepareEnterpriseInstitutionCompositionPlan(ctx:PeMutationContext,input:{policyRef:unknown;allocationRef:unknown}){
 const policy=await readEnterpriseContingentPolicy(ctx,input.policyRef),allocationRef=ExperimentRefSchema.parse(input.allocationRef),
  consumer=await import('./project-z/z5-institution-linker/consumer'),
  compositionContract=await consumer.currentCompositionForHandoff(ctx,policy.ref,allocationRef);
 if(!compositionContract)throw unavailable();
 const planningCostRef=await consumer.beginCompositionPlanning(ctx,compositionContract);
 const body:InstitutionCompositionPlanBody={schema:'finnor.s4.institution-composition-plan.v1',tenantId:ctx.auth.tenantId,
  principalId:actor(ctx),workId:compositionContract.workId,rightsRef:policy.mandate.rightsRef,policyRef:policy.ref,allocationRef,
  compositionContract,planningCostRef,qualification:'EXACT_DECLARED_CONTRACT_PLANNING_ONLY_OLD_UNKNOWN_RETAINED',
  executionAuthorityGranted:false,protectedAdmission:false},digest=epistemicHash(body),
  ref:ExperimentRef={owner:'S4',id:'contingent-institution-plan:'+digest,version:'z5-s4-composition-plan-v1',contentDigest:digest},
  plan=immutableControl({...body,ref});
 await saveArtifact(ctx,'institution-composition-plans',digest,plan);
 await consumer.recordCompositionPlanConsumed(ctx,compositionContract,ref);
 return plan;
}
/** Immutable producer-byte reader used by S4's real consumption recording.
 * It does not call the composition checker, avoiding recursive owner inspection. */
export async function readEnterpriseInstitutionCompositionPlanByRef(ctx:PeMutationContext,value:unknown):Promise<InstitutionCompositionPlanBody&{ref:ExperimentRef}>{
 const ref=ExperimentRefSchema.parse(value);
 if(ref.owner!=='S4'||ref.version!=='z5-s4-composition-plan-v1'||ref.id!=='contingent-institution-plan:'+ref.contentDigest)throw unavailable();
 const plan=await readArtifact(ctx,'institution-composition-plans',ref.contentDigest),{ref:stored,...body}=plan;
 if(body.schema!=='finnor.s4.institution-composition-plan.v1'||body.tenantId!==ctx.auth.tenantId||body.principalId!==actor(ctx)
  ||epistemicHash(body)!==ref.contentDigest||epistemicHash(stored)!==epistemicHash(ref)
  ||body.executionAuthorityGranted!==false||body.protectedAdmission!==false)throw unavailable();
 await readEnterpriseContingentPolicy(ctx,body.policyRef);
 return immutableControl(plan);
}

/** Exact current owner contexts. Nothing is cached across authenticated reads. */""")
policies = "finnor-os/apps/api/app/api/policies/[operation]/route.ts"
edit(policies, "export const runtime='nodejs';", """import {prepareEnterpriseInstitutionCompositionPlan} from '@finnor/private-equity/src/enterprise-control';
export const runtime='nodejs';""")
edit(policies, " case 'handoff':return response(await prepareEnterpriseContingentHandoff(ctx,handoff.parse(body)));",
""" case 'composition-plan':{
  try{return response(await prepareEnterpriseInstitutionCompositionPlan(ctx,z.object({policyRef:ExperimentRefSchema,allocationRef:ExperimentRefSchema}).strict().parse(body)));}
  catch(error){
   if(!(error instanceof Error)||!/^Z5_[A-Z0-9_]{1,155}$/.test(error.message))throw error;
   const code=error.message;
   return response({code,error:'The original permitted conditional contract is unavailable',protectedAdmission:false,
    executionAuthorityGranted:false,oldExposureRetained:true},/IDEMPOTENCY|STALE|CURRENT|CHANGED|FENCED|EXHAUSTED/.test(code)?409:403);
  }
 }
 case 'handoff':return response(await prepareEnterpriseContingentHandoff(ctx,handoff.parse(body)));""")

s8 = "finnor-os/packages/capability-evolution/src/lifecycle.ts"
edit(s8, "                await this.checkpoint(prior);\n                return prior.result;", """                if(input.operation==='Z5_COMPOSITION_ADMIT'){
                    this.role(a,'CONSUMER');this.scope(input.body);
                    if(this.policy.domain!=='DISPOSABLE_TEST_AUTHORITY')fault('S8_Z5_ORDINARY_DOMAIN_ONLY',403);
                    await CapabilityEvolution.sources(this.policy.sourcePins);
                    const owner=await import('../../private-equity/src/project-z/z5-institution-linker/native-s8-owner');
                    await owner.currentInstitutionFromOriginalS8({...this.policy,lifecyclePolicyDigest:digest(this.policy)},
                        {...input.body,physical:undefined,nativeReference:prior.result.nativeReference});
                }
                await this.checkpoint(prior);
                return prior.result;""")
edit(s8, "            const b = input.body;\n            let result: any, journalOperation = input.operation;", """            const b = input.body;
            if(input.operation==='Z5_COMPOSITION_ADMIT'||input.operation==='Z5_COMPOSITION_CURRENT'){
                this.role(a,'CONSUMER');this.scope(b);
                if(this.policy.domain!=='DISPOSABLE_TEST_AUTHORITY')fault('S8_Z5_ORDINARY_DOMAIN_ONLY',403);
                const owner=await import('../../private-equity/src/project-z/z5-institution-linker/native-s8-owner'),
                    authority={...this.policy,lifecyclePolicyDigest:digest(this.policy)};
                if(input.operation==='Z5_COMPOSITION_CURRENT')return owner.currentInstitutionFromOriginalS8(authority,b);
                const assertion=await owner.evaluateInstitutionFromOriginalS8(authority,b),
                    committed=await this.commitReference('z5-institution-composition-check',assertion),
                    answer={assertion,nativeReference:committed.ref};
                await this.persist({requestId:input.requestId,requestDigest,actorId:a.id,operation:input.operation,body:b,result:answer});
                return answer;
            }
            let result: any, journalOperation = input.operation;""")

world = "src/components/centropy/world/WorldWorkRecord.tsx"
edit(world, 'import { usePrivateRequestScope } from "../lib/use-private-request-scope"',
'''import { usePrivateRequestScope } from "../lib/use-private-request-scope"
import { InstitutionCompositionPanel } from "./InstitutionCompositionPanel"''')
edit(world, '      {root ? <ConfidentialComputationPanel key={workId} root={root} workId={workId} /> : null}',
'''      {root ? <ConfidentialComputationPanel key={workId} root={root} workId={workId} /> : null}
      {root ? <InstitutionCompositionPanel key={`composition:${scope.key}`} root={root} workId={workId} /> : null}''')
panel = "src/components/centropy/world/InstitutionCompositionPanel.tsx"
if (source / panel).exists():
    raise RuntimeError("NEW_Z5_MOUNT_PREIMAGE_MUST_BE_ABSENT")
changes[panel] = [None, (ROOT / "scope-z/phase-evidence/z5/integration/templates/InstitutionCompositionPanel.tsx").read_text()]

catalogue = "scripts/centropy/generate-capability-manifest.mjs"
edit(catalogue, '  ["InteractionOperations", "interaction-synthesis/api.ts"],',
'''  ["InteractionOperations", "interaction-synthesis/api.ts"],
  ["Z5_OPERATIONS", "project-z/z5-institution-linker/contracts.ts"],''')
edit(catalogue, '  "confidential-read", "confidential-list",',
'''  "confidential-read", "confidential-list",
  "institution-link-read", "institution-link-projection",''')

openapi = "finnor-os/scripts/generate-openapi.ts"
edit(openapi, 'import {InteractionOperationSchemas,InteractionOperations} from "../packages/private-equity/src/interaction-synthesis/api";',
'''import {InteractionOperationSchemas,InteractionOperations} from "../packages/private-equity/src/interaction-synthesis/api";
import {Z5_OPERATIONS,Z5_SCHEMAS} from "../packages/private-equity/src/project-z/z5-institution-linker/contracts";''')
edit(openapi, ' ...Object.entries(InteractionOperationSchemas).map(([name,schema])=>[name,applicationSchema(schema)]),',
''' ...Object.entries(InteractionOperationSchemas).map(([name,schema])=>[name,applicationSchema(schema)]),
 ...Object.entries(Z5_SCHEMAS).map(([name,schema])=>[name,applicationSchema(schema)]),''')
edit(openapi, 'const document = {', '''(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...Z5_OPERATIONS);
for(const operation of Z5_OPERATIONS)Object.assign(paths,{["/api/company-brain/"+operation]:{post:{
 security:secured,requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/"+operation}}}},
 responses:{"200":{description:"Exact current original Work, declared fixed-kernel contract, original S8 admission or retained failure. Not protected, production, financial efficacy or effect authority."},
 "202":{description:"Same original Work accepted into the actual bounded native queue, not completion."},
 "400":{description:"Strict bounded original-owner request rejected."},"401":{description:"Genuine owner bearer required before body IO."},
 "403":{description:"Original rights, exact existing owner contract or ordinary disposable profile absent."},
 "408":{description:"Bounded authenticated body deadline."},"409":{description:"Original live cut, source, rights, reservation, cumulative resources, admission or idempotency changed."},
 "413":{description:"Input, retained bytes, episode or process bound."},"503":{description:"Pinned native checker, capacity or original S8 custody unavailable."}}
}}});
Object.assign(paths,{"/api/policies/composition-plan":{post:{security:secured,
 requestBody:json(z.object({policyRef:ExperimentRefSchema,allocationRef:ExperimentRefSchema}).strict()),
 responses:{"200":{description:"Original S4 immutable integration/replacement plan consumed the current conditional contract, retaining original S6 UNKNOWN and S5 liabilities. Not a new control choice or dispatch."},
 "403":{description:"Genuine original owner required."},"409":{description:"Current S4/S5/S6/S8 source or original remaining planning allowance unavailable."}}}}});

const document = {''')
# ExperimentRefSchema is already in the generator's epistemic-runtime import.
if "ExperimentRefSchema" not in changes[openapi][0]:
    edit(openapi, "import { z } from \"zod\";", 'import { z } from "zod";\nimport {ExperimentRefSchema} from "@finnor/epistemic-runtime";')

build = "finnor-os/apps/api/next.config.mjs"
edit(build, '      "../../scripts/r4/requirements.lock",',
'''      "../../scripts/r4/requirements.lock",
      "../../scripts/project-z/z5/**/*.{mjs,ts,py}",
      "../../../scope-z/phase-evidence/z5/reconstruction/source-manifest.json",''')

entries, patch = [], []
for relative, (before, after) in sorted(changes.items()):
    for kind, value in [("preimages", before), ("postimages", after)]:
        if value is not None:
            target = destination / kind / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(value)
    delta = "".join(difflib.unified_diff((before or "").splitlines(keepends=True), after.splitlines(keepends=True),
        fromfile="a/" + relative if before is not None else "/dev/null", tofile="b/" + relative))
    header = "diff --git a/" + relative + " b/" + relative + "\n"
    if before is None:
        header += "new file mode 100644\n"
    patch.append(header + delta)
    entries.append({"path": relative, "preimageSha256": sha(before.encode()) if before is not None else None,
        "postimageSha256": sha(after.encode()), "postimage": str((destination / "postimages" / relative).relative_to(ROOT)),
        "preimage": str((destination / "preimages" / relative).relative_to(ROOT)) if before is not None else None,
        "mode": "100644"})
patch_bytes = "".join(patch).encode()
(destination / "shared.patch").write_bytes(patch_bytes)
schema_path = "finnor-os/packages/private-equity/src/project-z/z5-institution-linker/schema.sql"
manifest = {
    "schema": "finnor.z5.exact-shared-integration-request.v1", "phase": "Z5",
    "productLock": "61d9881ca8059d24d057d1e00d5436ef2059de7889ccd1fd2f92a630075bcebf",
    "sourceRepositoryReadOnly": str(source), "sourceHead": subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip(),
    "patchSha256": sha(patch_bytes), "files": entries,
    "applied": False, "coordinatorOwned": True, "requiresAllExactPreimagesBeforeAnyWrite": True,
    "newSymbols": ["Z5_OPERATIONS/v1", "link_institution_components_v1/protocol1", "prepareEnterpriseInstitutionCompositionPlan/v1",
        "readEnterpriseInstitutionCompositionPlanByRef/v1", "Z5_COMPOSITION_ADMIT/v1", "Z5_COMPOSITION_CURRENT/v1", "InstitutionCompositionPanel/v1"],
    "compatibility": "Absent ordinary Z5 profile/head preserves old S4 behavior; existing immutable preparations remain readable. No authority broadening or retroactive discharge.",
    "failureModel": "scope-z/phase-evidence/z5/failure-model.md",
    "migration": {"body": schema_path, "sha256": sha((ROOT / schema_path).read_bytes()),
        "assignedMigrationName": None, "sqlExecuted": False,
        "coordinatorMustAssignOrderHeadAndRegenerateBundle": True,
        "currentPreimages": {p: sha((source / p).read_bytes()) for p in [
            "finnor-os/packages/db/migrate.ts", "finnor-os/packages/db/migration-head.ts",
            "finnor-os/packages/db/migrations-bundle.ts"]}},
    "remainingObligations": ["COORDINATOR_ACCEPT_OR_EXACTLY_REBASE_SHARED_FILES",
        "ASSIGN_REAL_MIGRATION_NAME_HEAD_AND_BUNDLE_ONLY_WITH_AUTHORITY",
        "REGENERATE_CANONICAL_OPENAPI_MANIFEST_CLIENT_FORMS_COVERAGE_IN_COMBINED_SOURCE",
        "RUN_COMBINED_SOURCE_FULL_GRAPHS_BUILD_AND_GUARDED_NATIVE_E2E_WHEN_SEPARATELY_AUTHORIZED"],
    "externalAuthorityCreated": False, "productionActivated": False,
}
(destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"files": len(entries), "patchSha256": manifest["patchSha256"], "applied": False, "destination": str(destination)}))

"""Create review-only exact-preimage owner patches. Never writes shared owners."""
import difflib
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[3]
OUT = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) == 2 else ROOT / "scope-postz/w1-economic-orchestration/native/integration-proposals"
ALLOWED = ROOT / "scope-postz/w1-economic-orchestration/native"
assert OUT.is_relative_to(ALLOWED) and not OUT.exists(), "New lane-owned proposal directory required"
changes = {}


def revise(path, old, new):
    if path not in changes:
        original = (ROOT / path).read_text()
        changes[path] = [original, original]
    original, current = changes[path]
    assert current.count(old) == 1, f"Exact unique proposal anchor absent: {path}: {old[:100]!r}"
    changes[path] = [original, current.replace(old, new, 1)]


def add(path, body):
    assert not (ROOT / path).exists() and path not in changes, f"New shared path already exists: {path}"
    changes[path] = [None, body]


PE = "finnor-os/packages/private-equity/src/"
P2 = PE + "compute-search/"
revise(P2 + "contracts.ts", "import {z} from 'zod';",
       "import {z} from 'zod';\nimport {EconomicOrchestrationOptionsSchema} from '../economic-orchestration/contracts';")
revise(P2 + "contracts.ts", " deliberation:z.object(", " orchestration:EconomicOrchestrationOptionsSchema.optional(),\n deliberation:z.object(")
revise(P2 + "contracts.ts", "methodOwner:z.enum(['P2','M2'])", "methodOwner:z.enum(['P2','M2','W1'])")
revise(P2 + "contracts.ts", "|'CONTROL_M2';", "|'CONTROL_M2'|'CONTROL_W1';")
revise(P2 + "contracts.ts", " deliberationPolicyRef?:ExperimentRef;", " deliberationPolicyRef?:ExperimentRef;\n orchestrationPolicyRef?:ExperimentRef;")

for filename in ["api.ts", "store.ts"]:
    anchor = "import {validateDeliberationBinding} from '../deliberation/store';" if filename == "api.ts" else "import {buildPolicy,persistPolicy,validateDeliberationBinding} from '../deliberation/store';"
    revise(P2 + filename, anchor, anchor + "\nimport {validateEconomicBinding} from '../economic-orchestration/currentness';")
revise(P2 + "api.ts", "   await validateDeliberationBinding(ctx,q,request);",
       "   await validateDeliberationBinding(ctx,q,request);await validateEconomicBinding(ctx,q,request);")
revise(P2 + "store.ts", " await validateDeliberationBinding(ctx,q,s.request);",
       " await validateDeliberationBinding(ctx,q,s.request);await validateEconomicBinding(ctx,q,s.request);")
revise(P2 + "api.ts", "(s.request.deliberation?'M2':'P2')!==input.methodOwner",
       "(s.request.orchestration?'W1':s.request.deliberation?'M2':'P2')!==input.methodOwner")
revise(P2 + "api.ts", "    if(locked.request.deliberation){", "    if(locked.request.deliberation||locked.request.orchestration){")
revise(P2 + "api.ts", "j.protocol_version=2\n", "j.protocol_version=CASE WHEN $5::boolean THEN 3 ELSE 2 END\n")
revise(P2 + "api.ts", "ORDER BY u.id,j.run_at,j.id FOR UPDATE OF u`,[s.tenant_id,s.principal_id,s.id,locked.generation]",
       "ORDER BY u.id,j.run_at,j.id FOR UPDATE OF u`,[s.tenant_id,s.principal_id,s.id,locked.generation,!!locked.request.orchestration]")
revise(P2 + "api.ts", "await append(ctx,locked,'M2_PRE_ADMISSION_DELIVERY_RECONCILED',",
       "await append(ctx,locked,locked.request.orchestration?'W1_PRE_ADMISSION_DELIVERY_RECONCILED':'M2_PRE_ADMISSION_DELIVERY_RECONCILED',")
revise(P2 + "api.ts", "CASE WHEN kind='CONTROL_M2' THEN 32 ELSE 2 END",
       "CASE WHEN kind='CONTROL_M2' THEN 32 WHEN kind='CONTROL_W1' THEN 1 ELSE 2 END")
revise(P2 + "owners.ts", "!!r.deliberation);", "!!(r.deliberation||r.orchestration));")
revise(P2 + "owners.ts", "if(s.request.deliberation&&stable(deriveEnterpriseDeliberationConversion(policy))",
       "if((s.request.deliberation||s.request.orchestration)&&stable(deriveEnterpriseDeliberationConversion(policy))")

revise(P2 + "controller.ts", "import {randomUUID} from 'node:crypto';",
       "import {randomUUID} from 'node:crypto';\nimport {replanEconomicOrchestrationTx} from '../economic-orchestration/controller';")
revise(P2 + "controller.ts", " if(frontier.some(u=>u.status==='UNKNOWN')){",
       " if(s.request.orchestration){await replanEconomicOrchestrationTx(ctx,s,q,c);}\n else if(frontier.some(u=>u.status==='UNKNOWN')){")
revise(P2 + "store.ts", "import {P2_VERSION} from './contracts';",
       "import {P2_VERSION} from './contracts';\nimport {latestPublishedEconomicCapsuleTx} from '../economic-orchestration/capsules';\nimport {W1_NATIVE_VERSION} from '../economic-orchestration/contracts';")
revise(P2 + "store.ts", "elapsedMs:a.body.elapsedMs??null,costUSD:null,receiptDigest:",
       "elapsedMs:a.body.elapsedMs??null,...(a.body.w1Meter?{w1Meter:a.body.w1Meter}:{}),costUSD:null,receiptDigest:")
revise(P2 + "store.ts", " const planId=randomUUID(),policy=",
       """ if(s.request.orchestration&&s.context&&!terminal){
  const capsule=await latestPublishedEconomicCapsuleTx(ctx,s,c);
  if(capsule)plan.orchestrationPolicyRef={owner:'W1',id:capsule.id,version:W1_NATIVE_VERSION,contentDigest:sha(capsule)};
  plan.topology={owner:'W1',strategy:'EMPIRICAL_FULL_HISTORY_CONTINUATION_WITH_ORIGINAL_NATIVE_FALLBACK',
   maxParallel:s.request.limits.maxParallel,active:active.length,capsuleDigest:capsule?sha(capsule):null,
   proposalStatus:capsule?.proposal.status??'PENDING_OR_BYPASS',independence:'COMMON_PREMISE_NOT_INDEPENDENT_VOTES',
   economicBenefit:null,completeCatalogueOptimalityQualified:false,protectedAdmission:false};
  plan.qualifications.push('W1_MODEL_RELATIVE_NATIVE_POLICY_NOT_FIELD_OR_PROTECTED_QUALIFICATION',
   'W1_UNIDENTIFIED_TREATMENTS_AND_CHILD_USAGE_REMAIN_UNQUALIFIED');
 }
 const planId=randomUUID(),policy=""")

revise(P2 + "admission.ts", "import {chargeOriginalNativeGrant} from './native-grant';",
       "import {chargeOriginalNativeGrant} from './native-grant';\nimport {assertEconomicUnitBoundaryTx,economicAttemptBindingTx} from '../economic-orchestration/currentness';\nimport {W1_NATIVE_LIMITS} from '../economic-orchestration/contracts';")
revise(P2 + "admission.ts", "  const perUnitBound=u.kind==='CONTROL_M2'",
       "  const perUnitBound=u.kind==='CONTROL_W1'?1:u.kind==='CONTROL_M2'")
revise(P2 + "admission.ts", "  await assertProgramCurrent(ctx,q,c,true);",
       """  if(locked.request.orchestration&&await assertEconomicUnitBoundaryTx(ctx,locked,q,u,'CLAIM',c,x.jobId)!=='CURRENT')return {w1Superseded:true as const};
  await assertProgramCurrent(ctx,q,c,true);""")
revise(P2 + "admission.ts", "  const id=randomUUID(),body={unitId:u.id,",
       "  const w1Assignment=locked.request.orchestration?await economicAttemptBindingTx(ctx,locked,u,c):{};\n  const id=randomUUID(),body={...w1Assignment,unitId:u.id,")
revise(P2 + "admission.ts", "originalEpisode:q.episode_id,steps,recovery:",
       "originalEpisode:q.episode_id,steps,...(locked.request.orchestration?{w1ResourceScope:{parentStepUnit:'P1_NATIVE_LOGICAL_OPERATOR_UNITS_NOT_MACHINE_INSTRUCTIONS',controlStepReservation:W1_NATIVE_LIMITS.controllerSteps,kernelStepBoundPerKernelCall:W1_NATIVE_LIMITS.kernelSteps,wholePhysicalInvocationChargedNativeAttempts:1}}:{}),recovery:")

revise(P2 + "worker.ts", "import {env as runtimeEnvironment} from 'node:process';",
       """import {env as runtimeEnvironment} from 'node:process';
import {executeEconomicControl} from '../economic-orchestration/capsules';
import {beginNativeMeter} from '../economic-orchestration/meter';
import {economicEpisodeDeadlineTx} from '../economic-orchestration/snapshot';
import {W1_NATIVE_LIMITS,W1_NATIVE_VERSION} from '../economic-orchestration/contracts';
import {assertEconomicUnitBoundaryTx} from '../economic-orchestration/currentness';
import {issueEconomicOrchestrationDevelopmentCheckTx} from '../../../capability-evolution/src/economic-orchestration-port';""")
revise(P2 + "worker.ts", "![1,2].includes(x.protocolVersion)", "![1,2,3].includes(x.protocolVersion)")
revise(P2 + "worker.ts", " if(x.protocolVersion===2){", " if(x.protocolVersion===2||x.protocolVersion===3){")
revise(P2 + "worker.ts", "x.protocolVersion!==(s.request.deliberation?2:1)",
       "x.protocolVersion!==(s.request.orchestration?3:s.request.deliberation?2:1)")
revise(P2 + "worker.ts", " const started=performance.now();let physicalCompleted=",
       " const started=performance.now(),finishW1Meter=s.request.orchestration?beginNativeMeter():null;let physicalCompleted=")
revise(P2 + "worker.ts", "  const q=await currentSearch(ctx,s);",
       """  if(s.request.orchestration){
   const boundary=await tx(ctx,async c=>{
    const locked=await searchRow(ctx,s.id,c,true),parent=await requestRow(ctx,s.program_id,c);
    if(locked.generation!==payload.generation||locked.status!=='RUNNING')return 'RESCHEDULED';
    const live=(await units(ctx,locked,c)).find(row=>row.id===u!.id);if(!live)return 'RESCHEDULED';
    return assertEconomicUnitBoundaryTx(ctx,locked,parent,live,'CLAIM',c,x.jobId);
   });if(boundary!=='CURRENT')return;
  }
  const q=await currentSearch(ctx,s);""")
revise(P2 + "worker.ts", "attempt=await admit(ctx,s,u,x,steps,endpoint,inputTokens);",
       "const admission=await admit(ctx,s,u,x,steps,endpoint,inputTokens);if('w1Superseded' in admission)return;attempt=admission;")
revise(P2 + "worker.ts", "  const originalDeadline=Math.min(deliveryDeadline??Infinity,Date.parse(q.proposed.bounds.deadlineAt));",
       "  const originalDeadline=Math.min(deliveryDeadline??Infinity,Date.parse(q.proposed.bounds.deadlineAt),s.request.orchestration?await tx(ctx,c=>economicEpisodeDeadlineTx(ctx,s,q,c)):Infinity);")
revise(P2 + "worker.ts", "const steps=u.kind==='CONTROL_M2'?256:",
       "const steps=u.kind==='CONTROL_W1'?W1_NATIVE_LIMITS.controllerSteps:u.kind==='CONTROL_M2'?256:")
revise(P2 + "worker.ts", "  if(u.kind==='CONTROL_M2'){\n",
       """  if(s.request.orchestration)await tx(ctx,c=>assertEconomicUnitBoundaryTx(ctx,s,q,u!,'USE',c));
  if(u.kind==='CONTROL_W1'){
   if(!s.request.orchestration||u.body.moduleId!==W1_NATIVE_VERSION)throw Error('W1_EXACT_NATIVE_CONTROL_UNIT_REQUIRED');
   try{result=await executeEconomicControl(ctx,s,u,q,attempt,x);}finally{physicalCompleted=true;}
  }else if(u.kind==='CONTROL_M2'){
""")
revise(P2 + "worker.ts", "retryAfterMs,s.request.deliberation?2:1]);",
       "retryAfterMs,s.request.orchestration?3:s.request.deliberation?2:1]);")
revise(P2 + "worker.ts", "   if(u!.kind==='MODEL_REFINE'&&!result.duplicate){",
       """   if(locked.request.orchestration){
    await assertEconomicUnitBoundaryTx(ctx,locked,qNow,current,'PUBLISH',c);
    if(u!.kind==='CONTROL_W1'&&result.w1ProposalStatus==='CHECKED_POLICY'){
     const checked=await issueEconomicOrchestrationDevelopmentCheckTx(ctx,locked,qNow,result.w1CapsuleDigest,c);
     result={...result,w1DevelopmentCheckDigest:sha(checked)};
    }
   }
   if(u!.kind==='MODEL_REFINE'&&!result.duplicate){""")
revise(P2 + "worker.ts", "elapsedMs:performance.now()-started,costUSD:null},c);",
       "elapsedMs:performance.now()-started,...(finishW1Meter?{w1Meter:finishW1Meter()}:{}),costUSD:null},c);")
revise(P2 + "worker.ts", "costUSD:null,liabilityRetained:true},c);",
       "...(finishW1Meter?{w1Meter:finishW1Meter()}:{}),costUSD:null,liabilityRetained:true},c);")

revise(PE + "program-synthesis/worker.ts", "import {advanceProgramSearch,invalidateUnstartedProgramSearch} from '../compute-search/controller';",
       "import {advanceProgramSearch,invalidateUnstartedProgramSearch} from '../compute-search/controller';\nimport {assertEconomicDispatchBoundary} from '../economic-orchestration/currentness';")
revise(PE + "program-synthesis/worker.ts", "for(const operation of request.operations??[]){meter();await assertProgramCurrent(ctx,q);",
       "for(const operation of request.operations??[]){meter();await assertProgramCurrent(ctx,q);await assertEconomicDispatchBoundary(ctx,q);")
revise(PE + "program-synthesis/worker.ts", "selectionPolicy:adaptive?'P2_CURRENT_CHECKED_SEARCH_V1':'FIXED_CHECKED_FEWEST_INSTRUCTIONS_V1'",
       "selectionPolicy:adaptive?.plan?.orchestrationPolicyRef?'W1_CURRENT_NATIVE_POLICY_OR_COMPATIBLE_FALLBACK_V1':adaptive?'P2_CURRENT_CHECKED_SEARCH_V1':'FIXED_CHECKED_FEWEST_INSTRUCTIONS_V1'")
revise("finnor-os/packages/db/compute-contract.ts", "protocolVersions: [1, 2] },", "protocolVersions: [1, 2, 3] },")

ROUTE = "finnor-os/apps/api/app/api/company-brain/[operation]/route.ts"
revise(ROUTE, "import {handleComputeSearchOperation,COMPUTE_SEARCH_OPERATIONS} from '@finnor/private-equity/src/compute-search/api';",
       """import {handleComputeSearchOperation,COMPUTE_SEARCH_OPERATIONS} from '@finnor/private-equity/src/compute-search/api';
import {handleEconomicOrchestrationOperation,ECONOMIC_ORCHESTRATION_OPERATIONS} from '@finnor/private-equity/src/economic-orchestration/api';
import {reconcileEconomicPolicyDependenciesTx} from '@finnor/private-equity/src/live-recompilation/economic-orchestration-port';""")
revise(ROUTE, "    if((DELIBERATION_OPERATIONS as readonly string[]).includes(route.operation))return await inDeliberationDeadline(",
       "    if((ECONOMIC_ORCHESTRATION_OPERATIONS as readonly string[]).includes(route.operation))return await inDeliberationDeadline(deliberationTransportDeadline(req),()=>dispatchPost(req,route));\n    if((DELIBERATION_OPERATIONS as readonly string[]).includes(route.operation))return await inDeliberationDeadline(")
revise(ROUTE, "    if((COMPUTE_SEARCH_OPERATIONS as readonly string[]).includes(route.operation)){",
       "    if((ECONOMIC_ORCHESTRATION_OPERATIONS as readonly string[]).includes(route.operation)){const result=await handleEconomicOrchestrationOperation(ctx,route.operation,body,{reconcileDependenciesTx:reconcileEconomicPolicyDependenciesTx});return response(result.body,result.status);}\n    if((COMPUTE_SEARCH_OPERATIONS as readonly string[]).includes(route.operation)){")

revise("finnor-os/scripts/generate-openapi.ts", 'import { DELIBERATION_OPERATIONS } from "../packages/private-equity/src/deliberation/api";',
       'import { DELIBERATION_OPERATIONS } from "../packages/private-equity/src/deliberation/api";\nimport { ECONOMIC_ORCHESTRATION_OPERATIONS, ECONOMIC_ORCHESTRATION_OPERATION_SCHEMAS } from "../packages/private-equity/src/economic-orchestration/api";')
revise("finnor-os/scripts/generate-openapi.ts", "for (const operation of DELIBERATION_OPERATIONS) {",
       """for (const operation of ECONOMIC_ORCHESTRATION_OPERATIONS) {
  Object.assign(paths, { ["/api/company-brain/" + operation]: { post: {
    security: secured, parameters: [{ in: "header", name: "x-deliberation-deadline-ms", required: false,
      description: "Existing shared whole-transport attenuation; no new Work deadline or compute grant",
      schema: { type: "integer", minimum: 1, maximum: 30000, default: 30000 } }],
    requestBody: json(ECONOMIC_ORCHESTRATION_OPERATION_SCHEMAS[operation]), responses: {
      "200": { description: "Authenticated principal-scoped native policy, measured response or lifecycle receipt; no protected authority" },
      "202": { description: "Original P1/S4/S5-bound ordinary W1 work accepted" },
      "400": { description: "Strict bounded native contract rejected" },
      "401": { description: "Authentication required" },
      "404": { description: "Absent or unauthorized private Work is indistinguishable" },
      "413": { description: "Inherited whole-transport deadline exhausted" },
      "422": { description: "Original owner, currentness, unsupported port or resource predicate unpassed" },
    },
  } } });
}

for (const operation of DELIBERATION_OPERATIONS) {""")

add("finnor-os/packages/capability-evolution/src/economic-orchestration-port.ts", """import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../../private-equity/src/types';
import type {SearchRow} from '../../private-equity/src/compute-search/contracts';
import type {ProgramRow} from '../../private-equity/src/program-synthesis/store';
import {sha,stable} from '../../private-equity/src/evidence-execution/store';
import {prepareEconomicDevelopmentCheckTx,currentEconomicDevelopmentCheckTx,storedEconomicCapsuleTx} from '../../private-equity/src/economic-orchestration/capsules';
/** Actual S8 additive check-only domain. Never admitted, active, protected or an effect origin. */
export async function issueEconomicOrchestrationDevelopmentCheckTx(ctx:PeMutationContext,s:SearchRow,q:ProgramRow,digest:string,c:PoolClient){
 const check=await prepareEconomicDevelopmentCheckTx(ctx,s,q,digest,c);
 await c.query(`INSERT INTO finnor_os.w1_development_checks(tenant_id,principal_id,search_id,candidate_digest,body,digest)
  VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,principal_id,search_id,candidate_digest) DO NOTHING`,
  [s.tenant_id,s.principal_id,s.id,digest,stable(check),sha(check)]);
 const capsule=await storedEconomicCapsuleTx(ctx,s,digest,c),current=await currentEconomicDevelopmentCheckTx(ctx,s,capsule,c);
 if(sha(current)!==sha(check))throw Error('W1_S8_TYPED_DEVELOPMENT_PREIMAGE_CONFLICT');
 return current;
}
""")
add(PE + "live-recompilation/economic-orchestration-port.ts", """import type {PoolClient} from 'pg';
import type {PeMutationContext} from '../types';
import type {SearchRow} from '../compute-search/contracts';
import {invalidateEconomicDependenciesTx} from '../economic-orchestration/currentness';
/** P7 original revision+method/model/price/deadline/resource/source/rights/Work
 * dependency adapter. Original P2 automatically continues/recontrols/falls back
 * or waits on its original owner, never a new recompiler/grant/effect identity. */
export async function reconcileEconomicPolicyDependenciesTx(ctx:PeMutationContext,s:SearchRow,c:PoolClient):Promise<string[]>{
 return invalidateEconomicDependenciesTx(ctx,s,c);
}
""")
add("finnor-os/packages/db/migrations/postz_w1_native_orchestration.sql", """-- Reserved namespaced proposal only. Sole coordinator owns canonical ordering/numbering/application.
-- W1 reuses P2 custody, original P1/S5 accounting and existing physical leases.
ALTER TABLE finnor_os.p2_units DROP CONSTRAINT p2_units_kind_check;
ALTER TABLE finnor_os.p2_units ADD CONSTRAINT p2_units_kind_check
 CHECK(kind IN('EXECUTE_P1','VERIFY_P1','MODEL_REFINE','INSPECT_SOURCE','CONTROL_M2','CONTROL_W1'));
ALTER TABLE finnor_os.p2_units DROP CONSTRAINT p2_units_attempts_check;
ALTER TABLE finnor_os.p2_units ADD CONSTRAINT p2_units_attempts_check
 CHECK(attempts>=0 AND attempts<=CASE WHEN kind='CONTROL_M2' THEN 32 WHEN kind='CONTROL_W1' THEN 1 ELSE 2 END);

CREATE TABLE finnor_os.w1_capsules(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),unit_id uuid NOT NULL,attempt_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=4194304),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,principal_id,search_id,revision),UNIQUE(tenant_id,principal_id,search_id,digest),
 UNIQUE(tenant_id,principal_id,attempt_id),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,unit_id) REFERENCES finnor_os.p2_units(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,attempt_id) REFERENCES finnor_os.p2_attempts(tenant_id,principal_id,id),
 CHECK(coalesce(body->>'schema'='finnor.orchestration-policy-capsule.v1'
  AND body->>'id'=id::text AND body->>'searchId'=search_id::text
  AND body->'execution'->>'unitId'=unit_id::text AND body->'execution'->>'attemptId'=attempt_id::text
  AND body->'authorityGranted'='false'::jsonb,false))
);
CREATE TABLE finnor_os.w1_native_observations(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,id text NOT NULL,search_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id)
);
CREATE TABLE finnor_os.w1_response_states(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 dataset_digest text NOT NULL CHECK(dataset_digest~'^[a-f0-9]{64}$'),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=2097152),
 dataset jsonb NOT NULL CHECK(octet_length(dataset::text)<=4194304),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,digest),
 CHECK(coalesce(body->>'schema'='finnor.orchestration-response-state.v1'
  AND body->>'tenantId'=tenant_id::text AND body->>'principalId'=principal_id::text
  AND body->>'sourceClass'='CONTROLLED_NATIVE' AND dataset->>'sourceClass'='CONTROLLED_NATIVE',false))
);
CREATE INDEX w1_response_current ON finnor_os.w1_response_states(tenant_id,principal_id,created_at DESC,digest DESC);
CREATE TABLE finnor_os.w1_development_checks(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,candidate_digest text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,search_id,candidate_digest),
 FOREIGN KEY(tenant_id,principal_id,search_id,candidate_digest) REFERENCES finnor_os.w1_capsules(tenant_id,principal_id,search_id,digest),
 CHECK(coalesce(body->>'schema'='finnor.w1.s8-development-check.v1'
  AND body->>'domain'='ECONOMIC_ORCHESTRATION' AND body->>'protectionDomain'='DISPOSABLE_LOCAL_DEVELOPMENT'
  AND body->>'tenantId'=tenant_id::text AND body->>'principalId'=principal_id::text
  AND body->>'searchId'=search_id::text AND body->>'candidateDigest'=candidate_digest AND body->>'status'='CHECKED'
  AND body->'protectedAdmission'='false'::jsonb AND body->'productionActivated'='false'::jsonb
  AND body->'executionAuthorityGranted'='false'::jsonb,false))
);
CREATE TABLE finnor_os.w1_dependencies(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,capsule_digest text NOT NULL,
 dependency_key text NOT NULL,revision bigint NOT NULL CHECK(revision>=0),facet text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,search_id,capsule_digest,dependency_key),
 FOREIGN KEY(tenant_id,principal_id,search_id,capsule_digest) REFERENCES finnor_os.w1_capsules(tenant_id,principal_id,search_id,digest)
);
CREATE TABLE finnor_os.w1_invalidations(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,capsule_digest text NOT NULL,
 dependency_key text NOT NULL,observed_revision bigint NOT NULL CHECK(observed_revision>=0),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,principal_id,search_id,capsule_digest,dependency_key,observed_revision),
 FOREIGN KEY(tenant_id,principal_id,search_id,capsule_digest) REFERENCES finnor_os.w1_capsules(tenant_id,principal_id,search_id,digest)
);
CREATE TABLE finnor_os.w1_stage_observations(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,id text NOT NULL CHECK(length(id)<=1024),
 context_key text NOT NULL CHECK(length(context_key)<=1024),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=262144),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,id),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id),
 CHECK(coalesce(body->>'schema'='finnor.w1.native-stage-observation.v1' AND body->>'id'=id
  AND jsonb_typeof(body->'before'->'history')='array' AND jsonb_typeof(body->'after'->'history')='array',false))
);
CREATE INDEX w1_stage_history ON finnor_os.w1_stage_observations(tenant_id,principal_id,search_id,created_at,id);
CREATE TABLE finnor_os.w1_continuation_states(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,context_key text NOT NULL CHECK(length(context_key)<=1024),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=2097152),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,digest),
 CHECK(coalesce(body->>'schema'='finnor.w1.native-continuation-response.v1'
  AND body->>'version'='postz-w1-empirical-continuation-v2'
  AND body->'context'->>'tenantId'=tenant_id::text AND body->'context'->>'principalId'=principal_id::text
  AND body->'context'->>'sourceClass'='CONTROLLED_NATIVE' AND jsonb_array_length(body->'samples')<=128,false))
);
CREATE UNIQUE INDEX w1_continuation_ref ON finnor_os.w1_continuation_states(tenant_id,principal_id,(body->>'ref'));
CREATE INDEX w1_continuation_current ON finnor_os.w1_continuation_states(tenant_id,principal_id,context_key,created_at DESC,digest DESC);
CREATE TABLE finnor_os.w1_dependency_snapshots(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,capsule_digest text NOT NULL,
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,search_id,capsule_digest),
 FOREIGN KEY(tenant_id,principal_id,search_id,capsule_digest) REFERENCES finnor_os.w1_capsules(tenant_id,principal_id,search_id,digest),
 CHECK(coalesce(body->>'schema'='finnor.w1.native-dependency-snapshot.v1'
  AND body->'facets' ?& ARRAY['METHOD','MODEL','PRICE','DEADLINE','RESOURCE','SOURCE','RIGHTS','WORK']
  AND body->'authorityGranted'='false'::jsonb,false))
);
CREATE TABLE finnor_os.w1_measurement_gaps(
 tenant_id uuid NOT NULL,principal_id uuid NOT NULL,search_id uuid NOT NULL,id text NOT NULL CHECK(length(id)<=1024),
 body jsonb NOT NULL CHECK(octet_length(body::text)<=65536),digest text NOT NULL CHECK(digest~'^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,principal_id,search_id,id),
 FOREIGN KEY(tenant_id,principal_id,search_id) REFERENCES finnor_os.p2_requests(tenant_id,principal_id,id),
 CHECK(coalesce(body->>'schema'='finnor.w1.native-measurement-gap.v1' AND body->>'id'=id
  AND body->>'kind'~'^[A-Z][A-Z0-9_]{0,127}$' AND body->'value'='null'::jsonb
  AND body->'authorityGranted'='false'::jsonb,false))
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['w1_capsules','w1_native_observations','w1_response_states','w1_development_checks','w1_dependencies','w1_invalidations',
  'w1_stage_observations','w1_continuation_states','w1_dependency_snapshots','w1_measurement_gaps'] LOOP
  EXECUTE format('ALTER TABLE finnor_os.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE finnor_os.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY w1_principal_isolation ON finnor_os.%I USING(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid) WITH CHECK(tenant_id=finnor_os.request_tenant_id() AND principal_id=nullif(current_setting(''app.user_id'',true),'''')::uuid)',t);
  EXECUTE format('GRANT SELECT,INSERT ON finnor_os.%I TO finnor_app',t);
  EXECUTE format('CREATE TRIGGER w1_immutable BEFORE UPDATE OR DELETE ON finnor_os.%I FOR EACH ROW EXECUTE FUNCTION finnor_os.p1_immutable()',t);
 END LOOP;
END $$;
-- No historical P2/M2 row is rewritten, no grant/ledger/authority/job kind added.
""")

revise("finnor-os/scripts/p2/run-e2e.mts", " if(process.env.FINNOR_P2_BROWSER_FIXTURE==='1'){",
       """ if(process.env.FINNOR_W1_NATIVE_STORY==='1'){
  const native=await import('../postz-w1/native-stories.mjs');
  await test('W1-native-owner-proof',{},'Signed bearer with bypass0; actual original P1/S4/S5/P2 warm and scored continuation without renewing episode/grant/deadline; actual capsule consumption, SQL acceptance and separate Fraction oracle',()=>native.nativeOwnerStory(environment));
 }else if(process.env.FINNOR_P2_BROWSER_FIXTURE==='1'){""")

assert changes and all(before != after for before, after in changes.values())
OUT.mkdir(parents=True)
entries, combined = [], []
for index, (path, (before, after)) in enumerate(changes.items(), 1):
    source = ROOT / path
    assert not source.exists() if before is None else source.read_text() == before, f"Shared preimage changed during proposal: {path}"
    diff = f"diff --git a/{path} b/{path}\n" + ("new file mode 100644\n" if before is None else "")
    diff += "".join(difflib.unified_diff((before or "").splitlines(keepends=True), after.splitlines(keepends=True),
                                       fromfile="/dev/null" if before is None else "a/" + path, tofile="b/" + path, n=5))
    patch_name = f"{index:02d}-{source.name}.diff"
    (OUT / patch_name).write_text(diff)
    proposed = OUT / "after" / path
    proposed.parent.mkdir(parents=True, exist_ok=True)
    proposed.write_text(after)
    entries.append({"normalizedPath": path, "action": "ADD" if before is None else "MODIFY",
                    "originalSha256": None if before is None else hashlib.sha256(before.encode()).hexdigest(),
                    "originalState": "ABSENT" if before is None else "EXACT_BYTES",
                    "proposedSha256": hashlib.sha256(after.encode()).hexdigest(),
                    "patch": patch_name, "fullProposedSource": str(proposed.relative_to(OUT)),
                    "callers": ["Authenticated Company Brain", "Original P2 planner/admission/worker/current reader",
                                "Original P1 source/SQL acceptance/owner dispatch", "Existing production queue contract",
                                "Additive S8 check-only and P7 dependency ports"],
                    "compatibility": "Optional W1 request only; protocols1/2 and historical M2/P2 bytes retained; no new grants or effects",
                    "validation": {"preimageAndFullDiff": "GENERATED", "applied": False,
                                   "narrowOverlayTypecheck": "NOT_RUN", "postgresMigration": "NOT_RUN",
                                   "authQueueNativeE2E": "NOT_RUN"}})
    combined.append(diff)
(OUT / "combined.diff").write_text("\n".join(combined))
manifest = {
    "schema": "finnor.w1.native-owner-integration-proposals.v2",
    "status": "PROPOSED_NOT_APPLIED_ACKNOWLEDGMENT_REQUIRED",
    "workerSession": "39a611b0-72ef-4adb-94f7-832e1eb4fc88", "parentSession": "82969ba5-49dd-408f-87b4-8da74f3ae2a6",
    "baseCommit": "f4c2e41c8a0222c9d83ca1be821b3aef888da08a", "baseTree": "1ea863a81e2244ea9da6f9378d9db994950caf8b",
    "sharedFilesActuallyWritten": [], "proposals": entries,
    "validationStatusAtGenerationOnly": True,
    "registration": {"newJobKind": None, "existingJobKind": "run_compute_search_unit_v1", "protocols": [1, 2, 3],
                     "workerRegistrationChanged": False, "reason": "Existing P2 registration consumes the versioned production contract",
                     "reservedMigrationFilename": "postz_w1_native_orchestration.sql",
                     "rollout": ["Sole shared writer assigns canonical order/number to reserved postz_w1_native_orchestration.sql", "Apply exact-preimage migration and owner patches",
                                 "Release protocol3-capable workers before enabling W1 submit; old workers refuse protocol3",
                                 "Regenerate openapi.json through canonical serial generator; resolve frontend mount separately",
                                 "Freeze source/schema/runtime identities before any native campaign"]},
    "resourceSemantics": {"originalNativeGrantCounter": "p2_grant_usage via chargeOriginalNativeGrant",
                          "parentCounters": "Original p1_episodes; no renewals/resets/refunds",
                          "physicalCapacity": "Original native:p2 leases and durable P2 intent/submitted/publication fences",
                          "controlParentLogicalSteps": 256, "kernelPerCallHardStepLimit": 4000000,
                          "kernelBudgetChangeFromV4": "4096 scanner/traversal units could not fit a multistage model; now the existing kernel's bounded4M account, independently per producer/checker call;1second local deadline remains; original P1 logical256 debit is not changed or equated to machine instructions",
                          "publicationAttemptReservation": "0 after actual P1 evidence_query_id, otherwise1; actual P1 continuation still debits logical steps",
                          "actualDeadline": "Minimum original P1 episode deadline, immutable request deadline, original owner validity, and pinned fitted validity; never extended",
                          "importantGap": "P1 logical operator units are not CPU instructions. Complete child CPU/memory, dollars and total engineering costs are unqualified."},
    "domain": {"registeredP1Modules": 3, "jointBundles": 7, "states": 64, "choicesPerState": 16, "maxContingentDecisions": 8,
               "fittedResponse": "Immutable original native conditional complete semantic/history observations with joint resource/outcome distributions; missing-cost conditionals unqualified and named, never favorable denominators or invented zero",
               "sameCapsuleContinuation": "Pinned immutable fit; exact observed semantic state only, ambiguous/unseen states use original remaining-budget fallback; no nearest-state match",
               "resourceStatisticalScope": "Original beforeRemaining is retained; empirical semantic-history response is not a causal/resource-invariance claim; exact actual remaining-budget feasibility and deadlines are checked separately",
               "measurementGapRetentionPerSearch": "256 distinct as-of gaps plus one saturation sentinel; original records retained",
               "lockOrder": "Principal two-int namespace gate, then entire deduplicated sorted actual signed64bit hashtextextended ID set",
               "globalOrCausalOptimality": False, "completeEmpiricalContinuationQualified": False},
    "unchangedAuthority": ["S4 utility", "S5 funding", "S6 original effect identity and UNKNOWN", "S7 economic attribution", "S8 protected admission and activation"],
    "internalFollowups": ["Migration ordering and SQL execution", "Derived OpenAPI regeneration", "Mounted Work UI and privacy proof",
                         "Run prepared real warm/scored native bootstrap; exact source/response compatibility remains unverified",
                         "Owner/queue interruption, budget, drift and fallback E2Es", "Cold final runtime proof",
                         "Actual PG context-lock concurrency and byte/retention bounds",
                         "Resource-cost outcomes remain empirical forecasts, not guaranteed physical latency; original admission/deadline always governs"],
    "qualification": {"DESIGNED": True, "CODE_COMPLETE": False, "E2E_DEV_VERIFIED": False,
                      "DOMAIN_QUALIFIED": False, "ADMITTED": False, "PRODUCTION_ACTIVE": False, "FIELD_VALIDATED": False}
}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(json.dumps({"status": manifest["status"], "output": str(OUT), "proposalCount": len(entries),
                  "sharedFilesActuallyWritten": [], "combinedSha256": hashlib.sha256((OUT / "combined.diff").read_bytes()).hexdigest()}))

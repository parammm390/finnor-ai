"""Produce exact-preimage coordinator requests. Never writes shared live files."""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import subprocess


def sha(body):
    return hashlib.sha256(body).hexdigest()


def proposals(repository):
    before, after, why = {}, {}, {}

    def replace(path, old, new, rationale, count=1):
        if path not in before:
            before[path] = (repository / path).read_text()
            after[path] = before[path]
        if after[path].count(old) != count:
            raise ValueError("Z4_SHARED_ANCHOR_COUNT:" + path + ":" + repr(old[:100]))
        after[path] = after[path].replace(old, new)
        why.setdefault(path, []).append(rationale)

    def create(path, body, rationale):
        if (repository / path).exists() or path in before:
            raise ValueError("Z4_SHARED_NEW_PATH_EXISTS:" + path)
        before[path], after[path], why[path] = "", body, [rationale]

    f = "finnor-os/"
    pe = f + "packages/private-equity/src/"
    orch = f + "packages/orchestration/src/"
    path = f + "packages/db/compute-contract.ts"
    anchor = '  run_evidence_derivation_v1: tenantFixed("INTERACTIVE", "locally_idempotent", "Bounded native evidence computation for accepted Work; no protected admission."),\n'
    replace(path, anchor, anchor + '  prove_exact_execution_v1: tenantFixed("HEAVY", "locally_idempotent", "Z4 bounded exact integer proof and independent original-semantics verification under the original Work/S5 deadline; no effects or protected admission.", {leaseRecovery:"immediate_after_expiry"}),\n',
            "Register the owned fenced heavy job in the sole compute contract.")

    path = f + "apps/worker/src/index.ts"
    anchor = "import {runEvidenceDerivationJob} from '@finnor/private-equity/src/evidence-execution/worker';\n"
    replace(path, anchor, anchor + "import {runExecutionProofJob} from '@finnor/private-equity/src/project-z/z4-execution-proof/worker';\n",
            "Import the concrete original-Work worker, not an optional port.")
    replace(path, "  return queue;\n", '  queue.register("prove_exact_execution_v1", runExecutionProofJob, PRODUCTION_JOB_CONTRACTS.prove_exact_execution_v1);\n  return queue;\n',
            "Use the shared queue claim, lease, fence and production contract.")

    path = pe + "enterprise-interventions.ts"
    replace(path, "input: { modelRef: unknown; query: unknown }): Promise<InterventionResponseBundle>",
            "input: { modelRef: unknown; query: unknown; executionProofGuard?: unknown }): Promise<InterventionResponseBundle>",
            "Add an optional exact invocation guard, preserving ordinary callers.")
    anchor = "  await recoverModelExperience(ctx,model);\n  const response = await queryInterventionModel(model, input.query,"
    replace(path, anchor, "  await recoverModelExperience(ctx,model);\n  await (await import('./project-z/z4-execution-proof/owner-consumer')).assertExecutionProofGuard(ctx,input.executionProofGuard,'S3',{modelRef:input.modelRef,query:input.query},'BEFORE');\n  const response = await queryInterventionModel(model, input.query,",
            "S3 independently verifies the original relation before native computation.")
    anchor = "  await immutableFile(ctx, 'responses', response.ref.contentDigest, response);\n  return response;\n"
    replace(path, anchor, "  await immutableFile(ctx, 'responses', response.ref.contentDigest, response);\n  await (await import('./project-z/z4-execution-proof/owner-consumer')).assertExecutionProofGuard(ctx,input.executionProofGuard,'S3',{modelRef:input.modelRef,query:input.query},'AFTER');\n  return response;\n",
            "Persist the real output and acknowledge the same exact input after use.")
    reader = """\
/** Read only this principal's immutable original S3 response, with current rights. */
export async function readEnterpriseInterventionResponse(ctx:PeMutationContext,value:unknown):Promise<InterventionResponseBundle>{
 const parsed=ExperimentRefSchema.safeParse(value);
 if(!parsed.success||parsed.data.owner!=='S3'||parsed.data.version!=='s3-temporal-linear-v1'||
  parsed.data.id!==`intervention-response:${parsed.data.contentDigest}`)throw unavailable();
 try{
  await checkedStore(ctx);const dir=join(directory(ctx),'responses');await privateDirectory(dir);
  const file=await open(join(dir,`${parsed.data.contentDigest}.json`),constants.O_RDONLY|constants.O_NOFOLLOW);
  let response:InterventionResponseBundle;
  try{
   const st=await file.stat();
   if(!st.isFile()||st.size>8*1024*1024||st.uid!==process.getuid?.()||(st.mode&0o077)!==0)throw unavailable();
   response=JSON.parse(await file.readFile('utf8'));
  }finally{await file.close();}
  if(response.schema!=='finnor.s3.response-bundle.v1'||epistemicHash(response.ref)!==epistemicHash(parsed.data)||
   response.queryRef!==`response-query:${epistemicHash(response.query)}`||
   epistemicHash({modelRef:response.modelRef,queryRef:response.queryRef,identification:response.identification,
    responses:response.responses,compute:response.compute})!==parsed.data.contentDigest)throw unavailable();
  const model=await readModel(ctx,response.modelRef);await readableHistory(ctx,model);
  if(epistemicHash(model.ref)!==epistemicHash(response.modelRef)||await current(ctx,model))throw unavailable();
  return response;
 }catch{throw unavailable();}
}
"""
    replace(path, "export async function projectEnterpriseInterventionExperiment(", reader + "export async function projectEnterpriseInterventionExperiment(",
            "Durable S3 owner readback recomputes the native five-field digest and rights.")

    path = pe + "enterprise-control.ts"
    replace(path, "measurements?:Array<{protocol?:unknown;events:unknown[]}>;confidentialGuard?:unknown};",
            "measurements?:Array<{protocol?:unknown;events:unknown[]}>;confidentialGuard?:unknown;executionProofGuard?:unknown};",
            "Extend only the numeric analytical S4 choice, not the R3 protocol.")
    anchor = " await (await import('./confidential-computation/owner-consumer')).assertConfidentialGuard(ctx,input.confidentialGuard);\n"
    # There are precisely two native boundary calls, before and after evaluation.
    if (repository / path).read_text().count(anchor) != 2:
        raise ValueError("Z4_S4_BOUNDARY_COUNT")
    old = anchor + " const policy=await readEnterpriseContingentPolicy(ctx,input.policyRef),decision=parseControlDecision(input.decision);\n"
    replace(path, old, anchor + " await (await import('./project-z/z4-execution-proof/owner-consumer')).assertExecutionProofGuard(ctx,input.executionProofGuard,'S4',input,'BEFORE');\n const policy=await readEnterpriseContingentPolicy(ctx,input.policyRef),decision=parseControlDecision(input.decision);\n",
            "Verify exact S4 policy, decision, allocation and measurements before choice.")
    replace(path, anchor + " return choice;\n", anchor + " await (await import('./project-z/z4-execution-proof/owner-consumer')).assertExecutionProofGuard(ctx,input.executionProofGuard,'S4',input,'AFTER');\n return choice;\n",
            "Require the real S4 boundary after its immutable choice and currentness check.")
    anchor = "  ...(input.confidentialGuard!==undefined?{confidentialGuard:input.confidentialGuard}:{}),\n"
    replace(path, anchor, anchor + "  ...(input.executionProofGuard!==undefined?{executionProofGuard:input.executionProofGuard}:{}),\n",
            "Retain guard provenance in native S4 prepared experience.")

    path = f + "packages/shared-types/src/operational-queries.ts"
    anchor = 'export interface ConfidentialComputationQueryRequest { intent:"confidential_economic_computation_v1"; workId:string }\n'
    replace(path, anchor, anchor + '/** Z4 current completion metadata only, never raw owner/private outputs. */\nexport const EXECUTION_PROOF_OPERATIONAL_QUERY_INTENTS = ["execution_proof_capsule_v1"] as const;\nexport interface ExecutionProofQueryRequest { intent:"execution_proof_capsule_v1"; workId:string }\n',
            "Extend the canonical query universe, not a parallel query API.")
    replace(path, "  ...CONFIDENTIAL_OPERATIONAL_QUERY_INTENTS,\n", "  ...CONFIDENTIAL_OPERATIONAL_QUERY_INTENTS,\n  ...EXECUTION_PROOF_OPERATIONAL_QUERY_INTENTS,\n",
            "Expose the exact Z4 canonical intent.")
    replace(path, "  | ConfidentialComputationQueryRequest\n", "  | ConfidentialComputationQueryRequest\n  | ExecutionProofQueryRequest\n",
            "Type the canonical original-Work request.")
    anchor = 'export interface ConfidentialComputationQueryResult extends OperationalQueryResultBase<"confidential_economic_computation_v1"> {}\n'
    replace(path, anchor, anchor + 'export interface ExecutionProofQueryResult extends OperationalQueryResultBase<"execution_proof_capsule_v1"> {}\n',
            "Type the completion result envelope.")
    replace(path, "  | ConfidentialComputationQueryResult\n", "  | ConfidentialComputationQueryResult\n  | ExecutionProofQueryResult\n",
            "Include the result in the existing result union.")
    replace(path, "    : R extends ConfidentialComputationQueryRequest ? ConfidentialComputationQueryResult\n",
            "    : R extends ConfidentialComputationQueryRequest ? ConfidentialComputationQueryResult\n    : R extends ExecutionProofQueryRequest ? ExecutionProofQueryResult\n",
            "Preserve request/result type correspondence.")

    path = orch + "operational-query-runtime.ts"
    anchor = 'import {executeConfidentialComputationQuery} from "@finnor/private-equity/src/confidential-computation/operational-query";\n'
    replace(path, anchor, anchor + 'import {executeExecutionProofQuery} from "@finnor/private-equity/src/project-z/z4-execution-proof/operational-query";\n',
            "Wire the concrete existing-owner completion reader.")
    replace(path, "  CONFIDENTIAL_OPERATIONAL_QUERY_INTENTS,\n", "  CONFIDENTIAL_OPERATIONAL_QUERY_INTENTS,\n  EXECUTION_PROOF_OPERATIONAL_QUERY_INTENTS,\n",
            "Reuse the canonical intent constant.")
    replace(path, "...PROGRAM_OPERATIONAL_QUERY_INTENTS,...CONFIDENTIAL_OPERATIONAL_QUERY_INTENTS]",
            "...PROGRAM_OPERATIONAL_QUERY_INTENTS,...CONFIDENTIAL_OPERATIONAL_QUERY_INTENTS,...EXECUTION_PROOF_OPERATIONAL_QUERY_INTENTS]",
            "Limit Z4 discovery to the active private-equity vertical.")
    anchor = "  if (PE.has(request.intent)) {\n"
    replace(path, anchor, '  if(request.intent==="execution_proof_capsule_v1")return executeExecutionProofQuery(tenantId,request,options) as Promise<OperationalQueryResultFor<T>>;\n' + anchor,
            "Dispatch through the native tenant/principal/Work envelope.")

    path = orch + "plugin-registry.ts"
    replace(path, 'intent==="confidential_economic_computation_v1"?["workId"]:',
            '(intent==="confidential_economic_computation_v1"||intent==="execution_proof_capsule_v1")?["workId"]:',
            "Require original Work grounding for the registered planner query.")
    path = orch + "objective-success.ts"
    replace(path, 'params.request.intent === "confidential_economic_computation_v1" ||',
            'params.request.intent === "confidential_economic_computation_v1" || params.request.intent === "execution_proof_capsule_v1" ||',
            "Reconstitute the real persisted principal for objective observation.")
    replace(path, '["harness_program_v1","economic_programme_v1","confidential_economic_computation_v1"]',
            '["harness_program_v1","economic_programme_v1","confidential_economic_computation_v1","execution_proof_capsule_v1"]',
            "Pass the exact current Work input to canonical success verification.")
    path = orch + "objective-loop.ts"
    replace(path, '(c.request.intent==="harness_program_v1"||c.request.intent==="confidential_economic_computation_v1")',
            '(c.request.intent==="harness_program_v1"||c.request.intent==="confidential_economic_computation_v1"||c.request.intent==="execution_proof_capsule_v1")',
            "Inspect the selected proof objective, never substitute deal readiness.")
    replace(path, '["harness_program_v1","confidential_economic_computation_v1"].includes(validated.request.intent)',
            '["harness_program_v1","confidential_economic_computation_v1","execution_proof_capsule_v1"].includes(validated.request.intent)',
            "Keep principal, Work and current input through decision-query execution.")

    wake = """\
/** Schedule original-goal observation only after durable, doubly guarded native readback. */
export async function schedulePreparedExecutionProofObjectiveTx(db:Db,params:{
 tenantId:string;workId:string;planRevisionId:string;sessionId:string;definitionDigest:string;
 capsuleDigest:string;resultDigest:string;useId:string;
}):Promise<void>{
 const [plan]=await db.select().from(workPlanRevisions).where(and(eq(workPlanRevisions.tenantId,params.tenantId),
  eq(workPlanRevisions.workId,params.workId),eq(workPlanRevisions.id,params.planRevisionId))).limit(1);
 if(!plan?.objectiveLoopId||plan.status!=='active'||!plan.workInputId)throw Error('Z4_NATIVE_ACTIVE_OBJECTIVE_PLAN_REQUIRED');
 await db.execute(sql`SELECT id FROM ${workObjectiveLoops} WHERE ${workObjectiveLoops.tenantId}=${params.tenantId}
  AND ${workObjectiveLoops.id}=${plan.objectiveLoopId} FOR NO KEY UPDATE`);
 let [loop]=await db.select().from(workObjectiveLoops).where(and(eq(workObjectiveLoops.tenantId,params.tenantId),
  eq(workObjectiveLoops.id,plan.objectiveLoopId))).limit(1);
 const deadline=(plan.constraintSet as {deadlineAt?:unknown})?.deadlineAt;
 if(!loop||loop.workId!==params.workId||!loop.createdBy||!['waiting','continue'].includes(loop.state)||
  loop.deadlineAt.getTime()<=Date.now()||typeof deadline!=='string'||Date.parse(deadline)!==loop.deadlineAt.getTime())
  throw Error('Z4_NATIVE_ORIGINAL_OBJECTIVE_FENCED');
 const condition=parseObjectiveSuccessCondition(loop.successCondition);
 if(condition.mode!=='all'||condition.criteria.length!==3||!condition.criteria.every(c=>c.kind==='canonical_query'
  &&c.request.intent==='execution_proof_capsule_v1'&&c.request.workId===params.workId)||
  !Object.entries({status:'CHECKED',definitionDigest:params.definitionDigest,nativeOwnerConsumed:true}).every(([key,expected])=>
   condition.criteria.some(c=>c.kind==='canonical_query'&&c.assertion.path.join('.')==='data.'+key&&
    c.assertion.operator==='eq'&&c.assertion.expected===expected)))throw Error('Z4_NATIVE_ORIGINAL_SUCCESS_CONDITION_CHANGED');
 const ready=await db.execute(sql`SELECT j.id FROM finnor_os.jobs j
  JOIN finnor_os.work_inputs i ON i.tenant_id=j.tenant_id AND i.work_id=${params.workId}::uuid AND i.id=${plan.workInputId}::uuid
  WHERE j.tenant_id=${params.tenantId}::uuid AND j.id=${params.sessionId}::uuid AND j.type='prove_exact_execution_v1'
   AND j.payload->>'tenantId'=${params.tenantId} AND j.payload->>'principalId'=${loop.createdBy}
   AND j.payload->>'sessionId'=${params.sessionId} AND j.payload->>'workId'=${params.workId}
   AND j.payload->>'workInputId'=${plan.workInputId} AND j.payload->'workRevisionRef'->>'id'=${params.planRevisionId}
   AND j.payload->>'definitionDigest'=${params.definitionDigest}
   AND j.payload->'z4'->>'schema'='finnor.z4.job.v1'
   AND j.payload->'z4'->>'sessionId'=${params.sessionId} AND j.payload->'z4'->>'principalId'=${loop.createdBy}
   AND j.payload->'z4'->>'status'='CHECKED' AND j.payload->'z4'->>'capsuleDigest'=${params.capsuleDigest}
   AND j.payload->'z4'->'delivery'->>'state'='ACKNOWLEDGED'
   AND j.payload->'z4'->'delivery'->>'capsuleDigest'=${params.capsuleDigest}
   AND j.payload->'z4'->'delivery'->>'resultDigest'=${params.resultDigest}
   AND j.payload->'z4'->'delivery'->>'useId'=${params.useId}
   AND j.payload->'z4'->'delivery'->'acks' @> '["BEFORE","AFTER"]'::jsonb
   AND i.created_by=${loop.createdBy}::uuid
   AND i.context_snapshot->>'executionProofAcceptedRequestDigest'=${params.definitionDigest}
   AND NOT EXISTS(SELECT 1 FROM finnor_os.work_inputs n WHERE n.tenant_id=i.tenant_id AND n.work_id=i.work_id
    AND (n.created_at,n.id)>(i.created_at,i.id))`);
 if(ready.rows.length!==1)throw Error('Z4_NATIVE_TYPED_OWNER_OBSERVATION_REQUIRED');
 if(loop.state==='waiting'){
  await transitionWorkTx(db,params.tenantId,params.workId,'executing','execution_proof_observation_ready',
   {sessionId:params.sessionId,planRevisionId:plan.id,metadataOnly:true},{expectedWorkInputId:plan.workInputId});
  [loop]=await db.update(workObjectiveLoops).set({state:'continue',revision:loop.revision+1,
   reason:'Native owner independently consumed the exact history guard; verify the original canonical goal.',updatedAt:new Date()})
   .where(and(eq(workObjectiveLoops.tenantId,params.tenantId),eq(workObjectiveLoops.id,loop.id),
    eq(workObjectiveLoops.state,'waiting'))).returning();
 }
 if(!loop)throw Error('Z4_NATIVE_OBJECTIVE_FENCED');
 await scheduleIterationTx(db,loop,new Date());
}

"""
    replace(path, "async function workerContext(tenantId: string, workId: string):", wake + "async function workerContext(tenantId: string, workId: string):",
            "Concrete fenced wake checks original plan, all three criteria and exact durable native acknowledgement.")

    path = f + "apps/api/app/api/company-brain/[operation]/route.ts"
    anchor = "import {CONFIDENTIAL_OPERATIONS,handleConfidentialOperation} from '@finnor/private-equity/src/confidential-computation/api';\n"
    replace(path, anchor, anchor + "import {EXECUTION_PROOF_OPERATIONS} from '@finnor/private-equity/src/project-z/z4-execution-proof/contracts';\nimport {handleProofOperation} from '@finnor/private-equity/src/project-z/z4-execution-proof/api';\n",
            "Use the existing authenticated company-brain route and literal registry.")
    route = """\
    if(EXECUTION_PROOF_OPERATIONS.some(operation=>operation===route.operation)){
      try{
        const auth=await requireContext(req),body=await readApplicationBody(req);
        const result=await handleProofOperation({auth},route.operation,body);
        return response(result.body,result.status);
      }catch(error){const mapped=applicationResponseError(error);return mapped?response(mapped.body,mapped.status):requestError(error);}
    }
"""
    replace(path, "    if(route.operation==='application-cancel'){\n", route + "    if(route.operation==='application-cancel'){\n",
            "Authenticate before bounded body parsing and preserve canonical response/error handling.")

    # Additional requests are composed below, always in memory.
    additional_requests(replace, create, repository)
    return before, after, why


def additional_requests(replace, create, repository):
    f = "finnor-os/"
    migration = """\
-- Coordinator proposal only. Applying source does not authorize executing DDL.
-- Existing Work/jobs/S5 remain the sole durable owners; no parallel tables.
DO $z4_query_history$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO STRICT previous FROM pg_constraint
  WHERE conrelid='finnor_os.work_query_executions'::regclass
   AND conname='work_query_executions_intent_check';
 IF previous NOT LIKE 'CHECK (%' THEN
  RAISE EXCEPTION 'Z4 requires the existing validated query-history predicate';
 END IF;
 ALTER TABLE finnor_os.work_query_executions DROP CONSTRAINT work_query_executions_intent_check;
 EXECUTE format('ALTER TABLE finnor_os.work_query_executions ADD CONSTRAINT work_query_executions_intent_check CHECK ((%s) OR intent=%L)',
  substring(previous FROM 7),'execution_proof_capsule_v1');
END $z4_query_history$;
INSERT INTO finnor_os.compute_job_type_policies
 (job_type,default_class,allowed_classes,classification_rule,tenant_scope,obligation_kind,policy_revision,rationale)
 VALUES('prove_exact_execution_v1','HEAVY',ARRAY['HEAVY'],'fixed','tenant','required',1,
 'Z4 bounded original integer history, pinned relation proof and independent checking under the original Work/S5 envelope; no effect or admission authority.');
INSERT INTO finnor_os.compute_resource_policies
 (resource_key,capacity,per_tenant_capacity,interactive_reserve,lease_seconds,source)
 VALUES('native:z4-execution-proof',1,1,0,150,
 'One bounded Z4 native prover/verifier process; original parent budget and currentness remain required.');
"""
    create(f + "packages/db/migrations/postz_z4_execution_proof.sql", migration,
           "Additive policy and compositional query-history migration, never executed by the lane.")
    path = f + "scripts/bundle-migrations.ts"
    replace(path, '"postz_z0_institution_application_bridge.sql"].includes(name)',
            '"postz_z0_institution_application_bridge.sql","postz_z4_execution_proof.sql"].includes(name)',
            "Add only the exact namespaced migration to the shared bundler allowlist.")
    path = f + "packages/db/schema.ts"
    replace(path, '        "confidential_economic_computation_v1",\n',
            '        "confidential_economic_computation_v1",\n        "execution_proof_capsule_v1",\n',
            "Keep the Drizzle query-execution intent type aligned with the additive migration.")
    path = f + "packages/orchestration/src/fast-read-lane.ts"
    anchor = '  if(intent==="confidential_economic_computation_v1"){\n'
    branch = """\
  if(intent==="execution_proof_capsule_v1"){
    if(Object.keys(value!).some(key=>!["intent","workId"].includes(key))||typeof value?.workId!=="string"||!UUID.test(value.workId))
      return {success:false,error:"Execution proof query requires the exact Work ID; principal and input come from the native controller"};
    return {success:true,request:value as unknown as OperationalQueryRequest};
  }
"""
    replace(path, anchor, branch + anchor,
            "Deterministic planner validation admits only the exact two-field Z4 query.")
    path = f + "apps/api/app/api/queries/route.ts"
    replace(path, 'input.intent === "confidential_economic_computation_v1") {',
            'input.intent === "confidential_economic_computation_v1" || input.intent === "execution_proof_capsule_v1") {',
            "Never expose a lowered native-only invocation through the public query facade.")
    path = f + "scripts/release/verify-pe-domain-boundary.ts"
    replace(path, "  CONFIDENTIAL_OPERATIONAL_QUERY_INTENTS,\n",
            "  CONFIDENTIAL_OPERATIONAL_QUERY_INTENTS,\n  EXECUTION_PROOF_OPERATIONAL_QUERY_INTENTS,\n",
            "Classify the new exact native query in the existing boundary verifier.")
    replace(path, "const NATIVE_QUERY_INTENTS = [...PROGRAM_OPERATIONAL_QUERY_INTENTS, ...CONFIDENTIAL_OPERATIONAL_QUERY_INTENTS];",
            "const NATIVE_QUERY_INTENTS = [...PROGRAM_OPERATIONAL_QUERY_INTENTS, ...CONFIDENTIAL_OPERATIONAL_QUERY_INTENTS, ...EXECUTION_PROOF_OPERATIONAL_QUERY_INTENTS];",
            "Retain the full public/native denominator without advertising native intent on /api/queries.")
    anchor = '  if (!equalSets(OPERATIONAL_QUERY_INTENTS, [...PUBLIC_QUERY_INTENTS, ...NATIVE_QUERY_INTENTS])) {\n'
    replace(path, anchor, '  if (!equalSets(EXECUTION_PROOF_OPERATIONAL_QUERY_INTENTS, ["execution_proof_capsule_v1"])) {\n    errors.push("native-only query catalogue must retain the exact Z4 reader");\n  }\n' + anchor,
            "Add an exact Z4 classification check, preserving every older boundary assertion.")
    old = '  if (OPERATIONAL_QUERY_INTENTS.length !== 19) errors.push(`active query registry has ${OPERATIONAL_QUERY_INTENTS.length} intents; expected 19 including P7 workforce_status, P1 harness_program_v1, Y1 economic_programme_v1 and Y4 confidential_economic_computation_v1`);'
    new = '  if (OPERATIONAL_QUERY_INTENTS.length !== 20) errors.push(`active query registry has ${OPERATIONAL_QUERY_INTENTS.length} intents; expected 20 including P7 workforce_status, P1 harness_program_v1, Y1 economic_programme_v1, Y4 confidential_economic_computation_v1 and Z4 execution_proof_capsule_v1`);'
    replace(path, old, new, "Update the exact catalogue denominator for one additive intent, not a looser bound.")
    path = f + "scripts/release/run-pe5-water-retirement-certification.ts"
    replace(path,
            '  assert(OPERATIONAL_QUERY_INTENTS.length === 19, "PE3 query contract plus P7 workforce status, P1 harness, Y1 economic programme and Y4 confidential computation readers is incomplete");',
            '  assert(OPERATIONAL_QUERY_INTENTS.length === 20, "PE3 query contract plus P7 workforce status, P1 harness, Y1 economic programme, Y4 confidential computation and Z4 execution proof readers is incomplete");',
            "Keep the exact existing certification-source denominator aligned; do not execute its DB/DDL path.")

    path = f + "scripts/generate-openapi.ts"
    anchor = 'import {CONFIDENTIAL_OPERATION_SCHEMAS,CONFIDENTIAL_OPERATIONS} from "../packages/private-equity/src/confidential-computation/api";\n'
    replace(path, anchor, anchor + 'import {OPERATION_SCHEMAS as EXECUTION_PROOF_OPERATION_SCHEMAS,EXECUTION_PROOF_OPERATIONS} from "../packages/private-equity/src/project-z/z4-execution-proof/contracts";\n',
            "Generate schemas from the exact owned API contracts.")
    anchor = " ...Object.entries(CONFIDENTIAL_OPERATION_SCHEMAS).map(([name,schema])=>[name,applicationSchema(schema)]),\n"
    replace(path, anchor, anchor + " ...Object.entries(EXECUTION_PROOF_OPERATION_SCHEMAS).map(([name,schema])=>[name,applicationSchema(schema)]),\n",
            "Include all eight bounded Z4 operation components.")
    anchor = '(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...CONFIDENTIAL_OPERATIONS);\n'
    routes = """\
(paths["/api/company-brain/{operation}"].post.parameters[0]!.schema.enum as string[]).push(...EXECUTION_PROOF_OPERATIONS);
for(const operation of EXECUTION_PROOF_OPERATIONS){
 Object.assign(paths,{["/api/company-brain/"+operation]:{post:{security:secured,
  requestBody:{required:true,content:{"application/json":{schema:{$ref:"#/components/schemas/"+operation}}}},
  responses:{"200":{description:"Current ordinary-disposable computation evidence or original native analytical guard use. No source truth, security, protected or effect admission."},
   "202":{description:"Original durable proof job queued, not checked or completed."},
   "400":{description:"Exact bounded typed contract refused."},"401":{description:"Current signed identity required."},
   "404":{description:"Unavailable in the current tenant/principal/Work scope."},
   "413":{description:"Bounded request or response exceeded."},
   "422":{description:"Original semantics, source, rights, deadline, budget, claim, owner acknowledgement or separate admission premise unpassed."},
   "503":{description:"Pinned native runtime or configured owner unavailable."}}}}});
}
"""
    replace(path, anchor, routes + anchor,
            "Document actual queue and refusal statuses without a new endpoint or completion claim.")
    path = "scripts/centropy/generate-capability-manifest.mjs"
    anchor = '  ["CONFIDENTIAL_OPERATIONS", "confidential-computation/api.ts"],\n'
    replace(path, anchor, anchor + '  ["EXECUTION_PROOF_OPERATIONS", "project-z/z4-execution-proof/contracts.ts"],\n',
            "Discover the concrete registered operations from their owned registry.")
    anchor = "const operationClasses = new Map()\n"
    classifications = """\
for (const operation of ["execution-proof-read", "execution-proof-list"])
  operationClasses.set(`company-brain/${operation}`, "READ")
operationClasses.set("company-brain/execution-proof-cancel", "CONTROL")
for (const operation of ["execution-proof-intake", "execution-proof-plan", "execution-proof-submit", "execution-proof-audit", "execution-proof-consume"])
  operationClasses.set(`company-brain/${operation}`, "MUTATION")
"""
    replace(path, anchor, anchor + classifications,
            "Read-only metadata, cancellation and budget-consuming audit/use keep explicit classes.")
    anchor = '      path.startsWith("company-brain/confidential-")?'
    replace(path, anchor, '      path.startsWith("company-brain/execution-proof-")?["work","company-brain","authority","source"]:\n' + anchor,
            "Invalidate real Work/source/authority surfaces after bounded writes.")
    path = "scripts/centropy/generate-human-forms.mjs"
    anchor = "function group(c) {\n"
    replace(path, anchor, anchor + '  if (c.routePattern?.startsWith("company-brain/execution-proof-") && c.classification !== "READ") return "execution-proofs"\n',
            "Use the existing generated human form plane for typed Z4 writes.")
    path = "src/components/centropy/world/WorldWorkRecord.tsx"
    anchor = 'import { ConfidentialComputationPanel } from "./ConfidentialComputationPanel"\n'
    replace(path, anchor, anchor + 'import { ExecutionProofPanel } from "../../../../finnor-os/packages/private-equity/src/project-z/z4-execution-proof/ExecutionProofPanel"\n',
            "Mount the actual owned client panel in the canonical Work record.")
    anchor = '      {root ? <ConfidentialComputationPanel key={workId} root={root} workId={workId} /> : null}\n'
    replace(path, anchor, anchor + '      {root ? <ExecutionProofPanel key={`proof:${workId}:${root.entityType}:${root.entityId}`} root={root} workId={workId} onChanged={onChanged} /> : null}\n',
            "Bind mounted controls to the selected original Work/root; the server validates its current input.")
    path = f + "apps/api/next.config.mjs"
    anchor = "  outputFileTracingRoot: repositoryRoot,\n"
    replace(path, anchor, anchor + '  outputFileTracingExcludes: {"/api/*": [\n    "../../packages/epistemic-runtime/native/z4-execution-proof/target/**",\n    "../../packages/epistemic-runtime/native/z4-execution-proof/.cargo-home/**",\n    "../../packages/epistemic-runtime/native/z4-execution-proof/.cargo/**",\n    "../../packages/epistemic-runtime/native/z4-execution-proof/.toolchain/**",\n  ]},\n',
            "Exclude build trees, caches and toolchains from the installed API artifact.")
    anchor = '      "../../Dockerfile.worker", "./next.config.mjs",\n'
    tracing = """\
      // Z4 installed verification binds both source and native runtime, never build-host fallback.
      "../../../package.json", "../../package.json",
      "../../../z4-reconstruction-source.json",
      "../../../scope-z/phase-evidence/z4/installed-provenance.json",
      "../../../next.config.mjs",
      "../../../tsconfig.json", "../../tsconfig.json", "../../tsconfig.base.json",
      "./tsconfig.json", "./lib/auth.ts",
      "../../../src/components/centropy/world/WorldWorkRecord.tsx",
      "../../../src/components/centropy/lib/api.ts",
      "../../../src/components/centropy/lib/use-private-request-scope.ts",
      "../../../src/app/api/centropy/*/route.ts",
      "../../node_modules/@esbuild/linux-x64/**/*",
      "../../packages/private-equity/src/project-z/z4-execution-proof/*.tsx",
      "../../packages/epistemic-runtime/native/z4-execution-proof/bin/*",
      "../../packages/epistemic-runtime/native/z4-execution-proof/build-identity.json",
      "../../packages/epistemic-runtime/native/z4-execution-proof/supervise.py",
      "../../packages/epistemic-runtime/native/z4-execution-proof/Cargo.toml",
      "../../packages/epistemic-runtime/native/z4-execution-proof/Cargo.lock",
      "../../packages/epistemic-runtime/native/z4-execution-proof/rust-toolchain.toml",
      "../../packages/epistemic-runtime/native/z4-execution-proof/src/*.rs",
      "../../packages/epistemic-runtime/native/z4-execution-proof/NOVA-LICENSE.txt",
      "../../scripts/project-z/z4/*.{py,mts,mjs,json,md}",
"""
    replace(path, anchor, anchor + tracing,
            "Trace required source/native assets, never Cargo target/cache or hidden toolchains.")
    path = f + "packages/orchestration/src/project-z/z0-convergence/semantics.ts"
    anchor = '  z.object({ intent: z.literal("confidential_economic_computation_v1"), ...work }).strict(),\n'
    replace(path, anchor, anchor + '  z.object({ intent: z.literal("execution_proof_capsule_v1"), ...work }).strict(),\n',
            "Coordinator/peer-owned proposal only: preserve original-Work convergence grounding.")
    replace(path, '["harness_program_v1", "economic_programme_v1", "confidential_economic_computation_v1"].includes(value.intent)',
            '["harness_program_v1", "economic_programme_v1", "confidential_economic_computation_v1", "execution_proof_capsule_v1"].includes(value.intent)',
            "Include Z4 in the same original-Work observer predicate, not an alternate lifecycle.")
    queue_request(replace)


def queue_request(replace):
    path = "finnor-os/apps/worker/src/queue.ts"
    anchor = "export class JobQueue {\n"
    replace(path, anchor, 'export const SCOPED_JOB_CLAIM_VERSION = "original-job-scope-v1" as const;\n\n' + anchor,
            "Expose an exact scoped-claim capability marker so replay fails before DB use if this seam is absent.")
    anchor = '      ? parseWorkloadClass(process.env.FINNOR_WORKLOAD_CLASS) : null,\n  ) {\n'
    replace(path, anchor, '      ? parseWorkloadClass(process.env.FINNOR_WORKLOAD_CLASS) : null,\n    readonly claimScope?: Readonly<{tenantId:string;jobId:string}>,\n  ) {\n    if(claimScope&&(process.env.FINNOR_ENVIRONMENT!=="staging"||workloadClass===null||\n      ![claimScope.tenantId,claimScope.jobId].every(id=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))))\n      throw new Error("SCOPED_REPLAY_REQUIRES_EXACT_STAGING_TENANT_JOB_AND_CLASS");\n',
            "Optional narrowing only: an authorized replay worker can claim/recover one original job, never an entire class.")
    anchor = "            AND ($2::text IS NULL OR workload_class=$2)\n          ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100`,\n        [RETIRED_WATER_JOB_TYPES, this.workloadClass],\n"
    replace(path, anchor, "            AND ($2::text IS NULL OR workload_class=$2)\n            ${this.claimScope?'AND tenant_id=$3::uuid AND id=$4::uuid':''}\n          ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 100`,\n        [RETIRED_WATER_JOB_TYPES, this.workloadClass,...(this.claimScope?[this.claimScope.tenantId,this.claimScope.jobId]:[])],\n",
            "A scoped replay never quarantines another tenant/job's retired work.")
    anchor = "            AND coalesce(lease_expires_at,started_at+($2::int || ' seconds')::interval)<=now()\n          ORDER BY lease_expires_at NULLS LAST,id\n          FOR UPDATE SKIP LOCKED LIMIT 100`,\n        [this.workloadClass, leaseSeconds],\n"
    replace(path, anchor, "            AND coalesce(lease_expires_at,started_at+($2::int || ' seconds')::interval)<=now()\n            ${this.claimScope?'AND tenant_id=$3::uuid AND id=$4::uuid':''}\n          ORDER BY lease_expires_at NULLS LAST,id\n          FOR UPDATE SKIP LOCKED LIMIT 100`,\n        [this.workloadClass, leaseSeconds,...(this.claimScope?[this.claimScope.tenantId,this.claimScope.jobId]:[])],\n",
            "Lease-expiry recovery remains the canonical queue transition, restricted to the same original job.")
    anchor = "            CLASS_CLAIM_SQL,\n            [compatibilityJson, this.workloadClass, this.priorityAgingSeconds, this.tenantInflightLimit],\n"
    replace(path, anchor, '            this.claimScope?CLASS_CLAIM_SQL.replace("WHERE eligible.workload_class=$2",\n              "WHERE eligible.tenant_id=$5::uuid AND eligible.id=$6::uuid AND eligible.workload_class=$2"):CLASS_CLAIM_SQL,\n            [compatibilityJson, this.workloadClass, this.priorityAgingSeconds, this.tenantInflightLimit,\n              ...(this.claimScope?[this.claimScope.tenantId,this.claimScope.jobId]:[])],\n',
            "Narrow the inner eligible candidate before LIMIT. Preserve the unscoped production/query-plan SQL unchanged.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    if not args.repository.is_absolute() or not args.evidence.is_absolute():
        raise ValueError("Z4_ABSOLUTE_PATHS_REQUIRED")
    before, after, why = proposals(args.repository)
    # Verify the complete request set before creating the immutable output directory.
    args.evidence.mkdir(parents=True, exist_ok=False, mode=0o700)
    head = subprocess.run(["git", "-C", str(args.repository), "rev-parse", "HEAD"],
                          check=True, capture_output=True, text=True).stdout.strip()
    manifest = {"schema": "finnor.z4.shared-requests.v1", "baseCommit": head,
                "status": "REQUESTED_NOT_APPLIED", "liveSharedFilesWritten": 0,
                "migrationExecuted": False, "requests": []}
    combined = []
    for index, path in enumerate(sorted(before), 1):
        old, new = before[path], after[path]
        diff = "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True),
                        fromfile="a/" + path if old else "/dev/null", tofile="b/" + path))
        ident = "SP-" + str(index).zfill(2)
        patch_name = ident + ".patch"
        (args.evidence / patch_name).write_text(diff)
        combined.append(diff)
        manifest["requests"].append({"id": ident, "path": path,
            "preimageSha256": sha(old.encode()) if old else None, "requiresAbsent": not old,
            "postimageSha256": sha(new.encode()), "patch": patch_name, "patchSha256": sha(diff.encode()),
            "rationale": why[path]})
    body = "".join(combined)
    (args.evidence / "combined.patch").write_text(body)
    manifest["combinedPatchSha256"] = sha(body.encode())
    manifest["generatorSha256"] = sha(Path(__file__).read_bytes())
    (args.evidence / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    # Recheck no target was changed by this read-only proposal generator.
    for path, old in before.items():
        actual = (args.repository / path).read_text() if (args.repository / path).exists() else ""
        if actual != old:
            raise ValueError("Z4_LIVE_SHARED_PREIMAGE_CHANGED:" + path)
    print(json.dumps({"status": "REQUESTED_NOT_APPLIED", "requests": len(before),
                      "combinedPatchSha256": manifest["combinedPatchSha256"]}))


if __name__ == "__main__":
    main()

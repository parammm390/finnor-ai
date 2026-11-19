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

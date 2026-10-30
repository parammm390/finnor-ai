-- R12 widens the persisted Work query-history intent set by exactly one typed
-- native-only reader. Work, jobs, S5 and the V2 tables remain the sole owners;
-- the job type advance_primary_diligence_v1 keeps its existing compute policy.
DO $r12_query_history$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO STRICT previous FROM pg_constraint
  WHERE conrelid='finnor_os.work_query_executions'::regclass
   AND conname='work_query_executions_intent_check';
 IF previous NOT LIKE 'CHECK (%' THEN
  RAISE EXCEPTION 'R12 requires the existing validated query-history predicate';
 END IF;
 ALTER TABLE finnor_os.work_query_executions DROP CONSTRAINT work_query_executions_intent_check;
 EXECUTE format('ALTER TABLE finnor_os.work_query_executions ADD CONSTRAINT work_query_executions_intent_check CHECK ((%s) OR intent=%L)',
  substring(previous FROM 7),'primary_diligence_v1');
END $r12_query_history$;

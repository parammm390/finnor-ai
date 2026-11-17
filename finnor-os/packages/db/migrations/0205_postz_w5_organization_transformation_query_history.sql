-- Register the W5 receipt while retaining the validated history predicate.
DO $w5_query_history$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO STRICT previous FROM pg_constraint
  WHERE conrelid='finnor_os.work_query_executions'::regclass
   AND conname='work_query_executions_intent_check' AND contype='c' AND convalidated;
 IF previous NOT LIKE 'CHECK (%' THEN
  RAISE EXCEPTION 'W5 reads require the existing validated query-history predicate';
 END IF;
 ALTER TABLE finnor_os.work_query_executions DROP CONSTRAINT work_query_executions_intent_check;
 EXECUTE format('ALTER TABLE finnor_os.work_query_executions ADD CONSTRAINT work_query_executions_intent_check CHECK ((%s) OR intent=%L)',
  substring(previous FROM 7),'organization_transformation_v1');
END $w5_query_history$;

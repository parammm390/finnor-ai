-- Add read receipts without reactivating or weakening any historical predicate.
DO $w1_read_history$
DECLARE previous text;
BEGIN
 SELECT pg_get_constraintdef(oid) INTO STRICT previous FROM pg_constraint
  WHERE conrelid='finnor_os.work_query_executions'::regclass
   AND conname='work_query_executions_intent_check';
 IF previous NOT LIKE 'CHECK (%' THEN
  RAISE EXCEPTION 'W1 reads require the existing validated query-history predicate';
 END IF;
 ALTER TABLE finnor_os.work_query_executions DROP CONSTRAINT work_query_executions_intent_check;
 EXECUTE format('ALTER TABLE finnor_os.work_query_executions ADD CONSTRAINT work_query_executions_intent_check CHECK ((%s) OR intent IN (%L,%L))',
  substring(previous FROM 7),'company_revenue','stock_quote');
END $w1_read_history$;

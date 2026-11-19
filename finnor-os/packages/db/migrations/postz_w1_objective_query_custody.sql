-- Extend the existing private reply owner, not the human input or a second store.
-- All old rows retain their original input-only slot and original bytes.
ALTER TABLE finnor_os.work_input_responses
 ADD COLUMN reply_key text NOT NULL DEFAULT 'input';
ALTER TABLE finnor_os.work_input_responses DROP CONSTRAINT work_input_responses_pkey;
ALTER TABLE finnor_os.work_input_responses ADD PRIMARY KEY(tenant_id,work_input_id,reply_key);
ALTER TABLE finnor_os.work_input_responses ADD CONSTRAINT work_input_responses_native_slot CHECK(
 (reply_key='input' AND response#>>'{objective,kind}' IS DISTINCT FROM 'objective_query')
 OR (reply_key ~ '^objective:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  AND response#>>'{objective,kind}'='objective_query'
  AND reply_key='objective:'||(response#>>'{objective,objectiveStepId}')) IS TRUE
);

ALTER TABLE finnor_os.work_query_executions
 ADD COLUMN objective_step_id uuid,
 ADD COLUMN objective_claim_owner text,
 ADD CONSTRAINT work_query_executions_objective_step_key UNIQUE(tenant_id,objective_step_id),
 ADD CONSTRAINT work_query_executions_objective_step_fkey FOREIGN KEY(tenant_id,objective_step_id)
  REFERENCES finnor_os.work_objective_steps(tenant_id,id),
 ADD CONSTRAINT work_query_executions_objective_read CHECK(
  (objective_step_id IS NULL AND objective_claim_owner IS NULL)
  OR (objective_step_id IS NOT NULL AND objective_claim_owner IS NOT NULL
   AND intent IN('company_revenue','stock_quote') AND work_input_id IS NOT NULL)
 );

-- Principal-only RLS and INSERT/SELECT privileges from 0195 are unchanged.
-- Deliberately no UPDATE/DELETE grant, bypass, parallel cache, job, or resource.

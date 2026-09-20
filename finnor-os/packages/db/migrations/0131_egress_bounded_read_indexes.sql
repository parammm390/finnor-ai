-- Bounded-read protection: keep the SQL-side page boundaries used by the
-- production read paths indexable as append-only history grows. These indexes are
-- additive; they do not alter rows, policies, triggers, retention, or audit history.

CREATE INDEX IF NOT EXISTS action_log_tenant_action_timestamp_id_idx
  ON finnor_os.action_log(tenant_id, domain_action_id, timestamp, id);

CREATE INDEX IF NOT EXISTS instruction_events_tenant_instruction_seq_idx
  ON finnor_os.instruction_events(tenant_id, instruction_id, seq);

CREATE INDEX IF NOT EXISTS domain_actions_tenant_work_created_id_idx
  ON finnor_os.domain_actions(tenant_id, work_id, created_at, id)
  WHERE work_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS domain_actions_tenant_instruction_created_id_idx
  ON finnor_os.domain_actions(tenant_id, instruction_id, created_at, id)
  WHERE instruction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS domain_actions_tenant_plan_created_id_idx
  ON finnor_os.domain_actions(tenant_id, plan_id, created_at, id)
  WHERE plan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS business_operation_targets_tenant_operation_ordinal_id_idx
  ON finnor_os.business_operation_targets(tenant_id, operation_id, ordinal, id);

-- The historical production lineage projects communications_log as a view over
-- messages. A view cannot be indexed; give its physical source the same bounded
-- tenant/time access path. Fresh lineages still retain the physical table.
DO $communications_index$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='finnor_os' AND c.relname='communications_log'
      AND c.relkind IN ('r','p')
  ) THEN
    CREATE INDEX IF NOT EXISTS communications_log_tenant_timestamp_id_idx
      ON finnor_os.communications_log(tenant_id, timestamp, id);
  ELSE
    CREATE INDEX IF NOT EXISTS messages_tenant_sent_id_idx
      ON finnor_os.messages(tenant_id, sent_at, id);
  END IF;
END $communications_index$;
